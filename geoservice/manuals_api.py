"""
manuals_api.py — раздел «Методички» геопортала ОДЗиМЛ.

Методичка = заголовок (+ краткое описание) и список файлов Word/PDF под ним.
Просмотр — всем пользователям геопортала, правка — только администратору
(require_admin + verify_csrf из app.py).

Хранение (без БД):
    instance/manuals/manuals.json         — список методичек и файлов
    instance/manuals/files/<id>.<ext>     — сами файлы
    instance/manuals/cache/<id>/          — HTML-просмотр DOCX + картинки
    instance/manuals/.lock                — межпроцессная блокировка (uvicorn workers=4)

Маршруты:
    GET  /manuals                                   страница раздела
    GET  /api/manuals                               список
    GET  /api/manuals/files/{fid}/download          скачать (оригинальное имя)
    GET  /api/manuals/files/{fid}/raw               открыть (PDF inline)
    GET  /api/manuals/files/{fid}/html              просмотр DOCX (HTML)
    GET  /api/manuals/files/{fid}/media/{name}      картинки из DOCX
    POST   /api/admin/manuals                       {title, desc}  — новая методичка
    PATCH  /api/admin/manuals/{mid}                 {title?, desc?}
    DELETE /api/admin/manuals/{mid}
    POST   /api/admin/manuals/{mid}/move            {dir: -1|1}
    POST   /api/admin/manuals/{mid}/files           multipart files[] — добавить файлы
    POST   /api/admin/manuals/files/{fid}/replace   multipart file    — заменить файл
    PATCH  /api/admin/manuals/files/{fid}           {name}
    DELETE /api/admin/manuals/files/{fid}
    POST   /api/admin/manuals/files/{fid}/move      {dir: -1|1}
"""
from __future__ import annotations

import datetime
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

ALLOWED_EXT = {".pdf", ".docx", ".doc"}
MAX_FILE_BYTES = 200 * 1024 * 1024          # 200 МБ на файл
MAX_TITLE = 200
_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")
_MEDIA_RE = re.compile(r"^[\w.\-]{1,120}$")


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


# ──────────────────────────────────────────────────────────────────────────
# Хранилище
# ──────────────────────────────────────────────────────────────────────────
class _Store:
    def __init__(self, root: str):
        self.root = root
        self.files_dir = os.path.join(root, "files")
        self.cache_dir = os.path.join(root, "cache")
        self.path = os.path.join(root, "manuals.json")
        self.lock_path = os.path.join(root, ".lock")
        os.makedirs(self.files_dir, exist_ok=True)
        os.makedirs(self.cache_dir, exist_ok=True)
        self._tlock = threading.RLock()

    # межпроцессная блокировка: атомарное создание lock-файла (Windows и Linux)
    def _acquire(self, timeout=15.0):
        t0 = time.time()
        while True:
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode()); os.close(fd)
                return
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.lock_path) > 30:   # зависший lock
                        os.remove(self.lock_path); continue
                except OSError:
                    pass
                if time.time() - t0 > timeout:
                    raise HTTPException(503, "Хранилище методичек занято, повторите")
                time.sleep(0.05)

    def _release(self):
        try:
            os.remove(self.lock_path)
        except OSError:
            pass

    def load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get("manuals"), list):
                return d
        except (OSError, ValueError):
            pass
        return {"manuals": []}

    def _save(self, data: dict):
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".manuals-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def edit(self, fn):
        """fn(data) -> result; выполняется под блокировкой, данные сохраняются."""
        with self._tlock:
            self._acquire()
            try:
                data = self.load()
                res = fn(data)
                self._save(data)
                return res
            finally:
                self._release()

    def file_path(self, f: dict) -> str:
        return os.path.join(self.files_dir, f["id"] + f["ext"])

    def find_file(self, data: dict, fid: str):
        for m in data["manuals"]:
            for i, f in enumerate(m.get("files", [])):
                if f["id"] == fid:
                    return m, i, f
        return None, -1, None

    def drop_cache(self, fid: str):
        shutil.rmtree(os.path.join(self.cache_dir, fid), ignore_errors=True)


def _clean_title(v, limit=MAX_TITLE) -> str:
    v = re.sub(r"\s+", " ", str(v or "")).strip()
    return v[:limit]


def _clean_filename(name: str) -> str:
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", name)
    return name[:180] or "file"


def _sniff_ok(ext: str, head: bytes) -> bool:
    if ext == ".pdf":
        return head.startswith(b"%PDF")
    if ext == ".docx":
        return head.startswith(b"PK")
    if ext == ".doc":
        return head.startswith(b"\xd0\xcf\x11\xe0") or head.startswith(b"{\\rtf")
    return False


async def _save_upload(store: _Store, up: UploadFile, fid: str) -> dict:
    name = _clean_filename(up.filename)
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"«{name}»: допустимы только PDF и Word (.pdf, .docx, .doc)")
    tmp = os.path.join(store.files_dir, f".up-{fid}-{uuid.uuid4().hex[:6]}")
    size, head = 0, b""
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = await up.read(1024 * 1024)
                if not chunk:
                    break
                if not head:
                    head = chunk[:8]
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(413, f"«{name}»: файл больше {MAX_FILE_BYTES // (1024*1024)} МБ")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, f"«{name}»: пустой файл")
        if not _sniff_ok(ext, head):
            raise HTTPException(400, f"«{name}»: содержимое не похоже на {ext[1:].upper()}")
    except BaseException:
        try: os.remove(tmp)
        except OSError: pass
        raise
    return {"tmp": tmp, "name": name, "ext": ext, "size": size}


# ──────────────────────────────────────────────────────────────────────────
# DOCX → HTML (только стандартная библиотека)
# ──────────────────────────────────────────────────────────────────────────
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
V = "urn:schemas-microsoft-com:vml"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"


def _w(tag):
    return "{%s}%s" % (W, tag)


def _on(el) -> bool:
    """<w:b/> = вкл; <w:b w:val="0|false|off"/> = выкл."""
    if el is None:
        return False
    v = el.get(_w("val"))
    return v is None or v.lower() not in ("0", "false", "off", "none")


class _Docx:
    WEB_IMG = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"}

    def __init__(self, path: str, media_url: str, media_dir: str):
        self.z = zipfile.ZipFile(path)
        self.media_url = media_url
        self.media_dir = media_dir
        self.rels = self._rels("word/_rels/document.xml.rels")
        self.styles = self._styles()
        self.numfmt = self._numbering()
        self.toc = []
        self._hid = 0
        self._media_done = {}

    def _xml(self, name):
        try:
            return ET.fromstring(self.z.read(name))
        except (KeyError, ET.ParseError):
            return None

    def _rels(self, name):
        out = {}
        root = self._xml(name)
        if root is not None:
            for r in root.findall("{%s}Relationship" % PR):
                out[r.get("Id")] = (r.get("Target", ""), r.get("TargetMode", ""))
        return out

    def _styles(self):
        out = {}
        root = self._xml("word/styles.xml")
        if root is not None:
            for s in root.findall(_w("style")):
                n = s.find(_w("name"))
                out[s.get(_w("styleId"))] = (n.get(_w("val")) if n is not None else "").lower()
        return out

    def _numbering(self):
        root = self._xml("word/numbering.xml")
        fmts, nums = {}, {}
        if root is None:
            return {}
        for an in root.findall(_w("abstractNum")):
            aid = an.get(_w("abstractNumId"))
            for lvl in an.findall(_w("lvl")):
                f = lvl.find(_w("numFmt"))
                fmts[(aid, lvl.get(_w("ilvl")))] = f.get(_w("val")) if f is not None else "bullet"
        for n in root.findall(_w("num")):
            a = n.find(_w("abstractNumId"))
            if a is not None:
                nums[n.get(_w("numId"))] = a.get(_w("val"))
        return {"fmts": fmts, "nums": nums}

    def _list_kind(self, numId, ilvl):
        if not self.numfmt:
            return "ul"
        aid = self.numfmt["nums"].get(numId)
        f = self.numfmt["fmts"].get((aid, ilvl), "bullet")
        return "ul" if f in ("bullet", "none", "") else "ol"

    def _media(self, rid) -> Optional[str]:
        t = self.rels.get(rid)
        if not t:
            return None
        target = t[0].lstrip("/")
        zname = target if target.startswith("word/") else "word/" + target
        zname = os.path.normpath(zname).replace("\\", "/")
        if zname in self._media_done:
            return self._media_done[zname]
        base = re.sub(r"[^\w.\-]", "_", os.path.basename(zname))
        ext = os.path.splitext(base)[1].lower()
        if ext not in self.WEB_IMG:
            self._media_done[zname] = None
            return None
        try:
            data = self.z.read(zname)
        except KeyError:
            return None
        os.makedirs(self.media_dir, exist_ok=True)
        with open(os.path.join(self.media_dir, base), "wb") as f:
            f.write(data)
        url = self.media_url + base
        self._media_done[zname] = url
        return url

    # ── runs ──
    def _run(self, r) -> str:
        rpr = r.find(_w("rPr"))
        b = i = u = s = False
        sup = sub = False
        color = hl = None
        if rpr is not None:
            b = _on(rpr.find(_w("b")))
            i = _on(rpr.find(_w("i")))
            uu = rpr.find(_w("u"))
            u = uu is not None and uu.get(_w("val"), "single") != "none"
            s = _on(rpr.find(_w("strike")))
            va = rpr.find(_w("vertAlign"))
            if va is not None:
                sup = va.get(_w("val")) == "superscript"
                sub = va.get(_w("val")) == "subscript"
            c = rpr.find(_w("color"))
            if c is not None and re.match(r"^[0-9A-Fa-f]{6}$", c.get(_w("val"), "")) and c.get(_w("val")).upper() not in ("000000",):
                color = "#" + c.get(_w("val"))
            h = rpr.find(_w("highlight"))
            if h is not None and h.get(_w("val"), "none") != "none":
                hl = h.get(_w("val"))
        parts = []
        for ch in r:
            tag = ch.tag
            if tag == _w("t"):
                parts.append(html.escape(ch.text or ""))
            elif tag == _w("tab"):
                parts.append('<span class="tab"></span>')
            elif tag in (_w("br"), _w("cr")):
                parts.append("<br>")
            elif tag == _w("noBreakHyphen"):
                parts.append("&#8209;")
            elif tag == _w("sym"):
                try:
                    parts.append("&#%d;" % int(ch.get(_w("char"), "2022"), 16))
                except ValueError:
                    pass
            elif tag == _w("drawing") or tag == "{%s}AlternateContent" % MC or tag == _w("pict") or tag == _w("object"):
                parts.append(self._images(ch))
        txt = "".join(parts)
        if not txt:
            return ""
        if sup: txt = "<sup>%s</sup>" % txt
        if sub: txt = "<sub>%s</sub>" % txt
        if s: txt = "<s>%s</s>" % txt
        if u: txt = "<u>%s</u>" % txt
        if i: txt = "<em>%s</em>" % txt
        if b: txt = "<strong>%s</strong>" % txt
        if color or hl:
            st = ("color:%s;" % color if color else "") + ("background:%s;" % {"yellow": "#fff3a3", "green": "#c8f0c0", "cyan": "#c4eef5", "lightGray": "#e6e6e6"}.get(hl, "#fff3a3") if hl else "")
            txt = '<span style="%s">%s</span>' % (st, txt)
        return txt

    def _images(self, el) -> str:
        out = []
        # mc:AlternateContent — берём только первый вариант с картинкой
        if el.tag == "{%s}AlternateContent" % MC:
            for alt in el:
                h = self._images_in(alt)
                if h:
                    return h
            return ""
        return self._images_in(el)

    def _images_in(self, el) -> str:
        out = []
        for blip in el.iter("{%s}blip" % A):
            rid = blip.get("{%s}embed" % R)
            url = self._media(rid)
            if url:
                w = None
                for ext in el.iter("{%s}extent" % WP):
                    try:
                        w = int(int(ext.get("cx")) / 9525)
                    except (TypeError, ValueError):
                        pass
                    break
                st = ' style="width:%dpx"' % w if w else ""
                out.append('<img src="%s" alt="" loading="lazy"%s>' % (html.escape(url), st))
        if not out:
            for im in el.iter("{%s}imagedata" % V):
                url = self._media(im.get("{%s}id" % R))
                if url:
                    out.append('<img src="%s" alt="" loading="lazy">' % html.escape(url))
        return "".join(out)

    def _inline(self, p) -> str:
        out = []
        for ch in p:
            tag = ch.tag
            if tag == _w("r"):
                out.append(self._run(ch))
            elif tag == _w("hyperlink"):
                inner = self._inline(ch)
                rid = ch.get("{%s}id" % R)
                t = self.rels.get(rid) if rid else None
                if t and t[1] == "External" and re.match(r"^(https?|mailto):", t[0], re.I):
                    out.append('<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>' % (html.escape(t[0]), inner))
                else:
                    out.append(inner)
            elif tag in (_w("ins"), _w("smartTag"), _w("fldSimple"), _w("customXml")):
                out.append(self._inline(ch))
            elif tag == _w("sdt"):
                c = ch.find(_w("sdtContent"))
                if c is not None:
                    out.append(self._inline(c))
        return "".join(out)

    def _para(self, p):
        """→ (kind, html, list_info). kind: p|h1..h4|li"""
        ppr = p.find(_w("pPr"))
        style = ""
        num = None
        cls, css = [], []
        if ppr is not None:
            ps = ppr.find(_w("pStyle"))
            if ps is not None:
                sid = ps.get(_w("val"), "")
                style = self.styles.get(sid, sid.lower())
            np_ = ppr.find(_w("numPr"))
            if np_ is not None:
                ni = np_.find(_w("numId")); il = np_.find(_w("ilvl"))
                nid = ni.get(_w("val")) if ni is not None else None
                if nid and nid != "0":
                    num = (nid, il.get(_w("val")) if il is not None else "0")
            jc = ppr.find(_w("jc"))
            if jc is not None and jc.get(_w("val")) in ("center", "right", "both"):
                css.append("text-align:%s" % {"both": "justify"}.get(jc.get(_w("val")), jc.get(_w("val"))))
            shd = ppr.find(_w("shd"))
            if shd is not None and re.match(r"^[0-9A-Fa-f]{6}$", shd.get(_w("fill"), "")) and shd.get(_w("fill")).upper() != "FFFFFF":
                cls.append("note")
        body = self._inline(p)
        st = style.replace(" ", "")
        m = re.match(r"^(heading|заголовок)(\d)$", st)
        if st == "title":
            return "h1", body, None, cls, css
        if st == "subtitle":
            return "sub", body, None, cls, css
        if m:
            lvl = min(4, int(m.group(2)) + 1)
            return "h%d" % lvl, body, None, cls, css
        if num or st.startswith("listbullet") or st.startswith("listnumber") or st.startswith("listparagraph") and num:
            if num:
                kind = self._list_kind(num[0], num[1]); lvl = int(num[1] or 0)
            else:
                kind = "ol" if st.startswith("listnumber") else "ul"
                d = re.search(r"(\d)$", st); lvl = int(d.group(1)) - 1 if d else 0
            return "li", body, (kind, lvl), cls, css
        return "p", body, None, cls, css

    def _table(self, t) -> str:
        rows = []
        for tr in t.findall(_w("tr")):
            cells = []
            for tc in tr.findall(_w("tc")):
                tcpr = tc.find(_w("tcPr"))
                span = 1
                if tcpr is not None:
                    gs = tcpr.find(_w("gridSpan"))
                    if gs is not None:
                        try: span = int(gs.get(_w("val"), "1"))
                        except ValueError: pass
                    vm = tcpr.find(_w("vMerge"))
                    if vm is not None and vm.get(_w("val")) != "restart":
                        cells.append('<td class="vm"></td>'); continue
                inner = self._blocks(tc)
                cells.append("<td%s>%s</td>" % (' colspan="%d"' % span if span > 1 else "", inner))
            rows.append("<tr>%s</tr>" % "".join(cells))
        return '<div class="tbl"><table>%s</table></div>' % "".join(rows)

    def _blocks(self, parent) -> str:
        out = []
        stack = []           # открытые списки: [(kind, lvl)]

        def close_to(lvl):
            while stack and stack[-1][1] > lvl:
                out.append("</li></%s>" % stack.pop()[0])

        def close_all():
            while stack:
                out.append("</li></%s>" % stack.pop()[0])

        def items(el):
            for ch in el:
                if ch.tag == _w("sdt"):
                    c = ch.find(_w("sdtContent"))
                    if c is not None:
                        yield from items(c)
                else:
                    yield ch

        for ch in items(parent):
            if ch.tag == _w("p"):
                kind, body, li, cls, css = self._para(ch)
                attrs = (' class="%s"' % " ".join(cls) if cls else "") + (' style="%s"' % ";".join(css) if css else "")
                if kind == "li":
                    k, lvl = li
                    if stack and stack[-1][1] == lvl and stack[-1][0] == k:
                        out.append("</li><li%s>%s" % (attrs, body))
                    else:
                        close_to(lvl)
                        if stack and stack[-1][1] == lvl:      # тот же уровень, другой тип
                            out.append("</li></%s>" % stack.pop()[0])
                        out.append("<%s><li%s>%s" % (k, attrs, body)); stack.append((k, lvl))
                    continue
                close_all()
                if kind.startswith("h") and kind != "h1":
                    self._hid += 1
                    hid = "h-%d" % self._hid
                    txt = re.sub(r"<[^>]+>", "", body).strip()
                    if txt:
                        self.toc.append({"id": hid, "lvl": int(kind[1]), "text": html.unescape(txt)})
                    out.append('<%s id="%s"%s>%s</%s>' % (kind, hid, attrs, body, kind))
                elif kind == "h1":
                    out.append('<h1 class="doc-title"%s>%s</h1>' % (attrs, body))
                elif kind == "sub":
                    out.append('<p class="doc-sub">%s</p>' % body)
                else:
                    out.append("<p%s>%s</p>" % (attrs, body or "&nbsp;") if body else '<p class="empty"></p>')
            elif ch.tag == _w("tbl"):
                close_all()
                out.append(self._table(ch))
        close_all()
        return "".join(out)

    def render(self) -> dict:
        root = self._xml("word/document.xml")
        if root is None:
            raise ValueError("В файле нет word/document.xml")
        body = root.find(_w("body"))
        h = self._blocks(body)
        h = re.sub(r'(<p class="empty"></p>){2,}', '<p class="empty"></p>', h)
        return {"html": h, "toc": self.toc}


def _find_soffice() -> Optional[str]:
    for c in ("soffice", "libreoffice",
              r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
        p = shutil.which(c) or (c if os.path.isfile(c) else None)
        if p:
            return p
    return None


# ──────────────────────────────────────────────────────────────────────────
# Роутер
# ──────────────────────────────────────────────────────────────────────────
def build_router(base_dir: str, templates, require_admin, verify_csrf,
                 is_admin=None, get_csrf_token=None, logger=None) -> APIRouter:
    store = _Store(os.path.join(base_dir, "instance", "manuals"))
    router = APIRouter()

    def log(msg):
        if logger:
            logger.info("[manuals] " + msg)

    # Первый запуск: методички из папки manuals_seed/ (если есть)
    seed = os.path.join(base_dir, "manuals_seed")
    if not os.path.exists(store.path) and os.path.isdir(seed):
        try:
            def _seed(data):
                if data["manuals"]:
                    return
                files = []
                for n in sorted(os.listdir(seed)):
                    ext = os.path.splitext(n)[1].lower()
                    if ext not in ALLOWED_EXT:
                        continue
                    fid = uuid.uuid4().hex[:16]
                    shutil.copyfile(os.path.join(seed, n), os.path.join(store.files_dir, fid + ext))
                    files.append({"id": fid, "name": n, "ext": ext, "size": os.path.getsize(os.path.join(seed, n)),
                                  "uploaded": _now(), "by": "seed", "ver": 1})
                if files:
                    data["manuals"].append({"id": uuid.uuid4().hex[:12], "title": "Гайды по обработке снимков (ERDAS, ArcMap)",
                                            "desc": "Пошаговые инструкции для сотрудников ОДЗиМЛ", "created": _now(),
                                            "updated": _now(), "files": files})
            store.edit(_seed)
        except Exception as e:  # не мешаем старту приложения
            log(f"seed error: {e}")

    def _admin(request: Request) -> bool:
        try:
            return bool(is_admin(request)) if is_admin else False
        except Exception:
            return False

    def _public(data):
        return {"manuals": data["manuals"]}

    def _check_id(v):
        if not _ID_RE.match(v or ""):
            raise HTTPException(404, "Не найдено")

    # ── страница ──
    @router.get("/manuals", response_class=HTMLResponse)
    async def manuals_page(request: Request):
        adm = _admin(request)
        ctx = {"is_admin": adm, "csrf_token": get_csrf_token(request) if (adm and get_csrf_token) else ""}
        return templates.TemplateResponse(request=request, name="manuals.html", context=ctx)

    # ── чтение ──
    @router.get("/api/manuals")
    async def api_list(request: Request):
        d = _public(store.load()); d["is_admin"] = _admin(request)
        d["limits"] = {"max_mb": MAX_FILE_BYTES // (1024 * 1024), "ext": sorted(ALLOWED_EXT)}
        return JSONResponse(d, headers={"Cache-Control": "no-store"})

    def _get_file(fid):
        _check_id(fid)
        m, _, f = store.find_file(store.load(), fid)
        if not f or not os.path.isfile(store.file_path(f)):
            raise HTTPException(404, "Файл не найден")
        return m, f

    _MIME = {".pdf": "application/pdf",
             ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             ".doc": "application/msword"}

    @router.get("/api/manuals/files/{fid}/download")
    async def api_download(fid: str):
        m, f = _get_file(fid)
        return FileResponse(store.file_path(f), media_type=_MIME.get(f["ext"], "application/octet-stream"),
                            filename=f["name"], headers={"Cache-Control": "no-cache"})

    @router.get("/api/manuals/files/{fid}/raw")
    async def api_raw(fid: str):
        m, f = _get_file(fid)
        path = store.file_path(f)
        if f["ext"] == ".pdf":
            return FileResponse(path, media_type="application/pdf", filename=f["name"],
                                content_disposition_type="inline", headers={"Cache-Control": "no-cache"})
        # .doc → PDF через LibreOffice (если установлен на сервере)
        if f["ext"] == ".doc":
            pdf = await run_in_threadpool(_doc_to_pdf, f)
            if pdf:
                return FileResponse(pdf, media_type="application/pdf", content_disposition_type="inline",
                                    filename=os.path.splitext(f["name"])[0] + ".pdf")
        raise HTTPException(415, "Для этого формата доступно только скачивание")

    def _doc_to_pdf(f) -> Optional[str]:
        cdir = os.path.join(store.cache_dir, f["id"])
        out = os.path.join(cdir, "v%d.pdf" % f.get("ver", 1))
        if os.path.isfile(out):
            return out
        so = _find_soffice()
        if not so:
            return None
        os.makedirs(cdir, exist_ok=True)
        tmpd = tempfile.mkdtemp(dir=cdir)
        try:
            src = os.path.join(tmpd, "src" + f["ext"])
            shutil.copyfile(store.file_path(f), src)
            subprocess.run([so, "--headless", "--convert-to", "pdf", "--outdir", tmpd, src],
                           timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            res = os.path.join(tmpd, "src.pdf")
            if os.path.isfile(res):
                os.replace(res, out)
                return out
        except Exception as e:
            log(f"soffice error: {e}")
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)
        return None

    def _render_docx(f) -> dict:
        cdir = os.path.join(store.cache_dir, f["id"])
        cache = os.path.join(cdir, "v%d.json" % f.get("ver", 1))
        if os.path.isfile(cache):
            with open(cache, "r", encoding="utf-8") as fh:
                return json.load(fh)
        shutil.rmtree(cdir, ignore_errors=True)
        os.makedirs(cdir, exist_ok=True)
        doc = _Docx(store.file_path(f), "/api/manuals/files/%s/media/" % f["id"], os.path.join(cdir, "media"))
        res = doc.render()
        fd, tmp = tempfile.mkstemp(dir=cdir, suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False)
        os.replace(tmp, cache)
        return res

    @router.get("/api/manuals/files/{fid}/html")
    async def api_html(fid: str):
        m, f = _get_file(fid)
        if f["ext"] != ".docx":
            raise HTTPException(415, "Просмотр в виде страницы доступен только для .docx")
        try:
            res = await run_in_threadpool(_render_docx, f)
        except (zipfile.BadZipFile, ValueError, ET.ParseError) as e:
            raise HTTPException(422, f"Не удалось прочитать документ: {e}")
        return JSONResponse(res, headers={"Cache-Control": "no-cache"})

    @router.get("/api/manuals/files/{fid}/media/{name}")
    async def api_media(fid: str, name: str):
        _check_id(fid)
        if not _MEDIA_RE.match(name or "") or name.startswith("."):
            raise HTTPException(404, "Не найдено")
        p = os.path.join(store.cache_dir, fid, "media", name)
        if not os.path.isfile(p):
            raise HTTPException(404, "Не найдено")
        return FileResponse(p, headers={"Cache-Control": "public, max-age=86400"})

    # ── правка (администратор) ──
    def _find_manual(data, mid):
        _check_id(mid)
        for i, m in enumerate(data["manuals"]):
            if m["id"] == mid:
                return i, m
        raise HTTPException(404, "Методичка не найдена")

    async def _json(request):
        try:
            d = await request.json()
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    @router.post("/api/admin/manuals")
    async def api_create(request: Request, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        d = await _json(request)
        title = _clean_title(d.get("title"))
        if not title:
            raise HTTPException(400, "Укажите заголовок методички")
        m = {"id": uuid.uuid4().hex[:12], "title": title, "desc": _clean_title(d.get("desc"), 500),
             "created": _now(), "updated": _now(), "files": []}
        store.edit(lambda data: data["manuals"].append(m))
        log(f"создана «{title}» (admin={admin_id})")
        return {"ok": True, "manual": m}

    @router.patch("/api/admin/manuals/{mid}")
    async def api_update(mid: str, request: Request, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        d = await _json(request)

        def fn(data):
            _, m = _find_manual(data, mid)
            if "title" in d:
                t = _clean_title(d.get("title"))
                if not t:
                    raise HTTPException(400, "Заголовок не может быть пустым")
                m["title"] = t
            if "desc" in d:
                m["desc"] = _clean_title(d.get("desc"), 500)
            m["updated"] = _now()
            return m
        return {"ok": True, "manual": store.edit(fn)}

    @router.delete("/api/admin/manuals/{mid}")
    async def api_delete(mid: str, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        def fn(data):
            i, m = _find_manual(data, mid)
            data["manuals"].pop(i)
            return m
        m = store.edit(fn)
        for f in m.get("files", []):
            try: os.remove(store.file_path(f))
            except OSError: pass
            store.drop_cache(f["id"])
        log(f"удалена «{m['title']}» (admin={admin_id})")
        return {"ok": True}

    def _move(lst, i, d):
        j = i + (1 if d > 0 else -1)
        if 0 <= j < len(lst):
            lst[i], lst[j] = lst[j], lst[i]

    @router.post("/api/admin/manuals/{mid}/move")
    async def api_move(mid: str, request: Request, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        d = int((await _json(request)).get("dir") or 0)

        def fn(data):
            i, _ = _find_manual(data, mid); _move(data["manuals"], i, d)
        store.edit(fn)
        return {"ok": True}

    @router.post("/api/admin/manuals/{mid}/files")
    async def api_add_files(mid: str, files: List[UploadFile] = File(...),
                            admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        _find_manual(store.load(), mid)
        saved = []
        try:
            for up in files:
                fid = uuid.uuid4().hex[:16]
                s = await _save_upload(store, up, fid)
                s["id"] = fid
                saved.append(s)
        except BaseException:
            for s in saved:
                try: os.remove(s["tmp"])
                except OSError: pass
            raise
        new = []
        for s in saved:
            os.replace(s["tmp"], os.path.join(store.files_dir, s["id"] + s["ext"]))
            new.append({"id": s["id"], "name": s["name"], "ext": s["ext"], "size": s["size"],
                        "uploaded": _now(), "by": str(admin_id), "ver": 1})

        def fn(data):
            _, m = _find_manual(data, mid)
            m.setdefault("files", []).extend(new); m["updated"] = _now()
        try:
            store.edit(fn)
        except BaseException:
            for f in new:
                try: os.remove(store.file_path(f))
                except OSError: pass
            raise
        log(f"+{len(new)} файл(ов) в {mid} (admin={admin_id})")
        return {"ok": True, "files": new}

    @router.post("/api/admin/manuals/files/{fid}/replace")
    async def api_replace(fid: str, file: UploadFile = File(...),
                          admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        _get_file(fid)
        s = await _save_upload(store, file, fid)

        def fn(data):
            m, i, f = store.find_file(data, fid)
            if not f:
                raise HTTPException(404, "Файл не найден")
            old = store.file_path(f)
            os.replace(s["tmp"], os.path.join(store.files_dir, fid + s["ext"]))
            if old != os.path.join(store.files_dir, fid + s["ext"]):
                try: os.remove(old)
                except OSError: pass
            f.update({"name": s["name"], "ext": s["ext"], "size": s["size"], "uploaded": _now(),
                      "by": str(admin_id), "ver": int(f.get("ver", 1)) + 1})
            m["updated"] = _now()
            return dict(f)
        try:
            f = store.edit(fn)
        finally:
            if os.path.exists(s["tmp"]):
                try: os.remove(s["tmp"])
                except OSError: pass
        store.drop_cache(fid)
        log(f"заменён {fid} → «{f['name']}» (admin={admin_id})")
        return {"ok": True, "file": f}

    @router.patch("/api/admin/manuals/files/{fid}")
    async def api_rename_file(fid: str, request: Request, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        _check_id(fid)
        name = _clean_filename((await _json(request)).get("name"))

        def fn(data):
            m, i, f = store.find_file(data, fid)
            if not f:
                raise HTTPException(404, "Файл не найден")
            n = name if name.lower().endswith(f["ext"]) else name + f["ext"]
            f["name"] = n
            return dict(f)
        return {"ok": True, "file": store.edit(fn)}

    @router.delete("/api/admin/manuals/files/{fid}")
    async def api_delete_file(fid: str, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        _check_id(fid)

        def fn(data):
            m, i, f = store.find_file(data, fid)
            if not f:
                raise HTTPException(404, "Файл не найден")
            m["files"].pop(i); m["updated"] = _now()
            return f
        f = store.edit(fn)
        try: os.remove(store.file_path(f))
        except OSError: pass
        store.drop_cache(fid)
        log(f"удалён файл «{f['name']}» (admin={admin_id})")
        return {"ok": True}

    @router.post("/api/admin/manuals/files/{fid}/move")
    async def api_move_file(fid: str, request: Request, admin_id=Depends(require_admin), _c=Depends(verify_csrf)):
        _check_id(fid)
        d = int((await _json(request)).get("dir") or 0)

        def fn(data):
            m, i, f = store.find_file(data, fid)
            if not f:
                raise HTTPException(404, "Файл не найден")
            _move(m["files"], i, d)
        store.edit(fn)
        return {"ok": True}

    return router
