# -*- coding: utf-8 -*-
"""pvlib — общие функции генератора медиа превью-страницы (тайлы, WMS/WFS, растеризация, графика)."""
import hashlib, io, json, math, os, time, urllib.parse, urllib.request
from collections import OrderedDict
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

R = 6378137.0
O = math.pi * R                 # половина ширины мира в EPSG:3857
C0 = 2 * O / 256                # м/пикс на зуме 0 (156543.03…)
UA = "Mozilla/5.0 (X11; Linux x86_64) GeoservicePreview/1.0"


def merc(lat, lon):
    return math.radians(lon) * R, R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def unmerc(x, y):
    return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), math.degrees(x / R)


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0))) if e1 != e0 else float(x >= e1)
    return t * t * (3 - 2 * t)


def hex2rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ───────────────────────── HTTP + дисковый кэш ─────────────────────────
class Cache:
    def __init__(self, root, offline=False):
        self.root = root; self.offline = offline; os.makedirs(root, exist_ok=True)

    def path(self, url, ext):
        h = hashlib.sha1(url.encode()).hexdigest(); return os.path.join(self.root, h[:2], h + ext)

    def get(self, url, ext='.bin', validate=None, timeout=90, tries=4):
        p = self.path(url, ext)
        if os.path.exists(p):
            with open(p, 'rb') as f: return f.read()
        if self.offline: raise RuntimeError('нет в кэше (offline): ' + url)
        err = None
        for k in range(tries):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    data = r.read(); ct = r.headers.get('Content-Type', '')
                if validate and not validate(data, ct):
                    raise RuntimeError('ответ не прошёл проверку (%s, %d байт)' % (ct, len(data)))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p + '.tmp', 'wb') as f: f.write(data)
                os.replace(p + '.tmp', p)
                return data
            except Exception as e:  # noqa: BLE001
                err = e; time.sleep(1.5 * (k + 1))
        raise RuntimeError('не удалось загрузить %s: %s' % (url, err))


def is_image(data, ct):
    return ct.startswith('image/') or data[:4] in (b'\x89PNG', b'\xff\xd8\xff\xe0', b'\xff\xd8\xff\xe1', b'\xff\xd8\xff\xdb', b'RIFF')


# ───────────────────────── источники тайлов ─────────────────────────
def tile_bbox(z, x, y):
    ts = 2 * O / 2 ** z
    return (x * ts - O, O - (y + 1) * ts, (x + 1) * ts - O, O - y * ts)


class TileSource:
    """Базовый класс: tile(z,x,y) → np.uint8 (256,256,C) или None; LRU в памяти + кэш на диске."""
    channels = 3; maxz = 17; ext = '.jpg'

    def __init__(self, cache, lru=900):
        self.cache = cache; self.mem = OrderedDict(); self.lru = lru

    def url(self, z, x, y): raise NotImplementedError

    def decode(self, data): raise NotImplementedError

    def raw(self, z, x, y):
        return self.cache.get(self.url(z, x, y), self.ext, validate=is_image)

    def tile(self, z, x, y):
        k = (z, x, y)
        if k in self.mem:
            self.mem.move_to_end(k); return self.mem[k]
        try:
            arr = self.decode(self.raw(z, x, y))
        except Exception as e:  # noqa: BLE001
            print('  ! тайл', self.__class__.__name__, k, str(e)[:120]); arr = None
        self.mem[k] = arr
        if len(self.mem) > self.lru: self.mem.popitem(last=False)
        return arr

    def prefetch(self, keys, workers=8):
        keys = [k for k in dict.fromkeys(keys) if not os.path.exists(self.cache.path(self.url(*k), self.ext))]
        if not keys: return 0
        def one(k):
            try: self.raw(*k); return 1
            except Exception as e: print('  ! prefetch', k, str(e)[:100]); return 0  # noqa: E701
        with ThreadPoolExecutor(workers) as ex: n = sum(ex.map(one, keys))
        return n


class XYZImagery(TileSource):
    channels = 3; ext = '.jpg'

    def __init__(self, cache, tpl, maxz=17, **kw):
        super().__init__(cache, **kw); self.tpl = tpl; self.maxz = maxz

    def url(self, z, x, y): return self.tpl.format(z=z, x=x, y=y)

    def decode(self, data):
        im = Image.open(io.BytesIO(data)).convert('RGB')
        if im.size != (256, 256): im = im.resize((256, 256), Image.LANCZOS)
        return np.asarray(im, dtype=np.uint8)


class WMSTiles(TileSource):
    """WMS GetMap по сетке тайлов 3857 (чтобы кадры разных масштабов были согласованы). recolor: fn(rgba)->rgba."""
    channels = 4; ext = '.png'

    def __init__(self, cache, base, layer, style='', maxz=17, recolor=None, extra='', **kw):
        super().__init__(cache, **kw); self.base = base; self.layer = layer; self.style = style
        self.maxz = maxz; self.recolor = recolor; self.extra = extra

    def url(self, z, x, y):
        b = tile_bbox(z, x, y)
        q = dict(SERVICE='WMS', VERSION='1.1.1', REQUEST='GetMap', LAYERS=self.layer, STYLES=self.style,
                 SRS='EPSG:3857', BBOX=','.join('%.3f' % v for v in b), WIDTH=256, HEIGHT=256,
                 FORMAT='image/png', TRANSPARENT='true')
        return self.base + ('&' if '?' in self.base else '?') + urllib.parse.urlencode(q) + self.extra

    def decode(self, data):
        a = np.asarray(Image.open(io.BytesIO(data)).convert('RGBA'), dtype=np.uint8)
        if a.shape[:2] != (256, 256): a = np.asarray(Image.fromarray(a).resize((256, 256), Image.LANCZOS))
        return self.recolor(a) if self.recolor else a


def lod_of(mpp):
    return math.log2(C0 / mpp)


def tiles_for(cx, cy, mpp, W, H, L):
    res = C0 / 2 ** L; s = mpp / res
    pcx = (cx + O) / res; pcy = (O - cy) / res
    x0 = pcx - W / 2 * s; y0 = pcy - H / 2 * s
    tx0, tx1 = int(math.floor((x0 - 3) / 256)), int(math.floor((x0 + W * s + 3) / 256))
    ty0, ty1 = int(math.floor((y0 - 3) / 256)), int(math.floor((y0 + H * s + 3) / 256))
    return [(L, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)], (x0, y0, s, tx0, ty0, tx1, ty1)


def render_lod(src, cx, cy, mpp, W, H, L):
    """Собирает мозаику тайлов уровня L и переводит её в кадр W×H (м/пикс = mpp). float32 0…1, RGBA — премультипл."""
    keys, (x0, y0, s, tx0, ty0, tx1, ty1) = tiles_for(cx, cy, mpp, W, H, L)
    C = src.channels
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, C), np.float32)
    for (_, tx, ty) in keys:
        a = src.tile(L, tx, ty)
        if a is None and L > 0:     # нет тайла — берём четверть родительского и увеличиваем
            pa = src.tile(L - 1, tx // 2, ty // 2)
            if pa is not None:
                q = pa[(ty % 2) * 128:(ty % 2) * 128 + 128, (tx % 2) * 128:(tx % 2) * 128 + 128]
                a = cv2.resize(q, (256, 256), interpolation=cv2.INTER_CUBIC)
        if a is None: continue
        a = a.astype(np.float32) / 255.0
        if C == 4: a[..., :3] *= a[..., 3:4]
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = a
    if s > 1.02:
        mos = cv2.GaussianBlur(mos, (0, 0), 0.5 * math.sqrt(s * s - 1))
    a = x0 + 0.5 * s - 0.5 - tx0 * 256; b = y0 + 0.5 * s - 0.5 - ty0 * 256
    M = np.float32([[s, 0, a], [0, s, b]])
    return cv2.warpAffine(mos, M, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def render(src, cx, cy, mpp, W, H, bias=1, xfade=0.3):
    """Рендер с плавной сменой уровней тайлов (без «перескока» резкости и цвета)."""
    z = lod_of(mpp); L = min(src.maxz, int(math.floor(z)) + bias); frac = z - math.floor(z)
    out = render_lod(src, cx, cy, mpp, W, H, L)
    if xfade and frac > 1 - xfade and L + 1 <= src.maxz:
        w = smoothstep(1 - xfade, 1, frac)
        if w > 0.01: out = out * (1 - w) + render_lod(src, cx, cy, mpp, W, H, L + 1) * w
    return out


def needed_tiles(src, views, bias=1, xfade=0.3):
    keys = []
    for (cx, cy, mpp, W, H) in views:
        z = lod_of(mpp); L = min(src.maxz, int(math.floor(z)) + bias); frac = z - math.floor(z)
        keys += tiles_for(cx, cy, mpp, W, H, L)[0]
        if xfade and frac > 1 - xfade and L + 1 <= src.maxz: keys += tiles_for(cx, cy, mpp, W, H, L + 1)[0]
    return keys


# ───────────────────────── легенда пород и перекраска ─────────────────────────
# Своя палитра (тёмная тема сайта): ключ — начало названия правила в легенде WMS-стиля
PALETTE = [
    ('Сосн', 'Сосна', '#F2B35E'), ('Ель', 'Ель', '#3FD7AE'), ('Пихт', 'Пихта', '#33B8C9'),
    ('Лиственниц', 'Лиственница', '#F59E6B'), ('Кедр', 'Кедр', '#E6C27A'), ('Дуб', 'Дуб', '#E5864F'),
    ('Бук', 'Бук', '#D9A066'), ('Граб', 'Граб', '#CFA57E'), ('Ясень', 'Ясень', '#7FA6F8'),
    ('Клен', 'Клён', '#F287A6'), ('Ильм', 'Ильмовые', '#DB9475'), ('Акация', 'Акация, рябина', '#F5B7C8'),
    ('Береза', 'Берёза', '#ECE47E'), ('Осина', 'Осина, тополь', '#A6DA5E'), ('Ольха серая', 'Ольха серая', '#8FCDF4'),
    ('Ольха черная', 'Ольха чёрная', '#AC8CFB'), ('Липа', 'Липа', '#F8D36A'), ('Ива древ', 'Ива', '#F59BC4'),
    ('Груша', 'Груша, яблоня', '#F7A273'), ('Каштан', 'Каштан', '#C48A5C'), ('Боярышник', 'Боярышник', '#D8A9A9'),
    ('Ива куст', 'Ива кустарниковая', '#BCD29E'), ('Лещина', 'Лещина', '#9FC97E'),
    ('Можжевельник', 'Можжевельник, орех', '#B4BCA4'), ('Всё', 'Прочие земли', '#CFC8B6'),
]
OTHER_NAME = 'Прочие земли'


def load_legend(cache, wms_base, layer, style):
    """GetLegendGraphic (JSON) → список групп: name, official(rgb), color(rgb), codes(set)."""
    q = dict(SERVICE='WMS', VERSION='1.1.1', REQUEST='GetLegendGraphic', LAYER=layer, STYLE=style, FORMAT='application/json')
    url = wms_base + ('&' if '?' in wms_base else '?') + urllib.parse.urlencode(q)
    d = json.loads(cache.get(url, '.json', validate=lambda b, ct: b[:1] in (b'{', b'[')).decode('utf-8'))
    groups = []
    for L in d.get('Legend', []):
        for r in L.get('rules', []):
            title = (r.get('title') or r.get('name') or '').strip()
            sym = (r.get('symbolizers') or [{}])[0].get('Polygon', {})
            fill = sym.get('fill') or '#FFFFFF'
            codes = set()
            flt = r.get('filter') or ''
            for tok in flt.replace('[', ' ').replace(']', ' ').replace('(', ' ').replace(')', ' ').replace(',', ' ').split():
                tok = tok.strip("'\"")
                if tok.isdigit(): codes.add(int(tok))
            name, color = title, '#CFC8B6'
            for key, nm, col in PALETTE:
                if title.startswith(key): name, color = nm, col; break
            groups.append(dict(name=name, title=title, official=hex2rgb(fill), color=hex2rgb(color), codes=codes,
                               other=not flt))
    if not any(g['other'] for g in groups):
        groups.append(dict(name=OTHER_NAME, title='', official=(255, 255, 255), color=hex2rgb('#CFC8B6'), codes=set(), other=True))
    return groups


def group_of_code(groups, code):
    for i, g in enumerate(groups):
        if code in g['codes']: return i
    return next(i for i, g in enumerate(groups) if g['other'])


def make_recolor(groups, other_alpha=1.0):
    """LUT 32³: официальный цвет WMS → цвет своей палитры (ближайший по RGB); «прочие земли» — прозрачнее."""
    off = np.array([g['official'] for g in groups], np.float32)
    new = np.array([g['color'] for g in groups], np.uint8)
    amul = np.array([other_alpha if g['other'] else 1.0 for g in groups], np.float32)
    grid = (np.arange(32, dtype=np.float32) * 8 + 4)
    r, g, b = np.meshgrid(grid, grid, grid, indexing='ij')
    pts = np.stack([r, g, b], -1).reshape(-1, 3)
    idx = np.argmin(((pts[:, None, :] - off[None]) ** 2).sum(-1), 1)
    lut = new[idx].reshape(32, 32, 32, 3); alut = amul[idx].reshape(32, 32, 32)

    def recolor(a):
        out = a.copy(); q = (a[..., :3] >> 3).astype(np.intp)
        out[..., :3] = lut[q[..., 0], q[..., 1], q[..., 2]]
        out[..., 3] = (a[..., 3] * alut[q[..., 0], q[..., 1], q[..., 2]] + 0.5).astype(np.uint8)
        return out
    return recolor


# ───────────────────────── WFS → векторы ─────────────────────────
def load_wfs(cache, wfs_base, type_name, bbox, page=1000):
    """Объекты слоя WFS в bbox (EPSG:3857). page=0 — одним запросом: представления (view_*) GeoServer
    без первичного ключа не умеют startIndex («natural order without primary key»)."""
    feats, start = [], 0
    while True:
        q = dict(service='WFS', version='2.0.0', request='GetFeature', typeNames=type_name,
                 bbox='%.2f,%.2f,%.2f,%.2f,EPSG:3857' % bbox, outputFormat='application/json', srsName='EPSG:3857')
        if page: q.update(count=page, startIndex=start)
        url = wfs_base + ('&' if '?' in wfs_base else '?') + urllib.parse.urlencode(q)
        d = json.loads(cache.get(url, '.json', validate=lambda b, ct: b[:1] == b'{', timeout=300).decode('utf-8'))
        fs = d.get('features', []); feats += fs
        if not page or len(fs) < page: break
        start += page
    return feats


def polys_of(geom):
    t = geom.get('type'); c = geom.get('coordinates') or []
    if t == 'Polygon': return [c]
    if t == 'MultiPolygon': return c
    return []


def rasterize(feats, cx, cy, mpp, W, H):
    """ID-карта int32: 0 — пусто, i+1 — индекс объекта. Дыры учитываются (fillPoly, чёт-нечет)."""
    ids = np.zeros((H, W), np.int32)
    x0 = cx - W / 2 * mpp; y1 = cy + H / 2 * mpp; SH = 4; k = 2 ** SH
    for i, f in enumerate(feats):
        for poly in polys_of(f['geometry']):
            rings = []
            for ring in poly:
                a = np.asarray(ring, np.float64)[:, :2]
                px = (a[:, 0] - x0) / mpp; py = (y1 - a[:, 1]) / mpp
                if px.max() < -2 or py.max() < -2 or px.min() > W + 2 or py.min() > H + 2:
                    if not rings: break  # внешний контур вне кадра — пропускаем полигон целиком
                    continue
                rings.append(np.round(np.stack([px, py], 1) * k).astype(np.int32))
            if rings:
                cv2.fillPoly(ids, rings, int(i + 1), lineType=cv2.LINE_8, shift=SH)
    return ids


class Layer:
    """Полигоны слоя (EPSG:3857) для быстрой отрисовки: кольца, их bbox и номер объекта у каждого кольца."""
    def __init__(self, feats):
        self.feats = feats
        rings, owner, polys, ext = [], [], [], []
        for i, f in enumerate(feats):
            for poly in polys_of(f.get('geometry') or {}):
                pr = []
                for j, ring in enumerate(poly):
                    a = np.asarray(ring, np.float64)
                    if a.ndim != 2 or len(a) < 3:
                        if j == 0: break
                        continue
                    pr.append(len(rings)); rings.append(np.ascontiguousarray(a[:, :2])); owner.append(i); ext.append(j == 0)
                if pr: polys.append((i, pr))
        self.rings, self.polys = rings, polys
        self.owner = np.array(owner, np.int32); self.ext = np.array(ext, bool)
        self.bb = np.array([[r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()] for r in rings]) if rings else np.zeros((0, 4))

    def __len__(self):
        return len(self.feats)

    def visible(self, x0, y0, x1, y1):
        b = self.bb
        return np.nonzero((b[:, 2] >= x0) & (b[:, 0] <= x1) & (b[:, 3] >= y0) & (b[:, 1] <= y1))[0]

    def _px(self, i, x0, y1, k, lim):
        r = self.rings[i]
        p = np.empty((len(r), 2), np.float64)
        p[:, 0] = (r[:, 0] - x0) * k; p[:, 1] = (y1 - r[:, 1]) * k
        np.clip(p, -lim, lim, out=p)        # далёкие вершины: короткие отрезки, искажение вне кадра
        return np.round(p).astype(np.int32)

    def lines(self, cx, cy, mpp, W, H, thick, ss=1, sel=None, min_px=0.0, ext_only=False):
        """Маска границ (float32 0…1, H×W): сглаженные полилинии колец, видимых в кадре. sel — номера объектов,
        ext_only — только внешние контуры (без «дыр»: поля и вырубки внутри лесхоза обводят кварталы и выделы)."""
        x0, x1 = cx - W / 2 * mpp, cx + W / 2 * mpp; y0, y1 = cy - H / 2 * mpp, cy + H / 2 * mpp
        SH = 3; k = 2 ** SH * ss / mpp; lim = 2 ** SH * ss * max(W, H) * 5.0
        idx = self.visible(x0 - 4 * mpp, y0 - 4 * mpp, x1 + 4 * mpp, y1 + 4 * mpp)
        if sel is not None: idx = idx[np.isin(self.owner[idx], np.asarray(list(sel), np.int32))]
        if ext_only: idx = idx[self.ext[idx]]
        if min_px > 0 and len(idx):
            b = self.bb[idx]; idx = idx[np.maximum(b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]) / mpp >= min_px]
        m = np.zeros((H * ss, W * ss), np.uint8)
        if len(idx):
            t = max(1, int(round(thick * ss)))
            cv2.polylines(m, [self._px(i, x0, y1, k, lim) for i in idx], True, 255, t, cv2.LINE_AA, SH)
        out = m.astype(np.float32) / 255
        if ss > 1: out = cv2.resize(out, (W, H), interpolation=cv2.INTER_AREA)
        if thick * ss < 1: out *= thick * ss
        return out

    def fill(self, cx, cy, mpp, W, H, ss=1, sel=None):
        """Маска заливки (float32 0…1) объектов sel (или всех), дыры учитываются."""
        x0, x1 = cx - W / 2 * mpp, cx + W / 2 * mpp; y0, y1 = cy - H / 2 * mpp, cy + H / 2 * mpp
        SH = 3; k = 2 ** SH * ss / mpp; lim = 2 ** SH * ss * max(W, H) * 5.0
        vis = set(self.visible(x0, y0, x1, y1).tolist())
        sel = None if sel is None else set(int(s) for s in sel)
        m = np.zeros((H * ss, W * ss), np.uint8)
        for fi, pr in self.polys:
            if sel is not None and fi not in sel: continue
            if pr[0] not in vis: continue
            cv2.fillPoly(m, [self._px(i, x0, y1, k, lim) for i in pr], 255, cv2.LINE_AA, SH)
        out = m.astype(np.float32) / 255
        return cv2.resize(out, (W, H), interpolation=cv2.INTER_AREA) if ss > 1 else out

    def ids(self, cx, cy, mpp, W, H):
        return rasterize(self.feats, cx, cy, mpp, W, H)


def anchors_of(ids, min_px=0.0, region=None):
    """Точки подписей: самая «глубокая» точка каждого объекта id-карты (distance transform).
    region — маска (bool), где можно ставить подписи. → [(id, x, y, глубина_пикс)]"""
    out = []
    H, W = ids.shape
    lab = ids if region is None else np.where(region, ids, 0)
    for qi in np.unique(lab):
        if qi == 0: continue
        m = (lab == qi).astype(np.uint8)
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        d = cv2.distanceTransform(np.pad(m[y0:y1, x0:x1], 1), cv2.DIST_L2, 5)
        k = int(np.argmax(d)); yy, xx = divmod(k, d.shape[1])
        if d.flat[k] < min_px: continue
        out.append((int(qi), x0 + xx - 1 + 0.5, y0 + yy - 1 + 0.5, float(d.flat[k])))
    return out


def edges_of(lab):
    """Маска границ между разными значениями (4-связность), включая границу с пустотой (если хоть одна сторона >0)."""
    e = np.zeros(lab.shape, bool)
    d = lab[:, 1:] != lab[:, :-1]; nz = (lab[:, 1:] > 0) | (lab[:, :-1] > 0); d &= nz
    e[:, 1:] |= d; e[:, :-1] |= d
    d = lab[1:, :] != lab[:-1, :]; nz = (lab[1:, :] > 0) | (lab[:-1, :] > 0); d &= nz
    e[1:, :] |= d; e[:-1, :] |= d
    return e


# ───────────────────────── шрифты и текст ─────────────────────────
FONT_CANDIDATES = [
    '/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    'DejaVuSans.ttf',
    'segoeui.ttf', 'arial.ttf',            # Windows: Pillow ищет такие имена в C:\Windows\Fonts
]
FONT_BOLD = {'segoeui.ttf': 'seguisb.ttf', 'arial.ttf': 'arialbd.ttf', 'DejaVuSans.ttf': 'DejaVuSans-Bold.ttf',
             'LiberationSans-Regular.ttf': 'LiberationSans-Bold.ttf', 'NotoSans-Regular.ttf': 'NotoSans-SemiBold.ttf'}


@lru_cache(maxsize=64)
def font(size, weight=600):
    """Шрифт с кириллицей. PREVIEW_FONT=<путь к .ttf> — свой. Переменный (Noto Sans VF) получает нужную
    насыщенность; у обычных при weight ≥ 600 берётся полужирный файл из той же папки, если он есть."""
    env = os.environ.get('PREVIEW_FONT')
    for p in ([env] if env else []) + FONT_CANDIDATES:
        names = [p]
        b = FONT_BOLD.get(os.path.basename(p))
        if b and weight >= 600: names.insert(0, os.path.join(os.path.dirname(p), b))
        for q in names:
            try:
                f = ImageFont.truetype(q, int(round(size)))
            except Exception:
                continue
            try: f.set_variation_by_axes([weight])
            except Exception: pass  # noqa: E701
            return f
    return ImageFont.load_default()


def text_width(t, f, track=0.0):
    return f.getlength(t) + track * max(0, len(t) - 1)


def _draw(d, x, y, t, f, anchor, track, **kw):
    if not track:
        d.text((x, y), t, font=f, anchor=anchor, **kw); return
    w = text_width(t, f, track)              # разрядка (трекинг): посимвольно
    x -= {'l': 0, 'm': w / 2, 'r': w}[anchor[0]]
    for ch in t:
        d.text((x, y), ch, font=f, anchor='l' + anchor[1], **kw); x += f.getlength(ch) + track


def text_layer(W, H, items):
    """items: (x, y, text, font, rgba, anchor, halo_px, halo_rgba[, track_px]). Возвращает float32 RGBA премультипл."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    halo = Image.new('RGBA', (W, H), (0, 0, 0, 0)); dh = ImageDraw.Draw(halo)
    anyhalo = False
    for it in items:
        (x, y, t, f, col, anchor, hp, hcol), track = it[:8], (it[8] if len(it) > 8 else 0)
        if hp:
            _draw(dh, x, y, t, f, anchor, track, fill=hcol, stroke_width=int(hp), stroke_fill=hcol); anyhalo = True
        _draw(d, x, y, t, f, anchor, track, fill=col)
    a = np.asarray(im, np.float32) / 255.0
    a[..., :3] *= a[..., 3:4]
    if anyhalo:
        h = np.asarray(halo, np.float32) / 255.0
        h = cv2.GaussianBlur(h, (0, 0), 1.2); h[..., :3] *= h[..., 3:4]
        a = a + h * (1 - a[..., 3:4])
    return a


def over(dst_rgb, layer_pm, opacity=1.0):
    """Наложение премультиплицированного RGBA-слоя на RGB."""
    if opacity <= 0: return dst_rgb
    a = layer_pm[..., 3:4] * opacity
    return dst_rgb * (1 - a) + layer_pm[..., :3] * opacity


# ───────────────────────── цвет ─────────────────────────
def grade(rgb, sat=1.0, gamma=1.0, gain=1.0, lift=0.0, contrast=1.0, warm=0.0):
    x = rgb
    if sat != 1.0:
        l = (x * np.float32([0.299, 0.587, 0.114])).sum(-1, keepdims=True); x = l + (x - l) * sat
    if contrast != 1.0: x = (x - 0.5) * contrast + 0.5
    if warm: x = x * np.float32([1 + warm, 1, 1 - warm])
    x = np.clip(x * gain + lift, 0, 1)
    if gamma != 1.0: x = x ** (1 / gamma)
    return x.astype(np.float32)


def vignette(W, H, strength=0.35, power=2.2):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
    return (1 - strength * d ** power)[..., None].astype(np.float32)


def unsharp(rgb, amount=0.35, sigma=1.0):
    b = cv2.GaussianBlur(rgb, (0, 0), sigma); return np.clip(rgb + (rgb - b) * amount, 0, 1)


def to_u8(rgb):
    return (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def save_webp(rgb, path, q=72):
    Image.fromarray(to_u8(rgb)).save(path, 'WEBP', quality=q, method=6)


def save_jpg(rgb, path, q=86):
    Image.fromarray(to_u8(rgb)).save(path, 'JPEG', quality=q, optimize=True, progressive=True)
