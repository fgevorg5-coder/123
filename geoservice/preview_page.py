# -*- coding: utf-8 -*-
"""[v20.4–v20.5] Превью-страница геосервиса (лендинг): GET /preview и /about.

Сама страница — статичный файл static/preview/index.html (её можно открыть и без сервера,
например через «python -m http.server»). Маршрут лишь:
  • подставляет версию ?v=<версия статики>-<время сборки медиа> в ссылки на CSS/JS/медиа,
    чтобы после обновления браузер не показывал старые кадры (nginx кэширует ?v= надолго);
  • делает og:image абсолютным адресом (так его понимают Telegram, Viber и др.).
Медиа (снимки, кадры, видео) готовят tools/preview/make_preview_media.py (первый экран и «нырок»)
и tools/preview/make_space_media.py (орбита и посадка, v20.5) — см. tools/preview/README_RU.md.
"""
import html
import os
import re

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

_REF = re.compile(r'(/static/preview/[^"\'?\s()<>]+\.(?:css|js|webp|mp4|jpg|png|json))(?=["\'])')
_HOST = re.compile(r'[A-Za-z0-9.\-]{1,253}(:\d{1,5})?')
_OG = 'content="/static/preview/media/og.jpg'
_MEDIA = '/static/preview/media/'


def build_router(base_dir: str, version=lambda: "") -> APIRouter:
    page = os.path.join(base_dir, "static", "preview", "index.html")
    stamp_file = os.path.join(base_dir, "static", "preview", "media", "hero.json")
    cache = {"key": None, "html": ""}
    router = APIRouter()

    def _stamp() -> int:
        try:
            return int(os.path.getmtime(stamp_file))
        except OSError:
            return 0

    def _render(request: Request):
        try:
            st = os.stat(page)
        except OSError:
            return None
        stamp = _stamp()
        ver = re.sub(r"[^A-Za-z0-9._-]", "", "%s-%d" % (version() or "v", stamp))   # CSS/JS страницы
        mver = "m%d" % stamp    # медиа — только по hero.json: обновление JS/CSS геосервиса не заставляет перекачивать ~28 МБ
        key = (st.st_mtime_ns, st.st_size, ver)
        if cache["key"] != key:
            with open(page, encoding="utf-8") as f:
                src = f.read()
            src = _REF.sub(lambda m: m.group(1) + "?v=" + (mver if m.group(1).startswith(_MEDIA) else ver), src)
            src = src.replace('data-v=""', 'data-v="%s"' % mver, 1)
            cache.update(key=key, html=src)
        out = cache["html"]
        host = request.headers.get("host", "")
        if _HOST.fullmatch(host or ""):
            proto = request.headers.get("x-forwarded-proto", "") or request.url.scheme
            proto = "https" if proto.split(",")[0].strip().lower() == "https" else "http"
            out = out.replace(_OG, 'content="%s://%s/static/preview/media/og.jpg' % (proto, html.escape(host, quote=True)))
        return out

    # HEAD — для проверок доступности и сборщиков превью ссылок (Telegram, почта), иначе FastAPI отвечает 405
    @router.api_route("/preview", methods=["GET", "HEAD"], response_class=HTMLResponse, include_in_schema=False)
    @router.api_route("/about", methods=["GET", "HEAD"], response_class=HTMLResponse, include_in_schema=False)
    async def preview(request: Request):
        out = _render(request)
        if out is None:
            return Response("Превью-страница не установлена (нет static/preview/index.html)",
                            status_code=404, media_type="text/plain; charset=utf-8")
        return HTMLResponse(out, headers={"Cache-Control": "no-cache"})

    return router
