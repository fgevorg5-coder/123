# -*- coding: utf-8 -*-
"""Run from any directory: python geoservice/check_install_v20.11.py"""
from pathlib import Path
import hashlib, json, sys
root = Path(__file__).resolve().parent
missing=[]
def out(s):
    try: print(s)
    except UnicodeEncodeError: print(s.encode(sys.stdout.encoding or 'ascii','replace').decode(sys.stdout.encoding or 'ascii'))
def check(condition, text):
    out(('  OK  ' if condition else ' FAIL ') + text)
    if not condition: missing.append(text)
def text(p):
    try: return (root/p).read_text(encoding='utf-8')
    except OSError: return ''
for f in ['app.py','templates/index.html','static/view3d.js','static/forest3d-taxation.js','static/forest3d/taxation/tax-worker.js','static/forest3d/taxation/species.json','static/vendor/three/three.module.min.js','static/vendor/three/OrbitControls.js','static/vendor/three/GLTFLoader.js','static/vendor/three/BufferGeometryUtils.js']:
    check((root/f).is_file(),f)
check('forest3d-taxation.js' in text('templates/index.html'), 'index.html подключает новый модуль')
check('Forest3DTaxation.attach' in text('static/view3d.js'),'view3d.js подключает панель')
try:
    models=json.loads((root/'static/forest3d/taxation/models/sources.json').read_text(encoding='utf-8'))
    check(len(models)==13,'манифест 13 моделей')
    for m in models:
        b=(root/'static/forest3d/taxation/models'/m['file']).read_bytes()
        check(len(b)==m['bytes'] and hashlib.sha256(b).hexdigest()==m['sha256'],'модель '+m['file'])
except Exception as e: check(False,'модели: '+str(e))
out('Ошибки установки: '+str(len(missing)) if missing else 'Проверка v20.11: всё на месте.')
sys.exit(bool(missing))
