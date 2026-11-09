/* avatar-sync.js — Геосервис v20.9: ОДИН аватар пользователя на всех страницах.
   Источник — профиль из «Сообщений» (/api/profile/me: фото, рамка, эмодзи статуса; буква и цвет — как в messages.js).
   • Главная: элементы [data-me-avatar] (строка профиля в боковой панели) рисуются сразу из кэша
     (localStorage geo_av_me_v1), затем обновляются с сервера.
   • «Сообщения»: profile-v18.js сообщает об изменении своего аватара (GeoAvatar.fromMessages) —
     все открытые вкладки перерисовываются мгновенно (BroadcastChannel + событие storage).
   Старый «эмодзи-пикер» главной (sf_user_avatar_v2) больше не используется: он показывал 🌲 вместо фото
   и при выборе эмодзи удалял фото профиля. */
(function () {
  'use strict';
  var VER = '20.9', KEY = 'geo_av_me_v1', CH = 'geo-avatar-v1';
  var D = document, W = window;
  if (W.GeoAvatar && W.GeoAvatar.version) return;

  /* Палитра и буква — точная копия messages.js (AVATAR_PALETTE / ODZIML_PALETTE / avatarInner) */
  var PALETTE = [
    ['#e74c7a', '#f0547c', '#fff'], ['#f07d23', '#f5a623', '#fff'], ['#d4a017', '#f0c040', '#1a1000'],
    ['#1fa84a', '#3dcc6e', '#fff'], ['#17a8a8', '#2dd4d4', '#fff'], ['#1a6fe8', '#4da0f5', '#fff'],
    ['#7b3ff5', '#a86bf9', '#fff'], ['#c0392b', '#e05a4e', '#fff'], ['#2d8c5e', '#4ab890', '#fff'],
    ['#5a5a8a', '#8080b8', '#fff']
  ];
  var ODZ = ['#7c3aed', '#c026d3', '#fff'];
  var FRAMES = ['pine', 'birch', 'oak', 'fern', 'moss', 'autumn', 'frost', 'sunrise', 'mushroom', 'night', 'spruce'];

  function isOdz(org) {
    if (typeof W.isOdziml === 'function') { try { return !!W.isOdziml(org); } catch (e) {} }
    return ['odziml', 'одзимл'].indexOf(String(org || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')) !== -1;
  }
  function palette(ip, org) {
    if (isOdz(org)) return ODZ;
    var h = 0, s = ip || 'x';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return PALETTE[h % PALETTE.length];
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function letterOf(ip, name) {
    var e = lsGet('geo_avatar_emoji_' + ip);                    // старый эмодзи-аватар из «Сообщений»
    if (e) return e;
    var n = String(name || '').trim();
    return n ? n.charAt(0).toUpperCase() : '?';
  }
  function sameState(a, b) {
    if (!a || !b) return false;
    return a.ip === b.ip && a.name === b.name && a.org === b.org && a.photo === b.photo && a.frame === b.frame && a.emoji === b.emoji;
  }
  function norm(o) {
    o = o || {};
    var fr = FRAMES.indexOf(o.frame) >= 0 ? o.frame : 'none';
    return { ip: String(o.ip || ''), name: String(o.name || ''), org: String(o.org || ''), photo: String(o.photo || ''),
             frame: fr, emoji: String(o.emoji || ''), t: +o.t || Date.now() };
  }
  function readCache() { try { var o = JSON.parse(lsGet(KEY) || 'null'); return o && typeof o === 'object' ? norm(o) : null; } catch (e) { return null; } }

  var broken = {};
  var state = null;        // текущий «мой» аватар
  var targets = [];

  /* ── отрисовка одного элемента ── */
  function paint(el, st) {
    if (!el || !st) return;
    var p = palette(st.ip, st.org);
    var photo = st.photo && !broken[st.photo] ? st.photo : '';
    var letter = letterOf(st.ip, st.name);
    var sig = [st.ip, letter, p[0], photo, st.frame, st.emoji].join('|');
    if (el.getAttribute('data-gav-sig') === sig) return;
    el.setAttribute('data-gav-sig', sig);
    el.classList.add('gav');
    el.style.setProperty('background', p[0], 'important');
    el.style.setProperty('color', p[2], 'important');
    el.className = el.className.replace(/\bgav-(framed|fr-[a-z]+|photo)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    if (st.frame !== 'none') el.classList.add('gav-framed', 'gav-fr-' + st.frame);
    if (photo) el.classList.add('gav-photo');
    var h = '<span class="gav-l" aria-hidden="true"></span>';
    el.innerHTML = h;
    el.firstChild.textContent = letter;
    if (photo) {
      var im = D.createElement('img');
      im.className = 'gav-img'; im.alt = ''; im.decoding = 'async'; im.draggable = false;
      im.addEventListener('error', function () { broken[photo] = 1; el.removeAttribute('data-gav-sig'); paint(el, state || st); });
      im.src = photo;
      el.appendChild(im);
    }
    if (st.emoji) {
      var em = D.createElement('span');
      em.className = 'gav-emo'; em.setAttribute('aria-hidden', 'true'); em.textContent = st.emoji;
      el.appendChild(em);
    }
    el.setAttribute('data-gav-ver', VER);
  }
  function scan() {
    targets = Array.prototype.slice.call(D.querySelectorAll('[data-me-avatar]'));
    return targets;
  }
  function paintAll() { if (!state) return; scan().forEach(function (el) { paint(el, state); }); }

  /* ── источник «по умолчанию»: атрибуты разметки ── */
  function fromMarkup() {
    var el = D.querySelector('[data-me-avatar][data-me-ip]');
    var ip = (el && el.getAttribute('data-me-ip')) || String(W.MY_IP || '');
    if (!ip) return null;
    return norm({ ip: ip, name: (el && el.getAttribute('data-me-name')) || W.MY_NAME || '',
                  org: (el && el.getAttribute('data-me-org')) || W.MY_ORG || '' , t: 1 });
  }

  var bc = null;
  try { if ('BroadcastChannel' in W) bc = new BroadcastChannel(CH); } catch (e) { bc = null; }

  function apply(st, opts) {
    st = norm(st); opts = opts || {};
    var mine = fromMarkup();
    if (mine && st.ip && mine.ip !== st.ip) return false;     // чужой IP (другой пользователь на этом ПК)
    if (mine && !st.name) st.name = mine.name;
    if (mine && !st.org) st.org = mine.org;
    var changed = !sameState(state, st);
    state = st;
    paintAll();
    if (changed && opts.save !== false) lsSet(KEY, JSON.stringify(st));
    if (changed && opts.broadcast !== false && bc) { try { bc.postMessage({ type: 'avatar', state: st }); } catch (e) {} }
    if (changed) { try { W.dispatchEvent(new CustomEvent('geo:avatar', { detail: st })); } catch (e) {} }
    return changed;
  }

  /* ── загрузка с сервера (то же, что видит окно «Мой профиль» в «Сообщениях») ── */
  var loading = null;
  function refresh() {
    if (loading) return loading;
    var mine = fromMarkup();
    if (!mine) return Promise.resolve(null);
    loading = fetch('/api/profile/me', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        loading = null;
        if (!j || !j.ok) return null;
        var pr = j.profile || {};
        apply({ ip: j.ip || mine.ip, name: j.name || mine.name, org: j.org || mine.org,
                photo: j.photo_src || j.photo_url || '', frame: pr.frame, emoji: pr.status_emoji, t: Date.now() });
        return state;
      }, function () { loading = null; return null; });
    return loading;
  }

  /* ── вызывается из profile-v18.js на странице «Сообщения» ── */
  function fromMessages(c) {
    if (!c) return;
    var ip = String(W.MY_IP || ''); if (!ip) return;
    apply({ ip: ip, name: W.MY_NAME || '', org: W.MY_ORG || '', photo: c.photo || c.photo_src || '',
            frame: c.frame, emoji: c.emoji !== undefined ? c.emoji : c.status_emoji, t: Date.now() });
  }

  if (bc) bc.onmessage = function (e) { var m = e && e.data; if (m && m.type === 'avatar' && m.state) apply(m.state, { save: false, broadcast: false }); };
  W.addEventListener('storage', function (e) {
    if (e.key === KEY && e.newValue) { try { apply(JSON.parse(e.newValue), { save: false, broadcast: false }); } catch (x) {} }
    else if (e.key && e.key.indexOf('geo_avatar_emoji_') === 0) { if (state) { scan().forEach(function (el) { el.removeAttribute('data-gav-sig'); }); paintAll(); } }
  });

  /* Совместимость: старый пикер главной теперь открывает «Мой профиль → Рамка» в «Сообщениях» */
  function openSettings(tab) { location.href = '/messages?openProfile=1' + (tab ? '&tab=' + encodeURIComponent(tab) : ''); }
  if (!W.PV) {
    W.sfOpenPicker = function () { openSettings('frame'); };
    W.sfClosePicker = function () {};
    W.sfTab = W.sfPhotoSelected = W.sfUploadPhoto = W.sfDeletePhoto = function () {};
  }
  try { localStorage.removeItem('sf_user_avatar_v2'); } catch (e) {}

  function start() {
    var mine = fromMarkup();
    var cached = readCache();
    if (mine) {
      if (cached && cached.ip === mine.ip) {
        if (!cached.name) cached.name = mine.name;
        if (!cached.org) cached.org = mine.org;
        apply(cached, { save: false, broadcast: false });
      } else apply(mine, { save: false, broadcast: false });
    }
    // Клик по самому аватару (не по строке профиля) — сразу к настройкам профиля
    D.addEventListener('dblclick', function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-me-avatar]');
      if (t && !W.PV) { e.preventDefault(); openSettings('frame'); }
    });
    if (mine && !W.PV) {
      var go = function () { refresh(); };
      if (D.readyState === 'complete') setTimeout(go, 400); else W.addEventListener('load', function () { setTimeout(go, 600); });
      // вкладка снова видна — подтянуть изменения, сделанные на другом устройстве
      D.addEventListener('visibilitychange', function () {
        if (D.visibilityState === 'visible' && state && Date.now() - (state.t || 0) > 60000) refresh();
      });
    }
  }

  W.GeoAvatar = { version: VER, get: function () { return state; }, refresh: refresh, paint: function (el) { if (state) paint(el, state); },
                  repaint: function () { scan().forEach(function (el) { el.removeAttribute('data-gav-sig'); }); paintAll(); },
                  fromMessages: fromMessages, apply: apply, open: openSettings };
  if (D.readyState === 'loading') {
    // скрипт встроен сразу после строки профиля: рисуем немедленно, без «ёлочки» до загрузки страницы
    if (D.querySelector('[data-me-avatar]')) start(); else D.addEventListener('DOMContentLoaded', start);
  } else start();
})();
