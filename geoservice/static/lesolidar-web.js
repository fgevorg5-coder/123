/* lesolidar-web.js — ЛесоЛидар в геосервисе (v19).
 * Веб-мастер обработки облаков точек LAS/LAZ по образцу «Арборитм»:
 *   Входные данные → Основные настройки → Опции обработки → Обзор и запуск → Процесс → Результаты.
 * • блок «Обработка LAS» вверху окна выбора 3D (над списком лесхозов): состояние обработчика, новые и последние задания;
 * • входные данные: загрузка LAS/LAZ кусками с докачкой, демо-участок, список требований к данным, выбор CRS,
 *   контуры с типами «Лесосека / Выдел / НЭП (исключить)» (KML/GeoJSON — с превью, ZIP-SHP — на сервер), граница 3D-сцены;
 * • режимы 1–3: подсчёт стволов → + породы → + объём древесины; регион/подрегион, сезон съёмки, возраст (для бонитета);
 * • процесс: этапы с процентами, оценка времени, журнал, отмена; результаты: показатели (запас, деревья, площадь,
 *   бонитет и полнота, время), пивот по породам, круговые диаграммы, ярусы, распределения, «Учёт деревьев» с причинами
 *   отметок, выходные файлы и ZIP, история версий, показ деревьев и рельефа LAS в 3D.
 * Данные: /api/lesolidar/* (lesolidar_bridge.py). Запуск/удаление — администратор (+ CSRF).
 */
(function (root) {
'use strict';
var API = '/api/lesolidar', VERSION = 'v19', LS_OPEN = 'llw_pick_open_v1', LS_PREFS = 'llw_prefs_v1';
var S = { caps: null, capsP: null, modal: null, wiz: null, pickers: [], viewers: [], jobsCache: null, jobsAt: 0 };
var STEP_NAMES = ['Входные данные', 'Основные настройки', 'Опции обработки', 'Обзор и запуск', 'Процесс', 'Результаты'];
var MODES = {
  1: { t: 'Режим 1 — подсчёт стволов', d: 'Количество деревьев и их высоты, кроны. Без классификации пород и без расчёта объёмов.' },
  2: { t: 'Режим 2 — стволы и породы', d: 'Подсчёт стволов с классификацией пород: высота и порода каждого дерева, состав насаждения.' },
  3: { t: 'Режим 3 — полный анализ', d: 'Классификация пород и расчёт объёма древесины: подеревный отчёт, пивот по породам, запас, таксационная ведомость.' }
};
var REGIONS = {
  'Беларусь': ['Подзона дубово-темнохвойных лесов (север)', 'Подзона грабово-дубово-темнохвойных лесов (центр)', 'Подзона широколиственно-сосновых лесов (Полесье)'],
  'Россия — европейская часть': ['Северо-Западный', 'Центральный', 'Приволжский'],
  'Прибалтика': ['Литва', 'Латвия', 'Эстония'],
  'Другой': ['—']
};
var PRESETS = {
  balanced: { t: 'Сбалансированный', d: 'Подходит для большинства спелых и средневозрастных насаждений', p: { min_tree_height: 4, ws_a: 1.2, ws_b: 0.05, crown_rel_threshold: 0.4, max_crown_a: 1.5, max_crown_b: 0.22, min_crown_area: 0.5, smooth_sigma_m: 0.3 } },
  dense: { t: 'Густой молодняк', d: 'Меньше окно поиска вершин, мелкие кроны — для молодняков и густого второго яруса', p: { min_tree_height: 2.5, ws_a: 0.8, ws_b: 0.035, crown_rel_threshold: 0.45, max_crown_a: 1.0, max_crown_b: 0.16, min_crown_area: 0.3, smooth_sigma_m: 0.2 } },
  mature: { t: 'Спелый разреженный', d: 'Крупные кроны, шире окно — меньше ложных вершин в старых древостоях', p: { min_tree_height: 6, ws_a: 1.6, ws_b: 0.07, crown_rel_threshold: 0.35, max_crown_a: 2.2, max_crown_b: 0.28, min_crown_area: 1.0, smooth_sigma_m: 0.45 } }
};
var ROLE = { lesoseka: 'Лесосека', vydel: 'Выдел', nep: 'НЭП — исключить' };
var FLAG = {
  ok: ['В запасе', '#82e938'], young: ['Подрост < 5 м', '#7cc4ff'], lowconf: ['Порода неуверенно', '#ffd54a'], nodbh: ['Без диаметра', '#ff9d7a']
};

/* ───────────── утилиты ───────────── */
function $(s, el) { return (el || document).querySelector(s); }
function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function num(v, d) { if (v == null || v === '' || !isFinite(v)) return '—'; d = d || 0; return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function bytes(n) { if (!isFinite(n)) return '—'; var u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'], i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return num(n, i ? (n < 10 ? 1 : 0) : 0) + ' ' + u[i]; }
function dur(s) { if (s == null || !isFinite(s)) return '—'; s = Math.max(0, Math.round(s)); if (s < 60) return s + ' с'; var m = Math.floor(s / 60); if (m < 60) return m + ' мин ' + (s % 60 ? (s % 60) + ' с' : ''); return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин'; }
function when(ts) { if (!ts) return '—'; var d = new Date(ts * 1000); return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
function toast(m, e) { if (typeof root.showToast === 'function') root.showToast(m, e); else (e ? console.warn : console.log)('[ЛесоЛидар] ' + m); }
function csrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ''; }
function prefs(upd) { var p = {}; try { p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch (e) {} if (upd) { for (var k in upd) p[k] = upd[k]; try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch (e) {} } return p; }
function call(method, path, body, opt) {
  opt = opt || {};
  var h = { 'Accept': 'application/json' };
  if (method !== 'GET') h['X-CSRFToken'] = csrf();
  var init = { method: method, credentials: 'same-origin', headers: h, cache: 'no-store', signal: opt.signal };
  if (body !== undefined && body !== null) {
    if (body instanceof Blob || body instanceof ArrayBuffer) { init.body = body; h['Content-Type'] = 'application/octet-stream'; }
    else { init.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  }
  return fetch(API + path, init).then(function (r) {
    var ct = r.headers.get('content-type') || '';
    if (!r.ok) return (ct.indexOf('json') >= 0 ? r.json() : r.text().then(function (t) { return { detail: t.slice(0, 200) }; })).catch(function () { return {}; }).then(function (j) {
      var d = j && j.detail; if (Array.isArray(d)) d = d.map(function (x) { return x.msg || x; }).join('; ');
      var e = new Error(d || ('HTTP ' + r.status)); e.status = r.status; throw e;
    });
    if (opt.raw) return r;
    return ct.indexOf('json') >= 0 ? r.json() : r.text();
  });
}
function caps(force) {
  if (S.caps && !force) return Promise.resolve(S.caps);
  if (S.capsP && !force) return S.capsP;
  S.capsP = call('GET', force === 'recheck' ? '/caps?recheck=1' : '/caps').then(function (c) { S.caps = c; S.capsP = null; return c; }, function (e) { S.capsP = null; throw e; });
  return S.capsP;
}
function jobs(force) {
  if (!force && S.jobsCache && Date.now() - S.jobsAt < 4000) return Promise.resolve(S.jobsCache);
  return call('GET', '/jobs?limit=200').then(function (j) { S.jobsCache = j.items || []; S.jobsAt = Date.now(); return S.jobsCache; });
}
function speciesInfo(code) {
  var c = S.caps && (S.caps.species || []).filter(function (s) { return s.code === code; })[0];
  return c || { code: code, name: code || '—', short: '?', color: '#9e9e9e', group: 'conifer', id: 30 };
}
function statusChip(j) {
  var st = j.status, p = Math.round(+j.progress || 0);
  var map = { queued: ['В очереди', 'q'], running: ['Обработка ' + p + '%', 'r'], done: ['Готово', 'ok'], error: ['Ошибка', 'err'], cancelled: ['Отменено', 'off'] };
  var m = map[st] || [st || '—', 'off'];
  return '<span class="llw-chip ' + m[1] + '">' + esc(m[0]) + '</span>';
}
function modeOf(j) { return (j && j.meta && j.meta.mode) || 3; }
function ringAreaHa(ring) {
  if (!ring || ring.length < 4) return 0;
  var lat0 = 0; ring.forEach(function (p) { lat0 += p[1]; }); lat0 /= ring.length;
  var kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540, s = 0;
  for (var i = 0; i < ring.length - 1; i++) s += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky;
  return Math.abs(s) / 2 / 1e4;
}
function geomAreaHa(g) {
  var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates, a = 0;
  polys.forEach(function (pc) { a += ringAreaHa(pc[0]); for (var i = 1; i < pc.length; i++) a -= ringAreaHa(pc[i]); });
  return Math.max(0, a);
}

/* ───────────── стили ───────────── */
function css() {
  if (document.getElementById('llw-css')) return;
  var st = document.createElement('style'); st.id = 'llw-css';
  st.textContent = [
    ':root{--llw-acc:var(--icon-accent,#82e938);--llw-bg:#13241a;--llw-bg2:#182d20;--llw-line:rgba(130,233,56,.22);--llw-txt:#e8f5e9;--llw-sub:#a9c4ab}',
    /* блок в окне выбора 3D */
    '.llw-pick{margin:0 10px 8px;border:1px solid var(--llw-line);border-radius:11px;background:linear-gradient(180deg,rgba(130,233,56,.10),rgba(130,233,56,.03));padding:8px 10px;color:var(--llw-txt)}',
    '.llw-pick-h{display:flex;align-items:center;gap:7px;font-weight:700;cursor:pointer;user-select:none}',
    '.llw-pick-h i.fa-tree{color:var(--llw-acc)}.llw-pick-h .llw-car{margin-left:4px;opacity:.7;transition:transform .2s}.llw-pick.closed .llw-car{transform:rotate(-90deg)}',
    '.llw-pick-h .llw-badge{margin-left:auto}',
    '.llw-pick.closed .llw-pick-b{display:none}',
    '.llw-pick-sub{font-size:11.5px;color:var(--llw-sub);margin:3px 0 7px}',
    '.llw-pick-btns{display:flex;flex-wrap:wrap;gap:6px}',
    '.llw-pick-btns button{flex:1 1 auto;min-height:30px;padding:5px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font:600 12px Lato,Arial,sans-serif;cursor:pointer}',
    '.llw-pick-btns button.pri{background:var(--llw-acc);color:#10220f;border-color:var(--llw-acc)}',
    '.llw-pick-btns button:hover{filter:brightness(1.1)}',
    '.llw-pick-btns button b{display:inline-block;min-width:16px;padding:0 4px;border-radius:8px;background:rgba(0,0,0,.25);margin-left:3px}',
    '.llw-pick-jobs{list-style:none;margin:7px 0 0!important;padding:0!important;display:flex;flex-direction:column;gap:4px;overflow:visible!important}',
    '.llw-pick-jobs li{display:block!important;padding:5px 7px!important;border-radius:7px;background:rgba(0,0,0,.18);cursor:pointer;font-size:12px}',
    '.llw-pick-jobs li:hover{background:rgba(130,233,56,.14)!important}',
    '.llw-pick-jobs .t{display:flex;gap:6px;align-items:center}.llw-pick-jobs .t span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.llw-pick-jobs .s{color:var(--llw-sub);font-size:11px;margin-top:2px}',
    '.llw-mini{height:3px;border-radius:2px;background:rgba(255,255,255,.12);margin-top:4px;overflow:hidden}.llw-mini i{display:block;height:100%;background:var(--llw-acc);transition:width .3s}',
    '.llw-badge{font:700 10.5px Lato,Arial,sans-serif;padding:2px 7px;border-radius:9px;white-space:nowrap}',
    '.llw-badge.ok{background:rgba(130,233,56,.2);color:#b9f58f}.llw-badge.warn{background:rgba(255,213,74,.18);color:#ffe08a}.llw-badge.off{background:rgba(255,255,255,.1);color:#cfd8cf}',
    '.llw-chip{display:inline-block;font:700 10.5px Lato,Arial,sans-serif;padding:2px 7px;border-radius:9px;white-space:nowrap;background:rgba(255,255,255,.1)}',
    '.llw-chip.ok{background:rgba(130,233,56,.22);color:#c4f7a0}.llw-chip.r{background:rgba(124,196,255,.2);color:#b9e0ff}.llw-chip.q{background:rgba(255,213,74,.18);color:#ffe08a}.llw-chip.err{background:rgba(255,120,100,.2);color:#ffb4a6}.llw-chip.off{color:#cfd8cf}',
    /* модальное окно */
    '#llw-modal{position:fixed;inset:0;z-index:10060;background:rgba(4,10,5,.58);display:flex;align-items:center;justify-content:center;font:13px/1.45 Lato,Arial,sans-serif;color:var(--llw-txt)}',
    '#llw-modal *{box-sizing:border-box}',
    '#llw-modal .llw-win{width:min(1120px,97vw);height:min(880px,95vh);display:flex;flex-direction:column;background:var(--llw-bg);border:1px solid var(--llw-line);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}',
    '#llw-modal .llw-top{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07);background:var(--llw-bg2)}',
    '#llw-modal .llw-title{font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px;white-space:nowrap}',
    '#llw-modal .llw-title i{color:var(--llw-acc)}',
    '#llw-modal .llw-nav{display:flex;gap:4px;margin-left:8px}',
    '#llw-modal .llw-nav button{border:1px solid transparent;background:none;color:var(--llw-sub);padding:6px 11px;border-radius:9px;font:700 12.5px Lato,Arial,sans-serif;cursor:pointer}',
    '#llw-modal .llw-nav button.on{color:var(--llw-txt);background:rgba(130,233,56,.14);border-color:var(--llw-line)}',
    '#llw-modal .llw-x{margin-left:auto;width:34px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;font-size:20px;cursor:pointer;line-height:1}',
    '#llw-modal .llw-steps{display:flex;gap:4px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.06);overflow-x:auto}',
    '#llw-modal .llw-step{display:flex;align-items:center;gap:7px;padding:5px 10px 5px 5px;border-radius:20px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:var(--llw-sub);font:700 12px Lato,Arial,sans-serif;white-space:nowrap;cursor:default}',
    '#llw-modal .llw-step b{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,.1);font-size:11.5px}',
    '#llw-modal .llw-step.done{color:#cfe9cf;cursor:pointer}#llw-modal .llw-step.done b{background:rgba(130,233,56,.3);color:#d8ffbf}',
    '#llw-modal .llw-step.cur{color:#10220f;background:var(--llw-acc);border-color:var(--llw-acc)}#llw-modal .llw-step.cur b{background:rgba(0,0,0,.18);color:#10220f}',
    '#llw-modal .llw-step-sep{flex:0 0 14px;align-self:center;height:1px;background:rgba(255,255,255,.15)}',
    '#llw-modal .llw-main{flex:1;overflow:auto;padding:14px 16px}',
    '#llw-modal .llw-foot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid rgba(255,255,255,.07);background:var(--llw-bg2)}',
    '#llw-modal .llw-foot .llw-msg{flex:1;color:var(--llw-sub);font-size:12px}',
    '#llw-modal .llw-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:14px;align-items:start}',
    '@media (max-width:860px){#llw-modal .llw-grid{grid-template-columns:1fr}#llw-modal .llw-win{width:100vw;height:100vh;border-radius:0}#llw-modal .llw-title span{display:none}}',
    '#llw-modal .llw-card{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);border-radius:12px;padding:12px 13px;margin-bottom:12px}',
    '#llw-modal .llw-card h3{margin:0 0 9px;font-size:13.5px;display:flex;align-items:center;gap:7px}',
    '#llw-modal .llw-card h3 i{color:var(--llw-acc)}#llw-modal .llw-card h3 .llw-r{margin-left:auto;font-weight:600;font-size:12px}',
    '#llw-modal .llw-sub{color:var(--llw-sub);font-size:12px}',
    '#llw-modal .llw-btn{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:6px 13px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font:700 12.5px Lato,Arial,sans-serif;cursor:pointer;text-decoration:none}',
    '#llw-modal .llw-btn:hover{filter:brightness(1.12)}#llw-modal .llw-btn:disabled{opacity:.45;cursor:not-allowed;filter:none}',
    '#llw-modal .llw-btn.pri{background:var(--llw-acc);color:#10220f;border-color:var(--llw-acc)}',
    '#llw-modal .llw-btn.danger{border-color:rgba(255,120,100,.45);color:#ffb4a6}',
    '#llw-modal .llw-btn.sm{min-height:28px;padding:3px 9px;font-size:12px}',
    '#llw-modal .llw-link{background:none;border:none;color:var(--llw-acc);cursor:pointer;font:600 12px Lato,Arial,sans-serif;padding:0;text-decoration:underline}',
    '#llw-modal .llw-drop{border:2px dashed rgba(130,233,56,.35);border-radius:12px;padding:18px;text-align:center;cursor:pointer;background:rgba(130,233,56,.04);transition:background .15s,border-color .15s}',
    '#llw-modal .llw-drop.over{background:rgba(130,233,56,.13);border-color:var(--llw-acc)}',
    '#llw-modal .llw-drop i{font-size:24px;color:var(--llw-acc);display:block;margin-bottom:6px}',
    '#llw-modal .llw-drop b{display:block;font-size:13.5px;margin-bottom:3px}',
    '#llw-modal .llw-bar{height:7px;border-radius:4px;background:rgba(255,255,255,.1);overflow:hidden;margin:7px 0 4px}#llw-modal .llw-bar i{display:block;height:100%;background:linear-gradient(90deg,#59a14f,var(--llw-acc));transition:width .3s}',
    '#llw-modal .llw-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:7px 0}',
    '#llw-modal .llw-f{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;font-size:12px;color:var(--llw-sub)}',
    '#llw-modal .llw-f>span{font-weight:700;color:#d6e9d6}',
    '#llw-modal input[type=text],#llw-modal input[type=number],#llw-modal input[type=search],#llw-modal select{background:rgba(0,0,0,.28);color:var(--llw-txt);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:7px 9px;font:13px Lato,Arial,sans-serif;min-height:34px;outline:none}',
    '#llw-modal input:focus,#llw-modal select:focus{border-color:var(--llw-acc)}',
    '#llw-modal .llw-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '#llw-modal .llw-three{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
    '@media (max-width:560px){#llw-modal .llw-two,#llw-modal .llw-three{grid-template-columns:1fr}}',
    '#llw-modal .llw-sw{display:flex;gap:10px;align-items:flex-start;padding:10px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.1);margin-bottom:8px;cursor:pointer;background:rgba(0,0,0,.12)}',
    '#llw-modal .llw-sw input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--llw-acc);flex:0 0 auto}',
    '#llw-modal .llw-sw b{display:block;font-size:13px}#llw-modal .llw-sw.dis{opacity:.5;cursor:not-allowed}',
    '#llw-modal .llw-mode{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(130,233,56,.1);border:1px solid var(--llw-line);margin:4px 0 12px}',
    '#llw-modal .llw-mode .n{font:800 22px Lato,Arial,sans-serif;color:var(--llw-acc);min-width:26px;text-align:center}',
    '#llw-modal .llw-chk{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
    '#llw-modal .llw-chk li{display:flex;gap:8px;align-items:flex-start;font-size:12.5px}',
    '#llw-modal .llw-chk li i{margin-top:2px;width:15px;text-align:center}',
    '#llw-modal .llw-chk .ok i{color:var(--llw-acc)}#llw-modal .llw-chk .warn i{color:#ffd54a}#llw-modal .llw-chk .bad i{color:#ff8a80}#llw-modal .llw-chk .na i{color:#8aa08b}',
    '#llw-modal .llw-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12.5px}',
    '#llw-modal .llw-kv dt{color:var(--llw-sub)}#llw-modal .llw-kv dd{margin:0;font-weight:600;word-break:break-word}',
    '#llw-modal .llw-polys{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
    '#llw-modal .llw-poly{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.18)}',
    '#llw-modal .llw-poly .sw{width:12px;height:12px;border-radius:3px;flex:0 0 auto}',
    '#llw-modal .llw-poly span.nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#llw-modal .llw-poly select{min-height:28px;padding:3px 6px}',
    '#llw-modal .llw-prev{width:100%;height:220px;border-radius:10px;background:#0d1a11;border:1px solid rgba(255,255,255,.08)}',
    '#llw-modal .llw-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '#llw-modal .llw-chips label{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:16px;border:1px solid rgba(255,255,255,.14);cursor:pointer;font-size:12.5px;background:rgba(0,0,0,.15)}',
    '#llw-modal .llw-chips label.on{border-color:var(--llw-acc);background:rgba(130,233,56,.13)}',
    '#llw-modal .llw-chips input{display:none}',
    '#llw-modal .llw-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:0 0 auto}',
    '#llw-modal details.llw-adv{border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px 11px;margin-bottom:10px;background:rgba(0,0,0,.1)}',
    '#llw-modal details.llw-adv summary{cursor:pointer;font-weight:700;color:#d6e9d6}',
    '#llw-modal .llw-hint{font-size:11.5px;color:var(--llw-sub);margin-top:-2px}',
    '#llw-modal .llw-rev{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}',
    '#llw-modal .llw-stages{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}',
    '#llw-modal .llw-stages li{display:flex;gap:10px;align-items:center;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.12)}',
    '#llw-modal .llw-stages li i{width:18px;text-align:center;color:#6f8a70}',
    '#llw-modal .llw-stages li.done i{color:var(--llw-acc)}#llw-modal .llw-stages li.cur{border-color:var(--llw-line);background:rgba(130,233,56,.08)}#llw-modal .llw-stages li.cur i{color:#7cc4ff}',
    '#llw-modal .llw-stages li .p{margin-left:auto;font-weight:700;color:var(--llw-sub)}',
    '#llw-modal pre.llw-log{max-height:260px;overflow:auto;background:#09130c;border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:8px 10px;font:11.5px/1.45 Consolas,Menlo,monospace;color:#b8d4b9;white-space:pre-wrap;margin:8px 0 0}',
    '#llw-modal .llw-big{font:800 30px Lato,Arial,sans-serif;color:var(--llw-acc)}',
    '#llw-modal .llw-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px;margin-bottom:12px}#llw-modal .llw-mc .v{overflow-wrap:anywhere}',
    '#llw-modal .llw-mc{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px 12px;background:linear-gradient(180deg,rgba(130,233,56,.08),rgba(255,255,255,.02))}',
    '#llw-modal .llw-mc .k{font-size:11.5px;color:var(--llw-sub);display:flex;gap:6px;align-items:center}#llw-modal .llw-mc .k i{color:var(--llw-acc)}',
    '#llw-modal .llw-mc .v{font:800 21px Lato,Arial,sans-serif;margin-top:3px}#llw-modal .llw-mc .u{font-size:11.5px;color:var(--llw-sub)}',
    '#llw-modal .llw-tabs2{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08)}',
    '#llw-modal .llw-tabs2 button{border:none;background:none;color:var(--llw-sub);padding:8px 12px;font:700 12.5px Lato,Arial,sans-serif;cursor:pointer;border-bottom:2px solid transparent}',
    '#llw-modal .llw-tabs2 button.on{color:var(--llw-txt);border-bottom-color:var(--llw-acc)}',
    '#llw-modal table.llw-t{width:100%;border-collapse:collapse;font-size:12.5px}',
    '#llw-modal table.llw-t th{text-align:left;color:var(--llw-sub);font-weight:700;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.12);white-space:nowrap;position:sticky;top:0;background:var(--llw-bg)}',
    '#llw-modal table.llw-t th[data-sort]{cursor:pointer}#llw-modal table.llw-t th.on{color:var(--llw-acc)}',
    '#llw-modal table.llw-t td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.05)}#llw-modal table.llw-t td.n,#llw-modal table.llw-t th.n{text-align:right;font-variant-numeric:tabular-nums}',
    '#llw-modal table.llw-t tr.tot td{font-weight:800;border-top:1px solid rgba(255,255,255,.2)}',
    '#llw-modal table.llw-t tbody tr:hover td{background:rgba(130,233,56,.05)}',
    '#llw-modal .llw-tw{max-height:430px;overflow:auto;border:1px solid rgba(255,255,255,.07);border-radius:10px}',
    '#llw-modal .llw-pies{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}',
    '#llw-modal .llw-pie{display:flex;gap:12px;align-items:center}',
    '#llw-modal .llw-leg{list-style:none;margin:0;padding:0;font-size:12px;display:flex;flex-direction:column;gap:4px}',
    '#llw-modal .llw-leg li{display:flex;gap:6px;align-items:center}',
    '#llw-modal .llw-tiers{display:flex;height:22px;border-radius:7px;overflow:hidden;margin:6px 0}',
    '#llw-modal .llw-tiers i{display:flex;align-items:center;justify-content:center;font:700 11px Lato,Arial,sans-serif;color:#0d1a0f;min-width:0;overflow:hidden;white-space:nowrap}',
    '#llw-modal .llw-hist{display:flex;align-items:flex-end;gap:2px;height:150px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.15)}',
    '#llw-modal .llw-hist .c{flex:1;display:flex;flex-direction:column-reverse;min-width:6px;position:relative}',
    '#llw-modal .llw-hist .c i{display:block}',
    '#llw-modal .llw-hx{display:flex;gap:2px;font-size:10.5px;color:var(--llw-sub)}#llw-modal .llw-hx span{flex:1;text-align:center;min-width:6px}',
    '#llw-modal .llw-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
    '#llw-modal .llw-files li{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:9px;background:rgba(0,0,0,.15)}',
    '#llw-modal .llw-files li .nm{flex:1}#llw-modal .llw-files li .nm small{display:block;color:var(--llw-sub)}',
    '#llw-modal .llw-empty{padding:30px;text-align:center;color:var(--llw-sub)}',
    '#llw-modal .llw-err{color:#ffb4a6}',
    '#llw-modal .llw-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;font-size:12px;color:var(--llw-sub)}',
    '#llw-modal .llw-flag{display:inline-flex;align-items:center;gap:5px;font-size:11.5px}',
    '#llw-modal .llw-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:var(--llw-acc);border-radius:50%;animation:llwspin .8s linear infinite;vertical-align:-2px}',
    '@keyframes llwspin{to{transform:rotate(360deg)}}',
    '#llw-crs{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:5}',
    '#llw-crs .box{width:min(520px,94%);max-height:80%;display:flex;flex-direction:column;background:var(--llw-bg2);border:1px solid var(--llw-line);border-radius:14px;padding:14px}',
    '#llw-crs ul{list-style:none;margin:8px 0;padding:0;overflow:auto;flex:1}#llw-crs li{padding:7px 9px;border-radius:8px;cursor:pointer}#llw-crs li:hover,#llw-crs li.on{background:rgba(130,233,56,.14)}',
    /* карточка в 3D */
    '#v3d-ll .llw-3d-job{padding:6px 0;border-top:1px solid rgba(255,255,255,.07)}#v3d-ll .llw-3d-job:first-child{border-top:none}',
    '#v3d-ll .llw-3d-job .t{display:flex;gap:6px;align-items:center}#v3d-ll .llw-3d-job .t span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#v3d-ll .llw-3d-job .s{font-size:11.5px;color:#a8c3a8;margin:2px 0 0 22px}',
    '#v3d-ll .llw-3d-job button{background:none;border:none;color:#cfe9cf;cursor:pointer;padding:2px 4px}',
    '#v3d-ll .llw-3d-leg{display:flex;flex-wrap:wrap;gap:4px 10px;margin:4px 0 0 22px;font-size:11px;color:#cfe0cf}',
    '#v3d-ll .llw-3d-leg span{display:inline-flex;align-items:center;gap:4px}',
    '#v3d-ll .llw-3d-act{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '#v3d-ll .llw-3d-cm{display:flex;gap:6px;align-items:center;font-size:12px;margin:0 0 6px;color:#cfe0cf}#v3d-ll .llw-3d-cm button{padding:3px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:inherit;cursor:pointer;font:600 11.5px Lato,Arial,sans-serif}#v3d-ll .llw-3d-cm button.on{background:rgba(130,233,56,.22);border-color:#82e938;color:#fff}',
    '#v3d-ll .llw-3d-act button{flex:1 1 auto;padding:6px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;font:600 12px Lato,Arial,sans-serif;cursor:pointer}',
    '#v3d-ll .llw-3d-act button.pri{background:#82e938;color:#10220f;border-color:#82e938}'
  ].join('\n');
  document.head.appendChild(st);
}

/* ───────────── контуры: KML / GeoJSON в браузере ───────────── */
function parseGeoJSON(txt) {
  var j = JSON.parse(txt), out = [];
  function add(g, name) {
    if (!g) return;
    if (g.type === 'GeometryCollection') { (g.geometries || []).forEach(function (x) { add(x, name); }); return; }
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return;
    var first = g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates[0][0][0];
    if (!first || Math.abs(first[0]) > 180 || Math.abs(first[1]) > 90) throw new Error('координаты не в градусах WGS-84 — пересохраните GeoJSON в EPSG:4326 или загрузите ZIP с SHP и .prj');
    out.push({ name: name, geom: { type: g.type, coordinates: g.coordinates } });
  }
  var feats = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ geometry: j, properties: {} }];
  (feats || []).forEach(function (f, i) {
    var p = f.properties || {};
    add(f.geometry, p.name || p.NAME || p.title || p.vydel || p.quarter || ('Полигон ' + (i + 1)));
  });
  return out;
}
function parseKML(txt) {
  var doc = new DOMParser().parseFromString(txt, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('KML повреждён');
  function ring(el) {
    var c = el && el.getElementsByTagName('coordinates')[0];
    if (!c) return null;
    var pts = c.textContent.trim().split(/\s+/).map(function (t) { var a = t.split(','); return [+a[0], +a[1]]; }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    if (pts.length < 3) return null;
    var f = pts[0], l = pts[pts.length - 1]; if (f[0] !== l[0] || f[1] !== l[1]) pts.push([f[0], f[1]]);
    return pts;
  }
  var out = [];
  $$('Placemark', doc).forEach(function (pm, i) {
    var nm = pm.getElementsByTagName('name')[0], name = nm ? nm.textContent.trim() : 'Полигон ' + (i + 1);
    var polys = [];
    Array.prototype.forEach.call(pm.getElementsByTagName('Polygon'), function (pg) {
      var ob = pg.getElementsByTagName('outerBoundaryIs')[0], o = ring(ob); if (!o) return;
      var rings = [o];
      Array.prototype.forEach.call(pg.getElementsByTagName('innerBoundaryIs'), function (ib) { var r = ring(ib); if (r) rings.push(r); });
      polys.push(rings);
    });
    if (polys.length === 1) out.push({ name: name, geom: { type: 'Polygon', coordinates: polys[0] } });
    else if (polys.length > 1) out.push({ name: name, geom: { type: 'MultiPolygon', coordinates: polys } });
  });
  return out;
}
function guessRole(name) {
  var n = String(name || '').toLowerCase();
  if (/нэп|не\s*экспл|дорог|водо|болот|исключ|exclu|road|water/.test(n)) return 'nep';
  if (/выдел|vydel|stand/.test(n)) return 'vydel';
  return 'lesoseka';
}

/* ───────────── загрузка LAS/LAZ кусками с докачкой ───────────── */
function Uploader(file, on) {
  var self = { file: file, sent: 0, total: file.size, paused: false, aborted: false, speed: 0, uid: null, xhr: null };
  var t0 = 0, b0 = 0;
  function chunk(uid, off, size) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest(); self.xhr = x;
      x.open('POST', API + '/upload/' + encodeURIComponent(uid) + '/chunk?offset=' + off);
      x.withCredentials = true; x.setRequestHeader('X-CSRFToken', csrf()); x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = function (e) { self.sent = off + e.loaded; tick(); };
      x.onload = function () {
        self.xhr = null;
        if (x.status >= 200 && x.status < 300) { try { res(JSON.parse(x.responseText)); } catch (e) { res({ received: off + size }); } }
        else { var m = 'HTTP ' + x.status; try { m = JSON.parse(x.responseText).detail || m; } catch (e) {} rej(new Error(m)); }
      };
      x.onerror = function () { self.xhr = null; rej(new Error('сеть недоступна')); };
      x.onabort = function () { self.xhr = null; rej(new Error('abort')); };
      x.send(file.slice(off, off + size));
    });
  }
  function tick() {
    var now = performance.now();
    if (now - t0 > 700) { var sp = (self.sent - b0) / ((now - t0) / 1000); self.speed = self.speed ? self.speed * 0.6 + sp * 0.4 : sp; t0 = now; b0 = self.sent; }
    on.progress && on.progress(self);
  }
  async function run() {
    try {
      var init = await call('POST', '/upload/init', { name: file.name, size: file.size, last_modified: file.lastModified || 0 });
      self.uid = init.upload_id; self.sent = init.received || 0; t0 = performance.now(); b0 = self.sent;
      if (init.resumed && self.sent) on.note && on.note('Продолжение загрузки с ' + bytes(self.sent));
      var cs = init.chunk_bytes || 32 * 1048576, retry = 0;
      while (self.sent < file.size) {
        if (self.aborted) throw new Error('abort');
        if (self.paused) { await new Promise(function (r) { setTimeout(r, 300); }); continue; }
        var off = self.sent, size = Math.min(cs, file.size - off);
        try { var r = await chunk(self.uid, off, size); self.sent = Math.max(off + size, r.received || 0); retry = 0; tick(); }
        catch (e) {
          if (self.aborted || e.message === 'abort') { if (self.paused && !self.aborted) continue; throw e; }
          if (++retry > 5) throw e;
          on.note && on.note('Сбой сети, повтор ' + retry + ' из 5…');
          await new Promise(function (r) { setTimeout(r, 1500 * retry); });
          try { var st = await call('GET', '/upload/' + encodeURIComponent(self.uid)); self.sent = st.received || self.sent; } catch (e2) {}
        }
      }
      on.note && on.note('Проверка файла на сервере…');
      var meta = await call('POST', '/upload/' + encodeURIComponent(self.uid) + '/complete');
      on.done && on.done(meta);
    } catch (e) {
      if (self.aborted || e.message === 'abort') { on.cancel && on.cancel(); return; }
      on.error && on.error(e);
    }
  }
  self.pause = function () { self.paused = true; if (self.xhr) self.xhr.abort(); };
  self.resume = function () { self.paused = false; };
  self.abort = function () {
    self.aborted = true; if (self.xhr) self.xhr.abort();
    if (self.uid) call('DELETE', '/upload/' + encodeURIComponent(self.uid)).catch(function () {});
  };
  run();
  return self;
}

/* ───────────── модальное окно ───────────── */
function modal() {
  css();
  if (S.modal && document.body.contains(S.modal.el)) return S.modal;
  var el = document.createElement('div'); el.id = 'llw-modal';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'ЛесоЛидар — обработка облаков точек');
  el.innerHTML = '<div class="llw-win"><header class="llw-top"><div class="llw-title"><i class="fa-solid fa-tree"></i>ЛесоЛидар <span>· таксация по облаку точек</span></div>' +
    '<nav class="llw-nav"><button type="button" data-nav="wizard">Новая обработка</button><button type="button" data-nav="history">Мои обработки</button></nav>' +
    '<button type="button" class="llw-x" title="Закрыть (Esc)" aria-label="Закрыть">&times;</button></header>' +
    '<div class="llw-steps"></div><div class="llw-main"></div><footer class="llw-foot"></footer></div>';
  document.body.appendChild(el);
  var M = { el: el, steps: $('.llw-steps', el), main: $('.llw-main', el), foot: $('.llw-foot', el), view: '', timers: [] };
  ['pointerdown', 'wheel', 'keydown', 'contextmenu'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.stopPropagation(); }); });
  el.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('#llw-crs', el)) { $('#llw-crs', el).remove(); return; }
    var t = e.target; if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) { t.blur(); return; }
    close();
  });
  $('.llw-x', el).onclick = close;
  el.addEventListener('mousedown', function (e) { if (e.target === el) el._down = true; });
  el.addEventListener('click', function (e) { if (e.target === el && el._down) close(); el._down = false; });
  $$('[data-nav]', el).forEach(function (b) { b.onclick = function () { if (b.dataset.nav === 'wizard') openWizard(S.wiz && S.wiz.ctx); else openHistory(); }; });
  S.modal = M;
  setTimeout(function () { try { $('.llw-x', el).focus({ preventScroll: true }); } catch (e) {} }, 30);
  return M;
}
function clearTimers() { var M = S.modal; if (!M) return; M.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); M.timers = []; if (M.abort) { try { M.abort.abort(); } catch (e) {} M.abort = null; } }
function close() {
  if (!S.modal) return;
  if (S.wiz && S.wiz.up && !S.wiz.up.aborted && S.wiz.up.sent < S.wiz.up.total) {
    if (!confirm('Идёт загрузка облака. Прервать? (загрузку можно будет продолжить позже — выберите тот же файл)')) return;
    S.wiz.up.pause();
  }
  clearTimers();
  S.modal.el.remove(); S.modal = null;
  refreshPickers();
}
function setNav(view) { var M = S.modal; M.view = view; $$('[data-nav]', M.el).forEach(function (b) { b.classList.toggle('on', b.dataset.nav === (view === 'history' ? 'history' : 'wizard')); }); }

/* ───────────── мастер ───────────── */
function copy(o) { return JSON.parse(JSON.stringify(o || {})); }
function newWizard(ctx) {
  var c = S.caps || {}, pr = prefs();
  var W = {
    step: 0, max: 0, ctx: ctx || {}, file: null, up: null, upNote: '', polys: [], zip: null,
    contour: (ctx && ctx.scene && ctx.scene.geojson) ? 'scene' : 'none',
    epsg: null, classify: pr.classify !== false, volume: pr.volume !== false,
    region: pr.region || 'Беларусь', subregion: pr.subregion || REGIONS['Беларусь'][1], season: 'summer', age: '',
    model: pr.model || '', name: '', species: (c.default_species || []).slice(), ranks: {},
    params: copy(c.defaults), preset: 'balanced', job: null, parent: null, demo: { size: 120, density: 40 }
  };
  if (!W.params.species) W.params.species = W.species.slice();
  return W;
}
function wizardFromJob(j, ctx) {
  var W = newWizard(ctx);
  var p = j.params || {}, m = j.meta || {};
  W.params = Object.assign(copy(S.caps && S.caps.defaults), copy(p));
  W.species = (p.species || W.species).slice(); W.ranks = copy(p.height_ranks || {});
  W.season = p.season || 'summer'; W.model = p.model_path || '';
  var reg = String(p.region || 'Беларусь').split(' · '); W.region = REGIONS[reg[0]] ? reg[0] : 'Другой'; if (reg[1]) W.subregion = reg[1];
  W.classify = (m.mode || 3) >= 2; W.volume = (m.mode || 3) >= 3; W.age = m.age || '';
  W.epsg = p.epsg || null; W.name = j.name || ''; W.parent = j.id; W.job = j;
  W.contour = 'none';
  W.preset = '';
  return W;
}
function mode(W) { return W.classify ? (W.volume ? 3 : 2) : 1; }
function fileEpsg(f) { return f && f.info && (f.info.epsg || (f.info.crs ? 'wkt' : null)); }
function canNext(W) {
  if (W.step === 0) return !!W.file && !(W.up) && !!(fileEpsg(W.file) || W.epsg) && !(W.contour === 'file' && !W.polys.length && !W.zip);
  if (W.step === 1) return true;
  if (W.step === 2) return !W.classify || W.species.length > 0;
  return true;
}
function openWizard(ctx, opts) {
  opts = opts || {};
  var M = modal(); clearTimers(); setNav('wizard');
  M.main.innerHTML = '<div class="llw-empty"><span class="llw-spin"></span> Подготовка мастера…</div>'; M.steps.innerHTML = ''; M.foot.innerHTML = '';
  caps().then(function (c) {
    if (!S.wiz || opts.fresh || (S.wiz.job && S.wiz.step >= 4)) S.wiz = newWizard(ctx);
    else if (ctx) S.wiz.ctx = ctx;
    if (opts.file) { S.wiz.file = opts.file; }
    renderWizard();
    if (opts.demo) setTimeout(function () { var b = $('[data-a=demo-open]', M.main); if (b) b.click(); }, 50);
  }).catch(function (e) { M.main.innerHTML = '<div class="llw-empty llw-err">Обработчик недоступен: ' + esc(e.message) + '</div>'; });
}
function go(step) { var W = S.wiz; if (step < 0 || step > W.max) return; W.step = step; renderWizard(); }
function renderSteps(W) {
  var M = S.modal;
  M.steps.innerHTML = STEP_NAMES.map(function (n, i) {
    var cls = i === W.step ? 'cur' : (i <= W.max ? 'done' : '');
    return (i ? '<span class="llw-step-sep"></span>' : '') + '<span class="llw-step ' + cls + '" data-step="' + i + '"' +
      (cls === 'done' ? ' role="button" tabindex="0" title="Перейти к шагу «' + n + '»"' : '') + '><b>' + (cls === 'done' ? '✓' : (i + 1)) + '</b>' + n + '</span>';
  }).join('');
  $$('.llw-step.done', M.steps).forEach(function (s) {
    function act() {
      var i = +s.dataset.step;
      if (W.job && W.step >= 4 && i < 4) { reviseFrom(W.job, i); return; }
      go(i);
    }
    s.onclick = act; s.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } };
  });
}
function reviseFrom(job, step) {
  // пересчёт: те же данные, новые параметры → новая версия задания
  var W = wizardFromJob(job, S.wiz && S.wiz.ctx);
  call('GET', '/files/' + encodeURIComponent(job.file_id)).then(function (f) {
    W.file = f; W.max = 3; W.step = step; W.job = null; S.wiz = W; renderWizard();
    toast('Пересчёт: измените параметры и запустите — будет создана версия ' + ((job.version || 1) + 1));
  }).catch(function (e) { toast('Исходный файл недоступен: ' + e.message, true); });
}
function renderWizard() {
  var W = S.wiz, M = S.modal; if (!M) return;
  clearTimers();
  renderSteps(W);
  M.main.scrollTop = 0;
  [step1, step2, step3, step4, step5, step6][W.step](W, M.main, M.foot);
}
function foot(M, W, opt) {
  opt = opt || {};
  M.foot.innerHTML = '<span class="llw-msg">' + (opt.msg || '') + '</span>' +
    (W.step > 0 && W.step < 4 ? '<button type="button" class="llw-btn" data-f="back"><i class="fa-solid fa-arrow-left"></i> Назад</button>' : '') +
    (opt.extra || '') +
    (W.step < 3 ? '<button type="button" class="llw-btn pri" data-f="next"' + (canNext(W) ? '' : ' disabled') + '>Далее <i class="fa-solid fa-arrow-right"></i></button>' : '');
  var b = $('[data-f=back]', M.foot); if (b) b.onclick = function () { go(W.step - 1); };
  var n = $('[data-f=next]', M.foot); if (n) n.onclick = function () { if (!canNext(W)) return; W.step++; W.max = Math.max(W.max, W.step); renderWizard(); };
}
function refreshNext() { var W = S.wiz, M = S.modal; if (!M) return; var n = $('[data-f=next]', M.foot); if (n) n.disabled = !canNext(W); }

/* ───────────── шаг 1: входные данные ───────────── */
function isAdmin() { return !!(S.caps && S.caps.is_admin); }
/* [v20.10] подсказка администратору: куда положить программу (точный путь на сервере) */
function setupHtml(c) {
  var s = c && c.setup; if (!s) return '';
  var C = function (t) { return '<code style="word-break:break-all;color:#e8f5e8">' + esc(t) + '</code>'; };
  return '<div class="llw-sub" style="margin-top:6px;line-height:1.5">Скопируйте папку программы <b>целиком</b> (LesoLidar.exe + _internal, models, tables) так, чтобы был файл ' + C(s.exe) +
    '<br>или впишите в ' + C(s.env_file) + ' строку ' + C('LESOLIDAR_EXE=полный\\путь\\LesoLidar.exe') + '.<br>Перезапуск не нужен — нажмите «Проверить снова».</div>';
}
function problemHead(c, adm) {
  var p = (c.problems || [])[0] || 'Обработчик LesoLidar не найден';
  return (adm && c.setup && /^Не найден LesoLidar\.exe/.test(p)) ? 'LesoLidar.exe не найден' : p;
}
function step1(W, main) {
  var M = S.modal, c = S.caps || {}, f = W.file;
  var engineWarn = !c.available ? '<div class="llw-card" style="border-color:rgba(255,213,74,.4)"><h3><i class="fa-solid fa-triangle-exclamation" style="color:#ffd54a"></i>Обработчик LesoLidar не готов</h3><div class="llw-sub">' +
    esc((c.problems || []).join('; ') || 'Не найден LesoLidar.exe') + '</div>' + (isAdmin() ? setupHtml(c) : '') + '<div class="llw-sub" style="margin-top:6px">Просмотр готовых результатов доступен. Как подключить — README_DEPLOY_RU.md, раздел «ЛесоЛидар».</div></div>' : '';
  main.innerHTML = engineWarn + '<div class="llw-grid"><div>' +
    '<section class="llw-card" data-card="cloud"><h3><i class="fa-solid fa-braille"></i>Облако точек (LAS / LAZ)<span class="llw-r llw-sub">обязательно</span></h3><div data-slot="cloud"></div></section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-draw-polygon"></i>Контуры лесосеки, выделов и НЭП<span class="llw-r llw-sub">рекомендуется</span></h3><div data-slot="contour"></div></section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-globe"></i>Система координат</h3><div data-slot="crs"></div></section>' +
    '</div><div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-circle-info"></i>Сведения об участке</h3><div data-slot="info"></div></section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-list-check"></i>Список требований к данным</h3><div data-slot="checks"></div></section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-map"></i>Превью участка</h3><div data-slot="preview"></div></section>' +
    '</div></div>';
  drawCloud(W); drawContour(W); drawCrs(W); drawInfo(W); drawChecks(W); drawPreview(W);
  foot(M, W, { msg: W.file ? '' : 'Загрузите облако точек или выберите загруженное ранее' });
}
function slot(name) { return S.modal && $('[data-slot="' + name + '"]', S.modal.main); }
function redraw1() { var W = S.wiz; if (!W || W.step !== 0 || !S.modal) return; drawCloud(W); drawContour(W); drawCrs(W); drawInfo(W); drawChecks(W); drawPreview(W); refreshNext(); var m = $('.llw-msg', S.modal.foot); if (m) m.textContent = W.file ? '' : 'Загрузите облако точек или выберите загруженное ранее'; }
function drawCloud(W) {
  var el = slot('cloud'); if (!el) return;
  var c = S.caps || {};
  if (W.up) {
    var u = W.up, p = u.total ? u.sent / u.total * 100 : 0, left = u.speed > 0 ? (u.total - u.sent) / u.speed : null;
    el.innerHTML = '<div style="font-weight:700;word-break:break-all">' + esc(u.file.name) + '</div><div class="llw-bar"><i style="width:' + p.toFixed(1) + '%"></i></div>' +
      '<div class="llw-sub">' + bytes(u.sent) + ' из ' + bytes(u.total) + ' · ' + num(p, 1) + '%' + (u.speed ? ' · ' + bytes(u.speed) + '/с' : '') + (left != null && !u.paused ? ' · осталось ' + dur(left) : '') + (u.paused ? ' · пауза' : '') + '</div>' +
      (W.upNote ? '<div class="llw-sub" style="margin-top:4px">' + esc(W.upNote) + '</div>' : '') +
      '<div class="llw-row"><button type="button" class="llw-btn sm" data-a="pause">' + (u.paused ? '<i class="fa-solid fa-play"></i> Продолжить' : '<i class="fa-solid fa-pause"></i> Пауза') + '</button><button type="button" class="llw-btn sm danger" data-a="cancel"><i class="fa-solid fa-xmark"></i> Отменить</button></div>';
    $('[data-a=pause]', el).onclick = function () { if (u.paused) u.resume(); else u.pause(); drawCloud(W); };
    $('[data-a=cancel]', el).onclick = function () { u.abort(); W.up = null; W.upNote = ''; redraw1(); };
    return;
  }
  if (W.file) {
    var f = W.file, h = f.header || {}, inf = f.info || {};
    el.innerHTML = '<div class="llw-row" style="margin-top:0"><i class="fa-solid fa-file-circle-check" style="color:var(--llw-acc);font-size:20px"></i><div style="flex:1;min-width:0"><div style="font-weight:700;word-break:break-all">' + esc(f.name) + '</div>' +
      '<div class="llw-sub">' + bytes(f.size) + ' · ' + num(inf.points || h.points) + ' точек · LAS ' + esc(inf.version || h.version || '?') + (h.compressed ? ' (LAZ)' : '') + (f.demo ? ' · демо' : '') + '</div></div>' +
      (W.parent ? '' : '<button type="button" class="llw-btn sm" data-a="change">Заменить</button>') + '</div>' +
      (f.info_error ? '<div class="llw-sub llw-err">Проверка обработчиком: ' + esc(f.info_error) + '</div>' : '') +
      (W.parent ? '<div class="llw-sub">Пересчёт версии ' + esc((W.job && W.job.version) || '') + ' — тот же файл, новые параметры.</div>' : '');
    var ch = $('[data-a=change]', el); if (ch) ch.onclick = function () { W.file = null; W.epsg = null; redraw1(); };
    return;
  }
  var admin = isAdmin();
  el.innerHTML = (admin ? '<div class="llw-drop" tabindex="0" role="button" aria-label="Выбрать LAS или LAZ"><i class="fa-solid fa-cloud-arrow-up"></i><b>Перетащите LAS/LAZ сюда или нажмите для выбора</b>' +
      '<span class="llw-sub">до ' + bytes(c.max_upload_bytes || 0) + ' · загрузка частями, прерванную можно продолжить тем же файлом</span><input type="file" accept=".las,.laz" hidden></div>' :
      '<div class="llw-sub">Загрузка и запуск обработки — для администратора. Ниже — облака, загруженные ранее.</div>') +
    '<div class="llw-row" style="margin-top:10px"><select data-a="files" style="flex:1;min-width:0"><option value="">Загруженные ранее облака…</option></select>' +
    (admin && c.demo ? '<button type="button" class="llw-btn" data-a="demo-open" title="Синтетическое облако с известными деревьями — проверить обработку без своих данных"><i class="fa-solid fa-flask"></i> Демо-участок</button>' : '') + '</div>' +
    '<div data-a="demo" hidden></div>';
  var drop = $('.llw-drop', el);
  if (drop) {
    var inp = $('input[type=file]', drop);
    drop.onclick = function () { inp.click(); };
    drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
    inp.onchange = function () { if (inp.files[0]) startUpload(W, inp.files[0]); };
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); var fl = e.dataTransfer.files[0]; if (fl) startUpload(W, fl); });
  }
  var sel = $('[data-a=files]', el);
  call('GET', '/files').then(function (j) {
    var items = (j.items || []).sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    if (!items.length) { sel.innerHTML = '<option value="">Загруженных облаков пока нет</option>'; sel.disabled = true; return; }
    sel.innerHTML = '<option value="">Загруженные ранее облака (' + items.length + ')…</option>' + items.map(function (f) {
      return '<option value="' + esc(f.id) + '">' + esc(f.name) + ' · ' + bytes(f.size) + ' · ' + when(f.created) + (f.jobs ? ' · обработок: ' + f.jobs : '') + '</option>';
    }).join('');
    sel.onchange = function () { var f = items.filter(function (x) { return x.id === sel.value; })[0]; if (f) { W.file = f; W.epsg = null; if (!W.name) W.name = ''; redraw1(); } };
  }).catch(function (e) { sel.innerHTML = '<option>' + esc(e.message) + '</option>'; });
  var dopen = $('[data-a=demo-open]', el);
  if (dopen) dopen.onclick = function () {
    var box = $('[data-a=demo]', el); box.hidden = !box.hidden; if (box.hidden) return;
    var where = W.ctx.scene ? 'в центре 3D-сцены «' + esc(W.ctx.scene.name || W.ctx.scene.code) + '»' : (W.ctx.mapCenter ? 'в центре карты' : 'в точке генератора');
    box.innerHTML = '<div class="llw-card" style="margin:10px 0 0;background:rgba(0,0,0,.15)"><div class="llw-two"><label class="llw-f"><span>Размер участка, м</span><input type="number" min="40" max="400" step="10" value="' + W.demo.size + '" data-d="size"></label>' +
      '<label class="llw-f"><span>Плотность, точек/м²</span><input type="number" min="8" max="150" step="1" value="' + W.demo.density + '" data-d="density"></label></div>' +
      '<div class="llw-sub">Синтетический смешанный древостой (хвойные и лиственные, подрост) с известными деревьями; будет размещён ' + where + '.</div>' +
      '<div class="llw-row"><button type="button" class="llw-btn pri" data-d="make"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать облако</button><span class="llw-sub" data-d="st"></span></div></div>';
    $('[data-d=make]', box).onclick = function () {
      var size = +$('[data-d=size]', box).value, dens = +$('[data-d=density]', box).value, btn = this;
      W.demo = { size: size, density: dens };
      var body = { size: size, density: dens };
      var ll = W.ctx.scene && W.ctx.scene.center ? W.ctx.scene.center : (W.ctx.mapCenter ? W.ctx.mapCenter() : null);
      if (ll) { body.lon = ll[0]; body.lat = ll[1]; if (W.ctx.scene && isFinite(W.ctx.scene.z0)) body.z0 = W.ctx.scene.z0; }
      btn.disabled = true; $('[data-d=st]', box).innerHTML = '<span class="llw-spin"></span> генерация облака (до минуты)…';
      call('POST', '/demo', body).then(function (f) { W.file = f; W.epsg = null; W.name = ''; toast('Демо-облако создано: ' + f.name); redraw1(); })
        .catch(function (e) { btn.disabled = false; $('[data-d=st]', box).innerHTML = '<span class="llw-err">' + esc(e.message) + '</span>'; });
    };
  };
}
function startUpload(W, file) {
  if (!/\.(las|laz)$/i.test(file.name)) { toast('Нужен файл .las или .laz', true); return; }
  var c = S.caps || {};
  if (c.max_upload_bytes && file.size > c.max_upload_bytes) { toast('Файл больше ' + bytes(c.max_upload_bytes), true); return; }
  W.upNote = '';
  var last = 0;
  W.up = Uploader(file, {
    progress: function () { var n = performance.now(); if (n - last > 250) { last = n; drawCloud(W); } },
    note: function (m) { W.upNote = m; drawCloud(W); },
    done: function (meta) { W.up = null; W.upNote = ''; W.file = meta; W.epsg = null; toast('Облако загружено: ' + meta.name); redraw1(); },
    error: function (e) { W.up = null; W.upNote = ''; toast('Загрузка: ' + e.message, true); redraw1(); },
    cancel: function () { W.up = null; W.upNote = ''; redraw1(); }
  });
  drawCloud(W); refreshNext();
}
function drawContour(W) {
  var el = slot('contour'); if (!el) return;
  var sc = W.ctx.scene, admin = isAdmin();
  el.innerHTML = '<div class="llw-chips" style="margin-bottom:8px">' +
    '<label class="' + (W.contour === 'none' ? 'on' : '') + '"><input type="radio" name="llw-ct" value="none"' + (W.contour === 'none' ? ' checked' : '') + '>Без контура — всё облако</label>' +
    (sc && sc.geojson ? '<label class="' + (W.contour === 'scene' ? 'on' : '') + '"><input type="radio" name="llw-ct" value="scene"' + (W.contour === 'scene' ? ' checked' : '') + '>Граница 3D-сцены</label>' : '') +
    '<label class="' + (W.contour === 'file' ? 'on' : '') + '"><input type="radio" name="llw-ct" value="file"' + (W.contour === 'file' ? ' checked' : '') + '>Файл контуров</label></div>' +
    '<div data-c="body"></div>';
  $$('input[name=llw-ct]', el).forEach(function (r) { r.onchange = function () { W.contour = r.value; drawContour(W); drawPreview(W); drawChecks(W); refreshNext(); }; });
  var body = $('[data-c=body]', el);
  if (W.contour === 'none') { body.innerHTML = '<div class="llw-sub">Обрабатывается всё облако; площадь — по фактическому покрытию точками. Для отчётов по лесосеке добавьте её контур.</div>'; return; }
  if (W.contour === 'scene') { body.innerHTML = '<div class="llw-sub">Расчёт в пределах <b>' + esc(sc.name || sc.code) + '</b> (пересечение с охватом облака).</div>'; return; }
  body.innerHTML = '<div class="llw-drop" style="padding:12px" tabindex="0" role="button"><b style="font-size:12.5px">KML, GeoJSON (WGS-84) или ZIP с SHP</b><span class="llw-sub">Несколько полигонов — у каждого выберите тип</span><input type="file" accept=".kml,.geojson,.json,.zip" hidden></div>' +
    '<div class="llw-polys" data-c="list"></div>' +
    '<div class="llw-hint" style="margin-top:8px">«Лесосека» — участок, по которому формируются отчёты; «Выдел» — тоже входит в расчёт; «НЭП» — не эксплуатационная площадь (дороги, водоёмы, болота) — исключается.</div>';
  var drop = $('.llw-drop', body), inp = $('input', drop);
  drop.onclick = function () { inp.click(); };
  drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  inp.onchange = function () { if (inp.files[0]) readContour(W, inp.files[0]); inp.value = ''; };
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); var fl = e.dataTransfer.files[0]; if (fl) readContour(W, fl); });
  var list = $('[data-c=list]', body);
  var colors = { lesoseka: '#82e938', vydel: '#7cc4ff', nep: '#ff7a6b' };
  list.innerHTML = (W.zip ? '<div class="llw-poly"><span class="sw" style="background:#82e938"></span><span class="nm">ZIP-SHP: ' + esc(W.zip.name) + ' (на сервере, тип — лесосека)</span><button type="button" class="llw-link" data-c="rmzip">убрать</button></div>' : '') +
    W.polys.map(function (p, i) {
      return '<div class="llw-poly"><span class="sw" style="background:' + colors[p.role] + '"></span><span class="nm" title="' + esc(p.name) + '">' + esc(p.name) + '</span><span class="llw-sub">' + num(p.area_ha, 2) + ' га</span>' +
        '<select data-i="' + i + '">' + Object.keys(ROLE).map(function (r) { return '<option value="' + r + '"' + (p.role === r ? ' selected' : '') + '>' + ROLE[r] + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="llw-link" data-rm="' + i + '" title="Убрать">✕</button></div>';
    }).join('');
  $$('select[data-i]', list).forEach(function (s) { s.onchange = function () { W.polys[+s.dataset.i].role = s.value; drawContour(W); drawPreview(W); drawChecks(W); }; });
  $$('[data-rm]', list).forEach(function (b) { b.onclick = function () { W.polys.splice(+b.dataset.rm, 1); drawContour(W); drawPreview(W); drawChecks(W); refreshNext(); }; });
  var rz = $('[data-c=rmzip]', list); if (rz) rz.onclick = function () { W.zip = null; drawContour(W); refreshNext(); };
  if (!admin) body.insertAdjacentHTML('beforeend', '<div class="llw-sub" style="margin-top:6px">ZIP-SHP загружается на сервер — только администратор.</div>');
}
function readContour(W, file) {
  var name = file.name.toLowerCase();
  if (/\.zip$/.test(name)) {
    if (!isAdmin()) { toast('Загрузка ZIP — только администратор', true); return; }
    file.arrayBuffer().then(function (buf) { return call('POST', '/boundary?name=' + encodeURIComponent(file.name), buf); })
      .then(function (r) { W.zip = r; drawContour(W); drawChecks(W); refreshNext(); toast('Контур SHP загружен: ' + r.name); })
      .catch(function (e) { toast('Контур: ' + e.message, true); });
    return;
  }
  file.text().then(function (txt) {
    var polys = /\.kml$/.test(name) ? parseKML(txt) : parseGeoJSON(txt);
    if (!polys.length) throw new Error('в файле нет полигонов');
    polys.forEach(function (p) { p.role = guessRole(p.name); p.area_ha = geomAreaHa(p.geom); W.polys.push(p); });
    drawContour(W); drawPreview(W); drawChecks(W); refreshNext();
    toast('Контуров добавлено: ' + polys.length);
  }).catch(function (e) { toast('Контур «' + file.name + '»: ' + e.message, true); });
}
function drawCrs(W) {
  var el = slot('crs'); if (!el) return;
  var f = W.file, fe = f && f.info && f.info.epsg, wkt = f && f.info && f.info.crs && !fe;
  var txt = !f ? '<span class="llw-sub">Определится по файлу облака</span>' :
    W.epsg ? '<b>EPSG:' + W.epsg + '</b> ' + esc(crsName(W.epsg)) + ' <span class="llw-sub">(выбрано вручную)</span>' :
    fe ? '<b>EPSG:' + fe + '</b> ' + esc(crsName(fe)) + ' <span class="llw-sub">(из файла)</span>' :
    wkt ? '<b>Из файла (WKT)</b> <span class="llw-sub">код EPSG не распознан — можно указать вручную</span>' :
    '<span class="llw-err"><i class="fa-solid fa-triangle-exclamation"></i> В файле нет системы координат — выберите CRS</span>';
  el.innerHTML = '<div class="llw-row" style="margin:0"><div style="flex:1">' + txt + '</div>' + (f ? '<button type="button" class="llw-btn sm" data-a="crs">Выбрать CRS…</button>' : '') + (W.epsg ? '<button type="button" class="llw-link" data-a="crs-reset">как в файле</button>' : '') + '</div>';
  var b = $('[data-a=crs]', el); if (b) b.onclick = function () { crsDialog(W); };
  var r = $('[data-a=crs-reset]', el); if (r) r.onclick = function () { W.epsg = null; redraw1(); };
}
var EXTRA_CRS = [
  { epsg: 32634, name: 'WGS 84 / UTM 34N' }, { epsg: 32635, name: 'WGS 84 / UTM 35N' }, { epsg: 32636, name: 'WGS 84 / UTM 36N' }, { epsg: 32637, name: 'WGS 84 / UTM 37N' },
  { epsg: 25834, name: 'ETRS89 / UTM 34N' }, { epsg: 25835, name: 'ETRS89 / UTM 35N' }, { epsg: 28404, name: 'Pulkovo 1942 / Gauss-Krüger 4 (СК-42)' },
  { epsg: 28405, name: 'Pulkovo 1942 / Gauss-Krüger 5 (СК-42)' }, { epsg: 28406, name: 'Pulkovo 1942 / Gauss-Krüger 6 (СК-42)' }, { epsg: 28407, name: 'Pulkovo 1942 / Gauss-Krüger 7 (СК-42)' },
  { epsg: 2180, name: 'ETRS89 / Poland CS92' }, { epsg: 3059, name: 'LKS-92 / Latvia TM' }, { epsg: 3346, name: 'LKS94 / Lithuania TM' }, { epsg: 3301, name: 'Estonian Coordinate System 1997' },
  { epsg: 3857, name: 'WGS 84 / Pseudo-Mercator' }
];
function crsList() {
  var seen = {}, out = [];
  ((S.caps && S.caps.epsg_presets) || []).concat(EXTRA_CRS).forEach(function (c) { if (!seen[c.epsg]) { seen[c.epsg] = 1; out.push(c); } });
  try { (JSON.parse(localStorage.getItem('crs_custom_presets_v1') || '[]') || []).forEach(function (c) { var e = +(c.epsg || c.code); if (e && !seen[e]) { seen[e] = 1; out.push({ epsg: e, name: (c.name || 'Мой пресет') + ' (мои пресеты)' }); } }); } catch (e) {}
  return out;
}
function crsName(e) { var c = crsList().filter(function (x) { return x.epsg === +e; })[0]; return c ? '— ' + c.name : ''; }
function crsDialog(W) {
  var M = S.modal, win = $('.llw-win', M.el);
  var d = document.createElement('div'); d.id = 'llw-crs';
  d.innerHTML = '<div class="box" role="dialog" aria-label="Выбор системы координат"><b style="font-size:14px">Система координат облака</b>' +
    '<div class="llw-sub" style="margin:4px 0 8px">Поиск по коду EPSG или названию. Нужна проекция в метрах (UTM, СК-42/63 Гаусса-Крюгера и т. п.).</div>' +
    '<input type="search" placeholder="Например: 32635, UTM 35, СК-42" autocomplete="off"><ul></ul>' +
    '<div class="llw-row"><input type="number" min="1024" max="999999" placeholder="Свой код EPSG" style="flex:1" data-a="own"><button type="button" class="llw-btn pri" data-a="ok">Применить</button><button type="button" class="llw-btn" data-a="x">Отмена</button></div></div>';
  win.style.position = 'relative'; win.appendChild(d);
  var q = $('input[type=search]', d), ul = $('ul', d), own = $('[data-a=own]', d), pick = W.epsg || (W.file && W.file.info && W.file.info.epsg) || null;
  function render() {
    var s = q.value.trim().toLowerCase();
    var items = crsList().filter(function (c) { return !s || String(c.epsg).indexOf(s) === 0 || c.name.toLowerCase().indexOf(s) >= 0; });
    ul.innerHTML = items.map(function (c) { return '<li data-e="' + c.epsg + '" class="' + (+pick === c.epsg ? 'on' : '') + '"><b>EPSG:' + c.epsg + '</b> — ' + esc(c.name) + '</li>'; }).join('') || '<li style="cursor:default">Нет совпадений — введите код ниже</li>';
  }
  ul.onclick = function (e) { var li = e.target.closest('li[data-e]'); if (!li) return; pick = +li.dataset.e; own.value = ''; render(); };
  ul.ondblclick = function (e) { var li = e.target.closest('li[data-e]'); if (li) { pick = +li.dataset.e; apply(); } };
  q.oninput = render;
  function apply() {
    var e = +own.value || +pick;
    if (!(e >= 1024 && e <= 999999)) { toast('Укажите код EPSG', true); return; }
    if (e === 4326) { toast('EPSG:4326 — градусы; для облака нужна проекция в метрах', true); return; }
    var fe = W.file && W.file.info && W.file.info.epsg;
    W.epsg = (fe && +fe === e) ? null : e; d.remove(); redraw1();
  }
  $('[data-a=ok]', d).onclick = apply; $('[data-a=x]', d).onclick = function () { d.remove(); };
  render(); setTimeout(function () { q.focus(); }, 20);
}
function drawInfo(W) {
  var el = slot('info'); if (!el) return;
  var f = W.file;
  if (!f) { el.innerHTML = '<div class="llw-sub">Появятся после загрузки облака: координаты участка, площадь, плотность, атрибуты.</div>'; return; }
  var h = f.header || {}, inf = f.info || {}, bb = f.bbox_ll, pts = inf.points || h.points, area = h.area_bbox_ha;
  var dens = inf.density_bbox || (area ? pts / (area * 1e4) : null);
  el.innerHTML = '<dl class="llw-kv">' +
    '<dt>Точек</dt><dd>' + num(pts) + '</dd>' +
    '<dt>Формат</dt><dd>LAS ' + esc(inf.version || h.version || '?') + ', формат точек ' + esc(h.point_format != null ? h.point_format : '?') + (h.compressed ? ', LAZ' : '') + '</dd>' +
    '<dt>Площадь охвата</dt><dd>' + num(area, 2) + ' га</dd>' +
    '<dt>Плотность</dt><dd>' + num(dens, 1) + ' точек/м²</dd>' +
    '<dt>Высоты Z</dt><dd>' + (h.mins ? num(h.mins[2], 1) + ' … ' + num(h.maxs[2], 1) + ' м' : '—') + '</dd>' +
    '<dt>Цвет RGB</dt><dd>' + ((inf.has_rgb != null ? inf.has_rgb : h.has_rgb) ? 'есть' : 'нет') + '</dd>' +
    '<dt>Центр</dt><dd>' + (bb ? num((bb[1] + bb[3]) / 2, 5) + '° с. ш., ' + num((bb[0] + bb[2]) / 2, 5) + '° в. д.' : 'появится после определения CRS') + '</dd>' +
    '<dt>Загружен</dt><dd>' + when(f.created) + '</dd></dl>';
}
function drawChecks(W) {
  var el = slot('checks'); if (!el) return;
  var f = W.file, items = [];
  if (!f) items.push({ cls: 'na', t: 'Облако точек LAS/LAZ — не загружено' });
  else {
    (f.checks || []).forEach(function (c) {
      if (c.key === 'crs' && W.epsg) { items.push({ cls: 'ok', t: 'Система координат: EPSG:' + W.epsg + ' (выбрана вручную)' }); return; }
      items.push({ cls: c.ok ? (c.warn ? 'warn' : 'ok') : (c.warn ? 'warn' : 'bad'), t: c.text });
    });
    var area = (f.header || {}).area_bbox_ha;
    if (area) items.push(area <= 100 ? { cls: 'ok', t: 'Площадь ' + num(area, 1) + ' га — в пределах рекомендуемых 100 га за запуск' } : { cls: 'warn', t: 'Площадь ' + num(area, 0) + ' га — больше рекомендуемых 100 га: обработка займёт больше времени и памяти' });
    items.push({ cls: 'na', t: 'Атрибуты XYZ и Intensity — обязательны для LAS; классификация земли (класс 2) ускоряет построение ЦМР' });
  }
  if (W.contour === 'file') items.push(W.polys.length || W.zip ? { cls: 'ok', t: 'Контуры: ' + (W.polys.length ? W.polys.length + ' шт., участков ' + W.polys.filter(function (p) { return p.role !== 'nep'; }).length + ', НЭП ' + W.polys.filter(function (p) { return p.role === 'nep'; }).length : 'ZIP-SHP') } : { cls: 'bad', t: 'Выбран файл контуров, но он не загружен' });
  else if (W.contour === 'none') items.push({ cls: 'warn', t: 'Контур лесосеки не задан — обрабатывается всё облако' });
  else items.push({ cls: 'ok', t: 'Граница 3D-сцены — пересечение с облаком' });
  var icon = { ok: 'fa-circle-check', warn: 'fa-circle-exclamation', bad: 'fa-circle-xmark', na: 'fa-circle-info' };
  el.innerHTML = '<ul class="llw-chk">' + items.map(function (i) { return '<li class="' + i.cls + '"><i class="fa-solid ' + icon[i.cls] + '"></i><span>' + esc(i.t) + '</span></li>'; }).join('') + '</ul>';
}
function drawPreview(W) {
  var el = slot('preview'); if (!el) return;
  var shapes = [], bb = W.file && W.file.bbox_ll;
  if (bb) shapes.push({ kind: 'cloud', rings: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] });
  if (W.contour === 'scene' && W.ctx.scene && W.ctx.scene.geojson) geoRings(W.ctx.scene.geojson).forEach(function (r) { shapes.push({ kind: 'scene', rings: r }); });
  if (W.contour === 'file') W.polys.forEach(function (p) { (p.geom.type === 'Polygon' ? [p.geom.coordinates] : p.geom.coordinates).forEach(function (pc) { shapes.push({ kind: p.role, rings: pc }); }); });
  if (!shapes.length) { el.innerHTML = '<div class="llw-sub">Охват облака и контуры появятся здесь.</div>'; return; }
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  shapes.forEach(function (s) { s.rings.forEach(function (r) { r.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }); }); });
  var kx = Math.cos((y0 + y1) / 2 * Math.PI / 180), W0 = 400, H0 = 220, pad = 14;
  var sx = (W0 - 2 * pad) / Math.max(1e-9, (x1 - x0) * kx), sy = (H0 - 2 * pad) / Math.max(1e-9, y1 - y0), s = Math.min(sx, sy);
  var ox = (W0 - (x1 - x0) * kx * s) / 2, oy = (H0 - (y1 - y0) * s) / 2;
  function P(p) { return (ox + (p[0] - x0) * kx * s).toFixed(1) + ',' + (H0 - oy - (p[1] - y0) * s).toFixed(1); }
  var sty = { cloud: 'fill="rgba(41,182,246,.08)" stroke="#29b6f6" stroke-dasharray="5 4"', scene: 'fill="rgba(255,213,74,.07)" stroke="#ffd54a"', lesoseka: 'fill="rgba(130,233,56,.22)" stroke="#82e938"', vydel: 'fill="rgba(124,196,255,.2)" stroke="#7cc4ff"', nep: 'fill="url(#llw-hatch)" stroke="#ff7a6b"' };
  var order = { cloud: 0, scene: 1, lesoseka: 2, vydel: 3, nep: 4 };
  shapes.sort(function (a, b) { return order[a.kind] - order[b.kind]; });
  var svg = '<svg class="llw-prev" viewBox="0 0 ' + W0 + ' ' + H0 + '" role="img" aria-label="Превью: охват облака и контуры"><defs><pattern id="llw-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(255,122,107,.12)"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ff7a6b" stroke-width="1.5"/></pattern></defs>' +
    shapes.map(function (sh) { return '<path ' + sty[sh.kind] + ' stroke-width="1.6" fill-rule="evenodd" d="' + sh.rings.map(function (r) { return 'M' + r.map(P).join('L') + 'Z'; }).join('') + '"/>'; }).join('') + '</svg>';
  var leg = [['#29b6f6', 'облако (охват)'], W.contour === 'scene' ? ['#ffd54a', 'граница сцены'] : null, ['#82e938', 'лесосека'], ['#7cc4ff', 'выдел'], ['#ff7a6b', 'НЭП']].filter(Boolean);
  el.innerHTML = svg + '<div class="llw-row llw-sub" style="gap:12px">' + leg.map(function (l) { return '<span><span class="llw-dot" style="background:' + l[0] + '"></span> ' + l[1] + '</span>'; }).join('') + '</div>';
}
function geoRings(gj) {
  var out = [];
  (gj.type === 'FeatureCollection' ? gj.features : [gj]).forEach(function (f) {
    var g = f.geometry || f; if (!g) return;
    if (g.type === 'Polygon') out.push(g.coordinates); else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (c) { out.push(c); });
  });
  return out;
}

/* ───────────── шаг 2: основные настройки ───────────── */
function step2(W, main) {
  var M = S.modal, c = S.caps || {}, m = mode(W), models = c.models || [];
  main.innerHTML = '<div class="llw-grid"><div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-sliders"></i>Режим анализа</h3>' +
    '<label class="llw-sw"><input type="checkbox" data-k="classify"' + (W.classify ? ' checked' : '') + '><span><b>Провести классификацию пород деревьев</b><span class="llw-sub">Породный состав: порода каждого дерева, состав насаждения (формула), пивот по породам.</span></span></label>' +
    '<label class="llw-sw' + (W.classify ? '' : ' dis') + '"><input type="checkbox" data-k="volume"' + (W.volume && W.classify ? ' checked' : '') + (W.classify ? '' : ' disabled') + '><span><b>Рассчитать объём древесины</b><span class="llw-sub">Диаметры, разряды высот и запас по лесотаксационным нормативам — нужен регион; требует классификации пород.</span></span></label>' +
    '<div class="llw-mode"><span class="n">' + m + '</span><div><b>' + esc(MODES[m].t) + '</b><div class="llw-sub">' + esc(MODES[m].d) + '</div></div></div>' +
    (W.classify ? '<label class="llw-f"><span>Модель классификации пород</span><select data-k="model"><option value="">Встроенная: хвойные / лиственные по форме кроны</option>' +
      models.map(function (x) { var n = x.name || x; return '<option value="' + esc(n) + '"' + (W.model && (W.model === n || W.model.split(/[\\/]/).pop() === n) ? ' selected' : '') + '>' + esc(x.title || n) + (x.size ? ' · ' + bytes(x.size) : '') + '</option>'; }).join('') +
      '</select><span class="llw-hint">' + (models.length ? 'Обученная модель различает породы из списка на следующем шаге.' : 'Обученных моделей нет (папка models/ рядом с LesoLidar.exe) — породы определяются как хвойные/лиственные.') + '</span></label>' : '') +
    '</section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-signature"></i>Название обработки</h3><input type="text" data-k="name" maxlength="120" style="width:100%" placeholder="' + esc(defaultName(W)) + '" value="' + esc(W.name || '') + '"></section>' +
    '</div><div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-location-dot"></i>Местоположение участка</h3>' +
    '<label class="llw-f"><span>Регион</span><select data-k="region">' + Object.keys(REGIONS).map(function (r) { return '<option' + (r === W.region ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
    '<label class="llw-f"><span>Подрегион (лесорастительная подзона)</span><select data-k="subregion">' + (REGIONS[W.region] || ['—']).map(function (r) { return '<option' + (r === W.subregion ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
    '<div class="llw-f"><span>Сезон съёмки</span><div class="llw-chips">' + [['summer', 'Лето (с листвой)'], ['winter', 'Зима / без листвы']].map(function (s) {
      return '<label class="' + (W.season === s[0] ? 'on' : '') + '"><input type="radio" name="llw-season" value="' + s[0] + '"' + (W.season === s[0] ? ' checked' : '') + '>' + s[1] + '</label>'; }).join('') +
    '</div><span class="llw-hint">Зимой у лиственных нет листвы — кроны выглядят иначе; обработчик учитывает это при поиске вершин и классификации.</span></div>' +
    '<label class="llw-f"><span>Возраст древостоя, лет (необязательно)</span><input type="number" min="5" max="300" step="1" data-k="age" value="' + esc(W.age) + '" placeholder="например, 65"><span class="llw-hint">Для класса бонитета по шкале М. М. Орлова (по высоте главной породы). Без возраста бонитет не оценивается.</span></label>' +
    '</section></div></div>';
  main.querySelector('[data-k=classify]').onchange = function () { W.classify = this.checked; if (!W.classify) W.volume = false; else W.volume = true; W.params.export_xlsx = mode(W) === 3; step2(W, main); };
  main.querySelector('[data-k=volume]').onchange = function () { W.volume = this.checked; W.params.export_xlsx = mode(W) === 3; step2(W, main); };
  var md = main.querySelector('[data-k=model]'); if (md) md.onchange = function () { W.model = md.value; };
  main.querySelector('[data-k=name]').oninput = function () { W.name = this.value; };
  main.querySelector('[data-k=region]').onchange = function () { W.region = this.value; W.subregion = (REGIONS[W.region] || ['—'])[0]; step2(W, main); };
  main.querySelector('[data-k=subregion]').onchange = function () { W.subregion = this.value; };
  $$('input[name=llw-season]', main).forEach(function (r) { r.onchange = function () { W.season = r.value; step2(W, main); }; });
  main.querySelector('[data-k=age]').oninput = function () { W.age = this.value; };
  foot(M, W, { msg: MODES[m].t });
}
function defaultName(W) {
  var f = W.file ? W.file.name.replace(/\.(las|laz)$/i, '') : 'Облако';
  return f + ' · ' + new Date().toLocaleDateString('ru-RU');
}

/* ───────────── шаг 3: опции обработки ───────────── */
var PARAM_UI = [
  ['Поиск деревьев', [
    ['min_tree_height', 'Мин. высота дерева, м', 1, 20, 0.5, 'Вершины ниже порога не учитываются (подрост < 5 м учитывается отдельно, в запас не входит).'],
    ['ws_a', 'Окно поиска вершин: a, м', 0.2, 5, 0.1, 'Радиус окна = a + b·H. Меньше — больше найденных деревьев (и ложных вершин).'],
    ['ws_b', 'Окно поиска вершин: b', 0, 0.4, 0.005, ''],
    ['crown_rel_threshold', 'Граница кроны, доля высоты', 0.05, 0.95, 0.05, 'Пиксели CHM ниже доли от высоты вершины не входят в крону.'],
    ['max_crown_a', 'Макс. радиус кроны: a, м', 0.2, 6, 0.1, 'Ограничение радиуса = a + b·H.'],
    ['max_crown_b', 'Макс. радиус кроны: b', 0, 0.6, 0.01, ''],
    ['min_crown_area', 'Мин. площадь кроны, м²', 0, 30, 0.1, '']
  ]],
  ['Рельеф и модель высот крон', [
    ['dtm_res', 'Шаг ЦМР, м', 0.25, 5, 0.25, ''],
    ['chm_res', 'Шаг CHM, м', 0.1, 2, 0.01, 'Меньше шаг — детальнее кроны, дольше расчёт.'],
    ['smooth_sigma_m', 'Сглаживание CHM, м', 0, 2, 0.05, 'Убирает «шум» ветвей, но может сливать соседние кроны.']
  ]],
  ['Производительность и таксация', [
    ['max_points_millions', 'Макс. точек, млн', 1, 3000, 1, 'Больше — облако прорежается равномерно.'],
    ['thin_density', 'Прореживание до, точек/м² (0 — нет)', 0, 1000, 1, ''],
    ['dbh_step_cm', 'Ступень толщины, см', 1, 8, 1, 'Для распределения по ступеням и ведомости.']
  ]]
];
var EXPORTS = [
  ['export_shp', 'Вершины и кроны деревьев (SHP)', 'Точечный слой вершин и полигоны крон со стилями QGIS'],
  ['export_rasters', 'ЦМР и модель высот крон (GeoTIFF)', 'dtm.tif и chm.tif со стилями QGIS; нужны для рельефа LAS в 3D'],
  ['export_xlsx', 'Таксационная ведомость (Excel)', 'Подеревный отчёт и сводная по породам'],
  ['export_html', 'Аналитическая панель (HTML)', 'Интерактивный отчёт с диаграммами распределения стволов по высотам и породам'],
  ['export_las', 'Облако с номерами деревьев (LAZ)', 'Сегментированное облако — большой файл']
];
function step3(W, main) {
  var M = S.modal, c = S.caps || {}, sp = (c.species || []).filter(function (s) { return s.code !== 'conifer' && s.code !== 'deciduous'; });
  var p = W.params;
  var h = '<div class="llw-grid"><div>';
  if (W.classify) {
    h += '<section class="llw-card"><h3><i class="fa-solid fa-leaf"></i>Классификация и расчёт объёмов</h3><div class="llw-sub" style="margin-bottom:8px">Отметьте породы, которые могут быть на участке' + (W.volume ? ', и разряд высот для расчёта запаса (авто — по таблицам высот обработчика)' : '') + '.</div>' +
      '<div class="llw-chips">' + sp.map(function (s) { var on = W.species.indexOf(s.code) >= 0; return '<label class="' + (on ? 'on' : '') + '"><input type="checkbox" data-sp="' + esc(s.code) + '"' + (on ? ' checked' : '') + '><span class="llw-dot" style="background:' + esc(s.color) + '"></span>' + esc(s.name) + '</label>'; }).join('') + '</div>' +
      (W.volume && W.species.length ? '<table class="llw-t" style="margin-top:10px"><thead><tr><th>Порода</th><th>Разряд высот</th></tr></thead><tbody>' + W.species.map(function (code) {
        var s = speciesInfo(code), r = W.ranks[code] || '';
        return '<tr><td><span class="llw-dot" style="background:' + esc(s.color) + '"></span> ' + esc(s.name) + '</td><td><select data-rank="' + esc(code) + '"><option value="">авто</option>' + [1, 2, 3, 4, 5, 6, 7].map(function (k) { return '<option' + (+r === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') + '</tbody></table>' : '') +
      (!W.species.length ? '<div class="llw-err" style="margin-top:8px">Выберите хотя бы одну породу</div>' : '') + '</section>';
  } else {
    h += '<section class="llw-card"><h3><i class="fa-solid fa-leaf"></i>Классификация пород</h3><div class="llw-sub">Режим 1: породы не определяются, объёмы не рассчитываются — только количество стволов, высоты и кроны.</div></section>';
  }
  h += '<section class="llw-card"><h3><i class="fa-solid fa-magnifying-glass"></i>Параметры поиска деревьев</h3><div class="llw-chips" style="margin-bottom:8px">' +
    Object.keys(PRESETS).map(function (k) { return '<label class="' + (W.preset === k ? 'on' : '') + '" title="' + esc(PRESETS[k].d) + '"><input type="radio" name="llw-pre" value="' + k + '"' + (W.preset === k ? ' checked' : '') + '>' + esc(PRESETS[k].t) + '</label>'; }).join('') +
    (W.preset ? '' : '<label class="on"><input type="radio" name="llw-pre" value="" checked>Свои значения</label>') + '</div>' +
    '<div class="llw-sub">' + esc(W.preset ? PRESETS[W.preset].d : 'Параметры изменены вручную или взяты из прошлой версии') + '</div>' +
    PARAM_UI.map(function (grp, gi) {
      return '<details class="llw-adv" style="margin-top:10px"' + (gi === 0 && !W.preset ? ' open' : '') + '><summary>' + esc(grp[0]) + '</summary><div class="llw-two" style="margin-top:8px">' + grp[1].map(function (f) {
        return '<label class="llw-f"><span>' + esc(f[1]) + '</span><input type="number" data-p="' + f[0] + '" min="' + f[2] + '" max="' + f[3] + '" step="' + f[4] + '" value="' + esc(p[f[0]] != null ? p[f[0]] : '') + '">' + (f[5] ? '<span class="llw-hint">' + esc(f[5]) + '</span>' : '') + '</label>';
      }).join('') + (gi === 1 ? '<label class="llw-sw" style="grid-column:1/-1"><input type="checkbox" data-pb="use_existing_ground"' + (p.use_existing_ground ? ' checked' : '') + '><span><b>Использовать классификацию земли из файла (класс 2)</b><span class="llw-sub">Если в облаке уже есть точки земли — ЦМР точнее и быстрее.</span></span></label>' : '') + '</div></details>';
    }).join('') + '</section></div><div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-file-export"></i>Экспортируемые файлы</h3>' +
    EXPORTS.map(function (e) { return '<label class="llw-sw"><input type="checkbox" data-pb="' + e[0] + '"' + (p[e[0]] ? ' checked' : '') + '><span><b>' + esc(e[1]) + '</b><span class="llw-sub">' + esc(e[2]) + '</span></span></label>'; }).join('') +
    '<div class="llw-hint">Сводка (summary.json), параметры расчёта и журнал сохраняются всегда. Результаты — на сервере, скачивание по одному файлу или ZIP.</div></section></div></div>';
  main.innerHTML = h;
  $$('[data-sp]', main).forEach(function (x) { x.onchange = function () { var code = x.dataset.sp, i = W.species.indexOf(code); if (x.checked && i < 0) W.species.push(code); if (!x.checked && i >= 0) W.species.splice(i, 1); step3(W, main); refreshNext(); }; });
  $$('[data-rank]', main).forEach(function (x) { x.onchange = function () { if (x.value) W.ranks[x.dataset.rank] = +x.value; else delete W.ranks[x.dataset.rank]; }; });
  $$('input[name=llw-pre]', main).forEach(function (r) { r.onchange = function () { if (!r.value) return; W.preset = r.value; var pp = PRESETS[r.value].p; for (var k in pp) W.params[k] = pp[k]; step3(W, main); }; });
  $$('[data-p]', main).forEach(function (x) { x.onchange = function () { var v = parseFloat(String(x.value).replace(',', '.')); if (!isFinite(v)) return; v = Math.min(+x.max, Math.max(+x.min, v)); x.value = v; W.params[x.dataset.p] = v; if (W.preset) { W.preset = ''; $$('label.on', $('.llw-presets', main) || main).forEach(function (l) { l.classList.remove('on'); }); } }; });
  $$('[data-pb]', main).forEach(function (x) { x.onchange = function () { W.params[x.dataset.pb] = x.checked; }; });
  foot(M, W, { msg: W.classify && !W.species.length ? 'Выберите породы' : '' });
}

/* ───────────── шаг 4: обзор и запуск ───────────── */
function estimateSec(W) {
  var f = W.file || {}, pts = (f.info && f.info.points) || (f.header && f.header.points) || 0, rate = null;
  (S.jobsCache || []).forEach(function (j) { if (j.status === 'done' && j.elapsed_s && j.summary && j.summary.points) { var r = j.elapsed_s / Math.max(0.05, j.summary.points / 1e6); rate = rate == null ? r : rate * 0.7 + r * 0.3; } });
  if (rate == null) rate = 7;
  var n = Math.min(pts, (W.params.max_points_millions || 60) * 1e6);
  return Math.max(10, 8 + n / 1e6 * rate);
}
function boundaryBody(W) {
  if (W.contour === 'scene' && W.ctx.scene && W.ctx.scene.geojson) return { kind: 'scene', geojson: W.ctx.scene.geojson, label: 'Граница 3D-сцены: ' + (W.ctx.scene.name || W.ctx.scene.code) };
  if (W.contour === 'file' && W.zip && !W.polys.length) return { kind: 'upload', id: W.zip.id, label: W.zip.name, polygons: [{ role: 'lesoseka', name: W.zip.name }] };
  if (W.contour === 'file' && W.polys.length) {
    return { kind: 'roles', label: W.polys.map(function (p) { return ROLE[p.role] + ': ' + p.name; }).join('; ').slice(0, 118),
      geojson: { type: 'FeatureCollection', features: W.polys.map(function (p) { return { type: 'Feature', properties: { role: p.role, name: p.name }, geometry: p.geom }; }) },
      polygons: W.polys.map(function (p) { return { role: p.role, name: p.name, area_ha: +p.area_ha.toFixed(3) }; }) };
  }
  return { kind: 'none' };
}
function jobBody(W) {
  var p = copy(W.params);
  p.epsg = W.epsg || null; p.region = W.region + ' · ' + W.subregion; p.season = W.season; p.model_path = W.classify ? (W.model || '') : '';
  p.species = W.species.length ? W.species.slice() : ((S.caps && S.caps.default_species) || ['pine', 'birch']).slice();
  p.height_ranks = W.volume ? copy(W.ranks) : {};
  var b = boundaryBody(W);
  return { file_id: W.file.id, name: (W.name || defaultName(W)).slice(0, 120), params: p, boundary: b, parent: W.parent || undefined,
    scene: W.ctx.scene ? { code: W.ctx.scene.code, name: W.ctx.scene.name } : undefined,
    meta: { mode: mode(W), age: W.age ? +W.age : null, plot: b.kind === 'roles' ? (W.polys.filter(function (x) { return x.role !== 'nep'; })[0] || {}).role || 'nep' : b.kind } };
}
function step4(W, main) {
  var M = S.modal, f = W.file, p = W.params, m = mode(W), b = boundaryBody(W), est = estimateSec(W);
  function blk(title, step, rows) {
    return '<section class="llw-card"><h3><i class="fa-solid fa-clipboard-check"></i>' + esc(title) + '<span class="llw-r"><button type="button" class="llw-link" data-edit="' + step + '">Изменить</button></span></h3><dl class="llw-kv">' +
      rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></section>';
  }
  var pts = (f.info && f.info.points) || (f.header && f.header.points);
  var warns = [];
  if (b.kind === 'none') warns.push('Контур не задан — расчёт по всему облаку.');
  var dens = f.info && f.info.density_bbox; if (dens && dens < 4) warns.push('Низкая плотность облака (' + num(dens, 1) + ' т/м²) — часть деревьев будет пропущена.');
  if ((f.header || {}).area_bbox_ha > 100) warns.push('Участок больше 100 га — обработка займёт больше времени.');
  if (m >= 2 && !W.model && !(S.caps.models || []).length) warns.push('Обученной модели пород нет — породы будут «хвойные/лиственные».');
  main.innerHTML = '<div class="llw-rev">' +
    blk('Входные данные', 0, [['Облако', esc(f.name) + ' <span class="llw-sub">(' + bytes(f.size) + ', ' + num(pts) + ' точек)</span>'], ['Система координат', W.epsg ? 'EPSG:' + W.epsg + ' (вручную)' : (f.info && f.info.epsg ? 'EPSG:' + f.info.epsg : 'из файла')],
      ['Контур', b.kind === 'none' ? 'нет — всё облако' : esc(b.label || '')]].concat(b.polygons ? [['Полигоны', b.polygons.map(function (x) { return esc(ROLE[x.role] || x.role) + (x.area_ha != null ? ' ' + num(x.area_ha, 2) + ' га' : ''); }).join('<br>')]] : [])) +
    blk('Основные настройки', 1, [['Режим', '<b>' + esc(MODES[m].t) + '</b>'], ['Регион', esc(W.region + ' · ' + W.subregion)], ['Сезон съёмки', W.season === 'winter' ? 'зима / без листвы' : 'лето'], ['Возраст', W.age ? esc(W.age) + ' лет (бонитет)' : 'не указан'],
      ['Модель пород', m >= 2 ? esc(W.model || 'встроенная: хвойные / лиственные') : '—'], ['Название', esc(W.name || defaultName(W))]]) +
    blk('Опции обработки', 2, [['Породы', m >= 2 ? W.species.map(function (c) { var s = speciesInfo(c); return '<span class="llw-dot" style="background:' + esc(s.color) + '"></span> ' + esc(s.name) + (W.volume && W.ranks[c] ? ' (разряд ' + W.ranks[c] + ')' : ''); }).join(', ') : '—'],
      ['Поиск деревьев', 'H ≥ ' + num(p.min_tree_height, 1) + ' м, окно ' + num(p.ws_a, 2) + ' + ' + num(p.ws_b, 3) + '·H' + (W.preset ? ' · «' + esc(PRESETS[W.preset].t) + '»' : '')],
      ['ЦМР / CHM', num(p.dtm_res, 2) + ' / ' + num(p.chm_res, 2) + ' м' + (p.use_existing_ground ? ', земля из файла' : '')],
      ['Экспорт', EXPORTS.filter(function (e) { return p[e[0]]; }).map(function (e) { return esc(e[1]); }).join('<br>') || 'только сводка']]) +
    '</div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-hourglass-half"></i>Запуск</h3><div class="llw-row" style="margin:0"><div style="flex:1">Оценка времени: <b>≈ ' + dur(est) + '</b> <span class="llw-sub">(по прошлым обработкам на этом сервере)</span>' +
    (warns.length ? '<ul class="llw-chk" style="margin-top:8px">' + warns.map(function (w) { return '<li class="warn"><i class="fa-solid fa-circle-exclamation"></i><span>' + esc(w) + '</span></li>'; }).join('') + '</ul>' : '') + '</div></div></section>';
  $$('[data-edit]', main).forEach(function (bt) { bt.onclick = function () { go(+bt.dataset.edit); }; });
  var admin = isAdmin(), avail = S.caps && S.caps.available;
  foot(M, W, { msg: !admin ? 'Запуск — только администратор' : !avail ? 'Обработчик не настроен на сервере' : '', extra: '<button type="button" class="llw-btn pri" data-f="run"' + (admin && avail ? '' : ' disabled') + '><i class="fa-solid fa-play"></i> Запустить обработку</button>' });
  var run = $('[data-f=run]', M.foot);
  run.onclick = function () {
    run.disabled = true; run.innerHTML = '<span class="llw-spin"></span> Запуск…';
    prefs({ classify: W.classify, volume: W.volume, region: W.region, subregion: W.subregion, model: W.model });
    call('POST', '/jobs', jobBody(W)).then(function (j) {
      W.job = j; W.step = 4; W.max = 4; S.jobsAt = 0; renderWizard(); refreshPickers();
    }).catch(function (e) { run.disabled = false; run.innerHTML = '<i class="fa-solid fa-play"></i> Запустить обработку'; toast('Запуск: ' + e.message, true); });
  };
}

/* ───────────── шаг 5: процесс ───────────── */
function step5(W, main) {
  var M = S.modal, j = W.job, logOpen = false, logOff = 0, logTxt = '';
  main.innerHTML = '<div class="llw-grid"><div><section class="llw-card"><h3><i class="fa-solid fa-gears"></i>Обработка: ' + esc(j.name || j.file_name || '') + '<span class="llw-r" data-p="chip"></span></h3>' +
    '<div class="llw-row" style="margin:0 0 4px"><span class="llw-big" data-p="pct">0%</span><div style="flex:1"><div data-p="stage" style="font-weight:700"></div><div class="llw-sub" data-p="time"></div></div></div>' +
    '<div class="llw-bar" style="height:10px"><i data-p="bar" style="width:0"></i></div>' +
    '<ul class="llw-stages" data-p="stages" style="margin-top:12px"></ul></section></div><div>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-terminal"></i>Журнал обработки<span class="llw-r"><button type="button" class="llw-link" data-p="logbtn">показать</button></span></h3><div class="llw-sub" data-p="last"></div><pre class="llw-log" data-p="log" hidden></pre></section>' +
    '<section class="llw-card"><h3><i class="fa-solid fa-circle-info"></i>Что происходит</h3><div class="llw-sub">Нормализация облака, построение ЦМР и модели высот крон (DTM / CHM), поиск вершин и сегментация крон, классификация пород, диаметры и запас, экспорт. Окно можно закрыть — обработка продолжится на сервере; результаты — в «Мои обработки».</div></section>' +
    '</div></div>';
  var q = function (k) { return $('[data-p=' + k + ']', main); };
  q('logbtn').onclick = function () { logOpen = !logOpen; q('log').hidden = !logOpen; this.textContent = logOpen ? 'скрыть' : 'показать'; if (logOpen) pullLog(); };
  function pullLog() {
    if (!logOpen || !S.modal) return;
    call('GET', '/jobs/' + j.id + '/log?offset=' + logOff).then(function (r) {
      if (r.next < logOff) { logTxt = ''; }
      logOff = r.next || logOff; if (r.text) { logTxt = (logTxt + r.text).slice(-60000); var pre = q('log'); if (pre) { var atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30; pre.textContent = logTxt; if (atEnd) pre.scrollTop = pre.scrollHeight; } }
    }).catch(function () {});
  }
  function draw(j) {
    W.job = j;
    var stages = j.stages || (S.caps && S.caps.stages) || STEP_NAMES, si = j.stage_index == null ? -1 : j.stage_index, p = Math.max(0, Math.min(100, +j.progress || 0));
    q('chip').innerHTML = statusChip(j);
    q('pct').textContent = Math.round(p) + '%'; q('bar').style.width = p + '%';
    q('stage').textContent = j.status === 'queued' ? 'В очереди — ожидает завершения других обработок' : j.status === 'running' ? ('Этап ' + Math.min(stages.length, si + 1) + ' из ' + stages.length + ': ' + (j.stage || stages[si] || '')) : (j.stage || '');
    var el = j.started ? (j.finished || Date.now() / 1000) - j.started : 0;
    q('time').textContent = (j.started ? 'Прошло ' + dur(el) : 'Создано ' + when(j.created)) + (j.eta_s ? ' · осталось ≈ ' + dur(j.eta_s) : '') + (j.version > 1 ? ' · версия ' + j.version : '');
    q('stages').innerHTML = stages.map(function (s, i) {
      var cls = (j.status === 'done' || i < si) ? 'done' : (i === si && j.status === 'running') ? 'cur' : '';
      var ic = cls === 'done' ? 'fa-circle-check' : cls === 'cur' ? 'fa-spinner fa-spin' : 'fa-circle';
      return '<li class="' + cls + '"><i class="fa-solid ' + ic + '"></i><span>' + (i + 1) + '. ' + esc(s) + '</span><span class="p">' + (cls === 'done' ? '✓' : cls === 'cur' ? Math.round(p) + '%' : '') + '</span></li>';
    }).join('');
    q('last').textContent = j.last_message || (j.tail && j.tail.length ? j.tail[j.tail.length - 1] : '') || '';
    if (j.status === 'error') q('last').innerHTML = '<span class="llw-err">' + esc(j.error || 'Ошибка обработки') + '</span>';
  }
  function fin(j) {
    var acts = '';
    if (j.status === 'done') { W.step = 5; W.max = 5; renderWizard(); refreshPickers(); toast('ЛесоЛидар: обработка «' + (j.name || '') + '» завершена'); return true; }
    if (j.status === 'error' || j.status === 'cancelled') {
      acts = '<button type="button" class="llw-btn" data-f="revise"><i class="fa-solid fa-rotate"></i> Изменить параметры и повторить</button>';
      M.foot.innerHTML = '<span class="llw-msg">' + (j.status === 'error' ? 'Обработка завершилась с ошибкой — откройте журнал' : 'Обработка отменена') + '</span>' + acts;
      $('[data-f=revise]', M.foot).onclick = function () { reviseFrom(j, 2); };
      logOpen = true; q('log').hidden = false; q('logbtn').textContent = 'скрыть'; pullLog(); refreshPickers();
      return true;
    }
    return false;
  }
  draw(j);
  M.foot.innerHTML = '<span class="llw-msg">Окно можно закрыть — обработка идёт на сервере</span>' + (isAdmin() ? '<button type="button" class="llw-btn danger" data-f="cancel"><i class="fa-solid fa-stop"></i> Отменить</button>' : '');
  var cb = $('[data-f=cancel]', M.foot);
  if (cb) cb.onclick = function () { if (!confirm('Отменить обработку?')) return; cb.disabled = true; call('POST', '/jobs/' + j.id + '/cancel').then(function (r) { if (r && r.id) draw(r); }).catch(function (e) { cb.disabled = false; toast(e.message, true); }); };
  if (fin(j)) return;
  var errs = 0;
  (function poll() {
    if (!S.modal || S.wiz !== W || W.step !== 4) return;
    call('GET', '/jobs/' + j.id).then(function (nj) { errs = 0; draw(nj); if (!fin(nj)) M.timers.push(setTimeout(poll, nj.status === 'queued' ? 2500 : 1200)); if (logOpen) pullLog(); })
      .catch(function (e) { if (++errs > 20) { q('last').innerHTML = '<span class="llw-err">Нет связи с сервером: ' + esc(e.message) + '</span>'; } M.timers.push(setTimeout(poll, 3000)); });
  })();
}

/* ───────────── шаг 6: результаты ───────────── */
function step6(W, main) {
  var M = S.modal, j = W.job, md = modeOf(j), sm = j.summary || {};
  main.innerHTML = '<div class="llw-empty"><span class="llw-spin"></span> Загрузка результатов…</div>';
  Promise.all([call('GET', '/jobs/' + j.id), call('GET', '/jobs/' + j.id + '/stats').catch(function (e) { return { error: e.message }; })]).then(function (r) {
    j = W.job = r[0]; sm = j.summary || {}; var st = r[1];
    renderResults(W, main, j, st);
  }).catch(function (e) { main.innerHTML = '<div class="llw-empty llw-err">' + esc(e.message) + '</div>'; });
  M.foot.innerHTML = '<span class="llw-msg">' + esc(MODES[md].t) + ' · версия ' + (j.version || 1) + ' · ' + when(j.finished || j.created) + '</span>' +
    '<button type="button" class="llw-btn" data-f="revise" title="Тот же файл, другие параметры — новая версия"><i class="fa-solid fa-rotate"></i> Пересчитать</button>' +
    '<a class="llw-btn" data-f="zip" href="' + API + '/jobs/' + j.id + '/zip"><i class="fa-solid fa-file-zipper"></i> Все файлы (ZIP)</a>' +
    '<button type="button" class="llw-btn pri" data-f="show3d"><i class="fa-solid fa-cube"></i> Показать в 3D</button>';
  $('[data-f=revise]', M.foot).onclick = function () { reviseFrom(j, 1); };
  $('[data-f=show3d]', M.foot).onclick = function () { show3D(W.job); };
  if (!isAdmin()) $('[data-f=revise]', M.foot).remove();
}
function renderResults(W, main, j, st) {
  var sm = j.summary || {}, md = modeOf(j), stand = (st && st.stand) || {}, tab = W.tab || 'sum';
  var tabs = [['sum', 'Сводка'], ['pivot', 'Пивот-таблица'], ['charts', 'Графики'], ['trees', 'Учёт деревьев'], ['files', 'Файлы']];
  var bon = stand.bonitet ? stand.bonitet : (stand.available ? 'нужен возраст' : '—');
  var cards = [
    md >= 3 ? ['fa-cubes-stacked', 'Объём древесины', num(sm.volume, 1), 'м³ · ' + num(sm.volume_ha, 0) + ' м³/га'] : null,
    ['fa-tree', 'Деревьев обнаружено', num(sm.trees), num(sm.trees_ha, 0) + ' шт/га'],
    ['fa-vector-square', 'Площадь участка', num(sm.area_ha, 2), 'га'],
    md >= 3 ? ['fa-ranking-star', 'Полнота · бонитет', (stand.available ? num(stand.polnota, 2) : '—') + (stand.bonitet ? ' · ' + esc(stand.bonitet) : ''), stand.bonitet ? 'ориентировочно' + (stand.h_lorey ? ', Hлор ' + num(stand.h_lorey, 1) + ' м' : '') : 'бонитет — укажите возраст (пересчёт)'] : null,
    ['fa-stopwatch', 'Время обработки', dur(j.elapsed_s), 'облако: ' + num(sm.points) + ' точек'],
    md >= 2 ? ['fa-leaf', 'Состав', esc(sm.composition || '—'), esc(sm.species_method ? sm.species_method.split('—')[0] : '')] : null,
    ['fa-arrows-up-to-line', 'Высота макс.', num(sm.h_max, 1), 'м' + (st && st.tiers ? ' · подрост ' + num(st.tiers['подрост']) : '')]
  ].filter(Boolean);
  main.innerHTML = '<div class="llw-cards">' + cards.map(function (c) { return '<div class="llw-mc"><div class="k"><i class="fa-solid ' + c[0] + '"></i>' + esc(c[1]) + '</div><div class="v">' + c[2] + '</div><div class="u">' + c[3] + '</div></div>'; }).join('') + '</div>' +
    '<nav class="llw-tabs2">' + tabs.map(function (t) { return '<button type="button" data-t="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</nav><div data-t="body"></div>';
  $$('[data-t]', main).forEach(function (b) { if (b.tagName === 'BUTTON') b.onclick = function () { W.tab = b.dataset.t; $$('.llw-tabs2 button', main).forEach(function (x) { x.classList.toggle('on', x === b); }); body(); }; });
  function body() {
    var el = $('div[data-t=body]', main), t = W.tab || 'sum';
    if (t === 'sum') el.innerHTML = resSummary(j, st);
    if (t === 'pivot') el.innerHTML = resPivot(j, st);
    if (t === 'charts') el.innerHTML = resCharts(j, st);
    if (t === 'trees') resTrees(el, j, st);
    if (t === 'files') resFiles(el, j);
  }
  body();
}
function resSummary(j, st) {
  var sm = j.summary || {}, md = modeOf(j), stand = (st && st.stand) || {}, tiers = (st && st.tiers) || null, b = j.boundary || {};
  var h = '<div class="llw-grid"><div>';
  if (tiers) {
    var tot = Math.max(1, tiers.I + tiers.II + tiers.III + tiers['подрост']), cols = { I: '#82e938', II: '#b7e36b', III: '#e3d36b', 'подрост': '#7cc4ff' };
    h += '<section class="llw-card"><h3><i class="fa-solid fa-layer-group"></i>Ярусы по высоте</h3><div class="llw-tiers">' + ['I', 'II', 'III', 'подрост'].map(function (k) { var w = tiers[k] / tot * 100; return w > 0 ? '<i style="width:' + w + '%;background:' + cols[k] + '" title="' + k + ': ' + tiers[k] + '">' + (w > 8 ? k : '') + '</i>' : ''; }).join('') + '</div>' +
      '<div class="llw-row llw-sub" style="gap:12px">' + ['I', 'II', 'III', 'подрост'].map(function (k) { return '<span><span class="llw-dot" style="background:' + cols[k] + '"></span> ' + (k === 'подрост' ? 'подрост < 5 м' : k + ' ярус') + ': <b>' + num(tiers[k]) + '</b></span>'; }).join('') + '</div>' +
      '<div class="llw-hint">I — от 75 % максимальной высоты (' + num(st.h_max * 0.75, 1) + ' м), II — 50–75 %, III — ниже, подрост — до 5 м.</div></section>';
  }
  if (md >= 3 && stand.available) {
    h += '<section class="llw-card"><h3><i class="fa-solid fa-ranking-star"></i>Таксационные показатели (ориентировочно)</h3><dl class="llw-kv">' +
      '<dt>Сумма площадей сечений</dt><dd>' + num(stand.g_ha, 1) + ' м²/га</dd><dt>Средняя высота (по Лорею)</dt><dd>' + num(stand.h_lorey, 1) + ' м</dd>' +
      '<dt>Относительная полнота</dt><dd>' + num(stand.polnota, 2) + '</dd><dt>Класс бонитета</dt><dd>' + (stand.bonitet ? esc(stand.bonitet) + ' (возраст ' + esc(stand.age) + ' лет)' : 'укажите возраст при пересчёте') + '</dd>' +
      '<dt>Главная порода</dt><dd>' + esc(speciesInfo(stand.main_species).name) + '</dd></dl><div class="llw-hint" style="margin-top:6px">' + esc(stand.note || '') + '</div></section>';
  }
  h += '</div><div><section class="llw-card"><h3><i class="fa-solid fa-circle-info"></i>Участок и расчёт</h3><dl class="llw-kv">' +
    '<dt>Облако</dt><dd>' + esc(j.file_name || '') + '</dd><dt>Точек</dt><dd>' + num(sm.points) + ' (' + num(sm.density, 1) + ' т/м²)</dd><dt>Система координат</dt><dd>' + esc(sm.crs || '—') + '</dd>' +
    '<dt>Контур</dt><dd>' + (b.kind && b.kind !== 'none' ? esc(b.label || b.kind) : 'всё облако') + '</dd>' +
    ((j.polygons || []).length ? '<dt>Полигоны</dt><dd>' + j.polygons.map(function (p) { return esc(ROLE[p.role] || p.role) + ' ' + esc(p.name) + (p.area_ha != null ? ' — ' + num(p.area_ha, 2) + ' га' : ''); }).join('<br>') + '</dd>' : '') +
    '<dt>Породы</dt><dd>' + (md >= 2 ? esc(sm.species_method || '') : 'не определялись (режим 1)') + '</dd>' +
    '<dt>Объёмы</dt><dd>' + (md >= 3 ? esc(((sm.by_species || [])[0] || {}).method || 'по нормативам') : 'не рассчитывались') + '</dd>' +
    '<dt>Версия</dt><dd>' + (j.version || 1) + (j.parent ? ' (пересчёт)' : '') + '</dd><dt>Завершено</dt><dd>' + when(j.finished) + '</dd></dl></section></div></div>';
  return h;
}
function pivotRows(j, st) {
  var sm = j.summary || {}, rows = (sm.by_species || []).map(function (s) { return Object.assign({}, s); });
  var stand = (st && st.stand && st.stand.by_species) || [];
  rows.forEach(function (r) { var x = stand.filter(function (y) { return y.species === r.species; })[0]; if (x) r.polnota = x.polnota; var si = speciesInfo(r.species); r.color = si.color; r.name = r.name || si.name; });
  return rows;
}
function resPivot(j, st) {
  var sm = j.summary || {}, md = modeOf(j), rows = pivotRows(j, st);
  if (md === 1) {
    return '<section class="llw-card"><h3><i class="fa-solid fa-table"></i>Режим 1 — подсчёт стволов</h3><dl class="llw-kv"><dt>Стволов</dt><dd>' + num(sm.trees) + '</dd><dt>На 1 га</dt><dd>' + num(sm.trees_ha, 0) + '</dd><dt>Высота макс.</dt><dd>' + num(sm.h_max, 1) + ' м</dd></dl>' +
      '<div class="llw-hint" style="margin-top:6px">Разбивка по породам — в режимах 2 и 3 (кнопка «Пересчитать»).</div></section>';
  }
  var tot = { trees: 0, per_ha: 0, volume: 0, volume_ha: 0, g_ha: 0 };
  rows.forEach(function (r) { tot.trees += r.trees || 0; tot.per_ha += r.per_ha || 0; tot.volume += r.volume || 0; tot.volume_ha += r.volume_ha || 0; tot.g_ha += r.g_ha || 0; });
  var v3 = md >= 3;
  return '<section class="llw-card"><h3><i class="fa-solid fa-table"></i>Разбивка по породам<span class="llw-r">состав: <b>' + esc(sm.composition || '—') + '</b></span></h3><div class="llw-tw"><table class="llw-t"><thead><tr><th>Порода</th><th class="n">Стволов</th><th class="n">Стволов/га</th><th class="n">Hср, м</th>' +
    (v3 ? '<th class="n">Dср, см</th><th class="n">G, м²/га</th><th class="n">Полнота</th><th class="n">Разряд</th><th class="n">Запас, м³</th><th class="n">Запас, м³/га</th>' : '') + '<th class="n">Доля, %</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr><td><span class="llw-dot" style="background:' + esc(r.color) + '"></span> ' + esc(r.name) + '</td><td class="n">' + num(r.trees) + '</td><td class="n">' + num(r.per_ha, 0) + '</td><td class="n">' + num(r.h_mean, 1) + '</td>' +
        (v3 ? '<td class="n">' + num(r.d_mean, 1) + '</td><td class="n">' + num(r.g_ha, 1) + '</td><td class="n">' + num(r.polnota, 2) + '</td><td class="n">' + (r.rank || 'авто') + '</td><td class="n">' + num(r.volume, 1) + '</td><td class="n">' + num(r.volume_ha, 0) + '</td>' : '') +
        '<td class="n">' + num(v3 ? r.share : (r.trees / Math.max(1, sm.trees) * 100), 1) + '</td></tr>';
    }).join('') +
    '<tr class="tot"><td>Итого</td><td class="n">' + num(tot.trees) + '</td><td class="n">' + num(tot.per_ha, 0) + '</td><td class="n"></td>' + (v3 ? '<td class="n"></td><td class="n">' + num(tot.g_ha, 1) + '</td><td class="n">' + num(st && st.stand && st.stand.polnota, 2) + '</td><td class="n"></td><td class="n">' + num(tot.volume, 1) + '</td><td class="n">' + num(tot.volume_ha, 0) + '</td>' : '') + '<td class="n">100</td></tr>' +
    '</tbody></table></div><div class="llw-hint" style="margin-top:6px">Доля — ' + (v3 ? 'по запасу' : 'по числу стволов') + '. Объём — ' + esc(((rows[0] || {}).method) || 'по нормативам') + '.</div></section>';
}
function pie(items, title) {
  var tot = items.reduce(function (a, b) { return a + (b.v || 0); }, 0);
  if (!tot) return '<div class="llw-sub">Нет данных</div>';
  var a0 = -Math.PI / 2, R = 62, cx = 70, cy = 70, paths = '';
  items.forEach(function (it) {
    var f = it.v / tot, a1 = a0 + f * Math.PI * 2;
    if (f >= 0.9999) paths += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + esc(it.c) + '"/>';
    else if (f > 0) paths += '<path d="M' + cx + ',' + cy + 'L' + (cx + R * Math.cos(a0)).toFixed(2) + ',' + (cy + R * Math.sin(a0)).toFixed(2) + 'A' + R + ',' + R + ' 0 ' + (f > 0.5 ? 1 : 0) + ' 1 ' + (cx + R * Math.cos(a1)).toFixed(2) + ',' + (cy + R * Math.sin(a1)).toFixed(2) + 'Z" fill="' + esc(it.c) + '" stroke="#13241a" stroke-width="1.5"><title>' + esc(it.l) + ': ' + num(f * 100, 1) + '%</title></path>';
    a0 = a1;
  });
  return '<div class="llw-pie"><svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="' + esc(title) + '">' + paths + '<circle cx="70" cy="70" r="30" fill="#13241a"/></svg><ul class="llw-leg">' +
    items.map(function (it) { return '<li><span class="llw-dot" style="background:' + esc(it.c) + '"></span>' + esc(it.l) + ' — <b>' + num(it.v / tot * 100, 1) + '%</b></li>'; }).join('') + '</ul></div>';
}
function spOrder(rows, obj) {   // постоянный порядок пород в столбцах (как в легенде), остальные — в конце
  var o = rows.map(function (r) { return r.species; }).filter(function (k) { return obj[k]; });
  Object.keys(obj).forEach(function (k) { if (o.indexOf(k) < 0) o.push(k); });
  return o;
}
function resCharts(j, st) {
  var md = modeOf(j), rows = pivotRows(j, st), h = '';
  if (md >= 2) {
    h += '<div class="llw-pies"><section class="llw-card"><h3><i class="fa-solid fa-chart-pie"></i>Породы по числу стволов</h3>' + pie(rows.map(function (r) { return { l: r.name, v: r.trees, c: r.color }; }), 'По числу стволов') + '</section>' +
      (md >= 3 ? '<section class="llw-card"><h3><i class="fa-solid fa-chart-pie"></i>Породы по объёму</h3>' + pie(rows.map(function (r) { return { l: r.name, v: r.volume, c: r.color }; }), 'По объёму') + '</section>' : '') + '</div>';
  }
  if (st && st.dbh_classes && st.dbh_classes.length && md >= 3) {
    var mx = Math.max.apply(null, st.dbh_classes.map(function (d) { return d.total; }).concat([1]));
    h += '<section class="llw-card"><h3><i class="fa-solid fa-chart-column"></i>Распределение по ступеням толщины (см)</h3><div class="llw-hist">' + st.dbh_classes.map(function (d) {
      return '<div class="c" title="' + d.d + ' см: ' + d.total + ' шт.">' + spOrder(rows, d.by_species).map(function (sp) { return '<i style="height:' + (d.by_species[sp] / mx * 140).toFixed(1) + 'px;background:' + esc(speciesInfo(sp).color) + '"></i>'; }).join('') + '</div>';
    }).join('') + '</div><div class="llw-hx">' + st.dbh_classes.map(function (d) { return '<span>' + d.d + '</span>'; }).join('') + '</div></section>';
  }
  if (st && st.height_classes && st.height_classes.length) {
    var mh = Math.max.apply(null, st.height_classes.map(function (d) { return d.trees; }).concat([1]));
    h += '<section class="llw-card"><h3><i class="fa-solid fa-chart-column"></i>Распределение стволов по высотам (м)</h3><div class="llw-hist">' + st.height_classes.map(function (d) {
      return '<div class="c" title="' + d.h + '–' + (d.h + 2) + ' м: ' + d.trees + ' шт."><i style="height:' + (d.trees / mh * 140).toFixed(1) + 'px;background:' + (d.h < 5 ? '#7cc4ff' : '#82e938') + '"></i></div>';
    }).join('') + '</div><div class="llw-hx">' + st.height_classes.map(function (d) { return '<span>' + d.h + '</span>'; }).join('') + '</div></section>';
  }
  return h || '<div class="llw-empty">Диаграммы недоступны: нет слоя вершин деревьев (включите экспорт SHP).</div>';
}
function resTrees(el, j, st) {
  var md = modeOf(j), T = { offset: 0, limit: 100, sort: 'h', desc: 1, species: '', flag: '', hmin: '', hmax: '' };
  var acc = (st && st.accounting) || [];
  el.innerHTML = (acc.length ? '<section class="llw-card"><h3><i class="fa-solid fa-scale-balanced"></i>Учёт деревьев — что вошло в отчёты</h3><table class="llw-t"><thead><tr><th>Категория</th><th class="n">Деревьев</th>' + (md >= 3 ? '<th class="n">Объём, м³</th>' : '') + '</tr></thead><tbody>' +
      acc.map(function (a) { var fl = FLAG[a.key]; return '<tr><td>' + (fl ? '<span class="llw-dot" style="background:' + fl[1] + '"></span> ' : '<span class="llw-dot" style="background:#6f8a70"></span> ') + esc(a.label) + '</td><td class="n">' + (a.trees == null ? '—' : num(a.trees)) + '</td>' + (md >= 3 ? '<td class="n">' + (a.volume == null ? '—' : num(a.volume, 1)) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></section>' : '') +
    '<section class="llw-card"><h3><i class="fa-solid fa-list"></i>Подеревный список</h3><div class="llw-row" style="margin-top:0">' +
    (md >= 2 ? '<select data-q="species"><option value="">Все породы</option>' + pivotRows(j, st).map(function (r) { return '<option value="' + esc(r.species) + '">' + esc(r.name) + '</option>'; }).join('') + '</select>' : '') +
    '<select data-q="flag"><option value="">Все отметки</option>' + Object.keys(FLAG).map(function (k) { return '<option value="' + k + '">' + FLAG[k][0] + '</option>'; }).join('') + '</select>' +
    '<input type="number" data-q="hmin" placeholder="H от, м" style="width:90px" min="0" step="0.5"><input type="number" data-q="hmax" placeholder="H до, м" style="width:90px" min="0" step="0.5">' +
    '<span class="llw-sub" data-q="cnt"></span></div><div class="llw-tw"><table class="llw-t"><thead><tr>' +
    [['id', '№'], md >= 2 ? ['species', 'Порода'] : null, ['h', 'H, м'], md >= 3 ? ['dbh', 'D, см'] : null, ['crown_d', 'Ø кроны, м'], md >= 3 ? ['volume', 'V, м³'] : null, md >= 2 ? ['conf', 'Досто­верность'] : null, [null, 'Отметка'], [null, 'Координаты']].filter(Boolean).map(function (c) {
      return '<th' + (c[0] ? ' data-sort="' + c[0] + '"' : '') + ' class="' + (['h', 'dbh', 'crown_d', 'volume', 'conf', 'id'].indexOf(c[0]) >= 0 ? 'n' : '') + '">' + c[1] + '</th>'; }).join('') +
    '</tr></thead><tbody data-q="rows"><tr><td colspan="9" class="llw-sub">Загрузка…</td></tr></tbody></table></div><div class="llw-pager"><button type="button" class="llw-btn sm" data-q="prev">←</button><span data-q="pg"></span><button type="button" class="llw-btn sm" data-q="next">→</button></div></section>';
  function q(k) { return $('[data-q=' + k + ']', el); }
  function load() {
    var qs = '?offset=' + T.offset + '&limit=' + T.limit + '&sort=' + T.sort + '&desc=' + T.desc + (T.species ? '&species=' + encodeURIComponent(T.species) : '') + (T.flag ? '&flag=' + T.flag : '') + (T.hmin !== '' ? '&hmin=' + T.hmin : '') + (T.hmax !== '' ? '&hmax=' + T.hmax : '');
    $$('th[data-sort]', el).forEach(function (th) { th.classList.toggle('on', th.dataset.sort === T.sort); th.textContent = th.textContent.replace(/ [↑↓]$/, '') + (th.dataset.sort === T.sort ? (T.desc ? ' ↓' : ' ↑') : ''); });
    call('GET', '/jobs/' + j.id + '/trees' + qs).then(function (r) {
      q('cnt').textContent = 'найдено ' + num(r.total) + ' из ' + num(r.all);
      q('pg').textContent = r.total ? (T.offset + 1) + '–' + Math.min(r.total, T.offset + T.limit) + ' из ' + num(r.total) : '0';
      q('prev').disabled = T.offset <= 0; q('next').disabled = T.offset + T.limit >= r.total;
      q('rows').innerHTML = r.items.map(function (t) {
        var fl = FLAG[t.flag] || ['—', '#888'], s = speciesInfo(t.species);
        return '<tr><td class="n">' + t.id + '</td>' + (md >= 2 ? '<td><span class="llw-dot" style="background:' + esc(s.color) + '"></span> ' + esc(t.species_name || s.name) + '</td>' : '') + '<td class="n">' + num(t.h, 1) + '</td>' +
          (md >= 3 ? '<td class="n">' + num(t.dbh, 1) + '</td>' : '') + '<td class="n">' + num(t.crown_d, 1) + '</td>' + (md >= 3 ? '<td class="n">' + num(t.volume, 3) + '</td>' : '') +
          (md >= 2 ? '<td class="n">' + num(t.conf, 2) + '</td>' : '') + '<td><span class="llw-flag"><span class="llw-dot" style="background:' + fl[1] + '"></span>' + fl[0] + '</span></td><td class="llw-sub">' + num(t.lat, 6) + ', ' + num(t.lon, 6) + '</td></tr>';
      }).join('') || '<tr><td colspan="9" class="llw-sub">Нет деревьев по фильтру</td></tr>';
    }).catch(function (e) { q('rows').innerHTML = '<tr><td colspan="9" class="llw-err">' + esc(e.message) + '</td></tr>'; });
  }
  $$('th[data-sort]', el).forEach(function (th) { th.onclick = function () { var k = th.dataset.sort; if (T.sort === k) T.desc = T.desc ? 0 : 1; else { T.sort = k; T.desc = k === 'species' || k === 'id' ? 0 : 1; } T.offset = 0; load(); }; });
  ['species', 'flag', 'hmin', 'hmax'].forEach(function (k) { var x = q(k); if (x) x.onchange = function () { T[k] = x.value; T.offset = 0; load(); }; });
  q('prev').onclick = function () { T.offset = Math.max(0, T.offset - T.limit); load(); };
  q('next').onclick = function () { T.offset += T.limit; load(); };
  load();
}
function resFiles(el, j) {
  var files = j.files || [];
  el.innerHTML = '<section class="llw-card"><h3><i class="fa-solid fa-folder-open"></i>Выходные файлы<span class="llw-r"><a class="llw-btn sm" href="' + API + '/jobs/' + j.id + '/zip"><i class="fa-solid fa-file-zipper"></i> Скачать всё (ZIP)</a></span></h3>' +
    (files.length ? '<ul class="llw-files">' + files.map(function (f) {
      var html = f.name === 'dashboard.html';
      return '<li><i class="fa-solid ' + (/\.tif$/.test(f.name) ? 'fa-image' : /\.xlsx$/.test(f.name) ? 'fa-file-excel' : /\.html$/.test(f.name) ? 'fa-chart-line' : /\.(shp|dbf|shx|prj|cpg|qml)$/.test(f.name) ? 'fa-draw-polygon' : 'fa-file') + '" style="color:var(--llw-acc)"></i>' +
        '<span class="nm">' + esc(f.label || f.name) + '<small>' + esc(f.name) + ' · ' + bytes(f.size) + '</small></span>' +
        (html ? '<a class="llw-btn sm" target="_blank" rel="noopener" href="' + API + '/jobs/' + j.id + '/files/' + encodeURIComponent(f.name) + '?inline=1">Открыть</a>' : '') +
        '<a class="llw-btn sm" href="' + API + '/jobs/' + j.id + '/files/' + encodeURIComponent(f.name) + '"><i class="fa-solid fa-download"></i></a></li>';
    }).join('') + '</ul>' : '<div class="llw-sub">Файлов нет.</div>') +
    '<div class="llw-hint" style="margin-top:8px">SHP и GeoTIFF открываются в QGIS (стили .qml рядом). Аналитическая панель открывается в изолированной вкладке.</div></section>';
}

/* ───────────── «Мои обработки»: задания и облака ───────────── */
function openHistory() {
  var M = modal(); clearTimers(); setNav('history');
  var H = S.hist || (S.hist = { q: '', status: '', tab: 'jobs' });
  M.steps.innerHTML = '<span class="llw-sub" style="padding:5px 2px">Все обработки облаков точек: статус, версии пересчёта, итоги. Щёлкните строку, чтобы открыть результаты.</span>';
  M.foot.innerHTML = '<span class="llw-msg" data-h="msg"></span>' +
    '<button type="button" class="llw-btn" data-h="reload"><i class="fa-solid fa-rotate-right"></i> Обновить</button>' +
    (isAdmin() ? '<button type="button" class="llw-btn pri" data-h="new"><i class="fa-solid fa-plus"></i> Новая обработка</button>' : '');
  M.main.innerHTML = '<div class="llw-row" style="margin-top:0">' +
    '<nav class="llw-tabs2" style="margin:0 8px 0 0"><button type="button" data-ht="jobs">Обработки</button><button type="button" data-ht="files">Облака точек</button></nav>' +
    '<input type="search" data-h="q" placeholder="Поиск: название, файл, лесхоз…" autocomplete="off" style="flex:1;min-width:180px">' +
    '<select data-h="status" aria-label="Статус"><option value="">Все статусы</option><option value="running">В работе</option><option value="done">Готово</option><option value="error">Ошибка</option><option value="cancelled">Отменено</option></select>' +
    '</div><div data-h="body"><div class="llw-empty"><span class="llw-spin"></span> Загрузка…</div></div>';
  var q = function (k) { return $('[data-h=' + k + ']', M.el); };
  q('q').value = H.q; q('status').value = H.status;
  var data = { jobs: [], files: [] };
  function tabs() { $$('[data-ht]', M.main).forEach(function (b) { b.classList.toggle('on', b.dataset.ht === H.tab); }); q('status').hidden = H.tab !== 'jobs'; }
  function match(s) { return !H.q || String(s || '').toLowerCase().indexOf(H.q.toLowerCase()) >= 0; }
  function draw() {
    var el = q('body'); if (!el) return; tabs();
    if (H.tab === 'files') return drawFiles(el);
    var list = data.jobs.filter(function (j) {
      if (H.status === 'running' && !(j.status === 'running' || j.status === 'queued')) return false;
      if (H.status && H.status !== 'running' && j.status !== H.status) return false;
      return match(j.name) || match(j.file_name) || match(j.scene && j.scene.name) || match(j.id);
    });
    q('msg').textContent = 'Обработок: ' + data.jobs.length + (list.length !== data.jobs.length ? ' · показано ' + list.length : '') +
      (data.jobs.some(function (j) { return j.status === 'running' || j.status === 'queued'; }) ? ' · идёт обработка, список обновляется' : '');
    if (!list.length) { el.innerHTML = '<div class="llw-empty">' + (data.jobs.length ? 'Ничего не найдено' : 'Обработок ещё нет. ' + (isAdmin() ? 'Нажмите «Новая обработка» или создайте демо-участок.' : '')) + '</div>'; return; }
    el.innerHTML = '<div class="llw-tw" style="max-height:none"><table class="llw-t" data-h="tbl"><thead><tr><th>Название</th><th>Версия</th><th>Режим</th><th>Статус</th><th>Создано</th><th class="n">Деревьев</th><th class="n">Запас, м³</th><th class="n">Площадь, га</th><th></th></tr></thead><tbody>' +
      list.map(function (j) {
        var sm = j.summary || {}, md = modeOf(j), run = j.status === 'running' || j.status === 'queued';
        return '<tr data-id="' + esc(j.id) + '" style="cursor:pointer"><td><b>' + esc(j.name || j.file_name) + '</b><div class="llw-sub">' + esc(j.file_name || '') +
          (j.scene && j.scene.name ? ' · ' + esc(j.scene.name) : '') + (j.boundary && j.boundary.label ? ' · ' + esc(j.boundary.label) : '') + '</div></td>' +
          '<td>v' + (j.version || 1) + (j.parent ? ' <span class="llw-sub" title="Пересчёт">↻</span>' : '') + '</td><td>' + md + '</td>' +
          '<td>' + statusChip(j) + (run ? '<div class="llw-bar" style="margin:5px 0 0;height:5px"><i style="width:' + Math.max(2, Math.min(100, +j.progress || 0)) + '%"></i></div><div class="llw-sub">' + esc(j.stage || '') + '</div>' : '') +
          (j.status === 'error' && j.error ? '<div class="llw-sub llw-err" style="max-width:240px">' + esc(String(j.error).slice(0, 120)) + '</div>' : '') + '</td>' +
          '<td class="llw-sub">' + when(j.created) + '</td><td class="n">' + num(sm.trees) + '</td><td class="n">' + (md >= 3 ? num(sm.volume, 1) : '—') + '</td><td class="n">' + num(sm.area_ha, 2) + '</td>' +
          '<td style="white-space:nowrap">' + (j.status === 'done' ? '<button type="button" class="llw-btn sm" data-a="3d" title="Показать в 3D"><i class="fa-solid fa-cube"></i></button> <a class="llw-btn sm" data-a="zip" title="Все файлы (ZIP)" href="' + API + '/jobs/' + esc(j.id) + '/zip"><i class="fa-solid fa-file-zipper"></i></a> ' : '') +
          (isAdmin() && !run ? '<button type="button" class="llw-btn sm danger" data-a="del" title="Удалить обработку"><i class="fa-solid fa-trash"></i></button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function drawFiles(el) {
    var list = data.files.filter(function (f) { return match(f.name) || match(f.id); });
    q('msg').textContent = 'Облаков: ' + data.files.length;
    if (!list.length) { el.innerHTML = '<div class="llw-empty">' + (data.files.length ? 'Ничего не найдено' : 'Загруженных облаков нет.') + '</div>'; return; }
    el.innerHTML = '<div class="llw-tw" style="max-height:none"><table class="llw-t"><thead><tr><th>Файл</th><th class="n">Размер</th><th class="n">Точек</th><th>CRS</th><th>Загружен</th><th>Обработки</th><th></th></tr></thead><tbody>' +
      list.map(function (f) {
        var h = f.header || {}, inf = f.info || {}, lj = f.last_job;
        return '<tr data-fid="' + esc(f.id) + '"><td><b>' + esc(f.name) + '</b>' + (f.info_error ? '<div class="llw-sub llw-err">' + esc(f.info_error) + '</div>' : '') + '</td>' +
          '<td class="n">' + bytes(f.size) + '</td><td class="n">' + num(inf.points || h.points) + '</td><td>' + (inf.epsg ? 'EPSG:' + esc(inf.epsg) : (inf.crs ? 'WKT' : '<span class="llw-sub">не указана</span>')) + '</td>' +
          '<td class="llw-sub">' + when(f.created) + '</td><td>' + (f.jobs || 0) + (lj ? ' · ' + statusChip(lj) : '') + '</td>' +
          '<td style="white-space:nowrap">' + (isAdmin() ? '<button type="button" class="llw-btn sm" data-a="run" title="Новая обработка этого облака"><i class="fa-solid fa-play"></i> Обработать</button> ' : '') +
          (lj ? '<button type="button" class="llw-btn sm" data-a="last" title="Последняя обработка"><i class="fa-solid fa-chart-column"></i></button> ' : '') +
          (isAdmin() ? '<button type="button" class="llw-btn sm danger" data-a="fdel" title="Удалить облако"><i class="fa-solid fa-trash"></i></button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function load(quiet) {
    if (!S.modal || S.modal.view !== 'history') return;
    if (!quiet) q('body').innerHTML = '<div class="llw-empty"><span class="llw-spin"></span> Загрузка…</div>';
    Promise.all([caps(), jobs(true), call('GET', '/files').catch(function () { return { items: [] }; })]).then(function (r) {
      if (!S.modal || S.modal.view !== 'history') return;
      data.jobs = r[1]; data.files = r[2].items || [];
      draw();
      if (data.jobs.some(function (j) { return j.status === 'running' || j.status === 'queued'; })) S.modal.timers.push(setTimeout(function () { load(true); }, 2500));
    }).catch(function (e) { var el = q('body'); if (el) el.innerHTML = '<div class="llw-empty llw-err">' + esc(e.message) + '</div>'; });
  }
  q('q').oninput = function () { H.q = this.value.trim(); draw(); };
  q('status').onchange = function () { H.status = this.value; draw(); };
  $$('[data-ht]', M.main).forEach(function (b) { b.onclick = function () { H.tab = b.dataset.ht; draw(); }; });
  q('reload').onclick = function () { clearTimers(); load(); };
  if (q('new')) q('new').onclick = function () { openWizard(S.wiz && S.wiz.ctx, { fresh: !(S.wiz && !S.wiz.job && S.wiz.step < 4) }); };
  q('body').addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]'), tr = e.target.closest('tr[data-id],tr[data-fid]'); if (!tr) return;
    var id = tr.dataset.id, fid = tr.dataset.fid, j = id && data.jobs.filter(function (x) { return x.id === id; })[0];
    var f = fid && data.files.filter(function (x) { return x.id === fid; })[0];
    if (a && a.dataset.a === 'zip') return;
    if (a && a.dataset.a === '3d' && j) { e.stopPropagation(); show3D(j); return; }
    if (a && a.dataset.a === 'del' && j) {
      e.stopPropagation();
      if (!confirm('Удалить обработку «' + (j.name || j.id) + '» (v' + (j.version || 1) + ') со всеми результатами?')) return;
      call('DELETE', '/jobs/' + j.id).then(function () { toast('Обработка удалена'); S.jobsCache = null; load(true); refreshPickers(); }).catch(function (er) { toast(er.message, true); });
      return;
    }
    if (a && a.dataset.a === 'fdel' && f) {
      if (!confirm('Удалить облако «' + f.name + '» (' + bytes(f.size) + ')? Результаты обработок останутся.')) return;
      call('DELETE', '/files/' + f.id).then(function () { toast('Облако удалено'); load(true); }).catch(function (er) { toast(er.message, true); });
      return;
    }
    if (a && a.dataset.a === 'run' && f) { openWizard(S.wiz && S.wiz.ctx, { fresh: true, file: f }); return; }
    if (a && a.dataset.a === 'last' && f && f.last_job) { openJob(f.last_job.id); return; }
    if (j) openJob(j.id);
  });
  load();
}
function openJob(jid, tab) {
  var M = modal(); clearTimers(); setNav('wizard');
  M.main.innerHTML = '<div class="llw-empty"><span class="llw-spin"></span> Открываю обработку…</div>'; M.steps.innerHTML = ''; M.foot.innerHTML = '';
  caps().then(function () { return call('GET', '/jobs/' + encodeURIComponent(jid)); }).then(function (j) {
    var W = wizardFromJob(j, S.wiz && S.wiz.ctx);
    W.job = j; W.parent = j.parent || null; W.step = j.status === 'done' ? 5 : 4; W.max = W.step; if (tab) W.tab = tab;
    S.wiz = W;
    return call('GET', '/files/' + encodeURIComponent(j.file_id)).then(function (f) { W.file = f; }, function () {}).then(function () { if (S.wiz === W && S.modal) renderWizard(); });
  }).catch(function (e) { M.main.innerHTML = '<div class="llw-empty llw-err">Обработка недоступна: ' + esc(e.message) + '</div>'; });
}

/* ───────────── блок «Обработка LAS» в окне выбора 3D ───────────── */
function refreshPickers() {
  S.pickers = S.pickers.filter(function (P) { return P.el && document.body.contains(P.el); });
  S.pickers.forEach(function (P) { P.render(); });
  S.viewers = S.viewers.filter(function (V) { return V.alive; });
  S.viewers.forEach(function (V) { V.reload(); });
}
function pickerBlock(p, ctx) {
  css(); ctx = ctx || {};
  if (!p) return null;
  var old = $('.llw-pick', p); if (old) old.remove();
  var open = true; try { open = localStorage.getItem(LS_OPEN) !== '0'; } catch (e) {}
  var el = document.createElement('section'); el.className = 'llw-pick' + (open ? '' : ' closed'); el.setAttribute('data-llw', 'pick');
  el.innerHTML = '<div class="llw-pick-h" role="button" tabindex="0" aria-expanded="' + open + '" title="Свернуть / развернуть">' +
    '<i class="fa-solid fa-tree"></i>Обработка LAS · ЛесоЛидар<span class="llw-badge off" data-k="badge">…</span><i class="fa-solid fa-chevron-down llw-car"></i></div>' +
    '<div class="llw-pick-b"><div class="llw-pick-sub" data-k="sub">Проверяю обработчик…</div><div class="llw-pick-btns" data-k="btns"></div><ul class="llw-pick-jobs" data-k="jobs"></ul></div>';
  var head = $('.v3d-ph', p);
  if (head && head.parentNode === p) p.insertBefore(el, head.nextSibling); else p.insertBefore(el, p.firstChild);
  var P = { el: el, ctx: ctx, t: 0 };
  var k = function (n) { return $('[data-k=' + n + ']', el); };
  var h = $('.llw-pick-h', el);
  function toggle() { var c = el.classList.toggle('closed'); h.setAttribute('aria-expanded', String(!c)); try { localStorage.setItem(LS_OPEN, c ? '0' : '1'); } catch (e) {} }
  h.onclick = toggle; h.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  function wctx() { return { mapCenter: ctx.mapCenter, from: 'picker' }; }
  P.render = function () {
    clearTimeout(P.t);
    if (!document.body.contains(el)) return;
    caps().then(function (c) {
      var adm = !!c.is_admin, ready = !!c.available;
      var b = k('badge'); b.className = 'llw-badge ' + (ready ? 'ok' : 'warn'); b.textContent = ready ? (c.queue ? 'В работе: ' + c.queue : 'Готов') : 'Не настроен';
      b.title = ready ? 'Обработчик: ' + (c.engine === 'exe' ? 'LesoLidar.exe' : 'LesoLidar (Python)') : (c.problems || []).join('; ');
      k('sub').innerHTML = ready ? 'Деревья, породы и запас по облаку LAS/LAZ: мастер в 6 шагов, сводка, пивот, «Учёт деревьев», показ в 3D.'
        : '<span style="color:#ffe08a">' + esc(problemHead(c, adm)) + '</span>' + (adm ? setupHtml(c) : '');
      return jobs(true).then(function (list) {
        if (!document.body.contains(el)) return;
        var btns = '';
        if (adm && !ready) btns += '<button type="button" data-b="recheck" title="Проверить снова, найден ли LesoLidar.exe (после копирования программы перезапуск не нужен)"><i class="fa-solid fa-rotate"></i> Проверить снова</button>';
        if (adm) btns += '<button type="button" class="pri" data-b="new"><i class="fa-solid fa-plus"></i> Новая обработка</button>';
        if (adm && c.demo) btns += '<button type="button" data-b="demo" title="Сгенерировать тестовое облако в центре карты и обработать его"><i class="fa-solid fa-flask"></i> Демо-участок</button>';
        btns += '<button type="button" data-b="hist"><i class="fa-solid fa-list-check"></i> Мои обработки<b>' + list.length + '</b></button>';
        k('btns').innerHTML = btns;
        var last = list.slice(0, 3), running = list.some(function (j) { return j.status === 'running' || j.status === 'queued'; });
        k('jobs').innerHTML = last.map(function (j) {
          var sm = j.summary || {}, run = j.status === 'running' || j.status === 'queued';
          return '<li data-jid="' + esc(j.id) + '" title="Открыть обработку"><div class="t"><span>' + esc(j.name || j.file_name) + ' · v' + (j.version || 1) + '</span>' + statusChip(j) + '</div>' +
            (run ? '<div class="llw-bar" style="height:5px;margin:4px 0 2px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden"><i style="display:block;height:100%;background:var(--llw-acc);width:' + Math.max(2, Math.min(100, +j.progress || 0)) + '%"></i></div><div class="s">' + esc(j.stage || '') + (j.eta_s ? ' · осталось ~' + dur(j.eta_s) : '') + '</div>'
              : '<div class="s">' + when(j.finished || j.created) + (j.status === 'done' ? ' · ' + num(sm.trees) + ' дер.' + (modeOf(j) >= 3 && sm.volume != null ? ' · ' + num(sm.volume, 0) + ' м³' : '') + ' · ' + num(sm.area_ha, 1) + ' га' : (j.error ? ' · ' + esc(String(j.error).slice(0, 70)) : '')) + '</div>') + '</li>';
        }).join('');
        if (running) P.t = setTimeout(P.render, 2500);
      });
    }).catch(function (e) {
      if (!document.body.contains(el)) return;
      var b = k('badge'); b.className = 'llw-badge warn'; b.textContent = 'Недоступен';
      k('sub').textContent = 'Сервис ЛесоЛидар недоступен: ' + e.message; k('btns').innerHTML = ''; k('jobs').innerHTML = '';
    });
  };
  el.addEventListener('click', function (e) {
    var b = e.target.closest('[data-b]'), li = e.target.closest('li[data-jid]');
    if (b) {
      if (b.dataset.b === 'new') openWizard(wctx(), { fresh: !(S.wiz && !S.wiz.job && S.wiz.step < 4 && S.wiz.ctx && S.wiz.ctx.from === 'picker') });
      if (b.dataset.b === 'demo') openWizard(wctx(), { fresh: true, demo: true });
      if (b.dataset.b === 'hist') openHistory();
      if (b.dataset.b === 'recheck') { b.disabled = true; caps('recheck').then(function (c) { toast(c.available ? 'ЛесоЛидар найден — можно запускать обработку' : 'LesoLidar.exe пока не найден', !c.available); }, function () {}).then(P.render); }
    } else if (li) openJob(li.dataset.jid);
  });
  ['pointerdown', 'wheel', 'keydown'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.stopPropagation(); }); });
  S.pickers.push(P);
  P.render();
  return P;
}

/* ───────────── показ результатов в 3D ───────────── */
function show3D(job) {
  if (!job || job.status !== 'done') { toast('Обработка ещё не завершена', true); return; }
  var V = S.viewers.filter(function (x) { return x.alive && x.api.isAlive(); })[0];
  if (V && V.covers(job)) { close(); V.show(job.id, true); return; }
  S.pending3D = job.id;
  function openCode(code) {
    if (!(root.forest3d && root.forest3d.open)) { S.pending3D = null; toast('3D-модуль не загружен (view3d.js)', true); return; }
    close(); root.forest3d.open(code);
  }
  if (job.scene && job.scene.code) { openCode(job.scene.code); return; }
  var b = job.bbox_ll;
  if (!b) { S.pending3D = null; toast('У обработки нет координат участка', true); return; }
  fetch('/api/forest3d/at?lon=' + ((b[0] + b[2]) / 2).toFixed(6) + '&lat=' + ((b[1] + b[3]) / 2).toFixed(6), { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) { if (!j.found) { S.pending3D = null; toast('Участок вне известных лесхозов — 3D-сцена не найдена', true); return; } openCode(j.code); })
    .catch(function (e) { S.pending3D = null; toast('3D: ' + e.message, true); });
}
function sphInverse(c) {   // запасной вариант (сфера) — если нет Forest3DMapLayers.projection
  var D = Math.PI / 180, R = 6371008.8, phi0 = c[1] * D;
  return function (x, y) {
    var rho = Math.hypot(x, y); if (rho < 1e-6) return [c[0], c[1]];
    var k = rho / R, lat = Math.asin(Math.cos(k) * Math.sin(phi0) + y * Math.sin(k) * Math.cos(phi0) / rho);
    return [c[0] + Math.atan2(x * Math.sin(k), rho * Math.cos(phi0) * Math.cos(k) - y * Math.sin(phi0) * Math.sin(k)) / D, lat / D];
  };
}
function projector(center) {
  var P = root.Forest3DMapLayers && root.Forest3DMapLayers.projection;
  var inv = P && P.inverseAEQD ? function (x, y) { return P.inverseAEQD(center, x, y); } : sphInverse(center), J = null;
  function jac(x, y) {
    var e = 5, a = inv(x, y), bx = inv(x + e, y), by = inv(x, y + e);
    var j11 = (bx[0] - a[0]) / e, j21 = (bx[1] - a[1]) / e, j12 = (by[0] - a[0]) / e, j22 = (by[1] - a[1]) / e, det = j11 * j22 - j12 * j21;
    return { x: x, y: y, a: a, i11: j22 / det, i12: -j12 / det, i21: -j21 / det, i22: j11 / det };
  }
  function fwd(lon, lat) {
    if (!J || Math.abs(lon - J.a[0]) > 0.3 || Math.abs(lat - J.a[1]) > 0.2) {
      var D = Math.PI / 180; J = jac((lon - center[0]) * D * 6371008.8 * Math.cos(lat * D), (lat - center[1]) * D * 6371008.8);
    }
    var x = J.x + J.i11 * (lon - J.a[0]) + J.i12 * (lat - J.a[1]), y = J.y + J.i21 * (lon - J.a[0]) + J.i22 * (lat - J.a[1]);
    for (var i = 0; i < 4; i++) {
      var g = inv(x, y), dl = lon - g[0], dp = lat - g[1];
      if (Math.abs(dl) < 2e-10 && Math.abs(dp) < 2e-10) break;
      x += J.i11 * dl + J.i12 * dp; y += J.i21 * dl + J.i22 * dp;
    }
    return [x, y];
  }
  return { inv: inv, fwd: fwd };
}
var NATURAL = {   // натуральные цвета крон по породам (id из таблицы пород LesoLidar)
  1: '#4b7043', 2: '#2f5a3c', 3: '#7f9c4c', 11: '#93b552', 12: '#7fa64d', 13: '#587f40', 14: '#6d9250', 15: '#5f8139', 16: '#6b8f43', 17: '#7a9a4b', 30: '#3f7448', 31: '#719947'
};
function decodeTrees(buf, center) {
  var REC = 40, n = Math.floor(buf.byteLength / REC), dv = new DataView(buf), pr = projector(center);
  var arr = new Float32Array(n * 7), sp = new Uint8Array(n), byId = {}, groups = {};
  ((S.caps && S.caps.species) || []).forEach(function (s) { byId[s.id] = s; });
  var meta = { trees: n, conifer: 0, deciduous: 0, h_mean: 0, dbh_mean: 0, h_max: 0, dbh_measured: 0, h_classes: [0, 1, 2, 3].map(function () { return { conifer: 0, deciduous: 0 }; }), volume: 0 };
  var hs = 0, ds = 0, counts = {};
  for (var i = 0; i < n; i++) {
    var o = i * REC, lon = dv.getFloat64(o, true), lat = dv.getFloat64(o + 8, true), h = dv.getFloat32(o + 16, true), dbh = dv.getFloat32(o + 20, true),
      cd = dv.getFloat32(o + 24, true), vol = dv.getFloat32(o + 28, true), sid = dv.getUint8(o + 36);
    var s = byId[sid], con = s ? s.group === 'conifer' : sid < 10 || sid === 30;
    var xy = pr.fwd(lon, lat), b = i * 7;
    arr[b] = xy[0]; arr[b + 1] = xy[1]; arr[b + 2] = h; arr[b + 3] = isFinite(dbh) ? dbh : 0; arr[b + 4] = isFinite(cd) && cd > 0 ? cd : Math.max(1, h * 0.22);
    arr[b + 5] = h * (con ? 0.32 : 0.42); arr[b + 6] = con ? 1 : 2;
    sp[i] = sid; counts[sid] = (counts[sid] || 0) + 1;
    if (con) meta.conifer++; else meta.deciduous++;
    hs += h; ds += arr[b + 3]; if (h > meta.h_max) meta.h_max = h; if (isFinite(vol)) meta.volume += vol;
    meta.h_classes[h < 10 ? 0 : h < 20 ? 1 : h < 30 ? 2 : 3][con ? 'conifer' : 'deciduous']++;
  }
  meta.h_mean = n ? hs / n : 0; meta.dbh_mean = n ? ds / n : 0;
  var legend = Object.keys(counts).map(function (id) { var s = byId[id] || { name: 'порода ' + id, color: '#9e9e9e', code: '' }; return { id: +id, name: s.name, color: s.color, code: s.code, n: counts[id] }; })
    .sort(function (a, b) { return b.n - a.n; });
  var names = {}, colors = {}, natural = {};
  legend.forEach(function (l) { names[l.id] = l.name; colors[l.id] = l.color; natural[l.id] = NATURAL[l.id] || (l.id < 10 || l.id === 30 ? NATURAL[30] : NATURAL[31]); l.natural = natural[l.id]; });
  return { n: n, arr: arr, species: sp, meta: meta, legend: legend, names: names, colors: colors, natural: natural, proj: pr };
}
function sceneGeoJSON(d, pr) {
  var polys = d.polygons_m || [], total = 0;
  polys.forEach(function (p) { p.forEach(function (r) { total += r.length; }); });
  var step = Math.max(1, Math.ceil(total / 15000));
  var mp = polys.map(function (p) {
    return p.map(function (r) {
      var out = [];
      for (var i = 0; i < r.length; i += step) out.push(pr.inv(r[i][0], r[i][1]).map(function (v) { return +v.toFixed(7); }));
      if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
      return out;
    }).filter(function (r) { return r.length >= 4; });
  }).filter(function (p) { return p.length; });
  return mp.length ? { type: 'Feature', properties: { name: d.name || d.code }, geometry: { type: 'MultiPolygon', coordinates: mp } } : null;
}
function attach(api) {
  css();
  if (!api || !api.host) return null;
  var d = api.data || {}, pr = projector(d.center || [0, 0]), key = function (jid) { return 'll-' + jid; };
  var V = { api: api, alive: true, jobs: [], on: {}, terr: {}, busy: {}, lay: {}, t: 0, cmode: prefs().ll3d_color === 'legend' ? 'legend' : 'natural' };
  var c = api.card('v3d-ll', 'fa-tree', 'ЛесоЛидар · обработки LAS', true), body = $('.v3d-body', c);
  body.innerHTML = '<div class="llw-3d-cm" role="group" aria-label="Цвет крон">Цвет крон: <button type="button" data-a="cm" data-v="natural">натуральный</button><button type="button" data-a="cm" data-v="legend">по породам</button></div>' +
    '<div class="llw-3d-list"><div class="sub">Загрузка обработок…</div></div><div class="llw-3d-act"></div>' +
    '<div class="note" style="margin-top:6px">Наведите курсор на дерево — порода, высота, диаметр, источник. «Рельеф LAS» — ЦМР из обработки (точнее общей ЦМР внутри участка).</div>';
  function cmBtns() { $$('[data-a=cm]', body).forEach(function (b) { b.classList.toggle('on', b.dataset.v === V.cmode); }); }
  cmBtns();
  if (api.after && api.after.parentNode === api.host) api.host.insertBefore(c, api.after.nextSibling); else api.host.appendChild(c);
  var list = $('.llw-3d-list', body), act = $('.llw-3d-act', body);
  V.covers = function (j) {
    if (j.scene && j.scene.code && j.scene.code === api.code) return true;
    var b = j.bbox_ll, bb = d.bbox_wgs84; return !!(b && bb) && !(b[2] < bb[0] || b[0] > bb[2] || b[3] < bb[1] || b[1] > bb[3]);
  };
  function hasDtm(j) { return (j.files || []).some(function (f) { return f.name === 'dtm.tif'; }); }
  function render() {
    if (!V.alive) return;
    var c0 = S.caps || {}, items = V.jobs.filter(function (j) { return j.status !== 'cancelled'; });
    list.innerHTML = items.length ? items.map(function (j) {
      var sm = j.summary || {}, L = V.lay[j.id], run = j.status === 'running' || j.status === 'queued';
      if (j.status !== 'done') return '<div class="llw-3d-job" data-jid="' + esc(j.id) + '"><div class="t"><i class="fa-solid ' + (run ? 'fa-gear fa-spin' : 'fa-triangle-exclamation') + '" style="color:' + (run ? '#82e938' : '#ff8a80') + ';width:16px"></i><span title="' + esc(j.name) + '">' + esc(j.name || j.file_name) + ' · v' + (j.version || 1) + '</span><button type="button" data-a="res" title="Открыть"><i class="fa-solid fa-up-right-from-square"></i></button></div>' +
        '<div class="s">' + (run ? esc(j.stage || 'В очереди') + ' · ' + Math.round(+j.progress || 0) + '%' : esc(j.status === 'error' ? 'Ошибка: ' + String(j.error || '').slice(0, 80) : j.status)) + '</div></div>';
      return '<div class="llw-3d-job" data-jid="' + esc(j.id) + '"><div class="t"><input type="checkbox" data-a="trees" title="Показать деревья"' + (V.on[j.id] ? ' checked' : '') + (V.busy[j.id] ? ' disabled' : '') + '>' +
        '<span title="' + esc(j.name) + '">' + esc(j.name || j.file_name) + ' · v' + (j.version || 1) + '</span>' +
        '<button type="button" data-a="fly" title="Подлететь к участку"><i class="fa-solid fa-location-arrow"></i></button>' +
        '<button type="button" data-a="res" title="Результаты таксации"><i class="fa-solid fa-chart-column"></i></button></div>' +
        '<div class="s">' + (V.busy[j.id] ? '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(V.busy[j.id]) + ' · ' : '') + num(sm.trees) + ' дер. · ' + num(sm.area_ha, 1) + ' га' + (sm.composition && modeOf(j) >= 2 ? ' · ' + esc(sm.composition) : '') +
        (modeOf(j) >= 3 && sm.volume != null ? ' · ' + num(sm.volume, 0) + ' м³' : '') + (V.covers(j) ? '' : ' · <span style="color:#ffd54a">вне сцены</span>') + '</div>' +
        (hasDtm(j) ? '<div class="s"><label style="cursor:pointer"><input type="checkbox" data-a="terr"' + (V.terr[j.id] ? ' checked' : '') + '> рельеф LAS (ЦМР обработки)</label></div>' : '') +
        (L && V.on[j.id] ? '<div class="llw-3d-leg">' + L.legend.slice(0, 8).map(function (s) { return '<span><i class="llw-dot" style="width:9px;height:9px;border-radius:50%;display:inline-block;background:' + esc(V.cmode === 'legend' ? s.color : s.natural) + '"></i>' + esc(s.name) + ' ' + num(s.n) + '</span>'; }).join('') + '</div>' : '') + '</div>';
    }).join('') : '<div class="sub">Для этой сцены обработок ЛесоЛидар нет.' + (c0.is_admin ? ' Запустите новую или демо-обработку.' : '') + '</div>';
    act.innerHTML = (c0.is_admin ? '<button type="button" class="pri" data-a="new"><i class="fa-solid fa-plus"></i> Новая обработка</button>' : '') +
      (c0.is_admin && c0.demo ? '<button type="button" data-a="demo" title="Тестовое облако в центре текущего вида"><i class="fa-solid fa-flask"></i> Демо здесь</button>' : '') +
      '<button type="button" data-a="hist"><i class="fa-solid fa-list-check"></i> Все обработки</button>';
  }
  function sceneCtx() {
    var t = api.target ? api.target() : null, center = d.center, z0;
    if (t) { center = pr.inv(t[0], t[1]); z0 = api.groundZ ? api.groundZ(t[0], t[1]) : undefined; }
    var gj = null; try { gj = sceneGeoJSON(d, pr); } catch (e) {}
    return { from: 'viewer', viewer: V, scene: { code: api.code, name: api.name || d.name || api.code, center: center, z0: isFinite(z0) ? +z0.toFixed(2) : undefined, geojson: gj } };
  }
  function load() {
    if (!V.alive || !api.isAlive()) return;
    clearTimeout(V.t);
    var bb = d.bbox_wgs84;
    Promise.all([caps(), call('GET', '/jobs?limit=60&code=' + encodeURIComponent(api.code || '') + (bb ? '&bbox=' + bb.map(function (v) { return (+v).toFixed(6); }).join(',') : ''))]).then(function (r) {
      if (!V.alive || !api.isAlive()) return;
      V.jobs = r[1].items || [];
      render();
      if (S.pending3D) { var id = S.pending3D; S.pending3D = null; V.show(id, true); }
      if (V.jobs.some(function (j) { return j.status === 'running' || j.status === 'queued'; })) V.t = setTimeout(load, 3000);
    }).catch(function (e) { list.innerHTML = '<div class="sub" style="color:#ff9d9d">ЛесоЛидар: ' + esc(e.message) + '</div>'; act.innerHTML = ''; });
  }
  V.reload = load;
  function loadTerrain(jid, quiet) {
    if (!V.alive) return Promise.resolve();
    if (!quiet) { V.busy[jid] = 'рельеф LAS…'; render(); }
    return call('GET', '/jobs/' + jid + '/terrain?lon=' + d.center[0].toFixed(7) + '&lat=' + d.center[1].toFixed(7) + '&max_nodes=320').then(function (g) {
      if (!V.alive || !api.isAlive()) return;
      api.addTerrain(key(jid), g); V.terr[jid] = true;
    }).catch(function (e) { V.terr[jid] = false; toast('Рельеф LAS: ' + e.message, true); }).then(function () { if (!quiet) delete V.busy[jid]; render(); });
  }
  V.show = function (jid, fly) {
    if (!V.alive) return;
    V.on[jid] = true;
    if (V.lay[jid]) { api.setTreesVisible(key(jid), true); if (fly) api.fly(key(jid)); render(); return; }
    var j = V.jobs.filter(function (x) { return x.id === jid; })[0];
    var pre = j ? Promise.resolve(j) : call('GET', '/jobs/' + jid);
    V.busy[jid] = 'загрузка деревьев…'; render();
    pre.then(function (job) {
      if (!V.jobs.some(function (x) { return x.id === jid; })) V.jobs.unshift(job);
      var terr = hasDtm(job) && V.terr[jid] !== false && !api.hasTerrain(key(jid)) ? loadTerrain(jid, true) : Promise.resolve();
      V.busy[jid] = 'загрузка деревьев…';
      return Promise.all([terr, fetch(API + '/jobs/' + jid + '/trees.bin', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('деревья не загружены (HTTP ' + r.status + ')'); return r.arrayBuffer(); })]).then(function (res) {
        if (!V.alive || !api.isAlive()) return;
        var t = decodeTrees(res[1], d.center);
        V.lay[jid] = t;
        api.addTrees(key(jid), t.arr, t.meta, { species: t.species, names: t.names, colors: V.cmode === 'legend' ? t.colors : t.natural, colorMode: V.cmode, source: 'ЛесоЛидар · ' + (job.name || jid) });
        if (fly) api.fly(key(jid));
        if (t.n > 600000) toast('Показана выборка из ' + num(t.n) + ' деревьев');
      });
    }).catch(function (e) { V.on[jid] = false; toast('ЛесоЛидар: ' + e.message, true); }).then(function () { delete V.busy[jid]; render(); });
  };
  V.hide = function (jid) { V.on[jid] = false; if (V.lay[jid]) api.setTreesVisible(key(jid), false); render(); };
  body.addEventListener('click', function (e) {
    var a = e.target.closest('[data-a]'); if (!a) return;
    var row = a.closest('[data-jid]'), jid = row && row.dataset.jid, j = jid && V.jobs.filter(function (x) { return x.id === jid; })[0];
    var t = a.dataset.a;
    if (t === 'cm') {
      V.cmode = a.dataset.v === 'legend' ? 'legend' : 'natural'; prefs({ ll3d_color: V.cmode }); cmBtns();
      Object.keys(V.lay).forEach(function (id) { if (api.recolor) api.recolor(key(id), V.cmode === 'legend' ? V.lay[id].colors : V.lay[id].natural, V.cmode); });
      render(); return;
    }
    if (t === 'trees') { if (a.checked) V.show(jid, !V.lay[jid]); else V.hide(jid); }
    if (t === 'terr') {
      if (a.checked) { if (api.hasTerrain(key(jid))) { api.setTerrainVisible(key(jid), true); V.terr[jid] = true; } else loadTerrain(jid); }
      else { V.terr[jid] = false; api.setTerrainVisible(key(jid), false); }
    }
    if (t === 'fly') { if (V.lay[jid]) { if (!V.on[jid]) V.show(jid, true); else api.fly(key(jid)); } else V.show(jid, true); }
    if (t === 'res' && jid) openJob(jid);
    if (t === 'new') openWizard(sceneCtx(), { fresh: true });
    if (t === 'demo') openWizard(sceneCtx(), { fresh: true, demo: true });
    if (t === 'hist') openHistory();
  });
  V.dispose = function () { V.alive = false; clearTimeout(V.t); S.viewers = S.viewers.filter(function (x) { return x !== V; }); };
  S.viewers.push(V);
  load();
  return V;
}

root.LesoLidarWeb = { version: VERSION, pickerBlock: pickerBlock, openWizard: openWizard, openHistory: openHistory, openJob: openJob, attach: attach, show3D: show3D, refresh: refreshPickers, _decode: decodeTrees, _projector: projector };
})(window);
