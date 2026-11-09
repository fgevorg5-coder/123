# -*- coding: utf-8 -*-
"""
lesolidar_bridge.py — ЛесоЛидар внутри геосервиса (v19).

Обработчик облаков точек LesoLidar (LesoLidar.exe, режим командной строки) запускается
сервером как отдельный процесс. Модуль даёт веб-интерфейсу:

  • загрузку LAS/LAZ кусками с докачкой (init → chunk → complete) и проверкой заголовка;
  • «инспектор» файла: точки, версия, CRS/EPSG, RGB, охват, плотность (команда `info`);
  • очередь заданий `process` с живым прогрессом по этапам, журналом, оценкой времени,
    отменой (снятие всего дерева процессов) и историей пересчётов (версии одного файла);
  • результаты: сводка (summary.json), таблица деревьев (DBF вершин), бинарный слой
    деревьев для 3D, сетка рельефа/высот крон (dtm.tif/chm.tif) в координатах 3D-сцены,
    отчёт dashboard.html (в песочнице), скачивание файлов и ZIP.

Где лежит обработчик (первое найденное):
  LESOLIDAR_EXE      — полный путь к LesoLidar.exe (рядом должна быть папка _internal,
                       а также models/ и tables/, если они есть в поставке);
  LESOLIDAR_PYTHON   — интерпретатор Python 3.11 с пакетом lesolidar (альтернатива exe,
                       например на Linux), LESOLIDAR_PATH — каталог, где лежит пакет;
  <BASE_DIR>/tools/LesoLidar/LesoLidar.exe, <BASE_DIR>/LesoLidar/LesoLidar.exe — по умолчанию.
  [v20.10] Ищется и в «двойной» папке после распаковки (tools/LesoLidar/LesoLidar/LesoLidar.exe,
  tools/LesoLidar*/…/LesoLidar.exe), рядом с папкой приложения; LESOLIDAR_EXE может указывать на папку,
  кавычки в пути убираются, .env перечитывается. Пока обработчик не найден, /caps проверяет заново
  (не чаще раза в 3 с) — после копирования программы перезапуск не нужен, кнопка «Проверить снова».
Прочее: LESOLIDAR_WORKDIR (instance/lesolidar), LESOLIDAR_MAX_UPLOAD_GB (20),
LESOLIDAR_MAX_JOBS (1 — одновременно), LESOLIDAR_TIMEOUT_MIN (360), LESOLIDAR_KEEP_JOBS (200).

Права: просмотр — как у 3D-режима (зависимость подключается в app.py), загрузка/запуск/
удаление — только администратор (+ CSRF-токен).
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool

try:                                   # пакетом (tests) или рядом с app.py
    from . import jobkit as _jk        # type: ignore
except ImportError:                    # pragma: no cover
    import jobkit as _jk               # type: ignore
MB = _jk.MB
IS_WIN = _jk.IS_WIN
ID_RE = _jk.ID_RE
PROGRESS_RE = _jk.PROGRESS_RE
JobStore = _jk.JobStore
_now, _env_float, _decode = _jk._now, _jk._env_float, _jk._decode
_atomic_json, _read_json, _check_id = _jk._atomic_json, _jk._read_json, _jk._check_id
_pid_alive, _kill_pid_tree, kill_tree = _jk._pid_alive, _jk._kill_pid_tree, _jk.kill_tree
popen_kwargs, child_env, _jk_safe_name = _jk.popen_kwargs, _jk.child_env, _jk._safe_name
CHUNK = 32 * MB                      # nginx: client_max_body_size 40m для /api/lesolidar/upload/
STAGES = [
    "Чтение и обрезка облака точек",
    "Рельеф (ЦМР) и модель высот крон",
    "Поиск вершин и сегментация деревьев",
    "Классификация пород",
    "Диаметры, разряды высот и объёмы",
    "Экспорт результатов",
]
# Код породы → (название, краткое, группа, цвет, числовой код для 3D-слоя)
SPECIES = {
    "pine": ("Сосна", "С", "conifer", "#e41a1c", 1),
    "spruce": ("Ель", "Е", "conifer", "#377eb8", 2),
    "larch": ("Лиственница", "Лц", "conifer", "#ff7f00", 3),
    "birch": ("Берёза", "Б", "deciduous", "#e6c200", 11),
    "aspen": ("Осина", "Ос", "deciduous", "#4daf4a", 12),
    "alder_black": ("Ольха чёрная", "Олч", "deciduous", "#a65628", 13),
    "alder_grey": ("Ольха серая", "Олс", "deciduous", "#bf812d", 14),
    "oak": ("Дуб", "Д", "deciduous", "#984ea3", 15),
    "hornbeam": ("Граб", "Г", "deciduous", "#f781bf", 16),
    "ash": ("Ясень", "Я", "deciduous", "#66c2a5", 17),
    "conifer": ("Хвойные (не уточн.)", "Хв", "conifer", "#d95f02", 30),
    "deciduous": ("Лиственные (не уточн.)", "Лв", "deciduous", "#1b9e77", 31),
}
DEFAULT_SPECIES = ["pine", "spruce", "birch", "aspen", "alder_black", "oak"]
OUTPUT_FILES = {
    # имя → (подпись, тип содержимого)
    "dtm.tif": ("ЦМР (рельеф), GeoTIFF", "image/tiff"),
    "dtm.qml": ("Стиль QGIS для ЦМР", "application/xml"),
    "chm.tif": ("Модель высот крон (CHM), GeoTIFF", "image/tiff"),
    "chm.qml": ("Стиль QGIS для CHM", "application/xml"),
    "trees_tops.shp": ("Вершины деревьев, SHP", "application/octet-stream"),
    "trees_tops.shx": ("", "application/octet-stream"),
    "trees_tops.dbf": ("", "application/octet-stream"),
    "trees_tops.prj": ("", "text/plain"),
    "trees_tops.cpg": ("", "text/plain"),
    "trees_tops.qml": ("", "application/xml"),
    "trees_crowns.shp": ("Кроны деревьев, SHP", "application/octet-stream"),
    "trees_crowns.shx": ("", "application/octet-stream"),
    "trees_crowns.dbf": ("", "application/octet-stream"),
    "trees_crowns.prj": ("", "text/plain"),
    "trees_crowns.cpg": ("", "text/plain"),
    "trees_crowns.qml": ("", "application/xml"),
    "taksaciya.xlsx": ("Таксационная ведомость, Excel",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "dashboard.html": ("Отчёт по участку, HTML", "text/html"),
    "summary.json": ("Сводка, JSON", "application/json"),
    "params.json": ("Параметры расчёта, JSON", "application/json"),
    "segmented.laz": ("Облако с номерами деревьев, LAZ", "application/octet-stream"),
    "log.txt": ("Журнал обработки", "text/plain"),
    "boundary.geojson": ("Граница участка, GeoJSON", "application/geo+json"),
}
# Параметры, которые принимает веб-мастер (всё прочее отбрасывается). (тип, мин, макс)
PARAM_SPEC = {
    "epsg": ("int", 1024, 999999),
    "region": ("str", 0, 60),
    "season": ("enum", ("summer", "winter")),
    "model_path": ("model",),
    "species": ("species",),
    "height_ranks": ("ranks",),
    "use_existing_ground": ("bool",),
    "dtm_res": ("float", 0.25, 5.0),
    "chm_res": ("float", 0.1, 2.0),
    "smooth_sigma_m": ("float", 0.0, 2.0),
    "min_tree_height": ("float", 1.0, 20.0),
    "ws_a": ("float", 0.2, 5.0),
    "ws_b": ("float", 0.0, 0.4),
    "crown_rel_threshold": ("float", 0.05, 0.95),
    "max_crown_a": ("float", 0.2, 6.0),
    "max_crown_b": ("float", 0.0, 0.6),
    "min_crown_area": ("float", 0.0, 30.0),
    "thin_density": ("float", 0.0, 1000.0),
    "max_points_millions": ("float", 1.0, 3000.0),
    "dbh_step_cm": ("int", 1, 8),
    "export_rasters": ("bool",),
    "export_shp": ("bool",),
    "export_xlsx": ("bool",),
    "export_html": ("bool",),
    "export_las": ("bool",),
}
DEFAULT_PARAMS = {
    "epsg": None, "region": "Беларусь", "season": "summer", "model_path": "",
    "species": list(DEFAULT_SPECIES), "height_ranks": {}, "use_existing_ground": True,
    "dtm_res": 1.0, "chm_res": 0.33, "smooth_sigma_m": 0.3, "min_tree_height": 4.0,
    "ws_a": 1.2, "ws_b": 0.05, "crown_rel_threshold": 0.4, "max_crown_a": 1.5,
    "max_crown_b": 0.22, "min_crown_area": 0.5, "thin_density": 0, "max_points_millions": 60,
    "dbh_step_cm": 4, "export_rasters": True, "export_shp": True, "export_xlsx": True,
    "export_html": True, "export_las": False,
}
EPSG_PRESETS = [
    {"epsg": 32635, "name": "WGS 84 / UTM 35N — центр Беларуси (24°–30° в. д.)"},
    {"epsg": 32634, "name": "WGS 84 / UTM 34N — крайний запад (до 24° в. д.)"},
    {"epsg": 32636, "name": "WGS 84 / UTM 36N — восток (от 30° в. д.)"},
    {"epsg": 2180, "name": "ETRS89 / Poland CS92"},
    {"epsg": 3301, "name": "Estonian Coordinate System 1997"},
    {"epsg": 3059, "name": "LKS-92 / Latvia TM"},
    {"epsg": 28405, "name": "Pulkovo 1942 / Gauss-Krüger 5 (СК-42)"},
    {"epsg": 28406, "name": "Pulkovo 1942 / Gauss-Krüger 6 (СК-42)"},
]


def _safe_name(name: str, fallback: str = "cloud.las") -> str:
    return _jk_safe_name(name, fallback)


# ───────────────────────────── LAS: заголовок ─────────────────────────────
def las_header(path: Path) -> Dict[str, Any]:
    """Быстрая проверка заголовка LAS/LAZ без сторонних пакетов (спецификация ASPRS LAS 1.0–1.4)."""
    with open(path, "rb") as f:
        head = f.read(375)
    if len(head) < 227 or head[:4] != b"LASF":
        raise ValueError("Это не LAS/LAZ: нет сигнатуры LASF в начале файла")
    major, minor = head[24], head[25]
    if major != 1 or minor > 4:
        raise ValueError(f"Неподдерживаемая версия LAS {major}.{minor}")
    header_size = struct.unpack_from("<H", head, 94)[0]
    offset_points = struct.unpack_from("<I", head, 96)[0]
    n_vlr = struct.unpack_from("<I", head, 100)[0]
    fmt_raw = head[104]
    rec_len = struct.unpack_from("<H", head, 105)[0]
    legacy_n = struct.unpack_from("<I", head, 107)[0]
    scale = struct.unpack_from("<3d", head, 131)
    offs = struct.unpack_from("<3d", head, 155)
    mx, mnx, my, mny, mz, mnz = struct.unpack_from("<6d", head, 179)
    n = legacy_n
    if minor >= 4 and len(head) >= 255:
        n64 = struct.unpack_from("<Q", head, 247)[0]
        n = n64 or legacy_n
    compressed = bool(fmt_raw & 0x80) or bool(fmt_raw & 0x40)
    fmt = fmt_raw & 0x3F
    size = path.stat().st_size
    if not compressed and rec_len and n and size < offset_points + n * rec_len * 0.999:
        raise ValueError("Файл обрезан: точек меньше, чем указано в заголовке (загрузка не завершена?)")
    if not all(math.isfinite(v) for v in (mx, mnx, my, mny, mz, mnz)) or mx < mnx or my < mny:
        raise ValueError("В заголовке LAS некорректный охват (min/max)")
    return {
        "version": f"{major}.{minor}", "point_format": fmt, "compressed": compressed,
        "record_length": rec_len, "points": int(n), "vlr": int(n_vlr), "header_size": header_size,
        "scale": list(scale), "offset": list(offs),
        "mins": [mnx, mny, mnz], "maxs": [mx, my, mz],
        "has_rgb": fmt in (2, 3, 5, 7, 8, 10),
        "area_bbox_ha": max(0.0, (mx - mnx) * (my - mny) / 10000.0),
    }


def relocate_las(path: Path, dx: float, dy: float, dz: float = 0.0) -> None:
    """Сдвиг всего облака правкой заголовка (смещения и охват) — точки не переписываются.
    Нужен демо-участку: синтетический участок LesoLidar ставится в центр открытой территории."""
    with open(path, "r+b") as f:
        head = bytearray(f.read(227))
        if head[:4] != b"LASF":
            raise ValueError("не LAS")
        ox, oy, oz = struct.unpack_from("<3d", head, 155)
        mx, mnx, my, mny, mz, mnz = struct.unpack_from("<6d", head, 179)
        struct.pack_into("<3d", head, 155, ox + dx, oy + dy, oz + dz)
        struct.pack_into("<6d", head, 179, mx + dx, mnx + dx, my + dy, mny + dy, mz + dz, mnz + dz)
        f.seek(0)
        f.write(head)


# ───────────────────────────── DBF без зависимостей ─────────────────────────────
def read_dbf(path: Path, encoding: Optional[str] = None):
    """Читает DBF (dBase III) → (список полей, генератор записей-словарей)."""
    cpg = path.with_suffix(".cpg")
    if not encoding:
        try:
            encoding = (cpg.read_text(encoding="ascii", errors="ignore").strip() or "utf-8")
        except OSError:
            encoding = "utf-8"
        if encoding.lower() in ("utf8", "utf-8"):
            encoding = "utf-8"
    data = path.read_bytes()
    if len(data) < 32:
        raise ValueError("DBF пуст")
    nrec = struct.unpack_from("<I", data, 4)[0]
    hlen, rlen = struct.unpack_from("<HH", data, 8)
    fields = []
    pos = 32
    while pos + 32 <= hlen and data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\x00")[0].decode("ascii", "ignore")
        ftype = chr(data[pos + 11])
        flen, fdec = data[pos + 16], data[pos + 17]
        fields.append((name, ftype, flen, fdec))
        pos += 32

    def records():
        off = hlen
        for _ in range(nrec):
            rec = data[off:off + rlen]
            off += rlen
            if len(rec) < rlen or rec[:1] == b"*":
                continue
            p = 1
            row = {}
            for name, ftype, flen, fdec in fields:
                raw = rec[p:p + flen]
                p += flen
                txt = raw.decode(encoding, "replace").strip()
                if ftype in "NFIB":
                    try:
                        row[name] = float(txt) if txt and txt not in ("*" * len(txt),) else None
                    except ValueError:
                        row[name] = None
                    if row[name] is not None and ftype == "N" and fdec == 0 and abs(row[name]) < 2 ** 53:
                        row[name] = int(row[name])
                elif ftype == "L":
                    row[name] = txt[:1] in ("Y", "y", "T", "t")
                else:
                    row[name] = txt
            yield row

    return fields, records()


# ───────────────────────────── геометрия/проекции ─────────────────────────────
def _transformer(src, dst):
    from pyproj import Transformer  # pyproj — зависимость geopandas
    return Transformer.from_crs(src, dst, always_xy=True)


def bbox_ll_from_info(info: Dict[str, Any]) -> Optional[List[float]]:
    try:
        crs = info.get("epsg") or info.get("crs")
        if not crs:
            return None
        mins, maxs = info["mins"], info["maxs"]
        t = _transformer(crs, 4326)
        xs = [mins[0], maxs[0], mins[0], maxs[0], (mins[0] + maxs[0]) / 2]
        ys = [mins[1], mins[1], maxs[1], maxs[1], (mins[1] + maxs[1]) / 2]
        lon, lat = t.transform(xs, ys)
        lon, lat = list(lon), list(lat)
        if not all(math.isfinite(v) for v in lon + lat):
            return None
        if not (-180 <= min(lon) <= 180 and -90 <= min(lat) <= 90):
            return None
        return [min(lon), min(lat), max(lon), max(lat)]
    except Exception:
        return None


def _aeqd(center):
    return f"+proj=aeqd +lat_0={center[1]:.10f} +lon_0={center[0]:.10f} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"


# ───────────────────────────── обработчик (exe / python) ─────────────────────────────
class Engine:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.exe: Optional[Path] = None
        self.python: Optional[str] = None
        self.pkg_path: Optional[Path] = None
        self.detect()

    # [v20.10] значения LESOLIDAR_EXE: сначала .env рядом с app.py (перечитывается при каждой проверке —
    # исправили .env, нажали «Проверить снова», перезапуск не нужен), затем переменная окружения
    def _env_values(self) -> List[str]:
        raw: List[str] = []
        try:
            for line in (self.base_dir / ".env").read_text(encoding="utf-8-sig", errors="replace").splitlines():
                s = line.strip()
                if s.startswith("export "):
                    s = s[7:].lstrip()
                if "=" in s and s.split("=", 1)[0].strip() == "LESOLIDAR_EXE":
                    raw.append(s.split("=", 1)[1].split(" #", 1)[0])
        except OSError:
            pass
        raw = raw[-1:]                                       # как в python-dotenv: действует последняя строка
        raw.append(os.environ.get("LESOLIDAR_EXE") or "")
        out: List[str] = []
        for v in raw:
            v = v.strip().strip('"').strip("'").strip()
            v = os.path.expandvars(os.path.expanduser(v)) if v else ""
            if v and v not in out:
                out.append(v)
        return out

    @staticmethod
    def _exe_in(p: Path) -> List[Path]:
        # папка (или «двойная» папка после распаковки ZIP) → LesoLidar.exe внутри
        return [p / "LesoLidar.exe", p / "LesoLidar" / "LesoLidar.exe"]

    def detect(self) -> None:
        self.exe, self.python, self.pkg_path = None, None, None
        self.checked: List[str] = []
        env_values = self._env_values()
        self._env_seen = list(env_values)
        self.env_value = env_values[0] if env_values else ""
        self._detect_at = time.time()
        cand: List[Path] = []
        for ev in env_values:
            p = Path(ev)
            cand += self._exe_in(p) if (p.is_dir() or not p.suffix) else [p]
        if not os.environ.get("LESOLIDAR_PYTHON"):
            roots = [self.base_dir]
            if self.base_dir.parent != self.base_dir:
                roots.append(self.base_dir.parent)          # tools\ рядом с папкой приложения
            for root in roots:
                for sub in ("tools/LesoLidar", "LesoLidar"):
                    cand += self._exe_in(root / sub)
                cand.append(root / "tools" / "LesoLidar.exe")
                try:                                         # tools\LesoLidar_v2\…, tools\LesoLidar\dist\LesoLidar\…
                    for d in sorted((root / "tools").glob("LesoLidar*")):
                        if d.is_dir():
                            cand += sorted(d.glob("*/LesoLidar.exe")) + sorted(d.glob("*/*/LesoLidar.exe"))
                except OSError:
                    pass
        seen, found = set(), []
        for c in cand:
            k = str(c).lower()
            if k in seen:
                continue
            seen.add(k)
            self.checked.append(str(c))
            try:
                if c.is_file():
                    found.append(c)
            except OSError:
                pass
        if found:                                            # лучше тот, рядом с которым есть _internal
            best = next((c for c in found if (c.parent / "_internal").is_dir()), found[0])
            self.exe = best.resolve()
            for ev in env_values:                            # какое значение LESOLIDAR_EXE сработало
                p = Path(ev)
                if best in (self._exe_in(p) if (p.is_dir() or not p.suffix) else [p]):
                    self.env_value = ev
                    break
            return
        py = os.environ.get("LESOLIDAR_PYTHON")
        if py:
            self.python = py
            if os.environ.get("LESOLIDAR_PATH"):
                self.pkg_path = Path(os.environ["LESOLIDAR_PATH"]).resolve()

    @property
    def kind(self) -> Optional[str]:
        return "exe" if self.exe else ("python" if self.python else None)

    @property
    def app_dir(self) -> Optional[Path]:
        if self.exe:
            return self.exe.parent
        if self.pkg_path:
            return self.pkg_path
        return None

    def redetect(self, min_interval: float = 3.0, force: bool = False) -> None:
        """[v20.10] Повторный поиск без перезапуска — не чаще раза в min_interval с: пока обработчик
        не найден, если файл пропал или изменилось значение LESOLIDAR_EXE (.env/окружение);
        force — кнопка «Проверить снова» у администратора."""
        if not force and time.time() - getattr(self, "_detect_at", 0) < min_interval:
            return
        if (force or not self.kind or (self.exe is not None and not self.exe.is_file())
                or self._env_values() != getattr(self, "_env_seen", None)):
            self.detect()
        else:
            self._detect_at = time.time()

    def setup_hint(self) -> Dict[str, Any]:
        """Куда положить программу — показывается только администратору."""
        d = self.base_dir / "tools" / "LesoLidar"
        return {"dir": str(d), "exe": str(d / "LesoLidar.exe"), "env_file": str(self.base_dir / ".env"),
                "env_value": getattr(self, "env_value", "") or None, "checked": list(getattr(self, "checked", []))[:12]}

    def public_problems(self) -> List[str]:
        """[v20.10] Для не-администраторов — без путей сервера."""
        if not self.kind:
            return ["ЛесоЛидар на сервере ещё не настроен — обратитесь к администратору"]
        return [p for p in self.problems() if "\\" not in p and "/" not in p]

    def problems(self) -> List[str]:
        out = []
        if not self.kind:
            ev = getattr(self, "env_value", "")
            if ev:
                out.append(f"LESOLIDAR_EXE = «{ev}» — там нет LesoLidar.exe. Укажите полный путь к LesoLidar.exe "
                           "или уберите строку из .env и положите папку программы в tools\\LesoLidar\\ рядом с app.py")
            else:
                out.append("Не найден LesoLidar.exe: скопируйте папку программы целиком (LesoLidar.exe + _internal) "
                           "в tools\\LesoLidar\\ рядом с app.py или укажите LESOLIDAR_EXE в .env — "
                           "см. README_DEPLOY_RU, раздел «ЛесоЛидар»")
        elif self.exe and not (self.exe.parent / "_internal").is_dir():
            out.append("Рядом с LesoLidar.exe нет папки _internal — скопируйте папку программы целиком")
        if self.exe and not IS_WIN:
            out.append("LesoLidar.exe — программа Windows; на этом сервере используйте LESOLIDAR_PYTHON")
        return out

    def models(self) -> List[Dict[str, Any]]:
        d = self.app_dir / "models" if self.app_dir else None
        res = []
        if d and d.is_dir():
            for p in sorted(d.glob("*.joblib")):
                res.append({"name": p.name, "size": p.stat().st_size})
        return res

    def tables(self) -> List[str]:
        d = self.app_dir / "tables" if self.app_dir else None
        return sorted(p.name for p in d.iterdir()) if d and d.is_dir() else []

    def command(self, args: List[str]) -> List[str]:
        if self.exe:
            return [str(self.exe)] + list(args)
        if self.python:
            return [self.python, "-c", "import sys;from lesolidar.cli import main;main(sys.argv[1:])"] + list(args)
        raise RuntimeError("Обработчик LesoLidar не настроен")

    def env(self) -> Dict[str, str]:
        env = child_env()
        env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 2) - 1)))
        if self.python and self.pkg_path:
            env["PYTHONPATH"] = str(self.pkg_path) + os.pathsep + env.get("PYTHONPATH", "")
        return env

    def popen_kwargs(self) -> Dict[str, Any]:
        return popen_kwargs(self.env())

    def info(self, las: Path, timeout: float = 180) -> Dict[str, Any]:
        kw = self.popen_kwargs()
        kw["stdout"], kw["stderr"] = subprocess.PIPE, subprocess.STDOUT
        r = subprocess.run(self.command(["info", "--las", str(las)]), timeout=timeout, **kw)
        text = _decode(r.stdout or b"")
        a, b = text.find("{"), text.rfind("}")
        if r.returncode != 0 or a < 0 or b < a:
            tail = "\n".join(text.strip().splitlines()[-6:])
            raise RuntimeError(f"LesoLidar info: код {r.returncode}. {tail[:600]}")
        return json.loads(text[a:b + 1])


class Store(JobStore):
    """Файлы, задания и очередь на диске (instance/lesolidar). Очередь, исполнитель, отмена и
    восстановление после перезапуска — общие (jobkit.JobStore): состояние задания — job.json,
    вывод обработчика — log.txt (его читают все процессы сервера), отмена — флаг cancel.flag."""

    SUBDIRS = ("uploads", "files", "jobs", "boundaries")
    STAGES = STAGES
    KIND = "задание"

    def __init__(self, root: Path, engine: Engine, log=None, start_runner: bool = True):
        self.engine = engine
        self.tree_cache: Dict[str, Any] = {}
        super().__init__(root, log=log, max_jobs=int(_env_float("LESOLIDAR_MAX_JOBS", 1)),
                         timeout_s=_env_float("LESOLIDAR_TIMEOUT_MIN", 360) * 60,
                         keep=int(_env_float("LESOLIDAR_KEEP_JOBS", 200)), start_runner=start_runner)

    # пути
    def fdir(self, fid: str) -> Path:
        return self.root / "files" / _check_id(fid, "файл")

    def udir(self, uid: str) -> Path:
        return self.root / "uploads" / _check_id(uid, "загрузка")

    def bdir(self, bid: str) -> Path:
        return self.root / "boundaries" / _check_id(bid, "граница")

    # файлы
    def file_meta(self, fid: str) -> Dict[str, Any]:
        m = _read_json(self.fdir(fid) / "meta.json")
        if not m:
            raise HTTPException(404, "Файл не найден")
        return m

    def save_file_meta(self, m: Dict[str, Any]) -> None:
        _atomic_json(self.fdir(m["id"]) / "meta.json", m)

    def files(self) -> List[Dict[str, Any]]:
        out = []
        for d in (self.root / "files").iterdir():
            m = _read_json(d / "meta.json") if d.is_dir() else None
            if m:
                out.append(m)
        out.sort(key=lambda m: m.get("created", 0), reverse=True)
        return out

    # обработка
    def command_for(self, j: Dict[str, Any]):
        jd = self.jdir(j["id"])
        fm = self.file_meta(j["file_id"])
        las = self.fdir(fm["id"]) / fm["stored_name"]
        if not las.is_file():
            raise RuntimeError("исходный файл LAS удалён")
        args = ["process", "--las", str(las), "--out", str(jd / "out"), "--config", str(jd / "params.json")]
        if j.get("boundary_path"):
            args += ["--boundary", j["boundary_path"]]
        if (j.get("params") or {}).get("epsg"):
            args += ["--epsg", str(int(j["params"]["epsg"]))]
        return self.engine.command(args), jd, self.engine.env()

    def parse_line(self, j: Dict[str, Any], line: str, t0: float) -> bool:
        if line.startswith("[") and not PROGRESS_RE.match(line):
            return False
        return super().parse_line(j, line, t0)

    def on_success(self, j: Dict[str, Any], rc: Optional[int]) -> bool:
        summary = _read_json(self.jdir(j["id"]) / "out" / "summary.json")
        if summary and (rc == 0 or rc is None):
            j["summary"] = summary
            return True
        return False

    def output_files(self, jid: str) -> List[Dict[str, Any]]:
        jd = self.jdir(jid)
        res = []
        for name, (label, _ct) in OUTPUT_FILES.items():
            p = (jd / name) if name in ("log.txt", "boundary.geojson") else (jd / "out" / name)
            if p.is_file():
                res.append({"name": name, "label": label, "size": p.stat().st_size})
        return res

    def prune(self) -> None:
        super().prune()
        # брошенные загрузки старше 3 суток
        for d in (self.root / "uploads").iterdir():
            m = _read_json(d / "meta.json") if d.is_dir() else None
            if m and _now() - float(m.get("updated") or m.get("created") or 0) > 3 * 86400:
                shutil.rmtree(d, ignore_errors=True)

    def after_finish(self, j: Dict[str, Any]) -> None:
        self.tree_cache.pop(j["id"], None)



# ───────────────────────────── параметры и граница ─────────────────────────────
def clean_params(raw: Dict[str, Any], engine: Engine) -> Dict[str, Any]:
    p = json.loads(json.dumps(DEFAULT_PARAMS))
    raw = raw if isinstance(raw, dict) else {}
    for key, spec in PARAM_SPEC.items():
        if key not in raw:
            continue
        v = raw[key]
        kind = spec[0]
        try:
            if kind == "int":
                if v in (None, "", 0):
                    p[key] = None if key == "epsg" else p[key]
                    continue
                v = int(v)
                if not spec[1] <= v <= spec[2]:
                    raise ValueError
                p[key] = v
            elif kind == "float":
                v = float(v)
                if not (math.isfinite(v) and spec[1] <= v <= spec[2]):
                    raise ValueError
                p[key] = v
            elif kind == "bool":
                p[key] = bool(v)
            elif kind == "str":
                p[key] = str(v)[: spec[2]]
            elif kind == "enum":
                if v not in spec[1]:
                    raise ValueError
                p[key] = v
            elif kind == "model":
                name = os.path.basename(str(v or ""))
                if not name:
                    p[key] = ""
                else:
                    models = {m["name"] for m in engine.models()}
                    if name not in models:
                        raise ValueError
                    p[key] = str(engine.app_dir / "models" / name)
            elif kind == "species":
                lst = [s for s in (v or []) if s in SPECIES and s not in ("conifer", "deciduous")]
                if not lst:
                    raise ValueError
                p[key] = lst
            elif kind == "ranks":
                ranks = {}
                for sp, r in (v or {}).items():
                    if sp in SPECIES and r not in (None, "", "auto"):
                        r = int(r)
                        if 1 <= r <= 7:
                            ranks[sp] = r
                p[key] = ranks
        except (TypeError, ValueError):
            raise HTTPException(422, f"Недопустимое значение параметра «{key}»")
    return p


def clean_meta(raw: Any) -> Dict[str, Any]:
    """Сведения мастера для интерфейса (в обработчик не передаются): режим анализа 1–3
    («Арборитм»: 1 — подсчёт стволов, 2 — + породы, 3 — + объём), возраст для бонитета, тип участка."""
    raw = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {"mode": 3, "age": None, "plot": ""}
    try:
        m = int(raw.get("mode") or 3)
        out["mode"] = m if m in (1, 2, 3) else 3
    except (TypeError, ValueError):
        pass
    try:
        a = raw.get("age")
        if a not in (None, ""):
            a = int(a)
            out["age"] = a if 5 <= a <= 300 else None
    except (TypeError, ValueError):
        pass
    plot = str(raw.get("plot") or "")
    out["plot"] = plot if plot in POLY_ROLES or plot in ("", "cloud", "scene") else ""
    return out


def _ring_area_ll(ring) -> float:
    # приблизительная площадь (м²) кольца lon/lat — только для проверки «вмещает ли граница облако»
    if len(ring) < 4:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    s = 0.0
    for a, b in zip(ring, ring[1:]):
        s += (a[0] * kx) * (b[1] * ky) - (b[0] * kx) * (a[1] * ky)
    return abs(s) / 2


POLY_ROLES = {"lesoseka": "Лесосека", "vydel": "Выдел", "nep": "НЭП (исключить)", "exclude": "Исключить"}


def compose_boundary(geojson: Dict[str, Any], bbox_ll: Optional[List[float]]) -> Optional[Dict[str, Any]]:
    """Полигоны мастера (как в «Арборитм»): у каждого свойство role — lesoseka/vydel (участок расчёта)
    или nep/exclude (НЭП, дороги, водоёмы — исключить). Итог: объединение участков минус исключения,
    обрезанное по охвату облака. Нет участков — всё облако минус исключения."""
    feats = geojson.get("features") if geojson.get("type") == "FeatureCollection" else [geojson]
    area, excl = [], []
    for f in feats or []:
        if not isinstance(f, dict):
            continue
        g = f.get("geometry", f)
        if not isinstance(g, dict) or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        role = str((f.get("properties") or {}).get("role") or "lesoseka")
        (excl if role in ("nep", "exclude") else area).append(g)
    if not area and not excl:
        raise HTTPException(422, "Граница: нет полигонов")
    try:
        from shapely.geometry import shape, box, mapping
        from shapely.ops import unary_union
    except Exception:                      # без shapely: исключения — дырами (если лежат внутри участка)
        if not area:
            if not bbox_ll:
                raise HTTPException(422, "Для зон исключения без участка нужен охват облака")
            w, s_, e, n = bbox_ll
            area = [{"type": "Polygon", "coordinates": [[[w, s_], [e, s_], [e, n], [w, n], [w, s_]]]}]
        out = []
        for g in area:
            polys = [g["coordinates"]] if g["type"] == "Polygon" else list(g["coordinates"])
            for pc in polys:
                rings = [pc[0]] + list(pc[1:])
                for x in excl:
                    xp = [x["coordinates"]] if x["type"] == "Polygon" else list(x["coordinates"])
                    rings += [q[0] for q in xp]
                out.append({"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": rings}})
        return {"type": "FeatureCollection", "features": out}
    try:
        geom = unary_union([shape(g).buffer(0) for g in area]) if area else (box(*bbox_ll) if bbox_ll else None)
        if geom is None:
            raise HTTPException(422, "Для зон исключения без участка нужен охват облака")
        if excl:
            geom = geom.difference(unary_union([shape(g).buffer(0) for g in excl]))
        if bbox_ll:
            geom = geom.intersection(box(*bbox_ll))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"Граница: некорректная геометрия ({e})")
    if geom.is_empty or geom.area <= 0:
        raise HTTPException(422, "После исключения НЭП от участка ничего не осталось или он вне облака точек")
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": mapping(geom)}]}


# Стандартная таблица сумм площадей сечений при полноте 1,0 (м²/га) по средней высоте — приближённо,
# для ориентировочной относительной полноты. Ключ — группа пород, значения — (H, G).
STAND_G = {
    "pine": [(8, 17.6), (12, 23.7), (16, 28.1), (20, 31.6), (24, 34.4), (28, 36.8), (32, 38.8)],
    "spruce": [(8, 19.6), (12, 26.2), (16, 31.6), (20, 35.7), (24, 39.0), (28, 41.7), (32, 43.8)],
    "larch": [(8, 15.5), (12, 20.8), (16, 25.0), (20, 28.4), (24, 31.2), (28, 33.6), (32, 35.6)],
    "birch": [(8, 12.6), (12, 16.9), (16, 20.4), (20, 23.3), (24, 25.7), (28, 27.6), (32, 29.0)],
    "aspen": [(8, 15.3), (12, 20.4), (16, 25.0), (20, 28.7), (24, 31.6), (28, 33.9), (32, 35.7)],
    "alder_black": [(8, 15.8), (12, 21.0), (16, 25.4), (20, 29.0), (24, 31.8), (28, 34.0), (32, 35.8)],
    "oak": [(8, 13.0), (12, 17.4), (16, 21.0), (20, 24.1), (24, 26.9), (28, 29.2), (32, 31.2)],
}
STAND_G_ALIAS = {"alder_grey": "alder_black", "hornbeam": "oak", "ash": "oak", "conifer": "pine", "deciduous": "birch"}
# Шкала бонитетов проф. М. М. Орлова (семенные насаждения): возраст → нижние границы высот классов Ia, I, II, III, IV, V.
ORLOV = [
    (10, [5, 4, 3, 2, 1, 0.5]), (20, [10, 8, 6, 5, 3, 2]), (30, [14, 12, 10, 8, 6, 4]), (40, [18, 15, 13, 11, 8, 6]),
    (50, [21, 18, 16, 13, 10, 7]), (60, [24, 21, 18, 15, 12, 9]), (70, [26, 23, 20, 17, 14, 10]),
    (80, [28, 25, 22, 19, 15, 11]), (90, [30, 27, 23, 20, 16, 12]), (100, [31, 28, 24, 21, 17, 13]),
    (110, [32, 29, 25, 22, 18, 13]), (120, [33, 30, 26, 23, 19, 14]), (140, [35, 32, 28, 24, 20, 15]),
    (160, [36, 33, 29, 25, 21, 16]),
]
ORLOV_CLASSES = ["Ia", "I", "II", "III", "IV", "V", "Va"]


def _interp(table, x):
    if x <= table[0][0]:
        return table[0][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x <= x1:
            if isinstance(y0, list):
                return [a + (b - a) * (x - x0) / (x1 - x0) for a, b in zip(y0, y1)]
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return table[-1][1]


def bonitet_orlov(h: float, age: float) -> Optional[str]:
    if not (h and age and h > 0 and 5 <= age <= 300):
        return None
    lims = _interp(ORLOV, age)
    for cls, lim in zip(ORLOV_CLASSES, lims):
        if h >= lim:
            return cls
    return ORLOV_CLASSES[-1]


def stand_metrics(trees: List[Dict[str, Any]], area_ha: float, age: Optional[float]) -> Dict[str, Any]:
    """Ориентировочные таксационные показатели: сумма площадей сечений, высота по Лорею,
    относительная полнота (по стандартной таблице), бонитет по шкале Орлова (если указан возраст)."""
    g_sp: Dict[str, float] = {}
    gh_sp: Dict[str, float] = {}
    for t in trees:
        if t["h"] < 5 or t["dbh"] <= 0:
            continue
        g = math.pi * (t["dbh"] / 200.0) ** 2
        g_sp[t["species"]] = g_sp.get(t["species"], 0.0) + g
        gh_sp[t["species"]] = gh_sp.get(t["species"], 0.0) + g * t["h"]
    if not g_sp or not area_ha or area_ha <= 0:
        return {"available": False}
    g_tot = sum(g_sp.values())
    h_lorey = sum(gh_sp.values()) / g_tot
    pol, by = 0.0, []
    for sp, g in sorted(g_sp.items(), key=lambda kv: -kv[1]):
        h = gh_sp[sp] / g
        key = sp if sp in STAND_G else STAND_G_ALIAS.get(sp, "pine")
        gn = _interp(STAND_G[key], h)
        p = (g / area_ha) / gn
        pol += p
        by.append({"species": sp, "g_ha": round(g / area_ha, 2), "h_lorey": round(h, 1), "polnota": round(p, 2)})
    main = by[0]
    out = {"available": True, "g_ha": round(g_tot / area_ha, 2), "h_lorey": round(h_lorey, 1),
           "polnota": round(pol, 2), "by_species": by, "main_species": main["species"], "age": age,
           "bonitet": bonitet_orlov(main["h_lorey"], age) if age else None,
           "note": "Ориентировочно: полнота — по стандартной таблице сумм площадей сечений, бонитет — по шкале М. М. Орлова"
                   " (высота главной породы по Лорею и указанный возраст)."}
    return out


def scene_boundary(geojson: Dict[str, Any], bbox_ll: Optional[List[float]]) -> Optional[Dict[str, Any]]:
    """Граница территории 3D-сцены → пересечение с охватом облака (иначе площадь = вся территория).
    Если территория целиком вмещает облако — граница не нужна (площадь по фактическому покрытию точками)."""
    try:
        from shapely.geometry import shape, box, mapping
    except Exception:
        return geojson
    geoms = []
    feats = geojson.get("features") if geojson.get("type") == "FeatureCollection" else [geojson]
    for f in feats or []:
        g = f.get("geometry", f) if isinstance(f, dict) else None
        if g and g.get("type") in ("Polygon", "MultiPolygon"):
            geoms.append(shape(g).buffer(0))
    if not geoms:
        raise HTTPException(422, "Граница: нет полигонов")
    from shapely.ops import unary_union
    poly = unary_union(geoms)
    if bbox_ll:
        bb = box(*bbox_ll)
        inter = poly.intersection(bb)
        if inter.is_empty:
            raise HTTPException(422, "Облако точек не попадает в выбранную территорию")
        if inter.area >= bb.area * 0.985:
            return None
        poly = inter
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": mapping(poly)}]}


# ───────────────────────────── деревья, рельеф ─────────────────────────────
def species_of(code: str) -> Dict[str, Any]:
    s = SPECIES.get(code)
    if not s:
        s = SPECIES["deciduous"] if code and "lv" in code.lower() else SPECIES["conifer"] if code else SPECIES["deciduous"]
    return {"name": s[0], "short": s[1], "group": s[2], "color": s[3], "id": s[4]}


def load_trees(store: Store, jid: str) -> List[Dict[str, Any]]:
    cached = store.tree_cache.get(jid)
    dbf = store.jdir(jid) / "out" / "trees_tops.dbf"
    if not dbf.is_file():
        raise HTTPException(404, "Нет слоя вершин деревьев (включите экспорт SHP)")
    mt = dbf.stat().st_mtime
    if cached and cached[0] == mt:
        return cached[1]
    _fields, recs = read_dbf(dbf)
    trees = []
    for r in recs:
        try:
            lon, lat = float(r.get("LON")), float(r.get("LAT"))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lon) and math.isfinite(lat)):
            continue
        trees.append({
            "id": int(r.get("TREE_ID") or len(trees) + 1), "lon": lon, "lat": lat,
            "x": r.get("X"), "y": r.get("Y"),
            "h": float(r.get("HEIGHT") or 0), "species": str(r.get("SPECIES") or ""),
            "species_ru": str(r.get("SPECIES_RU") or ""), "conf": float(r.get("CONF") or 0),
            "crown_area": float(r.get("CROWN_AREA") or 0), "crown_d": float(r.get("CROWN_DIAM") or 0),
            "dbh": float(r.get("DBH_CM") or 0), "dbh_step": r.get("DBH_STEP"), "rank": r.get("H_RANK"),
            "volume": float(r.get("VOLUME_M3") or 0), "points": int(r.get("N_POINTS") or 0),
        })
    if len(store.tree_cache) > 4:
        store.tree_cache.pop(next(iter(store.tree_cache)))
    store.tree_cache[jid] = (mt, trees)
    return trees


def tree_flag(t: Dict[str, Any]) -> str:
    """Отметка «Учёта деревьев»: ok — в запасе; young — < 5 м; nodbh — без диаметра; lowconf — порода неуверенно."""
    if t["h"] < 5:
        return "young"
    if t["dbh"] <= 0:
        return "nodbh"
    if (t["conf"] or 0) < 0.5 and t["species"] not in ("conifer", "deciduous"):
        return "lowconf"
    return "ok"


TREE_REC = struct.Struct("<ddfffffBbH")   # 40 байт: lon, lat, h, dbh, crown_d, volume, conf, species, rank, reserve


def trees_binary(trees: List[Dict[str, Any]]) -> bytes:
    buf = bytearray(TREE_REC.size * len(trees))
    off = 0
    for t in trees:
        rank = t.get("rank")
        try:
            rank = int(rank) if rank not in (None, "", "—") else -1
        except (TypeError, ValueError):
            rank = -1
        TREE_REC.pack_into(buf, off, t["lon"], t["lat"], t["h"], t["dbh"], t["crown_d"], t["volume"],
                           max(0.0, min(1.0, t["conf"])), species_of(t["species"])["id"],
                           max(-1, min(100, rank)), 0)
        off += TREE_REC.size
    return bytes(buf)


def _sample_bilinear(arr, nodata, cols, rows):
    import numpy as np
    h, w = arr.shape
    c0 = np.floor(cols).astype(int)
    r0 = np.floor(rows).astype(int)
    fc, fr = cols - c0, rows - r0
    out = np.full(cols.shape, np.nan, dtype="float64")
    ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
    if not ok.any():
        return out
    c, r, a, b = c0[ok], r0[ok], fc[ok], fr[ok]
    z00, z01, z10, z11 = arr[r, c], arr[r, c + 1], arr[r + 1, c], arr[r + 1, c + 1]
    v = (z00 * (1 - a) + z01 * a) * (1 - b) + (z10 * (1 - a) + z11 * a) * b
    if nodata is not None:
        bad = (z00 == nodata) | (z01 == nodata) | (z10 == nodata) | (z11 == nodata)
        v = np.where(bad, np.nan, v)
    out[ok] = v
    return out


def terrain_grid(out_dir: Path, center, max_nodes: int = 320) -> Dict[str, Any]:
    """dtm.tif (+ chm.tif) → регулярная сетка в координатах 3D-сцены (AEQD от центра лесхоза)."""
    import numpy as np
    import rasterio
    dtm_p = out_dir / "dtm.tif"
    if not dtm_p.is_file():
        raise HTTPException(404, "Нет dtm.tif (включите экспорт растров)")
    with rasterio.open(dtm_p) as ds:
        dtm = ds.read(1).astype("float64")
        nod = ds.nodata
        crs = ds.crs.to_wkt() if ds.crs else None
        inv = ~ds.transform
        b = ds.bounds
    if not crs:
        raise HTTPException(422, "У dtm.tif нет системы координат")
    chm = None
    chm_p = out_dir / "chm.tif"
    if chm_p.is_file():
        try:
            with rasterio.open(chm_p) as cs:
                chm = (cs.read(1).astype("float64"), cs.nodata, ~cs.transform)
        except Exception:
            chm = None
    to_aeqd = _transformer(crs, _aeqd(center))
    from_aeqd = _transformer(_aeqd(center), crs)
    ex = [b.left, b.right, b.left, b.right, (b.left + b.right) / 2, b.left, b.right, (b.left + b.right) / 2]
    ey = [b.bottom, b.bottom, b.top, b.top, b.bottom, (b.bottom + b.top) / 2, (b.bottom + b.top) / 2, b.top]
    ax, ay = to_aeqd.transform(ex, ey)
    x0, x1, y0, y1 = min(ax), max(ax), min(ay), max(ay)
    span = max(x1 - x0, y1 - y0)
    step = max(1.0, span / max(16, min(max_nodes, 600)))
    nx = int(math.floor((x1 - x0) / step)) + 1
    ny = int(math.floor((y1 - y0) / step)) + 1
    gx = x0 + np.arange(nx) * step
    gy = y0 + np.arange(ny) * step
    GX, GY = np.meshgrid(gx, gy)
    sx, sy = from_aeqd.transform(GX.ravel(), GY.ravel())
    sx, sy = np.asarray(sx), np.asarray(sy)
    cols = inv.a * sx + inv.b * sy + inv.c - 0.5
    rows = inv.d * sx + inv.e * sy + inv.f - 0.5
    z = _sample_bilinear(dtm, nod, cols, rows)
    zv = z[np.isfinite(z)]
    if not zv.size:
        raise HTTPException(422, "ЦМР пуста")
    res = {
        "nx": nx, "ny": ny, "bounds_m": [float(x0), float(y0), float(x0 + (nx - 1) * step), float(y0 + (ny - 1) * step)],
        "step_m": step, "datum_m": float(np.percentile(zv, 2)),
        "z": [None if not math.isfinite(v) else round(float(v), 2) for v in z],
        "min_m": float(zv.min()), "max_m": float(zv.max()), "source": "LesoLidar dtm.tif",
    }
    if chm is not None:
        carr, cnod, cinv = chm
        ccols = cinv.a * sx + cinv.b * sy + cinv.c - 0.5
        crows = cinv.d * sx + cinv.e * sy + cinv.f - 0.5
        ch = _sample_bilinear(carr, cnod, ccols, crows)
        res["chm"] = [None if not math.isfinite(v) else round(max(0.0, float(v)), 1) for v in ch]
    return res


# ───────────────────────────── маршруты ─────────────────────────────
def build_router(*, base_dir: str, is_admin: Callable[[Request], bool], verify_csrf: Callable[[Request], None],
                 logger=None, workdir: Optional[str] = None) -> APIRouter:
    root = Path(workdir or os.environ.get("LESOLIDAR_WORKDIR") or os.path.join(base_dir, "instance", "lesolidar"))
    root.mkdir(parents=True, exist_ok=True)
    engine = Engine(base_dir)
    store = Store(root, engine, logger)
    max_upload = int(_env_float("LESOLIDAR_MAX_UPLOAD_GB", 20) * 1024 * MB)
    max_queue = int(_env_float("LESOLIDAR_MAX_QUEUE", 12))
    r = APIRouter(prefix="/api/lesolidar", tags=["lesolidar"])
    r.store = store  # для тестов
    r.engine = engine

    def admin(request: Request) -> None:
        if not is_admin(request):
            raise HTTPException(403, "Только администратор может загружать и обрабатывать облака")

    def mutate(request: Request) -> None:
        admin(request)
        verify_csrf(request)

    def public_job(j: Dict[str, Any]) -> Dict[str, Any]:
        out = {k: v for k, v in j.items() if k not in ("boundary_path", "pid", "runner_pid", "log_pos")}
        if isinstance(out.get("params"), dict) and out["params"].get("model_path"):
            out["params"] = {**out["params"], "model_path": os.path.basename(out["params"]["model_path"])}
        out["stages"] = STAGES
        return out

    @r.get("/caps")
    def caps(request: Request, recheck: int = 0):
        adm = bool(is_admin(request))
        # [v20.10] скопировали программу / поправили .env — подхватываем без перезапуска
        engine.redetect(min_interval=1.0 if (recheck and adm) else 3.0, force=bool(recheck and adm))
        return {
            "setup": engine.setup_hint() if adm and not engine.kind else None,
            "available": bool(engine.kind) and not (engine.exe and not IS_WIN),
            "engine": engine.kind, "problems": engine.problems() if adm else engine.public_problems(), "is_admin": adm,
            "engine_path": str(engine.exe or engine.python or "") if adm else None,
            "models": engine.models(), "tables": engine.tables(),
            "max_upload_bytes": max_upload, "chunk_bytes": CHUNK,
            "species": [{"code": k, "name": v[0], "short": v[1], "group": v[2], "color": v[3], "id": v[4]}
                        for k, v in SPECIES.items()],
            "default_species": DEFAULT_SPECIES, "defaults": DEFAULT_PARAMS, "epsg_presets": EPSG_PRESETS,
            "stages": STAGES, "queue": sum(1 for j in store.jobs() if j.get("status") in ("queued", "running")),
            "demo": bool(engine.kind) and not (engine.exe and not IS_WIN), "runner": store.is_runner or None,
        }

    # ── загрузка кусками ──
    @r.post("/upload/init")
    async def upload_init(request: Request):
        mutate(request)
        body = await request.json()
        def _init():
            name = _safe_name(body.get("name"))
            size = int(body.get("size") or 0)
            if not re.search(r"\.(las|laz)$", name, re.I):
                raise HTTPException(422, "Нужен файл .las или .laz")
            if size <= 375:
                raise HTTPException(422, "Файл пуст или слишком мал")
            if size > max_upload:
                raise HTTPException(413, f"Файл больше {max_upload // (1024 * MB)} ГБ (LESOLIDAR_MAX_UPLOAD_GB)")
            free = shutil.disk_usage(root).free
            if free < size * 1.3 + 2 * 1024 * MB:
                raise HTTPException(507, f"Мало места на диске сервера: свободно {free / 1024 ** 3:.1f} ГБ")
            key = f"{name}|{size}|{body.get('last_modified') or ''}"
            for d in (root / "uploads").iterdir():  # докачка того же файла
                m = _read_json(d / "meta.json")
                if m and m.get("key") == key and (d / "data.part").exists():
                    m["received"] = (d / "data.part").stat().st_size
                    return {"upload_id": m["id"], "chunk_bytes": CHUNK, "received": m["received"], "resumed": True}
            uid = uuid.uuid4().hex[:16]
            d = root / "uploads" / uid
            d.mkdir(parents=True)
            (d / "data.part").write_bytes(b"")
            _atomic_json(d / "meta.json", {"id": uid, "key": key, "name": name, "size": size, "created": _now()})
            return {"upload_id": uid, "chunk_bytes": CHUNK, "received": 0, "resumed": False}

        return await run_in_threadpool(_init)

    @r.get("/upload/{uid}")
    def upload_state(uid: str, request: Request):
        admin(request)
        d = store.udir(uid)
        m = _read_json(d / "meta.json")
        if not m:
            raise HTTPException(404, "Загрузка не найдена")
        return {"upload_id": uid, "size": m["size"], "received": (d / "data.part").stat().st_size}

    @r.post("/upload/{uid}/chunk")
    async def upload_chunk(uid: str, request: Request, offset: int = 0):
        mutate(request)
        d = store.udir(uid)
        m = _read_json(d / "meta.json")
        if not m:
            raise HTTPException(404, "Загрузка не найдена")
        part = d / "data.part"
        have = part.stat().st_size
        if offset > have:
            raise HTTPException(409, f"Пропуск данных: сервер получил {have} байт")
        written = 0
        f = await run_in_threadpool(open, part, "r+b")
        try:
            await run_in_threadpool(f.seek, offset)
            async for chunk in request.stream():
                written += len(chunk)
                if written > CHUNK + MB or offset + written > m["size"]:
                    raise HTTPException(413, "Кусок больше допустимого")
                await run_in_threadpool(f.write, chunk)
        finally:
            await run_in_threadpool(f.close)
        if written and _now() - float(m.get("updated") or 0) > 60:
            m["updated"] = _now()
            await run_in_threadpool(_atomic_json, d / "meta.json", m)
        return {"received": max(have, offset + written)}  # повтор куска не уменьшает длину

    @r.delete("/upload/{uid}")
    def upload_abort(uid: str, request: Request):
        mutate(request)
        shutil.rmtree(store.udir(uid), ignore_errors=True)
        return {"ok": True}

    @r.post("/upload/{uid}/complete")
    def upload_complete(uid: str, request: Request):
        mutate(request)
        d = store.udir(uid)
        m = _read_json(d / "meta.json")
        if not m:
            raise HTTPException(404, "Загрузка не найдена")
        part = d / "data.part"
        got = part.stat().st_size
        if got != m["size"]:
            raise HTTPException(409, f"Получено {got} из {m['size']} байт — продолжите загрузку")
        try:
            hdr = las_header(part)
        except ValueError as e:
            raise HTTPException(422, str(e))
        fid = uuid.uuid4().hex[:16]
        fd = root / "files" / fid
        fd.mkdir(parents=True)
        stored = _safe_name(m["name"])
        os.replace(part, fd / stored)
        shutil.rmtree(d, ignore_errors=True)
        meta = {"id": fid, "name": m["name"], "stored_name": stored, "size": got, "created": _now(),
                "header": hdr, "info": None, "info_error": None}
        store.save_file_meta(meta)
        inspect_file(meta)
        return store.file_meta(fid)

    def inspect_file(meta: Dict[str, Any]) -> None:
        if not engine.kind:
            meta["info_error"] = "Обработчик LesoLidar не настроен — проверка CRS недоступна"
        else:
            try:
                info = engine.info(store.fdir(meta["id"]) / meta["stored_name"])
                meta["info"] = info
                meta["info_error"] = None
            except Exception as e:
                meta["info_error"] = str(e)[:600]
        src = meta.get("info") or {}
        if not src.get("mins") and meta.get("header"):
            src = dict(meta["header"])
        meta["bbox_ll"] = bbox_ll_from_info(src) if src.get("epsg") or src.get("crs") else None
        meta["checks"] = file_checks(meta)
        store.save_file_meta(meta)

    def file_checks(meta: Dict[str, Any]) -> List[Dict[str, Any]]:
        h = meta.get("header") or {}
        info = meta.get("info") or {}
        pts = int(info.get("points") or h.get("points") or 0)
        dens = info.get("density_bbox")
        if dens is None and h.get("area_bbox_ha"):
            dens = pts / max(1.0, h["area_bbox_ha"] * 10000)
        checks = [{"key": "format", "ok": True,
                   "text": f"Формат LAS {h.get('version', '?')}" + (", сжатие LAZ" if h.get("compressed") else "")
                   + f", формат точек {h.get('point_format', '?')}"}]
        if info.get("epsg") or info.get("crs"):
            checks.append({"key": "crs", "ok": True, "text": "Система координат: " + (f"EPSG:{info['epsg']}" if info.get("epsg") else "из файла (WKT)")})
        else:
            checks.append({"key": "crs", "ok": False, "warn": True,
                           "text": "Система координат в файле не указана — выберите EPSG на шаге «География»"})
        if dens is not None:
            if dens >= 10:
                checks.append({"key": "density", "ok": True, "text": f"Плотность {dens:.1f} точек/м² — достаточно для поиска деревьев"})
            elif dens >= 4:
                checks.append({"key": "density", "ok": True, "warn": True, "text": f"Плотность {dens:.1f} точек/м² — невысокая: часть деревьев второго яруса может быть пропущена"})
            else:
                checks.append({"key": "density", "ok": False, "text": f"Плотность {dens:.1f} точек/м² — слишком разреженные данные для подеревной таксации"})
        checks.append({"key": "points", "ok": pts > 1000, "text": f"Точек: {pts:,}".replace(",", " ")})
        if pts > DEFAULT_PARAMS["max_points_millions"] * 1e6:
            checks.append({"key": "thin", "ok": True, "warn": True,
                           "text": "Облако больше 60 млн точек: будет прорежено (параметр «Макс. точек») или увеличьте лимит"})
        checks.append({"key": "rgb", "ok": True, "warn": not (info.get("has_rgb") if info else h.get("has_rgb")),
                       "text": "Цвет RGB: есть" if (info.get("has_rgb") if info else h.get("has_rgb")) else "Цвета RGB нет (на расчёт не влияет)"})
        if meta.get("info_error"):
            checks.append({"key": "info", "ok": False, "warn": True, "text": "Проверка обработчиком: " + meta["info_error"][:200]})
        return checks

    @r.get("/files")
    def files(request: Request):
        jobs = store.jobs()
        out = []
        for m in store.files():
            mine = [j for j in jobs if j.get("file_id") == m["id"]]
            m = dict(m)
            m["jobs"] = len(mine)
            m["last_job"] = public_job(mine[0]) if mine else None
            out.append(m)
        return {"items": out}

    @r.get("/files/{fid}")
    def file_get(fid: str, request: Request):
        return store.file_meta(fid)

    @r.post("/files/{fid}/inspect")
    def file_inspect(fid: str, request: Request):
        mutate(request)
        meta = store.file_meta(fid)
        inspect_file(meta)
        return store.file_meta(fid)

    @r.delete("/files/{fid}")
    def file_delete(fid: str, request: Request):
        mutate(request)
        store.file_meta(fid)
        if any(j.get("file_id") == fid and j.get("status") in ("queued", "running") for j in store.jobs()):
            raise HTTPException(409, "Файл обрабатывается — сначала отмените задание")
        shutil.rmtree(store.fdir(fid), ignore_errors=True)
        return {"ok": True}

    # ── граница участка (KML / GeoJSON / ZIP с SHP) ──
    @r.post("/boundary")
    async def boundary_upload(request: Request, name: str = "boundary.geojson"):
        mutate(request)
        name = _safe_name(name, "boundary.geojson")
        ext = name.lower().rsplit(".", 1)[-1]
        if ext not in ("kml", "geojson", "json", "zip"):
            raise HTTPException(422, "Граница: нужен KML, GeoJSON или ZIP с SHP")
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > 25 * MB:
                raise HTTPException(413, "Файл границы больше 25 МБ")
        def _save():
            bid = uuid.uuid4().hex[:16]
            bd = root / "boundaries" / bid
            bd.mkdir(parents=True)
            path = bd / name
            if ext == "zip":
                try:
                    with zipfile.ZipFile(io.BytesIO(bytes(data))) as z:
                        shp = None
                        for info in z.infolist():
                            base = _safe_name(info.filename)
                            if not re.search(r"\.(shp|shx|dbf|prj|cpg)$", base, re.I) or info.file_size > 200 * MB:
                                continue
                            (bd / base).write_bytes(z.read(info))
                            if base.lower().endswith(".shp"):
                                shp = bd / base
                except zipfile.BadZipFile:
                    shutil.rmtree(bd, ignore_errors=True)
                    raise HTTPException(422, "Повреждённый ZIP")
                if not shp:
                    shutil.rmtree(bd, ignore_errors=True)
                    raise HTTPException(422, "В ZIP нет .shp")
                path = shp
            else:
                path.write_bytes(bytes(data))
            meta = {"id": bid, "name": name, "path": str(path), "created": _now()}
            _atomic_json(bd / "meta.json", meta)
            return {"id": bid, "name": name}

        return await run_in_threadpool(_save)

    # ── демо-участок: синтетическое облако LesoLidar (команда synth) в центре территории ──
    @r.post("/demo")
    async def demo_create(request: Request):
        mutate(request)
        if not engine.kind or (engine.exe and not IS_WIN):
            raise HTTPException(503, "; ".join(engine.problems()) or "Обработчик не настроен")
        body = await request.json()
        try:
            size = max(40.0, min(400.0, float(body.get("size") or 120)))
            density = max(8.0, min(150.0, float(body.get("density") or 40)))
            seed = int(body.get("seed") or int(_now()) % 100000)
            lon = float(body["lon"]) if body.get("lon") is not None else None
            lat = float(body["lat"]) if body.get("lat") is not None else None
            z0 = float(body["z0"]) if body.get("z0") is not None else None
        except (TypeError, ValueError):
            raise HTTPException(422, "Некорректные параметры демо-участка")
        if size * size * density > 12e6:
            raise HTTPException(422, "Слишком большой демо-участок: уменьшите размер или плотность")
        fid = uuid.uuid4().hex[:16]
        fd = root / "files" / fid
        fd.mkdir(parents=True)
        las = fd / "demo_plot.las"

        def make():
            kw = engine.popen_kwargs()
            res = subprocess.run(engine.command(["synth", "--las", str(las), "--truth", str(fd / "truth.csv"),
                                                 "--size", f"{size:g}", "--density", f"{density:g}",
                                                 "--seed", str(seed)]), cwd=str(fd), timeout=900, **kw)
            return res.returncode, _decode(res.stdout or b"")

        try:
            rc, text = await run_in_threadpool(make)
        except subprocess.TimeoutExpired:
            rc, text = -1, "превышено время"
        if rc != 0 or not las.is_file():
            shutil.rmtree(fd, ignore_errors=True)
            raise HTTPException(500, "Демо-участок не создан: " + " ".join(text.strip().splitlines()[-3:])[:400])
        placed = None
        if lon is not None and lat is not None and -180 <= lon <= 180 and -90 <= lat <= 90:
            try:
                X, Y = _transformer(4326, 32635).transform(lon, lat)
                hdr = las_header(las)
                cx = (hdr["mins"][0] + hdr["maxs"][0]) / 2
                cy = (hdr["mins"][1] + hdr["maxs"][1]) / 2
                dz = (z0 - hdr["mins"][2]) if z0 is not None and math.isfinite(z0) else 0.0
                relocate_las(las, X - cx, Y - cy, dz)
                placed = [lon, lat]
            except Exception as e:  # noqa — останется в исходной точке генератора
                placed = None
                if logger:
                    logger.warning(f"LesoLidar demo relocate: {e}")
        name = f"Демо-участок {size:.0f}×{size:.0f} м, {density:.0f} точек на м².las"
        meta = {"id": fid, "name": name, "stored_name": las.name, "size": las.stat().st_size, "created": _now(),
                "header": las_header(las), "info": None, "info_error": None, "demo": True, "placed": placed}
        store.save_file_meta(meta)
        await run_in_threadpool(inspect_file, meta)
        return store.file_meta(fid)

    # ── задания ──
    @r.post("/jobs")
    async def job_create(request: Request):
        mutate(request)
        if not engine.kind:
            raise HTTPException(503, "; ".join(engine.problems()) or "Обработчик не настроен")
        body = await request.json()
        def _create():
            active = sum(1 for x in store.jobs() if x.get("status") in ("queued", "running"))
            if active >= max_queue:
                raise HTTPException(429, f"Очередь ЛесоЛидар заполнена ({active} заданий) — дождитесь завершения текущих")
            fid = _check_id(str(body.get("file_id") or ""), "файл")
            fm = store.file_meta(fid)
            params = clean_params(body.get("params") or {}, engine)
            info = fm.get("info") or {}
            if not params.get("epsg") and not (info.get("epsg") or info.get("crs")):
                raise HTTPException(422, "В файле нет системы координат — укажите EPSG")
            jid = uuid.uuid4().hex[:16]
            jd = root / "jobs" / jid
            jd.mkdir(parents=True)
            b = body.get("boundary") or {}
            kind = b.get("kind") or "none"
            bpath = None
            label = str(b.get("label") or "")[:120]
            if kind in ("scene", "geojson", "roles") and isinstance(b.get("geojson"), dict):
                if kind == "scene":
                    gj = scene_boundary(b["geojson"], fm.get("bbox_ll"))
                elif kind == "roles":
                    gj = compose_boundary(b["geojson"], fm.get("bbox_ll"))
                else:
                    gj = b["geojson"]
                if gj:
                    bpath = jd / "boundary.geojson"
                    bpath.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")
                else:
                    label = (label + " — облако целиком внутри").strip(" —")
            elif kind == "upload":
                bm = _read_json(store.bdir(_check_id(str(b.get("id") or ""), "граница")) / "meta.json")
                if not bm:
                    raise HTTPException(404, "Файл границы не найден")
                bpath = Path(bm["path"])
                label = label or bm["name"]
            lp = dict(params)
            lp.update({"las_path": str(store.fdir(fid) / fm["stored_name"]), "out_dir": str(jd / "out"),
                       "boundary_path": str(bpath) if bpath else ""})
            (jd / "params.json").write_text(json.dumps(lp, ensure_ascii=False, indent=1), encoding="utf-8")
            versions = [j for j in store.jobs() if j.get("file_id") == fid]
            scene = body.get("scene") if isinstance(body.get("scene"), dict) else {}
            j = {
                "id": jid, "file_id": fid, "file_name": fm["name"], "name": str(body.get("name") or fm["name"])[:120],
                "created": _now(), "status": "queued", "progress": 0, "stage": "В очереди", "stage_index": -1,
                "params": params, "boundary": {"kind": kind if (bpath or kind == "none") else "none", "label": label},
                "boundary_path": str(bpath) if bpath else None, "version": len(versions) + 1,
                "polygons": [{"role": str(r.get("role") or "")[:12], "name": str(r.get("name") or "")[:80],
                              "area_ha": r.get("area_ha") if isinstance(r.get("area_ha"), (int, float)) else None}
                             for r in (b.get("polygons") or [])[:50] if isinstance(r, dict)],
                "parent": body.get("parent") if isinstance(body.get("parent"), str) and ID_RE.match(body.get("parent") or "") else None,
                "scene": {"code": str(scene.get("code") or "")[:40], "name": str(scene.get("name") or "")[:160]},
                "bbox_ll": fm.get("bbox_ll"), "author": "admin", "eta_s": None, "meta": clean_meta(body.get("meta")),
            }
            store.enqueue(j)
            return public_job(j)

        return await run_in_threadpool(_create)

    @r.get("/jobs")
    def jobs(request: Request, file_id: Optional[str] = None, code: Optional[str] = None, bbox: str = "",
             status: str = "", limit: int = 100):
        items = store.jobs()
        if file_id:
            items = [j for j in items if j.get("file_id") == file_id]
        if status:
            want = set(status.split(","))
            items = [j for j in items if j.get("status") in want]
        if bbox:
            try:
                bb = [float(v) for v in bbox.split(",")]
                if len(bb) != 4 or not all(math.isfinite(v) for v in bb):
                    raise ValueError
            except ValueError:
                raise HTTPException(422, "bbox: minLon,minLat,maxLon,maxLat")

            def hit(j):
                b = j.get("bbox_ll")
                if (j.get("scene") or {}).get("code") and (j.get("scene") or {}).get("code") == code:
                    return True
                return bool(b) and not (b[2] < bb[0] or b[0] > bb[2] or b[3] < bb[1] or b[1] > bb[3])
            items = [j for j in items if hit(j)]
        elif code:
            items = [j for j in items if (j.get("scene") or {}).get("code") == code or not (j.get("scene") or {}).get("code")]
        return {"items": [public_job(j) for j in items[: max(1, min(500, limit))]],
                "queue": sum(1 for j in store.jobs() if j.get("status") in ("queued", "running"))}

    @r.get("/jobs/{jid}")
    def job_get(jid: str, request: Request):
        j = store.job(jid)
        if j.get("status") == "done" and not j.get("files"):
            j["files"] = store.output_files(jid)
        return public_job(j)

    @r.get("/jobs/{jid}/log")
    def job_log(jid: str, request: Request, offset: int = 0):
        p = store.jdir(jid) / "log.txt"
        if not p.is_file():
            return {"text": "", "next": 0, "size": 0}
        size = p.stat().st_size
        offset = max(0, min(int(offset), size))
        if size - offset > 256 * 1024:
            offset = size - 256 * 1024
        with open(p, "rb") as f:
            f.seek(offset)
            data = f.read()
        return {"text": data.decode("utf-8", "replace"), "next": size, "size": size}

    @r.post("/jobs/{jid}/cancel")
    def job_cancel(jid: str, request: Request):
        mutate(request)
        return public_job(store.cancel(jid))

    @r.delete("/jobs/{jid}")
    def job_delete(jid: str, request: Request):
        mutate(request)
        ok = store.delete(jid)
        store.tree_cache.pop(jid, None)
        return {"ok": ok}

    def out_path(jid: str, name: str) -> Path:
        if name not in OUTPUT_FILES:
            raise HTTPException(404, "Файл не найден")
        jd = store.jdir(jid)
        p = (jd / name) if name in ("log.txt", "boundary.geojson") else (jd / "out" / name)
        if not p.is_file():
            raise HTTPException(404, "Файл не найден")
        return p

    @r.get("/jobs/{jid}/files/{name}")
    def job_file(jid: str, name: str, request: Request, inline: int = 0):
        p = out_path(jid, name)
        label, ctype = OUTPUT_FILES[name]
        j = store.job(jid)
        base = re.sub(r"\.(las|laz)$", "", j.get("file_name") or "cloud", flags=re.I)
        dl = f"{_safe_name(base)}_{name}"
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60"}
        if name == "dashboard.html":
            headers["Content-Security-Policy"] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
            if not inline:
                return FileResponse(p, media_type="application/octet-stream", filename=dl, headers=headers)
            return FileResponse(p, media_type="text/html; charset=utf-8", headers=headers)
        return FileResponse(p, media_type=ctype if name.endswith((".json", ".txt", ".geojson")) and inline else "application/octet-stream",
                            filename=None if inline else dl, headers=headers)

    @r.get("/jobs/{jid}/zip")
    def job_zip(jid: str, request: Request):
        j = store.job(jid)
        files = [f["name"] for f in store.output_files(jid)]
        if not files:
            raise HTTPException(404, "Нет результатов")
        base = _safe_name(re.sub(r"\.(las|laz)$", "", (j.get("file_name") or "cloud").replace("/", "_").replace("\\", "_"), flags=re.I))
        zp = store.jdir(jid) / ".results.zip"
        newest = max(out_path(jid, n).stat().st_mtime for n in files)
        if not zp.is_file() or zp.stat().st_mtime < newest:
            tmp = zp.with_name(f".results.{os.getpid()}.{threading.get_ident()}.tmp")
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
                for n in files:
                    ct = zipfile.ZIP_STORED if n.endswith((".laz", ".tif", ".xlsx")) else zipfile.ZIP_DEFLATED
                    z.write(out_path(jid, n), arcname=f"{base}_lesolidar/{n}", compress_type=ct)
            os.replace(tmp, zp)
        return FileResponse(zp, media_type="application/zip", filename=f"{base}_lesolidar_v{j.get('version', 1)}.zip")

    @r.get("/jobs/{jid}/trees.bin")
    def job_trees_bin(jid: str, request: Request):
        trees = load_trees(store, jid)
        cache = store.jdir(jid) / "out" / ".trees_v19.bin"
        dbf = store.jdir(jid) / "out" / "trees_tops.dbf"
        if not cache.is_file() or cache.stat().st_mtime < dbf.stat().st_mtime:
            cache.write_bytes(trees_binary(trees))
        return FileResponse(cache, media_type="application/octet-stream",
                            headers={"X-Trees": str(len(trees)), "X-Record-Bytes": str(TREE_REC.size),
                                     "Cache-Control": "private, max-age=300"})

    @r.get("/jobs/{jid}/trees")
    def job_trees(jid: str, request: Request, offset: int = 0, limit: int = 100, species: str = "",
                  sort: str = "id", desc: int = 0, hmin: float = 0, hmax: float = 1000, flag: str = ""):
        trees = load_trees(store, jid)
        rows = [t for t in trees if (not species or t["species"] == species) and hmin <= t["h"] <= hmax
                and (not flag or tree_flag(t) == flag)]
        key = sort if sort in ("id", "h", "dbh", "crown_d", "volume", "conf", "species") else "id"
        rows.sort(key=lambda t: (t[key] if t[key] is not None else 0), reverse=bool(desc))
        limit = max(1, min(1000, int(limit)))
        page = rows[max(0, int(offset)): max(0, int(offset)) + limit]
        items = []
        for t in page:
            row = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in t.items() if k not in ("x", "y")}
            row["lon"], row["lat"] = round(t["lon"], 7), round(t["lat"], 7)
            row["species_name"] = species_of(t["species"])["name"]
            row["flag"] = tree_flag(t)
            items.append(row)
        return {"total": len(rows), "all": len(trees), "offset": offset, "items": items}

    @r.get("/jobs/{jid}/stats")
    def job_stats(jid: str, request: Request):
        """Распределения для диаграмм: ступени толщины, высоты, породы (по всем деревьям)."""
        trees = load_trees(store, jid)
        by_sp: Dict[str, Dict[str, Any]] = {}
        dcls: Dict[int, Dict[str, int]] = {}
        hcls: Dict[int, int] = {}
        tiers = {"I": 0, "II": 0, "III": 0, "подрост": 0}
        hmax = max((t["h"] for t in trees), default=0)
        for t in trees:
            s = by_sp.setdefault(t["species"], {"species": t["species"], "trees": 0, "volume": 0.0, "h": 0.0, "d": 0.0})
            s["trees"] += 1
            s["volume"] += t["volume"]
            s["h"] += t["h"]
            s["d"] += t["dbh"]
            step = 4
            d = int(round(t["dbh"] / step) * step)
            dcls.setdefault(d, {})
            dcls[d][t["species"]] = dcls[d].get(t["species"], 0) + 1
            hb = int(t["h"] // 2 * 2)
            hcls[hb] = hcls.get(hb, 0) + 1
            if t["h"] < 5:
                tiers["подрост"] += 1
            elif hmax and t["h"] >= hmax * 0.75:
                tiers["I"] += 1
            elif hmax and t["h"] >= hmax * 0.5:
                tiers["II"] += 1
            else:
                tiers["III"] += 1
        for s in by_sp.values():
            n = max(1, s["trees"])
            s["h_mean"] = round(s.pop("h") / n, 2)
            s["d_mean"] = round(s.pop("d") / n, 2)
            s["volume"] = round(s["volume"], 3)
            s.update({k: v for k, v in species_of(s["species"]).items() if k in ("name", "short", "color", "group")})
        j = store.job(jid)
        summ = j.get("summary") or {}
        meta = j.get("meta") or {}
        params = j.get("params") or {}
        # «Учёт деревьев» (как в «Арборитм»): что вошло в отчёт и почему часть деревьев отмечена
        acc = {"ok": [0, 0.0], "young": [0, 0.0], "lowconf": [0, 0.0], "nodbh": [0, 0.0]}
        for t in trees:
            k = tree_flag(t)
            acc[k][0] += 1
            acc[k][1] += t["volume"]
        labels = {
            "ok": "Вошли в расчёт запаса",
            "young": "Подрост и молодняк (< 5 м) — учтены отдельно, в запас не входят",
            "lowconf": "Порода определена неуверенно (достоверность < 0,5) — в запасе, проверить",
            "nodbh": "Диаметр не определён — объём не рассчитан",
        }
        accounting = [{"key": k, "label": labels[k], "trees": v[0], "volume": round(v[1], 2)} for k, v in acc.items()]
        accounting.append({"key": "filtered", "label": f"Отсеяны до учёта: вершины ниже {params.get('min_tree_height', 4):g} м и кроны меньше "
                           f"{params.get('min_crown_area', 0.5):g} м² (параметры поиска)", "trees": None, "volume": None})
        stand = stand_metrics(trees, float(summ.get("area_ha") or 0), meta.get("age"))
        return {"species": sorted(by_sp.values(), key=lambda s: -s["volume"]),
                "dbh_classes": [{"d": d, "by_species": v, "total": sum(v.values())} for d, v in sorted(dcls.items())],
                "height_classes": [{"h": h, "trees": n} for h, n in sorted(hcls.items())],
                "tiers": tiers, "trees": len(trees), "h_max": hmax, "accounting": accounting, "stand": stand,
                "mode": meta.get("mode", 3)}

    @r.get("/jobs/{jid}/terrain")
    def job_terrain(jid: str, request: Request, lon: float, lat: float, max_nodes: int = 320):
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise HTTPException(422, "Некорректный центр")
        out = store.jdir(jid) / "out"
        dtm = out / "dtm.tif"
        key = hashlib.md5(f"{lon:.7f}_{lat:.7f}_{int(max_nodes)}".encode()).hexdigest()[:12]
        cache = out / f".terrain_{key}.json"
        if dtm.is_file() and cache.is_file() and cache.stat().st_mtime >= dtm.stat().st_mtime:
            return Response(cache.read_bytes(), media_type="application/json")
        try:
            data = terrain_grid(out, (lon, lat), max(32, min(600, int(max_nodes))))
        except HTTPException:
            raise
        except ImportError as e:
            raise HTTPException(503, f"Для рельефа LesoLidar на сервере нужен пакет: {e.name}")
        raw = json.dumps(data, separators=(",", ":")).encode("utf-8")
        try:
            cache.write_bytes(raw)
        except OSError:
            pass
        return Response(raw, media_type="application/json")

    return r
