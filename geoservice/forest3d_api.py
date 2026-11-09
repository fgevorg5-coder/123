# -*- coding: utf-8 -*-
"""
forest3d_api.py — данные для режима «ВИД 2D/3D» (3D-модель местности лесхоза).

Источник: SHP лесхозов. Порядок поиска:
  1) переменная окружения FOREST3D_SHP — путь к .shp;
  2) папка shp_leshoz3d/ рядом с app.py (первый *.shp), затем shp_leshoz/ (если есть .prj);
  3) данные геосервиса (load_leshoz_data из app.py — уже в WGS-84).
Система координат берётся из .prj (СК-63, СК-42, UTM, WGS-84 …); для датума
Пулково-1942 подставляются те же параметры towgs84, что и на геосервисе.
Всё приводится к WGS-84 (EPSG:4326). Площадь и периметр — геодезические,
на эллипсоиде WGS-84 (pyproj.Geod), поэтому у каждого лесхоза своя реальная площадь.
Для 3D-модели контур переводится в метры в локальной азимутальной
равнопромежуточной проекции (AEQD, WGS-84) с центром в центре лесхоза —
1 единица сцены = 1 метр, размеры на местности сохраняются.

Маршруты (все GET, только чтение):
  /api/forest3d/list               — список лесхозов: код, название, площадь, центр
  /api/forest3d/at?lon=..&lat=..   — какой лесхоз в точке (WGS-84)
  /api/forest3d/item/{code}        — контур (метры + WGS-84 bbox), площадь, периметр
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import threading

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

_TOWGS84_PULKOVO = "23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12"   # как в app.py (SK42_PRECISE_GOST)
_SIMPLIFY_M = float(os.getenv("FOREST3D_SIMPLIFY_M", "12"))     # упрощение контура для 3D, м


def _decode_dbf_text(value, preferred="utf-8"):
    """Some supplied DBFs mix cp1251 and UTF-8 records despite a UTF-8 CPG.
    Read as latin1 losslessly, then decode each individual text field strictly.
    """
    if not isinstance(value, str):
        return value
    raw = value.encode("latin1")
    for enc in dict.fromkeys([preferred, "utf-8", "cp1251"]):
        try:
            return raw.decode(enc)
        except (UnicodeError, LookupError):
            continue
    raise ValueError("Неизвестная кодировка текстового поля DBF")


def boundary_crs(prj_text):
    """Shared by 2D and 3D: honour the PRJ and identical Pulkovo datum transform."""
    from pyproj import CRS
    crs = CRS.from_user_input(prj_text)
    if crs.is_geographic and "WGS" in (crs.datum.name if crs.datum else "").upper():
        return crs
    try:
        p4 = crs.to_proj4()
    except Exception:
        return crs
    dn = (crs.datum.name if crs.datum else "").lower()
    if ("pulkovo" in dn or "+ellps=krass" in p4) and "+towgs84" not in p4:
        return CRS.from_proj4(p4.replace("+no_defs", "").strip()+f" +towgs84={_TOWGS84_PULKOVO} +no_defs")
    return crs


def build_router(*, base_dir: str, names: dict | None = None, gdf_loader=None, logger=None,
                 shp_dirs: list | None = None, preferred_shp: str | None = None) -> APIRouter:
    router = APIRouter()
    state = {"items": None, "list": None, "err": None, "bodies": {}}
    lock = threading.Lock()
    names = {str(k): v for k, v in (names or {}).items()}

    def _log(msg):
        if logger:
            logger.info(msg)

    # ── чтение SHP ────────────────────────────────────────────────────────
    def _find_shp():
        if preferred_shp and os.path.isfile(preferred_shp):
            return preferred_shp
        p = os.getenv("FOREST3D_SHP")
        if p and os.path.isfile(p):
            return p
        for d in (shp_dirs or [os.path.join(base_dir, "shp_leshoz3d")]):
            for c in sorted(glob.glob(os.path.join(d, "*.shp"))):
                # из чужих папок берём только SHP с .prj (иначе СК неизвестна → fallback геосервиса)
                if d.rstrip("/\\").endswith("shp_leshoz3d") or os.path.isfile(os.path.splitext(c)[0] + ".prj"):
                    return c
        return None

    def _crs_from_prj(prj_text):
        return boundary_crs(prj_text)

    def _guess_crs(minx, miny):
        """Без .prj: та же логика, что в process_forestry_gdf (СК-42, зона по первой цифре X)."""
        from pyproj import CRS
        if abs(minx) <= 1000 and abs(miny) <= 1000:
            return CRS.from_epsg(4326)
        zone = int(str(int(abs(minx)))[0]) if minx else 5
        zone = zone if zone in (5, 6) else 5
        return CRS.from_proj4(f"+proj=tmerc +lat_0=0 +lon_0={zone * 6 - 3} +k=1 +x_0={zone}500000 +y_0=0 "
                              f"+ellps=krass +towgs84={_TOWGS84_PULKOVO} +units=m +no_defs")

    def _read_records(shp_path):
        """→ list[(code, name, shapely_geom_wgs84, shp_area)]"""
        from shapely.geometry import shape as _shape
        from shapely.ops import transform as _tr
        from pyproj import Transformer, CRS
        recs = []
        prj = os.path.splitext(shp_path)[0] + ".prj"
        try:
            import shapefile  # pyshp
            enc = "utf-8"
            cpg = os.path.splitext(shp_path)[0] + ".cpg"
            if os.path.isfile(cpg):
                enc = (open(cpg, encoding="ascii", errors="ignore").read().strip() or "utf-8")
            rd = shapefile.Reader(shp_path, encoding="latin1", encodingErrors="strict")
            fields = [f[0].lower() for f in rd.fields[1:]]
            rows = [(dict(zip(fields, [_decode_dbf_text(v, enc) for v in sr.record])),
                     _shape(sr.shape.__geo_interface__)) for sr in rd.iterShapeRecords()]
            bb = rd.bbox
        except ImportError:
            import geopandas as gpd
            g = gpd.read_file(shp_path)
            g.columns = [c.lower() for c in g.columns]
            rows = [({k: v for k, v in r.items() if k != "geometry"}, r["geometry"]) for _, r in g.iterrows()]
            bb = g.total_bounds
        crs = _crs_from_prj(open(prj, encoding="utf-8", errors="ignore").read()) if os.path.isfile(prj) \
            else _guess_crs(bb[0], bb[1])
        to_wgs = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True).transform
        for props, geom in rows:
            if geom is None or geom.is_empty:
                continue
            code = next((props[k] for k in ("leshozkod", "code", "kod", "kod_les", "l_code") if k in props), None)
            if code is None:
                continue
            code = str(code).strip()
            if code.endswith(".0"):
                code = code[:-2]
            name = next((props[k] for k in ("name", "naim", "leshoz", "name_lx", "l_name", "name_rus") if props.get(k)), None)
            shp_area = props.get("shape_area")
            recs.append((code, name, _tr(to_wgs, geom).buffer(0), shp_area))
        _log(f"[forest3d] {os.path.basename(shp_path)}: {len(recs)} объектов, CRS: {crs.name}")
        return recs

    def _read_forestries():
        """Read the supplied forestry SHP, respecting CRS and actual DBF encoding."""
        import shapefile
        from shapely.geometry import shape
        from shapely.ops import transform
        from pyproj import Transformer
        path = os.getenv("FOREST3D_FORESTRY_SHP")
        if path and not os.path.isfile(path):
            raise RuntimeError("FOREST3D_FORESTRY_SHP: файл не найден")
        if not path:
            files = sorted(glob.glob(os.path.join(base_dir, "gran_lesnich", "*.shp")))
            path = files[0] if files else None
        if not path:
            return []
        enc_path = os.path.splitext(path)[0] + ".cpg"
        enc = open(enc_path, encoding="ascii").read().strip() if os.path.isfile(enc_path) else "utf-8"
        with shapefile.Reader(path, encoding="latin1", encodingErrors="strict") as rd:
            fields = [f[0].lower() for f in rd.fields[1:]]
            rows = [(dict(zip(fields, [_decode_dbf_text(v, enc) for v in sr.record])),
                     shape(sr.shape.__geo_interface__)) for sr in rd.iterShapeRecords()]
        prj = os.path.splitext(path)[0] + ".prj"
        if not os.path.isfile(prj):
            raise RuntimeError("Для лесничеств нужен .prj с системой координат")
        crs = _crs_from_prj(open(prj, encoding="utf-8").read())
        fwd = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
        result = []
        for i, (props, geom) in enumerate(rows):
            if geom.is_empty:
                continue
            parent = props.get("codeleshoz") or props.get("code") or props.get("leshozkod")
            parent = str(parent or "").strip().removesuffix(".0")
            num = str(props.get("num_ln") or props.get("codelvo") or i + 1).removesuffix(".0")
            name = props.get("name_ln") or props.get("namelvo") or f"Лесничество {num}"
            result.append((parent, num, str(name).strip(), transform(fwd, geom).buffer(0)))
        _log(f"[forest3d] лесничества: {len(result)}, кодировка по полям (UTF-8 / cp1251)")
        return result

    def _records_from_app():
        if not gdf_loader:
            raise RuntimeError("Нет SHP для 3D (положите файлы в shp_leshoz3d/)")
        gdf, err = gdf_loader()
        if err or gdf is None:
            raise RuntimeError(err or "Нет данных лесхозов")
        out = []
        for _, r in gdf.iterrows():
            out.append((str(r.get("code")), r.get("final_name"), r.geometry, None))
        return out

    # ── подготовка ────────────────────────────────────────────────────────
    def _prepare():
        from pyproj import Geod, Transformer
        from shapely.ops import transform as _tr, unary_union
        from shapely.geometry import mapping
        shp = _find_shp()
        recs = _read_records(shp) if shp else _records_from_app()
        by_code = {}
        for code, name, geom, shp_area in recs:
            e = by_code.setdefault(code, {"geoms": [], "name": None, "shp_area": 0.0})
            e["geoms"].append(geom)
            e["name"] = e["name"] or name
            if shp_area:
                try:
                    e["shp_area"] += float(shp_area)
                except Exception:
                    pass
        geod = Geod(ellps="WGS84")
        items = {}
        for code, e in by_code.items():
            g = unary_union(e["geoms"]) if len(e["geoms"]) > 1 else e["geoms"][0]
            if g.is_empty:
                continue
            area, perim = geod.geometry_area_perimeter(g)
            area, perim = abs(area), abs(perim)
            c = g.representative_point() if not g.centroid.within(g) else g.centroid
            lon0, lat0 = g.centroid.x, g.centroid.y
            fwd = Transformer.from_proj("EPSG:4326",
                                        f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +datum=WGS84 +units=m +no_defs",
                                        always_xy=True).transform
            gm = _tr(fwd, g).simplify(_SIMPLIFY_M, preserve_topology=True)
            polys = [gm] if gm.geom_type == "Polygon" else [p for p in getattr(gm, "geoms", []) if p.geom_type == "Polygon"]

            def ring(rr):
                return [[round(x, 1), round(y, 1)] for x, y in rr.coords]
            local = [[ring(p.exterior)] + [ring(h) for h in p.interiors] for p in polys if p.area > 1]
            mnx, mny, mxx, mxy = gm.bounds
            items[code] = {
                "code": code,
                "name": names.get(code) or e["name"] or f"Лесхоз {code}",
                "crs": "WGS-84 (EPSG:4326)",
                "center": [round(lon0, 6), round(lat0, 6)],
                "label_point": [round(c.x, 6), round(c.y, 6)],
                "bbox_wgs84": [round(v, 6) for v in g.bounds],
                "area_m2": round(area, 1),
                "area_ha": round(area / 1e4, 1),
                "area_km2": round(area / 1e6, 2),
                "perimeter_km": round(perim / 1000, 2),
                "shp_area_m2": round(e["shp_area"], 1) if e["shp_area"] else None,
                "size_m": [round(mxx - mnx, 1), round(mxy - mny, 1)],
                "bounds_m": [round(mnx, 1), round(mny, 1), round(mxx, 1), round(mxy, 1)],
                "local_proj": f"AEQD WGS-84, центр {lat0:.5f}° с.ш., {lon0:.5f}° в.д.",
                "polygons_m": local,
                "_geom": g,
            }
        # Forestry polygons in parent AEQD for internal lines, and independent AEQD scenes.
        forest_items = dict(items)
        # Render-only shells use the exact coordinates sent to the client.
        # Actual _geom stays unchanged for point/LAS territory classification.
        from shapely.geometry import Polygon
        display_shells = {code: unary_union([Polygon(p[0],p[1:]).buffer(0) for p in it['polygons_m']]).buffer(0)
                          for code,it in forest_items.items()}
        display_parts = {code: [] for code in forest_items}
        def render_polygons(geom):
            ps = [geom] if geom.geom_type == 'Polygon' else [p for p in getattr(geom,'geoms',[]) if p.geom_type == 'Polygon']
            return [[[[round(x,6),round(y,6)] for x,y in p.exterior.coords]] + [[[round(x,6),round(y,6)] for x,y in h.coords] for h in p.interiors] for p in ps if p.area > 1]

        for it in forest_items.values():
            it["kind"] = "forest"
            it["forestries"] = []
        for code,it in forest_items.items():
            it['polygons_m'] = render_polygons(display_shells[code])
        grouped = {}
        for parent, num, name, geom in _read_forestries():
            # Old forestry codes (e.g. 15050102) encode short forest code 102.
            compact = str(int(parent[-4:])) if len(parent) >= 8 and parent.isdigit() else parent
            if parent not in forest_items and compact in forest_items and geom.intersects(forest_items[compact]["_geom"]):
                parent = compact
            if parent not in forest_items:
                gb = geom.bounds
                candidates = [(geom.intersection(it["_geom"]).area, code)
                              for code, it in forest_items.items()
                              if not (it["_geom"].bounds[0] > gb[2] or it["_geom"].bounds[2] < gb[0]
                                      or it["_geom"].bounds[1] > gb[3] or it["_geom"].bounds[3] < gb[1])
                              and geom.intersects(it["_geom"])]
                if not candidates or max(candidates)[0] <= 0:
                    continue
                parent = max(candidates)[1]
            key = (parent, num, name)
            grouped.setdefault(key, []).append(geom)
        for (parent, num, name), geoms in grouped.items():
            pg = forest_items[parent]["_geom"]
            raw = unary_union(geoms)
            g = raw if pg.covers(raw) else raw.intersection(pg).buffer(0)
            if g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            code = "ln-" + parent + "-" + num + "-" + hashlib.sha1(name.encode()).hexdigest()[:6]
            lon0, lat0 = g.centroid.x, g.centroid.y
            def project(center):
                return Transformer.from_proj("EPSG:4326",
                    f"+proj=aeqd +lat_0={center[1]} +lon_0={center[0]} +datum=WGS84 +units=m +no_defs",
                    always_xy=True).transform
            def polygons(center):
                gm = _tr(project(center), g).simplify(_SIMPLIFY_M, preserve_topology=True)
                ps = [gm] if gm.geom_type == "Polygon" else list(gm.geoms)
                return gm, [[ring(p.exterior)] + [ring(h) for h in p.interiors] for p in ps]
            gm, local = polygons((lon0, lat0))
            # Do not simplify each adjacent polygon independently: this creates cracks.
            # Intersect in the common parent projection with its DISPLAY shell.
            parent_geom = _tr(project((pg.centroid.x, pg.centroid.y)), g)
            parent_geom = parent_geom.buffer(0).intersection(display_shells[parent]).buffer(0)
            display_parts[parent].append(parent_geom)
            parent_local = render_polygons(parent_geom)
            area, perim = geod.geometry_area_perimeter(g)
            mnx, mny, mxx, mxy = gm.bounds
            c = g.representative_point()
            items[code] = dict(code=code, name=name, kind="forestry", parent_code=parent,
                parent_name=forest_items[parent]["name"], number=num, crs="WGS-84 (EPSG:4326)",
                center=[lon0, lat0], label_point=[c.x, c.y], bbox_wgs84=list(g.bounds),
                area_m2=round(abs(area), 1), area_ha=round(abs(area)/1e4, 1), area_km2=round(abs(area)/1e6, 2),
                perimeter_km=round(abs(perim)/1000, 2), size_m=[mxx-mnx, mxy-mny],
                bounds_m=[mnx,mny,mxx,mxy], polygons_m=local, _geom=g,
                local_proj=f"AEQD WGS-84, центр {lat0:.5f}, {lon0:.5f}")
            forest_items[parent]["forestries"].append(dict(code=code,name=name,number=num,
                area_ha=items[code]["area_ha"],polygons_m=parent_local))
        for parent,it in forest_items.items():
            it['forestries'].sort(key=lambda x:x['name'])
            covered = unary_union(display_parts[parent])
            missing = display_shells[parent].difference(covered).buffer(0)
            it['forestry_uncovered_area_ha'] = round(missing.area/1e4,2)
            it['forestry_uncovered_percent'] = round(100*missing.area/max(display_shells[parent].area,1),3)
            it['forestry_uncovered_polygons_m'] = render_polygons(missing)
            # Only a few major uncovered parts get a label; never invented forestry names.
            parts = [missing] if missing.geom_type == 'Polygon' else list(getattr(missing,'geoms',[]))
            major = sorted((p for p in parts if p.geom_type == 'Polygon' and p.area>=10000),key=lambda p:p.area,reverse=True)[:5]
            it['forestry_unknown_labels'] = [dict(name='н/инф',polygons_m=render_polygons(p)) for p in major]
        for it in items.values():
            if it.get("kind") == "forestry":
                it["siblings"] = [{k:v for k,v in ln.items() if k != "polygons_m"}
                                  for ln in forest_items[it["parent_code"]]["forestries"]]
        areas = sorted((it["area_m2"] for it in forest_items.values()), reverse=True)
        for it in forest_items.values():
            it["rank"] = areas.index(it["area_m2"]) + 1
            it["count"] = len(areas)
            it["mean_area_km2"] = round(sum(areas) / len(areas) / 1e6, 2) if areas else None
        lst = sorted(({k: v for k, v in it.items() if k not in ("polygons_m", "_geom", "bounds_m", "forestries", "siblings", "forestry_uncovered_polygons_m", "forestry_unknown_labels")}
                      for it in items.values()), key=lambda d: d["name"])
        return items, lst

    def _ensure():
        if state["items"] is not None:
            return
        with lock:
            if state["items"] is not None:
                return
            items, lst = _prepare()
            state["items"], state["list"] = items, lst
            _log(f"[forest3d] готово: {len(items)} лесхозов")

    def _json_resp(request, key, obj, max_age=3600):
        body = state["bodies"].get(key)
        if body is None:
            body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            state["bodies"][key] = body
        etag = '"' + hashlib.md5(body).hexdigest()[:20] + '"'
        hdrs = {"Cache-Control": "no-store", "ETag": etag}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=hdrs)
        return Response(body, media_type="application/json", headers=hdrs)

    async def _ready():
        from starlette.concurrency import run_in_threadpool
        try:
            await run_in_threadpool(_ensure)
        except Exception as e:
            if logger:
                logger.error(f"[forest3d] ошибка подготовки: {e}")
            raise HTTPException(503, "Данные лесхозов для 3D недоступны")

    @router.get("/api/forest3d/list")
    async def forest3d_list(request: Request, kind: str = Query("forest"), parent: str = Query("")):
        await _ready()
        if kind not in ("forest", "forestry"):
            raise HTTPException(400, "kind: forest или forestry")
        rows = [it for it in state["list"] if it.get("kind") == kind
                and (not parent or it.get("parent_code") == parent)]
        return _json_resp(request, "list:" + kind + ":" + parent, {"items": rows})

    @router.get("/api/forest3d/at")
    async def forest3d_at(lon: float = Query(..., ge=-180, le=180), lat: float = Query(..., ge=-90, le=90)):
        await _ready()
        from shapely.geometry import Point
        pt = Point(lon, lat)
        for it in state["items"].values():
            if it.get("kind") == "forestry":
                continue
            b = it["bbox_wgs84"]
            if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and it["_geom"].covers(pt):
                return {"found": True, "code": it["code"], "name": it["name"]}
        return {"found": False}

    @router.get("/api/forest3d/item/{code}")
    async def forest3d_item(request: Request, code: str):
        await _ready()
        it = state["items"].get(str(code).strip())
        if not it:
            raise HTTPException(404, "Лесхоз не найден")
        return _json_resp(request, "item:" + it["code"], {k: v for k, v in it.items() if k != "_geom"})

    def items():
        """Для других модулей (облака LAS): подготовленные лесхозы (с _geom), синхронно."""
        _ensure()
        return state["items"]

    router.forest3d_items = items
    return router
