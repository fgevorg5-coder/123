"""v20.10 — поиск LesoLidar.exe и подсказка «Не настроен» (без программы ЛесоЛидар и без сети).
Запуск: python tests/lesolidar/test_lesolidar_detect.py   (нужны fastapi, httpx — как для app.py)
Проверяет: подсказку администратору (куда положить, что проверено), отсутствие путей у обычных
пользователей, «двойную» папку после распаковки ZIP, .env с кавычками/папкой, исправление .env
без перезапуска (даже если старое значение уже в окружении), «Проверить снова» через /caps."""
import os, sys, time, shutil, tempfile
from pathlib import Path
HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.environ.get('GEO_DIR') or os.path.join(HERE, '..', '..', 'geoservice')
sys.path.insert(0, GEO)
for k in ('LESOLIDAR_EXE', 'LESOLIDAR_PYTHON', 'LESOLIDAR_PATH'):
    os.environ.pop(k, None)
TMP = Path(tempfile.mkdtemp(prefix='lldet_'))
os.environ['LESOLIDAR_WORKDIR'] = str(TMP / 'work')
import lesolidar_bridge as lb
from fastapi import FastAPI
from fastapi.testclient import TestClient
R = []
def ok(name, cond, info=''):
    R.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(info) if info else ''))
def fake_prog(folder: Path) -> Path:
    (folder / '_internal').mkdir(parents=True, exist_ok=True)
    exe = folder / 'LesoLidar.exe'; exe.write_bytes(b'MZ'); return exe
try:
    app_dir = TMP / 'DZZ_geo'; app_dir.mkdir()
    flags = {'admin': True}
    app = FastAPI()
    r = lb.build_router(base_dir=str(app_dir), is_admin=lambda q: flags['admin'], verify_csrf=lambda q: None)
    app.include_router(r); c = TestClient(app); eng = r.engine
    def caps(admin=True, wait=True):
        flags['admin'] = admin
        if wait:
            eng._detect_at = 0                      # «Проверить снова» — без ожидания 3 с
        return c.get('/api/lesolidar/caps').json()
    # 1. программы нет
    j = caps()
    ok('Нет программы: available=false, engine=null', j['available'] is False and j['engine'] is None, j['problems'])
    ok('Админу — подсказка: папка tools\\LesoLidar рядом с app.py', j['setup'] and j['setup']['dir'] == str(app_dir / 'tools' / 'LesoLidar'), j['setup'] and j['setup']['dir'])
    ok('Подсказка: список проверенных мест', j['setup'] and str(app_dir / 'tools' / 'LesoLidar' / 'LesoLidar.exe') in j['setup']['checked'], len(j['setup']['checked']))
    ok('Текст проблемы указывает на README «ЛесоЛидар»', any('README_DEPLOY_RU' in p for p in j['problems']))
    u = caps(admin=False)
    ok('Пользователю — без подсказки и без путей сервера', u['setup'] is None and u['engine_path'] is None and not any(str(TMP) in p for p in u['problems']), u['problems'])
    # 2. распаковали ZIP «папкой в папке»: tools\LesoLidar\LesoLidar\LesoLidar.exe
    exe = fake_prog(app_dir / 'tools' / 'LesoLidar' / 'LesoLidar')
    j = caps(wait=False)
    ok('Без «Проверить снова» повтор не чаще раза в 3 с', j['engine'] is None or time.time() - eng._detect_at < 3)
    j = caps()
    ok('Двойная папка найдена без перезапуска', j['engine'] == 'exe' and Path(eng.exe) == exe.resolve(), eng.exe)
    ok('Найдено — подсказка больше не нужна', j['setup'] is None)
    if lb.IS_WIN:
        ok('Windows: available=true', j['available'] is True)
    else:
        ok('Linux: честно «программа Windows»', j['available'] is False and any('Windows' in p for p in j['problems']), j['problems'])
    shutil.rmtree(app_dir / 'tools')
    j = caps()
    ok('Программу удалили — снова «не найден»', j['engine'] is None)
    # 3. обычная раскладка tools\LesoLidar\LesoLidar.exe, без _internal — предупреждение
    (app_dir / 'tools' / 'LesoLidar').mkdir(parents=True); (app_dir / 'tools' / 'LesoLidar' / 'LesoLidar.exe').write_bytes(b'MZ')
    j = caps()
    ok('Без _internal — подсказка «скопируйте папку целиком»', j['engine'] == 'exe' and any('_internal' in p for p in j['problems']), j['problems'])
    shutil.rmtree(app_dir / 'tools')
    # 4. tools\ рядом с папкой приложения, имя с версией: ..\tools\LesoLidar_v2\LesoLidar\LesoLidar.exe
    exe2 = fake_prog(TMP / 'tools' / 'LesoLidar_v2' / 'LesoLidar')
    j = caps()
    ok('Найдено в ..\\tools\\LesoLidar_v2\\LesoLidar\\', j['engine'] == 'exe' and Path(eng.exe) == exe2.resolve(), eng.exe)
    shutil.rmtree(TMP / 'tools')
    # 5. .env: путь к ПАПКЕ в кавычках, с комментарием
    prog = TMP / 'Program Files' / 'ЛесоЛидар 2'; exe3 = fake_prog(prog)
    (app_dir / '.env').write_text('# настройки\nDB_URL=sqlite://\nLESOLIDAR_EXE="%s"   # папка программы\n' % prog, encoding='utf-8')
    j = caps()
    ok('.env: папка в кавычках (пробелы, кириллица) — найдено', j['engine'] == 'exe' and Path(eng.exe) == exe3.resolve(), eng.exe)
    # 6. неверный путь в .env — понятная ошибка с этим путём (админу)
    (app_dir / '.env').write_text('LESOLIDAR_EXE=D:\\нет\\такой\\LesoLidar.exe\n', encoding='utf-8')
    j = caps()
    ok('.env: неверный путь — ошибка «там нет LesoLidar.exe» с путём', j['engine'] is None and any('там нет' in p and 'нет\\такой' in p for p in j['problems']), j['problems'][:1])
    ok('Подсказка показывает значение из .env', j['setup'] and 'такой' in (j['setup']['env_value'] or ''))
    # 7. старое (неверное) значение уже в окружении, .env исправили — перезапуск не нужен
    os.environ['LESOLIDAR_EXE'] = 'D:\\старое\\LesoLidar.exe'
    (app_dir / '.env').write_text('LESOLIDAR_EXE=%s\n' % (prog / 'LesoLidar.exe'), encoding='utf-8')
    j = caps()
    ok('.env исправлен при старом значении в окружении — найдено', j['engine'] == 'exe' and Path(eng.exe) == exe3.resolve(), eng.exe)
    # 8. значение только в окружении (системная переменная), .env без строки
    (app_dir / '.env').write_text('DB_URL=sqlite://\n', encoding='utf-8')
    os.environ['LESOLIDAR_EXE'] = str(prog)
    j = caps()
    ok('Системная переменная LESOLIDAR_EXE (папка) — найдено', j['engine'] == 'exe' and Path(eng.exe) == exe3.resolve(), eng.exe)
    # 9. «Проверить снова» (?recheck=1) у администратора — сразу, без ожидания; у пользователя — не форсирует
    os.environ.pop('LESOLIDAR_EXE')
    prog2 = TMP / 'LL3'; exe4 = fake_prog(prog2)
    (app_dir / '.env').write_text('LESOLIDAR_EXE=%s\n' % prog2, encoding='utf-8')
    eng._detect_at = time.time(); flags['admin'] = False
    c.get('/api/lesolidar/caps?recheck=1')
    ok('Пользователь: ?recheck=1 не запускает поиск раньше 3 с', Path(eng.exe) == exe3.resolve(), eng.exe)
    flags['admin'] = True
    j = c.get('/api/lesolidar/caps?recheck=1').json()
    ok('Администратор: «Проверить снова» — новый путь из .env сразу', j['engine'] == 'exe' and Path(eng.exe) == exe4.resolve(), eng.exe)
finally:
    shutil.rmtree(TMP, ignore_errors=True)
print('\nИТОГ: %d / %d' % (sum(R), len(R)) + ('  ALL OK' if all(R) else ''))
sys.exit(0 if all(R) else 1)
