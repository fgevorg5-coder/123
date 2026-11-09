# -*- coding: utf-8 -*-
"""
geocoder.py — поиск адресов (Беларусь) с исправлением опечаток. [v20]

Используется поиском на карте (/api/geocode) и «План → GeoTIFF» (georef_runner.py).
Порядок поиска (останавливается на первом найденном):
  1. Nominatim (OSM): адрес как есть и с раскрытыми сокращениями (ул. → улица, пр-т → проспект…);
  2. Nominatim, структурный запрос: улица + дом + населённый пункт;
  3. исправление опечаток в названии улицы: список улиц населённого пункта (OSM, Overpass API,
     кэш на диске 30 дней) → ближайшие по написанию и звучанию («Долгобротская» → «Долгобродская»);
  4. без Overpass — варианты звонких/глухих согласных и безударных гласных (д↔т, б↔п, о↔а…).
Если дом не найден, но улица есть — возвращается середина улицы (approx=True).
Населённый пункт узнаётся и без «г.»: «Брест, ул. Советская 10», «ул. Советская 10, Гомель», «Минск Долгобродская 38»;
найденное в другом месте отбрасывается (Nominatim на «Брест» добирает всю Брестскую область).

Без сторонних пакетов (urllib). Nominatim — не чаще 1 запроса в секунду (правила OSMF).
Переменные окружения: GEOCODER_NOMINATIM, GEOCODER_OVERPASS, GEOCODER_UA, GEOCODER_CACHE_DIR,
GEOCODER_DEFAULT_CITY (по умолчанию «Минск»), GEOCODER_OFF=1 — только Nominatim без исправлений.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

NOMINATIM = os.environ.get("GEOCODER_NOMINATIM", "https://nominatim.openstreetmap.org").rstrip("/")
OVERPASS = [u.strip() for u in os.environ.get("GEOCODER_OVERPASS", "https://overpass-api.de/api/interpreter,"
             "https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",") if u.strip()]
UA = os.environ.get("GEOCODER_UA", "ODZiML-Geoportal/1.2 (geocoder; internal)")
DEFAULT_CITY = os.environ.get("GEOCODER_DEFAULT_CITY", "Минск")
CACHE_DIR = Path(os.environ.get("GEOCODER_CACHE_DIR") or (Path(__file__).resolve().parent / "data" / "geocoder_cache"))
BY_BOX = (51.2, 56.2, 23.1, 32.8)          # lat_min, lat_max, lon_min, lon_max (Беларусь с запасом)

_lock = threading.Lock()
_last_call = [0.0]
_mem: Dict[str, Tuple[float, Any]] = {}
_MEM_TTL = 3600.0

TYPE_FULL = [  # сокращение → полное (порядок важен: длинные первыми)
    (r"пр-?т\.?|просп\.?|пр\.(?=\s*[А-ЯЁA-Z])", "проспект"), (r"ул\.?", "улица"), (r"пер\.?", "переулок"),
    (r"пр-?д\.?", "проезд"), (r"б-р\.?|бул\.?", "бульвар"), (r"пл\.?", "площадь"), (r"ш\.", "шоссе"),
    (r"тр-?т\.?", "тракт"), (r"наб\.?", "набережная"), (r"туп\.?", "тупик"), (r"мкр-?н?\.?|м-н\.?", "микрорайон"),
]
TYPE_WORDS = {"улица", "проспект", "переулок", "проезд", "бульвар", "площадь", "шоссе", "тракт", "набережная",
              "тупик", "микрорайон", "аллея", "спуск", "линия", "дорога", "вуліца", "праспект", "завулак",
              "плошча", "шаша", "тупік", "набярэжная", "мікрараён", "праезд", "алея", "ул", "пр", "пер"}
PLACE_RE = re.compile(r"(?i)(?:^|[,;]\s*|\s)(?:г\.|гор\.|город|г\.\s*п\.|гп|аг\.|агрогородок|пос\.|посёлок|поселок|"
                      r"д\.(?=\s*[А-ЯЁ])|дер\.|деревня|с\.|село)\s*([А-ЯЁ][А-Яа-яЁё\-]+(?:\s+[А-ЯЁ][а-яё\-]+)?)")
# [v20] населённые пункты, которые узнаются и без «г.» и запятой («Гомель ул. Советская 10»)
KNOWN_PLACES = set("""минск брест витебск гомель гродно могилев бобруйск барановичи борисов пинск орша мозырь солигорск
новополоцк лида молодечно полоцк жлобин светлогорск речица жодино слуцк кобрин слоним волковыск калинковичи сморгонь
рогачев осиповичи новогрудок вилейка дзержинск заславль фаниполь смолевичи логойск столбцы несвиж островец ошмяны
поставы глубокое лепель новолукомль кричев климовичи шклов быхов добруш хойники петриков лунинец дрогичин пружаны
каменец жабинка малорита столин ганцевичи ляховичи мядель воложин копыль клецк любань червень березино крупки
ивацевичи микашевичи щучин скидель дятлово ивье кореличи зельва свислочь вороново браслав докшицы миоры верхнедвинск
сенно толочин чашники бешенковичи лиозно ушачи россоны дубровно наровля ельск лельчицы житковичи ветка чечерск
брагин лоев мінск брэст віцебск гродна магілеў""".split()) | {"марьина горка", "старые дороги", "буда-кошелево"}
_REGION_RE = re.compile(r"(?i)(?<![а-яё])(район|р-н|область|обл\.?|сельсовет|с/с|сельский совет)(?![а-яё])")
_HOUSE_ONLY_RE = re.compile(r"(?i)^(?:д(?:ом)?\.?\s*)?\d{1,4}[а-яё]?(?:\s*/\s*\d{1,4}[а-яё]?)?(?:\s*(?:к|корп|корпус)\.?\s*\d{1,3})?$")
_PLACE_WORD_RE = re.compile(r"^[А-ЯЁІЎA-Z][А-Яа-яЁёІіЎў\-]+(?:\s+[А-ЯЁІЎа-яёіў][А-Яа-яЁёІіЎў\-]+){0,2}$")


_BE_ALIAS = {"мінск": "минск", "брэст": "брест", "віцебск": "витебск", "гродна": "гродно", "магілеў": "могилев",
             "бабруйск": "бобруйск", "барысаў": "борисов", "пінск": "пинск", "мазыр": "мозырь", "маладзечна": "молодечно",
             "полацк": "полоцк", "наваполацк": "новополоцк", "ліда": "лида", "салігорск": "солигорск",
             "баранавічы": "барановичи", "жодзіна": "жодино", "слонім": "слоним", "кобрын": "кобрин"}


def _pnorm(v) -> str:
    v = str(v or "").lower().replace("ё", "е").strip(" ,;")
    v = re.sub(r"^(?:г\.\s*п\.|г\.|гп|гор\.|город|аг\.|агрогородок|д\.|дер\.|деревня|пос\.|поселок|с\.|село)\s*", "", v)
    v = v.strip()
    return _BE_ALIAS.get(v, v)


def _has_type(seg: str) -> bool:
    return any(w in TYPE_WORDS for w in re.findall(r"[а-яёіў]+", seg.lower()))


def split_place(s: str) -> Tuple[Optional[str], str]:
    """[v20] Населённый пункт без «г.»: «Брест, ул. Советская 10», «ул. Советская 10, Брест», «Минск, Долгобродская 38»,
    «Гомель ул. Советская 10». Возвращает (город | None, адрес без города и без района/области)."""
    parts = [x.strip() for x in s.split(",") if x.strip()]
    if len(parts) > 1:
        parts = [x for x in parts if not _REGION_RE.search(x)] or parts
        house = [x for x in parts if _HOUSE_ONLY_RE.match(x)]
        rest = [x for x in parts if not _HOUSE_ONLY_RE.match(x)]
        street = next((x for x in rest if _has_type(x)), None) or next((x for x in rest if re.search(r"\d", x)), None)
        if street is None and house:                       # «Брест, Советская, 10» — улица перед номером дома
            i = parts.index(house[0])
            street = next((parts[j] for j in range(i - 1, -1, -1) if not _HOUSE_ONLY_RE.match(parts[j])), None)
        cands = [x for x in rest if x is not street and not re.search(r"\d", x) and _PLACE_WORD_RE.match(x)]
        if street is None and len(cands) == 2:            # «Брест, Советская» — город тот, что в списке
            known = [x for x in cands if _pnorm(x) in KNOWN_PLACES]
            if len(known) == 1:
                street = cands[1 - cands.index(known[0])]
                cands = known
        if street is not None and cands:
            city = next((x for x in cands if _pnorm(x) in KNOWN_PLACES), cands[0])
            return city, (street + (" " + house[0] if house and house[0] not in street else "")).strip()
        return None, s
    w = s.split()
    for n in (2, 1):
        if len(w) > n and " ".join(w[:n]).lower().replace("ё", "е") in KNOWN_PLACES:
            return " ".join(w[:n]), " ".join(w[n:])
    if len(w) > 2 and w[-1].lower().replace("ё", "е") in KNOWN_PLACES and re.search(r"\d", " ".join(w[:-1])):
        return w[-1], " ".join(w[:-1])
    return None, s


def in_place(item: Dict[str, Any], city: Optional[str]) -> bool:
    """[v20] Результат Nominatim — в указанном населённом пункте? («Брестская область» ≠ «Брест»)"""
    k = _pnorm(city)
    if not k:
        return True
    a = item.get("address") or {}
    vals = [a.get(f) for f in ("city", "town", "village", "hamlet", "municipality", "suburb", "city_district",
                               "locality", "isolated_dwelling")]
    vals += str(item.get("display_name") or "").split(",")
    return any(_pnorm(v) == k for v in vals if v)


def flag_approx(addr: str, items, P: Optional[Dict[str, Any]] = None):
    """[v20] В запросе есть номер дома, а найдена только улица — пометить _approx («дом не найден — центр улицы»)."""
    P = P or parse(addr)
    if not P.get("house"):
        return items
    out = []
    for x in items or []:
        a = x.get("address") or {}
        if not a.get("house_number") and (x.get("category") or x.get("class")) == "highway":
            x = dict(x)
            x["_approx"] = True
        out.append(x)
    return out


HOUSE_RE = re.compile(r"(?i)(?:\bд(?:ом)?\.?\s*)?(\d{1,4}[а-яё]?(?:\s*/\s*\d{1,4}[а-яё]?)?)"
                      r"(?:\s*,?\s*(?:к|корп|корпус)\.?\s*(\d{1,3}))?\s*$")


# ───────────────────────── HTTP ─────────────────────────
# ── [v20] межпроцессные замки: uvicorn запущен с несколькими воркерами, а правила OSM — 1 запрос/с на сервер ──
_IS_WIN = os.name == "nt"


def _open_lock(name: str):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        return open(CACHE_DIR / name, "a+b")
    except OSError:
        return None


def _flock(fh, block: bool) -> bool:
    try:
        fh.seek(0)
        if _IS_WIN:
            import msvcrt
            t_end = time.time() + (15.0 if block else 0.0)
            while True:
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    return True
                except OSError:
                    if time.time() >= t_end:
                        return False
                    time.sleep(0.05)
                    fh.seek(0)
        import fcntl
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | (0 if block else fcntl.LOCK_NB))
        return True
    except OSError:
        return False


def _funlock(fh) -> None:
    try:
        fh.seek(0)
        if _IS_WIN:
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def _throttle_nominatim(gap: float = 1.05) -> None:
    """Не чаще 1 запроса/с к Nominatim на весь сервер: потоки — _lock, воркеры — файл с меткой времени."""
    with _lock:
        fh = _open_lock(".nominatim.lock")
        got = bool(fh) and _flock(fh, True)
        try:
            last = _last_call[0]
            if got:
                try:
                    fh.seek(0)
                    last = max(last, float(fh.read(40).decode("ascii") or 0))
                except (ValueError, OSError):
                    pass
            wait = last + gap - time.time()
            if 0 < wait <= 5:
                time.sleep(wait)
            _last_call[0] = time.time()
            if got:
                try:
                    fh.seek(0)
                    fh.truncate()
                    fh.write(repr(_last_call[0]).encode("ascii"))
                    fh.flush()
                except OSError:
                    pass
        finally:
            if fh:
                if got:
                    _funlock(fh)
                fh.close()


def _http_json(url: str, timeout: float = 12.0, data: Optional[bytes] = None, throttle: bool = True):
    if throttle:
        _throttle_nominatim()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept-Language": "ru"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw.decode("utf-8")) if raw[:1] in (b"[", b"{") else raw.decode("utf-8", "replace")


def _cached(key: str, fn, ttl: float = _MEM_TTL):
    now = time.time()
    hit = _mem.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    if len(_mem) > 800:
        for k in sorted(_mem, key=lambda k: _mem[k][0])[:200]:
            _mem.pop(k, None)
    _mem[key] = (now, val)
    return val


def nominatim(q: Optional[str] = None, limit: int = 5, **structured) -> List[Dict[str, Any]]:
    """Один запрос к Nominatim (формат jsonv2 + addressdetails) с кэшем в памяти."""
    p = {"format": "jsonv2", "limit": max(1, min(int(limit), 20)), "countrycodes": "by",
         "accept-language": "ru", "addressdetails": 1, "namedetails": 1}       # [v20.1] name — для охвата улицы
    if q:
        p["q"] = q
    p.update({k: v for k, v in structured.items() if v})
    url = NOMINATIM + "/search?" + urllib.parse.urlencode(p)
    try:
        return _cached("n:" + url, lambda: _http_json(url) or [])
    except Exception:
        return []


# ───────────────────────── разбор адреса ─────────────────────────
def expand(addr: str) -> str:
    s = " " + re.sub(r"\s+", " ", str(addr or "")).strip(" ,;") + " "
    s = re.sub(r"(?i)\b(республика\s+)?беларусь\b,?|\bрб\b,?|\b\d{6}\b,?", " ", s)
    for pat, full in TYPE_FULL:
        s = re.sub(r"(?i)(?<![А-Яа-яЁё\w])(?:" + pat + r")(?=\s|(?-i:[А-ЯЁ])|$|(?<=\.))\s*", full + " ", s)   # [v20] «улица» ≠ «ул»+«ица»
    s = re.sub(r"(?i)(?<=\d)\s*(?:к|корп|корпус)\.?\s*(\d+)", r" к\1", s)
    return re.sub(r"\s+", " ", s).strip(" ,;")


def parse(addr: str, city: Optional[str] = None) -> Dict[str, Any]:
    """«г. Минск, ул. Долгобротская 38 к2» → {'city','street','stype','house','corp','core'}"""
    s = expand(addr)
    c = None
    m = PLACE_RE.search(" " + s)
    if m:
        c = m.group(1).strip()
        s = (" " + s)[:m.start()] + (" " + s)[m.end():]
    if not c:                                   # [v20] без «г.»: «Брест, ул. Советская 10»
        pc, rest = split_place(s)
        if pc:
            c, s = pc, rest
    if not c and city:
        c = city.strip()
    if c and re.search(r"(?i)(^|[\s,])" + re.escape(c) + r"($|[\s,])", s):
        s = re.sub(r"(?i)(^|[\s,])" + re.escape(c) + r"($|[\s,])", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" ,;")
    house = corp = None
    hm = HOUSE_RE.search(s)
    if hm and hm.start() > 0:
        house, corp = hm.group(1).replace(" ", ""), hm.group(2)
        s = s[:hm.start()].strip(" ,;")
    stype = None
    for w in s.lower().split():
        if w in TYPE_WORDS:
            stype = w
            break
    return {"city": c, "street": s, "stype": stype, "house": house, "corp": corp, "core": core_name(s)}


def core_name(name: str) -> str:
    s = str(name or "").lower().replace("ё", "е")
    s = re.sub(r"[^\w\s\-]", " ", s)
    words = [w for w in re.split(r"[\s\-]+", s) if w and w not in TYPE_WORDS]
    return " ".join(words)


_PH = str.maketrans({"д": "т", "б": "п", "г": "к", "з": "с", "в": "ф", "ж": "ш", "о": "а", "ы": "и", "э": "е",
                     "й": "и", "ё": "е", "ъ": "", "ь": "", "щ": "ш"})


def phon(s: str) -> str:
    return re.sub(r"(.)\1+", r"\1", s.translate(_PH))


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    r1 = difflib.SequenceMatcher(None, a, b).ratio()
    r2 = difflib.SequenceMatcher(None, phon(a), phon(b)).ratio() * 0.985
    return max(r1, r2)


# ───────────────────────── населённый пункт и его улицы ─────────────────────────
def _disk_get(name: str, max_age_s: float):
    p = CACHE_DIR / name
    try:
        if p.is_file() and time.time() - p.stat().st_mtime < max_age_s:
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _disk_put(name: str, val) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_DIR / (name + ".tmp")
        tmp.write_text(json.dumps(val, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, CACHE_DIR / name)
    except Exception:
        pass


def _key(s: str) -> str:
    return re.sub(r"[^\wа-яё]+", "_", s.lower())[:60]


def place_box(city: str) -> Optional[Tuple[float, float, float, float]]:
    """bbox населённого пункта (lat_min, lat_max, lon_min, lon_max) по Nominatim."""
    if not city:
        return None
    name = "place_" + _key(city) + ".json"
    hit = _disk_get(name, 90 * 86400)
    if hit:
        return tuple(hit) if hit != "none" else None
    best = None
    for it in nominatim(city, limit=5):
        if it.get("category") in ("place", "boundary") or it.get("addresstype") in ("city", "town", "village", "hamlet", "suburb"):
            bb = [float(v) for v in it.get("boundingbox") or []]
            if len(bb) == 4:
                best = (bb[0], bb[1], bb[2], bb[3])
                break
    if best and (best[1] - best[0]) * (best[3] - best[2]) > 1.2:      # не берём целую область/район
        best = None
    _disk_put(name, list(best) if best else "none")
    return best


_street_jobs: Dict[str, threading.Thread] = {}


def city_streets(city: str, timeout: float = 45.0, wait_s: Optional[float] = None) -> List[str]:
    """Названия улиц населённого пункта из OSM (name, name:ru, name:be), кэш на диске 30 дней.
    wait_s — сколько ждать загрузки, если кэша ещё нет: загрузка идёт в фоне и пригодится
    следующему поиску (None — ждать до конца)."""
    name = "streets_" + _key(city) + ".json"
    hit = _disk_get(name, 30 * 86400)
    if isinstance(hit, list) and hit:
        return hit
    if wait_s is not None:
        if time.time() - _streets_fail.get(name, 0.0) < 1800:      # недавно не загрузились — не ждём
            return []
        with _lock_streets:
            th = _street_jobs.get(name)
            if th is None or not th.is_alive():
                th = threading.Thread(target=_load_streets, args=(city, timeout), daemon=True, name="geocoder-streets")
                _street_jobs[name] = th
                th.start()
        th.join(max(0.0, wait_s))
        hit = _disk_get(name, 30 * 86400)
        return hit if isinstance(hit, list) else []
    return _load_streets(city, timeout)


_lock_streets = threading.Lock()
_streets_fail: Dict[str, float] = {}


def _load_streets(city: str, timeout: float = 45.0) -> List[str]:
    """[v20] Один воркер загружает список улиц, остальные ждут его результат (кэш на диске)."""
    name = "streets_" + _key(city) + ".json"
    fh = _open_lock("." + name + ".lock")
    if fh is not None and not _flock(fh, False):
        fh.close()
        t_end = time.time() + timeout + 20
        while time.time() < t_end:
            time.sleep(0.5)
            hit = _disk_get(name, 30 * 86400)
            if isinstance(hit, list) and hit:
                return hit
            f2 = _open_lock("." + name + ".lock")
            free = f2 is not None and _flock(f2, False)
            if f2 is not None:
                if free:
                    _funlock(f2)
                f2.close()
            if free:                      # тот воркер закончил без результата
                break
        hit = _disk_get(name, 30 * 86400)
        return hit if isinstance(hit, list) else []
    try:
        hit = _disk_get(name, 30 * 86400)
        if isinstance(hit, list) and hit:
            return hit
        return _load_streets_now(city, timeout)
    finally:
        if fh is not None:
            _funlock(fh)
            fh.close()


def _load_streets_now(city: str, timeout: float = 45.0) -> List[str]:
    name = "streets_" + _key(city) + ".json"
    bb = place_box(city)
    if not bb:
        return []
    q = ('[out:csv("name","name:ru","name:be";false;"|")][timeout:%d];'
         'way["highway"]["name"](%.5f,%.5f,%.5f,%.5f);out tags;') % (int(timeout), bb[0], bb[2], bb[1], bb[3])
    txt = ""
    for url in OVERPASS:                     # основной сервер и зеркала — до первого ответа
        try:
            txt = _http_json(url, timeout=timeout + 10, data=urllib.parse.urlencode({"data": q}).encode(), throttle=False)
        except Exception:
            continue
        if isinstance(txt, str) and txt.count("\n") > 20:
            break
    names = set()
    for line in str(txt or "").splitlines():
        for v in line.split("|"):
            v = v.strip()
            if v and re.search(r"[А-Яа-яЁёІіЎў]", v):
                names.add(v)
    res = sorted(names)
    if res:
        _disk_put(name, res)
        _streets_fail.pop(name, None)
    else:
        _streets_fail[name] = time.time()
    return res


def reverse_place(lat: float, lon: float) -> Optional[str]:
    """Название населённого пункта в точке (для поиска по карте без указания города)."""
    key = "rev_%.2f_%.2f" % (lat, lon)
    def fn():
        url = NOMINATIM + "/reverse?" + urllib.parse.urlencode({"lat": lat, "lon": lon, "zoom": 12, "format": "jsonv2",
                                                                  "accept-language": "ru", "addressdetails": 1})
        try:
            a = (_http_json(url) or {}).get("address") or {}
        except Exception:
            return None
        return a.get("city") or a.get("town") or a.get("village") or a.get("hamlet")
    return _cached(key, fn, ttl=7 * 86400)


# ───────────────────────── поиск ─────────────────────────
def _variants(addr: str, city: Optional[str]) -> List[str]:
    out: List[str] = []

    def add(q):
        q = re.sub(r"\s+", " ", q).strip(" ,;")
        if q and q not in out:
            out.append(q)
    a = re.sub(r"\s+", " ", str(addr or "")).strip()
    with_city = a if (not city or city.lower() in a.lower()) else f"{city}, {a}"
    add(with_city)
    e = expand(with_city)
    add(e)
    add(re.sub(r"(?i)(?<=\d)\s*,?\s*к\d+\b", "", e))
    return out


_PAIR = dict(zip("бвгджзпфктшс", "пфктшсбвгджз"))
_VOICED, _VOICELESS = set("бгджз"), set("пфктшсхцчщ")
_VOWEL = {"о": "а", "а": "о", "е": "и", "и": "е", "я": "е", "ы": "и"}


def _phon_variants(word: str, limit: int = 14) -> List[str]:
    """Вероятные исправления «как слышится»: сначала оглушение/озвончение согласных
    («Долгобротская» → «Долгобродская», «прозьба» → «просьба»), затем безударные гласные,
    двойные согласные и прочие замены звонких/глухих."""
    w = str(word or "").lower()
    n, cand = len(w), {}

    def add(v, sc):
        if v != w and (v not in cand or sc < cand[v]):
            cand[v] = sc
    for i, ch in enumerate(w):
        nxt = w[i + 1] if i + 1 < n else ""
        nn = w[i + 2] if nxt == "ь" and i + 2 < n else nxt      # «зь» + следующая буква
        if ch in _PAIR and i > 0:
            v = w[:i] + _PAIR[ch] + w[i + 1:]
            if ch in _VOICELESS and (nxt in _VOICELESS or nxt in ("", "ь")):
                add(v, 0.0)          # написали глухую, слышимую перед глухой: т(с) ← д(с)
            elif ch in _VOICED and nn in _VOICED:
                add(v, 0.3)          # озвончение перед звонкой: з(б) ← с(б)
            else:
                add(v, 2.0 + i / 100.0)
        if ch in _VOWEL and 0 < i < n - 1:
            add(w[:i] + _VOWEL[ch] + w[i + 1:], 1.0 + i / 100.0)
        if ch in "нслтмр" and 0 < i < n - 1:
            if nxt == ch:
                add(w[:i] + w[i + 1:], 1.2)
            elif ch in "нс" and nxt in "аоеиыяюу":
                add(w[:i] + ch + w[i:], 1.6)
    return [v for v, _ in sorted(cand.items(), key=lambda kv: kv[1])][:limit]


def _road(item: Dict[str, Any], default: str) -> str:
    """Название улицы так, как оно записано в OSM (для сообщения «исправлено …»)."""
    a = item.get("address") or {}
    return a.get("road") or a.get("pedestrian") or a.get("square") or default


def _mark(items, **extra):
    out = []
    for it in items or []:
        it = dict(it)
        it.update({k: v for k, v in extra.items() if v is not None})
        out.append(it)
    return out


def search(addr: str, city: Optional[str] = None, limit: int = 5, center: Optional[Tuple[float, float]] = None,
           fuzzy: bool = True, budget_s: float = 25.0) -> List[Dict[str, Any]]:
    """Список результатов в формате Nominatim (+ поля _corrected, _approx, _how).
    Итог кэшируется в памяти: найденное — на час, «не найдено» — на 10 минут."""
    ck = "s:%s|%s|%d|%s|%d" % (re.sub(r"\s+", " ", str(addr or "")).strip().lower(), (city or "").strip().lower(), int(limit),
                               "%.2f,%.2f" % tuple(center) if center else "", int(bool(fuzzy)))
    hit = _mem.get(ck)
    if hit and time.time() - hit[0] < (_MEM_TTL if hit[1] else 600.0):
        return [dict(x) for x in hit[1]]
    res = _search(addr, city, limit, center, fuzzy, budget_s)
    _mem[ck] = (time.time(), res)
    return [dict(x) for x in res]


def _search(addr: str, city: Optional[str], limit: int, center: Optional[Tuple[float, float]],
            fuzzy: bool, budget_s: float) -> List[Dict[str, Any]]:
    t0 = time.time()
    addr = re.sub(r"\s+", " ", str(addr or "")).strip()
    if len(addr) < 2:
        return []
    P = parse(addr, city)
    c = P["city"]
    # 1) как есть / с раскрытыми сокращениями
    fallback: List[Dict[str, Any]] = []
    for q in _variants(addr, c):
        js = nominatim(q, limit)
        if js:
            if not c:
                return _mark(flag_approx(addr, js, P), _how="nominatim")
            inside = [x for x in js if in_place(x, c)]
            if inside:
                return _mark(flag_approx(addr, inside + [x for x in js if not in_place(x, c)], P), _how="nominatim")
            fallback = js          # [v20] найдено, но не там («Брест, …» → любая «Советская 10» Брестской области)
            break
    if not fuzzy or os.environ.get("GEOCODER_OFF") == "1" or not P["street"]:
        return _mark(fallback, _how="nominatim")
    cities = [x for x in [c] if x]
    if not cities and center:
        rp = reverse_place(center[0], center[1])
        if rp:
            cities.append(rp)
    if DEFAULT_CITY and DEFAULT_CITY not in cities:
        cities.append(DEFAULT_CITY)
    house = (P["house"] or "") + (" к" + P["corp"] if P["corp"] else "")

    def nom_in(cc, lim, **kw):      # [v20] только найденное в этом населённом пункте (Nominatim добирает по области)
        return [x for x in nominatim(None, lim, **kw) if in_place(x, cc)]

    def fix_of(to):                 # «исправлено» — только если название действительно другое
        return {"from": P["street"], "to": to} if core_name(to) != core_name(P["street"]) else None
    for cc in cities:
        if time.time() - t0 > budget_s:
            break
        # 2) структурный запрос
        if P["house"]:
            js = nom_in(cc, limit, street=f"{P['house']} {P['street']}", city=cc)
            if js:
                return _mark(js, _how="structured")
        # [v20] улица написана верно, но такого дома нет в OSM — середина улицы (не «похожая» улица с этим домом)
        js = nom_in(cc, limit, street=P["street"], city=cc)
        if js:
            return _mark(js[:1], _how="street", _approx=True) if P["house"] else _mark(js, _how="street")
        # 3) исправление названия улицы по списку улиц населённого пункта
        core = P["core"]
        if not core or len(core) < 3:
            continue
        left = budget_s - (time.time() - t0)
        streets = city_streets(cc, wait_s=min(max(0.5, left - 4.0), 8.0))
        cands, phon = [], False
        if streets:
            best: Dict[str, Tuple[float, str]] = {}
            for s in streets:
                cn = core_name(s)
                sc = similarity(core, cn)
                if P["stype"] and P["stype"] not in s.lower():
                    sc -= 0.04
                if sc >= 0.74 and cn != core and (cn not in best or sc > best[cn][0]):
                    best[cn] = (sc, s)
            cands = [v[1] for v in sorted(best.values(), key=lambda v: -v[0])[:3]]
        else:      # 4) списка улиц нет (Overpass недоступен) — варианты «как слышится»
            phon = True
            words = core.split()
            main = max(words, key=len) if words else core
            for w in _phon_variants(main):
                cands.append(re.sub(r"(?i)" + re.escape(main), w, P["street"], count=1))
        if P["house"]:                      # сначала — с номером дома
            for s in cands:
                if time.time() - t0 > budget_s:
                    break
                js = nom_in(cc, limit, street=f"{P['house']} {s}", city=cc)
                if js:
                    return _mark(js, _how="fuzzy", _corrected=fix_of(_road(js[0], s)))
        for s in cands[:3] if (phon and P["house"]) else cands:
            if time.time() - t0 > budget_s:
                break
            js = nom_in(cc, limit, street=s, city=cc)
            if js:
                fixed = fix_of(_road(js[0], s))
                if P["house"]:          # дом не найден — середина улицы
                    return _mark(js[:1], _how="fuzzy-street", _corrected=fixed, _approx=True)
                return _mark(js, _how="fuzzy", _corrected=fixed)
    return _mark(fallback, _how="nominatim")


def locate(addr: str, city: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Лучший результат: {'lat','lon','label','note','approx','item'} или None (item — ответ Nominatim целиком)."""
    res = search(addr, city, limit=3)
    if not res:
        return None
    r = res[0]
    lat, lon = float(r["lat"]), float(r["lon"])
    note = []
    if r.get("_corrected"):
        note.append("исправлено «%s» → «%s»" % (r["_corrected"]["from"], r["_corrected"]["to"]))
    if r.get("_approx"):
        note.append("дом не найден — взята середина улицы")
    return {"lat": lat, "lon": lon, "label": r.get("display_name") or addr, "note": "; ".join(note), "approx": bool(r.get("_approx")),
            "inside_by": BY_BOX[0] <= lat <= BY_BOX[1] and BY_BOX[2] <= lon <= BY_BOX[3], "item": r}


if __name__ == "__main__":          # python geocoder.py "ул. Долгобротская 38" [город]
    import sys
    a = sys.argv[1] if len(sys.argv) > 1 else "ул. Долгобротская 38"
    print(json.dumps(locate(a, sys.argv[2] if len(sys.argv) > 2 else None), ensure_ascii=False, indent=1))
