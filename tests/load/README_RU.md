# Нагрузочный стенд geoservice

Все команды выполняются из корня репозитория в venv (`. .venv/bin/activate`), доп. пакеты не нужны.

| Файл | Назначение |
|---|---|
| `load_test.py` | генератор нагрузки (asyncio + httpx), отчёты JSON/Markdown |
| `mock_geoserver.py` | заглушка GeoServer с настраиваемыми задержками и отказами |
| `make_fixtures.py` | синтетические лесхозы (`shp_leshoz/leshoz.shp`) и `stand.mbtiles` |

## Запуск стенда с моком GeoServer

```bash
# 1. PostGIS — поднимите как обычно для сервиса (БД из настроек geoservice/app.py)

# 2. Тестовые данные (идемпотентно)
python tests/load/make_fixtures.py --dest geoservice/

# 3. Мок GeoServer (порт 9090)
python tests/load/mock_geoserver.py --port 9090 --latency-ms 40 --jitter-ms 10
#   отказы:  --fail-rate 0.05     каждый N-й запрос — 5 с:  --slow-every 50
#   счётчики: curl http://127.0.0.1:9090/__stats   (total, routes, in_flight_max)

# 4. Сервис
GEOSERVER_BASE_URL=http://127.0.0.1:9090/geoserver python geoservice/server.py   # порт 5002

# 5. Нагрузка
python tests/load/load_test.py --users 120 --duration 60 --ramp 10 --scenario map
```

Важно: в `geoservice/app.py` URL GeoServer в `_geoserver_wms_proxy_impl` сейчас зашит
(`http://192.168.12.109:9090`); переменная `GEOSERVER_BASE_URL` должна быть подхвачена кодом сервиса.

MBTiles: файл `uploads/mbtiles/stand.mbtiles` сервис сам не видит — слой хранится в
`maps_storage/MBTILES_MINSK/` и регистрируется строкой таблицы `mbtiles_layers`. Регистрация через API
(нужна роль admin):

```bash
python tests/load/make_fixtures.py --register-url http://127.0.0.1:5002 --header "Cookie: session=..."
curl http://127.0.0.1:5002/api/mbtiles/list          # узнать id слоя
python tests/load/load_test.py --mbtiles-id <id>      # включить запросы к MBTiles
```

## Против реального сервера

```bash
python tests/load/load_test.py --url https://geo.example.by --insecure \
  --header "Authorization: Bearer ..." --users 60 --duration 120 --tile-layer "External:Подложка ДЗЗ"
```

Нагружайте боевую систему только по согласованию.

## Параметры `load_test.py`

`--url` `--users` (120) `--duration` (60 с) `--ramp` (10 с, линейный разгон) `--scenario` `--out` (`tests/load/results`)
`--insecure` `--header "Имя: значение"` (повторяемый) `--tile-layer` `--bbox-center LAT LON` (53.9 27.5)
`--zoom-range MIN MAX` (8 14) `--max-p95-ms` (1500) `--max-error-pct` (1.0) `--mbtiles-id`
`--only-wms` / `--only tiles` (без `/tiles/raster`), `--wms-path` (по умолчанию `/geoserver_wms_proxy`), `--timeout`.

Сценарии:
- `map` — сессия пользователя: индекс, `session/init`, опрос `session/check` + `inbox_count` раз в 15–30 с,
  «панорамирование» (блок 3×3…4×4 тайлов на случайном зуме: WMS-прокси + `/tiles/raster`),
  изредка погода, `country-boundary` (с `If-None-Match`), `images`, MBTiles.
- `tiles` — только тайлы без пауз; `api` — только JSON-эндпоинты; `smoke` — каждый эндпоинт по разу на пользователя.

Проверка самого генератора без сервиса (только мок):
`python tests/load/load_test.py --url http://127.0.0.1:9090 --only tiles --wms-path /geoserver/wms --users 50 --duration 10`

## Как читать отчёт

В `--out` создаются `load_<сценарий>_<время>.json` и `.md`; таблица печатается и в консоль.
- RPS, доля ошибок, p50/p90/p95/p99/max (мс) и МБ/с — по каждому эндпоинту и итого.
- «Динамика» — RPS и p95 по окнам 5 с: рост p95 при росте числа пользователей показывает точку насыщения.
- Ошибки: любые транспортные сбои, HTTP 404/503/504 и прочие ≥400. `304` — успех.
- Метка `wms_proxy` — прокси к GeoServer; рост p95 при `--slow-every` в моке показывает, держит ли прокси медленный бэкенд.

## Вердикт

`PASS` (код 0), если итоговый p95 ≤ `--max-p95-ms` (1500) и доля ошибок ≤ `--max-error-pct` (1.0 %);
иначе `FAIL` и код выхода 1. Ctrl-C завершает тест и печатает частичный отчёт.
