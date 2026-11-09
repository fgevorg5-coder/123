"""Persistent, fail-closed 3D viewing policy; uploads/settings remain admin-only."""
from __future__ import annotations
import json
import os
import threading
from types import SimpleNamespace
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from forest3d_las import _write_json_atomic

def build_access(*, base_dir, is_admin, verify_csrf):
    path = os.path.join(base_dir, "instance", "forest3d_access.json")
    lock = threading.Lock()
    router = APIRouter()

    def read_enabled():
        # Missing/corrupt/unreadable configuration never grants access.
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f).get("users_enabled") is True
        except (OSError, ValueError, AttributeError):
            return False

    async def require_view(request: Request):
        if is_admin(request):
            return
        if not await run_in_threadpool(read_enabled):
            raise HTTPException(403, "3D-режим доступен только администратору")

    def response(request, enabled):
        admin = bool(is_admin(request))
        return JSONResponse({"allowed": admin or enabled, "is_admin": admin,
                             "users_enabled": enabled}, headers={"Cache-Control": "no-store"})

    @router.get("/api/forest3d/access")
    async def get_access(request: Request):
        return response(request, await run_in_threadpool(read_enabled))

    @router.post("/api/forest3d/access")
    async def set_access(request: Request):
        if not is_admin(request):
            raise HTTPException(403, "Изменять доступ к 3D может только администратор")
        verify_csrf(request)
        data = await request.json()
        if not isinstance(data, dict) or type(data.get("users_enabled")) is not bool:
            raise HTTPException(400, "users_enabled должен быть true или false")
        def save():
            with lock:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                _write_json_atomic(path, {"users_enabled": data["users_enabled"]})
        await run_in_threadpool(save)
        return response(request, data["users_enabled"])

    return SimpleNamespace(router=router, require_view=require_view)
