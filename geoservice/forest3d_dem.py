# -*- coding: utf-8 -*-
"""
forest3d_dem.py — рельеф (ЦМР) для 3D-режима через собственный сервер (v19).

Почему так: страница геосервиса запрещает браузеру ходить за данными на чужие сайты
(Content-Security-Policy connect-src 'self'), поэтому прямой запрос тайлов высот AWS
заканчивался ошибкой «ЦМР не загружена… Failed to fetch». Теперь 3D-режим берёт тайлы
только у своего сервера: GET /api/forest3d/dem/{z}/{x}/{y}.png, а сервер по порядку:

  1) FOREST3D_DEM_DIR      — локальный каталог готовых тайлов Terrarium {z}/{x}/{y}.png (офлайн);
  2) FOREST3D_DEM_GEOTIFF  — свои GeoTIFF высот через «;» (лидарная ЦМР, SRTM, Copernicus GLO-30,
                             любая СК; нужен rasterio): тайл строится на лету и кэшируется;
  3) FOREST3D_DEM_UPSTREAMS — внешние источники через «;» (по умолчанию AWS Terrain Tiles —
                             открытые данные SRTM/GMTED/ETOPO1): «terrarium:URL» или «mapbox:URL»
                             (Mapbox Terrain-RGB пересчитывается в Terrarium); FOREST3D_DEM_OFFLINE=1 — не ходить в сеть.
Скачанные и построенные тайлы лежат в FOREST3D_DEM_CACHE (instance/dem_cache) и больше не скачиваются.
Ответ всегда Terrarium PNG 256×256: высота = R·256 + G + B/256 − 32768 (м).
Прокси для выхода в интернет — стандартные переменные HTTPS_PROXY / HTTP_PROXY.
"""
from __future__ import annotations

import hashlib
import io
import math
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

WORLD_HALF = math.pi * 6378137.0
DEFAULT_UPSTREAM = "terrarium:https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = "DZZ-geoservice/19 forest3d-dem (+server-side cache)"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    span = 2 * WORLD_HALF / (1 << z)
    x0 = -WORLD_HALF + x * span
    y1 = WORLD_HALF - y * span
    return x0, y1 - span, x0 + span, y1


def encode_terrarium(h) -> bytes:
    """float32-массив высот (NaN допускается) → Terrarium PNG."""
    import numpy as np
    from PIL import Image
    a = np.asarray(h, dtype="float64")
    a = np.where(np.isfinite(a), a, 0.0)
    v = np.clip(a + 32768.0, 0, 65535.996)
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    rgb = np.stack([r, g, b], axis=-1).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def decode_png(data: bytes, encoding: str):
    """PNG Terrarium / Mapbox Terrain-RGB → float-массив высот 256×256 (больший тайл уменьшается по высотам)."""
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    alpha = None
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        alpha = np.asarray(im)[..., 3]
    im = im.convert("RGB")
    a = np.asarray(im).astype("float64")
    if encoding == "mapbox":
        h = -10000.0 + (a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]) * 0.1
    else:
        h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256.0 - 32768.0
    if alpha is not None:
        h = np.where(alpha > 0, h, np.nan)
    if h.shape != (256, 256):
        hi = Image.fromarray(np.nan_to_num(h, nan=0.0).astype("float32"), "F").resize((256, 256), Image.BILINEAR)
        h = np.asarray(hi).astype("float64")
    return h


class DemService:
    def __init__(self, base_dir: str, logger=None):
        self.log = logger
        self.cache = Path(_env("FOREST3D_DEM_CACHE") or os.path.join(base_dir, "instance", "dem_cache"))
        self.cache.mkdir(parents=True, exist_ok=True)
        local = _env("FOREST3D_DEM_DIR")
        self.local = Path(local) if local else None
        self.geotiffs = [p for p in (s.strip() for s in _env("FOREST3D_DEM_GEOTIFF").split(";")) if p]
        self.offline = _env("FOREST3D_DEM_OFFLINE").lower() in ("1", "true", "yes", "on")
        ups = _env("FOREST3D_DEM_UPSTREAMS", DEFAULT_UPSTREAM)
        self.upstreams: List[Dict[str, object]] = []
        for item in (s.strip() for s in ups.replace("\n", ";").split(";")):
            if not item or self.offline:
                continue
            enc, _, url = item.partition(":")
            if enc not in ("terrarium", "mapbox"):
                enc, url = "terrarium", item
            if "{z}" in url and "{x}" in url and "{y}" in url:
                key = hashlib.md5(url.split("?")[0].encode()).hexdigest()[:10]
                self.upstreams.append({"encoding": enc, "url": url, "key": key, "ok": 0, "fail": 0,
                                       "last_error": "", "last_ok": None, "down_until": 0.0})
        self.max_z = int(_env("FOREST3D_DEM_MAX_Z", "15") or 15)
        self.timeout = float(_env("FOREST3D_DEM_TIMEOUT", "10") or 10)
        self.sem = threading.BoundedSemaphore(int(_env("FOREST3D_DEM_PARALLEL", "6") or 6))
        self.inflight: Dict[str, threading.Event] = {}
        self.lock = threading.Lock()
        self.neg: Dict[str, float] = {}
        self.stats = {"served": 0, "cache_hits": 0, "fetched": 0, "rendered": 0, "missing": 0, "errors": 0}
        sig = []
        for p in self.geotiffs:
            try:
                st = os.stat(p)
                sig.append(f"{p}|{st.st_size}|{int(st.st_mtime)}")
            except OSError:
                sig.append(p + "|missing")
        self.gt_key = hashlib.md5("\n".join(sig).encode()).hexdigest()[:10] if self.geotiffs else ""

    # ── пути кэша ──
    def _cpath(self, kind: str, key: str, z: int, x: int, y: int) -> Path:
        return self.cache / f"{kind}-{key}" / str(z) / str(x) / f"{y}.png"

    @staticmethod
    def _write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        try:
            os.replace(tmp, path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass

    # ── источники ──
    def _local(self, z, x, y) -> Optional[bytes]:
        if not self.local:
            return None
        p = self.local / str(z) / str(x) / f"{y}.png"
        return p.read_bytes() if p.is_file() else None

    def _render_geotiff(self, z, x, y):
        if not self.geotiffs or z < 6:
            return None
        import numpy as np
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.transform import from_bounds
        from rasterio.warp import reproject, transform_bounds
        b = tile_bounds(z, x, y)
        dst = np.full((256, 256), np.nan, dtype="float32")
        for path in self.geotiffs:
            if not os.path.isfile(path):
                continue
            with rasterio.open(path) as ds:
                try:
                    tb = transform_bounds("EPSG:3857", ds.crs, *b, densify_pts=8)
                except Exception:
                    continue
                if tb[2] < ds.bounds.left or tb[0] > ds.bounds.right or tb[3] < ds.bounds.bottom or tb[1] > ds.bounds.top:
                    continue
                tmp = np.full((256, 256), np.nan, dtype="float32")
                reproject(source=rasterio.band(ds, 1), destination=tmp, src_transform=ds.transform, src_crs=ds.crs,
                          src_nodata=ds.nodata, dst_transform=from_bounds(*b, 256, 256), dst_crs="EPSG:3857",
                          dst_nodata=np.nan, resampling=Resampling.bilinear)
                fill = np.isnan(dst) & np.isfinite(tmp) & (tmp > -1000) & (tmp < 9000)
                dst[fill] = tmp[fill]
            if not np.isnan(dst).any():
                break
        if np.isnan(dst).all():
            return None
        return dst

    def _fetch(self, up: Dict[str, object], z, x, y) -> Optional[bytes]:
        """Сырой PNG из внешнего источника (с кэшем на диске). None — тайла там нет (404)."""
        cp = self._cpath("up", str(up["key"]), z, x, y)
        if cp.is_file():
            self.stats["cache_hits"] += 1
            return cp.read_bytes()
        if time.time() < float(up["down_until"]):
            raise RuntimeError(str(up["last_error"]) or "источник временно недоступен")
        url = str(up["url"]).replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/png,image/*"})
        with self.sem:
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = r.read(8 * 1024 * 1024 + 1)
            except urllib.error.HTTPError as e:
                if e.code in (404, 204):
                    return None
                up["fail"] = int(up["fail"]) + 1
                up["last_error"] = f"HTTP {e.code}"
                if e.code in (401, 403, 429) or e.code >= 500:
                    up["down_until"] = time.time() + min(300, 15 * int(up["fail"]))
                raise RuntimeError(f"HTTP {e.code}")
            except Exception as e:  # сеть, DNS, тайм-аут
                up["fail"] = int(up["fail"]) + 1
                up["last_error"] = str(getattr(e, "reason", e))[:200]
                up["down_until"] = time.time() + min(300, 10 * int(up["fail"]))
                raise RuntimeError(str(up["last_error"]))
        if len(data) > 8 * 1024 * 1024 or not data.startswith(b"\x89PNG"):
            up["last_error"] = "ответ не PNG"
            raise RuntimeError("ответ не PNG")
        up["ok"] = int(up["ok"]) + 1
        up["fail"] = 0
        up["last_ok"] = time.time()
        self.stats["fetched"] += 1
        self._write(cp, data)
        return data

    def _upstream_heights(self, z, x, y):
        errors = []
        for up in self.upstreams:
            try:
                raw = self._fetch(up, z, x, y)
            except Exception as e:
                errors.append(str(e))
                continue
            if raw is None:
                continue
            return decode_png(raw, str(up["encoding"])), raw if up["encoding"] == "terrarium" else None
        if errors:
            raise RuntimeError("; ".join(errors)[:300])
        return None, None

    # ── главный вход ──
    def tile(self, z: int, x: int, y: int) -> Tuple[Optional[bytes], str]:
        if not (0 <= z <= self.max_z and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
            raise HTTPException(404, "Нет такого тайла")
        key = f"{z}/{x}/{y}"
        data = self._local(z, x, y)
        if data:
            return data, "local"
        if self.neg.get(key, 0) > time.time():
            return None, "missing"
        with self.lock:
            ev = self.inflight.get(key)
            owner = ev is None
            if owner:
                ev = self.inflight[key] = threading.Event()
        if not owner:
            ev.wait(self.timeout * 2 + 5)
        try:
            return self._tile(z, x, y)
        finally:
            if owner:
                with self.lock:
                    self.inflight.pop(key, None)
                ev.set()

    def _tile(self, z, x, y) -> Tuple[Optional[bytes], str]:
        key = f"{z}/{x}/{y}"
        if self.geotiffs:
            gp = self._cpath("gt", self.gt_key, z, x, y)
            if gp.is_file():
                self.stats["cache_hits"] += 1
                return gp.read_bytes(), "geotiff"
            try:
                h = self._render_geotiff(z, x, y)
            except Exception as e:  # noqa
                h = None
                if self.log:
                    self.log.warning(f"forest3d_dem GeoTIFF {key}: {e}")
            if h is not None:
                import numpy as np
                if np.isnan(h).any():
                    try:
                        uh, _raw = self._upstream_heights(z, x, y)
                    except Exception:
                        uh = None
                    if uh is not None:
                        h = np.where(np.isnan(h), uh, h)
                    else:
                        h = np.where(np.isnan(h), float(np.nanmedian(h)), h)
                data = encode_terrarium(h)
                self._write(gp, data)
                self.stats["rendered"] += 1
                return data, "geotiff"
        if not self.upstreams:
            self.neg[key] = time.time() + 600
            return None, "missing"
        h, raw = self._upstream_heights(z, x, y)
        if h is None:
            self.neg[key] = time.time() + 6 * 3600
            self.stats["missing"] += 1
            return None, "missing"
        if raw is not None and len(raw) < 2 * 1024 * 1024:
            return raw, "upstream"
        return encode_terrarium(h), "upstream"

    def status(self) -> Dict[str, object]:
        srcs = []
        if self.local:
            srcs.append({"kind": "dir", "label": "Локальные тайлы", "ok": self.local.is_dir()})
        if self.geotiffs:
            srcs.append({"kind": "geotiff", "label": "GeoTIFF высот на сервере",
                         "files": [os.path.basename(p) for p in self.geotiffs],
                         "ok": all(os.path.isfile(p) for p in self.geotiffs)})
        for up in self.upstreams:
            host = str(up["url"]).split("/")[2] if "//" in str(up["url"]) else str(up["url"])[:40]
            srcs.append({"kind": "upstream", "label": host, "encoding": up["encoding"],
                         "ok": not up["fail"], "last_error": up["last_error"] or None,
                         "last_ok": up["last_ok"]})
        return {"url": "/api/forest3d/dem/{z}/{x}/{y}.png", "encoding": "terrarium", "max_zoom": self.max_z,
                "offline": self.offline, "sources": srcs, "stats": dict(self.stats)}


def build_router(*, base_dir: str, logger=None) -> APIRouter:
    svc = DemService(base_dir, logger)
    r = APIRouter(prefix="/api/forest3d/dem", tags=["forest3d-dem"])
    r.service = svc

    @r.get("/status")
    def dem_status():
        return svc.status()

    @r.get("/{z}/{x}/{y}.png")
    def dem_tile(z: int, x: int, y: int):
        try:
            data, src = svc.tile(z, x, y)
        except HTTPException:
            raise
        except Exception as e:
            svc.stats["errors"] += 1
            raise HTTPException(502, f"ЦМР: источник недоступен ({e})")
        if not data:
            return Response(status_code=404, headers={"Cache-Control": "private, max-age=3600", "X-DEM-Source": "none"})
        svc.stats["served"] += 1
        return Response(data, media_type="image/png",
                        headers={"Cache-Control": "private, max-age=2592000", "X-DEM-Source": src})

    return r
