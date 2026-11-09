# -*- coding: utf-8 -*-
"""[v20.7] Сдвиг растрового MBTiles целиком — «картинка» смещается на dx, dy метров EPSG:3857 (восток, север).

На каждом уровне zoom пиксели переносятся на round(d / размер пикселя уровня) — ошибка не больше половины
пикселя своего уровня; тайлы собираются заново (PNG/WebP — прозрачные края, JPEG — белые), пустые не пишутся,
уровни без сдвига (сдвиг меньше полупикселя) копируются как есть. bounds/center в метаданных сдвигаются.

  python mbtiles_shift.py tiles ИСХОДНЫЙ.mbtiles -o СДВИНУТЫЙ.mbtiles --shift DX,DY [--threads 8] [--result-json r.json]
  python mbtiles_shift.py delta ФАЙЛ.tif --shift DX,DY [--result-json r.json]
      сдвиг привязки GeoTIFF в его СК, равный сдвигу DX,DY на карте (центр растра) и оценка неточности
      в пикселях на углах (для перепроецированных файлов, нужен rasterio)
"""
import argparse
import io
import json
import math
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ORIGIN = 20037508.342789244
R = 6378137.0


def log(*a):
    print(" ".join(str(x) for x in a), flush=True)


def merc(lon, lat):
    lat = max(-85.05113, min(85.05113, float(lat)))
    return math.radians(float(lon)) * R, R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def unmerc(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def move_lonlat(lon, lat, dx, dy):
    x, y = merc(lon, lat)
    return unmerc(x + dx, y + dy)


def _sniff(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:2] in (b"\x1f\x8b", b"\x1a\x00") or data[:1] == b"\x1a":
        return "pbf"
    return ""


def shift_tiles(src, dst, dx, dy, threads=4, max_tiles=250000):
    """-> сводка. Пишет во временный файл рядом с dst, затем переименовывает."""
    from PIL import Image
    import numpy as np
    src, dst = Path(src), Path(dst)
    try:
        con = sqlite3.connect(src.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
        meta = {str(k): str(v) for k, v in con.execute("SELECT name, value FROM metadata")}
    except sqlite3.DatabaseError as e:
        raise SystemExit(f"{src.name}: не MBTiles или файл повреждён ({e})")
    xyz = (meta.get("scheme") or "tms").strip().lower() == "xyz"
    zooms = [int(z) for (z,) in con.execute("SELECT DISTINCT zoom_level FROM tiles ORDER BY zoom_level")]
    if not zooms:
        raise SystemExit(f"{src.name}: в файле нет тайлов")
    fmt = (meta.get("format") or "").strip().lower()
    if not fmt:
        row = con.execute("SELECT tile_data FROM tiles LIMIT 1").fetchone()
        fmt = _sniff(bytes(row[0] or b"")) if row else "png"
    fmt = {"jpeg": "jpg"}.get(fmt, fmt)
    if fmt in ("pbf", "mvt"):
        raise SystemExit(f"{src.name}: векторные MBTiles (pbf) не сдвигаются — нужен растровый (PNG/JPEG/WebP)")
    if fmt not in ("png", "jpg", "webp"):
        fmt = "png"

    def ts_of(z):
        for (d,) in con.execute("SELECT tile_data FROM tiles WHERE zoom_level=? LIMIT 8", (z,)):
            try:
                with Image.open(io.BytesIO(bytes(d))) as im:
                    return im.size[0]
            except Exception:
                continue
        return 256

    plan, heavy = [], 0
    for z in zooms:
        ts = ts_of(z)
        res = 2 * ORIGIN / (ts * 2 ** z)
        px, py = int(round(dx / res)), int(round(-dy / res))
        n = con.execute("SELECT COUNT(*) FROM tiles WHERE zoom_level=?", (z,)).fetchone()[0]
        plan.append((z, ts, px, py, n))
        if px or py:
            heavy += n
    if heavy > max_tiles:
        raise SystemExit(f"для сдвига нужно пересобрать {heavy} тайлов (> {max_tiles}) — слишком большой MBTiles; "
                         f"предел: GEOREF_SHIFT_MAX_TILES")
    part = dst.with_name(dst.name + ".part")
    for p in (part, Path(str(part) + "-journal")):
        if p.exists():
            p.unlink()
    out = sqlite3.connect(str(part))
    out.executescript(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA page_size=4096;"
        "CREATE TABLE metadata (name TEXT, value TEXT);"
        "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);")
    white = fmt == "jpg"
    t0 = time.time()
    total = sum(p[4] for p in plan)
    done = written = 0
    shifts = {}

    def flip(z, r):
        return r if xyz else (2 ** z - 1) - r

    def encode(arr):
        a = arr[:, :, 3]
        if not a.any():
            return None
        if white:
            rgb = arr[:, :, :3].astype(np.float32)
            al = a[:, :, None].astype(np.float32) / 255.0
            rgb = rgb * al + 255.0 * (1.0 - al)
            im = Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), "RGB")
            b = io.BytesIO()
            im.save(b, "JPEG", quality=92, optimize=False)
            return b.getvalue()
        im = Image.fromarray(arr, "RGBA") if (a < 255).any() else Image.fromarray(np.ascontiguousarray(arr[:, :, :3]), "RGB")
        b = io.BytesIO()
        if fmt == "webp":
            im.save(b, "WEBP", quality=90, method=4)
        else:
            im.save(b, "PNG", compress_level=6)
        return b.getvalue()

    def decode(data, ts):
        try:
            with Image.open(io.BytesIO(data)) as im:
                im = im.convert("RGBA")
                if im.size != (ts, ts):
                    im = im.resize((ts, ts), Image.BILINEAR)
                return np.asarray(im)
        except Exception:
            return None

    with ThreadPoolExecutor(max(1, int(threads))) as ex:
        for z, ts, px, py, n in plan:
            shifts[z] = [px, py]
            if not px and not py:                      # сдвиг меньше полупикселя уровня — копия
                cur = con.execute("SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=?", (z,))
                while True:
                    rows = cur.fetchmany(512)
                    if not rows:
                        break
                    out.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(z, int(c), int(r), d) for c, r, d in rows if d])
                    written += len(rows)
                    done += len(rows)
                log(f"z{z}: сдвиг 0 px — {n} тайлов скопировано; тайлы: {done}/{total}")
                continue
            idx = {}
            for c, r in con.execute("SELECT tile_column, tile_row FROM tiles WHERE zoom_level=?", (z,)):
                idx.setdefault(flip(z, int(r)), set()).add(int(c))
            lim = 2 ** z
            dest = {}
            for sy, cols in idx.items():
                ry = [(sy * ts + py) // ts, (sy * ts + py + ts - 1) // ts]
                for sx in cols:
                    rx = [(sx * ts + px) // ts, (sx * ts + px + ts - 1) // ts]
                    for Y in range(ry[0], ry[1] + 1):
                        if 0 <= Y < lim:
                            s = dest.setdefault(Y, set())
                            for X in range(rx[0], rx[1] + 1):
                                if 0 <= X < lim:
                                    s.add(X)
            raw, dec = {}, {}                            # сжатые тайлы двух рядов источника; раскодированные — по кускам

            def src_row(sy):
                if sy not in raw:
                    raw[sy] = {}
                    if sy in idx:
                        for c, b in con.execute("SELECT tile_column, tile_data FROM tiles WHERE zoom_level=? AND tile_row=?",
                                                (z, flip(z, sy))):
                            if b:
                                raw[sy][int(c)] = bytes(b)
                return raw[sy]

            def compose(X, Y, sys_):
                canvas = np.zeros((ts, ts, 4), np.uint8)
                hit = False
                for sy in sys_:
                    oy = sy * ts + py - Y * ts
                    for sx in sorted({(X * ts - px) // ts, (X * ts - px + ts - 1) // ts}):
                        arr = dec.get((sy, sx))
                        if arr is None:
                            continue
                        ox = sx * ts + px - X * ts
                        y0, y1, x0, x1 = max(0, oy), min(ts, oy + ts), max(0, ox), min(ts, ox + ts)
                        if y1 <= y0 or x1 <= x0:
                            continue
                        canvas[y0:y1, x0:x1] = arr[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
                        hit = True
                return encode(canvas) if hit else None

            step, nd, last = 96, sum(len(v) for v in dest.values()), time.time()
            k = 0
            for Y in sorted(dest):
                sys_ = sorted({(Y * ts - py) // ts, (Y * ts - py + ts - 1) // ts})
                rows = {sy: src_row(sy) for sy in sys_}
                Xs = sorted(dest[Y])
                for c0 in range(0, len(Xs), step):
                    part_x = Xs[c0:c0 + step]
                    need = set()
                    for X in part_x:
                        for sx in ((X * ts - px) // ts, (X * ts - px + ts - 1) // ts):
                            for sy in sys_:
                                if sx in rows[sy] and (sy, sx) not in dec:
                                    need.add((sy, sx))
                    need = sorted(need)
                    for key, arr in zip(need, ex.map(lambda q: decode(rows[q[0]][q[1]], ts), need)):
                        dec[key] = arr
                    blobs = list(ex.map(lambda X: compose(X, Y, sys_), part_x))
                    ins = [(z, X, flip(z, Y), sqlite3.Binary(b)) for X, b in zip(part_x, blobs) if b]
                    if ins:
                        out.executemany("INSERT INTO tiles VALUES (?,?,?,?)", ins)
                        written += len(ins)
                    lo = (part_x[-1] * ts - px) // ts            # раскодированные левее куска больше не нужны
                    for q in [q for q in dec if q[1] < lo or q[0] < sys_[0]]:
                        del dec[q]
                    k += len(part_x)
                    if time.time() - last > 2:
                        last = time.time()
                        log(f"z{z}: собрано {k}/{nd} тайлов")
                for q in [q for q in raw if q < sys_[-1]]:
                    del raw[q]
                for q in [q for q in dec if q[0] < sys_[-1]]:
                    del dec[q]
            done = sum(p[4] for p in plan if p[0] <= z)
            log(f"z{z}: сдвиг {px:+d}, {-py:+d} px (восток, север); тайлы: {done}/{total}")
    # метаданные: как в исходнике, bounds/center — со сдвигом
    m2 = dict(meta)
    try:
        b = [float(v) for v in meta.get("bounds", "").split(",")]
        if len(b) == 4:
            lo0, la0 = move_lonlat(b[0], b[1], dx, dy)
            lo1, la1 = move_lonlat(b[2], b[3], dx, dy)
            m2["bounds"] = f"{lo0:.8f},{la0:.8f},{lo1:.8f},{la1:.8f}"
    except ValueError:
        pass
    try:
        c = [float(v) for v in meta.get("center", "").split(",")]
        if len(c) >= 2:
            lo, la = move_lonlat(c[0], c[1], dx, dy)
            m2["center"] = ",".join([f"{lo:.8f}", f"{la:.8f}"] + [f"{v:g}" for v in c[2:]])
    except ValueError:
        pass
    m2["format"] = meta.get("format") or fmt
    m2["georef_shift_3857"] = f"{dx:.4f},{dy:.4f}"
    out.executemany("INSERT INTO metadata VALUES (?,?)", list(m2.items()))
    out.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
    out.execute("CREATE UNIQUE INDEX name ON metadata (name)")
    out.commit()
    out.close()
    con.close()
    os.replace(part, dst)
    bl = None
    if "bounds" in m2:
        try:
            bl = [round(float(v), 7) for v in m2["bounds"].split(",")]
        except ValueError:
            bl = None
    info = {"file": dst.name, "path": str(dst), "tiles": written, "zooms": [zooms[0], zooms[-1]], "format": fmt,
            "shift_px": shifts, "bounds_lonlat": bl, "size_mb": round(dst.stat().st_size / 1048576, 2),
            "shift_3857": [round(dx, 4), round(dy, 4)], "seconds": round(time.time() - t0, 1)}
    log(f"-> {dst.name}: {written} тайлов, z{zooms[0]}–{zooms[-1]}, {info['size_mb']} МБ, {info['seconds']} с")
    return info


def tif_delta(tif, dx, dy):
    """сдвиг привязки GeoTIFF в его СК для сдвига dx, dy (EPSG:3857) и неточность на углах, пикс."""
    import rasterio
    from rasterio.warp import transform
    with rasterio.open(tif) as ds:
        crs, b, tr = ds.crs, ds.bounds, ds.transform
    if crs is None:
        raise SystemExit(f"{Path(tif).name}: в файле нет СК")
    xs = [b.left, b.right, b.left, b.right, (b.left + b.right) / 2]
    ys = [b.top, b.top, b.bottom, b.bottom, (b.top + b.bottom) / 2]
    mx, my = transform(crs, "EPSG:3857", xs, ys)
    bx, by = transform("EPSG:3857", crs, [v + dx for v in mx], [v + dy for v in my])
    ddx = [bx[i] - xs[i] for i in range(5)]
    ddy = [by[i] - ys[i] for i in range(5)]
    pa, pe = abs(tr.a) or 1.0, abs(tr.e) or 1.0
    err = max(max(abs(ddx[i] - ddx[4]) for i in range(4)) / pa, max(abs(ddy[i] - ddy[4]) for i in range(4)) / pe)
    return {"delta": [ddx[4], ddy[4]], "err_px": err, "geographic": bool(crs.is_geographic),
            "pixel": [pa, pe], "crs": crs.to_string()[:200]}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(description="Сдвиг MBTiles / привязки GeoTIFF на dx, dy (м EPSG:3857)")
    ap.add_argument("cmd", choices=("tiles", "delta"))
    ap.add_argument("src")
    ap.add_argument("-o", "--out", help="tiles: путь результата .mbtiles")
    ap.add_argument("--shift", required=True, help="DX,DY — м EPSG:3857, восток/север")
    ap.add_argument("--threads", type=int, default=int(os.environ.get("GEOREF_THREADS", "4")))
    ap.add_argument("--max-tiles", type=int, default=int(os.environ.get("GEOREF_SHIFT_MAX_TILES", "250000")))
    ap.add_argument("--result-json")
    a = ap.parse_args(argv)
    try:
        dx, dy = (float(v) for v in a.shift.replace(";", ",").split(","))
    except ValueError:
        raise SystemExit("--shift: два числа через запятую")
    if not all(math.isfinite(v) for v in (dx, dy)):
        raise SystemExit("--shift: некорректные числа")
    if a.cmd == "tiles":
        if not a.out:
            raise SystemExit("tiles: нужен -o СДВИНУТЫЙ.mbtiles")
        res = shift_tiles(a.src, a.out, dx, dy, a.threads, a.max_tiles)
    else:
        res = tif_delta(a.src, dx, dy)
    if a.result_json:
        tmp = Path(a.result_json + ".tmp")
        tmp.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
        os.replace(tmp, a.result_json)
    else:
        print(json.dumps(res, ensure_ascii=False, default=float))
    return res


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0) and not isinstance(e.code, int):
            print("ВНИМАНИЕ: " + str(e.code), flush=True)
            sys.exit(2)
        raise
