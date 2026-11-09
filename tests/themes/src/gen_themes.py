# -*- coding: utf-8 -*-
"""Генератор static/themes/* для Геосервиса v20.9: gt-<id>.css, gt-core.css, gt-fonts.css, gt-boot.js, gt.js.
Источник тем — themes_def.py. Запуск: python3 gen_themes.py <каталог static/themes>"""
import sys, os, json, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from themes_def import THEMES, F, MONO
SRC = os.path.dirname(os.path.abspath(__file__))
# по умолчанию — geoservice/static/themes пакета (tests/themes/src → ../../../geoservice/static/themes)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(SRC, '..', '..', '..', 'geoservice', 'static', 'themes'))
P = 'html[data-gt][data-gt][lang]'
SKIP = {'id', 'name', 'tag', 'desc', 'fontName', 'labels', 'plates'}
FORCED = {  # темы, где размер кнопок карты — часть стиля (иначе действует настройка пользователя)
    'contrast': dict(mib=48, icon=24, nav=42, navicon=22),
    'field': dict(mib=52, icon=24, nav=44, navicon=22),
    'gis': dict(mib=64, icon=20, nav=32, navicon=18),
}
EXTRA = {
 'white': '{T}{{--gt-lmix:72%;--gt-lmix2:90%}}\n',
 'gis': '{T}{{--gt-lmix:100%;--gt-lmix2:100%}}\n'
        '{T} body .sidebar .forest-header{{border-bottom:1px solid #1c2a38!important}}\n'
        '{T} body #map-icon-bar{{border-radius:var(--gt-r)!important}}\n',
 'contrast': '{T}{{--gt-lmix:100%;--gt-lmix2:100%}}\n'
        '{T} body a:not([class]){{text-decoration:underline!important}}\n'
        '{T} body #map-icon-bar>button.mib-btn{{box-shadow:inset 0 0 0 2px transparent!important}}\n'
        '{T} body #map-icon-bar>button.mib-btn:hover{{box-shadow:inset 0 0 0 2px #ffffff!important}}\n'
        '{T} body :is(#sf-profile-menu .sf-profile-menu-item,.tpm-item,.lsr-item,.dialog-item):is(:hover,:focus-visible){{outline:2px solid #ffffff!important;outline-offset:-2px!important}}\n',
 'swiss': '{T} body .sidebar .forest-header{{border-bottom:2px solid #111111!important}}\n'
        '{T} body .sidebar .fh-title{{font-weight:800!important;letter-spacing:-.01em!important}}\n'
        '{T} body :is(#map-icon-bar,#map-nav-group,#coords-panel,#map-slide-panel,#sf-profile-menu,#custom-scale-bar,#selected-leshoz-bar){{border-width:1px!important;border-color:#111111!important}}\n'
        '{T} body .topbar{{border-bottom:2px solid #111111!important}}\n',
 'gov': '{T} body .topbar::after{{height:4px!important;opacity:1!important;background:linear-gradient(90deg,#b3202a 0 66%,#1e6b3a 66%)!important}}\n'
        '{T} body .sidebar .fh-title{{font-weight:700!important}}\n',
 'navy': '{T} body :is(#map-geoloc-btn,#map-view3d-btn,#map-fullscreen-btn){{border-radius:999px!important}}\n',
 'field': '{T} body #sf-profile-menu .sf-profile-menu-item{{min-height:44px!important}}\n',
}
LABELS = ('{T} body:not(.fullscreen-mode) #map-icon-bar{{width:calc(var(--gt-mib) + 14px)!important}}\n'
 '{T} body #map-icon-bar>button.mib-btn{{width:var(--gt-mib)!important;min-width:var(--gt-mib)!important;height:auto!important;min-height:50px!important;'
 'flex-direction:column!important;gap:2px!important;padding:5px 2px 4px!important}}\n'
 '{T} body #map-icon-bar{{gap:2px!important;row-gap:2px!important}}\n'
 '{T} body #map-icon-bar>button.mib-btn .mib-tip{{position:static!important;transform:none!important;opacity:1!important;visibility:visible!important;'
 'background:none!important;color:inherit!important;box-shadow:none!important;border:0!important;border-radius:0!important;padding:0 1px!important;margin:0!important;'
 'font-size:10px!important;font-weight:600!important;line-height:1.15!important;letter-spacing:0!important;white-space:normal!important;text-align:center!important;'
 'width:100%!important;max-width:100%!important;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden!important;pointer-events:none!important}}\n')
PLATES = {
 'circle': '{T} body #map-icon-bar>button.mib-btn{{background:var(--gt-c-plate)!important;border-radius:999px!important}}\n'
           '{T} body #map-nav-group .map-nav-btn{{border-radius:999px!important}}\n',
 'square': '{T} body #map-icon-bar>button.mib-btn{{background:var(--gt-c-plate)!important;border-radius:var(--gt-r-sm)!important;box-shadow:inset 0 0 0 1px var(--gt-c-line)!important}}\n',
}

def tok(t):
    out = []
    for k, v in t.items():
        if k in SKIP: continue
        if k == 'font': v = F[v]
        elif k == 'mono': v = MONO[v]
        out.append('--gt-%s:%s' % (k.replace('_', '-'), v))
    return ';'.join(out)

def theme_css(t):
    T = '%s[data-gt="%s"]' % (P, t['id'])
    s = ['/* Геосервис ОДЗиМЛ v20.9 — тема «%s» (%s): %s.\n   Файл создан gen_themes.py из themes_def.py — правьте источник, а не этот файл. */' % (t['name'], t['id'], t['tag'].lower()),
         'html[data-gt="%s"]{%s}' % (t['id'], tok(t))]
    f = FORCED.get(t['id'])
    if f:
        s.append('%s,%s body{--mib-btn-size:%dpx!important;--mib-icon-size:%dpx!important;--map-nav-size:%dpx!important;--map-nav-icon-size:%dpx!important}' % (T, T, f['mib'], f['icon'], f['nav'], f['navicon']))
        if not t.get('labels'):
            s.append('%s body:not(.fullscreen-mode) #map-icon-bar{width:calc(%dpx + 14px)!important}' % (T, f['mib']))
    if t.get('labels'): s.append(LABELS.format(T=T).rstrip())
    if t.get('plates') in PLATES: s.append(PLATES[t['plates']].format(T=T).rstrip())
    if t['id'] in EXTRA: s.append(EXTRA[t['id']].format(T=T).rstrip())
    return '\n'.join(s) + '\n'

CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'
LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
FAM = {'golos-text': 'Golos Text', 'ibm-plex-sans': 'IBM Plex Sans', 'roboto': 'Roboto', 'source-sans-3': 'Source Sans 3', 'fira-sans': 'Fira Sans',
       'pt-sans': 'PT Sans', 'onest': 'Onest', 'manrope': 'Manrope', 'open-sans': 'Open Sans', 'ibm-plex-mono': 'IBM Plex Mono', 'jetbrains-mono': 'JetBrains Mono'}
def fonts_css():
    files = sorted(os.listdir(os.path.join(OUT, 'fonts')))
    s = ['/* Геосервис ОДЗиМЛ v20.9 — шрифты модулей оформления (все — SIL Open Font License 1.1, см. fonts/OFL.txt).',
         '   Файлы локальные (без интернета); браузер скачивает только начертания, которые реально нужны на экране. */']
    for w in (400, 500, 600, 700):
        s.append('@font-face{font-family:"Inter";font-style:normal;font-weight:%d;font-display:swap;src:url("/static/fonts/inter-%d.woff2?v=4.1") format("woff2")}' % (w, w))
    for fn in files:
        m = re.match(r'(.+)-(cyrillic|latin)-(\d+)\.woff2$', fn)
        if not m: continue
        fam, sub, w = m.group(1), m.group(2), m.group(3)
        s.append('@font-face{font-family:"%s";font-style:normal;font-weight:%s;font-display:swap;src:url("fonts/%s") format("woff2");unicode-range:%s}' % (FAM[fam], w, fn, CYR if sub == 'cyrillic' else LAT))
    return '\n'.join(s) + '\n'

def pv(t):
    return dict(s_bg=t['s_bg'], s_bg2=t['s_bg2'], s_line=t['s_line'], s_ink=t['s_ink'], s_muted=t['s_muted'], s_fill=t['s_fill'],
                head_bg=t['head_bg'], head_ink=t['head_ink'], o_bg=t['o_bg'], o_line=t['o_line'], o_ink=t['o_ink'], o_muted=t['o_muted'],
                fill=t['fill'], c_bg=t['c_bg'], c_line=t['c_line'], c_ink=t['c_ink'], c_on_bg=t['c_on_bg'], r=t['r'], r_btn=t['r_btn'],
                r_c='50%' if t['plates'] == 'circle' else t['r_sm'], font=F[t['font']])
CLASSIC = dict(name='Как сейчас', tag='Привычный вид без изменений', fontName='Inter',
               desc='Оформление Геосервиса по умолчанию: тема и сезон из настроек сайта. «Страж контраста» работает и здесь.',
               pv=dict(s_bg='#0f1f17', s_bg2='#13281f', s_line='#294331', s_ink='#edf7ef', s_muted='#b4c9be', s_fill='#82e938', head_bg='linear-gradient(180deg,#1d4a2b,#10291d)',
                       head_ink='#ffffff', o_bg='#13281f', o_line='#577568', o_ink='#edf7ef', o_muted='#b4c9be', fill='#82e938', c_bg='#13281f', c_line='#294331',
                       c_ink='#82e938', c_on_bg='#82e938', r='10px', r_btn='8px', r_c='8px', font=F['inter']))

def main():
    os.makedirs(OUT, exist_ok=True)
    ids = [t['id'] for t in THEMES]
    for t in THEMES:
        open(os.path.join(OUT, 'gt-%s.css' % t['id']), 'w', encoding='utf-8').write(theme_css(t))
    core = open(os.path.join(SRC, 'gt-core.src.css'), encoding='utf-8').read().replace('%P%', P)
    open(os.path.join(OUT, 'gt-core.css'), 'w', encoding='utf-8').write(core)
    open(os.path.join(OUT, 'gt-fonts.css'), 'w', encoding='utf-8').write(fonts_css())
    meta = [dict(id=t['id'], name=t['name'], tag=t['tag'], desc=t['desc'], fontName=t['fontName'], scheme=t['scheme'], pv=pv(t)) for t in THEMES]
    js = open(os.path.join(SRC, 'gt.src.js'), encoding='utf-8').read()
    js = js.replace('/*__THEMES__*/[]', json.dumps(meta, ensure_ascii=False, separators=(',', ':')))
    js = js.replace('/*__CLASSIC__*/{}', json.dumps(CLASSIC, ensure_ascii=False, separators=(',', ':')))
    open(os.path.join(OUT, 'gt.js'), 'w', encoding='utf-8').write(js)
    boot = open(os.path.join(SRC, 'gt-boot.src.js'), encoding='utf-8').read().replace('/*__IDS__*/[]', json.dumps(ids))
    open(os.path.join(OUT, 'gt-boot.js'), 'w', encoding='utf-8').write(boot)
    print('OK:', len(THEMES), 'тем →', OUT)

if __name__ == '__main__':
    main()
