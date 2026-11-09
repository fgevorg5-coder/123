/* ============================================================
   header-scene.js v21 — анимированная сцена шапки ОДЗиМЛ
   ------------------------------------------------------------
   • Три плана хвойного леса (ели и сосны) с кроной из ярусов,
     стволами и покачиванием на ветру (порывы бегут волной).
   • Спутник ДЗЗ: корпус в золотой ЭВТИ-фольге, панели солнечных
     батарей с бликом, антенна, объектив, проблесковые огни.
   • Луч сканирования: деревья под линией подсвечиваются,
     к спутнику уходят «пакеты данных». Сезоны: снег, листья, птицы.
   [v21] Сцена рисуется в ОТДЕЛЬНОМ ПОТОКЕ (Web Worker + OffscreenCanvas):
     масштабирование и перетаскивание карты больше не останавливают
     и не «дёргают» шапку — основной поток занят картой, а шапка
     продолжает идти ровно (до 30 кадров/с, на слабом ПК 20/15).
   [v21] Непрерывные часы сцены: после любой паузы (скрытая вкладка,
     шапка вне экрана) анимация продолжается с того же места — без
     скачка спутника и деревьев (раньше время бралось «с часов»).
   Если браузер не умеет OffscreenCanvas — прежний режим в основном
   потоке (пауза на время движения карты, но тоже без рывка).
   Принудительно основной поток: адрес ?hs=main или window.HS_NO_WORKER=true.
   Диагностика: HeaderScene.getState() / await HeaderScene.refresh().
   Один и тот же файл работает и на странице, и внутри Worker.
   ============================================================ */
(function () {
    'use strict';

    var IN_WORKER = typeof document === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function';
    var perfNow = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };

    // Детерминированный ГПСЧ — лес одинаковый при каждой загрузке
    function rng(seed) {
        return function () {
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    // Палитры планов: [r,g,b] кроны, ствол, альфа
    var ROWS = [
        { base: 0.80, hMin: 13, hMax: 22, gap: 7,  col: [22, 74, 34],  hi: [40, 110, 52], trunk: '#2a1d10', alpha: 0.55, amp: 0.6 },
        { base: 0.93, hMin: 20, hMax: 33, gap: 11, col: [26, 92, 40],  hi: [58, 140, 66], trunk: '#3a2614', alpha: 0.78, amp: 1.0 },
        { base: 1.04, hMin: 30, hMax: 46, gap: 17, col: [16, 66, 28],  hi: [64, 150, 70], trunk: '#4a3018', alpha: 0.95, amp: 1.5 }
    ];
    var SCAN_RGB = [178, 255, 120];

    // ── СЕЗОНЫ: весна / лето / осень / зима (настройка администратора, /api/season) ──
    var SEASONS = ['spring', 'summer', 'autumn', 'winter'];
    function byMonth() { var m = new Date().getMonth(); return m < 2 || m === 11 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'autumn'; }
    function normS(v) { return SEASONS.indexOf(v) >= 0 ? v : null; }
    // Осенние цвета макушек
    var AUTUMN = [[233, 178, 60], [217, 130, 43], [240, 203, 78], [207, 106, 42], [196, 160, 52]];

    // ════════════════════════════════════════════════════════════
    //  ЯДРО СЦЕНЫ — без DOM: работает с любым 2D-контекстом
    //  (обычный <canvas> в странице или OffscreenCanvas в потоке)
    // ════════════════════════════════════════════════════════════
    function createScene(ctx, opt) {
        opt = opt || {};
        var W = 0, H = 0, DPR = 1;
        var trees = [], ridge = [], foil = [], packets = [];
        var season = normS(opt.season) || byMonth();
        var reduceMotion = !!opt.reduceMotion;
        var flakes = [], leaves = [], birds = [], nextFlock = 0;
        var sceneT = +opt.t0 || 0, drawCount = 0, costAvg = 0;
        function windK() { return season === 'autumn' ? 2.1 : season === 'winter' ? 0.7 : 1; }

        function build() {
            var r = rng(20240917);
            trees = [];
            ROWS.forEach(function (row, ri) {
                var x = -6 + r() * row.gap;
                while (x < W + 8) {
                    var h = row.hMin + r() * (row.hMax - row.hMin);
                    var pine = ri > 0 && r() < 0.22;
                    trees.push({
                        row: ri, x: x, base: H * row.base, h: h,
                        w: h * (pine ? 0.5 : 0.40 + r() * 0.08),
                        pine: pine,
                        tiers: 4 + Math.floor(r() * 3),
                        phase: r() * Math.PI * 2,
                        speed: 0.8 + r() * 0.5,
                        lean: (r() - 0.5) * 0.6,
                        scan: 0, pinged: 0,
                        yel: r() < 0.62 ? AUTUMN[Math.floor(r() * AUTUMN.length)] : null,
                        yelTiers: 1 + Math.floor(r() * 3)
                    });
                    x += row.gap * (0.65 + r() * 0.7);
                }
            });
            // Дальняя линия холмов
            ridge = [];
            for (var i = 0; i <= 40; i++) {
                var px = i / 40 * W;
                ridge.push([px, H * 0.70 - 5 * Math.sin(px * 0.021 + 1.3) - 3 * Math.sin(px * 0.057) - 2 * Math.sin(px * 0.13 + 2)]);
            }
            // «Морщины» фольги на корпусе спутника
            var fr = rng(77);
            foil = [];
            for (var k = 0; k < 9; k++) foil.push([fr() * 10 - 5, fr() * 12 - 6, fr() * 10 - 5, fr() * 12 - 6, 0.25 + fr() * 0.4]);
        }
        function mix(a, b, k) {
            return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k) + ',' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ')';
        }

        // ── Деревья ─────────────────────────────────────────────
        function swayAt(tr, time) {
            var row = ROWS[tr.row];
            var gust = Math.max(0, Math.sin(time * 0.00035 - tr.x * 0.012)) ; // порыв бежит слева направо
            var wk = windK();
            return row.amp * (Math.sin(time * 0.0016 * tr.speed * (wk > 1 ? 1.35 : 1) + tr.phase) * 0.9 * Math.sqrt(wk) + gust * gust * 2.2 * wk) + tr.lean + (wk > 1 ? row.amp * 0.8 : 0);
        }

        function drawSpruce(tr, sway) {
            var row = ROWS[tr.row];
            var cx = tr.x, b = tr.base, h = tr.h, hw = tr.w / 2;
            var k = tr.scan;
            var body = mix(row.col, SCAN_RGB, k * 0.62);
            var lite = mix(row.hi, [220, 255, 190], k * 0.8);
            // Ствол
            var trunkTop = b - h * 0.22;
            ctx.fillStyle = row.trunk;
            ctx.beginPath();
            ctx.moveTo(cx - tr.w * 0.05, b);
            ctx.lineTo(cx + tr.w * 0.05, b);
            ctx.lineTo(cx + tr.w * 0.03 + sway * 0.15, trunkTop);
            ctx.lineTo(cx - tr.w * 0.03 + sway * 0.15, trunkTop);
            ctx.closePath(); ctx.fill();
            // Ярусы кроны — снизу вверх, каждый с опущенными «лапами»
            var n = tr.tiers, crownH = h * 0.86, step = crownH / n;
            for (var i = 0; i < n; i++) {
                var f = i / n;
                var yb = b - h * 0.14 - i * step;
                var th = step * 1.75;
                var w = hw * (1 - f * 0.78);
                var bend = sway * Math.pow((b - yb) / h, 1.6);
                var bendTop = sway * Math.pow((b - yb + th) / h, 1.6);
                var x0 = cx + bend, xt = cx + bendTop;
                var tierBody = body, tierLite = lite;
                if (season === 'autumn' && tr.yel && i >= n - tr.yelTiers) {
                    var ak = 0.55 + 0.4 * ((i - (n - tr.yelTiers)) / tr.yelTiers);
                    tierBody = mix(row.col, tr.yel, ak); tierLite = mix(row.hi, [255, 226, 120], ak);
                } else if (season === 'spring') {
                    tierBody = mix(row.col, [70, 170, 70], 0.28); tierLite = mix(row.hi, [150, 230, 120], 0.35);
                } else if (season === 'winter') {
                    tierBody = mix(row.col, [30, 60, 52], 0.35);
                }
                ctx.fillStyle = tierBody;
                ctx.beginPath();
                ctx.moveTo(xt, yb - th);
                ctx.quadraticCurveTo(x0 + w * 0.30, yb - th * 0.45, x0 + w, yb + 1.2);
                ctx.lineTo(x0 + w * 0.55, yb - th * 0.06);
                ctx.lineTo(x0 + w * 0.30, yb + 0.8);
                ctx.lineTo(x0, yb - th * 0.08);
                ctx.lineTo(x0 - w * 0.30, yb + 0.8);
                ctx.lineTo(x0 - w * 0.55, yb - th * 0.06);
                ctx.lineTo(x0 - w, yb + 1.2);
                ctx.quadraticCurveTo(x0 - w * 0.30, yb - th * 0.45, xt, yb - th);
                ctx.closePath(); ctx.fill();
                // Освещённая (левая) сторона яруса
                ctx.fillStyle = tierLite;
                ctx.globalAlpha *= 0.55;
                ctx.beginPath();
                ctx.moveTo(xt, yb - th);
                ctx.quadraticCurveTo(x0 - w * 0.30, yb - th * 0.45, x0 - w, yb + 1.2);
                ctx.lineTo(x0 - w * 0.55, yb - th * 0.06);
                ctx.quadraticCurveTo(x0 - w * 0.18, yb - th * 0.40, xt, yb - th);
                ctx.closePath(); ctx.fill();
                ctx.globalAlpha /= 0.55;
                if (season === 'winter') {
                    // Снег, лежащий на ярусе: шапка сверху + белая кромка «лап»
                    ctx.fillStyle = 'rgba(244,250,255,0.95)';
                    ctx.beginPath();
                    ctx.moveTo(xt, yb - th - 0.6);
                    ctx.quadraticCurveTo(x0 + w * 0.22, yb - th * 0.55, x0 + w * 0.78, yb - th * 0.02);
                    ctx.quadraticCurveTo(x0 + w * 0.45, yb - th * 0.12, x0 + w * 0.2, yb - th * 0.26);
                    ctx.quadraticCurveTo(x0, yb - th * 0.18, x0 - w * 0.2, yb - th * 0.28);
                    ctx.quadraticCurveTo(x0 - w * 0.45, yb - th * 0.12, x0 - w * 0.78, yb - th * 0.02);
                    ctx.quadraticCurveTo(x0 - w * 0.22, yb - th * 0.55, xt, yb - th - 0.6);
                    ctx.closePath(); ctx.fill();
                }
            }
        }

        function drawPine(tr, sway) {
            var row = ROWS[tr.row];
            var cx = tr.x, b = tr.base, h = tr.h;
            var k = tr.scan;
            var body = mix(row.col, SCAN_RGB, k * 0.62);
            var lite = mix(row.hi, [220, 255, 190], k * 0.8);
            var topX = cx + sway * 1.1, topY = b - h * 0.72;
            // Высокий ствол сосны (рыжеватый)
            ctx.strokeStyle = tr.row === 2 ? '#6b4423' : '#4f331b';
            ctx.lineWidth = Math.max(1, tr.w * 0.09);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(cx, b);
            ctx.quadraticCurveTo(cx + sway * 0.3, b - h * 0.4, topX, topY);
            ctx.stroke();
            // Ветви
            ctx.lineWidth = Math.max(0.6, tr.w * 0.04);
            ctx.beginPath();
            ctx.moveTo(topX - sway * 0.1, topY + h * 0.08); ctx.lineTo(topX - tr.w * 0.38, topY - h * 0.02);
            ctx.moveTo(topX, topY + h * 0.02); ctx.lineTo(topX + tr.w * 0.36, topY - h * 0.08);
            ctx.stroke();
            // Крона — несколько «облаков» хвои
            var blobs = [[0, -0.12, 0.34, 0.11], [-0.32, -0.02, 0.24, 0.08], [0.32, -0.08, 0.24, 0.08], [0.05, -0.22, 0.24, 0.08]];
            for (var i = 0; i < blobs.length; i++) {
                var bl = blobs[i];
                var bx = topX + bl[0] * tr.w + sway * 0.25, by = topY + bl[1] * h;
                var pb = body, pl = lite;
                if (season === 'autumn' && tr.yel && (i === 0 || i === 3)) { pb = mix(row.col, tr.yel, 0.7); pl = mix(row.hi, [255, 226, 120], 0.7); }
                else if (season === 'spring') { pb = mix(row.col, [70, 170, 70], 0.28); pl = mix(row.hi, [150, 230, 120], 0.35); }
                ctx.fillStyle = pb;
                ctx.beginPath(); ctx.ellipse(bx, by, bl[2] * tr.w, bl[3] * h, 0, 0, Math.PI * 2); ctx.fill();
                if (season === 'winter') {
                    ctx.save(); ctx.globalAlpha *= 0.95; ctx.fillStyle = '#f4faff';
                    ctx.beginPath(); ctx.ellipse(bx, by - bl[3] * h * 0.45, bl[2] * tr.w * 0.85, bl[3] * h * 0.5, 0, Math.PI, Math.PI * 2); ctx.fill();
                    ctx.restore();
                }
                ctx.fillStyle = pl;
                ctx.globalAlpha *= 0.5;
                ctx.beginPath(); ctx.ellipse(bx - bl[2] * tr.w * 0.25, by - bl[3] * h * 0.35, bl[2] * tr.w * 0.6, bl[3] * h * 0.45, 0, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha /= 0.5;
            }
        }

        // ── Спутник ─────────────────────────────────────────────
        function drawPanel(x, y, w, h, time, dir) {
            var g = ctx.createLinearGradient(x, y, x, y + h);
            g.addColorStop(0, '#16336b'); g.addColorStop(0.5, '#2457a6'); g.addColorStop(1, '#0e2550');
            ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
            // Сетка ячеек
            ctx.strokeStyle = 'rgba(150,190,240,0.45)'; ctx.lineWidth = 0.4;
            ctx.beginPath();
            var cols = Math.max(3, Math.round(w / 3.2));
            for (var c = 1; c < cols; c++) { var cx = x + w * c / cols; ctx.moveTo(cx, y); ctx.lineTo(cx, y + h); }
            for (var r = 1; r < 3; r++) { var ry = y + h * r / 3; ctx.moveTo(x, ry); ctx.lineTo(x + w, ry); }
            ctx.stroke();
            // Солнечный блик пробегает по панели
            var p = ((time * 0.00025 + (dir > 0 ? 0 : 0.5)) % 1);
            var gx = x - w * 0.4 + p * w * 1.8;
            var gl = ctx.createLinearGradient(gx - 4, y, gx + 4, y + h);
            gl.addColorStop(0, 'rgba(255,255,255,0)'); gl.addColorStop(0.5, 'rgba(210,235,255,0.55)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
            ctx.fillStyle = gl; ctx.fillRect(gx - 5, y, 10, h);
            ctx.restore();
            // Рамка
            ctx.strokeStyle = '#a9b8c9'; ctx.lineWidth = 0.6; ctx.strokeRect(x, y, w, h);
        }

        function drawSatellite(x, y, time, tilt, dir) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(tilt);
            // Тень/свечение
            ctx.shadowColor = 'rgba(130,233,56,0.35)'; ctx.shadowBlur = 6;
            // Штанги панелей
            ctx.strokeStyle = '#b8c4cf'; ctx.lineWidth = 0.9;
            ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(-9.5, 0); ctx.moveTo(5, 0); ctx.lineTo(9.5, 0); ctx.stroke();
            ctx.shadowBlur = 0;
            // Панели (по две секции на крыло)
            drawPanel(-30, -4.5, 9.8, 9, time, dir);  drawPanel(-19.8, -4.5, 9.8, 9, time + 400, dir);
            drawPanel(10, -4.5, 9.8, 9, time + 800, dir); drawPanel(20.2, -4.5, 9.8, 9, time + 1200, dir);
            // Корпус — золотая фольга ЭВТИ
            var g = ctx.createLinearGradient(-5, -6, 5, 6);
            g.addColorStop(0, '#fbe08a'); g.addColorStop(0.35, '#d19a2a'); g.addColorStop(0.6, '#f0c25a'); g.addColorStop(1, '#8a5a12');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.rect(-5, -6, 10, 12); ctx.fill();
            ctx.strokeStyle = 'rgba(255,240,190,0.6)'; ctx.lineWidth = 0.35;
            ctx.beginPath();
            for (var i = 0; i < foil.length; i++) { var f = foil[i]; ctx.moveTo(f[0], f[1]); ctx.lineTo(f[2], f[3]); }
            ctx.stroke();
            ctx.strokeStyle = '#7a5210'; ctx.lineWidth = 0.5; ctx.strokeRect(-5, -6, 10, 12);
            // Белый радиатор сверху
            ctx.fillStyle = '#e6edf2'; ctx.fillRect(-5, -8, 10, 2.2);
            ctx.strokeStyle = '#9aa7b2'; ctx.lineWidth = 0.3; ctx.strokeRect(-5, -8, 10, 2.2);
            // Антенна-тарелка сбоку
            ctx.strokeStyle = '#cfd8df'; ctx.lineWidth = 0.6;
            ctx.beginPath(); ctx.moveTo(3, -8); ctx.lineTo(5.5, -11.5); ctx.stroke();
            ctx.fillStyle = '#eef3f6';
            ctx.beginPath(); ctx.ellipse(6.2, -12.4, 2.8, 1.1, -0.5, 0, Math.PI * 2); ctx.fill();
            // Объектив сенсора снизу
            ctx.fillStyle = '#2b3138'; ctx.fillRect(-2.6, 6, 5.2, 2.2);
            ctx.fillStyle = '#0b0f14';
            ctx.beginPath(); ctx.arc(0, 8.6, 1.9, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(160,255,120,0.9)';
            ctx.beginPath(); ctx.arc(-0.5, 8.1, 0.6, 0, Math.PI * 2); ctx.fill();
            // Проблесковые огни
            var blink = (time % 1600) < 120;
            ctx.fillStyle = blink ? '#ff5050' : 'rgba(255,80,80,0.25)';
            ctx.beginPath(); ctx.arc(-30.5, 0, 0.9, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = ((time + 800) % 1600) < 120 ? '#6dff7a' : 'rgba(109,255,122,0.25)';
            ctx.beginPath(); ctx.arc(30.5, 0, 0.9, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }

        // ── Кадр ────────────────────────────────────────────────
        var SAT_PERIOD = 26000, SAT_FLY = 20000;

        function satState(time) {
            var cyc = Math.floor(time / SAT_PERIOD), local = time % SAT_PERIOD;
            if (local > SAT_FLY) return null;
            var p = local / SAT_FLY;
            var e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // плавный старт/финиш
            e = 0.15 * p + 0.85 * e;
            var dir = (cyc % 2 === 0) ? 1 : -1;
            var x = dir > 0 ? -40 + (W + 80) * e : W + 40 - (W + 80) * e;
            return { x: x, y: 15 + 2.5 * Math.sin(p * Math.PI * 3), tilt: 0.06 * Math.sin(p * Math.PI * 2) * dir, p: p, dir: dir };
        }
        // Один кадр. dt — сколько мс прошло с прошлого кадра (0 — перерисовать как есть).
        // Время сцены — собственные непрерывные часы (sceneT), а не performance.now().
        function draw(dt) {
            dt = dt > 0 ? Math.min(100, dt) : 0;
            sceneT += dt; drawCount++;
            var now = sceneT, tCost0 = perfNow();
            var time = reduceMotion ? 6000 : now;

            ctx.clearRect(0, 0, W, H);

            // Дальние холмы + туман
            ctx.fillStyle = season === 'winter' ? 'rgba(170,196,205,0.42)' : season === 'autumn' ? 'rgba(52,48,18,0.55)' : 'rgba(14,44,20,0.55)';
            ctx.beginPath(); ctx.moveTo(0, H);
            for (var i = 0; i < ridge.length; i++) ctx.lineTo(ridge[i][0], ridge[i][1]);
            ctx.lineTo(W, H); ctx.closePath(); ctx.fill();

            var sat = satState(time);
            var groundY = H * 0.86;
            var scanX = null, footL = 0, footR = 0;
            if (sat) {
                var half = 22;
                footL = sat.x - half; footR = sat.x + half;
                // Поперечная линия сканирования внутри пятна
                scanX = sat.x + Math.sin(time * 0.006) * half * 0.95;
            }

            // Деревья по планам; затухание подсветки
            var decay = Math.exp(-dt / 1400);
            for (var r = 0; r < ROWS.length; r++) {
                ctx.globalAlpha = ROWS[r].alpha;
                if (r === 1) {
                    // Туман между планами
                    var mg = ctx.createLinearGradient(0, H * 0.62, 0, H);
                    mg.addColorStop(0, 'rgba(120,200,120,0)'); mg.addColorStop(1, 'rgba(60,140,70,0.10)');
                    ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = mg; ctx.fillRect(0, H * 0.62, W, H * 0.38); ctx.restore();
                }
                for (var j = 0; j < trees.length; j++) {
                    var tr = trees[j];
                    if (tr.row !== r) continue;
                    tr.scan *= decay;
                    if (sat && scanX !== null && Math.abs(tr.x - scanX) < 3.5 + tr.w * 0.3) {
                        tr.scan = Math.min(1, tr.scan + 0.6);
                        if (!reduceMotion && now - tr.pinged > 900 && packets.length < 24 && tr.row > 0) {
                            tr.pinged = now;
                            packets.push({ x: tr.x, y: tr.base - tr.h * 0.7, t: 0 });
                        }
                    } else if (sat && tr.x > footL && tr.x < footR) {
                        tr.scan = Math.max(tr.scan, 0.18);
                    }
                    var sw = reduceMotion ? tr.lean : swayAt(tr, time);
                    if (tr.pine) drawPine(tr, sw); else drawSpruce(tr, sw);
                }
            }
            ctx.globalAlpha = 1;

            if (sat) {
                var sx = sat.x, sy = sat.y + 9;
                var fade = Math.min(1, sat.p * 8, (1 - sat.p) * 8);
                // Конус луча
                var cg = ctx.createLinearGradient(0, sy, 0, groundY);
                cg.addColorStop(0, 'rgba(190,255,150,' + (0.30 * fade) + ')');
                cg.addColorStop(1, 'rgba(130,233,56,' + (0.05 * fade) + ')');
                ctx.fillStyle = cg;
                ctx.beginPath(); ctx.moveTo(sx - 1.5, sy); ctx.lineTo(sx + 1.5, sy); ctx.lineTo(footR, groundY); ctx.lineTo(footL, groundY); ctx.closePath(); ctx.fill();
                // Пятно на земле
                var eg = ctx.createRadialGradient(sx, groundY, 2, sx, groundY, 26);
                eg.addColorStop(0, 'rgba(170,255,110,' + (0.28 * fade) + ')'); eg.addColorStop(1, 'rgba(130,233,56,0)');
                ctx.fillStyle = eg;
                ctx.beginPath(); ctx.ellipse(sx, groundY, 26, 5, 0, 0, Math.PI * 2); ctx.fill();
                // Линия сканирования
                ctx.strokeStyle = 'rgba(210,255,170,' + (0.85 * fade) + ')';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(scanX, groundY); ctx.stroke();
                ctx.fillStyle = 'rgba(230,255,200,' + fade + ')';
                ctx.beginPath(); ctx.arc(scanX, groundY, 1.4, 0, Math.PI * 2); ctx.fill();
                // Кольцевой «пинг» пятна
                var ping = (time % 1800) / 1800;
                ctx.strokeStyle = 'rgba(160,255,106,' + (0.5 * (1 - ping) * fade) + ')';
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.ellipse(sx, groundY, 4 + ping * 22, 1 + ping * 4.5, 0, 0, Math.PI * 2); ctx.stroke();
            }

            // Пакеты данных: от подсвеченных деревьев к спутнику
            for (var q = packets.length - 1; q >= 0; q--) {
                var pk = packets[q];
                pk.t += dt / 700;
                if (!sat || pk.t >= 1) { packets.splice(q, 1); continue; }
                var tx = sat.x, ty = sat.y + 9;
                var px = pk.x + (tx - pk.x) * pk.t, py = pk.y + (ty - pk.y) * pk.t;
                ctx.fillStyle = 'rgba(200,255,160,' + (1 - pk.t * 0.6) + ')';
                ctx.fillRect(px - 0.9, py - 0.9, 1.8, 1.8);
            }

            if (sat) drawSatellite(sat.x, sat.y, time, sat.tilt, sat.dir);
            if (!reduceMotion) drawSeasonFx(dt, time);
            var cost = perfNow() - tCost0;
            costAvg = costAvg ? costAvg * 0.92 + cost * 0.08 : cost;
            return cost;
        }

        // ── Сезонные частицы: снег, листья, перелётные птицы ──
        function drawSeasonFx(dt, time) {
            var k = dt / 16.7, i, p;
            if (season === 'winter') {
                var want = Math.round(W / 9);
                while (flakes.length < want) flakes.push({ x: Math.random() * W, y: Math.random() * H - (flakes.length > want / 2 ? H : 0), r: 0.6 + Math.random() * 1.5, v: 0.25 + Math.random() * 0.5, ph: Math.random() * 6.28 });
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                for (i = 0; i < flakes.length; i++) {
                    p = flakes[i];
                    p.y += p.v * k * (0.6 + p.r * 0.4); p.x += Math.sin(time * 0.001 + p.ph) * 0.25 * k - 0.08 * k;
                    if (p.y > H + 2) { p.y = -3; p.x = Math.random() * W; }
                    if (p.x < -3) p.x = W + 2;
                    ctx.globalAlpha = 0.55 + p.r * 0.25;
                    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
                }
                ctx.globalAlpha = 1;
            } else if (season === 'autumn') {
                var wantL = Math.round(W / 30);
                while (leaves.length < wantL) leaves.push({ x: Math.random() * W, y: Math.random() * H, s: 1.8 + Math.random() * 2, v: 0.3 + Math.random() * 0.5, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.12, c: AUTUMN[Math.floor(Math.random() * AUTUMN.length)], ph: Math.random() * 6.28 });
                for (i = 0; i < leaves.length; i++) {
                    p = leaves[i];
                    var gust = 1 + 1.4 * Math.max(0, Math.sin(time * 0.00035 - p.x * 0.012));
                    p.x += (0.9 * gust + Math.sin(time * 0.002 + p.ph) * 0.4) * k; p.y += (p.v + Math.sin(time * 0.003 + p.ph) * 0.25) * k; p.rot += p.vr * k * gust;
                    if (p.x > W + 6 || p.y > H + 6) { p.x = -6 - Math.random() * 40; p.y = Math.random() * H * 0.8; }
                    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(time * 0.004 + p.ph)));
                    ctx.fillStyle = 'rgb(' + p.c[0] + ',' + p.c[1] + ',' + p.c[2] + ')';
                    ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, Math.PI * 2); ctx.fill();
                    ctx.restore();
                }
            } else if (season === 'spring') {
                if (time > nextFlock && birds.length < 14) {
                    var n = 3 + Math.floor(Math.random() * 5), y0 = H * (0.12 + Math.random() * 0.3), dir = Math.random() < 0.5 ? 1 : -1, sp = 0.7 + Math.random() * 0.5;
                    for (i = 0; i < n; i++) {
                        var row2 = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
                        birds.push({ x: (dir > 0 ? -20 : W + 20) - dir * row2 * 9, y: y0 + side * row2 * 5, v: sp * dir, ph: Math.random() * 6.28, s: 2.6 + Math.random() * 0.8 });
                    }
                    nextFlock = time + 5000 + Math.random() * 7000;
                }
                ctx.strokeStyle = 'rgba(236,246,226,0.9)'; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
                for (i = birds.length - 1; i >= 0; i--) {
                    p = birds[i];
                    p.x += p.v * k; p.y += Math.sin(time * 0.002 + p.ph) * 0.08 * k;
                    if (p.x < -40 || p.x > W + 40) { birds.splice(i, 1); continue; }
                    var f = Math.sin(time * 0.012 + p.ph) * p.s * 0.7;
                    ctx.beginPath(); ctx.moveTo(p.x - p.s, p.y - f); ctx.quadraticCurveTo(p.x - p.s * 0.4, p.y - f * 0.3 - 0.6, p.x, p.y);
                    ctx.quadraticCurveTo(p.x + p.s * 0.4, p.y - f * 0.3 - 0.6, p.x + p.s, p.y - f); ctx.stroke();
                }
            }
        }
        function resize(w, h, dpr) {
            w = Math.max(1, Math.round(w || 1)); h = Math.max(1, Math.round(h || 1));
            dpr = Math.min(Math.max(+dpr || 1, 1), 2);
            var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
            if (w === W && h === H && dpr === DPR && ctx.canvas.width === pw && ctx.canvas.height === ph) return false;
            W = w; H = h; DPR = dpr;
            ctx.canvas.width = pw; ctx.canvas.height = ph;
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
            build();
            return true;
        }
        function setSeason(v) {
            v = normS(v) || byMonth();
            if (v === season) return false;
            season = v; flakes = []; leaves = []; birds = []; nextFlock = 0;
            return true;
        }
        return {
            resize: resize, draw: draw, setSeason: setSeason,
            getSeason: function () { return season; },
            setReduce: function (v) { reduceMotion = !!v; },
            costAvg: function () { return costAvg; },
            time: function () { return sceneT; },
            stats: function () {
                return { draws: drawCount, trees: trees.length, width: W, height: H, dpr: DPR,
                         cost: Math.round(costAvg * 100) / 100, t: Math.round(sceneT), season: season };
            }
        };
    }

    // ════════════════════════════════════════════════════════════
    //  РЕЖИМ ПОТОКА (Web Worker): кадры не зависят от основного потока
    // ════════════════════════════════════════════════════════════
    if (IN_WORKER) {
        var wScene = null, wRun = false, wRaf = 0, wLastT = 0, wLastDraw = 0;
        var W_FAST = 1000 / 30, W_MID = 1000 / 20, W_SLOW = 1000 / 15, wFrameMs = W_FAST;
        var wFrames = 0, wFpsT0 = 0, wFps = 0;
        var hasRaf = typeof self.requestAnimationFrame === 'function';
        var wReq = hasRaf ? function (f) { return self.requestAnimationFrame(f); }
                          : function (f) { return setTimeout(function () { f(perfNow()); }, 1000 / 60); };
        var wCancel = hasRaf ? function (id) { self.cancelAnimationFrame(id); } : function (id) { clearTimeout(id); };
        var post = function (m) { try { self.postMessage(m); } catch (e) {} };
        var wStats = function () {
            if (!wScene) return;
            var s = wScene.stats();
            s.fps = Math.round(1000 / wFrameMs); s.fpsReal = wRun ? wFps : 0; s.running = wRun; s.raf = hasRaf;
            post({ t: 'stats', s: s });
        };
        var wLoop = function () {
            wRaf = 0;
            if (!wRun || !wScene) return;
            wRaf = wReq(wLoop);
            var now = perfNow();
            if (wLastDraw && now - wLastDraw < wFrameMs - 2) return;
            var dt = wLastT ? now - wLastT : 16;
            wLastT = now; wLastDraw = now;
            try { wScene.draw(dt); }
            catch (err) { wRun = false; post({ t: 'fail', why: 'draw: ' + (err && err.message || err) }); return; }
            wFrames++;
            // адаптация к слабому ПК: дорогой кадр → реже рисуем
            var ca = wScene.costAvg();
            wFrameMs = ca > 14 ? W_SLOW : ca > 8 ? W_MID : ca < 5 ? W_FAST : wFrameMs;
            if (now - wFpsT0 >= 1000) { wFps = Math.round(wFrames * 1000 / (now - wFpsT0)); wFrames = 0; wFpsT0 = now; wStats(); }
        };
        var wSetRun = function (on) {
            on = !!on;
            if (on === wRun) return;
            wRun = on;
            if (on) { wLastT = 0; wLastDraw = 0; wFrames = 0; wFpsT0 = perfNow(); if (!wRaf) wRaf = wReq(wLoop); }
            else { if (wRaf) wCancel(wRaf); wRaf = 0; wFps = 0; wStats(); }
        };
        self.onmessage = function (e) {
            var m = e.data || {};
            try {
                if (m.t === 'init') {
                    var c = m.canvas, cx = c && c.getContext ? c.getContext('2d') : null;
                    if (!cx) { post({ t: 'fail', why: 'no-2d' }); return; }
                    wScene = createScene(cx, { season: m.season, reduceMotion: m.reduce, t0: m.t0 });
                    wScene.resize(m.w, m.h, m.dpr);
                    wScene.draw(0);
                    post({ t: 'ready' });
                    wStats();
                    wSetRun(m.run);
                    return;
                }
                if (!wScene) return;
                if (m.t === 'size') { if (wScene.resize(m.w, m.h, m.dpr)) wScene.draw(0); }
                else if (m.t === 'run') wSetRun(m.on);
                else if (m.t === 'season') { if (wScene.setSeason(m.v) && !wRun) wScene.draw(0); }
                else if (m.t === 'reduce') { wScene.setReduce(m.on); if (!wRun) wScene.draw(0); }
                else if (m.t === 'redraw') { if (!wRun) wScene.draw(0); }
                else if (m.t === 'stats') wStats();
                else if (m.t === 'crash') throw new Error('проверка резервного режима');
                else if (m.t === 'block') { var t1 = perfNow() + (+m.ms || 0); while (perfNow() < t1) { /* тест */ } }
            } catch (err) { post({ t: 'fail', why: String(err && err.message || err) }); }
        };
        return;
    }

    // ════════════════════════════════════════════════════════════
    //  ОСНОВНОЙ ПОТОК (страница)
    // ════════════════════════════════════════════════════════════
    var cv = document.getElementById('fh-scene-canvas');
    if (!cv || !cv.getContext) return;
    var SELF_SRC = (document.currentScript && document.currentScript.src) || '';
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduceMotion = !!(mq && mq.matches);
    var enabled = document.documentElement.getAttribute('data-gs-motion') !== 'off';

    function initialSeason() {
        var v = normS((document.documentElement.getAttribute('data-season') || '').trim());
        if (v) return v;
        try { if (window.ForestSeason && normS(window.ForestSeason.get())) return window.ForestSeason.get(); } catch (e) {}
        try { var c = JSON.parse(localStorage.getItem('forest_season') || 'null'); if (c && normS(c.effective)) return c.effective; } catch (e) {}
        return byMonth();
    }
    var season = initialSeason();
    var visible = true, bootHold = true, mapBusy = false, manualStop = false, running = false;
    var mode = 'init', why = '';                 // 'worker' | 'main'
    var worker = null, wReady = false, lastStats = null, wTimer = 0, waiters = [];
    var scene = null, rafId = 0, lastT = 0, lastDraw = 0, mFrames = 0, mFpsT0 = 0, mFps = 0;
    // [v18 PERF] в основном потоке — 20 кадров/с, на медленном ПК 12
    var FRAME_FAST = 1000 / 20, FRAME_SLOW = 1000 / 12, FRAME_MS = FRAME_FAST;
    var size = { w: 0, h: 0, dpr: 0 };
    var T0 = Math.min(Math.max(perfNow(), 1500), 9000);   // стартовая фаза: спутник сразу в кадре
    var ro = null, io = null, dprMq = null;

    function header() { return cv.closest ? cv.closest('.forest-header') : null; }
    function markSeason() {
        var h = header();
        if (h) h.className = h.className.replace(/\bfh-s-\w+/g, '').replace(/\s+/g, ' ').trim() + ' fh-s-' + season;
    }
    function wantRun() {
        return !manualStop && !document.hidden && visible && enabled && !reduceMotion && !bootHold && !(mode === 'main' && mapBusy);
    }
    function measure() {
        var r = cv.getBoundingClientRect();
        return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)), dpr: Math.min(window.devicePixelRatio || 1, 2) };
    }
    function resize() {
        var s = measure();
        if (s.w === size.w && s.h === size.h && s.dpr === size.dpr) return;
        size = s;
        if (mode === 'worker' && worker) worker.postMessage({ t: 'size', w: s.w, h: s.h, dpr: s.dpr });
        else if (mode === 'main' && scene && scene.resize(s.w, s.h, s.dpr) && !running) scene.draw(0);
    }
    // Масштаб браузера (Ctrl +/−) меняет devicePixelRatio, а размер шапки в CSS-пикселях — нет:
    // следим за DPR отдельно, иначе холст становился мыльным.
    function watchDpr() {
        if (!window.matchMedia) return;
        try { if (dprMq) { if (dprMq.removeEventListener) dprMq.removeEventListener('change', onDpr); else dprMq.removeListener(onDpr); } } catch (e) {}
        try {
            dprMq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
            if (dprMq.addEventListener) dprMq.addEventListener('change', onDpr); else dprMq.addListener(onDpr);
        } catch (e) { dprMq = null; }
    }
    function onDpr() { watchDpr(); resize(); }

    function canWorker() {
        try {
            if (window.HS_NO_WORKER || /[?&]hs=main\b/.test(location.search)) { why = 'forced-main'; return false; }
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || !cv.transferControlToOffscreen) { why = 'no-offscreen'; return false; }
            if (!/header-scene\.js(\?|#|$)/.test(SELF_SRC)) { why = 'no-src'; return false; }
            var t = new OffscreenCanvas(1, 1);
            if (!t.getContext('2d')) { why = 'no-offscreen-2d'; return false; }
            return true;
        } catch (e) { why = 'check: ' + (e && e.message || e); return false; }
    }

    function onWorkerMsg(e) {
        var m = e.data || {};
        if (m.t === 'ready') { wReady = true; clearTimeout(wTimer); }
        else if (m.t === 'stats') {
            lastStats = m.s;
            var list = waiters; waiters = [];
            for (var i = 0; i < list.length; i++) { try { list[i](getState()); } catch (err) {} }
        }
        else if (m.t === 'fail') toMain('сбой потока: ' + m.why, true);
    }
    function startWorker() {
        var off;
        try { worker = new Worker(SELF_SRC); }
        catch (e) { worker = null; why = 'worker: ' + (e && e.message || e); return false; }
        try { off = cv.transferControlToOffscreen(); }
        catch (e) { try { worker.terminate(); } catch (_) {} worker = null; why = 'transfer: ' + (e && e.message || e); return false; }
        mode = 'worker';
        worker.onmessage = onWorkerMsg;
        worker.onerror = function (e) { try { e.preventDefault(); } catch (_) {} toMain('ошибка потока: ' + (e && e.message || 'загрузка'), true); };
        worker.onmessageerror = function () { toMain('messageerror', true); };
        size = measure();
        running = wantRun();
        worker.postMessage({ t: 'init', canvas: off, w: size.w, h: size.h, dpr: size.dpr, season: season,
                             reduce: reduceMotion, run: running, t0: T0 }, [off]);
        wTimer = setTimeout(function () { if (!wReady) toMain('поток не ответил за 8 с', true); }, 8000);
        return true;
    }

    // Резервный режим: рисуем в основном потоке (как в v18–v20).
    function toMain(reason, failed) {
        if (mode === 'main') return;
        if (reason) why = reason;
        if (failed) { try { console.warn('[header-scene] шапка переключена в основной поток:', reason); } catch (e) {} }
        clearTimeout(wTimer);
        var t0 = lastStats && lastStats.t ? lastStats.t : T0;
        if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
        if (mode === 'worker') {
            // холст уже передан потоку — ставим на его место новый
            var fresh = document.createElement('canvas');
            fresh.id = cv.id; fresh.className = cv.className; fresh.setAttribute('aria-hidden', 'true');
            if (cv.getAttribute('style')) fresh.setAttribute('style', cv.getAttribute('style'));
            if (cv.parentNode) cv.parentNode.replaceChild(fresh, cv);
            try { if (ro) { ro.unobserve(cv); ro.observe(fresh); } } catch (e) {}
            try { if (io) { io.unobserve(cv); io.observe(fresh); } } catch (e) {}
            cv = fresh;
        }
        mode = 'main'; running = false;
        var ctx = cv.getContext('2d');
        if (!ctx) return;
        scene = createScene(ctx, { season: season, reduceMotion: reduceMotion, t0: t0 });
        size = measure();
        scene.resize(size.w, size.h, size.dpr);
        scene.draw(0);
        hookMap(0);
        sync();
    }

    function frame() {
        rafId = requestAnimationFrame(frame);
        var now = perfNow();
        if (lastDraw && now - lastDraw < FRAME_MS - 2) return;
        var dt = lastT ? now - lastT : 16;
        lastT = now; lastDraw = now;
        scene.draw(dt);
        mFrames++;
        if (now - mFpsT0 >= 1000) { mFps = Math.round(mFrames * 1000 / (now - mFpsT0)); mFrames = 0; mFpsT0 = now; }
        // [v18 PERF] адаптация: если кадр дорогой (слабый ПК/встроенная графика) — реже рисуем
        var ca = scene.costAvg();
        FRAME_MS = ca > 7 ? FRAME_SLOW : ca < 4 ? FRAME_FAST : FRAME_MS;
    }
    function sync() {
        var on = wantRun();
        if (mode === 'worker') {
            if (worker && on !== running) { running = on; worker.postMessage({ t: 'run', on: on }); }
            return;
        }
        if (mode !== 'main' || !scene) return;
        if (on && !running) { running = true; lastT = 0; lastDraw = 0; mFrames = 0; mFpsT0 = perfNow(); rafId = requestAnimationFrame(frame); }
        else if (!on && running) { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0; mFps = 0; }
    }
    function redraw() {
        if (mode === 'worker' && worker) worker.postMessage({ t: 'redraw' });
        else if (scene && !running) scene.draw(0);
    }
    function setSeason(v) {
        v = normS(v) || byMonth();
        if (v === season) return;
        season = v; markSeason();
        if (mode === 'worker' && worker) worker.postMessage({ t: 'season', v: v });
        else if (scene) { scene.setSeason(v); if (!running) scene.draw(0); }
    }
    function getState() {
        var s = mode === 'worker' ? (lastStats || {}) : (scene ? scene.stats() : {});
        return { mode: mode, reason: why, ready: mode === 'main' ? !!scene : wReady, running: running, visible: visible,
                 season: season, draws: s.draws || 0, trees: s.trees || 0, width: s.width || size.w, height: s.height || size.h,
                 dpr: s.dpr || size.dpr, fps: mode === 'worker' ? (s.fps || 30) : Math.round(1000 / FRAME_MS),
                 fpsReal: mode === 'worker' ? (running ? (s.fpsReal || 0) : 0) : (running ? mFps : 0),
                 cost: s.cost || 0, time: s.t || 0, boot: bootHold, mapBusy: mapBusy, enabled: enabled, reduceMotion: reduceMotion };
    }
    // Свежее состояние (в режиме потока — после ответа потока)
    function refresh() {
        return new Promise(function (res) {
            if (mode !== 'worker' || !worker) { res(getState()); return; }
            waiters.push(res);
            worker.postMessage({ t: 'stats' });
            setTimeout(function () { var i = waiters.indexOf(res); if (i >= 0) { waiters.splice(i, 1); res(getState()); } }, 1500);
        });
    }

    // [v18 PERF] старт анимации — через ~1.5 с после полной загрузки страницы
    function releaseBoot() { if (!bootHold) return; bootHold = false; sync(); }
    if (document.readyState === 'complete') setTimeout(releaseBoot, 1200);
    else window.addEventListener('load', function () { setTimeout(releaseBoot, 1500); }, { once: true });
    setTimeout(releaseBoot, 15000); // страховка, если load так и не наступил (долгие тайлы)

    // Пауза на время движения карты — ТОЛЬКО в резервном режиме (основной поток).
    // В режиме потока шапка идёт и во время масштабирования карты.
    var mapHooked = false;
    function hookMap(tries) {
        if (mapHooked) return;
        var m = window.map;
        if (m && typeof m.on === 'function' && typeof m.getView === 'function') {
            try {
                m.on('movestart', function () { mapBusy = true; sync(); });
                m.on('moveend', function () { mapBusy = false; sync(); });
                mapHooked = true;
            } catch (e) {}
            return;
        }
        if (tries < 60) setTimeout(function () { hookMap(tries + 1); }, 500);
    }

    // Сезон рисуется прямо здесь → старое наложение (#fh-season-canvas) не нужно
    window.__hsSeasonNative = true;
    (function () {
        var old = document.getElementById('fh-season-canvas'); if (old) old.style.display = 'none';
        var st = document.createElement('style');
        st.textContent = '#fh-season-canvas{display:none!important}.forest-header #fh-scene-canvas{animation:none!important}';
        document.head.appendChild(st);
        markSeason();
    })();

    if (!(canWorker() && startWorker())) toMain(why, false);

    if (window.ResizeObserver) { ro = new ResizeObserver(function () { resize(); }); ro.observe(cv); }
    window.addEventListener('resize', resize);
    watchDpr();
    document.addEventListener('visibilitychange', sync);
    if (window.IntersectionObserver) {
        io = new IntersectionObserver(function (es) { visible = es[es.length - 1].isIntersecting; sync(); });
        io.observe(cv);
    }

    window.HeaderScene = {
        start: function () { manualStop = false; sync(); },
        stop: function () { manualStop = true; sync(); },
        seasonNative: true, setSeason: setSeason, getSeason: function () { return season; },
        redraw: redraw, getState: getState, refresh: refresh,
        // для проверки: занять поток шапки на ms миллисекунд (основной поток при этом свободен)
        _blockWorker: function (ms) { if (worker) worker.postMessage({ t: 'block', ms: ms }); },
        _crashWorker: function () { if (worker) worker.postMessage({ t: 'crash' }); }
    };

    window.addEventListener('forestseason', function (e) { if (e.detail) setSeason(e.detail.season); });
    window.addEventListener('storage', function (e) {
        if (e.key === 'forest_season' && e.newValue) { try { setSeason(JSON.parse(e.newValue).effective); } catch (_) {} }
    });
    try { if (window.ForestSeason && window.ForestSeason.on) window.ForestSeason.on(setSeason); } catch (e) {}
    function motionSync() {
        var rm = !!(mq && mq.matches);
        enabled = document.documentElement.getAttribute('data-gs-motion') !== 'off';
        if (rm !== reduceMotion) {
            reduceMotion = rm;
            if (mode === 'worker' && worker) worker.postMessage({ t: 'reduce', on: rm });
            else if (scene) scene.setReduce(rm);
        }
        sync();
        if (!running) redraw();
    }
    window.addEventListener('gs-scene-motion', motionSync);
    if (mq) { try { if (mq.addEventListener) mq.addEventListener('change', motionSync); else mq.addListener(motionSync); } catch (e) {} }
    motionSync();
})();
