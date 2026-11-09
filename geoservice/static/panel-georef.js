/* ============================================================
   panel-georef.js — v19: новые инструменты раздела «Конвертер СК»
   ------------------------------------------------------------
   • «План → GeoTIFF/TFW → MBTiles» — скан плана (JPG/PNG/TIFF) или PDF
     автоматически привязывается к местности (контуры зданий НКА/OSM +
     ортофото НКА/Esri). Результат: GeoTIFF EPSG:3857 + .tfw/.tfwx/.prj/
     .aux.xml/.ovr, MBTiles для карты, контрольная картинка, отчёт.
   • «Растр → MBTiles» — готовые GeoTIFF / растры с world-файлом / архивы.
   Задания идут через очередь сервера (/api/georef): ход по этапам,
   журнал, отмена, повтор с другими параметрами без повторной загрузки,
   история (48 ч), просмотр на карте, отправка в «Перепроецирование».
   ============================================================ */
(function () {
    'use strict';

    var API = '/api/georef';
    var CLIENT_VER = '20.7';                    // [v20.7] сверка с /caps.version
    var LS = 'georef_prefs_v1';
    var caps = null, capsAt = 0, capsP = null;
    var host = null, mode = 'georef', opts = {};
    var S = { georef: blank(), mbtiles: blank(), mb2tif: blank() };
    var shown = {};          // key → {tile, foot, op, ext}
    var picking = null;      // {key, prevFlag, prevCursor}
    var placeLyr = null;
    var lightbox = null;
    var mv = null;           // [v20.3] перемещение результата: {key, jid, kind, target, lyr, tr, ring0, k, saving…}

    function blank() { return { files: [], job: null, timer: null, log: '', logNext: 0, logOpen: false, hist: null, xhr: null, restored: false, histOpen: false }; }

    // ── утилиты ─────────────────────────────────────────────
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function toast(m, err) { if (window.showToast) window.showToast(m, !!err); }
    function csrf() { return window.getCsrfToken ? window.getCsrfToken() : ((document.querySelector('meta[name="csrf-token"]') || {}).content || ''); }
    function fmtSize(b) { b = +b || 0; return b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' ГБ' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ'; }
    function fmtDur(s) {
        s = Math.max(0, Math.round(+s || 0));
        if (s < 60) return s + ' с';
        if (s < 3600) return Math.floor(s / 60) + ' мин ' + (s % 60 ? (s % 60) + ' с' : '');
        return Math.floor(s / 3600) + ' ч ' + Math.round((s % 3600) / 60) + ' мин';
    }
    function fmtDate(ts) {
        if (!ts) return '';
        var d = new Date(ts * 1000), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function num(v, d) { var x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : d; }
    function $(id) { return document.getElementById(id); }
    function alive() { return host && document.body.contains(host); }
    function ext(name) { var n = String(name || '').toLowerCase(); if (/\.aux\.xml$/.test(n)) return 'aux.xml'; var i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1); }
    function stem(name) { return String(name || '').replace(/\.aux\.xml$/i, '').replace(/\.[^.]+$/, ''); }
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
    function savePrefs(m, v) { var p = loadPrefs(); p[m] = v; try { localStorage.setItem(LS, JSON.stringify(p)); } catch (e) {} }
    function api(path, o) {
        o = o || {};
        var init = { method: o.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
        if (o.json !== undefined) { init.body = JSON.stringify(o.json); init.headers['Content-Type'] = 'application/json'; }
        if (init.method !== 'GET') init.headers['X-CSRFToken'] = csrf();
        return fetch(API + path, init).then(function (r) {
            return r.text().then(function (t) {
                var d = null; try { d = t ? JSON.parse(t) : {}; } catch (e) {}
                if (!r.ok) {
                    var msg = d && d.detail ? (typeof d.detail === 'string' ? d.detail : (d.detail[0] && d.detail[0].msg) || JSON.stringify(d.detail)) : 'HTTP ' + r.status;
                    var er = new Error(msg); er.status = r.status; throw er;
                }
                return d;
            });
        });
    }
    function fileUrl(jid, name, inline) { return API + '/jobs/' + jid + '/files/' + encodeURIComponent(name) + (inline ? '?inline=1' : ''); }
    function loadCaps(force) {
        if (caps && !force && Date.now() - capsAt < 60000) return Promise.resolve(caps);
        if (capsP) return capsP;
        capsP = api('/caps').then(function (c) { caps = c; capsAt = Date.now(); capsP = null; return c; }, function (e) { capsP = null; throw e; });
        return capsP;
    }
    var ST_TEXT = { queued: 'В очереди', running: 'Выполняется', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено' };
    var Q_TEXT = { good: 'Хорошо', check: 'Проверить', poor: 'Сомнительно', coarse: 'Грубая' };
    var Q_COLOR = { good: '#a9d46b', check: '#f2c15e', poor: '#ff9270', coarse: '#d9b78f' };   // [v20] тёплые, тёмный текст на плашке
    function active(j) { return j && (j.status === 'queued' || j.status === 'running'); }

    // ── стили ───────────────────────────────────────────────
    function css() {
        if ($('georef-css')) return;
        var st = document.createElement('style'); st.id = 'georef-css';
        st.textContent = [
            /* [v20] цвета из темы сайта (--gs-*): тёплые и контрастные в тёмной и светлых темах */
            '.gr-root{--gr-ink:var(--gs-ink,#1f2a1f);--gr-muted:var(--gs-muted,#5e6a5c);--gr-card:var(--gs-card,#fff);--gr-acc:var(--gs-accent,#5e9b3c);' +
                '--gr-line:color-mix(in srgb,var(--gr-ink) 16%,transparent);--gr-soft:color-mix(in srgb,var(--gr-ink) 6%,var(--gr-card));' +
                '--gr-link:color-mix(in srgb,var(--gr-acc) 70%,var(--gr-ink));--gr-amber:color-mix(in srgb,#f2b35e 64%,var(--gr-ink));' +
                '--gr-coral:color-mix(in srgb,#ff9270 62%,var(--gr-ink));--gr-leaf:color-mix(in srgb,#a9d46b 62%,var(--gr-ink));' +
                '--gr-sand:color-mix(in srgb,#d9b78f 52%,var(--gr-ink));--gr-honey:color-mix(in srgb,#ffd27a 62%,var(--gr-ink))}',
            '.gr-seg{display:flex;background:var(--gr-soft);border:1px solid var(--gr-line);border-radius:8px;padding:2px;gap:2px;margin-bottom:6px}',
            '.gr-seg button{flex:1;border:none;background:none;border-radius:6px;padding:5px 6px;font:700 11.5px Lato,Arial,sans-serif;color:var(--gr-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}',
            '.gr-seg button.on{background:var(--gr-card);color:var(--gr-ink);box-shadow:0 1px 3px rgba(0,0,0,.18),inset 0 0 0 1px color-mix(in srgb,var(--gr-amber) 45%,transparent)}',
            '.gr-chips{display:flex;flex-wrap:wrap;gap:4px}',
            '.gr-chip{border:1.5px solid var(--gr-line);background:transparent;border-radius:14px;padding:3px 9px;font:700 11.5px Lato,Arial,sans-serif;color:var(--gr-ink);cursor:pointer}',
            '.gr-chip:hover{border-color:color-mix(in srgb,var(--gr-amber) 55%,transparent)}',
            '.gr-chip.on{background:color-mix(in srgb,#f2b35e 22%,var(--gr-card));border-color:color-mix(in srgb,#f2b35e 70%,transparent);color:var(--gr-ink)}',
            '.gr-g2{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
            '.gr-g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}',
            '.gr-g2 .crs-lbl,.gr-g3 .crs-lbl{margin-top:4px}',
            '.gr-ck{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:var(--gr-ink);margin-top:6px;cursor:pointer;line-height:1.35}',
            '.gr-ck input{margin-top:2px;accent-color:var(--gr-acc)}',
            '.gr-ck small{display:block;color:var(--gr-muted);font-size:10.5px}',
            '.gr-adv{margin-top:8px;border-top:1px dashed var(--gr-line);padding-top:6px}',
            '.gr-adv>summary{cursor:pointer;font-size:12px;font-weight:800;color:var(--gr-link);list-style:none;display:flex;align-items:center;gap:6px}',
            '.gr-adv>summary::-webkit-details-marker{display:none}',
            '.gr-adv>summary:before{content:"\\25B8";transition:.15s;display:inline-block}',
            '.gr-adv[open]>summary:before{transform:rotate(90deg)}',
            '.gr-file{display:flex;align-items:center;gap:7px;font-size:12px;border:1px solid var(--gr-line);background:var(--gr-soft);border-radius:7px;padding:5px 7px;margin-top:5px}',
            '.gr-file i.k{width:16px;text-align:center;color:var(--gr-amber)}',
            '.gr-file .nm{flex:1;min-width:0;word-break:break-all;font-weight:700;color:var(--gr-ink)}',
            '.gr-file .sz{color:var(--gr-muted);font-size:11px;white-space:nowrap}',
            '.gr-file .x{border:none;background:none;color:var(--gr-coral);cursor:pointer;padding:2px 4px}',
            '.gr-file .crs-chips{margin-top:2px}',
            '.gr-place{display:flex;gap:5px;align-items:center}',
            '.gr-place .crs-in{flex:1;min-width:0}',
            '.gr-ib{border:1.5px solid var(--gr-line);background:var(--gr-soft);border-radius:7px;cursor:pointer;color:var(--gr-ink);padding:5px 8px;font:800 11.5px Lato,Arial,sans-serif;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
            '.gr-ib i{color:var(--gr-amber)}',
            '.gr-ib:hover{border-color:color-mix(in srgb,#f2b35e 60%,transparent);background:color-mix(in srgb,#f2b35e 12%,var(--gr-card))}',
            '.gr-ib.on{background:#f0a75e;border-color:#f0a75e;color:#24170a}.gr-ib.on i{color:#24170a}',
            '.gr-ib:disabled{opacity:.6;cursor:wait}',
            '.gr-steps{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}',
            '.gr-steps li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--gr-muted)}',
            '.gr-steps li i{width:16px;text-align:center}',
            '.gr-steps li.done{color:var(--gr-ink)}.gr-steps li.done i{color:var(--gr-leaf)}',
            '.gr-steps li.cur{color:var(--gr-ink);font-weight:800}.gr-steps li.cur i{color:var(--gr-amber)}',
            '.gr-steps li.fail{color:var(--gr-coral);font-weight:800}',
            '.gr-jh{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:var(--gr-ink);word-break:break-all}',
            '.gr-st{font-size:10.5px;font-weight:800;border-radius:10px;padding:1px 8px;white-space:nowrap;margin-left:auto;border:1px solid transparent}',
            '.gr-st.queued{background:color-mix(in srgb,#d9b78f 16%,transparent);color:var(--gr-sand);border-color:color-mix(in srgb,#d9b78f 35%,transparent)}',
            '.gr-st.running{background:color-mix(in srgb,#f2b35e 16%,transparent);color:var(--gr-amber);border-color:color-mix(in srgb,#f2b35e 40%,transparent)}',
            '.gr-st.done{background:color-mix(in srgb,#a9d46b 15%,transparent);color:var(--gr-leaf);border-color:color-mix(in srgb,#a9d46b 38%,transparent)}',
            '.gr-st.error{background:color-mix(in srgb,#ff9270 15%,transparent);color:var(--gr-coral);border-color:color-mix(in srgb,#ff9270 40%,transparent)}',
            '.gr-st.cancelled{background:var(--gr-soft);color:var(--gr-muted);border-color:var(--gr-line)}',
            '.gr-meta{font-size:11.5px;color:var(--gr-muted);margin-top:5px;display:flex;flex-wrap:wrap;gap:4px 10px}',
            '.gr-msg{font-size:11px;color:var(--gr-muted);margin-top:3px;word-break:break-word;min-height:13px}',
            '.gr-err{font-size:12px;color:var(--gr-ink);background:color-mix(in srgb,#ff9270 11%,var(--gr-card));border:1px solid color-mix(in srgb,#ff9270 34%,transparent);border-left:3px solid var(--gr-coral);border-radius:8px;padding:7px 9px;margin-top:6px;line-height:1.45;word-break:break-word}',
            '.gr-err b{color:var(--gr-coral)}.gr-err i{color:var(--gr-amber);font-style:normal;font-weight:800}.gr-err a{color:var(--gr-amber);font-weight:800}',
            '.gr-log{max-height:190px;overflow:auto;background:#16140f;color:#ece3cf;font:10.5px/1.45 Consolas,monospace;border:1px solid var(--gr-line);border-radius:7px;padding:7px 8px;margin-top:6px;white-space:pre-wrap;word-break:break-all}',
            '.gr-acts{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}',
            '.gr-sheet{border:1px solid var(--gr-line);border-radius:9px;padding:8px 9px;margin-top:7px;font-size:12px;background:var(--gr-soft)}',
            '.gr-sheet.err{border-color:color-mix(in srgb,#ff9270 40%,transparent);background:color-mix(in srgb,#ff9270 8%,var(--gr-card))}',
            '.gr-sheet .t{display:flex;align-items:center;gap:6px;font-weight:800;color:var(--gr-ink);word-break:break-all}',
            '.gr-q{font-size:10.5px;font-weight:800;border-radius:10px;padding:1px 8px;color:#22170b;white-space:nowrap;margin-left:auto}',
            '.gr-qt{font-size:11px;color:var(--gr-muted);margin-top:3px;line-height:1.35}',
            '.gr-facts{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin-top:6px;font-size:11.5px}',
            '.gr-facts div{color:var(--gr-muted)}.gr-facts b{color:var(--gr-ink);font-weight:800}',
            '.gr-dl{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
            '.gr-dl a{font-size:10.5px;font-weight:800;text-decoration:none;padding:2px 8px;border-radius:10px;background:color-mix(in srgb,#f2b35e 13%,transparent);color:var(--gr-amber);border:1px solid color-mix(in srgb,#f2b35e 38%,transparent)}',
            '.gr-dl a:hover{background:#f0a75e;color:#24170a;border-color:#f0a75e}',
            '.gr-op{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--gr-muted);margin-top:6px}',
            '.gr-op input{flex:1;accent-color:var(--gr-acc)}',
            '.gr-mv{margin-top:7px;padding:7px 8px;border:1px dashed #e0913a;border-radius:8px;background:color-mix(in srgb,#f2b35e 9%,var(--gr-card))}',
            '.gr-mv .h{font-size:11px;color:var(--gr-muted);line-height:1.45}',
            '.gr-mv .i{font-size:11.5px;margin:6px 0;color:var(--gr-ink)}',
            '.gr-mv .row{display:flex;gap:5px;align-items:center}.gr-mv .row input{width:0;flex:1;min-width:0}',
            '.gr-mv .st{font-size:11px;color:var(--gr-muted);margin-top:5px;line-height:1.4}.gr-mv .st.err{color:var(--gr-coral)}',
            '.gr-mv .w{font-size:10.5px;color:var(--gr-amber);margin-top:5px;line-height:1.4}',
            '.gr-mbs{margin-top:7px;padding:6px 8px;border-radius:8px;border:1px solid color-mix(in srgb,#1565c0 32%,transparent);background:color-mix(in srgb,#1565c0 7%,var(--gr-card));font-size:11px;line-height:1.45;color:var(--gr-ink)}',
            '.gr-mbs i.fa-table-cells{color:#1565c0;margin-right:4px}.gr-mbs .a{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
            '.gr-crs-picks{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}',
            '.gr-reg{display:flex;gap:5px;margin-top:6px}',
            '.gr-sum{font-size:11.5px;color:var(--gr-muted);line-height:1.5}',
            '.gr-sum b{color:var(--gr-ink)}.gr-sum .fix{color:var(--gr-amber)}',
            '.gr-hist{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:5px 2px;border-bottom:1px dashed var(--gr-line);cursor:pointer}',
            '.gr-hist:hover{background:var(--gr-soft)}',
            '.gr-hist.cur{background:color-mix(in srgb,#f2b35e 10%,var(--gr-card))}',
            '.gr-hist .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:var(--gr-ink)}',
            '.gr-hist .dt{color:var(--gr-muted);font-size:10.5px;white-space:nowrap}',
            '.gr-hist .gr-st{margin-left:0}',
            '.gr-hist .x{border:none;background:none;color:var(--gr-coral);cursor:pointer;padding:1px 4px}',
            '.gr-warn{font-size:11.5px;color:var(--gr-ink);background:color-mix(in srgb,#f2b35e 12%,var(--gr-card));border:1px solid color-mix(in srgb,#f2b35e 38%,transparent);border-left:3px solid var(--gr-amber);border-radius:8px;padding:6px 9px;line-height:1.45}',
            '.gr-warn b{display:block;margin-bottom:2px;color:var(--gr-amber)}',
            '.gr-range{display:flex;align-items:center;gap:6px}.gr-range input[type=range]{flex:1;accent-color:var(--gr-acc)}',
            '.gr-range span{font-size:11.5px;font-weight:800;color:var(--gr-ink);min-width:30px;text-align:right}',
            '.gr-found{display:flex;gap:8px;align-items:flex-start;margin-top:6px;padding:7px 9px;border-radius:8px;font-size:12px;line-height:1.4;color:var(--gr-ink);background:color-mix(in srgb,#a9d46b 10%,var(--gr-card));border:1px solid color-mix(in srgb,#a9d46b 32%,transparent);border-left:3px solid var(--gr-leaf)}',
            '.gr-found>i{color:var(--gr-leaf);margin-top:2px}.gr-found.busy{background:var(--gr-soft);border-color:var(--gr-line);border-left-color:var(--gr-amber)}.gr-found.busy>i{color:var(--gr-amber)}',
            '.gr-found .tx{flex:1;min-width:0;word-break:break-word}.gr-found .tx small{display:block;color:var(--gr-amber);font-weight:700;margin-top:2px}',
            '.gr-found .tx .ll{color:var(--gr-muted);font-size:11px}',
            '.gr-alts{display:flex;flex-direction:column;gap:2px;margin-top:5px}',
            '.gr-alts button{all:unset;cursor:pointer;font-size:11.5px;color:var(--gr-muted);padding:2px 4px;border-radius:5px}.gr-alts button:hover{color:var(--gr-ink);background:var(--gr-soft)}',
            '.gr-lb{position:fixed;inset:0;z-index:100000;background:rgba(14,12,8,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px;box-sizing:border-box}',
            '.gr-lb .bar{position:absolute;top:10px;left:14px;right:14px;display:flex;align-items:center;gap:10px;color:#f6efe0;font:700 13px Lato,Arial,sans-serif}',
            '.gr-lb .bar span{flex:1}',
            '.gr-lb .bar button,.gr-lb .bar a{border:none;background:rgba(255,240,215,.14);color:#f6efe0;border-radius:7px;padding:6px 10px;cursor:pointer;font:700 12px Lato,Arial,sans-serif;text-decoration:none}',
            '.gr-lb .wrap{overflow:auto;max-width:100%;max-height:calc(100% - 40px);margin-top:30px}',
            '.gr-lb img{display:block;max-width:calc(100vw - 40px);max-height:calc(100vh - 80px);cursor:zoom-in}',
            '.gr-lb.zoom img{max-width:none;max-height:none;cursor:zoom-out}',
            '.gr-tip{font-size:10.5px;color:var(--gr-muted);margin-top:3px;line-height:1.35}'
        ].join('\n');
        document.head.appendChild(st);
    }

    // ── вход ────────────────────────────────────────────────
    function render(body, o) {
        css();
        host = body; opts = o || {}; mode = (opts.mode === 'mbtiles' || opts.mode === 'mb2tif') ? opts.mode : 'georef';
        body.classList.add('gr-root');
        body.innerHTML = '<div class="crs-hint" style="padding:14px;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка…</div>';
        var me = body;
        loadCaps().then(function () {
            if (host !== me || !alive()) return;
            if (!caps.enabled) {
                body.innerHTML = '<div class="crs-off"><i class="fa-solid fa-ban" style="font-size:28px;color:var(--gr-coral);display:block;margin-bottom:8px"></i>Инструменты привязки планов отключены администратором.</div>';
                return;
            }
            draw();
            restore();
        }).catch(function (e) {
            if (host === me) body.innerHTML = '<div class="crs-off">Не удалось загрузить инструменты: ' + esc(e.message) + '</div>';
        });
    }

    function detach() {
        stopPick();
        if (mv && !mv.saving) stopMove();
        Object.keys(S).forEach(function (m) { if (S[m].timer) { clearTimeout(S[m].timer); S[m].timer = null; } });
        host = null;
    }

    function isReady(m) { m = m || mode; return m === 'georef' ? caps.georef : m === 'mb2tif' ? (caps.mb2tif != null ? caps.mb2tif : caps.mbtiles) : caps.mbtiles; }
    function problemsHtml() {
        var ok = isReady();
        if (ok && !(caps.problems || []).length) return '';
        var list = (caps.problems || []).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('');
        return '<div class="gr-warn"><b><i class="fa-solid fa-triangle-exclamation"></i> ' + (ok ? 'Есть замечания по окружению сервера' : 'Инструмент пока не готов на сервере') + '</b>' +
            (caps.is_admin ? '<ul style="margin:2px 0 0 16px;padding:0">' + list + '</ul>' : 'Обратитесь к администратору.') + '</div>';
    }

    // ── форма ───────────────────────────────────────────────
    function draw() {
        if (!alive()) return;
        var P = loadPrefs()[mode] || {};
        var D = (caps.defaults || {});
        var h = [problemsHtml()];
        if (mode === 'georef') {
            var g = D.georef || {}, scales = caps.scales || [200, 500, 1000, 2000, 5000, 10000];
            var pv = prefV201(P, g), sc = pv.scale, rv = pv.radius;      // [v20.1] 'auto' | число
            h.push(
                '<div class="crs-card"><div class="crs-h"><span class="n">1</span>Скан плана<span class="sp"></span>' +
                '<span class="crs-hint">до ' + (caps.max_sheets || 12) + ' листов</span></div>' +
                '<div class="crs-drop" id="gr-drop"><i class="fa-solid fa-file-image"></i>Перетащите сканы планов или PDF' +
                '<small>JPG, PNG, TIFF, BMP, WebP, PDF или ZIP · до ' + (caps.max_upload_mb || 1024) + ' МБ<br>Каждый файл и каждая страница PDF — отдельный лист. Соседние листы сшиваются автоматически.</small></div>' +
                '<input type="file" id="gr-file" multiple accept="' + (caps.accept && caps.accept.georef || []).join(',') + '" style="display:none">' +
                '<div id="gr-files"></div></div>',

                '<div class="crs-card"><div class="crs-h"><span class="n">2</span>Где находится участок</div>' +
                '<div class="gr-seg" id="gr-pmode"><button data-pm="point"><i class="fa-solid fa-location-crosshairs"></i>Точка на карте</button><button data-pm="address"><i class="fa-solid fa-house-flag"></i>Адрес</button></div>' +
                '<div id="gr-pm-point"><div class="gr-place"><input class="crs-in" id="gr-center" placeholder="широта, долгота — напр. 53.9023, 27.5619" value="' + esc(P.center || '') + '">' +
                '<button class="gr-ib" id="gr-pick" title="Щёлкнуть точку на карте"><i class="fa-solid fa-crosshairs"></i>На карте</button>' +
                '<button class="gr-ib" id="gr-mapc" title="Центр текущего вида карты"><i class="fa-regular fa-circle-dot"></i></button></div>' +
                '<div class="gr-tip">Достаточно примерно: участок должен попасть в круг поиска. Круг показан на карте.</div></div>' +
                '<div id="gr-pm-address" style="display:none"><div class="gr-g2" style="grid-template-columns:2fr 1fr">' +
                '<div><div class="crs-lbl">Адрес</div><input class="crs-in" id="gr-addr" placeholder="ул. Ленина, 5" autocomplete="off" value="' + esc(P.address || '') + '"></div>' +
                '<div><div class="crs-lbl">Город</div><input class="crs-in" id="gr-city" autocomplete="off" value="' + esc(P.city != null ? P.city : (g.city || 'Минск')) + '"></div></div>' +
                '<div class="gr-place" style="margin-top:6px"><button class="gr-ib" id="gr-find" title="Найти адрес и показать место на карте (Enter)"><i class="fa-solid fa-magnifying-glass-location"></i>Найти на карте</button>' +
                '<button class="gr-ib" id="gr-fix" title="Уточнить место щелчком по карте"><i class="fa-solid fa-crosshairs"></i>Уточнить</button></div>' +
                '<div id="gr-found"></div>' +
                '<div class="gr-tip">Опечатки в названии улицы исправляются («Долгобротская» → «Долгобродская»). Найденное место показывается на карте кругом поиска.</div></div>' +
                '<div class="crs-lbl">Радиус поиска</div><div class="gr-chips" id="gr-radius">' +
                '<button class="gr-chip' + (rv === 'auto' ? ' on' : '') + '" data-v="auto" title="По охвату улицы или дома и размеру листа: лист плана целиком внутри круга">авто</button>' +
                [100, 200, 300, 500, 1000, 2000].map(function (r) { return '<button class="gr-chip' + (rv === r ? ' on' : '') + '" data-v="' + r + '">' + (r < 1000 ? r + ' м' : r / 1000 + ' км') + '</button>'; }).join('') +
                '</div><div class="gr-tip" id="gr-rtip"></div></div>',

                '<div class="crs-card"><div class="crs-h"><span class="n">3</span>План</div>' +
                '<div class="crs-lbl">Масштаб плана</div><div class="gr-chips" id="gr-scale">' +
                '<button class="gr-chip' + (sc === 'auto' ? ' on' : '') + '" data-v="auto" title="Из подписи масштаба в PDF или в штампе плана («М 1:500»); не найдена — 1:500">авто (из файла)</button>' +
                scales.map(function (s) { return '<button class="gr-chip' + (+sc === s ? ' on' : '') + '" data-v="' + s + '">1:' + s + '</button>'; }).join('') +
                '<input class="crs-in" id="gr-scale-x" placeholder="другой" style="width:74px;padding:3px 7px" value="' + (sc !== 'auto' && scales.indexOf(+sc) < 0 ? esc(sc) : '') + '"></div>' +
                '<div class="gr-tip">Масштаб — плана, а не листа: если PDF увеличен или уменьшен при печати (например, A2 → A1), поправка определяется по координатной сетке.</div>' +
                '<div class="gr-g2"><div><div class="crs-lbl">Разрешение скана</div><select class="crs-sel" id="gr-dpi">' +
                [['', 'авто (из файла)'], ['150', '150 dpi'], ['200', '200 dpi'], ['300', '300 dpi'], ['400', '400 dpi'], ['600', '600 dpi']].map(function (o) { return '<option value="' + o[0] + '"' + (String(P.dpi || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">Ориентация скана</div><select class="crs-sel" id="gr-orient">' +
                [['auto', 'авто'], ['0', 'север вверху'], ['90', 'повёрнут на 90°'], ['180', 'на 180°'], ['270', 'на 270°']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.orient || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div></div>' +
                '<label class="gr-ck"><input type="checkbox" id="gr-grid"' + (P.no_grid ? '' : ' checked') + '><span>На плане есть координатная сетка<small>Кресты/линии сетки уточняют масштаб и поворот</small></span></label>' +
                '<details class="gr-adv"' + (P.adv ? ' open' : '') + ' id="gr-adv"><summary>Тонкая настройка</summary>' +
                '<div class="crs-lbl">Модель преобразования</div><select class="crs-sel" id="gr-model">' +
                [['auto', 'Авто (по качеству совпадения)'], ['rigid', 'Жёсткая: сдвиг + поворот'], ['similarity', 'Подобие: + масштаб'], ['affine', 'Аффинная: + перекос (деформированный скан)']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.model || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select>' +
                '<label class="gr-ck"><input type="checkbox" id="gr-fine"' + (P.no_fine ? '' : ' checked') + '><span>Тонкая привязка по линиям плана<small>Сверка с ортофото: точность до 0,1–0,3 м. Без неё — только по контурам зданий (до ~5 м)</small></span></label>' +
                '<div class="gr-g3"><div><div class="crs-lbl">Контуры зданий</div><select class="crs-sel" id="gr-bld">' +
                [['nca', 'НКА'], ['osm', 'OSM']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.buildings || 'nca') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">Ортофото</div><select class="crs-sel" id="gr-ortho">' +
                [['nca', 'НКА'], ['esri', 'Esri']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.ortho || 'nca') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">Уровень z</div><select class="crs-sel" id="gr-zoom">' +
                [17, 18, 19, 20, 21].map(function (z) { return '<option' + ((+P.zoom || 20) === z ? ' selected' : '') + '>' + z + '</option>'; }).join('') +
                '</select></div></div>' +
                '<div class="gr-g2"><div><div class="crs-lbl">Поиск поворота, ±°</div><input class="crs-in" id="gr-sa" type="number" min="0.5" max="15" step="0.5" value="' + esc(P.search_angle || 2.5) + '"></div>' +
                '<div><div class="crs-lbl">Поиск сдвига, ± м</div><input class="crs-in" id="gr-ss" type="number" min="1" max="60" step="1" value="' + esc(P.search_shift || 8) + '"></div></div>' +
                '<div class="gr-g2"><div><div class="crs-lbl">PDF: разрешение</div><select class="crs-sel" id="gr-pdpi">' +
                [['auto', 'как в скане'], ['150', '150 dpi'], ['200', '200 dpi'], ['300', '300 dpi'], ['400', '400 dpi']].map(function (o) { return '<option value="' + o[0] + '"' + (String(P.pdf_dpi || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">PDF: страницы</div><input class="crs-in" id="gr-pages" placeholder="все · или 1,3-5" value="' + esc(P.pages && P.pages !== 'all' ? P.pages : '') + '"></div></div>' +
                '</details></div>',

                mbtilesCard(P, 4, true)
            );
        } else if (mode !== 'mb2tif') {
            h.push(
                '<div class="crs-card"><div class="crs-h"><span class="n">1</span>Растры</div>' +
                '<div class="crs-drop" id="gr-drop"><i class="fa-solid fa-layer-group"></i>Перетащите GeoTIFF или растры с привязкой' +
                '<small>GeoTIFF · TIFF/JPG/PNG + world-файл (.tfw .jgw .pgw) и .prj · ZIP/7z/RAR · до ' + (caps.max_upload_mb || 1024) + ' МБ</small></div>' +
                '<input type="file" id="gr-file" multiple accept="' + (caps.accept && caps.accept.mbtiles || []).join(',') + '" style="display:none">' +
                '<div id="gr-files"></div></div>',

                '<div class="crs-card"><div class="crs-h"><span class="n">2</span>Система координат</div>' +
                '<div class="crs-lbl">Если в файле нет СК (.prj / GeoTIFF)</div>' + crsSelect('gr-srccrs', !P.src_crs || (P.src_crs === 'EPSG:3857' && !P.v203) ? 'auto' : P.src_crs, true) +
                '<div class="crs-hint" style="margin-top:3px">Авто: СК без .prj определяется по координатам (Web Mercator, СК-42 с номером зоны, UTM) — если подходит одна; иначе задание предложит варианты.</div>' +
                '<input class="crs-in" id="gr-srccrs-x" placeholder="EPSG:XXXX, PROJ-строка или WKT" style="margin-top:4px;display:none" value="' + esc(P.src_crs_x || '') + '">' +
                '<label class="gr-ck"><input type="checkbox" id="gr-force"' + (P.force ? ' checked' : '') + '><span>Игнорировать СК из файлов<small>Применить выбранную СК ко всем растрам принудительно</small></span></label>' +
                '<div class="gr-g2"><div><div class="crs-lbl">NoData (пусто)</div><input class="crs-in" id="gr-nodata" placeholder="авто" value="' + esc(P.src_nodata != null ? P.src_nodata : '') + '"></div>' +
                '<div><div class="crs-lbl">Название слоя</div><input class="crs-in" id="gr-name" placeholder="по имени файла" value="' + esc(P.name || '') + '"></div></div>' +
                '</div>',

                mbtilesCard(P, 3, false)
            );
        } else if (mode === 'mb2tif') {
            h.push(
                '<div class="crs-card"><div class="crs-h"><span class="n">1</span>Файлы MBTiles</div>' +
                '<div class="crs-drop" id="gr-drop"><i class="fa-solid fa-database"></i>Перетащите файлы .mbtiles' +
                '<small>Растровые MBTiles (PNG, JPEG, WebP) или ZIP с ними · до ' + (caps.max_upload_mb || 1024) + ' МБ<br>Каждый файл — отдельный GeoTIFF. Векторные MBTiles (pbf) не подходят.</small></div>' +
                '<input type="file" id="gr-file" multiple accept="' + ((caps.accept && caps.accept.mb2tif) || ['.mbtiles', '.zip']).join(',') + '" style="display:none">' +
                '<div id="gr-files"></div></div>',

                '<div class="crs-card"><div class="crs-h"><span class="n">2</span>Система координат результата</div>' +
                crsSelect('gr-dstcrs', P.crs != null ? (P.crs || '__x') : 'EPSG:3857') +
                '<input class="crs-in" id="gr-dstcrs-x" placeholder="EPSG:XXXX, PROJ-строка или WKT" style="margin-top:4px;display:none" value="' + esc(P.crs_x || '') + '">' +
                '<div class="gr-tip" id="gr-dst-tip"></div></div>',

                '<div class="crs-card"><div class="crs-h"><span class="n">3</span>GeoTIFF</div>' +
                '<div class="gr-g2"><div><div class="crs-lbl">Уровень детализации</div><select class="crs-sel" id="gr-z2">' +
                [['max', 'Самый подробный в файле'], ['auto', 'Подробный, до ' + Math.round(caps.mb2tif_max_mp || 400) + ' Мпикс']].concat(
                    [22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10].map(function (z) { var m = 156543.034 * Math.cos(54 * Math.PI / 180) / Math.pow(2, z); return [String(z), 'z' + z + ' · ≈' + (m < 1 ? m.toFixed(2) : m < 10 ? m.toFixed(1) : Math.round(m)).toString().replace('.', ',') + ' м/пикс']; })
                ).map(function (o) { return '<option value="' + o[0] + '"' + (String(P.zoom || 'max') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">Пустые места</div><select class="crs-sel" id="gr-bg">' +
                [['none', 'Прозрачные (альфа-канал)'], ['white', 'Белый фон'], ['black', 'Чёрный фон']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.background || 'none') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div></div>' +
                '<div class="crs-lbl">Сжатие</div><div class="gr-chips" id="gr-cmp">' +
                [['deflate', 'Deflate · без потерь'], ['lzw', 'LZW'], ['jpeg', 'JPEG · компактно'], ['none', 'Без сжатия']].map(function (o) { return '<button class="gr-chip' + ((P.compress || 'deflate') === o[0] ? ' on' : '') + '" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
                '<div class="gr-g2"><div><div class="crs-lbl">Обрезка</div><select class="crs-sel" id="gr-clip">' +
                [['auto', 'По содержимому'], ['bounds', 'По границам (bounds)'], ['none', 'Все тайлы целиком']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.clip || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div><div><div class="crs-lbl">Перепроецирование</div><select class="crs-sel" id="gr-rs2">' +
                [['cubic', 'Кубическое'], ['bilinear', 'Билинейное'], ['lanczos', 'Ланцош (резче)'], ['nearest', 'Без сглаживания']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.resampling || 'cubic') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                '</select></div></div>' +
                '<label class="gr-ck"><input type="checkbox" id="gr-ovr"' + (P.overviews === false ? '' : ' checked') + '><span>Внутренние пирамиды<small>Быстрый просмотр крупного растра в QGIS, ArcGIS, MapInfo</small></span></label>' +
                '<div class="gr-tip" id="gr-cmp-tip"></div></div>'
            );
        }
        h.push(
            '<div class="crs-card" id="gr-run-card"><div id="gr-run"></div></div>',
            '<div class="crs-card" id="gr-job-card" style="display:none"></div>',
            '<div class="crs-card" id="gr-res-card" style="display:none"></div>',
            '<div class="crs-card"><div class="crs-h" id="gr-hist-h" style="cursor:pointer;margin-bottom:0"><i class="fa-solid fa-clock-rotate-left" style="color:var(--gr-amber)"></i>Мои задания<span class="sp"></span><span class="crs-hint" id="gr-hist-n"></span><i class="fa-solid fa-chevron-down" id="gr-hist-ch" style="font-size:11px;color:#8a9a8a"></i></div><div id="gr-hist" style="display:none;margin-top:6px"></div></div>',
            '<div class="crs-hint" style="padding:0 4px 8px">' + (mode === 'georef'
                ? 'Привязка по контурам зданий и ортофото работает для застроенной территории (план с домами/дорогами). Результаты хранятся на сервере ' + Math.round(caps.keep_hours || 48) + ' ч; GeoTIFF/TFW можно сразу отправить на вкладку «Смена СК» (СК-42, СК-63, UTM…).'
                : mode === 'mb2tif'
                ? 'Тайлы выбранного уровня склеиваются в один GeoTIFF с привязкой. В комплекте: .tif, world-файлы .tfw и .tfwx (одинаковые, A·D·B·E·C·F — центр левого верхнего пикселя) и .prj (ESRI WKT). Результаты хранятся ' + Math.round(caps.keep_hours || 48) + ' ч.'
                : 'MBTiles — один файл с готовыми тайлами для карты, ГИС и мобильных приложений. Пустые и белые поля можно сделать прозрачными. Результаты хранятся ' + Math.round(caps.keep_hours || 48) + ' ч.') + '</div>'
        );
        host.innerHTML = h.join('');
        bindForm();
        renderFiles(); renderRun(); renderJob(); renderHist();
    }

    function crsSelect(id, val, auto) {
        var list = [['EPSG:3857', 'Web Mercator (EPSG:3857)'], ['EPSG:4326', 'WGS-84, градусы (EPSG:4326)'], ['EPSG:32634', 'UTM 34N (EPSG:32634)'], ['EPSG:32635', 'UTM 35N (EPSG:32635)'], ['EPSG:32636', 'UTM 36N (EPSG:32636)'],
            ['EPSG:28404', 'СК-42 6°, зона 4 (EPSG:28404)'], ['EPSG:28405', 'СК-42 6°, зона 5 (EPSG:28405)'], ['EPSG:28406', 'СК-42 6°, зона 6 (EPSG:28406)'],
            ['EPSG:2495', 'СК-42 6° без № зоны, осевой 27° (EPSG:2495)'], ['EPSG:2524', 'СК-42 3°, зона 8 (EPSG:2524)'], ['EPSG:2525', 'СК-42 3°, зона 9 (EPSG:2525)'], ['EPSG:2526', 'СК-42 3°, зона 10 (EPSG:2526)'],
            ['EPSG:2582', 'СК-42 3° без № зоны, осевой 21° (EPSG:2582)'], ['EPSG:2583', 'СК-42 3° без № зоны, осевой 24° (EPSG:2583)'], ['EPSG:2584', 'СК-42 3° без № зоны, осевой 27° (EPSG:2584)'], ['EPSG:2585', 'СК-42 3° без № зоны, осевой 30° (EPSG:2585)']];
        if (auto) list.unshift(['auto', 'Авто — по координатам (рекомендуется)']);      // [v20.3]
        var my = []; try { my = JSON.parse(localStorage.getItem('crs_custom_presets_v1') || '[]') || []; } catch (e) {}
        var known = list.some(function (o) { return o[0] === val; }) || my.some(function (p) { return p.def === val; });
        return '<select class="crs-sel" id="' + id + '">' + list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
            (my.length ? '<optgroup label="Мои пресеты (Конвертер СК)">' + my.map(function (p) { return '<option value="' + esc(p.def) + '"' + (p.def === val ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</optgroup>' : '') +
            '<option value="__x"' + (known ? '' : ' selected') + '>Другая… (EPSG / PROJ / WKT)</option></select>';
    }

    function mbtilesCard(P, n, optional) {
        var fmt = P.format || 'png', paper = P.paper || (optional ? 'auto' : 'transparent');
        return '<div class="crs-card"><div class="crs-h"><span class="n">' + n + '</span>MBTiles для карты' +
            (optional ? '<span class="sp"></span><label class="gr-ck" style="margin:0"><input type="checkbox" id="gr-mb-on"' + (P.mb_off ? '' : ' checked') + '><span>нарезать</span></label>' : '') + '</div>' +
            '<div id="gr-mb-body"' + (optional && P.mb_off ? ' style="display:none"' : '') + '>' +
            '<div class="crs-lbl">Формат тайлов</div><div class="gr-chips" id="gr-fmt">' +
            [['png', 'PNG'], ['png8', 'PNG8 · меньше'], ['jpg', 'JPEG'], ['webp', 'WebP']].map(function (o) { return '<button class="gr-chip' + (fmt === o[0] ? ' on' : '') + '" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
            '<div class="crs-lbl">Белая бумага / фон</div><select class="crs-sel" id="gr-paper">' +
            [['auto', 'Авто'], ['clean', 'Очистить (ровный белый)'], ['original', 'Как в скане'], ['transparent', 'Прозрачная — видна подложка']].map(function (o) { return '<option value="' + o[0] + '"' + (paper === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
            (optional
                ? '<div class="gr-g2"><div><div class="crs-lbl">Уровни zoom</div><input class="crs-in" id="gr-zr" placeholder="авто · напр. 15-21" value="' + esc(P.zr || '') + '"></div>' +
                  '<div><div class="crs-lbl">Объединить листы</div><input class="crs-in" id="gr-merge" placeholder="имя общего файла" value="' + esc(P.merge || '') + '"></div></div>'
                : '<div class="gr-g3"><div><div class="crs-lbl">Мин. zoom</div><input class="crs-in" id="gr-minz" type="number" min="0" max="24" placeholder="авто" value="' + esc(P.minzoom != null ? P.minzoom : '') + '"></div>' +
                  '<div><div class="crs-lbl">Макс. zoom</div><input class="crs-in" id="gr-maxz" type="number" min="0" max="24" placeholder="авто" value="' + esc(P.maxzoom != null ? P.maxzoom : '') + '"></div>' +
                  '<div><div class="crs-lbl">Тайл, px</div><select class="crs-sel" id="gr-ts"><option' + (+P.tile_size === 512 ? '' : ' selected') + '>256</option><option' + (+P.tile_size === 512 ? ' selected' : '') + '>512</option></select></div></div>' +
                  '<div class="gr-g2"><div><div class="crs-lbl">Сглаживание</div><select class="crs-sel" id="gr-rs">' +
                  [['cubic', 'Кубическое'], ['bilinear', 'Билинейное'], ['lanczos', 'Ланцош'], ['average', 'Среднее'], ['nearest', 'Без (классы)']].map(function (o) { return '<option value="' + o[0] + '"' + ((P.resampling || 'cubic') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
                  '</select></div><div><div class="crs-lbl">Объединить в файл</div><input class="crs-in" id="gr-merge" placeholder="имя (иначе по файлам)" value="' + esc(P.merge || '') + '"></div></div>' +
                  '<div id="gr-qwrap"><div class="crs-lbl">Качество JPEG/WebP</div><div class="gr-range"><input type="range" id="gr-qual" min="40" max="100" value="' + (+P.quality || 85) + '"><span id="gr-qual-v">' + (+P.quality || 85) + '</span></div></div>' +
                  '<div id="gr-wwrap"><div class="crs-lbl">Порог «белого» для очистки</div><div class="gr-range"><input type="range" id="gr-white" min="150" max="254" value="' + (+P.white_threshold || 235) + '"><span id="gr-white-v">' + (+P.white_threshold || 235) + '</span></div></div>') +
            '<div class="gr-tip">Авто-уровни подбираются по разрешению растра (обычно z15–z21 для плана 1:500).</div></div></div>';
    }

    function bindForm() {
        var drop = $('gr-drop'), inp = $('gr-file');
        drop.onclick = function () { inp.click(); };
        inp.onchange = function () { addFiles(inp.files); inp.value = ''; };
        ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
        ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
        drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });
        var chipGroup = function (id) {
            var box = $(id); if (!box) return;
            box.addEventListener('click', function (e) {
                var b = e.target.closest('.gr-chip'); if (!b) return;
                Array.prototype.forEach.call(box.querySelectorAll('.gr-chip'), function (x) { x.classList.toggle('on', x === b); });
                if (id === 'gr-scale' && $('gr-scale-x')) $('gr-scale-x').value = '';
                if (id === 'gr-radius') drawPlace();
                onChange();
            });
        };
        ['gr-radius', 'gr-scale', 'gr-fmt', 'gr-cmp'].forEach(chipGroup);
        host.addEventListener('input', onChange);
        host.addEventListener('change', onChange);
        if (mode === 'georef') {
            var P = loadPrefs().georef || {};
            setPlaceMode(P.pmode || 'point');
            $('gr-pmode').onclick = function (e) { var b = e.target.closest('[data-pm]'); if (b) { setPlaceMode(b.getAttribute('data-pm')); onChange(); } };
            $('gr-pick').onclick = function () { picking ? stopPick() : startPick(); };
            $('gr-mapc').onclick = function () {
                var map = window.map; if (!map) return;
                var c = ol.proj.toLonLat(map.getView().getCenter());
                $('gr-center').value = c[1].toFixed(6) + ', ' + c[0].toFixed(6);
                drawPlace(); onChange();
            };
            $('gr-center').addEventListener('change', function () { drawPlace(true); });
            found = (P.found && P.found.key === addrKey() && P.found.alts) ? P.found : null;
            renderFound();
            $('gr-find').onclick = function () { findAddress(null, true); };
            $('gr-fix').onclick = function () {
                var c = foundPoint();
                if (c) $('gr-center').value = c[0].toFixed(6) + ', ' + c[1].toFixed(6);
                setPlaceMode('point'); onChange(); startPick();
            };
            $('gr-addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); findAddress(null, true); } });
            ['gr-addr', 'gr-city'].forEach(function (id) {
                $(id).addEventListener('input', function () { if (found && found.key !== addrKey()) { found = null; renderFound(); drawPlace(); } });
                $(id).addEventListener('change', function () { if (!foundPoint() && $('gr-addr').value.trim().length >= 5) findAddress(null, true); });
            });
            $('gr-scale-x').addEventListener('input', function () {
                if (this.value) Array.prototype.forEach.call($('gr-scale').querySelectorAll('.gr-chip'), function (x) { x.classList.remove('on'); });
            });
            $('gr-mb-on').onchange = function () { $('gr-mb-body').style.display = this.checked ? '' : 'none'; };
            drawPlace();
        } else if (mode === 'mb2tif') {
            var dsel = $('gr-dstcrs'), dx = $('gr-dstcrs-x');
            var dsync = function () { dx.style.display = dsel.value === '__x' ? '' : 'none'; syncTifOpts(); };
            dsel.addEventListener('change', dsync); dsync();
        } else {
            var sel = $('gr-srccrs'), x = $('gr-srccrs-x');
            var sync = function () { x.style.display = sel.value === '__x' ? '' : 'none'; };
            sel.addEventListener('change', sync); sync();
            var q = $('gr-qual'), w = $('gr-white');
            q.oninput = function () { $('gr-qual-v').textContent = q.value; };
            w.oninput = function () { $('gr-white-v').textContent = w.value; };
            syncMbOpts();
        }
        $('gr-hist-h').onclick = function () { S[mode].histOpen = !S[mode].histOpen; renderHist(); if (S[mode].histOpen) loadHist(); };
    }

    function syncTifOpts() {
        if (mode !== 'mb2tif' || !$('gr-dst-tip')) return;
        var v = $('gr-dstcrs').value, c = chipVal('gr-cmp', 'deflate'), bg = $('gr-bg').value;
        $('gr-dst-tip').innerHTML = v === 'EPSG:3857'
            ? '<i class="fa-solid fa-circle-check" style="color:var(--gr-leaf)"></i> Родная СК тайлов: растр собирается пиксель в пиксель, без перепроецирования.'
            : '<i class="fa-solid fa-arrows-rotate" style="color:var(--gr-amber)"></i> Растр будет перепроецирован из Web Mercator; размер пикселя подбирается по местности.';
        $('gr-cmp-tip').textContent = c === 'jpeg'
            ? (bg === 'none' ? 'JPEG: пустые места хранятся внутренней маской (QGIS/ArcGIS покажут их прозрачными).' : 'JPEG: файл в 5–10 раз меньше, небольшие потери качества.')
            : c === 'none' ? 'Без сжатия файл может быть очень большим.' : 'Сжатие без потерь — каждый пиксель как в тайлах.';
    }

    function syncMbOpts() {
        if (mode !== 'mbtiles') return;
        var f = chipVal('gr-fmt', 'png'), p = $('gr-paper').value;
        $('gr-qwrap').style.display = (f === 'jpg' || f === 'webp') ? '' : 'none';
        $('gr-wwrap').style.display = (p === 'clean' || p === 'transparent' || p === 'auto') ? '' : 'none';
    }

    function setPlaceMode(m) {
        Array.prototype.forEach.call($('gr-pmode').querySelectorAll('[data-pm]'), function (b) { b.classList.toggle('on', b.getAttribute('data-pm') === m); });
        $('gr-pm-point').style.display = m === 'point' ? '' : 'none';
        $('gr-pm-address').style.display = m === 'address' ? '' : 'none';
        if (m !== 'point') stopPick();
        drawPlace();
    }
    function placeMode() { var b = $('gr-pmode') && $('gr-pmode').querySelector('.on'); return b ? b.getAttribute('data-pm') : 'point'; }
    function chipVal(id, d) { var b = $(id) && $(id).querySelector('.gr-chip.on'); return b ? b.getAttribute('data-v') : d; }
    // [v20.1] радиус и масштаб — «авто» по умолчанию; прежние значения по умолчанию (300 м, 1:500) переводятся в «авто»
    function isAuto(v) { return v == null || v === '' || String(v).toLowerCase() === 'auto'; }
    function autoNum(v) { return isAuto(v) ? 'auto' : +v; }
    function prefV201(P, g) {
        var r = P.radius, s = P.scale;
        if (!P.v201) { if (+r === 300) r = null; if (+s === 500) s = null; }
        return { radius: isAuto(r) ? autoNum(g.radius) : +r, scale: isAuto(s) ? autoNum(g.scale) : +s };
    }

    var saveT = null;
    function onChange(e) {
        if (e && e.target && e.target.type === 'file') return;
        if (mode === 'mbtiles') syncMbOpts();
        if (mode === 'mb2tif') syncTifOpts();
        clearTimeout(saveT);
        saveT = setTimeout(function () { if (alive()) savePrefs(mode, formState()); renderRun(); }, 250);
    }

    function parseCenter(v) {
        v = String(v || '').trim(); if (!v) return null;
        var m = v.replace(/[°NnEeСсВв]/g, ' ').split(/[,;\s]+/).filter(Boolean).map(function (t) { return parseFloat(t.replace(',', '.')); });
        if (m.length !== 2 || !isFinite(m[0]) || !isFinite(m[1])) return null;
        var lat = m[0], lon = m[1];
        if (lat >= 10 && lat <= 45 && lon >= 40 && lon <= 70) { var t = lat; lat = lon; lon = t; }   // перепутаны местами
        if (lat < 40 || lat > 70 || lon < 10 || lon > 45) return null;
        return [lat, lon];
    }

    function formState() {
        var st = {};
        if (mode === 'georef') {
            var sx = $('gr-scale-x').value.trim();
            st = {
                pmode: placeMode(), center: $('gr-center').value.trim(), address: $('gr-addr').value.trim(), city: $('gr-city').value.trim(),
                found: found && found.alts ? found : null,
                radius: autoNum(chipVal('gr-radius', 'auto')), scale: sx ? num(sx, 500) : autoNum(chipVal('gr-scale', 'auto')), v201: 1, dpi: $('gr-dpi').value,
                orient: $('gr-orient').value, no_grid: !$('gr-grid').checked, model: $('gr-model').value, no_fine: !$('gr-fine').checked,
                buildings: $('gr-bld').value, ortho: $('gr-ortho').value, zoom: +$('gr-zoom').value, search_angle: num($('gr-sa').value, 2.5),
                search_shift: num($('gr-ss').value, 8), pdf_dpi: $('gr-pdpi').value, pages: $('gr-pages').value.trim() || 'all', adv: $('gr-adv').open,
                mb_off: !$('gr-mb-on').checked, format: chipVal('gr-fmt', 'png'), paper: $('gr-paper').value, zr: $('gr-zr').value.trim(), merge: $('gr-merge').value.trim()
            };
        } else if (mode === 'mb2tif') {
            var dv = $('gr-dstcrs').value;
            st = {
                crs: dv === '__x' ? '' : dv, crs_x: $('gr-dstcrs-x').value.trim(), zoom: $('gr-z2').value, compress: chipVal('gr-cmp', 'deflate'),
                background: $('gr-bg').value, clip: $('gr-clip').value, resampling: $('gr-rs2').value, overviews: $('gr-ovr').checked
            };
        } else {
            var sel = $('gr-srccrs').value;
            st = {
                src_crs: sel === '__x' ? '' : sel, src_crs_x: $('gr-srccrs-x').value.trim(), force: $('gr-force').checked,
                src_nodata: $('gr-nodata').value.trim() === '' ? null : num($('gr-nodata').value, null), name: $('gr-name').value.trim(),
                format: chipVal('gr-fmt', 'png'), paper: $('gr-paper').value, minzoom: $('gr-minz').value === '' ? null : +$('gr-minz').value,
                maxzoom: $('gr-maxz').value === '' ? null : +$('gr-maxz').value, tile_size: +$('gr-ts').value, resampling: $('gr-rs').value,
                merge: $('gr-merge').value.trim(), quality: +$('gr-qual').value, white_threshold: +$('gr-white').value, v203: 1
            };
        }
        return st;
    }

    function readParams() {
        var f = formState(), p;
        if (mode === 'georef') {
            var g = { radius: f.radius, scale: f.scale, dpi: f.dpi || null, orient: f.orient, no_grid: f.no_grid, buildings: f.buildings,
                ortho: f.ortho, zoom: f.zoom, model: f.model, no_fine: f.no_fine, search_angle: f.search_angle, search_shift: f.search_shift };
            if (f.pmode === 'point') {
                var c = parseCenter(f.center);
                if (!c) throw new Error(f.center ? 'Точка: «широта, долгота» в пределах Беларуси и соседних регионов' : 'Укажите место: щёлкните «На карте» или введите координаты');
                g.center = c;
            } else {
                if (!f.address) throw new Error('Введите адрес участка');
                g.address = f.address; g.city = f.city;
                var fp = foundPoint();                   // [v20] найденная точка — сразу как центр поиска
                if (fp) {
                    var fa = found.alts[found.i || 0];
                    g.center = fp; g.place_label = fa.label; g.place_note = fa.note || '';
                    // [v20.1] найденный объект: для улицы сервер берёт все её участки (охват → круг поиска)
                    if (fa.osm) g.place_osm = fa.osm;
                    if (fa.cls) g.place_cls = fa.cls;
                    if (fa.type) g.place_type = fa.type;
                    if (fa.name) g.place_name = fa.name;
                    if (fa.bbox) g.place_bbox = fa.bbox;
                    if (fa.approx) g.place_approx = true;
                }
            }
            if (f.scale !== 'auto' && !(f.scale >= 50 && f.scale <= 50000)) throw new Error('Масштаб: от 1:50 до 1:50000');
            if (f.zr && !/^\d{1,2}(\s*-\s*\d{1,2})?$/.test(f.zr)) throw new Error('Уровни zoom: «мин-макс», например 15-21');
            p = { georef: g, pdf: { dpi: f.pdf_dpi, pages: f.pages }, mbtiles: { enabled: !f.mb_off, format: f.format, paper: f.paper, zoom: f.zr, merge: f.merge } };
        } else if (mode === 'mb2tif') {
            var dcrs = f.crs || f.crs_x;
            if (!dcrs) throw new Error('Укажите СК результата: код EPSG, PROJ-строку или WKT');
            p = { mb2tif: { crs: dcrs, zoom: f.zoom, compress: f.compress, background: f.background, clip: f.clip, resampling: f.resampling, overviews: f.overviews } };
        } else {
            var crs = f.src_crs || f.src_crs_x;
            if (!crs) throw new Error('Укажите СК исходных растров');
            if (f.minzoom != null && f.maxzoom != null && f.minzoom > f.maxzoom) throw new Error('Мин. zoom больше максимального');
            p = { mbtiles: { format: f.format, paper: f.paper, background: f.paper === 'transparent' ? 'none' : 'auto', quality: f.quality,
                resampling: f.resampling, tile_size: f.tile_size, minzoom: f.minzoom, maxzoom: f.maxzoom, white_threshold: f.white_threshold,
                src_crs: crs, force_crs: f.force && crs !== 'auto' ? crs : '', src_nodata: f.src_nodata, name: f.name, merge: f.merge } };
        }
        return p;
    }

    // ── место на карте ──────────────────────────────────────
    function placeLayer() {
        var map = window.map; if (!map || !window.ol) return null;
        if (placeLyr && map.getLayers().getArray().indexOf(placeLyr) >= 0) return placeLyr;
        placeLyr = new ol.layer.Vector({
            source: new ol.source.Vector(), zIndex: 470,
            style: function (f) {
                if (f.get('kind') === 'pt') return new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: '#ff6d00' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }) }) });
                return new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(255,109,0,0.07)' }), stroke: new ol.style.Stroke({ color: '#ff6d00', width: 2, lineDash: [7, 6] }) });
            }
        });
        placeLyr.set('georefPreview', true); placeLyr.set('title', 'Привязка плана: место поиска');
        map.addLayer(placeLyr);
        return placeLyr;
    }
    function clearPlace() { if (placeLyr) placeLyr.getSource().clear(); }
    function drawPlace(fly) {
        if (mode !== 'georef' || !alive()) return;
        var c = placeMode() === 'point' ? parseCenter($('gr-center').value) : foundPoint();
        if (!c) { clearPlace(); return; }
        var L = placeLayer(); if (!L) return;
        var r = autoNum(chipVal('gr-radius', 'auto')), ar = null, pt = ol.proj.fromLonLat([c[1], c[0]]);
        if (r === 'auto') { ar = autoRadius(c, placeMode() === 'point' ? null : curAlt()); r = ar.r; c = ar.c; }
        radiusTip(ar, r);
        var p = ol.proj.fromLonLat([c[1], c[0]]);
        var k = 1 / Math.cos(c[0] * Math.PI / 180);       // метры → единицы Web Mercator
        var ring = [];
        for (var i = 0; i <= 64; i++) { var a = i / 64 * Math.PI * 2; ring.push([p[0] + Math.cos(a) * r * k, p[1] + Math.sin(a) * r * k]); }
        L.getSource().clear();
        L.getSource().addFeatures([new ol.Feature({ geometry: new ol.geom.Polygon([ring]), kind: 'circle' }), new ol.Feature({ geometry: new ol.geom.Point(pt), kind: 'pt' })]);
        if (fly && window.map) fitTo(L.getSource().getExtent(), 17);
    }
    // [v20.1] авто-радиус — оценка для карты; точный считается на сервере по охвату улицы (все её участки) и размеру листа
    var SHEET_HD = 175;                    // м: половина диагонали типового листа 1:500 (A2)
    function curAlt() { return (found && found.alts && found.key === addrKey()) ? found.alts[found.i || 0] : null; }
    function autoRadius(c, a) {
        if (a && a.bbox && (a.approx || a.cls === 'highway')) {
            var b = a.bbox, la = (b[0] + b[1]) / 2;
            var hd = Math.sqrt(Math.pow((b[1] - b[0]) * 111320, 2) + Math.pow((b[3] - b[2]) * 111320 * Math.cos(la * Math.PI / 180), 2)) / 2;
            return { c: [la, (b[2] + b[3]) / 2], r: Math.round(hd + SHEET_HD + 25), what: 'охват улицы ~' + Math.round(hd) + ' м + лист' };
        }
        return a ? { c: c, r: SHEET_HD + 40, what: 'дом + лист' } : { c: c, r: SHEET_HD + 100, what: 'точка ±100 м + лист' };
    }
    function radiusTip(ar, r) {
        var t = $('gr-rtip'); if (!t) return;
        t.textContent = ar ? 'Авто ≈ ' + r + ' м (' + ar.what + '): лист плана целиком внутри круга и захватывает адрес; точный радиус — по размеру листа.'
            : 'Лист плана должен целиком помещаться в круг: меньший радиус будет увеличен до размера листа.';
    }
    // ── [v20] поиск адреса (сервер исправляет опечатки) ─────
    var found = null, findSeq = 0;     // {key, alts:[{lat,lon,label,note,approx}], i} | {key, none|err}
    function addrKey() { return (($('gr-addr') ? $('gr-addr').value : '') + '|' + ($('gr-city') ? $('gr-city').value : '')).trim().toLowerCase().replace(/\s+/g, ' '); }
    function foundPoint() {
        if (!found || !found.alts || !$('gr-addr') || found.key !== addrKey()) return null;
        var a = found.alts[found.i || 0];
        return a ? [a.lat, a.lon] : null;
    }
    function noteOf(x) {
        var n = [];
        if (x._corrected && x._corrected.to) n.push('исправлено: «' + x._corrected.from + '» → «' + x._corrected.to + '»');
        if (x._approx) n.push('дом не найден — взят центр улицы');
        return n.join('; ');
    }
    function findAddress(then, fly) {
        var a = $('gr-addr').value.trim(), c = $('gr-city').value.trim(), key = addrKey(), my = ++findSeq;
        if (a.length < 3) { found = null; renderFound('Введите адрес: улица и номер дома'); return; }
        found = { key: key, busy: true }; renderFound();
        if ($('gr-find')) $('gr-find').disabled = true;
        var url = '/api/geocode?q=' + encodeURIComponent(a) + '&limit=5' + (c ? '&city=' + encodeURIComponent(c) : '') + (window._geoCenterQS ? window._geoCenterQS() : '');
        var init = { credentials: 'same-origin' };
        try { if (window.AbortSignal && AbortSignal.timeout) init.signal = AbortSignal.timeout(30000); } catch (e) {}
        var end = function (ok) { if ($('gr-find')) $('gr-find').disabled = false; if (then) then(ok); };
        fetch(url, init).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (list) {
            if (my !== findSeq || !alive()) return;
            list = (Array.isArray(list) ? list : []).filter(function (x) { return isFinite(+x.lat) && isFinite(+x.lon); });
            if (!list.length) { found = { key: key, none: true }; renderFound(); drawPlace(); end(false); return; }
            found = { key: key, i: 0, alts: list.slice(0, 5).map(function (x) {
                var bb = (x.boundingbox || []).map(Number), nd = x.namedetails || {};
                return { lat: +x.lat, lon: +x.lon, label: x.display_name || a, note: noteOf(x), approx: !!x._approx,
                    osm: (x.osm_type && x.osm_id) ? String(x.osm_type).toLowerCase().replace(/^([nwr])$/, function (m) { return { n: 'node', w: 'way', r: 'relation' }[m]; }) + '/' + x.osm_id : '',
                    cls: x.category || x['class'] || '', type: x.type || '', name: x.name || nd['name:ru'] || nd.name || '',
                    bbox: (bb.length === 4 && bb.every(isFinite)) ? bb : null };
            }) };
            renderFound(); drawPlace(fly !== false); onChange(); end(true);
        }).catch(function (e) {
            if (my !== findSeq || !alive()) return;
            found = { key: key, err: String(e && e.message || e) }; renderFound(); end(null);
        });
    }
    function renderFound(msg) {
        var box = $('gr-found'); if (!box) return;
        if (msg) { box.innerHTML = '<div class="gr-tip">' + esc(msg) + '</div>'; return; }
        if (!found || found.key !== addrKey()) { box.innerHTML = ''; return; }
        if (found.busy) { box.innerHTML = '<div class="gr-found busy"><i class="fa-solid fa-spinner fa-spin"></i><div class="tx">Ищем адрес… при опечатке подбираем похожие улицы — до 15 с</div></div>'; return; }
        if (found.err) { box.innerHTML = '<div class="gr-warn"><b>Поиск адреса недоступен</b>' + esc(found.err) + ' — адрес будет найден при запуске или укажите точку на карте.</div>'; return; }
        if (found.none) {
            box.innerHTML = '<div class="gr-err"><b>Адрес не найден.</b> Проверьте улицу и номер дома (можно без «ул.») или <a href="#" id="gr-to-pick">укажите точку на карте</a>.</div>';
            $('gr-to-pick').onclick = function (e) { e.preventDefault(); setPlaceMode('point'); onChange(); startPick(); };
            return;
        }
        var cur = found.alts[found.i || 0];
        var h = '<div class="gr-found"><i class="fa-solid fa-location-dot"></i><div class="tx"><b>' + esc(cur.label) + '</b>' +
            (cur.note ? '<small>' + esc(cur.note) + '</small>' : '') + '<span class="ll">' + cur.lat.toFixed(6) + ', ' + cur.lon.toFixed(6) + '</span>';
        if (found.alts.length > 1) {
            h += '<div class="gr-alts">' + found.alts.map(function (x, i) {
                return i === (found.i || 0) ? '' : '<button data-i="' + i + '" title="Выбрать этот вариант"><i class="fa-regular fa-circle"></i> ' + esc(x.label) + '</button>';
            }).join('') + '</div>';
        }
        box.innerHTML = h + '</div></div>';
        Array.prototype.forEach.call(box.querySelectorAll('.gr-alts button'), function (b) {
            b.onclick = function () { found.i = +b.getAttribute('data-i'); renderFound(); drawPlace(true); onChange(); };
        });
    }
    function startPick() {
        var map = window.map; if (!map) { toast('Карта ещё загружается', true); return; }
        stopPick();
        var tgt = map.getTargetElement();
        picking = { prevFlag: !!window._msrDrawingActive, prevCursor: tgt.style.cursor };
        window._msrDrawingActive = true;                    // глушим идентификацию объектов на время выбора
        tgt.style.cursor = 'crosshair';
        picking.key = map.on('singleclick', function (e) {
            var ll = ol.proj.toLonLat(e.coordinate);
            if (alive() && $('gr-center')) { $('gr-center').value = ll[1].toFixed(6) + ', ' + ll[0].toFixed(6); drawPlace(); onChange(); }
            stopPick();
        });
        picking.esc = function (e) { if (e.key === 'Escape') stopPick(); };
        document.addEventListener('keydown', picking.esc, true);
        if ($('gr-pick')) $('gr-pick').classList.add('on');
        toast('Щёлкните на карте по участку плана (Esc — отмена)');
    }
    function stopPick() {
        if (!picking) return;
        var map = window.map, p = picking; picking = null;
        if (p.key) ol.Observable.unByKey(p.key);
        document.removeEventListener('keydown', p.esc, true);
        if (map) map.getTargetElement().style.cursor = p.prevCursor || '';
        setTimeout(function () { window._msrDrawingActive = p.prevFlag; }, 350);   // singleclick других модулей приходит с задержкой
        if ($('gr-pick')) $('gr-pick').classList.remove('on');
    }

    // ── файлы ───────────────────────────────────────────────
    function addFiles(list) {
        var acc = (caps.accept && caps.accept[mode]) || [];
        var bad = [];
        Array.prototype.forEach.call(list || [], function (f) {
            var low = f.name.toLowerCase();
            if (!acc.some(function (e) { return low.slice(-e.length) === e; }) && !/\.aux\.xml$/.test(low)) { bad.push(f.name); return; }
            S[mode].files = S[mode].files.filter(function (x) { return x.name.toLowerCase() !== low; });
            S[mode].files.push(f);
        });
        if (S[mode].files.length > (caps.max_files || 60)) { S[mode].files = S[mode].files.slice(0, caps.max_files || 60); toast('Не больше ' + (caps.max_files || 60) + ' файлов за раз', true); }
        if (bad.length) toast('Пропущены (тип не поддерживается): ' + bad.slice(0, 4).join(', ') + (bad.length > 4 ? '…' : ''), true);
        renderFiles(); renderRun();
    }

    function renderFiles() {
        var box = $('gr-files'); if (!box) return;
        var fl = S[mode].files;
        if (!fl.length) { box.innerHTML = ''; return; }
        var h = [];
        if (mode !== 'mbtiles') {
            fl.forEach(function (f, i) {
                var e = ext(f.name), ic = e === 'pdf' ? 'fa-file-pdf' : e === 'zip' ? 'fa-file-zipper' : e === 'mbtiles' ? 'fa-database' : 'fa-file-image';
                h.push('<div class="gr-file"><i class="fa-solid ' + ic + ' k"></i><span class="nm">' + esc(f.name) + '</span><span class="sz">' + fmtSize(f.size) + '</span><button class="x" data-rm="' + i + '" title="Убрать"><i class="fa-solid fa-xmark"></i></button></div>');
            });
        } else {
            var groups = {}, order = [];
            fl.forEach(function (f, i) { var s = stem(f.name).toLowerCase(); if (!groups[s]) { groups[s] = []; order.push(s); } groups[s].push({ f: f, i: i }); });
            order.forEach(function (s) {
                var g = groups[s], exts = g.map(function (x) { return ext(x.f.name); });
                var main = g.find(function (x) { return /^(tiff?|jpe?g|png|zip|7z|rar)$/.test(ext(x.f.name)); });
                var size = g.reduce(function (a, x) { return a + x.f.size; }, 0);
                var chips = exts.map(function (e) { return '<span class="crs-chip">.' + esc(e) + '</span>'; });
                var hasWorld = exts.some(function (e) { return /^(tfw|tfwx|tifw|wld|jgw|jpgw|pgw|pngw)$/.test(e); });
                var note = '';
                if (main && /^(jpe?g|png)$/.test(ext(main.f.name)) && !hasWorld) note = '<span class="crs-chip miss">нет world-файла</span>';
                else if (main && /^tiff?$/.test(ext(main.f.name)) && !hasWorld) note = '<span class="crs-chip opt">привязка из GeoTIFF</span>';
                if (main && !exts.some(function (e) { return e === 'prj' || e === 'aux.xml'; }) && hasWorld) note += '<span class="crs-chip opt">СК — из настройки ниже</span>';
                h.push('<div class="gr-file"><i class="fa-solid ' + (main && /^(zip|7z|rar)$/.test(ext(main.f.name)) ? 'fa-file-zipper' : 'fa-image') + ' k"></i><div style="flex:1;min-width:0"><div class="nm">' + esc(main ? main.f.name : g[0].f.name) + '</div><div class="crs-chips">' + chips.join('') + note + '</div></div><span class="sz">' + fmtSize(size) + '</span>' +
                    '<button class="x" data-rmg="' + esc(s) + '" title="Убрать"><i class="fa-solid fa-xmark"></i></button></div>');
            });
        }
        var total = fl.reduce(function (a, f) { return a + f.size; }, 0);
        h.push('<div class="crs-hint" style="margin-top:5px;display:flex">Файлов: ' + fl.length + ' · ' + fmtSize(total) + '<span style="flex:1"></span><a href="#" id="gr-clear" style="color:var(--gr-coral)">очистить</a></div>');
        box.innerHTML = h.join('');
        Array.prototype.forEach.call(box.querySelectorAll('[data-rm]'), function (b) { b.onclick = function (e) { e.stopPropagation(); S[mode].files.splice(+b.getAttribute('data-rm'), 1); renderFiles(); renderRun(); }; });
        Array.prototype.forEach.call(box.querySelectorAll('[data-rmg]'), function (b) { b.onclick = function (e) { e.stopPropagation(); var s = b.getAttribute('data-rmg'); S[mode].files = S[mode].files.filter(function (f) { return stem(f.name).toLowerCase() !== s; }); renderFiles(); renderRun(); }; });
        $('gr-clear').onclick = function (e) { e.preventDefault(); S[mode].files = []; renderFiles(); renderRun(); };
    }

    // ── запуск ──────────────────────────────────────────────
    function renderRun() {
        var box = $('gr-run'); if (!box) return;
        var s = S[mode], j = s.job, ready = isReady();
        var canRerun = j && !active(j) && !s.files.length && j.status !== 'queued';
        var label = mode === 'georef' ? 'Привязать план' : mode === 'mb2tif' ? 'Собрать GeoTIFF' + (s.files.length > 1 ? ' (' + s.files.length + ')' : '') : 'Нарезать MBTiles';
        if (mode === 'georef' && s.files.length) {
            var pdf = s.files.filter(function (f) { return ext(f.name) === 'pdf'; }).length, img = s.files.length - pdf;
            if (s.files.length > 1) label = 'Привязать ' + s.files.length + ' файла(ов)';
            if (pdf && !img) label = 'Привязать PDF';
        }
        var h = '';
        if (s.xhr) {
            h = '<button class="crs-btn main" disabled><i class="fa-solid fa-spinner fa-spin"></i>Загрузка файлов…</button>' +
                '<div class="crs-prog" style="display:block"><div id="gr-up-bar"></div></div><div class="crs-stat" id="gr-up-stat"></div>' +
                '<div class="gr-acts"><button class="crs-btn sm" id="gr-up-cancel"><i class="fa-solid fa-ban"></i>Прервать загрузку</button></div>';
        } else if (canRerun) {
            h = '<button class="crs-btn main" id="gr-rerun"' + (ready ? '' : ' disabled') + '><i class="fa-solid fa-rotate"></i>Повторить с этими параметрами</button>' +
                '<div class="crs-stat">Файлы задания «' + esc(j.title || '') + '» уже на сервере — загружать заново не нужно. Чтобы обработать другие файлы, добавьте их выше.</div>';
        } else {
            h = '<button class="crs-btn main" id="gr-go"' + (ready && s.files.length && !active(j) ? '' : ' disabled') + '><i class="fa-solid ' + (mode === 'georef' ? 'fa-map-location-dot' : mode === 'mb2tif' ? 'fa-file-image' : 'fa-table-cells') + '"></i>' + label + '</button>' +
                '<div class="crs-stat">' + (active(j) ? 'Дождитесь завершения текущего задания (или отмените его).' : !s.files.length ? (mode === 'georef' ? 'Добавьте скан плана и укажите место.' : mode === 'mb2tif' ? 'Добавьте файл .mbtiles.' : 'Добавьте растры.') : (mode === 'georef' ? 'Обычно 1–3 мин на лист: поиск места → грубая → тонкая привязка → экспорт.' : mode === 'mb2tif' ? 'Обычно секунды — пара минут: зависит от числа тайлов и смены СК.' : 'Обычно несколько секунд — минута.')) + '</div>';
        }
        box.innerHTML = h;
        if ($('gr-go')) $('gr-go').onclick = submit;
        if ($('gr-rerun')) $('gr-rerun').onclick = rerun;
        if ($('gr-up-cancel')) $('gr-up-cancel').onclick = function () { if (s.xhr) s.xhr.abort(); };
    }

    function submit() {
        var s = S[mode], m = mode, p;
        if (s.xhr || !s.files.length) return;
        if (m === 'georef' && placeMode() === 'address' && $('gr-addr').value.trim() && !foundPoint() &&
            !(found && found.key === addrKey() && (found.none || found.err))) {
            if (found && found.busy) return;
            findAddress(function (ok) {
                if (ok === false) toast('Адрес не найден — проверьте написание или укажите точку на карте', true);
                else if (mode === m) submit();
            }, true);
            return;
        }
        if (m === 'georef' && placeMode() === 'address' && found && found.key === addrKey() && found.none) {
            toast('Адрес не найден — проверьте написание или укажите точку на карте', true); return;
        }
        try { p = readParams(); } catch (e) { toast(e.message, true); return; }
        savePrefs(m, formState());
        var fd = new FormData();
        fd.append('kind', m); fd.append('params', JSON.stringify(p));
        fd.append('title', s.files.length === 1 ? s.files[0].name : s.files[0].name + ' +' + (s.files.length - 1));
        s.files.forEach(function (f) { fd.append('files', f, f.name); });
        var x = s.xhr = new XMLHttpRequest();
        x.open('POST', API + '/jobs');
        x.withCredentials = true;
        x.setRequestHeader('X-CSRFToken', csrf());
        x.upload.onprogress = function (e) {
            if (!e.lengthComputable || mode !== m) return;
            var pc = Math.round(e.loaded / e.total * 100);
            if ($('gr-up-bar')) $('gr-up-bar').style.width = pc + '%';
            if ($('gr-up-stat')) $('gr-up-stat').textContent = pc < 100 ? 'Загрузка: ' + pc + '% из ' + fmtSize(e.total) : 'Постановка в очередь…';
        };
        var done = function () { s.xhr = null; if (mode === m) renderRun(); };
        x.onload = function () {
            var d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
            done();
            if (x.status !== 200 || !d || !d.id) { toast('Не удалось запустить: ' + ((d && d.detail) || ('HTTP ' + x.status)), true); return; }
            s.files = []; s.log = ''; s.logNext = 0;
            setJob(m, d);
            if (mode === m) { renderFiles(); renderRun(); }
            toast(m === 'georef' ? 'Задание принято — идёт привязка' : m === 'mb2tif' ? 'Задание принято — собираю GeoTIFF' : 'Задание принято — идёт нарезка');
            s.hist = null; if (s.histOpen) loadHist();
        };
        x.onerror = function () { done(); toast('Сеть недоступна или файлы слишком большие', true); };
        x.onabort = function () { done(); toast('Загрузка прервана'); };
        renderRun();
        x.send(fd);
    }

    function rerun() {
        var s = S[mode], m = mode, j = s.job, p;
        if (!j) return;
        try { p = readParams(); } catch (e) { toast(e.message, true); return; }
        savePrefs(m, formState());
        $('gr-rerun').disabled = true;
        api('/jobs/' + j.id + '/rerun', { method: 'POST', json: { params: p } }).then(function (d) {
            s.log = ''; s.logNext = 0;
            setJob(m, d); toast('Повтор запущен (версия ' + (d.version || 2) + ')');
            s.hist = null; if (s.histOpen) loadHist();
        }).catch(function (e) {
            toast('Повтор не запущен: ' + e.message, true);
            if (e.status === 410) { s.job = null; }
            if (mode === m) renderRun();
        });
    }

    function setJob(m, j) {
        var s = S[m];
        if (s.job && s.job.id !== j.id) { s.log = ''; s.logNext = 0; }
        var fresh = !s.job || s.job.id !== j.id;
        s.job = j;
        if (mode === m && alive()) {
            renderJob(); renderRun();
            if (fresh && active(j) && $('gr-job-card')) $('gr-job-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (active(j)) schedule(m, 300);
    }

    function schedule(m, ms) {
        var s = S[m];
        clearTimeout(s.timer);
        s.timer = setTimeout(function () { poll(m); }, ms);
    }

    function poll(m) {
        var s = S[m], j = s.job;
        s.timer = null;
        if (!j || !alive()) return;                         // панель закрыта — продолжим при открытии
        api('/jobs/' + j.id).then(function (d) {
            if (!s.job || s.job.id !== d.id) return;
            var was = s.job.status;
            s.job = d;
            if (mode === m) { renderJob(true); if (was !== d.status) renderRun(); }
            if (s.logOpen) pullLog(m);
            if (active(d)) { schedule(m, d.status === 'queued' ? 2500 : 1300); return; }
            if (was !== d.status) finished(m, d);
        }).catch(function (e) {
            if (e.status === 404) { s.job = null; if (mode === m) { renderJob(); renderRun(); } return; }
            schedule(m, 4000);
        });
    }

    function finished(m, d) {
        S[m].hist = null; if (S[m].histOpen && mode === m) loadHist();
        if (d.status === 'done') {
            var res = d.result || {};
            if (m === 'georef') {
                var ok = (res.sheets || []).filter(function (x) { return x.registered; }).length;
                toast('Привязка готова: ' + ok + ' из ' + (res.sheets || []).length + ' лист(ов)', !ok);
            } else if (m === 'mb2tif') toast('GeoTIFF готовы: ' + (res.outputs || []).length);
            else toast('MBTiles готовы: ' + (res.mbtiles || []).length);
            if (mode === m && alive()) showAll(d, true);
        } else if (d.status === 'error') toast('Ошибка: ' + (d.error || 'обработка не удалась'), true);
    }

    function cancelJob() {
        var j = S[mode].job; if (!j) return;
        api('/jobs/' + j.id + '/cancel', { method: 'POST' }).then(function () { toast('Отмена…'); poll(mode); }).catch(function (e) { toast(e.message, true); });
    }

    function pullLog(m) {
        var s = S[m], j = s.job; if (!j || s.logBusy) return;
        s.logBusy = true;
        api('/jobs/' + j.id + '/log?offset=' + (s.logNext || 0)).then(function (d) {
            s.logBusy = false;
            if (!s.job || s.job.id !== j.id) return;
            if (d.text) { s.log = (s.log + d.text).slice(-200000); }
            s.logNext = d.next || s.logNext;
            var pre = $('gr-log');
            if (pre && mode === m) { var stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20; pre.textContent = s.log || '(пусто)'; if (stick) pre.scrollTop = pre.scrollHeight; }
        }).catch(function () { s.logBusy = false; });
    }

    // ── ход работы ──────────────────────────────────────────
    function renderJob(soft) {
        var card = $('gr-job-card'), s = S[mode], j = s.job;
        if (!card) return;
        if (!j) { card.style.display = 'none'; renderResults(); return; }
        card.style.display = '';
        var stages = j.stages || (caps.stages && caps.stages[j.kind || mode]) || [];
        var si = j.status === 'done' ? stages.length : (j.stage_index == null ? -1 : j.stage_index);
        var pct = j.status === 'done' ? 100 : Math.max(0, Math.min(100, j.progress || 0));
        var el = j.elapsed_s || (j.started ? Math.max(0, Date.now() / 1000 - j.started) : 0);
        var steps = stages.map(function (t, i) {
            var cls = i < si ? 'done' : i === si ? (j.status === 'error' ? 'fail' : active(j) ? 'cur' : 'done') : '';
            if (j.status === 'error' && i === si) cls = 'fail';
            var ic = cls === 'done' ? 'fa-solid fa-circle-check' : cls === 'cur' ? 'fa-solid fa-spinner fa-spin' : cls === 'fail' ? 'fa-solid fa-circle-xmark' : 'fa-regular fa-circle';
            return '<li class="' + cls + '"><i class="' + ic + '"></i>' + esc(t) + '</li>';
        }).join('');
        var meta = [];
        if (j.status === 'queued') meta.push('<span><i class="fa-solid fa-hourglass-half"></i> ' + (j.queue_pos ? 'в очереди: ' + j.queue_pos + '-й' : 'в очереди') + '</span>');
        if (active(j) || j.status === 'done') meta.push('<span><b>' + pct + '%</b></span>');
        if (j.status === 'running' && j.eta_s) meta.push('<span>осталось ≈ ' + fmtDur(j.eta_s) + '</span>');
        if (el && j.status !== 'queued') meta.push('<span>' + (active(j) ? 'идёт ' : 'заняло ') + fmtDur(el) + '</span>');
        if (j.version > 1) meta.push('<span>версия ' + j.version + '</span>');
        var html =
            '<div class="crs-h" style="margin-bottom:4px"><i class="fa-solid fa-gears" style="color:var(--gr-amber)"></i>Ход работы<span class="sp"></span><span class="gr-st ' + j.status + '">' + (ST_TEXT[j.status] || j.status) + '</span></div>' +
            '<div class="gr-jh" style="font-weight:700;font-size:11.5px;color:var(--gr-muted)">' + esc(j.title || '') + ' · ' + fmtDate(j.created) + '</div>' +
            '<ol class="gr-steps">' + steps + '</ol>' +
            '<div class="crs-prog" style="display:block"><div style="width:' + pct + '%"></div></div>' +
            '<div class="gr-meta">' + meta.join('') + '</div>' +
            (active(j) ? '<div class="gr-msg">' + esc(j.stage && j.stage !== stages[si] ? j.stage : (j.last_message || '')) + '</div>' : '') +
            (j.status === 'error' ? '<div class="gr-err"><b>Не получилось:</b> ' + esc(cleanErr(j.error) || 'неизвестная ошибка') + hintFor(j) + crsPicks(j) + '</div>' : '') +
            (j.status === 'cancelled' ? '<div class="gr-msg">' + esc(j.error || 'Задание отменено') + '</div>' : '') +
            '<div class="gr-acts">' + (active(j) ? '<button class="crs-btn sm" id="gr-cancel"><i class="fa-solid fa-ban"></i>Отменить</button>' : '') +
            '<button class="crs-btn sm' + (s.logOpen ? ' on' : '') + '" id="gr-logbtn"><i class="fa-solid fa-terminal"></i>Журнал</button>' +
            (!active(j) ? '<button class="crs-btn sm" id="gr-new" title="Начать заново: убрать задание из панели"><i class="fa-solid fa-plus"></i>Новое</button>' : '') + '</div>' +
            '<pre class="gr-log" id="gr-log"' + (s.logOpen ? '' : ' hidden') + '>' + esc(s.log || 'Загрузка журнала…') + '</pre>';
        if (soft && card.getAttribute('data-sig') === j.id + j.status + pct + si + (j.queue_pos || '') + Math.round(j.eta_s || 0) + Math.round(el) + s.logOpen) return;
        card.setAttribute('data-sig', j.id + j.status + pct + si + (j.queue_pos || '') + Math.round(j.eta_s || 0) + Math.round(el) + s.logOpen);
        var pre = $('gr-log'), keep = pre ? pre.scrollTop : 0;
        card.innerHTML = html;
        if ($('gr-log') && s.logOpen) $('gr-log').scrollTop = keep || $('gr-log').scrollHeight;
        if ($('gr-cancel')) $('gr-cancel').onclick = cancelJob;
        $('gr-logbtn').onclick = function () { s.logOpen = !s.logOpen; renderJob(); if (s.logOpen) pullLog(mode); };
        if ($('gr-new')) $('gr-new').onclick = function () { hideJob(j.id); s.job = null; s.log = ''; s.logNext = 0; renderJob(); renderRun(); };
        Array.prototype.forEach.call(card.querySelectorAll('[data-crspick]'), function (b) {      // [v20.3] повтор с выбранной СК
            b.onclick = function () {
                var c = b.getAttribute('data-crspick'), sel = $('gr-srccrs');
                if (!sel) { toast('Выберите СК в форме и запустите снова', true); return; }
                if (Array.prototype.some.call(sel.options, function (o) { return o.value === c; })) sel.value = c;
                else { sel.value = '__x'; $('gr-srccrs-x').value = c; }
                sel.dispatchEvent(new Event('change'));
                if ($('gr-rerun') && !$('gr-rerun').disabled) rerun(); else toast('СК выбрана — запустите задание снова');
            };
        });
        if (!soft || card.getAttribute('data-res') !== j.id + j.status) { card.setAttribute('data-res', j.id + j.status); renderResults(); }
    }

    function cleanErr(e) {     // подсказки командной строки (--center …) пользователю не нужны
        return String(e || '').replace(/\.?\s*(Задайте|Укажите)\s+--[a-z]+[^.]*?(\.|$)/g, '.').replace(/\s*\(для OCR[^)]*\)/, '').replace(/\s*\(--[a-z-]+\)/g, '').replace(/\.\.$/, '.').trim();
    }
    function crsPicks(j) {       // [v20.3] «подходят к нескольким СК: … (EPSG:N); …» → кнопки повтора с СК
        if ((j.kind || mode) !== 'mbtiles') return '';
        var e = String(j.error || ''), i = e.indexOf('нескольким СК:');
        if (i < 0) return '';
        var part = e.slice(i + 14).split(' - ')[0], re = /\s*([^;]+?)\s*\((EPSG:\d{4,5})\)/g, m, out = [], seen = {};
        while ((m = re.exec(part)) && out.length < 6) {
            if (seen[m[2]]) continue;
            seen[m[2]] = 1;
            out.push('<button class="crs-btn sm" data-crspick="' + esc(m[2]) + '" title="Повторить с ' + esc(m[2]) + '">' + esc(m[1]) + '</button>');
        }
        return out.length ? '<div class="gr-crs-picks">' + out.join('') + '</div><div class="crs-hint" style="margin-top:4px">Нажмите СК — задание повторится с ней без повторной загрузки файлов.</div>' : '';
    }
    function hintFor(j) {
        var e = String(j.error || '').toLowerCase();
        if (/адрес|геокод|nominatim/.test(e)) return '<br><i>Совет:</i> проверьте написание улицы и номер дома или выберите «Точка на карте» и щёлкните участок.';
        if (/не найден|не удалось найти|мало зданий|совпад/.test(e)) return '<br><i>Совет:</i> уточните точку, увеличьте радиус или проверьте масштаб плана.';
        if (/сеть|timeout|timed out|connection|http/.test(e)) return '<br><i>Совет:</i> сервер не смог получить ортофото/контуры — повторите позже или смените источник.';
        return '';
    }

    // ── результаты ──────────────────────────────────────────
    function mbOfSheet(res, sh) {
        if (sh.mbtiles) return sh.mbtiles;
        var m = (res.mbtiles || []).find(function (x) { return (x.sources || []).some(function (s) { return stem(String(s).replace(/^.*[\\/]/, '')) === sh.name; }); });
        return m ? m.file : null;
    }
    function mbInfo(res, file) { return (res.mbtiles || []).find(function (x) { return x.file === file; }) || {}; }

    function renderResults() {
        var card = $('gr-res-card'), j = S[mode].job;
        if (!card) return;
        if (!j || j.status !== 'done' || !j.result) { card.style.display = 'none'; card.innerHTML = ''; return; }
        card.style.display = '';
        var res = j.result, h = [];
        var files = (j.files || []).reduce(function (a, f) { a[f.name] = f; return a; }, {});
        h.push('<div class="crs-h"><i class="fa-solid fa-flag-checkered" style="color:var(--gr-amber)"></i>Результат<span class="sp"></span>' +
            '<button class="crs-btn sm" id="gr-allmap" title="Показать все результаты на карте"><i class="fa-solid fa-map"></i>На карте</button></div>');
        if (j.kind === 'georef' || res.kind === 'georef') {
            var sheets = res.sheets || [], ok = sheets.filter(function (x) { return x.registered; });
            var c = res.center || {};
            h.push('<div class="gr-sum">Привязано листов: <b>' + ok.length + ' из ' + sheets.length + '</b> · СК результата: <b>' + esc(res.crs || 'EPSG:3857') + '</b> (Web Mercator)' +
                (res.place && res.place.label ? '<br>Адрес: <b>' + esc(res.place.label) + '</b>' + (res.place.note ? ' <span class="fix">(' + esc(res.place.note) + ')</span>' : '') : '') +
                (c.lat ? '<br>Место: ' + (+c.lat).toFixed(5) + ', ' + (+c.lon).toFixed(5) + (c.radius_m ? ' · <span title="' + esc(c.radius_note || '') + '">радиус ' + Math.round(c.radius_m) + ' м' +
                    (/^авто/.test(c.radius_note || '') ? ' (авто)' : /увеличен/.test(c.radius_note || '') ? ' (увеличен до размера листа)' : '') + '</span>' : '') +
                    (c.area && c.area.kind === 'street' && c.area.radius_m ? ' · охват улицы ' + Math.round(c.area.radius_m) + ' м' : '') : '') +
                (res.sources ? '<br>Контуры: ' + esc(res.sources.buildings || '') + ' · ортофото: ' + esc(res.sources.ortho || '') : '') + '</div>');
            (res.warnings || []).slice(0, 6).forEach(function (w) { h.push('<div class="crs-note">' + esc(String(w).replace(/^ВНИМАНИЕ:\s*/, '')) + '</div>'); });
            sheets.forEach(function (sh, i) { h.push(sheetHtml(j, res, sh, i, files)); });
            h.push('<div class="gr-acts" style="margin-top:9px">' +
                '<a class="crs-btn dl" href="' + API + '/jobs/' + j.id + '/zip?what=all"><i class="fa-solid fa-file-zipper"></i>Всё (ZIP)</a>' +
                '<a class="crs-btn sm" href="' + API + '/jobs/' + j.id + '/zip?what=gis" title="GeoTIFF + TFW + PRJ + AUX + OVR"><i class="fa-solid fa-file-zipper"></i>GeoTIFF/TFW</a>' +
                ((res.mbtiles || []).length ? '<a class="crs-btn sm" href="' + API + '/jobs/' + j.id + '/zip?what=mbtiles"><i class="fa-solid fa-file-zipper"></i>MBTiles</a>' : '') +
                (res.qa ? '<button class="crs-btn sm" data-qa="' + esc(res.qa) + '"' + (res.qa_outdated ? ' title="Снимок контроля сделан до ручного сдвига"' : '') + '><i class="fa-solid fa-eye"></i>Контроль' + (res.qa_outdated ? ' (до сдвига)' : '') + '</button>' : '') +
                (files['report.txt'] ? '<a class="crs-btn sm" target="_blank" rel="noopener" href="' + fileUrl(j.id, 'report.txt', true) + '"><i class="fa-solid fa-file-lines"></i>Отчёт</a>' : '') + '</div>');
        } else if (j.kind === 'mb2tif' || res.kind === 'mb2tif') {
            var outs = res.outputs || [], crs0 = outs.length ? (outs[0].crs_name || outs[0].crs) : '';
            h.push('<div class="gr-sum">Готово GeoTIFF: <b>' + outs.length + '</b>' + (crs0 ? ' · СК: <b>' + esc(crs0) + '</b>' : '') + (res.elapsed_s ? ' · за ' + fmtDur(res.elapsed_s) : '') +
                '<br>В комплекте у каждого: .tif + .tfw + .tfwx + .prj</div>');
            (res.warnings || []).slice(0, 6).forEach(function (w) { h.push('<div class="crs-note">' + esc(String(w).replace(/^ВНИМАНИЕ:\s*/, '')) + '</div>'); });
            outs.forEach(function (o, i) { h.push(tifHtml(j, o, i, files)); });
            if (outs.length > 1) h.push('<div class="gr-acts" style="margin-top:9px"><a class="crs-btn dl" href="' + API + '/jobs/' + j.id + '/zip?what=all"><i class="fa-solid fa-file-zipper"></i>Все GeoTIFF (ZIP)</a></div>');
        } else {
            var list = res.mbtiles || [];
            h.push('<div class="gr-sum">Готово файлов MBTiles: <b>' + list.length + '</b>' + (res.elapsed_s ? ' · за ' + fmtDur(res.elapsed_s) : '') + '</div>');
            (res.warnings || []).slice(0, 6).forEach(function (w) { h.push('<div class="crs-note">' + esc(w) + '</div>'); });
            list.forEach(function (m, i) { h.push(mbHtml(j, m, i)); });
            if (list.length > 1) h.push('<div class="gr-acts" style="margin-top:9px"><a class="crs-btn dl" href="' + API + '/jobs/' + j.id + '/zip?what=mbtiles"><i class="fa-solid fa-file-zipper"></i>Все MBTiles (ZIP)</a></div>');
        }
        card.innerHTML = h.join('');
        bindResults(card, j);
    }

    function sheetHtml(j, res, sh, i, files) {
        if (!sh.registered) {
            return '<div class="gr-sheet err"><div class="t"><i class="fa-solid fa-circle-xmark" style="color:var(--gr-coral)"></i>' + esc(sh.name) + '</div>' +
                '<div class="gr-qt">Лист не привязан. Уточните место (точку/радиус) и масштаб, затем «Повторить с этими параметрами».' + (sh.source && sh.source.page ? ' Источник: ' + esc(sh.source.file) + ', стр. ' + sh.source.page : '') + '</div></div>';
        }
        var q = sh.quality || 'check', key = j.id + ':' + sh.name, on = !!shown[key];
        var sd = sh.scale_denominator || [], mpp = sh.m_per_px || [];
        var fscale = sd.length ? '1:' + Math.round((sd[0] + (sd[1] || sd[0])) / 2) : '—';
        var pf = +sh.paper_factor || 1, scaled = Math.abs(pf - 1) > 0.03;          // [v20.1] масштаб плана, лист ×1.41
        var scale = sh.plan_scale ? '1:' + Math.round(sh.plan_scale) + (scaled ? ' · лист ×' + pf.toFixed(2) : '') : fscale;
        var stip = [sh.scale_source ? 'масштаб плана: ' + sh.scale_source : '',
            scaled ? 'лист файла увеличен/уменьшен в ' + pf.toFixed(3) + ' раза относительно бумажного оригинала (по сетке); на листе файла ' + fscale : '',
            sh.north_hint && sh.north_hint.src ? 'север: ' + sh.north_hint.src : ''].filter(Boolean).join('; ');
        var mb = mbOfSheet(res, sh), mi = mb ? mbInfo(res, mb) : {};
        var src = sh.source || {};
        var dl = (sh.files || []).map(function (n) {
            var e = /\.tif\.aux\.xml$/i.test(n) ? 'AUX.XML' : /\.tif\.ovr$/i.test(n) ? 'OVR' : ext(n).toUpperCase();
            return '<a href="' + fileUrl(j.id, n) + '" title="' + esc((files[n] && files[n].label) || n) + (files[n] ? ' · ' + fmtSize(files[n].size) : '') + '" download>' + esc(e) + '</a>';
        }).join('');
        return '<div class="gr-sheet"><div class="t"><i class="fa-solid fa-map" style="color:color-mix(in srgb,' + Q_COLOR[q] + ' 68%,var(--gr-ink))"></i>' + esc(sh.name) +
            '<span class="gr-q" style="background:' + Q_COLOR[q] + '">' + (Q_TEXT[q] || q) + '</span></div>' +
            '<div class="gr-qt">' + esc(sh.quality_text || '') + '</div>' +
            '<div class="gr-facts">' +
            '<div title="' + esc(stip) + '">Масштаб <b>' + esc(scale) + '</b></div>' +
            '<div>Пиксель <b>' + (mpp.length ? (+mpp[0]).toFixed(3) + ' м' : '—') + '</b></div>' +
            '<div>Поворот <b>' + (sh.rotation_deg != null ? (+sh.rotation_deg).toFixed(2) + '°' : '—') + '</b></div>' +
            '<div>Модель <b>' + ({ rigid: 'жёсткая', similarity: 'подобие', affine: 'аффинная' }[sh.model] || esc(sh.model || '—')) + '</b></div>' +
            (sh.coarse_to_final_m != null ? '<div>Уточнение <b>' + (+sh.coarse_to_final_m).toFixed(1) + ' м</b></div>' : '') +
            (src.file ? '<div title="' + esc(src.file) + '">Источник <b>' + esc(src.page ? 'стр. ' + src.page + (src.dpi ? ', ' + Math.round(src.dpi) + ' dpi' : '') : (sh.dpi ? Math.round(sh.dpi) + ' dpi' : '')) + '</b></div>' : '') +
            (mi.minzoom != null ? '<div>MBTiles <b>z' + mi.minzoom + '–' + mi.maxzoom + ', ' + (mi.size_mb != null ? mi.size_mb + ' МБ' : '') + '</b></div>' : '') +
            (sh.shift_m ? '<div style="grid-column:1/3" title="Ручной сдвиг от автопривязки">Сдвиг вручную <b>восток ' + fmtM(sh.shift_m[0]) + ', север ' + fmtM(sh.shift_m[1]) + '</b></div>' : '') +
            '</div>' +
            '<div class="gr-acts">' +
            '<button class="crs-btn sm' + (on ? ' on' : '') + '" data-show="' + i + '"><i class="fa-solid ' + (on ? 'fa-eye-slash' : 'fa-eye') + '"></i>' + (on ? 'Скрыть' : 'На карте') + '</button>' +
            '<button class="crs-btn sm" data-fit="' + i + '" title="Приблизить к листу"><i class="fa-solid fa-expand"></i></button>' +
            '<button class="crs-btn sm" data-tocrs="' + i + '" title="GeoTIFF + TFW + PRJ → вкладка «Смена СК» (СК-42, СК-63, UTM…)"><i class="fa-solid fa-earth-europe"></i>В конвертер СК</button>' +
            (mb && caps.can_register ? '<button class="crs-btn sm" data-reg="' + esc(mb) + '" data-regname="' + esc(sh.name) + '" title="Добавить MBTiles в папку «MBTILES MINSK»"><i class="fa-solid fa-layer-group"></i>' + (j.registered && j.registered[mb] ? 'В слоях ✓' : 'В слои') + '</button>' : '') +
            '<button class="crs-btn sm' + (mv && mv.key === key ? ' on' : '') + '" data-move="' + i + '" title="Перетащить лист на карте или задать точный сдвиг — GeoTIFF/TFW/MBTiles пересохраняются"><i class="fa-solid fa-up-down-left-right"></i>Переместить</button>' +
            '</div>' + (mv && mv.key === key ? mvHtml(sh) : '') +
            (on ? '<div class="gr-op"><i class="fa-solid fa-circle-half-stroke"></i>Прозрачность<input type="range" min="10" max="100" value="' + Math.round((shown[key].op || 0.8) * 100) + '" data-op="' + esc(key) + '"></div>' : '') +
            '<div class="gr-dl">' + dl + '<a href="' + API + '/jobs/' + j.id + '/zip?what=all&sheet=' + encodeURIComponent(sh.name) + '" title="Все файлы листа">ZIP листа</a></div>' +
            (!mb ? '<div class="gr-tip">MBTiles не нарезаны — на карте показан только контур листа.</div>' : '') +
            '</div>';
    }

    function mbHtml(j, m, i) {
        var key = j.id + ':' + m.file, on = !!shown[key];
        return '<div class="gr-sheet"><div class="t"><i class="fa-solid fa-table-cells" style="color:var(--gr-amber)"></i>' + esc(m.file) + '</div>' +
            '<div class="gr-facts">' +
            '<div>Уровни <b>z' + m.minzoom + '–' + m.maxzoom + '</b></div><div>Тайлов <b>' + (m.tiles || 0).toLocaleString('ru-RU') + '</b></div>' +
            '<div>Размер <b>' + (m.size_mb != null ? m.size_mb + ' МБ' : '—') + '</b></div><div>Формат <b>' + esc(String(m.format || '').toUpperCase()) + ', ' + (m.tile_size || 256) + ' px</b></div>' +
            '<div style="grid-column:1/3">СК исходника <b>' + esc((m.src_crs || []).join('; ') || '—') + '</b>' + (m.reprojected ? ' → EPSG:3857' : '') +
                ((m.how_crs || []).some(function (h) { return /по координатам/.test(h); }) ? ' <span style="color:var(--gr-amber)">(в файле не было — по координатам)</span>' : '') + '</div>' +
            (m.shift_m ? '<div style="grid-column:1/3">Сдвиг вручную <b>восток ' + fmtM(m.shift_m[0]) + ', север ' + fmtM(m.shift_m[1]) + '</b></div>' : '') +
            ((m.sources || []).length ? '<div style="grid-column:1/3">Растры <b>' + esc(m.sources.map(function (s) { return String(s).replace(/^.*[\\/]/, ''); }).join(', ')) + '</b></div>' : '') +
            '</div><div class="gr-acts">' +
            '<button class="crs-btn sm' + (on ? ' on' : '') + '" data-mshow="' + i + '"><i class="fa-solid ' + (on ? 'fa-eye-slash' : 'fa-eye') + '"></i>' + (on ? 'Скрыть' : 'На карте') + '</button>' +
            '<button class="crs-btn sm" data-mfit="' + i + '"><i class="fa-solid fa-expand"></i></button>' +
            '<a class="crs-btn dl" href="' + fileUrl(j.id, m.file) + '" download><i class="fa-solid fa-download"></i>Скачать</a>' +
            (caps.can_register ? '<button class="crs-btn sm" data-reg="' + esc(m.file) + '" data-regname="' + esc(stem(m.file)) + '"><i class="fa-solid fa-layer-group"></i>' + (j.registered && j.registered[m.file] ? 'В слоях ✓' : 'В слои') + '</button>' : '') +
            '<button class="crs-btn sm' + (mv && mv.key === key ? ' on' : '') + '" data-mmove="' + i + '" title="Перетащить на карте или задать точный сдвиг — MBTiles нарезается заново"><i class="fa-solid fa-up-down-left-right"></i>Переместить</button>' +
            '</div>' + (mv && mv.key === key ? mvHtml(m) : '') + (on ? '<div class="gr-op"><i class="fa-solid fa-circle-half-stroke"></i>Прозрачность<input type="range" min="10" max="100" value="' + Math.round((shown[key].op || 0.85) * 100) + '" data-op="' + esc(key) + '"></div>' : '') + '</div>';
    }

    function tifHtml(j, o, i, files) {          // [v20] MBTiles → GeoTIFF
        var key = j.id + ':' + o.file, on = !!shown[key];
        var px = o.pixel || [], geo = o.pixel_units === '°';
        var pxs = px.length ? (geo ? (+px[0]).toExponential(3) + '°' : (+px[0]).toFixed(px[0] < 1 ? 3 : 2).replace('.', ',') + ' м') : '—';
        var cmp = { deflate: 'Deflate', lzw: 'LZW', jpeg: 'JPEG', none: 'без сжатия' }[o.compress] || o.compress || '—';
        var alpha = o.alpha ? 'альфа-канал' : (o.compress === 'jpeg' && (o.background || 'none') === 'none') ? 'маска' : 'фон ' + ({ white: 'белый', black: 'чёрный' }[o.background] || o.background || '');
        var dl = (o.files || []).filter(function (n) { return !/_preview\.png$/i.test(n); }).map(function (n) {
            return '<a href="' + fileUrl(j.id, n) + '" title="' + esc((files[n] && files[n].label) || n) + (files[n] ? ' · ' + fmtSize(files[n].size) : '') + '" download>' + esc(ext(n).toUpperCase()) + '</a>';
        }).join('');
        return '<div class="gr-sheet"><div class="t"><i class="fa-solid fa-file-image" style="color:var(--gr-amber)"></i>' + esc(o.file) +
            (o.reprojected ? '<span class="gr-q" style="background:#f2c15e">перепроецирован</span>' : '<span class="gr-q" style="background:#a9d46b">пиксель в пиксель</span>') + '</div>' +
            '<div class="gr-facts">' +
            '<div>Размер <b>' + (o.width || 0).toLocaleString('ru-RU') + '×' + (o.height || 0).toLocaleString('ru-RU') + ' px</b></div>' +
            '<div>Файл <b>' + (o.size_mb != null ? String(o.size_mb).replace('.', ',') + ' МБ' : '—') + '</b></div>' +
            '<div>Пиксель <b>' + pxs + '</b>' + (geo && o.pixel_m ? ' (≈' + String(o.pixel_m).replace('.', ',') + ' м)' : '') + '</div>' +
            '<div>Уровень <b>z' + o.zoom + '</b>' + (o.zooms && o.zooms[0] !== o.zooms[1] ? ' из z' + o.zooms[0] + '–' + o.zooms[1] : '') + '</div>' +
            '<div>Сжатие <b>' + esc(cmp) + '</b>, ' + esc(alpha) + '</div>' +
            '<div>Тайлов <b>' + (o.tiles || 0).toLocaleString('ru-RU') + '</b> · ' + esc(String(o.format || '').toUpperCase()) + '</div>' +
            '<div style="grid-column:1/3">СК <b>' + esc(o.crs_name || o.crs || '—') + '</b></div>' +
            '<div style="grid-column:1/3">Источник <b>' + esc(o.source || '') + '</b>' + (o.title && o.title !== stem(o.source || '') ? ' · «' + esc(o.title) + '»' : '') + '</div>' +
            (o.shift_m ? '<div style="grid-column:1/3" title="Ручной сдвиг от исходного положения MBTiles">Сдвиг вручную <b>восток ' + fmtM(o.shift_m[0]) + ', север ' + fmtM(o.shift_m[1]) + '</b></div>' : '') +
            '</div><div class="gr-acts">' +
            (o.preview ? '<button class="crs-btn sm' + (on ? ' on' : '') + '" data-tshow="' + i + '"><i class="fa-solid ' + (on ? 'fa-eye-slash' : 'fa-eye') + '"></i>' + (on ? 'Скрыть' : 'На карте') + '</button>' +
                '<button class="crs-btn sm" data-tfit="' + i + '" title="Приблизить"><i class="fa-solid fa-expand"></i></button>' +
                '<button class="crs-btn sm" data-tview="' + i + '" title="Просмотр (уменьшенная копия)"><i class="fa-solid fa-image"></i>Просмотр</button>' : '') +
            '<button class="crs-btn sm" data-ttocrs="' + i + '" title="GeoTIFF + TFW + PRJ → вкладка «Смена СК»"><i class="fa-solid fa-earth-europe"></i>В конвертер СК</button>' +
            (o.preview ? '<button class="crs-btn sm' + (mv && mv.key === key ? ' on' : '') + '" data-tmove="' + i + '" title="Перетащить на карте или задать точный сдвиг — привязка GeoTIFF/TFW/TFWX пересохраняется, из исходного MBTiles собирается сдвинутый MBTiles"><i class="fa-solid fa-up-down-left-right"></i>Переместить</button>' : '') +
            '<a class="crs-btn dl" href="' + API + '/jobs/' + j.id + '/zip?what=all&sheet=' + encodeURIComponent(o.name || stem(o.file)) + '"><i class="fa-solid fa-file-zipper"></i>TIFF + TFWX (ZIP)</a>' +
            '</div>' + (mv && mv.key === key ? mvHtml(o) : '') + mbsHtml(j, o) + (on ? '<div class="gr-op"><i class="fa-solid fa-circle-half-stroke"></i>Прозрачность<input type="range" min="10" max="100" value="' + Math.round((shown[key].op || 0.85) * 100) + '" data-op="' + esc(key) + '"></div>' : '') +
            '<div class="gr-dl">' + dl + '</div></div>';
    }

    function mbsHtml(j, o) {                   // [v20.7] «<имя>_сдвиг.mbtiles» — исходный MBTiles, сдвинутый целиком
        var ms = o.mbtiles_shifted; if (!ms || !ms.file) return '';
        return '<div class="gr-mbs"><i class="fa-solid fa-table-cells"></i>MBTiles со сдвигом: <b>' + esc(ms.file) + '</b>' +
            ' · z' + ((ms.zooms || [])[0] != null ? ms.zooms[0] + '–' + ms.zooms[1] : '?') + ', ' + (ms.tiles || 0).toLocaleString('ru-RU') + ' тайлов' +
            (ms.size_mb != null ? ', ' + String(ms.size_mb).replace('.', ',') + ' МБ' : '') +
            '<div class="a"><a class="crs-btn dl" href="' + fileUrl(j.id, ms.file) + (ms.v ? '?v=' + ms.v : '') + '" download="' + esc(ms.file) + '"><i class="fa-solid fa-download"></i>Скачать MBTiles</a>' +
            (caps.can_register ? '<button class="crs-btn sm" data-reg="' + esc(ms.file) + '" data-regname="' + esc(o.name || stem(o.file)) + '" title="Добавить сдвинутый MBTiles в папку «MBTILES MINSK»"><i class="fa-solid fa-layer-group"></i>' + (j.registered && j.registered[ms.file] ? 'В слоях ✓' : 'В слои') + '</button>' : '') +
            '</div></div>';
    }

    function bindResults(card, j) {
        var res = j.result || {};
        var each = function (sel, fn) { Array.prototype.forEach.call(card.querySelectorAll(sel), fn); };
        each('[data-show]', function (b) { b.onclick = function () { var sh = res.sheets[+b.getAttribute('data-show')]; toggleSheet(j, sh); renderResults(); }; });
        each('[data-fit]', function (b) { b.onclick = function () { var sh = res.sheets[+b.getAttribute('data-fit')]; if (!shown[j.id + ':' + sh.name]) { toggleSheet(j, sh); renderResults(); } fitTo(sheetExtent(sh)); }; });
        each('[data-mshow]', function (b) { b.onclick = function () { toggleMb(j, res.mbtiles[+b.getAttribute('data-mshow')]); renderResults(); }; });
        each('[data-mfit]', function (b) { b.onclick = function () { var m = res.mbtiles[+b.getAttribute('data-mfit')]; if (!shown[j.id + ':' + m.file]) { toggleMb(j, m); renderResults(); } fitTo(mbExtent(m)); }; });
        each('[data-tshow]', function (b) { b.onclick = function () { toggleTif(j, res.outputs[+b.getAttribute('data-tshow')]); renderResults(); }; });
        each('[data-tfit]', function (b) { b.onclick = function () { var o = res.outputs[+b.getAttribute('data-tfit')]; if (!shown[j.id + ':' + o.file]) { toggleTif(j, o); renderResults(); } fitTo(tifExtent(o)); }; });
        each('[data-tview]', function (b) { b.onclick = function () { var o = res.outputs[+b.getAttribute('data-tview')]; openLightbox(fileUrl(j.id, o.preview, true) + (o.v ? '&v=' + o.v : ''), o.file + ' — ' + (o.crs_name || o.crs || '') + ' (уменьшенная копия)', fileUrl(j.id, o.file)); }; });
        each('[data-ttocrs]', function (b) { b.onclick = function () { var o = res.outputs[+b.getAttribute('data-ttocrs')]; toCrs(j, { name: o.name || stem(o.file), files: o.files || [] }, b); }; });
        each('[data-op]', function (r) { r.oninput = function () { var o = shown[r.getAttribute('data-op')]; if (!o) return; o.op = r.value / 100; if (o.tile) o.tile.setOpacity(o.op); }; });
        each('[data-tocrs]', function (b) { b.onclick = function () { toCrs(j, res.sheets[+b.getAttribute('data-tocrs')], b); }; });
        each('[data-move]', function (b) { b.onclick = function () { toggleMove(j, 'sheet', +b.getAttribute('data-move')); }; });     // [v20.3]
        each('[data-mmove]', function (b) { b.onclick = function () { toggleMove(j, 'mb', +b.getAttribute('data-mmove')); }; });
        each('[data-tmove]', function (b) { b.onclick = function () { toggleMove(j, 'tif', +b.getAttribute('data-tmove')); }; });   // [v20.7]
        mvBind();
        each('[data-reg]', function (b) { b.onclick = function () { register(j, b.getAttribute('data-reg'), b.getAttribute('data-regname'), b); }; });
        each('[data-qa]', function (b) { b.onclick = function () { openLightbox(fileUrl(j.id, b.getAttribute('data-qa'), true), 'Контроль привязки: план поверх ортофото (' + (j.title || '') + ')', fileUrl(j.id, b.getAttribute('data-qa'))); }; });
        var all = $('gr-allmap'); if (all) all.onclick = function () { showAll(j, true); };
    }

    // ── карта ───────────────────────────────────────────────
    function sheetExtent(sh) {
        var cs = sh.corners_latlon; if (!cs || !window.ol) return null;
        return ol.extent.boundingExtent(cs.map(function (c) { return ol.proj.fromLonLat([c[1], c[0]]); }));
    }
    function mbExtent(m) {
        var b = m.bounds_lonlat; if (!b || !window.ol) return null;
        return ol.extent.boundingExtent([ol.proj.fromLonLat([b[0], b[1]]), ol.proj.fromLonLat([b[2], b[3]])]);
    }
    function fitTo(ext, maxZoom) {
        var map = window.map; if (!map || !ext) return;
        var pw = (document.getElementById('crs-wrap') || {}).offsetWidth || 0;
        map.getView().fit(ext, { padding: [50, 50, 50, Math.min(480, pw + 40)], duration: 500, maxZoom: maxZoom || 20 });
    }
    function tileLayer(jid, file, maxz, ext, op, v) {
        var url = API + '/jobs/' + jid + '/tiles/' + encodeURIComponent(stem(file)) + '/{z}/{x}/{y}.png' + (v ? '?v=' + encodeURIComponent(v) : '');   // [v20.3] v — после сдвига
        var lyr = new ol.layer.Tile({
            source: new ol.source.XYZ({ url: url, maxZoom: maxz || 21, transition: 0 }),
            opacity: op, zIndex: 456, extent: ext || undefined, preload: 0
        });
        lyr.set('georefPreview', true);
        lyr.set('_gr', { url: url, maxz: maxz || 21, ext: ext || null });
        return lyr;
    }
    function footLayer(coords, color, name) {
        var f = new ol.Feature({ geometry: new ol.geom.Polygon([coords]) });
        var lyr = new ol.layer.Vector({
            source: new ol.source.Vector({ features: [f] }), zIndex: 458,
            style: new ol.style.Style({
                stroke: new ol.style.Stroke({ color: color, width: 2.2, lineDash: [8, 5] }),
                text: new ol.style.Text({ text: name, font: 'bold 12px Lato,Arial,sans-serif', fill: new ol.style.Fill({ color: '#152918' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3.5 }), overflow: true, placement: 'point' })
            })
        });
        lyr.set('georefPreview', true);
        return lyr;
    }
    function toggleSheet(j, sh, force) {
        var map = window.map; if (!map || !window.ol || !sh || !sh.registered) return;
        var key = j.id + ':' + sh.name;
        if (shown[key] && !force) { removeShown(key); return; }
        if (shown[key]) return;
        var res = j.result || {}, mb = mbOfSheet(res, sh), mi = mb ? mbInfo(res, mb) : {};
        var ring = (sh.corners_latlon || []).map(function (c) { return ol.proj.fromLonLat([c[1], c[0]]); });
        if (ring.length) ring.push(ring[0]);
        var o = { op: 0.8, ext: sheetExtent(sh) };
        if (mb) { o.tile = tileLayer(j.id, mb, mi.maxzoom, o.ext ? ol.extent.buffer(o.ext, 1) : null, o.op, mi.v); o.tile.set('title', 'Привязка: ' + sh.name); map.addLayer(o.tile); }
        if (ring.length) { o.foot = footLayer(ring, Q_COLOR[sh.quality || 'check'], sh.name); o.foot.set('title', 'Привязка: контур ' + sh.name); map.addLayer(o.foot); }
        shown[key] = o;
    }
    function toggleMb(j, m, force) {
        var map = window.map; if (!map || !window.ol || !m) return;
        var key = j.id + ':' + m.file;
        if (shown[key] && !force) { removeShown(key); return; }
        if (shown[key]) return;
        var ext = mbExtent(m), o = { op: 0.85, ext: ext };
        o.tile = tileLayer(j.id, m.file, m.maxzoom, ext, o.op, m.v); o.tile.set('title', 'MBTiles: ' + m.file); map.addLayer(o.tile);
        if (ext) {
            var b = m.bounds_lonlat;
            o.foot = footLayer([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]].map(function (c) { return ol.proj.fromLonLat(c); }), '#1565c0', stem(m.file));
            map.addLayer(o.foot);
        }
        shown[key] = o;
    }
    function tifExtent(o) {
        var b = o.preview_bounds_3857 || o.bounds_3857;
        return b && b.length === 4 ? [b[0], b[1], b[2], b[3]] : null;
    }
    function toggleTif(j, o, force) {
        var map = window.map; if (!map || !window.ol || !o || !o.preview) return;
        var key = j.id + ':' + o.file;
        if (shown[key] && !force) { removeShown(key); return; }
        if (shown[key]) return;
        var ext = tifExtent(o); if (!ext) return;
        var sh = { op: 0.85, ext: ext, img: true, sdx: 0, sdy: 0 };
        sh.tile = new ol.layer.Image({
            source: new ol.source.ImageStatic({ url: fileUrl(j.id, o.preview, true) + (o.v ? '&v=' + encodeURIComponent(o.v) : ''), imageExtent: ext, projection: 'EPSG:3857', crossOrigin: null }),
            opacity: sh.op, zIndex: 456
        });
        // [v20.7] «Переместить»: картинка едет за рамкой — сдвиг холста слоя (холст не повёрнут, поворот вида — стилем)
        sh.tile.on('prerender', function (e) {
            if ((!sh.sdx && !sh.sdy) || !e.context || !e.context.save) return;
            var fs = e.frameState, r = fs.viewState.resolution, pr = fs.pixelRatio;
            e.context.save(); sh.saved = true;
            e.context.translate(sh.sdx / r * pr, -sh.sdy / r * pr);
        });
        sh.tile.on('postrender', function (e) { if (sh.saved) { sh.saved = false; try { e.context.restore(); } catch (x) {} } });
        sh.tile.set('georefPreview', true); sh.tile.set('title', 'GeoTIFF: ' + o.file);
        map.addLayer(sh.tile);
        sh.foot = footLayer([[ext[0], ext[1]], [ext[2], ext[1]], [ext[2], ext[3]], [ext[0], ext[3]], [ext[0], ext[1]]], '#e0913a', o.name || stem(o.file));
        sh.foot.set('title', 'GeoTIFF: контур ' + o.file);
        map.addLayer(sh.foot);
        shown[key] = sh;
    }
    function removeShown(key) {
        if (mv && mv.key === key && !mv.refreshing) stopMove();     // [v20.3]
        var o = shown[key], map = window.map; if (!o) return;
        if (map) { if (o.tile) map.removeLayer(o.tile); if (o.foot) map.removeLayer(o.foot); }
        delete shown[key];
    }
    function hideJob(jid) { Object.keys(shown).forEach(function (k) { if (k.indexOf(jid + ':') === 0) removeShown(k); }); }
    function showAll(j, fit) {
        var res = j.result || {}, ext = null;
        if (res.kind === 'mbtiles' || j.kind === 'mbtiles') (res.mbtiles || []).forEach(function (m) { toggleMb(j, m, true); var e = mbExtent(m); if (e) ext = ext ? ol.extent.extend(ext, e) : e.slice(); });
        else if (res.kind === 'mb2tif' || j.kind === 'mb2tif') (res.outputs || []).forEach(function (o) { toggleTif(j, o, true); var e = tifExtent(o); if (e) ext = ext ? ol.extent.extend(ext, e) : e.slice(); });
        else (res.sheets || []).forEach(function (sh) { if (!sh.registered) return; toggleSheet(j, sh, true); var e = sheetExtent(sh); if (e) ext = ext ? ol.extent.extend(ext, e) : e.slice(); });
        if (mode === 'georef') clearPlace();
        renderResults();
        if (fit && ext) fitTo(ext);
    }
    function clearMap() {
        Object.keys(shown).forEach(removeShown);
        clearPlace();
    }

    // ── [v20.3] перемещение результата: рамка-«ручка» на карте, точный сдвиг, сохранение на сервере ──
    // Лист плана: сервер сдвигает привязку GeoTIFF/.ovr/.tfw/.tfwx/.aux.xml и нарезает MBTiles заново;
    // «Растр → MBTiles»: MBTiles нарезается заново со сдвигом. Пока идёт сохранение, тайлы показаны
    // со сдвинутой сеткой (те же тайлы, смещённые на экране) — план «едет» вместе с рамкой.
    function mvFind(j, kind, target) {
        var res = (j && j.result) || {};
        if (kind === 'sheet') { var sh = (res.sheets || []).find(function (x) { return x.name === target; }); return sh ? { kind: kind, key: j.id + ':' + sh.name, target: sh.name, item: sh } : null; }
        if (kind === 'tif') { var o = (res.outputs || []).find(function (x) { return x.file === target; }); return o ? { kind: kind, key: j.id + ':' + o.file, target: o.file, item: o } : null; }
        var m = (res.mbtiles || []).find(function (x) { return x.file === target; });
        return m ? { kind: kind, key: j.id + ':' + m.file, target: m.file, item: m } : null;
    }
    function mvRing(t) {
        if (t.kind === 'sheet') {
            var r = (t.item.corners_latlon || []).map(function (c) { return ol.proj.fromLonLat([c[1], c[0]]); });
            if (r.length) r.push(r[0].slice());
            return r;
        }
        if (t.kind === 'tif') { var e = tifExtent(t.item); return e ? [[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]], [e[0], e[1]]] : []; }   // рамка картинки (EPSG:3857)
        var b = t.item.bounds_lonlat; if (!b) return [];
        return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]].map(function (c) { return ol.proj.fromLonLat(c); });
    }
    function mvLat(t) { var it = t.item; return t.kind === 'sheet' ? (it.center_latlon || [54])[0] : it.bounds_lonlat ? (it.bounds_lonlat[1] + it.bounds_lonlat[3]) / 2 : 54; }
    function fmtM(v) { v = +v || 0; return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2).replace('.', ',') + ' м'; }
    function mvItem() { var t = mv && mvFind(S[mode].job, mv.kind, mv.target); return t ? t.item : null; }
    function mvDelta() {
        if (!mv || !mv.lyr || !mv.ring0 || !mv.ring0.length) return [0, 0];
        var f = mv.lyr.getSource().getFeatures()[0], c = f && f.getGeometry().getCoordinates()[0][0];
        return c ? [c[0] - mv.ring0[0][0], c[1] - mv.ring0[0][1]] : [0, 0];
    }
    function mvPending() { var d = mvDelta(); return Math.abs(d[0]) > 0.0005 || Math.abs(d[1]) > 0.0005; }
    function shiftPreview(o, dx, dy) {          // тайлы со сдвинутой сеткой: тот же z/x/y, на экране — со сдвигом
        if (o && o.img && o.tile) { if (o.sdx !== dx || o.sdy !== dy) { o.sdx = dx; o.sdy = dy; o.tile.changed(); } return; }   // [v20.7] GeoTIFF: картинка
        if (!o || !o.tile || !o.tile.get('_gr')) return;
        var k = Math.round(dx * 1000) + ':' + Math.round(dy * 1000);
        if ((o.shiftKey || '0:0') === k) return;
        o.shiftKey = k;
        var g = o.tile.get('_gr'), H = 20037508.342789244, sh = dx || dy;
        o.tile.setSource(new ol.source.XYZ({ url: g.url, maxZoom: g.maxz || 21, transition: 0, wrapX: !sh,
            tileGrid: sh ? ol.tilegrid.createXYZ({ extent: [-H + dx, -H + dy, H + dx, H + dy], maxZoom: g.maxz || 21 }) : undefined }));
        if (g.ext) o.tile.setExtent([g.ext[0] + dx, g.ext[1] + dy, g.ext[2] + dx, g.ext[3] + dy]);
    }
    function mvInfoText(it) {
        if (!mv || !it) return '';
        var sv = it.shift_m || [0, 0], d = mvDelta(), e = sv[0] + d[0] * mv.k, n = sv[1] + d[1] * mv.k;
        return (mv.kind === 'sheet' ? 'Сдвиг от автопривязки' : 'Сдвиг от исходного положения') + ': на восток <b>' + fmtM(e) + '</b>, на север <b>' + fmtM(n) + '</b>' +
            (mvPending() ? ' <span style="color:var(--gr-amber)">· не сохранён</span>' : '');
    }
    function mvInfo() { var el = $('gr-mv-info'); if (el) el.innerHTML = mvInfoText(mvItem()); var rb = $('gr-mv-reset'), it = mvItem(); if (rb && it) rb.disabled = !!(mv.saving || !(it.shift_3857 || mvPending())); }
    function mvStatus(html, err) { if (!mv) return; mv.st = html; mv.stErr = !!err; var el = $('gr-mv-st'); if (el) { el.innerHTML = html; el.className = 'st' + (err ? ' err' : ''); } }
    function mvSync(now) {
        if (!mv) return;
        var run = function () { if (!mv) return; mv.raf = 0; var d = mvDelta(); shiftPreview(shown[mv.key], d[0], d[1]); mvInfo(); };
        if (now) { if (mv.raf) cancelAnimationFrame(mv.raf); run(); } else if (!mv.raf) mv.raf = requestAnimationFrame(run);
    }
    function mvHtml(it) {
        if (!mv) return '';
        return '<div class="gr-mv"><div class="h"><i class="fa-solid fa-up-down-left-right"></i> Перетащите оранжевую рамку на карте или задайте сдвиг в метрах. Стрелки ← ↑ → ↓ — 0,1 м, с Shift — 1 м. ' +
            'Сохраняется сразу: ' + (mv.kind === 'sheet' ? 'GeoTIFF, TFW/TFWX, AUX.XML, OVR и MBTiles листа' : mv.kind === 'tif' ? 'привязка GeoTIFF, TFW/TFWX и MBTiles со сдвигом — всё изображение исходного MBTiles, все уровни' : 'MBTiles нарезается заново') +
            '. Можно двигать дальше, пока идёт сохранение.</div>' +
            (caps && caps.version !== CLIENT_VER ? '<div class="w"><i class="fa-solid fa-triangle-exclamation"></i> На сервере модули ' + (caps.version ? 'v' + esc(caps.version) : 'старее v20.7') + ', интерфейс v' + CLIENT_VER + '. Если сохранение не сработает — установите .py-файлы и tools/georef из пакета v' + CLIENT_VER + ' и перезапустите приложение.</div>' : '') +
            '<div class="i" id="gr-mv-info">' + mvInfoText(it) + '</div>' +
            '<div class="row"><input class="crs-in" id="gr-mv-dx" placeholder="на восток, м" inputmode="decimal"><input class="crs-in" id="gr-mv-dy" placeholder="на север, м" inputmode="decimal">' +
            '<button class="crs-btn sm" id="gr-mv-apply">Сдвинуть</button></div>' +
            '<div class="gr-acts"><button class="crs-btn sm" id="gr-mv-reset"' + (mv.saving || !(it.shift_3857 || mvPending()) ? ' disabled' : '') + ' title="Вернуть привязку, полученную автоматически"><i class="fa-solid fa-rotate-left"></i>Исходная привязка</button>' +
            '<button class="crs-btn sm on" id="gr-mv-done"><i class="fa-solid fa-check"></i>Готово</button></div>' +
            '<div class="st' + (mv.stErr ? ' err' : '') + '" id="gr-mv-st">' + (mv.st || '') + '</div></div>';
    }
    function mvBind() {
        if (!mv) return;
        if ($('gr-mv-apply')) $('gr-mv-apply').onclick = function () {
            var e = num($('gr-mv-dx').value, 0), n = num($('gr-mv-dy').value, 0);
            if (!e && !n) { toast('Введите сдвиг на восток и/или на север, м', true); return; }
            if (Math.abs(e) > 5000 || Math.abs(n) > 5000) { toast('Сдвиг за раз — не больше 5 км', true); return; }
            $('gr-mv-dx').value = ''; $('gr-mv-dy').value = '';
            mvNudge(e, n); mvQueue(0);
        };
        if ($('gr-mv-reset')) $('gr-mv-reset').onclick = function () {
            var it = mvItem(); if (!mv || mv.saving || !it) return;
            if (!it.shift_3857) { mvRebase(); mvSync(true); return; }        // только несохранённый сдвиг
            if (!window.confirm('Вернуть исходную привязку «' + mv.target + '»? Ручной сдвиг будет отменён, ' + (mv.kind === 'tif' ? 'MBTiles со сдвигом — удалён.' : 'MBTiles нарезаются заново.'))) return;
            mvRebase(); mvSync(true); mvSave(true);
        };
        if ($('gr-mv-done')) $('gr-mv-done').onclick = function () {
            if (!mv) return;
            if (mv.saving || mvPending()) { mv.stopAfter = true; if (!mv.saving) mvSave(); else mvStatus('<i class="fa-solid fa-spinner fa-spin"></i> Сохранение… панель закроется после него'); return; }
            stopMove(); renderResults();
        };
    }
    function mvNudge(e, n) {                    // e, n — метры на местности → единицы карты (EPSG:3857)
        if (!mv || !mv.lyr) return;               // [v20.7] и во время сохранения — следующий шаг сохранится после
        var f = mv.lyr.getSource().getFeatures()[0]; if (!f) return;
        f.getGeometry().translate(e / mv.k, n / mv.k);
        mvSync(true);
    }
    function mvRebase() {                       // рамка — в сохранённое положение
        if (!mv || !mv.lyr) return;
        var f = mv.lyr.getSource().getFeatures()[0];
        if (f) f.setGeometry(new ol.geom.Polygon([mv.ring0.map(function (c) { return c.slice(); })]));
    }
    function mvHandle(t) {
        var map = window.map, ring = mvRing(t);
        if (mv.tr) try { map.removeInteraction(mv.tr); } catch (e) {}
        if (mv.lyr) try { map.removeLayer(mv.lyr); } catch (e) {}
        mv.ring0 = ring.map(function (c) { return c.slice(); });
        mv.lyr = new ol.layer.Vector({
            source: new ol.source.Vector({ features: ring.length ? [new ol.Feature({ geometry: new ol.geom.Polygon([ring]) })] : [] }), zIndex: 470,
            style: new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(242,179,94,0.12)' }), stroke: new ol.style.Stroke({ color: '#e0913a', width: 2.6 }) })
        });
        mv.lyr.set('georefPreview', true); mv.lyr.set('title', 'Перемещение: ' + t.target);
        map.addLayer(mv.lyr);
        mv.tr = new ol.interaction.Translate({ layers: [mv.lyr], hitTolerance: 4 });
        mv.tr.on('translatestart', function () { if (mv) mv.dragging = true; });
        mv.tr.on('translating', function () { mvSync(); });
        mv.tr.on('translateend', function () { if (mv) mv.dragging = false; mvSync(true); mvQueue(0); });
        mv.tr.setActive(true);                    // [v20.7] двигать можно и во время сохранения
        map.addInteraction(mv.tr);
        if (!mv.hover) mv.hover = map.on('pointermove', function (e) {
            if (!mv || e.dragging) return;
            var hit = map.hasFeatureAtPixel(e.pixel, { layerFilter: function (l) { return l === mv.lyr; }, hitTolerance: 4 });
            map.getTargetElement().style.cursor = hit ? 'move' : '';
        });
        var o = shown[t.key]; if (o && o.foot) o.foot.setVisible(false);
    }
    function toggleMove(j, kind, i) {
        var res = j.result || {}, it = kind === 'sheet' ? (res.sheets || [])[i] : kind === 'tif' ? (res.outputs || [])[i] : (res.mbtiles || [])[i];
        var t = it && mvFind(j, kind, kind === 'sheet' ? it.name : it.file);
        var map = window.map; if (!t || !map || !window.ol) return;
        if (mv && (mv.saving || mvPending())) { toast('Подождите — сдвиг сохраняется', true); return; }
        if (mv && mv.key === t.key) { stopMove(); renderResults(); return; }
        if (mv) stopMove();
        if (!shown[t.key]) { if (kind === 'sheet') toggleSheet(j, t.item); else if (kind === 'tif') toggleTif(j, t.item); else toggleMb(j, t.item); }
        if (!shown[t.key]) return;
        mv = { key: t.key, jid: j.id, kind: kind, target: t.target, saving: false, k: Math.max(0.05, Math.cos(mvLat(t) * Math.PI / 180)) };
        mvHandle(t);
        mv.keyH = function (e) {
            if (!mv) return;
            var tg = e.target && e.target.tagName;
            if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || (e.target && e.target.isContentEditable)) return;
            var st = e.shiftKey ? 1 : 0.1, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
            if (!d) return;
            e.preventDefault(); e.stopPropagation();
            mvNudge(d[0], d[1]); mvQueue(700);
        };
        document.addEventListener('keydown', mv.keyH, true);
        var ext = ol.extent.boundingExtent(mv.ring0.length ? mv.ring0 : [map.getView().getCenter()]);
        if (!ol.extent.containsExtent(map.getView().calculateExtent(map.getSize()), ext)) fitTo(ext);
        renderResults();
    }
    function mvQueue(delay) { if (!mv) return; clearTimeout(mv.tq); mv.tq = setTimeout(function () { mvSave(); }, delay || 0); }
    function mvSave(reset) {
        var s = mv; if (!s) return;
        clearTimeout(s.tq);
        if (s.saving) return;
        var d = mvDelta(), j = S[mode].job;
        if (!reset && !mvPending()) { if (s.stopAfter) { stopMove(); renderResults(); } return; }
        if (!j || j.id !== s.jid) return;
        s.saving = true; s.sent = reset ? [0, 0] : d.slice();
        mvStatus('<i class="fa-solid fa-spinner fa-spin"></i> Сохранение: ' + (s.kind === 'sheet' ? 'привязка GeoTIFF/TFW сдвигается, MBTiles нарезаются заново…' : s.kind === 'tif' ? 'привязка GeoTIFF/TFW сдвигается, MBTiles со сдвигом собирается…' : 'MBTiles нарезается заново со сдвигом…'));
        var t0 = Date.now();
        api('/jobs/' + s.jid + '/shift', { method: 'POST', json: reset ? { target: s.target, reset: true } : { target: s.target, dx: d[0], dy: d[1] } }).then(function (r) {
            if (mv !== s) return;
            s.saving = false;
            var nj = r.job || j; S[mode].job = nj;
            var t = mvFind(nj, s.kind, s.target);
            var cur = mvDelta(), extra = [cur[0] - s.sent[0], cur[1] - s.sent[1]], more = Math.abs(extra[0]) > 0.0005 || Math.abs(extra[1]) > 0.0005;
            if (t) {
                var op = shown[s.key] ? shown[s.key].op : null;
                s.refreshing = true; removeShown(s.key); s.refreshing = false;
                if (s.kind === 'sheet') toggleSheet(nj, t.item, true); else if (s.kind === 'tif') toggleTif(nj, t.item, true); else toggleMb(nj, t.item, true);
                if (op != null && shown[s.key]) { shown[s.key].op = op; if (shown[s.key].tile) shown[s.key].tile.setOpacity(op); }
                if (s.dragging && !reset) {          // [v20.7] рамку тянут прямо сейчас — её не пересоздаём: сохранённое положение — новое начало отсчёта
                    s.ring0 = s.ring0.map(function (c) { return [c[0] + s.sent[0], c[1] + s.sent[1]]; });
                    if (shown[s.key] && shown[s.key].foot) shown[s.key].foot.setVisible(false);
                    mvSync(true);
                } else {
                    mvHandle(t);
                    if (more) { var f2 = s.lyr && s.lyr.getSource().getFeatures()[0]; if (f2) f2.getGeometry().translate(extra[0], extra[1]); mvSync(true); }   // [v20.7] сдвиг во время сохранения
                }
            }
            var files = (r.changed || []).length + (r.mbtiles || []).length;
            mvStatus('<i class="fa-solid fa-circle-check" style="color:var(--gr-acc)"></i> ' + (reset ? 'Исходная привязка восстановлена' : 'Сохранено') +
                (files ? ': ' + esc((r.changed || []).concat(r.mbtiles || []).map(function (n) { return /\.tif\.aux\.xml$/i.test(n) ? 'AUX.XML' : /\.tif\.ovr$/i.test(n) ? 'OVR' : ext(n).toUpperCase(); }).filter(function (v, k, a) { return a.indexOf(v) === k; }).join(', ')) : '') +
                ' · ' + fmtDur(Math.max(1, (Date.now() - t0) / 1000)));
            if ((r.unregistered || []).length) toast('Слой «MBTILES MINSK» был добавлен до сдвига — нажмите «В слои», чтобы заменить его сдвинутым');
            (r.warnings || []).forEach(function (w) { toast(w, true); });
            if (more && t) { renderResults(); if (!s.dragging) mvQueue(300); return; }   // тянут — сохранится по отпусканию
            if (s.stopAfter) { stopMove(); }
            renderResults();
        }).catch(function (e) {
            if (mv !== s) return;
            s.saving = false; s.stopAfter = false;
            mvRebase(); mvSync(true);
            if (s.tr) s.tr.setActive(true);
            mvStatus('<i class="fa-solid fa-triangle-exclamation"></i> Не сохранено: ' + esc(mvErrText(e)), true);
            renderResults();
        });
    }
    function mvErrText(e) {                     // [v20.7] старый сервер → что установить
        var m = (e && e.message) || String(e), how = ' — установите .py-файлы и tools/georef из пакета v' + CLIENT_VER + ' в папку приложения (рядом с app.py) и перезапустите приложение';
        if (e && e.status === 404 && /^Not Found$/i.test(m)) return 'на сервере нет функции перемещения (georef_api.py старее v20.3)' + how;
        if (e && e.status === 422 && /Сдвиг доступен для/.test(m)) return 'на сервере старый georef_shift.py — «MBTiles → TIFF» он не сдвигает' + how;
        if (e && e.status === 405) return 'сервер не принимает запрос сдвига (HTTP 405)' + how;
        return m;
    }
    function stopMove() {
        var s = mv, map = window.map; if (!s) return;
        mv = null;
        clearTimeout(s.tq); if (s.raf) cancelAnimationFrame(s.raf);
        if (map) { try { map.removeInteraction(s.tr); } catch (e) {} try { map.removeLayer(s.lyr); } catch (e) {} }
        if (s.hover) try { ol.Observable.unByKey(s.hover); } catch (e) {}
        try { map.getTargetElement().style.cursor = ''; } catch (e) {}
        document.removeEventListener('keydown', s.keyH, true);
        var o = shown[s.key];
        if (o) { if (o.foot) o.foot.setVisible(true); shiftPreview(o, 0, 0); }   // несохранённый сдвиг — отменён
    }

    // ── действия ────────────────────────────────────────────
    function toCrs(j, sh, btn) {
        if (!opts.onToCrs) { toast('Конвертер СК недоступен', true); return; }
        var names = (sh.files || []).filter(function (n) { return /\.(tif|tfw|tfwx|prj)$/i.test(n) || /\.tif\.aux\.xml$/i.test(n); });
        if (!names.length) { toast('Нет файлов GeoTIFF для конвертера', true); return; }
        var old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>Готовлю…';
        Promise.all(names.map(function (n) {
            return fetch(fileUrl(j.id, n), { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(n + ': HTTP ' + r.status); return r.blob(); })
                .then(function (b) { return new File([b], n); });
        })).then(function (fl) {
            btn.disabled = false; btn.innerHTML = old;
            opts.onToCrs(fl, 'wgs84_3857');
            toast((mode === 'mb2tif' ? 'GeoTIFF «' : 'Лист «') + sh.name + '» передан на вкладку «Смена СК» — выберите целевую СК');
        }).catch(function (e) { btn.disabled = false; btn.innerHTML = old; toast('Не удалось передать файлы: ' + e.message, true); });
    }

    function register(j, file, name, btn) {
        var title = window.prompt('Название слоя в папке «MBTILES MINSK»:', name || stem(file));
        if (title == null) return;
        btn.disabled = true;
        api('/jobs/' + j.id + '/register', { method: 'POST', json: { file: file, name: title } }).then(function (layer) {
            j.registered = j.registered || {}; j.registered[file] = { id: layer.id, name: layer.name };
            toast('Слой «' + (layer.name || title) + '» добавлен в «MBTILES MINSK»');
            if (window.loadMbtilesLayers) window.loadMbtilesLayers();
            renderResults();
        }).catch(function (e) { btn.disabled = false; toast('Не добавлено: ' + e.message, true); });
    }

    function openLightbox(src, title, dl) {
        closeLightbox();
        var d = document.createElement('div'); d.className = 'gr-lb';
        d.innerHTML = '<div class="bar"><span>' + esc(title) + '</span><a href="' + esc(dl) + '" download><i class="fa-solid fa-download"></i> Скачать</a><button data-x><i class="fa-solid fa-xmark"></i> Закрыть</button></div>' +
            '<div class="wrap"><img alt="" src="' + esc(src) + '"></div>';
        d.addEventListener('click', function (e) {
            if (e.target.tagName === 'IMG') { d.classList.toggle('zoom'); return; }
            if (e.target.closest('a')) return;
            if (e.target.closest('[data-x]') || e.target === d) closeLightbox();
        });
        lightbox = { el: d, key: function (e) { if (e.key === 'Escape') closeLightbox(); } };
        document.addEventListener('keydown', lightbox.key, true);
        document.body.appendChild(d);
    }
    function closeLightbox() { if (!lightbox) return; document.removeEventListener('keydown', lightbox.key, true); lightbox.el.remove(); lightbox = null; }

    // ── история / восстановление ────────────────────────────
    function restore() {
        var s = S[mode], m = mode;
        if (s.job) {
            api('/jobs/' + s.job.id).then(function (d) { setJob(m, d); }).catch(function () { s.job = null; if (mode === m) { renderJob(); renderRun(); } });
            return;
        }
        if (s.restored) return;
        s.restored = true;
        api('/jobs?kind=' + m + '&limit=20').then(function (d) {
            s.hist = d.items || [];
            if (mode === m) renderHist();
            var last = s.hist[0];
            if (!last || s.job) return;
            if (active(last) || (Date.now() / 1000 - (last.finished || last.created || 0) < 6 * 3600)) {
                return api('/jobs/' + last.id).then(function (full) { if (!S[m].job) setJob(m, full); });
            }
        }).catch(function () {});
    }

    function loadHist() {
        var m = mode;
        api('/jobs?kind=' + m + '&limit=30').then(function (d) { S[m].hist = d.items || []; if (mode === m) renderHist(); }).catch(function (e) { if ($('gr-hist')) $('gr-hist').innerHTML = '<div class="crs-hint">' + esc(e.message) + '</div>'; });
    }

    function renderHist() {
        var box = $('gr-hist'), s = S[mode]; if (!box) return;
        box.style.display = s.histOpen ? '' : 'none';
        if ($('gr-hist-ch')) $('gr-hist-ch').className = 'fa-solid ' + (s.histOpen ? 'fa-chevron-up' : 'fa-chevron-down');
        if ($('gr-hist-n')) $('gr-hist-n').textContent = s.hist ? String(s.hist.length) : '';
        if (!s.histOpen) return;
        if (!s.hist) { box.innerHTML = '<div class="crs-hint"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка…</div>'; return; }
        if (!s.hist.length) { box.innerHTML = '<div class="crs-hint">Заданий пока нет.</div>'; return; }
        box.innerHTML = s.hist.map(function (it) {
            var extra = it.status === 'done' && it.result ? (it.kind === 'mbtiles' ? (it.result.mbtiles || []).length + ' MBTiles' : it.kind === 'mb2tif' ? (it.result.outputs || []).length + ' GeoTIFF' : (it.result.sheets || []).filter(function (x) { return x.registered; }).length + '/' + (it.result.sheets || []).length + ' лист.') : '';
            return '<div class="gr-hist' + (s.job && s.job.id === it.id ? ' cur' : '') + '" data-open="' + it.id + '"><span class="gr-st ' + it.status + '">' + (ST_TEXT[it.status] || it.status) + '</span>' +
                '<span class="nm" title="' + esc(it.title) + '">' + esc(it.title || it.id) + (it.version > 1 ? ' · v' + it.version : '') + '</span><span class="dt">' + esc(extra) + ' ' + fmtDate(it.created) + '</span>' +
                (active(it) ? '' : '<button class="x" data-del="' + it.id + '" title="Удалить с сервера"><i class="fa-solid fa-trash-can"></i></button>') + '</div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (r) {
            r.onclick = function (e) {
                if (e.target.closest('[data-del]')) return;
                var id = r.getAttribute('data-open'), m = mode;
                api('/jobs/' + id).then(function (d) { S[m].files = []; setJob(m, d); renderFiles(); renderHist(); if (d.status === 'done') showAll(d, true); }).catch(function (er) { toast(er.message, true); });
            };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
            b.onclick = function (e) {
                e.stopPropagation();
                var id = b.getAttribute('data-del'), m = mode;
                if (!window.confirm('Удалить задание и его файлы с сервера?')) return;
                api('/jobs/' + id, { method: 'DELETE' }).then(function () {
                    hideJob(id);
                    if (S[m].job && S[m].job.id === id) { S[m].job = null; renderJob(); renderRun(); }
                    loadHist();
                }).catch(function (er) { toast(er.message, true); });
            };
        });
    }

    window.GeorefTools = { render: render, detach: detach, clearMap: clearMap, version: 'v20.3' };
})();
