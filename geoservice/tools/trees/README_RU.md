# Генератор моделей деревьев для 3D (v20)

Готовые файлы уже лежат в `static/forest3d/trees/` — запускать генератор нужно только
для изменения моделей (порода, густота, число треугольников).

Состав результата:

| Файл | Что это |
|---|---|
| `trees_v20.json` | описание **18 моделей** (по 3 варианта: сосна, ель, берёза, осина, дуб, прочие лиственные): порода, размеры кроны и ствола, смещения в .bin, ячейки атласа |
| `trees_v20.bin` | геометрия (int16-позиции, int8-нормали, int16-UV, uint16-индексы), ~2,9 МБ (gzip ~1,6 МБ); 4,8–7,7 тыс. треугольников на модель |
| `impostors_v20.webp` | атлас импосторов 6×3 (вид сбоку 256×512 + вид сверху 256×256 на модель), отрисован теми же материалами |
| `bark_*.jpg`, `leaves_*.webp` | кора (512 px) и листва/хвоя (512 px, альфа): `pine`, `birch`, `aspens`, `oak`, `ash` |

## Как перегенерировать

1. Нужны: Python 3.9+ с `playwright` (`pip install playwright numpy`) **или** Node 18+ с npm-пакетом
   `playwright`; Chromium; npm-пакет `@dgreenheck/ez-tree@1.1.0` (MIT); three.js r160
   (`static/vendor/three/three.module.min.js`). `gen.py` и `gen.js` равноценны — дают одинаковые файлы.
2. Подготовить папку-сервер (пример — Linux):
   ```bash
   mkdir gen && cd gen
   ln -s <путь>/ez-tree/build ez               # ez-tree.es.js
   cp -r <путь>/ez-tree/src/lib/assets assets   # bark/*.jpg, leaves/*.png (копия — добавим 2 текстуры)
   ln -s <путь>/static/vendor/three three
   cp <путь>/tools/trees/{gen.html,gen_page.js,gen.py,gen.js,species.json} .
   # листва берёзы и осины — из листвы осины ez-tree (яркость, насыщенность, оттенок):
   magick assets/leaves/aspen_color.png -modulate 80,80,124 assets/leaves/birch_color.png
   magick assets/leaves/aspen_color.png -modulate 74,78,131 assets/leaves/aspens_color.png
   python3 -m http.server 8830 &
   python3 gen.py ./out        # или: node gen.js ./out
   # → out/trees_v20.json, trees_v20.bin, impostors_v20.webp (+ .png), preview.png
   ```
   Переменные: `TREES_VER` (суффикс имён, по умолчанию `v20`), `SPECIES` (другой species.json),
   `COLS` (столбцов в атласе, 6), `CHROMIUM_PATH`, `GEN_URL` (адрес gen.html).
3. Скопировать `out/trees_v20.*` и `out/impostors_v20.webp` в `static/forest3d/trees/`;
   текстуры уменьшить до 512 px (ImageMagick):
   ```bash
   for b in pine birch oak willow; do magick assets/bark/${b}_color_1k.jpg -resize 512x512 -strip -quality 82 bark_${b}.jpg; done
   for l in pine birch aspens oak ash; do magick assets/leaves/${l}_color.png -resize 512x512 -strip -quality 86 leaves_${l}.webp; done
   ```
4. Если менялся состав или формат — поднять `TREES_VER` и `VER` в `static/forest3d-trees.js` (имена файлов
   строятся из него), старые `trees_v19.*`, `impostors_v19.webp`, `leaves_aspen.webp` больше не нужны.

`species.json` — список моделей: `key`, `species` (порода: pine, spruce, birch, aspen, oak, decid — по ней
3D выбирает модель), `preset` (пресет ez-tree), `seeds`, кора/листва и оттенки, `over` — параметры поверх пресета
(уровни и число ветвей, углы, длины, листья). `probe.js` быстро печатает число треугольников для вариантов.
Бюджет: ≤ ~8 тыс. треугольников на модель (полных моделей — до 380 в радиусе 220 м, на телефоне до 170 в радиусе 150 м).

## Лицензии

* ez-tree 1.1.0 — MIT, © 2024 Daniel Greenheck (генератор и текстуры листвы/хвои; `leaves_birch`,
  `leaves_aspens` — перекрашенная листва осины из того же пакета).
* Текстуры коры — CC0: Poly Haven (bark_brown_02, bark_willow_02), TextureCan (birch, pine) —
  источники перечислены в `assets/bark/README.md` пакета ez-tree.
