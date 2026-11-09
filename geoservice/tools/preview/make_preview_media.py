#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_preview_media.py — медиа для превью-страницы геосервиса из РЕАЛЬНЫХ данных.

  hero : hero-bare.webp  — «голый» космоснимок участка
         hero-alive.webp / hero-alive.mp4 — тот же кадр + границы лесного фонда: лесхозы, лесничества,
                           кварталы с номерами и выделы; анимация «сканирования» (бесшовная петля)
         hero-ids.png + hero.json — карта выделов для подсказки и подсветки под курсором, легенда
  story: frames/ (16:9) и frames-m/ (9:16) — «нырок» от всей Беларуси: границы всех лесхозов → лесхоз
         участка с названием → лесничества → кварталы с номерами → выделы;
         manifest.json (число кадров + центр/масштаб каждого кадра для HUD), intro.mp4 / intro-m.mp4
  og   : og.jpg 1200×630 для превью ссылки в мессенджерах

Источники по умолчанию — публичные: Esri World Imagery (тайлы) и WFS ГУ «Белгослес» (bank.belgosles.by):
  BelGosLes:view_leshoz — лесхозы, BelGosLes:view_lesnich — лесничества,
  BelGosLes:quarter — кварталы, BelGosLes:allotmentMin — выделы.
Свои слои и поля — ключами --wfs-* и --f-*. Всё скачанное кэшируется (--cache), повторный запуск — офлайн (--offline).

Пример:
  python3 tools/preview/make_preview_media.py --out static/preview/media
  python3 tools/preview/make_preview_media.py --lat 53.42 --lon 28.63 --width 6000 --only hero,og
"""
import argparse, json, math, os, re, subprocess, sys, time

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pvlib import (Cache, XYZImagery, Layer, load_wfs, rasterize, anchors_of, merc, unmerc, smoothstep,  # noqa: E402
                   render, needed_tiles, font, text_layer, text_width, over, grade, vignette, unsharp, to_u8,
                   save_webp, save_jpg)

DEF_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
DEF_WFS = 'https://bank.belgosles.by/geoserver/wfs'
WORLD_TOPO = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json'
BY_BBOX = (23.18, 51.26, 32.78, 56.17)
CITIES = [('Минск', 53.902, 27.561, True), ('Брест', 52.097, 23.734, False), ('Гродно', 53.669, 23.813, False),
          ('Гомель', 52.441, 30.988, False), ('Могилёв', 53.894, 30.331, False), ('Витебск', 55.184, 30.202, False)]
C = lambda *v: np.float32(v) / 255  # noqa: E731
AMBER, AMBER_HI = C(242, 179, 94), C(255, 222, 168)          # кварталы
AMBER_LINE = C(248, 196, 122)
TEAL, TEAL_HI = C(91, 224, 200), C(196, 255, 240)            # лесничества
CREAM, CREAM_GLOW = C(255, 246, 230), C(255, 212, 150)       # лесхозы
WARM_WHITE = C(255, 240, 214)
EMERALD = C(63, 215, 174)                                    # тинт лесного фонда
LEGEND = [('leshoz', 'Лесхозы', '#FFF0D6'), ('lesnich', 'Лесничества', '#5BE0C8'),
          ('quarter', 'Кварталы', '#F2B35E'), ('allot', 'Выделы', '#FFFFFF')]
# тайминги «нырка» (доли прогресса скролла); меняются ключом --timing key=val,…
TIMING = dict(zoom0=0.03, zoom1=0.93,
              hl0=0.16, hl1=0.26, hl2=0.60, hl3=0.70,         # лесхоз участка: подсветка
              hn0=0.20, hn1=0.28, hn2=0.54, hn3=0.62,         # …и его название
              ln0=0.40, ln1=0.50, lt0=0.46, lt1=0.54, lt2=0.70, lt3=0.76,   # лесничества и их названия
              q0=0.56, q1=0.66, qt0=0.72, qt1=0.80,           # кварталы и номера
              a0=0.74, a1=0.84,                               # выделы
              dk0=0.34, dk1=0.62)                             # притемнение снимка под границами


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def clean_name(s):
    s = re.sub(r'_.*$', '', str(s or '').strip())            # «Махновичское_принятые» → «Махновичское»
    s = re.sub(r'["«»]', '', s)
    return re.sub(r'\s+ГЛХУ$', '', s).strip()


def lesnich_name(s):
    n = clean_name(s)
    return n if not n or re.search('лесничеств', n, re.I) else n + ' лесничество'


def split2(t, f, maxw, track=0.0):
    """Длинное название — в две строки (по пробелу ближе к середине)."""
    if text_width(t, f, track) <= maxw or ' ' not in t: return [t]
    sp = [m.start() for m in re.finditer(' ', t)]
    i = min(sp, key=lambda p: abs(p - len(t) / 2))
    return [t[:i], t[i + 1:]]


# ───────────────────────── цвет ─────────────────────────
def colorize(I, col, gain=1.0):
    """«Цвет» в Lab: яркость (текстура крон) — из снимка, оттенок — из col."""
    lab = cv2.cvtColor(np.ascontiguousarray(I, np.float32), cv2.COLOR_RGB2Lab)
    lc = cv2.cvtColor(np.ascontiguousarray(np.broadcast_to(col, I.shape), np.float32), cv2.COLOR_RGB2Lab)
    L = np.clip(lab[..., :1] * 1.08 + 8, 0, 100)
    out = cv2.cvtColor(np.concatenate([L, lc[..., 1:] * 0.55 * gain], -1).astype(np.float32), cv2.COLOR_Lab2RGB)
    return np.clip(out, 0, 1)


def cool_dark(I):
    """Фон «живого» слоя: темнее и холоднее снимка — границы читаются лучше."""
    return grade(I, sat=0.55, gain=0.66, warm=-0.03)


def down(m, W, H):
    return cv2.resize(m.astype(np.float32), (W, H), interpolation=cv2.INTER_AREA)


def blur(m, s):
    return cv2.GaussianBlur(m, (0, 0), s)


def lerp_log(mpp, pts):
    """Значение по log(м/пикс): pts = [(mpp, v), …] по возрастанию mpp."""
    xs = [math.log(p) for p, _ in pts]; ys = [v for _, v in pts]
    return float(np.interp(math.log(mpp), xs, ys))


def draw_bounds(img, M, flow=1.0, k=1.0):
    """Границы поверх кадра: выделы (белые тонкие) → кварталы (янтарь со свечением) →
    лесничества (бирюза) → лесхозы (кремовые, толстые, со свечением). M: маски и альфы."""
    aA, aQ, aL, aH = M.get('aA', 0), M.get('aQ', 0), M.get('aL', 0), M.get('aH', 0)
    if aA > 0:
        e = M['A'][..., None]
        img = img * (1 - 0.45 * e * aA) + 0.45 * e * aA
    if aQ > 0:
        q = M['Q']; e = q[..., None]
        g = (blur(q, 5.0 * k) * 0.85 + blur(q, 16.0 * k) * 0.35)[..., None]
        img = img + AMBER * g * flow * aQ * M.get('gQ', 1.0)
        img = img * (1 - e * 0.95 * aQ) + AMBER_LINE * e * 0.95 * aQ * (0.75 + 0.25 * flow)
    if aL > 0:
        ln = M['L']; e = ln[..., None]
        img = img * (1 - 0.35 * blur(ln, 2.5 * k)[..., None] * aL)
        g = (blur(ln, 6.0 * k) * 0.8 + blur(ln, 18.0 * k) * 0.32)[..., None]
        img = img + TEAL * g * aL * (0.75 + 0.25 * flow)
        img = img * (1 - e * aL) + TEAL_HI * e * aL * 0.92
    if aH > 0:
        h = M['H']; e = h[..., None]
        img = img * (1 - 0.45 * blur(h, 3.5 * k)[..., None] * aH)
        g = (blur(h, 8.0 * k) * 0.9 + blur(h, 24.0 * k) * 0.4)[..., None]
        img = img + CREAM_GLOW * g * aH * M.get('gH', 1.0)
        img = img * (1 - e * aH) + CREAM * e * aH
    return img


class Labels:
    """Подписи с простым отсевом наложений (кто раньше добавлен — тот важнее)."""
    def __init__(self, W, H):
        self.W, self.H = W, H; self.items = []; self.boxes = []

    def block(self, x, y, parts, pad=4, margin=6, force=False, gap=3, lh=1.18):
        """Блок строк с центром в (x, y). parts: [(строки, шрифт, rgba, halo_rgba, трекинг)]."""
        rows = [(t, f, rgba, halo, tr, f.size * lh) for lines, f, rgba, halo, tr in parts for t in lines]
        if not rows: return False
        w = max(text_width(r[0], r[1], r[4]) for r in rows); h = sum(r[5] for r in rows) + gap * (len(parts) - 1)
        b = (x - w / 2 - pad, y - h / 2 - pad, x + w / 2 + pad, y + h / 2 + pad)
        if not force:
            if b[0] < margin or b[1] < margin or b[2] > self.W - margin or b[3] > self.H - margin: return False
            for o in self.boxes:
                if b[0] < o[2] and o[0] < b[2] and b[1] < o[3] and o[1] < b[3]: return False
        self.boxes.append(b)
        yy = y - h / 2
        for lines, f, rgba, halo, tr in parts:
            for t in lines:
                hs = f.size * lh; self.items.append((x, yy + hs / 2, t, f, rgba, 'mm', 3, halo, tr)); yy += hs
            yy += gap
        return True

    def add(self, x, y, lines, f, rgba, halo=(6, 12, 9, 200), track=0.0, **kw):
        return self.block(x, y, [(lines, f, rgba, halo, track)], **kw)

    def layer(self):
        return text_layer(self.W, self.H, self.items) if self.items else None


# ───────────────────────── сцена: снимок + слои ─────────────────────────
class Scene:
    def __init__(self, a, cache):
        self.a = a; self.cache = cache
        self.imagery = XYZImagery(cache, a.imagery, maxz=a.imagery_maxz, lru=1600)
        self.P = merc(a.lat, a.lon)
        x0, y0 = merc(BY_BBOX[1] - 0.3, BY_BBOX[0] - 0.3); x1, y1 = merc(BY_BBOX[3] + 0.3, BY_BBOX[2] + 0.3)
        log('WFS: лесхозы —', a.wfs_leshoz)
        self.LH = Layer(load_wfs(cache, a.wfs, a.wfs_leshoz, (x0, y0, x1, y1), page=0))
        self.lh_names = [clean_name(f.get('properties', {}).get(a.f_leshoz)) for f in self.LH.feats]
        self.target_lh = self.at(self.LH, *self.P)
        log('  лесхозов: %d; участок — %s' % (len(self.LH), self.lh_names[self.target_lh] if self.target_lh >= 0 else 'вне лесхозов'))
        self.LN = self.Q = self.A = None
        self.ln_names = []; self.target_ln = -1

    @staticmethod
    def at(layer, X, Y):
        ids = rasterize(layer.feats, X, Y, 4.0, 3, 3)
        return int(ids[1, 1]) - 1

    def load(self, bbs):
        a = self.a
        if 'ln' in bbs:
            log('WFS: лесничества в %.0f×%.0f км' % ((bbs['ln'][2] - bbs['ln'][0]) / 1e3, (bbs['ln'][3] - bbs['ln'][1]) / 1e3))
            self.LN = Layer(load_wfs(self.cache, a.wfs, a.wfs_lesnich, bbs['ln'], page=0))
            self.ln_names = [lesnich_name(f.get('properties', {}).get(a.f_lesnich)) for f in self.LN.feats]
            self.target_ln = self.at(self.LN, *self.P)
            log('  лесничеств: %d; участок — %s' % (len(self.LN), self.ln_names[self.target_ln] if self.target_ln >= 0 else '—'))
        if 'q' in bbs:
            log('WFS: кварталы в %.0f×%.0f км' % ((bbs['q'][2] - bbs['q'][0]) / 1e3, (bbs['q'][3] - bbs['q'][1]) / 1e3))
            self.Q = Layer(load_wfs(self.cache, a.wfs, a.wfs_quarter, bbs['q']))
            self.q_num = [str((f.get('properties') or {}).get(a.f_quarter) or '') for f in self.Q.feats]
            log('  кварталов: %d' % len(self.Q))
        if 'a' in bbs:
            log('WFS: выделы в %.1f×%.1f км' % ((bbs['a'][2] - bbs['a'][0]) / 1e3, (bbs['a'][3] - bbs['a'][1]) / 1e3))
            self.A = Layer(load_wfs(self.cache, a.wfs, a.wfs_allot, bbs['a']))
            log('  выделов: %d' % len(self.A))

    def allot_label(self, fi):
        p = self.A.feats[fi].get('properties') or {}
        n, s = p.get(self.a.f_allot), p.get(self.a.f_allot_sub)
        return (str(n) if n is not None else '') + ('.%s' % s if s not in (None, '', 0, '0') else '')


def union_bb(rects):
    return (min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects))


def grow(bb, f):
    w, h = (bb[2] - bb[0]) * f / 2, (bb[3] - bb[1]) * f / 2
    return (bb[0] - w, bb[1] - h, bb[2] + w, bb[3] + h)


# ───────────────────────── HERO ─────────────────────────
def hero_bb(scene, a):
    cx, cy = scene.P; hw, hh = a.width / 2, a.width * a.hero_h / a.hero_w / 2
    return grow((cx - hw, cy - hh, cx + hw, cy + hh), 0.25)


def make_hero(scene, out, a):
    W, H = a.hero_w, a.hero_h; SS = 2
    cx, cy = scene.P; mpp = a.width / W
    log('HERO: снимок %d×%d, %.2f м/пикс (суперсэмплинг ×%d)' % (W, H, mpp, SS))
    views = [(cx, cy, mpp / SS, W * SS, H * SS)]
    scene.imagery.prefetch(needed_tiles(scene.imagery, views, bias=1))
    I2 = render(scene.imagery, cx, cy, mpp / SS, W * SS, H * SS, bias=1)
    I1 = down(I2, W, H)
    vig = vignette(W, H, 0.28)
    bare = unsharp(grade(I1, sat=0.92, contrast=1.04), 0.25, 1.0) * vig
    save_webp(bare, os.path.join(out, 'hero-bare.webp'), a.q_hero)

    # статичная «живая» основа: тёмный холодный снимок + лёгкий тинт лесного фонда
    forest = scene.A.fill(cx, cy, mpp, W, H, ss=SS)[..., None]
    dark = unsharp(cool_dark(I1), 0.25, 1.0)
    base = (dark * (1 - 0.3 * forest) + colorize(dark, EMERALD, 0.8) * 0.3 * forest) * vig
    M = dict(A=scene.A.lines(cx, cy, mpp, W, H, 1.0, ss=SS), Q=scene.Q.lines(cx, cy, mpp, W, H, a.qline, ss=SS),
             L=scene.LN.lines(cx, cy, mpp, W, H, 3.0, ss=SS, ext_only=True),
             H=scene.LH.lines(cx, cy, mpp, W, H, 4.4, ss=SS, ext_only=True), aA=1.0, aQ=1.0, aL=1.0, aH=1.0)

    # подписи: лесхозы → лесничества → номера кварталов (без наложений)
    Lb = Labels(W, H)
    region = np.zeros((H, W), bool); region[int(H * 0.1):int(H * 0.9), int(W * 0.42):int(W * 0.94)] = True
    f_lh = font(17, 700); f_ln = font(15, 600); f_q = font(a.label_px, 650)
    idsH = scene.LH.ids(cx, cy, mpp, W, H); idsL = scene.LN.ids(cx, cy, mpp, W, H); idsQ = scene.Q.ids(cx, cy, mpp, W, H)
    C_LH, H_LH, C_LN, H_LN = (255, 238, 210, 250), (20, 12, 4, 215), (206, 255, 243, 245), (3, 18, 14, 210)
    done_ln = set()
    for fi, x, y, d in sorted(anchors_of(idsH, 60, region), key=lambda r: -r[3]):
        li = int(idsL[min(H - 1, int(y)), min(W - 1, int(x))])          # лесничество в точке подписи — второй строкой
        parts = [(split2(scene.lh_names[fi - 1].upper(), f_lh, 300, 1.6), f_lh, C_LH, H_LH, 1.6)]
        if li: parts.append((split2(scene.ln_names[li - 1], f_ln, 280), f_ln, C_LN, H_LN, 0))
        if Lb.block(x, y, parts, gap=4) and li: done_ln.add(li)
    for fi, x, y, d in sorted(anchors_of(idsL, 45, region), key=lambda r: -r[3]):
        if fi in done_ln: continue
        for dy in (0, 30, -30, 56, -56):
            if Lb.add(x, y + dy, split2(scene.ln_names[fi - 1], f_ln, 260), f_ln, C_LN, H_LN): break
    nq = 0
    for fi, x, y, d in anchors_of(idsQ, a.label_min):
        nq += Lb.add(x, y, [scene.q_num[fi - 1]], f_q, (255, 255, 255, 240), (8, 18, 10, 200), pad=2, margin=3)
    labels = Lb.layer()
    log('  подписей: %d (номеров кварталов %d)' % (len(Lb.boxes), nq))

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    th = math.radians(8)
    dd = yy * math.cos(th) + xx * math.sin(th)
    dmin, dmax = float(dd.min()), float(dd.max())
    tau = 0.11 * H
    flow_phase = (xx + 0.6 * yy) / 560.0

    def frame(t):
        breath = 1 + 0.06 * math.sin(2 * math.pi * t)
        flow = (0.62 + 0.38 * (0.5 + 0.5 * np.sin(2 * math.pi * (flow_phase - t)))).astype(np.float32)[..., None]
        img = base
        if t < 0.9:          # «сканирующая» полоса проходит кадр и оставляет подсвеченный след
            c = dmin - 30 + (t / 0.9) * (dmax - dmin + 30 + 5 * tau)
            dc = c - dd
            trail = np.where(dc >= 0, np.exp(-np.maximum(dc, 0) / tau), 0).astype(np.float32)[..., None]
            line = (np.exp(-(dc / 1.6) ** 2) + 0.35 * np.exp(-(dc / 12.0) ** 2)).astype(np.float32)[..., None]
            img = img * (1 + 0.22 * trail * forest)
        else:
            trail = line = None
        img = draw_bounds(img, dict(M, gQ=breath * (1.0 if trail is None else 1 + 0.6 * trail), gH=breath), flow=flow)
        if labels is not None: img = over(img, labels)
        if line is not None:
            img = img + WARM_WHITE * line * 0.55 + AMBER * trail * 0.035
        return np.clip(img, 0, 1)

    alive0 = frame(0.0)
    save_webp(alive0, os.path.join(out, 'hero-alive.webp'), a.q_hero)
    if not a.no_video:
        n = int(round(a.alive_seconds * a.fps))
        log('  видео петли: %d кадров' % n)
        encode((frame(i / n) for i in range(n)), os.path.join(out, 'hero-alive.mp4'), W, H, a.fps, a.crf_hero)

    # карта выделов для подсказки и подсветки (½ разрешения, RGB = индекс+1), к каждому — лесничество и лесхоз
    w2, h2 = W // 2, H // 2; m2 = mpp * 2
    ids = scene.A.ids(cx, cy, m2, w2, h2)
    L2 = scene.LN.ids(cx, cy, m2, w2, h2); H2 = scene.LH.ids(cx, cy, m2, w2, h2)

    def majority(sub):
        msk = (ids > 0) & (sub > 0)
        key = ids[msk].astype(np.int64) * 65536 + sub[msk]
        u, c = np.unique(key, return_counts=True)
        best = {}
        for kk, cc in zip(u.tolist(), c.tolist()):
            fi, v = divmod(kk, 65536)
            if cc > best.get(fi, (0, 0))[0]: best[fi] = (cc, v)
        return {fi: v for fi, (cc, v) in best.items()}
    ln_of, lh_of = majority(L2), majority(H2)
    rgb = np.stack([(ids & 255), (ids >> 8) & 255, np.zeros_like(ids)], -1).astype(np.uint8)
    Image.fromarray(rgb).save(os.path.join(out, 'hero-ids.png'), optimize=True)
    used = sorted(set(np.unique(ids).tolist()) - {0})
    ln_list, lh_list, feats = [], [], {}

    def ref(lst, name):
        if not name: return -1
        if name not in lst: lst.append(name)
        return lst.index(name)
    for fi in used:
        p = scene.A.feats[fi - 1].get('properties') or {}
        li, hi = ln_of.get(fi, 0), lh_of.get(fi, 0)
        feats[str(fi)] = [str(p.get(a.f_allot_quarter) or ''), scene.allot_label(fi - 1), round(float(p.get(a.f_area) or 0), 1),
                          ref(ln_list, scene.ln_names[li - 1] if li else ''), ref(lh_list, scene.lh_names[hi - 1] if hi else '')]
    counts = dict(leshoz=len(set(np.unique(idsH).tolist()) - {0}), lesnich=len(set(np.unique(idsL).tolist()) - {0}),
                  quarter=len(set(np.unique(idsQ).tolist()) - {0}), allot=len(used))
    meta = dict(lat=a.lat, lon=a.lon, width_m=a.width, size=[W, H], ids_size=[w2, h2],
                lesnich=ln_list, leshoz=lh_list, features=feats,
                legend=[dict(k=k, name=nm, color=c, n=counts[k]) for k, nm, c in LEGEND],
                target=dict(leshoz=scene.lh_names[scene.target_lh] if scene.target_lh >= 0 else '',
                            lesnich=scene.ln_names[scene.target_ln] if scene.target_ln >= 0 else ''),
                attribution='Снимки: Esri, Maxar, Earthstar Geographics · Лесной фонд: ГУ «Белгослес»')
    with open(os.path.join(out, 'hero.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))
    log('  в кадре: лесхозов %(leshoz)d, лесничеств %(lesnich)d, кварталов %(quarter)d, выделов %(allot)d' % counts)
    return alive0, bare


def encode(frames, path, W, H, fps, crf, gop=None):
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(fps),
           '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', str(crf), '-pix_fmt', 'yuv420p',
           '-movflags', '+faststart']
    if gop: cmd += ['-g', str(gop)]
    p = subprocess.Popen(cmd + [path], stdin=subprocess.PIPE)
    for fr in frames: p.stdin.write(to_u8(fr).tobytes())
    p.stdin.close()
    if p.wait() != 0: raise RuntimeError('ffmpeg: ошибка кодирования ' + path)


# ───────────────────────── STORY («нырок») ─────────────────────────
def belarus_rings(cache):
    d = json.loads(cache.get(WORLD_TOPO, '.json', validate=lambda b, ct: b[:1] == b'{').decode('utf-8'))
    sx, sy = d['transform']['scale']; tx, ty = d['transform']['translate']
    arcs = []
    for arc in d['arcs']:
        x = y = 0; pts = []
        for dx, dy in arc:
            x += dx; y += dy; pts.append(merc(y * sy + ty, x * sx + tx))
        arcs.append(pts)
    geom = next(g for g in d['objects']['countries']['geometries'] if str(g.get('id')) == '112')
    polys = geom['arcs'] if geom['type'] == 'MultiPolygon' else [geom['arcs']]
    rings = []
    for poly in polys:
        for ring in poly:
            pts = []
            for i in ring:
                a = arcs[i] if i >= 0 else arcs[~i][::-1]
                pts.extend(a if not pts else a[1:])
            rings.append(np.array(pts, np.float64))
    return rings


def ease_zoom(u):
    u = min(1.0, max(0.0, u))
    return 0.35 * u + 0.65 * u * u * (3 - 2 * u)


class Story:
    def __init__(self, scene, a, W, H, portrait):
        self.s = scene; self.a = a; self.T = a.T; self.W, self.H = W, H; self.portrait = portrait
        self.k = a.portrait_scale if portrait else 1.0          # масштаб подписей/линий
        short = W if portrait else H
        self.short = short
        self.s0 = a.start_span * (1.12 if portrait else 1.0)
        self.s1 = a.width * 9 / 16
        x0, y0 = merc(*BY_BBOX[1::-1]); x1, y1 = merc(*BY_BBOX[:1:-1])
        # Беларусь в первом кадре смещена: на десктопе — вправо (слева подпись), на телефоне — вверх (подпись снизу)
        mpp0 = self.s0 / short
        if portrait:
            self.c0 = ((x0 + x1) / 2, (y0 + y1) / 2 - a.start_shift_y * H * mpp0)
        else:
            self.c0 = ((x0 + x1) / 2 - a.start_shift_x * W * mpp0, (y0 + y1) / 2)
        P = scene.P
        self.off0 = ((P[0] - self.c0[0]) / self.s0, (P[1] - self.c0[1]) / self.s0)

    def view(self, t, zeta=1.0):
        T = self.T
        E = ease_zoom((t - T['zoom0']) / (T['zoom1'] - T['zoom0']))
        span = self.s0 * (self.s1 / self.s0) ** E / zeta
        off = (self.off0[0] * (1 - E), self.off0[1] * (1 - E))
        P = self.s.P
        cx, cy = P[0] - off[0] * span, P[1] - off[1] * span
        return cx, cy, span / self.short

    def rect(self, t):
        cx, cy, mpp = self.view(t)
        return (cx - self.W / 2 * mpp, cy - self.H / 2 * mpp, cx + self.W / 2 * mpp, cy + self.H / 2 * mpp)

    def tile_views(self, ts):
        return [self.view(t) + (self.W, self.H) for t in ts]


def draw_polyline_mask(W, H, rings_px, thick):
    m = np.zeros((H, W), np.uint8); SH = 3
    pts = [np.round(r * 2 ** SH).astype(np.int32) for r in rings_px]
    cv2.polylines(m, pts, True, 255, max(1, int(round(thick))), cv2.LINE_AA, SH)
    return m.astype(np.float32) / 255


def story_frame(st, t, borders, anc, zeta=1.0, glow_pulse=0.0, soften=0.0):
    s, a, T, W, H, k = st.s, st.a, st.T, st.W, st.H, st.k
    cx, cy, mpp = st.view(t, zeta)
    x0, y1 = cx - W / 2 * mpp, cy + H / 2 * mpp
    to_px = lambda X, Y: np.stack([(X - x0) / mpp, (y1 - Y) / mpp], -1)   # noqa: E731
    I = grade(render(s.imagery, cx, cy, mpp, W, H, bias=1), sat=0.92, contrast=1.04)
    dk = smoothstep(T['dk0'], T['dk1'], t)
    img = I * (1 - dk) + cool_dark(I) * dk
    # лесной фонд (по лесхозам): лёгкий тинт; лесхоз участка — тёплая подсветка
    hl = smoothstep(T['hl0'], T['hl1'], t) * (1 - smoothstep(T['hl2'], T['hl3'], t))
    fill = s.LH.fill(cx, cy, mpp, W, H)[..., None]
    tint = 0.10 + 0.14 * dk
    img = img * (1 - tint * fill) + colorize(img, EMERALD) * tint * fill
    tl = s.target_lh
    ft0 = s.LH.fill(cx, cy, mpp, W, H, sel=[tl]) if tl >= 0 and (hl > 0 or t < T['hn3']) else None
    if hl > 0 and ft0 is not None:      # лесхоз участка светлее, остальное — чуть темнее
        ft = cv2.GaussianBlur(ft0, (0, 0), 1.5 * k)[..., None]
        img = img * (1 + 0.24 * hl * ft) * (1 - 0.2 * hl * (1 - ft)) + CREAM_GLOW * 0.07 * hl * ft
    # контур Беларуси + притемнение вокруг
    ab = 1 - smoothstep(0.16, 0.36, t)
    if ab > 0:
        rings = [to_px(r[:, 0], r[:, 1]) for r in borders]
        dim = 0.42 * (1 - smoothstep(0.06, 0.28, t))
        if dim > 0:
            m = np.zeros((H, W), np.uint8); SH = 3
            cv2.fillPoly(m, [np.round(r * 2 ** SH).astype(np.int32) for r in rings], 255, cv2.LINE_AA, SH)
            m = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 2.0)[..., None]
            img = img * (1 - dim * (1 - m))
        line = draw_polyline_mask(W, H, rings, 1.6 * k)
        g1 = cv2.GaussianBlur(line, (0, 0), 4 * k)[..., None]; g2 = cv2.GaussianBlur(line, (0, 0), 14 * k)[..., None]
        gl = 1 + glow_pulse
        img = img + AMBER * (g1 * 1.1 + g2 * 0.6) * ab * gl
        img = img * (1 - line[..., None] * 0.9 * ab) + AMBER_HI * line[..., None] * 0.9 * ab
    # границы
    M = {}
    aH = 0.42 + 0.58 * smoothstep(0.30, 0.50, t)
    M['H'] = s.LH.lines(cx, cy, mpp, W, H, lerp_log(mpp, [(5, 4.0), (80, 2.4), (1500, 0.9)]) * k, min_px=1.5, ext_only=True)
    M['aH'] = aH; M['gH'] = (0.45 + 0.35 * smoothstep(0.3, 0.5, t)) * (1 + glow_pulse) * lerp_log(mpp, [(5, 1.0), (15, 0.7), (40, 0.45), (200, 1.0)])
    if hl > 0 and tl >= 0:      # лесхоз участка — ярче и толще
        ht = s.LH.lines(cx, cy, mpp, W, H, lerp_log(mpp, [(5, 4.4), (80, 3.4), (1500, 2.2)]) * k, sel=[tl], ext_only=True)
        M['H'] = np.maximum(M['H'] * (1 - 0.35 * hl), ht * (0.6 + 0.4 * hl)) if hl < 1 else np.maximum(M['H'], ht)
        M['gH'] = M['gH'] * (1 + 0.5 * hl)
    aL = smoothstep(T['ln0'], T['ln1'], t)
    if aL > 0 and s.LN is not None:
        M['L'] = s.LN.lines(cx, cy, mpp, W, H, lerp_log(mpp, [(5, 3.0), (80, 1.5), (300, 1.0)]) * k, min_px=3, ext_only=True)
        M['aL'] = aL
    aQ = smoothstep(T['q0'], T['q1'], t)
    if aQ > 0 and s.Q is not None:
        M['Q'] = s.Q.lines(cx, cy, mpp, W, H, lerp_log(mpp, [(5, a.qline * 0.92), (12, 1.4), (40, 0.8)]) * k, min_px=2)
        M['aQ'] = aQ * lerp_log(mpp, [(5, 0.95), (20, 0.75)])
        M['gQ'] = lerp_log(mpp, [(5, 1.0), (12, 0.6), (35, 0.25)])        # на среднем масштабе сетка густая — меньше свечения
    aA = smoothstep(T['a0'], T['a1'], t)
    if aA > 0 and s.A is not None:
        M['A'] = s.A.lines(cx, cy, mpp, W, H, 1.0 * k, min_px=2); M['aA'] = aA
    img = draw_bounds(img, M, flow=1.0, k=k)
    img = img * st.vig
    if soften >= 0.15:      # лёгкое смягчение кадров «в движении»: −20…25 % к размеру WebP, глазу не заметно
        img = cv2.GaussianBlur(img, (0, 0), soften)
    # ── подписи: города, лесхоз участка, лесничества, номера кварталов ──
    Lb = Labels(W, H)
    f_city = font(15 * k, 600); f_city_b = font(17 * k, 650)
    f_lh = font(17 * k, 700); f_lh2 = font(14 * k, 650); f_ln = font(15 * k, 600); f_q = font(a.label_px * k, 650)
    dots = np.zeros((H, W), np.float32)
    safe_x = W * (0.11 if H > W else 0.06)
    for name, la, lo, big in CITIES:
        al = (1 - smoothstep(0.42, 0.52, t)) if big else (1 - smoothstep(0.08, 0.18, t))
        if al <= 0.01: continue
        X, Y = merc(la, lo); p = to_px(np.array([X]), np.array([Y]))[0]
        if not (-50 < p[0] < W + 50 and -50 < p[1] < H + 50): continue
        r = (4.2 if big else 3.2) * k
        cv2.circle(dots, (int(round(p[0] * 8)), int(round(p[1] * 8))), int(round(r * 8)), al, -1, cv2.LINE_AA, 3)
        fc = f_city_b if big else f_city
        # подпись не должна попадать в полосу, которую срежет object-fit: cover на узком экране, — тогда она слева от точки
        tw = fc.getlength(name)
        left = p[0] + 10 * k + tw > W - safe_x
        Lb.add(p[0] - 10 * k - tw / 2 if left else p[0] + 10 * k + tw / 2, p[1] - 1 * k, [name], fc,
               (255, 255, 255, int(235 * al)), (5, 12, 8, int(190 * al)), force=True)
    hn = smoothstep(T['hn0'], T['hn1'], t) * (1 - smoothstep(T['hn2'], T['hn3'], t))
    if hn > 0.01 and ft0 is not None:   # название лесхоза участка — в самой «глубокой» его точке в кадре
        lines = split2(s.lh_names[tl].upper(), f_lh, 260 * k, 1.4 * k)
        w = max(text_width(l, f_lh, 1.4 * k) for l in lines)
        m = np.zeros((H, W), np.uint8); mg = int(0.08 * min(W, H))
        m[mg:H - mg, mg:W - mg] = ft0[mg:H - mg, mg:W - mg] > 0.5
        if m.any():
            d = cv2.distanceTransform(m, cv2.DIST_L2, 5); j = int(np.argmax(d)); yy, xx = divmod(j, W)
            if d.flat[j] >= 0.3 * w:
                Lb.block(xx + 0.5, yy + 0.5, [(lines, f_lh, (255, 236, 205, int(250 * hn)), (20, 12, 4, int(215 * hn)), 1.4 * k)], force=True)
    if hn > 0.01:
        for fi, X, Y, dm in anc['lh']:
            p = to_px(np.array([X]), np.array([Y]))[0]
            main = fi == tl
            if main: continue
            fo = f_lh if main else f_lh2
            lines = split2(s.lh_names[fi].upper(), fo, 260 * k, 1.4 * k)
            w = max(text_width(l, fo, 1.4 * k) for l in lines)
            if not main and dm / mpp < 0.55 * w: continue
            al = hn if main else hn * 0.6 * smoothstep(0.30, 0.42, t)
            if al <= 0.01: continue
            Lb.add(p[0], p[1], lines, fo, (255, 236, 205, int(250 * al)), (20, 12, 4, int(215 * al)), track=1.4 * k, margin=14 * k)
    at = smoothstep(T['lt0'], T['lt1'], t) * (1 - smoothstep(T['lt2'], T['lt3'], t))
    if at > 0.01:
        for fi, X, Y, dm in anc['ln']:
            lines = split2(s.ln_names[fi], f_ln, 220 * k)
            w = max(text_width(l, f_ln) for l in lines)
            if dm / mpp < 0.5 * w: continue
            p = to_px(np.array([X]), np.array([Y]))[0]
            al = at * (1.0 if fi == s.target_ln else 0.9)
            Lb.add(p[0], p[1], lines, f_ln, (206, 255, 243, int(245 * al)), (3, 18, 14, int(205 * al)), margin=14 * k)
    aq = smoothstep(T['qt0'], T['qt1'], t)
    if aq > 0.01:
        for fi, X, Y, dm in anc['q']:
            if dm / mpp < 10 * k: continue
            p = to_px(np.array([X]), np.array([Y]))[0]
            Lb.add(p[0], p[1], [s.q_num[fi]], f_q, (255, 255, 255, int(240 * aq)), (8, 18, 10, int(200 * aq)), pad=2, margin=24 * k)
    if dots.max() > 0:
        dg = cv2.GaussianBlur(dots, (0, 0), 6 * k)[..., None]
        img = img + AMBER * dg * 0.9
        img = img * (1 - dots[..., None]) + WARM_WHITE * dots[..., None]
    # прицел на участке
    ar = smoothstep(0.05, 0.14, t) * (1 - smoothstep(0.50, 0.60, t))
    if ar > 0.01:
        P = to_px(np.array([s.P[0]]), np.array([s.P[1]]))[0]
        ring = np.zeros((H, W), np.float32); SH = 3; c = (int(round(P[0] * 8)), int(round(P[1] * 8)))
        rr = 26 * k
        cv2.circle(ring, c, int(rr * 8), 1.0, max(1, int(round(1.6 * k))), cv2.LINE_AA, SH)
        ang = t * 4 * math.pi
        for j in range(4):
            u = ang + j * math.pi / 2; d1, d2 = rr * 1.25, rr * 1.7
            p1 = (int(round((P[0] + math.cos(u) * d1) * 8)), int(round((P[1] + math.sin(u) * d1) * 8)))
            p2 = (int(round((P[0] + math.cos(u) * d2) * 8)), int(round((P[1] + math.sin(u) * d2) * 8)))
            cv2.line(ring, p1, p2, 1.0, max(1, int(round(1.6 * k))), cv2.LINE_AA, SH)
        ph = (t * 9) % 1.0       # расходящийся «пинг»
        cv2.circle(ring, c, int(rr * (1 + 2.2 * ph) * 8), float(0.7 * (1 - ph)), max(1, int(round(1.2 * k))), cv2.LINE_AA, SH)
        cv2.circle(ring, c, int(3 * k * 8), 1.0, -1, cv2.LINE_AA, SH)
        g = cv2.GaussianBlur(ring, (0, 0), 5 * k)[..., None]
        img = img + AMBER * g * 0.9 * ar
        img = img * (1 - ring[..., None] * ar) + AMBER_HI * ring[..., None] * ar
    lay = Lb.layer()
    if lay is not None: img = over(img, lay)
    return np.clip(img, 0, 1), (cx, cy, mpp)


def world_anchors(layer, bb, mpp_a, min_m=0.0):
    """Точки подписей объектов слоя в метрах EPSG:3857 (по растру охвата bb): [(индекс, X, Y, глубина_м)]."""
    Wa, Ha = max(8, int((bb[2] - bb[0]) / mpp_a)), max(8, int((bb[3] - bb[1]) / mpp_a))
    ids = layer.ids((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, mpp_a, Wa, Ha)
    x0, y1 = (bb[0] + bb[2]) / 2 - Wa / 2 * mpp_a, (bb[1] + bb[3]) / 2 + Ha / 2 * mpp_a
    return [(fi - 1, x0 + x * mpp_a, y1 - y * mpp_a, d * mpp_a) for fi, x, y, d in anchors_of(ids, min_m / mpp_a)]


def story_bbs(sts, a):
    """Охваты загрузки слоёв: по кадрам, где слой виден."""
    T = a.T; ts = [i / (a.frames - 1) for i in range(a.frames)]
    out = {}
    for key, t0 in (('ln', T['ln0']), ('q', T['q0']), ('a', T['a0'])):
        rects = [st.rect(t) for st in sts for t in ts if t >= t0 - 0.01]
        if rects: out[key] = grow(union_bb(rects), 0.04)
    return out


def make_story(scene, out, a, sts):
    T = a.T
    sets = [('frames', 'intro.mp4'), ('frames-m', 'intro-m.mp4')]
    borders = belarus_rings(scene.cache)
    N = a.frames
    ts = [i / (N - 1) for i in range(N)]
    # точки подписей (в метрах): лесхозы — по всей стране, лесничества и кварталы — по охвату кадров
    x0, y0 = merc(BY_BBOX[1], BY_BBOX[0]); x1, y1 = merc(BY_BBOX[3], BY_BBOX[2])
    anc = dict(lh=world_anchors(scene.LH, (x0, y0, x1, y1), 600.0, 3000))
    r_ln = union_bb([st.rect(t) for st in sts for t in ts if T['lt0'] - 0.01 <= t <= T['lt3'] + 0.01])
    anc['ln'] = world_anchors(scene.LN, grow(r_ln, 0.3), max(40.0, (r_ln[2] - r_ln[0]) / 3000), 1500)
    r_q = union_bb([st.rect(t) for st in sts for t in ts if t >= T['qt0'] - 0.01])
    anc['q'] = world_anchors(scene.Q, grow(r_q, 0.05), max(4.0, (r_q[2] - r_q[0]) / 3000), 40)
    log('STORY: точек подписей — лесхозов %d, лесничеств %d, кварталов %d' % (len(anc['lh']), len(anc['ln']), len(anc['q'])))
    for (folder, intro_name), st in zip(sets, sts):
        W, H = st.W, st.H
        od = os.path.join(out, folder); os.makedirs(od, exist_ok=True)
        for fn in os.listdir(od):
            if fn.startswith('f_') and fn.endswith('.webp'): os.remove(os.path.join(od, fn))
        st.vig = vignette(W, H, 0.22)
        log('STORY %s: %d кадров %d×%d — загрузка тайлов…' % (folder, N, W, H))
        n1 = scene.imagery.prefetch(needed_tiles(scene.imagery, st.tile_views(ts), bias=1))
        log('  скачано тайлов: %d' % n1)
        meta = dict(count=N, w=W, h=H, lat=[], lon=[], mpp=[], x=[], y=[])
        first = None
        soft = lambda t: a.soften * (1 - smoothstep(T['zoom1'] - 0.15, T['zoom1'] - 0.03, t))  # noqa: E731
        for i, t in enumerate(ts):
            img, (cx, cy, mpp) = story_frame(st, t, borders, anc, soften=soft(t))
            if i == 0: first = img
            save_webp(img, os.path.join(od, 'f_%04d.webp' % (i + 1)), a.q_frames)
            la, lo = unmerc(cx, cy)
            meta['lat'].append(round(la, 5)); meta['lon'].append(round(lo, 5)); meta['mpp'].append(round(mpp, 4))
            meta['x'].append(round(cx, 1)); meta['y'].append(round(cy, 1))
            if i % 20 == 0: log('  кадр %d/%d' % (i + 1, N))
        with open(os.path.join(od, 'manifest.json'), 'w') as f: json.dump(meta, f, separators=(',', ':'))
        if not a.no_video:
            n = int(round(a.intro_seconds * a.fps))
            log('  интро-петля %s: %d кадров' % (intro_name, n))

            def intro_frames():
                for j in range(n):
                    ph = (1 - math.cos(2 * math.pi * j / n)) / 2
                    yield story_frame(st, 0.0, borders, anc, zeta=1 + 0.035 * ph, glow_pulse=0.45 * ph,
                                      soften=soft(0.0))[0] if j else first
            encode(intro_frames(), os.path.join(out, intro_name), W, H, a.fps, a.crf_intro)
        sz = sum(os.path.getsize(os.path.join(od, f)) for f in os.listdir(od))
        log('  %s: %.1f МБ' % (folder, sz / 1e6))


# ───────────────────────── OG ─────────────────────────
def make_og(out, alive, a):
    H0, W0 = alive.shape[:2]
    W, H = 1200, 630
    s = max(W / W0, H / H0)
    im = cv2.resize(alive, (int(W0 * s + 0.5), int(H0 * s + 0.5)), interpolation=cv2.INTER_AREA)
    y = (im.shape[0] - H) // 2; x = (im.shape[1] - W) // 2
    im = im[y:y + H, x:x + W]
    xx = np.linspace(0, 1, W, dtype=np.float32)[None, :, None]
    im = im * (0.35 + 0.65 * np.clip((xx - 0.05) / 0.6, 0, 1) ** 0.8) + np.float32([0.03, 0.06, 0.04]) * (1 - np.clip(xx / 0.6, 0, 1))
    T = [(70, 250, 'Геосервис ОДЗиМЛ', font(30, 600), (242, 179, 94, 255), 'ls', 0, None),
         (66, 330, 'Лесной фонд', font(68, 700), (255, 255, 255, 255), 'ls', 0, None),
         (66, 405, 'как на ладони', font(68, 700), (255, 255, 255, 255), 'ls', 0, None),
         (70, 465, 'Снимки и границы лесного фонда — в браузере', font(26, 450), (220, 226, 220, 255), 'ls', 0, None)]
    im = over(np.clip(im, 0, 1), text_layer(W, H, T))
    save_jpg(im, os.path.join(out, 'og.jpg'), 86)


def main():
    ap = argparse.ArgumentParser(description='Медиа превью-страницы геосервиса из реальных снимков и границ лесного фонда')
    ap.add_argument('--out', default='static/preview/media')
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/geoservice-preview'))
    ap.add_argument('--offline', action='store_true', help='не ходить в сеть, только кэш')
    ap.add_argument('--only', default='hero,story,og', help='hero,story,og')
    ap.add_argument('--lat', type=float, default=54.4097); ap.add_argument('--lon', type=float, default=26.7545)
    ap.add_argument('--width', type=float, default=7000, help='ширина кадра героя, м EPSG:3857 (≈ ×cos(φ) на местности)')
    ap.add_argument('--start-span', type=float, default=1.1e6, help='высота первого кадра «нырка», м (вся Беларусь)')
    ap.add_argument('--start-shift-x', type=float, default=0.2); ap.add_argument('--start-shift-y', type=float, default=0.14)
    ap.add_argument('--imagery', default=DEF_IMAGERY); ap.add_argument('--imagery-maxz', type=int, default=17)
    ap.add_argument('--wfs', default=DEF_WFS)
    ap.add_argument('--wfs-leshoz', default='BelGosLes:view_leshoz'); ap.add_argument('--f-leshoz', default='name_lx')
    ap.add_argument('--wfs-lesnich', default='BelGosLes:view_lesnich'); ap.add_argument('--f-lesnich', default='name_ln')
    ap.add_argument('--wfs-quarter', default='BelGosLes:quarter'); ap.add_argument('--f-quarter', default='quarter_number')
    ap.add_argument('--wfs-allot', default='BelGosLes:allotmentMin')
    ap.add_argument('--f-allot', default='allotment_number'); ap.add_argument('--f-allot-sub', default='allotment_sub_number')
    ap.add_argument('--f-allot-quarter', default='quarter_number'); ap.add_argument('--f-area', default='area')
    ap.add_argument('--hero-w', type=int, default=1600); ap.add_argument('--hero-h', type=int, default=900)
    ap.add_argument('--frame-w', type=int, default=1280); ap.add_argument('--frame-h', type=int, default=720)
    ap.add_argument('--frame-mw', type=int, default=720); ap.add_argument('--frame-mh', type=int, default=1280)
    ap.add_argument('--portrait-scale', type=float, default=1.5)
    ap.add_argument('--soften', type=float, default=0.6, help='σ смягчения кадров в движении (0 — выкл.)')
    ap.add_argument('--frames', type=int, default=96); ap.add_argument('--fps', type=int, default=24)
    ap.add_argument('--alive-seconds', type=float, default=6); ap.add_argument('--intro-seconds', type=float, default=5)
    ap.add_argument('--q-hero', type=int, default=80); ap.add_argument('--q-frames', type=int, default=56)
    ap.add_argument('--crf-hero', type=int, default=24); ap.add_argument('--crf-intro', type=int, default=26)
    ap.add_argument('--label-px', type=float, default=15); ap.add_argument('--label-min', type=float, default=13)
    ap.add_argument('--qline', type=float, default=2.4)
    ap.add_argument('--no-video', action='store_true')
    ap.add_argument('--timing', default='', help='тайминги «нырка», напр. q0=0.55,a0=0.73 (см. TIMING в коде)')
    a = ap.parse_args()
    a.T = dict(TIMING)
    for kv in filter(None, (s.strip() for s in a.timing.split(','))):
        k, v = kv.split('='); a.T[k.strip()] = float(v)
    parts = set(p.strip() for p in a.only.split(','))
    if 'og' in parts and not os.path.exists(os.path.join(a.out, 'hero-alive.webp')): parts.add('hero')
    os.makedirs(a.out, exist_ok=True)
    cache = Cache(a.cache, offline=a.offline)
    scene = Scene(a, cache)
    t0 = time.time(); alive = None
    sts = [Story(scene, a, a.frame_w, a.frame_h, False), Story(scene, a, a.frame_mw, a.frame_mh, True)]
    bbs = {}
    if 'hero' in parts:
        hb = hero_bb(scene, a); bbs = dict(ln=hb, q=hb, a=hb)
    if 'story' in parts:
        for key, bb in story_bbs(sts, a).items():
            bbs[key] = union_bb([bb, bbs[key]]) if key in bbs else bb
    scene.load(bbs)
    if 'story' in parts:
        make_story(scene, a.out, a, sts)
    if 'hero' in parts or 'og' in parts:
        alive, bare = make_hero(scene, a.out, a) if 'hero' in parts or not os.path.exists(os.path.join(a.out, 'hero-alive.webp')) else \
            (np.asarray(Image.open(os.path.join(a.out, 'hero-alive.webp')).convert('RGB'), np.float32) / 255, None)
    if 'og' in parts and alive is not None:
        make_og(a.out, alive, a)
    stamp = os.path.join(a.out, 'hero.json')       # по времени hero.json /preview строит ?v= для всех медиа —
    if os.path.exists(stamp): os.utime(stamp, None)  # обновляем и при --only story/og, чтобы кэш браузеров сбросился  # noqa: E701
    log('готово за %.0f с → %s' % (time.time() - t0, a.out))


if __name__ == '__main__':
    main()
