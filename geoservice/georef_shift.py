# -*- coding: utf-8 -*-
"""[v20.3] Ручной сдвиг результатов «План → GeoTIFF/TFW → MBTiles» и «Растр → MBTiles» (POST /api/georef/jobs/{id}/shift).
[v20.7] + «MBTiles → TIFF»: привязка GeoTIFF/TFW/TFWX сдвигается на месте (EPSG:3857 — точно; перепроецированный —
сдвигом в его СК, если неточность на углах ≤ 0,2 пикс, иначе GeoTIFF собирается заново из MBTiles со сдвигом),
и из исходного MBTiles собирается «<имя>_сдвиг.mbtiles» — всё изображение сдвинуто на всех уровнях (mbtiles_shift.py).

Лист плана: привязка сдвигается «на месте», пиксели не пересчитываются — теги GeoTIFF ModelTiepoint (33922) и
ModelTransformation (34264) во всех IFD .tif и .tif.ovr (TIFF и BigTIFF), строки C/F в .tfw/.tfwx, GeoTransform и GCP
в .tif.aux.xml; затем MBTiles листа (или общий MBTiles нескольких листов) нарезается заново тем же tif2mbtiles.py
с теми же параметрами и уровнями zoom. «Растр → MBTiles»: исходники не меняются — MBTiles нарезается заново
из исходных файлов задания со сдвигом (tif2mbtiles.py --shift). Сдвиг накапливается: result.json → shift_3857
(м Web Mercator, восток/север) и shift_m (≈ м на местности).
"""
import json
import math
import os
import re
import shutil
import struct
import subprocess
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

R = 6378137.0
GEO_TAGS = (33922, 34264)            # ModelTiepointTag, ModelTransformationTag
MAX_STEP = 20000.0                   # м EPSG:3857 за один запрос
MAX_TOTAL = 50000.0
MB2TIF_TOL_PX = 0.2                  # [v20.7] допуск сдвига привязки «на месте» для перепроецированного GeoTIFF
KINDS = ('georef', 'mbtiles', 'mb2tif')


class ShiftError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def merc(lat, lon):
    lat = max(-85.05113, min(85.05113, float(lat)))
    return math.radians(float(lon)) * R, R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def unmerc(x, y):
    return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), math.degrees(x / R)


def move_latlon(pt, dx, dy):
    x, y = merc(pt[0], pt[1])
    lat, lon = unmerc(x + dx, y + dy)
    return [lat, lon] + list(pt[2:])


# ── GeoTIFF: теги привязки во всех IFD ──
def shift_tiff_tags(path, dx, dy):
    """сдвиг ModelTiepoint / ModelTransformation во всех IFD; -> число изменённых тегов"""
    n = 0
    with open(path, 'r+b') as f:
        size = os.fstat(f.fileno()).st_size
        hdr = f.read(16)
        if hdr[:2] not in (b'II', b'MM'):
            raise ValueError(f'{Path(path).name}: не TIFF')
        e = '<' if hdr[:2] == b'II' else '>'
        magic = struct.unpack(e + 'H', hdr[2:4])[0]
        if magic not in (42, 43):
            raise ValueError(f'{Path(path).name}: не TIFF')
        big = magic == 43
        off = struct.unpack(e + 'Q', hdr[8:16])[0] if big else struct.unpack(e + 'I', hdr[4:8])[0]
        cfmt, esz, ofmt, osz = ('Q', 20, 'Q', 8) if big else ('H', 12, 'I', 4)
        seen, edits = set(), []
        while off and off not in seen and off + 8 < size and len(seen) < 100000:
            seen.add(off)
            f.seek(off)
            cnt = struct.unpack(e + cfmt, f.read(8 if big else 2))[0]
            if cnt > 100000:
                raise ValueError(f'{Path(path).name}: повреждён каталог TIFF')
            base = off + (8 if big else 2)
            ents = f.read(cnt * esz)
            nxt = f.read(osz)
            for i in range(cnt):
                b = ents[i * esz:(i + 1) * esz]
                if len(b) < esz:
                    break
                tag, typ = struct.unpack(e + 'HH', b[:4])
                if tag not in GEO_TAGS or typ != 12:            # 12 = DOUBLE
                    continue
                count = struct.unpack(e + ofmt, b[4:4 + osz])[0]
                nbytes = count * 8
                voff = base + i * esz + 4 + osz if nbytes <= osz else struct.unpack(e + ofmt, b[4 + osz:4 + 2 * osz])[0]
                if voff + nbytes > size or count > 6 * 100000:
                    raise ValueError(f'{Path(path).name}: повреждён тег {tag}')
                f.seek(voff)
                vals = list(struct.unpack(e + 'd' * count, f.read(nbytes)))
                if tag == 33922:
                    for k in range(0, count - count % 6, 6):
                        vals[k + 3] += dx
                        vals[k + 4] += dy
                elif count >= 8:
                    vals[3] += dx
                    vals[7] += dy
                else:
                    continue
                edits.append((voff, struct.pack(e + 'd' * count, *vals)))
            off = struct.unpack(e + ofmt, nxt)[0] if len(nxt) == osz else 0
        for voff, data in edits:                     # запись — после разбора всех IFD
            f.seek(voff)
            f.write(data)
            n += 1
    return n


def shift_world_file(path, dx, dy):
    """строки 5-6 (C, F) world-файла; остальные — как были"""
    raw = Path(path).read_bytes().decode('utf-8', 'replace')
    lines = raw.splitlines()
    idx = [i for i, ln in enumerate(lines) if ln.strip()]
    if len(idx) < 6:
        return False
    try:
        c, f = (float(lines[idx[k]].strip().replace(',', '.')) for k in (4, 5))
    except ValueError:
        return False
    lines[idx[4]], lines[idx[5]] = f'{c + dx:.10f}', f'{f + dy:.10f}'
    Path(path).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return True


def shift_aux_xml(path, dx, dy):
    """GeoTransform (c, a, b, f, d, e) и GCP X/Y в .aux.xml (PAM GDAL)"""
    s = Path(path).read_bytes().decode('utf-8', 'replace')

    def gt(m):
        try:
            v = [float(t) for t in m.group(2).split(',')]
        except ValueError:
            return m.group(0)
        if len(v) != 6:
            return m.group(0)
        v[0] += dx
        v[3] += dy
        return m.group(1) + ', '.join(f'{x:.16g}' for x in v) + m.group(3)

    def gcp(m):
        return f'{m.group(1)}{float(m.group(2)) + dx:.16g}{m.group(3)}{float(m.group(4)) + dy:.16g}{m.group(5)}'

    s2 = re.sub(r'(<GeoTransform>\s*)([^<]+?)(\s*</GeoTransform>)', gt, s)
    s2 = re.sub(r'(<GCP\b[^>]*?\bX=")([-+0-9.eE]+)("[^>]*?\bY=")([-+0-9.eE]+)(")', gcp, s2)
    if s2 == s:
        return False
    Path(path).write_text(s2, encoding='utf-8')
    return True


def shift_sheet_files(out: Path, name: str, dx, dy):
    """файлы листа «на месте»; при ошибке — откат уже сдвинутых. -> [изменённые файлы]"""
    tif = out / f'{name}.tif'
    if not tif.is_file():
        raise ShiftError(410, f'GeoTIFF листа «{name}» не найден на сервере')
    done = []
    try:
        for ext in ('.tfw', '.tfwx', '.tifw', '.wld'):
            p = out / f'{name}{ext}'
            if p.is_file() and shift_world_file(p, dx, dy):
                done.append(p)
        aux = out / f'{name}.tif.aux.xml'
        if aux.is_file() and shift_aux_xml(aux, dx, dy):
            done.append(aux)
        ovr = out / f'{name}.tif.ovr'
        if ovr.is_file() and shift_tiff_tags(ovr, dx, dy):
            done.append(ovr)
        if shift_tiff_tags(tif, dx, dy):
            done.append(tif)
        elif not any(p.suffix.lower() in ('.tfw', '.tfwx') for p in done):
            raise ShiftError(422, f'{tif.name}: нет тегов привязки GeoTIFF и world-файла — сдвигать нечего')
    except Exception:
        for p in done:                                     # откат
            try:
                if p.suffix.lower() in ('.tif', '.ovr'):
                    shift_tiff_tags(p, -dx, -dy)
                elif p.name.lower().endswith('.aux.xml'):
                    shift_aux_xml(p, -dx, -dy)
                else:
                    shift_world_file(p, -dx, -dy)
            except Exception:
                pass
        raise
    return [p.name for p in done]


# ── MBTiles: нарезка заново ──
def _decode(b):
    for enc in ('utf-8', 'cp1251', 'cp866'):
        try:
            return (b or b'').decode(enc)
        except UnicodeDecodeError:
            pass
    return (b or b'').decode('latin-1')


def run_tif2mbtiles(python, tools, inputs, opts, tmp: Path, popen_kwargs, timeout):
    rj = tmp / 'result.json'
    av = [python, str(Path(tools) / 'tif2mbtiles.py'), *map(str, inputs), '-o', str(tmp / 'out'), *opts, '--result-json', str(rj)]
    try:
        proc = subprocess.run(av, timeout=timeout, **popen_kwargs)
    except subprocess.TimeoutExpired:
        raise ShiftError(504, f'MBTiles не пересозданы за {timeout:.0f} с — повторите или уменьшите уровни zoom')
    text = _decode(proc.stdout)
    res = json.loads(rj.read_text(encoding='utf-8')) if rj.is_file() else []
    if proc.returncode != 0 or not res:
        warn = [ln.split('ВНИМАНИЕ:', 1)[1].strip() for ln in text.splitlines() if 'ВНИМАНИЕ:' in ln][-3:]
        raise ShiftError(500, 'MBTiles не пересозданы: ' + ('; '.join(warn) or text.strip()[-300:] or f'код {proc.returncode}'))
    return res


def _zoom_opts(m):
    if m.get('minzoom') is None or m.get('maxzoom') is None:
        return []
    return ['--minzoom', str(int(m['minzoom'])), '--maxzoom', str(int(m['maxzoom']))]


def georef_opts(p, m):
    mb = p.get('mbtiles') or {}
    paper = mb.get('paper') or 'auto'
    bg = mb.get('background') or 'auto'
    if bg.strip().lower() == 'auto':
        bg = 'none' if paper == 'transparent' else 'white'
    return ['--format', mb.get('format') or 'png', '--paper', paper, '--background', bg] + _zoom_opts(m)


def mbtiles_opts(p, m):
    """как в georef_runner.mbtiles_job"""
    mb = p.get('mbtiles') or {}
    av = ['--format', mb.get('format') or 'png', '--paper', mb.get('paper') or 'auto', '--background', mb.get('background') or 'auto',
          '--resampling', mb.get('resampling') or 'cubic', '--tile-size', str(int(mb.get('tile_size') or 256))]
    for k, opt in (('quality', '--quality'), ('white_threshold', '--white-threshold')):
        if mb.get(k) not in (None, ''):
            av += [opt, str(int(mb[k]))]
    if mb.get('src_nodata') not in (None, ''):
        av += ['--src-nodata', f"{float(mb['src_nodata']):g}"]
    for k, opt in (('src_crs', '--src-crs'), ('force_crs', '--force-crs'), ('name', '--name')):
        if mb.get(k):
            av += [opt, str(mb[k])[:4000]]
    return av + _zoom_opts(m)


def replace_file(src: Path, dst: Path, release=None, tries=24):
    for k in range(tries):
        try:
            if release:
                release(dst)
            os.replace(src, dst)
            return
        except PermissionError:                 # Windows: файл открыт (скачивание / чтение тайла)
            time.sleep(0.25)
    raise ShiftError(409, f'{dst.name} занят (скачивается?) — повторите через минуту')


def _fmt(v):
    return f'{v:+.2f}'.replace('.', ',')


def apply_shift(jd: Path, j: dict, target: str, dx: float, dy: float, reset: bool, *, python, tools, popen_kwargs,
                release=None, timeout=900.0, threads=None):
    """-> (обновлённый result, сводка). j — запись задания (меняется на месте)."""
    res = j.get('result') or {}
    kind = res.get('kind') or j.get('kind')
    out = jd / 'out'
    p = json.loads((jd / 'params.json').read_text(encoding='utf-8')) if (jd / 'params.json').is_file() else (j.get('params') or {})
    t0 = time.time()
    opts_threads = ['--threads', str(int(threads or os.environ.get('GEOREF_THREADS', '8')))]
    mbl = res.get('mbtiles') or []
    if kind == 'georef':
        sh = next((s for s in res.get('sheets') or [] if s.get('name') == target and s.get('registered')), None)
        if sh is None:
            raise ShiftError(404, f'Лист «{target}» не найден среди привязанных')
        tot0 = list(sh.get('shift_3857') or [0.0, 0.0])
    elif kind == 'mbtiles':
        sh = next((m for m in mbl if m.get('file') == target), None)
        if sh is None:
            raise ShiftError(404, f'MBTiles «{target}» не найден в результате')
        tot0 = list(sh.get('shift_3857') or [0.0, 0.0])
    elif kind == 'mb2tif':                                 # [v20.7]
        sh = next((o for o in res.get('outputs') or [] if o.get('file') == target), None)
        if sh is None:
            raise ShiftError(404, f'GeoTIFF «{target}» не найден в результате')
        tot0 = list(sh.get('shift_3857') or [0.0, 0.0])
    else:
        raise ShiftError(422, 'Сдвиг доступен для «План → GeoTIFF», «Растр → MBTiles» и «MBTiles → TIFF»')
    if reset:
        dx, dy = -tot0[0], -tot0[1]
    if not all(math.isfinite(v) for v in (dx, dy)) or abs(dx) > MAX_STEP or abs(dy) > MAX_STEP:
        raise ShiftError(422, f'Сдвиг за раз — не больше {MAX_STEP / 1000:.0f} км')
    tot = [tot0[0] + dx, tot0[1] + dy]
    if abs(tot[0]) < 1e-6 and abs(tot[1]) < 1e-6:
        tot = [0.0, 0.0]
    if max(abs(tot[0]), abs(tot[1])) > MAX_TOTAL:
        raise ShiftError(422, f'Суммарный сдвиг — не больше {MAX_TOTAL / 1000:.0f} км')
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return res, {'changed': [], 'mbtiles': [], 'seconds': 0.0}
    tmp = jd / f'.shift_{uuid.uuid4().hex[:8]}'
    tmp.mkdir()
    changed, rebuilt, extra = [], [], {}
    try:
        if kind == 'mb2tif':                                # [v20.7]
            changed, rebuilt, extra = _shift_mb2tif(jd, out, res, p, sh, dx, dy, tot, tot0, reset, python=python, tools=tools,
                                                    popen_kwargs=popen_kwargs, release=release, timeout=timeout,
                                                    threads=opts_threads[1], tmp=tmp)
            jobs = []
        elif kind == 'georef':
            changed = shift_sheet_files(out, target, dx, dy)
            mfile = sh.get('mbtiles')
            jobs = []
            if mfile and (out / mfile).is_file():
                m = next((x for x in mbl if x.get('file') == mfile), {})
                srcs = [os.path.basename(str(s)) for s in (m.get('sources') or [target + '.tif'])]
                inputs = [out / s for s in srcs if (out / s).is_file()] or [out / (target + '.tif')]
                opts = georef_opts(p, m) + opts_threads + (['--merge', mfile] if len(inputs) > 1 else [])
                jobs.append((mfile, m, inputs, opts))
        else:
            sin = jd / 'in'
            if not sin.is_dir() or not any(sin.iterdir()):
                raise ShiftError(410, 'Исходные растры задания уже удалены — загрузите их заново')
            m = sh
            srcs = [str(s) for s in m.get('sources') or []]
            merged = len(srcs) > 1 or bool((p.get('mbtiles') or {}).get('merge'))
            opts = mbtiles_opts(p, m) + opts_threads + ['--shift', f'{tot[0]:.4f},{tot[1]:.4f}']
            opts += ['--merge', m['file']] if merged else [x for s in srcs for x in ('--only', s)]
            jobs = [(m['file'], m, [sin], opts)]
        for mfile, m, inputs, opts in jobs:
            work = tmp / re.sub(r'\W+', '_', mfile)[:40]
            work.mkdir()
            r = run_tif2mbtiles(python, tools, inputs, opts, work, popen_kwargs, timeout)
            r0 = r[0]
            replace_file(Path(r0['path']), out / mfile, release)
            upd = {k: v for k, v in r0.items() if k not in ('path', 'file', 'sources')}
            upd.pop('shift_3857', None)
            m.update(upd)
            m['v'] = int(time.time() * 1000) % 10 ** 10
            rebuilt.append(mfile)
    except ShiftError:
        if kind == 'georef' and changed:
            _undo_sheet(out, target, changed, dx, dy)
        raise
    except Exception as e:
        if kind == 'georef' and changed:
            _undo_sheet(out, target, changed, dx, dy)
        raise ShiftError(500, f'Сдвиг не сохранён: {e}')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # итог: контур, центр, world_file, накопленный сдвиг
    if kind == 'georef':
        if sh.get('corners_latlon'):
            sh['corners_latlon'] = [move_latlon(c, dx, dy) for c in sh['corners_latlon']]
        if sh.get('center_latlon'):
            sh['center_latlon'] = move_latlon(sh['center_latlon'], dx, dy)
        wf = sh.get('world_file')
        if isinstance(wf, list) and len(wf) == 6:
            sh['world_file'] = wf[:4] + [wf[4] + dx, wf[5] + dy]
        lat = (sh.get('center_latlon') or [54.0])[0]
        res['qa_outdated'] = True
    else:
        b = sh.get('bounds_lonlat') or [0, 54, 0, 54]
        lat = (b[1] + b[3]) / 2
    k = math.cos(math.radians(lat))
    if tot == [0.0, 0.0]:
        for key in ('shift_3857', 'shift_m', 'shifted_at'):
            sh.pop(key, None)
    else:
        sh['shift_3857'] = [round(tot[0], 4), round(tot[1], 4)]
        sh['shift_m'] = [round(tot[0] * k, 3), round(tot[1] * k, 3)]
        sh['shifted_at'] = time.time()
    if kind == 'mb2tif':
        sh['v'] = int(time.time() * 1000) % 10 ** 10
        res['files'] = sorted(x.name for x in out.iterdir() if x.is_file() and not x.name.startswith('.'))
    reg = j.get('registered') or {}
    unreg = [f for f in rebuilt if f in reg]
    for f in unreg:
        reg.pop(f, None)
    _atomic_write(out / 'result.json', res)
    try:                                                   # отчёт — для истории
        with open(out / 'report.txt', 'a', encoding='utf-8') as fh:
            fh.write(f'\n[{time.strftime("%Y-%m-%d %H:%M:%S")}] ручной сдвиг «{target}»: восток {_fmt(dx * k)} м, север {_fmt(dy * k)} м '
                     f'(итого {_fmt(tot[0] * k)} / {_fmt(tot[1] * k)} м; EPSG:3857 {tot[0]:+.3f}, {tot[1]:+.3f}); '
                     f'файлы: {", ".join(changed + rebuilt) or "—"}\n')
    except OSError:
        pass
    return res, {'changed': changed, 'mbtiles': rebuilt, 'unregistered': unreg, 'seconds': round(time.time() - t0, 1),
                 'shift_3857': [dx, dy], 'total_3857': tot, **extra}


# ── [v20.7] «MBTiles → TIFF» ──
def _tool_json(python, script, args, rj: Path, popen_kwargs, timeout, what):
    av = [python, str(script), *map(str, args), '--result-json', str(rj)]
    try:
        proc = subprocess.run(av, timeout=timeout, **popen_kwargs)
    except subprocess.TimeoutExpired:
        raise ShiftError(504, f'{what}: не успели за {timeout:.0f} с — повторите позже')
    text = _decode(proc.stdout)
    data = None
    if rj.is_file():
        try:
            data = json.loads(rj.read_text(encoding='utf-8'))
        except ValueError:
            data = None
    if proc.returncode != 0 or data is None:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        warn = [ln.split('ВНИМАНИЕ:', 1)[1].strip() for ln in lines if 'ВНИМАНИЕ:' in ln][-3:]
        tb = [ln for ln in lines if not ln.startswith(('Traceback', 'File ', '^'))]
        raise ShiftError(500, f'{what}: ' + ('; '.join(warn) or (tb[-1][-300:] if tb else f'код {proc.returncode}')))
    return data


def _zip_name(info):
    raw = info.filename
    try:
        if not (info.flag_bits & 0x800):
            raw = raw.encode('cp437').decode('cp866')
    except Exception:
        pass
    return os.path.basename(raw.replace('\\', '/'))


def mb2tif_source(jd: Path, o: dict, tmp: Path) -> Path:
    """исходный MBTiles результата: in/<имя> или (как в georef_runner.extract_zip) из ZIP задания"""
    name = os.path.basename(str(o.get('source') or ''))
    sin = jd / 'in'
    if not name:
        raise ShiftError(410, 'В результате нет имени исходного MBTiles')
    if (sin / name).is_file():
        return sin / name
    for d in (jd / 'work', sin):
        if d.is_dir():
            for q in d.rglob('*.mbtiles'):
                if q.name.lower() == name.lower() and q.is_file():
                    return q
    used = set()
    for z in sorted(sin.glob('*.zip'), key=lambda x: x.name.lower()) if sin.is_dir() else []:
        try:
            with zipfile.ZipFile(z) as zf:
                for info in zf.infolist():
                    if info.is_dir() or info.file_size > 2 * 1024 ** 3:
                        continue
                    base = _zip_name(info)
                    if not base or base.startswith('.') or not base.lower().endswith('.mbtiles'):
                        continue
                    nm = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', '_', base)
                    stem_, suf = os.path.splitext(nm)
                    k = 2
                    while nm.lower() in used:                # как extract_zip: «имя_2.mbtiles»
                        nm, k = f'{stem_}_{k}{suf}', k + 1
                    used.add(nm.lower())
                    if nm.lower() == name.lower():
                        dst = tmp / 'src' / nm
                        dst.parent.mkdir(exist_ok=True)
                        with zf.open(info) as f, open(dst, 'wb') as g:
                            shutil.copyfileobj(f, g, 1024 * 1024)
                        return dst
        except zipfile.BadZipFile:
            continue
    raise ShiftError(410, f'Исходный MBTiles «{name}» уже удалён с сервера — загрузите его заново')


def mb2tif_opts(p, res, o):
    t = dict(res.get('params') or {})
    t.update({k: v for k, v in (p.get('mb2tif') or {}).items() if v not in (None, '')})
    av = ['--zoom', str(o.get('zoom') if o.get('zoom') is not None else (t.get('zoom') or 'max')),
          '--crs', str(t.get('crs') or 'EPSG:3857')[:8000], '--compress', str(t.get('compress') or 'deflate'),
          '--background', str(t.get('background') or 'none'), '--clip', str(t.get('clip') or 'auto'),
          '--resampling', str(t.get('resampling') or 'cubic'), '--max-mp', os.environ.get('GEOREF_MB2TIF_MAX_MP', '400')]
    if t.get('overviews') is False:
        av.append('--no-overviews')
    return av


def _swap_in(pairs, bak: Path, release=None):
    """[(новый, итоговый)] → на место; при сбое — откат уже заменённых"""
    bak.mkdir(exist_ok=True)
    done = []
    try:
        for new, dst in pairs:
            b = None
            if dst.exists():
                b = bak / dst.name
                replace_file(dst, b, (lambda _p, d=dst: release(d)) if release else None)
            done.append((dst, b))
            replace_file(new, dst, release)
    except Exception:
        for dst, b in reversed(done):
            try:
                if b is not None and b.exists():
                    os.replace(b, dst)
                elif b is None and dst.exists():
                    dst.unlink()
            except OSError:
                pass
        raise


def _move_bounds(o, dx, dy):
    for key in ('bounds_3857', 'preview_bounds_3857'):
        b = o.get(key)
        if isinstance(b, list) and len(b) == 4:
            o[key] = [round(b[0] + dx, 3), round(b[1] + dy, 3), round(b[2] + dx, 3), round(b[3] + dy, 3)]
    b = o.get('bounds_lonlat')
    if isinstance(b, list) and len(b) == 4:
        la0, lo0 = move_latlon([b[1], b[0]], dx, dy)[:2]
        la1, lo1 = move_latlon([b[3], b[2]], dx, dy)[:2]
        o['bounds_lonlat'] = [round(lo0, 7), round(la0, 7), round(lo1, 7), round(la1, 7)]


def _shift_mb2tif(jd: Path, out: Path, res, p, o, dx, dy, tot, tot0, reset, *, python, tools, popen_kwargs, release,
                  timeout, threads, tmp: Path):
    """-> (изменённые файлы, пересобранные файлы, доп. сведения)"""
    script = Path(tools) / 'mbtiles_shift.py'
    if not script.is_file():
        raise ShiftError(501, 'На сервере нет tools/georef/mbtiles_shift.py (v20.7) — скопируйте папку tools/georef '
                              'из пакета и перезапустите приложение')
    stem = o.get('name') or Path(o['file']).stem
    if not (out / o['file']).is_file():
        raise ShiftError(410, f'GeoTIFF «{o["file"]}» не найден на сервере')
    zero = tot == [0.0, 0.0]
    rp = bool(o.get('reprojected'))
    mode, dX, dY, err = 'inplace', dx, dy, 0.0
    if rp:
        if reset and o.get('rebuilt_shift'):
            mode = 'rebuild'
        elif reset:
            sc = o.get('shift_crs') or [0.0, 0.0]
            dX, dY = -float(sc[0]), -float(sc[1])
        else:
            d = _tool_json(python, script, ['delta', out / o['file'], '--shift', f'{dx:.6f},{dy:.6f}'], tmp / 'delta.json',
                           popen_kwargs, min(timeout, 120), 'Сдвиг привязки GeoTIFF')
            err = float(d.get('err_px') or 0.0)
            if err > MB2TIF_TOL_PX:
                mode = 'rebuild'
            else:
                dX, dY = (float(v) for v in d['delta'])
    warns, changed, rebuilt, removed = [], [], [], []
    src_box = {}

    def source():
        if 'p' not in src_box:
            src_box['p'] = mb2tif_source(jd, o, tmp)
        return src_box['p']

    def build_tif():
        work = tmp / 'tif'
        work.mkdir(exist_ok=True)
        av = [source(), '-o', work, *mb2tif_opts(p, res, o), '--threads', threads, '--name', stem]
        if not zero:
            av += ['--shift', f'{tot[0]:.4f},{tot[1]:.4f}']
        r = _tool_json(python, Path(tools) / 'mbtiles2tif.py', av, tmp / 'tif.json', popen_kwargs, timeout, 'GeoTIFF не собран')
        return r[0] if isinstance(r, list) else r

    def build_mb():
        work = tmp / 'mb'
        work.mkdir(exist_ok=True)
        name = f'{stem}_сдвиг.mbtiles'
        return _tool_json(python, script, ['tiles', source(), '-o', work / name, '--shift', f'{tot[0]:.4f},{tot[1]:.4f}',
                                           '--threads', threads], tmp / 'mb.json', popen_kwargs, timeout, 'MBTiles со сдвигом')
    if mode == 'rebuild':
        source()                                         # 410 — до любых изменений
    skip_mb = zero
    if not zero:
        try:
            source()
        except ShiftError as e:                          # GeoTIFF сдвинем, MBTiles со сдвигом — не из чего
            warns.append(f'{e} — MBTiles со сдвигом не собран')
            skip_mb = True
    with ThreadPoolExecutor(2) as ex:
        ft = ex.submit(build_tif) if mode == 'rebuild' else None
        fm = ex.submit(build_mb) if not skip_mb else None
        info_t = ft.result() if ft else None             # ошибка GeoTIFF — весь сдвиг не сохранён
        try:
            info_m = fm.result() if fm else None
        except ShiftError as e:
            info_m = None
            warns.append(str(e))
    try:
        if mode == 'rebuild':
            pairs = [(tmp / 'tif' / n, out / n) for n in info_t.get('files') or [] if (tmp / 'tif' / n).is_file()]
            _swap_in(pairs, tmp / 'bak', release)
            for n in (o.get('files') or []):                # устаревшие файлы прежней сборки (например .ovr)
                if n not in (info_t.get('files') or []) and (out / n).is_file():
                    try:
                        (out / n).unlink()
                    except OSError:
                        pass
            keep = {k: o.get(k) for k in ('source', 'shift_3857', 'shift_m', 'shifted_at', 'mbtiles_shifted')}
            o.clear()
            o.update({k: v for k, v in info_t.items() if k not in ('path', 'shift_applied_3857')})
            o.update({k: v for k, v in keep.items() if v is not None})
            o['rebuilt_shift'] = not zero
            o['shift_crs'] = [0.0, 0.0]
            rebuilt += [d.name for _, d in pairs]
        else:
            changed = shift_sheet_files(out, stem, dX, dY)
            sc = o.get('shift_crs') or [0.0, 0.0]
            o['shift_crs'] = [0.0, 0.0] if reset else [float(sc[0]) + dX, float(sc[1]) + dY]
            wf = o.get('world_file')
            if isinstance(wf, list) and len(wf) == 6:
                o['world_file'] = wf[:4] + [wf[4] + dX, wf[5] + dY]
            _move_bounds(o, dx, dy)
            if reset:
                o.pop('rebuilt_shift', None)
        mname = f'{stem}_сдвиг.mbtiles'
        if zero:
            if (out / mname).exists():
                if release:
                    release(out / mname)
                try:
                    (out / mname).unlink()
                    removed.append(mname)
                except OSError:
                    warns.append(f'{mname} занят — удалите позже')
            o.pop('mbtiles_shifted', None)
        elif info_m:
            _swap_in([(Path(info_m['path']), out / mname)], tmp / 'bak', release)
            o['mbtiles_shifted'] = {'file': mname, 'tiles': info_m.get('tiles'), 'size_mb': info_m.get('size_mb'),
                                    'zooms': info_m.get('zooms'), 'format': info_m.get('format'),
                                    'bounds_lonlat': info_m.get('bounds_lonlat'), 'shift_3857': info_m.get('shift_3857'),
                                    'v': int(time.time() * 1000) % 10 ** 10}
            rebuilt.append(mname)
        else:
            o.pop('mbtiles_shifted', None)
            if (out / mname).exists():                    # прежний сдвинутый MBTiles больше не соответствует
                try:
                    if release:
                        release(out / mname)
                    (out / mname).unlink()
                except OSError:
                    pass
    except Exception:
        if changed:
            _undo_sheet(out, stem, changed, dX, dY)
        raise
    return changed, rebuilt, {'mode': mode, 'err_px': round(err, 3), 'warnings': warns, 'removed': removed}


def _undo_sheet(out, name, changed, dx, dy):
    for n in changed:
        p = out / n
        try:
            if n.lower().endswith(('.tif', '.ovr')):
                shift_tiff_tags(p, -dx, -dy)
            elif n.lower().endswith('.aux.xml'):
                shift_aux_xml(p, -dx, -dy)
            else:
                shift_world_file(p, -dx, -dy)
        except Exception:
            pass


def _atomic_write(path: Path, data):
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, path)
