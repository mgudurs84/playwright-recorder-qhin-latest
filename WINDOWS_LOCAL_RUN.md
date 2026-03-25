# CDR Observability — Windows Local Run Guide

Run the full CDR Observability stack on a Windows machine without Docker or WSL.

---

## Quick summary

| Thing | Value |
|---|---|
| API server port | **8080** (hardcoded — do not change) |
| Frontend (Vite) port | **5173** (default) |
| Frontend URL | http://localhost:5173/ |
| API health check | http://localhost:8080/api/health |
| `.env` file location | `artifacts\api-server\.env` |

---

## Prerequisites

Install these once. Use the links below.

| Tool | Download | Notes |
|---|---|---|
| **Git** | https://git-scm.com/download/win | Default options are fine |
| **Node.js 20+ LTS** | https://nodejs.org | Adds `node` and `npm` to your PATH |
| **pnpm** | Run `npm install -g pnpm` after Node | Package manager for this project |
| **GCP Service Account JSON** | GCP Console → IAM → Service Accounts | Download the key file (.json) |

> Tip: Use [Windows Terminal](https://aka.ms/terminal). All commands work in
> PowerShell or Command Prompt.

---

## Step-by-step setup (run once)

### 1. Clone the repo

```powershell
git clone <YOUR_REPO_URL> cdr-observability
cd cdr-observability
```

### 2. Install all packages

```powershell
pnpm install
```

### 3. Fill in your credentials

Open `artifacts\api-server\.env` in Notepad or VS Code and replace the placeholder
values with your real credentials:

```
artifacts\api-server\.env   ← edit this file
```

**What to fill in:**

```env
# Keep PORT=8080 — the frontend proxy is hardcoded to this port
PORT=8080

# Your CommonWell portal login
CW_USERNAME=your.email@company.com
CW_PASSWORD=your-portal-password

# Your GCP Service Account JSON — paste the entire JSON on ONE LINE
GCP_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...@....iam.gserviceaccount.com",...}
```

**How to get the JSON onto one line in PowerShell:**

```powershell
# Run this in the folder where you saved your GCP key file
$raw = Get-Content "your-key-file.json" -Raw
$oneLine = $raw.Trim() -replace "`r`n", "\n" -replace "`n", "\n"
Write-Output $oneLine
# Copy the output and paste it as the GCP_SERVICE_ACCOUNT_JSON value in .env
```

### 4. Install Playwright's Chromium browser (one-time, ~150 MB)

```powershell
npx --yes playwright install chromium
```

---

## Running the app (every time)

Open **two separate PowerShell windows** in the project root.

### Terminal 1 — API server

```powershell
pnpm --filter @workspace/api-server run dev
```

Wait until you see:
```
Server listening on port 8080
```

### Terminal 2 — React frontend

```powershell
pnpm --filter @workspace/cw-recorder run dev
```

Wait until you see:
```
  ➜  Local:   http://localhost:5173/
```

Then open **http://localhost:5173/** in your browser.

> Both terminals must stay open while you use the app.

---

## Optional: run both servers with one command

```powershell
npm install -g concurrently
concurrently `
  "pnpm --filter @workspace/api-server run dev" `
  "pnpm --filter @workspace/cw-recorder run dev"
```

---

## Using the PAR Demo (Transaction Monitoring)

1. Click **PAR Demo** in the top navigation bar.
2. Choose your search mode:
   - **Date Range** — last 24 h / 7 d / 30 d, or pick custom dates.
   - **Transaction ID** — type a specific CW transaction ID.
3. Click **Run PAR Demo**.
4. The browser opens and navigates CommonWell automatically.
5. When prompted, enter the **6-digit OTP** that arrives in your email.
6. Vertex AI (Gemini 2.5 Flash) summarises the results once done.

---

## Ports explained

| Service | Port | Who sets it |
|---|---|---|
| API server | 8080 | `PORT=8080` in `artifacts/api-server/.env` |
| React frontend | 5173 | Vite default (no config needed locally) |
| Vite → API proxy | — | Hardcoded to `http://localhost:8080` in `vite.config.ts` |

> **Important:** Do not change `PORT` in `.env` to anything other than `8080`.
> The Vite proxy target is hardcoded. If you need a different port, you must also
> change line 54 of `artifacts/cw-recorder/vite.config.ts`.

---

## Windows-specific fixes

### `pnpm` not found after install

```powershell
# Restart PowerShell, or add npm global bin to PATH:
$env:PATH += ";$env:APPDATA\npm"
```

### Long path errors on `pnpm install`

```powershell
# Run PowerShell as Administrator:
git config --system core.longpaths true
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
# Then restart your terminal.
```

### Playwright Chromium `Executable doesn't exist`

```powershell
npx playwright install chromium
```

Chromium is stored at: `%LOCALAPPDATA%\ms-playwright\`

### Antivirus blocking Chromium

Add an exclusion for `%LOCALAPPDATA%\ms-playwright\` in your antivirus settings.

### `PORT environment variable is required` error

Your `.env` file is missing or in the wrong location.
It must be at: `artifacts\api-server\.env`
Make sure `PORT=8080` is in that file.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm` then restart terminal |
| `Cannot find module '@workspace/...'` | Run `pnpm install` from the repo root |
| `Executable doesn't exist` (Playwright) | `npx playwright install chromium` |
| Blank page / "Cannot connect" at :5173 | Make sure the API server is running on 8080 |
| OTP not arriving | Check your CW account email; verify `CW_USERNAME` is correct |
| `PERMISSION_DENIED` from Vertex AI | Your JSON key is wrong or not on a single line in `.env` |
| `PORT environment variable is required` | `.env` file is missing — check `artifacts\api-server\.env` |
| Port 8080 already in use | Find the process: `netstat -ano \| findstr :8080` and kill it |

---

## File locations

```
cdr-observability\
├── artifacts\
│   ├── api-server\
│   │   └── .env          ← your credentials go here
│   └── cw-recorder\
│       └── vite.config.ts  ← proxy target (localhost:8080)
├── WINDOWS_LOCAL_RUN.md  ← this file
└── pnpm-workspace.yaml
```

---

## Stopping the servers

Press **Ctrl+C** in each terminal.
