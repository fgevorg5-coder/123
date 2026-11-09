# -*- coding: utf-8 -*-
"""v20.10 — тесты сервера веб-редакций методичек (manuals_editor_api.py).
Запуск:  python tests/manuals_editor/test_manuals_editor_api.py      → в конце «ALL OK»
Нужны: fastapi, httpx (для TestClient). Данные — во временной папке, рабочие не трогаются."""
import json, os, sys, tempfile, threading
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..', 'geoservice')))
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
import manuals_editor_api as M

RESULTS = []
def ok(name, cond, info=''):
    RESULTS.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (' — ' + str(info) if info else ''))

def require_admin(request: Request):
    if request.headers.get('X-Test-Admin') != '1':
        raise HTTPException(401, 'Требуется авторизация', headers={'X-Admin-Stepup': '1'})
    return 'admin'
def verify_csrf(request: Request):
    if request.method not in ('GET', 'HEAD') and request.headers.get('X-CSRFToken') != 'tok':
        raise HTTPException(403, 'CSRF-токен недействителен')

def make(tmp, **env):
    for k, v in env.items(): os.environ[k] = str(v)
    app = FastAPI()
    app.include_router(M.build_router(base_dir=tmp, require_admin=require_admin, verify_csrf=verify_csrf))
    for k in env: os.environ.pop(k, None)
    return TestClient(app)

ADM = {'X-Test-Admin': '1', 'X-CSRFToken': 'tok', 'Content-Type': 'application/json'}
def put(c, fid, html, base, hdr=ADM, **kw):
    body = {'html': html, 'title': 'Гайд 1', 'source_ver': '1', 'base_revision': base}; body.update(kw)
    return c.put('/api/manuals-editions/' + fid, headers=hdr, content=json.dumps(body))

def main():
    tmp = tempfile.mkdtemp(prefix='mned_')
    c = make(tmp)
    r = c.get('/api/manuals-editions/_status')
    ok('_status: сервер редакций готов', r.status_code == 200 and r.json().get('ready') is True, r.text[:80])
    r = c.get('/api/manuals-editions/g1f01')
    ok('GET без редакций → revision 0, html null (страница считает сервер подключённым)', r.status_code == 200 and r.json()['revision'] == 0 and r.json()['html'] is None, r.text[:120])
    ok('GET: Cache-Control no-store', r.headers.get('cache-control') == 'no-store')
    r = put(c, 'g1f01', '<p>x</p>', 0, hdr={'Content-Type': 'application/json'})
    ok('PUT без администратора → 401 (+ X-Admin-Stepup)', r.status_code == 401 and r.headers.get('x-admin-stepup') == '1', r.status_code)
    r = put(c, 'g1f01', '<p>x</p>', 0, hdr={'X-Test-Admin': '1', 'Content-Type': 'application/json'})
    ok('PUT без CSRF-токена → 403', r.status_code == 403, r.status_code)
    evil = ('<h1 onclick="alert(1)">Заголовок</h1><script>alert(1)</script><p style="color:red;background:url(javascript:alert(1));font-size:14px">'
            'Текст &lt;script&gt; <a href="javascript:alert(1)">плохая</a> <a href="JaVaScRiPt:alert(2)">плохая2</a> '
            '<a href="%6Aavascript:alert(3)">плохая3</a> <a href="//evil.example/x">плохая4</a> <a href="https://belgiproles.by/">хорошая</a></p>'
            '<img src="x" onerror="alert(1)"><img src="https://evil.example/a.png"><img src="data:image/png;base64,iVBORw0KGgo=" alt="рис">'
            '<svg><script>alert(1)</script><a href="#">svg</a></svg><iframe src="https://evil.example"></iframe><style>body{display:none}</style>'
            '<!-- комментарий --><table><tr><td colspan="2" onmouseover="x()">ячейка</td></tr></table><form><p>в форме</p></form>'
            '<div><b>незакрытый <i>тег</div><unknown-tag>содержимое</unknown-tag></p></p>')
    r = put(c, 'g1f01', evil, 0)
    ok('PUT администратора → редакция 1', r.status_code == 200 and r.json()['revision'] == 1, r.text[:160])
    h = r.json().get('html', '')
    bad = [s for s in ('<script', 'onclick', 'onerror', 'onmouseover', 'javascript', 'JaVaScRiPt', '%6Aavascript', 'evil.example', '<svg', '<iframe', '<style', '<!--', 'в форме', 'url(') if s in h]
    ok('Очистка HTML: скрипты, on*-обработчики, javascript:/внешние ссылки и картинки, svg/iframe/style/form удалены', not bad, 'осталось: ' + ', '.join(bad) if bad else '')
    need = [s for s in ('<h1>Заголовок</h1>', 'color: red', 'font-size: 14px', '&lt;script&gt;', 'href="https://belgiproles.by/" rel="noopener noreferrer" target="_blank"',
                        'src="data:image/png;base64,iVBORw0KGgo=" alt="рис"', 'colspan="2"', 'ячейка', 'содержимое') if s not in h]
    ok('Очистка HTML: разрешённая разметка, стили, data:-картинки и ссылки https сохранены', not need, 'нет: ' + ' | '.join(need) if need else '')
    ok('Очистка HTML: незакрытые теги закрыты, лишние </p> отброшены', h.count('<div>') == h.count('</div>') and h.count('<b>') == h.count('</b>') and h.count('<i>') == h.count('</i>') and h.count('</p>') == h.count('<p') , h[-160:])
    r = c.get('/api/manuals-editions/g1f01')
    ok('GET после сохранения → редакция 1 для всех (без входа)', r.status_code == 200 and r.json()['revision'] == 1 and r.json()['html'] == h and r.json()['source_ver'] == '1' and r.json()['saved_at'])
    r = put(c, 'g1f01', '<p>правка из другого окна</p>', 0)
    ok('PUT с устаревшей base_revision → 409 (правки из другого окна не затираются)', r.status_code == 409 and 'редакция 1' in r.json().get('detail', ''), r.text[:160])
    r = put(c, 'g1f01', '<p>Вторая редакция</p>', 1, source_ver='2')
    ok('PUT base_revision=1 → редакция 2', r.status_code == 200 and r.json()['revision'] == 2 and r.json()['source_ver'] == '2')
    r = c.get('/api/manuals-editions/g1f01/history')
    ok('История без администратора → 401', r.status_code == 401)
    r = c.get('/api/manuals-editions/g1f01/history', headers=ADM)
    ok('История: новые сверху [2, 1]', r.status_code == 200 and [x['revision'] for x in r.json()['items']] == [2, 1] and all(x['saved_at'] for x in r.json()['items']), r.text[:160])
    r = c.get('/api/manuals-editions/g1f01/revisions/1', headers=ADM)
    ok('Редакция 1 доступна для восстановления', r.status_code == 200 and r.json()['revision'] == 1 and r.json()['html'] == h)
    r = c.get('/api/manuals-editions/g1f01/revisions/9', headers=ADM)
    ok('Несуществующая редакция → 404', r.status_code == 404)
    for fid in ('..', '.hidden', 'a/b', 'a\\b', 'x' * 200, '%2e%2e'):
        r = c.get('/api/manuals-editions/' + fid)
        if r.status_code not in (400, 404, 405, 422): ok('Недопустимый идентификатор ' + fid, False, r.status_code); break
    else: ok('Недопустимые идентификаторы файла (.., /, \\, длинные) отклоняются', True)
    ok('Файлы редакций лежат в instance/manuals_editions/<fid>/', sorted(os.listdir(os.path.join(tmp, 'instance', 'manuals_editions', 'g1f01'))) == ['index.json', 'r000001.json', 'r000002.json'],
       os.listdir(os.path.join(tmp, 'instance', 'manuals_editions', 'g1f01')))
    r = put(c, 'g1f02', '<p> </p><p>&nbsp;</p>', 0)
    ok('Пустая редакция не сохраняется (400)', r.status_code == 400, r.text[:100])
    r = c.put('/api/manuals-editions/g1f02', headers=ADM, content='не json')
    ok('Не JSON → 400', r.status_code == 400)
    # лимиты: размер и число хранимых редакций
    c2 = make(tempfile.mkdtemp(prefix='mned2_'), MANUALS_EDITION_MAX_MB=1, MANUALS_EDITIONS_KEEP=3)
    big = '<p>' + 'я' * (1100 * 1024) + '</p>'
    r = put(c2, 'big', big, 0)
    ok('Редакция больше MANUALS_EDITION_MAX_MB → 413', r.status_code == 413, r.status_code)
    for i in range(5): put(c2, 'k', '<p>редакция %d</p>' % (i + 1), i)
    r = c2.get('/api/manuals-editions/k/history', headers=ADM)
    ok('MANUALS_EDITIONS_KEEP=3: хранятся три последние редакции', [x['revision'] for x in r.json()['items']] == [5, 4, 3], r.text[:120])
    # гонка: два окна сохраняют одновременно от одной редакции
    res = []
    def w(t): res.append(put(c, 'race', '<p>%s</p>' % t, 0).status_code)
    th = [threading.Thread(target=w, args=('окно %d' % i,)) for i in range(4)]
    [t.start() for t in th]; [t.join() for t in th]
    ok('Одновременное сохранение из 4 окон: одно принято, остальные 409', sorted(res) == [200, 409, 409, 409], res)
    n = sum(1 for x in RESULTS if x[1])
    print('\nИТОГ: %d / %d' % (n, len(RESULTS)))
    print('ALL OK' if n == len(RESULTS) else 'FAILED')
    return 0 if n == len(RESULTS) else 1

if __name__ == '__main__':
    sys.exit(main())
