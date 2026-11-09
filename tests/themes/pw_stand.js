// Общие функции Playwright для стенда (настоящий app.py, BASE=http://127.0.0.1:8810) — v20.9
// Стенд без интернета: ol/proj4 берутся из STAND_FE, тайлы подложки — заглушки, CDN шрифтов/иконок — пусто.
// stand_emul.css + stand_menu.js эмулируют раскладку прода (стенд собран без style.css/v15/sidebar_profile_menu).
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8810';
const FE = process.env.STAND_FE || '/data/fe';                      // ol.js, ol.css, proj4.js (офлайн-копии CDN)
const EMUL_CSS = __dirname + '/stand_emul.css';
const EMUL_JS = __dirname + '/stand_menu.js';
const TILES = process.env.STAND_TILES || (__dirname + '/tiles');  // картинки-заглушки подложки
async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'] });
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
async function ctx(browser, { ip = '192.168.12.97', w = 1600, h = 900, dpr = 1, emul = true, storage = null } = {}) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, extraHTTPHeaders: { 'X-Real-IP': ip }, locale: 'ru-RU', storageState: storage || undefined });
  await c.route(/cdn\.jsdelivr\.net\/npm\/ol@9\.2\.4\/dist\/ol\.js/, r => r.fulfill({ path: FE + '/ol.js', contentType: 'application/javascript' }));
  await c.route(/cdn\.jsdelivr\.net\/npm\/ol@9\.2\.4\/(dist\/)?ol\.css/, r => r.fulfill({ path: FE + '/ol.css', contentType: 'text/css' }));
  await c.route(/cdn\.jsdelivr\.net\/npm\/proj4@2\.10\.0\/dist\/proj4\.js/, r => r.fulfill({ path: FE + '/proj4.js', contentType: 'application/javascript' }));
  // подложка: картинки-заглушки (стенд офлайн по данным)
  await c.route(/(tile\.openstreetmap|arcgisonline|basemaps\.cartocdn|tile\.opentopomap|mt\d\.google|yandex|tile)/, r => {
    const u = r.request().url();
    if (/\.(js|css)(\?|$)/.test(u)) return r.continue();
    return r.fulfill({ path: TILES + '/t' + (hash(u) % 6) + '.png', contentType: 'image/png' });
  });
  await c.route(/cdnjs\.cloudflare\.com|unpkg\.com/, r => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  if (emul) {
    await c.route(/\/__stand\/emul\.css/, r => r.fulfill({ path: EMUL_CSS, contentType: 'text/css' }));
    await c.route(/\/__stand\/menu\.js/, r => r.fulfill({ path: EMUL_JS, contentType: 'application/javascript' }));
    await c.route(/\/__stand\/tile\.png/, r => r.fulfill({ path: TILES + '/t2.png', contentType: 'image/png' }));
    // vacancy.css в стенд не входит — подставляем минимальную эмуляцию (окно заявления скрыто, пока нет .open)
    await c.route(/\/static\/vacancy\.css/, r => r.fulfill({ path: __dirname + '/stand_vacancy.css', contentType: 'text/css' }));
    await c.route(u => { const p = new URL(u).pathname; return p === '/' || p === '/index.html'; }, async r => {
      const resp = await r.fetch();
      let body = await resp.text();
      body = body.replace(/<head>/i, '<head><link rel="stylesheet" href="/__stand/emul.css" data-stand-emul>')
                 .replace(/<\/body>/i, '<script src="/__stand/menu.js" defer></script></body>');
      const headers = Object.assign({}, resp.headers()); delete headers['content-length']; delete headers['content-encoding'];
      r.fulfill({ status: resp.status(), headers, body });
    });
  }
  return c;
}
async function open(c, path, wait = 2500) {
  const p = await c.newPage();
  p._errs = [];
  p.on('pageerror', e => p._errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') p._errs.push('console: ' + m.text()); });
  await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(wait);
  return p;
}
module.exports = { launch, ctx, open, BASE };
