@echo off
setlocal

echo.
echo ============================================================
echo  CDR Observability - Start All Services
echo ============================================================
echo.
echo This will launch both tools:
echo   - CW Transaction Analyzer  (ports 8000 + 5173)
echo   - CW Recorder              (ports 8080 + 5174)
echo.

:: ── Prerequisite checks ─────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not on PATH.
    echo Download it from https://nodejs.org  ^(LTS version^)
    echo.
    pause
    exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
    echo ERROR: pnpm is not installed.
    echo Run:  npm install -g pnpm
    echo Then reopen this window and try again.
    echo.
    pause
    exit /b 1
)

:: ── Combined .env checks ─────────────────────────────────────
set MISSING_ENV=0

if not exist "%~dp0artifacts\tx-analyzer-api\.env" (
    echo MISSING: artifacts\tx-analyzer-api\.env
    echo   Run:  copy artifacts\tx-analyzer-api\.env.example artifacts\tx-analyzer-api\.env
    set MISSING_ENV=1
)

if not exist "%~dp0artifacts\api-server\.env" (
    echo MISSING: artifacts\api-server\.env
    echo   Run:  copy artifacts\api-server\.env.example artifacts\api-server\.env
    set MISSING_ENV=1
)

if "%MISSING_ENV%"=="1" (
    echo.
    echo Please create the missing .env files above, fill in your credentials,
    echo then run this script again.
    echo.
    pause
    exit /b 1
)

:: ── Launch both tools (NO_PAUSE suppresses their individual pause prompts) ──
set NO_PAUSE=1

echo Starting CW Transaction Analyzer...
call "%~dp0start-tx-analyzer.bat"

echo.
echo Starting CW Recorder...
call "%~dp0start-cw-recorder.bat"

echo.
echo ============================================================
echo  All four windows are starting. Wait ~20 seconds then open:
echo.
echo  CW Transaction Analyzer:  http://localhost:5173/cw-tx-analyzer/
echo  CW Recorder:              http://localhost:5174/
echo.
echo  APIs:
echo    TX Analyzer API:  http://localhost:8000
echo    CW Recorder API:  http://localhost:8080
echo ============================================================
echo.
echo You can close this window — the four service windows stay open.
echo.
pause
