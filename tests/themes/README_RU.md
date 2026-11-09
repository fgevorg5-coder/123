# tests/themes — v20.9: «Оформление» (10 стилей), «Страж контраста», единый аватар

| Файл | Что это |
|---|---|
| `v20_9_ui_test.js` | UI-тест (Playwright + Chromium) на стенде с настоящим `app.py`: аватар (фото, рамка, эмодзи; смена рамки в «Сообщениях» → главная во второй вкладке без перезагрузки; гость), 11 вариантов вида × (главная, меню профиля с наведением, кнопки и панель карты, «Сообщения», окно заявления; контраст до/после стража; ошибки JS), сохранение и синхронизация вкладок, `?gt=`, окно «Оформление» (мышь, Escape, Alt+Shift+T, стрелки, «Страж контраста») |
| `make_v20_9_report.py` | `reports/v20.9_report.md` + обзорные листы `reports/v20.9_shots/sheet_*.jpg` из `reports/v20.9_ui_report.json` |
| `pw_stand.js` | общие функции стенда: офлайн-копии ol.js/ol.css/proj4.js (`STAND_FE`), заглушки тайлов (`tiles/`), пользователь по `X-Real-IP` |
| `stand_emul.css`, `stand_menu.js`, `stand_vacancy.css` | **только стенд**: в нём нет `style.css`/`design-system-v15`/`sidebar_profile_menu.js`/`vacancy.css` прода — эти файлы эмулируют раскладку, меню профиля и скрытое окно заявления |
| `src/` | исходники тем: `themes_def.py` (10 палитр и параметры), `gen_themes.py` (сборка `static/themes/*`), `check_themes.py` + `contrast.py` (контраст 43 пар × 10 тем по WCAG), `gt-core.src.css`, `gt.src.js`, `gt-boot.src.js` |

## Запуск
```bash
# стенд: настоящий app.py без PostgreSQL/GDAL (tests/security/stand), static и templates — из этой версии
python3 tests/security/stand/run_stand.py <папка приложения> 8810
# тест (нужны playwright и chromium; ME_IP — пользователь с профилем в «Сообщениях», GUEST_IP — без профиля)
CHROME=$(which chromium) BASE=http://127.0.0.1:8810 STAND_FE=<папка с ol.js, ol.css, proj4.js> \
  ME_IP=192.168.12.51 GUEST_IP=192.168.12.97 node tests/themes/v20_9_ui_test.js      # PARTS=2,4 — только часть
python3 tests/themes/make_v20_9_report.py
```
Тест меняет рамку профиля `ME_IP` и возвращает прежнюю — запускайте на стенде, не на рабочем портале.
Код выхода 0 — все проверки пройдены.

## Правка тем
Цвета, шрифты и размеры — в `src/themes_def.py`, общие правила — в `src/gt-core.src.css`, логика окна и стража — в `src/gt.src.js`.
Затем:
```bash
python3 tests/themes/src/check_themes.py          # «нарушений: 0» — палитры проходят WCAG
python3 tests/themes/src/gen_themes.py geoservice/static/themes
```
Файлы `static/themes/gt-*.css`, `gt.js`, `gt-boot.js` создаются генератором — руками их не правьте.
Шрифты `static/themes/fonts/*.woff2` (Golos Text, IBM Plex Sans/Mono, Roboto, Source Sans 3, Fira Sans, PT Sans, Onest, Manrope,
Open Sans, JetBrains Mono; кириллица + латиница) — лицензия SIL OFL 1.1 (`fonts/OFL.txt`); Inter («Белая карта») — уже
имеющийся `static/fonts/inter-*.woff2`.

## Консоль браузера (F12)
* `GeoTheme.list()` — темы; `GeoTheme.get()` — текущая; `GeoTheme.set('navy')` / `GeoTheme.set('classic')`.
* `GeoTheme.open()` — окно «Оформление» (или Alt+Shift+T).
* `GeoTheme.audit()` — места с недостаточным контрастом на странице (после стража должно быть 0).
* `GeoTheme.guard.enable(false)` — выключить «Страж контраста» (во всех вкладках этого браузера).
* `GeoAvatar.get()` — аватар из профиля «Сообщений»; `GeoAvatar.refresh()` — перечитать с сервера.
