# UI-стенд: настоящий /api/georef (georef_api.py), заглушки /api/crs/*, OpenLayers, panel-crs.js
import os, sys, json, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.environ.get('GEO_DIR') or os.path.join(HERE, '..', '..', 'geoservice')   # полная папка новой версии: app.py, static/, tools/
WORK = os.environ.get('WORK_DIR') or os.path.join(HERE, '..', '_work')             # рабочие файлы тестов (создаются сами)
sys.path.insert(0, GEO)
W = os.path.join(WORK, 'georef_ui')
os.makedirs(W + '/cache', exist_ok=True)
for src in (os.path.join(WORK, 'georef_api', 'cache'), os.environ.get('GEOREF_CACHE_DIR', '')):
    if src and os.path.isdir(src):
        for f in os.listdir(src):
            d = W + '/cache/' + f
            if not os.path.exists(d):
                shutil.copy(os.path.join(src, f), d)
os.environ['GEOREF_WORKDIR'] = W
os.environ['GEOREF_TOOLS_DIR'] = os.path.join(GEO, 'tools', 'georef')
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
import georef_api as ga
STATIC = os.environ.get('STATIC_DIR') or os.path.join(GEO, 'static')
app = FastAPI()
REG = []
def reg(path, name):
    REG.append((path, name)); return {"success": True, "id": 77, "name": name, "tile_url": "/api/mbtiles/77/{z}/{x}/{y}.png"}
ADMIN = {'v': os.environ.get('UI_ADMIN', '1') == '1'}
app.include_router(ga.build_router(base_dir=GEO, is_admin=lambda req: ADMIN['v'] or req.headers.get('x-admin') == '1',
                                   verify_csrf=lambda req: None, register_mbtiles=reg))

@app.get('/api/crs/status')
def crs_status():
    return {"enabled": True, "is_admin": ADMIN['v'], "max_upload_mb": 2048}

@app.get('/api/crs/presets')
def crs_presets():
    presets = [{"id": "wgs84_3857", "name": "WGS-84 / Web Mercator (EPSG:3857)", "group": "wgs"},
               {"id": "wgs84_4326", "name": "WGS-84 географические (EPSG:4326)", "group": "wgs"},
               {"id": "sk42_z5", "name": "СК-42, 6° зона 5", "group": "sk42"},
               {"id": "sk63_c2", "name": "СК-63 C2", "group": "sk63"}]
    return {"groups": [{"id": "wgs", "name": "WGS-84"}, {"id": "sk42", "name": "СК-42"}, {"id": "sk63", "name": "СК-63"}],
            "presets": presets, "popular": ["wgs84_3857", "sk63_c2"],
            "datums": [{"id": "gost2001", "name": "ГОСТ 51794-2001"}]}

@app.get('/api/crs/jobs/current')
def crs_current():
    return {"job": None}

@app.get('/api/crs/shifts/{jid}')
def crs_shifts(jid: str):
    return {"items": {}}

@app.get('/admin_on')
def admin_on(v: int = 1):
    ADMIN['v'] = bool(v); return {"admin": ADMIN['v']}

@app.get('/reg_calls')
def reg_calls():
    return {"calls": REG}

@app.get('/fixtures')
def fixtures():
    # [v20.3] сканы «Пар-2-73…» без описания СК: ГК зона 5 (с № зоны) и UTM 35N (неоднозначно)
    sys.path.insert(0, HERE)
    import shift_fixtures as fx
    d = os.path.join(W, 'fixtures')
    return {"gk5": [str(p) for p in fx.write_par(os.path.join(d, 'gk5'))],
            "utm": [str(p) for p in fx.write_par(os.path.join(d, 'utm'), crs=fx.UTM35)]}

@app.get('/mb_fixture')
def mb_fixture(name: str = 'квартал_ортофото', fmt: str = 'png', n: int = 3, z0: int = 15, z1: int = 18):
    # [v20.7] растровый MBTiles для «MBTiles → TIFF → Переместить»
    sys.path.insert(0, HERE)
    import shift_fixtures as fx
    d = os.path.join(W, 'fixtures', 'mb'); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, os.path.basename(name) + '.mbtiles')
    if os.path.exists(p): os.remove(p)
    fx.write_mb(p, z0=z0, z1=z1, n=max(1, min(8, n)), fmt='jpg' if fmt == 'jpg' else 'png')
    return {"path": p}

@app.get('/seed_georef')
def seed_georef(tok: str):
    # [v20.3] готовое задание «План → GeoTIFF/TFW → MBTiles» владельца tok (cookie georef_uid)
    sys.path.insert(0, HERE)
    import shift_fixtures as fx
    return {"id": fx.seed_georef_job(W, tok, os.environ['GEOREF_TOOLS_DIR'], minzoom=17, maxzoom=21)}

@app.get('/fe/{name}')
def fe(name: str):
    # OpenLayers: своя копия (FE_DIR — папка с ol.js / ol.css) или CDN, как на портале
    d = os.environ.get('FE_DIR')
    if d and os.path.isfile(os.path.join(d, os.path.basename(name))):
        return FileResponse(os.path.join(d, os.path.basename(name)))
    from fastapi.responses import RedirectResponse
    return RedirectResponse('https://cdn.jsdelivr.net/npm/ol@9.2.4/dist/' + os.path.basename(name))

@app.get('/static/{path:path}')
def static(path: str):
    p = os.path.join(STATIC, path)
    if not os.path.isfile(p):
        return JSONResponse({"detail": "nf"}, 404)
    return FileResponse(p, headers={"Cache-Control": "no-store"})

PAGE = r'''<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="csrf-token" content="test">
<link rel="stylesheet" href="/fe/ol.css">
<style>html,body{margin:0;height:100%;font-family:Lato,Arial,sans-serif}#map{position:absolute;inset:0}
#slide{position:absolute;left:0;top:0;bottom:0;width:360px;background:#fff;box-shadow:2px 0 12px rgba(0,0,0,.2);z-index:10;overflow:hidden}
.msp-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#152918;color:#fff;font-weight:800}
.msp-close{background:none;border:none;color:#fff;cursor:pointer}</style>
<script>window.__errors=[];window.__toasts=[];window.addEventListener('error',function(e){__errors.push(String(e.message||e));});
window.addEventListener('unhandledrejection',function(e){__errors.push('unhandled: '+String(e.reason&&e.reason.message||e.reason));});
window.showToast=function(m,e){__toasts.push({m:String(m),e:!!e});};window._staticVer='test';</script>
<script src="/fe/ol.js"></script>
</head><body><div id="map"><div id="slide"></div></div>
<script>
window.map=new ol.Map({target:'map',layers:[new ol.layer.Tile({source:new ol.source.OSM()})],view:new ol.View({center:ol.proj.fromLonLat([27.6442,53.9332]),zoom:16})});
var s=document.createElement('script');s.src='/static/panel-crs.js?v=t';s.onload=function(){window.buildCrsPanel(document.getElementById('slide'),function(){if(window._panelCleanup)window._panelCleanup();document.getElementById('slide').innerHTML='';window.__closed=1;});};document.head.appendChild(s);
</script></body></html>'''

@app.get('/georef-test', response_class=HTMLResponse)
def page():
    return PAGE
