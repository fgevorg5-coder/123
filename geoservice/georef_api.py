# -*- coding: utf-8 -*-
"""
georef_api.py — инструменты раздела «Конвертер СК» (v19):

  • «План → GeoTIFF/TFW → MBTiles»: скан плана (JPG/PNG/TIFF) или PDF привязывается к местности
    автоматически (georef_plans.py: контуры зданий НКА/OSM + ортофото НКА/Esri), результат —
    GeoTIFF EPSG:3857 (+ .tfw/.tfwx/.prj/.aux.xml/.ovr), MBTiles для карты, контрольная картинка;
  • «Растр → MBTiles»: готовые GeoTIFF / растры с world-файлом / архивы → MBTiles (tif2mbtiles.py).

Задания выполняются отдельным процессом (georef_runner.py) через общую очередь (jobkit):
ход по этапам, журнал, отмена, повтор с другими параметрами без повторной загрузки.
Каждый видит только свои задания (метка в cookie), администратор — все; администратор может
сразу добавить MBTiles в слои карты (папка «MBTILES MINSK»).

Переменные .env: GEOREF_ENABLED (1), GEOREF_TOOLS_DIR (tools/georef), GEOREF_PYTHON (python
сервера), GEOREF_WORKDIR (instance/georef), GEOREF_MAX_UPLOAD_MB (1024), GEOREF_MAX_FILES (60),
GEOREF_MAX_SHEETS (12), GEOREF_MAX_JOBS (1 — одновременно), GEOREF_MAX_QUEUE (12),
GEOREF_TIMEOUT_MIN (60), GEOREF_KEEP_HOURS (48), GEOREF_CACHE_DAYS (30), GEOREF_PDF_MAX_MP (150).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

try:
    from . import jobkit as _jk        # type: ignore
except ImportError:                    # pragma: no cover
    import jobkit as _jk               # type: ignore
try:                                   # [v20.3] ручной сдвиг результатов
    from . import georef_shift as _gs  # type: ignore
except ImportError:                    # pragma: no cover
    import georef_shift as _gs         # type: ignore

MB = _jk.MB
PROGRESS_RE = _jk.PROGRESS_RE
_now, _env_float = _jk._now, _jk._env_float
_read_json, _atomic_json, _check_id = _jk._read_json, _jk._atomic_json, _jk._check_id

COOKIE = "georef_uid"
SERVER_VERSION = "20.7"
CRS_COOKIE = "crs_raster_uid"          # [v20.7] владелец сохранённых сдвигов растров «Смены СК»
CRS_RASTER_EXT = (".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".gif", ".jp2", ".img", ".ecw", ".sid", ".webp")
CRS_WORLD_EXT = (".tfw", ".tfwx", ".tifw", ".tiffw", ".jgw", ".jpgw", ".pgw", ".pngw", ".bpw", ".gfw", ".wld", ".aux.xml")
STAGES = {
    "georef": ["Подготовка файлов", "Поиск места", "Грубая привязка", "Тонкая привязка", "Экспорт GeoTIFF/TFW", "Нарезка MBTiles"],
    "mbtiles": ["Подготовка файлов", "Чтение привязки", "Нарезка MBTiles"],
    "mb2tif": ["Подготовка файлов", "Чтение MBTiles", "Сборка GeoTIFF", "Перепроецирование и пирамиды"],   # [v20]
}
IN_EXT = {
    "georef": (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".pdf", ".zip"),
    "mbtiles": (".tif", ".tiff", ".tfw", ".tfwx", ".tifw", ".wld", ".prj", ".xml", ".ovr", ".jpg", ".jpeg", ".jgw",
                ".jpgw", ".png", ".pgw", ".pngw", ".zip", ".7z", ".rar", ".qpj", ".cpg"),
    "mb2tif": (".mbtiles", ".zip"),
}
FILE_LABELS = [
    (r"_сдвиг\.mbtiles$", "MBTiles со сдвигом (исходный MBTiles, смещён целиком)"),   # [v20.7]
    (r"\.tif$", "GeoTIFF (EPSG:3857)"), (r"\.tfw$", "World-файл TFW"), (r"\.tfwx$", "World-файл TFWX"),
    (r"\.prj$", "Проекция (.prj, ESRI WKT)"), (r"\.tif\.aux\.xml$", "Метаданные СК (.aux.xml)"),
    (r"\.tif\.ovr$", "Пирамиды (.ovr)"), (r"\.mbtiles$", "MBTiles (тайлы для карты)"),
    (r"^qa_overlay\.jpg$", "Контроль: план поверх ортофото"), (r"^report\.txt$", "Отчёт о привязке"),
    (r"^report\.json$", "Отчёт (JSON)"), (r"^result\.json$", "Сводка (JSON)"),
    (r"_preview\.png$", "Просмотр (PNG, Web Mercator)"),
]
INLINE = {".jpg": "image/jpeg", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
          ".json": "application/json", ".tfw": "text/plain; charset=utf-8", ".tfwx": "text/plain; charset=utf-8",
          ".prj": "text/plain; charset=utf-8"}
SCALES = [200, 500, 1000, 2000, 5000, 10000]
DEFAULTS = {
    "georef": {"radius": "auto", "scale": "auto", "dpi": None, "orient": "auto", "no_grid": False, "buildings": "nca",
               "ortho": "nca", "zoom": 20, "model": "auto", "no_fine": False, "search_angle": 2.5, "search_shift": 8.0,
               "city": "Минск"},
    "pdf": {"dpi": "auto", "pages": "all"},
    "mbtiles": {"enabled": True, "format": "png", "zoom": "", "paper": "auto", "background": "auto", "merge": "",
                "quality": 85, "resampling": "cubic", "tile_size": 256, "minzoom": None, "maxzoom": None,
                "white_threshold": 235, "src_crs": "auto", "force_crs": "", "src_nodata": None, "name": ""},
    "mb2tif": {"zoom": "max", "crs": "EPSG:3857", "compress": "deflate", "background": "none", "clip": "auto",
               "resampling": "cubic", "overviews": True},
}


def _label(name: str) -> str:
    for rx, lab in FILE_LABELS:
        if re.search(rx, name, re.I):
            return lab
    return ""


def _num(v, lo, hi, default=None, integer=False):
    if v in (None, ""):
        return default
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise HTTPException(422, f"Некорректное число: {str(v)[:30]}")
    if not math.isfinite(x) or x < lo or x > hi:
        raise HTTPException(422, f"Значение {x:g} вне диапазона {lo:g}…{hi:g}")
    return int(round(x)) if integer else x


def _is_auto(v) -> bool:
    return v is None or str(v).strip().lower() in ("", "auto", "авто", "0", "none", "null")


def _place_obj(g: dict) -> dict:
    """[v20.1] объект, найденный геокодером в интерфейсе: osm («way/123»), класс, тип, название, рамка, «дом не найден»"""
    out: Dict[str, Any] = {}
    osm = str(g.get("place_osm") or "").strip()
    if re.fullmatch(r"(node|way|relation)/\d{1,12}", osm):
        out["place_osm"] = osm
    for k in ("place_cls", "place_type"):
        v = str(g.get(k) or "").strip()
        if re.fullmatch(r"[a-z_:]{1,40}", v):
            out[k] = v
    nm = re.sub(r"\s+", " ", str(g.get("place_name") or "")).strip()[:120]
    if nm:
        out["place_name"] = nm
    bb = g.get("place_bbox")
    if isinstance(bb, (list, tuple)) and len(bb) == 4:
        try:
            v = [float(x) for x in bb]
            if all(math.isfinite(x) for x in v) and -90 <= v[0] <= v[1] <= 90 and -180 <= v[2] <= v[3] <= 180:
                out["place_bbox"] = v
        except (TypeError, ValueError):
            pass
    if g.get("place_approx"):
        out["place_approx"] = True
    return out


def _choice(v, allowed, default):
    v = str(v if v not in (None, "") else default)
    if v not in allowed:
        raise HTTPException(422, f"Недопустимое значение «{v[:30]}»")
    return v


def _crs_text(v) -> str:
    v = str(v or "").strip()
    if not v:
        return ""
    if len(v) > 4000 or not re.fullmatch(r"[\w\s:.,+\-=\[\]\"()/°']+", v, re.U):
        raise HTTPException(422, "СК: укажите код EPSG:XXXX, PROJ-строку или WKT")
    return v


def _color(v) -> str:
    v = str(v or "auto").strip().lower()
    if v in ("auto", "white", "black", "none") or re.fullmatch(r"#[0-9a-f]{6}", v) or re.fullmatch(r"\d{1,3},\d{1,3},\d{1,3}", v):
        return v
    raise HTTPException(422, "Фон: white, black, none, auto или #RRGGBB")


def clean_params(kind: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {"kind": kind}
    if kind == "mb2tif":                           # [v20] MBTiles → GeoTIFF + TFW/TFWX + PRJ
        t = raw.get("mb2tif") or {}
        z = str(t.get("zoom") or "max").strip().lower()
        if z not in ("max", "auto") and not (re.fullmatch(r"\d{1,2}", z) and int(z) <= 24):
            raise HTTPException(422, "Уровень MBTiles: max, auto или число 0…24")
        bg = str(t.get("background") or "none").strip().lower()
        out["mb2tif"] = {
            "zoom": z, "crs": _crs_text(t.get("crs") or "EPSG:3857") or "EPSG:3857",
            "compress": _choice(t.get("compress"), ("deflate", "lzw", "jpeg", "none"), "deflate"),
            "background": "none" if bg in ("", "auto", "transparent") else _color(bg),
            "clip": _choice(t.get("clip"), ("auto", "bounds", "none"), "auto"),
            "resampling": _choice(t.get("resampling"), ("nearest", "bilinear", "cubic", "lanczos", "average"), "cubic"),
            "overviews": bool(t.get("overviews", True)),
        }
        return out
    m = raw.get("mbtiles") or {}
    mb = {
        "enabled": bool(m.get("enabled", True)) if kind == "georef" else True,
        "format": _choice(m.get("format"), ("png", "png8", "jpg", "webp"), "png"),
        "paper": _choice(m.get("paper"), ("auto", "clean", "original", "transparent"), "auto"),
        "background": _color(m.get("background")),
        "merge": re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(m.get("merge") or ""))[:80].strip(" ."),
    }
    zoom = str(m.get("zoom") or "").strip()
    if zoom and not re.fullmatch(r"\d{1,2}(\s*-\s*\d{1,2})?", zoom):
        raise HTTPException(422, "Уровни MBTiles: «мин-макс», например 15-21")
    mb["zoom"] = zoom
    if kind == "mbtiles":
        mb.update({
            "quality": _num(m.get("quality"), 10, 100, 85, True),
            "resampling": _choice(m.get("resampling"), ("nearest", "bilinear", "cubic", "cubic_spline", "lanczos", "average"), "cubic"),
            "tile_size": int(_choice(str(m.get("tile_size") or 256), ("256", "512"), "256")),
            "minzoom": _num(m.get("minzoom"), 0, 24, None, True), "maxzoom": _num(m.get("maxzoom"), 0, 24, None, True),
            "white_threshold": _num(m.get("white_threshold"), 150, 254, 235, True),
            # [v20.3] «auto»: СК файла без .prj/GeoTIFF — по координатам (раньше молча EPSG:3857 → растр не на месте)
            "src_crs": _crs_text(m.get("src_crs") or "auto"), "force_crs": _crs_text(m.get("force_crs")),
            "src_nodata": _num(m.get("src_nodata"), -1e9, 1e9, None), "name": str(m.get("name") or "")[:120],
        })
        if mb["minzoom"] is not None and mb["maxzoom"] is not None and mb["minzoom"] > mb["maxzoom"]:
            raise HTTPException(422, "Мин. уровень больше максимального")
    out["mbtiles"] = mb
    if kind == "georef":
        g = raw.get("georef") or {}
        gg: Dict[str, Any] = {
            # [v20.1] «auto»: радиус — по охвату адреса и размеру листа, масштаб — из файла (текст PDF «1:500»)
            "radius": None if _is_auto(g.get("radius")) else _num(g.get("radius"), 30, 5000, None),
            "scale": None if _is_auto(g.get("scale")) else _num(g.get("scale"), 50, 50000, None),
            "dpi": _num(g.get("dpi"), 50, 1200, None), "orient": _choice(g.get("orient"), ("auto", "0", "90", "180", "270"), "auto"),
            "no_grid": bool(g.get("no_grid")), "buildings": _choice(g.get("buildings"), ("nca", "osm"), "nca"),
            "ortho": _choice(g.get("ortho"), ("nca", "esri"), "nca"), "zoom": _num(g.get("zoom"), 17, 21, 20, True),
            "model": _choice(g.get("model"), ("auto", "rigid", "similarity", "affine"), "auto"),
            "no_fine": bool(g.get("no_fine")), "search_angle": _num(g.get("search_angle"), 0.5, 15, 2.5),
            "search_shift": _num(g.get("search_shift"), 1, 60, 8.0),
        }
        c = g.get("center")
        if c not in (None, "", []):
            if isinstance(c, str):
                c = [t for t in re.split(r"[,;\s]+", c.strip()) if t]
            if not isinstance(c, (list, tuple)) or len(c) != 2:
                raise HTTPException(422, "Точка: «широта, долгота»")
            lat, lon = _num(c[0], -90, 90), _num(c[1], -180, 180)
            if not (40 <= lat <= 70 and 10 <= lon <= 45):
                raise HTTPException(422, "Точка вне зоны покрытия ортофото (ожидается Беларусь и соседние регионы)")
            gg["center"] = [lat, lon]
        addr = re.sub(r"\s+", " ", str(g.get("address") or "")).strip()[:200]
        if addr:
            gg["address"] = addr
            gg["city"] = re.sub(r"\s+", " ", str(g.get("city") or "")).strip()[:60]
            lab = re.sub(r"\s+", " ", str(g.get("place_label") or "")).strip()[:300]
            if lab and gg.get("center"):          # [v20] адрес уже найден в интерфейсе — для журнала и итога
                gg["place_label"] = lab
                gg["place_note"] = re.sub(r"\s+", " ", str(g.get("place_note") or "")).strip()[:200]
                gg.update(_place_obj(g))          # [v20.1] найденный объект — для охвата улицы
        out["georef"] = gg
        p = raw.get("pdf") or {}
        dpi = p.get("dpi")
        out["pdf"] = {"dpi": "auto" if dpi in (None, "", "auto") else _num(dpi, 72, 600),
                      "pages": re.sub(r"[^0-9,;\- ]", "", str(p.get("pages") or ""))[:60] or "all"}
    return out


class GeorefStore(_jk.JobStore):
    SUBDIRS = ("jobs", "cache")
    KIND = "задание"

    def __init__(self, root: Path, runner: Path, python: str, tools: Path, log=None, start_runner: bool = True):
        self.runner = runner
        self.python = python
        self.tools = tools
        self._cache_cleaned = 0.0
        super().__init__(root, log=log, max_jobs=int(_env_float("GEOREF_MAX_JOBS", 1)),
                         timeout_s=_env_float("GEOREF_TIMEOUT_MIN", 60) * 60, keep=int(_env_float("GEOREF_KEEP_JOBS", 300)),
                         keep_hours=_env_float("GEOREF_KEEP_HOURS", 48), start_runner=start_runner)

    def stages_for(self, j):
        return STAGES.get(j.get("kind") or "georef", STAGES["georef"])

    def command_for(self, j):
        jd = self.jdir(j["id"])
        env = _jk.child_env({"GEOREF_TOOLS_DIR": str(self.tools), "GEOREF_CACHE_DIR": str(self.root / "cache")})
        env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 2) - 1)))
        return [self.python, str(self.runner), str(jd)], jd, env

    def parse_line(self, j, line, t0):
        m = PROGRESS_RE.match(line)
        if m:
            self.set_progress(j, int(m.group(1)), m.group(2).strip(), t0)
            return True
        t = re.sub(r"^\s*\[\s*[\d.]+s\]\s*", "", line).strip()
        if not t:
            return False
        if t.startswith("ВНИМАНИЕ"):
            w = j.setdefault("warnings", [])
            if t not in w:
                w.append(t[:300])
                del w[:-15]
            return True
        if t.startswith("Ошибка:"):
            j["last_error"] = t[7:].strip()[:600]
        j["last_message"] = t[:300]
        return False

    def on_success(self, j, rc):
        res = _read_json(self.jdir(j["id"]) / "out" / "result.json")
        if rc == 0 and res and res.get("ok"):
            j["result"] = res
            return True
        return False

    def error_message(self, j, rc, tail):
        if j.get("last_error"):
            return j["last_error"]
        for t in reversed(tail):
            if "Ошибка:" in t:
                return t.split("Ошибка:", 1)[1].strip()[:1200]
        return super().error_message(j, rc, tail)

    def output_files(self, jid):
        out = self.jdir(jid) / "out"
        res = []
        if out.is_dir():
            crs = {}
            r = _read_json(out / "result.json") or {}
            if r.get("kind") == "mb2tif":              # [v20] СК результата своя у каждого файла
                crs = {o.get("file"): o.get("crs_name") or o.get("crs") for o in r.get("outputs") or []}
            for p in sorted(out.iterdir(), key=lambda p: p.name.lower()):
                if p.is_file() and not p.name.startswith("."):
                    lab = f"GeoTIFF ({crs[p.name]})" if crs.get(p.name) else _label(p.name)
                    res.append({"name": p.name, "label": lab, "size": p.stat().st_size})
        return res

    def after_finish(self, j):
        shutil.rmtree(self.jdir(j["id"]) / "work", ignore_errors=True)   # растры страниц PDF и т.п.

    def prune(self):
        super().prune()
        if _now() - self._cache_cleaned < 12 * 3600:
            return
        self._cache_cleaned = _now()
        edge = _now() - _env_float("GEOREF_CACHE_DAYS", 30) * 86400
        for p in (self.root / "cache").glob("*"):
            try:
                if p.is_file() and p.stat().st_mtime < edge:
                    p.unlink()
            except OSError:
                pass


def build_router(*, base_dir: str, is_admin: Callable[[Request], bool], verify_csrf: Callable[[Request], None],
                 register_mbtiles: Optional[Callable[[str, str], Dict[str, Any]]] = None,
                 logger=None, workdir: Optional[str] = None, start_runner: bool = True) -> APIRouter:
    base = Path(base_dir)
    root = Path(workdir or os.environ.get("GEOREF_WORKDIR") or base / "instance" / "georef")
    root.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve().parent
    runner = here / "georef_runner.py"
    tools = Path(os.environ.get("GEOREF_TOOLS_DIR") or (base / "tools" / "georef"))
    if not tools.is_dir() and (here / "tools" / "georef").is_dir():
        tools = here / "tools" / "georef"
    python = os.environ.get("GEOREF_PYTHON") or sys.executable
    store = GeorefStore(root, runner, python, tools, logger, start_runner=start_runner)
    enabled = os.environ.get("GEOREF_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off")
    max_upload = int(_env_float("GEOREF_MAX_UPLOAD_MB", 1024) * MB)
    max_files = int(_env_float("GEOREF_MAX_FILES", 60))
    max_queue = int(_env_float("GEOREF_MAX_QUEUE", 12))
    max_per_ip = int(_env_float("GEOREF_MAX_PER_IP", 4))
    r = APIRouter(prefix="/api/georef", tags=["georef"])
    r.store = store
    check_cache: Dict[str, Any] = {"t": 0.0, "v": None}
    check_lock = threading.Lock()

    # ── доступ ──
    def owner_of(request: Request) -> Optional[str]:
        tok = request.cookies.get(COOKIE) or ""
        if not re.fullmatch(r"[0-9a-f]{32}", tok):
            return None
        return hashlib.sha256(("georef:" + tok).encode()).hexdigest()[:24]

    def need_enabled(request: Request) -> None:
        if not enabled and not is_admin(request):
            raise HTTPException(403, "Инструменты привязки планов отключены администратором (GEOREF_ENABLED)")

    def mutate(request: Request) -> None:
        need_enabled(request)
        verify_csrf(request)

    def own_job(jid: str, request: Request) -> Dict[str, Any]:
        j = store.job(jid)
        if is_admin(request):
            return j
        ow = owner_of(request)
        if not ow or j.get("owner") != ow:
            raise HTTPException(404, "Задание не найдено")
        return j

    def public_job(j: Dict[str, Any], request: Optional[Request] = None) -> Dict[str, Any]:
        out = {k: v for k, v in j.items() if k not in ("pid", "runner_pid", "log_pos", "owner", "ip", "tail", "last_error")}
        out["stages"] = store.stages_for(j)
        if request is not None and is_admin(request):
            out["ip"] = j.get("ip")
        return out

    def client_ip(request: Request) -> str:
        return (request.headers.get("x-real-ip") or (request.client.host if request.client else "") or "")[:64]

    def env_check() -> Dict[str, Any]:
        with check_lock:
            if check_cache["v"] is not None and _now() - check_cache["t"] < 600:
                return check_cache["v"]
            v: Dict[str, Any]
            try:
                kw = _jk.popen_kwargs(_jk.child_env({"GEOREF_TOOLS_DIR": str(tools)}))
                res = subprocess.run([python, str(runner), "--check"], timeout=90, **kw)
                text = _jk._decode(res.stdout or b"")
                a, b = text.find("{"), text.rfind("}")
                v = json.loads(text[a:b + 1]) if a >= 0 else {"error": text[-300:]}
            except Exception as e:  # noqa
                v = {"error": str(e)[:300]}
            check_cache.update(t=_now(), v=v)
            return v

    # ── возможности ──
    @r.get("/caps")
    def caps(request: Request):
        adm = is_admin(request)
        if not enabled and not adm:
            return {"enabled": False, "is_admin": False}
        chk = env_check()
        mods = chk.get("modules") or {}
        problems = []
        if chk.get("error"):
            problems.append("Не запускается проверка окружения: " + chk["error"])
        if not chk.get("tools_dir"):
            problems.append("Нет georef_plans.py / tif2mbtiles.py — положите их в tools/georef/ (GEOREF_TOOLS_DIR)")
        need = {"numpy": "numpy", "cv2": "opencv-python-headless", "rasterio": "rasterio", "shapely": "shapely",
                "mapbox_vector_tile": "mapbox-vector-tile", "PIL": "pillow"}
        miss = [pkg for m, pkg in need.items() if mods and not mods.get(m)]
        if miss:
            problems.append("Не установлены пакеты: " + ", ".join(miss) + " (pip install -r tools/georef/requirements.txt)")
        georef_ok = bool(chk.get("tools_dir")) and bool(mods) and not miss
        mb_ok = bool(chk.get("tools_dir")) and all(mods.get(m) for m in ("numpy", "rasterio", "PIL"))
        mb2_ok = mb_ok and bool((chk.get("tools") or {}).get("mbtiles2tif", True))
        if chk.get("tools_dir") and not mb2_ok and mb_ok:
            problems.append("Нет tools/georef/mbtiles2tif.py — вкладка «MBTiles → TIFF» недоступна")
        jobs = store.jobs()
        return {
            "enabled": True, "is_admin": adm, "georef": georef_ok, "mbtiles": mb_ok, "mb2tif": mb2_ok,
            "mb2tif_max_mp": _env_float("GEOREF_MB2TIF_MAX_MP", 400),
            "pdf": bool(mods.get("pypdfium2") or mods.get("fitz")), "ocr": bool(mods.get("pytesseract")),
            "problems": problems, "python": chk.get("python"), "max_upload_mb": max_upload // MB,
            "max_files": max_files, "max_sheets": int(_env_float("GEOREF_MAX_SHEETS", 12)),
            "queue": sum(1 for j in jobs if j.get("status") in ("queued", "running")),
            "can_register": bool(adm and register_mbtiles), "defaults": DEFAULTS, "scales": SCALES,
            "stages": STAGES, "accept": {k: list(v) for k, v in IN_EXT.items()},
            "keep_hours": _env_float("GEOREF_KEEP_HOURS", 48),
            "can_shift": True,                                         # [v20.3] «Переместить» результат
            "shift_kinds": list(getattr(_gs, "KINDS", ("georef", "mbtiles"))),   # [v20.7] + «MBTiles → TIFF»
            "shift_tools": {n: (tools / f"{n}.py").is_file() for n in ("tif2mbtiles", "mbtiles2tif", "mbtiles_shift")},
            "crs_raster_shift": True,                                  # [v20.7] /api/crs-shift/raster/…
            "version": SERVER_VERSION,
        }

    # ── задания ──
    @r.post("/jobs")
    async def job_create(request: Request):
        mutate(request)
        ow = owner_of(request)
        new_tok = None
        if not ow:
            new_tok = secrets.token_hex(16)
            ow = hashlib.sha256(("georef:" + new_tok).encode()).hexdigest()[:24]
        ip = client_ip(request)
        admin_req = is_admin(request)

        def limit_error() -> Optional[str]:
            active = [j for j in store.jobs() if j.get("status") in ("queued", "running")]
            if len(active) >= max_queue:
                return "Очередь заполнена — попробуйте через несколько минут"
            if not admin_req:
                if sum(1 for j in active if j.get("owner") == ow) >= 2:
                    return "У вас уже два задания в работе — дождитесь их завершения"
                if ip and sum(1 for j in active if j.get("ip") == ip) >= max_per_ip:
                    return "С вашего адреса уже слишком много заданий в работе — дождитесь их завершения"
            return None

        err = await run_in_threadpool(limit_error)
        if err:
            raise HTTPException(429, err)
        ln = int(request.headers.get("content-length") or 0)
        if ln > max_upload + MB:
            raise HTTPException(413, f"Больше {max_upload // MB} МБ за раз")
        try:
            form = await request.form(max_files=max_files + 1, max_fields=20)
        except TypeError:                                   # старый Starlette
            form = await request.form()
        kind = str(form.get("kind") or "georef")
        if kind not in STAGES:
            raise HTTPException(422, "Неизвестный вид задания")
        try:
            raw = json.loads(str(form.get("params") or "{}"))
        except ValueError:
            raise HTTPException(422, "params: ожидается JSON")
        params = clean_params(kind, raw)
        if kind == "georef" and not params["georef"].get("center") and not params["georef"].get("address"):
            raise HTTPException(422, "Укажите место: адрес или точку на карте")
        uploads = [f for f in form.getlist("files") if hasattr(f, "filename") and f.filename]
        if not uploads:
            raise HTTPException(422, "Нет файлов")
        if len(uploads) > max_files:
            raise HTTPException(413, f"Не больше {max_files} файлов за раз")
        jid = uuid.uuid4().hex[:16]
        jd = root / "jobs" / jid
        await run_in_threadpool((jd / "in").mkdir, parents=True)
        total, names, used = 0, [], set()
        try:
            for up in uploads:
                name = _jk._safe_name(up.filename, "file")
                low = name.lower()
                if not low.endswith(IN_EXT[kind]) and not low.endswith(".aux.xml"):
                    raise HTTPException(422, f"Файл «{name}»: такой тип не поддерживается")
                k, base = 2, name
                while name.lower() in used:
                    stem, dot, ext = base.partition(".")
                    name, k = f"{stem}_{k}.{ext}" if dot else f"{base}_{k}", k + 1
                used.add(name.lower())
                fh = await run_in_threadpool(open, jd / "in" / name, "wb")
                try:
                    while True:
                        chunk = await up.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_upload:
                            raise HTTPException(413, f"Больше {max_upload // MB} МБ за раз")
                        await run_in_threadpool(fh.write, chunk)
                finally:
                    await run_in_threadpool(fh.close)
                names.append({"name": name, "size": (jd / "in" / name).stat().st_size})
            if kind == "georef" and not any(n["name"].lower().endswith(IN_EXT["georef"][:-1]) or n["name"].lower().endswith(".zip") for n in names):
                raise HTTPException(422, "Нужен скан плана (JPG/PNG/TIFF) или PDF")
            free = shutil.disk_usage(root).free
            if free < total * 6 + 1024 * MB:
                raise HTTPException(507, "Мало места на диске сервера")
        except BaseException:
            await run_in_threadpool(shutil.rmtree, jd, True)
            raise
        finally:
            for up in uploads:
                try:
                    await up.close()
                except Exception:
                    pass
        title = str(form.get("title") or "").strip()[:120] or ", ".join(n["name"] for n in names[:3]) + ("…" if len(names) > 3 else "")
        j = {"id": jid, "kind": kind, "title": title, "created": _now(), "status": "queued", "progress": 0,
             "stage": "В очереди", "stage_index": -1, "params": params, "inputs": names, "input_bytes": total,
             "owner": ow, "ip": ip, "eta_s": None}

        def commit() -> Optional[str]:
            # повторная проверка под локом прямо перед постановкой: загрузка шла долго, лимиты могли быть исчерпаны
            with store.lock:
                store._invalidate_jobs()
                err = limit_error()
                if err:
                    shutil.rmtree(jd, ignore_errors=True)
                    return err
                _atomic_json(jd / "params.json", params)
                store.enqueue(j)
            return None

        err = await run_in_threadpool(commit)
        if err:
            raise HTTPException(429, err)
        resp = JSONResponse(public_job(j, request))
        if new_tok:
            secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
            resp.set_cookie(COOKIE, new_tok, max_age=60 * 86400, httponly=True, samesite="lax", secure=secure, path="/api/georef")
        return resp

    @r.get("/jobs")
    def jobs(request: Request, all: int = 0, limit: int = 30, kind: str = ""):
        need_enabled(request)
        ow = owner_of(request)
        items = store.jobs()
        if not (all and is_admin(request)):
            items = [j for j in items if ow and j.get("owner") == ow]
        if kind in STAGES:
            items = [j for j in items if (j.get("kind") or "georef") == kind]
        q = [j for j in store.jobs() if j.get("status") in ("queued", "running")]
        q.sort(key=lambda j: j.get("created", 0))
        pos = {j["id"]: i for i, j in enumerate(x for x in q if x.get("status") == "queued")}
        res = []
        for j in items[: max(1, min(200, limit))]:
            pj = public_job(j, request)
            if j["id"] in pos:
                pj["queue_pos"] = pos[j["id"]] + 1
            res.append(pj)
        return {"items": res, "queue": len(q)}

    @r.get("/jobs/{jid}")
    def job_get(jid: str, request: Request):
        j = own_job(jid, request)
        if j.get("status") == "done" and not j.get("files"):
            j["files"] = store.output_files(jid)
        pj = public_job(j, request)
        if j.get("status") == "queued":
            q = sorted((x for x in store.jobs() if x.get("status") == "queued"), key=lambda x: x.get("created", 0))
            pj["queue_pos"] = next((i + 1 for i, x in enumerate(q) if x["id"] == jid), None)
        return pj

    @r.get("/jobs/{jid}/log")
    def job_log(jid: str, request: Request, offset: int = 0):
        own_job(jid, request)
        p = store.jdir(jid) / "log.txt"
        if not p.is_file():
            return {"text": "", "next": 0, "size": 0}
        size = p.stat().st_size
        offset = max(0, min(int(offset), size))
        with open(p, "rb") as f:
            f.seek(max(offset, size - 512 * 1024) if offset == 0 else offset)
            data = f.read(512 * 1024)
        return {"text": _jk._decode(data), "next": offset + len(data) if offset else size, "size": size}

    @r.post("/jobs/{jid}/cancel")
    def job_cancel(jid: str, request: Request):
        mutate(request)
        own_job(jid, request)
        return public_job(store.cancel(jid), request)

    @r.delete("/jobs/{jid}")
    def job_delete(jid: str, request: Request):
        mutate(request)
        own_job(jid, request)
        return {"ok": store.delete(jid)}

    @r.post("/jobs/{jid}/rerun")
    async def job_rerun(jid: str, request: Request):
        """Повтор с другими параметрами (место, масштаб, MBTiles…) — без повторной загрузки файлов."""
        mutate(request)
        src = own_job(jid, request)
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > 256 * 1024:
                raise HTTPException(413, "Слишком большой запрос")
        try:
            raw = json.loads(bytes(body) or b"{}")
        except ValueError:
            raise HTTPException(422, "Ожидается JSON")
        kind = src.get("kind") or "georef"
        params = clean_params(kind, raw.get("params") or {})
        if kind == "georef" and not params["georef"].get("center") and not params["georef"].get("address"):
            raise HTTPException(422, "Укажите место: адрес или точку на карте")
        sin = store.jdir(jid) / "in"
        if not sin.is_dir() or not any(sin.iterdir()):
            raise HTTPException(410, "Исходные файлы уже удалены — загрузите их заново")
        active = [j for j in store.jobs() if j.get("status") in ("queued", "running")]
        if len(active) >= max_queue:
            raise HTTPException(429, "Очередь заполнена — попробуйте через несколько минут")
        if not is_admin(request) and sum(1 for j in active if j.get("owner") == src.get("owner")) >= 2:
            raise HTTPException(429, "У вас уже два задания в работе — дождитесь их завершения")
        nid = uuid.uuid4().hex[:16]
        nd = root / "jobs" / nid
        (nd / "in").mkdir(parents=True)
        for p in sin.iterdir():
            try:
                os.link(p, nd / "in" / p.name)          # без копирования (тот же диск)
            except OSError:
                shutil.copy2(p, nd / "in" / p.name)
        _atomic_json(nd / "params.json", params)
        j = {"id": nid, "kind": kind, "title": src.get("title"), "created": _now(), "status": "queued", "progress": 0,
             "stage": "В очереди", "stage_index": -1, "params": params, "inputs": src.get("inputs"),
             "input_bytes": src.get("input_bytes"), "owner": src.get("owner"), "ip": client_ip(request),
             "parent": jid, "version": int(src.get("version") or 1) + 1, "eta_s": None}
        store.enqueue(j)
        return public_job(j, request)

    # ── результаты ──
    def out_file(jid: str, name: str) -> Path:
        if not re.fullmatch(r"[^/\\\x00]{1,200}", name or "") or name.startswith("."):
            raise HTTPException(404, "Файл не найден")
        p = store.jdir(jid) / "out" / name
        if not p.is_file():
            raise HTTPException(404, "Файл не найден")
        return p

    @r.get("/jobs/{jid}/files/{name}")
    def job_file(jid: str, name: str, request: Request, inline: int = 0):
        own_job(jid, request)
        p = out_file(jid, name)
        ext = "".join(p.suffixes[-1:]).lower()
        if inline and ext in INLINE:
            return FileResponse(p, media_type=INLINE[ext], headers={"Cache-Control": "private, max-age=600",
                                                                  "Content-Disposition": "inline"})
        return FileResponse(p, filename=p.name, media_type="application/octet-stream",
                            headers={"Cache-Control": "private, no-store"})

    @r.get("/jobs/{jid}/zip")
    def job_zip(jid: str, request: Request, what: str = "all", sheet: str = ""):
        j = own_job(jid, request)
        files = [f["name"] for f in store.output_files(jid)]
        if sheet:
            files = [n for n in files if n == sheet + ".mbtiles" or n.startswith(sheet + ".")]
        if j.get("kind") == "mb2tif":                 # [v20] в архив — только ГИС-файлы
            files = [n for n in files if n.endswith((".tif", ".tfw", ".tfwx", ".prj", ".ovr"))]
        if what == "gis":
            files = [n for n in files if not n.endswith(".mbtiles")]
        elif what == "mbtiles":
            files = [n for n in files if n.endswith(".mbtiles")]
        if not files:
            raise HTTPException(404, "Нет результатов")
        key = hashlib.md5(("|".join(files) + what + sheet).encode()).hexdigest()[:10]
        zp = store.jdir(jid) / f".results_{key}.zip"
        newest = max(out_file(jid, n).stat().st_mtime for n in files)
        if not zp.is_file() or zp.stat().st_mtime < newest:
            tmp = zp.with_name(f".zip.{os.getpid()}.{threading.get_ident()}.tmp")
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
                for n in files:
                    ct = zipfile.ZIP_STORED if n.endswith((".mbtiles", ".tif", ".ovr", ".jpg")) else zipfile.ZIP_DEFLATED
                    z.write(out_file(jid, n), arcname=n, compress_type=ct)
            os.replace(tmp, zp)
        title = sheet or re.sub(r"\.(pdf|jpe?g|png|tiff?|bmp|webp|zip|7z|rar)$", "", str(j.get("title") or "plan"), flags=re.I)
        base = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", title)[:60].strip(" .") or "plan"
        suffix = {"gis": "_GeoTIFF", "mbtiles": "_MBTiles"}.get(what, "_GeoTIFF" if j.get("kind") == "mb2tif" else "")
        return FileResponse(zp, media_type="application/zip", filename=f"{base}{suffix}.zip",
                            headers={"Cache-Control": "private, no-store"})

    @r.get("/jobs/{jid}/footprints")
    def job_footprints(jid: str, request: Request):
        j = own_job(jid, request)
        res = j.get("result") or {}
        feats = []
        for s in res.get("sheets") or []:
            cs = s.get("corners_latlon")
            if not s.get("registered") or not cs:
                continue
            ring = [[c[1], c[0]] for c in cs] + [[cs[0][1], cs[0][0]]]
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
                          "properties": {"name": s["name"], "quality": s.get("quality"), "mbtiles": s.get("mbtiles"),
                                         "scale": s.get("plan_scale") or (s.get("scale_denominator") or [None])[0],
                                         "rotation": s.get("rotation_deg")}})
        for m in res.get("mbtiles") or []:
            b = m.get("bounds_lonlat")
            if b and res.get("kind") == "mbtiles":
                feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]]},
                              "properties": {"name": m["file"], "mbtiles": m["file"]}})
        for o in res.get("outputs") or []:            # [v20] MBTiles → TIFF
            b = o.get("bounds_lonlat")
            if b:
                feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]]},
                              "properties": {"name": o.get("file"), "file": o.get("file"), "crs": o.get("crs"),
                                             "preview": o.get("preview"), "preview_bounds_3857": o.get("preview_bounds_3857")}})
        return {"type": "FeatureCollection", "features": feats}

    conns: Dict[str, Any] = {}
    conns_lock = threading.Lock()

    def mb_conn(path: Path):
        key = str(path)
        mt = path.stat().st_mtime
        with conns_lock:
            c = conns.get(key)
            if c and c[1] == mt:
                return c[0], c[2]
            if c:
                try:
                    c[0].close()
                except Exception:
                    pass
            if len(conns) > 24:
                for k in list(conns)[:8]:
                    try:
                        conns.pop(k)[0].close()
                    except Exception:
                        pass
            con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
            fmt = "png"
            try:
                row = con.execute("SELECT value FROM metadata WHERE name='format'").fetchone()
                fmt = (row[0] if row else "png").lower()
            except Exception:
                pass
            lock = threading.Lock()
            conns[key] = (con, mt, (fmt, lock))
            return con, (fmt, lock)

    @r.get("/jobs/{jid}/tiles/{name}/{z}/{x}/{y}.png")
    def job_tile(jid: str, name: str, z: int, x: int, y: int, request: Request):
        own_job(jid, request)
        if not name.endswith(".mbtiles"):
            name += ".mbtiles"
        p = out_file(jid, name)
        if not (0 <= z <= 24 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
            return Response(status_code=204)
        con, (fmt, lock) = mb_conn(p)
        with lock:
            row = con.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                              (z, x, (2 ** z - 1) - y)).fetchone()
        if not row:
            return Response(status_code=204, headers={"Cache-Control": "private, max-age=600"})
        media = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(fmt, "image/png")
        return Response(bytes(row[0]), media_type=media, headers={"Cache-Control": "private, max-age=600"})

    @r.post("/jobs/{jid}/register")
    async def job_register(jid: str, request: Request):
        """Администратор: MBTiles результата → слой карты (папка «MBTILES MINSK»)."""
        verify_csrf(request)
        if not is_admin(request):
            raise HTTPException(403, "Добавлять слои на карту может только администратор")
        if not register_mbtiles:
            raise HTTPException(501, "Регистрация слоёв не подключена")
        j = own_job(jid, request)
        body = await request.json()
        name = str(body.get("file") or "")
        if not name.endswith(".mbtiles"):
            raise HTTPException(422, "Нужен файл .mbtiles")
        p = out_file(jid, name)
        title = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:120] or Path(name).stem
        from starlette.concurrency import run_in_threadpool
        layer = await run_in_threadpool(register_mbtiles, str(p), title)
        reg = j.setdefault("registered", {})
        reg[name] = {"id": layer.get("id"), "name": layer.get("name"), "at": _now()}
        store.save_job(j)
        return layer

    # ── [v20.3] ручной сдвиг результата: лист плана или MBTiles ──
    shift_locks: Dict[str, threading.Lock] = {}
    shift_guard = threading.Lock()

    def release_mb(path: Path) -> None:
        """закрыть кэшированное соединение SQLite перед заменой файла (Windows не даёт заменить открытый)"""
        with conns_lock:
            c = conns.pop(str(path), None)
        if c:
            with c[2][1]:
                try:
                    c[0].close()
                except Exception:
                    pass

    @r.post("/jobs/{jid}/shift")
    async def job_shift(jid: str, request: Request):
        """Сдвинуть результат на dx, dy (м EPSG:3857, восток/север) или вернуть исходную привязку (reset):
        лист «План → GeoTIFF» — GeoTIFF/.ovr/.tfw/.tfwx/.aux.xml на месте + MBTiles заново;
        «Растр → MBTiles» — MBTiles заново из исходников со сдвигом;
        [v20.7] «MBTiles → TIFF» — привязка GeoTIFF/TFW/TFWX + «<имя>_сдвиг.mbtiles» из исходного MBTiles."""
        mutate(request)
        j = own_job(jid, request)
        if j.get("status") != "done" or not j.get("result"):
            raise HTTPException(409, "Задание ещё не готово")
        body = await request.body()
        if len(body) > 64 * 1024:
            raise HTTPException(413, "Слишком большой запрос")
        try:
            raw = json.loads(body or b"{}")
        except ValueError:
            raise HTTPException(422, "Ожидается JSON")
        target = str(raw.get("target") or "")[:200]
        reset = bool(raw.get("reset"))
        dx = 0.0 if reset else _num(raw.get("dx"), -_gs.MAX_STEP, _gs.MAX_STEP, 0.0)
        dy = 0.0 if reset else _num(raw.get("dy"), -_gs.MAX_STEP, _gs.MAX_STEP, 0.0)
        with shift_guard:
            lock = shift_locks.setdefault(jid, threading.Lock())
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "Предыдущий сдвиг ещё сохраняется — подождите")
        try:
            from starlette.concurrency import run_in_threadpool

            def work():
                jj = store.job(jid)                      # свежая запись — под блокировкой
                kw = _jk.popen_kwargs(_jk.child_env({"GEOREF_TOOLS_DIR": str(tools)}))
                res, info = _gs.apply_shift(store.jdir(jid), jj, target, dx, dy, reset, python=python, tools=tools,
                                            popen_kwargs=kw, release=release_mb,
                                            timeout=_env_float("GEOREF_SHIFT_TIMEOUT", 900))
                jj["result"] = res
                jj["files"] = store.output_files(jid)
                store.save_job(jj)
                return jj, info
            try:
                jj, info = await run_in_threadpool(work)
            except _gs.ShiftError as e:
                raise HTTPException(e.status, str(e))
        finally:
            lock.release()
        if logger:
            try:
                logger.info("georef shift %s «%s»: %s", jid, target, info)
            except Exception:
                pass
        return {"ok": True, "job": public_job(jj, request), **info}

    # ── [v20.7] «Смена СК»: сохранённые перемещения растров ──
    # ZIP со сдвинутой привязкой (теги GeoTIFF, .tfw/.tfwx, .aux.xml) собирается в браузере (panel-crs.js);
    # здесь он только хранится — у каждого владельца (cookie crs_raster_uid) своё. Пути — под /api/crs-shift/,
    # где уже настроены лимиты nginx и security_hardening; 4 сегмента — чтобы не пересекаться с crs_shift.py.
    r.routes.extend(_crs_raster_router(root / "crs_shift", verify_csrf, logger).routes)
    return r


def _crs_raster_router(croot: Path, verify_csrf: Callable[[Request], None], logger=None) -> APIRouter:
    cr = APIRouter(prefix="/api/crs-shift/raster", tags=["crs-shift"])
    max_bytes = int(_env_float("CRS_RASTER_SHIFT_MAX_MB", 2048) * MB)
    keep_s = _env_float("CRS_RASTER_SHIFT_DAYS", 14) * 86400
    state = {"pruned": 0.0}
    plock = threading.Lock()

    def owner(request: Request) -> Optional[str]:
        tok = request.cookies.get(CRS_COOKIE) or ""
        if not re.fullmatch(r"[0-9a-f]{32}", tok):
            return None
        return hashlib.sha256(("crsr:" + tok).encode()).hexdigest()[:24]

    def check(jid: str, idx: int) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}", jid or "") or not (0 <= int(idx) < 100000):
            raise HTTPException(404, "Не найдено")

    def item(jid: str, idx: int, meta: Dict[str, Any]) -> Dict[str, Any]:
        v = int(float(meta.get("saved_at") or 0) * 1000) % 10 ** 10
        base = f"/api/crs-shift/raster/{jid}/{idx}"
        return {"download_url": f"{base}/file?v={v}", "preview_url": f"{base}/preview?v={v}", "name": meta.get("name"),
                "info": meta.get("info") or "", "size": meta.get("size"), "saved_at": meta.get("saved_at"),
                "files": meta.get("files") or [], "raster": True}

    def prune() -> None:
        with plock:
            if _now() - state["pruned"] < 6 * 3600:
                return
            state["pruned"] = _now()
        edge = _now() - keep_s
        if not croot.is_dir():
            return
        for od in croot.iterdir():
            for jd in (od.iterdir() if od.is_dir() else []):
                for d in (jd.iterdir() if jd.is_dir() else []):
                    m = _read_json(d / "meta.json") or {}
                    if float(m.get("saved_at") or 0) < edge or (d.name.startswith(".") and d.stat().st_mtime < _now() - 3600):
                        shutil.rmtree(d, ignore_errors=True)
                try:
                    if jd.is_dir() and not any(jd.iterdir()):
                        jd.rmdir()
                except OSError:
                    pass

    @cr.post("/{jid}/{idx}/file")
    async def save(jid: str, idx: int, request: Request):
        """ZIP (растр + привязка со сдвигом) и GeoJSON-контур → сохранить; ответ — ссылки на них."""
        verify_csrf(request)
        check(jid, idx)
        if int(request.headers.get("content-length") or 0) > max_bytes + MB:
            raise HTTPException(413, f"Архив больше {max_bytes // MB} МБ (CRS_RASTER_SHIFT_MAX_MB)")
        ow, new_tok = owner(request), None
        if not ow:
            new_tok = secrets.token_hex(16)
            ow = hashlib.sha256(("crsr:" + new_tok).encode()).hexdigest()[:24]
        try:
            form = await request.form(max_files=3, max_fields=10)
        except TypeError:                                   # старый Starlette
            form = await request.form()
        ups = [form.get("zip"), form.get("geojson")]
        try:
            up, gup = ups
            if not hasattr(up, "read"):
                raise HTTPException(422, "Нет ZIP со сдвинутым растром (поле zip)")
            name = _jk._safe_name(str(form.get("name") or getattr(up, "filename", "") or "raster_сдвиг.zip"), "raster_сдвиг.zip")
            if not name.lower().endswith(".zip"):
                name += ".zip"
            d = croot / ow / jid / str(idx)
            tmp = d.with_name(f".{idx}.{uuid.uuid4().hex[:8]}")
            tmp.mkdir(parents=True)
            try:
                total = 0
                with open(tmp / "shift.zip", "wb") as fh:
                    while True:
                        chunk = await up.read(MB)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            raise HTTPException(413, f"Архив больше {max_bytes // MB} МБ (CRS_RASTER_SHIFT_MAX_MB)")
                        fh.write(chunk)
                try:
                    with zipfile.ZipFile(tmp / "shift.zip") as z:
                        names = [i.filename for i in z.infolist() if not i.is_dir()][:5000]
                except zipfile.BadZipFile:
                    raise HTTPException(422, "Это не ZIP-архив")
                low = [n.lower() for n in names]
                if not any(n.endswith(CRS_RASTER_EXT) for n in low):
                    raise HTTPException(422, "В архиве нет растра (.tif, .jpg, .png…)")
                if any(n.startswith(("/", "\\")) or ".." in n.replace("\\", "/").split("/") for n in names):
                    raise HTTPException(422, "Недопустимые пути в архиве")
                gj = b""
                if hasattr(gup, "read"):
                    gj = await gup.read(4 * MB + 1)
                    if len(gj) > 4 * MB:
                        raise HTTPException(413, "Контур (GeoJSON) больше 4 МБ")
                    try:
                        g = json.loads(gj.decode("utf-8") or "{}")
                        if not isinstance(g, dict) or "type" not in g:
                            raise ValueError
                    except (ValueError, UnicodeDecodeError):
                        raise HTTPException(422, "Контур: ожидается GeoJSON")
                (tmp / "preview.geojson").write_bytes(gj or b'{"type":"FeatureCollection","features":[]}')
                meta = {"name": name, "info": re.sub(r"[\x00-\x1f]+", " ", str(form.get("info") or ""))[:600], "size": total,
                        "saved_at": _now(), "files": names[:60],
                        "georef": [n for n in names if n.lower().endswith(CRS_WORLD_EXT)][:20]}
                _atomic_json(tmp / "meta.json", meta)
                old = None
                if d.exists():
                    old = d.with_name(f".{idx}.old.{uuid.uuid4().hex[:6]}")
                    os.replace(d, old)
                os.replace(tmp, d)
                if old is not None:
                    shutil.rmtree(old, ignore_errors=True)
            except BaseException:
                shutil.rmtree(tmp, ignore_errors=True)
                raise
        finally:
            for u in ups:
                if hasattr(u, "close"):
                    try:
                        await u.close()
                    except Exception:
                        pass
        try:
            prune()
        except Exception:
            pass
        if logger:
            try:
                logger.info("crs raster shift saved %s/%s: %s (%d B)", jid, idx, name, total)
            except Exception:
                pass
        resp = JSONResponse({"ok": True, **item(jid, idx, meta)})
        if new_tok:
            secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
            resp.set_cookie(CRS_COOKIE, new_tok, max_age=60 * 86400, httponly=True, samesite="lax", secure=secure,
                            path="/api/crs-shift/raster")
        return resp

    def find(jid: str, idx: int, request: Request) -> Path:
        check(jid, idx)
        ow = owner(request)
        d = croot / ow / jid / str(idx) if ow else None
        if d is None or not (d / "meta.json").is_file():
            raise HTTPException(404, "Сохранённое перемещение не найдено")
        return d

    @cr.get("/{jid}/items/all")
    def items(jid: str, request: Request):
        check(jid, 0)
        ow = owner(request)
        res: Dict[str, Any] = {}
        jd = croot / ow / jid if ow else None
        if jd is not None and jd.is_dir():
            for d in jd.iterdir():
                if d.is_dir() and d.name.isdigit():
                    m = _read_json(d / "meta.json")
                    if m and (d / "shift.zip").is_file():
                        res[d.name] = item(jid, int(d.name), m)
        return JSONResponse({"items": res, "raster": True}, headers={"Cache-Control": "no-store"})

    @cr.get("/{jid}/{idx}/file")
    def download(jid: str, idx: int, request: Request):
        d = find(jid, idx, request)
        m = _read_json(d / "meta.json") or {}
        return FileResponse(d / "shift.zip", media_type="application/zip", filename=m.get("name") or "raster_сдвиг.zip",
                            headers={"Cache-Control": "private, no-store"})

    @cr.get("/{jid}/{idx}/preview")
    def preview(jid: str, idx: int, request: Request):
        d = find(jid, idx, request)
        return FileResponse(d / "preview.geojson", media_type="application/geo+json",
                            headers={"Cache-Control": "private, no-store"})

    @cr.delete("/{jid}/{idx}/file")
    def remove(jid: str, idx: int, request: Request):
        """Удалить сохранённое перемещение; повторное удаление (или не было сохранено) — тоже 200, removed=false."""
        verify_csrf(request)
        check(jid, idx)
        ow = owner(request)
        d = croot / ow / jid / str(idx) if ow else None
        found = d is not None and d.is_dir()
        if found:
            shutil.rmtree(d, ignore_errors=True)
        return {"ok": True, "removed": found}

    return cr
