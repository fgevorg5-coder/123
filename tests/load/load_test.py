#!/usr/bin/env python
"""Нагрузочный генератор для geoservice (asyncio + httpx).

Пример: python tests/load/load_test.py --users 120 --duration 60 --scenario map
"""
import argparse
import asyncio
import json
import math
import os
import random
import sys
import time
from datetime import datetime
from urllib.parse import quote

import httpx

ERROR_STATUSES = {404, 503, 504}
DEFAULT_LAYER = "External:Подложка ДЗЗ"
R = 6378137.0
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------- геометрия тайлов ----------
def deg2tile(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_bbox_3857(z, x, y):
    size = 2 * math.pi * R / (2 ** z)
    minx = -math.pi * R + x * size
    maxy = math.pi * R - y * size
    return minx, maxy - size, minx + size, maxy


# ---------- сбор метрик ----------
class Recorder:
    def __init__(self):
        self.rows = []  # (t_rel, label, status, ms, bytes, err)
        self.t0 = time.monotonic()

    def add(self, label, status, ms, nbytes, err):
        self.rows.append((time.monotonic() - self.t0, label, status, ms, nbytes, err))


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = min(len(sorted_vals) - 1, max(0, math.ceil(p / 100 * len(sorted_vals)) - 1))
    return sorted_vals[k]


def summarize(rows, elapsed):
    lat = sorted(r[3] for r in rows)
    n = len(rows)
    errs = sum(1 for r in rows if r[5])
    total_b = sum(r[4] for r in rows)
    return {
        "count": n,
        "rps": round(n / elapsed, 2) if elapsed > 0 else 0,
        "error_pct": round(100.0 * errs / n, 2) if n else 0.0,
        "p50": round(pct(lat, 50), 1), "p90": round(pct(lat, 90), 1),
        "p95": round(pct(lat, 95), 1), "p99": round(pct(lat, 99), 1),
        "max": round(lat[-1], 1) if lat else 0.0,
        "mb_s": round(total_b / 1048576 / elapsed, 3) if elapsed > 0 else 0,
    }


def build_report(rec, args, elapsed, interrupted):
    by = {}
    for r in rec.rows:
        by.setdefault(r[1], []).append(r)
    endpoints = {k: summarize(v, elapsed) for k, v in sorted(by.items())}
    total = summarize(rec.rows, elapsed)
    series = []
    buckets = {}
    for r in rec.rows:
        buckets.setdefault(int(r[0] // 5), []).append(r[3])
    for b in sorted(buckets):
        v = sorted(buckets[b])
        series.append({"t": b * 5, "rps": round(len(v) / 5, 2), "p95": round(pct(v, 95), 1)})
    errors = {}
    for r in rec.rows:
        if r[5]:
            errors[r[5]] = errors.get(r[5], 0) + 1
    ok = total["p95"] <= args.max_p95_ms and total["error_pct"] <= args.max_error_pct
    return {
        "started": datetime.now().isoformat(timespec="seconds"),
        "url": args.url, "scenario": args.scenario, "users": args.users,
        "duration_s": args.duration, "ramp_s": args.ramp,
        "elapsed_s": round(elapsed, 2), "interrupted": interrupted,
        "thresholds": {"max_p95_ms": args.max_p95_ms, "max_error_pct": args.max_error_pct},
        "total": total, "endpoints": endpoints, "errors": errors,
        "timeseries": series, "verdict": "PASS" if ok else "FAIL",
    }


def fmt_table(rep):
    head = f"{'Эндпоинт':<26}{'N':>7}{'RPS':>8}{'Err%':>7}{'p50':>8}{'p90':>8}{'p95':>8}{'p99':>8}{'max':>8}{'MB/s':>7}"
    lines = [head, "-" * len(head)]
    for name, s in list(rep["endpoints"].items()) + [("ИТОГО", rep["total"])]:
        lines.append(f"{name[:25]:<26}{s['count']:>7}{s['rps']:>8}{s['error_pct']:>7}"
                     f"{s['p50']:>8}{s['p90']:>8}{s['p95']:>8}{s['p99']:>8}{s['max']:>8}{s['mb_s']:>7}")
    return "\n".join(lines)


def fmt_md(rep):
    t = rep["total"]
    out = [f"# Отчёт нагрузочного теста ({rep['scenario']})", "",
           f"- Время старта: {rep['started']}", f"- Цель: `{rep['url']}`",
           f"- Пользователей: {rep['users']}, длительность: {rep['duration_s']} с, "
           f"разгон: {rep['ramp_s']} с, фактически: {rep['elapsed_s']} с"
           + (" (прервано)" if rep["interrupted"] else ""),
           f"- Пороги: p95 ≤ {rep['thresholds']['max_p95_ms']} мс, ошибки ≤ {rep['thresholds']['max_error_pct']} %",
           f"- **Вердикт: {rep['verdict']}** (p95 = {t['p95']} мс, ошибки = {t['error_pct']} %)", "",
           "## Эндпоинты (задержка в мс)", "",
           "| Эндпоинт | N | RPS | Ошибки % | p50 | p90 | p95 | p99 | max | МБ/с |",
           "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name, s in list(rep["endpoints"].items()) + [("**ИТОГО**", t)]:
        out.append(f"| {name} | {s['count']} | {s['rps']} | {s['error_pct']} | {s['p50']} | "
                   f"{s['p90']} | {s['p95']} | {s['p99']} | {s['max']} | {s['mb_s']} |")
    if rep["errors"]:
        out += ["", "## Ошибки", ""] + [f"- `{k}`: {v}" for k, v in sorted(rep["errors"].items())]
    out += ["", "## Динамика (шаг 5 с)", "", "| t, с | RPS | p95, мс |", "|---:|---:|---:|"]
    out += [f"| {s['t']} | {s['rps']} | {s['p95']} |" for s in rep["timeseries"]]
    return "\n".join(out) + "\n"


# ---------- виртуальный пользователь ----------
class User:
    def __init__(self, uid, args, rec, headers, stop_at):
        self.uid, self.args, self.rec, self.stop_at = uid, args, rec, stop_at
        self.headers = dict(headers)
        # Как за nginx: каждому виртуальному пользователю свой IP в X-Real-IP, иначе
        # per-IP лимиты geo_guard/security_hardening режут весь тест как одного клиента.
        # Заголовки Sec-Fetch-* — как у fetch() с карты (прямая навигация к данным запрещена).
        if args.fake_ip_prefix:
            self.headers["X-Real-IP"] = f"{args.fake_ip_prefix}{1 + uid % 250}"
            self.headers["X-Forwarded-For"] = self.headers["X-Real-IP"]
        self.headers.setdefault("Sec-Fetch-Site", "same-origin")
        self.headers.setdefault("Sec-Fetch-Mode", "cors")
        self.headers.setdefault("Sec-Fetch-Dest", "empty")
        self.headers.setdefault("Referer", args.url.rstrip("/") + "/")
        self.rng = random.Random(uid * 7919 + int(time.time()))
        self.lat = args.bbox_center[0] + self.rng.uniform(-0.6, 0.6)
        self.lon = args.bbox_center[1] + self.rng.uniform(-0.9, 0.9)
        self.etag = None
        self.client = None
        self.sem = asyncio.Semaphore(max(1, args.per_user_conns))  # как браузер: 6 соединений на хост

    def alive(self):
        return time.monotonic() < self.stop_at

    async def req(self, label, method, path, **kw):
        t = time.perf_counter()
        status, nbytes, err = 0, 0, ""
        try:
            async with self.sem:
                r = await self.client.request(method, path, **kw)
            nbytes = len(r.content)
            status = r.status_code
            if status in ERROR_STATUSES or status >= 500:
                err = f"HTTP {status}"
            elif status >= 400:
                err = f"HTTP {status}"
            if label == "country-boundary" and r.headers.get("etag"):
                self.etag = r.headers["etag"]
        except Exception as e:
            err = type(e).__name__
        self.rec.add(label, status, (time.perf_counter() - t) * 1000, nbytes, err)

    async def wms(self, z, x, y):
        minx, miny, maxx, maxy = tile_bbox_3857(z, x, y)
        q = ("SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=" + quote(self.args.tile_layer, safe="") +
             "&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857"
             f"&BBOX={minx},{miny},{maxx},{maxy}&WIDTH=256&HEIGHT=256")
        await self.req("wms_proxy", "GET", self.args.wms_path + "?" + q)

    async def pan(self, with_raster=True):
        z = self.rng.randint(*self.args.zoom_range)
        self.lat = min(56.0, max(51.5, self.lat + self.rng.uniform(-0.05, 0.05)))
        self.lon = min(32.5, max(23.5, self.lon + self.rng.uniform(-0.08, 0.08)))
        cx, cy = deg2tile(self.lat, self.lon, z)
        w, h = self.rng.randint(3, 4), self.rng.randint(3, 4)
        coords = [(cx + i, cy + j) for i in range(w) for j in range(h)]
        n = 2 ** z
        tasks = []
        for x, y in coords:
            x, y = x % n, min(n - 1, y)
            tasks.append(self.wms(z, x, y))
            if with_raster:
                tasks.append(self.req("tiles_raster", "GET", f"/tiles/raster/{z}/{x}/{y}.png"))
        await asyncio.gather(*tasks)

    async def sleep(self, a, b):
        end = min(self.stop_at, time.monotonic() + self.rng.uniform(a, b))
        while time.monotonic() < end:
            await asyncio.sleep(min(0.5, max(0.0, end - time.monotonic())))

    async def poll(self):
        await self.req("session_check", "GET", "/api/session/check")
        await self.req("inbox_count", "GET", "/api/messages/inbox_count")

    async def country(self):
        h = {"If-None-Match": self.etag} if self.etag else {}
        await self.req("country-boundary", "GET", "/api/country-boundary", headers=h)

    async def api_round(self):
        a = self.args
        paths = [("forestry-boundaries", "/api/forestry-boundaries"), ("zones-boundaries", "/api/zones-boundaries"),
                 ("vectors", "/api/vectors"), ("images", "/api/images"), ("basemaps", "/api/basemaps"),
                 ("news", "/api/news"), ("mbtiles_list", "/api/mbtiles/list")]
        label, p = self.rng.choice(paths)
        await self.req(label, "GET", p)
        if self.rng.random() < 0.3:
            await self.weather()
        await self.poll()
        await self.country()

    async def weather(self):
        await self.req("weather", "GET", f"/api/weather?latitude={self.lat:.4f}&longitude={self.lon:.4f}")

    async def mbtile(self):
        if not self.args.mbtiles_id:
            return
        z = self.rng.randint(6, 10)
        x, y = deg2tile(self.lat, self.lon, z)
        await self.req("mbtiles", "GET", f"/api/mbtiles/{self.args.mbtiles_id}/{z}/{x}/{y}.png")

    async def smoke(self):
        await self.req("index", "GET", "/")
        await self.req("session_init", "POST", "/api/session/init", json={})
        await self.poll()
        await self.req("session_me", "GET", "/api/session/me")
        for label, p in [("forestry-boundaries", "/api/forestry-boundaries"), ("zones-boundaries", "/api/zones-boundaries"),
                         ("vectors", "/api/vectors"), ("images", "/api/images"), ("basemaps", "/api/basemaps"),
                         ("news", "/api/news"), ("mbtiles_list", "/api/mbtiles/list")]:
            await self.req(label, "GET", p)
        await self.country()
        await self.weather()
        await self.req("geocode", "GET", "/api/geocode?q=" + quote("Минск") + "&limit=3")
        await self.pan(with_raster=True)
        await self.mbtile()

    async def run(self):
        a = self.args
        limits = httpx.Limits(max_connections=a.users + 10, max_keepalive_connections=a.users + 10)
        async with httpx.AsyncClient(base_url=a.url, headers=self.headers, limits=limits, http2=False,
                                     verify=not a.insecure, timeout=a.timeout, follow_redirects=True) as c:
            self.client = c
            try:
                if a.scenario == "smoke":
                    await self.smoke()
                elif a.scenario == "tiles":
                    if not a.only_wms:  # пропуск geo_guard (cookie gp_pass) выдаёт страница карты
                        await self.req("index", "GET", "/")
                    while self.alive():
                        await self.pan(with_raster=not a.only_wms)
                elif a.scenario == "api":
                    await self.req("session_init", "POST", "/api/session/init", json={})
                    while self.alive():
                        await self.api_round()
                        await self.sleep(0.2, 1.5)
                else:
                    await self.map_session()
            except asyncio.CancelledError:
                raise

    async def map_session(self):
        await self.req("index", "GET", "/")
        await self.req("session_init", "POST", "/api/session/init", json={})
        await self.country()
        next_poll = time.monotonic() + self.rng.uniform(15, 30)
        while self.alive():
            if time.monotonic() >= next_poll:
                await self.poll()
                next_poll = time.monotonic() + self.rng.uniform(15, 30)
            await self.pan(with_raster=not self.args.only_wms)
            r = self.rng.random()
            if r < 0.10:
                await self.weather()
            elif r < 0.20:
                await self.country()
            elif r < 0.30:
                await self.req("images", "GET", "/api/images")
            elif r < 0.40:
                await self.mbtile()
            await self.sleep(1.0, 4.0)


async def user_task(u, delay):
    await asyncio.sleep(delay)
    if u.alive():
        await u.run()


async def main_async(args, rec, uid_from=0, uid_to=None):
    headers = {"User-Agent": "geoservice-load/1.0"}
    for h in args.header:
        k, _, v = h.partition(":")
        headers[k.strip()] = v.strip()
    stop_at = time.monotonic() + args.duration
    uid_to = args.users if uid_to is None else uid_to
    users = [User(i, args, rec, headers, stop_at) for i in range(uid_from, uid_to)]
    tasks = [asyncio.create_task(user_task(u, args.ramp * i / max(1, args.users))) for i, u in enumerate(users)]
    interrupted = False
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except asyncio.CancelledError:
        interrupted = True
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return interrupted


def _worker(args, uid_from, uid_to, conn):
    """Один процесс генератора: часть пользователей, строки метрик — родителю через pipe.
    Генератор на asyncio+httpx упирается в один CPU уже на ~600 rps, поэтому при 100+
    пользователях нужно несколько процессов, иначе измеряется сам генератор."""
    import signal
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Ctrl-C обрабатывает родитель
    rec = Recorder()
    try:
        asyncio.run(main_async(args, rec, uid_from, uid_to))
    finally:
        conn.send(rec.rows)
        conn.close()


def _run_multiproc(args, rec):
    import multiprocessing as mp
    ctx = mp.get_context("spawn")
    per = [args.users // args.procs + (1 if i < args.users % args.procs else 0) for i in range(args.procs)]
    procs, conns, start = [], [], 0
    for n in per:
        if n == 0:
            continue
        parent, child = ctx.Pipe(duplex=False)
        pr = ctx.Process(target=_worker, args=(args, start, start + n, child), daemon=True)
        pr.start(); child.close()
        procs.append(pr); conns.append(parent); start += n
    interrupted = False
    try:
        for c in conns:
            rec.rows.extend(c.recv())
    except KeyboardInterrupt:
        interrupted = True
        for pr in procs:
            pr.terminate()
    for pr in procs:
        pr.join(timeout=5)
    rec.rows.sort(key=lambda r: r[0])
    return interrupted


def main():
    p = argparse.ArgumentParser(description="Нагрузочный тест geoservice")
    p.add_argument("--url", default="http://127.0.0.1:5002")
    p.add_argument("--users", type=int, default=120)
    p.add_argument("--duration", type=float, default=60)
    p.add_argument("--ramp", type=float, default=10)
    p.add_argument("--scenario", default="map", choices=["map", "tiles", "api", "smoke"])
    p.add_argument("--out", default=os.path.join(HERE, "results"))
    p.add_argument("--insecure", action="store_true")
    p.add_argument("--header", action="append", default=[], help="'Имя: значение', можно несколько раз")
    p.add_argument("--tile-layer", default=DEFAULT_LAYER)
    p.add_argument("--bbox-center", nargs=2, type=float, default=[53.9, 27.5], metavar=("LAT", "LON"))
    p.add_argument("--zoom-range", nargs=2, type=int, default=[8, 14], metavar=("MIN", "MAX"))
    p.add_argument("--max-p95-ms", type=float, default=1500)
    p.add_argument("--max-error-pct", type=float, default=1.0)
    p.add_argument("--only-wms", action="store_true", help="не ходить в /tiles/raster (нужно для мока GeoServer)")
    p.add_argument("--only", choices=["tiles"], help="только тайлы: сценарий tiles без /tiles/raster")
    p.add_argument("--mbtiles-id", type=int, default=0, help="id слоя MBTiles (см. /api/mbtiles/list)")
    p.add_argument("--wms-path", default="/geoserver_wms_proxy", help="путь WMS (для мока: /geoserver/wms)")
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--per-user-conns", type=int, default=6, help="параллельных запросов на пользователя (браузер: 6)")
    p.add_argument("--procs", type=int, default=0,
                   help="процессов генератора (0 = авто: 1 на каждые 40 пользователей, не больше числа CPU)")
    p.add_argument("--fake-ip-prefix", default="192.168.12.",
                   help="префикс X-Real-IP для виртуальных пользователей ('' — выключить); работает, если сервис доверяет 127.0.0.1 как прокси")
    args = p.parse_args()
    if args.only == "tiles":
        args.scenario, args.only_wms = "tiles", True
    args.url = args.url.rstrip("/")

    if args.procs <= 0:
        args.procs = max(1, min(os.cpu_count() or 1, math.ceil(args.users / 40)))

    t0 = time.monotonic()
    rec = Recorder()
    interrupted = False
    try:
        if args.procs > 1:
            interrupted = _run_multiproc(args, rec)
        else:
            interrupted = asyncio.run(main_async(args, rec))
    except KeyboardInterrupt:
        interrupted = True
    elapsed = time.monotonic() - t0
    rep = build_report(rec, args, min(elapsed, rec.rows[-1][0] if rec.rows else elapsed) or elapsed, interrupted)
    os.makedirs(args.out, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    jp, mp = (os.path.join(args.out, f"load_{args.scenario}_{ts}.{e}") for e in ("json", "md"))
    with open(jp, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=2)
    with open(mp, "w", encoding="utf-8") as f:
        f.write(fmt_md(rep))
    print(fmt_table(rep))
    for k, v in sorted(rep["errors"].items()):
        print(f"  ошибка {k}: {v}")
    print(f"\nВердикт: {rep['verdict']}  (p95={rep['total']['p95']} мс при пороге {args.max_p95_ms}, "
          f"ошибки={rep['total']['error_pct']}% при пороге {args.max_error_pct}%)")
    print(f"Отчёты: {jp}\n        {mp}")
    sys.exit(0 if rep["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()
