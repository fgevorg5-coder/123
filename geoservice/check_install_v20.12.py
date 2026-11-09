# -*- coding: utf-8 -*-
from pathlib import Path
import json,sys
root=Path(__file__).resolve().parent
failed=[]
def out(s):
    try: print(s)
    except UnicodeEncodeError: print(s.encode(sys.stdout.encoding or 'ascii','replace').decode(sys.stdout.encoding or 'ascii'))
def check(ok,label):
    out((' OK   ' if ok else ' FAIL ')+label)
    if not ok: failed.append(label)
def text(p):
    try:return (root/p).read_text(encoding='utf-8')
    except OSError:return ''
for p in ['app.py','templates/index.html','static/view3d.js','static/forest3d-taxation.js','static/forest3d-trees.js','static/forest3d/taxation/tax-worker.js','static/forest3d/taxation/species.json','static/vendor/three/three.module.min.js','static/vendor/three/OrbitControls.js']:
    check((root/p).is_file(),p)
check('forest3d-taxation.js?v=v20.12' in text('templates/index.html'),'шаблон подключает v20.12')
check('if (v.tax) v.tax.lod()' in text('static/view3d.js'),'движок обновляет детализацию деревьев')
try:
    d=root/'static/forest3d/trees';m=json.loads((d/'trees_v20.json').read_text(encoding='utf-8'))
    files={'trees_v20.json','trees_v20.bin',m['atlas']['file']}
    for model in m['models']:files.update(['bark_'+model['bark']+'.jpg','leaves_'+model['leaf']+'.webp'])
    check(len(m['models'])>=18,'каталог 18 форм деревьев')
    for f in sorted(files):check((d/f).is_file() and (d/f).stat().st_size>0,'модели: '+f)
except Exception as e:check(False,'каталог моделей: '+str(e))
out('Проверка v20.12: всё на месте.' if not failed else 'Ошибки установки: '+str(len(failed)))
sys.exit(bool(failed))
