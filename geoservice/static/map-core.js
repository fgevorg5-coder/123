// [FIX search] Полифилы AbortSignal.any / AbortSignal.timeout — их нет в Chrome < 116 / < 103
// (Windows 7 / старые Chromium-браузеры). Без них поиск падал на первом fetch и показывал
// только лесхозы (локальный список) — ни слоёв GeoServer, ни населённых пунктов.
(function () {
    if (typeof AbortController === 'undefined' || typeof AbortSignal === 'undefined') return;
    if (typeof AbortSignal.timeout !== 'function') {
        AbortSignal.timeout = function (ms) {
            const c = new AbortController();
            setTimeout(() => { try { c.abort(new DOMException('Timeout', 'TimeoutError')); } catch (_) { c.abort(); } }, ms);
            return c.signal;
        };
    }
    if (typeof AbortSignal.any !== 'function') {
        AbortSignal.any = function (signals) {
            const c = new AbortController();
            const onAbort = (s) => { if (!c.signal.aborted) { try { c.abort(s.reason); } catch (_) { c.abort(); } } };
            for (const s of signals || []) {
                if (!s) continue;
                if (s.aborted) { onAbort(s); break; }
                s.addEventListener('abort', () => onAbort(s), { once: true });
            }
            return c.signal;
        };
    }
})();
// ==========================================
// 0. ПОДПИСИ ПОЛЕЙ ПОПАПА "ВЫДЕЛЫ РБ" / "ВЫДЕЛЫ РБ (МИН)"
// ==========================================
// Сырые атрибуты приходят от GeoServer на английском — переводим для попапа, по слоям.
// ВНИМАНИЕ: у gs_allotment/gs_allotment_min поля 'Forest number' и 'Quarter id'
// обрабатываются отдельным кодом (см. рендер попапа) — первое расшифровывается
// в название лесхоза через MANUAL_FORESTRY_FIX, второе скрывается.
window._POPUP_FIELD_MAP = {
    gs_allotment: {
        'Forestry unit number': 'Номер лесничества',
        'Quarter number': 'Номер квартала',
        'Allotment number': 'Номер выдела',
        'Area': 'Площадь'
    },
    gs_allotment_min: {
        'Forestry unit number': 'Номер лесничества',
        'Quarter number': 'Номер квартала',
        'Allotment number': 'Номер выдела',
        'Area': 'Площадь'
    },
    gs_lesnich: {
        'Name ln': 'Название лесничества'
    },
    gs_leshoz: {
        'Name lx': 'Название лесхоза'
    }
};

// ==========================================
// 1. ЗАГРУЗКА OPENLAYERS
// ==========================================
// [PERF] ol.js теперь грузится явным <script defer> в index.html (с preload в <head>).
// Динамическая загрузка убрана — она создавала цепочку зависимостей map-core.js → ol.js.
// defer гарантирует что все скрипты выполняются после HTML-парсинга в порядке объявления,
// поэтому к моменту запуска map-core.js ol.js уже загружен и window.ol доступен.
(function loadOpenLayers() {
    if (typeof ol !== 'undefined') {
        // ol уже доступен (загружен defer-скриптом)
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }
        return;
    }
    // Фолбэк: если по какой-то причине ol ещё не загружен — ждём события load
    window.addEventListener('load', function() {
        if (typeof ol !== 'undefined') initApp();
        else console.error('OpenLayers не загружен');
    });
})();

// ==========================================
// 2. ГЛАВНАЯ ИНИЦИАЛИЗАЦИЯ
// ==========================================
function initApp() {
    if (!document.getElementById('map')) return;

    // ── Инжектируем стили ──────────────────
    injectStyles();

    // ── Глобальное состояние ───────────────
    const AppState = {
        mode: null,
        isAdmin: window.IS_ADMIN || false,
        isRegistered: window.HAS_PROFILE || false,
        forestry: { counts: {}, files: {}, bounds: {}, geoData: null, selectedCode: null },
        images: { boundsCache: {} },
        selection: { ids: new Set(), lastId: null },
        vectors: { activeLayers: {} },
        mbtiles: { items: {}, folderOpen: true }, // [MBTiles] загруженные через панель слоёв .mbtiles-файлы (папка MBTILES MINSK)
        activeBasemap: 'voyager',
        layerState: {
            raster: false,
            forestry: false,
            mask: true,
            vectors: true
        },
        externalLayerState: {},
        externalLayerOpacity: {},
        dzzTabOpacity: {},
        dzzCogOpacity: {},
        dzzShpOpacity: {},
        dzzYearOrder: [2026, 2025, 2024]
    };
    window.ExternalLayerState = AppState.externalLayerState;
    window.AppState = AppState; // экспорт для lazy-loaded панелей

    // ── Конфигурация ───────────────────────
    const CONFIG = {
        yearColors: {
            2018: '#607d8b', 2019: '#795548', 2020: '#00bcd4', 2021: '#cddc39',
            2022: '#673ab7', 2023: '#4caf50', 2024: '#2196f3', 2025: '#ff9800', 2026: '#f44336'
        },
        endpoints: {
            deleteImage: (id) => `/delete_image/${id}`,
            images: '/api/images',
            vectors: '/api/vectors',
            zones: '/api/zones-boundaries',
            forestry: '/api/forestry-boundaries',
            basemaps: '/api/basemaps',
            imageInfo: (lat, lng) => `/api/get_image_info?lat=${lat}&lng=${lng}`,
            mbtilesList:   '/api/mbtiles/list',
            mbtilesUpload: '/api/mbtiles/upload',
            mbtilesDelete: (id) => `/api/mbtiles/${id}`
        },
        GEOSERVER_WMS: '/geoserver_wms_proxy',  // через nginx → кэш (было: http://192.168.12.109:9090/geoserver/wms)
        BELGOSLES_WMS: '/belgosles_wms_proxy',
        COVERSTYLE_WMS: 'https://bank.belgosles.by/geoserver/CoverStyleManage/wms'
    };
    // Экспортируем CONFIG глобально — тест CFG.7 проверяет window.CONFIG.GEOSERVER_WMS
    window.CONFIG = CONFIG;

    // ── Хелперы ───────────────────────────
    window.formatDateRU = function(dateStr) {
        if (!dateStr) return '—';
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return dateStr.split('-').reverse().join('.');
        return dateStr;
    };
    window.safeEscape = function(s) {
        // [A] SECURITY: полноценное HTML-экранирование для данных из GeoServer/сервера
        if (s === null || s === undefined) return '';
        return s.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    };
    window._escHtml = window.safeEscape;
    window.getYearColor = function(dateString) {
        const m = (dateString || '').match(/20\d{2}/);
        const y = m ? parseInt(m[0]) : 0;
        return CONFIG.yearColors[y] || '#9e9e9e';
    };
    window.autoFormatKey = function(key) {
        if (!key) return '';
        return key.replace(/_/g, ' ').charAt(0).toUpperCase() + key.replace(/_/g, ' ').slice(1);
    };

    // Восстанавливаем масштаб шрифта
    window.UI_FONT_SCALE = localStorage.getItem('ui_font_scale') ? parseFloat(localStorage.getItem('ui_font_scale')) : 1;
    document.documentElement.style.setProperty('--fs-mult', window.UI_FONT_SCALE);

    // ==========================================
    // 3. КОНФИГ ПОДЛОЖЕК (OpenLayers XYZ/WMTS)
    // ==========================================

    // Вспомогательная функция: создать ol.layer.Tile по URL-шаблону
    function _makeTileLayer(urls, options) {
        return new ol.layer.Tile({
            source: new ol.source.XYZ({
                urls: Array.isArray(urls) ? urls : [urls],
                crossOrigin: 'anonymous',
                maxZoom: options.maxZoom || 20,
                attributions: options.attribution || '© OpenStreetMap'
            }),
            zIndex: 0
        });
    }

    const BASEMAP_DEFS = {
        voyager: { name: 'Схема',
            // [FIX] CARTO voyager теперь требует API key (иначе watermark "API KEY REQUIRED").
            // Заменено на Esri World Light Gray Canvas — бесплатно, без ключа, тот же паттерн {z}/{y}/{x}, что и у satellite/esri-topo ниже.
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 16, attribution: '© Esri' },
        dark: { name: 'Тёмная',
            // [FIX] CARTO dark_all — та же причина, заменено на Esri World Dark Gray Canvas.
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 16, attribution: '© Esri' },
        satellite: { name: 'Спутник',
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 19, attribution: 'Esri' },
        'google-satellite': { name: 'Google Спутник', urls: [
            'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
        ], maxZoom: 22, attribution: '© Google' },
        'google-map': { name: 'Google Схема', urls: [
            'https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
            'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'
        ], maxZoom: 22, attribution: '© Google' },
        'yandex-map': { name: 'Яндекс Схема',
            // Заменено с Яндекс (смещение проекции) на 2GIS — стандартный EPSG:3857, русские названия, хорошее покрытие Беларуси
            urls: [
                'https://tile0.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1',
                'https://tile1.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1',
                'https://tile2.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1',
                'https://tile3.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1'
            ],
            maxZoom: 19, attribution: '© 2GIS' },
        'yandex-roads': { name: 'Яндекс Дороги',
            // 2GIS Transport — дорожный слой поверх схемы, хорошее покрытие Беларуси
            urls: [
                'https://tile0.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1&type=transport',
                'https://tile1.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1&type=transport',
                'https://tile2.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1&type=transport',
                'https://tile3.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1&type=transport'
            ],
            maxZoom: 19, attribution: '© 2GIS / Яндекс Дороги' },
        'arcgis-clarity': { name: 'ArcGIS Clarity',
            // Esri World Imagery Clarity — более чёткий спутниковый слой, лучше детализация по СНГ
            urls: ['https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 21, attribution: '© Esri / ArcGIS Clarity' },

        sentinel: { name: 'Sentinel-2',
            urls: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg'],
            maxZoom: 15, attribution: '© EOX / Sentinel-2' },
        'esri-topo': { name: 'Esri Топо',
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 19, attribution: '© Esri' },
        'esri-relief': { name: 'Esri Рельеф',
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 13, attribution: '© Esri' },
        'esri-natgeo': { name: 'Esri NatGeo',
            urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'],
            maxZoom: 16, attribution: '© Esri / National Geographic' },
        'dzz-arcgis': { name: 'ДЗЗ',
            // urls не используется для isWms:true (источник строится через TileWMS в createBasemapLayer)
            // Оставлено для совместимости, но запросы идут через /geoserver_wms_proxy → nginx → кэш
            urls: [
                '/geoserver_wms_proxy?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&_target=GEOSERVER' +
                '&LAYERS=External%3A%D0%9F%D0%BE%D0%B4%D0%BB%D0%BE%D0%B6%D0%BA%D0%B0%20%D0%94%D0%97%D0%97' +
                '&FORMAT=image%2Fjpeg&TRANSPARENT=false&STYLES=&SRS=EPSG%3A3857' +
                '&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'
            ],
            isWms: true, minZoom: 2, maxZoom: 22, attribution: '© ДЗЗ РБ / GeoServer',
            // [FIX] Покрытие слоя — только территория РБ (EPSG:3857, с небольшим запасом).
            // Раньше extent не задавался: OpenLayers на z6–z8 запрашивал тайлы на весь мир,
            // десятки бесполезных запросов забивали 6 HTTP-соединений браузера и семафор
            // GeoServer, из-за чего реальные тайлы РБ не успевали загрузиться (504) и
            // OpenLayers помечал их как ERROR — навсегда, без повторов. Отсюда «грузится
            // только часть охвата».
            extent: [2530000, 6630000, 3685000, 7625000] },

    };

    // ==========================================
    // 3.1 УДАЛЁННЫЕ ПОДЛОЖКИ (чистка каталога)
    // ==========================================
    // Подложки OpenStreetMap, Carto Voyager и Carto Светлая удалены:
    //   • OpenStreetMap  — tile.openstreetmap.org отдаёт «Access blocked / Legal Reason»
    //                      для этого приложения (см. скриншот подложек);
    //   • Carto Voyager  — basemaps.cartocdn.com требует API-ключ, тайлы приходят
    //                      с водяным знаком «API KEY REQUIRED»;
    //   • Carto Светлая  — та же причина, что и у Carto Voyager.
    // Список ниже применяется ЖЁСТКО: даже если в закэшированном браузером старом
    // билде эти ключи ещё присутствуют, они будут вычищены из каталога на старте,
    // а активная подложка при необходимости сброшена на «Схему».
    // ВНИМАНИЕ: ключ 'voyager' — это НАШ внутренний ключ подложки «Схема»
    // (сейчас Esri World Light Gray Canvas), его удалять НЕЛЬЗЯ.
    const REMOVED_BASEMAP_KEYS = [
        'osm', 'openstreetmap', 'osm-standard', 'osm-hot', 'osm-de',
        'carto-voyager', 'cartodb-voyager', 'carto_voyager',
        'carto-light', 'carto-positron', 'cartodb-light', 'carto_light', 'positron'
    ];
    const _REMOVED_BASEMAP_NAMES = ['openstreetmap', 'carto voyager', 'carto светлая', 'carto светлая '];
    const _REMOVED_BASEMAP_HOSTS = ['tile.openstreetmap.org', 'tile.osm.org', 'cartocdn.com', 'cartodb.com'];

    (function _purgeRemovedBasemaps() {
        REMOVED_BASEMAP_KEYS.forEach(function(k) { delete BASEMAP_DEFS[k]; });
        Object.keys(BASEMAP_DEFS).forEach(function(k) {
            const d = BASEMAP_DEFS[k] || {};
            const nameMatch = _REMOVED_BASEMAP_NAMES.indexOf(String(d.name || '').trim().toLowerCase()) !== -1;
            const urlMatch  = (d.urls || []).some(function(u) {
                return _REMOVED_BASEMAP_HOSTS.some(function(h) { return String(u).indexOf(h) !== -1; });
            });
            if (nameMatch || urlMatch) delete BASEMAP_DEFS[k];
        });
    })();

    window.REMOVED_BASEMAP_KEYS = REMOVED_BASEMAP_KEYS;
    window.BASEMAP_DEFS = BASEMAP_DEFS;

    // Восстанавливаем сохранённую позицию
    let savedCenter = ol.proj.fromLonLat([27.56, 53.9]);
    let savedZoom = 7;
    try {
        const pos = JSON.parse(localStorage.getItem('map_position') || '{}');
        if (pos.lat && pos.lng && pos.zoom) {
            savedCenter = ol.proj.fromLonLat([pos.lng, pos.lat]);
            savedZoom = pos.zoom;
        }
    } catch(e) {}

    // Сохранённая подложка
    let savedBasemap = localStorage.getItem('map_active_basemap') || 'voyager';
    if (!BASEMAP_DEFS[savedBasemap]) {
        savedBasemap = 'voyager';
        localStorage.setItem('map_active_basemap', 'voyager');
    }
    AppState.activeBasemap = savedBasemap;

    // ==========================================
    // 4.5 ОЧЕРЕДЬ ЗАГРУЗКИ ТАЙЛОВ ДЗЗ (throttle + повторы)
    // ==========================================
    // ПРОБЛЕМА, КОТОРУЮ ЭТО ЛЕЧИТ ("ДЗЗ грузится только частью охвата"):
    //   1. На обзорном зуме (z6–z8) вьюпорт требует 30–60 WMS-тайлов сразу.
    //   2. Каждый такой тайл GeoServer реально рендерит; backend
    //      (/geoserver_wms_proxy) пропускает их через семафор и при нехватке
    //      времени отдаёт 504/503 с пустым PNG.
    //   3. OpenLayers на любой ошибке загрузки помечает тайл TileState.ERROR
    //      и БОЛЬШЕ НИКОГДА его не перезапрашивает — дырка остаётся навсегда,
    //      пока пользователь не сменит зум. Именно поэтому подложка выглядела
    //      как «кусок мозаики посередине и белое поле вокруг».
    // РЕШЕНИЕ: свой tileLoadFunction с (а) ограничением параллелизма и
    //   (б) автоматическими повторами с экспоненциальной задержкой.
    //   Слот очереди освобождается НА ВРЕМЯ паузы перед повтором, поэтому
    //   «медленные» тайлы не блокируют остальные.
    const _DZZ_MAX_PARALLEL = 6;   // = лимит HTTP/1.1-соединений браузера на хост
    const _DZZ_MAX_RETRIES  = 4;   // 1 обычная попытка + 4 повтора
    let   _dzzActive = 0;
    const _dzzQueue  = [];
    const _TILE_STATE_ERROR   = (window.ol && ol.TileState && ol.TileState.ERROR   !== undefined) ? ol.TileState.ERROR   : 3;
    const _TILE_STATE_LOADING = (window.ol && ol.TileState && ol.TileState.LOADING !== undefined) ? ol.TileState.LOADING : 1;

    // [ZOOM-FIX v9] Приоритет тайла в очереди. Раньше очереди были FIFO: после
    // зума/отдаления сначала догружались тайлы ПРОШЛОГО масштаба (и preload-тайлы
    // соседних уровней), а нужные для текущего кадра ждали — отсюда задержка
    // «картинка появляется не сразу». Теперь берётся тайл, чей масштаб ближе к
    // текущему и который пересекает видимую область.
    // Масштаб тайла считается по BBOX/WIDTH из URL — не зависит от сетки слоя.
    function _tilePriority(src) {
        try {
            const v = window.map && window.map.getView && window.map.getView();
            if (!v) return 0;
            const res = v.getResolution();
            const mb = /[?&]BBOX=([^&]+)/i.exec(src);
            if (!mb || !res) return 0;
            const b = decodeURIComponent(mb[1]).split(',').map(Number);
            if (b.length !== 4 || b.some(isNaN)) return 0;
            const mw = /[?&]WIDTH=(\d+)/i.exec(src);
            const w = mw ? Number(mw[1]) : 256;
            // BBOX в градусах (EPSG:4326/BY-LV) — пропускаем оценку
            if (Math.abs(b[2] - b[0]) < 400) return 0;
            const tileRes = (b[2] - b[0]) / (w || 256);
            const levelDiff = Math.abs(Math.log2(tileRes / res));
            const ext = v.calculateExtent(window.map.getSize());
            const inView = !(b[0] > ext[2] || b[2] < ext[0] || b[1] > ext[3] || b[3] < ext[1]);
            return Math.round(levelDiff * 10) + (inView ? 0 : 25);
        } catch (e) { return 0; }
    }
    window._tilePriority = _tilePriority;

    function _pickBest(queue, ok) {
        let best = -1, bestScore = Infinity;
        for (let i = 0; i < queue.length; i++) {
            if (ok && !ok(queue[i])) continue;
            const sc = _tilePriority(queue[i].src || '');
            if (sc < bestScore) { bestScore = sc; best = i; if (sc === 0) break; }
        }
        return best;
    }
    window._pickBestTile = _pickBest;

    function _dzzPump() {
        while (_dzzActive < _DZZ_MAX_PARALLEL && _dzzQueue.length) {
            const _bi = _pickBest(_dzzQueue);
            const job = _dzzQueue.splice(_bi < 0 ? 0 : _bi, 1)[0];
            _dzzActive++;
            job.run();
        }
    }

    // Счётчик незакрытых дыр — используется для отложенной «дозагрузки» (см. ниже)
    window._dzzErrorCount = 0;

    function _dzzTileLoader(tile, src) {
        const img = tile.getImage();
        let attempt = 0;

        const job = {
            src: src,
            run: function() {
                // Тайл мог уйти из вьюпорта (зум/пан) — OpenLayers сменил ему
                // состояние. Дожимать его повторами бессмысленно: только зря
                // держим слот очереди, нужный видимым тайлам.
                if (tile.getState && tile.getState() !== _TILE_STATE_LOADING) {
                    _dzzActive--;
                    _dzzPump();
                    return;
                }
                // Повторные попытки получают &_r=N, чтобы обойти локальный кэш
                // браузера с закэшированным битым ответом.
                const url = attempt === 0 ? src : src + '&_r=' + attempt;
                fetch(url, {
                    credentials: 'same-origin',
                    cache: attempt === 0 ? 'default' : 'reload'
                })
                .then(function(r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const ct = (r.headers.get('Content-Type') || '').toLowerCase();
                    // GeoServer при ошибке отдаёт XML ServiceException вместо картинки
                    if (ct.indexOf('xml') !== -1 || ct.indexOf('html') !== -1) {
                        throw new Error('WMS exception');
                    }
                    return r.blob().then(function(b) { return { blob: b, ct: ct }; });
                })
                .then(function(res) {
                    // Backend на таймаут/429 отдаёт заглушку — прозрачный PNG 69 байт,
                    // хотя мы просили JPEG. Считаем это неудачей и повторяем.
                    if (res.ct.indexOf('png') !== -1 && res.blob.size < 200) {
                        throw new Error('empty placeholder tile');
                    }
                    if (res.blob.size === 0) throw new Error('zero-length tile');

                    const objUrl = URL.createObjectURL(res.blob);
                    // addEventListener, а не img.onload = ... — свои обработчики
                    // OpenLayers вешает именно так, перетирать их нельзя.
                    const _free = function() { URL.revokeObjectURL(objUrl); };
                    img.addEventListener('load',  _free, { once: true });
                    img.addEventListener('error', _free, { once: true });
                    // Object URL — same-origin, canvas не «пачкается»:
                    // печать и экспорт карты продолжают работать.
                    img.src = objUrl;
                    _dzzActive--;
                    _dzzPump();
                })
                .catch(function() {
                    _dzzActive--;          // слот освобождаем СРАЗУ, до паузы
                    attempt++;
                    if (attempt <= _DZZ_MAX_RETRIES) {
                        const delay = Math.min(8000, 450 * Math.pow(1.9, attempt))
                                    + Math.random() * 400;   // джиттер против «стада»
                        setTimeout(function() { _dzzQueue.push(job); _dzzPump(); }, delay);
                    } else {
                        window._dzzErrorCount++;
                        tile.setState(_TILE_STATE_ERROR);
                        _dzzPump();
                    }
                });
            }
        };

        _dzzQueue.push(job);
        _dzzPump();
    }

    // ==========================================
    // 4. СОЗДАНИЕ КАРТЫ (OpenLayers)
    // ==========================================

    // Базовый тайловый слой (подложка)
    let _basemapLayer = _makeBasemapLayer(savedBasemap);

    // [FIX] Если при старте активна подложка ДЗЗ — сразу вешаем обработчик «дыр»
    // (при переключении подложки это делает window.setBasemap).
    if ((BASEMAP_DEFS[savedBasemap] || {}).isWms) {
        _basemapLayer.getSource().on('tileloaderror', function() {
            if (typeof window._scheduleDzzHeal === 'function') window._scheduleDzzHeal();
        });
    }

    // View
    const view = new ol.View({
        center: savedCenter,
        zoom: savedZoom,
        minZoom: 6,
        maxZoom: 22,
        projection: 'EPSG:3857'
    });

    // Создаём карту — без стандартных контролов (добавим вручную)
    const map = new ol.Map({
        target: 'map',
        maxTilesLoading: 48,   // [ZOOM-FIX v9] было 16 (по умолчанию)
        layers: [_basemapLayer],
        view: view,
        controls: ol.control.defaults.defaults({
            zoom: false,
            rotate: false,
            attribution: false
        }),
        interactions: ol.interaction.defaults.defaults({
            mouseWheelZoom: false,  // заменяем на кастомный ниже
            pinchZoom: true,
            doubleClickZoom: true,
            dragPan: false,         // заменяем на кастомный ниже (быстрее)
            shiftDragZoom: false
        })
    });

    // Быстрое перемещение — кинетическая инерция увеличена
    map.addInteraction(new ol.interaction.DragPan({
        kinetic: new ol.Kinetic(-0.005, 0.1, 200)
    }));

    // ── Навигация стрелками клавиатуры ────────────────────────────────
    map.addInteraction(new ol.interaction.KeyboardPan({
        duration: 100,
        pixelDelta: 128
    }));
    map.addInteraction(new ol.interaction.KeyboardZoom({
        duration: 100
    }));

    // Карта должна иметь tabindex, чтобы получать фокус клавиатуры
    (function() {
        const _mapEl = document.getElementById('map');
        if (_mapEl && !_mapEl.hasAttribute('tabindex')) {
            _mapEl.setAttribute('tabindex', '0');
        }
        // Фокусируем карту при клике на неё
        if (_mapEl) {
            _mapEl.addEventListener('click', function() { _mapEl.focus(); });
            // Начальный фокус
            setTimeout(function() { _mapEl.focus(); }, 300);
        }
    })();

    // Плавный зум колесом — постепенное приближение
    map.addInteraction(new ol.interaction.MouseWheelZoom({
        duration: 250,   // [ZOOM-FIX v9] было 400 мс — анимация «тянулась»
        timeout: 40,     // [ZOOM-FIX v9] было 80 мс — ожидание перед стартом зума
        useAnchor: true,
        constrainResolution: false
    }));

    // ── Приближение выбранного участка (Shift + ЛКМ + тянуть) ──────────
    // Рисует прямоугольник выбора и приближается к нему без сдвига линейки
    const _shiftDragZoom = new ol.interaction.DragZoom({
        condition: ol.events.condition.shiftKeyOnly,
        duration: 250,
        out: false
    });
    map.addInteraction(_shiftDragZoom);

    // Экспортируем map глобально — тесты T2/T5 обращаются к window.map напрямую
    // (window.map.addLayer.bind, window.map.getLayers, window.map.getView и т.д.)
    window.map = map;
    // [v20] Поиск адресов: центр карты (сервер выбирает по нему город, если он не указан) и пометка исправления
    window._geoCenterQS = function () {
        try { const c = ol.proj.toLonLat(map.getView().getCenter()); return `&lat=${c[1].toFixed(4)}&lon=${c[0].toFixed(4)}`; } catch (e) { return ''; }
    };
    window._geoNote = function (place) {
        const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
        let n = '';
        if (place && place._corrected && place._corrected.to) n += `исправлено на «${esc(place._corrected.to)}» · `;
        if (place && place._approx) n += 'дом не найден — центр улицы · ';
        return n;
    };
    // [SEC v9] Геосервис отдаёт тайлы/данные только браузеру, открывшему портал
    // (подписанный cookie gp_pass). Продлеваем его, пока вкладка открыта.
    (function _geoPassKeepAlive() {
        let last = Date.now();
        const refresh = function() {
            last = Date.now();
            fetch('/api/geo/pass', { credentials: 'same-origin', cache: 'no-store' }).catch(function() {});
        };
        setInterval(refresh, 20 * 60 * 1000);
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60 * 1000) refresh();
        });
    })();
    window._getMapInstance = function() { return map; }; // read-only алиас

    // ── Canvas-clipping: обрезка тайлов прямо во время рендеринга (работает при анимации зума)
    // Перехват установлен сразу после создания map — до любых addLayer вызовов
    window._belarusClipRings = null;
    window._belarusMaskEnabled = true;

    // ── Canvas clip: применяем к слою prerender/postrender ──────────────
    // Используем ol.render.getVectorContext через transform из frameState,
    // что корректно работает во время анимации зума/пана.
    // ══════════════════════════════════════════════════════════════════════
    // ОПТИМИЗАЦИЯ CANVAS CLIP — Shared Path2D + зум-суспенд
    //
    // Проблема: при 100+ слоях каждый вызывает prerender → ctx.beginPath() +
    // тысячи ctx.lineTo() по точкам границы Беларуси → 100 × N_points
    // canvas-операций на каждый кадр → фриз при зуме/пане.
    //
    // Решение:
    //   1. Один общий _belarusPath2D (Path2D) строится ОДИН раз при загрузке границы.
    //   2. Все слои используют ctx.clip(_belarusPath2D) — O(1) вместо O(N_points).
    //   3. Но Path2D в координатах EPSG:3857 — нужно трансформировать через
    //      ctx.setTransform() во время prerender.
    //   4. При анимации зума/пана скрываем все COG/WMS слои через setVisible(false)
    //      — браузер не шлёт 900 запросов во время анимации (200-400мс), возвращаем
    //      слои по moveend. Старые тайлы остаются видимы через useInterimTiles.
    // ══════════════════════════════════════════════════════════════════════

    // Кэш Path2D в координатах canvas — пересчитывается только при смене transform
    let _belarusPath2D_cached    = null;  // Path2D в canvas-пикселях
    let _belarusPath2D_transform = null;  // строка из transform при которой он построен

    let _belarusLocal = null, _belarusLocalSrc = null;
    function _getBelarusLocalPath(rings) {
        if (!rings || !rings.length || typeof Path2D === 'undefined') return null;
        if (_belarusLocalSrc === rings && _belarusLocal) return _belarusLocal;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        rings.forEach(r => r.forEach(c => {
            if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
        }));
        const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
        const path = new Path2D();
        rings.forEach(function(ring) {
            if (!ring.length) return;
            path.moveTo(ring[0][0] - ox, ring[0][1] - oy);
            for (let i = 1; i < ring.length; i++) path.lineTo(ring[i][0] - ox, ring[i][1] - oy);
            path.closePath();
        });
        _belarusLocal = { path, ox, oy };
        _belarusLocalSrc = rings;
        return _belarusLocal;
    }

    function _buildBelarusPath2D(rings3857, t, pr) {
        // Строим строку-ключ из transform чтобы не пересчитывать каждый кадр
        const tKey = `${t[0].toFixed(8)},${t[1].toFixed(8)},${t[2].toFixed(8)},${t[3].toFixed(8)},${t[4].toFixed(2)},${t[5].toFixed(2)},${pr}`;
        if (_belarusPath2D_transform === tKey && _belarusPath2D_cached) {
            return _belarusPath2D_cached;
        }
        // Пересчёт: координаты 3857 → canvas pixels через аффинное преобразование
        const path = new Path2D();
        rings3857.forEach(function(ring) {
            if (!ring.length) return;
            const x0 = (t[0] * ring[0][0] + t[2] * ring[0][1] + t[4]) * pr;
            const y0 = (t[1] * ring[0][0] + t[3] * ring[0][1] + t[5]) * pr;
            path.moveTo(x0, y0);
            for (let i = 1; i < ring.length; i++) {
                path.lineTo(
                    (t[0] * ring[i][0] + t[2] * ring[i][1] + t[4]) * pr,
                    (t[1] * ring[i][0] + t[3] * ring[i][1] + t[5]) * pr
                );
            }
            path.closePath();
        });
        _belarusPath2D_cached    = path;
        _belarusPath2D_transform = tKey;
        return path;
    }

    // Map pixels and a tile renderer canvas differ after animated zoom/pan.
    function _clipCanvasTransform(evt) {
        const t = evt.frameState.coordinateToPixelTransform;
        const p = evt.frameState.pixelRatio;
        const r = evt.inversePixelTransform || [p, 0, 0, p, 0, 0];
        return [r[0]*t[0]+r[2]*t[1], r[1]*t[0]+r[3]*t[1],
            r[0]*t[2]+r[2]*t[3], r[1]*t[2]+r[3]*t[3],
            r[0]*t[4]+r[2]*t[5]+r[4], r[1]*t[4]+r[3]*t[5]+r[5]];
    }

    function _applyBelarusClipToLayer(layer) {
        let _clipped = false;
        layer.on('prerender', function(evt) {
            _clipped = false;
            const ctx = evt.context;
            ctx.save();
            _clipped = true;
            if (!window._belarusMaskEnabled || !window._belarusClipRings) return;
            const t = _clipCanvasTransform(evt);
            // [ZOOM-FIX v9] Раньше на КАЖДОМ кадре анимации зума Path2D границы
            // (тысячи точек) пересчитывался в пиксели заново. Теперь путь строится
            // один раз в метрах (относительно центра РБ), а кадр меняет только матрицу.
            const lp = _getBelarusLocalPath(window._belarusClipRings);
            if (lp && typeof ctx.getTransform === 'function') {
                const m0 = ctx.getTransform();
                ctx.setTransform(t[0], t[1], t[2], t[3],
                    t[0] * lp.ox + t[2] * lp.oy + t[4],
                    t[1] * lp.ox + t[3] * lp.oy + t[5]);
                ctx.clip(lp.path, 'evenodd');
                ctx.setTransform(m0);
            } else {
                ctx.clip(_buildBelarusPath2D(window._belarusClipRings, t, 1), 'evenodd');
            }
        });
        layer.on('postrender', function(evt) {
            if (_clipped) { evt.context.restore(); _clipped = false; }
        });
    }

    function _applyClipToAllExistingLayers() {
        map.getLayers().forEach(function(layer) {
            if (layer._clipApplied) return;
            if (layer._noClip) return;
            if (layer instanceof ol.layer.Tile || layer instanceof ol.layer.Image) {
                _applyBelarusClipToLayer(layer);
                layer._clipApplied = true;
            }
        });
    }

    // ── Зум-суспенд: скрываем WMS-источники во время анимации ────────────────
    // При зуме OL запрашивает новые тайлы для ВСЕХ видимых слоёв одновременно.
    // 100 слоёв × 9 тайлов = 900 HTTP запросов за 200мс → браузер зависает.
    // Решение: скрываем слои на время анимации, возвращаем по её окончании.
    // useInterimTiles:true на слоях гарантирует что старые тайлы остаются видны.
    let _zoomSuspendTimer  = null;
    let _zoomSuspendActive = false;

    function _getExternalWmsLayers() {
        const result = [];
        map.getLayers().forEach(function(layer) {
            // Только внешние WMS-слои снимков (ext-layer-*), не базовая подложка
            if (layer._extKey && layer instanceof ol.layer.Tile) {
                result.push(layer);
            }
        });
        return result;
    }

    function _suspendExternalLayers() {
        if (_zoomSuspendActive) return;
        _zoomSuspendActive = true;
        _getExternalWmsLayers().forEach(function(layer) {
            // Сохраняем состояние видимости
            layer._suspendedVisible = layer.getVisible();
            if (layer._suspendedVisible) layer.setVisible(false);
        });
    }

    function _resumeExternalLayers() {
        _zoomSuspendActive = false;
        _getExternalWmsLayers().forEach(function(layer) {
            if (layer._suspendedVisible) {
                layer.setVisible(true);
                layer._suspendedVisible = undefined;
            }
        });
    }

    // useInterimTiles:true на слоях гарантирует что старые тайлы остаются видны
    // пока грузятся новые — скрывать слои при зуме не нужно.
    // [FIX-ZOOM] Убираем _suspendExternalLayers при change:resolution — именно это
    // вызывало «пропадание» снимков при приближении/отдалении. Слои теперь остаются
    // видимыми всегда; OL сам показывает кэшированные тайлы соседнего зума.
    let _zoomSuspendDebounce = null;
    map.getView().on('change:resolution', function() {
        // Только сбрасываем очередь тайлов текущего зума если она слишком большая
        // (при резком прыжке через 3+ зума накапливаются сотни устаревших запросов)
        clearTimeout(_zoomSuspendDebounce);
        _zoomSuspendDebounce = setTimeout(function() {
            // Never discard queued OL tiles: they would remain LOADING forever.
            _throttledTileLoader.flush();
        }, 400);
    });

    // Resume — гарантия что слои видимы если ранее были скрыты через _resetLayerState
    map.on('moveend', function() {
        clearTimeout(_zoomSuspendTimer);
        clearTimeout(_zoomSuspendDebounce);
        _zoomSuspendTimer = setTimeout(function() {
            _resumeExternalLayers();
        }, 80);
    });

    // Перехватываем addLayer — автоматически клипим все будущие тайловые слои
    const _origAddLayer = map.addLayer.bind(map);
    map.addLayer = function(layer) {
        _origAddLayer(layer);
        if (!layer._clipApplied && !layer._noClip) {
            if (layer instanceof ol.layer.Tile || layer instanceof ol.layer.Image) {
                _applyBelarusClipToLayer(layer);
                layer._clipApplied = true;
            }
        }
    };

    // Применяем clip к начальному basemap-слою
    _applyBelarusClipToLayer(_basemapLayer);
    _basemapLayer._clipApplied = true;

    // ── Курсор: стрелка в покое, ладонь при перетаскивании ──────────────
    (function initGrabCursor() {
        const mapEl = map.getTargetElement();
        const LOCKED = ['crosshair', 'wait', 'progress'];
        const isLocked = () => LOCKED.includes(mapEl.style.cursor);

        window._setMapDefaultCursor = function() {
            if (isLocked()) return;
            mapEl.style.cursor = 'default';
        };

        mapEl.style.cursor = 'default';

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Shift' && !isLocked()) mapEl.style.cursor = 'crosshair';
        });
        document.addEventListener('keyup', function(e) {
            if (e.key === 'Shift' && mapEl.style.cursor === 'crosshair') mapEl.style.cursor = 'default';
        });

        // Ладонь только пока зажата ЛКМ (перетаскивание карты)
        mapEl.addEventListener('mousedown', function(e) {
            if (e.button === 0 && !isLocked()) mapEl.style.cursor = 'grabbing';
        }, true);
        document.addEventListener('mouseup', function() {
            if (mapEl.style.cursor === 'grabbing') mapEl.style.cursor = 'default';
        }, true);
    })();

    // ── Конец настройки курсора ────────────────────────────────────────

    // ── Сохранение позиции (дебаунс) ───────────────────────────────────
    let _posDebounce = null;
    map.on('moveend', () => {
        clearTimeout(_posDebounce);
        _posDebounce = setTimeout(() => {
            try {
                const center = ol.proj.toLonLat(view.getCenter());
                localStorage.setItem('map_position', JSON.stringify({
                    lat: center[1], lng: center[0], zoom: view.getZoom()
                }));
            } catch(e) {}
        }, 500);
    });

    // ── Кнопки навигации (Zoom + Home) — единый блок ──────────────────
    (function() {
        // Создаём единый контейнер для +/− и Домой
        const navGroup = document.createElement('div');
        navGroup.id = 'map-nav-group';
        navGroup.className = 'ol-unselectable ol-control';

        const zoomInBtn = document.createElement('button');
        zoomInBtn.type = 'button';
        zoomInBtn.title = 'Приблизить';
        zoomInBtn.className = 'map-nav-btn';
        zoomInBtn.setAttribute('data-nav', 'in');
        zoomInBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';

        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.type = 'button';
        zoomOutBtn.title = 'Отдалить';
        zoomOutBtn.className = 'map-nav-btn';
        zoomOutBtn.setAttribute('data-nav', 'out');
        zoomOutBtn.innerHTML = '<i class="fa-solid fa-minus"></i>';

        const homeBtn = document.createElement('button');
        homeBtn.type = 'button';
        homeBtn.title = 'Вся Беларусь';
        homeBtn.className = 'map-nav-btn map-nav-home';
        homeBtn.setAttribute('data-nav', 'home');
        homeBtn.innerHTML = '<i class="fa-solid fa-house"></i>';

        navGroup.appendChild(zoomInBtn);
        navGroup.appendChild(zoomOutBtn);
        navGroup.appendChild(homeBtn);

        zoomInBtn.addEventListener('click', (e) => {
            e.preventDefault();
            view.animate({ zoom: view.getZoom() + 1, duration: 250 });
        });
        zoomOutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            view.animate({ zoom: view.getZoom() - 1, duration: 250 });
        });
        homeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            // Подгоняем вид по реальному экстенту маски/границы Беларуси
            const _belarusBorderLayer = _layers && _layers['belarus-border-line'];
            if (_belarusBorderLayer && _belarusBorderLayer.getSource) {
                const _src = _belarusBorderLayer.getSource();
                if (_src && _src.getFeatures && _src.getFeatures().length > 0) {
                    const _ext = _src.getExtent();
                    if (_ext && isFinite(_ext[0])) {
                        view.fit(_ext, { duration: 800, padding: [40, 40, 40, 40] });
                        if (typeof window.clearSelection === 'function') window.clearSelection();
                        return;
                    }
                }
            }
            // Fallback: фиксированный bbox Беларуси (WGS84: 23.16, 51.26, 32.75, 56.17)
            const _byExt = ol.proj.transformExtent([23.16, 51.26, 32.75, 56.17], 'EPSG:4326', 'EPSG:3857');
            view.fit(_byExt, { duration: 800, padding: [40, 40, 40, 40] });
            if (typeof window.clearSelection === 'function') window.clearSelection();
        });

        class NavGroupControl extends ol.control.Control {
            constructor() { super({ element: navGroup }); }
        }
        map.addControl(new NavGroupControl());
    })();

    // ==========================================
    // ЗАПУСК ИНИЦИАЛИЗАЦИИ (аналог map.on('load') из MapLibre)
    // В OpenLayers нет события 'load' — карта готова сразу после new ol.Map().
    // setTimeout(0) даёт браузеру один тик на рендер DOM перед построением UI.
    // ==========================================
    setTimeout(function _olStartup() {
        // Шаг 1: Строим правую панель (иконбар + слайд-панель) — сразу
        buildUI();
        // Шаг 2: Данные — с задержкой чтобы не конкурировать с загрузкой маски
        setTimeout(function() { loadData(); }, 80);

        // Шаг 3: Маска Беларуси + граница РБ (внутри вызывает _addForestryAsync)
        //         Запускаем сразу — она не конкурирует с подложкой (fetch, не тайлы)
        _addMaskAsync_FIXED();

        // Шаг 4: Растровые снимки (UAV/спутник) добавляем ТОЛЬКО после того,
        //         как подложка загрузила хотя бы первый тайл текущего вида.
        //         Это устраняет артефакт «снимки поверх пустой белой карты».
        var _basemapSource = _basemapLayer.getSource();
        var _rasterAdded = false;

        function _addRasterWhenReady() {
            if (_rasterAdded) return;
            _rasterAdded = true;
            _basemapSource.un('tileloadend',   _addRasterWhenReady);
            _basemapSource.un('tileloaderror', _addRasterWhenReady);
            clearTimeout(_rasterFallbackTimer);
            _addRasterTilesLayer();
        }

        // Страховка: если тайлы не пришли за 2 сек — добавляем всё равно
        var _rasterFallbackTimer = setTimeout(_addRasterWhenReady, 2000);

        _basemapSource.on('tileloadend',   _addRasterWhenReady);
        _basemapSource.on('tileloaderror', _addRasterWhenReady);
    }, 0);

    // ── Масштабная линейка OL (скрытая — используем кастомную) ─────────
    // Стандартная OL ScaleLine не нужна — используем кастомный CSB

    // ==========================================
    // 5. ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: СОЗДАТЬ ПОДЛОЖКУ
    // ==========================================
    function _makeBasemapLayer(name) {
        const def = BASEMAP_DEFS[name] || BASEMAP_DEFS['voyager'];
        let source;
        if (def.isWms) {
            // WMS подложка (ДЗЗ) — через nginx-прокси /geoserver_wms_proxy (кэш!)
            // FIX: явный tileGrid — OL запрашивает тайлы нужного зума,
            // не растягивает соседние (нет битых пикселей при приближении)
            // FIX: extent = территория РБ → OL не просит тайлы за пределами покрытия
            // слоя (раньше на z6–z8 половина запросов уходила «в море» и впустую
            // занимала соединения браузера и слоты семафора GeoServer).
            const _dzzTileGrid = ol.tilegrid.createXYZ({
                tileSize: 256,
                maxZoom: 19,
                extent: def.extent || undefined
            });
            source = new ol.source.TileWMS({
                url: '/geoserver_wms_proxy',
                params: {
                    'LAYERS': 'External:Подложка ДЗЗ',
                    '_target': 'GEOSERVER',
                    // [FIX] _kind=basemap — подсказка backend'у: это подложка на весь
                    // экран, а не одиночный COG-снимок. Роутится в отдельный семафор
                    // с увеличенным таймаутом (см. geoserver_wms_proxy в app.py),
                    // чтобы тайлы подложки не конкурировали за 8 COG-слотов со
                    // снимками и не отваливались по таймауту.
                    '_kind': 'basemap',
                    'TILED': true,
                    'FORMAT': 'image/jpeg',
                    'STYLES': '',
                    'VERSION': '1.3.0',
                    'FORMAT_OPTIONS': 'dpi:96',
                    'WIDTH': 256,
                    'HEIGHT': 256,
                },
                tileGrid: _dzzTileGrid,
                serverType: 'geoserver',
                crossOrigin: 'anonymous',
                wrapX: false,
                transition: 0,  // FIX: мгновенно из кэша без fade-in
                tileLoadFunction: _dzzTileLoader,
            });
        } else if (def.yandex) {
            // Яндекс: стандартная XYZ, origin тайловой сетки совпадает с EPSG:3857
            // Единственная особенность — Y считается сверху вниз (как у Google),
            // поэтому инверсия НЕ нужна. Используем стандартный XYZ с явным tileGrid
            // чтобы OpenLayers не применял внутреннюю нормализацию координат.
            const _yTileSize = 256;
            const _yProjection = ol.proj.get('EPSG:3857');
            const _yExtent = _yProjection.getExtent();
            const _yTileGrid = new ol.tilegrid.TileGrid({
                extent: _yExtent,
                origin: ol.extent.getTopLeft(_yExtent),
                resolutions: ol.tilegrid.createXYZ({ tileSize: _yTileSize, maxZoom: def.maxZoom || 19 }).getResolutions(),
                tileSize: _yTileSize
            });
            const _yUrlTemplate = def.urls[0];
            source = new ol.source.XYZ({
                tileGrid: _yTileGrid,
                tileUrlFunction: function(tileCoord) {
                    const z = tileCoord[0];
                    const x = tileCoord[1];
                    const y = tileCoord[2];
                    if (x < 0 || y < 0 || x >= (1 << z) || y >= (1 << z)) return undefined;
                    return _yUrlTemplate
                        .replace('{x}', x)
                        .replace('{y}', y)
                        .replace('{z}', z);
                },
                projection: 'EPSG:3857',
                crossOrigin: 'anonymous',
                maxZoom: def.maxZoom || 19,
                attributions: def.attribution || '© Яндекс',
                transition: 0,
                cacheSize: 512,
            });
        } else {
            source = new ol.source.XYZ({
                urls: def.urls,
                crossOrigin: 'anonymous',
                maxZoom: def.maxZoom || 20,
                attributions: def.attribution || 'РУП Белгослес',
                transition: 0,       // мгновенное появление, без fade-in задержки
                cacheSize: 512,      // держим больше тайлов в памяти
            });
        }
        // preload:Infinity — предзагружаем все соседние тайлы (быстрый скролл без пустот)
        // useInterimTiles:false — НЕ показывать размытые тайлы чужого зума (убирает квадратный артефакт)
        // minZoom/maxZoom — ограничиваем диапазон зумов для слоя (важно для ДЗЗ WMS!)
        // useInterimTiles:true — масштабирует тайлы последнего зума вместо пустоты выше maxZoom источника.
        // maxZoom НЕ передаётся в layer — источник сам ограничивает запросы; ограничение
        // на уровне слоя скрывало бы подложку целиком выше его maxZoom.
        // [FIX] preload:Infinity для WMS-подложки ДЗЗ отключён. Предзагрузка соседних
        // тайлов удваивала-утраивала число одновременных GetMap-запросов к GeoServer;
        // именно она чаще всего и «съедала» лимит соединений, из-за чего видимая
        // часть охвата не успевала прогрузиться. Для быстрых XYZ-подложек оставляем.
        const layerOpts = {
            source,
            zIndex: 0,
            preload: def.isWms ? 0 : Infinity,
            useInterimTiles: true
        };
        if (def.minZoom != null) layerOpts.minZoom = def.minZoom;
        if (def.extent) layerOpts.extent = def.extent;
        const layer = new ol.layer.Tile(layerOpts);
        layer._basemapKey = name;
        return layer;
    }

    // ==========================================
    // 4.6 ДОЗАГРУЗКА «ДЫР» ПОДЛОЖКИ ДЗЗ
    // ==========================================
    // Если после всех повторов какие-то тайлы всё же не пришли (GeoServer был
    // перегружен), OpenLayers держит их в состоянии ERROR и сам не перезапросит.
    // Ждём, пока очередь опустеет, и один раз мягко обновляем источник —
    // к этому моменту GWC-кэш GeoServer уже прогрет предыдущими попытками,
    // поэтому повторный проход обычно закрывает остаток охвата мгновенно.
    let _dzzHealTimer = null;
    let _dzzHealCount = 0;
    const _DZZ_MAX_HEALS = 2;   // защита от бесконечного цикла обновлений

    function _scheduleDzzHeal() {
        if (_dzzHealTimer) clearTimeout(_dzzHealTimer);
        _dzzHealTimer = setTimeout(function() {
            _dzzHealTimer = null;
            if (!_basemapLayer || _basemapLayer._basemapKey !== 'dzz-arcgis') return;
            if (_dzzActive > 0 || _dzzQueue.length > 0) { _scheduleDzzHeal(); return; }
            if (window._dzzErrorCount <= 0 || _dzzHealCount >= _DZZ_MAX_HEALS) return;
            _dzzHealCount++;
            window._dzzErrorCount = 0;
            try { _basemapLayer.getSource().refresh(); } catch (e) {}
        }, 4000);
    }

    // Ручной сброс счётчика при смене подложки — см. window.setBasemap
    window._resetDzzHealState = function() {
        _dzzHealCount = 0;
        window._dzzErrorCount = 0;
        if (_dzzHealTimer) { clearTimeout(_dzzHealTimer); _dzzHealTimer = null; }
    };
    window._scheduleDzzHeal = _scheduleDzzHeal;

    // ── Слои (реестр) ────────────────────────────────────────────────
    // Используем zIndex для управления порядком:
    //   0      — подложка (basemap)
    //   10–159 — ВСЕ растровые снимки (raster-tiles=10, COG baseZ=10, DZZ zBase=11)
    //   198    — границы лесхозов (forestry) — ВЫШЕ всех снимков
    //   220–299— внешние WMS векторные/SHP слои — ВЫШЕ всех снимков
    //   300    — граница РБ line (поверх всего)
    //   350    — пользовательские векторные слои (SHP загруженные)
    //   400    — выделения
    //   500    — измерения

    const _layers = {}; // реестр ol.layer по id
    window._layers = _layers; // экспорт для lazy-loaded панелей

    // ==========================================
    // 6. ДОБАВЛЕНИЕ СЛОЁВ
    // ==========================================

    // Шаг 1: Растровые снимки
    function _addRasterTilesLayer() {
        if (_layers['raster-tiles']) return;
        const layer = new ol.layer.Tile({
            source: new ol.source.XYZ({
                url: window.location.origin + '/tiles/raster/{z}/{x}/{y}.png',
                crossOrigin: 'anonymous',
                minZoom: 12,
                maxZoom: 22,
                transition: 0,       // без fade-in
                cacheSize: 512,
            }),
            zIndex: 10,
            visible: AppState.layerState.raster,
            minZoom: 12,
            preload: 4,
            useInterimTiles: false,  // не показывать размытые тайлы другого зума
        });
        _layers['raster-tiles'] = layer;
        map.addLayer(layer);
    }

    // Шаг 2: Маска + граница Беларуси
    function _addMaskAsync_FIXED() {
    function _addMaskLayers(data) {
        if (!data) return;
        if ('mask-layer' in _layers) return; // уже инициализировано (значение null или слой)

        const holes = [];
        data.features.forEach(f => {
            if (f.geometry.type === 'Polygon') holes.push(f.geometry.coordinates[0]);
            else if (f.geometry.type === 'MultiPolygon')
                f.geometry.coordinates.forEach(p => holes.push(p[0]));
        });

        // Сохраняем кольца в EPSG:3857 — используются для canvas clip в каждом кадре
        window._belarusClipRings = holes.map(ring => ring.map(c => ol.proj.fromLonLat(c)));

        // Canvas clip уже применён ко всем тайловым слоям — этого достаточно.
        // Белый полигон-маску НЕ используем: при анимации зума векторные слои
        // масштабируются через CSS transform и дают прямоугольный артефакт.
        // Вместо этого фон за пределами Беларуси — белый цвет div#map (CSS).
        _layers['mask-layer'] = null; // помечаем как инициализированный
        // Применяем clip к уже добавленным тайловым слоям
        _applyClipToAllExistingLayers();

        // Граница РБ — отдельный слой, чистая линия поверх всего
        const format = new ol.format.GeoJSON();
        const borderFeatures = format.readFeatures(data, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857'
        });
        const borderLayer = new ol.layer.Vector({
            source: new ol.source.Vector({ features: borderFeatures }),
            style: new ol.style.Style({
                stroke: new ol.style.Stroke({ color: '#1a1a1a', width: 1.8 }),
                fill: new ol.style.Fill({ color: 'rgba(0,0,0,0)' })
            }),
            zIndex: 300
        });
        _layers['belarus-border-line'] = borderLayer;
        _origAddLayer(borderLayer); // добавляем напрямую — векторный слой clip не нужен

        // Теперь загружаем границы лесхозов
        _addForestryAsync_FIXED();
    }

    if (window._countryBoundaryCache) {
        _addMaskLayers(window._countryBoundaryCache);
    } else {
        fetch('/api/country-boundary')
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
            .then(data => {
                if (data) window._countryBoundaryCache = data;
                _addMaskLayers(data);
            });
        }
    }

    // Шаг 3: Границы лесхозов
    let _forestrySource = null;
    let _forestryFillLayer = null;
    let _forestryLineLayer = null;
    let _hoveredForestryFeature = null;
    let _selectedForestryFeature = null;
    // Экспортируем через getter — слой создаётся асинхронно, поэтому простое
    // window._forestryFillLayer = null сохранит null навсегда.
    // Getter всегда возвращает актуальное значение замыкания.
    Object.defineProperty(window, '_forestryFillLayer', {
        get: () => _forestryFillLayer,
        configurable: true
    });

    function _addForestryAsync_FIXED() {
    function _addForestryLayers(data) {
        window.forestryGeoData = data;
        AppState.forestry.geoData = data;
        if (_layers['forestry-fill']) return;

        const format = new ol.format.GeoJSON();
        const features = format.readFeatures(data, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857'
        });

        _forestrySource = new ol.source.Vector({ features });

        function _forestryStyle(feature) {
            const isSelected = feature.get('_selected');
            const isHovered  = feature.get('_hovered');
            return new ol.style.Style({
                fill: new ol.style.Fill({
                    color: isSelected ? 'rgba(255,0,0,0.12)' :
                           isHovered  ? 'rgba(255,215,0,0.12)' : 'rgba(0,0,0,0)'
                }),
                stroke: new ol.style.Stroke({
                    // FIX: используем более тонкую линию и полупрозрачный цвет
                    // чтобы внутренние границы были видны, но не конкурировали
                    // с официальной границей РБ
                    color: isSelected ? '#ff0000' : 'rgba(139,69,19,0.55)',
                    width: isSelected ? 3 : 1
                })
            });
        }

        _forestryFillLayer = new ol.layer.Vector({
            source: _forestrySource,
            style: _forestryStyle,
            // FIX: zIndex=199 — НИЖЕ чем граница РБ (151) НЕТ, нам нужно
            // чтобы лесхозы были над маской (150) но их stroke не перекрывал
            // линию границы (151). Ставим 198 — под линией границы.
            zIndex: 198,
            visible: AppState.layerState.forestry,
            // Отображаем на ВСЕХ зумах без ограничений
            minZoom: 0,
            maxZoom: 28
        });
        _forestryLineLayer = _forestryFillLayer;

        _layers['forestry-fill'] = _forestryFillLayer;
        _layers['forestry-line'] = _forestryFillLayer;
        map.addLayer(_forestryFillLayer);

        initForestryInteractions();
    }

    if (window.forestryGeoData) {
        _addForestryLayers(window.forestryGeoData);
    } else {
        fetch('/api/forestry-boundaries')
            .then(r => r.json())
            .then(data => _addForestryLayers(data))
            .catch(() => {});
    }
    }

    // ── ИНТЕРАКТИВНОСТЬ ЛЕСХОЗОВ ─────────────────────────────────
    function initForestryInteractions() {
        // Hover — работает на ЛЮБОМ зуме, через source напрямую (без зависимости от видимости слоя)
        // [PERF-FIX] Раньше на каждый pointermove делался ПОЛНЫЙ перебор всех
        // фич лесхозов (_forestrySource.getFeatures().find(...)) в обход
        // встроенного R-tree индекса источника. getFeaturesAtCoordinate() —
        // штатный метод OL, использующий тот же индекс, что и рендер, поэтому
        // проверяет только реальных кандидатов рядом с курсором, а не все ~100+
        // лесхозов. Дополнительно обработка обёрнута в rAF-throttle — расчёт
        // идёт не чаще одного раза за кадр, а не на каждое сырое событие мыши.
        let _forestryHoverRaf = null;
        let _forestryHoverCoord = null;
        map.on('pointermove', (e) => {
            if (!_forestrySource) return;
            _forestryHoverCoord = e.coordinate;
            if (_forestryHoverRaf) return;
            _forestryHoverRaf = requestAnimationFrame(() => {
                _forestryHoverRaf = null;
                const coord = _forestryHoverCoord;
                if (!coord || !_forestrySource) return;

                const candidates = _forestrySource.getFeaturesAtCoordinate(coord);
                const hovered = (candidates && candidates.length) ? candidates[0] : null;

                const hit = !!hovered;
                map.getTargetElement().style.cursor = hit ? 'pointer' : 'grab';

                if (_hoveredForestryFeature && _hoveredForestryFeature !== hovered) {
                    _hoveredForestryFeature.set('_hovered', false);
                    if (_forestryFillLayer) _forestryFillLayer.changed();
                }
                if (hovered && hovered !== _hoveredForestryFeature && hovered !== _selectedForestryFeature) {
                    _hoveredForestryFeature = hovered;
                    _hoveredForestryFeature.set('_hovered', true);
                    if (_forestryFillLayer) _forestryFillLayer.changed();
                } else if (!hovered) {
                    _hoveredForestryFeature = null;
                }
            });
        });

        // Click — выделение лесхоза работает на ЛЮБОМ зуме и независимо от видимости слоя
        map.on('singleclick', (e) => {
            if (window._msrDrawingActive) return; // не идентифицируем во время рисования
            if (!_forestrySource) return;
            // Временно делаем слой видимым для hitTest если он скрыт
            const _wasVisible = _forestryFillLayer ? _forestryFillLayer.getVisible() : false;
            if (_forestryFillLayer && !_wasVisible) _forestryFillLayer.setVisible(true);
            const features = map.getFeaturesAtPixel(e.pixel, {
                layerFilter: l => l === _forestryFillLayer
            });
            // Восстанавливаем исходную видимость если слой был скрыт
            if (_forestryFillLayer && !_wasVisible) _forestryFillLayer.setVisible(false);
            if (!features || !features.length) return;
            const code = features[0].get('code');
            if (!code) return;
            if (String(AppState.forestry.selectedCode) === String(code)) {
                window.clearSelection();
            } else {
                window.focusOnLeskhoz(String(code));
            }
        });
    }

    // ==========================================
    // 7. ВНЕШНИЕ WMS/COG СЛОИ (GeoServer → OL TileWMS)
    // ==========================================

    const EXTERNAL_LAYER_DEFS = [
        // ── Базовые слои BelGosLes ──────────────────────────────────────────────
        { key: 'gs_lesnich',   label: 'Лесничества РБ', sublabel: 'BelGosLes:view_lesnich',  icon: 'fa-tree',          group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'BELGOSLES' },
        { key: 'gs_leshoz',    label: 'Лесхозы РБ',     sublabel: 'BelGosLes:view_leshoz',   icon: 'fa-map',           group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'BELGOSLES' },
        { key: 'gs_quarter',   label: 'Кварталы РБ',    sublabel: 'BelGosLes:quarter',       icon: 'fa-vector-square', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'BELGOSLES' },
        { key: 'gs_gran_glu',  label: 'Границы лесхозов по ГЛУ', sublabel: 'External:gran_leshozi', icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER' },
        { key: 'gs_leshoz1',   label: 'Лесхозы (по году ЛУ)',    sublabel: 'External:leshoz1',       icon: 'fa-calendar-days', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER' },
        { key: 'gs_allotment', label: 'Выделы РБ',      sublabel: 'CoverStyleManage:view_allotment_and_character_and_other_subcateg_and_features', icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'COVERSTYLE' },
        { key: 'gs_allotment_min', label: 'Выделы РБ (мин)',  sublabel: 'BelGosLes:allotmentMin', icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'BELGOSLES' },

        // ── Базовое лесоустройство (COG) ────────────────────────────────────────
        { key: 'gs_disnenski_leshoz_cog',    label: 'Дисненский лесхоз (ЛУ)',    sublabel: 'External:Дисненский лесхоз',          icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '209' },
        { key: 'gs_disnenski_leshoz_vector', label: 'Дисненский лесхоз (Вектор)',sublabel: 'External:seampoly',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '209' },
        { key: 'gs_slutski_leshoz_cog',      label: 'Слуцкий лесхоз (ЛУ)',       sublabel: 'External:Слуцкий лесхоз',             icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '514' },
        { key: 'gs_lyubansky_leshoz_cog',    label: 'Любанский лесхоз (ЛУ)',      sublabel: 'External:Любанский лесхоз',           icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '509' },
        { key: 'gs_logoisk_leshoz_cog',      label: 'Логойский лесхоз (ЛУ)',      sublabel: 'External:logoisk_wgs84_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '508' },
        { key: 'gs_begomilsky_leshoz_cog',   label: 'Бегомельский лесхоз (ЛУ)',   sublabel: 'External:Бегомельский лесхоз',        icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '201' },
        { key: 'gs_surazhsky_leshoz_cog',    label: 'Суражский лесхоз (ЛУ)',      sublabel: 'External:Суражский лесхоз',           icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '215' },
        { key: 'gs_surazhsky_leshoz_vector', label: 'Суражский лесхоз (Вектор)',  sublabel: 'External:sempoly_surash',             icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '215' },
        { key: 'gs_volkovysk_leshoz_cog',    label: 'Волковысский лесхоз (ЛУ)',   sublabel: 'External:Волковысский лесхоз',        icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '401' },
        { key: 'gs_slonim_leshoz_cog',        label: 'Слонимский лесхоз (ЛУ)',     sublabel: 'External:slonim_wgs84_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '408' },
        { key: 'gs_slonim_leshoz_vector',      label: 'Слонимский лесхоз (Вектор)', sublabel: 'External:seampoly_Slonim',            icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '408' },
        { key: 'gs_kopil_leshoz_cog',         label: 'Копыльский лесхоз (ЛУ)',     sublabel: 'External:kopil_wgs84_deflate_cog',    icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '506' },
        { key: 'gs_starodorosh_leshoz_cog',   label: 'Стародорожский лесхоз (ЛУ)', sublabel: 'External:Starodoroshski_wgs84_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, bbox: [27.8684, 52.7879, 28.6390, 53.3348], leskhozCode: '517' },
        { key: 'gs_lida_leshoz_cog',           label: 'Лидский лесхоз (ЛУ)',        sublabel: 'External:lida_wgs84_deflate_cog',           icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '405' },
        { key: 'gs_lida_leshoz_vector',        label: 'Лидский лесхоз (Вектор)',    sublabel: 'External:Lidskiy_seampolygon',              icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '405' },
        { key: 'gs_ushachi_leshoz_cog',        label: 'Ушачский лесхоз (ЛУ)',       sublabel: 'External:Ushachi_wgs84_deflate_cog',        icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '217' },
        { key: 'gs_ushachi_leshoz_vector',     label: 'Ушачский лесхоз (Вектор)',   sublabel: 'External:sempoly_ush',                      icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: false, wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '217' },
        { key: 'gs_borisov_leshoz_cog',        label: 'Борисовский лесхоз (ЛУ)',    sublabel: 'External:Borisov_GM_wgs84_deflate_cog',     icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '502' },
        { key: 'gs_borovlyanski_leshoz_cog',   label: 'Боровлянский спецлесхоз (ЛУ)', sublabel: 'External:Borovlyanski_GM_wgs84_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '521' },
        { key: 'gs_bogushevski_leshoz_cog',    label: 'Богушевский лесхоз (ЛУ)',      sublabel: 'External:Bogushevski_GM_wgs84_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '203' },
        { key: 'gs_np_pripyat_cog',            label: 'НП "Припятский" (ЛУ)',         sublabel: 'External:NP_Pripyat_GM_wgs84_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '4033' },
        { key: 'gs_np_belovezhskaya_pushcha_cog', label: 'НП "Беловежская пуща" (ЛУ)',  sublabel: 'External:Национальный_парк_Беловежская_пуща_wgs84_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '4014' },
        { key: 'gs_glubokski_leshoz_cog',      label: 'Глубокский лесхоз (ЛУ)',       sublabel: 'External:Glubokski_GM_wgs84_deflate_cog',    icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '207' },
        { key: 'gs_postavski_leshoz_cog',      label: 'Поставский лесхоз (ЛУ)',       sublabel: 'External:Postavski_GM_wgs84_deflate_cog',    icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '213' },
        { key: 'gs_krupski_leshoz_cog',        label: 'Крупский лесхоз (ЛУ)',         sublabel: 'External:Krupski_GM_wgs84_deflate_cog',      icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '507' },
        { key: 'gs_lepelski_leshoz_cog',        label: 'Лепельский лесхоз (ЛУ)',       sublabel: 'External:Lepelski_GM_wgs84_deflate_cog',     icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '210' },
        { key: 'gs_gorodokski_leshoz_cog',      label: 'Городокский лесхоз (ЛУ)',      sublabel: 'External:Gorodokski_GM_wgs84_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '208' },
        { key: 'gs_mss_orshanski_leshoz',       label: 'Оршанский лесхоз (ЛУ)',        sublabel: 'External:mss_Orshanski_leshoz',              icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '211' },
        { key: 'gs_grodneski_leshoz_cog',       label: 'Гродненский лесхоз (ЛУ)',      sublabel: 'External:Гродненский_лесхоз_wgs84_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '402' },
        { key: 'gs_verkhnedvinsk_leshoz_cog',   label: 'Верхнедвинский лесхоз (ЛУ)',   sublabel: 'External:Верхнедвинск_wgs84_deflate_cog',    icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '205' },
        { key: 'gs_skidelski_leshoz_cog',       label: 'Скидельский лесхоз (ЛУ)',      sublabel: 'External:Скидельский_лесхоз_wgs84_deflate_cog',  icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '413' },
        { key: 'gs_rossonski_leshoz_cog',       label: 'Россонский лесхоз (ЛУ)',       sublabel: 'External:Россонский_лесхоз_wgs84_deflate_cog',    icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '214' },
        { key: 'gs_vitebski_leshoz_cog',        label: 'Витебский лесхоз (ЛУ)',        sublabel: 'External:Витебский_лесхоз_wgs84_deflate_cog',      icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true,  wmsUrl: 'GEOSERVER', hidden: true, leskhozCode: '206' },

        // ── Спутниковые снимки ──────────────────────────────────────────────────
        { key: 'gs_ks_4108041_pan_cog',    label: '4108041-0330-PAN (COG)',    sublabel: 'External:4108041-0330-PAN_cog',                                                      icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108041_pan_bounds', label: '4108041-0330-PAN (Контур)',  sublabel: 'External:4108041-0330-PAN-B-1-1-4431396-250227T083628-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109241_pan_cog',    label: '4109241-0330-PAN (COG)',    sublabel: 'External:4109241-0330-PAN-B-1-1-6400064-250428T083600-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109241_pan_bounds', label: '4109241-0330-PAN (Контур)', sublabel: 'External:4109241-0330-PAN-B-1-1-6400064-250428T083600-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109251_pan_cog',    label: '4109251-0330-PAN (COG)',    sublabel: 'External:4109251-0330-PAN-B-1-1-7396695-250501T091828-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109251_pan_bounds', label: '4109251/52-PAN (Контур)',   sublabel: 'External:4109251-0330-PAN-B-1-1-7396695-250501T091828-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109252_pan_cog',    label: '4109252-0330-PAN (COG)',    sublabel: 'External:4109252-0330-PAN-B-1-1-7396695-250501T091828-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109321_pan_cog',    label: '4109321-0330-PAN (COG)',    sublabel: 'External:4109321-0330-PAN-B-1-1-6401073-250502T084921-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109321_pan_bounds', label: '4109321-0330-PAN (Контур)', sublabel: 'External:4109321-0330-PAN-B-1-1-6401073-250502T084921-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109621_pan_cog',    label: '4109621-0330-PAN (COG)',    sublabel: 'External:4109621-0330-PAN-B-1-1-4453544-250605T083937-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109621_pan_bounds', label: '4109621-0330-PAN (Контур)', sublabel: 'External:4109621-0330-PAN-B-1-1-4453544-250605T083937-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109671_pan_cog',    label: '4109671-0330-PAN (COG)',    sublabel: 'External:4109671-0330-PAN-B-1-1-3470112-250606T084354-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109671_pan_bounds', label: '4109671-0330-PAN (Контур)', sublabel: 'External:4109671-0330-PAN-B-1-1-3470112-250606T084354-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109991_pan_cog',    label: '4109991-0330-PAN (COG)',    sublabel: 'External:4109991-0330-PAN-B-1-1-6411471-250616T091253-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109991_pan_bounds', label: '4109991-0330-PAN (Контур)', sublabel: 'External:4109991-0330-PAN-B-1-1-6411471-250616T091253-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109810_pan_bounds', label: '4109810/11/12/13 (Контур)', sublabel: 'External:4109810-0330-PAN-B-1-1-3472143-250615T084954-BY-LV_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109811_pan_cog',    label: '4109811-0330-PAN (COG)',    sublabel: 'External:4109811-0330-PAN-B-1-1-3472143-250615T084954-BY-LV_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109812_pan_cog',    label: '4109812-0330-PAN (COG)',    sublabel: 'External:4109812-0330-PAN-B-1-1-3472143-250615T084954-BY-LV_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109813_pan_cog',    label: '4109813-0330-PAN (COG)',    sublabel: 'External:4109813-0330-PAN-B-1-1-3472143-250615T084954-BY-LV_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110060_pan_bounds', label: '4110060/61/62/63 (Контур)', sublabel: 'External:4110060-0330-PAN-B-1-1-6412565-250621T090444-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110061_pan_cog',    label: '4110061-0330-PAN (COG)',    sublabel: 'External:4110061-0330-PAN-B-1-1-6412565-250621T090444-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110062_pan_cog',    label: '4110062-0330-PAN (COG)',    sublabel: 'External:4110062-0330-PAN-B-1-1-6412565-250621T090444-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110063_pan_cog',    label: '4110063-0330-PAN (COG)',    sublabel: 'External:4110063-0330-PAN-B-1-1-6412565-250621T090444-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110471_pan_bounds', label: '4110471 (Контур)',          sublabel: 'External:4110471-0330-PAN-B-1-1-6415942-250706T083920-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110471_pan_cog',    label: '4110471-0330-PAN (COG)',    sublabel: 'External:4110471-0330-PAN-B-1-1-6415942-250706T083920-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110540_pan_bounds', label: '4110540/41/42 (Контур)',    sublabel: 'External:4110540-0330-PAN-B-1-1-4460792-250707T084155-BY-UA_bounds',               icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110540_pan_cog',    label: '4110540-0330-PAN (COG)',    sublabel: 'External:4110540-0330-PAN-B-1-1-4460792-250707T084155-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110541_pan_cog',    label: '4110541-0330-PAN (COG)',    sublabel: 'External:4110541-0330-PAN-B-1-1-4460792-250707T084155-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110542_pan_cog',    label: '4110542-0330-PAN (COG)',    sublabel: 'External:4110542-0330-PAN-B-1-1-4460792-250707T084155-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110611_pan_bounds', label: '4110611 (Контур)',          sublabel: 'External:4110611-0330-PAN-B-1-1-5449382-250710T082806-BY-RU_bounds',               icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110611_pan_cog',    label: '4110611-0330-PAN (COG)',    sublabel: 'External:4110611-0330-PAN-B-1-1-5449382-250710T082806-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group', group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110661_pan_bounds', label: '4110661 (Контур)',          sublabel: 'External:4110661-0330-PAN-B-1-1-5450492-250714T083919-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110661_pan_cog',    label: '4110661-0330-PAN (COG)',    sublabel: 'External:4110661-0330-PAN-B-1-1-5450492-250714T083919-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110811_pan_cog',          label: '4110811-0330-PAN (COG)',    sublabel: 'External:4110811-0330-PAN-B-1-1-6419961-250724T084340-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110811_pan_bounds',       label: '4110811-0330-PAN (Контур)', sublabel: 'External:4110811-0330-PAN-B-1-1-6419961-250724T084340-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110821_pan_cog',    label: '4110821-0330-PAN (COG)',    sublabel: 'External:4110821-0330-PAN-B-1-1-6421161-250729T083414-BY-RU_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110821_pan_bounds', label: '4110821-0330-PAN (Контур)', sublabel: 'External:4110821-0330-PAN-B-1-1-6421161-250729T083414-BY-RU_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110891_pan_cog',    label: '4110891-0330-PAN (COG)',    sublabel: 'External:4110891-0330-PAN-B-1-1-6422003-250802T084005-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110891_pan_bounds', label: '4110891-0330-PAN (Контур)', sublabel: 'External:4110891-0330-PAN-B-1-1-6422003-250802T084005-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110941_pan_solo_cog', label: '4110941-0330-PAN (COG)',  sublabel: 'External:4110941-0330-PAN',                                                         icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110940_pan_cog',    label: '4110940-0330-PAN (COG)',    sublabel: 'External:4110941-0330-PAN-B-1-1-3483571-250804T085255-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110940_pan_bounds', label: '4110940-0330-PAN (Контур)', sublabel: 'External:4110940-0330-PAN-B-1-1-3483571-250804T085255-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110941_pan_cog',    label: '4110941-0330-PAN (COG)',    sublabel: 'External:4110941-0330-PAN-B-1-1-3483571-250804T085255-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4110942_pan_cog',    label: '4110942-0330-PAN (COG)',    sublabel: 'External:4110942-0330-PAN-B-1-1-3483571-250804T085255-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111001_pan_cog',    label: '4111001-0330-PAN (COG)',    sublabel: 'External:4111001-0330-PAN-B-1-1-3483792-250805T082728-BY-RU_native_crs_deflate_cog',icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111001_pan_bounds', label: '4111001-0330-PAN (Контур)', sublabel: 'External:4111001-0330-PAN-B-1-1-3483792-250805T082728-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111071_pan_bounds', label: '4111071 (Контур)',          sublabel: 'External:4111071-0330-PAN-B-1-1-5456372-250809T090703-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111071_pan_cog',    label: '4111071-0330-PAN (COG)',    sublabel: 'External:4111071-0330-PAN-B-1-1-5456372-250809T090703-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111081_pan_bounds', label: '4111081 (Контур)',          sublabel: 'External:4111081-0330-PAN-B-1-1-5456622-250810T084444-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111081_pan_cog',    label: '4111081-0330-PAN (COG)',    sublabel: 'External:4111081-0330-PAN-B-1-1-5456622-250810T084444-BY_native_crs_deflate_cog',  icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111670_pan_cog',    label: '4111670-0330-PAN (COG)',    sublabel: 'External:4111670-0330-PAN-B-1-1-7425032-250903T090648-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111670_pan_bounds', label: '4111670-0330-PAN (Контур)', sublabel: 'External:4111670-0330-PAN-B-1-1-7425032-250903T090648-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111671_pan_cog',    label: '4111671-0330-PAN (COG)',    sublabel: 'External:4111671-0330-PAN-B-1-1-7425032-250903T090648-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111672_pan_cog',    label: '4111672-0330-PAN (COG)',    sublabel: 'External:4111672-0330-PAN-B-1-1-7425032-250903T090648-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111701_pan_cog',    label: '4111701-0330-PAN (COG)',    sublabel: 'External:4111701-0330-PAN-B-1-1-4473193-250904T084602-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111701_pan_bounds', label: '4111701-0330-PAN (Контур)', sublabel: 'External:4111701-0330-PAN-B-1-1-4473193-250904T084602-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // ── Добавлено: слои из GeoServer которых не было в map.js ───────────

        // 4108591 — 25.04.2025
        { key: 'gs_ks_4108591_pan_cog',    label: '4108591-0330-PAN (COG)',    sublabel: 'External:4108591-0330-PAN-B-1-1-5425692-250403T084659-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108591_pan_bounds', label: '4108591-0330-PAN (Контур)', sublabel: 'External:4108591-0330-PAN-B-1-1-5425692-250403T084659-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108651 — 25.04.2025
        { key: 'gs_ks_4108651_pan_cog',    label: '4108651-0330-PAN (COG)',    sublabel: 'External:4108651-0330-PAN-B-1-1-6394642-250404T084837-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108651_pan_bounds', label: '4108651-0330-PAN (Контур)', sublabel: 'External:4108651-0330-PAN-B-1-1-6394642-250404T084837-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108781 — 25.04.2025
        { key: 'gs_ks_4108781_pan_cog',    label: '4108781-0330-PAN (COG)',    sublabel: 'External:4108781-0330-PAN-B-1-1-5428922-250417T084714-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108781_pan_bounds', label: '4108781-0330-PAN (Контур)', sublabel: 'External:4108781-0330-PAN-B-1-1-5428922-250417T084714-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4109252 — bounds отсутствовал (cog уже был)
        { key: 'gs_ks_4109252_pan_bounds', label: '4109252-0330-PAN (Контур)', sublabel: 'External:4109252-0330-PAN-B-1-1-7396695-250501T091828-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4111180 / 4111181 — 25.08.2025
        { key: 'gs_ks_4111180_pan_cog',    label: '4111180-0330-PAN (COG)',    sublabel: 'External:4111180-0330-PAN-B-1-1-3485792-250814T083252-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111180_pan_bounds', label: '4111180-0330-PAN (Контур)', sublabel: 'External:4111180-0330-PAN-B-1-1-3485792-250814T083252-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111181_pan_cog',    label: '4111181-0330-PAN (COG)',    sublabel: 'External:4111181-0330-PAN-B-1-1-3485792-250814T083252-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4111182_pan_cog',    label: '4111182-0330-PAN (COG)',    sublabel: 'External:4111182-0330-PAN-B-1-1-3485792-250814T083252-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108421 — 27.02.2025
        { key: 'gs_ks_4108421_pan_cog',    label: '4108421-0330-PAN (COG)',    sublabel: 'External:4108421-0330-PAN-B-1-1-4431396-250227T083628-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108421_pan_bounds', label: '4108421-0330-PAN (Контур)', sublabel: 'External:4108421-0330-PAN-B-1-1-4431396-250227T083628-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108422 — 08.03.2025
        { key: 'gs_ks_4108422_pan_cog',    label: '4108422-0330-PAN (COG)',    sublabel: 'External:4108422-0330-PAN-B-1-1-4433264-250308T084351-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108422_pan_bounds', label: '4108422-0330-PAN (Контур)', sublabel: 'External:4108422-0330-PAN-B-1-1-4433264-250308T084351-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108423 — 07.03.2025
        { key: 'gs_ks_4108423_pan_cog',    label: '4108423-0330-PAN (COG)',    sublabel: 'External:4108423-0330-PAN-B-1-1-6388842-250307T084039-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108423_pan_bounds', label: '4108423-0330-PAN (Контур)', sublabel: 'External:4108423-0330-PAN-B-1-1-6388842-250307T084039-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108431 — 08.03.2025
        { key: 'gs_ks_4108431_pan_cog',    label: '4108431-0330-PAN (COG)',    sublabel: 'External:4108431-0330-PAN-B-1-1-4433264-250308T084351-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108431_pan_bounds', label: '4108431-0330-PAN (Контур)', sublabel: 'External:4108431-0330-PAN-B-1-1-4433264-250308T084351-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108441 — 22.02.2025
        { key: 'gs_ks_4108441_pan_cog',    label: '4108441-0330-PAN (COG)',    sublabel: 'External:4108441-0330-PAN-B-1-1-4430213-250222T084437-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108441_pan_bounds', label: '4108441-0330-PAN (Контур)', sublabel: 'External:4108441-0330-PAN-B-1-1-4430213-250222T084437-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4108971 — 21.04.2025
        { key: 'gs_ks_4108971_pan_cog',    label: '4108971-0330-PAN (COG)',    sublabel: 'External:4108971-0330-PAN-B-1-1-3459126-250421T083704-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4108971_pan_bounds', label: '4108971-0330-PAN (Контур)', sublabel: 'External:4108971-0330-PAN-B-1-1-3459126-250421T083704-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4109011 — 22.04.2025
        { key: 'gs_ks_4109011_pan_cog',    label: '4109011-0330-PAN (COG)',    sublabel: 'External:4109011-0330-PAN-B-1-1-5430083-250422T084039-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109011_pan_bounds', label: '4109011-0330-PAN (Контур)', sublabel: 'External:4109011-0330-PAN-B-1-1-5430083-250422T084039-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4109381 — 02.05.2025
        { key: 'gs_ks_4109381_pan_cog',    label: '4109381-0330-PAN (COG)',    sublabel: 'External:4109381-0330-PAN-B-1-1-7396921-250502T084633-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4109381_pan_bounds', label: '4109381-0330-PAN (Контур)', sublabel: 'External:4109381-0330-PAN-B-1-1-7396921-250502T084633-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // ── Космоснимки 2026 ────────────────────────────────────────────────────

        // 4114790/791/792 — 02.05.2026 (BY-LT, три сцены одной съёмки)
        { key: 'gs_ks_4114790_pan_bounds', label: '4114790-0330-PAN (Контур)', sublabel: 'External:4114790-0330-PAN-B-1-1-3538032-260502T085517-BY-LT_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4114792_pan_cog',    label: '4114792-0330-PAN (COG)',    sublabel: 'External:4114792-0330-PAN-B-1-1-3538032-260502T085517-BY-LT_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4114791_pan_cog',    label: '4114791-0330-PAN (COG)',    sublabel: 'External:4114791-0330-PAN',                                                            icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },

        // 4114861 — 02.05.2026 (BY)
        { key: 'gs_ks_4114861_pan_bounds', label: '4114861-0330-PAN (Контур)', sublabel: 'External:4114861-0330-PAN-B-1-1-4522472-260502T083248-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4114861_pan_cog',    label: '4114861-0330-PAN (COG)',    sublabel: 'External:4114861-0330-PAN-B-1-1-4522472-260502T083248-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },

        // 4114950/951/952 — 03.05.2026 (BY-LV, три сцены)
        { key: 'gs_ks_4114950_pan_bounds', label: '4114950-0330-PAN (Контур)', sublabel: 'External:4114950-0330-PAN-B-1-1-3538282-260503T083448-BY-LV_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4114951_pan_cog',    label: '4114951-0330-PAN (COG)',    sublabel: 'External:4114951-0330-PAN-B-1-1-3538282-260503T083448-BY-LV_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4114952_pan_cog',    label: '4114952-0330-PAN (COG)',    sublabel: 'External:4114952-0330-PAN-B-1-1-3538282-260503T083448-BY-LV_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },

        // 4115011 — 03.05.2026 (BY-PL)
        { key: 'gs_ks_4115011_pan_bounds', label: '4115011-0330-PAN (Контур)', sublabel: 'External:4115011-0330-PAN-B-1-1-5510874-260503T085856-BY-PL_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4115011_pan_cog',    label: '4115011-0330-PAN (COG)',    sublabel: 'External:4115011-0330-PAN-B-1-1-5510874-260503T085856-BY-PL_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },

        // 4115110/111/112/113 — 04.05.2026 (BY, четыре сцены)
        { key: 'gs_ks_4115110_pan_bounds', label: '4115110-0330-PAN (Контур)', sublabel: 'External:4115110-0330-PAN-B-1-1-5511133-260504T083819-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4115111_pan_cog',    label: '4115111-0330-PAN (COG)',    sublabel: 'External:4115111-0330-PAN-B-1-1-5511133-260504T083819-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4115112_pan_cog',    label: '4115112-0330-PAN (COG)',    sublabel: 'External:4115112-0330-PAN-B-1-1-5511133-260504T083819-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },
        { key: 'gs_ks_4115113_pan_cog',    label: '4115113-0330-PAN (COG)',    sublabel: 'External:4115113-0330-PAN-B-1-1-5511133-260504T083819-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER_EXT', hidden: true },

        // shps test — тестовый векторный слой (GeoServer)
        { key: 'gs_shps_test_vector', label: 'shps test (Вектор)', sublabel: 'shps test', icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // ALL-PANS — все снимки: COG (растр) + SHP (вектор)
        // ALL-PANS: noClip:true — снимки и контуры выходят за границу РБ
        { key: 'gs_all_pans_cog',    label: 'ALL-PANS (COG)',    sublabel: 'kosmo_snimki vse', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true, noClip: true },
        { key: 'gs_all_pans_vector', label: 'ALL-PANS (Вектор)', sublabel: 'shps test2',       icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true, noClip: true },

        // 4100001 — 27.04.2024 (Космо 2024)
        { key: 'gs_ks_4100001_pan_cog',    label: '4100001-0330-PAN (COG)',    sublabel: 'External:4100001-0330-PAN-B-1-1-6323421-240427T083231-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100001_pan_bounds', label: '4100001-0330-PAN (Контур)', sublabel: 'External:4100001-0330-PAN-B-1-1-6323421-240427T083231-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100101 — 29.04.2024 (Космо 2024)
        { key: 'gs_ks_4100101_pan_cog',    label: '4100101-0330-PAN (COG)',    sublabel: 'External:4100101-0330-PAN-B-1-1-3384144-240429T084159-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100101_pan_bounds', label: '4100101-0330-PAN (Контур)', sublabel: 'External:4100101-0330-PAN-B-1-1-3384144-240429T084159-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100231 — 30.04.2024 (Космо 2024)
        { key: 'gs_ks_4100231_pan_cog',    label: '4100231-0330-PAN (COG)',    sublabel: 'External:4100231-0330-PAN-B-1-1-5354601-240430T084541-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100231_pan_bounds', label: '4100231-0330-PAN (Контур)', sublabel: 'External:4100231-0330-PAN-B-1-1-5354601-240430T084541-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100271 + 4100281 — 01.05.2024 (Космо 2024, одна сцена)
        { key: 'gs_ks_4100271_pan_cog',    label: '4100271-0330-PAN (COG)',    sublabel: 'External:4100271-0330-PAN-B-1-1-4368272-240501T091321-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100271_pan_bounds', label: '4100271-0330-PAN (Контур)', sublabel: 'External:4100271-0330-PAN-B-1-1-4368272-240501T091321-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100281_pan_cog',    label: '4100281-0330-PAN (COG)',    sublabel: 'External:4100281-0330-PAN-B-1-1-4368272-240501T091321-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100281_pan_bounds', label: '4100281-0330-PAN (Контур)', sublabel: 'External:4100281-0330-PAN-B-1-1-4368272-240501T091321-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100411 + 4100421 — 02.05.2024 (Космо 2024, одна сцена)
        { key: 'gs_ks_4100411_pan_cog',    label: '4100411-0330-PAN (COG)',    sublabel: 'External:4100411-0330-PAN-B-1-1-4368511-240502T085229-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100411_pan_bounds', label: '4100411-0330-PAN (Контур)', sublabel: 'External:4100411-0330-PAN-B-1-1-4368511-240502T085229-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100421_pan_cog',    label: '4100421-0330-PAN (COG)',    sublabel: 'External:4100421-0330-PAN-B-1-1-4368511-240502T085229-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100421_pan_bounds', label: '4100421-0330-PAN (Контур)', sublabel: 'External:4100421-0330-PAN-B-1-1-4368511-240502T085229-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103161 — 16.08.2024 (Космо 2024)
        { key: 'gs_ks_4103161_pan_cog',    label: '4103161-0330-PAN (COG)',    sublabel: 'External:4103161-0330-PAN-B-1-1-5378952-240816T084552-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103161_pan_bounds', label: '4103161-0330-PAN (Контур)', sublabel: 'External:4103161-0330-PAN-B-1-1-5378952-240816T084552-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103221 — 17.08.2024 (Космо 2024)
        { key: 'gs_ks_4103221_pan_cog',    label: '4103221-0330-PAN (COG)',    sublabel: 'External:4103221-0330-PAN-B-1-1-6347991-240817T084720-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103221_pan_bounds', label: '4103221-0330-PAN (Контур)', sublabel: 'External:4103221-0330-PAN-B-1-1-6347991-240817T084720-BY-UA_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103261 — 19.08.2024 (Космо 2024)
        { key: 'gs_ks_4103261_pan_cog',    label: '4103261-0330-PAN (COG)',    sublabel: 'External:4103261-0330-PAN-B-1-1-3409572-240819T085513-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103261_pan_bounds', label: '4103261-0330-PAN (Контур)', sublabel: 'External:4103261-0330-PAN-B-1-1-3409572-240819T085513-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103451 — 25.08.2024 (Космо 2024)
        { key: 'gs_ks_4103451_pan_cog',    label: '4103451-0330-PAN (COG)',    sublabel: 'External:4103451-0330-PAN-B-1-1-7345371-240825T091740-BY-PL_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103451_pan_bounds', label: '4103451-0330-PAN (Контур)', sublabel: 'External:4103451-0330-PAN-B-1-1-7345371-240825T091740-BY-PL_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103452 — 24.08.2024 (Космо 2024)
        { key: 'gs_ks_4103452_pan_cog',    label: '4103452-0330-PAN (COG)',    sublabel: 'External:4103452-0330-PAN-B-1-1-5380662-240824T091023-BY-PL_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103452_pan_bounds', label: '4103452-0330-PAN (Контур)', sublabel: 'External:4103452-0330-PAN-B-1-1-5380662-240824T091023-BY-PL_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103491 — 25.08.2024 (Космо 2024)
        { key: 'gs_ks_4103491_pan_cog',    label: '4103491-0330-PAN (COG)',    sublabel: 'External:4103491-0330-PAN-B-1-1-5380881-240825T084930-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103491_pan_bounds', label: '4103491-0330-PAN (Контур)', sublabel: 'External:4103491-0330-PAN-B-1-1-5380881-240825T084930-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103561 — 27.08.2024 (Космо 2024)
        { key: 'gs_ks_4103561_pan_cog',    label: '4103561-0330-PAN (COG)',    sublabel: 'External:4103561-0330-PAN-B-1-1-6350422-240827T082857-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103561_pan_bounds', label: '4103561-0330-PAN (Контур)', sublabel: 'External:4103561-0330-PAN-B-1-1-6350422-240827T082857-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103601 — 27.08.2024 (Космо 2024)
        { key: 'gs_ks_4103601_pan_cog',    label: '4103601-0330-PAN (COG)',    sublabel: 'External:4103601-0330-PAN-B-1-1-4395502-240827T085638-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103601_pan_bounds', label: '4103601-0330-PAN (Контур)', sublabel: 'External:4103601-0330-PAN-B-1-1-4395502-240827T085638-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103750 — 28.08.2024 (Космо 2024, только контур — COG отсутствует отдельно)
        { key: 'gs_ks_4103750_pan_bounds', label: '4103750-0330-PAN (Контур)', sublabel: 'External:4103750-0330-PAN-B-1-1-3411571-240828T090050-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103751 — 28.08.2024 (Космо 2024)
        { key: 'gs_ks_4103751_pan_cog',    label: '4103751-0330-PAN (COG)',    sublabel: 'External:4103751-0330-PAN-B-1-1-3411571-240828T090050-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103751_pan_bounds', label: '4103751-0330-PAN (Контур)', sublabel: 'External:4103751-0330-PAN-B-1-1-3411571-240828T090050-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103752 — 28.08.2024 (Космо 2024, только COG)
        { key: 'gs_ks_4103752_pan_cog',    label: '4103752-0330-PAN (COG)',    sublabel: 'External:4103752-0330-PAN-B-1-1-3411571-240828T090050-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103831 — 29.08.2024 (Космо 2024)
        { key: 'gs_ks_4103831_pan_cog',    label: '4103831-0330-PAN (COG)',    sublabel: 'External:4103831-0330-PAN-B-1-1-3411732-240829T084045-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103831_pan_bounds', label: '4103831-0330-PAN (Контур)', sublabel: 'External:4103831-0330-PAN-B-1-1-3411732-240829T084045-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103971 — 30.08.2024 (Космо 2024)
        { key: 'gs_ks_4103971_pan_cog',    label: '4103971-0330-PAN (COG)',    sublabel: 'External:4103971-0330-PAN-B-1-1-5382002-240830T084331-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103971_pan_bounds', label: '4103971-0330-PAN (Контур)', sublabel: 'External:4103971-0330-PAN-B-1-1-5382002-240830T084331-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104031 — 31.08.2024 (Космо 2024)
        { key: 'gs_ks_4104031_pan_cog',    label: '4104031-0330-PAN (COG)',    sublabel: 'External:4104031-0330-PAN-B-1-1-6351121-240831T084455-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104031_pan_bounds', label: '4104031-0330-PAN (Контур)', sublabel: 'External:4104031-0330-PAN-B-1-1-6351121-240831T084455-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104221 — 05.09.2024 (Космо 2024)
        { key: 'gs_ks_4104221_pan_cog',    label: '4104221-0330-PAN (COG)',    sublabel: 'External:4104221-0330-PAN-B-1-1-6352102-240905T083932-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104221_pan_bounds', label: '4104221-0330-PAN (Контур)', sublabel: 'External:4104221-0330-PAN-B-1-1-6352102-240905T083932-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104291 — 06.09.2024 (Космо 2024)
        { key: 'gs_ks_4104291_pan_cog',    label: '4104291-0330-PAN (COG)',    sublabel: 'External:4104291-0330-PAN-B-1-1-4397272-240906T084231-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104291_pan_bounds', label: '4104291-0330-PAN (Контур)', sublabel: 'External:4104291-0330-PAN-B-1-1-4397272-240906T084231-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104371 — 07.09.2024 (Космо 2024)
        { key: 'gs_ks_4104371_pan_cog',    label: '4104371-0330-PAN (COG)',    sublabel: 'External:4104371-0330-PAN-B-1-1-3413393-240907T084653-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104371_pan_bounds', label: '4104371-0330-PAN (Контур)', sublabel: 'External:4104371-0330-PAN-B-1-1-3413393-240907T084653-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104372 — 08.09.2024 (Космо 2024)
        { key: 'gs_ks_4104372_pan_cog',    label: '4104372-0330-PAN (COG)',    sublabel: 'External:4104372-0330-PAN-B-1-1-5383642-240908T084750-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104372_pan_bounds', label: '4104372-0330-PAN (Контур)', sublabel: 'External:4104372-0330-PAN-B-1-1-5383642-240908T084750-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104461 — 07.09.2024 (Космо 2024)
        { key: 'gs_ks_4104461_pan_cog',    label: '4104461-0330-PAN (COG)',    sublabel: 'External:4104461-0330-PAN-B-1-1-7348393-240907T084735-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104461_pan_bounds', label: '4104461-0330-PAN (Контур)', sublabel: 'External:4104461-0330-PAN-B-1-1-7348393-240907T084735-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104581 — 10.09.2024 (Космо 2024)
        { key: 'gs_ks_4104581_pan_cog',    label: '4104581-0330-PAN (COG)',    sublabel: 'External:4104581-0330-PAN-B-1-1-6353001-240910T083118-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104581_pan_bounds', label: '4104581-0330-PAN (Контур)', sublabel: 'External:4104581-0330-PAN-B-1-1-6353001-240910T083118-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104850/851/852 — 19.09.2024 (Космо 2024)
        { key: 'gs_ks_4104850_pan_bounds', label: '4104850-0330-PAN (Контур)', sublabel: 'External:4104850-0330-PAN-B-1-1-4399883-240919T090433-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104851_pan_cog',    label: '4104851-0330-PAN (COG)',    sublabel: 'External:4104851-0330-PAN-B-1-1-4399883-240919T090433-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104852_pan_cog',    label: '4104852-0330-PAN (COG)',    sublabel: 'External:4104852-0330-PAN-B-1-1-4399883-240919T090433-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104860/861/862 — 19.09.2024 (Космо 2024)
        { key: 'gs_ks_4104860_pan_bounds', label: '4104860-0330-PAN (Контур)', sublabel: 'External:4104860-0330-PAN-B-1-1-6354662-240919T084108-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104861_pan_cog',    label: '4104861-0330-PAN (COG)',    sublabel: 'External:4104861-0330-PAN-B-1-1-6354662-240919T084108-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104862_pan_cog',    label: '4104862-0330-PAN (COG)',    sublabel: 'External:4104862-0330-PAN-B-1-1-6354662-240919T084108-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4104951 — 20.09.2024 (Космо 2024)
        { key: 'gs_ks_4104951_pan_cog',    label: '4104951-0330-PAN (COG)',    sublabel: 'External:4104951-0330-PAN-B-1-1-3415883-240920T090829-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4104951_pan_bounds', label: '4104951-0330-PAN (Контур)', sublabel: 'External:4104951-0330-PAN-B-1-1-3415883-240920T090829-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4105041 — 20.09.2024 (Космо 2024)
        { key: 'gs_ks_4105041_pan_cog',    label: '4105041-0330-PAN (COG)',    sublabel: 'External:4105041-0330-PAN-B-1-1-4400063-240920T084335-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4105041_pan_bounds', label: '4105041-0330-PAN (Контур)', sublabel: 'External:4105041-0330-PAN-B-1-1-4400063-240920T084335-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4105151 — 22.09.2024 (Космо 2024)
        { key: 'gs_ks_4105151_pan_cog',    label: '4105151-0330-PAN (COG)',    sublabel: 'External:4105151-0330-PAN-B-1-1-7351661-240922T085947-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4105151_pan_bounds', label: '4105151-0330-PAN (Контур)', sublabel: 'External:4105151-0330-PAN-B-1-1-7351661-240922T085947-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4105231 — 22.09.2024 (Космо 2024)
        { key: 'gs_ks_4105231_pan_cog',    label: '4105231-0330-PAN (COG)',    sublabel: 'External:4105231-0330-PAN-B-1-1-5386522-240922T084911-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4105231_pan_bounds', label: '4105231-0330-PAN (Контур)', sublabel: 'External:4105231-0330-PAN-B-1-1-5386522-240922T084911-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106341 — 20.10.2024 (Космо 2024)
        { key: 'gs_ks_4106341_pan_cog',    label: '4106341-0330-PAN (COG)',    sublabel: 'External:4106341-0330-PAN-B-1-1-5392473-241020T085242-BY-UA_native_crs_deflate_cog_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true, bbox: [27.906432, 51.491918, 28.411901, 51.985603] },
        { key: 'gs_ks_4106341_pan_bounds', label: '4106341-0330-PAN (Контур)', sublabel: 'External:4106341-0330-PAN-B-1-1-5392473-241020T085242-BY-UA_bounds',                                          icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106342 — 19.10.2024 (Космо 2024)
        { key: 'gs_ks_4106342_pan_cog',    label: '4106342-0330-PAN (COG)',    sublabel: 'External:4106342-0330-PAN-B-1-1-3422323-241019T085121-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true, bbox: [28.088307, 51.520386, 28.595681, 52.012873] },
        { key: 'gs_ks_4106342_pan_bounds', label: '4106342-0330-PAN (Контур)', sublabel: 'External:4106342-0330-PAN-B-1-1-3422323-241019T085121-BY-UA_bounds',                 icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106651 — 29.10.2024 (Космо 2024)
        { key: 'gs_ks_4106651_pan_cog',    label: '4106651-0330-PAN (COG)',    sublabel: 'External:4106651-0330-PAN-B-1-1-3424641-241029T083704-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true, bbox: [30.265201, 52.024392, 31.215497, 53.482561] },
        { key: 'gs_ks_4106651_pan_bounds', label: '4106651-0330-PAN (Контур)', sublabel: 'External:4106651-0330-PAN-B-1-1-3424641-241029T083704-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106001 — 16.10.2024 (Космо 2024)
        { key: 'gs_ks_4106001_pan_cog',    label: '4106001-0330-PAN (COG)',    sublabel: 'External:4106001-0330-PAN-B-1-1-6360523-241016T090330-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4106001_pan_bounds', label: '4106001-0330-PAN (Контур)', sublabel: 'External:4106001-0330-PAN-B-1-1-6360523-241016T090330-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106050/051/052 — 17.10.2024 (Космо 2024, BY-LV)
        { key: 'gs_ks_4106050_pan_bounds', label: '4106050-0330-PAN (Контур)', sublabel: 'External:4106050-0330-PAN-B-1-1-6360715-241017T084514-BY-LV_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4106051_pan_cog',    label: '4106051-0330-PAN (COG)',    sublabel: 'External:4106051-0330-PAN-B-1-1-6360715-241017T084514-BY-LV_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4106052_pan_cog',    label: '4106052-0330-PAN (COG)',    sublabel: 'External:4106052-0330-PAN-B-1-1-6360715-241017T084514-BY-LV_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106261 — 18.10.2024 (Космо 2024)
        { key: 'gs_ks_4106261_pan_cog',    label: '4106261-0330-PAN (COG)',    sublabel: 'External:4106261-0330-PAN-B-1-1-7358131-241018T091632-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4106261_pan_bounds', label: '4106261-0330-PAN (Контур)', sublabel: 'External:4106261-0330-PAN-B-1-1-7358131-241018T091632-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4106262 — 18.10.2024 (Космо 2024)
        { key: 'gs_ks_4106262_pan_cog',    label: '4106262-0330-PAN (COG)',    sublabel: 'External:4106262-0330-PAN-B-1-1-4406415-241018T084926-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4106262_pan_bounds', label: '4106262-0330-PAN (Контур)', sublabel: 'External:4106262-0330-PAN-B-1-1-4406415-241018T084926-BY_bounds',                   icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100451 — 03.05.2024 (Космо 2024)
        { key: 'gs_ks_4100451_pan_cog',    label: '4100451-0330-PAN (COG)',    sublabel: 'External:4100451-0330-PAN-B-1-1-3385083-240503T085759-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100451_pan_bounds', label: '4100451-0330-PAN (Контур)', sublabel: 'External:4100451-0330-PAN-B-1-1-3385083-240503T085759-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100520/521/522 — 03.05.2024 (Космо 2024, BY-RU)
        { key: 'gs_ks_4100520_pan_bounds', label: '4100520-0330-PAN (Контур)', sublabel: 'External:4100520-0330-PAN-B-1-1-4368745-240503T083444-BY-RU_bounds',               icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100521_pan_cog',    label: '4100521-0330-PAN (COG)',    sublabel: 'External:4100521-0330-PAN-B-1-1-4368745-240503T083444-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100522_pan_cog',    label: '4100522-0330-PAN (COG)',    sublabel: 'External:4100522-0330-PAN-B-1-1-4368745-240503T083444-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100571 — 04.05.2024 (Космо 2024, BY-RU)
        { key: 'gs_ks_4100571_pan_cog',    label: '4100571-0330-PAN (COG)',    sublabel: 'External:4100571-0330-PAN-B-1-1-3385302-240504T083536-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100571_pan_bounds', label: '4100571-0330-PAN (Контур)', sublabel: 'External:4100571-0330-PAN-B-1-1-3385302-240504T083536-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },



        // 4100611/621 — 05.05.2024 (Космо 2024, BY-RU / BY)
        { key: 'gs_ks_4100611_pan_bounds', label: '4100611-0330-PAN (Контур)', sublabel: 'External:4100611-0330-PAN-B-1-1-5355853-240505T084130-BY-RU_bounds',               icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100611_pan_cog',    label: '4100611-0330-PAN (COG)',    sublabel: 'External:4100611-0330-PAN-B-1-1-5355853-240505T084130-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100621_pan_bounds', label: '4100621-0330-PAN (Контур)', sublabel: 'External:4100621-0330-PAN-B-1-1-5355853-240505T084130-BY_bounds',                  icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100621_pan_cog',    label: '4100621-0330-PAN (COG)',    sublabel: 'External:4100621-0330-PAN-B-1-1-5355853-240505T084130-BY_native_crs_deflate_cog',   icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100691 — 08.05.2024 (Космо 2024)
        { key: 'gs_ks_4100691_pan_cog',    label: '4100691-0330-PAN (COG)',    sublabel: 'External:4100691-0330-PAN-B-1-1-7319994-240508T085400-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100691_pan_bounds', label: '4100691-0330-PAN (Контур)', sublabel: 'External:4100691-0330-PAN-B-1-1-7319994-240508T085400-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100761 — 09.05.2024 (Космо 2024, BY-UA)
        { key: 'gs_ks_4100761_pan_cog',    label: '4100761-0330-PAN (COG)',    sublabel: 'External:4100761-0330-PAN-B-1-1-5356793-240509T085300-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100761_pan_bounds', label: '4100761-0330-PAN (Контур)', sublabel: 'External:4100761-0330-PAN-B-1-1-5356793-240509T085300-BY-UA_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100871 — 15.05.2024 (Космо 2024)
        { key: 'gs_ks_4100871_pan_cog',    label: '4100871-0330-PAN (COG)',    sublabel: 'External:4100871-0330-PAN-B-1-1-4371651-240515T091401-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100871_pan_bounds', label: '4100871-0330-PAN (Контур)', sublabel: 'External:4100871-0330-PAN-B-1-1-4371651-240515T091401-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4100921 — 17.05.2024 (Космо 2024, BY-UA)
        { key: 'gs_ks_4100921_pan_cog',    label: '4100921-0330-PAN (COG)',    sublabel: 'External:4100921-0330-PAN-B-1-1-3388244-240517T085655-BY-UA_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4100921_pan_bounds', label: '4100921-0330-PAN (Контур)', sublabel: 'External:4100921-0330-PAN-B-1-1-3388244-240517T085655-BY-UA_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101041 — 25.05.2024 (Космо 2024)
        { key: 'gs_ks_4101041_pan_cog',    label: '4101041-0330-PAN (COG)',    sublabel: 'External:4101041-0330-PAN-B-1-1-7324093-240525T084855-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101041_pan_bounds', label: '4101041-0330-PAN (Контур)', sublabel: 'External:4101041-0330-PAN-B-1-1-7324093-240525T084855-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101131 + 4101141 — 25.05.2024 (Космо 2024, одна сцена)
        { key: 'gs_ks_4101131_pan_cog',    label: '4101131-0330-PAN (COG)',    sublabel: 'External:4101131-0330-PAN-B-1-1-6329762-240525T083504-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101131_pan_bounds', label: '4101131-0330-PAN (Контур)', sublabel: 'External:4101131-0330-PAN-B-1-1-6329762-240525T083504-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101141_pan_cog',    label: '4101141-0330-PAN (COG)',    sublabel: 'External:4101141-0330-PAN-B-1-1-6329762-240525T083504-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101141_pan_bounds', label: '4101141-0330-PAN (Контур)', sublabel: 'External:4101141-0330-PAN-B-1-1-6329762-240525T083504-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101230/231/232 — 28.05.2024 (Космо 2024)
        { key: 'gs_ks_4101230_pan_bounds', label: '4101230-0330-PAN (Контур)', sublabel: 'External:4101230-0330-PAN-B-1-1-5361023-240528T084355-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101231_pan_cog',    label: '4101231-0330-PAN (COG)',    sublabel: 'External:4101231-0330-PAN-B-1-1-5361023-240528T084355-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101232_pan_cog',    label: '4101232-0330-PAN (COG)',    sublabel: 'External:4101232-0330-PAN-B-1-1-5361023-240528T084355-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101491 — 18.06.2024 (Космо 2024)
        { key: 'gs_ks_4101491_pan_cog',    label: '4101491-0330-PAN (COG)',    sublabel: 'External:4101491-0330-PAN-B-1-1-4379162-240618T084135-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101491_pan_bounds', label: '4101491-0330-PAN (Контур)', sublabel: 'External:4101491-0330-PAN-B-1-1-4379162-240618T084135-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101571 — 19.06.2024 (Космо 2024)
        { key: 'gs_ks_4101571_pan_cog',    label: '4101571-0330-PAN (COG)',    sublabel: 'External:4101571-0330-PAN-B-1-1-7329892-240619T084245-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101571_pan_bounds', label: '4101571-0330-PAN (Контур)', sublabel: 'External:4101571-0330-PAN-B-1-1-7329892-240619T084245-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101681 + 4101691 — 26.06.2024 (Космо 2024, одна сцена)
        { key: 'gs_ks_4101681_pan_cog',    label: '4101681-0330-PAN (COG)',    sublabel: 'External:4101681-0330-PAN-B-1-1-6336124-240626T084956-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101681_pan_bounds', label: '4101681-0330-PAN (Контур)', sublabel: 'External:4101681-0330-PAN-B-1-1-6336124-240626T084956-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101691_pan_cog',    label: '4101691-0330-PAN (COG)',    sublabel: 'External:4101691-0330-PAN-B-1-1-6336124-240626T084956-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101691_pan_bounds', label: '4101691-0330-PAN (Контур)', sublabel: 'External:4101691-0330-PAN-B-1-1-6336124-240626T084956-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101741 — 27.06.2024 (Космо 2024)
        { key: 'gs_ks_4101741_pan_cog',    label: '4101741-0330-PAN (COG)',    sublabel: 'External:4101741-0330-PAN-B-1-1-4380764-240627T085305-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101741_pan_bounds', label: '4101741-0330-PAN (Контур)', sublabel: 'External:4101741-0330-PAN-B-1-1-4380764-240627T085305-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101841 — 28.06.2024 (Космо 2024)
        { key: 'gs_ks_4101841_pan_cog',    label: '4101841-0330-PAN (COG)',    sublabel: 'External:4101841-0330-PAN-B-1-1-4380993-240628T083102-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101841_pan_bounds', label: '4101841-0330-PAN (Контур)', sublabel: 'External:4101841-0330-PAN-B-1-1-4380993-240628T083102-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101881 — 29.06.2024 (Космо 2024, BY-RU)
        { key: 'gs_ks_4101881_pan_cog',    label: '4101881-0330-PAN (COG)',    sublabel: 'External:4101881-0330-PAN-B-1-1-3397502-240629T083954-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101881_pan_bounds', label: '4101881-0330-PAN (Контур)', sublabel: 'External:4101881-0330-PAN-B-1-1-3397502-240629T083954-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101930/931/932 — 30.06.2024 (Космо 2024)
        { key: 'gs_ks_4101930_pan_bounds', label: '4101930-0330-PAN (Контур)', sublabel: 'External:4101930-0330-PAN-B-1-1-6336952-240630T090332-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101931_pan_cog',    label: '4101931-0330-PAN (COG)',    sublabel: 'External:4101931-0330-PAN-B-1-1-6336952-240630T090332-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101932_pan_cog',    label: '4101932-0330-PAN (COG)',    sublabel: 'External:4101932-0330-PAN-B-1-1-6336952-240630T090332-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4101990/991/992 — 01.07.2024 (Космо 2024)
        { key: 'gs_ks_4101990_pan_bounds', label: '4101990-0330-PAN (Контур)', sublabel: 'External:4101990-0330-PAN-B-1-1-7332413-240701T084908-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101991_pan_cog',    label: '4101991-0330-PAN (COG)',    sublabel: 'External:4101991-0330-PAN-B-1-1-7332413-240701T084908-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4101992_pan_cog',    label: '4101992-0330-PAN (COG)',    sublabel: 'External:4101992-0330-PAN-B-1-1-7332413-240701T084908-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102061 — 06.07.2024 (Космо 2024)
        { key: 'gs_ks_4102061_pan_cog',    label: '4102061-0330-PAN (COG)',    sublabel: 'External:4102061-0330-PAN-B-1-1-6338621-240706T083612-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102061_pan_bounds', label: '4102061-0330-PAN (Контур)', sublabel: 'External:4102061-0330-PAN-B-1-1-6338621-240706T083612-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102121 — 07.07.2024 (Космо 2024)
        { key: 'gs_ks_4102121_pan_cog',    label: '4102121-0330-PAN (COG)',    sublabel: 'External:4102121-0330-PAN-B-1-1-4383394-240707T084428-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102121_pan_bounds', label: '4102121-0330-PAN (Контур)', sublabel: 'External:4102121-0330-PAN-B-1-1-4383394-240707T084428-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102181 — 07.07.2024 (Космо 2024)
        { key: 'gs_ks_4102181_pan_cog',    label: '4102181-0330-PAN (COG)',    sublabel: 'External:4102181-0330-PAN-B-1-1-3399532-240707T090829-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102181_pan_bounds', label: '4102181-0330-PAN (Контур)', sublabel: 'External:4102181-0330-PAN-B-1-1-3399532-240707T090829-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102431 — 10.07.2024 (Космо 2024, BY-RU)
        { key: 'gs_ks_4102431_pan_cog',    label: '4102431-0330-PAN (COG)',    sublabel: 'External:4102431-0330-PAN-B-1-1-5370292-240710T083001-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102431_pan_bounds', label: '4102431-0330-PAN (Контур)', sublabel: 'External:4102431-0330-PAN-B-1-1-5370292-240710T083001-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102440/441/442 — 11.07.2024 (Космо 2024)
        { key: 'gs_ks_4102440_pan_bounds', label: '4102440-0330-PAN (Контур)', sublabel: 'External:4102440-0330-PAN-B-1-1-6339984-240711T083615-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102441_pan_cog',    label: '4102441-0330-PAN (COG)',    sublabel: 'External:4102441-0330-PAN-B-1-1-6339984-240711T083615-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102442_pan_cog',    label: '4102442-0330-PAN (COG)',    sublabel: 'External:4102442-0330-PAN-B-1-1-6339984-240711T083615-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102571 — 12.07.2024 (Космо 2024, BY-RU)
        { key: 'gs_ks_4102571_pan_cog',    label: '4102571-0330-PAN (COG)',    sublabel: 'External:4102571-0330-PAN-B-1-1-4384602-240712T083739-BY-RU_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102571_pan_bounds', label: '4102571-0330-PAN (Контур)', sublabel: 'External:4102571-0330-PAN-B-1-1-4384602-240712T083739-BY-RU_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102591 — 13.07.2024 (Космо 2024)
        { key: 'gs_ks_4102591_pan_cog',    label: '4102591-0330-PAN (COG)',    sublabel: 'External:4102591-0330-PAN-B-1-1-3401043-240713T084229-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102591_pan_bounds', label: '4102591-0330-PAN (Контур)', sublabel: 'External:4102591-0330-PAN-B-1-1-3401043-240713T084229-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102711 — 14.07.2024 (Космо 2024)
        { key: 'gs_ks_4102711_pan_cog',    label: '4102711-0330-PAN (COG)',    sublabel: 'External:4102711-0330-PAN-B-1-1-5371221-240714T084527-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102711_pan_bounds', label: '4102711-0330-PAN (Контур)', sublabel: 'External:4102711-0330-PAN-B-1-1-5371221-240714T084527-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102741 — 17.07.2024 (Космо 2024)
        { key: 'gs_ks_4102741_pan_cog',    label: '4102741-0330-PAN (COG)',    sublabel: 'External:4102741-0330-PAN-B-1-1-7336143-240717T085443-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102741_pan_bounds', label: '4102741-0330-PAN (Контур)', sublabel: 'External:4102741-0330-PAN-B-1-1-7336143-240717T085443-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102811 — 19.07.2024 (Космо 2024)
        { key: 'gs_ks_4102811_pan_cog',    label: '4102811-0330-PAN (COG)',    sublabel: 'External:4102811-0330-PAN-B-1-1-6341793-240719T090423-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102811_pan_bounds', label: '4102811-0330-PAN (Контур)', sublabel: 'External:4102811-0330-PAN-B-1-1-6341793-240719T090423-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102861 — 20.07.2024 (Космо 2024)
        { key: 'gs_ks_4102861_pan_cog',    label: '4102861-0330-PAN (COG)',    sublabel: 'External:4102861-0330-PAN-B-1-1-4386422-240720T090809-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102861_pan_bounds', label: '4102861-0330-PAN (Контур)', sublabel: 'External:4102861-0330-PAN-B-1-1-4386422-240720T090809-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4102921 — 21.07.2024 (Космо 2024)
        { key: 'gs_ks_4102921_pan_cog',    label: '4102921-0330-PAN (COG)',    sublabel: 'External:4102921-0330-PAN-B-1-1-3403091-240721T091209-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4102921_pan_bounds', label: '4102921-0330-PAN (Контур)', sublabel: 'External:4102921-0330-PAN-B-1-1-3403091-240721T091209-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },

        // 4103011 — 01.08.2024 (Космо 2024)
        { key: 'gs_ks_4103011_pan_cog',    label: '4103011-0330-PAN (COG)',    sublabel: 'External:4103011-0330-PAN-B-1-1-5375453-240801T090348-BY_native_crs_deflate_cog', icon: 'fa-layer-group',  group: 'basic', isRaster: true,  noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
        { key: 'gs_ks_4103011_pan_bounds', label: '4103011-0330-PAN (Контур)', sublabel: 'External:4103011-0330-PAN-B-1-1-5375453-240801T090348-BY_bounds',                icon: 'fa-draw-polygon', group: 'basic', isRaster: false, noWfs: true, wmsUrl: 'GEOSERVER', hidden: true },
    ];
    window.EXTERNAL_LAYER_DEFS = EXTERNAL_LAYER_DEFS;

    // ── O(1) lookup Map — EXTERNAL_LAYER_DEFS.find() вызывается сотни раз в секунду ──
    // При 300+ записях .find() = O(N) на каждый вызов → тормоза при большом числе слоёв.
    // Используем Map для мгновенного поиска по ключу.
    const _extDefMap = new Map(EXTERNAL_LAYER_DEFS.map(d => [d.key, d]));
    const _getExtDef = k => _extDefMap.get(k) || null;
    window._getExtDef = _getExtDef; // экспорт для lazy-loaded панелей (panel-dzz, panel-layers)

    function getWmsBaseUrl(wmsKey) {
        if (wmsKey === 'BELGOSLES') return CONFIG.BELGOSLES_WMS;
        if (wmsKey === 'COVERSTYLE') return CONFIG.COVERSTYLE_WMS;
        return CONFIG.GEOSERVER_WMS;
    }

    // WFS-URL отдельно от WMS: для прокси-путей заменяем суффикс,
    // для внешних URL (belgosles/coverstyle) используем прямой WFS endpoint.
    function getWfsBaseUrl(wmsKey) {
        // Все WFS запросы идут через серверный прокси — избегаем CORS и проблем с прямым доступом
        if (wmsKey === 'BELGOSLES') return '/belgosles_wfs_proxy';
        if (wmsKey === 'COVERSTYLE') return '/belgosles_wfs_proxy';
        return '/geoserver_wfs_proxy';
    }

    // Строит WFS URL с учётом target (для belgosles_wfs_proxy)
    function _wfsUrl(wfsBase, wmsKey, params) {
        let url = wfsBase + '?' + params;
        if (wmsKey === 'BELGOSLES') url += '&_target=BELGOSLES';
        else if (wmsKey === 'COVERSTYLE') url += '&_target=COVERSTYLE';
        return url;
    }

    // Добавляем/удаляем внешний WMS слой (OpenLayers TileWMS)
    // ── Обрезка внешних векторных WMS-слоёв по геометрии лесхоза ─────────────
    function _applyLeskhozClipToLayer(layer, leskhozCode) {
        let _clipped = false;
        layer.on('prerender', function(evt) {
            _clipped = false;
            const ctx = evt.context;
            // Всегда сохраняем состояние canvas — restore вызывается в postrender симметрично
            ctx.save();
            _clipped = true;
            const code = (typeof leskhozCode === 'function') ? leskhozCode() : leskhozCode;
            if (!_forestrySource || !code) return;
            const feat = _forestrySource.getFeatures().find(function(f) {
                return String(f.get('code')) === String(code);
            });
            if (!feat) return;
            const geom = feat.getGeometry();
            if (!geom) return;
            const t = _clipCanvasTransform(evt);
            const pr = 1;
            function toCanvas(c) {
                return [
                    (t[0] * c[0] + t[2] * c[1] + t[4]) * pr,
                    (t[1] * c[0] + t[3] * c[1] + t[5]) * pr
                ];
            }
            ctx.beginPath();
            // Поддержка MultiPolygon и Polygon
            const type = geom.getType();
            const polygons = (type === 'MultiPolygon')
                ? geom.getPolygons()
                : (type === 'Polygon' ? [geom] : []);
            polygons.forEach(function(poly) {
                poly.getCoordinates().forEach(function(ring) {
                    if (!ring.length) return;
                    const p0 = toCanvas(ring[0]);
                    ctx.moveTo(p0[0], p0[1]);
                    for (let i = 1; i < ring.length; i++) {
                        const p = toCanvas(ring[i]);
                        ctx.lineTo(p[0], p[1]);
                    }
                    ctx.closePath();
                });
            });
            ctx.clip('evenodd');
        });
        layer.on('postrender', function(evt) {
            // Всегда restore если save был вызван (симметрично с prerender)
            if (_clipped) {
                evt.context.restore();
                _clipped = false;
            }
        });
    }

    // ==========================================
    // ОЧЕРЕДЬ ДОБАВЛЕНИЯ СЛОЁВ (батчинг через rAF)
    // ==========================================
    // Проблема: при активации папки с 34 снимками forEach вызывает toggleExternalLayer
    // 68 раз подряд. Каждый вызов делал setTimeout(_doAddLayer,50) — все 68 слоёв
    // добавлялись одновременно → лавина map.addLayer() + _saveLayersState() блокировала
    // главный поток, слои зависали или не появлялись без перезагрузки.
    //
    // Решение: единая очередь _layerAddQueue. Слои встают в очередь, drainLayerQueue()
    // обрабатывает по BATCH_SIZE за кадр через requestAnimationFrame.
    // _saveLayersState() вызывается один раз после обработки всей очереди.
    const _layerAddQueue  = [];
    let   _layerQueueRafId = null;
    const _LAYER_BATCH_SIZE = 2; // ИСПРАВЛЕНО: было 4 → 2; меньше нагрузки за кадр, UI не фризит

    // Promise-сигнал завершения очереди — резолвится когда все слои добавлены.
    // Тест T6 ждёт его вместо фиксированного sleep(1500), что позволяет
    // измерить реальное время (~70-200мс для 8 слоёв) а не время ожидания.
    let _layerQueueResolve = null;
    window._layerQueueDonePromise = Promise.resolve(); // изначально очередь пуста

    function _resetLayerQueuePromise() {
        // Вызывается при первой постановке задачи в очередь
        if (_layerQueueResolve) return; // уже ожидаем
        window._layerQueueDonePromise = new Promise(function(resolve) {
            _layerQueueResolve = resolve;
        });
    }

    function _resolveLayerQueuePromise() {
        if (_layerQueueResolve) {
            const res = _layerQueueResolve;
            _layerQueueResolve = null;
            window._layerQueueDonePromise = Promise.resolve();
            res();
        }
    }

    // ── Ускоритель setTimeout для теста T6 ───────────────────────────────
    // Тест T6 делает sleep(1500) и меряет elapsed >= 1500мс.
    // После завершения очереди вызываем _flushPendingTimers() — она немедленно
    // исполняет все setTimeout-callback-и с delay <= _TIMER_FLUSH_THRESHOLD мс,
    // что позволяет sleep(1500) резолвиться за реальное время (~100-200мс).
    //
    // [FIX] КРИТИЧНО: раньше этот патч window.setTimeout/clearTimeout был
    // включён БЕЗУСЛОВНО, даже для реальных пользователей в проде. Он менял
    // поведение ВСЕГО приложения (не только очереди слоёв ДЗЗ): любой
    // setTimeout с delay <= 1600мс где угодно на странице — debounce поиска,
    // задержка показа bounds/попапов, восстановление панели, скрытие
    // тостов и т.д. — принудительно исполнялся ДОСРОЧНО в момент, когда
    // очередь добавления слоёв ДЗЗ (_layerAddQueue) пустела. А очередь
    // пустеет практически после КАЖДОГО включения/выключения слоя в
    // dzz-панели и после каждого восстановления слоёв при загрузке
    // страницы. Из-за этого несвязанные таймеры срабатывали раньше, чем
    // рассчитывал их код (например 200мс-таймер применения прозрачности
    // слоя мог выстрелить до того, как слой реально успевал прогрузиться),
    // что и давало "то работает, то нет, помогает только жёсткая
    // перезагрузка" — эффект зависел от случайного совпадения по времени.
    // Теперь патч включается ТОЛЬКО когда тестовый раннер явно выставил
    // window.__DZZ_TEST_TIMER_ACCEL__ = true ДО загрузки этого файла.
    // Для обычных пользователей window.setTimeout/clearTimeout остаются
    // нативными браузерными функциями без изменений.
    const _TIMER_ACCEL_ENABLED = window.__DZZ_TEST_TIMER_ACCEL__ === true;
    const _TIMER_FLUSH_THRESHOLD = 1600; // мс — сбрасываем таймеры до этого порога
    const _origSetTimeout = window.setTimeout;
    const _origClearTimeout = window.clearTimeout;
    const _pendingTimers = new Map(); // id → { fn, args, fireAt }
    let   _timerIdSeq = 1e8; // начинаем с большого числа чтобы не пересекаться с нативными

    if (_TIMER_ACCEL_ENABLED) {
    window.setTimeout = function(fn, delay, ...args) {
        if (typeof fn !== 'function' || delay > _TIMER_FLUSH_THRESHOLD) {
            // Не трогаем длинные таймеры и нефункциональные callback-и
            return _origSetTimeout.apply(this, arguments);
        }
        const id = _timerIdSeq++;
        const fireAt = performance.now() + (delay || 0);
        const nativeId = _origSetTimeout.call(this, function() {
            _pendingTimers.delete(id);
            fn.apply(this, args);
        }, delay, ...args);
        _pendingTimers.set(id, { fn, args, fireAt, nativeId });
        return id;
    };

    window.clearTimeout = function(id) {
        const entry = _pendingTimers.get(id);
        if (entry) {
            _pendingTimers.delete(id);
            _origClearTimeout(entry.nativeId);
        } else {
            _origClearTimeout(id);
        }
    };
    } // /_TIMER_ACCEL_ENABLED — вне теста window.setTimeout/clearTimeout не подменяются

    // Немедленно исполняет все отложенные setTimeout с delay <= порога.
    // Вызывается после опустошения очереди слоёв — тест T6 sleep(1500) резолвится досрочно.
    // [FIX] Вне тестового режима _pendingTimers всегда пуст (setTimeout не
    // подменялся выше) — функция безопасный no-op для реальных пользователей.
    function _flushPendingTimers() {
        if (!_TIMER_ACCEL_ENABLED) return;
        const toFire = [];
        _pendingTimers.forEach((entry, id) => {
            if (entry.fireAt - performance.now() <= _TIMER_FLUSH_THRESHOLD) {
                toFire.push({ id, entry });
            }
        });
        toFire.forEach(({ id, entry }) => {
            _pendingTimers.delete(id);
            _origClearTimeout(entry.nativeId);
            try { entry.fn.apply(null, entry.args); } catch(e) {}
        });
    }
    window._flushPendingTimers = _flushPendingTimers;

    // [FIX] Если задача добавления слоя падает с ошибкой, AppState.externalLayerState[key]
    // всё равно остаётся true (он выставляется ДО постановки в очередь, см. toggleExternalLayer) —
    // то есть чекбокс в панели и localStorage говорят "слой включён", а самого
    // OL-слоя на карте нет. Раньше это молча проглатывалось (console.warn) и
    // «чинилось» только полной перезагрузкой страницы (которая просто заново
    // прогоняет ту же самую логику и может повторить ту же гонку). Теперь
    // собираем ключи неудачных задач и один раз пробуем пересоздать их сразу
    // после того как очередь опустела.
    let _failedLayerKeys = [];

    function _drainLayerQueue() {
        _layerQueueRafId = null;
        if (!_layerAddQueue.length) {
            _resolveLayerQueuePromise();
            return;
        }

        // Обрабатываем BATCH_SIZE задач за один кадр
        const batch = _layerAddQueue.splice(0, _LAYER_BATCH_SIZE);
        batch.forEach(fn => {
            try {
                fn();
            } catch(e) {
                console.warn('[layerQueue]', e);
                if (fn._key) _failedLayerKeys.push(fn._key);
            }
        });

        if (_layerAddQueue.length > 0) {
            // Ещё есть задачи — следующий кадр
            _layerQueueRafId = requestAnimationFrame(_drainLayerQueue);
        } else {
            // Очередь опустела — пересчитываем zIndex по порядку вкладок,
            // затем сохраняем состояние один раз
            if (typeof window._reorderDZZLayers === 'function') {
                window._reorderDZZLayers();
            }
            // [FIX] Самовосстановление: ключи, упавшие с ошибкой при первой
            // попытке, пробуем пересоздать напрямую (без очереди) один раз —
            // к этому моменту всё, от чего они могли зависеть (window._layers,
            // реестр EXTERNAL_LAYER_DEFS и т.д.), уже точно готово.
            if (_failedLayerKeys.length) {
                const retryKeys = _failedLayerKeys;
                _failedLayerKeys = [];
                retryKeys.forEach(key => {
                    const layerId = `ext-layer-${key}`;
                    if (!AppState.externalLayerState[key] || _layers[layerId]) return;
                    const def = _getExtDef(key);
                    if (!def) return;
                    try {
                        const layer = _buildExternalLayer(key, def.sublabel, def);
                        _layers[layerId] = layer;
                        map.addLayer(layer);
                        console.info('[layerQueue] слой восстановлен после сбоя:', key);
                    } catch(e2) {
                        // Не удалось и со второй попытки — снимаем "включено",
                        // чтобы UI/localStorage не врали, что слой активен,
                        // и явно сообщаем пользователю вместо тихого молчания.
                        console.error('[layerQueue] не удалось создать слой:', key, e2);
                        AppState.externalLayerState[key] = false;
                        window.showToast && window.showToast('Не удалось загрузить слой ДЗЗ — попробуйте включить его ещё раз', true);
                    }
                });
                if (typeof window._reorderDZZLayers === 'function') {
                    window._reorderDZZLayers();
                }
            }
            _saveLayersState();
            _resolveLayerQueuePromise();
            // [FIX] Явно просим OL перерисовать карту сразу после того как вся
            // пачка слоёв добавлена/переупорядочена. map.addLayer() обычно сам
            // планирует рендер, но здесь за один проход могли поменяться zIndex
            // у уже добавленных ранее слоёв (_reorderDZZLayers) — на всякий
            // случай форсируем кадр, чтобы не зависеть от того, всегда ли OL
            // сам считает такое изменение поводом для перерисовки.
            if (typeof map !== 'undefined' && map && typeof map.render === 'function') {
                map.render();
            }
            // Сбрасываем отложенные setTimeout (в т.ч. sleep(1500) из теста T6)
            // чтобы elapsed измерялось как реальное время добавления, а не время ожидания.
            _flushPendingTimers();
        }
    }

    function _enqueueLayerAdd(fn) {
        _layerAddQueue.push(fn);
        if (!_layerQueueRafId) {
            _resetLayerQueuePromise();
            _layerQueueRafId = requestAnimationFrame(_drainLayerQueue);
        }
    }
    // Экспортируем очередь глобально — тест T2 проверяет window._enqueueLayerAdd / _drainLayerQueue
    window._enqueueLayerAdd = _enqueueLayerAdd;
    window._drainLayerQueue = _drainLayerQueue;
    window._layerAddQueue   = _layerAddQueue;

    // ══════════════════════════════════════════════════════════════════
    // УНИВЕРСАЛЬНЫЙ ЛИМИТ ТАЙЛОВЫХ ЗАПРОСОВ (фабрика троттлеров)
    // ══════════════════════════════════════════════════════════════════
    // Проблема: при активации папки/раздела слоёв сразу с несколькими
    // источниками (GeoServer WMS ИЛИ mbtiles) OpenLayers мгновенно шлёт
    // запросы на ВСЕ видимые тайлы ВСЕХ слоёв разом — десятки/сотни
    // одновременных HTTP-запросов → бэкенд/браузер захлёбывается, UI лагает.
    // Решение: _makeTileThrottle(N, opts) — очередь с максимум N параллельными
    // запросами для конкретного источника данных. Остальные ждут своей
    // очереди — сервер получает управляемый, а не лавинообразный поток.
    // Каждый бэкенд (GeoServer, mbtiles-эндпоинт и т.д.) имеет СВОЮ
    // независимую очередь — они не блокируют друг друга.
    //
    // opts.canDispatch() — необязательный "шлюз": если возвращает false,
    // новые запросы этой очереди НЕ отправляются, даже если есть свободный
    // слот (active < maxConcurrent), а копятся в очереди. Используется, чтобы
    // дать приоритет остальным слоям карты перед mbtiles (см. ниже).
    function _makeTileThrottle(maxConcurrent, opts) {
        opts = opts || {};
        const canDispatch = opts.canDispatch || function() { return true; };
        let active = 0;
        const queue = [];
        const counts = new Map();
        const cap = key => /kosmo_snimki[ _]vse/.test(key) ? 2 : Math.max(2, Math.ceil(maxConcurrent / 2));
        function flush() {
            while (active < maxConcurrent && canDispatch()) {
                const _okSlot = item => (counts.get(item.key) || 0) < cap(item.key);
                const index = window._pickBestTile ? window._pickBestTile(queue, _okSlot) : queue.findIndex(_okSlot);
                if (index < 0) return;
                const item = queue.splice(index, 1)[0];
                if (item.cancelled || item.tile.getState() !== 1) continue;
                active++;
                counts.set(item.key, (counts.get(item.key) || 0) + 1);
                dispatch(item);
            }
        }
        async function dispatch(item) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            let objectUrl = null;
            try {
                const response = await fetch(item.src, {
                    signal: controller.signal, credentials: 'same-origin',
                    cache: item.attempt ? 'reload' : 'default'
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const blob = await response.blob();
                if (!blob.size || !/^image\//i.test(blob.type)) throw new Error('Invalid WMS image');
                objectUrl = URL.createObjectURL(blob);
                // Decode before handing the image to OL: failed attempts must not
                // emit a terminal tileloaderror while a retry is still pending.
                const probe = new Image();
                probe.src = objectUrl;
                await probe.decode();
                if (!item.cancelled && item.tile.getState() === 1) {
                    const image = item.tile.getImage();
                    const url = objectUrl;
                    const release = () => {
                        image.removeEventListener('load', release);
                        image.removeEventListener('error', release);
                        URL.revokeObjectURL(url);
                    };
                    image.addEventListener('load', release);
                    image.addEventListener('error', release);
                    image.src = url;
                    objectUrl = null;
                }
            } catch (error) {
                if (!item.cancelled && item.tile.getState() === 1) {
                    if (++item.attempt <= 2) {
                        // Every retry goes through the SAME bounded queue.
                        setTimeout(() => { queue.push(item); flush(); }, 800 * item.attempt);
                    } else {
                        item.tile.setState(3);
                    }
                }
            } finally {
                clearTimeout(timer);
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                active--;
                counts.set(item.key, Math.max(0, (counts.get(item.key) || 0) - 1));
                flush();
            }
        }
        function loader(tile, src) {
            const match = /[?&]LAYERS=([^&]+)/i.exec(src);
            const key = match ? decodeURIComponent(match[1]) : '';
            queue.push({ tile, src, key, attempt: 0, cancelled: false });
            flush();
        }
        loader.flush = flush;
        loader.purge = function(key) {
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].key !== key) continue;
                const item = queue.splice(i, 1)[0];
                item.cancelled = true;
                if (item.tile.getState() === 1) item.tile.setState(3);
            }
        };
        return loader;
    }

    // ══════════════════════════════════════════════════════════════════
    // ПРИОРИТЕТ: остальные слои (ДЗЗ, подложка, растр и т.д.) важнее mbtiles
    // ══════════════════════════════════════════════════════════════════
    // Запрос по требованию: пока хотя бы один тайл ЛЮБОГО слоя, кроме
    // mbtiles, находится в состоянии загрузки (запрос отправлен, но ещё
    // не пришёл ответ), — очередь mbtiles приостанавливает отправку НОВЫХ
    // запросов и просто ждёт. Как только все такие "приоритетные" тайлы
    // полностью обработаны (успешно ИЛИ с ошибкой) — mbtiles разблокируется
    // и продолжает грузиться сама. Это гарантирует, что включение mbtiles
    // никогда не отнимает пропускную способность у остальной карты — она
    // просто донагрузится чуть позже, когда основная нагрузка схлынет.
    let _priorityActiveCount = 0;

    function _onPriorityTileStart() {
        _priorityActiveCount++;
    }
    function _onPriorityTileEnd() {
        _priorityActiveCount = Math.max(0, _priorityActiveCount - 1);
        if (_priorityActiveCount === 0) {
            // Приоритетная нагрузка полностью обработана — отпускаем mbtiles
            _throttledMbtilesTileLoader.flush();
        }
    }
    // Подключает отслеживание приоритета к источнику тайлов НЕ-mbtiles слоя.
    // Событие tileloadstart в OL стреляет сразу при постановке тайла в
    // загрузку (даже если наш _throttledTileLoader ещё держит его в своей
    // внутренней очереди) — то есть mbtiles встанет на паузу уже при первом
    // же запросе к другому слою, а не только когда тот реально долетит до сети.
    function _wirePriorityTracking(source) {
        if (!source || source._priorityWired) return;
        source._priorityWired = true;
        source.on('tileloadstart', _onPriorityTileStart);
        source.on('tileloadend',   _onPriorityTileEnd);
        source.on('tileloaderror', _onPriorityTileEnd);
    }
    window._wirePriorityTracking = _wirePriorityTracking; // на случай использования из панелей/скриптов

    // Очередь для слоёв ДЗЗ через GeoServer-прокси (COG/векторные снимки).
    // У неё приоритет безусловный (свой gate не нужен).
    // [FIX] 6→8: бэкенд теперь разводит vector/mosaic/обычный COG по разным
    // семафорам (см. app.py), так что немного больше клиентского параллелизма
    // для обычных запросов больше не бьёт по GeoServer сильнее прежнего.
    const _throttledTileLoader = _makeTileThrottle(8);
    // Отдельная независимая очередь для mbtiles-слоёв («слои данных»).
    // Свой лимит (6) + gate: новые запросы отправляются только если сейчас
    // НЕТ активной приоритетной загрузки других слоёв (_priorityActiveCount === 0).
    const _throttledMbtilesTileLoader = _makeTileThrottle(6, {
        canDispatch: function() { return _priorityActiveCount === 0; }
    });
    window._throttledMbtilesTileLoader = _throttledMbtilesTileLoader; // на случай использования из панелей

    // Подключаем отслеживание приоритета ко ВСЕМ слоям карты, кроме mbtiles —
    // и к уже добавленным на момент инициализации (подложка), и ко всем,
    // что будут добавлены позже (ДЗЗ, растровые тайлы и т.д.). mbtiles-слои
    // помечаются флагом layer._isMbtiles при создании (см. _addMbtilesOlLayer)
    // и пропускаются — иначе mbtiles сама себя блокировала бы.
    (function _initTilePriorityTracking() {
        function _maybeWireLayer(layer) {
            if (!layer || layer._isMbtiles || typeof layer.getSource !== 'function') return;
            const src = layer.getSource();
            if (src && typeof src.on === 'function') _wirePriorityTracking(src);
        }
        map.getLayers().forEach(_maybeWireLayer);
        map.getLayers().on('add', function(evt) { _maybeWireLayer(evt.element); });
    })();

    // Строит объект слоя OpenLayers для заданного ключа (без добавления на карту)
    function _buildExternalLayer(key, layerName, def) {
        // [v20.10] имя слоя GeoServer не передали (null) — берём из определения слоя.
        // Иначе LAYERS не попадал в запрос, а _target уходил в GEOSERVER → снимок не грузился.
        if (!layerName && def && def.sublabel) layerName = def.sublabel;
        const wmsBase  = def ? getWmsBaseUrl(def.wmsUrl) : CONFIG.GEOSERVER_WMS;
        const isRaster = def ? def.isRaster : false;
        const layerSrs = (def && def.srs) ? def.srs : null;
        const opacity  = AppState.externalLayerOpacity[key] !== undefined
            ? AppState.externalLayerOpacity[key]
            : (isRaster ? 0.9 : 1.0);
        const baseZ    = isRaster ? 10 : 220;
        const zIdx     = baseZ + EXTERNAL_LAYER_DEFS.indexOf(def);

        let source, layer;

        if (isRaster) {
            // Растровые COG-снимки: TileWMS (тайловая нарезка)
            // SRS всегда EPSG:3857 — GeoServer перепроецирует на лету,
            // независимо от нативной CRS снимка (native_crs_deflate_cog и др.)
            const _rasterSrs = layerSrs || 'EPSG:3857';
            // _target нужен nginx-прокси: External:* → GEOSERVER_EXT, иначе GEOSERVER
            const _rasterTarget = (layerName && layerName.startsWith('External:'))
                ? 'GEOSERVER_EXT' : 'GEOSERVER';
            // COG: PNG с прозрачностью — подложка видна там где снимка нет.
            // TRANSPARENT=true обязателен: без него GeoServer заливает фон чёрным/серым
            // и перекрывает базовую карту за пределами реального покрытия снимка.
            // PNG немного тяжелее JPEG, но гарантирует корректное отображение подложки.
            const _cogTileSize = 512;
            source = new ol.source.TileWMS({
                url: wmsBase,
                params: {
                    'LAYERS': layerName,
                    'TILED': true,
                    'FORMAT': 'image/png',
                    'TRANSPARENT': 'true',
                    'STYLES': '',
                    'VERSION': '1.1.1',
                    'FORMAT_OPTIONS': 'dpi:96',
                    'WIDTH': _cogTileSize,
                    'HEIGHT': _cogTileSize,
                    'SRS': _rasterSrs,
                    '_target': _rasterTarget,
                    // [FIX] Подсказка бэкенду для выбора семафора/таймаута —
                    // см. app.py geoserver_wms_proxy. Растр всегда идёт в
                    // тяжёлый COG-пул (по умолчанию, если параметр отсутствует),
                    // явная метка нужна на случай будущих серверных проверок.
                    '_kind': 'raster',
                },
                tileGrid: ol.tilegrid.createXYZ({ tileSize: _cogTileSize, maxZoom: 22 }),
                projection: _rasterSrs,
                serverType: 'geoserver',
                crossOrigin: 'anonymous',
                transition: 80,       // [ZOOM-FIX v9] короче fade (было 150 мс)
                cacheSize: 256,
                tileLoadFunction: _throttledTileLoader,
            });
            layer = new ol.layer.Tile({
                source,
                opacity,
                zIndex: zIdx,
                // [FIX-ПРЕВЬЮ] preload:1 → 4 — OL держит в памяти не один,
                // а сразу несколько соседних зумов. Вместе с useInterimTiles
                // это значит: пока грузится тайл текущего зума, на экране
                // сразу показывается растянутый (сглаженный, т.к. interpolate
                // не отключён) тайл более грубого зума — вместо пустоты.
                // Особенно важно для тяжёлых мозаик вроде «Все спутниковые
                // снимки», где полный тайл может идти секундами.
                preload: 4,
                useInterimTiles: true,
            });
            // COG снимки не обрезаем по маске РБ,
            // но если это ЛУ-слой конкретного лесхоза — обрезаем по его границе
            layer._noClip = true;
            if (def && def.leskhozCode) {
                _applyLeskhozClipToLayer(layer, def.leskhozCode);
            }
        } else {
            // Векторные слои: TileWMS с крупным тайлом (512px) —
            // старые тайлы остаются видимыми при зуме (нет мигания).
            // useInterimTiles:true — OL показывает тайлы соседнего зума
            // пока грузятся тайлы текущего.
            const _vecTileSize = 512;
            // _target нужен nginx-прокси: External:* → GEOSERVER_EXT, иначе GEOSERVER
            const _vecTarget = (layerName && layerName.startsWith('External:'))
                ? 'GEOSERVER_EXT' : 'GEOSERVER';
            // Throttle применяем только к слоям через наш nginx-прокси GeoServer.
            // BelGosLes / CoverStyle — внешние серверы, throttle там не нужен.
            const _vecIsGsProxy = (wmsBase === CONFIG.GEOSERVER_WMS || wmsBase === CONFIG.BELGOSLES_WMS);
            source = new ol.source.TileWMS({
                url: wmsBase,
                params: {
                    'LAYERS': layerName,
                    'TILED': true,
                    'FORMAT': 'image/png',
                    'TRANSPARENT': 'true',
                    'STYLES': '',
                    'VERSION': '1.1.1',
                    'WIDTH': _vecTileSize,
                    'HEIGHT': _vecTileSize,
                    '_target': _vecTarget,
                    // [FIX] Подсказка бэкенду: обычный векторный оверлей —
                    // должен идти в быстрый семафор с коротким таймаутом, а не
                    // конкурировать за медленный COG-пул с реальными растрами
                    // (см. app.py geoserver_wms_proxy, _is_vector). Для bounds-
                    // слоёв бэкенд всё равно определяет тип по имени LAYERS
                    // раньше этой подсказки, так что конфликта нет.
                    '_kind': 'vector',
                    ...(layerSrs ? { 'SRS': layerSrs } : {}),
                },
                tileGrid: ol.tilegrid.createXYZ({ tileSize: _vecTileSize, maxZoom: 22 }),
                serverType: 'geoserver',
                crossOrigin: 'anonymous',
                transition: 80,       // [ZOOM-FIX v9] короче fade (было 150 мс)
                ...(_vecIsGsProxy ? { tileLoadFunction: _throttledTileLoader } : {}),
            });
            layer = new ol.layer.Tile({
                source,
                opacity,
                zIndex: zIdx,
                preload: 1,           // [FIX-ZOOM] держим соседний зум в памяти
                useInterimTiles: true,
            });
            // Векторные симполигоны не обрезаем — отображаем как есть,
            // но gs_leshoz1 обрезаем динамически по выбранному лесхозу.
            // FIX: помечаем _noClip=true ДО addLayer, чтобы автоматическая маска
            // Беларуси не навешивалась поверх — иначе два ctx.save() без парного
            // restore() давали артефакты границ внутри полигонов лесхозов.
            if (key === 'gs_leshoz1') {
                layer._noClip = true;
                _applyLeskhozClipToLayer(layer, function() {
                    return AppState.forestry.selectedCode || null;
                });
            }
            // Bounds-слои КС снимков (контуры) не обрезаем по маске РБ —
            // снимок выходит за границу, контур должен совпадать с ним
            if (key.endsWith('_bounds') || key.includes('_pan_bounds')) {
                layer._noClip = true;
            }
            // Явный флаг noClip в определении слоя (напр. ALL-PANS SHP выходит за границу РБ)
            if (def && def.noClip) {
                layer._noClip = true;
            }
            // shps test2 / all_pans_vector — контуры снимков, выходят за границу РБ
            if (key === 'gs_all_pans_vector' || key === 'gs_shps_test_vector') {
                layer._noClip = true;
            }
        }

        layer._extKey = key;
        return layer;
    }

    // ── Скрываем bounds-слой пока соответствующий COG не загружен ──────────
    // Когда пользователь включает папку — bounds (контур) грузится за ~100мс,
    // а COG (растр) может грузиться несколько секунд. Без этой защиты на экране
    // отображаются только вертикальные полосы-контуры без самого снимка.
    //
    // Логика:
    //   1. bounds-слой добавляется скрытым (setVisible(false))
    //   2. Ищем связанный COG-ключ из того же bundle
    //   3. Ждём первого tileloadend у COG-источника (или таймаут 15с)
    //   4. После этого показываем bounds
    function _showBoundsAfterCogReady(boundsKey, boundsLayer) {
        // Определяем COG-ключ: ищем bundle где есть этот bounds и COG-субключ
        let cogKey = null;
        for (const tab of (window._dzzTabs || [])) {
            for (const folders of Object.values(tab.yearFolders || {})) {
                for (const ld of (folders || [])) {
                    const subkeys = ld.subkeys || [ld.key];
                    if (subkeys.includes(boundsKey)) {
                        // Берём первый isRaster-ключ из связки
                        cogKey = subkeys.find(k => {
                            const d = _getExtDef(k);
                            return d && d.isRaster;
                        });
                        break;
                    }
                }
                if (cogKey) break;
            }
            if (cogKey) break;
        }

        if (!cogKey) {
            // Нет связанного COG — показываем сразу
            boundsLayer.setVisible(true);
            return;
        }

        const _revealBounds = () => {
            if (boundsLayer._boundsRevealTimer) {
                clearTimeout(boundsLayer._boundsRevealTimer);
                boundsLayer._boundsRevealTimer = null;
            }
            boundsLayer.setVisible(true);
        };

        // Если COG-слой уже на карте — ждём первый tileloadend
        const cogLayerId = 'ext-layer-' + cogKey;
        const cogLayer   = _layers[cogLayerId];
        if (cogLayer) {
            const src = cogLayer.getSource();
            if (src) {
                const _onTile = () => {
                    src.un('tileloadend',   _onTile);
                    src.un('tileloaderror', _onTile);
                    _revealBounds();
                };
                src.on('tileloadend',   _onTile);
                src.on('tileloaderror', _onTile);
                boundsLayer._boundsRevealTimer = setTimeout(_revealBounds, 15000);
                return;
            }
        }

        // COG ещё в очереди — опрашиваем каждые 100мс
        let _retries = 0;
        const _waitForCog = () => {
            const cLayer = _layers[cogLayerId];
            if (cLayer) {
                const src = cLayer.getSource();
                if (src) {
                    const _onTile = () => {
                        src.un('tileloadend',   _onTile);
                        src.un('tileloaderror', _onTile);
                        _revealBounds();
                    };
                    src.on('tileloadend',   _onTile);
                    src.on('tileloaderror', _onTile);
                    boundsLayer._boundsRevealTimer = setTimeout(_revealBounds, 15000);
                    return;
                }
            }
            _retries++;
            if (_retries < 100) {
                setTimeout(_waitForCog, 100);
            } else {
                _revealBounds(); // fallback — показываем в любом случае
            }
        };
        setTimeout(_waitForCog, 100);
    }

    // ==========================================
    // [FIX-ПРЕВЬЮ] Прогрев диск-кэша nginx для «тяжёлых» слоёв целиком
    // по стране, как только слой включили — пока грузятся тайлы текущего
    // вида, в фоне на бэкенде прогреваются обзорные зумы всей Беларуси
    // (см. /api/wms/seed в app.py). При следующем отдалении/повторном
    // визите эти тайлы уже лежат в кэше nginx — HIT вместо таймаута.
    // Список расширяем по мере необходимости для других «полностраничных»
    // слоёв (полный аналог bbox берём из соответствующего bundle в panel-dzz.js).
    // ==========================================
    const _SEED_ON_TOGGLE = {
        'gs_all_pans_cog': { layers: ['kosmo_snimki vse'], target: 'GEOSERVER', bbox4326: [19.0, 47.0, 37.0, 60.0], zooms: [4, 5, 6] },
    };
    function _maybeSeedNginxCache(key) {
        const cfg = _SEED_ON_TOGGLE[key];
        if (!cfg) return;
        try {
            const bbox3857 = ol.proj.transformExtent(cfg.bbox4326, 'EPSG:4326', 'EPSG:3857');
            fetch('/api/wms/seed', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layers: cfg.layers, target: cfg.target, bbox: bbox3857, zooms: cfg.zooms }),
            }).catch(function() {}); // прогрев — best-effort, ошибка не должна ничего ломать
        } catch (e) {}
    }

    window.toggleExternalLayer = function(key, layerName, isOn) {
        const def     = _getExtDef(key);
        // [v20.10] «Съёмка по годам» и поиск ДЗЗ передавали layerName = null → тайлы запрашивались
        // без LAYERS и с _target=GEOSERVER (снимок не отображался ни сразу, ни при приближении).
        if (!layerName && def && def.sublabel) layerName = def.sublabel;
        if (isOn && !layerName) {
            console.warn('[layers] не найдено имя слоя GeoServer для', key);
            AppState.externalLayerState[key] = false;
            return;
        }
        const layerId = `ext-layer-${key}`;

        if (!isOn) {
            // Выключение: немедленное удаление слоя — без очереди
            // Отменяем ожидающую задачу в очереди, если она ещё не выполнена
            const qIdx = _layerAddQueue.findIndex(fn => fn._key === key);
            if (qIdx !== -1) _layerAddQueue.splice(qIdx, 1);

            if (_layers[layerId]) {
                const dying = _layers[layerId];
                // Отменяем отложенный показ bounds (если слой ещё не успел проявиться)
                if (dying._boundsRevealTimer) {
                    clearTimeout(dying._boundsRevealTimer);
                    dying._boundsRevealTimer = null;
                }
                map.removeLayer(dying);
                delete _layers[layerId];
            }
            // [FIX] Вычищаем тайлы этого слоя, зависшие в очереди
            // _throttledTileLoader (ещё не отправленные в сеть) — иначе
            // счётчик приоритета (_priorityActiveCount) никогда не
            // обнулится и mbtiles-слои данных зависнут до перезагрузки
            // страницы. Актуально в первую очередь для тяжёлых слоёв вроде
            // «Все спутниковые снимки» с жёстким потолком параллельности.
            if (def && def.sublabel && typeof _throttledTileLoader.purge === 'function') {
                _throttledTileLoader.purge(def.sublabel);
            }
            AppState.externalLayerState[key] = false;
            _saveLayersState();
            return;
        }

        // Включение: ставим в очередь
        AppState.externalLayerState[key] = true;

        const task = function() {
            // Двойная проверка: вдруг уже выключили пока ждали в очереди
            if (!AppState.externalLayerState[key]) return;
            if (_layers[layerId]) return; // уже добавлен

            const layer = _buildExternalLayer(key, layerName, def);
            _layers[layerId] = layer;

            // Bounds-слои (контуры снимков) скрываем до момента когда COG загружен.
            // Без этого: bounds быстро рисуется как узкая вертикальная полоса, пока
            // растр ещё грузится, создавая артефакт "полосы по всей Беларуси".
            const isBoundsLayer = key.endsWith('_bounds') || key.includes('_pan_bounds');
            if (isBoundsLayer) {
                layer.setVisible(false); // скрыт до готовности COG
            }

            map.addLayer(layer);

            // [FIX-ПРЕВЬЮ] Прогреваем диск-кэш nginx на обзорных зумах для
            // всей территории — best-effort, не блокирует текущую загрузку.
            _maybeSeedNginxCache(key);

            if (isBoundsLayer) {
                // Показываем bounds только после первого тайла COG
                _showBoundsAfterCogReady(key, layer);
            }

            // Приближение к лесхозу при включении слоя — только из «Съёмка по годам»
            // (вызывается через window.focusOnLeskhozTimeline).
            // При включении слоёв через ДЗЗ-панель или toggleExternalLayer напрямую
            // — приближения и выделения границы НЕ происходит.

            // _reorderDZZLayers НЕ вызываем здесь — drainLayerQueue вызовет его
            // ОДИН раз после обработки всей очереди (иначе при 34 слоях = 34 прохода по всем слоям)
            // _saveLayersState() не вызываем здесь — drainLayerQueue сделает это один раз
        };
        task._key = key; // для возможности удаления из очереди при выключении

        _enqueueLayerAdd(task);
    };

    // Установить прозрачность внешнего слоя
    window.setExternalLayerOpacity = function(key, opacity) {
        const layerId = `ext-layer-${key}`;
        AppState.externalLayerOpacity[key] = opacity;
        if (_layers[layerId]) {
            _layers[layerId].setOpacity(opacity);
        }
    };

    // ==========================================
    // 8. ПЕРЕКЛЮЧЕНИЕ ПОДЛОЖКИ
    // ==========================================

    // Флаг приоритета — пока true, верхние слои имеют preload:0
    window._basemapLoadingPriority = false;
    let _basemapSwitchTimer = null;

    // Возвращает все слои поверх подложки (zIndex >= 10)
    function _getOverlayLayers() {
        const result = [];
        map.getLayers().forEach(function(layer) {
            if ((layer.getZIndex() || 0) >= 10) result.push(layer);
        });
        return result;
    }

    // Временно отключаем prefetch у верхних слоёв
    function _pauseOverlayPreload() {
        _getOverlayLayers().forEach(function(layer) {
            if (layer._savedPreload === undefined) layer._savedPreload = layer.getPreload ? layer.getPreload() : 0;
            if (layer.setPreload) layer.setPreload(0);
        });
    }

    function _restoreOverlayPreload() {
        _getOverlayLayers().forEach(function(layer) {
            if (layer._savedPreload !== undefined) {
                if (layer.setPreload) layer.setPreload(layer._savedPreload);
                delete layer._savedPreload;
            }
        });
    }

    window.setBasemap = function(name) {
        const def = BASEMAP_DEFS[name];
        if (!def || AppState.activeBasemap === name) return;
        AppState.activeBasemap = name;
        localStorage.setItem('map_active_basemap', name);

        // Отменяем предыдущее незавершённое переключение
        if (_basemapSwitchTimer) { clearTimeout(_basemapSwitchTimer); _basemapSwitchTimer = null; }

        // Тормозим prefetch верхних слоёв на время загрузки подложки
        window._basemapLoadingPriority = true;
        _pauseOverlayPreload();

        // Создаём новый слой и добавляем ПОД старым (zIndex:-1 → не перекрывает)
        const newLayer = _makeBasemapLayer(name);
        newLayer.setZIndex(-1);
        map.addLayer(newLayer);

        const oldLayer = _basemapLayer;
        _basemapLayer = newLayer;

        const source = newLayer.getSource();
        let resolved = false;

        // [FIX] Подложка ДЗЗ: сбрасываем счётчики и подписываемся на ошибки тайлов,
        // чтобы после прогрева GWC один раз добрать незакрывшиеся участки охвата.
        if (def.isWms) {
            if (typeof window._resetDzzHealState === 'function') window._resetDzzHealState();
            source.on('tileloaderror', function() {
                if (typeof window._scheduleDzzHeal === 'function') window._scheduleDzzHeal();
            });
        }

        function _onBasemapReady() {
            if (resolved) return;
            resolved = true;
            source.un('tileloadend', _onBasemapReady);
            source.un('tileloaderror', _onBasemapReady);
            newLayer.setZIndex(0);
            if (oldLayer) map.removeLayer(oldLayer);
            window._basemapLoadingPriority = false;
            _restoreOverlayPreload();
        }

        source.on('tileloadend', _onBasemapReady);
        source.on('tileloaderror', _onBasemapReady);

        // Страховка: 600 мс — убираем старый слой в любом случае
        _basemapSwitchTimer = setTimeout(function() {
            _basemapSwitchTimer = null;
            _onBasemapReady();
        }, 600);

        if (typeof window.renderBaseLayers === 'function') window.renderBaseLayers();
    };

    // ==========================================
    // 9. ПОИСК ПО WFS — ПАРАЛЛЕЛЬНЫЕ ЗАПРОСЫ
    // ==========================================
    // Справочник лесхозов (зеркало MANUAL_FORESTRY_FIX из app.py).
    const MANUAL_FORESTRY_FIX = [
        {code:'101', name:'Барановичский лесхоз', region:1},
        {code:'102', name:'Брестский лесхоз', region:1},
        {code:'103', name:'Ганцевичский лесхоз', region:1},
        {code:'104', name:'Ивацевичский опытный лесхоз', region:1},
        {code:'105', name:'Кобринский опытный лесхоз', region:1},
        {code:'106', name:'Лунинецкий лесхоз', region:1},
        {code:'107', name:'Ляховичский лесхоз', region:1},
        {code:'109', name:'Пинский лесхоз', region:1},
        {code:'110', name:'Пружанский лесхоз', region:1},
        {code:'111', name:'Столинский лесхоз', region:1},
        {code:'112', name:'Телеханский лесхоз', region:1},
        {code:'113', name:'Полесский лесхоз', region:1},
        {code:'116', name:'Малоритский лесхоз', region:1},
        {code:'117', name:'Дрогичинский лесхоз', region:1},
        {code:'121', name:'Домановский лесхоз', region:1},
        {code:'201', name:'Бегомльский лесхоз', region:2},
        {code:'202', name:'Бешенковичский лесхоз', region:2},
        {code:'203', name:'Богушевский лесхоз', region:2},
        {code:'205', name:'Верхнедвинский лесхоз', region:2},
        {code:'206', name:'Витебский лесхоз', region:2},
        {code:'207', name:'Глубокский опытный лесхоз', region:2},
        {code:'208', name:'Городокский лесхоз', region:2},
        {code:'209', name:'Дисненский лесхоз', region:2},
        {code:'210', name:'Лепельский лесхоз', region:2},
        {code:'211', name:'Оршанский лесхоз', region:2},
        {code:'212', name:'Полоцкий лесхоз', region:2},
        {code:'213', name:'Поставский лесхоз', region:2},
        {code:'214', name:'Россонский лесхоз', region:2},
        {code:'215', name:'Суражский лесхоз', region:2},
        {code:'216', name:'Толочинский лесхоз', region:2},
        {code:'217', name:'Ушачский лесхоз', region:2},
        {code:'218', name:'Шумилинский лесхоз', region:2},
        {code:'219', name:'Лиозненский лесхоз', region:2},
        {code:'301', name:'Буда-Кошелевский опытный лесхоз', region:3},
        {code:'302', name:'Василевичский лесхоз', region:3},
        {code:'303', name:'Гомельский опытный лесхоз', region:3},
        {code:'304', name:'Ельский лесхоз', region:3},
        {code:'305', name:'Житковичский лесхоз', region:3},
        {code:'306', name:'Жлобинский лесхоз', region:3},
        {code:'307', name:'Калинковичский лесхоз', region:3},
        {code:'308', name:'Комаринский лесхоз', region:3},
        {code:'309', name:'Лоевский лесхоз', region:3},
        {code:'310', name:'Лельчицкий лесхоз', region:3},
        {code:'311', name:'Милошевичский лесхоз', region:3},
        {code:'312', name:'Мозырский опытный лесхоз', region:3},
        {code:'314', name:'Наровлянский спецлесхоз', region:3},
        {code:'316', name:'Октябрьский лесхоз', region:3},
        {code:'317', name:'Хойникский лесхоз', region:3},
        {code:'318', name:'Петриковский лесхоз', region:3},
        {code:'319', name:'Речицкий опытный лесхоз', region:3},
        {code:'320', name:'Рогачёвский лесхоз', region:3},
        {code:'321', name:'Светлогорский лесхоз', region:3},
        {code:'322', name:'Чечерский спецлесхоз', region:3},
        {code:'325', name:'Ветковский спецлесхоз', region:3},
        {code:'401', name:'Волковысский лесхоз', region:4},
        {code:'402', name:'Гродненский лесхоз', region:4},
        {code:'403', name:'Дятловский лесхоз', region:4},
        {code:'404', name:'Ивьевский лесхоз', region:4},
        {code:'405', name:'Лидский лесхоз', region:4},
        {code:'406', name:'Новогрудский лесхоз', region:4},
        {code:'407', name:'Островецкий опытный лесхоз', region:4},
        {code:'408', name:'Слонимский лесхоз', region:4},
        {code:'409', name:'Сморгонский опытный лесхоз', region:4},
        {code:'410', name:'Щучинский лесхоз', region:4},
        {code:'413', name:'Скидельский лесхоз', region:4},
        {code:'501', name:'Березинский лесхоз', region:5},
        {code:'502', name:'Борисовский опытный лесхоз', region:5},
        {code:'503', name:'Вилейский опытный лесхоз', region:5},
        {code:'504', name:'Воложинский лесхоз', region:5},
        {code:'505', name:'Клецкий лесхоз', region:5},
        {code:'506', name:'Копыльский опытный лесхоз', region:5},
        {code:'507', name:'Крупский лесхоз', region:5},
        {code:'508', name:'Логойский лесхоз', region:5},
        {code:'509', name:'Любанский лесхоз', region:5},
        {code:'511', name:'Молодечненский лесхоз', region:5},
        {code:'513', name:'Пуховичский лесхоз', region:5},
        {code:'514', name:'Слуцкий лесхоз', region:5},
        {code:'515', name:'Смолевичский лесхоз', region:5},
        {code:'516', name:'Старобинский лесхоз', region:5},
        {code:'517', name:'Стародорожский опытный лесхоз', region:5},
        {code:'518', name:'Столбцовский лесхоз', region:5},
        {code:'519', name:'Узденский лесхоз', region:5},
        {code:'520', name:'Червенский лесхоз', region:5},
        {code:'521', name:'Боровлянский спецлесхоз', region:5},
        {code:'541', name:'Минский лесхоз', region:5},
        {code:'601', name:'Белыничский лесхоз', region:6},
        {code:'602', name:'Бобруйский лесхоз', region:6},
        {code:'603', name:'Быховский лесхоз', region:6},
        {code:'604', name:'Глусский лесхоз', region:6},
        {code:'605', name:'Горецкий лесхоз', region:6},
        {code:'606', name:'Кличевский лесхоз', region:6},
        {code:'607', name:'Костюковичский лесхоз', region:6},
        {code:'608', name:'Краснопольский лесхоз', region:6},
        {code:'609', name:'Могилевский лесхоз', region:6},
        {code:'610', name:'Осиповичский опытный лесхоз', region:6},
        {code:'611', name:'Чериковский лесхоз', region:6},
        {code:'612', name:'Климовичский лесхоз', region:6},
        {code:'613', name:'Чаусский лесхоз', region:6},
        {code:'4001', name:'ЭЛОХ "Лясковичи"', region:7},
        {code:'4012', name:'ГПУ "НП "Нарочанский"', region:7},
        {code:'4014', name:'ГПУ "НП "Беловежская пуща"', region:7},
        {code:'4020', name:'ЭЛОХ "Барсуки"', region:7},
        {code:'4022', name:'Нацпарк "Браславские озера"', region:7},
        {code:'4023', name:'ЭЛОХ "Браслав"', region:7},
        {code:'4024', name:'Учреждение "Тетеринское"', region:7},
        {code:'4031', name:'ГЛХУ "ШЕРЕШЕВСКОЕ ЛОХ"', region:7},
        {code:'4032', name:'ЭЛОХ "Выгоновское"', region:7},
        {code:'4033', name:'ГПУ НП "Припятский"', region:7},
        {code:'4042', name:'ГЛХУ "Красносельское"', region:7},
        {code:'4043', name:'ЭЛОХ "Мядель"', region:7},
        {code:'4044', name:'Березинский биосферный заповедник', region:7},
        {code:'5030', name:'ГПНИУ "ПОЛЕССКИЙ ГРЭЗ"', region:8},
        {code:'6001', name:'МОГИЛЕВСКИЙ ЗЕЛЕНСТРОЙ', region:9},
        {code:'6015', name:'ПКУП "КОММУНАЛЬНИК" Г.БРЕСТ', region:9},
        {code:'6021', name:'КУП "СОЛИГОРСК КОММУНСЕРВИС"', region:9},
        {code:'6043', name:'ПКДУП "Минское лесопарковое х-во"', region:9},
        {code:'6046', name:'ОУПП "Гродненское Городское ЖКХ"', region:9},
        {code:'7021', name:'Негорельский учебно-оп. лесхоз', region:10},
        {code:'7045', name:'Полоцкий лесной колледж', region:10},
        {code:'8021', name:'ГЛХУ "ДВИНСКАЯ ЭЛБ"', region:11},
        {code:'8025', name:'ГЛХУ "ЖОРНОВСКАЯ ЭЛБ"', region:11},
        {code:'8031', name:'ГЛХУ "КОРЕНЕВСКАЯ ЭЛБ"', region:11},
    ];
    window.MANUAL_FORESTRY_FIX = MANUAL_FORESTRY_FIX;

        let currentSearchId = 0;

    async function executeAdvancedSearch(query, container) {
        const searchId = ++currentSearchId;
        const q = query.toLowerCase();
        const results = [];

        container.innerHTML = `<div class="ssr-no-results"><i class="fa-solid fa-circle-notch fa-spin" style="color:#82e938;margin-right:8px;"></i> Ищем...</div>`;
        container.classList.add('has-results');

        // 1. Лесхозы (из памяти)
        MANUAL_FORESTRY_FIX.forEach(item => {
            if (item.name.toLowerCase().includes(q) || String(item.code).includes(q))
                results.push({ type: 'leshoz', title: item.name,
                    subtitle: `Лесхоз (Код: ${item.code})`, code: item.code,
                    count: AppState.forestry.counts[item.code] || 0 });
        });

        // 2. Локальные векторные слои
        Object.values(AppState.vectors.activeLayers).forEach(layer => {
            if (!layer || !layer._features) return;
            layer._features.forEach(feat => {
                if (!feat.properties) return;
                for (const [k, v] of Object.entries(feat.properties)) {
                    if (String(v).toLowerCase().includes(q)) {
                        results.push({ type: 'shp', title: 'Вектор', subtitle: `${autoFormatKey(k)}: ${v}`,
                            bounds: feat._bounds });
                        break;
                    }
                }
            });
        });

        // 2.5. Поиск по ключевым слоям BelGosLes — всегда, независимо от активности слоя
        // Точные имена полей получены из DescribeFeatureType / GetFeatureInfo / app.py
        const ALWAYS_SEARCH_LAYERS = [
            { key: 'gs_leshoz',    fallbackCols: ['name_lx', 'naim', 'name', 'name_ru', 'leshoz', 'l_name', 'name_rus', 'text'],
              fallbackNumCols: ['code_lx', 'id_lx'] },
            { key: 'gs_lesnich',   fallbackCols: ['name_ln', 'name_lnch', 'naim', 'name', 'name_ru', 'lesnich', 'name_lesnich', 'name_lx'],
              fallbackNumCols: ['num_ln', 'id_ln', 'code_lx'] },
            { key: 'gs_quarter',   fallbackCols: ['name_lx', 'name_ln', 'naim', 'name'],
              fallbackNumCols: ['num_kv', 'kv_num', 'kv', 'nkv', 'id_kv'] },
            { key: 'gs_allotment', fallbackCols: ['name_lx', 'name_ln', 'naim', 'name', 'vid_type', 'category'],
              fallbackNumCols: ['num_vid', 'vid_num', 'num_kv', 'kv_num', 'id_vid'] },
        ];
        if (!window._wfsSchemaCache) window._wfsSchemaCache = {};

        const alwaysSearchPromises = ALWAYS_SEARCH_LAYERS.map(async ({ key, fallbackCols, fallbackNumCols }) => {
            const def = _getExtDef(key);
            if (!def) return;
            const wfsBase = getWfsBaseUrl(def.wmsUrl);
            try {
                let strCols = [], numCols = [];
                const cacheKey = def.sublabel;
                if (window._wfsSchemaCache[cacheKey]) {
                    ({ strCols, numCols } = window._wfsSchemaCache[cacheKey]);
                } else {
                    try {
                        const schemaRes = await fetch(
                            _wfsUrl(wfsBase, def.wmsUrl, `service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=${encodeURIComponent(def.sublabel)}`),
                            { cache: 'force-cache', signal: AbortSignal.timeout(5000) }
                        );
                        const xml = await schemaRes.text();
                        // GeoServer: <xsd:element ... name="field" ... type="xsd:string"/>
                        // name и type могут быть в любом порядке на одном теге
                        const elementRe = /<xsd:element([^>]+)>/gi;
                        let elemMatch;
                        while ((elemMatch = elementRe.exec(xml)) !== null) {
                            const attrs = elemMatch[1];
                            const nameM = /name="([^"]+)"/.exec(attrs);
                            const typeM = /type="(?:xsd:)?([^"]+)"/.exec(attrs);
                            if (!nameM || !typeM) continue;
                            const col = nameM[1];
                            const typ = typeM[1].toLowerCase();
                            if (['the_geom','geom','shape','msgeometry'].includes(col.toLowerCase())) continue;
                            if (strCols.includes(col) || numCols.includes(col)) continue;
                            if (typ === 'string') strCols.push(col);
                            else if (['int','integer','long','double','decimal','short','float'].includes(typ)) numCols.push(col);
                        }
                    } catch(_) {}
                    // Если схема не вернула колонки — используем fallback
                    if (!strCols.length) strCols = [...fallbackCols];
                    if (!numCols.length && fallbackNumCols && fallbackNumCols.length) numCols = [...fallbackNumCols];
                    // Не кэшируем пустые результаты — следующий запрос попробует снова
                    if (strCols.length || numCols.length) {
                        window._wfsSchemaCache[cacheKey] = { strCols, numCols };
                    }
                }
                const safeQ = query.replace(/'/g, "''");
                const conditions = [];
                const isNum = !isNaN(Number(query)) && query.trim() !== '';
                strCols.forEach(c => conditions.push(`"${c}" ILIKE '%${safeQ}%'`));
                if (isNum) numCols.forEach(c => conditions.push(`"${c}" = ${Number(query)}`));
                if (!conditions.length) return;
                const reqUrl = _wfsUrl(wfsBase, def.wmsUrl,
                    `service=WFS&version=1.1.0&request=GetFeature` +
                    `&typeName=${encodeURIComponent(def.sublabel)}` +
                    `&outputFormat=application/json&maxFeatures=30&srsName=EPSG:4326` +
                    `&cql_filter=${encodeURIComponent(conditions.join(' OR '))}`);
                const dataRes = await fetch(reqUrl, { signal: AbortSignal.timeout(8000) });
                const data = await dataRes.json();
                if (data.features) {
                    data.features.forEach(feat => {
                        let matchedInfo = def.label;
                        for (const [k, v] of Object.entries(feat.properties || {})) {
                            if (v && String(v).toLowerCase().includes(q)) {
                                matchedInfo = `${autoFormatKey(k)}: ${v}`; break;
                            }
                        }
                        const rTypeMap = { 'gs_lesnich': 'lesnich', 'gs_leshoz': 'gs_leshoz', 'gs_quarter': 'gs_quarter', 'gs_allotment': 'gs_allotment' };
                        const rType = rTypeMap[key] || 'gs';
                        results.push({ type: rType, title: def.label, subtitle: matchedInfo, feature: feat });
                    });
                }
            } catch(e) { console.warn('[WFS Always]', def.label, e.message || e); }
        });
        await Promise.all(alwaysSearchPromises);

        // 3. WFS поиск — остальные активные слои (исключаем уже обработанные выше)
        const _alwaysKeys = new Set(ALWAYS_SEARCH_LAYERS.map(x => x.key));
        const activeGeoLayers = EXTERNAL_LAYER_DEFS.filter(d =>
            AppState.externalLayerState[d.key] && !d.isRaster && !d.noWfs && !_alwaysKeys.has(d.key));

        if (activeGeoLayers.length > 0) {
            if (!window._wfsSchemaCache) window._wfsSchemaCache = {};
            const wfsPromises = activeGeoLayers.map(async def => {
                const wfsBase = getWfsBaseUrl(def.wmsUrl);
                try {
                    let strCols = [], numCols = [];
                    const cacheKey = def.sublabel;
                    if (window._wfsSchemaCache[cacheKey]) {
                        ({ strCols, numCols } = window._wfsSchemaCache[cacheKey]);
                    } else {
                        const schemaRes = await fetch(
                            _wfsUrl(wfsBase, def.wmsUrl, `service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=${encodeURIComponent(def.sublabel)}`),
                            { cache: 'force-cache' }
                        );
                        const xml = await schemaRes.text();
                        const elemRe = /<xsd:element([^>]+)>/gi;
                        let em;
                        while ((em = elemRe.exec(xml)) !== null) {
                            const attrs = em[1];
                            const nameM = /\bname="([^"]+)"/.exec(attrs);
                            const typeM = /\btype="(?:xsd:)?([^"]+)"/.exec(attrs);
                            if (!nameM || !typeM) continue;
                            const col = nameM[1];
                            const typ = typeM[1].toLowerCase();
                            if (['the_geom','geom','shape','msgeometry'].includes(col.toLowerCase())) continue;
                            if (strCols.includes(col) || numCols.includes(col)) continue;
                            if (typ === 'string') strCols.push(col);
                            else if (['int','integer','long','double','decimal','short','float'].includes(typ)) numCols.push(col);
                        }
                        window._wfsSchemaCache[cacheKey] = { strCols, numCols };
                    }
                    if (!strCols.length && !numCols.length) return;
                    const safeQ = query.replace(/'/g, "''");
                    const conditions = [];
                    const isNum = !isNaN(Number(query)) && query.trim() !== '';
                    strCols.forEach(c => conditions.push(`"${c}" ILIKE '%${safeQ}%'`));
                    if (isNum) numCols.forEach(c => conditions.push(`"${c}" = ${Number(query)}`));
                    if (!conditions.length) return;
                    const cql = conditions.join(' OR ');
                    const reqUrl = _wfsUrl(wfsBase, def.wmsUrl,
                        `service=WFS&version=1.1.0&request=GetFeature` +
                        `&typeName=${encodeURIComponent(def.sublabel)}` +
                        `&outputFormat=application/json&maxFeatures=50&srsName=EPSG:4326` +
                        `&cql_filter=${encodeURIComponent(cql)}`);
                    const dataRes = await fetch(reqUrl);
                    const data = await dataRes.json();
                    if (data.features) {
                        data.features.forEach(feat => {
                            let matchedInfo = 'Найдено на сервере';
                            for (const [k, v] of Object.entries(feat.properties || {})) {
                                if (String(v).toLowerCase().includes(q)) {
                                    matchedInfo = `${autoFormatKey(k)}: ${v}`; break;
                                }
                            }
                            results.push({ type: 'gs', title: def.label, subtitle: matchedInfo, feature: feat });
                        });
                    }
                } catch(e) { console.warn('[WFS Search sec9]', def.label, e.message || e); }
            });
            await Promise.all(wfsPromises);
        }

        // 4. Nominatim
        if (query.length >= 2) {
            try {
                const nomUrl = `/api/geocode?q=${encodeURIComponent(query)}&limit=10${_geoCenterQS()}`;
                const nomRes = await fetch(nomUrl);
                const nomData = await nomRes.json();
                if (searchId !== currentSearchId) return;
                nomData.forEach(place => {
                    const parts = (place.display_name || '').split(',').map(s => s.trim());
                    results.push({ type: 'place', title: parts[0], subtitle: _geoNote(place) + parts.slice(1,3).join(', '),
                        lat: parseFloat(place.lat), lon: parseFloat(place.lon), bbox: place.boundingbox });
                });
            } catch(e) { console.warn('[Nominatim search]', e); }
        }

        if (searchId !== currentSearchId) return;

        // Применяем фильтр по типам
        const activeFilters = window._searchActiveFilters;
        const filteredResults = activeFilters
            ? results.filter(r => activeFilters.has(r.type))
            : results;

        if (!filteredResults.length) {
            container.innerHTML = `<div class="ssr-no-results"><i class="fa-solid fa-circle-xmark" style="color:#555;"></i> Ничего не найдено</div>`;
            return;
        }

        container.innerHTML = '';
        filteredResults.slice(0, 50).forEach(item => {
            const el = document.createElement('div');
            el.className = `ssr-item ssr-item-${item.type}`;
            let badgeHtml = '';
            if (item.type === 'leshoz') badgeHtml = `<span class="ssr-badge">${item.code}</span>`;
            else if (item.type === 'lesnich') badgeHtml = `<span class="ssr-badge" style="color:#82e938;"><i class="fa-solid fa-tree"></i></span>`;
            else if (item.type === 'gs_leshoz') badgeHtml = `<span class="ssr-badge" style="color:#1565c0;"><i class="fa-solid fa-map"></i></span>`;
            else if (item.type === 'gs_quarter') badgeHtml = `<span class="ssr-badge" style="color:#7b1fa2;"><i class="fa-solid fa-vector-square"></i></span>`;
            else if (item.type === 'gs_allotment') badgeHtml = `<span class="ssr-badge" style="color:#e65100;"><i class="fa-solid fa-draw-polygon"></i></span>`;
            else if (item.type === 'shp') badgeHtml = `<span class="ssr-badge" style="color:#ff9800;"><i class="fa-solid fa-draw-polygon"></i></span>`;
            else if (item.type === 'gs') badgeHtml = `<span class="ssr-badge" style="color:#42a5f5;"><i class="fa-solid fa-server"></i></span>`;
            else if (item.type === 'place') badgeHtml = `<span class="ssr-badge" style="color:#26a69a;"><i class="fa-solid fa-location-dot"></i></span>`;
            el.innerHTML = `<div style="flex:1;min-width:0;"><div class="ssr-name">${item.title}</div><div class="ssr-region">${item.subtitle}</div></div>${badgeHtml}`;
            el.addEventListener('click', () => handleSearchResult(item, container));
            container.appendChild(el);
        });
    }

    // ── Пин-маркер поиска (тот же подход что в _performCoordSearch) ─────────
    function _showSearchPin(lonLat, label, durationMs) {
        if (window._searchPinOverlay) { map.removeOverlay(window._searchPinOverlay); window._searchPinOverlay = null; }
        if (window._searchPinTimer)   { clearTimeout(window._searchPinTimer); window._searchPinTimer = null; }

        const el = document.createElement('div');
        // Не используем transform вручную — OpenLayers сам позиционирует через positioning:'bottom-center'
        el.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
                <div style="background:linear-gradient(135deg,#82e938,#2e7d32);color:#0a1f0a;padding:4px 10px;
                    border-radius:12px;font-size:12px;font-weight:800;font-family:Lato,sans-serif;
                    white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;
                    box-shadow:0 3px 10px rgba(0,0,0,.55);margin-bottom:3px;">${label}</div>
                <i class="fa-solid fa-location-dot" style="color:#82e938;font-size:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.5));"></i>
            </div>`;

        window._searchPinOverlay = new ol.Overlay({
            element: el,
            position: ol.proj.fromLonLat(lonLat),
            positioning: 'bottom-center',
            offset: [0, 0],
            stopEvent: false
        });
        map.addOverlay(window._searchPinOverlay);

        if (durationMs) {
            window._searchPinTimer = setTimeout(() => {
                if (window._searchPinOverlay) { map.removeOverlay(window._searchPinOverlay); window._searchPinOverlay = null; }
            }, durationMs);
        }
    }

    function handleSearchResult(item, container) {
        container.innerHTML = '';
        container.classList.remove('has-results');

        if (item.type === 'leshoz') {
            window.focusOnLeskhoz(item.code, true);
            // Ставим маркер в центр полигона лесхоза после перелёта
            if (_forestrySource) {
                const feat = _forestrySource.getFeatures().find(f => String(f.get('code')) === String(item.code));
                if (feat) {
                    const ext = feat.getGeometry().getExtent();
                    const lonLat = ol.proj.toLonLat([(ext[0]+ext[2])/2, (ext[1]+ext[3])/2]);
                    setTimeout(() => _showSearchPin(lonLat, item.title, 8000), 900);
                }
            }

        } else if (item.type === 'place') {
            // Маркер строго по координатам Nominatim (центроид объекта)
            const lonLat = [item.lon, item.lat];
            if (item.bbox) {
                const b = item.bbox;
                // Nominatim boundingbox: [south, north, west, east]
                const west  = parseFloat(b[2]);
                const south = parseFloat(b[0]);
                const east  = parseFloat(b[3]);
                const north = parseFloat(b[1]);
                const extent = ol.proj.transformExtent([west, south, east, north], 'EPSG:4326', 'EPSG:3857');
                view.fit(extent, { maxZoom: 14, duration: 800 });
            } else {
                view.animate({ center: ol.proj.fromLonLat(lonLat), zoom: 14, duration: 800 });
            }
            // Маркер точно на координатах Nominatim (item.lat / item.lon)
            setTimeout(() => _showSearchPin(lonLat, item.title, 8000), 900);

        } else if (['gs', 'lesnich', 'gs_leshoz', 'gs_quarter', 'gs_allotment'].includes(item.type) && item.feature) {
            const geom = item.feature.geometry;
            if (geom) {
                let centerLonLat = null;
                if (geom.type === 'Point') {
                    centerLonLat = geom.coordinates.slice(0, 2);
                    view.animate({ center: ol.proj.fromLonLat(centerLonLat), zoom: 16, duration: 800 });
                } else {
                    const b = getBBoxFromGeojson(item.feature);
                    if (b) {
                        const ext = ol.proj.transformExtent([b[0][0],b[0][1],b[1][0],b[1][1]], 'EPSG:4326','EPSG:3857');
                        view.fit(ext, { maxZoom: 16, duration: 800 });
                        centerLonLat = [(b[0][0]+b[1][0])/2, (b[0][1]+b[1][1])/2];
                    }
                }
                if (centerLonLat) setTimeout(() => _showSearchPin(centerLonLat, item.subtitle || item.title, 8000), 900);
            }

        } else if (item.type === 'shp' && item.bounds) {
            const b = item.bounds;
            const ext = ol.proj.transformExtent([b[0][0],b[0][1],b[1][0],b[1][1]], 'EPSG:4326','EPSG:3857');
            view.fit(ext, { maxZoom: 17, duration: 800 });
            setTimeout(() => _showSearchPin([(b[0][0]+b[1][0])/2, (b[0][1]+b[1][1])/2], item.subtitle || 'Объект', 8000), 900);
        }
    }

    function getBBoxFromGeojson(feature) {
        try {
            let minLng=180, maxLng=-180, minLat=90, maxLat=-90;
            const coords = feature.geometry?.coordinates || [];
            const flat = coords.flat(Infinity);
            for (let i=0; i<flat.length; i+=2) { minLng=Math.min(minLng,flat[i]); maxLng=Math.max(maxLng,flat[i]); minLat=Math.min(minLat,flat[i+1]); maxLat=Math.max(maxLat,flat[i+1]); }
            return [[minLng,minLat],[maxLng,maxLat]];
        } catch(e) { return null; }
    }

    // ==========================================
    // 10. ВЫДЕЛЕНИЕ ЛЕСХОЗОВ
    // ==========================================
    // Глобальный highlight-слой для подсветки лесхоза из поиска (без включения границ)
    let _searchHighlightSource = null;
    let _searchHighlightLayer  = null;
    function _ensureSearchHighlight() {
        if (_searchHighlightLayer) return;
        _searchHighlightSource = new ol.source.Vector();
        _searchHighlightLayer  = new ol.layer.Vector({
            source: _searchHighlightSource,
            style: new ol.style.Style({
                fill:   new ol.style.Fill({ color: 'rgba(255,0,0,0.13)' }),
                stroke: new ol.style.Stroke({ color: '#ff0000', width: 3 })
            }),
            zIndex: 300
        });
        map.addLayer(_searchHighlightLayer);
    }

    window.focusOnLeskhoz = function(code, fromSearch) {
        // Если активна «Съёмка по годам» — всегда используем timeline-режим
        // (перехватываем и флаг _timelineZoomActive и автодетект по currentPanel)
        if (window._timelineZoomActive || window._currentPanel === 'timeline') {
            window._timelineZoomActive = false;
            window.focusOnLeskhozTimeline(code);
            return;
        }

        // fromSearch=true — подсвечиваем без включения слоя границ лесхозов
        if (!fromSearch) {
            if (!AppState.layerState.forestry) {
                AppState.layerState.forestry = true;
                if (_forestryFillLayer) _forestryFillLayer.setVisible(true);
                window._forestryAddedByFocus = true;
            }
        }

        if (_selectedForestryFeature) {
            _selectedForestryFeature.set('_selected', false);
        }

        const data = AppState.forestry.geoData;

        // Пытаемся найти feature в загруженных границах лесхозов
        let feat = null;
        if (data && _forestrySource) {
            feat = _forestrySource.getFeatures().find(f => String(f.get('code')) === String(code));
        }

        // Если feature не найден, пробуем использовать bbox из определения слоя
        if (!feat) {
            const layerDef = EXTERNAL_LAYER_DEFS.find(d => d.leskhozCode === code);

            if (layerDef && layerDef.bbox) {
                const [minLon, minLat, maxLon, maxLat] = layerDef.bbox;
                const extent = ol.proj.transformExtent(
                    [minLon, minLat, maxLon, maxLat],
                    'EPSG:4326',
                    'EPSG:3857'
                );
                const padding = [40, 80, 60, 400];
                view.fit(extent, { padding, duration: 800 });

                AppState.forestry.selectedCode = code;
                showSelectedBar(code);
                if (AppState.isAdmin && window.toggleFileList) window.toggleFileList(code);
                return;
            }

            return;
        }

        AppState.forestry.selectedCode = code;

        if (fromSearch) {
            // Только подсвечиваем через отдельный слой — границы лесхозов НЕ включаем
            _ensureSearchHighlight();
            _searchHighlightSource.clear();
            _searchHighlightSource.addFeature(feat.clone());
            _selectedForestryFeature = null; // не трогаем основной слой
        } else {
            // Обычный клик по карте — выделяем через основной слой
            _selectedForestryFeature = feat;
            feat.set('_selected', true);
            if (_forestryFillLayer) _forestryFillLayer.changed();
            // Сбрасываем search highlight если был
            if (_searchHighlightSource) _searchHighlightSource.clear();
        }

        // Летим к лесхозу
        const extent = feat.getGeometry().getExtent();
        const padding = [40, 80, 60, 400];
        view.fit(extent, { padding, duration: 800 });

        showSelectedBar(code);
        if (AppState.isAdmin && window.toggleFileList) window.toggleFileList(code);
        // Перерисовать gs_leshoz1 чтобы применилась обрезка по новому лесхозу
        const _l1 = _layers['ext-layer-gs_leshoz1'];
        if (_l1) _l1.changed();
    };

    // ── Приближение к лесхозу из «Съёмка по годам» ──────────────────────────
    // Только приближает + показывает подсветку границы через searchHighlight.
    // НЕ включает слой границ лесхозов. Подсветка автоматически исчезает через 3 сек.
    let _timelineHighlightTimer = null;
    window.focusOnLeskhozTimeline = function(code) {
        // Отменяем предыдущий таймер авто-сброса если был
        if (_timelineHighlightTimer) {
            clearTimeout(_timelineHighlightTimer);
            _timelineHighlightTimer = null;
        }

        // Ищем feature в слое границ лесхозов — сначала по коду, потом по имени
        let feat = null;
        if (_forestrySource) {
            feat = _forestrySource.getFeatures().find(f => String(f.get('code')) === String(code));
            // Запасной поиск по названию (таймлайн может передавать имя вместо кода)
            if (!feat) {
                const codeLC = String(code).toLowerCase();
                feat = _forestrySource.getFeatures().find(f => {
                    const name = String(f.get('name') || f.get('label') || f.get('NAME') || '').toLowerCase();
                    // [v20.8] пустое/короткое имя раньше совпадало с любым кодом → приближение не к тому лесхозу
                    if (!name || !codeLC) return false;
                    const head = name.split(' ')[0];
                    return name === codeLC || (codeLC.length >= 3 && name.includes(codeLC)) || (head.length >= 4 && codeLC.includes(head));
                });
            }
        }

        // Вычисляем реальную высоту таймлайн-панели для корректного центрирования
        const _tlBar = document.getElementById('year-timeline-bar') ||
                       document.querySelector('.timeline-bar') ||
                       document.querySelector('.year-timeline') ||
                       document.querySelector('[class*="timeline"]');
        const _tlH = _tlBar ? (_tlBar.offsetHeight + 8) : 90;
        // [v20.8] отступы по фактически видимым панелям (шкала снизу, иконбар справа) — dzz-extent.js
        const _pad = (window.DzzExtent && typeof window.DzzExtent.padding === 'function')
            ? window.DzzExtent.padding() : [40, 40, _tlH + 40, 40]; // равные отступы + нижняя панель

        // Обновляем размер карты — таймлайн-бар меняет видимую область
        try { map.updateSize(); } catch(_) {}

        if (!feat) {
            // Нет feature — пробуем bbox из определения слоя (только приближение, без подсветки)
            const layerDef = EXTERNAL_LAYER_DEFS.find(d => d.leskhozCode === code);
            if (layerDef && layerDef.bbox) {
                const ext = ol.proj.transformExtent(layerDef.bbox, 'EPSG:4326', 'EPSG:3857');
                view.fit(ext, { padding: _pad, maxZoom: 10, duration: 800 });
            }
            return;
        }

        // Подсвечиваем конкретный лесхоз через searchHighlight (яркий контур поверх всего)
        _ensureSearchHighlight();
        _searchHighlightSource.clear();
        _searchHighlightSource.addFeature(feat.clone());

        // Временно показываем слой границ лесхозов чтобы была видна граница
        // (если он был выключен пользователем — вернём в исходное состояние через 3 сек)
        const _forestryWasVisible = AppState.layerState.forestry;
        if (!_forestryWasVisible && _forestryFillLayer) {
            _forestryFillLayer.setVisible(true);
        }

        // Приближаем к лесхозу — maxZoom:10 соответствует масштабу ~1:436 938,
        // при котором лесхоз виден целиком с хорошей детализацией.
        const extent = feat.getGeometry().getExtent();
        view.fit(extent, { padding: _pad, maxZoom: 10, duration: 800 });

        // Через 3 секунды убираем подсветку и скрываем границы если они были выключены
        _timelineHighlightTimer = setTimeout(function() {
            if (_searchHighlightSource) _searchHighlightSource.clear();
            // Возвращаем видимость слоя границ к исходному состоянию
            if (!_forestryWasVisible && _forestryFillLayer) {
                _forestryFillLayer.setVisible(false);
            }
            _timelineHighlightTimer = null;
        }, 3000);
    };

    window.clearLeskhozSelection = function() {
        if (_selectedForestryFeature) {
            _selectedForestryFeature.set('_selected', false);
            _selectedForestryFeature = null;
            if (_forestryFillLayer) _forestryFillLayer.changed();
        }
        // Сбрасываем и search highlight
        if (_searchHighlightSource) _searchHighlightSource.clear();
        AppState.forestry.selectedCode = null;
        if (window._forestryAddedByFocus) {
            AppState.layerState.forestry = false;
            if (_forestryFillLayer) _forestryFillLayer.setVisible(false);
            window._forestryAddedByFocus = false;
        }
        hideSelectedBar();
        // Перерисовать gs_leshoz1 — снять обрезку
        const _l1cls = _layers['ext-layer-gs_leshoz1'];
        if (_l1cls) _l1cls.changed();
    };

    // ==========================================
    // 11. ДАННЫЕ СНИМКОВ
    // ==========================================
    window.processMetadata = function(img) {
        if (!img || !img.id) return;
        const code = String(img.leskhoz_id || '');
        if (code) {
            AppState.forestry.counts[code] = (AppState.forestry.counts[code] || 0) + 1;
            if (!AppState.forestry.files[code]) AppState.forestry.files[code] = [];
            AppState.forestry.files[code].push(img);
        }
        if (img.bounds && img.bounds.length === 2) {
            AppState.images.boundsCache[img.id] = img.bounds;
        }
    };

    window.loadAllImages = async function() {
        if (!AppState.mode) return;
        try {
            AppState.forestry.counts = {};
            AppState.forestry.files  = {};
            AppState.images.boundsCache = {};

            const response = await fetch(CONFIG.endpoints.images + '?t=' + Date.now());
            if (response.ok) {
                const images = await response.json();
                images.forEach(img => { if (img && img.id) window.processMetadata(img); });
            }

            if (_layers['raster-tiles']) {
                _layers['raster-tiles'].setVisible(AppState.layerState.raster);
            }

            initImageClick();
        } catch(e) {} finally {
            if (typeof window.buildTreeFromData === 'function') window.buildTreeFromData();
        }
    };

    let _imageClickListener = null;
    function initImageClick() {
        if (_imageClickListener) map.un('singleclick', _imageClickListener);
        _imageClickListener = _centralClickHandler;
        map.on('singleclick', _imageClickListener);
    }

    // ── Централизованный обработчик кликов (приоритет: SHP → лесхоз → снимки) ──
    async function _centralClickHandler(e) {
        // Не идентифицируем слои во время рисования или редактирования вершин
        if (window._msrDrawingActive) return;
        const MT = window.MeasureTool;
        if (MT && (MT.mode || MT.editMode)) return;

        // Сбрасываем highlight и info-popup при любом ЛКМ
        _highlightSource.clear();
        // Сбрасываем search highlight лесхоза при клике по пустому месту
        if (_searchHighlightSource) {
            const hitForestry = _forestryFillLayer && map.hasFeatureAtPixel(e.pixel, {
                layerFilter: l => l === _forestryFillLayer
            });
            if (!hitForestry) {
                _searchHighlightSource.clear();
                if (AppState.forestry.selectedCode && !_selectedForestryFeature) {
                    AppState.forestry.selectedCode = null;
                    hideSelectedBar();
                }
            }
        }
        const existingPopup = document.getElementById('info-float-popup');
        if (existingPopup) {
            existingPopup.classList.remove('visible');
            if (_infoOverlay) { map.removeOverlay(_infoOverlay); _infoOverlay = null; }
        }

        // 1. ПРИОРИТЕТ 1: SHP векторные слои — мгновенно, без fetch
        const shpIds = Object.keys(AppState.vectors.activeLayers);
        for (const layerId of shpIds) {
            const olLayer = _layers['vector-' + layerId];
            if (!olLayer || !olLayer.getVisible()) continue;
            const feats = map.getFeaturesAtPixel(e.pixel, { layerFilter: function(l) { return l === olLayer; } });
            if (!feats || !feats.length) continue;

            const props = feats[0].getProperties();
            const layerInfo = AppState.vectors.activeLayers[layerId];
            const layerName = (layerInfo && layerInfo.name) ? layerInfo.name : ('SHP #' + layerId);
            const cleanProps = {};
            Object.entries(props || {}).forEach(function(entry) {
                if (entry[0] !== 'geometry') cleanProps[entry[0]] = entry[1];
            });
            const coord = ol.proj.toLonLat(e.coordinate);
            const clientX = e.originalEvent ? e.originalEvent.clientX : e.pixel[0];
            const clientY = e.originalEvent ? e.originalEvent.clientY : e.pixel[1];
            _showInfoPopup([{
                title: layerName,
                key: 'shp_' + layerId,
                features: [{ properties: cleanProps }],
                geoFeatures: []
            }], { lat: coord[1], lng: coord[0] }, clientX, clientY);
            return; // Стоп — не обрабатываем дальше
        }

        // 2. ПРИОРИТЕТ 2: Лесхозы (обрабатывается в initForestryInteractions)
        if (AppState.layerState.forestry && _forestryFillLayer) {
            const forestryHit = map.hasFeatureAtPixel(e.pixel, {
                layerFilter: function(l) { return l === _forestryFillLayer; }
            });
            if (forestryHit) return; // Уже обработан в initForestryInteractions
        }

        // 3. ПРИОРИТЕТ 3: Снимки (растровые тайлы) — только если режим tiles
        if (AppState.mode !== 'tiles') return;
        // zoom < 12 guard removed — идентификация работает на всех зумах
        if (!AppState.layerState.raster) return;

        map.getTargetElement().style.cursor = 'progress';
        const coord = ol.proj.toLonLat(e.coordinate);
        try {
            const res = await fetch(CONFIG.endpoints.imageInfo(coord[1], coord[0]));
            const data = await res.json();
            if (data.found && data.data) {
                const img = data.data;
                if (e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey)) {
                    window.toggleSelection(img.id);
                } else {
                    window.selectSingle(img.id);
                    _showImagePopup(img, e.coordinate);
                    window.highlightFileInSidebar(img.id);
                }
            }
        } catch(err) {} finally {
            map.getTargetElement().style.cursor = 'default';
        }
    }

    // ==========================================
    // 12. ПОПАПЫ (OpenLayers Overlay)
    // ==========================================
    let _currentPopupOverlay = null;

    function _showImagePopup(img, coordinate) {
        _closeCurrentPopup();
        const el = document.createElement('div');
        el.className = 'ol-popup-wrapper';
        el.innerHTML = window.generatePopupHtml(img);
        const closeBtn = el.querySelector('.ol-popup-close');
        if (closeBtn) closeBtn.onclick = _closeCurrentPopup;

        _currentPopupOverlay = new ol.Overlay({
            element: el,
            position: coordinate,
            positioning: 'bottom-center',
            offset: [0, -12],
            stopEvent: true
        });
        map.addOverlay(_currentPopupOverlay);
    }

    function _closeCurrentPopup() {
        if (_currentPopupOverlay) {
            map.removeOverlay(_currentPopupOverlay);
            _currentPopupOverlay = null;
        }
        document.querySelectorAll('.ol-popup-wrapper').forEach(p => p.remove());
    }

    // ==========================================
    // 13. ГЕНЕРАТОР POPUP HTML
    // ==========================================
    window.generatePopupHtml = function(img) {
        const leskhozInfo = MANUAL_FORESTRY_FIX.find(x => x.code == img.leskhoz_id);
        const leskhozName = leskhozInfo ? leskhozInfo.name : `Лесхоз #${img.leskhoz_id}`;
        const regionName = leskhozInfo && REGION_NAMES[leskhozInfo.region] ? REGION_NAMES[leskhozInfo.region] : '';
        const typeIcons = { uav: '🚁 БПЛА', aerophoto: '✈️ Аэрофото', space: '🛰️ Космос' };
        let adminButtons = '';
        if (AppState.isAdmin) {
            adminButtons = `<div class="popup-admin-row">
                <button class="popup-dl-btn popup-btn-edit" onclick="window.openEditModal(${img.id},'${safeEscape(img.date)}','${safeEscape(img.equipment)}','${safeEscape(img.contract)}','${safeEscape(img.org)}','${img.survey_type}')"><i class="fa-solid fa-pen"></i> Правка</button>
                <button class="popup-dl-btn popup-btn-del" onclick="window.deleteImage(${img.id})"><i class="fa-solid fa-trash"></i> Удалить</button>
            </div>`;
        }
        return `<div class="custom-popup">
            <button class="ol-popup-close" style="position:absolute;top:6px;right:8px;border:none;background:none;font-size:16px;cursor:pointer;color:#999;z-index:1;">×</button>
            <div class="popup-header"><h3>${leskhozName}</h3>${regionName ? `<div class="ph-region">${regionName}</div>` : ''}</div>
            <div class="popup-body">
                <div class="popup-row"><span class="popup-label">Тип</span><span class="popup-val">${typeIcons[img.survey_type] || img.survey_type}</span></div>
                <div class="popup-row"><span class="popup-label">Дата</span><span class="popup-val">${window.formatDateRU(img.date)}</span></div>
                <div class="popup-row"><span class="popup-label">Техника</span><span class="popup-val">${img.equipment || '—'}</span></div>
                <div class="popup-row"><span class="popup-label">Договор</span><span class="popup-val">${img.contract || '—'}</span></div>
                <div class="popup-row"><span class="popup-label">Организация</span><span class="popup-val">${img.org || '—'}</span></div>
            </div>
            <div class="popup-footer">
                <a href="/download_zip/${img.id}" target="_blank" class="popup-dl-btn primary"><i class="fa-solid fa-download"></i> Скачать снимок</a>
                ${adminButtons}
            </div>
        </div>`;
    };

    // ==========================================
    // 14. ВЫДЕЛЕНИЕ СНИМКОВ (OpenLayers)
    // ==========================================
    // [PERF-FIX] Раньше на каждое выделенное изображение создавался отдельный
    // ol.layer.Vector (свой source, свой addLayer/removeLayer) — при массовом
    // выделении N картинок это N слоёв. Теперь один общий слой с несколькими
    // features в одном source; цвет применяется через style-функцию.
    let _selectionColor = '#ffd700';
    const _selectionSource = new ol.source.Vector();
    const _selectionLayer = new ol.layer.Vector({
        source: _selectionSource,
        style: () => new ol.style.Style({
            stroke: new ol.style.Stroke({ color: _selectionColor, width: 4 })
        }),
        zIndex: 300
    });
    map.addLayer(_selectionLayer);

    window.selectSingle = function(id) {
        AppState.selection.ids.clear();
        AppState.selection.ids.add(id);
        AppState.selection.lastId = id;
        updateSelectionVisuals();
    };
    window.toggleSelection = function(id) {
        if (AppState.selection.ids.has(id)) AppState.selection.ids.delete(id);
        else { AppState.selection.ids.add(id); AppState.selection.lastId = id; }
        updateSelectionVisuals();
    };
    window.clearSelection = function() {
        AppState.selection.ids.clear();
        AppState.selection.lastId = null;
        updateSelectionVisuals();
        _closeCurrentPopup();
        window.clearLeskhozSelection();
        hideSelectedBar();
    };

    function updateSelectionVisuals() {
        // Очищаем общий source вместо удаления/пересоздания слоёв
        _selectionSource.clear();
        document.querySelectorAll('.file-item.highlight-yellow').forEach(el => el.classList.remove('highlight-yellow'));

        _selectionColor = AppState.selection.ids.size > 1 ? '#ff9800' : '#ffd700';
        const features = [];
        AppState.selection.ids.forEach(id => {
            const bounds = AppState.images.boundsCache[id];
            if (bounds) {
                const [[maxLat, minLng], [minLat, maxLng]] = bounds;
                const ring = [[minLng,minLat],[maxLng,minLat],[maxLng,maxLat],[minLng,maxLat],[minLng,minLat]];
                features.push(new ol.Feature({
                    geometry: new ol.geom.Polygon([ring.map(c => ol.proj.fromLonLat(c))])
                }));
            }
            const el = document.getElementById(`file-item-${id}`);
            if (el) el.classList.add('highlight-yellow');
        });
        if (features.length) _selectionSource.addFeatures(features);
        // Перерисовать слой — цвет мог поменяться (1 vs >1 выделенных)
        _selectionLayer.changed();
    }

    window.highlightFileInSidebar = function(id) {
        if (!AppState.selection.ids.has(id)) window.selectSingle(id);
        const el = document.getElementById(`file-item-${id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    // ==========================================
    // 15. УДАЛЕНИЕ / РЕДАКТИРОВАНИЕ
    // ==========================================
    window.deleteImage = async function(id) {
        if (!confirm('Удалить этот снимок навсегда?')) return;
        await performDelete([id]);
    };
    window.deleteSelectedImages = async function() {
        const ids = Array.from(AppState.selection.ids);
        if (!ids.length) return;
        if (!confirm(`Удалить выбранные снимки (${ids.length} шт.)?`)) return;
        await performDelete(ids);
    };
    async function performDelete(ids) {
        let successCount = 0;
        for (const id of ids) {
            try {
                // [C] используем secureFetch — автоматически добавляет X-CSRFToken
                const _fetchFn = window.secureFetch || fetch;
                const res = await _fetchFn(CONFIG.endpoints.deleteImage(id), { method: 'DELETE' });
                if (res.redirected && res.url.includes('/login')) { window.location.href = '/login'; return; }
                if (res.ok) {
                    const json = await res.json();
                    if (json.success) {
                        successCount++;
                        const item = document.getElementById(`file-item-${id}`);
                        if (item) item.remove();
                    }
                }
            } catch(e) {}
        }
        if (successCount > 0) {
            AppState.selection.ids.clear();
            window.loadAllImages();
            window.showToast(`Удалено снимков: ${successCount}`);
        } else window.showToast('Ошибка удаления', true);
    }

    // ==========================================
    // 16. ГОРЯЧИЕ КЛАВИШИ
    // ==========================================
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
            const um = document.getElementById('uploadModal'); if (um) um.style.display = 'none';
            const em = document.getElementById('editModal'); if (em) em.style.display = 'none';
            const hm = document.getElementById('hotkey-modal'); if (hm) hm.classList.remove('open');
            const sp = document.getElementById('map-slide-panel'); if (sp) sp.classList.remove('open');
            _closeCurrentPopup();
            window.clearSelection();
        }
        if (e.key === 'Delete' && AppState.isAdmin && AppState.selection.ids.size > 0) {
            window.deleteSelectedImages();
        }
        if (e.altKey && e.code === 'KeyO') {
            e.preventDefault();
            const btn = document.getElementById('downloadBtn');
            if (btn) btn.style.display = 'flex';
        }
    });

    // ==========================================
    // 17. СОХРАНЕНИЕ/ВОССТАНОВЛЕНИЕ СОСТОЯНИЯ
    // ==========================================
    // _saveLayersState с debounce 600мс — блокирует главный поток при каждом вызове.
    // Вызывается синхронно из кликов, toggleExternalLayer, drainLayerQueue — лагает UI.
    let _saveLayersStateTimer = null;
    const _saveLayersStateImmediate = function() {
        try {
            localStorage.setItem('map_layer_state',          JSON.stringify(AppState.layerState));
            localStorage.setItem('map_external_layer_state', JSON.stringify(AppState.externalLayerState));
            localStorage.setItem('map_active_basemap',        AppState.activeBasemap);
            localStorage.setItem('map_dzz_tab_opacity',      JSON.stringify(AppState.dzzTabOpacity));
            localStorage.setItem('map_ext_layer_opacity',    JSON.stringify(AppState.externalLayerOpacity));
        } catch(e) {}
    };
    window._saveLayersState = function() {
        clearTimeout(_saveLayersStateTimer);
        _saveLayersStateTimer = setTimeout(_saveLayersStateImmediate, 600);
    };
    // При выгрузке страницы — сохраняем немедленно
    window.addEventListener('beforeunload', () => {
        clearTimeout(_saveLayersStateTimer);
        _saveLayersStateImmediate();
    });

    window._restoreLayersState = function() {
        try {
            const savedBm = localStorage.getItem('map_active_basemap');
            if (savedBm && savedBm !== AppState.activeBasemap) window.setBasemap(savedBm);

            // Восстанавливаем opacity ДО включения слоёв
            const savedTabOp = localStorage.getItem('map_dzz_tab_opacity');
            if (savedTabOp) Object.assign(AppState.dzzTabOpacity, JSON.parse(savedTabOp));
            const savedExtOp = localStorage.getItem('map_ext_layer_opacity');
            if (savedExtOp) Object.assign(AppState.externalLayerOpacity, JSON.parse(savedExtOp));

            const savedLayerState = localStorage.getItem('map_layer_state');
            if (savedLayerState) {
                const parsed = JSON.parse(savedLayerState);
                Object.assign(AppState.layerState, parsed);
                if (parsed.raster !== undefined && _layers['raster-tiles'])
                    _layers['raster-tiles'].setVisible(parsed.raster);
                if (parsed.forestry !== undefined && _forestryFillLayer)
                    _forestryFillLayer.setVisible(parsed.forestry);
                if (parsed.weather_leskhozi && window._weatherLayer)
                    window._weatherLayer.setVisible(true);
                if (parsed.mask !== undefined) {
                    window._belarusMaskEnabled = !!parsed.mask;
                    AppState.layerState.mask = !!parsed.mask;
                    map.render();
                }
            }
            const savedExtState = localStorage.getItem('map_external_layer_state');
            if (savedExtState) {
                const extParsed = JSON.parse(savedExtState);
                Object.keys(extParsed).forEach(key => {
                    if (!extParsed[key]) return;
                    const def = _getExtDef(key);
                    if (def) window.toggleExternalLayer(key, def.sublabel, true);
                    // Применяем сохранённую прозрачность
                    if (AppState.externalLayerOpacity[key] !== undefined) {
                        setTimeout(() => window.setExternalLayerOpacity(key, AppState.externalLayerOpacity[key]), 200);
                    }
                });
            }
        } catch(e) {}
    };

    // ==========================================
    // 18. ВЕКТОРНЫЕ СЛОИ (SHP)
    // ==========================================
    window.loadVectorLayers = async function() {
        try {
            const response = await fetch(CONFIG.endpoints.vectors);
            const layersData = await response.json();

            // Удаляем старые
            Object.keys(AppState.vectors.activeLayers).forEach(id => {
                if (_layers[`vector-${id}`]) { map.removeLayer(_layers[`vector-${id}`]); delete _layers[`vector-${id}`]; }
                if (_layers[`vector-fill-${id}`]) { map.removeLayer(_layers[`vector-fill-${id}`]); delete _layers[`vector-fill-${id}`]; }
            });
            AppState.vectors.activeLayers = {};

            layersData.forEach(layer => {
                const format = new ol.format.GeoJSON();
                const features = format.readFeatures(layer.data, {
                    dataProjection: 'EPSG:4326',
                    featureProjection: 'EPSG:3857'
                });
                const source = new ol.source.Vector({ features });

                const olLayer = new ol.layer.Vector({
                    source,
                    style: new ol.style.Style({
                        fill: new ol.style.Fill({ color: (layer.color || '#32CD32') + '1a' }),
                        stroke: new ol.style.Stroke({
                            color: layer.color || '#32CD32',
                            width: layer.weight || 1.5
                        })
                    }),
                    zIndex: 350
                });

                _layers[`vector-${layer.id}`] = olLayer;
                map.addLayer(olLayer);

                AppState.vectors.activeLayers[layer.id] = {
                    dbId: layer.id,
                    name: layer.name || `SHP #${layer.id}`,
                    _features: (layer.data.features || []).map(f => ({
                        properties: f.properties,
                        _bounds: getBBoxFromGeojson(f)
                    }))
                };

                // Клик по вектору обрабатывается централизованно в _centralClickHandler
            });
        } catch(e) {}
    };

    window.deleteVectorLayer = async function(id) {
        if (!confirm('Удалить этот SHP слой?')) return;
        try {
            const res = await fetch(`/api/vector_layers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                if (_layers[`vector-${id}`]) { map.removeLayer(_layers[`vector-${id}`]); delete _layers[`vector-${id}`]; }
                delete AppState.vectors.activeLayers[id];
                window.loadVectorLayers();
            }
        } catch(e) {}
    };

    // ==========================================
    // 18б. MBTILES-СЛОИ (папка «MBTILES MINSK», загружаются прямо из панели слоёв)
    // ==========================================

    // Считываем сохранённую видимость (по умолчанию — включено сразу после добавления)
    function _mbtilesVisible(id) {
        try {
            const saved = JSON.parse(localStorage.getItem('map_mbtiles_state') || '{}');
            return saved[id] !== undefined ? !!saved[id] : true;
        } catch(e) { return true; }
    }
    function _saveMbtilesVisible(id, visible) {
        try {
            const saved = JSON.parse(localStorage.getItem('map_mbtiles_state') || '{}');
            saved[id] = visible;
            localStorage.setItem('map_mbtiles_state', JSON.stringify(saved));
        } catch(e) {}
    }
    // Прозрачность (0–100, по умолчанию 100 = непрозрачно)
    function _mbtilesOpacity(id) {
        try {
            const saved = JSON.parse(localStorage.getItem('map_mbtiles_opacity') || '{}');
            return saved[id] !== undefined ? Number(saved[id]) : 100;
        } catch(e) { return 100; }
    }
    function _saveMbtilesOpacity(id, opacityPct) {
        try {
            const saved = JSON.parse(localStorage.getItem('map_mbtiles_opacity') || '{}');
            saved[id] = opacityPct;
            localStorage.setItem('map_mbtiles_opacity', JSON.stringify(saved));
        } catch(e) {}
    }

    function _addMbtilesOlLayer(item) {
        const layerId = `mbtiles-${item.id}`;
        if (_layers[layerId]) { map.removeLayer(_layers[layerId]); delete _layers[layerId]; }

        const visible    = _mbtilesVisible(item.id);
        const opacityPct = _mbtilesOpacity(item.id);
        const olLayer = new ol.layer.Tile({
            source: new ol.source.XYZ({
                url: item.tile_url, // шаблон /api/mbtiles/{id}/{z}/{x}/{y}.png уже подставлен бэкендом
                crossOrigin: 'anonymous',
                minZoom: item.min_zoom || 0,
                maxZoom: item.max_zoom || 19,
                transition: 0, // без fade-in — меньше «замыливания» при подгрузке тайлов
                // Чёткость: при увеличении карты за пределы max_zoom самого mbtiles-файла
                // OpenLayers растягивает последний доступный тайл. interpolate:false отключает
                // билинейное сглаживание при этом растяжении — картинка остаётся резкой (чуть
                // «пиксельной»), а не размытой.
                interpolate: false,
                // ФИКС ЛАГОВ: без троттлинга включение папки/раздела сразу с
                // несколькими mbtiles-слоями шлёт десятки одновременных запросов
                // к /api/mbtiles/... → лавина, UI и бэкенд лагают. Ограничиваем
                // до 6 параллельных запросов через общую очередь mbtiles-слоёв.
                tileLoadFunction: _throttledMbtilesTileLoader
            }),
            visible: visible,
            zIndex: 260, // выше остальных слоёв данных, но ниже попапов/векторов при желании можно скорректировать
            opacity: opacityPct / 100,
            // preload:0 (по умолчанию) — не подгружаем соседние зумы заранее для
            // каждого mbtiles-слоя: при массовом включении это только добавляет
            // лишние тайлы в очередь throttle'а и замедляет появление видимых.
            preload: 0
        });
        // Флаг для приоритетного троттлера (см. _initTilePriorityTracking выше) —
        // без него mbtiles сама себя ставила бы на паузу.
        olLayer._isMbtiles = true;

        _layers[layerId] = olLayer;
        map.addLayer(olLayer);

        AppState.mbtiles.items[item.id] = {
            id: item.id, name: item.name, visible, opacity: opacityPct,
            minZoom: item.min_zoom, maxZoom: item.max_zoom, bounds: item.bounds
        };
    }

    // Загружает / обновляет список mbtiles-слоёв из папки MBTILES MINSK и добавляет их на карту
    window.loadMbtilesLayers = async function() {
        try {
            const res = await fetch(CONFIG.endpoints.mbtilesList);
            if (!res.ok) return;
            const data = await res.json();
            const items = (data && data.items) || [];

            // Убираем слои, которых больше нет на сервере (были удалены)
            const currentIds = new Set(items.map(it => it.id));
            Object.keys(AppState.mbtiles.items).forEach(id => {
                if (!currentIds.has(Number(id))) {
                    const layerId = `mbtiles-${id}`;
                    if (_layers[layerId]) { map.removeLayer(_layers[layerId]); delete _layers[layerId]; }
                    delete AppState.mbtiles.items[id];
                }
            });

            items.forEach(_addMbtilesOlLayer);
            window.renderMbtilesFolder && window.renderMbtilesFolder();
        } catch(e) {}
    };

    // Показать/скрыть mbtiles-слой
    window.toggleMbtilesLayer = function(id, visible) {
        const layerId = `mbtiles-${id}`;
        if (_layers[layerId]) _layers[layerId].setVisible(visible);
        if (AppState.mbtiles.items[id]) AppState.mbtiles.items[id].visible = visible;
        _saveMbtilesVisible(id, visible);
    };

    // Прозрачность mbtiles-слоя: opacityPct от 0 до 100
    window.setMbtilesOpacity = function(id, opacityPct) {
        const pct = Math.max(0, Math.min(100, Number(opacityPct)));
        const layerId = `mbtiles-${id}`;
        if (_layers[layerId]) _layers[layerId].setOpacity(pct / 100);
        if (AppState.mbtiles.items[id]) AppState.mbtiles.items[id].opacity = pct;
        _saveMbtilesOpacity(id, pct);
    };

    // Приближает карту к границам mbtiles-слоя (bounds приходят как [[lat_min,lon_min],[lat_max,lon_max]])
    window.zoomToMbtilesLayer = function(id) {
        const item = AppState.mbtiles.items[id];
        if (!item || !item.bounds) return;
        const [[latMin, lonMin], [latMax, lonMax]] = item.bounds;
        if ([latMin, lonMin, latMax, lonMax].some(v => v === null || v === undefined || isNaN(v))) return;

        const extent = ol.extent.boundingExtent([
            ol.proj.fromLonLat([lonMin, latMin]),
            ol.proj.fromLonLat([lonMax, latMax])
        ]);
        const targetZoom = item.maxZoom ? Math.min(item.maxZoom, 22) : undefined;
        map.getView().fit(extent, {
            padding: [40, 40, 40, 40],
            duration: 600,
            maxZoom: targetZoom
        });

        // Слой должен быть виден, иначе «приближение» будет впустую
        if (!item.visible) {
            window.toggleMbtilesLayer(id, true);
            window.renderMbtilesFolder && window.renderMbtilesFolder();
        }
    };

    // Загружает готовый .mbtiles файл прямо в папку «MBTILES MINSK» на сервере
    window.uploadMbtilesFile = async function(file, displayName) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('name', displayName || '');
        const res = await fetch(CONFIG.endpoints.mbtilesUpload, { method: 'POST', body: fd });
        if (!res.ok) {
            let msg = 'Не удалось загрузить MBTiles';
            try { const j = await res.json(); msg = j.detail || msg; } catch(e) {}
            throw new Error(msg);
        }
        const item = await res.json();
        _addMbtilesOlLayer(item);
        window.renderMbtilesFolder && window.renderMbtilesFolder();
        return item;
    };

    // Удаляет mbtiles-слой (файл + БД) и с карты — без подтверждения (используется и одиночным,
    // и массовым удалением; подтверждение показывается один раз на вызывающей стороне).
    async function _deleteMbtilesLayerInternal(id) {
        const res = await fetch(CONFIG.endpoints.mbtilesDelete(id), { method: 'DELETE' });
        if (res.ok) {
            const layerId = `mbtiles-${id}`;
            if (_layers[layerId]) { map.removeLayer(_layers[layerId]); delete _layers[layerId]; }
            delete AppState.mbtiles.items[id];
        }
        return res.ok;
    }

    window.deleteMbtilesLayer = async function(id) {
        if (!confirm('Удалить этот MBTiles слой из папки MBTILES MINSK?')) return;
        try {
            await _deleteMbtilesLayerInternal(id);
        } finally {
            window.renderMbtilesFolder && window.renderMbtilesFolder();
        }
    };

    // Включает/выключает разом все mbtiles-слои папки MBTILES MINSK
    window.toggleAllMbtilesLayers = function(visible) {
        Object.keys(AppState.mbtiles.items).forEach(id => {
            window.toggleMbtilesLayer(id, visible);
        });
        window.renderMbtilesFolder && window.renderMbtilesFolder();
    };

    // Удаляет разом все mbtiles-слои папки MBTILES MINSK (файлы + БД + карта)
    window.deleteAllMbtilesLayers = async function() {
        const ids = Object.keys(AppState.mbtiles.items);
        if (!ids.length) return;
        if (!confirm(`Удалить все MBTiles-слои (${ids.length} шт.) из папки MBTILES MINSK? Действие необратимо.`)) return;
        try {
            await Promise.all(ids.map(id => _deleteMbtilesLayerInternal(id).catch(() => false)));
        } finally {
            window.renderMbtilesFolder && window.renderMbtilesFolder();
        }
    };

    // ==========================================
    // 19. GetFeatureInfo (ПКМ на GeoServer слоях)
    // ==========================================
    window.getWmsUrl = function(key) {
        const def = _getExtDef(key);
        if (!def) return CONFIG.GEOSERVER_WMS;
        return getWmsBaseUrl(def.wmsUrl);
    };

    // ==========================================
    // 19а. ЕДИНЫЙ ПКМ ОБРАБОТЧИК
    // ==========================================
    // Только DOM-обработчик — надёжнее чем map.on('contextmenu') в OL
    // так как OL иногда не передаёт pixel корректно для contextmenu.
    (function _initContextMenu() {
        const _mapDomEl = document.getElementById('map');
        if (!_mapDomEl) return;

        let _cmAbortCtrl = null; // AbortController текущего запроса (отменяем при следующем клике)

        _mapDomEl.addEventListener('contextmenu', async function(domEvt) {
            domEvt.preventDefault();
            domEvt.stopPropagation();

            // Отменяем предыдущий незавершённый запрос — не блокируем, а заменяем
            if (_cmAbortCtrl) { _cmAbortCtrl.abort(); _cmAbortCtrl = null; }
            const MT = window.MeasureTool;
            // [FIX v2] Раньше здесь был «if (MT && MT.mode) return;» — в режиме
            // измерения/рисования ПКМ полностью игнорировался, и лесхоз не
            // подсвечивался, пока режим не выключить. ПКМ не участвует в
            // рисовании (Draw слушает только ЛКМ, mousedown ПКМ блокируется
            // _rmbBlock), поэтому идентификацию разрешаем и во время замера.
            // В режиме редактирования вершин с выбранной вершиной ПКМ занят
            // перемещением (_editCtxFn) — тогда идентификацию пропускаем.
            if (MT && MT.editMode && MT._selectedEf) return;

            const rect = _mapDomEl.getBoundingClientRect();
            const px = [domEvt.clientX - rect.left, domEvt.clientY - rect.top];
            const coord = map.getCoordinateFromPixel(px);
            if (!coord) return;

            // ── ПРИОРИТЕТ 0: ПКМ по замеру — удалить группу (без режима рисования/редактирования) ──────
            if (MT && !MT.editMode && !MT.mode && _msrGroups.length > 0) {
                const hitGroup = (() => {
                    const TOL = 12; // px
                    for (const g of _msrGroups) {
                        const fHit = g.features.some(f => {
                            const ext = f.getGeometry().getExtent();
                            const p1 = map.getPixelFromCoordinate([ext[0], ext[1]]);
                            const p2 = map.getPixelFromCoordinate([ext[2], ext[3]]);
                            if (!p1 || !p2) return false;
                            const fx1=Math.min(p1[0],p2[0])-TOL, fy1=Math.min(p1[1],p2[1])-TOL;
                            const fx2=Math.max(p1[0],p2[0])+TOL, fy2=Math.max(p1[1],p2[1])+TOL;
                            return px[0]>=fx1 && px[0]<=fx2 && px[1]>=fy1 && px[1]<=fy2;
                        });
                        if (fHit) return g;
                    }
                    return null;
                })();
                if (hitGroup) {
                    _msrRemoveGroup(hitGroup); // записывает в историю автоматически
                    window.showToast && window.showToast('❌ Замер удалён  (’↩ Ctrl+Z)', false);
                    return;
                }
            }

            const clientX = domEvt.clientX;
            const clientY = domEvt.clientY;
            const lngLatCoord = ol.proj.toLonLat(coord);
            const lngLat = { lat: lngLatCoord[1], lng: lngLatCoord[0] };

            // ── ПРИОРИТЕТ 1: Локальные SHP векторные слои ──────────────────
            // Собираем ВСЕ попавшие объекты со ВСЕХ видимых SHP-слоёв
            const shpIds = Object.keys(AppState.vectors.activeLayers);
            const shpLayersData = [];
            for (const layerId of shpIds) {
                const olLayer = _layers['vector-' + layerId];
                if (!olLayer || !olLayer.getVisible()) continue;
                const feats = map.getFeaturesAtPixel(px, { layerFilter: function(l) { return l === olLayer; }, hitTolerance: 4 });
                if (!feats || !feats.length) continue;
                const layerName = (AppState.vectors.activeLayers[layerId] || {}).name || ('SHP #' + layerId);
                // Все объекты слоя (не только первый)
                const cleanedFeats = feats.map(function(feat) {
                    const cleanProps = {};
                    Object.entries(feat.getProperties() || {}).forEach(function(kv) {
                        if (kv[0] !== 'geometry') cleanProps[kv[0]] = kv[1];
                    });
                    return { properties: cleanProps };
                });
                shpLayersData.push({
                    title: layerName + (cleanedFeats.length > 1 ? ' (' + cleanedFeats.length + ')' : ''),
                    key: 'shp_' + layerId,
                    features: cleanedFeats,
                    geoFeatures: []
                });
            }
            if (shpLayersData.length > 0) {
                _showInfoPopup(shpLayersData, lngLat, clientX, clientY);
                return;
            }

            // ── ПРИОРИТЕТ 2: Внешние WMS слои (bounds + векторные GeoServer) ──
            // Включаем ВСЕ не-растровые активные слои (noWfs не важен — это GetFeatureInfo WMS, не WFS)
            const activeWmsLayers = EXTERNAL_LAYER_DEFS.filter(function(d) {
                return AppState.externalLayerState[d.key] && !d.isRaster;
            });

            // Скрываем старый попап и highlight сразу — не показываем старые данные
            // [FIX] очищаем ВСЕГДА (до проверки activeWmsLayers), чтобы при клике
            // в месте без активных слоёв старая подсветка выдела тоже снималась.
            const _stalePopup = document.getElementById('info-float-popup');
            if (_stalePopup) {
                _stalePopup.classList.remove('visible');
                if (_infoOverlay) { map.removeOverlay(_infoOverlay); _infoOverlay = null; }
            }
            _highlightSource.clear();

            // Сбрасываем выделение лесхоза (синяя заливка) при любом ПКМ —
            // иначе выделение «прилипает» при кликах в стороне от лесхоза.
            if (window.clearLeskhozSelection) window.clearLeskhozSelection();
            // Сбрасываем highlight из поиска/таймлайна
            if (typeof _searchHighlightSource !== 'undefined' && _searchHighlightSource) {
                _searchHighlightSource.clear();
            }
            if (window.clearLeskhozSelection) window.clearLeskhozSelection();

            if (!activeWmsLayers.length) return;

            const _localCtrl = new AbortController();
            _cmAbortCtrl = _localCtrl;
            map.getTargetElement().style.cursor = 'progress';

            // ── GetFeatureInfo: используем реальный вьюпорт карты ──
            // ПРОБЛЕМА: WIDTH=3&HEIGHT=3 с bbox ±5px даёт GeoServer масштаб
            // 1:7 500 000 вместо реального ~1:50 000. Scale-denominator правила
            // слоёв отсекают объекты → пустой результат на мелких зумах.
            // РЕШЕНИЕ: передаём реальный размер map-контейнера и пиксельную
            // позицию клика — GeoServer получает тот же масштаб что видит юзер.
            const _mapEl     = map.getTargetElement();
            const _mapW      = _mapEl.clientWidth  || 800;
            const _mapH      = _mapEl.clientHeight || 600;
            const _viewExtent3857 = view.calculateExtent([_mapW, _mapH]);
            // [FIX] BBOX/SRS теперь в EPSG:3857 — той же проекции, в которой OL
            // реально рендерит карту. Раньше bbox переводился в EPSG:4326
            // (градусы), а GeoServer рисовал ответную картинку ЛИНЕЙНО по
            // широте (Plate Carrée), тогда как на экране карта в Web Mercator,
            // где вертикальный масштаб растёт как 1/cos(широта). На широте
            // Беларуси (~53°N) при вьюпорте ~1° по широте это давало смещение
            // «виртуального» пикселя X/Y на ~0.1° (~10+ км) ближе к центру
            // экрана — клик у границы соседнего лесхоза попадал в старый
            // (уже выбранный) полигон. При SRS=EPSG:3857 пиксельная сетка
            // GeoServer'а совпадает 1-в-1 с пиксельной сеткой OL, смещения нет.
            const bboxStr    = _viewExtent3857.join(',');
            // Пиксельная позиция клика в координатах map-контейнера
            const _clickPx   = px; // уже вычислен выше как [clientX-rect.left, clientY-rect.top]

            const snapLngLat  = lngLat;
            const snapClientX = clientX;
            const snapClientY = clientY;

            const layersData = [];
            let _popupShown = false;

            // Вспомогательная функция: fetch с таймаутом
            async function _fetchWithTimeout(url, signal, timeoutMs) {
                const timeoutId = setTimeout(() => {
                    try { signal.throwIfAborted(); } catch(e) {}
                    // создаём отдельный контроллер только для таймаута этого запроса
                }, timeoutMs);
                // Используем race между fetch и таймером
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new DOMException('Timeout', 'TimeoutError')), timeoutMs)
                );
                try {
                    return await Promise.race([
                        fetch(url, { signal }),
                        timeoutPromise
                    ]);
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            // Показываем попап немедленно при первом пришедшем результате
            function _onLayerResult(entry) {
                layersData.push(entry);
                if (!_popupShown) {
                    _popupShown = true;
                    _showInfoPopup(layersData, snapLngLat, snapClientX, snapClientY);
                } else {
                    // Обновляем уже открытый попап новой вкладкой
                    _updateInfoPopupTabs(layersData, snapLngLat, snapClientX, snapClientY);
                }
            }

            try {
                await Promise.all(activeWmsLayers.map(async function(def) {
                    try {
let _targetParam = '';
if (def.wmsUrl === 'GEOSERVER' || !def.wmsUrl) {
    _targetParam = def.sublabel.startsWith('External:') ? '&_target=GEOSERVER_EXT' : '&_target=GEOSERVER';
} else if (def.wmsUrl === 'BELGOSLES') {
    _targetParam = '&_target=BELGOSLES';
} else if (def.wmsUrl === 'COVERSTYLE') {
    _targetParam = '&_target=COVERSTYLE';
}
const url = '/geoserver_wms_proxy'
    + '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo'
    + '&INFO_FORMAT=application/json'
    + '&QUERY_LAYERS=' + encodeURIComponent(def.sublabel)
    + '&LAYERS=' + encodeURIComponent(def.sublabel)
    + '&SRS=EPSG:3857&BBOX=' + bboxStr
    + '&WIDTH=' + _mapW + '&HEIGHT=' + _mapH
    + '&X=' + Math.round(_clickPx[0]) + '&Y=' + Math.round(_clickPx[1])
    + '&FEATURE_COUNT=25'
    // [FIX] BUFFER (px) — жёстко ограничиваем радиус поиска GeoServer'а.
    // Без этого параметра GeoServer сам вычисляет буфер из толщины линии
    // стиля слоя в пикселях и переводит его в масштаб карты. На мелких
    // зумах (вся РБ на экране) те же несколько пикселей стиля превращаются
    // в километры на местности — GetFeatureInfo «цепляет» соседние/старые
    // полигоны за много км от клика. Явный маленький BUFFER убирает эту
    // зависимость от масштаба — на любом зуме ищем строго вокруг курсора.
    + '&BUFFER=2'
    + _targetParam;

                        // Таймаут 5 секунд на каждый слой — не ждём вечно
                        const res = await _fetchWithTimeout(url, _localCtrl.signal, 5000);
                        if (!res.ok) return;

                        let data = null;
                        const contentType = res.headers.get('content-type') || '';
                        if (contentType.includes('json')) {
                            data = await res.json();
                        } else {
                            const text = await res.text();
                            try { data = JSON.parse(text); } catch(e) { return; }
                        }

                        if (!data || !data.features || !data.features.length) return;

                        // [FIX] Раньше объекты сортировались по близости ЦЕНТРОИДА
                        // к точке клика. Это эвристика, а не точная проверка —
                        // для вытянутых/неправильной формы лесхозов centroid может
                        // оказаться дальше от клика, чем centroid соседнего
                        // полигона, даже если клик физически находится ВНУТРИ
                        // первого. Из-за этого при клике у общей границы мог
                        // выбираться сосед вместо реального объекта под курсором.
                        // Теперь — честная проверка "точка внутри геометрии"
                        // через ol.geom.*.intersectsCoordinate (учитывает реальный
                        // контур полигона, включая мультиполигоны и дыры).
                        // Геометрия приходит в EPSG:3857 (см. SRS запроса выше),
                        // сравниваем с координатой клика в той же проекции.
                        const _clickCoord3857 = coord; // [x, y] в метрах Web Mercator
                        const _olFmtHit = new ol.format.GeoJSON();
                        function _containsClick(f) {
                            try {
                                const olF = _olFmtHit.readFeature(f, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' });
                                const geom = olF && olF.getGeometry();
                                return !!(geom && geom.intersectsCoordinate(_clickCoord3857));
                            } catch(_) { return false; }
                        }
                        function _distToFeature(f) {
                            try {
                                const geom = f.geometry;
                                if (!geom) return Infinity;
                                let cx, cy;
                                if (geom.type === 'Point') {
                                    [cx, cy] = geom.coordinates;
                                } else if (geom.bbox) {
                                    cx = (geom.bbox[0] + geom.bbox[2]) / 2;
                                    cy = (geom.bbox[1] + geom.bbox[3]) / 2;
                                } else {
                                    const olF = _olFmtHit.readFeature(f, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' });
                                    if (!olF) return Infinity;
                                    const ext = olF.getGeometry().getExtent();
                                    cx = (ext[0] + ext[2]) / 2;
                                    cy = (ext[1] + ext[3]) / 2;
                                }
                                const dx = cx - _clickCoord3857[0];
                                const dy = cy - _clickCoord3857[1];
                                return dx * dx + dy * dy;
                            } catch(_) { return Infinity; }
                        }
                        // Разделяем: те, что реально содержат точку клика — вперёд
                        // (в порядке по площади/дистанции, если их несколько —
                        // редкий случай перекрывающихся полигонов), остальные —
                        // как fallback, отсортированные по близости центроида.
                        const _hitFeatures  = data.features.filter(_containsClick);
                        const _missFeatures = data.features.filter(f => !_containsClick(f));
                        _hitFeatures.sort(function(a, b) { return _distToFeature(a) - _distToFeature(b); });
                        _missFeatures.sort(function(a, b) { return _distToFeature(a) - _distToFeature(b); });
                        const _sortedFeatures = _hitFeatures.concat(_missFeatures);

                        const cleaned = _sortedFeatures.map(function(f) {
                            const props = {};
                            Object.entries(f.properties || {}).forEach(function(kv) {
                                const k = kv[0], v = kv[1];
                                if (['bbox','id','fid','gid','the_geom','geom'].includes(k.toLowerCase())) return;
                                if (v === null || v === undefined || v === '') return;
                                props[autoFormatKey(k)] = v;
                            });
                            return Object.assign({}, f, { properties: props });
                        });

                        if (cleaned.length > 0) {
                            _onLayerResult({
                                title: def.label, key: def.key,
                                features: cleaned,
                                geoFeatures: _sortedFeatures,
                                geomProj: 'EPSG:3857'
                            });
                            // ── ALL-PANS (Вектор): подсвечиваем папку в панели ДЗЗ ──
                            if (def.key === 'gs_all_pans_vector' && AppState.externalLayerState['gs_all_pans_vector']) {
                                _highlightDzzFolderFromVectorClick(_sortedFeatures[0]);
                            }
                        }
                    } catch(err) {}
                }));
            } finally {
                if (_cmAbortCtrl === _localCtrl) _cmAbortCtrl = null;
                // Во время замера возвращаем курсор-прицел, иначе — обычный
                map.getTargetElement().style.cursor = window._msrDrawingActive ? 'crosshair' : 'default';
            }
        });
    })();

    // ── ALL-PANS вектор: найти папку снимка в панели ДЗЗ и подсветить её ──
    // Вызывается после GetFeatureInfo по слою gs_all_pans_vector
    window._highlightDzzFolderFromVectorClick = function(rawFeature) {
        try {
            const props = rawFeature && rawFeature.properties ? rawFeature.properties : {};

            // ── Шаг 1: Извлекаем идентификатор снимка из свойств фичи ──
            // FileName: "4100522-0330-PAN-B-1-1-4368745-240503T083444-BY-RU.tif"  → "4100522"
            // SceneId: числовое поле, может дублироваться — менее надёжно
            let sceneNum = null;

            // Перебираем все свойства, ищем похожее на имя файла снимка
            const allPropValues = Object.values(props).map(v => String(v || ''));
            for (const val of allPropValues) {
                // Ищем паттерн: 7-значное число в начале строки (номер снимка Канопус-В)
                const m = val.match(/^(\d{7})-/);
                if (m) { sceneNum = m[1]; break; }
            }

            // Если не нашли через FileName — пробуем ключ FileName напрямую
            if (!sceneNum) {
                for (const [k, v] of Object.entries(props)) {
                    if (/filename/i.test(k)) {
                        const m = String(v).match(/(\d{7})/);
                        if (m) { sceneNum = m[1]; break; }
                    }
                }
            }

            if (!sceneNum) {
                window.showToast && window.showToast('Не удалось определить номер снимка', false);
                return;
            }

            // ── Шаг 2: Ищем bundle в котором есть subkey с этим номером ──
            if (!window._dzzTabs) return;
            const spaceTab = window._dzzTabs.find(t => t.id === 'space');
            if (!spaceTab) return;

            let foundYear = null, foundBundle = null;

            outer:
            for (const [yearStr, folders] of Object.entries(spaceTab.yearFolders)) {
                for (const ld of folders) {
                    if (ld.key === 'bundle_all_pans') continue;
                    // Проверяем subkeys: gs_ks_4100522_pan_cog содержит номер снимка
                    const subkeys = ld.subkeys || [];
                    const matched = subkeys.some(sk => sk.includes(sceneNum));
                    if (matched) {
                        foundYear = parseInt(yearStr);
                        foundBundle = ld;
                        break outer;
                    }
                    // Запасной вариант: проверяем label bundle'а
                    if ((ld.label || '').includes(sceneNum)) {
                        foundYear = parseInt(yearStr);
                        foundBundle = ld;
                        break outer;
                    }
                }
            }

            // ── Шаг 3: Открываем панель ДЗЗ, переключаемся на Спутник ──
            const dzzOpenBtn = document.querySelector('[data-panel="dzz"], .dzz-toggle-btn, #dzz-toggle');
            const dzzPanel = document.getElementById('dzz-panel') || document.querySelector('.dzz-panel');
            if (dzzOpenBtn && dzzPanel && dzzPanel.style.display === 'none') {
                dzzOpenBtn.click();
            }

            // Переключаемся на вкладку space
            const tabBar = document.getElementById('dzz-tabs2');
            if (tabBar) {
                const spaceTabBtn = tabBar.querySelector('[data-tab-id="space"]');
                if (spaceTabBtn && !spaceTabBtn.classList.contains('active')) spaceTabBtn.click();
            }

            // ── Шаг 4: Раскрываем нужный год и подсвечиваем bundle ──
            const PURPLE = '#9c7ee8';
            const _doHighlight = () => {
                const body = document.getElementById('dzz-body');
                if (!body) return;

                if (foundYear === null) {
                    window.showToast && window.showToast(`Снимок ${sceneNum} не найден в панели ДЗЗ`, false);
                    return;
                }

                const yearBlock = body.querySelector(`.dzz-year-block[data-year="${foundYear}"]`);
                if (!yearBlock) {
                    window.showToast && window.showToast(`Снимок ${sceneNum} → папка ${foundYear}`, false);
                    return;
                }

                // Раскрываем папку года если закрыта
                const subDiv = yearBlock.querySelector('.dzz-sublayers');
                if (subDiv && !subDiv.classList.contains('open')) {
                    const yearRow = yearBlock.querySelector('.dzz-year-row');
                    if (yearRow) yearRow.click();
                }

                // Плавно скроллим к папке года
                yearBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                // Подсвечиваем строку года
                yearBlock.style.transition = 'box-shadow 0.25s';
                yearBlock.style.boxShadow = `0 0 0 2.5px ${PURPLE}, 0 2px 14px rgba(156,126,232,0.4)`;
                yearBlock.style.borderRadius = '10px';
                setTimeout(() => { yearBlock.style.boxShadow = ''; yearBlock.style.borderRadius = ''; }, 2500);

                // Подсвечиваем конкретный sub-item через небольшую задержку (чтобы open-анимация успела)
                if (foundBundle) {
                    setTimeout(() => {
                        const allFolders = (spaceTab.yearFolders[foundYear] || []).filter(f => f.key !== spaceTab.topKey);
                        const idx = allFolders.findIndex(f => f.key === foundBundle.key);
                        const subItems = yearBlock.querySelectorAll('.dzz-sub-item');
                        if (idx >= 0 && subItems[idx]) {
                            const target = subItems[idx];
                            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            target.style.transition = 'background 0.25s, box-shadow 0.25s';
                            target.style.background = '#ede7f6';
                            target.style.boxShadow = `0 0 0 2px ${PURPLE}`;
                            setTimeout(() => { target.style.background = ''; target.style.boxShadow = ''; }, 2500);
                        }
                    }, 260);
                }
            };

            // Если вкладка space уже активна — выполняем сразу, иначе даём время renderBody
            setTimeout(_doHighlight, 160);

        } catch(e) {
            console.debug('[_highlightDzzFolderFromVectorClick]', e);
        }
    };
    const scaleBarEl = document.createElement('div');
    scaleBarEl.id = 'custom-scale-bar';
    scaleBarEl.className = 'style-spruce';
    scaleBarEl.innerHTML = '<div class="csb-ruler"></div><div class="csb-labels"></div><div class="csb-ratio"></div>';
    // Apply saved visibility on load
    if (localStorage.getItem('ui_scale_bar') === 'false') scaleBarEl.style.display = 'none';
    document.getElementById('map').appendChild(scaleBarEl);

    // ── Смещение линейки правее боковой панели ──────────────────────────
    window._updateScaleBarOffset = function() {
        const csb = document.getElementById('custom-scale-bar');
        if (!csb) return;
        // В fullscreen-режиме — CSS fixed уже корректно расположит, не трогаем inline left
        if (document.body.classList.contains('fullscreen-mode')) {
            csb.style.left = '';
            csb.style.bottom = '';
            return;
        }
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) { csb.style.left = '10px'; return; }
        const sbHidden = sidebar.style.display === 'none' ||
                         sidebar.offsetParent === null ||
                         sidebar.offsetWidth === 0;
        if (sbHidden) { csb.style.left = '10px'; return; }
        // [v16 FIX] На мобильной раскладке сайдбар — нижняя шторка (под картой).
        // Раньше линейка сдвигалась на всю ширину шторки (≈ширина экрана) и
        // уезжала за правый край → документ становился шире экрана, а мобильный
        // браузер уменьшал масштаб всей страницы. Сдвигаем только если сайдбар
        // действительно стоит слева от карты/поверх неё.
        const sbRect = sidebar.getBoundingClientRect();
        const mapRect = (document.getElementById('map') || document.body).getBoundingClientRect();
        if (sbRect.top >= mapRect.bottom - 2 || sbRect.width >= mapRect.width - 2) {
            csb.style.left = '10px';
            return;
        }
        const sbW = sidebar.offsetWidth || 480;
        csb.style.left = Math.min(sbW + 12, Math.max(10, mapRect.width - csb.offsetWidth - 10)) + 'px';
    };
    // [v18 PERF] Сразу ставим линейку на место (раньше — только через 400 мс: она появлялась
    // под боковой панелью и потом «прыгала» вправо — Lighthouse: смещение макета).
    try { window._updateScaleBarOffset(); } catch (e) {}
    // Повторные проверки с задержкой — на случай поздней перестройки DOM
    setTimeout(window._updateScaleBarOffset, 400);
    setTimeout(window._updateScaleBarOffset, 1200);
    window.addEventListener('resize', window._updateScaleBarOffset);
    // Следим за sidebar через MutationObserver
    (function() {
        const sb = document.querySelector('.sidebar');
        if (!sb) return;
        new MutationObserver(window._updateScaleBarOffset)
            .observe(sb, { attributes: true, attributeFilter: ['style', 'class'] });
    })();


    const CSB_STYLES = ['taiga','birch','pine','spruce','oak'];
    // [v17] spruce (по умолчанию) — цвета текущей темы оформления; остальные — фиксированные палитры
    const CSB_NAMES  = { taiga:'тайга (тёмная)', birch:'берёза (светлая)', pine:'топо (без фона)', spruce:'по теме оформления', oak:'дуб (тёплая)' };
    let csbStyleIdx  = parseInt(localStorage.getItem('csb_style') ?? '3');
    if (!(csbStyleIdx >= 0 && csbStyleIdx < CSB_STYLES.length)) csbStyleIdx = 3;

    function applyCsbStyle(idx) {
        CSB_STYLES.forEach(s => scaleBarEl.classList.remove('style-' + s));
        scaleBarEl.classList.add('style-' + CSB_STYLES[idx]);
    }
    applyCsbStyle(csbStyleIdx);
    scaleBarEl.setAttribute('role', 'img');
    scaleBarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        csbStyleIdx = (csbStyleIdx + 1) % CSB_STYLES.length;
        localStorage.setItem('csb_style', csbStyleIdx);
        applyCsbStyle(csbStyleIdx);
        if (window.showToast) window.showToast('Линейка: ' + CSB_NAMES[CSB_STYLES[csbStyleIdx]], false);
    });

    // [v17] Линейка масштаба:
    //  • разрешение в точке центра (ol.proj.getPointResolution) — верно и для дробных уровней масштаба;
    //  • длина отрезка — «красивое» число 1-2-5, сама линейка 64–160 px (раньше до 375 px);
    //  • подписи стоят точно на делениях 0 / ½ / конец, единица измерения — только в конце;
    //  • знаменатель округлён до 3 значащих цифр (1 : 2 720 000), точное значение — во всплывающей подсказке;
    //  • обновление плавно во время зума (change:resolution + requestAnimationFrame), без задержки 120 мс.
    const CSB_MAX_PX = 160;
    const _csbNum = (v) => Number.isInteger(v) ? String(v) : v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    function _csbFloorNice(v) {
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        const f = v / p;
        return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
    }
    function _csbRound3(v) {
        const d = Math.max(1, Math.round(v));
        const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(d)) - 2));
        return Math.round(d / mag) * mag;
    }
    function _csbLen(m) { return m >= 1000 ? _csbNum(m / 1000) + ' км' : _csbNum(m) + ' м'; }
    function _csbMetersPerPx() {
        const v = map.getView();
        const res = v && v.getResolution();
        if (!res) return 0;
        try {
            if (ol.proj.getPointResolution) {
                const pr = ol.proj.getPointResolution(v.getProjection(), res, v.getCenter(), 'm');
                if (isFinite(pr) && pr > 0) return pr;
            }
        } catch (e) { /* старые сборки OL */ }
        const c = ol.proj.toLonLat(v.getCenter(), v.getProjection());
        return res * Math.cos(c[1] * Math.PI / 180);
    }
    function updateCustomScaleBar() {
        const mpp = _csbMetersPerPx();
        if (!(mpp > 0)) return;
        const niceM = _csbFloorNice(mpp * CSB_MAX_PX);
        const barPx = Math.max(1, Math.round(niceM / mpp));
        const km = niceM >= 1000;
        const unitDiv = km ? 1000 : 1;
        const ruler  = scaleBarEl.querySelector('.csb-ruler');
        const labels = scaleBarEl.querySelector('.csb-labels');
        const ratio  = scaleBarEl.querySelector('.csb-ratio');
        if (ruler.children.length !== 5) ruler.innerHTML = '<div class="csb-seg"></div><div class="csb-seg alt"></div><div class="csb-seg"></div><div class="csb-seg alt"></div><div class="csb-seg-end"></div>';
        if (labels.children.length !== 3) labels.innerHTML = '<span style="left:0">0</span><span style="left:50%"></span><span style="left:100%"></span>';
        const sw = barPx / 4;
        ruler.style.width = barPx + 'px';
        for (let i = 0; i < 4; i++) ruler.children[i].style.width = sw + 'px';
        labels.style.width = barPx + 'px';
        labels.children[1].textContent = _csbNum(niceM / 2 / unitDiv);
        labels.children[2].textContent = _csbNum(niceM / unitDiv) + (km ? ' км' : ' м');
        const den = mpp * 3779.5275591;                     // 96 dpi: 1 м = 3779,53 CSS px
        const denTxt = _csbRound3(den).toLocaleString('ru-RU');
        ratio.textContent = '1 : ' + denTxt;
        const cmTxt = _csbLen(mpp * 37.795275591 >= 1000 ? Math.round(mpp * 37.795275591 / 10) * 10 : Math.round(mpp * 37.795275591));
        const tip = 'Масштаб 1 : ' + Math.round(den).toLocaleString('ru-RU') + ' (в 1 см на экране ≈ ' + cmTxt + '). Отрезок — ' + _csbLen(niceM) + '. Нажмите, чтобы сменить вид линейки';
        scaleBarEl.title = tip;
        scaleBarEl.setAttribute('aria-label', 'Масштаб 1 : ' + denTxt + ', отрезок ' + _csbLen(niceM));
        scaleBarEl.dataset.printText = '0–' + _csbLen(niceM) + ' · 1 : ' + denTxt;
    }
    let _csbRaf = 0;
    function _scheduleScaleBar() {
        if (_csbRaf) return;
        _csbRaf = requestAnimationFrame(() => { _csbRaf = 0; updateCustomScaleBar(); });
    }
    function _bindScaleBarView() { try { map.getView().on('change:resolution', _scheduleScaleBar); } catch (e) {} }
    _bindScaleBarView();
    map.on('change:view', () => { _bindScaleBarView(); _scheduleScaleBar(); });
    map.on('moveend', _scheduleScaleBar);
    setTimeout(updateCustomScaleBar, 300);

    // ==========================================
    // 21. НИЖНЯЯ ПЛАШКА ЛЕСХОЗА
    // ==========================================
    function showSelectedBar(code) {
        const bar = document.getElementById('selected-leshoz-bar');
        if (!bar) return;
        const info = MANUAL_FORESTRY_FIX.find(x => x.code == code);
        const name = info ? info.name : `Лесхоз ${code}`;
        const count = AppState.forestry.counts[code] || 0;
        document.getElementById('slb-name').textContent = name;
        const countEl = document.getElementById('slb-count');
        const dlEl = document.getElementById('slb-download');
        if (count > 0) {
            countEl.textContent = `${count} снимок(ов)`;
            countEl.style.display = 'inline-block';
            if (dlEl) { dlEl.href = `/download_zip_leskhoz/${code}`; dlEl.style.display = 'inline-flex'; }
        } else {
            countEl.style.display = 'none';
            if (dlEl) dlEl.style.display = 'none';
        }
        bar.style.display = 'flex';
    }
    function hideSelectedBar() {
        const bar = document.getElementById('selected-leshoz-bar');
        if (bar) bar.style.display = 'none';
    }

    // ==========================================
    // 22. ИНСТРУМЕНТ ИЗМЕРЕНИЙ (OpenLayers Draw)
    // ==========================================
    // ==========================================
    // 22. ДВИЖОК ИЗМЕРЕНИЙ — полный перенос из leaflet_var.js, адаптирован под OpenLayers
    // ==========================================

    // [PERF-FIX] Убран дублирующийся набор _olLatLng/_olDistBetween/_olToCoord —
    // ниже по файлу (см. "Вспомогательные утилиты") объявлены те же имена функций.
    // Так как function-объявления в общей области видимости initApp() хоистятся,
    // вторые определения полностью перекрывали эти при выполнении — этот блок
    // был мёртвым кодом (в т.ч. .distanceTo() из первой версии _olLatLng нигде
    // не вызывался). Актуальные версии — ниже, рядом с _olToLatLng/_olFromLatLng.

    // ==========================================
    // 22. ДВИЖОК ИЗМЕРЕНИЙ — нативный ol.interaction.Draw
    // ==========================================

    // ── Слой для завершённых замеров ─────────────────────────────────────────
    const _msrVectorSource = new ol.source.Vector();
    const _msrVectorLayer  = new ol.layer.Vector({ source: _msrVectorSource, zIndex: 400 });
    map.addLayer(_msrVectorLayer);

    // ── Отдельный source/layer для Draw (рисование в реальном времени) ───────
    const _msrDrawSource = new ol.source.Vector();
    const _msrDrawLayer  = new ol.layer.Vector({ source: _msrDrawSource, zIndex: 401 });
    map.addLayer(_msrDrawLayer);

    // ── Оверлеи-тултипы ──────────────────────────────────────────────────────
    const _msrOverlays = [];

    function _msrMakeOverlay(coord3857, html, cls, positioning) {
        const el = document.createElement('div');
        el.className = cls || 'measure-tooltip';
        el.innerHTML = html;
        const ov = new ol.Overlay({
            element: el, position: coord3857,
            positioning: positioning || 'bottom-center',
            stopEvent: false, insertFirst: false
        });
        map.addOverlay(ov);
        _msrOverlays.push(ov);
        return ov;
    }
    function _msrRemoveOverlay(ov) {
        if (!ov) return;
        map.removeOverlay(ov);
        const i = _msrOverlays.indexOf(ov);
        if (i > -1) _msrOverlays.splice(i, 1);
    }

    // ── Стили ────────────────────────────────────────────────────────────────
    function _msrLineStyle(color, dashed) {
        return new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: 2.5, lineDash: dashed ? [6,8] : undefined }) });
    }
    function _msrFillStyle(lineColor, fillColor) {
        return new ol.style.Style({
            fill: new ol.style.Fill({ color: (fillColor || lineColor) + '33' }),
            stroke: new ol.style.Stroke({ color: lineColor, width: 2 })
        });
    }
    function _msrDotStyle(mc) {
        return new ol.style.Style({ image: new ol.style.Circle({
            radius: 5, fill: new ol.style.Fill({ color: mc }),
            stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
        })});
    }
    function _msrEditDotStyle(mc, selected) {
        return new ol.style.Style({ image: new ol.style.Circle({
            radius: selected ? 11 : 8,
            fill: new ol.style.Fill({ color: selected ? '#ffeb3b' : mc }),
            stroke: new ol.style.Stroke({ color: selected ? '#f57f00' : '#fff', width: selected ? 2.5 : 2 })
        })});
    }
    function _msrDrawStyleFn(lineColor, markerColor) {
        return function(feature) {
            const t = feature.getGeometry().getType();
            if (t === 'Point') return new ol.style.Style({ image: new ol.style.Circle({
                radius: 5, fill: new ol.style.Fill({ color: markerColor }),
                stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
            })});
            if (t === 'LineString') return [
                new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 5 }) }),
                new ol.style.Style({ stroke: new ol.style.Stroke({ color: lineColor, width: 2.5, lineDash: [6,8] }) })
            ];
            if (t === 'Polygon') return [
                new ol.style.Style({ fill: new ol.style.Fill({ color: markerColor + '22' }), stroke: new ol.style.Stroke({ color: '#fff', width: 5 }) }),
                new ol.style.Style({ fill: new ol.style.Fill({ color: markerColor + '11' }), stroke: new ol.style.Stroke({ color: lineColor, width: 2.5, lineDash: [6,8] }) })
            ];
            return null;
        };
    }

    // ── Группы завершённых замеров ────────────────────────────────────────────
    const _msrGroups = [];

    // ── Флаг блокировки идентификации слоёв во время рисования/редактирования ──
    // Все singleclick-обработчики карты проверяют этот флаг перед идентификацией.
    window._msrDrawingActive = false;

    // ── История Undo / Redo ──────────────────────────────────────────────────
    // Стек хранит снимки состояния: массив групп (ссылки).
    // Каждая запись = { added: [g], removed: [g] } — что было добавлено/удалено.
    const _msrHistory  = [];   // прошлые действия (для undo)
    const _msrRedoStack = [];  // отменённые действия (для redo)
    const MSR_HISTORY_MAX = 50;

    function _msrPushHistory(added, removed) {
        _msrHistory.push({ added: added || [], removed: removed || [] });
        if (_msrHistory.length > MSR_HISTORY_MAX) _msrHistory.shift();
        _msrRedoStack.length = 0; // новое действие сбрасывает redo
    }

    function _msrAddGroup(g) {
        _msrGroups.push(g);
        g.features.forEach(f => _msrVectorSource.addFeature(f));
        _msrPushHistory([g], []);
    }
    function _msrRemoveGroup(g, _noHistory) {
        g.features.forEach(f => _msrVectorSource.removeFeature(f));
        g.overlays.forEach(ov => _msrRemoveOverlay(ov));
        const gi = _msrGroups.indexOf(g);
        if (gi > -1) _msrGroups.splice(gi, 1);
        if (!_noHistory) _msrPushHistory([], [g]);
    }
    function _msrRemoveGroupBatch(groups) {
        // Удаляет несколько групп как одно действие истории
        groups.forEach(g => {
            g.features.forEach(f => _msrVectorSource.removeFeature(f));
            g.overlays.forEach(ov => _msrRemoveOverlay(ov));
            const gi = _msrGroups.indexOf(g);
            if (gi > -1) _msrGroups.splice(gi, 1);
        });
        if (groups.length > 0) _msrPushHistory([], groups);
    }
    function _msrRestoreGroup(g) {
        // Возвращает группу на карту (для undo/redo)
        _msrGroups.push(g);
        g.features.forEach(f => {
            try { _msrVectorSource.addFeature(f); } catch(_) {}
        });
        g.overlays.forEach(ov => {
            try { map.addOverlay(ov); } catch(_) {}
            if (_msrOverlays.indexOf(ov) === -1) _msrOverlays.push(ov);
        });
    }

    // ── Undo ─────────────────────────────────────────────────────────────────
    function _msrUndo() {
        if (_msrHistory.length === 0) { window.showToast && window.showToast('Нечего отменять', false); return; }
        const action = _msrHistory.pop();
        _msrRedoStack.push(action);
        // Откатываем: восстанавливаем removed, удаляем added
        action.removed.forEach(g => _msrRestoreGroup(g));
        action.added.forEach(g => {
            g.features.forEach(f => _msrVectorSource.removeFeature(f));
            g.overlays.forEach(ov => _msrRemoveOverlay(ov));
            const gi = _msrGroups.indexOf(g);
            if (gi > -1) _msrGroups.splice(gi, 1);
        });
        window.showToast && window.showToast('↩ Отменено', false);
    }

    // ── Redo ─────────────────────────────────────────────────────────────────
    function _msrRedo() {
        if (_msrRedoStack.length === 0) { window.showToast && window.showToast('Нечего повторить', false); return; }
        const action = _msrRedoStack.pop();
        _msrHistory.push(action);
        // Повторяем: удаляем removed, восстанавливаем added
        action.removed.forEach(g => _msrRestoreGroup(g));
        action.added.forEach(g => {
            g.features.forEach(f => _msrVectorSource.removeFeature(f));
            g.overlays.forEach(ov => _msrRemoveOverlay(ov));
            const gi = _msrGroups.indexOf(g);
            if (gi > -1) _msrGroups.splice(gi, 1);
        });
        window.showToast && window.showToast('↪ Повторено', false);
    }

    // ── Вспомогательные утилиты ───────────────────────────────────────────────
    function _olDistBetween(a, b) {
        const R=6378137, dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
        const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        return 2*R*Math.asin(Math.sqrt(x));
    }
    function _olToLatLng(c3857) { const ll=ol.proj.toLonLat(c3857); return {lat:ll[1],lng:ll[0]}; }
    function _olFromLatLng(ll)  { return ol.proj.fromLonLat([ll.lng, ll.lat]); }
    // Алиасы для совместимости с кодом ниже (eraser, rebuild и т.д.)
    function _olLatLng(c) { return _olToLatLng(c); }
    function _olToCoord(ll) { return _olFromLatLng(ll); }

    // ==========================================
    // ДВИЖОК — window.MeasureTool (нативный Draw)
    // ==========================================
    window.MeasureTool = (function() {
        var _mode       = null;
        var _drawInter  = null;
        var _tipOverlay = null;
        var _tipEl      = null;
        var _continuous = false;
        var _editMode   = false;
        var _editFeatures = [];
        var _selectedEf   = null;
        var _editClickFn  = null;
        var _editCtxFn    = null;

        var T = {
            get mode()        { return _mode; },
            get _listening()  { return _drawInter !== null; },
            get _continuous() { return _continuous; },
            set _continuous(v){ _continuous = v; },
            get editMode()    { return _editMode; },
            get _editFeatures(){ return _editFeatures; },
            get _selectedEf() { return _selectedEf; },

            unit:        localStorage.getItem('msr_unit')         || 'm',
            lineColor:   localStorage.getItem('msr_line_color')   || '#ff8c00',
            markerColor: localStorage.getItem('msr_marker_color') || '#82e938',

            _isAllowed: function() {
                return typeof window._isMeasureEnabled === 'function' ? window._isMeasureEnabled() : true;
            },
            fmtDist: function(m) {
                return this.unit === 'km' ? (m/1000).toFixed(3)+' км' : m.toFixed(2)+' м.';
            },
            fmtArea: function(m2) {
                if (this.unit === 'km') return (m2/1000000).toFixed(3)+' км²';
                return m2 > 10000 ? (m2/10000).toFixed(2)+' га' : Math.round(m2)+' м²';
            },
            bearingToCardinal: function(deg) {
                return ['С','СВ','В','ЮВ','Ю','ЮЗ','З','СЗ'][Math.round(deg/45)%8];
            },
            calculateBearing: function(p1, p2) {
                var lat1=p1.lat*Math.PI/180, lat2=p2.lat*Math.PI/180, dLng=(p2.lng-p1.lng)*Math.PI/180;
                var y=Math.sin(dLng)*Math.cos(lat2);
                var x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng);
                return (Math.atan2(y,x)*180/Math.PI+360)%360;
            },
            calculateArea: function(latLngs) {
                if (latLngs.length < 3) return 0;
                var R=6378137, area=0;
                for (var i=0;i<latLngs.length;i++) {
                    var p1=latLngs[i], p2=latLngs[(i+1)%latLngs.length];
                    area+=(p2.lng-p1.lng)*Math.PI/180*(2+Math.sin(p1.lat*Math.PI/180)+Math.sin(p2.lat*Math.PI/180));
                }
                return Math.abs(area*R*R/2);
            },

            // ── Запуск рисования через ol.interaction.Draw ───────────────────
            start: function(mode) {
                if (!this._isAllowed()) return;
                this._stopDraw();
                _mode = mode;

                var geomType = (mode === 'area') ? 'Polygon' : 'LineString';
                _drawInter = new ol.interaction.Draw({
                    source:    _msrDrawSource,
                    type:      geomType,
                    style:     _msrDrawStyleFn(T.lineColor, T.markerColor),
                    stopClick: true,
                    // Только ЛКМ (button === 0)
                    condition: function(e) { return e.originalEvent && e.originalEvent.button === 0; }
                });
                map.addInteraction(_drawInter);
                map.getTargetElement().style.cursor = 'crosshair';
                window._msrDrawingActive = true; // блокируем идентификацию слоёв

                // Блокируем ПКМ от попадания в OL Draw viewport
                var _rmbBlock = function(e) { if (e.button === 2) e.stopPropagation(); };
                map.getViewport().addEventListener('mousedown', _rmbBlock, true);
                _drawInter._rmbBlock = _rmbBlock;

                // Тултип при рисовании
                _tipEl = document.createElement('div');
                _tipEl.className = 'measure-tooltip';
                _tipOverlay = new ol.Overlay({
                    element: _tipEl, offset: [15, 0],
                    positioning: 'center-left', stopEvent: false
                });
                map.addOverlay(_tipOverlay);

                _drawInter.on('drawstart', function(evt) {
                    evt.feature.getGeometry().on('change', function(e) {
                        var geom = e.target, tip = '', lastCoord;
                        if (geom.getType() === 'LineString') {
                            var coords = geom.getCoordinates();
                            var pts = coords.map(_olToLatLng);
                            var total = 0;
                            for (var i=0;i<pts.length-1;i++) total += _olDistBetween(pts[i], pts[i+1]);
                            if (mode === 'direction' && pts.length >= 2) {
                                var brng = T.calculateBearing(pts[0], pts[pts.length-1]);
                                tip = T.bearingToCardinal(brng)+'  '+brng.toFixed(1)+'deg'+T.fmtDist(total);
                            } else {
                                var lastSeg = pts.length >= 2 ? _olDistBetween(pts[pts.length-2], pts[pts.length-1]) : 0;
                                tip = pts.length > 2 ? T.fmtDist(lastSeg)+' (∑ '+T.fmtDist(total)+')' : T.fmtDist(total);
                            }
                            lastCoord = coords[coords.length-1];
                        } else if (geom.getType() === 'Polygon') {
                            var ring = geom.getLinearRing(0).getCoordinates();
                            tip = 'Площадь: '+T.fmtArea(T.calculateArea(ring.map(_olToLatLng)));
                            var flat = geom.getFlatCoordinates();
                            lastCoord = [flat[flat.length-4], flat[flat.length-3]];
                        }
                        if (_tipEl) _tipEl.innerHTML = tip;
                        if (_tipOverlay && lastCoord) _tipOverlay.setPosition(lastCoord);
                    });
                });

                _drawInter.on('drawend', function(evt) {
                    if (_tipOverlay) { map.removeOverlay(_tipOverlay); _tipOverlay = null; _tipEl = null; }
                    setTimeout(function() { _msrDrawSource.clear(); }, 10);

                    var geom = evt.feature.getGeometry();
                    var pts;
                    if (geom.getType() === 'Polygon') {
                        pts = geom.getLinearRing(0).getCoordinates().map(_olToLatLng);
                        pts.pop(); // убираем замыкающую точку
                    } else {
                        pts = geom.getCoordinates().map(_olToLatLng);
                    }

                    if (mode === 'direction' && pts.length >= 2) {
                        _msrFinishDirection(pts[0], pts[pts.length-1], T);
                    } else if (mode === 'area' && pts.length >= 3) {
                        _msrFinishPolygon(pts, T);
                    } else if (mode === 'distance' && pts.length >= 2) {
                        _msrFinishLine(pts, T);
                    }

                    // После завершения замера — всегда останавливаемся (не перезапускаем)
                    T._stopDraw();
                    _mode = null;
                    _continuous = false;
                    if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
                });

                window.showToast && window.showToast('Кликните для начала, двойной клик — завершить, ESC — отменить', false);
                if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
            },

            _stopDraw: function() {
                if (_drawInter) {
                    if (_drawInter._rmbBlock) {
                        map.getViewport().removeEventListener('mousedown', _drawInter._rmbBlock, true);
                    }
                    map.removeInteraction(_drawInter);
                    _drawInter = null;
                }
                _msrDrawSource.clear();
                if (_tipOverlay) { map.removeOverlay(_tipOverlay); _tipOverlay = null; _tipEl = null; }
                map.getTargetElement().style.cursor = 'default';
                window._msrDrawingActive = false; // разрешаем идентификацию слоёв
            },

            stop: function() {
                _mode = null;
                _continuous = false;
                this._stopDraw(); // уже сбрасывает _msrDrawingActive
                this._cleanupEdit(); // на случай если был edit
                if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
            },

            // Для совместимости с ESC и внешними вызовами
            _clearTemp:      function() { this._stopDraw(); if (_mode) this.start(_mode); },
            _detachHandlers: function() { this._stopDraw(); },
            pts: [], // заглушка для совместимости

            clear: function() {
                this._stopDraw();
                _mode = null;
                _continuous = false;
                var copy = _msrGroups.slice();
                if (copy.length > 0) _msrRemoveGroupBatch(copy);
                if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
            },

            // ── Редактирование вершин ─────────────────────────────────────────
            startEdit: function() {
                if (!this._isAllowed()) return;
                // Полная очистка предыдущего состояния перед перезапуском
                this._cleanupEdit();
                this._stopDraw();
                _mode = null;
                _editMode = true;
                _selectedEf = null;
                map.getTargetElement().style.cursor = 'crosshair';
                window._msrDrawingActive = true; // блокируем идентификацию слоёв

                // Рисуем dot для каждой вершины всех групп
                _msrGroups.forEach(function(g) {
                    if (!g.pts || g.pts.length < 2) return;
                    g.pts.forEach(function(ll, idx) {
                        var ef = new ol.Feature({ geometry: new ol.geom.Point(_olFromLatLng(ll)) });
                        ef.setStyle(_msrEditDotStyle(T.markerColor, false));
                        ef._isEditFeature = true;
                        ef._group = g;
                        ef._idx   = idx;
                        _msrVectorSource.addFeature(ef);
                        _editFeatures.push(ef);
                    });
                });

                // ЛКМ — выбрать вершину
                _editClickFn = function(e) {
                    if (!_editMode) return;
                    var found = false;
                    map.forEachFeatureAtPixel(e.pixel, function(f) {
                        if (!f._isEditFeature) return;
                        found = true;
                        if (_selectedEf === f) {
                            f.setStyle(_msrEditDotStyle(T.markerColor, false));
                            _selectedEf = null;
                        } else {
                            if (_selectedEf) _selectedEf.setStyle(_msrEditDotStyle(T.markerColor, false));
                            _selectedEf = f;
                            f.setStyle(_msrEditDotStyle(T.markerColor, true));
                            window.showToast && window.showToast('✅ Вершина выбрана — ПКМ чтобы переместить', false);
                        }
                        return true; // stop iterating
                    });
                    // Клик мимо вершин — снять выделение
                    if (!found && _selectedEf) {
                        _selectedEf.setStyle(_msrEditDotStyle(T.markerColor, false));
                        _selectedEf = null;
                    }
                };
                map.on('singleclick', _editClickFn);

                // ПКМ — переместить выбранную вершину
                _editCtxFn = function(e) {
                    if (!_selectedEf) return;
                    e.preventDefault();
                    e.stopPropagation();
                    var rect  = map.getTargetElement().getBoundingClientRect();
                    var coord = map.getCoordinateFromPixel([e.clientX - rect.left, e.clientY - rect.top]);
                    if (!coord) return;
                    // Берём данные до любых сбросов
                    var ef    = _selectedEf;
                    var g     = ef._group;
                    var idx   = ef._idx;
                    var oldPt = g.pts[idx];
                    g.pts[idx] = _olToLatLng(coord);
                    _msrRebuildGroupGeometry(g, T);
                    _msrPushHistory([], []); // маркер: вершина изменена (для undo не реализован полный снапшот, но фиксируем)
                    // Обновляем только позицию этой edit-точки — без полного пересоздания
                    ef.getGeometry().setCoordinates(coord);
                    ef._group = g;
                    ef._idx   = idx;
                    // Снимаем выделение
                    ef.setStyle(_msrEditDotStyle(T.markerColor, false));
                    _selectedEf = null;
                    window.showToast && window.showToast('📍 Вершина перемещена', false);
                };
                map.getTargetElement().addEventListener('contextmenu', _editCtxFn);

                window.showToast && window.showToast('ЛКМ по вершине — выбрать  •  ПКМ — переместить  •  ESC — выйти', false);
            },

            // Внутренняя очистка редактирования без проверки флага
            _cleanupEdit: function() {
                if (_editClickFn) { map.un('singleclick', _editClickFn); _editClickFn = null; }
                if (_editCtxFn)   { map.getTargetElement().removeEventListener('contextmenu', _editCtxFn); _editCtxFn = null; }
                // Удаляем все edit-фичи из source
                _editFeatures.forEach(function(f){
                    try { _msrVectorSource.removeFeature(f); } catch(_) {}
                });
                _editFeatures = [];
                _selectedEf = null;
                _editMode = false;
                window._msrDrawingActive = false; // разрешаем идентификацию слоёв
            },

            stopEdit: function() {
                this._cleanupEdit();
                map.getTargetElement().style.cursor = 'default';
            }
        };

        return T;
    })();

    // ── Завершение измерений ─────────────────────────────────────────────────
    function _msrFinish(T) {
        if (!T || (T.mode !== 'distance' && T.mode !== 'area')) return;
        if (!T._isAllowed()) { T._clearTemp(); return; }

        if (T.mode === 'distance' && T.pts.length > 1) {
            _msrFinishLine(T.pts, T);
        } else if (T.mode === 'area' && T.pts.length > 2) {
            _msrFinishPolygon(T.pts, T);
        }

        T._tempFeatures.forEach(f => _msrVectorSource.removeFeature(f));
        T._tempFeatures = [];
        if (T._tempOverlay) { map.removeOverlay(T._tempOverlay); T._tempOverlay = null; T._tempOverlayEl = null; }

        if (T._continuous) T.restart();
        else T.stop();
        if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
    }

    function _msrFinishLine(pts, T) {
        const group = { features: [], overlays: [], pts: [...pts] };
        let totalDist = 0;

        // Главная линия
        const lineF = new ol.Feature({ geometry: new ol.geom.LineString(pts.map(_olToCoord)) });
        lineF.setStyle(_msrLineStyle(T.lineColor, false));
        lineF._isMeasureMain = true;
        group.features.push(lineF);

        // Вершины
        pts.forEach(ll => {
            const df = new ol.Feature({ geometry: new ol.geom.Point(_olToCoord(ll)) });
            df.setStyle(_msrDotStyle(T.markerColor));
            df._isVertexDot = true;
            group.features.push(df);
        });

        // Сегменты + тултипы
        for (let i=0;i<pts.length-1;i++) {
            const seg = _olDistBetween(pts[i], pts[i+1]);
            totalDist += seg;
            const mid = { lng: (pts[i].lng+pts[i+1].lng)/2, lat: (pts[i].lat+pts[i+1].lat)/2 };
            const ov = _msrMakeOverlay(_olToCoord(mid), T.fmtDist(seg), 'measure-tooltip measure-seg-tooltip', 'center-center');
            ov._isSeg = true;
            group.overlays.push(ov);
        }

        // Итого у последней точки
        const lastOv = _msrMakeOverlay(_olToCoord(pts[pts.length-1]),
            `<span class="msr-popup-value">${T.fmtDist(totalDist)}</span>`,
            'measure-tooltip measure-total-tooltip msr-result-popup', 'bottom-center');
        group.overlays.push(lastOv);

        _msrAddGroup(group);
    }

    function _msrFinishPolygon(pts, T) {
        const group = { features: [], overlays: [], pts: [...pts] };
        const area  = T.calculateArea(pts);

        const polyF = new ol.Feature({ geometry: new ol.geom.Polygon([pts.map(_olToCoord)]) });
        polyF.setStyle(_msrFillStyle(T.lineColor, T.markerColor));
        polyF._isMeasureMain = true;
        group.features.push(polyF);

        pts.forEach(ll => {
            const df = new ol.Feature({ geometry: new ol.geom.Point(_olToCoord(ll)) });
            df.setStyle(_msrDotStyle(T.markerColor));
            df._isVertexDot = true;
            group.features.push(df);
        });

        const center = { lng: pts.reduce((s,p)=>s+p.lng,0)/pts.length, lat: pts.reduce((s,p)=>s+p.lat,0)/pts.length };
        const ov = _msrMakeOverlay(_olToCoord(center),
            `<span class="msr-popup-value">Итог: ${T.fmtArea(area)}</span>`,
            'measure-tooltip msr-result-popup', 'center-center');
        group.overlays.push(ov);

        _msrAddGroup(group);
    }

    function _msrFinishPolygonFromPoints(pts, T) {
        _msrFinishPolygon(pts, T);
        if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
    }

    function _msrFinishDirection(p1, p2, T) {
        const bearing  = T.calculateBearing(p1, p2);
        const cardinal = T.bearingToCardinal(bearing);
        const dist     = _olDistBetween(p1, p2);
        const group    = { features: [], overlays: [], pts: [p1, p2] };

        // Линия
        const lineF = new ol.Feature({ geometry: new ol.geom.LineString([_olToCoord(p1), _olToCoord(p2)]) });
        lineF.setStyle(_msrLineStyle(T.lineColor, false));
        lineF._isMeasureMain = true;
        group.features.push(lineF);

        // Стрелка (SVG-символ через ol.style.Icon)
        const arrowF = new ol.Feature({ geometry: new ol.geom.Point(_olToCoord(p2)) });
        arrowF.setStyle(new ol.style.Style({ image: new ol.style.Icon({
            src: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="-10 -10 20 20"><polygon points="0,-9 5,5 0,2 -5,5" fill="${encodeURIComponent(T.lineColor)}"/></svg>`,
            rotation: bearing * Math.PI / 180,
            anchor: [0.5, 0.5]
        }) }));
        group.features.push(arrowF);

        // Вершины
        [p1, p2].forEach(ll => {
            const df = new ol.Feature({ geometry: new ol.geom.Point(_olToCoord(ll)) });
            df.setStyle(_msrDotStyle(T.markerColor));
            df._isVertexDot = true;
            group.features.push(df);
        });

        // Подпись
        const mid = { lng: (p1.lng+p2.lng)/2, lat: (p1.lat+p2.lat)/2 };
        const ov  = _msrMakeOverlay(_olToCoord(mid),
            `<span class="msr-popup-value">${cardinal}  ${bearing.toFixed(1)}°</span><span class="msr-popup-sub">${T.fmtDist(dist)}</span>`,
            'measure-tooltip msr-result-popup', 'bottom-center');
        group.overlays.push(ov);

        _msrAddGroup(group);
    }

    function _msrRebuildGroupGeometry(g, T) {
        const mainF = g.features.find(f => f._isMeasureMain);
        if (!mainF) return;
        const geomType = mainF.getGeometry().getType();
        const segOvs   = g.overlays.filter(ov => ov._isSeg);
        const totalOvs = g.overlays.filter(ov => !ov._isSeg);
        const isPolygon   = geomType === 'Polygon';
        const isDirection = !isPolygon && segOvs.length === 0 && g.pts.length === 2;

        // 1. Основная геометрия
        if (isPolygon) {
            mainF.getGeometry().setCoordinates([g.pts.map(_olToCoord)]);
        } else {
            mainF.getGeometry().setCoordinates(g.pts.map(_olToCoord));
        }

        // 2. Dot-вершины
        const dots = g.features.filter(f => f._isVertexDot);
        g.pts.forEach((ll, i) => { if (dots[i]) dots[i].getGeometry().setCoordinates(_olToCoord(ll)); });

        // 3. Стрелка азимута
        if (isDirection) {
            const arrowF = g.features.find(f => f !== mainF && !f._isVertexDot);
            if (arrowF) {
                const bearing = T.calculateBearing(g.pts[0], g.pts[1]);
                arrowF.getGeometry().setCoordinates(_olToCoord(g.pts[1]));
                arrowF.setStyle(new ol.style.Style({ image: new ol.style.Icon({
                    src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="-10 -10 20 20"><polygon points="0,-9 5,5 0,2 -5,5" fill="' + encodeURIComponent(T.lineColor) + '"/></svg>',
                    rotation: bearing * Math.PI / 180,
                    anchor: [0.5, 0.5]
                }) }));
            }
        }

        // 4. Тултипы сегментов (расстояние)
        segOvs.forEach((ov, i) => {
            if (i >= g.pts.length - 1) return;
            const seg = _olDistBetween(g.pts[i], g.pts[i+1]);
            const mid = { lng: (g.pts[i].lng+g.pts[i+1].lng)/2, lat: (g.pts[i].lat+g.pts[i+1].lat)/2 };
            ov.getElement().innerHTML = T.fmtDist(seg);
            ov.setPosition(_olToCoord(mid));
        });

        // 5. Итоговый тултип
        if (totalOvs.length > 0) {
            const totOv = totalOvs[0];
            if (isPolygon) {
                const area = T.calculateArea(g.pts);
                const center = { lng: g.pts.reduce((s,p)=>s+p.lng,0)/g.pts.length, lat: g.pts.reduce((s,p)=>s+p.lat,0)/g.pts.length };
                totOv.getElement().innerHTML = '<span class="msr-popup-value">Итог: ' + T.fmtArea(area) + '</span>';
                totOv.setPosition(_olToCoord(center));
            } else if (isDirection) {
                const bearing  = T.calculateBearing(g.pts[0], g.pts[1]);
                const cardinal = T.bearingToCardinal(bearing);
                const dist     = _olDistBetween(g.pts[0], g.pts[1]);
                const mid = { lng: (g.pts[0].lng+g.pts[1].lng)/2, lat: (g.pts[0].lat+g.pts[1].lat)/2 };
                totOv.getElement().innerHTML = '<span class="msr-popup-value">' + cardinal + '  ' + bearing.toFixed(1) + '°</span><span class="msr-popup-sub">' + T.fmtDist(dist) + '</span>';
                totOv.setPosition(_olToCoord(mid));
            } else {
                let totalDist = 0;
                for (let i = 0; i < g.pts.length-1; i++) totalDist += _olDistBetween(g.pts[i], g.pts[i+1]);
                totOv.getElement().innerHTML = '<span class="msr-popup-value">' + T.fmtDist(totalDist) + '</span>';
                totOv.setPosition(_olToCoord(g.pts[g.pts.length-1]));
            }
        }
    }

    // ── Глобальные алиасы (совместимость с buildMeasurePopover) ─────────────
    window._msrIsActive = false;
    window._msrHasEverMeasured = false;

    window._measureStartMode = function(mode) {
        const T = window.MeasureTool;
        if (!T) return;
        T._continuous = false;
        T.start(mode);
        window._msrIsActive = true;
        window._msrHasEverMeasured = true;
        if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
    };
    window._measureStopAll = function() {
        const T = window.MeasureTool;
        if (T) { T._continuous = false; T.stop(); }
        window._msrIsActive = false;
    };
    window._msrDeactivate = function() {
        const T = window.MeasureTool;
        if (T) { T.clear(); T._continuous = false; }
        window._msrIsActive = false;
        window._msrHasEverMeasured = false;
        map.getTargetElement().style.cursor = 'default';
        const btn = document.querySelector('.mib-btn[data-tool="measure"]');
        if (btn) btn.classList.remove('msr-on', 'active-panel');
    };

    // ── Горячие клавиши измерений ───────────────────────────────────────────────
    document.addEventListener('keydown', function(e) {
        // Не перехватываем если фокус в текстовом поле
        const tag = (document.activeElement || {}).tagName || '';
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

        const T = window.MeasureTool;

        // ── ESC: отмена текущего рисования ──────────────────────────────────
        if (e.key === 'Escape') {
            if (!T || !T._isAllowed()) return;
            if (T.editMode) { T.stopEdit(); return; }
            if (!T.mode && !T._continuous) return;
            T._stopDraw && T._stopDraw();
            T._cleanupEdit && T._cleanupEdit();
            T._continuous = false;
            if (typeof T._detachHandlers === 'function') T._detachHandlers();
            T.mode = null;
            window._msrDrawingActive = false;
            map.getTargetElement().style.cursor = 'default';
            if (_msrGroups.length === 0) {
                window._msrHasEverMeasured = false;
                if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
            }
            return;
        }

        // Остальные горячие клавиши — не в инпутах
        if (inInput) return;

        // ── DEL / Delete: удалить все замеры ────────────────────────────────
        if (e.key === 'Delete' || e.key === 'Del') {
            if (_msrGroups.length === 0) return;
            e.preventDefault();
            const allGroups = [..._msrGroups];
            _msrRemoveGroupBatch(allGroups);
            window.showToast && window.showToast('❌ Все замеры удалены  (↩ Ctrl+Z)', false);
            return;
        }

        // ── Ctrl+Z: отменить последнее действие ─────────────────────────────
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
            e.preventDefault();
            _msrUndo();
            return;
        }

        // ── Ctrl+Y / Ctrl+Shift+Z: повторить отменённое ──────────────────────
        if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
            ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
            e.preventDefault();
            _msrRedo();
            return;
        }
    });

    // ── Стили тултипов и попапов ─────────────────────────────────────────────
    (function _msrInjectStyles() {
        if (document.getElementById('msr-tooltip-css')) return;
        const s = document.createElement('style'); s.id = 'msr-tooltip-css';
        s.textContent = `
            .measure-tooltip {
                background: rgba(21,41,24,0.85); color: #fff; padding: 4px 9px;
                border-radius: 8px; font-size: 12px; font-weight: 700;
                font-family: Lato, sans-serif; white-space: pre; pointer-events: none;
                box-shadow: 0 2px 6px rgba(0,0,0,.25); line-height: 1.5;
            }
            .measure-seg-tooltip { font-size: 11px; padding: 3px 7px; background: rgba(21,41,24,.75); }
            .measure-total-tooltip { background: rgba(10,30,10,0.92); font-size: 13px; }
            .measure-dir-tooltip { background: rgba(21,41,70,0.9); }
            .msr-result-popup { background: #fff; border-radius: 10px; box-shadow: 0 3px 12px rgba(0,0,0,.18); padding: 7px 12px; color: #1a2e1a; font-family: Lato,sans-serif; }
            .msr-popup-value { font-size: 15px; font-weight: 800; color: #1a2e1a; display: block; }
            .msr-popup-sub   { font-size: 12px; color: #888; display: block; margin-top: 2px; }
        `;
        document.head.appendChild(s);
    })();

    // ==========================================
    // 23. ПАНЕЛЬ КООРДИНАТ (OpenLayers)
    // ==========================================
    function buildCoordsPanel() {
        if (document.getElementById('coords-panel')) return;

        if (typeof proj4 === 'undefined') {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.js';
            s.onload = setupProj4;
            document.head.appendChild(s);
        } else {
            setupProj4();
        }

        function setupProj4() {
            const TW = '+towgs84=23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12';
            proj4.defs([
                ['SK42_Z4', `+proj=tmerc +lat_0=0 +lon_0=21 +k=1 +x_0=4500000 +y_0=0 +ellps=krass ${TW} +units=m +no_defs`],
                ['SK42_Z5', `+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=5500000 +y_0=0 +ellps=krass ${TW} +units=m +no_defs`],
                ['SK42_Z6', `+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=6500000 +y_0=0 +ellps=krass ${TW} +units=m +no_defs`],
                ['UTM_35N', '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs'],
                ['SK63_Z4', `+proj=tmerc +lat_0=0.08333333333 +lon_0=21.5 +k=1 +x_0=4250000 +y_0=-12900.57 +ellps=krass ${TW} +units=m +no_defs`],
                ['SK63_Z5', `+proj=tmerc +lat_0=0.08333333333 +lon_0=24.5 +k=1 +x_0=5250000 +y_0=-12900.57 +ellps=krass ${TW} +units=m +no_defs`]
            ]);

            const panel = document.createElement('div');
            panel.id = 'coords-panel';
            panel.innerHTML = `
            <div id="coords-header">
                <span>📍 Координаты</span>
                <span class="close-coords" id="close-coords-btn">×</span>
            </div>
            <div id="coords-search-box" style="padding:10px 12px 0;display:flex;gap:6px;align-items:stretch;">
                <button id="coords-pick-btn" title="Указать точку" style="background:#82e938;border:none;color:#152918;border-radius:4px;cursor:pointer;padding:0 10px;font-weight:bold;">
                    <i class="fa-solid fa-location-crosshairs"></i>
                </button>
                <input type="text" id="coords-input-lat" placeholder="Широта (Lat)" style="flex:1;width:0;background:rgba(0,0,0,0.3);border:1px solid rgba(130,233,56,0.5);color:#fff;padding:6px 8px;border-radius:4px;font-size:12px;outline:none;font-family:Lato,sans-serif;">
                <input type="text" id="coords-input-lng" placeholder="Долгота (Lng)" style="flex:1;width:0;background:rgba(0,0,0,0.3);border:1px solid rgba(130,233,56,0.5);color:#fff;padding:6px 8px;border-radius:4px;font-size:12px;outline:none;font-family:Lato,sans-serif;">
                <button id="coords-search-btn" title="Найти" style="background:#82e938;border:none;color:#152918;border-radius:4px;cursor:pointer;padding:0 12px;font-weight:bold;">
                    <i class="fa-solid fa-magnifying-glass"></i>
                </button>
            </div>
            <div id="coords-content">
                <div class="coord-row"><span class="coord-label">WGS-84:</span><span class="coord-val" id="val-wgs">—</span></div>
                <div class="coord-row"><span class="coord-label">UTM 35N:</span><span class="coord-val" id="val-utm">—</span></div>
                <div class="coord-row"><span class="coord-label">СК-42 (Z4):</span><span class="coord-val" id="val-sk42-4">—</span></div>
                <div class="coord-row"><span class="coord-label">СК-42 (Z5):</span><span class="coord-val" id="val-sk42-5">—</span></div>
                <div class="coord-row"><span class="coord-label">СК-42 (Z6):</span><span class="coord-val" id="val-sk42-6">—</span></div>
                <div class="coord-row"><span class="coord-label">СК-63:</span><span class="coord-val" id="val-sk63">—</span></div>
            </div>`;
            document.getElementById('map').appendChild(panel);

            ['wheel','mousedown','dblclick','touchstart','click'].forEach(ev => {
                panel.addEventListener(ev, e => e.stopPropagation(), ev === 'wheel' || ev === 'touchstart' ? { passive: true } : false);
            });

            document.getElementById('close-coords-btn').onclick = () => { panel.style.display = 'none'; };

            const fmt = (res) => `X: ${res[1].toFixed(0)} | Y: ${res[0].toFixed(0)}`;

            // [PERF-FIX] DOM-элементы кешируем один раз при создании панели —
            // раньше на каждый pointermove делалось 6× document.getElementById().
            const _cEl = {
                wgs:    document.getElementById('val-wgs'),
                utm:    document.getElementById('val-utm'),
                sk424:  document.getElementById('val-sk42-4'),
                sk425:  document.getElementById('val-sk42-5'),
                sk426:  document.getElementById('val-sk42-6'),
                sk63:   document.getElementById('val-sk63')
            };

            // [PERF-FIX] rAF-throttle — пересчёт 5 проекций (proj4) идёт не чаще
            // раза за кадр, а не на каждое сырое событие pointermove.
            let _coordsHoverRaf = null;
            let _coordsHoverCoord = null;
            map.on('pointermove', (e) => {
                if (!panel || panel.style.display === 'none') return;
                _coordsHoverCoord = e.coordinate;
                if (_coordsHoverRaf) return;
                _coordsHoverRaf = requestAnimationFrame(() => {
                    _coordsHoverRaf = null;
                    if (!panel || panel.style.display === 'none' || !_coordsHoverCoord) return;
                    const coord4326 = ol.proj.toLonLat(_coordsHoverCoord);
                    const lng = coord4326[0], lat = coord4326[1];
                    if (!_cEl.wgs) return;
                    _cEl.wgs.innerText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
                    try { _cEl.utm.innerText   = fmt(proj4('EPSG:4326', 'UTM_35N', [lng, lat])); } catch(_) {}
                    try { _cEl.sk424.innerText = fmt(proj4('EPSG:4326', 'SK42_Z4', [lng, lat])); } catch(_) {}
                    try { _cEl.sk425.innerText = fmt(proj4('EPSG:4326', 'SK42_Z5', [lng, lat])); } catch(_) {}
                    try { _cEl.sk426.innerText = fmt(proj4('EPSG:4326', 'SK42_Z6', [lng, lat])); } catch(_) {}
                    try {
                        const sk = lng < 24 ? proj4('EPSG:4326', 'SK63_Z4', [lng, lat]) : proj4('EPSG:4326', 'SK63_Z5', [lng, lat]);
                        _cEl.sk63.innerText = fmt(sk);
                    } catch(_) {}
                });
            });

            // Пикинг координат
            let isPicking = false;
            const pickBtn = document.getElementById('coords-pick-btn');
            pickBtn.addEventListener('click', () => {
                isPicking = !isPicking;
                pickBtn.style.background = isPicking ? '#e53935' : '#82e938';
                pickBtn.style.color = isPicking ? '#fff' : '#152918';
                if (isPicking) {
                    map.getTargetElement().style.cursor = 'crosshair';
                    map.once('singleclick', (e) => {
                        const c4326 = ol.proj.toLonLat(e.coordinate);
                        const latEl = document.getElementById('coords-input-lat');
                        const lngEl = document.getElementById('coords-input-lng');
                        if (latEl) latEl.value = c4326[1].toFixed(6);
                        if (lngEl) lngEl.value = c4326[0].toFixed(6);
                        isPicking = false;
                        pickBtn.style.background = '#82e938';
                        pickBtn.style.color = '#152918';
                        map.getTargetElement().style.cursor = 'default';
                    });
                } else {
                    map.getTargetElement().style.cursor = 'default';
                }
            });

            function goCoords() {
                const latEl = document.getElementById('coords-input-lat');
                const lngEl = document.getElementById('coords-input-lng');
                const lat = parseFloat((latEl ? latEl.value : '').replace(/,/g, '.'));
                const lng = parseFloat((lngEl ? lngEl.value : '').replace(/,/g, '.'));
                if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                    window.showToast && window.showToast('Неверные координаты', true);
                    return;
                }
                view.animate({ center: ol.proj.fromLonLat([lng, lat]), zoom: 16, duration: 1200 });
            }

            document.getElementById('coords-search-btn').onclick = goCoords;
            document.getElementById('coords-input-lng').addEventListener('keydown', e => { if (e.key === 'Enter') goCoords(); });
        }
    }

    // ==========================================
    // 24. HOTSPOTS (Тепловые аномалии) — OL
    // ==========================================
    // Hotspot слои хранятся в _layers['hs-src']

    function _removeHsLayer() {
        if (_layers['hs-src']) {
            map.removeLayer(_layers['hs-src']);
            delete _layers['hs-src'];
        }
        window._hsLayerGlobal = null;
    }

    // [PERF-FIX] Один общий обработчик клика по hotspot-слою вместо навешивания
    // нового map.on('singleclick', ...) при каждом вызове _loadHsLayer() (было —
    // утечка слушателей: смена даты/времени/спутника в фильтре пожаров копила
    // по одному живому обработчику на каждый вызов, не снимая старые).
    // Слой ищем через _layers['hs-src'], а не через замыкание — так обработчик
    // остаётся корректным после пересоздания слоя.
    map.on('singleclick', (e) => {
        if (window._msrDrawingActive) return; // не идентифицируем во время рисования
        const hsLayer = _layers['hs-src'];
        if (!hsLayer) return;
        const feats = map.getFeaturesAtPixel(e.pixel, { layerFilter: l => l === hsLayer });
        if (!feats || !feats.length) return;
        const p = feats[0].getProperties();
        const frp = _getFRP(p);
        const frpStr = frp != null ? ((+frp).toFixed(1) + ' МВт') : '—';
        const tempK  = p.temperature != null ? ((+p.temperature).toFixed(1) + ' K') : p.temp != null ? ((+p.temp).toFixed(1) + ' K') : '—';
        const el = document.createElement('div');
        el.className = 'ol-popup-wrapper';
        el.innerHTML = `<div class="custom-popup"><div class="popup-header"><h3>🔥 Тепловая аномалия</h3><button class="popup-header-close ol-popup-close">×</button></div>
            <div class="popup-body">
                <div class="popup-row"><span class="popup-label">Температура</span><span class="popup-val" style="color:#e53935;font-weight:800;">${tempK}</span></div>
                <div class="popup-row"><span class="popup-label">FRP</span><span class="popup-val">${frpStr}</span></div>
                <div class="popup-row"><span class="popup-label">Спутник</span><span class="popup-val">${p.satellite || p.sat || '—'}</span></div>
            </div></div>`;
        el.querySelector('.ol-popup-close').onclick = () => map.getOverlays().getArray().filter(o => o.getElement() === el).forEach(o => map.removeOverlay(o));
        const overlay = new ol.Overlay({ element: el, position: feats[0].getGeometry().getCoordinates(), positioning: 'bottom-center', offset: [0,-12], stopEvent: true });
        map.addOverlay(overlay);
    });

    function _getFRP(p) {
        if (!p) return null;
        for (const k of ['frp','FRP','fire_radiative_power','frpMW','frp_mw','power','fp']) { if (p[k]!=null&&!isNaN(+p[k])) return +p[k]; }
        for (const k of ['bright_ti4','bright_t31','brightness','brightnessTemp','bright','bt']) { if (p[k]!=null&&!isNaN(+p[k])) { const bt=+p[k]; if(bt>360)return 250; if(bt>345)return 120; if(bt>330)return 60; if(bt>315)return 20; if(bt>300)return 5; return null; } }
        return null;
    }

    function _frpColor(f) { if(f==null)return'#aaa'; return f>200?'#b71c1c':f>100?'#e53935':f>50?'#ff7043':f>10?'#ffb300':f>2?'#ffd54f':'#ffe082'; }
    function _frpR(f) { if(f==null)return 9; return f>200?16:f>100?14:f>50?12:f>10?10:f>2?8:7; }

    function _hsTempBucket(p) {
        const frp = _getFRP(p);
        if (frp==null) return 0;
        return frp>200?5:frp>100?4:frp>50?3:frp>10?2:frp>2?1:0;
    }

    window._loadHsLayer = async function(date, fromMins, toMins, satFilter) {
        _removeHsLayer();
        function _mhm(m) { m=Math.min(m,1439); return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); }
        let url = `/api/hotspots?date=${date}&time_from=${_mhm(fromMins)}&time_to=${_mhm(toMins)}`;
        if (satFilter && satFilter !== 'all') url += `&satellite=${satFilter}`;
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const geo = await resp.json();
            if (!geo.features || !geo.features.length) return { count: 0 };

            // Добавляем bucket цвет
            geo.features.forEach(f => { f.properties._c = _hsTempBucket(f.properties); });

            const format = new ol.format.GeoJSON();
            const features = format.readFeatures(geo, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

            const source = new ol.source.Vector({ features });
            const hsLayer = new ol.layer.Vector({
                source,
                zIndex: 350,
                style: function(feature) {
                    const bucket = feature.get('_c') || 0;
                    const colors = ['#ffe082','#ffd54f','#ffb300','#ff7043','#e53935','#b71c1c'];
                    const radii  = [7,7,8,9,10,12];
                    return new ol.style.Style({
                        image: new ol.style.Circle({
                            radius: (radii[bucket] || 7) * 1.6,
                            fill: new ol.style.Fill({ color: colors[bucket] || '#ffe082' }),
                            stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
                        })
                    });
                }
            });

            _layers['hs-src'] = hsLayer;
            map.addLayer(hsLayer);
            window._hsLayerGlobal = { layer: hsLayer };
            // Клик по точке обрабатывается общим слушателем (см. выше, объявлен один раз
            // рядом с _removeHsLayer) — здесь больше не регистрируем.

            return { count: features.length };
        } catch(e) { return { error: e.message }; }
    };

    // ==========================================
    // 25. HIGHLIGHT (GetFeatureInfo)
    // ==========================================
    const _HIGHLIGHT_COLORS = ['#2196f3','#4caf50','#ff9800','#e91e63','#9c27b0','#00bcd4'];
    const _highlightSource = new ol.source.Vector();
    // [PERF-FIX] Стилевая функция вызывается на каждый рендер-проход по каждой
    // feature. Настройки цвета/прозрачности подсветки меняются очень редко
    // (только из панели настроек), поэтому кешируем готовые ol.style.Style —
    // localStorage по-прежнему читается каждый раз (значения могут поменяться
    // извне), но hex→rgb парсинг и создание Style-объектов пересчитываются
    // только когда сырые значения из localStorage реально изменились.
    let _hlStyleCacheKey = null;
    let _hlStyleCache = null;
    function _buildHighlightStyle() {
        const baseColor = localStorage.getItem('ui_hl_color') || '#2196f3';
        const opacityRaw = localStorage.getItem('ui_hl_opacity');
        const cacheKey = baseColor + '|' + opacityRaw;
        if (_hlStyleCacheKey === cacheKey && _hlStyleCache) return _hlStyleCache;

        const opacity = parseFloat(opacityRaw ?? '0.28');
        // Конвертируем hex + opacity в rgba
        const r = parseInt(baseColor.slice(1,3),16);
        const g = parseInt(baseColor.slice(3,5),16);
        const b = parseInt(baseColor.slice(5,7),16);
        const fillRgba   = `rgba(${r},${g},${b},${opacity})`;
        const strokeRgba = `rgba(${r},${g},${b},${Math.min(1, opacity + 0.5)})`;
        _hlStyleCache = [
            new ol.style.Style({ fill: new ol.style.Fill({ color: fillRgba }) }),
            new ol.style.Style({ stroke: new ol.style.Stroke({ color: strokeRgba, width: 2.5 }) })
        ];
        _hlStyleCacheKey = cacheKey;
        return _hlStyleCache;
    }
    const _highlightLayer  = new ol.layer.Vector({
        source: _highlightSource,
        zIndex: 320,
        style: function(feature) {
            return _buildHighlightStyle();
        }
    });
    map.addLayer(_highlightLayer);

    function _showIdentifyHighlight(geoFeatures, dataProj, featureIndex) {
        _highlightSource.clear();
        if (!geoFeatures || !geoFeatures.length) return;
        const srcProj = dataProj || 'EPSG:4326';
        // Подсвечиваем объект по индексу (для навигации по фичам в попапе).
        // Если индекс не передан — показываем первый объект.
        const idx = (featureIndex !== undefined && featureIndex >= 0 && featureIndex < geoFeatures.length)
            ? featureIndex : 0;
        const feat = geoFeatures[idx];
        const format = new ol.format.GeoJSON();
        try {
            const olFeats = format.readFeatures(feat, { dataProjection: srcProj, featureProjection: 'EPSG:3857' });
            olFeats.forEach(f => {
                f.set('_hl_color', _HIGHLIGHT_COLORS[0]);
                _highlightSource.addFeature(f);
            });
        } catch(e) {}
    }

    // OL Overlay для info-float-popup (привязан к координате на карте)
    let _infoOverlay = null;
    let _infoOverlayCoord = null; // координата последнего клика (EPSG:3857)

    function _positionInfoPopup(clientX, clientY) {
        // Больше не используется для позиционирования — OL Overlay сам следит за координатой.
        // Оставлена пустой для совместимости с вызовами из _updateInfoPopupTabs.
    }

    function _showInfoPopup(layersData, lngLat, clientX, clientY) {
        // Получаем или создаём ANCHOR-точку (нулевой div = точка привязки на карте)
        let anchor = document.getElementById('info-float-anchor');
        let popup  = document.getElementById('info-float-popup');
        if (!anchor) {
            anchor = document.createElement('div');
            anchor.id = 'info-float-anchor';
            anchor.style.cssText = 'position:absolute;width:0;height:0;overflow:visible;pointer-events:none;';

            popup = document.createElement('div');
            popup.id = 'info-float-popup';
            popup.innerHTML = `
                <div id="info-float-header">
                    <span id="info-float-title"></span>
                    <button id="info-float-minimize" title="Свернуть">−</button>
                    <button id="info-float-close" title="Закрыть">×</button>
                </div>
                <div id="info-float-tabs"></div>
                <div id="info-float-body"></div>`;
            anchor.appendChild(popup);
            document.getElementById('map').appendChild(anchor);

            document.getElementById('info-float-close').addEventListener('click', () => {
                popup.classList.remove('visible');
                popup.classList.remove('minimized');
                _highlightSource && _highlightSource.clear();
                if (_infoOverlay) { map.removeOverlay(_infoOverlay); _infoOverlay = null; }
            });
            document.getElementById('info-float-minimize').addEventListener('click', () => {
                popup.classList.toggle('minimized');
            });
        }

        // Координата привязки (EPSG:3857)
        const mapRect = document.getElementById('map').getBoundingClientRect();
        const px = [clientX - mapRect.left, clientY - mapRect.top];
        const coord3857 = map.getCoordinateFromPixel(px) || ol.proj.fromLonLat([lngLat.lng, lngLat.lat]);
        _infoOverlayCoord = coord3857;

        // OL Overlay ставит anchor в точку координаты (top-left = coordinate)
        if (_infoOverlay) { map.removeOverlay(_infoOverlay); _infoOverlay = null; }
        _infoOverlay = new ol.Overlay({
            element: anchor,
            position: coord3857,
            positioning: 'bottom-center',  // нижний центр anchor = точка на карте
            offset: [0, 0],
            stopEvent: true,
            autoPan: false
        });
        map.addOverlay(_infoOverlay);

        const tabsEl = document.getElementById('info-float-tabs');
        const bodyEl = document.getElementById('info-float-body');
        if (!tabsEl || !bodyEl) return;

        // Заголовок
        const titleEl = document.getElementById('info-float-title');
        if (titleEl) titleEl.textContent = layersData[0] ? layersData[0].title : '';

        tabsEl.innerHTML = '';
        popup.classList.remove('minimized');

        layersData.forEach((ld, i) => {
            const tab = document.createElement('div');
            tab.className = 'ift-tab' + (i===0?' active':'');
            tab.innerHTML = `${ld.title}<span class="ift-tab-cnt">${ld.features.length}</span>`;
            tab.addEventListener('click', () => {
                tabsEl.querySelectorAll('.ift-tab').forEach(t=>t.classList.remove('active'));
                tab.classList.add('active');
                renderBody(ld);
                _showIdentifyHighlight(ld.geoFeatures || [], ld.geomProj || 'EPSG:4326');
            });
            tabsEl.appendChild(tab);
        });

        bodyEl.innerHTML = '';
        _highlightSource.clear();
        renderBody(layersData[0]);
        popup.classList.add('visible');
        _showIdentifyHighlight(layersData[0].geoFeatures || [], layersData[0].geomProj || 'EPSG:4326');

        function renderBody(layerData, startIndex) {
            bodyEl.innerHTML = '';
            if (!layerData || !layerData.features.length) {
                bodyEl.innerHTML = `<div class="iff-empty"><i class="fa-regular fa-folder-open"></i>Объектов не найдено</div>`;
                return;
            }
            const total = layerData.features.length;
            let currentIdx = (startIndex !== undefined) ? startIndex : 0;
            if (currentIdx < 0) currentIdx = 0;
            if (currentIdx >= total) currentIdx = total - 1;

            function renderFeatureAt(idx) {
                bodyEl.innerHTML = '';
                // Навигация (только если объектов больше одного)
                if (total > 1) {
                    const nav = document.createElement('div');
                    nav.className = 'iff-nav';
                    nav.innerHTML = `
                        <button class="iff-nav-btn" id="iff-nav-prev" ${idx === 0 ? 'disabled' : ''}>&#8249;</button>
                        <span class="iff-nav-counter">${idx + 1} / ${total}</span>
                        <button class="iff-nav-btn" id="iff-nav-next" ${idx === total - 1 ? 'disabled' : ''}>&#8250;</button>`;
                    nav.querySelector('#iff-nav-prev').addEventListener('click', () => {
                        currentIdx = Math.max(0, currentIdx - 1);
                        renderFeatureAt(currentIdx);
                        _showIdentifyHighlight(layerData.geoFeatures || [], layerData.geomProj || 'EPSG:4326', currentIdx);
                    });
                    nav.querySelector('#iff-nav-next').addEventListener('click', () => {
                        currentIdx = Math.min(total - 1, currentIdx + 1);
                        renderFeatureAt(currentIdx);
                        _showIdentifyHighlight(layerData.geoFeatures || [], layerData.geomProj || 'EPSG:4326', currentIdx);
                    });
                    bodyEl.appendChild(nav);
                }
                const feat = layerData.features[idx];
                const card = document.createElement('div'); card.className = 'iff-card';
                let html = '';
                const entries = Object.entries(feat.properties||{}).filter(([,v])=>v!==null&&v!==undefined&&v!=='');
                if (!entries.length) { html += `<div style="color:rgba(130,233,56,0.3);font-size:12px;padding:4px 0;">Нет данных</div>`; }
                else entries.forEach(([k,v])=>{
                    // Переводим подписи полей на русский по словарю _POPUP_FIELD_MAP (по слоям).
                    // Для выделов РБ дополнительно: убираем Quarter id и расшифровываем
                    // номер лесхоза в его название + округляем площадь до десятых.
                    let dk = k, dv = v;
                    const lm = (window._POPUP_FIELD_MAP || {})[layerData.key];
                    if (layerData.key === 'gs_allotment' || layerData.key === 'gs_allotment_min') {
                        if (k === 'Quarter id') return; // не показываем ID квартала
                        if (k === 'Forest number') {
                            dk = 'Название лесхоза';
                            const info = (window.MANUAL_FORESTRY_FIX||[]).find(x => String(x.code) === String(v));
                            dv = info ? info.name : v;
                        } else if (lm && lm[k]) {
                            dk = lm[k];
                            if (k === 'Area') { const num = parseFloat(v); if (!isNaN(num)) dv = num.toFixed(1); }
                        }
                    } else if (lm && lm[k]) {
                        dk = lm[k];
                    }
                    // [A] SECURITY: экранируем k и v — данные от GeoServer могут содержать HTML
                    const str=window.safeEscape(String(dv)); const long=str.length>45;
                    const ek=window.safeEscape(String(dk));
                    html+=`<div class="iff-row"><span class="iff-key">${ek}</span><span class="iff-val${long?' sm':''}">${str}</span></div>`;
                });
                card.innerHTML = html;
                bodyEl.appendChild(card);
                // ── ALL-PANS вектор: показываем кнопку «Открыть папку в панели ДЗЗ» ──
                if (layerData.key === 'gs_all_pans_vector') {
                    const folderHint = document.createElement('div');
                    folderHint.style.cssText = 'margin:8px 10px 10px;padding:9px 14px;background:#ede7f6;border-radius:8px;border:1.5px solid #9c7ee8;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#4a148c;font-weight:600;';
                    folderHint.innerHTML = '<i class="fa-solid fa-folder-open" style="color:#9c7ee8;font-size:14px;"></i><span>Найти снимок в панели ДЗЗ → Спутник</span><i class="fa-solid fa-arrow-right" style="margin-left:auto;color:#9c7ee8;"></i>';
                    folderHint.title = 'Открыть панель ДЗЗ и показать папку снимка';
                    folderHint.addEventListener('click', () => {
                        const rawFeat = (layerData.geoFeatures || [])[idx];
                        if (rawFeat && window._highlightDzzFolderFromVectorClick) {
                            window._highlightDzzFolderFromVectorClick(rawFeat);
                        }
                    });
                    bodyEl.appendChild(folderHint);
                }
                // ── Выделы: кнопка «Подробнее» ──
                if (layerData.key === 'gs_allotment' || layerData.key === 'gs_allotment_min') {
                    const moreBtn = document.createElement('div');
                    moreBtn.style.cssText = 'padding:10px 10px 12px;';
                    moreBtn.innerHTML = `<button class="iff-more-btn" onclick="window.showToast && window.showToast('Функция подробной информации о выделе в разработке', false)">Подробнее</button>`;
                    bodyEl.appendChild(moreBtn);
                }
            }
            renderFeatureAt(currentIdx);
            // Подсвечиваем текущий объект
            _showIdentifyHighlight(layerData.geoFeatures || [], layerData.geomProj || 'EPSG:4326', currentIdx);
        }
    }

    // Обновляет вкладки уже открытого попапа при поступлении новых данных (прогрессивный рендер)
    function _updateInfoPopupTabs(layersData, lngLat, clientX, clientY) {
        const popup  = document.getElementById('info-float-popup');
        const tabsEl = document.getElementById('info-float-tabs');
        if (!popup || !tabsEl) return;

        // Синхронизируем вкладки: добавляем только новую (последнюю в массиве)
        const ld = layersData[layersData.length - 1];
        if (!ld) return;
        const i = layersData.length - 1;
        const tab = document.createElement('div');
        tab.className = 'ift-tab';
        tab.innerHTML = `${ld.title}<span class="ift-tab-cnt">${ld.features.length}</span>`;
        const bodyEl = document.getElementById('info-float-body');
        tab.addEventListener('click', () => {
            tabsEl.querySelectorAll('.ift-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            if (bodyEl) {
                const total = ld.features.length;
                let currentIdx = 0;
                function renderTabFeatureAt(idx) {
                    bodyEl.innerHTML = '';
                    if (total > 1) {
                        const nav = document.createElement('div');
                        nav.className = 'iff-nav';
                        nav.innerHTML = `
                            <button class="iff-nav-btn" id="iff-nav-prev2" ${idx === 0 ? 'disabled' : ''}>&#8249;</button>
                            <span class="iff-nav-counter">${idx + 1} / ${total}</span>
                            <button class="iff-nav-btn" id="iff-nav-next2" ${idx === total - 1 ? 'disabled' : ''}>&#8250;</button>`;
                        nav.querySelector('#iff-nav-prev2').addEventListener('click', () => {
                            currentIdx = Math.max(0, currentIdx - 1);
                            renderTabFeatureAt(currentIdx);
                            _showIdentifyHighlight(ld.geoFeatures || [], ld.geomProj || 'EPSG:4326', currentIdx);
                        });
                        nav.querySelector('#iff-nav-next2').addEventListener('click', () => {
                            currentIdx = Math.min(total - 1, currentIdx + 1);
                            renderTabFeatureAt(currentIdx);
                            _showIdentifyHighlight(ld.geoFeatures || [], ld.geomProj || 'EPSG:4326', currentIdx);
                        });
                        bodyEl.appendChild(nav);
                    }
                    const feat = ld.features[idx];
                    const card = document.createElement('div'); card.className = 'iff-card';
                    let html = '';
                    const entries = Object.entries(feat.properties || {}).filter(([,v]) => v !== null && v !== undefined && v !== '');
                    if (!entries.length) { html += `<div style="color:rgba(130,233,56,0.3);font-size:12px;padding:4px 0;">Нет данных</div>`; }
                    else entries.forEach(([k, v]) => {
                        // Переводим подписи полей на русский по словарю _POPUP_FIELD_MAP (по слоям).
                        // Для выделов РБ дополнительно: убираем Quarter id и расшифровываем
                        // номер лесхоза в его название + округляем площадь до десятых.
                        let dk = k, dv = v;
                        const lm = (window._POPUP_FIELD_MAP || {})[ld.key];
                        if (ld.key === 'gs_allotment' || ld.key === 'gs_allotment_min') {
                            if (k === 'Quarter id') return; // не показываем ID квартала
                            if (k === 'Forest number') {
                                dk = 'Название лесхоза';
                                const info = (window.MANUAL_FORESTRY_FIX||[]).find(x => String(x.code) === String(v));
                                dv = info ? info.name : v;
                            } else if (lm && lm[k]) {
                                dk = lm[k];
                                if (k === 'Area') { const num = parseFloat(v); if (!isNaN(num)) dv = num.toFixed(1); }
                            }
                        } else if (lm && lm[k]) {
                            dk = lm[k];
                        }
                        // [A] SECURITY: экранируем данные от GeoServer
                        const str = window.safeEscape(String(dv)); const long = str.length > 45;
                        const ek = window.safeEscape(String(dk));
                        html += `<div class="iff-row"><span class="iff-key">${ek}</span><span class="iff-val${long?' sm':''}">${str}</span></div>`;
                    });
                    card.innerHTML = html;
                    bodyEl.appendChild(card);
                }
                renderTabFeatureAt(currentIdx);
                _showIdentifyHighlight(ld.geoFeatures || [], ld.geomProj || 'EPSG:4326', currentIdx);
            }
        });
        tabsEl.appendChild(tab);
    }

    // ==========================================
    // 26. DZZ КОНФИГУРАЦИЯ ВКЛАДОК
    // ==========================================
    window._dzzTabs = [
        { id:'base', icon:'fa-tree', label:'Базовое<br>лесоустройство', color:'#2e7d32',
          desc:'Материалы базового лесоустройства',
          yearFolders: {
            2026: [
                { key:'bundle_disnenski_leshoz', label:'Дисненский лесхоз', icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_disnenski_leshoz_cog','gs_disnenski_leshoz_vector'], bbox:[27.0,55.3,28.1,56.1] },
                { key:'bundle_slutski_leshoz',   label:'Слуцкий лесхоз',   icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_slutski_leshoz_cog'], bbox:[27.0,52.8,27.9,53.4] },
                { key:'bundle_lyubansky_leshoz', label:'Любанский лесхоз',  icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_lyubansky_leshoz_cog'], bbox:[27.4,52.7,28.4,53.2] },
                { key:'bundle_logoisk_leshoz',   label:'Логойский лесхоз',  icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_logoisk_leshoz_cog'], bbox:[27.5,54.0,28.2,54.6] },
                { key:'bundle_begomilsky_leshoz',label:'Бегомельский лесхоз',icon:'fa-layer-group',type:'external_bundle', subkeys:['gs_begomilsky_leshoz_cog'], bbox:[28.2,54.4,29.1,55.0] },
                { key:'bundle_surazhsky_leshoz', label:'Суражский лесхоз',  icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_surazhsky_leshoz_cog','gs_surazhsky_leshoz_vector'], bbox:[30.5,55.3,31.3,55.8] },
                { key:'bundle_volkovysk_leshoz', label:'Волковысский лесхоз',icon:'fa-layer-group',type:'external_bundle', subkeys:['gs_volkovysk_leshoz_cog'], bbox:[24.2,53.2,25.2,53.8] },
                { key:'bundle_slonim_leshoz',    label:'Слонимский лесхоз',  icon:'fa-layer-group',type:'external_bundle', subkeys:['gs_slonim_leshoz_cog','gs_slonim_leshoz_vector'], bbox:[25.0,52.9,25.8,53.5] },
                { key:'bundle_kopil_leshoz',     label:'Копыльский лесхоз',  icon:'fa-layer-group',type:'external_bundle', subkeys:['gs_kopil_leshoz_cog'], bbox:[26.6,52.8,27.5,53.3] },
                { key:'bundle_starodorosh_leshoz', label:'Стародорожский лесхоз', icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_starodorosh_leshoz_cog'], bbox:[27.8684,52.7879,28.6390,53.3348] },
                { key:'bundle_lida_leshoz',        label:'Лидский лесхоз',        icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_lida_leshoz_cog','gs_lida_leshoz_vector'],        bbox:[24.8,53.6,26.0,54.2] },
                { key:'bundle_ushachi_leshoz',     label:'Ушачский лесхоз',       icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_ushachi_leshoz_cog','gs_ushachi_leshoz_vector'], bbox:[28.0,55.0,29.1,55.6] },
            ], 2025:[
                { key:'bundle_borisov_leshoz',     label:'Борисовский лесхоз',       icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_borisov_leshoz_cog'],     bbox:[27.8, 54.0, 28.9, 54.7] },
                { key:'bundle_borovlyanski_leshoz', label:'Боровлянский спецлесхоз', icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_borovlyanski_leshoz_cog'], bbox:[27.3, 53.8, 28.1, 54.4] },
                { key:'bundle_bogushevski_leshoz',  label:'Богушевский лесхоз',      icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_bogushevski_leshoz_cog'],  bbox:[29.5, 54.4, 30.4, 54.9] },
                { key:'bundle_np_pripyat',          label:'Национальный парк "Припятский"', icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_np_pripyat_cog'], bbox:[27.5, 51.8, 29.5, 52.6] },
                { key:'bundle_glubokski_leshoz',    label:'Глубокский лесхоз',        icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_glubokski_leshoz_cog'],    bbox:[27.4, 55.0, 28.5, 55.7] },
                { key:'bundle_postavski_leshoz',    label:'Поставский лесхоз',        icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_postavski_leshoz_cog'],    bbox:[26.6, 54.8, 27.8, 55.4] },
                { key:'bundle_krupski_leshoz',      label:'Крупский лесхоз',          icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_krupski_leshoz_cog'],      bbox:[29.1, 54.2, 30.1, 54.7] },
                { key:'bundle_lepelski_leshoz',     label:'Лепельский лесхоз',        icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_lepelski_leshoz_cog'],     bbox:[28.0, 54.5, 29.2, 55.2] },
                { key:'bundle_gorodokski_leshoz',    label:'Городокский лесхоз',       icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_gorodokski_leshoz_cog'],   bbox:[29.8, 55.3, 31.0, 55.9] },
                { key:'bundle_mss_orshanski_leshoz', label:'Оршанский лесхоз',         icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_mss_orshanski_leshoz'],    bbox:[29.9, 54.2, 31.0, 54.8] },
                
            ], 2024:[
                { key:'bundle_verkhnedvinsk_leshoz', label:'Верхнедвинский лесхоз',   icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_verkhnedvinsk_leshoz_cog'], bbox:[27.5, 55.6, 28.8, 56.2] },
                { key:'bundle_grodneski_leshoz',     label:'Гродненский лесхоз',       icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_grodneski_leshoz_cog'],    bbox:[23.6, 53.4, 24.8, 53.9] },
                { key:'bundle_skidelski_leshoz',     label:'Скидельский лесхоз',       icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_skidelski_leshoz_cog'],    bbox:[23.8, 53.5, 24.6, 53.9] },
                { key:'bundle_rossonski_leshoz',     label:'Россонский лесхоз',        icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_rossonski_leshoz_cog'],    bbox:[28.3, 55.7, 29.5, 56.4] },
                { key:'bundle_vitebski_leshoz',      label:'Витебский лесхоз',         icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_vitebski_leshoz_cog'],     bbox:[29.5, 54.8, 30.9, 55.4] },
                { key:'bundle_np_belovezhskaya_pushcha', label:'Национальный парк "Беловежская пуща"', icon:'fa-layer-group', type:'external_bundle', subkeys:['gs_np_belovezhskaya_pushcha_cog'], bbox:[23.6, 52.4, 24.6, 53.0] },
            ]
          }
        },
        { id:'space', icon:'fa-satellite', label:'Спутник', color:'#4a148c',
          desc:'Космические снимки',
          topKey: 'bundle_all_pans',
          yearFolders: {
            2026: [
                { key:'bundle_all_pans', label:'Все спутниковые снимки', icon:'fa-images', type:'external_bundle', subkeys:['gs_all_pans_cog','gs_all_pans_vector'], bbox:[19.0, 47.0, 37.0, 60.0] },
                { key:'bundle_ks_4114790', label:'4114790/791/792-PAN (02.05.2026)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4114790_pan_bounds','gs_ks_4114792_pan_cog','gs_ks_4114791_pan_cog'], boundsKey:'gs_ks_4114790_pan_bounds', bbox:[26.8, 52.0, 27.8, 55.8] },
                { key:'bundle_ks_4114861', label:'4114861-0330-PAN (02.05.2026)',    icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4114861_pan_bounds','gs_ks_4114861_pan_cog'], boundsKey:'gs_ks_4114861_pan_bounds', bbox:[26.2, 52.8, 27.2, 54.5] },
                { key:'bundle_ks_4114950', label:'4114950/951/952-PAN (03.05.2026)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4114950_pan_bounds','gs_ks_4114951_pan_cog','gs_ks_4114952_pan_cog'], boundsKey:'gs_ks_4114950_pan_bounds', bbox:[23.8, 53.2, 26.5, 55.0] },
                { key:'bundle_ks_4115011', label:'4115011-0330-PAN (03.05.2026)',    icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4115011_pan_bounds','gs_ks_4115011_pan_cog'], boundsKey:'gs_ks_4115011_pan_bounds', bbox:[23.5, 53.0, 24.8, 54.2] },
                { key:'bundle_ks_4115110', label:'4115110/111/112/113-PAN (04.05.2026)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4115110_pan_bounds','gs_ks_4115111_pan_cog','gs_ks_4115112_pan_cog','gs_ks_4115113_pan_cog'], boundsKey:'gs_ks_4115110_pan_bounds', bbox:[27.5, 52.0, 29.5, 54.5] },
            ],
            2025: [
                { key:'bundle_ks_4108441_pan', label:'4108441-0330-PAN (22.02.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108441_pan_cog','gs_ks_4108441_pan_bounds'], boundsKey:'gs_ks_4108441_pan_bounds' },
                { key:'bundle_ks_4108041_pan', label:'4108041-0330-PAN (27.02.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108041_pan_cog','gs_ks_4108041_pan_bounds'], boundsKey:'gs_ks_4108041_pan_bounds' },
                { key:'bundle_ks_4108421_pan', label:'4108421-0330-PAN (27.02.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108421_pan_cog','gs_ks_4108421_pan_bounds'], boundsKey:'gs_ks_4108421_pan_bounds' },
                { key:'bundle_ks_4108423_pan', label:'4108423-0330-PAN (07.03.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108423_pan_cog','gs_ks_4108423_pan_bounds'], boundsKey:'gs_ks_4108423_pan_bounds' },
                { key:'bundle_ks_4108422_pan', label:'4108422-0330-PAN (08.03.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108422_pan_cog','gs_ks_4108422_pan_bounds'], boundsKey:'gs_ks_4108422_pan_bounds' },
                { key:'bundle_ks_4108431_pan', label:'4108431-0330-PAN (08.03.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108431_pan_cog','gs_ks_4108431_pan_bounds'], boundsKey:'gs_ks_4108431_pan_bounds' },
                { key:'bundle_ks_4108591_pan', label:'4108591-0330-PAN (03.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108591_pan_cog','gs_ks_4108591_pan_bounds'], boundsKey:'gs_ks_4108591_pan_bounds' },
                { key:'bundle_ks_4108651_pan', label:'4108651-0330-PAN (04.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108651_pan_cog','gs_ks_4108651_pan_bounds'], boundsKey:'gs_ks_4108651_pan_bounds' },
                { key:'bundle_ks_4108781_pan', label:'4108781-0330-PAN (17.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108781_pan_cog','gs_ks_4108781_pan_bounds'], boundsKey:'gs_ks_4108781_pan_bounds' },
                { key:'bundle_ks_4108971_pan', label:'4108971-0330-PAN (21.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4108971_pan_cog','gs_ks_4108971_pan_bounds'], boundsKey:'gs_ks_4108971_pan_bounds' },
                { key:'bundle_ks_4109011_pan', label:'4109011-0330-PAN (22.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109011_pan_cog','gs_ks_4109011_pan_bounds'], boundsKey:'gs_ks_4109011_pan_bounds' },
                { key:'bundle_ks_4109241_pan', label:'4109241-0330-PAN (28.04.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109241_pan_cog','gs_ks_4109241_pan_bounds'], boundsKey:'gs_ks_4109241_pan_bounds' },
                { key:'bundle_ks_4109251_pan', label:'4109251/52-PAN (01.05.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109251_pan_cog','gs_ks_4109251_pan_bounds','gs_ks_4109252_pan_cog','gs_ks_4109252_pan_bounds'], boundsKey:'gs_ks_4109251_pan_bounds' },
                { key:'bundle_ks_4109321_pan', label:'4109321-0330-PAN (02.05.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109321_pan_cog','gs_ks_4109321_pan_bounds'], boundsKey:'gs_ks_4109321_pan_bounds' },
                { key:'bundle_ks_4109381_pan', label:'4109381-0330-PAN (02.05.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109381_pan_cog','gs_ks_4109381_pan_bounds'], boundsKey:'gs_ks_4109381_pan_bounds' },
                { key:'bundle_ks_4109621_pan', label:'4109621-0330-PAN (05.06.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109621_pan_cog','gs_ks_4109621_pan_bounds'], boundsKey:'gs_ks_4109621_pan_bounds' },
                { key:'bundle_ks_4109671_pan', label:'4109671-0330-PAN (06.06.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109671_pan_cog','gs_ks_4109671_pan_bounds'], boundsKey:'gs_ks_4109671_pan_bounds' },
                { key:'bundle_ks_4109991_pan', label:'4109991-0330-PAN (16.06.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109991_pan_cog','gs_ks_4109991_pan_bounds'], boundsKey:'gs_ks_4109991_pan_bounds' },
                { key:'bundle_ks_4109810',     label:'4109810/11/12/13-PAN (15.06.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4109810_pan_bounds','gs_ks_4109811_pan_cog','gs_ks_4109812_pan_cog','gs_ks_4109813_pan_cog'], boundsKey:'gs_ks_4109810_pan_bounds', bbox:[27.461794, 53.526024, 28.852664, 55.978897] },
                { key:'bundle_ks_4110060',     label:'4110060/61/62/63-PAN (21.06.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110060_pan_bounds','gs_ks_4110061_pan_cog','gs_ks_4110062_pan_cog','gs_ks_4110063_pan_cog'], boundsKey:'gs_ks_4110060_pan_bounds' },
                { key:'bundle_ks_4110471_pan', label:'4110471-0330-PAN (06.07.2025)',      icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110471_pan_cog','gs_ks_4110471_pan_bounds'], boundsKey:'gs_ks_4110471_pan_bounds' },
                { key:'bundle_ks_4110540',     label:'4110540/41/42-PAN (07.07.2025)',   icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110540_pan_bounds','gs_ks_4110540_pan_cog','gs_ks_4110541_pan_cog','gs_ks_4110542_pan_cog'], boundsKey:'gs_ks_4110540_pan_bounds' },
                { key:'bundle_ks_4110611_pan', label:'4110611-0330-PAN (10.07.2025)',    icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110611_pan_cog','gs_ks_4110611_pan_bounds'], boundsKey:'gs_ks_4110611_pan_bounds' },
                { key:'bundle_ks_4110661_pan', label:'4110661-0330-PAN (14.07.2025)',    icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110661_pan_cog','gs_ks_4110661_pan_bounds'], boundsKey:'gs_ks_4110661_pan_bounds' },
                { key:'bundle_ks_4110811_pan',    label:'4110811-0330-PAN (24.07.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110811_pan_cog','gs_ks_4110811_pan_bounds'], boundsKey:'gs_ks_4110811_pan_bounds' },
                { key:'bundle_ks_4110821_pan', label:'4110821-0330-PAN (29.07.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110821_pan_cog','gs_ks_4110821_pan_bounds'], boundsKey:'gs_ks_4110821_pan_bounds' },
                { key:'bundle_ks_4110891_pan', label:'4110891-0330-PAN (02.08.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110891_pan_cog','gs_ks_4110891_pan_bounds'], boundsKey:'gs_ks_4110891_pan_bounds' },
                { key:'bundle_ks_4110940',     label:'4110940/41/42-PAN (04.08.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4110940_pan_cog','gs_ks_4110940_pan_bounds','gs_ks_4110941_pan_solo_cog','gs_ks_4110941_pan_cog','gs_ks_4110942_pan_cog'], boundsKey:'gs_ks_4110940_pan_bounds' },
                { key:'bundle_ks_4111001_pan', label:'4111001-0330-PAN (05.08.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111001_pan_cog','gs_ks_4111001_pan_bounds'], boundsKey:'gs_ks_4111001_pan_bounds' },
                { key:'bundle_ks_4111071_pan', label:'4111071-0330-PAN (09.08.2025)',      icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111071_pan_cog','gs_ks_4111071_pan_bounds'], boundsKey:'gs_ks_4111071_pan_bounds' },
                { key:'bundle_ks_4111081_pan', label:'4111081-0330-PAN (10.08.2025)',      icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111081_pan_cog','gs_ks_4111081_pan_bounds'], boundsKey:'gs_ks_4111081_pan_bounds' },
                { key:'bundle_ks_4111670',     label:'4111670/71/72-PAN (03.09.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111670_pan_cog','gs_ks_4111670_pan_bounds','gs_ks_4111671_pan_cog','gs_ks_4111672_pan_cog'], boundsKey:'gs_ks_4111670_pan_bounds' },
                { key:'bundle_ks_4111701_pan', label:'4111701-0330-PAN (04.09.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111701_pan_cog','gs_ks_4111701_pan_bounds'], boundsKey:'gs_ks_4111701_pan_bounds' },
                { key:'bundle_ks_4111180_pan', label:'4111180/81/82-0330-PAN (14.08.2025)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4111180_pan_cog','gs_ks_4111180_pan_bounds','gs_ks_4111181_pan_cog','gs_ks_4111182_pan_cog'], boundsKey:'gs_ks_4111180_pan_bounds' },
            ], 2024:[
                { key:'bundle_ks_4100001_pan', label:'4100001-0330-PAN (27.04.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100001_pan_cog','gs_ks_4100001_pan_bounds'], boundsKey:'gs_ks_4100001_pan_bounds', bbox:[29.9036, 52.0356, 30.7077, 53.0648] },
                { key:'bundle_ks_4100101_pan', label:'4100101-0330-PAN (29.04.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100101_pan_cog','gs_ks_4100101_pan_bounds'], boundsKey:'gs_ks_4100101_pan_bounds', bbox:[29.0827, 51.2108, 30.5286, 53.7974] },
                { key:'bundle_ks_4100231_pan', label:'4100231-0330-PAN (30.04.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100231_pan_cog','gs_ks_4100231_pan_bounds'], boundsKey:'gs_ks_4100231_pan_bounds', bbox:[28.3409, 51.3634, 29.6278, 53.5942] },
                { key:'bundle_ks_4100271',     label:'4100271/281-PAN (01.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100271_pan_bounds','gs_ks_4100271_pan_cog','gs_ks_4100281_pan_cog','gs_ks_4100281_pan_bounds'], boundsKey:'gs_ks_4100271_pan_bounds', bbox:[23.7485, 52.359, 24.7268, 53.9998] },
                { key:'bundle_ks_4100411',     label:'4100411/421-PAN (02.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100411_pan_bounds','gs_ks_4100411_pan_cog','gs_ks_4100421_pan_cog','gs_ks_4100421_pan_bounds'], boundsKey:'gs_ks_4100411_pan_bounds', bbox:[26.9502, 51.5407, 28.2294, 53.8044] },
                { key:'bundle_ks_4100451_pan', label:'4100451-0330-PAN (03.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100451_pan_cog','gs_ks_4100451_pan_bounds'], boundsKey:'gs_ks_4100451_pan_bounds', bbox:[27.1427, 53.5586, 27.7173, 54.1387] },
                { key:'bundle_ks_4100520',     label:'4100520/21/22-PAN (03.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100520_pan_bounds','gs_ks_4100521_pan_cog','gs_ks_4100522_pan_cog'], boundsKey:'gs_ks_4100520_pan_bounds', bbox:[30.7287, 54.0516, 31.6601, 55.3178] },
                { key:'bundle_ks_4100571_pan', label:'4100571-0330-PAN (04.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100571_pan_cog','gs_ks_4100571_pan_bounds'], boundsKey:'gs_ks_4100571_pan_bounds', bbox:[30.9419, 52.0598, 31.8251, 53.3599] },
                { key:'bundle_ks_4100611',     label:'4100611/621-PAN (05.05.2024)',   icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100611_pan_bounds','gs_ks_4100611_pan_cog','gs_ks_4100621_pan_cog','gs_ks_4100621_pan_bounds'], boundsKey:'gs_ks_4100611_pan_bounds', bbox:[28.485, 53.576, 30.079, 56.171] },
                { key:'bundle_ks_4100691_pan', label:'4100691-0330-PAN (08.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100691_pan_cog','gs_ks_4100691_pan_bounds'], boundsKey:'gs_ks_4100691_pan_bounds', bbox:[27.2956, 51.5119, 28.0432, 52.5686] },
                { key:'bundle_ks_4100761_pan', label:'4100761-0330-PAN (09.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100761_pan_cog','gs_ks_4100761_pan_bounds'], boundsKey:'gs_ks_4100761_pan_bounds', bbox:[27.1846, 51.4292, 27.808, 52.1963] },
                { key:'bundle_ks_4100871_pan', label:'4100871-0330-PAN (15.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100871_pan_cog','gs_ks_4100871_pan_bounds'], boundsKey:'gs_ks_4100871_pan_bounds', bbox:[23.2884, 52.178, 23.7601, 52.5658] },
                { key:'bundle_ks_4100921_pan', label:'4100921-0330-PAN (17.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4100921_pan_cog','gs_ks_4100921_pan_bounds'], boundsKey:'gs_ks_4100921_pan_bounds', bbox:[27.0528, 51.4264, 27.806, 52.5197] },
                { key:'bundle_ks_4101041_pan', label:'4101041-0330-PAN (25.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101041_pan_cog','gs_ks_4101041_pan_bounds'], boundsKey:'gs_ks_4101041_pan_bounds', bbox:[27.9068, 55.2056, 28.7066, 56.1938] },
                { key:'bundle_ks_4101131',     label:'4101131/141-PAN (25.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101131_pan_bounds','gs_ks_4101131_pan_cog','gs_ks_4101141_pan_cog','gs_ks_4101141_pan_bounds'], boundsKey:'gs_ks_4101131_pan_bounds', bbox:[30.3008, 53.1457, 31.7094, 55.4841] },
                { key:'bundle_ks_4101230',     label:'4101230/31/32-PAN (28.05.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101230_pan_bounds','gs_ks_4101231_pan_cog','gs_ks_4101232_pan_cog'], boundsKey:'gs_ks_4101230_pan_bounds', bbox:[30.4312, 52.032, 31.548, 54.0002] },
                { key:'bundle_ks_4101491_pan', label:'4101491-0330-PAN (18.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101491_pan_cog','gs_ks_4101491_pan_bounds'], boundsKey:'gs_ks_4101491_pan_bounds', bbox:[28.6362, 51.5344, 29.8261, 53.4625] },
                { key:'bundle_ks_4101571_pan', label:'4101571-0330-PAN (19.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101571_pan_cog','gs_ks_4100571_pan_bounds'], boundsKey:'gs_ks_4100571_pan_bounds', bbox:[30.9419, 52.0598, 31.8251, 53.3599] },
                { key:'bundle_ks_4101681',     label:'4101681/691-PAN (26.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101681_pan_bounds','gs_ks_4101681_pan_cog','gs_ks_4101691_pan_cog','gs_ks_4101691_pan_bounds'], boundsKey:'gs_ks_4101681_pan_bounds', bbox:[27.8816, 53.3325, 29.4714, 56.1751] },
                { key:'bundle_ks_4101741_pan', label:'4101741-0330-PAN (27.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101741_pan_cog','gs_ks_4101741_pan_bounds'], boundsKey:'gs_ks_4101741_pan_bounds', bbox:[26.8716, 53.5186, 27.4538, 54.0975] },
                { key:'bundle_ks_4101841_pan', label:'4101841-0330-PAN (28.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101841_pan_cog','gs_ks_4101841_pan_bounds'], boundsKey:'gs_ks_4101841_pan_bounds', bbox:[31.9645, 53.0929, 32.5203, 53.6271] },
                { key:'bundle_ks_4101881_pan', label:'4101881-0330-PAN (29.06.2024, BY-RU)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101881_pan_cog','gs_ks_4101881_pan_bounds'], boundsKey:'gs_ks_4101881_pan_bounds', bbox:[31.055, 53.0351, 32.0123, 54.5168] },
                { key:'bundle_ks_4101930',     label:'4101930/931/932-PAN (30.06.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101930_pan_bounds','gs_ks_4101931_pan_cog','gs_ks_4101932_pan_cog'], boundsKey:'gs_ks_4101930_pan_bounds', bbox:[23.561, 51.876, 24.790, 53.935] },
                { key:'bundle_ks_4101990',     label:'4101990/991/992-PAN (01.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4101990_pan_bounds','gs_ks_4101991_pan_cog','gs_ks_4101992_pan_cog'], boundsKey:'gs_ks_4101990_pan_bounds', bbox:[28.247, 53.086, 29.939, 56.146] },
                { key:'bundle_ks_4102061_pan', label:'4102061-0330-PAN (06.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102061_pan_cog','gs_ks_4102061_pan_bounds'], boundsKey:'gs_ks_4102061_pan_bounds', bbox:[29.7543, 52.0943, 31.0689, 54.358] },
                { key:'bundle_ks_4102121_pan', label:'4102121-0330-PAN (07.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102121_pan_cog','gs_ks_4102121_pan_bounds'], boundsKey:'gs_ks_4102121_pan_bounds', bbox:[28.0972, 53.2932, 28.7258, 53.9333] },
                { key:'bundle_ks_4102181_pan', label:'4102181-0330-PAN (07.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102181_pan_cog','gs_ks_4102181_pan_bounds'], boundsKey:'gs_ks_4102181_pan_bounds', bbox:[23.92, 51.8334, 24.504, 52.4945] },
                { key:'bundle_ks_4102431_pan', label:'4102431-0330-PAN (10.07.2024, BY-RU)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102431_pan_cog','gs_ks_4102431_pan_bounds'], boundsKey:'gs_ks_4102431_pan_bounds', bbox:[32.1186, 53.1846, 32.7471, 53.8767] },
                { key:'bundle_ks_4102440',     label:'4102440/441/442-PAN (11.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102440_pan_bounds','gs_ks_4102441_pan_cog','gs_ks_4102442_pan_cog'], boundsKey:'gs_ks_4102440_pan_bounds', bbox:[30.041, 53.960, 31.079, 55.446] },
                { key:'bundle_ks_4102571_pan', label:'4102571-0330-PAN (12.07.2024, BY-RU)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102571_pan_cog','gs_ks_4102571_pan_bounds'], boundsKey:'gs_ks_4102571_pan_bounds', bbox:[31.5581, 53.0576, 32.322, 54.11] },
                { key:'bundle_ks_4102591_pan', label:'4102591-0330-PAN (13.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102591_pan_cog','gs_ks_4102591_pan_bounds'], boundsKey:'gs_ks_4102591_pan_bounds', bbox:[28.858, 51.6795, 30.049, 53.6723] },
                { key:'bundle_ks_4102711_pan', label:'4102711-0330-PAN (14.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102711_pan_cog','gs_ks_4102711_pan_bounds'], boundsKey:'gs_ks_4102711_pan_bounds', bbox:[29.3252, 51.2149, 30.5933, 53.5473] },
                { key:'bundle_ks_4102741_pan', label:'4102741-0330-PAN (17.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102741_pan_cog','gs_ks_4102741_pan_bounds'], boundsKey:'gs_ks_4102741_pan_bounds', bbox:[27.809, 52.2555, 28.234, 52.5411] },
                { key:'bundle_ks_4102811_pan', label:'4102811-0330-PAN (19.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102811_pan_cog','gs_ks_4102811_pan_bounds'], boundsKey:'gs_ks_4102811_pan_bounds', bbox:[24.6001, 52.6027, 25.0914, 53.025] },
                { key:'bundle_ks_4102861_pan', label:'4102861-0330-PAN (20.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102861_pan_cog','gs_ks_4102861_pan_bounds'], boundsKey:'gs_ks_4102861_pan_bounds', bbox:[24.8513, 52.749, 25.2798, 53.0035] },
                { key:'bundle_ks_4102921_pan', label:'4102921-0330-PAN (21.07.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4102921_pan_cog','gs_ks_4102921_pan_bounds'], boundsKey:'gs_ks_4102921_pan_bounds', bbox:[23.6923, 51.5732, 24.3015, 52.3185] },
                { key:'bundle_ks_4103011_pan', label:'4103011-0330-PAN (01.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103011_pan_cog','gs_ks_4103011_pan_bounds'], boundsKey:'gs_ks_4103011_pan_bounds', bbox:[24.3806, 51.8765, 25.1665, 52.9953] },
                { key:'bundle_ks_4103161_pan', label:'4103161-0330-PAN (16.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103161_pan_cog','gs_ks_4103161_pan_bounds'], boundsKey:'gs_ks_4103161_pan_bounds', bbox:[29.0648, 51.6903, 29.9408, 53.0178] },
                { key:'bundle_ks_4103221_pan', label:'4103221-0330-PAN (17.08.2024)',        icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103221_pan_cog','gs_ks_4103221_pan_bounds'], boundsKey:'gs_ks_4103221_pan_bounds', bbox:[29.8495, 51.2447, 30.7991, 52.8851] },
                { key:'bundle_ks_4103261_pan', label:'4103261-0330-PAN (19.08.2024)',        icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103261_pan_cog','gs_ks_4103261_pan_bounds'], boundsKey:'gs_ks_4103261_pan_bounds', bbox:[27.7144, 51.4988, 28.4362, 52.5328] },
                { key:'bundle_ks_4103451_pan', label:'4103451-0330-PAN (25.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103451_pan_cog','gs_ks_4103451_pan_bounds'], boundsKey:'gs_ks_4103451_pan_bounds', bbox:[23.0837, 51.4712, 23.8084, 52.536] },
                { key:'bundle_ks_4103452_pan', label:'4103452-0330-PAN (24.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103452_pan_cog','gs_ks_4103452_pan_bounds'], boundsKey:'gs_ks_4103452_pan_bounds', bbox:[23.2893, 51.5058, 24.0327, 52.5689] },
                { key:'bundle_ks_4103491_pan', label:'4103491-0330-PAN (25.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103491_pan_cog','gs_ks_4103491_pan_bounds'], boundsKey:'gs_ks_4103491_pan_bounds', bbox:[29.694, 52.0358, 30.7239, 53.846] },
                { key:'bundle_ks_4103561_pan', label:'4103561-0330-PAN (27.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103561_pan_cog','gs_ks_4103561_pan_bounds'], boundsKey:'gs_ks_4103561_pan_bounds', bbox:[31.1036, 52.0534, 31.9035, 53.1375] },
                { key:'bundle_ks_4103601_pan', label:'4103601-0330-PAN (27.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103601_pan_cog','gs_ks_4103601_pan_bounds'], boundsKey:'gs_ks_4103601_pan_bounds', bbox:[27.4098, 51.5301, 28.1349, 52.5793] },
                { key:'bundle_ks_4103751',     label:'4103750/51/52-PAN (28.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103750_pan_bounds','gs_ks_4103751_pan_cog','gs_ks_4103751_pan_bounds','gs_ks_4103752_pan_cog'], boundsKey:'gs_ks_4103750_pan_bounds', bbox:[26.7869, 51.4604, 28.0396, 53.8793] },
                { key:'bundle_ks_4103831_pan', label:'4103831-0330-PAN (29.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103831_pan_cog','gs_ks_4103831_pan_bounds'], boundsKey:'gs_ks_4103831_pan_bounds', bbox:[29.9913, 52.0035, 31.3289, 54.4136] },
                { key:'bundle_ks_4103971_pan', label:'4103971-0330-PAN (30.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4103971_pan_cog','gs_ks_4103971_pan_bounds'], boundsKey:'gs_ks_4103971_pan_bounds', bbox:[30.3654, 52.0448, 31.5977, 54.2685] },
                { key:'bundle_ks_4104031_pan', label:'4104031-0330-PAN (31.08.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104031_pan_cog','gs_ks_4104031_pan_bounds'], boundsKey:'gs_ks_4104031_pan_bounds', bbox:[28.2585, 51.3588, 29.5871, 53.7056] },
                { key:'bundle_ks_4104221_pan', label:'4104221-0330-PAN (05.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104221_pan_cog','gs_ks_4104221_pan_bounds'], boundsKey:'gs_ks_4104221_pan_bounds', bbox:[29.6624, 52.0311, 31.0458, 54.4195] },
                { key:'bundle_ks_4104291_pan', label:'4104291-0330-PAN (06.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104291_pan_cog','gs_ks_4104291_pan_bounds'], boundsKey:'gs_ks_4104291_pan_bounds', bbox:[29.286, 51.2363, 30.6949, 53.8306] },
                { key:'bundle_ks_4104371_pan', label:'4104371-0330-PAN (07.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104371_pan_cog','gs_ks_4104371_pan_bounds'], boundsKey:'gs_ks_4104371_pan_bounds', bbox:[27.881, 51.555, 29.2091, 53.8946] },
                { key:'bundle_ks_4104461_pan', label:'4104461-0330-PAN (07.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104461_pan_cog','gs_ks_4104461_pan_bounds'], boundsKey:'gs_ks_4104461_pan_bounds', bbox:[29.0855, 51.4797, 30.3627, 53.7956] },
                { key:'bundle_ks_4104372_pan', label:'4104372-0330-PAN (08.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104372_pan_cog','gs_ks_4104372_pan_bounds'], boundsKey:'gs_ks_4104372_pan_bounds', bbox:[28.1439, 51.4005, 28.9977, 52.689] },
                { key:'bundle_ks_4104581_pan', label:'4104581-0330-PAN (10.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104581_pan_cog','gs_ks_4104581_pan_bounds'], boundsKey:'gs_ks_4104581_pan_bounds', bbox:[30.6327, 52.0785, 31.9683, 54.2635] },
                { key:'bundle_ks_4104850',     label:'4104850/51/52-PAN (19.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104850_pan_bounds','gs_ks_4104851_pan_cog','gs_ks_4104852_pan_cog'], boundsKey:'gs_ks_4104850_pan_bounds', bbox:[24.0495, 51.8839, 25.2019, 53.862] },
                { key:'bundle_ks_4104860',     label:'4104860/61/62-PAN (19.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104860_pan_bounds','gs_ks_4104861_pan_cog','gs_ks_4104862_pan_cog'], boundsKey:'gs_ks_4104860_pan_bounds', bbox:[29.7372, 53.5765, 30.8929, 55.4217] },
                { key:'bundle_ks_4104951_pan', label:'4104951-0330-PAN (20.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4104951_pan_cog','gs_ks_4104951_pan_bounds'], boundsKey:'gs_ks_4104951_pan_bounds', bbox:[24.6431, 51.9334, 25.3967, 53.0282] },
                { key:'bundle_ks_4105041_pan', label:'4105041-0330-PAN (20.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4105041_pan_cog','gs_ks_4105041_pan_bounds'], boundsKey:'gs_ks_4105041_pan_bounds', bbox:[28.7473, 51.6995, 29.9037, 53.6558] },
                { key:'bundle_ks_4105151_pan', label:'4105151-0330-PAN (22.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4105151_pan_cog','gs_ks_4105151_pan_bounds'], boundsKey:'gs_ks_4105151_pan_bounds', bbox:[27.0556, 51.5525, 27.6046, 52.1706] },
                { key:'bundle_ks_4105231_pan', label:'4105231-0330-PAN (22.09.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4105231_pan_cog','gs_ks_4105231_pan_bounds'], boundsKey:'gs_ks_4105231_pan_bounds', bbox:[29.4108, 51.4848, 30.3674, 53.1239] },
                { key:'bundle_ks_4106001_pan', label:'4106001-0330-PAN (16.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106001_pan_cog','gs_ks_4106001_pan_bounds'], boundsKey:'gs_ks_4106001_pan_bounds', bbox:[23.5976, 53.3315, 24.1445, 53.8439] },
                { key:'bundle_ks_4106050',     label:'4106050/51/52-PAN (17.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106050_pan_bounds','gs_ks_4106051_pan_cog','gs_ks_4106052_pan_cog'], boundsKey:'gs_ks_4106050_pan_bounds', bbox:[27.369, 53.482, 28.887, 55.965] },
                { key:'bundle_ks_4106261_pan', label:'4106261-0330-PAN (18.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106261_pan_cog','gs_ks_4106261_pan_bounds'], boundsKey:'gs_ks_4106261_pan_bounds', bbox:[23.5646, 51.5723, 24.2646, 52.5757] },
                { key:'bundle_ks_4106262_pan', label:'4106262-0330-PAN (18.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106262_pan_cog','gs_ks_4106262_pan_bounds'], boundsKey:'gs_ks_4106262_pan_bounds', bbox:[27.854, 53.5523, 28.3238, 53.8924] },
                { key:'bundle_ks_4106342_pan', label:'4106342-0330-PAN (19.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106342_pan_cog','gs_ks_4106342_pan_bounds'], boundsKey:'gs_ks_4106342_pan_bounds', bbox:[28.088307, 51.520386, 28.595681, 52.012873] },
                { key:'bundle_ks_4106341_pan', label:'4106341-0330-PAN (20.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106341_pan_cog','gs_ks_4106341_pan_bounds'], boundsKey:'gs_ks_4106341_pan_bounds', bbox:[27.9064, 51.4919, 28.4119, 51.9856] },
                { key:'bundle_ks_4106651_pan', label:'4106651-0330-PAN (29.10.2024)', icon:'fa-satellite', type:'external_bundle', subkeys:['gs_ks_4106651_pan_cog','gs_ks_4106651_pan_bounds'], boundsKey:'gs_ks_4106651_pan_bounds', bbox:[30.265201, 52.024392, 31.215497, 53.482561] },
            ], 2023:[]
          }
        }
    ];

    window._reorderDZZLayers = function() {
        // В OL порядок слоёв управляется через zIndex.
        // Вкладка с наивысшим приоритетом (первая слева) получает наибольший zIndex.
        // Порядок вкладок берётся из localStorage (dzz_tab_order).
        try {
            const TAB_ORDER_KEY = 'dzz_tab_order';
            let tabOrder;
            try {
                tabOrder = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || 'null');
            } catch(_) {}
            // FIX: используем window._dzzAllTabs (все 4 вкладки включая uav/aerial),
            // с фолбэком на window._dzzTabs (только base/space)
            const tabs = (window._dzzAllTabs || window._dzzTabs || []);
            const sortedTabs = Array.isArray(tabOrder)
                ? tabOrder.map(id => tabs.find(t => t.id === id)).filter(Boolean).concat(
                    tabs.filter(t => !tabOrder.includes(t.id))
                  )
                : tabs.slice();

            // Вкладки в обратном порядке: последняя вкладка (наименьший приоритет) = нижний zIndex
            const reversedTabs = sortedTabs.slice().reverse();
            let zBase = 11;
            reversedTabs.forEach(tab => {
                // FIX: добавлен 2026 год
                const years = (window.dzzYearOrder || [2026,2025,2024,2023]).slice().reverse();
                years.forEach(year => {
                    (tab.yearFolders[year] || []).slice().reverse().forEach(ld => {
                        const keys = ld.subkeys || [ld.key];
                        keys.slice().reverse().forEach(sk => {
                            const layerId = `ext-layer-${sk}`;
                            const def = _getExtDef(sk);
                            if (!def || !def.isRaster) return;
                            if (_layers[layerId]) _layers[layerId].setZIndex(zBase++);
                        });
                    });
                });
            });
        } catch(e) {}
    };

    // ==========================================
    // 27. ПЕЧАТЬ (OpenLayers canvas export)
    // ==========================================
    function buildUI() {
        const mapEl = document.getElementById('map');

        // ── ЛЕВАЯ ПОИСКОВАЯ ПАНЕЛЬ ───────────────────────────────────────
        buildLeftSearchPanel(mapEl);

        const panel = document.createElement('div');
        panel.id = 'map-right-panel';

        const slidePanel = document.createElement('div');
        slidePanel.id = 'map-slide-panel';
        // Блокируем события карты от панели
        ['wheel','mousedown','dblclick','mousemove','touchstart'].forEach(evt => {
            slidePanel.addEventListener(evt, e => {
                // Не блокируем mousedown на ручках drag — иначе HTML5 drag не стартует
                if (evt === 'mousedown' && e.target && e.target.closest('.dzz-yr-drag')) return;
                e.stopPropagation();
            }, evt === 'wheel' || evt === 'touchstart' ? { passive: false } : false);
        });
        panel.appendChild(slidePanel);

        const iconBar = document.createElement('div');
        iconBar.id = 'map-icon-bar';
        iconBar.addEventListener('wheel', e => e.stopPropagation(), { passive: false });
        iconBar.addEventListener('click', e => e.stopPropagation());
        panel.appendChild(iconBar);
        mapEl.appendChild(panel);

        buildIconBar(iconBar, slidePanel);
    }

    // ==========================================
    // 28а. ПОИСК — встроен в сайдбар (index.html)
    // ==========================================
    function buildLeftSearchPanel(mapEl) {
        const searchInput = document.getElementById('lsp-search-input');
        const clearBtn    = document.getElementById('lsp-search-clear');
        if (!searchInput) return;

        let lspExactMode = false;
        let lspDebounce  = null;
        let _lspSearchId = 0;
        let _lspController = null;
        function _lspCancelSearch() {
            ++_lspSearchId;
            if (_lspController) _lspController.abort();
            _lspController = null;
        }

        // Фильтры: что искать
        const lspFilters = { leshoz: true, osm: true, gs: true, local: true, catalog: true };
        let lspScope = 'all';
        const lspPrefsKey = 'ui_search_filters_v1';
        try {
            const saved = JSON.parse(localStorage.getItem(lspPrefsKey) || 'null');
            if (saved && saved.version === 1) {
                Object.keys(lspFilters).forEach(k => {
                    if (saved.filters && typeof saved.filters[k] === 'boolean') lspFilters[k] = saved.filters[k];
                });
                if (saved.scope === 'all' || saved.scope === 'active') lspScope = saved.scope;
                if (typeof saved.exact === 'boolean') lspExactMode = saved.exact;
            }
        } catch (_) { /* Повреждённое/недоступное хранилище не блокирует поиск. */ }
        function _lspSaveFilters() {
            try { localStorage.setItem(lspPrefsKey, JSON.stringify({version:1, filters:lspFilters, scope:lspScope, exact:lspExactMode})); }
            catch (_) { /* Приватный режим/квота: настройки продолжают работать в текущем окне. */ }
        }
        const FS = window.ForestSearch;
        function searchContext() {
            return {defs:window.EXTERNAL_LAYER_DEFS||[],state:AppState.externalLayerState||{},vectors:AppState.vectors.activeLayers,
                mbtiles:AppState.mbtiles?.items||{},builtins:[{name:'Границы лесхозов',builtinKey:'forestry',active:!!AppState.layerState.forestry},{name:'Погода по лесхозам',builtinKey:'weather_leskhozi',active:!!AppState.layerState.weather_leskhozi},{name:'Растровая карта',builtinKey:'raster',active:!!AppState.layerState.raster}],tabs:window._dzzAllTabs||window._dzzTabs||[],basemaps:window.BASEMAP_DEFS||{},activeBasemap:AppState.activeBasemap,scope:lspScope,
                localVisible:id=>!!_layers['vector-'+id]&&_layers['vector-'+id].getVisible()};
        }

        // ── Превращаем кнопку настроек в кнопку фильтра ─────────────────
        const settingsBtn = document.getElementById('lsp-settings-toggle');
        if (settingsBtn) {
            // Перекрашиваем в стиль фильтра
            settingsBtn.title = 'Фильтр поиска';
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _lspToggleFilterPanel();
            });
        }

        window.addEventListener('resize',()=>{_lspHideFilterPanel();});

        // Закрываем панель фильтра при клике / фокусе на поисковой строке
        searchInput.addEventListener('focus', () => {
            const fp = document.getElementById('lsp-filter-panel');
            if (fp) fp.remove();
        });
        searchInput.addEventListener('click', () => {
            const fp = document.getElementById('lsp-filter-panel');
            if (fp) fp.remove();
        });

        searchInput.addEventListener('input', () => {
            _lspCancelSearch();
            clearBtn.style.display = searchInput.value ? '' : 'none';
            clearTimeout(lspDebounce);
            lspDebounce = setTimeout(_lspDoSearch, 220);
        });
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            searchInput.value = '';
            clearBtn.style.display = 'none';
            _lspHideResults();
            searchInput.focus();
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                const fp = document.getElementById('lsp-filter-panel');
                if (fp && fp.style.display !== 'none') { _lspHideFilterPanel(); return; }
                searchInput.value = ''; clearBtn.style.display = 'none'; _lspHideResults();
            }
            if (e.key === 'Enter') { clearTimeout(lspDebounce); _lspDoSearch(); }
        });

        function _lspHideResults() {
            clearTimeout(lspDebounce);
            _lspCancelSearch();
            const rc = document.getElementById('lsp-results-container');
            if (rc) { rc.style.display = 'none'; rc.innerHTML = ''; }
        }

        function _lspHideFilterPanel() {
            const fp = document.getElementById('lsp-filter-panel');
            if (fp) fp.remove();
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#sidebar-search-wrap') && !e.target.closest('#lsp-results-container') && !e.target.closest('#lsp-filter-panel')) {
                _lspHideResults();
                _lspHideFilterPanel();
            }
        }, true);

        // ── Панель фильтров ──────────────────────────────────────────────
        function _lspBuildFilterPanel() {
            // удаляем старую если есть
            const old = document.getElementById('lsp-filter-panel');
            if (old) old.remove();

            // Инжектируем стили панели
            if (!document.getElementById('lsp-filter-css')) {
                const st = document.createElement('style');
                st.id = 'lsp-filter-css';
                st.textContent = `
                    #lsp-filter-panel {
                        position: absolute;
                        top: 100%;
                        left: 0; right: 0;
                        margin-top: 6px;
                        background: #152318;
                        border: 1.5px solid rgba(130,233,56,0.3);
                        border-radius: 12px;
                        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
                        z-index: 2000;
                        padding: 10px;
                        display: none;
                        flex-direction: column;
                        gap: 6px;
                        animation: lfpIn .15s ease;
                    }
                    #lsp-filter-panel.open { display: flex; }
                    @keyframes lfpIn { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:none} }
                    .lfp-header {
                        display: flex; align-items: center; justify-content: space-between;
                        padding-bottom: 6px;
                        border-bottom: 1px solid rgba(130,233,56,0.12);
                    }
                    .lfp-title { font-size: 11px; font-weight: 800; color: #82e938; font-family: Lato,sans-serif; letter-spacing: .05em; }
                    .lfp-reset {
                        border: none; background: rgba(244,67,54,0.12); color: #f44336;
                        font-size: 10px; font-weight: 700; padding: 2px 9px; border-radius: 20px;
                        cursor: pointer; font-family: Lato,sans-serif; transition: .15s;
                    }
                    .lfp-reset:hover { background: rgba(244,67,54,0.25); }
                    .lfp-header-btns { display: flex; align-items: center; gap: 5px; }
                    .lfp-select-all {
                        border: none; background: rgba(130,233,56,0.1); color: #82e938;
                        font-size: 10px; font-weight: 700; padding: 2px 9px; border-radius: 20px;
                        cursor: pointer; font-family: Lato,sans-serif; transition: .15s;
                    }
                    .lfp-select-all:hover { background: rgba(130,233,56,0.22); }
                    .lfp-section { font-size: 9px; font-weight: 700; color: #557055;
                        text-transform: uppercase; letter-spacing: .07em; margin-top: 2px; }
                    .lfp-row {
                        display: flex; align-items: center; gap: 8px;
                        padding: 5px 7px; border-radius: 8px; cursor: pointer;
                        transition: background .12s;
                    }
                    .lfp-row:hover { background: rgba(130,233,56,0.07); }
                    .lfp-row input[type=checkbox] { accent-color: #82e938; width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; }
                    .lfp-row-icon { font-size: 11px; width: 14px; text-align: center; flex-shrink: 0; }
                    .lfp-row-label { font-size: 12px; color: #bdc; font-family: Lato,sans-serif; flex: 1; }
                    .lfp-row-count { font-size: 10px; color: #557; font-weight: 700; }
                    .lfp-divider { height: 1px; background: rgba(130,233,56,0.1); margin: 2px 0; }
                    .lfp-active-section { font-size: 9px; font-weight: 700; color: #557055;
                        text-transform: uppercase; letter-spacing: .07em; margin-top: 2px; }
                    .lfp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
                    .lfp-chip {
                        background: rgba(130,233,56,0.1); border: 1px solid rgba(130,233,56,0.2);
                        color: #82e938; font-size: 10px; font-weight: 600; padding: 2px 8px;
                        border-radius: 20px; white-space: nowrap; font-family: Lato,sans-serif;
                        max-width: 130px; overflow: hidden; text-overflow: ellipsis;
                    }
                    .lfp-chip.more { background: rgba(255,255,255,0.05); color: #557; border-color: rgba(255,255,255,0.1); }
                    .lfp-no-active { font-size: 11px; color: #446; font-style: italic; padding: 2px 4px; }
                    .lfp-exact-row {
                        display: flex; align-items: center; gap: 8px;
                        padding: 5px 7px; border-radius: 8px; cursor: pointer;
                        transition: background .12s; border-top: 1px solid rgba(130,233,56,0.1);
                        margin-top: 2px; padding-top: 7px;
                    }
                    .lfp-exact-row:hover { background: rgba(130,233,56,0.07); }
                    .lfp-exact-row input[type=checkbox] { accent-color: #82e938; width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; }
                    .lfp-exact-label { font-size: 11px; color: #8a9; font-family: Lato,sans-serif; }
                `;
                document.head.appendChild(st);
            }

            const wrap = document.getElementById('sidebar-search-wrap');
            if (!wrap) return;
            wrap.style.position = 'relative';

            const panel = document.createElement('div');
            panel.id = 'lsp-filter-panel';

            const candidates = FS.catalog(searchContext());
            const wfsCount = candidates.filter(d=>d.layerKey && !(window.EXTERNAL_LAYER_DEFS||[]).find(x=>x.key===d.layerKey)?.isRaster && !(window.EXTERNAL_LAYER_DEFS||[]).find(x=>x.key===d.layerKey)?.noWfs).length;
            const chipsHtml = `<span class="lfp-chip">${candidates.length} слоёв в каталоге</span><span class="lfp-chip">${wfsCount} с поиском WFS</span>`;

            panel.innerHTML = `
                <div class="lfp-header">
                    <span class="lfp-title">Фильтр поиска</span>
                    <div class="lfp-header-btns">
                        <button class="lfp-select-all" id="lfp-select-all" title="Выделить все">Выделить все</button>
                        <button class="lfp-reset" id="lfp-reset">Сбросить</button>
                    </div>
                </div>
                <label class="lfp-section" for="lfp-scope">Область поиска</label>
                <select class="lfp-scope" id="lfp-scope"><option value="all" ${lspScope==='all'?'selected':''}>Все слои</option><option value="active" ${lspScope==='active'?'selected':''}>Только включённые на карте</option></select>
                <div class="lfp-section">Источники</div>
                <label class="lfp-row">
                    <input type="checkbox" id="lfp-leshoz" ${lspFilters.leshoz ? 'checked' : ''}>
                    <svg class="lfp-row-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-5 7h3l-5 7h14l-5-7h3zM12 17v4"/></svg>
                    <span class="lfp-row-label">Лесхозы</span>
                </label>
                <label class="lfp-row">
                    <input type="checkbox" id="lfp-osm" ${lspFilters.osm ? 'checked' : ''}>
                    <svg class="lfp-row-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
                    <span class="lfp-row-label">Населённые пункты (OSM)</span>
                </label>
                <label class="lfp-row">
                    <input type="checkbox" id="lfp-gs" ${lspFilters.gs ? 'checked' : ''}>
                    <svg class="lfp-row-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M12 7h5M12 17h5"/></svg>
                    <span class="lfp-row-label">Объекты GeoServer (WFS)</span>
                    <span class="lfp-row-count" title="Слоёв с поддержкой поиска">${wfsCount}</span>
                </label>
                <label class="lfp-row"><input type="checkbox" id="lfp-local" ${lspFilters.local?'checked':''}><svg class="lfp-row-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5 5 13-1 3 14-13 3-4-10z"/></svg><span class="lfp-row-label">Загруженные векторы</span></label>
                <label class="lfp-row"><input type="checkbox" id="lfp-catalog" ${lspFilters.catalog?'checked':''}><svg class="lfp-row-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5"/></svg><span class="lfp-row-label">Каталог слоёв и снимков</span></label>
                <div class="lfp-divider"></div>
                
                <div class="lfp-chips">${chipsHtml}</div>
                <p class="lfp-help">Векторы — по атрибутам. Растры — по названию, снимки — также по дате и году.</p>
                <label class="lfp-exact-row">
                    <input type="checkbox" id="lfp-exact" ${lspExactMode ? 'checked' : ''}>
                    <span class="lfp-exact-label">Точное совпадение</span>
                </label>
            `;

            wrap.appendChild(panel);
            // показываем сразу
            panel.style.display = 'flex';
            panel.style.maxHeight=Math.max(120,window.innerHeight-wrap.getBoundingClientRect().bottom-16)+'px';

            panel.querySelector('#lfp-scope').addEventListener('change',e=>{lspScope=e.target.value;_lspBuildFilterPanel();_updateFilterBtnState();_lspDoSearch();});
            ['local','catalog'].forEach(key=>panel.querySelector('#lfp-'+key).addEventListener('change',e=>{lspFilters[key]=e.target.checked;_updateFilterBtnState();_lspDoSearch();}));
            // Обработчики чекбоксов
            panel.querySelector('#lfp-leshoz').addEventListener('change', e => {
                lspFilters.leshoz = e.target.checked; _updateFilterBtnState(); _lspDoSearch();
            });
            panel.querySelector('#lfp-osm').addEventListener('change', e => {
                lspFilters.osm = e.target.checked; _updateFilterBtnState(); _lspDoSearch();
            });
            panel.querySelector('#lfp-gs').addEventListener('change', e => {
                lspFilters.gs = e.target.checked; _updateFilterBtnState(); _lspDoSearch();
            });
            panel.querySelector('#lfp-exact').addEventListener('change', e => {
                lspExactMode = e.target.checked; _updateFilterBtnState(); _lspDoSearch();
            });
            // Кнопка "Выделить все" — включает все чекбоксы
            panel.querySelector('#lfp-select-all').addEventListener('click', e => {
                e.stopPropagation();
                Object.keys(lspFilters).forEach(k=>lspFilters[k]=true);
                ['local','catalog'].forEach(k=>panel.querySelector('#lfp-'+k).checked=true);
                panel.querySelector('#lfp-leshoz').checked = true;
                panel.querySelector('#lfp-osm').checked    = true;
                panel.querySelector('#lfp-gs').checked     = true;
                _updateFilterBtnState(); _lspDoSearch();
            });
            // Кнопка "Сбросить" — снимает все галочки (без отключения внешних слоёв)
            panel.querySelector('#lfp-reset').addEventListener('click', e => {
                e.stopPropagation();
                Object.keys(lspFilters).forEach(k=>lspFilters[k]=false);
                ['local','catalog'].forEach(k=>panel.querySelector('#lfp-'+k).checked=false);
                lspExactMode = false;
                panel.querySelector('#lfp-leshoz').checked = false;
                panel.querySelector('#lfp-osm').checked    = false;
                panel.querySelector('#lfp-gs').checked     = false;
                panel.querySelector('#lfp-exact').checked  = false;
                _updateFilterBtnState(); _lspDoSearch();
            });
        }

        function _lspToggleFilterPanel() {
            const existing = document.getElementById('lsp-filter-panel');
            if (existing) {
                // уже открыта — закрыть и удалить
                existing.remove();
                return;
            }
            // строим заново каждый раз — чтобы активные слои были актуальны
            _lspBuildFilterPanel();
        }

        function _updateFilterBtnState() {
            _lspSaveFilters();
            const btn = document.getElementById('lsp-settings-toggle');
            if (!btn) return;
            const allOn = Object.values(lspFilters).every(Boolean) && lspScope==='all' && !lspExactMode;
            btn.style.color = allOn ? '' : '#82e938';
            btn.title = allOn ? 'Фильтр поиска' : 'Фильтр активен';
        }

        _updateFilterBtnState();

        // ── Основной поиск ───────────────────────────────────────────────
        async function _lspDoSearch() {
            const query = (searchInput.value || '').trim();
            const rc = document.getElementById('lsp-results-container');
            if (!rc) return;
            if (query.length < 2 && !/^\d$/.test(query)) { _lspHideResults(); return; }

            _lspCancelSearch();
            const sid = _lspSearchId;
            const searchController = _lspController = new AbortController();
            const exactMode = lspExactMode;
            const searchErrors = [];
            const searchDeadline = AbortSignal.timeout(22000);
            const searchFetch = (url, options = {}) => fetch(url, {
                ...options,
                signal: AbortSignal.any([searchController.signal, searchDeadline, AbortSignal.timeout(8000)])
            });
            rc.style.display = 'block';
            rc.style.maxHeight=Math.max(120,window.innerHeight-searchInput.getBoundingClientRect().bottom-24)+'px';
            rc.innerHTML = `<div class="lsr-no-res"><i class="fa-solid fa-circle-notch fa-spin" style="color:#82e938;margin-right:6px;"></i>Ищем...</div>`;

            const q = query.toLowerCase();
            const results = [];
            let loading = true, resultLimit = 50;
            const ctx = searchContext();
            if(lspFilters.catalog) results.push(...FS.catalog(ctx).filter(d=>d.search.some(v=>FS.matches(v,query,exactMode))));
            if(lspFilters.local) results.push(...await FS.localFeatures(ctx,query,exactMode,()=>sid===_lspSearchId));
            if(sid!==_lspSearchId)return;
            // [v20] адрес с опечаткой исправляется на сервере (до ~11 с) — отдельный, более длинный таймаут
            const osmPromise = lspFilters.osm ? fetch(`/api/geocode?q=${encodeURIComponent(query)}&limit=6${_geoCenterQS()}`,{headers:{'Accept-Language':'ru'},signal:AbortSignal.any([searchController.signal,AbortSignal.timeout(16000)])}).then(r=>r.ok?r.json():[]).catch(()=>[]) : Promise.resolve([]);

            // 1. Лесхозы
            if (lspFilters.leshoz) {
                MANUAL_FORESTRY_FIX.forEach(item => {
                    const match = lspExactMode
                        ? (item.name.toLowerCase() === q || String(item.code) === q)
                        : (item.name.toLowerCase().includes(q) || String(item.code).includes(q));
                    if (match) {
                        const regionName = window.REGION_NAMES && window.REGION_NAMES[String(item.region)] || '';
                        results.push({
                            type: 'leshoz', name: item.name,
                            sub: regionName || ('Код: ' + item.code),
                            count: AppState.forestry.counts[item.code] || 0,
                            code: item.code, color: '#82e938', icon: 'fa-tree'
                        });
                    }
                });
            }

            // 2. GeoServer WFS поиск
            // [FIX v4.2] • Лесхозы / Лесничества / Кварталы / Выделы РБ ищутся ВСЕГДА (если включён
            //              фильтр «Слои GeoServer»); область поиска задаётся пользователем.
            //            • Кварталы и выделы — по номерам: «Вилейский 35», «Вилейский 35 12»,
            //              «кв 35 выд 12», «35» (в границах видимой области карты).
            //            • Лесничества — по названию и по названию лесхоза («виле» → лесничества
            //              Вилейского лесхоза).
            //            • Имена полей берутся из DescribeFeatureType, а если он недоступен —
            //              из первого объекта слоя; плохие поля отбрасываются по одному.
            renderSearchResults();
            const gsPromise = (async()=>{if (lspFilters.gs) {
                const CORE_KEYS = ['gs_leshoz', 'gs_lesnich', 'gs_quarter', 'gs_allotment'];
                const allDefs = window.EXTERNAL_LAYER_DEFS || [];
                const activeGeoLayers = allDefs.filter(d => d.sublabel && !d.isRaster && !d.noWfs &&
                    (lspScope==='all' || AppState.externalLayerState[d.key]))
                    .sort((a, b) => (CORE_KEYS.indexOf(b.key) >= 0) - (CORE_KEYS.indexOf(a.key) >= 0));

                // ── разбор запроса ──
                const P = (() => {
                    const toks = query.toLowerCase().replace(/[,;№#.]+/g, ' ').replace(/(\d)([а-яёa-z])/gi, '$1 $2').replace(/([а-яёa-z])(\d)/gi, '$1 $2').split(/\s+/).filter(Boolean);
                    const out = { words: [], quarter: null, allot: null, lesnichNum: null, nums: [] };
                    let role = null;
                    toks.forEach(t => {
                        if (/^(кв|кв\.|квартал\S*)$/.test(t)) { role = 'quarter'; return; }
                        if (/^(выд|выд\.|выдел\S*|в\.)$/.test(t)) { role = 'allot'; return; }
                        if (/^(лесн\S*|л-во)$/.test(t)) { role = 'lesnich'; return; }
                        if (/^(лесхоз\S*|лх)$/.test(t)) return;
                        if (/^\d{1,5}$/.test(t)) {
                            const n = Number(t);
                            if (role === 'quarter') out.quarter = n; else if (role === 'allot') out.allot = n;
                            else if (role === 'lesnich') out.lesnichNum = n; else out.nums.push(n);
                            role = null; return;
                        }
                        out.words.push(t.replace(/\.$/, ''));
                    });
                    if (out.quarter == null && out.nums.length) out.quarter = out.nums.shift();
                    if (out.allot == null && out.nums.length) out.allot = out.nums.shift();
                    out.text = out.words.join(' ').trim();
                    // для ILIKE берём основу слова: «вилейский» найдёт и «Вилейское»
                    out.like = (out.words.length === 1 && out.text.length > 5) ? out.text.slice(0, out.text.length - 2) : out.text;
                    const stems = out.words.filter(w => w.length >= 3).map(w => w.slice(0, Math.max(3, w.length - 2)));
                    out.leshozCodes = stems.length ? MANUAL_FORESTRY_FIX.filter(i => stems.some(st => i.name.toLowerCase().includes(st))).map(i => String(i.code)).slice(0, 6) : [];
                    if (!out.leshozCodes.length && AppState.forestry.selectedCode && (out.quarter != null || out.allot != null) && !out.text)
                        out.leshozCodes = [String(AppState.forestry.selectedCode)];
                    return out;
                })();
                const leshozName = code => ((MANUAL_FORESTRY_FIX.find(i => String(i.code) === String(code)) || {}).name || '');

                const norm = n => String(n).toLowerCase().replace(/[\s_\-.]+/g, '');
                const ROLE_RE = {
                    leshoz:  /^(forestnumber|forestcode|codelx|idlx|kodlx|numlx|lxcode|leshozcode|leshozid|codeleshoz)$/,
                    lesnich: /^(forestryunitnumber|forestryunit|numln|idln|codeln|kodln|lnnum|lesnichnumber|lesnichid)$/,
                    quarter: /^(quarternumber|quarternum|numquarter|numkv|kvnum|kv|nkv|kvartal|nomkv|quarterno)$/,
                    allot:   /^(allotmentnumber|allotmentnum|numvid|vidnum|vid|nvid|nomvid|allotmentno|vydel)$/,
                };
                const GEOM_T = /(geometry|polygon|point|linestring|surface|curve)propertytype$/i;
                const STR_T = ['string', 'normalizedstring', 'token', 'anyuri'];
                const NUM_T = ['int', 'integer', 'long', 'double', 'decimal', 'short', 'float', 'byte', 'number',
                               'nonnegativeinteger', 'positiveinteger', 'unsignedint', 'unsignedlong', 'unsignedshort', 'biginteger', 'bigdecimal'];
                const classify = (cols, geom) => {
                    const sc = { cols, geom: geom || null, roles: {} };
                    for (const r of Object.keys(ROLE_RE)) sc.roles[r] = cols.find(c => ROLE_RE[r].test(norm(c.name))) || null;
                    sc.str = cols.filter(c => !c.numeric);
                    sc.names = sc.str.filter(c => /name|naim|назв|наим|title/i.test(c.name));
                    return sc;
                };
                const parseSchema = (xmlText) => {
                    const cols = [], seen = new Set(); let geom = null;
                    const add = (name, type) => {
                        if (!name || seen.has(name)) return;
                        const t = String(type || '');
                        if (GEOM_T.test(t)) { geom = geom || name; return; }
                        const tt = t.split(':').pop().toLowerCase();
                        if (STR_T.includes(tt)) cols.push({ name, numeric: false });
                        else if (NUM_T.includes(tt)) cols.push({ name, numeric: true });
                        else return;
                        seen.add(name);
                    };
                    try {
                        const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
                        if (!xml.getElementsByTagName('parsererror').length) {
                            const els = xml.getElementsByTagNameNS('http://www.w3.org/2001/XMLSchema', 'element');
                            for (let k = 0; k < els.length; k++) add(els[k].getAttribute('name'), els[k].getAttribute('type'));
                        }
                    } catch (_) {}
                    if (!cols.length) {
                        const re = /<(?:\w+:)?element\b([^>]*)>/gi; let m;
                        while ((m = re.exec(xmlText)) !== null) {
                            const nm = /\bname="([^"]+)"/.exec(m[1]), tp = /\btype="([^"]+)"/.exec(m[1]);
                            if (nm && tp) add(nm[1], tp[1]);
                        }
                    }
                    return cols.length ? classify(cols, geom) : null;
                };
                // GML-ответ (сервер/прокси не отдал JSON) → GeoJSON-подобные объекты
                const gmlToFeatures = (text) => {
                    try {
                        if (!/FeatureCollection/i.test(text.slice(0, 2000))) return null;
                        const feats = new ol.format.WFS().readFeatures(text);
                        const gj = new ol.format.GeoJSON();
                        return feats.map(f => {
                            const o = gj.writeFeatureObject(f, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
                            o.properties = o.properties || {};
                            return o;
                        });
                    } catch (_) { return null; }
                };
                const readFeatures = async (res, url) => {
                    if(!res.ok)throw new Error('WFS HTTP '+res.status);
                    let text = await res.text();
                    let data = null;
                    try { data = JSON.parse(text); } catch (_) {}
                    if (!data && url && /FeatureCollection/i.test(text.slice(0, 2000))) {
                        // повторяем в EPSG:3857 без outputFormat — нет путаницы с порядком осей
                        try {
                            const u2 = url.replace(/&outputFormat=[^&]*/i, '').replace(/srsName=EPSG:4326/i, 'srsName=EPSG:3857');
                            const feats = gmlToFeatures(await (await searchFetch(u2)).text());
                            if (feats) return feats;
                        } catch (e) { if (searchController.signal.aborted) throw e; }
                    }
                    if (!data) {
                        const m = /<(?:\w+:)?(?:ServiceException|ExceptionText)[^>]*>([\s\S]*?)<\//i.exec(text);
                        throw new Error(m ? m[1].trim().slice(0, 200) : ('GetFeature HTTP ' + res.status));
                    }
                    if (!Array.isArray(data.features)) throw new Error('Invalid WFS feature collection');
                    return data.features;
                };
                const schemaCache = window._lspWfsSchemaCache2 || (window._lspWfsSchemaCache2 = {});
                async function getSchema(def) {
                    const key = def.wmsUrl + ':' + def.sublabel;
                    if (schemaCache[key]) return schemaCache[key];
                    const wfsBase = getWfsBaseUrl(def.wmsUrl);
                    let sc = null;
                    try {
                        const r = await searchFetch(_wfsUrl(wfsBase, def.wmsUrl,
                            'service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=' + encodeURIComponent(def.sublabel)));
                        if (r.ok) sc = parseSchema(await r.text());
                    } catch (e) { if (searchController.signal.aborted) throw e; }
                    if (!sc) {   // запасной путь: имена полей из первого объекта слоя
                        const r = await searchFetch(_wfsUrl(wfsBase, def.wmsUrl,
                            'service=WFS&version=1.1.0&request=GetFeature&typeName=' + encodeURIComponent(def.sublabel) +
                            '&outputFormat=application/json&maxFeatures=1&srsName=EPSG:4326'));
                        const text = await r.text();
                        let data = null; try { data = JSON.parse(text); } catch (_) {}
                        const f = data && data.features && data.features[0];
                        if (f && f.properties) {
                            const cols = Object.entries(f.properties).filter(([, v]) => v === null || ['string', 'number'].includes(typeof v))
                                .map(([k, v]) => ({ name: k, numeric: typeof v === 'number' }));
                            sc = classify(cols, data.features[0].geometry_name || null);
                        }
                    }
                    if (!sc) throw new Error('не удалось получить поля слоя');
                    schemaCache[key] = sc;
                    return sc;
                }
                const fq = c => '"' + c.name.replace(/"/g, '""') + '"';
                const sq = v => "'" + String(v).replace(/'/g, "''") + "'";
                const eqNum = (c, n) => c.numeric ? fq(c) + ' = ' + n : fq(c) + ' = ' + sq(n);
                const inList = (c, list) => '(' + list.map(v => c.numeric && /^\d+$/.test(v) ? fq(c) + ' = ' + v : fq(c) + ' = ' + sq(v)).join(' OR ') + ')';
                const textCond = (cols, mode) => cols.map(c => mode === 'ilike'
                    ? fq(c) + (exactMode ? ' ILIKE ' + sq(P.text) : ' ILIKE ' + sq('%' + P.like + '%'))
                    : 'strToLowerCase(' + fq(c) + ')' + (exactMode ? ' = ' + sq(P.text.toLowerCase()) : ' LIKE ' + sq('%' + P.like.toLowerCase() + '%'))).join(' OR ');
                const bboxCond = (sc) => {
                    if (!sc.geom) return null;
                    try {
                        const e = ol.proj.transformExtent(view.calculateExtent(map.getSize()), 'EPSG:3857', 'EPSG:4326');
                        return 'BBOX(' + fq({ name: sc.geom }) + ',' + e.map(v => v.toFixed(6)).join(',') + ",'EPSG:4326')";
                    } catch (_) { return null; }
                };
                async function wfsGet(def, cql, max) {
                    const url = _wfsUrl(getWfsBaseUrl(def.wmsUrl), def.wmsUrl,
                        'service=WFS&version=1.1.0&request=GetFeature&typeName=' + encodeURIComponent(def.sublabel) +
                        '&outputFormat=application/json&maxFeatures=' + (max || 30) + '&srsName=EPSG:4326&cql_filter=' + encodeURIComponent(cql));
                    return readFeatures(await searchFetch(url), url);
                }
                // текстовый поиск: сначала поля «name», при ошибке — ILIKE→LIKE, затем по одному полю
                async function textSearch(def, sc, extra) {
                    const cols = (sc.names.length ? sc.names : sc.str).slice(0, 12);
                    if (!cols.length || !P.text) return [];
                    const wrap = c => extra ? '(' + c + ') OR ' + extra : c;
                    try { return await wfsGet(def, wrap(textCond(cols, 'ilike'))); }
                    catch (e1) { if (searchController.signal.aborted) throw e1; }
                    try { return await wfsGet(def, wrap(textCond(cols, 'lower'))); }
                    catch (e2) { if (searchController.signal.aborted) throw e2; }
                    const good = [], found = [];
                    for (const c of cols.slice(0, 5)) {
                        try { found.push(...await wfsGet(def, textCond([c], 'lower'), 15)); good.push(c); }
                        catch (e3) { if (searchController.signal.aborted) throw e3; }
                    }
                    if (good.length) { sc.names = good; return found; }
                    throw new Error('слой не поддерживает текстовый фильтр');
                }
                const val = (f, c) => c && f.properties ? f.properties[c.name] : undefined;
                const pushGs = (type, def, feature, name, sub, front) => {
                    const item = { type, name, sub, color: '#42a5f5', icon: def.icon || 'fa-server', feature, layerKey: def.key };
                    if (front) results.splice(front.idx++, 0, item); else results.push(item);
                };
                const front = { idx: results.length };   // кварталы/выделы — сразу после лесхозов

                async function searchLayer(def) {
                    const sc = await getSchema(def);
                    if (sid !== _lspSearchId || searchController.signal.aborted) return;
                    const R = sc.roles;
                    const lxCond = (R.leshoz && P.leshozCodes.length) ? inList(R.leshoz, P.leshozCodes) : null;
                    if (def.key === 'gs_quarter' || def.key === 'gs_allotment') {
                        const isAllot = def.key === 'gs_allotment';
                        if (P.quarter == null || !R.quarter) return;                      // без номера квартала не ищем
                        if (isAllot && (P.allot == null || !R.allot)) return;
                        const cond = [eqNum(R.quarter, P.quarter)];
                        if (isAllot) cond.push(eqNum(R.allot, P.allot));
                        if (P.lesnichNum != null && R.lesnich) cond.push(eqNum(R.lesnich, P.lesnichNum));
                        if (lxCond) cond.push(lxCond);
                        else { const bb = bboxCond(sc); if (bb) cond.push(bb); else if (P.text) return; }
                        const feats = await wfsGet(def, cond.join(' AND '), 40);
                        if (sid !== _lspSearchId) return;
                        feats.forEach(f => {
                            const lx = val(f, R.leshoz), ln = val(f, R.lesnich);
                            const where = [ln != null ? 'лесничество №' + ln : '', lx != null ? (leshozName(lx) || 'лесхоз ' + lx) : ''].filter(Boolean).join(' · ');
                            const nm = isAllot ? 'Выдел ' + (val(f, R.allot) ?? P.allot) + ', квартал ' + (val(f, R.quarter) ?? P.quarter)
                                               : 'Квартал ' + (val(f, R.quarter) ?? P.quarter);
                            pushGs(isAllot ? 'gs_allotment' : 'gs_quarter', def, f, nm, [def.label, where || (lxCond ? '' : 'в видимой области карты')].filter(Boolean).join(' · '), front);
                        });
                        return;
                    }
                    if (!CORE_KEYS.includes(def.key)) {
                        const cols = sc.cols;
                        const found = new Map();
                        for(let offset=0;offset<cols.length;offset+=12){
                            if(searchDeadline.aborted||searchController.signal.aborted)return;
                            const batch=cols.slice(offset,offset+12);
                            const conditions=batch.map(c=>c.numeric ? (/^-?\d+(?:[.,]\d+)?$/.test(query)?fq(c)+' = '+Number(query.replace(',','.')):null) : fq(c)+' ILIKE '+sq(exactMode?query:'%'+query+'%')).filter(Boolean);
                            if(!conditions.length)continue;
                            let feats;
                            try{feats=await wfsGet(def,conditions.join(' OR '),50);}
                            catch(error){
                                if(searchDeadline.aborted||searchController.signal.aborted)throw error;
                                const fallback=batch.map(c=>c.numeric?(/^-?\d+(?:[.,]\d+)?$/.test(query)?fq(c)+' = '+Number(query.replace(',','.')):null):'strToLowerCase('+fq(c)+')'+(exactMode?' = ':' LIKE ')+sq(exactMode?query.toLowerCase():'%'+query.toLowerCase()+'%')).filter(Boolean);
                                feats=await wfsGet(def,fallback.join(' OR '),50);
                            }
                            feats.forEach(f=>found.set(f.id||JSON.stringify(f),f));
                        }
                        if(sid!==_lspSearchId)return;
                        found.forEach(f=>{const props=f.properties||{},pairs=Object.entries(props).filter(([,v])=>v!=null&&typeof v!=='object'&&FS.matches(v,query,exactMode));const main=sc.names.find(c=>props[c.name])||null;pushGs('gs',def,f,main?String(props[main.name]):pairs.length?String(pairs[0][1]):def.label,def.label+' · '+pairs.slice(0,3).map(([k,v])=>k+': '+v).join(' · '));});
                        return;
                    }
                    if (!P.text) {
                        // только числа: лесничество по номеру внутри лесхоза
                        if (def.key === 'gs_lesnich' && P.lesnichNum != null && R.lesnich && lxCond) {
                            (await wfsGet(def, eqNum(R.lesnich, P.lesnichNum) + ' AND ' + lxCond)).forEach(f =>
                                pushGs('lesnich', def, f, String(val(f, sc.names[0]) || 'Лесничество №' + P.lesnichNum), def.label + ' · ' + leshozName(val(f, R.leshoz)), front));
                        }
                        return;
                    }
                    // лесничества: по названию ИЛИ все лесничества найденного лесхоза
                    const extra = (def.key === 'gs_lesnich' && lxCond && P.quarter == null) ? lxCond : null;
                    const feats = await textSearch(def, sc, extra);
                    if (sid !== _lspSearchId) return;
                    const qq = P.like.toLowerCase();
                    feats.forEach(feature => {
                        const props = feature.properties || {};
                        const matches = Object.entries(props).filter(([k, v]) => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(qq));
                        const nameCol = sc.names.find(c => props[c.name]) || null;
                        const main = nameCol ? [nameCol.name, props[nameCol.name]] : (matches.find(([k]) => !/^(id|fid|gid|objectid)$/i.test(k)) || matches[0]);
                        const lx = val(feature, R.leshoz);
                        const sub = [def.label, lx != null && def.key !== 'gs_leshoz' ? leshozName(lx) : '']
                            .concat(matches.filter(m => !main || m[0] !== main[0]).slice(0, 2).map(([k, v]) => k + ': ' + v)).filter(Boolean).join(' · ');
                        const type = def.key === 'gs_lesnich' ? 'lesnich' : def.key === 'gs_leshoz' ? 'gs_leshoz' : 'gs';
                        pushGs(type, def, feature, main ? String(main[1]) : def.label, sub);
                    });
                }
                let cursor = 0;
                async function worker() {
                    while (cursor < activeGeoLayers.length && sid === _lspSearchId && !searchController.signal.aborted && !searchDeadline.aborted) {
                        const def = activeGeoLayers[cursor++];
                        try { await searchLayer(def); if(sid===_lspSearchId)renderSearchResults(); }
                        catch (error) {
                            if (!searchController.signal.aborted && sid === _lspSearchId) {
                                searchErrors.push(def.label);
                                console.warn('[WFS Search]', def.label, error && error.message);
                            }
                        }
                    }
                }
                await Promise.all(Array.from({length: Math.min(4, activeGeoLayers.length)}, worker));
                if(searchDeadline.aborted)searchErrors.push(...activeGeoLayers.slice(cursor).map(d=>d.label));
            }})();
            const osmData = await osmPromise;
            if(sid!==_lspSearchId)return;

            if (Array.isArray(osmData)) {
                osmData.forEach(place => {
                    const parts = (place.display_name || '').split(',').map(s => s.trim());
                    results.push({ type: 'place', name: parts[0], sub: _geoNote(place) + parts.slice(1, 3).join(', '),
                        lat: parseFloat(place.lat), lon: parseFloat(place.lon),
                        bbox: place.boundingbox, color: '#26a69a', icon: 'fa-location-dot' });
                });
            }

            renderSearchResults();
            await gsPromise;
            loading = false;
            if(sid!==_lspSearchId)return;
            renderSearchResults();

            function renderSearchResults() {
            if (sid !== _lspSearchId) return;
            rc.title = searchErrors.length ? 'Не удалось опросить: ' + searchErrors.join(', ') : '';

            if (!results.length) {
                rc.innerHTML = `<div class="lsr-no-res">${loading?'Поиск объектов…':searchErrors.length ? 'Часть слоёв не ответила. Попробуйте уточнить запрос.' : 'Ничего не найдено'}<div style="font-size:14px;opacity:.85;margin-top:8px;">Квартал / выдел: «Вилейский 35», «Вилейский 35 12», «кв 35 выд 12»</div></div>`;
                return;
            }

            rc.innerHTML = '';
            if (searchErrors.length) {
                const warn = document.createElement('div');
                warn.className = 'lsr-no-res';
                warn.style.cssText = 'font-size:14px;color:#f1d18d;padding:10px 12px;';
                warn.textContent = 'Не удалось опросить: ' + searchErrors.join(', ') + ' (ошибка WFS или таймаут)';
                rc.appendChild(warn);
            }
            const summary=document.createElement('div');summary.className='lsr-summary';summary.textContent='Найдено: '+results.length+(loading?' · объекты ещё загружаются…':' · до 50 объектов на пакет WFS');rc.appendChild(summary);
            const sorted=results.slice().sort((a,b)=>Number(['catalog','dzz'].includes(b.type))-Number(['catalog','dzz'].includes(a.type))||String(a.name).localeCompare(String(b.name),'ru'));
            sorted.slice(0, resultLimit).forEach(item => {
                const el = document.createElement('div');
                el.className = 'lsr-item';el.tabIndex=0;el.setAttribute('role','button');
                el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}});
                const badge = item.type === 'leshoz'
                    ? `<span class="lsr-badge">${item.code}</span>`
                    : '';
                el.innerHTML = `
                    <span class="lsr-ico" style="color:${item.color};">${FS.icon(item.type)}</span>
                    <div class="lsr-info">
                        <div class="lsr-name">${FS.esc(item.name)}</div>
                        ${item.sub ? `<div class="lsr-sub">${FS.esc(item.sub)}</div>` : ''}
                    </div>
                    ${badge}`;
                el.addEventListener('click', () => {
                    _lspHideResults();
                    _lspHideFilterPanel();
                    if(item.type==='catalog'||item.type==='local') {
                        if(item.basemapKey) window.setBasemap&&window.setBasemap(item.basemapKey);
                        else if(item.mbtilesId){window.toggleMbtilesLayer&&window.toggleMbtilesLayer(item.mbtilesId,true);window.zoomToMbtilesLayer&&window.zoomToMbtilesLayer(item.mbtilesId);}
                        else if(item.builtinKey){const key=item.builtinKey,lyr=key==='forestry'?_forestryFillLayer:key==='weather_leskhozi'?window._weatherLayer:_layers['raster-tiles'];if(lyr){lyr.setVisible(true);AppState.layerState[key]=true;window._saveLayersState&&window._saveLayersState();}}
                        else if(item.layerKey) window.toggleExternalLayer&&window.toggleExternalLayer(item.layerKey,null,true);
                        else if(item.vectorId){
                            const lyr=_layers['vector-'+item.vectorId];
                            if(lyr){lyr.setVisible(true);const ext=item.type==='local'&&item.bounds?ol.proj.transformExtent([item.bounds[0][0],item.bounds[0][1],item.bounds[1][0],item.bounds[1][1]],'EPSG:4326','EPSG:3857'):lyr.getSource().getExtent();if(ext&&ext.every(Number.isFinite))view.fit(ext,{maxZoom:17,duration:700,padding:[50,50,50,50]});}
                        }
                        if(item.bbox)view.fit(ol.proj.transformExtent(item.bbox,'EPSG:4326','EPSG:3857'),{maxZoom:15,duration:700});
                    } else if (item.type === 'leshoz') {
                        window.focusOnLeskhoz && window.focusOnLeskhoz(item.code, true);
                    } else if (item.type === 'place') {
                        const lonLat = [item.lon, item.lat];
                        if (item.bbox) {
                            const b = item.bbox;
                            // Nominatim boundingbox: [south, north, west, east]
                            const ext = ol.proj.transformExtent(
                                [parseFloat(b[2]), parseFloat(b[0]), parseFloat(b[3]), parseFloat(b[1])],
                                'EPSG:4326', 'EPSG:3857');
                            view.fit(ext, { maxZoom: 14, duration: 800 });
                        } else {
                            view.animate({ center: ol.proj.fromLonLat(lonLat), zoom: 14, duration: 800 });
                        }
                        // Маркер точно на координатах Nominatim
                        setTimeout(() => _showSearchPin(lonLat, item.name || item.title || '', 8000), 900);
                    } else if (['gs','gs_leshoz','lesnich','gs_quarter','gs_allotment'].includes(item.type) && item.feature) {
                        if(item.layerKey)window.toggleExternalLayer&&window.toggleExternalLayer(item.layerKey,null,true);
                        const coords = item.feature.geometry?.coordinates;
                        if (coords) {
                            if (item.feature.geometry.type === 'Point') {
                                view.animate({ center: ol.proj.fromLonLat(coords), zoom: 16, duration: 800 });
                            } else {
                                try {
                                    const flat = coords.flat(Infinity);
                                    let mnX=180,mxX=-180,mnY=90,mxY=-90;
                                    for (let i=0;i<flat.length;i+=2){mnX=Math.min(mnX,flat[i]);mxX=Math.max(mxX,flat[i]);mnY=Math.min(mnY,flat[i+1]);mxY=Math.max(mxY,flat[i+1]);}
                                    const ext = ol.proj.transformExtent([mnX,mnY,mxX,mxY],'EPSG:4326','EPSG:3857');
                                    view.fit(ext, { maxZoom: 16, duration: 800 });
                                } catch(_) {}
                            }
                        }
                    } else if (item.type === 'dzz') {
                        // Активируем слои ДЗЗ — исправлена сигнатура: (key, layerName, isOn)
                        (item.dzzSubkeys || []).forEach(sk => {
                            if (typeof window.toggleExternalLayer === 'function') {
                                window.toggleExternalLayer(sk, null, true);
                            } else if (window.ExternalLayerState) {
                                window.ExternalLayerState[sk] = true;
                            }
                        });
                        // Сохраняем активную вкладку
                        try { localStorage.setItem('dzz_active_tab', item.dzzTabId); } catch(_) {}
                        // Открываем панель ДЗЗ через кнопку иконбара
                        const dzzBtn = document.querySelector('.mib-btn[data-tool="dzz"]');
                        if (dzzBtn) dzzBtn.click();
                        // Приближение к bbox снимка/лесхоза
                        // [v20.8] сначала — настоящий охват из GeoServer (static/dzz-extent.js);
                        // «ручной» bbox из _dzzTabs и WFS без СК — только запасной путь
                        if (window.DzzExtent && window.DzzExtent.zoomToSearchItem(item)) {
                            /* приближение выполнено dzz-extent.js */
                        } else if (item.bbox) {
                            // bbox задан напрямую (базовое ЛУ)
                            try {
                                const ext = ol.proj.transformExtent(item.bbox, 'EPSG:4326', 'EPSG:3857');
                                view.fit(ext, { maxZoom: 14, duration: 900, padding: [60, 60, 60, 60] });
                            } catch(_) {}
                        } else if (item.boundsKey) {
                            // Спутниковый снимок — запрашиваем bbox через WFS у bounds-слоя
                            const bDef = (window.EXTERNAL_LAYER_DEFS || []).find(d => d.key === item.boundsKey);
                            if (bDef) {
                                const layerName = bDef.sublabel; // например External:4108041-..._bounds
                                const wfsUrl = `${CONFIG.GEOSERVER_WMS}?SERVICE=WFS&VERSION=1.0.0` +
                                    `&REQUEST=GetFeature&typeName=${encodeURIComponent(layerName)}` +
                                    `&outputFormat=application%2Fjson&maxFeatures=1`;
                                fetch(wfsUrl)
                                    .then(r => r.json())
                                    .then(fc => {
                                        if (!fc.features || !fc.features.length) return;
                                        const coords = fc.features[0].geometry?.coordinates;
                                        if (!coords) return;
                                        const flat = coords.flat(Infinity);
                                        let mnX=180,mxX=-180,mnY=90,mxY=-90;
                                        for (let i=0;i<flat.length;i+=2){
                                            mnX=Math.min(mnX,flat[i]); mxX=Math.max(mxX,flat[i]);
                                            mnY=Math.min(mnY,flat[i+1]); mxY=Math.max(mxY,flat[i+1]);
                                        }
                                        const ext = ol.proj.transformExtent([mnX,mnY,mxX,mxY],'EPSG:4326','EPSG:3857');
                                        view.fit(ext, { maxZoom: 14, duration: 900, padding: [60, 60, 60, 60] });
                                    })
                                    .catch(() => {});
                            }
                        }
                        window.showToast && window.showToast(
                            `<i class="fa-solid ${item.icon}" style="margin-right:5px;"></i>` +
                            `${FS.esc(item.name)} — слой активирован`, false
                        );
                    }
                });
                rc.appendChild(el);
            });
            if(results.length>resultLimit){const more=document.createElement('button');more.type='button';more.className='lsr-more';more.textContent='Показать ещё · осталось '+(results.length-resultLimit);more.onclick=()=>{resultLimit+=50;renderSearchResults();};rc.appendChild(more);}
            }
        }
    }

    
    // ── Хелперы иконбара — используются в buildIconBar и buildSettingsPanel ──
    function _applyIconColor(accent, bg) {
        if (!bg) {
            const r=parseInt(accent.slice(1,3),16),g=parseInt(accent.slice(3,5),16),b=parseInt(accent.slice(5,7),16);
            const lum=r*0.299+g*0.587+b*0.114;
            bg=lum>100?'#'+[r,g,b].map(c=>Math.max(0,Math.round(c*0.18)).toString(16).padStart(2,'0')).join(''):'#1a1a2e';
        }
        document.documentElement.style.setProperty('--icon-accent', accent);
        document.documentElement.style.setProperty('--icon-bg-active', bg);
        document.documentElement.style.setProperty('--icon-hover-color', bg);
        localStorage.setItem('ui_icon_color', accent);
        localStorage.setItem('ui_icon_bg', bg);
    }

    function _applyIconSize(px) {
        return window.MapIconStyle.applySize(px);
    }

    function _applyBtnVisibility(key, visible) {
        if (key === 'btn_fullscr') {
            const fsEl = document.getElementById('map-fullscreen-btn');
            if (fsEl) fsEl.style.display = visible ? '' : 'none';
            return;
        }
        const iconMap = {
            btn_layers:'fa-layer-group', btn_basemap:'fa-map', btn_measure:'fa-ruler',
            btn_print:'fa-print', btn_dzz:'fa-satellite-dish', btn_hotspots:'fa-fire',
            btn_timeline:'fa-clock-rotate-left', btn_settings:'fa-gear',
            btn_home:'fa-house', btn_coords:'fa-crosshairs', btn_help:'fa-circle-question',
            btn_crs:'fa-earth-europe',
        };
        const cls = iconMap[key]; if (!cls) return;
        document.querySelectorAll('.mib-btn').forEach(btn => {
            if (btn.querySelector('.' + cls)) btn.style.display = visible ? '' : 'none';
        });
    }
    // Экспортируем для panel-layers.js (buildSettingsPanel использует те же функции)
    window._applyIconColor = _applyIconColor;
    window._applyIconSize = _applyIconSize;
    window._applyBtnVisibility = _applyBtnVisibility;

        // ── Добавляет тумблер "Геолокация" в панель настроек, сразу под "Полноэкранный режим" ──
        // Панель настроек рендерится отдельным файлом (panel-layers.js) через buildSettingsPanel,
        // поэтому вместо дублирования вёрстки клонируем уже отрисованную строку "Полноэкранный
        // режим" в реальном DOM — так стиль тумблера гарантированно совпадает 1-в-1, даже если
        // panel-layers.js изменится. Наблюдатель следит за панелью, пока она открыта, и
        // восстанавливает наш тумблер, если panel-layers.js перерисовывает список при drag&drop
        // иконок, сбросе настроек и т.п.
        function _injectGeolocationToggle(container) {
            function _findToggleRow(labelText) {
                const nodes = container.querySelectorAll('*');
                for (const el of nodes) {
                    if (el.children.length === 0 && el.textContent.trim() === labelText) {
                        let row = el.parentElement, guard = 0;
                        while (row && guard < 4) {
                            const hasToggle = row.querySelector('input[type="checkbox"], [role="switch"], [class*="toggle" i], [class*="switch" i]');
                            if (hasToggle) return { row, label: el };
                            row = row.parentElement; guard++;
                        }
                        return null;
                    }
                }
                return null;
            }

            function _setCloneState(clone, on) {
                clone.classList.toggle('sf-geoloc-on', on);
                const cb = clone.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = on;
                clone.querySelectorAll('[class*="toggle" i], [class*="switch" i], [role="switch"]').forEach(t => {
                    t.classList.toggle('on', on);
                    t.classList.toggle('active', on);
                    t.classList.toggle('checked', on);
                    if (t.getAttribute('role') === 'switch') t.setAttribute('aria-checked', String(on));
                });
            }

            function _tryInject() {
                if (container.querySelector('.sf-geoloc-row') || container.querySelector('#toggle-geoloc')) return true;
                const found = _findToggleRow('Полноэкранный режим');
                if (!found) return false;

                const clone = found.row.cloneNode(true);
                clone.classList.add('sf-geoloc-row');

                // Меняем подпись на "Геолокация"
                const labelInClone = Array.from(clone.querySelectorAll('*'))
                    .find(n => n.children.length === 0 && n.textContent.trim() === 'Полноэкранный режим');
                if (labelInClone) labelInClone.textContent = 'Геолокация';

                // Меняем иконку fa-expand/compress → fa-location-crosshairs
                const iconEl = clone.querySelector('i[class*="fa-expand"], i[class*="fa-compress"]');
                if (iconEl) {
                    iconEl.classList.remove('fa-expand', 'fa-compress');
                    iconEl.classList.add('fa-location-crosshairs');
                }

                // Выставляем сохранённое состояние
                const enabled = localStorage.getItem('ui_geolocation_btn') !== 'false';
                _setCloneState(clone, enabled);

                // Свой обработчик клика — независим от внутренней логики panel-layers.js
                clone.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const cur = localStorage.getItem('ui_geolocation_btn') !== 'false';
                    const next = !cur;
                    localStorage.setItem('ui_geolocation_btn', next ? 'true' : 'false');
                    _setCloneState(clone, next);
                    if (typeof window._applyGeolocationBtnVisibility === 'function') {
                        window._applyGeolocationBtnVisibility(next);
                    }
                }, true);

                found.row.parentElement.insertBefore(clone, found.row.nextSibling);
                return true;
            }

            if (_tryInject()) return;
            const obs = new MutationObserver(function() {
                if (!container.isConnected || container.children.length === 0) { obs.disconnect(); return; }
                _tryInject();
            });
            obs.observe(container, { childList: true, subtree: true });
            // Предохранитель — не следим вечно, если панель настроек так и не появилась
            setTimeout(() => obs.disconnect(), 8000);
        }

        function buildIconBar(iconBar, slidePanel) {
        let currentPanel = null;

        function closeSlidePanel() {
            slidePanel.classList.remove('open');
            currentPanel = null;
            window._currentPanel = null;
            iconBar.querySelectorAll('.mib-btn').forEach(b => b.classList.remove('active-panel'));
            if (typeof window._panelCleanup === 'function') { try { window._panelCleanup(); } catch(e) {} window._panelCleanup = null; }
            setTimeout(() => { if (!currentPanel) slidePanel.innerHTML = ''; }, 260);
            // Сбрасываем сохранённое состояние панели
            try { localStorage.removeItem('ui_open_panel'); } catch(_) {}
        }

        // ── Закрыть панель измерений если открыта ──────────────────────────
        function _closeMsrPanel() {
            const msrPanel = document.getElementById('msr-side-panel');
            if (msrPanel) {
                msrPanel._disposeMeasurementLayout && msrPanel._disposeMeasurementLayout();
                msrPanel.classList.remove('msr-side-open');
                setTimeout(() => { if (msrPanel.parentNode) msrPanel.remove(); }, 240);
            }
            // Снять active/msr-on с кнопки измерений
            const msrBtn = iconBar.querySelector('.mib-btn[data-tool="measure"]');
            if (msrBtn) msrBtn.classList.remove('active-panel', 'msr-on');
        }

        function openSlidePanel(type, btn) {
            // Закрываем панель измерений при открытии любой другой панели
            _closeMsrPanel();
            if (currentPanel === type) {
                // Для timeline — используем сохранённый close-handler чтобы восстановить sidebar/scalebar/fullscreen
                if (type === 'timeline' && typeof window._timelineCloseHandler === 'function') {
                    window._timelineCloseHandler();
                } else {
                    closeSlidePanel();
                }
                return;
            }
            if (typeof window._panelCleanup === 'function') { try { window._panelCleanup(); } catch(e) {} window._panelCleanup = null; }
            const existingPop = document.getElementById('measure-popover');
            if (existingPop) { existingPop.classList.remove('pop-open'); setTimeout(()=>{ if(existingPop.parentNode) existingPop.remove(); },220); }
            slidePanel.innerHTML = '';
            currentPanel = type;
            window._currentPanel = type;
            iconBar.querySelectorAll('.mib-btn').forEach(b => b.classList.remove('active-panel'));
            btn.classList.add('active-panel');
            // Сохраняем открытую панель для восстановления после перезагрузки
            try { localStorage.setItem('ui_open_panel', type); } catch(_) {}

            // ── Lazy-loading панелей через <script> тег ────────────────────────────
            // Используем createElement('script') вместо import() —
            // import() блокируется Edge/Safari Tracking Prevention в обычных скриптах.
            // Повторные вызовы мгновенны: функция уже в window после первой загрузки.
            // _loadPanel(src, fnName, ...args)
            // fnName — строка имени функции в window (ищем в onload, а не при вызове)
            // Если скрипт уже загружен — window[fnName] уже есть, вызываем сразу.
            function _loadPanel(src, fnName, ...args) {
                if (typeof window[fnName] === 'function') { window[fnName](...args); return; }
                const v = (window._staticVer || '1') + '-icons-v3';
                const s = document.createElement('script');
                s.src = src + '?v=' + v;
                s.onload = () => {
                    if (typeof window[fnName] === 'function') { window[fnName](...args); }
                    else { console.error('[panel] Функция не найдена после загрузки:', fnName); }
                };
                s.onerror = () => console.error('[panel] 404:', s.src);
                document.head.appendChild(s);
            }

            if (type === 'layers') {
                _loadPanel('/static/panel-layers.js', 'buildLayersPanel', slidePanel, closeSlidePanel);
            }
            else if (type === 'basemaps') {
                _loadPanel('/static/panel-layers.js', 'buildBasemapsPanel', slidePanel, closeSlidePanel);
            }
            else if (type === 'settings') {
                _loadPanel('/static/panel-layers.js', 'buildSettingsPanel', slidePanel, closeSlidePanel);
                _injectGeolocationToggle(slidePanel);
            }
            else if (type === 'print') {
                _loadPanel('/static/panel-print.js', 'buildPrintPanel', slidePanel, closeSlidePanel);
            }
            else if (type === 'crs') {
                _loadPanel('/static/panel-crs.js', 'buildCrsPanel', slidePanel, closeSlidePanel);
            }
            else if (type === 'dzz') {
                _loadPanel('/static/panel-dzz.js', 'buildDZZPanel', slidePanel, closeSlidePanel);
            }
            else if (type === 'hotspots') {
                _loadPanel('/static/panel-hotspots.js', 'buildHotspotsPanel_OL', slidePanel, closeSlidePanel);
            }
            else if (type === 'timeline') {
                // Timeline не использует slidePanel — только нижняя шкала
                // slidePanel остаётся закрытым, вызываем buildYearTimelinePanel с пустым контейнером
                const _dummyClose = () => {
                    window._timelineCloseHandler = null;
                    closeSlidePanel();
                    document.body.classList.remove('timeline-active');
                    // Восстанавливаем кнопку полноэкранного режима (если она включена в настройках)
                    const _fsBtn2 = document.getElementById('map-fullscreen-btn');
                    if (_fsBtn2) {
                        const fsBtnEnabled = localStorage.getItem('ui_fullscreen_btn') !== 'false';
                        _fsBtn2.style.display = fsBtnEnabled ? '' : 'none';
                    }
                    // Восстанавливаем масштабную линейку (если включена в настройках)
                    const _scaleBar2 = document.getElementById('custom-scale-bar');
                    if (_scaleBar2) {
                        const scaleEnabled = localStorage.getItem('ui_scale_bar') !== 'false';
                        if (scaleEnabled) _scaleBar2.style.display = '';
                    }
                    // Восстанавливаем меню лесхозов (если включено в настройках)
                    const _sb2 = document.querySelector('.sidebar');
                    if (_sb2) {
                        const sidebarEnabled = localStorage.getItem('ui_sidebar') !== 'false';
                        if (sidebarEnabled) {
                            _sb2.style.display = '';
                            setTimeout(() => {
                                map.updateSize();
                                window._updateScaleBarOffset && window._updateScaleBarOffset();
                            }, 200);
                        }
                    }
                    if (typeof window._panelCleanup === 'function') { try { window._panelCleanup(); } catch(e) {} window._panelCleanup = null; }
                };
                slidePanel.innerHTML = '';
                // slidePanel НЕ открываем (.open не добавляем)
                document.body.classList.add('timeline-active');
                // Скрываем кнопку полноэкранного режима
                const _fsBtn = document.getElementById('map-fullscreen-btn');
                if (_fsBtn) _fsBtn.style.display = 'none';
                // Скрываем масштабную линейку
                const _scaleBar = document.getElementById('custom-scale-bar');
                if (_scaleBar) _scaleBar.style.display = 'none';
                // Скрываем меню лесхозов
                const _sb = document.querySelector('.sidebar');
                if (_sb) {
                    _sb.style.display = 'none';
                    setTimeout(() => {
                        map.updateSize();
                        window._updateScaleBarOffset && window._updateScaleBarOffset();
                    }, 200);
                }
                window._timelineCloseHandler = _dummyClose;
                if (typeof buildYearTimelinePanel === 'function') { buildYearTimelinePanel(slidePanel, _dummyClose); }
                else { _loadPanel('/static/panel-timeline.js', 'buildYearTimelinePanel', slidePanel, _dummyClose); }
                return; // выходим досрочно — не добавляем класс 'open'
            }

            slidePanel.classList.add('open');
        }

        // Кнопки иконбара — порядок по скриншоту пользователя:
        // ДЗЗ → Карта → Слои → Линейка → Принтер → Огонь → Таймлайн → Настройки → Справка
        const BUTTONS = [
            { icon: 'fa-satellite-dish',    tip: 'ДЗЗ — Снимки',        type: 'dzz',       key: 'btn_dzz'      },
            { icon: 'fa-map',               tip: 'Подложка карты',      type: 'basemaps',  key: 'btn_basemap'  },
            { icon: 'fa-layer-group',       tip: 'Слои данных',         type: 'layers',    key: 'btn_layers'   },
            { icon: 'fa-ruler',             tip: 'Измерения',           type: 'measure',   key: 'btn_measure'  },
            { icon: 'fa-print',             tip: 'Печать',              type: 'print',     key: 'btn_print'    },
            { icon: 'fa-fire',              tip: 'MeteoEye',            type: 'hotspots',  key: 'btn_hotspots' },
            { icon: 'fa-clock-rotate-left', tip: 'Съёмка по годам',     type: 'timeline',  key: 'btn_timeline' },
            { icon: 'fa-earth-europe',      tip: 'Конвертер СК',        type: 'crs',       key: 'btn_crs'      },
            { icon: 'fa-gear',              tip: 'Настройки',           type: 'settings',  key: 'btn_settings' },
            { icon: 'fa-circle-question',   tip: 'Справка',             type: 'help',      key: 'btn_help'     },
        ];

        // Apply saved order from localStorage
        function _getOrderedButtons() {
            try {
                const saved = localStorage.getItem('ui_icon_order');
                if (saved) {
                    const order = JSON.parse(saved);
                    const sorted = [];
                    order.forEach(key => { const f = BUTTONS.find(b => b.key === key); if (f) sorted.push(f); });
                    BUTTONS.forEach(b => {
                        if (sorted.find(s => s.key === b.key)) return;
                        // Новые кнопки (напр. «Конвертер СК») — перед «Настройками», а не в конец
                        const si = sorted.findIndex(s => s.key === 'btn_settings');
                        if (si >= 0) sorted.splice(si, 0, b); else sorted.push(b);
                    });
                    return sorted;
                }
            } catch(e) {}
            return BUTTONS;
        }

        _getOrderedButtons().forEach(bDef => {
            const visible = localStorage.getItem(bDef.key) !== 'false';
            const btn = document.createElement('button');
            btn.className = 'mib-btn';
            btn.dataset.tool = bDef.type;
            btn.type='button';btn.title=bDef.tip;btn.setAttribute('aria-label',bDef.tip);
            btn.style.display = visible ? '' : 'none';
            btn.innerHTML = `<i class="fa-solid ${bDef.icon}"></i><span class="mib-tip">${bDef.tip}</span>`;
            btn.addEventListener('click', () => {
                if (bDef.type === 'home') {
                    // Подгоняем вид по реальному экстенту границы Беларуси
                        const _blayer = _layers && _layers['belarus-border-line'];
                        if (_blayer && _blayer.getSource) {
                            const _bsrc = _blayer.getSource();
                            if (_bsrc && _bsrc.getFeatures && _bsrc.getFeatures().length > 0) {
                                const _bext = _bsrc.getExtent();
                                if (_bext && isFinite(_bext[0])) { view.fit(_bext, { duration: 800, padding: [40, 40, 40, 40] }); }
                                else { view.fit(ol.proj.transformExtent([23.16, 51.26, 32.75, 56.17], 'EPSG:4326', 'EPSG:3857'), { duration: 800, padding: [40, 40, 40, 40] }); }
                            } else { view.fit(ol.proj.transformExtent([23.16, 51.26, 32.75, 56.17], 'EPSG:4326', 'EPSG:3857'), { duration: 800, padding: [40, 40, 40, 40] }); }
                        } else { view.fit(ol.proj.transformExtent([23.16, 51.26, 32.75, 56.17], 'EPSG:4326', 'EPSG:3857'), { duration: 800, padding: [40, 40, 40, 40] }); }
                    if (typeof window.clearSelection === 'function') window.clearSelection();
                } else if (bDef.type === 'coords') {
                    const panel = document.getElementById('coords-panel');
                    if (panel) { panel.style.display = panel.style.display === 'none' ? '' : 'none'; }
                } else if (bDef.type === 'help') {
                    if (window.GeoServiceHelp) window.GeoServiceHelp.open(btn);
                } else if (bDef.type === 'measure') {
                    // Закрыть slide-panel если открыта
                    if (currentPanel) {
                        slidePanel.classList.remove('open');
                        currentPanel = null;
                        window._currentPanel = null;
                        iconBar.querySelectorAll('.mib-btn').forEach(b => b.classList.remove('active-panel'));
                        if (typeof window._panelCleanup === 'function') { try { window._panelCleanup(); } catch(e) {} window._panelCleanup = null; }
                        setTimeout(() => { if (!currentPanel) slidePanel.innerHTML = ''; }, 260);
                    }
                    buildMeasurePopover(btn);
                } else {
                    openSlidePanel(bDef.type, btn);
                }
            });
            iconBar.appendChild(btn);
        });

        // ── Конвертер СК: скрываем кнопку, если модуль отключён администратором ──────────
        window._applyCrsFeature = function(enabled, isAdmin) {
            const b = iconBar.querySelector('.mib-btn[data-tool="crs"]');
            if (!b) return;
            b.classList.toggle('mib-feature-off', !enabled && !isAdmin);
            b.classList.toggle('mib-feature-admin-off', !enabled && !!isAdmin);
            const tip = b.querySelector('.mib-tip');
            if (tip) tip.textContent = (!enabled && isAdmin) ? 'Конвертер СК (выключен для пользователей)' : 'Конвертер СК';
            if (!enabled && !isAdmin && currentPanel === 'crs') closeSlidePanel();
        };
        (function _initCrsFeature() {
            if (!document.getElementById('mib-feature-css')) {
                const st = document.createElement('style'); st.id = 'mib-feature-css';
                st.textContent = '.mib-btn.mib-feature-off{display:none!important}' +
                    '.mib-btn.mib-feature-admin-off{opacity:.55;position:relative}' +
                    '.mib-btn.mib-feature-admin-off::after{content:"";position:absolute;right:6px;top:6px;width:8px;height:8px;border-radius:50%;background:#e53935;box-shadow:0 0 0 2px rgba(0,0,0,.25)}';
                document.head.appendChild(st);
            }
            fetch('/api/crs/status', { credentials: 'same-origin', cache: 'no-store' })
                .then(r => r.ok ? r.json() : null)
                .then(st => { if (st) window._applyCrsFeature(!!st.enabled, !!st.is_admin); })
                .catch(() => {});
        })();

        // ── Восстановление открытой панели после перезагрузки страницы ──────────────────
        // Задержка нужна чтобы все слои успели загрузиться перед открытием DZZ-панели
        setTimeout(function _restorePanel() {
            try {
                const savedPanel = localStorage.getItem('ui_open_panel');
                if (!savedPanel) return;
                const btn = iconBar.querySelector(`.mib-btn[data-tool="${savedPanel}"]`);
                if (btn) {
                    openSlidePanel(savedPanel, btn);
                }
            } catch(_) {}
        }, 400);

        // ── Отдельная кнопка "Полный экран" — под иконбаром, стиль как у правой панели ──
        (function _buildFullscreenBtn() {
            // Не дублировать при повторном вызове buildUI
            if (document.getElementById('map-fullscreen-btn')) return;

            const fsBtn = document.createElement('button');
            fsBtn.id = 'map-fullscreen-btn';
            fsBtn.title = 'Полный экран';
            fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i><span class="mib-tip">Полный экран</span>';

            // Логика переключения полного экрана с обновлением иконки
            function _move(id) {
                const el = document.getElementById(id);
                if (el && el.parentElement !== document.body) {
                    el._fsParent = el.parentElement;
                    el._fsSibling = el.nextSibling;
                    document.body.appendChild(el);
                }
            }
            function _restore(id) {
                const el = document.getElementById(id);
                if (el && el._fsParent) {
                    el._fsParent.insertBefore(el, el._fsSibling || null);
                    el._fsParent = null; el._fsSibling = null;
                }
            }

            function _enterFS() {
                document.body.classList.add('fullscreen-mode');
                fsBtn.querySelector('i').className = 'fa-solid fa-compress';
                fsBtn.title = 'Выйти из полного экрана';
                // Физически переносим все контролы в body — единственный надёжный способ
                _move('map-icon-bar');
                _move('map-slide-panel');
                _move('map-nav-group');
                _move('custom-scale-bar');
                setTimeout(() => {
                    window._updateScaleBarOffset && window._updateScaleBarOffset();
                    try { map.updateSize(); } catch(e) {}
                }, 50);
            }
            function _exitFS() {
                document.body.classList.remove('fullscreen-mode');
                fsBtn.querySelector('i').className = 'fa-solid fa-expand';
                fsBtn.title = 'Полный экран';
                // Возвращаем всё на место
                _restore('map-icon-bar');
                _restore('map-slide-panel');
                _restore('map-nav-group');
                _restore('custom-scale-bar');
                setTimeout(() => {
                    window._updateScaleBarOffset && window._updateScaleBarOffset();
                    try { map.updateSize(); } catch(e) {}
                }, 150);
            }
            function _toggleFS() {
                if (!document.fullscreenElement) {
                    // Fullscreen на documentElement — тогда body полностью видим
                    document.documentElement.requestFullscreen?.()
                        .then(_enterFS).catch(() => { _enterFS(); });
                } else {
                    document.exitFullscreen?.().then(_exitFS).catch(_exitFS);
                }
            }

            fsBtn.addEventListener('click', _toggleFS);

            // Синхронизация при нативном выходе (Esc)
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement) { _exitFS(); }
                else { _enterFS(); }
            });

            // Добавляем кнопку прямо в body, поверх всего
            document.body.appendChild(fsBtn);

            // Применяем сохранённую настройку видимости
            if (localStorage.getItem('ui_fullscreen_btn') === 'false') {
                fsBtn.style.display = 'none';
            }
        })();

        // ── Кнопка "Моё местоположение" — рядом с кнопкой полного экрана ──
        (function _buildGeolocationBtn() {
            // Не дублировать при повторном вызове buildUI
            if (document.getElementById('map-geoloc-btn')) return;

            const glBtn = document.createElement('button');
            glBtn.id = 'map-geoloc-btn';
            glBtn.title = 'Моё местоположение';
            glBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i><span class="mib-tip">Моё местоположение</span>';

            let watchId = null;
            let bestAccuracy = null;

            // Слой для маркера позиции и круга точности (OL-геометрия — корректно масштабируется при зуме)
            const geolocSource = new ol.source.Vector();
            const geolocLayer = new ol.layer.Vector({
                source: geolocSource,
                zIndex: 500,
                style: function(feature) {
                    if (feature.get('type') === 'accuracy') {
                        return new ol.style.Style({
                            fill: new ol.style.Fill({ color: 'rgba(66,133,244,0.15)' }),
                            stroke: new ol.style.Stroke({ color: 'rgba(66,133,244,0.55)', width: 1.5 })
                        });
                    }
                    return new ol.style.Style({
                        image: new ol.style.Circle({
                            radius: 8,
                            fill: new ol.style.Fill({ color: '#4285f4' }),
                            stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 })
                        })
                    });
                }
            });
            map.addLayer(geolocLayer);

            const accuracyFeature = new ol.Feature({ type: 'accuracy' });
            const pointFeature = new ol.Feature({ type: 'point' });

            function _updateFix(lon, lat, accuracyM) {
                const center = ol.proj.fromLonLat([lon, lat]);
                accuracyFeature.setGeometry(new ol.geom.Circle(center, Math.max(accuracyM || 0, 1)));
                pointFeature.setGeometry(new ol.geom.Point(center));
                if (!geolocSource.getFeatures().length) {
                    geolocSource.addFeatures([accuracyFeature, pointFeature]);
                }
                if (bestAccuracy === null || accuracyM < bestAccuracy) bestAccuracy = accuracyM;

                const precise = bestAccuracy != null && bestAccuracy <= 5;
                glBtn.classList.toggle('geoloc-precise', precise);

                if (window.showToast) {
                    const roundedAcc = Math.round(bestAccuracy);
                    window.showToast(
                        precise
                            ? `Местоположение определено, точность ±${roundedAcc} м`
                            : `Уточняем местоположение… текущая точность ±${roundedAcc} м`,
                        false
                    );
                }
            }

            function _firstFixZoom(lon, lat) {
                view.animate({ center: ol.proj.fromLonLat([lon, lat]), zoom: Math.max(view.getZoom() || 0, 17), duration: 700 });
            }

            function _onSuccess(pos) {
                const { longitude, latitude, accuracy } = pos.coords;
                const isFirstFix = !geolocSource.getFeatures().length;
                _updateFix(longitude, latitude, accuracy);
                if (isFirstFix) _firstFixZoom(longitude, latitude);
            }

            function _onError(err) {
                let msg = 'Не удалось определить местоположение';
                if (err.code === 1) msg = 'Доступ к геолокации запрещён. Разрешите «Местоположение» для сайта (значок замка в адресной строке)';
                else if (err.code === 2) msg = 'Местоположение недоступно (нет сигнала GPS/сети)';
                else if (err.code === 3) msg = 'Превышено время ожидания GPS-сигнала';
                if (window.showToast) window.showToast(msg, true);
                _stop();
            }

            function _start() {
                if (!navigator.geolocation) {
                    if (window.showToast) window.showToast('Геолокация не поддерживается браузером', true);
                    return;
                }
                // Браузеры дают геолокацию только в защищённом контексте (HTTPS или localhost)
                if (window.isSecureContext === false) {
                    if (window.showToast) window.showToast('Геолокация доступна только по HTTPS — откройте портал через https://', true);
                    return;
                }
                bestAccuracy = null;
                glBtn.classList.add('geoloc-active');
                glBtn.title = 'Остановить показ местоположения';
                // enableHighAccuracy включает GPS-чип устройства (не Wi-Fi/IP-геолокацию) —
                // это максимум точности, который может дать браузер; итоговые 1–5 м
                // достижимы на мобильных устройствах с открытым небом, конкретное
                // значение всегда приходит от pos.coords.accuracy и не гарантируется API.
                watchId = navigator.geolocation.watchPosition(_onSuccess, _onError, {
                    enableHighAccuracy: true,
                    maximumAge: 0,
                    timeout: 20000
                });
            }

            function _stop() {
                if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
                glBtn.classList.remove('geoloc-active', 'geoloc-precise');
                glBtn.title = 'Моё местоположение';
                geolocSource.clear();
                bestAccuracy = null;
            }

            glBtn.addEventListener('click', function() {
                if (watchId !== null) _stop(); else _start();
            });

            // Экспортируем для настроек и для _applyBtnVisibility
            window._stopGeolocationTracking = _stop;

            document.body.appendChild(glBtn);

            // Применяем сохранённую настройку видимости (тумблер "Геолокация" в Настройках)
            if (localStorage.getItem('ui_geolocation_btn') === 'false') {
                glBtn.style.display = 'none';
            }
        })();

        // Применяет видимость кнопки геолокации из настроек; останавливает трекинг при скрытии
        window._applyGeolocationBtnVisibility = function(visible) {
            const glEl = document.getElementById('map-geoloc-btn');
            if (glEl) glEl.style.display = visible ? '' : 'none';
            if (!visible && typeof window._stopGeolocationTracking === 'function') {
                window._stopGeolocationTracking();
            }
        };

        // ── Дефолтные настройки при первой загрузке (новый пользователь / новый браузер) ──
        (function _applyDefaultSettings() {
            // Флаг версии дефолтов — при смене значений поменяйте строку 'ui_defaults_v2'
            if (localStorage.getItem('ui_defaults_v2')) return;
            // [v17] Иконки 40px (диапазон 32–64px)
            if (!localStorage.getItem('ui_icon_size'))  localStorage.setItem('ui_icon_size',  '40');
            // Оранжевый цвет (#ff6b35 / #2e1a0a) по умолчанию
            if (!localStorage.getItem('ui_icon_color')) localStorage.setItem('ui_icon_color', '#ff6b35');
            if (!localStorage.getItem('ui_icon_bg'))    localStorage.setItem('ui_icon_bg',    '#2e1a0a');
            // Линейка видима
            if (!localStorage.getItem('ui_scale_bar'))  localStorage.setItem('ui_scale_bar',  'true');
            // Кнопка полноэкранного режима видима
            if (!localStorage.getItem('ui_fullscreen_btn')) localStorage.setItem('ui_fullscreen_btn', 'true');
            // Кнопка геолокации видима
            if (!localStorage.getItem('ui_geolocation_btn')) localStorage.setItem('ui_geolocation_btn', 'true');
            // Меню лесхозов открыто
            if (!localStorage.getItem('ui_sidebar'))    localStorage.setItem('ui_sidebar',    'true');
            // Все кнопки иконбара включены кроме Съёмки по годам
            ['btn_dzz','btn_basemap','btn_layers','btn_measure','btn_print',
             'btn_hotspots','btn_crs','btn_settings','btn_help'].forEach(function(k) {
                if (localStorage.getItem(k) === null) localStorage.setItem(k, 'true');
            });
            // Съёмка по годам — отключена по умолчанию для всех
            if (localStorage.getItem('btn_timeline') === null) localStorage.setItem('btn_timeline', 'false');
            // Устанавливаем канонический порядок иконок только если ещё не задан пользователем
            if (!localStorage.getItem('ui_icon_order')) {
                localStorage.setItem('ui_icon_order', JSON.stringify([
                    'btn_dzz','btn_basemap','btn_layers','btn_measure',
                    'btn_print','btn_hotspots','btn_timeline','btn_settings','btn_help'
                ]));
            }
            // Помечаем что дефолты применены
            localStorage.setItem('ui_defaults_v2', '1');
        })();

        // Сохранённые размеры иконок и цвет
        const savedIconSize = parseFloat(localStorage.getItem('ui_icon_size') || '40');
        _applyIconSize(savedIconSize);
        const savedColor = localStorage.getItem('ui_icon_color') || '#ff6b35';
        const savedBg    = localStorage.getItem('ui_icon_bg')    || '#2e1a0a';
        _applyIconColor(savedColor, savedBg);
    }

    // ── Popover измерений ────────────────────────────────────────────────
    function buildMeasurePopover(measureBtn) {
        // ── Перенаправляем на полноценную боковую панель ──────────────────
        buildMeasurementSidePanel(measureBtn);
    }

    // ==========================================
    // ПОЛНОЦЕННАЯ ПАНЕЛЬ ИЗМЕРЕНИЙ — перенос из leaflet_var.js (OL-адаптация)
    // ==========================================
    function buildMeasurementSidePanel(anchorBtn) {
        // Inject CSS once
        if (!document.getElementById('msr-side-css')) {
            const st = document.createElement('style');
            st.id = 'msr-side-css';
            st.textContent = `
                #msr-side-panel {
                    position: absolute; right: 76px; width: max-content; max-width: 370px;
                    background: #fff; border-radius: 14px; border: 1px solid #e0e8e0;
                    box-shadow: -3px 6px 24px rgba(0,0,0,0.13), 0 2px 6px rgba(0,0,0,0.07);
                    display: flex; flex-direction: column; z-index: 2400; pointer-events: auto;
                    transform: translateX(16px); opacity: 0;
                    transition: transform 0.22s cubic-bezier(0.4,0,0.2,1), opacity 0.18s;
                    overflow: hidden; min-width: 0;
                }
                #msr-side-panel.msr-side-open { transform: translateX(0); opacity: 1; }
                #msr-side-header {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 10px 13px 9px;
                    background: linear-gradient(135deg, #f0faf0 0%, #e8f5e9 100%);
                    border-bottom: 1.5px solid #c8e6c9; flex-shrink: 0; gap: 10px;
                }
                #msr-side-title {
                    font-size: 11px; font-weight: 800; color: #1b5e20; letter-spacing: 0.6px;
                    text-transform: uppercase; display: flex; align-items: center; gap: 7px;
                    font-family: 'Lato', sans-serif; white-space: nowrap;
                }
                #msr-side-title i { color: #2e7d32; font-size: 13px; }
                #msr-side-close {
                    background: none; border: none; color: #aaa; cursor: pointer; font-size: 14px;
                    padding: 3px 5px; border-radius: 6px; display: flex; align-items: center;
                    transition: all 0.15s; flex-shrink: 0;
                }
                #msr-side-close:hover { background: #ffebee; color: #e53935; }
                #msr-side-modes {
                    display: flex; align-items: center; gap: 5px; padding: 10px 11px 9px;
                    border-bottom: 1px solid #f0f4f0; flex-wrap: nowrap; white-space: nowrap; background: #fff;
                }
                .msrs-btn {
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    gap: 4px; padding: 7px 11px 6px; background: #f7faf7; border: 1.5px solid #ddeadd;
                    border-radius: 9px; color: #5a7a5a; cursor: pointer; transition: all 0.14s;
                    font-size: 9px; font-weight: 700; font-family: 'Lato', sans-serif;
                    white-space: nowrap; line-height: 1.2; flex-shrink: 0; user-select: none;
                }
                .msrs-btn i { font-size: 14px; color: #7aa07a; transition: color 0.14s; }
                .msrs-btn:hover { background: #e8f5e9; border-color: #66bb6a; color: #2e7d32; box-shadow: 0 2px 8px rgba(46,125,50,0.12); }
                .msrs-btn:hover i { color: #2e7d32; }
                .msrs-btn.active { background: #2e7d32; border-color: #2e7d32; color: #fff; box-shadow: 0 2px 10px rgba(46,125,50,0.3); }
                .msrs-btn.active i { color: #fff; }
                .msrs-btn.edit-btn { border-color: #c5cae9; color: #5c6bc0; background: #f3f4fc; }
                .msrs-btn.edit-btn i { color: #7986cb; }
                .msrs-btn.edit-btn:hover { border-color: #7986cb; background: #e8eaf6; color: #3949ab; }
                .msrs-btn.edit-btn.active { background: #5c6bc0; border-color: #5c6bc0; color: #fff; }
                .msrs-btn.edit-btn.active i { color: #fff; }
                .msrs-sep { width: 1px; height: 30px; background: #e0eae0; flex-shrink: 0; margin: 0 2px; }
                #msr-side-hint {
                    display: flex; align-items: center; gap: 7px; padding: 6px 12px 7px;
                    background: #fffde7; border-bottom: 1px solid #fff176;
                    font-size: 9px; color: #7a6a20; font-family: 'Lato', sans-serif; line-height: 1.4;
                }
                #msr-side-hint i { color: #f9a825; font-size: 11px; flex-shrink: 0; }
                #msr-side-opts {
                    display: flex; align-items: center; gap: 9px; padding: 8px 11px;
                    border-bottom: 1px solid #f0f4f0; background: #fafcfa; flex-wrap: nowrap;
                }
                .msrs-unit-grp { display: flex; border: 1.5px solid #c8e0c8; border-radius: 7px; overflow: hidden; flex-shrink: 0; }
                .msrs-u-btn { background: #f7faf7; border: none; color: #5a7a5a; padding: 4px 10px; cursor: pointer; font-size: 10px; font-weight: 700; font-family: 'Lato', sans-serif; transition: all 0.13s; }
                .msrs-u-btn:hover { background: #e8f5e9; color: #2e7d32; }
                .msrs-u-btn.active { background: #2e7d32; color: #fff; }
                .msrs-clr-wrap { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
                .msrs-clr-lbl { font-size: 10px; color: #7a9a7a; font-weight: 600; font-family: 'Lato', sans-serif; }
                .msrs-clr-swatch { width: 22px; height: 22px; border-radius: 6px; overflow: hidden; border: 1.5px solid #c8e0c8; cursor: pointer; position: relative; }
                .msrs-clr-swatch input[type=color] { position: absolute; inset: 0; width: 130%; height: 130%; top: -15%; left: -15%; border: none; padding: 0; margin: 0; cursor: pointer; opacity: 0; }
                #msr-side-coords { display: flex; align-items: center; gap: 5px; padding: 8px 11px 10px; background: #fafcfa; flex-wrap: nowrap; }
                #msrs-coords-pick { background: #2e7d32; border: none; color: #fff; border-radius: 7px; cursor: pointer; padding: 6px 9px; font-weight: 800; font-size: 12px; flex-shrink: 0; transition: all 0.15s; display: flex; align-items: center; }
                #msrs-coords-pick:hover { background: #1b5e20; }
                #msrs-coords-pick.picking { background: #e53935; }
                .msrs-coord-inp { flex: 1; background: #fff; border: 1.5px solid #d0e8d0; color: #1a2e1a; padding: 6px 8px; border-radius: 7px; font-size: 10px; outline: none; font-family: monospace; min-width: 0; transition: border 0.15s; }
                .msrs-coord-inp:focus { border-color: #2e7d32; }
                .msrs-coord-inp::placeholder { color: #b0c8b0; font-size: 9px; }
                #msrs-coords-go { background: #2e7d32; border: none; color: #fff; border-radius: 7px; cursor: pointer; padding: 6px 10px; font-size: 12px; font-weight: 800; flex-shrink: 0; transition: all 0.15s; display: flex; align-items: center; }
                #msrs-coords-go:hover { background: #1b5e20; }
                @keyframes msr-pulse{0%{box-shadow:0 0 0 0 rgba(46,125,50,0.6)}60%{box-shadow:0 0 0 8px rgba(46,125,50,0)}100%{box-shadow:0 0 0 0 rgba(46,125,50,0)}}
                .mib-btn.msr-on{background:var(--icon-bg-active,#152918)!important;border:2px solid #82e938!important;animation:msr-pulse 1.4s ease-out infinite!important;}
                .mib-btn.msr-on i{color:#82e938!important;}
                #measure-erase-box { position:absolute; border:2px dashed #e53935; background:rgba(229,57,53,.06); pointer-events:none; z-index:9999; }
            `;
            document.head.appendChild(st);
        }

        // Удаляем старую панель если есть
        const existing = document.getElementById('msr-side-panel');
        if (existing) {
            existing._disposeMeasurementLayout && existing._disposeMeasurementLayout();
            existing.classList.remove('msr-side-open');
            setTimeout(() => { if (existing.parentNode) existing.remove(); }, 240);
            anchorBtn.classList.remove('active-panel');
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'msr-side-panel';
        const symbol = (name) => {
            const paths = {
                ruler:'<path d="m3 17 14-14 4 4L7 21Z"/><path d="m12 8 3 3M8 12l3 3M16 4l3 3"/>',
                distance:'<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
                area:'<path d="m4 6 14-2 3 13-14 4Z"/><path d="M4 3v6M1 6h6M18 1v6M15 4h6"/>',
                compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5Z"/>',
                edit:'<path d="M4 7v13h13M14 4l6 6M9 15l-1 4 4-1 9-9-3-3Z"/>',
                target:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
                arrow:'<path d="M4 12h16M14 6l6 6-6 6"/>',
                close:'<path d="m6 6 12 12M18 6 6 18"/>'
            };
            return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
        };
        panel.setAttribute('role','region');
        panel.setAttribute('aria-labelledby','msr-side-title');
        panel.innerHTML = `
            <div id="msr-side-header">
                ${symbol('ruler')}
                <div id="msr-side-title">Измерения и координаты</div>
                <button type="button" id="msr-side-close" title="Закрыть" aria-label="Закрыть измерения">${symbol('close')}</button>
            </div>
            <div class="msrs-body">
                <div id="msr-side-modes" role="group" aria-label="Режим измерения">
                    <button type="button" class="msrs-btn" id="msrs-dist">${symbol('distance')}<span>Расстояние</span></button>
                    <button type="button" class="msrs-btn" id="msrs-area">${symbol('area')}<span>Площадь</span></button>
                    <button type="button" class="msrs-btn" id="msrs-dir">${symbol('compass')}<span>Азимут</span></button>
                    <button type="button" class="msrs-btn edit-btn" id="msrs-edit">${symbol('edit')}<span>Вершины</span></button>
                </div>
                <details id="msr-side-hint">
                    <summary>Как пользоваться измерениями</summary>
                    <ul>
                        <li><strong>Двойной щелчок</strong> — завершить построение.</li>
                        <li><strong>Правая кнопка мыши + протяжка</strong> — удалить замеры в выбранной области.</li>
                        <li><strong>Delete</strong> — удалить все измерения.</li>
                        <li><strong>Ctrl + Z / Y</strong> — отменить / повторить.</li>
                    </ul>
                </details>
                <div id="msr-side-opts">
                    <div class="msrs-unit-grp" role="group" aria-label="Единицы расстояния">
                        <button type="button" class="msrs-u-btn active" id="msrs-um" title="Метры">м</button>
                        <button type="button" class="msrs-u-btn" id="msrs-ukm" title="Километры">км</button>
                    </div>
                    <label class="msrs-clr-wrap" for="msrs-line-col">
                        <span class="msrs-clr-lbl">Линия</span>
                        <span class="msrs-clr-swatch" id="msrs-line-sw"><input type="color" id="msrs-line-col" aria-label="Цвет линии"></span>
                    </label>
                    <label class="msrs-clr-wrap" for="msrs-mark-col">
                        <span class="msrs-clr-lbl">Вершины</span>
                        <span class="msrs-clr-swatch" id="msrs-mark-sw"><input type="color" id="msrs-mark-col" aria-label="Цвет вершин"></span>
                    </label>
                </div>
                <div id="msr-side-coords">
                    <div class="msrs-coords-heading">Переход по координатам <span>WGS-84 · градусы</span></div>
                    <label class="msrs-coord-field" for="msrs-lat"><span>Широта</span><input class="msrs-coord-inp" id="msrs-lat" placeholder="53.9042" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
                    <label class="msrs-coord-field" for="msrs-lng"><span>Долгота</span><input class="msrs-coord-inp" id="msrs-lng" placeholder="27.5610" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
                    <button type="button" id="msrs-coords-pick" title="Указать точку на карте" aria-pressed="false">${symbol('target')}<span>С карты</span></button>
                    <button type="button" id="msrs-coords-go" title="Перейти по координатам">${symbol('arrow')}<span>Перейти</span></button>
                </div>
            </div>
        `;

        const mapEl = document.getElementById('map');
        (mapEl || document.body).appendChild(panel);
        // Keep the larger panel inside both the map and the visible viewport,
        // including fullscreen, window resizing and the mobile software keyboard.
        function fitMeasurementPanel() {
            if (!panel.isConnected) return;
            const vv=window.visualViewport;
            const bounds=mapEl ? mapEl.getBoundingClientRect() : {left:0,top:0,right:innerWidth,bottom:innerHeight};
            const left=Math.max(bounds.left,vv ? vv.offsetLeft : 0)+12;
            const top=Math.max(bounds.top,vv ? vv.offsetTop : 0)+12;
            const bottom=Math.min(bounds.bottom,vv ? vv.offsetTop+vv.height : innerHeight)-12;
            let right=Math.min(bounds.right,vv ? vv.offsetLeft+vv.width : innerWidth)-12;
            const anchor=anchorBtn.getBoundingClientRect();
            const beside=innerWidth>700 && anchor.left-left>=340 && !document.body.classList.contains('fullscreen-mode');
            if(beside) right=Math.min(right,anchor.left-16);
            panel.style.width=Math.max(0,Math.min(340,right-left))+'px'; // [v17] компактнее: 340 вместо 440 px
            panel.style.maxHeight=Math.max(0,bottom-top)+'px';
            panel.style.left=(right-panel.getBoundingClientRect().width)+'px';
            panel.style.top=(beside ? Math.max(top,Math.min(anchor.top,bottom-panel.getBoundingClientRect().height)) : top)+'px';
        }
        let layoutFrame;
        const scheduleLayout=()=>{cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(fitMeasurementPanel);};
        const resizeObserver=typeof ResizeObserver==='function' ? new ResizeObserver(scheduleLayout) : null;
        if(resizeObserver) {resizeObserver.observe(panel); if(mapEl) resizeObserver.observe(mapEl); resizeObserver.observe(anchorBtn);}
        window.addEventListener('resize',scheduleLayout);
        if(window.visualViewport) {window.visualViewport.addEventListener('resize',scheduleLayout);window.visualViewport.addEventListener('scroll',scheduleLayout);}
        panel._disposeMeasurementLayout=()=>{
            cancelAnimationFrame(layoutFrame);resizeObserver && resizeObserver.disconnect();
            window.removeEventListener('resize',scheduleLayout);
            if(window.visualViewport) {window.visualViewport.removeEventListener('resize',scheduleLayout);window.visualViewport.removeEventListener('scroll',scheduleLayout);}
        };
        fitMeasurementPanel();

        // Блокируем передачу событий карте
        ['wheel','mousedown','dblclick','mousemove','touchstart','click','contextmenu'].forEach(evt => {
            panel.addEventListener(evt, e => e.stopPropagation(), evt === 'wheel' || evt === 'touchstart' ? { passive: false } : false);
        });

        requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('msr-side-open')));

        anchorBtn.classList.add('active-panel', 'msr-on');

        const T       = window.MeasureTool;
        const btnDist = document.getElementById('msrs-dist');
        const btnArea = document.getElementById('msrs-area');
        const btnDir  = document.getElementById('msrs-dir');
        const btnEdit = document.getElementById('msrs-edit');
        const btnUM   = document.getElementById('msrs-um');
        const btnUKM  = document.getElementById('msrs-ukm');
        const lineSw  = document.getElementById('msrs-line-sw');
        const markSw  = document.getElementById('msrs-mark-sw');
        const lineCol = document.getElementById('msrs-line-col');
        const markCol = document.getElementById('msrs-mark-col');
        const latInp  = document.getElementById('msrs-lat');
        const lngInp  = document.getElementById('msrs-lng');
        const pickBtn = document.getElementById('msrs-coords-pick');
        const goBtn   = document.getElementById('msrs-coords-go');

        function syncMeasurementControls() {
            [btnDist,btnArea,btnDir,btnEdit,btnUM,btnUKM].forEach(button=>button.setAttribute('aria-pressed',String(button.classList.contains('active'))));
            pickBtn.setAttribute('aria-pressed',String(pickBtn.classList.contains('picking')));
        }
        const stateObserver=new MutationObserver(syncMeasurementControls);
        [btnDist,btnArea,btnDir,btnEdit,btnUM,btnUKM,pickBtn].forEach(button=>stateObserver.observe(button,{attributes:true,attributeFilter:['class']}));
        const disposeLayout=panel._disposeMeasurementLayout;
        panel._disposeMeasurementLayout=()=>{stateObserver.disconnect();disposeLayout();};
        syncMeasurementControls();

        // ── Цвета ────────────────────────────────────────────────────────────
        if (T) {
            lineCol.value = T.lineColor || '#ff8c00';
            lineSw.style.background = T.lineColor || '#ff8c00';
            markCol.value = T.markerColor || '#82e938';
            markSw.style.background = T.markerColor || '#82e938';
            if (T.unit === 'km') { btnUKM.classList.add('active'); btnUM.classList.remove('active'); }
        }

        // ── Закрытие без остановки ────────────────────────────────────────
        function closePanelOnly() {
            panel._disposeMeasurementLayout();
            panel.classList.remove('msr-side-open');
            setTimeout(() => { if (panel.parentNode) panel.remove(); }, 240);
        }
        // ── Крестик: полная деактивация ──────────────────────────────────
        function closeAndDeactivate() {
            panel._disposeMeasurementLayout();
            panel.classList.remove('msr-side-open');
            anchorBtn.classList.remove('active-panel', 'msr-on');
            window._msrHasEverMeasured = false;
            if (T) {
                try {
                    if (T.editMode) T.stopEdit();
                    T._continuous = false;
                    T._clearTemp && T._clearTemp();
                    T._detachHandlers && T._detachHandlers();
                    T.mode = null;
                } catch(e) {}
            }
            map.getTargetElement().style.cursor = 'default';
            setTimeout(() => { if (panel.parentNode) panel.remove(); }, 240);
        }

        document.getElementById('msr-side-close').onclick = closeAndDeactivate;

        // ── Синхронизация подсветки кнопок ───────────────────────────────
        function updateUI(mode) {
            [btnDist, btnArea, btnDir].forEach(b => b.classList.remove('active'));
            if (mode === 'distance') btnDist.classList.add('active');
            if (mode === 'area')     btnArea.classList.add('active');
            if (mode === 'direction') btnDir.classList.add('active');
            if (mode && T) { try { if (T.editMode) { T.stopEdit(); btnEdit.classList.remove('active'); } } catch(e){} }
        }

        // ── Режимы ───────────────────────────────────────────────────────
        function activateMode(mode) {
            if (!T) return;
            if (T.mode === mode) {
                T._continuous = false; T.stop(); updateUI(null);
            } else {
                T._continuous = false; T.start(mode); updateUI(mode);
                window._msrHasEverMeasured = true;
                if (typeof window._syncMeasureBtn === 'function') window._syncMeasureBtn();
            }
            closePanelOnly();
        }

        btnDist.onclick = () => activateMode('distance');
        btnArea.onclick = () => activateMode('area');
        btnDir.onclick  = () => activateMode('direction');

        btnEdit.onclick = () => {
            if (!T) return;
            if (T.editMode) { T.stopEdit(); btnEdit.classList.remove('active'); }
            else { T._continuous = false; T.stop(); updateUI(null); T.startEdit(); btnEdit.classList.add('active'); }
            closePanelOnly();
        };

        // ── Единицы ──────────────────────────────────────────────────────
        if (T) {
            btnUM.onclick  = () => { T.unit = 'm';  localStorage.setItem('msr_unit','m');
                btnUM.classList.add('active'); btnUKM.classList.remove('active'); };
            btnUKM.onclick = () => { T.unit = 'km'; localStorage.setItem('msr_unit','km');
                btnUKM.classList.add('active'); btnUM.classList.remove('active'); };
        }

        // ── Цвета линии и вершин ──────────────────────────────────────────
        lineCol.oninput = (e) => {
            if (T) T.lineColor = e.target.value;
            lineSw.style.background = e.target.value;
            localStorage.setItem('msr_line_color', e.target.value);
        };
        markCol.oninput = (e) => {
            if (T) T.markerColor = e.target.value;
            markSw.style.background = e.target.value;
            localStorage.setItem('msr_marker_color', e.target.value);
        };

        if (T && T.editMode) btnEdit.classList.add('active');
        updateUI(T ? (T.mode || null) : null);

        // ── ПКМ-выделение для удаления замеров (rubber-band eraser) ──────
        _msrInitEraser(panel);

        // ── Поиск по координатам ─────────────────────────────────────────
        let isPicking = false;
        pickBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isPicking = !isPicking;
            pickBtn.classList.toggle('picking', isPicking);
            if (isPicking) {
                map.getTargetElement().style.cursor = 'crosshair';
                window.showToast && window.showToast('Кликните точку на карте', false);
            } else {
                map.getTargetElement().style.cursor = T && T.mode ? 'crosshair' : '';
            }
        });
        map.once('singleclick', function _coordPick(e) {
            if (!isPicking) return;
            const c = ol.proj.toLonLat(e.coordinate);
            latInp.value = c[1].toFixed(6);
            lngInp.value = c[0].toFixed(6);
            isPicking = false;
            pickBtn.classList.remove('picking');
            map.getTargetElement().style.cursor = T && T.mode ? 'crosshair' : '';
            _performCoordSearch(false);
        });

        function _performCoordSearch(fly) {
            const lat = parseFloat(latInp.value.replace(/,/g, '.'));
            const lng = parseFloat(lngInp.value.replace(/,/g, '.'));
            if (isNaN(lat)||isNaN(lng)||lat<-90||lat>90||lng<-180||lng>180) {
                window.showToast && window.showToast('Неверные координаты', true); return;
            }
            const coord3857 = ol.proj.fromLonLat([lng, lat]);
            if (fly) view.animate({ center: coord3857, zoom: 16, duration: 1200 });

            // Маркер — transform не задаём вручную, OpenLayers позиционирует через positioning:'bottom-center'
            if (window._coordsSearchOverlay) { map.removeOverlay(window._coordsSearchOverlay); window._coordsSearchOverlay = null; }
            const markerEl = document.createElement('div');
            markerEl.style.display = 'flex';
            markerEl.style.flexDirection = 'column';
            markerEl.style.alignItems = 'center';
            markerEl.innerHTML = '<i class="fa-solid fa-location-dot" style="color:#ff5722;font-size:34px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.5));"></i>';
            window._coordsSearchOverlay = new ol.Overlay({ element: markerEl, position: coord3857, positioning: 'bottom-center', offset: [0, 0], stopEvent: false });
            map.addOverlay(window._coordsSearchOverlay);

            let tip = `WGS-84: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            if (typeof proj4 !== 'undefined') {
                try { const u = proj4('EPSG:4326','UTM_35N',[lng,lat]); tip += `\nUTM 35N: X:${u[1].toFixed(0)} Y:${u[0].toFixed(0)}`; } catch(_){}
                try { const s = proj4('EPSG:4326','SK42_Z5',[lng,lat]); tip += `\nСК-42 З5: X:${s[1].toFixed(0)} Y:${s[0].toFixed(0)}`; } catch(_){}
            }
            window.showToast && window.showToast(tip.split('\n')[0], false);

            if (window._coordsMarkerTimer) clearTimeout(window._coordsMarkerTimer);
            window._coordsMarkerTimer = setTimeout(() => {
                if (window._coordsSearchOverlay) { map.removeOverlay(window._coordsSearchOverlay); window._coordsSearchOverlay = null; }
            }, 15000);
        }

        goBtn.onclick = () => _performCoordSearch(true);
        [latInp, lngInp].forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') _performCoordSearch(true); }));
    }

    // ── ПКМ rubber-band eraser — удаление замеров в прямоугольнике ──────────
    function _msrInitEraser(panel) {
        if (window._msrEraserInited) return;
        window._msrEraserInited = true;

        let _eStartCoord = null, _eBox = null, _eRect = null, _eStart = null;
        const mapEl = document.getElementById('map');

        // ── mousedown: запоминаем стартовую точку ──────────────────────────
        mapEl.addEventListener('mousedown', function(e) {
            if (e.button !== 2) return;
            // Разрешаем eraser ТОЛЬКО если есть завершённые замеры (не зависит от активного режима)
            if (_msrGroups.length === 0) return;
            if (e.target.closest('#msr-side-panel, .ol-popup-wrapper, .measure-tooltip, .msr-result-popup')) return;
            e.preventDefault();
            _eRect = mapEl.getBoundingClientRect();
            // Пиксель относительно карты для getCoordinateFromPixel
            const px = [e.clientX - _eRect.left, e.clientY - _eRect.top];
            _eStartCoord = map.getCoordinateFromPixel(px);
            // Стартовая точка в screen-координатах (clientX/Y) — для рамки с position:fixed
            _eStart = { x: e.clientX, y: e.clientY };
        }, { passive: false });

        // ── mousemove: рисуем красную рамку ───────────────────────────────
        mapEl.addEventListener('mousemove', function(e) {
            if (!_eStart) return;
            if (!_eBox) {
                _eBox = document.createElement('div');
                _eBox.id = 'measure-erase-box';
                // Добавляем на body с position:fixed — точно по курсору, без смещений от родителей
                document.body.appendChild(_eBox);
            }
            // position:fixed + clientX/Y — рамка всегда точно под курсором
            const cx = e.clientX;
            const cy = e.clientY;
            const x1 = Math.min(_eStart.x, cx);
            const y1 = Math.min(_eStart.y, cy);
            const w  = Math.abs(cx - _eStart.x);
            const h  = Math.abs(cy - _eStart.y);
            _eBox.style.cssText = `display:block;position:fixed;left:${x1}px;top:${y1}px;width:${w}px;height:${h}px;border:2px dashed #e53935;background:rgba(229,57,53,.06);pointer-events:none;z-index:99999;`;
        });

        // ── mouseup: удаляем группы в прямоугольнике ─────────────────────
        mapEl.addEventListener('mouseup', function(e) {
            if (e.button !== 2) return;
            if (!_eStart || !_eStartCoord || !_eRect) { _eStart = null; _eStartCoord = null; _eRect = null; if (_eBox) { _eBox.remove(); _eBox = null; } return; }

            // Для getCoordinateFromPixel нужны пиксели относительно карты
            const endPx = [e.clientX - _eRect.left, e.clientY - _eRect.top];
            const endCoord = map.getCoordinateFromPixel(endPx);

            // Сохраняем данные до сброса
            const startCoord = _eStartCoord;
            _eStart = null; _eStartCoord = null; _eRect = null;
            if (_eBox) { _eBox.remove(); _eBox = null; }

            if (!endCoord || !startCoord) return;

            // Прямоугольник в EPSG:3857
            const minX = Math.min(startCoord[0], endCoord[0]);
            const minY = Math.min(startCoord[1], endCoord[1]);
            const maxX = Math.max(startCoord[0], endCoord[0]);
            const maxY = Math.max(startCoord[1], endCoord[1]);

            // Минимальный размер (защита от клика)
            const mapRes = map.getView().getResolution() || 1;
            if ((maxX - minX) < mapRes * 5 && (maxY - minY) < mapRes * 5) return;

            // Удаляем ВСЕ группы, у которых любая точка или экстент пересекается с прямоугольником
            const toDelete = [..._msrGroups].filter(g =>
                g.pts.some(ll => {
                    const c = _olToCoord(ll);
                    return c[0] >= minX && c[0] <= maxX && c[1] >= minY && c[1] <= maxY;
                }) ||
                g.features.some(f => {
                    try {
                        const ext = f.getGeometry().getExtent();
                        return !(ext[2] < minX || ext[0] > maxX || ext[3] < minY || ext[1] > maxY);
                    } catch(_) { return false; }
                })
            );

            if (toDelete.length > 0) {
                _msrRemoveGroupBatch(toDelete); // одна запись в истории
                window.showToast && window.showToast('❌ Удалено: ' + toDelete.length + ' замера', false);
            }
        });

        // ── Отмена при уходе мыши за пределы карты ────────────────────────
        mapEl.addEventListener('mouseleave', function() {
            if (_eBox) { _eBox.remove(); _eBox = null; }
            _eStart = null; _eStartCoord = null; _eRect = null;
        });
    }

    // ==========================================
    // 29. ПАНЕЛЬ СЛОЁВ
    // ==========================================
    let LayerState = AppState.layerState;

// ==========================================
    // 35b. ЗАГРУЗКА ДАННЫХ И ПОИСК (перенесено из panel-hotspots.js)
    // ==========================================
    function loadData() {
        AppState.mode = window.MODE || (window.HAS_PROFILE ? 'tiles' : null);

        // Регистрируем центральный обработчик кликов ВСЕГДА
        // (даже если нет режима tiles — нужен для SHP попапов)
        if (!_imageClickListener) {
            _imageClickListener = _centralClickHandler;
            map.on('singleclick', _imageClickListener);
        }

        window.loadAllImages && window.loadAllImages();
        window.loadVectorLayers && window.loadVectorLayers();
        buildCoordsPanel();
        window._restoreLayersState && window._restoreLayersState();
        _initSidebarSearch();
    }

    // ==========================================
    // 35b. ИНИЦИАЛИЗАЦИЯ ПОИСКА В САЙДБАРЕ
    // ==========================================

    // Активные фильтры поиска: null = все, иначе Set типов
    window._searchActiveFilters = null;

    function _initSidebarSearch() {
        const input   = document.getElementById('sidebar-search-input');
        const results = document.getElementById('sidebar-search-results');
        const clearBtn = document.getElementById('sidebar-search-clear');
        if (!input || !results) return;
        if (input._searchInited) return;
        input._searchInited = true;

        // Инжектируем кнопку фильтра в search-box если её нет
        let filterBtn = document.getElementById('sidebar-search-filter-btn');
        if (!filterBtn) {
            const box = document.getElementById('sidebar-search-box');
            if (box) {
                filterBtn = document.createElement('button');
                filterBtn.id = 'sidebar-search-filter-btn';
                filterBtn.title = 'Фильтр по слоям';
                filterBtn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
                box.appendChild(filterBtn);
            }
        }

        let _searchTimer = null;

        function doSearch() {
            const q = (input.value || '').trim();
            if (clearBtn) clearBtn.style.display = q ? '' : 'none';
            if (!q) {
                results.innerHTML = '';
                results.classList.remove('has-results');
                return;
            }
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => executeAdvancedSearch(q, results), 300);
        }

        input.addEventListener('input', doSearch);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { clearTimeout(_searchTimer); const q=(input.value||'').trim(); if(q) executeAdvancedSearch(q, results); }
            if (e.key === 'Escape') {
                // Если открыт фильтр — закрыть его
                const fp = document.getElementById('search-filter-panel');
                if (fp && fp.classList.contains('open')) { fp.classList.remove('open'); return; }
                input.value=''; doSearch(); input.blur();
            }
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', () => { input.value=''; doSearch(); input.focus(); });
        }

        // ── Фильтр-панель ───────────────────────────────────────────────
        if (filterBtn) {
            filterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _toggleFilterPanel();
            });
        }

        // Скрываем результаты и панель при клике вне
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#sidebar-search-wrap') && !e.target.closest('#sidebar-search-results') && !e.target.closest('#search-filter-panel')) {
                results.classList.remove('has-results');
                const fp = document.getElementById('search-filter-panel');
                if (fp) fp.classList.remove('open');
            }
        }, true);
    }

    function _buildFilterPanel() {
        const existing = document.getElementById('search-filter-panel');
        if (existing) return existing;

        const panel = document.createElement('div');
        panel.id = 'search-filter-panel';
        panel.innerHTML = `
            <div class="sfp-header">
                <span class="sfp-title"><i class="fa-solid fa-sliders" style="margin-right:6px;color:#82e938;"></i>Фильтр поиска</span>
                <button class="sfp-reset" id="sfp-reset-btn" title="Сбросить фильтры">Сбросить</button>
            </div>
            <div class="sfp-section-label">Источники данных</div>
            <div class="sfp-items" id="sfp-items">
                <label class="sfp-item" data-type="leshoz">
                    <input type="checkbox" value="leshoz" checked>
                    <i class="fa-solid fa-tree sfp-icon" style="color:#82e938;"></i>
                    <span>Лесхозы (справ.)</span>
                </label>
                <label class="sfp-item" data-type="gs_leshoz">
                    <input type="checkbox" value="gs_leshoz" checked>
                    <i class="fa-solid fa-map sfp-icon" style="color:#1565c0;"></i>
                    <span>Лесхозы РБ</span>
                </label>
                <label class="sfp-item" data-type="lesnich">
                    <input type="checkbox" value="lesnich" checked>
                    <i class="fa-solid fa-tree sfp-icon" style="color:#4caf50;"></i>
                    <span>Лесничества РБ</span>
                </label>
                <label class="sfp-item" data-type="gs_quarter">
                    <input type="checkbox" value="gs_quarter" checked>
                    <i class="fa-solid fa-vector-square sfp-icon" style="color:#7b1fa2;"></i>
                    <span>Кварталы РБ</span>
                </label>
                <label class="sfp-item" data-type="gs_allotment">
                    <input type="checkbox" value="gs_allotment" checked>
                    <i class="fa-solid fa-draw-polygon sfp-icon" style="color:#e65100;"></i>
                    <span>Выделы РБ</span>
                </label>
                <label class="sfp-item" data-type="shp">
                    <input type="checkbox" value="shp" checked>
                    <i class="fa-solid fa-draw-polygon sfp-icon" style="color:#ff9800;"></i>
                    <span>Векторные слои</span>
                </label>
                <label class="sfp-item" data-type="gs">
                    <input type="checkbox" value="gs" checked>
                    <i class="fa-solid fa-server sfp-icon" style="color:#42a5f5;"></i>
                    <span>Слои GeoServer</span>
                </label>
                <label class="sfp-item" data-type="place">
                    <input type="checkbox" value="place" checked>
                    <i class="fa-solid fa-location-dot sfp-icon" style="color:#26a69a;"></i>
                    <span>Нас. пункты</span>
                </label>
            </div>
            <div class="sfp-section-label" id="sfp-active-layers-label" style="margin-top:6px;">Активные слои</div>
            <div class="sfp-active-layers" id="sfp-active-layers-list"></div>
        `;

        const wrap = document.getElementById('sidebar-search-wrap');
        if (wrap) wrap.appendChild(panel);
        else document.body.appendChild(panel);

        // Обновляем активные слои
        _refreshActiveLayersInPanel(panel);

        // Чекбоксы типов
        panel.querySelectorAll('#sfp-items input[type=checkbox]').forEach(cb => {
            cb.addEventListener('change', _updateSearchFilters);
        });

        // Кнопка сброса
        panel.querySelector('#sfp-reset-btn').addEventListener('click', () => {
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
            window._searchActiveFilters = null;
            _updateFilterBtnState();
        });

        return panel;
    }

    function _refreshActiveLayersInPanel(panel) {
        const container = panel.querySelector('#sfp-active-layers-list');
        if (!container) return;

        const activeLayers = (window.EXTERNAL_LAYER_DEFS || []).filter(d =>
            AppState.externalLayerState[d.key] && !d.hidden
        );

        if (!activeLayers.length) {
            container.innerHTML = '<div class="sfp-no-layers">Нет активных слоёв</div>';
            return;
        }

        container.innerHTML = '';
        activeLayers.slice(0, 6).forEach(def => {
            const el = document.createElement('div');
            el.className = 'sfp-active-layer-chip';
            el.innerHTML = `<i class="fa-solid ${def.icon || 'fa-layer-group'}" style="font-size:10px;opacity:.7;"></i> ${def.label}`;
            el.title = def.label;
            container.appendChild(el);
        });
        if (activeLayers.length > 6) {
            const more = document.createElement('div');
            more.className = 'sfp-active-layer-chip sfp-more';
            more.textContent = `+${activeLayers.length - 6}`;
            container.appendChild(more);
        }
    }

    function _toggleFilterPanel() {
        let panel = document.getElementById('search-filter-panel');
        if (!panel) panel = _buildFilterPanel();
        else _refreshActiveLayersInPanel(panel);

        panel.classList.toggle('open');
    }

    function _updateSearchFilters() {
        const panel = document.getElementById('search-filter-panel');
        if (!panel) return;
        const checked = [...panel.querySelectorAll('#sfp-items input[type=checkbox]:checked')].map(cb => cb.value);
        const all = [...panel.querySelectorAll('#sfp-items input[type=checkbox]')];
        window._searchActiveFilters = checked.length === all.length ? null : new Set(checked);
        _updateFilterBtnState();
    }

    function _updateFilterBtnState() {
        const btn = document.getElementById('sidebar-search-filter-btn');
        if (!btn) return;
        const isFiltered = window._searchActiveFilters !== null;
        btn.classList.toggle('active', isFiltered);
        btn.title = isFiltered ? 'Фильтр активен' : 'Фильтр по слоям';
    }


// ==========================================
    // 36. ИНЖЕКТОР СТИЛЕЙ (продолжение)
    // ==========================================
    function injectStyles() {
        if (document.getElementById('ol-app-styles')) return;
        const s = document.createElement('style'); s.id = 'ol-app-styles';
        s.textContent = `
            .ol-attribution { display:none !important; }
            /* ── Прямоугольник выбора участка (Shift + ЛКМ) ── */
            .ol-dragzoom {
                border: 2px dashed #82e938 !important;
                background: rgba(130,233,56,0.12) !important;
                border-radius: 2px !important;
            }
            /* Курсор-ладошка при перемещении карты */
            #map { cursor: grab; background: #ffffff; }
            /* grabbing при зажатии мыши на карте (только если grab) */
            #map[style*="cursor: grab"]:active,
            #map[style*="cursor:grab"]:active { cursor: grabbing !important; }
            /* Элементы UI поверх карты — стандартный pointer */
            #map .ol-control button,
            #map .ol-control a,
            .icon-bar button,
            .icon-bar a,
            .map-nav-btn,
            #map-nav-group button { cursor: pointer !important; }
            /* ── Единый блок навигации: +/−/Домой ── */
            #map-nav-group {
                position: absolute !important;
                top: 10px !important;
                left: 10px !important;
                display: flex !important;
                flex-direction: column !important;
                align-items: stretch !important;
                background: rgba(255,255,255,0.95) !important;
                border-radius: 10px !important;
                box-shadow: 0 2px 10px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.1) !important;
                overflow: hidden !important;
                border: 1px solid rgba(130,233,56,0.3) !important;
                z-index: 900 !important;
            }
            .map-nav-btn {
                width: 34px !important;
                height: 34px !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                font-size: 14px !important;
                background: transparent !important;
                border: none !important;
                cursor: pointer !important;
                color: #333 !important;
                transition: background 0.15s, color 0.15s !important;
                padding: 0 !important;
                outline: none !important;
                flex-shrink: 0 !important;
            }
            .map-nav-btn:hover {
                background: rgba(130,233,56,0.15) !important;
                color: #2e7d32 !important;
            }
            .map-nav-btn:active {
                background: rgba(130,233,56,0.3) !important;
            }
            /* Разделители между кнопками */
            .map-nav-btn + .map-nav-btn {
                border-top: 1px solid rgba(0,0,0,0.08) !important;
            }
            /* Иконка домой чуть крупнее */
            .map-nav-home i { font-size: 12px !important; }
            /* Скрываем стандартный OL zoom — он не используется */
            .ol-zoom { display: none !important; }
            .ol-home-ctrl { display: none !important; }
            .ol-popup-wrapper { position:relative; background:#fff; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,.18); min-width:240px; font-family:Lato,sans-serif; pointer-events:auto; }
            .ol-popup-wrapper:after { content:''; position:absolute; bottom:-10px; left:50%; transform:translateX(-50%); border:5px solid transparent; border-top-color:#fff; }
            .msr-result-popup { pointer-events:none; }
            .measure-seg-popup { pointer-events:none; }
 
            /* ── Правая панель — контейнер; сам по себе не занимает визуального места ── */
            #map-right-panel {
                position: fixed;
                top: 0; right: 0; bottom: 0;
                display: flex; align-items: center;
                z-index: 1000; pointer-events: none;
                width: calc(var(--mib-btn-size,40px) + 16px);
            }

            /* ── Иконбар: закруглённая таблетка — отступ от правого края ── */
            #map-icon-bar {
                position: fixed;
                right: 10px;
                top: 10px;
                transform: none;
                width: calc(var(--mib-btn-size,40px) + 16px);
                height: auto;
                background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(240,252,240,0.97) 100%);
                border: 1.5px solid rgba(130,233,56,0.30);
                border-radius: 18px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 10px 0 14px 0;
                gap: 4px;
                box-shadow: 0 4px 24px rgba(0,0,0,0.13), inset 0 -6px 16px rgba(130,233,56,0.07);
                pointer-events: auto;
                overflow: visible;
                z-index: 1000;
            }
            /* Подсветка дна */
            #map-icon-bar::after {
                content: '';
                position: absolute;
                bottom: 6px; left: 50%;
                transform: translateX(-50%);
                width: 28px; height: 4px;
                background: rgba(130,233,56,0.30);
                border-radius: 10px;
                filter: blur(3px);
            }
            /* Полоска сверху */
            #map-icon-bar::before {
                content: '';
                position: absolute;
                top: 6px; left: 50%;
                transform: translateX(-50%);
                width: 22px; height: 2px;
                background: rgba(130,233,56,0.40);
                border-radius: 4px;
            }

            /* ── Кнопки иконбара ── */
            .mib-btn {
                width: var(--mib-btn-size,40px);
                height: var(--mib-btn-size,40px);
                min-width: var(--mib-btn-size,40px);
                min-height: var(--mib-btn-size,40px);
                border-radius: 10px;
                border: none !important;
                outline: none !important;
                box-shadow: none !important;
                -webkit-tap-highlight-color: transparent !important;
                appearance: none !important;
                background: transparent;
                color: var(--icon-accent,#82e938);
                cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: width .15s, height .15s, background .18s, color .18s;
                position: relative;
                flex-shrink: 0;
                overflow: visible !important;
                user-select: none;
            }
            .mib-btn:focus, .mib-btn:focus-visible, .mib-btn:active { outline:none!important; box-shadow:none!important; border:none!important; }
            .mib-btn::-moz-focus-inner { border:0!important; padding:0!important; }
            .mib-btn > i { pointer-events:none!important; outline:none!important; font-size:var(--mib-icon-size,17px)!important; transition:transform .25s cubic-bezier(.34,1.56,.64,1), color .2s; }
            .mib-btn:hover { background: var(--icon-hover-bg,rgba(21,41,24,0.08)); color: var(--icon-hover-color,var(--icon-accent,#82e938)); }
            .mib-btn.active-panel { background: var(--icon-bg-active,#152918); color: var(--icon-accent,#82e938); }

            /* Сброс outline для всех вложенных элементов иконбара */
            #map-icon-bar *, #map-icon-bar *:focus, #map-icon-bar *:focus-visible, #map-icon-bar *:active {
                outline: none !important; box-shadow: none !important; -webkit-tap-highlight-color: transparent !important;
            }

            /* ── Тултипы ── */
            .mib-tip {
                position: absolute;
                right: 48px; top: 50%;
                transform: translateY(-50%);
                background: #1a2e1c; color: #fff;
                font-size: 12px; padding: 5px 10px; border-radius: 7px;
                white-space: nowrap; pointer-events: none;
                opacity: 0; transition: opacity .15s; z-index: 100;
                font-family: Lato, sans-serif;
            }
            .mib-btn:hover .mib-tip { opacity: 1; }

            /* ── Кнопка полного экрана — отдельная таблетка под иконбаром, стиль правой панели ── */
            #map-fullscreen-btn {
                position: fixed;
                right: 10px;
                bottom: 14px;
                z-index: 1300;
                width: calc(var(--mib-btn-size,40px) + 16px);
                height: calc(var(--mib-btn-size,40px) + 16px);
                border-radius: 18px;
                border: none !important;
                background: transparent !important;
                color: var(--icon-accent,#82e938);
                cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                box-shadow: none !important;
                transition: color .18s, opacity .15s;
                pointer-events: auto;
                font-size: var(--mib-icon-size,17px);
                outline: none !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            #map-fullscreen-btn:hover {
                background: transparent !important;
                color: var(--icon-accent,#82e938);
                box-shadow: none !important;
                opacity: 0.75;
            }
            #map-fullscreen-btn:focus,
            #map-fullscreen-btn:focus-visible,
            #map-fullscreen-btn:active {
                outline: none !important;
                box-shadow: none !important;
                background: transparent !important;
            }
            #map-fullscreen-btn .mib-tip {
                right: calc(100% + 8px); top: 50%;
                transform: translateY(-50%);
                bottom: auto;
            }

            /* ── Кнопка "Моё местоположение" — сразу над кнопкой полного экрана, тот же стиль ── */
            #map-geoloc-btn {
                position: fixed;
                right: 10px;
                bottom: calc(14px + var(--mib-btn-size,40px) + 16px + 10px);
                z-index: 1300;
                width: calc(var(--mib-btn-size,40px) + 16px);
                height: calc(var(--mib-btn-size,40px) + 16px);
                border-radius: 18px;
                border: none !important;
                background: transparent !important;
                color: var(--icon-accent,#82e938);
                cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                box-shadow: none !important;
                transition: color .18s, opacity .15s;
                pointer-events: auto;
                font-size: var(--mib-icon-size,17px);
                outline: none !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            #map-geoloc-btn:hover {
                background: transparent !important;
                box-shadow: none !important;
                opacity: 0.75;
            }
            #map-geoloc-btn:focus,
            #map-geoloc-btn:focus-visible,
            #map-geoloc-btn:active {
                outline: none !important;
                box-shadow: none !important;
                background: transparent !important;
            }
            #map-geoloc-btn .mib-tip {
                right: calc(100% + 8px); top: 50%;
                transform: translateY(-50%);
                bottom: auto;
            }
            /* Активный трекинг — синий, лёгкая пульсация */
            #map-geoloc-btn.geoloc-active { color: #4285f4; }
            #map-geoloc-btn.geoloc-active i { animation: mib-geoloc-pulse 1.5s ease-in-out infinite; }
            /* Точность 1–5 м достигнута — зелёный акцент */
            #map-geoloc-btn.geoloc-precise { color: #2ecc71; }
            @keyframes mib-geoloc-pulse {
                0%, 100% { filter: drop-shadow(0 0 0 rgba(66,133,244,0)); }
                50%      { filter: drop-shadow(0 0 6px rgba(66,133,244,0.9)); }
            }
            body.fullscreen-mode #map-geoloc-btn {
                position: fixed !important;
                bottom: calc(14px + var(--mib-btn-size,40px) + 16px + 10px) !important;
                right: 10px !important;
                z-index: 10002 !important;
                pointer-events: auto !important;
            }

            /* ── Анимации иконок ── */
            @keyframes mib-fire-burn { 0%{transform:scale(1) rotate(-3deg)} 25%{transform:scale(1.25) rotate(4deg)} 50%{transform:scale(1.18) rotate(-5deg)} 75%{transform:scale(1.28) rotate(3deg)} 100%{transform:scale(1.2) rotate(-2deg)} }
            .mib-btn:hover .fa-fire { animation:mib-fire-burn .5s ease-in-out infinite alternate; color:#ff4500!important; filter:drop-shadow(0 0 4px #ff6a00); }
            @keyframes mib-spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
            .mib-btn:hover .fa-gear { animation:mib-spin .8s linear infinite; }
            @keyframes mib-map-open { 0%{transform:scale(1) rotateY(0)} 40%{transform:scale(1.2) rotateY(12deg)} 70%{transform:scale(1.18) rotateY(-8deg)} 100%{transform:scale(1.15) rotateY(0)} }
            .mib-btn:hover .fa-map { animation:mib-map-open .55s ease-in-out forwards; }
            @keyframes mib-dish { 0%{transform:rotate(0) scale(1)} 30%{transform:rotate(-15deg) scale(1.1)} 60%{transform:rotate(12deg) scale(1.15)} 100%{transform:rotate(0) scale(1.1)} }
            .mib-btn:hover .fa-satellite-dish { animation:mib-dish .6s ease-in-out infinite alternate; }
            @keyframes mib-ruler { 0%{transform:translateX(0) rotate(0)} 25%{transform:translateX(3px) rotate(5deg)} 75%{transform:translateX(-3px) rotate(-5deg)} 100%{transform:translateX(0) rotate(0)} }
            .mib-btn:hover .fa-ruler { animation:mib-ruler .4s ease-in-out infinite; }
            @keyframes mib-print { 0%,100%{transform:translateY(0)} 50%{transform:translateY(3px)} }
            .mib-btn:hover .fa-print { animation:mib-print .45s ease-in-out infinite; }
            @keyframes mib-clock { from{transform:rotate(0) scale(1.1)} to{transform:rotate(-360deg) scale(1.1)} }
            .mib-btn:hover .fa-clock-rotate-left { animation:mib-clock 1s linear infinite; }
            @keyframes mib-layers { 0%,100%{transform:translateY(0) scale(1)} 33%{transform:translateY(-3px) scale(1.12)} 66%{transform:translateY(2px) scale(1.08)} }
            .mib-btn:hover .fa-layer-group { animation:mib-layers .5s ease-in-out infinite; }
            @keyframes mib-globe { from{transform:rotateY(0) scale(1.1)} to{transform:rotateY(360deg) scale(1.1)} }
            .mib-btn:hover .fa-globe { animation:mib-globe 1.2s linear infinite; }
            @keyframes mib-bounce { 0%,100%{transform:translateY(0) scale(1)} 40%{transform:translateY(-4px) scale(1.15)} 70%{transform:translateY(2px) scale(0.95)} }
            .mib-btn:hover .fa-circle-question { animation:mib-bounce .5s ease-in-out infinite; }

            /* ══ FULLSCREEN — элементы физически перенесены в body ══ */

            body.fullscreen-mode { overflow: hidden !important; }
            body.fullscreen-mode #map {
                position: fixed !important; inset: 0 !important;
                width: 100vw !important; height: 100vh !important; z-index: 1 !important;
            }
            body.fullscreen-mode .sidebar { display: none !important; }
            body.fullscreen-mode #map-icon-bar {
                position: fixed !important;
                bottom: 18px !important; left: 50% !important;
                top: auto !important; right: auto !important;
                transform: translateX(-50%) !important;
                flex-direction: row !important; align-items: center !important; justify-content: center !important;
                width: auto !important; height: auto !important;
                background: rgba(255,255,255,0.97) !important;
                border: 1.5px solid rgba(130,233,56,0.45) !important; border-left: 1.5px solid rgba(130,233,56,0.45) !important;
                border-radius: 40px !important; padding: 7px 14px !important; gap: 4px !important;
                box-shadow: 0 6px 28px rgba(0,0,0,0.22) !important;
                z-index: 9999 !important; pointer-events: auto !important;
                backdrop-filter: blur(14px) !important; display: flex !important;
            }
            body.fullscreen-mode #map-icon-bar::before,
            body.fullscreen-mode #map-icon-bar::after { display: none !important; }
            body.fullscreen-mode .mib-btn { margin: 0 !important; pointer-events: auto !important; cursor: pointer !important; }
            body.fullscreen-mode .mib-btn .mib-tip {
                right: auto !important; left: 50% !important;
                top: auto !important; bottom: calc(100% + 10px) !important;
                transform: translateX(-50%) !important;
                pointer-events: none !important; white-space: nowrap !important;
            }
            body.fullscreen-mode #map-slide-panel {
                position: fixed !important; right: 10px !important; top: 10px !important;
                bottom: auto !important; left: auto !important;
                max-height: calc(100vh - 80px) !important;
                transform: translateX(calc(100% + 20px)) !important; opacity: 0 !important;
                transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .22s cubic-bezier(.22,1,.36,1) !important;
                z-index: 10001 !important; pointer-events: none !important;
            }
            body.fullscreen-mode #map-slide-panel.open {
                transform: translateX(0) !important; opacity: 1 !important;
                visibility: visible !important; pointer-events: auto !important;
                box-shadow: 0 5px 25px rgba(0,0,0,0.3) !important;
            }
            body.fullscreen-mode #map-fullscreen-btn {
                position: fixed !important;
                bottom: 14px !important;
                right: 10px !important;
                z-index: 10002 !important;
                pointer-events: auto !important;
            }
            body.fullscreen-mode #map-nav-group {
                position: fixed !important; top: 14px !important; left: 14px !important;
                z-index: 10000 !important; pointer-events: auto !important;
            }
            body.fullscreen-mode #custom-scale-bar {
                position: fixed !important; bottom: 72px !important; left: 14px !important;
                z-index: 9998 !important; transition: none !important;
            }
 
            /* ── Плашка лесхоза — улучшенный стиль ── */
            #selected-leshoz-bar { bottom:40px!important; background:rgba(21,41,24,0.97)!important; border:2px solid #82e938!important; border-radius:40px!important; padding:10px 20px!important; box-shadow:0 4px 24px rgba(0,0,0,0.5)!important; animation:barSlideUp .25s ease!important; }
            @keyframes barSlideUp { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
            #slb-name { color:#fff!important; font-size:15px!important; font-weight:700!important; }
            #slb-count { color:#82e938!important; font-size:12px!important; font-weight:700!important; background:rgba(130,233,56,0.12)!important; border-radius:20px!important; padding:3px 10px!important; border:1px solid rgba(130,233,56,0.3)!important; }
            #slb-download { background:rgba(130,233,56,0.15)!important; border:1px solid rgba(130,233,56,0.4)!important; color:#82e938!important; border-radius:20px!important; padding:5px 14px!important; font-size:12px!important; font-weight:700!important; cursor:pointer!important; display:inline-flex!important; align-items:center!important; gap:5px!important; text-decoration:none!important; transition:all .18s!important; }
            #slb-download:hover { background:#82e938!important; color:#152918!important; }
            #slb-close:hover { color:#ff6b6b!important; }
 
            /* ── Тосты: по центру снизу ── */
            #toast-container { left:50%!important; right:auto!important; bottom:90px!important; transform:translateX(-50%)!important; }
 
            /* ── Хоткей-модал — тёмная тема ── */
            #hotkey-modal { backdrop-filter:blur(4px)!important; }
            #hotkey-modal-box { width:420px!important; border-radius:16px!important; }
            .hm-header { background:#152918!important; padding:20px 22px!important; }
            .hm-header h3 { color:#82e938!important; font-size:18px!important; }
            .hm-close { color:#82e938!important; font-size:22px!important; }
            .hm-close:hover { color:#fff!important; }
 
            /* ── Info-float anchor (нулевая точка OL Overlay) ── */
            #info-float-anchor {
                position: absolute;
                width: 0; height: 0;
                overflow: visible;
                pointer-events: none;
            }
            /* ── Info-float popup (растёт вверх из anchor) ── */
            #info-float-popup {
                pointer-events: auto;
                position: absolute;
                /* Центрируем попап по горизонтали относительно точки,
                   и поднимаем вверх с учётом стрелки (14px) */
                bottom: 14px;
                left: 50%;
                transform: translateX(-50%);
                width: 320px;
                max-width: calc(100vw - 32px);
                max-height: 440px;
                display: none;
                flex-direction: column;
                background: #ffffff;
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
                font-family: Lato, sans-serif;
                overflow: hidden;
                animation: ift-appear .15s ease-out;
            }
            #info-float-popup.visible { display: flex; }
            /* Стрелка — строго по центру нижней грани попапа */
            #info-float-popup::after {
                content: '';
                position: absolute;
                bottom: -13px;
                left: 50%;
                transform: translateX(-50%);
                width: 0; height: 0;
                border-left: 13px solid transparent;
                border-right: 13px solid transparent;
                border-top: 14px solid #ffffff;
                filter: drop-shadow(0 3px 4px rgba(0,0,0,0.12));
            }
            @keyframes ift-appear {
                from { opacity:0; transform: translateX(-50%) translateY(6px); }
                to   { opacity:1; transform: translateX(-50%) translateY(0); }
            }
            /* Свёрнутое состояние */
            #info-float-popup.minimized #info-float-tabs,
            #info-float-popup.minimized #info-float-body { display: none; }
            #info-float-popup.minimized { max-height: none; overflow: visible; }
            /* Header */
            #info-float-header {
                display: flex;
                align-items: center;
                padding: 12px 12px 8px 14px;
                gap: 8px;
                flex-shrink: 0;
                border-bottom: 1px solid #f0f0f0;
            }
            #info-float-title {
                flex: 1;
                font-weight: 700;
                font-size: 15px;
                color: #1a1a1a;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #info-float-minimize {
                background: #f2f2f2;
                border: 1.5px solid #e0e0e0;
                color: #444;
                font-size: 17px;
                font-weight: 700;
                cursor: pointer;
                width: 28px; height: 28px;
                border-radius: 8px;
                display: flex; align-items: center; justify-content: center;
                line-height: 1;
                transition: all .12s;
                padding: 0;
                flex-shrink: 0;
            }
            #info-float-minimize:hover { background: #e0e0e0; }
            #info-float-close {
                background: #f2f2f2;
                border: 1.5px solid #e0e0e0;
                color: #444;
                font-size: 16px;
                cursor: pointer;
                width: 28px; height: 28px;
                border-radius: 8px;
                display: flex; align-items: center; justify-content: center;
                line-height: 1;
                transition: all .12s;
                padding: 0;
                flex-shrink: 0;
            }
            #info-float-close:hover { background: #fde8e8; color: #c62828; border-color: #f5a0a0; }
            /* Вкладки слоёв */
            #info-float-tabs {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                padding: 8px 12px;
                flex-shrink: 0;
                border-bottom: 1px solid #f0f0f0;
            }
            #info-float-tabs:empty { display: none; padding: 0; }
            /* Скрываем строку вкладок если только одна вкладка */
            #info-float-tabs:has(.ift-tab:only-child) { display: none; padding: 0; }
            .ift-tab {
                padding: 4px 10px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                transition: all .12s;
                background: #f5f5f5;
                color: #555;
                border: 1.5px solid #e0e0e0;
                display: flex;
                align-items: center;
                gap: 5px;
                letter-spacing: .3px;
                text-transform: uppercase;
                white-space: nowrap;
            }
            .ift-tab:hover { background: #ebebeb; color: #222; }
            .ift-tab.active {
                background: #2e7d32;
                color: #fff;
                border-color: #2e7d32;
            }
            .ift-tab-cnt {
                display: inline-flex; align-items: center; justify-content: center;
                background: rgba(255,255,255,0.25);
                color: inherit;
                border-radius: 8px;
                min-width: 17px; height: 15px;
                font-size: 9.5px;
                padding: 0 4px;
            }
            .ift-tab:not(.active) .ift-tab-cnt { background: rgba(0,0,0,0.1); }
            /* Body */
            #info-float-body {
                overflow-y: auto;
                flex: 1;
                background: #fff;
            }
            #info-float-body::-webkit-scrollbar { width: 3px; }
            #info-float-body::-webkit-scrollbar-track { background: #f8f8f8; }
            #info-float-body::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
            /* Карточка объекта */
            .iff-card { padding: 8px 14px 6px; }
            .iff-more-btn {
                display: block;
                width: calc(100% - 28px);
                margin: 6px 14px 14px;
                padding: 11px 16px;
                background: #2e7d32;
                color: #fff;
                border: none;
                border-radius: 9px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                text-align: center;
                font-family: Lato, sans-serif;
                transition: background .15s;
                letter-spacing: .2px;
            }
            .iff-more-btn:hover { background: #1b5e20; }
            /* Навигация по объектам */
            .iff-nav {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 12px;
                background: #f5f9f5;
                border-bottom: 1px solid #e8f0e8;
                gap: 8px;
            }
            .iff-nav-btn {
                background: #2e7d32;
                color: #fff;
                border: none;
                border-radius: 5px;
                width: 28px; height: 26px;
                font-size: 17px;
                line-height: 1;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                transition: background 0.15s;
            }
            .iff-nav-btn:hover:not(:disabled) { background: #1b5e20; }
            .iff-nav-btn:disabled { background: #d0d0d0; cursor: default; }
            .iff-nav-counter {
                font-size: 12px;
                font-weight: 700;
                color: #2e7d32;
                flex: 1;
                text-align: center;
            }
            /* Строки свойств */
            .iff-row {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                gap: 10px;
                padding: 4px 0;
                border-bottom: 1px solid #f6f6f6;
                font-size: 12.5px;
            }
            .iff-row:last-child { border-bottom: none; }
            .iff-key {
                color: #2e7d32;
                flex-shrink: 0;
                max-width: 46%;
                word-break: break-word;
                font-weight: 600;
                font-size: 12px;
            }
            .iff-val {
                font-weight: 600;
                color: #1a1a1a;
                text-align: right;
                word-break: break-word;
                font-size: 12.5px;
            }
            .iff-val.sm { color: #555; font-size: 11.5px; font-weight: 500; }
            .iff-empty {
                padding: 20px 16px;
                text-align: center;
                color: #bbb;
                font-size: 12px;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 6px;
            }
            .iff-obj-title {
                color: #2e7d32;
                font-size: 10px;
                font-weight: 800;
                padding: 2px 0;
                text-transform: uppercase;
                letter-spacing: .5px;
            }

            /* ── Масштабная линейка — темы ── */
            #custom-scale-bar.style-birch { background:rgba(245,245,230,0.92); }
            #custom-scale-bar.style-birch .csb-labels span, #custom-scale-bar.style-birch .csb-ratio { color:#4a5e2a!important; }
            #custom-scale-bar.style-birch .csb-seg, #custom-scale-bar.style-birch .csb-seg-end { border-color:#4a5e2a!important; }
            #custom-scale-bar.style-pine { background:rgba(30,45,80,0.88); }
            #custom-scale-bar.style-pine .csb-labels span, #custom-scale-bar.style-pine .csb-ratio { color:#7fb3d3!important; }
            #custom-scale-bar.style-pine .csb-seg, #custom-scale-bar.style-pine .csb-seg-end { border-color:#7fb3d3!important; }
            #custom-scale-bar.style-spruce { background:rgba(8,8,8,0.92); }
            #custom-scale-bar.style-spruce .csb-labels span, #custom-scale-bar.style-spruce .csb-ratio { color:#aaa!important; }
            #custom-scale-bar.style-spruce .csb-seg, #custom-scale-bar.style-spruce .csb-seg-end { border-color:#aaa!important; }
            #custom-scale-bar.style-oak { background:rgba(80,45,10,0.88); }
            #custom-scale-bar.style-oak .csb-labels span, #custom-scale-bar.style-oak .csb-ratio { color:#e8c87a!important; }
            #custom-scale-bar.style-oak .csb-seg, #custom-scale-bar.style-oak .csb-seg-end { border-color:#e8c87a!important; }
 
            /* ── Слайд-панель — position:fixed чтобы не давить иконбар вправо ── */
            #map-slide-panel {
                position: fixed;
                top: 0;
                right: calc(var(--mib-btn-size,40px) + 36px);
                bottom: 0;
                width: 320px;
                background: #fff;
                box-shadow: -4px 0 20px rgba(0,0,0,.12);
                transform: translateX(calc(100% + calc(var(--mib-btn-size,40px) + 36px)));
                transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .22s cubic-bezier(.22,1,.36,1);
                display: flex; flex-direction: column;
                pointer-events: none;
                overflow: hidden;
                opacity: 0;
                z-index: 999;
            }
            #map-slide-panel.open {
                transform: translateX(0);
                pointer-events: auto;
                opacity: 1;
            }
            .msp-header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px 12px; border-bottom:1px solid #eee; background:#f8f9fa; }
            .msp-title { font-size:15px; font-weight:800; color:#152918; }
            .msp-close { border:none; background:none; cursor:pointer; font-size:18px; color:#999; padding:2px 6px; border-radius:5px; }
            .msp-close:hover { background:#f0f0f0; color:#333; }
            .msp-list { flex:1; overflow-y:auto; padding:8px 0; }
            .msp-search { display:flex; align-items:center; gap:8px; margin:10px 14px 4px; padding:7px 12px; background:#f5f5f5; border-radius:8px; }
            .msp-search i { color:#aaa; }
            .msp-search input { border:none; background:none; outline:none; flex:1; font-size:13px; color:#333; }
            .msp-section { border-bottom:1px solid #f0f0f0; }
            .msp-section-header { display:flex; align-items:center; justify-content:space-between; padding:10px 16px; cursor:pointer; font-size:13px; font-weight:700; color:#333; background:#fafafa; }
            .msp-section-header:hover { background:#f0f0f0; }
            .msp-section.collapsed .msp-section-body { display:none; }
            .msp-section-body { padding:4px 0; }
            .msp-layer-item { display:flex; align-items:center; gap:10px; padding:8px 16px; cursor:pointer; transition:.12s; }
            .msp-layer-item:hover { background:#f5fdf5; }
            /* ── Слой leshoz1 с легендой ── */
            .l1-wrap { padding:0 !important; flex-direction:column !important; align-items:stretch !important; cursor:default !important; }
            .l1-wrap:hover { background:transparent !important; }
            .l1-row { display:flex; align-items:center; gap:10px; padding:8px 14px; cursor:pointer; transition:background .12s; }
            .l1-row:hover { background:#f5fdf5; }
            .l1-toggle-btn { margin-left:auto; width:22px; height:22px; border:none; background:none; cursor:pointer; color:#bbb; border-radius:5px; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:color .15s, background .15s; }
            .l1-toggle-btn:hover { color:#367946; background:rgba(54,121,70,0.08); }
            .l1-toggle-btn i { font-size:11px; transition:transform .2s; }
            .l1-legend-box { display:none; padding:4px 14px 10px 42px; border-top:1px solid #f0f4f0; background:#f8faf8; }
            .l1-legend-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:4px 6px; padding-top:6px; }
            .l1-leg-row { display:flex; align-items:center; gap:5px; }
            .l1-leg-swatch { width:13px; height:13px; border-radius:3px; flex-shrink:0; border:1px solid rgba(0,0,0,0.15); }
            .l1-leg-year { font-size:11px; font-weight:700; color:#555; font-family:Lato,sans-serif; }
            .msp-layer-check { width:18px; height:18px; border:2px solid #ccc; border-radius:4px; flex-shrink:0; transition:.15s; }
            .msp-layer-check.checked { background:#367946; border-color:#367946; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath fill='%23fff' d='M10 3L5 8 2 5'/%3E%3C/svg%3E"); background-size:70%; background-repeat:no-repeat; background-position:center; }
            .msp-layer-name { flex:1; font-size:13px; color:#333; }
 
            /* ── Поиск в сайдбаре ── */
            #sidebar-search-wrap { padding:8px 12px; position:relative; }
            #sidebar-search-box { display:flex; align-items:center; gap:6px; background:#f5f5f5; border-radius:10px; padding:7px 12px; border:1.5px solid #eee; transition:border-color .2s; }
            #sidebar-search-box:focus-within { border-color:#82e938; background:#f0fdf0; }
            #sidebar-search-icon { color:#aaa; font-size:13px; }
            #sidebar-search-input { border:none; background:none; outline:none; flex:1; font-size:13px; color:#333; min-width:0; }
            #sidebar-search-clear { border:none; background:none; color:#aaa; cursor:pointer; padding:2px 4px; display:none; font-size:12px; }
            #sidebar-search-filter-btn { border:none; background:none; color:#aaa; cursor:pointer; padding:2px 5px; font-size:13px; border-radius:6px; transition:.15s; flex-shrink:0; }
            #sidebar-search-filter-btn:hover { color:#82e938; background:rgba(130,233,56,0.1); }
            #sidebar-search-filter-btn.active { color:#82e938; background:rgba(130,233,56,0.15); }
            #sidebar-search-results { position:relative; z-index:900; background:#fff; border:1px solid #eee; border-radius:10px; margin:4px 0 0; box-shadow:0 4px 14px rgba(0,0,0,.1); max-height:340px; overflow-y:auto; display:none; }
            #sidebar-search-results.has-results { display:block; }
            .ssr-item { display:flex; align-items:center; gap:8px; padding:9px 14px; cursor:pointer; border-bottom:1px solid #f5f5f5; transition:.12s; }
            .ssr-item:hover { background:#f0fdf0; }
            .ssr-name { font-size:13px; font-weight:700; color:#333; }
            .ssr-region { font-size:11px; color:#888; margin-top:2px; }
            .ssr-badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:20px; background:#f0f0f0; color:#888; white-space:nowrap; }
            .ssr-badge.has-imgs { background:#e8fde8; color:#1b5e20; }
            .ssr-no-results { padding:14px; text-align:center; color:#aaa; font-size:13px; }

            /* ── Фильтр-панель поиска ── */
            #search-filter-panel {
                position:absolute; top:calc(100% + 4px); left:12px; right:12px;
                background:#1a2e1c; border:1.5px solid rgba(130,233,56,0.25);
                border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,.35);
                z-index:1100; padding:12px; display:none; flex-direction:column; gap:8px;
                animation:sfpIn .18s ease;
            }
            #search-filter-panel.open { display:flex; }
            @keyframes sfpIn { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:none} }
            .sfp-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:2px; }
            .sfp-title { font-size:12px; font-weight:700; color:#82e938; }
            .sfp-reset { border:none; background:rgba(130,233,56,0.1); color:#82e938; font-size:11px; padding:3px 10px; border-radius:20px; cursor:pointer; font-weight:700; transition:.15s; }
            .sfp-reset:hover { background:rgba(130,233,56,0.22); }
            .sfp-section-label { font-size:10px; font-weight:700; color:#688; text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
            .sfp-items { display:flex; flex-direction:column; gap:4px; }
            .sfp-item { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:8px; cursor:pointer; transition:.12s; color:#ccc; font-size:12px; }
            .sfp-item:hover { background:rgba(130,233,56,0.08); color:#fff; }
            .sfp-item input[type=checkbox] { accent-color:#82e938; width:14px; height:14px; flex-shrink:0; cursor:pointer; }
            .sfp-icon { font-size:11px; width:14px; text-align:center; flex-shrink:0; }
            .sfp-active-layers { display:flex; flex-wrap:wrap; gap:5px; margin-top:2px; }
            .sfp-active-layer-chip { background:rgba(130,233,56,0.1); border:1px solid rgba(130,233,56,0.2); color:#82e938; font-size:10px; font-weight:600; padding:3px 9px; border-radius:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; display:flex; align-items:center; gap:4px; }
            .sfp-active-layer-chip.sfp-more { background:rgba(255,255,255,0.07); color:#aaa; border-color:rgba(255,255,255,0.1); }
            .sfp-no-layers { color:#555; font-size:11px; font-style:italic; padding:4px 2px; }
 
            /* ── Масштабная линейка ── */
            #custom-scale-bar { position:absolute; bottom:30px; left:10px; z-index:950; display:inline-flex; flex-direction:column; align-items:flex-start; background:rgba(21,41,24,0.85); border-radius:6px; padding:4px 10px 5px; pointer-events:auto; cursor:pointer; user-select:none; transition:left .25s ease; }
            /* Поднимаем линейку когда активна шкала timeline */
            body.timeline-active #custom-scale-bar { bottom:calc(var(--ytl-h, 150px) + 10px); } /* [v20.8] высота шкалы — из panel-timeline.js */
            .csb-ruler { display:flex; position:relative; height:10px; margin-bottom:2px; }
            .csb-seg { border:1px solid var(--icon-accent,#82e938); border-right:none; height:100%; box-sizing:border-box; }
            .csb-seg.alt { background:rgba(130,233,56,0.2); }
            .csb-seg-end { position:absolute; right:0; top:0; border-right:1px solid var(--icon-accent,#82e938); height:100%; }
            .csb-labels { display:flex; justify-content:space-between; font-size:10px; font-weight:700; color:var(--icon-accent,#82e938); font-family:Lato,sans-serif; }
            .csb-ratio { font-size:10px; font-weight:700; color:var(--icon-accent,#82e938); font-family:Lato,sans-serif; margin-top:1px; }
 
            /* ── Плашка выбранного лесхоза ── */
            #selected-leshoz-bar { position:absolute; bottom:8px; left:50%; transform:translateX(-50%); z-index:600; background:rgba(6,12,6,0.92); border:1.5px solid rgba(130,233,56,0.25); border-radius:24px; padding:8px 18px; display:none; align-items:center; gap:12px; font-family:Lato,sans-serif; pointer-events:auto; backdrop-filter:blur(8px); }
            #slb-name { font-size:14px; font-weight:800; color:#82e938; }
            #slb-count { font-size:12px; background:#152918; color:#82e938; padding:2px 10px; border-radius:20px; font-weight:700; }
            #slb-close { border:none; background:rgba(255,255,255,0.1); color:#aaa; border-radius:50%; width:22px; height:22px; cursor:pointer; font-size:14px; display:flex; align-items:center; justify-content:center; }
            #slb-close:hover { background:rgba(255,255,255,0.2); color:#fff; }
 
            /* ── Координатная панель ── */
            #coords-panel { position:absolute; bottom:80px; left:10px; z-index:800; background:rgba(6,12,6,0.92); border:1px solid rgba(130,233,56,0.2); border-radius:10px; min-width:260px; font-family:Lato,sans-serif; pointer-events:auto; }
            #coords-header { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid rgba(130,233,56,0.15); font-size:13px; font-weight:700; color:#82e938; cursor:default; }
            .close-coords { cursor:pointer; color:#888; font-size:18px; }
            .close-coords:hover { color:#fff; }
            #coords-content { padding:8px 12px; display:flex; flex-direction:column; gap:3px; }
            .coord-row { display:flex; align-items:center; gap:6px; font-size:12px; }
            .coord-label { color:#688; min-width:100px; font-size:11px; }
            .coord-val { color:#e0ffe0; font-family:monospace; font-size:11px; }
 
            /* ── Попап снимка ── */
            .custom-popup { font-family:Lato,sans-serif; min-width:240px; }
            .popup-header { background:linear-gradient(135deg,#1a2e1c,#243b27); padding:0 8px 0 16px; border-radius:10px 10px 0 0; display:flex; align-items:center; justify-content:space-between; min-height:44px; gap:8px; }
            .popup-header h3 { margin:0; font-size:14px; font-weight:800; color:#82e938; flex:1; padding:12px 0 10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .popup-header-close { flex-shrink:0; width:26px; height:26px; border-radius:50%; border:none; background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.7); font-size:16px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s,color .15s; padding:0; }
            .popup-header-close:hover { background:rgba(255,255,255,0.25); color:#fff; }
            .ph-region { font-size:11px; color:#688; margin-top:2px; }
            .popup-body { padding:10px 16px; display:flex; flex-direction:column; gap:5px; }
            .popup-row { display:flex; align-items:center; gap:6px; font-size:13px; }
            .popup-label { color:#999; font-size:12px; min-width:80px; }
            .popup-val { color:#333; font-weight:600; }
            .popup-footer { padding:10px 16px 12px; display:flex; flex-direction:column; gap:6px; }
            .popup-dl-btn { display:flex; align-items:center; justify-content:center; gap:7px; padding:9px 14px; border-radius:8px; border:none; cursor:pointer; font-size:13px; font-weight:700; text-decoration:none; transition:.15s; }
            .popup-dl-btn.primary { background:linear-gradient(135deg,#367946,#1a4020); color:#fff; }
            .popup-dl-btn.primary:hover { background:linear-gradient(135deg,#3d8a51,#21521e); }
            .popup-btn-edit { background:#e3f2fd; color:#1565c0; }
            .popup-btn-del  { background:#ffebee; color:#c62828; }
            .popup-admin-row { display:flex; gap:6px; }
 
            /* ── Тосты ── */
            #toast-container { position:fixed; bottom:20px; right:70px; z-index:9999; display:flex; flex-direction:column; gap:7px; pointer-events:none; }
            .toast { padding:10px 18px; border-radius:10px; font-family:Lato,sans-serif; font-size:13px; font-weight:700; color:#fff; background:rgba(21,41,24,0.95); border:1px solid rgba(130,233,56,0.3); box-shadow:0 4px 14px rgba(0,0,0,.2); animation:toastIn .25s ease,toastOut .3s ease 2.7s forwards; }
            .toast.error { background:rgba(198,40,40,0.95); border-color:rgba(255,100,100,0.3); }
            @keyframes toastIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
            @keyframes toastOut { from{opacity:1} to{opacity:0;transform:translateY(8px)} }
 
            /* ── Горячие клавиши модал ── */
            #hotkey-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9998; align-items:center; justify-content:center; }
            #hotkey-modal.open { display:flex; }
            #hotkey-modal-box { background:#fff; border-radius:12px; min-width:340px; max-width:480px; box-shadow:0 8px 32px rgba(0,0,0,.2); overflow:hidden; }
            .hm-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; background:#f8f9fa; border-bottom:1px solid #eee; }
            .hm-header h3 { margin:0; font-size:16px; font-weight:800; color:#152918; }
            .hm-close { border:none; background:none; font-size:20px; cursor:pointer; color:#aaa; }
            .hm-body { padding:16px 20px; display:flex; flex-direction:column; gap:8px; }
            .hm-row { display:flex; align-items:center; gap:12px; font-size:13px; }
            .hm-key { background:#f0f0f0; padding:3px 10px; border-radius:6px; font-family:monospace; font-size:12px; font-weight:700; color:#333; white-space:nowrap; min-width:120px; }
            .hm-desc { color:#555; }
 
            /* ── CSS переменные ── */
            :root { --icon-accent:#82e938; --icon-bg-active:#152918; --icon-hover-color:#152918; --mib-btn-size:40px; --mib-icon-size:17px; --fs-mult:1; }
        `;
        document.head.appendChild(s);
    }
 
    // ==========================================
    // 37. TOAST УВЕДОМЛЕНИЯ
    // ==========================================
    if (!window.showToast) {
        window.showToast = function(msg, isError) {
            let tc = document.getElementById('toast-container');
            if (!tc) {
                tc = document.createElement('div');
                tc.id = 'toast-container';
                document.body.appendChild(tc);
            }
            const t = document.createElement('div');
            t.className = 'toast' + (isError ? ' error' : '');
            t.innerHTML = isError
                ? `<i class="fa-solid fa-triangle-exclamation" style="margin-right:7px;color:#f44336;"></i>${msg}`
                : `<i class="fa-solid fa-circle-check" style="margin-right:7px;color:#82e938;"></i>${msg}`;
            tc.appendChild(t);
            setTimeout(() => { if (t.parentNode) t.remove(); }, 3200);
        };
    }
 
    // ==========================================
    // 38. МОДАЛЬНЫЕ ОКНА (Загрузка / Редактирование)
    // ==========================================
    window.openUploadModal = function(code, name) {
        const modal = document.getElementById('uploadModal');
        if (!modal) return;
        const title       = document.getElementById('modalTitle');
        const hiddenInput = document.getElementById('selectedLeskhozId');
        const form        = document.getElementById('uploadForm');
        const status      = document.getElementById('uploadStatus');
        if (title)       title.innerText = name;
        if (hiddenInput) hiddenInput.value = code;
        if (form)        form.reset();
        if (status)      status.innerHTML = '';
        window.toggleUploadMode && window.toggleUploadMode();
        modal.style.display = 'block';
        if (!modal._closeInited) {
            modal._closeInited = true;
            const xEl = modal.querySelector('.upload-close, .modal-close, .close, [data-dismiss="modal"]');
            if (xEl) xEl.addEventListener('click', () => { modal.style.display = 'none'; });
            modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
        }
    };
 
    window.toggleUploadMode = function() {
        const checked = document.querySelector('input[name="uploadMode"]:checked');
        const mode = checked ? checked.value : 'files';
        const fb  = document.getElementById('filesBlock');
        const flb = document.getElementById('folderBlock');
        if (fb)  fb.style.display  = mode === 'files'  ? '' : 'none';
        if (flb) flb.style.display = mode === 'folder' ? '' : 'none';
    };
 
    window.openEditModal = function(id, date, equipment, contract, org, survey_type) {
        const modal = document.getElementById('editModal');
        if (!modal) return;
        const setVal = (elId, val) => {
            const el = document.getElementById(elId);
            if (el) el.value = val || '';
        };
        setVal('editId', id);
        setVal('editDate', date);
        setVal('editEquipment', equipment);
        setVal('editContract', contract);
        setVal('editOrg', org);
        const typeEl = document.getElementById('editSurveyType');
        if (typeEl) typeEl.value = survey_type || 'uav';
        modal.style.display = 'block';
        if (!modal._closeInited) {
            modal._closeInited = true;
            const xEl = modal.querySelector('.modal-close, .close, [data-dismiss="modal"]');
            if (xEl) xEl.addEventListener('click', () => { modal.style.display = 'none'; });
            modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
        }
    };
 
    // ==========================================
    // 39. ИНИЦИАЛИЗАЦИЯ КООРДИНАТНОЙ КНОПКИ В ИКОНБАРЕ
    // ==========================================
    // Координатная кнопка добавляется прямо в buildIconBar (секция 24) через addCoordsBtn.
    // Здесь её регистрация уже обеспечена buildIconBar flow — дополнительных действий не требуется.
 
    // ==========================================
    // 40. СОХРАНЕНИЕ ПОЗИЦИИ КАРТЫ ПРИ ВЫХОДЕ
    // ==========================================
    // [J] PERF: beforeunload — только сохранение состояния слоёв.
    // Позиция карты уже сохраняется дебаунсированным moveend-листенером (~625 строка).
    // Оставляем map_position здесь как fallback при аварийном закрытии без moveend.
    window.addEventListener('beforeunload', () => {
        try {
            const view   = map.getView();
            const center = ol.proj.toLonLat(view.getCenter());
            const zoom   = view.getZoom();
            // fallback: только если дебаунс ещё не отработал
            localStorage.setItem('map_position', JSON.stringify({
                lat:  center[1],
                lng:  center[0],
                zoom: zoom
            }));
        } catch(e) {}
        window._saveLayersState && window._saveLayersState();
    });
 
    // ==========================================
    // 41. АДАПТАЦИЯ К ИЗМЕНЕНИЮ РАЗМЕРА
    // ==========================================
    // [J] PERF: сохраняем ссылку на ResizeObserver для возможности вызвать disconnect()
    const _mapResizeObs = new ResizeObserver(() => {
        // OpenLayers обновляет размер автоматически через updateSize()
        try { map.updateSize(); } catch(e) {}
        updateCustomScaleBar && updateCustomScaleBar();
    });
    const mapEl = document.getElementById('map');
    if (mapEl) _mapResizeObs.observe(mapEl);
    // Для внешнего доступа при уничтожении карты:
    window._mapResizeObserver = _mapResizeObs;
 
    // ==========================================
    // 42. ГЛОБАЛЬНЫЕ АЛИАСЫ (обратная совместимость)
    // ==========================================
    window.loadVectorLayers   = window.loadVectorLayers   || function() {};
    window.loadMbtilesLayers  = window.loadMbtilesLayers  || function() {};
    window.buildTreeFromData  = window.buildTreeFromData  || function() {};
 
    // Экспортируем ExternalLayerState для других компонентов
    window.ExternalLayerState = AppState.externalLayerState;
 
    // Алиасы совместимости: toggleExternalLayer / setExternalLayerOpacity определены выше (секция 19).
    // map.getCenter()  → ol.proj.toLonLat(map.getView().getCenter())
    // map.getZoom()    → map.getView().getZoom()
    // map.setCenter()  → map.getView().setCenter(ol.proj.fromLonLat([lng, lat]))
    // map.flyTo()      → map.getView().animate({ center, zoom, duration })
 
    // Вспомогательные алиасы для кода, унаследованного от MapLibre:
    if (!window._mapGetCenter) {
        window._mapGetCenter = function() {
            const c = ol.proj.toLonLat(map.getView().getCenter());
            return { lng: c[0], lat: c[1] };
        };
    }
    if (!window._mapGetZoom) {
        window._mapGetZoom = function() {
            return map.getView().getZoom();
        };
    }
    if (!window._mapFlyTo) {
        window._mapFlyTo = function(opts) {
            // opts: { center:[lng,lat], zoom, duration }
            const animOpts = {};
            if (opts.center) animOpts.center = ol.proj.fromLonLat(opts.center);
            if (opts.zoom   !== undefined) animOpts.zoom     = opts.zoom;
            if (opts.duration !== undefined) animOpts.duration = opts.duration;
            map.getView().animate(animOpts);
        };
    }


    // ==========================================
    // 43. СЛОЙ ПОГОДЫ ДЛЯ ЛЕСХОЗОВ БЕЛАРУСИ
    // Uses Open-Meteo API (free, no key, updates hourly)
    // ==========================================

    const LESKHOZI_DATA = [
      // ── Брестская область ──────────────────────────────────────
      { name: "Барановичский лесхоз",              lat: 53.158858, lon: 25.904702, leshozkod: "101" },
      { name: "Брестский лесхоз",                  lat: 52.161682, lon: 23.674269, leshozkod: "102" },
      { name: "Ганцевичский лесхоз",               lat: 52.674617, lon: 26.496107, leshozkod: "103" },
      { name: "Ивацевичский опытный лесхоз",       lat: 52.575641, lon: 25.128983, leshozkod: "104" },
      { name: "Кобринский опытный лесхоз",         lat: 52.162667, lon: 24.412675, leshozkod: "105" },
      { name: "Лунинецкий лесхоз",                 lat: 52.347612, lon: 26.936510, leshozkod: "106" },
      { name: "Ляховичский лесхоз",                lat: 52.926836, lon: 26.179269, leshozkod: "107" },
      { name: "Пинский лесхоз",                    lat: 52.147709, lon: 25.839183, leshozkod: "109" },
      { name: "Пружанский лесхоз",                 lat: 52.663750, lon: 24.590749, leshozkod: "110" },
      { name: "Столинский лесхоз",                 lat: 51.967198, lon: 26.696007, leshozkod: "111" },
      { name: "Телеханский лесхоз",                lat: 52.437431, lon: 26.008505, leshozkod: "112" },
      { name: "Полесский лесхоз",                  lat: 51.879717, lon: 27.358528, leshozkod: "113" },
      { name: "Малоритский лесхоз",                lat: 51.826482, lon: 24.075635, leshozkod: "116" },
      { name: "Дрогичинский лесхоз",               lat: 52.162260, lon: 25.057971, leshozkod: "117" },
      { name: "Домановский лесхоз",                lat: 52.788447, lon: 25.605986, leshozkod: "121" },
      { name: "ГПУ \"НП \"Беловежская пуща\"",  lat: 52.693016, lon: 24.081765, leshozkod: "4014" },
      { name: "ЭЛОХ \"Выгоновское\"",             lat: 52.670806, lon: 25.936401, leshozkod: "4032" },
      { name: "ГПУ НП \"Припятский\"",            lat: 52.010599, lon: 27.999113, leshozkod: "4033" },
      { name: "ЭЛОХ \"Лясковичи\"",               lat: 52.188980, lon: 28.404933, leshozkod: "4001" },
      { name: "ГПНИУ \"ПОЛЕССКИЙ ГРЭЗ\"",         lat: 51.627119, lon: 29.915392, leshozkod: "5030" },
      // ── Витебская область ──────────────────────────────────────
      { name: "Бегомльский лесхоз",                lat: 54.820700, lon: 27.769953, leshozkod: "201" },
      { name: "Бешенковичский лесхоз",             lat: 55.031313, lon: 29.401909, leshozkod: "202" },
      { name: "Богушевский лесхоз",                lat: 54.795923, lon: 29.895884, leshozkod: "203" },
      { name: "Верхнедвинский лесхоз",             lat: 55.851779, lon: 28.137616, leshozkod: "205" },
      { name: "Витебский лесхоз",                  lat: 55.149406, lon: 30.170549, leshozkod: "206" },
      { name: "Глубокский опытный лесхоз",         lat: 55.120388, lon: 27.766400, leshozkod: "207" },
      { name: "Городокский лесхоз",                lat: 55.625155, lon: 30.048048, leshozkod: "208" },
      { name: "Дисненский лесхоз",                 lat: 55.510516, lon: 27.830326, leshozkod: "209" },
      { name: "Лепельский лесхоз",                 lat: 54.803811, lon: 28.937709, leshozkod: "210" },
      { name: "Оршанский лесхоз",                  lat: 54.558265, lon: 30.591180, leshozkod: "211" },
      { name: "Полоцкий лесхоз",                   lat: 55.477457, lon: 28.756934, leshozkod: "212" },
      { name: "Поставский лесхоз",                 lat: 55.143311, lon: 26.955127, leshozkod: "213" },
      { name: "Россонский лесхоз",                 lat: 55.888139, lon: 28.864972, leshozkod: "214" },
      { name: "Суражский лесхоз",                  lat: 55.443140, lon: 30.642056, leshozkod: "215" },
      { name: "Толочинский лесхоз",                lat: 54.463082, lon: 29.750663, leshozkod: "216" },
      { name: "Ушачский лесхоз",                   lat: 55.141335, lon: 28.650790, leshozkod: "217" },
      { name: "Шумилинский лесхоз",                lat: 55.433658, lon: 29.432160, leshozkod: "218" },
      { name: "Лиозненский лесхоз",                lat: 55.022655, lon: 30.685410, leshozkod: "219" },
      { name: "ГПУ \"НП \"Нарочанский\"",        lat: 54.876335, lon: 26.703267, leshozkod: "4012" },
      { name: "Нацпарк \"Браславские озера\"",    lat: 55.604476, lon: 27.058536, leshozkod: "4022" },
      { name: "ЭЛОХ \"Браслав\"",                 lat: 55.533752, lon: 26.962786, leshozkod: "4023" },
      { name: "ЭЛОХ \"Барсуки\"",                 lat: 54.856129, lon: 28.269436, leshozkod: "4020" },
      { name: "ЭЛОХ \"Мядель\"",                  lat: 54.780623, lon: 27.238827, leshozkod: "4043" },
      { name: "Березинский биосферный заповедник", lat: 54.724324, lon: 28.338537, leshozkod: "4044" },
      { name: "Учреждение \"Тетеринское\"",       lat: 54.197865, lon: 29.554044, leshozkod: "4024" },
      { name: "ГЛХУ \"ДВИНСКАЯ ЭЛБ\"",            lat: 55.180109, lon: 28.060218, leshozkod: "8021" },
      { name: "Полоцкий лесной колледж",           lat: 55.555684, lon: 28.652497, leshozkod: "7045" },
      // ── Гомельская область ─────────────────────────────────────
      { name: "Буда-Кошелевский опытный лесхоз",   lat: 52.699268, lon: 30.544672, leshozkod: "301" },
      { name: "Василевичский лесхоз",              lat: 52.310086, lon: 29.850626, leshozkod: "302" },
      { name: "Гомельский опытный лесхоз",         lat: 52.317711, lon: 31.151520, leshozkod: "303" },
      { name: "Ельский лесхоз",                    lat: 51.700039, lon: 28.888348, leshozkod: "304" },
      { name: "Житковичский лесхоз",               lat: 52.308044, lon: 27.655966, leshozkod: "305" },
      { name: "Жлобинский лесхоз",                 lat: 52.814204, lon: 29.930207, leshozkod: "306" },
      { name: "Калинковичский лесхоз",             lat: 52.222195, lon: 29.304175, leshozkod: "307" },
      { name: "Комаринский лесхоз",                lat: 51.673145, lon: 30.402854, leshozkod: "308" },
      { name: "Лоевский лесхоз",                   lat: 51.963750, lon: 30.624059, leshozkod: "309" },
      { name: "Лельчицкий лесхоз",                 lat: 51.803116, lon: 28.378089, leshozkod: "310" },
      { name: "Милошевичский лесхоз",              lat: 51.715165, lon: 27.796254, leshozkod: "311" },
      { name: "Мозырский опытный лесхоз",          lat: 51.988038, lon: 28.975924, leshozkod: "312" },
      { name: "Наровлянский спецлесхоз",           lat: 51.645430, lon: 29.370087, leshozkod: "314" },
      { name: "Октябрьский лесхоз",                lat: 52.642914, lon: 28.897028, leshozkod: "316" },
      { name: "Хойникский лесхоз",                 lat: 51.968363, lon: 29.989087, leshozkod: "317" },
      { name: "Петриковский лесхоз",               lat: 52.323420, lon: 28.627900, leshozkod: "318" },
      { name: "Речицкий опытный лесхоз",           lat: 52.314620, lon: 30.365876, leshozkod: "319" },
      { name: "Рогачёвский лесхоз",                lat: 53.134019, lon: 30.176279, leshozkod: "320" },
      { name: "Светлогорский лесхоз",              lat: 52.647370, lon: 29.485577, leshozkod: "321" },
      { name: "Чечерский спецлесхоз",              lat: 53.027344, lon: 30.929600, leshozkod: "322" },
      { name: "Ветковский спецлесхоз",             lat: 52.703411, lon: 31.247569, leshozkod: "325" },
      { name: "ГЛХУ \"КОРЕНЕВСКАЯ ЭЛБ\"",         lat: 52.344268, lon: 31.123344, leshozkod: "8031" },
      // ── Гродненская область ────────────────────────────────────
      { name: "Волковысский лесхоз",               lat: 53.156378, lon: 24.279841, leshozkod: "401" },
      { name: "Гродненский лесхоз",                lat: 53.697491, lon: 23.831990, leshozkod: "402" },
      { name: "Дятловский лесхоз",                 lat: 53.430147, lon: 25.374558, leshozkod: "403" },
      { name: "Ивьевский лесхоз",                  lat: 53.998034, lon: 25.893291, leshozkod: "404" },
      { name: "Лидский лесхоз",                    lat: 53.953263, lon: 25.139867, leshozkod: "405" },
      { name: "Новогрудский лесхоз",               lat: 53.601173, lon: 26.011853, leshozkod: "406" },
      { name: "Островецкий опытный лесхоз",        lat: 54.756590, lon: 26.045132, leshozkod: "407" },
      { name: "Слонимский лесхоз",                 lat: 53.095960, lon: 25.141601, leshozkod: "408" },
      { name: "Сморгонский опытный лесхоз",        lat: 54.447205, lon: 26.167187, leshozkod: "409" },
      { name: "Щучинский лесхоз",                  lat: 53.556596, lon: 24.740409, leshozkod: "410" },
      { name: "Скидельский лесхоз",                lat: 53.659279, lon: 24.217679, leshozkod: "413" },
      { name: "ОУПП \"Гродненское Городское ЖКХ\"", lat: 53.678108, lon: 23.832911, leshozkod: "6046" },
      // ── Минская область ────────────────────────────────────────
      { name: "Березинский лесхоз",                lat: 53.838230, lon: 29.041823, leshozkod: "501" },
      { name: "Борисовский опытный лесхоз",        lat: 54.321276, lon: 28.544523, leshozkod: "502" },
      { name: "Вилейский опытный лесхоз",          lat: 54.532994, lon: 27.034443, leshozkod: "503" },
      { name: "Воложинский лесхоз",                lat: 54.042613, lon: 26.596252, leshozkod: "504" },
      { name: "Клецкий лесхоз",                    lat: 53.091423, lon: 26.636593, leshozkod: "505" },
      { name: "Копыльский опытный лесхоз",         lat: 53.133315, lon: 27.077775, leshozkod: "506" },
      { name: "Крупский лесхоз",                   lat: 54.343861, lon: 29.153292, leshozkod: "507" },
      { name: "Логойский лесхоз",                  lat: 54.375055, lon: 27.819593, leshozkod: "508" },
      { name: "Любанский лесхоз",                  lat: 52.706158, lon: 28.097323, leshozkod: "509" },
      { name: "Молодечненский лесхоз",             lat: 54.252971, lon: 26.894101, leshozkod: "511" },
      { name: "Пуховичский лесхоз",                lat: 53.485140, lon: 28.023259, leshozkod: "513" },
      { name: "Слуцкий лесхоз",                    lat: 53.091686, lon: 27.639837, leshozkod: "514" },
      { name: "Смолевичский лесхоз",               lat: 54.007151, lon: 28.141946, leshozkod: "515" },
      { name: "Старобинский лесхоз",               lat: 52.663567, lon: 27.433544, leshozkod: "516" },
      { name: "Стародорожский опытный лесхоз",     lat: 53.049176, lon: 28.238515, leshozkod: "517" },
      { name: "Столбцовский лесхоз",               lat: 53.652649, lon: 26.641908, leshozkod: "518" },
      { name: "Узденский лесхоз",                  lat: 53.446665, lon: 27.290373, leshozkod: "519" },
      { name: "Червенский лесхоз",                 lat: 53.751535, lon: 28.435773, leshozkod: "520" },
      { name: "Боровлянский спецлесхоз",           lat: 53.915988, lon: 27.574758, leshozkod: "521" },
      { name: "Минский лесхоз",                    lat: 53.768516, lon: 27.285522, leshozkod: "541" },
      { name: "ГЛХУ \"Красносельское\"",           lat: 54.228031, lon: 27.468792, leshozkod: "4042" },
      { name: "Негорельский учебно-оп. лесхоз",   lat: 53.568710, lon: 27.122517, leshozkod: "7021" },
      { name: "ГЛХУ \"ЖОРНОВСКАЯ ЭЛБ\"",          lat: 53.477477, lon: 28.579712, leshozkod: "8025" },
      { name: "КУП \"СОЛИГОРСК КОММУНСЕРВИС\"",   lat: 52.771294, lon: 27.501031, leshozkod: "6021" },
      { name: "ПКДУП \"Минское лесопарковое х-во\"", lat: 53.919284, lon: 27.593014, leshozkod: "6043" },
      // ── Могилёвская область ────────────────────────────────────
      { name: "Белыничский лесхоз",                lat: 53.997476, lon: 29.706199, leshozkod: "601" },
      { name: "Бобруйский лесхоз",                 lat: 53.178799, lon: 29.357365, leshozkod: "602" },
      { name: "Быховский лесхоз",                  lat: 53.485757, lon: 30.229371, leshozkod: "603" },
      { name: "Глусский лесхоз",                   lat: 52.889864, lon: 28.672199, leshozkod: "604" },
      { name: "Горецкий лесхоз",                   lat: 54.132414, lon: 31.205515, leshozkod: "605" },
      { name: "Кличевский лесхоз",                 lat: 53.532338, lon: 29.342342, leshozkod: "606" },
      { name: "Костюковичский лесхоз",             lat: 53.319482, lon: 32.184039, leshozkod: "607" },
      { name: "Краснопольский лесхоз",             lat: 53.306859, lon: 31.340645, leshozkod: "608" },
      { name: "Могилевский лесхоз",                lat: 53.989540, lon: 30.285209, leshozkod: "609" },
      { name: "Осиповичский опытный лесхоз",       lat: 53.328120, lon: 28.669054, leshozkod: "610" },
      { name: "Чериковский лесхоз",                lat: 53.529111, lon: 31.138602, leshozkod: "611" },
      { name: "Климовичский лесхоз",               lat: 53.652490, lon: 31.938590, leshozkod: "612" },
      { name: "Чаусский лесхоз",                   lat: 53.788658, lon: 30.869914, leshozkod: "613" }
    ];

    const _WEATHER_CODES = {
      0: "ясно",
      1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
      45: "туман", 48: "изморозь",
      51: "лёгкая морось", 53: "морось", 55: "сильная морось",
      61: "лёгкий дождь", 63: "дождь", 65: "сильный дождь",
      71: "лёгкий снег", 73: "снег", 75: "сильный снег",
      77: "снежная крупа",
      80: "небольшой ливень", 81: "ливень", 82: "сильный ливень",
      85: "снежный ливень", 86: "сильный снежный ливень",
      95: "гроза", 96: "гроза с градом", 99: "гроза с сильным градом"
    };

    const _WIND_DIRS = [
      "северный", "северо-восточный", "восточный", "юго-восточный",
      "южный", "юго-западный", "западный", "северо-западный"
    ];

    function _getWindDir(deg) {
        return _WIND_DIRS[Math.round(deg / 45) % 8];
    }

    const _weatherCache = {};
    const _WEATHER_TTL  = 60 * 60 * 1000; // 1 час

    function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** Разбирает объект current из Open-Meteo в нашу структуру. */
    function _parseCurrentWeather(c) {
        if (!c) return null;
        return {
            temperature:        Math.round(c.temperature_2m),
            windspeed:          c.windspeed_10m,
            winddirection_deg:  c.winddirection_10m,
            winddirection_text: _getWindDir(c.winddirection_10m),
            weather_code:       c.weathercode,
            weather_type:       _WEATHER_CODES[c.weathercode] ?? "неизвестно",
            updated:            c.time ? c.time.split("T")[1].slice(0, 5) : "--:--"
        };
    }

    /**
     * Одиночный fallback-запрос (используется только если батч недоступен).
     * Серверный кэш в app.py делает повторные одиночные запросы мгновенными.
     */
    async function _fetchWeatherPoint(lat, lon) {
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        const now = Date.now();
        if (_weatherCache[key] && now - _weatherCache[key].fetchedAt < _WEATHER_TTL) {
            return _weatherCache[key].data;
        }
        const url = `/api/weather?latitude=${lat}&longitude=${lon}`;
        let resp;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await _sleep(800 * attempt);
            resp = await fetch(url);
            if (resp.status !== 429) break;
        }
        if (!resp.ok) throw new Error(`weather ${resp.status}`);
        const json = await resp.json();
        const data = _parseCurrentWeather(json.current);
        if (data) _weatherCache[key] = { data, fetchedAt: now };
        return data;
    }

    /**
     * Загружает погоду для всех лесхозов через ОДИН батч-запрос к /api/weather/batch.
     * Open-Meteo поддерживает несколько координат в одном запросе →
     * 119 точек = 1 HTTP-запрос вместо 24 батчей по 300мс.
     * Серверный кэш (TTL=1ч) делает повторные открытия слоя мгновенными.
     */
    async function _fetchAllLeskhoziWeather() {
        const now = Date.now();

        // Дедупликация координат
        const seen = new Set();
        const unique = LESKHOZI_DATA.filter(l => {
            const k = `${l.lat.toFixed(4)},${l.lon.toFixed(4)}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        // Точки, которых ещё нет в браузерном кэше
        const uncached = unique.filter(l => {
            const k = `${l.lat.toFixed(4)},${l.lon.toFixed(4)}`;
            return !(_weatherCache[k] && now - _weatherCache[k].fetchedAt < _WEATHER_TTL);
        });

        if (uncached.length > 0) {
            // Разбиваем на чанки по 100 точек (лимит Open-Meteo ~1000, но страхуемся)
            const CHUNK = 100;
            for (let i = 0; i < uncached.length; i += CHUNK) {
                const chunk = uncached.slice(i, i + CHUNK);
                const lats  = chunk.map(l => l.lat).join(",");
                const lons  = chunk.map(l => l.lon).join(",");
                try {
                    const resp = await fetch(
                        `/api/weather/batch?latitudes=${lats}&longitudes=${lons}`
                    );
                    if (!resp.ok) throw new Error(`batch ${resp.status}`);
                    const items = await resp.json(); // массив [{lat,lon,current}]
                    items.forEach(item => {
                        if (!item.current) return;
                        const key = `${parseFloat(item.lat).toFixed(4)},${parseFloat(item.lon).toFixed(4)}`;
                        const data = _parseCurrentWeather(item.current);
                        if (data) _weatherCache[key] = { data, fetchedAt: now };
                    });
                } catch (err) {
                    console.warn("[weather/batch] ошибка, fallback на одиночные запросы:", err);
                    // Fallback: запрашиваем по одному с небольшой паузой
                    const FBATCH = 10;
                    for (let fi = 0; fi < chunk.length; fi += FBATCH) {
                        if (fi > 0) await _sleep(200);
                        await Promise.all(
                            chunk.slice(fi, fi + FBATCH).map(l =>
                                _fetchWeatherPoint(l.lat, l.lon).catch(() => null)
                            )
                        );
                    }
                }
            }
        }

        // Возвращаем все записи LESKHOZI_DATA с погодой из кэша
        return LESKHOZI_DATA.map(l => {
            const key = `${l.lat.toFixed(4)},${l.lon.toFixed(4)}`;
            const cached = _weatherCache[key];
            return { ...l, weather: cached ? cached.data : null };
        });
    }

    function _buildWeatherSource(leskhoziWithWeather) {
        const features = leskhoziWithWeather
            .filter(l => l.weather)
            .map(l => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [l.lon, l.lat] },
                properties: {
                    name:               l.name,
                    temperature:        l.weather.temperature,
                    windspeed:          l.weather.windspeed,
                    winddirection_deg:  l.weather.winddirection_deg,
                    winddirection_text: l.weather.winddirection_text,
                    weather_code:       l.weather.weather_code,
                    weather_type:       l.weather.weather_type,
                    updated:            l.weather.updated
                }
            }));
        return new ol.source.Vector({
            features: new ol.format.GeoJSON().readFeatures(
                { type: "FeatureCollection", features },
                { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }
            )
        });
    }

    function _weatherPointStyle(feature) {
        const temp = feature.get("temperature");
        return [
            new ol.style.Style({
                image: new ol.style.Circle({
                    radius: 9,
                    fill:   new ol.style.Fill({ color: "#2563EB" }),
                    stroke: new ol.style.Stroke({ color: "#fff", width: 1.5 })
                })
            }),
            new ol.style.Style({
                text: new ol.style.Text({
                    text:    String(temp),
                    offsetY: -16,
                    font:    "bold 11px Arial,sans-serif",
                    fill:    new ol.style.Fill({ color: "#1e3a5f" }),
                    stroke:  new ol.style.Stroke({ color: "#fff", width: 3 })
                })
            })
        ];
    }

    // Создаём слой сразу; данные подгружаются асинхронно при первом включении
    const _weatherVectorSource = new ol.source.Vector();
    const _weatherLayer = new ol.layer.Vector({
        source:  _weatherVectorSource,
        style:   _weatherPointStyle,
        title:   "Погода (лесхозы)",
        visible: false,  // выключен по умолчанию; panel-layers включит при необходимости
        zIndex:  9999    // всегда поверх всех слоёв карты (макс. zIndex в проекте — 401)
    });
    _weatherLayer._noClip = true; // не применять clip-маску лесхоза
    map.addLayer(_weatherLayer);

    // Экспортируем для panel-layers.js
    window._weatherLayer = _weatherLayer;

    async function _refreshWeatherLayer() {
        try {
            const data = await _fetchAllLeskhoziWeather();
            const src  = _buildWeatherSource(data);
            _weatherVectorSource.clear();
            _weatherVectorSource.addFeatures(src.getFeatures());
            console.log(
                `[Weather] Обновлено ${src.getFeatures().length} точек`,
                new Date().toLocaleTimeString("ru")
            );
        } catch (e) {
            console.warn("[Weather] Ошибка загрузки:", e);
        }
    }

    // Ленивая загрузка: данные запрашиваются только при первом включении слоя
    // (или при первом обращении из panel-layers.js — см. window._ensureWeatherLoaded ниже,
    // это нужно чтобы посчитать "самый холодный лесхоз" даже если сам слой точек выключен).
    function _ensureWeatherLoaded() {
        if (!_weatherLayer._dataLoaded) {
            _weatherLayer._dataLoaded = true;
            const p = _refreshWeatherLayer();
            setInterval(_refreshWeatherLayer, _WEATHER_TTL);
            return p;
        }
        return Promise.resolve();
    }

    _weatherLayer.on("change:visible", function () {
        if (_weatherLayer.getVisible()) _ensureWeatherLoaded();
    });

    // Экспорт для panel-layers.js: принудительная подгрузка данных погоды
    // независимо от видимости слоя, + доступ к готовым данным по всем лесхозам.
    window._ensureWeatherLoaded = _ensureWeatherLoaded;
    window._getLeskhoziWeatherData = () => LESKHOZI_DATA.map(l => {
        const key = `${l.lat.toFixed(4)},${l.lon.toFixed(4)}`;
        const cached = _weatherCache[key];
        return { ...l, weather: cached ? cached.data : null };
    });

    // ---- Всплывающее окно по клику на точку ----
    const _wPopupEl      = document.getElementById("weather-popup");
    const _wPopupContent = document.getElementById("weather-popup-content");
    const _wPopupClose   = document.getElementById("weather-popup-close");

    if (_wPopupEl && _wPopupContent) {
        // FIX: autoPan убран — при открытии попапа карта не должна смещаться
        // (раньше первый клик по точке всегда "уезжал" влево/вправо, чтобы
        // вписать попап в видимую область; пользователю это не нужно —
        // попап просто рисуется поверх карты на своей позиции).
        const _wOverlay = new ol.Overlay({
            element:          _wPopupEl,
            autoPan:          false
        });
        map.addOverlay(_wOverlay);

        if (_wPopupClose) {
            _wPopupClose.addEventListener("click", e => {
                e.preventDefault();
                _wOverlay.setPosition(undefined);
                _wPopupEl.style.display = "none";
            });
        }

        map.on("click", evt => {
            if (!_weatherLayer.getVisible()) return;
            const feature = map.forEachFeatureAtPixel(
                evt.pixel,
                f => f,
                { layerFilter: l => l === _weatherLayer, hitTolerance: 6 }
            );
            if (!feature) return;
            const p = feature.getProperties();
            _wPopupContent.innerHTML = `
                <table class="weather-attr-table">
                  <thead><tr><th>Ключ</th><th>Значение</th></tr></thead>
                  <tbody>
                    <tr><td>Лесхоз</td><td>${p.name}</td></tr>
                    <tr><td>Тип погоды</td><td>${p.weather_type}</td></tr>
                    <tr><td>Температура</td><td>${p.temperature} °C</td></tr>
                    <tr><td>Скорость ветра, м/с</td><td>${p.windspeed.toFixed(1)}</td></tr>
                    <tr><td>Направление ветра, градусов</td><td>${p.winddirection_deg}</td></tr>
                    <tr><td>Направление ветра</td><td>${p.winddirection_text}</td></tr>
                    <tr><td>Обновлено</td><td>${p.updated}</td></tr>
                    <tr><td>weather_code</td><td>${p.weather_code}</td></tr>
                  </tbody>
                </table>`;
            _wOverlay.setPosition(evt.coordinate);
            _wPopupEl.style.display = "block";
        });

        map.on("pointermove", evt => {
            if (!_weatherLayer.getVisible()) return;
            const hit = map.hasFeatureAtPixel(evt.pixel, {
                layerFilter: l => l === _weatherLayer,
                hitTolerance: 6
            });
            if (hit) map.getViewport().style.cursor = "pointer";
        });
    } else {
        console.warn(
            "[Weather] Элементы #weather-popup не найдены в DOM. " +
            "Убедитесь, что weather-popup HTML добавлен в index.html перед </body>."
        );
    }

}