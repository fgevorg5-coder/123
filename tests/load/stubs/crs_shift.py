"""Заглушка для стенда: модуль crs_shift не входит в пакет v20.12."""
from fastapi import APIRouter

def build_router(**kwargs):
    return APIRouter()
