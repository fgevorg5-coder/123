#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_space_media.py — «космические» сцены превью-страницы из двух видео.

  orbit/     спутник (МКС) на фоне Земли: кадры WebP для прокрутки + manifest.json
             (число кадров, размер, рамка спутника на каждом кадре — для наведения курсора)
  astro/     космонавт подходит к камере: кадры 16:9;  astro-m/ — 9:16 для телефона (+ manifest.json с рамкой)
  astro-loop.mp4 / astro-loop-m.mp4 — он стоит и машет рукой: бесшовная петля без звука,
             её первый кадр = последний кадр подхода (переход незаметен)

Длина петли подбирается сама (в окне --loop-min…--loop-max): конец петли — кадр, больше всего похожий
на её начало, плюс короткий перекрёстный переход (--xfade). Звук убирается, шум слегка подавляется (hqdn3d),
цвет выравнивается (контраст, виньетка).

Пример:
  python3 tools/preview/make_space_media.py --orbit iss.mp4 --astro astronaut.mp4 --out static/preview/media
"""
import argparse, json, math, os, subprocess, sys, time

import cv2
import numpy as np
from PIL import Image


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,r_frame_rate', '-of', 'json', path], capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                               capture_output=True, text=True, check=True).stdout.strip())
    return int(s['width']), int(s['height']), float(n) / float(d), dur


def frames(path, W, H, vf='', gray=False):
    """Кадры видео по порядку (numpy uint8) через ffmpeg; vf — фильтры до масштабирования в W×H."""
    f = (vf + ',' if vf else '') + 'scale=%d:%d:flags=lanczos' % (W, H)
    fmt, ch = ('gray', 1) if gray else ('rgb24', 3)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', path, '-an', '-vf', f, '-f', 'rawvideo', '-pix_fmt', fmt, '-'],
                         stdout=subprocess.PIPE)
    n = W * H * ch
    try:
        while True:
            b = p.stdout.read(n)
            if len(b) < n: break
            yield np.frombuffer(b, np.uint8).reshape((H, W) if gray else (H, W, 3))
    finally:
        if p.poll() is None: p.kill()          # дочитали не до конца — без «Broken pipe» в журнале
        p.stdout.close(); p.wait()


def vignette(W, H, s):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
    return (1 - s * d ** 2.2)[..., None]


def grade(rgb, vig, contrast=1.05, sat=1.0, lift=0.0):
    x = rgb.astype(np.float32) / 255
    if sat != 1.0:
        l = (x * np.float32([0.299, 0.587, 0.114])).sum(-1, keepdims=True); x = l + (x - l) * sat
    x = ((x - 0.5) * contrast + 0.5 + lift) * vig
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def webp(rgb, path, q):
    Image.fromarray(rgb).save(path, 'WEBP', quality=q, method=6)


class Encoder:
    def __init__(self, path, W, H, fps, crf):
        self.p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H),
                                   '-r', '%g' % fps, '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', str(crf),
                                   '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], stdin=subprocess.PIPE)
        self.path = path

    def write(self, rgb):
        self.p.stdin.write(np.ascontiguousarray(rgb).tobytes())

    def close(self):
        self.p.stdin.close()
        if self.p.wait() != 0: raise RuntimeError('ffmpeg: ошибка кодирования ' + self.path)


def clean_dir(d):
    os.makedirs(d, exist_ok=True)
    for fn in os.listdir(d):
        if fn.startswith('f_') and fn.endswith('.webp'): os.remove(os.path.join(d, fn))


def smooth_boxes(boxes, k=5):
    b = np.array(boxes, np.float64); out = b.copy()
    for i in range(len(b)):
        out[i] = np.median(b[max(0, i - k // 2):i + k // 2 + 1], 0)
    return out


def pad_box(b, px, py):
    return [max(0.0, b[0] - px), max(0.0, b[1] - py), min(1.0, b[2] + px), min(1.0, b[3] + py)]


# ───────────────────────── спутник ─────────────────────────
def iss_box(rgb):
    """Рамка станции по солнечным панелям (насыщенно-синие); крупный план — почти весь кадр."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    m = ((hsv[..., 0] > 100) & (hsv[..., 0] < 125) & (hsv[..., 1] > 170) & (hsv[..., 2] > 150)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    ys, xs = np.nonzero(m); H, W = m.shape
    if len(xs) < 0.02 * W * H: return [0.06, 0.08, 0.94, 0.92]
    x0, x1 = np.percentile(xs, [1, 99]) / W; y0, y1 = np.percentile(ys, [1, 99]) / H
    return [float(x0), float(y0), float(x1), float(y1)]


def make_orbit(a):
    sw, sh, fps, dur = probe(a.orbit)
    t1 = min(dur - 1.5 / fps, a.orbit_to or dur)
    i0, i1 = int(round(a.orbit_from * fps)), int(t1 * fps)
    want = {int(round(i0 + (i1 - i0) * k / (a.orbit_frames - 1))): k for k in range(a.orbit_frames)}
    od = os.path.join(a.out, 'orbit'); clean_dir(od)
    W, H = a.w, a.h; vig = vignette(W, H, 0.22); boxes = [None] * a.orbit_frames; size = 0
    log('ОРБИТА: %s → %d кадров %d×%d (%.1f–%.1f с)' % (os.path.basename(a.orbit), a.orbit_frames, W, H, i0 / fps, i1 / fps))
    for i, fr in enumerate(frames(a.orbit, W, H, a.denoise)):
        if i in want:
            k = want[i]; g = grade(fr, vig, 1.04, 1.02)
            p = os.path.join(od, 'f_%04d.webp' % (k + 1)); webp(g, p, a.q); size += os.path.getsize(p)
            boxes[k] = iss_box(fr)
        if i >= i1: break
    if any(b is None for b in boxes): raise RuntimeError('видео спутника короче, чем ожидалось')
    hot = [pad_box([round(v, 3) for v in b], 0.02, 0.03) for b in smooth_boxes(boxes)]
    meta = dict(count=a.orbit_frames, w=W, h=H, hot=[[round(v, 3) for v in b] for b in hot])
    with open(os.path.join(od, 'manifest.json'), 'w') as f: json.dump(meta, f, separators=(',', ':'))
    log('  orbit/: %.1f МБ' % (size / 1e6))


# ───────────────────────── космонавт ─────────────────────────
def astro_box(rgb):
    """Рамка космонавта: светлый малонасыщенный скафандр на оранжевом фоне."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    m = ((hsv[..., 1] < 195) & (hsv[..., 2] > 165)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((17, 17), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2: return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA])); x, y, w, h, _ = st[i]; H, W = m.shape
    return [x / W, y / H, (x + w) / W, (y + h) / H]


def make_astro(a):
    sw, sh, fps, dur = probe(a.astro)
    i_end = int(round(a.astro_arrive * fps)); X = max(2, int(round(a.xfade * fps)))
    # 1) длина петли: кадр в окне [loop_min, loop_max], наиболее похожий на начало петли
    small = [f.astype(np.float32) for f in frames(a.astro, 160, 90, gray=True)]
    lo, hi = i_end + int(a.loop_min * fps), min(len(small) - 1, i_end + int(a.loop_max * fps))
    ref = small[i_end]
    diff = [float(np.abs(small[j] - ref).mean()) for j in range(lo, hi + 1)]
    D = lo + int(np.argmin(diff)) - i_end           # петля: кадры i_end … i_end+D−1, затем снова i_end
    log('КОСМОНАВТ: подход 0–%.1f с, петля %.1f–%.1f с (%.1f с, разница стыка %.1f/255)' %
        (i_end / fps, i_end / fps, (i_end + D) / fps, D / fps, min(diff)))
    want = {int(round(i_end * k / (a.astro_frames - 1))): k for k in range(a.astro_frames)}
    sets = [('astro', 'astro-loop.mp4', a.w, a.h, None), ('astro-m', 'astro-loop-m.mp4', a.mw, a.mh, 'crop')]
    crop_x = None
    for folder, loop_name, W, H, mode in sets:
        od = os.path.join(a.out, folder); clean_dir(od)
        vf = a.denoise
        if mode == 'crop':
            cw = int(round(sh * W / H / 2)) * 2
            vf = (vf + ',' if vf else '') + 'crop=%d:%d:%d:0' % (cw, sh, crop_x)
        vig = vignette(W, H, 0.25)
        enc = None if a.no_video else Encoder(os.path.join(a.out, loop_name), W, H, fps, a.crf)
        boxes = [None] * a.astro_frames; part = {}; loop_boxes = []; size = 0
        for i, fr in enumerate(frames(a.astro, W, H, vf)):
            g = None
            if i in want:
                k = want[i]; g = grade(fr, vig, 1.05, 0.97)
                p = os.path.join(od, 'f_%04d.webp' % (k + 1)); webp(g, p, a.q); size += os.path.getsize(p)
                boxes[k] = astro_box(fr)
            if i_end - X <= i < i_end:                  # кадры перед началом петли: в них плавно уходит её конец
                part[i - (i_end - X)] = grade(fr, vig, 1.05, 0.97) if g is None else g
            if i_end <= i < i_end + D:
                if (i - i_end) % 6 == 0:
                    b = astro_box(fr)
                    if b: loop_boxes.append(b)
                if enc is not None:
                    g = grade(fr, vig, 1.05, 0.97) if g is None else g
                    j = i - (i_end + D - X)
                    if j >= 0:                          # последние X кадров плавно переходят в кадры перед началом
                        w = (j + 1) / (X + 1)
                        g = (g.astype(np.float32) * (1 - w) + part[j].astype(np.float32) * w + 0.5).astype(np.uint8)
                    enc.write(g)
            if i >= i_end + D: break
        if enc is not None: enc.close()
        last = None
        for k in range(a.astro_frames):           # где фигура не нашлась — рамка соседнего кадра
            if boxes[k] is None: boxes[k] = last
            last = boxes[k]
        boxes = [b or [0.35, 0.1, 0.65, 0.95] for b in boxes]
        sb = smooth_boxes(boxes)
        hot = [pad_box(b, 0.03 if mode is None else 0.06, 0.02) for b in sb]
        lb = np.array(loop_boxes) if loop_boxes else np.array([sb[-1]])
        lhot = pad_box([float(np.percentile(lb[:, 0], 10)), float(np.percentile(lb[:, 1], 10)),
                        float(np.percentile(lb[:, 2], 90)), float(np.percentile(lb[:, 3], 90))], 0.03 if mode is None else 0.06, 0.02)
        meta = dict(count=a.astro_frames, w=W, h=H, hot=[[round(v, 3) for v in b] for b in hot],
                    loop=None if a.no_video else loop_name, loop_hot=[round(v, 3) for v in lhot], loop_s=round(D / fps, 2))
        with open(os.path.join(od, 'manifest.json'), 'w') as f: json.dump(meta, f, separators=(',', ':'))
        vs = os.path.getsize(os.path.join(a.out, loop_name)) / 1e6 if enc is not None else 0
        log('  %s/: %d кадров %d×%d, %.1f МБ; %s: %.1f МБ' % (folder, a.astro_frames, W, H, size / 1e6, loop_name, vs))
        if mode is None:                          # кадрирование для телефона — по центру фигуры
            cxs = [((b[0] + b[2]) / 2) for b in sb[len(sb) // 2:]] + [((b[0] + b[2]) / 2) for b in lb]
            cw = int(round(sh * a.mw / a.mh / 2)) * 2
            crop_x = int(min(sw - cw, max(0, float(np.median(cxs)) * sw - cw / 2)))


def main():
    ap = argparse.ArgumentParser(description='Кадры «Орбита» и «Посадка» для превью-страницы из двух видео')
    ap.add_argument('--orbit', help='видео спутника (МКС на фоне Земли)')
    ap.add_argument('--astro', help='видео космонавта (идёт к камере, потом стоит)')
    ap.add_argument('--out', default='static/preview/media')
    ap.add_argument('--w', type=int, default=1280); ap.add_argument('--h', type=int, default=720)
    ap.add_argument('--mw', type=int, default=540); ap.add_argument('--mh', type=int, default=960)
    ap.add_argument('--orbit-frames', type=int, default=72)
    ap.add_argument('--orbit-from', type=float, default=0.0); ap.add_argument('--orbit-to', type=float, default=0.0)
    ap.add_argument('--astro-frames', type=int, default=72)
    ap.add_argument('--astro-arrive', type=float, default=9.4, help='секунда, когда космонавт подошёл и остановился')
    ap.add_argument('--loop-min', type=float, default=7.5); ap.add_argument('--loop-max', type=float, default=9.5)
    ap.add_argument('--xfade', type=float, default=0.4, help='перекрёстный переход на стыке петли, с')
    ap.add_argument('--q', type=int, default=52, help='качество WebP')
    ap.add_argument('--crf', type=int, default=27, help='качество петли H.264 (меньше — лучше)')
    ap.add_argument('--denoise', default='hqdn3d=1.5:1.5:3:3', help='фильтр ffmpeg до масштабирования («» — выкл.)')
    ap.add_argument('--no-video', action='store_true')
    a = ap.parse_args()
    if not a.orbit and not a.astro: ap.error('нужно --orbit и/или --astro')
    os.makedirs(a.out, exist_ok=True); t0 = time.time()
    if a.orbit: make_orbit(a)
    if a.astro: make_astro(a)
    stamp = os.path.join(a.out, 'hero.json')        # /preview строит ?v= медиа по времени hero.json
    if os.path.exists(stamp): os.utime(stamp, None)
    log('готово за %.0f с → %s' % (time.time() - t0, a.out))


if __name__ == '__main__':
    main()
