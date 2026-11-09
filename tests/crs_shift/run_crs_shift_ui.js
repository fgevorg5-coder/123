// UI-тест «Смена СК → Переместить» для растров (и регрессия SHP). Стенд: python3 stand.py 8790
// NODE_PATH=…/node_modules CHROME=$(which chromium) node run_crs_shift_ui.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const OUT = process.env.OUT || path.join(__dirname, '..', '_work', 'crs_shift');
const R = []; const ok = (n, c, x) => { R.push({ n, ok: !!c, x }); console.log((c ? 'OK   ' : 'FAIL ') + n + (x !== undefined ? ' — ' + JSON.stringify(x) : '')); };
const near = (a, b, t) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= t);
const N0 = 'пер. Стахановский (оз)';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });   // без UTF-8 локали Chromium называет кириллические загрузки «download»
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const cons = [], badResp = []; page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) cons.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) badResp.push(r.status() + ' ' + r.request().method() + ' ' + decodeURIComponent(r.url().replace(BASE, ''))); });
  page.on('dialog', d => d.accept());
  const T = () => page.evaluate(() => __toasts.length);
  const waitToast = async (re, from, ms) => {
    try { await page.waitForFunction(([s, n]) => __toasts.slice(n).some(t => new RegExp(s).test(t.m)), [re.source, from], { timeout: ms || 20000 }); return true; }
    catch (e) { console.log('   тосты:', JSON.stringify(await page.evaluate(n => __toasts.slice(n), from))); return false; }
  };
  const settle = async () => { await page.waitForFunction(() => !map.getView().getAnimating()); await page.waitForTimeout(250); };
  const lext = (name) => page.evaluate(n => { const l = map.getLayers().getArray().find(l => l.get('title') === 'Конвертер СК: ' + n); if (!l) return null; const s = l.getSource(); return s.getImageExtent ? s.getImageExtent() : s.getExtent(); }, name);
  const res = () => page.evaluate(() => map.getView().getResolution());
  const check = (i) => page.evaluate(i => fetch('/_check/' + i).then(r => r.json()), i);
  const mvd = () => page.evaluate(() => (document.getElementById('crs-mvd') || {}).textContent || '');
  const waitReady = async (re) => { await page.waitForFunction(s => new RegExp(s).test((document.getElementById('crs-mvd') || {}).textContent || ''), (re || /Пока (не сдвинут|ничего не сдвинуто)/).source, { timeout: 20000 }); };
  const drag = async (coord, dx, dy) => {
    const px = await page.evaluate(c => map.getPixelFromCoordinate(c), coord);
    const box = await page.locator('#map').boundingBox(), x = box.x + px[0], y = box.y + px[1];
    await page.mouse.move(x, y); await page.waitForTimeout(120); await page.mouse.down();
    for (let i = 1; i <= 14; i++) { await page.mouse.move(x + dx * i / 14, y + dy * i / 14); await page.waitForTimeout(18); }
    await page.mouse.up();
  };
  const numeric = async (dx, dy) => { await page.fill('#crs-mv-dx', String(dx)); await page.fill('#crs-mv-dy', String(dy)); await page.click('#crs-mv-apply'); };
  const center = e => [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2];
  const noErr = (c, label) => ok(label + ': без ошибок проверки файлов', !c.errors || !c.errors.length, c.errors);
  try {
    await page.goto(BASE + '/_reset'); await page.goto(BASE + '/crs-test');
    await page.waitForSelector('#crs-results [data-map="4"]', { timeout: 30000 });
    const job = (await page.evaluate(() => fetch('/api/crs/jobs/current').then(r => r.json()))).job;
    const moves = await page.$$eval('#crs-results [data-move]', b => b.map(x => x.getAttribute('data-move')));
    ok('кнопка «Переместить» есть у всех результатов (4 растра + SHP)', JSON.stringify(moves) === '["0","1","2","3","4"]', moves);

    // ── 0: EPSG:3857, как у пользователя ─────────────────────────────
    let t = await T();
    await page.click('[data-move="0"]');                 // слой ещё не на карте — покажется сам
    await waitReady(); await settle();
    ok('0: растр показан и открыт режим перемещения', !!(await lext(N0 + '.tif')), await mvd());
    const hint = await page.$eval('.crs-mv', e => e.textContent);
    ok('0: подсказка для растра, без «весь слой / объект»', /пунктирной рамки/.test(hint) && !/Отдельный объект/.test(hint));
    const e0 = job.items[0].extent3857, r0 = await res();
    await drag(center(e0), 150, 80);
    ok('0: после перетаскивания — сохранено на сервере', await waitToast(/привязка растра сохранена на сервере/, t));
    let c = await check(0); noErr(c, '0 drag');
    ok('0: имена файлов «…_сдвиг.*»', JSON.stringify(c.names.slice().sort()) === JSON.stringify([N0 + '_сдвиг.prj', N0 + '_сдвиг.tfw', N0 + '_сдвиг.tfwx', N0 + '_сдвиг.tif', N0 + '_сдвиг.txt'].sort()), c.names);
    const d0 = c.deltas['.tif теги'];
    ok('0: ΔX/ΔY = перетаскивание (150, −80 пикс.)', near(d0, [150 * r0, -80 * r0], 0.51 * r0), { d0, exp: [150 * r0, -80 * r0] });
    ok('0: теги GeoTIFF = .tfw = .tfwx = PIL = рамка', ['.tfw', '.tfwx', '.tif PIL'].every(k => near(c.deltas[k], d0, 1e-6))
       && near([c.gj.features[0].properties.extent3857[0] - e0[0], c.gj.features[0].properties.extent3857[1] - e0[1]], d0, 1e-6), c.deltas);
    ok('0: в .txt записан итог', new RegExp('Всего от исходной привязки: dX=' + d0[0].toFixed(3).slice(0, -1)).test(c.txt), c.txt);
    let le = await lext(N0 + '.tif');
    ok('0: картинка растра переехала вместе с рамкой', near(le, c.gj.features[0].properties.extent3857, 1e-6), le);
    ok('0: заметка «✓ сохранена на сервере» и кнопки', await page.$eval('#crs-results', b => /✓ Новая привязка сохранена на сервере/.test(b.textContent) && !!b.querySelector('[data-unshift="0"]') && !!b.querySelector('[data-reconv="0"]')));
    await page.screenshot({ path: path.join(OUT, 'qa_raster_drag.png') });
    // точный сдвиг
    t = await T(); await numeric('12,5', '-7.25');
    ok('0: точный сдвиг сохранён', await waitToast(/привязка растра сохранена на сервере/, t));
    c = await check(0); noErr(c, '0 numeric');
    const d1 = c.deltas['.tif теги'];
    ok('0: точный сдвиг +12.5 / −7.25 м добавлен к итогу', near(d1, [d0[0] + 12.5, d0[1] - 7.25], 1e-6), { d1 });
    ok('0: без «_сдвиг_сдвиг» в именах', c.names.every(n => !/_сдвиг_сдвиг/.test(n)), c.names);
    ok('0: .tfw/.tfwx согласованы', ['.tfw', '.tfwx'].every(k => near(c.deltas[k], d1, 1e-6)), c.deltas);
    // скачать сдвинутый
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('.crs-note + .a [data-download="0"]')]);
    ok('0: «Скачать сдвинутый» → «' + N0 + '_сдвиг.zip»', dl.suggestedFilename() === N0 + '_сдвиг.zip', dl.suggestedFilename());
    await page.click('[data-move="0"]');                // «Закончить»
    ok('0: «Закончить» убирает рамку', !(await page.evaluate(() => map.getLayers().getArray().some(l => l.get('title') === 'Конвертер СК: рамка перемещения растра'))));

    // ── перезагрузка: сдвиг берётся с сервера ─────────────────────────
    await page.reload(); await page.waitForSelector('#crs-results [data-map="4"]');
    await page.waitForFunction(() => /✓ Новая привязка сохранена на сервере/.test(document.getElementById('crs-results').textContent), null, { timeout: 15000 });
    await page.click('[data-map="0"]'); await page.waitForFunction(n => map.getLayers().getArray().some(l => l.get('title') === 'Конвертер СК: ' + n), N0 + '.tif'); await settle();
    le = await lext(N0 + '.tif');
    ok('после перезагрузки: растр на новом месте', near(le, c.gj.features[0].properties.extent3857, 1e-6), le);
    t = await T(); await page.click('[data-move="0"]'); await waitReady(/Сохранено от исходной привязки/); await settle();
    ok('после перезагрузки: итог прочитан из _сдвиг.txt', (await mvd()).includes('ΔX ' + d1[0].toFixed(3)), await mvd());
    await drag(center(le), -60, 40);
    ok('повторный сдвиг сохранён', await waitToast(/привязка растра сохранена на сервере/, t));
    const r1 = await res(); c = await check(0); noErr(c, '0 после перезагрузки');
    const d2 = c.deltas['.tif теги'];
    ok('итог накапливается (+(−60, −40) пикс.)', near(d2, [d1[0] - 60 * r1, d1[1] - 40 * r1], 0.51 * r1), { d2 });
    ok('итог в .txt = теги', new RegExp('dX=' + String(d2[0]).slice(0, 9)).test(c.txt), c.txt);
    // «Исходная»
    t = await T(); await page.click('[data-unshift="0"]');
    ok('«Исходная» — сдвиг удалён', await waitToast(/Исходная привязка восстановлена/, t));
    await page.waitForFunction(n => map.getLayers().getArray().some(l => l.get('title') === 'Конвертер СК: ' + n), N0 + '.tif'); await page.waitForTimeout(400);
    ok('«Исходная» — растр вернулся на исходное место', near(await lext(N0 + '.tif'), e0, 1e-6), await lext(N0 + '.tif'));
    ok('«Исходная» — на сервере сдвига нет', (await check(0)).none === true);
    await page.click('[data-map="0"]');                 // убрать с карты

    // ── 1: UTM 35N, ModelTransformation, .aux.xml, .ovr ──────────────
    t = await T(); await page.click('[data-move="1"]'); await waitReady(); await settle();
    await numeric(12.5, -7.25);
    ok('1: точный сдвиг сохранён', await waitToast(/привязка растра сохранена на сервере/, t));
    c = await check(1); noErr(c, '1 numeric');
    ok('1: имена (.tif.aux.xml, .tif.ovr)', JSON.stringify(c.names.slice().sort()) === JSON.stringify(['plan_utm_сдвиг.prj', 'plan_utm_сдвиг.tfw', 'plan_utm_сдвиг.tif', 'plan_utm_сдвиг.tif.aux.xml', 'plan_utm_сдвиг.tif.ovr', 'plan_utm_сдвиг.txt'].sort()), c.names);
    ok('1: ModelTransformation +12.5 / −7.25 м (UTM)', near(c.deltas['.tif теги'], [12.5, -7.25], 1e-3), c.deltas);
    ok('1: .tfw, .aux.xml, PIL согласованы', ['.tfw', '.tif.aux.xml', '.tif PIL'].every(k => near(c.deltas[k], c.deltas['.tif теги'], 1e-6)), c.deltas);
    const u0 = await lext('plan_utm.tif'), ru = await res();
    t = await T(); await drag(center(u0), 100, -50);
    ok('1: перетаскивание сохранено', await waitToast(/привязка растра сохранена на сервере/, t));
    const u1 = await lext('plan_utm.tif'); c = await check(1); noErr(c, '1 drag');
    const expU = await page.evaluate(([a, b, wkt]) => { const P = proj4(wkt), ca = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2], d = [b[0] - a[0], b[1] - a[1]];
      const A = P.forward(ol.proj.toLonLat(ca)), B = P.forward(ol.proj.toLonLat([ca[0] + d[0], ca[1] + d[1]])); return [B[0] - A[0] + 12.5, B[1] - A[1] - 7.25]; },
      [u0, u1, fs.readFileSync(path.join(OUT, 'fixtures', 'plan_utm.prj'), 'utf8')]);
    ok('1: сдвиг в UTM = перенос рамки на карте (через proj4)', near(c.deltas['.tif теги'], expU, 1e-3), { got: c.deltas['.tif теги'], expU, px: [100 * ru, 50 * ru] });
    await page.click('[data-move="1"]'); await page.click('[data-map="1"]');

    // ── 2: SHP — регрессия ───────────────────────────────────────────
    await page.click('[data-move="2"]'); await waitReady(); await settle();
    const g = await lext('kvartal.shp'), rs = await res(), nlog = (await page.evaluate(() => fetch('/_log').then(r => r.json()))).length;
    await drag([g[0] + 75, g[1] + 60], 80, 30);
    await page.waitForFunction(n => fetch('/_log').then(r => r.json()).then(l => l.length > n), nlog, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    c = await check(2);
    const exp2 = [80 * rs, -30 * rs];
    ok('2: SHP — сдвиг сохранён на сервере, все точки сдвинуты', !c.none && c.deltas.every(r => r.every(d => near(d, exp2, 0.51 * rs))), c.none ? c : { d: c.deltas[0][0], exp2 });
    ok('2: SHP — рамка заголовка сдвинута', !c.none && near(c.bbox_delta, [exp2[0], exp2[1], exp2[0], exp2[1]], 0.51 * rs), c.bbox_delta);
    await page.click('[data-move="2"]'); await page.click('[data-map="2"]');

    // ── 3: «голый» BigTIFF EPSG:4326 без .prj ────────────────────────
    t = await T(); await page.click('[data-move="3"]'); await waitReady(); await settle();
    await numeric('0.0001', '-0.00005');
    ok('3: BigTIFF — сдвиг сохранён', await waitToast(/привязка растра сохранена на сервере/, t));
    c = await check(3); noErr(c, '3');
    ok('3: имена ortho_big_сдвиг.tif + .txt', JSON.stringify(c.names.slice().sort()) === JSON.stringify(['ortho_big_сдвиг.tif', 'ortho_big_сдвиг.txt']), c.names);
    ok('3: Tiepoint +0.0001° / −0.00005° (СК из GeoKeys)', near(c.deltas['.tif теги'], [0.0001, -0.00005], 1e-11), c.deltas);
    ok('3: единицы — градусы', /°/.test(await mvd()), await mvd());
    await page.click('[data-move="3"]'); await page.click('[data-map="3"]');

    // ── 4: «.tfwx» не world-файл — исключается, сохранение не падает ──
    t = await T(); await page.click('[data-move="4"]'); await waitReady(); await settle();
    await numeric(3, 4);
    ok('4: сохранено, предупреждение о .tfwx', await waitToast(/привязка растра сохранена на сервере/, t) && await page.evaluate(n => __toasts.slice(n).some(x => /не включён в архив: bad_world\.tfwx/.test(x.m)), t));
    c = await check(4); noErr(c, '4');
    ok('4: .tfwx исключён, .tfw и теги сдвинуты', !c.names.some(n => /tfwx/.test(n)) && near(c.deltas['.tif теги'], [3, 4], 1e-6) && near(c.deltas['.tfw'], [3, 4], 1e-6), c);
    ok('4: в .txt отмечен исключённый файл', /Не включены \(не world-файл/.test(c.txt), c.txt);
    await page.click('[data-move="4"]'); await page.click('[data-map="4"]');

    // ── 413 от nginx → понятное сообщение ─────────────────────────────
    await page.evaluate(() => fetch('/_mode?reject=413'));
    t = await T(); await page.click('[data-move="0"]'); await waitReady(); await settle();
    await numeric(1, 1);
    ok('413 → «архив больше лимита сервера»', await waitToast(/архив больше лимита сервера \(HTTP 413/, t));
    await page.click('[data-move="0"]');
    await page.reload(); await page.waitForSelector('#crs-results [data-map="4"]');
    await page.waitForFunction(() => /⚠ Сохранено в этом браузере/.test(document.getElementById('crs-results').textContent), null, { timeout: 15000 }).catch(() => {});
    ok('перезагрузка: локальная копия из кэша браузера + «Повторить»', await page.$eval('#crs-results', b => /⚠ Сохранено в этом браузере/.test(b.textContent) && !!b.querySelector('[data-retry-shift="0"]')));
    await page.click('[data-map="0"]'); await page.waitForFunction(n => map.getLayers().getArray().some(l => l.get('title') === 'Конвертер СК: ' + n), N0 + '.tif'); await settle();
    { const r413 = await lext(N0 + ".tif");
      ok('перезагрузка: растр из кэша на сдвинутом месте (+1, +1 м)', near([r413[0] - e0[0], r413[1] - e0[1]], [1, 1], 1e-3), [r413[0] - e0[0], r413[1] - e0[1]]); }
    await page.evaluate(() => fetch('/_mode?reject=0')); t = await T(); await page.click('[data-unshift="0"]');
    ok('после 413 — «Исходная» сбрасывает локальную копию', await waitToast(/Исходная привязка восстановлена/, t));
    await page.click('[data-map="0"]').catch(() => {});

    // ── ошибка сервера → копия в браузере → «Повторить» ───────────────
    await page.evaluate(() => fetch('/_mode?reject=1'));
    t = await T(); await page.click('[data-move="0"]'); await waitReady(); await settle();
    await numeric(5, 0);
    ok('сервер отказал → понятное сообщение, копия в браузере', await waitToast(/Сервер не сохранил сдвиг: в архиве нет \.shp\. Резервная копия сохранена в этом браузере/, t));
    ok('заметка «⚠ Сохранено в этом браузере» и «Повторить»', await page.$eval('#crs-results', b => /⚠ Сохранено в этом браузере/.test(b.textContent) && !!b.querySelector('[data-retry-shift="0"]')));
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('.crs-note + .a [data-download="0"]')]);
    const p2 = path.join(OUT, 'local_shift.zip'); await dl2.saveAs(p2);
    ok('локальную копию можно скачать', dl2.suggestedFilename() === N0 + '_сдвиг.zip' && fs.statSync(p2).size > 1000, [dl2.suggestedFilename(), fs.statSync(p2).size]);
    await page.evaluate(() => fetch('/_mode?reject=0'));
    t = await T(); await page.click('[data-retry-shift="0"]');
    ok('«Повторить сохранение» → на сервере', await waitToast(/сохранена на сервере/, t));
    c = await check(0); noErr(c, 'retry');
    ok('после повтора на сервере сдвиг +5 м', near(c.deltas['.tif теги'], [5, 0], 1e-6), c.deltas);
    // «В другую СК»
    await page.click('[data-move="0"]');
    await page.click('[data-reconv="0"]');
    await page.waitForFunction(() => /_сдвиг\.tif/.test(document.getElementById('crs-files').textContent), null, { timeout: 15000 }).catch(() => {});
    const fl = await page.$eval('#crs-files', e => e.textContent);
    ok('«В другую СК» — сдвинутые файлы в конвертере (без .txt)', /_сдвиг\.tif/.test(fl) && /\.tfw✓/.test(fl) && /Файлов: 4/.test(fl) && !/\.txt/.test(fl), fl.slice(0, 200));
    // «Скачать всё»
    const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#crs-dl-all')]);
    const p3 = path.join(OUT, 'all_shift.zip'); await dl3.saveAs(p3);
    ok('«Скачать всё» собран', dl3.suggestedFilename() === 'crs_result_сдвиг.zip', dl3.suggestedFilename());
    fs.writeFileSync(path.join(OUT, 'all_zip_path.txt'), p3);
    await page.click('[data-map="0"]'); await settle(); await page.click('[data-move="0"]'); await waitReady(/Сохранено от исходной/); await settle();
    await page.screenshot({ path: path.join(OUT, 'qa_raster_saved.png') });
    const errs = await page.evaluate(() => __errors);
    ok('нет ошибок JS', !errs.length && !cons.length, { errs, cons });
    const unexpected = badResp.filter(s => !/^(400|413) POST \/api\/crs-shift\/(raster\/)?job-test-1\/0(\/file)?$/.test(s) && !/favicon/.test(s));
    ok('нет неожиданных ответов 4xx/5xx (кроме намеренного отказа сервера)', !unexpected.length, badResp);
  } catch (e) { ok('сценарий выполнен без исключений', false, String(e && e.stack || e)); await page.screenshot({ path: path.join(OUT, 'qa_fail.png') }).catch(() => {}); }
  fs.writeFileSync(path.join(OUT, 'ui_results.json'), JSON.stringify(R, null, 1));
  const bad = R.filter(r => !r.ok).length; console.log('\nИтого: ' + (R.length - bad) + ' / ' + R.length + ' OK');
  await page.close(); await browser.close(); process.exit(bad ? 1 : 0);
})();
