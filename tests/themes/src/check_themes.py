import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from themes_def import THEMES
from contrast import rgba, blend, cr
PAIRS = [  # (текст, фон, минимум, что)
 ('ink','card',7,'текст/панель'),('ink','bg',7,'текст/фон'),('muted','card',4.5,'вторичный/панель'),('muted','bg',4.5,'вторичный/фон'),
 ('muted','soft',4.5,'вторичный/подложка'),('accent','card',4.5,'акцент/панель'),('accent','bg',4.5,'акцент/фон'),('on','fill',4.5,'текст кнопки'),
 ('on','fill_h',4.5,'текст кнопки (наведение)'),('on_acc','accent',4.5,'текст на акценте'),('hover_ink','hover',4.5,'наведение'),('sel_ink','sel',4.5,'выбрано'),
 ('danger','card',4.5,'ошибка/панель'),('warn','warn_bg',4.5,'предупреждение'),('err_ink','err_bg',4.5,'тост-ошибка'),('ink','soft',7,'текст/подложка'),('ink','tint',4.5,'текст/оттенок'),
 ('accent','soft',4.5,'акцент/подложка'),
 ('s_ink','s_bg',7,'боковая: текст'),('s_muted','s_bg',4.5,'боковая: вторичный'),('s_ink','s_bg2',7,'боковая: текст/поле'),('s_muted','s_bg2',4.5,'боковая: вторичный/поле'),
 ('s_acc','s_bg',4.5,'боковая: акцент'),('s_acc','s_bg2',4.5,'боковая: акцент/поле'),('s_on','s_fill',4.5,'боковая: кнопка'),('s_on','s_fill_h',4.5,'боковая: кнопка (наведение)'),
 ('s_hover_ink','s_hover',4.5,'боковая: наведение'),('s_sel_ink','s_sel',4.5,'боковая: выбрано'),('s_danger','s_bg2',4.5,'боковая: выход'),('s_ink','s_soft',7,'боковая: текст/подложка'),('s_muted','s_soft',4.5,'боковая: вторичный/подложка'),
 ('head_ink','head_bg',4.5,'шапка'),
 ('o_ink','o_bg',7,'плашки: текст'),('o_muted','o_bg',4.5,'плашки: вторичный'),('o_ink','o_bg2',7,'плашки: кнопки'),('o_muted','o_bg2',4.5,'плашки: вторичный/кнопки'),('o_acc','o_bg',4.5,'плашки: акцент'),
 ('o_acc','o_bg2',4.5,'плашки: акцент/кнопки'),('o_hover_ink','o_hover',4.5,'плашки: наведение'),('o_sel_ink','o_sel',4.5,'плашки: выбрано'),
 ('c_ink','c_bg',4.5,'кнопки карты'),('c_hover_ink','c_hover',4.5,'кнопки карты: наведение'),('c_on_ink','c_on_bg',4.5,'кнопки карты: активна'),
]
bad = 0; out = []
for t in THEMES:
    row = []
    for fg, bg, need, what in PAIRS:
        b = rgba(t[bg]); f = rgba(t[fg])
        # поверх фона страницы для полупрозрачных
        base = rgba(t['bg'])[:3] if not fg.startswith('s_') else rgba(t['s_bg'])[:3]
        bb = blend(b, base); ff = blend(f, bb)
        r = cr(ff, bb)
        if t['plates'] != 'none' and fg == 'c_ink':
            r = min(r, cr(ff, blend(rgba(t['c_plate']), bb)))
        row.append(r)
        if r < need:
            bad += 1; out.append(f"  {t['id']:9} {what:38} {fg}/{bg} = {r:.2f} < {need}")
    print(f"{t['id']:9} min={min(row):.2f}  ink/card={cr(rgba(t['ink'])[:3], rgba(t['card'])[:3]):.1f}  accent/card={cr(rgba(t['accent'])[:3], rgba(t['card'])[:3]):.1f}  on/fill={cr(rgba(t['on'])[:3], rgba(t['fill'])[:3]):.1f}  hover={cr(rgba(t['hover_ink'])[:3], rgba(t['hover'])[:3]):.1f}")
print('\n'.join(out) if out else 'все пары проходят'); print('нарушений:', bad)
