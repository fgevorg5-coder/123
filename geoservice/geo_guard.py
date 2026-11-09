# -*- coding: utf-8 -*-
"""
geo_guard.py — защита и ускорение геосервиса ОДЗиМЛ (подключается из app.py).

Что делает (чистый ASGI, без BaseHTTPMiddleware — почти не стоит CPU):
  1. «Пропуск» геосервиса: подписанный HMAC cookie gp_pass (привязан к IP и
     браузеру, живёт 12 ч). Выдаётся при открытии любой HTML-страницы портала
     и продлевается фронтендом через /api/geo/pass. Без него тайлы, WMS/WFS,
     границы и прочие геоданные не отдаются → curl/python-скрипты «в лоб» не
     работают, ссылку на WFS нельзя просто открыть или встроить на чужой сайт.
  2. Запрет прямого открытия данных в адресной строке (Sec-Fetch-Mode=navigate)
     и кросс-сайтовых запросов (Sec-Fetch-Site=cross-site).
  3. Фильтр параметров WMS/WFS: только нужные порталу запросы (GetMap,
     GetFeatureInfo, GetLegendGraphic, GetFeature, DescribeFeatureType,
     GetCapabilities); форматы GetMap — только картинки (нельзя выгрузить вектор
     через KML/SVG/GeoTIFF); лимит объектов WFS (по умолчанию 50), запрет
     выгрузки «всего слоя» без фильтра, запрет SHAPE-ZIP/CSV/Excel, startIndex
     (постраничный обход), SLD_BODY, viewparams; ограничение размеров картинки.
  4. Лимиты запросов по IP (token bucket) + авто-бан IP, который упорно
     превышает лимит на данные (скрейпинг), с записью в лог.
  5. Убирает «Access-Control-Allow-Origin: *», заголовок Server и текст
     внутренних ошибок (5xx) из ответов.
  6. Ускорение: bypass() позволяет тайлам/статике обходить тяжёлые
     BaseHTTPMiddleware-слои; SecurityHeadersASGI и TileCacheHeadersASGI —
     ASGI-версии SecurityMiddleware и NoCookieTileMiddleware.

Важно: полностью запретить пользователю ВИДЕТЬ данные, которые его браузер
уже получил (вкладка Network в DevTools), технически невозможно ни на одном
сайте. Модуль делает так, чтобы получить можно было только то и столько,
сколько нужно для показа карты, и только из открытого портала.

Настройки (переменные окружения, все необязательные):
  GEO_GUARD_MODE        enforce (по умолчанию) | monitor (только лог) | off
  GEO_GUARD_SECRET      секрет HMAC (по умолчанию производный от SECRET_KEY)
  GEO_PASS_TTL          срок жизни пропуска, сек (43200)
  GEO_WFS_MAX           макс. объектов в одном WFS/GetFeatureInfo ответе (50)
  GEO_DESKTOP_WFS_MAX   то же для собственного /wfs (ArcGIS/QGIS), (20000)
  GEO_GIS_CLIENT_NETS   сети, откуда ArcGIS/QGIS ходят в /wms и /wfs без
                        пропуска (192.168.12.0/24,127.0.0.1/32). Пусто = никто.
  GEO_WFS_EDIT_IPS      IP, которым разрешён WFS-T (Transaction) в /wfs
                        (по умолчанию PROTECTED_IPS из app.py) + админ-сессия
  GEO_RATE_TILE / GEO_BURST_TILE   тайлы, запросов/с и запас (120 / 1200)
  GEO_RATE_DATA / GEO_BURST_DATA   данные (8 / 200)
  GEO_RATE_HEAVY / GEO_BURST_HEAVY GetCapabilities (0.5 / 15)
  GEO_BAN_STRIKES / GEO_BAN_SECONDS   авто-бан: сколько отказов за 10 мин (60)
                        и на сколько банить (900)
Лимиты — на один процесс uvicorn; общий лимит на все процессы — в nginx
(см. nginx_geoportal.conf, limit_req).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from urllib.parse import parse_qsl, urlencode

log = logging.getLogger("geo_guard")


def _env_f(name, default):
    try:
        return float(os.getenv(name, default))
    except Exception:
        return float(default)


# ─────────────────────────── классификация путей ────────────────────────────
WMS_PROXY_PATHS = ("/geoserver_wms_proxy", "/belgosles_wms_proxy")
WFS_PROXY_PATHS = ("/geoserver_wfs_proxy", "/belgosles_wfs_proxy")
OWN_OGC_PATHS = ("/wms", "/wfs")
TILE_PREFIXES = ("/tiles/", "/geoserver_pbf_proxy", "/api/proxy-tile", "/dzz-wms-proxy")
DATA_PATHS = ("/api/forestry-boundaries", "/api/zones-boundaries", "/api/country-boundary",
              "/api/get_image_info", "/api/images", "/api/vectors", "/api/geoserver_layers")
DATA_PREFIXES = ("/api/vector/", "/api/forest3d/")
_MBTILES_TILE_RE = re.compile(r"^/api/mbtiles/[^/]+/\d+/\d+/\d+\.[a-z0-9]+$")
# Пути, которым не нужны тяжёлые BaseHTTPMiddleware (сессия-профиль, аудит, IP-статус)
FAST_PREFIXES = WMS_PROXY_PATHS + TILE_PREFIXES + ("/static/",)

_ALLOWED_IMG_FORMATS = {
    "image/png", "image/png8", "image/png; mode=8bit", "image/jpeg", "image/jpg", "image/gif",
    "image/webp", "image/vnd.jpeg-png", "image/vnd.jpeg-png8",
}
_ALLOWED_INFO_FORMATS = {
    "application/json", "text/html", "text/plain", "application/geo+json",
    "application/vnd.ogc.gml", "text/xml", "application/vnd.ogc.gml/3.1.1",
}
_WFS_JSON = "application/json"
_DROP_ALWAYS = {"sld_body", "sld", "viewparams", "format_options_raw", "callback", "format_options_callback"}


def is_fast_path(path: str) -> bool:
    return path.startswith(FAST_PREFIXES) or bool(_MBTILES_TILE_RE.match(path))


def bypass(mw_cls, predicate=is_fast_path):
    """Обёртка над BaseHTTPMiddleware: для тайлов/статики слой пропускается
    целиком (каждый BaseHTTPMiddleware стоит ~0.3–1 мс и отдельную задачу
    anyio на КАЖДЫЙ тайл — при 100+ пользователях это тысячи задач/с)."""

    class _Bypass:
        def __init__(self, app, **kw):
            self.app = app
            self.inner = mw_cls(app, **kw)

        async def __call__(self, scope, receive, send):
            if scope.get("type") == "http" and predicate(scope.get("path", "")):
                return await self.app(scope, receive, send)
            return await self.inner(scope, receive, send)

    _Bypass.__name__ = "Bypass" + getattr(mw_cls, "__name__", "MW")
    return _Bypass


# ─────────────────────────── вспомогательное ────────────────────────────────
def _hdrs(scope):
    out = {}
    for k, v in scope.get("headers") or []:
        out[k.decode("latin-1").lower()] = v.decode("latin-1")
    return out


def _cookies(h):
    out = {}
    raw = h.get("cookie", "")
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


async def _send_simple(send, status, body: bytes, ctype="application/json; charset=utf-8", extra=None):
    headers = [(b"content-type", ctype.encode()), (b"content-length", str(len(body)).encode()),
               (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
    for k, v in (extra or {}).items():
        headers.append((k.lower().encode(), str(v).encode()))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _json(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


class _Bucket:
    __slots__ = ("tokens", "ts")

    def __init__(self, burst):
        self.tokens = burst
        self.ts = time.monotonic()


class RateLimiter:
    """Token bucket per (IP, класс запроса). Потокобезопасен, O(1)."""

    def __init__(self, limits: dict):
        self.limits = limits          # kind -> (rate, burst)
        self.b = {}
        self.lock = threading.Lock()
        self._last_gc = time.monotonic()

    def take(self, ip, kind, mult=1.0) -> float:
        """0 → можно; >0 → сколько секунд подождать."""
        rate, burst = self.limits[kind]
        rate *= mult
        burst *= mult
        now = time.monotonic()
        key = (ip, kind)
        with self.lock:
            bk = self.b.get(key)
            if bk is None:
                bk = self.b[key] = _Bucket(burst)
            bk.tokens = min(burst, bk.tokens + (now - bk.ts) * rate)
            bk.ts = now
            if bk.tokens >= 1:
                bk.tokens -= 1
                wait = 0.0
            else:
                wait = (1 - bk.tokens) / rate if rate > 0 else 60.0
            if now - self._last_gc > 120 and len(self.b) > 5000:
                self._last_gc = now
                for k in [k for k, v in self.b.items() if now - v.ts > 600]:
                    self.b.pop(k, None)
        return wait


class TTLCache:
    """Маленький потокобезопасный LRU+TTL кэш (для WFS-схем/поиска/Capabilities)."""

    def __init__(self, maxsize=512, ttl=120.0):
        self.maxsize, self.ttl = maxsize, ttl
        self.d = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            v = self.d.get(key)
            if v is None:
                return None
            if time.monotonic() - v[0] > self.ttl:
                self.d.pop(key, None)
                return None
            self.d.move_to_end(key)
            return v[1]

    def put(self, key, value):
        with self.lock:
            self.d[key] = (time.monotonic(), value)
            self.d.move_to_end(key)
            while len(self.d) > self.maxsize:
                self.d.popitem(last=False)


# ─────────────────────────── фильтр OGC-параметров ──────────────────────────
class Reject(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def _int(v, default=0):
    try:
        return int(float(v))
    except Exception:
        return default


def sanitize_ogc(path: str, items: list, *, admin: bool, wfs_max: int, desktop_max: int):
    """Возвращает (kind, new_items, changed). kind: tile|data|heavy|edit."""
    low = {}
    for k, v in items:
        low.setdefault(k.lower(), v)
    req = (low.get("request") or "").strip().lower()
    service = (low.get("service") or "").strip().lower()
    own = path in OWN_OGC_PATHS
    is_wfs_path = path in WFS_PROXY_PATHS or path == "/wfs"

    if not req:
        req = "getcapabilities" if own else ("getfeature" if is_wfs_path else "getmap")

    out = []
    changed = False
    drop = set() if admin else set(_DROP_ALWAYS)

    if req in ("getmap", "getlegendgraphic", "gettile"):
        if is_wfs_path:
            raise Reject(400, "Недопустимый запрос")
        kind = "tile"
        cap = 4096 if req == "getmap" else 1024
        for k, v in items:
            kl = k.lower()
            if kl in drop:
                changed = True
                continue
            if kl in ("width", "height") and _int(v) > cap:
                raise Reject(400, "Слишком большой размер изображения")
            if kl == "format" and not admin and req == "getmap":
                f = v.strip().lower()
                if f not in _ALLOWED_IMG_FORMATS and not f.startswith("application/x-protobuf") \
                        and not f.startswith("application/vnd.mapbox-vector-tile"):
                    raise Reject(400, "Формат не разрешён")
            out.append((k, v))
        return kind, out, changed

    if req == "getfeatureinfo":
        kind = "data"
        for k, v in items:
            kl = k.lower()
            if kl in drop:
                changed = True
                continue
            if kl == "feature_count" and _int(v, 1) > wfs_max:
                v, changed = str(wfs_max), True
            if kl in ("width", "height") and _int(v) > 8192:
                raise Reject(400, "Слишком большой размер")
            if kl == "info_format" and not admin and v.strip().lower().split(";")[0] not in _ALLOWED_INFO_FORMATS:
                raise Reject(400, "Формат не разрешён")
            out.append((k, v))
        return kind, out, changed

    if req == "describefeaturetype":
        return "data", [(k, v) for k, v in items if k.lower() not in drop], False

    if req == "getcapabilities":
        return "heavy", [(k, v) for k, v in items if k.lower() not in drop], False

    if req == "getfeature":
        kind = "data"
        limit = desktop_max if own else wfs_max
        has_filter = any(x in low for x in ("cql_filter", "filter", "featureid", "resourceid", "bbox"))
        if not has_filter and not own and not admin:
            limit = 1                       # «весь слой без фильтра» — только 1 объект (схема)
        ver = (low.get("version") or "1.1.0")
        cnt_key = "count" if ver.startswith("2") else "maxfeatures"
        seen_cnt = False
        for k, v in items:
            kl = k.lower()
            if kl in drop:
                changed = True
                continue
            if not admin:
                if kl in ("startindex", "resulttype", "outputformat") and not own:
                    changed = True          # постраничный обход/выгрузка в SHP/CSV запрещены
                    continue
                if kl in ("cql_filter",) and len(v) > 3000:
                    raise Reject(400, "Слишком сложный фильтр")
                if kl == "filter" and len(v) > 6000:
                    raise Reject(400, "Слишком сложный фильтр")
            if kl in ("maxfeatures", "count"):
                seen_cnt = True
                n = _int(v, limit)
                if not admin and (n <= 0 or n > limit):
                    v, changed = str(limit), True
            out.append((k, v))
        if not admin and not seen_cnt:
            out.append(("maxFeatures" if cnt_key == "maxfeatures" else "count", str(limit)))
            changed = True
        if not admin and not own:
            out.append(("outputFormat", _WFS_JSON))
            changed = True
        return kind, out, changed

    if req == "transaction" and path == "/wfs":
        return "edit", items, False

    if admin:
        return "data", items, False
    raise Reject(400, "Недопустимый тип запроса")


# ─────────────────────────── основной middleware ────────────────────────────
class GeoGuardMiddleware:
    def __init__(self, app, *, secret_key: str = "", protected_ips=(), trusted_proxies=("127.0.0.1", "::1"),
                 allowed_origins=(), session_cookie="forest_session", session_max_age=86400):
        self.app = app
        self.mode = (os.getenv("GEO_GUARD_MODE", "enforce") or "enforce").strip().lower()
        sec = os.getenv("GEO_GUARD_SECRET") or ("gp1:" + (secret_key or ""))
        if not secret_key and not os.getenv("GEO_GUARD_SECRET"):
            log.warning("[geo_guard] SECRET_KEY не задан — пропуска будут разными в процессах!")
            sec = "gp1:" + os.urandom(16).hex()
        self.key = hashlib.sha256(sec.encode()).digest()
        self.ttl = int(_env_f("GEO_PASS_TTL", 43200))
        self.wfs_max = int(_env_f("GEO_WFS_MAX", 50))
        self.desktop_max = int(_env_f("GEO_DESKTOP_WFS_MAX", 20000))
        self.protected = set(protected_ips or ())
        self.trusted = set(trusted_proxies or ())
        self.allowed_origins = {o.rstrip("/") for o in (allowed_origins or ())}
        edit = os.getenv("GEO_WFS_EDIT_IPS")
        self.edit_ips = {x.strip() for x in edit.split(",") if x.strip()} if edit is not None else set(self.protected)
        nets = os.getenv("GEO_GIS_CLIENT_NETS", "192.168.12.0/24,127.0.0.1/32")
        self.gis_nets = []
        for n in nets.split(","):
            n = n.strip()
            if n:
                try:
                    self.gis_nets.append(ipaddress.ip_network(n, strict=False))
                except ValueError:
                    log.warning(f"[geo_guard] неверная сеть в GEO_GIS_CLIENT_NETS: {n}")
        self.rl = RateLimiter({
            "tile": (_env_f("GEO_RATE_TILE", 120), _env_f("GEO_BURST_TILE", 1200)),
            "data": (_env_f("GEO_RATE_DATA", 8), _env_f("GEO_BURST_DATA", 200)),
            "heavy": (_env_f("GEO_RATE_HEAVY", 0.5), _env_f("GEO_BURST_HEAVY", 15)),
            "pass": (0.2, 20),
        })
        self.ban_strikes = int(_env_f("GEO_BAN_STRIKES", 60))
        self.ban_seconds = int(_env_f("GEO_BAN_SECONDS", 900))
        self.strikes = {}      # ip -> [count, window_start]
        self.banned = {}       # ip -> until
        self.lock = threading.Lock()
        self.session_cookie = session_cookie
        self.session_max_age = session_max_age
        self._signer = None
        try:
            from itsdangerous import TimestampSigner
            if secret_key:
                self._signer = TimestampSigner(str(secret_key))
        except Exception:
            self._signer = None
        self._admin_cache = TTLCache(maxsize=2048, ttl=10)
        self.stats = {"denied_pass": 0, "denied_nav": 0, "rate_limited": 0, "rejected": 0, "bans": 0}
        log.info(f"[geo_guard] mode={self.mode} wfs_max={self.wfs_max} pass_ttl={self.ttl}s")

    # ── идентификация ──
    def _ip(self, scope, h):
        client = scope.get("client")
        direct = client[0] if client else "unknown"
        if direct in self.trusted:
            rip = h.get("x-real-ip")
            if rip:
                return rip.strip()
            fwd = h.get("x-forwarded-for")
            if fwd:
                return fwd.split(",")[0].strip()
        return direct

    def _is_https(self, scope, h):
        if scope.get("scheme") == "https":
            return True
        client = scope.get("client")
        return bool(client and client[0] in self.trusted and h.get("x-forwarded-proto", "").lower() == "https")

    def _is_admin(self, cookies):
        raw = cookies.get(self.session_cookie)
        if not raw or not self._signer:
            return False
        hit = self._admin_cache.get(raw)
        if hit is not None:
            return hit
        ok = False
        try:
            data = self._signer.unsign(raw.encode(), max_age=self.session_max_age)
            sess = json.loads(base64.b64decode(data))
            # права админа — только после доп. пароля (admin_stepup.py)
            ok = bool(sess.get("user_id")) and float(sess.get("adm2_until", 0) or 0) > time.time()
        except Exception:
            ok = False
        self._admin_cache.put(raw, ok)
        return ok

    def _in_gis_nets(self, ip):
        if not self.gis_nets:
            return False
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in n for n in self.gis_nets)

    # ── пропуск ──
    def _sig(self, exp, ip, ua):
        uah = hashlib.sha256(ua.encode("utf-8", "ignore")).hexdigest()[:16]
        mac = hmac.new(self.key, f"{exp}|{ip}|{uah}".encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac[:18]).decode().rstrip("=")

    def make_pass(self, ip, ua):
        exp = int(time.time()) + self.ttl
        return f"{exp}.{self._sig(exp, ip, ua)}"

    def check_pass(self, token, ip, ua):
        """→ остаток жизни в секундах (>0) или 0 если недействителен."""
        try:
            exp_s, sig = token.split(".", 1)
            exp = int(exp_s)
        except Exception:
            return 0
        left = exp - int(time.time())
        if left <= 0 or left > self.ttl + 60:
            return 0
        if not hmac.compare_digest(sig, self._sig(exp, ip, ua)):
            return 0
        return left

    def _pass_cookie(self, ip, ua, https):
        v = f"gp_pass={self.make_pass(ip, ua)}; Path=/; Max-Age={self.ttl}; HttpOnly; SameSite=Lax"
        if https:
            v += "; Secure"
        return v.encode("latin-1")

    # ── бан/страйки ──
    def _strike(self, ip):
        now = time.time()
        with self.lock:
            c = self.strikes.get(ip)
            if not c or now - c[1] > 600:
                c = self.strikes[ip] = [0, now]
            c[0] += 1
            if c[0] >= self.ban_strikes and ip not in self.protected:
                self.banned[ip] = now + self.ban_seconds
                self.strikes.pop(ip, None)
                self.stats["bans"] += 1
                log.warning(f"[geo_guard] BAN {ip} на {self.ban_seconds} с: массовые запросы данных (похоже на скрейпинг)")
            if len(self.strikes) > 10000:
                self.strikes.clear()

    def _is_banned(self, ip):
        until = self.banned.get(ip)
        if not until:
            return False
        if time.time() > until:
            with self.lock:
                self.banned.pop(ip, None)
            return False
        return True

    def ban_list(self):
        now = time.time()
        return {ip: int(t - now) for ip, t in list(self.banned.items()) if t > now}

    def unban(self, ip):
        with self.lock:
            self.banned.pop(ip, None)
            self.strikes.pop(ip, None)

    # ── классификация ──
    def _classify(self, path):
        if path in WMS_PROXY_PATHS or path in WFS_PROXY_PATHS or path in OWN_OGC_PATHS:
            return "ogc"
        if path.startswith(TILE_PREFIXES) or _MBTILES_TILE_RE.match(path):
            return "tile"
        if path in DATA_PATHS or path.startswith(DATA_PREFIXES):
            return "data"
        return None

    # ── ASGI ──
    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or self.mode == "off":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        h = _hdrs(scope)
        ip = self._ip(scope, h)
        ua = h.get("user-agent", "")
        https = self._is_https(scope, h)
        cookies = _cookies(h)
        enforce = self.mode == "enforce"

        if path == "/api/geo/pass":
            return await self._serve_pass(scope, send, h, ip, ua, https, cookies)

        group = self._classify(path)
        admin = False
        kind = None
        if group:
            admin = self._is_admin(cookies)
            privileged = admin or ip in self.protected
            sfs = h.get("sec-fetch-site", "")
            gis_client = path in OWN_OGC_PATHS and self._in_gis_nets(ip) and not sfs
            # 0) бан
            if self._is_banned(ip) and not privileged:
                if enforce:
                    return await _send_simple(send, 403, _json({"error": "Доступ к данным временно ограничен"}))
            # 1) кросс-сайт и прямое открытие в адресной строке
            if not privileged and not gis_client:
                if sfs == "cross-site":
                    self.stats["denied_nav"] += 1
                    if enforce:
                        return await _send_simple(send, 403, _json({"error": "Запрос с чужого сайта запрещён"}))
                if h.get("sec-fetch-mode") == "navigate" and h.get("sec-fetch-dest", "document") in ("document", "iframe") \
                        and group in ("ogc", "data") and method == "GET" and not path.startswith("/api/vector/"):
                    self.stats["denied_nav"] += 1
                    if enforce:
                        body = ("<!doctype html><meta charset=utf-8><title>Геопортал</title>"
                                "<p style='font:16px sans-serif;margin:40px'>Прямой просмотр данных геосервиса "
                                "отключён. Откройте <a href='/'>карту портала</a>.</p>").encode("utf-8")
                        return await _send_simple(send, 403, body, "text/html; charset=utf-8")
            # 2) пропуск
            if not privileged and not gis_client:
                tok = cookies.get("gp_pass", "")
                if not tok or not self.check_pass(tok, ip, ua):
                    self.stats["denied_pass"] += 1
                    if enforce:
                        return await _send_simple(send, 403, _json({"error": "Нет доступа: откройте карту портала"}),
                                                  extra={"x-geo-guard": "pass"})
            # 3) фильтр OGC-параметров
            if group == "ogc":
                items = parse_qsl(scope.get("query_string", b"").decode("latin-1"),
                                  keep_blank_values=True, encoding="utf-8", errors="replace")
                try:
                    kind, new_items, changed = sanitize_ogc(path, items, admin=admin,
                                                            wfs_max=self.wfs_max, desktop_max=self.desktop_max)
                except Reject as r:
                    self.stats["rejected"] += 1
                    if enforce:
                        return await _send_simple(send, r.status, _json({"error": r.msg}))
                    kind, changed = "data", False
                else:
                    if kind == "edit" and not (admin or ip in self.edit_ips):
                        if enforce:
                            log.warning(f"[geo_guard] WFS-T запрещён для {ip}")
                            return await _send_simple(send, 403, _json({"error": "Редактирование запрещено"}))
                    if changed and enforce:
                        scope = dict(scope)
                        scope["query_string"] = urlencode(new_items).encode("ascii")
            else:
                kind = "tile" if group == "tile" else "data"
            # 4) лимит запросов
            if ip not in self.protected and kind in ("tile", "data", "heavy"):
                wait = self.rl.take(ip, kind, mult=5.0 if admin else 1.0)
                if wait > 0:
                    self.stats["rate_limited"] += 1
                    if kind != "tile":
                        self._strike(ip)
                    if enforce:
                        return await _send_simple(send, 429, _json({"error": "Слишком много запросов"}),
                                                  extra={"retry-after": max(1, int(wait + 0.999))})

        req_origin = h.get("origin", "").rstrip("/")
        is_page = method == "GET" and not group and not path.startswith(("/static/", "/uploads/", "/api/"))
        no_store = group == "ogc" and kind == "data"
        need_pass = False
        if is_page:
            tok = cookies.get("gp_pass", "")
            left = self.check_pass(tok, ip, ua) if tok else 0
            need_pass = left < self.ttl / 2
        hide_5xx = not admin
        state = {"buffer": None, "start": None}

        async def _send(message):
            t = message["type"]
            if t == "http.response.start":
                status = message["status"]
                headers = []
                ctype = ""
                for k, v in message.get("headers", []):
                    kl = k.lower()
                    if kl == b"server":
                        continue
                    if kl == b"access-control-allow-origin":
                        vv = v.decode("latin-1").rstrip("/")
                        if vv == "*" or vv not in self.allowed_origins or vv != req_origin:
                            continue
                    if kl == b"content-type":
                        ctype = v.decode("latin-1").lower()
                    if no_store and kl in (b"cache-control", b"x-accel-expires", b"expires"):
                        continue
                    headers.append((k, v))
                if no_store:
                    headers.append((b"cache-control", b"private, no-store, max-age=0"))
                    headers.append((b"x-accel-expires", b"0"))
                if need_pass and status == 200 and ctype.startswith("text/html"):
                    headers.append((b"set-cookie", self._pass_cookie(ip, ua, https)))
                if hide_5xx and status >= 500 and ("json" in ctype or "text/plain" in ctype):
                    state["start"] = {"type": t, "status": status, "headers": headers}
                    state["buffer"] = []
                    return
                message = dict(message)
                message["headers"] = headers
                return await send(message)
            if t == "http.response.body" and state["buffer"] is not None:
                state["buffer"].append(message.get("body", b""))
                if message.get("more_body"):
                    return
                raw = b"".join(state["buffer"])
                log.warning(f"[geo_guard] 5xx {path}: {raw[:300]!r}")
                body = _json({"detail": "Внутренняя ошибка сервера. Попробуйте позже."})
                st = state["start"]
                hdrs = [(k, v) for k, v in st["headers"] if k.lower() not in (b"content-length", b"content-type")]
                hdrs += [(b"content-type", b"application/json; charset=utf-8"),
                         (b"content-length", str(len(body)).encode())]
                await send({"type": "http.response.start", "status": st["status"], "headers": hdrs})
                return await send({"type": "http.response.body", "body": body})
            return await send(message)

        return await self.app(scope, receive, _send)

    async def _serve_pass(self, scope, send, h, ip, ua, https, cookies):
        if h.get("sec-fetch-site", "same-origin") not in ("same-origin", "none", "same-site"):
            return await _send_simple(send, 403, _json({"error": "forbidden"}))
        if self._is_banned(ip):
            return await _send_simple(send, 403, _json({"error": "Доступ к данным временно ограничен"}))
        if self.rl.take(ip, "pass") > 0:
            return await _send_simple(send, 429, _json({"error": "Слишком много запросов"}), extra={"retry-after": 30})
        body = _json({"ok": True, "ttl": self.ttl})
        headers = [(b"content-type", b"application/json; charset=utf-8"),
                   (b"content-length", str(len(body)).encode()),
                   (b"cache-control", b"no-store"),
                   (b"set-cookie", self._pass_cookie(ip, ua, https))]
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        await send({"type": "http.response.body", "body": body})


# ─────────────────── ASGI-версии заголовочных middleware ────────────────────
class SecurityHeadersASGI:
    """То же, что SecurityMiddleware из app.py, но без BaseHTTPMiddleware."""

    def __init__(self, app, *, headers: dict, forbidden_suffixes=(), forbidden_dirs=()):
        self.app = app
        self.headers = [(k.lower().encode(), v.encode("latin-1")) for k, v in headers.items()]
        self.names = {k for k, _ in self.headers}
        self.suffixes = tuple(forbidden_suffixes)
        self.dirs = tuple(forbidden_dirs)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        low = scope.get("path", "").lower()
        if low.startswith(("/static/", "/uploads/")):
            if self.suffixes and low.endswith(self.suffixes):
                return await _send_simple(send, 404, b"Not Found", "text/plain")
            parts = [p for p in low.split("/") if p]
            if any(seg.split(" ")[0] in self.dirs for seg in parts[1:-1]):
                return await _send_simple(send, 404, b"Not Found", "text/plain")
        if ("/." in low or ".." in low) and not low.startswith("/.well-known/"):
            return await _send_simple(send, 404, b"Not Found", "text/plain")

        async def _send(message):
            if message["type"] == "http.response.start":
                hs = list(message.get("headers", []))
                present = {k.lower() for k, _ in hs}
                for k, v in self.headers:
                    if k not in present:
                        hs.append((k, v))
                ct = next((v for k, v in hs if k.lower() == b"content-type"), b"")
                if ct.startswith(b"text/html") and b"cache-control" not in present:
                    hs.append((b"cache-control", b"no-store, must-revalidate"))
                message = dict(message)
                message["headers"] = hs
            await send(message)

        return await self.app(scope, receive, _send)


class TileCacheHeadersASGI:
    """То же, что NoCookieTileMiddleware: у тайлов нет Set-Cookie и есть public-кэш."""
    TILE_PATHS = ("/geoserver_wms_proxy", "/belgosles_wms_proxy", "/wms", "/tiles/", "/dzz-wms-proxy")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not scope.get("path", "").startswith(self.TILE_PATHS):
            return await self.app(scope, receive, send)
        qs = scope.get("query_string", b"").lower()
        is_gfi = b"request=getfeatureinfo" in qs or b"request=getfeature&" in qs or qs.endswith(b"request=getfeature")

        async def _send(message):
            if message["type"] == "http.response.start":
                hs = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"set-cookie"]
                status = message["status"]
                cc = next((v for k, v in hs if k.lower() == b"cache-control"), None)
                xae = next((v for k, v in hs if k.lower() == b"x-accel-expires"), None)
                if not (is_gfi or status >= 400 or xae == b"0"):
                    if cc is None or b"no-" in cc:
                        hs = [(k, v) for k, v in hs if k.lower() != b"cache-control"]
                        hs.append((b"cache-control", b"public, max-age=86400, s-maxage=86400"))
                message = dict(message)
                message["headers"] = hs
            await send(message)

        return await self.app(scope, receive, _send)
