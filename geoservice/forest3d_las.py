# -*- coding: utf-8 -*-
"""
forest3d_las.py — облака точек LAS/LAZ → деревья для 3D-режима лесхоза.

Загрузка (администратор): LAS/LAZ передаются частями через /upload/init, /upload/{id}/part, /upload/{id}/finish.
Старый POST /api/forest3d/las/upload (тело — сам файл) оставлен для совместимости.
Обработка идёт в отдельном процессе (python forest3d_las.py <папка задания>),
чтобы не тормозить веб-сервер и не держать память воркера:

  1) чтение облака кусками (laspy; LAZ — через lazrs), СК — из VLR файла,
     иначе из параметра crs, иначе подбор СК; WGS-84 lon/lat автоматически проецируется в UTM WGS-84
     с проверкой «попадает в Беларусь»;
  2) ЦМР: точки класса 2 (земля), если их нет — минимум по ячейкам + морфологическое
     открытие; дыры заполняются;
  3) CHM (модель высот полога) = DSM − ЦМР, сглаживание;
  4) вершины деревьев — локальные максимумы с окном, зависящим от высоты
     (ширина кроны по Popescu), кроны — наращивание областей от вершин;
  5) по каждому дереву: высота, диаметр кроны, высота начала кроны (профиль точек),
     порода (хвойное / лиственное — по форме вершины, ширине кроны и интенсивности),
     диаметр ствола: ИЗМЕРЕН по точкам ствола на 1,3 м (вписанная окружность),
     если точек хватает (ULS/TLS), иначе — ОЦЕНКА по аллометрии H + Ø кроны
     (калибруется по измеренным деревьям этого облака).

Результат: trees.npz (WGS-84 lon/lat + параметры) и meta.json. Только numpy (+laspy, pyproj).
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time

if __name__ == "__main__":
    for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ[_var] = os.getenv("FOREST3D_BLAS_THREADS", "1")
import numpy as np

try:  # для веб-API; процесс обработки работает и без FastAPI
    from fastapi import HTTPException, Query, Request
except ImportError:  # pragma: no cover
    HTTPException = Query = Request = None

BELARUS_BBOX = (23.0, 51.2, 33.0, 56.3)
TOWGS84_PULKOVO = "23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12"
MIN_TREE_H = max(0.1, float(os.getenv("FOREST3D_MIN_TREE_H", "0.25")))
POINT_DTYPE = np.dtype([("lon", "<f8"), ("lat", "<f8"), ("z", "<f4"), ("h", "<f4"),
                        ("cls", "u1"), ("rgb", "u1", (3,))])
MAX_CELLS = int(os.getenv("FOREST3D_MAX_CELLS", "25000000"))
CHUNK = 2_000_000
MAX_STEM_POINTS = max(0,int(os.getenv("FOREST3D_MAX_STEM_POINTS", "2000000")))


def _write_json_atomic(path, obj):
    """Write JSON via a unique same-directory temp file; tolerate brief Windows locks."""
    folder = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
        # Windows may briefly deny replacement when another process, antivirus,
        # or indexer has the destination open. Retry without sharing a .tmp name.
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 7:
                    raise
                time.sleep(min(0.05 * (2 ** attempt), 0.8))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


# ════════════════════════════ утилиты растров (numpy) ════════════════════════════
def _filt(a, k, fn, fill):
    """Квадратный фильтр k×k (max/min), раздельный по осям."""
    if k <= 1:
        return a
    from numpy.lib.stride_tricks import sliding_window_view as sw
    p = k // 2
    out = np.pad(a, ((p, p), (0, 0)), constant_values=fill)
    out = fn(sw(out, k, axis=0), axis=-1)
    out = np.pad(out, ((0, 0), (p, p)), constant_values=fill)
    return fn(sw(out, k, axis=1), axis=-1)


def maxfilt(a, k):
    return _filt(a, k, np.max, -np.inf)


def minfilt(a, k):
    return _filt(a, k, np.min, np.inf)


def smooth121(a, passes=1):
    """Биномиальное сглаживание [1,2,1]⊗[1,2,1] (≈ гаусс σ≈0.7 ячейки на проход)."""
    for _ in range(passes):
        p = np.pad(a, ((1, 1), (0, 0)), mode="edge")
        a = (p[:-2] + 2 * p[1:-1] + p[2:]) / 4.0
        p = np.pad(a, ((0, 0), (1, 1)), mode="edge")
        a = (p[:, :-2] + 2 * p[:, 1:-1] + p[:, 2:]) / 4.0
    return a


def fill_nan(a, max_iter=400):
    """Заполнение пустот средним соседей (растущий фронт)."""
    a = a.astype(np.float32, copy=True)
    m = np.isnan(a)
    if not m.any():
        return a
    if m.all():
        return np.zeros_like(a)
    for _ in range(max_iter):
        if not m.any():
            break
        v = np.where(m, 0, a)
        w = (~m).astype(np.float32)
        pv, pw = np.pad(v, 1), np.pad(w, 1)
        s = pv[:-2, 1:-1] + pv[2:, 1:-1] + pv[1:-1, :-2] + pv[1:-1, 2:]
        c = pw[:-2, 1:-1] + pw[2:, 1:-1] + pw[1:-1, :-2] + pw[1:-1, 2:]
        new = m & (c > 0)
        if not new.any():
            break
        a[new] = s[new] / c[new]
        m &= ~new
    if m.any():
        a[m] = np.nanmedian(a[~m])
    return a


def bilinear(grid, x0, y0, res, x, y):
    """Значения сетки (строка = y, столбец = x, центр ячейки) в точках x,y."""
    fx = (x - x0) / res - 0.5
    fy = (y - y0) / res - 0.5
    ny, nx = grid.shape
    ix = np.clip(np.floor(fx).astype(np.int64), 0, nx - 2) if nx > 1 else np.zeros(len(x), np.int64)
    iy = np.clip(np.floor(fy).astype(np.int64), 0, ny - 2) if ny > 1 else np.zeros(len(y), np.int64)
    tx = np.clip(fx - ix, 0, 1) if nx > 1 else 0
    ty = np.clip(fy - iy, 0, 1) if ny > 1 else 0
    ix1 = np.minimum(ix + 1, nx - 1)
    iy1 = np.minimum(iy + 1, ny - 1)
    g00, g10, g01, g11 = grid[iy, ix], grid[iy, ix1], grid[iy1, ix], grid[iy1, ix1]
    return (g00 * (1 - tx) + g10 * tx) * (1 - ty) + (g01 * (1 - tx) + g11 * tx) * ty


def crown_width(h):
    """Ширина кроны по высоте (Popescu, Wynne 2004) — для окна поиска вершин."""
    return 3.09632 + 0.00895 * h * h


# ════════════════════════════ система координат ════════════════════════════
def _pulkovo_fix(crs):
    from pyproj import CRS
    try:
        dn = (crs.datum.name if crs.datum else "").lower()
        p4 = crs.to_proj4()
    except Exception:
        return crs
    if p4 and ("pulkovo" in dn or "+ellps=krass" in p4) and "+towgs84" not in p4:
        return CRS.from_proj4(p4.replace("+no_defs", "").strip() + f" +towgs84={TOWGS84_PULKOVO} +no_defs")
    return crs


def _crs_candidates(hint, las_crs, shp_prj, cx, cy):
    from pyproj import CRS
    out = []
    if las_crs is not None:
        out.append(("из файла LAS", las_crs))
    if hint and hint.lower() not in ("auto", ""):
        h = hint.strip()
        try:
            out.insert(0, ("указана при загрузке", CRS.from_user_input(int(h) if h.isdigit() else h)))
        except Exception:
            raise ValueError(f"Не распознана система координат: {hint}")
    if shp_prj and os.path.isfile(shp_prj):
        try:
            out.append(("как SHP лесхозов (.prj)", CRS.from_user_input(open(shp_prj, encoding="utf-8", errors="ignore").read())))
        except Exception:
            pass
    zone = int(str(int(abs(cx)))[0]) if abs(cx) >= 1_000_000 else None
    if zone in (4, 5, 6):
        out.append((f"СК-42 ГК зона {zone}", CRS.from_proj4(
            f"+proj=tmerc +lat_0=0 +lon_0={zone * 6 - 3} +k=1 +x_0={zone}500000 +y_0=0 +ellps=krass +units=m +no_defs")))
    for z in (35, 34, 36):
        out.append((f"UTM {z}N (WGS-84)", CRS.from_epsg(32600 + z)))
    out.append(("WGS-84 градусы", CRS.from_epsg(4326)))
    return out


def pick_crs(hint, las_crs, shp_prj, cx, cy):
    from pyproj import CRS, Transformer
    tried = []
    for label, crs in _crs_candidates(hint, las_crs, shp_prj, cx, cy):
        crs = _pulkovo_fix(crs)
        try:
            lon, lat = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True).transform(cx, cy)
        except Exception:
            continue
        tried.append(f"{label}: {lat:.3f}, {lon:.3f}")
        ok = BELARUS_BBOX[0] <= lon <= BELARUS_BBOX[2] and BELARUS_BBOX[1] <= lat <= BELARUS_BBOX[3]
        if ok or label in ("указана при загрузке",):
            return label, crs, (lon, lat)
    raise ValueError("Не удалось определить систему координат облака (координаты не попадают в Беларусь). "
                     "Укажите СК при загрузке (например EPSG:32635). Проверено: " + "; ".join(tried[:6]))


# ════════════════════════════ обработка ════════════════════════════
class Job:
    def __init__(self, jdir):
        self.dir = jdir
        self.cfg = json.load(open(os.path.join(jdir, "job.json"), encoding="utf-8"))
        self.t0 = time.time()

    def status(self, state, progress, stage, **kw):
        st = {"state": state, "progress": round(float(progress), 1), "stage": stage,
              "elapsed_s": round(time.time() - self.t0, 1), "updated": time.time()}
        st.update(kw)
        _write_json_atomic(os.path.join(self.dir, "status.json"), st)


def _chunks(path):
    import laspy
    with laspy.open(path) as fh:
        for ch in fh.chunk_iterator(CHUNK):
            yield ch


def process(jdir):
    import laspy
    job = Job(jdir)
    cfg = job.cfg
    src = os.path.join(jdir, cfg["file"])
    species_mode = cfg.get("species", "auto")
    job.status("running", 1, "Чтение заголовка")

    with laspy.open(src) as fh:
        hdr = fh.header
        npts = int(hdr.point_count)
        mins, maxs = np.array(hdr.mins, float), np.array(hdr.maxs, float)
        las_crs = None
        try:
            las_crs = hdr.parse_crs()
        except Exception:
            las_crs = None
        dims = set(fh.header.point_format.dimension_names)
    if npts <= 0:
        raise ValueError("В файле нет точек")
    source_mins, source_maxs = mins.copy(), maxs.copy()
    source_W, source_H = source_maxs[0] - source_mins[0], source_maxs[1] - source_mins[1]
    if source_W <= 0 or source_H <= 0:
        raise ValueError("Пустой охват облака")
    label, crs, (clon, clat) = pick_crs(cfg.get("crs", "auto"), las_crs, cfg.get("shp_prj"),
                                        (source_mins[0] + source_maxs[0]) / 2,
                                        (source_mins[1] + source_maxs[1]) / 2)
    source_to_work = None
    if crs.is_geographic:
        # LAS иногда содержит координаты WGS-84 lon/lat. Растровые модели и
        # расстояния строятся в метрах, поэтому автоматически перепроецируем
        # такие точки в WGS-84 / UTM зону их центра (34/35/36 для Беларуси).
        from pyproj import CRS, Transformer
        zone = int(np.clip(math.floor((clon + 180.0) / 6.0) + 1, 1, 60))
        hemisphere = "N" if clat >= 0 else "S"
        work_crs = CRS.from_epsg((32600 if clat >= 0 else 32700) + zone)
        source_to_work = Transformer.from_crs(crs, work_crs, always_xy=True)
        # Преобразуем точки по периметру bbox (с промежуточными точками,
        # чтобы не занижать охват из-за кривизны проекции).
        edge = np.linspace(0.0, 1.0, 17)
        bx = np.concatenate((
            source_mins[0] + edge * (source_maxs[0] - source_mins[0]),
            np.full_like(edge, source_maxs[0]),
            source_maxs[0] - edge * (source_maxs[0] - source_mins[0]),
            np.full_like(edge, source_mins[0]),
        ))
        by = np.concatenate((
            np.full_like(edge, source_mins[1]),
            source_mins[1] + edge * (source_maxs[1] - source_mins[1]),
            np.full_like(edge, source_maxs[1]),
            source_maxs[1] - edge * (source_maxs[1] - source_mins[1]),
        ))
        bx, by = source_to_work.transform(bx, by)
        if not (np.isfinite(bx).all() and np.isfinite(by).all()):
            raise ValueError("Не удалось перепроецировать координаты WGS-84 в UTM")
        mins = np.array([float(np.min(bx)), float(np.min(by)), source_mins[2]], dtype=float)
        maxs = np.array([float(np.max(bx)), float(np.max(by)), source_maxs[2]], dtype=float)
        crs = work_crs
        label = f"UTM {zone}{hemisphere} (WGS-84, автоматически из lon/lat)"
    else:
        mins, maxs = source_mins, source_maxs
    W, H = maxs[0] - mins[0], maxs[1] - mins[1]
    if W <= 0 or H <= 0:
        raise ValueError("Пустой охват после преобразования координат")
    is_geo = crs.is_geographic
    unit = 1.0
    try:
        unit = float(crs.axis_info[0].unit_conversion_factor or 1.0)
    except Exception:
        pass

    # разрешение CHM: 0.5 м, но не больше MAX_CELLS ячеек
    cres = max(0.5, math.sqrt(W * unit * H * unit / MAX_CELLS)) / unit
    cres = math.ceil(cres * unit * 4) / 4 / unit
    gres = cres * 2
    x0, y0 = mins[0], mins[1]
    nx, ny = int(W / cres) + 1, int(H / cres) + 1
    gnx, gny = int(W / gres) + 1, int(H / gres) + 1

    dsm = np.full(ny * nx, -np.inf, np.float32)
    g_cls = np.full(gny * gnx, np.inf, np.float32)
    g_all = np.full(gny * gnx, np.inf, np.float32)
    isum = np.zeros(ny * nx, np.float32)
    icnt = np.zeros(ny * nx, np.int32)
    has_int = "intensity" in dims
    n_cls2 = 0
    rgb_max = 0
    done = 0
    job.status("running", 3, f"Проход 1/2: {npts:,} точек".replace(",", " "), crs=label)
    for ch in _chunks(src):
        x, y, z = np.asarray(ch.x), np.asarray(ch.y), np.asarray(ch.z, dtype=np.float32)
        if source_to_work is not None:
            x, y = source_to_work.transform(x, y)
        cls = np.asarray(ch.classification) if "classification" in dims else None
        if {"red", "green", "blue"} <= dims:
            rgb_max = max(rgb_max, *(int(np.asarray(getattr(ch, k)).max(initial=0)) for k in ("red", "green", "blue")))
        keep = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
        if cls is not None:
            keep &= (cls != 7) & (cls != 18)
        x, y, z = x[keep], y[keep], z[keep]
        ci = (np.clip(((y - y0) / cres).astype(np.int64), 0, ny - 1) * nx + np.clip(((x - x0) / cres).astype(np.int64), 0, nx - 1))
        gi = (np.clip(((y - y0) / gres).astype(np.int64), 0, gny - 1) * gnx + np.clip(((x - x0) / gres).astype(np.int64), 0, gnx - 1))
        np.maximum.at(dsm, ci, z)
        np.minimum.at(g_all, gi, z)
        if cls is not None:
            c2 = cls[keep] == 2
            if c2.any():
                n_cls2 += int(c2.sum())
                np.minimum.at(g_cls, gi[c2], z[c2])
        if has_int:
            it = np.asarray(ch.intensity, dtype=np.float32)[keep]
            rn = np.asarray(ch.return_number)[keep] if "return_number" in dims else None
            first = (rn == 1) if rn is not None else np.ones(len(it), bool)
            np.add.at(isum, ci[first], it[first])
            np.add.at(icnt, ci[first], 1)
        done += len(ch)
        job.status("running", 3 + 37 * done / npts, f"Проход 1/2: {done:,} из {npts:,} точек".replace(",", " "), crs=label)

    # ── ЦМР ──
    job.status("running", 42, "Модель рельефа (ЦМР)", crs=label)
    use_cls = n_cls2 > 0
    dense_ground = use_cls and np.isfinite(g_cls).mean() > 0.05
    if dense_ground:
        g = g_cls.reshape(gny, gnx)
        g = np.where(np.isfinite(g), g, np.nan).astype(np.float32)
        ground_method = "класс 2 (земля)"
    else:
        # Sparse class-2 ground constrains, but must not flatten a whole sloping scan.
        g = g_all.reshape(gny, gnx)
        g = np.where(np.isfinite(g), g, np.nan).astype(np.float32)
        k = max(3, int(round(12 / (gres * unit))) | 1)
        gf = fill_nan(g)
        op = maxfilt(minfilt(gf, k), k)
        g = np.where(np.isnan(g) | (g > op + 0.5), np.nan, g)
        if use_cls:
            classified = g_cls.reshape(gny, gnx)
            g = np.where(np.isfinite(classified), classified, g)
        ground_method = "класс 2 + авто (минимумы + фильтр)" if use_cls else "авто (минимумы + фильтр)"
    dtm = smooth121(fill_nan(g), 1)

    # Keep the DTM for a real, metric ground surface in the viewer.
    np.savez_compressed(os.path.join(jdir, "terrain.npz"), dtm=dtm,
        coverage=np.isfinite(g_all.reshape(gny, gnx)), x0=x0, y0=y0, res=gres,
        unit=unit, crs=crs.to_wkt())

    # ── CHM ──
    job.status("running", 48, "Модель высот полога (CHM)", crs=label)
    dsm = dsm.reshape(ny, nx)
    cxs = x0 + (np.arange(nx) + 0.5) * cres
    cys = y0 + (np.arange(ny) + 0.5) * cres
    gxx, gyy = np.meshgrid(cxs, cys)
    dtm_c = bilinear(dtm, x0, y0, gres, gxx.ravel(), gyy.ravel()).reshape(ny, nx).astype(np.float32)
    del gxx, gyy
    chm = np.where(np.isfinite(dsm), (dsm - dtm_c) * unit, np.nan).astype(np.float32)
    chm = np.clip(chm, 0, 80)
    nanm = np.isnan(chm)
    if nanm.any():   # дырки между точками — максимум соседей, остальное 0
        mx = maxfilt(np.where(nanm, -np.inf, chm), 3)
        chm = np.where(nanm, np.where(np.isfinite(mx), mx, 0), chm)
    cr_m = cres * unit
    chm_s = smooth121(chm, 2 if cr_m <= 0.5 else 1).astype(np.float32)
    inten = np.where(icnt > 0, isum / np.maximum(icnt, 1), np.nan).reshape(ny, nx)
    del isum, icnt, dsm

    # ── вершины ──
    job.status("running", 55, "Поиск вершин деревьев", crs=label)
    rng = np.random.default_rng(1)
    chm_t = chm_s + rng.random(chm_s.shape, dtype=np.float32) * 1e-3     # разрыв «плато»
    win = np.clip(0.6 * crown_width(chm_t), 1.5, 16) / cr_m              # окно, ячеек
    kcell = (np.round(win) // 2 * 2 + 1).astype(np.int16)
    seeds = np.zeros(chm_t.shape, bool)
    cand = chm_t >= MIN_TREE_H
    for k in np.unique(kcell[cand]):
        m = cand & (kcell == k)
        if not m.any():
            continue
        mf = maxfilt(chm_t, int(k))
        seeds |= m & (chm_t >= mf)
    sy, sx = np.nonzero(seeds)
    nt = len(sx)
    # Ground-only / zero-height clouds are valid: retain points and terrain even with no tree peaks.
    # высота — по несглаженному CHM (максимум 3×3 у вершины): сглаживание «срезает» острые макушки
    th = np.maximum(maxfilt(chm, 3)[sy, sx], chm_s[sy, sx]).astype(np.float32)

    # ── кроны: наращивание областей ──
    job.status("running", 60, f"Кроны: {nt:,} деревьев".replace(",", " "), crs=label)
    lab = np.zeros(chm_s.shape, np.int32)
    lab[sy, sx] = np.arange(1, nt + 1)
    H_l = np.concatenate([[0], th])
    SX = np.concatenate([[0], sx]).astype(np.float32)
    SY = np.concatenate([[0], sy]).astype(np.float32)
    R_l = np.concatenate([[0], np.clip(0.6 * crown_width(th), 1.0, 14) / cr_m]).astype(np.float32)
    canopy = chm_s >= min(2.0, MIN_TREE_H * 0.5)
    yy, xx = np.indices(chm_s.shape, dtype=np.float32)
    for it in range(int(R_l.max()) + 2):
        grew = False
        free = canopy & (lab == 0)
        if not free.any():
            break
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nl = np.zeros_like(lab)
            nh = np.full(chm_s.shape, -1, np.float32)
            ys = slice(max(dy, 0), chm_s.shape[0] + min(dy, 0))
            yd = slice(max(-dy, 0), chm_s.shape[0] + min(-dy, 0))
            xs_ = slice(max(dx, 0), chm_s.shape[1] + min(dx, 0))
            xd = slice(max(-dx, 0), chm_s.shape[1] + min(-dx, 0))
            nl[yd, xd] = lab[ys, xs_]
            nh[yd, xd] = chm_s[ys, xs_]
            c = free & (nl > 0) & (chm_s <= nh + 0.3)
            if not c.any():
                continue
            L = nl[c]
            ok = (chm_s[c] >= 0.45 * H_l[L]) & ((xx[c] - SX[L]) ** 2 + (yy[c] - SY[L]) ** 2 <= R_l[L] ** 2)
            ci = np.flatnonzero(c)[ok]
            if len(ci):
                lab.flat[ci] = L[ok]
                free.flat[ci] = False
                grew = True
        if not grew:
            break
    del xx, yy

    labf = lab.ravel()
    area = np.bincount(labf, minlength=nt + 1)[1:].astype(np.float32) * cr_m * cr_m
    cd = 2 * np.sqrt(np.maximum(area, cr_m * cr_m) / math.pi)
    msum = np.bincount(labf, weights=chm_s.ravel(), minlength=nt + 1)[1:]
    rmean = (msum / np.maximum(area / (cr_m * cr_m), 1)) / np.maximum(th, 0.1)
    # форма вершины: падение высоты CHM на 1.25 м от вершины (конус → резкое, купол → плавное)
    d = max(1, int(round(1.25 / cr_m)))
    ring = []
    for ddy, ddx in ((d, 0), (-d, 0), (0, d), (0, -d), (d, d), (-d, -d), (d, -d), (-d, d)):
        yy_ = np.clip(sy + ddy, 0, ny - 1)
        xx_ = np.clip(sx + ddx, 0, nx - 1)
        ring.append(chm_s[yy_, xx_])
    ring = np.mean(ring, axis=0)
    dist = 1.25 * (1 + math.sqrt(2)) / 2
    apex = (th - ring) / dist
    # интенсивность (первые отражения) в пределах кроны
    if has_int and np.isfinite(inten).any():
        iv = np.where(np.isfinite(inten), inten, 0).ravel()
        iw = np.isfinite(inten).ravel().astype(np.float32)
        ti = np.bincount(labf, weights=iv, minlength=nt + 1)[1:] / np.maximum(np.bincount(labf, weights=iw, minlength=nt + 1)[1:], 1)
        med = np.median(ti[ti > 0]) if (ti > 0).any() else 0
        irel = ti / med if med > 0 else np.ones(nt)
        ispread = np.std(irel[ti > 0]) if (ti > 0).sum() > 10 else 0
    else:
        irel, ispread = np.ones(nt), 0

    # ── проход 2: профиль точек по кронам и точки ствола на 1.3 м ──
    job.status("running", 68, "Проход 2/2: профиль крон и стволы", crs=label)
    NB = 20
    prof = np.zeros((nt + 1) * NB, np.int64)
    stem_l, stem_x, stem_y = [], [], []
    stem_n = 0
    done = 0
    dtm_scale = unit
    from pyproj import Transformer
    point_to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    point_count, zero_count, invalid_count = 0, 0, 0
    culture_grid = np.zeros(gny * gnx, bool)
    class_counts = {}
    point_file = os.path.join(jdir, "points.bin")
    # Write each chunk immediately; no full-cloud array or height cutoff.
    with open(point_file, "wb"):
        pass
    for ch in _chunks(src):
        x, y, z = np.asarray(ch.x), np.asarray(ch.y), np.asarray(ch.z, dtype=np.float32)
        if source_to_work is not None:
            x, y = source_to_work.transform(x, y)
        finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
        invalid_count += int((~finite).sum())
        cls = np.asarray(ch.classification)[finite] if "classification" in dims else np.zeros(int(finite.sum()), np.uint8)
        rgb = None
        if {"red", "green", "blue"} <= dims:
            # Standard LAS RGB is uint16; also support files storing 8-bit values.
            rgb = np.column_stack([np.asarray(getattr(ch, k))[finite] for k in ("red", "green", "blue")])
            rgb = (rgb / (257.0 if rgb_max > 255 else 1.0)).clip(0,255).astype(np.uint8)
        x, y, z = x[finite], y[finite], z[finite]
        nh = (z - bilinear(dtm, x0, y0, gres, x, y)) * dtm_scale
        near_ground = np.abs(nh) <= 0.15
        gi = (np.clip(((y-y0)/gres).astype(np.int64),0,gny-1)*gnx +
              np.clip(((x-x0)/gres).astype(np.int64),0,gnx-1))
        culture_grid[gi[near_ground]] = True
        records = np.empty(len(x), dtype=POINT_DTYPE)
        records["lon"], records["lat"] = point_to_wgs.transform(x, y)
        records["z"], records["h"], records["cls"] = z * unit, nh, cls
        records["rgb"] = rgb if rgb is not None else 0
        with open(point_file, "ab") as out:
            records.tofile(out)
        point_count += len(records)
        zero_count += int(np.count_nonzero(np.abs(nh) <= 0.05))
        for c, n in zip(*np.unique(cls, return_counts=True)):
            class_counts[str(int(c))] = class_counts.get(str(int(c)), 0) + int(n)
        ix = np.clip(((x - x0) / cres).astype(np.int64), 0, nx - 1)
        iy = np.clip(((y - y0) / cres).astype(np.int64), 0, ny - 1)
        L = lab[iy, ix]
        valid = (cls != 7) & (cls != 18)
        m = valid & (L > 0) & (nh > 0.05)
        if m.any():
            Lm = L[m]
            b = np.clip((nh[m] / H_l[Lm] * NB).astype(np.int64), 0, NB - 1)
            np.add.at(prof, Lm.astype(np.int64) * NB + b, 1)
        s = valid & (L > 0) & (nh > 1.0) & (nh < 1.6)
        if s.any() and stem_n < MAX_STEM_POINTS:
            Ls = L[s]
            dx_ = (x[s] - (x0 + (SX[Ls] + 0.5) * cres)) * unit
            dy_ = (y[s] - (y0 + (SY[Ls] + 0.5) * cres)) * unit
            near = dx_ * dx_ + dy_ * dy_ <= (1.2 + 0.02 * H_l[Ls]) ** 2
            if near.any():
                selected=np.flatnonzero(near)
                remaining=MAX_STEM_POINTS-stem_n
                if len(selected)>remaining:
                    selected=selected[np.linspace(0,len(selected)-1,remaining,dtype=np.int64)]
                stem_l.append(Ls[selected]); stem_x.append(dx_[selected].astype(np.float32)); stem_y.append(dy_[selected].astype(np.float32))
                stem_n += len(selected)
        done += len(ch)
        job.status("running", 68 + 22 * done / npts, f"Проход 2/2: {done:,} из {npts:,} точек".replace(",", " "), crs=label)

    np.savez_compressed(os.path.join(jdir, "terrain.npz"), dtm=dtm,
        coverage=np.isfinite(g_all.reshape(gny, gnx)), cultures=culture_grid.reshape(gny,gnx),
        x0=x0, y0=y0, res=gres, unit=unit, crs=crs.to_wkt())
    # Huge canopy rasters are no longer needed for species/diameter fitting.
    del lab, labf, chm, chm_s, chm_t, kcell, seeds, inten, dtm_c, canopy, nanm, cand, win, g_cls, g_all
    prof = prof.reshape(nt + 1, NB)[1:]
    tot = prof.sum(1)
    cum = np.cumsum(prof, 1) / np.maximum(tot[:, None], 1)
    cb_bin = np.argmax(cum >= 0.06, axis=1)
    cbh = np.where(tot >= 8, (cb_bin / NB) * th, np.nan)
    top_frac = np.where(tot >= 8, prof[:, int(NB * 0.8):].sum(1) / np.maximum(tot, 1), np.nan)

    # ── порода ──
    job.status("running", 91, "Породы и диаметры", crs=label)
    ratio = cd / np.maximum(th, 0.1)
    score = (apex - 0.85) / 0.35 + 0.6 * (0.30 - ratio) / 0.08 + 0.6 * (0.62 - rmean) / 0.08
    if ispread > 0.08:
        score += 0.8 * (1 - irel) / max(ispread, 0.1)
    if species_mode == "conifer":
        typ = np.ones(nt, np.uint8)
    elif species_mode == "deciduous":
        typ = np.full(nt, 2, np.uint8)
    else:
        typ = np.where(score >= 0, 1, 2).astype(np.uint8)
    conf = np.clip(np.abs(score) / 2.0, 0, 1)
    cb_def = np.where(typ == 1, 0.45, 0.38) * th
    cbh = np.where(np.isnan(cbh), cb_def, np.clip(cbh, 0.15 * th, 0.85 * th))

    # Profile histograms are no longer needed after crown-base inference.
    del prof, cum, tot, cb_bin, top_frac
    # ── диаметр ствола ──
    dbh = np.full(nt, np.nan, np.float32)
    meas = np.zeros(nt, np.uint8)
    if stem_n:
        Ls = np.concatenate(stem_l); Xs = np.concatenate(stem_x); Ys = np.concatenate(stem_y)
        order = np.argsort(Ls, kind="stable")
        Ls, Xs, Ys = Ls[order], Xs[order], Ys[order]
        bnd = np.flatnonzero(np.diff(Ls)) + 1
        starts = np.concatenate([[0], bnd]); ends = np.concatenate([bnd, [len(Ls)]])
        del stem_l, stem_x, stem_y
        last_update = 0.0
        job.status("running", 92, "Измерение диаметров стволов", crs=label,
                   fitted_stems=0, total_stems=len(starts))
        for number, (a, b) in enumerate(zip(starts, ends)):
            if time.monotonic() - last_update >= 0.5:
                job.status("running", 92 + 4 * number / max(1,len(starts)),
                           "Измерение диаметров стволов", crs=label,
                           fitted_stems=number, total_stems=len(starts))
                last_update = time.monotonic()
            if b - a < 10:
                continue
            r = _fit_circle(Xs[a:b].astype(np.float64), Ys[a:b].astype(np.float64))
            if r is not None:
                dbh[Ls[a] - 1] = r * 200.0     # см
                meas[Ls[a] - 1] = 1
        del Ls, Xs, Ys, order, bnd, starts, ends
    job.status("running", 96, "Оценка диаметров по высоте и кроне", crs=label)
    k = {1: 0.45, 2: 0.45}
    allo = lambda t, hh, cc: k[t] * np.power(np.maximum(hh, 1.3), 1.2) * np.power(np.maximum(cc, 0.5), 0.3)
    for t in (1, 2):
        mm = (typ == t) & (meas == 1)
        if mm.sum() >= 20:
            kk = np.median(dbh[mm] / (allo(t, th[mm], cd[mm]) / k[t]))
            if 0.15 < kk < 1.5:
                k[t] = float(kk)
    est = np.where(typ == 1, allo(1, th, cd), allo(2, th, cd))
    dbh = np.where(th < 1.3, 0, np.where(meas == 1, dbh, np.clip(est, 1, 120))).astype(np.float32)
    meas[th < 1.3] = 0

    # ── координаты → WGS-84 ──
    job.status("running", 97, "Преобразование координат деревьев", crs=label)
    from pyproj import CRS, Transformer
    tx = x0 + (sx + 0.5) * cres
    ty = y0 + (sy + 0.5) * cres
    tr = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True)
    lon, lat = tr.transform(tx, ty)
    gz = bilinear(dtm, x0, y0, gres, tx, ty) * unit
    corners = tr.transform(np.array([mins[0], maxs[0], maxs[0], mins[0]]), np.array([mins[1], mins[1], maxs[1], maxs[1]]))
    job.status("running", 98, "Сохранение моделей деревьев", crs=label)
    np.savez_compressed(os.path.join(jdir, "trees.npz"),
                        lon=np.asarray(lon), lat=np.asarray(lat), h=th.astype(np.float32), dbh=dbh,
                        cd=cd.astype(np.float32), cbh=cbh.astype(np.float32), typ=typ, meas=meas,
                        conf=conf.astype(np.float32), gz=gz.astype(np.float32))
    # ── итоги ──
    con = typ == 1
    hcls = [(0, 10), (10, 20), (20, 30), (30, 99)]
    meta = {
        "name": cfg.get("name"), "file": cfg["file"], "uploaded": cfg.get("uploaded"),
        "points": npts, "stored_points": point_count, "zero_height_points": zero_count,
        "invalid_points": invalid_count, "point_classes": class_counts, "format_version": 2,
        "terrain_available": True, "min_tree_h": MIN_TREE_H, "trees": int(nt), "conifer": int(con.sum()), "deciduous": int((~con).sum()),
        "crs": label, "crs_name": crs.name, "cell_m": round(cr_m, 2),
        "area_ha": round(W * H * unit * unit / 1e4, 2),
        "density_pts_m2": round(npts / max(W * H * unit * unit, 1), 1),
        "ground": ground_method,
        "species_mode": species_mode,
        "h_mean": round(float(th.mean()) if nt else 0.0, 1), "h_max": round(float(th.max()) if nt else 0.0, 1),
        "stem_points_used":stem_n,"stem_sample_limited":stem_n>=MAX_STEM_POINTS if MAX_STEM_POINTS else True,
        "dbh_mean": round(float(dbh.mean()) if nt else 0.0, 1), "dbh_measured": int(meas.sum()),
        "cd_mean": round(float(cd.mean()) if nt else 0.0, 1),
        "h_classes": [{"from": a, "to": b, "conifer": int(((th >= a) & (th < b) & con).sum()),
                       "deciduous": int(((th >= a) & (th < b) & ~con).sum())} for a, b in hcls],
        "center": [round(float(np.mean(lon)) if nt else clon, 6), round(float(np.mean(lat)) if nt else clat, 6)],
        "bbox_wgs84": [round(float(min(corners[0])), 6), round(float(min(corners[1])), 6),
                       round(float(max(corners[0])), 6), round(float(max(corners[1])), 6)],
        "footprint_wgs84": [[round(float(a), 6), round(float(b), 6)] for a, b in zip(*corners)],
        "processing_s": round(time.time() - job.t0, 1),
    }
    job.status("running", 99, "Сохранение итогов обработки", crs=label)
    _write_json_atomic(os.path.join(jdir, "meta.json"), meta)
    if cfg.get("delete_source", False):
        try:
            os.remove(src)
        except OSError:
            pass
    job.status("done", 100, "Готово", crs=label, trees=int(nt))
    return meta


def _fit_circle(x, y):
    """Окружность по точкам ствола (метод Каса + отсев выбросов). → радиус, м или None."""
    max_points = max(64, int(os.getenv("FOREST3D_STEM_FIT_POINTS", "2048")))
    if len(x) > max_points:
        take = np.linspace(0,len(x)-1,max_points,dtype=np.int64)
        x,y = x[take],y[take]
    for _ in range(2):
        if len(x) < 8:
            return None
        A = np.c_[2 * x, 2 * y, np.ones(len(x))]
        b = x * x + y * y
        try:
            (a0, b0, c0), *_ = np.linalg.lstsq(A, b, rcond=None)
        except Exception:
            return None
        r2 = c0 + a0 * a0 + b0 * b0
        if r2 <= 0:
            return None
        r = math.sqrt(r2)
        res = np.abs(np.hypot(x - a0, y - b0) - r)
        keep = res <= max(0.03, 2.5 * np.median(res))
        x, y = x[keep], y[keep]
    if not (0.025 <= r <= 0.7) or math.hypot(a0, b0) > 1.0:
        return None
    rmse = float(np.sqrt(np.mean(res[keep] ** 2))) if keep.any() else 1
    ang = np.arctan2(y - b0, x - a0)
    cover = len(np.unique(((ang + math.pi) / (2 * math.pi) * 12).astype(int)))
    if rmse > 0.25 * r + 0.015 or cover < 5:
        return None
    return r


def main(jdir):
    job = Job(jdir)
    try:
        process(jdir)
    except MemoryError:
        job.status("error", 0, "Ошибка", message="Недостаточно памяти для облака такого размера")
    except Exception as e:
        import traceback
        with open(os.path.join(jdir, "error.log"), "w", encoding="utf-8") as f:
            traceback.print_exc(file=f)
        job.status("error", 0, "Ошибка", message=str(e)[:500])


if __name__ == "__main__":
    main(sys.argv[1])


# ════════════════════════════ веб-API (FastAPI) ════════════════════════════
def territory_mask(it, lon, lat):
    from shapely.geometry import Point
    b = it["_geom"].bounds
    candidate = (lon >= b[0]) & (lon <= b[2]) & (lat >= b[1]) & (lat <= b[3])
    out = np.zeros(len(lon), bool)
    inds = np.flatnonzero(candidate)
    try:
        import shapely
        shapely.prepare(it["_geom"])
        out[inds] = shapely.covers(it["_geom"], shapely.points(lon[inds], lat[inds]))
    except AttributeError:
        from shapely.prepared import prep
        geom = prep(it["_geom"])
        out[inds] = [geom.covers(Point(float(lon[i]), float(lat[i]))) for i in inds]
    return out


def locate_cloud(d, items, progress=None):
    """Count real points in EVERY polygon; bbox is only a candidate prefilter.
    No nearest-forest/centroid substitution when the scan crosses a boundary.
    """
    counts = {k: 0 for k in items}
    cultures = {k: 0 for k in items}
    total = outside = near_ground_total = 0
    path = os.path.join(d, "points.bin")
    basis = "LAS points" if os.path.isfile(path) else "tree peaks (legacy)"
    expected = os.path.getsize(path)//POINT_DTYPE.itemsize if os.path.isfile(path) else 0
    def batches():
        if os.path.isfile(path):
            with open(path, "rb") as f:
                while True:
                    rows = np.fromfile(f, POINT_DTYPE, count=200000)
                    if not len(rows):
                        break
                    yield rows["lon"], rows["lat"], rows["h"]
        else:
            with np.load(os.path.join(d, "trees.npz")) as z:
                for off in range(0, len(z["lon"]), 200000):
                    yield z["lon"][off:off+200000], z["lat"][off:off+200000], z["h"][off:off+200000]
    for lon, lat, h in batches():
        total += len(lon)
        in_forest = np.zeros(len(lon), bool)
        near_ground = np.abs(h) <= 0.15
        near_ground_total += int(near_ground.sum())
        if not len(lon):
            continue
        bbox = (float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max()))
        for code, it in items.items():
            b = it["_geom"].bounds
            if b[0]>bbox[2] or b[2]<bbox[0] or b[1]>bbox[3] or b[3]<bbox[1]:
                continue
            mask = territory_mask(it, lon, lat)
            counts[code] += int(mask.sum())
            cultures[code] += int((mask & near_ground).sum())
            if it.get("kind") != "forestry":
                in_forest |= mask
        outside += int((~in_forest).sum())
        if progress:
            progress(total,expected or total)
    forests, forestries = [], []
    for code, n in counts.items():
        if not n:
            continue
        it = items[code]
        row = dict(code=code, name=it["name"], points=n, culture_points=cultures[code])
        if it.get("kind") == "forestry":
            row.update(parent_code=it.get("parent_code"), parent_name=it.get("parent_name"))
            forestries.append(row)
        else:
            forests.append(row)
    forests.sort(key=lambda r:(-r["points"], r["name"]))
    forestries.sort(key=lambda r:(r.get("parent_name") or "",r["name"]))
    return dict(forests=forests,forestries=forestries,forest_count=len(forests),
                forestry_count=len(forestries),located_points=total,outside_forest_points=outside,
                location_basis=basis,location_version=3,culture_points=near_ground_total)


def build_router(*, base_dir, items_fn, is_admin, verify_csrf, logger=None, shp_prj=None):
    """Маршруты /api/forest3d/las/*. items_fn() → {code: item} из forest3d_api (с _geom)."""
    import re
    import secrets
    import subprocess
    import threading
    from fastapi import APIRouter
    from fastapi.responses import Response
    from starlette.concurrency import run_in_threadpool

    router = APIRouter()
    data_dir = os.getenv("FOREST3D_LAS_DIR") or os.path.join(base_dir, "instance", "forest3d_las")
    os.makedirs(data_dir, exist_ok=True)
    max_mb = int(os.getenv("FOREST3D_LAS_MAX_MB", "0"))          # 0 = без ограничения размера файла
    # FOREST3D_LAS_UPLOAD=all no longer grants uploads to non-admins.
    busy = os.path.join(data_dir, ".busy")
    id_re = re.compile(r"^[0-9a-f]{12}$")
    tree_cache = {}
    stats_cache = {}
    meta_lock = threading.Lock()

    def log(m, err=False):
        if logger:
            (logger.error if err else logger.info)(m)

    def can_upload(request):
        return bool(is_admin(request))

    def jdir(jid):
        if not id_re.match(jid or ""):
            raise HTTPException(404, "Облако не найдено")
        d = os.path.join(data_dir, jid)
        if not os.path.isdir(d):
            raise HTTPException(404, "Облако не найдено")
        return d

    def read_json(p, default=None):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default

    def write_json(p, obj):
        _write_json_atomic(p, obj)

    # ── очередь: одна обработка на сервер (общая для всех воркеров uvicorn) ──
    def _acquire():
        while True:
            try:
                fd = os.open(busy, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode()); os.close(fd)
                return
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(busy) > 180:     # хозяин умер (не обновлял > 3 мин)
                        os.remove(busy)
                        continue
                except OSError:
                    continue
                time.sleep(3)

    def _runner(d):
        st_path = os.path.join(d, "status.json")
        _acquire()
        try:
            st = read_json(st_path, {})
            st.update({"state": "running", "progress": 0.5, "stage": "Запуск обработки", "updated": time.time()})
            write_json(st_path, st)
            kw = {}
            if os.name == "nt":
                kw["creationflags"] = 0x00004000 | 0x08000000    # BELOW_NORMAL_PRIORITY | CREATE_NO_WINDOW
            p = subprocess.Popen([sys.executable, os.path.abspath(__file__), d], cwd=base_dir,
                                 stdout=subprocess.DEVNULL, stderr=open(os.path.join(d, "stderr.log"), "wb"), **kw)
            tmo = float(os.getenv("FOREST3D_LAS_TIMEOUT_S", "0"))          # 0 = без ограничения времени
            t_end = time.time() + tmo if tmo > 0 else float("inf")
            hb = os.path.join(d, "heartbeat")
            while p.poll() is None:
                try:
                    os.utime(busy, None)
                    with open(hb, "w") as _f:
                        _f.write(str(time.time()))
                except OSError:
                    pass
                if time.time() > t_end:
                    p.kill()
                    write_json(st_path, {"state": "error", "progress": 0, "stage": "Ошибка",
                                         "message": "Превышено время обработки", "updated": time.time()})
                    break
                time.sleep(2)
            st = read_json(st_path, {})
            if p.returncode not in (0, None) and st.get("state") != "error":
                write_json(st_path, {"state": "error", "progress": 0, "stage": "Ошибка", "updated": time.time(),
                                     "message": "Обработка аварийно завершилась (код %s) — возможно, не хватило памяти" % p.returncode})
            if st.get("state") == "done":
                _schedule_finalize(d)
            log(f"[forest3d-las] {os.path.basename(d)}: {read_json(st_path, {}).get('state')}")
        except Exception as e:
            log(f"[forest3d-las] ошибка запуска: {e}", True)
            write_json(st_path, {"state": "error", "progress": 0, "stage": "Ошибка", "message": str(e)[:300], "updated": time.time()})
        finally:
            try:
                os.remove(busy)
            except OSError:
                pass

    def _finalize(d, progress=None):
        """Automatic point-based assignment to all intersected forests/forestries."""
        with meta_lock:
            mp = os.path.join(d, "meta.json")
            meta = read_json(mp)
            if not meta:
                raise RuntimeError("Итоги LAS отсутствуют или повреждены (meta.json). Проверьте диагностику задания.")
            if meta.get("location_version") == 3:
                return meta
            meta.update(locate_cloud(d, items_fn(), progress=progress))
            primary = meta["forests"][0] if meta["forests"] else None
            meta["code"] = primary["code"] if primary else None
            meta["leshoz"] = "; ".join(r["name"] for r in meta["forests"]) or "Вне границ лесхозов"
            meta["inside"] = bool(primary)
            meta["hint_code"] = read_json(os.path.join(d, "job.json"), {}).get("code")
            write_json(mp, meta)
            return meta

    finalizing = set()
    finalize_lock = threading.Lock()

    def _schedule_finalize(d):
        lock_path = os.path.join(d, "finalize.lock")
        with finalize_lock:
            if d in finalizing:
                return
            try:
                if os.path.exists(lock_path) and time.time()-os.path.getmtime(lock_path)>3600:
                    os.remove(lock_path)
                fd=os.open(lock_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
                os.close(fd)
            except FileExistsError:
                return
            finalizing.add(d)
        def task():
            stop = threading.Event()
            st_path=os.path.join(d,"status.json")
            old=read_json(st_path,{})
            start=time.time()
            def update(percent,stage,**kw):
                st=dict(state="finalizing",progress=percent,stage=stage,updated=time.time(),
                        elapsed_s=float(old.get("elapsed_s",0)) + time.time()-start)
                st.update(kw);write_json(st_path,st)
            def beat():
                while not stop.wait(2):
                    try:
                        os.utime(lock_path,None)
                        with open(os.path.join(d,"heartbeat"),"w") as f:f.write(str(time.time()))
                    except OSError:
                        pass
            threading.Thread(target=beat,daemon=True).start()
            try:
                update(99,"Подготовка границ лесхозов и лесничеств")
                def progress(done,total):
                    update(round(99 + 0.9*done/max(1,total),2),"Определение лесхозов и лесничеств по LAS-точкам",
                           located_points=done,total_points=total)
                meta=_finalize(d,progress=progress)
                write_json(st_path,dict(state="done",progress=100,stage="Готово",updated=time.time(),
                                       elapsed_s=float(old.get("elapsed_s",0))+time.time()-start,trees=(meta or {}).get("trees",0)))
            except Exception as e:
                import traceback
                with open(os.path.join(d,"finalize_error.log"),"w",encoding="utf-8") as f:
                    traceback.print_exc(file=f)
                write_json(st_path,dict(state="error",progress=99,stage="Ошибка определения местоположения",updated=time.time(),message=str(e)[:500]))
                log(f"[forest3d-las] ошибка геопривязки {os.path.basename(d)}: {e}",True)
            finally:
                stop.set()
                try:os.remove(lock_path)
                except OSError:pass
                with finalize_lock:finalizing.discard(d)
        threading.Thread(target=task,daemon=True).start()

    def _status(d):
        st = read_json(os.path.join(d, "status.json"), {"state":"queued","progress":0,"stage":"В очереди"})
        try:hb=os.path.getmtime(os.path.join(d,"heartbeat"))
        except OSError:hb=0
        age=time.time()-max(float(st.get("updated",0)),hb)
        if st.get("state")=="uploading" and age>6*3600:
            st=dict(state="error",progress=0,stage="Ошибка",message="Загрузка файла не завершена")
        if st.get("state") in ("running","finalizing") and age>120:
            st=dict(state="error",progress=st.get("progress",0),stage="Обработка прервана",
                    message="Нет активности обработчика более 2 минут. Проверьте диагностику задания.")
        if st.get("state")=="queued" and age>1800 and not os.path.exists(busy):
            st=dict(state="error",progress=0,stage="Ошибка",message="Обработка прервана (перезапуск сервера?)")
        if st.get("state")=="done":
            meta=read_json(os.path.join(d,"meta.json"),{})
            if meta.get("location_version") != 3:
                _schedule_finalize(d)
                st=dict(state="finalizing",progress=99,stage="Подготовка геопривязки LAS",updated=time.time())
            else:
                st["meta"]=meta
        st["last_activity_seconds"]=round(max(0,age),1)
        return st

    @router.get("/api/forest3d/las/{jid}/diagnostics")
    async def las_diagnostics(request: Request,jid: str):
        if not is_admin(request):raise HTTPException(403,"Диагностика доступна только администратору")
        d=jdir(jid)
        def read():
            parts=[json.dumps(read_json(os.path.join(d,"status.json"),{}),ensure_ascii=False,indent=2)]
            for fn in ("stderr.log","error.log","finalize_error.log"):
                path=os.path.join(d,fn)
                if os.path.isfile(path):
                    with open(path,"rb") as f:
                        f.seek(max(0,os.path.getsize(path)-16384))
                        parts.append("\n--- "+fn+" ---\n"+f.read().decode("utf-8",errors="replace"))
            return "\n".join(parts)
        text=await run_in_threadpool(read)
        return Response(text,media_type="text/plain",headers={"Cache-Control":"no-store"})

    @router.get("/api/forest3d/las/caps")
    async def las_caps(request: Request):
        return {"can_upload": can_upload(request), "max_mb": max_mb, "formats": [".las", ".laz"],
                "module": "forest3d_las v15 (chunked upload, auto WGS-84 → UTM, Windows-safe status)", "chunked": True,
                "auto_utm_from_wgs84": True, "windows_atomic_status": True}

    @router.post("/api/forest3d/las/upload")
    async def las_upload(request: Request, name: str = Query("", max_length=200), crs: str = Query("auto", max_length=300),
                         species: str = Query("auto"), code: str = Query("", max_length=100)):
        if not can_upload(request):
            raise HTTPException(401, "Загрузка облаков точек — только для администратора (войдите в систему)")
        verify_csrf(request)
        ext = os.path.splitext(name.lower())[1]
        if ext not in (".las", ".laz"):
            raise HTTPException(400, "Нужен файл .las или .laz")
        if species not in ("auto", "conifer", "deciduous"):
            species = "auto"
        cl = request.headers.get("content-length")
        if max_mb > 0 and cl and cl.isdigit() and int(cl) > max_mb * 1024 * 1024:
            raise HTTPException(413, f"Файл больше {max_mb} МБ")
        if cl and cl.isdigit():
            import shutil as _sh
            free = _sh.disk_usage(data_dir).free
            if int(cl) + 512 * 1024 * 1024 > free:
                raise HTTPException(507, f"Мало места на диске сервера: свободно {free / 1073741824:.1f} ГБ, "
                                         f"файл {int(cl) / 1073741824:.1f} ГБ")
        jid = secrets.token_hex(6)
        d = os.path.join(data_dir, jid)
        os.makedirs(d)
        fn = "source" + ext
        size, head = 0, b""
        try:
            with open(os.path.join(d, fn), "wb", buffering=0) as f:
                buf = bytearray()
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    if len(head) < 4:
                        head += chunk[:4 - len(head)]
                        if len(head) >= 4 and head != b"LASF":
                            raise HTTPException(400, "Это не LAS/LAZ (нет сигнатуры LASF)")
                    size += len(chunk)
                    if max_mb > 0 and size > max_mb * 1024 * 1024:
                        raise HTTPException(413, f"Файл больше {max_mb} МБ")
                    buf += chunk
                    if len(buf) >= 16 * 1024 * 1024:          # пишем на диск блоками в отдельном потоке
                        await run_in_threadpool(f.write, bytes(buf))
                        buf.clear()
                if buf:
                    await run_in_threadpool(f.write, bytes(buf))
            if size < 375:
                raise HTTPException(400, "Файл пустой или повреждён")
        except BaseException:
            import shutil
            shutil.rmtree(d, ignore_errors=True)
            raise
        disp = os.path.basename(name.replace("\\", "/"))[:120]
        write_json(os.path.join(d, "job.json"), {
            "file": fn, "name": disp, "crs": crs or "auto", "species": species, "code": code or None,
            "uploaded": time.strftime("%Y-%m-%d %H:%M"), "size_mb": round(size / 1048576, 1),
            "shp_prj": shp_prj() if callable(shp_prj) else shp_prj, "delete_source": False,
        })
        write_json(os.path.join(d, "status.json"), {"state": "queued", "progress": 0, "stage": "В очереди", "updated": time.time()})
        threading.Thread(target=_runner, args=(d,), daemon=True, name=f"las-{jid}").start()
        log(f"[forest3d-las] загружено {disp} ({size / 1048576:.1f} МБ) → {jid}")
        return {"id": jid, "size_mb": round(size / 1048576, 1)}

    # ── загрузка ЧАСТЯМИ (обходит client_max_body_size nginx и любые прокси) ──
    # 1) POST /api/forest3d/las/upload/init?name=&size=&crs=&species=&code=   → {id, part_mb}
    # 2) PUT  /api/forest3d/las/upload/{id}/part?offset=N   (тело — кусок файла ≤ part_mb)
    # 3) POST /api/forest3d/las/upload/{id}/finish          → запуск обработки
    # Ограничиваем часть 32 МиБ: в nginx для chunk endpoint достаточно 40m.
    # Переменная позволяет уменьшить размер частей на медленных/ограниченных прокси.
    PART_MB = max(1, min(32, int(os.getenv("FOREST3D_LAS_PART_MB", "32"))))
    PART_BYTES = PART_MB * 1024 * 1024

    @router.post("/api/forest3d/las/upload/init")
    async def las_upload_init(request: Request, name: str = Query("", max_length=200), size: int = Query(..., ge=375),
                              crs: str = Query("auto", max_length=300), species: str = Query("auto"),
                              code: str = Query("", max_length=100)):
        if not can_upload(request):
            raise HTTPException(401, "Загрузка облаков точек — только для администратора (войдите в систему)")
        verify_csrf(request)
        ext = os.path.splitext(name.lower())[1]
        if ext not in (".las", ".laz"):
            raise HTTPException(400, "Нужен файл .las или .laz")
        if max_mb > 0 and size > max_mb * 1024 * 1024:
            raise HTTPException(413, f"Файл больше {max_mb} МБ")
        import shutil as _sh
        free = _sh.disk_usage(data_dir).free
        if size + 512 * 1024 * 1024 > free:
            raise HTTPException(507, f"Мало места на диске сервера: свободно {free / 1073741824:.1f} ГБ, файл {size / 1073741824:.1f} ГБ")
        jid = secrets.token_hex(6)
        d = os.path.join(data_dir, jid)
        os.makedirs(d)
        os.makedirs(os.path.join(d, "parts"), exist_ok=True)
        fn = "source" + ext
        with open(os.path.join(d, fn), "wb") as f:      # резервируем файл нужного размера
            f.truncate(size)
        write_json(os.path.join(d, "job.json"), {
            "file": fn, "name": os.path.basename(name.replace("\\", "/"))[:120], "crs": crs or "auto",
            "species": species if species in ("auto", "conifer", "deciduous") else "auto", "code": code or None,
            "uploaded": time.strftime("%Y-%m-%d %H:%M"), "size_mb": round(size / 1048576, 1), "size": size,
            "shp_prj": shp_prj() if callable(shp_prj) else shp_prj, "delete_source": False,
        })
        write_json(os.path.join(d, "status.json"), {"state": "uploading", "progress": 0, "stage": "Передача файла",
                                                    "received": 0, "updated": time.time()})
        log(f"[forest3d-las] начата загрузка частями {name} ({size / 1048576:.1f} МБ) → {jid}")
        return {"id": jid, "part_mb": PART_MB}

    @router.put("/api/forest3d/las/upload/{jid}/part")
    async def las_upload_part(request: Request, jid: str, offset: int = Query(..., ge=0)):
        if not can_upload(request):
            raise HTTPException(401, "Требуется вход администратора")
        verify_csrf(request)
        d = jdir(jid)
        job = read_json(os.path.join(d, "job.json"), {})
        st = read_json(os.path.join(d, "status.json"), {})
        if st.get("state") != "uploading":
            raise HTTPException(409, "Загрузка уже завершена или отменена")
        total = int(job.get("size", 0))
        if offset >= total or offset % PART_BYTES:
            raise HTTPException(400, "Неверное смещение части файла")
        body = await request.body()
        expected_len = min(PART_BYTES, total - offset)
        if len(body) != expected_len:
            raise HTTPException(400, "Неверный кусок файла")
        if offset == 0 and body[:4] != b"LASF":
            raise HTTPException(400, "Это не LAS/LAZ (нет сигнатуры LASF)")
        import hashlib
        part_dir = os.path.join(d, "parts")
        marker = os.path.join(part_dir, f"{offset}.sha256")
        digest = hashlib.sha256(body).hexdigest()

        def _w():
            # Повтор после потери ответа идемпотентен: уже записанную часть
            # не учитываем повторно и не принимаем подменённое содержимое.
            try:
                with open(marker, encoding="ascii") as mf:
                    previous = mf.read().strip()
            except OSError:
                previous = None
            if previous and previous != digest:
                raise HTTPException(409, "Содержимое этой части уже загружено и отличается")
            if not previous:
                with open(os.path.join(d, job["file"]), "r+b") as f:
                    f.seek(offset)
                    f.write(body)
                    f.flush()
                tmp_marker = marker + "." + secrets.token_hex(4) + ".tmp"
                with open(tmp_marker, "w", encoding="ascii") as mf:
                    mf.write(digest)
                os.replace(tmp_marker, marker)
            with meta_lock:
                s2 = read_json(os.path.join(d, "status.json"), {})
                # Считаем уникальные части по маркерам, а не суммируем байты:
                # сетевой retry не может ошибочно завершить неполную загрузку.
                rec = 0
                for entry in os.listdir(part_dir):
                    if not entry.endswith(".sha256"):
                        continue
                    try:
                        part_offset = int(entry[:-7])
                    except ValueError:
                        continue
                    if 0 <= part_offset < total and part_offset % PART_BYTES == 0:
                        rec += min(PART_BYTES, total - part_offset)
                s2.update({"received": rec, "progress": round(min(99.0, 100.0 * rec / max(total, 1)), 1),
                           "stage": "Передача файла", "updated": time.time()})
                write_json(os.path.join(d, "status.json"), s2)
        await run_in_threadpool(_w)
        return {"ok": True}

    @router.post("/api/forest3d/las/upload/{jid}/finish")
    async def las_upload_finish(request: Request, jid: str):
        if not can_upload(request):
            raise HTTPException(401, "Требуется вход администратора")
        verify_csrf(request)
        d = jdir(jid)
        job = read_json(os.path.join(d, "job.json"), {})
        st = read_json(os.path.join(d, "status.json"), {})
        if st.get("state") != "uploading":
            raise HTTPException(409, "Загрузка уже завершена")
        total = int(job.get("size", 0))
        part_dir = os.path.join(d, "parts")
        missing = [
            offset for offset in range(0, total, PART_BYTES)
            if not os.path.isfile(os.path.join(part_dir, f"{offset}.sha256"))
        ]
        if missing or os.path.getsize(os.path.join(d, job["file"])) != total:
            raise HTTPException(400, "Файл передан не полностью — повторите загрузку")
        write_json(os.path.join(d, "status.json"), {"state": "queued", "progress": 0, "stage": "В очереди", "updated": time.time()})
        import shutil
        shutil.rmtree(part_dir, ignore_errors=True)
        threading.Thread(target=_runner, args=(d,), daemon=True, name=f"las-{jid}").start()
        log(f"[forest3d-las] загрузка частями завершена {job.get('name')} → {jid}")
        return {"id": jid, "size_mb": job.get("size_mb")}

    @router.get("/api/forest3d/las/job/{jid}")
    async def las_job(jid: str):
        d = jdir(jid)
        st = await run_in_threadpool(_status, d)
        return Response(json.dumps(st, ensure_ascii=False), media_type="application/json", headers={"Cache-Control": "no-store"})

    def _scope_mask(it, lon, lat):
        return territory_mask(it, lon, lat)

    def _projector(it):
        from pyproj import Transformer
        c = it["_geom"].centroid
        return Transformer.from_crs("EPSG:4326",
            f"+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84 +units=m +no_defs", always_xy=True)

    def _scope_stats(d, it):
        path = os.path.join(d, "trees.npz")
        key = (os.path.basename(d), it["code"], os.stat(path).st_mtime_ns)
        if key in stats_cache:
            return stats_cache[key]
        with np.load(path) as z:
            m = _scope_mask(it, z["lon"], z["lat"])
            h, typ, dbh, cd, meas = (z[k][m] for k in ("h", "typ", "dbh", "cd", "meas"))
        n = len(h)
        result = dict(trees=n, conifer=int((typ == 1).sum()), deciduous=int((typ == 2).sum()),
            h_mean=round(float(h.mean()),1) if n else 0, h_max=round(float(h.max()),1) if n else 0,
            dbh_mean=round(float(dbh.mean()),1) if n else 0, cd_mean=round(float(cd.mean()),1) if n else 0,
            dbh_measured=int(meas.sum()),
            h_classes=[dict(**{"from":a,"to":b}, conifer=int(((h>=a)&(h<b)&(typ==1)).sum()),
                            deciduous=int(((h>=a)&(h<b)&(typ==2)).sum()))
                       for a,b in [(0,10),(10,20),(20,30),(30,99)]])
        if len(stats_cache) >= 64:
            stats_cache.pop(next(iter(stats_cache)))
        meta = read_json(os.path.join(d, "meta.json"), {})
        if meta.get("footprint_wgs84"):
            from shapely.geometry import Polygon
            from pyproj import Geod
            footprint = Polygon(meta["footprint_wgs84"]).buffer(0).intersection(it["_geom"])
            if not footprint.is_empty:
                area, _ = Geod(ellps="WGS84").geometry_area_perimeter(footprint)
                result["area_ha"] = round(abs(area) / 1e4, 2)
        stats_cache[key] = result
        return result

    @router.get("/api/forest3d/las")
    async def las_list(code: str = Query("", max_length=100)):
        def _list():
            out = []
            for jid in sorted(os.listdir(data_dir), reverse=True):
                d = os.path.join(data_dir, jid)
                if not id_re.match(jid) or not os.path.isdir(d):
                    continue
                st = _status(d)
                job = read_json(os.path.join(d, "job.json"), {})
                m = st.get("meta") or {}
                scope = items_fn().get(code) if code else None
                if code and scope is None:
                    raise HTTPException(404, "Территория не найдена")
                if code:
                    if st["state"] == "done":
                        rows = m.get("forestries", []) if scope.get("kind") == "forestry" else m.get("forests", [])
                        if not any(r["code"] == code for r in rows):
                            continue
                    elif job.get("code") and job.get("code") not in (code, scope.get("parent_code")):
                        continue
                e = {"id": jid, "state": st["state"], "progress": st.get("progress"), "stage": st.get("stage"),
                     "message": st.get("message"), "name": job.get("name"), "uploaded": job.get("uploaded")}
                if st["state"] == "done":
                    e.update({k: m.get(k) for k in ("code", "leshoz", "inside", "trees", "conifer", "deciduous", "h_mean", "h_max",
                                                     "dbh_mean", "dbh_measured", "cd_mean", "crs", "ground", "area_ha",
                                                     "points", "density_pts_m2", "h_classes", "center", "bbox_wgs84",
                                                     "footprint_wgs84", "species_mode", "stored_points", "zero_height_points", "terrain_available", "format_version", "forests", "forestries", "forest_count", "forestry_count", "location_basis", "outside_forest_points", "culture_points")})
                    if scope:
                        e.update(_scope_stats(d, scope))
                        e["in_scope"] = True
                out.append(e)
            return out
        items = await run_in_threadpool(_list)
        return Response(json.dumps({"items": items}, ensure_ascii=False), media_type="application/json",
                        headers={"Cache-Control": "no-store"})

    @router.get("/api/forest3d/las/{jid}/trees")
    async def las_trees(request: Request, jid: str, code: str = Query(..., max_length=100),
                        limit: int = Query(0, ge=0)):
        d = jdir(jid)

        def _build():
            key = (jid, code, limit)
            if key in tree_cache:
                return tree_cache[key]
            from pyproj import Transformer
            items = items_fn()
            it = items.get(code)
            if not it:
                raise HTTPException(404, "Лесхоз не найден")
            z = dict(np.load(os.path.join(d, "trees.npz")))
            mask = _scope_mask(it, z["lon"], z["lat"])
            z = {k:v[mask] for k,v in z.items()}
            n_all = len(z["h"])
            if limit and n_all > limit:          # равномерная выборка, без предпочтения высоким деревьям
                sel = np.linspace(0, n_all - 1, limit, dtype=np.int64)
                z = {k: v[sel] for k, v in z.items()}
            lon0, lat0 = it["center"]
            # тот же центр AEQD, что у контура лесхоза (forest3d_api: центроид, округлённый до 1e-6)
            g = it["_geom"].centroid
            fwd = Transformer.from_proj("EPSG:4326", f"+proj=aeqd +lat_0={g.y} +lon_0={g.x} +datum=WGS84 +units=m +no_defs",
                                        always_xy=True).transform
            x, y = fwd(z["lon"], z["lat"])
            arr = np.empty((len(x), 7), np.float32)
            arr[:, 0], arr[:, 1] = x, y
            arr[:, 2], arr[:, 3], arr[:, 4], arr[:, 5] = z["h"], z["dbh"], z["cd"], z["cbh"]
            arr[:, 6] = z["typ"].astype(np.float32) + 10 * z["meas"].astype(np.float32)
            body = arr.tobytes()
            if len(tree_cache) > 16:
                tree_cache.pop(next(iter(tree_cache)))
            tree_cache[key] = body
            return body
        body = await run_in_threadpool(_build)
        import hashlib
        etag = '"' + hashlib.md5(body[:4096] + str(len(body)).encode() + jid.encode() + code.encode()).hexdigest()[:20] + '"'
        hdr = {"Cache-Control": "no-store", "ETag": etag, "X-Trees": str(len(body) // 28)}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=hdr)
        return Response(body, media_type="application/octet-stream", headers=hdr)

    @router.get("/api/forest3d/las/{jid}/points")
    async def las_points(jid: str, code: str = Query(..., max_length=100),
                         offset: int = Query(0, ge=0), limit: int = Query(100000, ge=1, le=200000)):
        d = jdir(jid)
        def build():
            it = items_fn().get(code)
            if not it:
                raise HTTPException(404, "Территория не найдена")
            path = os.path.join(d, "points.bin")
            if not os.path.isfile(path):
                raise HTTPException(409, "Перезагрузите исходный LAS: старая обработка не сохраняла точки")
            total = os.path.getsize(path) // POINT_DTYPE.itemsize
            with open(path, "rb") as f:
                f.seek(min(offset,total) * POINT_DTYPE.itemsize)
                rows = np.fromfile(f, POINT_DTYPE, count=min(limit, max(0,total-offset)))
            next_offset = min(total, offset + len(rows))
            rows = rows[_scope_mask(it, rows["lon"], rows["lat"])]
            x,y = _projector(it).transform(rows["lon"], rows["lat"])
            arr = np.empty((len(rows),8), dtype="<f4")
            arr[:,0],arr[:,1],arr[:,2],arr[:,3],arr[:,4] = x,y,rows["z"],rows["h"],rows["cls"]
            rgb = rows["rgb"].astype(np.float32)/255
            no_rgb = (rows["rgb"] == 0).all(axis=1)
            rgb[no_rgb] = [0.55,0.51,0.43]
            veg = np.isin(rows["cls"], [3,4,5]) | ((rows["h"] > 0.15) & np.isin(rows["cls"],[0,1]))
            rgb[no_rgb & veg] = [0.22,0.48,0.18]
            # Never classify explicit low vegetation (3/4/5) as ground, even at H=0.
            soil = (rows["cls"] == 2) | ((rows["h"] <= 0.15) & np.isin(rows["cls"],[0,1]))
            rgb[soil] = [0.25,0.64,0.16]  # culture plot by the user's ground-point rule
            arr[:,5:8] = rgb
            return arr.tobytes(), total, next_offset
        body,total,nxt = await run_in_threadpool(build)
        return Response(body, media_type="application/octet-stream", headers={
            "Cache-Control":"no-store", "X-Points-Total":str(total), "X-Next-Offset":str(nxt),
            "X-Points":str(len(body)//32), "X-Point-Stride":"8"})

    @router.get("/api/forest3d/las/{jid}/terrain")
    async def las_terrain(jid: str, code: str = Query(..., max_length=100)):
        d = jdir(jid)
        def build():
            from pyproj import Transformer
            it = items_fn().get(code)
            if not it:
                raise HTTPException(404, "Территория не найдена")
            path = os.path.join(d,"terrain.npz")
            if not os.path.isfile(path):
                raise HTTPException(409, "Для рельефа LAS перезагрузите исходное облако")
            with np.load(path) as f:
                dtm,coverage = f["dtm"],f["coverage"]
                cultures=f["cultures"] if "cultures" in f else np.zeros_like(coverage)
                x0,y0,res,unit = (float(f[k]) for k in ("x0","y0","res","unit"))
                crs = str(f["crs"])
            ny,nx = dtm.shape
            to_wgs = Transformer.from_crs(crs,"EPSG:4326",always_xy=True)
            cx = [x0+res*0.5,x0+res*(nx-0.5)]
            cy = [y0+res*0.5,y0+res*(ny-0.5)]
            bx,by = np.meshgrid(np.linspace(cx[0],cx[1],20),np.linspace(cy[0],cy[1],20))
            lon,lat = to_wgs.transform(bx.ravel(),by.ravel())
            fwd = _projector(it)
            ax,ay = fwd.transform(lon,lat)
            sb=it["bounds_m"]
            xmin,xmax=max(float(min(ax)),sb[0]),min(float(max(ax)),sb[2])
            ymin,ymax=max(float(min(ay)),sb[1]),min(float(max(ay)),sb[3])
            if xmin>=xmax or ymin>=ymax:
                raise HTTPException(404,"Облако вне выбранной территории")
            gx,gy=160,160
            xx,yy=np.meshgrid(np.linspace(xmin,xmax,gx),np.linspace(ymin,ymax,gy))
            from pyproj.enums import TransformDirection
            lon,lat=fwd.transform(xx.ravel(),yy.ravel(),direction=TransformDirection.INVERSE)
            wx,wy=Transformer.from_crs("EPSG:4326",crs,always_xy=True).transform(lon,lat)
            zi=bilinear(dtm,x0,y0,res,wx,wy)*unit
            ix=np.clip(((wx-x0)/res).astype(int),0,nx-1)
            iy=np.clip(((wy-y0)/res).astype(int),0,ny-1)
            valid=(wx>=cx[0])&(wx<=cx[1])&(wy>=cy[0])&(wy<=cy[1])&coverage[iy,ix]&_scope_mask(it,lon,lat)
            return dict(nx=gx,ny=gy,bounds_m=[xmin,ymin,xmax,ymax],
                z=[round(float(v),3) if ok else None for v,ok in zip(zi,valid)],
                datum_m=float(np.median(dtm))*unit,cultures=(cultures[iy,ix]&valid).astype(int).tolist(),
                source="LAS DTM",interpolated=True)
        result=await run_in_threadpool(build)
        return Response(json.dumps(result,allow_nan=False),media_type="application/json",headers={"Cache-Control":"no-store"})

    @router.delete("/api/forest3d/las/{jid}")
    async def las_delete(request: Request, jid: str):
        if not is_admin(request):
            raise HTTPException(401, "Удаление — только для администратора")
        verify_csrf(request)
        d = jdir(jid)
        st = read_json(os.path.join(d, "status.json"), {})
        if st.get("state") in ("queued", "running", "finalizing") and time.time() - float(st.get("updated", 0)) < 1800:
            raise HTTPException(409, "Облако ещё обрабатывается")   # «uploading» удалять можно (отмена)
        import shutil
        await run_in_threadpool(shutil.rmtree, d, True)
        for k in [k for k in tree_cache if k[0] == jid]:
            tree_cache.pop(k, None)
        for k in [k for k in stats_cache if k[0] == jid]:
            stats_cache.pop(k, None)
        return {"ok": True}

    return router
