#!/usr/bin/env python3
"""
extract_all.py - "достать абсолютно всё" из exe/dll/установщика/архива.

Дополняет exe_unpack.py:
  * overlay (данные после последней секции PE) и цифровая подпись;
  * правильные иконки (.ico), картинки BMP, таблицы строк, сведения о версии;
  * карвинг вложенных файлов по сигнатурам (zip/jar, 7z, cab, rar, gzip, PE,
    png/jpg/gif, OLE/MSI, SQLite, RIFF, OGG, PDF, Godot .pck);
  * распаковка Godot .pck (встроенного в exe или отдельного);
  * рекурсивная распаковка всех найденных архивов (zip/jar/apk/asar/7z/cab/msi/pck);
  * опись всех извлечённых файлов (00_INVENTORY.csv) и покрытие байтов исходника.
Используйте только для своих программ или там, где лицензия разрешает реверс-инжиниринг.
"""
import csv, hashlib, json, re, shutil, struct, subprocess, zipfile
from pathlib import Path

try:
    import pefile
except ImportError:
    pefile = None


def _safe(name):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name)).strip(" .") or "_"


# ---------------- определение типа по содержимому ----------------
MAGIC = [
    (b"MZ", "pe"), (b"PK\x03\x04", "zip"), (b"7z\xbc\xaf\x27\x1c", "7z"), (b"MSCF", "cab"),
    (b"Rar!\x1a\x07", "rar"), (b"\x1f\x8b\x08", "gzip"), (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole"),
    (b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"),
    (b"SQLite format 3\x00", "sqlite"), (b"RIFF", "riff"), (b"OggS", "ogg"), (b"%PDF-", "pdf"),
    (b"GDPC", "godot_pck"), (b"\x7fELF", "elf"), (b"\xca\xfe\xba\xbe", "class"),
    (b"dex\n", "dex"), (b"UnityFS", "unity_bundle"), (b"BZh", "bzip2"), (b"\xfd7zXZ\x00", "xz"),
]


def file_type(head: bytes):
    for m, t in MAGIC:
        if head.startswith(m):
            return t
    if head[:4] in (b"\x00\x00\x01\x00",):
        return "ico"
    return ""


# ---------------- PE: ресурсы, overlay, подпись ----------------
def pe_overlay_offset(pe):
    off = pe.get_overlay_data_start_offset()
    if off is None:
        return None
    # подпись Authenticode лежит в конце файла и формально тоже "overlay"
    sec = pe.OPTIONAL_HEADER.DATA_DIRECTORY[4]
    if sec.VirtualAddress and sec.VirtualAddress == off:
        return None
    return off


def dump_pe_extras(pe, data: bytes, out: Path, log):
    info, res_dir, unp = out / "01_info", out / "03_resources", out / "04_unpacked"
    for d in (info, res_dir, unp):
        d.mkdir(parents=True, exist_ok=True)

    # цифровая подпись
    sec = pe.OPTIONAL_HEADER.DATA_DIRECTORY[4]
    if sec.VirtualAddress and sec.Size:
        (info / "signature_authenticode.bin").write_bytes(data[sec.VirtualAddress + 8: sec.VirtualAddress + sec.Size])
        log("Цифровая подпись сохранена: 01_info/signature_authenticode.bin (PKCS#7, открыть: openssl pkcs7 -inform DER -print_certs)")

    # PDB-путь и прочая отладочная информация
    dbg = []
    for e in getattr(pe, "DIRECTORY_ENTRY_DEBUG", []):
        ent = getattr(e, "entry", None)
        pdb = getattr(ent, "PdbFileName", None)
        if pdb:
            dbg.append(pdb.rstrip(b"\0").decode(errors="ignore"))
    if dbg:
        (info / "pdb_paths.txt").write_text("\n".join(dbg), encoding="utf-8")

    # сведения о версии
    ver = {}
    for fi in getattr(pe, "FileInfo", []) or []:
        for entry in fi if isinstance(fi, list) else [fi]:
            for st in getattr(entry, "StringTable", []):
                for k, v in st.entries.items():
                    ver[k.decode(errors="ignore")] = v.decode(errors="ignore")
    if ver:
        (info / "version_info.json").write_text(json.dumps(ver, indent=2, ensure_ascii=False), encoding="utf-8")

    # overlay
    ov = pe_overlay_offset(pe)
    overlay = None
    if ov is not None and ov < len(data):
        end = sec.VirtualAddress if (sec.VirtualAddress and sec.VirtualAddress > ov) else len(data)
        overlay = (ov, end)
        (unp / "overlay.bin").write_bytes(data[ov:end])
        log(f"Overlay: {end - ov:,} байт после секций -> 04_unpacked/overlay.bin")

    # ресурсы: иконки, bmp, строки
    if not hasattr(pe, "DIRECTORY_ENTRY_RESOURCE"):
        return overlay
    image = pe.get_memory_mapped_image()
    icons, groups, strings = {}, [], {}
    RT = pefile.RESOURCE_TYPE
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        tid = t.struct.Id if t.name is None else None
        for r in getattr(getattr(t, "directory", None), "entries", []):
            rid = r.struct.Id if r.name is None else str(r.name)
            for lang in getattr(getattr(r, "directory", None), "entries", []):
                ds = lang.data.struct
                blob = image[ds.OffsetToData: ds.OffsetToData + ds.Size]
                if tid == RT["RT_ICON"]:
                    icons[rid] = blob
                elif tid == RT["RT_GROUP_ICON"]:
                    groups.append((rid, blob))
                elif tid == RT["RT_BITMAP"] and len(blob) >= 40:
                    hdr_size, = struct.unpack_from("<I", blob, 0)
                    bpp, = struct.unpack_from("<H", blob, 14)
                    clr_used, = struct.unpack_from("<I", blob, 32)
                    pal = (clr_used or (1 << bpp if bpp <= 8 else 0)) * 4
                    fh = b"BM" + struct.pack("<IHHI", 14 + len(blob), 0, 0, 14 + hdr_size + pal)
                    d = res_dir / "bitmaps"
                    d.mkdir(exist_ok=True)
                    (d / f"{_safe(rid)}.bmp").write_bytes(fh + blob)
                elif tid == RT["RT_STRING"] and isinstance(rid, int):
                    p = 0
                    for i in range(16):
                        if p + 2 > len(blob):
                            break
                        n, = struct.unpack_from("<H", blob, p)
                        p += 2
                        if n:
                            strings[(rid - 1) * 16 + i] = blob[p:p + n * 2].decode("utf-16le", errors="ignore")
                        p += n * 2

    # собираем настоящие .ico из RT_GROUP_ICON + RT_ICON
    if groups:
        d = res_dir / "icons"
        d.mkdir(exist_ok=True)
        for gid, g in groups:
            if len(g) < 6:
                continue
            _, _, count = struct.unpack_from("<HHH", g, 0)
            entries, images = [], []
            for i in range(count):
                o = 6 + i * 14
                if o + 14 > len(g):
                    break
                w, h, cc, rsv, planes, bc, size, nid = struct.unpack_from("<BBBBHHIH", g, o)
                img = icons.get(nid)
                if img:
                    entries.append((w, h, cc, rsv, planes, bc, len(img)))
                    images.append(img)
            off = 6 + 16 * len(entries)
            ico = struct.pack("<HHH", 0, 1, len(entries))
            for e, img in zip(entries, images):
                ico += struct.pack("<BBBBHHII", *e, off)
                off += len(img)
            (d / f"{_safe(gid)}.ico").write_bytes(ico + b"".join(images))
        log(f"Иконки: собрано {len(groups)} файлов .ico")
    if strings:
        (res_dir / "string_table.json").write_text(
            json.dumps({str(k): v for k, v in sorted(strings.items())}, indent=2, ensure_ascii=False), encoding="utf-8")
        log(f"Таблица строк: {len(strings)} строк -> 03_resources/string_table.json")
    return overlay


# ---------------- карвинг вложенных файлов ----------------
def _size_zip(data, s):
    e = data.rfind(b"PK\x05\x06", s)
    while e != -1:
        if e + 22 <= len(data):
            clen, = struct.unpack_from("<H", data, e + 20)
            return e + 22 + clen - s
        e = data.rfind(b"PK\x05\x06", s, e)
    return None


def _size_7z(data, s):
    if s + 32 > len(data):
        return None
    off, size = struct.unpack_from("<QQ", data, s + 12)
    n = 32 + off + size
    return n if s + n <= len(data) else None


def _size_cab(data, s):
    n, = struct.unpack_from("<I", data, s + 8)
    return n if 0 < n and s + n <= len(data) else None


def _size_png(data, s):
    e = data.find(b"IEND\xaeB`\x82", s)
    return e + 8 - s if e != -1 else None


def _size_jpg(data, s):
    e = data.find(b"\xff\xd9", s + 2)
    return e + 2 - s if e != -1 else None


def _size_riff(data, s):
    n, = struct.unpack_from("<I", data, s + 4)
    return n + 8 if s + n + 8 <= len(data) and data[s + 8:s + 12].isalnum() else None


def _size_sqlite(data, s):
    ps, = struct.unpack_from(">H", data, s + 16)
    ps = 65536 if ps == 1 else ps
    pages, = struct.unpack_from(">I", data, s + 28)
    n = ps * pages
    return n if 0 < n and s + n <= len(data) else None


def _size_pe(data, s):
    if not pefile:
        return None
    try:
        e_lfanew, = struct.unpack_from("<I", data, s + 0x3c)
        if data[s + e_lfanew:s + e_lfanew + 4] != b"PE\0\0":
            return None
        pe = pefile.PE(data=data[s:], fast_load=True)
        end = max([sec.PointerToRawData + sec.SizeOfRawData for sec in pe.sections] + [pe.OPTIONAL_HEADER.SizeOfHeaders])
        cert = pe.OPTIONAL_HEADER.DATA_DIRECTORY[4]
        if cert.VirtualAddress:
            end = max(end, cert.VirtualAddress + cert.Size)
        return end if s + end <= len(data) else len(data) - s
    except Exception:
        return None


def _size_pdf(data, s):
    e = data.find(b"%%EOF", s)
    return e + 5 - s if e != -1 else None


CARVERS = [
    (b"PK\x03\x04", ".zip", _size_zip), (b"7z\xbc\xaf\x27\x1c", ".7z", _size_7z), (b"MSCF\x00\x00\x00\x00", ".cab", _size_cab),
    (b"\x89PNG\r\n\x1a\n", ".png", _size_png), (b"\xff\xd8\xff\xe0", ".jpg", _size_jpg), (b"\xff\xd8\xff\xe1", ".jpg", _size_jpg),
    (b"RIFF", ".riff", _size_riff), (b"SQLite format 3\x00", ".sqlite", _size_sqlite), (b"MZ", ".exe_or_dll", _size_pe),
    (b"%PDF-", ".pdf", _size_pdf), (b"Rar!\x1a\x07", ".rar", None), (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", ".ole_msi", None),
    (b"GDPC", ".pck", None),
]


def carve(data: bytes, out: Path, log, ranges=None, skip_offsets=(0,)):
    """Ищет вложенные файлы по сигнатурам. ranges - список (start, end) где искать (по умолчанию весь файл)."""
    d = out / "04_unpacked" / "carved"
    found = []
    taken = []  # уже вырезанные диапазоны, чтобы не дробить zip на внутренние png и т.п.
    for start, end in ranges or [(0, len(data))]:
        for magic, ext, sizer in CARVERS:
            p = data.find(magic, start, end)
            while p != -1:
                if p not in skip_offsets and not any(a <= p < b for a, b in taken):
                    n = sizer(data, p) if sizer else len(data) - p
                    if n and n >= 64:
                        if ext == ".rar" or ext == ".ole_msi" or ext == ".pck":
                            n = len(data) - p  # размер неизвестен - до конца файла
                        d.mkdir(parents=True, exist_ok=True)
                        name = d / f"{p:010x}{ext}"
                        name.write_bytes(data[p:p + n])
                        found.append((p, n, name))
                        if ext in (".zip", ".7z", ".cab", ".exe_or_dll", ".sqlite"):
                            taken.append((p, p + n))
                p = data.find(magic, p + 1, end)
    if found:
        log(f"Карвинг: найдено {len(found)} вложенных файлов -> 04_unpacked/carved/")
    return found


# ---------------- Godot .pck ----------------
def extract_godot_pck(data: bytes, dest: Path, log, base=0):
    if data[base:base + 4] != b"GDPC":
        # встроенный в exe: в конце "GDPC" и перед ним u64 размер
        if data[-4:] == b"GDPC":
            size, = struct.unpack_from("<Q", data, len(data) - 12)
            base = len(data) - 12 - size
            if data[base:base + 4] != b"GDPC":
                return 0
        else:
            return 0
    ver, = struct.unpack_from("<I", data, base + 4)
    p = base + 20
    file_base, rel = 0, True  # Godot 3 (v1): смещения от начала pck
    if ver >= 2:
        flags, file_base = struct.unpack_from("<IQ", data, p)
        p += 12
        if flags & 1:
            log("Godot .pck: каталог зашифрован (нужен ключ шифрования проекта) - пропуск")
            return 0
        rel = ver >= 3 or bool(flags & 2)  # PACK_REL_FILEBASE; в 4.0-4.2 file_base абсолютный
    if ver >= 3:
        dir_off, = struct.unpack_from("<Q", data, p)
        p = base + dir_off
    else:
        p += 16 * 4
    count, = struct.unpack_from("<I", data, p)
    p += 4
    n = 0
    for _ in range(count):
        ln, = struct.unpack_from("<I", data, p)
        p += 4
        path = data[p:p + ln].rstrip(b"\0").decode(errors="ignore")
        p += ln
        off, size = struct.unpack_from("<QQ", data, p)
        p += 16 + 16
        fflags = 0
        if ver >= 2:
            fflags, = struct.unpack_from("<I", data, p)
            p += 4
        rel = path.replace("res://", "").replace("user://", "user/")
        target = dest / Path(*[_safe(x) for x in rel.split("/") if x not in ("", ".", "..")])
        target.parent.mkdir(parents=True, exist_ok=True)
        start = (base if rel else 0) + file_base + off
        target.write_bytes(data[start:start + size])
        if fflags & 1:
            target.rename(target.with_name(target.name + ".encrypted"))
        n += 1
    log(f"Godot .pck: извлечено {n} файлов ресурсов")
    return n


# ---------------- рекурсивная распаковка ----------------
def _run(cmd, timeout=3600):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, errors="ignore", timeout=timeout).returncode == 0
    except Exception:
        return False


def _safe_zip_extract(z: zipfile.ZipFile, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    for info in z.infolist():
        parts = [_safe(x) for x in info.filename.replace("\\", "/").split("/") if x not in ("", ".", "..")]
        if not parts:
            continue
        target = dest.joinpath(*parts)
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        except Exception:
            # зашифрованный или повреждённый элемент
            target.with_name(target.name + ".FAILED.txt").write_text("не удалось извлечь (шифрование/повреждение)", encoding="utf-8")


def extract_archive(path: Path, dest: Path, find_tool, log):
    """Распаковывает архив любым доступным способом. Возвращает True при успехе."""
    head = path.read_bytes()[:16] if path.stat().st_size else b""
    t = file_type(head)
    if path.suffix.lower() == ".asar":
        from exe_unpack import extract_asar
        try:
            extract_asar(path, dest)
            return True
        except Exception:
            return False
    if t == "godot_pck" or path.suffix.lower() == ".pck":
        return extract_godot_pck(path.read_bytes(), dest, log) > 0
    if t == "zip" or zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as z:
                _safe_zip_extract(z, dest)
            return True
        except Exception:
            pass
    if t == "gzip":
        import gzip
        try:
            dest.mkdir(parents=True, exist_ok=True)
            (dest / path.stem).write_bytes(gzip.decompress(path.read_bytes()))
            return True
        except Exception:
            pass
    sz = find_tool("7z", "7za", "7zz")
    if sz and t in ("7z", "cab", "rar", "ole", "pe", "zip", "bzip2", "xz", ""):
        dest.mkdir(parents=True, exist_ok=True)
        if _run([sz, "x", "-y", "-p-", f"-o{dest}", str(path)]) and any(dest.iterdir()):
            return True
        shutil.rmtree(dest, ignore_errors=True)
    elif t in ("7z", "cab", "rar", "ole") and not sz:
        log(f"Нужен 7-Zip, чтобы распаковать {path.name}")
    return False


ARCHIVE_EXT = {".zip", ".jar", ".apk", ".aab", ".xapk", ".apks", ".obb", ".asar", ".7z", ".cab", ".rar",
               ".msi", ".pck", ".nupkg", ".whl", ".egg", ".pyz", ".war", ".ear", ".gz", ".tgz", ".xpi", ".crx",
               ".ole_msi", ".appx", ".msix", ".vsix", ".docx", ".xlsx"}


def expand_recursive(root: Path, find_tool, log, max_depth=5):
    """Ищет архивы среди извлечённого и распаковывает их рядом в <имя>__extracted/."""
    done, total = set(), 0
    for depth in range(max_depth):
        new = 0
        for f in list(root.rglob("*")):
            if not f.is_file() or f in done or "__extracted" in f.name:
                continue
            ext = f.suffix.lower()
            if ext not in ARCHIVE_EXT:
                if ext or f.stat().st_size < 64:
                    continue
                if file_type(f.read_bytes()[:16]) not in ("zip", "7z", "cab", "rar", "gzip"):
                    continue
            done.add(f)
            dest = f.with_name(f.name + "__extracted")
            if dest.exists():
                continue
            if extract_archive(f, dest, find_tool, log):
                new += 1
        total += new
        if not new:
            break
    if total:
        log(f"Рекурсивная распаковка: раскрыто {total} вложенных архивов")
    return total


# ---------------- опись и покрытие ----------------
def inventory(out: Path, log):
    rows = []
    for f in sorted(out.rglob("*")):
        if f.is_file() and f.name not in ("00_INVENTORY.csv",):
            b = f.read_bytes()
            rows.append((str(f.relative_to(out)), len(b), hashlib.sha256(b).hexdigest(), file_type(b[:16])))
    with open(out / "00_INVENTORY.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["путь", "размер", "sha256", "тип_по_сигнатуре"])
        w.writerows(rows)
    log(f"Опись: {len(rows)} файлов, {sum(r[1] for r in rows):,} байт -> 00_INVENTORY.csv")
    return rows


def coverage(pe, data: bytes, overlay):
    """Какие байты исходного файла попали в выгрузку (заголовки, секции, overlay, подпись)."""
    if not pe:
        return None
    covered = [(0, pe.OPTIONAL_HEADER.SizeOfHeaders)]
    covered += [(s.PointerToRawData, s.PointerToRawData + s.SizeOfRawData) for s in pe.sections]
    if overlay:
        covered.append(overlay)
    sec = pe.OPTIONAL_HEADER.DATA_DIRECTORY[4]
    if sec.VirtualAddress:
        covered.append((sec.VirtualAddress, sec.VirtualAddress + sec.Size))
    covered.sort()
    total, cur = 0, 0
    for a, b in covered:
        a, b = max(a, cur), min(b, len(data))
        if b > a:
            total += b - a
            cur = b
    return total, len(data)
