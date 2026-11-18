#!/usr/bin/env python3
"""
analyze.py - определяет, на чём написан .exe, и как его декомпилировать.

Запуск:
    python analyze.py program.exe [--json]

Выводит язык/технологию, разрядность, признаки упаковки и рекомендуемый
инструмент для декомпиляции. Используется самостоятельно или внутри exe_unpack.py.
"""
import argparse, json, sys
from pathlib import Path

try:
    import pefile
except ImportError:
    pefile = None


# (ключ, человеческое имя, рекомендуемый декомпилятор, качество)
QUALITY = {
    "full":  "почти полное восстановление исходного кода",
    "good":  "хорошее восстановление, возможны неточности",
    "approx":"только приблизительный псевдо-код, исходник вернуть нельзя",
}


def sig(data, needle, limit=None):
    return data.find(needle, 0, limit) != -1


def analyze(path: Path):
    data = path.read_bytes()
    res = {
        "file": path.name,
        "size": len(data),
        "is_pe": False,
        "arch": None,
        "subsystem": None,
        "language": "неизвестно",
        "packer": None,
        "decompiler": "Ghidra (псевдо-C)",
        "quality": QUALITY["approx"],
        "notes": [],
    }

    pe = None
    if data[:2] != b"MZ":
        res["notes"].append("Не Windows-exe (нет подписи MZ).")
        return res
    res["is_pe"] = True

    if pefile:
        try:
            pe = pefile.PE(data=data, fast_load=True)
            pe.parse_data_directories(directories=[
                pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
                pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_COM_DESCRIPTOR"],
            ])
            res["arch"] = {0x14c: "x86 (32-bit)", 0x8664: "x64 (64-bit)",
                            0x1c0: "ARM", 0xaa64: "ARM64"}.get(pe.FILE_HEADER.Machine, hex(pe.FILE_HEADER.Machine))
            res["subsystem"] = {2: "GUI", 3: "консоль"}.get(pe.OPTIONAL_HEADER.Subsystem, str(pe.OPTIONAL_HEADER.Subsystem))
            secs = [s.Name.rstrip(b"\0").decode(errors="ignore") for s in pe.sections]
            for p, nm in (("UPX", "UPX"), (".aspack", "ASPack"), (".themida", "Themida"),
                          ("petite", "Petite"), (".enigma", "Enigma")):
                if any(p.lower() in s.lower() for s in secs):
                    res["packer"] = nm
            clr = pe.OPTIONAL_HEADER.DATA_DIRECTORY[14]
            if clr.VirtualAddress and clr.Size:
                res["language"] = ".NET (C# / VB.NET)"
                res["decompiler"] = "ilspycmd / dnSpy"
                res["quality"] = QUALITY["full"]
                return res
        except Exception as e:
            res["notes"].append(f"pefile: {e}")
    else:
        res["notes"].append("pefile не установлен (pip install pefile) - анализ по сигнатурам.")

    low = data.lower()

    # по приоритету сигнатур
    if sig(low, b".net") and sig(data, b"mscoree.dll"):
        res.update(language=".NET (C# / VB.NET)", decompiler="ilspycmd / dnSpy", quality=QUALITY["full"])
    elif sig(data, b"MEI\x0c\x0b\x0a\x0b\x0e") or sig(data, b"pyi-windows-manifest") or sig(low, b"pyinstaller"):
        res.update(language="Python (PyInstaller)", decompiler="pyinstxtractor + pycdc/decompyle3", quality=QUALITY["good"])
    elif sig(data, b"py2exe"):
        res.update(language="Python (py2exe)", decompiler="извлечение PYTHONSCRIPT + pycdc", quality=QUALITY["good"])
    elif sig(data, b"electron.asar") or (path.parent / "resources" / "app.asar").exists():
        res.update(language="Electron (JavaScript)", decompiler="встроенная распаковка app.asar", quality=QUALITY["full"])
    elif sig(data, b"NODE_SEA_BLOB") or sig(data, b"pkg/prelude") or sig(data, b"BUN_") or (sig(data, b"node::") and sig(data, b"v8::")):
        res.update(language="JavaScript (Node.js: SEA / pkg / Bun)", decompiler="извлечение JS из 01_info/strings.txt; для pkg - pkg-unpacker", quality=QUALITY["good"])
        res["notes"].append("JS-код часто лежит внутри exe открытым текстом или как V8-байткод (тогда исходник не вернуть).")
    elif sig(data, b"Go build ID") or sig(data, b"Go buildinf"):
        res.update(language="Go", decompiler="Ghidra + GoReSym", quality=QUALITY["approx"])
    elif sig(low, b"rustc") or sig(low, b"cargo") or sig(data, b"/rust/"):
        res.update(language="Rust", decompiler="Ghidra", quality=QUALITY["approx"])
    elif sig(data, b"AutoIt") or sig(data, b"AU3!"):
        res.update(language="AutoIt", decompiler="myAut2Exe / Exe2Aut", quality=QUALITY["good"])
    elif sig(data, b"Nullsoft"):
        res.update(language="Установщик NSIS", decompiler="7-Zip (распаковка)", quality=QUALITY["full"])
    elif sig(data, b"Inno Setup"):
        res.update(language="Установщик Inno Setup", decompiler="innoextract", quality=QUALITY["full"])
    elif sig(data, b"Delphi") or sig(data, b"Borland") or sig(data, b"Embarcadero"):
        res.update(language="Delphi / Pascal", decompiler="IDR / DeDe + Ghidra", quality=QUALITY["good"])
    elif sig(data, b"JauntyJalopy") or sig(data, b"launch4j") or sig(data, b"PK\x03\x04") and sig(data, b".class"):
        res.update(language="Java (обёртка .exe)", decompiler="CFR / Procyon / jd-cli", quality=QUALITY["full"])
    elif sig(data, b"GCC:") or sig(data, b"MinGW") or sig(data, b"libgcc"):
        res.update(language="C / C++ (MinGW/GCC)", decompiler="Ghidra (псевдо-C)", quality=QUALITY["approx"])
    elif sig(data, b"Visual C++") or sig(data, b"MSVCR") or sig(data, b"VCRUNTIME") or sig(data, b"Microsoft"):
        res.update(language="C / C++ (MSVC)", decompiler="Ghidra (псевдо-C)", quality=QUALITY["approx"])
    else:
        res.update(language="Нативный код (C/C++ или иное)", decompiler="Ghidra (псевдо-C)", quality=QUALITY["approx"])

    if res["packer"]:
        res["notes"].append(f"Обнаружена упаковка {res['packer']} - сначала распаковка.")
    return res


def human(r):
    out = []
    out.append("=" * 48)
    out.append(f"  Файл:        {r['file']}  ({r['size']:,} байт)")
    out.append(f"  Язык/тех.:   {r['language']}")
    if r['arch']:       out.append(f"  Архитектура: {r['arch']}")
    if r['subsystem']:  out.append(f"  Тип:         {r['subsystem']}")
    if r['packer']:     out.append(f"  Упаковка:    {r['packer']}")
    out.append(f"  Декомпил.:  {r['decompiler']}")
    out.append(f"  Качество:    {r['quality']}")
    for n in r['notes']:
        out.append(f"  ! {n}")
    out.append("=" * 48)
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Анализатор .exe: на чём написан")
    ap.add_argument("exe")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    p = Path(a.exe)
    if not p.exists():
        print("Файл не найден:", p); sys.exit(1)
    r = analyze(p)
    print(json.dumps(r, indent=2, ensure_ascii=False) if a.json else human(r))


if __name__ == "__main__":
    main()
