"""Проверки perf_kit (v20.13). Запуск: python tests/perf_kit/test_perf_kit.py  (или pytest)."""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "geoservice"))
import perf_kit as pk  # noqa: E402


def test_ttl_cache_lru_and_expiry():
    c = pk.TTLCache(maxsize=2, ttl=0.05)
    c.put("a", 1); c.put("b", 2); c.put("c", 3)
    assert c.get("a") is None          # вытеснен по maxsize
    assert c.get("c") == 3
    time.sleep(0.06)
    assert c.get("c") is None          # истёк TTL
    c.put("d", 4, ttl=10); assert "d" in c and len(c) >= 1
    assert c.purge_expired() == 1       # "b" истёк, но не читался — удаляется чисткой


def test_circuit_breaker():
    br = pk.CircuitBreaker("t", threshold=2, cooldown=0.05)
    assert br.allow()
    assert br.record_failure() is False and br.allow()
    assert br.record_failure() is True and not br.allow() and br.is_open
    time.sleep(0.06)
    assert br.allow()                   # half-open: одна проба
    br.record_success(); assert not br.is_open and br.trips == 1


def test_throttle():
    t = pk.Throttle(interval=0.05, maxsize=2)
    assert t.should("x") and not t.should("x")
    time.sleep(0.06); assert t.should("x")
    t.should("y"); t.should("z")        # вытеснение старого ключа
    assert t.should("x")


def test_single_flight_coalesces():
    async def go():
        sf = pk.SingleFlight(); calls = [0]
        async def work():
            calls[0] += 1; await asyncio.sleep(0.05); return 42
        res = await asyncio.gather(*[sf.run("k", work) for _ in range(50)])
        assert res == [42] * 50 and calls[0] == 1 and sf.coalesced == 49 and len(sf) == 0
        async def boom():
            await asyncio.sleep(0.01); raise ValueError("x")
        res = await asyncio.gather(*[sf.run("e", boom) for _ in range(5)], return_exceptions=True)
        assert all(isinstance(r, ValueError) for r in res)   # ошибка доставлена всем
    asyncio.run(go())


def test_no_store_headers():
    h = pk.no_store({"Cache-Control": "max-age=1", "ETag": "x", "Vary": "A", "X-Accel-Expires": "9"})
    assert h["Vary"] == "A" and "ETag" not in h
    assert h["Cache-Control"].startswith("no-store") and h["X-Accel-Expires"] == "0"


def test_adaptive_gate_aimd():
    async def go():
        g = pk.AdaptiveGate("t", initial=4, min_limit=2, max_limit=6, grow_interval=0.0)
        peak = [0]
        async def one(throttle):
            async with g:
                peak[0] = max(peak[0], g.active); await asyncio.sleep(0.005)
            g.report(throttle)
        await asyncio.gather(*[one(False) for _ in range(20)])
        assert peak[0] <= 6 and g.waits > 0            # не выше max_limit, очередь была
        assert g.limit > 4                              # успехи расширили ворота
        lim = g.limit
        g.report(True)
        assert g.limit == max(2, int(lim * 0.7))        # 429 сужает ×0.7
        for _ in range(10):
            g._last_throttle = 0.0; g.report(True)   # разнесённые по времени 429
        assert g.limit == 2                             # не ниже min_limit
    asyncio.run(go())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
    print("perf_kit: все проверки пройдены")
