@echo off
setlocal

echo.
echo ============================================================
echo  CW Recorder - Local Launcher
echo ============================================================
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

:: ── .env check ──────────────────────────────────────────────
if not exist "%~dp0artifacts\api-server\.env" (
    echo WARNING: artifacts\api-server\.env not found.
    echo.
    echo Create it by running:
    echo   copy artifacts\api-server\.env.example artifacts\api-server\.env
    echo.
    echo Then open it in Notepad and fill in:
    echo   CW_USERNAME, CW_PASSWORD, GCP_PROJECT_ID ^(or GCP_SERVICE_ACCOUNT_JSON^)
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
echo Starting services in separate windows...
echo.

:: ── API server (port 8080) ───────────────────────────────────
start "CW Recorder API  [port 8080]" cmd /k "title CW Recorder API [port 8080] && cd /d "%~dp0" && pnpm --filter @workspace/api-server run dev"

:: Short pause so Playwright Chromium install finishes before the frontend starts
timeout /t 3 /nobreak >nul

:: ── Frontend (port 5174 — avoids clash if TX Analyzer is also running) ──
start "CW Recorder UI  [port 5174]" cmd /k "title CW Recorder UI [port 5174] && cd /d "%~dp0" && set PORT=5174 && set BASE_PATH=/ && pnpm --filter @workspace/cw-recorder run dev"

echo.
echo ============================================================
echo  Both windows are starting up. Wait ~15 seconds then open:
echo.
echo    http://localhost:5174/
echo.
echo  API running at: http://localhost:8080
echo.
echo  NOTE: Always use "localhost" — NOT your machine's IP address.
echo  Using your LAN IP (e.g. 10.x.x.x) bypasses the local proxy
echo  and will cause 404 errors on every API call.
echo ============================================================
echo.
echo You can close this window — the service windows stay open.
echo.
if not defined NO_PAUSE pause
