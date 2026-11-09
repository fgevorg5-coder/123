#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mbtiles2tif.py — растровые MBTiles → GeoTIFF + world-файл (.tfw и .tfwx) + .prj. [v20]

Тайлы выбранного уровня zoom склеиваются в один GeoTIFF:
  • EPSG:3857 (родная СК тайлов) — без перепроецирования, пиксель в пиксель с тайлами;
  • любая другая СК (EPSG:4326, UTM, СК-42/СК-63, PROJ-строка или WKT) — перепроецирование GDAL.
Прозрачность сохраняется альфа-каналом (или заливается фоном), пустые поля по краям обрезаются,
строятся внутренние пирамиды. World-файл: A D B E C F (C/F — центр левого верхнего пикселя);
.tfwx — то же содержимое (для программ, которые ищут .tfwx); .prj — ESRI WKT.
Поддерживаются схемы TMS (по спецификации MBTiles) и XYZ (metadata scheme=xyz), PNG/JPEG/WebP.

  python mbtiles2tif.py plan.mbtiles [-o out/] [--zoom max|auto|N] [--crs EPSG:3857]
         [--compress deflate|lzw|jpeg|none] [--background none|white|black|#RRGGBB]
         [--clip auto|bounds|none] [--max-mp 400] [--resampling cubic|bilinear|nearest|lanczos]

Пакеты: numpy, pillow, rasterio (pip install numpy pillow rasterio).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds
from rasterio.windows import Window

T_START = time.time()
ORIGIN = 20037508.342789244            # π·R, R = 6378137 м
ESRI_3857 = ('PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
             'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
             'PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],'
             'PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],'
             'UNIT["Meter",1.0]]')
RESAMPLING = {"nearest": Resampling.nearest, "bilinear": Resampling.bilinear, "cubic": Resampling.cubic,
              "lanczos": Resampling.lanczos, "average": Resampling.average}
_log = None


def log(*a):
    text = " ".join(str(x) for x in a)
    if _log:
        _log(text)
    else:
        print("[%6.1fs] %s" % (time.time() - T_START, text), file=sys.stderr, flush=True)


def warn(*a):
    log("ВНИМАНИЕ:", *a)


def parse_color(v):
    v = str(v or "none").strip().lower()
    if v in ("", "none", "transparent", "auto"):
        return None
    if v == "white":
        return (255, 255, 255)
    if v == "black":
        return (0, 0, 0)
    m = re.fullmatch(r"#?([0-9a-f]{6})", v)
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"(\d{1,3}),(\d{1,3}),(\d{1,3})", v)
    if m:
        return tuple(min(255, int(x)) for x in m.groups())
    raise SystemExit(f"фон: none, white, black или #RRGGBB, а не «{v}»")


class MBTiles:
    """Чтение растрового MBTiles (только чтение, без блокировок)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        try:
            self.con = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
            self.meta = {str(k): str(v) for k, v in self.con.execute("SELECT name, value FROM metadata")}
        except sqlite3.DatabaseError as e:
            raise SystemExit(f"{self.path.name}: не MBTiles или файл повреждён ({e})")
        self.fmt = (self.meta.get("format") or "").lower()
        if self.fmt in ("pbf", "mvt"):
            raise SystemExit(f"{self.path.name}: векторные MBTiles (pbf) — нужен растровый (PNG/JPEG/WebP)")
        self.xyz = (self.meta.get("scheme") or "tms").lower() == "xyz"
        self.zooms = [int(z) for (z,) in self.con.execute("SELECT DISTINCT zoom_level FROM tiles ORDER BY zoom_level")]
        if not self.zooms:
            raise SystemExit(f"{self.path.name}: в файле нет тайлов")

    def extent(self, z):
        """(x0, x1, y0, y1) в схеме XYZ и число тайлов уровня z."""
        x0, x1, r0, r1, n = self.con.execute(
            "SELECT MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row), COUNT(*) FROM tiles WHERE zoom_level=?",
            (z,)).fetchone()
        if self.xyz:
            return int(x0), int(x1), int(r0), int(r1), int(n)
        m = 2 ** z - 1
        return int(x0), int(x1), m - int(r1), m - int(r0), int(n)

    def tiles(self, z, batch=256):
        cur = self.con.execute("SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=?", (z,))
        m = 2 ** z - 1
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                return
            yield [(int(c), int(r) if self.xyz else m - int(r), bytes(d)) for c, r, d in rows if d]

    def tile_size(self, z):
        for rows in self.tiles(z, 8):
            for _, _, d in rows:
                try:
                    with Image.open(io.BytesIO(d)) as im:
                        return im.size[0]
                except Exception:
                    continue
        return 256

    def bounds(self):
        try:
            b = [float(v) for v in self.meta.get("bounds", "").split(",")]
            if len(b) == 4 and b[0] < b[2] and b[1] < b[3]:
                return b
        except ValueError:
            pass
        return None


def pick_zoom(mb: MBTiles, want, ts_guess, max_mp):
    """Уровень zoom: max — самый подробный, auto — самый подробный в пределах max_mp, N — заданный."""
    def mp(z):
        x0, x1, y0, y1, _ = mb.extent(z)
        return (x1 - x0 + 1) * (y1 - y0 + 1) * ts_guess * ts_guess / 1e6
    want = str(want or "max").strip().lower()
    if want not in ("max", "auto"):
        try:
            zz = int(want)
        except ValueError:
            raise SystemExit(f"zoom: max, auto или число, а не «{want}»")
        if zz not in mb.zooms:
            lower = [z for z in mb.zooms if z <= zz]
            z = lower[-1] if lower else mb.zooms[0]
            warn(f"уровня z{zz} в файле нет (есть z{mb.zooms[0]}–z{mb.zooms[-1]}) — взят z{z}")
        else:
            z = zz
    else:
        z = mb.zooms[-1]
    while mp(z) > max_mp and z > mb.zooms[0]:
        lower = [q for q in mb.zooms if q < z]
        nz = lower[-1]
        warn(f"z{z} даёт {mp(z):.0f} Мпикс (> {max_mp:g}) — взят z{nz}; ограничение: --max-mp / GEOREF_MB2TIF_MAX_MP")
        z = nz
    if mp(z) > max_mp:
        raise SystemExit(f"даже z{z} даёт {mp(z):.0f} Мпикс — больше допустимых {max_mp:g}")
    return z


def decode(item, ts):
    c, r, data = item
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGBA")
            if im.size != (ts, ts):
                im = im.resize((ts, ts), Image.BILINEAR)
            return c, r, np.asarray(im)
    except Exception:
        return c, r, None


def world_lines(tr: Affine):
    a, b, c, d, e, f = tr.a, tr.b, tr.c, tr.d, tr.e, tr.f
    return [a, d, b, e, c + a / 2 + b / 2, f + d / 2 + e / 2]


def esri_wkt(crs: CRS) -> str:
    if crs.to_epsg() == 3857:
        return ESRI_3857
    try:
        return crs.to_wkt(version="WKT1_ESRI")
    except Exception:
        try:
            return crs.to_wkt(morph_to_esri_dialect=True)
        except Exception:
            return crs.to_wkt()


def crs_label(crs: CRS) -> str:
    epsg = crs.to_epsg()
    try:
        name = crs.to_dict().get("proj") if not epsg else None
    except Exception:
        name = None
    wkt = crs.to_wkt()
    m = re.match(r'\s*(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\["([^"]+)"', wkt)
    title = m.group(1) if m else (name or "")
    if title.lower() in ("unknown", "unnamed", ""):
        title = ""
    if epsg:
        return f"EPSG:{epsg}" + (f" — {title}" if title else "")
    if title:
        return title
    try:                                            # PROJ-строка без имени: коротко и по делу
        p = crs.to_proj4()
        keep = [t for t in p.split() if t.split("=")[0] in ("+proj", "+lat_0", "+lon_0", "+k", "+k_0", "+x_0", "+ellps", "+datum", "+zone")]
        return "пользовательская СК (" + " ".join(keep)[:90] + ")"
    except Exception:
        return "пользовательская СК"


def gtiff_profile(width, height, count, crs, transform, compress, block=256):
    p = {"driver": "GTiff", "width": width, "height": height, "count": count, "dtype": "uint8", "crs": crs,
         "transform": transform, "tiled": True, "blockxsize": block, "blockysize": block, "BIGTIFF": "IF_SAFER",
         "interleave": "pixel"}
    if compress == "jpeg":
        p.update(compress="JPEG", jpeg_quality=90, photometric="YCBCR")
    elif compress in ("deflate", "lzw"):
        p.update(compress=compress.upper(), predictor=2)
        if compress == "deflate":
            p["zlevel"] = 6
        if count == 4:
            p.update(photometric="RGB", alpha="YES")
    elif count == 4:
        p.update(photometric="RGB", alpha="YES")
    return p


def mosaic(mb: MBTiles, z, ts, out_tif: Path, threads=4, shift=(0.0, 0.0)):
    """Шаг 1: тайлы z → GeoTIFF EPSG:3857 RGBA (без потерь). Возвращает (пиксельная рамка непустого, тайлов).
    [v20.7] shift — сдвиг привязки мозаики, м EPSG:3857 (восток, север): точный, пиксели не пересчитываются."""
    x0, x1, y0, y1, n = mb.extent(z)
    W, H = (x1 - x0 + 1) * ts, (y1 - y0 + 1) * ts
    span = 2 * ORIGIN / 2 ** z
    res = span / ts
    tr = Affine(res, 0, -ORIGIN + x0 * span + float(shift[0]), 0, -res, ORIGIN - y0 * span + float(shift[1]))
    log(f"{mb.path.name}: z{z}, тайлов {n}, {W}×{H} px, пиксель {res:.4f} м (Web Mercator)")
    bbox = [W, H, -1, -1]
    done = bad = 0
    transp = False
    prof = gtiff_profile(W, H, 4, CRS.from_epsg(3857), tr, "deflate")
    prof["zlevel"] = 1                              # временный файл: быстрее
    with rasterio.open(out_tif, "w", **prof) as dst, ThreadPoolExecutor(max(1, threads)) as ex:
        for rows in mb.tiles(z):
            for c, r, arr in ex.map(lambda it: decode(it, ts), rows):
                if arr is None:
                    bad += 1
                    continue
                col, row = (c - x0) * ts, (r - y0) * ts
                if col < 0 or row < 0 or col + ts > W or row + ts > H:
                    continue
                a = arr[:, :, 3]
                if not transp and (a < 255).any():
                    transp = True
                ys = np.flatnonzero(a.any(axis=1))
                if ys.size:
                    xs = np.flatnonzero(a.any(axis=0))
                    bbox[0] = min(bbox[0], col + int(xs[0]))
                    bbox[1] = min(bbox[1], row + int(ys[0]))
                    bbox[2] = max(bbox[2], col + int(xs[-1]))
                    bbox[3] = max(bbox[3], row + int(ys[-1]))
                    dst.write(np.ascontiguousarray(arr.transpose(2, 0, 1)), window=Window(col, row, ts, ts))
            done += len(rows)
            log(f"тайлы: {done}/{n}")
    if bad:
        warn(f"не прочитано тайлов: {bad} (повреждены или неизвестный формат)")
    if bbox[2] < 0:
        raise SystemExit(f"{mb.path.name}: на уровне z{z} все тайлы пустые (прозрачные)")
    return tr, (W, H), bbox, n - bad, transp


def _copy_blocks(src, dst, src_win: Window, bg, jpeg):
    """Окно src → dst (тот же размер пикселя), полосами по 1024 строки; фон/маска для RGB."""
    step = 1024
    for r0 in range(0, int(src_win.height), step):
        h = min(step, int(src_win.height) - r0)
        w = Window(src_win.col_off, src_win.row_off + r0, src_win.width, h)
        data = src.read(window=w, boundless=True, fill_value=0)
        _write(dst, data, Window(0, r0, int(src_win.width), h), bg, jpeg)


def _write(dst, rgba, win, bg, jpeg):
    if dst.count == 4:
        dst.write(rgba, window=win)
        return
    rgb = rgba[:3].astype(np.float32)
    a = rgba[3:4].astype(np.float32) / 255.0
    if bg is not None:
        b = np.array(bg, dtype=np.float32).reshape(3, 1, 1)
        rgb = rgb * a + b * (1 - a)
    dst.write(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), window=win)
    if jpeg and bg is None:
        dst.write_mask(rgba[3] > 0, window=win)


def convert(path, out_dir, zoom="max", crs="EPSG:3857", compress="deflate", background="none", clip="auto",
            max_mp=400.0, resampling="cubic", overviews=True, threads=4, name=None, log_fn=None, shift=None):
    """Один MBTiles → GeoTIFF + .tfw + .tfwx + .prj + _preview.png. Возвращает сводку.
    [v20.7] shift=(dx, dy) — результат сдвинут на dx, dy м EPSG:3857 (ручная поправка привязки)."""
    global _log
    if log_fn:
        _log = log_fn
    path, out_dir = Path(path), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    compress = str(compress or "deflate").lower()
    if compress not in ("deflate", "lzw", "jpeg", "none"):
        raise SystemExit("сжатие: deflate, lzw, jpeg или none")
    bg = parse_color(background)
    try:
        dst_crs = CRS.from_user_input(str(crs or "EPSG:3857").strip())
    except Exception as e:
        raise SystemExit(f"не распознана СК «{str(crs)[:80]}»: {e}")
    mb = MBTiles(path)
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name or path.stem).strip(" .") or "mbtiles"
    ts0 = mb.tile_size(mb.zooms[-1])
    z = pick_zoom(mb, zoom, ts0, float(max_mp))
    ts = mb.tile_size(z)
    tmp = out_dir / f".{stem}.mosaic.tif"
    sx, sy = (float(shift[0]), float(shift[1])) if shift else (0.0, 0.0)
    tr, (W, H), bbox, used, transp = mosaic(mb, z, ts, tmp, threads, (sx, sy))
    # рамка результата (пиксели мозаики)
    if clip == "auto" and not transp and mb.bounds():
        log("тайлы без прозрачности (JPEG) — обрезка по границам bounds из метаданных")
        clip = "bounds"
    if clip == "none":
        win = Window(0, 0, W, H)
    elif clip == "bounds" and mb.bounds():
        b = mb.bounds()
        xs, ys = rasterio.warp.transform("EPSG:4326", "EPSG:3857", [b[0], b[2]], [b[1], b[3]])
        xs, ys = [v + sx for v in xs], [v + sy for v in ys]
        inv = ~tr
        c0, r0 = inv * (xs[0], ys[1])
        c1, r1 = inv * (xs[1], ys[0])
        c0, r0 = max(0, int(math.floor(c0))), max(0, int(math.floor(r0)))
        c1, r1 = min(W, int(math.ceil(c1))), min(H, int(math.ceil(r1)))
        win = Window(c0, r0, max(1, c1 - c0), max(1, r1 - r0))
    else:
        if clip == "bounds":
            warn("в метаданных нет bounds — обрезано по непустым пикселям")
        win = Window(bbox[0], bbox[1], bbox[2] - bbox[0] + 1, bbox[3] - bbox[1] + 1)
    count = 4 if (bg is None and compress != "jpeg") else 3
    jpeg = compress == "jpeg"
    out_tif = out_dir / f"{stem}.tif"
    rs = RESAMPLING.get(str(resampling or "cubic"), Resampling.cubic)
    same = dst_crs.to_epsg() == 3857
    env = rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True, GDAL_NUM_THREADS=str(max(1, threads)))
    with env, rasterio.open(tmp) as src:
        if same:
            log(f"сборка GeoTIFF: {int(win.width)}×{int(win.height)} px, EPSG:3857 без перепроецирования")
            prof = gtiff_profile(int(win.width), int(win.height), count, dst_crs, src.window_transform(win), compress)
            with rasterio.open(out_tif, "w", **prof) as dst:
                _copy_blocks(src, dst, win, bg, jpeg)
        else:
            sub_bounds = rasterio.windows.bounds(win, src.transform)
            dtr, dw, dh = calculate_default_transform(src.crs, dst_crs, int(win.width), int(win.height), *sub_bounds)
            log(f"перепроецирование в {crs_label(dst_crs)}: {dw}×{dh} px")
            if dw * dh > float(max_mp) * 1.6e6:
                raise SystemExit(f"после перепроецирования {dw * dh / 1e6:.0f} Мпикс — уменьшите zoom")
            prof = gtiff_profile(dw, dh, count, dst_crs, dtr, compress)
            with WarpedVRT(src, crs=dst_crs, transform=dtr, width=dw, height=dh, resampling=rs,
                           src_alpha=4, dst_alpha=4, warp_mem_limit=256) as vrt, rasterio.open(out_tif, "w", **prof) as dst:
                step = 1024
                for r0 in range(0, dh, step):
                    h = min(step, dh - r0)
                    w = Window(0, r0, dw, h)
                    _write(dst, vrt.read(window=w), w, bg, jpeg)
                    log(f"перепроецирование: строк {r0 + h}/{dh}")
    # пирамиды
    with rasterio.open(out_tif, "r+") as dst:
        if overviews and max(dst.width, dst.height) > 1024:
            f, facs = 2, []
            while max(dst.width, dst.height) / f >= 256:
                facs.append(f)
                f *= 2
            dst.build_overviews(facs, Resampling.average)
            dst.update_tags(ns="rio_overview", resampling="average")
        out_tr, ow, oh, out_crs = dst.transform, dst.width, dst.height, dst.crs
        b3857 = transform_bounds(out_crs, "EPSG:3857", *dst.bounds, densify_pts=21)
        bll = transform_bounds(out_crs, "EPSG:4326", *dst.bounds, densify_pts=21)
    # world-файлы и .prj (СК записана и внутри GeoTIFF; .aux.xml не пишем — он перекрыл бы её в GDAL/QGIS)
    wl = world_lines(out_tr)
    geo = out_crs.is_geographic
    txt = "".join((f"{v:.12f}\n" if geo else f"{v:.10f}\n") for v in wl)
    for ext in (".tfw", ".tfwx"):
        (out_dir / (stem + ext)).write_text(txt, encoding="ascii")
    wkt = esri_wkt(out_crs)
    (out_dir / (stem + ".prj")).write_text(wkt, encoding="utf-8")
    stale = out_dir / (stem + ".tif.aux.xml")
    if stale.is_file():
        stale.unlink()
    # просмотр (Web Mercator, прозрачный PNG ≤ 1600 px) — для показа на карте
    prev = out_dir / f"{stem}_preview.png"
    with rasterio.open(tmp) as src:
        k = max(1.0, max(win.width, win.height) / 1600.0)
        pw, ph = max(1, int(win.width / k)), max(1, int(win.height / k))
        data = src.read(window=win, out_shape=(4, ph, pw), resampling=Resampling.average)
        pb = rasterio.windows.bounds(win, src.transform)
    Image.fromarray(np.ascontiguousarray(data.transpose(1, 2, 0)), "RGBA").save(prev, optimize=True)
    try:
        tmp.unlink()
    except OSError:
        pass
    mid_lat = (bll[1] + bll[3]) / 2
    px_m = (2 * ORIGIN / (ts * 2 ** z)) * math.cos(math.radians(mid_lat))
    files = [n for n in (stem + e for e in (".tif", ".tfw", ".tfwx", ".prj", "_preview.png")) if (out_dir / n).is_file()]
    info = {
        "name": stem, "file": stem + ".tif", "source": path.name, "zoom": z, "zooms": [mb.zooms[0], mb.zooms[-1]],
        "tile_size": ts, "tiles": used, "format": mb.fmt or "png", "width": ow, "height": oh,
        "crs": (f"EPSG:{out_crs.to_epsg()}" if out_crs.to_epsg() else "custom"), "crs_name": crs_label(out_crs),
        "reprojected": not same, "pixel": [abs(out_tr.a), abs(out_tr.e)], "pixel_units": "°" if geo else "м",
        "pixel_m": round(px_m, 4), "compress": compress, "alpha": count == 4, "background": background,
        "bounds_lonlat": [round(v, 7) for v in bll], "bounds_3857": [round(v, 3) for v in b3857],
        "preview": prev.name, "preview_bounds_3857": [round(v, 3) for v in pb],
        "world_file": wl, "size_mb": round((out_dir / (stem + ".tif")).stat().st_size / 1048576, 2), "files": files,
        "title": mb.meta.get("name") or "",
    }
    if sx or sy:
        info["shift_applied_3857"] = [round(sx, 4), round(sy, 4)]
    log(f"-> {stem}.tif: {ow}×{oh} px, {info['crs_name']}, {info['size_mb']} МБ (+ .tfw, .tfwx, .prj)")
    return info


def main(argv=None, log=None):
    ap = argparse.ArgumentParser(description="MBTiles → GeoTIFF + TFW/TFWX + PRJ")
    ap.add_argument("inputs", nargs="+", help=".mbtiles (можно несколько)")
    ap.add_argument("-o", "--out", default=".", help="папка результатов")
    ap.add_argument("--zoom", default="max", help="max | auto | номер уровня")
    ap.add_argument("--crs", default="EPSG:3857", help="СК результата: EPSG:XXXX, PROJ или WKT")
    ap.add_argument("--compress", default="deflate", choices=("deflate", "lzw", "jpeg", "none"))
    ap.add_argument("--background", default="none", help="none (альфа-канал) | white | black | #RRGGBB")
    ap.add_argument("--clip", default="auto", choices=("auto", "bounds", "none"),
                    help="auto — обрезать пустые поля, bounds — по границам из метаданных, none — все тайлы целиком")
    ap.add_argument("--max-mp", type=float, default=float(os.environ.get("GEOREF_MB2TIF_MAX_MP", "400")))
    ap.add_argument("--resampling", default="cubic", choices=tuple(RESAMPLING))
    ap.add_argument("--no-overviews", action="store_true")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--name", help="[v20.7] имя результата без расширения (только для одного файла)")
    ap.add_argument("--shift", help="[v20.7] DX,DY — сдвиг результата, м EPSG:3857 (восток, север)")
    ap.add_argument("--result-json", help="[v20.7] записать сводку в файл JSON")
    a = ap.parse_args(argv)
    shift = None
    if a.shift:
        try:
            shift = tuple(float(v) for v in a.shift.replace(";", ",").split(","))
            assert len(shift) == 2 and all(math.isfinite(v) for v in shift)
        except (ValueError, AssertionError):
            raise SystemExit("--shift: два числа через запятую")
    res = []
    for p in a.inputs:
        res.append(convert(p, a.out, a.zoom, a.crs, a.compress, a.background, a.clip, a.max_mp, a.resampling,
                           not a.no_overviews, a.threads, name=a.name if len(a.inputs) == 1 else None, log_fn=log,
                           shift=shift))
    if a.result_json:
        tmp = Path(a.result_json + ".tmp")
        tmp.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
        os.replace(tmp, a.result_json)
    return res


if __name__ == "__main__":
    out = main()
    print(json.dumps(out, ensure_ascii=False, indent=1, default=float))
