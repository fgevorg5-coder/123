/* ============================================================
   panel-crs.js — панель «Конвертер СК»
   ------------------------------------------------------------
   • Загрузка SHP (+shx, dbf, prj, cpg, sbn, sbx, qpj, shp.xml) и
     TIFF (+tfw, tfwx, xml, aux.xml, ovr, prj) или zip-архива.
   • Исходная СК: авто (.prj / GeoTIFF) или пресет; целевая — пресет.
     Пресеты: СК-42 6°/3° все зоны, СК-63, WGS-84 (гео, Web Mercator,
     World Mercator, UTM N/S), «Мои пресеты» (WKT/PROJ/EPSG/.prj).
   • Результат: скачать (всё / по слою) или проверить на карте.
   • «Переместить»: перетащить весь слой или отдельный объект на карте
     (или задать точный сдвиг), «Сохранить перемещение» → zip в целевой СК,
     «В другую СК» — сдвинутый слой сразу в конвертер.
     [v20.2] Растр (GeoTIFF) — так же: перетаскивается целиком, сдвигается
     привязка (теги GeoTIFF, .tfw/.tfwx/.wld, .aux.xml), пиксели не меняются.
     НОВАЯ конвертация принудительно удаляет предыдущую — и с карты,
     и на сервере.
   • v19: вкладки «План → GeoTIFF/TFW → MBTiles» и «Растр → MBTiles»
     (panel-georef.js, грузится по требованию; сервер — /api/georef).
   ============================================================ */
(function () {
    'use strict';

    var LS_PRESETS = 'crs_custom_presets_v1';
    var LS_CHOICE  = 'crs_last_choice_v1';
    var REQUIRED_SHP = ['shx', 'dbf'];
    var VEC_SIDE = ['prj', 'cpg', 'qpj', 'sbn', 'sbx', 'shp.xml'];
    var RAS_SIDE = ['tfw', 'tfwx', 'tifw', 'wld', 'prj', 'xml', 'aux.xml', 'ovr'];
    var ACCEPT = '.shp,.shx,.dbf,.prj,.cpg,.qpj,.sbn,.sbx,.xml,.tif,.tiff,.tfw,.tfwx,.tifw,.wld,.ovr,.zip';

    var catalog = null;          // {groups, presets, popular, datums}
    var status  = null;          // {enabled, is_admin, max_upload_mb}
    var files   = [];            // File[]
    var job     = null;          // последний результат (meta)
    var layers  = {};            // idx → ol.layer
    var xhr     = null;

    // ── утилиты ─────────────────────────────────────────────
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
    function toast(m, err) { if (window.showToast) window.showToast(m, !!err); }
    function csrf() { return window.getCsrfToken ? window.getCsrfToken() : ''; }
    function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ'; }
    function extOf(name) {
        var low = name.toLowerCase();
        var multi = ['.shp.xml', '.aux.xml', '.tif.xml', '.tiff.xml', '.tif.ovr', '.tiff.ovr', '.tif.aux.xml', '.tiff.aux.xml'];
        for (var i = 0; i < multi.length; i++) if (low.endsWith(multi[i])) return multi[i].slice(1);
        var p = low.lastIndexOf('.');
        return p >= 0 ? low.slice(p + 1) : '';
    }
    function stemOf(name) {
        var low = name.toLowerCase(), e = extOf(name);
        var s = low.slice(0, low.length - e.length - 1);
        return s.replace(/\.(tif|tiff)$/, '');
    }
    function loadCustom() { try { return JSON.parse(localStorage.getItem(LS_PRESETS) || '[]') || []; } catch (e) { return []; } }
    function saveCustom(arr) { try { localStorage.setItem(LS_PRESETS, JSON.stringify(arr)); } catch (e) {} }
    function loadChoice() { try { return JSON.parse(localStorage.getItem(LS_CHOICE) || '{}') || {}; } catch (e) { return {}; } }
    function saveChoice(c) { try { localStorage.setItem(LS_CHOICE, JSON.stringify(c)); } catch (e) {} }
    function isKrass(id) {
        if (!id) return false;
        if (id === 'auto') return true;
        if (/^sk(42|63)/.test(id)) return true;
        var c = loadCustom().find(function (p) { return p.id === id; });
        return !!(c && c.krass);
    }

    // ── карта: слои проверки ───────────────────────────────
    function removeAllLayers() {
        var map = window.map;
        if (mv) stopMove(true);
        Object.keys(layers).forEach(function (k) { try { map && map.removeLayer(layers[k]); } catch (e) {} });
        layers = {};
        // Страховка: удаляем любые «осиротевшие» слои проверки конвертера
        try {
            if (map) map.getLayers().getArray().slice().forEach(function (l) { if (l.get && l.get('crsPreview')) map.removeLayer(l); });
        } catch (e) {}
    }
    window.CrsConverter = {
        clearMap: function () { if (window.GeorefTools) window.GeorefTools.clearMap(); return afterMove(removeAllLayers); },
        // v19: передать файлы во вкладку «Перепроецирование» (из «План → GeoTIFF» и др.)
        useFiles: function (list) { pendingFiles = Array.prototype.slice.call(list || []); if (document.getElementById('crs-body')) switchTab('crs'); },
        openTab: function (t) { if (document.getElementById('crs-body')) switchTab(t); else try { localStorage.setItem('crs_tab_v1', t); } catch (e) {} },
        version: 'v5.1-raster-move'
    };

    var VSTYLE = null;
    function vectorStyle() {
        if (VSTYLE) return VSTYLE;
        var stroke = new ol.style.Stroke({ color: '#ff3d00', width: 2.2 });
        var fill = new ol.style.Fill({ color: 'rgba(255,152,0,0.18)' });
        VSTYLE = [
            new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.9)', width: 4.5 }) }),
            new ol.style.Style({ stroke: stroke, fill: fill,
                image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#ff3d00' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) }) })
        ];
        return VSTYLE;
    }

    function fitExtent(ext) {
        var map = window.map;
        if (!map || !ext || !isFinite(ext[0])) return;
        map.getView().fit(ext, { padding: [60, 60, 60, 60], duration: 600, maxZoom: 18 });
    }

    function showOnMap(idx, btn) {
        var map = window.map, it = job && job.items[idx];
        if (!map || !it || !it.ok) return;
        if (layers[idx]) {                       // повторное нажатие — убрать
            if (mv && mv.idx === idx && (moveSaving || moveDirty())) { afterMove(function () { showOnMap(idx, btn); }); return; }
            if (mv && mv.idx === idx) stopMove(true);
            map.removeLayer(layers[idx]); delete layers[idx];
            renderResults(); return;
        }
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
        var jobAtStart = job.job_id;
        if (it.preview === 'geojson') {
            fetch((shifted[idx] && shifted[idx].preview_url) || it.preview_url, { credentials: 'same-origin', cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (gj) {
                    if (!job || job.job_id !== jobAtStart) return;   // за это время запущена новая конвертация
                    var feats = new ol.format.GeoJSON().readFeatures(gj, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
                    feats.forEach(function (f, k) { f.set('_crs_i', k); f.set('_crs_g0', f.getGeometry() ? f.getGeometry().clone() : null); });
                    var src = new ol.source.Vector({ features: feats });
                    var lyr = new ol.layer.Vector({ source: src, style: vectorStyle(), zIndex: 460 });
                    lyr.set('crsPreview', true); lyr.set('title', 'Конвертер СК: ' + it.name);
                    map.addLayer(lyr); layers[idx] = lyr;
                    fitExtent(src.getExtent());
                    renderResults();
                })
                .catch(function (e) { toast('Не удалось показать слой: ' + e.message, true); renderResults(); });
        } else {
            // [v20.2] растр: картинка предпросмотра в рамке extent3857; у сдвинутого — рамка из его предпросмотра (GeoJSON)
            var url = it.preview_url + '?t=' + Date.now();
            var put = function (ext, warn) {
                if (!job || job.job_id !== jobAtStart || layers[idx]) return;
                var lyr = new ol.layer.Image({ source: rasterSource(url, ext), opacity: 0.85, zIndex: 455 });
                lyr.set('crsPreview', true); lyr.set('title', 'Конвертер СК: ' + it.name);
                lyr.set('_crs_url', url); lyr.set('_crs_ext', ext.slice());
                map.addLayer(lyr); layers[idx] = lyr;
                fitExtent(ext);
                if (warn) toast(warn, true);
                renderResults();
            };
            var s = shifted[idx];
            if (s && s.ext3857) put(s.ext3857);
            else if (s && s.preview_url) {
                fetch(s.preview_url, { credentials: 'same-origin', cache: 'no-store' })
                    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function (gj) { var e = rasterExtOf(gj); if (!e) throw new Error('нет рамки растра'); s.ext3857 = e; put(e); })
                    .catch(function (e) { put(it.extent3857, 'Положение сдвинутого растра не прочитано (' + e.message + ') — показано исходное'); });
            } else put(it.extent3857);
        }
    }
    function rasterSource(url, ext) { return new ol.source.ImageStatic({ url: url, imageExtent: ext, projection: 'EPSG:3857' }); }
    function rasterExtOf(gj) {
        var fs = (gj && gj.features) || [], i, e;
        for (i = 0; i < fs.length; i++) {
            e = fs[i] && fs[i].properties && fs[i].properties.extent3857;
            if (e && e.length === 4 && e.every(function (v) { return isFinite(v); })) return e.map(Number);
        }
        try {
            var f = new ol.format.GeoJSON().readFeatures(gj, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
            if (f.length && f[0].getGeometry()) { e = f[0].getGeometry().getExtent(); if (isFinite(e[0])) return e; }
        } catch (x) {}
        return null;
    }
    function canMove(it) { return it.kind === 'vector' || !!(it.preview_url && it.extent3857 && it.extent3857.length === 4); }

    // ── перемещение результата на карте и сохранение сдвига в целевой СК ──────
    // Сдвиг считается в целевой СК: точка «до» и «после» переводятся из карты
    // в СК результата, разность и есть сдвиг. Погрешность перехода датумов
    // (towgs84) одинакова для обеих точек и сокращается.
    // Сохранение: берётся исходный .zip результата (полная точность, все атрибуты),
    // в .shp/.shx сдвигаются координаты и рамки, .dbf/.prj/.cpg не меняются.
    var mv = null;          // {idx, mode, tr, coll, lyr, hover}
    var shifted = {};       // idx → {blob, name, files:[File], dst_id, dxdy}

    var moveSaving = null;
    function moveDirty() {
        return !!(mv && mv.lyr.getSource().getFeatures().some(function (f) {
            var d = featDelta(f); return Math.abs(d[0]) > 1e-9 || Math.abs(d[1]) > 1e-9;
        }));
    }
    function moveCache(op, key, value) {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open('forest_crs_shift_v1', 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('shifts'); };
            req.onerror = function () { reject(req.error); };
            req.onblocked = function () { reject(new Error('Хранилище занято другим окном')); };
            req.onsuccess = function () {
                var db = req.result, tx = db.transaction('shifts', op === 'get' ? 'readonly' : 'readwrite');
                var store = tx.objectStore('shifts');
                var q = op === 'put' ? store.put(value, key) : op === 'delete' ? store.delete(key) : store.get(key);
                tx.oncomplete = function () { db.close(); resolve(q.result); };
                tx.onabort = tx.onerror = function () { db.close(); reject(tx.error || new Error('Ошибка хранилища')); };
            };
        });
    }
    function cacheKey(jid, idx) { return String(jid) + ':' + idx; }
    function afterMove(action) {
        return (moveSaving || (moveDirty() ? saveMove() : Promise.resolve(true))).then(function (ok) {
            if (ok !== false) return action();
        });
    }
    window.addEventListener('beforeunload', function (e) {
        if (moveSaving || moveDirty() || Object.keys(shifted).some(function (k) { return !shifted[k].server && !shifted[k].cached; })) { e.preventDefault(); e.returnValue = ''; }
    });
    function restoreLocalShifts() {
        if (!job) return Promise.resolve();
        var jid = job.job_id;
        return Promise.all(job.items.map(function (it, idx) {
            return moveCache('get', cacheKey(jid, idx)).then(function (v) {
                if (!v || !v.blob || v.source !== it.name || !job || job.job_id !== jid || shifted[idx]) return;
                shifted[idx] = {server:false, cached:true, url:URL.createObjectURL(v.blob),
                    preview_url:URL.createObjectURL(new Blob([JSON.stringify(v.geojson)], {type:'application/geo+json'})),
                    name:v.name, info:v.info, dst_id:v.dst_id, pack:null, files:null, ext3857:v.ext3857 || null};
            }).catch(function () {});
        })).then(function () { if (job && job.job_id === jid) renderResults(); });
    }

    function retryShift(idx) {
        if (moveSaving || moveDirty()) { afterMove(function () { retryShift(idx); }); return; }
        var s = shifted[idx], jid = job && job.job_id;
        if (!s || s.server || !jid) return Promise.resolve(true);
        var jobAtStart = job;
        if (mv && mv.tr) mv.tr.setActive(false);
        moveSaving = Promise.all([fetch(s.url).then(function (r) { if (!r.ok) throw new Error('ZIP недоступен'); return r.blob(); }),
            fetch(s.preview_url).then(function (r) { if (!r.ok) throw new Error('Предпросмотр недоступен'); return r.blob(); })])
            .then(function (parts) {
                var fd = new FormData(); fd.append('zip',parts[0],s.name); fd.append('geojson',parts[1],'preview.geojson');
                fd.append('info',s.info); fd.append('name',s.name);
                return fetch(shiftUrl(jid, idx), {
                    method:'POST',body:fd,credentials:'same-origin',headers:{'X-CSRFToken':csrf()},signal:AbortSignal.timeout(upTimeout(parts[0].size))
                });
            }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw shiftErr(r, d, isRasterIdx(idx));
                if (!d.download_url || !d.preview_url) throw new Error('Сервер не вернул сохранённый файл'); return d;
            }); }).then(function (d) {
                if (job !== jobAtStart || shifted[idx] !== s) return false;
                URL.revokeObjectURL(s.url); URL.revokeObjectURL(s.preview_url);
                s.url=d.download_url; s.preview_url=d.preview_url; s.server=true;
                return moveCache('delete',cacheKey(jid,idx)).catch(function () {}).then(function () {
                    toast('Новая привязка сохранена на сервере'); return true;
                });
            }).catch(function (e) { toast('Не сохранено на сервере: ' + e.message + '. Локальная копия не удалена.',true); return false; })
            .finally(function () {
                moveSaving=null; if (mv && mv.tr) mv.tr.setActive(true); if (job===jobAtStart) renderResults();
            });
        renderResults(); return moveSaving;
    }

    function loadJsZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);
        return new Promise(function (ok, fail) {
            var s = document.createElement('script');
            s.src = '/static/vendor/jszip.min.js?v=3.10.2';
            s.onload = function () { window.JSZip ? ok(window.JSZip) : fail(new Error('JSZip не загрузился')); };
            s.onerror = function () { fail(new Error('Нет /static/vendor/jszip.min.js')); };
            document.head.appendChild(s);
        });
    }

    function upTimeout(b) { return Math.min(600000, 15000 + Math.round((b || 0) / 1048576) * 2000); }   // [v20.2] ZIP растров — дольше
    function shiftErr(r, d, raster) {     // [v20.2] ответ /api/crs-shift с ошибкой → понятный текст
        if (r.status === 413) return new Error('архив больше лимита сервера (HTTP 413: nginx client_max_body_size для /api/crs-shift/)');
        var m = d && typeof d.detail === 'string' ? d.detail : ('HTTP ' + r.status);
        if (raster && (r.status === 404 && /^Not Found$/i.test(m) || r.status === 405))   // [v20.7] нет маршрута — старый georef_api.py
            m = 'на сервере нет хранилища сдвигов растров (georef_api.py v20.7) — установите .py-файлы из пакета v20.7 и перезапустите приложение';
        return new Error(m);
    }
    // [v20.7] растры — /api/crs-shift/raster/… (georef_api.py: хранит ZIP со сдвинутой привязкой), векторы — /api/crs-shift/… (crs_shift.py)
    function isRasterIdx(idx) { var it = job && job.items && job.items[idx]; return !!(it && it.kind !== 'vector'); }
    function shiftUrl(jid, idx) {
        return isRasterIdx(idx) ? '/api/crs-shift/raster/' + encodeURIComponent(jid) + '/' + idx + '/file' : '/api/crs-shift/' + encodeURIComponent(jid) + '/' + idx;
    }
    function featDelta(f) {               // сдвиг объекта на карте, EPSG:3857
        var g = f.getGeometry(), g0 = f.get('_crs_g0');
        if (!g || !g0 || !g.getFirstCoordinate || !g0.getFirstCoordinate) return [0, 0];
        var a = g0.getFirstCoordinate(), b = g.getFirstCoordinate();
        return [b[0] - a[0], b[1] - a[1]];
    }
    function featAnchor(f) {
        var g0 = f.get('_crs_g0');
        return g0 && g0.getFirstCoordinate ? g0.getFirstCoordinate() : null;
    }

    function moveBoxHtml(it) {
        var whole = mv.mode !== 'one';
        return '<div class="crs-mv">' +
            (mv.raster ? '<div class="crs-hint">Перетащите растр мышью на карте — за любую точку внутри пунктирной рамки. После отпускания мыши новая привязка сохраняется автоматически: в целевой СК сдвигаются теги GeoTIFF, .tfw/.tfwx и .aux.xml, пиксели не пересчитываются.</div>' :
            '<div class="crs-row" style="gap:4px;margin-bottom:5px">' +
            '<button class="crs-btn sm' + (whole ? ' on' : '') + '" data-mvmode="all" style="flex:1">Весь слой</button>' +
            '<button class="crs-btn sm' + (!whole ? ' on' : '') + '" data-mvmode="one" style="flex:1">Отдельный объект</button></div>' +
            '<div class="crs-hint">Перетащите ' + (whole ? 'любой объект — сдвинется весь слой' : 'нужный объект') + ' мышью на карте. После отпускания мыши сдвиг сохраняется автоматически.</div>') +
            '<div class="crs-mvd" id="crs-mvd"></div>' +
            '<div class="crs-lbl">Точный сдвиг в целевой СК (+ к текущему)</div>' +
            '<div class="crs-row"><input class="crs-in" id="crs-mv-dx" placeholder="ΔX (восток)" inputmode="decimal">' +
            '<input class="crs-in" id="crs-mv-dy" placeholder="ΔY (север)" inputmode="decimal">' +
            '<button class="crs-btn sm" id="crs-mv-apply" title="Сдвинуть весь слой на заданные значения">OK</button></div>' +
            '<div class="crs-row" style="margin-top:7px"><button class="crs-btn dl" id="crs-mv-save" style="flex:1"><i class="fa-solid fa-floppy-disk"></i>Сохранить перемещение</button>' +
            '<button class="crs-btn sm" id="crs-mv-reset" title="Вернуть на место"><i class="fa-solid fa-rotate-left"></i></button></div></div>';
    }

    function shiftedHtml(i) {
        var s = shifted[i];
        return '<div class="crs-note' + (s.server ? ' ok' : '') + '">' +
            (s.server ? '✓ Новая привязка сохранена на сервере: ' : (s.cached ? '⚠ Сохранено в этом браузере, но не на сервере: ' : '⚠ Только в памяти окна — скачайте ZIP: ')) + esc(s.info) + '</div>' +
            '<div class="a"><a class="crs-btn sm" data-download="' + i + '" href="' + esc(s.url) + '" download="' + esc(s.name) + '"><i class="fa-solid fa-download"></i>Скачать сдвинутый</a>' +
            (!s.server ? '<button class="crs-btn sm" data-retry-shift="' + i + '">Повторить сохранение на сервере</button>' : '') +
            '<button class="crs-btn sm" data-reconv="' + i + '" title="Загрузить сдвинутый слой в конвертер и перевести в другую СК"><i class="fa-solid fa-arrows-rotate"></i>В другую СК</button>' +
            '<button class="crs-btn sm" data-unshift="' + i + '" title="Удалить перемещение и вернуть исходную привязку"><i class="fa-solid fa-rotate-left"></i>Исходная</button>' + '</div>';
    }

    function units() { return mv && mv.prj && mv.prj.geo ? '°' : ' м'; }
    function fmtD(v) { return mv && mv.prj && mv.prj.geo ? v.toFixed(8) : v.toFixed(3); }

    function updateMoveInfo() {
        var el = document.getElementById('crs-mvd');
        if (!el || !mv) return;
        if (moveSaving) { el.textContent = mv.raster ? 'Сохраняю новую привязку растра…' : 'Сохраняю новые координаты…'; return; }
        if (mv.raster) {
            var rf = mv.lyr.getSource().getFeatures()[0], rd = rf ? featDelta(rf) : [0, 0];
            var rr = (Math.abs(rd[0]) > 1e-6 || Math.abs(rd[1]) > 1e-6) ? dstDelta(rasterAnchor(), rd) : null, tot = mv.pack && mv.pack.total;
            el.innerHTML = !mv.pack ? 'Читаю результат…' :
                (rr ? 'Сдвиг растра: ΔX <b>' + fmtD(rr[0]) + units() + '</b>, ΔY <b>' + fmtD(rr[1]) + units() + '</b>' : 'Пока не сдвинут.') +
                (tot && (tot[0] || tot[1]) ? '<br>Сохранено от исходной привязки: ΔX ' + fmtD(tot[0]) + units() + ', ΔY ' + fmtD(tot[1]) + units() : '') +
                (mv.prj && mv.prj.approx ? '<br><span style="color:var(--gr-amber)">СК результата не прочитана — сдвиг не будет записан</span>' : '');
            return;
        }
        var moved = 0, d = null;
        mv.lyr.getSource().getFeatures().forEach(function (f) {
            var dd = featDelta(f);
            if (Math.abs(dd[0]) > 1e-6 || Math.abs(dd[1]) > 1e-6) { moved++; if (!d) d = dstDelta(featAnchor(f), dd); }
        });
        el.innerHTML = moved ? 'Сдвинуто объектов: <b>' + moved + '</b>' + (d ? ' · ΔX ' + fmtD(d[0]) + units() + ', ΔY ' + fmtD(d[1]) + units() : '') +
            (mv.prj && mv.prj.approx ? '<br><span style="color:var(--gr-amber)">СК результата прочитана приближённо — проверьте сдвиг</span>' : '')
            : 'Пока ничего не сдвинуто.';
    }

    // ── СК результата: из .prj внутри zip ──
    function centralMeridian(wkt) {
        var m = /PARAMETER\["(?:central_meridian|longitude_of_center|Longitude of natural origin)",\s*(-?[\d.]+)/i.exec(wkt || '');
        return m ? +m[1] : null;
    }
    function makePrj(wkt) {
        var w = wkt || '';
        if (!w.trim()) return {approx:true, geo:false};
        var em = /^\s*EPSG:(\d{4,6})\s*$/i.exec(w);        // [v20.2] код из GeoKeys GeoTIFF (нет .prj)
        if (em) {
            try {
                var dfe = window.proj4 && window.proj4.defs('EPSG:' + em[1]);
                if (!dfe) return {approx:true, geo:false};
                if (dfe.projName === 'longlat') return { geo: true, fwd: function (ll) { return ll; }, inv: function (xy) { return xy; } };
                var PE = window.proj4('EPSG:' + em[1]); PE.forward([27, 53]);
                return { geo: false, fwd: function (ll) { return PE.forward(ll); }, inv: function (xy) { return PE.inverse(xy); } };
            } catch (e) { return {approx:true, geo:false}; }
        }
        if (/Auxiliary_Sphere|Pseudo.Mercator|3857|900913/i.test(w)) {
            return { geo: false, fwd: function (ll) { return ol.proj.fromLonLat(ll); }, inv: function (xy) { return ol.proj.toLonLat(xy); } };
        }
        var isGeo = !/^\s*PROJCS|^\s*PROJCRS/i.test(w);
        if (isGeo) return { geo: true, fwd: function (ll) { return ll; }, inv: function (xy) { return xy; } };
        if (window.proj4) {
            try {
                var P = window.proj4(w);
                P.forward([27, 53]);
                return { geo: false, fwd: function (ll) { return P.forward(ll); }, inv: function (xy) { return P.inverse(xy); } };
            } catch (e) { /* ниже — приближение */ }
        }
        // Приближение для поперечной Меркатора: масштаб + сближение меридианов
        var lon0 = centralMeridian(w);
        return { geo: false, approx: true, lon0: lon0 };
    }
    function dstDelta(a3857, d3857) {     // → [dX, dY] в СК результата
        if (!a3857 || !mv || !mv.prj) return [0, 0];
        var P = mv.prj;
        var a = ol.proj.toLonLat(a3857), b = ol.proj.toLonLat([a3857[0] + d3857[0], a3857[1] + d3857[1]]);
        if (!P.approx) {
            var A = P.fwd(a), B = P.fwd(b);
            return [B[0] - A[0], B[1] - A[1]];
        }
        var k = Math.cos(a[1] * Math.PI / 180);
        var g = P.lon0 == null ? 0 : (a[0] - P.lon0) * Math.PI / 180 * Math.sin(a[1] * Math.PI / 180);
        var x = d3857[0] * k, y = d3857[1] * k;
        return [x * Math.cos(g) - y * Math.sin(g), x * Math.sin(g) + y * Math.cos(g)];
    }
    function mapDelta(a3857, dX, dY) {    // обратная задача: сдвиг в СК результата → сдвиг на карте
        var P = mv.prj, a = ol.proj.toLonLat(a3857);
        if (!P.approx) {
            var A = P.fwd(a), B = P.inv([A[0] + dX, A[1] + dY]);
            var b = ol.proj.fromLonLat(B);
            return [b[0] - a3857[0], b[1] - a3857[1]];
        }
        var k = Math.cos(a[1] * Math.PI / 180);
        var g = P.lon0 == null ? 0 : -(a[0] - P.lon0) * Math.PI / 180 * Math.sin(a[1] * Math.PI / 180);
        var x = (dX * Math.cos(g) - dY * Math.sin(g)) / k, y = (dX * Math.sin(g) + dY * Math.cos(g)) / k;
        return [x, y];
    }

    function fetchItemZip(it) {
        return Promise.all([loadJsZip(), fetch(it.download_url, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })])
            .then(function (res) {
                var JSZip = res[0], buf = res[1], u8 = new Uint8Array(buf, 0, 4);
                if (!(u8[0] === 0x50 && u8[1] === 0x4b)) throw new Error('результат не в zip-архиве');
                return JSZip.loadAsync(buf);
            })
            .then(function (zip) {
                var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir; });
                var shp = names.filter(function (n) { return /\.shp$/i.test(n); });
                if (!shp.length) throw new Error('в архиве нет .shp');
                var stem = (it.name || '').toLowerCase().replace(/\.(shp|zip)$/, '');
                var main = shp.find(function (n) { return n.toLowerCase().replace(/^.*\//, '').replace(/\.shp$/, '') === stem; }) || shp[0];
                var base = main.slice(0, -4);
                var side = names.filter(function (n) { return n.slice(0, base.length + 1).toLowerCase() === (base + '.').toLowerCase(); });
                var prjName = side.find(function (n) { return /\.prj$/i.test(n); });
                return (prjName ? zip.file(prjName).async('string') : Promise.resolve('')).then(function (wkt) {
                    return { zip: zip, base: base, side: side, wkt: wkt };
                });
            });
    }

    function toggleMove(idx) {
        if (moveSaving || moveDirty()) { afterMove(function () { toggleMove(idx); }); return; }
        if (mv && mv.idx === idx) { stopMove(false); renderResults(); return; }
        if (mv) stopMove(false);
        var map = window.map, it = job && job.items[idx], jobAtToggle = job;
        if (!map || !it) return;
        var go = function () {
            if (job !== jobAtToggle) return;
            var lyr = layers[idx], raster = it.kind !== 'vector';
            if (!lyr || (raster ? !lyr.get('_crs_ext') : (!lyr.getSource || !lyr.getSource().getFeatures))) { toast('Слой не загружен', true); return; }
            mv = raster ? { idx: idx, mode: 'all', raster: true, img: lyr, lyr: rasterHandle(lyr), prj: null, pack: null }   // [v20.2]
                        : { idx: idx, mode: 'all', lyr: lyr, prj: null, pack: null };
            var session = mv;
            toast('Загрузка результата для точного сдвига…');
            var from = shifted[idx] ? { name: it.name, download_url: shifted[idx].url } : it;
            (shifted[idx] && shifted[idx].pack ? Promise.resolve(shifted[idx].pack)
                : (raster ? fetchRasterZip(from) : fetchItemZip(from))).then(function (pack) {
                if (mv !== session) return;
                mv.pack = pack; mv.prj = makePrj(pack.wkt);
                setMode(mv.mode); updateMoveInfo();
            }).catch(function (e) { if (mv !== session) return; toast('Не удалось прочитать результат: ' + e.message, true); stopMove(false); renderResults(); });
            setMode('all');
            renderResults();
        };
        if (!layers[idx]) {                         // сначала показать на карте
            showOnMap(idx);
            var t0 = Date.now(), wait = setInterval(function () {
                if (job !== jobAtToggle) { clearInterval(wait); return; }
                if (layers[idx]) { clearInterval(wait); go(); }
                else if (Date.now() - t0 > 30000) clearInterval(wait);
            }, 150);
        } else go();
    }

    function setMode(mode) {
        var map = window.map;
        if (!mv || moveSaving) return;
        if (mv.tr) { map.removeInteraction(mv.tr); mv.tr = null; }
        mv.mode = mode;
        if (!mv.pack) return;
        var feats = mv.lyr.getSource().getFeatures();
        var opts = { layers: [mv.lyr], hitTolerance: 4 };
        if (mode === 'all') opts.features = new ol.Collection(feats);
        mv.tr = new ol.interaction.Translate(opts);
        mv.tr.on('translating', function () { syncRaster(); updateMoveInfo(); });
        mv.tr.on('translateend', function () { syncRaster(true); updateMoveInfo(); saveMove(); });
        map.addInteraction(mv.tr);
        if (!mv.hover) {
            mv.hover = map.on('pointermove', function (e) {
                if (!mv || e.dragging) return;
                var hit = map.hasFeatureAtPixel(e.pixel, { layerFilter: function (l) { return l === mv.lyr; }, hitTolerance: 4 });
                map.getTargetElement().style.cursor = hit ? 'move' : '';
            });
        }
    }

    function stopMove(silent) {
        var map = window.map;
        if (!mv) return;
        if (mv.tr) try { map.removeInteraction(mv.tr); } catch (e) {}
        if (mv.raster) {                         // [v20.2] рамка перемещения растра — вспомогательный слой
            if (mv.raf) cancelAnimationFrame(mv.raf);
            if (moveDirty()) try { mv.img.setSource(rasterSource(mv.img.get('_crs_url'), mv.img.get('_crs_ext'))); } catch (e) {}
            try { map.removeLayer(mv.lyr); } catch (e) {}
        }
        if (mv.hover) try { ol.Observable.unByKey(mv.hover); } catch (e) {}
        try { map.getTargetElement().style.cursor = ''; } catch (e) {}
        mv = null;
    }

    function resetMove() {
        if (!mv || moveSaving) return;
        mv.lyr.getSource().getFeatures().forEach(function (f) { var g0 = f.get('_crs_g0'); if (g0) f.setGeometry(g0.clone()); });
        syncRaster(true);
        updateMoveInfo();
    }

    function applyNumeric() {
        if (!mv || !mv.prj || moveSaving) { toast('Подождите — результат читается или сохраняется', true); return; }
        var dx = parseFloat((document.getElementById('crs-mv-dx').value || '0').replace(',', '.')) || 0;
        var dy = parseFloat((document.getElementById('crs-mv-dy').value || '0').replace(',', '.')) || 0;
        if (!isFinite(dx) || !isFinite(dy)) { toast('Введите конечные числовые значения сдвига', true); return; }
        if (!dx && !dy) return;
        var feats = mv.lyr.getSource().getFeatures();
        var ext = mv.lyr.getSource().getExtent(), c = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
        var d = mapDelta(c, dx, dy);
        feats.forEach(function (f) { var g = f.getGeometry(); if (g) g.translate(d[0], d[1]); });
        syncRaster(true);
        document.getElementById('crs-mv-dx').value = ''; document.getElementById('crs-mv-dy').value = '';
        updateMoveInfo();
        saveMove();
    }

    // Сдвиг координат в .shp; deltaFor(номер записи) → [dx, dy]
    function shiftShp(buf, deltaFor) {
        shpTypes(buf); // validate record boundaries before writing
        var out = buf.slice(0), dv = new DataView(out);
        var len = Math.min(dv.getInt32(24, false) * 2, out.byteLength);
        var off = 100, rec = 0, gb = [Infinity, Infinity, -Infinity, -Infinity];
        function pt(p, d) {
            var x = dv.getFloat64(p, true) + d[0], y = dv.getFloat64(p + 8, true) + d[1];
            dv.setFloat64(p, x, true); dv.setFloat64(p + 8, y, true);
            if (x < gb[0]) gb[0] = x; if (y < gb[1]) gb[1] = y; if (x > gb[2]) gb[2] = x; if (y > gb[3]) gb[3] = y;
        }
        function box(p, d) {
            dv.setFloat64(p, dv.getFloat64(p, true) + d[0], true); dv.setFloat64(p + 8, dv.getFloat64(p + 8, true) + d[1], true);
            dv.setFloat64(p + 16, dv.getFloat64(p + 16, true) + d[0], true); dv.setFloat64(p + 24, dv.getFloat64(p + 24, true) + d[1], true);
        }
        while (off + 12 <= len) {
            var clen = dv.getInt32(off + 4, false) * 2, p = off + 8, type = dv.getInt32(p, true), i, n;
            var d = (type !== 0 && deltaFor(rec)) || [0, 0];
            if (type === 1 || type === 11 || type === 21) pt(p + 4, d);
            else if (type === 3 || type === 5 || type === 13 || type === 15 || type === 23 || type === 25 || type === 31) {
                box(p + 4, d);
                var np = dv.getInt32(p + 36, true); n = dv.getInt32(p + 40, true);
                var q = p + 44 + np * 4 + (type === 31 ? np * 4 : 0);
                for (i = 0; i < n; i++) pt(q + i * 16, d);
            } else if (type === 8 || type === 18 || type === 28) {
                box(p + 4, d); n = dv.getInt32(p + 36, true);
                for (i = 0; i < n; i++) pt(p + 40 + i * 16, d);
            }
            off += 8 + clen; rec++;
        }
        if (isFinite(gb[0])) { dv.setFloat64(36, gb[0], true); dv.setFloat64(44, gb[1], true); dv.setFloat64(52, gb[2], true); dv.setFloat64(60, gb[3], true); }
        return out;
    }
    function shpTypes(buf) {
        if (!buf || buf.byteLength < 100) throw new Error('Неполный заголовок SHP');
        var dv = new DataView(buf), len = dv.getInt32(24, false) * 2, off = 100, t = [];
        if (dv.getInt32(0, false) !== 9994 || len < 100 || len > buf.byteLength) throw new Error('Повреждён заголовок SHP');
        while (off < len) {
            if (off + 12 > len) throw new Error('Неполная запись SHP');
            var clen = dv.getInt32(off + 4, false) * 2, p = off + 8, type = dv.getInt32(p, true);
            if (clen < 4 || off + 8 + clen > len) throw new Error('Неверная длина записи SHP');
            if ([0,1,3,5,8,11,13,15,18,21,23,25,28,31].indexOf(type) < 0) throw new Error('Неподдерживаемый тип SHP: ' + type);
            if ([1,11,21].indexOf(type) >= 0 && clen < (type === 11 ? 36 : type === 21 ? 28 : 20)) throw new Error('Неполная точка SHP');
            if ([3,5,13,15,23,25,31].indexOf(type) >= 0) {
                if (clen < 44) throw new Error('Неполная геометрия SHP');
                var np = dv.getInt32(p+36, true), n = dv.getInt32(p+40, true);
                if (np < 0 || n < 0 || 44 + np * (type === 31 ? 8 : 4) + n * 16 > clen) throw new Error('Повреждены координаты SHP');
            }
            if ([8,18,28].indexOf(type) >= 0 && (clen < 40 || dv.getInt32(p+36,true) < 0 || 40 + dv.getInt32(p+36,true)*16 > clen)) throw new Error('Неполный MultiPoint SHP');
            t.push(type); off += 8 + clen;
        }
        return t;
    }

    // ── [v20.2] перемещение растра: рамка-«ручка» на карте, сдвиг привязки без пересчёта пикселей ──
    // Сдвиг (ΔX, ΔY) в целевой СК прибавляется к ModelTiepoint (33922) / ModelTransformation (34264)
    // во всех IFD GeoTIFF и .ovr, к строкам C/F world-файлов (.tfw/.tfwx/.tifw/.wld), к <GeoTransform> и GCP в .aux.xml.
    var RSTYLE = null;
    function rasterHandle(imgLyr) {
        var f = new ol.Feature({ geometry: ol.geom.Polygon.fromExtent(imgLyr.get('_crs_ext')) });
        f.set('_crs_i', 0); f.set('_crs_g0', f.getGeometry().clone());
        if (!RSTYLE) RSTYLE = [new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.9)', width: 4.5 }) }),
            new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ff3d00', width: 2.2, lineDash: [9, 6] }), fill: new ol.style.Fill({ color: 'rgba(255,152,0,0.07)' }) })];
        var h = new ol.layer.Vector({ source: new ol.source.Vector({ features: [f] }), style: RSTYLE, zIndex: 461 });
        h.set('crsPreview', true); h.set('title', 'Конвертер СК: рамка перемещения растра');
        window.map.addLayer(h);
        return h;
    }
    function rasterAnchor() { var e = mv.img.get('_crs_ext'); return [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]; }
    function syncRaster(now) {                 // картинка растра — за рамкой (не чаще одного раза за кадр)
        var s = mv;
        if (!s || !s.raster) return;
        var run = function () {
            s.raf = 0;
            if (mv !== s) return;
            var f = s.lyr.getSource().getFeatures()[0], d = f ? featDelta(f) : [0, 0], e = s.img.get('_crs_ext');
            s.img.setSource(rasterSource(s.img.get('_crs_url'), [e[0] + d[0], e[1] + d[1], e[2] + d[0], e[3] + d[1]]));
        };
        if (now) { if (s.raf) cancelAnimationFrame(s.raf); run(); }
        else if (!s.raf) s.raf = requestAnimationFrame(run);
    }
    var TIFF_SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
    function tiffIfds(buf) {                   // теги всех IFD (TIFF и BigTIFF): [{ifd, tag, type, count, off}]
        if (!buf || buf.byteLength < 16) return null;
        var dv = new DataView(buf), bo = dv.getUint16(0, false), le;
        if (bo === 0x4949) le = true; else if (bo === 0x4D4D) le = false; else return null;
        var magic = dv.getUint16(2, le), big = magic === 43, N = buf.byteLength;
        if (magic !== 42 && !big) return null;
        var u64 = function (p) { var a = dv.getUint32(p, le), b = dv.getUint32(p + 4, le); return le ? b * 4294967296 + a : a * 4294967296 + b; };
        var ptr = function (p) { return big ? u64(p) : dv.getUint32(p, le); };
        var ents = [], ifd = ptr(big ? 8 : 4), seen = {}, k = 0, es = big ? 20 : 12;
        while (ifd > 0 && ifd + (big ? 8 : 2) <= N && !seen[ifd] && k < 512) {
            seen[ifd] = 1;
            var cnt = big ? u64(ifd) : dv.getUint16(ifd, le), p0 = ifd + (big ? 8 : 2);
            if (p0 + cnt * es + (big ? 8 : 4) > N) break;
            for (var j = 0; j < cnt; j++) {
                var e = p0 + j * es, type = dv.getUint16(e + 2, le), count = big ? u64(e + 4) : dv.getUint32(e + 4, le);
                var vp = e + (big ? 12 : 8);
                ents.push({ ifd: k, tag: dv.getUint16(e, le), type: type, count: count, off: (TIFF_SZ[type] || 1) * count <= (big ? 8 : 4) ? vp : ptr(vp) });
            }
            ifd = ptr(p0 + cnt * es); k++;
        }
        return { le: le, dv: dv, ents: ents, n: N };
    }
    function tiffGeoShift(buf, dX, dY) {       // → число изменённых тегов привязки
        var T = tiffIfds(buf), n = 0;
        if (!T) return 0;
        T.ents.forEach(function (e) {
            if ((e.tag !== 33922 && e.tag !== 34264) || e.type !== 12 || e.off + e.count * 8 > T.n) return;
            var add = function (i, d) { var q = e.off + i * 8; T.dv.setFloat64(q, T.dv.getFloat64(q, T.le) + d, T.le); };
            if (e.tag === 33922) { for (var t = 0; t + 5 < e.count; t += 6) { add(t + 3, dX); add(t + 4, dY); } n++; }
            else if (e.count >= 16) { add(3, dX); add(7, dY); n++; }
        });
        return n;
    }
    function tiffCrs(buf) {                    // СК из GeoKeys, если нет .prj и .aux.xml: 3857 / географическая / EPSG:код
        var T = tiffIfds(buf);
        if (!T) return '';
        var gk = T.ents.find(function (e) { return e.ifd === 0 && e.tag === 34735 && e.type === 3; });
        if (!gk || gk.off + gk.count * 2 > T.n || gk.count < 4) return '';
        var v = function (i) { return T.dv.getUint16(gk.off + i * 2, T.le); }, keys = {}, nk = Math.min(v(3), (gk.count - 4) / 4 | 0);
        for (var i = 0; i < nk; i++) { var b = 4 + i * 4; if (v(b + 1) === 0) keys[v(b)] = v(b + 3); }
        var pcs = keys[3072];
        if (pcs === 3857 || pcs === 3785) return 'PROJCS["WGS 84 / Pseudo-Mercator (EPSG:3857)"]';
        if (keys[1024] === 2) return 'GEOGCS["EPSG:' + (keys[2048] || 4326) + '"]';
        return pcs && pcs !== 32767 ? 'EPSG:' + pcs : '';
    }
    function auxSrs(xml) {
        var m = /<SRS[^>]*>([\s\S]*?)<\/SRS>/i.exec(xml || '');
        return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : '';
    }
    function fmtLike(s, v) {                   // число в духе исходной строки, не меньше 6 знаков после точки
        if (/e/i.test(s)) return v.toExponential(15);
        var m = /\.(\d+)/.exec(s);
        return v.toFixed(Math.min(14, Math.max(6, m ? m[1].length : 0)));
    }
    function worldShift(text, dX, dY) {        // строки 5 и 6 world-файла (C, F) + ΔX, ΔY
        var nl = /\r\n/.test(text) ? '\r\n' : '\n', L = String(text).split(/\r?\n/), at = [];
        for (var i = 0; i < L.length && at.length < 6; i++) if (L[i].trim()) at.push(i);
        if (at.length < 6) return null;
        var c = parseFloat(L[at[4]].trim().replace(',', '.')), f = parseFloat(L[at[5]].trim().replace(',', '.'));
        if (!isFinite(c) || !isFinite(f)) return null;
        L[at[4]] = fmtLike(L[at[4]].trim(), c + dX); L[at[5]] = fmtLike(L[at[5]].trim(), f + dY);
        return L.join(nl);
    }
    function auxShift(xml, dX, dY) {           // <GeoTransform> и GCP в GDAL PAM (.aux.xml)
        var n = 0;
        var out = String(xml).replace(/(<GeoTransform>)([^<]*)(<\/GeoTransform>)/gi, function (m, a, body, c) {
            var p = body.split(',').map(function (s) { return parseFloat(s); });
            if (p.length !== 6 || !p.every(isFinite)) return m;
            p[0] += dX; p[3] += dY; n++;
            return a + ' ' + p.map(function (x) { return x.toExponential(16); }).join(', ') + c;
        }).replace(/<GCP\b[^>]*>/gi, function (g) {
            var x = /\bX="([^"]+)"/.exec(g), y = /\bY="([^"]+)"/.exec(g);
            if (!x || !y || !isFinite(+x[1]) || !isFinite(+y[1])) return g;
            n++;
            return g.replace(/\bX="[^"]+"/, 'X="' + (+x[1] + dX).toPrecision(17) + '"').replace(/\bY="[^"]+"/, 'Y="' + (+y[1] + dY).toPrecision(17) + '"');
        });
        return { xml: out, n: n };
    }
    function footprint4326(e) {
        var r = [[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]], [e[0], e[1]]].map(function (c) {
            var ll = ol.proj.toLonLat(c); return [+ll[0].toFixed(9), +ll[1].toFixed(9)];
        });
        return { type: 'Polygon', coordinates: [r] };
    }
    function fetchRasterZip(it) {              // ZIP результата (или голый GeoTIFF) → {zip, base, side, wkt, total}
        return Promise.all([loadJsZip(), fetch(it.download_url, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })])
            .then(function (res) {
                var JSZip = res[0], buf = res[1], u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
                if (u8[0] === 0x50 && u8[1] === 0x4b) return JSZip.loadAsync(buf);
                if (!((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d))) throw new Error('результат не в zip-архиве и не GeoTIFF');
                var z = new JSZip(); z.file((it.name || 'raster.tif').replace(/^.*[\\/]/, ''), buf); return z;
            })
            .then(function (zip) {
                var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir; });
                var tifs = names.filter(function (n) { return /\.tiff?$/i.test(n); });
                if (!tifs.length) throw new Error('в архиве нет .tif');
                var stemOfN = function (n) { return n.toLowerCase().replace(/^.*\//, '').replace(/\.tiff?$/, ''); };
                var stem = (it.name || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(tiff?|zip)$/, '');
                var main = tifs.find(function (n) { return stemOfN(n) === stem; })
                    || tifs.find(function (n) { return stemOfN(n) === stem.replace(/_сдвиг$/, '') + '_сдвиг'; }) || tifs[0];
                var base = main.replace(/\.tiff?$/i, '');
                var side = names.filter(function (n) { return n.slice(0, base.length + 1).toLowerCase() === (base + '.').toLowerCase(); });
                var prjName = side.find(function (n) { return /\.prj$/i.test(n); }), auxName = side.find(function (n) { return /\.aux\.xml$/i.test(n); });
                var txtName = names.find(function (n) { return /_сдвиг\.txt$/i.test(n); });
                var str = function (n) { return n ? zip.file(n).async('string') : Promise.resolve(''); };
                return Promise.all([str(prjName), str(auxName), str(txtName)]).then(function (r) {
                    var m = /Всего[^\n]*?dX=(\S+)\s+dY=(\S+)/.exec(r[2]);
                    var pack = { zip: zip, base: base, side: side, wkt: r[0].trim() || auxSrs(r[1]), raster: true,
                        total: m && isFinite(+m[1]) && isFinite(+m[2]) ? [+m[1], +m[2]] : [0, 0] };
                    if (pack.wkt) return pack;
                    return zip.file(main).async('arraybuffer').then(function (b) { pack.wkt = tiffCrs(b); return pack; });
                });
            });
    }
    function shiftRasterPack(pack, dX, dY) {   // новые файлы «<имя>_сдвиг.*» со сдвинутой привязкой
        var changed = [], skipped = [], base = pack.base.replace(/^.*\//, ''), tag = base.replace(/_сдвиг$/, '') + '_сдвиг';
        return Promise.all(pack.side.filter(function (n) { return !/_сдвиг\.txt$/i.test(n); }).map(function (n) {
            var ext = n.slice(pack.base.length), low = ext.toLowerCase(), short = n.replace(/^.*\//, '');
            if (/\.(tiff?|ovr)$/.test(low)) return pack.zip.file(n).async('arraybuffer').then(function (b) {
                b = b.slice(0);
                if (tiffGeoShift(b, dX, dY)) changed.push(short + ' (теги GeoTIFF)');
                return [tag + ext, b];
            });
            if (/\.(tfw|tfwx|tifw|tiffw|wld)$/.test(low)) return pack.zip.file(n).async('string').then(function (s) {
                var t = worldShift(s, dX, dY);
                if (t == null) { skipped.push(short); return null; }   // не 6 чисел — в архив не кладём, чтобы GIS не взяла старую привязку
                changed.push(short);
                return [tag + ext, t];
            });
            if (/\.aux\.xml$/.test(low)) return pack.zip.file(n).async('string').then(function (s) {
                var r = auxShift(s, dX, dY);
                if (r.n) changed.push(short);
                return [tag + ext, r.xml];
            });
            return pack.zip.file(n).async('arraybuffer').then(function (b) { return [tag + ext, b]; });
        })).then(function (parts) {
            if (!changed.length) throw new Error('в результате нет привязки, которую можно сдвинуть (теги GeoTIFF, .tfw, .aux.xml)');
            if (skipped.length) toast('Не похож на world-файл и не включён в архив: ' + skipped.join(', '), true);
            return { parts: parts.filter(Boolean), tag: tag, changed: changed, skipped: skipped };
        });
    }
    function uploadShift(jid, idx, loc, blob, gj, jobAtStart) {
        var fd = new FormData();
        fd.append('zip', blob, loc.name);
        fd.append('geojson', new Blob([JSON.stringify(gj)], { type: 'application/geo+json' }), 'preview.geojson');
        fd.append('info', loc.info); fd.append('name', loc.name);
        return fetch(shiftUrl(jid, idx), {
            method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRFToken': csrf() }, signal: AbortSignal.timeout(upTimeout(blob.size))
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw shiftErr(r, d, true);
                if (!d.download_url || !d.preview_url) throw new Error('Сервер не вернул сохранённый файл');
                return d;
            });
        }).then(function (d) {
            if (job !== jobAtStart || shifted[idx] !== loc) return;
            loc.server = true;
            URL.revokeObjectURL(loc.url); URL.revokeObjectURL(loc.preview_url);
            loc.url = d.download_url; loc.preview_url = d.preview_url;
            return moveCache('delete', cacheKey(jid, idx)).catch(function () {}).then(function () {
                toast('Новая привязка растра сохранена на сервере. В ZIP — GeoTIFF и world-файлы со сдвигом.');
            });
        }).catch(function (e) {
            toast('Сервер не сохранил сдвиг: ' + e.message +
                (loc.cached ? '. Резервная копия сохранена в этом браузере; скачайте ZIP.' : '. Скачайте ZIP до закрытия окна!'), true);
        });
    }
    function saveRasterMove() {
        var session = mv, jobAtStart = job, jid = job.job_id, idx = mv.idx, it = job.items[idx], pack = mv.pack;
        var f = mv.lyr.getSource().getFeatures()[0], d3 = f ? featDelta(f) : [0, 0];
        if (Math.abs(d3[0]) < 1e-9 && Math.abs(d3[1]) < 1e-9) return Promise.resolve(true);
        var e0 = mv.img.get('_crs_ext'), d = dstDelta(rasterAnchor(), d3);
        if (!isFinite(d[0]) || !isFinite(d[1])) { toast('Некорректный сдвиг — сохранение отменено', true); return Promise.resolve(false); }
        var ext1 = [e0[0] + d3[0], e0[1] + d3[1], e0[2] + d3[0], e0[3] + d3[1]], g1 = f.getGeometry().clone();
        var geo = session.prj.geo, un = geo ? '°' : ' м', num = function (v) { return v.toFixed(geo ? 8 : 3); };
        var btn = document.getElementById('crs-mv-save'); if (btn) btn.disabled = true;
        if (session.tr) session.tr.setActive(false);
        Array.prototype.forEach.call(document.querySelectorAll('#crs-mv-apply,#crs-mv-reset,#crs-mv-dx,#crs-mv-dy'), function (b) { b.disabled = true; });
        var statusEl = document.getElementById('crs-mvd'); if (statusEl) statusEl.textContent = 'Сохраняю новую привязку растра…';
        moveSaving = shiftRasterPack(pack, d[0], d[1]).then(function (res) {
            var t0 = pack.total || [0, 0], tot = [t0[0] + d[0], t0[1] + d[1]], z = new window.JSZip();
            res.parts.forEach(function (p) {
                z.file(p[0], p[1], p[1].byteLength > 1048576 ? { compression: 'DEFLATE', compressionOptions: { level: 1 } } : undefined);
            });
            z.file(res.tag + '.txt', 'Сдвиг растра в СК результата (' + (it.dst || '') + ')\r\n' +
                'Всего от исходной привязки: dX=' + tot[0] + ' dY=' + tot[1] + '\r\n' +
                'Последний шаг: dX=' + d[0] + ' dY=' + d[1] + '\r\n' +
                'Изменено: ' + res.changed.join(', ') + '\r\n' +
                (res.skipped.length ? 'Не включены (не world-файл, привязку не прочитать): ' + res.skipped.join(', ') + '\r\n' : '') +
                'Пиксели не пересчитывались — меняется только привязка.\r\n');
            return z.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (blob) {
                if (!job || job !== jobAtStart) throw new Error('Результат конвертации уже заменён');
                if (shifted[idx] && shifted[idx].url) URL.revokeObjectURL(shifted[idx].url);
                var z2pack = { zip: z, base: res.tag, side: res.parts.map(function (p) { return p[0]; }), wkt: pack.wkt, total: tot, raster: true };
                shifted[idx] = {
                    pack: z2pack, server: false, url: URL.createObjectURL(blob), name: res.tag + '.zip',
                    files: res.parts.map(function (p) { return new File([p[1]], p[0]); }), dst_id: job._dst_id || null, ext3857: ext1,
                    info: 'ΔX ' + num(tot[0]) + un + ', ΔY ' + num(tot[1]) + un + ' от исходной привязки · ' + (it.dst || '')
                };
                // новое положение = новая точка отсчёта для следующих сдвигов
                f.set('_crs_g0', g1); session.img.set('_crs_ext', ext1); session.pack = z2pack;
                try { session.img.setSource(rasterSource(session.img.get('_crs_url'), ext1)); } catch (e) {}
                var gj = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: footprint4326(ext1),
                    properties: { kind: 'raster', name: it.name, extent3857: ext1, total_dx: tot[0], total_dy: tot[1], dst: it.dst || '' } }] };
                var loc = shifted[idx];
                loc.preview_url = URL.createObjectURL(new Blob([JSON.stringify(gj)], { type: 'application/geo+json' }));
                return moveCache('put', cacheKey(jid, idx), { blob: blob, geojson: gj, source: it.name, name: loc.name, info: loc.info,
                    dst_id: loc.dst_id, ext3857: ext1 }).then(function () { loc.cached = true; }).catch(function () { loc.cached = false; })
                    .then(function () { return uploadShift(jid, idx, loc, blob, gj, jobAtStart); })
                    .then(function () { return true; });
            });
        }).catch(function (e) {
            toast('Растр не сдвинут: ' + e.message, true);
            if (mv === session) { var g0 = f.get('_crs_g0'); if (g0) f.setGeometry(g0.clone()); syncRaster(true); }
            return false;
        }).finally(function () {
            moveSaving = null;
            if (mv === session && session.tr) session.tr.setActive(true);
            if (job === jobAtStart) renderResults();
        });
        return moveSaving;
    }

    function saveMove() {
        if (moveSaving) return moveSaving;
        if (!mv || !mv.pack || !mv.prj) { toast('Подождите — результат ещё читается', true); return Promise.resolve(false); }
        if (mv.prj.approx) { toast('Нельзя точно прочитать СК результата. Проверьте .prj и загрузку proj4; сдвиг не записан.', true); return Promise.resolve(false); }
        if (mv.raster) return saveRasterMove();              // [v20.2]
        var session = mv, jobAtStart = job, jid = job.job_id;
        var savedUnits = session.prj.geo ? '°' : ' м';
        function savedNumber(v) { return v.toFixed(session.prj.geo ? 8 : 3); }
        var idx = mv.idx, it = job.items[idx], pack = mv.pack, feats = mv.lyr.getSource().getFeatures().slice();
        feats.sort(function (a, b) { return a.get('_crs_i') - b.get('_crs_i'); });
        var deltas = feats.map(function (f) { return dstDelta(featAnchor(f), featDelta(f)); });
        if (!deltas.every(function (d) { return isFinite(d[0]) && isFinite(d[1]); })) { toast('Некорректные координаты — сохранение отменено', true); return Promise.resolve(false); }
        var any = deltas.some(function (d) { return Math.abs(d[0]) > 1e-9 || Math.abs(d[1]) > 1e-9; });
        if (!any) return Promise.resolve(true);
        var shpName = pack.side.find(function (n) { return /\.shp$/i.test(n); }), shxName = pack.side.find(function (n) { return /\.shx$/i.test(n); });
        var btn = document.getElementById('crs-mv-save'); if (btn) btn.disabled = true;
        if (session.tr) session.tr.setActive(false);
        Array.prototype.forEach.call(document.querySelectorAll('[data-mvmode],#crs-mv-apply,#crs-mv-reset,#crs-mv-dx,#crs-mv-dy'), function (b) { b.disabled = true; });
        var statusEl = document.getElementById('crs-mvd'); if (statusEl) statusEl.textContent = 'Сохраняю новые координаты…';
        moveSaving = pack.zip.file(shpName).async('arraybuffer').then(function (buf) {
            var types = shpTypes(buf), nonNull = [], k;
            for (k = 0; k < types.length; k++) if (types[k] !== 0) nonNull.push(k);
            var map = {};
            // Реальные смещения, а не последняя выбранная кнопка режима.
            var same = deltas.every(function (d) { return Math.abs(d[0] - deltas[0][0]) < 1e-7 && Math.abs(d[1] - deltas[0][1]) < 1e-7; });
            if (!same) {
                var order = feats.length === types.length ? types.map(function (_, j) { return j; })
                          : feats.length === nonNull.length ? nonNull : null;
                if (!order) throw new Error('не удалось сопоставить объекты карты с записями SHP (' + feats.length + ' и ' + types.length + ') — сдвигайте весь слой');
                order.forEach(function (r, j) { map[r] = deltas[j]; });
            }
            var mid = deltas.find(function (d) { return d[0] || d[1]; });
            var shp2 = shiftShp(buf, function (r) { return same ? deltas[0] : (map[r] || [0, 0]); });
            var JSZip = window.JSZip, z = new JSZip(), base = pack.base.replace(/^.*\//, '');
            var tag = base.replace(/_сдвиг$/, '') + '_сдвиг';
            var jobs = pack.side.filter(function (n) { return !/\.(sbn|sbx|qix|fix|fbn|fbx)$/i.test(n); }).map(function (n) {
                var ext = n.slice(pack.base.length);
                if (n === shpName) return Promise.resolve([tag + ext, shp2]);
                return pack.zip.file(n).async('arraybuffer').then(function (b) {
                    if (n === shxName) {                    // рамка слоя в .shx = рамке в .shp
                        b = b.slice(0); new Uint8Array(b).set(new Uint8Array(shp2, 36, 32), 36);
                    }
                    return [tag + ext, b];
                });
            });
            return Promise.all(jobs).then(function (parts) {
                parts.forEach(function (p) { z.file(p[0], p[1]); });
                var moved = deltas.filter(function (d) { return d[0] || d[1]; }).length;
                z.file(tag + '.txt', 'Сдвиг в СК результата (' + (it.dst || '') + ')\r\n' +
                    (same ? 'Весь слой: dX=' + mid[0] + ' dY=' + mid[1] : 'Сдвинуто объектов: ' + moved + ' (по отдельности)') + '\r\n');
                return z.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (blob) {
                    if (!job || job !== jobAtStart) throw new Error('Результат конвертации уже заменён');
                    if (shifted[idx] && shifted[idx].url) URL.revokeObjectURL(shifted[idx].url);
                    var z2pack = { zip: z, base: tag, side: parts.map(function (p) { return p[0]; }).filter(function (n) { return !/\.txt$/i.test(n); }), wkt: pack.wkt };
                    shifted[idx] = {
                        pack: z2pack, server: false,
                        url: URL.createObjectURL(blob), name: tag + '.zip',
                        files: parts.map(function (p) { return new File([p[1]], p[0]); }),
                        dst_id: job._dst_id || null,
                        info: (same ? 'ΔX ' + savedNumber(mid[0]) + savedUnits + ', ΔY ' + savedNumber(mid[1]) + savedUnits : 'объектов: ' + moved) + ' · ' + (it.dst || '')
                    };
                    // новое положение = новая точка отсчёта для следующих сдвигов
                    feats.forEach(function (f) { var g = f.getGeometry(); f.set('_crs_g0', g ? g.clone() : null); });
                    session.pack = z2pack;
                    var gj = new ol.format.GeoJSON().writeFeaturesObject(feats.map(function (f) {
                        var c = f.clone(); c.unset('_crs_g0'); c.unset('_crs_i'); return c;
                    }), { featureProjection: 'EPSG:3857', dataProjection: 'EPSG:4326', decimals: 8 });
                    var loc = shifted[idx];
                    loc.preview_url = URL.createObjectURL(new Blob([JSON.stringify(gj)], {type:'application/geo+json'}));
                    return moveCache('put', cacheKey(jid, idx), {blob:blob, geojson:gj, source:it.name,
                        name:loc.name, info:loc.info, dst_id:loc.dst_id}).then(function () { loc.cached = true; })
                        .catch(function () { loc.cached = false; }).then(function () {
                            var fd = new FormData();
                            fd.append('zip', blob, tag + '.zip');
                            fd.append('geojson', new Blob([JSON.stringify(gj)], {type:'application/geo+json'}), 'preview.geojson');
                            fd.append('info', loc.info); fd.append('name', loc.name);
                            return fetch('/api/crs-shift/' + encodeURIComponent(jid) + '/' + idx, {
                                method:'POST', body:fd, credentials:'same-origin', headers:{'X-CSRFToken':csrf()},
                                signal:AbortSignal.timeout(upTimeout(blob.size))
                            }).then(function (r) {
                                return r.json().catch(function () { return {}; }).then(function (d) {
                                    if (!r.ok) throw shiftErr(r, d);
                                    if (!d.download_url || !d.preview_url) throw new Error('Сервер не вернул сохранённый файл');
                                    return d;
                                });
                            }).then(function (d) {
                                if (job !== jobAtStart || shifted[idx] !== loc) return;
                                loc.server = true;
                                URL.revokeObjectURL(loc.url); URL.revokeObjectURL(loc.preview_url);
                                loc.url = d.download_url; loc.preview_url = d.preview_url;
                                return moveCache('delete', cacheKey(jid, idx)).catch(function () {}).then(function () {
                                    toast('Новая привязка сохранена на сервере. ZIP содержит смещённые координаты.');
                                });
                            }).catch(function (e) {
                                toast('Сервер не сохранил сдвиг: ' + e.message +
                                    (loc.cached ? '. Резервная копия сохранена в этом браузере; скачайте ZIP.' : '. Скачайте ZIP до закрытия окна!'), true);
                            });
                        }).then(function () { return true; });
                });
            });
        }).catch(function (e) { toast('Ошибка сохранения: ' + e.message, true); return false; }).finally(function () {
            moveSaving = null;
            if (mv === session && session.tr) session.tr.setActive(true);
            if (job === jobAtStart) renderResults();
        });
        return moveSaving;
    }

    function reconvert(i) {
        if (moveSaving || moveDirty()) { afterMove(function () { reconvert(i); }); return; }
        var s = shifted[i];
        if (!s) return;
        if (!s.files) {
            loadJsZip().then(function () { return fetch(s.url, { credentials: 'same-origin', cache: 'no-store' }); })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then(function (b) { return window.JSZip.loadAsync(b); })
                .then(function (z) {
                    var ns = Object.keys(z.files).filter(function (n) { return !z.files[n].dir; });
                    return Promise.all(ns.map(function (n) { return z.file(n).async('blob').then(function (b) { return new File([b], n.replace(/^.*\//, '')); }); }));
                })
                .then(function (fl) { s.files = fl; reconvert(i); })
                .catch(function (e) { toast('Не удалось получить сдвинутый слой: ' + e.message, true); });
            return;
        }
        files = s.files.filter(function (f) { return !/_сдвиг\.txt$/.test(f.name); });
        var src = document.getElementById('crs-src');
        // исходная СК = СК результата; если неизвестна — «Авто» (берётся из .prj в архиве)
        var id = s.dst_id;
        if (src && id && src.querySelector('option[value="' + CSS.escape(id) + '"]')) src.value = id;
        else if (src) src.value = 'auto';
        renderFiles();
        var body = document.getElementById('crs-body'); if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
        toast('Сдвинутый слой загружен — выберите «В какую СК» и нажмите «Конвертировать»');
    }


    // ── сохранённые на сервере перемещения ──
    function loadServerShifts() {
        if (!job || !job.job_id) return;
        var jid = job.job_id;
        try { if (!job._dst_id) job._dst_id = localStorage.getItem('crs_job_dst_' + jid) || null; } catch (e) {}
        var get = function (u) { return fetch(u, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); };
        Promise.all([get('/api/crs-shift/' + encodeURIComponent(jid)), get('/api/crs-shift/raster/' + encodeURIComponent(jid) + '/items/all')])   // [v20.7]
            .then(function (two) {
                var d = { items: {} };
                Object.keys((two[0] && two[0].items) || {}).forEach(function (k) { d.items[k] = two[0].items[k]; });
                Object.keys((two[1] && two[1].items) || {}).forEach(function (k) { if (isRasterIdx(+k)) d.items[k] = two[1].items[k]; });
                return d;
            })
            .then(function (d) {
                if (!d || !d.items || !job || job.job_id !== jid) return;
                var changed = false;
                Object.keys(d.items).forEach(function (k) {
                    var it = d.items[k], i = +k;
                    if (shifted[i] || (mv && mv.idx === i)) return;
                    shifted[i] = { server: true, url: it.download_url, preview_url: it.preview_url, name: it.name,
                                   info: it.info, dst_id: job._dst_id || null, pack: null, files: null };
                    changed = true;
                    if (layers[i]) { try { window.map.removeLayer(layers[i]); } catch (e) {} delete layers[i]; showOnMap(i); }
                });
                if (changed) renderResults();
            }).catch(function () {});
    }

    function unshift(i) {
        if (!job || !confirm('Удалить сохранённое перемещение и вернуть исходную привязку?')) return;
        if (moveSaving) { toast('Дождитесь сохранения', true); return; }
        var jid = job.job_id;
        fetch(shiftUrl(jid, i), {
            method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRFToken': csrf() }
        }).then(function (r) {
            if (!r.ok && r.status !== 404 && r.status !== 405) throw new Error('HTTP ' + r.status);
            return moveCache('delete', cacheKey(jid, i));
        }).then(function () {
            if (!job || job.job_id !== jid) return;
            delete shifted[i];
            if (mv && mv.idx === i) stopMove(true);
            if (layers[i]) { try { window.map.removeLayer(layers[i]); } catch (e) {} delete layers[i]; showOnMap(i); }
            else renderResults();
            toast('Исходная привязка восстановлена');
        }).catch(function (e) { toast('Ошибка: ' + e.message, true); });
    }

    function downloadAll() {
        toast('Собираю архив со сдвинутыми слоями…');
        loadJsZip().then(function (JSZip) {
            return fetch(job.download_url, { credentials: 'same-origin', cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then(function (b) { return JSZip.loadAsync(b); })
                .then(function (all) {
                    var tasks = Object.keys(shifted).map(function (k) {
                        var it = job.items[+k], s = shifted[k];
                        var stem = (it && it.name || '').replace(/\.(shp|zip|tiff?)$/i, '').toLowerCase();
                        Object.keys(all.files).forEach(function (n) {
                            var b = n.replace(/^.*\//, '').toLowerCase();
                            if (b.slice(0, stem.length + 1) === stem + '.') all.remove(n);
                        });
                        return fetch(s.url, { credentials: 'same-origin', cache: 'no-store' })
                            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                            .then(function (b) { return JSZip.loadAsync(b); })
                            .then(function (z) {
                                return Promise.all(Object.keys(z.files).filter(function (n) { return !z.files[n].dir; }).map(function (n) {
                                    return z.file(n).async('arraybuffer').then(function (b) { all.file(n, b); });
                                }));
                            });
                    });
                    return Promise.all(tasks).then(function () { return all.generateAsync({ type: 'blob', compression: 'DEFLATE' }); });
                });
        }).then(function (blob) {
            var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
            a.download = 'crs_result_сдвиг.zip'; document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        }).catch(function (e) { toast('Не удалось собрать архив: ' + e.message, true); });
    }

    function bindMoveBox() {
        if (!mv) return;
        Array.prototype.forEach.call(document.querySelectorAll('[data-mvmode]'), function (b) {
            b.onclick = function () { setMode(b.getAttribute('data-mvmode')); renderResults(); };
        });
        var e;
        if ((e = document.getElementById('crs-mv-save'))) e.onclick = saveMove;
        if ((e = document.getElementById('crs-mv-reset'))) e.onclick = resetMove;
        if ((e = document.getElementById('crs-mv-apply'))) e.onclick = applyNumeric;
        if (moveSaving) Array.prototype.forEach.call(document.querySelectorAll('[data-mvmode],#crs-mv-apply,#crs-mv-reset,#crs-mv-save,#crs-mv-dx,#crs-mv-dy'), function (b) { b.disabled = true; });
        updateMoveInfo();
    }
    function bindShifted() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-retry-shift]'), function (b) {
            b.disabled = !!moveSaving; b.onclick = function () { retryShift(+b.getAttribute('data-retry-shift')); };
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-reconv]'), function (b) {
            b.onclick = function () { reconvert(+b.getAttribute('data-reconv')); };
        });
    }

    // ── вёрстка ─────────────────────────────────────────────
    function css() {
        if (document.getElementById('crs-panel-css')) return;
        var st = document.createElement('style'); st.id = 'crs-panel-css';
        st.textContent = [
            /* [v20] цвета из темы сайта (--gs-*) с тёплыми акцентами: читается и в тёмной, и в светлых темах */
            '#crs-wrap,.gr-root{--gr-ink:var(--gs-ink,#1f2a1f);--gr-muted:var(--gs-muted,#5e6a5c);--gr-card:var(--gs-card,#fff);--gr-acc:var(--gs-accent,#5e9b3c);' +
                '--gr-line:color-mix(in srgb,var(--gr-ink) 16%,transparent);--gr-soft:color-mix(in srgb,var(--gr-ink) 6%,var(--gr-card));' +
                '--gr-link:color-mix(in srgb,var(--gr-acc) 70%,var(--gr-ink));--gr-amber:color-mix(in srgb,#f2b35e 64%,var(--gr-ink));' +
                '--gr-coral:color-mix(in srgb,#ff9270 62%,var(--gr-ink));--gr-leaf:color-mix(in srgb,#a9d46b 62%,var(--gr-ink));' +
                '--gr-sand:color-mix(in srgb,#d9b78f 52%,var(--gr-ink));--gr-honey:color-mix(in srgb,#ffd27a 62%,var(--gr-ink))}',
            '#crs-wrap{display:flex;flex-direction:column;height:100%;font-family:Lato,Arial,sans-serif;background:var(--gs-bg,#f6f8f6);color:var(--gr-ink)}',
            '#crs-body{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:9px}',
            '.crs-card{background:var(--gr-card);border:1px solid var(--gr-line);border-radius:10px;padding:10px 11px;box-shadow:0 1px 4px rgba(0,0,0,.06)}',
            '.crs-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:800;color:var(--gr-ink);margin-bottom:7px}',
            '.crs-h .n{width:20px;height:20px;border-radius:50%;background:color-mix(in srgb,#f2b35e 20%,var(--gr-card));color:var(--gr-amber);border:1px solid color-mix(in srgb,#f2b35e 45%,transparent);font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box}',
            '.crs-h .sp{flex:1}',
            '.crs-drop{border:2px dashed color-mix(in srgb,#f2b35e 38%,var(--gr-line));border-radius:10px;padding:14px 10px;text-align:center;color:var(--gr-ink);font-size:12.5px;cursor:pointer;transition:.15s;background:var(--gr-soft)}',
            '.crs-drop:hover,.crs-drop.over{background:color-mix(in srgb,#f2b35e 10%,var(--gr-card));border-color:color-mix(in srgb,#f2b35e 70%,transparent)}',
            '.crs-drop i{font-size:24px;color:var(--gr-amber);display:block;margin-bottom:5px}',
            '.crs-drop small{display:block;color:var(--gr-muted);margin-top:4px;font-size:11px}',
            '.crs-ds{border:1px solid var(--gr-line);border-radius:8px;padding:6px 8px;margin-top:6px;font-size:12px;background:var(--gr-soft)}',
            '.crs-ds .t{display:flex;align-items:center;gap:6px;font-weight:800;color:var(--gr-ink);word-break:break-all}',
            '.crs-ds .t i{color:var(--gr-amber)}',
            '.crs-ds .t .x{margin-left:auto;border:none;background:none;color:var(--gr-coral);cursor:pointer;font-size:12px;padding:2px 4px}',
            '.crs-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px}',
            '.crs-chip{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:color-mix(in srgb,#a9d46b 13%,transparent);color:var(--gr-leaf);border:1px solid color-mix(in srgb,#a9d46b 34%,transparent)}',
            '.crs-chip.miss{background:color-mix(in srgb,#ff9270 13%,transparent);color:var(--gr-coral);border-color:color-mix(in srgb,#ff9270 38%,transparent)}',
            '.crs-chip.opt{background:var(--gr-soft);color:var(--gr-muted);border-color:var(--gr-line)}',
            '.crs-lbl{font-size:11.5px;font-weight:700;color:var(--gr-muted);margin:6px 0 3px;display:flex;align-items:center;gap:6px}',
            '.crs-in,.crs-sel,.crs-ta{width:100%;box-sizing:border-box;border:1.5px solid var(--gr-line);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;color:var(--gr-ink);background:color-mix(in srgb,var(--gr-ink) 3%,var(--gr-card));outline:none}',
            '.crs-in::placeholder,.crs-ta::placeholder{color:var(--gr-muted);opacity:.8}',
            '.crs-in:focus,.crs-sel:focus,.crs-ta:focus{border-color:color-mix(in srgb,#f2b35e 75%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,#f2b35e 15%,transparent)}',
            '.crs-sel{cursor:pointer}',
            '.crs-sel option,.crs-sel optgroup{background:var(--gr-card);color:var(--gr-ink)}',
            '.crs-ta{min-height:64px;resize:vertical;font-family:Consolas,monospace;font-size:11px}',
            '.crs-row{display:flex;gap:6px;align-items:center}',
            '.crs-swap{border:1.5px solid var(--gr-line);background:var(--gr-soft);border-radius:7px;cursor:pointer;color:var(--gr-ink);padding:5px 8px;font-size:12px;font-weight:800;display:flex;align-items:center;gap:5px;margin:7px auto 0}',
            '.crs-swap i{color:var(--gr-amber)}',
            '.crs-swap:hover{border-color:color-mix(in srgb,#f2b35e 60%,transparent)}',
            '.crs-btn{text-decoration:none;border:1px solid transparent;border-radius:8px;padding:8px 12px;font-size:12.5px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;transition:.15s}',
            '.crs-btn.main{width:100%;background:var(--gs-accent,#2f6b2f);color:var(--gs-on,#fff);padding:10px;font-size:13.5px}',
            '.crs-btn.main:hover{filter:brightness(1.07)}',
            '.crs-btn.main:disabled{opacity:.45;cursor:not-allowed}',
            '.crs-btn.sm{padding:4px 8px;font-size:11.5px;background:var(--gr-soft);color:var(--gr-ink);border-color:var(--gr-line)}',
            '.crs-btn.sm i{color:var(--gr-amber)}',
            '.crs-btn.sm:hover{border-color:color-mix(in srgb,#f2b35e 55%,transparent);background:color-mix(in srgb,#f2b35e 9%,var(--gr-card))}',
            '.crs-btn.sm.on{background:#f0a75e;color:#24170a;border-color:#f0a75e}.crs-btn.sm.on i{color:#24170a}',
            '.crs-btn.dl{background:color-mix(in srgb,#f2b35e 18%,var(--gr-card));color:var(--gr-ink);border-color:color-mix(in srgb,#f2b35e 55%,transparent)}',
            '.crs-btn.dl i{color:var(--gr-amber)}',
            '.crs-btn.dl:hover{background:#f0a75e;color:#24170a;border-color:#f0a75e}.crs-btn.dl:hover i{color:#24170a}',
            '.crs-prog{height:6px;border-radius:4px;background:var(--gr-soft);overflow:hidden;margin-top:8px;display:none}',
            '.crs-prog>div{height:100%;width:0;background:linear-gradient(90deg,#e7974c,#f6cf7a);transition:width .2s}',
            '.crs-stat{font-size:11.5px;color:var(--gr-muted);margin-top:5px;min-height:14px}',
            '.crs-res{border:1px solid var(--gr-line);border-radius:8px;padding:7px 8px;margin-top:6px;font-size:12px;background:var(--gr-soft)}',
            '.crs-res.err{border-color:color-mix(in srgb,#ff9270 40%,transparent);background:color-mix(in srgb,#ff9270 8%,var(--gr-card))}',
            '.crs-res .t{font-weight:800;color:var(--gr-ink);display:flex;align-items:center;gap:6px;word-break:break-all}',
            '.crs-res .m{color:var(--gr-muted);font-size:11px;margin-top:3px;line-height:1.4}',
            '.crs-res .a{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap}',
            '.crs-note{font-size:11px;color:var(--gr-ink);background:color-mix(in srgb,#f2b35e 12%,var(--gr-card));border:1px solid color-mix(in srgb,#f2b35e 32%,transparent);border-radius:6px;padding:4px 7px;margin-top:4px}',
            '.crs-note.ok{background:color-mix(in srgb,#a9d46b 11%,var(--gr-card));border-color:color-mix(in srgb,#a9d46b 32%,transparent)}',
            '.crs-my{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 0;border-bottom:1px dashed var(--gr-line)}',
            '.crs-my span{flex:1;word-break:break-all;color:var(--gr-ink);font-weight:700}',
            '.crs-my button{border:none;background:none;color:var(--gr-coral);cursor:pointer}',
            '.crs-hint{font-size:11px;color:var(--gr-muted);line-height:1.45}',
            '.crs-off{padding:24px 16px;text-align:center;color:var(--gr-muted);font-size:13px}',
            '.crs-adm{font-size:11px;background:color-mix(in srgb,#ff9270 11%,var(--gr-card));color:var(--gr-ink);border:1px solid color-mix(in srgb,#ff9270 34%,transparent);border-radius:6px;padding:5px 7px}',
            '.crs-mv{margin-top:7px;border-top:1px dashed var(--gr-line);padding-top:7px}',
            '.crs-mvd{font-size:11.5px;color:var(--gr-ink);background:var(--gr-soft);border-radius:6px;padding:5px 7px;margin-top:5px}',
            '.crs-mv .crs-in{min-width:0}',
            '.crs-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:8px 8px 7px;background:var(--gs-bg,#eef3ee);border-bottom:1px solid var(--gr-line);flex-shrink:0}',
            '.crs-tabs button{min-width:0;border:1px solid var(--gr-line);background:var(--gr-soft);border-radius:8px;padding:6px;font:800 11.5px Lato,Arial,sans-serif;color:var(--gr-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;line-height:1.15}',
            '.crs-tabs button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.crs-tabs button i{color:var(--gr-sand)}',
            '.crs-tabs button:hover{color:var(--gr-ink);border-color:color-mix(in srgb,#f2b35e 45%,transparent)}',
            '.crs-tabs button.on{background:var(--gr-card);border-color:color-mix(in srgb,#f2b35e 70%,transparent);color:var(--gr-ink);box-shadow:inset 0 -2px 0 #f0a75e}',
            '.crs-tabs button.on i{color:var(--gr-amber)}',
            '@media (max-width:420px){.crs-tabs button span{font-size:10.5px}}'
        ].join('\n');
        document.head.appendChild(st);
    }

    function optionsHtml(withAuto, selected) {
        var h = [];
        var sel = function (v) { return v === selected ? ' selected' : ''; };
        if (withAuto) h.push('<option value="auto"' + sel('auto') + '>⟳ Авто — из .prj / GeoTIFF</option>');
        var my = loadCustom();
        if (my.length) {
            h.push('<optgroup label="★ Мои пресеты">');
            my.forEach(function (p) { h.push('<option value="' + esc(p.id) + '"' + sel(p.id) + '>' + esc(p.name) + '</option>'); });
            h.push('</optgroup>');
        }
        var byId = {};
        catalog.presets.forEach(function (p) { byId[p.id] = p; });
        h.push('<optgroup label="Часто используемые">');
        catalog.popular.forEach(function (id) { if (byId[id]) h.push('<option value="' + id + '"' + sel(id) + '>' + esc(byId[id].name) + '</option>'); });
        h.push('</optgroup>');
        catalog.groups.forEach(function (g) {
            h.push('<optgroup label="' + esc(g.name) + '">');
            catalog.presets.forEach(function (p) {
                if (p.group === g.id) h.push('<option value="' + p.id + '">' + esc(p.name) + (p.epsg ? ' · EPSG:' + p.epsg : '') + '</option>');
            });
            h.push('</optgroup>');
        });
        return h.join('');
    }

    function filterSelect(sel, q) {
        q = (q || '').trim().toLowerCase();
        var first = null;
        Array.prototype.forEach.call(sel.querySelectorAll('option'), function (o) {
            var ok = !q || o.value === 'auto' || o.textContent.toLowerCase().indexOf(q) >= 0 || o.value.toLowerCase().indexOf(q) >= 0;
            o.hidden = !ok;
            if (ok && !first && o.value !== 'auto') first = o;
        });
        Array.prototype.forEach.call(sel.querySelectorAll('optgroup'), function (g) {
            g.hidden = !Array.prototype.some.call(g.children, function (o) { return !o.hidden; });
        });
        if (q && first) sel.value = first.value;
    }

    // ── датасеты (группировка файлов на клиенте) ────────────
    function datasets() {
        var by = {}, out = [];
        files.forEach(function (f) {
            var e = extOf(f.name), s = stemOf(f.name);
            (by[s] = by[s] || {})[e] = f;
        });
        files.forEach(function (f) {
            var e = extOf(f.name), s = stemOf(f.name), g = by[s];
            if (e === 'shp') {
                out.push({ kind: 'vector', main: f, stem: s,
                    req: REQUIRED_SHP.map(function (x) { return { e: x, ok: !!g[x] }; }),
                    side: VEC_SIDE.filter(function (x) { return g[x]; }) });
            } else if (e === 'tif' || e === 'tiff') {
                var side = RAS_SIDE.filter(function (x) { return g[x] || g[e + '.' + x] || (x === 'xml' && g['tif.xml']) || (x === 'ovr' && g['tif.ovr']) || (x === 'aux.xml' && g['tif.aux.xml']); });
                out.push({ kind: 'raster', main: f, stem: s, req: [], side: side });
            } else if (e === 'zip') {
                out.push({ kind: 'zip', main: f, stem: s, req: [], side: [] });
            }
        });
        return out;
    }

    function renderFiles() {
        var box = document.getElementById('crs-files');
        if (!box) return;
        var ds = datasets(), h = [];
        ds.forEach(function (d) {
            var icon = d.kind === 'vector' ? 'fa-draw-polygon' : d.kind === 'raster' ? 'fa-image' : 'fa-file-zipper';
            var chips = d.req.map(function (r) { return '<span class="crs-chip' + (r.ok ? '' : ' miss') + '">' + (r.ok ? '✓ ' : 'нет ') + '.' + r.e + '</span>'; })
                .concat(d.side.map(function (x) { return '<span class="crs-chip">✓ .' + x + '</span>'; }));
            if (d.kind === 'vector' && d.side.indexOf('prj') < 0) chips.push('<span class="crs-chip opt">нет .prj — укажите исходную СК</span>');
            if (d.kind === 'raster') {
                ['tfw', 'tfwx', 'xml', 'ovr'].forEach(function (x) { if (d.side.indexOf(x) < 0) chips.push('<span class="crs-chip opt">.' + x + '</span>'); });
            }
            if (d.kind === 'zip') chips.push('<span class="crs-chip opt">будет распакован на сервере</span>');
            h.push('<div class="crs-ds"><div class="t"><i class="fa-solid ' + icon + '"></i>' + esc(d.main.name) +
                '<button class="x" data-stem="' + esc(d.stem) + '" title="Убрать"><i class="fa-solid fa-xmark"></i></button></div>' +
                '<div class="crs-chips">' + chips.join('') + '</div></div>');
        });
        var orphans = files.filter(function (f) {
            var s = stemOf(f.name);
            return !ds.some(function (d) { return d.stem === s; });
        });
        if (orphans.length) {
            h.push('<div class="crs-ds"><div class="t" style="color:var(--gr-amber)"><i class="fa-solid fa-triangle-exclamation" style="color:var(--gr-honey)"></i>Без основного файла (.shp/.tif): ' +
                orphans.map(function (f) { return esc(f.name); }).join(', ') + '</div></div>');
        }
        var total = files.reduce(function (a, f) { return a + f.size; }, 0);
        if (files.length) h.push('<div class="crs-hint" style="margin-top:6px">Файлов: ' + files.length + ', ' + fmtSize(total) +
            ' · <a href="#" id="crs-clear-files" style="color:var(--gr-coral)">очистить</a></div>');
        box.innerHTML = h.join('');
        Array.prototype.forEach.call(box.querySelectorAll('.x'), function (b) {
            b.onclick = function () {
                var s = b.getAttribute('data-stem');
                files = files.filter(function (f) { return stemOf(f.name) !== s; });
                renderFiles();
            };
        });
        var cl = document.getElementById('crs-clear-files');
        if (cl) cl.onclick = function (e) { e.preventDefault(); files = []; renderFiles(); };
        updateUi();
    }

    function addFiles(list) {
        Array.prototype.forEach.call(list || [], function (f) {
            var e = extOf(f.name);
            var allowed = ACCEPT.split(',').map(function (x) { return x.slice(1); });
            if (allowed.indexOf(e.split('.').pop()) < 0 && allowed.indexOf(e) < 0) return;
            files = files.filter(function (x) { return x.name.toLowerCase() !== f.name.toLowerCase(); });
            files.push(f);
        });
        renderFiles();
    }

    function updateUi() {
        var src = document.getElementById('crs-src'), dst = document.getElementById('crs-dst');
        if (!src || !dst) return;
        var ds = datasets();
        var hasRaster = ds.some(function (d) { return d.kind === 'raster' || d.kind === 'zip'; });
        document.getElementById('crs-res-wrap').style.display = hasRaster ? '' : 'none';
        document.getElementById('crs-datum-wrap').style.display = (isKrass(src.value) || isKrass(dst.value)) ? '' : 'none';
        var good = ds.filter(function (d) { return !d.req.some(function (r) { return !r.ok; }); });
        var btn = document.getElementById('crs-go');
        btn.disabled = !good.length || (xhr !== null);
        btn.title = good.length < ds.length ? 'Неполные SHP (без .shx/.dbf) будут пропущены с ошибкой' : '';
        saveChoice({ src: src.value, dst: dst.value, datum: document.getElementById('crs-datum').value,
                     resampling: document.getElementById('crs-resampling').value });
    }

    function presetSpec(id) {
        if (id === 'auto') return { spec: 'auto', def: '' };
        var c = loadCustom().find(function (p) { return p.id === id; });
        if (c) return { spec: 'custom', def: c.def };
        return { spec: id, def: '' };
    }

    function presetName(id) {
        if (id === 'auto') return 'Авто';
        var c = loadCustom().find(function (p) { return p.id === id; });
        if (c) return c.name;
        var p = catalog.presets.find(function (x) { return x.id === id; });
        return p ? p.name : id;
    }

    // ── конвертация ─────────────────────────────────────────
    function convert() {
        if (moveSaving || moveDirty()) { afterMove(convert); return; }
        if (xhr) return;
        var ds = datasets();
        if (!ds.length) return;
        var src = presetSpec(document.getElementById('crs-src').value);
        var dst = presetSpec(document.getElementById('crs-dst').value);
        if (dst.spec === 'auto') { toast('Выберите целевую СК', true); return; }

        // ПРИНУДИТЕЛЬНО убираем результат прошлой конвертации с карты
        removeAllLayers();
        job = null;
        renderResults();

        var fd = new FormData();
        files.forEach(function (f) { fd.append('files', f, f.name); });
        fd.append('src', src.spec); fd.append('src_def', src.def);
        fd.append('dst', dst.spec); fd.append('dst_def', dst.def);
        fd.append('datum', document.getElementById('crs-datum').value);
        fd.append('resampling', document.getElementById('crs-resampling').value);

        var prog = document.getElementById('crs-prog'), bar = prog.firstChild, stat = document.getElementById('crs-stat');
        prog.style.display = 'block'; bar.style.width = '0%';
        stat.textContent = 'Загрузка файлов…';
        xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/crs/convert');
        xhr.setRequestHeader('X-CSRFToken', csrf());
        xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable) return;
            var p = Math.round(e.loaded / e.total * 100);
            bar.style.width = (p * 0.8) + '%';
            stat.textContent = p < 100 ? 'Загрузка: ' + p + '%' : 'Перепроецирование на сервере…';
        };
        xhr.onload = function () {
            var r = xhr; xhr = null;
            prog.style.display = 'none';
            var data = null;
            try { data = JSON.parse(r.responseText); } catch (e) {}
            if (r.status !== 200 || !data) {
                stat.textContent = '';
                toast('Ошибка конвертации: ' + ((data && data.detail) || ('HTTP ' + r.status)), true);
                updateUi(); return;
            }
            job = data; shifted = {};
            job._dst_id = document.getElementById('crs-dst').value;
            try { localStorage.setItem('crs_job_dst_' + job.job_id, job._dst_id); } catch (e) {}
            var ok = job.items.filter(function (i) { return i.ok; }).length;
            stat.textContent = 'Готово: ' + ok + ' из ' + job.items.length + ' → ' + (job.dst_name || '');
            toast(ok ? 'Конвертация завершена (' + ok + ')' : 'Ни один слой не сконвертирован', !ok);
            renderResults();
            updateUi();
        };
        xhr.onerror = function () {
            xhr = null; prog.style.display = 'none'; stat.textContent = '';
            toast('Сеть недоступна или файл слишком большой', true);
            updateUi();
        };
        updateUi();
        xhr.send(fd);
    }

    function renderResults() {
        var box = document.getElementById('crs-results');
        if (!box) return;
        if (!job) { box.innerHTML = '<div class="crs-hint">Здесь появятся сконвертированные файлы. Новая конвертация заменяет предыдущую — старый результат удаляется с карты и с сервера.</div>'; return; }
        var h = [];
        var okCount = job.items.filter(function (i) { return i.ok; }).length;
        job.items.forEach(function (it, i) {
            if (!it.ok) {
                h.push('<div class="crs-res err"><div class="t"><i class="fa-solid fa-circle-xmark" style="color:var(--gr-coral)"></i>' + esc(it.name) + '</div><div class="m">' + esc(it.error) + '</div></div>');
                return;
            }
            var meta = it.kind === 'vector'
                ? 'Объектов: ' + it.features + (it.geom && it.geom.length ? ' · ' + esc(it.geom.join(', ')) : '')
                : 'Растр ' + it.size[0] + '×' + it.size[1] + ' · каналов: ' + it.bands + ' · ' + esc(it.dtype);
            var on = !!layers[i];
            h.push('<div class="crs-res"><div class="t"><i class="fa-solid ' + (it.kind === 'vector' ? 'fa-draw-polygon' : 'fa-image') + '" style="color:var(--gr-amber)"></i>' + esc(it.name) + '</div>' +
                '<div class="m">' + esc(it.src) + ' → <b>' + esc(it.dst) + '</b><br>' + meta + '<br>Файлы: ' + esc((it.files || []).join(', ')) + '</div>' +
                (it.notes || []).map(function (n) { return '<div class="crs-note">' + esc(n) + '</div>'; }).join('') +
                '<div class="a"><button class="crs-btn sm' + (on ? ' on' : '') + '" data-map="' + i + '"><i class="fa-solid ' + (on ? 'fa-eye-slash' : 'fa-map-location-dot') + '"></i>' + (on ? 'Убрать с карты' : 'Проверить на карте') + '</button>' +
                '<a class="crs-btn sm" data-download="' + i + '" href="' + (shifted[i] ? shifted[i].url : it.download_url) + '" download' + (shifted[i] ? '="' + esc(shifted[i].name) + '"' : '') + '><i class="fa-solid fa-download"></i>Скачать' + (shifted[i] ? ' (сдвинутый)' : '') + '</a>' +
                (canMove(it) ? '<button class="crs-btn sm' + (mv && mv.idx === i ? ' on' : '') + '" data-move="' + i + '" title="' + (it.kind === 'vector' ? 'Перетащить слой или объект на карте и сохранить в целевой СК' : 'Перетащить растр на карте и сохранить новую привязку (GeoTIFF, .tfw, .aux.xml) в целевой СК') + '">' +
                    '<i class="fa-solid fa-up-down-left-right"></i>' + (mv && mv.idx === i ? 'Закончить' : 'Переместить') + '</button>' : '') +
                '</div>' + (mv && mv.idx === i ? moveBoxHtml(it) : '') +
                (shifted[i] ? shiftedHtml(i) : '') + '</div>');
        });
        if (okCount) {
            h.push('<div class="crs-row" style="margin-top:8px"><a class="crs-btn dl" id="crs-dl-all" style="flex:1" href="' + job.download_url + '" download><i class="fa-solid fa-file-zipper"></i>Скачать всё (zip)' + (Object.keys(shifted).length ? ' — со сдвигом' : '') + '</a>' +
                '<button class="crs-btn sm" id="crs-unmap" title="Убрать все результаты с карты"><i class="fa-solid fa-eraser"></i></button></div>');
        }
        box.innerHTML = h.join('');
        Array.prototype.forEach.call(box.querySelectorAll('[data-map]'), function (b) {
            b.onclick = function () { showOnMap(+b.getAttribute('data-map'), b); };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-move]'), function (b) {
            b.onclick = function () { toggleMove(+b.getAttribute('data-move')); };
        });
        bindMoveBox(); bindShifted();
        Array.prototype.forEach.call(box.querySelectorAll('[data-download]'), function (a) {
            a.onclick = function (e) {
                e.preventDefault(); var i = +a.getAttribute('data-download');
                afterMove(function () {
                    var s = shifted[i], link = document.createElement('a');
                    link.href = s ? s.url : job.items[i].download_url;
                    link.download = s ? s.name : ''; document.body.appendChild(link); link.click(); link.remove();
                });
            };
        });
        var dla = document.getElementById('crs-dl-all');
        if (dla) dla.onclick = function (e) { e.preventDefault(); afterMove(downloadAll); };
        Array.prototype.forEach.call(box.querySelectorAll('[data-unshift]'), function (b) {
            b.onclick = function () { unshift(+b.getAttribute('data-unshift')); };
        });
        var um = document.getElementById('crs-unmap');
        if (um) um.onclick = function () { afterMove(function () { removeAllLayers(); renderResults(); }); };
    }

    // ── мои пресеты ─────────────────────────────────────────
    function renderMy() {
        var box = document.getElementById('crs-my-list');
        if (!box) return;
        var my = loadCustom();
        box.innerHTML = my.length ? my.map(function (p) {
            return '<div class="crs-my"><i class="fa-solid fa-star" style="color:var(--gr-honey)"></i><span title="' + esc(p.def.slice(0, 400)) + '">' + esc(p.name) + '</span>' +
                '<button data-del="' + esc(p.id) + '" title="Удалить"><i class="fa-solid fa-trash"></i></button></div>';
        }).join('') : '<div class="crs-hint">Пока нет своих пресетов.</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
            b.onclick = function () {
                var id = b.getAttribute('data-del');
                saveCustom(loadCustom().filter(function (p) { return p.id !== id; }));
                refreshSelects(); renderMy();
            };
        });
    }

    function refreshSelects() {
        var src = document.getElementById('crs-src'), dst = document.getElementById('crs-dst');
        var sv = src.value, dv = dst.value;
        src.innerHTML = optionsHtml(true, sv);
        dst.innerHTML = optionsHtml(false, dv);
        if (!src.querySelector('option[value="' + CSS.escape(sv) + '"]')) src.value = 'auto'; else src.value = sv;
        if (!dst.querySelector('option[value="' + CSS.escape(dv) + '"]')) dst.value = 'wgs84_3857'; else dst.value = dv;
        updateUi();
    }

    function addPreset(text, file, name) {
        var fd = new FormData();
        if (file) fd.append('file', file, file.name); else fd.append('text', text);
        return fetch('/api/crs/parse', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRFToken': csrf() } })
            .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || ('HTTP ' + r.status)); return d; }); })
            .then(function (d) {
                var my = loadCustom();
                var p = { id: 'u_' + Date.now().toString(36), name: (name || d.name || 'Моя СК').trim(), def: d.def, krass: !!d.krass };
                if (my.some(function (x) { return x.def === p.def; })) { toast('Такой пресет уже есть'); return null; }
                my.push(p); saveCustom(my);
                refreshSelects(); renderMy();
                toast('Пресет добавлен: ' + p.name);
                return p;
            });
    }

    // ── панель ──────────────────────────────────────────────
    // ── вкладки (v20): «Смена СК» | «План → GeoTIFF/TFW → MBTiles» | «Растр → MBTiles» | «MBTiles → TIFF + TFWX» ──
    var LS_TAB = 'crs_tab_v1';
    var TABS = [
        ['crs', 'fa-arrows-rotate', 'Смена СК', 'Перепроецирование SHP и GeoTIFF: СК-42, СК-63, WGS-84, UTM…'],
        ['georef', 'fa-map-location-dot', 'План → GeoTIFF', 'Скан плана (JPG/PDF) → GeoTIFF + TFW → MBTiles'],
        ['mbtiles', 'fa-table-cells', 'Растр → MBTiles', 'GeoTIFF / растр с привязкой → MBTiles'],
        ['mb2tif', 'fa-file-image', 'MBTiles → TIFF', 'MBTiles → GeoTIFF + TFW/TFWX + PRJ (в нужной СК)']
    ];
    var curTab = 'crs', crsReady = null, shiftsRestored = false, pendingFiles = null, georefP = null, panelBox = null;

    function loadGeoref() {
        if (window.GeorefTools) return Promise.resolve(window.GeorefTools);
        if (georefP) return georefP;
        georefP = new Promise(function (ok, fail) {
            var s = document.createElement('script');
            s.src = '/static/panel-georef.js?v=' + encodeURIComponent((window._staticVer || '1') + '-georef207');   // [v20.7] — сбросить кэш браузера
            s.onload = function () { window.GeorefTools ? ok(window.GeorefTools) : fail(new Error('panel-georef.js не загрузился')); };
            s.onerror = function () { georefP = null; fail(new Error('нет /static/panel-georef.js')); };
            document.head.appendChild(s);
        });
        return georefP;
    }

    function switchTab(t) {
        if (TABS.every(function (x) { return x[0] !== t; })) t = 'crs';
        if (t !== 'crs' && curTab === 'crs' && (mv || moveSaving)) {
            afterMove(function () { if (mv) stopMove(true); switchTab(t); });
            return;
        }
        curTab = t;
        try { localStorage.setItem(LS_TAB, t); } catch (e) {}
        Array.prototype.forEach.call(document.querySelectorAll('#crs-tabs [data-tab]'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
        var body = document.getElementById('crs-body');
        if (!body) return;
        body.scrollTop = 0;
        body.innerHTML = '<div class="crs-hint" style="padding:14px;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка…</div>';
        if (t === 'crs') {
            if (window.GeorefTools) window.GeorefTools.detach();
            crsReady.then(function (ok) {
                if (curTab !== 'crs' || !document.getElementById('crs-body')) return;
                if (ok === 'off') {
                    document.getElementById('crs-body').innerHTML = '<div class="crs-off"><i class="fa-solid fa-ban" style="font-size:28px;color:var(--gr-coral);display:block;margin-bottom:8px"></i>Перепроецирование отключено администратором.<br><small>Инструменты «План → GeoTIFF» и «Растр → MBTiles» — на соседних вкладках.</small></div>';
                    return;
                }
                render(panelBox);
                if (!shiftsRestored) { shiftsRestored = true; restoreLocalShifts().then(loadServerShifts); }
                if (pendingFiles) {
                    var fl = pendingFiles; pendingFiles = null;
                    addFiles(fl);
                    var src = document.getElementById('crs-src');
                    if (src && src.querySelector('option[value="auto"]')) { src.value = 'auto'; updateUi(); }
                }
            }).catch(function (e) {
                if (curTab === 'crs' && document.getElementById('crs-body')) document.getElementById('crs-body').innerHTML = '<div class="crs-off">Не удалось загрузить конвертер: ' + esc(e.message) + '</div>';
            });
        } else {
            loadGeoref().then(function (G) {
                if (curTab !== t || !document.getElementById('crs-body')) return;
                G.render(document.getElementById('crs-body'), { mode: t, onToCrs: function (fl) { pendingFiles = fl; switchTab('crs'); } });
            }).catch(function (e) {
                if (curTab === t && document.getElementById('crs-body')) document.getElementById('crs-body').innerHTML = '<div class="crs-off">Не удалось загрузить инструмент: ' + esc(e.message) + '</div>';
            });
        }
    }

    function buildCrsPanel(container, onClose) {
        css();
        var prevWidth = container.style.width;
        container.style.width = 'min(400px, 100vw)';
        window._panelCleanup = function () { container.style.width = prevWidth || ''; };
        panelBox = container; shiftsRestored = false;

        container.innerHTML =
            '<div id="crs-wrap">' +
            '<div class="msp-header"><span class="msp-title"><i class="fa-solid fa-earth-europe"></i> Конвертер СК <small style="font-size:10px;opacity:.55;font-weight:600">v5</small></span>' +
            '<button class="msp-close" id="crs-close"><i class="fa-solid fa-xmark"></i></button></div>' +
            '<div class="crs-tabs" id="crs-tabs" role="tablist">' + TABS.map(function (t) {
                return '<button role="tab" data-tab="' + t[0] + '" title="' + esc(t[3]) + '"><i class="fa-solid ' + t[1] + '"></i><span>' + esc(t[2]) + '</span></button>';
            }).join('') + '</div>' +
            '<div id="crs-body"><div class="crs-hint" style="padding:14px;text-align:center"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка…</div></div></div>';
        document.getElementById('crs-close').onclick = onClose;
        // [FIX] Панель лежит внутри #map: клик доходил до карты, она забирала фокус
        // (_mapEl.focus()) и выпадающий список СК тут же закрывался — выбрать СК было нельзя.
        // Клавиши тоже не отдаём карте (стрелки в списке двигали карту).
        ['click', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress'].forEach(function (ev) {
            document.getElementById('crs-wrap').addEventListener(ev, function (e) { e.stopPropagation(); });
        });
        document.getElementById('crs-tabs').onclick = function (e) {
            var b = e.target.closest('[data-tab]');
            if (b && b.getAttribute('data-tab') !== curTab) switchTab(b.getAttribute('data-tab'));
        };
        var _prevCleanup = window._panelCleanup;
        window._panelCleanup = function () {
            if (moveDirty()) saveMove();
            if (mv) stopMove(true);
            if (window.GeorefTools) window.GeorefTools.detach();
            if (_prevCleanup) _prevCleanup();
        };

        crsReady = fetch('/api/crs/status', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) {
            status = st;
            if (!status.enabled && !status.is_admin) return 'off';
            return Promise.all([
                catalog ? Promise.resolve(catalog) : fetch('/api/crs/presets', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
                fetch('/api/crs/jobs/current', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { job: null }; })
            ]).then(function (res) {
                catalog = res[0];
                if (!job && res[1] && res[1].job) job = res[1].job;
                if (job && res[1] && res[1].job && res[1].job.job_id !== job.job_id) { removeAllLayers(); job = res[1].job; shifted = {}; }
                return true;
            });
        });
        var t0 = 'crs';
        try { t0 = localStorage.getItem(LS_TAB) || 'crs'; } catch (e) {}
        switchTab(t0);
    }

    function render(container) {
        var ch = loadChoice();
        var body = document.getElementById('crs-body');
        body.innerHTML =
            (status && !status.enabled ? '<div class="crs-adm"><i class="fa-solid fa-user-shield"></i> Модуль отключён для пользователей — доступен только вам как администратору.</div>' : '') +
            '<div class="crs-card"><div class="crs-h"><span class="n">1</span>Файлы</div>' +
            '<div class="crs-drop" id="crs-drop"><i class="fa-solid fa-cloud-arrow-up"></i>Перетащите файлы или нажмите для выбора' +
            '<small>SHP: .shp .shx .dbf (+ .prj .cpg .sbn .sbx .shp.xml)<br>TIFF: .tif (+ .tfw .tfwx .xml .ovr .prj) · или .zip · до ' + (status ? status.max_upload_mb : 2048) + ' МБ</small></div>' +
            '<input type="file" id="crs-file" multiple accept="' + ACCEPT + '" style="display:none">' +
            '<div id="crs-files"></div></div>' +

            '<div class="crs-card"><div class="crs-h"><span class="n">2</span>Системы координат</div>' +
            '<div class="crs-lbl">Из какой СК</div>' +
            '<input class="crs-in" id="crs-src-q" placeholder="Поиск: «C2», «зона 5», «27E», «UTM 35»…" style="margin-bottom:4px">' +
            '<select class="crs-sel" id="crs-src">' + optionsHtml(true, ch.src || 'auto') + '</select>' +
            '<button class="crs-swap" id="crs-swap" title="Поменять местами"><i class="fa-solid fa-arrow-down-up-across-line"></i> поменять</button>' +
            '<div class="crs-lbl">В какую СК</div>' +
            '<input class="crs-in" id="crs-dst-q" placeholder="Поиск СК…" style="margin-bottom:4px">' +
            '<select class="crs-sel" id="crs-dst">' + optionsHtml(false, ch.dst || 'wgs84_3857') + '</select>' +
            '<div id="crs-datum-wrap"><div class="crs-lbl"><i class="fa-solid fa-shuffle" style="color:var(--gr-amber)"></i>Переход СК-42/СК-63 ↔ WGS-84</div>' +
            '<select class="crs-sel" id="crs-datum">' + catalog.datums.map(function (d) { return '<option value="' + d.id + '"' + (d.id === (ch.datum || 'gost2001') ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') + '</select></div>' +
            '<div id="crs-res-wrap"><div class="crs-lbl"><i class="fa-solid fa-image" style="color:var(--gr-amber)"></i>Передискретизация растра</div>' +
            '<select class="crs-sel" id="crs-resampling">' +
            [['nearest', 'Ближайший сосед (без изменения значений, для классов)'], ['bilinear', 'Билинейная (снимки)'], ['cubic', 'Кубическая (снимки, мягче)'], ['lanczos', 'Ланцош (максимум резкости)']]
                .map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === (ch.resampling || 'nearest') ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
            '</select></div></div>' +

            '<div class="crs-card"><button class="crs-btn main" id="crs-go"><i class="fa-solid fa-arrows-rotate"></i>Конвертировать</button>' +
            '<div class="crs-prog" id="crs-prog"><div></div></div><div class="crs-stat" id="crs-stat"></div></div>' +

            '<div class="crs-card"><div class="crs-h"><span class="n">3</span>Результат</div><div id="crs-results"></div></div>' +

            '<div class="crs-card"><div class="crs-h"><i class="fa-solid fa-star" style="color:var(--gr-honey)"></i>Мои пресеты<span class="sp"></span>' +
            '<button class="crs-btn sm" id="crs-my-exp" title="Экспорт в JSON"><i class="fa-solid fa-file-export"></i></button>' +
            '<button class="crs-btn sm" id="crs-my-imp" title="Импорт из JSON"><i class="fa-solid fa-file-import"></i></button></div>' +
            '<div id="crs-my-list"></div>' +
            '<div class="crs-lbl">Название</div><input class="crs-in" id="crs-my-name" placeholder="Напр. «СК-63 C2 (наш лесхоз)»">' +
            '<div class="crs-lbl">WKT / PROJ / код EPSG</div><textarea class="crs-ta" id="crs-my-def" placeholder="EPSG:28405  или  +proj=tmerc …  или  PROJCS[…]"></textarea>' +
            '<div class="crs-row" style="margin-top:6px"><button class="crs-btn sm" id="crs-my-add" style="flex:1"><i class="fa-solid fa-plus"></i>Проверить и добавить</button>' +
            '<button class="crs-btn sm" id="crs-my-prj" style="flex:1"><i class="fa-solid fa-file-arrow-up"></i>Из файла .prj</button></div>' +
            '<input type="file" id="crs-my-prj-file" accept=".prj,.wkt,.txt,.qpj" style="display:none">' +
            '<input type="file" id="crs-my-imp-file" accept=".json" style="display:none">' +
            '<div class="crs-hint" style="margin-top:6px">Пресеты хранятся в этом браузере и доступны в обоих списках СК.</div></div>' +

            '<div class="crs-hint" style="padding:0 4px 8px">Для SHP создаётся новый .prj (ESRI WKT) и .cpg (UTF-8). Для TIFF — перепроецированный растр + .tfw' +
            ' (и .tfwx, если был), .prj, копия .xml метаданных и пирамиды .ovr (если были). Файлы хранятся на сервере до 24 ч.</div>';

        // файлы
        var drop = document.getElementById('crs-drop'), inp = document.getElementById('crs-file');
        drop.onclick = function () { inp.click(); };
        inp.onchange = function () { addFiles(inp.files); inp.value = ''; };
        ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
        ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
        drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });

        // СК
        var src = document.getElementById('crs-src'), dst = document.getElementById('crs-dst');
        if (ch.src && src.querySelector('option[value="' + CSS.escape(ch.src) + '"]')) src.value = ch.src;
        if (ch.dst && dst.querySelector('option[value="' + CSS.escape(ch.dst) + '"]')) dst.value = ch.dst;
        document.getElementById('crs-src-q').oninput = function (e) { filterSelect(src, e.target.value); updateUi(); };
        document.getElementById('crs-dst-q').oninput = function (e) { filterSelect(dst, e.target.value); updateUi(); };
        src.onchange = dst.onchange = updateUi;
        document.getElementById('crs-datum').onchange = updateUi;
        document.getElementById('crs-resampling').onchange = updateUi;
        document.getElementById('crs-swap').onclick = function () {
            if (src.value === 'auto') { toast('Исходная СК «Авто» — выберите конкретную, чтобы поменять местами'); return; }
            var a = src.value; src.value = dst.value; dst.value = a; updateUi();
        };
        document.getElementById('crs-go').onclick = convert;

        // мои пресеты
        document.getElementById('crs-my-add').onclick = function () {
            var t = document.getElementById('crs-my-def').value.trim();
            if (!t) { toast('Вставьте WKT, PROJ-строку или код EPSG', true); return; }
            addPreset(t, null, document.getElementById('crs-my-name').value).then(function (p) {
                if (p) { document.getElementById('crs-my-def').value = ''; document.getElementById('crs-my-name').value = ''; }
            }).catch(function (e) { toast(e.message, true); });
        };
        var prjIn = document.getElementById('crs-my-prj-file');
        document.getElementById('crs-my-prj').onclick = function () { prjIn.click(); };
        prjIn.onchange = function () {
            var f = prjIn.files[0]; prjIn.value = '';
            if (!f) return;
            addPreset(null, f, document.getElementById('crs-my-name').value || f.name.replace(/\.[^.]+$/, ''))
                .catch(function (e) { toast(e.message, true); });
        };
        document.getElementById('crs-my-exp').onclick = function () {
            var blob = new Blob([JSON.stringify(loadCustom(), null, 2)], { type: 'application/json' });
            var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'crs_presets.json';
            document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        };
        var impIn = document.getElementById('crs-my-imp-file');
        document.getElementById('crs-my-imp').onclick = function () { impIn.click(); };
        impIn.onchange = function () {
            var f = impIn.files[0]; impIn.value = '';
            if (!f) return;
            f.text().then(function (t) {
                var arr = JSON.parse(t);
                if (!Array.isArray(arr)) throw new Error('Ожидается массив пресетов');
                var my = loadCustom(), added = 0;
                arr.forEach(function (p) {
                    if (!p || !p.def || !p.name) return;
                    if (my.some(function (x) { return x.def === p.def; })) return;
                    my.push({ id: 'u_' + Date.now().toString(36) + added, name: String(p.name), def: String(p.def), krass: !!p.krass });
                    added++;
                });
                saveCustom(my); refreshSelects(); renderMy();
                toast('Импортировано пресетов: ' + added);
            }).catch(function (e) { toast('Ошибка импорта: ' + e.message, true); });
        };

        renderFiles();
        renderMy();
        renderResults();
        updateUi();
    }

    window.buildCrsPanel = buildCrsPanel;
})();
