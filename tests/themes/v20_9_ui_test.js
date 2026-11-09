// v20.9 — UI-тест на стенде (настоящий app.py): «Один аватар на всех страницах» и «Оформление» (10 тем + «Как сейчас»).
// Запуск (из папки, где установлен playwright):
//   CHROME=$(which chromium) BASE=http://127.0.0.1:8810 node tests/themes/v20_9_ui_test.js
// Что нужно стенду: пользователи по IP (X-Real-IP) — ME_IP (.51) с профилем в «Сообщениях» (лучше с фото, рамкой и эмодзи
// статуса — ожидаемые значения тест берёт из /api/profile/me); GUEST_IP (.97) — без профиля.
// Результат: reports/v20.9_ui_report.json, снимки reports/v20.9_shots/*.jpg; код выхода 0 — все проверки пройдены.
// ВНИМАНИЕ: тест меняет рамку профиля ME_IP и возвращает прежнюю — запускайте только на стенде.
const { launch, ctx, open, BASE } = require('./pw_stand.js');
const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'reports');
const SHOTS = path.join(OUT, 'v20.9_shots'); fs.mkdirSync(SHOTS, { recursive: true });
const IDS = (process.env.THEMES || 'classic,bor,graphite,white,navy,gis,contrast,field,swiss,taiga,gov').split(',');
const ME = process.env.ME_IP || '192.168.12.51', GUEST = process.env.GUEST_IP || '192.168.12.97';
let FRAME0 = 'birch', FRAME1 = 'oak';
const PARTS = (process.env.PARTS || '1,2,3,4').split(',');   // можно запустить часть: PARTS=2,4
// Шум стенда (нет style.css/v15, CDN офлайн) — не ошибки v20.9
const NOISE = /net-status\.js|scene-season\.js|design-system-v15\.js|brand-logo\.js|future-icons\.js|404|MIME type \('application\/json'\)|integrity|Failed to load resource/;
const checks = [];
function ok(group, name, cond, info) {
  checks.push({ group, name, ok: !!cond, info: info === undefined ? null : info });
  console.log((cond ? '  ✓ ' : '  ✗ ') + group + ' · ' + name + (info !== undefined && info !== null && info !== '' ? ' — ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 300) : ''));
}
const errs = p => p._errs.filter(e => !NOISE.test(e));
const shot = (p, name, o) => p.screenshot(Object.assign({ path: path.join(SHOTS, name + '.jpg'), type: 'jpeg', quality: 80 }, o || {}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, step = 150) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(step); } return v; }
function watchAssets(c, bad) {
  c.on('response', r => { const u = r.url(); if (/\/static\/(themes\/|avatar-sync\.)/.test(u) && r.status() >= 400) bad.push(r.status() + ' ' + u.replace(BASE, '')); });
}
async function audit(p, root) {
  return p.evaluate(sel => {
    const g = window.GeoTheme; if (!g) return { err: 'нет GeoTheme' };
    const r = sel ? document.querySelector(sel) : null;
    if (sel && !r) return { err: 'нет ' + sel };
    const a = g.audit(r ? { fix: false, root: r } : { fix: false });
    return { checked: a.checked, n: a.fails.length, fails: a.fails.slice(0, 6) };
  }, root || null);
}
const avState = p => p.evaluate(() => {
  const el = [...document.querySelectorAll('[data-me-avatar]')].find(e => e.offsetParent !== null) || document.querySelector('[data-me-avatar]');
  if (!el) return null;
  const im = el.querySelector('img.gav-img'), em = el.querySelector('.gav-emo');
  return { cls: el.className, frame: (el.className.match(/gav-fr-([a-z]+)/) || [])[1] || null, photo: !!(im && im.complete && im.naturalWidth > 0),
           emoji: em ? em.textContent : '', letter: (el.querySelector('.gav-l') || {}).textContent || '', ver: el.getAttribute('data-gav-ver') };
});

(async () => {
  const b = await launch();
  const table = {};
  const assets = [];
  console.log('Стенд: ' + BASE);
  if (PARTS.includes('1')) {
    console.log('\n1) Аватар');
    const c = await ctx(b, { ip: ME }); watchAssets(c, assets);
    await c.addInitScript(() => { try { localStorage.removeItem('gt_theme'); } catch (e) {} });
    const A = await open(c, '/', 4200);
    const me = await A.evaluate(() => fetch('/api/profile/me', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null));
    const pf = (me && me.profile) || {}, PHOTO = !!(me && (me.photo_url || me.photo_src)), EMO = pf.status_emoji || '';
    FRAME0 = pf.frame || 'none'; FRAME1 = FRAME0 === 'oak' ? 'pine' : 'oak';
    ok('Аватар', 'профиль ' + ME + ' в «Сообщениях» есть (/api/profile/me)', !!(me && me.ok), me ? { frame: FRAME0, emoji: EMO, photo: PHOTO } : 'нет ответа');
    let s = await avState(A);
    ok('Аватар', 'главная: ' + (PHOTO ? 'фото профиля' : 'буква') + ' — как в «Сообщениях»', s && s.photo === PHOTO, s);
    ok('Аватар', 'главная: рамка ' + FRAME0, s && (s.frame || 'none') === FRAME0, s && s.frame);
    ok('Аватар', 'главная: эмодзи статуса ' + (EMO || '(нет)'), s && s.emoji === EMO, s && s.emoji);
    const box = await A.evaluate(() => { const el = [...document.querySelectorAll('[data-me-avatar]')].find(e => e.offsetParent !== null); if (!el) return null; const r = (el.closest('.sf-user-row,[class*="user"]') || el).getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: Math.min(360, r.width + 24), height: r.height + 24 }; });
    if (box) await shot(A, 'av_main_' + FRAME0, { clip: box });
    const B = await open(c, '/messages?openProfile=1&tab=frame', 4200);
    const hasFrames = await until(() => B.$('.pv-frame-opt[data-frame="' + FRAME1 + '"]'), 5000);
    ok('Аватар', '/messages?openProfile=1&tab=frame открывает выбор рамки', !!hasFrames);
    async function setFrame(fr) {
      await B.click('.pv-frame-opt[data-frame="' + fr + '"]');
      const [resp] = await Promise.all([B.waitForResponse(r => /\/api\/profile\/save/.test(r.url()), { timeout: 15000 }).catch(() => null), B.click('#pv-save')]);
      return resp ? resp.status() : 0;
    }
    if (hasFrames) {
      const st = await setFrame(FRAME1);
      ok('Аватар', 'сохранение рамки ' + FRAME1 + ' (/api/profile/save)', st === 200, 'HTTP ' + st);
      const got = await until(async () => { const v = await avState(A); return v && v.frame === FRAME1 ? v : null; }, 5000);
      ok('Аватар', 'вторая вкладка (главная) получила рамку ' + FRAME1 + ' без перезагрузки', !!got, got || (await avState(A)));
      if (box) await shot(A, 'av_main_' + FRAME1, { clip: box });
      await B.evaluate(() => { if (typeof openProfileModal === 'function') openProfileModal('frame'); });
      await until(() => B.$('.pv-frame-opt[data-frame="' + FRAME0 + '"]:not([disabled])'), 4000);
      await sleep(400);
      const st2 = await setFrame(FRAME0);
      const back = await until(async () => { const v = await avState(A); return v && (v.frame || 'none') === FRAME0 ? v : null; }, 5000);
      ok('Аватар', 'рамка возвращена ' + FRAME0 + ' (и на главной)', st2 === 200 && !!back, 'HTTP ' + st2);
    }
    const A2 = await open(c, '/', 3500);
    s = await avState(A2);
    ok('Аватар', 'после перезагрузки главной — тот же аватар, рамка ' + FRAME0, s && s.photo === PHOTO && (s.frame || 'none') === FRAME0, s && s.frame);
    ok('Аватар', 'ошибок JS нет (' + ME + ')', !errs(A).length && !errs(B).length && !errs(A2).length, [...errs(A), ...errs(B), ...errs(A2)].slice(0, 4));
    await c.close();
    const g = await ctx(b, { ip: GUEST }); watchAssets(g, assets);
    const G1 = await open(g, '/', 3800), G2 = await open(g, '/messages', 3800);
    const gs = await avState(G1);
    ok('Аватар', 'гость без профиля (' + GUEST + '): главная и «Сообщения» без ошибок JS', !errs(G1).length && !errs(G2).length, [...errs(G1), ...errs(G2)].slice(0, 4));
    ok('Аватар', 'гость: буква вместо фото, без рамки', !gs || (!gs.photo && !gs.frame), gs);
    await g.close();
  }

  if (PARTS.includes('2')) console.log('\n2) Темы: главная, меню профиля, кнопки и панель карты, «Сообщения», окно заявления');
  for (const id of PARTS.includes('2') ? IDS : []) {
    const row = table[id] = {};
    // ДО: «Страж контраста» выключен — что даёт сама тема
    let c = await ctx(b, { ip: ME }); watchAssets(c, assets);
    await c.addInitScript(() => { try { localStorage.setItem('gt_guard', '0'); } catch (e) {} });
    let p = await open(c, '/?gt=' + id, 4200);
    row.main_before = (await audit(p)).n;
    let q = await open(c, '/messages?gt=' + id, 4200);
    row.msg_before = (await audit(q)).n;
    await c.close();
    // ПОСЛЕ: страж включён (по умолчанию)
    c = await ctx(b, { ip: ME }); watchAssets(c, assets);
    p = await open(c, '/?gt=' + id, 4800);
    const st = await p.evaluate(() => ({ gt: document.documentElement.getAttribute('data-gt'), css: (document.getElementById('gt-theme-css') || {}).href || '', api: !!window.GeoTheme, cur: window.GeoTheme && window.GeoTheme.get(), ls: localStorage.getItem('gt_theme'), font: getComputedStyle(document.body).fontFamily }));
    ok('Темы', id + ': применена (data-gt, стили, GeoTheme.get)', st.api && (id === 'classic' ? !st.gt && !st.css : st.gt === id && st.css.indexOf('gt-' + id + '.css') >= 0) && (st.cur === id || (id === 'classic' && (st.cur === 'classic' || st.cur === ''))), st);
    const a1 = await audit(p); row.main_after = a1.n; row.main_checked = a1.checked;
    // меню профиля: наведение на пункты
    await p.click('[data-sf-profile-trigger]'); await sleep(350);
    const items = await p.$$('#sf-profile-menu .sf-profile-menu-item');
    let hv = 0, hvN = 0, hvBad = [];
    for (const it of items.slice(0, 9)) {
      await it.hover(); await sleep(520); hvN++;
      const r = await it.evaluate(e => { const a = window.GeoTheme.audit({ fix: false, root: e }); return { t: (e.textContent || '').trim().slice(0, 30), n: a.fails.length, w: a.fails[0] || null }; });
      if (r.n) { hv++; hvBad.push(r); }
    }
    row.menu_hover = hv + '/' + hvN;
    const third = items[2]; if (third) { await third.hover(); await sleep(500); }
    await shot(p, id + '_main');
    await p.click('[data-sf-profile-trigger]'); await sleep(250);
    // кнопки карты: наведение (подсказка .mib-tip)
    const btns = await p.$$('#map-icon-bar .mib-btn');
    let mb = 0, mbN = 0;
    for (const bt of btns.slice(0, 6)) {
      if (!(await bt.isVisible())) continue;
      await bt.hover(); await sleep(450); mbN++;
      const r = await bt.evaluate(e => window.GeoTheme.audit({ fix: false, root: e }).fails.length);
      if (r) mb++;
    }
    row.mib_hover = mb + '/' + mbN;
    // панель «Подложка карты»
    const pb = await p.$('.mib-btn[data-tool="basemaps"]');
    if (pb) { await pb.click(); await sleep(1400); }
    const ap = await audit(p, '#map-slide-panel'); row.panel_after = ap.err ? ap.err : ap.n;
    await p.mouse.move(800, 450); await sleep(300);
    await shot(p, id + '_panel');
    const pe = errs(p);
    // «Сообщения»
    q = await open(c, '/messages?gt=' + id, 4800);
    const a2 = await audit(q); row.msg_after = a2.n; row.msg_checked = a2.checked;
    await shot(q, id + '_msg');
    let th = 0, thN = 0;
    if (await q.$('.topbar-user')) {
      await q.click('.topbar-user'); await sleep(350);
      for (const it of (await q.$$('.topbar-profile-menu .tpm-item')).slice(0, 8)) {
        if (!(await it.isVisible())) continue;
        await it.hover(); await sleep(480); thN++;
        if (await it.evaluate(e => window.GeoTheme.audit({ fix: false, root: e }).fails.length)) th++;
      }
      await q.keyboard.press('Escape'); await q.evaluate(() => { if (typeof closeProfileMenu === 'function') closeProfileMenu(); });
    }
    row.msg_menu_hover = th + '/' + thN;
    const vf = await q.evaluate(() => { try { if (typeof openVacancyForm !== 'function') return 'нет openVacancyForm'; openVacancyForm(); return 'ok'; } catch (e) { return 'ошибка: ' + e.message; } });
    if (vf === 'ok') { await sleep(1300); const av = await audit(q, '#vf-modal-overlay'); row.vacancy_after = av.err ? av.err : av.n; if (id === 'classic' || id === 'navy' || id === 'white') await shot(q, id + '_vacancy'); await q.evaluate(() => closeVacancyForm()); }
    else row.vacancy_after = vf;
    const qe = errs(q);
    row.errors = pe.length + qe.length;
    ok('Темы', id + ': ошибок JS нет', !row.errors, [...pe, ...qe].slice(0, 4));
    ok('Темы', id + ': контраст после стража — главная, «Сообщения», панель = 0', row.main_after === 0 && row.msg_after === 0 && row.panel_after === 0, { main: row.main_after, msg: row.msg_after, panel: row.panel_after, fails: a1.fails.concat(a2.fails).slice(0, 3) });
    ok('Темы', id + ': наведение — меню профиля, кнопки карты, меню «Сообщений» без проблем', hv === 0 && mb === 0 && th === 0, { menu: row.menu_hover, mib: row.mib_hover, msg: row.msg_menu_hover, bad: hvBad.slice(0, 2) });
    ok('Темы', id + ': окно «Заявление за свой счёт» читается', row.vacancy_after === 0, row.vacancy_after);
    await c.close();
    console.log('    ' + id.padEnd(9) + JSON.stringify(row));
  }

  if (PARTS.includes('3')) {
    console.log('\n3) Сохранение, синхронизация вкладок, ?gt=');
    const c = await ctx(b, { ip: ME }); watchAssets(c, assets);
    const A = await open(c, '/?gt=classic', 3800), B = await open(c, '/', 3800), M = await open(c, '/messages', 3800);
    const dg = pg => pg.evaluate(() => ({ gt: document.documentElement.getAttribute('data-gt'), css: (document.getElementById('gt-theme-css') || {}).href || '' }));
    ok('Синхр.', '?gt=classic: тема снята и запомнена «classic»', !(await dg(A)).gt && (await A.evaluate(() => localStorage.getItem('gt_theme'))) === 'classic');
    await A.evaluate(() => GeoTheme.set('navy'));
    const b1 = await until(async () => { const v = await dg(B); return v.gt === 'navy' && v.css.indexOf('gt-navy.css') >= 0 ? v : null; }, 3000);
    const m1 = await until(async () => { const v = await dg(M); return v.gt === 'navy' ? v : null; }, 3000);
    ok('Синхр.', 'GeoTheme.set("navy") во вкладке A → вкладки B (главная) и C («Сообщения») без перезагрузки', !!b1 && !!m1, { B: b1 || (await dg(B)), C: m1 || (await dg(M)) });
    await B.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
    ok('Синхр.', 'после перезагрузки тема сохраняется (localStorage gt_theme)', (await dg(B)).gt === 'navy');
    await M.evaluate(() => GeoTheme.set('classic'));
    const a2 = await until(async () => { const v = await dg(A); return !v.gt ? v : null; }, 3000);
    ok('Синхр.', '«Как сейчас» из «Сообщений» → главная вернулась к прежнему виду', !!a2 && !(await dg(B)).gt);
    await A.evaluate(() => GeoTheme.guard.enable(false));
    const gOff = await until(() => B.evaluate(() => !GeoTheme.guard.isOn()), 3000);
    await A.evaluate(() => GeoTheme.guard.enable(true));
    const gOn = await until(() => B.evaluate(() => GeoTheme.guard.isOn()), 3000);
    ok('Синхр.', 'переключатель «Страж контраста» синхронизируется между вкладками', !!gOff && !!gOn);
    ok('Синхр.', 'ошибок JS нет', !errs(A).length && !errs(B).length && !errs(M).length, [...errs(A), ...errs(B), ...errs(M)].slice(0, 4));
    await c.close();
  }

  if (PARTS.includes('4')) {
    console.log('\n4) Окно «Оформление»');
    const c = await ctx(b, { ip: ME }); watchAssets(c, assets);
    const p = await open(c, '/?gt=classic', 4200);
    const vis = () => p.evaluate(() => { const o = document.querySelector('.gt-ov'); if (!o || o.hidden) return false; const r = o.getBoundingClientRect(); return getComputedStyle(o).display !== 'none' && r.width > 0 && r.height > 0; });
    await p.click('[data-sf-profile-trigger]'); await sleep(300);
    const item = await p.$('#sf-profile-menu [data-gt-open]');
    ok('Окно', 'в меню профиля есть пункт «Оформление»', !!item && /Оформление/.test(await item.textContent()));
    if (item) await item.click(); await sleep(700);
    const w1 = await p.evaluate(() => ({ cards: document.querySelectorAll('.gt-ov .gt-card').length, pressed: (document.querySelector('.gt-ov .gt-card[aria-pressed="true"]') || {}).getAttribute && document.querySelector('.gt-ov .gt-card[aria-pressed="true"]').getAttribute('data-gt-id'), menuHidden: !document.getElementById('sf-profile-menu') || document.getElementById('sf-profile-menu').hidden, focus: document.activeElement && document.activeElement.className }));
    ok('Окно', 'открывается из меню, меню закрывается, 11 карточек, выбрана «Как сейчас», фокус на карточке', (await vis()) && w1.cards === 11 && w1.pressed === 'classic' && w1.menuHidden && /gt-card/.test(w1.focus), w1);
    await shot(p, 'window_classic');
    await p.click('.gt-ov .gt-card[data-gt-id="field"]'); await sleep(900);
    const w2 = await p.evaluate(() => ({ gt: document.documentElement.getAttribute('data-gt'), pressed: document.querySelector('.gt-ov .gt-card[aria-pressed="true"]').getAttribute('data-gt-id'), ls: localStorage.getItem('gt_theme') }));
    ok('Окно', 'клик по карточке «Полевая» применяет и запоминает тему', w2.gt === 'field' && w2.pressed === 'field' && w2.ls === 'field', w2);
    await shot(p, 'window_field');
    await p.keyboard.press('Escape'); await sleep(300);
    ok('Окно', 'Escape закрывает окно', !(await vis()));
    await p.keyboard.press('Alt+Shift+KeyT'); await sleep(500);
    const o1 = await vis();
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter'); await sleep(700);
    const kb = await p.evaluate(() => document.documentElement.getAttribute('data-gt'));
    await p.keyboard.press('Alt+Shift+KeyT'); await sleep(400);
    ok('Окно', 'Alt+Shift+T открывает/закрывает; стрелки и Enter выбирают карточку', o1 && !(await vis()) && kb && kb !== 'field', { open: o1, keyboardTheme: kb });
    await p.evaluate(() => GeoTheme.open()); await sleep(400);
    await p.click('#gt-guard-sw'); await sleep(200);
    const g0 = await p.evaluate(() => ({ on: GeoTheme.guard.isOn(), ls: localStorage.getItem('gt_guard') }));
    await p.click('#gt-guard-sw'); await sleep(200);
    const g1 = await p.evaluate(() => GeoTheme.guard.isOn());
    ok('Окно', 'переключатель «Страж контраста» выключает/включает стража', !g0.on && g0.ls === '0' && g1, g0);
    await p.click('.gt-ov [data-gt-close].gt-ok'); await sleep(300);
    ok('Окно', 'кнопка «Готово» закрывает', !(await vis()));
    const m = await open(c, '/messages?gt=white', 4200);
    await m.click('.topbar-user'); await sleep(350);
    const tpm = await m.$('.topbar-profile-menu .tpm-item:has-text("Оформление")');
    ok('Окно', '«Сообщения»: пункт «Оформление» в меню профиля', !!tpm);
    if (tpm) { await tpm.click(); await sleep(800); }
    const mv = await m.evaluate(() => { const o = document.querySelector('.gt-ov'); return !!o && !o.hidden; });
    ok('Окно', '«Сообщения»: окно открывается', mv);
    await shot(m, 'window_msg_white');
    ok('Окно', 'ошибок JS нет', !errs(p).length && !errs(m).length, [...errs(p), ...errs(m)].slice(0, 4));
    await c.close();
  }
  ok('Файлы', 'стили, шрифты и скрипты тем и аватара отдаются без ошибок (HTTP < 400)', !assets.length, [...new Set(assets)].slice(0, 6));

  const fail = checks.filter(x => !x.ok);
  const rep = { version: '20.9', base: BASE, date: new Date().toISOString(), total: checks.length, passed: checks.length - fail.length, failed: fail.length, themes: table, checks };
  fs.writeFileSync(path.join(OUT, 'v20.9_ui_report.json'), JSON.stringify(rep, null, 1));
  console.log('\nИтог: ' + rep.passed + '/' + rep.total + ' проверок' + (fail.length ? ' — НЕ ПРОЙДЕНО: ' + fail.map(x => x.group + ' · ' + x.name).join('; ') : ' ✓'));
  await b.close(); process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
