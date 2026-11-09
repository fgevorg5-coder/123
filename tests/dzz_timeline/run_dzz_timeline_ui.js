/* v20.8–v20.10 — UI-тесты «Приблизить к слою» (ДЗЗ), поиска и «Съёмки по годам» на стенде stand.py.
 * Запуск:  python3 stand.py 8210 &   затем
 *          REPORT_TAG=v20.10 NODE_PATH=<node_modules с playwright> CHROME=$(which chromium) node run_dzz_timeline_ui.js [http://127.0.0.1:8210]
 * Результат: reports/<REPORT_TAG>_ui_report.json и .md, скриншоты reports/<REPORT_TAG>_shots/*.png (по умолчанию v20.10).
 * v20.10: тайлы снимка из шкалы (журнал GetMap стенда: LAYERS и _target) и размер шкалы (A−/A+, авто-уменьшение). */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = (process.argv[2] || 'http://127.0.0.1:8208').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '..', '..');
const TAG = process.env.REPORT_TAG || 'v20.10';
const SHOTS = path.join(ROOT, 'reports', TAG + '_shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let browser, TRUTH = {};

function ok(name, pass, info) { results.push({ name, pass: !!pass, info: info || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); }
async function mode(q) { await fetch(BASE + '/__mode?' + q); }
function truthOf(id) { const k = Object.keys(TRUTH).find(x => x.includes(id) && /_bounds$/.test(x)) || Object.keys(TRUTH).find(x => x.includes(id)); return k ? TRUTH[k] : null; }
const inside = (c, b) => c && b && c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
const contains = (o, i) => o && i && o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];
const f3 = a => a ? a.map(v => Math.round(v * 1000) / 1000).join(', ') : 'null';

async function open(q, opt) {
  opt = opt || {};
  const ctx = await browser.newContext({ viewport: { width: opt.w || 1600, height: opt.h || 900 } });
  const p = await ctx.newPage();
  p._errs = [];
  p.on('pageerror', e => p._errs.push('PAGEERR ' + (e.message || e).toString().slice(0, 300)));
  if (opt.noFix) await p.route('**/static/dzz-extent.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* v20.7: без dzz-extent.js */' }));
  await p.addInitScript(o => {
    try {
      if (!sessionStorage.getItem('__init')) {
        sessionStorage.setItem('__init', '1');
        localStorage.removeItem('dzz_extent_cache_v208');
        if (!o.keepState) localStorage.removeItem('ytl208_state');
        localStorage.setItem('btn_timeline', 'true');
        localStorage.setItem('map_active_basemap', 'esri-topo');
        localStorage.removeItem('ui_open_panel');
        Object.keys(o.ls || {}).forEach(k => localStorage.setItem(k, o.ls[k]));
      }
    } catch (_) {}
  }, { keepState: !!opt.keepState, ls: opt.ls || {} });
  await p.goto(BASE + '/' + (q || ''), { waitUntil: 'load' });
  await p.waitForFunction(() => window.map && window._dzzTabs && window.EXTERNAL_LAYER_DEFS && (window.DzzExtent || window.__noFixOk !== undefined || true), null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    window.__toasts = [];
    const o = window.showToast;
    window.showToast = function (m, e) { window.__toasts.push([String(m), !!e]); return o && o.apply(this, arguments); };
    window.__fits = 0;
    const v = window.map.getView(), of = v.fit.bind(v);
    v.fit = function () { window.__fits++; return of.apply(null, arguments); };
  });
  return { ctx, p };
}
async function still(p, ms) {
  await p.waitForTimeout(ms || 300);
  for (let i = 0; i < 40; i++) {
    const s = await p.evaluate(() => { const v = window.map.getView(); return { a: v.getAnimating(), c: v.getCenter().map(x => Math.round(x)) + '' }; });
    await p.waitForTimeout(150);
    const s2 = await p.evaluate(() => { const v = window.map.getView(); return { a: v.getAnimating(), c: v.getCenter().map(x => Math.round(x)) + '' }; });
    if (!s.a && !s2.a && s.c === s2.c) return;
  }
}
const view = p => p.evaluate(() => {
  const v = window.map.getView(), c = ol.proj.toLonLat(v.getCenter());
  const sz = window.map.getSize(), e = ol.proj.transformExtent(v.calculateExtent(sz), v.getProjection(), 'EPSG:4326');
  return { c, e, res: v.getResolution() };
});
// центр и границы видимой части карты (без открытой панели справа, иконбара и шкалы снизу)
const vis = (p, b) => p.evaluate(b => {
  const map = window.map, M = map.getTargetElement().getBoundingClientRect();
  let L = M.left, R = M.right, T = M.top, B = M.bottom;
  const sp = document.querySelector('#map-slide-panel.open'); if (sp) { const r = sp.getBoundingClientRect(); if (r.width > 0) R = Math.min(R, r.left); }
  const rp = document.getElementById('map-right-panel'); if (rp) { const r = rp.getBoundingClientRect(); if (r.width > 0 && r.left > M.left + M.width / 2) R = Math.min(R, r.left); }
  const tb = document.getElementById('year-timeline-bar'); if (tb) { const r = tb.getBoundingClientRect(); if (r.height > 0) B = Math.min(B, r.top); }
  const c = ol.proj.toLonLat(map.getCoordinateFromPixel([(L + R) / 2 - M.left, (T + B) / 2 - M.top]));
  let full = null;
  if (b) {
    const a = map.getPixelFromCoordinate(ol.proj.fromLonLat([b[0], b[1]])), z = map.getPixelFromCoordinate(ol.proj.fromLonLat([b[2], b[3]]));
    full = a[0] + M.left >= L - 1 && z[0] + M.left <= R + 1 && z[1] + M.top >= T - 1 && a[1] + M.top <= B + 1;
  }
  return { c, full, area: [L, T, R, B].map(Math.round) };
}, b || null);
const layerOn = (p, k) => p.evaluate(k => !!(window.AppState.externalLayerState || {})[k], k);
async function shot(p, name) { await p.screenshot({ path: path.join(SHOTS, name) }); }

async function openDzzItem(p, id) {
  await p.click('.mib-btn[data-tool="dzz"]');
  await p.waitForSelector('#dzz-tabs2 [data-tab-id="space"]', { timeout: 10000 });
  await p.click('#dzz-tabs2 [data-tab-id="space"]');
  await p.waitForTimeout(300);
  const item = p.locator('.dzz-sub-item', { hasText: id }).first();
  await item.locator('.dzz-sub-cb').check();
  return item;
}

// ── ДЗЗ: «Приблизить к слою» ────────────────────────────────────────────────
async function testDzzBeforeAfter() {
  const T = truthOf('4114861');
  { // v20.7 — без dzz-extent.js
    const { ctx, p } = await open('', { noFix: true });
    const it = await openDzzItem(p, '4114861');
    await it.locator('.dzz-sub-act-btn').first().click();
    await still(p, 700);
    const v = await vis(p, T);
    await shot(p, '01_v20.7_zoom_4114861_wrong.png');
    ok('v20.7 (без исправления) воспроизводит ошибку: 4114861 приближается не туда', !inside(v.c, T) && !v.full, 'центр видимой части ' + f3(v.c) + ', истинный охват ' + f3(T));
    await ctx.close();
  }
  { // v20.8
    const { ctx, p } = await open('');
    const it = await openDzzItem(p, '4114861');
    await it.locator('.dzz-sub-act-btn').first().click();
    await still(p, 900);
    const v = await vis(p, T), vv = await view(p);
    const hl = await p.evaluate(() => { const l = window.map.getLayers().getArray().find(x => x.get('name') === 'dzz-extent-highlight'); return l ? l.getSource().getFeatures().length : 0; });
    await shot(p, '02_v20.8_zoom_4114861_ok.png');
    ok('v20.8: «Приблизить к слою» 4114861 — центр видимой части карты в истинном контуре снимка', inside(v.c, T), 'центр ' + f3(v.c));
    ok('v20.8: снимок целиком в видимой части (не под панелью ДЗЗ)', v.full && contains(vv.e, T), 'видимая область ' + v.area.join(','));
    ok('v20.8: контур снимка подсвечен', hl > 0, 'объектов подсветки: ' + hl);
    const st = await p.evaluate(() => window.DzzExtent.status());
    ok('v20.8: охваты получены из GeoServer', st.capsOk || st.wfsResolved > 0, JSON.stringify(st));
    // «Скачать» не перехватывается
    const before = await view(p);
    await it.locator('.dzz-dl-btn').click();
    await p.waitForTimeout(500);
    const after = await view(p), dl = await p.evaluate(() => window.__dlClicked || null);
    ok('Кнопка «Скачать» работает как раньше (не перехватывается)', dl === 'bundle_ks_4114861' && Math.abs(after.res - before.res) < 1e-6, 'dl=' + dl);
    p._errs.length && ok('Без ошибок JS (ДЗЗ)', false, p._errs.join(' | '));
    await ctx.close();
  }
  // разметка кнопки зума у портала может быть другой
  for (const zm of ['datatip', 'tip', 'icon']) {
    const { ctx, p } = await open('?zoommark=' + zm);
    const it = await openDzzItem(p, '4114861');
    await it.locator('.dzz-sub-act-btn').first().click();
    await still(p, 900);
    const v = await vis(p, T);
    ok('Кнопка зума с разметкой «' + zm + '» перехватывается и приближает верно', inside(v.c, T) && v.full, 'центр ' + f3(v.c));
    await ctx.close();
  }
  // снимок без bbox в конфигурации (33 таких) — раньше WFS без СК
  {
    const { ctx, p } = await open('');
    const nob = await p.evaluate(() => { for (const t of window._dzzTabs) for (const y in t.yearFolders) for (const ld of t.yearFolders[y]) if (/^bundle_ks_/.test(ld.key) && !ld._bboxManual && !ld.bbox) return ld.label; return null; });
    if (nob) {
      const id = (nob.match(/\d{7}/) || [nob])[0], T2 = truthOf(id);
      const it = await openDzzItem(p, id);
      await it.locator('.dzz-sub-act-btn').first().click();
      await still(p, 900);
      const v = await vis(p, T2);
      ok('Снимок без bbox в конфигурации (' + id + ') — приближение по охвату GeoServer', inside(v.c, T2) && v.full, 'центр ' + f3(v.c) + ', охват ' + f3(T2));
    } else ok('Снимок без bbox в конфигурации — найден', false, 'bbox проставлены у всех (кэш?)');
    await ctx.close();
  }
}

async function testFallbacks() {
  const T = truthOf('4114861');
  const cases = [['caps=0&wfs=1', 'GetCapabilities недоступен → WFS-контур', true], ['caps=1&wfs=0', 'WFS недоступен → GetCapabilities', true], ['caps=0&wfs=0', 'GeoServer недоступен → ручной bbox с предупреждением', false]];
  for (const [q, name, expectTruth] of cases) {
    await mode(q);
    const { ctx, p } = await open('');
    const it = await openDzzItem(p, '4114861');
    await it.locator('.dzz-sub-act-btn').first().click();
    await still(p, 1500);
    const v = await vis(p, T), toasts = await p.evaluate(() => window.__toasts.map(t => t[0]).join(' | '));
    if (expectTruth) ok('Отказ: ' + name, inside(v.c, T) && v.full, 'центр ' + f3(v.c));
    else ok('Отказ: ' + name, /GeoServer не ответил/.test(toasts) && inside(v.c, [26.2, 52.8, 27.2, 54.5]), 'центр ' + f3(v.c) + '; тосты: ' + toasts.slice(0, 160));
    await ctx.close();
    await mode('caps=1&wfs=1');
  }
}

async function testSearch() {
  const T = truthOf('4114861');
  const { ctx, p } = await open('');
  let used = 'UI';
  const inp = await p.$('#lsp-search-input');
  let clicked = false;
  if (inp) {
    await inp.fill('4114861');
    await p.keyboard.press('Enter').catch(() => {});
    try {
      await p.waitForSelector('.lsr-item:has-text("4114861")', { timeout: 6000 });
      await p.click('.lsr-item:has-text("4114861")');
      clicked = true;
    } catch (_) {}
  }
  if (!clicked) {            // поисковый индекс строит unified-search.js (не входит в комплект) — проверяем обработчик
    used = 'API';
    await p.evaluate(() => {
      const ld = window.DzzExtent.findFolder('bundle_ks_4114861');
      window.DzzExtent.zoomToSearchItem({ type: 'dzz', dzzSubkeys: ld.subkeys, boundsKey: ld.boundsKey, bbox: ld._bboxManual || ld.bbox, dzzTabId: 'space' });
    });
  }
  await still(p, 900);
  const v = await vis(p, T);
  ok('Поиск: снимок 4114861 приближается в истинный охват (' + used + ')', inside(v.c, T) && v.full, 'центр ' + f3(v.c));
  await ctx.close();
}

// ── «Съёмка по годам» ───────────────────────────────────────────────────────
const RECT = (p, sels) => p.evaluate(sels => {
  const o = {};
  sels.forEach(s => {
    const e = document.querySelector(s);
    if (!e) return;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2 || r.height < 2) return;
    o[s] = [r.left, r.top, r.right, r.bottom];
  });
  return o;
}, sels);
const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
async function checkOverlap(p, tag) {
  const others = ['#custom-scale-bar', '#map-view3d-btn', '#map-geoloc-btn', '#map-fullscreen-btn', '#map-right-panel', '#coords-panel', '#selected-leshoz-bar', '#_global_toast', '.ol-attribution'];
  const r = await RECT(p, ['#year-timeline-bar'].concat(others));
  const bar = r['#year-timeline-bar'];
  if (!bar) { ok(tag + ': шкала показана', false); return; }
  const bad = others.filter(s => r[s] && inter(bar, r[s]) > 1).map(s => s + ' ' + f3(r[s]));
  const sc = r['#custom-scale-bar'];
  ok(tag + ': шкала не перекрывает кнопки, линейку и панели', !bad.length, bad.length ? 'перекрытия: ' + bad.join('; ') : 'шкала ' + f3(bar) + (sc ? ', линейка ' + f3(sc) : ''));
  const sc2 = r['#custom-scale-bar'], co = r['#coords-panel'];
  if (sc2 && co) ok(tag + ': линейка и панель «Координаты» не перекрываются', inter(sc2, co) < 1);
}
async function openTimeline(p) {
  await p.click('.mib-btn[data-tool="timeline"]');
  await p.waitForSelector('#year-timeline-bar .ytl-card', { timeout: 10000 });
  await p.waitForTimeout(500);
}
const cardOf = (p, id) => p.locator('#year-timeline-bar .ytl-card[data-id="' + id + '"]');

async function testTimeline() {
  const { ctx, p } = await open('');
  await openTimeline(p);
  await shot(p, '10_timeline_open_1600x900.png');
  await checkOverlap(p, '1600×900');
  const cnt = await p.evaluate(() => {
    const items = window.YearTimeline.items(), by = {};
    items.forEach(i => by[i.type] = (by[i.type] || 0) + 1);
    const chips = {};
    document.querySelectorAll('#year-timeline-bar .ytl-chip').forEach(c => chips[c.dataset.type] = +c.querySelector('.ytl-cnt').textContent);
    let cfg = 0;
    window._dzzTabs.forEach(t => Object.values(t.yearFolders).forEach(a => a.forEach(ld => { if (ld.key !== t.topKey) cfg++; })));
    return { n: items.length, by, chips, cfg };
  });
  ok('Шкала: все снимки из конфигурации ДЗЗ учтены', cnt.n === cnt.cfg && cnt.chips.all === cnt.n, JSON.stringify(cnt));
  ok('Шкала: счётчики по типам съёмки', cnt.chips.space === cnt.by.space && cnt.chips.base === cnt.by.base && cnt.chips.uav === 0 && cnt.chips.aerial === 0, JSON.stringify(cnt.chips));

  // год 2026 → май → снимок 4114861
  await p.click('#year-timeline-bar .ytl-year[data-year="2026"]');
  await p.click('#year-timeline-bar .ytl-m[data-month="5"]');
  await cardOf(p, 'bundle_ks_4114861').click();
  await still(p, 900);
  const T = truthOf('4114861');
  let v = await vis(p, T);
  const on1 = await layerOn(p, 'gs_ks_4114861_pan_cog');
  await shot(p, '11_timeline_select_4114861.png');
  ok('Шкала: щелчок по снимку показывает его на карте', on1);
  ok('Шкала: приближение к 4114861 — в истинный охват', inside(v.c, T) && v.full, 'центр ' + f3(v.c));
  const barR = (await RECT(p, ['#year-timeline-bar']))['#year-timeline-bar'];
  const tb = await p.evaluate(T => { const px = window.map.getPixelFromCoordinate(ol.proj.fromLonLat([T[0], T[1]])), px2 = window.map.getPixelFromCoordinate(ol.proj.fromLonLat([T[2], T[3]])); const r = window.map.getTargetElement().getBoundingClientRect(); return [r.left + px[0], r.top + px2[1], r.left + px2[0], r.top + px[1]]; }, T);
  ok('Шкала: снимок не спрятан под шкалой', tb[3] <= barR[1] + 2, 'низ снимка ' + Math.round(tb[3]) + ' / верх шкалы ' + Math.round(barR[1]));

  // шаг вперёд кнопкой и клавишей
  await p.click('#year-timeline-bar [data-act="next"]');
  await still(p, 700);
  let st = await p.evaluate(() => window.YearTimeline.state());
  const on2 = await layerOn(p, 'gs_ks_4114790_pan_cog').catch(() => false);
  const sk2 = await p.evaluate(() => { const it = window.YearTimeline.items().find(i => i.id === window.YearTimeline.state().sel); return it ? it.keys : []; });
  const on2b = await p.evaluate(ks => ks.some(k => window.AppState.externalLayerState[k]), sk2);
  ok('Шкала: «›» — следующий снимок по времени', st.sel !== 'bundle_ks_4114861' && on2b, 'выбран ' + st.sel);
  ok('Шкала: «Только выбранный» — предыдущий снимок скрыт', !(await layerOn(p, 'gs_ks_4114861_pan_cog')));
  await p.hover('#year-timeline-bar .ytl-title');
  await p.keyboard.press('ArrowRight');
  await still(p, 600);
  const st2 = await p.evaluate(() => window.YearTimeline.state());
  ok('Шкала: клавиша → листает снимки', st2.sel !== st.sel, st.sel + ' → ' + st2.sel);
  await p.keyboard.press('ArrowLeft');
  await still(p, 600);
  ok('Шкала: клавиша ← возвращает назад', (await p.evaluate(() => window.YearTimeline.state().sel)) === st.sel);

  // «Только выбранный» выкл → снимки накапливаются
  await p.click('#year-timeline-bar .ytl-switch');
  await cardOf(p, 'bundle_ks_4114861').click();
  await still(p, 600);
  const both = await p.evaluate(() => window.YearTimeline.items().filter(i => i.keys.some(k => window.AppState.externalLayerState[k])).length);
  ok('Шкала: без «Только выбранный» снимки добавляются к показанным', both >= 2, 'показано ' + both);
  const hideCnt = await p.evaluate(() => +document.querySelector('#year-timeline-bar [data-role="shown"]').textContent);
  ok('Шкала: счётчик «Скрыть показанные»', hideCnt === both, hideCnt + ' / ' + both);
  await p.click('#year-timeline-bar [data-act="hideall"]');
  await p.waitForTimeout(300);
  const none = await p.evaluate(() => window.YearTimeline.items().filter(i => i.keys.some(k => window.AppState.externalLayerState[k])).length);
  ok('Шкала: «Скрыть показанные» убирает снимки с карты', none === 0, 'осталось ' + none);
  await p.click('#year-timeline-bar .ytl-switch');      // обратно «Только выбранный»

  // день: все снимки за 2 мая
  await p.click('#year-timeline-bar .ytl-day[data-day="5-2"]');
  await still(p, 900);
  const day = await p.evaluate(() => window.YearTimeline.items().filter(i => i.year === 2026 && i.month === 5 && i.day === 2).map(i => [i.id, i.keys.some(k => window.AppState.externalLayerState[k])]));
  ok('Шкала: заголовок дня показывает все снимки дня', day.length >= 2 && day.every(d => d[1]), JSON.stringify(day));
  await shot(p, '12_timeline_day.png');

  // лесоустройство
  await p.click('#year-timeline-bar .ytl-chip[data-type="base"]');
  await p.click('#year-timeline-bar .ytl-year[data-year="2026"]');
  await p.waitForSelector('#year-timeline-bar .ytl-m[data-month="0"]');
  await p.click('#year-timeline-bar .ytl-m[data-month="0"]');
  await cardOf(p, 'bundle_disnenski_leshoz').click();
  await still(p, 900);
  v = await vis(p);
  const ldb = await p.evaluate(() => window.DzzExtent.findFolder('bundle_disnenski_leshoz'));
  const bb = ldb._bboxManual || ldb.bbox;
  ok('Шкала: лесоустройство — слой показан', await layerOn(p, 'gs_disnenski_leshoz_cog'));
  ok('Шкала: лесоустройство — приближение к лесхозу', inside(v.c, bb), 'центр ' + f3(v.c) + ', лесхоз ' + f3(bb));
  await shot(p, '13_timeline_forest_inventory.png');

  // 2024, «Весь год»
  await p.click('#year-timeline-bar .ytl-chip[data-type="all"]');
  await p.click('#year-timeline-bar .ytl-year[data-year="2024"]');
  await p.click('#year-timeline-bar .ytl-m[data-month="-1"]');
  const y24 = await p.evaluate(() => ({ cards: document.querySelectorAll('#year-timeline-bar .ytl-card').length, n: window.YearTimeline.items().filter(i => i.year === 2024).length,
    months: Array.from(document.querySelectorAll('#year-timeline-bar .ytl-m:not(.empty):not(.all)')).map(m => m.dataset.month).join(',') }));
  ok('Шкала: «Весь год» 2024 — все снимки года в ленте', y24.cards === y24.n && y24.n > 60, JSON.stringify(y24));
  await p.hover('#year-timeline-bar .ytl-ribbon');
  const sl0 = await p.evaluate(() => document.querySelector('#year-timeline-bar .ytl-ribbon').scrollLeft), r0 = (await view(p)).res;
  await p.mouse.wheel(0, 600);
  await p.waitForTimeout(500);
  const sl1 = await p.evaluate(() => document.querySelector('#year-timeline-bar .ytl-ribbon').scrollLeft), r1 = (await view(p)).res;
  ok('Шкала: колесо над лентой прокручивает её и не масштабирует карту', sl1 > sl0 && Math.abs(r1 - r0) < 1e-9, 'scrollLeft ' + sl0 + '→' + sl1);
  await shot(p, '14_timeline_2024_year.png');

  // уведомление и плашка лесхоза — над шкалой
  await p.evaluate(() => { window.showToast('Проверка уведомления'); const s = document.getElementById('selected-leshoz-bar'); if (s) s.style.display = 'flex'; });
  await p.waitForTimeout(400);
  await checkOverlap(p, 'Уведомление и плашка лесхоза');
  await p.evaluate(() => { const s = document.getElementById('selected-leshoz-bar'); if (s) s.style.display = 'none'; });

  // свернуть / развернуть
  await p.click('#year-timeline-bar [data-act="collapse"]');
  await p.waitForTimeout(400);
  const col = await RECT(p, ['#year-timeline-bar', '#custom-scale-bar']);
  const colH = col['#year-timeline-bar'][3] - col['#year-timeline-bar'][1];
  ok('Шкала: «Свернуть» оставляет одну строку, линейка опускается следом', colH < 60 && col['#custom-scale-bar'][3] <= col['#year-timeline-bar'][1] && col['#custom-scale-bar'][3] > col['#year-timeline-bar'][1] - 40, 'высота ' + Math.round(colH));
  await shot(p, '15_timeline_collapsed.png');
  await p.click('#year-timeline-bar [data-act="collapse"]');

  // состояние сохраняется
  await p.click('#year-timeline-bar .ytl-chip[data-type="space"]');
  await p.click('#year-timeline-bar .ytl-year[data-year="2025"]');
  const saved = await p.evaluate(() => window.YearTimeline.state());

  // закрыть ×
  await p.click('#year-timeline-bar [data-act="close"]');
  await p.waitForTimeout(500);
  const cl = await p.evaluate(() => ({ bar: !!document.getElementById('year-timeline-bar'), ta: document.body.classList.contains('timeline-active'), fs: getComputedStyle(document.getElementById('map-fullscreen-btn') || document.body).display, csb: (() => { const r = document.getElementById('custom-scale-bar').getBoundingClientRect(); return innerHeight - r.bottom; })() }));
  ok('Шкала: «×» закрывает и возвращает линейку и кнопки', !cl.bar && !cl.ta && cl.fs !== 'none' && cl.csb < 40, JSON.stringify(cl));
  p._errs.length && ok('Без ошибок JS (шкала)', false, p._errs.join(' | '));
  await ctx.close();

  // повторное открытие — тот же тип и год
  const r2 = await open('', { keepState: true, ls: { ytl208_state: JSON.stringify(saved) } });
  await openTimeline(r2.p);
  const st3 = await r2.p.evaluate(() => window.YearTimeline.state());
  ok('Шкала: тип съёмки, год и месяц сохраняются', st3.type === 'space' && st3.year === 2025 && st3.month === saved.month, JSON.stringify(st3));
  // переключение на другую панель закрывает шкалу корректно
  await r2.p.click('.mib-btn[data-tool="dzz"]');
  await r2.p.waitForTimeout(600);
  const sw = await r2.p.evaluate(() => ({ bar: !!document.getElementById('year-timeline-bar'), ta: document.body.classList.contains('timeline-active'), dzz: !!document.querySelector('#dzz-panel') }));
  ok('Шкала: при открытии панели ДЗЗ шкала закрывается без «хвостов»', !sw.bar && !sw.ta && sw.dzz, JSON.stringify(sw));
  await r2.ctx.close();
}

// ── v20.10: снимок из «Съёмки по годам» действительно запрашивается у GeoServer (LAYERS + _target) ──
async function tileStats(p, layer) {
  return p.evaluate(l => {
    const lay = window.map.getLayers().getArray().find(x => x.getSource && x.getSource() && x.getSource().getParams && x.getSource().getParams().LAYERS === l);
    if (!lay) return null;
    const s = lay.getSource();
    if (!s.__cnt) { s.__cnt = { ok: 0, err: 0 }; s.on('tileloadend', () => s.__cnt.ok++); s.on('tileloaderror', () => s.__cnt.err++); }
    return Object.assign({ target: s.getParams()._target }, s.__cnt);
  }, layer);
}
async function testTimelineTiles() {
  const { ctx, p } = await open('');
  await fetch(BASE + '/__tiles?clear=1');
  await openTimeline(p);
  await p.click('#year-timeline-bar .ytl-chip[data-type="base"]');
  await p.click('#year-timeline-bar .ytl-year[data-year="2025"]');
  await p.waitForSelector('#year-timeline-bar .ytl-m[data-month="0"]');
  await p.click('#year-timeline-bar .ytl-m[data-month="0"]');
  await cardOf(p, 'bundle_np_pripyat').click();
  await still(p, 1500);
  const LN = await p.evaluate(() => window._getExtDef('gs_np_pripyat_cog').sublabel);
  let t = await (await fetch(BASE + '/__tiles?clear=1')).json();
  const empty = t.filter(x => !x.layers).length, np = t.filter(x => x.layers === LN), npOk = np.filter(x => x.target === 'GEOSERVER_EXT').length;
  ok('v20.10 Шкала: тайлы снимка ЛУ запрашиваются с LAYERS=' + LN + ' и _target=GEOSERVER_EXT', np.length > 0 && npOk === np.length, 'запросов ' + np.length + ', с верным _target ' + npOk);
  ok('v20.10 Шкала: нет запросов GetMap без LAYERS', empty === 0, 'без LAYERS: ' + empty + ' из ' + t.length);
  await tileStats(p, LN);
  await p.evaluate(() => { const v = window.map.getView(); v.setZoom(v.getZoom() + 2.5); });
  await still(p, 2500);
  const st = await tileStats(p, LN);
  t = await (await fetch(BASE + '/__tiles?clear=1')).json();
  ok('v20.10 Шкала: при приближении снимок догружается без ошибок', st && st.ok > 0 && st.err === 0 && t.filter(x => x.layers === LN).length > 0, JSON.stringify(st) + ', новых запросов ' + t.filter(x => x.layers === LN).length);
  await shot(p, '30_v2010_timeline_tiles_zoom.png');
  // поиск ДЗЗ и прочий код, вызывающий toggleExternalLayer(ключ, null, …)
  await p.evaluate(() => window.toggleExternalLayer('gs_borisov_leshoz_cog', null, true));
  await p.waitForTimeout(900);
  const bl = await p.evaluate(() => { const l = window.map.getLayers().getArray().find(x => x.getSource && x.getSource() && x.getSource().getParams && /borisov/i.test(String(x.getSource().getParams().LAYERS))); return l ? l.getSource().getParams() : null; });
  const bdef = await p.evaluate(() => window._getExtDef('gs_borisov_leshoz_cog').sublabel);
  ok('v20.10 toggleExternalLayer(ключ, null) подставляет имя слоя из EXTERNAL_LAYER_DEFS', bl && bl.LAYERS === bdef && bl._target === (bdef.startsWith('External:') ? 'GEOSERVER_EXT' : 'GEOSERVER'), JSON.stringify(bl && { LAYERS: bl.LAYERS, _target: bl._target }));
  p._errs.length && ok('Без ошибок JS (v20.10 тайлы)', false, p._errs.join(' | '));
  await ctx.close();
}
// ── v20.10: шкала крупнее, «A− 130% A+», размер запоминается ──
async function testTimelineSize() {
  let { ctx, p } = await open('');
  await openTimeline(p);
  const fs0 = await p.evaluate(() => ({ s: window.YearTimeline.state().size, f: getComputedStyle(document.getElementById('year-timeline-bar')).fontSize, c: getComputedStyle(document.querySelector('#year-timeline-bar .ytl-card b')).fontSize }));
  ok('v20.10 Размер шкалы по умолчанию 130 % (шрифт 15.6px вместо 12px)', fs0.s === 1.3 && fs0.f === '15.6px' && fs0.c === '15.6px', JSON.stringify(fs0));
  await shot(p, '31_v2010_size_130.png');
  await p.click('#year-timeline-bar [data-act="szup"]');
  await p.waitForTimeout(400);
  const fs1 = await p.evaluate(() => ({ s: window.YearTimeline.state().size, f: getComputedStyle(document.getElementById('year-timeline-bar')).fontSize }));
  ok('v20.10 «A+» — крупнее (150 %)', fs1.s === 1.5 && fs1.f === '18px', JSON.stringify(fs1));
  await checkOverlap(p, '150 %');
  await shot(p, '32_v2010_size_150.png');
  await ctx.close();
  ({ ctx, p } = await open('', { keepState: true, ls: { ytl208_state: JSON.stringify({ size: 1.5 }) } }));
  await openTimeline(p);
  const fs2 = await p.evaluate(() => window.YearTimeline.state().size);
  ok('v20.10 Размер шкалы сохраняется между сеансами', fs2 === 1.5, 'size=' + fs2);
  for (let i = 0; i < 4; i++) { const b = await p.$('#year-timeline-bar [data-act="szdn"]:not([disabled])'); if (b) { await b.click(); await p.waitForTimeout(200); } }
  const fs3 = await p.evaluate(() => ({ s: window.YearTimeline.state().size, f: getComputedStyle(document.getElementById('year-timeline-bar')).fontSize, dn: document.querySelector('#year-timeline-bar [data-act="szdn"]').disabled }));
  ok('v20.10 «A−» до 100 % — прежний размер, кнопка блокируется', fs3.s === 1 && fs3.f === '12px' && fs3.dn, JSON.stringify(fs3));
  await ctx.close();
  // невысокое окно: масштаб уменьшается сам, шкала ≤ 45 % высоты
  ({ ctx, p } = await open('', { w: 1280, h: 600, keepState: true, ls: { ytl208_state: JSON.stringify({ size: 1.75 }) } }));
  await openTimeline(p);
  const lo = await p.evaluate(() => { const b = document.getElementById('year-timeline-bar'); return { st: window.YearTimeline.state(), h: b.offsetHeight, H: window.map.getTargetElement().getBoundingClientRect().height }; });
  ok('v20.10 Невысокое окно (1280×600, выбран 175 %): масштаб уменьшен, шкала ≤ 45 % высоты', lo.st.size === 1.75 && lo.st.eff < 1.75 && lo.h <= lo.H * 0.45 + 1, JSON.stringify(lo));
  await shot(p, '33_v2010_size_lowwindow.png');
  p._errs.length && ok('Без ошибок JS (v20.10 размер)', false, p._errs.join(' | '));
  await ctx.close();
}
async function testTimelineTypes() {
  const { ctx, p } = await open('?demo=uav');
  await openTimeline(p);
  const chips = await p.evaluate(() => { const o = {}; document.querySelectorAll('#year-timeline-bar .ytl-chip').forEach(c => o[c.dataset.type] = [+c.querySelector('.ytl-cnt').textContent, c.disabled]); return o; });
  ok('Типы съёмки: БЛА и Аэрофото из panel-dzz.js (_dzzAllTabs)', chips.uav[0] === 1 && !chips.uav[1] && chips.aerial[0] === 1 && !chips.aerial[1], JSON.stringify(chips));
  await p.click('#year-timeline-bar .ytl-chip[data-type="uav"]');
  await p.waitForTimeout(300);
  const st = await p.evaluate(() => ({ st: window.YearTimeline.state(), cards: Array.from(document.querySelectorAll('#year-timeline-bar .ytl-card')).map(c => c.dataset.id) }));
  ok('Типы съёмки: фильтр «БЛА» — год 2025, июнь, один снимок', st.st.year === 2025 && st.st.month === 6 && st.cards.length === 1 && st.cards[0] === 'bundle_demo_uav_logoisk', JSON.stringify(st));
  await cardOf(p, 'bundle_demo_uav_logoisk').click();
  await still(p, 900);
  const v = await vis(p);
  ok('Типы съёмки: снимок БЛА показан и приближен', (await layerOn(p, 'gs_logoisk_leshoz_cog')) && inside(v.c, [27.3, 53.8, 28.4, 54.8]), 'центр ' + f3(v.c));
  await shot(p, '16_timeline_uav.png');
  await ctx.close();
}

async function testNarrow() {
  for (const [w, h] of [[1280, 720], [1024, 700], [760, 900], [390, 844]]) {
    const { ctx, p } = await open('', { w, h });
    const btn = await p.$('.mib-btn[data-tool="timeline"]');
    const vis = btn && await btn.isVisible();
    if (!vis) { ok(w + '×' + h + ': кнопка «Съёмка по годам» доступна', false, 'кнопка скрыта раскладкой'); await ctx.close(); continue; }
    await openTimeline(p);
    await p.waitForTimeout(500);
    await shot(p, '20_timeline_' + w + 'x' + h + '.png');
    await checkOverlap(p, w + '×' + h);
    const fit = await p.evaluate(() => { const r = document.getElementById('year-timeline-bar').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, h: r.height }; });
    ok(w + '×' + h + ': шкала в пределах экрана', fit.l >= 0 && fit.r <= fit.w + 0.5 && fit.h < h * 0.5, JSON.stringify(fit));
    await ctx.close();
  }
}

(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  TRUTH = await (await fetch(BASE + '/__truth')).json();
  await mode('caps=1&wfs=1&delay=0');
  const t0 = Date.now();
  for (const fn of [testDzzBeforeAfter, testFallbacks, testSearch, testTimeline, testTimelineTiles, testTimelineSize, testTimelineTypes, testNarrow]) {
    try { await fn(); } catch (e) { ok(fn.name + ': без исключений', false, String(e && e.stack || e).slice(0, 400)); }
  }
  await mode('caps=1&wfs=1&delay=0');
  await browser.close();
  const pass = results.filter(r => r.pass).length;
  const rep = { version: TAG.replace(/^v/, ''), date: new Date().toISOString(), base: BASE, total: results.length, pass, fail: results.length - pass, seconds: Math.round((Date.now() - t0) / 1000), results };
  fs.writeFileSync(path.join(ROOT, 'reports', TAG + '_ui_report.json'), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(ROOT, 'reports', TAG + '_ui_report.md'),
    '# ' + TAG + ' — UI-тесты ДЗЗ и «Съёмки по годам»\n\nИтог: **' + pass + ' из ' + results.length + '** (' + rep.seconds + ' с)\n\n| | Проверка | Подробности |\n|---|---|---|\n' +
    results.map(r => '| ' + (r.pass ? '✅' : '❌') + ' | ' + r.name + ' | ' + String(r.info).replace(/\|/g, '/').slice(0, 220) + ' |').join('\n') + '\n');
  console.log('\nИТОГ: ' + pass + ' / ' + results.length);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
