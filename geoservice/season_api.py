"""
Сезон оформления геопортала ОДЗиМЛ: auto / spring / summer / autumn / winter.

  GET  /api/season        → {"season": "auto", "effective": "autumn"}   (публично)
  POST /api/admin/season  → {"season": "..."}  (только админ + CSRF-заголовок X-CSRFToken)

В шаблонах доступна глобальная переменная {{ season }} — уже вычисленный сезон
(<html data-season="{{ season }}">), поэтому ели правильные сразу, даже на страницах
блокировки/тех. работ, где API недоступен.

Хранение — файл instance/season.json: общий для всех воркеров uvicorn (workers=4),
каждый воркер перечитывает его только при изменении mtime.
"""
import datetime
import json
import os
import tempfile
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

SEASONS = ("auto", "spring", "summer", "autumn", "winter")


def season_by_month(today=None) -> str:
    m = (today or datetime.date.today()).month
    if m in (12, 1, 2):
        return "winter"
    if m in (3, 4, 5):
        return "spring"
    if m in (6, 7, 8):
        return "summer"
    return "autumn"


class _SeasonStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._mtime = None
        self._mode = "auto"
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def mode(self) -> str:
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            return "auto"
        if mtime != self._mtime:
            try:
                with open(self.path, encoding="utf-8") as f:
                    value = json.load(f).get("season", "auto")
                self._mode = value if value in SEASONS else "auto"
            except (OSError, ValueError):
                self._mode = "auto"
            self._mtime = mtime
        return self._mode

    def effective(self, mode: str = None) -> str:
        mode = mode or self.mode()
        return season_by_month() if mode == "auto" else mode

    def save(self, mode: str, who: str = "") -> None:
        with self._lock:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"season": mode, "by": who,
                           "updated": datetime.datetime.now().isoformat(timespec="seconds")},
                          f, ensure_ascii=False)
            os.replace(tmp, self.path)  # атомарно — воркеры не прочитают полупустой файл
            self._mtime = None


class _SeasonNow:
    """Глобал шаблона: {{ season }} → 'winter' и т.п. Вычисляется при каждом рендере."""
    def __init__(self, store: _SeasonStore):
        self._store = store

    def __str__(self) -> str:
        return self._store.effective()

    __html__ = __str__

    def __bool__(self) -> bool:
        return True

    def __eq__(self, other):
        return str(self) == other

    __hash__ = object.__hash__


# ── Карточка «Сезон оформления» для консоли (самовнедряемый JS) ──────────
ADMIN_CARD_URL = "/api/season/admin-card.js"
ADMIN_CARD_JS = '/* Сезон оформления — карточка в консоли (самовнедряемая) + кнопка «Сезон» в шапке. */\n(function(){\n  if(window.__seasonCardInit) return; window.__seasonCardInit=true;\n  var ME=document.currentScript;\n  var NAMES={auto:\'Авто\',spring:\'Весна\',summer:\'Лето\',autumn:\'Осень\',winter:\'Зима\'};\n  var ITEMS=[[\'auto\',\'#82e938\',\'fa-wand-magic-sparkles\',\'по календарю\'],[\'spring\',\'#7fe0a0\',\'fa-dove\',\'перелётные птицы\'],\n    [\'summer\',\'#9be35a\',\'fa-sun\',\'как есть\'],[\'autumn\',\'#f0a33a\',\'fa-leaf\',\'жёлтые макушки, ветер\'],[\'winter\',\'#9fd4ff\',\'fa-snowflake\',\'снег на кронах, снегопад\']];\n  var cur={season:null,effective:null,err:null};\n  var CSS=\'.fsc{padding:16px 18px;margin:0 0 14px;border:1px solid var(--border,#2a6e2c);border-radius:12px;background:linear-gradient(135deg,rgba(130,233,56,.06),rgba(226,182,64,.05)),var(--panel,#0f1f12);color:var(--text,#e8f5e0);font-family:Lato,sans-serif}\'+\n  \'.fsc .sc-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}.fsc .sc-head>i{font-size:22px;color:#e2b640}\'+\n  \'.fsc .sc-t{font-weight:900;font-size:14px}.fsc .sc-s{font-size:12px;color:var(--muted,#9bb59a);margin-top:2px}\'+\n  \'.fsc .sc-state{min-width:130px;text-align:center;font-size:12px;font-weight:800;padding:5px 12px;border-radius:999px;border:1px solid var(--border,#2a6e2c);background:rgba(0,0,0,.2)}\'+\n  \'.fsc .sc-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}\'+\n  \'.fsc .sc-btn{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 6px 10px;border-radius:12px;cursor:pointer;border:1.5px solid var(--border,#2a6e2c);background:rgba(0,0,0,.18);color:inherit;font-family:inherit;transition:all .2s;position:relative}\'+\n  \'.fsc .sc-btn i{font-size:20px;color:var(--sc);transition:transform .25s}.fsc .sc-btn b{font-size:13px;font-weight:900}\'+\n  \'.fsc .sc-btn small{font-size:10.5px;color:var(--muted,#9bb59a);text-align:center;line-height:1.25}\'+\n  \'.fsc .sc-btn:hover{border-color:var(--sc);transform:translateY(-1px)}.fsc .sc-btn:hover i{transform:scale(1.12)}\'+\n  \'.fsc .sc-btn.on{border-color:var(--sc);background:color-mix(in srgb,var(--sc) 14%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--sc) 18%,transparent)}\'+\n  \'.fsc .sc-btn.on::after{content:"✓";position:absolute;top:5px;right:8px;font-size:11px;font-weight:900;color:var(--sc)}\'+\n  \'.fsc .sc-btn.eff:not(.on){border-style:dashed;border-color:var(--sc)}.fsc .sc-btn[disabled]{opacity:.6;cursor:wait}\'+\n  \'@media(max-width:760px){.fsc .sc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}\'+\n  \'#hdrSeasonBtn{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;cursor:pointer;font:900 13px Lato,sans-serif;text-transform:uppercase;letter-spacing:.5px;background:rgba(226,182,64,.08);color:#e2b640;border:1.5px solid #6e5a2a;transition:all .25s}\'+\n  \'#hdrSeasonBtn:hover{background:rgba(226,182,64,.2)}\'+\n  \'#hdrSeasonPop{position:fixed;z-index:100000;width:min(620px,94vw);box-shadow:0 20px 50px -10px rgba(0,0,0,.7);background:var(--panel,#0f1f12)}\'+\n  \'#hdrSeasonPop.fsc{background:linear-gradient(135deg,rgba(130,233,56,.06),rgba(226,182,64,.05)),var(--panel,#0f1f12)}\';\n  function csrf(){\n    var t=ME&&ME.getAttribute(\'data-csrf\'); if(t) return t;\n    var m=document.querySelector(\'meta[name="csrf-token"]\'); if(m&&m.content) return m.content;\n    if(typeof window.getCsrfToken===\'function\'){try{return window.getCsrfToken()||\'\';}catch(e){}}\n    var c=document.cookie.match(/(?:^|;\\s*)(?:csrf_token|csrftoken|XSRF-TOKEN)=([^;]+)/); return c?decodeURIComponent(c[1]):\'\';\n  }\n  function build(id){\n    var d=document.createElement(\'div\'); d.className=\'fsc\'; if(id) d.id=id;\n    d.innerHTML=\'<div class="sc-head"><i class="fa-solid fa-tree"></i><div style="flex:1;min-width:220px"><div class="sc-t">Сезон оформления</div>\'+\n      \'<div class="sc-s">Ели в шапке геопортала и на служебных страницах (вход, тех. работы, блокировки). Применяется у всех пользователей.</div></div>\'+\n      \'<span class="sc-state">…</span></div><div class="sc-grid" role="radiogroup" aria-label="Сезон оформления">\'+\n      ITEMS.map(function(it){return \'<button type="button" class="sc-btn" role="radio" data-season="\'+it[0]+\'" style="--sc:\'+it[1]+\'"><i class="fa-solid \'+it[2]+\'"></i><b>\'+NAMES[it[0]]+\'</b><small>\'+it[3]+\'</small></button>\';}).join(\'\')+\'</div>\';\n    d.addEventListener(\'click\',function(e){var b=e.target.closest(\'.sc-btn\'); if(b) save(b.getAttribute(\'data-season\'));});\n    paintOne(d); return d;\n  }\n  function paintOne(d){\n    var st=d.querySelector(\'.sc-state\');\n    d.querySelectorAll(\'.sc-btn\').forEach(function(b){var s=b.getAttribute(\'data-season\');\n      b.classList.toggle(\'on\',s===cur.season);b.classList.toggle(\'eff\',s===cur.effective&&cur.season===\'auto\');b.setAttribute(\'aria-checked\',s===cur.season);b.disabled=!!cur.busy;});\n    if(cur.busy){st.textContent=\'Сохраняю…\';st.style.color=\'\';}\n    else if(cur.err){st.textContent=cur.err;st.style.color=\'#ff8a65\';}\n    else if(cur.season){st.textContent=\'Сейчас: \'+NAMES[cur.effective]+(cur.season===\'auto\'?\' (авто)\':\'\');st.style.color=\'\';}\n  }\n  function paint(){document.querySelectorAll(\'.fsc\').forEach(paintOne);\n    var l=document.getElementById(\'hdrSeasonLabel\'); if(l&&cur.effective) l.textContent=\'Сезон: \'+NAMES[cur.effective];}\n  function load(){\n    fetch(\'/api/season\',{credentials:\'same-origin\',cache:\'no-store\'}).then(function(r){return r.ok?r.json():Promise.reject(new Error(\'HTTP \'+r.status));})\n      .then(function(d){cur.season=d.season;cur.effective=d.effective;cur.err=null;paint();})\n      .catch(function(){cur.err=\'API сезона не подключён\';paint();});\n  }\n  function save(s){\n    cur.busy=true;cur.err=null;paint();\n    fetch(\'/api/admin/season\',{method:\'POST\',credentials:\'same-origin\',headers:{\'Content-Type\':\'application/json\',\'X-CSRFToken\':csrf(),\'X-CSRF-Token\':csrf()},body:JSON.stringify({season:s})})\n      .then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok) throw new Error(d.detail||d.error||(\'HTTP \'+r.status));return d;});})\n      .then(function(d){cur.season=d.season;cur.effective=d.effective;\n        try{localStorage.setItem(\'forest_season\',JSON.stringify({season:d.season,effective:d.effective,t:Date.now()}));}catch(e){}\n        document.querySelectorAll(\'iframe[src*="/maintenance"]\').forEach(function(f){try{f.contentWindow.location.reload();}catch(e){f.src=f.src;}});})\n      .catch(function(e){cur.err=\'Ошибка: \'+e.message;})\n      .finally(function(){cur.busy=false;paint();});\n  }\n  function ensureCard(){\n    var panel=document.getElementById(\'panel-maintenance\'); if(!panel) return;\n    var old=document.getElementById(\'seasonCard\'); if(old&&!old.classList.contains(\'fsc\')) old.remove(); /* старая inline-версия */\n    if(panel.querySelector(\'#seasonCard\')) return false;\n    var card=build(\'seasonCard\'), fc=panel.querySelector(\'#featuresCard\');\n    if(fc&&fc.parentNode) fc.parentNode.insertBefore(card,fc.nextSibling); else panel.insertBefore(card,panel.firstChild);\n    return true;\n  }\n  function ensureHdrBtn(){\n    if(document.getElementById(\'hdrSeasonBtn\')) return false;\n    var m=document.getElementById(\'hdrMaintBtn\'); if(!m||!m.parentNode) return false;\n    var b=document.createElement(\'button\'); b.type=\'button\'; b.id=\'hdrSeasonBtn\'; b.title=\'Сезон оформления (ели, снег, листья, птицы)\';\n    b.innerHTML=\'<i class="fa-solid fa-tree"></i><span id="hdrSeasonLabel">Сезон</span>\';\n    m.parentNode.insertBefore(b,m);\n    b.addEventListener(\'click\',function(e){e.stopPropagation();\n      var p=document.getElementById(\'hdrSeasonPop\'); if(p){p.remove();return;}\n      p=build(\'hdrSeasonPop\'); document.body.appendChild(p);\n      var r=b.getBoundingClientRect(); p.style.top=(r.bottom+8)+\'px\'; p.style.left=Math.max(8,Math.min(r.left,innerWidth-p.offsetWidth-8))+\'px\';});\n    document.addEventListener(\'click\',function(e){var p=document.getElementById(\'hdrSeasonPop\'); if(p&&!p.contains(e.target)&&e.target!==b) p.remove();});\n    document.addEventListener(\'keydown\',function(e){if(e.key===\'Escape\'){var p=document.getElementById(\'hdrSeasonPop\'); if(p) p.remove();}});\n    return true;\n  }\n  function init(){\n    var s=document.createElement(\'style\'); s.id=\'fscCss\'; s.textContent=CSS; document.head.appendChild(s);\n    ensureCard(); ensureHdrBtn(); paint(); load();\n    var t=null; new MutationObserver(function(){ if(t) return; t=setTimeout(function(){t=null;var a=ensureCard(),b=ensureHdrBtn();if(a||b)paint();},150);})\n      .observe(document.body,{childList:true,subtree:true});\n  }\n  if(document.readyState===\'loading\') document.addEventListener(\'DOMContentLoaded\',init); else init();\n})();\n'


def inject_admin_card(response, csrf_token: str = ""):
    """Гарантирует подключение карточки сезона на странице консоли,
    даже если на сервере остался старый admin_users.html."""
    try:
        body = response.body
        if not body or ('src="%s"' % ADMIN_CARD_URL).encode() in body:
            return response
        import html as _h
        tag = ('<script src="%s" data-csrf="%s"></script>' % (ADMIN_CARD_URL, _h.escape(csrf_token or "", quote=True))).encode()
        i = body.rfind(b"</body>")
        body = body[:i] + tag + body[i:] if i >= 0 else body + tag
        response.body = body
        response.headers["content-length"] = str(len(body))
    except Exception:
        pass
    return response


def build_router(base_dir: str, templates, require_admin, verify_csrf, logger=None) -> APIRouter:
    store = _SeasonStore(os.path.join(base_dir, "instance", "season.json"))
    if templates is not None:
        templates.env.globals["season"] = _SeasonNow(store)

    router = APIRouter()

    @router.get("/api/season")
    async def api_season():
        mode = store.mode()
        return JSONResponse({"season": mode, "effective": store.effective(mode)},
                            headers={"Cache-Control": "no-store"})

    @router.get(ADMIN_CARD_URL)
    async def api_season_admin_card():
        return Response(ADMIN_CARD_JS, media_type="application/javascript; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})

    @router.post("/api/admin/season")
    async def api_admin_season(request: Request,
                               admin_id: str = Depends(require_admin),
                               _csrf=Depends(verify_csrf)):
        try:
            data = await request.json()
        except Exception:
            data = {}
        value = str((data or {}).get("season", "")).strip().lower()
        if value not in SEASONS:
            raise HTTPException(400, "Неизвестный сезон")
        store.save(value, who=str(admin_id))
        if logger:
            logger.info(f"[season] Сезон оформления → {value} (admin={admin_id})")
        return JSONResponse({"ok": True, "season": value, "effective": store.effective(value)},
                            headers={"Cache-Control": "no-store"})

    return router
