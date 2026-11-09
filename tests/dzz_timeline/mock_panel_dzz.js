/* ТОЛЬКО ДЛЯ СТЕНДА. Имитация static/panel-dzz.js портала (исходник в комплект не входил):
 * та же разметка (.dzz-panel / #dzz-tabs2 / #dzz-body / .dzz-year-block / .dzz-sub-item / .dzz-sub-act-btn)
 * и «старое» приближение — строго по ld.bbox из window._dzzTabs (у 4114861 там bbox Минской области).
 * Разметку кнопки «Приблизить к слою» можно менять параметром страницы ?zoommark=title|datatip|tip|icon. */
(function () {
  var qs = new URLSearchParams(location.search);
  var MARK = qs.get('zoommark') || 'title';
  var base = window._dzzTabs || [];
  var uav = { id: 'uav', icon: 'fa-helicopter', label: 'БЛА', color: '#ef6c00', yearFolders: { 2026: [], 2025: [], 2024: [] } };
  var aer = { id: 'aerial', icon: 'fa-plane', label: 'Аэрофото', color: '#0277bd', yearFolders: { 2026: [], 2025: [], 2024: [] } };
  if (qs.get('demo') === 'uav') {
    uav.yearFolders[2025].push({ key: 'bundle_demo_uav_logoisk', label: 'Ортофотоплан БЛА, Логойский лесхоз (14.06.2025)', icon: 'fa-helicopter', type: 'external_bundle', subkeys: ['gs_logoisk_leshoz_cog'], bbox: [27.5, 54.0, 28.2, 54.6] });
    aer.yearFolders[2024].push({ key: 'bundle_demo_aer_slutsk', label: 'Аэрофотосъёмка, Слуцкий лесхоз (03.07.2024)', icon: 'fa-plane', type: 'external_bundle', subkeys: ['gs_slutski_leshoz_cog'], bbox: [27.0, 52.8, 27.9, 53.4] });
  }
  window._dzzAllTabs = base.concat([uav, aer]);

  function zoomBtnHtml() {
    var icon = '<i class="fa-solid fa-magnifying-glass-plus"></i>';
    if (MARK === 'datatip') return '<button class="dzz-sub-act-btn" data-tip="Приблизить к слою">' + icon + '</button>';
    if (MARK === 'tip') return '<button class="dzz-sub-act-btn">' + icon + '<span class="mib-tip">Приблизить к слою</span></button>';
    if (MARK === 'icon') return '<button class="dzz-sub-act-btn">' + icon + '</button>';
    return '<button class="dzz-sub-act-btn" title="Приблизить к слою">' + icon + '</button>';
  }
  function oldZoom(ld) {                       // как в портале: bbox → fit; без bbox → WFS (координаты считаются градусами)
    window.showToast && window.showToast('Приближение: ' + ld.label);
    var view = window.map.getView();
    if (ld.bbox) { view.fit(ol.proj.transformExtent(ld.bbox, 'EPSG:4326', 'EPSG:3857'), { padding: [40, 420, 40, 40], duration: 500 }); return; }
    var d = (window.EXTERNAL_LAYER_DEFS || []).find(function (x) { return x.key === ld.boundsKey; });
    if (!d) return;
    fetch(window.CONFIG.GEOSERVER_WMS + '?SERVICE=WFS&VERSION=1.0.0&REQUEST=GetFeature&typeName=' + encodeURIComponent(d.sublabel) + '&outputFormat=application%2Fjson&maxFeatures=1')
      .then(function (r) { return r.json(); }).then(function (fc) {
        var flat = fc.features[0].geometry.coordinates.flat(Infinity), a = [180, 90, -180, -90];
        for (var i = 0; i < flat.length; i += 2) { a[0] = Math.min(a[0], flat[i]); a[2] = Math.max(a[2], flat[i]); a[1] = Math.min(a[1], flat[i + 1]); a[3] = Math.max(a[3], flat[i + 1]); }
        view.fit(ol.proj.transformExtent(a, 'EPSG:4326', 'EPSG:3857'), { padding: [40, 420, 40, 40], duration: 500 });
      }).catch(function () {});
  }
  window.buildDZZPanel = function (container, onClose) {
    var active = localStorage.getItem('dzz_active_tab') || 'space';
    var state = (window.AppState && window.AppState.externalLayerState) || {};
    container.innerHTML = '<div id="dzz-panel" class="dzz-panel tool-ui" style="padding:12px;color:#e8f5e9;font:13px Lato,Arial,sans-serif;height:100%;overflow:auto;box-sizing:border-box">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b style="font-size:15px;color:#82e938">ДЗЗ — Снимки</b>' +
      '<button class="dzz-close" style="background:none;border:0;color:#aaa;font-size:18px;cursor:pointer">×</button></div>' +
      '<div id="dzz-tabs2" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px"></div>' +
      '<input class="dzz-search" placeholder="Номер, дата, месяц…" style="width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:8px;background:#132016;border:1px solid #2f4f33;color:#e8f5e9;border-radius:8px">' +
      '<div id="dzz-body"></div></div>';
    container.querySelector('.dzz-close').onclick = onClose;
    var tabsEl = container.querySelector('#dzz-tabs2'), body = container.querySelector('#dzz-body');
    function render() {
      tabsEl.innerHTML = ''; body.innerHTML = '';
      window._dzzAllTabs.forEach(function (tab) {
        var n = 0; Object.keys(tab.yearFolders).forEach(function (y) { n += tab.yearFolders[y].filter(function (f) { return f.key !== tab.topKey; }).length; });
        var b = document.createElement('button'); b.className = 'dzz-tab2' + (tab.id === active ? ' active' : ''); b.setAttribute('data-tab-id', tab.id);
        b.style.cssText = 'padding:4px 8px;border-radius:8px;border:1px solid #2f4f33;cursor:pointer;background:' + (tab.id === active ? '#2e4d31' : '#132016') + ';color:#e8f5e9;font-size:11px';
        b.innerHTML = tab.label.replace('<br>', ' ') + ' <span class="dzz-tab-count">' + n + '</span>';
        b.onclick = function () { active = tab.id; localStorage.setItem('dzz_active_tab', active); render(); };
        tabsEl.appendChild(b);
      });
      var tab = window._dzzAllTabs.find(function (t) { return t.id === active; }) || window._dzzAllTabs[0];
      Object.keys(tab.yearFolders).sort().reverse().forEach(function (y) {
        var folders = tab.yearFolders[y].filter(function (f) { return f.key !== tab.topKey; });
        if (!folders.length) return;
        var yb = document.createElement('div'); yb.className = 'dzz-year-block'; yb.setAttribute('data-year', y);
        yb.innerHTML = '<div class="dzz-year-row" style="display:flex;gap:6px;padding:6px 4px;cursor:pointer;font-weight:700"><i class="fa-solid fa-folder dzz-yr-icon"></i><span class="dzz-yr-name">' + y + '</span><span class="dzz-yr-cnt">' + folders.length + '</span></div>' +
          '<div class="dzz-sublayers open"></div>';
        var sub = yb.querySelector('.dzz-sublayers');
        folders.forEach(function (ld) {
          var it = document.createElement('div'); it.className = 'dzz-sub-item';
          it.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 4px';
          var on = (ld.subkeys || []).some(function (k) { return state[k]; });
          it.innerHTML = '<input type="checkbox" class="dzz-sub-cb"' + (on ? ' checked' : '') + '><i class="fa-solid ' + (ld.icon || 'fa-layer-group') + '"></i>' +
            '<span class="dzz-sub-label" style="flex:1">' + ld.label + '</span><span class="dzz-sub-actions" style="display:flex;gap:2px">' + zoomBtnHtml() +
            '<button class="dzz-sub-act-btn dzz-dl-btn" title="Скачать"><i class="fa-solid fa-download"></i></button></span>';
          it.querySelector('.dzz-sub-cb').onchange = function (e) { (ld.subkeys || []).forEach(function (k) { window.toggleExternalLayer(k, null, e.target.checked); }); };
          it.querySelectorAll('.dzz-sub-act-btn')[0].addEventListener('click', function () { oldZoom(ld); });
          it.querySelector('.dzz-dl-btn').addEventListener('click', function () { window.__dlClicked = ld.key; });
          sub.appendChild(it);
        });
        body.appendChild(yb);
      });
    }
    render();
  };
})();
