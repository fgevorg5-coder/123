# v20.12 — реалистичные деревья таксации

Установка, управление и ограничения: `ПРОЧТИ_v20.12.txt`. Старые инструкции сохранены ниже для истории.

# v20.11 — TaxationData в 3D

Пошаговая установка, использование и ограничения — в `ПРОЧТИ_v20.11.txt`. Предыдущие разделы ниже сохранены.

# Установка обновлений геосервиса (последнее — v20.10; включает всё из v16–v20.9)

Что изменилось и зачем — в `CHANGELOG_RU.md` (v19 — `CHANGELOG_v19_RU.md`, v16–v18 — `CHANGELOG_v18_RU.md`). Как запускать тесты — в `tests/README_RU.md`.
Снимки v20.3 — `reports/v20.3_shots/`, v20 — `reports/v20_shots/`; отчёт v19 со скриншотами — `reports/v19_report.html`, журналы и JSON — `reports/tests_v19/`.

## v20.10 — поверх v20.9 (или любой v20.x): «Съёмка по годам», ЛесоЛидар, редактор методичек

Что исправлено: снимки из «Съёмки по годам» снова видны на карте и догружаются при приближении; шкала крупнее
(130 %, кнопки «A−» / «A+»); ЛесоЛидар подсказывает администратору точный путь и находит программу без перезапуска
(кнопка «Проверить снова»); «Методички» — новый сервер редакций `manuals_editor_api.py` (правка и сохранение веб-редакции).

1. Остановить приложение (службу или окно uvicorn).
2. Скопировать **содержимое** папки `geoservice` из архива в корень приложения (туда, где `app.py`), с заменой.
   Саму папку `geoservice` внутрь не класть: должно получиться `D:\DZZ_geo\manuals_editor_api.py` рядом с `D:\DZZ_geo\app.py`.
3. Запустить приложение — **перезапуск нужен** (новые/изменённые `.py`: `app.py`, `manuals_editor_api.py`, `lesolidar_bridge.py`, `security_hardening.py`).
4. В браузере Ctrl+F5.
5. Проверка: `python check_install_v20.10.py` и `python check_install_v20.10.py --url http://127.0.0.1:<порт>`.
6. ЛесоЛидар — по разделу [«ЛесоЛидар»](#лесолидар--подключение-программы-v2010) ниже.

БД, nginx, GeoServer и пакеты Python не меняются. Новые переменные `.env` (необязательные) — в разделе «Редактор методичек».

| Файл | Куда | Что изменено (v20.10) |
|---|---|---|
| `static/map-core.js` | `static/` | внешний слой ДЗЗ без имени берёт имя из каталога (`sublabel`), запросы — к нужному GeoServer |
| `static/panel-timeline.js` | `static/` | «Съёмка по годам»: включение снимка с именем слоя; крупная шкала, «A−/A+», подстройка под экран |
| `static/lesolidar-web.js` | `static/` | подсказка «куда положить LesoLidar.exe», кнопка «Проверить снова» |
| `static/manuals-workspace.js` | `static/` | понятное предупреждение с кодом ошибки, если сервер редакций не отвечает |
| `manuals_editor_api.py` | рядом с `app.py` | **новый**: сервер редакций методичек `/api/manuals-editions/…` |
| `app.py` | корень | подключение `manuals_editor_api.py` (после `manuals_api`) |
| `lesolidar_bridge.py` | корень | поиск программы в «двойной» папке, в `..\tools\`, по `.env` без перезапуска |
| `security_hardening.py` | корень | лимит тела запроса для `/api/manuals-editions/` = `MANUALS_EDITION_MAX_MB` + 1 МБ |
| `check_install_v20.10.py` | корень | проверка установки (после проверки можно удалить) |

## ЛесоЛидар — подключение программы (v20.10)

Окно «ЛесоЛидар — Не настроен: Не найден LesoLidar.exe» значит, что рядом с приложением нет программы обработки облаков.
Программа (`LesoLidar.exe` и папка `_internal`) в архив обновления не входит — её нужно скопировать один раз.

1. Возьмите папку программы **целиком**: `LesoLidar.exe`, `_internal\`, а также `models\` и `tables\` (если есть).
   Одного `LesoLidar.exe` мало — без `_internal` он не запустится.
2. Скопируйте её в папку `tools\LesoLidar\` рядом с `app.py`, чтобы получилось:
   ```
   D:\DZZ_geo\app.py
   D:\DZZ_geo\tools\LesoLidar\LesoLidar.exe
   D:\DZZ_geo\tools\LesoLidar\_internal\
   D:\DZZ_geo\tools\LesoLidar\models\      (если есть)
   D:\DZZ_geo\tools\LesoLidar\tables\      (если есть)
   ```
   Если после распаковки ZIP получилось «папка в папке» (`tools\LesoLidar\LesoLidar\LesoLidar.exe`) — тоже подойдёт,
   как и `tools\LesoLidar_<версия>\…` или `tools\` уровнем выше папки приложения.
3. **Или** оставьте программу где угодно и впишите в `.env` рядом с `app.py` одну строку (путь к файлу или к папке,
   кавычки допускаются):
   ```
   LESOLIDAR_EXE=D:\Programs\LesoLidar\LesoLidar.exe
   ```
4. Перезапуск не нужен: войдите администратором (с дополнительным паролем, если включён), откройте «ЛесоЛидар»
   и нажмите **«Проверить снова»**. Плашка «Не настроен» сменится на готовность к обработке.
   Пока программа не найдена, администратор видит в окне точный путь, куда её положить, и список проверенных мест;
   обычные пользователи — только «ещё не настроен, обратитесь к администратору» (без путей сервера).
5. Если плашка пишет «Рядом с LesoLidar.exe нет папки _internal» — скопирована не вся папка, повторите шаг 1.
   Если «LESOLIDAR_EXE = «…» — там нет LesoLidar.exe» — исправьте путь в `.env` (или удалите строку) и снова «Проверить снова».
6. Учётная запись службы (под которой работает приложение) должна иметь права на чтение и запуск этой папки и на запись
   в `instance\lesolidar\` (`LESOLIDAR_WORKDIR`). Антивирус не должен блокировать `LesoLidar.exe`.

Остальные переменные ЛесоЛидара — в разделе 3 («v19 — ЛесоЛидар»).

## Редактор методичек — сервер редакций (v20.10)

Предупреждение в «Методичках» «сервер редакций не подключён… Установите модуль manuals_editor_api» значит, что
на сервере нет модуля, который хранит отредактированные (веб-)редакции методичек. Теперь он есть.

1. Файл `manuals_editor_api.py` — рядом с `app.py` (входит в архив, шаг 2 установки v20.10).
   `app.py` из архива уже подключает модуль. Если ваш `app.py` правился вручную и заменять его нельзя — вставьте в него
   сразу после подключения `manuals_api` (строка с `include_router` для методичек) этот блок:
   ```python
   try:
       from manuals_editor_api import build_router as _build_manuals_editor_router
       app.include_router(_build_manuals_editor_router(base_dir=BASE_DIR, require_admin=require_admin,
                                                       verify_csrf=verify_csrf, logger=logger))
       logger.info("✅ Редактор методичек (manuals_editor_api) подключён: /api/manuals-editions")
   except Exception as _e:
       logger.warning("Редактор методичек не подключён: %s", _e)
   ```
   и в `security_hardening.py` (список лимитов тела запроса, после строки `("/api/admin/manuals/", big),`) строку
   `("/api/manuals-editions/", (_env_int("MANUALS_EDITION_MAX_MB", 40) + 1) * MB),` — иначе большие редакции с картинками
   получат «413».
2. Перезапустите приложение. В журнале запуска появится строка `✅ Редактор методичек (manuals_editor_api) подключён`.
3. Проверка: `<адрес портала>/api/manuals-editions/_status` → `{"ready": true, "version": "20.10", …}`.
4. В «Методичках» администратор: «Редактировать» → правка → «Сохранить» → «Редакция N сохранена на сервере».
   Читают редакцию все пользователи; сохранять — только администратор (с дополнительным паролем, если включён).
   Исходный файл (DOCX/PDF) не меняется; если две вкладки правят одновременно — вторая получит «документ уже изменён»
   и не затрёт чужую правку.

Где хранится: `instance\manuals_editions\<id файла>\r000001.json …` + `index.json` (включите папку в резервное копирование).

| Переменная `.env` | По умолчанию | Назначение |
|---|---|---|
| `MANUALS_EDITIONS_DIR` | `instance/manuals_editions` | папка редакций |
| `MANUALS_EDITION_MAX_MB` | `40` | предельный размер одной редакции вместе с картинками (nginx: `client_max_body_size` для `/api/` должен быть не меньше — в поставке 100m) |
| `MANUALS_EDITIONS_KEEP` | `100` | сколько последних редакций одного файла хранить (старые удаляются) |

Если предупреждение осталось: в нём указан код ошибки — `404` (модуль не подключён: файл не рядом с `app.py` или
приложение не перезапущено; см. журнал запуска), `401/403` (войдите администратором), `502/504` (приложение не запущено).

## 0.000. Если v20.2 уже установлен — v20.3 (MBTiles «на месте» и «Переместить»): 6 файлов + 1 новый

База данных, `.env` и `nginx.conf` не меняются, новых пакетов не нужно.

1. Резервная копия заменяемых файлов.
2. Рядом с `app.py`: **`georef_shift.py`** (новый — без него не загрузится `georef_api.py`), заменить
   **`georef_api.py`**, **`georef_runner.py`**, **`jobkit.py`**.
3. `tools\georef\` (или `GEOREF_TOOLS_DIR`): заменить **`tif2mbtiles.py`** (и `README.md`).
4. `static\`: заменить **`panel-georef.js`**.
5. Перезапустить приложение (службу FastAPI) — меняются Python-модули.
6. Проверка: «Конвертер СК» → «Растр → MBTiles» → в «Если в файле нет СК» выбрано «Авто — по координатам» →
   загрузить «Пар-2-73…tif» + `.tfw` без `.prj` → «Готово», предупреждение «по координатам … принята СК-42 6°,
   зона 5 (EPSG:28405)», слой у ул. Грицевца. Затем «Переместить» → потянуть рамку → «Сдвиг вручную …» в карточке.
   Для плана: «План → GeoTIFF» → результат → «Переместить» у листа → скачать ZIP листа: `.tfw` с новыми C/F.

Новые необязательные переменные — `GEOREF_REGION_BBOX`, `GEOREF_SHIFT_TIMEOUT` (раздел 3, v19 — «План → GeoTIFF»).
**Откат:** вернуть файлы из копии, удалить `georef_shift.py`, перезапустить. Построчно —
`geoservice/changes_v20.2_to_v20.3.diff`; что изменилось — `CHANGELOG_RU.md`, раздел v20.3; тесты —
`tests/georef/test_georef_shift.py`, `run_shift_ui.js` (`tests/README_RU.md`, раздел 11).

## 0.00. Если v20.1 уже установлен — v20.2 («Смена СК»: перемещение растров): 1 файл + блок nginx

База данных, `.env` и Python-модули не меняются, новых пакетов не нужно.

1. Резервная копия `static/panel-crs.js` и `nginx.conf`.
2. В `static/` заменить **`panel-crs.js`**. Перезапуск приложения не нужен: версия статики (`?v=`) считается по дате
   изменения файлов, после обновления страницы (F5) браузеры возьмут новую панель.
3. В `nginx.conf` добавить блок **`location ^~ /api/crs-shift/`** — он в пакетном `nginx.conf` сразу после блока
   `location ^~ /api/crs/` (поиск по «v20.2»). Затем `nginx -t` и `nginx -s reload`. Без него ZIP растра больше 100 МБ
   получит 413: панель сообщит «архив больше лимита сервера», сдвиг останется только в браузере.
4. Серверный **`crs_shift.py`** (в пакет не передавался) должен принимать в ZIP не только SHP, но и
   `.tif/.tiff/.tfw/.tfwx/.tifw/.wld/.prj/.aux.xml/.ovr/.xml/.txt`. Если в нём есть список разрешённых расширений
   или проверка наличия `.shp` — дополнить. Лимит FastAPI для этого пути — `UPLOAD_MAX_MB` (по умолчанию 4096 МБ).
5. Проверка: «Конвертер СК» → «Смена СК» → сконвертировать TIFF → «Переместить» → потянуть растр за рамку →
   сообщение «Новая привязка растра сохранена на сервере» → «Скачать сдвинутый»: в ZIP `<имя>_сдвиг.tif/.tfw/.tfwx/.prj`
   и `<имя>_сдвиг.txt` со сдвигом. После F5 растр на новом месте; «Исходная» возвращает привязку.

**Откат:** вернуть два файла из копии, `nginx -s reload`. Построчно — `geoservice/changes_v20.1_to_v20.2.diff`,
что изменилось — `CHANGELOG_RU.md`, раздел v20.2; тест — `tests/crs_shift/` (`tests/README_RU.md`, раздел 10).

## 0.0. Если v20 уже установлен — v20.1 (привязка планов): заменить 7 файлов

База данных, `.env` и `nginx.conf` не меняются, новых пакетов не нужно (текст PDF читают уже стоящие pypdfium2
или PyMuPDF; tesseract — по желанию: масштаб из штампа у сканов JPG/TIFF без текстового слоя).

1. Резервная копия заменяемых файлов.
2. Рядом с `app.py` заменить `georef_api.py`, `georef_runner.py`, `geocoder.py`.
3. В `static/` заменить `panel-georef.js` и `panel-crs.js` (в нём новая метка версии — браузеры не возьмут старую панель из кэша).
4. В `tools\georef\` (или `GEOREF_TOOLS_DIR`) заменить `georef_plans.py` и `README.md`.
5. Перезапустить приложение. Для охвата улицы нужен тот же доступ к Nominatim/Overpass, что и в v20
   (без Overpass охват берётся из ответа Nominatim).

Что изменилось — `CHANGELOG_RU.md`, раздел v20.1.

## 0. Если v19 уже установлен — скопировать только файлы v20

База данных и `nginx.conf` не меняются, новых Python-пакетов не нужно.

1. **Резервная копия:** `app.py`, `georef_api.py`, `georef_runner.py`, `templates/index.html`, `templates/messages.html`, папка `static/`.
2. Рядом с `app.py` положить новый **`geocoder.py`** (поиск адресов с исправлением опечаток; без него `app.py` запускается, но ищет по-старому).
3. В `tools\georef\` (или `GEOREF_TOOLS_DIR`) добавить **`mbtiles2tif.py`** — вкладка «MBTiles → TIFF» (пакеты numpy, pillow, rasterio уже стоят с v19).
4. В `static/` добавить **`forest3d-ground.js`**; заменить `view3d.js`, `forest3d-terrain.js`, `forest3d-trees.js`, `map-core.js`, `panel-crs.js`, `panel-georef.js`, `odz-v18.css`.
5. Папку **`static/forest3d/trees/`** заменить целиком (12 файлов, ~4 МБ): новые `trees_v20.json`, `trees_v20.bin`, `impostors_v20.webp`, `leaves_birch.webp`, `leaves_aspens.webp`; файлы `trees_v19.*`, `impostors_v19.webp`, `leaves_aspen.webp` больше не нужны.
6. Заменить `app.py`, `georef_api.py`, `georef_runner.py`, `templates/index.html`, `templates/messages.html`.
7. Кэш улиц для исправления опечаток: по умолчанию `data\geocoder_cache\` рядом с `geocoder.py` — дать учётной записи приложения право записи или указать в `.env` `GEOCODER_CACHE_DIR=D:\DZZ_geo\instance\geocoder_cache`.
8. Серверу нужен доступ к `nominatim.openstreetmap.org` и Overpass API (`overpass-api.de` и зеркала — `GEOCODER_OVERPASS`), при выходе через прокси — `HTTPS_PROXY` в `.env`.
9. Перезапустить приложение. По желанию — `tools/trees/` (генератор моделей v20, серверу не нужен) и `tests/geocoder/`.

Кэш браузеров чистить не нужно: у изменённых файлов `?v=v20`. Построчно — `geoservice/changes_v19_to_v20.diff`.

**Откат v20:** вернуть файлы и папку `static/forest3d/trees/` из копии → перезапуск. `geocoder.py`, `mbtiles2tif.py`, `forest3d-ground.js` и `data\geocoder_cache\` старая версия не использует — можно удалить.

## 0.1. Если установлен только v18 — сначала файлы v19 (ниже), затем раздел 0

В пакете v20 файлы v19 уже обновлены: в п. 6 ниже папку `forest3d/trees/` брать из пакета (она уже v20), п. 7 — `forest3d-terrain.js`, `panel-crs.js`, `view3d.js` из пакета.

1. **Резервная копия:** `app.py`, `security_hardening.py`, `nginx.conf`, папка `static/`, `templates/index.html`. Базу данных v19 не меняет (новых таблиц и колонок нет; слой MBTiles из конвертера добавляется в обычный список слоёв «MBTILES MINSK»).
2. Рядом с `app.py` положить новые модули: **`forest3d_dem.py`, `lesolidar_bridge.py`, `jobkit.py`, `georef_api.py`, `georef_runner.py`** — без них новый `app.py` не запустится.
3. Рядом с `app.py` положить папку **`tools/`**: `tools/georef/` (нужна вкладке «План → GeoTIFF/TFW → MBTiles»), `tools/trees/` (только чтобы пересобрать модели деревьев; серверу не нужна).
4. **ЛесоЛидар:** присланную программу скопировать **папкой целиком** (`LesoLidar.exe` + `_internal\`, а также `models\` и `tables\`, если есть) в `D:\DZZ_geo\tools\LesoLidar\` — или указать путь в `.env`: `LESOLIDAR_EXE=D:\...\LesoLidar.exe`.
5. Python-пакеты — в то же окружение, из которого запускается `app.py`:
   ```bat
   pip install -r tools\georef\requirements.txt
   pip install pypdfium2 pyproj
   ```
   (numpy, pillow, rasterio, shapely, opencv-python-headless, mapbox-vector-tile, pypdfium2 — PDF-планы, pyproj — CRS облаков LAS). Необязательно: **7-Zip** в `PATH` — архивы `.7z/.rar` в «Растр → MBTiles»; Tesseract (язык rus) + `pip install pytesseract` — чтение адреса со штампа плана.
6. В `static/` добавить: `forest3d-labels.js`, `forest3d-trees.js`, `forest_uav_types.js`, `lesolidar-web.js`, `panel-georef.js` и папку **`forest3d/trees/`** целиком (11 файлов: модели деревьев, кора, листва, импосторы).
7. В `static/` заменить: `forest3d-terrain.js`, `forest3d-vector-boundaries.js`, `forest_drone.js`, `panel-crs.js`, `view3d.js`. Файл `busel_model.js` (модель «Бусла») остаётся прежним — не удалять.
8. Заменить `templates/index.html`, `app.py`, `security_hardening.py`.
9. Заменить `nginx.conf` (новые `location` для `/api/lesolidar/`, `/api/forest3d/dem/`, `/api/georef/`, моделей деревьев; если в конфиге есть свои правки — перенести блоки с пометкой `[v19]`) → `nginx -t` → `nginx -s reload`.
10. Дать учётной записи приложения право записи в `D:\DZZ_geo\instance\` — там сами создадутся `dem_cache\` (кэш рельефа), `lesolidar\` (загруженные LAS и результаты), `georef\` (задания привязки).
11. Перезапустить приложение.
12. Проверить доступ сервера в интернет (раздел 6, п. 1). Если выход только через прокси — `HTTPS_PROXY` в `.env`; если интернета нет — свои данные рельефа (`FOREST3D_DEM_GEOTIFF` / `FOREST3D_DEM_DIR`).

Остальные переменные `.env` (раздел 3) необязательны — значения по умолчанию рабочие.
Кэш браузеров чистить не нужно: у изменённых файлов новые `?v=`.
Построчно — `geoservice/changes_v18_to_v19.diff`.

**Откат v19:** вернуть файлы из копии → `nginx -s reload` → перезапуск. Новые модули, `tools/` и папки `instance\dem_cache`, `instance\lesolidar`, `instance\georef` старая версия не использует — их можно удалить (в `instance\lesolidar` — загруженные LAS и результаты обработки; если нужны — сохранить). Слои, добавленные из конвертера в «MBTILES MINSK», — обычные слои MBTiles, остаются.

Если v18 не устанавливался — ставить весь пакет по разделам 1–2 (он накопительный: v16 + v17 + v18 + v19).

## 1. Состав поставки (`geoservice/`)

| Файл | Куда положить | Статус |
|---|---|---|
| `app.py` | папка приложения (рядом со старым `app.py`) | изменён (v16–v20) |
| `security_hardening.py` | **рядом с `app.py`** (без него `app.py` не запустится) | новый (v16), изменён (v19) |
| `static_assets.py` | **рядом с `app.py`** | новый (v18, сборка стилей) |
| `forest3d_dem.py` | **рядом с `app.py`** | новый (v19, рельеф 3D через сервер) |
| `lesolidar_bridge.py`, `jobkit.py` | **рядом с `app.py`** | новые (v19, ЛесоЛидар и очередь заданий); `jobkit.py` изменён (v20.3) |
| `georef_api.py`, `georef_runner.py` | **рядом с `app.py`** | новые (v19, «План → GeoTIFF/TFW → MBTiles»), изменены (v20: MBTiles → TIFF, поиск адреса; v20.3: СК «по координатам», сдвиг) |
| `georef_shift.py` | **рядом с `app.py`** (без него не загрузится `georef_api.py`) | новый (v20.3, «Переместить» результат привязки и MBTiles) |
| `geocoder.py` | **рядом с `app.py`** | новый (v20, поиск адресов с исправлением опечаток) |
| `tools/georef/` — `georef_plans.py`, `tif2mbtiles.py`, `mbtiles2tif.py`, `requirements.txt`, `README.md` | `D:\DZZ_geo\tools\georef\` (или `GEOREF_TOOLS_DIR`) | новые (v19; `mbtiles2tif.py` — v20); `tif2mbtiles.py` изменён (v20.3) |
| `tools/trees/` — генератор моделей деревьев (Python или Node + ez-tree) | `tools\trees\` — по желанию | новые (v19), изменены (v20; на сервере не нужны) |
| `nginx.conf` | `C:\nginx\conf\` | изменён (v16, v18, v19) |
| `security_headers.conf` | `C:\nginx\conf\` (рядом с `nginx.conf`, подключается через `include`) | новый (v16) |
| `static/view3d.js`, `forest3d-terrain.js`, `forest3d-vector-boundaries.js`, `forest_drone.js` | `static/` | 3D: исправления (v16), изменены (v19; `view3d.js`, `forest3d-terrain.js` — и v20) |
| `static/forest3d-ground.js` | `static/` | новый (v20, почвенный покров и микрорельеф) |
| `static/forest3d-map-layers.js` | `static/` | 3D: исправления (v16) |
| `static/forest3d-labels.js`, `forest3d-trees.js`, `forest_uav_types.js`, `lesolidar-web.js` | `static/` | новые (v19: подписи, деревья, типы БПЛА, ЛесоЛидар; `forest3d-trees.js` изменён в v20) |
| `static/forest3d/trees/` (12 файлов, ~4 МБ) | `static/forest3d/trees/` (папка целиком) | новая (v19), заменена (v20: 18 моделей) |
| `static/panel-crs.js`, `static/panel-georef.js` | `static/` | изменён / новый (v19, конвертер СК), изменены (v20); `panel-crs.js` — v20.2, `panel-georef.js` — v20.3 |
| `static/design-system-v16.css` | `static/` | новый (v16) |
| `static/design-system-v17.css`, `ui-v17.js`, `icons-tabler.css`, `icons-tabler.js`, `LICENSE-Tabler.txt` | `static/` | новые (v17) |
| `static/fonts/` — `inter-400/500/600/700.woff2`, `LICENSE-Inter.txt` | `static/fonts/` (папка целиком) | новая (v17, шрифт Inter) |
| `static/map-icon-style.js`, `map-core.js`, `panel-layers.js`, `panel-print.js`, `tool-panels-ui.js`, `ui-custom.css`, `ui-enhance.js`, `ui-prefs.js` | `static/` | дизайн/раскладка (v16 + v17; `map-core.js`, `panel-layers.js` — и v18) |
| `static/design-system-v18.css`, `index-head.css`, `index-sidebar.css`, `perf-v18.js` | `static/` | новые (v18, скорость) |
| `static/odz-staff.js`, `odz-v18.css` | `static/` | новые (v18, сотрудники ОДЗиМЛ, окна, ЭЦП) |
| `static/profile-v18.js`, `profile-v18.css`, `static/frames/*.svg` (11) | `static/`, `static/frames/` | новые (v18, профиль) |
| `static/manuals-v18.js`, `manuals-v18.css` | `static/` | новые (v18, методички) |
| `static/admin_guard.js`, `calendar.css`, `calendar.js`, `header-scene.js`, `manuals-workspace.js`, `messages.js`, `vacancy.js` | `static/` | изменены (v18) |
| `templates/*.html` (9 шт.) | `templates/` | v16/v17; `index.html` — v16–v20, `manuals.html` — ещё и v18, `messages.html` — v18 и v20 |

`changes.diff` — полный построчный diff относительно присланных файлов (v16–v19), `changes_v17_to_v18.diff` — только v18, `changes_v18_to_v19.diff` — только v19, `changes_v19_to_v20.diff` — только v20 (для ревью).
Программа **LesoLidar.exe в поставку не входит** — используется присланная вами (см. раздел 0, п. 4).

## 2. Порядок установки (полный пакет)

1. **Резервная копия:** `app.py`, `nginx.conf`, папки `static/` и `templates/`, база данных.
2. Скопировать файлы из `geoservice/` поверх (таблица выше). В `static/` и `templates/` заменяются только перечисленные файлы — остальные (в т.ч. `static/avatars/`, `busel_model.js`) не трогать.
3. Положить ЛесоЛидар в `tools\LesoLidar\` (раздел 0, п. 4) и установить Python-пакеты (раздел 0, п. 5).
4. Права записи для учётной записи приложения: `static/_b/` (v18, общий файл стилей) и `instance\` (v19: `dem_cache`, `lesolidar`, `georef`).
5. Дописать в `.env` новые переменные (раздел 3). Минимум (v16): `GEOSERVER_PASSWORD`, `WFS_T_TOKEN` (или `WFS_T_USER`/`WFS_T_PASSWORD`), `ARCGIS_WEBHOOK_SECRET`.
6. nginx:
   ```bat
   cd C:\nginx
   nginx -t            :: должно быть "syntax is ok" / "test is successful"
   nginx -s reload
   ```
7. Перезапустить приложение (как обычно: `python app.py` — слушает `127.0.0.1:5000`, 4 воркера).
   Рекомендуется запуск с `--no-server-header`, чтобы не раскрывать `server: uvicorn`:
   `uvicorn app:app --host 127.0.0.1 --port 5000 --workers 4 --no-server-header`
   Очередь заданий ЛесоЛидара и привязки общая для всех воркеров: задания выполняет один из них (блокировка через файл в `instance\`), остальные только принимают и показывают.
8. При старте приложение само создаст таблицы v18 (`pg_odziml_staff`, `pg_print_queue_meta`, `pg_user_profiles`), добавит колонки в `pg_vacations` и `pg_ecp_signatures` и перенесёт прежний список из 6 сотрудников в справочник (один раз). Ошибки миграции — в логе с пометкой `[v18]`. v19 базу не меняет.
9. Кэш браузеров чистить не нужно.

**Откат:** вернуть файлы из резервной копии → `nginx -s reload` → перезапуск приложения. Новые переменные `.env`, таблицы, колонки и папки `instance\…` можно оставить — старая версия их игнорирует.

## 3. Переменные окружения (`.env`)

### v20 — поиск адресов (`geocoder.py`) и MBTiles → TIFF

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `GEOCODER_NOMINATIM` | `https://nominatim.openstreetmap.org` | Свой Nominatim (тогда нет ограничения 1 запрос/с у OSM). |
| `GEOCODER_OVERPASS` | `overpass-api.de`, `maps.mail.ru`, `overpass.private.coffee` | Overpass API для списка улиц (через запятую, по порядку). |
| `GEOCODER_CACHE_DIR` | `data/geocoder_cache` рядом с `geocoder.py` | Кэш списков улиц и границ населённых пунктов (30 дней). |
| `GEOCODER_DEFAULT_CITY` | `Минск` | Город, если он не указан в адресе и не определился по центру карты. |
| `GEOCODER_BUDGET_S` | `11` | Предел времени поиска с исправлением, с. |
| `GEOCODER_PARALLEL` | `2` | Сколько поисков с исправлением одновременно (остальные — обычный поиск). |
| `GEOCODER_WARM` | `1` | `0` — не подгружать список улиц города по умолчанию при старте. |
| `GEOCODER_UA` | `ODZiML-Geoportal/1.2 …` | User-Agent запросов к OSM (правила OSM требуют осмысленный). |
| `GEOCODER_OFF` | — | `1` — без исправлений (как в v19). |
| `GEOREF_MB2TIF_MAX_MP` | `400` | Предел размера GeoTIFF из MBTiles, Мпикс (больше — берётся уровень мельче). |

### v19 — рельеф 3D (`forest3d_dem.py`)
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `FOREST3D_DEM_GEOTIFF` | — | Свои ЦМР в GeoTIFF через `;` (любая СК, например лидарная ЦМР из ЛесоЛидара, SRTM, Copernicus). Имеют приоритет над интернетом. |
| `FOREST3D_DEM_DIR` | — | Своя папка готовых тайлов Terrarium `{z}/{x}/{y}.png` (офлайн). Проверяется первой. |
| `FOREST3D_DEM_UPSTREAMS` | `terrarium:https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Внешние источники через `;`, префикс `terrarium:` или `mapbox:` (кодировка высот). |
| `FOREST3D_DEM_OFFLINE` | `0` | `1` — не ходить в интернет, только свои тайлы/GeoTIFF и кэш. |
| `FOREST3D_DEM_CACHE` | `instance/dem_cache` | Дисковый кэш тайлов (скачанное и построенное больше не запрашивается). |
| `FOREST3D_DEM_MAX_Z` | `15` | Наибольший уровень тайлов высот. |
| `FOREST3D_DEM_TIMEOUT` / `FOREST3D_DEM_PARALLEL` | `10` с / `6` | Таймаут запроса к внешнему источнику и число одновременных загрузок. |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | Стандартный прокси для выхода сервера в интернет (рельеф, привязка планов). |

### v19 — ЛесоЛидар (`lesolidar_bridge.py`)
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `LESOLIDAR_EXE` | ищется `tools\LesoLidar\LesoLidar.exe` (и `tools\LesoLidar\LesoLidar\…`, `tools\LesoLidar*\…`), `LesoLidar\LesoLidar.exe`, `tools\LesoLidar.exe` — рядом с `app.py` и уровнем выше | Полный путь к `LesoLidar.exe` или к его папке (рядом должна быть папка `_internal`). С v20.10 `.env` перечитывается по кнопке «Проверить снова» — перезапуск не нужен. Пошагово — раздел «ЛесоЛидар» в начале файла. |
| `LESOLIDAR_PYTHON` / `LESOLIDAR_PATH` | — | Только для Linux/стенда: Python и папка пакета `lesolidar` вместо `.exe`. |
| `LESOLIDAR_WORKDIR` | `instance/lesolidar` | Загруженные LAS/LAZ, задания, результаты. Нужен диск с запасом (LAS — десятки ГБ). |
| `LESOLIDAR_MAX_UPLOAD_GB` | `20` | Предельный размер одного LAS/LAZ. |
| `LESOLIDAR_MAX_JOBS` | `1` | Сколько обработок одновременно (каждая грузит CPU и память). |
| `LESOLIDAR_TIMEOUT_MIN` | `360` | Предел времени одной обработки, затем она снимается вместе с дочерними процессами. |
| `LESOLIDAR_KEEP_JOBS` | `200` | Сколько последних заданий хранить (старые удаляются с результатами). |

### v19 — «План → GeoTIFF/TFW → MBTiles» (`georef_api.py`, `georef_runner.py`)
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GEOREF_ENABLED` | `1` | `0` — вкладка видна только администратору. |
| `GEOREF_TOOLS_DIR` | `tools/georef` | Где лежат `georef_plans.py` и `tif2mbtiles.py`. |
| `GEOREF_PYTHON` | Python приложения | Другой Python для заданий (если пакеты стоят в отдельном окружении). |
| `GEOREF_WORKDIR` | `instance/georef` | Задания, загруженные сканы, результаты. |
| `GEOREF_CACHE_DIR` | `<GEOREF_WORKDIR>/cache` | Кэш контуров зданий и ортофото (повторная привязка того же места — без интернета). |
| `GEOREF_CACHE_DAYS` | `30` | Срок хранения кэша. |
| `GEOREF_MAX_UPLOAD_MB` / `GEOREF_MAX_FILES` | `1024` / `60` | Предел загрузки за одно задание и число файлов. |
| `GEOREF_MAX_SHEETS` | `12` | Сколько страниц PDF / листов обрабатывать в одном задании. |
| `GEOREF_PDF_MAX_MP` | `150` | Предел размера растра при чтении PDF (мегапикселей). |
| `GEOREF_MAX_JOBS` / `GEOREF_MAX_QUEUE` | `1` / `12` | Одновременно выполняемых заданий / мест в очереди. |
| `GEOREF_TIMEOUT_MIN` | `60` | Предел времени одного задания. |
| `GEOREF_KEEP_HOURS` / `GEOREF_KEEP_JOBS` | `48` / `300` | Сколько хранить историю и результаты. |
| `GEOREF_THREADS` | `12` (привязка), `8` (нарезка) | Потоки нарезки тайлов. На слабом сервере — уменьшить. |
| `GEOREF_REGION_BBOX` | `23,51.1,33,56.4` | [v20.3] Регион для выбора СК растра без `.prj` «по координатам» (мин. долгота, мин. широта, макс. долгота, макс. широта); `off` — без проверки (тогда нужна явная СК). |
| `GEOREF_SHIFT_TIMEOUT` | `900` | [v20.3] Предел времени «Переместить» (нарезка MBTiles заново), с. Не больше `proxy_read_timeout` блока `/api/georef/` в nginx (900 с). |

### v16–v18
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ODZ_EDITORS` (v18) | `admin` | Кто меняет отметки «Календаря ОДЗиМЛ» и справочник сотрудников: `admin` — только администратор; `odziml` — ещё и сотрудники ОДЗиМЛ (каждая правка подписывается). |
| `ECP_LOCK_MONTHS` (v18) | `6` | На сколько месяцев блокируется утверждённая ЭЦП (1–36). Досрочно снять — администратор. |
| `GEOSERVER_USER` / `GEOSERVER_PASSWORD` | `admin` / *стандартный пароль GeoServer + предупреждение в логе* | Раньше пароль был зашит в код. **Смените пароль admin в GeoServer и задайте его здесь.** |
| `GEOSERVER_VERIFY_TLS` | `1` | Проверка сертификата GeoServer (`0` — только для самоподписанного). |
| `DATABASE_URL` | собирается из `DB_*` | Необязательно. Пароль БД экранируется (символы `@ : / #` не ломают подключение). |
| `WFS_T_ENABLED` | `1` | `0` — полностью запретить WFS-транзакции. |
| `WFS_T_TOKEN` | — | Токен для QGIS/ArcGIS: заголовок `X-WFS-Token` или `?token=`. |
| `WFS_T_USER` / `WFS_T_PASSWORD` | — | Альтернатива токену: HTTP Basic в настройках подключения WFS. |
| `VECTOR_EDIT_TOKEN` | — | Правка векторных слоёв не из-под администратора: заголовок `X-Edit-Token`. |
| `ARCGIS_WEBHOOK_SECRET` | — | Секрет вебхука `/api/sync/webhook` (`X-Webhook-Secret` или `?secret=`). Если не задан — вебхук принимается, но тело очищается. |
| `DOWNLOAD_ZIP_PUBLIC` | `0` | `1` — вернуть скачивание `/download_zip` без входа. |
| `ZIP_BUILD_CONCURRENCY` | `3` | Сколько ZIP-архивов собирается одновременно (защита CPU/диска). |
| `SSE_MAX_SUBSCRIBERS` | `300` | Предел одновременных SSE-подписок. |
| `UPLOAD_MAX_MB` | `4096` | Предел тела для загрузок (`/upload`, руководства, CRS-сдвиг). Куски LAS и сканы планов имеют свои пределы (раздел 4). |
| `BODY_MAX_DEFAULT_MB` | `2` | Предел тела для остальных запросов. |
| `MULTIPART_DEFAULT_MB` | `100` | Предел для multipart-форм без отдельного правила. |
| `MAX_URL_LENGTH` / `MAX_QUERY_LENGTH` | `8192` / `16384` | Длина пути / строки запроса. |
| `RATE_LIMIT_ENABLED` | `1` | Ограничение частоты (вход, step-up, токены, загрузки, ZIP, WFS-T, v19 — запуск обработки LAS и привязки). |
| `RATE_LIMIT_EXEMPT_IPS` | — | IP через запятую без ограничений (`PROTECTED_IPS` освобождены всегда). |
| `ALLOWED_ORIGINS` | список в `app.py` | Доп. сайты, которым разрешены изменяющие запросы (свой сайт разрешён всегда). |
| `ALLOWED_HOSTS` | — (проверка выключена) | Например `192.168.12.97,192.168.12.109,localhost` — отсечь чужой `Host`. |
| `SESSION_HTTPS_ONLY` | `1` | Cookie сессии только по HTTPS. `0` — только если портал открывают по HTTP. |

Доверенный прокси для `X-Real-IP`/`X-Forwarded-For` — только `127.0.0.1`/`::1` (nginx на той же машине).
Лимиты частоты в приложении считаются в каждом воркере отдельно; глобально частоту режет nginx (`limit_req`).

## 4. Что изменится для пользователей и интеграций

**v20**
- **Поиск адресов** (поиск на карте и «План → GeoTIFF»): исправляет опечатки в названии улицы, понимает город без «г.», при отсутствии дома показывает центр улицы с пометкой. Ответ `/api/geocode` — прежний формат Nominatim + поля `_corrected {from,to}` и `_approx`; поиск с исправлением — до ~11 с.
- **3D:** 18 моделей деревьев (первое открытие скачивает ~2,9 МБ, gzip ~1,6 МБ), почвенный покров и микрорельеф (переключатели в карточке «Вид»).
- **Конвертер СК:** новая вкладка «MBTiles → TIFF» (GeoTIFF + TFW/TFWX + PRJ, ZIP). Права — как у «Растр → MBTiles».
- **Панель привязки и отчёт очереди печати** — тёплые цвета текста.

**v19**
- **3D, рельеф:** браузер больше не обращается к внешним сайтам за высотами — тайлы идут через `/api/forest3d/dem/…` (права — как у 3D-режима). Ошибка «ЦМР не загружена… Failed to fetch» уходит; если источник недоступен — честная надпись «нет данных высот» и кнопка повтора, условный рельеф не подставляется.
- **3D, подписи:** номера кварталов и выделов закреплены на местности, не дрожат и не подменяются при вращении и приближении.
- **3D, деревья:** модели сосны, ели, берёзы, осины, дуба вместо конусов. Первое открытие 3D скачивает ~1,8 МБ моделей (дальше — из кэша). На слабых компьютерах автоматически меньше детальных деревьев; переключатель «реалистичные / простые».
- **Режим БПЛА** (бывший «Бусел»): выбор из 6 типов, приборы, миссия «змейкой», автопилот, геймпад, справка по клавишам. Выход — Esc, 3D-сцена остаётся открытой.
- **ЛесоЛидар:** блок «Обработка LAS» в окне выбора 3D. Смотреть результаты — всем, у кого есть 3D; **загружать LAS, запускать и удалять — только администратору**. Загрузка идёт кусками по 32 МиБ с докачкой — большие файлы не упираются в лимиты nginx.
- **Конвертер СК:** новые вкладки «План → GeoTIFF/TFW → MBTiles» и «Растр → MBTiles». Каждый видит только свои задания, администратор — все и может добавить результат в слои карты.
- **Пределы запросов:** куски LAS — до 40 МБ, файлы границ — до 26 МБ, сканы/PDF — до `GEOREF_MAX_UPLOAD_MB` (1 ГБ); слишком частый запуск обработки → `429`.

**v18**
- **ЭЦП («Таксаторы печать»):** новая подпись сначала сохраняется черновиком, затем «Утвердить» — и она закреплена на 6 месяцев. В очередь можно ставить только с утверждённой подписью (проверяет сервер).
- **Сотрудники ОДЗиМЛ:** список в «Заявлении за свой счёт» и календаре общий и хранится на сервере; правит администратор (или отдел — `ODZ_EDITORS=odziml`).
- **Календарь:** кроме отпусков — больничные, командировки и «за свой счёт».
- **Профиль:** пользователи сами задают фото, рамку, должность, телефон, «о себе», статус и приватность.
- **`/api/users/online`:** без входа/регистрации → `403`.

**v16–v17**
- **QGIS/ArcGIS (WFS-T):** правка слоёв без токена/логина → `401`. Нужно прописать `WFS_T_TOKEN` или Basic-логин в подключении.
- **Правка векторных слоёв:** только администратор (сессия + доп. пароль) или `X-Edit-Token`.
- **`/download_zip`:** только после входа (`DOWNLOAD_ZIP_PUBLIC=1` — как раньше).
- **Изменяющие запросы с чужих сайтов** (POST/PUT/DELETE с чужим `Origin`) → `403`. Если есть внешний фронтенд — добавить его в `ALLOWED_ORIGINS`.
- **Подбор пароля:** после серии неудачных входов IP временно блокируется (≈15 минут).
- **Слишком большие запросы** → `413`, слишком частые → `429` с `Retry-After`.

## 5. Проверка после установки

**v20 — в браузере под администратором:**

| Адрес | Что должно быть |
|---|---|
| `https://192.168.12.97/api/geocode?q=ул.%20Долгобротская%2038` | результат «38, Долгобродская улица…» и `"_corrected": {"to": "Долгобродская улица"}` (первый раз — до ~11 с) |
| `https://192.168.12.97/api/georef/caps` | `"mb2tif": true` |

Визуально (v20): 3D — земля с пятнами подстилки, мха, травы и песка (не ровно-зелёная), под кронами темнее, деревья с густыми кронами, в карточке «Вид» — «Почвенный покров» и «Микрорельеф»; «Конвертер СК» → «MBTiles → TIFF». Без сети: `python tests\geocoder\test_geocoder.py` → `ALL OK` (с `set GEOCODER_ONLINE=1` — ещё и поиск через OSM).

**v19 — в браузере под администратором** (JSON открывается прямо во вкладке):

| Адрес | Что должно быть |
|---|---|
| `https://192.168.12.97/api/forest3d/dem/status` | список источников (свои GeoTIFF/тайлы, AWS) и счётчики кэша; после открытия 3D растут `served` / `cache_hits` |
| `https://192.168.12.97/api/lesolidar/caps` | `"available": true`, `"engine": "exe"`, `"problems": []`, в `models` — модели из папки программы |
| `https://192.168.12.97/api/georef/caps` | `"georef": true`, `"mbtiles": true`, `"pdf": true`, `"problems": []` (иначе в `problems` — каких пакетов не хватает) |

Визуально (v19): открыть 3D по лесхозу — рельеф с отмывкой и горизонталями, подпись «Реальная ЦМР … тайлов z13/z14», деревья-модели, номера кварталов не дрожат при вращении; кнопка режима БПЛА → выбор типа и «Запуск»; вверху окна выбора 3D — блок «Обработка LAS» → «Демо-участок» (проверка всей цепочки ЛесоЛидара за 1–2 минуты); «Конвертер СК» → вкладка «План → GeoTIFF/TFW → MBTiles».

Тесты v19 можно запустить прямо на сервере (без браузера, ничего не меняют на портале; нужен `pip install httpx`):
```bat
set GEO_DIR=D:\DZZ_geo
python tests\dem\test_dem_api.py              :: рельеф: тайлы, кэш, NaN, ошибки → EXIT 0
python tests\lesolidar\test_lesolidar_api.py  :: ЛесоЛидар: загрузка кусками, демо, задание, результаты → ALL OK
python tests\georef\test_georef_api.py        :: план PDF → GeoTIFF/TFW → MBTiles (нужен интернет) → ALL OK
```

v16–v18:
```bash
# 1) заголовки безопасности и скрытие служебных файлов
curl -skI https://192.168.12.97/ | grep -iE "strict-transport|content-security|x-frame|x-content-type"
curl -sk -o /dev/null -w "%{http_code}\n" "https://192.168.12.97/static/..%2fapp.py"        # 400/403/404
curl -sk -o /dev/null -w "%{http_code}\n" "https://192.168.12.97/static/copies%20(no%20read)/" # 403/404

# 2) v18: фото профиля отдаются только как картинки; стили главной — одним файлом
curl -sk -o /dev/null -w "%{http_code}\n" "https://192.168.12.97/static/avatars/..%2f..%2fapp.py"  # 400/404
curl -sk -o /dev/null -w "%{http_code}\n" "https://192.168.12.97/static/frames/pine.svg?v=18.1"    # 200

# 3) атаки в безопасном режиме (только чтение, ничего не меняет) — ожидается 0 FAIL
python3 tests/security/attack_suite.py --base https://192.168.12.97 --insecure --report after_deploy.html

# 4) раскладка и читаемость (нужен Playwright/Chromium) — ожидается 68 PASS / 0 FAIL
ADMIN_USER=admin ADMIN_PASS='***' STEPUP_PASS='***' \
  node tests/ui/ui_layout_test.js https://192.168.12.97 out after
```
Тесты v18 (`tests/ui/v18_*`) создают и удаляют данные — запускайте их **на стенде**, см. `tests/README_RU.md`.
Счётчик отсечённых атак с момента запуска: `GET /api/admin/security/stats` (под администратором).

## 6. Сделать вручную (вне кода)

1. **Доступ сервера в интернет (v19)** — разрешить в межсетевом экране (или через `HTTPS_PROXY`):
   рельеф — `s3.amazonaws.com` (если нет своей ЦМР); привязка планов — `map.nca.by` (контуры зданий и ортофото НКА), `services.arcgisonline.com` (ортофото Esri), `overpass-api.de` / `overpass.kumi.systems` (контуры OSM), `nominatim.openstreetmap.org` (поиск адреса). Браузерам пользователей внешний доступ не нужен.
2. **Своя ЦМР (рекомендуется):** указать в `FOREST3D_DEM_GEOTIFF` лидарную ЦМР (ЛесоЛидар выдаёт `DTM` GeoTIFF по каждому участку) или общую ЦМР региона — рельеф будет точнее открытых SRTM и не будет зависеть от интернета.
3. **Место на диске** для `instance\lesolidar` — LAS по десятку ГБ плюс результаты; старые задания удаляются автоматически (`LESOLIDAR_KEEP_JOBS`), исходники — кнопкой «Удалить» в списке файлов.
4. Решить, кто правит календарь и справочник сотрудников: только администратор (по умолчанию) или весь отдел (`ODZ_EDITORS=odziml`).
5. Удалить из веб-доступа `static/copies (no read)/` и `templates/Test/` (заблокированы в nginx и приложении, но файлам там не место).
6. Сменить стандартный пароль admin в GeoServer → `GEOSERVER_PASSWORD`.
7. Прокси belgosles: `proxy_ssl_verify off` — заменить на проверку доверенного сертификата.
8. Задать `ARCGIS_WEBHOOK_SECRET` и прописать его в ArcGIS.
9. Не переданы и проверялись только через заглушки: `forest3d_api.py`, `forest3d_access.py`, `forest3d_las.py`, `geo_guard.py`, `admin_stepup.py`, `ip_identity.py`, `crs_converter.py`, `crs_shift.py`, `season_api.py`, `manuals_api.py`, `design_theme_api.py`. Их стоит прислать на такой же аудит.
