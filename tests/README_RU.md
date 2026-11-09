# Тесты геосервиса (v20.4)

| Папка | Что проверяет | Чем запускать |
|---|---|---|
| `security/test_security_unit.py` | 88 модульных тестов защитных функций (`security_hardening.py`): обход путей, лимиты тела, CSRF/Origin, заголовки, rate-limit, SSE, проверка загрузок | `pytest` |
| `security/attack_suite.py` | «Чёрный ящик»: 36 атак на живой сервер (обход каталогов, утечки, инъекции SQL/XSS/XXE, доступ без входа, SSRF, CSRF, подбор паролей, DoS, заголовки) + работа под атакой (флуд) | `python3` / `pytest` |
| `security/test_attack_suite.py` | Та же атака как pytest: каждая проверка — отдельный тест | `pytest` |
| `security/stand/` | Стенд: запускает **настоящий** `app.py` без PostgreSQL/GDAL (заглушки), плюс локальный nginx | `python3`, `nginx` |
| `3d/` | 17 сценариев 3D-режима в Chromium/WebGL2 (утечки контекстов, гонки, сбои API, производительность) | `node` (Playwright) |
| `ui/` | Раскладка и дизайн всех вкладок на 3 экранах: 68 проверок + скриншоты | `node` (Playwright) |
| `ui/v18_*` | v18: сотрудники ОДЗиМЛ, календарь, ЭЦП и очередь печати, профиль, методички — 54 + 37 + 124 + 200 проверок (только на стенде: создают и удаляют данные) | `node` (Playwright) |
| `3d/label_jitter.js`, `3d/label_lag_synth.js` | v19: дрожание и отставание подписей кварталов/выделов при вращении и приближении (px от своей точки, подмены номеров) | `node` (Playwright) |
| `trees/` | v19/v20: модели деревьев (v20 — 18 моделей) — загрузка, импосторы, ближние модели, породы, LAS-деревья, производительность (12 проверок) | `node` (Playwright) |
| `geocoder/test_geocoder.py` | v20: поиск адресов — раскрытие сокращений, город без «г.», разбор дома/корпуса, «не тот город» (без сети); с `GEOCODER_ONLINE=1` — 4 запроса к OSM (опечатка, город, дом не найден, корпус) | `python` / `pytest` |
| `uav/` | v19: режим БПЛА — 6 типов, взлёт/посадка, миссия, автопилот, возврат и повторный вылет, панель; компьютер 27 и телефон 7 проверок | `node` (Playwright) |
| `dem/` | v19: `/api/forest3d/dem` — тайлы, кэш, источники, ошибки | `python` |
| `lesolidar/` | v19: `/api/lesolidar` (загрузка кусками, докачка, демо, задание, отмена, результаты) и мастер ЛесоЛидара в 3D (17 проверок) | `python`, `node` (Playwright) |
| `georef/` | v19: «План → GeoTIFF/TFW → MBTiles» и «Растр → MBTiles» — API и прохождение в интерфейсе; v20.3: СК «по координатам», «Переместить» (64 + 20 проверок) | `python`, `node` (Playwright) |
| `preview/` | v20.4: превью-страница `/preview` — маршрут, файлы, медиа, бюджеты (74) и браузер: окно под курсором, «нырок», телефон, reduced-motion (44 + 18 снимков) | `python`, `node` (Playwright) |
| `perf/lh.js` | Lighthouse главной под администратором (телефон/компьютер) | `node` (Playwright + Lighthouse) |

## 1. Модульные тесты (1 секунда, сеть не нужна)
```bash
pip install pytest starlette httpx
pytest -q tests/security/test_security_unit.py          # ожидается: 88 passed
```

## 2. Атаки на работающий сервер
Безопасный режим (по умолчанию): только чтение, заведомо отклоняемые запросы, ничего не создаётся и не удаляется.
```bash
pip install requests
python3 tests/security/attack_suite.py --base https://192.168.12.97 --insecure \
        --report security_report.html --json security_results.json
# или как pytest:
ATTACK_BASE=https://192.168.12.97 ATTACK_INSECURE=1 pytest -q tests/security/test_attack_suite.py
```
Полный прогон «под атакой» (подбор пароля блокирует IP на 15 минут — запускайте на стенде или в окно обслуживания):
```bash
python3 tests/security/attack_suite.py --base https://127.0.0.1 --insecure --intrusive --flood 20 \
        --admin-user admin --admin-pass '***' --stepup-pass '***' --loopback-ips --server-pid <PID uvicorn> \
        --json after.json --compare before.json --report security_report.html
```
Код возврата `1` — найдены уязвимости уровня critical/high (удобно для CI).

## 3. Стенд (без PostgreSQL/GDAL)
```bash
cd tests/security/stand
./make_stand.sh /путь/к/новой/версии stand_fixed && python3 run_stand.py stand_fixed 8812 &
./make_stand.sh /путь/к/старой/версии stand_orig && python3 run_stand.py stand_orig 8811 &
# через nginx (Linux): собрать локальную копию конфига и запустить
./nginx_local.sh ../../../geoservice/nginx.conf /tmp/ngx/conf/nginx.conf 8443 8080 8812 _new "$(realpath /путь/к/новой/версии)"  # подготовка — в шапке скрипта
```
«Версия» — **полная** папка проекта (`app.py`, `static_assets.py`, `static/`, `templates/`; для v19 — ещё `forest3d_dem.py`, `lesolidar_bridge.py`, `jobkit.py`, `georef_api.py`, `georef_runner.py` и `tools/`): старая — до обновления, новая — после копирования файлов из `geoservice/` (в поставке только изменённые файлы).
Пароль администратора стенда — в `run_stand.py` (переменная `ADMIN_PASSWORD`).

## 4. 3D-раздел — см. `3d/README.md`

## 5. Дизайн / раскладка
```bash
npm i playwright && npx playwright install chromium
node tests/ui/ui_layout_test.js https://127.0.0.1:9443 out before   # старая версия
node tests/ui/ui_layout_test.js https://127.0.0.1:8443 out after    # новая версия
python3 tests/ui/make_ui_report.py out reports                     # → reports/ui_report.html
```
Переменные: `ADMIN_USER`, `ADMIN_PASS`, `STEPUP_PASS`, `CHROME` (путь к Chromium, если не из Playwright).

`ui_layout_test.js` (v17) — 68 проверок: к 53 прежним добавлены 15 проверок компактности и читаемости
(ширина панелей, шрифт и размер текста, единый набор иконок, сворачивание меню, кнопки карты, подписи линейки).
Ожидается: v16 — 53/68, v17 — 68/68.

### 5.1. Новые элементы v17 и отчёт «до/после»
```bash
node tests/ui/v17_func_test.js https://127.0.0.1:8443 out/v17_func.json   # 12 проверок: меню, размер текста, кнопки, линейка
python3 tests/ui/make_design_report.py before/v16_ui.json after/v17_ui.json out/v17_func.json shots reports/design_v17_report.html "17/17"
```
`shots/` для отчёта: `b16_*.png` / `a17_*.png` (экран 1706×851), `b16t_*` / `a17t_*` (планшет 768×1024),
`ui_b_<экран>_tabNN.png` / `ui_a_<экран>_tabNN.png` — снимки `ui_layout_test.js` (префиксы `v16_` / `v17_` заменить на `ui_b_` / `ui_a_`).

## 6. Новые функции v18 (только на стенде)
Тесты создают и удаляют данные (сотрудники, отметки, ЭЦП, профили) — запускайте их на стенде из раздела 3, не на рабочем сервере.
```bash
export STAND_DIR=tests/security/stand/stand_fixed        # папка стенда: stand.db, secret.key, static/
B=http://127.0.0.1:8812
node tests/ui/v18_api_test.js $B                  # 54: сотрудники, отметки календаря, ЭЦП, очередь, профиль, права
node tests/ui/v18_ecp_ui_test.js $B               # 37: ЭЦП черновик → утверждение → блокировка, «Обновлено…»
node tests/ui/v18_profile_ui_test.js $B           # 62: профиль на компьютере (сам создаёт демо-коллег)
node tests/ui/v18_profile_ui_test.js $B mobile    # 62: профиль на телефоне 390×844
node tests/ui/v18_manuals_ui_test.js $B           # 49: методички, администратор
node tests/ui/v18_manuals_ui_test.js $B mobile    # 53
node tests/ui/v18_manuals_ui_test.js $B mobile anon   # 51: гость
node tests/ui/v18_manuals_ui_test.js $B anon      # 47
```
Ожидается 0 FAIL везде. Методички проверяются на демо-данных заглушки `security/stand/stubs/manuals_api.py` (раздел из 11 гайдов + раздел с PDF и DOC).

Вспомогательные:
* `v18_profile_seed.py [clean]` — демо-коллеги с фото, рамками, статусами и перепиской; `clean` — удалить всё созданное.
* `v18_seed.js <base>` — демо-отметки календаря для скриншотов (удаляет только свои прежние).
* `stand_ecp_reset.py [stand.db]` — удалить тестовую ЭЦП администратора стенда.
* `stand_api.js <base> <METHOD> <url> [json]` — запрос к API стенда от имени администратора.
* `make_design_report_v18.py <скриншоты> <отчёт.html> [tests_summary.json] [lighthouse_summary.json]` — отчёт «до/после» (`reports/design_v18_report.html`).
* `fixtures/sample.jpg` — фото для проверки загрузки и кадрирования.

После прогона на стенде: `python3 tests/ui/v18_profile_seed.py clean && python3 tests/ui/stand_ecp_reset.py`.
Переменные: `ADMIN_USER`, `ADMIN_PASS`, `STEPUP_PASS` (по умолчанию — пароли стенда), `CHROME`, `STAND_DIR`.

## 7. Скорость (Lighthouse)
```bash
npm i playwright lighthouse
node tests/perf/lh.js https://127.0.0.1:8443 out/v18_mobile mobile     # телефон (Moto G Power, CPU ×4, медленный 4G)
node tests/perf/lh.js https://127.0.0.1:8443 out/v18_desktop desktop   # компьютер
```
Оценка на телефоне заметно «плавает» от прогона к прогону (имитация медленного CPU) — берите медиану 3–5 прогонов. Результаты v17/v18 — `reports/lighthouse/README.md`.

## 8. Новое в v19: 3D, подписи, деревья, БПЛА, ЛесоЛидар, привязка планов
Бэкенд портала не нужен: 3D-стенд `3d/mock_server.py` отдаёт статику и синтетические данные, API-тесты поднимают
**настоящие** модули v19 (`forest3d_dem.py`, `lesolidar_bridge.py`, `georef_api.py`) через `fastapi.TestClient`.
```bash
pip install fastapi uvicorn httpx numpy pillow rasterio shapely pyproj opencv-python-headless mapbox-vector-tile pypdfium2
npm i playwright && npx playwright install chromium
export GEO_DIR=/путь/к/полной/папке/новой/версии     # app.py, static/ (вместе с неизменёнными файлами), tools/
export WORK_DIR=/tmp/geo_tests                        # рабочие файлы (по умолчанию tests/_work)
```
Если Chromium не из Playwright — `CHROME=/usr/bin/chromium`. Каталог результатов — последний аргумент (по умолчанию `out/...`).

**3D-стенд и браузерные тесты 3D** (по одному стенду на версию):
```bash
cd tests/3d
STATIC_DIR=$GEO_DIR/static python3 -m uvicorn mock_server:app --host 127.0.0.1 --port 8819 &
STATIC_DIR=/путь/к/старой/static python3 -m uvicorn mock_server:app --host 127.0.0.1 --port 8818 &
node run_3d_tests.js http://127.0.0.1:8819 v19 out/3d          # 17 сценариев (регрессия v16–v18)
node label_jitter.js http://127.0.0.1:8819 v19 out/labels      # подписи: дрожание при вращении/приближении
node label_lag_synth.js http://127.0.0.1:8819 v19 out/labels   # подписи: смещение от точки (сравнить с ...:8818 v18)
node ../trees/trees_test.js http://127.0.0.1:8819 out/trees    # деревья: 12 проверок
node ../uav/uav_test.js http://127.0.0.1:8819 out/uav          # БПЛА, компьютер: 27 проверок
node ../uav/uav_mobile.js http://127.0.0.1:8819 out/uav_mobile # БПЛА, телефон 390×844: 7 проверок
```
Ожидается: 17/17, подписи — смещение p95 < 1 px и 0 подмен номеров (v18: p95 15,6 px, до 96 px при приближении, 2972 подмены), 12/12, 27/27, 7/7.

**Рельеф (без браузера):**
```bash
python3 tests/dem/test_dem_api.py          # EXIT 0; нужен интернет (AWS Terrain Tiles) или FOREST3D_DEM_GEOTIFF
```

**ЛесоЛидар:** обработчик — `LesoLidar.exe` в `$GEO_DIR/tools/LesoLidar/` или `LESOLIDAR_EXE` (Windows);
на Linux — `LESOLIDAR_PATH=<папка пакета lesolidar>` (Python — тот же, что запускает тест).
```bash
python3 tests/lesolidar/test_lesolidar_api.py                 # ALL OK: загрузка кусками, докачка, демо, обработка, результаты
PORT=8821 python3 tests/lesolidar/ll_server.py &              # стенд мастера: настоящий /api/lesolidar + 3D-заглушки
node tests/lesolidar/ll_ui_test.js http://127.0.0.1:8821 out/lesolidar_ui   # 17 проверок
```
Иконки стенда — с CDN Font Awesome (как на портале) или своя копия: `FA_DIR=<папка с css/ и webfonts/>`.

**«План → GeoTIFF/TFW → MBTiles»** (нужен интернет: контуры НКА/OSM, ортофото; кэш прошлых прогонов — `GEOREF_CACHE_DIR`):
```bash
python3 tests/georef/test_georef_api.py                       # ALL OK; кладёт Plan_A.tif/.tfw/.prj в out/georef_api
cd tests/georef && python3 -m uvicorn ui_server:app --host 127.0.0.1 --port 8811 &
node run_georef_ui.js http://127.0.0.1:8811 out/georef_ui     # PDF → привязка → результат → «Растр → MBTiles» → история
```
План для проверки — `georef/fixtures/Plan_A.pdf` (свой — `PLAN_PDF=...`). OpenLayers стенда — с CDN или `FE_DIR=<папка с ol.js и ol.css>`.

## 9. Новое в v20

```bash
python tests/geocoder/test_geocoder.py                       # без сети, < 1 с → ALL OK
GEOCODER_ONLINE=1 python tests/geocoder/test_geocoder.py     # + поиск через Nominatim/Overpass (~15 с)
node tests/trees/trees_test.js http://127.0.0.1:8801 out/trees   # стенд 3D (tests/3d/mock_server.py) → 12 OK
node tests/3d/run_3d_tests.js http://127.0.0.1:8801 v20 out/3d   # 17 сценариев; для T13 нужен busel_model.js проекта
```

## 10. Новое в v20.2: «Смена СК» → «Переместить» для растров (`tests/crs_shift/`)

Стенд без GDAL и PostgreSQL: настоящий `static/panel-crs.js`, OpenLayers 9.2.4 и proj4 2.10.0 (CDN, как на портале),
заглушки `/api/crs/*` и `/api/crs-shift/*` (тот же API, что у `crs_shift.py`). Тестовые результаты создаются сами
(`_work/crs_shift/fixtures`): растр EPSG:3857 с кириллическим именем (.tif .tfw .tfwx .prj), UTM 35N с
ModelTransformation, .aux.xml и .ovr, «голый» BigTIFF EPSG:4326, SHP, растр с .tfwx не в формате world-файла.
Сервер стенда сам проверяет каждый сохранённый ZIP: теги TIFF (свой разбор + Pillow), .tfw/.tfwx, .aux.xml, неизменность
пикселей и прочих байтов, имена файлов.

```bash
pip install fastapi uvicorn python-multipart pillow
python tests/crs_shift/stand.py 8790                       # GEO_DIR — папка geoservice; JSZIP_JS — путь к jszip.min.js
CHROME=/path/to/chromium node tests/crs_shift/run_crs_shift_ui.js   # Playwright → 60 OK, снимки и ui_results.json в _work/crs_shift
```
Chromium без UTF-8 локали называет кириллические загрузки «download» — тест запускает его с `LANG=C.UTF-8`.

## 11. Новое в v20.3: СК «по координатам» и «Переместить» в «План → GeoTIFF» / «Растр → MBTiles» (`tests/georef/`)

Без сети и без пакетов привязки (shapely и др.): тестовые растры создаются сами (`shift_fixtures.py`) — лист плана
«пер. Стахановский (оз)» как у `georef_plans.py` (EPSG:3857 с поворотом −0,79°, `.ovr`, `.tfw/.tfwx`, `.prj`,
`.aux.xml`, MBTiles) и сканы «Пар-2-73…» `.tif + .tfw` без `.prj` в СК-42 зона 5 и UTM 35N.
```bash
pip install fastapi uvicorn python-multipart httpx rasterio numpy pillow
python tests/georef/test_georef_shift.py                      # 64/64 OK, ~40 с: теги GeoTIFF, авто-СК, API /shift
cd tests/georef && python3 -m uvicorn ui_server:app --host 127.0.0.1 --port 8811 &
CHROME=/path/to/chromium node run_shift_ui.js http://127.0.0.1:8811 out/shift_ui   # 20/20 OK + 10 снимков
```
Стенд `ui_server.py` дополнен `/fixtures` (сканы без СК) и `/seed_georef?tok=…` (готовое задание привязки владельца
cookie `georef_uid`) — только для тестов, в приложение не входит.

## 12. Новое в v20.4: превью-страница `/preview` (`tests/preview/`)

Без сети и без PostgreSQL: стенд `ui_server.py` — FastAPI + `preview_page.build_router` (как в `app.py`) + `/static`,
заглушки `/`, `/login`, `/favicon.ico`.
```bash
pip install fastapi uvicorn httpx pillow numpy
python3 tests/preview/test_preview.py                     # 74/74, ~20 с; ffmpeg в PATH — ещё проверки петель видео
NODE_PATH=<node_modules с playwright> CHROME=$(which chromium) node tests/preview/run_preview_ui.js   # 44/44, ~1,5 мин
```
`run_preview_ui.js` сам поднимает стенд на порту 8766 (`BASE=<url>` — проверить уже запущенный сервер), снимки и
`ui_log.txt` — в `reports/v20.4_shots/` (`OUT=<папка>`). `PREVIEW_CACHE=<кэш генератора>` в `test_preview.py` —
дополнительно прогнать генератор офлайн на маленьком кадре.

## 13. Новое в v20.10: «Съёмка по годам», ЛесоЛидар, редактор методичек

```bash
pip install fastapi uvicorn httpx itsdangerous jinja2 python-dotenv requests
# «Съёмка по годам»: стенд с журналом GetMap (пустой LAYERS или External:* не к GEOSERVER_EXT → ServiceException, как у GeoServer)
GEO_DIR=geoservice FE_DIR=<папка с ol.js, ol.css, proj4.js> python3 tests/dzz_timeline/stand.py 8210 &
REPORT_TAG=v20.10 NODE_PATH=<node_modules с playwright> CHROME=$(which chromium) node tests/dzz_timeline/run_dzz_timeline_ui.js http://127.0.0.1:8210
#   65/65 → reports/v20.10_ui_report.{json,md}, снимки reports/v20.10_shots/ (30–33 — тайлы при зуме и размеры шкалы)
# Редактор методичек
python3 tests/manuals_editor/test_manuals_editor_api.py          # 23/23: права, CSRF, 409, очистка HTML, лимиты, история
bash tests/security/stand/make_stand.sh geoservice <стенд> && python3 tests/security/stand/run_stand.py <стенд> 8240 &
NODE_PATH=<…> CHROME=$(which chromium) node tests/manuals_editor/run_manuals_editor_ui.js http://127.0.0.1:8240   # 8/8, снимки 40–42
# ЛесоЛидар: поиск программы и подсказка (без самой программы)
python3 tests/lesolidar/test_lesolidar_detect.py                 # 19/19
```

