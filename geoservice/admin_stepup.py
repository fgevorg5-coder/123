# -*- coding: utf-8 -*-
"""
admin_stepup.py — второй пароль администратора (step-up авторизация).

Права администратора действуют ТОЛЬКО после ввода дополнительного пароля,
даже если запрос пришёл с ADMIN_IP или выполнен вход через /login.

  • Подтверждение живёт случайное время (ADMIN_STEPUP_MIN..MAX минут) —
    пароль может запроситься снова на любой странице в любой момент.
  • Подтверждение привязано к IP и браузеру (User-Agent): украденная cookie
    с другого компьютера прав не даёт.
  • Абсолютный предел — ADMIN_STEPUP_ABS_H часов, затем снова пароль.
  • Перебор: после ADMIN_STEPUP_MAX_FAILS ошибок — блокировка IP
    (15 мин → 30 → 60 …), сессия администратора сбрасывается.
  • Нет пароля в .env → админ-права не выдаются никому (fail-closed).

.env:
  ADMIN_PASSWORD2_HASH=pbkdf2:sha256:...   (предпочтительно; см. README)
  или ADMIN_PASSWORD2=...                  (открытым текстом, хэшируется при старте)
  ADMIN_STEPUP_MIN=10   ADMIN_STEPUP_MAX=45   ADMIN_STEPUP_ABS_H=8
  ADMIN_STEPUP_MAX_FAILS=5
"""
import hashlib
import html
import os
import secrets
import threading
import time
from urllib.parse import quote

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from werkzeug.security import check_password_hash, generate_password_hash


def _env_int(name, default):
    try:
        return int(os.getenv(name, str(default)).strip())
    except Exception:
        return default


STEPUP_MIN = max(1, _env_int("ADMIN_STEPUP_MIN", 10)) * 60
STEPUP_MAX = max(STEPUP_MIN // 60, _env_int("ADMIN_STEPUP_MAX", 45)) * 60
STEPUP_ABS = max(1, _env_int("ADMIN_STEPUP_ABS_H", 8)) * 3600
MAX_FAILS = max(3, _env_int("ADMIN_STEPUP_MAX_FAILS", 5))
LOCK_SEC = 15 * 60
STEPUP_HEADER = "X-Admin-Stepup"
STEPUP_DETAIL = "Требуется дополнительный пароль администратора"

_hash = (os.environ.pop("ADMIN_PASSWORD2_HASH", "") or "").strip()
_plain = os.environ.pop("ADMIN_PASSWORD2", "") or ""
if not _hash and _plain:
    _hash = generate_password_hash(_plain)
_same_as_main = bool(_plain) and _plain == os.getenv("ADMIN_PASSWORD", "")
del _plain
CONFIGURED = bool(_hash)

_fails = {}
_fails_lock = threading.Lock()


def _fp(request, ip):
    ua = request.headers.get("user-agent", "")
    return hashlib.sha256(f"{ip}|{ua}".encode("utf-8", "ignore")).hexdigest()[:24]


def is_verified(request, ip):
    s = request.session
    if not s.get("user_id"):
        return False
    try:
        until = float(s.get("adm2_until", 0))
        since = float(s.get("adm2_since", 0))
    except Exception:
        return False
    now = time.time()
    if until <= now or now - since > STEPUP_ABS:
        return False
    return secrets.compare_digest(str(s.get("adm2_fp", "")), _fp(request, ip))


def drop(request):
    for k in ("adm2_until", "adm2_since", "adm2_fp"):
        request.session.pop(k, None)


def _locked_for(ip):
    now = time.time()
    with _fails_lock:
        r = _fails.get(ip)
        if r and r.get("until", 0) > now:
            return int(r["until"] - now)
        if r and now - r.get("first", now) > 3600:
            _fails.pop(ip, None)
    return 0


def _fail(ip):
    now = time.time()
    with _fails_lock:
        r = _fails.get(ip)
        if not r or now - r.get("first", now) > 3600:
            r = {"n": 0, "first": now, "until": 0}
        r["n"] += 1
        if r["n"] >= MAX_FAILS:
            r["until"] = now + min(LOCK_SEC * 2 ** (r["n"] - MAX_FAILS), 24 * 3600)
        _fails[ip] = r
        if len(_fails) > 5000:
            _fails.pop(next(iter(_fails)), None)
        return r["n"]


_ADMIN = {"ip": None, "id": "1"}


def _check(request, ip, password, logger):
    """→ (ok, сообщение об ошибке)."""
    if not CONFIGURED:
        return False, "Дополнительный пароль не задан на сервере (ADMIN_PASSWORD2 в .env)"
    left = _locked_for(ip)
    if left:
        return False, f"Слишком много ошибок. Повторите через {left // 60 + 1} мин."
    if not request.session.get("user_id") and ip != _ADMIN["ip"]:
        return False, "Сначала выполните вход администратора"
    if check_password_hash(_hash, password or ""):
        request.session.pop("adm2_skip", None)
        if not request.session.get("user_id"):
            request.session["user_id"] = _ADMIN["id"]
        with _fails_lock:
            _fails.pop(ip, None)
        now = time.time()
        s = request.session
        s["adm2_since"] = now if not is_verified(request, ip) else float(s.get("adm2_since", now))
        s["adm2_until"] = now + secrets.choice(range(STEPUP_MIN, STEPUP_MAX + 1))
        s["adm2_fp"] = _fp(request, ip)
        if logger:
            logger.info("[stepup] доп. пароль администратора подтверждён, IP %s", ip)
        return True, ""
    n = _fail(ip)
    if logger:
        logger.warning("[stepup] НЕВЕРНЫЙ доп. пароль администратора, IP %s (попытка %s)", ip, n)
    if n >= MAX_FAILS:
        request.session.clear()
        return False, "Слишком много ошибок — сессия администратора сброшена"
    return False, "Неверный пароль"


def _page(csrf, nxt, error=""):
    err = f'<div class="err">{html.escape(error)}</div>' if error else ""
    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подтверждение администратора</title>
<style>
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f2a1d;font-family:Segoe UI,Arial,sans-serif;color:#e8f3ec}}
form{{background:#163a28;border:1px solid #2f6b4b;border-radius:14px;padding:28px 30px;width:340px;
box-shadow:0 12px 40px rgba(0,0,0,.45)}}
h1{{font-size:18px;margin:0 0 6px}} p{{font-size:13px;opacity:.8;margin:0 0 18px}}
input[type=password]{{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;border:1px solid #3c7d5a;
background:#0f2a1d;color:#fff;font-size:15px}}
button{{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:#3fa36b;color:#fff;
font-size:15px;cursor:pointer}} a{{display:block;text-align:center;margin-top:12px;color:#9fd4b5;font-size:13px}}
.err{{background:#5a1f1f;border:1px solid #a54444;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:12px}}
</style></head><body>
<form method="post" action="/admin/verify" autocomplete="off">
<h1>🔒 Подтверждение администратора</h1>
<p>Введите дополнительный пароль администратора, чтобы продолжить.</p>{err}
<input type="hidden" name="_csrf_token" value="{html.escape(csrf)}">
<input type="hidden" name="next" value="{html.escape(nxt)}">
<input type="password" name="password" placeholder="Дополнительный пароль" autofocus required>
<button type="submit">Подтвердить</button>
<a href="/logout_guest">Продолжить без прав администратора</a>
</form></body></html>"""


def _safe_next(n):
    n = (n or "/").strip()
    if not n.startswith("/") or n.startswith("//") or "\\" in n:
        return "/"
    return n


def build(*, app, get_real_ip, get_csrf_token, admin_ip, admin_id="1", logger=None):
    from fastapi.exception_handlers import http_exception_handler as _default_http

    _ADMIN["ip"], _ADMIN["id"] = admin_ip, admin_id
    if not CONFIGURED and logger:
        logger.error("[stepup] ADMIN_PASSWORD2 не задан — права администратора НЕ выдаются никому")
    if _same_as_main and logger:
        logger.warning("[stepup] ADMIN_PASSWORD2 совпадает с ADMIN_PASSWORD — задайте другой пароль")

    router = APIRouter()

    def _needs(request, ip):
        if request.session.get("user_id"):
            return True
        return ip == admin_ip and not request.session.get("adm2_skip")

    def _csrf_ok(request, token):
        st = request.session.get("csrf_token")
        return bool(st) and secrets.compare_digest(token or "", st)

    @router.get("/api/admin/stepup/status")
    async def stepup_status(request: Request):
        ip = get_real_ip(request)
        ver = is_verified(request, ip)
        left = max(0, int(float(request.session.get("adm2_until", 0)) - time.time())) if ver else 0
        return JSONResponse({"need": _needs(request, ip) and not ver, "verified": ver,
                             "configured": CONFIGURED, "locked": _locked_for(ip),
                             "check_in": min(left, 60) if ver else 60},
                            headers={"Cache-Control": "no-store"})

    @router.post("/api/admin/stepup")
    async def stepup_api(request: Request):
        ip = get_real_ip(request)
        hdr = request.headers.get("X-CSRFToken") or request.headers.get("X-CSRF-Token")
        if not _csrf_ok(request, hdr):
            raise HTTPException(403, "CSRF-токен недействителен")
        try:
            data = await request.json()
        except Exception:
            data = {}
        ok, err = _check(request, ip, str(data.get("password", ""))[:256], logger)
        if not ok:
            return JSONResponse({"ok": False, "error": err}, status_code=429 if "Повторите" in err else 400)
        return {"ok": True}

    @router.get("/admin/verify", response_class=HTMLResponse)
    async def verify_page(request: Request, next: str = "/"):
        return HTMLResponse(_page(get_csrf_token(request), _safe_next(next)),
                            headers={"Cache-Control": "no-store"})

    @router.post("/admin/verify")
    async def verify_form(request: Request, password: str = Form(""), next: str = Form("/"),
                          csrf_token: str = Form("", alias="_csrf_token")):
        ip = get_real_ip(request)
        nxt = _safe_next(next)
        if not _csrf_ok(request, csrf_token):
            return HTMLResponse(_page(get_csrf_token(request), nxt, "Сессия устарела, повторите"), 403)
        ok, err = _check(request, ip, password[:256], logger)
        if ok:
            return RedirectResponse(nxt, status_code=303)
        return HTMLResponse(_page(get_csrf_token(request), nxt, err), 400)

    @router.get("/logout_guest")
    async def logout_guest(request: Request):
        request.session.clear()
        request.session["adm2_skip"] = 1
        return RedirectResponse("/", status_code=303)

    @router.post("/api/admin/stepup/skip")
    async def stepup_skip(request: Request):
        request.session.pop("user_id", None)
        drop(request)
        request.session["adm2_skip"] = 1
        return {"ok": True}

    app.include_router(router)

    @app.exception_handler(HTTPException)
    async def _stepup_http_handler(request: Request, exc: HTTPException):
        hdrs = getattr(exc, "headers", None) or {}
        if exc.status_code == 401 and hdrs.get(STEPUP_HEADER) == "1":
            accept = request.headers.get("accept", "")
            if request.method == "GET" and "text/html" in accept:
                return RedirectResponse("/admin/verify?next=" + quote(request.url.path), status_code=303)
        return await _default_http(request, exc)

    return router
