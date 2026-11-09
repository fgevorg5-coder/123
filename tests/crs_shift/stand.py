# Стенд «Смена СК → Переместить»: panel-crs.js + OpenLayers + заглушки /api/crs/* и /api/crs-shift/*.
# Тестовые результаты конвертации (создаются сами в _work/crs_shift/fixtures):
#   0 — «пер. Стахановский (оз).tif» EPSG:3857, ModelPixelScale+ModelTiepoint, .tfw .tfwx .prj (как у пользователя)
#   1 — plan_utm.tif UTM 35N, ModelTransformation (поворот 5°), .tfw .prj .tif.aux.xml .tif.ovr
#   2 — kvartal.shp (2 полигона, EPSG:3857) — регрессия перемещения SHP
#   3 — ortho_big.tif — «голый» BigTIFF EPSG:4326 (только GeoKeys, без .prj), отдаётся не zip-ом
#   4 — bad_world.tif — EPSG:3857, .tfw + «.tfwx» не в формате world-файла (должен быть исключён, сохранение не падает)
# [v20.7] растры сохраняются через настоящие маршруты /api/crs-shift/raster/… из georef_api.py (подключены после «чужих»
#   /api/crs-shift/{jid}/{idx}, как crs_shift.py на портале); SHP — по-прежнему в заглушку crs_shift.py.
# Запуск: python3 stand.py [порт]   (GEO_DIR — папка geoservice новой версии)
import os, sys, io, json, math, struct, zipfile, subprocess, time
from PIL import Image, ImageDraw, TiffImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.environ.get('GEO_DIR') or os.path.join(HERE, '..', '..', 'geoservice')
STATIC = os.path.join(GEO, 'static')
WORK = os.path.join(os.environ.get('WORK_DIR') or os.path.join(HERE, '..', '_work'), 'crs_shift')
FX = os.path.join(WORK, 'fixtures'); UP = os.path.join(WORK, 'uploads')
os.makedirs(FX, exist_ok=True); os.makedirs(UP, exist_ok=True)
JSZIP = os.environ.get('JSZIP_JS') or next((p for p in ('/vercel/sandbox/node_modules/jszip/dist/jszip.min.js',
        os.path.join(HERE, '..', '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js')) if os.path.isfile(p)), '')
PROJ4_LOCAL = os.environ.get('PROJ4_JS', '')        # node-копия proj4 для расчёта рамки UTM (иначе — встроенная формула)

R = 6378137.0
def merc(lon, lat): return (R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
def unmerc(x, y): return (math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2))

WKT3857 = ('PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
           'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],'
           'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]')
WKTUTM = ('PROJCS["WGS_1984_UTM_Zone_35N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],'
          'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],'
          'PARAMETER["Central_Meridian",27.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]')

def utm_inv(E, N, lon0=27.0, k0=0.9996):   # обратная поперечная Меркатора (WGS-84), точность ~мм
    a, f = 6378137.0, 1 / 298.257223563; e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    x, y = E - 500000.0, N
    M = y / k0; mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    C1 = ep2 * math.cos(p1) ** 2; T1 = math.tan(p1) ** 2; N1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    R1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5; D = x / (N1 * k0)
    lat = p1 - (N1 * math.tan(p1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
                                          + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720)
    lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / math.cos(p1)
    return lon0 + math.degrees(lon), math.degrees(lat)

def picture(w, h, rgb, label):
    im = Image.new('RGB', (w, h), rgb); d = ImageDraw.Draw(im)
    for x in range(0, w, 40): d.line([(x, 0), (x, h)], fill=(255, 255, 255))
    for y in range(0, h, 40): d.line([(0, y), (w, y)], fill=(255, 255, 255))
    d.rectangle([0, 0, w - 1, h - 1], outline=(20, 20, 20), width=4)
    d.ellipse([w // 2 - 9, h // 2 - 9, w // 2 + 9, h // 2 + 9], fill=(230, 0, 0)); d.text((10, 10), label, fill=(0, 0, 0))
    return im

def geotiff(path, im, tags):
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    for tag, (typ, val) in tags.items():
        ifd.tagtype[tag] = typ; ifd[tag] = val
    im.save(path, format='TIFF', tiffinfo=ifd)

def bigtiff(path, im, tags):               # минимальный BigTIFF (1 полоса, без сжатия) + свои теги
    w, h = im.size; data = im.tobytes(); spp = len(im.getbands())
    base = {256: (16, [w]), 257: (16, [h]), 258: (3, [8] * spp), 259: (3, [1]), 262: (3, [1 if spp == 1 else 2]),
            273: (16, [0]), 277: (3, [spp]), 278: (16, [h]), 279: (16, [len(data)]), 284: (3, [1])}
    base.update(tags)
    fmt = {3: 'H', 4: 'I', 12: 'd', 16: 'Q'}
    ents = sorted(base.items()); n = len(ents); ifd_off = 16; extra = ifd_off + 8 + n * 20 + 8
    for _ in range(2):
        blobs, pos, out = [], extra, []
        for tag, (typ, vals) in ents:
            b = struct.pack('<' + fmt[typ] * len(vals), *vals)
            if len(b) <= 8: out.append(struct.pack('<HHQ', tag, typ, len(vals)) + b.ljust(8, b'\0'))
            else:
                out.append(struct.pack('<HHQQ', tag, typ, len(vals), pos)); blobs.append(b + (b'\0' if len(b) % 2 else b'')); pos += len(blobs[-1])
        img_off = pos; base[273] = (16, [img_off]); ents = sorted(base.items())
    with open(path, 'wb') as f:
        f.write(b'II' + struct.pack('<HHHQ', 43, 8, 0, ifd_off) + struct.pack('<Q', n) + b''.join(out) + struct.pack('<Q', 0) + b''.join(blobs) + data)

def write_shp(stem, polys):                 # полигоны (тип 5) .shp/.shx/.dbf
    recs = []
    for ring in polys:
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        c = struct.pack('<i4d2i', 5, min(xs), min(ys), max(xs), max(ys), 1, len(ring)) + struct.pack('<i', 0) + b''.join(struct.pack('<2d', *p) for p in ring)
        recs.append(c)
    allx = [p[0] for r in polys for p in r]; ally = [p[1] for r in polys for p in r]
    def header(length_bytes):
        return struct.pack('>7i', 9994, 0, 0, 0, 0, 0, length_bytes // 2) + struct.pack('<2i4d4d', 1000, 5, min(allx), min(ally), max(allx), max(ally), 0, 0, 0, 0)
    body = b''.join(struct.pack('>2i', i + 1, len(c) // 2) + c for i, c in enumerate(recs))
    open(stem + '.shp', 'wb').write(header(100 + len(body)) + body)
    off, shx = 50, b''
    for c in recs: shx += struct.pack('>2i', off, len(c) // 2); off += 4 + len(c) // 2
    open(stem + '.shx', 'wb').write(header(100 + len(shx)) + shx)
    fields = [(b'ID', b'N', 5, 0), (b'NAME', b'C', 20, 0)]; rl = 1 + sum(f[2] for f in fields)
    hdr = struct.pack('<B3BIHH20x', 3, 124, 1, 1, len(polys), 32 + 32 * len(fields) + 1, rl)
    fd = b''.join(n.ljust(11, b'\0') + t + b'\0\0\0\0' + struct.pack('<BB', l, d) + b'\0' * 14 for n, t, l, d in fields)
    rows = b''.join(b' ' + str(i + 1).rjust(5).encode() + ('Квартал %d' % (i + 1)).encode('utf-8').ljust(20)[:20] for i in range(len(polys)))
    open(stem + '.dbf', 'wb').write(hdr + fd + b'\r' + rows + b'\x1a')
    open(stem + '.cpg', 'w').write('UTF-8')

def zip_files(path, names):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for n in names: z.write(os.path.join(FX, n), n)

def build():
    items = []
    # 0 — EPSG:3857, как «пер. Стахановский (оз).tif»
    n0 = 'пер. Стахановский (оз)'; w, h, px = 320, 240, 0.6
    X0, Y0 = merc(27.6440, 53.9345); X0, Y0 = round(X0, 2), round(Y0, 2)
    im = picture(w, h, (120, 200, 140), 'STAKHANOVSKY 3857')
    gk3857 = (3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857])
    geotiff(os.path.join(FX, n0 + '.tif'), im, {33550: (12, (px, px, 0.0)), 33922: (12, (0.0, 0.0, 0.0, X0, Y0, 0.0)), 34735: gk3857})
    open(os.path.join(FX, n0 + '.tfw'), 'w').write('%.10f\n0.0000000000\n0.0000000000\n%.10f\n%.10f\n%.10f\n' % (px, -px, X0 + px / 2, Y0 - px / 2))
    open(os.path.join(FX, n0 + '.tfwx'), 'w').write('%.15f\r\n0.000000000000000\r\n0.000000000000000\r\n%.15f\r\n%.15f\r\n%.15f\r\n' % (px, -px, X0 + px / 2, Y0 - px / 2))
    open(os.path.join(FX, n0 + '.prj'), 'w').write(WKT3857)
    im.save(os.path.join(FX, '0.png'))
    f0 = [n0 + e for e in ('.tif', '.tfw', '.tfwx', '.prj')]; zip_files(os.path.join(FX, '0.zip'), f0)
    items.append({'ok': True, 'kind': 'raster', 'name': n0 + '.tif', 'src': 'СК-63 C2 (EPSG:—)', 'dst': 'WGS-84 / Pseudo-Mercator (EPSG:3857)',
                  'size': [w, h], 'bands': 3, 'dtype': 'Byte', 'files': f0, 'notes': [], 'download_url': '/fx/0.zip', 'preview_url': '/fx/0.png',
                  'extent3857': [X0, Y0 - h * px, X0 + w * px, Y0]})
    # 1 — UTM 35N, ModelTransformation с поворотом, .aux.xml и .ovr
    n1 = 'plan_utm'; w, h, s, th = 400, 300, 0.5, math.radians(5)
    E0, N0 = 543900.25, 5976700.75
    a, b, d, e = s * math.cos(th), s * math.sin(th), s * math.sin(th), -s * math.cos(th)
    im = picture(w, h, (150, 170, 230), 'PLAN UTM35 rot5')
    M = (a, b, 0.0, E0, d, e, 0.0, N0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0)
    geotiff(os.path.join(FX, n1 + '.tif'), im, {34264: (12, M), 34735: (3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32635])})
    ovr = im.resize((w // 2, h // 2)); ovr.save(os.path.join(FX, n1 + '.tif.ovr'), format='TIFF')
    open(os.path.join(FX, n1 + '.tfw'), 'w').write('\n'.join('%.12f' % v for v in (a, d, b, e, E0 + a / 2 + b / 2, N0 + d / 2 + e / 2)) + '\n')
    open(os.path.join(FX, n1 + '.prj'), 'w').write(WKTUTM)
    open(os.path.join(FX, n1 + '.tif.aux.xml'), 'w').write(
        '<PAMDataset>\n  <SRS dataAxisToSRSAxisMapping="1,2">%s</SRS>\n  <GeoTransform>  %.16e,  %.16e,  %.16e,  %.16e,  %.16e,  %.16e</GeoTransform>\n'
        '  <Metadata><MDI key="AREA_OR_POINT">Area</MDI></Metadata>\n</PAMDataset>\n' % (WKTUTM.replace('"', '&quot;'), E0, a, b, N0, d, e))
    corners = [(E0 + a * i + b * j, N0 + d * i + e * j) for i, j in ((0, 0), (w, 0), (w, h), (0, h))]
    m = [merc(*utm_inv(x, y)) for x, y in corners]
    ext1 = [min(p[0] for p in m), min(p[1] for p in m), max(p[0] for p in m), max(p[1] for p in m)]
    rot = im.convert('RGBA').rotate(5, expand=True, fillcolor=(0, 0, 0, 0)); rot.save(os.path.join(FX, '1.png'))
    f1 = [n1 + x for x in ('.tif', '.tfw', '.prj', '.tif.aux.xml', '.tif.ovr')]; zip_files(os.path.join(FX, '1.zip'), f1)
    items.append({'ok': True, 'kind': 'raster', 'name': n1 + '.tif', 'src': 'СК-42 зона 5', 'dst': 'WGS 84 / UTM zone 35N (EPSG:32635)',
                  'size': [w, h], 'bands': 3, 'dtype': 'Byte', 'files': f1, 'notes': ['Пирамиды .ovr пересозданы'], 'download_url': '/fx/1.zip',
                  'preview_url': '/fx/1.png', 'extent3857': ext1})
    # 2 — SHP (регрессия)
    n2 = 'kvartal'; cx, cy = merc(27.6300, 53.9330)
    polys = [[(cx, cy), (cx, cy + 120), (cx + 150, cy + 120), (cx + 150, cy), (cx, cy)],
             [(cx + 200, cy), (cx + 200, cy + 90), (cx + 300, cy + 90), (cx + 300, cy), (cx + 200, cy)]]
    write_shp(os.path.join(FX, n2), polys); open(os.path.join(FX, n2 + '.prj'), 'w').write(WKT3857)
    gj = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'ID': i + 1},
          'geometry': {'type': 'Polygon', 'coordinates': [[list(unmerc(*p)) for p in r]]}} for i, r in enumerate(polys)]}
    json.dump(gj, open(os.path.join(FX, '2.geojson'), 'w'))
    f2 = [n2 + x for x in ('.shp', '.shx', '.dbf', '.prj', '.cpg')]; zip_files(os.path.join(FX, '2.zip'), f2)
    items.append({'ok': True, 'kind': 'vector', 'name': n2 + '.shp', 'src': 'СК-63 C2', 'dst': 'WGS-84 / Pseudo-Mercator (EPSG:3857)', 'features': 2,
                  'geom': ['Polygon'], 'files': f2, 'notes': [], 'download_url': '/fx/2.zip', 'preview': 'geojson', 'preview_url': '/fx/2.geojson'})
    # 3 — «голый» BigTIFF EPSG:4326 (без .prj): СК из GeoKeys
    n3 = 'ortho_big'; w, h, dg = 64, 48, 0.00002; L0, B0 = 27.6545, 53.9262
    im = picture(w, h, (230, 190, 120), 'BIG').convert('L')
    bigtiff(os.path.join(FX, n3 + '.tif'), im, {33550: (12, [dg, dg, 0.0]), 33922: (12, [0.0, 0.0, 0.0, L0, B0, 0.0]),
                                                 34735: (3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326])})
    im.save(os.path.join(FX, '3.png'))
    p0, p1 = merc(L0, B0 - h * dg), merc(L0 + w * dg, B0)
    items.append({'ok': True, 'kind': 'raster', 'name': n3 + '.tif', 'src': 'СК-42 гео', 'dst': 'WGS-84 географические (EPSG:4326)', 'size': [w, h],
                  'bands': 1, 'dtype': 'Byte', 'files': [n3 + '.tif'], 'notes': [], 'download_url': '/fx/' + n3 + '.tif', 'preview_url': '/fx/3.png',
                  'extent3857': [p0[0], p0[1], p1[0], p1[1]]})
    # 4 — .tfwx не world-файл
    n4 = 'bad_world'; w, h, px = 200, 150, 0.5; X4, Y4 = merc(27.6380, 53.9290); X4, Y4 = round(X4, 2), round(Y4, 2)
    im = picture(w, h, (210, 160, 200), 'BAD TFWX')
    geotiff(os.path.join(FX, n4 + '.tif'), im, {33550: (12, (px, px, 0.0)), 33922: (12, (0.0, 0.0, 0.0, X4, Y4, 0.0)), 34735: gk3857})
    open(os.path.join(FX, n4 + '.tfw'), 'w').write('%.10f\n0\n0\n%.10f\n%.10f\n%.10f\n' % (px, -px, X4 + px / 2, Y4 - px / 2))
    open(os.path.join(FX, n4 + '.tfwx'), 'w').write('<WorldFile version="2"><A>0.5</A></WorldFile>\n')
    open(os.path.join(FX, n4 + '.prj'), 'w').write(WKT3857); im.save(os.path.join(FX, '4.png'))
    f4 = [n4 + e for e in ('.tif', '.tfw', '.tfwx', '.prj')]; zip_files(os.path.join(FX, '4.zip'), f4)
    items.append({'ok': True, 'kind': 'raster', 'name': n4 + '.tif', 'src': 'СК-63 C2', 'dst': 'WGS-84 / Pseudo-Mercator (EPSG:3857)', 'size': [w, h],
                  'bands': 3, 'dtype': 'Byte', 'files': f4, 'notes': [], 'download_url': '/fx/4.zip', 'preview_url': '/fx/4.png',
                  'extent3857': [X4, Y4 - h * px, X4 + w * px, Y4]})
    zip_files(os.path.join(FX, 'all.zip'), f0 + f1 + f2 + [n3 + '.tif'] + f4)
    job = {'job_id': 'job-test-1', 'items': items, 'download_url': '/fx/all.zip', 'dst_name': 'разные'}
    json.dump(job, open(os.path.join(FX, 'job.json'), 'w'), ensure_ascii=False, indent=1)
    return job

# ── чтение тегов TIFF/BigTIFF (независимо от JS) ──
TSZ = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8}
def tiff_tags(b):
    bo = b[:2]; le = '<' if bo == b'II' else '>'
    magic = struct.unpack(le + 'H', b[2:4])[0]; big = magic == 43
    ifd = struct.unpack(le + ('Q' if big else 'I'), b[8:16] if big else b[4:8])[0]; out, k = [], 0
    while ifd and k < 64:
        cnt = struct.unpack(le + ('Q' if big else 'H'), b[ifd:ifd + (8 if big else 2)])[0]; p = ifd + (8 if big else 2); tags = {}
        for j in range(cnt):
            e = p + j * (20 if big else 12)
            tag, typ = struct.unpack(le + 'HH', b[e:e + 4]); count = struct.unpack(le + ('Q' if big else 'I'), b[e + 4:e + (12 if big else 8)])[0]
            vp = e + (12 if big else 8); size = TSZ.get(typ, 1) * count
            off = vp if size <= (8 if big else 4) else struct.unpack(le + ('Q' if big else 'I'), b[vp:vp + (8 if big else 4)])[0]
            if typ == 12: tags[tag] = (list(struct.unpack(le + 'd' * count, b[off:off + 8 * count])), off, 8 * count)
            elif typ == 3: tags[tag] = (list(struct.unpack(le + 'H' * count, b[off:off + 2 * count])), off, 2 * count)
        out.append(tags); ifd = struct.unpack(le + ('Q' if big else 'I'), b[p + cnt * (20 if big else 12):p + cnt * (20 if big else 12) + (8 if big else 4)])[0]; k += 1
    return out

def geo_of_tiff(b):
    t = tiff_tags(b)[0]
    if 33922 in t: return ('tie', t[33922][0][3], t[33922][0][4])
    if 34264 in t: return ('mt', t[34264][0][3], t[34264][0][7])
    return (None, None, None)

def world_cf(txt):
    v = [float(x) for x in txt.split() if x.strip()]
    return v[4], v[5], v[:4]

def inspect(idx, data):
    """Сравнение сохранённого ZIP сдвига с исходными файлами результата idx."""
    job = json.load(open(os.path.join(FX, 'job.json'))); it = job['items'][idx]
    z = zipfile.ZipFile(io.BytesIO(data)); names = z.namelist(); res = {'names': names, 'deltas': {}, 'errors': []}
    stem = it['name'].rsplit('.', 1)[0]
    for n in names:
        if not n.startswith(stem + '_сдвиг'): res['errors'].append('лишний/неверно названный файл: ' + n); continue
        ext = n[len(stem + '_сдвиг'):]; orig_name = stem + ext
        new = z.read(n)
        if ext == '.txt': res['txt'] = new.decode('utf-8'); continue
        orig_path = os.path.join(FX, orig_name)
        if not os.path.isfile(orig_path): res['errors'].append('нет исходного файла для ' + n); continue
        old = open(orig_path, 'rb').read()
        if ext in ('.tif', '.tif.ovr', '.tiff'):
            if len(old) != len(new): res['errors'].append(n + ': размер TIFF изменился'); continue
            k0, x0, y0 = geo_of_tiff(old); k1, x1, y1 = geo_of_tiff(new)
            allowed = []
            for tg in tiff_tags(old):
                for t in (33922, 34264):
                    if t in tg: allowed.append((tg[t][1], tg[t][1] + tg[t][2]))
            bad = [i for i in range(len(old)) if old[i] != new[i] and not any(a <= i < b for a, b in allowed)]
            if bad: res['errors'].append(n + ': изменены байты вне тегов привязки (%d), напр. @%d' % (len(bad), bad[0]))
            if k0: res['deltas'][ext + ' теги'] = [x1 - x0, y1 - y0]
            else: res['deltas'][ext + ' (нет тегов)'] = None
            if k0 == 'mt':
                m0, m1 = tiff_tags(old)[0][34264][0], tiff_tags(new)[0][34264][0]
                if any(abs(m0[i] - m1[i]) > 1e-15 for i in range(16) if i not in (3, 7)): res['errors'].append(n + ': изменены коэффициенты матрицы')
            if ext == '.tif' and not new.startswith(b'II+'):
                try:
                    pil = Image.open(io.BytesIO(new)); t2 = pil.tag_v2
                    if 33922 in t2: res['deltas']['.tif PIL'] = [t2[33922][3] - x0, t2[33922][4] - y0]
                    if 34264 in t2: res['deltas']['.tif PIL'] = [t2[34264][3] - x0, t2[34264][7] - y0]
                    if pil.tobytes() != Image.open(io.BytesIO(old)).tobytes(): res['errors'].append(n + ': изменились пиксели')
                except Exception as ex: res['errors'].append(n + ': PIL не открыл: %s' % ex)
        elif ext in ('.tfw', '.tfwx', '.tifw', '.wld'):
            c0, f0, r0 = world_cf(old.decode()); c1, f1, r1 = world_cf(new.decode())
            if r0 != r1: res['errors'].append(n + ': изменены A/B/D/E')
            if (b'\r\n' in old) != (b'\r\n' in new): res['errors'].append(n + ': сменились переводы строк')
            res['deltas'][ext] = [c1 - c0, f1 - f0]
        elif ext.endswith('.aux.xml'):
            import re
            g0 = [float(v) for v in re.search(r'<GeoTransform>([^<]*)</GeoTransform>', old.decode()).group(1).split(',')]
            g1 = [float(v) for v in re.search(r'<GeoTransform>([^<]*)</GeoTransform>', new.decode()).group(1).split(',')]
            if [g0[i] for i in (1, 2, 4, 5)] != [g1[i] for i in (1, 2, 4, 5)]: res['errors'].append(n + ': изменён масштаб/поворот GeoTransform')
            if '<SRS' not in new.decode(): res['errors'].append(n + ': пропал SRS')
            res['deltas'][ext] = [g1[0] - g0[0], g1[3] - g0[3]]
        else:
            if old != new: res['errors'].append(n + ': файл без привязки изменился')
    return res

def inspect_shp(data):
    z = zipfile.ZipFile(io.BytesIO(data)); names = z.namelist()
    shp = [n for n in names if n.endswith('.shp')][0]
    new = z.read(shp); old = open(os.path.join(FX, 'kvartal.shp'), 'rb').read()
    def pts(b):
        out, off = [], 100
        while off < len(b):
            cl = struct.unpack('>i', b[off + 4:off + 8])[0] * 2; p = off + 8
            n = struct.unpack('<i', b[p + 40:p + 44])[0]; q = p + 44 + 4
            out.append([struct.unpack('<2d', b[q + i * 16:q + i * 16 + 16]) for i in range(n)]); off += 8 + cl
        return out
    a, b = pts(old), pts(new)
    d = [[[q[0] - p[0], q[1] - p[1]] for p, q in zip(r0, r1)] for r0, r1 in zip(a, b)]
    bb0 = struct.unpack('<4d', old[36:68]); bb1 = struct.unpack('<4d', new[36:68])
    return {'names': names, 'deltas': d, 'bbox_delta': [bb1[i] - bb0[i] for i in range(4)]}

if not os.path.isfile(os.path.join(FX, 'job.json')) or os.environ.get('REBUILD'):
    build()

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, Response, RedirectResponse
app = FastAPI()
SHIFTS = {}; MODE = {'reject': 0, 'n': 0}; LOG = []

@app.get('/api/crs/status')
def crs_status(): return {'enabled': True, 'is_admin': True, 'max_upload_mb': 2048}

@app.get('/api/crs/presets')
def crs_presets():
    presets = [{'id': 'wgs84_3857', 'name': 'WGS-84 / Web Mercator (EPSG:3857)', 'group': 'wgs', 'epsg': 3857},
               {'id': 'wgs84_4326', 'name': 'WGS-84 географические (EPSG:4326)', 'group': 'wgs', 'epsg': 4326},
               {'id': 'utm35n', 'name': 'WGS-84 / UTM 35N', 'group': 'wgs', 'epsg': 32635},
               {'id': 'sk63_c2', 'name': 'СК-63 C2', 'group': 'sk63'}]
    return {'groups': [{'id': 'wgs', 'name': 'WGS-84'}, {'id': 'sk63', 'name': 'СК-63'}], 'presets': presets,
            'popular': ['wgs84_3857', 'sk63_c2'], 'datums': [{'id': 'gost2001', 'name': 'ГОСТ 51794-2001'}]}

@app.get('/api/crs/jobs/current')
def crs_current(): return {'job': json.load(open(os.path.join(FX, 'job.json')))}

@app.get('/fx/{name}')
def fx(name: str):
    p = os.path.join(FX, os.path.basename(name))
    if not os.path.isfile(p): return JSONResponse({'detail': 'nf'}, 404)
    mt = {'.zip': 'application/zip', '.png': 'image/png', '.geojson': 'application/geo+json', '.tif': 'image/tiff'}.get(os.path.splitext(p)[1], 'application/octet-stream')
    return FileResponse(p, media_type=mt, headers={'Cache-Control': 'no-store'})

@app.post('/api/crs-shift/{jid}/{idx}')
async def shift_put(jid: str, idx: int, request: Request, zip: UploadFile = File(...), geojson: UploadFile = File(...), info: str = Form(''), name: str = Form('')):
    zb = await zip.read(); gb = await geojson.read()
    LOG.append({'op': 'POST', 'idx': idx, 'size': len(zb), 'name': name, 'info': info, 'csrf': request.headers.get('x-csrftoken')})
    if MODE['reject'] == 413: return HTMLResponse('<html><body><h1>413 Request Entity Too Large</h1></body></html>', 413)
    if MODE['reject']: return JSONResponse({'detail': 'в архиве нет .shp'}, 400)
    if zb[:2] != b'PK': return JSONResponse({'detail': 'не zip'}, 400)
    gj = json.loads(gb)
    MODE['n'] += 1; n = MODE['n']
    open(os.path.join(UP, '%s_%d_%d.zip' % (jid, idx, n)), 'wb').write(zb)
    SHIFTS[(jid, idx)] = {'zip': zb, 'gj': gj, 'info': info, 'name': name, 'n': n}
    return {'download_url': '/api/crs-shift/%s/%d/zip?n=%d' % (jid, idx, n), 'preview_url': '/api/crs-shift/%s/%d/preview?n=%d' % (jid, idx, n), 'name': name}

@app.get('/api/crs-shift/{jid}')
def shift_list(jid: str):
    return {'items': {str(i): {'download_url': '/api/crs-shift/%s/%d/zip?n=%d' % (j, i, s['n']), 'preview_url': '/api/crs-shift/%s/%d/preview?n=%d' % (j, i, s['n']),
                               'name': s['name'], 'info': s['info']} for (j, i), s in SHIFTS.items() if j == jid}}

@app.get('/api/crs-shift/{jid}/{idx}/zip')
def shift_zip(jid: str, idx: int):
    s = SHIFTS.get((jid, idx))
    return Response(s['zip'], media_type='application/zip') if s else JSONResponse({'detail': 'nf'}, 404)

@app.get('/api/crs-shift/{jid}/{idx}/preview')
def shift_preview(jid: str, idx: int):
    s = SHIFTS.get((jid, idx))
    return JSONResponse(s['gj']) if s else JSONResponse({'detail': 'nf'}, 404)

@app.delete('/api/crs-shift/{jid}/{idx}')
def shift_del(jid: str, idx: int):
    LOG.append({'op': 'DELETE', 'idx': idx})
    return {'ok': SHIFTS.pop((jid, idx), None) is not None}

@app.get('/_mode')
def mode(reject: int = 0): MODE['reject'] = reject; return MODE

@app.get('/_reset')
def reset():
    SHIFTS.clear(); LOG.clear(); MODE.update(reject=0); shutil.rmtree(RSTORE, ignore_errors=True); return {'ok': True}

@app.get('/_log')
def log(): return LOG

@app.get('/_check/{idx}')
def check(idx: int):
    s = SHIFTS.get(('job-test-1', idx)) or raster_saved('job-test-1', idx)
    if not s: return {'none': True}
    r = inspect_shp(s['zip']) if idx == 2 else inspect(idx, s['zip'])
    r['gj'] = s['gj']; r['info'] = s['info']; r['name'] = s['name']
    return r

@app.get('/static/vendor/jszip.min.js')
def jszip(): return FileResponse(JSZIP, media_type='application/javascript')

@app.get('/static/{path:path}')
def static(path: str):
    p = os.path.join(STATIC, path)
    return FileResponse(p, headers={'Cache-Control': 'no-store'}) if os.path.isfile(p) else JSONResponse({'detail': 'nf'}, 404)

@app.get('/fe/{name}')
def fe(name: str):
    d = os.environ.get('FE_DIR')
    if d and os.path.isfile(os.path.join(d, os.path.basename(name))): return FileResponse(os.path.join(d, os.path.basename(name)))
    if name == 'proj4.js': return RedirectResponse('https://cdn.jsdelivr.net/npm/proj4@2.10.0/dist/proj4.js')
    return RedirectResponse('https://cdn.jsdelivr.net/npm/ol@9.2.4/dist/' + os.path.basename(name))

PAGE = r'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>crs-shift test</title>
<link rel="stylesheet" href="/fe/ol.css">
<style>html,body{margin:0;height:100%;font-family:Lato,Arial,sans-serif}#map{position:absolute;inset:0;background:#eef2ee}
#slide{position:absolute;left:0;top:0;bottom:0;width:360px;background:#fff;box-shadow:2px 0 12px rgba(0,0,0,.2);z-index:10;overflow:hidden}
.msp-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#152918;color:#fff;font-weight:800}
.msp-close{background:none;border:none;color:#fff;cursor:pointer}
#toasts{position:absolute;right:10px;bottom:10px;z-index:20;display:flex;flex-direction:column;gap:6px;max-width:460px}
#toasts div{background:#1d3b24;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.25)}#toasts div.e{background:#9b2c1f}</style>
<script>window.__errors=[];window.__toasts=[];window.addEventListener('error',function(e){__errors.push(String(e.message||e));});
window.addEventListener('unhandledrejection',function(e){__errors.push('unhandled: '+String(e.reason&&e.reason.message||e.reason));});
window.showToast=function(m,e){__toasts.push({m:String(m),e:!!e,t:Date.now()});var b=document.getElementById('toasts');if(!b)return;var d=document.createElement('div');d.className=e?'e':'';d.textContent=m;b.appendChild(d);setTimeout(function(){d.remove();},6000);};
window._staticVer='test';</script>
<script src="/fe/ol.js"></script><script src="/fe/proj4.js"></script>
</head><body><div id="map"><div id="slide"></div><div id="toasts"></div></div>
<script>
window.map=new ol.Map({target:'map',layers:[],view:new ol.View({center:ol.proj.fromLonLat([27.645,53.931]),zoom:15})});
var s=document.createElement('script');s.src='/static/panel-crs.js?v='+Date.now();s.onload=function(){window.buildCrsPanel(document.getElementById('slide'),function(){if(window._panelCleanup)window._panelCleanup();document.getElementById('slide').innerHTML='';});};
document.body.appendChild(s);
</script></body></html>'''

@app.get('/crs-test', response_class=HTMLResponse)
def page(): return PAGE

# ── [v20.7] настоящие маршруты растров из georef_api.py ──
import shutil, glob
from pathlib import Path
RSTORE = os.path.join(WORK, 'raster_store')
sys.path.insert(0, GEO)
import georef_api as _ga
app.include_router(_ga._crs_raster_router(Path(RSTORE), lambda req: None, None))

def raster_saved(jid, idx):
    for d in glob.glob(os.path.join(RSTORE, '*', jid, str(idx))):
        if os.path.isfile(os.path.join(d, 'shift.zip')):
            m = json.load(open(os.path.join(d, 'meta.json'), encoding='utf-8'))
            return {'zip': open(os.path.join(d, 'shift.zip'), 'rb').read(), 'gj': json.load(open(os.path.join(d, 'preview.geojson'), encoding='utf-8')),
                    'info': m.get('info', ''), 'name': m.get('name', ''), 'raster': True}
    return None

@app.middleware('http')
async def raster_reject(request: Request, call_next):     # отказ сервера / 413 nginx — и для маршрутов растров
    if request.method == 'POST' and request.url.path.startswith('/api/crs-shift/raster/'):
        LOG.append({'op': 'POST raster', 'path': request.url.path, 'csrf': request.headers.get('x-csrftoken')})
        if MODE['reject'] == 413: return HTMLResponse('<html><body><h1>413 Request Entity Too Large</h1></body></html>', 413)
        if MODE['reject']: return JSONResponse({'detail': 'в архиве нет .shp'}, 400)
    if request.method == 'DELETE' and request.url.path.startswith('/api/crs-shift/raster/'):
        LOG.append({'op': 'DELETE raster', 'path': request.url.path})
    return await call_next(request)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]) if len(sys.argv) > 1 else 8790, log_level='warning')
