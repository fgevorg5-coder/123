/* stand_menu.js — ТОЛЬКО для стенда: в рабочей копии нет sidebar_profile_menu.js (прод),
   поэтому кнопка профиля открывает/закрывает меню этим маленьким заменителем. */
(function () {
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-sf-profile-trigger]');
    var m = document.getElementById('sf-profile-menu');
    if (!m) return;
    if (t) { e.preventDefault(); var open = m.hasAttribute('hidden'); if (open) m.removeAttribute('hidden'); else m.setAttribute('hidden', ''); t.setAttribute('aria-expanded', open ? 'true' : 'false'); return; }
    if (!m.contains(e.target)) m.setAttribute('hidden', '');
  });
})();
