# -*- coding: utf-8 -*-
"""
manuals_editor_api.py — сервер веб-редакций методичек (v20.10).

Редактор на странице /manuals (static/manuals-workspace.js) не трогает исходный Word/PDF:
правки публикуются отдельными «веб-редакциями» 1, 2, 3 …, прежние остаются в истории,
любую можно открыть и опубликовать заново. Без этого модуля страница показывала
«Чтение доступно, но сервер редакций не подключён… Установите модуль manuals_editor_api».

Маршруты (префикс /api/manuals-editions):
  GET  /_status               — готовность сервера редакций (диагностика, без данных);
  GET  /{fid}                 — последняя редакция файла {fid, revision, html, title, source_ver, saved_at};
                                 revision = 0 и html = null, если редакций ещё нет. Читать могут все,
                                 кто видит методички (как и сами файлы);
  PUT  /{fid}                 — опубликовать новую редакцию: JSON {html, title, source_ver, base_revision}.
                                 Только администратор (с доп. паролем) + CSRF-токен. Если base_revision
                                 не совпадает с последней редакцией (правили в другом окне) — 409;
  GET  /{fid}/history         — редакции файла, новые сверху {items:[{revision, saved_at, title, size}]} — админ;
  GET  /{fid}/revisions/{n}   — текст редакции n — администратор.

Хранение: instance/manuals_editions/<fid>/r000001.json …, index.json — список редакций.
Запись атомарная (временный файл + os.replace), публикация под файловой блокировкой —
безопасно при нескольких воркерах uvicorn. HTML очищается и на сервере (белый список тегов,
атрибутов и стилей — тот же, что в редакторе): <script>, on*-обработчики, javascript:-ссылки,
внешние картинки не сохраняются.

Настройки (.env, необязательные):
  MANUALS_EDITIONS_DIR    — папка редакций (по умолчанию instance/manuals_editions рядом с app.py);
  MANUALS_EDITION_MAX_MB  — предельный размер одной редакции с картинками, МБ (40);
  MANUALS_EDITIONS_KEEP   — сколько последних редакций одного файла хранить (100).

Подключение (app.py, после manuals_api):
  from manuals_editor_api import build_router as _build_manuals_editor_router
  app.include_router(_build_manuals_editor_router(base_dir=BASE_DIR, require_admin=require_admin,
                     verify_csrf=verify_csrf, logger=logger))
"""
from __future__ import annotations

import html as _html
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

VERSION = "20.10"
MB = 1024 * 1024
FID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$")
REV_FILE_RE = re.compile(r"^r(\d{6,9})\.json$")
NO_STORE = {"Cache-Control": "no-store"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ.get(name, "") or default))
    except (TypeError, ValueError):
        return default


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def check_fid(fid: str) -> str:
    fid = str(fid or "")
    if not FID_RE.match(fid) or ".." in fid:
        raise HTTPException(400, "Некорректный идентификатор файла методички")
    return fid


# ───────────────────────────── очистка HTML (как clean() в manuals-workspace.js) ─────────────────────────────
ALLOWED_TAGS = frozenset(
    "p div span br h1 h2 h3 h4 h5 h6 strong b em i u s strike sub sup ul ol li blockquote pre code hr "
    "table thead tbody tfoot tr td th caption colgroup col img a figure figcaption".split())
# удаляются вместе с содержимым
DROP_TAGS = frozenset(
    "script style iframe object embed svg math template noscript form button input textarea select "
    "meta link base head title frameset frame applet audio video canvas".split())
VOID_TAGS = frozenset("br hr img col wbr area input meta link base source track param embed frame".split())
STYLE_PROPS = (
    "text-align font-weight font-style text-decoration color background-color font-size font-family width "
    "height max-width border border-collapse vertical-align padding margin margin-left").split()
STYLE_BAD = re.compile(r"url|expression|import|behavior|binding|javascript|[<>\\{}@]|/\*", re.I)
NUM_ATTR = re.compile(r"^\d{1,4}%?$")
DATA_IMG = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$", re.I)
CTRL = re.compile(r"[\x00-\x20\x7f\\]")


def url_safe(value: str, image: bool) -> bool:
    v = (value or "").strip()
    if CTRL.search(v):
        return False
    try:
        d = unquote(v, errors="strict")
    except Exception:
        return False
    if image and DATA_IMG.match(v):
        return True
    if d.startswith("//") or "\\" in d or CTRL.search(d):
        return False
    if image:
        return bool(re.match(r"^/(api/manuals/|uploads/|static/)", d))
    return bool(re.match(r"^(https?:|mailto:|/(?!/)|#)", d, re.I))


def clean_style(value: str) -> str:
    out = []
    for part in (value or "").split(";"):
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k, v = k.strip().lower(), v.strip()
        if k in STYLE_PROPS and v and len(v) <= 200 and not STYLE_BAD.search(v):
            out.append(f"{k}: {v}")
    return "; ".join(out)


class _Cleaner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []
        self.stack: List[str] = []          # открытые разрешённые теги
        self.skip: Optional[str] = None     # удаляемый тег (вместе с содержимым)
        self.skip_depth = 0

    def _attrs(self, tag: str, attrs) -> str:
        res = []
        for k, v in attrs:
            k = (k or "").lower()
            v = "" if v is None else str(v)
            if k == "style":
                css = clean_style(v)
                if css:
                    res.append(("style", css))
            elif k == "src" and tag == "img":
                if url_safe(v, True):
                    res.append(("src", v.strip()))
            elif k == "href" and tag == "a":
                if url_safe(v, False):
                    res.append(("href", v.strip()))
            elif k in ("alt", "title"):
                res.append((k, v[:500]))
            elif k in ("width", "height", "colspan", "rowspan", "start") and NUM_ATTR.match(v):
                res.append((k, v))
        if tag == "a":
            res += [("rel", "noopener noreferrer"), ("target", "_blank")]
        return "".join(f' {k}="{_html.escape(v, quote=True)}"' for k, v in res)

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag == self.skip and tag not in VOID_TAGS:
                self.skip_depth += 1
            return
        if tag in DROP_TAGS:
            if tag not in VOID_TAGS:
                self.skip, self.skip_depth = tag, 1
            return
        if tag not in ALLOWED_TAGS:
            return                                   # тег снимается, содержимое остаётся
        self.out.append(f"<{tag}{self._attrs(tag, attrs)}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if tag in VOID_TAGS or self.skip or tag in DROP_TAGS or tag not in ALLOWED_TAGS:
            self.handle_starttag(tag, attrs)
            return
        self.handle_starttag(tag, attrs)             # <p/> → <p></p>
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag == self.skip:
                self.skip_depth -= 1
                if self.skip_depth <= 0:
                    self.skip, self.skip_depth = None, 0
            return
        if tag in VOID_TAGS or tag not in self.stack:
            return                                   # лишний закрывающий тег — пропускаем
        while self.stack:
            t = self.stack.pop()
            self.out.append(f"</{t}>")
            if t == tag:
                break

    def handle_data(self, data):
        if not self.skip and data:
            self.out.append(_html.escape(data, quote=False))

    def close_all(self) -> str:
        self.close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def clean_html(value: str) -> str:
    """Белый список тегов / атрибутов / стилей. Комментарии, doctype, обработчики событий удаляются."""
    p = _Cleaner()
    p.feed(value or "")
    return p.close_all()


# ───────────────────────────── хранилище ─────────────────────────────
class Conflict(Exception):
    def __init__(self, current: int):
        super().__init__(current)
        self.current = current


class Store:
    def __init__(self, root: Path, keep: int = 100, log=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.keep = max(1, keep)
        self.log = log
        self._lock = threading.Lock()

    def fdir(self, fid: str) -> Path:
        return self.root / check_fid(fid)

    @staticmethod
    def _write_json(path: Path, data: Any) -> None:
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        for i in range(20):                          # Windows: файл может быть открыт читателем
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.05 * (i + 1))
        os.replace(tmp, path)

    @staticmethod
    def _read_json(path: Path) -> Optional[Dict[str, Any]]:
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            return d if isinstance(d, dict) else None
        except (OSError, ValueError):
            return None

    def revisions(self, fid: str) -> List[int]:
        d = self.fdir(fid)
        if not d.is_dir():
            return []
        out = []
        for p in d.iterdir():
            m = REV_FILE_RE.match(p.name)
            if m:
                out.append(int(m.group(1)))
        return sorted(out)

    def read(self, fid: str, n: int) -> Optional[Dict[str, Any]]:
        if n < 1:
            return None
        return self._read_json(self.fdir(fid) / f"r{n:06d}.json")

    def latest(self, fid: str) -> Optional[Dict[str, Any]]:
        for n in reversed(self.revisions(fid)):
            rec = self.read(fid, n)
            if rec:
                return rec
        return None

    def history(self, fid: str) -> List[Dict[str, Any]]:
        d = self.fdir(fid)
        revs = self.revisions(fid)
        idx = self._read_json(d / "index.json") or {}
        items = {int(x.get("revision", 0)): x for x in idx.get("items", []) if isinstance(x, dict)}
        out = []
        for n in reversed(revs):
            it = items.get(n)
            if not it:                                # индекса нет / устарел — читаем файл редакции
                rec = self.read(fid, n) or {}
                it = {"revision": n, "saved_at": rec.get("saved_at"), "title": rec.get("title", ""),
                      "size": len(rec.get("html") or ""), "source_ver": rec.get("source_ver")}
            out.append({k: it.get(k) for k in ("revision", "saved_at", "title", "size", "source_ver")})
        return out

    # межпроцессная блокировка: lock-файл с O_EXCL (+ снятие «зависшей» старше 60 с)
    def _acquire(self, d: Path, timeout: float = 15.0) -> Path:
        lock = d / ".lock"
        t0 = time.time()
        while True:
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, f"{os.getpid()} {time.time():.0f}".encode())
                os.close(fd)
                return lock
            except FileExistsError:
                try:
                    if time.time() - lock.stat().st_mtime > 60:
                        lock.unlink()
                        continue
                except OSError:
                    pass
                if time.time() - t0 > timeout:
                    raise HTTPException(503, "Сервер редакций занят — повторите сохранение через несколько секунд")
                time.sleep(0.05)

    def save(self, fid: str, rec: Dict[str, Any], base_revision: Optional[int]) -> Dict[str, Any]:
        d = self.fdir(fid)
        d.mkdir(parents=True, exist_ok=True)
        with self._lock:
            lock = self._acquire(d)
            try:
                revs = self.revisions(fid)
                cur = revs[-1] if revs else 0
                if base_revision is not None and int(base_revision) != cur:
                    raise Conflict(cur)
                n = cur + 1
                rec = dict(rec, fid=fid, revision=n, saved_at=_now())
                self._write_json(d / f"r{n:06d}.json", rec)
                idx = self._read_json(d / "index.json") or {}
                items = [x for x in idx.get("items", []) if isinstance(x, dict) and int(x.get("revision", 0)) in set(revs)]
                items.append({"revision": n, "saved_at": rec["saved_at"], "title": rec.get("title", ""),
                              "size": len(rec.get("html") or ""), "source_ver": rec.get("source_ver"),
                              "by": rec.get("by")})
                for old in (revs + [n])[:-self.keep]:  # храним последние keep редакций
                    try:
                        (d / f"r{old:06d}.json").unlink()
                    except OSError:
                        pass
                keep_set = set((revs + [n])[-self.keep:])
                items = [x for x in items if int(x.get("revision", 0)) in keep_set]
                self._write_json(d / "index.json", {"fid": fid, "items": items})
                return rec
            finally:
                try:
                    lock.unlink()
                except OSError:
                    pass


def public(rec: Optional[Dict[str, Any]], fid: str) -> Dict[str, Any]:
    if not rec:
        return {"fid": fid, "revision": 0, "html": None, "title": None, "source_ver": None, "saved_at": None}
    return {k: rec.get(k) for k in ("fid", "revision", "html", "title", "source_ver", "saved_at")}


# ───────────────────────────── маршруты ─────────────────────────────
def build_router(*, base_dir: str, require_admin: Optional[Callable[[Request], Any]] = None,
                 is_admin: Optional[Callable[[Request], bool]] = None,
                 verify_csrf: Optional[Callable[[Request], None]] = None,
                 logger=None, workdir: Optional[str] = None, **_unused) -> APIRouter:
    root = Path(workdir or os.environ.get("MANUALS_EDITIONS_DIR") or os.path.join(base_dir, "instance", "manuals_editions"))
    store = Store(root, keep=_env_int("MANUALS_EDITIONS_KEEP", 100), log=logger)
    max_bytes = _env_int("MANUALS_EDITION_MAX_MB", 40) * MB
    r = APIRouter(prefix="/api/manuals-editions", tags=["manuals-editions"])
    r.store = store  # для тестов

    def admin(request: Request) -> str:
        if require_admin is not None:
            return str(require_admin(request) or "admin")   # 401 (+ X-Admin-Stepup) без входа / доп. пароля
        if is_admin is not None and is_admin(request):
            return "admin"
        raise HTTPException(401, "Требуется авторизация администратора")

    def log(msg: str) -> None:
        if logger:
            try:
                logger.info(msg)
            except Exception:
                pass

    @r.get("/_status")
    def status():
        return JSONResponse({"ready": True, "version": VERSION, "max_mb": max_bytes // MB}, headers=NO_STORE)

    @r.get("/{fid}")
    def get_edition(fid: str):
        fid = check_fid(fid)
        return JSONResponse(public(store.latest(fid), fid), headers=NO_STORE)

    @r.put("/{fid}")
    async def put_edition(fid: str, request: Request):
        fid = check_fid(fid)
        who = admin(request)
        if verify_csrf is not None:
            verify_csrf(request)
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > max_bytes + MB:
            raise HTTPException(413, f"Редакция больше {max_bytes // MB} МБ — уменьшите или удалите крупные иллюстрации")
        raw = await request.body()
        if len(raw) > max_bytes + MB:
            raise HTTPException(413, f"Редакция больше {max_bytes // MB} МБ — уменьшите или удалите крупные иллюстрации")
        def _process():
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
            except (UnicodeDecodeError, ValueError):
                raise HTTPException(400, "Ожидается JSON {html, title, source_ver, base_revision}")
            if not isinstance(data, dict) or not isinstance(data.get("html"), str):
                raise HTTPException(400, "Нет текста редакции (поле html)")
            html = clean_html(data["html"])
            if not re.sub(r"<[^>]+>|&nbsp;|\s", "", html) and "<img" not in html:
                raise HTTPException(400, "Пустая редакция не сохраняется")
            if len(html.encode("utf-8")) > max_bytes:
                raise HTTPException(413, f"Редакция больше {max_bytes // MB} МБ — уменьшите или удалите крупные иллюстрации")
            base = data.get("base_revision")
            if base is not None:
                try:
                    base = int(base)
                except (TypeError, ValueError):
                    raise HTTPException(400, "base_revision должен быть числом")
            rec = {"html": html, "title": str(data.get("title") or "")[:300],
                   "source_ver": str(data.get("source_ver") or "1")[:40], "by": str(who)[:80]}
            try:
                saved = store.save(fid, rec, base)
            except Conflict as c:
                raise HTTPException(409, f"Редакцию уже обновили в другом окне (сейчас редакция {c.current}). "
                                         "Откройте актуальную и перенесите правки.")
            return html, saved

        html, saved = await run_in_threadpool(_process)
        log(f"[manuals-editions] {fid}: сохранена редакция {saved['revision']} ({len(html)} символов)")
        return JSONResponse(public(saved, fid), headers=NO_STORE)

    @r.get("/{fid}/history")
    def history(fid: str, request: Request):
        fid = check_fid(fid)
        admin(request)
        return JSONResponse({"fid": fid, "items": store.history(fid)}, headers=NO_STORE)

    @r.get("/{fid}/revisions/{n}")
    def revision(fid: str, n: int, request: Request):
        fid = check_fid(fid)
        admin(request)
        rec = store.read(fid, n)
        if not rec:
            raise HTTPException(404, f"Редакция {n} не найдена (возможно, удалена как старая)")
        return JSONResponse(public(rec, fid), headers=NO_STORE)

    return r
