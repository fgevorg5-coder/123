/* ==========================================================================
   Геосервис ОДЗиМЛ v20.9 — модули оформления: окно «Оформление» и «Страж контраста».
   Подключается из gt-boot.js (асинхронно). API: window.GeoTheme
     .open() / .close()            — окно выбора (также Alt+Shift+T и любой элемент [data-gt-open])
     .set('bor'|…|'classic')       — применить и сохранить тему (localStorage gt_theme)
     .get()                        — текущая тема ('' = «Как сейчас»)
     .audit({fix:false, root})     — проверка контраста видимого текста и значков (для тестов/консоли)
     .guard.enable(true|false)     — «Страж контраста» (localStorage gt_guard, по умолчанию включён)
   ========================================================================== */
(function () {
  'use strict';
  if (window.GeoTheme) return;
  var THEMES = [{"id":"bor","name":"Бор","tag":"Тёмная лесная","desc":"Привычный тёмно-зелёный вид, но читаемый: лаймовые кнопки с тёмным текстом, светлые подписи, ровный шрифт Golos.","fontName":"Golos Text","scheme":"dark","pv":{"s_bg":"#0b1710","s_bg2":"#13261a","s_line":"#2f4a39","s_ink":"#eaf4ec","s_muted":"#a5beac","s_fill":"#a6e05a","head_bg":"#0b1710","head_ink":"#f3fbef","o_bg":"#0e1c14","o_line":"#33513f","o_ink":"#ecf5ee","o_muted":"#a8c1b0","fill":"#a6e05a","c_bg":"#122419","c_line":"#33513f","c_ink":"#e4efe6","c_on_bg":"#a6e05a","r":"10px","r_btn":"9px","r_c":"8px","font":"\"Golos Text\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"graphite","name":"Графит","tag":"Тёмная нейтральная, компактная","desc":"Серый «инженерный» интерфейс без цветового шума: янтарный акцент, плотная раскладка, моноширинные координаты.","fontName":"IBM Plex Sans","scheme":"dark","pv":{"s_bg":"#121416","s_bg2":"#1b1e21","s_line":"#353b42","s_ink":"#e8eaed","s_muted":"#a4aab2","s_fill":"#ffb547","head_bg":"#121416","head_ink":"#f4f5f7","o_bg":"#17191c","o_line":"#3d434b","o_ink":"#eceef1","o_muted":"#a9afb8","fill":"#ffb547","c_bg":"#1f2226","c_line":"#3d434b","c_ink":"#e6e8eb","c_on_bg":"#ffb547","r":"6px","r_btn":"5px","r_c":"4px","font":"\"IBM Plex Sans\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"white","name":"Белая карта","tag":"Светлая, спокойная","desc":"Светлые панели-карточки с мягкой тенью, тёмный текст, зелёный акцент с белым текстом на кнопках — максимум места карте.","fontName":"Inter","scheme":"light","pv":{"s_bg":"#ffffff","s_bg2":"#f3f6f4","s_line":"#dde4df","s_ink":"#15201a","s_muted":"#56635b","s_fill":"#147a3a","head_bg":"#0f2a1b","head_ink":"#ffffff","o_bg":"#ffffff","o_line":"#cfd8d2","o_ink":"#15201a","o_muted":"#56635b","fill":"#147a3a","c_bg":"#ffffff","c_line":"#cfd8d2","c_ink":"#24302a","c_on_bg":"#147a3a","r":"12px","r_btn":"10px","r_c":"8px","font":"\"Inter\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"navy","name":"Штаб","tag":"Тёмно-синяя, «пульт»","desc":"Тёмно-синий «диспетчерский» стиль: иконки в круглых плашках, кнопки-таблетки, голубой акцент с тёмным текстом.","fontName":"Roboto","scheme":"dark","pv":{"s_bg":"#0a1220","s_bg2":"#111c30","s_line":"#2a3c5c","s_ink":"#e7eef8","s_muted":"#a2b2c9","s_fill":"#5cc0ff","head_bg":"#0a1220","head_ink":"#eef4ff","o_bg":"#0e1726","o_line":"#34496d","o_ink":"#e9eff8","o_muted":"#a8b7cd","fill":"#5cc0ff","c_bg":"#142036","c_line":"#34496d","c_ink":"#dfe8f5","c_on_bg":"#5cc0ff","r":"14px","r_btn":"999px","r_c":"50%","font":"\"Roboto\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"gis","name":"ГИС-классика","tag":"Светло-серая, с подписями","desc":"Как в настольных ГИС: подписи под иконками панели инструментов, прямоугольные кнопки, синий акцент, плотные списки.","fontName":"Source Sans 3","scheme":"light","pv":{"s_bg":"#e6e9ed","s_bg2":"#ffffff","s_line":"#c4cbd3","s_ink":"#1b1f24","s_muted":"#4b5460","s_fill":"#0a59c2","head_bg":"#2c3e50","head_ink":"#ffffff","o_bg":"#ffffff","o_line":"#c4cbd3","o_ink":"#1b1f24","o_muted":"#4f5864","fill":"#0a59c2","c_bg":"#ffffff","c_line":"#b7c0ca","c_ink":"#2b3138","c_on_bg":"#0a59c2","r":"3px","r_btn":"3px","r_c":"2px","font":"\"Source Sans 3\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"contrast","name":"Высокий контраст","tag":"Чёрно-жёлтая, крупная","desc":"Для яркого солнца и слабого зрения: чёрный фон, белый текст, жёлтый акцент, рамки 2 px, крупные кнопки 48 px.","fontName":"Fira Sans","scheme":"dark","pv":{"s_bg":"#000000","s_bg2":"#0a0a0a","s_line":"#ffffff","s_ink":"#ffffff","s_muted":"#e0e0e0","s_fill":"#ffe600","head_bg":"#000000","head_ink":"#ffffff","o_bg":"#000000","o_line":"#ffffff","o_ink":"#ffffff","o_muted":"#e0e0e0","fill":"#ffe600","c_bg":"#000000","c_line":"#ffffff","c_ink":"#ffffff","c_on_bg":"#ffe600","r":"6px","r_btn":"6px","r_c":"4px","font":"\"Fira Sans\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"field","name":"Полевой планшет","tag":"Тёплая светлая, крупная","desc":"Для планшета в лесу: «бумажный» фон, тёмно-зелёная шапка, кнопки 52 px под палец, крупный шрифт PT Sans.","fontName":"PT Sans","scheme":"light","pv":{"s_bg":"#183626","s_bg2":"#1f4430","s_line":"#3d6650","s_ink":"#f7f1e3","s_muted":"#cbd8c6","s_fill":"#ffd27a","head_bg":"#183626","head_ink":"#fff7e6","o_bg":"#fffcf5","o_line":"#d3c6ab","o_ink":"#1e1a12","o_muted":"#5a5141","fill":"#1d6b30","c_bg":"#fffcf5","c_line":"#c9bb9c","c_ink":"#1e1a12","c_on_bg":"#1d6b30","r":"12px","r_btn":"10px","r_c":"10px","font":"\"PT Sans\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"swiss","name":"Швейцарский","tag":"Белый, строгий, без скруглений","desc":"Строгая типографика: белое поле, чёрные линии 1 px, прописные подписи, красный акцент, инверсия при наведении.","fontName":"Onest","scheme":"light","pv":{"s_bg":"#ffffff","s_bg2":"#ffffff","s_line":"#111111","s_ink":"#111111","s_muted":"#4a4a4a","s_fill":"#111111","head_bg":"#ffffff","head_ink":"#111111","o_bg":"#ffffff","o_line":"#111111","o_ink":"#111111","o_muted":"#4a4a4a","fill":"#111111","c_bg":"#ffffff","c_line":"#111111","c_ink":"#111111","c_on_bg":"#d7191c","r":"0px","r_btn":"0px","r_c":"0px","font":"\"Onest\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"taiga","name":"Тайга-сумерки","tag":"Тёмная бирюзовая, мягкая","desc":"Сумеречная тайга: глубокий сине-зелёный фон, бирюзовый акцент и коралловые метки, крупные скругления.","fontName":"Manrope","scheme":"dark","pv":{"s_bg":"#081517","s_bg2":"#0f2224","s_line":"#284a4e","s_ink":"#e3f2ef","s_muted":"#9ab8b3","s_fill":"#2ed3b7","head_bg":"#081517","head_ink":"#eafffb","o_bg":"#0b1b1d","o_line":"#30565a","o_ink":"#e6f4f2","o_muted":"#a1bfba","fill":"#2ed3b7","c_bg":"#112628","c_line":"#30565a","c_ink":"#dcefec","c_on_bg":"#2ed3b7","r":"14px","r_btn":"12px","r_c":"10px","font":"\"Manrope\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}},{"id":"gov","name":"Госстандарт","tag":"Светлая официальная","desc":"Официальный стиль: красно-зелёная полоса в шапке, белые панели, иконки в квадратных плашках, строгие скругления 4 px.","fontName":"Open Sans","scheme":"light","pv":{"s_bg":"#ffffff","s_bg2":"#f4f6f8","s_line":"#d5dbe2","s_ink":"#1a1d21","s_muted":"#4f5761","s_fill":"#1e6b3a","head_bg":"linear-gradient(180deg,#b3202a 0,#b3202a 66%,#1e6b3a 66%,#1e6b3a 100%)","head_ink":"#ffffff","o_bg":"#ffffff","o_line":"#ccd3db","o_ink":"#1a1d21","o_muted":"#4f5761","fill":"#1e6b3a","c_bg":"#ffffff","c_line":"#c3cbd4","c_ink":"#1a1d21","c_on_bg":"#1e6b3a","r":"4px","r_btn":"4px","r_c":"3px","font":"\"Open Sans\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}}];
  var CLASSIC = {"name":"Как сейчас","tag":"Привычный вид без изменений","fontName":"Inter","desc":"Оформление Геосервиса по умолчанию: тема и сезон из настроек сайта. «Страж контраста» работает и здесь.","pv":{"s_bg":"#0f1f17","s_bg2":"#13281f","s_line":"#294331","s_ink":"#edf7ef","s_muted":"#b4c9be","s_fill":"#82e938","head_bg":"linear-gradient(180deg,#1d4a2b,#10291d)","head_ink":"#ffffff","o_bg":"#13281f","o_line":"#577568","o_ink":"#edf7ef","o_muted":"#b4c9be","fill":"#82e938","c_bg":"#13281f","c_line":"#294331","c_ink":"#82e938","c_on_bg":"#82e938","r":"10px","r_btn":"8px","r_c":"8px","font":"\"Inter\",\"Segoe UI\",system-ui,-apple-system,Arial,sans-serif"}};
  var KEY = 'gt_theme', GKEY = 'gt_guard';
  var d = document, H = d.documentElement, BOOT = window.GT_BOOT || {};
  var BASE = BOOT.base || '/static/themes/', Q = BOOT.q || '';

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (e) { return null; }
  }
  function byId(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return null; }
  function cur() { return H.getAttribute('data-gt') || ''; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- темы ---------------- */
  function ensureFonts() {
    if (d.getElementById('gt-fonts-css')) return;
    var l = d.createElement('link'); l.rel = 'stylesheet'; l.id = 'gt-fonts-css'; l.href = BASE + 'gt-fonts.css' + Q;
    (d.head || H).appendChild(l);
  }
  var seq = 0;
  function apply(id, save) {
    id = byId(id) ? id : '';
    if (save) ls(KEY, id || 'classic');
    var my = ++seq, old = d.getElementById('gt-theme-css'), nl = null;
    function done() {
      if (my !== seq) { if (nl && nl.parentNode) nl.parentNode.removeChild(nl); return; }
      H.classList.add('gt-switching');
      if (id) H.setAttribute('data-gt', id); else H.removeAttribute('data-gt');
      var o = d.getElementById('gt-theme-css');
      if (o && o !== nl && o.parentNode) o.parentNode.removeChild(o);
      if (nl) nl.id = 'gt-theme-css';
      setTimeout(function () { H.classList.remove('gt-switching'); }, 80);
      Guard.reset(); Guard.schedule(300, true); Guard.schedule(1500, true);
      syncCards();
      try { window.dispatchEvent(new CustomEvent('gt-change', { detail: { theme: id || 'classic' } })); } catch (e) {}
    }
    if (!id) { done(); return; }
    if (old && cur() === id) { done(); return; }
    ensureFonts();
    nl = d.createElement('link'); nl.rel = 'stylesheet'; nl.href = BASE + 'gt-' + id + '.css' + Q;
    nl.onload = done; nl.onerror = done;
    var anchor = old || d.getElementById('gt-core-css');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(nl, anchor.nextSibling); else (d.head || H).appendChild(nl);
  }

  /* ---------------- окно «Оформление» ---------------- */
  var ov = null, lastFocus = null;
  function pvVars(p) {
    var m = { sbg: p.s_bg, sbg2: p.s_bg2, sline: p.s_line, sink: p.s_ink, smut: p.s_muted, sfill: p.s_fill, head: p.head_bg, hink: p.head_ink,
      obg: p.o_bg, oline: p.o_line, oink: p.o_ink, omut: p.o_muted, fill: p.fill, cbg: p.c_bg, cline: p.c_line, cink: p.c_ink, con: p.c_on_bg,
      r: p.r, rb: p.r_btn, rc: p.r_c, font: p.font };
    var s = ''; for (var k in m) s += '--p-' + k + ':' + m[k] + ';';
    return s;
  }
  function card(t) {
    var id = t ? t.id : 'classic', p = t ? t.pv : CLASSIC.pv, nm = t ? t.name : CLASSIC.name, tag = t ? t.tag : CLASSIC.tag,
      fn = t ? t.fontName : CLASSIC.fontName, ds = t ? t.desc : CLASSIC.desc;
    return '<button type="button" class="gt-card" data-gt-id="' + id + '" aria-pressed="false" style="' + esc(pvVars(p)) + '" title="' + esc(ds) + '">' +
      '<span class="gt-pv" aria-hidden="true"><span class="gt-pv-s"><span class="gt-pv-h"><i></i><u></u></span><span class="gt-pv-q"></span>' +
      '<span class="gt-pv-l"></span><span class="gt-pv-l m"></span><span class="gt-pv-l"></span><span class="gt-pv-l m"></span><span class="gt-pv-b"></span></span>' +
      '<span class="gt-pv-p"><i></i><i class="m"></i><i class="m"></i><b></b></span><span class="gt-pv-c"><i class="on"></i><i></i><i></i><i></i></span>' +
      '<span class="gt-pv-t" data-gt-keepfont>Аа 1:50 000</span></span>' +
      '<span class="gt-nm"><b data-gt-keepfont style="font-family:' + esc(p.font) + '">' + esc(nm) + '</b><small>' + esc(tag) + '</small>' +
      '<em>' + esc(fn) + ' · ' + esc(ds) + '</em></span></button>';
  }
  function build() {
    ov = d.createElement('div'); ov.className = 'gt-ov'; ov.hidden = true; ov.setAttribute('data-gt-ui', '');
    ov.innerHTML = '<div class="gt-dlg" role="dialog" aria-modal="true" aria-labelledby="gt-title" tabindex="-1">' +
      '<div class="gt-hd"><div><h2 id="gt-title">Оформление</h2><p>Вид всего Геосервиса: цвета, шрифт, форма и размер кнопок. ' +
      'Применяется сразу на всех открытых вкладках и запоминается в этом браузере. «Как сейчас» — прежний вид без изменений.</p></div>' +
      '<button type="button" class="gt-x" data-gt-close aria-label="Закрыть">×</button></div>' +
      '<div class="gt-grid">' + [card(null)].concat(THEMES.map(card)).join('') + '</div>' +
      '<div class="gt-ft"><label class="gt-sw"><input type="checkbox" id="gt-guard-sw"><span><b>Страж контраста</b>' +
      '<small>Следит, чтобы текст и значки читались в любой теме — и при наведении. Если цвета сливаются, подправляет их на лету.</small></span></label>' +
      '<span class="gt-note">Alt+Shift+T — открыть это окно</span><button type="button" class="gt-ok" data-gt-close>Готово</button></div></div>';
    d.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[data-gt-id]');
      if (c) { var id = c.getAttribute('data-gt-id'); apply(id === 'classic' ? '' : id, true); return; }
      if (e.target === ov || (e.target.closest && e.target.closest('[data-gt-close]'))) close();
    });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        var f = ov.querySelectorAll('button,input'), a = f[0], z = f[f.length - 1];
        if (e.shiftKey && d.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && d.activeElement === z) { e.preventDefault(); a.focus(); }
      }
      if (/^Arrow/.test(e.key) && e.target.classList && e.target.classList.contains('gt-card')) {
        var cs = Array.prototype.slice.call(ov.querySelectorAll('.gt-card')), i = cs.indexOf(e.target);
        var cols = Math.max(1, Math.round(ov.querySelector('.gt-grid').clientWidth / (e.target.offsetWidth + 14)));
        var j = i + ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols })[e.key];
        if (cs[j]) { e.preventDefault(); cs[j].focus(); }
      }
    });
    var sw = ov.querySelector('#gt-guard-sw'); sw.checked = Guard.isOn();
    sw.addEventListener('change', function () { Guard.enable(sw.checked, true); });
  }
  function syncCards() {
    if (!ov) return;
    var id = cur() || 'classic';
    Array.prototype.forEach.call(ov.querySelectorAll('.gt-card'), function (c) { c.setAttribute('aria-pressed', c.getAttribute('data-gt-id') === id ? 'true' : 'false'); });
    var sw = ov.querySelector('#gt-guard-sw'); if (sw) sw.checked = Guard.isOn();
  }
  function open() {
    if (!d.body) return;
    if (!ov) build();
    ensureFonts(); syncCards();
    lastFocus = d.activeElement;
    ov.hidden = false;
    var sel = ov.querySelector('.gt-card[aria-pressed="true"]') || ov.querySelector('.gt-card');
    setTimeout(function () { try { sel.focus({ preventScroll: false }); } catch (e) {} }, 30);
  }
  function close() {
    if (!ov || ov.hidden) return;
    ov.hidden = true;
    if (lastFocus && lastFocus.focus && d.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) {} }
    Guard.schedule(400, true);
  }
  function closeHostMenus() {
    var m = d.getElementById('sf-profile-menu');
    if (m && !m.hidden) {
      var t = d.querySelector('[data-sf-profile-trigger][aria-expanded="true"]');
      if (t) t.click(); else m.hidden = true;
    }
    if (typeof window.closeProfileMenu === 'function') { try { window.closeProfileMenu(); } catch (e) {} }
  }
  d.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('[data-gt-open]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    closeHostMenus(); open();
  }, true);
  d.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyT' || /^[tTеЕ]$/.test(e.key))) {
      e.preventDefault(); if (ov && !ov.hidden) close(); else open();
    }
  });
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { var v = e.newValue || ''; apply(v === 'classic' ? '' : v, false); }
    else if (e.key === GKEY) Guard.enable(e.newValue !== '0', false);
  });

  /* ---------------- «Страж контраста» ---------------- */
  var Guard = (function () {
    var on = ls(GKEY) !== '0';
    var fixed = new Set(), orig = new WeakMap(), hov = new Map(), memo = new Map(), cache = new Map();
    var phSheet = null, phN = 0, phRules = new Map();
    var cx = null;
    var RE_COL = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}\b|transparent)/g;
    var SKIP_TAG = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, HR: 1, CANVAS: 1, IMG: 1, VIDEO: 1, AUDIO: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, PICTURE: 1, SOURCE: 1, TRACK: 1, PARAM: 1, MAP: 1, AREA: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1 };
    var EMO = /^[\s\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]+$/u;
    var INTER = 'button,a[href],[role=button],[role=menuitem],[role=tab],[role=option],.tpm-item,.dialog-item,.lsr-item,label,summary,[onclick],[tabindex]:not([tabindex="-1"]),.sf-profile-menu-item,.mib-btn,.map-nav-btn';
    function parse(s) {
      if (!s || s === 'transparent' || s === 'none') return [0, 0, 0, 0];
      var c = cache.get(s); if (c) return c;
      var m = /^rgba?\(([^)]+)\)$/.exec(s), r;
      if (m) {
        var p = m[1].split(/[\s,\/]+/).filter(Boolean);
        r = [+p[0], +p[1], +p[2], p.length > 3 ? (p[3].slice(-1) === '%' ? parseFloat(p[3]) / 100 : +p[3]) : 1];
      } else if ((m = /^color\(srgb\s+([^)]+)\)$/.exec(s))) {
        var q = m[1].split(/[\s\/]+/).filter(Boolean);
        r = [q[0] * 255, q[1] * 255, q[2] * 255, q.length > 3 ? (q[3].slice(-1) === '%' ? parseFloat(q[3]) / 100 : +q[3]) : 1];
      } else {
        try {
          if (!cx) { var cv = d.createElement('canvas'); cv.width = cv.height = 1; cx = cv.getContext('2d', { willReadFrequently: true }); }
          cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
          var px = cx.getImageData(0, 0, 1, 1).data; r = [px[0], px[1], px[2], px[3] / 255];
        } catch (e) { r = [0, 0, 0, 0]; }
      }
      for (var i = 0; i < 4; i++) if (!isFinite(r[i])) r[i] = i === 3 ? 1 : 0;
      if (cache.size > 800) cache.clear();
      cache.set(s, r); return r;
    }
    function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function lum(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
    function cr(a, b) { var x = lum(a), y = lum(b); return x > y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05); }
    function over(f, b) { var a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; }
    function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
    function parentOf(n) { return n.parentElement || (n.parentNode && n.parentNode.host) || null; }
    // Возможные цвета фона под содержимым элемента (градиенты — все опорные цвета); null — фон неизвестен (картинка, карта)
    function cand(n) {
      if (!n || n.nodeType !== 1) return [[255, 255, 255, 1]];
      if (memo.has(n)) return memo.get(n);
      var res;
      if (n.id === 'map' || (n.classList && (n.classList.contains('ol-viewport') || n.classList.contains('ol-layer'))) || SKIP_TAG[n.tagName] === 1 && n.tagName !== 'OPTION') {
        res = n.tagName === 'HTML' ? [[255, 255, 255, 1]] : null;
        memo.set(n, res); return res;
      }
      var cs = getComputedStyle(n), bc = parse(cs.backgroundColor), bi = cs.backgroundImage, stops = null;
      if (bi && bi !== 'none') {
        if (bi.indexOf('url(') >= 0 || bi.indexOf('image-set') >= 0) { memo.set(n, null); return null; }
        var mm = bi.match(RE_COL); if (mm) stops = mm.map(parse);
      }
      var base;
      if (bc[3] >= 0.995) base = [bc];
      else {
        var stopsOpaque = stops && stops.length && stops.every(function (s) { return s[3] >= 0.995; });
        if (stopsOpaque) base = [[255, 255, 255, 1]];
        else {
          var below = n.tagName === 'HTML' ? [[255, 255, 255, 1]] : cand(parentOf(n));
          if (below === null) { memo.set(n, null); return null; }
          base = bc[3] > 0.005 ? below.map(function (b) { return over(bc, b); }) : below;
        }
      }
      if (stops && stops.length) {
        var out = [], seen = {};
        for (var i = 0; i < base.length; i++) for (var j = 0; j < stops.length; j++) {
          var c = over(stops[j], base[i]), k = Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]);
          if (!seen[k]) { seen[k] = 1; out.push(c); }
        }
        if (out.length > 16) { out.sort(function (a, b) { return lum(a) - lum(b); }); out = [out[0], out[out.length >> 1], out[out.length - 1]]; }
        base = out;
      }
      memo.set(n, base); return base;
    }
    function hasText(el) {
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
      return false;
    }
    function visible(el) {
      if (el.checkVisibility) {
        try { if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false; } catch (e) {}
      }
      var r = el.getClientRects(); if (!r.length) return false;
      var b = r[0]; return b.width > 0.5 && b.height > 0.5;
    }
    function disabled(el) {
      try { if (el.matches(':disabled')) return true; } catch (e) {}
      return !!(el.closest && el.closest('[aria-disabled="true"],[disabled],[inert]'));
    }
    function opac(el) {   // прозрачность самого элемента и прозрачных (без фона) предков
      var o = 1, n = el, k = 0;
      while (n && n.nodeType === 1 && k++ < 40) {
        var cs = getComputedStyle(n); o *= parseFloat(cs.opacity);
        if (n !== el && (parse(cs.backgroundColor)[3] > 0.005 || cs.backgroundImage !== 'none')) break;
        n = parentOf(n);
      }
      return o;
    }
    function groupOpac(el) { var o = 1, n = el, k = 0; while (n && n.nodeType === 1 && k++ < 60) { o *= parseFloat(getComputedStyle(n).opacity); n = parentOf(n); } return o; }
    function worst(fg, cands) { var m = 99; for (var i = 0; i < cands.length; i++) { var r = cr(over(fg, cands[i]), cands[i]); if (r < m) m = r; } return m; }
    function solve(fg, a, cands, th) {
      var best = null, T = [[0, 0, 0], [255, 255, 255]];
      for (var t = 0; t < 2; t++) {
        var tg = T[t], ext = worst([tg[0], tg[1], tg[2], a], cands);
        if (ext < th) { if (!best || (!best.ok && ext > best.r)) best = { c: tg, ok: false, r: ext }; continue; }
        var lo = 0, hi = 1;
        for (var k = 0; k < 14; k++) { var mid = (lo + hi) / 2, c = mix(fg, tg, mid); if (worst([c[0], c[1], c[2], a], cands) >= th) hi = mid; else lo = mid; }
        var cc = mix(fg, tg, hi);
        if (!best || !best.ok || hi < best.t) best = { c: cc, ok: true, t: hi, r: worst([cc[0], cc[1], cc[2], a], cands) };
      }
      return best;
    }
    function remember(el, props, store) {
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (store) { store.push({ el: el, p: p, v: el.style.getPropertyValue(p), pr: el.style.getPropertyPriority(p) }); continue; }
        var o = orig.get(el); if (!o) { o = {}; orig.set(el, o); }
        if (!(p in o)) o[p] = { v: el.style.getPropertyValue(p), pr: el.style.getPropertyPriority(p) };
      }
      if (!store) fixed.add(el);
    }
    function setProps(el, props, val, store) {
      remember(el, props, store);
      for (var i = 0; i < props.length; i++) el.style.setProperty(props[i], val, 'important');
    }
    function phFix(el, val) {
      if (!phSheet) { var st = d.createElement('style'); st.id = 'gt-guard-ph'; (d.head || H).appendChild(st); phSheet = st; }
      var k = el.getAttribute('data-gtg-ph'); if (!k) { k = String(++phN); el.setAttribute('data-gtg-ph', k); }
      phRules.set(k, '[data-gtg-ph="' + k + '"]::placeholder{color:' + val + '!important;opacity:1!important}');
      var s = ''; phRules.forEach(function (v) { s += v + '\n'; }); phSheet.textContent = s;
    }
    function label(el) {
      var s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
      if (el.classList && el.classList.length) s += '.' + Array.prototype.slice.call(el.classList, 0, 3).join('.');
      return s;
    }
    // Проверка одного элемента. rep — отчёт; fix — исправлять; store — массив для отката (наведение/фокус)
    function check(el, rep, fix, store) {
      if (!el || el.nodeType !== 1 || SKIP_TAG[el.tagName] === 1) return;
      if (el.closest('.gt-pv,[data-gt-skip],.ol-viewport canvas')) return;
      var tag = el.tagName, isSvg = tag === 'svg' || tag === 'SVG', kind = null;
      if (isSvg) {
        if (el.parentElement && el.parentElement.closest('svg')) return;
        if (!(el.classList.contains('tb-svg') || /currentcolor/i.test(el.getAttribute('stroke') || '') || /currentcolor/i.test(el.getAttribute('fill') || ''))) return;
        kind = 'icon';
      } else if (el instanceof SVGElement) return;
      else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        var ty = (el.type || '').toLowerCase();
        if (/^(checkbox|radio|range|color|file|hidden|image|submit|reset|button)$/.test(ty)) { if (!/^(submit|reset|button)$/.test(ty) || !el.value) return; kind = 'text'; }
        else kind = (el.value || tag === 'SELECT') ? 'text' : (el.placeholder ? 'ph' : null);
        if (!kind) return;
      } else if (tag === 'I' && !el.querySelector('svg') && /(^|\s)(fa|fa-[a-z-]+|ti|ti-[a-z-]+|future-icon)(\s|$)/.test(el.className)) kind = 'icon';
      else if (hasText(el)) {
        kind = 'text';
        // цветные эмодзи не зависят от color — не проверяем
        if (EMO.test(el.textContent || '')) return;
      }
      else return;
      if (!visible(el) || disabled(el)) return;
      if (groupOpac(el) < 0.6) return;
      var cs = getComputedStyle(el);
      if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') return;
      var fgS = cs.color, props = ['color'];
      if (kind === 'ph') { try { fgS = getComputedStyle(el, '::placeholder').color; } catch (e) {} }
      else if (isSvg) {
        var st = cs.stroke, fl = cs.fill;
        if (st && st !== 'none' && !/url\(/.test(st)) { fgS = st; if (parse(st).join() !== parse(cs.color).join()) props = ['color', 'stroke']; }
        else if (fl && fl !== 'none' && !/url\(/.test(fl)) { fgS = fl; if (parse(fl).join() !== parse(cs.color).join()) props = ['color', 'fill']; }
      } else {
        var tf = cs.webkitTextFillColor;
        if (tf && tf !== fgS && parse(tf)[3] > 0) { fgS = tf; props = ['color', '-webkit-text-fill-color']; }
      }
      var fg = parse(fgS); if (fg[3] < 0.04) return;
      var cands = cand(el); if (!cands) return;
      var op = opac(el), a = fg[3] * op;
      var fs = parseFloat(cs.fontSize) || 14, fw = parseInt(cs.fontWeight, 10) || 400;
      var th = kind === 'icon' ? 3 : ((fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3 : 4.5);
      var r = worst([fg[0], fg[1], fg[2], a], cands);
      rep.checked++;
      if (r >= th) return;
      var item = { el: label(el), text: (kind === 'icon' ? '[значок]' : kind === 'ph' ? '[подсказка] ' + (el.placeholder || '') : (el.value || el.textContent || '')).replace(/\s+/g, ' ').trim().slice(0, 48),
        kind: kind, ratio: Math.round(r * 100) / 100, need: th, fg: rgb(fg), bg: rgb(cands[0]) };
      if (fix) {
        var s = solve(fg, Math.max(op, 0.0001) >= 1 ? 1 : op, cands, th + 0.2);
        if (s) {
          var v = rgb(s.c);
          if (kind === 'ph') phFix(el, v); else setProps(el, props, v, store);
          item.fixed = v; item.after = Math.round(s.r * 100) / 100; rep.fixed++;
        }
      }
      rep.fails.push(item);
    }
    function list(root) {
      var out = [];
      if (!root) return out;
      if (root.nodeType === 1) out.push(root);
      var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var i = 0; i < all.length; i++) { var t = all[i].tagName; if (SKIP_TAG[t] !== 1 && !(all[i] instanceof SVGElement && t !== 'svg')) out.push(all[i]); }
      return out;
    }
    function newRep() { return { checked: 0, fixed: 0, fails: [], theme: cur() || 'classic', guard: on }; }
    function audit(o) {
      o = o || {}; memo.clear();
      var rep = newRep(), els = list(o.root || d.body), fix = o.fix === true || (o.fix !== false && on);
      for (var i = 0; i < els.length; i++) { try { check(els[i], rep, fix, null); } catch (e) {} }
      memo.clear(); return rep;
    }
    /* фоновая проверка порциями */
    var queue = [], qset = new Set(), busy = false, timers = [], last = null;
    function enqueue(root) {
      if (!root || qset.has(root)) return;
      qset.add(root); queue.push(root);
    }
    function pump() {
      if (busy) return; busy = true;
      var rep = newRep(), els = [];
      while (queue.length) els = els.concat(list(queue.shift()));
      qset.clear(); memo.clear();
      var i = 0;
      (function slice() {
        var t0 = performance.now();
        while (i < els.length && performance.now() - t0 < 12) { try { check(els[i++], rep, true, null); } catch (e) {} }
        if (i < els.length) { setTimeout(slice, 16); return; }
        memo.clear(); busy = false; last = rep;
        if (queue.length) setTimeout(pump, 50);
      })();
    }
    function schedule(ms, full) {
      if (!on) return;
      timers.push(setTimeout(function () { if (full) enqueue(d.body); pump(); }, ms || 0));
    }
    function reset() {
      fixed.forEach(function (el) {
        var o = orig.get(el); if (!o) return;
        for (var p in o) { if (o[p].v) el.style.setProperty(p, o[p].v, o[p].pr); else el.style.removeProperty(p); }
        orig.delete(el);
      });
      fixed.clear();
      hov.forEach(function (st) { restore(st); }); hov.clear();
      phRules.clear(); if (phSheet) phSheet.textContent = '';
      cache.clear();
    }
    function restore(st) {
      for (var i = st.length - 1; i >= 0; i--) { var x = st[i]; if (x.v) x.el.style.setProperty(x.p, x.v, x.pr); else x.el.style.removeProperty(x.p); }
      st.length = 0;
    }
    /* наведение и фокус */
    function interRoot(t) { return t && t.closest ? t.closest(INTER) : null; }
    function hoverCheck(root) {
      if (!on || !root.isConnected) return;
      if (!(root.matches(':hover') || root.matches(':focus-within') || root.matches(':focus'))) return;
      var st = hov.get(root); if (!st) { st = []; hov.set(root, st); }
      memo.clear();
      var rep = newRep(), els = list(root);
      if (els.length > 60) els = els.slice(0, 60);
      for (var i = 0; i < els.length; i++) { try { check(els[i], rep, true, st); } catch (e) {} }
      memo.clear();
    }
    function leave(root) {
      setTimeout(function () {
        if (!root.isConnected || root.matches(':hover') || root.matches(':focus-within')) return;
        var st = hov.get(root); if (st) { restore(st); hov.delete(root); }
        setTimeout(function () { if (on && root.isConnected && !root.matches(':hover')) { enqueue(root); pump(); } }, 260);
      }, 30);
    }
    function onEnter(e) {
      if (!on) return;
      var r = interRoot(e.target); if (!r || (e.relatedTarget && r.contains(e.relatedTarget))) return;
      setTimeout(function () { hoverCheck(r); }, 120);
      setTimeout(function () { hoverCheck(r); }, 380);
    }
    function onLeave(e) {
      var r = interRoot(e.target); if (!r || (e.relatedTarget && r.contains(e.relatedTarget))) return;
      if (hov.has(r)) leave(r);
    }
    d.addEventListener('pointerover', onEnter, true);
    d.addEventListener('pointerout', onLeave, true);
    d.addEventListener('focusin', onEnter, true);
    d.addEventListener('focusout', onLeave, true);
    var lastClick = 0;
    d.addEventListener('click', function () {
      if (!on) return; var n = Date.now(); if (n - lastClick < 1500) return; lastClick = n;
      schedule(450, true);
    }, true);
    var mo = null, mtimer = 0, mroots = [];
    function observe() {
      if (mo || !window.MutationObserver || !d.body) return;
      mo = new MutationObserver(function (ms) {
        if (!on) return;
        for (var i = 0; i < ms.length && mroots.length < 60; i++) {
          var m = ms[i];
          if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) mroots.push(m.addedNodes[j]); else if (m.addedNodes[j].nodeType === 3 && m.target.nodeType === 1) mroots.push(m.target); }
          else if (m.target.nodeType === 1 && m.target.id !== 'gt-guard-ph') mroots.push(m.target);
        }
        clearTimeout(mtimer);
        mtimer = setTimeout(function () {
          var rs = mroots; mroots = [];
          if (rs.length >= 60) { enqueue(d.body); pump(); return; }
          rs.forEach(function (r) { if (r.isConnected && !(r.closest && r.closest('.gt-pv'))) enqueue(r); });
          pump();
        }, 700);
      });
      mo.observe(d.body, { childList: true, subtree: true, characterData: false, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'aria-expanded', 'aria-selected', 'aria-pressed', 'data-theme', 'data-gs-theme'] });
    }
    function enable(v, save) {
      on = !!v; if (save) ls(GKEY, on ? '1' : '0');
      if (!on) reset(); else { schedule(50, true); }
      if (ov) { var sw = ov.querySelector('#gt-guard-sw'); if (sw) sw.checked = on; }
    }
    function start() {
      observe();
      schedule(1000, true); schedule(3200, true);
    }
    return { audit: audit, schedule: schedule, reset: reset, enable: enable, isOn: function () { return on; }, start: start, last: function () { return last; },
      _cr: cr, _parse: parse };
  })();

  window.GeoTheme = {
    version: '20.9',
    list: function () { return THEMES.map(function (t) { return { id: t.id, name: t.name, tag: t.tag }; }); },
    get: cur,
    set: function (id) { apply(id === 'classic' ? '' : id, true); },
    open: open, close: close,
    audit: function (o) { return Guard.audit(o); },
    guard: { enable: function (v) { Guard.enable(v, true); }, isOn: Guard.isOn, reset: Guard.reset, last: Guard.last }
  };
  // тема из другой вкладки/параметра могла смениться до загрузки скрипта
  (function () {
    var want = ls(KEY) || ''; if (want === 'classic') want = '';
    if (byId(want) && want !== cur()) apply(want, false);
  })();
  if (d.readyState === 'complete') Guard.start();
  else window.addEventListener('load', function () { Guard.start(); });
})();
