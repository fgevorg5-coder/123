# server.py
import os, sys, socket, logging

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import uvicorn

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except:
        return '127.0.0.1'
    finally:
        s.close()

PORT = 5002   # ← совпадает с nginx upstream

print("=" * 60)
print(f"🚀 FastAPI + Uvicorn запущен")
print(f"🌍 Локально:  http://127.0.0.1:{PORT}/")
print(f"📡 В сети:    http://{get_ip()}:{PORT}/")
print("=" * 60)

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=PORT,
        workers=1,
        log_level="warning",
        # loop="uvloop" — NOT supported on Windows, removed
        http="httptools",           # pip install httptools (works on Windows)
        timeout_keep_alive=30,
        timeout_graceful_shutdown=10,
        # [v20.13] 512 одновременных соединений — это ~85 пользователей по 6 соединений браузера;
        # дальше uvicorn отвечал 503 даже на страницу карты, и пользователь оставался без
        # пропуска geo_guard (каскад 403 на тайлы). Ограничение нагрузки — семафоры внутри app.py.
        limit_concurrency=int(os.getenv("UVICORN_LIMIT_CONCURRENCY", "4096")),
        # limit_max_requests перезапускал процесс каждые 10 000 запросов — при 100 пользователях
        # это раз в ~10 с с потерей всех RAM-кэшей и SSE-подключений. Выключено (0).
        limit_max_requests=int(os.getenv("UVICORN_MAX_REQUESTS", "0")) or None,
        server_header=False,
        date_header=True,
    )