# Стенд v20.8 «Приближение к снимкам ДЗЗ» + «Съёмка по годам».
# Отдаёт настоящий templates/index.html (Jinja2 + static_assets) со всеми скриптами из geoservice/static,
# а вместо внутренних сервисов портала — заглушки:
#   • /geoserver_wms_proxy — мини-GeoServer: GetCapabilities (EX_GeographicBoundingBox для каждого слоя External),
#     WFS GetFeature (контур снимка, EPSG:3857 или 4326), GetMap (снимок рисуется полупрозрачной «панхроматикой»
#     строго по своему контуру, контур — линией). «Истинные» контуры снимков задаются здесь (TRUTH): 4114861 лежит
#     полосой в Витебской области, а в window._dzzTabs у него «ручной» bbox Минской области — ровно как у пользователя.
#   • panel-dzz.js на портале в комплект не входил → отдаётся tests/dzz_timeline/mock_panel_dzz.js: та же разметка
#     (.dzz-sub-item/.dzz-sub-act-btn/#dzz-tabs2/#dzz-body) и «старое» приближение по ld.bbox.
#   • /api/* — пустые ответы; /api/forestry-boundaries — прямоугольники лесхозов из bbox вкладки ЛУ.
# Управление: /__mode?caps=0|1&wfs=0|1&delay=мс&zoommark=title|datatip|tip|icon   /__log — журнал запросов к GeoServer.
# Запуск: GEO_DIR=<папка geoservice> python3 stand.py [порт]
import os, sys, re, io, json, math, time, random, hashlib
from functools import lru_cache
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, Response, JSONResponse, FileResponse
from PIL import Image, ImageDraw
import jinja2

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.abspath(os.environ.get('GEO_DIR') or os.path.join(HERE, '..', '..', 'geoservice'))
STATIC = os.path.join(GEO, 'static')
FE = os.environ.get('FE_DIR', '/data/fe')        # локальные ol.js / ol.css / proj4.js (иначе — CDN)
sys.path.insert(0, GEO)

R = 6378137.0
def merc(lon, lat): return (R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
def unmerc(x, y): return (math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2))

# ── разбор map-core.js: EXTERNAL_LAYER_DEFS и window._dzzTabs ─────────────────────────────────────
SRC = open(os.path.join(STATIC, 'map-core.js'), encoding='utf-8').read()
def _block(start, end):
    i = SRC.index(start); return SRC[i:SRC.index(end, i)]
DEFS = {}
for m in re.finditer(r"\{\s*key:\s*'([^']+)',\s*label:\s*'([^']*)',\s*sublabel:\s*'([^']*)'(.*?)\}", _block('const EXTERNAL_LAYER_DEFS = [', 'window.EXTERNAL_LAYER_DEFS = EXTERNAL_LAYER_DEFS')):
    DEFS[m.group(1)] = {'key': m.group(1), 'label': m.group(2), 'sublabel': m.group(3), 'raster': 'isRaster: true' in m.group(4)}
FOLDERS = []          # (tab, year, key, label, subkeys, bbox)
_tab = None; _year = None
for line in _block('window._dzzTabs = [', 'window._reorderDZZLayers = function').splitlines():
    t = re.search(r"\{ id:'(\w+)'", line)
    if t: _tab = t.group(1)
    ys = re.findall(r"(\d{4})\s*:\s*\[", line)
    if ys: _year = int(ys[-1])
    m = re.search(r"key:\s*'([^']+)',\s*label:\s*'([^']+)'.*?subkeys:\s*\[([^\]]*)\](.*)", line)
    if m and m.group(1) != 'bundle_all_pans':
        bb = re.search(r"bbox:\s*\[([^\]]+)\]", m.group(4))
        FOLDERS.append((_tab, _year, m.group(1), m.group(2), re.findall(r"'([^']+)'", m.group(3)),
                        [float(v) for v in bb.group(1).split(',')] if bb else None))

def short(n): return n.split(':', 1)[1] if ':' in n else n

# ── «истинные» контуры (lon/lat) ─────────────────────────────────────────────────────────────────
SPECIAL = {   # снимок из жалобы пользователя: полоса в Витебской обл. (у «ручного» bbox — Минская обл.)
    'bundle_ks_4114861': [(28.42, 54.93), (28.80, 54.90), (29.02, 56.02), (28.63, 56.05)],
}
def _strip(bundle_key, bbox):
    rnd = random.Random(int(hashlib.md5(bundle_key.encode()).hexdigest()[:8], 16))
    if bbox:
        w, s, e, n = bbox; cx = (w + e) / 2
    else:
        cx = rnd.uniform(24.2, 31.0); s = rnd.uniform(51.6, 54.6); n = s + rnd.uniform(0.9, 1.6); w = cx - .3; e = cx + .3
    half = min(0.2, max(0.12, (e - w) / 3)); sk = rnd.uniform(-0.12, 0.12)
    return [(cx - half - sk, s), (cx + half - sk, s), (cx + half + sk, n), (cx - half + sk, n)]
TRUTH = {}            # короткое имя слоя → полигон (lon/lat)
for tab, year, key, label, sks, bbox in FOLDERS:
    if tab == 'base':
        if not bbox: continue
        w, s, e, n = bbox; dx = (e - w) * .06; dy = (n - s) * .06
        poly = [(w + dx, s + dy), (e - dx, s + dy), (e - dx, n - dy), (w + dx, n - dy)]
        for k in sks:
            if k in DEFS and DEFS[k]['sublabel'].startswith('External:'): TRUTH[short(DEFS[k]['sublabel'])] = poly
        continue
    poly = SPECIAL.get(key) or _strip(key, bbox)
    cogs = [k for k in sks if k in DEFS and DEFS[k]['raster']]
    bnds = [k for k in sks if k.endswith('_bounds') and k in DEFS]
    for k in bnds: TRUTH[short(DEFS[k]['sublabel'])] = poly
    (a, b, c, d) = poly
    for i, k in enumerate(cogs):          # несколько COG в связке — делим полосу по широте
        t0, t1 = i / len(cogs), (i + 1) / len(cogs)
        lerp = lambda p, q, t: (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
        TRUTH[short(DEFS[k]['sublabel'])] = [lerp(a, d, t0), lerp(b, c, t0), lerp(b, c, t1), lerp(a, d, t1)]

def bbox_ll(poly):
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]; return [min(xs), min(ys), max(xs), max(ys)]

MODE = {'caps': 1, 'wfs': 1, 'delay': 0, 'zoommark': 'title', 'demo': ''}
LOG = []
TILES = []          # [v20.10] журнал GetMap: LAYERS и _target (как их видит nginx/GeoServer)
app = FastAPI()

@app.get('/__mode')
def mode(request: Request):
    for k, v in request.query_params.items():
        if k in MODE: MODE[k] = int(v) if k in ('caps', 'wfs', 'delay') else v
    return MODE
@app.get('/__log')
def log(clear: int = 0):
    out = list(LOG)
    if clear: LOG.clear()
    return out
@app.get('/__tiles')
def tiles(clear: int = 0):
    out = list(TILES)
    if clear: TILES.clear()
    return out
@app.get('/__truth')
def truth(): return {k: bbox_ll(v) for k, v in TRUTH.items()}

# ── мини-GeoServer ─────────────────────────────────────────────────────────────────────────────
def _caps_xml():
    out = ['<?xml version="1.0" encoding="UTF-8"?><WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" '
           'xmlns:xlink="http://www.w3.org/1999/xlink"><Service><Name>WMS</Name><Title>External</Title></Service><Capability>'
           '<Request/><Layer><Title>External</Title><CRS>EPSG:3857</CRS><CRS>EPSG:4326</CRS>'
           '<EX_GeographicBoundingBox><westBoundLongitude>19.0</westBoundLongitude><eastBoundLongitude>37.0</eastBoundLongitude>'
           '<southBoundLatitude>47.0</southBoundLatitude><northBoundLatitude>60.0</northBoundLatitude></EX_GeographicBoundingBox>']
    for name, poly in TRUTH.items():
        w, s, e, n = bbox_ll(poly)
        out.append('<Layer queryable="1" opaque="0"><Name>%s</Name><Title>%s</Title><CRS>EPSG:3857</CRS>'
                   '<EX_GeographicBoundingBox><westBoundLongitude>%.6f</westBoundLongitude><eastBoundLongitude>%.6f</eastBoundLongitude>'
                   '<southBoundLatitude>%.6f</southBoundLatitude><northBoundLatitude>%.6f</northBoundLatitude></EX_GeographicBoundingBox>'
                   '<BoundingBox CRS="EPSG:4326" minx="%.6f" miny="%.6f" maxx="%.6f" maxy="%.6f"/></Layer>'
                   % (name, name, w, e, s, n, s, w, n, e))
    out.append('</Layer></Capability></WMS_Capabilities>')
    return ''.join(out)

@lru_cache(maxsize=1)
def _noise():
    rnd = random.Random(7); im = Image.new('L', (256, 256))
    px = im.load()
    for y in range(256):
        for x in range(256):
            px[x, y] = int(110 + 60 * math.sin(x / 9.0) * math.cos(y / 13.0) + rnd.randint(-28, 28))
    return im

@lru_cache(maxsize=4096)
def _tile(layers, bbox, w, h):
    minx, miny, maxx, maxy = bbox
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    for lay in layers.split(','):
        poly = TRUTH.get(short(lay))
        if not poly: continue
        pts = []
        for lon, lat in poly:
            x, y = merc(lon, lat)
            pts.append(((x - minx) / (maxx - minx) * w, (maxy - y) / (maxy - miny) * h))
        if lay.endswith('_bounds'):
            ImageDraw.Draw(im).line(pts + [pts[0]], fill=(156, 126, 232, 255), width=3)
        else:
            mask = Image.new('L', (w, h), 0); ImageDraw.Draw(mask).polygon(pts, fill=215)
            g = _noise().resize((w, h)); rgb = Image.merge('RGBA', (g, g, g, mask))
            im = Image.alpha_composite(im, rgb)
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()

EMPTY = None
def _empty_png():
    global EMPTY
    if EMPTY is None:
        buf = io.BytesIO(); Image.new('RGBA', (1, 1), (0, 0, 0, 0)).save(buf, 'PNG'); EMPTY = buf.getvalue()
    return EMPTY

@app.get('/geoserver_wms_proxy')
async def gs(request: Request):
    q = {k.upper(): v for k, v in request.query_params.items()}
    req = q.get('REQUEST', '').lower(); svc = q.get('SERVICE', 'WMS').upper()
    if MODE['delay'] and req != 'getmap': time.sleep(MODE['delay'] / 1000.0)
    if req != 'getmap':
        LOG.append({'t': round(time.time(), 3), 'service': svc, 'request': q.get('REQUEST', ''), 'typename': q.get('TYPENAME', q.get('TYPENAMES', '')),
                    'srs': q.get('SRSNAME', ''), 'target': q.get('_TARGET', ''), 'version': q.get('VERSION', '')})
    if req == 'getcapabilities':
        if not MODE['caps']: return Response('<ServiceExceptionReport><ServiceException>disabled</ServiceException></ServiceExceptionReport>', 500, media_type='text/xml')
        return Response(_caps_xml(), media_type='text/xml')
    if req == 'getfeature':
        if not MODE['wfs']: return Response('<ows:ExceptionReport><ows:Exception>WFS disabled</ows:Exception></ows:ExceptionReport>', 400, media_type='text/xml')
        tn = short(q.get('TYPENAME', q.get('TYPENAMES', ''))); poly = TRUTH.get(tn)
        if not poly: return Response('<ows:ExceptionReport><ows:Exception>Unknown featureType</ows:Exception></ows:ExceptionReport>', 400, media_type='text/xml')
        srs = q.get('SRSNAME', '')
        ring = [list(merc(*p)) if '3857' in srs else [p[0], p[1]] for p in poly]; ring.append(ring[0])
        crs = 'urn:ogc:def:crs:EPSG::3857' if '3857' in srs else 'urn:ogc:def:crs:EPSG::4326'
        fid = re.match(r'(\d{7})', tn)
        return JSONResponse({'type': 'FeatureCollection', 'totalFeatures': 1, 'crs': {'type': 'name', 'properties': {'name': crs}},
                             'features': [{'type': 'Feature', 'id': tn + '.1', 'geometry': {'type': 'Polygon', 'coordinates': [ring]},
                                           'properties': {'FileName': (fid.group(1) if fid else tn) + '-0330-PAN.tif'}}]})
    if req == 'getmap':
        # [v20.10] как настоящий GeoServer за nginx: без LAYERS — ServiceException «LAYERS parameter is mandatory»,
        # слой External:* с _target≠GEOSERVER_EXT уходит не в тот GeoServer — «Could not find layer».
        lay = q.get('LAYERS', ''); tgt = q.get('_TARGET', '')
        TILES.append({'layers': lay, 'target': tgt, 'kind': q.get('_KIND', '')})
        if len(TILES) > 5000: del TILES[:1000]
        err = 'LAYERS parameter is mandatory' if not lay else ('Could not find layer ' + lay if lay.startswith('External:') and tgt and tgt != 'GEOSERVER_EXT' else '')
        if err:
            return Response('<?xml version="1.0"?><ServiceExceptionReport version="1.1.1"><ServiceException code="LayerNotDefined">%s</ServiceException></ServiceExceptionReport>' % err,
                            media_type='application/vnd.ogc.se_xml')
        try:
            bbox = tuple(float(v) for v in q.get('BBOX', '').split(','))
            crs = q.get('CRS', q.get('SRS', 'EPSG:3857'))
            if '4326' in crs:
                if q.get('VERSION', '1.1.1').startswith('1.3'): bbox = (bbox[1], bbox[0], bbox[3], bbox[2])
                a = merc(bbox[0], bbox[1]); b = merc(bbox[2], bbox[3]); bbox = (a[0], a[1], b[0], b[1])
            return Response(_tile(q.get('LAYERS', ''), bbox, int(q.get('WIDTH', 256)), int(q.get('HEIGHT', 256))), media_type='image/png')
        except Exception:
            return Response(_empty_png(), media_type='image/png')
    return Response(_empty_png(), media_type='image/png')

@app.get('/belgosles_wms_proxy')
@app.get('/dzz-wms-proxy')
def other_wms(): return Response(_empty_png(), media_type='image/png')

# ── API-заглушки ───────────────────────────────────────────────────────────────────────────────
@app.get('/api/forestry-boundaries')
def forestry():
    feats = []
    for tab, year, key, label, sks, bbox in FOLDERS:
        if tab != 'base' or not bbox: continue
        code = None
        for k in sks:
            mm = re.search(r"key:\s*'%s'[^}]*leskhozCode:\s*'(\d+)'" % re.escape(k), SRC)
            if mm: code = mm.group(1); break
        w, s, e, n = bbox
        feats.append({'type': 'Feature', 'properties': {'code': code or key, 'name': label},
                      'geometry': {'type': 'Polygon', 'coordinates': [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}})
    return {'type': 'FeatureCollection', 'features': feats}

@app.api_route('/api/{path:path}', methods=['GET', 'POST'])
def api_any(path: str):
    if path == 'country-boundary': return Response('', 404)
    if path == 'forest3d/access': return {'allowed': True, 'users_enabled': True, 'is_admin': True}
    if path in ('images', 'vectors', 'basemaps', 'mbtiles/list'): return JSONResponse([])
    if path.endswith('boundaries'): return {'type': 'FeatureCollection', 'features': []}
    return JSONResponse({})

# ── статика и страница ──────────────────────────────────────────────────────────────────────────
MOCKS = {'panel-dzz.js': os.path.join(HERE, 'mock_panel_dzz.js')}
@app.get('/static/{path:path}')
def static(path: str):
    if path in MOCKS: return FileResponse(MOCKS[path], media_type='application/javascript', headers={'Cache-Control': 'no-store'})
    full = os.path.normpath(os.path.join(STATIC, path))
    if full.startswith(STATIC) and os.path.isfile(full):
        return FileResponse(full, headers={'Cache-Control': 'no-store'})
    ct = 'text/css' if path.endswith('.css') else 'application/javascript'
    return Response('', media_type=ct)          # файлы, которых нет в комплекте (style.css, unified-search.js …)
@app.get('/__fe/{name}')
def fe(name: str):
    p = os.path.join(FE, name)
    return FileResponse(p) if os.path.isfile(p) else Response('', 404)

class _T: pass
_tpl = _T(); _tpl.env = jinja2.Environment(loader=jinja2.FileSystemLoader(os.path.join(GEO, 'templates')), autoescape=True)
try:
    import static_assets; static_assets.install(_tpl, STATIC)
except Exception as e:
    print('static_assets:', e)
    _tpl.env.globals['css_bundle'] = lambda name, defer=False: ''
    _tpl.env.globals['inline_js'] = lambda rel: jinja2.utils.markupsafe.Markup('<script src="/static/%s"></script>' % rel)
_tpl.env.globals['version'] = 'stand208'

@app.get('/', response_class=HTMLResponse)
def page():
    html = _tpl.env.get_template('index.html').render(
        organization_name='', news_first=None, user_name='Тестировщик', season='', profile_org='ГЛХУ (стенд)',
        profile_name='Тестировщик', csrf_token='stand', is_admin=True, is_registered=True, has_profile=True)
    if os.path.isfile(os.path.join(FE, 'ol.js')):
        html = html.replace('https://cdn.jsdelivr.net/npm/ol@9.2.4/dist/ol.js', '/__fe/ol.js')
        html = re.sub(r'https://cdn\.jsdelivr\.net/npm/ol@9\.2\.4/(dist/)?ol\.css', '/__fe/ol.css', html)
        html = html.replace('https://cdn.jsdelivr.net/npm/proj4@2.10.0/dist/proj4.js', '/__fe/proj4.js')
    html = html.replace('crossorigin="anonymous" defer', 'defer')
    # style.css портала в комплект не входит — минимальная раскладка «как на портале»: карта на всё окно под шапкой,
    # меню лесхозов поверх карты слева (линейка сдвигается правее него — см. _updateScaleBarOffset в map-core.js).
    html = html.replace('</head>', '<style id="stand-layout">html,body{height:100%;margin:0;overflow:hidden;background:#0b140d}'
        'body{display:flex;flex-direction:column}.app-container{position:relative;flex:1 1 auto;min-height:0}'
        '.sidebar{position:absolute;left:8px;top:8px;bottom:8px;width:300px;z-index:900;overflow:auto;background:rgba(10,22,12,.94);'
        'color:#dfe;border-radius:12px;font:13px Lato,Arial,sans-serif}#map{position:fixed!important;left:0;top:0;width:100vw!important;height:100vh!important}</style></head>', 1)
    return HTMLResponse(html, headers={'Cache-Control': 'no-store'})

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]) if len(sys.argv) > 1 else 8208, log_level='warning')
