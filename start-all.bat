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

:: ── .env checks ─────────────────────────────────────────────
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

:: ── Install dependencies ─────────────────────────────────────
echo Installing / verifying dependencies...
call pnpm install
if errorlevel 1 (
    echo ERROR: pnpm install failed. Check the output above.
    pause
    exit /b 1
)

echo.
echo Starting all four services in separate windows...
echo.

:: ── TX Analyzer API (port 8000) ──────────────────────────────
start "TX Analyzer API  [port 8000]" cmd /k "title TX Analyzer API [port 8000] && cd /d %~dp0 && pnpm --filter @workspace/tx-analyzer-api run dev"

:: ── CW Recorder API (port 8080) ──────────────────────────────
start "CW Recorder API  [port 8080]" cmd /k "title CW Recorder API [port 8080] && cd /d %~dp0 && pnpm --filter @workspace/api-server run dev"

:: Short pause so Playwright Chromium installs don't collide
timeout /t 5 /nobreak >nul

:: ── CW TX Analyzer Frontend (port 5173) ──────────────────────
start "CW TX Analyzer UI  [port 5173]" cmd /k "title CW TX Analyzer UI [port 5173] && cd /d %~dp0 && set PORT=5173 && set BASE_PATH=/cw-tx-analyzer/ && pnpm --filter @workspace/cw-tx-analyzer run dev"

:: ── CW Recorder Frontend (port 5174) ─────────────────────────
start "CW Recorder UI  [port 5174]" cmd /k "title CW Recorder UI [port 5174] && cd /d %~dp0 && set PORT=5174 && set BASE_PATH=/ && pnpm --filter @workspace/cw-recorder run dev"

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
