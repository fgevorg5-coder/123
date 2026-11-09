# -*- coding: utf-8 -*-
"""
FOREST GIS APPLICATION — FastAPI Edition
=========================================
Полная замена Flask → FastAPI с сохранением всей логики.

Запуск:
    uvicorn main:app --host 0.0.0.0 --port 5000 --workers 4

Для продакшена (за nginx):
    uvicorn main:app --host 127.0.0.1 --port 5000 --workers 4
"""

# ==========================================
# 1. НАСТРОЙКА ОКРУЖЕНИЯ GDAL
# ==========================================
import os, sys

# ── Загрузка .env (python-dotenv, опционально) ──────────────────────────────
# Установить: pip install python-dotenv
# Создать файл .env рядом с app.py (НЕ коммитить в git!)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
except ImportError:
    pass  # dotenv не установлен — переменные берутся из окружения системы

os.environ['CPL_LOCALE'] = 'C'
os.environ['CPL_LOG'] = 'NUL'
os.environ['GDAL_FILENAME_IS_UTF8'] = 'YES'
os.environ['PROJ_LIB_ENCODING'] = 'UTF-8'

# ==========================================
# 2. ИМПОРТЫ
# ==========================================
import asyncio as _asyncio
import concurrent.futures as _futures
import glob
import io
import base64
import json
import math
import mimetypes
# [v17] Локальный шрифт интерфейса (static/fonts/*.woff2) — корректный Content-Type вместо octet-stream
mimetypes.add_type("font/woff2", ".woff2")
import hashlib
import logging
import random
import re
import secrets as _secrets_mod
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid as _uuid_mod
import wave
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from typing import Optional, List
from urllib.parse import urlparse, unquote, urljoin, urlencode
from html import unescape as _html_unescape

import numpy as np
import pandas as pd
import geopandas as gpd
import mercantile
import requests
from cryptography.fernet import Fernet
from PIL import Image, ImageFilter
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth
from shapely.geometry import box, shape, mapping
from shapely.wkt import loads as wkt_loads
from shapely.ops import unary_union
from urllib3.util.retry import Retry
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from bs4 import BeautifulSoup  # используется скриптом парсинга новостей belgosles.by (см. раздел 7.5)

import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine, from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, reproject, Resampling
from geoalchemy2 import Geometry
from geoalchemy2.shape import to_shape, from_shape
from sqlalchemy import func, Index, text

# FastAPI и зависимости
from fastapi import (
    FastAPI, Request, Response, Depends, HTTPException,
    UploadFile, File, Form, Query, status
)
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import (
    HTMLResponse, JSONResponse, RedirectResponse,
    StreamingResponse, FileResponse
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.sessions import SessionMiddleware
import secrets as _secrets  # [C] для CSRF-токена
from starlette.middleware.base import BaseHTTPMiddleware

# SQLAlchemy async / sync ORM
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import sessionmaker, declarative_base, Session
from sqlalchemy.pool import QueuePool
from sqlalchemy.exc import IntegrityError

# ==========================================
# ПОПЫТКА ИМПОРТА ТРАНСЛИТЕРАЦИИ
# ==========================================
try:
    from transliterate import translit
except ImportError:
    print("⚠️ Библиотека transliterate не найдена. pip install transliterate")
    def translit(text, language_code, reversed=False):
        return text

# ==========================================
# 3. ЛОГИРОВАНИЕ
# ==========================================
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ==========================================
# 4. FIX PROJ/GDAL PATHS
# ==========================================
def fix_proj_path():
    for env_var in ['PROJ_LIB', 'GDAL_DATA']:
        if env_var in os.environ:
            try:
                del os.environ[env_var]
            except Exception:
                pass
    base_dir = os.path.dirname(sys.executable)
    possible_paths = [
        os.path.join(base_dir, 'Lib', 'site-packages', 'rasterio', 'proj_data'),
        os.path.join(base_dir, '..', 'Lib', 'site-packages', 'rasterio', 'proj_data'),
        os.path.join(base_dir, 'share', 'proj'),
        os.path.join(sys.prefix, 'share', 'proj'),
        os.path.join(base_dir, 'Library', 'share', 'proj'),
    ]
    for p in possible_paths:
        p = os.path.abspath(p)
        if os.path.exists(os.path.join(p, 'proj.db')):
            os.environ['PROJ_LIB'] = p
            logger.info(f"✅ PROJ библиотека найдена: {p}")
            return
    logger.warning("⚠️ PROJ.db не найден. Проекции могут работать некорректно.")

fix_proj_path()

# ==========================================
# 5. КОНФИГУРАЦИЯ
# ==========================================
SERVICE_URL_CAPS = (
    'http://93.84.108.142:2052/arcgis/services/georesursDDZ/'
    'Belarus_Web_Mercator_new/ImageServer/WMSServer'
    '?service=WMS&version=1.3.0&request=GetCapabilities'
)
# ── Credentials из .env / переменных окружения ──────────────────────────────
LOGIN    = os.getenv('DZZ_LOGIN')
PASSWORD = os.getenv('DZZ_PASSWORD')

BASE_DIR           = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER      = os.path.join(BASE_DIR, 'uploads')

# [F] Cache-busting version для статических файлов (JS/CSS).
# Берём короткий git-хэш текущего коммита; если git недоступен — используем
# время модификации самого app.py, что гарантирует смену версии при деплое.
def _build_version() -> str:
    try:
        import subprocess
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=BASE_DIR, stderr=subprocess.DEVNULL
        ).decode().strip() + '-' + str(os.stat(os.path.abspath(__file__)).st_mtime_ns)
    except Exception:
        return str(int(os.path.getmtime(os.path.abspath(__file__))))

class _AssetVersion:
    """Версия статики для ?v=…: меняется при замене ЛЮБОГО файла в static/ и templates/
    (без перезапуска сервера). Иначе Service Worker (cache-first по ?v=) отдаёт старый JS."""
    _BASE = _build_version()
    _cache = ("", 0.0)

    def __str__(self) -> str:
        import time as _t
        val, ts = _AssetVersion._cache
        if val and _t.time() - ts < 5:
            return val
        latest = 0
        for sub in ("static", "templates"):
            root = os.path.join(BASE_DIR, sub)
            for dp, dns, fns in os.walk(root):
                dns[:] = [d for d in dns if not d.startswith("copies") and d not in ("avatars",)]
                for fn in fns:
                    if fn.endswith((".js", ".css", ".html")):
                        try:
                            latest = max(latest, int(os.path.getmtime(os.path.join(dp, fn))))
                        except OSError:
                            pass
        val = f"{_AssetVersion._BASE}-{latest}" if latest else _AssetVersion._BASE
        _AssetVersion._cache = (val, _t.time())
        return val

    __html__ = __str__

    def __format__(self, spec) -> str:
        return format(str(self), spec)

    def __add__(self, other):
        return str(self) + other

    def __radd__(self, other):
        return other + str(self)


APP_VERSION = _AssetVersion()
PREVIEW_FOLDER     = os.path.join(UPLOAD_FOLDER, 'previews')
SHP_FOLDER         = os.path.join(BASE_DIR, 'shp_leshoz')
CACHE_FOLDER       = os.path.join(BASE_DIR, 'cache')
MAPS_STORAGE       = os.path.join(BASE_DIR, 'maps_storage')
CUSTOM_TEMP_DIR    = os.path.join(BASE_DIR, 'big_temp')
# [MBTiles] Папка, в которую попадают все .mbtiles, добавленные через панель слоёв.
# Все слои из этой папки отображаются в UI сгруппированными в раздел "MBTILES MINSK".
MBTILES_MINSK_FOLDER = os.path.join(MAPS_STORAGE, 'MBTILES_MINSK')

os.environ['TMPDIR'] = CUSTOM_TEMP_DIR
os.environ['TEMP']   = CUSTOM_TEMP_DIR
os.environ['TMP']    = CUSTOM_TEMP_DIR
tempfile.tempdir     = CUSTOM_TEMP_DIR

for folder in [UPLOAD_FOLDER, PREVIEW_FOLDER, SHP_FOLDER,
               CACHE_FOLDER, MAPS_STORAGE, CUSTOM_TEMP_DIR, MBTILES_MINSK_FOLDER]:
    os.makedirs(folder, exist_ok=True)

ALLOWED_EXTENSIONS  = {'tif', 'tiff', 'geotiff', 'png', 'jpg', 'jpeg', 'img', 'map', 'ozf2'}
SK42_PRECISE_GOST   = ("+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=5500000 +y_0=0 "
                        "+ellps=krass +towgs84=23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12 "
                        "+units=m +no_defs")
SK42_CRS            = CRS.from_string(SK42_PRECISE_GOST)

# Параметры перехода Красовский (СК-42/СК-63) → WGS-84, как в SK42_PRECISE_GOST
_GOST_TOWGS84 = "+towgs84=23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12"


def _krass_with_towgs84(crs):
    """СК на эллипсоиде Красовского без TOWGS84 → та же СК + параметры ГОСТ.
    Остальные СК возвращаются без изменений."""
    import pyproj as _pp
    try:
        c = _pp.CRS.from_user_input(crs)
        el = c.ellipsoid
        if el is None or abs(float(el.semi_major_metre) - 6378245.0) > 0.5:
            return crs
        p4 = (c.to_proj4() or "").replace("+type=crs", "").strip()
        if not p4 or "+towgs84" in p4:
            return crs
        return _pp.CRS.from_proj4(p4 + " " + _GOST_TOWGS84)
    except Exception:
        return crs

SECRET_KEY  = os.getenv('SECRET_KEY')
ADMIN_IP    = os.getenv('ADMIN_IP', '192.168.12.97')
ADMIN_USER  = {
    "id": "1",
    "name": "Admin",
    "password_hash": generate_password_hash(os.getenv('ADMIN_PASSWORD', '')),
}

# ==========================================
# 6. БАЗА ДАННЫХ — SQLAlchemy (sync)
# ==========================================
DB_USER = os.getenv('DB_USER', 'postgres')
DB_PASS = os.getenv('DB_PASS')
DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_PORT = os.getenv('DB_PORT', '5432')
DB_NAME = os.getenv('DB_NAME', 'forest')

# ── Проверка обязательных переменных окружения ───────────────────────────────
_REQUIRED_ENV = {
    'DB_PASS':        DB_PASS,
    'SECRET_KEY':     SECRET_KEY,
    'ADMIN_PASSWORD': os.getenv('ADMIN_PASSWORD'),
    'DZZ_LOGIN':      os.getenv('DZZ_LOGIN'),
    'DZZ_PASSWORD':   os.getenv('DZZ_PASSWORD'),
}
_missing = [k for k, v in _REQUIRED_ENV.items() if not v]
if _missing:
    _msg = (
        "\n\n❌ ОШИБКА ЗАПУСКА: не заданы обязательные переменные окружения:\n"
        + "\n".join(f"   • {k}" for k in _missing)
        + "\n\nСоздайте файл .env на основе .env.example и заполните значения."
        + "\nУстановите python-dotenv: pip install python-dotenv\n"
    )
    raise RuntimeError(_msg)

# [SEC v16] Раньше URL собирался f-строкой: пароль с символами @ : / # ломал
# подключение (и мог «переадресовать» его на другой хост). URL.create экранирует.
from sqlalchemy.engine import URL as _SA_URL
DATABASE_URL = os.getenv("DATABASE_URL") or _SA_URL.create(
    "postgresql", username=DB_USER, password=DB_PASS, host=DB_HOST,
    port=int(DB_PORT or 5432), database=DB_NAME,
)

engine = create_engine(
    DATABASE_URL,
    poolclass=QueuePool,
    pool_size=10,
    max_overflow=6,
    pool_timeout=5,
    pool_recycle=300,
    pool_pre_ping=True,
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# Dependency — получение сессии БД для каждого запроса
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ==========================================
# 7. ORM МОДЕЛИ
# ==========================================
from sqlalchemy import JSON as SAJSON
from geoalchemy2 import Geometry as GeoGeometry


class Imagery(Base):
    __tablename__ = 'imagery'

    id               = Column(Integer, primary_key=True)
    filename         = Column(String, nullable=False)
    leskhoz_id       = Column(String, index=True)
    leskhoz_name     = Column(String)
    region_name      = Column(String)
    channels         = Column(Integer)
    crs_name         = Column(String)
    date_shot        = Column(String)
    equipment        = Column(String)
    contract_num     = Column(String)
    organization     = Column(String)
    survey_type      = Column(String, default='uav')
    meta_filename    = Column(String)
    preview_filename = Column(String)
    tfw_filename     = Column(String)
    upload_date      = Column(DateTime, server_default=text('now()'))
    geom             = Column(GeoGeometry('POLYGON', srid=4326))

    def to_dict(self):
        if self.geom is not None:
            sh_geom = to_shape(self.geom)
            minx, miny, maxx, maxy = sh_geom.bounds
            bounds = [[maxy, minx], [miny, maxx]]
        else:
            bounds = None
        preview_url = (
            f"/uploads/previews/{self.preview_filename}"
            if self.preview_filename else ''
        )
        return {
            "id": self.id,
            "leskhoz_id": self.leskhoz_id or '',
            "filename": self.filename,
            "preview": self.preview_filename or '',
            "preview_url": preview_url,           # полный URL для <img src>
            "bounds": bounds,
            "date": self.date_shot or '',
            "equipment": self.equipment or '',
            "org": self.organization or '',
            "contract": self.contract_num or '',
            "survey_type": self.survey_type or 'uav',
        }


class VectorLayer(Base):
    __tablename__ = 'vector_layers'

    id           = Column(Integer, primary_key=True)
    name         = Column(String, nullable=False)
    color        = Column(String, default='#3388ff')
    weight       = Column(Integer, default=2)
    fill_opacity = Column(Float, default=0.2)
    upload_date  = Column(DateTime, server_default=text('now()'))
    geojson_data = Column(SAJSON)


class BasemapLayer(Base):
    __tablename__ = 'basemap_layers'

    id              = Column(Integer, primary_key=True)
    name            = Column(String(150))
    filepath        = Column(String(300))
    min_zoom        = Column(Integer)
    max_zoom        = Column(Integer)
    bounds_lat_min  = Column(Float)
    bounds_lat_max  = Column(Float)
    bounds_lon_min  = Column(Float)
    bounds_lon_max  = Column(Float)


class MbtilesLayer(Base):
    """[MBTiles] Готовые .mbtiles файлы, загружаемые администратором прямо через
    панель слоёв («+ Добавить MBTiles»). Все записи относятся к одной папке
    'MBTILES MINSK', которая отображается в UI как отдельная группа слоёв."""
    __tablename__ = 'mbtiles_layers'

    id              = Column(Integer, primary_key=True)
    name            = Column(String(200), nullable=False)
    filename        = Column(String(300), nullable=False)   # имя файла внутри MBTILES_MINSK_FOLDER
    folder          = Column(String(100), default='MBTILES MINSK')
    tile_format     = Column(String(10), default='png')
    min_zoom        = Column(Integer, default=0)
    max_zoom        = Column(Integer, default=19)
    bounds_lat_min  = Column(Float)
    bounds_lat_max  = Column(Float)
    bounds_lon_min  = Column(Float)
    bounds_lon_max  = Column(Float)
    upload_date     = Column(DateTime, server_default=text('now()'))


# ==========================================
# 7б. ORM МОДЕЛИ — ПОЛЬЗОВАТЕЛИ И СООБЩЕНИЯ (PostgreSQL)
# ==========================================

class PgUser(Base):
    __tablename__ = 'pg_users'
    id                = Column(Integer, primary_key=True, autoincrement=True)
    # One server-derived IP = one canonical profile across all browsers.
    ip                = Column(String(45), nullable=False, unique=True, index=True)
    # Retained for compatibility only; no longer a user identity.
    device_id         = Column(String(64), unique=True, nullable=True, index=True)
    first_seen        = Column(String(30))
    last_seen         = Column(String(30))
    user_name         = Column(Text, default='')
    organization_name = Column(Text, default='')
    status            = Column(String(20), default='active')
    quota_unlimited   = Column(Integer, default=0)
    role              = Column(String(20), default='user')   # ← ADD THIS
    photo_url         = Column(Text, default='')             # аватар пользователя
    can_edit_print_queue = Column(Integer, default=0)         # право редактировать «Таксаторы печать» (статусы/удаление/порядок)


# Activity visits: server identity and timestamps; browser counters are untrusted.
from sqlalchemy import Boolean as _ActivityBoolean, BigInteger as _ActivityBigInteger
from sqlalchemy import ForeignKey as _ActivityForeignKey, CheckConstraint as _ActivityCheck
from sqlalchemy.dialects.postgresql import UUID as _ActivityUUID, insert as _activity_insert
from datetime import timezone as _activity_timezone


class PgActivityClick(Base):
    __tablename__ = 'pg_activity_clicks'
    id = Column(_ActivityUUID(as_uuid=True), primary_key=True)
    user_id = Column(Integer, _ActivityForeignKey('pg_users.id', ondelete='CASCADE'), nullable=False)
    ip = Column(String(45), nullable=False)  # Server-derived identity snapshot only.
    path = Column(String(2048), nullable=False)
    section = Column(String(80), nullable=False)
    action = Column(String(6), nullable=False)
    target = Column(String(160), nullable=False)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=text('now()'))
    __table_args__ = (
        Index('ix_clicks_occurred', 'occurred_at'),
        Index('ix_clicks_user_occurred', 'user_id', 'occurred_at'),
        _ActivityCheck("action IN ('click', 'change')", name='ck_clicks_action'),
    )


class PgActivityVisit(Base):
    __tablename__ = 'pg_activity_visits'
    visit_id = Column(_ActivityUUID(as_uuid=True), primary_key=True)
    user_id = Column(Integer, _ActivityForeignKey('pg_users.id', ondelete='CASCADE'), nullable=False)
    path = Column(String(2048), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=False)
    last_seen = Column(DateTime(timezone=True), nullable=False)
    elapsed_seconds = Column(Float, nullable=False, default=0)
    visible_seconds = Column(Float, nullable=False, default=0)
    sequence = Column(_ActivityBigInteger, nullable=False, default=-1)
    visible = Column(_ActivityBoolean, nullable=False, default=False)
    closed = Column(_ActivityBoolean, nullable=False, default=False)
    __table_args__ = (
        Index('ix_activity_started', 'started_at'),
        Index('ix_activity_user_started', 'user_id', 'started_at'),
        Index('ix_activity_last_seen', 'last_seen'),
        _ActivityCheck('elapsed_seconds >= 0 AND visible_seconds >= 0 AND visible_seconds <= elapsed_seconds', name='ck_activity_times'),
    )


class PgAnnouncement(Base):
    __tablename__ = 'pg_announcements'
    id         = Column(Integer, primary_key=True, autoincrement=True)
    title      = Column(Text, nullable=False)
    body       = Column(Text, nullable=False)
    type       = Column(String(20), default='info')
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30))
    is_active  = Column(Integer, default=1)
    created_by = Column(String(45))

class PgLoginHistory(Base):
    __tablename__ = 'pg_login_history'
    id         = Column(Integer, primary_key=True, autoincrement=True)
    user_id    = Column(Integer)
    ip         = Column(String(45))
    login_time = Column(String(30))

class PgToken(Base):
    __tablename__ = 'pg_tokens'
    id         = Column(Integer, primary_key=True, autoincrement=True)
    ip         = Column(String(45))
    token      = Column(String(128), unique=True)
    created_at = Column(String(30))
    expires_at = Column(String(30))

class PgPendingRequest(Base):
    __tablename__ = 'pg_pending_requests'
    id                = Column(Integer, primary_key=True, autoincrement=True)
    user_id           = Column(Integer)
    ip                = Column(String(45))
    requested_at      = Column(String(30))
    user_name         = Column(Text, default='')
    organization_name = Column(Text, default='')
    status            = Column(String(20), default='pending')

class PgMessage(Base):
    __tablename__ = 'pg_messages'
    id      = Column(Integer, primary_key=True, autoincrement=True)
    from_ip = Column(String(45), nullable=False)
    to_ip   = Column(String(45), nullable=False)
    body    = Column(Text, nullable=False)
    sent_at = Column(String(30), nullable=False)
    is_read = Column(Integer, default=0)

class PgMsgFile(Base):
    __tablename__ = 'pg_msg_files'
    id        = Column(Integer, primary_key=True, autoincrement=True)
    msg_id    = Column(Integer, nullable=False)
    from_ip   = Column(String(45), nullable=False)
    filename  = Column(String(200), nullable=False)
    orig_name = Column(String(300))
    mime_type = Column(String(100))
    file_size = Column(Integer, default=0)
    sent_at   = Column(String(30))

class PgAuditLog(Base):
    """Журнал действий пользователей: просмотр, скачивание, удаление, загрузка."""
    __tablename__ = 'pg_audit_log'
    id          = Column(Integer, primary_key=True, autoincrement=True)
    ip          = Column(String(45), nullable=False, index=True)
    user_name   = Column(Text, default='')          # расшифрованное имя на момент события
    action      = Column(String(64), nullable=False, index=True)   # view / download / upload / delete / login / admin_*
    resource    = Column(Text, default='')          # /api/download/42, /uploads/file.tif …
    detail      = Column(Text, default='')          # доп. контекст (JSON-строка или просто текст)
    status_code = Column(Integer, default=200)
    ts          = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)

class PgPrintQueueEntry(Base):
    """Очередь печати — Таксаторы. Одна запись = одна заявка на печать
    лесоустроительных материалов по конкретному лесхозу/лесничеству."""
    __tablename__ = 'pg_print_queue'
    id                 = Column(Integer, primary_key=True, autoincrement=True)
    pos                = Column(Integer, default=0)
    taxator            = Column(Text, nullable=False)
    leshoz             = Column(Text, nullable=False)
    lesnichestvo       = Column(Text, default='')
    expedition         = Column(Text, default='')
    kvartal            = Column(Text, default='')
    vydel              = Column(Text, default='')
    sheets             = Column(Integer, default=1)
    time_label         = Column(Text, default='')     # желаемое время (человекочитаемое)
    priority           = Column(String(20), default='normal')
    status             = Column(String(20), default='not_ready')   # not_ready / ready / delayed
    status_changed_by  = Column(Text, default='')
    status_changed_at  = Column(String(30), default='')
    ecp_user           = Column(Text, default='')
    ecp_time           = Column(Text, default='')
    ecp_sig_data       = Column(Text, default='')     # base64 dataURL PNG подписи — снимок на момент постановки в очередь
    created_by_ip      = Column(String(45), default='')
    created_at         = Column(String(30), default='')
    # Правка полей записи через вкладку «Просмотр Excel» — фиксируем, кто и
    # когда сохранил изменения, и какой ЭЦП это было подтверждено (снимок,
    # отдельный от ecp_* выше, которые относятся к постановке в очередь).
    edited_by          = Column(Text, default='')
    edited_at          = Column(String(30), default='')
    edit_ecp_user      = Column(Text, default='')
    edit_ecp_time      = Column(Text, default='')
    edit_ecp_sig_data  = Column(Text, default='')


class PgPrintQueueStatusLog(Base):
    """Журнал изменений статуса записи очереди печати — фиксирует, кто и
    когда переводил запись в «Готов»/«Задерживается»/«Не готов»."""
    __tablename__ = 'pg_print_queue_status_log'
    id             = Column(Integer, primary_key=True, autoincrement=True)
    entry_id       = Column(Integer, nullable=False, index=True)
    status         = Column(String(20), nullable=False)
    changed_by     = Column(Text, default='')
    changed_by_ip  = Column(String(45), default='')
    changed_at     = Column(String(30), nullable=False)


class PgEcpSignature(Base):
    """Личная ЭЦП таксатора для очереди печати — хранится на сервере
    (а не только в localStorage браузера), поэтому переживает перезагрузку
    страницы, смену устройства/браузера и не зависит от того, совпадает ли
    window.MY_NAME побайтово с ключом в старом клиентском кеше."""
    __tablename__ = 'pg_ecp_signatures'
    id             = Column(Integer, primary_key=True, autoincrement=True)
    taxator_name   = Column(String(255), unique=True, nullable=False, index=True)
    sig_data       = Column(Text, default='')      # base64 dataURL PNG
    signed_at      = Column(String(30), default='')
    locked_until   = Column(String(30), default='')
    signed_by_ip   = Column(String(45), default='')
    # [v18] Черновик подписи: меняется без ограничений, пока подпись не
    # утверждена. sig_data/signed_at — утверждённая (действующая) ЭЦП;
    # после утверждения она блокируется на ECP_LOCK_MONTHS (6) месяцев.
    draft_data     = Column(Text, default='')
    draft_at       = Column(String(30), default='')
    draft_by_ip    = Column(String(45), default='')
    approved_by    = Column(String(255), default='')


class PgVacation(Base):
    """Отпуска сотрудников ОДЗиМЛ, отображаемые в календаре.
    Заполняется только администратором (см. require_admin в /api/vacations)."""
    __tablename__ = 'pg_vacations'
    id          = Column(Integer, primary_key=True, autoincrement=True)
    employee    = Column(String(150), nullable=False)   # label из VF_EMPLOYEES, напр. "И.Р. Бузуновский"
    date_from   = Column(String(10), nullable=False)     # "YYYY-MM-DD"
    date_to     = Column(String(10), nullable=False)     # "YYYY-MM-DD"
    comment     = Column(String(300), default='')
    created_at  = Column(String(30), default='')
    created_by  = Column(String(45), default='')
    # [v18] Вид отметки: vacation (отпуск) | sick (больничный) |
    # trip (командировка) | unpaid (за свой счёт); связь со справочником
    # сотрудников и аудит правок.
    kind            = Column(String(16), default='vacation')
    staff_id        = Column(Integer, nullable=True)
    created_by_name = Column(String(150), default='')
    updated_at      = Column(String(30), default='')
    updated_by      = Column(String(150), default='')


class PgOdzStaff(Base):
    """[v18] Справочник сотрудников ОДЗиМЛ для «Заявления за свой счёт» и
    календаря (раньше — массив VF_EMPLOYEES, зашитый в vacancy.js).
    Исключённые из отдела сотрудники не удаляются, а скрываются из списков
    (excluded=1) — их можно вернуть, история отметок в календаре сохраняется."""
    __tablename__ = 'pg_odziml_staff'
    id          = Column(Integer, primary_key=True, autoincrement=True)
    label       = Column(String(150), nullable=False)   # «И.Р. Бузуновский» — И.О. Фамилия (подпись)
    fio_gen     = Column(String(200), default='')       # «Бузуновского И.Р.» — родительный падеж
    gender      = Column(String(1), default='m')        # m / f
    position    = Column(String(120), default='')       # должность (как в VF_POSITIONS)
    excluded    = Column(Integer, default=0)
    excluded_at = Column(String(30), default='')
    excluded_by = Column(String(150), default='')
    sort        = Column(Integer, default=0)
    created_at  = Column(String(30), default='')
    updated_at  = Column(String(30), default='')
    updated_by  = Column(String(150), default='')


class PgPrintQueueMeta(Base):
    """[v18] Одна строка (id=1): когда, кем и что последний раз менялось
    в очереди «Таксаторы печать» — для индикатора «Последнее обновление»
    (учитывает и удаление, и смену порядка, а не только время записей)."""
    __tablename__ = 'pg_print_queue_meta'
    id          = Column(Integer, primary_key=True)
    updated_at  = Column(String(30), default='')
    updated_by  = Column(String(255), default='')
    action      = Column(String(255), default='')


class PgUserProfile(Base):
    """[v18] Расширенный профиль (как в Telegram): «о себе», должность,
    телефон, статус с эмодзи, рамка аватара, настройки приватности.
    Один профиль на IP — как и pg_users. Имя пользователя здесь НЕ хранится:
    оно назначается администратором и используется для ЭЦП/очереди печати."""
    __tablename__ = 'pg_user_profiles'
    id          = Column(Integer, primary_key=True, autoincrement=True)
    ip          = Column(String(45), unique=True, nullable=False, index=True)
    data        = Column(Text, default='{}')
    updated_at  = Column(String(30), default='')


# Создаём все таблицы при старте (IF NOT EXISTS — безопасно)
try:
    Base.metadata.create_all(bind=engine)
except Exception as _e:
    import logging as _logging
    _logging.getLogger(__name__).warning(f"create_all warning: {_e}")

# create_all() не добавляет новые колонки в уже существующие таблицы —
# для pg_users (существует в БД с прошлых версий) добавляем недостающие
# колонки вручную, безопасно (IF NOT EXISTS).
try:
    with engine.begin() as _conn:
        _conn.execute(text(
            "ALTER TABLE pg_users ADD COLUMN IF NOT EXISTS can_edit_print_queue INTEGER DEFAULT 0"
        ))
        _conn.execute(text(
            "ALTER TABLE pg_users ADD COLUMN IF NOT EXISTS device_id VARCHAR(64)"
        ))
        _conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_pg_users_device_id ON pg_users (device_id)"
        ))
except Exception as _e:
    import logging as _logging
    _logging.getLogger(__name__).warning(f"pg_users migration warning: {_e}")

# IP uniqueness is installed after existing duplicate profiles have been merged.
# Do not drop IP uniqueness: the startup migration in ip_identity.py handles it.

# pg_print_queue — колонки для аудита правок из вкладки «Просмотр Excel»
# (появились после первого релиза таблицы, поэтому добавляем миграцией).
try:
    with engine.begin() as _conn:
        for _col_sql in (
            "ALTER TABLE pg_print_queue ADD COLUMN IF NOT EXISTS edited_by TEXT DEFAULT ''",
            "ALTER TABLE pg_print_queue ADD COLUMN IF NOT EXISTS edited_at VARCHAR(30) DEFAULT ''",
            "ALTER TABLE pg_print_queue ADD COLUMN IF NOT EXISTS edit_ecp_user TEXT DEFAULT ''",
            "ALTER TABLE pg_print_queue ADD COLUMN IF NOT EXISTS edit_ecp_time TEXT DEFAULT ''",
            "ALTER TABLE pg_print_queue ADD COLUMN IF NOT EXISTS edit_ecp_sig_data TEXT DEFAULT ''",
        ):
            _conn.execute(text(_col_sql))
except Exception as _e:
    import logging as _logging
    _logging.getLogger(__name__).warning(f"pg_print_queue migration warning: {_e}")

# [v18] Новые колонки — портабельно (PostgreSQL и SQLite): смотрим, каких
# колонок не хватает, и добавляем только их (без IF NOT EXISTS, которого нет
# в SQLite). Старые подписи остаются утверждёнными с прежним locked_until.
def _v18_add_columns(table, columns):
    try:
        from sqlalchemy import inspect as _sa_inspect
        insp = _sa_inspect(engine)
        if table not in insp.get_table_names():
            return
        have = {c['name'] for c in insp.get_columns(table)}
        with engine.begin() as _conn:
            for _name, _ddl in columns.items():
                if _name not in have:
                    _conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {_name} {_ddl}"))
    except Exception as _e:
        import logging as _logging
        _logging.getLogger(__name__).warning(f"[v18] migration {table}: {_e}")

_v18_add_columns('pg_ecp_signatures', {
    'draft_data': "TEXT DEFAULT ''", 'draft_at': "VARCHAR(30) DEFAULT ''",
    'draft_by_ip': "VARCHAR(45) DEFAULT ''", 'approved_by': "VARCHAR(255) DEFAULT ''",
})
_v18_add_columns('pg_vacations', {
    'kind': "VARCHAR(16) DEFAULT 'vacation'", 'staff_id': "INTEGER",
    'created_by_name': "VARCHAR(150) DEFAULT ''", 'updated_at': "VARCHAR(30) DEFAULT ''",
    'updated_by': "VARCHAR(150) DEFAULT ''",
})

# PostGIS GIST-индексы — создаём CONCURRENTLY чтобы не блокировать таблицу.
# IF NOT EXISTS — безопасно при повторных запусках.
def _ensure_postgis_indexes():
    """Создаёт GIST-индекс по геометрии imagery и составной индекс leskhoz+date.
    Вызывается один раз при старте; CONCURRENTLY не блокирует INSERT/SELECT.
    """
    sqls = [
        """CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_imagery_geom
           ON imagery USING GIST(geom)""",
        """CREATE INDEX IF NOT EXISTS idx_imagery_leskhoz_date
           ON imagery(leskhoz_id, date_shot DESC)""",
    ]
    try:
        # CONCURRENTLY нельзя внутри транзакции — нужен AUTOCOMMIT.
        # [FIX SAVEPOINT] Раньше тут был raw_connection().set_isolation_level(0):
        # соединение возвращалось в пул УЖЕ в режиме autocommit и потом отдавалось
        # обычным сессиям -> "SAVEPOINT can only be used in transaction blocks",
        # а db.commit()/rollback() переставали что-либо делать. Теперь используем
        # execution_options(isolation_level="AUTOCOMMIT") — SQLAlchemy сам
        # сбрасывает уровень изоляции при возврате соединения в пул.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as _ac:
            for sql in sqls:
                try:
                    _ac.exec_driver_sql(sql)
                    logger.info(f"[PostGIS] индекс создан/проверен: {sql.split('EXISTS')[-1].strip()[:60]}")
                except Exception as idx_err:
                    logger.warning(f"[PostGIS] индекс пропущен: {idx_err}")
    except Exception as e:
        logger.warning(f"[PostGIS] _ensure_postgis_indexes: {e}")

try:
    _ensure_postgis_indexes()
except Exception as _ie:
    logger.warning(f"[PostGIS] индексы не созданы: {_ie}")

# ==========================================
# 7.5. НОВОСТИ (belgosles.by) — фоновый парсинг для index.html
# ==========================================
# Скрипт парсит https://belgosles.by/novosti/ и отдаёт список новостей
# (картинка + текст) для отображения прямо на главной странице (index.html),
# в панели сайдбара. Работает так:
#   1) Пытается получить данные через встроенный REST API WordPress —
#      /wp-json/wp/v2/posts (если на сайте он включён — самый надёжный путь).
#   2) Если REST API недоступен — парсит HTML страницы /novosti/ через
#      requests + BeautifulSoup СТРУКТУРНО (по связке картинка → ссылка →
#      заголовок → дата ДД.ММ.ГГГГ), а не по конкретным CSS-классам —
#      меньше риск сломаться при редизайне их сайта.
# Результат кэшируется в памяти процесса и обновляется фоновым потоком —
# ТОЛЬКО пока запущен сервер (поток-демон, умирает вместе с процессом).
# index.html дергает эти данные через GET /api/news (см. раздел 8).

NEWS_BASE_URL      = "https://belgosles.by/novosti/"
NEWS_SITE_ORIGIN   = "https://belgosles.by"
NEWS_WP_API_URL    = "https://belgosles.by/wp-json/wp/v2/posts"
NEWS_REQUEST_TIMEOUT      = 12          # сек. на один HTTP-запрос к сайту
NEWS_CACHE_TTL_SECONDS    = 15 * 60     # кэш считается свежим 15 минут
NEWS_REFRESH_INTERVAL_SEC = 15 * 60     # период фонового обновления
NEWS_PER_PAGE             = 10

_NEWS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 ForestGIS-NewsBot/1.0"
    ),
    "Accept-Language": "ru,be;q=0.9,en;q=0.8",
}
_NEWS_DATE_RE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{4})\b")

_news_cache_lock = threading.Lock()
_news_cache: dict = {}          # {page:int -> {"data":dict, "ts":float}}
_news_refresh_thread: Optional[threading.Thread] = None
_news_refresh_stop_event: Optional[threading.Event] = None


def _news_strip_html(raw: str) -> str:
    """Убирает HTML-теги, декодирует сущности (&amp; и т.п.), схлопывает пробелы."""
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = _html_unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _news_make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(_NEWS_HEADERS)
    return s


def _news_format_iso_date(iso_str: str) -> str:
    """'2026-09-09T10:00:00' -> '09.09.2026'."""
    if not iso_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.split("+")[0].replace("Z", ""))
        return dt.strftime("%d.%m.%Y")
    except Exception:
        return iso_str[:10]


def _news_fetch_via_rest_api(page: int, per_page: int) -> Optional[dict]:
    """Пытается получить новости через REST API WordPress. None — если недоступен."""
    try:
        session = _news_make_session()
        resp = session.get(
            NEWS_WP_API_URL,
            params={"page": page, "per_page": per_page, "_embed": 1, "orderby": "date", "order": "desc"},
            timeout=NEWS_REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        posts = resp.json()
        if not isinstance(posts, list):
            return None

        total_pages_hdr = resp.headers.get("X-WP-TotalPages")
        try:
            total_pages = int(total_pages_hdr) if total_pages_hdr else None
        except ValueError:
            total_pages = None

        items = []
        for p in posts:
            try:
                title = _news_strip_html((p.get("title") or {}).get("rendered", ""))
                excerpt = _news_strip_html((p.get("excerpt") or {}).get("rendered", ""))
                link = p.get("link") or ""
                date_raw = p.get("date") or p.get("date_gmt") or ""
                date_display = _news_format_iso_date(date_raw)

                image_url = ""
                embedded = p.get("_embedded") or {}
                media_list = embedded.get("wp:featuredmedia") or []
                if media_list:
                    media = media_list[0] or {}
                    sizes = ((media.get("media_details") or {}).get("sizes") or {})
                    for size_key in ("medium_large", "medium", "large", "full"):
                        if size_key in sizes and sizes[size_key].get("source_url"):
                            image_url = sizes[size_key]["source_url"]
                            break
                    if not image_url:
                        image_url = media.get("source_url", "")

                if not title or not link:
                    continue
                items.append({
                    "title": title, "excerpt": excerpt[:280], "url": link,
                    "image": image_url, "date": date_display,
                })
            except Exception as e:
                logger.debug(f"[news] REST API: пропуск записи: {e}")
                continue

        if not items:
            return None
        return {
            "ok": True, "source": "wp_rest_api", "page": page, "items": items,
            "has_more": (total_pages is None) or (page < total_pages),
        }
    except Exception as e:
        logger.info(f"[news] REST API недоступен, переходим на HTML-скрейпинг: {e}")
        return None


def _news_page_url(page: int) -> str:
    return NEWS_BASE_URL if page <= 1 else urljoin(NEWS_BASE_URL, f"page/{page}/")


def _news_best_srcset_url(img_tag) -> str:
    """Из srcset выбирает картинку максимальной ширины; иначе — src."""
    srcset = img_tag.get("srcset") or img_tag.get("data-srcset")
    if srcset:
        candidates = []
        for part in srcset.split(","):
            part = part.strip()
            if not part:
                continue
            bits = part.rsplit(" ", 1)
            url = bits[0].strip()
            width = 0
            if len(bits) > 1 and bits[1].endswith("w"):
                try:
                    width = int(bits[1][:-1])
                except ValueError:
                    width = 0
            candidates.append((width, url))
        if candidates:
            candidates.sort(key=lambda t: t[0], reverse=True)
            return candidates[0][1]
    return img_tag.get("src") or img_tag.get("data-src") or ""


def _news_fetch_via_html_scrape(page: int) -> Optional[dict]:
    """Структурный разбор HTML архива новостей (без привязки к CSS-классам темы)."""
    try:
        session = _news_make_session()
        resp = session.get(_news_page_url(page), timeout=NEWS_REQUEST_TIMEOUT)
        if resp.status_code != 200:
            return None
        resp.encoding = resp.apparent_encoding or "utf-8"
        soup = BeautifulSoup(resp.text, "html.parser")

        items, seen_urls = [], set()
        for img in soup.find_all("img"):
            link_tag = img.find_parent("a", href=True)
            if not link_tag:
                continue
            href = urljoin(NEWS_SITE_ORIGIN, link_tag["href"])
            if "/novosti/" not in href or href.rstrip("/") == NEWS_BASE_URL.rstrip("/"):
                continue
            if href in seen_urls:
                continue

            container, title, date_display = link_tag, "", ""
            for _ in range(6):
                if container is None:
                    break
                for a in container.find_all("a", href=True):
                    a_href = urljoin(NEWS_SITE_ORIGIN, a["href"])
                    text = a.get_text(strip=True)
                    if a_href == href and text and "читать далее" not in text.lower():
                        if len(text) > len(title):
                            title = text
                if not date_display:
                    m = _NEWS_DATE_RE.search(container.get_text(" ", strip=True))
                    if m:
                        date_display = m.group(0)
                if title and date_display:
                    break
                container = container.parent

            if not title:
                continue
            image_url = urljoin(NEWS_SITE_ORIGIN, _news_best_srcset_url(img))
            items.append({
                "title": _html_unescape(title), "excerpt": "", "url": href,
                "image": image_url, "date": date_display,
            })
            seen_urls.add(href)

        if not items:
            return None
        has_more = bool(soup.select_one(f'a[href*="/novosti/page/{page + 1}/"]'))
        return {"ok": True, "source": "html_scrape", "page": page, "items": items, "has_more": has_more}
    except Exception as e:
        logger.error(f"[news] Ошибка HTML-скрейпинга: {e}")
        return None


def _news_fetch_fresh(page: int, per_page: int) -> dict:
    data = _news_fetch_via_rest_api(page, per_page)
    if data is None:
        data = _news_fetch_via_html_scrape(page)
    if data is None:
        data = {
            "ok": False, "source": None, "page": page, "items": [], "has_more": False,
            "error": "Не удалось получить новости с belgosles.by.",
        }
    return data


def get_news_page(page: int = 1, per_page: int = NEWS_PER_PAGE, force_refresh: bool = False) -> dict:
    """Синхронная функция — вызывать через run_in_threadpool из async-роута."""
    page = max(1, int(page or 1))
    now = time.time()
    with _news_cache_lock:
        cached = _news_cache.get(page)
        if cached and not force_refresh and (now - cached["ts"] < NEWS_CACHE_TTL_SECONDS):
            return cached["data"]

    data = _news_fetch_fresh(page, per_page)

    with _news_cache_lock:
        if not data.get("ok") and page in _news_cache:
            return _news_cache[page]["data"]   # лучше отдать старый кэш, чем пусто
        _news_cache[page] = {"data": data, "ts": now}
    return data


def _news_refresh_loop(stop_event: threading.Event):
    logger.info("[news] Фоновое обновление новостей запущено.")
    try:
        get_news_page(1, force_refresh=True)
    except Exception as e:
        logger.error(f"[news] Ошибка первичного обновления новостей: {e}")
    _news_prewarm_thumbs()   # [v18 PERF] миниатюры первых новостей — заранее, в этом же фоновом потоке

    while not stop_event.is_set():
        for _ in range(NEWS_REFRESH_INTERVAL_SEC):
            if stop_event.is_set():
                break
            time.sleep(1)
        if stop_event.is_set():
            break
        try:
            get_news_page(1, force_refresh=True)
        except Exception as e:
            logger.error(f"[news] Ошибка фонового обновления новостей: {e}")
        _news_prewarm_thumbs()
    logger.info("[news] Фоновое обновление новостей остановлено.")


def start_news_background_refresh():
    """Запускает фоновый поток обновления новостей. Идемпотентна.
    Поток-демон — работает, только пока запущен сервер (uvicorn)."""
    global _news_refresh_thread, _news_refresh_stop_event
    if _news_refresh_thread and _news_refresh_thread.is_alive():
        return
    _news_refresh_stop_event = threading.Event()
    _news_refresh_thread = threading.Thread(
        target=_news_refresh_loop, args=(_news_refresh_stop_event,),
        name="news-refresh", daemon=True,
    )
    _news_refresh_thread.start()


def stop_news_background_refresh():
    global _news_refresh_thread, _news_refresh_stop_event
    if _news_refresh_stop_event:
        _news_refresh_stop_event.set()
    if _news_refresh_thread:
        _news_refresh_thread.join(timeout=3)
    _news_refresh_thread = None
    _news_refresh_stop_event = None


# ==========================================
# 8. FASTAPI APP + MIDDLEWARE
# ==========================================
# ── [SEC] Swagger/OpenAPI закрыты по умолчанию ──────────────────────────────
# Раньше /docs, /redoc и /openapi.json были доступны ЛЮБОМУ посетителю: это
# готовая карта всех эндпоинтов, параметров и схем — первый шаг любой атаки
# и прямая утечка внутренней структуры сервиса.
# Включить временно (только для отладки): ENABLE_API_DOCS=1 в .env
_API_DOCS = os.getenv("ENABLE_API_DOCS", "0").strip().lower() in ("1", "true", "yes", "on")

app = FastAPI(
    title="Forest GIS",
    version="2.0",
    docs_url=("/docs" if _API_DOCS else None),
    redoc_url=("/redoc" if _API_DOCS else None),
    openapi_url=("/openapi.json" if _API_DOCS else None),
)

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    favicon_path = os.path.join(BASE_DIR, "favicon.ico")
    if os.path.exists(favicon_path):
        return FileResponse(favicon_path, media_type="image/x-icon")
    raise HTTPException(status_code=404)

@app.on_event("startup")
async def _one_ip_identity_startup():
    from ip_identity import migrate_ip_identity
    result = await run_in_threadpool(migrate_ip_identity, engine, decrypt, USERS_DB_PATH)
    logger.info('[one-ip identity] merged=%s, ips=%s, tokens_repaired=%s',
                result['merged_profiles'], result['unique_ips'], result['tokens_repaired'])


@app.on_event("startup")
async def _perf_thread_limiter():
    """[PERF] Обработчики с БД теперь выполняются в пуле потоков — расширяем его
    (по умолчанию 40) с учётом пула соединений БД (pool_size+max_overflow)."""
    try:
        import anyio.to_thread
        anyio.to_thread.current_default_thread_limiter().total_tokens = int(os.getenv("THREADPOOL_TOKENS", "64"))
    except Exception as _e:
        logger.warning(f"[perf] thread limiter: {_e}")


@app.on_event("startup")
async def _prewarm_leshoz_geom():
    """Прогрев кэша геометрий лесхозов при старте — первые тайлы не будут тормозить."""
    def _warm():
        for code in _LU_LAYER_TO_LESHOZ_CODE.values():
            try:
                _get_leshoz_geom(code)
            except Exception:
                pass
    try:
        await run_in_threadpool(_warm)
        logger.info(f"✅ Прогрев геометрий лесхозов: {len(_leshoz_geom_cache)} шт.")
    except Exception as e:
        logger.warning(f"prewarm leshoz geom: {e}")

@app.on_event("startup")
async def _news_startup():
    """Запускает фоновый парсинг новостей belgosles.by — работает,
    пока сервер активен (поток-демон), для панели новостей в index.html."""
    try:
        start_news_background_refresh()
        logger.info("✅ Фоновый парсинг новостей запущен.")
    except Exception as e:
        logger.warning(f"news background refresh startup: {e}")

@app.on_event("shutdown")
async def _news_shutdown():
    try:
        stop_news_background_refresh()
    except Exception:
        pass

# CORS — ограничен конкретными origins для безопасности cookie-сессий.
# Задать ALLOWED_ORIGINS в .env через запятую, напр.:
#   ALLOWED_ORIGINS=https://gis.example.by,http://localhost:5000
_ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", "http://localhost:5000,http://127.0.0.1:5000,http://192.168.12.97,http://192.168.12.97:5000")
_ALLOWED_ORIGINS = [o.strip() for o in _ALLOWED_ORIGINS_RAW.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    # [SEC] Было allow_headers=["*"] вместе с allow_credentials=True — браузеру
    # разрешалось отправлять к нам ЛЮБОЙ заголовок с cookies сессии. Оставляем
    # только те, что реально нужны фронтенду (см. fetch в static/*.js).
    allow_headers=[
        "Accept", "Accept-Language", "Content-Type", "Content-Language",
        "X-CSRFToken", "X-CSRF-Token", "X-Requested-With", "If-None-Match", "Range",
    ],
    max_age=600,
)

# GZip-сжатие ответов API — экономит 60-80% трафика для GeoJSON / JSON >= 1 KB.
# Не трогает уже сжатые форматы (PNG, PDF, TIFF).
class _SmartGZipMiddleware:
    """[PERF] GZip только для текстовых ответов.
    Стандартный GZipMiddleware жмёт ВСЁ ≥1 КБ — включая PNG/JPEG тайлы из
    LRU-кэша (они уже сжаты: выигрыш 0-2 %, а CPU тратится на каждый тайл)
    и SSE-поток. Тайловые/файловые пути пропускаем мимо компрессора,
    уровень сжатия 6 вместо 9 — почти тот же размер JSON при ~3x меньшем CPU."""
    _BYPASS = ('/geoserver_wms_proxy', '/belgosles_wms_proxy', '/wms', '/tiles/',
               '/dzz-wms-proxy', '/uploads/', '/api/download', '/api/sync/stream', '/api/tts',
               '/api/forest3d/dem/')
    # [v19] файлы/ZIP/тайлы заданий ЛесоЛидара и привязки планов — уже сжаты или большие
    _BYPASS_RE = re.compile(r"^/api/(lesolidar|georef)/jobs/[0-9a-f]+/(files/|zip|tiles/|trees\.bin)")

    def __init__(self, app, minimum_size: int = 1024, compresslevel: int = 6):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope, receive, send):
        _p = scope.get("path", "") if scope.get("type") == "http" else ""
        if _p.startswith(self._BYPASS) or (_p.startswith("/api/crs/jobs/") and not _p.rstrip("/").split("/")[-2] == "preview") \
                or self._BYPASS_RE.match(_p):
            await self.app(scope, receive, send)
        else:
            await self.gzip(scope, receive, send)


app.add_middleware(_SmartGZipMiddleware, minimum_size=1024, compresslevel=6)

# Сессии (для cookie-авторизации)
# [SEC] Ужесточение cookie сессии:
#   • https_only  → cookie не уйдёт по открытому HTTP (сайт работает на 443,
#     порт 80 отдаёт 301 → см. nginx.conf). Отключить можно только для
#     локальной отладки без TLS: SESSION_HTTPS_ONLY=0
#   • same_site=lax → cookie не отправляется при кросс-сайтовых POST,
#     это второй (после CSRF-токена) барьер против CSRF.
#   • httponly включён в SessionMiddleware всегда → JS не читает cookie,
#     украсть сессию через XSS нельзя.
_SESSION_HTTPS_ONLY = os.getenv("SESSION_HTTPS_ONLY", "1").strip().lower() not in ("0", "false", "no", "off")

app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    session_cookie="forest_session",
    max_age=86400,
    same_site="lax",
    https_only=_SESSION_HTTPS_ONLY,
)


# ─── [SEC] ЗАГОЛОВКИ БЕЗОПАСНОСТИ НА УРОВНЕ ПРИЛОЖЕНИЯ ──────────────────────
# nginx уже отдаёт эти заголовки, но он — не единственный возможный путь к
# приложению (прямой запрос на 127.0.0.1:5000, отладочный запуск, ошибка в
# конфиге прокси). Дублируем защиту в самом FastAPI: если заголовок уже
# выставлен nginx — не перезаписываем.
#
# ВАЖНО: font-src содержит data: — некоторые библиотеки карт подгружают
# подмножества шрифтов как data:font/truetype;base64,... Без data: браузер
# писал в консоль «Loading the font ... violates the following Content
# Security Policy directive: font-src ...» и шрифт не применялся.
_CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; "
    "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net 'unsafe-inline'; "
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
    "img-src 'self' https: data: blob:; "
    "connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
    "worker-src 'self' blob:; "
    "media-src 'self' blob: data:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'self'"
)

_SECURITY_HEADERS = {
    "Content-Security-Policy":  _CSP_POLICY,
    "X-Content-Type-Options":   "nosniff",
    "X-Frame-Options":          "SAMEORIGIN",
    "Referrer-Policy":          "strict-origin-when-cross-origin",
    "Permissions-Policy":       "geolocation=(self), microphone=(self), camera=()",
    # Геосервис — внутренняя система, в поисковых индексах ей не место
    "X-Robots-Tag":             "noindex, nofollow, noarchive",
    "Cross-Origin-Opener-Policy": "same-origin",
}

# [SEC] Файлы, которых не должно быть в раздаче /static/ и /uploads/ ни при
# каких условиях: исходники, конфиги, логи, бэкапы, source-map (по .map
# восстанавливается исходный код), архивы с кодом.
_FORBIDDEN_STATIC_SUFFIXES = (
    ".py", ".pyc", ".pyo", ".pyz", ".env", ".ini", ".cfg", ".conf", ".yml", ".yaml",
    ".map", ".bak", ".old", ".orig", ".save", ".swp", ".tmp", ".log", ".sql",
    ".db", ".sqlite", ".sqlite3", ".zip", ".rar", ".7z", ".tar", ".gz", ".pem", ".key",
)
# Каталоги с резервными копиями кода (например static/copies (no read)/)
_FORBIDDEN_STATIC_DIRS = ("copies", "copy", "backup", "backups", "old", "_bak", ".git", ".svn")


class SecurityMiddleware(BaseHTTPMiddleware):
    """Заголовки безопасности + запрет на выдачу исходников через статику."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        low  = path.lower()

        # 1) Никакой раздачи исходников/конфигов/бэкапов и source-map
        if low.startswith(("/static/", "/uploads/")):
            if low.endswith(_FORBIDDEN_STATIC_SUFFIXES):
                return Response(status_code=404)
            parts = [p for p in low.split("/") if p]
            if any(seg.split(" ")[0] in _FORBIDDEN_STATIC_DIRS for seg in parts[1:-1]):
                return Response(status_code=404)

        # 2) Скрытые файлы и обход каталогов
        if "/." in low or ".." in low:
            if not low.startswith("/.well-known/"):
                return Response(status_code=404)

        response = await call_next(request)

        for name, value in _SECURITY_HEADERS.items():
            if name not in response.headers:
                response.headers[name] = value

        # HTML-страницы не кэшируем: на них подставлены CSRF-токен и данные
        # текущего пользователя — они не должны остаться в общем кэше.
        ctype = response.headers.get("content-type", "")
        if ctype.startswith("text/html") and "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "no-store, must-revalidate"

        return response


# ──────────────────────────────────────────────────────────────────────────────
# AUDIT LOG — пишет действия в pg_audit_log асинхронно, не блокируя ответ
# ──────────────────────────────────────────────────────────────────────────────

# Маппинг метод+префикс пути → action-метка
_AUDIT_ROUTES: list[tuple] = [
    # (method, path_startswith_or_exact, action)
    ("POST",   "/api/imagery/upload",          "upload"),
    ("DELETE", "/api/imagery/",                "delete_imagery"),
    ("POST",   "/api/vector-layers",           "upload_vector"),
    ("DELETE", "/api/vector-layers/",          "delete_vector"),
    ("GET",    "/api/download/",               "download"),
    ("GET",    "/api/download_zip/",           "download_zip"),
    ("GET",    "/api/download_catalog",        "download_catalog"),
    ("GET",    "/api/download_cog/",           "download_cog"),
    ("POST",   "/api/admin/",                  "admin_action"),
    ("POST",   "/api/cache/purge",             "cache_purge"),
    ("POST",   "/api/login",                   "login"),
    ("POST",   "/api/logout",                  "logout"),
    ("GET",    "/uploads/",                    "view_file"),
]

# Пути, которые НЕ нужно логировать (шум)
_AUDIT_SKIP_PREFIXES = (
    "/static/", "/favicon", "/_health",
    "/wms", "/geoserver", "/dzz-wms", "/belgosles",
    "/api/country-boundary", "/api/forestry-boundaries",
    "/tiles/",
)


def _audit_action_for(method: str, path: str) -> str | None:
    """Возвращает action-метку для запроса или None (не логировать)."""
    if path.startswith(_AUDIT_SKIP_PREFIXES):
        return None
    for m, prefix, action in _AUDIT_ROUTES:
        if method == m and path.startswith(prefix):
            return action
    return None


def _audit_write(ip: str, action: str, resource: str,
                 status_code: int, detail: str = "") -> None:
    """Синхронная запись в БД — вызывается через run_in_threadpool."""
    if not is_tracked_ip(ip):   # [v4] 127.0.0.1 и чужие подсети не журналируем
        return
    db = SessionLocal()
    try:
        uname = _display_name(ip)
        db.add(PgAuditLog(
            ip=ip,
            user_name=uname,
            action=action,
            resource=resource,
            detail=detail,
            status_code=status_code,
            ts=datetime.utcnow(),
        ))
        db.commit()
    except Exception as _ae:
        logger.debug(f"[audit] write error: {_ae}")
        db.rollback()
    finally:
        db.close()


class AuditMiddleware(BaseHTTPMiddleware):
    """
    Перехватывает ответы и пишет запись в pg_audit_log для значимых действий.
    Не блокирует ответ: запись идёт в фоне через asyncio.create_task.
    """
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        try:
            method = request.method
            path   = request.url.path
            action = _audit_action_for(method, path)
            if action:
                ip = get_real_ip(request)
                resource = path
                qs = str(request.url.query)
                detail = qs[:300] if qs else ""
                sc = response.status_code
                # fire-and-forget, не ждём завершения
                _spawn_bg(run_in_threadpool(_audit_write, ip, action, resource, sc, detail))
        except Exception:
            pass  # аудит никогда не должен ронять основной ответ
        return response


import geo_guard as _gg  # [SEC/PERF v9] защита и ускорение геосервиса
import security_hardening as _sh  # [SEC v16] лимиты тела, CSRF-Origin, rate-limit, safe_join, XML
app.add_middleware(_gg.bypass(AuditMiddleware))

# Статические файлы
# JS/CSS отдаются с no-cache — браузер всегда берёт свежую версию
_STATIC_DIR = os.path.join(BASE_DIR, "static")
_NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0"}

# NOTE: app.mount calls moved to end of file, after all add_middleware calls


class CachedStaticFiles(StaticFiles):
    """[PERF] Раньше статика уходила без Cache-Control → браузер каждый раз
    перепроверял map-core.js (640 КБ) и ещё ~30 файлов, а эвристика кэша
    вела себя непредсказуемо (то старая версия, то лишние запросы).
    Теперь:
      • /static/x.js?v=<версия> → кэш на год, immutable (версия меняется при деплое)
      • /static/x.js без версии → no-cache: браузер хранит файл, но сверяет
        ETag (StaticFiles отдаёт 304 без тела, если файл не менялся)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            qs = scope.get("query_string", b"") or b""
            if re.search(rb"(?:^|&)v=[^&]+", qs):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                response.headers["Cache-Control"] = "public, no-cache"
        return response

# Шаблоны Jinja2 (замена render_template)
from starlette.templating import Jinja2Templates
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Фикс: url_for('static', filename=...) ломается при add_middleware + app.mount.
# Переопределяем url_for глобально в Jinja2-окружении.
def _jinja_url_for(name: str, **path_params) -> str:
    if name == "static":
        return "/static/" + path_params.get("filename", "")
    if name == "uploads":
        return "/uploads/" + path_params.get("filename", "")
    params = "/".join(str(v) for v in path_params.values())
    return f"/{name}/{params}"

templates.env.globals["url_for"] = _jinja_url_for
# [F] версия сборки доступна во ВСЕХ шаблонах (для ?v= cache-busting статики)
templates.env.globals["version"] = APP_VERSION

# [v18 PERF] css_bundle()/inline_js() для шаблонов: один CSS-файл вместо 17 и встроенные
# мелкие скрипты (см. static_assets.py). Если модуля нет — шаблон подключит файлы по отдельности.
try:
    import static_assets as _static_assets_mod
    STATIC_ASSETS = _static_assets_mod.install(templates, os.path.join(BASE_DIR, "static"))
except Exception as _sa_err:  # pragma: no cover — запасной вариант, страница всё равно работает
    logger.warning(f"[static_assets] не подключён ({_sa_err}) — CSS/JS подключаются по отдельности")
    from markupsafe import Markup as _SAMarkup, escape as _sa_esc
    _SA_FALLBACK = {
        "index": ["style.css", "ui-custom.css", "index-head.css", "voice-assistant.css", "net-status.css",
                  "ui-enhance.css", "sidebar_profile_menu.css", "design-system-v15.css", "icons-tabler.css",
                  "index-sidebar.css", "unified-search.css", "map-icon-style.css", "measurement-ui.css",
                  "tool-panels-ui.css", "geoservice-help.css", "design-system-v16.css", "design-system-v17.css",
                  "design-system-v18.css"],
        "index-late": [],
    }
    def _sa_css(name, defer=False):
        return _SAMarkup("\n".join('<link rel="stylesheet" href="/static/%s?v=%s">' % (_sa_esc(f), APP_VERSION)
                                   for f in _SA_FALLBACK.get(name, [])))
    def _sa_js(rel):
        return _SAMarkup('<script src="/static/%s?v=%s"></script>' % (_sa_esc(rel), APP_VERSION))
    templates.env.globals["css_bundle"] = _sa_css
    templates.env.globals["inline_js"] = _sa_js

# Only rendered local HTML is modified: never consume streaming/proxy bodies.
_activity_original_template_response = templates.TemplateResponse


def _activity_template_response(*args, **kwargs):
    response = _activity_original_template_response(*args, **kwargs)
    context = getattr(response, 'context', {}) or {}
    request = context.get('request') or kwargs.get('request')
    path = getattr(getattr(request, 'url', None), 'path', '')
    name = str(getattr(getattr(response, 'template', None), 'name', '')).lower()
    excluded = ('/login', '/logout', '/proxy', '/geoserver', '/belgosles',
                '/wms', '/wfs', '/tiles', '/dzz-', '/api/', '/frozen', '/banned', '/maintenance')
    body = getattr(response, 'body', None)
    if (response.status_code != 200 or path.startswith(excluded)
            or 'login' in name or 'proxy' in name
            or not response.headers.get('content-type', '').lower().startswith('text/html')
            or not isinstance(body, bytes) or hasattr(response, 'body_iterator')
            or response.headers.get('content-encoding')
            or b'activity_tracker.js' in body):
        return response
    # Fragments are not documents and must remain untouched.
    pos = body.lower().rfind(b'</body>')
    if pos < 0:
        return response
    tag = (b'<script src="/static/activity_pages.js" defer></script>\n'
           b'<script src="/static/activity_tracker.js" defer></script>\n'
           b'<script src="/static/activity_sections.js" defer></script>\n'
           b'<script src="/static/activity_clicks.js" defer></script>\n')
    response.body = body[:pos] + tag + body[pos:]
    response.headers['content-length'] = str(len(response.body))
    for header in ('etag', 'content-md5'):
        if header in response.headers:
            del response.headers[header]
    return response


templates.TemplateResponse = _activity_template_response


# ==========================================
# 9. HTTP-СЕССИЯ (requests)
# ==========================================
_http_session = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=16,
    pool_maxsize=32,
    max_retries=Retry(total=1, backoff_factor=0.1),  # 1 retry для WMS-тайлов, быстрее fallback
)
_http_session.mount('http://', _adapter)
_http_session.mount('https://', _adapter)

# ----------------------------------------------------------
# In-memory LRU-кэш тайлов GeoServer (работает пока nginx не запущен).
# 512 записей × ~50 КБ ≈ 25 МБ RAM — безопасно.
# Ключ: (url_без_параметра_time, args_str)  →  (bytes, content_type)
# ----------------------------------------------------------
import functools, collections
import perf_kit as _pk  # [v20.13] TTL-кэш, single-flight, предохранители, троттлинг

# ──────────────────────────────────────────────────────────────────────────────
# TILE CACHE — Redis-первый с LRU-fallback
#
# Приоритеты:
#   1. Redis (если REDIS_URL задан и сервер доступен) — горячий кэш WMS-тайлов,
#      переживает рестарт Python-процесса.
#   2. In-memory LRU — работает всегда, используется если Redis недоступен.
#
# Redis ключ:  "tile:{cache_key}"  →  bytes (PNG/JPEG)
# Redis key meta:  "tile:ct:{cache_key}" → content_type (string)
# TTL: REDIS_TILE_TTL секунд (default = 86400 = 1 сутки)
#
# Переменные окружения:
#   REDIS_URL      = redis://127.0.0.1:6379/0   (опционально)
#   REDIS_TILE_TTL = 86400                       (секунды, default 1 сутки)
# ──────────────────────────────────────────────────────────────────────────────

# [v20.13] Адрес внутреннего GeoServer — из .env (раньше был захардкожен в 5 местах).
GEOSERVER_BASE_URL = os.getenv("GEOSERVER_BASE_URL", "http://192.168.12.109:9090/geoserver").rstrip("/")

_REDIS_URL      = os.getenv("REDIS_URL", "")          # "" → Redis отключён
_REDIS_TILE_TTL = int(os.getenv("REDIS_TILE_TTL", "86400"))
_TILE_CACHE_MAX = 15000                                # LRU-fallback размер (шт.)
# [PERF] Лимит по памяти: 15000 тайлов ЛУ/снимков по 60-200 КБ — это до 2-3 ГБ RAM.
_TILE_CACHE_MAX_BYTES = int(os.getenv("TILE_CACHE_MAX_MB", "768")) * 1024 * 1024
_tile_cache_bytes = 0

# ── Попытка подключения к Redis (синхронный redis-py) ───────────────────────
_redis_client = None
_redis_ok      = False

if _REDIS_URL:
    try:
        import redis as _redis_mod
        _redis_client = _redis_mod.from_url(
            _REDIS_URL,
            socket_connect_timeout=1,
            socket_timeout=1,
            decode_responses=False,   # работаем с bytes
        )
        _redis_client.ping()
        _redis_ok = True
        logger.info(f"✅ Redis tile cache подключён: {_REDIS_URL} (TTL={_REDIS_TILE_TTL}s)")
    except Exception as _re:
        _redis_client = None
        _redis_ok      = False
        logger.warning(f"⚠️ Redis недоступен ({_re}) — используется in-memory LRU кэш")
else:
    logger.info("ℹ️ REDIS_URL не задан — используется in-memory LRU кэш тайлов")

# ── In-memory LRU fallback ──────────────────────────────────────────────────
_tile_cache: collections.OrderedDict = collections.OrderedDict()
_tile_cache_lock = threading.Lock()


# [v20.13] Redis-вызовы больше не делаются из event loop: при зависшем Redis
# (socket_timeout=1) каждый тайл раньше «замораживал» весь сервер на 1-2 с.
# Чтение — через threadpool (_tile_cache_aget), запись — fire-and-forget в
# отдельном маленьком пуле; после 3 ошибок подряд Redis отключается на 30 с.
_redis_breaker = _pk.CircuitBreaker("redis", threshold=3, cooldown=30.0)
_redis_executor = _futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="redis")


def _redis_available() -> bool:
    return bool(_redis_ok and _redis_client) and _redis_breaker.allow()


def _tile_cache_get(key: str):
    """Синхронное чтение ТОЛЬКО из LRU процесса (микросекунды, безопасно в loop)."""
    with _tile_cache_lock:
        hit = _tile_cache.get(key)
        if hit is not None:
            _tile_cache.move_to_end(key)
            return hit
    return None


def _tile_cache_redis_get(key: str):
    """Блокирующее чтение из Redis — вызывать только из потока."""
    try:
        data, ct = _redis_client.mget(f"tile:{key}", f"tile:ct:{key}")
        _redis_breaker.record_success()
    except Exception as _e:
        if _redis_breaker.record_failure():
            logger.warning(f"[tile-cache] Redis недоступен, отключён на {_redis_breaker.cooldown:.0f} с: {_e}")
        return None
    if data is None:
        return None
    value = (data, (ct or b"image/png").decode())
    _tile_lru_put(key, value)
    return value


async def _tile_cache_aget(key: str):
    """Читает тайл: LRU (в процессе) → Redis (в threadpool). Хит из Redis
    поднимается в LRU."""
    hit = _tile_cache_get(key)
    if hit is not None:
        return hit
    if _redis_available():
        return await run_in_threadpool(_tile_cache_redis_get, key)
    return None


def _tile_lru_put(key: str, value: tuple):
    global _tile_cache_bytes
    size = len(value[0]) if value and value[0] else 0
    with _tile_cache_lock:
        old = _tile_cache.pop(key, None)
        if old is not None:
            _tile_cache_bytes -= len(old[0]) if old[0] else 0
        _tile_cache[key] = value
        _tile_cache_bytes += size
        while _tile_cache and (len(_tile_cache) > _TILE_CACHE_MAX or _tile_cache_bytes > _TILE_CACHE_MAX_BYTES):
            _, ev = _tile_cache.popitem(last=False)
            _tile_cache_bytes -= len(ev[0]) if ev[0] else 0


def _tile_cache_redis_put(key: str, content: bytes, ct: str):
    try:
        pipe = _redis_client.pipeline(transaction=False)
        pipe.setex(f"tile:{key}",    _REDIS_TILE_TTL, content)
        pipe.setex(f"tile:ct:{key}", _REDIS_TILE_TTL, ct.encode())
        pipe.execute()
        _redis_breaker.record_success()
    except Exception as _e:
        if _redis_breaker.record_failure():
            logger.warning(f"[tile-cache] Redis недоступен, отключён на {_redis_breaker.cooldown:.0f} с: {_e}")


def _tile_cache_put(key: str, value: tuple):
    """Записывает тайл (bytes, content_type): LRU сразу, Redis — в фоне."""
    content, ct = value
    _tile_lru_put(key, value)
    if _redis_available():
        try:
            _redis_executor.submit(_tile_cache_redis_put, key, content, ct)
        except RuntimeError:
            pass  # интерпретатор завершается


def _tile_cache_flush_all() -> dict:
    """Полная инвалидация: Redis + LRU. Возвращает статистику."""
    stats = {"lru": 0, "redis": 0, "redis_ok": _redis_ok}

    global _tile_cache_bytes
    with _tile_cache_lock:
        stats["lru"] = len(_tile_cache)
        _tile_cache.clear()
        _tile_cache_bytes = 0

    if _redis_ok and _redis_client:
        try:
            # Удаляем только наши ключи tile:* — не трогаем другие данные в Redis
            cursor = 0
            deleted = 0
            while True:
                cursor, keys = _redis_client.scan(cursor, match="tile:*", count=500)
                if keys:
                    _redis_client.delete(*keys)
                    deleted += len(keys)
                if cursor == 0:
                    break
            stats["redis"] = deleted
            logger.info(f"[cache/purge] Redis: удалено {deleted} ключей")
        except Exception as _e:
            logger.warning(f"[cache/purge] Redis flush error: {_e}")
            stats["redis_error"] = str(_e)

    return stats

# ==========================================
# 10. УТИЛИТЫ АВТОРИЗАЦИИ
# ==========================================

import admin_stepup as _stepup


def get_current_user(request: Request) -> Optional[str]:
    """user_id администратора — ТОЛЬКО после ввода дополнительного пароля
    (admin_stepup.py). Без него — None, даже для ADMIN_IP и после /login."""
    user_id = request.session.get("user_id")
    if user_id and _stepup.is_verified(request, get_real_ip(request)):
        return user_id
    return None


def require_admin(request: Request):
    """Dependency — 401 без входа; 401 + X-Admin-Stepup: 1, если нужен доп. пароль."""
    user_id = get_current_user(request)
    if not user_id:
        if request.session.get("user_id") or get_real_ip(request) == ADMIN_IP:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=_stepup.STEPUP_DETAIL,
                headers={_stepup.STEPUP_HEADER: "1"},
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
        )
    return user_id


# ── [C] CSRF-защита ──────────────────────────────────────────────────────────
def get_csrf_token(request: Request) -> str:
    """Возвращает CSRF-токен из сессии, создаёт новый если отсутствует."""
    token = request.session.get("csrf_token")
    if not token:
        token = _secrets.token_hex(32)
        request.session["csrf_token"] = token
    return token


def verify_csrf(request: Request):
    """Dependency для мутирующих маршрутов (POST/DELETE/PATCH).
    Проверяет заголовок X-CSRFToken или поле формы _csrf_token."""
    # Безопасные методы не проверяем
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    session_token = request.session.get("csrf_token")
    if not session_token:
        raise HTTPException(status_code=403, detail="CSRF: сессионный токен отсутствует")
    # Проверяем заголовок (fetch) или тело формы
    header_token = request.headers.get("X-CSRFToken") or request.headers.get("X-CSRF-Token")
    if header_token and _secrets.compare_digest(header_token, session_token):
        return
    raise HTTPException(status_code=403, detail="CSRF-токен недействителен")


# IP-адрес(а), которым разрешено передавать X-Real-IP/X-Forwarded-For.
# nginx и FastAPI работают на одной Windows-машине (см. nginx.conf) и
# соединяются через loopback — поэтому единственный доверенный источник
# этих заголовков — сам localhost. Любой другой источник заголовка
# (в т.ч. прямой запрос на порт 5000 в обход nginx) игнорируется.
_TRUSTED_PROXY_IPS = {"127.0.0.1", "::1"}


def get_real_ip(request: Request) -> str:
    direct_ip = request.client.host if request.client else "unknown"

    # Доверяем заголовкам ТОЛЬКО если TCP-соединение реально пришло от
    # нашего nginx (loopback). Иначе заголовок мог подделать сам клиент,
    # отправив запрос напрямую на порт FastAPI, минуя nginx.
    if direct_ip in _TRUSTED_PROXY_IPS:
        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip.strip()
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()

    return direct_ip


# ── [v4] Учёт только адресов локальной сети 192.168.12.x ─────────────────────
# Последний октет адреса — «номер» пользователя в консоли (192.168.12.23 → #23).
# 127.0.0.1 / ::1 (запросы с самого сервера), а также любые другие подсети
# НЕ регистрируются как пользователи и не попадают в аналитику/журналы.
_TRACKED_IP_PREFIX = os.getenv('TRACKED_IP_PREFIX', '192.168.12.').strip() or '192.168.12.'
if not _TRACKED_IP_PREFIX.endswith('.'):
    _TRACKED_IP_PREFIX += '.'
_TRACKED_IP_RE = re.compile('^' + re.escape(_TRACKED_IP_PREFIX) + r'(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$')


def is_tracked_ip(ip) -> bool:
    """True только для адресов вида 192.168.12.N (N = 1…254)."""
    m = _TRACKED_IP_RE.match(str(ip or '').strip())
    return bool(m) and 0 < int(m.group(1)) < 255


def ip_octet(ip):
    """Последний октет отслеживаемого IP (идентификатор пользователя) или None."""
    m = _TRACKED_IP_RE.match(str(ip or '').strip())
    return int(m.group(1)) if m else None


# ==========================================
# 9.5 DEVICE ID — постоянный идентификатор браузера/ПК
# ==========================================
# Browser cookie is retained for compatibility/diagnostics only. Profile lookup
# always uses the trusted server-derived IP, including a new browser's first visit.
_DEVICE_COOKIE_NAME = "device_id"
_DEVICE_COOKIE_MAX_AGE = 63072000  # 2 года

def get_device_id(request: Request) -> Optional[str]:
    """Читает device_id, который для этого запроса уже определил
    DeviceIdentityMiddleware (см. ниже) и положил в request.state."""
    return getattr(request.state, "device_id", None) or request.cookies.get(_DEVICE_COOKIE_NAME)


class DeviceIdentityMiddleware(BaseHTTPMiddleware):
    """Гарантирует, что у каждого браузера есть свой постоянный device_id.

    Если cookie уже есть — читаем и кладём в request.state.device_id.
    Если нет (первый визит с этого браузера) — генерируем новый
    криптографически случайный ID и выставляем cookie в ОТВЕТЕ. Сам ID
    для ТЕКУЩЕГО запроса тоже кладём в request.state, для совместимости со старыми обработчиками. Профиль по этому ID
    больше не ищется: единственный идентификатор профиля — IP.
    """
    async def dispatch(self, request: Request, call_next):
        existing = request.cookies.get(_DEVICE_COOKIE_NAME)
        is_new = not existing
        device_id = existing or _uuid_mod.uuid4().hex
        request.state.device_id = device_id

        response = await call_next(request)

        if is_new:
            response.set_cookie(
                _DEVICE_COOKIE_NAME, device_id,
                max_age=_DEVICE_COOKIE_MAX_AGE,
                httponly=True,
                samesite="lax",
                secure=_SESSION_HTTPS_ONLY,
                path="/",
            )
        return response


# ==========================================
# 10.5 TTS (SILERO) — офлайн-синтез голосового ответа
# ==========================================
# Полностью локальный синтез речи без внешних API и ключей.
# Модель .pt скачивается ОДИН раз (нужен интернет в этот момент —
# если на сервере интернет заблокирован/перехватывается корпоративным
# файрволом, см. комментарий у _load_silero_model ниже про ручную
# закачку файла), дальше работает полностью офлайн.

_silero_model = None
_silero_lock = threading.Lock()
# Отдельный executor с ОДНИМ воркером — синтез гоняем строго по очереди,
# т.к. сама модель не гарантированно потокобезопасна для параллельных
# вызовов apply_tts() из разных потоков одновременно.
_tts_executor = _futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")

SILERO_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
SILERO_MODEL_PATH = os.path.join(SILERO_MODEL_DIR, "silero_v4_ru.pt")
SILERO_MODEL_URL = "https://models.silero.ai/models/tts/ru/v4_ru.pt"
SILERO_SAMPLE_RATE = 48000
SILERO_SPEAKER = "xenia"  # доступные голоса v4_ru: aidar, baya, kseniya, xenia, eugene, random


def _load_silero_model():
    """Ленивая (однократная) загрузка модели Silero TTS в память процесса.

    Если .pt-файла нет локально — модель качается автоматически при первом
    запросе (нужен доступ в интернет в этот момент). На корпоративной сети
    с перехватом TLS автоматическая закачка может не пройти — тогда проще
    скачать файл вручную в обычном браузере (он уже ходит в интернет без
    проблем) по ссылке SILERO_MODEL_URL и положить его по пути
    SILERO_MODEL_PATH (папка models/ рядом с app.py) — при следующем
    запуске сервер найдёт файл на диске и в сеть вообще не полезет.
    """
    global _silero_model
    if _silero_model is not None:
        return _silero_model
    with _silero_lock:
        if _silero_model is not None:
            return _silero_model
        import torch
        os.makedirs(SILERO_MODEL_DIR, exist_ok=True)
        if not os.path.isfile(SILERO_MODEL_PATH):
            logging.info("[TTS] Модель Silero не найдена локально — скачиваю: %s", SILERO_MODEL_URL)
            torch.hub.download_url_to_file(SILERO_MODEL_URL, SILERO_MODEL_PATH)
        model = torch.package.PackageImporter(SILERO_MODEL_PATH).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        _silero_model = model
        logging.info("[TTS] Модель Silero загружена и готова к синтезу.")
        return _silero_model


def _synthesize_wav_bytes(text: str) -> bytes:
    """Синтезирует текст голосом Silero, возвращает готовый WAV (PCM16, моно)."""
    model = _load_silero_model()
    audio = model.apply_tts(text=text, speaker=SILERO_SPEAKER, sample_rate=SILERO_SAMPLE_RATE)
    pcm16 = (audio.numpy() * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SILERO_SAMPLE_RATE)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


# ==========================================
# 11. УТИЛИТЫ РАСТРОВОЙ ОБРАБОТКИ
# ==========================================

def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def parse_tfw(tfw_path: str) -> Optional[Affine]:
    try:
        with open(tfw_path, 'r') as f:
            lines = [float(l.strip()) for l in f.readlines()]
        return Affine(lines[0], lines[2], lines[4], lines[1], lines[3], lines[5])
    except Exception:
        return None


def normalize_band(band: np.ndarray) -> np.ndarray:
    if band.dtype == np.uint8:
        return band
    valid_pixels = band[band > 0]
    if valid_pixels.size == 0:
        return band.astype(np.uint8)
    min_val = np.percentile(valid_pixels, 2)
    max_val = np.percentile(valid_pixels, 98)
    if max_val == min_val:
        if max_val == 0:
            return np.zeros_like(band, dtype=np.uint8)
        return ((band / max_val) * 255).astype(np.uint8)
    normalized = np.clip(band, min_val, max_val)
    return ((normalized - min_val) / (max_val - min_val) * 255).astype(np.uint8)


def fill_internal_holes(alpha_mask: np.ndarray) -> np.ndarray:
    """Заполняет внутренние дыры в альфа-маске растра.

    Было: Python-цикл for y in range(...) — O(H) итераций, медленно.
    Стало: чистый NumPy — cummax слева и справа по строкам, 50–200x быстрее.
    """
    mask = alpha_mask > 0                                      # bool [H, W]
    left  = np.maximum.accumulate(mask,          axis=1)       # True от первого пикселя вправо
    right = np.maximum.accumulate(mask[:, ::-1], axis=1)[:, ::-1]  # True от последнего влево
    return (left & right).astype(np.uint8) * 255


def crop_image_smart(img_array: np.ndarray, transform: Affine):
    alpha = img_array[:, :, 3]
    rows = np.any(alpha > 0, axis=1)
    cols = np.any(alpha > 0, axis=0)
    if not np.any(rows) or not np.any(cols):
        return img_array, transform
    ymin, ymax = np.where(rows)[0][[0, -1]]
    xmin, xmax = np.where(cols)[0][[0, -1]]
    ymax += 1
    xmax += 1
    cropped = img_array[ymin:ymax, xmin:xmax, :]
    new_transform = transform * rasterio.transform.Affine.translation(xmin, ymin)
    return cropped, new_transform


def generate_preview(tiff_path: str, save_name: str):
    try:
        with rasterio.open(tiff_path) as src:
            use_precise_sk42 = False
            if not src.crs:
                use_precise_sk42 = True
            else:
                try:
                    if src.crs.to_epsg() == 28405:
                        use_precise_sk42 = True
                    else:
                        source_crs = src.crs
                except Exception:
                    source_crs = src.crs

            if use_precise_sk42:
                source_crs = CRS.from_string(SK42_PRECISE_GOST)
            dst_crs = 'EPSG:4326'
            scale = 1500 / src.width if src.width > 1500 else 1
            dst_transform, width, height = calculate_default_transform(
                source_crs, dst_crs, src.width, src.height, *src.bounds,
                dst_width=int(src.width * scale), dst_height=int(src.height * scale),
            )
            final_img = np.zeros((height, width, 4), dtype=np.uint8)
            if src.count >= 3:
                for i in range(1, 4):
                    band_data = np.zeros((height, width), dtype=src.dtypes[0])
                    reproject(
                        rasterio.band(src, i), band_data,
                        src_transform=src.transform, src_crs=source_crs,
                        dst_transform=dst_transform, dst_crs=dst_crs,
                        resampling=Resampling.bilinear,
                    )
                    final_img[:, :, i - 1] = normalize_band(band_data)
                raw_mask = (np.sum(final_img[:, :, 0:3], axis=2) > 5).astype(np.uint8) * 255
            else:
                band_data = np.zeros((height, width), dtype=src.dtypes[0])
                reproject(
                    rasterio.band(src, 1), band_data,
                    src_transform=src.transform, src_crs=source_crs,
                    dst_transform=dst_transform, dst_crs=dst_crs,
                    resampling=Resampling.bilinear,
                )
                norm = normalize_band(band_data)
                final_img[:, :, 0] = final_img[:, :, 1] = final_img[:, :, 2] = norm
                raw_mask = (norm > 0).astype(np.uint8) * 255

            final_img[:, :, 3] = fill_internal_holes(raw_mask)
            cropped_img, final_transform = crop_image_smart(final_img, dst_transform)

            pil_image = Image.fromarray(cropped_img, 'RGBA')
            pil_image = pil_image.filter(ImageFilter.MedianFilter(size=3))
            save_path = os.path.join(PREVIEW_FOLDER, save_name)
            pil_image.save(save_path, 'PNG', optimize=True)

            fw, fh = pil_image.size
            w_bound = final_transform[2]
            n_bound = final_transform[5]
            e_bound = w_bound + fw * final_transform[0]
            s_bound = n_bound + fh * final_transform[4]
            return save_path, [[n_bound, w_bound], [s_bound, e_bound]]
    except Exception as e:
        logger.error(f"Preview generation error: {e}")
        return None, None


# ==========================================
# 12. ЛЕСХОЗЫ — загрузка и обработка
# ==========================================
MANUAL_FORESTRY_FIX = [
    # Брестская обл (1)
    {'code': '101', 'name': 'Барановичский лесхоз', 'region': 1},
    {'code': '102', 'name': 'Брестский лесхоз', 'region': 1},
    {'code': '103', 'name': 'Ганцевичский лесхоз', 'region': 1},
    {'code': '104', 'name': 'Ивацевичский опытный лесхоз', 'region': 1},
    {'code': '105', 'name': 'Кобринский опытный лесхоз', 'region': 1},
    {'code': '106', 'name': 'Лунинецкий лесхоз', 'region': 1},
    {'code': '107', 'name': 'Ляховичский лесхоз', 'region': 1},
    {'code': '109', 'name': 'Пинский лесхоз', 'region': 1},
    {'code': '110', 'name': 'Пружанский лесхоз', 'region': 1},
    {'code': '111', 'name': 'Столинский лесхоз', 'region': 1},
    {'code': '112', 'name': 'Телеханский лесхоз', 'region': 1},
    {'code': '113', 'name': 'Полесский лесхоз', 'region': 1},
    {'code': '116', 'name': 'Малоритский лесхоз', 'region': 1},
    {'code': '117', 'name': 'Дрогичинский лесхоз', 'region': 1},
    {'code': '121', 'name': 'Домановский лесхоз', 'region': 1},
    # Витебская обл (2)
    {'code': '201', 'name': 'Бегомльский лесхоз', 'region': 2},
    {'code': '202', 'name': 'Бешенковичский лесхоз', 'region': 2},
    {'code': '203', 'name': 'Богушевский лесхоз', 'region': 2},
    {'code': '205', 'name': 'Верхнедвинский лесхоз', 'region': 2},
    {'code': '206', 'name': 'Витебский лесхоз', 'region': 2},
    {'code': '207', 'name': 'Глубокский опытный лесхоз', 'region': 2},
    {'code': '208', 'name': 'Городокский лесхоз', 'region': 2},
    {'code': '209', 'name': 'Дисненский лесхоз', 'region': 2},
    {'code': '210', 'name': 'Лепельский лесхоз', 'region': 2},
    {'code': '211', 'name': 'Оршанский лесхоз', 'region': 2},
    {'code': '212', 'name': 'Полоцкий лесхоз', 'region': 2},
    {'code': '213', 'name': 'Поставский лесхоз', 'region': 2},
    {'code': '214', 'name': 'Россонский лесхоз', 'region': 2},
    {'code': '215', 'name': 'Суражский лесхоз', 'region': 2},
    {'code': '216', 'name': 'Толочинский лесхоз', 'region': 2},
    {'code': '217', 'name': 'Ушачский лесхоз', 'region': 2},
    {'code': '218', 'name': 'Шумилинский лесхоз', 'region': 2},
    {'code': '219', 'name': 'Лиозненский лесхоз', 'region': 2},
    # Гомельская обл (3)
    {'code': '301', 'name': 'Буда-Кошелевский опытный лесхоз', 'region': 3},
    {'code': '302', 'name': 'Василевичский лесхоз', 'region': 3},
    {'code': '303', 'name': 'Гомельский опытный лесхоз', 'region': 3},
    {'code': '304', 'name': 'Ельский лесхоз', 'region': 3},
    {'code': '305', 'name': 'Житковичский лесхоз', 'region': 3},
    {'code': '306', 'name': 'Жлобинский лесхоз', 'region': 3},
    {'code': '307', 'name': 'Калинковичский лесхоз', 'region': 3},
    {'code': '308', 'name': 'Комаринский лесхоз', 'region': 3},
    {'code': '309', 'name': 'Лоевский лесхоз', 'region': 3},
    {'code': '310', 'name': 'Лельчицкий лесхоз', 'region': 3},
    {'code': '311', 'name': 'Милошевичский лесхоз', 'region': 3},
    {'code': '312', 'name': 'Мозырский опытный лесхоз', 'region': 3},
    {'code': '314', 'name': 'Наровлянский спецлесхоз', 'region': 3},
    {'code': '316', 'name': 'Октябрьский лесхоз', 'region': 3},
    {'code': '317', 'name': 'Хойникский лесхоз', 'region': 3},
    {'code': '318', 'name': 'Петриковский лесхоз', 'region': 3},
    {'code': '319', 'name': 'Речицкий опытный лесхоз', 'region': 3},
    {'code': '320', 'name': 'Рогачёвский лесхоз', 'region': 3},
    {'code': '321', 'name': 'Светлогорский лесхоз', 'region': 3},
    {'code': '322', 'name': 'Чечерский спецлесхоз', 'region': 3},
    {'code': '325', 'name': 'Ветковский спецлесхоз', 'region': 3},
    # Гродненская обл (4)
    {'code': '401', 'name': 'Волковысский лесхоз', 'region': 4},
    {'code': '402', 'name': 'Гродненский лесхоз', 'region': 4},
    {'code': '403', 'name': 'Дятловский лесхоз', 'region': 4},
    {'code': '404', 'name': 'Ивьевский лесхоз', 'region': 4},
    {'code': '405', 'name': 'Лидский лесхоз', 'region': 4},
    {'code': '406', 'name': 'Новогрудский лесхоз', 'region': 4},
    {'code': '407', 'name': 'Островецкий опытный лесхоз', 'region': 4},
    {'code': '408', 'name': 'Слонимский лесхоз', 'region': 4},
    {'code': '409', 'name': 'Сморгонский опытный лесхоз', 'region': 4},
    {'code': '410', 'name': 'Щучинский лесхоз', 'region': 4},
    {'code': '413', 'name': 'Скидельский лесхоз', 'region': 4},
    # Минская обл (5)
    {'code': '501', 'name': 'Березинский лесхоз', 'region': 5},
    {'code': '502', 'name': 'Борисовский опытный лесхоз', 'region': 5},
    {'code': '503', 'name': 'Вилейский опытный лесхоз', 'region': 5},
    {'code': '504', 'name': 'Воложинский лесхоз', 'region': 5},
    {'code': '505', 'name': 'Клецкий лесхоз', 'region': 5},
    {'code': '506', 'name': 'Копыльский опытный лесхоз', 'region': 5},
    {'code': '507', 'name': 'Крупский лесхоз', 'region': 5},
    {'code': '508', 'name': 'Логойский лесхоз', 'region': 5},
    {'code': '509', 'name': 'Любанский лесхоз', 'region': 5},
    {'code': '511', 'name': 'Молодечненский лесхоз', 'region': 5},
    {'code': '513', 'name': 'Пуховичский лесхоз', 'region': 5},
    {'code': '514', 'name': 'Слуцкий лесхоз', 'region': 5},
    {'code': '515', 'name': 'Смолевичский лесхоз', 'region': 5},
    {'code': '516', 'name': 'Старобинский лесхоз', 'region': 5},
    {'code': '517', 'name': 'Стародорожский опытный лесхоз', 'region': 5},
    {'code': '518', 'name': 'Столбцовский лесхоз', 'region': 5},
    {'code': '519', 'name': 'Узденский лесхоз', 'region': 5},
    {'code': '520', 'name': 'Червенский лесхоз', 'region': 5},
    {'code': '521', 'name': 'Боровлянский спецлесхоз', 'region': 5},
    {'code': '541', 'name': 'Минский лесхоз', 'region': 5},
    # Могилёвская обл (6)
    {'code': '601', 'name': 'Белыничский лесхоз', 'region': 6},
    {'code': '602', 'name': 'Бобруйский лесхоз', 'region': 6},
    {'code': '603', 'name': 'Быховский лесхоз', 'region': 6},
    {'code': '604', 'name': 'Глусский лесхоз', 'region': 6},
    {'code': '605', 'name': 'Горецкий лесхоз', 'region': 6},
    {'code': '606', 'name': 'Кличевский лесхоз', 'region': 6},
    {'code': '607', 'name': 'Костюковичский лесхоз', 'region': 6},
    {'code': '608', 'name': 'Краснопольский лесхоз', 'region': 6},
    {'code': '609', 'name': 'Могилевский лесхоз', 'region': 6},
    {'code': '610', 'name': 'Осиповичский опытный лесхоз', 'region': 6},
    {'code': '611', 'name': 'Чериковский лесхоз', 'region': 6},
    {'code': '612', 'name': 'Климовичский лесхоз', 'region': 6},
    {'code': '613', 'name': 'Чаусский лесхоз', 'region': 6},
    # УДП (7)
    {'code': '4001', 'name': 'ЭЛОХ "Лясковичи"', 'region': 7},
    {'code': '4012', 'name': 'ГПУ "НП "Нарочанский"', 'region': 7},
    {'code': '4014', 'name': 'ГПУ "НП "Беловежская пуща"', 'region': 7},
    {'code': '4020', 'name': 'ЭЛОХ "Барсуки"', 'region': 7},
    {'code': '4022', 'name': 'Нацпарк "Браславские озера"', 'region': 7},
    {'code': '4023', 'name': 'ЭЛОХ "Браслав"', 'region': 7},
    {'code': '4024', 'name': 'Учреждение "Тетеринское"', 'region': 7},
    {'code': '4031', 'name': 'ГЛХУ "ШЕРЕШЕВСКОЕ ЛОХ"', 'region': 7},
    {'code': '4032', 'name': 'ЭЛОХ "Выгоновское"', 'region': 7},
    {'code': '4033', 'name': 'ГПУ НП "Припятский"', 'region': 7},
    {'code': '4042', 'name': 'ГЛХУ "Красносельское"', 'region': 7},
    {'code': '4043', 'name': 'ЭЛОХ "Мядель"', 'region': 7},
    {'code': '4044', 'name': 'Березинский биосферный заповедник', 'region': 7},
    # Минприроды (8)
    {'code': '5030', 'name': 'ГПНИУ "ПОЛЕССКИЙ ГРЭЗ"', 'region': 8},
    # ЖКХ (9)
    {'code': '6001', 'name': 'МОГИЛЕВСКИЙ ЗЕЛЕНСТРОЙ', 'region': 9},
    {'code': '6015', 'name': 'ПКУП "КОММУНАЛЬНИК" Г.БРЕСТ', 'region': 9},
    {'code': '6021', 'name': 'КУП "СОЛИГОРСК КОММУНСЕРВИС"', 'region': 9},
    {'code': '6043', 'name': 'ПКДУП "Минское лесопарковое х-во"', 'region': 9},
    {'code': '6046', 'name': 'ОУПП "Гродненское Городское ЖКХ"', 'region': 9},
    # МО (10)
    {'code': '7021', 'name': 'Негорельский учебно-оп. лесхоз', 'region': 10},
    {'code': '7045', 'name': 'Полоцкий лесной колледж', 'region': 10},
    # НАН (11)
    {'code': '8021', 'name': 'ГЛХУ "ДВИНСКАЯ ЭЛБ"', 'region': 11},
    {'code': '8025', 'name': 'ГЛХУ "ЖОРНОВСКАЯ ЭЛБ"', 'region': 11},
    {'code': '8031', 'name': 'ГЛХУ "КОРЕНЕВСКАЯ ЭЛБ"', 'region': 11},
]

_leshoz_gdf_cache = None
_leshoz_cache_lock = threading.Lock()


def process_forestry_gdf(gdf):
    try:
        gdf.columns = [c.lower() for c in gdf.columns]
        candidates_code = ['leshozkod', 'code', 'kod', 'id', 'kod_les', 'full_code', 'l_code']
        shp_code_col = next((c for c in gdf.columns if c in candidates_code), None)
        if not shp_code_col:
            valid_cols = [c for c in gdf.columns if c != 'geometry']
            if valid_cols:
                shp_code_col = valid_cols[0]
            else:
                return None, "Не найдена колонка с кодом лесхоза"
        gdf = gdf.rename(columns={shp_code_col: 'code'})
        gdf['code'] = gdf['code'].astype(str).str.strip().str.replace(r'\.0$', '', regex=True)

        bounds = gdf.geometry.total_bounds
        if bounds[0] > 1000 or bounds[1] > 1000:
            mean_x = gdf.geometry.centroid.x.mean()
            try:
                zone_prefix = int(str(int(mean_x))[0])
            except Exception:
                zone_prefix = 5
            zone = zone_prefix if zone_prefix in [5, 6] else 5
            cm = zone * 6 - 3
            precise_sk42 = (
                f"+proj=tmerc +lat_0=0 +lon_0={cm} +k=1 +x_0={zone}500000 +y_0=0 "
                "+ellps=krass +towgs84=23.92,-141.27,-80.9,0,-0.35,-0.82,-0.12 "
                "+units=m +no_defs"
            )
            gdf.crs = precise_sk42
            gdf = gdf.to_crs(epsg=4326)
        elif not gdf.crs:
            gdf.crs = "EPSG:4326"
        else:
            gdf = gdf.to_crs(epsg=4326)

        gdf['geometry'] = gdf.geometry.buffer(0)

        df_ref = pd.DataFrame(MANUAL_FORESTRY_FIX)
        df_ref['code'] = df_ref['code'].astype(str).str.strip()
        df_ref = df_ref.rename(columns={'name': 'ref_name', 'region': 'ref_zone_id'})
        gdf = gdf.merge(df_ref, on='code', how='left')
        gdf['zone_id'] = gdf['ref_zone_id'].fillna(0).astype(int)
        candidates_name = ['name', 'naim', 'leshoz', 'name_lx', 'text', 'l_name', 'name_rus']
        shp_name_col = next((c for c in gdf.columns if c in candidates_name), None)
        fallback_val = gdf[shp_name_col] if shp_name_col else gdf['code']
        gdf['final_name'] = gdf['ref_name'].combine_first(fallback_val)

        return gdf, None
    except Exception as e:
        logger.error(f"Processing Error: {e}")
        return None, str(e)


def load_leshoz_data():
    global _leshoz_gdf_cache
    if _leshoz_gdf_cache is not None:
        return _leshoz_gdf_cache, None
    # [v20.13] Загрузка целиком под замком: раньше замок закрывал только проверку,
    # и при холодном старте N потоков читали SHP одновременно (пик RAM × N).
    with _leshoz_cache_lock:
        if _leshoz_gdf_cache is not None:
            return _leshoz_gdf_cache, None
        shp_files = glob.glob(os.path.join(SHP_FOLDER, '*.shp'))
        if not shp_files:
            return None, "Файл .shp не найден в папке shp_leshoz"
        shp_path = shp_files[0]
        try:
            try:
                gdf = gpd.read_file(shp_path, encoding='cp1251')
            except Exception:
                gdf = gpd.read_file(shp_path, encoding='utf-8')
            gdf_processed, error = process_forestry_gdf(gdf)
            if error:
                return None, error
            _leshoz_gdf_cache = gdf_processed
            return gdf_processed, None
        except Exception as e:
            logger.error(f"SHP Load Error: {e}")
            return None, str(e)


# ==========================================
# 13. СИСТЕМА ТОКЕНОВ — хранение в SQLite users.db
# ==========================================
_tokens_lock = threading.Lock()

# ── Инициализация таблицы tokens при первом обращении ──────────────
def _ensure_tokens_table():
    conn = _get_conn(); cur = conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        token       TEXT    NOT NULL UNIQUE,
        user_id     INTEGER,
        ip          TEXT,
        token_type  TEXT    NOT NULL DEFAULT 'unlimited',
        layers      TEXT,
        file_path   TEXT,
        max_count   INTEGER,
        used_count  INTEGER NOT NULL DEFAULT 0,
        expires_at  TEXT,
        is_active   INTEGER NOT NULL DEFAULT 1,
        note        TEXT,
        issued_at   TEXT
    )""")
    conn.commit(); conn.close()

def _token_row_to_dict(row):
    d = dict(row)
    # Десериализуем layers из JSON-строки
    try:
        d['layers'] = json.loads(d['layers']) if d.get('layers') else None
    except Exception:
        d['layers'] = None
    d['is_active'] = bool(d.get('is_active', 1))
    # Нормализуем поля для совместимости с фронтендом
    d['type'] = d.get('token_type', 'unlimited')
    # Canonical profile and name live in PostgreSQL, not the old SQLite users.
    info = get_user_by_ip(d.get('ip') or '') or {}
    if info:
        d['user_id'] = info['id']
        d['user_name'] = info.get('user_name') or ''
    else:
        d['user_name'] = ''
        if d.get('user_id'):
            conn2 = _get_conn()
            try:
                row2 = conn2.execute('SELECT user_name FROM users WHERE id=?', (d['user_id'],)).fetchone()
                d['user_name'] = decrypt(row2['user_name']) if row2 and row2['user_name'] else ''
            except sqlite3.OperationalError:
                pass
            finally:
                conn2.close()
    return d

def token_issue(user_id, ip, token_type, layers=None, file_path=None,
                max_count=None, expires_in_hours=None, note=None):
    _ensure_tokens_table()
    token_str = str(_uuid_mod.uuid4())
    expires_at = (datetime.utcnow() + timedelta(hours=int(expires_in_hours))).strftime('%Y-%m-%d %H:%M:%S') \
        if expires_in_hours else None
    issued_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    layers_json = json.dumps(layers) if layers else None
    with _tokens_lock:
        conn = _get_conn(); cur = conn.cursor()
        cur.execute("""INSERT INTO tokens
            (token, user_id, ip, token_type, layers, file_path, max_count, used_count,
             expires_at, is_active, note, issued_at)
            VALUES (?,?,?,?,?,?,?,0,?,1,?,?)""",
            (token_str, user_id, ip, token_type, layers_json, file_path,
             max_count, expires_at, note, issued_at))
        new_id = cur.lastrowid
        conn.commit(); conn.close()
    return {
        "id": new_id, "token": token_str, "user_id": user_id, "ip": ip,
        "token_type": token_type, "type": token_type,
        "layers": layers, "file_path": file_path,
        "max_count": max_count, "used_count": 0,
        "expires_at": expires_at, "is_active": True,
        "note": note, "issued_at": issued_at,
    }


def token_revoke(token_id: int) -> bool:
    _ensure_tokens_table()
    with _tokens_lock:
        conn = _get_conn(); cur = conn.cursor()
        cur.execute("UPDATE tokens SET is_active=0 WHERE id=?", (token_id,))
        changed = cur.rowcount; conn.commit(); conn.close()
    return changed > 0


def token_validate(token_str: str, file_path: str = "") -> dict:
    _ensure_tokens_table()
    with _tokens_lock:
        conn = _get_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM tokens WHERE token=?", (token_str,))
        row = cur.fetchone(); conn.close()
    if not row:
        return {"ok": False, "reason": "Токен не найден"}
    rec = dict(row)
    if not rec["is_active"]:
        return {"ok": False, "reason": "Токен деактивирован"}
    if rec["expires_at"] and datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S') > rec["expires_at"]:
        return {"ok": False, "reason": "Токен просрочен"}
    if rec["token_type"] == "count":
        if (rec["used_count"] or 0) >= (rec["max_count"] or 1):
            return {"ok": False, "reason": "Лимит использований исчерпан"}
    if rec["token_type"] == "file" and rec["file_path"] and file_path:
        if rec["file_path"] != file_path:
            return {"ok": False, "reason": "Токен не предназначен для этого файла"}
    # Увеличиваем счётчик использований
    with _tokens_lock:
        conn = _get_conn(); cur = conn.cursor()
        cur.execute("UPDATE tokens SET used_count=used_count+1 WHERE token=?", (token_str,))
        conn.commit(); conn.close()
    return {"ok": True, "reason": "ok"}


def token_auto_deactivate_expired():
    _ensure_tokens_table()
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    with _tokens_lock:
        conn = _get_conn(); cur = conn.cursor()
        cur.execute("UPDATE tokens SET is_active=0 WHERE expires_at IS NOT NULL AND expires_at < ? AND is_active=1", (now,))
        conn.commit(); conn.close()


def token_get_by_ip(ip: str):
    _ensure_tokens_table()
    conn = _get_conn(); cur = conn.cursor()
    cur.execute("SELECT * FROM tokens WHERE ip=? ORDER BY id DESC", (ip,))
    rows = cur.fetchall(); conn.close()
    return [_token_row_to_dict(r) for r in rows]


def token_get_all():
    _ensure_tokens_table()
    conn = _get_conn(); cur = conn.cursor()
    cur.execute("SELECT * FROM tokens ORDER BY id DESC")
    rows = cur.fetchall(); conn.close()
    return [_token_row_to_dict(r) for r in rows]


# ==========================================
# 14. DOWNLOAD TOKENS (v2)
# ==========================================
_dl_tokens2: dict = {}
_dl_lock2 = threading.Lock()
_DL_TTL2  = 600  # 10 минут


def _dl_cleanup2():
    now = time.time()
    with _dl_lock2:
        dead = [k for k, v in _dl_tokens2.items() if v['expires'] < now]
        for k in dead:
            del _dl_tokens2[k]


# ==========================================
# 15. ФОНОВЫЕ ЗАДАЧИ
# ==========================================

def _tokens_cleanup_loop():
    time.sleep(30)  # ждём полной инициализации приложения (_get_conn определяется позже)
    while True:
        try:
            token_auto_deactivate_expired()
        except Exception as e:
            logger.error(f"[token cleanup] {e}")
        time.sleep(600)


threading.Thread(target=_tokens_cleanup_loop, daemon=True).start()

# ==========================================
# 16. МАРШРУТЫ — AUTH
# ==========================================

# ── [SEC] Защита входа от подбора пароля ────────────────────────────────────
# nginx ограничивает частоту запросов (login_limit 5 r/m), но лимит по частоте
# не останавливает медленный перебор «по паролю в минуту» за сутки. Здесь —
# блокировка по IP после серии неудач, с экспоненциальным окном.
_LOGIN_MAX_FAILS   = int(os.getenv("LOGIN_MAX_FAILS", "5"))       # неудач до блокировки
_LOGIN_LOCK_SEC    = int(os.getenv("LOGIN_LOCK_SECONDS", "900"))  # базовая блокировка, 15 мин
_LOGIN_FAIL_WINDOW = 3600                                          # окно подсчёта неудач, 1 ч
_login_fails: dict = {}   # ip → {"n": int, "first": ts, "until": ts}
_login_fails_lock = threading.Lock()


def _login_locked_for(ip: str) -> int:
    """Сколько секунд осталось до разблокировки IP (0 — не заблокирован)."""
    now = time.time()
    with _login_fails_lock:
        rec = _login_fails.get(ip)
        if not rec:
            return 0
        if rec.get("until", 0) > now:
            return int(rec["until"] - now)
        # Окно подсчёта истекло — забываем старые неудачи
        if now - rec.get("first", now) > _LOGIN_FAIL_WINDOW:
            _login_fails.pop(ip, None)
        return 0


def _login_register_fail(ip: str) -> None:
    now = time.time()
    with _login_fails_lock:
        rec = _login_fails.get(ip)
        if not rec or now - rec.get("first", now) > _LOGIN_FAIL_WINDOW:
            rec = {"n": 0, "first": now, "until": 0}
        rec["n"] += 1
        if rec["n"] >= _LOGIN_MAX_FAILS:
            # Каждая следующая серия неудач блокирует дольше (15 мин → 30 → 60 …)
            factor = 2 ** max(0, (rec["n"] - _LOGIN_MAX_FAILS))
            rec["until"] = now + min(_LOGIN_LOCK_SEC * factor, 24 * 3600)
        _login_fails[ip] = rec
        if len(_login_fails) > 5000:
            _login_fails.pop(next(iter(_login_fails)), None)


def _login_register_success(ip: str) -> None:
    with _login_fails_lock:
        _login_fails.pop(ip, None)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    # [C] Токен создаётся заранее, чтобы форма могла его отправить обратно
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"csrf_token": get_csrf_token(request)},
    )


@app.post("/login")
async def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    # [FIX] Имя параметра БЕЗ ведущего подчёркивания: pydantic запрещает такие
    # имена полей и приложение падало на старте с
    #   NameError: Fields must not use names with leading underscores
    # Имя поля в HTML-форме остаётся _csrf_token — оно задаётся через alias.
    csrf_token: str = Form("", alias="_csrf_token"),
):
    ip = get_real_ip(request)

    # 1) IP под блокировкой после серии неудачных попыток
    left = _login_locked_for(ip)
    if left:
        logger.warning("[login] IP %s заблокирован ещё %s c (перебор пароля)", ip, left)
        return templates.TemplateResponse(
            request=request,
            name="login.html",
            context={
                "csrf_token": get_csrf_token(request),
                "error": f"Слишком много неудачных попыток. Повторите через {left // 60 + 1} мин.",
            },
            status_code=429,
        )

    # 2) CSRF: форма обязана вернуть токен, выданный на GET /login
    session_token = request.session.get("csrf_token")
    if not session_token or not _secrets.compare_digest(csrf_token or "", session_token):
        return templates.TemplateResponse(
            request=request,
            name="login.html",
            context={
                "csrf_token": get_csrf_token(request),
                "error": "Сессия устарела, отправьте форму заново",
            },
            status_code=403,
        )

    # 3) Проверка пароля. compare_digest по имени пользователя — чтобы время
    #    ответа не подсказывало, существует ли логин.
    user_ok = _secrets.compare_digest(username or "", "admin")
    pass_ok = await run_in_threadpool(check_password_hash, ADMIN_USER["password_hash"], password)
    if user_ok and pass_ok:
        _login_register_success(ip)
        # Смена идентификатора сессии после входа — против session fixation
        request.session.clear()
        request.session["user_id"] = ADMIN_USER["id"]
        get_csrf_token(request)
        logger.info("[login] успешный вход администратора с IP %s", ip)
        return RedirectResponse(url="/", status_code=302)

    _login_register_fail(ip)
    logger.warning("[login] неудачная попытка входа с IP %s (логин=%r)", ip, username[:40])
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={
            "csrf_token": get_csrf_token(request),
            "error": "Неверный логин или пароль",
        },
        status_code=400,
    )


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/", status_code=302)


@app.post("/api/admin/logout")
async def api_admin_logout(request: Request):
    request.session.clear()
    return {"ok": True}


# ==========================================
# 17. МАРШРУТЫ — INDEX + STATIC
# ==========================================

# ── [v20.4] Превью-страница геосервиса (лендинг): /preview и /about ──────────────────────
# Статичный static/preview/index.html + медиа static/preview/media/ (готовит
# tools/preview/make_preview_media.py). Маршрут подставляет ?v= и абсолютный og:image.
try:
    import preview_page as _preview_page
    app.include_router(_preview_page.build_router(BASE_DIR, version=lambda: str(APP_VERSION)))
except Exception as _e:  # страница необязательна — сервис работает и без неё
    logger.warning(f"[v20.4] превью-страница не подключена: {_e}")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, db: Session = Depends(get_db)):
    ip      = get_real_ip(request)
    user_id = get_current_user(request)

    # ── ADMIN_IP опознаётся, но права — только после доп. пароля ──────────────────────────
    # Если запрос пришёл с IP администратора — сразу считаем его админом
    # и сохраняем user_id в сессию (чтобы все require_admin маршруты работали)
    if not user_id and ip == ADMIN_IP and not request.session.get("adm2_skip"):
        request.session["user_id"] = ADMIN_USER["id"]   # опознан по IP; права — после доп. пароля
        user_id = get_current_user(request)

    is_admin = bool(user_id)

    # ── Авто-вход по зарегистрированному IP ───────────────────────────────
    ip_user_name   = ""
    ip_org_name    = ""
    ip_has_profile = False

    if not is_admin:
        ip_user = await run_in_threadpool(get_user_by_ip, ip)
        if ip_user and ip_user.get('status') not in ('deleted', 'frozen', 'banned'):
            ip_user_name   = (ip_user.get('user_name', '') or '').strip()
            ip_org_name    = (ip_user.get('organization_name', '') or '').strip()
            ip_has_profile = bool(ip_user_name or ip_org_name)

    # Регистрируем визит только для настоящих гостей
    if not is_admin and not ip_has_profile:
        await run_in_threadpool(register_visit, ip)

    has_profile   = is_admin or ip_has_profile
    is_registered = has_profile
    display_name  = ("Admin" if is_admin else (ip_user_name or ip_org_name or ""))

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "is_admin":      is_admin,
            "is_admin_ip":   ip == ADMIN_IP,
            "user_ip":       ip,
            "client_ip":     ip,
            "has_profile":   has_profile,
            "is_registered": is_registered,
            "user_name":     display_name,
            "profile_name":  ip_user_name,
            "profile_org":   ip_org_name,
            # [v18 PERF] первая новость рисуется сервером (LCP), остальные — JS, как раньше
            "news_first":    _news_ssr_first(),
            # [C] CSRF-токен передаётся в шаблон для подстановки в мета-тег
            "csrf_token":    get_csrf_token(request),
            # [F] version для cache-busting (убрать если уже определена)
            "version":       APP_VERSION,
        }
    )

@app.post("/api/session/register")
async def api_session_register(request: Request):
    """Регистрация сессии гостя — заглушка для совместимости."""
    ip = get_real_ip(request)
    return {"ok": True, "ip": ip, "status": "guest"}

@app.get("/map.js")
async def serve_map_js(request: Request):
    static_path = os.path.join(BASE_DIR, 'static', 'map.js')
    root_path   = os.path.join(BASE_DIR, 'map.js')
    path = static_path if os.path.exists(static_path) else root_path

    # ETag по mtime+size — быстро (не читает весь файл), пересчитывается только при изменении.
    # Браузер при повторном открытии страницы шлёт If-None-Match → получает 304 (0 байт трафика).
    # При обновлении map.js ETag меняется → браузер загружает свежую версию (200).
    try:
        st = os.stat(path)
        _etag = f'"{int(st.st_mtime)}-{st.st_size}"'
    except OSError:
        _etag = '"unknown"'

    if request.headers.get("If-None-Match") == _etag:
        return Response(status_code=304)

    return FileResponse(
        path,
        media_type="application/javascript",
        headers={
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=60",
            "ETag": _etag,
        },
    )


# ==========================================
# 18. WMS ENDPOINT
# ==========================================

@app.get("/wms")
async def wms_endpoint(request: Request, db: Session = Depends(get_db)):
    args = {k.upper(): v for k, v in request.query_params.items()}
    req_type = args.get('REQUEST', '')
    if req_type == 'GetCapabilities':
        return _get_capabilities()
    elif req_type == 'GetMap':
        _bad = _wms_params_error(args)
        if _bad:
            return Response(_bad, status_code=400, media_type="text/plain; charset=utf-8")
        # [v20.13] запрос к PostGIS, rasterio и кодирование PNG — в threadpool
        return await run_in_threadpool(_get_map, args, db)
    return Response("Unknown Request", status_code=400)


def _get_capabilities():
    xml = """<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
    <WMS_Capabilities version="1.1.1">
    <Service><Name>WMS</Name><Title>DZZ Forestry WMS</Title></Service>
    <Capability><Request>
      <GetCapabilities><Format>application/vnd.ogc.wms_xml</Format></GetCapabilities>
      <GetMap><Format>image/png</Format></GetMap>
    </Request>
    <Layer><Title>Лесные Снимки</Title><SRS>EPSG:4326</SRS>
      <Layer><Name>dzz_imagery</Name><Title>Все снимки</Title>
        <SRS>EPSG:4326</SRS></Layer>
    </Layer></Capability></WMS_Capabilities>"""
    return Response(xml, media_type="application/xml")


def _get_map(args: dict, db: Session):
    try:
        bbox_str   = args.get('BBOX', '-180,-90,180,90')
        width      = int(args.get('WIDTH', 256))
        height     = int(args.get('HEIGHT', 256))
        filter_year = args.get('YEAR')
        filter_type = args.get('TYPE')

        coords = list(map(float, bbox_str.split(',')))
        minx, miny, maxx, maxy = coords

        screen_geom = func.ST_MakeEnvelope(minx, miny, maxx, maxy, 4326)
        query = db.query(Imagery).filter(func.ST_Intersects(Imagery.geom, screen_geom))
        if filter_year:
            query = query.filter(Imagery.date_shot.like(f"%{filter_year}%"))
        if filter_type:
            query = query.filter(Imagery.survey_type == filter_type)

        relevant_images = query.order_by(Imagery.date_shot.asc()).all()
        canvas = np.zeros((4, height, width), dtype=np.uint8)
        dst_transform = from_bounds(minx, miny, maxx, maxy, width, height)

        for row in relevant_images:
            file_path = os.path.join(UPLOAD_FOLDER, row.filename)
            if not os.path.exists(file_path):
                continue
            try:
                with rasterio.Env(CPL_LOCALE='C', CPL_LOG='NUL'):
                    with rasterio.open(file_path) as src:
                        src_transform = src.transform
                        if src_transform.is_identity:
                            tfw_name = row.tfw_filename or (
                                os.path.splitext(row.filename)[0] + ".tfw")
                            tfw_full = os.path.join(UPLOAD_FOLDER, tfw_name)
                            if os.path.exists(tfw_full):
                                manual = parse_tfw(tfw_full)
                                if manual:
                                    src_transform = manual
                        src_crs = src.crs or SK42_CRS
                        source_dtype = src.profile['dtype']
                        temp_rgb = np.zeros((3, height, width), dtype=source_dtype)
                        reproject(
                            source=(rasterio.band(src, [1, 2, 3])
                                    if src.count >= 3 else rasterio.band(src, 1)),
                            destination=temp_rgb,
                            src_transform=src_transform, src_crs=src_crs,
                            dst_transform=dst_transform, dst_crs='EPSG:4326',
                            resampling=Resampling.bilinear,
                            src_nodata=0, dst_nodata=0,
                        )
                        if src.count >= 3:
                            mask = (
                                (temp_rgb[0] > 5) |
                                (temp_rgb[1] > 5) |
                                (temp_rgb[2] > 5)
                            )
                        else:
                            mask = temp_rgb[0] > 0
                        for b in range(3):
                            band_norm = (normalize_band(temp_rgb[b])
                                         if src.count >= 3
                                         else normalize_band(temp_rgb[0]))
                            canvas[b][mask] = band_norm[mask]
                        canvas[3][mask] = 255
            except Exception as e:
                logger.warning(f"Ошибка рендеринга {row.filename}: {e}")
                continue

        pil_img = Image.fromarray(np.moveaxis(canvas, 0, -1), 'RGBA')
        img_io = io.BytesIO()
        pil_img.save(img_io, 'PNG', optimize=False, compress_level=6)  # optimize=True ×2-3 CPU без выигрыша для тайла
        img_io.seek(0)
        return Response(
            img_io.read(),
            media_type="image/png",
            headers={
                # Разрешаем nginx кэшировать WMS тайлы на 6 часов
                "Cache-Control": "public, max-age=300, s-maxage=21600",
                "X-Accel-Expires": "21600",
                "Vary": "",
            },
        )
    except Exception as e:
        logger.error(f"WMS Error: {e}")
        return Response(f"WMS Error: {e}", status_code=500)


# ==========================================
# 19. API — ГРАНИЦЫ ЛЕСХОЗОВ И ЗОН
# ==========================================

# [PERF] Раньше КАЖДЫЙ запрос заново делал gdf.to_json() → json.loads → json.dumps
# (несколько МБ геометрии), а /api/zones-boundaries ещё и unary_union по всем
# лесхозам — сотни миллисекунд CPU на запрос при каждом открытии карты.
# Теперь тело ответа собирается один раз и хранится в памяти вместе с ETag;
# браузер получает 304 без тела, nginx/Service Worker держат копию.
# Сброс — /api/admin/reset-boundary-cache.
_geojson_resp_cache: dict = {}          # name -> (body: bytes, etag: str)
_geojson_resp_lock = _asyncio.Lock()
_GEOJSON_HEADERS = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"


def _build_forestry_geojson() -> bytes:
    gdf, error = load_leshoz_data()
    if error:
        raise RuntimeError(error)
    cols = ['final_name', 'code', 'zone_id', 'geometry']
    actual = [c for c in cols if c in gdf.columns]
    # to_json() уже возвращает валидный JSON — без лишнего loads/dumps
    return gdf[actual].to_json(ensure_ascii=False).encode('utf-8')


def _build_zones_geojson() -> bytes:
    gdf, error = load_leshoz_data()
    if error:
        raise RuntimeError(error)
    features = []
    for zone_id, group in gdf.groupby('zone_id'):
        merged = unary_union(group.geometry)
        features.append({
            "type": "Feature",
            "geometry": mapping(merged),
            "properties": {"zone_id": int(zone_id)},
        })
    return json.dumps({"type": "FeatureCollection", "features": features},
                      ensure_ascii=False, separators=(',', ':')).encode('utf-8')


async def _cached_geojson_response(request: Request, name: str, builder) -> Response:
    entry = _geojson_resp_cache.get(name)
    if entry is None:
        async with _geojson_resp_lock:
            entry = _geojson_resp_cache.get(name)
            if entry is None:
                try:
                    body = await run_in_threadpool(builder)
                except Exception as e:
                    raise HTTPException(500, str(e))
                entry = (body, '"' + hashlib.md5(body).hexdigest()[:20] + '"')
                _geojson_resp_cache[name] = entry
    body, etag = entry
    headers = {"Cache-Control": _GEOJSON_HEADERS, "ETag": etag}
    if request.headers.get("If-None-Match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


@app.get("/api/forestry-boundaries")
async def api_forestry_boundaries(request: Request):
    return await _cached_geojson_response(request, "forestry", _build_forestry_geojson)


@app.get("/api/zones-boundaries")
async def api_zones_boundaries(request: Request):
    return await _cached_geojson_response(request, "zones", _build_zones_geojson)


# ==========================================
# 19b. API — ГРАНИЦА РБ (МАСКА)
# Используется map.js для построения белой маски поверх карты.
# Контур = точный unary_union всех полигонов лесхозов.
# БЕЗ буферизации — совпадает с forestry-boundaries пиксель в пиксель.
# Кэшируется в памяти + ETag + Cache-Control для nginx proxy_cache.
# ==========================================

_cb_cache_body: bytes = b""
_cb_cache_etag: str   = ""
_cb_lock = _asyncio.Lock()  # [v20.13] был threading.Lock поперёк await — второй запрос намертво вешал event loop


def _build_country_boundary() -> bytes:
    """
    Строит GeoJSON внешнего контура РБ как unary_union лесхозов.
    Буфер +50м / -50м закрывает микро-зазоры между лесхозами,
    не искажая внешнюю границу визуально.
    """
    from shapely.geometry import MultiPolygon, Polygon

    gdf, err = load_leshoz_data()
    if gdf is None or err:
        raise RuntimeError(err or "Нет данных лесхозов")

    # 1. Чистим геометрию
    geoms = [g.buffer(0) for g in gdf.geometry if g is not None and not g.is_empty]
    if not geoms:
        raise RuntimeError("Пустой список геометрий лесхозов")

    # 2. Объединяем с буфером +0.0005° (~50м) чтобы закрыть зазоры между лесхозами,
    #    потом убираем буфер -0.0005° чтобы вернуть точную внешнюю границу
    union = unary_union(geoms)
    union = union.buffer(0.0005).buffer(-0.0005)

    # 3. Убираем все внутренние дыры (holes) — оставляем только внешний контур
    def remove_holes(geom):
        if geom.geom_type == 'Polygon':
            return Polygon(geom.exterior)
        elif geom.geom_type == 'MultiPolygon':
            return MultiPolygon([Polygon(p.exterior) for p in geom.geoms])
        return geom

    union = remove_holes(union)

    # 4. Лёгкое сглаживание для уменьшения размера JSON
    union = union.simplify(0.0003, preserve_topology=True)

    # 5. Убираем мелкие осколки (< ~10 км²)
    if union.geom_type == "MultiPolygon":
        big = [p for p in union.geoms if p.area > 0.001]
        if big:
            union = MultiPolygon(big) if len(big) > 1 else big[0]

    result = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": mapping(union), "properties": {}}]
    }
    return json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


@app.get("/api/country-boundary")
async def api_country_boundary(request: Request):
    """
    Внешний контур РБ (union лесхозов без буферизации).
    Отдаёт ETag + Cache-Control → nginx кэширует 1 час.
    """
    global _cb_cache_body, _cb_cache_etag

    if not _cb_cache_body:
        async with _cb_lock:
            if not _cb_cache_body:
                try:
                    _cb_cache_body = await run_in_threadpool(_build_country_boundary)
                    import hashlib as _hlib
                    _cb_cache_etag = '"' + _hlib.md5(_cb_cache_body).hexdigest()[:16] + '"'
                    logger.info(
                        f"[country-boundary] Построен: "
                        f"{len(_cb_cache_body)//1024} КБ, etag={_cb_cache_etag}"
                    )
                except Exception as e:
                    logger.error(f"[country-boundary] Ошибка: {e}")
                    # Фолбэк — пустая коллекция, чтобы маска не блокировала загрузку
                    _cb_cache_body = b'{"type":"FeatureCollection","features":[]}'
                    _cb_cache_etag = '"fallback"'

    # 304 если клиент/nginx уже имеет актуальную версию
    if request.headers.get("If-None-Match") == _cb_cache_etag:
        return Response(status_code=304)

    return Response(
        content=_cb_cache_body,
        media_type="application/json; charset=utf-8",
        headers={
            # Браузер держит 5 мин, nginx — 1 час (s-maxage)
            "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=60",
            "ETag": _cb_cache_etag,
            "Vary": "Accept-Encoding",
            "X-Accel-Expires": "3600",
        },
    )
# ============================================================
# ОПТИМИЗАЦИЯ ДЛЯ 100+ СНИМКОВ: раздельные семафоры
# ============================================================
# bounds-слои (контуры) — лёгкие PNG полигонов, GeoServer отдаёт мгновенно.
# Разрешаем 24 параллельных — они не нагружают рендеринг.
_gs_bounds_semaphore = _asyncio.Semaphore(24)

# COG-снимки — тяжёлый рендеринг, GeoServer ограничен памятью/CPU.
# После заполнения GWC-кэша можно поднять до 16.
# Без GWC-кэша держим 8 чтобы не убить GeoServer.
_gs_cog_semaphore = _asyncio.Semaphore(8)

# [FIX] «Все спутниковые снимки» (LAYERS=kosmo_snimki vse) — это ImageMosaic,
# который на каждый GetMap компонует ДЕСЯТКИ пересекающихся COG-гранул
# (особенно на дальнем зуме) — на порядок тяжелее обычного одиночного
# COG-слоя. Раньше он делил общий 8-слотовый _gs_cog_semaphore с обычными
# снимками: пока в этом пуле были заняты слоты векторными оверлеями
# (см. предыдущий фикс — теперь vector ушёл в отдельный пул), эффективная
# конкурентность мозаики СЛУЧАЙНО оказывалась ниже 8 и GeoServer как-то
# справлялся. После того как vector перестал делить с ним пул, до 8
# запросов мозаики стали реально долетать до GeoServer ОДНОВРЕМЕННО —
# и он захлёбывается: часть запросов сразу рвётся с ConnectionError
# (сервер отказывается принимать новые соединения, пока занят предыдущими),
# часть висит до собственного таймаута в 35с. Даём мозаике СВОЙ маленький
# семафор — она физически не может параллелиться так же, как лёгкий COG.
_gs_mosaic_semaphore = _asyncio.Semaphore(2)

# [FIX] ПОДЛОЖКА ДЗЗ (LAYERS=External:Подложка ДЗЗ, _kind=basemap) — отдельный пул.
#
# СИМПТОМ: подложка ДЗЗ прогружалась только частью охвата — посреди страны
# оказывался прямоугольный «остров» тайлов, всё остальное оставалось белым,
# и само по себе это не чинилось.
#
# ПРИЧИНА: подложка — это ЕДИНСТВЕННЫЙ слой, который на обзорном зуме требует
# сразу 30–60 GetMap-тайлов на весь экран. Раньше она попадала в общий
# _gs_cog_semaphore (8 слотов) вместе с обычными COG-снимками. Тайлы, не
# получившие слот за 12с × 3 попытки, возвращались как 504 с пустым PNG, а
# OpenLayers помечал такой тайл ERROR навсегда (повторов он не делает).
# Отсюда и «прогрузился только кусок».
#
# РЕШЕНИЕ: свой семафор (подложка не должна конкурировать со снимками ни в ту,
# ни в другую сторону) + увеличенный таймаут ниже. 6 слотов совпадают с лимитом
# параллельных запросов, который теперь держит фронтенд (map-core.js,
# _DZZ_MAX_PARALLEL) и с лимитом HTTP/1.1-соединений браузера на хост —
# очередь не растёт, таймауты не накапливаются.
_gs_basemap_semaphore = _asyncio.Semaphore(6)

# Обратная совместимость: старый код ссылается на _gs_wms_semaphore
_gs_wms_semaphore = _gs_cog_semaphore

# Выделенный пул потоков для тайловых запросов.
# 40 потоков: bounds 24 + COG 8 + мозаика 2 + подложка ДЗЗ 6 = 40 одновременных HTTP.
# [FIX] Было 32 — ровно под bounds+COG. После появления отдельного пула подложки
# ДЗЗ её запросы вставали в очередь ЗА пределами семафора, уже внутри пула потоков,
# и «съедали» свой таймаут, ничего не делая. Пул расширен под все семафоры сразу.
_tile_executor = _futures.ThreadPoolExecutor(max_workers=40, thread_name_prefix="tile")

# Сессия для тайлов: пул соединений под новый параллелизм.
# Retry(total=0): быстрый fallback, браузер сам перезапросит.
_tile_session = requests.Session()
_tile_adapter = HTTPAdapter(
    pool_connections=32,
    pool_maxsize=64,
    max_retries=Retry(total=0),
)
_tile_session.mount('http://', _tile_adapter)
_tile_session.mount('https://', _tile_adapter)

# ==========================================
# МАСКА ЛЕСХОЗА ДЛЯ БАЗОВОГО ЛЕСОУСТРОЙСТВА
# ==========================================
# Словарь: имя WMS-слоя (LAYERS параметр) → код лесхоза из SHP
_LU_LAYER_TO_LESHOZ_CODE = {
    'External:Starodoroshski_wgs84_deflate_cog': '517',
    'External:logoisk_wgs84_deflate_cog':        '508',
    'External:slonim_wgs84_deflate_cog':         '408',
    'External:kopil_wgs84_deflate_cog':          '506',
    'External:lida_wgs84_deflate_cog':           '405',
    'External:Дисненский лесхоз':                '209',
    'External:Слуцкий лесхоз':                   '514',
    'External:Любанский лесхоз':                 '509',
    'External:Бегомельский лесхоз':              '201',
    'External:Суражский лесхоз':                 '215',
    'External:Волковысский лесхоз':              '401',
}

# ── Кэш геометрий лесхозов: code → shapely geometry (один раз навсегда) ──────
_leshoz_geom_cache: dict = {}
_leshoz_geom_cache_lock = threading.Lock()

def _get_leshoz_geom(leskhoz_code: str):
    """Возвращает объединённую геометрию лесхоза из кэша (вычисляется один раз)."""
    with _leshoz_geom_cache_lock:
        if leskhoz_code in _leshoz_geom_cache:
            return _leshoz_geom_cache[leskhoz_code]
    gdf, err = load_leshoz_data()
    if err or gdf is None:
        return None
    rows = gdf[gdf['code'] == leskhoz_code]
    if rows.empty:
        return None
    geom = unary_union(rows.geometry.values)
    if geom is None or geom.is_empty:
        return None
    with _leshoz_geom_cache_lock:
        _leshoz_geom_cache[leskhoz_code] = geom
    return geom

# ── Кэш numpy bool-масок: (code, w, h, bbox_tuple) → np.ndarray ──────────────
# Храним numpy, не PNG — нет лишнего encode/decode при каждом применении.
_leshoz_mask_cache: dict = {}
_leshoz_mask_cache_lock = threading.Lock()
_LESHOZ_MASK_CACHE_MAX = 1000

def _get_leshoz_mask_arr(leskhoz_code: str, bbox: list, width: int, height: int):
    """Возвращает bool-маску (HxW numpy): True = внутри лесхоза."""
    from rasterio.features import rasterize as _rasterize
    from rasterio.transform import from_bounds as _from_bounds

    cache_key = (leskhoz_code, width, height, tuple(round(b, 6) for b in bbox))
    with _leshoz_mask_cache_lock:
        if cache_key in _leshoz_mask_cache:
            return _leshoz_mask_cache[cache_key]

    geom = _get_leshoz_geom(leskhoz_code)
    if geom is None:
        return None

    transform = _from_bounds(bbox[0], bbox[1], bbox[2], bbox[3], width, height)
    try:
        arr = _rasterize(
            [(geom, 1)],
            out_shape=(height, width),
            transform=transform,
            fill=0,
            dtype='uint8',
            all_touched=True,
        ).astype(bool)
    except Exception as e:
        logger.warning(f"_get_leshoz_mask_arr rasterize error: {e}")
        return None

    with _leshoz_mask_cache_lock:
        _leshoz_mask_cache[cache_key] = arr
        while len(_leshoz_mask_cache) > _LESHOZ_MASK_CACHE_MAX:
            del _leshoz_mask_cache[next(iter(_leshoz_mask_cache))]
    return arr


def _apply_leshoz_mask_to_png(image_bytes: bytes, leskhoz_code: str,
                               bbox: list, width: int, height: int) -> bytes:
    """Обрезает PNG по границе лесхоза. Пиксели снаружи → alpha=0."""
    try:
        mask_arr = _get_leshoz_mask_arr(leskhoz_code, bbox, width, height)
        if mask_arr is None:
            return image_bytes
        src_arr = np.array(Image.open(io.BytesIO(image_bytes)).convert('RGBA'))
        src_arr[:, :, 3] = np.where(mask_arr, src_arr[:, :, 3], 0)
        buf = io.BytesIO()
        Image.fromarray(src_arr, mode='RGBA').save(buf, format='PNG')
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"_apply_leshoz_mask_to_png error: {e}")
        return image_bytes


# Обычные тайлы — кэшируются nginx 12 часов
_TILE_RESPONSE_HEADERS = {
    "Cache-Control": "public, max-age=86400, s-maxage=604800",   # nginx кэш 7 дней
    "X-Accel-Expires": "604800",                                  # ИСПРАВЛЕНО: 7 дней (было 1 день)
    "Vary": "",
}
# Masked ЛУ-тайлы — nginx НЕ кэширует (X-Accel-Expires: 0).
# Python in-memory кэш (_tile_cache) работает нормально — быстро при повторных запросах.
# Это единственный способ гарантировать что nginx никогда не отдаст тайл без маски.
_TILE_MASKED_HEADERS = {
    "Cache-Control": "public, max-age=43200, s-maxage=43200",
    "X-Accel-Expires": "43200",   # 12 часов
    "Vary": "",
}
# [FIX] GetFeatureInfo (идентификация объекта по клику) — НИКОГДА не кэшируется
# ни в nginx, ни в браузере. Раньше эти запросы получали ТЕ ЖЕ заголовки, что
# и обычные тайлы (_TILE_RESPONSE_HEADERS, X-Accel-Expires: 604800 = 7 дней!),
# потому что заголовки выбирались ДО проверки типа запроса. В итоге первый же
# (даже случайно неточный) ответ для конкретных X/Y/BBOX «прилипал» в кэше
# nginx на 7 дней — повторный клик в то же место у границы лесхозов всегда
# возвращал застрявший старый результат, пока BBOX не менялся (зум/пан),
# что и создавало иллюзию «чинится зумом».
_FEATURE_INFO_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "X-Accel-Expires": "0",
    "Pragma": "no-cache",
    "Vary": "",
}

@app.get("/belgosles_wms_proxy")
async def belgosles_wms_proxy(request: Request):
    """Алиас — перенаправляет BELGOSLES/COVERSTYLE запросы через geoserver_wms_proxy."""
    import asyncio as _asyncio
    wms_key = request.query_params.get("_wms", "BELGOSLES")
    base_urls = {
        "BELGOSLES":  "https://bank.belgosles.by/geoserver/BelGosLes/wms",
        "COVERSTYLE": "https://bank.belgosles.by/geoserver/CoverStyleManage/wms",
    }
    url = base_urls.get(wms_key, base_urls["BELGOSLES"])
    params = {k: v for k, v in request.query_params.items() if k not in ("_wms", "_target")}
    # [FIX] Раньше эта функция не ставила НИКАКИХ cache-заголовков — из-за этого
    # nginx применял свой дефолт для проксируемых WMS-путей (тот же, что и для тайлов:
    # max-age=86400, s-maxage=604800), и GetFeatureInfo-ответ (идентификация по клику)
    # «прилипал» в кэше на 7 дней независимо от X/Y следующего клика.
    # Явно запрещаем кэш для GetFeatureInfo — так же, как уже сделано в geoserver_wms_proxy.
    _req_type = params.get("REQUEST", params.get("request", "")).upper()
    # [PERF v9] Тайлы BelGosLes/CoverStyle раньше шли мимо кэша и без ограничения
    # параллелизма — теперь через общий geoserver_wms_proxy (RAM/Redis-кэш, ETag,
    # объединение одинаковых запросов, быстрый семафор для векторных слоёв).
    if _req_type in ("GETMAP", "GETLEGENDGRAPHIC"):
        _tgt = wms_key if wms_key in base_urls else "BELGOSLES"
        _qs = [(k, v) for k, v in request.query_params.multi_items() if k not in ("_wms", "_target", "_kind")]
        _qs += [("_target", _tgt), ("_kind", request.query_params.get("_kind") or "vector")]
        _scope = dict(request.scope)
        _scope["query_string"] = urlencode(_qs).encode("ascii")
        return await geoserver_wms_proxy(Request(_scope, request.receive))
    _resp_headers = _FEATURE_INFO_HEADERS if _req_type == "GETFEATUREINFO" else {}
    try:
        def _fetch():
            return _tile_session.get(url, params=params, timeout=12)
        resp = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch)
        ct = resp.headers.get("Content-Type", "application/json")
        return Response(resp.content, status_code=resp.status_code, media_type=ct, headers=_resp_headers)
    except Exception as e:
        logger.warning(f"belgosles_wms_proxy: {e}")
        return Response(b'{"type":"FeatureCollection","features":[]}', media_type="application/json", headers=_resp_headers)

@app.get("/belgosles_wfs_proxy")
async def belgosles_wfs_proxy(request: Request):
    """
    Прокси для WFS-запросов к bank.belgosles.by (BelGosLes и CoverStyleManage).
    Используется поиском на фронтенде: DescribeFeatureType + GetFeature (с cql_filter).
    Параметр _target=BELGOSLES|COVERSTYLE определяет workspace GeoServer.
    """
    import asyncio as _asyncio
    wfs_base_urls = {
        "BELGOSLES":    "https://bank.belgosles.by/geoserver/BelGosLes/wfs",
        "COVERSTYLE":   "https://bank.belgosles.by/geoserver/CoverStyleManage/wfs",
    }
    target = request.query_params.get("_target", "BELGOSLES")
    url = wfs_base_urls.get(target, wfs_base_urls["BELGOSLES"])

    # Убираем служебные параметры фронтенда, остальное передаём как есть
    params = {k: v for k, v in request.query_params.items() if k not in ("_target", "_wms")}

    req_type = params.get("request", params.get("REQUEST", "")).upper()

    # Для GetFeature принудительно выставляем outputFormat и srsName если не заданы
    if req_type == "GETFEATURE":
        params.setdefault("outputFormat", "application/json")
        params.setdefault("srsName", "EPSG:4326")

    _ckey = url + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    _cache = _wfs_schema_cache if req_type == "DESCRIBEFEATURETYPE" else _wfs_resp_cache
    _hit = _cache.get(_ckey)
    if _hit:
        return Response(_hit[0], media_type=_hit[1])
    try:
        def _fetch():
            return _tile_session.get(url, params=params, timeout=(5, 20))
        resp = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch)
        ct = resp.headers.get("Content-Type", "application/json")
        # DescribeFeatureType возвращает XML — пробрасываем с правильным content-type
        if req_type == "DESCRIBEFEATURETYPE" or "xml" in ct:
            media = "application/xml"
        else:
            media = "application/json"
        if resp.status_code == 200 and b"Exception" not in resp.content[:400]:
            _cache.put(_ckey, (resp.content, media))
        return Response(resp.content, status_code=resp.status_code, media_type=media)
    except Exception as e:
        logger.warning(f"belgosles_wfs_proxy error: {e}")
        return Response(
            b'{"type":"FeatureCollection","features":[]}',
            media_type="application/json",
            headers={}
        )

def _tile_ok_response(request: Request, content: bytes, ct: str, base_headers: dict) -> Response:
    """200 c ETag (или 304, если у браузера та же версия) — для ЛЮБОГО пути
    отдачи тайла: раньше ETag ставился только на «промахе» кэша, а хиты
    из LRU/Redis уходили без него → браузер не мог ревалидировать тайл."""
    etag = '"' + hashlib.md5(content).hexdigest()[:16] + '"'
    hdrs = dict(base_headers)
    hdrs["ETag"] = etag
    if request.headers.get("If-None-Match") == etag:
        return Response(status_code=304, headers=hdrs)
    return Response(content, media_type=ct, headers=hdrs)


@functools.lru_cache(maxsize=1)
def _get_3857_to_4326():
    import pyproj as _pyproj
    return _pyproj.Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)


# [PERF] Single-flight: когда несколько вкладок/пользователей одновременно
# запрашивают ОДИН И ТОТ ЖЕ тайл (типично — обзорный зум при открытии карты),
# раньше каждый запрос отдельно занимал слот семафора и ходил в GeoServer.
# Теперь в GeoServer уходит один запрос, остальные ждут его результат.
_tile_inflight: dict = {}


def _tile_coalesce_key(request: Request):
    qp = request.query_params
    req_type = (qp.get("REQUEST") or qp.get("request") or "").upper()
    if req_type == "GETFEATUREINFO":
        return None
    items = sorted((k, v) for k, v in qp.multi_items() if k.lower() not in ("_t", "t", "timestamp"))
    return "&".join(f"{k}={v}" for k, v in items)


@app.get("/geoserver_wms_proxy")
async def geoserver_wms_proxy(request: Request):
    key = _tile_coalesce_key(request)
    if key is None:
        return await _geoserver_wms_proxy_impl(request)
    fut = _tile_inflight.get(key)
    if fut is not None:
        try:
            shared = await _asyncio.wait_for(_asyncio.shield(fut), timeout=45)
        except Exception:
            shared = None
        if shared is not None:
            content, ct, hdrs = shared
            return _tile_ok_response(request, content, ct, hdrs)
        return await _geoserver_wms_proxy_impl(request)

    fut = _asyncio.get_running_loop().create_future()
    _tile_inflight[key] = fut
    result = None
    try:
        resp = await _geoserver_wms_proxy_impl(request)
        body = getattr(resp, "body", b"")
        if resp.status_code == 200 and body:
            hdrs = {k: v for k, v in resp.headers.items()
                    if k.lower() not in ("content-length", "content-type", "etag")}
            result = (body, resp.media_type or resp.headers.get("content-type", "image/png"), hdrs)
        return resp
    finally:
        _tile_inflight.pop(key, None)
        if not fut.done():
            fut.set_result(result)


_WMS_MAX_SIDE = int(os.getenv("WMS_MAX_SIDE", "1024"))


def _wms_params_error(params: dict):
    """Проверяет WIDTH/HEIGHT/BBOX GetMap-запроса. Возвращает текст ошибки или None."""
    lower = {k.lower(): v for k, v in params.items()}
    if lower.get("request", "").upper() not in ("GETMAP", "GETFEATUREINFO", ""):
        return None  # GetCapabilities/GetLegendGraphic — размеров нет
    for name in ("width", "height"):
        raw = lower.get(name)
        if raw is None:
            continue
        try:
            v = int(raw)
        except ValueError:
            return f"Некорректный {name.upper()}"
        if not 1 <= v <= _WMS_MAX_SIDE:
            return f"{name.upper()} вне диапазона 1..{_WMS_MAX_SIDE}"
    bbox = lower.get("bbox")
    if bbox is not None:
        try:
            parts = [float(x) for x in bbox.split(",")]
        except ValueError:
            return "Некорректный BBOX"
        if len(parts) != 4 or not all(math.isfinite(x) for x in parts):
            return "Некорректный BBOX"
        if parts[0] >= parts[2] or parts[1] >= parts[3]:
            return "Некорректный BBOX"
    return None


async def _geoserver_wms_proxy_impl(request: Request):
    target = request.query_params.get("_target", "GEOSERVER")
    base_urls = {
        "GEOSERVER":     GEOSERVER_BASE_URL + "/wms",
        "GEOSERVER_EXT": GEOSERVER_BASE_URL + "/External/wms",
        "BELGOSLES":     "https://bank.belgosles.by/geoserver/BelGosLes/wms",
        "COVERSTYLE":    "https://bank.belgosles.by/geoserver/CoverStyleManage/wms",
    }

    url = base_urls.get(target, base_urls["GEOSERVER"])
    # [FIX] "_kind" — необязательная подсказка от фронтенда (vector/raster/bounds),
    # см. map-core.js _buildExternalLayer(). Используется ниже для выбора
    # семафора/таймаута и НЕ пробрасывается в GeoServer.
    _kind_hint = request.query_params.get("_kind", "")
    params = {k: v for k, v in request.query_params.items() if k not in ("_target", "_kind")}

    # [v20.13] Границы на размеры и BBOX: иначе WIDTH=20000 раздувает маску ЛУ до
    # сотен МБ, а случайные значения забивают кэш уникальными ключами.
    _bad = _wms_params_error(params)
    if _bad:
        return Response(_bad, status_code=400, media_type="text/plain; charset=utf-8",
                        headers=_pk.no_store())

    # Определяем тип слоя: ЛУ-маска, bounds-контур или COG-снимок
    _wms_layers = params.get('LAYERS', params.get('layers', ''))
    _leshoz_code = _LU_LAYER_TO_LESHOZ_CODE.get(_wms_layers) if target == 'GEOSERVER' else None

    # External:* → workspace-специфичный endpoint (нестандартные CRS BY-LV и др.)
    if target == "GEOSERVER" and not _leshoz_code and _wms_layers.startswith("External:"):
        url = base_urls["GEOSERVER_EXT"]

    _resp_headers = _TILE_MASKED_HEADERS if _leshoz_code else _TILE_RESPONSE_HEADERS

    # GetFeatureInfo НЕ кэшируется
    _request_type = params.get('REQUEST', params.get('request', '')).upper()
    _is_feature_info = _request_type == 'GETFEATUREINFO'
    # [FIX] _FEATURE_INFO_HEADERS вычислялась (см. _is_feature_info выше), но нигде
    # не подставлялась в _resp_headers — GetFeatureInfo реально уходил с теми же
    # заголовками, что и обычные тайлы (max-age=86400, s-maxage=604800).
    if _is_feature_info:
        _resp_headers = _FEATURE_INFO_HEADERS

    # Ключ кэша: сортированные параметры без timestamp.
    # Нормализуем через urllib.parse.quote — кириллица в LAYERS (напр. "Подложка ДЗЗ")
    # кодируется одинаково независимо от того, пришёл ли параметр уже как %D0%9F... или как UTF-8.
    # Это устраняет дублирование запросов к GeoServer из-за несовпадения ключей кэша.
    from urllib.parse import quote as _url_quote, unquote as _url_unquote
    _cache_params = {k: v for k, v in params.items() if k.lower() not in ('_t', 't', 'timestamp')}
    cache_key = url + "?" + "&".join(
        f"{k}={_url_quote(_url_unquote(str(v)), safe='')}"
        for k, v in sorted(_cache_params.items())
    )

    # 1. Python in-memory / Redis кэш — мгновенный ответ без семафора
    if not _is_feature_info:
        cached = await _tile_cache_aget(cache_key)
        if cached:
            content, ct = cached
            return _tile_ok_response(request, content, ct, _resp_headers)

    # 2. Выбор семафора: bounds-контуры и вектор быстрые (24 пар.), COG-снимки тяжёлые (8 пар.)
    # _bounds слои — лёгкий WMS полигонов, GeoServer отдаёт < 50мс из GWC кэша.
    # _native_crs_deflate_cog / _cog — реальный растр, нагружает GeoServer CPU/IO.
    # [FIX] Раньше ЛЮБОЙ слой, у которого в имени нет "_bounds" и нет leshoz-кода,
    # автоматически шёл в тяжёлый 8-слотовый COG-семафор с таймаутом 12с×3 попытки —
    # включая обычные векторные оверлеи (например LAYERS="shps test2", он же
    # gs_all_pans_vector — контур ALL-PANS в вкладке «Спутник»). Если у такого
    # slow/битого векторного слоя начинались таймауты/ConnectionError, каждый
    # его тайл занимал один из 8 слотов COG-семафора до 36 секунд (12с × 3
    # попытки) — при нескольких тайлах в вьюпорте это исчерпывало ВЕСЬ пул и
    # блокировало загрузку остальных снимков/лесоустройства ("всё стало
    # лагать", хотя сами эти слои были ни при чём). Теперь фронтенд явно
    # помечает тип слоя параметром _kind=vector|raster|bounds (см.
    # map-core.js _buildExternalLayer), и векторные слои идут в тот же
    # быстрый пул, что и bounds, с коротким таймаутом и одной попыткой
    # повтора — вместо того чтобы конкурировать с настоящими COG-растрами.
    _is_bounds = '_bounds' in _wms_layers or (_leshoz_code is not None)
    _is_vector = (not _is_bounds) and (
        _kind_hint == 'vector'
        or (not _kind_hint and _wms_layers in ('shps test', 'shps test2'))
    )
    # [FIX] «Все спутниковые снимки» — ImageMosaic из сотен гранул, физически
    # не выдерживает такой же параллельности, как обычный одиночный COG-слой
    # (см. подробности у _gs_mosaic_semaphore выше). Вычисляем ДО выбора
    # семафора, а не только для таймаута, как было раньше.
    _is_all_pans = (not _is_bounds) and (not _is_vector) and (
        _wms_layers in ('kosmo_snimki vse', 'kosmo_snimki_vse') or 'all_pans' in _wms_layers.lower()
    )
    # [FIX] Подложка ДЗЗ — отдельный класс запросов (см. _gs_basemap_semaphore).
    # Определяем двумя способами: по явной подсказке фронтенда _kind=basemap
    # (map-core.js) и по имени слоя — на случай старых закэшированных клиентов,
    # которые этот параметр ещё не шлют.
    _is_dzz_basemap = (not _is_bounds) and (not _is_vector) and (
        _kind_hint == 'basemap' or 'подложка дзз' in _wms_layers.lower()
    )

    if _is_bounds or _is_vector:
        _semaphore = _gs_bounds_semaphore
    elif _is_dzz_basemap:
        _semaphore = _gs_basemap_semaphore
    elif _is_all_pans:
        _semaphore = _gs_mosaic_semaphore
    else:
        _semaphore = _gs_cog_semaphore

    _EMPTY_PNG = (
        b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x01\x00'
        b'\x00\x00\x01\x00\x08\x02\x00\x00\x00\x90w\x53\xde'
        b'\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01'
        b'\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82'
    )

    async with _semaphore:
        # Повторная проверка кэша внутри семафора (другой воркер мог уже заполнить)
        if not _is_feature_info:
            cached = await _tile_cache_aget(cache_key)
            if cached:
                content, ct = cached
                return _tile_ok_response(request, content, ct, _resp_headers)

        try:
            _params = params.copy()
            # FIX: слой "Все спутниковые снимки" (gs_all_pans_cog / "kosmo_snimki vse") —
            # это ImageMosaic из сотен COG-гранул. На дальнем зуме GeoServer реально
            # компонует десятки пересекающихся сцен в один тайл — 12с не хватает,
            # запрос падает по таймауту, а пустой fallback-тайл затем на неделю
            # прописывается в кэш nginx (см. ниже) → "дыры" в снимках, которые
            # сами не чинятся. Даём мозаике заметно больше времени.
            if _is_bounds:
                _base_timeout = 6
            elif _is_vector:
                _base_timeout = 8   # обычный векторный оверлей должен отвечать быстро
            elif _is_all_pans:
                _base_timeout = 35
            elif _is_dzz_basemap:
                # [FIX] Подложке даём 25с вместо 12с. Первый проход по «холодному»
                # GWC-кэшу GeoServer на обзорном зуме честно рендерит крупные куски
                # мозаики и в 12с не укладывался — тайл уходил в 504, а OpenLayers
                # больше его не запрашивал. С 25с первый проход доходит до конца,
                # дальше тайлы отдаются из GWC/nginx/LRU за десятки миллисекунд.
                _base_timeout = 25
            else:
                _base_timeout = 12

            def _fetch_tile(_t):
                return _tile_session.get(url, params=_params, timeout=_t)

            # [FIX] У bounds было 0 повторов (1 попытка), у всего остального —
            # 2 повтора (3 попытки × 12с = до 36с занятой слот семафора). Теперь
            # у vector-слоёв тоже максимум 1 повтор (2 попытки × 8с = до 16с) —
            # они не должны быть медленными в принципе, а при реальной поломке
            # быстрее освобождают быстрый семафор для остальных vector/bounds.
            _max_attempts = 1 if _is_bounds else (2 if _is_vector else 3)

            resp = None
            for _attempt in range(_max_attempts):
                try:
                    resp = await _asyncio.get_running_loop().run_in_executor(
                        _tile_executor, _fetch_tile, _base_timeout
                    )
                except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as _te:
                    # FIX: раньше первый же таймаут COG-тайла улетал в общий
                    # except ниже и мгновенно отдавался как "успешный" пустой
                    # PNG (200) — nginx его кэшировал на 168ч. Теперь для тяжёлых
                    # COG-тайлов даём ещё 1-2 попытки с тем же таймаутом, прежде
                    # чем сдаться — GeoServer часто уже прогрел GWC-кэш к повтору.
                    if _attempt < _max_attempts - 1:
                        logger.warning(f"geoserver_wms_proxy: таймаут ({_te.__class__.__name__}), повтор {_attempt+1}/{_max_attempts} для LAYERS={_wms_layers}")
                        continue
                    logger.warning(f"geoserver_wms_proxy: таймаут после {_attempt+1} попыток, LAYERS={_wms_layers}: {_te}")
                    # FIX: статус 504, а НЕ 200 — иначе nginx (proxy_cache_valid 200 168h)
                    # закэширует этот пустой тайл на неделю. При 504 сработает
                    # "any 0" (не кэшируется) + proxy_cache_use_stale отдаст
                    # старый валидный тайл из кэша, если он есть.
                    return Response(_EMPTY_PNG, status_code=504, media_type="image/png", headers=_pk.no_store(_resp_headers))
                if resp.status_code == 429:
                    try:
                        retry_after = min(3, max(0, int(resp.headers.get("Retry-After", 1 + _attempt))))
                    except ValueError:  # Retry-After в формате HTTP-даты
                        retry_after = 1 + _attempt
                    logger.warning(f"geoserver_wms_proxy: 429 от GeoServer, ждём {retry_after}s (попытка {_attempt+1}/{_max_attempts})")
                    await _asyncio.sleep(retry_after)
                    continue
                break

            content = resp.content
            ct = resp.headers.get("Content-Type", "image/png")

            if resp.status_code == 200 and content:
                # Применяем маску лесхоза для ЛУ-слоёв
                if _leshoz_code:
                    try:
                        _bbox_str = params.get('BBOX', params.get('bbox', ''))
                        _bbox = [float(x) for x in _bbox_str.split(',')]
                        _w = int(params.get('WIDTH', params.get('width', 256)))
                        _h = int(params.get('HEIGHT', params.get('height', 256)))
                        _srs = params.get('SRS', params.get('srs',
                               params.get('CRS', params.get('crs', 'EPSG:3857')))).upper()
                        _ver = params.get('VERSION', params.get('version', '1.1.1'))
                        if _ver.startswith('1.3') and _srs == 'EPSG:4326':
                            _bbox = [_bbox[1], _bbox[0], _bbox[3], _bbox[2]]
                        elif _srs == 'EPSG:3857':
                            _t = _get_3857_to_4326()
                            _lo1, _la1 = _t.transform(_bbox[0], _bbox[1])
                            _lo2, _la2 = _t.transform(_bbox[2], _bbox[3])
                            _bbox = [_lo1, _la1, _lo2, _la2]
                        content = await run_in_threadpool(
                            _apply_leshoz_mask_to_png, content, _leshoz_code, _bbox, _w, _h
                        )
                        ct = 'image/png'
                    except Exception as _me:
                        logger.warning(f"leshoz mask apply error: {_me}")

                if not _is_feature_info:
                    _tile_cache_put(cache_key, (content, ct))
                return _tile_ok_response(request, content, ct, _resp_headers)

            if resp.status_code == 429:
                logger.warning("geoserver_wms_proxy: GeoServer вернул 429 после 3 попыток, отдаём пустой тайл")
                # FIX: было media_type=..., без status_code → уходило как 200
                # и nginx кэшировал пустой тайл на 168ч. 503 не кэшируется.
                return Response(_EMPTY_PNG, status_code=503, media_type="image/png", headers=_pk.no_store(_resp_headers))

            # [v20.13] Ошибка апстрима не должна кэшироваться на сутки
            return Response(content, status_code=resp.status_code,
                            media_type=ct, headers=_pk.no_store(_resp_headers))
        except Exception as e:
            logger.warning(f"geoserver_wms_proxy: {e}")
            # FIX: тот же баг — любая иная ошибка (разрыв соединения, парсинг
            # и т.п.) отдавалась как 200 и намертво кэшировалась nginx-ом.
            return Response(_EMPTY_PNG, status_code=502, media_type="image/png", headers=_pk.no_store(_resp_headers))


# ============================================================
# ПРОГРЕВ КЭША: /api/wms/seed
# POST {"layers": ["External:xxx_bounds", "External:xxx_cog", ...],
#        "bbox": [minx, miny, maxx, maxy],   ← EPSG:3857, опционально
#        "zooms": [8, 9, 10]}                ← опционально, default [8,9,10]
#
# Запрашивает по одному тайлу на каждый zoom для каждого слоя —
# GeoServer рендерит и кладёт в GWC-кэш, FastAPI — в LRU/Redis.
# Следующий запрос браузера = HIT из кэша = мгновенно.
#
# Пример вызова из JS после включения слоёв:
#   fetch('/api/wms/seed', {method:'POST',
#     headers:{'Content-Type':'application/json'},
#     body: JSON.stringify({layers: activeLayerNames})})
# ============================================================
# [v20.13] Фоновые задачи держим в множестве: asyncio хранит только слабую ссылку,
# и задача могла быть собрана GC до выполнения.
_bg_tasks: set = set()


def _spawn_bg(coro):
    t = _asyncio.ensure_future(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


# Один и тот же слой/зум прогреваем не чаще раза в 10 минут: фронтенд шлёт seed
# при каждом включении слоя каждым пользователем — 100 пользователей = 100 × 320 запросов к GeoServer.
_seed_recent = _pk.TTLCache(maxsize=2000, ttl=600.0)


@app.post("/api/wms/seed")
async def api_wms_seed(request: Request):
    """
    Прогрев WMS-кэша для списка слоёв.
    Параллельно запрашивает один центральный тайл на каждый zoom для каждого слоя.
    Ответ приходит быстро (fire-and-forget в фоне), seed идёт в background task.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    layers: list = body.get("layers", [])
    if not layers:
        return {"ok": True, "queued": 0}

    # bbox Беларуси в EPSG:3857 — центральный тайл для прогрева
    # Если клиент передал bbox (текущий viewport) — используем его
    raw_bbox = body.get("bbox") or [2504688.5, 6261721.4, 3757032.8, 7514065.6]
    zooms: list = body.get("zooms") or [8, 9, 10, 11]
    # [SEC v16] Раньше число слоёв/зумов не ограничивалось (тысячи запросов к GeoServer
    # от одного POST), а zoom=10**9 вычислял 2**zoom — зависание процесса.
    if not isinstance(layers, list) or not isinstance(zooms, list):
        raise HTTPException(400, "layers/zooms: ожидаются списки")
    layers = [l for l in layers if isinstance(l, str) and re.fullmatch(r"[\w:.\-]{1,128}", l)][:40]
    try:
        zooms = sorted({int(z) for z in zooms if not isinstance(z, bool) and 0 <= int(z) <= 22})[:8]
        raw_bbox = [float(v) for v in raw_bbox]
        if len(raw_bbox) != 4 or not all(math.isfinite(v) and abs(v) <= 2.1e7 for v in raw_bbox):
            raise ValueError("bbox")
    except (TypeError, ValueError):
        raise HTTPException(400, "Некорректные zooms/bbox")
    if not layers or not zooms:
        return {"ok": True, "queued": 0}

    gs_ext_url = GEOSERVER_BASE_URL + "/External/wms"

    async def _seed_one(layer_name: str, zoom: int, bbox: list):
        """Запрашивает один тайл для прогрева кэша GeoServer + LRU."""
        width, height = (256, 256)
        params = {
            'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap',
            'FORMAT': 'image/png', 'TRANSPARENT': 'true',
            'LAYERS': layer_name, 'TILED': 'true', 'STYLES': '',
            'WIDTH': str(width), 'HEIGHT': str(height),
            'SRS': 'EPSG:3857',
            'BBOX': f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}",
            '_target': 'GEOSERVER_EXT',
            'FORMAT_OPTIONS': 'dpi:99',
        }
        from urllib.parse import quote as _sq, unquote as _suq
        _cache_key = gs_ext_url + "?" + "&".join(
            f"{k}={_sq(_suq(str(v)), safe='')}" for k, v in sorted(params.items())
        )
        # Пропускаем если уже в кэше
        if await _tile_cache_aget(_cache_key):
            return

        # bounds — быстрый семафор; cog — медленный
        _is_bounds_layer = '_bounds' in layer_name
        _sem = _gs_bounds_semaphore if _is_bounds_layer else _gs_cog_semaphore

        async with _sem:
            if await _tile_cache_aget(_cache_key):
                return
            try:
                _p = params.copy()
                def _fetch():
                    return _tile_session.get(gs_ext_url, params=_p, timeout=15)
                resp = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch)
                if resp.status_code == 200 and resp.content:
                    _tile_cache_put(_cache_key, (resp.content, resp.headers.get("Content-Type", "image/png")))
            except Exception as _se:
                logger.debug(f"[seed] {layer_name} z{zoom}: {_se}")

    def _tile_bbox_for_zoom(zoom: int, center_bbox: list) -> list:
        """Вычисляет BBOX одного центрального тайла на заданном зуме."""
        import math
        cx = (center_bbox[0] + center_bbox[2]) / 2
        cy = (center_bbox[1] + center_bbox[3]) / 2
        # Размер тайла в метрах Web Mercator на данном зуме
        earth_circ = 2 * math.pi * 6378137.0
        tile_size_m = earth_circ / (2 ** zoom)
        # Номер тайла
        tx = int((cx + earth_circ / 2) / tile_size_m)
        ty = int((earth_circ / 2 - cy) / tile_size_m)
        # Обратно в BBOX
        minx = tx * tile_size_m - earth_circ / 2
        maxy = earth_circ / 2 - ty * tile_size_m
        maxx = minx + tile_size_m
        miny = maxy - tile_size_m
        return [minx, miny, maxx, maxy]

    async def _run_seed():
        tasks = []
        for layer_name in layers:
            for zoom in zooms:
                _seed_key = (layer_name, zoom)
                if _seed_recent.get(_seed_key):
                    continue
                _seed_recent.put(_seed_key, True)
                bbox = _tile_bbox_for_zoom(zoom, raw_bbox)
                tasks.append(_seed_one(layer_name, zoom, bbox))
        if not tasks:
            return
        # Запускаем все задачи параллельно батчами по 32 чтобы не перегружать event loop
        _BATCH = 32
        for i in range(0, len(tasks), _BATCH):
            await _asyncio.gather(*tasks[i:i + _BATCH], return_exceptions=True)
        logger.info(f"[seed] завершён прогрев {len(layers)} слоёв × {len(zooms)} зумов")

    # Fire-and-forget: ответ сразу, прогрев идёт в фоне
    _spawn_bg(_run_seed())

    return {"ok": True, "queued": len(layers) * len(zooms), "layers": len(layers), "zooms": zooms}

@app.post("/api/admin/reset-boundary-cache")
def reset_boundary_cache(_=Depends(require_admin)):
    """Сбрасывает все кэши маскирования + WMS-тайлы (LRU + Redis) + nginx кэш на диске."""
    global _cb_cache_body, _cb_cache_etag, _leshoz_gdf_cache
    with _cb_lock:
        _cb_cache_body = b""
        _cb_cache_etag = ""
    _leshoz_gdf_cache = None
    _geojson_resp_cache.clear()
    with _leshoz_geom_cache_lock:
        _leshoz_geom_cache.clear()
    with _leshoz_mask_cache_lock:
        _leshoz_mask_cache.clear()

    # Используем единую функцию очистки LRU + Redis
    flush_stats = _tile_cache_flush_all()
    n = flush_stats["lru"]

    # Попытка очистить nginx кэш на диске (Windows C:\nginx\cache и Linux пути)
    nginx_cleared = 0
    for _nd in ['C:/nginx/cache', '/var/cache/nginx', '/tmp/nginx_cache', '/var/tmp/nginx',
                os.path.join(BASE_DIR, 'nginx_cache')]:
        if os.path.isdir(_nd):
            try:
                import subprocess
                subprocess.run(['find', _nd, '-type', 'f', '-delete'],
                               capture_output=True, timeout=15)
                nginx_cleared += 1
                logger.info(f"reset-boundary-cache: очищен nginx кэш {_nd}")
            except Exception as _ne:
                logger.warning(f"reset-boundary-cache: ошибка очистки {_nd}: {_ne}")
    logger.info(f"reset-boundary-cache: lru={n} redis={flush_stats.get('redis',0)} nginx_dirs={nginx_cleared}")
    return {"ok": True, "tiles_cleared": n, "redis_cleared": flush_stats.get("redis", 0),
            "nginx_dirs": nginx_cleared,
            "message": f"Сброшено LRU={n} Redis={flush_stats.get('redis',0)} + nginx ({nginx_cleared} dirs)"}


# ==========================================
# 20. API — СНИМКИ (IMAGERY)
# ==========================================

@app.get("/api/imagery")
def api_get_imagery(
    leskhoz_id: Optional[str] = None,
    survey_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    query = db.query(Imagery)
    if leskhoz_id:
        query = query.filter(Imagery.leskhoz_id == leskhoz_id)
    if survey_type:
        query = query.filter(Imagery.survey_type == survey_type)
    rows = query.order_by(Imagery.upload_date.desc()).all()
    return [r.to_dict() for r in rows]


@app.post("/api/imagery/upload")
async def api_upload_imagery(
    request: Request,
    file: UploadFile = File(...),
    leskhoz_id: str = Form(""),
    survey_type: str = Form("uav"),
    date_shot: str = Form(""),
    equipment: str = Form(""),
    organization: str = Form(""),
    contract_num: str = Form(""),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    if not allowed_file(file.filename):
        raise HTTPException(400, "Недопустимый формат файла")

    safe_name = secure_filename(file.filename)
    if not safe_name or '.' not in safe_name:  # [FIX v16] кириллическое имя → пустое/без расширения
        safe_name = f"img_{_uuid_mod.uuid4().hex[:12]}{_sh.safe_ext(file.filename, default='.tif')}"
    file_path = _sh.safe_join(UPLOAD_FOLDER, safe_name)
    if not file_path:
        raise HTTPException(400, "Недопустимое имя файла")
    # [PERF v16] потоковая запись (раньше файл целиком в RAM + блокировка event loop)
    await _sh.save_upload(file, file_path, max_bytes=int(os.getenv("UPLOAD_MAX_MB", "4096")) * 1024 * 1024)

    # Генерируем превью в фоне
    preview_name = f"prev_{os.path.splitext(safe_name)[0]}.png"
    bounds = None
    try:
        _, bounds = await run_in_threadpool(generate_preview, file_path, preview_name)
    except Exception as e:
        logger.warning(f"Preview error: {e}")

    # Определяем геометрию для PostGIS
    geom = None
    if bounds:
        try:
            n, w = bounds[0]
            s, e = bounds[1]
            poly = box(w, s, e, n)
            geom = from_shape(poly, srid=4326)
        except Exception:
            pass

    record = Imagery(
        filename=safe_name,
        leskhoz_id=leskhoz_id,
        survey_type=survey_type,
        date_shot=date_shot,
        equipment=equipment,
        organization=organization,
        contract_num=contract_num,
        preview_filename=preview_name if bounds else None,
        geom=geom,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    # Сбрасываем дисковый кэш тайлов — новый снимок должен появиться сразу
    _invalidate_raster_tile_cache(leskhoz_id=record.leskhoz_id)
    return record.to_dict()


@app.delete("/api/imagery/{imagery_id}")
def api_delete_imagery(
    imagery_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    row = db.query(Imagery).filter(Imagery.id == imagery_id).first()
    if not row:
        raise HTTPException(404, "Снимок не найден")
    # Удаляем файлы с диска
    for fname in [row.filename, row.preview_filename]:
        if fname:
            fpath = os.path.join(UPLOAD_FOLDER, fname)
            if os.path.exists(fpath):
                os.remove(fpath)
    db.delete(row)
    db.commit()
    # Сбрасываем кэш — удалённый снимок не должен отображаться
    _invalidate_raster_tile_cache(leskhoz_id=row.leskhoz_id)
    return {"ok": True}


# ==========================================
# 21. API — ВЕКТОРНЫЕ СЛОИ
# ==========================================

@app.get("/api/vector-layers")
def api_get_vector_layers(db: Session = Depends(get_db)):
    rows = db.query(VectorLayer).all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "color": r.color,
            "weight": r.weight,
            "fill_opacity": r.fill_opacity,
            "geojson": r.geojson_data,
        }
        for r in rows
    ]


@app.post("/api/vector-layers")
async def api_upload_vector_layer(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(""),
    color: str = Form('#3388ff'),
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    content = await file.read()
    try:
        geojson_data = json.loads(content)
    except Exception:
        raise HTTPException(400, "Неверный формат GeoJSON")

    layer_name = name or file.filename
    record = VectorLayer(
        name=layer_name,
        color=color,
        geojson_data=geojson_data,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {"id": record.id, "name": record.name}


@app.delete("/api/vector-layers/{layer_id}")
def api_delete_vector_layer(
    layer_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise HTTPException(404, "Слой не найден")
    db.delete(row)
    db.commit()
    _vectors_cache_invalidate()  # сброс in-memory кэша
    return {"ok": True}


# ==========================================
# 22. API — ТОКЕНЫ ДОСТУПА
# ==========================================

@app.post("/api/admin/tokens/issue")
async def api_admin_tokens_issue(
    request: Request,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    data = await request.json()
    user_id         = data.get("user_id", 0)
    ip              = data.get("ip", "")
    token_type      = data.get("token_type", "unlimited")
    layers          = data.get("layers")
    file_path       = data.get("file_path", "")
    max_count       = data.get("max_count")
    expires_in_hours = data.get("expires_in_hours")
    note            = data.get("note", "")

    valid_types = ['unlimited', 'file', 'count', 'layers']
    if token_type not in valid_types:
        raise HTTPException(400, f"Недопустимый тип токена. Допустимые: {valid_types}")
    if token_type == 'layers' and not layers:
        raise HTTPException(400, "Укажите допустимые слои")
    if token_type == 'file' and not file_path:
        raise HTTPException(400, "Укажите file_path")
    if token_type == 'count':
        try:
            max_count = int(max_count)
            assert 1 <= max_count <= 10
        except Exception:
            raise HTTPException(400, "max_count должен быть от 1 до 10")
    if token_type != 'unlimited' and not expires_in_hours:
        raise HTTPException(400, "Укажите expires_in_hours")

    ip = str(ip or '').strip()
    profile = await run_in_threadpool(get_user_by_ip, ip)
    if not profile or profile.get('status') != 'active' or not (profile.get('user_name') or '').strip():
        raise HTTPException(400, "Нужен активный именованный профиль с указанным IP")
    user_id = profile['id']  # A stale browser row ID cannot create a second identity.
    result = token_issue(
        int(user_id), ip, token_type,
        layers=layers, file_path=file_path,
        max_count=max_count, expires_in_hours=expires_in_hours,
        note=note,
    )
    logger.info(f"[token issued] id={result['id']} type={token_type} tok={result['token'][:8]}…")
    return result


@app.post("/api/admin/tokens/{token_id}/revoke")
async def api_admin_tokens_revoke(
    token_id: int,
    _=Depends(require_admin),
):
    ok = token_revoke(token_id)
    if not ok:
        raise HTTPException(404, "Токен не найден")
    return {"ok": True}


@app.get("/api/tokens/my")
async def api_tokens_my(request: Request):
    ip = get_real_ip(request)
    token_auto_deactivate_expired()
    tokens = token_get_by_ip(ip)
    return [
        {
            "id": t["id"],
            "token": t["token"],          # ← ДОБАВИТЬ ЭТО
            "type": t["token_type"],
            "layers": t["layers"],
            "file_path": t["file_path"],
            "max_count": t["max_count"],
            "used_count": t["used_count"],
            "expires_at": t["expires_at"],
            "is_active": t["is_active"],
        }
        for t in tokens
    ]


@app.post("/api/tokens/validate")
async def api_tokens_validate(request: Request):
    user_id = get_current_user(request)
    if user_id:
        return {"ok": True, "reason": "admin"}
    data = await request.json()
    token_str = (data.get("token") or "").strip()
    file_path = (data.get("file_path") or "").strip()
    if not token_str:
        raise HTTPException(403, "Введите токен доступа")
    r = token_validate(token_str, file_path=file_path)
    if not r["ok"]:
        raise HTTPException(403, r["reason"])
    return {"ok": True, "reason": r["reason"]}


# ==========================================
# 23. API — СКАЧИВАНИЕ ФАЙЛОВ (v2)
# ==========================================

def _detect_ddz_data_root() -> str:
    """Определяет путь к данным ДЗЗ: из переменной окружения или авто-поиск."""
    env_val = os.environ.get("DDZ_DATA_ROOT", "").strip()
    if env_val and os.path.isdir(env_val):
        return env_val
    # Авто-поиск: Windows-диски и Linux-пути
    candidates = [
        r"W:\Data", r"D:\Data", r"E:\Data", r"C:\Data",
        "/mnt/data", "/opt/data", "/srv/data",
        os.path.join(BASE_DIR, "data"),
    ]
    for p in candidates:
        if os.path.isdir(p):
            logger.info(f"[DDZ_DATA_ROOT] авто-определён: {p}")
            return p
    # Фолбэк — создаём локальную папку data/ рядом с приложением
    fallback = os.path.join(BASE_DIR, "data")
    os.makedirs(fallback, exist_ok=True)
    logger.warning(f"[DDZ_DATA_ROOT] не найден, используется фолбэк: {fallback}")
    return fallback

_DDZ_DATA_ROOT = _detect_ddz_data_root()
_COG_SERVER_PORT = 5002
_COG_DIRS = {
    "space": os.path.join(_DDZ_DATA_ROOT, "KS"),
    "base":  os.path.join(_DDZ_DATA_ROOT, "Basic DDZ"),
    "aero":  os.path.join(_DDZ_DATA_ROOT, "AFS"),
    "uav":   os.path.join(_DDZ_DATA_ROOT, "BLA"),
}

# ── Маппинг: имя слоя (после External:) → реальное имя файла на диске ─────
# Файлы лежат в Basic DDZ/ЛУ 2026/ (и подпапках), поиск рекурсивный.
_LAYER_FILENAME_MAP: dict = {
    "Дисненский лесхоз":    "disnenski_wgs84_deflate_cog.tif",
    "Слуцкий лесхоз":       "slutsk_wgs84_deflate_cog.tif",
    "Любанский лесхоз":     "luban_wgs84_deflate_cog.tif",
    "Бегомельский лесхоз":  "begomel_wgs84_deflate_cog.tif",
    "Суражский лесхоз":     "surash_wgs84_deflate_cog.tif",
    "Волковысский лесхоз":  "volkovissk_wgs84_deflate_cog.tif",
    "Starodoroshski_wgs84_deflate_cog": "Starodoroshski_wgs84_deflate_cog.tif",
    "logoisk_wgs84_deflate_cog":        "logoisk_wgs84_deflate_cog.tif",
    "slonim_wgs84_deflate_cog":         "slonim_wgs84_deflate_cog.tif",
    "kopil_wgs84_deflate_cog":          "kopil_wgs84_deflate_cog.tif",
    "Дисненский лесхоз_вектор":         None,
}


def _find_file_recursive(root: str, filename: str) -> Optional[str]:
    """Рекурсивный поиск файла — сначала точное совпадение, потом регистронезависимое."""
    if not os.path.isdir(root):
        return None
    filename_lower = filename.lower()
    for dirpath, _, files in os.walk(root):
        # Точное совпадение — приоритет
        if filename in files:
            return os.path.join(dirpath, filename)
        # Регистронезависимое совпадение (для русских имён и mixed-case)
        for f in files:
            if f.lower() == filename_lower:
                return os.path.join(dirpath, f)
    return None


def _resolve_cog_path(layer: str):
    """Возвращает (абсолютный_путь, имя_файла) для COG-слоя или (None, None)."""
    # Убираем префикс вида "External:" или "LayerName:" если есть
    clean = layer.split(':', 1)[-1].strip() if ':' in layer else layer
    logger.info(f"[resolve_cog] ищу слой='{clean}' в {_DDZ_DATA_ROOT}")

    # Шаг 1: проверяем маппинг слой→файл (русские имена, vектор и др.)
    mapped = _LAYER_FILENAME_MAP.get(clean)
    if mapped is None and clean in _LAYER_FILENAME_MAP:
        # Слой есть в маппинге, но файл для него не предусмотрен (напр. вектор)
        logger.warning(f"[resolve_cog] слой '{clean}' не имеет файла для скачивания")
        return None, None
    if mapped:
        found = _find_file_recursive(_COG_DIRS["base"], mapped)
        if not found:
            found = _find_file_recursive(_DDZ_DATA_ROOT, mapped)
        if found:
            logger.info(f"[resolve_cog] найден через маппинг: {found}")
            return found, mapped
        logger.warning(f"[resolve_cog] маппинг указывает на '{mapped}', но файл не найден в {_DDZ_DATA_ROOT}")

    # Шаг 2: перебираем варианты имени файла: с расширением и без
    candidates = [clean]
    if not clean.lower().endswith('.tif') and not clean.lower().endswith('.tiff'):
        candidates.append(clean + '.tif')
        candidates.append(clean + '.tiff')

    for name in candidates:
        abs_path, filename = _dl_resolve_file(name)
        if abs_path:
            logger.info(f"[resolve_cog] найден: {abs_path}")
            return abs_path, filename
        direct = _sh.safe_join(_DDZ_DATA_ROOT, name)  # [SEC v16]
        if direct and os.path.isfile(direct):
            logger.info(f"[resolve_cog] найден (direct): {direct}")
            return direct, os.path.basename(direct)

    logger.warning(f"[resolve_cog] файл НЕ найден для слоя='{layer}', clean='{clean}', root='{_DDZ_DATA_ROOT}'")
    return None, None


_cog_tokens: dict = {}
_cog_tokens_lock = threading.Lock()
_COG_TOKEN_TTL = 600  # 10 минут


def _cog_make_token(file_path: str, ip: str) -> str:
    """Создаёт временный токен для скачивания COG-файла через cog_server."""
    token = str(_uuid_mod.uuid4())
    expires = time.time() + _COG_TOKEN_TTL
    with _cog_tokens_lock:
        # Удаляем просроченные токены
        dead = [k for k, v in _cog_tokens.items() if v["expires"] < time.time()]
        for k in dead:
            del _cog_tokens[k]
        _cog_tokens[token] = {"file_path": file_path, "ip": ip, "expires": expires}
    return token

def _make_accel_filename_header(filename: str) -> str:
    """Content-Disposition с поддержкой кириллики (RFC 5987)."""
    try:
        filename.encode("ascii")
        return f'attachment; filename="{filename}"'
    except UnicodeEncodeError:
        from urllib.parse import quote as _quote
        return f"attachment; filename*=UTF-8''{_quote(filename)}"


def _stream_file_response(file_path: str, filename: str, request: Request) -> Response:
    """
    Стримит файл напрямую через FastAPI StreamingResponse с поддержкой Range (resume).
    Работает для файлов любого размера — Python читает чанками по 1 МБ.
    """
    from urllib.parse import quote as _url_quote

    file_size = os.path.getsize(file_path)

    # Content-Disposition с поддержкой кириллицы (RFC 5987)
    try:
        filename.encode("latin-1")
        cd_header = f'attachment; filename="{filename}"'
    except (UnicodeEncodeError, UnicodeDecodeError):
        ascii_name = filename.encode("ascii", errors="ignore").decode("ascii") or "file.tif"
        quoted_name = _url_quote(filename)
        cd_header = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted_name}"

    logger.info(f"[stream] {file_path}  ({file_size // 1024 // 1024} МБ)")

    # Поддержка Range-запросов (resume download, докачка)
    range_header = request.headers.get("Range", "")
    start = 0
    end = file_size - 1
    status = 200

    if range_header:
        try:
            range_val = range_header.strip().replace("bytes=", "")
            s, e = range_val.split("-")
            start = int(s) if s else 0
            end   = int(e) if e else file_size - 1
            end   = min(end, file_size - 1)
            status = 206
        except Exception:
            pass

    length = end - start + 1

    def _iter_file(path, offset, size, chunk=1024 * 1024):
        with open(path, "rb") as f:
            f.seek(offset)
            remaining = size
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Disposition": cd_header,
        "Content-Type":        "image/tiff",
        "Content-Length":      str(length),
        "Accept-Ranges":       "bytes",
        "Cache-Control":       "no-store",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    return StreamingResponse(
        _iter_file(file_path, start, length),
        status_code=status,
        headers=headers,
        media_type="image/tiff",
    )


def _dl_is_allowed(request: Request) -> bool:
    if get_current_user(request):
        return True
    return False




# ── Дополнительные маршруты (Flask→FastAPI) интегрированы в единый файл ──

# ══ ШИФРОВАНИЕ ══════════════════════════════════════════════════════
ENCRYPTION_KEY_FILE = os.path.join(BASE_DIR, 'secret.key')
def _load_or_create_key():
    if os.path.exists(ENCRYPTION_KEY_FILE):
        with open(ENCRYPTION_KEY_FILE,'rb') as f: return f.read()
    key = Fernet.generate_key()
    with open(ENCRYPTION_KEY_FILE,'wb') as f: f.write(key)
    return key
_FERNET = Fernet(_load_or_create_key())
def encrypt(v):  return '' if not v else _FERNET.encrypt(v.encode()).decode()
def decrypt(v):
    if not v: return ''
    try: return _FERNET.decrypt(v.encode()).decode()
    except: return '[зашифровано]'

# ══ USERS.DB ════════════════════════════════════════════════════════
USERS_DB_PATH     = os.path.join(BASE_DIR, 'users.db')
MSG_ATTACH_FOLDER = os.path.join(BASE_DIR, 'msg_attachments')
os.makedirs(MSG_ATTACH_FOLDER, exist_ok=True)
MSG_QUOTA_BYTES   = 512 * 1024 * 1024
PROTECTED_IPS     = {'192.168.12.97'}
ALLOWED_ATTACH_MIME = {
    'image/jpeg','image/png','image/gif','image/webp','image/bmp',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv','application/zip','application/x-zip-compressed',
}

_maintenance      = {"active":False,"since":None,"blocked_visits":0}
_maintenance_lock = threading.Lock()

# ══ PostgreSQL helpers (заменяют SQLite _get_conn) ═══════════════════

def _pg():
    """Возвращает новую SQLAlchemy-сессию (СИНХРОННУЮ! psycopg2). Закрывать вручную через .close().
    [FIX] Эта сессия — блокирующая. Любой db.query(...) на ней — обычный
    синхронный сетевой I/O к Postgres. Вызывать её нужно ТОЛЬКО через
    run_in_threadpool(...) внутри async-обработчиков — иначе она виснет
    прямо на потоке event loop и останавливает ВЕСЬ сервер (см. фикс
    api_session_init / api_messages_inbox_count ниже)."""
    return SessionLocal()

# SQLite _get_conn сохранён для оставшихся legacy-блоков (tokens, layer_prefs, dl_tokens и др.)
def _get_conn():
    conn = sqlite3.connect(USERS_DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn

def _row_to_dict(row, decrypt_fields=False):
    if row is None: return {}
    if hasattr(row, '_asdict'):
        d = row._asdict()
    elif hasattr(row, '__dict__'):
        d = {k: v for k, v in row.__dict__.items() if not k.startswith('_')}
    else:
        d = dict(row)
    if decrypt_fields:
        d['user_name']         = decrypt(d.get('user_name',''))
        d['organization_name'] = decrypt(d.get('organization_name',''))
    return d

def _find_user(db, ip, device_id=None):
    """One profile per IP; ignore browser cookie and never move a profile by cookie."""
    return (db.query(PgUser).filter(PgUser.ip == str(ip or '').strip())
            .order_by(PgUser.id.asc()).first())

def get_user_by_ip(ip, device_id=None):
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        return _row_to_dict(u, True) if u else None
    finally: db.close()

def get_user_info_by_ip(ip, device_id=None): return get_user_by_ip(ip, device_id) or {}

def get_status_by_ip(ip, device_id=None):
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        return (u.id, u.status) if u else (None, 'new')
    finally: db.close()

def register_visit(ip, device_id=None):
    if not is_tracked_ip(ip):
        return None, 'active'
    ip = str(ip).strip()
    db = _pg()
    try:
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        u = _find_user(db, ip)
        if u is None:
            u = PgUser(ip=ip, device_id=None, first_seen=now, last_seen=now,
                       user_name='', organization_name='', status='active')
            try:
                with db.begin_nested():
                    db.add(u)
                    db.flush()
            except IntegrityError:
                # The unique IP index also protects simultaneous first visits.
                u = _find_user(db, ip)
                if u is None:
                    raise
        if u.status in ('deleted', 'frozen', 'banned'):
            return None, u.status
        u.last_seen = now
        uid = u.id
        db.add(PgLoginHistory(user_id=uid, ip=ip, login_time=now))
        db.commit()
        return uid, 'active'
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def _is_registered_or_admin(ip, user_id=None, device_id=None):
    if user_id: return True
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        return bool(u and u.status == 'active' and u.user_name and decrypt(u.user_name).strip())
    finally: db.close()

def _display_name(ip, device_id=None):
    if ip == ADMIN_IP: return 'Администратор'
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        if u and u.status == 'active':
            n = decrypt(u.user_name or ''); o = decrypt(u.organization_name or '')
            if n.strip(): return n.strip()
            if o.strip(): return o.strip()
        return ip
    finally: db.close()

def _get_user_org(ip, device_id=None):
    """Возвращает организацию пользователя. Для администратора — 'ADMIN'."""
    if ip == ADMIN_IP: return 'ADMIN'
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        if u and u.status == 'active':
            o = decrypt(u.organization_name or '')
            return o.strip()
        return ''
    finally: db.close()

def _normalize_department(value):
    """Normalize only spelling/spacing; never infer privileges from a person's name."""
    import unicodedata
    key = ''.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())
    return 'odziml' if key in ('odziml', 'одзимл') else key


def _is_odziml_org(value):
    return _normalize_department(value) == 'odziml'


def _can_manage_print_queue(ip: str, user_id, device_id=None) -> bool:
    """Изменять статусы, порядок и удалять записи в очереди печати —
    Таксаторы могут:
      • администратор (сессия /login ИЛИ IP из PROTECTED_IPS/ADMIN_IP);
      • сотрудники отдела ОДЗиМЛ (organization_name == 'odziml');
      • любой пользователь, которому админ выдал право вручную через
        admin_users → колонка pg_users.can_edit_print_queue."""
    if user_id:
        return True
    db = _pg()
    try:
        u = _find_user(db, ip, device_id)
        if not u or u.status != 'active':
            return False
        if bool(u.can_edit_print_queue):
            return True
        if u:
            org = decrypt(u.organization_name or '')
            if _is_odziml_org(org):
                return True
        return False
    finally:
        db.close()


def get_all_users_admin():
    db = _pg()
    try:
        rows = db.query(PgUser).order_by(PgUser.id.desc()).all()
        out = []
        for r in rows:
            # [v4] пользователи с 127.0.0.1 и чужих подсетей в консоли не показываются
            if not is_tracked_ip(r.ip):
                continue
            d = _row_to_dict(r, True)
            d['octet'] = ip_octet(r.ip)
            d['protected'] = r.ip in PROTECTED_IPS
            d.pop('device_id', None)
            out.append(d)
        return out
    finally: db.close()

def get_login_history(limit=200):
    db = _pg()
    try:
        from sqlalchemy import text as sqlt
        rows = db.execute(sqlt("""
            SELECT lh.id, lh.ip, lh.login_time, u.user_name, u.organization_name, u.status
            FROM pg_login_history lh
            LEFT JOIN pg_users u ON u.id = lh.user_id
            ORDER BY lh.id DESC LIMIT :lim
        """), {'lim': limit}).fetchall()
        result = []
        for r in rows:
            d = dict(r._mapping)
            if not is_tracked_ip(d.get('ip')):   # [v4] 127.0.0.1 и чужие подсети не показываем
                continue
            d['user_name']         = decrypt(d.get('user_name','')) or ''
            d['organization_name'] = decrypt(d.get('organization_name','')) or ''
            result.append(d)
        return result
    finally: db.close()

def update_user_data(uid, user_name='', org_name=''):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == uid).first()
        if u:
            u.user_name = encrypt(user_name); u.organization_name = encrypt(org_name)
        db.commit()
    except: db.rollback(); raise
    finally: db.close()

def set_status(uid, st):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == uid).first()
        if u: u.status = st
        db.commit()
    except: db.rollback(); raise
    finally: db.close()

def add_pending_request(user_id, user_name, org_name):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == user_id).first()
        ip = u.ip if u else ''
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        db.add(PgPendingRequest(user_id=user_id, ip=ip, requested_at=now,
                                user_name=encrypt(user_name), organization_name=encrypt(org_name), status='pending'))
        db.commit()
    except: db.rollback(); raise
    finally: db.close()

def get_pending_requests():
    db = _pg()
    try:
        rows = db.query(PgPendingRequest).filter(PgPendingRequest.status == 'pending').order_by(PgPendingRequest.id.desc()).all()
        result = []
        for r in rows:
            d = _row_to_dict(r)
            d['user_name']         = decrypt(d.get('user_name',''))
            d['organization_name'] = decrypt(d.get('organization_name',''))
            result.append(d)
        return result
    finally: db.close()

def approve_request(req_id):
    db = _pg()
    try:
        r = db.query(PgPendingRequest).filter(PgPendingRequest.id == req_id).first()
        if r and r.status == 'pending':
            u = db.query(PgUser).filter(PgUser.id == r.user_id).first()
            if u:
                u.user_name = r.user_name; u.organization_name = r.organization_name
            r.status = 'approved'
        db.commit()
    except: db.rollback(); raise
    finally: db.close()

def reject_request(req_id):
    db = _pg()
    try:
        r = db.query(PgPendingRequest).filter(PgPendingRequest.id == req_id).first()
        if r: r.status = 'rejected'
        db.commit()
    except: db.rollback(); raise
    finally: db.close()

def _quota_used_today(ip):
    db = _pg()
    try:
        today = datetime.now().strftime('%Y-%m-%d')
        from sqlalchemy import func as _func
        row = db.query(_func.coalesce(_func.sum(PgMsgFile.file_size), 0)).filter(
            PgMsgFile.from_ip == ip,
            PgMsgFile.sent_at.like(f'{today}%')
        ).scalar()
        return int(row or 0)
    except: return 0
    finally: db.close()

def _is_quota_unlimited(ip):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.ip == ip).first()
        return bool(u and u.quota_unlimited)
    except: return False
    finally: db.close()

def _attach_dir_for_ip(ip):
    safe = ip.replace('.','_').replace(':','_')
    d = os.path.join(MSG_ATTACH_FOLDER, safe); os.makedirs(d, exist_ok=True); return d

# ══ DL TOKENS v2 ════════════════════════════════════════════════════
_dl_tokens2 = {}; _dl_lock2 = threading.Lock(); _DL_TTL2 = 600

def _dl_cleanup2():
    now = time.time()
    with _dl_lock2:
        dead = [k for k,v in _dl_tokens2.items() if v['expires']<now]
        for k in dead: del _dl_tokens2[k]

def _dl_resolve_file(file_path: str):
    """
    Ищет файл по частичному пути или имени в _DDZ_DATA_ROOT и подпапках.
    Поддерживает кириллику и регистронезависимый поиск.
    """
    filename = os.path.basename(file_path)
    if not filename:
        return None, None

    # 1. Прямой путь: DDZ_DATA_ROOT / file_path
    # [SEC v16] safe_join: абсолютный путь / «..» больше не выводят за пределы архива ДЗЗ
    direct = _sh.safe_join(_DDZ_DATA_ROOT, file_path)
    if direct and os.path.isfile(direct):
        return direct, filename

    # 2. Поиск по префиксу типа съёмки (space/aero/uav/base)
    fp_lower = file_path.lower().replace('\\', '/')
    prefix_map = {'space': 'ks/', 'base': 'basic ddz/', 'aero': 'afs/', 'uav': 'bla/'}
    for key, folder in _COG_DIRS.items():
        prefix = prefix_map.get(key, '')
        if prefix and fp_lower.startswith(prefix) and os.path.isdir(folder):
            found = _find_file_recursive(folder, filename)
            if found:
                return found, os.path.basename(found)

    # 3. Полный рекурсивный поиск по имени файла (включая кириллику)
    if os.path.isdir(_DDZ_DATA_ROOT):
        found = _find_file_recursive(_DDZ_DATA_ROOT, filename)
        if found:
            return found, os.path.basename(found)

    logger.debug(f"[dl_resolve] файл не найден: '{file_path}' в '{_DDZ_DATA_ROOT}'")
    return None, None

# ══ METEOEYE ════════════════════════════════════════════════════════
METEOEYE_ENDPOINT = 'https://meteoeye.gis.by/hotspots/GetHotspotsFromApi'
METEOEYE_TAKE = 50000
_me_session = requests.Session()
_me_session.headers.update({'User-Agent':'Mozilla/5.0','Accept':'application/json',
    'Referer':'https://meteoeye.gis.by/hotspots/','Origin':'https://meteoeye.gis.by'})

# ── TTL-кэш тепловых аномалий ────────────────────────────────────────────────
# Ключ: (date, time_from, time_to, satellite) → {'data': geojson, 'ts': float}
# TTL: 180 сек (3 мин) для текущего дня, 3600 сек (1 час) для прошлых дат.
# Потокобезопасен: защищён _hs_cache_lock.
_hs_cache: dict = {}
_hs_cache_lock  = threading.Lock()
_HS_TTL_TODAY   = 180    # секунд — текущий день (данные обновляются)
_HS_TTL_PAST    = 3600   # секунд — прошлые даты (данные не меняются)

def _me_build_expression(date, time_from='00:00', time_to='23:59', satellite=None, skip=0):
    ge_val = date if time_from in ('00:00','0:00','') else f'{date}T{time_from}'
    if time_to in ('23:59','24:00',''):
        lt_val = (datetime.strptime(date,'%Y-%m-%d')+timedelta(days=1)).strftime('%Y-%m-%d')
    else: lt_val = f'{date}T{time_to}'
    parts = [f'_take={METEOEYE_TAKE}',f'_skip={skip}',f'shooting=ge{ge_val}',f'shooting=lt{lt_val}']
    if satellite and satellite.strip().lower() not in ('','all'): parts.append(f'satellite={satellite.upper()}')
    return '&'.join(parts)

def _me_to_geojson(raw):
    if isinstance(raw,dict) and raw.get('type')=='FeatureCollection': return raw
    if isinstance(raw,list):
        features = []
        for item in raw:
            lat = item.get('lat') or item.get('Lat') or item.get('latitude') or item.get('y')
            lon = item.get('lon') or item.get('Lon') or item.get('longitude') or item.get('x')
            if lat is None or lon is None: continue
            props = {k:v for k,v in item.items() if k.lower() not in ('lat','lon','lng','latitude','longitude','x','y')}
            features.append({'type':'Feature','geometry':{'type':'Point','coordinates':[float(lon),float(lat)]},'properties':props})
        return {'type':'FeatureCollection','features':features}
    if isinstance(raw,dict):
        for key in ('items','features','results','data','hotspots','points','fires','value'):
            if key in raw and isinstance(raw[key],list): return _me_to_geojson(raw[key])
    return {'type':'FeatureCollection','features':[]}

def _me_fetch(date, time_from='00:00', time_to='23:59', satellite=None, timeout=20):
    expression = _me_build_expression(date, time_from, time_to, satellite)
    try:
        r = _me_session.get(METEOEYE_ENDPOINT, params={'expression':expression}, timeout=timeout)
        r.raise_for_status(); return _me_to_geojson(r.json()), 200
    except requests.exceptions.HTTPError as e:
        sc = e.response.status_code if e.response else 0; return {'error':f'MeteoEye HTTP {sc}'}, sc
    except Exception as e: return {'error':str(e)}, 500


def _me_fetch_cached(date, time_from='00:00', time_to='23:59', satellite=None, timeout=20):
    """Обёртка над _me_fetch с TTL-кэшем в памяти.

    Прошлые даты кэшируются на 1 час (данные не меняются).
    Текущий день — на 3 минуты (данные обновляются со спутников).
    При ошибке от MeteoEye возвращает устаревший кэш если он есть (stale-on-error).
    """
    today = datetime.utcnow().strftime('%Y-%m-%d')
    ttl   = _HS_TTL_TODAY if date == today else _HS_TTL_PAST
    key   = (date, time_from, time_to, satellite or 'all')

    with _hs_cache_lock:
        entry = _hs_cache.get(key)
        if entry and (time.time() - entry['ts']) < ttl:
            logger.debug(f"[hs-cache] HIT {key}, age={(time.time()-entry['ts']):.0f}s")
            return entry['data'], 200

    data, sc = _me_fetch(date, time_from, time_to, satellite, timeout)

    if sc == 200:
        with _hs_cache_lock:
            _hs_cache[key] = {'data': data, 'ts': time.time()}
            # Ограничиваем размер кэша: храним не более 200 записей (FIFO)
            if len(_hs_cache) > 200:
                oldest = next(iter(_hs_cache))
                del _hs_cache[oldest]
        logger.debug(f"[hs-cache] MISS {key} → cached, features={len(data.get('features',[]))}")
    else:
        # Stale-on-error: вернуть устаревший кэш если он есть
        with _hs_cache_lock:
            entry = _hs_cache.get(key)
            if entry:
                logger.warning(f"[hs-cache] MeteoEye error {sc}, serving stale cache for {key}")
                return entry['data'], 200

    return data, sc

# ══ GEOSERVER PROXIES ═══════════════════════════════════════════════
_GS_BASE = GEOSERVER_BASE_URL
_GS_PREFIX = '/geoserver-proxy'
_gs_session = requests.Session()
# [SEC v16] Логин/пароль GeoServer были зашиты в код (admin/geoserver — пароль
# по умолчанию, известен всем). Теперь берутся из .env: GEOSERVER_USER/GEOSERVER_PASSWORD.
_GS_USER = os.getenv('GEOSERVER_USER', 'admin')
_GS_PASSWORD = os.getenv('GEOSERVER_PASSWORD')
if not _GS_PASSWORD:
    logger.warning("[SEC] GEOSERVER_PASSWORD не задан — используется пароль GeoServer по умолчанию. "
                   "Смените пароль admin в GeoServer и задайте GEOSERVER_PASSWORD в .env")
    _GS_PASSWORD = 'geoserver'
_gs_session.auth = (_GS_USER, _GS_PASSWORD)
_gs_session.verify = os.getenv('GEOSERVER_VERIFY_TLS', '1').strip().lower() not in ('0', 'false', 'no', 'off')
GEOSERVER_WMS_URL = "http://192.168.12.109:8081/geoserver/wms"
GEOSERVER_WFS_URL = os.getenv("GEOSERVER_WFS_URL", GEOSERVER_BASE_URL + "/wfs")
_TILE_PROXY_ALLOWED_HOSTS = {
    '192.168.12.109','93.84.108.142','bank.belgosles.by',
    'tile.openstreetmap.org','a.tile.openstreetmap.org','b.tile.openstreetmap.org','c.tile.openstreetmap.org',
    'mt0.google.com','mt1.google.com','mt2.google.com','mt3.google.com',
    'server.arcgisonline.com','services.arcgisonline.com',
    'ecn.t0.tiles.virtualearth.net','ecn.t1.tiles.virtualearth.net',
}
arcgis_semaphore = threading.Semaphore(4)
SERVICE_URL  = 'http://93.84.108.142:2052/arcgis/services/georesursDDZ/Belarus_Web_Mercator_new/ImageServer/WMSServer'
LOGIN_DZZ    = os.getenv('DZZ_LOGIN')
PASSWORD_DZZ = os.getenv('DZZ_PASSWORD')

GEOSERVER_LAYERS_CONFIG = [
    {"id":"gs_leshoz","name":"kab400:leshoz","title":"Лесхозы (GeoServer)","active":True},
    {"id":"gs_leshoz1","name":"kab400:leshoz1","title":"Лесхозы 1 (Доп.)","active":False},
    {"id":"gs_leshoz2","name":"kab400:leshoz2","title":"Лесхозы 2 (Новый)","active":False},
    {"id":"gs_subcompartments","name":"test:subcompartments","title":"Выделы (GeoServer)","active":False},
    {"id":"gs_all_roads","name":"test:all_roads","title":"Все дороги (GeoServer)","active":False},
    {"id":"gs_roads","name":"test:roads","title":"Дороги (Lines)","active":False},
    {"id":"gs_all_roads_cached","name":"test:all_roads","title":"Дороги (PBF Кэш)","active":False,"type":"pbf"},
]

# ══════════════════════════════════════════════════════════════
# МАРШРУТЫ
# ══════════════════════════════════════════════════════════════


# [v20] Поиск адресов с исправлением опечаток (geocoder.py): «ул. Долгобротская 38» → «Долгобродская улица, 38».
try:
    import geocoder as _geocoder
except Exception as _geo_e:                     # модуль необязателен: без него — прежний прокси к Nominatim
    _geocoder = None
    logger.warning(f"[geocode] geocoder.py не загружен: {_geo_e}")
_GEO_FUZZY_SEM = threading.BoundedSemaphore(int(os.getenv("GEOCODER_PARALLEL", "2")))
_GEO_ADDR_RE = re.compile(r"(?i)\d|(?<![а-яё])(ул|улица|пр|пр-т|просп|проспект|пер|переулок|б-р|бульвар|пл|площадь|ш|шоссе|"
                          r"тракт|наб|набережная|проезд|туп|тупик|мкр|микрорайон|вул|вуліца)(?![а-яё])")


def _geocode_plain(q: str, limit: int):
    url = (
        f"https://nominatim.openstreetmap.org/search"
        f"?q={requests.utils.quote(q)}"
        f"&format=json&limit={min(limit,20)}"
        f"&countrycodes=by&accept-language=ru&addressdetails=1"
    )
    resp = _http_session.get(url, timeout=8, headers={
        "User-Agent": "ODZiML-Geoportal/1.0 (internal)",
        "Accept-Language": "ru"
    })
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


@app.get("/api/geocode")
def geocode_proxy(q: str, limit: int = 10, city: Optional[str] = None, lat: Optional[float] = None,
                  lon: Optional[float] = None, fuzzy: int = 1):
    """Прокси к Nominatim OSM — обходит возможные блокировки браузера.
    [v20] Если адрес не найден как есть — geocoder.py: раскрытие сокращений, структурный запрос,
    исправление опечаток в названии улицы. Поля ответа прежние (формат Nominatim) + _corrected
    {from,to} и _approx (дом не найден — середина улицы). city — населённый пункт по умолчанию,
    lat/lon — центр карты (для выбора города, если он не указан)."""
    q = re.sub(r"\s+", " ", str(q or "")).strip()[:300]
    city = (re.sub(r"\s+", " ", city).strip()[:80] or None) if city else None
    limit = max(1, min(int(limit or 10), 20))
    data = []
    if not q:
        return JSONResponse(content=[])
    if not city:
        try:
            data = _geocode_plain(q, limit)
        except Exception as e:
            logger.warning(f"[geocode_proxy] {e}")
    looks_addr = len(q) >= 5 and bool(_GEO_ADDR_RE.search(q)) and bool(re.search(r"[А-Яа-яЁёІіЎў]{3}", q))
    plain = data
    if data and _geocoder is not None and fuzzy and looks_addr:
        try:                                    # [v20] «Брест, ул. Советская 10» → Nominatim находит по области
            pc = _geocoder.parse(q)["city"]
            if pc and not any(_geocoder.in_place(x, pc) for x in data):
                data, city = [], pc
            else:
                data = _geocoder.flag_approx(q, data)
        except Exception as e:
            logger.debug(f"[geocode_proxy] parse: {e}")
    if not data and _geocoder is not None and fuzzy and (city or looks_addr):
        center = None
        if lat is not None and lon is not None and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
            center = (float(lat), float(lon))
        if _GEO_FUZZY_SEM.acquire(timeout=2.0):
            try:
                data = _geocoder.search(q, city=city, limit=min(limit, 10), center=center,
                                        budget_s=float(os.getenv("GEOCODER_BUDGET_S", "11")))
            except Exception as e:
                logger.warning(f"[geocode_proxy] fuzzy: {e}")
            finally:
                _GEO_FUZZY_SEM.release()
    return JSONResponse(content=data or plain or [])


@app.on_event("startup")
async def _geocoder_warmup():
    """[v20] Фоновая загрузка списка улиц города по умолчанию (для исправления опечаток)."""
    if _geocoder is None or os.getenv("GEOCODER_WARM", "1") == "0" or os.getenv("GEOCODER_OFF") == "1":
        return
    def _warm():
        time.sleep(15)
        try:
            _geocoder.city_streets(_geocoder.DEFAULT_CITY, wait_s=0)
        except Exception as e:
            logger.debug(f"[geocode] warmup: {e}")
    threading.Thread(target=_warm, daemon=True, name="geocoder-warmup").start()

@app.get("/health")
async def health():
    # no-store: используется индикатором соединения (static/net-status.js) —
    # ответ не должен браться из кэша браузера/nginx/Service Worker.
    # [v18 PERF] no-cache вместо no-store: ответ всё так же не берётся из кэша без проверки,
    # но страница, получившая no-store из fetch(), не попадает в кэш «назад/вперёд» (bfcache).
    return JSONResponse({"status": "ok", "timestamp": datetime.now().isoformat()},
                        headers={"Cache-Control": "no-cache, max-age=0, must-revalidate"})


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    """Service Worker должен отдаваться из корня, чтобы его scope был '/'."""
    path = os.path.join(_STATIC_DIR, "sw.js")
    if not os.path.exists(path):
        raise HTTPException(404)
    return FileResponse(path, media_type="application/javascript", headers={
        "Cache-Control": "no-cache, max-age=0",
        "Service-Worker-Allowed": "/",
    })

@app.get("/api/news")
async def api_news(page: int = Query(1, ge=1, le=50)):
    """Новости belgosles.by (картинка + текст) для панели в index.html.
    Данные берутся из кэша, который обновляется фоном, пока сервер активен."""
    data = await run_in_threadpool(get_news_page, page)
    # [v18 PERF] Картинки — через локальные миниатюры (/api/news/img): вместо PNG по 400–750 КБ
    # с belgosles.by браузер получает WebP ~30–60 КБ из кэша портала (LCP, «Оптимизация изображений»).
    try:
        items = data.get("items") if isinstance(data, dict) else None
        if items:
            data = {**data, "items": [_news_public_item(it) for it in items]}
    except Exception as e:
        logger.debug(f"[news] миниатюры не подставлены: {e}")
    return JSONResponse(data)


# ── [v18 PERF] Миниатюры картинок новостей ─────────────────────────────────────
# Скачиваются сервером ОДИН раз, уменьшаются до 640 px по ширине (панель ~390 px,
# запас под экраны 1.5–2x), сохраняются в cache/news_img/ (WebP, иначе JPEG).
# Источник — только https://belgosles.by (и поддомены); каждый редирект проверяется
# заново, поэтому эндпоинт нельзя использовать как прокси к другим адресам (SSRF).
_NEWS_IMG_DIR       = os.path.join(CACHE_FOLDER, "news_img")
_NEWS_IMG_HOSTS     = ("belgosles.by",)
_NEWS_IMG_MAX_BYTES = 15 * 1024 * 1024
_NEWS_IMG_WIDTH     = 640
_NEWS_IMG_KEEP      = 400          # сколько миниатюр хранить (старые удаляются)


def _news_img_allowed(u: str) -> bool:
    try:
        pu = urlparse(u)
        host = (pu.hostname or "").lower()
        return (pu.scheme == "https" and not pu.username and not pu.password
                and pu.port in (None, 443)
                and any(host == h or host.endswith("." + h) for h in _NEWS_IMG_HOSTS))
    except Exception:
        return False


def _news_public_item(it):
    """Новость для браузера: картинка — через локальную миниатюру /api/news/img."""
    if isinstance(it, dict) and it.get("image") and _news_img_allowed(it["image"]):
        from urllib.parse import quote as _q
        return {**it, "image_orig": it.get("image"),
                "image": "/api/news/img?u=" + _q(it["image"], safe="")}
    return it


def _news_ssr_first() -> Optional[dict]:
    """[v18 PERF] Первая новость для серверной отрисовки панели в index.html.
    Только из кэша в памяти (его держит фоновый поток), без сетевых запросов.
    Картинка новости — самый крупный элемент первого экрана (LCP): раньше она появлялась
    только после /api/news и JS, теперь браузер находит её сразу в HTML.
    None — кэша ещё нет (первые секунды после запуска): панель, как раньше, заполнит JS."""
    try:
        with _news_cache_lock:
            c = _news_cache.get(1)
        d = (c or {}).get("data") or {}
        items = [x for x in (d.get("items") or []) if isinstance(x, dict)]
        if not d.get("ok") or not items:
            return None
        it = _news_public_item(items[0])
        title = str(it.get("title") or "").strip()
        if not title:
            return None
        url = str(it.get("url") or "")
        if not url.startswith(("https://", "http://")):
            url = "#"
        img = str(it.get("image") or "")
        if img and not img.startswith(("/api/news/img?", "https://")):
            img = ""
        return {"title": title, "date": str(it.get("date") or ""), "url": url,
                "image": img, "count": min(6, len(items))}
    except Exception:
        return None


def _news_prewarm_thumbs(limit: int = 6):
    """[v18 PERF] Готовит миниатюры первых новостей заранее (вызывается из фонового потока
    обновления новостей), чтобы первая картинка панели не ждала скачивания с belgosles.by."""
    try:
        with _news_cache_lock:
            c = _news_cache.get(1)
        items = ((c or {}).get("data") or {}).get("items") or []
        for it in items[:limit]:
            u = it.get("image") if isinstance(it, dict) else None
            if u and _news_img_allowed(u):
                try:
                    _news_thumb_sync(u)
                except Exception as e:
                    logger.debug(f"[news] миниатюра не подготовлена ({e})")
    except Exception as e:
        logger.debug(f"[news] prewarm: {e}")


def _news_img_cleanup():
    try:
        files = [os.path.join(_NEWS_IMG_DIR, f) for f in os.listdir(_NEWS_IMG_DIR)]
        files = [f for f in files if os.path.isfile(f)]
        if len(files) <= _NEWS_IMG_KEEP:
            return
        files.sort(key=lambda f: os.path.getmtime(f))
        for f in files[:len(files) - _NEWS_IMG_KEEP]:
            try:
                os.remove(f)
            except OSError:
                pass
    except OSError:
        pass


def _news_thumb_sync(u: str):
    key = hashlib.sha1(u.encode("utf-8")).hexdigest()
    os.makedirs(_NEWS_IMG_DIR, exist_ok=True)
    for ext, mt in ((".webp", "image/webp"), (".jpg", "image/jpeg")):
        fp = os.path.join(_NEWS_IMG_DIR, key + ext)
        if os.path.isfile(fp):
            return fp, mt
    sess = _news_make_session()
    url = u
    raw = None
    for _hop in range(4):
        if not _news_img_allowed(url):
            raise ValueError("недопустимый адрес картинки")
        with sess.get(url, timeout=NEWS_REQUEST_TIMEOUT, stream=True, allow_redirects=False) as r:
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                url = urljoin(url, r.headers["location"])
                continue
            if r.status_code != 200:
                raise ValueError(f"HTTP {r.status_code}")
            if not (r.headers.get("content-type") or "").lower().startswith("image/"):
                raise ValueError("не картинка")
            buf = io.BytesIO()
            for chunk in r.iter_content(65536):
                buf.write(chunk)
                if buf.tell() > _NEWS_IMG_MAX_BYTES:
                    raise ValueError("слишком большой файл")
            raw = buf.getvalue()
        break
    if raw is None:
        raise ValueError("слишком много перенаправлений")
    from PIL import ImageOps as _ImageOps
    im = Image.open(io.BytesIO(raw))
    if im.width * im.height > 60_000_000:
        raise ValueError("слишком большое изображение")
    try:
        im.draft("RGB", (_NEWS_IMG_WIDTH * 2, _NEWS_IMG_WIDTH * 2))
    except Exception:
        pass
    im = _ImageOps.exif_transpose(im)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA" if has_alpha else "RGB")
    if im.width > _NEWS_IMG_WIDTH:
        im = im.resize((_NEWS_IMG_WIDTH, max(1, round(im.height * _NEWS_IMG_WIDTH / im.width))), Image.LANCZOS)
    tmp = os.path.join(_NEWS_IMG_DIR, f"{key}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        im.save(tmp, "WEBP", quality=74, method=4)
        fp, mt = os.path.join(_NEWS_IMG_DIR, key + ".webp"), "image/webp"
    except Exception:
        if has_alpha:
            bg = Image.new("RGB", im.size, (13, 26, 16))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im.convert("RGB").save(tmp, "JPEG", quality=80, optimize=True, progressive=True)
        fp, mt = os.path.join(_NEWS_IMG_DIR, key + ".jpg"), "image/jpeg"
    os.replace(tmp, fp)
    _news_img_cleanup()
    return fp, mt


@app.get("/api/news/img")
async def api_news_img(u: str = Query(..., min_length=10, max_length=2048)):
    if not _news_img_allowed(u):
        raise HTTPException(400, "Недопустимый адрес")
    try:
        fp, mt = await run_in_threadpool(_news_thumb_sync, u)
    except Exception as e:
        logger.info(f"[news] миниатюра не получена ({e}) — отдаю исходную ссылку")
        # Картинка всё равно покажется — браузер возьмёт оригинал с сайта
        return RedirectResponse(u, status_code=302, headers={"Cache-Control": "no-cache"})
    return FileResponse(fp, media_type=mt, headers={
        "Cache-Control": "public, max-age=2592000, immutable",
        "X-Content-Type-Options": "nosniff"})

@app.get("/uploads/{filename:path}")
async def uploaded_file(request: Request, filename: str):
    # [SEC v16] Было os.path.join(UPLOAD_FOLDER, filename): «/uploads//etc/passwd»,
    # «/uploads/C:/Windows/win.ini» или «%2F..» отдавали ЛЮБОЙ файл сервера.
    p = _sh.safe_join(UPLOAD_FOLDER, filename)
    if not p or not os.path.isfile(p):
        raise HTTPException(404)

    # ── ETag: MD5 первых 8 КБ + размер + mtime → стабильный, быстрый ──────
    stat = os.stat(p)
    _tag_src = f"{stat.st_size}:{stat.st_mtime_ns}:{filename}"
    etag = '"' + hashlib.md5(_tag_src.encode()).hexdigest()[:20] + '"'

    if request.headers.get("If-None-Match") == etag:
        return Response(status_code=304)

    # Превью — статичные PNG, кэшируем агрессивно (7 дней)
    is_preview = filename.startswith("previews/")
    headers = {
        "Cache-Control": "public, max-age=604800, immutable" if is_preview
                         else "public, max-age=3600",
        "ETag":  etag,
        "Vary":  "Accept-Encoding",
    }
    return FileResponse(p, headers=headers)

# ── In-memory кэш списка снимков ────────────────────────────────────────────
# Снимки меняются только при upload/delete. TTL 5 мин — страховка.
_images_cache: list = []
_images_cache_ts: float = 0.0
_IMAGES_CACHE_TTL = 300  # секунд

def _images_cache_invalidate():
    global _images_cache, _images_cache_ts
    _images_cache = []
    _images_cache_ts = 0.0

@app.get("/api/images")
def get_images(db: Session = Depends(get_db)):
    global _images_cache, _images_cache_ts
    now = time.time()
    if _images_cache and (now - _images_cache_ts) < _IMAGES_CACHE_TTL:
        return _images_cache
    rows = db.query(Imagery).all()
    result = [r.to_dict() for r in rows]
    _images_cache = result
    _images_cache_ts = now
    return result

@app.get("/api/download_catalog")
def download_catalog(db: Session = Depends(get_db)):
    import geopandas as gpd
    try:
        gdf = gpd.read_postgis("SELECT id,leskhoz_id,date_shot,equipment,contract_num,organization,geom FROM imagery", engine, geom_col='geom')
        if gdf.empty: raise HTTPException(404,"База пуста")
        tmp = tempfile.mkdtemp(prefix="tmp_cat_", dir=CUSTOM_TEMP_DIR)  # [FIX v16] было tmp_cat_<секунда> — гонка параллельных запросов
        gdf.to_file(os.path.join(tmp,'Catalog.shp'), driver='ESRI Shapefile', encoding='utf-8')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as zf:
            for f in os.listdir(tmp): zf.write(os.path.join(tmp,f),f)
        shutil.rmtree(tmp,ignore_errors=True); buf.seek(0)
        return StreamingResponse(buf, media_type="application/zip",
            headers={"Content-Disposition":"attachment; filename=Catalog.zip"})
    except HTTPException: raise
    except Exception as e: raise HTTPException(500,str(e))

# [SEC/PERF v16] Раньше: (1) без авторизации — любой мог выгрузить все снимки
# перебором id; (2) ZIP со снимком (сотни МБ) собирался в ОПЕРАТИВНОЙ памяти,
# DEFLATE по уже сжатому TIFF — 10 параллельных запросов «съедали» RAM и CPU.
# Теперь: зарегистрированный пользователь/администратор (DOWNLOAD_ZIP_PUBLIC=1 —
# как раньше, для всех), архив пишется во временный файл, TIFF без пережатия,
# не более ZIP_BUILD_CONCURRENCY сборок одновременно.
_ZIP_BUILD_SEM = threading.BoundedSemaphore(max(1, int(os.getenv("ZIP_BUILD_CONCURRENCY", "3"))))
_ZIP_STORED_EXT = ('.tif', '.tiff', '.jpg', '.jpeg', '.png', '.zip', '.ecw', '.jp2')


def _remove_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


@app.get("/download_zip/{img_id}")
def download_zip(img_id: int, request: Request, db: Session = Depends(get_db)):
    if os.getenv("DOWNLOAD_ZIP_PUBLIC", "0").strip().lower() not in ("1", "true", "yes", "on"):
        if not _is_registered_or_admin(get_real_ip(request), get_current_user(request), get_device_id(request)):
            raise HTTPException(403, "Скачивание снимков доступно зарегистрированным пользователям")
    rec = db.query(Imagery).filter(Imagery.id==img_id).first()
    if not rec: raise HTTPException(404)
    if not _ZIP_BUILD_SEM.acquire(timeout=20):
        raise HTTPException(503, "Сервер занят подготовкой архивов, повторите через минуту",
                            headers={"Retry-After": "30"})
    fd, tmp_zip = tempfile.mkstemp(suffix=".zip", dir=CUSTOM_TEMP_DIR)
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_zip, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for fname in [rec.filename,rec.meta_filename,rec.tfw_filename]:
                if fname:
                    p = _sh.safe_join(UPLOAD_FOLDER, fname)
                    if p and os.path.isfile(p):
                        ctype = zipfile.ZIP_STORED if fname.lower().endswith(_ZIP_STORED_EXT) else zipfile.ZIP_DEFLATED
                        zf.write(p, arcname=os.path.basename(fname), compress_type=ctype)
    except Exception:
        _remove_quiet(tmp_zip)
        raise
    finally:
        _ZIP_BUILD_SEM.release()
    from starlette.background import BackgroundTask as _BgTask
    _lk = re.sub(r'[^A-Za-z0-9_-]', '_', str(rec.leskhoz_id or 'img'))[:40]
    return FileResponse(tmp_zip, media_type="application/zip", filename=f"DZZ_{_lk}.zip",
                        background=_BgTask(_remove_quiet, tmp_zip),
                        headers={"Cache-Control": "private, no-store"})

@app.delete("/delete_image/{img_id}")
def delete_image(
    img_id: int,
    db: Session = Depends(get_db),
    admin_user_id: str = Depends(require_admin),
    _csrf=Depends(verify_csrf),  # [C] CSRF-защита
):
    # [C] Аудит-лог удаления
    import logging as _log
    _log.getLogger("audit").info("DELETE image id=%s by user=%s", img_id, admin_user_id)
    rec = db.query(Imagery).filter(Imagery.id==img_id).first()
    if not rec: raise HTTPException(404)
    for f in [rec.filename,rec.preview_filename,rec.meta_filename,rec.tfw_filename]:
        if f:
            try: os.remove(os.path.join(UPLOAD_FOLDER,f))
            except: pass
    db.delete(rec); db.commit()
    _images_cache_invalidate()  # сброс in-memory кэша — удалённый снимок не виден
    return {"success":True}

@app.post("/edit_image/{img_id}")
async def edit_image(img_id: int, request: Request, db: Session = Depends(get_db), _=Depends(require_admin)):
    rec = db.query(Imagery).filter(Imagery.id==img_id).first()
    if not rec: raise HTTPException(404)
    form = await request.form()
    rec.date_shot=form.get('date_shot'); rec.equipment=form.get('equipment')
    rec.contract_num=form.get('contract'); rec.organization=form.get('organization')
    rec.survey_type=form.get('survey_type'); db.commit()
    return {"success":True}

@app.post("/upload")
async def upload_file_route(
    file: UploadFile=File(...), leskhoz_id: str=Form(""),
    survey_type: str=Form("uav"), date_shot: str=Form(""),
    equipment: str=Form(""), organization: str=Form(""),
    contract_num: str=Form(""), skip_tfw: str=Form("false"),
    db: Session=Depends(get_db), _=Depends(require_admin)
):
    try:
        total,used,free = shutil.disk_usage(UPLOAD_FOLDER)
        if free < 500*1024*1024: raise HTTPException(507,"На сервере закончилось место")
        if not allowed_file(file.filename): raise HTTPException(400,"Недопустимый формат")
        safe_name = _sh.sanitize_filename(file.filename, default="upload.tif", ascii_only=True)  # [SEC v16]
        tif_path  = _sh.safe_join(UPLOAD_FOLDER, safe_name)
        if not tif_path: raise HTTPException(400, "Недопустимое имя файла")
        # [PERF v16] потоково на диск (раньше весь TIFF в RAM + блокировка event loop)
        await _sh.save_upload(file, tif_path, max_bytes=int(os.getenv("UPLOAD_MAX_MB", "4096")) * 1024 * 1024)
        base_name = os.path.splitext(safe_name)[0]
        preview_name = base_name+".png"; meta_name = base_name+".txt"
        bounds = await run_in_threadpool(generate_preview, tif_path, preview_name)
        geom = None
        if bounds:
            from geoalchemy2.shape import from_shape as _fs
            from shapely.geometry import box as _sbox
            geom = _fs(_sbox(bounds['west'],bounds['south'],bounds['east'],bounds['north']),srid=4326)
        img_channels,img_crs = 0,"Unknown"
        try:
            with rasterio.open(tif_path) as src:
                img_channels=src.count
                if src.crs: img_crs=src.crs.to_string()
        except: pass
        found = next((x for x in MANUAL_FORESTRY_FIX if x["code"]==leskhoz_id),None)
        RMAP = {1:'Брестская',2:'Витебская',3:'Гомельская',4:'Гродненская',5:'Минская',6:'Могилевская'}
        rec = Imagery(filename=safe_name,leskhoz_id=leskhoz_id,
            leskhoz_name=found['name'] if found else 'Неизвестный',
            region_name=RMAP.get(found['region'] if found else 0,'Не определена'),
            channels=img_channels,crs_name=img_crs,date_shot=date_shot,
            equipment=equipment,contract_num=contract_num,organization=organization,
            survey_type=survey_type,meta_filename=meta_name,
            preview_filename=preview_name if bounds else None,geom=geom)
        db.add(rec); db.commit(); db.refresh(rec)
        with open(os.path.join(UPLOAD_FOLDER,meta_name),'w',encoding='utf-8') as f:
            f.write(f"File: {safe_name}\nID: {leskhoz_id}")
        _images_cache_invalidate()  # сброс in-memory кэша — новый снимок сразу виден
        return {"success":True,"message":"Файл загружен","id":rec.id}
    except HTTPException: raise
    except Exception as e: raise HTTPException(500,str(e))

# ── In-memory кэш векторных слоёв ───────────────────────────────────────────
# Слои меняются только при upload/delete (редко) — кэшируем в памяти процесса.
# При изменении вызываем _vectors_cache_invalidate() — следующий запрос перечитает БД.
# TTL 10 мин — страховка от утечки устаревших данных если инвалидация не сработала.
_vectors_cache: list = []
_vectors_cache_ts: float = 0.0
_VECTORS_CACHE_TTL = 600  # секунд

def _vectors_cache_invalidate():
    global _vectors_cache, _vectors_cache_ts
    _vectors_cache = []
    _vectors_cache_ts = 0.0

@app.get("/api/vectors")
def get_vectors(db: Session=Depends(get_db)):
    global _vectors_cache, _vectors_cache_ts
    now = time.time()
    if _vectors_cache and (now - _vectors_cache_ts) < _VECTORS_CACHE_TTL:
        return _vectors_cache
    rows = db.query(VectorLayer).all()
    result = [{"id":r.id,"name":r.name,"color":r.color,"weight":r.weight,
               "fill_opacity":r.fill_opacity,"data":r.geojson_data} for r in rows]
    _vectors_cache = result
    _vectors_cache_ts = now
    return result

_SHP_PARTS = ('.shp', '.shx', '.dbf', '.prj', '.cpg', '.qix', '.sbn', '.sbx', '.xml', '.qmd')


@app.post("/upload_shp")
async def upload_shp(files: List[UploadFile]=File(...), layer_name: str=Form("Новый слой"),
                     layer_color: str=Form('#3388ff'), layer_weight: int=Form(2),
                     layer_filled: str=Form("off"), db: Session=Depends(get_db),
                     _=Depends(require_admin)):
    # [SEC v16] Раньше: без авторизации (любой создавал слои) и dest = join(tmp, f.filename) —
    # имя «../../static/x.js» записывало файл в произвольное место сервера.
    import geopandas as gpd
    fill_opacity = 0.2 if layer_filled=="on" else 0.0
    layer_name = (layer_name or "Новый слой").strip()[:200] or "Новый слой"
    if not re.fullmatch(r"#[0-9A-Fa-f]{3,8}", layer_color or ""): layer_color = '#3388ff'
    layer_weight = max(0, min(int(layer_weight or 2), 20))
    try:
        with tempfile.TemporaryDirectory() as tmp:
            shp_path = None
            if len(files) > 20: raise HTTPException(400, "Слишком много файлов")
            for f in files:
                fname = _sh.sanitize_filename(f.filename, default="layer")
                if not fname.lower().endswith(_SHP_PARTS):
                    continue
                dest = _sh.safe_join(tmp, fname)
                if not dest: raise HTTPException(400, "Недопустимое имя файла")
                await _sh.save_upload(f, dest, max_bytes=512 * 1024 * 1024)
                if fname.lower().endswith('.shp'): shp_path = dest
            if not shp_path: raise HTTPException(400,"Нет .shp файла")
            try: gdf = gpd.read_file(shp_path, encoding='cp1251')
            except: gdf = gpd.read_file(shp_path, encoding='utf-8')
            if gdf.crs is None: raise HTTPException(400,"В файле нет привязки (.prj)")
            # [FIX] СК-42/СК-63 в .prj (ESRI WKT) приходят БЕЗ TOWGS84 → pyproj переводил
            # в WGS-84 без смены датума и слой съезжал на ~100–150 м относительно
            # конвертера СК и подложки. Подставляем те же параметры, что везде в геопортале.
            gdf = gdf.set_crs(_krass_with_towgs84(gdf.crs), allow_override=True)
            if gdf.crs != "EPSG:4326": gdf = gdf.to_crs("EPSG:4326")
            layer = VectorLayer(name=layer_name,color=layer_color,weight=layer_weight,
                                fill_opacity=fill_opacity,geojson_data=json.loads(gdf.to_json()))
            db.add(layer); db.commit(); db.refresh(layer)
            _vectors_cache_invalidate()  # сброс in-memory кэша
            return {"success":True,"id":layer.id}
    except HTTPException: raise
    except Exception as e: raise HTTPException(500,str(e))

def generate_mbtiles(image_path: str, mbtiles_path: str, name: str):
    """Конвертирует геопривязанное изображение в MBTiles и возвращает (bounds, min_z, max_z).
    bounds = (lon_min, lat_min, lon_max, lat_max) в WGS84.
    """
    import sqlite3
    from rasterio.warp import transform_bounds as rb_transform_bounds

    with rasterio.open(image_path) as src:
        wgs84 = CRS.from_epsg(4326)
        b = rb_transform_bounds(src.crs, wgs84, src.bounds.left, src.bounds.bottom,
                                src.bounds.right, src.bounds.top)
        # b = (lon_min, lat_min, lon_max, lat_max)
        width, height = src.width, src.height

    # Выбираем диапазон зумов исходя из размера изображения
    max_dim = max(width, height)
    if max_dim >= 8192:
        min_z, max_z = 5, 16
    elif max_dim >= 2048:
        min_z, max_z = 5, 14
    else:
        min_z, max_z = 5, 12

    conn = sqlite3.connect(mbtiles_path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tiles "
        "(zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, "
        "PRIMARY KEY (zoom_level, tile_column, tile_row))"
    )
    meta = {
        "name": name,
        "format": "png",
        "bounds": f"{b[0]},{b[1]},{b[2]},{b[3]}",
        "minzoom": str(min_z),
        "maxzoom": str(max_z),
        "type": "overlay",
        "version": "1.1",
    }
    conn.executemany(
        "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
        meta.items(),
    )
    conn.commit()
    conn.close()
    return (b[0], b[1], b[2], b[3]), min_z, max_z


@app.post("/upload_basemap")
async def upload_basemap(files: List[UploadFile]=File(...), name: str=Form("New Layer"),
                         db: Session=Depends(get_db), _=Depends(require_admin)):
    session_dir = os.path.join(MAPS_STORAGE,f"temp_{int(time.time())}"); os.makedirs(session_dir,exist_ok=True)
    try:
        image_file = None
        for f in files:
            fname = _sh.sanitize_filename(f.filename, default="image.tif")  # [SEC v16]
            dest = _sh.safe_join(session_dir, fname)
            if not dest: raise HTTPException(400, "Недопустимое имя файла")
            await _sh.save_upload(f, dest, max_bytes=int(os.getenv("UPLOAD_MAX_MB", "4096")) * 1024 * 1024)
            if fname.lower().endswith(('.tif','.tiff','.png','.jpg')): image_file = fname
        if not image_file: raise HTTPException(400,"Нет изображения")
        name = (name or "New Layer").strip()[:120] or "New Layer"
        _safe_base = _sh.sanitize_filename(name.replace(' ', '_'), default="basemap", ascii_only=True)
        mbtiles_path = os.path.join(MAPS_STORAGE, f"{_safe_base}_{int(time.time())}.mbtiles")
        # [PERF v16] нарезка тайлов — минуты CPU; раньше выполнялась прямо в event loop
        bounds,min_z,max_z = await run_in_threadpool(generate_mbtiles, os.path.join(session_dir,image_file), mbtiles_path, name)
        layer = BasemapLayer(name=name,filepath=mbtiles_path,min_zoom=min_z,max_zoom=max_z,
                             bounds_lon_min=bounds[0],bounds_lat_min=bounds[1],bounds_lon_max=bounds[2],bounds_lat_max=bounds[3])
        db.add(layer); db.commit(); return {"success":True}
    except HTTPException: raise
    except Exception as e: raise HTTPException(500,str(e))
    finally: shutil.rmtree(session_dir,ignore_errors=True)

@app.get("/api/basemaps")
def get_basemaps(db: Session=Depends(get_db)):
    return [{"id":r.id,"name":r.name,"min_zoom":r.min_zoom,"max_zoom":r.max_zoom,
             "bounds":[[r.bounds_lat_min,r.bounds_lon_min],[r.bounds_lat_max,r.bounds_lon_max]]}
            for r in db.query(BasemapLayer).all()]

# ==========================================
# [MBTiles] ЗАГРУЗКА ГОТОВЫХ .mbtiles ПРЯМО В ПАНЕЛЬ СЛОЁВ
# Папка MBTILES_MINSK_FOLDER = maps_storage/MBTILES_MINSK — общая для всех
# файлов, добавляемых через кнопку «+ Добавить MBTiles» в панели слоёв.
# ==========================================

# Кэш открытых sqlite-соединений с mbtiles-файлами (тайлы читаются часто,
# переоткрывать файл на каждый запрос тайла — дорого).
_mbtiles_conn_cache: dict = {}
_mbtiles_conn_lock = threading.Lock()

# [FIX ЛАГОВ] Один sqlite3.Connection не потокобезопасен для одновременных
# запросов из разных потоков threadpool'а, даже с check_same_thread=False —
# конкурентные execute() на одном объекте соединения сериализуются "вслепую"
# и под нагрузкой (много тайлов разом при массовом включении слоёв) это
# создаёт затор. Даём каждому файлу свой Lock на чтение.
_mbtiles_conn_read_locks: dict = {}

def _get_mbtiles_conn_lock(filepath: str) -> threading.Lock:
    with _mbtiles_conn_lock:
        lock = _mbtiles_conn_read_locks.get(filepath)
        if lock is None:
            lock = threading.Lock()
            _mbtiles_conn_read_locks[filepath] = lock
        return lock

# [FIX ЛАГОВ] Ограничиваем число тайловых запросов к mbtiles, которые
# реально выполняются одновременно в threadpool'е. Клиент (map-core.js)
# уже троттлит запросы до 6 параллельных на источник, но это не защищает
# от нескольких вкладок/пользователей разом — семафор на бэкенде вторая
# линия защиты, не даёт очереди sqlite-чтений разрастись бесконтрольно.
_mbtiles_tile_semaphore = _asyncio.Semaphore(8)

def _get_mbtiles_conn(filepath: str):
    with _mbtiles_conn_lock:
        conn = _mbtiles_conn_cache.get(filepath)
        if conn is None:
            conn = sqlite3.connect(filepath, check_same_thread=False)
            _mbtiles_conn_cache[filepath] = conn
        return conn

def _close_mbtiles_conn(filepath: str):
    with _mbtiles_conn_lock:
        conn = _mbtiles_conn_cache.pop(filepath, None)
        _mbtiles_conn_read_locks.pop(filepath, None)
    if conn:
        try: conn.close()
        except Exception: pass

# [MBTiles] In-memory LRU-кэш уже прочитанных тайлов (готовые байты PNG/JPEG).
# Соединение с sqlite (выше) избавляет от повторного открытия файла, но каждый
# запрос всё равно уходит в run_in_threadpool + SELECT из БД. При массовом
# включении/выключении слоёв (см. «включить/выключить все» в панели) один и тот
# же участок запрашивается повторно за секунды — этот кэш отдаёт такие тайлы
# из RAM синхронно, без похода в threadpool и sqlite вообще.
# Ключ — (layer_id, z, x, y); значение — сырые байты тайла.
_mbtiles_tile_cache: "collections.OrderedDict" = collections.OrderedDict()
_mbtiles_tile_cache_lock = threading.Lock()
_MBTILES_TILE_CACHE_MAX = 4000  # ~4000 тайлов ≈ 40–120 МБ в зависимости от формата

def _mbtiles_tile_cache_get(key):
    with _mbtiles_tile_cache_lock:
        val = _mbtiles_tile_cache.get(key)
        if val is not None:
            _mbtiles_tile_cache.move_to_end(key)  # LRU: свежий запрос — в конец
        return val

def _mbtiles_tile_cache_put(key, data: bytes):
    with _mbtiles_tile_cache_lock:
        _mbtiles_tile_cache[key] = data
        _mbtiles_tile_cache.move_to_end(key)
        while len(_mbtiles_tile_cache) > _MBTILES_TILE_CACHE_MAX:
            _mbtiles_tile_cache.popitem(last=False)  # вытесняем самый старый

def _mbtiles_tile_cache_clear_layer(layer_id):
    """Чистит кэш тайлов конкретного слоя — вызывается при удалении mbtiles-слоя,
    чтобы после удаления файла из кэша не отдавались «призрачные» старые тайлы."""
    with _mbtiles_tile_cache_lock:
        for k in [k for k in _mbtiles_tile_cache if k[0] == layer_id]:
            del _mbtiles_tile_cache[k]

def _read_mbtiles_metadata(filepath: str):
    """Читает metadata-таблицу .mbtiles файла. Возвращает (name, format, bounds, min_zoom, max_zoom).
    Если чего-то нет в metadata — подстраховываемся вычислением по таблице tiles."""
    conn = sqlite3.connect(filepath)
    try:
        cur = conn.cursor()
        meta = {}
        try:
            cur.execute("SELECT name, value FROM metadata")
            meta = dict(cur.fetchall())
        except Exception:
            meta = {}

        bounds_str = meta.get('bounds')
        if bounds_str:
            try:
                lon_min, lat_min, lon_max, lat_max = [float(v) for v in bounds_str.split(',')]
            except Exception:
                lon_min, lat_min, lon_max, lat_max = 23.16, 51.25, 32.78, 56.17  # Беларусь — запасной вариант
        else:
            lon_min, lat_min, lon_max, lat_max = 23.16, 51.25, 32.78, 56.17

        def _int_or_none(v):
            try: return int(v)
            except Exception: return None

        min_z = _int_or_none(meta.get('minzoom'))
        max_z = _int_or_none(meta.get('maxzoom'))
        if min_z is None or max_z is None:
            try:
                cur.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles")
                row = cur.fetchone()
                if row:
                    min_z = min_z if min_z is not None else (row[0] or 0)
                    max_z = max_z if max_z is not None else (row[1] or 19)
            except Exception:
                min_z = min_z if min_z is not None else 0
                max_z = max_z if max_z is not None else 19

        fmt = (meta.get('format') or 'png').lower()
        if fmt not in ('png', 'jpg', 'jpeg', 'webp'):   # [v19] webp — из «План → MBTiles»
            fmt = 'png'
        name = meta.get('name') or ''
        return name, fmt, (lon_min, lat_min, lon_max, lat_max), min_z, max_z
    finally:
        conn.close()

@app.post("/api/mbtiles/upload")
async def upload_mbtiles(file: UploadFile = File(...), name: str = Form(""),
                         db: Session = Depends(get_db), _=Depends(require_admin)):  # [SEC v16] было без авторизации
    """Принимает готовый .mbtiles файл и кладёт его в папку MBTILES MINSK.
    Слой сразу же становится доступен в панели слоёв («📁 MBTILES MINSK»)."""
    orig_name = file.filename or "layer.mbtiles"
    if not orig_name.lower().endswith('.mbtiles'):
        raise HTTPException(400, "Файл должен иметь расширение .mbtiles")

    safe_base = secure_filename(orig_name) or "layer.mbtiles"
    dest_filename = f"{int(time.time())}_{safe_base}"
    dest_path = os.path.join(MBTILES_MINSK_FOLDER, dest_filename)

    try:
        with open(dest_path, 'wb') as fh:
            shutil.copyfileobj(file.file, fh)

        meta_name, fmt, bounds, min_z, max_z = await run_in_threadpool(_read_mbtiles_metadata, dest_path)
        display_name = (name or "").strip() or meta_name or os.path.splitext(safe_base)[0]

        layer = MbtilesLayer(
            name=display_name, filename=dest_filename, folder='MBTILES MINSK',
            tile_format=fmt, min_zoom=min_z, max_zoom=max_z,
            bounds_lon_min=bounds[0], bounds_lat_min=bounds[1],
            bounds_lon_max=bounds[2], bounds_lat_max=bounds[3],
        )
        db.add(layer); db.commit(); db.refresh(layer)

        return {
            "success": True, "id": layer.id, "name": layer.name, "folder": layer.folder,
            "min_zoom": layer.min_zoom, "max_zoom": layer.max_zoom,
            "bounds": [[layer.bounds_lat_min, layer.bounds_lon_min],
                       [layer.bounds_lat_max, layer.bounds_lon_max]],
            "tile_url": f"/api/mbtiles/{layer.id}/{{z}}/{{x}}/{{y}}." + fmt,
        }
    except HTTPException:
        raise
    except Exception as e:
        try:
            if os.path.exists(dest_path): os.remove(dest_path)
        except Exception: pass
        raise HTTPException(500, f"Ошибка загрузки MBTiles: {e}")

@app.get("/api/mbtiles/list")
def list_mbtiles(db: Session = Depends(get_db)):
    """Список всех mbtiles-слоёв, сгруппированных в папку MBTILES MINSK."""
    rows = db.query(MbtilesLayer).order_by(MbtilesLayer.upload_date.asc()).all()
    return {
        "folder": "MBTILES MINSK",
        "items": [{
            "id": r.id, "name": r.name, "folder": r.folder or "MBTILES MINSK",
            "min_zoom": r.min_zoom, "max_zoom": r.max_zoom,
            "bounds": [[r.bounds_lat_min, r.bounds_lon_min], [r.bounds_lat_max, r.bounds_lon_max]],
            "tile_url": f"/api/mbtiles/{r.id}/{{z}}/{{x}}/{{y}}." + (r.tile_format or "png"),
        } for r in rows]
    }

_MBT_META = {}            # layer_id -> (expires, filename, tile_format)
_MBT_META_LOCK = threading.Lock()

def _mbtiles_meta(layer_id: int):
    now = time.time()
    with _MBT_META_LOCK:
        m = _MBT_META.get(layer_id)
        if m and m[0] > now:
            return m[1], m[2]
    db = SessionLocal()
    try:
        layer = db.query(MbtilesLayer).filter(MbtilesLayer.id == layer_id).first()
        val = (layer.filename, layer.tile_format or "png") if layer else (None, None)
    finally:
        db.close()
    with _MBT_META_LOCK:
        _MBT_META[layer_id] = (now + 60, val[0], val[1])
    return val

@app.get("/api/mbtiles/{layer_id}/{z}/{x}/{y}.{ext}")
async def get_mbtiles_tile(layer_id: int, z: int, x: int, y: int, ext: str):
    """Отдаёт тайл из .mbtiles по XYZ-координатам (фронтенд использует ol.source.XYZ).
    MBTiles хранит тайлы в схеме TMS (Y снизу вверх) — конвертируем в XYZ (Y сверху вниз)."""
    media = "image/jpeg" if ext in ("jpg", "jpeg") else ("image/webp" if ext == "webp" else "image/png")

    # 0. In-memory кэш — если тайл уже читали раньше, отдаём сразу из RAM,
    #    без похода в БД/sqlite/threadpool. Ключ по (layer_id, z, x, y) —
    #    для media-type достаточно расширения из URL, БД не нужна.
    cache_key = (layer_id, z, x, y)
    cached = _mbtiles_tile_cache_get(cache_key)
    if cached is not None:
        return Response(cached, media_type=media, headers={
            "Cache-Control": "public, max-age=86400, s-maxage=86400",
        })

    # [PERF] метаданные слоя — из кэша (60 с), запрос к БД — в потоке
    _fname, _fmt = await run_in_threadpool(_mbtiles_meta, layer_id)
    if not _fname:
        return _send_blank_tile()

    filepath = os.path.join(MBTILES_MINSK_FOLDER, _fname)
    if not os.path.exists(filepath):
        return _send_blank_tile()

    tms_y = (2 ** z - 1) - y
    if tms_y < 0:
        return _send_blank_tile()

    def _read_tile():
        conn = _get_mbtiles_conn(filepath)
        lock = _get_mbtiles_conn_lock(filepath)
        # [FIX ЛАГОВ] Сериализуем доступ к общему sqlite-соединению этого файла —
        # без этого много потоков threadpool'а одновременно дёргают один и тот
        # же connection-объект, что под нагрузкой (массовое включение слоёв)
        # создаёт затор и резко увеличивает время ответа каждого тайла.
        with lock:
            cur = conn.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, tms_y)
            )
            row = cur.fetchone()
        return row[0] if row else None

    try:
        async with _mbtiles_tile_semaphore:
            data = await run_in_threadpool(_read_tile)
    except Exception:
        return _send_blank_tile()

    if not data:
        return _send_blank_tile()

    data = bytes(data)
    media = "image/jpeg" if _fmt in ("jpg", "jpeg") else ("image/webp" if _fmt == "webp" else "image/png")
    _mbtiles_tile_cache_put(cache_key, data)
    return Response(data, media_type=media, headers={
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
    })

@app.delete("/api/mbtiles/{layer_id}")
def delete_mbtiles(layer_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):  # [SEC v16] было без авторизации
    _MBT_META.pop(layer_id, None)
    """Удаляет mbtiles-слой из папки MBTILES MINSK: закрывает соединение, удаляет файл и запись в БД."""
    layer = db.query(MbtilesLayer).filter(MbtilesLayer.id == layer_id).first()
    if not layer:
        raise HTTPException(404, "Слой не найден")

    filepath = os.path.join(MBTILES_MINSK_FOLDER, layer.filename)
    _close_mbtiles_conn(filepath)
    _mbtiles_tile_cache_clear_layer(layer_id)

    db.delete(layer); db.commit()

    try:
        if os.path.exists(filepath): os.remove(filepath)
    except Exception:
        pass

    return {"success": True}

def _send_blank_tile():
    buf = io.BytesIO(); Image.new('RGBA',(256,256),(0,0,0,0)).save(buf,'PNG',optimize=True)
    return Response(buf.getvalue(), media_type="image/png", headers={
        "Cache-Control": "public, max-age=60, s-maxage=60",
    })

def _render_raster_tile(image_paths, tb, ts=256):
    """Рендер тайла в отдельном потоке (не блокирует event loop).
    Использует Resampling.average для низких зумов — стабильнее при отдалении.
    """
    canvas = np.zeros((4, ts, ts), dtype=np.uint8)
    dst_transform = from_bounds(tb.left, tb.bottom, tb.right, tb.top, ts, ts)

    # Определяем качество передискретизации по размеру тайла в метрах
    tile_width_m = tb.right - tb.left
    # < 5 км/тайл — крупный зум (bilinear), иначе average (стабильнее при отдалении)
    resamp = Resampling.bilinear if tile_width_m < 5000 else Resampling.average

    processed = 0
    for fp in image_paths:
        if not os.path.exists(fp):
            continue
        try:
            with rasterio.open(fp) as src:
                # Быстрая проверка: пересекается ли снимок с тайлом?
                src_bounds_3857 = rasterio.warp.transform_bounds(
                    src.crs, 'EPSG:3857',
                    src.bounds.left, src.bounds.bottom,
                    src.bounds.right, src.bounds.top
                )
                if (src_bounds_3857[2] < tb.left or src_bounds_3857[0] > tb.right or
                        src_bounds_3857[3] < tb.bottom or src_bounds_3857[1] > tb.top):
                    continue

                tmp = np.zeros((4, ts, ts), dtype=np.uint8)
                bands = [1, 2, 3] if src.count >= 3 else [1]
                reproject(
                    source=rasterio.band(src, bands),
                    destination=tmp[0:len(bands)],
                    src_transform=src.transform, src_crs=src.crs,
                    dst_transform=dst_transform, dst_crs="EPSG:3857",
                    resampling=resamp, dst_nodata=0,
                )
                if src.count < 3:
                    tmp[1] = tmp[0]; tmp[2] = tmp[0]; mask = tmp[0] > 0
                else:
                    mask = (tmp[0] > 0) | (tmp[1] > 0) | (tmp[2] > 0)
                tmp[3][mask] = 255
                for b in range(4):
                    canvas[b][mask] = tmp[b][mask]
                processed += 1
        except Exception:
            continue
    if not processed or not np.any(canvas[3]):   # проверяем канал альфы, не всё подряд
        return None
    img = Image.fromarray(np.moveaxis(canvas, 0, -1), "RGBA")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True, compress_level=6)
    return buf.getvalue()


# ── Качество тайлов по зуму (X-Tile-Quality от nginx) ───────────────────────
#
#  nginx передаёт заголовок X-Tile-Quality в зависимости от зума:
#    LOW  → zoom 0-9   → JPEG quality=50, ресайз ×0.5 → upscale (быстрая загрузка обзора)
#    MED  → zoom 10-13 → JPEG quality=72, ресайз ×0.75
#    HIGH → zoom 14+   → JPEG quality=90, оригинальный PNG (детальный просмотр)
#
_TILE_QUALITY_PARAMS = {
    "LOW":  {"jpeg_quality": 50,  "scale": 0.5},
    "MED":  {"jpeg_quality": 72,  "scale": 0.75},
    "HIGH": {"jpeg_quality": 90,  "scale": 1.0},
}

def _apply_tile_quality(png_bytes: bytes, quality: str) -> tuple[bytes, str]:
    """
    Принимает PNG-тайл (bytes) и уровень качества (LOW/MED/HIGH).
    Возвращает (bytes, media_type):
      - HIGH → оригинальный PNG без изменений
      - MED/LOW → JPEG с уменьшенным качеством и размером
    """
    params = _TILE_QUALITY_PARAMS.get((quality or "HIGH").upper(), _TILE_QUALITY_PARAMS["HIGH"])

    # HIGH — возвращаем PNG без изменений
    if params["scale"] == 1.0 and params["jpeg_quality"] == 90:
        return png_bytes, "image/png"

    try:
        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")

        # Даунсэмпл → апсэмпл: артефакты блочности создают эффект "меньшей детализации"
        if params["scale"] < 1.0:
            small_w = max(1, int(img.width  * params["scale"]))
            small_h = max(1, int(img.height * params["scale"]))
            img = img.resize((small_w, small_h), Image.LANCZOS)
            img = img.resize((256, 256), Image.BILINEAR)

        # RGBA → RGB (JPEG не поддерживает альфа-канал)
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])

        out = io.BytesIO()
        bg.save(out, format="JPEG", quality=params["jpeg_quality"], optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        # При любой ошибке — возвращаем оригинал
        return png_bytes, "image/png"


# ── In-memory LRU для растровых тайлов ──────────────────────────────────────
# Слой между рендером и диском: 512 тайлов × ~50 КБ ≈ 25 МБ RAM.
# Устраняет повторное чтение с диска при 4 воркерах uvicorn — каждый процесс
# держит свой LRU, горячие тайлы не трогают диск вообще.
_RASTER_LRU: collections.OrderedDict = collections.OrderedDict()
_RASTER_LRU_LOCK = threading.Lock()
_RASTER_LRU_MAX = 512

def _raster_lru_get(z: int, x: int, y: int) -> bytes | None:
    key = (z, x, y)
    with _RASTER_LRU_LOCK:
        if key in _RASTER_LRU:
            _RASTER_LRU.move_to_end(key)
            return _RASTER_LRU[key]
    return None

def _raster_lru_put(z: int, x: int, y: int, data: bytes):
    key = (z, x, y)
    with _RASTER_LRU_LOCK:
        _RASTER_LRU[key] = data
        _RASTER_LRU.move_to_end(key)
        while len(_RASTER_LRU) > _RASTER_LRU_MAX:
            _RASTER_LRU.popitem(last=False)

def _raster_lru_clear():
    with _RASTER_LRU_LOCK:
        _RASTER_LRU.clear()
_TILE_DISK_CACHE = os.path.join(CACHE_FOLDER, "raster_tiles")
os.makedirs(_TILE_DISK_CACHE, exist_ok=True)

def _tile_disk_path(z: int, x: int, y: int) -> str:
    return os.path.join(_TILE_DISK_CACHE, str(z), str(x), f"{y}.png")

def _tile_disk_get(z: int, x: int, y: int):
    p = _tile_disk_path(z, x, y)
    if os.path.exists(p):
        try:
            with open(p, 'rb') as f:
                return f.read()
        except Exception:
            pass
    return None

def _tile_disk_put(z: int, x: int, y: int, data: bytes):
    p = _tile_disk_path(z, x, y)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        tmp = p + ".tmp"
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, p)
    except Exception:
        pass

# Инвалидация дискового кэша по конкретному leskhoz_id (вызывается при загрузке нового снимка)
def _invalidate_raster_tile_cache(leskhoz_id: str = None):
    """Удаляет весь дисковый кэш тайлов и LRU (или можно добавить более точечную логику)."""
    try:
        _raster_lru_clear()  # сначала LRU — мгновенно
        try:
            _raster_final_clear()   # [PERF] готовые тайлы в RAM
        except NameError:
            pass
        shutil.rmtree(_TILE_DISK_CACHE, ignore_errors=True)
        os.makedirs(_TILE_DISK_CACHE, exist_ok=True)
        logger.info(f"Дисковый кэш и LRU тайлов сброшены (leskhoz_id={leskhoz_id})")
    except Exception as e:
        logger.warning(f"Ошибка сброса кэша тайлов: {e}")


_TILE_RESP_HEADERS = {
    "Cache-Control": "public, max-age=604800, s-maxage=604800, immutable",
    "X-Accel-Expires": "604800",
}

# [PERF] Готовые тайлы (уже в нужном качестве LOW/MED/HIGH) — в RAM, с ограничением по байтам.
#        Раньше на КАЖДЫЙ запрос (даже из кэша) тайл перекодировался PIL'ом
#        (LANCZOS + JPEG optimize) прямо в event loop → подтормаживал весь воркер.
_RASTER_FINAL = collections.OrderedDict()
_RASTER_FINAL_LOCK = threading.Lock()
_RASTER_FINAL_BYTES = 0
_RASTER_FINAL_MAX_BYTES = int(os.getenv("RASTER_FINAL_CACHE_MB", "48")) * 1024 * 1024
_raster_tile_semaphore = _asyncio.Semaphore(int(os.getenv("RASTER_TILE_CONCURRENCY", "8")))

def _raster_final_get(key):
    with _RASTER_FINAL_LOCK:
        v = _RASTER_FINAL.get(key)
        if v is not None:
            _RASTER_FINAL.move_to_end(key)
        return v

def _raster_final_put(key, val):
    global _RASTER_FINAL_BYTES
    size = len(val[0])
    if size > 2 * 1024 * 1024:
        return
    with _RASTER_FINAL_LOCK:
        old = _RASTER_FINAL.pop(key, None)
        if old is not None:
            _RASTER_FINAL_BYTES -= len(old[0])
        _RASTER_FINAL[key] = val
        _RASTER_FINAL_BYTES += size
        while _RASTER_FINAL_BYTES > _RASTER_FINAL_MAX_BYTES and _RASTER_FINAL:
            _, ov = _RASTER_FINAL.popitem(last=False)
            _RASTER_FINAL_BYTES -= len(ov[0])

def _raster_final_clear():
    global _RASTER_FINAL_BYTES
    with _RASTER_FINAL_LOCK:
        _RASTER_FINAL.clear()
        _RASTER_FINAL_BYTES = 0

_BLANK_RGBA_PNG = None
def _blank_rgba_png():
    global _BLANK_RGBA_PNG
    if _BLANK_RGBA_PNG is None:
        b = io.BytesIO(); Image.new('RGBA', (256, 256), (0, 0, 0, 0)).save(b, 'PNG', optimize=True)
        _BLANK_RGBA_PNG = b.getvalue()
    return _BLANK_RGBA_PNG

def _raster_tile_sync(z: int, x: int, y: int, tile_quality: str):
    """Весь тяжёлый путь тайла (диск, PostGIS, rasterio, PIL) — в потоке."""
    src_name = "lru-cache"
    png = _raster_lru_get(z, x, y)
    if not png:
        png = _tile_disk_get(z, x, y)
        src_name = "disk-cache"
        if png:
            _raster_lru_put(z, x, y, png)
    if not png:
        ll = mercantile.bounds(x, y, z)
        tb = mercantile.xy_bounds(x, y, z)
        from sqlalchemy import func as sqlfunc
        sg = sqlfunc.ST_MakeEnvelope(ll.west, ll.south, ll.east, ll.north, 4326)
        db = SessionLocal()
        try:
            names = [r[0] for r in db.query(Imagery.filename).filter(sqlfunc.ST_Intersects(Imagery.geom, sg)).all()]
        finally:
            db.close()
        if not names:
            return None
        png = _render_raster_tile([os.path.join(UPLOAD_FOLDER, n) for n in names], tb)
        if png is None:
            _tile_disk_put(z, x, y, _blank_rgba_png())   # пустой тайл — чтобы не дёргать БД повторно
            return None
        _tile_disk_put(z, x, y, png)
        _raster_lru_put(z, x, y, png)
        src_name = "rendered"
    data, media = _apply_tile_quality(png, tile_quality)
    return data, media, src_name

@app.get("/tiles/raster/{z}/{x}/{y}.png")
async def get_raster_tile(z: int, x: int, y: int, request: Request):
    # Качество из заголовка nginx (X-Tile-Quality: LOW | MED | HIGH); без nginx — по зуму
    tile_quality = (request.headers.get("X-Tile-Quality") or (
        "LOW" if z <= 9 else "MED" if z <= 13 else "HIGH")).upper()
    key = (z, x, y, tile_quality)
    hit = _raster_final_get(key)
    if hit is not None:
        return Response(hit[0], media_type=hit[1], headers={**_TILE_RESP_HEADERS, "X-Tile-Quality": tile_quality, "X-Tile-Source": "ram"})
    try:
        async with _raster_tile_semaphore:
            res = await run_in_threadpool(_raster_tile_sync, z, x, y, tile_quality)
    except Exception as e:
        logger.error(f"Tile error {z}/{x}/{y}: {e}")
        return _send_blank_tile()
    if res is None:
        return _send_blank_tile()
    data, media, src_name = res
    _raster_final_put(key, (data, media))
    return Response(data, media_type=media, headers={**_TILE_RESP_HEADERS, "X-Tile-Quality": tile_quality, "X-Tile-Source": src_name})


@app.post("/api/admin/reset-tile-cache")
async def reset_tile_cache(_=Depends(require_admin)):
    """Сбрасывает дисковый кэш растровых тайлов."""
    _invalidate_raster_tile_cache()
    return {"ok": True, "message": "Дисковый кэш тайлов сброшен"}


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/cache/purge  — единая инвалидация всех кэшей (для администратора)
#
# Сбрасывает:
#   1. Python in-memory LRU  (WMS-тайлы GeoServer)
#   2. Redis tile:* ключи    (если REDIS_URL настроен)
#   3. Дисковый кэш тайлов   (/cache/raster_tiles)
#   4. Nginx proxy_cache      (если установлен ngx_cache_purge и NGINX_PURGE_URL)
#   5. Границы лесхозов      (country-boundary + forestry-boundaries)
#
# Параметры (опциональные, JSON body):
#   zones: ["tiles", "wms", "meta", "all"]  — какие nginx-зоны чистить
#   nginx_purge: bool (default true)        — пытаться ли слать PURGE
#
# Переменные окружения:
#   NGINX_PURGE_URL = http://127.0.0.1:80   (host:port для PURGE-запросов)
#   NGINX_PURGE_PATH = /purge               (endpoint, если используется custom)
# ──────────────────────────────────────────────────────────────────────────────

_NGINX_PURGE_URL = os.getenv("NGINX_PURGE_URL", "")   # "" → nginx PURGE отключён

# Карта зон nginx → паттерны URL для purge
_NGINX_CACHE_ZONES: dict = {
    "tiles":     ["/tiles/raster/*"],
    "wms":       ["/wms*", "/geoserver_wms_proxy*"],
    "belgosles": ["/belgosles_wms_proxy*"],
    "meta":      ["/api/country-boundary", "/api/forestry-boundaries",
                  "/api/zones-boundaries", "/wms?*request=GetCapabilities*"],
    "dzz":       ["/dzz-wms-proxy*", "/geoserver_wms_proxy*"],
}


async def _purge_nginx_zone(zone: str, patterns: list) -> dict:
    """Шлёт PURGE-запросы nginx (требует ngx_cache_purge модуль)."""
    if not _NGINX_PURGE_URL:
        return {"skipped": True, "reason": "NGINX_PURGE_URL не задан"}

    import httpx
    results = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        for pattern in patterns:
            url = _NGINX_PURGE_URL.rstrip("/") + pattern
            try:
                r = await client.request("PURGE", url)
                results.append({"pattern": pattern, "status": r.status_code})
            except Exception as _e:
                results.append({"pattern": pattern, "error": str(_e)})
    return {"zone": zone, "results": results}


# ──────────────────────────────────────────────────────────────────────────────
# AUDIT LOG API
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/api/admin/audit-log")
def api_audit_log(
    request: Request,
    page:    int = Query(1,  ge=1),
    limit:   int = Query(50, ge=1, le=500),
    ip:      str = Query("", alias="ip"),
    action:  str = Query("", alias="action"),
    date_from: str = Query("", alias="date_from"),  # YYYY-MM-DD
    date_to:   str = Query("", alias="date_to"),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Журнал действий с фильтрацией.

    Query params (все опциональны):
      ip, action, date_from (YYYY-MM-DD), date_to (YYYY-MM-DD), page, limit
    """
    from sqlalchemy import desc as _desc
    q = db.query(PgAuditLog)
    if ip.strip():
        q = q.filter(PgAuditLog.ip.ilike(f"%{ip.strip()}%"))
    if action.strip():
        q = q.filter(PgAuditLog.action == action.strip())
    if date_from.strip():
        try:
            q = q.filter(PgAuditLog.ts >= datetime.strptime(date_from.strip(), "%Y-%m-%d"))
        except ValueError:
            pass
    if date_to.strip():
        try:
            q = q.filter(PgAuditLog.ts < datetime.strptime(date_to.strip(), "%Y-%m-%d") + timedelta(days=1))
        except ValueError:
            pass

    total = q.count()
    rows  = q.order_by(_desc(PgAuditLog.ts)).offset((page - 1) * limit).limit(limit).all()

    return {
        "total": total,
        "page":  page,
        "limit": limit,
        "items": [
            {
                "id":          r.id,
                "ip":          r.ip,
                "user_name":   r.user_name or r.ip,
                "action":      r.action,
                "resource":    r.resource,
                "detail":      r.detail,
                "status_code": r.status_code,
                "ts":          r.ts.strftime("%Y-%m-%d %H:%M:%S") if r.ts else "",
            }
            for r in rows
        ],
    }


@app.get("/api/admin/audit-log/export")
def api_audit_log_export(
    request: Request,
    ip:        str = Query("", alias="ip"),
    action:    str = Query("", alias="action"),
    date_from: str = Query("", alias="date_from"),
    date_to:   str = Query("", alias="date_to"),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Экспорт журнала в Excel (openpyxl). Применяются те же фильтры, что и у /api/admin/audit-log."""
    import io, openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    from sqlalchemy import desc as _desc

    q = db.query(PgAuditLog)
    if ip.strip():
        q = q.filter(PgAuditLog.ip.ilike(f"%{ip.strip()}%"))
    if action.strip():
        q = q.filter(PgAuditLog.action == action.strip())
    if date_from.strip():
        try:
            q = q.filter(PgAuditLog.ts >= datetime.strptime(date_from.strip(), "%Y-%m-%d"))
        except ValueError:
            pass
    if date_to.strip():
        try:
            q = q.filter(PgAuditLog.ts < datetime.strptime(date_to.strip(), "%Y-%m-%d") + timedelta(days=1))
        except ValueError:
            pass

    rows = q.order_by(_desc(PgAuditLog.ts)).limit(50_000).all()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Журнал действий"

    HEADERS = ["#", "Дата / Время", "IP", "Пользователь", "Действие", "Ресурс", "Детали", "Статус"]
    header_fill = PatternFill("solid", fgColor="1F4E79")
    header_font = Font(bold=True, color="FFFFFF", size=11)

    for col_idx, h in enumerate(HEADERS, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.fill   = header_fill
        cell.font   = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")

    ws.row_dimensions[1].height = 20

    # Чередование строк
    fill_even = PatternFill("solid", fgColor="EBF3FB")
    fill_odd  = PatternFill("solid", fgColor="FFFFFF")

    ACTION_RU = {
        "view_file":      "Просмотр файла",
        "download":       "Скачивание",
        "download_zip":   "Скачивание ZIP",
        "download_catalog": "Каталог (экспорт)",
        "download_cog":   "Скачивание COG",
        "upload":         "Загрузка снимка",
        "upload_vector":  "Загрузка вектора",
        "delete_imagery": "Удаление снимка",
        "delete_vector":  "Удаление вектора",
        "login":          "Вход",
        "logout":         "Выход",
        "admin_action":   "Действие админа",
        "cache_purge":    "Сброс кэша",
    }

    for row_idx, r in enumerate(rows, 2):
        fill = fill_even if row_idx % 2 == 0 else fill_odd
        values = [
            r.id,
            r.ts.strftime("%Y-%m-%d %H:%M:%S") if r.ts else "",
            r.ip,
            r.user_name or r.ip,
            ACTION_RU.get(r.action, r.action),
            r.resource,
            r.detail or "",
            r.status_code,
        ]
        for col_idx, v in enumerate(values, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=v)
            cell.fill = fill

    # Ширины колонок
    col_widths = [7, 20, 17, 24, 22, 45, 35, 8]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}1"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    fname = f"audit_log_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/cache/purge")
async def api_cache_purge(
    request: Request,
    _=Depends(require_admin),
):
    """
    Единая инвалидация всего кэша геопортала.

    Тело запроса (JSON, все поля опциональны):
      {
        "zones":       ["all"] | ["tiles","wms","meta","dzz","belgosles"],
        "nginx_purge": true,
        "reason":      "новый снимок загружен"
      }

    Возвращает подробный отчёт о каждом шаге.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    zones        = body.get("zones", ["all"])
    do_nginx     = body.get("nginx_purge", True)
    reason       = body.get("reason", "manual")
    started_at   = datetime.utcnow().isoformat() + "Z"

    report: dict = {
        "ok": True,
        "started_at": started_at,
        "reason": reason,
        "steps": {},
    }

    # ── Шаг 1: Python LRU + Redis ─────────────────────────────────────────
    flush_stats = _tile_cache_flush_all()
    report["steps"]["python_cache"] = {
        "lru_cleared":   flush_stats["lru"],
        "redis_cleared": flush_stats.get("redis", 0),
        "redis_ok":      flush_stats["redis_ok"],
    }
    logger.info(f"[cache/purge] LRU={flush_stats['lru']} Redis={flush_stats.get('redis',0)} reason={reason}")

    # ── Шаг 2: Дисковый кэш тайлов ───────────────────────────────────────
    try:
        before = sum(
            len(files) for _, _, files in os.walk(_TILE_DISK_CACHE)
        )
        _invalidate_raster_tile_cache()
        report["steps"]["disk_tile_cache"] = {"files_removed": before}
    except Exception as _e:
        report["steps"]["disk_tile_cache"] = {"error": str(_e)}

    # ── Шаг 3: Сброс in-memory границ / маски ─────────────────────────────
    global _cb_cache_body, _cb_cache_etag, _leshoz_gdf_cache
    try:
        with _cb_lock:
            _cb_cache_body = b""
            _cb_cache_etag = ""
        _leshoz_gdf_cache = None
        with _leshoz_geom_cache_lock:
            _leshoz_geom_cache.clear()
        with _leshoz_mask_cache_lock:
            _leshoz_mask_cache.clear()
        report["steps"]["boundary_cache"] = {"cleared": True}
    except Exception as _e:
        report["steps"]["boundary_cache"] = {"error": str(_e)}

    # ── Шаг 4: Nginx proxy_cache PURGE ────────────────────────────────────
    nginx_results = {}
    if do_nginx and _NGINX_PURGE_URL:
        # Определяем список зон для очистки
        if "all" in zones:
            purge_zones = list(_NGINX_CACHE_ZONES.items())
        else:
            purge_zones = [(z, _NGINX_CACHE_ZONES[z]) for z in zones
                           if z in _NGINX_CACHE_ZONES]

        for zone_name, patterns in purge_zones:
            nginx_results[zone_name] = await _purge_nginx_zone(zone_name, patterns)
    elif do_nginx:
        nginx_results["skipped"] = "NGINX_PURGE_URL не задан в .env"
    report["steps"]["nginx_purge"] = nginx_results

    # ── Шаг 5: Nginx кэш-папки (find + delete) для Windows и Linux ────────
    nginx_dirs_cleared = 0
    _nginx_cache_dirs = [
        "C:/nginx/cache/tiles",
        "C:/nginx/cache/dzz",
        "C:/nginx/cache/wms",
        "C:/nginx/cache/meta",
        "C:/nginx/cache/belgosles",
        "/var/cache/nginx",
        "/tmp/nginx_cache",
    ]
    for _nd in _nginx_cache_dirs:
        if "all" not in zones:
            # Фильтруем по имени папки
            zone_from_path = _nd.rstrip("/").split("/")[-1]
            if zone_from_path not in zones:
                continue
        if os.path.isdir(_nd):
            try:
                import subprocess
                subprocess.run(
                    ["find", _nd, "-type", "f", "-delete"],
                    capture_output=True, timeout=30
                )
                nginx_dirs_cleared += 1
                logger.info(f"[cache/purge] nginx disk cleared: {_nd}")
            except Exception as _ne:
                logger.warning(f"[cache/purge] nginx disk error {_nd}: {_ne}")
    report["steps"]["nginx_disk"] = {"dirs_cleared": nginx_dirs_cleared}

    report["finished_at"] = datetime.utcnow().isoformat() + "Z"
    logger.info(f"[cache/purge] завершено — {report['steps']}")
    return report

def _tile_to_bbox_wm(x,y,z):
    e=20037508.3427892; n=2**z; ts=2*e/n
    return f"{-e+x*ts},{e-(y+1)*ts},{-e+(x+1)*ts},{e-y*ts}"

def _empty_pixel():
    return Response(b'\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x01\x44\x00\x3b',media_type="image/gif")

# [PERF v9] Раньше КАЖДЫЙ тайл ДЗЗ ждал искусственные 20–80 мс (asyncio.sleep)
# и не кэшировался — при зуме это давало заметную задержку. Теперь: RAM/Redis-кэш,
# объединение одинаковых запросов, ограничение параллелизма к ArcGIS.
_DZZ_TILE_HEADERS = {"Cache-Control": "public, max-age=604800", "X-Accel-Expires": "604800", "Vary": ""}
_DZZ_EMPTY_HEADERS = {"Cache-Control": "no-store", "X-Accel-Expires": "0"}
_dzz_inflight: dict = {}
_dzz_sem = None


def _dzz_empty():
    r = _empty_pixel()
    r.headers.update(_DZZ_EMPTY_HEADERS)
    return r


@app.get("/tiles/dzz/{z}/{y}/{x}")
async def proxy_dzz_tile(request: Request, z: int, y: int, x: int):
    global _dzz_sem
    if not (0 <= z <= 22 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return _dzz_empty()
    key = f"dzz:{z}/{y}/{x}"
    hit = await _tile_cache_aget(key)
    if hit:
        return _tile_ok_response(request, hit[0], hit[1], _DZZ_TILE_HEADERS)
    fut = _dzz_inflight.get(key)
    if fut is not None:
        try:
            res = await _asyncio.wait_for(_asyncio.shield(fut), timeout=40)
        except Exception:
            res = None
        return _tile_ok_response(request, res, "image/jpeg", _DZZ_TILE_HEADERS) if res else _dzz_empty()
    if _dzz_sem is None:
        _dzz_sem = _asyncio.Semaphore(int(os.getenv("DZZ_TILE_CONCURRENCY", "12")))
    fut = _asyncio.get_running_loop().create_future()
    _dzz_inflight[key] = fut
    content = None
    try:
        bbox = _tile_to_bbox_wm(x, y, z)
        params = {
            'f': 'image', 'bbox': bbox, 'bboxSR': '3857', 'imageSR': '3857',
            'size': '256,256', 'format': 'jpg', 'compressionQuality': '75',
            'interpolation': 'RSP_NearestNeighbor',
        }

        def _fetch_dzz():
            return _http_session.get(f"{SERVICE_URL}/exportImage", params=params,
                                     auth=requests.auth.HTTPBasicAuth(LOGIN_DZZ, PASSWORD_DZZ),
                                     timeout=(5, 25))
        async with _dzz_sem:
            for attempt in range(3):
                try:
                    resp = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch_dzz)
                except Exception:
                    await _asyncio.sleep(0.3 * (attempt + 1))
                    continue
                if resp.status_code == 200:
                    head = resp.content[:100]
                    if b'Error' in head or b'html' in head or not resp.content:
                        break
                    content = resp.content
                    break
                if resp.status_code in (403, 429, 503):
                    await _asyncio.sleep(0.6 + random.uniform(0, 0.6) * (attempt + 1))
                    continue
                break
        if content:
            _tile_cache_put(key, (content, "image/jpeg"))
            return _tile_ok_response(request, content, "image/jpeg", _DZZ_TILE_HEADERS)
        return _dzz_empty()
    except Exception as e:
        logger.error(f"DZZ tile: {e}")
        return _dzz_empty()
    finally:
        _dzz_inflight.pop(key, None)
        if not fut.done():
            fut.set_result(content)

@app.get("/api/get_image_info")
def get_image_info(lat: float, lng: float, db: Session=Depends(get_db)):
    from sqlalchemy import func as sqlfunc
    pt = sqlfunc.ST_SetSRID(sqlfunc.ST_MakePoint(lng,lat),4326)
    img = db.query(Imagery).filter(sqlfunc.ST_Intersects(Imagery.geom,pt)).order_by(Imagery.date_shot.desc()).first()
    return {"found":True,"data":img.to_dict()} if img else {"found":False}

@app.get("/api/geoserver_layers")
async def get_geoserver_layers(): return GEOSERVER_LAYERS_CONFIG

@app.get("/geoserver_pbf_proxy")
async def geoserver_pbf_proxy(request: Request, layer: str, z: int, x: int, y: int):
    if not (0 <= z <= 22 and 0 <= x < (1 << z) and 0 <= y < (1 << z)) or len(layer) > 200:
        return Response(status_code=400)
    key = f"pbf:{layer}:{z}/{x}/{y}"
    hit = await _tile_cache_aget(key)
    if hit:
        return _tile_ok_response(request, hit[0], hit[1], _TILE_RESPONSE_HEADERS)
    try:
        bounds = mercantile.xy_bounds(x, y, z)
        bbox_str = f"{bounds.left},{bounds.bottom},{bounds.right},{bounds.top}"
        params = {'service': 'WMS', 'version': '1.1.0', 'request': 'GetMap', 'layers': layer, 'bbox': bbox_str,
                  'width': '256', 'height': '256', 'srs': 'EPSG:3857',
                  'format': 'application/x-protobuf;type=mapbox-vector'}

        def _fetch_pbf():
            r = _tile_session.get(GEOSERVER_WMS_URL, params=params, timeout=(5, 40))
            return r.status_code, r.content
        status_code, content = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch_pbf)
        if status_code != 200:
            return Response("GeoServer Error", status_code=502 if status_code >= 500 else status_code)
        _tile_cache_put(key, (content, "application/x-protobuf"))
        return _tile_ok_response(request, content, "application/x-protobuf", _TILE_RESPONSE_HEADERS)
    except requests.exceptions.Timeout:
        return Response("Timeout", status_code=504)
    except Exception as e:
        logger.warning(f"pbf_proxy: {e}")
        return Response("Ошибка геосервиса", status_code=502)


# [PERF v9] Схемы слоёв (DescribeFeatureType) и одинаковые поисковые запросы
# кэшируются в памяти: поиск по всем слоям больше не бьёт по GeoServer заново.
_wfs_resp_cache = _gg.TTLCache(maxsize=1500, ttl=float(os.getenv("WFS_CACHE_TTL", "120")))
_wfs_schema_cache = _gg.TTLCache(maxsize=500, ttl=600.0)


@app.get("/geoserver_wfs_proxy")
async def geoserver_wfs_proxy(request: Request):
    params = {k.lower(): v for k, v in request.query_params.items() if not k.startswith("_")}
    req_type = params.get('request', '').upper()
    if req_type == 'DESCRIBEFEATURETYPE':
        params.setdefault('service', 'WFS')
        params.setdefault('version', '1.1.0')
    else:
        params.update({
            'service': 'WFS',
            'version': params.get('version', '1.1.0'),
            'request': 'GetFeature',
            'outputformat': 'application/json',
            'srsname': 'EPSG:4326'
        })
    ckey = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    cache = _wfs_schema_cache if req_type == 'DESCRIBEFEATURETYPE' else _wfs_resp_cache
    hit = cache.get(ckey)
    if hit:
        return Response(hit[0], media_type=hit[1])
    try:
        def _fetch_wfs():
            r = _tile_session.get(GEOSERVER_WFS_URL, params=params, timeout=(5, 30))
            return r.status_code, r.headers.get('Content-Type', 'application/json'), r.content
        status_code, ct, content = await _asyncio.get_running_loop().run_in_executor(_tile_executor, _fetch_wfs)
    except Exception as e:
        logger.warning(f"geoserver_wfs_proxy: {e}")
        return JSONResponse({"type": "FeatureCollection", "features": [], "error": "Геосервис недоступен"}, status_code=502)
    if status_code != 200:
        return Response(f"GeoServer Error: {status_code}", status_code=502 if status_code >= 500 else status_code)
    media = 'application/xml' if ('xml' in ct or req_type == 'DESCRIBEFEATURETYPE') else 'application/json'
    if b'ExceptionReport' not in content[:400] and b'ServiceException' not in content[:400]:
        cache.put(ckey, (content, media))
    return Response(content, media_type=media)

@app.get("/api/proxy-tile")
async def api_proxy_tile(url: str=Query(...)):
    url=unquote(url)
    # [SEC v16] Белый список хостов был, но: редиректы шли куда угодно (SSRF во
    # внутреннюю сеть), любые порты/пути (REST/админка GeoServer), ответ любого
    # типа (text/html → XSS в нашем origin) и «Access-Control-Allow-Origin: *»
    # превращал сервер в открытый CORS-прокси к внутренним данным.
    _ok, _why = _sh.check_proxy_url(url, _TILE_PROXY_ALLOWED_HOSTS)
    if not _ok: raise HTTPException(400 if 'HTTP' in _why or 'URL' in _why else 403, f"URL не разрешён: {_why}")
    try:
        def _fetch():
            r=_http_session.get(url,timeout=(5,20),headers={'User-Agent':'GeoPortal/2.0'},
                                allow_redirects=False, stream=True)
            try:
                if r.is_redirect: return b"", 502, "application/octet-stream"
                ct=_sh.safe_proxy_media_type(r.headers.get('Content-Type','image/png'))
                return _sh.read_limited(r, 16 * 1024 * 1024), r.status_code, ct
            finally:
                r.close()
        content, sc, ct = await run_in_threadpool(_fetch)
        return Response(content,status_code=sc,media_type=ct,
                        headers={"Cache-Control":"public,max-age=86400","X-Content-Type-Options":"nosniff"})
    except requests.exceptions.Timeout: raise HTTPException(504,"Таймаут тайл-сервера")
    except Exception as e:
        logger.warning(f"proxy-tile: {e}")
        raise HTTPException(502,"Тайл-сервер недоступен")

@app.api_route("/geoserver-proxy/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH"])
async def geoserver_web_proxy(path: str, request: Request, _admin=Depends(require_admin)):
    # [SEC v9] Раньше веб-админка GeoServer (с логином admin) была открыта ВСЕМ:
    # любой мог менять/удалять слои и выгружать данные. Теперь — только администратор
    # портала, а изменяющие запросы — только со страниц самого портала.
    if request.method not in ("GET", "HEAD"):
        _org = (request.headers.get("origin") or "").rstrip("/")
        _host = request.headers.get("host", "")
        if _org and _org.split("://", 1)[-1] != _host:
            raise HTTPException(403, "Запрос с чужого сайта")
    target=_GS_BASE+'/'+path
    qs=str(request.url.query)
    if qs: target+='?'+qs
    fwd={k:v for k,v in request.headers.items() if k.lower() not in ('host','content-length','transfer-encoding','connection','cookie','authorization')}
    body=await request.body()
    try: gs_resp=_gs_session.request(request.method,target,headers=fwd,data=body,allow_redirects=False,timeout=30)
    except Exception as e:
        logger.warning(f"geoserver-proxy: {e}")
        raise HTTPException(502,"GeoServer недоступен")
    if gs_resp.status_code in (301,302,303,307,308):
        loc=gs_resp.headers.get('Location','').replace(_GS_BASE,_GS_PREFIX)
        return Response(status_code=gs_resp.status_code,headers={"Location":loc})
    skip={'content-encoding','content-length','transfer-encoding','connection','keep-alive','set-cookie','x-frame-options','content-security-policy'}
    out_h={k:v for k,v in gs_resp.headers.items() if k.lower() not in skip}
    ct=gs_resp.headers.get('Content-Type','')
    body_out=gs_resp.content
    if any(t in ct for t in ('text/','javascript','json','xml')):
        body_out=body_out.decode('utf-8','replace').replace(_GS_BASE,_GS_PREFIX).encode()
    return Response(body_out,status_code=gs_resp.status_code,headers=out_h,media_type=ct)

@app.get("/api/download_cog")
async def api_download_cog(request: Request, layer: str=Query(...), _=Depends(require_admin)):
    """Прямое скачивание COG-файла администратором (без токена)."""
    file_path, display_filename = _resolve_cog_path(layer)
    if not file_path:
        raise HTTPException(404, f"Файл для слоя '{layer}' не найден")
    filename = display_filename or os.path.basename(file_path)
    logger.info(f"[download_cog] {filename} ({os.path.getsize(file_path)//1024//1024} МБ)")
    return _stream_file_response(file_path, filename, request)

@app.get("/api/dzz/download")
async def api_dzz_download(request: Request, layer: str = Query(...),
                            token: Optional[str] = Query(None),
                            db: Session = Depends(get_db)):
    ip = get_real_ip(request)
    user_id = get_current_user(request)
    access_token = token or request.headers.get('X-Access-Token', '')

    # Авторизация: сессия администратора или токен доступа
    if not user_id:
        if not access_token:
            return JSONResponse({"error": "Введите токен доступа"}, status_code=403)
        val = token_validate(access_token, file_path=layer)
        if not val['ok']:
            return JSONResponse({"error": val['reason']}, status_code=403)

    # Поиск файла
    file_path, display_filename = _resolve_cog_path(layer)
    if not file_path:
        logger.warning(f"[api_dzz_download] 404 layer='{layer}' ip={ip} DDZ_ROOT={_DDZ_DATA_ROOT}")
        return JSONResponse(
            # [SEC v16] путь к архиву ДЗЗ на сервере больше не раскрывается клиенту
            {"error": "Файл для этого слоя не найден на сервере. Обратитесь к администратору."},
            status_code=404,
        )

    if not os.path.isfile(file_path):
        logger.error(f"[api_dzz_download] файл исчез после resolve: {file_path}")
        return JSONResponse({"error": "Файл недоступен на сервере"}, status_code=404)

    filename = display_filename or os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    logger.info(f"[api_dzz_download] отдаём '{filename}' ({file_size // 1024 // 1024} МБ) → {ip}")

    # Стриминг с поддержкой Range — работает для файлов любого размера
    return _stream_file_response(file_path, filename, request)

@app.post("/api/download_token")
async def api_download_token(request: Request):
    """Выдаёт одноразовый токен скачивания. Доступно авторизованным пользователям."""
    _dl_cleanup2()
    user_id = get_current_user(request)
    if not user_id:
        raise HTTPException(403, "Требуется авторизация")

    data = await request.json()
    file_path = data.get("file_path", "").strip()
    label = data.get("label", file_path)
    if not file_path:
        raise HTTPException(400, "Не указан file_path")

    abs_path, filename = _dl_resolve_file(file_path)
    if not abs_path:
        logger.warning(f"[download_token] файл не найден: '{file_path}'")
        raise HTTPException(404, f"Файл не найден на сервере: {label}")

    token = str(_uuid_mod.uuid4())
    with _dl_lock2:
        _dl_tokens2[token] = {
            "path": abs_path, "filename": filename,
            "label": label, "expires": time.time() + _DL_TTL2, "used": False,
        }
    logger.info(f"[download_token] {token[:8]}… => {filename}")
    return {"token": token}

@app.get("/api/download_file")
async def api_download_file_v2(request: Request, token: str = Query(...)):
    _dl_cleanup2()
    with _dl_lock2:
        entry = _dl_tokens2.get(token)
        if not entry:
            raise HTTPException(404, "Токен не найден")
        if entry["used"]:
            raise HTTPException(410, "Токен уже использован")
        if entry["expires"] < time.time():
            del _dl_tokens2[token]
            raise HTTPException(410, "Токен просрочен")
        entry["used"] = True

    abs_path = entry["path"]
    filename = entry["filename"]

    if not os.path.isfile(abs_path):
        logger.error(f"[download_file] файл пропал: {abs_path}")
        raise HTTPException(404, "Файл не найден на сервере")

    file_size = os.path.getsize(abs_path)
    logger.info(f"[download_file] отдаём '{filename}' ({file_size // 1024 // 1024} МБ)")

    # Стриминг с поддержкой Range — работает для файлов любого размера
    return _stream_file_response(abs_path, filename, request)

# ── USERS ──────────────────────────────────────────────────
@app.get("/api/users/me")
async def api_user_me(request: Request):
    ip      = get_real_ip(request)
    device_id = get_device_id(request)
    user_id = get_current_user(request)
    info    = get_user_info_by_ip(ip, device_id) or {"ip": ip, "user_name": "", "org_name": "", "status": "new"}
    name    = (info.get("user_name") or "").strip()
    org     = (info.get("organization_name") or info.get("org_name") or "").strip()
    info["has_profile"]   = bool(user_id or name or org)
    info["is_admin"]      = bool(user_id)
    info["display_name"]  = "Admin" if user_id else (name or org or "")
    return info

# Endpoint для фронтенда — авто-определение профиля по IP
# Фронтенд вызывает /poi/avatar/me для получения данных текущего пользователя
@app.get("/poi/avatar/me")
async def poi_avatar_me(request: Request):
    ip      = get_real_ip(request)
    device_id = get_device_id(request)
    user_id = get_current_user(request)

    if not user_id and ip == ADMIN_IP and not request.session.get("adm2_skip"):
        request.session["user_id"] = ADMIN_USER["id"]   # опознан по IP; права — после доп. пароля
        user_id = get_current_user(request)

    if user_id:
        return {"ip": ip, "user_name": "Admin", "organization_name": "",
                "has_profile": True, "is_admin": True, "status": "active"}
    info = await run_in_threadpool(get_user_by_ip, ip, device_id)
    if info and info.get('status') not in ('deleted', 'frozen', 'banned'):
        name = (info.get("user_name") or "").strip()
        org  = (info.get("organization_name") or "").strip()
        has  = bool(name or org)
        info["has_profile"]  = has
        info["is_admin"]     = False
        info["display_name"] = name or org or ""
        return info
    return {"ip": ip, "user_name": "", "organization_name": "",
            "has_profile": False, "is_admin": False, "status": "new"}

@app.get("/api/users/all")
async def api_users_all(_=Depends(require_admin)): return get_all_users_admin()

@app.post("/api/users/update/{uid}")
async def api_users_update(uid: int, request: Request, _=Depends(require_admin)):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == uid).first()
        if u and u.ip in PROTECTED_IPS:
            raise HTTPException(403, "Нельзя редактировать защищённого пользователя")
    finally:
        db.close()
    data = await request.json()
    update_user_data(uid, data.get("user_name",""), data.get("org_name",""))
    return {"ok": True}

@app.get("/api/users/history")
async def api_users_history(_=Depends(require_admin)): return get_login_history(5000)

@app.post("/api/admin/history/cleanup")
def api_history_cleanup(_=Depends(require_admin)):
    """Оставить только последние 2000 записей истории подключений."""
    db = _pg()
    try:
        from sqlalchemy import text as sqlt
        # Находим id 2000-й записи с конца
        result = db.execute(sqlt("""
            DELETE FROM pg_login_history
            WHERE id NOT IN (
                SELECT id FROM pg_login_history ORDER BY id DESC LIMIT 2000
            )
        """))
        deleted = result.rowcount
        db.commit()
        return {"ok": True, "deleted": deleted}
    except Exception as e:
        db.rollback()
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        db.close()

@app.post("/api/users/freeze/{uid}")
def api_users_freeze(uid: int, _=Depends(require_admin)):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == uid).first()
        if u and u.ip in PROTECTED_IPS:
            raise HTTPException(403, "Нельзя заморозить защищённого")
    finally:
        db.close()
    set_status(uid, "frozen"); return {"ok": True}

@app.post("/api/users/unfreeze/{uid}")
async def api_users_unfreeze(uid: int, _=Depends(require_admin)):
    set_status(uid, "active"); return {"ok": True}

@app.post("/api/users/delete/{uid}")
def api_users_delete(uid: int, _=Depends(require_admin)):
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.id == uid).first()
        if u and u.ip in PROTECTED_IPS:
            raise HTTPException(403, "Нельзя удалить защищённого")
    finally:
        db.close()
    set_status(uid, "banned"); return {"ok": True}

@app.get("/api/users/pending")
async def api_users_pending(_=Depends(require_admin)): return get_pending_requests()

@app.post("/api/users/approve/{req_id}")
async def api_users_approve(req_id: int, _=Depends(require_admin)):
    approve_request(req_id); return {"ok":True}

@app.post("/api/users/reject/{req_id}")
async def api_users_reject(req_id: int, _=Depends(require_admin)):
    reject_request(req_id); return {"ok":True}

@app.post("/api/users/submit_form")
async def api_submit_user_form(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); data=await request.json()
    req_user=data.get("user_name","").strip(); req_org=data.get("org_name","").strip()
    if not req_user or not req_org: raise HTTPException(400,"Заполните все поля")
    uid,_=get_status_by_ip(ip, device_id)
    if uid is None: uid,_=register_visit(ip, device_id)
    if uid is None:
        raise HTTPException(403, "Регистрация доступна только с рабочих мест сети " + _TRACKED_IP_PREFIX + "x")
    add_pending_request(uid,req_user,req_org)
    return {"ok":True,"message":"Заявка отправлена. Ожидайте подтверждения администратора."}

@app.get("/api/users/can_download")
async def api_can_download(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request)
    info=get_user_info_by_ip(ip, device_id)
    return {"can_download":bool(info and info.get("user_name") and info.get("org_name"))}

@app.get("/api/users/online")
def api_users_online(request: Request):
    # [v18] только для зарегистрированных (раньше «последний визит» любого IP был
    # доступен без входа) и с учётом приватности профиля: «невидимка» / скрытый
    # статус «в сети» / скрытое время визита. Плюс эмодзи и текст статуса.
    viewer = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(viewer, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    ips = [i.strip() for i in request.query_params.getlist('ip') if i and len(i) <= 45][:200]
    if not ips: return {"ok": True, "users": {}}
    threshold = (datetime.now() - timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M:%S')
    db = _pg(); result = {}
    try:
        for ip in ips:
            pub = _profile_public(_profile_load(db, ip))
            priv = pub["privacy"]
            if ip == ADMIN_IP:
                info = {"last_seen": "", "online": True}
            else:
                u = db.query(PgUser).filter(PgUser.ip == ip).first()
                if u and u.last_seen:
                    info = {"last_seen": u.last_seen, "online": u.last_seen >= threshold}
                else:
                    info = {"last_seen": "", "online": False}
            if ip != viewer:
                if pub["my_status"] == "invisible" or not priv["show_online"]:
                    info = {"last_seen": "", "online": False, "hidden": True}
                elif not priv["show_last_seen"]:
                    info["last_seen"] = ""
            info["presence"] = pub["my_status"] if info.get("online") else ("hidden" if info.get("hidden") else "offline")
            info["status_emoji"] = pub["status_emoji"]
            info["status_text"] = pub["status_text"]
            result[ip] = info
    finally:
        db.close()
    return {"ok": True, "users": result}

# ── SESSION ────────────────────────────────────────────────
@app.post("/api/session/submit_profile")
async def api_session_submit_profile(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); data=await request.json()
    req_user=data.get("user_name","").strip(); req_org=data.get("organization_name","").strip()
    if not req_user or not req_org: raise HTTPException(400,"Заполните все поля")
    uid,_=get_status_by_ip(ip, device_id)
    if uid is None: uid,_=register_visit(ip, device_id)
    if uid is None:
        raise HTTPException(403, "Регистрация доступна только с рабочих мест сети " + _TRACKED_IP_PREFIX + "x")
    add_pending_request(uid,req_user,req_org)
    return {"ok":True,"message":"Заявка отправлена. Ожидайте подтверждения."}

@app.get("/api/session/check")
async def api_session_check(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request)
    _,status=get_status_by_ip(ip, device_id); return {"status":status or "active"}

@app.get("/api/session/me")
async def api_session_me(request: Request):
    """Возвращает единый профиль текущего IP независимо от браузера (для авто-входа на фронтенде)."""
    ip      = get_real_ip(request)
    device_id = get_device_id(request)
    user_id = get_current_user(request)

    # Авто-определение ADMIN_IP
    if not user_id and ip == ADMIN_IP and not request.session.get("adm2_skip"):
        request.session["user_id"] = ADMIN_USER["id"]   # опознан по IP; права — после доп. пароля
        user_id = get_current_user(request)

    if user_id:
        return {"ip": ip, "user_name": "Admin", "organization_name": "",
                "has_profile": True, "is_admin": True, "status": "active",
                "display_name": "Admin"}
    info = await run_in_threadpool(get_user_by_ip, ip, device_id)
    if info and info.get('status') not in ('deleted', 'frozen', 'banned'):
        name = (info.get("user_name") or "").strip()
        org  = (info.get("organization_name") or "").strip()
        has  = bool(name or org)
        return {**info,
                "has_profile":  has,
                "is_admin":     False,
                "display_name": name or org or ""}
    return {"ip": ip, "user_name": "", "organization_name": "",
            "has_profile": False, "is_admin": False, "status": "new", "display_name": ""}

# ── ОБЪЕДИНЁННЫЙ INIT-ЭНДПОИНТ ─────────────────────────────
# [PERF] Заменяет цепочку session/register → session/me + inbox_count + avatar/me
# (3 последовательных запроса ~1944ms) одним запросом ~300ms.
# Фронтенд вызывает /api/session/init вместо трёх отдельных.
@app.post("/api/session/init")
async def api_session_init(request: Request):
    """Объединённый старт сессии: register + me + inbox_count + avatar за один запрос."""
    ip      = get_real_ip(request)
    device_id = get_device_id(request)
    user_id = get_current_user(request)

    # Авто-определение ADMIN_IP
    if not user_id and ip == ADMIN_IP and not request.session.get("adm2_skip"):
        request.session["user_id"] = ADMIN_USER["id"]   # опознан по IP; права — после доп. пароля
        user_id = get_current_user(request)

    # Все браузеры с одним доверенным IP используют одну запись профиля.
    if not user_id:
        await run_in_threadpool(register_visit, ip, device_id)

    # Параллельно получаем профиль и inbox_count из БД
    async def _get_profile():
        if user_id:
            return {"ip": ip, "user_name": "Admin", "organization_name": "",
                    "has_profile": True, "is_admin": True, "status": "active",
                    "display_name": "Admin", "photo_url": ""}
        info = await run_in_threadpool(get_user_by_ip, ip, device_id)
        if info and info.get('status') not in ('deleted', 'frozen', 'banned'):
            name = (info.get("user_name") or "").strip()
            org  = (info.get("organization_name") or "").strip()
            has  = bool(name or org)
            # Получаем фото из того же объекта
            photo = (info.get("photo_url") or "").strip()
            return {**info, "has_profile": has, "is_admin": False,
                    "display_name": name or org or "", "photo_url": photo}
        return {"ip": ip, "user_name": "", "organization_name": "",
                "has_profile": False, "is_admin": False, "status": "new",
                "display_name": "", "photo_url": ""}

    async def _get_inbox():
        # [FIX] И сама _is_registered_or_admin() внутри может делать синхронный
        # db.query() (когда IP не админский и не в fast-path) — заворачиваем
        # ВЕСЬ блок целиком в один поход в threadpool, а не только db.query.count().
        def _inbox_sync():
            if not _is_registered_or_admin(ip, user_id, device_id):
                return 0
            db = _pg()
            try:
                return db.query(PgMessage).filter(
                    PgMessage.to_ip == ip, PgMessage.is_read == 0).count()
            finally:
                db.close()
        return await run_in_threadpool(_inbox_sync)

    # Запускаем параллельно
    profile, inbox_cnt = await _asyncio.gather(_get_profile(), _get_inbox())

    return {
        "ok":           True,
        "user_id":      user_id,
        "ip":           ip,
        "me":           profile,
        "inbox_count":  inbox_cnt,
    }

# ── MESSAGES ───────────────────────────────────────────────
@app.get("/api/messages/inbox_count")
async def api_messages_inbox_count(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    # [FIX] _is_registered_or_admin() тоже может делать синхронный db.query()
    # внутри — весь блок (проверка + подсчёт) уходит в один поход в threadpool,
    # чтобы ни один синхронный вызов к Postgres не блокировал event loop.
    # Этот эндпоинт опрашивается очень часто (видно по логам — почти на
    # каждое действие), поэтому даже небольшая блокировка event loop здесь
    # ощутимо тормозит вообще все остальные запросы сервера, включая
    # проксирование тайлов ДЗЗ — именно это и ловил Lighthouse как 1.4-3.5с
    # задержки в цепочке критических запросов при загрузке страницы.
    def _inbox_sync():
        if not _is_registered_or_admin(ip,user_id,device_id): return None
        db=_pg()
        try:
            return db.query(PgMessage).filter(PgMessage.to_ip==ip, PgMessage.is_read==0).count()
        finally: db.close()
    cnt = await run_in_threadpool(_inbox_sync)
    if cnt is None: return {"count":0,"registered":False}
    return {"count":cnt,"registered":True}

@app.post("/api/messages/send")
async def api_messages_send(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not await run_in_threadpool(_is_registered_or_admin, ip, user_id, device_id): raise HTTPException(403,"Нет доступа")
    data=await request.json(); to_ip=data.get('to_ip','').strip(); body=data.get('body','').strip()
    if not to_ip or not body: raise HTTPException(400,"Пустое сообщение или получатель")
    if len(body)>2000: raise HTTPException(400,"Слишком длинное сообщение")
    now=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db=_pg()
    try:
        db.add(PgMessage(from_ip=ip,to_ip=to_ip,body=body,sent_at=now,is_read=0))
        db.commit(); return {"ok":True}
    except: db.rollback(); raise
    finally: db.close()

@app.get("/api/messages/list")
def api_messages_list(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not _is_registered_or_admin(ip,user_id,device_id): raise HTTPException(403,"Нет доступа")
    db=_pg()
    try:
        from sqlalchemy import or_, case, distinct, func as _func
        peers_q = db.query(
            distinct(case((PgMessage.from_ip==ip, PgMessage.to_ip), else_=PgMessage.from_ip)).label('peer')
        ).filter(or_(PgMessage.from_ip==ip, PgMessage.to_ip==ip)).all()
        peers = [r.peer for r in peers_q]
        dialogs=[]
        for peer in peers:
            pname=_display_name(peer)
            porg=_get_user_org(peer)
            last=db.query(PgMessage).filter(
                or_(
                    (PgMessage.from_ip==ip) & (PgMessage.to_ip==peer),
                    (PgMessage.from_ip==peer) & (PgMessage.to_ip==ip)
                )
            ).order_by(PgMessage.id.desc()).first()
            unread=db.query(PgMessage).filter(
                PgMessage.from_ip==peer, PgMessage.to_ip==ip, PgMessage.is_read==0
            ).count()
            dialogs.append({"peer_ip":peer,"peer_name":pname,"peer_org":porg,
                            "last_msg":last.body[:60] if last else '',
                            "last_at":last.sent_at if last else '',"unread":unread})
        dialogs.sort(key=lambda d: d['last_at'],reverse=True)
        return {"ok":True,"dialogs":dialogs,"my_ip":ip}
    finally: db.close()

@app.get("/api/messages/thread")
def api_messages_thread(request: Request, peer: str=Query(...)):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not _is_registered_or_admin(ip,user_id,device_id): raise HTTPException(403,"Нет доступа")
    db=_pg()
    try:
        from sqlalchemy import or_
        db.query(PgMessage).filter(
            PgMessage.from_ip==peer, PgMessage.to_ip==ip, PgMessage.is_read==0
        ).update({PgMessage.is_read: 1}); db.commit()
        rows=db.query(PgMessage).filter(
            or_(
                (PgMessage.from_ip==ip) & (PgMessage.to_ip==peer),
                (PgMessage.from_ip==peer) & (PgMessage.to_ip==ip)
            )
        ).order_by(PgMessage.id.asc()).all()
        pname=_display_name(peer)
        msgs=[{"id":r.id,"from_ip":r.from_ip,"body":r.body,"sent_at":r.sent_at,
               "from_me":r.from_ip==ip,"from_name":_display_name(r.from_ip)} for r in rows]
        return {"ok":True,"messages":msgs,"my_ip":ip,"peer_name":pname,"peer_ip":peer}
    finally: db.close()

@app.get("/api/messages/users_list")
def api_messages_users_list(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not _is_registered_or_admin(ip,user_id,device_id): raise HTTPException(403,"Нет доступа")
    db=_pg()
    try:
        rows=db.query(PgUser).filter(
            PgUser.status=='active', PgUser.user_name!='', PgUser.ip!=ip
        ).order_by(PgUser.user_name.asc()).all()
        users=[]
        for r in rows:
            un=decrypt(r.user_name or '').strip(); og=decrypt(r.organization_name or '').strip()
            if un: users.append({'ip':r.ip,'name':un,'org':og})
        if not user_id and ip!=ADMIN_IP:
            users.insert(0,{'ip':ADMIN_IP,'name':'Администратор','org':'ADMIN'})
        return {"ok":True,"users":users}
    finally: db.close()

# ==========================================
# ОЧЕРЕДЬ ПЕЧАТИ — ТАКСАТОРЫ
# ==========================================

_PQ_STATUS_LABELS = {'not_ready': 'Не готов', 'ready': 'Готов', 'delayed': 'Задерживается'}
_PQ_VALID_STATUSES = set(_PQ_STATUS_LABELS.keys())


def _pq_entry_to_dict(r: "PgPrintQueueEntry") -> dict:
    return {
        "id": r.id, "pos": r.pos, "taxator": r.taxator, "leshoz": r.leshoz,
        "lesnichestvo": r.lesnichestvo or '', "expedition": r.expedition or '',
        "kvartal": r.kvartal or '', "vydel": r.vydel or '', "sheets": r.sheets or 1,
        "time": r.time_label or '', "priority": r.priority or 'normal',
        "status": r.status or 'not_ready',
        "status_label": _PQ_STATUS_LABELS.get(r.status or 'not_ready', r.status),
        "status_changed_by": r.status_changed_by or '',
        "status_changed_at": r.status_changed_at or '',
        "ecp_user": r.ecp_user or '', "ecp_time": r.ecp_time or '',
        "ecp_sig_data": r.ecp_sig_data or '',
        "created_at": r.created_at or '',
        "edited_by": getattr(r, 'edited_by', '') or '',
        "edited_at": getattr(r, 'edited_at', '') or '',
    }


# Поля, которые можно редактировать через вкладку «Просмотр Excel».
# «status» и «priority» — отдельные списки допустимых значений;
# остальные — свободный текст (или число для sheets).
_PQ_EDITABLE_TEXT_FIELDS = {'taxator', 'leshoz', 'lesnichestvo', 'expedition', 'kvartal', 'vydel', 'time'}
_PQ_VALID_PRIORITIES = {'normal', 'high', 'urgent'}


def _pq_touch(who: str, action: str) -> None:
    """[v18] «Последнее обновление» очереди: кто, когда и что изменил.
    Пишется отдельной короткой транзакцией ПОСЛЕ основной — сбой этой
    отметки никогда не отменяет само действие с очередью."""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db = _pg()
    try:
        m = db.query(PgPrintQueueMeta).filter(PgPrintQueueMeta.id == 1).first()
        if not m:
            m = PgPrintQueueMeta(id=1)
            db.add(m)
        m.updated_at = now
        m.updated_by = (who or '')[:255]
        m.action = (action or '')[:255]
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning(f"print_queue meta: {e}")
    finally:
        db.close()


def _pq_meta(db) -> dict:
    """Последнее изменение очереди. До первой правки в v18 (или если строки
    meta нет) — самое позднее время из записей (создание/статус/правка)."""
    try:
        m = db.query(PgPrintQueueMeta).filter(PgPrintQueueMeta.id == 1).first()
    except Exception:
        m = None
    if m and m.updated_at:
        return {"updated_at": m.updated_at, "updated_by": m.updated_by or '', "action": m.action or ''}
    best, who, action = '', '', ''
    rows = db.query(PgPrintQueueEntry.created_at, PgPrintQueueEntry.status_changed_at,
                    PgPrintQueueEntry.status_changed_by, PgPrintQueueEntry.edited_at,
                    PgPrintQueueEntry.edited_by).all()
    for created_at, st_at, st_by, ed_at, ed_by in rows:
        for t, w, a in ((created_at, '', 'Добавлена запись'), (st_at, st_by, 'Статус изменён'),
                        (ed_at, ed_by, 'Запись изменена')):
            if t and t > best:
                best, who, action = t, (w or ''), a
    return {"updated_at": best, "updated_by": who, "action": action}


# [v18] ЭЦП: черновик → утверждение.
#  • «Сохранить черновик» — сколько угодно раз, действующую подпись не меняет;
#  • «Утвердить» — черновик становится действующей ЭЦП и блокируется на
#    ECP_LOCK_MONTHS (по умолчанию 6) календарных месяцев с даты утверждения;
#  • пока подпись заблокирована, ни черновик, ни замена недоступны;
#  • досрочно снять блокировку может администратор (/api/ecp/unlock).
# Старые подписи (до v18) считаются утверждёнными и сохраняют свой срок.
_ECP_LOCK_MONTHS = max(1, min(36, int(os.getenv('ECP_LOCK_MONTHS', '6') or 6)))


def _ecp_add_months(dt: datetime, months: int) -> datetime:
    import calendar as _calendar
    m0 = dt.month - 1 + months
    y, m = dt.year + m0 // 12, m0 % 12 + 1
    return dt.replace(year=y, month=m, day=min(dt.day, _calendar.monthrange(y, m)[1]))


def _ecp_fmt(v: str) -> str:
    try:
        return datetime.strptime((v or '')[:19], '%Y-%m-%d %H:%M:%S').strftime('%d.%m.%Y')
    except ValueError:
        return v or ''


def _ecp_state(rec, include_draft: bool) -> dict:
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    approved = bool(rec and rec.sig_data)
    locked = bool(approved and rec.locked_until and rec.locked_until > now)
    days_left = 0
    if locked:
        try:
            days_left = max(0, (datetime.strptime(rec.locked_until[:19], '%Y-%m-%d %H:%M:%S') - datetime.now()).days + 1)
        except ValueError:
            days_left = 0
    has_draft = bool(rec and getattr(rec, 'draft_data', ''))
    st = {
        "ok": True,
        "signed": approved,                       # совместимость: «есть действующая ЭЦП»
        "status": "approved" if approved else ("draft" if has_draft else "none"),
        "sig_data": (rec.sig_data or '') if approved else '',
        "signed_at": (rec.signed_at or '') if approved else '',
        "approved_at": (rec.signed_at or '') if approved else '',
        "approved_by": (getattr(rec, 'approved_by', '') or '') if approved else '',
        "locked_until": (rec.locked_until or '') if approved else '',
        "locked": locked,
        "lock_days_left": days_left,
        "lock_months": _ECP_LOCK_MONTHS,
        "has_draft": has_draft,
        "draft": None,
    }
    if include_draft and has_draft:
        st["draft"] = {"sig_data": rec.draft_data, "saved_at": rec.draft_at or ''}
    return st


def _ecp_resolve_name(request: Request, requested: str):
    """Рядовой пользователь работает только со своей ЭЦП (имя — из сессии);
    админ/ОДЗиМЛ/пользователи с правом очереди — с ЭЦП указанного таксатора."""
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _is_registered_or_admin(ip, user_id, device_id):
        raise HTTPException(403, "Нет доступа")
    verify_csrf(request)
    own = _display_name(ip, device_id)
    name = (requested or '').strip()
    manager = _can_manage_print_queue(ip, user_id, device_id)
    if not manager or not name:
        name = own
    if not name:
        raise HTTPException(400, "Не указано ФИО таксатора")
    return ip, name[:255], (manager or name == own), own


def _ecp_check_sig(sig_data: str):
    if not isinstance(sig_data, str) or not sig_data.startswith('data:image'):
        raise HTTPException(400, "Некорректные данные подписи")
    if len(sig_data) > 2_000_000:
        raise HTTPException(400, "Файл подписи слишком большой")


@app.get("/api/ecp/get")
def api_ecp_get(request: Request, name: str = ""):
    """Личная ЭЦП таксатора — читается с сервера при каждом открытии окна
    «Таксаторы печать». Черновик виден только владельцу и управляющим."""
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _is_registered_or_admin(ip, user_id, device_id):
        raise HTTPException(403, "Нет доступа")
    name = (name or '').strip()
    if not name:
        return {"ok": True, "signed": False, "status": "none", "lock_months": _ECP_LOCK_MONTHS}
    own = _display_name(ip, device_id)
    can_see_draft = (name == own) or _can_manage_print_queue(ip, user_id, device_id)
    db = _pg()
    try:
        rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == name).first()
        st = _ecp_state(rec, can_see_draft)
        st["is_admin"] = bool(user_id)
        return st
    finally:
        db.close()


@app.post("/api/ecp/save")
async def api_ecp_save(request: Request):
    """[v18] Сохранить ЧЕРНОВИК подписи — без ограничений по количеству.
    Недоступно, только пока утверждённая подпись заблокирована."""
    data = await request.json()
    ip, name, _own_or_mgr, _ = _ecp_resolve_name(request, data.get('name') or '')
    sig_data = data.get('sig_data') or ''
    _ecp_check_sig(sig_data)
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db = _pg()
    try:
        rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == name).first()
        if rec and rec.sig_data and rec.locked_until and rec.locked_until > now:
            raise HTTPException(403, f"ЭЦП «{name}» утверждена {_ecp_fmt(rec.signed_at)} и заблокирована до {_ecp_fmt(rec.locked_until)}")
        if not rec:
            rec = PgEcpSignature(taxator_name=name, sig_data='', signed_at='', locked_until='', signed_by_ip='')
            db.add(rec)
        rec.draft_data = sig_data
        rec.draft_at = now
        rec.draft_by_ip = ip
        db.commit()
        st = _ecp_state(rec, True); st["name"] = name
        return st
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.post("/api/ecp/approve")
async def api_ecp_approve(request: Request):
    """[v18] Утвердить подпись: присланную (sig_data) или сохранённый черновик.
    После утверждения ЭЦП блокируется на ECP_LOCK_MONTHS месяцев."""
    data = await request.json()
    ip, name, _own_or_mgr, who = _ecp_resolve_name(request, data.get('name') or '')
    now_dt = datetime.now()
    now = now_dt.strftime('%Y-%m-%d %H:%M:%S')
    db = _pg()
    try:
        rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == name).first()
        if rec and rec.sig_data and rec.locked_until and rec.locked_until > now:
            raise HTTPException(403, f"ЭЦП «{name}» уже утверждена {_ecp_fmt(rec.signed_at)} и заблокирована до {_ecp_fmt(rec.locked_until)}")
        sig_data = data.get('sig_data') or (getattr(rec, 'draft_data', '') if rec else '')
        if not sig_data:
            raise HTTPException(400, "Нет подписи для утверждения — нарисуйте подпись или сохраните черновик")
        _ecp_check_sig(sig_data)
        if not rec:
            rec = PgEcpSignature(taxator_name=name)
            db.add(rec)
        rec.sig_data = sig_data
        rec.signed_at = now
        rec.locked_until = _ecp_add_months(now_dt, _ECP_LOCK_MONTHS).strftime('%Y-%m-%d %H:%M:%S')
        rec.signed_by_ip = ip
        rec.approved_by = who
        rec.draft_data = ''; rec.draft_at = ''; rec.draft_by_ip = ''
        db.commit()
        st = _ecp_state(rec, True); st["name"] = name
        return st
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.post("/api/ecp/discard_draft")
async def api_ecp_discard_draft(request: Request):
    data = await request.json()
    _ip, name, _own_or_mgr, _ = _ecp_resolve_name(request, data.get('name') or '')
    db = _pg()
    try:
        rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == name).first()
        keep = bool(rec and rec.sig_data)
        if rec:
            rec.draft_data = ''; rec.draft_at = ''; rec.draft_by_ip = ''
            if not keep:
                db.delete(rec)
            db.commit()
        st = _ecp_state(rec if keep else None, True); st["name"] = name
        return st
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.post("/api/ecp/unlock")
async def api_ecp_unlock(request: Request):
    """[v18] Досрочно снять 6-месячную блокировку (например, подпись
    утверждена по ошибке). Только администратор (с доп. паролем)."""
    require_admin(request)
    verify_csrf(request)
    data = await request.json()
    name = (data.get('name') or '').strip()
    if not name:
        raise HTTPException(400, "Не указано ФИО таксатора")
    db = _pg()
    try:
        rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == name).first()
        if not rec or not rec.sig_data:
            raise HTTPException(404, "Утверждённая ЭЦП не найдена")
        rec.locked_until = ''
        db.commit()
        st = _ecp_state(rec, True); st["name"] = name
        return st
    except HTTPException:
        db.rollback(); raise
    finally:
        db.close()


@app.get("/api/print_queue/list")
def api_print_queue_list(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    db = _pg()
    try:
        rows = db.query(PgPrintQueueEntry).order_by(PgPrintQueueEntry.pos.asc(), PgPrintQueueEntry.id.asc()).all()
        return {
            "ok": True,
            "queue": [_pq_entry_to_dict(r) for r in rows],
            "can_manage": _can_manage_print_queue(ip, user_id, get_device_id(request)),
            "my_name": _display_name(ip, get_device_id(request)),
            "meta": _pq_meta(db),
            "server_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }
    finally:
        db.close()


@app.get("/api/print_queue/meta")
def api_print_queue_meta(request: Request):
    """[v18] Лёгкий опрос «изменилась ли очередь» (раз в ~20 с, пока окно
    «Таксаторы печать» открыто): время, автор и суть последнего изменения."""
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    db = _pg()
    try:
        return {"ok": True, "meta": _pq_meta(db),
                "count": db.query(func.count(PgPrintQueueEntry.id)).scalar() or 0,
                "server_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    finally:
        db.close()


@app.post("/api/print_queue/add")
async def api_print_queue_add(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    data = await request.json()

    leshoz = (data.get('leshoz') or '').strip()
    expedition = (data.get('expedition') or '').strip()
    taxator = (data.get('taxator') or '').strip()
    if not leshoz:
        raise HTTPException(400, "Не выбран лесхоз")
    if not expedition:
        raise HTTPException(400, "Не выбрана экспедиция")
    if not taxator:
        raise HTTPException(400, "Не указан таксатор")

    can_manage = _can_manage_print_queue(ip, user_id, get_device_id(request))
    if not can_manage:
        # рядовой пользователь может поставить в очередь только себя —
        # поле «Таксатор», присланное с клиента, игнорируется в пользу
        # реального имени из сессии (защита от подмены на клиенте)
        taxator = _display_name(ip, get_device_id(request))

    ecp_sig_data = data.get('ecp_sig_data') or ''
    if len(ecp_sig_data) > 2_000_000:
        raise HTTPException(400, "Файл подписи слишком большой")
    ecp_user = (data.get('ecp_user') or '').strip()
    if not can_manage:
        # рядовой пользователь подписывает заявку только своей ЭЦП
        ecp_user = _display_name(ip, get_device_id(request))
    if not ecp_user or not ecp_sig_data:
        raise HTTPException(403, "Для постановки в очередь нужна утверждённая ЭЦП")

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db = _pg()
    try:
        # [v18] ЭЦП проверяется на сервере: должна быть УТВЕРЖДЕНА (черновик
        # не подходит) и совпадать с действующей подписью таксатора.
        sig_rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == ecp_user).first()
        if not sig_rec or not sig_rec.sig_data:
            raise HTTPException(403, f"ЭЦП «{ecp_user}» не утверждена — откройте «ЭЦП» и нажмите «Утвердить»")
        if sig_rec.sig_data != ecp_sig_data:
            raise HTTPException(403, "Присланная ЭЦП не совпадает с утверждённой подписью — обновите окно")
        max_pos = db.query(func.coalesce(func.max(PgPrintQueueEntry.pos), 0)).scalar() or 0
        entry = PgPrintQueueEntry(
            pos=int(max_pos) + 1,
            taxator=taxator,
            leshoz=leshoz,
            lesnichestvo=(data.get('lesnichestvo') or '').strip(),
            expedition=expedition,
            kvartal=(data.get('kvartal') or '').strip(),
            vydel=(data.get('vydel') or '').strip(),
            sheets=int(data.get('sheets') or 1),
            time_label=(data.get('time') or '').strip(),
            priority=(data.get('priority') or 'normal').strip(),
            status='not_ready',
            status_changed_by=_display_name(ip, get_device_id(request)),
            status_changed_at=now,
            ecp_user=ecp_user,
            ecp_time=(data.get('ecp_time') or '').strip(),
            ecp_sig_data=ecp_sig_data,
            created_by_ip=ip,
            created_at=now,
        )
        db.add(entry); db.flush()
        db.add(PgPrintQueueStatusLog(entry_id=entry.id, status='not_ready',
                                      changed_by=_display_name(ip, get_device_id(request)), changed_by_ip=ip, changed_at=now))
        db.commit()
        out = _pq_entry_to_dict(entry)
        _pq_touch(_display_name(ip, get_device_id(request)), f"Добавлена запись: {leshoz}" + (f", кв. {out.get('kvartal')}" if out.get('kvartal') else ''))
        return {"ok": True, "entry": out}
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.post("/api/print_queue/{entry_id}/status")
async def api_print_queue_set_status(entry_id: int, request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _can_manage_print_queue(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Изменение статуса доступно только администратору и сотрудникам ОДЗиМЛ")
    data = await request.json()
    new_status = (data.get('status') or '').strip()
    if new_status not in _PQ_VALID_STATUSES:
        raise HTTPException(400, "Неизвестный статус")
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    who = _display_name(ip, get_device_id(request))
    db = _pg()
    try:
        entry = db.query(PgPrintQueueEntry).filter(PgPrintQueueEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(404, "Запись не найдена")
        entry.status = new_status
        entry.status_changed_by = who
        entry.status_changed_at = now
        db.add(PgPrintQueueStatusLog(entry_id=entry_id, status=new_status,
                                      changed_by=who, changed_by_ip=ip, changed_at=now))
        db.commit()
        out = _pq_entry_to_dict(entry)
        _pq_touch(who, f"Статус «{_PQ_STATUS_LABELS.get(new_status, new_status)}»: {out.get('taxator') or ''}, {out.get('leshoz') or ''}".strip(', '))
        return {"ok": True, "entry": out}
    except HTTPException:
        raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.post("/api/print_queue/{entry_id}/update")
async def api_print_queue_update(entry_id: int, request: Request):
    """Сохранение правок, сделанных во вкладке «Просмотр Excel».

    Требует прав на редактирование очереди (как смена статуса/удаление)
    И действующей, неистёкшей ЭЦП того, кто подтверждает сохранение —
    ecp_user/ecp_sig_data проверяются на сервере против pg_ecp_signatures,
    а не просто принимаются от клиента, чтобы «подтверждение ЭЦП» не
    сводилось к декоративной проверке на фронтенде."""
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _can_manage_print_queue(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Редактирование записей доступно только администратору и сотрудникам ОДЗиМЛ")

    data = await request.json()
    ecp_user = (data.get('ecp_user') or '').strip()
    ecp_sig_data = data.get('ecp_sig_data') or ''
    if not ecp_user or not ecp_sig_data:
        raise HTTPException(403, "Для сохранения изменений требуется подтверждённая ЭЦП")

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db = _pg()
    try:
        # Проверяем, что присланная ЭЦП действительно активна на сервере
        # (не истёк срок, подпись совпадает с сохранённой) — иначе
        # клиент мог бы прислать произвольные ecp_user/ecp_sig_data.
        sig_rec = db.query(PgEcpSignature).filter(PgEcpSignature.taxator_name == ecp_user).first()
        if not sig_rec or not sig_rec.sig_data:
            raise HTTPException(403, f"ЭЦП «{ecp_user}» не найдена на сервере — подпишите заново")
        if sig_rec.sig_data != ecp_sig_data:
            raise HTTPException(403, "Присланная ЭЦП не совпадает с действующей подписью на сервере")

        entry = db.query(PgPrintQueueEntry).filter(PgPrintQueueEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(404, "Запись не найдена")

        changed_status = False
        for field in _PQ_EDITABLE_TEXT_FIELDS:
            if field in data:
                value = (data.get(field) or '').strip()
                if field == 'time':
                    entry.time_label = value
                else:
                    setattr(entry, field, value)

        if 'sheets' in data:
            try:
                sheets = int(data.get('sheets'))
            except (TypeError, ValueError):
                raise HTTPException(400, "Некорректное значение «Листов»")
            if sheets < 1:
                raise HTTPException(400, "«Листов» должно быть не меньше 1")
            entry.sheets = sheets

        if 'priority' in data:
            priority = (data.get('priority') or '').strip()
            if priority not in _PQ_VALID_PRIORITIES:
                raise HTTPException(400, "Неизвестный приоритет")
            entry.priority = priority

        if 'status' in data:
            status = (data.get('status') or '').strip()
            if status not in _PQ_VALID_STATUSES:
                raise HTTPException(400, "Неизвестный статус")
            if status != entry.status:
                changed_status = True
            entry.status = status
            entry.status_changed_by = _display_name(ip, get_device_id(request))
            entry.status_changed_at = now

        who = _display_name(ip, get_device_id(request))
        entry.edited_by = who
        entry.edited_at = now
        entry.edit_ecp_user = ecp_user
        entry.edit_ecp_time = (data.get('ecp_time') or '').strip()
        entry.edit_ecp_sig_data = ecp_sig_data

        if changed_status:
            db.add(PgPrintQueueStatusLog(entry_id=entry_id, status=entry.status,
                                          changed_by=who, changed_by_ip=ip, changed_at=now))
        db.commit()
        out = _pq_entry_to_dict(entry)
        _pq_touch(who, f"Запись изменена: {out.get('taxator') or ''}, {out.get('leshoz') or ''}".strip(', '))
        return {"ok": True, "entry": out}
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.get("/api/print_queue/{entry_id}/status_history")
def api_print_queue_status_history(entry_id: int, request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    db = _pg()
    try:
        rows = db.query(PgPrintQueueStatusLog).filter(
            PgPrintQueueStatusLog.entry_id == entry_id
        ).order_by(PgPrintQueueStatusLog.id.asc()).all()
        return {"ok": True, "history": [
            {"status": r.status, "status_label": _PQ_STATUS_LABELS.get(r.status, r.status),
             "changed_by": r.changed_by, "changed_at": r.changed_at} for r in rows
        ]}
    finally:
        db.close()


@app.post("/api/print_queue/reorder")
async def api_print_queue_reorder(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _can_manage_print_queue(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Изменение порядка доступно только администратору и сотрудникам ОДЗиМЛ")
    data = await request.json()
    ids = data.get('ids') or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "Пустой список")
    db = _pg()
    try:
        for i, eid in enumerate(ids, 1):
            db.query(PgPrintQueueEntry).filter(PgPrintQueueEntry.id == int(eid)).update({"pos": i})
        db.commit()
        _pq_touch(_display_name(ip, get_device_id(request)), "Изменён порядок очереди")
        return {"ok": True}
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.delete("/api/print_queue/{entry_id}")
def api_print_queue_delete(entry_id: int, request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _can_manage_print_queue(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Удаление доступно только администратору и сотрудникам ОДЗиМЛ")
    db = _pg()
    try:
        entry = db.query(PgPrintQueueEntry).filter(PgPrintQueueEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(404, "Запись не найдена")
        gone = f"{entry.taxator or ''}, {entry.leshoz or ''}".strip(', ')
        db.delete(entry)
        db.query(PgPrintQueueStatusLog).filter(PgPrintQueueStatusLog.entry_id == entry_id).delete()
        db.commit()
        _pq_touch(_display_name(ip, get_device_id(request)), f"Запись удалена: {gone}")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


@app.get("/api/print_queue/export_xlsx")
def api_print_queue_export_xlsx(request: Request):
    """Экспорт очереди печати в Excel с встроенными изображениями подписей ЭЦП."""
    ip = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(ip, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")

    import io, base64, openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.drawing.image import Image as XLImage

    db = _pg()
    try:
        rows = db.query(PgPrintQueueEntry).order_by(PgPrintQueueEntry.pos.asc(), PgPrintQueueEntry.id.asc()).all()
    finally:
        db.close()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Очередь печати"

    HEADERS = ["#", "Таксатор", "Лесхоз", "Лесничество", "Экспедиция", "Квартал/уч.",
               "Выдел", "Листов", "Время", "Приоритет", "Статус", "Изменил статус",
               "Время изменения статуса", "Подписал ЭЦП", "Время подписи ЭЦП", "Подпись (ЭЦП)"]
    header_fill = PatternFill("solid", fgColor="1F5C2E")
    header_font = Font(bold=True, color="FFFFFF", size=11)
    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for col_idx, h in enumerate(HEADERS, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.fill = header_fill; cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = border
    ws.row_dimensions[1].height = 34

    fill_even = PatternFill("solid", fgColor="EEF7EC")
    fill_odd = PatternFill("solid", fgColor="FFFFFF")
    SIG_COL = len(HEADERS)  # последняя колонка — подпись

    for row_idx, r in enumerate(rows, 2):
        fill = fill_even if row_idx % 2 == 0 else fill_odd
        values = [
            r.pos, r.taxator, r.leshoz, r.lesnichestvo or '—', r.expedition,
            r.kvartal or '—', r.vydel or '—', r.sheets, r.time_label or '—',
            {'normal': 'Обычный', 'high': 'Высокий', 'urgent': 'Срочный'}.get(r.priority, r.priority),
            _PQ_STATUS_LABELS.get(r.status, r.status), r.status_changed_by or '—',
            r.status_changed_at or '—', r.ecp_user or '—', r.ecp_time or '—', '',
        ]
        for col_idx, v in enumerate(values, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=v)
            cell.fill = fill; cell.border = border
            cell.alignment = Alignment(vertical="center", wrap_text=(col_idx in (3, 5)))
        ws.row_dimensions[row_idx].height = 46

        # Встраиваем изображение подписи (если есть) в последнюю колонку
        sig = r.ecp_sig_data or ''
        if sig.startswith('data:image'):
            try:
                b64 = sig.split(',', 1)[1]
                img_bytes = base64.b64decode(b64)
                img = XLImage(io.BytesIO(img_bytes))
                img.width, img.height = 110, 38
                ws.add_image(img, f"{get_column_letter(SIG_COL)}{row_idx}")
            except Exception:
                ws.cell(row=row_idx, column=SIG_COL, value="—")

    col_widths = [5, 20, 26, 24, 30, 14, 8, 8, 16, 12, 14, 20, 18, 20, 18, 18]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADERS))}1"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"taxator_queue_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.get("/messages", response_class=HTMLResponse)
def messages_page(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not _is_registered_or_admin(ip,user_id,device_id): return RedirectResponse(url="/")
    return templates.TemplateResponse(request=request,name="messages.html",
        context={"is_admin":bool(user_id),"user_ip":ip,"user_name":_display_name(ip, device_id),"user_org":_get_user_org(ip, device_id),
                 "csrf_token":get_csrf_token(request)})


@app.post("/api/generate_vacancy_doc")
async def api_generate_vacancy_doc(request: Request):
    """Генерация заявления за свой счёт в формате .docx."""
    # Доступно всем пользователям сети (регистрация не требуется)
    try:
        from docx import Document as _DocxDocument
        from docx.shared import Pt, Twips
        from docx.oxml.ns import qn as _qn
        from docx.oxml import OxmlElement as _OE
    except ImportError:
        raise HTTPException(500, "python-docx не установлен. pip install python-docx")

    data = await request.json()
    dir_title = data.get('dir_title', '')
    dir_name  = data.get('dir_name',  '')
    pos_title = data.get('pos_title', '')
    pos_gen   = data.get('pos_gen',   '')
    fio_gen   = data.get('fio_gen',   '')
    fio_nom   = data.get('fio_nom',   '')
    days      = data.get('days',      '')
    day_word  = data.get('day_word',  'календарный день')
    dates     = data.get('dates',     '')
    date_doc  = data.get('date_doc',  datetime.now().strftime('%d.%m.%Y'))

    doc = _DocxDocument()
    # Поля точно из XML оригинала: top=1134, right=850, bottom=1134, left=1701 twips (A4)
    for section in doc.sections:
        section.page_width    = Twips(11906)
        section.page_height   = Twips(16838)
        section.top_margin    = Twips(1134)
        section.bottom_margin = Twips(1134)
        section.left_margin   = Twips(1701)
        section.right_margin  = Twips(850)

    def _set_font(run):
        """Times New Roman 14pt — точно как в оригинале (sz=28 = 14pt)."""
        run.font.size = Pt(14)
        run.font.name = 'Times New Roman'
        rPr = run._r.get_or_add_rPr()
        # Удаляем старые rFonts если есть
        for old in rPr.findall(_qn('w:rFonts')):
            rPr.remove(old)
        rFonts = _OE('w:rFonts')
        rFonts.set(_qn('w:ascii'), 'Times New Roman')
        rFonts.set(_qn('w:hAnsi'), 'Times New Roman')
        rPr.insert(0, rFonts)

    def _para_simple(text=''):
        """Обычный абзац без отступа (ЗАЯВЛЕНИЕ, дата, пустые строки)."""
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after  = Pt(0)
        if text:
            r = p.add_run(text)
            _set_font(r)
        return p

    def _para_right_block(text='', left_twips=5670):
        """Абзац с левым отступом для правого блока шапки — точно как в XML оригинала."""
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after  = Pt(0)
        pPr = p._p.get_or_add_pPr()
        ind = _OE('w:ind')
        ind.set(_qn('w:left'), str(left_twips))
        pPr.append(ind)
        if text:
            r = p.add_run(text)
            _set_font(r)
        return p

    # ── Шапка (правый блок через left-indent, как в оригинале) ─────────────────
    _para_right_block(dir_title,        left_twips=5670)   # "Генеральному директору"
    _para_right_block('РУП «Белгослес»', left_twips=5670)  # организация
    _para_right_block(dir_name,         left_twips=5670)   # ФИО директора
    _para_right_block(pos_gen,          left_twips=5670)   # должность заявителя (род.)
    _para_right_block('ОДЗиМЛ',         left_twips=5670)   # подразделение
    _para_right_block(fio_gen,          left_twips=5670)   # ФИО заявителя (род.)

    # ── Заголовок ──────────────────────────────────────────────────────────────
    _para_simple()                         # пустая строка
    p_title = _para_simple('ЗАЯВЛЕНИЕ')
    p_title.runs[0].bold = True
    _para_simple(date_doc)                 # дата

    # Две пустые строки (как в оригинале)
    _para_simple()
    _para_simple()

    # ── Текст заявления ────────────────────────────────────────────────────────
    # firstLine=851 twips, jc=both — точно из XML оригинала
    body_text = (
        f'Прошу предоставить мне социальный отпуск без сохранения заработной платы '
        f'на {days} {day_word} {dates} по семейно-бытовым причинам. '
    )
    p_body = doc.add_paragraph()
    p_body.paragraph_format.space_before = Pt(0)
    p_body.paragraph_format.space_after  = Pt(0)
    pPr_body = p_body._p.get_or_add_pPr()
    ind_body = _OE('w:ind')
    ind_body.set(_qn('w:firstLine'), '851')
    pPr_body.append(ind_body)
    jc = _OE('w:jc')
    jc.set(_qn('w:val'), 'both')
    pPr_body.append(jc)
    rb = p_body.add_run(body_text)
    _set_font(rb)

    # Две пустые строки после текста (как в оригинале)
    _para_simple()
    _para_simple()

    # ── Строка подписи ─────────────────────────────────────────────────────────
    # Оригинал: текст должности + пробелы + <w:tab/> + ФИО — всё в одном параграфе
    p_sign = doc.add_paragraph()
    p_sign.paragraph_format.space_before = Pt(0)
    p_sign.paragraph_format.space_after  = Pt(0)

    pos_clean = pos_title.rstrip('.')
    # Точку после должности ставим только если в названии есть сокращение (внутренняя точка)
    pos_sign = (pos_clean + '.') if '.' in pos_clean else pos_clean
    sign_left = f'{pos_sign} ОДЗиМЛ                                       '
    r_sign = p_sign.add_run(sign_left)
    _set_font(r_sign)
    # Добавляем <w:tab/> в тот же run
    tab_el = _OE('w:tab')
    r_sign._r.append(tab_el)
    # ФИО после таба
    fio_t = _OE('w:t')
    fio_t.text = fio_nom
    r_sign._r.append(fio_t)
    # Таб-стоп: right на 8640 twips
    pPr_sign = p_sign._p.get_or_add_pPr()
    tabs_el = _OE('w:tabs')
    tab_stop = _OE('w:tab')
    tab_stop.set(_qn('w:val'), 'right')
    tab_stop.set(_qn('w:pos'), '8640')
    tabs_el.append(tab_stop)
    pPr_sign.append(tabs_el)
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    from urllib.parse import quote as _url_quote
    _fname = 'Заявление_за_свой_счёт.docx'
    _fname_encoded = _url_quote(_fname, safe='')
    headers = {
        'Content-Disposition': f"attachment; filename=\"zayavlenie.docx\"; filename*=UTF-8''{_fname_encoded}"
    }
    return Response(content=buf.read(), headers=headers,
                    media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document')

@app.get("/api/messages/quota")
async def api_messages_quota(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not await run_in_threadpool(_is_registered_or_admin, ip, user_id, device_id): raise HTTPException(403)
    unlimited=_is_quota_unlimited(ip); used=0 if unlimited else _quota_used_today(ip)
    return {"ok":True,"unlimited":unlimited,"used_bytes":used,"limit_bytes":MSG_QUOTA_BYTES,"used_mb":round(used/1024/1024,1),"limit_mb":512}

@app.post("/api/messages/delete")
async def api_messages_delete(request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not await run_in_threadpool(_is_registered_or_admin, ip, user_id, device_id): raise HTTPException(403)
    data=await request.json(); msg_id=data.get('msg_id')
    if not msg_id: raise HTTPException(400,"msg_id обязателен")
    db=_pg()
    try:
        msg=db.query(PgMessage).filter(PgMessage.id==msg_id).first()
        if not msg: raise HTTPException(404)
        if msg.from_ip!=ip and not user_id: raise HTTPException(403,"Нет прав")
        db.delete(msg); db.commit(); return {"ok":True}
    except HTTPException: raise
    except: db.rollback(); raise
    finally: db.close()

@app.post("/api/messages/send_file")
async def api_messages_send_file(request: Request, to_ip: str=Form(...), file: UploadFile=File(...)):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not await run_in_threadpool(_is_registered_or_admin, ip, user_id, device_id): raise HTTPException(403)
    mime=file.content_type or 'application/octet-stream'
    if mime not in ALLOWED_ATTACH_MIME: raise HTTPException(400,f"Тип файла не разрешён: {mime}")
    # [SEC v16] Расширение — из РАЗРЕШЁННОГО MIME (раньше из имени: «x.html» с типом
    # image/png сохранялся как .html и открывался в браузере → stored XSS).
    # [PERF v16] Потоковая запись с лимитом вместо чтения 100 МБ в память.
    ext=_sh.ext_for_mime(mime, file.filename or ''); safe_name=_uuid_mod.uuid4().hex+ext
    save_dir=_attach_dir_for_ip(ip)
    _dest=os.path.join(save_dir,safe_name)
    fsize=await _sh.save_upload(file, _dest, max_bytes=100*1024*1024)
    if not _is_quota_unlimited(ip):
        used=_quota_used_today(ip)
        if used+fsize>MSG_QUOTA_BYTES:
            _remove_quiet(_dest)
            raise HTTPException(429,"Превышен дневной лимит 512 МБ")
    now=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    db=_pg()
    try:
        body=f'__FILE__:{safe_name}:{ip}:{file.filename or safe_name}:{mime}'
        msg=PgMessage(from_ip=ip,to_ip=to_ip,body=body,sent_at=now,is_read=0)
        db.add(msg); db.flush()
        db.add(PgMsgFile(msg_id=msg.id,from_ip=ip,filename=safe_name,
                         orig_name=file.filename or safe_name,mime_type=mime,file_size=fsize,sent_at=now))
        db.commit(); return {"ok":True,"msg_id":msg.id}
    except: db.rollback(); raise
    finally: db.close()

@app.get("/api/messages/file/{owner_ip}/{filename}")
def api_messages_file(owner_ip: str, filename: str, request: Request):
    ip=get_real_ip(request); device_id=get_device_id(request); user_id=get_current_user(request)
    if not _is_registered_or_admin(ip,user_id,device_id): raise HTTPException(403)
    db=_pg()
    try:
        from sqlalchemy import join
        row=db.query(PgMessage.from_ip, PgMessage.to_ip).join(
            PgMsgFile, PgMsgFile.msg_id==PgMessage.id
        ).filter(PgMsgFile.filename==filename, PgMsgFile.from_ip==owner_ip).first()
        if not row: raise HTTPException(404)
        if ip not in (row.from_ip, row.to_ip) and not user_id: raise HTTPException(403)
        fpath=_sh.safe_join(_attach_dir_for_ip(owner_ip),filename)
        if not fpath or not os.path.isfile(fpath): raise HTTPException(404)
        # [SEC v16] Только картинки/PDF показываются в браузере; остальное — скачивание
        # (octet-stream, nosniff, CSP sandbox): HTML/SVG во вложении не исполнится.
        _meta=db.query(PgMsgFile.orig_name, PgMsgFile.mime_type).filter(
            PgMsgFile.filename==filename, PgMsgFile.from_ip==owner_ip).first()
        _media,_hdrs=_sh.attachment_headers((_meta.orig_name if _meta else filename) or filename,
                                            (_meta.mime_type if _meta else '') or '')
        return FileResponse(fpath, media_type=_media, headers=_hdrs)
    finally: db.close()

# ── LAYER PREFS ────────────────────────────────────────────
@app.post("/api/layer_prefs/save")
async def api_layer_prefs_save(request: Request):
    ip=get_real_ip(request); data=await request.json(); now=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn=_get_conn(); cur=conn.cursor()
    cur.execute("INSERT INTO layer_prefs (ip,prefs_json,updated_at) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET prefs_json=excluded.prefs_json,updated_at=excluded.updated_at",
                (ip,json.dumps(data),now))
    conn.commit(); conn.close(); return {"ok":True}

@app.get("/api/layer_prefs/load")
def api_layer_prefs_load(request: Request):
    ip=get_real_ip(request); conn=_get_conn(); cur=conn.cursor()
    cur.execute("SELECT prefs_json FROM layer_prefs WHERE ip=?",(ip,)); row=cur.fetchone(); conn.close()
    if row:
        try: return json.loads(row['prefs_json'])
        except: pass
    return {}

# ── TTS (SILERO) — озвучка голосового ответа ────────────────
@app.post("/api/tts")
async def api_tts(request: Request):
    """Озвучивает переданный текст локальной моделью Silero (ru) —
    без внешних API и ключей. Возвращает audio/wav."""
    user_id = get_current_user(request)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Требуется авторизация")

    data = await request.json()
    text = (data.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустой текст")
    if len(text) > 300:
        text = text[:300]  # короткие служебные фразы — этого достаточно

    loop = _asyncio.get_running_loop()
    try:
        wav_bytes = await loop.run_in_executor(_tts_executor, _synthesize_wav_bytes, text)
    except Exception:
        logging.exception("[TTS] Ошибка синтеза речи")
        raise HTTPException(status_code=500, detail="Ошибка синтеза речи")

    return Response(content=wav_bytes, media_type="audio/wav")


# ── DZZ ORDER ──────────────────────────────────────────────
@app.post("/api/dzz_order/save")
async def api_dzz_order_save(request: Request):
    ip=get_real_ip(request); data=await request.json()
    tab_id=data.get('tabId','').strip(); year=str(data.get('year','')).strip(); key_order=data.get('keyOrder',[])
    if not tab_id or not year or not isinstance(key_order,list): raise HTTPException(400,"bad params")
    tab_year=f"{tab_id}_{year}"; now=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn=_get_conn(); cur=conn.cursor()
    cur.execute("INSERT INTO dzz_layer_order (ip,tab_year,key_order,updated_at) VALUES (?,?,?,?) ON CONFLICT(ip,tab_year) DO UPDATE SET key_order=excluded.key_order,updated_at=excluded.updated_at",
                (ip,tab_year,json.dumps(key_order),now))
    conn.commit(); conn.close(); return {"ok":True}

@app.get("/api/dzz_order/load")
def api_dzz_order_load(request: Request):
    ip=get_real_ip(request); conn=_get_conn(); cur=conn.cursor()
    try:
        cur.execute('SELECT tab_year,key_order FROM dzz_layer_order WHERE ip=?',(ip,)); rows=cur.fetchall(); conn.close()
        return {r['tab_year']:json.loads(r['key_order']) for r in rows if r['key_order']}
    except: conn.close(); return {}

# ── WEATHER ────────────────────────────────────────────────
# Серверный кэш погоды: ключ → (data_dict, timestamp)
# TTL = 1 час; не запрашиваем Open-Meteo повторно, пока кэш свежий.
_weather_server_cache: dict = {}
_WEATHER_SERVER_TTL = 3600   # секунд
_weather_cache_lock = threading.Lock()

def _weather_cache_key(lat: float, lon: float) -> str:
    return f"{round(lat, 4)},{round(lon, 4)}"

def _weather_cache_get(key: str):
    with _weather_cache_lock:
        entry = _weather_server_cache.get(key)
        if entry and (time.time() - entry["ts"]) < _WEATHER_SERVER_TTL:
            return entry["data"]
    return None

def _weather_cache_put(key: str, data: dict):
    with _weather_cache_lock:
        _weather_server_cache[key] = {"data": data, "ts": time.time()}


def _normalize_open_meteo(data: dict) -> dict:
    """Нормализует ответ Open-Meteo: приводит current_weather → current."""
    if "current" not in data and "current_weather" in data:
        cw = data["current_weather"]
        data["current"] = {
            "temperature_2m":    cw.get("temperature"),
            "windspeed_10m":     cw.get("windspeed"),
            "winddirection_10m": cw.get("winddirection"),
            "weathercode":       cw.get("weathercode"),
            "time":              cw.get("time", ""),
        }
    return data


@app.get("/api/weather")
async def api_weather(
    latitude: float = Query(..., description="Широта точки"),
    longitude: float = Query(..., description="Долгота точки"),
):
    """
    Прокси к Open-Meteo API — возвращает текущую погоду для заданных координат.
    Использует серверный кэш TTL=1ч, чтобы повторные запросы отдавались мгновенно.
    Фронтенд (_fetchWeatherPoint в map-core.js) ожидает структуру:
      { "current": { "temperature_2m", "windspeed_10m", "winddirection_10m", "weathercode", "time" } }
    """
    key = _weather_cache_key(latitude, longitude)
    cached = _weather_cache_get(key)
    if cached:
        return JSONResponse(content=cached)

    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitude}&longitude={longitude}"
        "&current=temperature_2m,windspeed_10m,winddirection_10m,weathercode"
        "&timezone=auto&forecast_days=1"
    )
    try:
        resp = await run_in_threadpool(
            lambda: requests.get(url, timeout=8)
        )
        resp.raise_for_status()
        data = _normalize_open_meteo(resp.json())
        _weather_cache_put(key, data)
        return JSONResponse(content=data)
    except requests.exceptions.Timeout:
        logger.warning(f"[weather] timeout для ({latitude}, {longitude})")
        raise HTTPException(status_code=504, detail="Open-Meteo не ответил вовремя")
    except requests.exceptions.HTTPError as e:
        logger.warning(f"[weather] HTTP error от Open-Meteo: {e}")
        raise HTTPException(status_code=502, detail=f"Ошибка Open-Meteo: {e}")
    except Exception as e:
        logger.error(f"[weather] неожиданная ошибка: {e}")
        raise HTTPException(status_code=502, detail="Ошибка получения погоды")


@app.get("/api/weather/batch")
async def api_weather_batch(
    latitudes: str = Query(..., description="Широты через запятую, напр. 53.1,52.9,54.2"),
    longitudes: str = Query(..., description="Долготы через запятую, напр. 25.9,23.7,27.8"),
):
    """
    Батч-прокси к Open-Meteo API.
    Open-Meteo поддерживает несколько координат в одном запросе (до 1000 точек),
    возвращая массив объектов. Один запрос вместо N — значительное ускорение.

    Возвращает JSON-массив:
      [ { "lat": 53.1, "lon": 25.9, "current": {...} }, ... ]
    Точки, для которых Open-Meteo вернул ошибку, включаются с current=null.
    """
    try:
        lats = [float(x.strip()) for x in latitudes.split(",") if x.strip()]
        lons = [float(x.strip()) for x in longitudes.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный формат координат")

    if len(lats) != len(lons):
        raise HTTPException(status_code=400, detail="Количество широт и долгот не совпадает")
    if not lats:
        raise HTTPException(status_code=400, detail="Нет координат")
    if len(lats) > 300:
        raise HTTPException(status_code=400, detail="Максимум 300 точек за запрос")

    # Сначала отдаём из серверного кэша всё что есть
    results = [None] * len(lats)
    uncached_idx = []
    for i, (lat, lon) in enumerate(zip(lats, lons)):
        key = _weather_cache_key(lat, lon)
        cached = _weather_cache_get(key)
        if cached:
            results[i] = {"lat": lat, "lon": lon, "current": cached.get("current")}
        else:
            uncached_idx.append(i)

    if uncached_idx:
        # Формируем один батч-запрос к Open-Meteo для некэшированных точек
        uc_lats = ",".join(str(lats[i]) for i in uncached_idx)
        uc_lons = ",".join(str(lons[i]) for i in uncached_idx)
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={uc_lats}&longitude={uc_lons}"
            "&current=temperature_2m,windspeed_10m,winddirection_10m,weathercode"
            "&timezone=auto&forecast_days=1"
        )
        try:
            resp = await run_in_threadpool(
                lambda: requests.get(url, timeout=15)
            )
            resp.raise_for_status()
            raw = resp.json()
            # Open-Meteo возвращает массив, если точек > 1; объект — если ровно 1
            items = raw if isinstance(raw, list) else [raw]
            for j, item in enumerate(items):
                if j >= len(uncached_idx):
                    break
                idx = uncached_idx[j]
                item = _normalize_open_meteo(item)
                _weather_cache_put(_weather_cache_key(lats[idx], lons[idx]), item)
                results[idx] = {
                    "lat": lats[idx],
                    "lon": lons[idx],
                    "current": item.get("current"),
                }
            # Если Open-Meteo вернул меньше точек — заполняем null
            for idx in uncached_idx:
                if results[idx] is None:
                    results[idx] = {"lat": lats[idx], "lon": lons[idx], "current": None}
        except requests.exceptions.Timeout:
            logger.warning(f"[weather/batch] timeout, {len(uncached_idx)} точек")
            for idx in uncached_idx:
                results[idx] = {"lat": lats[idx], "lon": lons[idx], "current": None}
        except Exception as e:
            logger.error(f"[weather/batch] ошибка: {e}")
            for idx in uncached_idx:
                results[idx] = {"lat": lats[idx], "lon": lons[idx], "current": None}

    return JSONResponse(content=results)

# ── HOTSPOTS ───────────────────────────────────────────────
@app.get("/api/hotspots")
async def api_hotspots(
    date: str = Query(default=""),
    time_from: str = Query(default="00:00"),
    time_to: str = Query(default="23:59"),
    satellite: Optional[str] = Query(default=None),
    bbox: Optional[str] = Query(default=None, description="minLon,minLat,maxLon,maxLat (EPSG:4326)"),
):
    """Возвращает тепловые аномалии MeteoEye.

    Параметр bbox (опциональный) позволяет фронтенду передать текущий вьюпорт
    и получить только точки внутри него — уменьшает объём данных на 50–90%.
    Фильтрация выполняется на стороне сервера после получения данных из кэша,
    что не добавляет лишних запросов к MeteoEye.
    """
    if not date:
        date = datetime.utcnow().strftime('%Y-%m-%d')
    try:
        datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise HTTPException(400, f"Неверный формат даты: {date}")

    data, sc = await run_in_threadpool(_me_fetch_cached, date, time_from, time_to, satellite)

    # Bbox-фильтр: отдаём только точки в текущем вьюпорту
    if sc == 200 and bbox and isinstance(data, dict) and 'features' in data:
        try:
            min_lon, min_lat, max_lon, max_lat = map(float, bbox.split(','))
            filtered = [
                f for f in data['features']
                if (f.get('geometry') and
                    f['geometry'].get('coordinates') and
                    min_lon <= f['geometry']['coordinates'][0] <= max_lon and
                    min_lat <= f['geometry']['coordinates'][1] <= max_lat)
            ]
            data = {**data, 'features': filtered, '_bbox_filtered': True,
                    '_total': len(data['features']), '_visible': len(filtered)}
        except Exception as _bbox_err:
            logger.debug(f"[hotspots] bbox filter error: {_bbox_err}")

    return JSONResponse(data, status_code=sc)

@app.get("/api/hotspots/latest")
async def api_hotspots_latest():
    now=datetime.utcnow(); data,sc=await run_in_threadpool(_me_fetch_cached,now.strftime('%Y-%m-%d'),'00:00',now.strftime('%H:%M'))
    if isinstance(data,dict) and 'error' not in data: data['_fetched_at']=now.isoformat()+'Z'
    return JSONResponse(data,status_code=sc)

@app.get("/api/hotspots/debug")
async def api_hotspots_debug():
    today=datetime.utcnow().strftime('%Y-%m-%d'); expr=_me_build_expression(today,'00:00','01:00')
    result={"endpoint":METEOEYE_ENDPOINT,"expression":expr}
    def _fetch_debug():
        r=_me_session.get(METEOEYE_ENDPOINT,params={'expression':expr},timeout=12)
        return {"status":r.status_code,"content_type":r.headers.get('Content-Type',''),"body_preview":r.text[:600],"ok":r.status_code==200}
    try:
        result.update(await run_in_threadpool(_fetch_debug))
    except Exception as e: result['error']=str(e)
    return result

# ══════════════════════════════════════════════════════════════
# ОТЧЁТ ПО ТЕПЛОВЫМ АНОМАЛИЯМ — PDF + Excel
# GET /api/hotspots/report?date=YYYY-MM-DD&time_from=00:00&time_to=23:59&satellite=all&fmt=pdf|xlsx
# Только аномалии ВНУТРИ лесхозов Беларуси (sjoin predicate=within).
# Кириллица через DejaVuSans.ttf (ищем в стандартных путях Linux/Win).
# ══════════════════════════════════════════════════════════════

# Пути поиска шрифта с поддержкой кириллицы (в порядке приоритета)
_CYRILLIC_FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSans-Regular.ttf',
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/calibri.ttf',
]
_CYRILLIC_BOLD_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/calibrib.ttf',
]
# Кэш зарегистрированных шрифтов
_rl_fonts_registered = False

def _register_rl_fonts():
    """Регистрирует кириллические шрифты в reportlab. Возвращает (font_name, bold_name)."""
    global _rl_fonts_registered
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if _rl_fonts_registered:
        return 'CyrFont', 'CyrFontBold'

    reg_normal = False
    reg_bold   = False

    for fp in _CYRILLIC_FONT_CANDIDATES:
        if os.path.exists(fp):
            try:
                pdfmetrics.registerFont(TTFont('CyrFont', fp))
                reg_normal = True
                break
            except Exception:
                continue

    for fp in _CYRILLIC_BOLD_CANDIDATES:
        if os.path.exists(fp):
            try:
                pdfmetrics.registerFont(TTFont('CyrFontBold', fp))
                reg_bold = True
                break
            except Exception:
                continue

    if reg_normal and reg_bold:
        from reportlab.pdfbase.pdfmetrics import registerFontFamily
        try:
            registerFontFamily('CyrFont', normal='CyrFont', bold='CyrFontBold',
                               italic='CyrFont', boldItalic='CyrFontBold')
        except Exception:
            pass

    if reg_normal:
        _rl_fonts_registered = True
        return 'CyrFont', ('CyrFontBold' if reg_bold else 'CyrFont')
    # Фолбэк — кириллица будет крокозябрами, но не упадём
    return 'Helvetica', 'Helvetica-Bold'


def _build_hotspots_report(date, time_from, time_to, satellite, fmt):
    """
    Скачивает горячие точки, делает spatial join с лесхозами Беларуси (shp),
    включает ТОЛЬКО точки внутри лесхозов (вне территории — отбрасываются).
    Кириллица через DejaVuSans. Возвращает (bytes, filename, media_type).
    """
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer,
                                        Table, TableStyle, HRFlowable, PageBreak)
        import openpyxl
        from openpyxl.styles import Font as XFont, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError as e:
        raise RuntimeError(f"Не установлена библиотека: {e}. Установите reportlab и openpyxl.")

    # ── Регистрация кириллического шрифта ──────────────────────────
    fn, fnb = _register_rl_fonts()   # fn=normal, fnb=bold

    # ── 1. Загрузка горячих точек ───────────────────────────────────
    geo, sc = _me_fetch(date, time_from, time_to, satellite)
    features = geo.get('features', []) if isinstance(geo, dict) else []

    # ── 2. Загрузка лесхозов из shp ────────────────────────────────
    gdf_leshoz, err = load_leshoz_data()
    if err or gdf_leshoz is None:
        raise RuntimeError(f"Не удалось загрузить границы лесхозов: {err}")
    if gdf_leshoz.crs and gdf_leshoz.crs.to_epsg() != 4326:
        gdf_leshoz = gdf_leshoz.to_crs('EPSG:4326')

    # ── 3. GeoDataFrame горячих точек ──────────────────────────────
    from shapely.geometry import Point
    rows = []
    for f in features:
        coords = f.get('geometry', {}).get('coordinates')
        if not coords or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        p = f.get('properties', {})
        frp = None
        for k in ('frp', 'FRP', 'fire_radiative_power', 'frpMW', 'frp_mw', 'power', 'fp'):
            if p.get(k) is not None:
                try: frp = float(p[k]); break
                except: pass
        temp = None
        for k in ('temperature', 'temp', 'brightness', 'bright_ti4'):
            if p.get(k) is not None:
                try: temp = float(p[k]); break
                except: pass
        rows.append({
            'geometry': Point(lon, lat),
            'lat': lat, 'lon': lon,
            'satellite': p.get('satellite') or p.get('sat') or '-',
            'dt': p.get('shooting') or p.get('datetime') or p.get('acq_datetime') or '-',
            'frp': frp, 'temp': temp,
        })

    if not rows:
        raise RuntimeError("Нет данных о горячих точках за указанный период.")

    gdf_pts = gpd.GeoDataFrame(rows, crs='EPSG:4326')

    # ── 4. Spatial join — только точки ВНУТРИ лесхозов ─────────────
    joined = gpd.sjoin(
        gdf_pts,
        gdf_leshoz[['final_name', 'code', 'geometry']],
        how='inner',          # inner = только совпавшие (внутри лесхозов)
        predicate='within'
    )

    if joined.empty:
        raise RuntimeError(
            "На территории лесхозов Беларуси за указанный период аномалий не обнаружено."
        )

    # ── 5. Группировка по лесхозам ─────────────────────────────────
    groups = {}
    for _, row in joined.iterrows():
        name = str(row['final_name'])
        code = str(row['code'])
        if name not in groups:
            groups[name] = {'code': code, 'points': []}
        groups[name]['points'].append(row)

    sorted_groups = sorted(groups.items(), key=lambda x: len(x[1]['points']), reverse=True)
    total_in_by   = sum(len(v['points']) for v in groups.values())
    total_all     = len(gdf_pts)

    # ── Подсчёт по степеням интенсивности (bucket) ─────────────────
    BUCKET_LABELS  = ['Незначительная', 'Слабая', 'Умеренная', 'Высокая', 'Очень высокая', 'Экстремальная']
    BUCKET_RANGES  = ['< 300 K', '300–315 K', '315–330 K', '330–345 K', '345–360 K', '> 360 K']
    BUCKET_COLORS_HEX = ['FFE082', 'FFD54F', 'FFB300', 'FF7043', 'E53935', 'B71C1C']

    def _temp_bucket(row):
        t = row.get('temp')
        if t is not None:
            if t > 360: return 5
            if t > 345: return 4
            if t > 330: return 3
            if t > 315: return 2
            if t > 300: return 1
            return 0
        frp = row.get('frp')
        if frp is not None:
            if frp > 200: return 5
            if frp > 100: return 4
            if frp > 50:  return 3
            if frp > 10:  return 2
            if frp > 2:   return 1
        return 0

    bucket_counts = [0] * 6
    for _, row in joined.iterrows():
        bucket_counts[_temp_bucket(row)] += 1

    # Форматируем дату для подписи отчёта  (YYYY-MM-DD → DD.MM.YYYY)
    try:
        date_ru = datetime.strptime(date, '%Y-%m-%d').strftime('%d.%m.%Y')
    except Exception:
        date_ru = date

    sat_label = satellite if satellite else 'Все'

    # ════════════════════════════════════════════
    # 6a. EXCEL
    # ════════════════════════════════════════════
    if fmt == 'xlsx':
        wb = openpyxl.Workbook()
        ws_sum = wb.active
        ws_sum.title = 'Сводка'

        thin = Side(border_style='thin', color='CCCCCC')
        bd   = Border(left=thin, right=thin, top=thin, bottom=thin)
        alt_fill = PatternFill('solid', fgColor='F9F9F9')

        def _xhdr(ws, row, col, val, fg='2C3E50', sz=10):
            c = ws.cell(row=row, column=col, value=val)
            c.font = XFont(bold=True, color='000000', size=sz)
            c.fill = PatternFill('solid', fgColor='FFFFFF')
            c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            c.border = bd
            return c

        # ─ строки 1-3: шапка ─
        ws_sum.merge_cells('A1:F1')
        c = ws_sum['A1']
        c.value = f'ОТЧЁТ ПО ТЕПЛОВЫМ АНОМАЛИЯМ — {date_ru}'
        c.font = XFont(bold=True, size=14, color='000000')
        c.fill = PatternFill('solid', fgColor='FFFFFF')
        c.alignment = Alignment(horizontal='center', vertical='center')
        ws_sum.row_dimensions[1].height = 30

        ws_sum.merge_cells('A2:F2')
        ws_sum['A2'].value = (f'Период: {time_from} – {time_to} UTC  |  Спутник: {sat_label}  |'
                              f'  Аномалий в лесхозах: {total_in_by} из {total_all}')
        ws_sum['A2'].font = XFont(italic=True, size=10, color='000000')
        ws_sum['A2'].alignment = Alignment(horizontal='center')

        # ─ шапка таблицы (строка 4) ─
        headers = ['Лесхоз', 'Код', 'Кол-во аномалий', 'Доля %',
                   'Макс. температура (K)', 'Макс. FRP (МВт)']
        col_w   = [42, 10, 18, 10, 22, 18]
        for ci, (h, w) in enumerate(zip(headers, col_w), 1):
            _xhdr(ws_sum, 4, ci, h)
            ws_sum.column_dimensions[get_column_letter(ci)].width = w
        ws_sum.row_dimensions[4].height = 32

        # ─ данные ─
        for ri, (name, info) in enumerate(sorted_groups, 5):
            pts = info['points']
            max_temp = max((p['temp'] for p in pts if p['temp']), default=None)
            max_frp  = max((p['frp']  for p in pts if p['frp']),  default=None)
            pct = round(len(pts) / total_in_by * 100, 1) if total_in_by else 0
            row_vals = [
                name, info['code'], len(pts), f'{pct}%',
                f'{max_temp:.1f}' if max_temp else '-',
                f'{max_frp:.2f}'  if max_frp  else '-',
            ]
            fill = alt_fill if ri % 2 == 0 else PatternFill()
            for ci, val in enumerate(row_vals, 1):
                cell = ws_sum.cell(row=ri, column=ci, value=val)
                cell.border = bd
                cell.alignment = Alignment(
                    horizontal='left' if ci == 1 else 'center', vertical='center')
                cell.fill = fill
                if ci == 3:
                    cell.font = XFont(bold=True, color='000000')

        # ─ итоговая строка ─
        lr = 5 + len(sorted_groups)
        ws_sum.merge_cells(f'A{lr}:B{lr}')
        for ci in range(1, 7):
            cell = ws_sum.cell(row=lr, column=ci)
            cell.fill = PatternFill('solid', fgColor='D4EDDA')
            cell.font = XFont(bold=True, color='000000')
            cell.border = bd
            cell.alignment = Alignment(horizontal='center', vertical='center')
        ws_sum['A' + str(lr)].value = 'ИТОГО'
        ws_sum.cell(row=lr, column=3).value = total_in_by

        # ─ блок статистики по степеням ─
        br = lr + 2  # начало блока, отступ 1 строка
        ws_sum.merge_cells(f'A{br}:F{br}')
        ws_sum[f'A{br}'].value = 'СТАТИСТИКА ПО СТЕПЕНЯМ ИНТЕНСИВНОСТИ'
        ws_sum[f'A{br}'].font = XFont(bold=True, size=11, color='000000')
        ws_sum[f'A{br}'].alignment = Alignment(horizontal='center', vertical='center')
        ws_sum[f'A{br}'].border = bd
        ws_sum.row_dimensions[br].height = 22

        bkt_hdr_row = br + 1
        for ci, h in enumerate(['Степень', 'Диапазон температур', 'Кол-во аномалий', 'Доля %', '', ''], 1):
            c = ws_sum.cell(row=bkt_hdr_row, column=ci, value=h)
            c.font = XFont(bold=True, color='000000', size=10)
            c.fill = PatternFill('solid', fgColor='FFFFFF')
            c.alignment = Alignment(horizontal='center', vertical='center')
            c.border = bd

        for bi, (label, rng, clr, cnt) in enumerate(
                zip(BUCKET_LABELS, BUCKET_RANGES, BUCKET_COLORS_HEX, bucket_counts), bkt_hdr_row + 1):
            pct = round(cnt / total_in_by * 100, 1) if total_in_by else 0
            row_data = [label, rng, cnt, f'{pct}%', '', '']
            for ci, val in enumerate(row_data, 1):
                c = ws_sum.cell(row=bi, column=ci, value=val)
                c.border = bd
                c.alignment = Alignment(horizontal='left' if ci == 1 else 'center', vertical='center')
                c.fill = alt_fill if bi % 2 == 0 else PatternFill()
            # Цветная точка — заливка ячейки A цветом степени
            dot_cell = ws_sum.cell(row=bi, column=1)
            dot_cell.fill = PatternFill('solid', fgColor=clr)
            dot_cell.font = XFont(bold=True, color='000000' if bi <= bkt_hdr_row + 2 else '000000')

        # ─ листы по лесхозам ─
        pt_headers = ['№', 'Широта', 'Долгота', 'Температура (K)',
                      'FRP (МВт)', 'Спутник', 'Дата/время UTC']
        pt_col_w   = [5, 14, 14, 18, 14, 14, 22]

        for name, info in sorted_groups:
            pts = info['points']
            sn = (name[:28]
                  .replace('/', '-').replace('\\', '-')
                  .replace('*', '').replace('?', '')
                  .replace('[', '').replace(']', '').replace(':', ''))
            ws = wb.create_sheet(title=sn)

            ws.merge_cells('A1:G1')
            ws['A1'].value = name
            ws['A1'].font  = XFont(bold=True, size=13, color='000000')
            ws['A1'].fill  = PatternFill('solid', fgColor='FFFFFF')
            ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
            ws.row_dimensions[1].height = 26

            ws.merge_cells('A2:G2')
            ws['A2'].value = (f'Аномалий: {len(pts)}  |  Код: {info["code"]}  |  Дата: {date_ru}')
            ws['A2'].font  = XFont(italic=True, size=10, color='000000')
            ws['A2'].alignment = Alignment(horizontal='center')

            for ci, (h, w) in enumerate(zip(pt_headers, pt_col_w), 1):
                _xhdr(ws, 4, ci, h, fg='2C3E50')
                ws.column_dimensions[get_column_letter(ci)].width = w
            ws.row_dimensions[4].height = 28

            for ri, p in enumerate(pts, 5):
                row_vals = [
                    ri - 4,
                    f'{p["lat"]:.5f}', f'{p["lon"]:.5f}',
                    f'{p["temp"]:.1f}' if p['temp'] else '-',
                    f'{p["frp"]:.2f}'  if p['frp']  else '-',
                    p['satellite'], p['dt']
                ]
                fill = alt_fill if ri % 2 == 0 else PatternFill()
                for ci, val in enumerate(row_vals, 1):
                    cell = ws.cell(row=ri, column=ci, value=val)
                    cell.border = bd
                    cell.alignment = Alignment(horizontal='center', vertical='center')
                    cell.fill = fill
                # Раскраска температуры
                if p['temp']:
                    t = p['temp']
                    clr = ('FFE082' if t < 300 else 'FFD54F' if t < 315 else
                           'FFB300' if t < 330 else 'FF7043' if t < 345 else
                           'E53935' if t < 360 else 'B71C1C')
                    tc = ws.cell(row=ri, column=4)
                    tc.fill = PatternFill('solid', fgColor=clr)
                    tc.font = XFont(bold=True, color='000000' if t < 330 else '000000')

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return buf.read(), f'anomalii_{date}.xlsx', \
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    # ════════════════════════════════════════════
    # 6b. PDF
    # ════════════════════════════════════════════
    else:
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4,
                                leftMargin=1.5*cm, rightMargin=1.5*cm,
                                topMargin=1.5*cm, bottomMargin=1.5*cm)
        story = []

        def _p(text, size=10, bold=False, color=colors.black, align='LEFT'):
            # Экранируем спецсимволы XML для Paragraph
            safe = (str(text)
                    .replace('&', '&amp;')
                    .replace('<', '&lt;')
                    .replace('>', '&gt;'))
            use_fn = fnb if bold else fn
            style = ParagraphStyle(
                'dyn', fontName=use_fn, fontSize=size,
                textColor=color, leading=size * 1.45,
                alignment={'LEFT': 0, 'CENTER': 1, 'RIGHT': 2}.get(align, 0),
                spaceAfter=2)
            return Paragraph(safe, style)

        def _cell(text, bold=False):
            """Ячейка таблицы с кириллическим шрифтом."""
            safe = (str(text)
                    .replace('&', '&amp;')
                    .replace('<', '&lt;')
                    .replace('>', '&gt;'))
            use_fn = fnb if bold else fn
            style = ParagraphStyle('tc', fontName=use_fn, fontSize=8,
                                   leading=10, spaceAfter=0)
            return Paragraph(safe, style)

        # ── Заголовок ──
        story.append(_p('ОТЧЁТ ПО ТЕПЛОВЫМ АНОМАЛИЯМ', 18, bold=True,
                        color=colors.black, align='CENTER'))
        story.append(Spacer(1, 5))
        story.append(_p(f'Дата: {date_ru}   |   Период: {time_from}–{time_to} UTC   |   Спутник: {sat_label}',
                        10, color=colors.black, align='CENTER'))
        story.append(_p(f'Аномалий в лесхозах Беларуси: {total_in_by}  (всего за дату: {total_all})',
                        11, bold=True, align='CENTER'))
        story.append(Spacer(1, 8))
        story.append(HRFlowable(width='100%', thickness=2, color=colors.HexColor('#CCCCCC')))
        story.append(Spacer(1, 10))

        # ── Сводная таблица ──
        story.append(_p('СВОДКА ПО ЛЕСХОЗАМ', 12, bold=True,
                        color=colors.black))
        story.append(Spacer(1, 5))

        sum_data = [[_cell('Лесхоз', bold=True),
                     _cell('Код', bold=True),
                     _cell('Аномалий', bold=True),
                     _cell('Доля %', bold=True),
                     _cell('Макс. T (K)', bold=True),
                     _cell('Макс FRP', bold=True)]]
        for name, info in sorted_groups:
            pts = info['points']
            max_temp = max((p['temp'] for p in pts if p['temp']), default=None)
            max_frp  = max((p['frp']  for p in pts if p['frp']),  default=None)
            pct = round(len(pts) / total_in_by * 100, 1) if total_in_by else 0
            sum_data.append([
                _cell(name),
                _cell(info['code']),
                _cell(str(len(pts)), bold=True),
                _cell(f'{pct}%'),
                _cell(f'{max_temp:.1f}' if max_temp else '-'),
                _cell(f'{max_frp:.2f}'  if max_frp  else '-'),
            ])
        sum_data.append([
            _cell('ИТОГО', bold=True), _cell(''),
            _cell(str(total_in_by), bold=True),
            _cell('100%'), _cell(''), _cell('')
        ])

        col_w_pdf = [7.2*cm, 1.6*cm, 2.0*cm, 1.6*cm, 2.4*cm, 2.0*cm]
        t = Table(sum_data, colWidths=col_w_pdf, repeatRows=1)
        t.setStyle(TableStyle([
            ('BACKGROUND',    (0, 0),  (-1, 0),  colors.white),
            ('BACKGROUND',    (0, -1), (-1, -1), colors.HexColor('#D4EDDA')),
            ('ROWBACKGROUNDS',(0, 1),  (-1, -2),
             [colors.white, colors.HexColor('#F5F5F5')]),
            ('TEXTCOLOR',     (0, 0),  (-1, -1), colors.black),
            ('ALIGN',         (0, 0),  (-1, -1), 'CENTER'),
            ('ALIGN',         (0, 1),  (0,  -1), 'LEFT'),
            ('GRID',          (0, 0),  (-1, -1), 0.5, colors.HexColor('#CCCCCC')),
            ('TOPPADDING',    (0, 0),  (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0),  (-1, -1), 5),
            ('LEFTPADDING',   (0, 0),  (-1, -1), 6),
            ('RIGHTPADDING',  (0, 0),  (-1, -1), 6),
        ]))
        story.append(t)
        story.append(Spacer(1, 14))

        # ── Статистика по степеням интенсивности ──
        story.append(_p('СТАТИСТИКА ПО СТЕПЕНЯМ ИНТЕНСИВНОСТИ', 12, bold=True, color=colors.black))
        story.append(Spacer(1, 5))

        bkt_data = [[_cell('Степень', bold=True), _cell('Диапазон', bold=True),
                     _cell('Кол-во', bold=True), _cell('Доля %', bold=True)]]
        bkt_row_colors = []
        for bi, (label, rng, clr_hex, cnt) in enumerate(
                zip(BUCKET_LABELS, BUCKET_RANGES, BUCKET_COLORS_HEX, bucket_counts)):
            pct = round(cnt / total_in_by * 100, 1) if total_in_by else 0
            bkt_data.append([_cell(label, bold=True), _cell(rng), _cell(str(cnt), bold=True), _cell(f'{pct}%')])
            bkt_row_colors.append(colors.HexColor('#' + clr_hex))

        bkt_col_w = [4.5*cm, 3.5*cm, 2.5*cm, 2.0*cm]
        tb = Table(bkt_data, colWidths=bkt_col_w, repeatRows=1)
        bkt_style = [
            ('BACKGROUND', (0, 0), (-1, 0), colors.white),
            ('TEXTCOLOR',  (0, 0), (-1, -1), colors.black),
            ('ALIGN',      (0, 0), (-1, -1), 'CENTER'),
            ('ALIGN',      (0, 1), (0, -1),  'LEFT'),
            ('GRID',       (0, 0), (-1, -1), 0.5, colors.HexColor('#CCCCCC')),
            ('TOPPADDING',    (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('LEFTPADDING',   (0, 0), (-1, -1), 6),
            ('RIGHTPADDING',  (0, 0), (-1, -1), 6),
        ]
        for bi, clr in enumerate(bkt_row_colors, 1):
            bkt_style.append(('BACKGROUND', (0, bi), (0, bi), clr))
            bkt_style.append(('TEXTCOLOR',  (0, bi), (0, bi), colors.black))
        tb.setStyle(TableStyle(bkt_style))
        story.append(tb)
        story.append(Spacer(1, 14))

        # ── Детальные страницы по лесхозам ──
        for name, info in sorted_groups:
            pts = info['points']
            story.append(PageBreak())
            story.append(_p(name, 14, bold=True, color=colors.black))
            story.append(_p(
                f'Код: {info["code"]}   |   Аномалий: {len(pts)}   |   Дата: {date_ru}',
                9, color=colors.black))
            story.append(Spacer(1, 5))
            story.append(HRFlowable(width='100%', thickness=1,
                                    color=colors.HexColor('#CCCCCC')))
            story.append(Spacer(1, 7))

            det_data = [[
                _cell('№', bold=True), _cell('Широта', bold=True),
                _cell('Долгота', bold=True), _cell('Темп. (K)', bold=True),
                _cell('FRP (МВт)', bold=True), _cell('Спутник', bold=True),
                _cell('Дата/Время UTC', bold=True)
            ]]
            for i, p in enumerate(pts, 1):
                det_data.append([
                    _cell(str(i)),
                    _cell(f'{p["lat"]:.5f}'), _cell(f'{p["lon"]:.5f}'),
                    _cell(f'{p["temp"]:.1f}' if p['temp'] else '-'),
                    _cell(f'{p["frp"]:.2f}'  if p['frp']  else '-'),
                    _cell(p['satellite']), _cell(p['dt'])
                ])

            col_w_det = [0.7*cm, 2.7*cm, 2.7*cm, 2.3*cm, 2.1*cm, 2.0*cm, 4.3*cm]
            td = Table(det_data, colWidths=col_w_det, repeatRows=1)
            td.setStyle(TableStyle([
                ('BACKGROUND',    (0, 0),  (-1, 0), colors.white),
                ('ROWBACKGROUNDS',(0, 1),  (-1, -1),
                 [colors.white, colors.HexColor('#F5F5F5')]),
                ('TEXTCOLOR',     (0, 0),  (-1, -1), colors.black),
                ('ALIGN',         (0, 0),  (-1, -1), 'CENTER'),
                ('GRID',          (0, 0),  (-1, -1), 0.4, colors.HexColor('#DDDDDD')),
                ('TOPPADDING',    (0, 0),  (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0),  (-1, -1), 4),
                ('LEFTPADDING',   (0, 0),  (-1, -1), 4),
                ('RIGHTPADDING',  (0, 0),  (-1, -1), 4),
            ]))
            story.append(td)

        doc.build(story)
        buf.seek(0)
        return buf.read(), f'anomalii_{date}.pdf', 'application/pdf'


@app.get("/api/hotspots/report")
async def api_hotspots_report(
    date: str = Query(default=""),
    time_from: str = Query(default="00:00"),
    time_to: str = Query(default="23:59"),
    satellite: str = Query(default="all"),
    fmt: str = Query(default="pdf"),
):
    if not date:
        date = datetime.utcnow().strftime('%Y-%m-%d')
    try:
        datetime.strptime(date, '%Y-%m-%d')
    except ValueError:
        raise HTTPException(400, f"Неверный формат даты: {date}")

    fmt = fmt.lower()
    if fmt not in ('pdf', 'xlsx'):
        raise HTTPException(400, "fmt должен быть pdf или xlsx")

    sat = satellite if satellite and satellite.lower() != 'all' else None

    try:
        data, filename, media_type = await run_in_threadpool(
            _build_hotspots_report, date, time_from, time_to, sat, fmt
        )
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Ошибка генерации отчёта: {e}")

    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        }
    )


# ==========================================
# ИНТЕГРАЦИЯ ARCGIS — SHP / WFS / СИНХРОНИЗАЦИЯ
# ==========================================
# fiona не используется напрямую — SHP-экспорт выполняется через geopandas (gpd.to_file)

# ── Конфиг ArcGIS из .env ───────────────────────────────────────────────────
ARCGIS_SERVER_URL   = os.getenv('ARCGIS_SERVER_URL', '').rstrip('/')
ARCGIS_SERVICE_NAME = os.getenv('ARCGIS_SERVICE_NAME', 'ForestGIS/VectorLayers')
ARCGIS_USER         = os.getenv('ARCGIS_USER', '')
ARCGIS_PASSWORD     = os.getenv('ARCGIS_PASSWORD', '')
PORTAL_BASE_URL     = os.getenv('PORTAL_BASE_URL', 'http://192.168.12.97').rstrip('/')

# ── ArcGIS REST Token кэш ───────────────────────────────────────────────────
_arcgis_token_cache: dict = {"token": None, "expires": 0}
_arcgis_token_lock = threading.Lock()

def _get_arcgis_token():
    if not ARCGIS_SERVER_URL or not ARCGIS_USER:
        return None
    with _arcgis_token_lock:
        now = time.time()
        if _arcgis_token_cache["token"] and now < _arcgis_token_cache["expires"] - 60:
            return _arcgis_token_cache["token"]
        try:
            token_url = f"{ARCGIS_SERVER_URL}/tokens/generateToken"
            resp = requests.post(token_url, data={
                "username": ARCGIS_USER, "password": ARCGIS_PASSWORD,
                "client": "requestip", "expiration": 120, "f": "json",
            }, timeout=10)
            data = resp.json()
            if "token" in data:
                _arcgis_token_cache["token"]   = data["token"]
                _arcgis_token_cache["expires"] = now + data.get("expires", 7200) / 1000
                logger.info("[ArcGIS] Токен обновлён")
                return data["token"]
        except Exception as e:
            logger.warning(f"[ArcGIS] Токен: {e}")
    return None

# ── SSE очередь синхронизации ───────────────────────────────────────────────
_sync_subscribers: list = []
_sync_lock_sse = threading.Lock()

def _broadcast_sync_event(event_type: str, entity_id: int, data: dict):
    import asyncio
    payload = json.dumps({
        "type": event_type, "id": entity_id,
        "data": data, "source": "server",
        "ts": datetime.utcnow().isoformat(),
    })
    with _sync_lock_sse:
        dead = []
        for q in _sync_subscribers:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            _sync_subscribers.remove(q)

# ── Лог синхронизации ───────────────────────────────────────────────────────
_sync_log: list = []
_sync_log_lock = threading.Lock()

def _log_sync(event: str, details: dict):
    entry = {"ts": datetime.utcnow().isoformat(), "event": event, **details}
    with _sync_log_lock:
        _sync_log.append(entry)
        if len(_sync_log) > 200:
            _sync_log.pop(0)

# ─────────────────────────────────────────────────────────────────────────────
# SHP ЭКСПОРТ
# ─────────────────────────────────────────────────────────────────────────────

def _vector_layer_to_shp_bytes(layer_id: int, db: Session):
    row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise ValueError(f"Слой {layer_id} не найден")
    geojson = row.geojson_data
    if not geojson:
        raise ValueError("Слой пустой (нет геометрии)")

    gdf = gpd.GeoDataFrame.from_features(geojson.get("features", []), crs="EPSG:4326")
    if gdf.empty:
        raise ValueError("Нет объектов в слое")

    # Транслит кириллических имён колонок (SHP не поддерживает)
    rename_map = {}
    for col in gdf.columns:
        if col == "geometry":
            continue
        try:
            new_name = translit(col, 'ru', reversed=True)
        except Exception:
            new_name = col
        new_name = re.sub(r'[^A-Za-z0-9_]', '_', new_name)[:10]
        if new_name != col:
            rename_map[col] = new_name
    if rename_map:
        gdf = gdf.rename(columns=rename_map)

    # Обрезаем строки до 254 символов (ограничение DBF)
    for col in gdf.select_dtypes(include='object').columns:
        gdf[col] = gdf[col].astype(str).str[:254]

    safe_name = re.sub(r'[^\w\-]', '_', row.name)[:40]

    with tempfile.TemporaryDirectory(dir=CUSTOM_TEMP_DIR) as tmp:
        shp_path = os.path.join(tmp, f"{safe_name}.shp")
        gdf.to_file(shp_path, driver='ESRI Shapefile', encoding='UTF-8')

        # .prj — WGS84 (стандарт для ArcGIS)
        prj_content = (
            'GEOGCS["GCS_WGS_1984",'
            'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
            'PRIMEM["Greenwich",0.0],'
            'UNIT["Degree",0.0174532925199433]]'
        )
        with open(shp_path.replace('.shp', '.prj'), 'w') as f:
            f.write(prj_content)
        with open(shp_path.replace('.shp', '.cpg'), 'w') as f:
            f.write('UTF-8')

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for ext in ['shp', 'shx', 'dbf', 'prj', 'cpg']:
                fpath = shp_path.replace('.shp', f'.{ext}')
                if os.path.exists(fpath):
                    zf.write(fpath, f"{safe_name}.{ext}")
        zip_buf.seek(0)
        return zip_buf.read(), safe_name


@app.get("/api/vector/{layer_id}/download/shp")
async def api_download_shp(layer_id: int, db: Session = Depends(get_db)):
    """Скачать SHP-архив векторного слоя (для ArcGIS / QGIS)."""
    try:
        data, name = await run_in_threadpool(_vector_layer_to_shp_bytes, layer_id, db)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        logger.error(f"[SHP export] {e}")
        raise HTTPException(500, f"Ошибка экспорта: {e}")
    return Response(
        content=data, media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name}.zip"',
            "Content-Length": str(len(data)),
        }
    )


@app.get("/api/vector/all/download/shp")
async def api_download_all_shp(db: Session = Depends(get_db)):
    """Скачать все векторные слои одним ZIP-архивом."""
    def _build():
        rows = db.query(VectorLayer).all()
        if not rows:
            raise ValueError("Нет векторных слоёв")
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for row in rows:
                if not row.geojson_data:
                    continue
                try:
                    data, name = _vector_layer_to_shp_bytes(row.id, db)
                    inner = zipfile.ZipFile(io.BytesIO(data))
                    for inner_name in inner.namelist():
                        zf.writestr(f"{name}/{inner_name}", inner.read(inner_name))
                except Exception as e:
                    logger.warning(f"[SHP export all] Слой {row.id}: {e}")
        zip_buf.seek(0)
        return zip_buf.read()
    try:
        data = await run_in_threadpool(_build)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
    ts = datetime.now().strftime('%Y%m%d_%H%M')
    return Response(
        content=data, media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="vectors_{ts}.zip"',
            "Content-Length": str(len(data)),
        }
    )

# ─────────────────────────────────────────────────────────────────────────────
# WFS 1.1.0 — для прямого подключения из ArcGIS Desktop / Pro
# ArcGIS: Add Data → GIS Server → WFS Server
# [F] SECURITY: внутренний адрес GeoServer убран из комментариев клиентского кода
# ─────────────────────────────────────────────────────────────────────────────

WFS_NAMESPACE = "http://forestgis.by/wfs"
WFS_PREFIX    = "fgis"


def _wfs_capabilities(db: Session) -> str:
    # [PERF v16] только id и имя — раньше вытягивались GeoJSON ВСЕХ слоёв (мегабайты) ради заголовков
    layers = db.query(VectorLayer.id, VectorLayer.name).all()
    feature_types = ""
    for lyr in layers:
        safe = re.sub(r'[^\w]', '_', lyr.name or '')
        feature_types += f"""
        <FeatureType>
            <Name>{WFS_PREFIX}:{safe}</Name>
            <Title>{_sh.xml_text(lyr.name)}</Title>
            <DefaultSRS>EPSG:4326</DefaultSRS>
            <OutputFormats>
                <Format>application/json</Format>
                <Format>text/xml; subtype=gml/3.1.1</Format>
            </OutputFormats>
            <ows:WGS84BoundingBox>
                <ows:LowerCorner>23.178 51.237</ows:LowerCorner>
                <ows:UpperCorner>32.776 56.172</ows:UpperCorner>
            </ows:WGS84BoundingBox>
        </FeatureType>"""

    feature_types += f"""
        <FeatureType>
            <Name>{WFS_PREFIX}:imagery_footprints</Name>
            <Title>Контуры съёмки ДЗЗ</Title>
            <DefaultSRS>EPSG:4326</DefaultSRS>
            <OutputFormats>
                <Format>application/json</Format>
            </OutputFormats>
            <ows:WGS84BoundingBox>
                <ows:LowerCorner>23.178 51.237</ows:LowerCorner>
                <ows:UpperCorner>32.776 56.172</ows:UpperCorner>
            </ows:WGS84BoundingBox>
        </FeatureType>"""

    base = PORTAL_BASE_URL
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<WFS_Capabilities version="1.1.0"
    xmlns="http://www.opengis.net/wfs"
    xmlns:ows="http://www.opengis.net/ows"
    xmlns:ogc="http://www.opengis.net/ogc"
    xmlns:xlink="http://www.w3.org/1999/xlink"
    xmlns:{WFS_PREFIX}="{WFS_NAMESPACE}">
  <ows:ServiceIdentification>
    <ows:Title>Forest GIS WFS — ОДЗиМЛ</ows:Title>
    <ows:Abstract>Геопортал лесного хозяйства — WFS слои для ArcGIS</ows:Abstract>
    <ows:ServiceType>WFS</ows:ServiceType>
    <ows:ServiceTypeVersion>1.1.0</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="{base}/wfs"/>
        <ows:Post xlink:href="{base}/wfs"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="DescribeFeatureType">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="{base}/wfs"/>
        <ows:Post xlink:href="{base}/wfs"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP>
        <ows:Get xlink:href="{base}/wfs"/>
        <ows:Post xlink:href="{base}/wfs"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="Transaction">
      <ows:DCP><ows:HTTP>
        <ows:Post xlink:href="{base}/wfs"/>
      </ows:HTTP></ows:DCP>
    </ows:Operation>
  </ows:OperationsMetadata>
  <FeatureTypeList>
    <Operations>
      <Operation>Query</Operation>
      <Operation>Insert</Operation>
      <Operation>Update</Operation>
      <Operation>Delete</Operation>
    </Operations>
    {feature_types}
  </FeatureTypeList>
</WFS_Capabilities>"""


def _wfs_describe(type_name: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:{WFS_PREFIX}="{WFS_NAMESPACE}"
    targetNamespace="{WFS_NAMESPACE}" elementFormDefault="qualified">
  <xsd:complexType name="{type_name}Type">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType"
          xmlns:gml="http://www.opengis.net/gml">
        <xsd:sequence>
          <xsd:element name="geom"  type="gml:GeometryPropertyType" minOccurs="0"/>
          <xsd:element name="id"    type="xsd:integer" minOccurs="0"/>
          <xsd:element name="name"  type="xsd:string"  minOccurs="0"/>
          <xsd:element name="color" type="xsd:string"  minOccurs="0"/>
          <xsd:element name="updated_at" type="xsd:string" minOccurs="0"/>
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
</xsd:schema>"""


def _wfs_get_feature(type_name: str, db: Session, bbox: str = None, max_features: int = 5000) -> str:
    if type_name.endswith("imagery_footprints"):
        q = db.query(Imagery).filter(Imagery.geom.isnot(None))
        if bbox:
            try:
                minx, miny, maxx, maxy = map(float, bbox.split(','))
                env = func.ST_MakeEnvelope(minx, miny, maxx, maxy, 4326)
                q = q.filter(func.ST_Intersects(Imagery.geom, env))
            except Exception:
                pass
        rows = q.limit(max_features).all()
        features = []
        for r in rows:
            geom = to_shape(r.geom) if r.geom else None
            if geom:
                features.append({
                    "type": "Feature",
                    "id": f"imagery_footprints.{r.id}",
                    "geometry": mapping(geom),
                    "properties": {
                        "id": r.id, "filename": r.filename,
                        "leskhoz_id": r.leskhoz_id, "leskhoz_name": r.leskhoz_name,
                        "date_shot": r.date_shot, "equipment": r.equipment,
                        "organization": r.organization, "contract_num": r.contract_num,
                        "survey_type": r.survey_type,
                    }
                })
        return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)

    local_name = type_name.split(":")[-1]
    # [PERF v16] сначала ищем слой по лёгким колонкам, GeoJSON грузим только найденного
    match_id = None
    for _id, _name in db.query(VectorLayer.id, VectorLayer.name).all():
        if re.sub(r'[^\w]', '_', _name or '') == local_name or str(_id) == local_name:
            match_id = _id
            break
    row = db.query(VectorLayer).filter(VectorLayer.id == match_id).first() if match_id is not None else None
    if row is not None:
        gj = row.geojson_data or {"type": "FeatureCollection", "features": []}
        for f in gj.get("features", []):
            f.setdefault("properties", {})
            f["properties"]["_layer_id"]   = row.id
            f["properties"]["_layer_name"] = row.name
        return json.dumps(gj, ensure_ascii=False)

    return json.dumps({"type": "FeatureCollection", "features": []})


def _wfs_transaction(body: bytes, db: Session) -> str:
    try:
        root = _sh.parse_xml_safely(body)  # [SEC v16] без DOCTYPE/ENTITY: XXE и «billion laughs»
    except (_sh.UnsafeXML, ET.ParseError, Exception):
        return '<TransactionResponse><TransactionSummary><totalInserted>0</totalInserted></TransactionSummary></TransactionResponse>'

    inserted = updated = deleted = 0

    for child in root:
        tag = child.tag.split('}')[-1].lower()

        if tag == "insert":
            for feature_el in child:
                try:
                    props = {}
                    for el in feature_el:
                        local = el.tag.split('}')[-1]
                        if local not in ('geom', 'geometry', 'the_geom'):
                            props[local] = el.text
                    name  = props.pop('name', 'Imported')
                    color = props.pop('color', '#3388ff')
                    new_layer = VectorLayer(
                        name=name, color=color,
                        geojson_data={"type": "FeatureCollection", "features": []}
                    )
                    db.add(new_layer)
                    db.flush()
                    inserted += 1
                    _broadcast_sync_event("insert", new_layer.id, {})
                except Exception as e:
                    logger.warning(f"[WFS-T insert] {e}")

        elif tag == "update":
            filter_el = child.find('{http://www.opengis.net/ogc}Filter')
            layer_id = None
            if filter_el is not None:
                for id_tag in ('GmlObjectId', 'FeatureId'):
                    id_el = filter_el.find(f'{{http://www.opengis.net/ogc}}{id_tag}')
                    if id_el is not None:
                        fid = id_el.get('fid') or id_el.get('id', '')
                        try:
                            layer_id = int(fid.split('.')[-1])
                        except Exception:
                            pass
                        break
            props = {}
            for prop_el in child.findall('{http://www.opengis.net/wfs}Property'):
                ne = prop_el.find('{http://www.opengis.net/wfs}Name')
                ve = prop_el.find('{http://www.opengis.net/wfs}Value')
                if ne is not None and ve is not None:
                    props[ne.text] = ve.text
            if layer_id:
                row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
                if row:
                    if 'name'  in props: row.name  = props['name']
                    if 'color' in props: row.color = props['color']
                    db.flush()
                    updated += 1
                    _broadcast_sync_event("update", layer_id, props)

        elif tag == "delete":
            filter_el = child.find('{http://www.opengis.net/ogc}Filter')
            if filter_el is not None:
                for id_el in filter_el.findall('.//{http://www.opengis.net/ogc}FeatureId'):
                    fid = id_el.get('fid', '')
                    try:
                        lid = int(fid.split('.')[-1])
                        row = db.query(VectorLayer).filter(VectorLayer.id == lid).first()
                        if row:
                            db.delete(row)
                            db.flush()
                            deleted += 1
                            _broadcast_sync_event("delete", lid, {})
                    except Exception as e:
                        logger.warning(f"[WFS-T delete] {e}")

    db.commit()
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<wfs:TransactionResponse version="1.1.0" xmlns:wfs="http://www.opengis.net/wfs">
  <wfs:TransactionSummary>
    <wfs:totalInserted>{inserted}</wfs:totalInserted>
    <wfs:totalUpdated>{updated}</wfs:totalUpdated>
    <wfs:totalDeleted>{deleted}</wfs:totalDeleted>
  </wfs:TransactionSummary>
</wfs:TransactionResponse>"""


@app.get("/wfs")
@app.post("/wfs")
async def wfs_endpoint(
    request: Request,
    db: Session = Depends(get_db),
    service:     str = Query(default="WFS"),
    REQUEST:     str = Query(default="GetCapabilities", alias="request"),
    TYPENAME:    str = Query(default="",   alias="typeName"),
    BBOX:        str = Query(default="",   alias="bbox"),
    MAXFEATURES: int = Query(default=5000, alias="maxFeatures"),
    OUTPUTFORMAT:str = Query(default="application/json", alias="outputFormat"),
):
    """
    OGC WFS 1.1.0 — подключение из ArcGIS Desktop / Pro / QGIS.

    ArcGIS Desktop:  Add Data → GIS Server → WFS Server
    URL: http://192.168.12.97/wfs?service=WFS&request=GetCapabilities

    ArcGIS Pro:  Insert → Connections → New WFS Server Connection
    URL: http://192.168.12.97/wfs
    """
    req_type = REQUEST.upper()
    MAXFEATURES = max(1, min(int(MAXFEATURES or 1), int(os.getenv("GEO_DESKTOP_WFS_MAX", "20000"))))

    if req_type == "GETCAPABILITIES":
        xml = await run_in_threadpool(_wfs_capabilities, db)
        return Response(xml, media_type="text/xml; charset=utf-8",
                        headers={})

    if req_type == "DESCRIBEFEATURETYPE":
        local = TYPENAME.split(":")[-1] if TYPENAME else "VectorLayer"
        return Response(_wfs_describe(local), media_type="text/xml; charset=utf-8")

    if req_type == "GETFEATURE":
        geojson_str = await run_in_threadpool(
            _wfs_get_feature, TYPENAME, db, BBOX or None, MAXFEATURES
        )
        return Response(geojson_str, media_type="application/json; charset=utf-8",
                        headers={})

    if req_type == "TRANSACTION":
        # [SEC v16] Раньше транзакции (создание/изменение/УДАЛЕНИЕ слоёв) принимались
        # от любого анонимного клиента. Теперь — администратор или WFS_T_USER/WFS_T_TOKEN.
        _ok, _code, _why = _sh.wfs_transaction_allowed(request, bool(get_current_user(request)))
        if not _ok:
            _hdr = {"WWW-Authenticate": 'Basic realm="WFS-T"'} if _code == 401 else {}
            return Response(f'<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows"><ows:Exception exceptionCode="{_code}"><ows:ExceptionText>{_sh.xml_text(_why)}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>',
                            status_code=_code, media_type="text/xml; charset=utf-8", headers=_hdr)
        body = await request.body()
        result_xml = await run_in_threadpool(_wfs_transaction, body, db)
        _vectors_cache_invalidate()
        return Response(result_xml, media_type="text/xml; charset=utf-8")

    # [SEC v16] параметр больше не вставляется в XML как есть (отражённая XSS/XML-инъекция)
    return Response(f"<e>Unknown WFS request: {_sh.xml_text(REQUEST[:64])}</e>",
                    status_code=400, media_type="text/xml")

# ─────────────────────────────────────────────────────────────────────────────
# SSE — ДВУСТОРОННЯЯ СИНХРОНИЗАЦИЯ (геопортал ↔ ArcGIS в реальном времени)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/sync/stream")
async def sync_sse_stream(request: Request):
    """
    Server-Sent Events: браузер слушает изменения от ArcGIS в реальном времени.
    JS: const es = new EventSource('/api/sync/stream');
        es.onmessage = e => { const ev = JSON.parse(e.data); ... };
    nginx: proxy_buffering off; proxy_read_timeout 3600s;
    """
    import asyncio
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    with _sync_lock_sse:
        # [SEC v16] каждое подключение держит корутину и очередь — без лимита
        # тысячи «вечных» соединений исчерпывали ресурсы процесса
        if len(_sync_subscribers) >= int(os.getenv("SSE_MAX_SUBSCRIBERS", "300")):
            raise HTTPException(503, "Слишком много подключений", headers={"Retry-After": "30"})
        _sync_subscribers.append(q)

    async def event_generator():
        try:
            yield 'data: {"type":"connected"}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            with _sync_lock_sse:
                try:
                    _sync_subscribers.remove(q)
                except ValueError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        }
    )


@app.get("/api/sync/status")
def sync_status(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Статус синхронизации: ArcGIS, кол-во слоёв, последние события."""
    arcgis_ok = False
    if ARCGIS_SERVER_URL:
        try:
            arcgis_ok = bool(_get_arcgis_token())
        except Exception:
            pass
    with _sync_log_lock:
        recent = list(_sync_log[-20:])
    return {
        "arcgis_connected":    arcgis_ok,
        "arcgis_server_url":   ARCGIS_SERVER_URL or None,
        "wfs_url":             f"{PORTAL_BASE_URL}/wfs",
        "wms_url":             f"{PORTAL_BASE_URL}/wms",
        "total_vector_layers": db.query(VectorLayer).count(),
        "total_imagery":       db.query(Imagery).count(),
        "sse_subscribers":     len(_sync_subscribers),
        "recent_events":       recent,
    }


@app.post("/api/sync/push-to-arcgis/{layer_id}")
async def push_layer_to_arcgis(
    layer_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Отправляет слой из геопортала в ArcGIS Feature Service."""
    if not ARCGIS_SERVER_URL:
        raise HTTPException(503, "ARCGIS_SERVER_URL не задан в .env")
    row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row or not row.geojson_data:
        raise HTTPException(404, "Слой не найден или пустой")

    def _push():
        token = _get_arcgis_token()
        base  = f"{ARCGIS_SERVER_URL}/rest/services/{ARCGIS_SERVICE_NAME}/FeatureServer/0"
        requests.post(f"{base}/deleteFeatures",
                      data={"where": f"layer_id={layer_id}", "f": "json", "token": token or ""},
                      timeout=30)
        features = row.geojson_data.get("features", [])
        esri_features = []
        for feat in features:
            props = dict(feat.get("properties") or {})
            props.update({"layer_id": layer_id, "layer_name": row.name,
                          "sync_ts": datetime.utcnow().isoformat()})
            esri_features.append({"geometry": feat.get("geometry"), "attributes": props})
        if esri_features:
            resp = requests.post(f"{base}/addFeatures",
                                 data={"features": json.dumps(esri_features),
                                       "f": "json", "token": token or ""},
                                 timeout=60)
            result = resp.json()
            added = sum(1 for r in result.get("addResults", []) if r.get("success"))
            return {"pushed": added, "total": len(esri_features)}
        return {"pushed": 0, "total": 0}

    try:
        result = await run_in_threadpool(_push)
    except Exception as e:
        raise HTTPException(500, f"Ошибка отправки в ArcGIS: {e}")
    _broadcast_sync_event("pushed_to_arcgis", layer_id, result)
    return {"ok": True, "layer_id": layer_id, **result}


@app.post("/api/sync/pull-from-arcgis/{layer_id}")
async def pull_layer_from_arcgis(
    layer_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Загружает слой из ArcGIS Feature Service на геопортал."""
    if not ARCGIS_SERVER_URL:
        raise HTTPException(503, "ARCGIS_SERVER_URL не задан в .env")

    def _pull():
        token = _get_arcgis_token()
        base  = f"{ARCGIS_SERVER_URL}/rest/services/{ARCGIS_SERVICE_NAME}/FeatureServer/0"
        resp  = requests.get(f"{base}/query",
                             params={"where": f"layer_id={layer_id}", "outFields": "*",
                                     "f": "geojson", "token": token or "",
                                     "returnGeometry": "true"},
                             timeout=30)
        return resp.json()

    try:
        geojson = await run_in_threadpool(_pull)
    except Exception as e:
        raise HTTPException(500, f"Ошибка получения из ArcGIS: {e}")

    if "features" not in geojson:
        raise HTTPException(502, f"Неверный ответ ArcGIS: {geojson}")

    row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise HTTPException(404, "Слой не найден в геопортале")

    for feat in geojson["features"]:
        for key in ("layer_id", "layer_name", "sync_ts", "OBJECTID", "objectid"):
            feat.get("properties", {}).pop(key, None)
    row.geojson_data = geojson
    db.commit()
    _broadcast_sync_event("pulled_from_arcgis", layer_id, {"count": len(geojson["features"])})
    return {"ok": True, "layer_id": layer_id, "features": len(geojson["features"])}


@app.post("/api/sync/webhook")
async def arcgis_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Webhook — ArcGIS уведомляет геопортал об изменениях.
    ArcGIS Server Manager: Webhooks → Add → URL: http://192.168.12.97/api/sync/webhook
    [SEC v16] ARCGIS_WEBHOOK_SECRET в .env → обязателен заголовок X-Webhook-Secret
    (или ?secret=). Всем вкладкам рассылается только тип события и id слоя.
    """
    if not _sh.webhook_secret_ok(request):
        raise HTTPException(401, "Неверный секрет webhook")
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    layer_id = None
    for key in ("layerId", "layer_id", "serviceLayerId"):
        if key in payload:
            try:
                layer_id = int(payload[key])
            except Exception:
                pass
            break
    _broadcast_sync_event("arcgis_change", layer_id or 0, _sh.sanitize_event_payload(payload))
    return {"received": True}


# ── Прямое редактирование объектов (геопортал + ArcGIS Python API) ──────────

def _require_vector_editor(request: Request):
    """[SEC v16] Правка объектов: администратор портала или клиент ArcPy с токеном
    VECTOR_EDIT_TOKEN (заголовок X-Edit-Token). Раньше — любой посетитель."""
    if get_current_user(request):
        return "admin"
    token = os.getenv("VECTOR_EDIT_TOKEN", "")
    got = request.headers.get("X-Edit-Token", "")
    if token and got and _secrets.compare_digest(got, token):
        return "token"
    raise HTTPException(401, "Требуется авторизация")


@app.patch("/api/vector/{layer_id}/feature/{feature_index}")
async def update_feature_geometry(
    layer_id: int, feature_index: int,
    request: Request, db: Session = Depends(get_db),
    _editor=Depends(_require_vector_editor),
):
    """Обновляет геометрию/атрибуты объекта. Вызывается из OpenLayers и ArcPy."""
    body = await request.json()
    row  = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise HTTPException(404, "Слой не найден")
    gj       = row.geojson_data or {"type": "FeatureCollection", "features": []}
    features = gj.get("features", [])
    if feature_index < 0 or feature_index >= len(features):
        raise HTTPException(400, f"Индекс {feature_index} вне диапазона")
    feat = features[feature_index]
    if body.get("geometry"):
        feat["geometry"] = body["geometry"]
    if body.get("properties"):
        feat.setdefault("properties", {}).update(body["properties"])
    row.geojson_data = gj
    db.commit()
    _broadcast_sync_event("feature_updated", layer_id,
                          {"feature_index": feature_index,
                           "source": request.headers.get("X-Client", "unknown")})
    return {"ok": True, "layer_id": layer_id, "feature_index": feature_index}


@app.post("/api/vector/{layer_id}/feature")
async def add_feature(layer_id: int, request: Request, db: Session = Depends(get_db),
                      _editor=Depends(_require_vector_editor)):
    """Добавляет новый объект в слой."""
    body = await request.json()
    row  = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise HTTPException(404, "Слой не найден")
    gj   = row.geojson_data or {"type": "FeatureCollection", "features": []}
    feat = {
        "type": "Feature",
        "geometry":   body.get("geometry"),
        "properties": body.get("properties", {}),
    }
    feat["properties"]["_added_by"] = request.headers.get("X-Client", "portal")
    feat["properties"]["_added_at"] = datetime.utcnow().isoformat()
    gj["features"].append(feat)
    row.geojson_data = gj
    db.commit()
    new_index = len(gj["features"]) - 1
    _broadcast_sync_event("feature_added", layer_id, {"feature_index": new_index})
    return {"ok": True, "layer_id": layer_id, "feature_index": new_index}


@app.delete("/api/vector/{layer_id}/feature/{feature_index}")
def delete_feature(
    layer_id: int, feature_index: int,
    db: Session = Depends(get_db), _: None = Depends(require_admin),
):
    """Удаляет объект из слоя."""
    row = db.query(VectorLayer).filter(VectorLayer.id == layer_id).first()
    if not row:
        raise HTTPException(404, "Слой не найден")
    gj       = row.geojson_data or {"type": "FeatureCollection", "features": []}
    features = gj.get("features", [])
    if feature_index < 0 or feature_index >= len(features):
        raise HTTPException(400, "Индекс вне диапазона")
    features.pop(feature_index)
    row.geojson_data = gj
    db.commit()
    _broadcast_sync_event("feature_deleted", layer_id, {"feature_index": feature_index})
    return {"ok": True}

# ── MAINTENANCE ────────────────────────────────────────────
@app.post("/api/maintenance/on")
async def api_maintenance_on(_=Depends(require_admin)):
    with _maintenance_lock:
        _maintenance["active"]=True; _maintenance["since"]=datetime.now().strftime("%H:%M, %d.%m.%Y"); _maintenance["blocked_visits"]=0
    return {"ok":True,"active":True,"since":_maintenance["since"]}

@app.post("/api/maintenance/off")
async def api_maintenance_off(_=Depends(require_admin)):
    with _maintenance_lock: _maintenance.update({"active":False,"since":None,"blocked_visits":0})
    return {"ok":True,"active":False}

import time

@app.get("/api/maintenance/status")
async def api_maintenance_status(_=Depends(require_admin)): return _maintenance.copy()

@app.get("/maintenance", response_class=HTMLResponse)
async def maintenance_page(request: Request):
    return templates.TemplateResponse(request=request,name="maintenance.html",context={})

# ── ADMIN PAGES ────────────────────────────────────────────
@app.get("/admin/users", response_class=HTMLResponse)
@app.get("/admin_users",  response_class=HTMLResponse)
async def admin_users_page(request: Request, _=Depends(require_admin)):
    # csrf_token — для <meta name="csrf-token">: им подписываются POST из консоли (напр. сезон оформления)
    _csrf = get_csrf_token(request)
    _resp = templates.TemplateResponse(request=request,name="admin_users.html",
                                       context={"is_admin":True,"csrf_token":_csrf})
    # карточка «Сезон оформления» (вкладка «Тех. работы») + кнопка «Сезон» в шапке
    from season_api import inject_admin_card as _inject_season_card
    return _inject_season_card(_resp, _csrf)

@app.get("/frozen", response_class=HTMLResponse)
async def frozen_page(request: Request):
    ip=get_real_ip(request)
    return templates.TemplateResponse(request=request,name="frozen.html",context={"ip":ip},status_code=403)

@app.get("/banned", response_class=HTMLResponse)
async def banned_page(request: Request):
    ip=get_real_ip(request)
    return templates.TemplateResponse(request=request,name="blacklisted.html",context={"ip":ip},status_code=403)

# ── TOKENS ADMIN ───────────────────────────────────────────
@app.get("/api/admin/tokens")
async def api_admin_tokens_list(_=Depends(require_admin)):
    token_auto_deactivate_expired(); return token_get_all()

@app.post("/api/admin/users/quota_unlimited")
async def api_admin_quota_unlimited(request: Request, _=Depends(require_admin)):
    data=await request.json(); target_ip=data.get('ip','').strip(); unlimited=bool(data.get('unlimited',False))
    if not target_ip: raise HTTPException(400,"ip обязателен")
    db = _pg()
    try:
        u = _find_user(db, target_ip)
        if not u:
            raise HTTPException(404, "Пользователь с таким IP не найден")
        u.quota_unlimited = 1 if unlimited else 0
        db.commit()
        return {"ok": True, "ip": target_ip, "unlimited": unlimited}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

@app.post("/api/admin/users/print_queue_perm")
async def api_admin_print_queue_perm(request: Request, _=Depends(require_admin)):
    """Выдать/забрать право редактировать «Таксаторы печать» конкретному
    пользователю (по IP). Хранится в pg_users.can_edit_print_queue —
    в той же базе (PostgreSQL), откуда admin_users.html читает список
    пользователей, поэтому изменение видно сразу и переживает перезапуск."""
    data = await request.json()
    target_ip = (data.get('ip') or '').strip()
    allowed = bool(data.get('allowed', False))
    if not target_ip:
        raise HTTPException(400, "ip обязателен")
    db = _pg()
    try:
        u = db.query(PgUser).filter(PgUser.ip == target_ip).order_by(PgUser.id.desc()).first()
        if not u:
            raise HTTPException(404, "Пользователь с таким IP не найден")
        u.can_edit_print_queue = 1 if allowed else 0
        db.commit()
        return {"ok": True, "ip": target_ip, "can_edit_print_queue": allowed}
    except HTTPException:
        raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()

# ── MIDDLEWARE: IP check + maintenance ─────────────────────
# In-memory кэш статусов IP: ip → (status, timestamp)
# TTL 60 сек — баланс между актуальностью и нагрузкой на БД.
# При блокировке/разблокировке IP кэш сбрасывается через _ip_status_cache_invalidate().
_ip_status_cache: dict = {}
_ip_status_cache_lock = threading.Lock()
_IP_STATUS_TTL = 60  # секунд

def _ip_status_cache_get(ip: str):
    """Возвращает статус из кэша или None если запись устарела/отсутствует."""
    with _ip_status_cache_lock:
        entry = _ip_status_cache.get(ip)
        if entry and (time.time() - entry[1]) < _IP_STATUS_TTL:
            return entry[0]
    return None

def _ip_status_cache_set(ip: str, status: str):
    with _ip_status_cache_lock:
        _ip_status_cache[ip] = (status, time.time())
        # Не даём кэшу расти бесконечно (max 5000 IP)
        if len(_ip_status_cache) > 5000:
            oldest = next(iter(_ip_status_cache))
            del _ip_status_cache[oldest]

def _ip_status_cache_invalidate(ip: str = None):
    """Сбрасывает кэш для конкретного IP или полностью."""
    with _ip_status_cache_lock:
        if ip:
            _ip_status_cache.pop(ip, None)
        else:
            _ip_status_cache.clear()

class IPCheckMiddleware(BaseHTTPMiddleware):
    SKIP=['/static/','/login','/logout','/frozen','/banned','/maintenance','/favicon','/health',
          '/wms','/tiles/','/geoserver_wms_proxy','/dzz-wms-proxy',
          '/wfs','/api/sync/stream','/api/sync/webhook',
          '/api/vector/',
          '/api/session/','/api/geoserver','/geoserver','/api/download_file','/api/download_token','/api/maintenance/']
    async def dispatch(self, request: Request, call_next):
        path=request.url.path; ip=get_real_ip(request)
        if _maintenance["active"] and ip not in PROTECTED_IPS:
            allowed=['/maintenance','/static/','/login','/logout','/favicon','/health']
            if not any(path.startswith(p) for p in allowed):
                with _maintenance_lock: _maintenance["blocked_visits"]+=1
                return templates.TemplateResponse(request=request,name="maintenance.html",context={},status_code=503)
        if any(path.startswith(p) for p in self.SKIP): return await call_next(request)
        # Регистрируем визит на главной странице
        if path == '/':
            await run_in_threadpool(register_visit, ip)
            return await call_next(request)
        # ── Проверка статуса IP: сначала in-memory кэш, потом БД ──────────
        st = _ip_status_cache_get(ip)
        if st is None:
            _, st = await run_in_threadpool(get_status_by_ip, ip)
            _ip_status_cache_set(ip, st)
        if st=="frozen": return templates.TemplateResponse(request=request,name="frozen.html",context={"ip":ip},status_code=403)
        if st=="banned": return templates.TemplateResponse(request=request,name="blacklisted.html",context={"ip":ip},status_code=403)
        return await call_next(request)


# Убираем Set-Cookie из тайловых ответов — иначе nginx не кэширует
class NoCookieTileMiddleware(BaseHTTPMiddleware):
    TILE_PATHS = ('/geoserver_wms_proxy', '/belgosles_wms_proxy', '/wms', '/tiles/', '/dzz-wms-proxy')
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if any(request.url.path.startswith(p) for p in self.TILE_PATHS):
            try:
                del response.headers['set-cookie']
            except KeyError:
                pass
            # Принудительно выставляем public cache — SessionMiddleware мог перезаписать.
            # [FIX] Кроме GetFeatureInfo и ошибок: им no-store выставлен намеренно,
            # а этот блок раньше превращал его в public/max-age=86400 — клики
            # идентификации снова «залипали» в кэше браузера на сутки.
            _rq = (request.query_params.get('REQUEST') or request.query_params.get('request') or '').upper()
            if _rq == 'GETFEATUREINFO' or response.status_code >= 400 or response.headers.get('x-accel-expires') == '0':
                pass
            elif 'cache-control' not in response.headers or 'no-' in response.headers.get('cache-control',''):
                cc = response.headers.get('cache-control','')
                if not cc or 'no-' in cc:
                    response.headers['cache-control'] = 'public, max-age=86400, s-maxage=86400'
        return response



# ─── Pydantic-схемы (объявления) ───────────────────────────────────
from pydantic import BaseModel

class AnnCreateSchema(BaseModel):
    title: str
    body: str
    type: Optional[str] = "info"

class AnnUpdateSchema(BaseModel):
    is_active: Optional[bool] = None
    title: Optional[str] = None
    body: Optional[str] = None
    type: Optional[str] = None

# ─── Публичный эндпоинт: текущее активное объявление ───────────────
@app.get("/api/announcements/active")
def get_active_announcement(db: Session = Depends(get_db)):
    """Возвращает единственное активное объявление (или null)."""
    ann = (
        db.query(PgAnnouncement)
        .filter(PgAnnouncement.is_active == 1)
        .order_by(PgAnnouncement.id.desc())
        .first()
    )
    if not ann:
        return {"announcement": None}
    return {
        "announcement": {
            "id":         ann.id,
            "title":      ann.title,
            "body":       ann.body,
            "type":       ann.type,
            "created_at": ann.created_at,
            "created_by": ann.created_by,
        }
    }

# ─── Админ: список всех объявлений ─────────────────────────────────
@app.get("/api/admin/announcements")
def admin_list_announcements(
    request: Request,
    db: Session = Depends(get_db),
):
    """Возвращает все объявления (для таблицы в админке)."""
    ip = get_real_ip(request)
    user = db.query(PgUser).filter(PgUser.ip == ip).first()
    if not user or user.role not in ("admin", "superadmin"):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    rows = db.query(PgAnnouncement).order_by(PgAnnouncement.id.desc()).all()
    return [
        {
            "id":         r.id,
            "title":      r.title,
            "body":       r.body,
            "type":       r.type,
            "created_at": r.created_at,
            "created_by": r.created_by,
            "is_active":  bool(r.is_active),
        }
        for r in rows
    ]

# ─── Админ: создать объявление ──────────────────────────────────────
@app.post("/api/admin/announcements")
def admin_create_announcement(
    payload: AnnCreateSchema,
    request: Request,
    db: Session = Depends(get_db),
):
    ip = get_real_ip(request)
    user = db.query(PgUser).filter(PgUser.ip == ip).first()
    if not user or user.role not in ("admin", "superadmin"):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    # Снимаем все предыдущие активные
    db.query(PgAnnouncement).filter(PgAnnouncement.is_active == 1).update({"is_active": 0})

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ann = PgAnnouncement(
        title=payload.title,
        body=payload.body,
        type=payload.type or "info",
        created_at=now_str,
        updated_at=now_str,
        is_active=1,
        created_by=ip,
    )
    db.add(ann)
    db.commit()
    db.refresh(ann)
    return {"ok": True, "id": ann.id}

# ─── Админ: обновить / активировать объявление ─────────────────────
@app.put("/api/admin/announcements/{ann_id}")
def admin_update_announcement(
    ann_id: int,
    payload: AnnUpdateSchema,
    request: Request,
    db: Session = Depends(get_db),
):
    ip = get_real_ip(request)
    user = db.query(PgUser).filter(PgUser.ip == ip).first()
    if not user or user.role not in ("admin", "superadmin"):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    ann = db.query(PgAnnouncement).filter(PgAnnouncement.id == ann_id).first()
    if not ann:
        return JSONResponse({"error": "not found"}, status_code=404)

    # Если активируем — снимаем все остальные
    if payload.is_active is True:
        db.query(PgAnnouncement).filter(PgAnnouncement.is_active == 1).update({"is_active": 0})
        ann.is_active = 1
    elif payload.is_active is False:
        ann.is_active = 0

    if payload.title is not None:
        ann.title = payload.title
    if payload.body is not None:
        ann.body = payload.body
    if payload.type is not None:
        ann.type = payload.type

    ann.updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db.commit()
    db.refresh(ann)
    return JSONResponse({"success": True, "id": ann.id})

@app.post("/api/admin/announcements/{ann_id}/deactivate")
def admin_deactivate_announcement(
    ann_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    ip = get_real_ip(request)
    user = db.query(PgUser).filter(PgUser.ip == ip).first()
    if not user or user.role not in ("admin", "superadmin"):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    db.query(PgAnnouncement).filter(PgAnnouncement.id == ann_id).update({
        "is_active": 0,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })
    db.commit()
    return {"ok": True}

# ─── Админ: удалить объявление ─────────────────────────────────────
@app.delete("/api/admin/announcements/{ann_id}")
def admin_delete_announcement(
    ann_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    ip = get_real_ip(request)
    user = db.query(PgUser).filter(PgUser.ip == ip).first()
    if not user or user.role not in ("admin", "superadmin"):
        return JSONResponse({"error": "forbidden"}, status_code=403)

    db.query(PgAnnouncement).filter(PgAnnouncement.id == ann_id).delete()
    db.commit()
    return {"ok": True}


# ==========================================
# ОТМЕТКИ КАЛЕНДАРЯ ОДЗиМЛ: отпуск / больничный / командировка / за свой счёт
# ==========================================
# Просмотр — сотрудники ОДЗиМЛ и админ (как доступ к самому календарю,
# см. _calIsOdziml() в calendar.js). Изменение — как и раньше, ТОЛЬКО
# администратор. [v18] Опционально (переменная окружения ODZ_EDITORS=odziml)
# менять отметки и справочник сотрудников могут и сотрудники ОДЗиМЛ —
# каждая правка подписывается (кто и когда).

_VAC_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
_ABS_KINDS = {
    'vacation': 'Отпуск',
    'sick':     'Больничный',
    'trip':     'Командировка',
    'unpaid':   'За свой счёт',
}
_ODZ_EDITORS = (os.getenv('ODZ_EDITORS', 'admin') or 'admin').strip().lower()


class VacationCreateSchema(BaseModel):
    employee:  str
    date_from: str
    date_to:   str
    comment:   Optional[str] = ""
    kind:      Optional[str] = "vacation"
    staff_id:  Optional[int] = None


def _vac_can_view(ip: str, user_id, device_id=None) -> bool:
    if user_id:
        return True
    return _is_odziml_org(_get_user_org(ip, device_id))


def _odz_can_edit(ip: str, user_id, device_id=None) -> bool:
    """Право менять справочник сотрудников и отметки календаря ОДЗиМЛ:
    администратор; сотрудники ОДЗиМЛ — только если ODZ_EDITORS=odziml."""
    if user_id:
        return True
    if _ODZ_EDITORS != 'odziml':
        return False
    return _vac_can_view(ip, user_id, device_id)


def _odz_now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _vac_to_dict(r) -> dict:
    kind = (getattr(r, 'kind', None) or 'vacation')
    if kind not in _ABS_KINDS:
        kind = 'vacation'
    return {
        "id":         r.id,
        "employee":   r.employee,
        "staff_id":   getattr(r, 'staff_id', None),
        "date_from":  r.date_from,
        "date_to":    r.date_to,
        "comment":    r.comment or "",
        "kind":       kind,
        "kind_label": _ABS_KINDS[kind],
        "created_at": r.created_at or "",
        "created_by_name": getattr(r, 'created_by_name', '') or "",
        "updated_at": getattr(r, 'updated_at', '') or "",
        "updated_by": getattr(r, 'updated_by', '') or "",
    }


def _vac_validate(payload: "VacationCreateSchema"):
    employee = (payload.employee or '').strip()
    df = (payload.date_from or '').strip()
    dt = (payload.date_to or '').strip()
    kind = (payload.kind or 'vacation').strip().lower()
    if not employee:
        raise HTTPException(400, "Не указан сотрудник")
    if kind not in _ABS_KINDS:
        raise HTTPException(400, "Неизвестный вид отметки")
    if not _VAC_DATE_RE.match(df) or not _VAC_DATE_RE.match(dt):
        raise HTTPException(400, "Неверный формат даты (ожидается ГГГГ-ММ-ДД)")
    try:
        d1 = datetime.strptime(df, "%Y-%m-%d"); d2 = datetime.strptime(dt, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Несуществующая дата")
    if d2 < d1:
        raise HTTPException(400, "Дата окончания раньше даты начала")
    if (d2 - d1).days > 366:
        raise HTTPException(400, "Слишком длинный период (больше года)")
    return employee[:150], df, dt, kind, (payload.comment or '').strip()[:300]


def _vac_check_overlap(db, employee, staff_id, df, dt, skip_id=None):
    """Отметки одного сотрудника не должны пересекаться по датам."""
    q = db.query(PgVacation).filter(PgVacation.date_from <= dt, PgVacation.date_to >= df)
    for r in q.all():
        if skip_id is not None and r.id == skip_id:
            continue
        same = (staff_id is not None and getattr(r, 'staff_id', None) == staff_id) or r.employee == employee
        if same:
            k = _ABS_KINDS.get(getattr(r, 'kind', None) or 'vacation', 'Отметка')
            f = lambda v: '.'.join(reversed(v.split('-')))
            raise HTTPException(409, f"Пересекается с уже отмеченным периодом: {k} {f(r.date_from)} — {f(r.date_to)}")


@app.get("/api/vacations")
def api_list_vacations(request: Request, db: Session = Depends(get_db)):
    ip      = get_real_ip(request)
    user_id = get_current_user(request)
    device_id = get_device_id(request)
    if not _vac_can_view(ip, user_id, device_id):
        raise HTTPException(403, "Доступно только сотрудникам ОДЗиМЛ")

    rows = db.query(PgVacation).order_by(PgVacation.date_from.asc(), PgVacation.id.asc()).all()
    return {
        "ok": True,
        "vacations": [_vac_to_dict(r) for r in rows],
        "kinds": _ABS_KINDS,
        "can_edit": _odz_can_edit(ip, user_id, device_id),
    }


def _vac_require_edit(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _odz_can_edit(ip, user_id, device_id):
        if not user_id and (request.session.get("user_id") or ip == ADMIN_IP):
            # сессия администратора без доп. пароля — фронтенд покажет запрос step-up
            require_admin(request)
        raise HTTPException(403, "Изменять отметки календаря может только администратор")
    verify_csrf(request)
    return ip, _display_name(ip, device_id)


@app.post("/api/vacations")
def api_create_vacation(payload: VacationCreateSchema, request: Request, db: Session = Depends(get_db)):
    ip, who = _vac_require_edit(request)
    employee, df, dt, kind, comment = _vac_validate(payload)
    _vac_check_overlap(db, employee, payload.staff_id, df, dt)
    now = _odz_now()
    v = PgVacation(
        employee=employee, date_from=df, date_to=dt, comment=comment, kind=kind,
        staff_id=payload.staff_id, created_at=now, created_by=ip, created_by_name=who,
        updated_at=now, updated_by=who,
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"ok": True, "id": v.id, "vacation": _vac_to_dict(v)}


@app.put("/api/vacations/{vac_id}")
def api_update_vacation(vac_id: int, payload: VacationCreateSchema, request: Request, db: Session = Depends(get_db)):
    ip, who = _vac_require_edit(request)
    row = db.query(PgVacation).filter(PgVacation.id == vac_id).first()
    if not row:
        raise HTTPException(404, "Не найдено")
    employee, df, dt, kind, comment = _vac_validate(payload)
    _vac_check_overlap(db, employee, payload.staff_id, df, dt, skip_id=vac_id)
    row.employee, row.date_from, row.date_to, row.kind, row.comment = employee, df, dt, kind, comment
    row.staff_id = payload.staff_id
    row.updated_at = _odz_now(); row.updated_by = who
    db.commit()
    return {"ok": True, "vacation": _vac_to_dict(row)}


@app.delete("/api/vacations/{vac_id}")
def api_delete_vacation(vac_id: int, request: Request, db: Session = Depends(get_db)):
    _vac_require_edit(request)
    row = db.query(PgVacation).filter(PgVacation.id == vac_id).first()
    if not row:
        raise HTTPException(404, "Не найдено")
    db.delete(row)
    db.commit()
    return {"ok": True}


# ==========================================
# [v18] СПРАВОЧНИК СОТРУДНИКОВ ОДЗиМЛ («Заявление за свой счёт», календарь)
# ==========================================
# Читать — сотрудники ОДЗиМЛ / пользователи «Таксаторы печать» / админ.
# Менять — те же права, что и у отметок календаря (_odz_can_edit).
_ODZ_STAFF_SEED = [
    # label (И.О. Фамилия), ФИО в родительном падеже, пол, должность
    ('И.Р. Бузуновский', 'Бузуновского И.Р.', 'm', 'Начальник'),
    ('А.А. Жибуль',      'Жибуля А.А.',       'm', 'Ведущий инженер'),
    ('О.А. Петрашкевич', 'Петрашкевич О.А.',  'f', 'Ведущий инженер'),
    ('Д.Д. Грузд',       'Грузд Д.Д.',        'f', 'Инженер-таксатор 1 кат.'),
    ('Г.А. Яковлев',     'Яковлева Г.А.',     'm', 'Инженер 2 кат.'),
    ('Д.В. Лабутина',    'Лабутиной Д.В.',    'f', 'Инженер'),
]
_ODZ_SEED_FLAG = os.path.join(BASE_DIR, 'instance', '.odziml_staff_seeded')
_odz_seed_lock = threading.Lock()


def _odz_seed_staff(db):
    """Первый запуск: переносим прежний встроенный список (VF_EMPLOYEES) в БД.
    Один раз — флаг в instance/, чтобы удалённые записи не возвращались."""
    if os.path.exists(_ODZ_SEED_FLAG):
        return
    with _odz_seed_lock:
        if os.path.exists(_ODZ_SEED_FLAG):
            return
        try:
            if db.query(PgOdzStaff).count() == 0:
                now = _odz_now()
                for i, (label, gen, g, pos) in enumerate(_ODZ_STAFF_SEED, 1):
                    db.add(PgOdzStaff(label=label, fio_gen=gen, gender=g, position=pos, sort=i, excluded=0,
                                      created_at=now, updated_at=now, updated_by='Начальная настройка'))
                db.commit()
            os.makedirs(os.path.dirname(_ODZ_SEED_FLAG), exist_ok=True)
            with open(_ODZ_SEED_FLAG, 'w', encoding='utf-8') as fh:
                fh.write(_odz_now())
        except Exception as e:
            db.rollback()
            logger.warning(f"[v18] odziml staff seed: {e}")


def _odz_staff_dict(r) -> dict:
    return {
        "id": r.id, "label": r.label, "fio_gen": r.fio_gen or '', "gender": r.gender or 'm',
        "position": r.position or '', "excluded": bool(r.excluded),
        "excluded_at": r.excluded_at or '', "excluded_by": r.excluded_by or '',
        "sort": r.sort or 0, "updated_at": r.updated_at or '', "updated_by": r.updated_by or '',
    }


class OdzStaffSchema(BaseModel):
    label:    Optional[str] = None
    fio_gen:  Optional[str] = None
    gender:   Optional[str] = None
    position: Optional[str] = None


def _odz_staff_apply(row, payload: "OdzStaffSchema", creating=False):
    if payload.label is not None or creating:
        label = ' '.join((payload.label or '').split())
        if not label:
            raise HTTPException(400, "Укажите ФИО сотрудника (И.О. Фамилия)")
        row.label = label[:150]
    if payload.fio_gen is not None:
        row.fio_gen = ' '.join(payload.fio_gen.split())[:200]
    if payload.gender is not None:
        if payload.gender not in ('m', 'f'):
            raise HTTPException(400, "Пол: m или f")
        row.gender = payload.gender
    if payload.position is not None:
        row.position = ' '.join(payload.position.split())[:120]


def _odz_require_edit(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _odz_can_edit(ip, user_id, device_id):
        if not user_id and (request.session.get("user_id") or ip == ADMIN_IP):
            require_admin(request)
        raise HTTPException(403, "Изменять список сотрудников может только администратор")
    verify_csrf(request)
    return _display_name(ip, device_id)


@app.get("/api/odziml/staff")
def api_odz_staff_list(request: Request, db: Session = Depends(get_db)):
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not (_vac_can_view(ip, user_id, device_id) or _can_manage_print_queue(ip, user_id, device_id)):
        raise HTTPException(403, "Доступно только сотрудникам ОДЗиМЛ")
    _odz_seed_staff(db)
    rows = db.query(PgOdzStaff).order_by(PgOdzStaff.excluded.asc(), PgOdzStaff.sort.asc(), PgOdzStaff.id.asc()).all()
    return {"ok": True, "staff": [_odz_staff_dict(r) for r in rows],
            "can_edit": _odz_can_edit(ip, user_id, device_id), "is_admin": bool(user_id)}


@app.post("/api/odziml/staff")
def api_odz_staff_create(payload: OdzStaffSchema, request: Request, db: Session = Depends(get_db)):
    who = _odz_require_edit(request)
    _odz_seed_staff(db)
    row = PgOdzStaff()
    _odz_staff_apply(row, payload, creating=True)
    if not row.gender:
        row.gender = 'm'
    dup = db.query(PgOdzStaff).filter(PgOdzStaff.label == row.label, PgOdzStaff.excluded == 0).first()
    if dup:
        raise HTTPException(409, f"Сотрудник «{row.label}» уже есть в списке")
    max_sort = db.query(func.coalesce(func.max(PgOdzStaff.sort), 0)).scalar() or 0
    now = _odz_now()
    row.sort = int(max_sort) + 1; row.excluded = 0
    row.created_at = now; row.updated_at = now; row.updated_by = who
    db.add(row); db.commit(); db.refresh(row)
    return {"ok": True, "staff": _odz_staff_dict(row)}


@app.put("/api/odziml/staff/{sid}")
def api_odz_staff_update(sid: int, payload: OdzStaffSchema, request: Request, db: Session = Depends(get_db)):
    who = _odz_require_edit(request)
    row = db.query(PgOdzStaff).filter(PgOdzStaff.id == sid).first()
    if not row:
        raise HTTPException(404, "Сотрудник не найден")
    old_label = row.label
    _odz_staff_apply(row, payload)
    row.updated_at = _odz_now(); row.updated_by = who
    if row.label != old_label:
        # Переименование — обновляем подпись у отметок календаря этого сотрудника.
        db.query(PgVacation).filter(PgVacation.staff_id == sid).update({"employee": row.label})
    db.commit()
    return {"ok": True, "staff": _odz_staff_dict(row)}


@app.post("/api/odziml/staff/{sid}/exclude")
def api_odz_staff_exclude(sid: int, request: Request, db: Session = Depends(get_db)):
    who = _odz_require_edit(request)
    row = db.query(PgOdzStaff).filter(PgOdzStaff.id == sid).first()
    if not row:
        raise HTTPException(404, "Сотрудник не найден")
    now = _odz_now()
    row.excluded = 1; row.excluded_at = now; row.excluded_by = who
    row.updated_at = now; row.updated_by = who
    db.commit()
    return {"ok": True, "staff": _odz_staff_dict(row)}


@app.post("/api/odziml/staff/{sid}/restore")
def api_odz_staff_restore(sid: int, request: Request, db: Session = Depends(get_db)):
    who = _odz_require_edit(request)
    row = db.query(PgOdzStaff).filter(PgOdzStaff.id == sid).first()
    if not row:
        raise HTTPException(404, "Сотрудник не найден")
    max_sort = db.query(func.coalesce(func.max(PgOdzStaff.sort), 0)).scalar() or 0
    row.excluded = 0; row.excluded_at = ''; row.excluded_by = ''
    row.sort = int(max_sort) + 1
    row.updated_at = _odz_now(); row.updated_by = who
    db.commit()
    return {"ok": True, "staff": _odz_staff_dict(row)}


@app.post("/api/odziml/staff/reorder")
async def api_odz_staff_reorder(request: Request, db: Session = Depends(get_db)):
    _odz_require_edit(request)
    data = await request.json()
    ids = data.get('ids') if isinstance(data, dict) else None
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise HTTPException(400, "Пустой список")
    for i, sid in enumerate(ids, 1):
        try:
            db.query(PgOdzStaff).filter(PgOdzStaff.id == int(sid)).update({"sort": i})
        except (TypeError, ValueError):
            raise HTTPException(400, "Некорректный идентификатор")
    db.commit()
    return {"ok": True}


@app.delete("/api/odziml/staff/{sid}")
def api_odz_staff_delete(sid: int, request: Request, db: Session = Depends(get_db)):
    """Окончательное удаление (ошибочно созданная запись) — только администратор.
    Для ушедших сотрудников — «Исключить из отдела» (с возможностью вернуть)."""
    require_admin(request)
    verify_csrf(request)
    row = db.query(PgOdzStaff).filter(PgOdzStaff.id == sid).first()
    if not row:
        raise HTTPException(404, "Сотрудник не найден")
    db.delete(row); db.commit()
    return {"ok": True}


# ==========================================
# АВАТАР ПОЛЬЗОВАТЕЛЯ
# ==========================================
_AVATAR_DIR = os.path.join(BASE_DIR, "static", "avatars")
os.makedirs(_AVATAR_DIR, exist_ok=True)

@app.api_route("/api/avatar/me", methods=["GET", "HEAD"])
def api_avatar_get(request: Request):
    """Возвращает photo_url текущего пользователя из pg_users.
    HEAD: 200 если фото есть, 204 если нет — для совместимости с фронтендом.
    GET:  JSON {ok, photo_url}.
    """
    from fastapi.responses import Response as FastResponse
    ip = get_real_ip(request)
    db = _pg()
    try:
        user = db.query(PgUser).filter(PgUser.ip == ip).first()
        url = (getattr(user, "photo_url", None) or "") if user else ""
        if not url:
            # [v18] у администратора (и у входа без строки pg_users) фото
            # хранится в pg_user_profiles
            url = _profile_load(db, ip).get("photo_url", "") or ""
    finally:
        db.close()
    if request.method == "HEAD":
        return FastResponse(status_code=200 if url else 204)
    return {"ok": True, "photo_url": url, "photo_src": _avatar_src(url)}

@app.post("/api/avatar/delete")
def api_avatar_delete(request: Request):
    """Удаляет фото пользователя — очищает photo_url в БД и файл на диске."""
    ip = get_real_ip(request)
    db = _pg()
    try:
        old_paths = []
        user = db.query(PgUser).filter(PgUser.ip == ip).first()
        if user and getattr(user, "photo_url", None):
            old_paths.append(user.photo_url)  # например /static/avatars/avatar_192_168_12_97.jpg
            user.photo_url = ""
        prof = db.query(PgUserProfile).filter(PgUserProfile.ip == ip).first()
        if prof:
            pdata = _profile_parse(prof.data)
            if pdata.get("photo_url"):
                old_paths.append(pdata.pop("photo_url"))
                prof.data = json.dumps(pdata, ensure_ascii=False)
        db.commit()
        # Удаляем файл с диска — только из каталога аватаров
        for old_path in set(old_paths):
            try:
                full_path = os.path.realpath(os.path.join(BASE_DIR, old_path.split("?", 1)[0].lstrip("/")))
                if full_path.startswith(os.path.realpath(_AVATAR_DIR) + os.sep) and os.path.exists(full_path):
                    os.remove(full_path)
            except Exception:
                pass
    finally:
        db.close()
    return {"ok": True}

@app.post("/api/avatar/upload")
async def api_avatar_upload(request: Request):
    """
    Принимает base64-изображение от фронтенда (v18: уже кадрированное 512×512), сжимает до 384×384 через Pillow
    (решает 413 Request Entity Too Large — большой файл не уходит "как есть"),
    сохраняет JPEG в static/avatars/, записывает путь в колонку photo_url таблицы pg_users.
    """
    ip = get_real_ip(request)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Неверный формат запроса")

    data_url = body.get("photo_data", "")
    if not data_url:
        raise HTTPException(400, "Нет данных изображения")
    if not isinstance(data_url, str) or len(data_url) > 15_000_000:
        raise HTTPException(400, "Изображение слишком большое (до 10 МБ)")

    # Убираем data:image/...;base64, префикс
    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url

    try:
        img_bytes = base64.b64decode(encoded)
    except Exception:
        raise HTTPException(400, "Ошибка декодирования base64")

    # Сжимаем до 384×384 через Pillow
    try:
        img = Image.open(io.BytesIO(img_bytes))
        # [SEC v16] PNG 30 000×30 000 весит килобайты, а в памяти — гигабайты
        if img.width * img.height > 40_000_000:
            raise HTTPException(400, "Слишком большое изображение")
        img.draft("RGB", (512, 512))
        from PIL import ImageOps as _ImageOps
        img = _ImageOps.exif_transpose(img).convert("RGB")
        img = _ImageOps.fit(img, (384, 384), Image.LANCZOS)  # [UX v16] обрезка по центру; [v18] 384 px — чётко на экранах 3x
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Не удалось обработать изображение")

    # Сохраняем JPEG (качество 85 ≈ 15–30 КБ)
    safe_ip = ip.replace(":", "_").replace(".", "_")
    filename = f"avatar_{safe_ip}.jpg"
    filepath = os.path.join(_AVATAR_DIR, filename)
    img.save(filepath, "JPEG", quality=85, optimize=True)

    photo_url = f"/static/avatars/{filename}"

    # Пишем в PostgreSQL колонку photo_url
    db = _pg()
    try:
        user = db.query(PgUser).filter(PgUser.ip == ip).first()
        if user:
            user.photo_url = photo_url
        elif get_current_user(request) or ip == ADMIN_IP:
            # [v18] администратор без строки в pg_users — фото в профиле
            prof = _profile_row(db, ip)
            pdata = _profile_parse(prof.data)
            pdata["photo_url"] = photo_url
            prof.data = json.dumps(pdata, ensure_ascii=False)
            prof.updated_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        else:
            try:
                os.remove(filepath)
            except OSError:
                pass
            raise HTTPException(404, "Пользователь не найден")
        db.commit()
    finally:
        db.close()

    return {"ok": True, "photo_url": photo_url, "photo_src": _avatar_src(photo_url)}


# ==========================================
# [v18] ПРОФИЛЬ «как в Telegram»: фото в «лесной» рамке, о себе, должность,
# телефон, статус с эмодзи и сроком, приватность. Имя НЕ редактируется
# пользователем: его назначает администратор, и оно же — подпись ЭЦП.
# ==========================================
_PROFILE_FRAMES = {
    "none": "Без рамки", "pine": "Сосновый бор", "birch": "Берёзовая роща", "oak": "Дубрава",
    "fern": "Папоротник", "moss": "Мох и лишайник", "autumn": "Осенний лес", "frost": "Зимний лес",
    "sunrise": "Рассвет над лесом", "mushroom": "Грибная поляна", "night": "Ночной лес",
    "spruce": "Ельник",
}
_PROFILE_STATUSES = ("online", "away", "busy", "invisible")
_PROFILE_PRIVACY_DEFAULTS = {
    "show_online": True, "show_last_seen": True, "read_receipts": True, "msg_anyone": True,
    "sound": True, "browser_notify": False, "show_phone": True, "show_bio": True,
}
_PROFILE_TEXT_LIMITS = {"job_title": 80, "phone": 30, "bio": 300, "status_text": 80, "status_emoji": 16}


def _avatar_src(url: str) -> str:
    """URL фото с версией по mtime: nginx отдаёт /static/avatars/* c ?v= как
    immutable, а без версии — с ревалидацией, поэтому новая фотография видна
    коллегам сразу, без «залипшего» кеша."""
    if not url:
        return ""
    path = url.split("?", 1)[0]
    try:
        v = int(os.path.getmtime(os.path.join(BASE_DIR, path.lstrip("/"))))
    except OSError:
        return ""
    return f"{path}?v={v}"


def _profile_parse(raw) -> dict:
    try:
        d = json.loads(raw or "{}")
        return d if isinstance(d, dict) else {}
    except (TypeError, ValueError):
        return {}


def _profile_row(db, ip: str):
    row = db.query(PgUserProfile).filter(PgUserProfile.ip == ip).first()
    if not row:
        row = PgUserProfile(ip=ip, data="{}", updated_at="")
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            row = db.query(PgUserProfile).filter(PgUserProfile.ip == ip).first()
    return row


def _profile_load(db, ip: str) -> dict:
    try:
        row = db.query(PgUserProfile).filter(PgUserProfile.ip == ip).first()
    except Exception:
        return {}
    return _profile_parse(row.data) if row else {}


def _profile_public(d: dict) -> dict:
    """Нормализованный профиль с умолчаниями; истёкший статус — сброшен."""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    out = {k: str(d.get(k) or "")[:lim] for k, lim in _PROFILE_TEXT_LIMITS.items()}
    out["status_until"] = str(d.get("status_until") or "")
    if out["status_until"] and out["status_until"] <= now:
        out["status_text"] = ""; out["status_emoji"] = ""; out["status_until"] = ""
    out["my_status"] = d.get("my_status") if d.get("my_status") in _PROFILE_STATUSES else "online"
    out["frame"] = d.get("frame") if d.get("frame") in _PROFILE_FRAMES else "none"
    priv = d.get("privacy") if isinstance(d.get("privacy"), dict) else {}
    out["privacy"] = {k: bool(priv.get(k, dv)) for k, dv in _PROFILE_PRIVACY_DEFAULTS.items()}
    return out


def _profile_clean_text(v, limit: int) -> str:
    v = "" if v is None else str(v)
    v = "".join(ch for ch in v if ch == "\n" or ch >= " ")   # без управляющих символов
    return v.strip()[:limit]


def _profile_photo(db, ip: str, pdata: dict) -> str:
    u = db.query(PgUser).filter(PgUser.ip == ip).first()
    url = (getattr(u, "photo_url", "") or "") if u else ""
    return url or (pdata.get("photo_url") or "")


@app.get("/api/profile/me")
def api_profile_me(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _is_registered_or_admin(ip, user_id, device_id):
        raise HTTPException(403, "Нет доступа")
    db = _pg()
    try:
        raw = _profile_load(db, ip)
        photo = _profile_photo(db, ip, raw)
        row = db.query(PgUserProfile).filter(PgUserProfile.ip == ip).first()
        return {"ok": True, "ip": ip, "name": _display_name(ip, device_id), "org": _get_user_org(ip, device_id),
                "is_admin": bool(user_id), "profile": _profile_public(raw),
                "photo_url": photo, "photo_src": _avatar_src(photo),
                "updated_at": (row.updated_at if row else "") or "",
                "frames": [{"id": k, "label": v} for k, v in _PROFILE_FRAMES.items()],
                "name_editable": False}
    finally:
        db.close()


@app.post("/api/profile/save")
async def api_profile_save(request: Request):
    ip = get_real_ip(request); user_id = get_current_user(request); device_id = get_device_id(request)
    if not _is_registered_or_admin(ip, user_id, device_id):
        raise HTTPException(403, "Нет доступа")
    verify_csrf(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Неверный формат запроса")
    if not isinstance(body, dict):
        raise HTTPException(400, "Неверный формат запроса")
    db = _pg()
    try:
        row = _profile_row(db, ip)
        cur = _profile_parse(row.data)
        for k, lim in _PROFILE_TEXT_LIMITS.items():
            if k in body:
                val = _profile_clean_text(body.get(k), 10_000)
                if len(val) > lim:
                    raise HTTPException(400, f"Поле «{k}» длиннее {lim} символов")
                if k != "bio":
                    val = val.replace("\n", " ")
                cur[k] = val
        if "phone" in body and cur.get("phone") and not re.fullmatch(r"[0-9+()\-\s.]{3,30}", cur["phone"]):
            raise HTTPException(400, "Телефон: только цифры, пробелы, «+», «-», скобки")
        if "status_ttl" in body:
            try:
                ttl = int(body.get("status_ttl") or 0)
            except (TypeError, ValueError):
                ttl = 0
            ttl = max(0, min(ttl, 60 * 24 * 31))
            cur["status_until"] = (datetime.now() + timedelta(minutes=ttl)).strftime('%Y-%m-%d %H:%M:%S') if ttl else ""
        if "my_status" in body:
            if body.get("my_status") not in _PROFILE_STATUSES:
                raise HTTPException(400, "Неизвестный статус")
            cur["my_status"] = body["my_status"]
        if "frame" in body:
            if body.get("frame") not in _PROFILE_FRAMES:
                raise HTTPException(400, "Неизвестная рамка")
            cur["frame"] = body["frame"]
        if isinstance(body.get("privacy"), dict):
            priv = cur.get("privacy") if isinstance(cur.get("privacy"), dict) else {}
            for k in _PROFILE_PRIVACY_DEFAULTS:
                if k in body["privacy"]:
                    priv[k] = bool(body["privacy"][k])
            cur["privacy"] = priv
        row.data = json.dumps(cur, ensure_ascii=False)
        row.updated_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        db.commit()
        photo = _profile_photo(db, ip, cur)
        return {"ok": True, "profile": _profile_public(cur), "photo_url": photo,
                "photo_src": _avatar_src(photo), "updated_at": row.updated_at}
    except HTTPException:
        db.rollback(); raise
    except Exception:
        db.rollback(); raise
    finally:
        db.close()


def _profile_card(db, ip: str, viewer_ip: str, full: bool) -> dict:
    raw = _profile_load(db, ip)
    pub = _profile_public(raw)
    priv = pub["privacy"]
    photo = _profile_photo(db, ip, raw)
    card = {"ip": ip, "photo_src": _avatar_src(photo), "frame": pub["frame"],
            "status_emoji": pub["status_emoji"]}
    if not full:
        return card
    own = (ip == viewer_ip)
    card.update({"name": _display_name(ip), "org": _get_user_org(ip),
                 "job_title": pub["job_title"],
                 "bio": pub["bio"] if (own or priv["show_bio"]) else "",
                 "phone": pub["phone"] if (own or priv["show_phone"]) else "",
                 "status_text": pub["status_text"], "status_until": pub["status_until"]})
    online, last_seen = False, ""
    if ip == ADMIN_IP:
        online = True
    else:
        u = db.query(PgUser).filter(PgUser.ip == ip).first()
        if u and u.last_seen:
            threshold = (datetime.now() - timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M:%S')
            online, last_seen = (u.last_seen >= threshold), u.last_seen
    hidden = (pub["my_status"] == "invisible") or not priv["show_online"]
    card["presence"] = "hidden" if (hidden and not own) else (pub["my_status"] if online else "offline")
    card["online"] = bool(online and not (hidden and not own))
    card["last_seen"] = last_seen if (own or priv["show_last_seen"]) and not (hidden and not own) else ""
    return card


@app.get("/api/profile/card")
def api_profile_card(request: Request, ip: str = Query(..., max_length=45)):
    viewer = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(viewer, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    ip = ip.strip()
    db = _pg()
    try:
        if ip != ADMIN_IP and ip != viewer:
            u = db.query(PgUser).filter(PgUser.ip == ip).first()
            if not u or u.status != 'active':
                raise HTTPException(404, "Пользователь не найден")
        return {"ok": True, "card": _profile_card(db, ip, viewer, True)}
    finally:
        db.close()


@app.get("/api/profile/cards")
def api_profile_cards(request: Request):
    """Пакетно: фото + рамка + эмодзи статуса для списка диалогов/контактов."""
    viewer = get_real_ip(request); user_id = get_current_user(request)
    if not _is_registered_or_admin(viewer, user_id, get_device_id(request)):
        raise HTTPException(403, "Нет доступа")
    ips = [i.strip() for i in request.query_params.getlist('ip') if i and len(i) <= 45][:200]
    db = _pg()
    try:
        return {"ok": True, "cards": {i: _profile_card(db, i, viewer, False) for i in dict.fromkeys(ips)}}
    finally:
        db.close()

# ==========================================
# Activity telemetry (independent of the existing audit log)
# ==========================================
def _activity_origin_tuple(value):
    try:
        parsed = urlparse(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return None
        return (parsed.scheme.lower(), parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == 'https' else 80))
    except (ValueError, TypeError):
        return None


def _activity_same_origin(request):
    # Do not trust arbitrary forwarded-host headers. Configure ASGI's trusted
    # proxy scheme and preserve Host in nginx so request.url is the public origin.
    if request.headers.get('sec-fetch-site', '').lower() not in ('', 'same-origin'):
        raise HTTPException(403, 'Same-origin request required')
    source = request.headers.get('origin') or request.headers.get('referer')
    origin = _activity_origin_tuple(source) if source else None
    if origin is None or origin != _activity_origin_tuple(str(request.url)):
        raise HTTPException(403, 'Same-origin request required')


def _activity_validate(payload):
    required = {'visit_id', 'path', 'sequence', 'elapsed_seconds', 'visible_seconds', 'visible', 'closed'}
    if not isinstance(payload, dict) or set(payload) != required:
        raise HTTPException(422, 'Invalid activity fields; identity is server-derived')
    try:
        visit_id = _uuid_mod.UUID(payload['visit_id'])
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, 'Invalid visit_id')
    path = payload['path']
    if (not isinstance(path, str) or not path.startswith('/') or path.startswith('//')
            or len(path) > 2048 or any(ord(c) < 32 for c in path) or '\\' in path):
        raise HTTPException(422, 'Invalid pathname')
    path = path.split('?', 1)[0].split('#', 1)[0]
    if type(payload['sequence']) is not int or not 0 <= payload['sequence'] <= 9223372036854775807:
        raise HTTPException(422, 'Invalid sequence')
    for key in ('visible', 'closed'):
        if type(payload[key]) is not bool:
            raise HTTPException(422, 'Invalid flag')
    for key in ('elapsed_seconds', 'visible_seconds'):
        value = payload[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 31536000:
            raise HTTPException(422, 'Invalid cumulative duration')
    if payload['visible_seconds'] > payload['elapsed_seconds']:
        raise HTTPException(422, 'Visible time exceeds elapsed time')
    return dict(payload, visit_id=visit_id, path=path)


def _activity_apply(visit, payload, now):
    """Caller owns row lock. Replay/out-of-order signals cannot reopen visits."""
    if visit.closed or payload['sequence'] <= visit.sequence:
        return False
    wall = max(0.0, (now - visit.started_at).total_seconds())
    visit.elapsed_seconds = max(visit.elapsed_seconds, min(float(payload['elapsed_seconds']), wall))
    visit.visible_seconds = max(visit.visible_seconds, min(float(payload['visible_seconds']), visit.elapsed_seconds, wall))
    visit.sequence = payload['sequence']
    visit.last_seen = max(visit.last_seen, now)
    visit.closed = payload['closed']
    visit.visible = payload['visible'] and not visit.closed
    return True


def _activity_heartbeat_write(ip, payload, device_id=None):
    if not is_tracked_ip(ip):   # [v4] 127.0.0.1 и чужие подсети не отслеживаем
        return {'ok': True, 'tracked': False}
    db = _pg()
    try:
        db.execute(text("SET LOCAL statement_timeout = '5s'"))
        user = _find_user(db, ip, device_id)
        if user is None or user.status != 'active':
            user = db.query(PgUser).filter(PgUser.ip == ip, PgUser.status == 'active').first()
        if user is None or user.status != 'active':
            raise HTTPException(403, 'Active registered user required')
        # [v4] heartbeat = «пользователь жив» → обновляем last_seen для 48-часовой очистки
        user.last_seen = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        now = datetime.now(_activity_timezone.utc)
        # Unique UUID + ON CONFLICT handles concurrent first signals. The row lock
        # serializes updates across workers; sequence makes retry totals idempotent.
        db.execute(_activity_insert(PgActivityVisit).values(
            visit_id=payload['visit_id'], user_id=user.id, path=payload['path'],
            started_at=now, last_seen=now, elapsed_seconds=0, visible_seconds=0,
            sequence=-1, visible=False, closed=False,
        ).on_conflict_do_nothing(index_elements=['visit_id']))
        visit = db.query(PgActivityVisit).filter(PgActivityVisit.visit_id == payload['visit_id']).with_for_update().one()
        if visit.user_id != user.id or visit.path != payload['path']:
            raise HTTPException(409, 'Visit ownership or pathname mismatch')
        # Re-read clock after waiting on the lock; never trust a client timestamp.
        _activity_apply(visit, payload, datetime.now(_activity_timezone.utc))
        result = {'ok': True, 'visit_id': str(visit.visit_id), 'elapsed_seconds': visit.elapsed_seconds,
                  'visible_seconds': visit.visible_seconds}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post('/api/activity/heartbeat')
async def api_activity_heartbeat(request: Request):
    _activity_same_origin(request)
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise HTTPException(415, 'application/json required')
    # Bound even chunked request bodies, not just Content-Length.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            raise HTTPException(413, 'Activity payload too large')
    try:
        payload = _activity_validate(json.loads(raw))
    except (ValueError, UnicodeDecodeError, OverflowError):
        raise HTTPException(422, 'Invalid activity JSON')
    return await run_in_threadpool(_activity_heartbeat_write, get_real_ip(request), payload, get_device_id(request))


def _activity_iso(value):
    return value.astimezone(_activity_timezone.utc).isoformat() if value is not None else None


def _activity_admin_read(days, user_id):
    now = datetime.now(_activity_timezone.utc)
    params = {'cutoff': now - timedelta(days=days), 'online_cutoff': now - timedelta(seconds=45), 'user_id': user_id}
    # Window is a started-at cohort; totals are whole-visit totals, not prorated.
    # SQL groups the full cohort, while all output lists are capped separately.
    cohort = "SELECT * FROM pg_activity_visits WHERE started_at >= :cutoff"
    if user_id is not None:
        cohort += ' AND user_id = :user_id'
    db = _pg()
    try:
        # Stable snapshot across the three bounded queries.
        db.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'))
        db.execute(text("SET LOCAL statement_timeout = '5s'"))
        summary = db.execute(text('''WITH cohort AS (''' + cohort + ''')
            SELECT COUNT(*) AS visits, COALESCE(SUM(elapsed_seconds), 0) AS elapsed_seconds,
                COALESCE(SUM(visible_seconds), 0) AS visible_seconds,
                COUNT(DISTINCT user_id) FILTER (WHERE last_seen >= :online_cutoff AND NOT closed) AS online_users
            FROM cohort'''), params).mappings().one()
        users = db.execute(text('''WITH cohort AS (''' + cohort + '''),
            totals AS (SELECT user_id, COUNT(*) AS visits, SUM(elapsed_seconds) AS elapsed_seconds,
                SUM(visible_seconds) AS visible_seconds,
                BOOL_OR(last_seen >= :online_cutoff AND NOT closed) AS online,
                MAX(last_seen) AS last_seen FROM cohort GROUP BY user_id),
            ranked AS (SELECT user_id, path, ROW_NUMBER() OVER (PARTITION BY user_id
                ORDER BY (last_seen >= :online_cutoff AND NOT closed) DESC, last_seen DESC, visit_id) AS rn FROM cohort)
            SELECT t.*, r.path AS current_path FROM totals t JOIN ranked r ON r.user_id=t.user_id AND r.rn=1
            ORDER BY t.last_seen DESC, t.user_id LIMIT 1001'''), params).mappings().all()
        pages = db.execute(text('''WITH cohort AS (''' + cohort + ''')
            SELECT path, COUNT(*) AS visits, SUM(elapsed_seconds) AS elapsed_seconds,
                SUM(visible_seconds) AS visible_seconds FROM cohort GROUP BY path
            ORDER BY elapsed_seconds DESC, path LIMIT 1001'''), params).mappings().all()
        timeline = db.execute(text('''WITH cohort AS (''' + cohort + ''')
            SELECT visit_id, user_id, path, started_at, last_seen, elapsed_seconds, visible_seconds,
                (last_seen >= :online_cutoff AND NOT closed) AS online FROM cohort
            ORDER BY last_seen DESC, visit_id LIMIT 201'''), params).mappings().all()
        result = {'generated_at': _activity_iso(now), 'users': [], 'pages': [dict(r) for r in pages[:1000]],
                  'summary': dict(summary),
                  'limits': {'users': len(users) > 1000, 'pages': len(pages) > 1000, 'timeline': len(timeline) > 200},
                  'timeline': [], 'truncated': len(users) > 1000 or len(pages) > 1000 or len(timeline) > 200}
        for row in users[:1000]:
            item = dict(row)
            item['last_seen'] = _activity_iso(item['last_seen'])
            if not item['online']:
                item['current_path'] = None
            result['users'].append(item)
        for row in timeline[:200]:
            item = dict(row)
            item['visit_id'] = str(item['visit_id'])
            item['started_at'] = _activity_iso(item['started_at'])
            item['last_seen'] = _activity_iso(item['last_seen'])
            result['timeline'].append(item)
        return result
    finally:
        db.close()


def _activity_clicks_validate(payload):
    """Only structured metadata; never accept identity, input values or labels."""
    import re
    if not isinstance(payload, dict) or set(payload) != {'events'}:
        raise HTTPException(422, 'Expected events batch only; identity is server-derived')
    events = payload['events']
    if not isinstance(events, list) or not 1 <= len(events) <= 20:
        raise HTTPException(422, 'Expected 1 to 20 events')
    required = {'event_id', 'path', 'section', 'action', 'target', 'occurred_at'}
    validated = []
    for event in events:
        if not isinstance(event, dict) or set(event) != required:
            raise HTTPException(422, 'Invalid click event fields')
        try:
            if not isinstance(event['event_id'], str) or len(event['event_id']) != 36:
                raise ValueError()
            event_id = _uuid_mod.UUID(event['event_id'])
            if str(event_id) != event['event_id'].lower():
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, 'Invalid event_id')
        path = event['path']
        if (not isinstance(path, str) or not 1 <= len(path) <= 2048
                or not path.startswith('/') or path.startswith('//')
                or any(ord(c) < 32 or ord(c) == 127 for c in path)
                or any(c in path for c in ('?', '#', '\\'))):
            raise HTTPException(422, 'Expected pathname without query or fragment')
        section = event['section']
        if not isinstance(section, str) or (section != '' and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', section) is None):
            raise HTTPException(422, 'Invalid section key')
        target = event['target']
        if not isinstance(target, str) or re.fullmatch(r'[A-Za-z0-9_.:#/ -]{1,160}', target) is None or not target.strip():
            raise HTTPException(422, 'Invalid structured target')
        if not isinstance(event['action'], str) or event['action'] not in ('click', 'change'):
            raise HTTPException(422, 'Invalid click action')
        # Browser timing is validated metadata, then discarded. Old/future dates
        # cannot backdate records or influence the admin reporting window.
        stamp = event['occurred_at']
        try:
            if not isinstance(stamp, str) or not 20 <= len(stamp) <= 40 or 'T' not in stamp:
                raise ValueError()
            parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError()
        except (ValueError, TypeError, OverflowError):
            raise HTTPException(422, 'Invalid occurred_at ISO timestamp')
        validated.append(dict(id=event_id, path=path, section=section,
                              action=event['action'], target=target))
    return validated


def _activity_clicks_write(ip, events, device_id=None):
    if not is_tracked_ip(ip):   # [v4]
        return {'ok': True, 'accepted': 0, 'tracked': False}
    db = _pg()
    try:
        db.execute(text("SET LOCAL statement_timeout = '5s'"))
        db.execute(text("SET LOCAL lock_timeout = '2s'"))
        db.execute(text("SET LOCAL idle_in_transaction_session_timeout = '5s'"))
        user = _find_user(db, ip, device_id)
        if user is None or user.status != 'active':
            user = db.query(PgUser).filter(PgUser.ip == ip, PgUser.status == 'active').first()
        if user is None or user.status != 'active':
            raise HTTPException(403, 'Active registered user required')
        rows = [dict(event, user_id=user.id, ip=ip) for event in events]
        # One multi-row INSERT per batch; duplicates never update ownership or
        # timestamps, including replays across workers and within one batch.
        inserted = db.execute(_activity_insert(PgActivityClick).values(rows)
                              .on_conflict_do_nothing(index_elements=['id'])
                              .returning(PgActivityClick.id)).all()
        db.commit()
        return {'ok': True, 'accepted': len(inserted)}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post('/api/activity/clicks')
async def api_activity_clicks(request: Request):
    _activity_same_origin(request)
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise HTTPException(415, 'application/json required')
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 32768:
            raise HTTPException(413, 'Click payload too large')
        raw.extend(chunk)
    try:
        events = _activity_clicks_validate(json.loads(raw))
    except (ValueError, UnicodeDecodeError, OverflowError, RecursionError):
        raise HTTPException(422, 'Invalid click JSON')
    return await run_in_threadpool(_activity_clicks_write, get_real_ip(request), events, get_device_id(request))


def _activity_clicks_admin_read(days, user_id):
    now = datetime.now(_activity_timezone.utc)
    params = {'cutoff': now - timedelta(days=days), 'until': now, 'user_id': user_id}
    cohort = 'SELECT * FROM pg_activity_clicks WHERE occurred_at >= :cutoff AND occurred_at <= :until'
    if user_id is not None:
        cohort += ' AND user_id = :user_id'
    db = _pg()
    try:
        db.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'))
        db.execute(text("SET LOCAL statement_timeout = '5s'"))
        db.execute(text("SET LOCAL lock_timeout = '2s'"))
        db.execute(text("SET LOCAL idle_in_transaction_session_timeout = '5s'"))
        summary = db.execute(text('WITH cohort AS (' + cohort + ') SELECT COUNT(*) AS clicks FROM cohort'), params).mappings().one()
        targets = db.execute(text('WITH cohort AS (' + cohort + ''')
            SELECT path, section, action, target, COUNT(*) AS count FROM cohort
            GROUP BY path, section, action, target
            ORDER BY count DESC, path, section, action, target LIMIT 301'''), params).mappings().all()
        events = db.execute(text('WITH cohort AS (' + cohort + ''')
            SELECT id AS event_id, user_id, path, section, action, target, occurred_at FROM cohort
            ORDER BY occurred_at DESC, id DESC LIMIT 201'''), params).mappings().all()
        result = {'generated_at': _activity_iso(now), 'summary': dict(summary),
                  'targets': [dict(row) for row in targets[:300]], 'events': [],
                  'truncated': len(targets) > 300 or len(events) > 200}
        for row in events[:200]:
            item = dict(row)
            item['event_id'] = str(item['event_id'])
            item['occurred_at'] = _activity_iso(item['occurred_at'])
            result['events'].append(item)
        return result
    finally:
        db.close()


@app.get('/api/admin/activity/clicks')
def api_admin_activity_clicks(days: int = Query(1), user_id: Optional[int] = Query(None, ge=1),
                              _admin=Depends(require_admin)):
    if days not in (1, 7, 30):
        raise HTTPException(422, 'days must be 1, 7, or 30')
    return JSONResponse(_activity_clicks_admin_read(days, user_id), headers={'Cache-Control': 'no-store'})


@app.get('/api/admin/activity')
def api_admin_activity(days: int = Query(1), user_id: Optional[int] = Query(None, ge=1),
                       _admin=Depends(require_admin)):
    if days not in (1, 7, 30):
        raise HTTPException(422, 'days must be 1, 7, or 30')
    return JSONResponse(_activity_admin_read(days, user_id), headers={'Cache-Control': 'no-store'})


# ═══════════════════════════════════════════════════════════════════════════
# [v4] КОНСОЛЬ АДМИНИСТРАТОРА: сводка по пользователям, разделам, кликам и
#      событиям + 48-часовое хранение данных о взаимодействиях
# ═══════════════════════════════════════════════════════════════════════════
# • Учитываются только адреса 192.168.12.x (см. is_tracked_ip); последний
#   октет — идентификатор пользователя в консоли.
# • Через ACTIVITY_RETENTION_HOURS (по умолчанию 48 ч) удаляются визиты,
#   клики, история входов и журнал действий (AUDIT_RETENTION_HOURS, 0 = хранить).
# • Пользователь без каких-либо сигналов дольше срока хранения удаляется из
#   базы, если это анонимная запись (без имени/организации, без особых прав,
#   не заморожен/не заблокирован, без ожидающей заявки). Записи с заполненным
#   профилем по умолчанию сохраняются (иначе сотрудник, не заходивший в
#   выходные, должен был бы заново проходить регистрацию) — их история всё
#   равно стирается, а в консоли они отображаются как «спящие».
#   CONSOLE_PURGE_NAMED_USERS=1 — удалять и их.
def _console_env_int(name, default):
    try:
        return max(0, int(os.getenv(name, str(default))))
    except ValueError:
        return default


_CONSOLE_RETENTION_HOURS = _console_env_int('ACTIVITY_RETENTION_HOURS', 48) or 48
_CONSOLE_AUDIT_RETENTION_HOURS = _console_env_int('AUDIT_RETENTION_HOURS', _CONSOLE_RETENTION_HOURS)
_CONSOLE_PURGE_NAMED = os.getenv('CONSOLE_PURGE_NAMED_USERS', '0').strip().lower() in ('1', 'true', 'yes', 'on')
_CONSOLE_ONLINE_SECONDS = 45
_console_purge_lock = threading.Lock()
_console_last_purge = {'at': None, 'result': None}


def _console_local_str(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S')


def _console_parse_local(value):
    """pg_users.last_seen / pg_login_history.login_time — локальное время строкой."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:19], '%Y-%m-%d %H:%M:%S').astimezone(_activity_timezone.utc)
    except (ValueError, OSError):
        return None


def _console_section_key(path, section=''):
    """Единый ключ раздела для визитов (path уже содержит /@section/…) и кликов."""
    path = path or '/'
    if section:
        return ('' if path == '/' else path) + '/@section/' + section
    return path


def _console_user_dict(u):
    name = (decrypt(u.user_name or '') or '').strip()
    org = (decrypt(u.organization_name or '') or '').strip()
    return {
        'id': u.id, 'ip': u.ip, 'octet': ip_octet(u.ip), 'user_name': name, 'organization_name': org,
        'status': u.status or 'active', 'role': u.role or 'user', 'photo_url': u.photo_url or '',
        'first_seen': u.first_seen or '', 'last_seen': u.last_seen or '',
        'quota_unlimited': int(u.quota_unlimited or 0), 'can_edit_print_queue': int(u.can_edit_print_queue or 0),
        'protected': u.ip in PROTECTED_IPS or u.ip == ADMIN_IP,
    }


def _console_safe(db, sql, params, default):
    """Отдельный SAVEPOINT на каждый запрос: отсутствие таблицы (миграция ещё
    не выполнена) не должно ронять всю сводку."""
    try:
        with db.begin_nested():
            return db.execute(text(sql), params).mappings().all()
    except Exception as e:  # noqa: BLE001
        logger.debug(f'[console] query skipped: {e}')
        return default


def _console_purge(force=False):
    """Удаляет взаимодействия старше срока хранения и «забытых» пользователей."""
    if not _console_purge_lock.acquire(blocking=force):
        return _console_last_purge.get('result') or {}
    try:
        now_utc = datetime.now(_activity_timezone.utc)
        hours = _CONSOLE_RETENTION_HOURS
        cutoff_utc = now_utc - timedelta(hours=hours)
        cutoff_local = _console_local_str(datetime.now() - timedelta(hours=hours))
        result = {'visits': 0, 'clicks': 0, 'logins': 0, 'audit': 0, 'users': 0, 'untracked_users': 0}
        steps = [
            ('visits', 'DELETE FROM pg_activity_visits WHERE last_seen < :c', {'c': cutoff_utc}),
            ('clicks', 'DELETE FROM pg_activity_clicks WHERE occurred_at < :c', {'c': cutoff_utc}),
            ('logins', 'DELETE FROM pg_login_history WHERE login_time IS NULL OR login_time < :c', {'c': cutoff_local}),
        ]
        if _CONSOLE_AUDIT_RETENTION_HOURS:
            steps.append(('audit', 'DELETE FROM pg_audit_log WHERE ts < :c',
                          {'c': datetime.utcnow() - timedelta(hours=_CONSOLE_AUDIT_RETENTION_HOURS)}))
        for key, sql, params in steps:
            db = _pg()
            try:
                db.execute(text("SET LOCAL statement_timeout = '30s'"))
                result[key] = db.execute(text(sql), params).rowcount or 0
                db.commit()
            except Exception as e:  # noqa: BLE001
                db.rollback()
                logger.debug(f'[console purge] {key}: {e}')
            finally:
                db.close()

        db = _pg()
        try:
            pending = {r[0] for r in db.query(PgPendingRequest.user_id)
                       .filter(PgPendingRequest.status == 'pending').all() if r[0] is not None}
            doomed, doomed_ips = [], set()
            for u in db.query(PgUser).all():
                if u.ip in PROTECTED_IPS or u.ip == ADMIN_IP or (u.role or '') == 'admin':
                    continue
                if not is_tracked_ip(u.ip):
                    doomed.append(u.id); doomed_ips.add(u.ip); result['untracked_users'] += 1
                    continue
                if (u.last_seen or '') >= cutoff_local:
                    continue
                if (u.status or 'active') != 'active' or u.id in pending:
                    continue
                if int(u.quota_unlimited or 0) or int(u.can_edit_print_queue or 0):
                    continue
                named = bool((decrypt(u.user_name or '') or '').strip() or (decrypt(u.organization_name or '') or '').strip())
                if named and not _CONSOLE_PURGE_NAMED:
                    continue
                doomed.append(u.id); doomed_ips.add(u.ip); result['users'] += 1
            for i in range(0, len(doomed), 500):
                chunk = doomed[i:i + 500]
                for model, col in ((PgActivityVisit, PgActivityVisit.user_id), (PgActivityClick, PgActivityClick.user_id),
                                   (PgLoginHistory, PgLoginHistory.user_id), (PgPendingRequest, PgPendingRequest.user_id)):
                    try:
                        with db.begin_nested():
                            db.query(model).filter(col.in_(chunk)).delete(synchronize_session=False)
                    except Exception as e:  # noqa: BLE001
                        logger.debug(f'[console purge] {model.__tablename__}: {e}')
                db.query(PgUser).filter(PgUser.id.in_(chunk)).delete(synchronize_session=False)
            db.commit()
            for ip in doomed_ips:
                _ip_status_cache_invalidate(ip)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning(f'[console purge] users: {e}')
        finally:
            db.close()
        result['at'] = _activity_iso(now_utc)
        result['retention_hours'] = hours
        _console_last_purge.update(at=result['at'], result=result)
        if any(result[k] for k in ('visits', 'clicks', 'logins', 'audit', 'users', 'untracked_users')):
            logger.info(f'[console purge] {result}')
        return result
    finally:
        _console_purge_lock.release()


def _console_purge_loop():
    time.sleep(90)
    while True:
        try:
            _console_purge()
        except Exception as e:  # noqa: BLE001
            logger.error(f'[console purge loop] {e}')
        time.sleep(900)  # каждые 15 минут


threading.Thread(target=_console_purge_loop, daemon=True, name='console-retention').start()


def _console_window():
    now = datetime.now(_activity_timezone.utc)
    return now, {'cutoff': now - timedelta(hours=_CONSOLE_RETENTION_HOURS),
                 'online_cutoff': now - timedelta(seconds=_CONSOLE_ONLINE_SECONDS),
                 'cutoff_local': _console_local_str(datetime.now() - timedelta(hours=_CONSOLE_RETENTION_HOURS)),
                 'audit_cutoff': datetime.utcnow() - timedelta(hours=_CONSOLE_RETENTION_HOURS)}


def _console_hourly(db, params, user_id=None, ip=None):
    """48 часовых корзин: визиты и клики."""
    uf = ' AND user_id = :user_id' if user_id is not None else ''
    p = dict(params, user_id=user_id)
    v = _console_safe(db, "SELECT date_trunc('hour', started_at) AS h, COUNT(*) AS n, COALESCE(SUM(visible_seconds),0) AS vis "
                          "FROM pg_activity_visits WHERE started_at >= :cutoff" + uf + " GROUP BY 1", p, [])
    c = _console_safe(db, "SELECT date_trunc('hour', occurred_at) AS h, COUNT(*) AS n "
                          "FROM pg_activity_clicks WHERE occurred_at >= :cutoff" + uf + " GROUP BY 1", p, [])
    vm = {r['h'].astimezone(_activity_timezone.utc).replace(tzinfo=None): r for r in v}
    cm = {r['h'].astimezone(_activity_timezone.utc).replace(tzinfo=None): r['n'] for r in c}
    start = params['cutoff'].astimezone(_activity_timezone.utc).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    out = []
    for i in range(_CONSOLE_RETENTION_HOURS + 1):
        h = start + timedelta(hours=i)
        out.append({'hour': h.replace(tzinfo=_activity_timezone.utc).isoformat(), 'visits': int(vm.get(h, {}).get('n', 0) or 0),
                    'visible_seconds': float(vm.get(h, {}).get('vis', 0) or 0), 'clicks': int(cm.get(h, 0) or 0)})
    return out[-_CONSOLE_RETENTION_HOURS:]


def _console_overview():
    now, params = _console_window()
    db = _pg()
    try:
        users = [_console_user_dict(u) for u in db.query(PgUser).order_by(PgUser.id.desc()).all() if is_tracked_ip(u.ip)]
        visits = {r['user_id']: r for r in _console_safe(db, '''
            WITH c AS (SELECT * FROM pg_activity_visits WHERE last_seen >= :cutoff),
            t AS (SELECT user_id, COUNT(*) AS visits, SUM(elapsed_seconds) AS elapsed_seconds,
                  SUM(visible_seconds) AS visible_seconds, MAX(last_seen) AS last_visit,
                  BOOL_OR(last_seen >= :online_cutoff AND NOT closed) AS online FROM c GROUP BY user_id),
            r AS (SELECT user_id, path, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY last_seen DESC, visit_id) AS rn FROM c),
            top AS (SELECT user_id, path, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY SUM(visible_seconds) DESC, path) AS rn
                    FROM c GROUP BY user_id, path)
            SELECT t.*, r.path AS current_path, top.path AS top_path FROM t
            JOIN r ON r.user_id = t.user_id AND r.rn = 1
            LEFT JOIN top ON top.user_id = t.user_id AND top.rn = 1''', params, [])}
        clicks = {r['user_id']: r for r in _console_safe(db, '''SELECT user_id, COUNT(*) AS clicks, MAX(occurred_at) AS last_click
            FROM pg_activity_clicks WHERE occurred_at >= :cutoff GROUP BY user_id''', params, [])}
        logins = {r['user_id']: r['n'] for r in _console_safe(db, '''SELECT user_id, COUNT(*) AS n FROM pg_login_history
            WHERE login_time >= :cutoff_local GROUP BY user_id''', params, [])}
        audit = {r['ip']: r['n'] for r in _console_safe(db, '''SELECT ip, COUNT(*) AS n FROM pg_audit_log
            WHERE ts >= :audit_cutoff GROUP BY ip''', params, [])}
        out_users, online = [], 0
        for u in users:
            v, c = visits.get(u['id']) or {}, clicks.get(u['id']) or {}
            stamps = [x for x in (v.get('last_visit'), c.get('last_click'), _console_parse_local(u['last_seen'])) if x]
            last = max(stamps) if stamps else None
            is_on = bool(v.get('online'))
            online += 1 if is_on else 0
            u.update(visits=int(v.get('visits') or 0), elapsed_seconds=float(v.get('elapsed_seconds') or 0),
                     visible_seconds=float(v.get('visible_seconds') or 0), clicks=int(c.get('clicks') or 0),
                     logins=int(logins.get(u['id'], 0)), audit=int(audit.get(u['ip'], 0)), online=is_on,
                     current_path=v.get('current_path') if is_on else None, top_path=v.get('top_path'),
                     last_activity=_activity_iso(last) if last else None,
                     dormant=not last or last < params['cutoff'])
            out_users.append(u)
        out_users.sort(key=lambda x: (not x['online'], x['dormant'], -(datetime.fromisoformat(x['last_activity']).timestamp() if x['last_activity'] else 0)))
        sec_v = _console_safe(db, '''SELECT path, COUNT(*) AS visits, COUNT(DISTINCT user_id) AS users,
            SUM(elapsed_seconds) AS elapsed_seconds, SUM(visible_seconds) AS visible_seconds
            FROM pg_activity_visits WHERE last_seen >= :cutoff GROUP BY path''', params, [])
        sec_c = _console_safe(db, '''SELECT path, section, COUNT(*) AS clicks, COUNT(DISTINCT user_id) AS users
            FROM pg_activity_clicks WHERE occurred_at >= :cutoff GROUP BY path, section''', params, [])
        sections = {}
        for r in sec_v:
            sections[r['path']] = {'path': r['path'], 'visits': int(r['visits']), 'users': int(r['users']),
                                   'elapsed_seconds': float(r['elapsed_seconds'] or 0),
                                   'visible_seconds': float(r['visible_seconds'] or 0), 'clicks': 0}
        for r in sec_c:
            k = _console_section_key(r['path'], r['section'])
            s = sections.setdefault(k, {'path': k, 'visits': 0, 'users': 0, 'elapsed_seconds': 0.0, 'visible_seconds': 0.0, 'clicks': 0})
            s['clicks'] += int(r['clicks']); s['users'] = max(s['users'], int(r['users']))
        sections = sorted(sections.values(), key=lambda s: (-s['visible_seconds'], -s['clicks'], s['path']))[:200]
        active_users = [u for u in out_users if not u['dormant']]
        summary = {'users': len(out_users), 'active_users': len(active_users), 'online': online,
                   'dormant': len(out_users) - len(active_users),
                   'visits': sum(u['visits'] for u in out_users), 'clicks': sum(u['clicks'] for u in out_users),
                   'logins': sum(u['logins'] for u in out_users), 'audit': sum(u['audit'] for u in out_users),
                   'visible_seconds': sum(u['visible_seconds'] for u in out_users),
                   'elapsed_seconds': sum(u['elapsed_seconds'] for u in out_users)}
        return {'generated_at': _activity_iso(now), 'retention_hours': _CONSOLE_RETENTION_HOURS,
                'subnet': _TRACKED_IP_PREFIX, 'purge_named': _CONSOLE_PURGE_NAMED,
                'online_seconds': _CONSOLE_ONLINE_SECONDS, 'last_purge': _console_last_purge.get('result'),
                'summary': summary, 'users': out_users, 'sections': sections, 'hourly': _console_hourly(db, params)}
    finally:
        db.close()


def _console_events(db, params, kind='', user_id=None, ip=None, limit=300, users_by_id=None, users_by_ip=None):
    """Единая лента: визиты разделов, клики, входы и журнал действий."""
    kinds = {kind} if kind in ('visit', 'click', 'login', 'audit') else {'visit', 'click', 'login', 'audit'}
    p = dict(params, user_id=user_id, ip=ip, lim=limit)
    uf = ' AND user_id = :user_id' if user_id is not None else ''
    items = []
    if 'visit' in kinds:
        for r in _console_safe(db, '''SELECT visit_id, user_id, path, started_at, last_seen, elapsed_seconds, visible_seconds,
                (last_seen >= :online_cutoff AND NOT closed) AS online FROM pg_activity_visits
                WHERE last_seen >= :cutoff''' + uf + ' ORDER BY last_seen DESC LIMIT :lim', p, []):
            items.append({'kind': 'visit', 'ts': _activity_iso(r['started_at']), 'until': _activity_iso(r['last_seen']),
                          'user_id': r['user_id'], 'path': r['path'], 'online': bool(r['online']),
                          'elapsed_seconds': float(r['elapsed_seconds'] or 0), 'visible_seconds': float(r['visible_seconds'] or 0)})
    if 'click' in kinds:
        for r in _console_safe(db, '''SELECT user_id, path, section, action, target, occurred_at FROM pg_activity_clicks
                WHERE occurred_at >= :cutoff''' + uf + ' ORDER BY occurred_at DESC LIMIT :lim', p, []):
            items.append({'kind': 'click', 'ts': _activity_iso(r['occurred_at']), 'user_id': r['user_id'],
                          'path': _console_section_key(r['path'], r['section']), 'action': r['action'], 'target': r['target']})
    if 'login' in kinds:
        for r in _console_safe(db, '''SELECT user_id, ip, login_time FROM pg_login_history
                WHERE login_time >= :cutoff_local''' + uf + ' ORDER BY id DESC LIMIT :lim', p, []):
            ts = _console_parse_local(r['login_time'])
            items.append({'kind': 'login', 'ts': _activity_iso(ts) if ts else None, 'user_id': r['user_id'], 'ip': r['ip']})
    if 'audit' in kinds and (user_id is None or ip):
        af = ' AND ip = :ip' if ip else ''
        for r in _console_safe(db, '''SELECT ip, action, resource, status_code, ts FROM pg_audit_log
                WHERE ts >= :audit_cutoff''' + af + ' ORDER BY ts DESC LIMIT :lim', p, []):
            u = (users_by_ip or {}).get(r['ip'])
            items.append({'kind': 'audit', 'ts': r['ts'].replace(tzinfo=_activity_timezone.utc).isoformat() if r['ts'] else None,
                          'user_id': u['id'] if u else None, 'ip': r['ip'], 'action': r['action'],
                          'resource': (r['resource'] or '')[:400], 'status_code': r['status_code']})
    for it in items:
        u = (users_by_id or {}).get(it.get('user_id'))
        if u:
            it.setdefault('ip', u['ip'])
            it['name'] = u['user_name']; it['octet'] = u['octet']; it['organization_name'] = u['organization_name']
        else:
            it.setdefault('ip', None); it['name'] = ''; it['octet'] = ip_octet(it.get('ip'))
    items = [i for i in items if i['ts'] and (i.get('ip') is None or is_tracked_ip(i['ip']))]
    items.sort(key=lambda i: i['ts'], reverse=True)
    return items[:limit]


def _console_user_maps(db):
    by_id, by_ip = {}, {}
    for u in db.query(PgUser).order_by(PgUser.id.asc()).all():
        if not is_tracked_ip(u.ip):
            continue
        d = _console_user_dict(u)
        by_id[u.id] = d
        by_ip[u.ip] = d   # при нескольких записях на IP — самая свежая
    return by_id, by_ip


def _console_events_read(kind, user_id, limit):
    now, params = _console_window()
    db = _pg()
    try:
        by_id, by_ip = _console_user_maps(db)
        ip = by_id[user_id]['ip'] if user_id in by_id else None
        items = _console_events(db, params, kind, user_id, ip, limit, by_id, by_ip)
        counts = {k: 0 for k in ('visit', 'click', 'login', 'audit')}
        for i in items:
            counts[i['kind']] += 1
        return {'generated_at': _activity_iso(now), 'retention_hours': _CONSOLE_RETENTION_HOURS,
                'items': items, 'counts': counts, 'total': len(items), 'limit': limit}
    finally:
        db.close()


def _console_user_read(uid):
    now, params = _console_window()
    db = _pg()
    try:
        by_id, by_ip = _console_user_maps(db)
        u = by_id.get(uid)
        if not u:
            raise HTTPException(404, 'Пользователь не найден (возможно, удалён по сроку хранения)')
        p = dict(params, user_id=uid, ip=u['ip'])
        sv = _console_safe(db, '''SELECT path, COUNT(*) AS visits, SUM(elapsed_seconds) AS elapsed_seconds,
            SUM(visible_seconds) AS visible_seconds, MAX(last_seen) AS last_seen,
            BOOL_OR(last_seen >= :online_cutoff AND NOT closed) AS online
            FROM pg_activity_visits WHERE last_seen >= :cutoff AND user_id = :user_id GROUP BY path''', p, [])
        sc = _console_safe(db, '''SELECT path, section, action, target, COUNT(*) AS count, MAX(occurred_at) AS last_at
            FROM pg_activity_clicks WHERE occurred_at >= :cutoff AND user_id = :user_id
            GROUP BY path, section, action, target ORDER BY count DESC''', p, [])
        sections, online, current = {}, False, None
        for r in sv:
            sections[r['path']] = {'path': r['path'], 'visits': int(r['visits']), 'clicks': 0,
                                   'elapsed_seconds': float(r['elapsed_seconds'] or 0),
                                   'visible_seconds': float(r['visible_seconds'] or 0), 'last_seen': _activity_iso(r['last_seen'])}
            if r['online']:
                online = True
        cur = _console_safe(db, '''SELECT path FROM pg_activity_visits WHERE user_id = :user_id AND last_seen >= :online_cutoff
            AND NOT closed ORDER BY last_seen DESC LIMIT 1''', p, [])
        current = cur[0]['path'] if cur else None
        targets = []
        for r in sc:
            k = _console_section_key(r['path'], r['section'])
            s = sections.setdefault(k, {'path': k, 'visits': 0, 'clicks': 0, 'elapsed_seconds': 0.0, 'visible_seconds': 0.0,
                                        'last_seen': None})
            s['clicks'] += int(r['count'])
            if len(targets) < 100:
                targets.append({'path': k, 'action': r['action'], 'target': r['target'], 'count': int(r['count']),
                                'last_at': _activity_iso(r['last_at'])})
        sections = sorted(sections.values(), key=lambda s: (-s['visible_seconds'], -s['clicks'], s['path']))
        events = _console_events(db, params, '', uid, u['ip'], 300, by_id, by_ip)
        logins = [e['ts'] for e in events if e['kind'] == 'login'][:50]
        summary = {'visits': sum(s['visits'] for s in sections), 'clicks': sum(s['clicks'] for s in sections),
                   'elapsed_seconds': sum(s['elapsed_seconds'] for s in sections),
                   'visible_seconds': sum(s['visible_seconds'] for s in sections),
                   'sections': len([s for s in sections if s['visits'] or s['clicks']]),
                   'logins': len(logins), 'audit': len([e for e in events if e['kind'] == 'audit'])}
        stamps = [x for x in [_console_parse_local(u['last_seen'])] + [datetime.fromisoformat(e['ts']) for e in events[:1]] if x]
        last = max(stamps) if stamps else None
        u.update(online=online, current_path=current, last_activity=_activity_iso(last) if last else None,
                 dormant=not last or last < params['cutoff'])
        return {'generated_at': _activity_iso(now), 'retention_hours': _CONSOLE_RETENTION_HOURS, 'user': u,
                'summary': summary, 'sections': sections, 'targets': targets, 'events': events, 'logins': logins,
                'hourly': _console_hourly(db, params, uid)}
    finally:
        db.close()


@app.get('/api/admin/console/overview')
def api_admin_console_overview(_admin=Depends(require_admin)):
    return JSONResponse(_console_overview(), headers={'Cache-Control': 'no-store'})


@app.get('/api/admin/console/user/{uid}')
def api_admin_console_user(uid: int, _admin=Depends(require_admin)):
    return JSONResponse(_console_user_read(uid), headers={'Cache-Control': 'no-store'})


@app.get('/api/admin/console/events')
def api_admin_console_events(kind: str = Query(''), user_id: Optional[int] = Query(None, ge=1),
                             limit: int = Query(300, ge=10, le=1000), _admin=Depends(require_admin)):
    return JSONResponse(_console_events_read(kind, user_id, limit), headers={'Cache-Control': 'no-store'})


@app.post('/api/admin/console/purge')
def api_admin_console_purge(_admin=Depends(require_admin)):
    """Ручной запуск очистки (то же делает фоновый поток раз в 15 минут)."""
    return JSONResponse(_console_purge(force=True), headers={'Cache-Control': 'no-store'})


# Регистрируем middleware и монтируем статику ПОСЛЕ объявления всех классов
# (порядок важен: add_middleware должен быть ДО app.mount, иначе url_for('static') сломается)
# [PERF v9] Тайлы и статика обходят BaseHTTPMiddleware-слои (IP-статус, device-id,
# аудит) — они для них ничего не делают, но стоили отдельной задачи на КАЖДЫЙ тайл.
app.add_middleware(_gg.bypass(IPCheckMiddleware))
app.add_middleware(_gg.TileCacheHeadersASGI)   # = NoCookieTileMiddleware (ASGI-версия)
# [FIX device-id] Должен успеть выставить request.state.device_id ДО того,
# как выполнится обработчик маршрута — поэтому регистрируем здесь же, вместе
# с остальными "поздними" (= внешними по цепочке) middleware.
app.add_middleware(_gg.bypass(DeviceIdentityMiddleware))

# [SEC] Регистрируется ПОСЛЕДНИМ → становится самым внешним слоем: проверяет
# путь до маршрутизации (в т.ч. до StaticFiles) и проставляет заголовки
# безопасности на любой ответ, включая статику и ошибки.
app.add_middleware(_gg.SecurityHeadersASGI, headers=_SECURITY_HEADERS,
                   forbidden_suffixes=_FORBIDDEN_STATIC_SUFFIXES,
                   forbidden_dirs=_FORBIDDEN_STATIC_DIRS)   # = SecurityMiddleware (ASGI-версия)

# [SEC v16] Защитный слой (security_hardening.py): опасные методы, обход каталогов,
# Host, CSRF по Origin для ВСЕХ изменяющих запросов, лимиты тела, rate-limit.
# Стоит сразу под GeoGuard: его авто-бан видит наши 4xx-отказы.
app.add_middleware(_sh.HardeningASGI, trusted_proxies=_TRUSTED_PROXY_IPS,
                   allowed_origins=_ALLOWED_ORIGINS, exempt_ips=PROTECTED_IPS)


@app.get("/api/admin/security/stats")
def api_admin_security_stats(_admin=Depends(require_admin)):
    """[SEC v16] Сколько атак/нарушений отсечено с момента запуска (по причинам)."""
    return JSONResponse({"blocked": _sh.stats()}, headers={"Cache-Control": "no-store"})


# [SEC v9] Самый внешний слой: пропуск геосервиса, фильтр WMS/WFS, лимиты, авто-бан.
app.add_middleware(_gg.GeoGuardMiddleware, secret_key=SECRET_KEY or "",
                   protected_ips=PROTECTED_IPS, trusted_proxies=_TRUSTED_PROXY_IPS,
                   allowed_origins=_ALLOWED_ORIGINS, session_cookie="forest_session")

# Монтируем статику последними — после всех add_middleware
app.mount("/static", CachedStaticFiles(directory=_STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_FOLDER), name="uploads")



# ==========================================
# 24. ЗАПУСК (dev)
# ==========================================
# ==========================================
# КОНВЕРТЕР СК (crs_converter.py)
# ==========================================
# Перепроецирование SHP / TIFF(+tfw, tfwx, xml, ovr) пользователей: СК-42 (все зоны),
# СК-63, WGS-84 (все разновидности), свои пресеты. Отключается админом:
# POST /api/admin/features {"crs_converter": false}.
from crs_converter import build_router as _build_crs_router
app.include_router(_build_crs_router(
    base_dir=BASE_DIR,
    cache_dir=CACHE_FOLDER,
    is_admin=lambda request: bool(get_current_user(request)),
    verify_csrf=verify_csrf,
))

# Перемещение результатов конвертера СК — новая привязка хранится на сервере (crs_shift.py)
from crs_shift import build_router as _build_crs_shift_router
app.include_router(_build_crs_shift_router(
    base_dir=BASE_DIR,
    verify_csrf=verify_csrf,
    logger=logger,
))

# [v19] Конвертер СК → «План → GeoTIFF/TFW → MBTiles» и «Растр → MBTiles» (georef_api.py).
# Скан плана (JPG/PNG/TIFF) или PDF привязывается по контурам зданий НКА и ортофото,
# результат — GeoTIFF EPSG:3857 + .tfw/.prj и MBTiles; админ может сразу добавить слой
# в папку «MBTILES MINSK». Инструменты: tools/georef/ (georef_plans.py, tif2mbtiles.py).
def _georef_register_mbtiles(src_path: str, name: str) -> dict:
    safe_base = secure_filename(os.path.basename(src_path)) or "plan.mbtiles"
    if not safe_base.lower().endswith(".mbtiles"):
        safe_base = "plan.mbtiles"
    os.makedirs(MBTILES_MINSK_FOLDER, exist_ok=True)
    dest_filename = f"{int(time.time())}_{safe_base}"
    dest_path = os.path.join(MBTILES_MINSK_FOLDER, dest_filename)
    shutil.copyfile(src_path, dest_path)
    try:
        meta_name, fmt, bounds, min_z, max_z = _read_mbtiles_metadata(dest_path)
        db = SessionLocal()
        try:
            layer = MbtilesLayer(
                name=(name or "").strip() or meta_name or os.path.splitext(safe_base)[0],
                filename=dest_filename, folder='MBTILES MINSK',
                tile_format=fmt, min_zoom=min_z, max_zoom=max_z,
                bounds_lon_min=bounds[0], bounds_lat_min=bounds[1],
                bounds_lon_max=bounds[2], bounds_lat_max=bounds[3],
            )
            db.add(layer); db.commit(); db.refresh(layer)
            return {
                "success": True, "id": layer.id, "name": layer.name, "folder": layer.folder,
                "min_zoom": layer.min_zoom, "max_zoom": layer.max_zoom,
                "bounds": [[layer.bounds_lat_min, layer.bounds_lon_min],
                           [layer.bounds_lat_max, layer.bounds_lon_max]],
                "tile_url": f"/api/mbtiles/{layer.id}/{{z}}/{{x}}/{{y}}." + fmt,
            }
        finally:
            db.close()
    except Exception:
        try:
            os.remove(dest_path)
        except OSError:
            pass
        raise

from georef_api import build_router as _build_georef_router
app.include_router(_build_georef_router(
    base_dir=BASE_DIR,
    is_admin=lambda request: bool(get_current_user(request)),
    verify_csrf=verify_csrf,
    register_mbtiles=_georef_register_mbtiles,
    logger=logger,
))


# ==========================================
# СЕЗОН ОФОРМЛЕНИЯ (season_api.py)
# ==========================================
# Весна / лето / осень / зима / авто — ели в шапке и на служебных страницах.
# Переключается в консоли администратора (вкладка «Тех. работы»):
# POST /api/admin/season {"season": "winter"}. В шаблонах — глобал {{ season }}.
from season_api import build_router as _build_season_router
app.include_router(_build_season_router(
    base_dir=BASE_DIR,
    templates=templates,
    require_admin=require_admin,
    verify_csrf=verify_csrf,
    logger=logger,
))


# ==========================================
# МЕТОДИЧКИ (manuals_api.py)
# ==========================================
# Страница /manuals: методички (заголовок + файлы Word/PDF). Читать и скачивать — всем,
# создавать/переименовывать/заменять/удалять — администратору (сессия + CSRF).
# Файлы: instance/manuals/. Первый запуск подхватывает файлы из папки manuals_seed/.
from manuals_api import build_router as _build_manuals_router
app.include_router(_build_manuals_router(
    base_dir=BASE_DIR,
    templates=templates,
    require_admin=require_admin,
    verify_csrf=verify_csrf,
    is_admin=lambda request: bool(get_current_user(request)),
    get_csrf_token=get_csrf_token,
    logger=logger,
))

# [v20.10] Веб-редакции методичек (manuals_editor_api.py): редактор на /manuals публикует правки
# отдельными редакциями (исходный Word/PDF не меняется), история и восстановление. Читать — всем,
# сохранять — администратору (доп. пароль + CSRF). Хранение: instance/manuals_editions/.
# Без модуля страница пишет «сервер редакций не подключён» — чтение при этом работает.
try:
    from manuals_editor_api import build_router as _build_manuals_editor_router
except ImportError as _e:
    _build_manuals_editor_router = None
    logger.warning("manuals_editor_api.py не найден рядом с app.py — редактор методичек только для чтения (%s)", _e)
if _build_manuals_editor_router is not None:
    try:
        app.include_router(_build_manuals_editor_router(
            base_dir=BASE_DIR,
            require_admin=require_admin,
            verify_csrf=verify_csrf,
            logger=logger,
        ))
        logger.info("✅ Редактор методичек (manuals_editor_api) подключён: /api/manuals-editions")
    except Exception as _e:                       # не мешаем запуску портала (например, нет прав на instance/)
        logger.exception("Редактор методичек не подключён: %s", _e)

# ==========================================
# 3D-РЕЖИМ ЛЕСХОЗОВ (forest3d_api.py) — кнопка «ВИД 2D/3D» на карте
# ==========================================
# SHP лесхозов кладётся в shp_leshoz3d/ (с .prj — СК-63/СК-42/UTM/WGS-84 определяется сама).
# Если там пусто — берётся shp_leshoz/ (при наличии .prj), иначе данные геосервиса.
# Всё приводится к WGS-84; площадь — геодезическая (эллипсоид WGS-84).
from forest3d_access import build_access as _build_forest3d_access
_forest3d_access = _build_forest3d_access(
    base_dir=BASE_DIR,
    is_admin=lambda request: bool(get_current_user(request)),
    verify_csrf=verify_csrf,
)
app.include_router(_forest3d_access.router)

from forest3d_api import build_router as _build_forest3d_router
_forest3d_router = _build_forest3d_router(
    base_dir=BASE_DIR,
    names={d['code']: d['name'] for d in MANUAL_FORESTRY_FIX},
    gdf_loader=load_leshoz_data,
    shp_dirs=[os.path.join(BASE_DIR, 'shp_leshoz3d'), SHP_FOLDER],
    logger=logger,
)
app.include_router(_forest3d_router, dependencies=[Depends(_forest3d_access.require_view)])

# Облака точек .las/.laz → деревья (хвойные/лиственные, высота, диаметр ствола) в 3D-режиме.
# Просмотр — по разрешению администратора; загрузка всегда только администратору.
# результаты: instance/forest3d_las/. Нужны пакеты: pip install laspy[lazrs]
def _forest3d_prj():
    for _d in (os.path.join(BASE_DIR, 'shp_leshoz3d'), SHP_FOLDER):
        _p = sorted(glob.glob(os.path.join(_d, '*.prj')))
        if _p:
            return _p[0]
    return None

from forest3d_las import build_router as _build_forest3d_las_router
app.include_router(_build_forest3d_las_router(
    base_dir=BASE_DIR,
    items_fn=_forest3d_router.forest3d_items,
    is_admin=lambda request: bool(get_current_user(request)),
    verify_csrf=verify_csrf,
    shp_prj=_forest3d_prj,
    logger=logger,
), dependencies=[Depends(_forest3d_access.require_view)])

# [v19] Рельеф 3D-сцены через сервер (forest3d_dem.py): тайлы Terrarium (AWS / свой GeoTIFF ЦМР /
# локальная папка) с дисковым кэшем — браузеру не нужен доступ к внешним сайтам (CSP connect-src 'self').
from forest3d_dem import build_router as _build_forest3d_dem_router
app.include_router(_build_forest3d_dem_router(base_dir=BASE_DIR, logger=logger),
                   dependencies=[Depends(_forest3d_access.require_view)])

# [v19] ЛесоЛидар (lesolidar_bridge.py): LAS/LAZ → деревья, породы, запас, ЦМР/ЦМП — обработчик
# LesoLidar.exe (tools/LesoLidar/ или LESOLIDAR_EXE). Просмотр — как у 3D, запуск — администратор.
from lesolidar_bridge import build_router as _build_lesolidar_router
app.include_router(_build_lesolidar_router(
    base_dir=BASE_DIR,
    is_admin=lambda request: bool(get_current_user(request)),
    verify_csrf=verify_csrf,
    logger=logger,
), dependencies=[Depends(_forest3d_access.require_view)])

# ==========================================
# ДОПОЛНИТЕЛЬНЫЙ ПАРОЛЬ АДМИНИСТРАТОРА (admin_stepup.py)
# ==========================================
# Права админа — только после второго пароля (ADMIN_PASSWORD2 в .env), даже с ADMIN_IP.
# Подтверждение действует случайное время (10–45 мин) — пароль спросится снова на любой странице.
_stepup.build(app=app, get_real_ip=get_real_ip, get_csrf_token=get_csrf_token,
              admin_ip=ADMIN_IP, admin_id=ADMIN_USER["id"], logger=logger)

# Shared design v13: presentation only; writes protected by session and CSRF.
from design_theme_api import build_router as _build_design_theme_router
app.include_router(_build_design_theme_router(
    base_dir=BASE_DIR, require_admin=require_admin, verify_csrf=verify_csrf,
    is_admin=lambda request: bool(get_current_user(request)),
))

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting FastAPI Server with PostgreSQL/PostGIS backend...")
    # workers=4: 4 процесса → параллельная обработка тайловых запросов.
    # При workers=1 все 34 КС-слоя обрабатываются последовательно → лаги.
    # reload=True несовместим с workers>1 — убираем reload в продакшене.
    # [FIX] Было host="0.0.0.0" — порт 5000 был доступен напрямую по сети,
    # в обход nginx. Из-за этого любой клиент мог подставить свой
    # X-Real-IP/X-Forwarded-For и подменить IP в аудит-логе и авто-логине.
    # За nginx приложение должно слушать только loopback (см. докстринг
    # в начале файла: "Для продакшена (за nginx): --host 127.0.0.1").
    uvicorn.run("app:app", host="127.0.0.1", port=5000, workers=4)
