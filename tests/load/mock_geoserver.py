#!/usr/bin/env python
"""Заглушка GeoServer для нагрузочных тестов (порт 9090 по умолчанию).

Пример: python tests/load/mock_geoserver.py --latency-ms 40 --fail-rate 0.02
"""
import argparse
import asyncio
import hashlib
import io
import os
import random

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from PIL import Image

CFG = {"latency_ms": 40.0, "jitter_ms": 10.0, "fail_rate": 0.0, "slow_every": 0, "slow_s": 5.0}
STATS = {"total": 0, "routes": {}, "in_flight": 0, "in_flight_max": 0, "failed": 0, "slow": 0}
_png_cache = {}
app = FastAPI(title="mock-geoserver")


def png_for(key: str) -> bytes:
    """256x256 PNG; цвет зависит от хэша имени слоя, результат кэшируется."""
    if key not in _png_cache:
        h = hashlib.md5(key.encode("utf-8")).digest()
        img = Image.new("RGBA", (256, 256), (60 + h[0] % 160, 60 + h[1] % 160, 60 + h[2] % 160, 200))
        for i in range(0, 256, 64):
            for j in range(256):
                img.putpixel((i, j), (255, 255, 255, 255))
                img.putpixel((j, i), (255, 255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        _png_cache[key] = buf.getvalue()
    return _png_cache[key]


@app.middleware("http")
async def chaos(request: Request, call_next):
    path = request.url.path
    if path == "/__stats":
        return await call_next(request)
    STATS["total"] += 1
    n = STATS["total"]
    route = "/geoserver/gwc/*" if path.startswith("/geoserver/gwc") else path
    STATS["routes"][route] = STATS["routes"].get(route, 0) + 1
    STATS["in_flight"] += 1
    STATS["in_flight_max"] = max(STATS["in_flight_max"], STATS["in_flight"])
    try:
        await asyncio.sleep((CFG["latency_ms"] + random.uniform(0, CFG["jitter_ms"])) / 1000)
        if CFG["slow_every"] and n % CFG["slow_every"] == 0:
            STATS["slow"] += 1
            await asyncio.sleep(CFG["slow_s"])
        if CFG["fail_rate"] and random.random() < CFG["fail_rate"]:
            STATS["failed"] += 1
            return Response("mock failure", status_code=503)
        return await call_next(request)
    finally:
        STATS["in_flight"] -= 1


@app.get("/__stats")
async def stats():
    return JSONResponse({**STATS, "config": CFG})


def _q(request: Request, name: str, default: str = "") -> str:
    for k, v in request.query_params.items():
        if k.lower() == name.lower():
            return v
    return default


CAPS = ('<?xml version="1.0" encoding="UTF-8"?><WMS_Capabilities version="1.1.1">'
        '<Service><Name>OGC:WMS</Name><Title>mock</Title></Service>'
        '<Capability><Layer><Title>mock</Title></Layer></Capability></WMS_Capabilities>')


async def wms_handler(request: Request):
    req = _q(request, "REQUEST", "GetMap").lower()
    if req == "getcapabilities":
        return Response(CAPS, media_type="application/xml")
    if req == "getfeatureinfo":
        return Response("[]", media_type="application/json")
    return Response(png_for(_q(request, "LAYERS")), media_type="image/png")


app.add_api_route("/geoserver/wms", wms_handler, methods=["GET", "POST"])
app.add_api_route("/geoserver/External/wms", wms_handler, methods=["GET", "POST"])
app.add_api_route("/geoserver/{ws}/wms", wms_handler, methods=["GET", "POST"])


@app.api_route("/geoserver/wfs", methods=["GET", "POST"])
async def wfs(request: Request):
    if _q(request, "REQUEST").lower() == "describefeaturetype":
        return JSONResponse({"elementFormDefault": "qualified", "targetNamespace": "mock",
                             "featureTypes": [{"typeName": "mock", "properties": [
                                 {"name": "geom", "type": "gml:Polygon"},
                                 {"name": "name", "type": "xsd:string"}]}]})
    feats = [{"type": "Feature", "id": f"mock.{i}", "properties": {"name": f"obj{i}"},
              "geometry": {"type": "Polygon", "coordinates": [[[27 + i * .1, 53], [27.1 + i * .1, 53],
                                                                [27.1 + i * .1, 53.1], [27 + i * .1, 53]]]}}
             for i in range(3)]
    return JSONResponse({"type": "FeatureCollection", "features": feats})


@app.get("/geoserver/gwc/service/tms/1.0.0/{rest:path}")
async def tms(rest: str):
    return Response(png_for(rest.split("/")[0]), media_type="image/png")


def main():
    e = os.environ.get
    p = argparse.ArgumentParser(description="Заглушка GeoServer")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=int(e("MOCK_GS_PORT", 9090)))
    p.add_argument("--latency-ms", type=float, default=float(e("MOCK_GS_LATENCY_MS", 40)))
    p.add_argument("--jitter-ms", type=float, default=float(e("MOCK_GS_JITTER_MS", 10)))
    p.add_argument("--fail-rate", type=float, default=float(e("MOCK_GS_FAIL_RATE", 0)))
    p.add_argument("--slow-every", type=int, default=int(e("MOCK_GS_SLOW_EVERY", 0)))
    a = p.parse_args()
    CFG.update(latency_ms=a.latency_ms, jitter_ms=a.jitter_ms, fail_rate=a.fail_rate, slow_every=a.slow_every)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
