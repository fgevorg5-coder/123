"""Shared presentation preference. Admin + CSRF required for every write."""
from __future__ import annotations
import inspect
import sqlite3
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

THEMES = ('standard', 'autumn', 'winter', 'spring', 'summer')

def build_router(*, base_dir, require_admin, verify_csrf, is_admin):
    router = APIRouter()
    folder = Path(base_dir) / 'instance'
    folder.mkdir(parents=True, exist_ok=True)
    db = folder / 'design_theme.sqlite3'
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS design_theme (id INTEGER PRIMARY KEY CHECK(id=1), theme TEXT NOT NULL)')
        conn.execute("INSERT OR IGNORE INTO design_theme VALUES (1,'standard')")

        # Migrate the former three-theme setting once; preserve new seasonal values.
        conn.execute("UPDATE design_theme SET theme=CASE theme WHEN 'light' THEN 'winter' WHEN 'forest' THEN 'standard' WHEN 'graphite' THEN 'standard' ELSE theme END WHERE id=1")

    def current():
        with sqlite3.connect(db, timeout=5) as conn:
            value = conn.execute('SELECT theme FROM design_theme WHERE id=1').fetchone()[0]
        return value if value in THEMES else 'standard'

    async def allowed(request):
        for fn in (require_admin, verify_csrf):
            result = fn(request)
            if inspect.isawaitable(result):
                await result

    @router.get('/api/design-theme')
    async def get_theme(request: Request):
        admin = is_admin(request)
        if inspect.isawaitable(admin):
            admin = await admin
        return JSONResponse({'theme': current(), 'can_manage': bool(admin)}, headers={'Cache-Control': 'no-store'})

    @router.put('/api/design-theme')
    async def put_theme(request: Request):
        await allowed(request)
        if len(await request.body()) > 1024:
            raise HTTPException(413, 'Слишком большой запрос')
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(400, 'Ожидается JSON')
        if not isinstance(data, dict) or data.get('theme') not in THEMES:
            raise HTTPException(400, 'Выберите одну из пяти тем')
        with sqlite3.connect(db, timeout=5) as conn:
            conn.execute('UPDATE design_theme SET theme=? WHERE id=1', (data['theme'],))
        return JSONResponse({'theme': data['theme'], 'can_manage': True}, headers={'Cache-Control': 'no-store'})

    return router
