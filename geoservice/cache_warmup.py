# -*- coding: utf-8 -*-
"""
🔥 Прогрев кеша тайлов ForestGIS
==================================
Запрашивает популярные тайлы при старте сервера,
чтобы первые пользователи не ждали по 4+ секунды.

Запуск вручную:
    python cache_warmup.py

Автозапуск при старте сервера — добавить в server.py:
    import subprocess, sys
    subprocess.Popen([sys.executable, 'cache_warmup.py'], cwd=os.path.dirname(__file__))

Параметры (можно менять):
"""

BASE_URL    = "http://127.0.0.1:5001"   # адрес сервера
WORKERS     = 16                         # параллельных потоков
TIMEOUT     = 30                         # секунд на тайл

# Зоны прогрева: (zoom, x_min, x_max, y_min, y_max)
# Беларусь в Web Mercator примерно z8-z12
WARM_ZONES = [
    # z8 — вся страна (~20 тайлов)
    (8,  145, 152, 82, 87),
    # z9 — вся страна (~80 тайлов)
    (9,  291, 305, 164, 175),
    # z10 — центр + основные лесхозы (~150 тайлов)
    (10, 583, 610, 329, 350),
    # z11 — только центральная зона (~100 тайлов)
    (11, 1168, 1182, 659, 670),
]

# Эндпоинты для прогрева
TILE_ENDPOINTS = [
    "/tiles/raster/{z}/{x}/{y}.png",
]

# ─────────────────────────────────────────────
import threading
import time
import urllib.request
import urllib.error
import os
import sys
from datetime import datetime

# ─── Статистика ──────────────────────────────
_lock    = threading.Lock()
_stats   = {"hit": 0, "miss": 0, "err": 0, "skip": 0}
_done    = 0
_total   = 0

def _count(key):
    global _done
    with _lock:
        _stats[key] += 1
        _done += 1

# ─── Генерация списка тайлов ─────────────────
def build_tile_list():
    tiles = []
    for (z, x0, x1, y0, y1) in WARM_ZONES:
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for tmpl in TILE_ENDPOINTS:
                    url = BASE_URL + tmpl.format(z=z, x=x, y=y)
                    tiles.append((z, x, y, url))
    return tiles

# ─── Запрос одного тайла ────────────────────
def fetch_tile(args):
    z, x, y, url = args
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "CacheWarmup/1.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            cache_header = resp.headers.get("X-Cache", "")
            resp.read()   # читаем тело
            if "HIT" in cache_header:
                _count("hit")
            else:
                _count("miss")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            _count("skip")   # тайл вне охвата данных
        else:
            _count("err")
    except Exception:
        _count("err")

# ─── Рабочий поток ───────────────────────────
def worker(queue):
    while True:
        try:
            item = queue.get(timeout=2)
        except Exception:
            break
        fetch_tile(item)
        queue.task_done()

# ─── Прогресс-бар ────────────────────────────
def progress_reporter(stop_event):
    chars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    i = 0
    t0 = time.time()
    while not stop_event.is_set():
        with _lock:
            done = _done
            hit  = _stats["hit"]
            miss = _stats["miss"]
            err  = _stats["err"]
        pct = done / _total * 100 if _total else 0
        elapsed = time.time() - t0
        rps = done / elapsed if elapsed > 0 else 0
        eta = (_total - done) / rps if rps > 0 else 0
        print(
            f"\r  {chars[i % len(chars)]}  {done}/{_total} ({pct:.0f}%)  "
            f"miss={miss} hit={hit} err={err}  "
            f"{rps:.0f} req/s  ETA {eta:.0f}s   ",
            end="", flush=True
        )
        i += 1
        time.sleep(0.25)
    print()

# ─── Основная функция ────────────────────────
def run_warmup():
    global _total

    print("=" * 60)
    print("🔥 ПРОГРЕВ КЕША ForestGIS")
    print("=" * 60)
    print(f"  Сервер:   {BASE_URL}")
    print(f"  Потоков:  {WORKERS}")
    print(f"  Зон:      {len(WARM_ZONES)}")
    print("-" * 60)

    # Проверяем доступность сервера
    try:
        urllib.request.urlopen(BASE_URL + "/", timeout=5)
    except Exception as e:
        print(f"❌ Сервер недоступен: {e}")
        print("   Запусти server.py и попробуй снова.")
        return

    tiles = build_tile_list()
    _total = len(tiles)
    print(f"  Тайлов к прогреву: {_total}")
    print(f"  Начало: {datetime.now().strftime('%H:%M:%S')}")
    print("-" * 60)

    import queue as _queue
    q = _queue.Queue()
    for item in tiles:
        q.put(item)

    stop_event = threading.Event()
    prog_thread = threading.Thread(target=progress_reporter, args=(stop_event,), daemon=True)
    prog_thread.start()

    t_start = time.time()
    threads = []
    for _ in range(min(WORKERS, _total)):
        t = threading.Thread(target=worker, args=(q,), daemon=True)
        t.start()
        threads.append(t)

    q.join()
    elapsed = time.time() - t_start

    stop_event.set()
    prog_thread.join(timeout=1)

    # ─── Отчёт ────────────────────────────────
    print("\n" + "=" * 60)
    print("📊 РЕЗУЛЬТАТ ПРОГРЕВА")
    print("=" * 60)
    print(f"  ✅ Загружено (MISS→кеш):  {_stats['miss']}")
    print(f"  ⚡ Уже в кеше (HIT):      {_stats['hit']}")
    print(f"  ⬜ Пустых тайлов (404):   {_stats['skip']}")
    print(f"  ❌ Ошибок:                {_stats['err']}")
    print(f"  ⏱  Время:                 {elapsed:.1f} сек")
    print(f"  🚀 Скорость:              {_total / elapsed:.0f} тайлов/сек")
    print("=" * 60)

    cached = _stats["miss"]
    if cached > 0:
        print(f"\n🟢 Кеш прогрет! {cached} тайлов теперь отдаются мгновенно.")
    else:
        print("\n🟡 Все тайлы уже были в кеше или данных нет.")

    print("=" * 60)

# ─── Интеграция в server.py (автозапуск) ─────
def start_in_background(server_base_url=None, delay_sec=5):
    """
    Запускает прогрев в фоне через delay_sec секунд после старта сервера.
    Вставить в server.py перед serve():

        from cache_warmup import start_in_background
        start_in_background(delay_sec=10)
    """
    global BASE_URL
    if server_base_url:
        BASE_URL = server_base_url

    def _delayed():
        time.sleep(delay_sec)
        print(f"\n🔥 Автопрогрев кеша запущен (через {delay_sec}с после старта)...")
        run_warmup()

    t = threading.Thread(target=_delayed, daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Прогрев кеша тайлов ForestGIS")
    parser.add_argument("--url",     default=BASE_URL,  help="Базовый URL сервера")
    parser.add_argument("--workers", type=int, default=WORKERS, help="Параллельных потоков")
    args = parser.parse_args()

    BASE_URL = args.url
    WORKERS  = args.workers

    run_warmup()