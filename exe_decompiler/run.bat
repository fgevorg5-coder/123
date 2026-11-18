@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title EXE Analyzer + Decompiler
cd /d "%~dp0"

rem === Path to Ghidra (for C/C++/Go/Rust). Leave empty if Ghidra is in the tools folder ===
set "GHIDRA_DIR="

rem --- Python check ---
where python >nul 2>nul
if errorlevel 1 (
    echo [!] Python not found. Install it from https://www.python.org ^(enable "Add to PATH"^).
    pause & exit /b 1
)
python -c "import pefile" 2>nul || (
    echo [*] Installing pefile...
    python -m pip install --quiet pefile
)

rem --- File: dragged onto the bat or asked for ---
set "EXE=%~1"
if "%EXE%"=="" (
    echo Drag an .exe / .dll / .msi / .apk / installer or a whole app FOLDER onto run.bat, or enter its path:
    set /p "EXE=> "
)
set "EXE=%EXE:"=%"
set "EXTRA="
if exist "%EXE%\" goto :have_input
if not exist "%EXE%" (
    echo [!] File not found: %EXE%
    pause & exit /b 1
)

echo.
echo ========== STEP 1: WHAT IS IT WRITTEN IN ==========
python "%~dp0analyze.py" "%EXE%"
echo.
choice /c YN /m "Decompile everything into folders"
if errorlevel 2 exit /b 0
choice /c YN /m "Also extract ALL files of the program folder (dll, data, game assets)"
if not errorlevel 2 set "EXTRA=--folder"
:have_input

echo.
echo ========== STEP 2: DECOMPILATION ==========
if defined GHIDRA_DIR (
    python "%~dp0exe_unpack.py" "%EXE%" %EXTRA% --ghidra "%GHIDRA_DIR%"
) else (
    python "%~dp0exe_unpack.py" "%EXE%" %EXTRA%
)

for %%F in ("%EXE%") do set "OUT=%%~dpnF_decompiled"
if exist "%EXE%\" for %%F in ("%EXE%\.") do set "OUT=%%~dpnxF_decompiled"
if exist "%OUT%" start "" explorer "%OUT%"
echo.
pause
