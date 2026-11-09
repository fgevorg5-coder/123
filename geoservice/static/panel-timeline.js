/* panel-timeline.js — v20.10. «Съёмка по годам»: нижняя шкала снимков ДЗЗ по типу съёмки и дате.
 *
 * v20.10:
 *   • снимок не отображался (ни сразу, ни при приближении): слои включались с именем null → тайлы шли без LAYERS
 *     и в GEOSERVER вместо GEOSERVER_EXT. Теперь передаётся настоящее имя слоя (sublabel), а map-core.js
 *     подставляет его сам, если вызвавший код имя не передал;
 *   • шкала крупнее: все размеры масштабируются переменной --ys, по умолчанию 130 %; в шапке «A− 130 % A+»
 *     (100…175 %, щелчок по проценту — вернуть 130 %), размер запоминается. В невысоком или узком окне
 *     (телефон) масштаб сам уменьшается: шкала не больше ~45 % высоты карты, на телефоне — прежний размер.
 *
 * Логика прежняя: тип съёмки → год → месяц → день → снимок, выбранный снимок показывается на карте.
 * Что изменилось в v20.8:
 *   • шкала не наезжает на кнопки справа (3D, геолокация, иконбар) и на масштабную линейку: ширина шкалы
 *     считается по фактическому положению кнопок, линейка, панель координат, плашка лесхоза и уведомления
 *     поднимаются над шкалой (CSS-переменная --ytl-h, следит ResizeObserver);
 *   • приближение к снимку — по настоящему охвату из GeoServer (window.DzzExtent, static/dzz-extent.js),
 *     а не по «ручным» bbox из window._dzzTabs; для лесоустройства — к границе лесхоза, как раньше;
 *   • фильтр типов (Все / Спутник / Лесоустройство / БЛА / Аэрофото) со счётчиками, годы, гистограмма
 *     по месяцам (цвет = тип съёмки), лента снимков месяца по дням, шаг ‹ › и клавишами ← →,
 *     «Только выбранный», «Скрыть показанные», свернуть/развернуть; состояние сохраняется.
 * Данные: window._dzzAllTabs (panel-dzz.js) или window._dzzTabs (map-core.js); слои включаются через
 * window.toggleExternalLayer(ключ, null, вкл/выкл), состояние — window.AppState.externalLayerState.
 * Вызов: window.buildYearTimelinePanel(container, onClose) — из map-core.js (кнопка «Съёмка по годам»).
 */
(function () {
    'use strict';
    var VER = '20.10';
    var LS_KEY = 'ytl208_state';
    var TYPES = {
        space:  { label: 'Спутник',        short: 'Спутник',  color: '#9c7ee8', icon: 'fa-satellite' },
        base:   { label: 'Лесоустройство', short: 'ЛУ',       color: '#66bb6a', icon: 'fa-tree' },
        uav:    { label: 'БЛА',            short: 'БЛА',      color: '#ffa726', icon: 'fa-helicopter' },
        aerial: { label: 'Аэрофото',       short: 'Аэрофото', color: '#4fc3f7', icon: 'fa-plane' },
        other:  { label: 'Прочее',         short: 'Прочее',   color: '#b0bec5', icon: 'fa-image' }
    };
    var TYPE_ORDER = ['space', 'base', 'uav', 'aerial', 'other'];
    var MON = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    var MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    var MON_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    var ALL_YEAR = -1, UNDATED = 0;
    var SIZES = [1, 1.15, 1.3, 1.5, 1.75], SIZE_DEF = 1.3;   // [v20.10] масштаб шкалы (--ys)

    var S = null;           // текущий экземпляр шкалы

    // ── утилиты ─────────────────────────────────────────────────────────────
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function plain(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function toast(m, e) { try { if (window.showToast) window.showToast(m, !!e); } catch (_) {} }
    function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function lsSet(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (_) {} }
    function layerState() { return (window.AppState && window.AppState.externalLayerState) || {}; }
    var defIdx = null, defN = -1;
    function defOf(k) {
        var a = window.EXTERNAL_LAYER_DEFS || [];
        if (!defIdx || defN !== a.length) {
            defIdx = {}; defN = a.length;
            for (var i = 0; i < a.length; i++) if (a[i] && a[i].key) defIdx[a[i].key] = a[i];
        }
        return defIdx[k] || null;
    }
    function vis(el) {
        if (!el || !el.getBoundingClientRect || !el.isConnected) return false;
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
        var r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    }
    function mapEl() {
        var m = window.map;
        return (m && m.getTargetElement && m.getTargetElement()) || document.getElementById('map');
    }

    // ── данные: снимки из конфигурации вкладок ДЗЗ ───────────────────────────
    function typeOfTab(tab) {
        var id = String((tab && tab.id) || '').toLowerCase(), lab = plain(tab && tab.label).toLowerCase(), s = id + ' ' + lab;
        if (id === 'base' || /лесоустр/.test(lab)) return 'base';
        if (id === 'space' || /спутн|космич|satell/.test(s)) return 'space';
        if (/\buav\b|bla|bpla|drone|бпла|бла\b|дрон|квадрокоп/.test(s)) return 'uav';
        if (/aer|аэро|авиа/.test(s)) return 'aerial';
        return 'other';
    }
    function parseDate(ld, keys) {
        var lab = plain(ld.label), d = null, t = null, m;
        m = lab.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (m) d = { y: +m[3], m: +m[2], d: +m[1] };
        if (!d && ld.date) {
            var s = String(ld.date);
            if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) d = { y: +m[1], m: +m[2], d: +m[3] };
            else if ((m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/))) d = { y: +m[3], m: +m[2], d: +m[1] };
        }
        for (var i = 0; i < keys.length && !t; i++) {
            var df = defOf(keys[i]);
            var mm = df && String(df.sublabel || '').match(/-(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-|_|$)/);
            if (mm) t = { y: 2000 + +mm[1], m: +mm[2], d: +mm[3], hh: +mm[4], mi: +mm[5] };
        }
        if (!d && t) d = { y: t.y, m: t.m, d: t.d };
        if (d && (d.m < 1 || d.m > 12 || d.d < 1 || d.d > 31)) d = null;
        var time = (t && d && t.y === d.y && t.m === d.m && t.d === d.d) ? pad2(t.hh) + ':' + pad2(t.mi) : '';
        return { d: d, time: time };
    }
    function titleOf(ld) {
        var s = plain(ld.label || ld.key).replace(/\s*\(\s*\d{1,2}\.\d{1,2}\.\d{4}\s*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        return s || String(ld.key);
    }
    function tabsList() {
        var out = [], ids = {};
        [window._dzzAllTabs, window._dzzTabs].forEach(function (list) {
            (list || []).forEach(function (t) {
                if (!t || !t.yearFolders) return;
                var id = String(t.id || out.length);
                if (ids[id]) return;
                ids[id] = 1; out.push(t);
            });
        });
        return out;
    }
    function collect() {
        var items = [], seen = {}, tops = [];
        tabsList().forEach(function (tab) {
            var type = typeOfTab(tab), yf = tab.yearFolders || {};
            Object.keys(yf).forEach(function (y) {
                (yf[y] || []).forEach(function (ld, idx) {
                    if (!ld || !ld.key) return;
                    var keys = (ld.subkeys && ld.subkeys.length) ? ld.subkeys.slice() : [ld.key];
                    if (ld.key === tab.topKey || ld.key === 'bundle_all_pans') { tops.push({ id: ld.key, type: type, keys: keys, ld: ld }); return; }
                    if (seen[ld.key]) return;
                    seen[ld.key] = 1;
                    var pd = parseDate(ld, keys), d = pd.d, fy = +y;
                    var year = (d && d.y) || fy || 0;
                    if (fy && d && d.y !== fy) year = fy;          // группировка — как в панели ДЗЗ (по папке года)
                    var month = (d && d.y === year) ? d.m : UNDATED, day = (d && d.y === year) ? d.d : 0;
                    items.push({
                        id: ld.key, ld: ld, tab: tab, tabId: tab.id, type: type, keys: keys,
                        mb: ld.mbtilesId || (ld.type === 'mbtiles' ? (ld.id || ld.key) : null),
                        year: year, month: month, day: day, time: (month ? pd.time : ''),
                        title: titleOf(ld), label: plain(ld.label || ld.key), ord: idx
                    });
                });
            });
        });
        items.sort(function (a, b) {
            return (a.year - b.year) || (a.month - b.month) || (a.day - b.day) ||
                   (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) ||
                   (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (a.ord - b.ord) ||
                   (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
        });
        items.forEach(function (it, i) { it.n = i; });
        return { items: items, tops: tops, sig: sigOf() };
    }
    function sigOf() {
        var n = 0, t = tabsList();
        t.forEach(function (tab) { Object.keys(tab.yearFolders || {}).forEach(function (y) { n += (tab.yearFolders[y] || []).length; }); });
        return t.length + ':' + n + ':' + ((window.EXTERNAL_LAYER_DEFS || []).length);
    }
    function isOn(it) {
        if (it.mb) { var m = window.AppState && window.AppState.mbtiles && window.AppState.mbtiles.items; return !!(m && m[it.mb] && m[it.mb].visible); }
        var st = layerState();
        return it.keys.some(function (k) { return !!st[k]; });
    }
    function dateText(it, withYear) {
        if (!it.month) return String(it.year);
        if (!it.day) return MON_FULL[it.month - 1] + ' ' + it.year;
        return pad2(it.day) + '.' + pad2(it.month) + (withYear === false ? '' : '.' + it.year);
    }
    function lhCode(it) {
        for (var i = 0; i < it.keys.length; i++) { var d = defOf(it.keys[i]); if (d && d.leskhozCode) return String(d.leskhozCode); }
        return it.ld.leskhozCode ? String(it.ld.leskhozCode) : null;
    }
    function hasForestry(code) {
        var gd = window.AppState && window.AppState.forestry && window.AppState.forestry.geoData;
        var fs = gd && (gd.features || (Array.isArray(gd) ? gd : null));
        return !!(code && fs && fs.some(function (f) { return f && f.properties && String(f.properties.code) === code; }));
    }

    // ── стили ───────────────────────────────────────────────────────────────────
    var CSS = [
        '#year-timeline-bar.ytl{position:absolute;left:10px;right:74px;bottom:8px;z-index:940;display:flex;flex-direction:column;gap:6px;padding:7px 9px 8px;',
        'background:rgba(8,16,9,.94);border:1px solid rgba(130,233,56,.24);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.45);color:#e3f2e3;',
        'font-size:12px;line-height:1.3;font-family:var(--gs-font,Inter,Lato,system-ui,sans-serif);-webkit-user-select:none;user-select:none;box-sizing:border-box;backdrop-filter:blur(6px);}',
        '.ytl *{box-sizing:border-box;}',
        '.ytl button{font-family:inherit;}',
        '.ytl-head{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;min-height:28px;}',
        '.ytl-title{display:flex;align-items:center;gap:7px;font-weight:800;font-size:13px;color:#82e938;white-space:nowrap;margin-right:4px;}',
        '.ytl-title i,.ytl-title svg{width:16px;height:16px;}',
        '.ytl-types{display:flex;gap:4px;flex-wrap:wrap;}',
        '.ytl-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:13px;border:1px solid rgba(255,255,255,.12);',
        'background:rgba(255,255,255,.04);color:#cfe3cf;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap;}',
        '.ytl-chip:hover:not([disabled]){background:rgba(130,233,56,.1);}',
        '.ytl-chip.on{background:rgba(130,233,56,.17);border-color:#82e938;color:#fff;}',
        '.ytl-chip[disabled]{opacity:.38;cursor:default;}',
        '.ytl-dot{width:9px;height:9px;border-radius:50%;flex:none;}',
        '.ytl-cnt{font-size:11px;font-weight:800;padding:1px 6px;border-radius:9px;background:rgba(255,255,255,.08);color:#bfe8a8;}',
        '.ytl-spacer{flex:1 1 0;min-width:0;}',
        '.ytl-nav{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 200px;max-width:480px;}',
        '.ytl-step{width:30px;}',
        '.ytl-step:not([disabled]){color:#82e938;border-color:rgba(130,233,56,.35);}',
        '.ytl-ibtn{width:28px;height:28px;flex:none;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#cfe3cf;',
        'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;padding:0;}',
        '.ytl-ibtn:hover:not([disabled]){background:rgba(130,233,56,.15);color:#fff;}',
        '.ytl-ibtn[disabled]{opacity:.35;cursor:default;}',
        '.ytl-ibtn i,.ytl-ibtn svg{width:15px;height:15px;}',
        '.ytl-status{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;color:#e8f5e8;font-size:12px;padding:0 4px;text-align:center;}',
        '.ytl-status small{color:#8fa58f;font-weight:600;margin-left:6px;}',
        '.ytl-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;color:#cfe3cf;white-space:nowrap;height:28px;}',
        '.ytl-switch input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none;}',
        '.ytl-sw{width:30px;height:17px;border-radius:9px;background:rgba(255,255,255,.2);position:relative;transition:background .15s;flex:none;}',
        '.ytl-sw:after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s;}',
        '.ytl-switch input:checked+.ytl-sw{background:#4caf50;}',
        '.ytl-switch input:checked+.ytl-sw:after{left:15px;}',
        '.ytl-btn{height:28px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#cfe3cf;',
        'font-weight:700;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}',
        '.ytl-btn:hover:not([disabled]){background:rgba(255,120,90,.16);color:#fff;}',
        '.ytl-btn[disabled]{opacity:.38;cursor:default;}',
        '.ytl-btn i,.ytl-btn svg{width:14px;height:14px;}',
        '.ytl-scale{display:flex;gap:8px;align-items:stretch;min-width:0;}',
        '.ytl-years{display:flex;align-items:center;gap:4px;flex:none;max-width:42%;}',
        '.ytl-ylist{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;}',
        '.ytl-ylist::-webkit-scrollbar{display:none;}',
        '.ytl-year{position:relative;min-width:62px;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#cfe3cf;',
        'display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;font-weight:800;font-size:14px;gap:1px;padding:0 8px;flex:none;}',
        '.ytl-year small{font-size:10px;font-weight:700;color:#8fa58f;}',
        '.ytl-year:hover:not([disabled]){background:rgba(130,233,56,.08);}',
        '.ytl-year.on{border-color:#82e938;background:rgba(130,233,56,.16);color:#fff;}',
        '.ytl-year.on small{color:#cdeec0;}',
        '.ytl-year[disabled]{opacity:.35;cursor:default;}',
        '.ytl-year.shown:after,.ytl-m.shown:after{content:"";position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:#ffd54a;box-shadow:0 0 0 2px rgba(8,16,9,.9);}',
        '.ytl-months{flex:1 1 auto;display:grid;gap:3px;min-width:0;}',
        '.ytl-m{position:relative;height:44px;border-radius:8px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.025);cursor:pointer;',
        'display:flex;flex-direction:column;justify-content:flex-end;padding:16px 5px 4px;overflow:hidden;min-width:0;color:#9fb59f;}',
        '.ytl-m:hover:not(.empty){background:rgba(130,233,56,.08);}',
        '.ytl-mlab{position:absolute;top:3px;left:5px;right:5px;display:flex;justify-content:space-between;gap:2px;font-size:10.5px;font-weight:700;white-space:nowrap;overflow:hidden;}',
        '.ytl-mlab b{font-weight:800;color:#d9ecd9;}',
        '.ytl-mbar{display:flex;flex-direction:column-reverse;min-height:3px;border-radius:3px;overflow:hidden;width:100%;}',
        '.ytl-mbar i{display:block;width:100%;flex:none;}',
        '.ytl-m.on{border-color:#82e938;background:rgba(130,233,56,.13);color:#e8f5e8;}',
        '.ytl-m.empty{opacity:.38;cursor:default;}',
        '.ytl-m.all{justify-content:center;align-items:center;padding:4px;text-align:center;font-weight:800;color:#cfe3cf;font-size:11px;line-height:1.15;}',
        '.ytl-m.all small{display:block;font-size:10px;color:#8fa58f;font-weight:700;}',
        '.ytl-rib{display:flex;align-items:stretch;gap:6px;min-width:0;}',
        '.ytl-rib>.ytl-ibtn{height:auto;}',
        '.ytl-ribbon{flex:1 1 auto;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;min-height:54px;align-items:stretch;padding-bottom:3px;scrollbar-width:thin;',
        'scrollbar-color:rgba(130,233,56,.35) transparent;min-width:0;}',
        '.ytl-ribbon::-webkit-scrollbar{height:6px;}',
        '.ytl-ribbon::-webkit-scrollbar-thumb{background:rgba(130,233,56,.35);border-radius:3px;}',
        '.ytl-day{flex:none;display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:54px;padding:0 8px;border-radius:10px;',
        'border:1px dashed rgba(130,233,56,.32);background:rgba(130,233,56,.04);color:#bfe8a8;cursor:pointer;font-weight:800;text-align:center;}',
        '.ytl-day:hover{background:rgba(130,233,56,.12);border-style:solid;}',
        '.ytl-day b{font-size:16px;line-height:1.05;}',
        '.ytl-day small{font-size:10px;color:#8fa58f;font-weight:700;white-space:nowrap;}',
        '.ytl-day.wide b{font-size:12px;}',
        '.ytl-card{--c:#9c7ee8;flex:none;width:248px;height:54px;display:flex;align-items:center;gap:8px;padding:0 5px 0 9px;border-radius:10px;',
        'border:1px solid rgba(255,255,255,.1);border-left:4px solid var(--c);background:rgba(255,255,255,.04);cursor:pointer;position:relative;text-align:left;color:inherit;}',
        '.ytl-card:hover{background:rgba(255,255,255,.08);}',
        '.ytl-card.sel{border-color:#82e938;border-left-color:var(--c);box-shadow:inset 0 0 0 1px #82e938;background:rgba(130,233,56,.11);}',
        '.ytl-ci{color:var(--c);font-size:15px;flex:none;display:inline-flex;}',
        '.ytl-ci svg,.ytl-ci i{width:17px;height:17px;}',
        '.ytl-ct{flex:1 1 auto;min-width:0;}',
        '.ytl-ct b{display:block;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eef7ee;}',
        '.ytl-ct small{display:block;font-size:10.5px;color:#8fa58f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ytl-ca{display:flex;flex-direction:column;gap:3px;flex:none;}',
        '.ytl-ca button{width:22px;height:21px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.2);color:#9fb59f;padding:0;',
        'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;}',
        '.ytl-ca button:hover{color:#fff;border-color:#82e938;}',
        '.ytl-ca button i,.ytl-ca button svg{width:13px;height:13px;}',
        '.ytl-card.shown .ytl-eye{color:#1b2a10;background:#ffd54a;border-color:#ffd54a;}',
        '.ytl-card.shown .ytl-ct small:before{content:"● ";color:#ffd54a;}',
        '.ytl-size{display:inline-flex;align-items:center;gap:2px;flex:none;}',
        '.ytl-sz{font-weight:800;font-size:12px;letter-spacing:-.5px;}',
        '.ytl-szv{min-width:44px;height:28px;padding:0 4px;border:0;border-radius:6px;background:none;color:#9fb59f;font-weight:800;font-size:11px;cursor:pointer;}',
        '.ytl-szv:hover{color:#fff;background:rgba(130,233,56,.1);}',
        '.ytl-szv.capped{color:#ffd54a;}',
        '.ytl.compact .ytl-szv,.ytl.mid .ytl-szv{display:none;}',
        '.ytl-tshort{display:none;}',
        '.ytl.mid .ytl-tfull{display:none;}',
        '.ytl.mid .ytl-tshort{display:inline;}',
        '.ytl.tight .ytl-title span{display:none;}',
        '.ytl.tight .ytl-nav{flex-basis:150px;}',
        '.ytl-m.shown:after{top:auto;bottom:3px;right:3px;}',
        '.ytl-empty{color:#8fa58f;padding:0 12px;font-style:italic;display:flex;align-items:center;white-space:nowrap;}',
        '.ytl.collapsed .ytl-scale,.ytl.collapsed .ytl-rib{display:none;}',
        '.ytl.compact .ytl-scale{flex-direction:column;}',
        '.ytl.compact .ytl-years{max-width:none;}',
        '.ytl.compact .ytl-year{height:30px;min-width:54px;flex-direction:row;gap:5px;font-size:13px;}',
        '.ytl.compact .ytl-m{height:38px;padding:14px 3px 3px;}',
        '.ytl.compact .ytl-mlab{font-size:9.5px;left:3px;right:3px;}',
        '.ytl.compact .ytl-mlab b{display:none;}',
        '.ytl.compact .ytl-title span,.ytl.compact .ytl-chip .ytl-tl,.ytl.compact .ytl-switch .ytl-tl,.ytl.compact .ytl-btn .ytl-tl{display:none;}',
        '.ytl.compact .ytl-card{width:168px;}',
        '.ytl-yshort{display:none;}',
        '.ytl.compact .ytl-yfull,.ytl.compact .ytl-m.all small{display:none;}',
        '.ytl.compact .ytl-yshort{display:inline;}',
        '.ytl.mid .ytl-switch .ytl-tl,.ytl.mid .ytl-btn .ytl-tl{display:none;}',
        '.ytl.compact .ytl-nav{max-width:none;flex:1 1 100%;order:20;}',
        /* всё, что стоит у нижнего края карты, — над шкалой. :not(#ytl-x) поднимает специфичность выше правил
           дизайн-системы v17 (html[data-ui="v17"][lang] body #custom-scale-bar{bottom:16px!important}) */
        'body.timeline-active #custom-scale-bar:not(#ytl-x){bottom:calc(var(--ytl-h,150px) + 10px)!important;}',
        'body.timeline-active #coords-panel:not(#ytl-x){bottom:calc(var(--ytl-h,150px) + 66px)!important;}',
        'body.timeline-active #selected-leshoz-bar:not(#ytl-x){bottom:calc(var(--ytl-h,150px) + 10px)!important;}',
        'body.timeline-active .ol-attribution:not(#ytl-x){bottom:calc(var(--ytl-h,150px) + 6px)!important;}',
        'body.timeline-active #_global_toast:not(#ytl-x),body.timeline-active #toast-container:not(#ytl-x){bottom:calc(var(--ytl-vh,160px) + 14px)!important;}',
        'body.timeline-active .ytl-lifted:not(#ytl-x){translate:0 calc(-1 * var(--ytl-lift,0px))!important;}'
    ].join('\n');
    // [v20.10] масштаб: каждое «Npx» (кроме 1px-границ и правил для body) → calc(var(--ys,1)*Npx)
    CSS = CSS.split('\n').map(function (l) {
        if (/^body\.timeline-active/.test(l)) return l;
        return l.replace(/(^|[^\w.-])(\d*\.?\d+)px\b/g, function (m, pre, n) { return +n <= 1 ? m : pre + 'calc(var(--ys,1)*' + n + 'px)'; });
    }).join('\n');
    function ensureCss() {
        var st = document.getElementById('ytl208-css');
        if (!st) { st = document.createElement('style'); st.id = 'ytl208-css'; document.head.appendChild(st); }
        if (st.textContent !== CSS) st.textContent = CSS;
    }

    // ── построение ──────────────────────────────────────────────────────────────
    function build(container, onClose) {
        if (S) destroy(true);
        ensureCss();
        var saved = lsGet();
        var host = mapEl() || document.body;
        var old = document.getElementById('year-timeline-bar');
        if (old) old.remove();
        var bar = document.createElement('div');
        bar.id = 'year-timeline-bar';
        bar.className = 'ytl';
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Съёмка по годам');
        if (host === document.body) bar.style.position = 'fixed';
        host.appendChild(bar);

        S = {
            bar: bar, host: host, onClose: onClose, data: collect(),
            type: (saved.type === 'all' || TYPES[saved.type]) ? saved.type : 'all',
            year: saved.year || 0, month: (saved.month == null ? null : saved.month), sel: saved.sel || null,
            exclusive: saved.exclusive !== false, collapsed: !!saved.collapsed,
            size: SIZES.indexOf(+saved.size) >= 0 ? +saved.size : SIZE_DEF, eff: 0,
            timers: [], offs: [], shownSig: '', lifted: [], ro: null
        };
        if (S.collapsed) bar.classList.add('collapsed');
        S.eff = S.size; bar.style.setProperty('--ys', String(S.size));
        // если на карте уже показан снимок — начинаем с него
        var on = S.data.items.filter(isOn);
        if (on.length) {
            var cur = on.filter(function (x) { return x.id === S.sel; })[0] || on[on.length - 1];
            S.sel = cur.id; S.year = cur.year;
            if (S.type !== 'all' && S.type !== cur.type) S.type = 'all';
            if (S.month !== ALL_YEAR) S.month = cur.month;
        }
        normalize();

        // события шкалы не должны доходить до карты
        ['mousedown', 'pointerdown', 'dblclick', 'touchstart', 'contextmenu', 'click'].forEach(function (ev) {
            bar.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
        });
        bar.addEventListener('wheel', onWheel, { passive: false });
        bar.addEventListener('click', onClick, false);
        bar.addEventListener('change', onChange, false);
        listen(window, 'keydown', onKey, true);       // захват: раньше клавиатурного сдвига карты OpenLayers
        listen(window, 'resize', layoutSoon, false);
        listen(document, 'fullscreenchange', layoutSoon, false);
        listen(window, 'dzz-extent:ready', function () { if (S) renderRibbon(); }, false);
        if (window.ResizeObserver) {
            S.ro = new ResizeObserver(function () { updateVars(); });
            S.ro.observe(bar);
            if (host !== document.body) S.ro.observe(host);
        }
        S.timers.push(setInterval(poll, 1500));
        // линейка видна (поднята над шкалой), если её не отключили в настройках
        var csb = document.getElementById('custom-scale-bar');
        if (csb && localStorage.getItem('ui_scale_bar') !== 'false') csb.style.display = '';

        window._panelCleanup = function () { destroy(false); };
        render();
        layout();
        S.timers.push(setTimeout(layout, 260), setTimeout(layout, 900));
        scrollToSel(false);
        return bar;
    }
    function listen(t, ev, fn, opt) { t.addEventListener(ev, fn, opt); S.offs.push(function () { t.removeEventListener(ev, fn, opt); }); }

    function destroy(rebuilding) {
        if (!S) return;
        var s = S; S = null;
        s.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
        s.offs.forEach(function (f) { try { f(); } catch (_) {} });
        if (s.ro) try { s.ro.disconnect(); } catch (_) {}
        s.lifted.forEach(function (n) { n.classList.remove('ytl-lifted'); });
        if (s.bar && s.bar.parentNode) s.bar.parentNode.removeChild(s.bar);
        var root = document.documentElement.style;
        root.removeProperty('--ytl-h'); root.removeProperty('--ytl-vh'); root.removeProperty('--ytl-lift');
        if (rebuilding) return;
        // Закрытие не через крестик (переключились на другую панель): возвращаем то, что спрятал map-core
        if (document.body.classList.contains('timeline-active')) {
            document.body.classList.remove('timeline-active');
            var fs = document.getElementById('map-fullscreen-btn');
            if (fs) fs.style.display = localStorage.getItem('ui_fullscreen_btn') !== 'false' ? '' : 'none';
            var csb = document.getElementById('custom-scale-bar');
            if (csb && localStorage.getItem('ui_scale_bar') !== 'false') csb.style.display = '';
            var sb = document.querySelector('.sidebar');
            if (sb && localStorage.getItem('ui_sidebar') !== 'false' && sb.style.display === 'none') {
                sb.style.display = '';
                setTimeout(function () { try { window.map && window.map.updateSize(); } catch (_) {} if (window._updateScaleBarOffset) window._updateScaleBarOffset(); }, 200);
            }
            window._timelineCloseHandler = null;
        }
    }
    function save() {
        if (!S) return;
        lsSet({ type: S.type, year: S.year, month: S.month, sel: S.sel, exclusive: S.exclusive, collapsed: S.collapsed, size: S.size });
    }

    // ── выборка ─────────────────────────────────────────────────────────────────
    function F() { return S.data.items.filter(function (it) { return S.type === 'all' || it.type === S.type; }); }
    function yearsAll() { var y = {}; S.data.items.forEach(function (it) { y[it.year] = 1; }); return Object.keys(y).map(Number).sort(function (a, b) { return a - b; }); }
    function inYear(list, y) { return list.filter(function (it) { return it.year === y; }); }
    function viewItems() {
        var l = inYear(F(), S.year);
        if (S.month === ALL_YEAR) return l;
        return l.filter(function (it) { return it.month === S.month; });
    }
    function normalize() {
        var f = F();
        if (!f.length && S.type !== 'all') { S.type = 'all'; f = F(); }
        if (!f.length) return;
        if (!inYear(f, S.year).length) S.year = f[f.length - 1].year;
        var y = inYear(f, S.year);
        if (S.month !== ALL_YEAR && !y.some(function (it) { return it.month === S.month; })) {
            var sel = y.filter(function (it) { return it.id === S.sel; })[0];
            S.month = sel ? sel.month : y[y.length - 1].month;
        }
    }
    function byId(id) { for (var i = 0; i < S.data.items.length; i++) if (S.data.items[i].id === id) return S.data.items[i]; return null; }

    // ── отрисовка ───────────────────────────────────────────────────────────────
    function render() {
        if (!S) return;
        var b = S.bar;
        b.innerHTML =
            '<div class="ytl-head">' +
                '<div class="ytl-title" title="Съёмка по годам — снимки ДЗЗ по типу съёмки и дате"><i class="fa-solid fa-clock-rotate-left"></i><span>Съёмка по годам</span></div>' +
                '<div class="ytl-types" role="radiogroup" aria-label="Тип съёмки">' + typesHtml() + '</div>' +
                '<div class="ytl-spacer"></div>' +
                '<div class="ytl-nav"><div class="ytl-status" data-role="status"></div></div>' +
                '<label class="ytl-switch" title="При выборе снимка остальные снимки этого типа скрываются с карты">' +
                    '<input type="checkbox" data-act="excl"' + (S.exclusive ? ' checked' : '') + '><span class="ytl-sw"></span><span class="ytl-tl">Только выбранный</span></label>' +
                '<button type="button" class="ytl-btn" data-act="hideall" title="Скрыть с карты снимки, показанные сейчас (с учётом фильтра типа)"><i class="fa-solid fa-eye-slash"></i><span class="ytl-tl">Скрыть показанные</span> <span class="ytl-cnt" data-role="shown">0</span></button>' +
                '<div class="ytl-size" role="group" aria-label="Размер шкалы">' +
                    '<button type="button" class="ytl-ibtn ytl-sz" data-act="szdn" title="Мельче">A−</button>' +
                    '<button type="button" class="ytl-szv" data-act="szdef" data-role="size"></button>' +
                    '<button type="button" class="ytl-ibtn ytl-sz" data-act="szup" title="Крупнее">A+</button>' +
                '</div>' +
                '<button type="button" class="ytl-ibtn" data-act="collapse" title="' + (S.collapsed ? 'Развернуть шкалу' : 'Свернуть шкалу') + '"><i class="fa-solid ' + (S.collapsed ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i></button>' +
                '<button type="button" class="ytl-ibtn" data-act="close" title="Закрыть «Съёмку по годам»"><i class="fa-solid fa-xmark"></i></button>' +
            '</div>' +
            '<div class="ytl-scale">' +
                '<div class="ytl-years"><button type="button" class="ytl-ibtn" data-act="yprev" title="Предыдущий год"><i class="fa-solid fa-chevron-left"></i></button>' +
                    '<div class="ytl-ylist" data-role="years"></div>' +
                    '<button type="button" class="ytl-ibtn" data-act="ynext" title="Следующий год"><i class="fa-solid fa-chevron-right"></i></button></div>' +
                '<div class="ytl-months" data-role="months"></div>' +
            '</div>' +
            '<div class="ytl-rib">' +
                '<button type="button" class="ytl-ibtn ytl-step" data-act="prev" title="Предыдущий снимок (←)"><i class="fa-solid fa-chevron-left"></i></button>' +
                '<div class="ytl-ribbon" data-role="ribbon" tabindex="0" aria-label="Снимки"></div>' +
                '<button type="button" class="ytl-ibtn ytl-step" data-act="next" title="Следующий снимок (→)"><i class="fa-solid fa-chevron-right"></i></button>' +
            '</div>';
        renderScale();
        renderRibbon();
        syncShown(true);
        sizeUi();
    }
    function sizeUi() {
        if (!S) return;
        var v = S.bar.querySelector('[data-role="size"]'), i = SIZES.indexOf(S.size);
        if (v) {
            var capped = S.eff && S.eff < S.size;
            v.textContent = Math.round((capped ? S.eff : S.size) * 100) + '%';
            v.classList.toggle('capped', !!capped);
            v.title = 'Размер шкалы: ' + Math.round(S.size * 100) + '%' +
                (capped ? ' (окно невысокое — показано ' + Math.round(S.eff * 100) + '%)' : '') +
                (S.size !== SIZE_DEF ? '. Щелчок — вернуть ' + Math.round(SIZE_DEF * 100) + '%' : '');
        }
        var dn = S.bar.querySelector('[data-act="szdn"]'), up = S.bar.querySelector('[data-act="szup"]');
        if (dn) dn.disabled = i <= 0;
        if (up) up.disabled = i >= SIZES.length - 1;
    }
    function setSize(v) {
        if (!S) return;
        v = +v;
        if (SIZES.indexOf(v) < 0) v = SIZE_DEF;
        S.size = v; save();
        layout(); sizeUi(); scrollToSel(false);
        S.timers.push(setTimeout(function () { layout(); sizeUi(); }, 160));
    }
    function typesHtml() {
        var cnt = { all: S.data.items.length };
        S.data.items.forEach(function (it) { cnt[it.type] = (cnt[it.type] || 0) + 1; });
        var h = '<button type="button" class="ytl-chip' + (S.type === 'all' ? ' on' : '') + '" data-type="all" role="radio" aria-checked="' + (S.type === 'all') + '" title="Все типы съёмки">' +
                '<span class="ytl-tl">Все</span><span class="ytl-cnt">' + cnt.all + '</span></button>';
        TYPE_ORDER.forEach(function (t) {
            if (t === 'other' && !cnt[t]) return;      // БЛА и аэрофото показываем всегда — как вкладки панели ДЗЗ
            var T = TYPES[t], n = cnt[t] || 0;
            h += '<button type="button" class="ytl-chip' + (S.type === t ? ' on' : '') + '" data-type="' + t + '" role="radio" aria-checked="' + (S.type === t) + '"' +
                 (n ? '' : ' disabled') + ' title="' + esc(T.label + (n ? ': ' + n + ' сн.' : ': снимков нет')) + '">' +
                 '<span class="ytl-dot" style="background:' + T.color + '"></span><span class="ytl-tl">' + (T.short === 'ЛУ' ? '<span class="ytl-tfull">Лесоустройство</span><span class="ytl-tshort">ЛУ</span>' : esc(T.label)) + '</span><span class="ytl-cnt">' + n + '</span></button>';
        });
        return h;
    }
    function renderScale() {
        var f = F(), ys = yearsAll();
        var yh = '';
        ys.forEach(function (y) {
            var n = inYear(f, y).length;
            yh += '<button type="button" class="ytl-year' + (y === S.year ? ' on' : '') + '" data-year="' + y + '"' + (n ? '' : ' disabled') +
                  ' title="' + y + ': ' + n + ' сн.">' + y + '<small>' + n + ' сн.</small></button>';
        });
        var yl = S.bar.querySelector('[data-role="years"]');
        yl.innerHTML = yh || '<span class="ytl-empty">Нет снимков</span>';
        var yi = ys.indexOf(S.year);
        S.bar.querySelector('[data-act="yprev"]').disabled = !ys.slice(0, Math.max(0, yi)).some(function (y) { return inYear(f, y).length; });
        S.bar.querySelector('[data-act="ynext"]').disabled = !(yi >= 0 && ys.slice(yi + 1).some(function (y) { return inYear(f, y).length; }));
        var on = yl.querySelector('.on');
        if (on) { var L = yl.scrollLeft, r = on.offsetLeft - yl.offsetLeft; if (r < L || r + on.offsetWidth > L + yl.clientWidth) yl.scrollLeft = Math.max(0, r - 10); }

        var y = inYear(f, S.year), per = {}, und = [];
        for (var m = 1; m <= 12; m++) per[m] = [];
        y.forEach(function (it) { if (it.month) per[it.month].push(it); else und.push(it); });
        var max = 1;
        for (m = 1; m <= 12; m++) max = Math.max(max, per[m].length);
        var cols = 13 + (und.length ? 1 : 0);
        var mh = '<button type="button" class="ytl-m all' + (S.month === ALL_YEAR ? ' on' : '') + '" data-month="-1" title="Все снимки ' + S.year + ' года: ' + y.length + '"><span class="ytl-yfull">Весь год</span><span class="ytl-yshort">Год</span><small>' + y.length + ' сн.</small></button>';
        if (und.length) {
            var allBase = und.every(function (it) { return it.type === 'base'; });
            mh += monthCell(UNDATED, allBase ? 'ЛУ' : 'Без даты', und, Math.max(max, und.length),
                allBase ? 'Лесоустройство ' + S.year + ' (без даты съёмки): ' + und.length : 'Без даты съёмки: ' + und.length);
        }
        for (m = 1; m <= 12; m++) mh += monthCell(m, MON[m - 1], per[m], max, MON_FULL[m - 1] + ' ' + S.year + ': ' + per[m].length + ' сн.');
        var mo = S.bar.querySelector('[data-role="months"]');
        mo.style.gridTemplateColumns = 'minmax(calc(var(--ys,1)*60px),1.1fr) repeat(' + (cols - 1) + ', minmax(0,1fr))';
        mo.innerHTML = mh;
    }
    function monthCell(m, lab, list, max, tip) {
        var n = list.length, h = Math.round(Math.max(n ? 14 : 0, Math.min(100, n / max * 100)));
        var by = {};
        list.forEach(function (it) { by[it.type] = (by[it.type] || 0) + 1; });
        var segs = '';
        TYPE_ORDER.forEach(function (t) { if (by[t]) segs += '<i style="height:' + (by[t] / n * 100) + '%;background:' + TYPES[t].color + '"></i>'; });
        return '<button type="button" class="ytl-m' + (S.month === m ? ' on' : '') + (n ? '' : ' empty') + '" data-month="' + m + '"' + (n ? '' : ' disabled') + ' title="' + esc(tip) + '">' +
               '<span class="ytl-mlab"><span>' + esc(lab) + '</span>' + (n ? '<b>' + n + '</b>' : '') + '</span>' +
               '<span class="ytl-mbar" style="height:' + h + '%">' + segs + '</span></button>';
    }
    function renderRibbon() {
        if (!S) return;
        var rb = S.bar.querySelector('[data-role="ribbon"]');
        if (!rb) return;
        var list = viewItems();
        if (!S.data.items.length) { rb.innerHTML = '<div class="ytl-empty">В панели «ДЗЗ — Снимки» нет снимков</div>'; statusUpd(); return; }
        if (!list.length) { rb.innerHTML = '<div class="ytl-empty">Нет снимков за выбранный период — выберите другой месяц или год</div>'; statusUpd(); return; }
        var h = '', gk = null;
        list.forEach(function (it) {
            var k = it.month ? it.month + '-' + it.day : 'u';
            if (k !== gk) {
                gk = k;
                var grp = list.filter(function (x) { return (x.month ? x.month + '-' + x.day : 'u') === k; });
                if (it.month && it.day) {
                    h += '<button type="button" class="ytl-day" data-day="' + k + '" title="' + esc('Показать все снимки за ' + it.day + ' ' + MON_GEN[it.month - 1] + ' ' + it.year + ' (' + grp.length + ')') + '">' +
                         '<b>' + it.day + '</b><small>' + MON_GEN[it.month - 1].slice(0, 3) + (S.month === ALL_YEAR ? '' : '') + ' · ' + grp.length + '</small></button>';
                } else {
                    var allBase = grp.every(function (x) { return x.type === 'base'; });
                    h += '<button type="button" class="ytl-day wide" data-day="' + k + '" title="' + esc('Показать все: ' + (allBase ? 'лесоустройство ' : 'без даты ') + it.year + ' (' + grp.length + ')') + '">' +
                         '<b>' + (allBase ? 'ЛУ ' + it.year : 'Без даты') + '</b><small>' + grp.length + ' сн.</small></button>';
                }
            }
            h += cardHtml(it);
        });
        rb.innerHTML = h;
        statusUpd();
    }
    function cardHtml(it) {
        var T = TYPES[it.type] || TYPES.other;
        var meta = it.month ? (dateText(it) + (it.time ? ' · ' + it.time : '')) : (T.label + ' · ' + it.year);
        var tip = it.label + '\n' + T.label + (it.month ? ', ' + dateText(it) + (it.time ? ' ' + it.time : '') : ', ' + it.year) +
                  '\nЩелчок — показать на карте и приблизить';
        return '<div class="ytl-card' + (it.id === S.sel ? ' sel' : '') + '" role="button" tabindex="-1" data-id="' + esc(it.id) + '" style="--c:' + T.color + '" title="' + esc(tip) + '">' +
               '<span class="ytl-ci"><i class="fa-solid ' + T.icon + '"></i></span>' +
               '<span class="ytl-ct"><b>' + esc(it.title) + '</b><small>' + esc(meta) + '</small></span>' +
               '<span class="ytl-ca">' +
                   '<button type="button" class="ytl-eye" data-act="eye" title="Показать / скрыть на карте (без приближения)"><i class="fa-solid fa-eye"></i></button>' +
                   '<button type="button" data-act="zoom" title="Приблизить к снимку"><i class="fa-solid fa-crosshairs"></i></button>' +
               '</span></div>';
    }
    function statusUpd() {
        if (!S) return;
        var st = S.bar.querySelector('[data-role="status"]');
        if (!st) return;
        var it = S.sel && byId(S.sel), f = F();
        var i = it ? f.indexOf(it) : -1;
        if (it) {
            var T = TYPES[it.type] || TYPES.other;
            st.innerHTML = '<span style="color:' + T.color + '">●</span> ' + esc(it.title) + '<small>' + esc(it.month ? dateText(it) + (it.time ? ' ' + it.time : '') : T.label + ' ' + it.year) +
                           (i >= 0 ? ' · ' + (i + 1) + '/' + f.length : '') + '</small>';
            st.title = it.label + (it.month ? ', ' + (it.day ? it.day + ' ' + MON_GEN[it.month - 1] + ' ' + it.year : dateText(it)) + (it.time ? ', ' + it.time : '') : '') +
                       (i >= 0 ? ' — ' + (i + 1) + ' из ' + f.length : '');
        } else {
            st.innerHTML = 'Выберите снимок<small>' + f.length + ' сн.</small>';
            st.title = '';
        }
        var p = S.bar.querySelector('[data-act="prev"]'), n = S.bar.querySelector('[data-act="next"]');
        if (p) p.disabled = !f.length || i === 0;
        if (n) n.disabled = !f.length || (i >= 0 && i === f.length - 1);
    }
    function syncShown(force) {
        if (!S) return;
        var st = layerState(), sig = '', shown = {};
        S.data.items.forEach(function (it) { if (isOn(it)) { shown[it.id] = 1; sig += it.id + ','; } });
        S.data.tops.forEach(function (t) { if (isOn(t)) sig += '*' + t.id + ','; });
        if (!force && sig === S.shownSig) return;
        S.shownSig = sig;
        S.bar.querySelectorAll('.ytl-card').forEach(function (c) {
            var on = !!shown[c.getAttribute('data-id')];
            c.classList.toggle('shown', on);
            var e = c.querySelector('.ytl-eye');
            if (e) e.title = on ? 'Скрыть с карты' : 'Показать на карте (без приближения)';
        });
        var f = F(), yS = {}, mS = {}, n = 0;
        f.forEach(function (it) { if (shown[it.id]) { n++; yS[it.year] = 1; if (it.year === S.year) mS[it.month] = 1; } });
        n += S.data.tops.filter(function (t) { return (S.type === 'all' || t.type === S.type) && isOn(t); }).length;
        S.bar.querySelectorAll('.ytl-year').forEach(function (y) { y.classList.toggle('shown', !!yS[+y.getAttribute('data-year')]); });
        S.bar.querySelectorAll('.ytl-m').forEach(function (m) { var k = +m.getAttribute('data-month'); m.classList.toggle('shown', k !== ALL_YEAR && !!mS[k]); });
        var c = S.bar.querySelector('[data-role="shown"]');
        if (c) c.textContent = n;
        var hb = S.bar.querySelector('[data-act="hideall"]');
        if (hb) hb.disabled = !n;
    }
    function poll() {
        if (!S) return;
        if (!S.bar.isConnected) { destroy(false); return; }
        if (sigOf() !== S.data.sig) {               // panel-dzz.js догрузил вкладки (БЛА, аэрофото…)
            S.data = collect(); normalize(); render(); layoutSoon(); return;
        }
        syncShown(false);
    }

    // ── раскладка: не перекрывать кнопки справа, поднимать нижние элементы карты ─────────
    var layT = 0;
    function layoutSoon() { clearTimeout(layT); layT = setTimeout(layout, 60); }
    function layout() {
        if (!S) return;
        var bar = S.bar, host = S.host;
        var M = (host === document.body ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight } : host.getBoundingClientRect());
        S.lifted.forEach(function (n) { n.classList.remove('ytl-lifted'); });
        S.lifted = [];
        var right = 10, left = 10, cands = [];
        var bandTop = M.bottom - Math.max(bar.offsetHeight || 150, 120) - 16;
        ['#map-right-panel', '#map-icon-bar', '.map-icon-bar', '#map-view3d-btn', '#map-geoloc-btn', '#map-fullscreen-btn', '.ol-zoom', '.ol-rotate:not(.ol-hidden)']
            .forEach(function (s) {
                document.querySelectorAll(s).forEach(function (n) {
                    if (bar.contains(n) || !vis(n)) return;
                    var r = n.getBoundingClientRect();
                    if (r.right < M.right - 200 || r.left >= M.right || r.bottom <= bandTop || r.top >= M.bottom) return;
                    if (r.width > M.width * 0.5) return;
                    cands.push(n);
                    right = Math.max(right, M.right - r.left + 8);
                });
            });
        ['.lsp-panel', '#left-search-panel', '#map-left-panel'].forEach(function (s) {
            document.querySelectorAll(s).forEach(function (n) {
                if (!vis(n)) return;
                var r = n.getBoundingClientRect();
                if (r.left > M.left + 200 || r.right <= M.left || r.bottom <= bandTop || r.top >= M.bottom) return;
                if (r.width > M.width * 0.4) return;
                left = Math.max(left, r.right - M.left + 8);
            });
        });
        var k = S.size || 1;
        var full = (right + left) > M.width * 0.42 || (M.width - right - left) < 560 * Math.min(k, 1.3);
        if (full) {
            right = 6; left = 6;
            cands.forEach(function (n) { n.classList.add('ytl-lifted'); S.lifted.push(n); });
        }
        bar.style.left = Math.round(left) + 'px';
        bar.style.right = Math.round(right) + 'px';
        var bw = M.width - right - left;
        bar.classList.toggle('full', full);
        // [v20.10] масштаб: пороги «компактно/средне» растут вместе с размером; в невысоком или узком окне
        // (телефон) масштаб уменьшается ступенями, пока шкала не займёт ≤ 45 % высоты карты и ширина окна
        // не станет ≥ 700px × масштаб (выбор пользователя при этом не меняется)
        var eff = S.size || 1, guard = 0;
        for (;;) {
            bar.style.setProperty('--ys', String(eff));
            bar.classList.toggle('compact', bw < 900 * eff);
            bar.classList.toggle('mid', bw >= 900 * eff && bw < 1420 * eff);
            bar.classList.toggle('tight', bw >= 900 * eff && bw < 1160 * eff);
            var j = SIZES.indexOf(eff);
            if (j <= 0 || ++guard > SIZES.length) break;
            if (M.width >= 700 * eff && (S.collapsed || bar.offsetHeight <= M.height * 0.45)) break;   // телефон / узкое окно — мельче
            eff = SIZES[j - 1];
        }
        if (eff !== S.eff) { S.eff = eff; sizeUi(); }
        updateVars();
    }
    function updateVars() {
        if (!S) return;
        var bar = S.bar, host = S.host;
        var r = bar.getBoundingClientRect();
        var mb = host === document.body ? innerHeight : host.getBoundingClientRect().bottom;
        var root = document.documentElement.style;
        root.setProperty('--ytl-h', Math.max(0, Math.round(mb - r.top)) + 'px');
        root.setProperty('--ytl-vh', Math.max(0, Math.round(innerHeight - r.top)) + 'px');
        root.setProperty('--ytl-lift', Math.max(0, Math.round(mb - r.top + 4)) + 'px');
    }

    // ── действия ─────────────────────────────────────────────────────────────
    function setOn(it, on) {
        if (!it) return;
        if (it.mb) { if (isOn(it) !== on && window.toggleMbtilesLayer) try { window.toggleMbtilesLayer(it.mb, on); } catch (e) { console.warn('[ytl] mbtiles', it.mb, e); } return; }
        if (typeof window.toggleExternalLayer !== 'function') return;
        var st = layerState();
        it.keys.forEach(function (k) {
            if (!!st[k] === on) return;
            // [v20.10] передаём настоящее имя слоя GeoServer (раньше null → тайлы без LAYERS, снимок не грузился)
            var df = defOf(k) || (typeof window._getExtDef === 'function' ? window._getExtDef(k) : null);
            var ln = (df && df.sublabel) || (it.keys.length === 1 && (it.ld.sublabel || it.ld.layerName || it.ld.layer)) || null;
            try { window.toggleExternalLayer(k, ln, on); } catch (e) { console.warn('[ytl] слой', k, e); }
        });
    }
    function hideOthers(keep) {
        var ids = {}, st = layerState();
        keep.forEach(function (it) { ids[it.id] = 1; });
        S.data.items.forEach(function (it) {
            if (ids[it.id] || (S.type !== 'all' && it.type !== S.type)) return;
            if (isOn(it)) setOn(it, false);
        });
        S.data.tops.forEach(function (t) { if (S.type === 'all' || t.type === S.type) setOn(t, false); });
    }
    function show(list, zoom) {
        if (!list.length) return;
        if (S.exclusive) hideOthers(list);
        list.forEach(function (it) { setOn(it, true); });
        if (zoom) zoomTo(list);
        syncShown(true);
    }
    function zoomTo(list) {
        if (!list.length) return;
        if (list.length === 1 && list[0].mb && window.zoomToMbtilesLayer) { try { window.zoomToMbtilesLayer(list[0].mb); return; } catch (_) {} }
        if (list.length === 1 && list[0].type === 'base') {
            var code = lhCode(list[0]);
            if (code && hasForestry(code) && typeof window.focusOnLeskhozTimeline === 'function') {
                try { window.focusOnLeskhozTimeline(code); return; } catch (_) {}
            }
        }
        if (window.DzzExtent && window.DzzExtent.zoomToItems) {
            window.DzzExtent.zoomToItems(list.map(function (x) { return x.ld; }), {
                toast: false, maxZoom: 14, from: 'timeline',
                label: list.length === 1 ? list[0].title + (list[0].month ? ' (' + dateText(list[0]) + ')' : '') : list.length + ' сн.'
            });
            return;
        }
        // запасной путь (нет dzz-extent.js): bbox из конфигурации
        var u = null;
        list.forEach(function (it) {
            var b = it.ld.bbox;
            if (!b || b.length !== 4) return;
            u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : b.slice();
        });
        if (u && window.map && window.ol) {
            var v = window.map.getView();
            v.fit(ol.proj.transformExtent(u, 'EPSG:4326', v.getProjection()), { padding: [48, 80, (S.bar.offsetHeight || 150) + 30, 48], maxZoom: 14, duration: 700 });
        }
    }
    function select(it, opt) {
        if (!it) return;
        opt = opt || {};
        S.sel = it.id;
        S.year = it.year;
        if (S.month !== ALL_YEAR) S.month = it.month;
        if (S.type !== 'all' && it.type !== S.type) S.type = 'all';
        save();
        renderScale(); renderRibbon();
        show([it], opt.zoom !== false);
        scrollToSel(true);
    }
    function step(d) {
        var f = F();
        if (!f.length) return;
        var cur = S.sel && byId(S.sel), i = cur ? f.indexOf(cur) : -1;
        var nx;
        if (i < 0) { var v = viewItems(); nx = v.length ? (d > 0 ? v[0] : v[v.length - 1]) : f[d > 0 ? 0 : f.length - 1]; }
        else {
            var j = i + d;
            if (j < 0 || j >= f.length) { toast(d > 0 ? 'Это последний снимок' : 'Это первый снимок'); return; }
            nx = f[j];
        }
        select(nx);
    }
    function scrollToSel(smooth) {
        if (!S) return;
        var rb = S.bar.querySelector('[data-role="ribbon"]');
        var c = rb && S.sel && rb.querySelector('.ytl-card[data-id="' + cssEsc(S.sel) + '"]');
        if (!c) return;
        var L = rb.scrollLeft, x = c.offsetLeft - rb.offsetLeft, w = c.offsetWidth, W = rb.clientWidth;
        if (x < L + 8 || x + w > L + W - 8) {
            var to = Math.max(0, x - (W - w) / 2);
            if (smooth && rb.scrollTo) rb.scrollTo({ left: to, behavior: 'smooth' }); else rb.scrollLeft = to;
        }
    }
    function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

    function onClick(e) {
        if (!S) return;
        var t = e.target, a = t.closest('[data-act]'), act = a && a.getAttribute('data-act');
        var card = t.closest('.ytl-card');
        if (card && act !== 'eye' && act !== 'zoom') act = null;
        if (act === 'excl') return;                 // обрабатывается в change
        if (act && a.disabled) return;
        switch (act) {
            case 'prev': step(-1); return;
            case 'next': step(1); return;
            case 'close':
                if (typeof S.onClose === 'function') { var f = S.onClose; try { f(); } catch (_) {} if (S) destroy(false); }
                else destroy(false);
                return;
            case 'szdn': case 'szup': case 'szdef': {
                var si = SIZES.indexOf(S.size); if (si < 0) si = SIZES.indexOf(SIZE_DEF);
                setSize(act === 'szdef' ? SIZE_DEF : SIZES[Math.max(0, Math.min(SIZES.length - 1, si + (act === 'szup' ? 1 : -1)))]);
                return;
            }
            case 'collapse':
                S.collapsed = !S.collapsed; S.bar.classList.toggle('collapsed', S.collapsed); save();
                a.innerHTML = '<i class="fa-solid ' + (S.collapsed ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i>';
                a.title = S.collapsed ? 'Развернуть шкалу' : 'Свернуть шкалу';
                updateVars(); layoutSoon();
                return;
            case 'hideall': {
                var st = layerState(), n = 0;
                S.data.items.forEach(function (it) { if ((S.type === 'all' || it.type === S.type) && isOn(it)) { setOn(it, false); n++; } });
                S.data.tops.forEach(function (tp) { if ((S.type === 'all' || tp.type === S.type) && isOn(tp)) { setOn(tp, false); n++; } });
                syncShown(true);
                if (n) toast('Скрыто снимков: ' + n);
                return;
            }
            case 'yprev': case 'ynext': {
                var f2 = F(), ys = yearsAll().filter(function (y) { return inYear(f2, y).length; }), i = ys.indexOf(S.year);
                var ny = ys[i + (act === 'ynext' ? 1 : -1)];
                if (ny != null) setYear(ny);
                return;
            }
            case 'rleft': case 'rright': {
                var rb = S.bar.querySelector('[data-role="ribbon"]');
                rb.scrollBy({ left: (act === 'rright' ? 1 : -1) * Math.max(200, rb.clientWidth * 0.8), behavior: 'smooth' });
                return;
            }
            case 'eye': {
                var it = byId(card.getAttribute('data-id'));
                if (!it) return;
                var on = !isOn(it);
                setOn(it, on);
                if (on) { S.sel = it.id; save(); S.bar.querySelectorAll('.ytl-card.sel').forEach(function (c) { c.classList.remove('sel'); }); card.classList.add('sel'); statusUpd(); }
                syncShown(true);
                return;
            }
            case 'zoom': {
                var iz = byId(card.getAttribute('data-id'));
                if (iz) zoomTo([iz]);
                return;
            }
        }
        var chip = t.closest('.ytl-chip');
        if (chip && !chip.disabled) { S.type = chip.getAttribute('data-type'); normalize(); save(); render(); layoutSoon(); scrollToSel(false); return; }
        var yb = t.closest('.ytl-year');
        if (yb && !yb.disabled) { setYear(+yb.getAttribute('data-year')); return; }
        var mb = t.closest('.ytl-m');
        if (mb && !mb.disabled) { S.month = +mb.getAttribute('data-month'); save(); renderScale(); renderRibbon(); syncShown(true); scrollToSel(false); return; }
        var db = t.closest('.ytl-day');
        if (db) {
            var k = db.getAttribute('data-day');
            var grp = viewItems().filter(function (x) { return (x.month ? x.month + '-' + x.day : 'u') === k; });
            if (grp.length) {
                S.sel = grp[0].id; save();
                S.bar.querySelectorAll('.ytl-card').forEach(function (c) { c.classList.toggle('sel', c.getAttribute('data-id') === S.sel); });
                statusUpd();
                show(grp, true);
            }
            return;
        }
        if (card) { select(byId(card.getAttribute('data-id'))); }
    }
    function setYear(y) {
        S.year = y;
        var yl = inYear(F(), y);
        if (S.month !== ALL_YEAR) {
            var sel = yl.filter(function (it) { return it.id === S.sel; })[0];
            S.month = sel ? sel.month : (yl.length ? yl[yl.length - 1].month : S.month);
        }
        normalize(); save(); renderScale(); renderRibbon(); syncShown(true); scrollToSel(false);
    }
    function onChange(e) {
        if (!S) return;
        var t = e.target;
        if (t && t.getAttribute('data-act') === 'excl') {
            S.exclusive = !!t.checked; save();
            toast(S.exclusive ? 'Показывается только выбранный снимок' : 'Выбранные снимки добавляются на карту к уже показанным');
        }
    }
    function onWheel(e) {
        var rb = e.target.closest && e.target.closest('.ytl-ribbon, .ytl-ylist');
        e.stopPropagation();
        if (!rb) { e.preventDefault(); return; }       // колесо над шкалой не масштабирует карту
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { rb.scrollLeft += e.deltaY; e.preventDefault(); }
    }
    function onKey(e) {
        if (!S || S.collapsed || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        var a = document.activeElement, tag = a && a.tagName;
        if (a && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable)) return;
        if (!(S.bar.matches(':hover') || S.bar.contains(a))) return;
        e.preventDefault(); e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        step(e.key === 'ArrowRight' ? 1 : -1);
    }

    // ── публичное API ──────────────────────────────────────────────────────────
    window.buildYearTimelinePanel = function (container, onClose) {
        try { return build(container, onClose); }
        catch (e) { console.error('[Съёмка по годам]', e); toast('Не удалось открыть «Съёмку по годам»: ' + esc(e.message || e), true); }
    };
    window.YearTimeline = {
        version: VER,
        isOpen: function () { return !!S; },
        items: function () { return S ? S.data.items.slice() : collect().items; },
        state: function () { return S ? { type: S.type, year: S.year, month: S.month, sel: S.sel, exclusive: S.exclusive, collapsed: S.collapsed, size: S.size, eff: S.eff } : null; },
        size: function (v) { if (!S) return null; if (v != null) setSize(v); return S.size; },
        select: function (id, opt) { if (S) select(byId(id), opt); },
        step: function (d) { if (S) step(d || 1); },
        refresh: function () { if (S) { S.data = collect(); normalize(); render(); layout(); } },
        layout: function () { layout(); },
        close: function () { if (S) { var f = S.onClose; if (typeof f === 'function') f(); if (S) destroy(false); } }
    };
})();
