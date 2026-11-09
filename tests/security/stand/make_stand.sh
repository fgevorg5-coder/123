#!/bin/bash
# Создать каталог стенда с НАСТОЯЩИМ app.py:  ./make_stand.sh <каталог_геосервиса> <каталог_стенда>
#   ./make_stand.sh /path/to/new/geoservice stand_fixed  # новая версия (полная папка проекта)
#   ./make_stand.sh /path/to/old/geoservice stand_orig   # исходная версия (для «до»)
# Запуск:  python3 run_stand.py stand_fixed 8812   (HTTP, без nginx)
set -e
SRC=$(cd "$1" && pwd); DST=$2
mkdir -p "$DST"
cp "$SRC/app.py" "$DST/"
[ -f "$SRC/security_hardening.py" ] && cp "$SRC/security_hardening.py" "$DST/"
[ -f "$SRC/static_assets.py" ] && cp "$SRC/static_assets.py" "$DST/"      # v18: сборка CSS-бандлов (static/_b)
for m in forest3d_dem.py lesolidar_bridge.py jobkit.py georef_api.py georef_runner.py georef_shift.py preview_page.py manuals_editor_api.py; do   # v19: рельеф, ЛесоЛидар, привязка планов; v20.3 — сдвиг; v20.4 — /preview; v20.10 — редакции методичек
  [ -f "$SRC/$m" ] && cp "$SRC/$m" "$DST/"
done
[ -d "$SRC/tools" ] && ln -sfn "$SRC/tools" "$DST/tools"                # v19: tools/georef (привязка планов)
ln -sfn "$SRC/static" "$DST/static"
ln -sfn "$SRC/templates" "$DST/templates"
echo "стенд $DST готов: python3 run_stand.py $DST <порт>"
