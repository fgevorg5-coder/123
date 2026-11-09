#!/usr/bin/env python
"""Синтетические данные для стенда: шейп-файл лесхозов и MBTiles.

Идемпотентно: повторный запуск перезаписывает те же файлы.
Пример: python tests/load/make_fixtures.py --dest geoservice/
"""
import argparse
import io
import math
import os
import random
import sqlite3

import geopandas as gpd
from PIL import Image, ImageDraw
from shapely.geometry import Polygon

BOUNDS = (26.0, 53.0, 29.0, 54.8)  # lon_min, lat_min, lon_max, lat_max
NAMES = ["Минский", "Борисовский", "Молодечненский", "Смолевичский", "Червенский", "Логойский",
         "Вилейский", "Воложинский", "Стародорожский", "Слуцкий", "Столбцовский", "Узденский",
         "Дзержинский", "Крупский", "Березинский", "Клецкий", "Копыльский", "Несвижский",
         "Любанский", "Пуховичский"]


def make_shp(dest):
    rng = random.Random(42)
    cols, rows = 5, 4
    lon0, lat0, lon1, lat1 = BOUNDS
    dx, dy = (lon1 - lon0) / cols, (lat1 - lat0) / rows
    # общие узлы сетки с шумом, чтобы соседние полигоны стыковались
    grid = {}
    for i in range(cols + 1):
        for j in range(rows + 1):
            jx = rng.uniform(-.1, .1) * dx if 0 < i < cols else 0
            jy = rng.uniform(-.1, .1) * dy if 0 < j < rows else 0
            grid[(i, j)] = (lon0 + i * dx + jx, lat0 + j * dy + jy)
    geoms, codes, names = [], [], []
    for n in range(cols * rows):
        i, j = n % cols, n // cols
        geoms.append(Polygon([grid[(i, j)], grid[(i + 1, j)], grid[(i + 1, j + 1)], grid[(i, j + 1)]]))
        codes.append(f"{n + 1:02d}")
        names.append(NAMES[n])
    gdf = gpd.GeoDataFrame({"code": codes, "name": names}, geometry=geoms, crs="EPSG:4326")
    d = os.path.join(dest, "shp_leshoz")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "leshoz.shp")
    gdf.to_file(path, driver="ESRI Shapefile", encoding="utf-8")
    return path


def tile_range(z):
    n = 2 ** z
    lon0, lat0, lon1, lat1 = BOUNDS

    def xy(lat, lon):
        return (int((lon + 180) / 360 * n),
                int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))
    x0, y1 = xy(lat0, lon0)
    x1, y0 = xy(lat1, lon1)
    return x0, x1, y0, y1


def tile_png(z, x, y):
    h = (z * 73856093) ^ (x * 19349663) ^ (y * 83492791)
    img = Image.new("RGB", (256, 256), (80 + h % 120, 80 + (h >> 8) % 120, 80 + (h >> 16) % 120))
    dr = ImageDraw.Draw(img)
    for k in range(0, 256, 64):
        dr.line([(k, 0), (k, 255)], fill=(255, 255, 255))
        dr.line([(0, k), (255, k)], fill=(255, 255, 255))
    dr.text((8, 8), f"{z}/{x}/{y}", fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_mbtiles(dest, minz=6, maxz=10):
    d = os.path.join(dest, "uploads", "mbtiles")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "stand.mbtiles")
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    conn.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    conn.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
    meta = {"name": "Стенд MBTiles", "format": "png", "type": "baselayer", "version": "1",
            "bounds": ",".join(str(v) for v in BOUNDS), "minzoom": str(minz), "maxzoom": str(maxz)}
    conn.executemany("INSERT INTO metadata VALUES (?,?)", meta.items())
    cnt = 0
    for z in range(minz, maxz + 1):
        x0, x1, y0, y1 = tile_range(z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                # MBTiles хранит строки в схеме TMS
                conn.execute("INSERT INTO tiles VALUES (?,?,?,?)", (z, x, (2 ** z - 1) - y, tile_png(z, x, y)))
                cnt += 1
    conn.commit()
    conn.close()
    return path, cnt


def register(url, path, headers):
    import httpx
    with open(path, "rb") as f:
        r = httpx.post(url.rstrip("/") + "/api/mbtiles/upload", headers=headers, timeout=60,
                       files={"file": ("stand.mbtiles", f, "application/octet-stream")},
                       data={"name": "Стенд MBTiles"})
    print(f"POST /api/mbtiles/upload -> {r.status_code}: {r.text[:300]}")


def main():
    p = argparse.ArgumentParser(description="Генератор тестовых данных стенда")
    p.add_argument("--dest", default="geoservice/")
    p.add_argument("--register-url", help="адрес сервиса: загрузить mbtiles через /api/mbtiles/upload (нужна роль admin)")
    p.add_argument("--header", action="append", default=[], help="'Cookie: ...' для --register-url")
    a = p.parse_args()
    shp = make_shp(a.dest)
    mbt, cnt = make_mbtiles(a.dest)
    print(f"шейп-файл: {shp}\nmbtiles:   {mbt} ({cnt} тайлов)")
    print("Сервис читает mbtiles из maps_storage/MBTILES_MINSK/ по строке таблицы mbtiles_layers,\n"
          "поэтому для регистрации используйте --register-url (POST /api/mbtiles/upload, роль admin).")
    if a.register_url:
        hdrs = {}
        for h in a.header:
            k, _, v = h.partition(":")
            hdrs[k.strip()] = v.strip()
        register(a.register_url, mbt, hdrs)


if __name__ == "__main__":
    main()
