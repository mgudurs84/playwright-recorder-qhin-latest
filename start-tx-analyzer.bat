@echo off
setlocal

echo.
echo ============================================================
echo  CW Transaction Analyzer - Local Launcher
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
if not exist "%~dp0artifacts\tx-analyzer-api\.env" (
    echo WARNING: artifacts\tx-analyzer-api\.env not found.
    echo.
    echo Create it by running:
    echo   copy artifacts\tx-analyzer-api\.env.example artifacts\tx-analyzer-api\.env
    echo.
    echo Then open it in Notepad and fill in:
    echo   CW_USERNAME, CW_PASSWORD, CW_PORTAL_URL, GCP_PROJECT_ID
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

:: ── API server (port 8000) ───────────────────────────────────
start "TX Analyzer API  [port 8000]" cmd /k "title TX Analyzer API [port 8000] && cd /d %~dp0 && pnpm --filter @workspace/tx-analyzer-api run dev"

:: Short pause so Playwright Chromium install finishes before the frontend starts
timeout /t 3 /nobreak >nul

:: ── Frontend (port 5173) ─────────────────────────────────────
start "CW TX Analyzer UI  [port 5173]" cmd /k "title CW TX Analyzer UI [port 5173] && cd /d %~dp0 && set PORT=5173 && set BASE_PATH=/cw-tx-analyzer/ && pnpm --filter @workspace/cw-tx-analyzer run dev"

echo.
echo ============================================================
echo  Both windows are starting up. Wait ~15 seconds then open:
echo.
echo    http://localhost:5173/cw-tx-analyzer/
echo.
echo  API running at: http://localhost:8000
echo ============================================================
echo.
echo You can close this window — the service windows stay open.
echo.
pause
