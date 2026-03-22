# CDR Observability — Windows Local Run Guide

Run the full CDR Observability stack (API server + React frontend) on a Windows machine
without Docker or WSL.

---

## Prerequisites

Install the following before you start. Use the recommended installers below.

| Tool | Where to get it | Notes |
|---|---|---|
| **Git** | https://git-scm.com/download/win | Use default options |
| **Node.js 20+** | https://nodejs.org (LTS) | Adds `node` + `npm` to PATH |
| **pnpm** | `npm install -g pnpm` in a terminal | Package manager for this monorepo |
| **GCP Service Account JSON** | GCP Console → IAM → Service Accounts | Download the key file for Vertex AI access |

> **Optional but recommended**: Use [Windows Terminal](https://aka.ms/terminal) for a better
> terminal experience. All commands below work in PowerShell or Command Prompt.

---

## 1 — Clone the repository

```powershell
git clone <YOUR_REPO_URL> cdr-observability
cd cdr-observability
```

---

## 2 — Install dependencies

```powershell
pnpm install
```

This installs all packages for every workspace (api-server, cw-recorder, shared libs, etc.).

---

## 3 — Configure environment variables

```powershell
# Copy the example file
copy .env.example .env
```

Open `.env` in Notepad (or any editor) and fill in the required values:

```env
# Port the API server listens on
PORT=3000

# CommonWell portal login
CW_USERNAME=your-username@example.com
CW_PASSWORD=your-portal-password

# GCP Vertex AI — paste the full contents of your service account JSON on ONE line
GCP_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

> **Tip — pasting JSON on one line**: Open your `.json` key file, copy everything,
> then in PowerShell run:
> ```powershell
> $json = Get-Content "path\to\your-key.json" -Raw
> $json -replace "`r`n","\n" -replace "`n","\n"
> ```
> Paste the output as the `GCP_SERVICE_ACCOUNT_JSON` value (keep it on a single line,
> wrapped in double quotes if your shell requires it).

---

## 4 — Install Playwright's Chromium browser

The API server does this automatically on first `dev` start, but you can also run it
manually upfront:

```powershell
npx --yes playwright install chromium
```

This downloads ~150 MB of Chromium into your local Playwright cache. Only needed once.

---

## 5 — Start the servers

Open **two separate terminal windows/tabs** in the project root.

### Terminal 1 — API server

```powershell
pnpm --filter @workspace/api-server run dev
```

Expected output:
```
Playwright is installing missing browsers...
Server listening on port 3000
Hourly monitor scheduler registered (every hour)
```

### Terminal 2 — React frontend (CW Recorder)

```powershell
pnpm --filter @workspace/cw-recorder run dev
```

Expected output:
```
  VITE v6.x.x  ready in XXX ms

  ➜  Local:   http://localhost:5173/
```

---

## 6 — Open the app

Navigate to **http://localhost:5173/** in your browser.

> **Important**: The frontend proxies API calls to `http://localhost:3000` via Vite's
> dev server. Both servers must be running for the app to work.

---

## Using the PAR Demo

1. Click **PAR Demo** in the top navigation.
2. Choose a search mode:
   - **Date Range** — pick a preset (last 24 h / 7 d / 30 d) or custom dates.
   - **Transaction ID** — type a specific CW transaction ID and press Enter or click Run.
3. Click **Run PAR Demo**.
4. The browser navigates the CommonWell portal automatically.  
   When prompted, enter the **6-digit OTP** sent to your email.
5. Vertex AI (Gemini 2.5 Flash) summarises the results once extraction completes.

---

## Windows-specific notes

### PATH issues with `pnpm`

If `pnpm` is not found after `npm install -g pnpm`, close and reopen your terminal
(PATH is refreshed on new sessions). Alternatively:

```powershell
# Add to your PowerShell profile or run each session:
$env:PATH += ";$env:APPDATA\npm"
```

### Long path errors (git clone / pnpm install)

Enable long paths in Windows:

```powershell
# Run as Administrator
git config --system core.longpaths true
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

### Playwright Chromium on Windows

Playwright installs Chromium into `%LOCALAPPDATA%\ms-playwright`. If you see
`Executable doesn't exist` errors, re-run:

```powershell
npx playwright install chromium
```

### Antivirus / Firewall

Some antivirus tools block Playwright's Chromium from launching. Add an exclusion for:
```
%LOCALAPPDATA%\ms-playwright\
```

### Screenshots / Sessions directory

On Windows, Playwright writes sessions to `%TEMP%\cw-sessions` and screenshots to
`%TEMP%\cw-screenshots` by default (the app uses `os.tmpdir()` which resolves correctly
on Windows).

---

## Running both servers with a single command (optional)

Install `concurrently` globally:

```powershell
npm install -g concurrently
```

Then from the project root:

```powershell
concurrently `
  "pnpm --filter @workspace/api-server run dev" `
  "pnpm --filter @workspace/cw-recorder run dev"
```

Or add this to the root `package.json` `scripts`:

```json
"dev:local": "concurrently \"pnpm --filter @workspace/api-server run dev\" \"pnpm --filter @workspace/cw-recorder run dev\""
```

Then run `pnpm run dev:local`.

---

## Ports summary

| Service | Default port | URL |
|---|---|---|
| API server | 3000 | http://localhost:3000/api/health |
| CW Recorder (frontend) | 5173 | http://localhost:5173/ |

Change `PORT=3000` in `.env` if 3000 is in use. The Vite proxy automatically picks up
the `PORT` env var via `vite.config.ts`.

---

## Environment variables quick reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | API server port (default 3000) |
| `CW_USERNAME` | Yes | CommonWell portal email |
| `CW_PASSWORD` | Yes | CommonWell portal password |
| `GCP_SERVICE_ACCOUNT_JSON` | Yes (for AI) | Full GCP service account JSON, single line |
| `GCP_PROJECT_ID` | Alt. to JSON | Use instead of JSON when on GKE with Workload Identity |
| `SESSION_MAX_AGE_HOURS` | No | Hours before re-auth required (default 24) |
| `VERTEX_MODEL_ID` | No | Gemini model (default `gemini-2.5-flash`) |
| `VERTEX_LOCATION` | No | GCP region (default `us-central1`) |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm`, then restart terminal |
| `Cannot find module '@workspace/...'` | Run `pnpm install` from the repo root |
| `Error: browserType.launch: Executable doesn't exist` | `npx playwright install chromium` |
| `fetch failed` / API not reachable | Ensure api-server is running on port 3000 |
| OTP not arriving | Check your CW account email; ensure `CW_USERNAME` is correct |
| Vertex AI `PERMISSION_DENIED` | Check `GCP_SERVICE_ACCOUNT_JSON` — ensure it's on one line with `\n` in the key |
| Port 3000 already in use | Change `PORT=3001` in `.env`; also update `vite.config.ts` proxy target |
| Long paths error on `pnpm install` | Enable Windows long paths (see above) |

---

## Stopping the servers

Press **Ctrl+C** in each terminal window.
