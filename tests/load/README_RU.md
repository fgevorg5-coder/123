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

Адреса внешних сервисов берутся из окружения: `GEOSERVER_BASE_URL` (по умолчанию `http://192.168.12.109:9090/geoserver`)
и `OPEN_METEO_URL` (мок отдаёт погоду на `http://127.0.0.1:9090/v1/forecast`) — стенд не ходит в интернет.

Всё вместе поднимает `tests/load/run_stand.sh up` (мок + сервис на 5002), `run_stand.sh base` дополнительно
собирает исходную версию v20.12 из git на порт 5003 для сравнения «до/после», `run_stand.sh down` — останавливает.

Генератор шлёт каждому виртуальному пользователю свой `X-Real-IP` (`--fake-ip-prefix`, по умолчанию `192.168.12.`):
сервис доверяет 127.0.0.1 как прокси, поэтому per-IP лимиты geo_guard/security_hardening считаются как в проде,
а не «все 150 человек с одного адреса». Первым запросом пользователь загружает `/` — так выдаётся cookie-пропуск
`gp_pass`; без него тайлы отвечают 403. На пользователя — не больше 6 параллельных запросов (`--per-user-conns`),
как у браузера. При 100+ пользователях генератор запускается в несколько процессов (`--procs`, авто: 1 на 40
пользователей) — один процесс Python упирается в CPU уже на ~600 rps и начинает измерять сам себя.

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
`--only-wms` / `--only tiles` (без `/tiles/raster`), `--wms-path` (по умолчанию `/geoserver_wms_proxy`), `--timeout`,
`--per-user-conns` (6), `--procs` (0 = авто), `--fake-ip-prefix` (`192.168.12.`; пустая строка — выключить).

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
