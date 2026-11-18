@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist tools mkdir tools
echo ===== Installing decompilation tools =====

echo [1/5] Python packages: pefile, pyinstxtractor-ng, decompyle3, uncompyle6, autoit-ripper
python -m pip install --upgrade pefile pyinstxtractor-ng decompyle3 uncompyle6 autoit-ripper

echo [2/5] ILSpy for .NET (needs .NET SDK: https://dotnet.microsoft.com/download)
where dotnet >nul 2>nul && dotnet tool install -g ilspycmd || echo     [!] dotnet not found - skipping .NET

echo [3/5] 7-Zip for installers
where winget >nul 2>nul && winget install -e --id 7zip.7zip --accept-source-agreements --accept-package-agreements || echo     [!] Install 7-Zip manually: https://www.7-zip.org

echo [4/5] CFR for Java
curl -L -o tools\cfr.jar https://www.benf.org/other/cfr/cfr-0.152.jar

echo [5/5] Download manually and unpack into the tools folder if needed:
echo     - Ghidra (C/C++/Go/Rust, needs JDK 21): https://ghidra-sre.org
echo     - UPX:         https://upx.github.io
echo     - innoextract: https://constexpr.org/innoextract
echo     - pycdc.exe (new Python versions): https://github.com/zrax/pycdc
echo     - jadx / apktool (Android APK): https://github.com/skylot/jadx  https://apktool.org
echo     - Unity: AssetRipper, Il2CppDumper;  Unreal: FModel
echo.
echo Done.
pause
