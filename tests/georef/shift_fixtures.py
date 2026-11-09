# -*- coding: utf-8 -*-
"""[v20.3] Тестовые данные: лист плана (как пишет georef_plans.py), растры «Пар-2-73…» без СК, готовое задание привязки.
Используют test_georef_shift.py и ui_server.py (/seed_georef)."""
import hashlib
import json
import math
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import transform as wt

R = 6378137.0
SHEET = 'пер. Стахановский (оз)'
SHEET_LL = (53.88350, 27.54800)                  # центр листа, lat/lon (Минск)
PAR = 'Пар-2-73_ул. Грицевца озеленение'
PAR_LL = (53.88000, 27.53000)
GK5 = CRS.from_epsg(28405)
UTM35 = CRS.from_epsg(32635)
ESRI_3857 = CRS.from_epsg(3857).to_wkt(version='WKT1_ESRI')


def merc(lat, lon):
    return math.radians(lon) * R, R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def unmerc(x, y):
    return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), math.degrees(x / R)


def plan_image(w, h):
    """«лист плана»: бумага, сетка, красный прямоугольник (метка для проверки сдвига), синий крест, рамка"""
    img = np.full((3, h, w), 247, np.uint8)
    for k in range(0, w, 80):
        img[:, :, k:k + 2] = 30
    for k in range(0, h, 80):
        img[:, k:k + 2, :] = 30
    y0, x0 = h * 3 // 8, w * 3 // 8
    img[:, y0:y0 + h // 4, x0:x0 + w // 4] = np.array([210, 25, 25], np.uint8)[:, None, None]
    img[:, h // 2 - 3:h // 2 + 3, w // 8:w * 7 // 8] = np.array([20, 40, 200], np.uint8)[:, None, None]
    img[:, h // 8:h * 7 // 8, w // 2 - 3:w // 2 + 3] = np.array([20, 40, 200], np.uint8)[:, None, None]
    img[:, :6, :] = img[:, -6:, :] = 0
    img[:, :, :6] = img[:, :, -6:] = 0
    return img


def write_world(path, T):
    """A D B E C F, C/F — центр левого верхнего пикселя"""
    c0, f0 = T.c + 0.5 * T.a + 0.5 * T.b, T.f + 0.5 * T.d + 0.5 * T.e
    Path(path).write_text(''.join(f'{v:.10f}\n' for v in (T.a, T.d, T.b, T.e, c0, f0)), encoding='utf-8')


def write_sheet(out, name=SHEET, lat=SHEET_LL[0], lon=SHEET_LL[1], w=1600, h=1200, px=0.063, rot=-0.79):
    """GeoTIFF EPSG:3857 с поворотом (ModelTransformation) + внешний .ovr + .tfwx/.tfw + .prj + .tif.aux.xml — как export_sheet"""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    x0, y0 = merc(lat, lon)
    a = math.radians(rot)
    A, B, D, E = px * math.cos(a), -px * math.sin(a), -px * math.sin(a), -px * math.cos(a)
    T = Affine(A, B, x0 - A * w / 2 - B * h / 2, D, E, y0 - D * w / 2 - E * h / 2)
    tif = out / f'{name}.tif'
    with rasterio.open(tif, 'w', driver='GTiff', width=w, height=h, count=3, dtype='uint8', crs='EPSG:3857', transform=T,
                       photometric='RGB', compress='LZW', predictor=2, tiled=True, blockxsize=256, blockysize=256,
                       interleave='pixel') as dst:
        dst.write(plan_image(w, h))
    with rasterio.Env(TIFF_USE_OVR='YES', COMPRESS_OVERVIEW='LZW'):
        with rasterio.open(tif, 'r+') as src:
            src.build_overviews([2, 4, 8], Resampling.average)
    write_world(out / f'{name}.tfwx', T)
    write_world(out / f'{name}.tfw', T)
    (out / f'{name}.prj').write_text(ESRI_3857, encoding='utf-8')
    (out / f'{name}.tif.aux.xml').write_text('<PAMDataset>\n  <SRS dataAxisToSRSAxisMapping="1,2">' + ESRI_3857 +
                                             '</SRS>\n</PAMDataset>\n', encoding='utf-8')
    corners = [list(unmerc(*(T * (c, r)))) for c, r in ((0, 0), (w, 0), (w, h), (0, h))]
    return {'T': T, 'corners_latlon': corners, 'center_latlon': [lat, lon], 'size': [w, h],
            'world_file': [T.a, T.d, T.b, T.e, T.c + 0.5 * T.a + 0.5 * T.b, T.f + 0.5 * T.d + 0.5 * T.e]}


def write_par(d, crs=GK5, name=PAR, lat=PAR_LL[0], lon=PAR_LL[1], w=800, h=600, px=0.1, with_crs=False):
    """скан «Пар-2-73…»: .tif + .tfw в СК-42 / ГК (по умолчанию — без описания СК, как у заказчика)"""
    d = Path(d)
    d.mkdir(parents=True, exist_ok=True)
    x, y = wt('EPSG:4326', crs, [lon], [lat])
    T = Affine(px, 0, x[0] - px * w / 2, 0, -px, y[0] + px * h / 2)
    kw = dict(driver='GTiff', width=w, height=h, count=3, dtype='uint8')
    if with_crs:
        kw.update(crs=crs, transform=T)
    p = d / f'{name}.tif'
    with rasterio.open(p, 'w', **kw) as ds:
        ds.write(plan_image(w, h))
    write_world(d / f'{name}.tfw', T)
    return [p, d / f'{name}.tfw']


def owner_of(tok):
    return hashlib.sha256(('georef:' + tok).encode()).hexdigest()[:24]


def run_t2m(tools, inputs, out, opts, python=None):
    rj = Path(out) / f'.t2m_{uuid.uuid4().hex[:6]}.json'
    av = [python or sys.executable, str(Path(tools) / 'tif2mbtiles.py'), *map(str, inputs), '-o', str(out), *opts,
          '--result-json', str(rj)]
    p = subprocess.run(av, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if p.returncode != 0 or not rj.is_file():
        raise RuntimeError('tif2mbtiles: ' + p.stdout.decode('utf-8', 'replace')[-1500:])
    r = json.loads(rj.read_text(encoding='utf-8'))
    rj.unlink()
    return r


def seed_georef_job(root, tok, tools, minzoom=16, maxzoom=20, registered=True, title='План_Стахановский.pdf'):
    """готовое задание «План → GeoTIFF/TFW → MBTiles» (один привязанный лист) владельца tok -> jid"""
    jid = uuid.uuid4().hex[:16]
    jd = Path(root) / 'jobs' / jid
    out = jd / 'out'
    (jd / 'in').mkdir(parents=True)
    (jd / 'in' / title).write_bytes(b'%PDF-1.4 stub\n')
    sh = write_sheet(out)
    params = {'georef': {'center': list(SHEET_LL), 'radius': 300, 'scale': 500},
              'mbtiles': {'enabled': True, 'format': 'png', 'paper': 'auto', 'background': 'auto',
                          'minzoom': minzoom, 'maxzoom': maxzoom}}
    r = run_t2m(tools, [out / f'{SHEET}.tif'], out, ['--format', 'png', '--paper', 'auto', '--background', 'white',
                                                      '--minzoom', str(minzoom), '--maxzoom', str(maxzoom), '--threads', '4'])
    mb = {k: v for k, v in r[0].items() if k != 'path'}
    from PIL import Image
    Image.fromarray(plan_image(400, 300).transpose(1, 2, 0)).save(out / 'qa_overlay.jpg', quality=80)
    (out / 'report.txt').write_text(f'{SHEET}: -> {SHEET}.tif\n', encoding='utf-8')
    files = [n for n in (SHEET + e for e in ('.tif', '.tfw', '.tfwx', '.prj', '.tif.aux.xml', '.tif.ovr', '.mbtiles')) if (out / n).is_file()]
    sheet = {'name': SHEET, 'file': title, 'registered': True, 'size': [4961, 3508], 'dpi': 300, 'orientation_cw': 0,
             'out_size': sh['size'], 'model': 'similarity', 'm_per_px': [0.063, 0.063], 'rotation_deg': -0.79,
             'center_latlon': sh['center_latlon'], 'corners_latlon': sh['corners_latlon'], 'world_file': sh['world_file'],
             'mbtiles': mb['file'], 'plan_scale': 500, 'source': {'file': title, 'page': 1},
             'quality': 'good', 'quality_text': 'Совпадение линий 31%, RMS 0.12 м', 'files': files}
    res = {'kind': 'georef', 'ok': True, 'created': time.time(), 'center': list(SHEET_LL), 'crs': 'EPSG:3857',
           'sheets': [sheet], 'components': [], 'links': [], 'mbtiles': [mb], 'warnings': [], 'qa': 'qa_overlay.jpg',
           'elapsed_s': 61.0}
    (out / 'result.json').write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    (jd / 'params.json').write_text(json.dumps(params, ensure_ascii=False), encoding='utf-8')
    (jd / 'log.txt').write_text('seeded\n', encoding='utf-8')
    now = time.time()
    j = {'id': jid, 'kind': 'georef', 'title': title, 'created': now - 70, 'started': now - 65, 'finished': now - 3,
         'status': 'done', 'progress': 100, 'stage': 'Готово', 'stage_index': 5, 'params': params,
         'inputs': [{'name': title, 'size': 14}], 'input_bytes': 14, 'owner': owner_of(tok), 'ip': '127.0.0.1',
         'eta_s': None, 'result': res, 'warnings': [],
         'files': [{'name': p.name, 'label': p.name, 'size': p.stat().st_size} for p in sorted(out.iterdir()) if not p.name.startswith('.')]}
    if registered:
        j['registered'] = {mb['file']: {'id': 5, 'name': 'Стахановский', 'at': now - 2}}
    (jd / 'job.json').write_text(json.dumps(j, ensure_ascii=False, indent=1), encoding='utf-8')
    return jid

# ── [v20.7] MBTiles для «MBTiles → TIFF → Переместить» ──
import io as _io, sqlite3 as _sq
from PIL import Image as _Image
ORIGIN = 20037508.342789244
_R = 6378137.0
def write_mb(path, z0=15, z1=18, lon=27.56, lat=53.90, n=3, fmt='png', scheme='tms'):
    """[v20.7] растровый MBTiles для «MBTiles → TIFF» (UI-стенд /mb_fixture): n×n тайлов узора на z1, на младших уровнях — уменьшенные копии; прозрачный угол"""
    con = _sq.connect(str(path))
    con.executescript("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);")
    x = math.radians(lon) * _R; y = _R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    span1 = 2 * ORIGIN / 2 ** z1
    tx0, ty0 = int((x + ORIGIN) // span1), int((ORIGIN - y) // span1)
    Wd = n * 256
    yy, xx = np.mgrid[0:Wd, 0:Wd]
    img = np.zeros((Wd, Wd, 4), np.uint8)
    img[..., 0] = (xx * 7) % 256; img[..., 1] = (yy * 5) % 256; img[..., 2] = ((xx // 16 + yy // 16) % 2) * 200 + 30
    img[..., 3] = 255
    img[:40, :60, 3] = 0
    for z in range(z0, z1 + 1):
        f = 2 ** (z1 - z)
        gx0, gy0 = tx0 * 256 // f, ty0 * 256 // f
        small = np.asarray(_Image.fromarray(img, 'RGBA').resize((max(1, Wd // f),) * 2, _Image.BILINEAR)) if f > 1 else img
        h = small.shape[0]
        for ty in range(gy0 // 256, (gy0 + h - 1) // 256 + 1):
            for tx in range(gx0 // 256, (gx0 + h - 1) // 256 + 1):
                t = np.zeros((256, 256, 4), np.uint8)
                ox, oy = tx * 256 - gx0, ty * 256 - gy0
                a0, b0, a1, b1 = max(0, ox), max(0, oy), min(h, ox + 256), min(h, oy + 256)
                if a1 > a0 and b1 > b0:
                    t[b0 - oy:b1 - oy, a0 - ox:a1 - ox] = small[b0:b1, a0:a1]
                if not t[..., 3].any():
                    continue
                b = _io.BytesIO()
                if fmt == 'jpg':
                    _Image.fromarray(t[..., :3], 'RGB').save(b, 'JPEG', quality=95)
                else:
                    _Image.fromarray(t, 'RGBA').save(b, 'PNG')
                con.execute("INSERT INTO tiles VALUES (?,?,?,?)", (z, tx, ty if scheme == 'xyz' else 2 ** z - 1 - ty, b.getvalue()))
    lon0 = math.degrees((tx0 * span1 - ORIGIN) / _R); lon1 = math.degrees(((tx0 + n) * span1 - ORIGIN) / _R)
    yl = lambda v: math.degrees(2 * math.atan(math.exp(v / _R)) - math.pi / 2)
    lat1, lat0 = yl(ORIGIN - ty0 * span1), yl(ORIGIN - (ty0 + n) * span1)
    meta = {'name': 'тест', 'format': fmt, 'bounds': f'{lon0},{lat0},{lon1},{lat1}', 'center': f'{(lon0 + lon1) / 2},{(lat0 + lat1) / 2},{z1}',
            'minzoom': str(z0), 'maxzoom': str(z1), 'type': 'overlay'}
    if scheme == 'xyz':
        meta['scheme'] = 'xyz'
    con.executemany("INSERT INTO metadata VALUES (?,?)", list(meta.items()))
    con.commit(); con.close()
    return Path(path)
