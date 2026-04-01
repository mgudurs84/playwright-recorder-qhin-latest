# Running Locally on Windows

Step-by-step instructions for running **CW Transaction Analyzer** and **CW Recorder** on a Windows machine.

---

## Prerequisites

Install the following before you begin:

| Tool | Version | Download |
|------|---------|----------|
| Node.js | 20 or later | https://nodejs.org/ |
| pnpm | latest | `npm install -g pnpm` (run after Node.js) |
| Git | any recent | https://git-scm.com/download/win |
| gcloud CLI | optional (GCP auth) | https://cloud.google.com/sdk/docs/install-sdk#windows |

> **VPN note:** Both tools connect to the CommonWell integration portal. If your organization requires a VPN to reach CommonWell, connect to VPN before starting the servers.

---

## First-Time Setup

After cloning the repo, install all workspace dependencies from the repo root:

```powershell
pnpm install
```

This installs dependencies for every package in the monorepo at once.

---

## CW Transaction Analyzer

The Transaction Analyzer is made up of two pieces that run in **two separate terminals**:

- `tx-analyzer-api` — Express API on port **8000**
- `cw-tx-analyzer` — Vite/React frontend on port **5173**

### 1. Configure the API environment

Open `artifacts/tx-analyzer-api/.env` in any text editor and fill in your values:

> **Important:** The app reads `.env` directly — do not copy it to `.env.local` (that file is not loaded). Edit `.env` in place and do not commit it.

```env
# Required
CW_USERNAME=your_commonwell_email@example.com
CW_PASSWORD=your_commonwell_password
CW_PORTAL_URL=https://integration.commonwellalliance.lkopera.com

# GCP — see the "GCP Auth" section below
GCP_PROJECT_ID=your-gcp-project-id

# Optional (defaults shown)
VERTEX_MODEL_ID=gemini-2.5-flash
VERTEX_LOCATION=us-central1
SESSION_MAX_AGE_HOURS=24
```

To prevent accidentally committing credentials, you can tell Git to ignore changes to this file:

```powershell
git update-index --skip-worktree artifacts/tx-analyzer-api/.env
```

### 2. Start the API server (Terminal 1)

```powershell
cd artifacts\tx-analyzer-api
pnpm dev
```

The first run downloads the Playwright Chromium browser — this can take a minute or two.
Once you see `Listening on port 8000`, the API is ready.

### 3. Start the frontend (Terminal 2)

```powershell
cd artifacts\cw-tx-analyzer
pnpm dev
```

Once Vite prints the local URL, open your browser to:

```
http://localhost:5173/cw-tx-analyzer/
```

---

## CW Recorder

The Recorder is also made up of two pieces that run in **two separate terminals**:

- `api-server` — Express API on port **8080**
- `cw-recorder` — Vite/React frontend on port **5173**

> If you are running both tools at the same time, the frontends share port 5173 — run only one frontend at a time, or change `PORT` in the relevant `.env` file.

### 1. Configure the API environment

Copy the example environment file and fill in your values:

```powershell
copy artifacts\api-server\.env.example artifacts\api-server\.env
```

Open `artifacts/api-server/.env` and update the fields:

```env
# Required
PORT=8080
CW_USERNAME=your_commonwell_email@example.com
CW_PASSWORD=your_commonwell_password

# GCP — see the "GCP Auth" section below
GCP_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
# or, if using ADC:
# GCP_PROJECT_ID=your-gcp-project-id

# Optional (defaults shown)
VERTEX_MODEL_ID=gemini-2.5-flash
SESSION_MAX_AGE_HOURS=24
```

See `artifacts/api-server/.env.example` for the full reference file.

### 2. Configure the frontend environment

```powershell
copy artifacts\cw-recorder\.env.example artifacts\cw-recorder\.env
```

The defaults in `.env.example` work for local development as-is:

```env
PORT=5173
BASE_PATH=/
NODE_ENV=development
```

See `artifacts/cw-recorder/.env.example` for the full reference file.

### 3. Start the API server (Terminal 1)

```powershell
cd artifacts\api-server
pnpm dev
```

The first run downloads the Playwright Chromium browser.
Once you see `Listening on port 8080`, the API is ready.

### 4. Start the frontend (Terminal 2)

```powershell
cd artifacts\cw-recorder
pnpm dev
```

Once Vite prints the local URL, open your browser to:

```
http://localhost:5173/
```

---

## GCP Auth

Both API servers need Google Cloud credentials to call Vertex AI (Gemini). Choose one option:

### Option A — Application Default Credentials (recommended for corporate use)

No JSON key file required. Uses your personal gcloud login.

1. Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install-sdk#windows)
2. Run in any terminal:
   ```powershell
   gcloud auth application-default login
   ```
3. In your `.env` file, set `GCP_PROJECT_ID` and leave `GCP_SERVICE_ACCOUNT_JSON` blank (or commented out).

### Option B — Service Account JSON key

Paste the entire contents of your GCP service account key file on a **single line** in the `.env`:

```env
GCP_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"your-project","private_key":"-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n","client_email":"name@project.iam.gserviceaccount.com",...}
```

Leave `GCP_PROJECT_ID` blank when using Option B (the project ID is embedded in the JSON).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Error: listen EADDRINUSE :::8000` or `:::8080` | Another process is using the port | Run `netstat -ano \| findstr :8000` to find the PID, then `taskkill /PID <pid> /F`, or change `PORT` in `.env` |
| `Error: listen EADDRINUSE :::5173` | Both frontends started at the same time | Stop one frontend, or set a different `PORT` in its `.env` |
| Playwright Chromium download fails / hangs | Firewall or antivirus blocking the download | Add a firewall exception for Node.js, or download Chromium manually via `pnpm exec playwright install chromium` with antivirus paused |
| `Missing required env var` error on startup | `.env` file not created or a value left blank | Make sure you copied `.env.example` to `.env` and filled in all required fields |
| Cannot reach CommonWell portal | VPN not connected | Connect to your organization's VPN, then restart the API server |
| `google.auth.exceptions.DefaultCredentialsError` | GCP credentials not configured | Follow the GCP Auth section above (Option A or Option B) |
| `pnpm: command not found` | pnpm not installed globally | Run `npm install -g pnpm` in an Administrator PowerShell, then reopen your terminal |
| Login shows "HTTP 404" | API server not running | Start the API server terminal first (`pnpm dev` in `artifacts\tx-analyzer-api` or `artifacts\api-server`). The frontend can load without the API, but all calls will 404 until the API is up. |
| API calls return 404 after the API is running | Port mismatch or wrong base path | Confirm `PORT` in the API `.env` matches what the frontend proxies to (8000 for TX Analyzer, 8080 for Recorder). Open the app at the correct URL (see "open your browser to" in each section above). |
