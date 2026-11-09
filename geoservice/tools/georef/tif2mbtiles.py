#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tif2mbtiles.py - MBTiles (растровые тайлы) из привязанных растров: GeoTIFF, а также TIF/JPG/PNG/BMP
с world-файлом (.tfw/.tfwx/.jgw/.pgw/.wld) и .prj/.aux.xml. На входе - файлы, папки (рекурсивно)
и архивы zip/7z/rar/tar(.gz/.bz2/.xz), в т.ч. вложенные; имена с кириллицей поддерживаются.

  python tif2mbtiles.py Avg_001.tif Avg_002.tif          # Avg_001.mbtiles, Avg_002.mbtiles рядом с TIF
  python tif2mbtiles.py планы.zip -o out                  # все привязанные растры архива
  python tif2mbtiles.py out --merge Avg_131.mbtiles       # все растры папки - в один MBTiles

СК: MBTiles по стандарту (1.3) - всегда Web Mercator EPSG:3857 (сетка XYZ/Google, ряды в файле - TMS).
Растры в EPSG:3857 (результат georef_plans.py) режутся в той же СК, без перепроецирования - только
пересчёт на сетку тайлов; растры в других СК (СК-63/1942, UTM, WGS84, МСК с .prj) перепроецируются.
Привязка ищется так: встроенная (GeoTIFF, .aux.xml, .tab, GCP - через GDAL) -> world-файл ->
СК из .prj / .aux.xml -> координаты в градусах = EPSG:4326 -> --src-crs.
[v20.3] СК «молча» не подставляется: по умолчанию (--src-crs auto) СК файла без описания определяется по координатам -
Web Mercator, СК-42 6°/3° (с номером зоны и без), UTM, - если однозначно попадает в регион (GEOREF_REGION_BBOX,
по умолчанию Беларусь), иначе - ошибка с вариантами (раньше подставлялась EPSG:3857 и растр уходил за тысячи км).
Растр вне региона при любой СК - предупреждение. --shift DX,DY - сдвиг результата (м EPSG:3857), --only - один растр.
Фон: по умолчанию белый - тайлы непрозрачные, вне растра и на «нет данных» белое (--background none - прозрачно).
Бумага сканов-чертежей очищается до белого: серый тон, тени, пятна, сгибы (--paper clean|original|transparent|auto).
"""
import argparse
import glob
import html
import io
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import warnings
import zipfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageFilter

import rasterio
from rasterio.crs import CRS
from rasterio.enums import ColorInterp, Resampling
from rasterio.errors import NotGeoreferencedWarning
from rasterio.transform import Affine, from_gcps
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

warnings.filterwarnings('ignore', category=NotGeoreferencedWarning)

R_EARTH = 6378137.0
HALF = math.pi * R_EARTH                      # 20037508.34 м: половина длины экватора Web Mercator
WORLD = 2 * HALF
MERC = CRS.from_epsg(3857)
MAX_ZOOM = 24
RASTER_EXT = ('.tif', '.tiff', '.gtif', '.gtiff', '.geotiff', '.jpg', '.jpeg', '.jpe', '.png', '.bmp', '.gif',
              '.webp', '.jp2', '.j2k', '.img', '.vrt', '.ecw', '.sid', '.rsw')
ARCHIVE_EXT = ('.zip', '.7z', '.rar', '.tar', '.tgz', '.tbz', '.tbz2', '.txz', '.tar.gz', '.tar.bz2', '.tar.xz')
FORMATS = {'png': 'png', 'png8': 'png', 'jpg': 'jpg', 'webp': 'webp'}
EMPTY = 0.5 / 255                             # альфа меньше этого - пиксель пустой
T_START = time.time()


def _log(*a):
    print('[%6.1fs]' % (time.time() - T_START), *a, flush=True)


class Log:
    def __init__(self, fn=None):
        self.fn = fn or _log

    def __call__(self, *a):
        self.fn(*a)

    def warn(self, *a):
        self.fn('ВНИМАНИЕ:', *a)


# ------------------------------------------------------------------------------------------ входные файлы
def lower_ext(p):
    n = p.lower()
    for e in ('.tar.gz', '.tar.bz2', '.tar.xz', '.aux.xml'):
        if n.endswith(e):
            return e
    return os.path.splitext(n)[1]


def is_archive(p):
    return lower_ext(p) in ARCHIVE_EXT or (os.path.isfile(p) and lower_ext(p) not in RASTER_EXT and zipfile.is_zipfile(p))


def is_raster(p):
    return lower_ext(p) in RASTER_EXT


def clean_parts(name):
    """имя из архива -> безопасные части пути (без абсолютных путей, '..', дисков и запрещённых символов)"""
    out = []
    for part in name.replace('\\', '/').split('/'):
        part = re.sub(r'[<>:"|?*\x00-\x1f]', '_', part).strip().rstrip('.')
        if part and part not in ('.', '..'):
            out.append(part)
    return out


def zip_name(info):
    """имена без флага UTF-8: zipfile читает их как CP437 - перекодируем (UTF-8 без флага, иначе CP866 - Windows)"""
    n = info.filename
    if not info.flag_bits & 0x800:
        try:
            raw = n.encode('cp437')
        except UnicodeEncodeError:
            return n
        for enc in ('utf-8', 'cp866'):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                pass
    return n


def find_7z():
    names = ['7z', '7zz', '7za', '7zr']
    for n in names:
        p = shutil.which(n)
        if p:
            yield p, n
    for d in (os.environ.get('ProgramFiles', r'C:\Program Files'), os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')):
        p = os.path.join(d, '7-Zip', '7z.exe')
        if os.path.isfile(p):
            yield p, '7z'


def extract_archive(path, dest, log):
    """распаковка во временную папку; True - успешно"""
    os.makedirs(dest, exist_ok=True)
    ext = lower_ext(path)
    try:
        if ext == '.zip' or (ext not in ARCHIVE_EXT and zipfile.is_zipfile(path)):
            with zipfile.ZipFile(path) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    parts = clean_parts(zip_name(info))
                    if not parts:
                        continue
                    out = os.path.join(dest, *parts)
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    with zf.open(info) as fi, open(out, 'wb') as fo:
                        shutil.copyfileobj(fi, fo, 1 << 20)
            return True
        if ext in ('.tar', '.tgz', '.tbz', '.tbz2', '.txz', '.tar.gz', '.tar.bz2', '.tar.xz'):
            with tarfile.open(path) as tf:
                for m in tf:
                    if not m.isfile():                  # ссылки и устройства не распаковываем
                        continue
                    parts = clean_parts(m.name)
                    if not parts:
                        continue
                    out = os.path.join(dest, *parts)
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    with tf.extractfile(m) as fi, open(out, 'wb') as fo:
                        shutil.copyfileobj(fi, fo, 1 << 20)
            return True
        if ext == '.7z':
            try:
                import py7zr                                # необязательный модуль (pip install py7zr)
                with py7zr.SevenZipFile(path) as z:
                    z.extractall(dest)
                return True
            except ImportError:
                pass
        tools = list(find_7z())
        if ext == '.rar':
            tools = [(p, n) for p, n in tools if n in ('7z', '7zz')]
            for n in ('unrar', 'unar', 'bsdtar'):
                p = shutil.which(n)
                if p:
                    tools.append((p, n))
        for exe, n in tools:
            cmd = {'unrar': [exe, 'x', '-o+', '-y', path, dest + os.sep], 'unar': [exe, '-q', '-f', '-o', dest, path],
                   'bsdtar': [exe, '-xf', path, '-C', dest]}.get(n, [exe, 'x', '-y', '-o' + dest, path])
            r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if r.returncode == 0:
                return True
        log.warn(f'{os.path.basename(path)}: не удалось распаковать - для {ext} нужен 7-Zip (7z/7za в PATH)'
                 + (' или unrar' if ext == '.rar' else '') + ', либо перепакуйте в zip')
    except (zipfile.BadZipFile, tarfile.TarError, OSError, RuntimeError, NotImplementedError) as e:
        log.warn(f'{os.path.basename(path)}: архив не прочитан ({e})')
    return False


def collect_inputs(paths, tmp, log):
    """-> [(путь к растру, подпись, папка вывода по умолчанию)]"""
    items, n_arch = [], [0]

    def add_dir(d, label, outdir, depth):
        for root, dirs, files in os.walk(d):
            dirs[:] = sorted(x for x in dirs if not x.startswith('.') and x != '__MACOSX')
            for f in sorted(files):
                if f.startswith('.'):
                    continue
                p = os.path.join(root, f)
                rel = os.path.relpath(p, d).replace(os.sep, '/')
                if is_raster(p):
                    items.append((p, f'{label}/{rel}' if label else rel, outdir or root))
                elif lower_ext(p) in ARCHIVE_EXT and depth < 3:
                    add_archive(p, f'{label}/{rel}' if label else rel, outdir or root, depth + 1)

    def add_archive(p, label, outdir, depth):
        n_arch[0] += 1
        dest = os.path.join(tmp, f'a{n_arch[0]:03d}')
        if extract_archive(p, dest, log):
            k = len(items)
            add_dir(dest, label, outdir, depth)
            log(f'{label}: архив, растров {len(items) - k}')

    for raw in paths:
        ps = sorted(glob.glob(raw)) if any(ch in raw for ch in '*?[') and not os.path.exists(raw) else [raw]
        if not ps:
            log.warn(f'{raw}: нет таких файлов')
        for p in ps:
            if os.path.isdir(p):
                k = len(items)
                add_dir(p, os.path.basename(os.path.normpath(p)), None, 0)
                log(f'{p}: папка, растров {len(items) - k}')
            elif not os.path.isfile(p):
                log.warn(f'{p}: файл не найден')
            elif is_raster(p):
                items.append((p, os.path.basename(p), os.path.dirname(os.path.abspath(p))))
            elif is_archive(p):
                add_archive(p, os.path.basename(p), os.path.dirname(os.path.abspath(p)), 1)
            else:
                log.warn(f'{p}: не растр и не архив - пропущен')
    return items


# ------------------------------------------------------------------------------------------ привязка
def sidecar(path, exts):
    """файл рядом с растром: <имя>.<ext> или <имя.расш>.<ext>, регистр не важен"""
    d, fn = os.path.split(path)
    stem = os.path.splitext(fn)[0]
    try:
        names = {n.lower(): n for n in os.listdir(d or '.')}
    except OSError:
        return None
    for e in exts:
        for cand in (f'{stem}.{e}', f'{fn}.{e}'):
            n = names.get(cand.lower())
            if n:
                return os.path.join(d, n)
    return None


def world_exts(path):
    e = os.path.splitext(path)[1].lower().lstrip('.')
    out = []
    if e:
        s = e[0] + e[-1] + 'w'                                 # tif -> tfw, jpg -> jgw, png -> pgw, bmp -> bpw
        out += [s, s + 'x', e + 'w', e + 'wx']
    for x in ('wld', 'tfw', 'tfwx', 'jgw', 'jgwx', 'pgw', 'pgwx'):
        if x not in out:
            out.append(x)
    return out


def read_world(p):
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    try:
        v = [float(ln.replace(',', '.')) for ln in lines[:6]]
    except ValueError:
        v = [float(t) for t in re.findall(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?', ' '.join(lines))[:6]]
    if len(v) < 6 or v[0] == 0 or v[3] == 0 and v[1] == 0:
        raise ValueError(f'{os.path.basename(p)}: не world-файл')
    A, D, B, E, C, F = v                                       # C, F - центр левого верхнего пикселя
    return Affine(A, B, C - A / 2 - B / 2, D, E, F - D / 2 - E / 2)


def read_text(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'cp1251'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode('latin-1')


def parse_crs(txt):
    txt = (txt or '').strip()
    if not txt:
        return None
    for fn in ((CRS.from_wkt, CRS.from_user_input) if '[' in txt else (CRS.from_user_input,)):
        try:
            c = fn(txt)
            if c:
                return c
        except Exception:
            pass
    return None


def crs_label(crs):
    try:
        e = crs.to_epsg()
    except Exception:
        e = None
    m = re.match(r'\s*\w+\["([^"]+)"', crs.to_wkt() or '')
    name = m.group(1) if m else crs.to_string()[:60]
    return f'EPSG:{e} ({name})' if e else name


def is_merc(crs):
    try:
        return crs == MERC or crs.to_epsg() == 3857
    except Exception:
        return False


# ------------------------------------------------------------------------------------------ [v20.3] СК без описания
REGION = (23.0, 51.1, 33.0, 56.4)              # Беларусь с запасом ~20-30 км: lon0, lat0, lon1, lat1
AUTO_CRS = ('', 'auto', 'авто', 'epsg:3857')   # EPSG:3857 был значением по умолчанию - теперь тоже «авто»


def region_bbox():
    """регион проверки «растр на месте»: GEOREF_REGION_BBOX=lon0,lat0,lon1,lat1 (off - без проверки)"""
    v = (os.environ.get('GEOREF_REGION_BBOX') or '').strip()
    if v.lower() in ('0', 'off', 'none', 'no', 'world'):
        return None
    if v:
        try:
            b = [float(t) for t in re.split(r'[\s,;]+', v) if t]
            if len(b) == 4 and b[0] < b[2] and b[1] < b[3]:
                return tuple(b)
        except ValueError:
            pass
    return REGION


def region_txt(reg):
    return 'в пределах Беларуси' if reg == REGION else 'в регионе %g…%g° в.д., %g…%g° с.ш.' % (reg[0], reg[2], reg[1], reg[3])


def crs_candidates(xc):
    """СК, к которым могут относиться метровые координаты с восточной составляющей xc"""
    out = [('EPSG:3857', 'Web Mercator (EPSG:3857)')]
    z = int(xc // 1e6)
    if 1e5 <= xc - z * 1e6 <= 9e5:                       # номер зоны в старших разрядах X
        if 2 <= z <= 32:
            out.append((f'EPSG:{28400 + z}', f'СК-42 6°, зона {z} (EPSG:{28400 + z})'))
        if 7 <= z <= 13:
            out.append((f'EPSG:{2516 + z}', f'СК-42 3°, зона {z} (EPSG:{2516 + z})'))
    if 1e5 <= xc <= 9e5:                                 # без номера зоны: UTM и СК-42 с X = 500 000 на осевом
        out += [(f'EPSG:{32600 + n}', f'UTM {n}N (EPSG:{32600 + n})') for n in range(1, 61)]
        out += [(f'EPSG:{c}', f'СК-42 6° без № зоны, осевой {m}° (EPSG:{c})') for m, c in ((21, 2494), (27, 2495), (33, 2496))]
        out += [(f'EPSG:{c}', f'СК-42 3° без № зоны, осевой {m}° (EPSG:{c})')
                for m, c in ((21, 2582), (24, 2583), (27, 2584), (30, 2585), (33, 2586))]
    return out


def guess_crs(x, y, reg):
    """[(код, подпись)] - СК, в которых все углы растра попадают в регион; совпадающие по месту (6° и 3° с одним
    осевым меридианом) - одной строкой"""
    if reg is None:
        return []
    x, y = np.asarray(x, float), np.asarray(y, float)
    fits, where = [], []
    for code, lab in crs_candidates(float(np.median(x))):
        try:
            lon, lat = warp_transform(CRS.from_user_input(code), 'EPSG:4326', x.tolist(), y.tolist())
        except Exception:
            continue
        lon, lat = np.asarray(lon, float), np.asarray(lat, float)
        if np.all(np.isfinite(lon) & np.isfinite(lat)) and \
                np.all((lon >= reg[0]) & (lon <= reg[2]) & (lat >= reg[1]) & (lat <= reg[3])):
            k = next((i for i, (lo, la) in enumerate(where) if np.max(np.abs(lo - lon)) < 1e-5 and np.max(np.abs(la - lat)) < 1e-5), None)
            if k is None:
                fits.append((code, lab))
                where.append((lon, lat))
            elif ' 6° ' in fits[k][1] and ' 3° ' in lab:
                fits[k] = (fits[k][0], fits[k][1].replace(' 6° ', ' 6°/3° '))
    return fits


def crs_without_description(args, x, y, name, log):
    """[v20.3] в файле нет СК: явная --src-crs; auto - по координатам, только если однозначно"""
    src = (args.src_crs or 'auto').strip()
    if src.lower() not in AUTO_CRS:
        crs = parse_crs(src)
        if crs is None:
            raise ValueError(f'СК «{src[:80]}» (--src-crs) не распознана')
        return crs, f'не задана -> {src[:80]} (--src-crs)'
    reg = region_bbox()
    xy = f'X {np.median(x):.0f}, Y {np.median(y):.0f}'
    tip = 'выберите СК в «Если в файле нет СК» (--src-crs) или приложите .prj'
    if reg is None:
        raise ValueError(f'в файле нет СК (.prj / GeoTIFF), координаты {xy}; проверка региона отключена (GEOREF_REGION_BBOX=off) - {tip}')
    fits = guess_crs(x, y, reg)
    if len(fits) == 1:
        log.warn(f'{name}: в файле нет СК (.prj / GeoTIFF) - по координатам ({xy}) принята {fits[0][1]}; '
                 'если растр не на месте - выберите СК вручную')
        return CRS.from_user_input(fits[0][0]), f'не задана; по координатам -> {fits[0][1]}'
    if not fits:
        raise ValueError(f'в файле нет СК (.prj / GeoTIFF), а координаты ({xy}) {region_txt(reg)} не подходят ни к Web Mercator, '
                         f'ни к СК-42 (6° и 3° зоны), ни к UTM - вероятно, местная СК (МСК, СК-63): {tip}')
    raise ValueError(f'в файле нет СК (.prj / GeoTIFF), координаты ({xy}) {region_txt(reg)} подходят к нескольким СК: '
                     + '; '.join(lab for _, lab in fits[:6]) + f' - {tip}')


def corners_px(w, h, n=16):
    t = np.linspace(0, 1, n + 1)[:-1]
    cols = np.concatenate([t * w, np.full(n, float(w)), (1 - t) * w, np.zeros(n)])
    rows = np.concatenate([np.zeros(n), t * h, np.full(n, float(h)), (1 - t) * h])
    return cols, rows


def resolve_georef(ds, path, args, log):
    """-> (transform, crs, откуда привязка, откуда СК) или None"""
    T, crs = ds.transform, ds.crs
    files = [os.path.basename(f) for f in (ds.files or [])[1:]]
    wfs = [f for f in files if re.search(r'\.(?:[a-z]{2,5}w|wld|tab)$', f, re.I)]
    if not T.is_identity:
        how = ((f'MapInfo {wfs[0]}' if wfs[0].lower().endswith('.tab') else f'world-файл {wfs[0]}') if wfs else
               'GeoTIFF' if ds.driver == 'GTiff' else f'{ds.driver} (GDAL)')
    elif ds.gcps[0]:
        gcps, gcrs = ds.gcps
        T = from_gcps(gcps)
        crs = crs or gcrs
        P = np.array([[g.col, g.row, g.x, g.y] for g in gcps], float)
        x, y = T * (P[:, 0], P[:, 1])
        how = f'GCP {len(gcps)} точек (аффинно, СКО {np.sqrt(np.mean((x - P[:, 2]) ** 2 + (y - P[:, 3]) ** 2)):.3g})'
    else:
        wf = sidecar(path, world_exts(path))
        if not wf:
            return None
        T = read_world(wf)
        how = f'world-файл {os.path.basename(wf)}'
    if args.force_crs:
        crs, how_crs = parse_crs(args.force_crs), '--force-crs'
    elif crs:
        aux = [f for f in files if f.lower().endswith('.aux.xml')]
        how_crs = ('GeoTIFF' if ds.driver == 'GTiff' and not wfs else
                   f'MapInfo {wfs[0]}' if wfs and wfs[0].lower().endswith('.tab') else aux[0] if aux else f'{ds.driver} (GDAL)')
    else:
        crs = how_crs = None
        p = sidecar(path, ['prj'])
        if p:
            crs, how_crs = parse_crs(read_text(p)), os.path.basename(p)
            if crs is None:
                log.warn(f'{os.path.basename(p)}: СК не распознана')
        if crs is None:
            p = sidecar(path, ['aux.xml'])
            m = re.search(r'<SRS[^>]*>(.*?)</SRS>', read_text(p), re.S) if p else None
            if m:
                crs, how_crs = parse_crs(html.unescape(m.group(1))), os.path.basename(p)
        if crs is None:
            c, r = corners_px(ds.width, ds.height, 1)
            x, y = T * (c, r)
            if np.all(np.abs(x) <= 180) and np.all(np.abs(y) <= 90) and abs(T.a) < 1:
                crs, how_crs = CRS.from_epsg(4326), 'не задана; координаты в градусах -> EPSG:4326'
            else:
                crs, how_crs = crs_without_description(args, x, y, os.path.basename(path), log)
    if crs is None:
        raise ValueError('СК не распознана: укажите --force-crs')
    return T, crs, how, how_crs


# ------------------------------------------------------------------------------------------ источник
class Source:
    def __init__(self, path, label, outdir, args, tmp, log):
        self.path, self.label, self.outdir, self.log = path, label, outdir, log
        self.ds = rasterio.open(path)
        self.tmp_ds = self.vrt = self.paper_ds = None
        try:
            g = resolve_georef(self.ds, path, args, log)
        except Exception:
            self.close()
            raise
        if g is None:
            self.close()
            raise LookupError('нет привязки (GeoTIFF, world-файл .tfw/.jgw/.pgw/.wld) - пропущен')
        self.T, self.crs, self.how, self.how_crs = g
        self.w, self.h = self.ds.width, self.ds.height
        self.same = is_merc(self.crs)
        self.shift = tuple(args.shift or (0.0, 0.0))          # [v20.3] сдвиг результата, м EPSG:3857
        try:
            self.footprint()
        except Exception:
            self.close()
            raise
        self.check_region(log)
        self.prepare(args, tmp)
        ts = args.tile_size
        self.native_z = math.log2(WORLD / (ts * self.res))
        self.zmax = int(min(MAX_ZOOM, max(0, math.ceil(self.native_z - 0.3))))
        self.zmin = int(max(0, min(self.zmax, math.floor(self.native_z - math.log2(max(self.w, self.h, 256) / 256)) - 1)))

    def footprint(self):
        c, r = corners_px(self.w, self.h)
        x, y = self.T * (c, r)
        if not self.same:
            try:
                x, y = warp_transform(self.crs, MERC, x, y)
            except Exception as e:
                raise ValueError(f'СК {crs_label(self.crs)} не пересчитывается в EPSG:3857 ({e}); укажите --force-crs')
        x, y = np.asarray(x, float) + self.shift[0], np.asarray(y, float) + self.shift[1]
        ok = np.isfinite(x) & np.isfinite(y)
        if ok.sum() < 4:
            raise ValueError('координаты вне Web Mercator - проверьте СК (--src-crs/--force-crs)')
        x, y = np.clip(x[ok], -HALF, HALF), np.clip(y[ok], -HALF, HALF)
        if x.max() - x.min() <= 0 or y.max() - y.min() <= 0:
            raise ValueError('координаты вне Web Mercator - проверьте СК (--src-crs/--force-crs)')
        self.bounds = (x.min(), y.min(), x.max(), y.max())
        area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
        self.res = math.sqrt(max(area, 1e-12) / (self.w * self.h))       # м Web Mercator на пиксель
        lon0, lat0 = merc2ll(self.bounds[0], self.bounds[1])
        lon1, lat1 = merc2ll(self.bounds[2], self.bounds[3])
        self.lonlat = (lon0, lat0, lon1, lat1)

    def check_region(self, log):
        """[v20.3] растр вне региона - предупреждение (вероятно, неверная СК)"""
        reg = region_bbox()
        if reg is None:
            return
        lon, lat = (self.lonlat[0] + self.lonlat[2]) / 2, (self.lonlat[1] + self.lonlat[3]) / 2
        if reg[0] <= lon <= reg[2] and reg[1] <= lat <= reg[3]:
            return
        msg = (f'{self.label}: растр вне региона - центр {lat:.4f}° с.ш., {lon:.4f}° в.д. (ожидается {region_txt(reg)}) '
               f'при СК {crs_label(self.crs)} ({self.how_crs}) - проверьте СК')
        if self.how_crs.startswith('не задана -> '):         # явная --src-crs у файла без СК
            c, r = corners_px(self.w, self.h, 1)
            fits = guess_crs(*(self.T * (c, r)), reg)
            if fits:
                msg += '; по координатам подходит: ' + '; '.join(lab for _, lab in fits[:4])
        log.warn(msg)

    def prepare(self, args, tmp):
        """палитра / не 8 бит -> временный 8-битный GeoTIFF; выбор каналов RGB|серый + альфа"""
        ds = self.ds
        ci = list(ds.colorinterp)
        try:
            cmap = ds.colormap(1)
        except ValueError:
            cmap = None
        if cmap or ds.dtypes[0] != 'uint8':
            self.tmp_path = os.path.join(tmp, f'u8_{abs(hash(self.path)) % 10 ** 8}_{len(os.listdir(tmp))}.tif')
            self.convert(cmap, ci, args)
            self.tmp_ds = rasterio.open(self.tmp_path)
            ds, ci = self.tmp_ds, list(self.tmp_ds.colorinterp)
            self.converted = True
        else:
            self.converted = False
        self.wds = ds
        alpha = [i + 1 for i, c in enumerate(ci) if c == ColorInterp.alpha]
        self.alpha = alpha[-1] if alpha else None
        color = [i + 1 for i in range(ds.count) if i + 1 != self.alpha]
        self.bands = color[:3] if len(color) >= 3 else color[:1]
        self.nodata = args.src_nodata if args.src_nodata is not None else (None if self.converted else ds.nodata)
        self.mode = ('RGB' if len(self.bands) == 3 else 'серый') + ('+альфа' if self.alpha else '')
        self.paper = 'original'
        if args.paper != 'original':
            self.make_paper(args, tmp)

    def make_paper(self, args, tmp):
        """бумага листа -> чисто белая (--paper clean) или прозрачная (transparent); auto - clean, если растр похож
        на чертёж на светлой бумаге, иначе без изменений (ортофото, тёмный фон). Фон бумаги (тени, пятна, сгибы,
        неравномерность скана) оценивается локально: уменьшенный растр min(R,G,B) -> 85-й процентиль в окнах 9×9 и
        5×5 -> размытие, уточнение на полном разрешении (резкие тени сгибов); оттенок бумаги - по медианам каналов. Цвет делится на фон (бумага = 255), альфа бумаги =
        (порог - min канал) / 25, цвет полупрозрачных пикселей «вычитается» из белого: transparent - на подложке
        линии без светлого ореола; clean - то же на белом: бумага 255, линии как в исходнике, лист непрозрачный"""
        ds, thr, soft, mode = self.wds, float(args.white_threshold), 25.0, args.paper
        w, h = ds.width, ds.height
        f = max(1, int(math.ceil(max(w, h) / 1600)))
        sw, sh = max(1, w // f), max(1, h // f)
        small = ds.read(self.bands, out_shape=(len(self.bands), sh, sw), resampling=Resampling.average).astype(np.float32)
        valid = np.ones((sh, sw), bool)
        if self.alpha:
            valid &= ds.read(self.alpha, out_shape=(sh, sw), resampling=Resampling.average) >= 128
        if self.nodata is not None:
            valid &= ~np.all(small == self.nodata, axis=0)
        if valid.mean() < 0.005:
            return
        if mode == 'auto':
            v = small.max(0)[valid]
            if np.median(v) < 190 or np.mean(v >= 190) < 0.6:
                self.mode += ', бумага как в исходнике (растр не похож на чертёж на светлой бумаге)'
                return
            mode = 'clean'
        sm = small.min(0)
        sm[~valid] = np.median(sm[valid])
        im = Image.fromarray(np.clip(sm + 0.5, 0, 255).astype(np.uint8))
        bg = lambda k, r: np.asarray(im.filter(ImageFilter.RankFilter(k, int(k * k * 0.85))).filter(ImageFilter.GaussianBlur(r)), np.float32)
        Bc = bg(9, 9)                                   # фон бумаги крупно (без линий, текста, штриховок)
        Bc = np.clip(Bc, max(120.0, float(np.median(Bc)) - 45), 255)
        B = np.maximum(bg(5, 2), Bc - 30)               # + узкие полосы/тени скана (не темнее крупного фона на 30)
        paper = valid & (sm >= B - 8)
        k = np.ones((len(self.bands), 1, 1), np.float32)
        if len(self.bands) == 3 and paper.sum() > 100:  # оттенок бумаги (желтоватая/серая) -> нейтрально белая
            pm = max(1.0, float(np.median(sm[paper])))
            k[:, 0, 0] = [np.clip(np.median(small[i][paper]) / pm, 1.0, 1.6) for i in range(3)]
        f2 = max(1, int(math.ceil(max(w, h) / 4000)))   # точно (≈ полное разрешение): резкие тени сгибов, края листа
        if f2 < f:
            sw2, sh2 = max(1, w // f2), max(1, h // f2)
            fine = ds.read(self.bands, out_shape=(len(self.bands), sh2, sw2), resampling=Resampling.average).min(0)
            im2 = Image.fromarray(np.ascontiguousarray(fine, dtype=np.uint8))
            Bf = np.asarray(im2.filter(ImageFilter.RankFilter(5, 21)).filter(ImageFilter.GaussianBlur(1.5)), np.float32)
            Bu = np.asarray(Image.fromarray(B.astype(np.float32), 'F').resize((sw2, sh2), Image.BILINEAR), np.float32)
            B, sw, sh = np.maximum(Bf, Bu - 15), sw2, sh2       # не темнее грубой оценки на 15 - толстые линии не светлеют
        xs = (np.arange(w) + 0.5) * (sw / w) - 0.5
        x0 = np.clip(np.floor(xs).astype(int), 0, sw - 1)
        x1, wx = np.clip(x0 + 1, 0, sw - 1), np.clip(xs - x0, 0, 1).astype(np.float32)
        transparent = mode == 'transparent'
        keep_a = bool(transparent or self.alpha or self.nodata is not None)
        path = os.path.join(tmp, f'paper_{len(os.listdir(tmp))}.tif')
        nc = len(self.bands)
        nb = nc + (1 if keep_a else 0)
        prof = dict(driver='GTiff', width=w, height=h, count=nb, dtype='uint8', crs=self.crs, transform=self.T,
                    tiled=True, blockxsize=256, blockysize=256, compress='DEFLATE', zlevel=1,
                    photometric='RGB' if nc == 3 else 'MINISBLACK', BIGTIFF='IF_SAFER')
        if keep_a:
            prof['alpha'] = 'YES'
        with rasterio.open(path, 'w', **prof) as dst:
            for r0 in range(0, h, 512):
                hh = min(512, h - r0)
                win = Window(0, r0, w, hh)
                ys = (np.arange(r0, r0 + hh) + 0.5) * (sh / h) - 0.5
                y0 = np.clip(np.floor(ys).astype(int), 0, sh - 1)
                y1, wy = np.clip(y0 + 1, 0, sh - 1), np.clip(ys - y0, 0, 1).astype(np.float32)[:, None]
                Bs = ((B[y0][:, x0] * (1 - wx) + B[y0][:, x1] * wx) * (1 - wy) +
                      (B[y1][:, x0] * (1 - wx) + B[y1][:, x1] * wx) * wy)
                c = ds.read(self.bands, window=win)
                cn = c.astype(np.float32) * (255.0 / (Bs[None] * k))
                a = np.clip((thr - cn.min(0)) / soft, 0, 1)
                cu = np.clip(np.where(a > 0, (cn - (1 - a) * 255) / np.maximum(a, 1e-3), 255), 0, 255)
                if not transparent:                     # clean: результат transparent на белом
                    cu = cu * a + 255 * (1 - a)
                    a = np.ones_like(a)
                if self.alpha:
                    a *= ds.read(self.alpha, window=win).astype(np.float32) / 255
                if self.nodata is not None:
                    a[np.all(c == self.nodata, axis=0)] = 0
                out = np.concatenate([cu, a[None] * 255] if keep_a else [cu], 0)
                dst.write(np.clip(out + 0.5, 0, 255).astype(np.uint8), window=win)
        self.paper_ds = rasterio.open(path)
        self.wds, self.converted, self.nodata = self.paper_ds, True, None
        self.bands, self.alpha = list(range(1, nc + 1)), (nb if keep_a else None)
        self.mode += ', бумага -> ' + ('прозрачная' if transparent else 'белая') + (' (авто)' if args.paper == 'auto' else '')
        self.paper = mode

    def convert(self, cmap, ci, args):
        ds = self.ds
        step = max(1, int(max(ds.width, ds.height) / 1500))
        shp = (max(1, ds.height // step), max(1, ds.width // step))
        alpha = [i + 1 for i, c in enumerate(ci) if c == ColorInterp.alpha]
        if cmap:
            n = max(256, max(cmap) + 1)
            lut = np.zeros((n, 4), np.uint8)
            lut[:, 3] = 255
            for k, v in cmap.items():
                lut[k] = (tuple(v) + (255,))[:4]
            if ds.nodata is not None and 0 <= int(ds.nodata) < n:
                lut[int(ds.nodata), 3] = 0
            used = np.unique(ds.read(1, out_shape=shp, resampling=Resampling.nearest))
            gray = bool(np.all(lut[used, 0] == lut[used, 1]) and np.all(lut[used, 1] == lut[used, 2]))
            has_a = bool(np.any(lut[used, 3] < 255))
            sel = ([0] if gray else [0, 1, 2]) + ([3] if has_a else [])
            what = 'палитра -> ' + ('серый' if gray else 'RGB')
        else:
            color = [i + 1 for i in range(ds.count) if i + 1 not in alpha]
            bands = color[:3] if len(color) >= 3 else color[:1]
            s = ds.read(bands, out_shape=(len(bands),) + shp, resampling=Resampling.nearest, masked=True)
            v = s.compressed() if np.ma.is_masked(s) else np.asarray(s).ravel()
            v = v[np.isfinite(v)]
            lo, hi = (np.percentile(v, [2, 98]) if v.size else (0, 1))
            hi = hi if hi > lo else lo + 1
            has_a = bool(alpha) or np.ma.is_masked(s) or ds.nodata is not None or ds.dtypes[0].startswith('float')
            what = f'{ds.dtypes[0]} -> 8 бит (растяжка 2-98%: {lo:.4g}..{hi:.4g})'
        nb = (1 if (cmap and gray) or (not cmap and len(bands) == 1) else 3) + (1 if has_a else 0)
        prof = dict(driver='GTiff', width=ds.width, height=ds.height, count=nb, dtype='uint8', crs=self.crs,
                    transform=self.T, tiled=True, blockxsize=256, blockysize=256, compress='DEFLATE', zlevel=1,
                    photometric='RGB' if nb >= 3 else 'MINISBLACK', BIGTIFF='IF_SAFER')
        if has_a:
            prof['alpha'] = 'YES'
        with rasterio.open(self.tmp_path, 'w', **prof) as dst:
            for r0 in range(0, ds.height, 1024):
                win = Window(0, r0, ds.width, min(1024, ds.height - r0))
                if cmap:
                    out = lut[ds.read(1, window=win)][..., sel].transpose(2, 0, 1)
                else:
                    a = ds.read(bands, window=win, masked=True)
                    m = np.ma.getmaskarray(a).all(0) if (has_a and not alpha) else None
                    d = np.ma.filled(a.astype(np.float32), lo)
                    d = np.nan_to_num(d, nan=lo)
                    out = np.clip((d - lo) / (hi - lo) * 255 + 0.5, 0, 255).astype(np.uint8)
                    if has_a:
                        av = ds.read(alpha[0], window=win) if alpha else np.where(m | ~np.isfinite(a.data).all(0), 0, 255)
                        if alpha and ds.dtypes[0] != 'uint8':
                            av = np.clip(av.astype(np.float32) / max(1.0, float(np.max(av))) * 255, 0, 255)
                        out = np.concatenate([out, np.asarray(av, np.uint8)[None]], 0)
                dst.write(out, window=win)
        self.log(f'{self.label}: {what}')

    def open_vrt(self, z, ts, resampling, args):
        size = WORLD / 2 ** z
        res = size / ts
        self.tile0 = tile_range(self.bounds, z)
        tx0, ty0, tx1, ty1 = self.tile0
        dx, dy = self.shift                         # [v20.3] тайл в точке P <- растр в точке P - сдвиг
        kw = dict(crs=MERC, transform=Affine(res, 0, -HALF + tx0 * size - dx, 0, -res, HALF - ty0 * size - dy),
                  width=(tx1 - tx0 + 1) * ts, height=(ty1 - ty0 + 1) * ts, resampling=resampling,
                  warp_mem_limit=256, NUM_THREADS='ALL_CPUS')
        if not self.converted:
            kw.update(src_crs=self.crs, src_transform=self.T)
        if self.alpha:
            kw.update(src_alpha=self.alpha, dst_alpha=self.alpha)
        else:
            kw['add_alpha'] = True
        if self.nodata is not None:
            kw.update(src_nodata=self.nodata, UNIFIED_SRC_NODATA='YES')
        self.vrt = WarpedVRT(self.wds, **kw)
        self.read_idx = list(self.bands) + [self.alpha or self.wds.count + 1]

    def read_block(self, tx, ty, n, ts):
        """блок n×n тайлов с левым верхним (tx, ty) на уровне open_vrt -> (массив k×h×w, смещение в блоке) | None"""
        vx0, vy0, vx1, vy1 = self.tile0
        ix0, iy0, ix1, iy1 = max(tx, vx0), max(ty, vy0), min(tx + n - 1, vx1), min(ty + n - 1, vy1)
        if ix0 > ix1 or iy0 > iy1:
            return None
        win = Window((ix0 - vx0) * ts, (iy0 - vy0) * ts, (ix1 - ix0 + 1) * ts, (iy1 - iy0 + 1) * ts)
        return self.vrt.read(indexes=self.read_idx, window=win), ((iy0 - ty) * ts, (ix0 - tx) * ts)

    def close(self):
        for d in (self.vrt, self.paper_ds, self.tmp_ds, self.ds):
            try:
                if d is not None:
                    d.close()
            except Exception:
                pass
        self.vrt = self.paper_ds = self.tmp_ds = self.ds = None


# ------------------------------------------------------------------------------------------ тайлы
def merc2ll(x, y):
    return x / HALF * 180.0, math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2)


def tile_range(b, z):
    n, size = 2 ** z, WORLD / 2 ** z
    f = lambda v: min(n - 1, max(0, int(math.floor(v))))
    return (f((b[0] + HALF) / size), f((HALF - b[3]) / size),
            f((b[2] + HALF) / size - 1e-7), f((HALF - b[1]) / size - 1e-7))


def tile_bounds(z, x, y):
    size = WORLD / 2 ** z
    return (-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size)


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def down2(a):
    h, w, c = a.shape
    return a.reshape(h // 2, 2, w // 2, 2, c).mean(axis=(1, 3), dtype=np.float32)


def parse_color(s):
    """white|black|#RRGGBB|R,G,B -> массив 0..1; none|transparent - None (прозрачный фон)"""
    named = {'white': (255, 255, 255), 'black': (0, 0, 0), 'белый': (255, 255, 255), 'черный': (0, 0, 0),
             'чёрный': (0, 0, 0)}
    s = (s or '').strip().lower()
    if s in ('none', 'transparent', 'no', 'off', 'нет', 'прозрачный', 'прозрачно', ''):
        return None
    if s in named:
        c = named[s]
    elif re.fullmatch(r'#?[0-9a-f]{6}', s):
        c = tuple(int(s.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
    else:
        c = tuple(int(v) for v in s.split(','))
        if len(c) != 3 or not all(0 <= v <= 255 for v in c):
            raise ValueError(s)
    return np.array(c, np.float32) / 255


class Encoder:
    def __init__(self, args):
        self.fmt, self.q = args.format, args.quality
        self.bg = parse_color(args.background)            # None - прозрачный фон (кроме jpg)
        self.flat = self.bg if self.bg is not None else np.ones(3, np.float32)

    def __call__(self, t):
        a = t[..., 3]
        u8 = lambda v: np.clip(v * 255 + 0.5, 0, 255).astype(np.uint8)
        b = io.BytesIO()
        if self.bg is not None or self.fmt == 'jpg':      # тайл на фоне: непрозрачный RGB
            img = Image.fromarray(u8(t[..., :3] + self.flat * (1 - a[..., None])))
            if self.fmt == 'jpg':
                img.save(b, 'JPEG', quality=self.q, subsampling=0, optimize=True)
                return b.getvalue()
        elif a.min() >= 1 - EMPTY:
            img = Image.fromarray(u8(t[..., :3]))
        else:
            rgb = np.where(a[..., None] > EMPTY, t[..., :3] / np.maximum(a, EMPTY)[..., None], 0)
            img = Image.fromarray(np.dstack([u8(rgb), u8(a)]))
        if self.fmt == 'webp':
            img.save(b, 'WEBP', quality=self.q, method=4, lossless=self.q >= 100)
        elif self.fmt == 'png8':
            img.quantize(256, method=Image.Quantize.FASTOCTREE).save(b, 'PNG', compress_level=9)
        else:
            img.save(b, 'PNG', compress_level=6)
        return b.getvalue()


class MBTilesWriter:
    def __init__(self, path):
        self.path, self.tmp = path, path + '.part'
        if os.path.exists(self.tmp):
            os.remove(self.tmp)
        self.db = sqlite3.connect(self.tmp)
        self.db.execute('PRAGMA synchronous=OFF')
        self.db.execute('PRAGMA journal_mode=MEMORY')
        self.db.execute('CREATE TABLE metadata (name TEXT, value TEXT)')
        self.db.execute('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
        self.buf, self.count, self.bytes, self.per_zoom = [], 0, 0, {}

    def add(self, z, x, y, data):
        self.buf.append((z, x, (1 << z) - 1 - y, sqlite3.Binary(data)))           # XYZ -> TMS
        self.count += 1
        self.bytes += len(data)
        self.per_zoom[z] = self.per_zoom.get(z, 0) + 1
        if len(self.buf) >= 200:
            self.flush()

    def flush(self):
        if self.buf:
            self.db.executemany('INSERT INTO tiles VALUES (?, ?, ?, ?)', self.buf)
            self.buf = []

    def close(self, meta):
        self.flush()
        self.db.executemany('INSERT INTO metadata VALUES (?, ?)', [(k, str(v)) for k, v in meta.items()])
        self.db.execute('CREATE UNIQUE INDEX name ON metadata (name)')
        self.db.execute('CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)')
        self.db.commit()
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.close()
        os.replace(self.tmp, self.path)

    def abort(self):
        try:
            self.db.close()
        except Exception:
            pass
        if os.path.exists(self.tmp):
            os.remove(self.tmp)


def render_block(srcs, tx, ty, n, ts, args):
    S = n * ts
    acc = None
    for s in srcs:
        r = s.read_block(tx, ty, n, ts)
        if r is None:
            continue
        arr, (oy, ox) = r
        a = arr[-1].astype(np.float32) * (1 / 255)
        if a.max() <= EMPTY:
            continue
        c = arr[:-1].astype(np.float32).transpose(1, 2, 0) * (1 / 255)
        if c.shape[2] == 1:
            c = np.repeat(c, 3, axis=2)
        pm = np.concatenate([c * a[..., None], a[..., None]], axis=2)
        if acc is None:
            acc = np.zeros((S, S, 4), np.float32)
        h, w = pm.shape[:2]
        sl = acc[oy:oy + h, ox:ox + w]
        sl *= 1 - pm[..., 3:4]
        sl += pm
    if acc is None or acc[..., 3].max() <= EMPTY:
        return None
    return acc


def build_mbtiles(out, srcs, args, log, name=None):
    ts = args.tile_size
    zmax = args.maxzoom if args.maxzoom is not None else max(s.zmax for s in srcs)
    zmin = args.minzoom if args.minzoom is not None else min(s.zmin for s in srcs)
    zmax = max(0, min(MAX_ZOOM, zmax))
    zmin = max(0, min(zmin, zmax))
    zb = max(zmin, zmax - 3)                       # уровень блоков: блок = 1 тайл zb = до 8×8 тайлов zmax
    nb = 2 ** (zmax - zb)
    rs = getattr(Resampling, args.resampling)
    for s in srcs:
        s.open_vrt(zmax, ts, rs, args)
    b = (min(s.bounds[0] for s in srcs), min(s.bounds[1] for s in srcs),
         max(s.bounds[2] for s in srcs), max(s.bounds[3] for s in srcs))
    x0, y0, x1, y1 = tile_range(b, zb)
    total = sum(1 for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)
                if any(overlaps(tile_bounds(zb, x, y), s.bounds) for s in srcs))
    enc = Encoder(args)
    opaque = enc.bg is not None                     # фон задан: все тайлы в охвате растров, в т.ч. пустые - сплошной фон
    blank = enc(np.zeros((ts, ts, 4), np.float32)) if opaque else None
    cover = lambda z, x, y: any(overlaps(tile_bounds(z, x, y), s.bounds) for s in srcs)
    wr = MBTilesWriter(out)
    done, seen, t0, t_last = [0], [False], time.time(), [time.time()]

    def emit_block(acc, bx, by, pool):
        jobs, lvl = [], acc
        for z in range(zmax, zb - 1, -1):
            k = 2 ** (z - zb)
            for j in range(k):
                for i in range(k):
                    t = lvl[j * ts:(j + 1) * ts, i * ts:(i + 1) * ts]
                    if t[..., 3].max() > EMPTY:
                        jobs.append((z, bx * k + i, by * k + j, t))
                    elif opaque and cover(z, bx * k + i, by * k + j):
                        jobs.append((z, bx * k + i, by * k + j, None))
            if z > zb:
                lvl = down2(lvl)
        for (z, x, y, _), data in zip(jobs, pool.map(lambda jb: blank if jb[3] is None else enc(jb[3]), jobs)):
            wr.add(z, x, y, data)
        return lvl

    def node(z, x, y, pool):
        if not cover(z, x, y):
            return None
        if z == zb:
            acc = render_block(srcs, x * nb, y * nb, nb, ts, args)
            if acc is not None:
                seen[0] = True
            elif opaque:
                acc = np.zeros((nb * ts, nb * ts, 4), np.float32)
            done[0] += 1
            if time.time() - t_last[0] > 15:
                t_last[0] = time.time()
                log(f'  ... {done[0]}/{total} блоков, тайлов {wr.count}')
            return None if acc is None else emit_block(acc, x, y, pool)
        kids = [node(z + 1, 2 * x + i, 2 * y + j, pool) for j in (0, 1) for i in (0, 1)]
        if all(k is None for k in kids):
            return None
        big = np.zeros((2 * ts, 2 * ts, 4), np.float32)
        for q, k in enumerate(kids):
            if k is not None:
                j, i = divmod(q, 2)
                big[j * ts:(j + 1) * ts, i * ts:(i + 1) * ts] = k
        t = down2(big)
        if t[..., 3].max() <= EMPTY:
            if not opaque:
                return None
            wr.add(z, x, y, blank)
            return t
        wr.add(z, x, y, enc(t))
        return t

    try:
        with ThreadPoolExecutor(max_workers=max(1, args.threads)) as pool:
            tx0, ty0, tx1, ty1 = tile_range(b, zmin)
            for y in range(ty0, ty1 + 1):
                for x in range(tx0, tx1 + 1):
                    node(zmin, x, y, pool)
        r = WORLD / (ts * 2 ** zmax)                 # bounds - по сетке пикселей zmax (GDAL читает без сдвига)
        lon0, lat0 = merc2ll(-HALF + math.floor((b[0] + HALF) / r + 1e-6) * r, HALF - math.ceil((HALF - b[1]) / r - 1e-6) * r)
        lon1, lat1 = merc2ll(-HALF + math.ceil((b[2] + HALF) / r - 1e-6) * r, HALF - math.floor((HALF - b[3]) / r + 1e-6) * r)
        name = name or os.path.splitext(os.path.basename(out))[0]
        crs_txt = '; '.join(sorted({crs_label(s.crs) for s in srcs}))
        bg_txt = ('прозрачный' if not opaque else 'белый' if np.all(enc.bg == 1) else 'чёрный' if np.all(enc.bg == 0)
                  else '#%02x%02x%02x' % tuple(int(round(v * 255)) for v in enc.bg))
        meta = dict(name=name, format=FORMATS[args.format], type='baselayer' if opaque else 'overlay', version='1.0',
                    bounds=f'{lon0:.10f},{lat0:.10f},{lon1:.10f},{lat1:.10f}',
                    center=f'{(lon0 + lon1) / 2:.7f},{(lat0 + lat1) / 2:.7f},{max(zmin, zmax - 3)}',
                    minzoom=zmin, maxzoom=zmax,
                    description=(f'{", ".join(s.label for s in srcs)}; СК источника: {crs_txt}; '
                                 + (f'сдвиг {args.shift[0]:+.3f}, {args.shift[1]:+.3f} м (EPSG:3857); ' if any(args.shift or ()) else '')
                                 + f'тайлы EPSG:3857; фон: {bg_txt}; tif2mbtiles.py'),
                    attribution='')
        if ts != 256:
            meta['tilesize'] = ts
        if wr.count == 0 or not seen[0]:
            raise RuntimeError('нет непустых тайлов')
        wr.close(meta)
    except BaseException:
        wr.abort()
        raise
    for s in srcs:
        if s.vrt is not None:
            s.vrt.close()
            s.vrt = None
    return dict(file=os.path.basename(out), path=os.path.abspath(out), sources=[s.label for s in srcs],
                src_crs=[crs_label(s.crs) for s in srcs], reprojected=any(not s.same for s in srcs),
                georef=[s.how for s in srcs], format=args.format, background=bg_txt, paper=[s.paper for s in srcs],
                tile_size=ts, minzoom=zmin, maxzoom=zmax,
                tiles=wr.count, tiles_per_zoom={str(k): v for k, v in sorted(wr.per_zoom.items())},
                size_mb=round(os.path.getsize(out) / 2 ** 20, 2), bounds_lonlat=[lon0, lat0, lon1, lat1],
                how_crs=[s.how_crs for s in srcs], seconds=round(time.time() - t0, 1),
                **({'shift_3857': [float(v) for v in args.shift]} if any(args.shift or ()) else {}))


# ------------------------------------------------------------------------------------------ main
def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description='MBTiles (EPSG:3857) из привязанных растров: файлы, папки, архивы zip/7z/rar/tar',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='GeoTIFF / растры с world-файлом, папки, архивы; маски вида *.tif')
    ap.add_argument('-o', '--out', default=None, help='папка результатов (по умолчанию - рядом с файлом/архивом)')
    ap.add_argument('--merge', default=None, metavar='NAME.mbtiles',
                    help='все растры в один MBTiles (наложение по порядку входов: следующие поверх предыдущих)')
    ap.add_argument('--name', default=None, help='название слоя (metadata name); по умолчанию - имя файла')
    g = ap.add_argument_group('тайлы')
    g.add_argument('--minzoom', type=int, default=None, help='мин. уровень (по умолчанию - весь растр ≈ 1/2 тайла)')
    g.add_argument('--maxzoom', type=int, default=None, help='макс. уровень (по умолчанию - не грубее разрешения растра)')
    g.add_argument('--format', default='png', choices=list(FORMATS), help='формат тайлов: png - без потерь; png8 - 256 цветов; '
                   'jpg - без прозрачности; webp - самый компактный')
    g.add_argument('--quality', type=int, default=85, help='качество jpg/webp (webp 100 - без потерь)')
    g.add_argument('--background', default='auto',
                   help='фон тайлов: white - тайлы непрозрачные, вне растра и на пустых участках белое | black | #RRGGBB | '
                        'R,G,B | none - прозрачный фон (png/png8/webp; jpg - всегда на белом); auto - white, '
                        'при --paper transparent - none')
    g.add_argument('--resampling', default='cubic', choices=['nearest', 'bilinear', 'cubic', 'cubic_spline', 'lanczos', 'average'],
                   help='интерполяция на макс. уровне (уровни ниже - усреднением 2×2)')
    g.add_argument('--tile-size', type=int, default=256, choices=[256, 512])
    g.add_argument('--paper', default='auto', choices=['auto', 'clean', 'original', 'transparent'],
                   help='бумага скана: clean - чисто белая (тени, пятна, серый тон скана убираются, линии без изменений); '
                        'original - как в растре; transparent - прозрачная (видны только линии, по умолчанию с --background none); '
                        'auto - clean для чертежей на светлой бумаге, иначе original (ортофото и т.п.)')
    g.add_argument('--white-transparent', action='store_true', help='то же, что --paper transparent --background none')
    g.add_argument('--white-threshold', type=int, default=235,
                   help='порог бумаги для --paper clean/transparent: светлее (по мин. из R,G,B, бумага = 255) - бумага')
    g = ap.add_argument_group('привязка')
    g.add_argument('--src-crs', default='auto',
                   help='СК для растров без СК (нет в GeoTIFF/.prj/.aux.xml): auto - по координатам, если однозначно в регионе '
                        '(GEOREF_REGION_BBOX, по умолчанию Беларусь), иначе ошибка; или EPSG:XXXX / PROJ-строка / WKT')
    g.add_argument('--force-crs', default=None, help='принудительно назначить СК всем растрам (напр. EPSG:32635)')
    g.add_argument('--src-nodata', type=float, default=None, help='значение «нет данных» (прозрачно), напр. 0 или 255')
    g.add_argument('--shift', default=None, metavar='DX,DY', help='[v20.3] сдвинуть результат на DX,DY м EPSG:3857 (восток, север)')
    ap.add_argument('--only', action='append', default=None, metavar='ПОДПИСЬ',
                    help='[v20.3] только растр(ы) с такой подписью (как в журнале: папка/файл) - можно несколько раз')
    ap.add_argument('--result-json', default=None, metavar='FILE', help='[v20.3] итог (список MBTiles) в JSON-файл')
    ap.add_argument('--threads', type=int, default=min(8, os.cpu_count() or 2), help='потоков кодирования тайлов')
    return ap.parse_args(argv)


def main(argv=None, log=None):
    args = parse_args(argv)
    log = Log(log)
    if args.white_transparent:
        args.paper = 'transparent'
    if (args.background or 'auto').strip().lower() == 'auto':
        args.background = 'none' if args.paper == 'transparent' else 'white'
    try:
        parse_color(args.background)
    except ValueError:
        raise SystemExit(f'--background: не понят цвет "{args.background}" (white|black|#RRGGBB|R,G,B|none)')
    if args.merge and not args.merge.lower().endswith('.mbtiles'):
        args.merge += '.mbtiles'
    try:
        args.shift = tuple(float(t) for t in re.split(r'[,;\s]+', args.shift.strip()) if t) if args.shift else (0.0, 0.0)
        if len(args.shift) != 2 or not all(math.isfinite(v) and abs(v) < 1e6 for v in args.shift):
            raise ValueError
    except ValueError:
        raise SystemExit('--shift: ожидается «DX,DY» в метрах EPSG:3857, напр. 2.5,-1.2')
    results, used = [], set()
    tmp = tempfile.mkdtemp(prefix='tif2mbtiles_')
    try:
        items = collect_inputs(args.inputs, tmp, log)
        if not items:
            raise SystemExit('нет растров на входе (tif/tiff/jpg/png/... или архив с ними)')
        if args.only:
            want = {o.replace('\\', '/') for o in args.only}
            items = [it for it in items if it[1] in want]
            if not items:
                raise SystemExit('--only: нет растров с такими подписями')

        def open_src(it):
            p, label, outdir = it
            try:
                s = Source(p, label, outdir, args, tmp, log)
            except LookupError as e:
                log.warn(f'{label}: {e}')
                return None
            except Exception as e:
                log.warn(f'{label}: не прочитан ({str(e).replace(tmp + os.sep, "")})')
                return None
            log(f'{label}: {s.w}×{s.h} px, {s.mode}; привязка: {s.how}; СК: {crs_label(s.crs)} ({s.how_crs})'
                + ('' if s.same else ' -> перепроецирование в EPSG:3857')
                + f'; {s.res:.4f} м/px (Web Mercator) ≈ z{s.native_z:.2f} -> z{s.zmin}-{s.zmax}')
            return s

        def out_path(d, stem):
            os.makedirs(d, exist_ok=True)
            stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', stem).strip() or 'tiles'
            p, k = os.path.join(d, stem + '.mbtiles'), 2
            while os.path.normcase(os.path.abspath(p)) in used:
                p, k = os.path.join(d, f'{stem}_{k}.mbtiles'), k + 1
            used.add(os.path.normcase(os.path.abspath(p)))
            return p

        def run(out, srcs):
            try:
                r = build_mbtiles(out, srcs, args, log, name=args.name)
            except Exception as e:
                log.warn(f'{os.path.basename(out)}: не создан ({e})')
                return
            results.append(r)
            zs = ', '.join(f'z{z}:{n}' for z, n in r['tiles_per_zoom'].items())
            log(f'-> {out}: {r["format"]}, фон {r["background"]}, z{r["minzoom"]}-{r["maxzoom"]}, тайлов {r["tiles"]} ({zs}), '
                f'{r["size_mb"]:.1f} МБ, {r["seconds"]:.0f} с')

        if args.merge:
            srcs = [s for s in map(open_src, items) if s]
            try:
                if srcs:
                    mdir, mname = os.path.split(args.merge)       # путь в --merge главнее -o
                    run(out_path(mdir or args.out or srcs[0].outdir, os.path.splitext(mname)[0]), srcs)
            finally:
                for s in srcs:
                    s.close()
        else:
            for it in items:
                s = open_src(it)
                if s:
                    try:
                        run(out_path(args.out or s.outdir, os.path.splitext(os.path.basename(s.path))[0]), [s])
                    finally:
                        s.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not results:
        log.warn('MBTiles не созданы')
    if args.result_json:
        import json
        with open(args.result_json, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False)
    return results


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')        # консоль/файл не в UTF-8 (Windows) - без падений на «×», «≈»
    main()
