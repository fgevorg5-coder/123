import re
def hex2rgb(h):
    h = h.strip().lstrip('#')
    if len(h) == 3: h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def rgba(s):
    s = s.strip()
    if s.startswith('#'): return hex2rgb(s) + (1.0,)
    m = re.match(r'rgba?\(([^)]*)\)', s)
    if m:
        p = re.split(r'[\s,/]+', m.group(1).strip())
        a = float(p[3]) if len(p) > 3 else 1.0
        return (int(p[0]), int(p[1]), int(p[2]), a)
    m = re.match(r'linear-gradient', s)
    if m:
        cols = re.findall(r'#[0-9a-fA-F]{6}', s)
        return hex2rgb(cols[0]) + (1.0,)
    raise ValueError(s)
def blend(fg, bg):
    a = fg[3] if len(fg) > 3 else 1
    return tuple(round(fg[i]*a + bg[i]*(1-a)) for i in range(3))
def lum(c):
    def ch(v):
        v /= 255
        return v/12.92 if v <= 0.03928 else ((v+0.055)/1.055)**2.4
    return 0.2126*ch(c[0]) + 0.7152*ch(c[1]) + 0.0722*ch(c[2])
def cr(a, b):
    la, lb = lum(a), lum(b)
    if la < lb: la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)
