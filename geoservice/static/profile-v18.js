/* ═══════════════════════════════════════════════════════════
   profile-v18.js — [v18] профиль «как в Telegram»
   • «Мой профиль»: фото с кадрированием (512×512 → /api/avatar/upload),
     12 «лесных» рамок, должность / телефон / о себе, статус-эмодзи со
     сроком, доступность (в сети / нет на месте / не беспокоить / невидимка),
     приватность и предпросмотр «так вас видят коллеги»;
   • имя НЕ редактируется: его назначает администратор, им же
     подписывается ЭЦП («Таксаторы печать»);
   • аватары во всём мессенджере (диалоги, чат, получатели, шапка):
     фото + рамка + эмодзи статуса; пакетно через /api/profile/cards,
     кэш 5 минут; элементы помечаются атрибутом data-av-ip;
   • карточка коллеги — по клику на аватар или имя в шапке чата.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var D = document;

  function $(sel, root) { return (root || D).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function myIp() { return String(window.MY_IP || ''); }
  function csrf() { var m = D.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') || '' : ''; }
  function errText(status, j) {
    var d = j && (j.detail || j.error || j.message);
    if (typeof d === 'string' && d) return d;
    if (status === 413) return 'Файл слишком большой';
    if (status === 401 || status === 403) return 'Нет доступа — войдите в систему';
    if (status >= 500) return 'Ошибка сервера, попробуйте позже';
    return 'Не удалось выполнить запрос';
  }
  function api(url, body) {
    var opt = { credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.headers['X-CSRFToken'] = csrf();
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || (j && j.ok === false)) { var e = new Error(errText(r.status, j)); e.status = r.status; throw e; }
        return j || {};
      });
    }, function () { throw new Error('Нет связи с сервером'); });
  }
  function isOdz(org) {
    if (typeof window.isOdziml === 'function') return window.isOdziml(org);
    return ['odziml', 'одзимл'].indexOf(String(org || '').toLowerCase().replace(/\s+/g, '')) !== -1;
  }
  function letterOf(ip, name, org) {
    try { if (typeof window.avatarInner === 'function') return String(window.avatarInner(ip, name, org) || '?'); } catch (e) {}
    return (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  }
  function styleOf(ip, org) {
    try { if (typeof window.avatarStyle === 'function') return String(window.avatarStyle(ip, org) || ''); } catch (e) {}
    return '';
  }
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseDT(s) { if (!s) return null; var d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? null : d; }
  function fmtWhen(d) {
    if (!d) return '';
    var now = new Date(), t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000);
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (days === 0) return 'сегодня в ' + hm;
    if (days === 1) return 'завтра в ' + hm;
    return d.getDate() + '\u00a0' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' в ' + hm;
  }
  function fmtSeen(s) {
    if (typeof window._fmtLastSeen === 'function') return window._fmtLastSeen(s);
    var d = parseDT(s); return d ? fmtWhen(d) : 'давно';
  }

  var FRAMES = [
    ['none', 'Без рамки'], ['pine', 'Сосновый бор'], ['birch', 'Берёзовая роща'], ['oak', 'Дубрава'],
    ['fern', 'Папоротник'], ['moss', 'Мох и лишайник'], ['autumn', 'Осенний лес'], ['frost', 'Зимний лес'],
    ['sunrise', 'Рассвет над лесом'], ['mushroom', 'Грибная поляна'], ['night', 'Ночной лес'], ['spruce', 'Ельник']
  ];
  var FRAME_IDS = FRAMES.map(function (f) { return f[0]; });
  var PRES = {
    online: ['В сети', 'Коллеги видят, что вы на связи'],
    away: ['Нет на месте', 'Отошли ненадолго'],
    busy: ['Не беспокоить', 'Заняты — ответите позже'],
    invisible: ['Невидимка', 'Для коллег — «был(а) недавно»']
  };
  // Как присутствие видят другие (шапка чата, карточка)
  var PRES_OTHER = { online: 'в сети', away: 'нет на месте', busy: 'не беспокоить', hidden: 'был(а) недавно' };
  var EMOJI = ['🌲', '🌳', '🌿', '🍃', '🍄', '🍂', '🌾', '🌻', '🦌', '🦉', '🐻', '🏕️', '🪵', '🔥', '☀️', '🌧️', '❄️', '⛈️',
    '🚗', '✈️', '🏠', '💼', '📍', '🗺️', '🛰️', '📐', '📋', '💻', '☕', '🍽️', '🤒', '🏖️', '🎉', '🎧', '📵', '⏳', '🛠️', '📚', '✅'];
  var PRESETS = [['🌲', 'На объекте, в лесу'], ['🚗', 'В дороге'], ['📋', 'На совещании'], ['☕', 'Перерыв'],
    ['🏠', 'Работаю из дома'], ['🤒', 'На больничном'], ['🏖️', 'В отпуске'], ['📵', 'Не на связи']];
  var TTLS = [['0', 'Не сбрасывать'], ['30', '30 минут'], ['60', '1 час'], ['240', '4 часа'], ['eod', 'До конца дня'], ['10080', 'Неделя']];
  var PRIV = [
    ['show_online', 'fa-solid fa-signal', 'Статус «в сети»', 'Если выключить — коллеги увидят «был(а) недавно»'],
    ['show_last_seen', 'fa-regular fa-clock', 'Время последнего визита', '«Был(а) 10 мин. назад» в чате и в карточке'],
    ['show_phone', 'fa-solid fa-phone', 'Телефон в карточке', 'Номер видят все сотрудники портала'],
    ['show_bio', 'fa-solid fa-align-left', '«О себе» в карточке', 'Текст из раздела «Профиль»']
  ];
  function ttlMinutes(v) {
    if (v === 'eod') {
      var n = new Date(), e = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 0);
      return Math.max(1, Math.round((e - n) / 60000));
    }
    return Math.max(0, parseInt(v, 10) || 0);
  }

  /* ══════════════ Аватары во всём мессенджере ══════════════ */
  var AV = { cache: {}, queue: {}, inflight: {}, broken: {}, timer: 0, TTL: 5 * 60 * 1000 };

  function avPut(ip, card) {
    card = card || {};
    AV.cache[ip] = { t: Date.now(), photo: card.photo_src || '', frame: FRAME_IDS.indexOf(card.frame) > 0 ? card.frame : 'none', emoji: card.status_emoji || '' };
  }
  function avFresh(ip) { var c = AV.cache[ip]; return !!c && (Date.now() - c.t) < AV.TTL; }
  function avRequest(ip) {
    if (!ip || AV.queue[ip] || AV.inflight[ip]) return;
    AV.queue[ip] = 1;
    if (!AV.timer) AV.timer = setTimeout(avFlush, 30);
  }
  function avFlush() {
    AV.timer = 0;
    var ips = Object.keys(AV.queue); AV.queue = {};
    while (ips.length) {
      (function (chunk) {
        chunk.forEach(function (ip) { AV.inflight[ip] = 1; });
        fetch('/api/profile/cards?' + chunk.map(function (ip) { return 'ip=' + encodeURIComponent(ip); }).join('&'), { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var cards = (j && j.cards) || {};
            chunk.forEach(function (ip) { delete AV.inflight[ip]; avPut(ip, cards[ip]); avRefreshIp(ip); if (ip === myIp()) avPublish(); });
          })
          .catch(function () {
            // сеть недоступна — повторим не раньше чем через минуту
            chunk.forEach(function (ip) { delete AV.inflight[ip]; if (!AV.cache[ip]) avPut(ip, {}); AV.cache[ip].t = Date.now() - AV.TTL + 60000; });
          });
      })(ips.splice(0, 100));
    }
  }
  function avStrip(el) {
    el.className = el.className.replace(/\bpv-(framed|fr-[a-z]+)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    $all(':scope > .pv-av-img, :scope > .pv-av-emo', el).forEach(function (n) { n.remove(); });
    el.removeAttribute('data-pv-sig');
  }
  function avDecorate(el) {
    var ip = el.getAttribute('data-av-ip');
    if (!ip) { if (el.hasAttribute('data-pv-sig')) avStrip(el); return; }
    if (!avFresh(ip)) avRequest(ip);
    var c = AV.cache[ip];
    var photo = c && c.photo && !AV.broken[c.photo] ? c.photo : '';
    var frame = c ? c.frame : 'none';
    var emoji = c && el.hasAttribute('data-av-emo') ? c.emoji : '';
    var sig = ip + '|' + photo + '|' + frame + '|' + emoji;
    var img = el.querySelector(':scope > .pv-av-img'), em = el.querySelector(':scope > .pv-av-emo');
    if (el.getAttribute('data-pv-sig') === sig && !!img === !!photo && !!em === !!emoji) return;
    el.setAttribute('data-pv-sig', sig);
    var cls = el.className.replace(/\bpv-(framed|fr-[a-z]+)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    if (frame !== 'none') cls += ' pv-framed pv-fr-' + frame;
    if (el.className !== cls) el.className = cls;
    if (photo) {
      if (!img) {
        img = D.createElement('img');
        img.className = 'pv-av-img'; img.alt = ''; img.decoding = 'async'; img.draggable = false;
        img.addEventListener('error', function () { AV.broken[img.getAttribute('src')] = 1; img.remove(); });
        el.insertBefore(img, el.firstChild);
      }
      if (img.getAttribute('src') !== photo) img.setAttribute('src', photo);
    } else if (img) img.remove();
    if (emoji) {
      if (!em) { em = D.createElement('span'); em.className = 'pv-av-emo'; em.setAttribute('aria-hidden', 'true'); el.appendChild(em); }
      if (em.textContent !== emoji) em.textContent = emoji;
    } else if (em) em.remove();
  }
  function avRefreshIp(ip) {
    $all('[data-av-ip]').forEach(function (el) {
      if (el.getAttribute('data-av-ip') === ip) { el.removeAttribute('data-pv-sig'); avDecorate(el); }
    });
  }
  function avScan(root) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('data-av-ip')) avDecorate(root);
    if (root.firstElementChild) $all('[data-av-ip]', root).forEach(avDecorate);
  }
  // [v20.9] Свой аватар из «Сообщений» — единственный источник для всех страниц (static/avatar-sync.js):
  // после загрузки с сервера и после каждого изменения в «Мой профиль» он рассылается в другие вкладки.
  function avPublish() {
    var c = AV.cache[myIp()];
    if (c && window.GeoAvatar && typeof window.GeoAvatar.fromMessages === 'function') { try { window.GeoAvatar.fromMessages(c); } catch (e) {} }
  }
  function avSetMine(patch) {
    var ip = myIp(); if (!ip) return;
    var c = AV.cache[ip] || { photo: '', frame: 'none', emoji: '' };
    avPut(ip, {
      photo_src: patch.photo_src !== undefined ? patch.photo_src : c.photo,
      frame: patch.frame !== undefined ? patch.frame : c.frame,
      status_emoji: patch.status_emoji !== undefined ? patch.status_emoji : c.emoji
    });
    avRefreshIp(ip);
    avPublish();
  }
  // Один наблюдатель на весь документ: messages.js перерисовывает списки через innerHTML
  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i], t = m.target;
      if (m.type === 'attributes') { if (t.nodeType === 1) { t.removeAttribute('data-pv-sig'); avDecorate(t); } continue; }
      if (t.nodeType === 1 && t.hasAttribute('data-av-ip')) avDecorate(t);
      for (var j = 0; j < m.addedNodes.length; j++) avScan(m.addedNodes[j]);
    }
  });
  function avStart() {
    if (!D.body) return;
    mo.observe(D.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-av-ip'] });
    avScan(D.body);
  }
  /* Нарисовать аватар целиком (окно профиля, карточка, сетка рамок) */
  function paintAv(el, o) {
    el.setAttribute('style', styleOf(o.ip, o.org));
    var cls = el.className.replace(/\bpv-(framed|fr-[a-z]+)\b/g, '').replace(/\s{2,}/g, ' ').trim();
    el.className = cls + (o.frame && o.frame !== 'none' ? ' pv-framed pv-fr-' + o.frame : '');
    var h = '<span class="pv-av-l" aria-hidden="true">' + esc(letterOf(o.ip, o.name, o.org)) + '</span>';
    var photo = o.photo && !AV.broken[o.photo] ? o.photo : '';
    if (photo) h += '<img class="pv-av-img" alt="" draggable="false" src="' + esc(photo) + '">';
    if (o.emoji) h += '<span class="pv-av-emo" aria-hidden="true">' + esc(o.emoji) + '</span>';
    el.innerHTML = h;
    var im = el.querySelector('img');
    if (im) im.addEventListener('error', function () { AV.broken[photo] = 1; im.remove(); });
  }

  /* ══════════════ Окно «Мой профиль» ══════════════ */
  var S = { me: null, f: null, base: null, tab: 'profile', ttl: null, ttlTouched: false, saving: false, loading: false,
            opener: null, seq: 0, built: false, migrated: false, closeTimer: 0 };
  var TABS = { profile: 1, frame: 1, status: 1, privacy: 1 };

  function tabBtn(id, icon, label) {
    return '<button type="button" class="pv-tab" role="tab" id="pv-tab-' + id + '" aria-controls="pv-p-' + id + '" aria-selected="false" tabindex="-1" data-tab="' + id + '">'
      + '<i class="' + icon + '" aria-hidden="true"></i><span>' + label + '</span><span class="pv-tab-dot" aria-hidden="true"></span></button>';
  }
  function roRow(icon, label, id, hint, lock) {
    return '<div class="pv-ro"><span class="pv-ro-ico"><i class="' + icon + '" aria-hidden="true"></i></span><div class="pv-ro-main">'
      + '<div class="pv-ro-label">' + label + '</div><div class="pv-ro-val" id="' + id + '">—</div>'
      + (hint ? '<div class="pv-ro-hint">' + hint + '</div>' : '') + '</div>'
      + (lock ? '<i class="fa-solid fa-lock" style="color:var(--u-muted);opacity:.7" title="Только для чтения" aria-hidden="true"></i>' : '') + '</div>';
  }
  function dialogHtml() {
    return ''
      + '<div class="pv-dlg" role="dialog" aria-modal="true" aria-labelledby="pv-name" tabindex="-1">'
      + '<header class="pv-hero" id="pv-hero" data-frame="none">'
      +   '<div class="pv-hero-top"><h2 class="pv-hero-title">Мой профиль</h2>'
      +   '<button type="button" class="pv-x" data-pv="close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>'
      +   '<div class="pv-hero-avwrap" id="pv-drop"><div class="pv-av pv-hero-av" id="pv-hero-av"></div>'
      +   '<button type="button" class="pv-cam" data-pv="photo" id="pv-cam" title="Загрузить фото" aria-label="Загрузить фото"><i class="fa-solid fa-camera"></i></button></div>'
      +   '<div class="pv-hero-name" id="pv-name"></div>'
      +   '<div class="pv-hero-sub"><span class="pv-pres"><span class="pv-dot" id="pv-hero-dot"></span><span id="pv-hero-pres"></span></span>'
      +   '<span class="pv-note" id="pv-hero-note" hidden></span></div>'
      + '</header>'
      + '<nav class="pv-tabs" role="tablist" aria-label="Разделы профиля">'
      +   tabBtn('profile', 'fa-regular fa-id-card', 'Профиль') + tabBtn('frame', 'fa-solid fa-leaf', 'Фото и рамка')
      +   tabBtn('status', 'fa-regular fa-face-smile', 'Статус') + tabBtn('privacy', 'fa-solid fa-shield-halved', 'Приватность')
      + '</nav>'
      + '<div class="pv-body" id="pv-body">'
      // ── Профиль
      + '<section class="pv-panel" role="tabpanel" id="pv-p-profile" aria-labelledby="pv-tab-profile" tabindex="-1">'
      +   '<div class="pv-migr" id="pv-migr" hidden><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><div>Перенесли данные из прежней версии профиля — она хранила их только в этом браузере. Проверьте и нажмите «Сохранить».</div></div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Работа и контакты</div>'
      +     '<div class="pv-grid2">'
      +       '<div class="v18-field pv-fld"><span><label for="pv-job">Должность</label></span><input class="v18-inp" id="pv-job" maxlength="80" autocomplete="organization-title" placeholder="Например: инженер-таксатор">'
      +         '<div class="pv-fld-foot"><em></em><span class="pv-count" data-for="pv-job"></span></div></div>'
      +       '<div class="v18-field pv-fld"><span><label for="pv-phone">Телефон</label></span><input class="v18-inp" id="pv-phone" maxlength="30" inputmode="tel" autocomplete="tel" placeholder="+375 (29) 000-00-00" aria-describedby="pv-phone-err">'
      +         '<div class="pv-fld-foot"><em class="pv-err" id="pv-phone-err"></em></div></div>'
      +     '</div>'
      +     '<div class="v18-field pv-fld"><span><label for="pv-bio">О себе</label><em>— видно коллегам в карточке</em></span>'
      +       '<textarea class="v18-inp" id="pv-bio" maxlength="300" rows="3" placeholder="Чем занимаетесь, по каким вопросам к вам обращаться"></textarea>'
      +       '<div class="pv-fld-foot"><em></em><span class="pv-count" data-for="pv-bio"></span></div></div>'
      +   '</div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Назначает администратор</div>'
      +     roRow('fa-solid fa-signature', 'Имя', 'pv-ro-name', 'Имя меняет только администратор: оно же стоит в подписи ЭЦП и в очереди «Таксаторы печать».', true)
      +     '<div class="pv-grid2" style="margin-top:10px">' + roRow('fa-solid fa-sitemap', 'Отдел', 'pv-ro-org', '', false)
      +     roRow('fa-solid fa-network-wired', 'Рабочее место (IP)', 'pv-ro-ip', '', false).replace('class="pv-ro"', 'class="pv-ro" style="margin-top:0"') + '</div>'
      +   '</div>'
      + '</section>'
      // ── Фото и рамка
      + '<section class="pv-panel" role="tabpanel" id="pv-p-frame" aria-labelledby="pv-tab-frame" tabindex="-1" hidden>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Фото</div>'
      +     '<div class="pv-photo-row"><div class="pv-av" id="pv-photo-mini"></div>'
      +     '<div class="pv-photo-txt"><b id="pv-photo-state">Фото не загружено</b>JPG, PNG или WebP. Перед загрузкой фото можно сдвинуть и приблизить.</div>'
      +     '<div class="pv-photo-btns"><button type="button" class="v18-btn sm pri" data-pv="photo"><i class="fa-solid fa-camera" aria-hidden="true"></i> <span id="pv-photo-btn-l">Загрузить</span></button>'
      +     '<button type="button" class="v18-btn sm ghost" data-pv="photo-del" id="pv-photo-del"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Удалить</button></div></div>'
      +   '</div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Лесная рамка</div>'
      +     '<div class="pv-frames" role="radiogroup" aria-label="Рамка аватара" id="pv-frames"></div>'
      +   '</div>'
      + '</section>'
      // ── Статус
      + '<section class="pv-panel" role="tabpanel" id="pv-p-status" aria-labelledby="pv-tab-status" tabindex="-1" hidden>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Доступность</div><div class="pv-pres-grid" role="radiogroup" aria-label="Доступность" id="pv-pres"></div></div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Статус</div>'
      +     '<div class="pv-st-row"><button type="button" class="pv-emo-btn" id="pv-emo-btn" aria-expanded="false" aria-controls="pv-emo-grid" title="Выбрать эмодзи" aria-label="Выбрать эмодзи">🙂</button>'
      +     '<input class="v18-inp" id="pv-st-text" maxlength="80" placeholder="Например: на объекте до 15:00" aria-label="Текст статуса">'
      +     '<button type="button" class="v18-icon" id="pv-st-clear" data-pv="st-clear" title="Очистить статус" aria-label="Очистить статус"><i class="fa-solid fa-xmark"></i></button></div>'
      +     '<div class="pv-fld-foot"><em>Виден под вашим именем в чате и в карточке</em><span class="pv-count" data-for="pv-st-text"></span></div>'
      +     '<div class="pv-emo-grid" id="pv-emo-grid" role="group" aria-label="Эмодзи статуса" hidden></div>'
      +   '</div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Быстрый выбор</div><div class="pv-chips" id="pv-presets"></div></div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Сбросить статус</div><div class="pv-chips" role="radiogroup" aria-label="Когда сбросить статус" id="pv-ttl"></div><div class="pv-until" id="pv-until"></div></div>'
      + '</section>'
      // ── Приватность
      + '<section class="pv-panel" role="tabpanel" id="pv-p-privacy" aria-labelledby="pv-tab-privacy" tabindex="-1" hidden>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Кто что видит</div><div id="pv-priv"></div></div>'
      +   '<div class="pv-sec"><div class="pv-sec-t">Так вас видят коллеги</div>'
      +     '<div class="pv-seen"><div class="pv-av" id="pv-seen-av"></div><div class="pv-seen-main"><div class="pv-seen-name" id="pv-seen-name"></div><div class="pv-seen-line" id="pv-seen-lines"></div></div></div>'
      +   '</div>'
      + '</section>'
      + '</div>'
      + '<footer class="pv-foot"><span class="pv-st" id="pv-st" role="status" aria-live="polite"></span>'
      +   '<button type="button" class="v18-btn ghost" data-pv="close">Отмена</button>'
      +   '<button type="button" class="v18-btn pri" id="pv-save" data-pv="save"><i class="fa-solid fa-check" aria-hidden="true"></i> <span>Сохранить</span></button></footer>'
      // ── Кадрирование
      + '<div class="pv-crop" id="pv-crop" role="dialog" aria-modal="true" aria-labelledby="pv-crop-t" hidden>'
      +   '<div class="pv-crop-head"><button type="button" class="v18-icon" data-pv="crop-cancel" aria-label="Назад"><i class="fa-solid fa-arrow-left"></i></button><h3 id="pv-crop-t">Фото профиля</h3></div>'
      +   '<div class="pv-crop-body"><div class="pv-crop-hint">Перетащите фото и приблизьте, чтобы лицо было в круге</div>'
      +     '<div class="pv-crop-stage" id="pv-crop-stage" tabindex="0" role="img" aria-label="Кадрирование: стрелки — сдвиг, плюс и минус — масштаб, R — поворот"><canvas id="pv-crop-cv"></canvas><div class="pv-crop-mask"></div></div>'
      +     '<div class="pv-crop-tools"><button type="button" class="v18-icon" data-pv="zoom-out" aria-label="Отдалить"><i class="fa-solid fa-magnifying-glass-minus"></i></button>'
      +     '<input type="range" id="pv-zoom" min="1" max="4" step="0.01" value="1" aria-label="Масштаб">'
      +     '<button type="button" class="v18-icon" data-pv="zoom-in" aria-label="Приблизить"><i class="fa-solid fa-magnifying-glass-plus"></i></button>'
      +     '<button type="button" class="v18-icon" data-pv="rotate" title="Повернуть на 90°" aria-label="Повернуть на 90°"><i class="fa-solid fa-rotate-right"></i></button></div>'
      +     '<div class="pv-crop-prev" aria-hidden="true"><span class="pv-crop-prev-t">Так будет выглядеть</span>'
      +       '<figure><span class="pv-cpv" style="--s:72px"><canvas></canvas></span><figcaption>Карточка</figcaption></figure>'
      +       '<figure><span class="pv-cpv" style="--s:46px"><canvas></canvas></span><figcaption>Чат</figcaption></figure>'
      +       '<figure><span class="pv-cpv" style="--s:32px"><canvas></canvas></span><figcaption>Сообщение</figcaption></figure></div>'
      +   '</div>'
      +   '<div class="pv-crop-foot"><span class="pv-st" id="pv-crop-st" role="status" aria-live="polite"></span>'
      +   '<button type="button" class="v18-btn ghost" data-pv="crop-cancel">Отмена</button>'
      +   '<button type="button" class="v18-btn pri" id="pv-crop-ok" data-pv="crop-ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Готово</button></div>'
      + '</div>'
      // ── Подтверждение, тост, выбор файла
      + '<div class="pv-cf" id="pv-cf" hidden><div class="pv-cf-box" role="alertdialog" aria-modal="true" aria-labelledby="pv-cf-t" aria-describedby="pv-cf-d">'
      +   '<h4 id="pv-cf-t"></h4><p id="pv-cf-d"></p><div class="pv-cf-btns"><button type="button" class="v18-btn ghost" id="pv-cf-no"></button><button type="button" class="v18-btn pri" id="pv-cf-yes"></button></div></div></div>'
      + '<div class="pv-toast" id="pv-toast" role="status" aria-live="polite"></div>'
      + '<input type="file" id="pv-file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" hidden>'
      + '</div>';
  }

  function build() {
    if (S.built) return;
    var ov = D.getElementById('profile-modal-overlay');
    if (!ov) { ov = D.createElement('div'); ov.id = 'profile-modal-overlay'; D.body.appendChild(ov); }
    ov.className = 'pv-ov v18ui';
    ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = dialogHtml();
    $('#pv-frames').innerHTML = FRAMES.map(function (f) {
      return '<button type="button" class="pv-frame-opt" role="radio" aria-checked="false" tabindex="-1" data-frame="' + f[0] + '">'
        + '<span class="pv-chk" aria-hidden="true"><i class="fa-solid fa-check"></i></span><span class="pv-av" aria-hidden="true"></span><span>' + f[1] + '</span></button>';
    }).join('');
    $('#pv-pres').innerHTML = Object.keys(PRES).map(function (k) {
      return '<button type="button" class="pv-pres-opt" role="radio" aria-checked="false" tabindex="-1" data-pres="' + k + '">'
        + '<span class="pv-dot ' + k + '" aria-hidden="true"></span><span><b>' + PRES[k][0] + '</b><span>' + PRES[k][1] + '</span></span></button>';
    }).join('');
    $('#pv-emo-grid').innerHTML = '<button type="button" class="pv-emo none" data-emo="" aria-pressed="false" title="Без эмодзи">нет</button>'
      + EMOJI.map(function (e) { return '<button type="button" class="pv-emo" data-emo="' + e + '" aria-pressed="false" aria-label="' + e + '">' + e + '</button>'; }).join('');
    $('#pv-presets').innerHTML = PRESETS.map(function (p, i) {
      return '<button type="button" class="pv-chip" data-preset="' + i + '" aria-pressed="false"><span aria-hidden="true">' + p[0] + '</span>' + esc(p[1]) + '</button>';
    }).join('');
    $('#pv-ttl').innerHTML = TTLS.map(function (t) {
      return '<button type="button" class="pv-chip" role="radio" aria-checked="false" tabindex="-1" data-ttl="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
    $('#pv-priv').innerHTML = PRIV.map(function (p) {
      return '<label class="pv-sw-row" data-priv-row="' + p[0] + '"><span class="pv-sw-ico"><i class="' + p[1] + '" aria-hidden="true"></i></span>'
        + '<span class="pv-sw-txt"><b>' + p[2] + '</b><span data-priv-hint="' + p[0] + '">' + p[3] + '</span></span>'
        + '<span class="pv-switch"><input type="checkbox" role="switch" data-priv="' + p[0] + '"><i aria-hidden="true"></i></span></label>';
    }).join('');
    bindDialog(ov);
    S.built = true;
  }

  /* ── состояние формы ── */
  function norm(p) {
    p = p || {};
    var pr = p.privacy || {};
    return {
      job_title: p.job_title || '', phone: p.phone || '', bio: p.bio || '',
      status_text: p.status_text || '', status_emoji: p.status_emoji || '',
      my_status: PRES[p.my_status] ? p.my_status : 'online',
      frame: FRAME_IDS.indexOf(p.frame) >= 0 ? p.frame : 'none',
      privacy: { show_online: pr.show_online !== false, show_last_seen: pr.show_last_seen !== false,
                 show_phone: pr.show_phone !== false, show_bio: pr.show_bio !== false }
    };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var GROUPS = {
    profile: ['job_title', 'phone', 'bio'], frame: ['frame'], status: ['my_status', 'status_text', 'status_emoji'],
    privacy: ['privacy']
  };
  function groupDirty(g) {
    if (!S.f || !S.base) return false;
    var d = GROUPS[g].some(function (k) { return JSON.stringify(S.f[k]) !== JSON.stringify(S.base[k]); });
    return d || (g === 'status' && S.ttlTouched);
  }
  function isDirty() { return Object.keys(GROUPS).some(groupDirty); }
  function photoSrc() { return S.me ? (S.me.photo_src || '') : ''; }
  function meName() { return (S.me && S.me.name) || window.MY_NAME || 'Пользователь'; }
  function meOrg() { return (S.me && S.me.org) || window.MY_ORG || ''; }
  function phoneOk(v) { return !v || /^[0-9+()\-\s.]{3,30}$/.test(v); }

  function legacyKey() { return 'geo_profile_' + myIp(); }
  function legacyRead() { try { var r = localStorage.getItem(legacyKey()); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function legacyDrop() { try { localStorage.removeItem(legacyKey()); } catch (e) {} }
  function legacyApply() {
    // Старый профиль жил только в localStorage (до v18 на сервер не сохранялся).
    S.migrated = false;
    var L = legacyRead();
    if (!L) return;
    if (S.me && S.me.updated_at) { legacyDrop(); return; }
    var f = S.f, used = false;
    if (L.jobTitle && !f.job_title) { f.job_title = String(L.jobTitle).slice(0, 80); used = true; }
    if (L.phone && !f.phone && phoneOk(String(L.phone))) { f.phone = String(L.phone).slice(0, 30); used = true; }
    if (L.statusText && !f.status_text) { f.status_text = String(L.statusText).slice(0, 80); used = true; }
    if (L.myStatus && PRES[L.myStatus] && L.myStatus !== f.my_status) { f.my_status = L.myStatus; used = true; }
    if (L.privacy) {
      if (L.privacy.showOnline === false) { f.privacy.show_online = false; used = true; }
      if (L.privacy.showLastSeen === false) { f.privacy.show_last_seen = false; used = true; }
    }
    S.migrated = used;
    if (!used) legacyDrop();
  }

  /* ── отрисовка ── */
  function setTab(name, focus) {
    if (!TABS[name]) name = 'profile';
    S.tab = name;
    $all('.pv-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      if (on && b.parentNode.scrollWidth > b.parentNode.clientWidth) {   // узкий экран: активная вкладка всегда видна
        var p = b.parentNode, l = b.offsetLeft - p.offsetLeft, r = l + b.offsetWidth;
        if (l < p.scrollLeft) p.scrollLeft = l - 8; else if (r > p.scrollLeft + p.clientWidth) p.scrollLeft = r - p.clientWidth + 8;
      }
    });
    $all('.pv-panel').forEach(function (p) { p.hidden = p.id !== 'pv-p-' + name; });
    var body = $('#pv-body'); if (body) body.scrollTop = 0;
    if (name !== 'status') emoGrid(false);
    try { if (typeof window.geoSaveModalState === 'function') window.geoSaveModalState({ modal: 'profile', tab: name }); } catch (e) {}
  }
  function renderHero() {
    var f = S.f || norm({});
    $('#pv-hero').setAttribute('data-frame', f.frame);
    paintAv($('#pv-hero-av'), { ip: myIp(), name: meName(), org: meOrg(), photo: photoSrc(), frame: f.frame, emoji: f.status_emoji });
    $('#pv-name').innerHTML = esc(meName()) + (isOdz(meOrg()) ? '<span class="pv-star" title="Отдел ОДЗиМЛ" aria-label="Отдел ОДЗиМЛ">★</span>' : '');
    $('#pv-hero-dot').className = 'pv-dot ' + f.my_status;
    $('#pv-hero-pres').textContent = PRES[f.my_status][0];
    var note = $('#pv-hero-note'), txt = (f.status_emoji ? f.status_emoji + ' ' : '') + f.status_text;
    note.textContent = txt.trim(); note.hidden = !txt.trim(); note.title = txt.trim();
  }
  function count(id) {
    var inp = D.getElementById(id), c = $('.pv-count[data-for="' + id + '"]');
    if (!inp || !c) return;
    var max = +inp.getAttribute('maxlength') || 0, n = inp.value.length;
    c.textContent = n ? n + ' / ' + max : '';
    c.classList.toggle('warn', max && n > max * 0.9);
  }
  function renderProfile() {
    var f = S.f;
    $('#pv-job').value = f.job_title; $('#pv-phone').value = f.phone; $('#pv-bio').value = f.bio;
    ['pv-job', 'pv-bio'].forEach(count);
    validatePhone(false);
    $('#pv-ro-name').textContent = meName();
    $('#pv-ro-org').textContent = meOrg() || 'Не указан';
    $('#pv-ro-ip').textContent = (S.me && S.me.ip) || myIp() || '—';
    $('#pv-migr').hidden = !S.migrated;
  }
  function renderFrames() {
    var f = S.f, ph = photoSrc();
    paintAv($('#pv-photo-mini'), { ip: myIp(), name: meName(), org: meOrg(), photo: ph, frame: f.frame });
    $('#pv-photo-state').textContent = ph ? 'Фото загружено' : 'Фото не загружено';
    $('#pv-photo-btn-l').textContent = ph ? 'Заменить' : 'Загрузить';
    $('#pv-photo-del').hidden = !ph;
    $('#pv-cam').setAttribute('aria-label', ph ? 'Заменить фото' : 'Загрузить фото');
    $('#pv-cam').title = ph ? 'Заменить фото' : 'Загрузить фото';
    $all('.pv-frame-opt').forEach(function (b) {
      var id = b.getAttribute('data-frame'), on = id === f.frame;
      b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      paintAv(b.querySelector('.pv-av'), { ip: myIp(), name: meName(), org: meOrg(), photo: ph, frame: id });
    });
  }
  function untilText() {
    var f = S.f;
    if (!f.status_text && !f.status_emoji) return '';
    if (S.ttlTouched) {
      var m = ttlMinutes(S.ttl);
      return m ? 'Статус сбросится ' + fmtWhen(new Date(Date.now() + m * 60000)) : 'Статус не будет сброшен автоматически';
    }
    var u = S.me && S.me.profile && S.me.profile.status_until && (S.base.status_text || S.base.status_emoji) ? parseDT(S.me.profile.status_until) : null;
    return u ? 'Статус сбросится ' + fmtWhen(u) : 'Статус не будет сброшен автоматически';
  }
  function renderStatus() {
    var f = S.f;
    $all('.pv-pres-opt').forEach(function (b) {
      var on = b.getAttribute('data-pres') === f.my_status;
      b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
    });
    var t = $('#pv-st-text'); if (t.value !== f.status_text) t.value = f.status_text;
    count('pv-st-text');
    var eb = $('#pv-emo-btn'); eb.textContent = f.status_emoji || '🙂'; eb.style.opacity = f.status_emoji ? '1' : '.55';
    $all('.pv-emo').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-emo') === f.status_emoji ? 'true' : 'false'); });
    $all('#pv-presets .pv-chip').forEach(function (b) {
      var p = PRESETS[+b.getAttribute('data-preset')];
      b.setAttribute('aria-pressed', p[0] === f.status_emoji && p[1] === f.status_text ? 'true' : 'false');
    });
    var sel = S.ttlTouched ? String(S.ttl) : (S.me && S.me.profile && S.me.profile.status_until ? '' : '0');
    var hasSel = false;
    $all('#pv-ttl .pv-chip').forEach(function (b) {
      var on = b.getAttribute('data-ttl') === sel; hasSel = hasSel || on;
      b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
    });
    if (!hasSel) { var first = $('#pv-ttl .pv-chip'); if (first) first.tabIndex = 0; }
    $('#pv-st-clear').hidden = !(f.status_text || f.status_emoji);
    $('#pv-until').textContent = untilText();
  }
  function renderPrivacy() {
    var f = S.f, hiddenAll = f.my_status === 'invisible' || !f.privacy.show_online;
    $all('[data-priv]').forEach(function (cb) { cb.checked = !!f.privacy[cb.getAttribute('data-priv')]; });
    var row = $('[data-priv-row="show_last_seen"]'), hint = $('[data-priv-hint="show_last_seen"]');
    row.style.opacity = hiddenAll ? '.55' : '';
    hint.textContent = hiddenAll ? (f.my_status === 'invisible' ? 'Сейчас вы «невидимка» — время визита скрыто' : 'Скрыто вместе со статусом «в сети»') : PRIV[1][3];
    renderSeen();
  }
  function seenPresence() {
    var f = S.f;
    if (f.my_status === 'invisible' || !f.privacy.show_online) return ['hidden', 'был(а) недавно'];
    return [f.my_status, PRES_OTHER[f.my_status] || 'в сети'];
  }
  function renderSeen() {
    var f = S.f, p = seenPresence(), L = [];
    paintAv($('#pv-seen-av'), { ip: myIp(), name: meName(), org: meOrg(), photo: photoSrc(), frame: f.frame });
    $('#pv-seen-name').textContent = meName();
    L.push('<span class="pv-pres"><span class="pv-dot ' + p[0] + '"></span>' + esc(p[1]) + '</span>');
    var st = ((f.status_emoji ? f.status_emoji + ' ' : '') + f.status_text).trim();
    if (st) L.push(esc(st));
    if (f.job_title) L.push('<i class="fa-solid fa-briefcase" aria-hidden="true"></i>' + esc(f.job_title));
    if (f.phone) L.push(f.privacy.show_phone ? '<i class="fa-solid fa-phone" aria-hidden="true"></i>' + esc(f.phone) : '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>телефон скрыт');
    if (f.bio) L.push(f.privacy.show_bio ? '<i class="fa-solid fa-align-left" aria-hidden="true"></i>' + esc(f.bio.length > 110 ? f.bio.slice(0, 110) + '…' : f.bio) : '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>«о себе» скрыто');
    $('#pv-seen-lines').innerHTML = L.join('<br>');
  }
  function renderDirty() {
    var dirty = isDirty();
    $all('.pv-tab').forEach(function (b) { b.classList.toggle('dirty', groupDirty(b.getAttribute('data-tab'))); });
    var bad = !phoneOk(S.f ? S.f.phone.trim() : '');
    var btn = $('#pv-save');
    btn.disabled = S.saving || S.loading || !dirty || bad;
    if (!S.saving) {
      var st = $('#pv-st');
      if (st.getAttribute('data-sticky') !== '1') {
        st.className = 'pv-st' + (dirty ? ' warn' : '');
        st.textContent = S.loading ? 'Загрузка профиля…' : (bad ? 'Проверьте телефон' : (dirty ? 'Есть несохранённые изменения' : ''));
        if (bad) st.className = 'pv-st err';
      }
    }
  }
  function renderAll() {
    if (!S.f) S.f = norm({});
    renderHero(); renderProfile(); renderFrames(); renderStatus(); renderPrivacy(); renderDirty();
  }
  function status(text, cls, sticky) {
    var st = $('#pv-st'); if (!st) return;
    st.className = 'pv-st' + (cls ? ' ' + cls : '') + (text ? ' show-m' : '');
    st.textContent = text || '';
    if (sticky) st.setAttribute('data-sticky', '1'); else st.removeAttribute('data-sticky');
  }
  function validatePhone(show) {
    var v = $('#pv-phone').value.trim(), ok = phoneOk(v), e = $('#pv-phone-err');
    $('#pv-phone').classList.toggle('pv-bad', !ok);
    $('#pv-phone').setAttribute('aria-invalid', ok ? 'false' : 'true');
    e.textContent = ok ? '' : 'Только цифры, пробелы, «+», «-», скобки';
    return ok;
  }
  var toastTimer = 0;
  function toast(text, err) {
    var t = $('#pv-toast'); if (!t) return;
    t.textContent = text; t.className = 'pv-toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'pv-toast' + (err ? ' err' : ''); }, Math.min(6000, 1800 + text.length * 45));
  }
  function emoGrid(open) {
    var g = $('#pv-emo-grid'), b = $('#pv-emo-btn'); if (!g) return;
    if (open === undefined) open = g.hidden;
    g.hidden = !open; b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ── подтверждение внутри окна ── */
  var CF = { resolve: null, back: null };
  function confirmBox(o) {
    return new Promise(function (resolve) {
      var box = $('#pv-cf');
      $('#pv-cf-t').textContent = o.title; $('#pv-cf-d').textContent = o.text || '';
      var yes = $('#pv-cf-yes'), no = $('#pv-cf-no');
      yes.textContent = o.yes; yes.className = 'v18-btn ' + (o.danger ? 'danger' : 'pri');
      no.textContent = o.no;
      CF.back = D.activeElement; CF.resolve = resolve;
      box.hidden = false;
      setTimeout(function () { (o.focusNo ? no : yes).focus(); }, 0);
    });
  }
  function cfDone(v) {
    var box = $('#pv-cf'); if (!box || box.hidden) return;
    box.hidden = true;
    var r = CF.resolve; CF.resolve = null;
    var back = CF.back; CF.back = null;
    if (back && back.focus && D.contains(back) && back.getClientRects().length) { try { back.focus(); } catch (e) {} }
    else { var dlg = $('.pv-dlg'); if (dlg) dlg.focus(); }
    if (r) r(v);
  }

  /* ── открыть / закрыть / сохранить ── */
  function isOpen() { var ov = D.getElementById('profile-modal-overlay'); return !!(ov && ov.classList.contains('open')); }
  function openProfileModal(tab) {
    build();
    clearTimeout(S.closeTimer);
    var ov = D.getElementById('profile-modal-overlay');
    if (!isOpen()) S.opener = D.activeElement;
    ov.classList.add('open'); ov.setAttribute('aria-hidden', 'false');
    $('#pv-crop').hidden = true; $('#pv-cf').hidden = true;
    S.loading = true; S.ttl = null; S.ttlTouched = false;
    if (!S.me) { S.f = norm({}); S.base = clone(S.f); }
    else { S.base = norm(S.me.profile); S.f = clone(S.base); }
    setTab(typeof tab === 'string' ? tab : 'profile', false);
    status('', '');
    renderAll();
    setTimeout(function () { var d = $('.pv-dlg', ov); if (d && !d.contains(D.activeElement)) d.focus(); }, 30);
    var seq = ++S.seq;
    api('/api/profile/me').then(function (j) {
      if (seq !== S.seq) return;
      S.me = j; S.loading = false;
      S.base = norm(j.profile); S.f = clone(S.base); S.ttl = null; S.ttlTouched = false;
      legacyApply();
      avSetMine({ photo_src: j.photo_src || '', frame: S.base.frame, status_emoji: S.base.status_emoji });
      renderAll();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.loading = false; renderAll();
      $('#pv-save').disabled = true;
      status('Не удалось загрузить профиль: ' + e.message, 'err', true);
    });
  }
  function doClose() {
    var ov = D.getElementById('profile-modal-overlay'); if (!ov) return;
    ov.classList.remove('open'); ov.setAttribute('aria-hidden', 'true');
    cropClose(true); emoGrid(false);
    S.seq++;
    try { if (typeof window.geoClearModalState === 'function') window.geoClearModalState('profile'); } catch (e) {}
    var o = S.opener; S.opener = null;
    if (o && o.focus && D.contains(o)) { try { o.focus(); } catch (e) {} }
  }
  function closeProfileModal(force) {
    if (!isOpen()) return;
    if (force !== true && !S.saving && !S.loading && isDirty()) {
      confirmBox({ title: 'Сохранить изменения?', text: 'Вы изменили профиль, но ещё не сохранили его.', yes: 'Сохранить', no: 'Не сохранять' })
        .then(function (r) { if (r === 'yes') saveProfile(true); else if (r === 'no') doClose(); });
      return;
    }
    doClose();
  }
  function saveProfile(closeAfter) {
    if (!S.built || !S.f || S.saving || S.loading) return;
    var f = S.f;
    f.job_title = f.job_title.trim(); f.phone = f.phone.trim(); f.bio = f.bio.trim(); f.status_text = f.status_text.trim();
    if (!validatePhone(true)) { setTab('profile'); $('#pv-phone').focus(); renderDirty(); return; }
    var body = { job_title: f.job_title, phone: f.phone, bio: f.bio, status_text: f.status_text, status_emoji: f.status_emoji,
                 my_status: f.my_status, frame: f.frame, privacy: clone(f.privacy) };
    if (S.ttlTouched) body.status_ttl = ttlMinutes(S.ttl);
    else if (!f.status_text && !f.status_emoji) body.status_ttl = 0;
    S.saving = true;
    var btn = $('#pv-save'); btn.disabled = true; btn.lastElementChild.textContent = 'Сохраняем…';
    status('', '');
    return api('/api/profile/save', body).then(function (j) {
      if (S.me) { S.me.profile = j.profile; S.me.updated_at = j.updated_at; if (j.photo_src !== undefined) S.me.photo_src = j.photo_src; }
      S.base = norm(j.profile); S.f = clone(S.base); S.ttl = null; S.ttlTouched = false;
      if (S.migrated) { S.migrated = false; }
      legacyDrop();
      avSetMine({ frame: S.base.frame, status_emoji: S.base.status_emoji });
      try { if (window.currentPeer && typeof window.updateOnlineStatus === 'function') window.updateOnlineStatus(window.currentPeer); } catch (e) {}
      S.saving = false;
      renderAll();
      status('✓ Профиль сохранён', 'ok', true);
      toast('Профиль сохранён');
      if (closeAfter !== false) S.closeTimer = setTimeout(function () { if (!isDirty()) doClose(); }, 700);
    }).catch(function (e) {
      S.saving = false; renderDirty();
      status(e.message || 'Не удалось сохранить профиль', 'err', true);
      toast(e.message || 'Не удалось сохранить профиль', true);
    }).then(function () { btn.lastElementChild.textContent = 'Сохранить'; renderDirty(); });
  }
  function changed(what) {
    if (what !== 'quiet') { var st = $('#pv-st'); if (st) st.removeAttribute('data-sticky'); }
    clearTimeout(S.closeTimer);
    renderHero(); renderDirty();
  }

  /* ── фото: выбор, кадрирование, загрузка, удаление ── */
  var CR = { img: null, url: '', z: 1, x: 0, y: 0, rot: 0, size: 300, ptrs: {}, pinch: null, busy: false };
  function pickPhoto() { var inp = $('#pv-file'); if (!inp) return; inp.value = ''; inp.click(); }
  function takeFile(file) {
    if (!file) return;
    if (!/^image\//i.test(file.type || '')) { toast('Выберите изображение: JPG, PNG или WebP', true); return; }
    if (file.size > 25 * 1024 * 1024) { toast('Файл больше 25 МБ — выберите фото поменьше', true); return; }
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      if (img.naturalWidth < 64 || img.naturalHeight < 64) { URL.revokeObjectURL(url); toast('Фото слишком маленькое — нужно хотя бы 64×64 пикселя', true); return; }
      cropOpen(img, url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Не удалось открыть изображение. Подойдут JPG, PNG или WebP', true); };
    img.src = url;
  }
  function cropOpen(img, url) {
    if (CR.url && CR.url !== url) URL.revokeObjectURL(CR.url);
    CR.img = img; CR.url = url; CR.z = 1; CR.x = 0; CR.y = 0; CR.rot = 0; CR.ptrs = {}; CR.pinch = null;
    $('#pv-zoom').value = '1';
    $('#pv-crop-st').textContent = ''; $('#pv-crop-st').className = 'pv-st';
    var fr = S.f && S.f.frame && S.f.frame !== 'none' ? ' pv-framed pv-fr-' + S.f.frame : '';
    $all('.pv-cpv', $('#pv-crop')).forEach(function (el) { el.className = 'pv-cpv' + fr; });
    $('#pv-crop').hidden = false;
    requestAnimationFrame(function () { cropResize(); cropDraw(); $('#pv-crop-stage').focus(); });
  }
  function cropClose(silent) {
    var c = $('#pv-crop'); if (!c) return;
    var was = !c.hidden;
    c.hidden = true;
    if (CR.url) { URL.revokeObjectURL(CR.url); CR.url = ''; }
    CR.img = null; CR.busy = false;
    if (was && !silent) { var cam = $('#pv-cam'); if (cam) cam.focus(); }
  }
  function cropDims() {
    var r = CR.rot % 180 !== 0, w = CR.img.naturalWidth, h = CR.img.naturalHeight;
    return r ? { w: h, h: w } : { w: w, h: h };
  }
  function cropResize() {
    var st = $('#pv-crop-stage'), cv = $('#pv-crop-cv'); if (!st || !CR.img) return;
    var s = st.clientWidth || 300, dpr = Math.min(window.devicePixelRatio || 1, 2);
    CR.size = s; cv.width = Math.round(s * dpr); cv.height = Math.round(s * dpr);
  }
  function cropBase() { var d = cropDims(); return CR.size / Math.min(d.w, d.h); }
  function cropClamp() {
    var d = cropDims(), sc = cropBase() * CR.z;
    var mx = Math.max(0, (d.w * sc - CR.size) / 2), my = Math.max(0, (d.h * sc - CR.size) / 2);
    CR.x = Math.max(-mx, Math.min(mx, CR.x)); CR.y = Math.max(-my, Math.min(my, CR.y));
  }
  function cropPaint(ctx, px, k) {
    var sc = cropBase() * CR.z * k, w = CR.img.naturalWidth * sc, h = CR.img.naturalHeight * sc;
    ctx.save();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, px, px);
    ctx.translate(px / 2 + CR.x * k, px / 2 + CR.y * k);
    ctx.rotate(CR.rot * Math.PI / 180);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(CR.img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  function cropDraw() {
    if (!CR.img) return;
    var cv = $('#pv-crop-cv'); cropClamp();
    cropPaint(cv.getContext('2d'), cv.width, cv.width / CR.size);
    // живой предпросмотр в размерах карточки / чата / сообщения
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    $all('.pv-crop-prev canvas', $('#pv-crop')).forEach(function (c) {
      var px = Math.round((c.parentNode.clientWidth || 40) * dpr);
      if (c.width !== px) { c.width = px; c.height = px; }
      cropPaint(c.getContext('2d'), px, px / CR.size);
    });
  }
  function cropZoom(z, px, py) {
    if (!CR.img) return;
    z = Math.max(1, Math.min(4, z)); px = px || 0; py = py || 0;
    var r = z / CR.z;
    CR.x = px - (px - CR.x) * r; CR.y = py - (py - CR.y) * r; CR.z = z;
    $('#pv-zoom').value = String(z.toFixed(2));
    cropDraw();
  }
  function stagePt(e) {
    var st = $('#pv-crop-stage'), r = st.getBoundingClientRect(), k = CR.size / (r.width || CR.size);
    return { x: (e.clientX - r.left - r.width / 2) * k, y: (e.clientY - r.top - r.height / 2) * k, k: k };
  }
  function bindCrop() {
    var st = $('#pv-crop-stage');
    st.addEventListener('pointerdown', function (e) {
      if (!CR.img) return;
      try { st.setPointerCapture(e.pointerId); } catch (x) {}
      CR.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      st.classList.add('drag');
      var ids = Object.keys(CR.ptrs);
      if (ids.length === 2) {
        var a = CR.ptrs[ids[0]], b = CR.ptrs[ids[1]];
        CR.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: CR.z };
      }
      e.preventDefault();
    });
    st.addEventListener('pointermove', function (e) {
      var p = CR.ptrs[e.pointerId]; if (!p || !CR.img) return;
      var ids = Object.keys(CR.ptrs);
      if (ids.length >= 2 && CR.pinch) {
        p.x = e.clientX; p.y = e.clientY;
        var a = CR.ptrs[ids[0]], b = CR.ptrs[ids[1]];
        var c = stagePt({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        cropZoom(CR.pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / CR.pinch.d), c.x, c.y);
        return;
      }
      var k = stagePt(e).k;
      CR.x += (e.clientX - p.x) * k; CR.y += (e.clientY - p.y) * k;
      p.x = e.clientX; p.y = e.clientY;
      cropDraw();
    });
    function up(e) {
      delete CR.ptrs[e.pointerId];
      if (Object.keys(CR.ptrs).length < 2) CR.pinch = null;
      if (!Object.keys(CR.ptrs).length) st.classList.remove('drag');
    }
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up); st.addEventListener('lostpointercapture', up);
    st.addEventListener('wheel', function (e) {
      if (!CR.img) return;
      e.preventDefault();
      var p = stagePt(e);
      cropZoom(CR.z * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
    st.addEventListener('keydown', function (e) {
      if (!CR.img) return;
      var step = e.shiftKey ? 24 : 8, k = e.key;
      if (k === 'ArrowLeft') CR.x += step; else if (k === 'ArrowRight') CR.x -= step;
      else if (k === 'ArrowUp') CR.y += step; else if (k === 'ArrowDown') CR.y -= step;
      else if (k === '+' || k === '=') { cropZoom(CR.z * 1.1); e.preventDefault(); return; }
      else if (k === '-' || k === '_') { cropZoom(CR.z / 1.1); e.preventDefault(); return; }
      else if (k === 'r' || k === 'R' || k === 'к' || k === 'К') { cropRotate(); e.preventDefault(); return; }
      else if (k === 'Enter') { cropOk(); e.preventDefault(); return; }
      else return;
      e.preventDefault(); cropDraw();
    });
    $('#pv-zoom').addEventListener('input', function () { cropZoom(parseFloat(this.value) || 1); });
    window.addEventListener('resize', function () { if (CR.img && !$('#pv-crop').hidden) { cropResize(); cropDraw(); } });
  }
  function cropRotate() { if (!CR.img) return; CR.rot = (CR.rot + 90) % 360; CR.x = 0; CR.y = 0; cropDraw(); }
  function cropOk() {
    if (CR.busy || !CR.img) return;
    var out = D.createElement('canvas'); out.width = 512; out.height = 512;
    cropPaint(out.getContext('2d'), 512, 512 / CR.size);
    var data;
    try { data = out.toDataURL('image/jpeg', 0.9); } catch (e) { toast('Не удалось подготовить фото', true); return; }
    CR.busy = true;
    var ok = $('#pv-crop-ok'), st = $('#pv-crop-st');
    ok.disabled = true; st.className = 'pv-st'; st.textContent = 'Загружаем фото…';
    api('/api/avatar/upload', { photo_data: data }).then(function (j) {
      if (!S.me) S.me = { profile: {} };
      S.me.photo_url = j.photo_url || ''; S.me.photo_src = j.photo_src || (j.photo_url ? j.photo_url + '?v=' + Date.now() : '');
      avSetMine({ photo_src: S.me.photo_src });
      cropClose();
      renderAll();
      toast('Фото обновлено — коллеги увидят его сразу');
    }).catch(function (e) {
      st.className = 'pv-st err'; st.textContent = e.message || 'Не удалось загрузить фото';
    }).then(function () { CR.busy = false; ok.disabled = false; });
  }
  function deletePhoto() {
    if (!photoSrc()) return;
    confirmBox({ title: 'Удалить фото профиля?', text: 'Вместо фото коллеги снова увидят первую букву имени. Рамка останется.', yes: 'Удалить', no: 'Отмена', danger: true, focusNo: true })
      .then(function (r) {
        if (r !== 'yes') return;
        api('/api/avatar/delete', {}).then(function () {
          S.me.photo_url = ''; S.me.photo_src = '';
          avSetMine({ photo_src: '' });
          renderAll(); toast('Фото удалено');
          var up = $('.pv-photo-btns [data-pv="photo"]') || $('#pv-cam'); if (up) up.focus();
        }).catch(function (e) { toast(e.message || 'Не удалось удалить фото', true); });
      });
  }

  /* ── события окна ── */
  function radioKeys(container, sel, pick) {
    container.addEventListener('keydown', function (e) {
      var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 0, End: 0 };
      if (!(e.key in keys)) return;
      var items = $all(sel, container); if (!items.length) return;
      var i = items.indexOf(D.activeElement); if (i < 0) i = 0;
      var n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + keys[e.key] + items.length) % items.length;
      e.preventDefault(); items[n].focus(); pick(items[n]);
    });
  }
  /* Esc закрывает верхний слой: подтверждение → кадрирование → эмодзи → окно */
  function escLayer() {
    if (!$('#pv-cf').hidden) cfDone(null);
    else if (!$('#pv-crop').hidden) cropClose();
    else if (!$('#pv-emo-grid').hidden) { emoGrid(false); $('#pv-emo-btn').focus(); }
    else closeProfileModal();
  }
  function topLayer(ov) {
    var cf = $('#pv-cf', ov); if (cf && !cf.hidden) return $('.pv-cf-box', cf);
    var cr = $('#pv-crop', ov); if (cr && !cr.hidden) return cr;
    return $('.pv-dlg', ov);
  }
  function trapTab(e, layer) {
    var f = $all('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', layer)
      .filter(function (el) { return !el.hidden && el.offsetParent !== null && !el.closest('[hidden]'); });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!layer.contains(D.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && D.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function bindDialog(ov) {
    ov.addEventListener('mousedown', function (e) { ov._downOnBackdrop = e.target === ov; });
    ov.addEventListener('click', function (e) {
      if (e.target === ov) { if (ov._downOnBackdrop) closeProfileModal(); return; }
      var cfBox = $('#pv-cf');
      if (e.target === cfBox) { cfDone(null); return; }
      var a = e.target.closest('[data-pv]');
      if (a && !a.disabled) {
        var act = a.getAttribute('data-pv');
        if (act === 'close') closeProfileModal();
        else if (act === 'save') saveProfile();
        else if (act === 'photo') pickPhoto();
        else if (act === 'photo-del') deletePhoto();
        else if (act === 'crop-cancel') cropClose();
        else if (act === 'crop-ok') cropOk();
        else if (act === 'zoom-in') cropZoom(CR.z * 1.15);
        else if (act === 'zoom-out') cropZoom(CR.z / 1.15);
        else if (act === 'rotate') cropRotate();
        else if (act === 'st-clear') { S.f.status_text = ''; S.f.status_emoji = ''; S.ttlTouched = true; S.ttl = '0'; renderStatus(); renderSeen(); changed(); $('#pv-st-text').focus(); }
        return;
      }
      var tab = e.target.closest('.pv-tab'); if (tab) { setTab(tab.getAttribute('data-tab'), true); return; }
      var fr = e.target.closest('.pv-frame-opt');
      if (fr) { S.f.frame = fr.getAttribute('data-frame'); renderFrames(); renderSeen(); changed(); return; }
      var pr = e.target.closest('.pv-pres-opt');
      if (pr) { S.f.my_status = pr.getAttribute('data-pres'); renderStatus(); renderPrivacy(); changed(); return; }
      var em = e.target.closest('.pv-emo');
      if (em) { S.f.status_emoji = em.getAttribute('data-emo'); if (!S.ttlTouched && !S.base.status_text && !S.base.status_emoji) { S.ttl = '0'; } renderStatus(); renderSeen(); emoGrid(false); changed(); $('#pv-st-text').focus(); return; }
      if (e.target.closest('#pv-emo-btn')) { emoGrid(); var cur = $('.pv-emo[aria-pressed="true"]') || $('.pv-emo'); if (!$('#pv-emo-grid').hidden && cur) cur.focus(); return; }
      var ps = e.target.closest('[data-preset]');
      if (ps) { var p = PRESETS[+ps.getAttribute('data-preset')]; S.f.status_emoji = p[0]; S.f.status_text = p[1]; renderStatus(); renderSeen(); changed(); return; }
      var tt = e.target.closest('[data-ttl]');
      if (tt) { S.ttl = tt.getAttribute('data-ttl'); S.ttlTouched = true; renderStatus(); changed(); return; }
    });
    ov.addEventListener('input', function (e) {
      var t = e.target, id = t.id;
      if (id === 'pv-job') { S.f.job_title = t.value; count(id); renderSeen(); changed(); }
      else if (id === 'pv-phone') { S.f.phone = t.value; validatePhone(false); renderSeen(); changed(); }
      else if (id === 'pv-bio') { S.f.bio = t.value; count(id); renderSeen(); changed(); }
      else if (id === 'pv-st-text') { S.f.status_text = t.value; count(id); renderSeen(); $('#pv-st-clear').hidden = !(S.f.status_text || S.f.status_emoji); $('#pv-until').textContent = untilText(); $all('#pv-presets .pv-chip').forEach(function (b) { var q = PRESETS[+b.getAttribute('data-preset')]; b.setAttribute('aria-pressed', q[0] === S.f.status_emoji && q[1] === S.f.status_text ? 'true' : 'false'); }); changed(); }
    });
    ov.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-priv')) { S.f.privacy[t.getAttribute('data-priv')] = t.checked; renderPrivacy(); changed(); }
      else if (t.id === 'pv-file') { takeFile(t.files && t.files[0]); }
    });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escLayer(); return; }
      if (e.key === 'Tab') { trapTab(e, topLayer(ov)); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ы' || e.key === 'Enter')) {
        if ($('#pv-crop').hidden && $('#pv-cf').hidden) { e.preventDefault(); if (!$('#pv-save').disabled) saveProfile(); }
      }
    });
    $('#pv-cf-yes').addEventListener('click', function () { cfDone('yes'); });
    $('#pv-cf-no').addEventListener('click', function () { cfDone('no'); });
    radioKeys($('.pv-tabs'), '.pv-tab', function (b) { setTab(b.getAttribute('data-tab'), true); });
    radioKeys($('#pv-frames'), '.pv-frame-opt', function (b) { b.click(); });
    radioKeys($('#pv-pres'), '.pv-pres-opt', function (b) { b.click(); });
    radioKeys($('#pv-ttl'), '.pv-chip', function (b) { b.click(); });
    // перетаскивание файла на аватар
    var drop = $('.pv-dlg');
    drop.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); $('#pv-hero').classList.add('pv-dragging'); } });
    drop.addEventListener('dragleave', function (e) { if (e.target === drop || !drop.contains(e.relatedTarget)) $('#pv-hero').classList.remove('pv-dragging'); });
    drop.addEventListener('drop', function (e) {
      $('#pv-hero').classList.remove('pv-dragging');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { e.preventDefault(); takeFile(file); }
    });
    bindCrop();
  }

  /* ══════════════ Карточка коллеги ══════════════ */
  var CARD = { el: null, ip: '', seq: 0, opener: null };
  function cardBuild() {
    if (CARD.el) return CARD.el;
    var ov = D.createElement('div');
    ov.className = 'pv-card-ov v18ui'; ov.id = 'pv-card-ov'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML = '<div class="pv-card" role="dialog" aria-modal="true" aria-labelledby="pv-card-name" tabindex="-1">'
      + '<header class="pv-hero" id="pv-card-hero" data-frame="none"><div class="pv-hero-top"><h2 class="pv-hero-title">Профиль</h2>'
      + '<button type="button" class="pv-x" data-card="close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>'
      + '<div class="pv-hero-avwrap"><div class="pv-av pv-hero-av" id="pv-card-av"></div></div>'
      + '<div class="pv-hero-name" id="pv-card-name"></div>'
      + '<div class="pv-hero-sub"><span class="pv-pres"><span class="pv-dot" id="pv-card-dot"></span><span id="pv-card-pres"></span></span><span class="pv-note" id="pv-card-note" hidden></span></div></header>'
      + '<div class="pv-card-body" id="pv-card-body"></div>'
      + '<div class="pv-card-foot"><button type="button" class="v18-btn ghost" data-card="close">Закрыть</button>'
      + '<button type="button" class="v18-btn pri" data-card="write" id="pv-card-write" hidden><i class="fa-regular fa-paper-plane" aria-hidden="true"></i> Написать</button></div></div>';
    D.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { ov._down = e.target === ov; });
    ov.addEventListener('click', function (e) {
      if (e.target === ov) { if (ov._down) cardClose(); return; }
      var a = e.target.closest('[data-card]'); if (!a) return;
      var act = a.getAttribute('data-card');
      if (act === 'close') cardClose();
      else if (act === 'write') { var c = CARD.data || {}; cardClose(); if (typeof window.openThread === 'function') window.openThread(CARD.ip, c.name || '', c.org || ''); }
      else if (act === 'copy') {
        var v = a.getAttribute('data-v') || '';
        var done = function () { a.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>'; setTimeout(function () { a.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>'; }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () {});
      }
    });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cardClose(); }
      else if (e.key === 'Tab') trapTab(e, $('.pv-card', ov));
    });
    CARD.el = ov;
    return ov;
  }
  function presOther(c) {
    var p = c.presence || (c.online ? 'online' : 'offline');
    if (PRES_OTHER[p]) return [p, PRES_OTHER[p]];
    return ['offline', c.last_seen ? 'был(а) ' + fmtSeen(c.last_seen) : 'не в сети'];
  }
  function cardRender(c, loading) {
    var ov = CARD.el, frame = FRAME_IDS.indexOf(c.frame) > 0 ? c.frame : 'none';
    $('#pv-card-hero', ov).setAttribute('data-frame', frame);
    paintAv($('#pv-card-av', ov), { ip: c.ip, name: c.name, org: c.org, photo: c.photo_src, frame: frame, emoji: c.status_emoji });
    $('#pv-card-name', ov).innerHTML = esc(c.name || 'Сотрудник') + (isOdz(c.org) ? '<span class="pv-star" title="Отдел ОДЗиМЛ" aria-label="Отдел ОДЗиМЛ">★</span>' : '');
    var p = loading ? ['offline', 'загрузка…'] : presOther(c);
    $('#pv-card-dot', ov).className = 'pv-dot ' + p[0];
    $('#pv-card-pres', ov).textContent = p[1];
    var st = ((c.status_emoji ? c.status_emoji + ' ' : '') + (c.status_text || '')).trim(), u = parseDT(c.status_until);
    var note = $('#pv-card-note', ov);
    note.textContent = st ? st + (u ? ' · до ' + (fmtWhen(u).replace(/^сегодня в /, '')) : '') : '';
    note.hidden = !st; note.title = note.textContent;
    var rows = [];
    if (c.job_title) rows.push(['fa-solid fa-briefcase', esc(c.job_title), 'Должность']);
    if (c.org) rows.push(['fa-solid fa-sitemap', esc(c.org), 'Отдел']);
    if (c.phone) {
      var tel = String(c.phone).replace(/[^0-9+]/g, '');
      rows.push(['fa-solid fa-phone', '<a href="tel:' + esc(tel) + '">' + esc(c.phone) + '</a>', 'Телефон',
        '<button type="button" class="v18-icon" data-card="copy" data-v="' + esc(c.phone) + '" title="Скопировать номер" aria-label="Скопировать номер"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>']);
    }
    if (c.bio) rows.push(['fa-solid fa-align-left', esc(c.bio), 'О себе']);
    var body = $('#pv-card-body', ov);
    if (loading) body.innerHTML = '<div class="pv-skel"><i></i><i></i></div>';
    else if (!rows.length) body.innerHTML = '<div class="pv-card-empty">Коллега пока не рассказал о себе</div>';
    else body.innerHTML = rows.map(function (r) {
      return '<div class="pv-card-row"><i class="' + r[0] + '" aria-hidden="true"></i><div><b>' + r[1] + '</b><span>' + r[2] + '</span></div>' + (r[3] || '') + '</div>';
    }).join('');
    $('#pv-card-write', ov).hidden = loading || !c.ip || c.ip === window.currentPeer || c.ip === myIp();
  }
  function openCard(ip, hint) {
    ip = String(ip || ''); if (!ip) return;
    if (ip === myIp()) { openProfileModal(); return; }
    var ov = cardBuild();
    CARD.ip = ip; CARD.opener = D.activeElement;
    var cached = AV.cache[ip] || {};
    var c = { ip: ip, name: (hint && hint.name) || '', org: (hint && hint.org) || '', photo_src: cached.photo || '', frame: cached.frame || 'none', status_emoji: cached.emoji || '' };
    CARD.data = c;
    cardRender(c, true);
    ov.classList.add('open'); ov.setAttribute('aria-hidden', 'false');
    setTimeout(function () { $('.pv-card', ov).focus(); }, 30);
    var seq = ++CARD.seq;
    api('/api/profile/card?ip=' + encodeURIComponent(ip)).then(function (j) {
      if (seq !== CARD.seq) return;
      var card = j.card || {};
      if (!card.name) card.name = c.name; if (!card.org) card.org = c.org;
      CARD.data = card;
      avPut(ip, card); avRefreshIp(ip);
      cardRender(card, false);
    }).catch(function (e) {
      if (seq !== CARD.seq) return;
      cardRender(c, false);
      $('#pv-card-body', ov).innerHTML = '<div class="pv-card-empty">' + esc(e.message || 'Не удалось загрузить профиль') + '</div>';
    });
  }
  function cardClose() {
    if (!CARD.el || !CARD.el.classList.contains('open')) return;
    CARD.el.classList.remove('open'); CARD.el.setAttribute('aria-hidden', 'true'); CARD.seq++;
    var o = CARD.opener; CARD.opener = null;
    if (o && o.focus && D.contains(o)) { try { o.focus(); } catch (e) {} }
  }
  function headerHint() {
    var n = D.getElementById('ch-name'), o = D.getElementById('ch-org');
    var name = n ? n.textContent.replace(/★/g, '').trim() : '';
    return { name: name === '—' ? '' : name, org: o ? o.textContent.trim() : '' };
  }
  D.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('#ch-avatar-letter, .chat-header-info')) {
      if (window.currentPeer) { e.preventDefault(); openCard(window.currentPeer, headerHint()); }
      return;
    }
    var mav = t.closest('.msg-row.from-them .msg-avatar-letter[data-av-ip]');
    if (mav) { var ip = mav.getAttribute('data-av-ip'); openCard(ip, ip === window.currentPeer ? headerHint() : null); }
  });
  D.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // фокус «выпал» из окна (например, скрылась кнопка, на которой он был) — Esc всё равно работает
      if (CARD.el && CARD.el.classList.contains('open') && !CARD.el.contains(e.target)) { e.preventDefault(); cardClose(); return; }
      var pov = D.getElementById('profile-modal-overlay');
      if (pov && pov.classList.contains('open') && !pov.contains(e.target)) { e.preventDefault(); escLayer(); return; }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.id === 'ch-avatar-letter' && window.currentPeer) {
      e.preventDefault(); openCard(window.currentPeer, headerHint());
    }
  });

  /* ══════════════ Экспорт и запуск ══════════════ */
  window.openProfileModal = function (tab) { openProfileModal(tab); };
  window.closeProfileModal = function (force) { closeProfileModal(force); };
  window.saveProfile = function () { saveProfile(); };
  window.pmTab = function (name) { if (isOpen()) setTab(name === 'status' || name === 'privacy' || name === 'frame' ? name : 'profile', true); };
  window.PV = {
    open: openProfileModal, close: closeProfileModal, card: openCard, closeCard: cardClose,
    refresh: function (ip) { if (ip) { delete AV.cache[ip]; avRefreshIp(ip); } },
    refreshMe: function () { var ip = myIp(); if (ip) { delete AV.cache[ip]; avRequest(ip); } },
    cache: AV.cache
  };
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', avStart); else avStart();
})();
