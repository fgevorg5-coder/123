/* v20.10 — UI-тест редактора методичек на стенде с НАСТОЯЩИМ app.py (tests/security/stand, заглушка manuals_api).
 * Запуск: python3 tests/security/stand/run_stand.py <стенд> 8240 &   затем
 *         NODE_PATH=<node_modules с playwright> CHROME=$(which chromium) node run_manuals_editor_ui.js [http://127.0.0.1:8240]
 * Проверяет: без сервера редакций — предупреждение (как на скриншоте пользователя); с manuals_editor_api.py —
 * предупреждения нет, «Редактировать» → правка → «Сохранить» → редакция 1 на сервере, видна после перезагрузки. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = (process.argv[2] || 'http://127.0.0.1:8240').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'reports', 'v20.10_shots'); fs.mkdirSync(SHOTS, { recursive: true });
const USER = process.env.ADMIN_USER || 'admin', PASS = process.env.ADMIN_PASS || 'Stand-Admin-Pass-2024!';
const R = [];
const ok = (n, c, i) => { R.push({ name: n, pass: !!c, info: i || '' }); console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? ' — ' + i : '')); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 200)));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=username]', USER); await page.fill('input[name=password]', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.click('button[type=submit]')]);
  await page.evaluate(async sp => { const t = document.querySelector('meta[name=csrf-token]'); await fetch('/api/admin/stepup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { 'X-CSRFToken': t.content } : {}) }, body: JSON.stringify({ password: sp }) }); }, process.env.STEPUP_PASS || 'Stand-StepUp-2024!');
  const st = await (await page.request.get(BASE + '/api/manuals-editions/_status')).json().catch(() => ({}));
  ok('Сервер редакций подключён в app.py (/api/manuals-editions/_status)', st.ready === true, JSON.stringify(st));
  const list = await (await page.request.get(BASE + '/api/manuals')).json();
  const f = (list.manuals || []).flatMap(m => m.files || []).find(x => x.ext === '.docx');
  const fid = f.id;
  // «до»: модуль не установлен (маршрут отвечает 404) — предупреждение, как на скриншоте пользователя
  await page.route('**/api/manuals-editions/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not Found"}' }));
  await page.goto(BASE + '/manuals#f=' + encodeURIComponent(fid), { waitUntil: 'load' });
  await page.waitForSelector('#mw-paper, .mw-placeholder', { timeout: 15000 }); await page.waitForTimeout(800);
  const n0 = await page.$eval('#mw-notice', e => e.hidden ? '' : e.textContent).catch(() => '');
  ok('Без модуля: предупреждение «сервер редакций не отвечает (код 404)…»', /сервер редакций не отвечает/.test(n0) && /404/.test(n0) && /manuals_editor_api\.py/.test(n0), n0.slice(0, 160));
  await page.screenshot({ path: path.join(SHOTS, '40_manuals_without_module.png') });
  await page.unroute('**/api/manuals-editions/**');
  // «после»
  await page.goto(BASE + '/manuals#f=' + encodeURIComponent(fid), { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mw-paper', { timeout: 15000 }); await page.waitForTimeout(800);
  const n1 = await page.$eval('#mw-notice', e => e.hidden ? '' : e.textContent).catch(() => '');
  ok('С модулем: предупреждения нет', !/сервер редакций/.test(n1), n1.slice(0, 120));
  // номер следующей редакции (стенд мог уже хранить редакции прошлых прогонов)
  const R0 = ((await (await page.request.get(BASE + '/api/manuals-editions/' + encodeURIComponent(fid))).json().catch(() => ({}))).revision) || 0, R1 = R0 + 1;
  await page.click('[data-ws="edit"]');
  await page.waitForSelector('#mw-paper[contenteditable="true"]', { timeout: 10000 });
  const MARK = 'Проверка v20.10 ' + Date.now();
  await page.evaluate(m => { const p = document.getElementById('mw-paper'); const h = document.createElement('h2'); h.textContent = m; p.insertBefore(h, p.firstChild); const s = document.createElement('p'); s.innerHTML = 'опасное <img src=x onerror="window.__xss=1"><a href="javascript:alert(1)">ссылка</a>'; p.insertBefore(s, h.nextSibling); p.dispatchEvent(new Event('input', { bubbles: true })); }, MARK);
  await page.screenshot({ path: path.join(SHOTS, '41_manuals_editing.png') });
  await page.click('[data-ws="save"]');
  await page.waitForFunction(() => /сохранена на сервере/.test((document.getElementById('mw-notice') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const n2 = await page.$eval('#mw-notice', e => e.textContent).catch(() => '');
  ok('«Сохранить» — редакция ' + R1 + ' сохранена на сервере', new RegExp('Редакция ' + R1 + ' сохранена на сервере').test(n2), n2.slice(0, 120));
  await page.screenshot({ path: path.join(SHOTS, '42_manuals_saved.png') });
  const ed = await (await page.request.get(BASE + '/api/manuals-editions/' + encodeURIComponent(fid))).json();
  ok('На сервере: редакция ' + R1 + ' с правкой, без onerror/javascript:', ed.revision === R1 && ed.html.includes(MARK) && !/onerror|javascript:/i.test(ed.html), 'revision ' + ed.revision);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mw-paper', { timeout: 15000 }); await page.waitForTimeout(800);
  const txt = await page.$eval('#mw-paper', e => e.textContent);
  ok('После перезагрузки читается веб-редакция ' + R1, txt.includes(MARK));
  // анонимный читатель (если страница доступна без входа) видит ту же редакцию через API
  const anon = await browser.newContext(); const ar = await anon.request.get(BASE + '/api/manuals-editions/' + encodeURIComponent(fid));
  ok('Редакцию читают все (GET без входа)', ar.status() === 200 && (await ar.json()).revision === R1, 'HTTP ' + ar.status());
  const pr = await anon.request.put(BASE + '/api/manuals-editions/' + encodeURIComponent(fid), { data: { html: '<p>взлом</p>', base_revision: R1 } });
  ok('Сохранять без входа нельзя (401/403)', [401, 403].includes(pr.status()), 'HTTP ' + pr.status());
  await anon.close();
  errs.length && ok('Без ошибок JS', false, errs.join(' | '));
  await browser.close();
  const pass = R.filter(r => r.pass).length;
  fs.writeFileSync(path.join(ROOT, 'reports', 'v20.10_manuals_editor_ui.json'), JSON.stringify({ date: new Date().toISOString(), base: BASE, total: R.length, pass, results: R }, null, 1));
  console.log('\nИТОГ: ' + pass + ' / ' + R.length);
  process.exit(pass === R.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
