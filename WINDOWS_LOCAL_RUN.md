# CDR Observability — Windows Local Run Guide

Run the full CDR Observability stack on a Windows machine without Docker or WSL.

---

## Quick summary

| Thing | Value |
|---|---|
| API server port | **8080** (hardcoded — do not change) |
| Frontend (Vite) port | **5173** (default) |
| Open in browser | http://localhost:5173/ |
| API health check | http://localhost:8080/api/health |
| Credentials file | `artifacts\api-server\.env` |

---

## Prerequisites

| Tool | Download | Notes |
|---|---|---|
| **Git** | https://git-scm.com/download/win | Default options are fine |
| **Node.js 20+ LTS** | https://nodejs.org | Adds `node` and `npm` to PATH |
| **pnpm** | `npm install -g pnpm` after Node | Monorepo package manager |
| **gcloud CLI** | https://cloud.google.com/sdk/docs/install | Required for ADC login |

> Tip: Use [Windows Terminal](https://aka.ms/terminal).

---

## Step-by-step setup

### 1. Clone the repo

```powershell
git clone <YOUR_REPO_URL> cdr-observability
cd cdr-observability
```

### 2. Install all packages

```powershell
pnpm install
```

### 3. Set up GCP credentials (ADC — recommended for corporate use)

ADC (Application Default Credentials) lets you log in with your Google account
instead of managing a JSON key file. This is the preferred approach in most company
environments.

```powershell
# Step 1 — log in with your Google account
gcloud auth application-default login
# A browser window opens; sign in with your company Google account.
# On success you'll see: Credentials saved to file [...\application_default_credentials.json]

# Step 2 — set your project
gcloud config set project YOUR_GCP_PROJECT_ID
```

Then open `artifacts\api-server\.env` and set your project ID:

```env
GCP_PROJECT_ID=your-gcp-project-id
```

Leave `GCP_SERVICE_ACCOUNT_JSON` commented out (or remove it entirely).

---

### Alternative: Service Account JSON key (no gcloud CLI needed)

If you prefer to use a downloaded JSON key file instead of ADC:

```powershell
# Convert key file to one line in PowerShell:
$raw = Get-Content "your-key-file.json" -Raw
$oneLine = $raw.Trim() -replace "`r`n", "\n" -replace "`n", "\n"
Write-Output $oneLine
# Copy the output, then paste it as GCP_SERVICE_ACCOUNT_JSON in .env
```

In `artifacts\api-server\.env`:

```env
# Comment out or remove GCP_PROJECT_ID
# GCP_PROJECT_ID=...

GCP_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}
```

---

### 4. Fill in CommonWell credentials

In `artifacts\api-server\.env`:

```env
PORT=8080                          # keep exactly as-is
CW_USERNAME=your.email@company.com
CW_PASSWORD=your-portal-password
GCP_PROJECT_ID=your-gcp-project-id # for ADC (Option A)
```

### 5. Install Playwright's Chromium browser (one-time, ~150 MB)

```powershell
npx --yes playwright install chromium
```

---

## Running the app

Open **two separate PowerShell windows** in the project root.

### Terminal 1 — API server

```powershell
pnpm --filter @workspace/api-server run dev
```

Wait for:
```
Server listening on port 8080
```

### Terminal 2 — React frontend

```powershell
pnpm --filter @workspace/cw-recorder run dev
```

Wait for:
```
  ➜  Local:   http://localhost:5173/
```

Open **http://localhost:5173/** in your browser.

---

## Optional: run both servers with one command

```powershell
npm install -g concurrently
concurrently `
  "pnpm --filter @workspace/api-server run dev" `
  "pnpm --filter @workspace/cw-recorder run dev"
```

---

## How the two auth options work

The server checks env vars in this order:

| Check | Result |
|---|---|
| `GCP_SERVICE_ACCOUNT_JSON` is set | Uses that key directly (Option B) |
| `GCP_PROJECT_ID` is set, no JSON | Uses ADC / gcloud credentials (Option A) |
| Neither is set | Server starts but AI features fail with a clear error |

You only need one of the two. ADC is preferred for corporate environments because
it uses your company Google account and respects IAM policies without distributing
JSON key files.

---

## ADC token refresh

ADC tokens expire. If AI features stop working, re-run:

```powershell
gcloud auth application-default login
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm` then restart terminal |
| `Cannot find module '@workspace/...'` | `pnpm install` from the repo root |
| `Executable doesn't exist` (Playwright) | `npx playwright install chromium` |
| Blank page at :5173 | Ensure the API server is running on port 8080 |
| `PORT environment variable is required` | `.env` is missing — check `artifacts\api-server\.env` |
| OTP not arriving | Verify `CW_USERNAME` is your correct CW portal email |
| `PERMISSION_DENIED` from Vertex AI (ADC) | Re-run `gcloud auth application-default login` |
| `PERMISSION_DENIED` from Vertex AI (JSON) | Check `GCP_SERVICE_ACCOUNT_JSON` is on one line |
| Port 8080 in use | `netstat -ano \| findstr :8080` then kill that process |
| Long paths error on `pnpm install` | See below |

### Long path fix (run PowerShell as Administrator once)

```powershell
git config --system core.longpaths true
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

Restart your terminal after running this.

---

## File locations

```
cdr-observability\
├── artifacts\
│   └── api-server\
│       └── .env          ← edit this file with your credentials
├── WINDOWS_LOCAL_RUN.md  ← this file
└── pnpm-workspace.yaml
```
