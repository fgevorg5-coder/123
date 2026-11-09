# -*- coding: utf-8 -*-
"""Проверка установки Геосервиса v20.10 (и всех файлов v20.3–v20.10).

Запуск в папке приложения (рядом с app.py):
    python check_install_v20.10.py                          — файлы на диске (+ где ищется LesoLidar.exe)
    python check_install_v20.10.py --url http://127.0.0.1:8000   — ещё и работающий сервер (редакции методичек, ЛесоЛидар, статика)
    python check_install_v20.10.py --url https://portal --cookie "session=…"   — если API требует входа
Ничего не меняет, только читает."""
import argparse, importlib.util, json, os, re, sys, urllib.request, urllib.error

VER = '20.10'
SERVER_VER = '20.7'      # georef_api.py с v20.7 не менялся — /api/georef/caps по-прежнему сообщает 20.7
THEMES = ['bor', 'graphite', 'white', 'navy', 'gis', 'contrast', 'field', 'swiss', 'taiga', 'gov']
# шаблоны, где в <head> подключается ранний запуск темы (v20.9)
BOOT_TEMPLATES = ['index.html', 'messages.html', 'manuals.html', 'login.html', 'admin_users.html', 'diag.html',
                  'maintenance.html', 'frozen.html', 'blacklisted.html']
# файл → (версия, метка в тексте или None, что даёт)
FILES = [
    ('manuals_editor_api.py',         '20.10', 'VERSION = "20.10"',       'сервер редакций методичек (/api/manuals-editions)'),
    ('app.py',                        '20.10', 'manuals_editor_api',      'подключение сервера редакций методичек'),
    ('security_hardening.py',         '20.10', '/api/manuals-editions/',  'лимит размера редакции методички'),
    ('lesolidar_bridge.py',           '20.10', 'def setup_hint',          'ЛесоЛидар: поиск программы без перезапуска, подсказка администратору'),
    ('static/panel-timeline.js',      '20.10', "var VER = '20.10'",       '«Съёмка по годам»: снимок грузится при приближении, крупная шкала, A−/A+'),
    ('static/map-core.js',            '20.10', '[v20.10]',                'внешние слои ДЗЗ с именем слоя (снимки из «Съёмки по годам»)'),
    ('static/lesolidar-web.js',       '20.10', 'data-b="recheck"',        'ЛесоЛидар: «Проверить снова», путь для программы'),
    ('static/manuals-workspace.js',   '20.10', 'apiError',                '«Методички»: понятная причина, если сервер редакций не отвечает'),
    ('static/themes/gt-boot.js',      '20.9', 'GT_BOOT',                  'тема ставится до первой отрисовки (без мигания)'),
    ('static/themes/gt.js',           '20.9', 'window.GeoTheme',          'окно «Оформление» (Alt+Shift+T) и «Страж контраста»'),
    ('static/themes/gt-core.css',     '20.9', '.gt-ov',                   'окно «Оформление» и общие правила тем'),
    ('static/themes/gt-fonts.css',    '20.9', '@font-face',               'шрифты тем (свои файлы, интернет не нужен)'),
    ('static/themes/fonts/OFL.txt',   '20.9', 'OPEN FONT LICENSE',        'лицензия шрифтов (SIL OFL 1.1)'),
] + [('static/themes/gt-%s.css' % t,  '20.9', 'html[data-gt="%s"]' % t,   'тема «%s»' % t) for t in THEMES] + [
    ('static/avatar-sync.js',         '20.9', "VER = '20.9'",             'один аватар на всех страницах (фото, рамка, эмодзи)'),
    ('static/avatar-sync.css',        '20.9', '.gav',                     'вид аватара и рамок на главной'),
    ('static/profile-v18.js',         '20.9', 'avPublish',                'профиль в «Сообщениях» сообщает об изменении аватара'),
    ('templates/index.html',          '20.9', 'data-gt-open',             'пункт «Оформление» в меню профиля'),
    ('templates/index.html',          '20.9', 'avatar-sync.js',           'аватар из профиля «Сообщений»'),
    ('templates/messages.html',       '20.9', 'GeoTheme.open',            '«Сообщения»: пункт «Оформление»'),
    ('templates/messages.html',       '20.9', 'avatar-sync.js',           '«Сообщения»: синхронизация аватара'),
    ('static/dzz-extent.js',          '20.8', "version: '20.8'",          'настоящий охват снимков ДЗЗ из GeoServer («Приблизить к слою», поиск)'),
    ('static/map-core.js',            '20.8', 'DzzExtent.zoomToSearchItem', 'поиск снимков и лесхозов без ошибочного приближения'),
    ('templates/index.html',          '20.8', 'dzz-extent.js',            'подключение dzz-extent.js'),
    ('georef_api.py',                 '20.7', 'SERVER_VERSION = "20.7"', 'API «План/Растр/MBTiles», сдвиги, /api/crs-shift/raster/…'),
    ('georef_shift.py',               '20.7', "'mb2tif'",                 '«Переместить» для «MBTiles → TIFF»'),
    ('georef_runner.py',              '20.3', None,                       'запуск заданий georef'),
    ('jobkit.py',                     '20.3', None,                       'очередь заданий'),
    ('tools/georef/mbtiles_shift.py', '20.7', 'def shift_tiles',            'сдвиг MBTiles целиком (новый файл)'),
    ('tools/georef/mbtiles2tif.py',   '20.7', '--shift',                  'MBTiles → GeoTIFF со сдвигом'),
    ('tools/georef/tif2mbtiles.py',   '20.3', None,                       'Растр → MBTiles'),
    ('static/panel-georef.js',        '20.7', "CLIENT_VER = '20.7'",      'кнопки «Переместить» во вкладках MBTiles'),
    ('static/panel-crs.js',           '20.7', '/api/crs-shift/raster/',   '«Смена СК»: сохранение сдвига растров'),
    ('static/header-scene.js',        '20.6', 'OffscreenCanvas',          'шапка без рывков'),
    ('templates/index.html',          '20.6', 'bgl-emblem-css',           'значок «Белгослес» (v20.6)'),
    ('preview_page.py',               '20.5', None,                       'страница предпросмотра'),
    ('static/preview/preview.js',     '20.5', None,                       'предпросмотр'),
]
OK, BAD, WARN = '  ✓ ', '  ✗ ', '  ! '
bad = []


def out(s=''):
    try:
        print(s)
    except UnicodeEncodeError:
        print(s.encode(sys.stdout.encoding or 'ascii', 'replace').decode(sys.stdout.encoding or 'ascii'))


def read(p):
    try:
        with open(p, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description='Проверка установки Геосервиса v' + VER)
    ap.add_argument('--root', default=os.path.dirname(os.path.abspath(__file__)), help='папка приложения (где app.py)')
    ap.add_argument('--url', help='адрес работающего приложения, например http://127.0.0.1:8000')
    ap.add_argument('--cookie', default='', help='Cookie для запросов (если API требует входа)')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    out(f'Геосервис v{VER}: проверка установки\nПапка: {root}\n')
    if not os.path.isfile(os.path.join(root, 'app.py')):
        out(BAD + 'рядом нет app.py — запустите скрипт из папки приложения или укажите --root')
        bad.append('app.py')
    nested = os.path.join(root, 'geoservice')
    if os.path.isdir(nested) and any(os.path.exists(os.path.join(nested, n)) for n in ('georef_api.py', 'static', 'tools')):
        out(WARN + 'есть вложенная папка geoservice\\ с файлами пакета — её содержимое нужно было скопировать В КОРЕНЬ '
                   'приложения (рядом с app.py), а не папкой. Перенесите файлы на уровень выше и удалите вложенную папку.')
        bad.append('вложенная geoservice')
    out('Файлы:')
    for rel, ver, mark, what in FILES:
        p = os.path.join(root, *rel.split('/'))
        t = read(p)
        if t is None:
            out(f'{BAD}{rel:32} нет файла (нужен с v{ver}: {what})'); bad.append(rel)
        elif mark and mark not in t:
            out(f'{BAD}{rel:32} старая версия — нет признака v{ver} ({what})'); bad.append(rel)
        else:
            out(f'{OK}{rel:32} v{ver}+ · {what}')
    # v20.9: ранний запуск темы во всех страницах и все шрифты из gt-fonts.css на месте
    miss = [n for n in BOOT_TEMPLATES if 'themes/gt-boot.js' not in (read(os.path.join(root, 'templates', n)) or '')]
    if miss:
        out(f'{BAD}шаблоны без gt-boot.js: {", ".join(miss)} — замените файлы templates из пакета'); bad.append('templates (gt-boot)')
    else:
        out(f'{OK}gt-boot.js подключён во всех {len(BOOT_TEMPLATES)} шаблонах')
    css = read(os.path.join(root, 'static', 'themes', 'gt-fonts.css')) or ''
    urls = re.findall(r'url\("([^"?#]+)', css)
    lost = []
    for u in urls:
        p = os.path.join(root, *u.lstrip('/').split('/')) if u.startswith('/') else os.path.join(root, 'static', 'themes', *u.split('/'))
        if not os.path.isfile(p):
            lost.append(u)
    if urls and not lost:
        out(f'{OK}шрифты тем: все {len(urls)} файлов на месте (static/themes/fonts, static/fonts)')
    elif urls:
        out(f'{BAD}нет файлов шрифтов: {len(lost)} из {len(urls)} (например {lost[0]}) — скопируйте static/themes/fonts целиком'); bad.append('fonts')
    check_lesolidar(root)
    out('\nПакеты Python (для tools/georef, в том Python, которым запущен этот скрипт):')
    for mod, pip in (('numpy', 'numpy'), ('rasterio', 'rasterio'), ('PIL', 'pillow'), ('pyproj', 'pyproj')):
        found = importlib.util.find_spec(mod) is not None
        out((OK if found else WARN) + mod + ('' if found else f' — не найден (pip install {pip}); если приложение работает в другом venv — проверьте там'))
    if a.url:
        check_server(a.url.rstrip('/'), a.cookie)
    out('\nИтог: ' + ('всё на месте ✓' if not bad else 'нужно исправить: ' + ', '.join(bad)))
    if not a.url:
        out('Проверка сервера: python check_install_v20.10.py --url http://127.0.0.1:<порт>  (или откройте в браузере <адрес>/api/manuals-editions/_status — должно быть «ready»: true, «version»: «20.10»)')
    return 1 if bad else 0


def check_lesolidar(root):
    """v20.10: где лежит LesoLidar.exe (та же логика поиска, что у приложения)."""
    out('\nЛесоЛидар (программа обработки облаков, в пакет не входит):')
    sys.path.insert(0, root)
    try:
        import lesolidar_bridge as lb
        e = lb.Engine(root)
    except Exception as ex:                      # другой Python без fastapi — проверим основные места сами
        e = None
        out(WARN + f'lesolidar_bridge не загружен этим Python ({ex.__class__.__name__}) — проверяю основные места')
    if e is not None and e.exe:
        has_int = os.path.isdir(os.path.join(str(e.exe.parent), '_internal'))
        out((OK if has_int else BAD) + f'найден {e.exe}' + ('' if has_int else ' — рядом НЕТ папки _internal: скопируйте папку программы целиком'))
        if not has_int:
            bad.append('LesoLidar _internal')
        return
    if e is not None and e.python:
        out(OK + f'LESOLIDAR_PYTHON = {e.python} (Linux/стенд)'); return
    places = [os.path.join(root, 'tools', 'LesoLidar', 'LesoLidar.exe'), os.path.join(root, 'tools', 'LesoLidar', 'LesoLidar', 'LesoLidar.exe')]
    if e is None and any(os.path.isfile(p) for p in places):
        out(OK + 'найден ' + next(p for p in places if os.path.isfile(p))); return
    out(WARN + 'LesoLidar.exe не найден — «ЛесоЛидар» покажет «Не настроен». Скопируйте папку программы целиком '
               '(LesoLidar.exe + _internal, models, tables) так, чтобы был файл')
    out('      ' + places[0])
    out('      или впишите в ' + os.path.join(root, '.env') + ' строку LESOLIDAR_EXE=полный\\путь\\LesoLidar.exe')
    if e is not None and getattr(e, 'env_value', ''):
        out(WARN + f'сейчас LESOLIDAR_EXE = «{e.env_value}» — там нет LesoLidar.exe')
    out('      Перезапуск не нужен: «ЛесоЛидар» → «Проверить снова» (под администратором). Подробно — README_DEPLOY_RU, «ЛесоЛидар».')


def get(url, cookie, method='GET'):
    rq = urllib.request.Request(url, method=method, headers={'Cookie': cookie} if cookie else {})
    try:
        with urllib.request.urlopen(rq, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:                      # нет соединения
        return 0, str(e).encode()


def check_server(base, cookie):
    out(f'\nСервер {base}:')
    # v20.10 — сервер редакций методичек и ЛесоЛидар
    st, b = get(base + '/api/manuals-editions/_status', cookie)
    try:
        js = json.loads(b) if st == 200 else {}
    except ValueError:
        js = {}
    if js.get('ready') and js.get('version') == VER:
        out(f'{OK}/api/manuals-editions/_status: сервер редакций методичек v{js.get("version")} подключён (до {js.get("max_mb")} МБ)')
    elif st == 200 and js.get('ready'):
        out(f'{BAD}сервер редакций методичек v{js.get("version")} — замените manuals_editor_api.py и перезапустите'); bad.append('manuals_editor_api (сервер)')
    else:
        out(f'{BAD}/api/manuals-editions/_status → HTTP {st} — manuals_editor_api.py не подключён: положите его рядом с app.py '
            '(app.py v20.10) и ПЕРЕЗАПУСТИТЕ приложение; причина — в журнале запуска'); bad.append('manuals_editor_api (сервер)')
    st, b = get(base + '/api/lesolidar/caps', cookie)
    try:
        lc = json.loads(b) if st == 200 else None
    except ValueError:
        lc = None
    if lc is None:
        out(f'{WARN}/api/lesolidar/caps → HTTP {st}')
    elif lc.get('available'):
        out(f'{OK}ЛесоЛидар готов' + (f' ({lc.get("engine_path")})' if lc.get('engine_path') else ''))
    else:
        out(f'{WARN}ЛесоЛидар не настроен: ' + '; '.join(lc.get('problems') or ['обработчик не найден']))
        if (lc.get('setup') or {}).get('exe'):
            out(f'      нужен файл {lc["setup"]["exe"]} (или LESOLIDAR_EXE в {lc["setup"]["env_file"]})')
    for rel, mark, what in (('/static/panel-timeline.js', b"var VER = '20.10'", '«Съёмка по годам» v20.10'),
                            ('/static/map-core.js', b'[v20.10]', 'карта: снимки ДЗЗ с именем слоя'),
                            ('/static/lesolidar-web.js', b'data-b="recheck"', 'ЛесоЛидар: «Проверить снова»'),
                            ('/static/manuals-workspace.js', b'apiError', '«Методички»: причина ошибки сервера редакций')):
        st, b = get(base + rel, cookie)
        if st == 200 and mark in b:
            out(f'{OK}сервер отдаёт {rel} v20.10 · {what}')
        elif st == 200:
            out(f'{BAD}сервер отдаёт старый {rel} — файл не заменён или кэш nginx; Ctrl+F5 в браузере'); bad.append(rel + ' (сервер)')
        else:
            out(f'{BAD}{rel} → HTTP {st}'); bad.append(rel + ' (сервер)')
    st, b = get(base + '/api/georef/caps', cookie)
    if st != 200:
        out(f'{BAD}/api/georef/caps → HTTP {st} {b[:120].decode("utf-8", "replace")}'
            + (' — нужен вход: передайте --cookie или откройте адрес в браузере' if st in (401, 403, 302) else ''))
        bad.append('caps'); return
    try:
        c = json.loads(b)
    except ValueError:
        out(BAD + '/api/georef/caps — не JSON (вход в систему?)'); bad.append('caps'); return
    v = c.get('version')
    if v in (SERVER_VER, VER):
        out(f'{OK}caps.version = {v}')
    else:
        out(f'{BAD}caps.version = {v or "нет (модули старее v20.7)"} — скопируйте .py-файлы и tools/georef из пакета и ПЕРЕЗАПУСТИТЕ приложение (нужны модули v{SERVER_VER})')
        bad.append('caps.version')
    kinds = c.get('shift_kinds') or []
    out((OK if 'mb2tif' in kinds else BAD) + 'сдвиг для вкладок: ' + (', '.join(kinds) or 'нет'))
    if 'mb2tif' not in kinds:
        bad.append('shift_kinds')
    tools = c.get('shift_tools') or {}
    if tools:
        miss = [k for k, x in tools.items() if not x]
        out((OK if not miss else BAD) + 'инструменты сдвига: ' + ', '.join(f'{k} {"✓" if x else "✗"}' for k, x in tools.items()))
        if miss:
            bad.append('shift_tools')
    for p in c.get('problems') or []:
        out(WARN + 'сервер сообщает: ' + str(p))
    st, b = get(base + '/api/crs-shift/raster/check-install/items/all', cookie)
    if st == 200 and b'"raster"' in b:
        out(OK + '/api/crs-shift/raster/… — маршруты сохранения растров «Смены СК» подключены')
    else:
        out(f'{BAD}/api/crs-shift/raster/… → HTTP {st} — georef_api.py v20.7 не загружен (перезапустите приложение)')
        bad.append('crs-shift/raster')
    st, b = get(base + '/static/panel-georef.js', cookie)
    if st == 200:
        m = re.search(rb"CLIENT_VER = '([\d.]+)'", b)
        cv = m.group(1).decode() if m else '?'
        out((OK if cv == SERVER_VER else BAD) + f'сервер отдаёт panel-georef.js v{cv}' + ('' if cv == SERVER_VER else ' — замените static/panel-georef.js'))
        if cv != SERVER_VER:
            bad.append('panel-georef.js (сервер)')
    else:
        out(f'{WARN}/static/panel-georef.js → HTTP {st}')
    # v20.9 — оформление и аватар (то, что реально получает браузер)
    for rel, mark, what in (('/static/themes/gt-boot.js', b'GT_BOOT', 'ранний запуск темы'),
                            ('/static/themes/gt.js', b'window.GeoTheme', 'окно «Оформление», страж контраста'),
                            ('/static/themes/gt-core.css', b'.gt-ov', 'стили окна'),
                            ('/static/themes/gt-bor.css', b'html[data-gt="bor"]', 'тема «Бор»'),
                            ('/static/avatar-sync.js', b"VER = '20.9'", 'аватар')):
        st, b = get(base + rel, cookie)
        if st == 200 and mark in b:
            out(f'{OK}сервер отдаёт {rel} v20.9 · {what}')
        elif st == 200:
            out(f'{BAD}сервер отдаёт старый {rel} — файл не заменён или кэш nginx; Ctrl+F5 в браузере'); bad.append(rel + ' (сервер)')
        else:
            out(f'{BAD}{rel} → HTTP {st} — нет папки static/themes или файла'); bad.append(rel + ' (сервер)')
    st, b = get(base + '/static/themes/fonts/golos-text-cyrillic-400.woff2', cookie)
    out((OK if st == 200 and len(b) > 1000 else BAD) + f'шрифт темы /static/themes/fonts/golos-text-cyrillic-400.woff2 → HTTP {st}, {len(b)} байт')
    if not (st == 200 and len(b) > 1000):
        bad.append('fonts (сервер)')
    st, b = get(base + '/login', cookie)
    if st == 200 and b'themes/gt-boot.js' in b:
        out(OK + 'страница входа подключает gt-boot.js (шаблоны v20.9 загружены)')
    elif st == 200:
        out(f'{BAD}страница входа без gt-boot.js — шаблоны не заменены (или приложение кэширует шаблоны: перезапустите)'); bad.append('templates (сервер)')
    else:
        out(f'{WARN}/login → HTTP {st}')
    # v20.8 — статика ДЗЗ (то, что реально получает браузер)
    for rel, mark, what in (('/static/dzz-extent.js', b"version: '20.8'", 'охват снимков ДЗЗ'),
                            ('/static/map-core.js', b'DzzExtent.zoomToSearchItem', 'карта (поиск снимков)')):
        st, b = get(base + rel, cookie)
        if st == 200 and mark in b:
            out(f'{OK}сервер отдаёт {rel} v20.8 · {what}')
        elif st == 200:
            out(f'{BAD}сервер отдаёт старый {rel} — файл не заменён или кэш nginx; Ctrl+F5 в браузере'); bad.append(rel + ' (сервер)')
        else:
            out(f'{BAD}{rel} → HTTP {st}'); bad.append(rel + ' (сервер)')


if __name__ == '__main__':
    sys.exit(main())
