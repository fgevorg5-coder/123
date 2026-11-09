/* dzz-extent.js — v20.8. Настоящий охват снимков ДЗЗ по данным GeoServer.
 *
 * Было (до v20.8): «Приблизить к слою» в панели «ДЗЗ — Снимки», поиск и «Съёмка по годам» приближали карту
 * по bbox, вписанным вручную в window._dzzTabs (map-core.js). Часть этих bbox грубые или ошибочные: например,
 * у 4114861-0330-PAN (02.05.2026) записано [26.2, 52.8, 27.2, 54.5] — это Минская область, а снимок лежит
 * полосой в Витебской. У 33 снимков bbox нет совсем, и охват брался из WFS без указания СК (координаты
 * молча считались градусами).
 *
 * Стало: охват берётся у самого GeoServer —
 *   1) WMS GetCapabilities рабочей области External (один запрос на все слои, EX_GeographicBoundingBox
 *      каждого COG) → «ручные» bbox в window._dzzTabs заменяются настоящими (исходные — в ld._bboxManual),
 *      результат кэшируется в localStorage на 3 суток;
 *   2) по требованию — WFS GetFeature контура снимка (…_bounds) сразу в EPSG:3857 (без путаницы осей);
 *   3) «ручной» bbox — только если GeoServer не ответил (с предупреждением).
 * Клик «Приблизить к слою» в панели ДЗЗ перехватывается в фазе захвата (для снимков со слоями GeoServer):
 * карта приближается к настоящему охвату с учётом открытых панелей, контур снимка подсвечивается.
 * API: window.DzzExtent.{zoomToFolder, zoomToKey, zoomToItems, zoomToSearchItem, resolve, findFolder, fitLL, status}.
 */
(function () {
    'use strict';
    if (window.DzzExtent) return;

    var LS_KEY = 'dzz_extent_cache_v208';
    var TTL = 3 * 24 * 3600 * 1000;
    var REGION = [19.5, 49.0, 36.5, 58.5];     // Беларусь с запасом (долгота/широта) — проверка правдоподобия
    var MAX_W = 12, MAX_H = 9;                  // снимок или лесхоз не бывает больше страны
    var ll = {};                                // короткое имя слоя GeoServer → [w, s, e, n]
    var cacheAt = 0;
    var caps = { p: null, ok: false, n: 0, err: '', failedAt: 0 };
    var shapes = {};                            // имя контура → Promise<{ll, feats}>
    var stat = { patched: 0, wfs: 0, capsLayers: 0, lastSrc: '', lastError: '' };
    var zoomSeq = 0;

    // ── справочники ─────────────────────────────────────────────────────────────────────────
    function base() { return (window.CONFIG && window.CONFIG.GEOSERVER_WMS) || '/geoserver_wms_proxy'; }
    function defs() { return window.EXTERNAL_LAYER_DEFS || []; }
    var defIdx = null, defN = -1;
    function defOf(k) {
        var a = defs();
        if (!defIdx || defN !== a.length) {
            defIdx = {}; defN = a.length;
            for (var i = 0; i < a.length; i++) if (a[i] && a[i].key) defIdx[a[i].key] = a[i];
        }
        return defIdx[k] || null;
    }
    function shortName(n) { n = String(n || ''); var i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; }
    function normLabel(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); }
    function plainLabel(ld) { return String((ld && (ld.label || ld.key)) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function toast(msg, isErr) { try { if (window.showToast) window.showToast(msg, !!isErr); } catch (_) {} }

    function eachFolder(cb) {
        var seen = [];
        [window._dzzAllTabs, window._dzzTabs].forEach(function (list) {
            (list || []).forEach(function (tab) {
                var yf = (tab && tab.yearFolders) || {};
                Object.keys(yf).forEach(function (y) {
                    (yf[y] || []).forEach(function (ld) {
                        if (!ld || seen.indexOf(ld) >= 0) return;
                        seen.push(ld); cb(ld, tab, y);
                    });
                });
            });
        });
    }
    function layersOf(ld) {
        var keys = (ld && ld.subkeys && ld.subkeys.length) ? ld.subkeys.slice() : [ld && ld.key];
        if (ld && ld.boundsKey && keys.indexOf(ld.boundsKey) < 0) keys.push(ld.boundsKey);
        var r = { rasters: [], bounds: [], other: [] };
        keys.forEach(function (k) {
            var d = defOf(k);
            if (!d || !d.sublabel || String(d.wmsUrl || 'GEOSERVER').toUpperCase().indexOf('GEOSERVER') !== 0) return;
            if (/_bounds$/i.test(k) || /_bounds$/i.test(d.sublabel)) { if (r.bounds.indexOf(d) < 0) r.bounds.push(d); }
            else if (d.isRaster) r.rasters.push(d);
            else r.other.push(d);
        });
        return r;
    }
    function isSatellite(ld) {
        return !!ld && (/^bundle_ks_/.test(ld.key || '') || (ld.subkeys || []).some(function (k) { return /^gs_ks_/.test(k); }));
    }

    // ── охваты ──────────────────────────────────────────────────────────────────────────────
    function okLL(b) {
        if (!b || b.length !== 4) return false;
        for (var i = 0; i < 4; i++) if (typeof b[i] !== 'number' || !isFinite(b[i])) return false;
        if (!(b[0] < b[2] && b[1] < b[3])) return false;
        if (b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90) return false;
        if (b[2] < REGION[0] || b[0] > REGION[2] || b[3] < REGION[1] || b[1] > REGION[3]) return false;
        return (b[2] - b[0]) <= MAX_W && (b[3] - b[1]) <= MAX_H;
    }
    function normLL(b) {                        // [w,s,e,n] или перепутанные оси [s,w,n,e]
        if (!b) return null;
        b = b.map(Number);
        if (okLL(b)) return b;
        var sw = [b[1], b[0], b[3], b[2]];
        return okLL(sw) ? sw : null;
    }
    function unionLL(list) {
        var u = null;
        (list || []).forEach(function (b) {
            if (!b) return;
            if (!u) u = b.slice();
            else { u[0] = Math.min(u[0], b[0]); u[1] = Math.min(u[1], b[1]); u[2] = Math.max(u[2], b[2]); u[3] = Math.max(u[3], b[3]); }
        });
        return u;
    }
    function r6(b) { return b.map(function (v) { return Math.round(v * 1e6) / 1e6; }); }
    function knownLL(ld) {
        var L = layersOf(ld);
        var rs = L.rasters.map(function (d) { return ll[shortName(d.sublabel)]; });
        var bs = L.bounds.map(function (d) { return ll[shortName(d.sublabel)]; });
        var rOk = rs.length && rs.every(Boolean), bOk = bs.length && bs.every(Boolean);
        var u = rOk ? unionLL(rs) : (bOk ? unionLL(bs) : unionLL(rs.filter(Boolean)));
        return u && okLL(u) ? u : null;
    }

    // ── кэш ─────────────────────────────────────────────────────────────────────────────────
    function loadCache() {
        try {
            var o = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
            if (o && o.at && Date.now() - o.at < TTL && o.ll) { ll = o.ll; cacheAt = o.at; }
        } catch (_) {}
    }
    var saveT = 0;
    function saveCache() {
        clearTimeout(saveT);
        saveT = setTimeout(function () {
            try {
                var used = {};
                defs().forEach(function (d) { var s = shortName(d && d.sublabel); if (s && ll[s]) used[s] = ll[s]; });
                localStorage.setItem(LS_KEY, JSON.stringify({ at: cacheAt || Date.now(), ll: used }));
            } catch (_) {}
        }, 400);
    }
    function patchFolder(ld) {
        if (!ld || ld.key === 'bundle_all_pans') return false;
        var u = knownLL(ld);
        if (!u) return false;
        if (!('_bboxManual' in ld)) ld._bboxManual = ld.bbox ? ld.bbox.slice() : null;
        ld.bbox = r6(u); ld._bboxSrc = 'geoserver';
        return true;
    }
    function patchAll() {
        var n = 0;
        eachFolder(function (ld) { if (patchFolder(ld)) n++; });
        stat.patched = n;
        return n;
    }

    // ── GeoServer ───────────────────────────────────────────────────────────────────────────
    function fetchText(url, ms) {
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var t = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (_) {} }, ms);
        return fetch(url, { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined }).then(function (r) {
            clearTimeout(t);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        }, function (e) { clearTimeout(t); throw e; });
    }
    function childEl(el, local) {
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) if ((c.localName || c.nodeName) === local) return c;
        return null;
    }
    function num(el) { return el ? parseFloat(String(el.textContent || '').trim()) : NaN; }
    function parseCaps(xml) {
        var doc = new DOMParser().parseFromString(xml, 'text/xml');
        if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error('GetCapabilities: XML не разобран');
        var root = doc.documentElement;
        if (/Exception/i.test(root.localName || '')) throw new Error('GetCapabilities: ' + String(root.textContent || '').trim().slice(0, 160));
        var v13 = /^1\.3/.test(root.getAttribute('version') || '1.3.0');
        var out = {}, n = 0, all = doc.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) {
            var L = all[i];
            if (L.localName !== 'Layer') continue;
            var nameEl = childEl(L, 'Name'), name = nameEl ? String(nameEl.textContent || '').trim() : '';
            if (!name) continue;                // у корневого слоя нет имени — его общий охват не берём
            var b = null, ex = childEl(L, 'EX_GeographicBoundingBox');
            if (ex) b = normLL([num(childEl(ex, 'westBoundLongitude')), num(childEl(ex, 'southBoundLatitude')),
                                num(childEl(ex, 'eastBoundLongitude')), num(childEl(ex, 'northBoundLatitude'))]);
            if (!b) {
                var lb = childEl(L, 'LatLonBoundingBox');
                if (lb) b = normLL([+lb.getAttribute('minx'), +lb.getAttribute('miny'), +lb.getAttribute('maxx'), +lb.getAttribute('maxy')]);
            }
            if (!b) {
                for (var c = L.firstElementChild; c && !b; c = c.nextElementSibling) {
                    if (c.localName !== 'BoundingBox') continue;
                    var crs = (c.getAttribute('CRS') || c.getAttribute('SRS') || '').toUpperCase();
                    var v = [+c.getAttribute('minx'), +c.getAttribute('miny'), +c.getAttribute('maxx'), +c.getAttribute('maxy')];
                    if (crs === 'CRS:84') b = normLL(v);
                    else if (crs === 'EPSG:4326') b = normLL(v13 ? [v[1], v[0], v[3], v[2]] : v);
                }
            }
            if (b) { out[shortName(name)] = r6(b); n++; }
        }
        return { ll: out, n: n };
    }
    function loadCaps(force) {
        if (caps.p && !force) return caps.p;
        if (!force && caps.failedAt && Date.now() - caps.failedAt < 60000) return Promise.reject(new Error(caps.err || 'GetCapabilities недоступен'));
        var url = base() + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&_target=GEOSERVER_EXT';
        caps.p = fetchText(url, 25000).then(function (txt) {
            var m = parseCaps(txt);
            if (!m.n) throw new Error('в GetCapabilities нет слоёв с охватом');
            Object.keys(m.ll).forEach(function (k) { ll[k] = m.ll[k]; });
            caps.ok = true; caps.n = m.n; caps.err = ''; cacheAt = Date.now(); stat.capsLayers = m.n;
            patchAll(); saveCache();
            try { document.dispatchEvent(new CustomEvent('dzz-extent:ready', { detail: { layers: m.n, patched: stat.patched } })); } catch (_) {}
            return m.n;
        });
        caps.p.catch(function (e) {
            caps.err = String((e && e.message) || e); stat.lastError = 'GetCapabilities: ' + caps.err;
            caps.p = null; caps.failedAt = Date.now();
        });
        return caps.p;
    }
    function walkCoords(c, cb) {
        if (!c || !c.length) return;
        if (typeof c[0] === 'number') { cb(c[0], c[1]); return; }
        for (var i = 0; i < c.length; i++) walkCoords(c[i], cb);
    }
    function footprint(bd) {                    // bd — описание слоя контура (…_bounds)
        var name = bd.sublabel;
        if (shapes[name]) return shapes[name];
        var url = base() + '?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=' + encodeURIComponent(name) +
            '&OUTPUTFORMAT=' + encodeURIComponent('application/json') + '&SRSNAME=EPSG:3857&MAXFEATURES=500';
        var p = fetchText(url, 15000).then(function (txt) {
            var fc;
            try { fc = JSON.parse(txt); } catch (_) { throw new Error('WFS: ответ не GeoJSON'); }
            var feats = (fc && fc.features) || [];
            var id = (shortName(name).match(/^(\d{7})/) || [])[1];
            if (id && feats.length > 1) {          // общий слой контуров — оставляем только свой снимок
                var own = feats.filter(function (f) { return JSON.stringify(f.properties || {}).indexOf(id) >= 0; });
                if (own.length) feats = own;
            }
            if (!feats.length) throw new Error('WFS: пустой контур');
            var crs = String((fc.crs && fc.crs.properties && fc.crs.properties.name) || '');
            var b = [Infinity, Infinity, -Infinity, -Infinity], small = true;
            feats.forEach(function (f) {
                walkCoords(f.geometry && f.geometry.coordinates, function (x, y) {
                    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
                    if (Math.abs(x) > 180 || Math.abs(y) > 90) small = false;
                });
            });
            var deg = /4326|CRS84/i.test(crs) || (!/3857|900913|3785|102100/.test(crs) && small);
            var llb = null, swapped = false;
            if (deg) { llb = normLL(b); swapped = !!llb && !okLL(b); }
            else if (isFinite(b[0])) {
                var a = ol.proj.toLonLat([b[0], b[1]]), c = ol.proj.toLonLat([b[2], b[3]]);
                llb = normLL([a[0], a[1], c[0], c[1]]);
            }
            if (!llb) throw new Error('WFS: охват контура вне Беларуси');
            var olFeats = null;
            if (!swapped) {
                try {
                    olFeats = new ol.format.GeoJSON().readFeatures({ type: 'FeatureCollection', features: feats },
                        { dataProjection: deg ? 'EPSG:4326' : 'EPSG:3857', featureProjection: 'EPSG:3857' });
                } catch (_) { olFeats = null; }
            }
            ll[shortName(name)] = r6(llb);
            if (!cacheAt) cacheAt = Date.now();
            stat.wfs++; saveCache();
            return { ll: llb, feats: olFeats };
        });
        shapes[name] = p;
        p.catch(function (e) { delete shapes[name]; stat.lastError = 'WFS ' + shortName(name) + ': ' + ((e && e.message) || e); });
        return p;
    }
    function firstOk(ps) {
        return new Promise(function (res, rej) {
            var left = ps.length, errs = [];
            if (!left) { rej(new Error('нет источников охвата')); return; }
            ps.forEach(function (p) { p.then(res, function (e) { errs.push(e); if (--left === 0) rej(errs[0]); }); });
        });
    }
    function manual(ld, failed) {
        var b = ('_bboxManual' in ld) ? ld._bboxManual : ld.bbox;
        b = b && normLL(b);
        if (b) return { ll: b, src: 'manual', warn: !!failed };
        throw new Error('охват снимка неизвестен');
    }
    function resolve(ld) {
        var known = knownLL(ld);
        if (known) return Promise.resolve({ ll: known, src: caps.ok ? 'geoserver' : 'cache' });
        var L = layersOf(ld), tries = [];
        if (L.bounds.length) {
            tries.push(Promise.all(L.bounds.map(footprint)).then(function (rs) {
                var u = unionLL(rs.map(function (r) { return r.ll; }));
                if (!u || !okLL(u)) throw new Error('WFS: нет охвата');
                return { ll: u, src: 'wfs', feats: [].concat.apply([], rs.map(function (r) { return r.feats || []; })) };
            }));
        }
        if (L.rasters.length || L.bounds.length) {
            tries.push(loadCaps().then(function () {
                var u = knownLL(ld);
                if (!u) throw new Error('слоя нет в GetCapabilities');
                return { ll: u, src: 'geoserver' };
            }));
        }
        if (!tries.length) return Promise.resolve().then(function () { return manual(ld, false); });
        return firstOk(tries).catch(function (e) {
            stat.lastError = String((e && e.message) || e);
            return manual(ld, true);
        });
    }

    // ── карта ───────────────────────────────────────────────────────────────────────────────
    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
        var r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
    }
    function padding() {                        // [верх, право, низ, лево] — не прячем снимок под панелями
        var map = window.map, el = map && map.getTargetElement && map.getTargetElement();
        if (!el) return [48, 48, 48, 48];
        var M = el.getBoundingClientRect(), pad = [48, 48, 48, 48];
        var sel = ['#map-slide-panel.open', '#map-right-panel', '#year-timeline-bar', '.sidebar', '#coords-panel',
                   '#left-search-panel', '.lsp-panel', '#map-icon-bar'];
        sel.forEach(function (s) {
            document.querySelectorAll(s).forEach(function (n) {
                if (!visible(n)) return;
                var r = n.getBoundingClientRect();
                var ix = Math.min(r.right, M.right) - Math.max(r.left, M.left), iy = Math.min(r.bottom, M.bottom) - Math.max(r.top, M.top);
                if (ix <= 0 || iy <= 0) return;
                if (r.bottom >= M.bottom - 90 && r.top > M.top + M.height * 0.3 && ix > M.width * 0.35) pad[2] = Math.max(pad[2], M.bottom - r.top + 24);
                else if (r.right >= M.right - 90 && r.left > M.left + M.width * 0.3) pad[1] = Math.max(pad[1], M.right - r.left + 24);
                else if (r.left <= M.left + 90 && r.right < M.right - M.width * 0.3 && iy > M.height * 0.25) pad[3] = Math.max(pad[3], r.right - M.left + 24);
            });
        });
        pad[1] = Math.min(pad[1], M.width * 0.55); pad[3] = Math.min(pad[3], M.width * 0.55);
        pad[0] = Math.min(pad[0], M.height * 0.3); pad[2] = Math.min(pad[2], M.height * 0.55);
        if (M.width - pad[1] - pad[3] < 160) { var k = (M.width - 160) / Math.max(1, pad[1] + pad[3]); pad[1] *= k; pad[3] *= k; }
        if (M.height - pad[0] - pad[2] < 140) { var q = (M.height - 140) / Math.max(1, pad[0] + pad[2]); pad[0] *= q; pad[2] *= q; }
        return pad.map(function (v) { return Math.max(8, Math.round(v)); });
    }
    function fitLL(b, opts) {
        opts = opts || {};
        var map = window.map, view = map && map.getView();
        if (!view || !b) return false;
        var ext = ol.proj.transformExtent(b, 'EPSG:4326', view.getProjection());
        try { view.cancelAnimations(); } catch (_) {}
        view.fit(ext, { padding: padding(), maxZoom: opts.maxZoom || 15, duration: opts.duration == null ? 750 : opts.duration });
        return true;
    }
    var hl = { layer: null, t: 0 };
    function hlSource() {
        if (!hl.layer) {
            hl.layer = new ol.layer.Vector({
                source: new ol.source.Vector(), zIndex: 9500,
                style: [new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.55)', width: 6 }) }),
                        new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#ffd54a', width: 3, lineDash: [12, 7] }),
                                             fill: new ol.style.Fill({ color: 'rgba(255,213,74,0.08)' }) })]
            });
            hl.layer.set('name', 'dzz-extent-highlight');
            window.map.addLayer(hl.layer);
        }
        return hl.layer.getSource();
    }
    function showOutline(feats) {
        var src = hlSource();
        src.clear(); src.addFeatures(feats);
        clearTimeout(hl.t);
        hl.t = setTimeout(function () { src.clear(); }, 4500);
    }
    function rectFeature(b) { return new ol.Feature(ol.geom.Polygon.fromExtent(ol.proj.transformExtent(b, 'EPSG:4326', 'EPSG:3857'))); }
    function flash(list, results) {
        var feats = [], waits = [];
        list.forEach(function (ld, i) {
            var r = results[i];
            if (!r || r.src === 'manual') return;
            if (r.feats && r.feats.length) { r.feats.forEach(function (f) { feats.push(f.clone()); }); return; }
            var L = layersOf(ld);
            if (L.bounds.length) {
                waits.push(Promise.all(L.bounds.map(footprint)).then(function (rs) {
                    rs.forEach(function (x) { (x.feats || []).forEach(function (f) { feats.push(f.clone()); }); });
                    if (!rs.some(function (x) { return x.feats && x.feats.length; })) feats.push(rectFeature(r.ll));
                }).catch(function () { feats.push(rectFeature(r.ll)); }));
            } else feats.push(rectFeature(r.ll));
        });
        Promise.all(waits).then(function () { if (feats.length) showOutline(feats); });
    }

    // ── публичные действия ──────────────────────────────────────────────────────────────────
    function findFolder(q) {
        if (!q) return null;
        if (typeof q === 'object') { if (q.subkeys || q.boundsKey || q.bbox) return q; if (!q.key) return null; q = q.key; }
        var s = String(q).trim(), hit = null;
        if (!s) return null;
        eachFolder(function (ld) { if (!hit && (ld.key === s || (ld.subkeys || []).indexOf(s) >= 0 || ld.boundsKey === s)) hit = ld; });
        if (hit) return hit;
        var nl = normLabel(s);
        eachFolder(function (ld) { if (!hit && ld.key !== 'bundle_all_pans' && normLabel(ld.label) === nl) hit = ld; });
        if (hit) return hit;
        var m = s.match(/(\d{7})/);
        if (m) {
            var id = m[1];
            eachFolder(function (ld) {
                if (hit || ld.key === 'bundle_all_pans') return;
                if ((ld.subkeys || []).some(function (k) { return k.indexOf('_' + id + '_') >= 0; }) ||
                    String(ld.label || '').indexOf(id) >= 0 || String(ld.key || '').indexOf(id) >= 0) hit = ld;
            });
        }
        return hit;
    }
    function zoomToItems(list, opts) {
        opts = opts || {};
        list = (list || []).map(function (x) { return findFolder(x) || x; }).filter(Boolean);
        if (!list.length || !window.map || !window.ol) return Promise.resolve(false);
        var title = opts.label || (list.length === 1 ? plainLabel(list[0]) : list.length + ' сним.');
        if (opts.toast !== false) toast('Приближение: ' + esc(title));
        var tok = ++zoomSeq;
        return Promise.all(list.map(function (ld) { return resolve(ld).catch(function () { return null; }); })).then(function (rs) {
            if (tok !== zoomSeq) return false;           // уже нажали другой снимок
            var ok = rs.filter(Boolean);
            if (!ok.length) { toast('Не удалось определить охват снимка «' + esc(title) + '»', true); return false; }
            list.forEach(function (ld, i) { if (rs[i] && rs[i].src !== 'manual') patchFolder(ld); });
            fitLL(unionLL(ok.map(function (r) { return r.ll; })), opts);
            stat.lastSrc = ok.map(function (r) { return r.src; }).join(',');
            if (ok.some(function (r) { return r.warn; }))
                toast('GeoServer не ответил — охват «' + esc(title) + '» взят из справочника и может быть неточным', true);
            if (opts.flash !== false) flash(list, rs);
            return true;
        });
    }
    function zoomToFolder(ld, opts) { return zoomToItems([ld], opts); }
    function zoomToKey(k, opts) { var f = findFolder(k); return f ? zoomToItems([f], opts) : Promise.resolve(false); }
    function zoomToSearchItem(item) {               // поиск map-core (item.type === 'dzz')
        if (!item) return false;
        var ld = null, sks = item.dzzSubkeys || [];
        for (var i = 0; i < sks.length && !ld; i++) ld = findFolder(sks[i]);
        if (!ld && item.boundsKey) ld = findFolder(item.boundsKey);
        if (!ld && item.key) ld = findFolder(item.key);
        if (!ld) return false;
        var L = layersOf(ld);
        if (!L.rasters.length && !L.bounds.length) return false;
        zoomToItems([ld], { toast: false, maxZoom: 14 });
        return true;
    }

    // ── перехват «Приблизить к слою» в панели ДЗЗ ────────────────────────────────────────────
    var ZOOM_TXT = /приблиз|к слою|показать на карте|zoom/i;
    var NOT_TXT = /скач|download|загруз|удал|delete|сохран|свойств|прозрач|opacity|инфо/i;
    var ZOOM_ICON = /magnifying-glass|search|crosshairs|location|expand|zoom|bullseye|maximize|focus|arrows-to|vector-square|map-pin/i;
    var NOT_ICON = /download|arrow-down|file-arrow|trash|eye|circle-info|info|gear|sliders|droplet|adjust|palette|xmark|times/i;
    function zoomIntent(btn) {
        var bits = [];
        ['title', 'data-tip', 'data-tooltip', 'data-title', 'aria-label', 'data-original-title', 'data-bs-original-title', 'data-hint', 'data-action']
            .forEach(function (a) { var v = btn.getAttribute(a); if (v) bits.push(v); });
        var t = String(btn.textContent || '').trim();
        if (t && t.length <= 60) bits.push(t);
        var s = bits.join(' | ');
        if (s && ZOOM_TXT.test(s)) return true;
        if (s && NOT_TXT.test(s)) return false;
        var cls = '';
        [btn].concat([].slice.call(btn.querySelectorAll('*'))).forEach(function (n) {
            for (var i = 0; n.attributes && i < n.attributes.length; i++) {
                var a = n.attributes[i];
                if (a.name === 'class' || a.name.indexOf('data-') === 0) cls += ' ' + a.value;
            }
        });
        if (NOT_ICON.test(cls)) return false;
        if (ZOOM_ICON.test(cls)) return true;
        return null;
    }
    function activeTab() {
        var b = document.querySelector('#dzz-tabs2 [data-tab-id].active');
        var id = b ? b.getAttribute('data-tab-id') : null;
        if (!id) { try { id = localStorage.getItem('dzz_active_tab'); } catch (_) {} }
        var all = window._dzzAllTabs || window._dzzTabs || [];
        for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
        return null;
    }
    function exactFolder(v) {
        var hit = null;
        eachFolder(function (ld) { if (!hit && (ld.key === v || (ld.subkeys || []).indexOf(v) >= 0)) hit = ld; });
        return hit;
    }
    function folderFromItem(item) {
        var nodes = [item].concat([].slice.call(item.querySelectorAll('*'))).slice(0, 60), i, j;
        for (i = 0; i < nodes.length; i++) {       // 1) ключ снимка в атрибутах строки
            var at = nodes[i].attributes;
            for (j = 0; at && j < at.length; j++) {
                var nm = at[j].name, v = at[j].value;
                if (!v || v.length > 160 || nm === 'class' || nm === 'style' || nm === 'title' || nm === 'type') continue;
                var f = exactFolder(v);
                if (f) return f;
            }
        }
        var lab = item.querySelector('.dzz-sub-label'), txt = normLabel((lab || item).textContent);
        if (txt) {                                // 2) подпись строки
            var f2 = null;
            eachFolder(function (ld) { if (!f2 && ld.key !== 'bundle_all_pans' && normLabel(ld.label) === txt) f2 = ld; });
            if (f2) return f2;
            var m = txt.match(/(\d{7})/);         // 3) номер снимка
            if (m) { var f3 = findFolder(m[1]); if (f3) return f3; }
        }
        var yb = item.closest('.dzz-year-block'), tab = activeTab();
        if (yb && tab) {                          // 4) позиция строки в папке года
            var list = (((tab.yearFolders || {})[yb.getAttribute('data-year')]) || []).filter(function (x) { return x.key !== tab.topKey; });
            var items = [].slice.call(yb.querySelectorAll('.dzz-sub-item'));
            if (items.length === list.length) return list[items.indexOf(item)] || null;
        }
        return null;
    }
    function onClickCapture(e) {
        if (e.defaultPrevented || (e.button != null && e.button !== 0)) return;
        var t = e.target;
        if (!t || !t.closest) return;
        var item = t.closest('.dzz-sub-item');
        if (!item) return;
        var btn = t.closest('button, [role="button"], .dzz-sub-act-btn, a');
        if (!btn || !item.contains(btn) || btn === item) return;
        if (btn.matches && btn.matches('input, label, .dzz-sub-cb')) return;
        if (zoomIntent(btn) !== true) return;
        var ld = folderFromItem(item);
        if (!ld) return;
        var L = layersOf(ld);
        if (!L.rasters.length && !L.bounds.length) return;                 // не слой GeoServer — штатный обработчик
        if (!isSatellite(ld) && !knownLL(ld)) return;                       // ЛУ без известного охвата — как раньше
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        zoomToItems([ld], { from: 'dzz-panel' });
    }

    // ── запуск ──────────────────────────────────────────────────────────────────────────────
    function missingCount() {
        var n = 0;
        eachFolder(function (ld) {
            if (ld.key === 'bundle_all_pans') return;
            var L = layersOf(ld);
            if ((L.rasters.length || L.bounds.length) && !knownLL(ld)) n++;
        });
        return n;
    }
    function start() {
        loadCache();
        window.addEventListener('click', onClickCapture, true);
        var tries = 0;
        (function wait() {
            if (window.map && window.ol && window.EXTERNAL_LAYER_DEFS && (window._dzzTabs || window._dzzAllTabs)) {
                patchAll();
                var fresh = cacheAt && Date.now() - cacheAt < TTL;
                if (fresh && missingCount() === 0) return;              // всё уже известно из кэша
                setTimeout(function () {
                    var go = function () { loadCaps().catch(function () {}); };
                    if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 4000 }); else go();
                }, fresh ? 15000 : 3500);                               // после первых тайлов карты
                return;
            }
            if (++tries < 200) setTimeout(wait, 300);
        })();
    }

    window.DzzExtent = {
        version: '20.8',
        zoomToFolder: zoomToFolder, zoomToKey: zoomToKey, zoomToItems: zoomToItems, zoomToSearchItem: zoomToSearchItem,
        resolve: function (q) { var f = findFolder(q); return f ? resolve(f) : Promise.reject(new Error('снимок не найден')); },
        findFolder: findFolder, layersOf: layersOf, isSatellite: isSatellite, knownLL: function (q) { var f = findFolder(q); return f ? knownLL(f) : null; },
        loadCaps: loadCaps, patchAll: patchAll, fitLL: fitLL, padding: padding, parseCaps: parseCaps,
        status: function () {
            return { capsOk: caps.ok, capsLayers: caps.n, capsError: caps.err, cached: Object.keys(ll).length,
                     cacheAgeMin: cacheAt ? Math.round((Date.now() - cacheAt) / 60000) : null, patched: stat.patched,
                     wfsResolved: stat.wfs, missing: missingCount(), lastSrc: stat.lastSrc, lastError: stat.lastError };
        },
        clearCache: function () { ll = {}; cacheAt = 0; try { localStorage.removeItem(LS_KEY); } catch (_) {} }
    };
    window.zoomToDzzImage = zoomToKey;
    start();
})();
