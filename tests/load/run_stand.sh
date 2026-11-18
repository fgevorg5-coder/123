#!/usr/bin/env bash
# Локальный нагрузочный стенд геосервиса.
#   tests/load/run_stand.sh up      — мок GeoServer/Open-Meteo (9090) + сервис (5002)
#   tests/load/run_stand.sh down    — остановить
#   tests/load/run_stand.sh base    — дополнительно поднять исходную версию v20.12 на 5003
#   Переменные: MOCK_ARGS="--max-concurrent 6" (control-flow мока), APP_ENV="WORKERS=4" (env сервиса), APP_WORKERS=4 (воркеры uvicorn)
# Требует: PostGIS (БД forest), .venv с зависимостями, geoservice/.env, фикстуры make_fixtures.py.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$ROOT/.venv/bin/activate"
STUBS="$ROOT/tests/load/stubs"
MOCK_LAT="${MOCK_LATENCY_MS:-40}"
BASE_REF="${BASE_REF:-77f1592}"   # коммит с исходным кодом v20.12

start_mock() {
  pgrep -f "mock_geoserver.py --port 9090" >/dev/null && return 0
  (cd "$ROOT" && . "$VENV" && nohup python tests/load/mock_geoserver.py --port 9090 \
      --latency-ms "$MOCK_LAT" --jitter-ms 20 ${MOCK_ARGS:-} >/tmp/mockgs.log 2>&1 &)
}

start_app() {  # $1 = каталог geoservice, $2 = порт; APP_ENV — доп. переменные сервиса ("A=1 B=2")
  (cd "$1" && . "$VENV" && \
   env GEOSERVER_BASE_URL=http://127.0.0.1:9090/geoserver OPEN_METEO_URL=http://127.0.0.1:9090/v1/forecast \
   ${APP_ENV:-} PYTHONPATH="$STUBS" nohup python -m uvicorn app:app --host 127.0.0.1 --port "$2" --workers "${APP_WORKERS:-1}" \
     --http httptools --limit-concurrency 4096 --log-level warning >"/tmp/app$2.log" 2>&1 &)
}

wait_http() {  # $1 = url
  for _ in $(seq 1 60); do curl -fs -o /dev/null "$1" && return 0; sleep 1; done
  echo "не поднялся: $1" >&2; return 1
}

case "${1:-up}" in
  up)
    start_mock; sleep 1
    start_app "$ROOT/geoservice" 5002
    wait_http http://127.0.0.1:9090/__stats; wait_http http://127.0.0.1:5002/health
    echo "стенд готов: сервис http://127.0.0.1:5002, мок http://127.0.0.1:9090/__stats"
    ;;
  base)
    # Исходная версия: код из git, недостающие модули и фикстуры — из рабочего каталога,
    # адреса GeoServer/Open-Meteo в ней захардкожены, поэтому подменяем sed-ом.
    rm -rf /tmp/baseline && mkdir -p /tmp/baseline
    (cd "$ROOT" && git archive "$BASE_REF" geoservice | tar -x -C /tmp/baseline)
    for m in admin_stepup design_theme_api forest3d_access forest3d_api forest3d_dem forest3d_las geo_guard geocoder ip_identity manuals_api season_api; do
      cp "$ROOT/geoservice/$m.py" /tmp/baseline/geoservice/
    done
    cp "$ROOT/geoservice/.env" /tmp/baseline/geoservice/
    cp -r "$ROOT/geoservice/shp_leshoz" /tmp/baseline/geoservice/
    sed -i 's#http://192.168.12.109:9090/geoserver#http://127.0.0.1:9090/geoserver#g; s#https://api.open-meteo.com/v1/forecast#http://127.0.0.1:9090/v1/forecast#g' /tmp/baseline/geoservice/app.py
    start_mock; sleep 1
    start_app /tmp/baseline/geoservice 5003
    wait_http http://127.0.0.1:5003/health
    echo "исходная версия: http://127.0.0.1:5003"
    ;;
  down)
    pkill -f "uvicorn app:app --host 127.0.0.1 --port 500[23]" || true
    pkill -f "mock_geoserver.py --port 9090" || true
    echo "остановлено"
    ;;
  *) echo "использование: $0 up|base|down" >&2; exit 2 ;;
esac
