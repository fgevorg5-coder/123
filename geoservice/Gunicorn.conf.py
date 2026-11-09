# gunicorn.conf.py
# Запуск: gunicorn -c gunicorn.conf.py app:app

workers = 4
worker_class = "gthread"   # threading — поддерживает streaming-ответы
threads = 4
timeout = 0                # 0 = без таймаута воркера (нужно для загрузки больших COG-файлов)
graceful_timeout = 30
keepalive = 5
bind = "0.0.0.0:5000"