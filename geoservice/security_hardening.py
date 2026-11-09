# -*- coding: utf-8 -*-
"""
security_hardening.py — защитный слой геосервиса (v16).

Подключается из app.py одной строкой (см. раздел «[SEC v16]» в конце app.py):

    import security_hardening as _sh
    app.add_middleware(_sh.HardeningASGI, trusted_proxies=..., allowed_origins=...)

Что делает (чистый ASGI, без BaseHTTPMiddleware — почти нулевая стоимость на тайл):
  1. Запрещает опасные HTTP-методы (TRACE/TRACK/CONNECT/DEBUG/PROPFIND …).
  2. Отсекает «грязные» пути ДО маршрутизации: NUL-байт, обратный слеш,
     сегменты «..», кодированные «%2e%2e», «%2f» и «%5c», слишком длинный URL/query.
  3. Проверяет заголовок Host (формат; при ALLOWED_HOSTS — список разрешённых).
  4. CSRF-барьер для cookie-сессий: изменяющие запросы (POST/PUT/PATCH/DELETE)
     с чужим Origin, Origin: null или Sec-Fetch-Site: cross-site → 403.
  5. Лимиты размера тела запроса по путям (по Content-Length сразу, а для
     chunked — по факту чтения) → 413 без чтения гигабайтов в память.
  6. Ограничение частоты (per-IP) для входа, токенов, загрузок, тяжёлых выгрузок → 429.
  7. Ответы: no-store для персональных API, CSP sandbox для HTML/SVG/XML,
     пришедших из прокси/вложений/загрузок (защита от stored-XSS).
  8. Счётчики блокировок — stats() (для /api/admin/security/stats).

Плюс функции для обработчиков: safe_join, sanitize_filename, save_upload
(потоковая запись с лимитом), parse_xml_safely (без DOCTYPE/ENTITY — XXE и
«billion laughs»), attachment_headers, check_proxy_url, safe_proxy_media_type,
sanitize_event_payload, wfs_transaction_allowed.

Все параметры переопределяются переменными окружения (см. README_DEPLOY_RU.md).
"""
from __future__ import annotations

import base64
import hmac
import logging
import os
import re
import threading
import time
import unicodedata
from collections import deque
from typing import Iterable, Optional
from urllib.parse import quote, urlsplit
from xml.sax.saxutils import escape as _xml_escape

log = logging.getLogger("security")


# ─────────────────────────────────────────────────────────────────────────────
# Утилиты окружения
# ─────────────────────────────────────────────────────────────────────────────
def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_list(name: str) -> list:
    return [x.strip() for x in (os.getenv(name) or "").split(",") if x.strip()]


MB = 1024 * 1024


# ─────────────────────────────────────────────────────────────────────────────
# 1. ПУТИ И ИМЕНА ФАЙЛОВ
# ─────────────────────────────────────────────────────────────────────────────
_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def safe_join(base: str, *parts: str) -> Optional[str]:
    """Соединяет base и части пути. Возвращает абсолютный путь ВНУТРИ base
    или None, если путь пытается выйти наружу:
      «../», абсолютный путь («/etc/passwd», «C:/Windows»), UNC («//host/share»),
      NUL-байт, обратный слеш как разделитель (Windows).
    Проверка лексическая (как werkzeug.safe_join): симлинки внутри base,
    созданные администратором, продолжают работать."""
    if not base:
        return None
    rel_parts = []
    for p in parts:
        if p is None:
            return None
        s = str(p)
        if "\x00" in s:
            return None
        s = s.replace("\\", "/")
        if s.startswith("//") or _DRIVE_RE.match(s):
            return None
        rel_parts.append(s.lstrip("/"))
    rel = "/".join(x for x in rel_parts if x)
    if any(seg == ".." for seg in rel.split("/")):
        return None
    base_abs = os.path.abspath(base)
    cand = os.path.abspath(os.path.join(base_abs, rel)) if rel else base_abs
    try:
        if os.path.commonpath([os.path.normcase(base_abs), os.path.normcase(cand)]) != os.path.normcase(base_abs):
            return None
    except ValueError:  # разные диски Windows
        return None
    return cand


_WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
_BAD_NAME_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]+')


def sanitize_filename(name: str, default: str = "file", max_len: int = 150, ascii_only: bool = False) -> str:
    """Безопасное имя файла: только базовое имя (без каталогов), без управляющих
    и запрещённых в Windows символов, без ведущих точек и зарезервированных
    имён (CON, NUL, COM1 …). Кириллица сохраняется (ascii_only=False)."""
    name = unicodedata.normalize("NFC", str(name or ""))
    name = name.replace("\\", "/").split("/")[-1]
    name = _BAD_NAME_CHARS.sub("_", name).strip().strip(".")
    if ascii_only:
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    if not name:
        name = default
    stem, ext = os.path.splitext(name)
    if not stem or stem.lower() in _WIN_RESERVED:
        stem = (stem or default) + "_"
    ext = re.sub(r"[^A-Za-z0-9.]", "", ext)[:12]
    stem = stem[: max(1, max_len - len(ext))]
    return stem + ext


def safe_ext(name: str, allowed: Optional[Iterable[str]] = None, default: str = "") -> str:
    """Расширение файла из [A-Za-z0-9]{1,10}; при allowed — только из списка."""
    ext = os.path.splitext(str(name or ""))[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", ext or ""):
        return default
    if allowed is not None and ext not in {e.lower() for e in allowed}:
        return default
    return ext


class UploadTooLarge(Exception):
    pass


async def save_upload(upload, dest_path: str, max_bytes: int, chunk_size: int = 1024 * 1024) -> int:
    """Потоковая запись UploadFile на диск с лимитом размера.
    Раньше обработчики делали `await file.read()` — файл целиком в RAM
    (×2 при записи) и синхронная запись блокировала event loop.
    Возвращает число записанных байт; при превышении — удаляет недописанный
    файл и бросает HTTPException(413)."""
    from fastapi import HTTPException
    from starlette.concurrency import run_in_threadpool

    def _copy():
        written = 0
        src = upload.file
        try:
            src.seek(0)
        except Exception:
            pass
        with open(dest_path, "wb") as out:
            while True:
                buf = src.read(chunk_size)
                if not buf:
                    break
                written += len(buf)
                if max_bytes and written > max_bytes:
                    raise UploadTooLarge()
                out.write(buf)
        return written

    try:
        return await run_in_threadpool(_copy)
    except UploadTooLarge:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise HTTPException(413, f"Файл больше допустимого ({max_bytes // MB} МБ)")
    except Exception:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise


# ─────────────────────────────────────────────────────────────────────────────
# 2. XML (WFS-T): без DOCTYPE/ENTITY — нет XXE и «billion laughs»
# ─────────────────────────────────────────────────────────────────────────────
_DTD_RE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.I)


class UnsafeXML(ValueError):
    pass


def parse_xml_safely(data: bytes, max_bytes: int = 10 * MB):
    """Разбор XML от клиента. DOCTYPE/ENTITY запрещены полностью (WFS они
    не нужны) — это закрывает XXE (чтение файлов сервера, SSRF) и
    экспоненциальное раскрытие сущностей. Если установлен defusedxml —
    используется он (второй рубеж)."""
    if data is None:
        raise UnsafeXML("пустой XML")
    if len(data) > max_bytes:
        raise UnsafeXML("XML слишком большой")
    if _DTD_RE.search(data[:65536]) or _DTD_RE.search(data):
        raise UnsafeXML("DOCTYPE/ENTITY запрещены")
    try:
        from defusedxml.ElementTree import fromstring as _fs  # type: ignore
        return _fs(data, forbid_dtd=True)
    except ImportError:
        import xml.etree.ElementTree as ET
        return ET.fromstring(data)


def xml_text(value) -> str:
    """Экранирование значения для вставки в XML-ответ (имена слоёв и т.п.)."""
    return _xml_escape("" if value is None else str(value), {'"': "&quot;", "'": "&apos;"})


# ─────────────────────────────────────────────────────────────────────────────
# 3. ОТДАЧА ПОЛЬЗОВАТЕЛЬСКИХ ФАЙЛОВ (вложения сообщений и т.п.)
# ─────────────────────────────────────────────────────────────────────────────
INLINE_SAFE_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "application/pdf"}
_EXT_FOR_MIME = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
    "application/pdf": ".pdf", "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt", "text/csv": ".csv", "application/zip": ".zip", "application/x-zip-compressed": ".zip",
}


def ext_for_mime(mime: str, fallback_name: str = "") -> str:
    """Расширение сохраняемого файла выводится из РАЗРЕШЁННОГО MIME, а не из
    имени от клиента: «photo.html» с типом image/png сохранится как .png."""
    return _EXT_FOR_MIME.get((mime or "").lower(), "") or (".bin" if fallback_name else ".bin")


def content_disposition(filename: str, inline: bool = False) -> str:
    """RFC 6266/5987: корректно для кириллицы и без инъекции заголовков."""
    fn = sanitize_filename(filename or "file")
    ascii_fn = re.sub(r"[^A-Za-z0-9._-]+", "_", fn) or "file"
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_fn}\"; filename*=UTF-8''{quote(fn)}"


def attachment_headers(filename: str, mime: str) -> tuple:
    """(media_type, headers) для безопасной отдачи пользовательского файла.
    Картинки/PDF — inline (просмотр в чате), всё остальное — только скачивание
    как application/octet-stream. Всегда nosniff и CSP sandbox: даже если
    внутри окажется HTML/SVG со скриптом, он не выполнится в origin портала."""
    m = (mime or "").lower()
    inline = m in INLINE_SAFE_MIME
    media = m if m in _EXT_FOR_MIME else "application/octet-stream"
    if not inline:
        media = "application/octet-stream"
    headers = {
        "Content-Disposition": content_disposition(filename, inline=inline),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if media == "application/pdf":
        # встроенный просмотрщик PDF в Chrome не работает в sandbox-документе;
        # PDF не исполняет JS в origin портала — остаётся общий CSP приложения
        headers.pop("Content-Security-Policy")
    return media, headers


# ─────────────────────────────────────────────────────────────────────────────
# 4. ПРОКСИ ВНЕШНИХ ТАЙЛОВ (SSRF)
# ─────────────────────────────────────────────────────────────────────────────
_PROXY_ALLOWED_PORTS = {None, 80, 443, 8080, 8081, 9090, 2052}
_PROXY_BLOCKED_PATH = re.compile(r"/(rest|web|j_spring_security|manager|admin|actuator|gwc/rest)(/|$|\?)", re.I)
_PROXY_MEDIA_OK = re.compile(r"^(image/(png|jpeg|jpg|gif|webp)|application/(x-protobuf|vnd\.mapbox-vector-tile|json|geo\+json|vnd\.ogc\.se_xml|xml)|text/xml)$", re.I)


def check_proxy_url(url: str, allowed_hosts: set) -> tuple:
    """(ok, причина). Разрешены только http/https, хост из белого списка,
    стандартные порты ГИС-сервисов, без логина в URL и без служебных путей
    (/rest, /web — админка и REST GeoServer)."""
    try:
        p = urlsplit(url)
    except ValueError:
        return False, "некорректный URL"
    if p.scheme not in ("http", "https"):
        return False, "только HTTP/HTTPS"
    if p.username or p.password or "@" in (p.netloc or ""):
        return False, "учётные данные в URL запрещены"
    host = (p.hostname or "").lower().rstrip(".")
    if host not in allowed_hosts:
        return False, "хост не разрешён"
    try:
        port = p.port
    except ValueError:
        return False, "некорректный порт"
    if port not in _PROXY_ALLOWED_PORTS:
        return False, "порт не разрешён"
    if _PROXY_BLOCKED_PATH.search(p.path or "/"):
        return False, "служебный путь запрещён"
    return True, ""


def safe_proxy_media_type(ct: str) -> str:
    """Тип содержимого из чужого сервера отдаём только из белого списка —
    иначе HTML/SVG с чужого хоста исполнился бы в origin портала."""
    base = (ct or "").split(";")[0].strip().lower()
    return base if _PROXY_MEDIA_OK.match(base or "") else "application/octet-stream"


def read_limited(resp, max_bytes: int, chunk: int = 65536) -> bytes:
    """Чтение ответа requests с ограничением размера (защита памяти)."""
    out = bytearray()
    for part in resp.iter_content(chunk):
        out += part
        if len(out) > max_bytes:
            raise ValueError("ответ апстрима слишком большой")
    return bytes(out)


# ─────────────────────────────────────────────────────────────────────────────
# 5. СОБЫТИЯ СИНХРОНИЗАЦИИ (webhook → SSE всем клиентам)
# ─────────────────────────────────────────────────────────────────────────────
_EVT_RE = re.compile(r"[^A-Za-z0-9_.:-]")


def sanitize_event_payload(payload) -> dict:
    """Webhook ArcGIS раньше пересылал ВСЁ тело запроса всем открытым вкладкам
    (SSE). Теперь — только тип события и id слоя, без произвольного HTML."""
    if not isinstance(payload, dict):
        return {"eventType": ""}
    et = _EVT_RE.sub("", str(payload.get("eventType", "")))[:64]
    return {"eventType": et}


def webhook_secret_ok(request) -> bool:
    """Если задан ARCGIS_WEBHOOK_SECRET — требуем его в X-Webhook-Secret или ?secret=."""
    secret = os.getenv("ARCGIS_WEBHOOK_SECRET", "")
    if not secret:
        return True
    got = request.headers.get("x-webhook-secret") or request.query_params.get("secret") or ""
    return hmac.compare_digest(got.encode(), secret.encode())


# ─────────────────────────────────────────────────────────────────────────────
# 6. WFS-T (изменение слоёв из ArcGIS/QGIS)
# ─────────────────────────────────────────────────────────────────────────────
def wfs_transaction_allowed(request, is_admin: bool) -> tuple:
    """(ok, http_status, причина). Транзакции WFS (insert/update/delete слоёв)
    раньше принимались от КОГО УГОДНО. Теперь:
      • администратор портала (сессия + доп. пароль) из браузера своего сайта;
      • настольная ГИС — HTTP Basic (WFS_T_USER/WFS_T_PASSWORD) или
        токен (X-WFS-Token / ?token= = WFS_T_TOKEN).
    WFS_T_ENABLED=0 выключает транзакции совсем."""
    if not _env_bool("WFS_T_ENABLED", True):
        return False, 403, "WFS-T отключён на сервере"
    if is_admin and same_origin_request(request):
        return True, 200, "admin"
    token = os.getenv("WFS_T_TOKEN", "")
    got = request.headers.get("x-wfs-token") or request.query_params.get("token") or ""
    if token and got and hmac.compare_digest(got.encode(), token.encode()):
        return True, 200, "token"
    user, pwd = os.getenv("WFS_T_USER", ""), os.getenv("WFS_T_PASSWORD", "")
    auth = request.headers.get("authorization", "")
    if user and pwd and auth[:6].lower() == "basic ":
        try:
            u, _, p = base64.b64decode(auth[6:].strip()).decode("utf-8").partition(":")
            if hmac.compare_digest(u.encode(), user.encode()) and hmac.compare_digest(p.encode(), pwd.encode()):
                return True, 200, "basic"
        except Exception:
            pass
    return False, 401, "Требуется авторизация для WFS-T"


def same_origin_request(request) -> bool:
    """True, если Origin/Referer совпадают с Host (или запрос без них — не браузер)."""
    host = (request.headers.get("host") or "").lower()
    origin = request.headers.get("origin") or ""
    if origin:
        return origin.lower() != "null" and urlsplit(origin).netloc.lower() == host
    ref = request.headers.get("referer") or ""
    if ref:
        return urlsplit(ref).netloc.lower() == host
    return request.headers.get("sec-fetch-site", "") in ("", "same-origin", "none")


# ─────────────────────────────────────────────────────────────────────────────
# 7. ОГРАНИЧЕНИЕ ЧАСТОТЫ
# ─────────────────────────────────────────────────────────────────────────────
class RateLimiter:
    """Скользящее окно per-key (IP + правило). Потокобезопасно, O(1) амортизированно,
    число ключей ограничено (старые вытесняются) — нельзя «раздуть» память.

    Состояние в памяти процесса: при нескольких воркерах uvicorn/gunicorn лимит
    действует на каждый воркер отдельно — задайте RATE_LIMIT_WORKERS=<число воркеров>,
    тогда лимит правила делится на это число (итоговый ≈ заданному)."""

    SWEEP_INTERVAL = 60.0

    def __init__(self, max_keys: int = 50000, workers: Optional[int] = None):
        self._hits: dict = {}
        self._lock = threading.Lock()
        self._max_keys = max_keys
        self._last_sweep = time.monotonic()
        self._max_window = 0.0
        self.workers = max(1, _env_int("RATE_LIMIT_WORKERS", 1) if workers is None else int(workers))

    def _sweep(self, now: float) -> None:
        """Раз в минуту (под локом) убирает ключи без свежих попаданий."""
        self._last_sweep = now
        edge = now - self._max_window
        for k in [k for k, q in self._hits.items() if not q or q[-1] <= edge]:
            del self._hits[k]

    def hit(self, key, limit: int, window: float, now: Optional[float] = None) -> tuple:
        now = time.monotonic() if now is None else now
        limit = max(1, limit // self.workers)
        with self._lock:
            if window > self._max_window:
                self._max_window = window
            if now - self._last_sweep >= self.SWEEP_INTERVAL:
                self._sweep(now)
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self._max_keys:
                    for k in list(self._hits.keys())[: max(1, self._max_keys // 10)]:
                        self._hits.pop(k, None)
                q = self._hits[key] = deque()
            edge = now - window
            while q and q[0] <= edge:
                q.popleft()
            if len(q) >= limit:
                return False, max(1, int(q[0] + window - now) + 1)
            q.append(now)
            return True, 0

    def reset(self):
        with self._lock:
            self._hits.clear()


# (метод или "*", префикс пути, лимит, окно сек, имя правила)
DEFAULT_RATE_RULES = [
    ("POST", "/login", 10, 60, "login"),
    ("POST", "/api/admin/stepup", 10, 60, "stepup"),
    ("POST", "/api/tokens/validate", 30, 60, "token"),
    ("GET", "/api/dzz/download", 30, 60, "token"),
    ("POST", "/api/download_token", 30, 60, "download"),
    ("POST", "/api/session/register", 10, 60, "register"),
    ("POST", "/api/session/submit_profile", 10, 60, "register"),
    ("POST", "/api/users/submit_form", 10, 60, "register"),
    ("POST", "/api/messages/send", 60, 60, "messages"),
    ("POST", "/api/messages/send_file", 20, 60, "upload"),
    ("POST", "/upload", 20, 60, "upload"),
    ("POST", "/upload_shp", 20, 60, "upload"),
    ("POST", "/upload_basemap", 10, 60, "upload"),
    ("POST", "/api/imagery/upload", 20, 60, "upload"),
    ("POST", "/api/mbtiles/upload", 10, 60, "upload"),
    ("POST", "/api/vector-layers", 20, 60, "upload"),
    ("POST", "/api/avatar/upload", 10, 60, "upload"),
    ("POST", "/api/wms/seed", 6, 60, "seed"),
    ("POST", "/api/tts", 30, 60, "cpu"),
    ("POST", "/api/generate_vacancy_doc", 20, 60, "cpu"),
    ("GET", "/download_zip*", 20, 60, "zip"),
    ("GET", "/api/download_catalog", 6, 60, "zip"),
    ("GET", "/api/vector/all/download", 6, 60, "zip"),
    ("POST", "/wfs", 60, 60, "wfs-t"),
    ("POST", "/api/sync/webhook", 120, 60, "webhook"),
    # [v19] ЛесоЛидар и привязка планов — тяжёлые задания (CPU, сеть), загрузка кусками
    ("POST", "/api/lesolidar/jobs", 20, 60, "cpu"),
    ("POST", "/api/lesolidar/demo", 6, 60, "cpu"),
    ("POST", "/api/lesolidar/upload/init", 30, 60, "upload"),
    ("POST", "/api/georef/jobs", 12, 60, "cpu"),
]

# Лимиты тела запроса: (префикс пути, байт). Самое длинное совпадение побеждает.
def default_body_limits() -> list:
    big = _env_int("UPLOAD_MAX_MB", 4096) * MB
    return sorted([
        ("/", _env_int("BODY_MAX_DEFAULT_MB", 2) * MB),
        ("/login", 64 * 1024),
        ("/api/activity/", 512 * 1024),
        ("/api/avatar/upload", 12 * MB),
        ("/api/messages/send_file", 105 * MB),
        ("/api/messages/send", 1 * MB),
        ("/wfs", 20 * MB),
        ("/api/vector/", 50 * MB),
        ("/api/vector-layers", 512 * MB),
        ("/api/upload_shp", 512 * MB),
        ("/api/admin/manuals/", big),           # PDF/Word руководств (manuals_api)
        ("/api/manuals-editions/", (_env_int("MANUALS_EDITION_MAX_MB", 40) + 1) * MB),  # [v20.10] веб-редакции с картинками
        ("/api/crs-shift/", big),               # ZIP + GeoJSON (crs_shift)
        ("/upload_shp", 512 * MB),
        ("/upload", big),
        ("/upload_basemap", big),
        ("/api/imagery/upload", big),
        ("/api/mbtiles/upload", big),
        ("/api/crs/", big),
        ("/api/forest3d/las/upload", 0),        # 0 = без лимита (LAS > 4 ГБ, чанки в forest3d_las)
        ("/api/lesolidar/upload/", 40 * MB),    # [v19] куски LAS/LAZ по 32 МиБ (lesolidar_bridge)
        ("/api/lesolidar/boundary", 26 * MB),   # граница участка: KML / GeoJSON / ZIP с SHP
        ("/api/lesolidar/", 16 * MB),           # задания (JSON с границей из сцены)
        ("/api/georef/jobs", _env_int("GEOREF_MAX_UPLOAD_MB", 1024) * MB + MB),  # сканы / PDF / GeoTIFF
        ("/geoserver-proxy/", 100 * MB),
        ("/api/generate_vacancy_doc", 256 * 1024),
        ("/api/layer_prefs/save", 512 * 1024),
        ("/api/dzz_order/save", 1 * MB),
        ("/api/print_queue/", 5 * MB),
        ("/api/ecp/save", 5 * MB),
        ("/api/sync/webhook", 256 * 1024),
        ("/api/wms/seed", 64 * 1024),
        ("/api/tts", 64 * 1024),
    ], key=lambda r: -len(r[0].rstrip("*")))


# ─────────────────────────────────────────────────────────────────────────────
# 8. ASGI-MIDDLEWARE
# ─────────────────────────────────────────────────────────────────────────────
_BAD_METHODS = {"TRACE", "TRACK", "CONNECT", "DEBUG", "PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK", "SEARCH"}
_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
_HOST_RE = re.compile(r"^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253})(:[0-9]{1,5})?$")
_HOT_PREFIXES = ("/static/", "/tiles/", "/geoserver_wms_proxy", "/wms", "/api/mbtiles/", "/uploads/")
_RAW_BAD = re.compile(rb"(%00|\x00|\\|%5c|(^|/)(\.|%2e){2}(/|$|%2f|\?)|%2e%2e)", re.I)
_PRIVATE_PREFIXES = ("/api/users/me", "/api/session/", "/api/messages/", "/api/admin/", "/api/tokens/",
                     "/api/download_token", "/api/activity/", "/login", "/api/ecp/", "/api/print_queue")
_SANDBOX_PREFIXES = ("/uploads/", "/api/messages/file/", "/api/proxy-tile", "/belgosles_", "/geoserver_", "/dzz-wms-proxy", "/wms")
_ACTIVE_TYPES = ("text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "text/xsl")
_BLOCK_HEADERS = [(b"content-type", b"application/json; charset=utf-8"),
                  (b"x-content-type-options", b"nosniff"),
                  (b"x-frame-options", b"DENY"),
                  (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
                  (b"cache-control", b"no-store")]

_stats_lock = threading.Lock()
_stats: dict = {}


def _count(reason: str):
    with _stats_lock:
        _stats[reason] = _stats.get(reason, 0) + 1


def stats() -> dict:
    with _stats_lock:
        return dict(sorted(_stats.items()))


class HardeningASGI:
    def __init__(self, app, trusted_proxies: Iterable[str] = ("127.0.0.1", "::1"),
                 allowed_origins: Iterable[str] = (), exempt_ips: Iterable[str] = (),
                 rate_rules: Optional[list] = None, body_limits: Optional[list] = None,
                 csrf_exempt: Iterable[str] = ("/api/sync/webhook",)):
        self.app = app
        self.trusted = set(trusted_proxies or ())
        self.allowed_origins = {o.rstrip("/").lower() for o in (allowed_origins or ())}
        self.allowed_origins |= {o.rstrip("/").lower() for o in _env_list("ALLOWED_ORIGINS")}
        self.allowed_hosts = [h.lower() for h in _env_list("ALLOWED_HOSTS")]
        self.exempt_ips = set(exempt_ips or ()) | set(_env_list("RATE_LIMIT_EXEMPT_IPS"))
        self.rate_rules = list(DEFAULT_RATE_RULES if rate_rules is None else rate_rules)
        self.rate_enabled = _env_bool("RATE_LIMIT_ENABLED", True)
        self.body_limits = body_limits or default_body_limits()
        self.default_limit = next((lim for pfx, lim in self.body_limits if pfx == "/"), _env_int("BODY_MAX_DEFAULT_MB", 2) * MB)
        self.upload_limit = _env_int("UPLOAD_MAX_MB", 4096) * MB
        self.multipart_limit = _env_int("MULTIPART_DEFAULT_MB", 100) * MB
        self.csrf_exempt = tuple(csrf_exempt or ())
        self.max_url = _env_int("MAX_URL_LENGTH", 8192)
        self.max_query = _env_int("MAX_QUERY_LENGTH", 16384)
        self.limiter = RateLimiter()

    # ── helpers ─────────────────────────────────────────────────────────────
    @staticmethod
    def _headers(scope) -> dict:
        h = {}
        for k, v in scope.get("headers") or ():
            h.setdefault(k.decode("latin-1").lower(), v.decode("latin-1"))
        return h

    def _client_ip(self, scope, h) -> str:
        client = scope.get("client") or ("", 0)
        ip = client[0] or ""
        if ip in self.trusted:
            real = h.get("x-real-ip") or (h.get("x-forwarded-for") or "").split(",")[0]
            if real.strip():
                return real.strip()
        return ip

    def _host_ok(self, host: str) -> bool:
        if not host or len(host) > 260 or not _HOST_RE.match(host):
            return False
        if not self.allowed_hosts:
            return True
        name = host.lower()
        if not name.startswith("["):
            name = name.rsplit(":", 1)[0] if ":" in name else name
        for pat in self.allowed_hosts:
            if pat == "*" or name == pat or (pat.startswith("*.") and name.endswith(pat[1:])):
                return True
        return False

    @staticmethod
    def _hostname(netloc: str) -> str:
        n = (netloc or "").strip().lower()
        if n.startswith("["):
            return n.split("]")[0] + "]"
        return n.rsplit(":", 1)[0] if n.count(":") == 1 else n

    def _origin_ok(self, h: dict) -> bool:
        """Браузер всегда шлёт Origin в POST/PUT/PATCH/DELETE. Сравниваем имя хоста
        (без порта: nginx передаёт Host без порта) с Host и ALLOWED_ORIGINS."""
        host = self._hostname(h.get("x-forwarded-host") or h.get("host") or "")
        origin = (h.get("origin") or "").strip()
        if origin:
            o = origin.rstrip("/").lower()
            if o == "null":
                return False
            if o in self.allowed_origins:
                return True
            try:
                return self._hostname(urlsplit(o).netloc) == host
            except ValueError:
                return False
        if (h.get("sec-fetch-site") or "").lower() == "cross-site":
            return False
        ref = h.get("referer")
        if ref:
            try:
                rn = self._hostname(urlsplit(ref).netloc)
            except ValueError:
                return False
            return rn == host or any(self._hostname(urlsplit(a).netloc) == rn for a in self.allowed_origins)
        return True  # не браузер (ArcGIS, QGIS, curl) — их защищают авторизация и CSRF-токен обработчиков

    @staticmethod
    def _match(path: str, prefix: str) -> bool:
        """'/a/' — всё под /a/; '/a*' — любой путь, начинающийся с /a; '/a' — /a и /a/…"""
        if prefix == "/":
            return True
        if prefix.endswith("*"):
            return path.startswith(prefix[:-1])
        if prefix.endswith("/"):
            return path.startswith(prefix)
        return path == prefix or path.startswith(prefix + "/")

    def _body_limit(self, path: str, ctype: str = "") -> int:
        """Лимит тела: точное правило для пути, иначе — по типу содержимого.
        Файлы (multipart / octet-stream) в модулях без явного правила (руководства, сдвиг СК,
        тема оформления…) получают лимит загрузок UPLOAD_MAX_MB, а JSON/формы — BODY_MAX_DEFAULT_MB."""
        for prefix, limit in self.body_limits:
            if prefix == "/":
                continue
            if self._match(path, prefix):
                return limit
        ct = (ctype or "").lower()
        if ct.startswith(("multipart/form-data", "application/octet-stream")):
            # админские модули (руководства, тема оформления…) — как загрузки; прочие — как nginx (100 МБ)
            return self.upload_limit if path.startswith("/api/admin/") else self.multipart_limit
        return self.default_limit

    def _rate_rule(self, method: str, path: str):
        for m, prefix, limit, window, name in self.rate_rules:
            if (m == "*" or m == method) and self._match(path, prefix):
                return limit, window, name
        return None

    async def _reject(self, send, status: int, reason: str, message: str, extra=()):
        _count(reason)
        body = ('{"detail":"%s","reason":"%s"}' % (message.replace('"', "'"), reason)).encode("utf-8")
        await send({"type": "http.response.start", "status": status,
                    "headers": _BLOCK_HEADERS + [(b"content-length", str(len(body)).encode())] + list(extra)})
        await send({"type": "http.response.body", "body": body})

    # ── main ────────────────────────────────────────────────────────────────
    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        method = (scope.get("method") or "GET").upper()
        path = scope.get("path") or "/"
        raw = scope.get("raw_path") or path.encode("utf-8", "ignore")
        qs = scope.get("query_string") or b""
        h = self._headers(scope)

        if method in _BAD_METHODS:
            return await self._reject(send, 405, "method", "Метод запрещён", [(b"allow", b"GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")])
        if len(raw) > self.max_url or len(qs) > self.max_query:
            return await self._reject(send, 414, "uri_too_long", "Слишком длинный URL")
        if _RAW_BAD.search(raw) or "\x00" in path or "\\" in path or "/../" in path + "/" or path.endswith("/.."):
            log.warning("[sec] traversal attempt %s %r from %s", method, raw[:200], self._client_ip(scope, h))
            return await self._reject(send, 400, "path", "Некорректный путь")
        low_raw = raw.lower()
        if b"%2f" in low_raw and (low_raw.startswith(b"/uploads/") or low_raw.startswith(b"/static/")):
            return await self._reject(send, 404, "path", "Не найдено")
        if not self._host_ok(h.get("host", "")):
            return await self._reject(send, 400, "host", "Некорректный заголовок Host")

        ip = self._client_ip(scope, h)

        if method in _UNSAFE and not path.startswith(self.csrf_exempt) and not self._origin_ok(h):
            log.warning("[sec] cross-site %s %s from %s origin=%r", method, path, ip, h.get("origin") or h.get("referer"))
            return await self._reject(send, 403, "csrf_origin", "Запрос с чужого сайта отклонён")

        # горячие read-only пути: без скана правил частоты (тело у GET/HEAD и так не лимитируется)
        hot = method in ("GET", "HEAD") and path.startswith(_HOT_PREFIXES)
        if self.rate_enabled and not hot and ip not in self.exempt_ips:
            rule = self._rate_rule(method, path)
            if rule:
                ok, retry = self.limiter.hit((ip, rule[2]), rule[0], rule[1])
                if not ok:
                    log.warning("[sec] rate limit %s %s %s", ip, rule[2], path)
                    return await self._reject(send, 429, "rate_" + rule[2], "Слишком много запросов, повторите позже",
                                              [(b"retry-after", str(retry).encode())])

        limit = self._body_limit(path, h.get("content-type", "")) if method in _UNSAFE else 0
        if limit:
            cl = h.get("content-length")
            if cl is not None:
                try:
                    if int(cl) > limit:
                        return await self._reject(send, 413, "body_size", "Слишком большой запрос (лимит %d МБ)" % max(1, limit // MB))
                except ValueError:
                    return await self._reject(send, 400, "body_size", "Некорректный Content-Length")

        state = {"seen": 0, "exceeded": False, "replaced": False, "started": False}

        async def _send_413():
            state["replaced"] = True
            body = '{"detail":"Слишком большой запрос","reason":"body_size"}'.encode("utf-8")
            await send({"type": "http.response.start", "status": 413,
                        "headers": _BLOCK_HEADERS + [(b"content-length", str(len(body)).encode()),
                                                     (b"connection", b"close")]})
            await send({"type": "http.response.body", "body": body})

        async def _receive():
            msg = await receive()
            if limit and msg.get("type") == "http.request":
                state["seen"] += len(msg.get("body", b""))
                if state["seen"] > limit:
                    state["exceeded"] = True
                    _count("body_size")
                    return {"type": "http.disconnect"}
            return msg

        private = path.startswith(_PRIVATE_PREFIXES)
        sandbox = path.startswith(_SANDBOX_PREFIXES)

        async def _send(msg):
            t = msg["type"]
            if state["replaced"]:
                return
            if t == "http.response.start":
                if state["exceeded"]:
                    await _send_413()
                    return
                state["started"] = True
                headers = list(msg.get("headers") or [])
                names = {k.lower() for k, _ in headers}
                if private and b"cache-control" not in names:
                    headers.append((b"cache-control", b"private, no-store"))
                if sandbox:
                    ctype = b""
                    for k, v in headers:
                        if k.lower() == b"content-type":
                            ctype = v.lower()
                            break
                    if ctype.decode("latin-1").startswith(_ACTIVE_TYPES):
                        headers = [(k, v) for k, v in headers if k.lower() != b"content-security-policy"]
                        headers.append((b"content-security-policy", b"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"))
                headers = [(k, v) for k, v in headers if k.lower() not in (b"x-powered-by", b"server")]
                msg = dict(msg)
                msg["headers"] = headers
            await send(msg)

        if not limit:
            return await self.app(scope, receive, _send)
        try:
            await self.app(scope, _receive, _send)
        except Exception:
            # Тело оборвано нашим лимитом: обработчик получил http.disconnect и упал
            # (ClientDisconnect / ошибка парсинга). Это не ошибка сервера → 413, а не 500.
            if not state["exceeded"]:
                raise
            if not state["started"] and not state["replaced"]:
                await _send_413()
