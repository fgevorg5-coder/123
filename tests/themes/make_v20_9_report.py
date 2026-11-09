# -*- coding: utf-8 -*-
"""Отчёт v20.9 из результатов v20_9_ui_test.js: reports/v20.9_report.md и обзорные листы снимков
reports/v20.9_shots/sheet_main.jpg, sheet_panel.jpg, sheet_msg.jpg.
Запуск: python3 tests/themes/make_v20_9_report.py [папка reports]   (нужен Pillow)"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'src'))
from themes_def import THEMES            # noqa: E402
from contrast import rgba, blend, cr     # noqa: E402

REP = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(HERE, '..', '..', 'reports'))
SH = os.path.join(REP, 'v20.9_shots')
R = json.load(open(os.path.join(REP, 'v20.9_ui_report.json'), encoding='utf-8'))
NAMES = {'classic': 'Как сейчас'}
NAMES.update({t['id']: t['name'] for t in THEMES})
ORDER = ['classic'] + [t['id'] for t in THEMES]


def ratio(t, fg, bg):
    b, f = rgba(t[bg]), rgba(t[fg])
    base = rgba(t['s_bg'] if fg.startswith('s_') else t['bg'])[:3]
    bb = blend(b, base)
    return cr(blend(f, bb), bb)


def sheet(kind, cols=4, w=480):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    ims = [(i, os.path.join(SH, f'{i}_{kind}.jpg')) for i in ORDER if os.path.exists(os.path.join(SH, f'{i}_{kind}.jpg'))]
    if not ims:
        return None
    h = None; tiles = []
    for i, p in ims:
        im = Image.open(p).convert('RGB'); h = round(im.height * w / im.width)
        tiles.append((i, im.resize((w, h), Image.LANCZOS)))
    lab, gap = 30, 10
    rows = (len(tiles) + cols - 1) // cols
    W, H = cols * w + (cols + 1) * gap, rows * (h + lab) + (rows + 1) * gap
    out = Image.new('RGB', (W, H), (29, 31, 30)); dr = ImageDraw.Draw(out)
    font = None
    for fp in ('/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf', '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf',
               'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        try:
            font = ImageFont.truetype(fp, 17); break
        except OSError:
            pass
    for k, (i, im) in enumerate(tiles):
        x, y = gap + (k % cols) * (w + gap), gap + (k // cols) * (h + lab + gap)
        dr.text((x + 2, y + 5), f'{NAMES.get(i, i)}  ·  ?gt={i}', fill=(235, 240, 236), font=font)
        out.paste(im, (x, y + lab))
    name = f'sheet_{kind}.jpg'
    out.save(os.path.join(SH, name), quality=82, optimize=True)
    return name


def md():
    T = R['themes']; L = []
    ok = R['failed'] == 0
    L += [f"# Геосервис v20.9 — отчёт UI-теста", '',
          f"Стенд: настоящий `app.py` ({R['base']}), Chromium 1600×900, дата {R['date'][:16].replace('T', ' ')} UTC.  ",
          f"**Итог: {R['passed']} из {R['total']} проверок {'пройдены ✓' if ok else '— есть непройденные ✗'}.**", '']
    groups = []
    for c in R['checks']:
        if c['group'] not in groups:
            groups.append(c['group'])
    titles = {'Аватар': '1. Один аватар на всех страницах', 'Темы': '2. Темы оформления (10 + «Как сейчас»)',
              'Синхр.': '3. Сохранение и синхронизация вкладок', 'Окно': '4. Окно «Оформление»', 'Файлы': '5. Файлы'}
    for g in groups:
        L += [f"## {titles.get(g, g)}", '']
        if g == 'Темы':
            L += ['Контраст — число мест, где текст/значок не дотягивает до WCAG (4,5:1 обычный текст, 3:1 крупный и значки). '
                  '«До» — страж контраста выключен (что даёт сама тема), «после» — включён (по умолчанию). '
                  'Наведение — пункты с проблемой / проверено пунктов.', '',
                  '| Тема | Главная до → после | «Сообщения» до → после | Меню профиля (наведение) | Кнопки карты (наведение) | Панель «Подложка» | Окно заявления | Ошибки JS |',
                  '|---|---|---|---|---|---|---|---|']
            for i in ORDER:
                if i not in T:
                    continue
                t = T[i]
                L.append(f"| {NAMES.get(i, i)} (`{i}`) | {t['main_before']} → **{t['main_after']}** | {t['msg_before']} → **{t['msg_after']}** | "
                         f"{t['menu_hover']} | {t['mib_hover']} | {t['panel_after']} | {t['vacancy_after']} | {t['errors']} |")
            L += ['', 'Что остаётся «до стража» и почему:', '',
                  '* «Как сейчас», главная — подсказка в поле поиска (на стенде нет style.css прода, в проде цвет может быть другим).',
                  '* «Как сейчас», «Сообщения» — заголовок и подписи списка диалогов на стенде без design-system-v15 (белое на светлом).',
                  '* Все темы, «Сообщения» — 1 место: белая буква/цифра на оранжевом аватаре собеседника (палитра messages.js, 2,74:1). '
                  'Это цвет аватара человека, а не темы; страж затемняет букву только у таких аватаров.', '']
        L += ['| | Проверка | Подробности |', '|---|---|---|']
        for c in R['checks']:
            if c['group'] != g:
                continue
            info = c['info']
            if isinstance(info, (dict, list)):
                info = json.dumps(info, ensure_ascii=False)
            info = '' if info in (None, '', '[]', '{}') else str(info)
            if c['ok'] and len(info) > 140:
                info = info[:140] + '…'
            L.append(f"| {'✓' if c['ok'] else '✗'} | {c['name']} | {info.replace('|', '¦')} |")
        L.append('')
    # палитры
    L += ['## 6. Контраст палитр (расчёт по WCAG, `tests/themes/src/check_themes.py`)', '',
          'Отношение яркостей для основных пар цветов каждой темы (норма: текст ≥ 7 для основного, ≥ 4,5 для остального).', '',
          '| Тема | Шрифт | Текст / панель | Вторичный / панель | Акцент / панель | Текст кнопки | Наведение | Боковая: текст | Кнопки карты |',
          '|---|---|---|---|---|---|---|---|---|']
    for t in THEMES:
        v = [ratio(t, 'ink', 'card'), ratio(t, 'muted', 'card'), ratio(t, 'accent', 'card'), ratio(t, 'on', 'fill'),
             ratio(t, 'hover_ink', 'hover'), ratio(t, 's_ink', 's_bg'), ratio(t, 'c_ink', 'c_bg')]
        L.append(f"| {t['name']} | {t['fontName']} | " + ' | '.join(f'{x:.1f}' for x in v) + ' |')
    try:
        out = subprocess.run([sys.executable, os.path.join(HERE, 'src', 'check_themes.py')], capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception as e:                     # noqa: BLE001
        out = f'не запустился: {e}'
    L += ['', 'Полная проверка всех пар (минимум по теме):', '', '```', out, '```', '']
    sheets = [s for s in (sheet('main'), sheet('panel'), sheet('msg')) if s]
    if sheets:
        L += ['## 7. Снимки', '', 'Папка `v20.9_shots/`: `<тема>_main.jpg` (главная + меню профиля), `<тема>_panel.jpg` (панель «Подложка карты»), '
              '`<тема>_msg.jpg` («Сообщения»), `window_*.jpg` (окно «Оформление»), `*_vacancy.jpg` (окно заявления), `av_main_*.jpg` (аватар до/после смены рамки).', '']
        L += [f'![{s}](v20.9_shots/{s})' for s in sheets] + ['']
    return '\n'.join(L)


if __name__ == '__main__':
    text = md()
    open(os.path.join(REP, 'v20.9_report.md'), 'w', encoding='utf-8').write(text)
    print('записано:', os.path.join(REP, 'v20.9_report.md'), '·', R['passed'], '/', R['total'])
