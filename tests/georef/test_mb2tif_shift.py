# -*- coding: utf-8 -*-
"""[v20.7] «Переместить» во вкладке «MBTiles → TIFF» и сохранение сдвига растров «Смены СК»:
  1) tools/georef/mbtiles_shift.py tiles — сдвиг MBTiles целиком: пиксель в пиксель (PNG TMS/XYZ), JPEG, метаданные;
  2) mbtiles2tif.py --shift — привязка результата сдвинута точно;
  3) POST /api/georef/jobs/{id}/shift для «MBTiles → TIFF» (TestClient, настоящий georef_api + раннер):
     EPSG:3857 — на месте, точно; EPSG:4326 — сдвиг в СК файла / сборка заново; «Исходная привязка»; MBTiles в ZIP;
  4) /api/crs-shift/raster/… — хранение ZIP со сдвинутым растром (владелец по cookie, проверки, удаление),
     не пересекается с маршрутами crs_shift.py, подключёнными раньше.
Запуск: python tests/georef/test_mb2tif_shift.py   (нужны rasterio, numpy, pillow, fastapi, httpx, python-multipart)"""
import hashlib, io, json, math, os, shutil, sqlite3, subprocess, sys, time, zipfile
from pathlib import Path
HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.environ.get('GEO_DIR') or os.path.join(HERE, '..', '..', 'geoservice')
WORK = os.environ.get('WORK_DIR') or os.path.join(HERE, '..', '_work')
TOOLS = os.path.join(GEO, 'tools', 'georef')
sys.path[:0] = [GEO, HERE, TOOLS]
W = Path(WORK) / 'mb2tif_shift'
shutil.rmtree(W, ignore_errors=True)
W.mkdir(parents=True)
os.environ['GEOREF_WORKDIR'] = str(W / 'srv')
os.environ['GEOREF_TOOLS_DIR'] = TOOLS
os.environ.setdefault('GEOREF_THREADS', '4')
import numpy as np, rasterio
from PIL import Image
ORIGIN = 20037508.342789244
R = 6378137.0

FAIL, N = [], [0]
def check(name, cond, info=''):
    N[0] += 1
    print(('OK   ' if cond else 'FAIL ') + name + (('  ' + str(info)) if info != '' else ''), flush=True)
    if not cond:
        FAIL.append(name)
def close(a, b, tol=1e-6): return all(abs(x - y) <= tol for x, y in zip(a, b))
def tr(p):
    with rasterio.open(p) as ds:
        return ds.transform
def bounds(p):
    with rasterio.open(p) as ds:
        return list(ds.bounds)
def pix(p):
    with rasterio.open(p) as ds:
        return hashlib.md5(ds.read().tobytes()).hexdigest()
def world(p): return [float(v.replace(',', '.')) for v in Path(p).read_text(encoding='utf-8').split()]


def make_mb(path, z0=15, z1=18, lon=27.56, lat=53.90, n=3, fmt='png', scheme='tms'):
    """MBTiles: n×n тайлов узора на z1, на младших уровнях — уменьшенные копии; прозрачный угол"""
    con = sqlite3.connect(str(path))
    con.executescript("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);")
    x = math.radians(lon) * R; y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
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
        small = np.asarray(Image.fromarray(img, 'RGBA').resize((max(1, Wd // f),) * 2, Image.BILINEAR)) if f > 1 else img
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
                b = io.BytesIO()
                if fmt == 'jpg':
                    Image.fromarray(t[..., :3], 'RGB').save(b, 'JPEG', quality=95)
                else:
                    Image.fromarray(t, 'RGBA').save(b, 'PNG')
                con.execute("INSERT INTO tiles VALUES (?,?,?,?)", (z, tx, ty if scheme == 'xyz' else 2 ** z - 1 - ty, b.getvalue()))
    lon0 = math.degrees((tx0 * span1 - ORIGIN) / R); lon1 = math.degrees(((tx0 + n) * span1 - ORIGIN) / R)
    yl = lambda v: math.degrees(2 * math.atan(math.exp(v / R)) - math.pi / 2)
    lat1, lat0 = yl(ORIGIN - ty0 * span1), yl(ORIGIN - (ty0 + n) * span1)
    meta = {'name': 'тест', 'format': fmt, 'bounds': f'{lon0},{lat0},{lon1},{lat1}', 'center': f'{(lon0 + lon1) / 2},{(lat0 + lat1) / 2},{z1}',
            'minzoom': str(z0), 'maxzoom': str(z1), 'type': 'overlay'}
    if scheme == 'xyz':
        meta['scheme'] = 'xyz'
    con.executemany("INSERT INTO metadata VALUES (?,?)", list(meta.items()))
    con.commit(); con.close()


def mosaic(path, z):
    con = sqlite3.connect(str(path))
    xyz = (dict(con.execute('select name, value from metadata')).get('scheme') or 'tms') == 'xyz'
    t = [(c, r if xyz else 2 ** z - 1 - r, d) for c, r, d in con.execute("SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=?", (z,))]
    con.close()
    x0, y0 = min(a[0] for a in t), min(a[1] for a in t)
    M = np.zeros(((max(a[1] for a in t) - y0 + 1) * 256, (max(a[0] for a in t) - x0 + 1) * 256, 4), np.uint8)
    for c, r, d in t:
        M[(r - y0) * 256:(r - y0 + 1) * 256, (c - x0) * 256:(c - x0 + 1) * 256] = np.asarray(Image.open(io.BytesIO(d)).convert('RGBA'))
    return x0, y0, M


def same_shifted(src, dst, z, px, py, exact=True):
    """каждый непрозрачный пиксель исходника — в dst со сдвигом (px, py) пикс.; лишних нет"""
    sx0, sy0, S = mosaic(src, z); dx0, dy0, D = mosaic(dst, z)
    ys, xs = np.nonzero(S[..., 3] > 0)
    gy, gx = ys + (sy0 - dy0) * 256 + py, xs + (sx0 - dx0) * 256 + px
    if gy.min() < 0 or gx.min() < 0 or gy.max() >= D.shape[0] or gx.max() >= D.shape[1]:
        return False
    if exact:
        return bool((D[gy, gx] == S[ys, xs]).all()) and int((D[..., 3] > 0).sum()) == len(ys)
    return float(np.abs(D[gy, gx][:, :3].astype(int) - S[ys, xs][:, :3].astype(int)).mean()) < 12


TOOL = os.path.join(TOOLS, 'mbtiles_shift.py')
# ═════════════ 1. mbtiles_shift.py tiles ═════════════
res18 = 2 * ORIGIN / (256 * 2 ** 18)
for fmt, scheme in (('png', 'tms'), ('png', 'xyz'), ('jpg', 'tms')):
    src, dst = W / f's_{fmt}_{scheme}.mbtiles', W / f'd_{fmt}_{scheme}.mbtiles'
    make_mb(src, fmt=fmt, scheme=scheme)
    dx, dy = 37.4 * res18, -21.6 * res18
    r = subprocess.run([sys.executable, TOOL, 'tiles', str(src), '-o', str(dst), '--shift', f'{dx},{dy}', '--threads', '4',
                        '--result-json', str(dst) + '.json'], capture_output=True, text=True)
    info = json.loads(Path(str(dst) + '.json').read_text(encoding='utf-8')) if r.returncode == 0 else {}
    okz = []
    for z in (18, 17, 16, 15):
        rz = 2 * ORIGIN / (256 * 2 ** z)
        px, py = int(round(dx / rz)), int(round(-dy / rz))
        okz.append(info.get('shift_px', {}).get(str(z)) == [px, py] and same_shifted(src, dst, z, px, py, fmt == 'png'))
    check(f'mbtiles_shift {fmt.upper()} {scheme.upper()}: все уровни сдвинуты на round(d/пиксель)' + (' пиксель в пиксель' if fmt == 'png' else ' (JPEG — с пересжатием)'),
          r.returncode == 0 and all(okz), (r.returncode, okz, r.stdout[-300:]))
    con = sqlite3.connect(str(dst)); meta = dict(con.execute('select name, value from metadata')); con.close()
    con = sqlite3.connect(str(src)); meta0 = dict(con.execute('select name, value from metadata')); con.close()
    b0, b1 = [float(v) for v in meta0['bounds'].split(',')], [float(v) for v in meta['bounds'].split(',')]
    x0 = math.radians(b0[0]) * R; x1 = math.radians(b1[0]) * R
    check(f'  метаданные: bounds сдвинуты, схема {scheme} сохранена', abs(x1 - x0 - dx) < 0.01 and b1[1] < b0[1] and (meta.get('scheme') or 'tms') == scheme
          and meta.get('georef_shift_3857'), (round(x1 - x0 - dx, 4), meta.get('scheme')))
# нулевой сдвиг на младших уровнях — копия байт в байт
src = W / 's_png_tms.mbtiles'; dst = W / 'tiny.mbtiles'
subprocess.run([sys.executable, TOOL, 'tiles', str(src), '-o', str(dst), '--shift', f'{0.3 * res18},0', '--result-json', str(dst) + '.json'], check=True, capture_output=True)
c1, c2 = sqlite3.connect(str(src)), sqlite3.connect(str(dst))
q = "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY 1,2,3"
check('  сдвиг меньше полупикселя: тайлы скопированы байт в байт', c1.execute(q).fetchall() == c2.execute(q).fetchall())
c1.close(); c2.close()
# векторный MBTiles — понятная ошибка
vec = W / 'vec.mbtiles'
con = sqlite3.connect(str(vec)); con.executescript("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); INSERT INTO metadata VALUES ('format','pbf'); INSERT INTO tiles VALUES (1,0,0,x'1a00');"); con.commit(); con.close()
r = subprocess.run([sys.executable, TOOL, 'tiles', str(vec), '-o', str(W / 'v2.mbtiles'), '--shift', '1,1'], capture_output=True, text=True)
check('  векторный MBTiles: отказ с понятным текстом', r.returncode != 0 and 'векторные' in (r.stdout + r.stderr), (r.returncode, (r.stdout + r.stderr)[-200:]))

# ═════════════ 2. mbtiles2tif --shift ═════════════
import mbtiles2tif as m2t
o0 = m2t.convert(W / 's_png_tms.mbtiles', W / 'm0', name='a')
o1 = m2t.convert(W / 's_png_tms.mbtiles', W / 'm1', name='a', shift=(12.5, -7.25))
T0, T1 = tr(W / 'm0' / 'a.tif'), tr(W / 'm1' / 'a.tif')
check('mbtiles2tif --shift (EPSG:3857): привязка сдвинута точно, пиксели те же', close((T1.c - T0.c, T1.f - T0.f), (12.5, -7.25), 1e-6)
      and pix(W / 'm0' / 'a.tif') == pix(W / 'm1' / 'a.tif') and o1.get('shift_applied_3857') == [12.5, -7.25], (T1.c - T0.c, T1.f - T0.f))
check('  .tfw и preview_bounds_3857 сдвинуты', close(world(W / 'm1' / 'a.tfw')[4:], [world(W / 'm0' / 'a.tfw')[4] + 12.5, world(W / 'm0' / 'a.tfw')[5] - 7.25], 1e-4)
      and close(o1['preview_bounds_3857'], [o0['preview_bounds_3857'][0] + 12.5, o0['preview_bounds_3857'][1] - 7.25, o0['preview_bounds_3857'][2] + 12.5, o0['preview_bounds_3857'][3] - 7.25], 2e-3))

# ═════════════ 3. API «MBTiles → TIFF» ═════════════
from fastapi import FastAPI, APIRouter, Request
from fastapi.testclient import TestClient
import georef_api as ga
os.makedirs(W / 'srv' / 'cache', exist_ok=True)
user = APIRouter(prefix='/api/crs-shift')               # как crs_shift.py: подключён раньше georef_api
@user.post('/{jid}/{idx}')
def u_post(jid: str, idx: int): return {'user': True}
@user.get('/{jid}')
def u_list(jid: str): return {'items': {}, 'user': True}
@user.get('/{jid}/{idx}/zip')
def u_zip(jid: str, idx: int): return {'user': True}
@user.delete('/{jid}/{idx}')
def u_del(jid: str, idx: int): return {'user': True}
CSRF = []
def verify_csrf(req: Request):
    CSRF.append(req.url.path)
app = FastAPI()
app.include_router(user)
rt = ga.build_router(base_dir=GEO, is_admin=lambda req: False, verify_csrf=verify_csrf, register_mbtiles=None)
app.include_router(rt)
c = TestClient(app)
def ok(resp, code=200):
    assert resp.status_code == code, (resp.status_code, resp.text[:800])
    return resp
def wait(jid, limit=300):
    t = time.time()
    while time.time() - t < limit:
        j = ok(c.get(f'/api/georef/jobs/{jid}')).json()
        if j['status'] in ('done', 'error', 'cancelled'):
            return j
        time.sleep(0.3)
    raise SystemExit('timeout ' + jid)
def post_m2t(path, t, name=None):
    fl = [('files', (name or path.name, open(path, 'rb'), 'application/octet-stream'))]
    return wait(ok(c.post('/api/georef/jobs', data={'kind': 'mb2tif', 'params': json.dumps({'mb2tif': t})}, files=fl)).json()['id'])
def shift(jid, target, **kw):
    return c.post(f'/api/georef/jobs/{jid}/shift', json=dict(target=target, **kw))
caps = ok(c.get('/api/georef/caps')).json()
check('caps: version 20.7, shift_kinds с mb2tif, mbtiles_shift.py на месте', caps.get('version') == '20.7' and 'mb2tif' in caps.get('shift_kinds', [])
      and caps.get('shift_tools', {}).get('mbtiles_shift') is True and caps.get('crs_raster_shift') is True, {k: caps.get(k) for k in ('version', 'shift_kinds', 'shift_tools')})

src = W / 'участок 1-151.mbtiles'
make_mb(src)
j = post_m2t(src, {'zoom': 'max', 'crs': 'EPSG:3857'})
o = (j.get('result') or {}).get('outputs', [{}])[0]
check('API: задание «MBTiles → TIFF» (EPSG:3857) готово', j['status'] == 'done' and o.get('file') == 'участок 1-151.tif', (j['status'], j.get('error'), o.get('file')))
jid, jd = j['id'], W / 'srv' / 'jobs' / j['id']
out = jd / 'out'
tif = out / o['file']
TA, PA, WA, PB = tr(tif), pix(tif), world(out / 'участок 1-151.tfw'), list(o['preview_bounds_3857'])
r = ok(shift(jid, o['file'], dx=10.0, dy=-4.0)).json()
o2 = r['job']['result']['outputs'][0]
TB = tr(tif)
check('API: сдвиг (10, −4) — GeoTIFF на месте, точно', r.get('mode') == 'inplace' and close((TB.c - TA.c, TB.f - TA.f), (10.0, -4.0), 1e-6) and pix(tif) == PA, (r.get('mode'), TB.c - TA.c, TB.f - TA.f))
check('  .tfw/.tfwx, world_file, preview_bounds_3857 сдвинуты', close(world(out / 'участок 1-151.tfw')[4:], [WA[4] + 10, WA[5] - 4], 1e-6)
      and close(world(out / 'участок 1-151.tfwx')[4:], [WA[4] + 10, WA[5] - 4], 1e-6) and close(o2['preview_bounds_3857'], [PB[0] + 10, PB[1] - 4, PB[2] + 10, PB[3] - 4], 2e-3)
      and close(o2['world_file'][4:], [o['world_file'][4] + 10, o['world_file'][5] - 4], 1e-6))
ms = o2.get('mbtiles_shifted') or {}
mfile = out / (ms.get('file') or '-')
z = 18; rz = 2 * ORIGIN / (256 * 2 ** z)
check('  «участок 1-151_сдвиг.mbtiles»: всё изображение сдвинуто на всех уровнях', ms.get('file') == 'участок 1-151_сдвиг.mbtiles' and mfile.is_file()
      and same_shifted(src, mfile, 18, int(round(10 / rz)), int(round(4 / rz))) and same_shifted(src, mfile, 16, int(round(10 / (rz * 4))), int(round(4 / (rz * 4)))), ms)
check('  shift_3857/shift_m/v; files и подпись файла', o2.get('shift_3857') == [10.0, -4.0] and abs(o2['shift_m'][0] - 10 * math.cos(math.radians(53.9))) < 0.02 and o2.get('v')
      and any(f['name'] == ms.get('file') and 'со сдвигом' in f['label'] for f in r['job']['files']), (o2.get('shift_m'), [f['name'] for f in r['job']['files']]))
check('  скачивание сдвинутого MBTiles по имени (кириллица)', ok(c.get(f'/api/georef/jobs/{jid}/files/' + ms['file'])).content == mfile.read_bytes())
zr = ok(c.get(f'/api/georef/jobs/{jid}/zip?what=all&sheet=' + o['name']))
zn = zipfile.ZipFile(io.BytesIO(zr.content)).namelist()
check('  ZIP «TIFF + TFWX» — только ГИС-файлы, с новой привязкой', sorted(zn) == sorted(['участок 1-151.tif', 'участок 1-151.tfw', 'участок 1-151.tfwx', 'участок 1-151.prj'])
      and world_txt_ok if (world_txt_ok := close([float(v) for v in zipfile.ZipFile(io.BytesIO(zr.content)).read('участок 1-151.tfw').decode().split()][4:], [WA[4] + 10, WA[5] - 4], 1e-6)) else False, zn)
check('  result.json на диске обновлён, report.txt — строка о сдвиге', json.loads((out / 'result.json').read_text(encoding='utf-8'))['outputs'][0]['shift_3857'] == [10.0, -4.0]
      and 'ручной сдвиг «участок 1-151.tif»' in (out / 'report.txt').read_text(encoding='utf-8') if (out / 'report.txt').is_file() else False)
r = ok(shift(jid, o['file'], dx=-2.5, dy=1.0)).json()
o3 = r['job']['result']['outputs'][0]
TC = tr(tif)
check('  повторный сдвиг накапливается: итого (7,5, −3)', r['total_3857'] == [7.5, -3.0] and close((TC.c - TA.c, TC.f - TA.f), (7.5, -3.0), 1e-6)
      and same_shifted(src, out / o3['mbtiles_shifted']['file'], 18, int(round(7.5 / rz)), int(round(3 / rz))), (r['total_3857'], TC.c - TA.c))
r = ok(shift(jid, o['file'], reset=True)).json()
o4 = r['job']['result']['outputs'][0]
check('  «Исходная привязка»: GeoTIFF/TFW как были, сдвинутый MBTiles удалён', close(tr(tif)[:6], TA[:6], 1e-7) and close(world(out / 'участок 1-151.tfw'), WA, 1e-6)
      and 'shift_3857' not in o4 and 'mbtiles_shifted' not in o4 and not mfile.exists() and close(o4['preview_bounds_3857'], PB, 2e-3), (tr(tif).c - TA.c, o4.get('mbtiles_shifted')))
check('  нулевой сдвиг — без работы', ok(shift(jid, o['file'], dx=0, dy=0)).json()['mbtiles'] == [])
rr = shift(jid, 'нет.tif', dx=1, dy=1)
check('  неизвестный файл — 404', rr.status_code == 404, rr.status_code)
rr = shift(jid, o['file'], dx=30000, dy=0)
check('  сдвиг больше 20 км за раз — 422', rr.status_code == 422, rr.status_code)

# 3b. EPSG:4326 — перепроецированный
j2 = post_m2t(src, {'zoom': 'max', 'crs': 'EPSG:4326'})
p = (j2.get('result') or {}).get('outputs', [{}])[0]
check('API: «MBTiles → TIFF» в EPSG:4326 (перепроецирован) готово', j2['status'] == 'done' and p.get('reprojected') is True, (j2['status'], j2.get('error')))
jid2 = j2['id']; out2 = W / 'srv' / 'jobs' / jid2 / 'out'; tif2 = out2 / p['file']
TA2, PA2, BA2 = tr(tif2), pix(tif2), bounds(tif2)
def ref(dx, dy, tag):
    q = m2t.convert(src, W / f'ref_{tag}', crs='EPSG:4326', name='r', shift=(dx, dy))
    return bounds(W / f'ref_{tag}' / 'r.tif'), [abs(q['pixel'][0]), abs(q['pixel'][1])]
r = ok(shift(jid2, p['file'], dx=8.0, dy=5.0)).json()
bref, pxs = ref(8.0, 5.0, 'a')
bb = bounds(tif2)
err = max(abs(bb[0] - bref[0]) / pxs[0], abs(bb[2] - bref[2]) / pxs[0], abs(bb[1] - bref[1]) / pxs[1], abs(bb[3] - bref[3]) / pxs[1])
check('  сдвиг (8, 5): на месте в градусах, совпадает со сборкой «со сдвигом» < 0,5 пикс', r.get('mode') == 'inplace' and err < 0.5 and pix(tif2) == PA2
      and abs((tr(tif2).c - TA2.c) - math.degrees(8.0 / R)) < 1e-10, (r.get('mode'), round(err, 3), r.get('err_px')))
check('  сдвинутый MBTiles собран и для перепроецированного', (r['job']['result']['outputs'][0].get('mbtiles_shifted') or {}).get('tiles', 0) > 0)
r = ok(shift(jid2, p['file'], dx=0, dy=15000.0)).json()
bref, pxs = ref(8.0, 15005.0, 'b')
bb = bounds(tif2)
err = max(abs(bb[0] - bref[0]) / pxs[0], abs(bb[2] - bref[2]) / pxs[0], abs(bb[1] - bref[1]) / pxs[1], abs(bb[3] - bref[3]) / pxs[1])
check('  большой сдвиг (15 км): ' + str(r.get('mode')) + ', совпадает со сборкой «со сдвигом» < 0,5 пикс', err < 0.5 and r.get('mode') in ('inplace', 'rebuild'), (r.get('mode'), round(err, 3), r.get('err_px')))
mode_b = r.get('mode')
r = ok(shift(jid2, p['file'], reset=True)).json()
check('  «Исходная привязка» (EPSG:4326): GeoTIFF как был' + (' — собран заново' if mode_b == 'rebuild' else ''), close(tr(tif2)[:6], TA2[:6], 1e-9) and pix(tif2) == PA2
      and 'shift_3857' not in r['job']['result']['outputs'][0], (tr(tif2).c - TA2.c, tr(tif2).f - TA2.f))

# 3c. MBTiles в ZIP: work/ удалён после задания — исходник берётся из ZIP
zp = W / 'архив.zip'
with zipfile.ZipFile(zp, 'w') as zf:
    zf.write(src, 'папка/план 7.mbtiles')
j3 = post_m2t(zp, {'zoom': 'max', 'crs': 'EPSG:3857'})
q3 = (j3.get('result') or {}).get('outputs', [{}])[0]
r = shift(j3['id'], q3.get('file', ''), dx=3.0, dy=3.0)
ms3 = (r.json().get('job', {}).get('result', {}).get('outputs', [{}])[0].get('mbtiles_shifted') or {}) if r.status_code == 200 else {}
check('API: MBTiles из ZIP — сдвиг и «план 7_сдвиг.mbtiles» (исходник извлечён из ZIP заново)', j3['status'] == 'done' and r.status_code == 200
      and not (W / 'srv' / 'jobs' / j3['id'] / 'work').exists() and ms3.get('file') == 'план 7_сдвиг.mbtiles', (j3.get('error'), r.status_code, r.text[:200], ms3))
# исходник удалён — GeoTIFF сдвигается, MBTiles — с предупреждением
shutil.rmtree(W / 'srv' / 'jobs' / j3['id'] / 'in')
r = shift(j3['id'], q3.get('file', ''), dx=1.0, dy=0.0)
check('  исходник удалён: GeoTIFF сдвинут, предупреждение про MBTiles', r.status_code == 200 and any('MBTiles со сдвигом не собран' in w for w in r.json().get('warnings', []))
      and 'mbtiles_shifted' not in r.json()['job']['result']['outputs'][0], (r.status_code, r.text[:300]))

# ═════════════ 4. /api/crs-shift/raster/… ═════════════
def zip_bytes(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        for n, d in files.items():
            z.writestr(n, d)
    return b.getvalue()
gj = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': None, 'properties': {'kind': 'raster', 'extent3857': [1, 2, 3, 4]}}]}
zb = zip_bytes({'пер. Стахановский (оз)_сдвиг.tif': b'II*\x00' + b'\x00' * 64, 'пер. Стахановский (оз)_сдвиг.tfw': '1\n0\n0\n-1\n10\n20\n'})
CSRF.clear()
r = c.post('/api/crs-shift/raster/abc123/0/file', files={'zip': ('пер. Стахановский (оз)_сдвиг.zip', zb, 'application/zip'),
                                                        'geojson': ('preview.geojson', json.dumps(gj), 'application/geo+json')},
           data={'info': 'ΔX 1 м, ΔY 2 м', 'name': 'пер. Стахановский (оз)_сдвиг.zip'})
d = r.json() if r.status_code == 200 else {}
check('Смена СК, растр: POST /api/crs-shift/raster/{jid}/{idx}/file — сохранено (а не «нет .shp»)', r.status_code == 200 and d.get('download_url', '').startswith('/api/crs-shift/raster/abc123/0/file')
      and 'crs_raster_uid' in r.headers.get('set-cookie', '') and CSRF == ['/api/crs-shift/raster/abc123/0/file'], (r.status_code, r.text[:300]))
check('  скачивание ZIP и контура', ok(c.get(d.get('download_url', '/x'))).content == zb and ok(c.get(d.get('preview_url', '/x'))).json() == gj)
li = ok(c.get('/api/crs-shift/raster/abc123/items/all')).json()
check('  список сохранённых: элемент 0 с именем и сведениями', li.get('items', {}).get('0', {}).get('name') == 'пер. Стахановский (оз)_сдвиг.zip' and li['items']['0']['info'] == 'ΔX 1 м, ΔY 2 м', li)
c2 = TestClient(app)
check('  другой пользователь не видит и не скачивает', c2.get('/api/crs-shift/raster/abc123/items/all').json().get('items') == {} and c2.get(d.get('download_url', '/x')).status_code == 404)
check('  маршруты crs_shift.py (подключены раньше) не перехватывают', c.get('/api/crs-shift/abc123').json().get('user') is True and c.get('/api/crs-shift/raster/abc123/items/all').json().get('raster') is True)
r = c.post('/api/crs-shift/raster/abc123/1/file', files={'zip': ('x.zip', b'not a zip', 'application/zip')})
check('  не ZIP — 422', r.status_code == 422, r.status_code)
r = c.post('/api/crs-shift/raster/abc123/1/file', files={'zip': ('x.zip', zip_bytes({'a.shp': b'1'}), 'application/zip')})
check('  ZIP без растра — 422 с понятным текстом', r.status_code == 422 and 'нет растра' in r.text, (r.status_code, r.text[:200]))
r = c.post('/api/crs-shift/raster/abc123/1/file', files={'zip': ('x.zip', zip_bytes({'../a.tif': b'1'}), 'application/zip')})
check('  пути «../» в ZIP — 422', r.status_code == 422, r.status_code)
check('  неверный id задания — 404', c.post('/api/crs-shift/raster/..%2Fx/0/file', files={'zip': ('x.zip', zb, 'application/zip')}).status_code == 404
      and c.get('/api/crs-shift/raster/a$b/items/all').status_code == 404)
zb2 = zip_bytes({'b_сдвиг.tif': b'II*\x00' + b'\x01' * 64})
r = ok(c.post('/api/crs-shift/raster/abc123/0/file', files={'zip': ('b_сдвиг.zip', zb2, 'application/zip')})).json()
check('  повторное сохранение заменяет прежнее', ok(c.get(r['download_url'])).content == zb2 and len(ok(c.get('/api/crs-shift/raster/abc123/items/all')).json()['items']) == 1)
CSRF.clear()
r = c.delete('/api/crs-shift/raster/abc123/0/file')
check('  DELETE: удалено, CSRF проверен', r.status_code == 200 and r.json().get('removed') is True and c.get('/api/crs-shift/raster/abc123/0/file').status_code == 404 and CSRF == ['/api/crs-shift/raster/abc123/0/file'], r.status_code)
r = c.delete('/api/crs-shift/raster/abc123/0/file')
check('  повторный DELETE (нечего удалять) — 200, removed=false', r.status_code == 200 and r.json().get('removed') is False, (r.status_code, r.text[:200]))

rt.store.stop()
print(f'\n{N[0] - len(FAIL)}/{N[0]} OK' + (' — FAIL: ' + '; '.join(FAIL) if FAIL else ''))
sys.exit(1 if FAIL else 0)
