#!/usr/bin/env python3
"""
exe_unpack.py - анализирует .exe (на чём написан) и декомпилирует его по папкам.

Структура результата:
  00_REPORT.txt     - на чём написан, чем декомпилировано, что не удалось
  01_info/          - info.json, заголовки, импорты, экспорты, строки
  02_sections/      - секции PE (.text, .data, ...)
  03_resources/     - ресурсы (иконки, манифест, формы, картинки)
  04_unpacked/      - распакованное (UPX, установщики, PyInstaller, jar)
  05_source/        - декомпилированный код (csharp/, python/, javascript/, java/, autoit/, native_c/, jadx/)
  06_inner/         - разбор каждого вложенного exe/dll/msi/apk/pck (рекурсивно)
  07_app_files/     - (--folder) все файлы папки программы + распакованные архивы
  00_INVENTORY.csv  - опись всех извлечённых файлов (размер, sha256, тип)

Использование:
  python exe_unpack.py program.exe|папка [-o папка] [--ghidra путь_к_ghidra] [--folder] [--deep]
Используйте только для своих программ или там, где лицензия разрешает реверс-инжиниринг.
"""
import argparse, glob, hashlib, json, os, re, shutil, struct, subprocess, sys, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = HERE / "tools"
sys.path.insert(0, str(HERE))
import analyze  # noqa: E402
import extract_all as xa  # noqa: E402

try:
    import pefile
except ImportError:
    pefile = None

LOG = []
SEEN = set()  # sha256 уже разобранных файлов (защита от повторов и циклов)
DEEP = False  # --deep: Ghidra и для вложенных нативных exe/dll


def log(msg):
    print(f"[*] {msg}")
    LOG.append(msg)


def find_tool(*names):
    """Ищет инструмент в tools\\, PATH и стандартных папках Windows."""
    extra = [r"C:\Program Files\7-Zip", r"C:\Program Files (x86)\7-Zip",
             os.path.expanduser(r"~\.dotnet\tools")]
    for n in names:
        for cand in [TOOLS / n, TOOLS / f"{n}.exe", *TOOLS.glob(f"*/{n}.exe"), *TOOLS.glob(f"*/{n}")]:
            if Path(cand).is_file():
                return str(cand)
        w = shutil.which(n)
        if w:
            return w
        for d in extra:
            p = Path(d) / f"{n}.exe"
            if p.is_file():
                return str(p)
    return None


def run(cmd, cwd=None, timeout=None):
    log("Запуск: " + " ".join(map(str, cmd)))
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors="ignore", timeout=timeout)
    except Exception as e:
        log(f"  не удалось запустить: {e}")
        return False, ""
    if r.returncode != 0:
        log(f"  ошибка ({r.returncode}): {(r.stderr or r.stdout).strip()[:400]}")
    return r.returncode == 0, r.stdout


def safe(name):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name)).strip(" .") or "_"


# ---------------- структура PE ----------------
MAGIC_EXT = [(b"\x89PNG", ".png"), (b"\xff\xd8\xff", ".jpg"), (b"GIF8", ".gif"), (b"BM", ".bmp"),
             (b"TPF0", ".dfm"), (b"<?xml", ".xml"), (b"PK\x03\x04", ".zip"), (b"MZ", ".exe_or_dll")]


def dump_pe(pe, out: Path):
    info, secs, res = out / "01_info", out / "02_sections", out / "03_resources"
    for d in (info, secs, res):
        d.mkdir(parents=True, exist_ok=True)
    (info / "headers.txt").write_text(pe.dump_info(), encoding="utf-8", errors="ignore")
    for s in pe.sections:
        nm = safe(s.Name.rstrip(b"\0").decode(errors="ignore").lstrip(".") or "noname")
        (secs / f"{nm}.bin").write_bytes(s.get_data())

    imports = {}
    for e in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        imports[e.dll.decode(errors="ignore")] = [
            i.name.decode(errors="ignore") if i.name else f"ord_{i.ordinal}" for i in e.imports]
    (info / "imports.json").write_text(json.dumps(imports, indent=2, ensure_ascii=False), encoding="utf-8")
    exports = []
    if hasattr(pe, "DIRECTORY_ENTRY_EXPORT"):
        exports = [e.name.decode(errors="ignore") if e.name else f"ord_{e.ordinal}"
                   for e in pe.DIRECTORY_ENTRY_EXPORT.symbols]
    (info / "exports.json").write_text(json.dumps(exports, indent=2, ensure_ascii=False), encoding="utf-8")

    count = 0
    image = pe.get_memory_mapped_image()
    for t in getattr(pe, "DIRECTORY_ENTRY_RESOURCE", type("x", (), {"entries": []})).entries:
        tname = str(t.name) if t.name else pefile.RESOURCE_TYPE.get(t.struct.Id, str(t.struct.Id))
        for r in getattr(getattr(t, "directory", None), "entries", []):
            rname = str(r.name) if r.name else str(r.struct.Id)
            for lang in getattr(getattr(r, "directory", None), "entries", []):
                ds = lang.data.struct
                blob = image[ds.OffsetToData: ds.OffsetToData + ds.Size]
                ext = {"RT_MANIFEST": ".xml", "RT_HTML": ".html", "RT_ICON": ".ico_raw"}.get(tname)
                if not ext:
                    ext = next((e for m, e in MAGIC_EXT if blob.startswith(m)), ".bin")
                d = res / safe(tname)
                d.mkdir(exist_ok=True)
                (d / f"{safe(rname)}_{lang.struct.Id}{ext}").write_bytes(blob)
                count += 1
    log(f"PE: {len(pe.sections)} секций, {len(imports)} DLL в импорте, {count} ресурсов")


def dump_strings(data: bytes, out: Path, min_len=6):
    a = re.findall(rb"[\x20-\x7e]{%d,}" % min_len, data)
    u = re.findall(rb"(?:[\x20-\x7e]\x00){%d,}" % min_len, data)
    lines = [s.decode() for s in a] + [s.decode("utf-16le") for s in u]
    (out / "01_info").mkdir(parents=True, exist_ok=True)
    (out / "01_info" / "strings.txt").write_text("\n".join(lines), encoding="utf-8")


# ---------------- обработчики ----------------
def do_upx(exe, out):
    upx = find_tool("upx")
    if not upx:
        log("UPX не найден (положите upx.exe в tools\\) - пропуск распаковки")
        return exe
    d = out / "04_unpacked" / "upx"
    d.mkdir(parents=True, exist_ok=True)
    target = d / exe.name
    ok, _ = run([upx, "-d", "-o", str(target), str(exe)])
    return target if ok else exe


def do_dotnet(exe, out, sub=""):
    tool = find_tool("ilspycmd")
    if not tool:
        log(".NET: ilspycmd не найден (install_tools.bat или: dotnet tool install -g ilspycmd)")
        return False
    d = out / "05_source" / "csharp" / safe(sub or exe.stem)
    d.mkdir(parents=True, exist_ok=True)
    ok, _ = run([tool, "-p", "-o", str(d), str(exe)], timeout=1800)
    return ok


def decompile_pyc(pyc: Path, target: Path):
    for tool in ("pycdc", "decompyle3", "uncompyle6"):
        t = find_tool(tool)
        if not t:
            continue
        try:
            r = subprocess.run([t, str(pyc)], capture_output=True, text=True, errors="ignore", timeout=120)
        except Exception:
            continue
        if r.stdout.strip() and r.returncode == 0:
            target.write_text(r.stdout, encoding="utf-8")
            return True
    return False


def do_pyinstaller(exe, out):
    raw = out / "04_unpacked" / "pyinstaller"
    raw.mkdir(parents=True, exist_ok=True)
    ng = find_tool("pyinstxtractor-ng")
    script = TOOLS / "pyinstxtractor.py"
    if ng:
        ok, stdout = run([ng, str(exe.resolve())], cwd=raw, timeout=1800)
    elif script.exists():
        ok, stdout = run([sys.executable, str(script), str(exe.resolve())], cwd=raw, timeout=1800)
    else:
        log("PyInstaller: нужен pyinstxtractor-ng (pip) или tools\\pyinstxtractor.py")
        return
    entries = re.findall(r"Possible entry point: (\S+)", stdout or "")
    src = out / "05_source" / "python"
    total = done = 0
    for pyc in raw.rglob("*.pyc"):
        rel = pyc.relative_to(raw)
        # пропускаем стандартную библиотеку и сторонние пакеты не будем - декомпилируем всё
        target = src / rel.with_suffix(".py")
        target.parent.mkdir(parents=True, exist_ok=True)
        total += 1
        if decompile_pyc(pyc, target):
            done += 1
        else:
            target.with_suffix(".FAILED.txt").write_text(
                "Не удалось декомпилировать. Исходный .pyc: " + str(pyc), encoding="utf-8")
    if entries:
        ep = src / "_ENTRY_POINTS"
        ep.mkdir(parents=True, exist_ok=True)
        for e in entries:
            for f in src.rglob(Path(e).stem + ".py"):
                shutil.copy(f, ep / f.name)
    log(f"Python: декомпилировано {done} из {total} файлов; точки входа: {', '.join(entries) or 'не найдены'}")


def do_archive(exe, out, kind):
    d = out / "04_unpacked" / kind
    d.mkdir(parents=True, exist_ok=True)
    inno, sz = find_tool("innoextract"), find_tool("7z", "7za")
    if kind == "inno" and inno:
        run([inno, "-d", str(d), str(exe)], timeout=3600)
    elif sz:
        run([sz, "x", "-y", f"-o{d}", str(exe)], timeout=3600)
    else:
        log("Установщик: нужен 7-Zip или innoextract")
    return d


def extract_asar(asar: Path, dest: Path):
    """Распаковка Electron app.asar без Node.js."""
    with open(asar, "rb") as f:
        head = f.read(16)
        header_size = struct.unpack("<I", head[4:8])[0]
        json_len = struct.unpack("<I", head[12:16])[0]
        header = json.loads(f.read(json_len).decode("utf-8"))
        base = 8 + header_size

        def walk(node, path: Path):
            for name, item in node.get("files", {}).items():
                p = path / safe(name)
                if "files" in item:
                    p.mkdir(parents=True, exist_ok=True)
                    walk(item, p)
                elif item.get("unpacked"):
                    src = Path(str(asar) + ".unpacked") / p.relative_to(dest)
                    if src.exists():
                        p.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy(src, p)
                elif "offset" in item:
                    f.seek(base + int(item["offset"]))
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(f.read(int(item["size"])))
        dest.mkdir(parents=True, exist_ok=True)
        walk(header, dest)


def do_electron(roots, out):
    found = False
    for root in roots:
        for asar in Path(root).rglob("*.asar"):
            found = True
            dest = out / "05_source" / "javascript" / safe(asar.stem)
            try:
                extract_asar(asar, dest)
                log(f"Electron: распакован {asar}")
            except Exception as e:
                log(f"Electron: ошибка {asar}: {e}")
    if not found:
        log("Electron: app.asar не найден (обычно лежит в папке resources рядом с exe)")


def do_java(exe, out):
    try:
        z = zipfile.ZipFile(exe)
    except zipfile.BadZipFile:
        log("Java: вложенный jar не найден")
        return
    raw = out / "04_unpacked" / "jar"
    z.extractall(raw)
    jar = out / "04_unpacked" / "app.jar"
    with zipfile.ZipFile(jar, "w", zipfile.ZIP_DEFLATED) as zz:
        for f in raw.rglob("*"):
            if f.is_file():
                zz.write(f, f.relative_to(raw))
    cfr = next(iter(TOOLS.glob("cfr*.jar")), None)
    java = find_tool("java")
    if cfr and java:
        run([java, "-jar", str(cfr), str(jar), "--outputdir", str(out / "05_source" / "java")], timeout=3600)
    else:
        log("Java: нужен Java и tools\\cfr.jar (install_tools.bat)")


def do_autoit(exe, out):
    tool = find_tool("autoit-ripper")
    if not tool:
        log("AutoIt: нужен autoit-ripper (pip install autoit-ripper)")
        return
    d = out / "05_source" / "autoit"
    d.mkdir(parents=True, exist_ok=True)
    run([tool, str(exe), str(d)], timeout=600)


def find_ghidra(arg):
    cands = [arg, os.environ.get("GHIDRA_DIR"), *glob.glob(str(TOOLS / "ghidra*")),
             *glob.glob(r"C:\ghidra*"), *glob.glob(os.path.expanduser(r"~\ghidra*"))]
    for c in cands:
        if c:
            h = Path(c) / "support" / ("analyzeHeadless.bat" if os.name == "nt" else "analyzeHeadless")
            if h.exists():
                return h
    return None


def do_ghidra(exe, out, ghidra_arg):
    headless = find_ghidra(ghidra_arg)
    if not headless:
        log("Нативный код: Ghidra не найдена. Распакуйте её в tools\\ или укажите GHIDRA_DIR в run.bat")
        return
    proj = out / "_ghidra_tmp"
    proj.mkdir(exist_ok=True)
    dest = out / "05_source" / "native_c"
    run([str(headless), str(proj), "tmp", "-import", str(exe), "-scriptPath", str(HERE),
         "-postScript", "ExportDecompiled.java", str(dest), "-deleteProject"], timeout=7200)
    shutil.rmtree(proj, ignore_errors=True)
    n = len(list(dest.rglob("*.c"))) if dest.exists() else 0
    log(f"Ghidra: сохранено {n} функций")


# ---------------- главное ----------------
def kind_of(lang: str):
    l = lang.lower()
    for key, k in ((".net", "dotnet"), ("node.js", "node"), ("pyinstaller", "pyinstaller"), ("py2exe", "py2exe"),
                   ("electron", "electron"), ("nsis", "nsis"), ("inno", "inno"),
                   ("java", "java"), ("autoit", "autoit")):
        if key in l:
            return k
    return "native"


def do_apk(path, out):
    """Android APK/AAB/XAPK: jadx (код+ресурсы) и apktool (smali+декодированные xml), иначе сырая распаковка."""
    jadx, apktool = find_tool("jadx", "jadx.bat"), find_tool("apktool", "apktool.bat")
    if jadx:
        run([jadx, "-d", str(out / "05_source" / "jadx"), "--show-bad-code", str(path)], timeout=7200)
    if apktool:
        run([apktool, "d", "-f", "-o", str(out / "05_source" / "apktool"), str(path)], timeout=7200)
    if not (jadx or apktool):
        log("APK: jadx/apktool не найдены - только сырая распаковка (classes.dex, res, assets, lib)")


def process_non_pe(path: Path, out: Path, rep):
    data = path.read_bytes()
    dest = out / "04_unpacked" / "archive"
    if xa.extract_archive(path, dest, find_tool, log):
        log(f"Распаковано как архив ({xa.file_type(data[:16]) or path.suffix}) -> 04_unpacked/archive")
        if (dest / "AndroidManifest.xml").exists() or path.suffix.lower() in (".apk", ".aab", ".xapk", ".apks"):
            do_apk(path, out)
        if any(dest.rglob("*.class")):
            do_java(path, out)
    elif xa.extract_godot_pck(data, out / "04_unpacked" / "godot_pck", log):
        pass
    else:
        log("Формат не распознан как архив - только карвинг вложенных файлов и строки")
    xa.carve(data, out, log, skip_offsets=(0,))
    dump_strings(data, out)
    return rep


def detect_engine(exe: Path):
    d = exe.parent
    if (d / "UnityPlayer.dll").exists() or any(d.glob("*_Data/globalgamemanagers")):
        il2cpp = (d / "GameAssembly.dll").exists()
        log("Unity: " + ("IL2CPP - код в GameAssembly.dll + *_Data/il2cpp_data/Metadata/global-metadata.dat "
                         "(Il2CppDumper/Cpp2IL), ассеты - AssetRipper" if il2cpp else
                         "Mono - C# в *_Data/Managed/Assembly-CSharp.dll (ILSpy), ассеты - AssetRipper") +
            ". Запустите с --folder, чтобы разобрать всю папку игры.")
    if any(d.glob("*.pak")) and any(d.rglob("*-Win64-Shipping.exe")):
        log("Unreal Engine: ассеты в .pak/.utoc - нужен FModel/UnrealPak (часто с AES-ключом)")


def process(exe: Path, out: Path, ghidra, depth=0):
    data = exe.read_bytes()
    h = hashlib.sha256(data).hexdigest()
    if h in SEEN:
        log(f"{exe.name}: уже разобран ранее - пропуск")
        return {"language": "дубликат", "is_pe": False}
    SEEN.add(h)
    rep = analyze.analyze(exe)
    kind = kind_of(rep["language"])
    log(f"{exe.name}: {rep['language']}")
    if not rep["is_pe"]:
        return process_non_pe(exe, out, rep)
    if depth == 0:
        detect_engine(exe)

    pe = None
    if pefile and rep["is_pe"]:
        try:
            pe = pefile.PE(data=data)
        except Exception as e:
            log(f"pefile: {e}")
    overlay = None
    if pe:
        dump_pe(pe, out)
        try:
            overlay = xa.dump_pe_extras(pe, data, out, log)
        except Exception as e:
            log(f"Доп. разбор PE: {e}")
        cov = xa.coverage(pe, data, overlay)
        if cov:
            rep["coverage"] = f"{cov[0]:,} из {cov[1]:,} байт файла выгружено в 02_sections/01_info/04_unpacked"
    dump_strings(data, out)
    xa.carve(data, out, log, skip_offsets=(0,))
    xa.extract_godot_pck(data, out / "04_unpacked" / "godot_pck", log)
    if overlay and kind not in ("nsis", "inno"):
        # SFX-архивы, самораспаковщики, приклеенные данные - пробуем 7-Zip
        if find_tool("7z", "7za", "7zz"):
            d = out / "04_unpacked" / "overlay_7z"
            if not xa.extract_archive(out / "04_unpacked" / "overlay.bin", d, find_tool, log):
                xa.extract_archive(exe, d, find_tool, log)

    work = exe
    if rep.get("packer") == "UPX":
        work = do_upx(exe, out)
        if work != exe:
            rep2 = analyze.analyze(work)
            kind = kind_of(rep2["language"])
            log(f"После распаковки UPX: {rep2['language']}")

    if kind == "dotnet":
        do_dotnet(work, out)
        # если рядом лежат .NET-библиотеки программы - декомпилируем и их
        if depth == 0:
            for dll in exe.parent.glob("*.dll"):
                if analyze.analyze(dll)["language"].startswith(".NET"):
                    do_dotnet(dll, out, sub=dll.stem)
    elif kind == "pyinstaller":
        do_pyinstaller(work, out)
    elif kind in ("nsis", "inno"):
        d = do_archive(work, out, kind)
        do_electron([d], out)
    elif kind == "electron":
        do_electron([exe.parent], out)
    elif kind == "py2exe":
        log("py2exe: байткод в ресурсе PYTHONSCRIPT (03_resources) и в приклеенном zip (04_unpacked/carved)")
    elif kind == "java":
        do_java(work, out)
    elif kind == "autoit":
        do_autoit(work, out)
    elif kind == "node":
        d = out / "05_source" / "javascript"
        d.mkdir(parents=True, exist_ok=True)
        js = re.findall(rb"(?:require\(|module\.exports|function\s+\w+\s*\(|=>)[\x09\x0a\x0d\x20-\x7e]{200,}", data)
        (d / "embedded_js_fragments.js").write_bytes(b"\n\n// -----\n".join(js[:5000]))
        log(f"Node.js: найдено {len(js)} фрагментов JS-кода")
    elif depth == 0 or DEEP:
        do_ghidra(work, out, ghidra)
    else:
        log(f"{exe.name}: нативный код - Ghidra для вложенных файлов только с --deep")

    # всё, что распаковалось, раскрываем дальше и разбираем вложенные программы
    unp = out / "04_unpacked"
    if unp.exists():
        xa.expand_recursive(unp, find_tool, log)
    if depth < 3:
        process_inner(out, ghidra, depth)
    return rep


INNER_EXT = {".exe", ".dll", ".exe_or_dll", ".sys", ".ocx", ".scr", ".msi", ".apk", ".jar", ".pck"}


def process_inner(out: Path, ghidra, depth):
    unp = out / "04_unpacked"
    if not unp.exists():
        return
    for inner in sorted(unp.rglob("*")):
        if not inner.is_file() or inner.suffix.lower() not in INNER_EXT or inner.name.endswith("__extracted"):
            continue
        if inner.parent.name == "upx" or inner.name == "overlay.bin":
            continue
        sub_out = out / "06_inner" / safe(str(inner.relative_to(unp)).replace(os.sep, "__"))
        sub_out.mkdir(parents=True, exist_ok=True)
        log(f"--- вложенный файл: {inner.relative_to(unp)}")
        try:
            process(inner, sub_out, ghidra, depth + 1)
        except Exception as e:
            log(f"    ошибка: {e}")
        if not any(sub_out.rglob("*")):
            sub_out.rmdir()


def process_folder(folder: Path, out: Path, ghidra, skip=None):
    """Копирует всю папку программы в 07_app_files и разбирает каждый исполняемый файл и архив."""
    files_dir = out / "07_app_files"
    n = 0
    for f in sorted(folder.rglob("*")):
        if not f.is_file() or out in f.parents or f.name.endswith("_decompiled"):
            continue
        t = files_dir / f.relative_to(folder)
        t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, t)
        n += 1
    log(f"Папка программы: скопировано {n} файлов -> 07_app_files/")
    xa.expand_recursive(files_dir, find_tool, log)
    for f in sorted(folder.rglob("*")):
        if not f.is_file() or (skip and f == skip) or out in f.parents:
            continue
        head = f.read_bytes()[:16] if f.stat().st_size >= 64 else b""
        if f.suffix.lower() in INNER_EXT or xa.file_type(head) == "pe":
            sub = out / "06_inner" / safe(str(f.relative_to(folder)).replace(os.sep, "__"))
            sub.mkdir(parents=True, exist_ok=True)
            log(f"--- файл программы: {f.relative_to(folder)}")
            try:
                process(f, sub, ghidra, depth=1)
            except Exception as e:
                log(f"    ошибка: {e}")


def main():
    ap = argparse.ArgumentParser(description="Анализ и декомпиляция .exe по папкам")
    ap.add_argument("exe")
    ap.add_argument("-o", "--out")
    ap.add_argument("--ghidra", help="папка Ghidra (для C/C++/Go/Rust)")
    ap.add_argument("--folder", action="store_true",
                    help="разобрать всю папку программы (dll, данные, ассеты игры), а не только exe")
    ap.add_argument("--deep", action="store_true", help="Ghidra и для вложенных нативных exe/dll (долго)")
    a = ap.parse_args()
    global DEEP
    DEEP = a.deep

    exe = Path(a.exe).resolve()
    if not exe.exists():
        print("Файл не найден:", exe)
        sys.exit(1)
    folder = exe if exe.is_dir() else (exe.parent if a.folder else None)
    out = Path(a.out or (exe.parent / f"{exe.name if exe.is_dir() else exe.stem}_decompiled")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if not pefile:
        log("pefile не установлен (pip install pefile) - разбор PE пропущен")

    if exe.is_dir():
        rep = {"file": exe.name, "size": 0, "language": "папка программы", "arch": None, "subsystem": None,
               "packer": None, "decompiler": "по каждому файлу", "quality": "-", "notes": []}
    else:
        rep = process(exe, out, a.ghidra)
        rep["sha256"] = hashlib.sha256(exe.read_bytes()).hexdigest()
    if folder:
        process_folder(folder, out, a.ghidra, skip=exe if exe.is_file() else None)
    (out / "01_info").mkdir(exist_ok=True)
    (out / "01_info" / "info.json").write_text(json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8")

    xa.inventory(out, log)
    if rep.get("coverage"):
        rep["notes"].append("Покрытие: " + rep["coverage"])
    tree = []
    for d in sorted(p for p in out.iterdir() if p.is_dir()):
        n = sum(1 for f in d.rglob("*") if f.is_file())
        tree.append(f"  {d.name + '/':<16} {n} файлов")
    report = analyze.human(rep) + "\n\nСодержимое:\n" + "\n".join(tree) + "\n\nЖурнал:\n" + "\n".join("  " + l for l in LOG)
    (out / "00_REPORT.txt").write_text(report, encoding="utf-8")
    print("\n" + report)
    print(f"\nГотово: {out}")


if __name__ == "__main__":
    main()
