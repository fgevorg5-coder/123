# Исходный код обработчика MDB

Собранный браузерный Worker находится в static/forest3d/taxation/tax-worker.js.
Зависимости и точные версии — package-lock.json; лицензии — static/forest3d/taxation/third_party/.
Чтобы пересобрать (нужны Node.js и npm):

```bash
npm ci
./node_modules/.bin/esbuild tax-worker.js --bundle --platform=browser --format=iife --minify --legal-comments=inline --alias:stream=stream-browserify --define:global=globalThis --inject:./shim.js --outfile=../../static/forest3d/taxation/tax-worker.js
```

MDB читается локально Worker-ом; серверу файл не отправляется. Справочник пород species.json подготовлен из листа Por предоставленного пользователем Справочника.xlsx. Формат геометрии — Esri Personal Geodatabase; другие варианты MDB не заявлены как поддерживаемые.
