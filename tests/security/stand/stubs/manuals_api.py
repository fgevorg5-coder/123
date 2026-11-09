"""СТЕНД: заглушка manuals_api (настоящий модуль в поставку не входит и не меняется).
Данные в памяти — как на боевом скриншоте (11 гайдов) + вторая группа с PDF/DOC,
чтобы проверить вёрстку. Админ-операции работают в памяти до перезапуска стенда."""
import io
from datetime import datetime, timedelta
from fastapi import APIRouter, Request, HTTPException, UploadFile, File
from fastapi.responses import Response


def _pdf_bytes(title):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    try:
        pdfmetrics.registerFont(TTFont('LS', '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf'))
        fn = 'LS'
    except Exception:
        fn = 'Helvetica'
    b = io.BytesIO(); c = canvas.Canvas(b, pagesize=A4)
    c.setFont(fn, 18); c.drawString(60, 780, title[:60])
    c.setFont(fn, 11)
    for i, t in enumerate(['1. Общие положения', '2. Требования к оформлению', '3. Масштаб и легенда', '4. Подписи и штампы']):
        c.drawString(60, 740 - i * 22, t)
    c.showPage(); c.save()
    return b.getvalue()


_HTML = """<h1>{title}</h1>
<p><strong>Назначение.</strong> Пошаговая инструкция для сотрудников ОДЗиМЛ. Перед началом убедитесь, что снимки
загружены в рабочую папку проекта, а система координат совпадает с картографической основой.</p>
<h2>1. Подготовка данных</h2>
<p>Откройте программу и создайте новый проект. Проверьте, что у всех снимков одинаковое пространственное разрешение
и набор каналов. Для мозаики используйте снимки одной даты съёмки.</p>
<ul><li>снимки в формате IMG или GeoTIFF;</li><li>контур объекта (SHP) в той же системе координат;</li><li>не менее 10 ГБ свободного места на диске.</li></ul>
<h2>2. Настройка параметров</h2>
<p>В окне параметров выберите метод <em>Histogram Matching</em> и отметьте «Use Illumination Equalizing».
Значения по умолчанию подходят для большинства лесхозов.</p>
<table><thead><tr><th>Параметр</th><th>Значение</th><th>Комментарий</th></tr></thead>
<tbody><tr><td>Метод</td><td>Histogram Matching</td><td>для снимков одной даты</td></tr>
<tr><td>Размер ячейки</td><td>0,5 м</td><td>как у исходных снимков</td></tr>
<tr><td>Формат вывода</td><td>IMG</td><td>затем экспорт в GeoTIFF</td></tr></tbody></table>
<h2>3. Запуск и проверка результата</h2>
<p>Нажмите «Run» и дождитесь окончания обработки. Откройте результат и проверьте швы между снимками
при масштабе 1:2 000.</p>
<blockquote>Если на стыках видны ступеньки яркости — повторите шаг 2 с включённым выравниванием освещённости.</blockquote>
<h3>3.1. Типичные ошибки</h3>
<ol><li>Разные системы координат снимков — перепроецируйте заранее.</li><li>Нет пирамид — постройте их перед мозаикой.</li><li>Мало места на диске — очистите временную папку.</li></ol>
<h2>4. Сохранение</h2>
<p>Сохраните результат в папку <code>Результаты\\Мозаика</code> и сообщите руководителю группы.</p>"""


def build_router(base_dir=None, templates=None, require_admin=None, verify_csrf=None,
                 is_admin=None, get_csrf_token=None, logger=None, **_k):
    r = APIRouter()
    now = datetime.now()
    D = lambda d: (now - timedelta(days=d)).strftime('%Y-%m-%d %H:%M:%S')
    g1 = [
        ('Гайд 1 «Цветокоррекция мозаики снимков в ERDAS MosaicPro».docx', 1782579, 26),
        ('Гайд 2 «Формирование проекта в ArcMap — буферные зоны населённых пунктов и садовых товариществ».docx', 3984588, 26),
        ('Гайд 3 «Импорт снимков TIFF в формат IMG в ERDAS IMAGINE».docx', 545792, 26),
        ('Гайд 4 «Синтез каналов снимка Sentinel-2 в ENVI Classic».docx', 3565158, 26),
        ('Гайд 5 «Настройка слоёв ЗИС в проекте ArcMap».docx', 2726297, 26),
        ('Гайд 6 — Оформление слоёв ВОЗ, ПП и Lots в ArcMap.docx', 628736, 21),
        ('Гайд 7 — Создание схемы покрытия снимками и отбор листов сетки.docx', 4928307, 21),
        ('Гайд 8 — Подготовка и проверка рамок печати в ArcMap.docx', 818176, 21),
        ('Гайд 9 — Сохранение RGB-синтеза снимков в ERDAS IMAGINE.docx', 968704, 21),
        ('Гайд 10 — Обрезка растра по контуру и экспорт в GeoTIFF в Global Mapper.docx', 841728, 21),
        ('Гайд 11 — Настройка RGB-синтеза и контраста снимка в ERDAS IMAGINE.docx', 4404019, 5),
    ]
    g2 = [
        ('Требования к оформлению картографических материалов.pdf', 1258291, 60),
        ('Шаблон акта приёмки снимков.doc', 90112, 90),
    ]
    def mk(prefix, rows):
        out = []
        for i, (n, s, d) in enumerate(rows, 1):
            ext = '.' + n.rsplit('.', 1)[1].lower()
            out.append({'id': f'{prefix}f{i:02d}', 'name': n, 'ext': ext, 'size': s, 'uploaded': D(d), 'ver': 1})
        return out
    st = {'seq': 100, 'manuals': [
        {'id': 'm1', 'title': 'Гайды по обработке снимков (ERDAS, ArcMap)', 'desc': 'Пошаговые инструкции для сотрудников ОДЗиМЛ', 'files': mk('m1', g1)},
        {'id': 'm2', 'title': 'Регламенты и шаблоны', 'desc': 'Требования к оформлению, формы актов', 'files': mk('m2', g2)},
    ], 'blobs': {}}

    def adm(request):
        if require_admin:
            require_admin(request)
        if verify_csrf and request.method not in ('GET', 'HEAD'):
            verify_csrf(request)

    def find(fid):
        for m in st['manuals']:
            for f in m['files']:
                if f['id'] == fid:
                    return m, f
        raise HTTPException(404, 'Файл не найден')

    def mfind(mid):
        for m in st['manuals']:
            if m['id'] == mid:
                return m
        raise HTTPException(404, 'Методичка не найдена')

    @r.get('/manuals')
    def page(request: Request):
        return templates.TemplateResponse(request=request, name='manuals.html', context={
            'is_admin': bool(is_admin and is_admin(request)),
            'csrf_token': get_csrf_token(request) if get_csrf_token else ''})

    @r.get('/api/manuals')
    def lst():
        return {'manuals': st['manuals'], 'limits': {'max_mb': 200}}

    @r.get('/api/manuals/files/{fid}/html')
    def html(fid: str):
        m, f = find(fid)
        if f['ext'] != '.docx':
            raise HTTPException(415, 'Только DOCX')
        t = f['name'].rsplit('.', 1)[0]
        return {'html': _HTML.format(title=t.replace('<', '&lt;'))}

    def raw_bytes(f):
        if f['id'] in st['blobs']:
            return st['blobs'][f['id']]
        if f['ext'] == '.pdf':
            return _pdf_bytes(f['name'].rsplit('.', 1)[0])
        return b'PK\x03\x04 stand placeholder'

    @r.get('/api/manuals/files/{fid}/raw')
    def raw(fid: str):
        m, f = find(fid)
        ct = {'.pdf': 'application/pdf', '.doc': 'application/msword'}.get(f['ext'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        return Response(raw_bytes(f), media_type=ct)

    @r.get('/api/manuals/files/{fid}/download')
    def dl(fid: str):
        m, f = find(fid)
        from urllib.parse import quote
        return Response(raw_bytes(f), media_type='application/octet-stream',
                        headers={'Content-Disposition': "attachment; filename*=UTF-8''" + quote(f['name'])})

    # /api/manuals-editions/* — обслуживает настоящий manuals_editor_api.py (v20.10)

    # ── админ (в памяти) ──
    @r.post('/api/admin/manuals')
    async def create(request: Request):
        adm(request); b = await request.json()
        st['seq'] += 1
        m = {'id': f"m{st['seq']}", 'title': (b.get('title') or 'Без названия')[:200], 'desc': (b.get('desc') or '')[:500], 'files': []}
        st['manuals'].append(m)
        return {'ok': True, 'manual': m}

    @r.patch('/api/admin/manuals/{mid}')
    async def patch(mid: str, request: Request):
        adm(request); b = await request.json(); m = mfind(mid)
        if 'title' in b: m['title'] = (b['title'] or m['title'])[:200]
        if 'desc' in b: m['desc'] = (b['desc'] or '')[:500]
        return {'ok': True, 'manual': m}

    @r.delete('/api/admin/manuals/{mid}')
    def delete(mid: str, request: Request):
        adm(request); m = mfind(mid); st['manuals'].remove(m)
        return {'ok': True}

    @r.post('/api/admin/manuals/{mid}/move')
    async def move(mid: str, request: Request):
        adm(request); b = await request.json(); L = st['manuals']; m = mfind(mid); i = L.index(m); j = i + (1 if int(b.get('dir', 0)) > 0 else -1)
        if 0 <= j < len(L): L[i], L[j] = L[j], L[i]
        return {'ok': True}

    @r.post('/api/admin/manuals/files/{fid}/move')
    async def fmove(fid: str, request: Request):
        adm(request); b = await request.json(); m, f = find(fid); L = m['files']; i = L.index(f); j = i + (1 if int(b.get('dir', 0)) > 0 else -1)
        if 0 <= j < len(L): L[i], L[j] = L[j], L[i]
        return {'ok': True}

    @r.patch('/api/admin/manuals/files/{fid}')
    async def frename(fid: str, request: Request):
        adm(request); b = await request.json(); m, f = find(fid)
        name = (b.get('name') or '').strip()
        if name:
            if not name.lower().endswith(f['ext']): name += f['ext']
            f['name'] = name[:240]
        return {'ok': True, 'file': f}

    @r.delete('/api/admin/manuals/files/{fid}')
    def fdelete(fid: str, request: Request):
        adm(request); m, f = find(fid); m['files'].remove(f); st['blobs'].pop(fid, None)
        return {'ok': True}

    @r.post('/api/admin/manuals/{mid}/files')
    async def upload(mid: str, request: Request, files: list[UploadFile] = File(...)):
        adm(request); m = mfind(mid); out = []
        for uf in files:
            data = await uf.read(); st['seq'] += 1
            ext = '.' + (uf.filename or 'x.pdf').rsplit('.', 1)[-1].lower()
            if ext not in ('.pdf', '.doc', '.docx'): raise HTTPException(415, 'Только PDF и Word')
            f = {'id': f"u{st['seq']}", 'name': uf.filename, 'ext': ext, 'size': len(data), 'uploaded': datetime.now().strftime('%Y-%m-%d %H:%M:%S'), 'ver': 1}
            st['blobs'][f['id']] = data; m['files'].append(f); out.append(f)
        return {'ok': True, 'files': out}

    @r.post('/api/admin/manuals/files/{fid}/replace')
    async def replace(fid: str, request: Request, file: UploadFile = File(...)):
        adm(request); m, f = find(fid); data = await file.read()
        st['blobs'][fid] = data; f['size'] = len(data); f['ver'] = int(f.get('ver') or 1) + 1
        f['uploaded'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        return {'ok': True, 'file': f}

    return r
