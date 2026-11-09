/* Геосервис ОДЗиМЛ v20.9 — модули оформления: ранний запуск (стоит в конце <head> всех страниц).
   Читает выбор из localStorage('gt_theme') или из адреса ?gt=<тема>|classic, ставит <html data-gt="…">
   и подключает стили темы ДО первой отрисовки (без мигания). Затем асинхронно грузит gt.js —
   окно «Оформление» (Alt+Shift+T) и «Страж контраста». Без выбранной темы вид прежний. */
(function () {
  var IDS = ["bor", "graphite", "white", "navy", "gis", "contrast", "field", "swiss", "taiga", "gov"], KEY = 'gt_theme', d = document, h = d.documentElement, id = '';
  try { id = localStorage.getItem(KEY) || ''; } catch (e) {}
  try {
    var m = /[?&]gt=([a-z]+)/.exec(location.search);
    if (m) { id = m[1]; try { localStorage.setItem(KEY, IDS.indexOf(id) >= 0 ? id : 'classic'); } catch (e) {} }
  } catch (e) {}
  if (IDS.indexOf(id) < 0) id = '';
  var me = d.currentScript, src = (me && me.src) || '/static/themes/gt-boot.js';
  var base = src.replace(/[?#].*$/, '').replace(/[^\/]*$/, ''), v = (/[?&]v=([^&#]+)/.exec(src) || [])[1], q = v ? '?v=' + v : '';
  window.GT_BOOT = { ids: IDS, base: base, q: q, theme: id };
  var html = '<link rel="stylesheet" id="gt-core-css" href="' + base + 'gt-core.css' + q + '">';
  if (id) {
    h.setAttribute('data-gt', id);
    html += '<link rel="stylesheet" id="gt-fonts-css" href="' + base + 'gt-fonts.css' + q + '">' +
            '<link rel="stylesheet" id="gt-theme-css" href="' + base + 'gt-' + id + '.css' + q + '">';
  }
  d.write(html);
  var s = d.createElement('script'); s.src = base + 'gt.js' + q; s.async = true;
  (d.head || h).appendChild(s);
})();
