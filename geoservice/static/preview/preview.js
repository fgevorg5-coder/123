/* Превью-страница геосервиса: 1) «окно» под курсором открывает границы лесного фонда под снимком,
   2) «нырок» по скроллу от всей Беларуси до квартала (кадры WebP + геоинтерполяция между ними),
   3) орбита — станция «пролетает» по скроллу и рассказывает, чем полезен геосервис,
   4) посадка — космонавт подходит; при наведении — «Зарегистрироваться» и «Войти в геосервис ОДЗиМЛ».
   Без библиотек. Медиа готовят tools/preview/make_preview_media.py и make_space_media.py. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MEDIA = document.documentElement.dataset.media || '/static/preview/media/';
  const V = document.documentElement.dataset.v, QV = V ? '?v=' + encodeURIComponent(V) : '';   // версия медиа (подставляет /preview)
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const R_EARTH = 6378137;

  /* шапка становится плотной при прокрутке */
  const nav = $('.nav');
  const onScroll = () => nav && nav.classList.toggle('solid', scrollY > 40);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  $$('.rise').forEach((el, i) => el.querySelectorAll(':scope > span').forEach(s => s.style.setProperty('--i', i)));

  /* ═════════ 1. ГЕРОЙ: окно под курсором ═════════ */
  function initHero() {
    const hero = $('.hero'), root = $('.reveal');
    if (!hero || !root) return;
    const video = root.querySelector('video'), tip = root.querySelector('.tip');
    const tipB = tip.querySelector('b'), tipS = tip.querySelector('span'), tipSm = tip.querySelector('small');
    const baseR = +root.dataset.radius || 190, hint = hero.querySelector('.hint');
    /* верхняя граница для подсказки: под меню, а на телефоне — ещё и под строкой «Коснитесь снимка…», пока она видна */
    const topSafe = () => {
      if (!hint || hero.classList.contains('active')) return 72;
      const hb = hint.getBoundingClientRect(), rb = root.getBoundingClientRect();
      return hb.top - rb.top < rb.height / 2 ? Math.max(72, hb.bottom - rb.top + 8) : 72;
    };
    let R = baseR;
    const fitR = () => { R = Math.round(Math.max(110, Math.min(baseR, innerWidth * 0.3))); };
    fitR(); addEventListener('resize', fitR);

    let tx = 0, ty = 0, x = 0, y = 0, r = 0, tr = 0, lastX = 0, lastY = 0, speed = 0;
    let inside = false, idle = !reduce, t0 = performance.now(), visible = true, idleTimer = 0;
    const play = () => { if (!reduce && visible && video.paused) video.play().catch(() => {}); };
    const local = e => { const b = root.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    function enter(px, py) {
      if (!inside) { x = px; y = py; inside = true; }
      tx = px; ty = py; tr = R; idle = false; clearTimeout(idleTimer);
      hero.classList.add('active'); hero.classList.remove('idle'); play();
    }
    function leave() {
      inside = false; tr = 0; hero.classList.remove('active');
      clearTimeout(idleTimer);
      if (!reduce) idleTimer = setTimeout(() => { if (!inside) { idle = true; t0 = performance.now(); } }, 2600);
    }
    root.addEventListener('pointermove', e => { const [px, py] = local(e); enter(px, py); });
    root.addEventListener('pointerdown', e => { const [px, py] = local(e); enter(px, py); });
    root.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') leave(); });
    root.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { clearTimeout(idleTimer); idleTimer = setTimeout(leave, 1800); } });
    root.addEventListener('pointercancel', () => leave());

    /* подсказка «квартал · выдел · площадь · лесничество · лесхоз» и подсветка выдела под курсором:
       карта объектов hero-ids.png (½ разрешения, R + G·256 = номер выдела) + таблица hero.json */
    const hl = root.querySelector('canvas.hl'), hg = hl && hl.getContext('2d');
    let meta = null, ids = null, idsW = 0, idsH = 0, bbox = null, lastTip = '', tipAt = 0, hlId = 0, hlMask = null;
    fetch(MEDIA + 'hero.json' + QV).then(r => r.json()).then(m => {
      meta = m; buildLegend(m);
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = idsW = im.naturalWidth; c.height = idsH = im.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
        ids = g.getImageData(0, 0, idsW, idsH).data;
        bbox = new Map();                                  // рамка каждого выдела: маску подсветки строим только внутри неё
        for (let y = 0, k = 0; y < idsH; y++) for (let x = 0; x < idsW; x++, k += 4) {
          const id = ids[k] + ids[k + 1] * 256; if (!id) continue;
          const q = bbox.get(id);
          if (!q) bbox.set(id, [x, y, x, y]);
          else { if (x < q[0]) q[0] = x; if (x > q[2]) q[2] = x; q[3] = y; }
        }
      };
      im.src = MEDIA + 'hero-ids.png' + QV;
    }).catch(() => {});
    function buildLegend(m) {          // чипы легенды статичны в разметке, из hero.json — цвет и число объектов в кадре
      (m.legend || []).forEach(l => {
        const c = $(`.legend .chip[data-k="${l.k}"]`); if (!c) return;
        if (l.color) c.style.setProperty('--c', l.color);
        const n = c.querySelector('b'); if (n && l.n) n.textContent = l.n.toLocaleString('ru-RU');
      });
    }
    function idAt(px, py) {
      if (!ids || !meta) return 0;
      const b = root.getBoundingClientRect(), iw = meta.size[0], ih = meta.size[1];
      const s = Math.max(b.width / iw, b.height / ih), ox = (b.width - iw * s) / 2, oy = (b.height - ih * s) / 2;
      const u = (px - ox) / s, v = (py - oy) / s;
      if (u < 0 || v < 0 || u >= iw || v >= ih) return 0;
      const k = (Math.floor(v * idsH / ih) * idsW + Math.floor(u * idsW / iw)) * 4;
      return ids[k] + ids[k + 1] * 256;
    }
    /* маска выдела: полупрозрачная заливка + контур (пиксели выдела на его краю); свечение — тенью канваса, работает везде */
    function buildMask(id) {
      const q = bbox && bbox.get(id); if (!q) return null;
      const x0 = Math.max(0, q[0] - 1), y0 = Math.max(0, q[1] - 1), w = Math.min(idsW, q[2] + 2) - x0, h = Math.min(idsH, q[3] + 2) - y0;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'), out = g.createImageData(w, h), d = out.data, lo = id & 255, hi = id >> 8;
      const on = (X, Y) => { if (X < 0 || Y < 0 || X >= idsW || Y >= idsH) return false; const k = (Y * idsW + X) * 4; return ids[k] === lo && ids[k + 1] === hi; };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const X = x0 + x, Y = y0 + y; if (!on(X, Y)) continue;
        const k = (y * w + x) * 4, edge = !on(X - 1, Y) || !on(X + 1, Y) || !on(X, Y - 1) || !on(X, Y + 1);
        if (edge) { d[k] = 255; d[k + 1] = 238; d[k + 2] = 204; d[k + 3] = 255; }
        else { d[k] = 255; d[k + 1] = 196; d[k + 2] = 118; d[k + 3] = 62; }
      }
      g.putImageData(out, 0, 0);
      return { c, x0, y0, w, h };
    }
    function drawHl() {
      if (!hg) return;
      const dpr = Math.min(devicePixelRatio || 1, 2), bw = root.clientWidth, bh = root.clientHeight;
      const W = Math.round(bw * dpr), H = Math.round(bh * dpr);
      if (hl.width !== W || hl.height !== H) { hl.width = W; hl.height = H; }
      hg.clearRect(0, 0, W, H);
      if (!hlMask || !meta) return;
      const iw = meta.size[0], ih = meta.size[1], s = Math.max(bw / iw, bh / ih) * dpr;
      const ox = (W - iw * s) / 2, oy = (H - ih * s) / 2, k = iw / idsW * s;      // пиксель карты объектов → пиксели канваса
      const m = hlMask, dx = ox + m.x0 * k, dy = oy + m.y0 * k, dw = m.w * k, dh = m.h * k;
      hg.imageSmoothingEnabled = true;
      hg.save(); hg.shadowColor = 'rgba(255,190,110,.9)'; hg.shadowBlur = 16 * dpr; hg.drawImage(m.c, dx, dy, dw, dh); hg.restore();
      hg.drawImage(m.c, dx, dy, dw, dh);
    }
    addEventListener('resize', () => drawHl());
    const fmtHa = v => v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    function updateTip(now) {
      if (now - tipAt < 70) return; tipAt = now;
      const id = r > 60 ? idAt(x, y) : 0, f = id ? meta.features[id] : null;
      if ((f ? id : 0) !== hlId) {
        hlId = f ? id : 0; hlMask = f ? buildMask(id) : null; drawHl();
        if (hl) hl.classList.toggle('on', !!hlMask);
      }
      if (!f) { tip.classList.remove('on'); lastTip = ''; return; }
      if (id !== lastTip) {
        lastTip = id;
        const head = [f[0] && 'Квартал ' + f[0], f[1] && (f[0] ? 'выдел ' : 'Выдел ') + f[1]].filter(Boolean).join(' · ');
        tipB.textContent = head || 'Лесной фонд';
        tipS.textContent = [f[2] ? fmtHa(f[2]) + ' га' : '', meta.lesnich[f[3]] || ''].filter(Boolean).join(' · ');
        tipSm.textContent = meta.leshoz[f[4]] || '';
      }
      tip.classList.add('on');
      const bw = root.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;   // не даём подсказке уйти за край
      tip.classList.toggle('flip-x', x + r * 0.5 + tw > bw - 10);
      tip.classList.toggle('flip-y', y - r * 0.66 - th < topSafe());
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(es => es.forEach(e => {
        visible = e.isIntersecting; if (!visible && !video.paused) video.pause(); else if (visible && r > 1) play();
      }), { threshold: 0.02 }).observe(hero);
    }
    if (idle) hero.classList.add('idle');

    function tick(now) {
      if (visible) {
        if (idle) {      // пока не трогали — окно само медленно «бродит» по массиву
          const b = root.getBoundingClientRect(), t = (now - t0) / 1000, narrow = b.width < 760;
          tx = b.width * ((narrow ? 0.5 : 0.66) + (narrow ? 0.2 : 0.15) * Math.sin(t * 0.55));
          ty = b.height * ((narrow ? 0.34 : 0.5) + 0.13 * Math.sin(t * 0.9 + 1.2));
          if (!inside) { x = tx; y = ty; inside = true; }
          tr = R * 0.8; play();
        }
        const k = reduce ? 1 : 0.16;
        x += (tx - x) * k; y += (ty - y) * k;
        speed = speed * 0.85 + Math.hypot(x - lastX, y - lastY) * 0.15; lastX = x; lastY = y;
        const target = tr * (1 + Math.min(speed / 60, 0.35));       // при быстром движении окно чуть растёт
        r += (target - r) * (reduce ? 1 : 0.12);
        if (r < 0.5 && tr === 0) r = 0;
        root.style.setProperty('--x', x.toFixed(1) + 'px');
        root.style.setProperty('--y', y.toFixed(1) + 'px');
        root.style.setProperty('--r', r.toFixed(1) + 'px');
        updateTip(now);
        if (r < 1 && !video.paused) video.pause();                  // экономим батарею
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ═════════ 2. «НЫРОК» ПО СКРОЛЛУ ═════════ */
  function initStory() {
    const story = $('#story'); if (!story) return;
    const canvas = story.querySelector('canvas'), ctx = canvas.getContext('2d', { alpha: false });
    const intro = story.querySelector('video.intro'), caps = $$('.cap', story), loader = $('.loader');
    const hudC = $('.hud .coords', story), hudS = $('.hud .scale b', story), hudBar = $('.hud .scale i', story), hudR = $('.hud .ratio', story);
    const dots = $$('.steps i', story);
    const portrait = matchMedia('(max-aspect-ratio: 4/5)');
    const SMOOTH = 0.14, INTRO_FADE = 0.025;
    caps.forEach(c => c.querySelectorAll('.num, h2 > span, p').forEach((el, i) => el.style.setProperty('--i', i)));

    let F = null, imgs = [], loaded = 0, cur = 0, drawnKey = '', started = false, gen = 0;

    function choose() {
      const folder = portrait.matches ? 'frames-m/' : 'frames/';
      intro.poster = MEDIA + folder + 'f_0001.webp' + QV;
      intro.src = MEDIA + (portrait.matches ? 'intro-m.mp4' : 'intro.mp4') + QV;
      const my = ++gen;
      return fetch(MEDIA + folder + 'manifest.json' + QV).then(r => r.json()).then(m => {
        if (my !== gen) return;
        F = Object.assign({ path: MEDIA + folder + 'f_', ext: '.webp', pad: 4 }, m);
        imgs = new Array(F.count); loaded = 0; drawnKey = ''; loader.style.opacity = 1;
        if (started) preload(my);
      });
    }
    const src = i => F.path + String(i + 1).padStart(F.pad, '0') + F.ext + QV;
    function preload(my) {      // сначала каждый 8-й кадр («черновик» анимации), потом остальные
      const order = [], seen = new Set();
      for (const step of [8, 4, 2, 1]) for (let i = 0; i < F.count; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
      if (!seen.has(F.count - 1)) order.splice(1, 0, F.count - 1);
      let p = 0;
      const next = () => {
        if (my !== gen || p >= order.length) return;
        const i = order[p++], im = new Image(); im.decoding = 'async';
        im.onload = im.onerror = () => {
          if (my !== gen) return;
          loaded++; loader.style.width = (loaded / F.count * 100) + '%';
          if (loaded >= F.count) setTimeout(() => { loader.style.opacity = 0; }, 300);
          drawnKey = ''; next();
        };
        im.src = src(i); imgs[i] = im;
      };
      for (let k = 0; k < 6; k++) next();
    }
    function start() { if (started) return; started = true; if (F) preload(gen); }

    const ok = im => im && im.complete && im.naturalWidth;
    /* ищем загруженный кадр, который ПОКРЫВАЕТ вид: сначала текущий и более «далёкие» (меньший номер) */
    function nearest(i) {
      for (let d = 0; d <= 12; d++) if (ok(imgs[i - d])) return i - d;
      for (let d = 1; d < F.count; d++) {
        if (ok(imgs[i + d])) return i + d;
        if (ok(imgs[i - 12 - d])) return i - 12 - d;
      }
      return -1;
    }
    function fit() {
      const d = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(innerWidth * d); canvas.height = Math.round(innerHeight * d); drawnKey = '';
    }
    /* кадр j рисуется так, как выглядел бы промежуточный вид между кадрами i и i+1
       (центр и масштаб из manifest.json) — зум получается непрерывным, без «ступенек» */
    function draw(pos) {
      const i = Math.min(F.count - 1, Math.floor(pos)), f = pos - i, j = nearest(i);
      if (j < 0) return false;
      const im = imgs[j], W = canvas.width, H = canvas.height, w = F.w, h = F.h;
      const s = Math.max(W / w, H / h), ox = (W - w * s) / 2, oy = (H - h * s) / 2;
      let k = 1, dX = 0, dY = 0;
      if (F.mpp && F.x) {
        const i2 = Math.min(F.count - 1, i + 1);
        const mppV = F.mpp[i] * Math.pow(F.mpp[i2] / F.mpp[i], f);
        const cx = F.x[i] + (F.x[i2] - F.x[i]) * f, cy = F.y[i] + (F.y[i2] - F.y[i]) * f;
        k = F.mpp[j] / mppV; dX = (cx - F.x[j]) / F.mpp[j]; dY = (cy - F.y[j]) / F.mpp[j];
      }
      const dx = ox + s * (w / 2 + (-w / 2 - dX) * k), dy = oy + s * (h / 2 + (-h / 2 + dY) * k);
      if (k < 1 || j > i + 1) { ctx.fillStyle = '#050a06'; ctx.fillRect(0, 0, W, H); }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, dx, dy, w * s * k, h * s * k);
      return true;
    }
    function niceRound(v) { const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p; }
    function hud(pos) {
      if (!F || !F.mpp) return;
      const i = Math.min(F.count - 1, Math.floor(pos)), i2 = Math.min(F.count - 1, i + 1), f = pos - i;
      const mpp = F.mpp[i] * Math.pow(F.mpp[i2] / F.mpp[i], f), lat = F.lat[i] + (F.lat[i2] - F.lat[i]) * f, lon = F.lon[i] + (F.lon[i2] - F.lon[i]) * f;
      const W = canvas.width, H = canvas.height, s = Math.max(W / F.w, H / F.h), dpr = W / innerWidth;
      const mCss = mpp * dpr / s * Math.cos(lat * Math.PI / 180);          // метров на местности в 1 CSS-пикселе
      const L = niceRound(mCss * 90);
      hudBar.style.width = (L / mCss).toFixed(0) + 'px';
      hudS.textContent = L >= 1000 ? (L / 1000).toLocaleString('ru-RU') + ' км' : L + ' м';
      hudC.textContent = lat.toFixed(3).replace('.', ',') + '° с. ш.  ' + lon.toFixed(3).replace('.', ',') + '° в. д.';
      const den = mCss / 0.0002646, p = Math.pow(10, Math.floor(Math.log10(den)) - 1);
      hudR.textContent = 'М 1 : ' + (Math.round(den / p) * p).toLocaleString('ru-RU');
    }
    function progress() {
      const r = story.getBoundingClientRect(), len = r.height - innerHeight;
      return Math.min(1, Math.max(0, -r.top / len));
    }
    function tick() {
      const p = progress();
      if (F) {
        const target = p * (F.count - 1);
        cur += (target - cur) * (reduce ? 1 : SMOOTH);
        if (Math.abs(target - cur) < 0.002) cur = target;
        const key = cur.toFixed(3) + '|' + canvas.width + '|' + loaded;
        if (key !== drawnKey && draw(cur)) { drawnKey = key; hud(cur); }
      }
      const f = Math.min(1, p / INTRO_FADE);                 // интро ↔ последовательность
      canvas.style.opacity = f; intro.style.opacity = 1 - f;
      const nearView = story.getBoundingClientRect().top < innerHeight && story.getBoundingClientRect().bottom > 0;
      if ((f >= 1 || !nearView) && !intro.paused) intro.pause();
      else if (f < 1 && nearView && intro.paused && !reduce && intro.src) intro.play().catch(() => {});
      let active = -1;
      caps.forEach((c, n) => { const on = p >= +c.dataset.in && p < +c.dataset.out; c.classList.toggle('on', on); if (on) active = n; });
      if (active < 0) caps.forEach((c, n) => { if (p >= +c.dataset.in) active = n; });
      dots.forEach((d, n) => d.classList.toggle('on', n === active));
      requestAnimationFrame(tick);
    }
    addEventListener('resize', fit);
    portrait.addEventListener && portrait.addEventListener('change', () => { cur = progress() * ((F && F.count - 1) || 0); choose(); });
    fit(); choose().then(() => requestAnimationFrame(tick));
    /* кадры грузим, когда страница уже показала героя: после load или при подходе к блоку */
    addEventListener('load', () => setTimeout(start, 400));
    if ('IntersectionObserver' in window)
      new IntersectionObserver(es => es.forEach(e => e.isIntersecting && start()), { rootMargin: '120% 0px' }).observe(story);
    else start();
  }

  /* ═════════ общий проигрыватель кадров по скроллу (орбита, посадка) ═════════
     manifest.json: {count, w, h, hot: [[x0, y0, x1, y1] — рамка объекта в долях кадра, по кадрам]} */
  const portraitMq = matchMedia('(max-aspect-ratio: 4/5)'), narrowMq = matchMedia('(max-width: 760px)');
  const coarse = matchMedia('(hover: none)').matches;
  const fv = el => { try { return !!el && el.matches(':focus-visible'); } catch (e) { return false; } };
  const progressOf = sec => { const r = sec.getBoundingClientRect(), len = r.height - innerHeight; return len > 0 ? Math.min(1, Math.max(0, -r.top / len)) : 0; };
  const prepCaps = caps => caps.forEach(c => c.querySelectorAll('.num, h2 > span, p').forEach((el, i) => el.style.setProperty('--i', i)));
  const setCaps = (caps, p) => caps.forEach(c => c.classList.toggle('on', p >= +c.dataset.in && p < +c.dataset.out));
  function place(el, x, y, w, h) {
    const k = [x, y, w, h].map(Math.round).join(',');
    if (el._k === k) return; el._k = k;
    el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    el.style.width = Math.max(0, Math.round(w)) + 'px'; el.style.height = Math.max(0, Math.round(h)) + 'px';
  }
  function makeSeq(section, o) {
    const canvas = section.querySelector('canvas.seq'), ctx = canvas.getContext('2d');
    const S = { F: null, near: false, key: '' };
    let imgs = [], loaded = 0, gen = 0, started = false, G = null;
    function choose() {
      const fd = (portraitMq.matches && o.portrait) || o.folder, my = ++gen;
      return fetch(MEDIA + fd + 'manifest.json' + QV).then(r => r.json()).then(m => {
        if (my !== gen) return;
        S.F = Object.assign({ path: MEDIA + fd + 'f_', ext: '.webp', pad: 4, folder: fd }, m);
        imgs = new Array(S.F.count); loaded = 0; fit();
        if (o.onManifest) o.onManifest(S.F);
        if (started) load(my);
      }).catch(() => {});
    }
    const src = i => S.F.path + String(i + 1).padStart(S.F.pad, '0') + S.F.ext + QV;
    function load(my) {            // первый и последний кадр, затем каждый 8-й, 4-й, 2-й — анимация «проявляется» сразу
      const F = S.F, order = [0, F.count - 1], seen = new Set(order);
      for (const st of [8, 4, 2, 1]) for (let i = 0; i < F.count; i += st) if (!seen.has(i)) { seen.add(i); order.push(i); }
      let p = 0;
      const next = () => {
        if (my !== gen || p >= order.length) return;
        const i = order[p++], im = new Image(); im.decoding = 'async';
        im.onload = im.onerror = () => { if (my !== gen) return; loaded++; S.key = ''; next(); };
        im.src = src(i); imgs[i] = im;
      };
      for (let k = 0; k < 4; k++) next();
    }
    S.start = () => { if (started) return; started = true; if (S.F) load(gen); };
    const ok = im => im && im.complete && im.naturalWidth;
    function nearest(i) {
      for (let d = 0; d < S.F.count; d++) { if (ok(imgs[i - d])) return i - d; if (ok(imgs[i + d])) return i + d; }
      return -1;
    }
    function fit() {
      const d = Math.min(devicePixelRatio || 1, 2), W = Math.round(canvas.clientWidth * d), H = Math.round(canvas.clientHeight * d);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      S.key = ''; G = null;
    }
    /* «cover»; на узком экране без своих кадров (widen) — кадр в widen раз шире «contain», верх и низ растворяются в фоне */
    function geom() {
      if (G) return G;
      const F = S.F, W = canvas.width, H = canvas.height, dpr = W / Math.max(1, canvas.clientWidth);
      let s = Math.max(W / F.w, H / F.h);
      const wide = !!o.widen && !(portraitMq.matches && o.portrait) && W / H < F.w / F.h * 0.8;
      if (wide) s = Math.min(s, Math.min(W / F.w, H / F.h) * o.widen);
      return (G = { s, ox: (W - F.w * s) / 2, oy: (H - F.h * s) / 2, dpr, wide });
    }
    S.draw = pos => {       // кадр pos (дробный): соседние кадры смешиваются — движение плавное и при 72 кадрах
      const F = S.F; if (!F) return false;
      const i = Math.min(F.count - 1, Math.max(0, Math.floor(pos))), f = pos - i;
      const key = pos.toFixed(3) + '|' + canvas.width + '|' + canvas.height + '|' + loaded;
      if (key === S.key) return true;
      const a = nearest(i); if (a < 0) return false;
      const g = geom(), W = canvas.width, H = canvas.height, dw = F.w * g.s, dh = F.h * g.s;
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      if (g.wide) ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(imgs[a], g.ox, g.oy, dw, dh);
      if (f > 0.01 && a === i && i + 1 < F.count && ok(imgs[i + 1])) { ctx.globalAlpha = f; ctx.drawImage(imgs[i + 1], g.ox, g.oy, dw, dh); ctx.globalAlpha = 1; }
      if (g.wide) {
        ctx.globalCompositeOperation = 'destination-out';
        const e = dh * 0.18;
        for (const [y0, y1] of [[g.oy, g.oy + e], [g.oy + dh, g.oy + dh - e]]) {
          const gr = ctx.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = gr; ctx.fillRect(0, Math.min(y0, y1) - 1, W, e + 2);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      S.key = key; return true;
    };
    S.box = (pos, fixed) => {   // рамка объекта на кадре pos — в CSS-пикселях сцены
      const F = S.F, list = fixed || (F && F.hot); if (!F || !list) return null;
      let r = list;
      if (Array.isArray(list[0])) {
        const i = Math.min(list.length - 1, Math.max(0, Math.floor(pos))), j = Math.min(list.length - 1, i + 1), f = Math.min(1, Math.max(0, pos - i));
        r = list[i].map((v, n) => v + (list[j][n] - v) * f);
      }
      const g = geom(), k = g.s / g.dpr, ox = g.ox / g.dpr, oy = g.oy / g.dpr;
      return { x: ox + r[0] * F.w * k, y: oy + r[1] * F.h * k, w: (r[2] - r[0]) * F.w * k, h: (r[3] - r[1]) * F.h * k };
    };
    S.ready = () => loaded > 0;
    addEventListener('resize', fit);
    if (portraitMq.addEventListener) portraitMq.addEventListener('change', () => { fit(); choose(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(es => es.forEach(e => e.isIntersecting && S.start()), { rootMargin: '150% 0px' }).observe(section);
      new IntersectionObserver(es => es.forEach(e => { S.near = e.isIntersecting; }), { rootMargin: '10% 0px' }).observe(section);
    } else { S.near = true; S.start(); }
    fit(); choose();
    return S;
  }

  /* панель «Сигнал со спутника»: наведение, фокус или касание; текст «печатается» один раз, луч — от спутника к панели */
  function satPanel(panel, trigger, stage, beam, follow) {
    const items = $$('li > b, li > span', panel).map(el => ({ el, t: el.textContent }));
    const line = beam && beam.querySelector('line'), x = panel.querySelector('.x');
    let open = false, typed = reduce, hideT = 0, lastPT = '', overT = false, overP = false;
    function finish() {
      typed = true; panel.classList.remove('typing');
      items.forEach(it => { it.el.textContent = it.t; it.el.classList.remove('cur'); it.el.parentNode.classList.add('on'); });
    }
    function type() {
      if (typed || panel.classList.contains('typing')) return;
      panel.classList.add('typing'); items.forEach(it => { it.el.textContent = ''; });
      let n = 0, c = 0, last = performance.now();
      const step = now => {
        if (typed) return;
        let budget = Math.max(1, Math.round((now - last) / 8)); last = now;      // ≈125 знаков в секунду
        while (budget > 0 && n < items.length) {
          const it = items[n], take = Math.min(budget, it.t.length - c);
          c += take; budget -= take; it.el.textContent = it.t.slice(0, c);
          it.el.parentNode.classList.add('on'); it.el.classList.add('cur');
          if (c >= it.t.length) { it.el.classList.remove('cur'); n++; c = 0; }
        }
        if (n >= items.length) finish(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    function set(v) {
      if (v === open) return; open = v;
      panel.classList.toggle('open', v); trigger.setAttribute('aria-expanded', String(v));
      if (v) { position(); type(); } else if (beam) beam.classList.remove('on');
    }
    const show = () => { clearTimeout(hideT); set(true); };
    const keep = () => overT || overP || fv(trigger) || (panel.contains(document.activeElement) && fv(document.activeElement));
    const hide = ms => { clearTimeout(hideT); hideT = setTimeout(() => { if (!keep()) set(false); }, ms); };
    trigger.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { overT = true; show(); } });
    trigger.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { overT = false; hide(600); } });
    panel.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { overP = true; clearTimeout(hideT); } });
    panel.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { overP = false; hide(500); } });
    trigger.addEventListener('pointerdown', e => { lastPT = e.pointerType; });
    trigger.addEventListener('click', () => { if (lastPT === 'mouse') show(); else set(!open); lastPT = ''; });
    trigger.addEventListener('focus', () => { if (fv(trigger)) show(); });
    trigger.addEventListener('blur', () => hide(300));
    panel.addEventListener('focusin', () => clearTimeout(hideT));
    panel.addEventListener('focusout', () => hide(300));
    if (x) x.addEventListener('click', () => { set(false); trigger.focus({ preventScroll: true }); });
    addEventListener('keydown', e => { if (e.key === 'Escape' && open) set(false); });
    document.addEventListener('pointerdown', e => { if (open && !panel.contains(e.target) && !trigger.contains(e.target)) set(false); });
    function position() {       // панель «следует» за летящим спутником (кроме телефона — там нижний лист)
      if (!follow || narrowMq.matches) return;
      const tb = trigger.getBoundingClientRect(), sb = stage.getBoundingClientRect(), pw = panel.offsetWidth, ph = panel.offsetHeight;
      let px = tb.left - sb.left + tb.width / 2 - pw / 2, py = tb.bottom - sb.top + 14;
      px = Math.max(16, Math.min(sb.width - pw - 16, px));
      if (py + ph > sb.height - 16) py = Math.max(16, tb.top - sb.top - ph - 14);
      panel.style.setProperty('--px', Math.round(px) + 'px'); panel.style.setProperty('--py', Math.round(py) + 'px');
    }
    return {
      get open() { return open; },
      update() {
        if (!open || !line) return;
        if (follow) position();
        const sb = stage.getBoundingClientRect(), tb = trigger.getBoundingClientRect(), pb = panel.getBoundingClientRect();
        const cx = tb.left + tb.width / 2 - sb.left, cy = tb.top + tb.height / 2 - sb.top;
        if (!follow) panel.classList.toggle('at-left', cx > sb.width * 0.6);
        const px = Math.min(Math.max(cx, pb.left - sb.left), pb.right - sb.left), py = Math.min(Math.max(cy, pb.top - sb.top + 20), pb.bottom - sb.top - 20);
        line.setAttribute('x1', cx.toFixed(1)); line.setAttribute('y1', cy.toFixed(1));
        line.setAttribute('x2', px.toFixed(1)); line.setAttribute('y2', py.toFixed(1));
        beam.classList.add('on');
      }
    };
  }

  /* ═════════ 4. ОРБИТА: станция «пролетает» по скроллу; наведение — чем полезен геосервис ═════════ */
  function initOrbit() {
    const sec = $('#orbit'); if (!sec) return;
    const stage = sec.querySelector('.stage'), hot = sec.querySelector('.sat-hot'), caps = $$('.cap', sec);
    prepCaps(caps);
    const seq = makeSeq(sec, { folder: 'orbit/', widen: 1.6 });
    const sat = satPanel($('#sat-panel'), hot, stage, sec.querySelector('.beam'), false);
    let cur = 0;
    function tick() {
      if (seq.near && seq.F) {
        const p = progressOf(sec), target = Math.min(1, p / 0.9) * (seq.F.count - 1);
        cur += (target - cur) * (reduce ? 1 : 0.16); if (Math.abs(target - cur) < 0.002) cur = target;
        seq.draw(cur);
        const b = seq.box(cur);
        if (b) {   // на крупных планах станция занимает весь кадр — «горячая» зона не больше центральной части сцены
          const sw = stage.clientWidth, sh = stage.clientHeight, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
          const w = Math.min(b.w, sw * 0.6), h = Math.min(b.h, sh * 0.56);
          const x0 = Math.max(sw * 0.04, cx - w / 2), y0 = Math.max(sh * 0.12, cy - h / 2);
          place(hot, x0, y0, Math.min(sw * 0.96, cx + w / 2) - x0, Math.min(sh * 0.9, cy + h / 2) - y0);
        }
        hot.classList.toggle('ready', seq.ready());
        setCaps(caps, p); sat.update();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ═════════ 5. ПОСАДКА: космонавт подходит по скроллу, затем «живёт» петлёй-видео;
     наведение (фокус, касание) — слева «Зарегистрироваться», справа «Войти в геосервис» ═════════ */
  function initLanding() {
    const sec = $('#landing'); if (!sec) return;
    const stage = sec.querySelector('.stage'), video = sec.querySelector('video.loop'), hot = sec.querySelector('.astro-hot');
    const acts = $('#astro-actions'), caps = $$('.cap', sec), ARRIVE = 0.82;
    prepCaps(caps);
    let loopSrc = '', loopHot = null, cur = 0, arrived = false, open = false, hideT = 0, autoT = 0, dismissed = false, lastPT = '', fk = '';
    let overH = false, overB = false;
    const seq = makeSeq(sec, { folder: 'astro/', portrait: 'astro-m/', onManifest: F => {
      loopHot = F.loop_hot || null; loopSrc = F.loop ? MEDIA + F.loop + QV : '';
      video.classList.remove('on'); video.poster = F.path + String(F.count).padStart(F.pad, '0') + F.ext + QV;
    } });
    /* спутник над космонавтом: та же панель «чем полезен геосервис», рядом со спутником */
    let mini = null;
    const ms = sec.querySelector('.mini-sat'), tpl = $('#sat-panel'), beamTpl = $('#orbit .beam');
    if (ms && tpl) {
      const p2 = tpl.cloneNode(true); p2.id = 'sat-panel-2'; p2.classList.add('mini'); p2.classList.remove('open'); stage.appendChild(p2);
      const b2 = beamTpl ? beamTpl.cloneNode(true) : null; if (b2) { b2.classList.remove('on'); stage.appendChild(b2); }
      mini = satPanel(p2, ms, stage, b2, true);
    }
    function set(v) { if (v === open) return; open = v; acts.classList.toggle('open', v); hot.setAttribute('aria-expanded', String(v)); }
    const show = () => { clearTimeout(hideT); clearTimeout(autoT); set(true); };
    const keep = () => overH || overB || fv(hot) || (acts.contains(document.activeElement) && fv(document.activeElement));
    const hide = ms => { clearTimeout(hideT); hideT = setTimeout(() => { if (!keep()) set(false); }, ms); };
    if (reduce) set(true);
    else {
      hot.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { overH = true; show(); } });
      hot.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { overH = false; hide(900); } });
      acts.addEventListener('pointerover', e => { if (e.pointerType === 'mouse' && e.target.closest('.astro-btn')) { overB = true; clearTimeout(hideT); } });
      acts.addEventListener('pointerout', e => {
        const to = e.relatedTarget;
        if (e.pointerType === 'mouse' && !(to && to.closest && to.closest('.astro-btn'))) { overB = false; hide(700); }
      });
      hot.addEventListener('pointerdown', e => { lastPT = e.pointerType; });
      hot.addEventListener('click', () => { clearTimeout(autoT); if (lastPT === 'mouse') show(); else { if (open) dismissed = true; set(!open); } lastPT = ''; });
      hot.addEventListener('focus', () => { if (fv(hot)) show(); });
      hot.addEventListener('blur', () => hide(400));
      acts.addEventListener('focusin', () => { if (fv(document.activeElement)) show(); });
      acts.addEventListener('focusout', () => hide(400));
      addEventListener('keydown', e => { if (e.key === 'Escape' && open) { set(false); dismissed = true; } });
      document.addEventListener('pointerdown', e => {
        if (open && e.pointerType !== 'mouse' && !acts.contains(e.target) && !hot.contains(e.target)) { set(false); dismissed = true; }
      });
    }
    video.addEventListener('playing', () => { if (arrived) video.classList.add('on'); });
    function onArrive(at) {
      sec.classList.toggle('arrived', at); clearTimeout(autoT);
      if (at) {
        if (!reduce && loopSrc) { try { video.currentTime = 0; } catch (e) { /* ещё нет метаданных */ } video.play().catch(() => {}); }
        if (coarse && !reduce && !dismissed) autoT = setTimeout(() => { if (arrived) set(true); }, 2800);   // на тач-экране наведения нет
      } else {
        video.classList.remove('on'); if (!video.paused) video.pause();
      }
    }
    function tick() {
      const F = seq.F;
      if (seq.near && F) {
        const p = progressOf(sec), target = Math.min(1, p / ARRIVE) * (F.count - 1);
        cur += (target - cur) * (reduce ? 1 : 0.16); if (Math.abs(target - cur) < 0.002) cur = target;
        if (!reduce && loopSrc && p > 0.4 && video.dataset.src !== loopSrc) { video.preload = 'auto'; video.src = loopSrc; video.dataset.src = loopSrc; }
        const at = p >= ARRIVE && cur >= F.count - 1.02;
        if (at !== arrived) { arrived = at; onArrive(at); }
        const vid = arrived && video.classList.contains('on');
        if (!vid) seq.draw(cur);
        const b = vid && loopHot ? seq.box(0, loopHot) : seq.box(cur);
        if (b) {
          place(hot, b.x, b.y, b.w, b.h);
          const k = Math.round(b.x) + ',' + Math.round(b.x + b.w) + ',' + Math.round(b.y + b.h * 0.42);
          if (k !== fk) {
            fk = k; acts.style.setProperty('--fx', Math.round(b.x) + 'px');
            acts.style.setProperty('--fr', Math.round(b.x + b.w) + 'px'); acts.style.setProperty('--fy', Math.round(b.y + b.h * 0.42) + 'px');
          }
        }
        hot.classList.toggle('ready', seq.ready());
        setCaps(caps, p);
        if (mini) mini.update();
      } else if (!video.paused) video.pause();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    /* «Регистрация» в шапке ведёт сразу к прибывшему космонавту */
    $$('a[href="#landing"]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const top = sec.getBoundingClientRect().top + scrollY + (sec.offsetHeight - innerHeight) * 0.88;
      scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    }));
  }

  /* ═════════ 6. карточки: подсветка под курсором и появление ═════════ */
  function initCards() {
    $$('.card').forEach(c => c.addEventListener('pointermove', e => {
      const b = c.getBoundingClientRect();
      c.style.setProperty('--mx', (e.clientX - b.left) + 'px'); c.style.setProperty('--my', (e.clientY - b.top) + 'px');
    }));
    const els = $$('[data-reveal]');
    if (reduce || !('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('in')); return; }
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }),
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(el => io.observe(el));
  }

  initHero(); initStory(); initOrbit(); initLanding(); initCards();
})();
