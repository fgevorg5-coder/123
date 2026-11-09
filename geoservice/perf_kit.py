"""perf_kit — примитивы устойчивости под нагрузкой (v20.13).

Маленький, независимый от FastAPI модуль: используется app.py и нагрузочным
стендом tests/load/stand.py, поэтому стенд проверяет ровно тот код, что
работает в проде.

  TTLCache        — потокобезопасный LRU-кэш с TTL и жёстким лимитом записей.
  SingleFlight    — склейка одновременных одинаковых запросов (cache stampede):
                    сколько бы корутин ни запросили ключ, тяжёлая работа
                    выполняется один раз, остальные ждут её результат.
  CircuitBreaker  — «предохранитель» для внешних зависимостей (Redis, GeoServer):
                    после N подряд ошибок вызовы отключаются на cooldown секунд.
  Throttle        — «не чаще, чем раз в N секунд на ключ» (запись last_seen и т.п.).
  no_store()      — заголовки для ответов-ошибок, которые нельзя кэшировать.
"""
from __future__ import annotations

import asyncio
import collections
import threading
import time
from typing import Any, Awaitable, Callable, Dict, Hashable, Optional

_MISSING = object()


class TTLCache:
    """LRU + TTL. Все операции O(1), под одним threading.Lock — безопасно
    вызывать и из event loop, и из потоков threadpool."""

    __slots__ = ("_data", "_lock", "maxsize", "ttl", "hits", "misses")

    def __init__(self, maxsize: int = 1000, ttl: float = 60.0):
        self._data: "collections.OrderedDict[Hashable, tuple[float, Any]]" = collections.OrderedDict()
        self._lock = threading.Lock()
        self.maxsize = max(1, int(maxsize))
        self.ttl = float(ttl)
        self.hits = 0
        self.misses = 0

    def get(self, key: Hashable, default: Any = None, now: Optional[float] = None) -> Any:
        now = time.monotonic() if now is None else now
        with self._lock:
            item = self._data.get(key)
            if item is None:
                self.misses += 1
                return default
            exp, value = item
            if exp <= now:
                del self._data[key]
                self.misses += 1
                return default
            self._data.move_to_end(key)
            self.hits += 1
            return value

    def put(self, key: Hashable, value: Any, ttl: Optional[float] = None, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        exp = now + (self.ttl if ttl is None else float(ttl))
        with self._lock:
            self._data[key] = (exp, value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def pop(self, key: Hashable, default: Any = None) -> Any:
        with self._lock:
            item = self._data.pop(key, None)
        return default if item is None else item[1]

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def purge_expired(self, now: Optional[float] = None) -> int:
        """Удаляет просроченные записи (для фоновых чисток). Возвращает число удалённых."""
        now = time.monotonic() if now is None else now
        with self._lock:
            dead = [k for k, (exp, _) in self._data.items() if exp <= now]
            for k in dead:
                del self._data[k]
        return len(dead)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key: Hashable) -> bool:
        return self.get(key, _MISSING) is not _MISSING

    def stats(self) -> dict:
        with self._lock:
            return {"size": len(self._data), "maxsize": self.maxsize, "ttl": self.ttl,
                    "hits": self.hits, "misses": self.misses}


class SingleFlight:
    """Склейка одинаковых одновременных async-запросов внутри одного процесса.

        result = await sf.run(key, lambda: fetch_tile(z, x, y))

    Первая корутина выполняет factory(), остальные с тем же key ждут тот же
    Future. Исключение фабрики пробрасывается всем ожидающим; ключ после
    завершения снимается, так что повтор запроса пойдёт заново.
    """

    __slots__ = ("_inflight", "coalesced")

    def __init__(self) -> None:
        self._inflight: Dict[Hashable, "asyncio.Future[Any]"] = {}
        self.coalesced = 0  # сколько запросов «приклеилось» к уже идущим

    async def run(self, key: Hashable, factory: Callable[[], Awaitable[Any]]) -> Any:
        loop = asyncio.get_running_loop()
        fut = self._inflight.get(key)
        if fut is not None:
            self.coalesced += 1
            # shield: отмена ожидающего не должна отменять общую работу
            return await asyncio.shield(fut)
        fut = loop.create_future()
        self._inflight[key] = fut
        try:
            result = await factory()
        except BaseException as exc:  # noqa: BLE001 — пробросить всем ожидающим
            if not fut.done():
                fut.set_exception(exc)
            raise
        else:
            if not fut.done():
                fut.set_result(result)
            return result
        finally:
            if self._inflight.get(key) is fut:
                del self._inflight[key]

    def __len__(self) -> int:
        return len(self._inflight)


class CircuitBreaker:
    """Закрыт (closed) — вызовы разрешены. После `threshold` подряд ошибок
    открывается на `cooldown` секунд: allow() → False, зависимость не трогаем.
    По истечении cooldown пропускает одну пробу (half-open); успех закрывает."""

    __slots__ = ("name", "threshold", "cooldown", "_fails", "_opened_at", "_lock", "trips")

    def __init__(self, name: str = "", threshold: int = 3, cooldown: float = 30.0):
        self.name = name
        self.threshold = max(1, int(threshold))
        self.cooldown = float(cooldown)
        self._fails = 0
        self._opened_at: Optional[float] = None
        self._lock = threading.Lock()
        self.trips = 0

    def allow(self, now: Optional[float] = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            if self._opened_at is None:
                return True
            if now - self._opened_at >= self.cooldown:
                # half-open: даём одну пробу, следующая ошибка откроет снова
                self._opened_at = now
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self._fails = 0
            self._opened_at = None

    def record_failure(self, now: Optional[float] = None) -> bool:
        """Возвращает True, если именно этот отказ открыл предохранитель."""
        now = time.monotonic() if now is None else now
        with self._lock:
            self._fails += 1
            if self._fails >= self.threshold and self._opened_at is None:
                self._opened_at = now
                self.trips += 1
                return True
            if self._opened_at is not None:
                self._opened_at = now
            return False

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._opened_at is not None

    def state(self) -> dict:
        with self._lock:
            return {"name": self.name, "open": self._opened_at is not None,
                    "fails": self._fails, "trips": self.trips}


class Throttle:
    """should(key) → True не чаще одного раза в `interval` секунд на ключ.
    Память ограничена maxsize ключей (старые вытесняются)."""

    __slots__ = ("_last", "_lock", "interval", "maxsize")

    def __init__(self, interval: float = 60.0, maxsize: int = 20000):
        self._last: "collections.OrderedDict[Hashable, float]" = collections.OrderedDict()
        self._lock = threading.Lock()
        self.interval = float(interval)
        self.maxsize = max(1, int(maxsize))

    def should(self, key: Hashable, now: Optional[float] = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            last = self._last.get(key)
            if last is not None and now - last < self.interval:
                return False
            self._last[key] = now
            self._last.move_to_end(key)
            while len(self._last) > self.maxsize:
                self._last.popitem(last=False)
            return True

    def forget(self, key: Hashable) -> None:
        with self._lock:
            self._last.pop(key, None)


class AdaptiveGate:
    """Адаптивный лимит одновременных запросов к внешнему сервису (AIMD).

    GeoServer с control-flow отвечает 429, когда с одного IP идёт больше N
    запросов сразу; N заранее неизвестен и меняется с настройками сервера.
    Ворота начинают с `initial`, при 429 сужаются (×0.7), после `limit`
    успешных ответов подряд расширяются на 1 — выходят на реальный потолок
    без ручной подстройки. Только для asyncio-кода одного event loop.

        async with gate:            # ждёт свободный слот
            resp = await fetch()
        gate.report(resp.status_code == 429)
    """

    __slots__ = ("name", "limit", "min_limit", "max_limit", "active", "_ok_streak",
                 "_cond", "throttled", "waits", "grow_interval", "_last_grow", "_last_throttle")

    def __init__(self, name: str = "", initial: int = 12, min_limit: int = 2, max_limit: int = 64,
                 grow_interval: float = 10.0):
        self.name = name
        self.grow_interval = float(grow_interval)  # расти не чаще раза в N с: каждая проба вверх стоит один 429
        self._last_grow = 0.0
        self._last_throttle = 0.0
        self.limit = max(min_limit, int(initial))
        self.min_limit = max(1, int(min_limit))
        self.max_limit = max(self.limit, int(max_limit))
        self.active = 0
        self._ok_streak = 0
        self._cond: Optional[asyncio.Condition] = None
        self.throttled = 0   # сколько раз сервер ответил 429
        self.waits = 0       # сколько запросов ждали слот

    def _c(self) -> asyncio.Condition:
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    async def __aenter__(self):
        c = self._c()
        async with c:
            if self.active >= self.limit:
                self.waits += 1
            while self.active >= self.limit:
                await c.wait()
            self.active += 1
        return self

    async def __aexit__(self, *exc):
        c = self._c()
        async with c:
            self.active -= 1
            c.notify()

    def report(self, throttled: bool) -> None:
        """Сообщить результат запроса; вызывать после выхода из контекста."""
        now = time.monotonic()
        if throttled:
            self.throttled += 1
            self._ok_streak = 0
            if now - self._last_throttle > 0.5:  # пачка 429 за полсекунды — одно событие, а не каскад ×0.7
                self.limit = max(self.min_limit, int(self.limit * 0.7))
            self._last_throttle = now
        else:
            self._ok_streak += 1
            if (self._ok_streak >= self.limit and self.limit < self.max_limit
                    and now - self._last_grow >= self.grow_interval):
                self.limit += 1
                self._ok_streak = 0
                self._last_grow = now
                if self._cond is not None and self._cond._waiters:  # noqa: SLF001 — разбудить ожидающих
                    asyncio.get_running_loop().call_soon(self._notify_one)

    def _notify_one(self):
        async def _n():
            async with self._cond:
                self._cond.notify()
        asyncio.ensure_future(_n())

    def state(self) -> dict:
        return {"name": self.name, "limit": self.limit, "active": self.active,
                "throttled": self.throttled, "waits": self.waits}


def no_store(base: Optional[dict] = None) -> dict:
    """Заголовки для ответов-ошибок тайлов: браузер, nginx и Redis их не кэшируют.
    Передаваемые `base` заголовки сохраняются, кроме кэширующих."""
    h = {k: v for k, v in (base or {}).items()
         if k.lower() not in ("cache-control", "expires", "x-accel-expires", "etag", "last-modified")}
    h["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    h["X-Accel-Expires"] = "0"
    h["Pragma"] = "no-cache"
    return h


__all__ = ["TTLCache", "SingleFlight", "CircuitBreaker", "Throttle", "AdaptiveGate", "no_store"]
