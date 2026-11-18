"""Проверка установки v20.13: наличие файлов и корректность импорта perf_kit."""
import os, sys, hashlib
BASE = os.path.dirname(os.path.abspath(__file__))
NEED = ["app.py", "perf_kit.py", "server.py", "security_hardening.py", "jobkit.py",
        "lesolidar_bridge.py", "georef_api.py", "manuals_editor_api.py", "geo_guard.py"]
ok = True
for f in NEED:
    p = os.path.join(BASE, f)
    if not os.path.isfile(p):
        print("НЕТ ФАЙЛА:", f); ok = False
src = open(os.path.join(BASE, "app.py"), encoding="utf-8").read() if os.path.isfile(os.path.join(BASE, "app.py")) else ""
for marker in ("import perf_kit as _pk", "_cb_lock = _asyncio.Lock()", "_imagery_names_for_bbox", "async def _json_body"):
    if marker not in src:
        print("app.py не v20.13 — нет фрагмента:", marker); ok = False
sys.path.insert(0, BASE)
try:
    import perf_kit
    perf_kit.TTLCache(1, 1).put("a", 1)
except Exception as e:
    print("perf_kit не импортируется:", e); ok = False
print("v20.13: установка в порядке" if ok else "v20.13: есть проблемы, см. выше")
sys.exit(0 if ok else 1)
