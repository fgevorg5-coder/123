# -*- coding: utf-8 -*-
"""
georef_runner.py — исполнитель заданий «План → GeoTIFF/TFW → MBTiles», «Растр → MBTiles»
и «MBTiles → TIFF + TFW/TFWX» (v20).

Запускается сервером отдельным процессом:  python georef_runner.py <папка задания>
В папке задания: params.json (вид задания и параметры), in/ (загруженные файлы).
Результаты — в out/: <лист>.tif (+ .tif.ovr, .tif.aux.xml), <лист>.tfw / .tfwx / .prj,
<лист>.mbtiles, qa_overlay.jpg, report.json / report.txt и общий result.json для интерфейса.

Ход работы печатается строками «[ NN%] Этап: …» — их читает очередь заданий (jobkit).

Инструменты: georef_plans.py и tif2mbtiles.py (каталог GEOREF_TOOLS_DIR, по умолчанию
tools/georef/ рядом с этим файлом). PDF → растр: pypdfium2 (pip install pypdfium2) или PyMuPDF.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
T0 = time.time()
RASTER_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp")
ESRI_3857 = ('PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
             'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
             'PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],'
             'PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],'
             'UNIT["Meter",1.0]]')
_last_pct = [0]


def say(text: str) -> None:
    print(text, flush=True)


def progress(pct: float, text: str) -> None:
    pct = int(max(0, min(100, round(pct))))
    pct = max(pct, _last_pct[0]) if pct < 100 else 100
    _last_pct[0] = pct
    say(f"[{pct:3d}%] {text}")


def fail(msg: str, code: int = 2) -> None:
    say(f"Ошибка: {msg}")
    sys.exit(code)


def tools_dir() -> Path:
    d = os.environ.get("GEOREF_TOOLS_DIR")
    for c in ([Path(d)] if d else []) + [HERE / "tools" / "georef", HERE / "georef"]:
        if (c / "georef_plans.py").is_file() or (c / "tif2mbtiles.py").is_file():
            return c.resolve()
    fail("не найдены georef_plans.py / tif2mbtiles.py: положите их в tools/georef/ или задайте GEOREF_TOOLS_DIR")


def safe_stem(name: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", os.path.splitext(os.path.basename(name))[0]).strip(" .")
    return s[:80] or "plan"


# ─────────────────────────── PDF → растр ───────────────────────────
def parse_pages(spec, n: int):
    spec = str(spec or "").strip().lower()
    if not spec or spec in ("all", "все", "*"):
        return list(range(n))
    out = []
    for part in re.split(r"[,;\s]+", spec):
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*[-–]\s*(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            out += list(range(min(a, b) - 1, max(a, b)))
        elif part.isdigit():
            out.append(int(part) - 1)
    out = sorted({p for p in out if 0 <= p < n})
    return out or list(range(n))


HINT_LETTERS = set("NSСЮC")


def _rot_pt(x, y, rot, w_pt, h_pt):
    """точка PDF (pt, начало внизу слева, страница без поворота) -> px растра с учётом /Rotate (по часовой)"""
    u, v = x, h_pt - y
    if rot == 90:
        return h_pt - v, u
    if rot == 180:
        return w_pt - u, h_pt - v
    if rot == 270:
        return v, w_pt - u
    return u, v


def _letters_box(boxes, rot, w_pt, h_pt, s):
    out = []
    for ch, (l, b, r, t) in boxes:
        p = [_rot_pt(l, b, rot, w_pt, h_pt), _rot_pt(r, t, rot, w_pt, h_pt)]
        out.append([round(min(p[0][0], p[1][0]) * s, 1), round(min(p[0][1], p[1][1]) * s, 1),
                    round(max(p[0][0], p[1][0]) * s, 1), round(max(p[0][1], p[1][1]) * s, 1), ch])
    return out


def pdf_hints_pdfium(page, dpi, w_pt, h_pt):
    """[v20.1] текст страницы (масштаб «1:500») и одиночные буквы N/S/С/Ю с положением в px растра (стрелка севера)"""
    tp = page.get_textpage()
    try:
        n = tp.count_chars()
        text = tp.get_text_range(0, n) if n else ""
        rot = int(page.get_rotation() or 0) % 360
        boxes = []
        if len(text) == n:
            for i, ch in enumerate(text):
                if ch in HINT_LETTERS and (i == 0 or not text[i - 1].isalnum()) and (i == n - 1 or not text[i + 1].isalnum()):
                    boxes.append((ch, tp.get_charbox(i)))
                    if len(boxes) > 200:
                        break
        return {"text": text[:40000], "letters": _letters_box(boxes, rot, w_pt, h_pt, dpi / 72.0),
                "page_mm": [round(w_pt / 72 * 25.4, 1), round(h_pt / 72 * 25.4, 1)], "rotation": rot}
    finally:
        tp.close()


def pdf_hints_fitz(page, dpi):
    words = page.get_text("words")
    text = page.get_text()
    s = dpi / 72.0
    M = page.rotation_matrix if page.rotation else None
    letters = []
    for w in words:
        if len(w[4]) == 1 and w[4] in HINT_LETTERS:
            r = page.rect.__class__(w[:4])
            if M is not None:
                r = r * M
            letters.append([round(r.x0 * s, 1), round(r.y0 * s, 1), round(r.x1 * s, 1), round(r.y1 * s, 1), w[4]])
    return {"text": text[:40000], "letters": letters[:200], "rotation": int(page.rotation or 0),
            "page_mm": [round(page.rect.width / 72 * 25.4, 1), round(page.rect.height / 72 * 25.4, 1)]}


def write_hints(png: Path, hints) -> None:
    if hints and (hints.get("text") or hints.get("letters")):
        try:
            png.with_name(png.stem + ".hints.json").write_text(json.dumps(hints, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass


def pdf_to_rasters(pdf: Path, work: Path, dpi_opt, pages_spec, max_mp: float):
    """Каждая страница → PNG с записанным разрешением (dpi). «Авто»: страница-скан выводится
    с родным разрешением вложенного изображения (без потери качества), векторная — 200 dpi."""
    stem = safe_stem(pdf.name)
    res = []
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(str(pdf))
        n = len(doc)
        pages = parse_pages(pages_spec, n)
        for k, i in enumerate(pages):
            page = doc[i]
            w_pt, h_pt = page.get_size()
            native = None
            try:
                import pypdfium2.raw as raw
                best = None
                for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=2):
                    pw, ph = obj.get_px_size()
                    b = (obj.get_bounds() if hasattr(obj, "get_bounds") else obj.get_pos())
                    bw, bh = abs(b[2] - b[0]), abs(b[3] - b[1])
                    if bw * bh > 0 and (best is None or bw * bh > best[0]):
                        best = (bw * bh, pw, ph, bw, bh)
                if best and best[0] >= 0.85 * w_pt * h_pt:
                    native = max(best[1] / (best[3] / 72.0), best[2] / (best[4] / 72.0))
            except Exception:
                native = None
            dpi = choose_dpi(dpi_opt, native, w_pt, h_pt, max_mp)
            bmp = page.render(scale=dpi / 72.0, may_draw_forms=True)
            img = bmp.to_pil().convert("RGB")
            name = f"{stem}.png" if len(pages) == 1 else f"{stem}_p{i + 1}.png"
            out = work / name
            img.save(out, "PNG", dpi=(dpi, dpi), compress_level=3)
            try:
                write_hints(out, pdf_hints_pdfium(page, dpi, w_pt, h_pt))
            except Exception as e:                # подсказки необязательны
                say(f"Внимание: текст PDF не прочитан ({e}) — масштаб и север определяются по самому плану")
            res.append((out, dpi, native, i + 1, n))
            progress(2 + 6 * (k + 1) / max(1, len(pages)),
                     f"Подготовка файлов: {pdf.name}, стр. {i + 1} из {n} → {img.width}×{img.height} px, {dpi:.0f} dpi"
                     + (" (родное разрешение скана)" if native and abs(native - dpi) < 1 else ""))
            page.close()
        doc.close()
        return res
    except ImportError:
        pass
    try:
        import fitz  # PyMuPDF
    except ImportError:
        fail("для PDF нужен пакет pypdfium2 (pip install pypdfium2) или PyMuPDF")
    doc = fitz.open(str(pdf))
    pages = parse_pages(pages_spec, doc.page_count)
    for k, i in enumerate(pages):
        page = doc[i]
        w_pt, h_pt = page.rect.width, page.rect.height
        native = None
        try:
            best = None
            for im in page.get_images(full=True):
                for r in page.get_image_rects(im[0]):
                    if r.width * r.height > 0 and (best is None or r.width * r.height > best[0]):
                        best = (r.width * r.height, im[2], im[3], r.width, r.height)
            if best and best[0] >= 0.85 * w_pt * h_pt:
                native = max(best[1] / (best[3] / 72.0), best[2] / (best[4] / 72.0))
        except Exception:
            native = None
        dpi = choose_dpi(dpi_opt, native, w_pt, h_pt, max_mp)
        pix = page.get_pixmap(dpi=int(round(dpi)), alpha=False)
        name = f"{stem}.png" if len(pages) == 1 else f"{stem}_p{i + 1}.png"
        out = work / name
        pix.set_dpi(int(round(dpi)), int(round(dpi)))
        pix.save(str(out))
        try:
            write_hints(out, pdf_hints_fitz(page, round(dpi)))
        except Exception:
            pass
        res.append((out, round(dpi), native, i + 1, doc.page_count))
        progress(2 + 6 * (k + 1) / max(1, len(pages)), f"Подготовка файлов: {pdf.name}, стр. {i + 1} из {doc.page_count} → {pix.width}×{pix.height} px")
    return res


def choose_dpi(opt, native, w_pt, h_pt, max_mp):
    if opt not in (None, "", "auto"):
        dpi = float(opt)
    elif native and 100 <= native <= 1200:
        dpi = native
    else:
        dpi = 200.0
    dpi = max(72.0, min(600.0, dpi))
    mp = (w_pt / 72.0 * dpi) * (h_pt / 72.0 * dpi) / 1e6
    if mp > max_mp:                               # огромный лист — уменьшаем, чтобы хватило памяти
        dpi *= math.sqrt(max_mp / mp)
    return round(dpi, 2)


def extract_zip(zp: Path, dest: Path, allowed) -> list:
    out = []
    with zipfile.ZipFile(zp) as z:
        for info in z.infolist():
            if info.is_dir() or info.file_size > 2 * 1024 ** 3:
                continue
            raw = info.filename
            try:
                if not (info.flag_bits & 0x800):
                    raw = raw.encode("cp437").decode("cp866")
            except Exception:
                pass
            base = os.path.basename(raw.replace("\\", "/"))
            if not base or base.startswith(".") or not base.lower().endswith(allowed):
                continue
            tgt = dest / re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", base)
            k = 2
            while tgt.exists():
                tgt = dest / f"{tgt.stem}_{k}{tgt.suffix}"
                k += 1
            with z.open(info) as src, open(tgt, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            out.append(tgt)
    return out


# ─────────────────────────── ход привязки по журналу georef_plans ───────────────────────────
class GeorefProgress:
    def __init__(self, names):
        self.names = list(names)
        self.n = max(1, len(self.names))
        self.read = 0
        self.coarse = 0
        self.exported = 0
        self.mb_total = max(1, len(self.names))
        self.mb_done = 0
        self.mb_frac = 0.0
        self.in_mb = False
        self.warnings = []

    def sheet(self, text):
        for nm in sorted(self.names, key=len, reverse=True):
            if text.startswith(nm + ":") or text.startswith(nm + " "):
                return nm
        return None

    def feed(self, text: str) -> None:
        t = text.strip()
        low = t.lower()
        if t.startswith("ВНИМАНИЕ"):
            self.warnings.append(t[:300])
        if self.in_mb:
            m = re.search(r"\.\.\.\s*(\d+)\s*/\s*(\d+)\s*блок", t)
            if m:
                self.mb_frac = int(m.group(1)) / max(1, int(m.group(2)))
                progress(90 + 9 * (self.mb_done + self.mb_frac) / self.mb_total,
                         f"Нарезка MBTiles: {self.mb_done + 1} из {self.mb_total}, блоков {m.group(1)}/{m.group(2)}")
                return
            if re.match(r"^->\s.*\.mbtiles:", t):
                self.mb_done += 1
                self.mb_frac = 0.0
                progress(90 + 9 * self.mb_done / self.mb_total, f"Нарезка MBTiles: готово {self.mb_done} из {self.mb_total}")
                return
            if ".tif:" in t and " px" in t:
                progress(90 + 9 * self.mb_done / self.mb_total, f"Нарезка MBTiles: {t.split(':')[0]}")
                return
        if low.startswith("готово"):
            progress(99, "Нарезка MBTiles: готово" if self.in_mb else "Экспорт GeoTIFF/TFW: готово")
            return
        if low.startswith("mbtiles:"):
            self.in_mb = True
            self.mb_total = max(1, len([x for x in t.split(":", 1)[1].split(",") if x.strip()]))
            progress(90, "Нарезка MBTiles: " + t.split(":", 1)[1].strip()[:160])
            return
        if low.startswith("центр поиска"):
            progress(12, "Поиск места: " + t[:180])
            return
        if low.startswith("контуры зданий"):
            progress(18, "Поиск места: " + t[:180])
            return
        if low.startswith("ортофото"):
            progress(58, "Тонкая привязка: " + t[:180])
            return
        if low.startswith("тонкая привязка"):
            progress(62, "Тонкая привязка: подбор по линиям плана и кромкам ортофото")
            return
        if low.startswith("совмещение"):
            progress(54, "Грубая привязка: " + t[:180])
            return
        nm = self.sheet(t)
        rest = t[len(nm) + 1:].strip() if nm else t
        if nm and re.match(r"\d+×\d+", rest):
            self.read += 1
            progress(8 + 3 * self.read / self.n, f"Подготовка файлов: {nm} — {rest[:150]}")
        elif nm and rest.startswith("сетка"):
            progress(20 + 32 * (self.coarse + 0.15) / self.n, f"Грубая привязка: {nm} — {rest[:150]}")
        elif nm and rest.startswith("грубо"):
            self.coarse += 1
            progress(20 + 32 * self.coarse / self.n, f"Грубая привязка: {nm} — {rest[:150]}")
        elif "поиск связи" in low:
            progress(53, "Грубая привязка: связь листов — " + t[:150])
        elif "перебор" in low:
            progress(80, "Тонкая привязка: " + t[:180])
        elif "профили" in low:
            progress(84, "Тонкая привязка: " + t[:180])
        elif "согласованность" in low:
            progress(85, "Тонкая привязка: проверка согласованности")
        elif nm and rest.startswith("->") and ".tif" in rest:
            self.exported += 1
            progress(86 + 3 * self.exported / self.n, f"Экспорт GeoTIFF/TFW: {nm}.tif")


def patch_log(mod, hook):
    start = getattr(mod, "T_START", T0)

    def log(*a):
        text = " ".join(str(x) for x in a)
        print("[%6.1fs] %s" % (time.time() - start, text), flush=True)
        try:
            hook(text)
        except Exception:
            pass
    mod.log = log
    return log


# ─────────────────────────── задания ───────────────────────────
def georef_job(jd: Path, p: dict) -> dict:
    tdir = tools_dir()
    sys.path.insert(0, str(tdir))
    try:
        import georef_plans as gp
    except ImportError as e:
        fail(f"не загружен georef_plans.py ({e}). Установите пакеты: pip install -r tools/georef/requirements.txt")
    inp, work, out = jd / "in", jd / "work", jd / "out"
    work.mkdir(exist_ok=True)
    out.mkdir(exist_ok=True)
    g = p.get("georef") or {}
    pdf = p.get("pdf") or {}
    progress(1, "Подготовка файлов: разбор загруженных файлов")
    files = sorted(x for x in inp.iterdir() if x.is_file())
    for z in [x for x in files if x.suffix.lower() == ".zip"]:
        files += extract_zip(z, work, RASTER_EXT + (".pdf",))
    scans, sources = [], {}
    used = set()
    for f in files:
        ext = f.suffix.lower()
        if ext == ".pdf":
            for path, dpi, native, page, n in pdf_to_rasters(f, work, pdf.get("dpi"), pdf.get("pages"),
                                                              float(os.environ.get("GEOREF_PDF_MAX_MP", "150"))):
                scans.append(path)
                sources[path.stem] = {"file": f.name, "page": page, "pages": n, "dpi": dpi,
                                      "native_dpi": round(native, 1) if native else None}
        elif ext in RASTER_EXT:
            scans.append(f)
            sources[f.stem] = {"file": f.name}
    if not scans:
        fail("нет сканов плана (JPG, PNG, TIFF или PDF)")
    # имена листов должны различаться (по ним называются результаты)
    final = []
    for s in scans:
        stem = safe_stem(s.name)
        k, name = 2, stem
        while name.lower() in used:
            name, k = f"{stem}_{k}", k + 1
        used.add(name.lower())
        if name != s.stem or s.parent != work:
            tgt = work / (name + s.suffix.lower())
            if s.parent == inp:
                try:
                    os.link(s, tgt)
                except OSError:
                    shutil.copy2(s, tgt)
            else:
                os.replace(s, tgt)
                hs = s.with_name(s.stem + ".hints.json")
                if hs.is_file():
                    os.replace(hs, tgt.with_name(tgt.stem + ".hints.json"))
            sources[name] = sources.pop(s.stem, {"file": s.name})
            s = tgt
        final.append(s)
    if len(final) > int(os.environ.get("GEOREF_MAX_SHEETS", "12")):
        fail(f"слишком много листов ({len(final)}): за один раз — не больше {os.environ.get('GEOREF_MAX_SHEETS', '12')}")
    names = [s.stem for s in final]
    progress(8, f"Подготовка файлов: листов {len(final)} — " + ", ".join(names)[:160])
    place = find_place(gp, g, work)
    av = [str(s) for s in final]
    if g.get("center"):
        av += ["--center", f"{float(g['center'][0]):.7f},{float(g['center'][1]):.7f}"]
    elif g.get("address"):
        av += ["--address", str(g["address"])[:200]]
        if g.get("city"):
            av += ["--city", str(g["city"])[:60]]
    # [v20.1] радиус и масштаб «авто»: круг — по охвату адреса и размеру листа, масштаб — из файла (текст PDF «1:500»)
    av += ["--radius", f"{float(g['radius']):g}" if g.get("radius") else "auto",
           "--scale", f"{float(g['scale']):g}" if g.get("scale") else "auto"]
    if place and place.get("area_file"):
        av += ["--area", place["area_file"]]
    if g.get("dpi"):
        av += ["--dpi", f"{float(g['dpi']):g}"]
    av += ["--orient", str(g.get("orient") or "auto")]
    if g.get("no_grid"):
        av.append("--no-grid")
    av += ["--buildings", g.get("buildings") or "nca", "--ortho", g.get("ortho") or "nca",
           "--zoom", str(int(g.get("zoom") or 20)), "--model", g.get("model") or "auto"]
    if g.get("no_fine"):
        av.append("--no-fine")
    for k, opt in (("search_angle", "--search-angle"), ("search_shift", "--search-shift")):
        if g.get(k) is not None:
            av += [opt, f"{float(g[k]):g}"]
    av += ["-o", str(out), "--cache", str(Path(os.environ.get("GEOREF_CACHE_DIR") or (jd.parent.parent / "cache")))]
    av += ["--threads", str(int(os.environ.get("GEOREF_THREADS", "12")))]
    mb = p.get("mbtiles") or {}
    if not mb.get("enabled", True):
        av.append("--no-mbtiles")
    else:
        av += ["--mbtiles-format", mb.get("format") or "png", "--mbtiles-paper", mb.get("paper") or "auto",
               "--mbtiles-background", mb.get("background") or "auto"]
        if mb.get("zoom"):
            av += ["--mbtiles-zoom", str(mb["zoom"])]
        if mb.get("merge"):
            av += ["--mbtiles-merge", safe_stem(str(mb["merge"]))]
    hook = GeorefProgress(names)
    patch_log(gp, hook.feed)
    gp.T_START = T0
    say("georef_plans " + " ".join(av[len(final):]))
    try:
        import tif2mbtiles as t2m             # общий журнал: строки нарезки тоже дают ход
        t2m.T_START = T0
    except ImportError:
        t2m = None
    if not place:
        progress(10, "Поиск места: " + ("центр задан точкой" if g.get("center") else "адрес из штампа (OCR)"))
    try:
        info = gp.main(av)
    except SystemExit as e:
        fail(str(e.code if e.code is not None else "привязка не выполнена"))
    except MemoryError:
        fail("не хватило памяти: уменьшите разрешение (dpi) PDF или число листов")
    # .tfw (= .tfwx) и .prj рядом с каждым GeoTIFF — для ГИС, которые не читают GeoTIFF-теги
    for s in info.get("sheets", []):
        if not s.get("registered"):
            continue
        tfwx = out / (s["name"] + ".tfwx")
        if tfwx.is_file():
            shutil.copyfile(tfwx, out / (s["name"] + ".tfw"))
        (out / (s["name"] + ".prj")).write_text(ESRI_3857, encoding="ascii")
    res = summarize(info, sources, hook.warnings, out)
    if place:
        res["place"] = place
        if place.get("approx"):
            res.setdefault("warnings", []).insert(0, "ВНИМАНИЕ: дом не найден — участок искали вокруг середины улицы; проверьте результат на карте")
    return res


def _geocoder():
    """geocoder.py сервера (исправление опечаток в адресах) или None."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    try:
        import geocoder
        return geocoder
    except Exception as e:                      # без него — геокодер georef_plans (Nominatim как есть)
        say(f"Внимание: geocoder.py не загружен ({e}) — адрес ищется без исправления опечаток")
        return None


def ui_item(g: dict, lat: float, lon: float):
    """[v20.1] найденный в интерфейсе объект (osm, класс, название, рамка) → ответ «как у Nominatim» для охвата адреса"""
    osm = str(g.get("place_osm") or "")
    m = re.fullmatch(r"(node|way|relation)/(\d{1,12})", osm)
    if not m and not g.get("place_bbox"):
        return None
    it = {"lat": lat, "lon": lon, "category": g.get("place_cls") or "", "type": g.get("place_type") or "",
          "name": g.get("place_name") or "", "display_name": g.get("place_label") or "", "_approx": bool(g.get("place_approx"))}
    if m:
        it["osm_type"], it["osm_id"] = m.group(1), m.group(2)
    if g.get("place_bbox"):
        it["boundingbox"] = [str(v) for v in g["place_bbox"]]
    return it


def place_area(gp, item, work, place: dict) -> dict:
    """[v20.1] охват адреса (вся улица/дом) → work/area.json для georef_plans --area"""
    if not item or work is None or not hasattr(gp, "address_area"):
        return place
    try:
        a = gp.address_area(item)
    except Exception as e:
        say(f"Внимание: охват адреса не определён ({e}) — круг поиска по точке")
        return place
    if a:
        fp = work / "area.json"
        fp.write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
        place["area_file"] = str(fp)
        place["area"] = {k: a.get(k) for k in ("kind", "radius_m", "source", "center")}
        if a["kind"] == "street":
            progress(10, f"Поиск места: охват улицы — {a['radius_m']:.0f} м от середины ({a.get('source') or 'геокодер'}); "
                         "лист плана должен её захватывать и целиком лежать в круге поиска")
    return place


def find_place(gp, g: dict, work: Path = None):
    """[v20] Адрес → точка до запуска привязки: исправление опечаток («Долгобротская» → «Долгобродская»),
    понятная ошибка, если адрес не найден. Найденная точка передаётся в georef_plans как --center.
    [v20.1] + охват адреса: для улицы — все её участки (круг поиска и проверка «лист захватывает улицу»)."""
    geo = _geocoder()
    if geo is not None:                         # и для адреса из штампа (OCR) — тот же геокодер
        def _gp_geocode(address, city):
            r = geo.locate(address, city)
            return (r["lat"], r["lon"], r["label"] + (f" ({r['note']})" if r.get("note") else "")) if r else None
        gp.geocode = _gp_geocode
    if g.get("center") and g.get("address") and g.get("place_label"):
        lat, lon = float(g["center"][0]), float(g["center"][1])
        progress(10, f"Поиск места: «{g['place_label']}» — {lat:.6f}, {lon:.6f} (найдено по адресу «{g['address']}»)")
        place = {"address": g["address"], "city": g.get("city"), "label": g["place_label"], "lat": lat, "lon": lon,
                 "note": g.get("place_note") or "", "approx": "центр улицы" in str(g.get("place_note") or "")}
        item = ui_item(g, lat, lon)
        if item is None and geo is not None:         # старый интерфейс: тот же адрес ещё раз (объект целиком)
            try:
                r = geo.locate(g["address"], g.get("city") or None)
            except Exception:
                r = None
            if r and r.get("item") and abs(r["lat"] - lat) < 0.002 and abs(r["lon"] - lon) < 0.003:
                item = dict(r["item"], _approx=r.get("approx"))
        return place_area(gp, item, work, place)
    if g.get("center") or not g.get("address"):
        return None
    addr, city = str(g["address"]).strip()[:200], str(g.get("city") or "").strip()[:60] or None
    progress(9, f"Поиск места: адрес «{addr}»" + (f", {city}" if city else ""))
    r = geo.locate(addr, city) if geo is not None else None
    if r is None and geo is None:
        return None                             # пусть ищет georef_plans
    if r is None:
        fail(f"адрес «{addr}»" + (f" ({city})" if city else "") + " не найден ни как есть, ни с исправлением опечаток. "
             "Проверьте название улицы и номер дома или укажите участок точкой на карте (режим «Точка на карте»).")
    if not r.get("inside_by"):
        fail(f"адрес «{addr}» найден за пределами Беларуси ({r['label']}) — уточните населённый пункт или укажите точку на карте")
    g["center"] = [r["lat"], r["lon"]]
    msg = f"Поиск места: найдено «{r['label']}» — {r['lat']:.6f}, {r['lon']:.6f}"
    progress(10, msg + (f" ({r['note']})" if r.get("note") else ""))
    if r.get("approx"):
        say("Внимание: дом не найден — поиск идёт вокруг середины улицы; при необходимости увеличьте радиус или укажите точку на карте")
    place = {"address": addr, "city": city, "label": r["label"], "lat": r["lat"], "lon": r["lon"],
             "note": r.get("note") or "", "approx": bool(r.get("approx"))}
    return place_area(gp, dict(r["item"], _approx=r.get("approx")) if r.get("item") else None, work, place)


def quality_of(stats, fine, flags):
    if not fine:
        return "coarse", "Только грубая привязка по контурам зданий — ошибка до ~5 м, проверьте на карте"
    cls = [v for k, v in (stats or {}).items() if k != "у зданий" and isinstance(v, dict)]
    if not cls:
        return "check", "Нет оценки по линиям плана — проверьте на карте"
    share = max(v.get("share") or 0 for v in cls)
    rms = min(v.get("rms") or 9 for v in cls)
    if share >= 0.15 and rms <= 0.35 and not flags:
        return "good", f"Совпадение линий {share:.0%}, RMS {rms:.2f} м"
    if share >= 0.08:
        return "check", f"Совпадение линий {share:.0%}, RMS {rms:.2f} м — проверьте на карте"
    return "poor", f"Слабое совпадение линий ({share:.0%}) — вероятна ошибка, проверьте на карте"


def summarize(info, sources, warnings, out: Path) -> dict:
    comp_of = {}
    for c in info.get("components", []):
        for nm in c.get("sheets", []):
            comp_of[nm] = c
    sheets = []
    for s in info.get("sheets", []):
        d = {k: s.get(k) for k in ("name", "file", "registered", "size", "dpi", "orientation_cw", "out_size", "model",
                                   "m_per_px", "scale_denominator", "rotation_deg", "shear_deg", "center_latlon",
                                   "corners_latlon", "world_file", "coarse_to_final_m", "fit", "mbtiles",
                                   "plan_scale", "scale_source", "paper_factor", "north_hint")}
        d["source"] = sources.get(s["name"]) or {"file": s.get("file")}
        if s.get("registered"):
            c = comp_of.get(s["name"]) or {}
            q, qt = quality_of(c.get("stats"), c.get("fine", False), c.get("flags"))
            d["quality"], d["quality_text"] = q, qt
            d["files"] = [n for n in (s["name"] + e for e in (".tif", ".tfw", ".tfwx", ".prj", ".tif.aux.xml", ".tif.ovr", ".mbtiles"))
                          if (out / n).is_file()]
            if s.get("mbtiles") and s["mbtiles"] not in d["files"] and (out / s["mbtiles"]).is_file():
                d["files"].append(s["mbtiles"])
        sheets.append(d)
    comps = []
    for c in info.get("components", []):
        comps.append({k: c.get(k) for k in ("ref", "sheets", "model", "fine", "grid_sheet", "moved_m", "stats", "consistency_m", "flags")})
    return {"kind": "georef", "ok": any(s.get("registered") for s in sheets), "created": info.get("created"),
            "center": info.get("center"), "sources": info.get("sources"), "crs": info.get("crs", "EPSG:3857"),
            "sheets": sheets, "components": comps, "links": [{k: v for k, v in l.items() if k != "K_b_to_a"} for l in info.get("links", [])],
            "mbtiles": [{k: v for k, v in m.items() if k != "path"} for m in info.get("mbtiles", [])],
            "warnings": warnings[-20:], "qa": "qa_overlay.jpg" if (out / "qa_overlay.jpg").is_file() else None,
            "elapsed_s": round(time.time() - T0, 1)}


def mbtiles_job(jd: Path, p: dict) -> dict:
    tdir = tools_dir()
    sys.path.insert(0, str(tdir))
    try:
        import tif2mbtiles as t2m
    except ImportError as e:
        fail(f"не загружен tif2mbtiles.py ({e}). Установите пакеты: pip install rasterio numpy pillow")
    t2m.T_START = T0
    inp, out = jd / "in", jd / "out"
    out.mkdir(exist_ok=True)
    m = p.get("mbtiles") or {}
    files = sorted(str(x) for x in inp.iterdir() if x.is_file())
    if not files:
        fail("нет входных файлов")
    mains = [f for f in files if f.lower().endswith((".tif", ".tiff", ".jpg", ".jpeg", ".png", ".zip", ".7z", ".rar"))]
    progress(2, f"Подготовка файлов: {len(files)} файл(ов), растров/архивов {len(mains)}")
    av = [str(inp), "-o", str(out), "--format", m.get("format") or "png", "--paper", m.get("paper") or "auto",
          "--background", m.get("background") or "auto", "--resampling", m.get("resampling") or "cubic",
          "--tile-size", str(int(m.get("tile_size") or 256)), "--threads", str(int(os.environ.get("GEOREF_THREADS", "8")))]
    for k, opt in (("minzoom", "--minzoom"), ("maxzoom", "--maxzoom"), ("quality", "--quality"),
                   ("white_threshold", "--white-threshold")):
        if m.get(k) not in (None, ""):
            av += [opt, str(int(m[k]))]
    if m.get("src_nodata") not in (None, ""):
        av += ["--src-nodata", f"{float(m['src_nodata']):g}"]
    for k, opt in (("src_crs", "--src-crs"), ("force_crs", "--force-crs"), ("name", "--name")):
        if m.get(k):
            av += [opt, str(m[k])[:4000]]
    if m.get("merge"):
        av += ["--merge", safe_stem(str(m["merge"])) + ".mbtiles"]
    total = max(1, len(mains)) if not m.get("merge") else 1
    st = {"done": 0, "warn": []}

    def hook(text):
        t = text.strip()
        if t.startswith("ВНИМАНИЕ"):
            st["warn"].append(t[:900])
        mm = re.search(r"\.\.\.\s*(\d+)\s*/\s*(\d+)\s*блок", t)
        if mm:
            fr = int(mm.group(1)) / max(1, int(mm.group(2)))
            progress(12 + 86 * (st["done"] + fr) / total, f"Нарезка MBTiles: блоков {mm.group(1)}/{mm.group(2)}")
        elif t.startswith("-> ") and ".mbtiles" in t:
            st["done"] += 1
            progress(12 + 86 * st["done"] / total, f"Нарезка MBTiles: готово {st['done']} из {total}")
        elif " px, " in t and "привязка:" in t:
            progress(8 + 4 * st["done"] / total, "Чтение привязки: " + re.sub(r"^(in|work)[/\\]", "", t)[:170])

    def log(*a):
        text = " ".join(str(x) for x in a)
        print("[%6.1fs] %s" % (time.time() - T0, text), flush=True)
        hook(text)
    progress(5, "Чтение привязки: поиск GeoTIFF / world-файлов / .prj")
    try:
        res = t2m.main(av, log=log)
    except SystemExit as e:
        fail(str(e.code if e.code is not None else "MBTiles не созданы"))
    if not res:                                 # [v20.3] без «ВНИМАНИЕ:», «in/» и повтора «MBTiles не созданы»
        ws = [re.sub(r"^ВНИМАНИЕ:\s*(?:(?:in|work)[/\\])?", "", w) for w in st["warn"] if "MBTiles не созданы" not in w]
        fail("MBTiles не созданы: " + ("; ".join(ws[-3:]) or "нет растров с привязкой"))
    return {"kind": "mbtiles", "ok": True, "mbtiles": [{k: v for k, v in r.items() if k != "path"} for r in res],
            "warnings": st["warn"][-20:], "elapsed_s": round(time.time() - T0, 1)}


def mb2tif_job(jd: Path, p: dict) -> dict:
    """[v20] MBTiles → GeoTIFF + .tfw/.tfwx + .prj (в выбранной СК) + PNG-просмотр для карты."""
    tdir = tools_dir()
    sys.path.insert(0, str(tdir))
    try:
        import mbtiles2tif as m2t
    except ImportError as e:
        fail(f"не загружен mbtiles2tif.py ({e}). Установите пакеты: pip install rasterio numpy pillow")
    m2t.T_START = T0
    inp, out, work = jd / "in", jd / "out", jd / "work"
    out.mkdir(exist_ok=True)
    t = p.get("mb2tif") or {}
    files = sorted((x for x in inp.iterdir() if x.is_file()), key=lambda x: x.name.lower())
    srcs = [x for x in files if x.suffix.lower() == ".mbtiles"]
    for z in (x for x in files if x.suffix.lower() == ".zip"):
        work.mkdir(exist_ok=True)
        try:
            srcs += extract_zip(z, work, (".mbtiles",))
        except zipfile.BadZipFile:
            fail(f"«{z.name}»: архив повреждён или это не ZIP")
    if not srcs:
        fail("нет файлов .mbtiles (в том числе внутри ZIP)")
    total = len(srcs)
    progress(3, f"Подготовка файлов: MBTiles — {total}")
    st = {"i": 0, "warn": [], "name": ""}
    span = 95.0 / total

    def hook(text):
        s_ = text.strip()
        base = 4 + span * st["i"]
        tag = f" · {st['name']}" if total > 1 else ""
        if s_.startswith("ВНИМАНИЕ"):
            st["warn"].append((f"{st['name']}: " if total > 1 else "") + s_[:300])
            return
        mm = re.match(r"тайлы:\s*(\d+)\s*/\s*(\d+)", s_)
        if mm:
            fr = int(mm.group(1)) / max(1, int(mm.group(2)))
            progress(base + span * (0.04 + 0.5 * fr), f"Чтение MBTiles: тайлов {mm.group(1)}/{mm.group(2)}{tag}")
            return
        mm = re.match(r"перепроецирование: строк (\d+)/(\d+)", s_)
        if mm:
            fr = int(mm.group(1)) / max(1, int(mm.group(2)))
            progress(base + span * (0.6 + 0.3 * fr), f"Перепроецирование и пирамиды: строк {mm.group(1)}/{mm.group(2)}{tag}")
            return
        if s_.startswith("перепроецирование в"):
            progress(base + span * 0.58, "Перепроецирование и пирамиды: " + s_[len("перепроецирование в"):].strip()[:150] + tag)
        elif s_.startswith("сборка GeoTIFF"):
            progress(base + span * 0.58, "Сборка GeoTIFF: " + s_.split(":", 1)[-1].strip()[:150] + tag)
        elif ".mbtiles: z" in s_:
            progress(base + span * 0.03, "Чтение MBTiles: " + s_[:170])

    def log(*a):
        text = " ".join(str(x) for x in a)
        print("[%6.1fs] %s" % (time.time() - T0, text), flush=True)
        hook(text)
    res, used = [], set()
    for i, src in enumerate(srcs):
        st["i"], st["name"] = i, src.name
        name = safe_stem(src.name)
        k = 2
        while name.lower() in used:
            name, k = f"{safe_stem(src.name)}_{k}", k + 1
        used.add(name.lower())
        progress(4 + span * i, f"Чтение MBTiles: {src.name}" + (f" ({i + 1} из {total})" if total > 1 else ""))
        try:
            info = m2t.convert(src, out, zoom=t.get("zoom") or "max", crs=t.get("crs") or "EPSG:3857",
                               compress=t.get("compress") or "deflate", background=t.get("background") or "none",
                               clip=t.get("clip") or "auto", max_mp=float(os.environ.get("GEOREF_MB2TIF_MAX_MP", "400")),
                               resampling=t.get("resampling") or "cubic", overviews=bool(t.get("overviews", True)),
                               threads=int(os.environ.get("GEOREF_THREADS", "4")), name=name, log_fn=log)
        except SystemExit as e:
            msg = str(e.code if e.code is not None else "не удалось собрать GeoTIFF")
            if total == 1:
                fail(msg)
            st["warn"].append(f"ВНИМАНИЕ: {src.name}: {msg}")
            continue
        except Exception as e:  # noqa — один битый файл не валит остальные
            if total == 1:
                fail(f"{src.name}: {type(e).__name__}: {e}")
            st["warn"].append(f"ВНИМАНИЕ: {src.name}: {type(e).__name__}: {str(e)[:200]}")
            continue
        res.append(info)
        progress(4 + span * (i + 1), f"Сборка GeoTIFF: готово {len(res)} из {total} — {info['file']}")
    if not res:
        fail("GeoTIFF не созданы: " + ("; ".join(w.replace("ВНИМАНИЕ: ", "") for w in st["warn"][-3:]) or "нет подходящих MBTiles"))
    return {"kind": "mb2tif", "ok": True, "outputs": res, "warnings": st["warn"][-20:],
            "params": {k: t.get(k) for k in ("zoom", "crs", "compress", "background", "clip", "resampling", "overviews")},
            "elapsed_s": round(time.time() - T0, 1)}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    if not argv:
        fail("использование: georef_runner.py <папка задания>", 1)
    if argv[0] == "--check":                      # проверка окружения для /api/georef/caps
        mods = {}
        for m in ("numpy", "cv2", "rasterio", "shapely", "mapbox_vector_tile", "PIL", "pypdfium2", "fitz", "pytesseract"):
            try:
                __import__(m)
                mods[m] = True
            except Exception:
                mods[m] = False
        try:
            td = str(tools_dir())
        except SystemExit:
            td = None
        tools = {n: bool(td and (Path(td) / f"{n}.py").is_file()) for n in ("georef_plans", "tif2mbtiles", "mbtiles2tif")}
        print(json.dumps({"modules": mods, "tools_dir": td, "tools": tools, "python": sys.version.split()[0]}))
        return
    jd = Path(argv[0]).resolve()
    p = json.loads((jd / "params.json").read_text(encoding="utf-8"))
    kind = p.get("kind") or "georef"
    res = georef_job(jd, p) if kind == "georef" else mb2tif_job(jd, p) if kind == "mb2tif" else mbtiles_job(jd, p)
    out = jd / "out"
    res["files"] = sorted(x.name for x in out.iterdir() if x.is_file() and not x.name.startswith("."))
    tmp = out / ".result.json.tmp"
    tmp.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
    os.replace(tmp, out / "result.json")
    if not res.get("ok"):
        fail("ни один лист не привязан — проверьте место (адрес/точку), масштаб и радиус поиска")
    progress(100, "Готово")


if __name__ == "__main__":
    main()
