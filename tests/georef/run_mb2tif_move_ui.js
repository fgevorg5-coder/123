// [v20.7] UI: «MBTiles → TIFF» → «Переместить»: рамка, картинка едет при перетаскивании, перетаскивание во время сохранения,
// точный сдвиг, «MBTiles со сдвигом» (скачать), «Исходная привязка»; «Растр → MBTiles» — «Переместить» видна и без caps.can_shift.
// Стенд: cd tests/georef && FE_DIR=… python3 -m uvicorn ui_server:app --port 8811 ;  node run_mb2tif_move_ui.js http://127.0.0.1:8811 out/mb2tif_move_ui
const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:8811';
const OUT = (process.argv[3] || 'out/mb2tif_move_ui') + '/';
fs.mkdirSync(OUT, { recursive: true });
const TOK = require('crypto').randomBytes(16).toString('hex');
const R = [];
const ok = (name, cond, info) => { R.push([name, !!cond]); console.log((cond ? 'OK   ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 300) : '')); };
const near = (a, b, t) => Math.abs(a - b) <= t;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await ctx.addCookies([{ name: 'georef_uid', value: TOK, domain: new URL(BASE).hostname, path: '/api/georef' }]);
  const page = await ctx.newPage();
  const cons = [], badResp = [];
  page.on('console', m => { if (m.type() === 'error' && !/tile|Failed to load resource/i.test(m.text())) cons.push(m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE) && !/\/fe\/|favicon/.test(r.url())) badResp.push(r.status() + ' ' + r.request().method() + ' ' + decodeURIComponent(r.url().replace(BASE, ''))); });
  page.on('dialog', d => d.accept());
  const shiftResp = [];
  page.on('response', async r => { if (/\/api\/georef\/jobs\/[^/]+\/shift$/.test(r.url()) && r.request().method() === 'POST') { try { const j = await r.json(); shiftResp.push({ st: r.status(), mode: j.mode, err_px: j.err_px, warnings: j.warnings }); } catch (e) { shiftResp.push({ st: r.status() }); } } });
  const api = p => page.evaluate(p => fetch('/api/georef' + p, { credentials: 'same-origin' }).then(r => r.json()), p);
  const status = () => page.evaluate(() => { const e = document.querySelector('#gr-job-card .gr-st'); return e ? e.textContent : ''; });
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);
  async function waitStatus(limit, prev) {
    const t = Date.now();
    while (Date.now() - t < limit) {
      await page.waitForTimeout(700);
      const s = await status();
      if (['Готово', 'Ошибка', 'Отменено'].includes(s) && s !== prev) return s;
    }
    return 'timeout';
  }
  const frameExt = () => page.evaluate(() => {
    const l = window.map.getLayers().getArray().find(l => /^Перемещение/.test(l.get('title') || ''));
    return l && l.getSource().getFeatures()[0] ? l.getSource().getFeatures()[0].getGeometry().getExtent() : null;
  });
  const frame = async () => { const e = await frameExt(); return e ? [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2] : null; };
  const imgExt = file => page.evaluate(f => { const l = window.map.getLayers().getArray().find(l => l.get('title') === 'GeoTIFF: ' + f); return l ? l.getSource().getImageExtent() : null; }, file);
  const res = () => page.evaluate(() => window.map.getView().getResolution());
  const toScreen = c => page.evaluate(c => { const px = window.map.getPixelFromCoordinate(c), b = window.map.getTargetElement().getBoundingClientRect(); return [b.left + px[0], b.top + px[1]]; }, c);
  async function centerOnFrame(z) {
    const c = await frame();
    await page.evaluate(([c, z]) => { const v = window.map.getView(); v.setZoom(z); v.setCenter([c[0] - 180 * v.getResolution(), c[1]]); }, [c, z]);
    await page.waitForTimeout(1500);
  }
  async function dragStart() { const p = await toScreen(await frame()); await page.mouse.move(p[0], p[1]); await page.waitForTimeout(200); await page.mouse.down(); return p; }
  async function dragTo(p, dx, dy, steps, pause) { for (let k = 1; k <= steps; k++) { await page.mouse.move(p[0] + dx * k / steps, p[1] + dy * k / steps); await page.waitForTimeout(pause); } }
  async function waitItem(id, pred, limit) {
    const t = Date.now(); let it;
    while (Date.now() - t < limit) { await page.waitForTimeout(600); it = (await api('/jobs/' + id)).result.outputs[0]; if (pred(it)) return it; }
    return it;
  }
  async function grab(clip) {          // снимок области → RGB
    const b = await page.screenshot({ clip });
    const { data, info } = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height };
  }
  function bestShift(A, B, lo, hi) {   // B ≈ A, сдвинутая вправо на s пикселей
    let best = [1e9, 0];
    for (let s = lo; s <= hi; s++) {
      let sum = 0, n = 0;
      for (let y = 0; y < A.h; y += 2) for (let x = Math.max(0, s); x < Math.min(A.w, A.w + s); x += 2) {
        const ia = (y * A.w + x - s) * 3, ib = (y * B.w + x) * 3;
        sum += Math.abs(A.data[ia] - B.data[ib]) + Math.abs(A.data[ia + 1] - B.data[ib + 1]) + Math.abs(A.data[ia + 2] - B.data[ib + 2]); n++;
      }
      if (n && sum / n < best[0]) best = [sum / n, s];
    }
    return best;
  }
  const NAME = 'квартал_ортофото';
  const mbPath = (await (await page.request.get(BASE + '/mb_fixture?name=' + encodeURIComponent(NAME))).json()).path;
  await page.goto(BASE + '/georef-test');
  await page.waitForSelector('#crs-tabs [data-tab=mb2tif]');
  await page.waitForTimeout(600);
  // ── 1. MBTiles → TIFF (EPSG:3857) ──
  await page.click('#crs-tabs [data-tab=mb2tif]');
  await page.waitForSelector('#gr-drop');
  await page.setInputFiles('#gr-file', mbPath);
  await page.waitForTimeout(400);
  await page.click('#gr-go');
  let st = await waitStatus(120000);
  ok('«MBTiles → TIFF» — «Готово»', st === 'Готово', st);
  await page.waitForTimeout(1500);
  const jid = (await api('/jobs?kind=mb2tif&limit=1')).items[0].id;
  let J = await api('/jobs/' + jid), o0 = J.result.outputs[0];
  ok('  GeoTIFF EPSG:3857 с просмотром', /3857/.test(o0.crs || '') && !!o0.preview, [o0.crs, o0.file]);
  ok('  кнопка «Переместить» у GeoTIFF', !!(await page.$('[data-tmove="0"]')));
  await page.screenshot({ path: OUT + '01_mb2tif_done_move_button.png' });
  // ── 2. «Переместить»: рамка, живой сдвиг картинки ──
  await page.click('[data-tmove="0"]');
  await page.waitForTimeout(1200);
  ok('«Переместить»: панель сдвига и оранжевая рамка', !!(await page.$('#gr-mv-apply')) && !!(await frame()));
  const hint = await text('.gr-mv .h');
  ok('  подсказка: GeoTIFF, TFW/TFWX и MBTiles со сдвигом', /TFW\/TFWX и MBTiles со сдвигом/.test(hint), hint);
  ok('  нет предупреждения о версии сервера', !(await page.$('.gr-mv .w')));
  await centerOnFrame(17);
  const e0 = await imgExt(o0.file), fe0 = await frameExt();
  ok('  рамка совпадает с картинкой', e0 && fe0 && [0, 1, 2, 3].every(k => near(e0[k], fe0[k], 0.01)), [e0, fe0]);
  await page.screenshot({ path: OUT + '02_mb2tif_move_panel.png' });
  const r0 = await res();
  const tl = await toScreen([e0[0], e0[3]]), br = await toScreen([e0[2], e0[1]]);
  const clip = { x: Math.round(Math.max(tl[0], 380) + 8), y: Math.round(tl[1] + 50), width: Math.round(Math.min(br[0], 1390) - Math.max(tl[0], 380) - 16), height: 120 };
  const A = await grab(clip);
  let p = await dragStart();
  await dragTo(p, 60, 0, 12, 40);
  await page.waitForTimeout(400);
  const B = await grab(clip);
  await page.screenshot({ path: OUT + '03_mb2tif_dragging.png' });
  const bs = bestShift(A, B, -10, 100);
  ok('картинка едет за рамкой во время перетаскивания (≈60 пикс.)', Math.abs(bs[1] - 60) <= 2, { shift_px: bs[1], diff: +bs[0].toFixed(1), clip });
  await page.mouse.up();
  // ── 3. второе перетаскивание, пока идёт сохранение ──
  let saving = false;
  for (let k = 0; k < 40 && !saving; k++) { await page.waitForTimeout(50); saving = /Сохранение/.test(await text('#gr-mv-st')); }
  ok('после отпускания — «Сохранение…»', saving, await text('#gr-mv-st'));
  p = await dragStart();
  await dragTo(p, 40, 0, 25, 60);
  await page.waitForTimeout(300);
  await page.mouse.up();
  const exp = 100 * r0;
  let it = await waitItem(jid, o => o.shift_3857 && near(o.shift_3857[0], exp, 2.5 * r0), 90000);
  for (let k = 0; k < 60 && /Сохранение/.test(await text('#gr-mv-st')); k++) await page.waitForTimeout(500);
  it = (await api('/jobs/' + jid)).result.outputs[0];
  ok('оба перетаскивания сохранены: 60 + 40 пикс. на восток', it.shift_3857 && near(it.shift_3857[0], exp, 2.5 * r0) && Math.abs(it.shift_3857[1]) < 2.5 * r0, { got: it.shift_3857, exp: [exp, 0], px: r0 });
  const toasts1 = await page.evaluate(() => window.__toasts.map(t => t.m));
  ok('  без «Подождите — сдвиг сохраняется» и ошибок', !toasts1.some(m => /Подождите|Не сохранено/.test(m)) && !/Не сохранено/.test(await text('#gr-mv-st')), toasts1);
  await page.waitForTimeout(1200);
  const e1 = await imgExt(it.file), fe1 = await frameExt();
  ok('  картинка и рамка — на сохранённом месте', e1 && fe1 && near(e1[0] - e0[0], it.shift_3857[0], 0.01) && near(e1[1] - e0[1], it.shift_3857[1], 0.01) && [0, 1, 2, 3].every(k => near(e1[k], fe1[k], 0.01)), { e1, fe1 });
  ok('  сохранений: ≥2, все 200, режим «на месте» (EPSG:3857)', shiftResp.length >= 2 && shiftResp.every(s => s.st === 200 && s.mode === 'inplace'), shiftResp);
  let card = await text('#gr-res-card');
  ok('  карточка: «Сдвиг вручную» и «MBTiles со сдвигом»', /Сдвиг вручную/.test(card) && /MBTiles со сдвигом/.test(card) && card.includes(NAME + '_сдвиг.mbtiles'), card.replace(/\s+/g, ' ').slice(0, 400));
  const ms = it.mbtiles_shifted || {};
  ok('  MBTiles со сдвигом: все уровни z15–18', ms.file === NAME + '_сдвиг.mbtiles' && ms.zooms && ms.zooms[0] === 15 && ms.zooms[1] === 18 && ms.tiles > 0, ms);
  await page.screenshot({ path: OUT + '04_mb2tif_moved_saved.png' });
  // скачивание «MBTiles со сдвигом»
  const href = await page.$eval('.gr-mbs a[download]', a => a.getAttribute('href'));
  const dl = await page.evaluate(h => fetch(h, { credentials: 'same-origin' }).then(async r => { const b = new Uint8Array(await r.arrayBuffer()); return { st: r.status, n: b.length, head: String.fromCharCode.apply(null, b.slice(0, 15)) }; }), href);
  ok('  «Скачать MBTiles» → файл SQLite', dl.st === 200 && dl.head === 'SQLite format 3' && dl.n > 4096, dl);
  // TFW совпадает со сдвигом
  const tfwName = (it.files || []).find(n => /\.tfw$/i.test(n));
  const tfw0 = (await page.evaluate(([j, n]) => fetch('/api/georef/jobs/' + j + '/files/' + encodeURIComponent(n), { credentials: 'same-origin' }).then(r => r.ok ? r.text() : 'HTTP ' + r.status), [jid, tfwName]));
  const w = tfw0.split(/\s+/).filter(Boolean).map(Number);
  ok('  .tfw прочитан', w.length === 6, tfw0.slice(0, 120));
  // точный сдвиг
  const s1 = it.shift_m.slice();
  await page.fill('#gr-mv-dx', '2'); await page.fill('#gr-mv-dy', '-1,5'); await page.click('#gr-mv-apply');
  it = await waitItem(jid, o => o.shift_m && Math.abs(o.shift_m[1] - s1[1] + 1.5) < 0.05, 60000);
  ok('точный сдвиг: +2 м на восток, −1,5 м на север', Math.abs(it.shift_m[0] - s1[0] - 2) < 0.05 && Math.abs(it.shift_m[1] - s1[1] + 1.5) < 0.05, [s1, it.shift_m]);
  const tfw1 = (await page.evaluate(([j, n]) => fetch('/api/georef/jobs/' + j + '/files/' + encodeURIComponent(n), { credentials: 'same-origin' }).then(r => r.ok ? r.text() : 'HTTP ' + r.status), [jid, tfwName]));
  const w1 = tfw1.split(/\s+/).filter(Boolean).map(Number), k = it.shift_3857[0] / it.shift_m[0];
  ok('  .tfw: C/F сдвинуты на точный шаг (в единицах EPSG:3857)', w1.length === 6 && near(w1[4] - w[4], 2 * k, 0.01) && near(w1[5] - w[5], -1.5 * k, 0.01), { dC: w1[4] - w[4], dF: w1[5] - w[5], k });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '05_mb2tif_exact.png' });
  // «Исходная привязка»
  await page.click('#gr-mv-reset');
  it = await waitItem(jid, o => !o.shift_3857, 60000);
  ok('«Исходная привязка» — сдвиг снят, MBTiles со сдвигом удалён', !it.shift_3857 && !it.mbtiles_shifted, [it.shift_3857, it.mbtiles_shifted]);
  await page.waitForTimeout(1500);
  const e2 = await imgExt(it.file);
  ok('  картинка вернулась на исходное место', e2 && [0, 1, 2, 3].every(k => near(e2[k], e0[k], 0.01)), [e2, e0]);
  card = await text('#gr-res-card');
  ok('  в карточке нет строки «MBTiles со сдвигом»', !(await page.$('.gr-mbs')) && !card.includes(NAME + '_сдвиг.mbtiles'));
  await page.click('#gr-mv-done'); await page.waitForTimeout(800);
  ok('«Готово» закрывает панель и рамку', !(await page.$('#gr-mv-apply')) && !(await frame()));
  await page.screenshot({ path: OUT + '06_mb2tif_reset_done.png' });
  // ── 4. «Растр → MBTiles»: кнопка «Переместить» без caps.can_shift ──
  await page.route('**/api/georef/caps*', async route => {
    const r = await route.fetch(); const c = await r.json(); delete c.can_shift; delete c.shift_kinds;
    await route.fulfill({ response: r, json: c });
  });
  const fx = await (await page.request.get(BASE + '/fixtures')).json();
  await page.reload();
  await page.waitForSelector('#crs-tabs [data-tab=mbtiles]');
  await page.waitForTimeout(600);
  await page.click('#crs-tabs [data-tab=mbtiles]');
  await page.waitForSelector('#gr-drop');
  await page.setInputFiles('#gr-file', fx.gk5);
  await page.fill('#gr-minz', '17'); await page.fill('#gr-maxz', '19');
  await page.waitForTimeout(300);
  await page.click('#gr-go');
  st = await waitStatus(180000);
  await page.waitForTimeout(1500);
  ok('«Растр → MBTiles» (caps без can_shift): «Готово» и кнопка «Переместить»', st === 'Готово' && !!(await page.$('[data-mmove="0"]')), st);
  await page.screenshot({ path: OUT + '07_mbtiles_move_button_without_can_shift.png' });
  await page.unroute('**/api/georef/caps*');
  const errs = await page.evaluate(() => window.__errors);
  ok('нет ошибок JS', errs.length === 0 && cons.length === 0, { errs, cons });
  ok('нет ответов 4xx/5xx', badResp.length === 0, badResp);
  const bad = R.filter(r => !r[1]).length;
  console.log(`\n${R.length - bad}/${R.length} OK`);
  fs.writeFileSync(OUT + 'ui_results.json', JSON.stringify(R, null, 1));
  await page.close(); await browser.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
