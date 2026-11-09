# -*- coding: utf-8 -*-
"""
jobkit.py — общая очередь фоновых заданий для тяжёлых обработчиков геосервиса (v19):
LesoLidar (облака точек) и привязка планов / MBTiles (раздел «Конвертер СК»).

Почему отдельный модуль: сервер работает в нескольких процессах (uvicorn --workers 4).
Очередь лежит на диске, исполняет её ровно один процесс (межпроцессная блокировка файла,
снимается ОС, если процесс упал), вывод обработчика пишется прямо в log.txt задания —
поэтому ход и журнал видны из любого процесса, отмена работает через флаг cancel.flag,
а обработка, пережившая перезапуск сервера, «подхватывается» новым исполнителем.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

MB = 1024 * 1024
ID_RE = re.compile(r"^[0-9a-f]{12,32}$")
PROGRESS_RE = re.compile(r"^\s*\[\s*(\d{1,3})%\]\s*(.*)$")
IS_WIN = os.name == "nt"


def _now() -> float:
    return time.time()


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _decode(raw: bytes) -> str:
    """Строки LesoLidar: UTF-8, а у собранного exe без консоли — иногда кодовая страница Windows."""
    for enc in ("utf-8", "cp1251", "cp866"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def _atomic_json(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for attempt in range(40):          # Windows: замена файла, открытого другим процессом на чтение
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05)
    os.replace(tmp, path)


def _read_json(path: Path, default=None):
    for attempt in range(20):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except PermissionError:
            time.sleep(0.05)
        except (OSError, ValueError):
            return default
    return default


def _pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    if IS_WIN:
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            return bool(ok) and code.value == 259    # STILL_ACTIVE
        except Exception:
            return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def _kill_pid_tree(pid: int) -> None:
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"], capture_output=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
        else:
            try:
                os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
            except ProcessLookupError:
                return
            for _ in range(50):
                if not _pid_alive(pid):
                    return
                time.sleep(0.1)
            os.killpg(os.getpgid(int(pid)), signal.SIGKILL)
    except Exception:
        pass


def _safe_name(name: str, fallback: str = "file") -> str:
    base = os.path.basename(str(name or "")).strip().replace("\x00", "")
    base = re.sub(r"[^\w.\- ()\[\]№]+", "_", base, flags=re.U)[:120].strip(" .") or fallback
    return base


def _check_id(value: str, what: str = "id") -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise HTTPException(404, f"Неизвестный {what}")
    return value



def popen_kwargs(env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Процесс без окна консоли и в своей группе — чтобы отмена снимала всё дерево процессов."""
    kw: Dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT}
    if env is not None:
        kw["env"] = env
    if IS_WIN:
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) | \
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
    else:
        kw["start_new_session"] = True
    return kw


def child_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    if extra:
        env.update(extra)
    return env


def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000))
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


class _ProcessLock:
    """Межпроцессная блокировка файла: uvicorn запущен с --workers 4, а очередь обработки
    должен исполнять ровно один процесс. Блокировку снимает ОС, если процесс завершился."""

    def __init__(self, path: Path):
        self.path = path
        self.fh = None

    def acquire(self) -> bool:
        if self.fh is not None:
            return True
        try:
            fh = open(self.path, "a+b")
        except OSError:
            return False
        try:
            if IS_WIN:
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self.fh = fh
        try:
            self.path.with_name(self.path.name + ".pid").write_text(str(os.getpid()), encoding="ascii")
        except OSError:
            pass
        return True

    def release(self) -> None:
        fh, self.fh = self.fh, None
        if fh is None:
            return
        try:
            if IS_WIN:
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        fh.close()


class JobStore:
    """Задания на диске: <root>/jobs/<id>/job.json, log.txt, cancel.flag, out/.
    Подкласс задаёт команду (command_for), разбор строк журнала (parse_line) и проверку
    результата (on_success). Остальное — очередь, исполнитель, отмена, восстановление — здесь."""

    POLL = 0.4
    SUBDIRS: Tuple[str, ...] = ("jobs",)
    STAGES: List[str] = []
    KIND = "задание"

    def __init__(self, root: Path, log=None, max_jobs: int = 1, timeout_s: float = 6 * 3600, keep: int = 200,
                 keep_hours: Optional[float] = None, start_runner: bool = True):
        self.root = Path(root)
        self.log = log
        for sub in self.SUBDIRS:
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cv = threading.Condition(self.lock)
        self.claimed: set = set()
        self.procs: Dict[str, Optional[subprocess.Popen]] = {}
        self.max_jobs = max(1, min(4, int(max_jobs)))
        self.timeout = float(timeout_s)
        self.keep = int(keep)
        self.keep_hours = keep_hours
        self.runner_lock = _ProcessLock(self.root / "runner.lock")
        self.is_runner = False
        self._stop = threading.Event()
        if start_runner:
            threading.Thread(target=self._supervisor, name=f"{self.root.name}-supervisor", daemon=True).start()

    # ── подклассу ──
    def command_for(self, j: Dict[str, Any]) -> Tuple[List[str], Path, Optional[Dict[str, str]]]:
        raise NotImplementedError

    def parse_line(self, j: Dict[str, Any], line: str, t0: float) -> bool:
        """По умолчанию — строки «[ NN%] текст» (прогресс) и последнее сообщение."""
        m = PROGRESS_RE.match(line)
        if m:
            self.set_progress(j, int(m.group(1)), m.group(2).strip(), t0)
            return True
        if not line.startswith((" ", "{", "}", "\"")):
            j["last_message"] = line.strip()[:300]
        return False

    def on_success(self, j: Dict[str, Any], rc: Optional[int]) -> bool:
        return rc == 0

    def error_message(self, j: Dict[str, Any], rc: Optional[int], tail: List[str]) -> str:
        msg = next((t for t in reversed(tail) if re.search(r"(Error|Ошибка|ошибка|Exception|слишком|не удалось|нет |SystemExit)", t)), None)
        if rc is None and not msg:
            msg = "Обработка прервана (перезапуск сервера?) — запустите задание повторно"
        return (msg or (tail[-1] if tail else f"Код завершения {rc}"))[:600]

    def output_files(self, jid: str) -> List[Dict[str, Any]]:
        return []

    def stages_for(self, j: Dict[str, Any]) -> List[str]:
        """Этапы задания (для шкалы в интерфейсе); у разных видов заданий могут отличаться."""
        return self.STAGES

    # ── общие ──
    def set_progress(self, j: Dict[str, Any], pct: int, text: str, t0: float) -> None:
        pct = max(0, min(100, int(pct)))
        j["progress"] = max(int(j.get("progress") or 0), pct) if pct < 100 else 100
        if text:
            j["stage"] = text[:200]
            for i, s in enumerate(self.stages_for(j)):
                if text.lower().startswith(s[:14].lower()):
                    j["stage_index"] = i
        el = _now() - t0
        p = j["progress"]
        if 3 <= p < 100 and el > 2:
            eta = el * (100 - p) / p
            prev = j.get("eta_s")
            j["eta_s"] = round(eta if prev is None else prev * 0.6 + eta * 0.4, 1)

    def jdir(self, jid: str) -> Path:
        return self.root / "jobs" / _check_id(jid, self.KIND)

    def job(self, jid: str) -> Dict[str, Any]:
        j = _read_json(self.jdir(jid) / "job.json")
        if not j:
            raise HTTPException(404, "Задание не найдено")
        return j

    def save_job(self, j: Dict[str, Any]) -> None:
        jd = self.jdir(j["id"])
        if not jd.is_dir():           # задание удалили, пока оно выполнялось
            return
        with self.lock:
            _atomic_json(jd / "job.json", j)

    def jobs(self) -> List[Dict[str, Any]]:
        out = []
        for d in (self.root / "jobs").iterdir():
            j = _read_json(d / "job.json") if d.is_dir() else None
            if j:
                out.append(j)
        out.sort(key=lambda j: j.get("created", 0), reverse=True)
        return out

    def enqueue(self, j: Dict[str, Any]) -> None:
        with self.cv:
            self.save_job(j)
            self.cv.notify_all()

    def cancel_requested(self, jid: str) -> Optional[str]:
        p = self.jdir(jid) / "cancel.flag"
        if not p.is_file():
            return None
        try:
            return p.read_text(encoding="utf-8").strip() or "user"
        except OSError:
            return "user"

    def cancel(self, jid: str, reason: str = "user") -> Dict[str, Any]:
        j = self.job(jid)
        if j.get("status") not in ("queued", "running"):
            return j
        try:
            (self.jdir(jid) / "cancel.flag").write_text(reason, encoding="utf-8")
        except OSError:
            pass
        if j.get("status") == "queued" and jid not in self.claimed:
            # исполнитель увидит флаг и не запустит; статус меняем сразу, чтобы интерфейс не ждал
            j.update(status="cancelled", finished=_now(), error="Отменено до запуска")
            self.save_job(j)
            return j
        pid = j.get("pid")
        proc = self.procs.get(jid)
        if proc is not None:
            kill_tree(proc)
        elif pid and _pid_alive(pid):
            _kill_pid_tree(int(pid))       # задание исполняет другой процесс сервера
        j["cancel_requested"] = True
        return j

    def delete(self, jid: str) -> bool:
        j = self.job(jid)
        if j.get("status") in ("queued", "running"):
            self.cancel(jid)
            for _ in range(100):           # исполнитель (возможно, другой процесс) снимает обработку
                if (_read_json(self.jdir(jid) / "job.json") or {}).get("status") not in ("queued", "running"):
                    break
                time.sleep(0.1)
        for _ in range(20):                # Windows: файлы журнала могут быть ещё открыты
            shutil.rmtree(self.jdir(jid), ignore_errors=True)
            if not self.jdir(jid).exists():
                break
            time.sleep(0.25)
        return not self.jdir(jid).exists()

    # ── исполнитель очереди (один на сервер) ──
    def _supervisor(self) -> None:
        while not self._stop.is_set():
            if self.runner_lock.acquire():
                self.is_runner = True
                try:
                    self._recover()
                except Exception as e:  # noqa
                    self._log("warning", f"{self.root.name}: восстановление очереди: {e}")
                for i in range(self.max_jobs):
                    threading.Thread(target=self._worker, name=f"{self.root.name}-{i}", daemon=True).start()
                return
            self._stop.wait(3.0)

    def stop(self) -> None:          # для тестов
        self._stop.set()
        with self.cv:
            self.cv.notify_all()
        self.runner_lock.release()

    def _log(self, level: str, msg: str) -> None:
        if self.log is not None:
            try:
                getattr(self.log, level)(msg)
            except Exception:
                pass

    def _recover(self) -> None:
        """Процесс стал исполнителем: задания со статусом running либо ещё выполняются
        (обработчик пережил перезапуск сервера — следим дальше), либо уже закончились."""
        for j in self.jobs():
            if j.get("status") != "running":
                continue
            pid = j.get("pid")
            if pid and _pid_alive(pid):
                with self.lock:
                    self.claimed.add(j["id"])
                threading.Thread(target=self._adopt, args=(j,), daemon=True).start()
            else:
                self._finish(j, rc=None)

    def _adopt(self, j: Dict[str, Any]) -> None:
        try:
            self._monitor(j, proc=None)
        finally:
            with self.lock:
                self.claimed.discard(j["id"])

    def _next(self) -> Optional[Dict[str, Any]]:
        queued = [j for j in self.jobs() if j.get("status") == "queued" and j["id"] not in self.claimed]
        queued.sort(key=lambda j: j.get("created", 0))
        return queued[0] if queued else None

    def _worker(self) -> None:
        while not self._stop.is_set():
            with self.cv:
                j = self._next()
                if j is None:
                    self.cv.wait(1.5)      # задания могут поставить другие процессы — опрос диска
                    continue
                self.claimed.add(j["id"])
            try:
                self._start(j)
            except Exception as e:  # noqa
                j.update(status="error", finished=_now(), error=f"Сбой запуска обработчика: {e}"[:600])
                self.save_job(j)
            finally:
                with self.lock:
                    self.claimed.discard(j["id"])
                    self.procs.pop(j["id"], None)
                try:
                    self.prune()
                except Exception:
                    pass

    def prune(self) -> None:
        done = [j for j in self.jobs() if j.get("status") in ("done", "error", "cancelled")]
        old = done[self.keep:]
        if self.keep_hours:
            edge = _now() - self.keep_hours * 3600
            old += [j for j in done[:self.keep] if float(j.get("finished") or j.get("created") or 0) < edge]
        for j in old:
            shutil.rmtree(self.jdir(j["id"]), ignore_errors=True)

    def _start(self, j: Dict[str, Any]) -> None:
        jid = j["id"]
        jd = self.jdir(jid)
        if self.cancel_requested(jid):
            j.update(status="cancelled", finished=_now(), error="Отменено до запуска")
            self.save_job(j)
            return
        (jd / "out").mkdir(exist_ok=True)
        cmd, cwd, env = self.command_for(j)
        logp = jd / "log.txt"
        with open(logp, "ab") as lf:
            lf.write(("Запуск: " + time.strftime("%Y-%m-%d %H:%M:%S") + "\n").encode("utf-8"))
            lf.flush()
            start_pos = lf.tell()
            kw = popen_kwargs(env)
            kw["stdout"], kw["stderr"] = lf, subprocess.STDOUT
            proc = subprocess.Popen(cmd, cwd=str(cwd), **kw)
        with self.lock:
            self.procs[jid] = proc
        stages = self.stages_for(j)
        j.update(status="running", started=_now(), progress=0, stage=stages[0] if stages else "Обработка",
                 stage_index=0, pid=proc.pid, runner_pid=os.getpid(), log_pos=start_pos, error=None)
        self.save_job(j)
        self._monitor(j, proc=proc)

    def _monitor(self, j: Dict[str, Any], proc: Optional[subprocess.Popen]) -> None:
        jid = j["id"]
        jd = self.jdir(jid)
        logp = jd / "log.txt"
        pos = int(j.get("log_pos") or 0)
        t0 = float(j.get("started") or _now())
        pending = b""
        last_save = 0.0
        tail: List[str] = list(j.get("tail") or [])
        killed: Optional[str] = None

        def feed(raw: bytes) -> bool:
            line = _decode(raw).rstrip("\r")
            if not line.strip():
                return False
            tail.append(line[:1200])
            del tail[:-12]
            return bool(self.parse_line(j, line, t0))

        while True:
            alive = (proc.poll() is None) if proc is not None else _pid_alive(j.get("pid"))
            try:
                with open(logp, "rb") as f:
                    f.seek(pos)
                    data = f.read(4 * MB)
            except OSError:
                data = b""
            changed = False
            if data:
                pos += len(data)
                pending += data
                *lines, pending = pending.split(b"\n")
                for raw in lines:
                    changed |= feed(raw)
            now = _now()
            if alive and not killed:
                reason = self.cancel_requested(jid)
                if not reason and now - t0 > self.timeout:
                    reason = "timeout"
                if reason:
                    killed = reason
                    if proc is not None:
                        kill_tree(proc)
                    elif j.get("pid"):
                        _kill_pid_tree(int(j["pid"]))
            if not alive:
                if pending.strip():
                    feed(pending)
                break
            if changed or now - last_save > 1.0:
                j["elapsed_s"] = round(now - t0, 1)
                j["log_pos"] = pos
                j["tail"] = tail[-12:]
                if not jd.is_dir():          # задание удалено
                    if proc is not None:
                        kill_tree(proc)
                    return
                self.save_job(j)
                last_save = now
            time.sleep(self.POLL)
        j["log_pos"] = pos
        j["tail"] = tail[-12:]
        self._finish(j, rc=proc.returncode if proc is not None else None, killed=killed)

    def _finish(self, j: Dict[str, Any], rc: Optional[int], killed: Optional[str] = None) -> None:
        jid = j["id"]
        jd = self.jdir(jid)
        if not jd.is_dir():
            return
        killed = killed or self.cancel_requested(jid)
        j["finished"] = _now()
        j["elapsed_s"] = round(j["finished"] - float(j.get("started") or j["finished"]), 1)
        j["eta_s"] = None
        j.pop("pid", None)
        tail = j.get("tail") or []
        if killed:
            j["status"] = "cancelled"
            j["error"] = "Превышено время обработки" if killed == "timeout" else "Отменено пользователем"
        else:
            try:
                ok = self.on_success(j, rc)
            except Exception as e:  # noqa
                ok = False
                tail = tail + [f"Ошибка разбора результата: {e}"]
            if ok:
                j["status"] = "done"
                j["progress"] = 100
                j["stage"] = "Готово"
                j["stage_index"] = len(self.stages_for(j))
                j["files"] = self.output_files(jid)
                j["error"] = None
            else:
                j["status"] = "error"
                j["error"] = self.error_message(j, rc, tail)
        self.save_job(j)
        self.after_finish(j)

    def after_finish(self, j: Dict[str, Any]) -> None:
        pass
