import { Express } from "express";
import fs from "fs";
import path from "path";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import { getPlaywrightService } from "../services/playwright-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CwTransactionRecord = Record<string, any>;

type RunnerPhase =
  | "idle"
  | "login:started"
  | "otp:waiting"
  | "navigating"
  | "extracting"
  | "reporting"
  | "complete"
  | "error";

interface RunnerState {
  phase: RunnerPhase;
  daysBack: number;
  transactionId: string | null;
  searchMode: "date" | "transaction_id";
  recordCount: number;
  errorCount: number;
  errorMessage: string | null;
  reportFile: string | null;
  screenshotUrls: string[];
}

let state: RunnerState = {
  phase: "idle",
  daysBack: 7,
  transactionId: null,
  searchMode: "date",
  recordCount: 0,
  errorCount: 0,
  errorMessage: null,
  reportFile: null,
  screenshotUrls: [],
};

let otpResolver: ((otp: string) => void) | null = null;
let otpRejecter: ((err: Error) => void) | null = null;

function waitForOtp(): Promise<string> {
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
  });
}

const REPORT_DIR = "/tmp/cw-reports";

function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GCP_SERVICE_ACCOUNT_JSON not set");
  const serviceAccount = JSON.parse(serviceAccountJson) as { project_id: string };
  const vertex = createVertex({
    project: serviceAccount.project_id,
    location: "us-central1",
    googleAuthOptions: { credentials: serviceAccount },
  });
  return vertex(process.env.VERTEX_MODEL_ID || "gemini-2.5-flash");
}

async function generateReport(records: CwTransactionRecord[]): Promise<string> {
  const model = createVertexModel();

  const errorRecords = records.filter(
    (r) =>
      r.status?.toLowerCase().includes("error") ||
      r.status?.toLowerCase().includes("fail")
  );

  const sampleSize = Math.min(records.length, 600);
  const sample = records.slice(0, sampleSize);

  const { text } = await generateText({
    model,
    prompt: `You are a CommonWell Health Alliance transaction analyst.

Analyze the following transaction records and generate a comprehensive markdown error analysis report.

Summary stats:
- Total records: ${records.length}
- Error/failure records: ${errorRecords.length}
- Sample shown: first ${sampleSize} of ${records.length}

Transaction records (JSON):
${JSON.stringify(sample, null, 2)}

Generate a well-structured markdown report with:
1. **Executive Summary** — total transactions, error rate, date range covered
2. **Error Breakdown** — errors grouped by status/type with counts
3. **Affected Organizations** — which orgs have the most errors
4. **Transaction Type Analysis** — which transaction types fail most
5. **Timeline** — errors distribution over time (if timestamps available)
6. **Top Issues and Recommendations** — actionable next steps

Use tables where useful. Be specific and data-driven.`,
    maxTokens: 8192,
  });

  return text;
}

async function runPipeline(daysBack: number, transactionId: string | null) {
  const pw = getPlaywrightService();
  const username = process.env.CW_USERNAME;
  const password = process.env.CW_PASSWORD;

  if (!username || !password) {
    state.phase = "error";
    state.errorMessage = "CW_USERNAME or CW_PASSWORD environment variable not set";
    return;
  }

  try {
    state.phase = "login:started";
    console.log("[CW Runner] Starting login...");
    const { needsOtp, screenshotUrl } = await pw.login(username, password);
    if (screenshotUrl) state.screenshotUrls = [screenshotUrl];

    if (needsOtp) {
      state.phase = "otp:waiting";
      console.log("[CW Runner] Waiting for OTP from user...");
      const otp = await waitForOtp();
      console.log("[CW Runner] OTP received, submitting...");
      const { success, screenshotUrl: otpShot } = await pw.submitOtp(otp);
      if (otpShot) state.screenshotUrls.push(otpShot);
      if (!success) throw new Error("OTP submission failed — check the code and try again");
    }

    state.phase = "navigating";
    console.log("[CW Runner] Navigating to transaction logs...");
    const navShot = await pw.navigateToTransactionLogs();
    if (navShot) state.screenshotUrls.push(navShot);

    let filterShot: string;
    if (transactionId) {
      console.log(`[CW Runner] Searching by transaction ID: ${transactionId}`);
      filterShot = await pw.searchByTransactionId(transactionId);
    } else {
      console.log(`[CW Runner] Applying ${daysBack}-day date filter...`);
      filterShot = await pw.applyDateFilter(daysBack);
    }
    if (filterShot) state.screenshotUrls.push(filterShot);

    state.phase = "extracting";
    console.log("[CW Runner] Extracting transactions...");
    const { records, screenshotUrl: extractShot } = await pw.extractTransactions(0);
    if (extractShot) state.screenshotUrls.push(extractShot);

    state.recordCount = records.length;
    state.errorCount = records.filter(
      (r) =>
        r.status?.toLowerCase().includes("error") ||
        r.status?.toLowerCase().includes("fail")
    ).length;
    console.log(`[CW Runner] Extracted ${records.length} records, ${state.errorCount} errors`);

    state.phase = "reporting";
    console.log("[CW Runner] Generating report with LLM...");
    const report = await generateReport(records);

    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(REPORT_DIR, `cw-report-${ts}.md`);
    fs.writeFileSync(file, report, "utf8");
    state.reportFile = file;

    state.phase = "complete";
    console.log(`[CW Runner] Complete. Report saved: ${file}`);
  } catch (err) {
    state.phase = "error";
    state.errorMessage = (err as Error).message;
    console.error("[CW Runner] Pipeline error:", state.errorMessage);
  } finally {
    otpResolver = null;
    otpRejecter = null;
  }
}

function resetState(): void {
  state = {
    phase: "idle",
    daysBack: 7,
    transactionId: null,
    searchMode: "date",
    recordCount: 0,
    errorCount: 0,
    errorMessage: null,
    reportFile: null,
    screenshotUrls: [],
  };
}

export function registerCwRunnerRoutes(app: Express) {
  app.post("/api/cw/run", async (req, res) => {
    const running = state.phase !== "idle" && state.phase !== "complete" && state.phase !== "error";
    if (running) {
      return res.status(409).json({ error: "A run is already in progress", phase: state.phase });
    }

    const { daysBack = 7, transactionId = null } = req.body as {
      daysBack?: number;
      transactionId?: string | null;
    };

    if (otpRejecter) otpRejecter(new Error("Cancelled by new run"));
    const pw = getPlaywrightService();
    try { await pw.close(); } catch {}

    resetState();
    state.daysBack = Number(daysBack) || 7;
    state.transactionId = transactionId || null;
    state.searchMode = transactionId ? "transaction_id" : "date";

    runPipeline(state.daysBack, state.transactionId).catch(console.error);

    res.json({ started: true, daysBack: state.daysBack, transactionId: state.transactionId });
  });

  app.post("/api/cw/otp", (req, res) => {
    if (state.phase !== "otp:waiting") {
      return res.status(400).json({ error: `Not waiting for OTP (phase: ${state.phase})` });
    }
    const { otp } = req.body as { otp: string };
    if (!otp?.trim()) {
      return res.status(400).json({ error: "OTP is required" });
    }
    if (!otpResolver) {
      return res.status(500).json({ error: "OTP resolver not ready" });
    }
    otpResolver(otp.trim());
    res.json({ accepted: true });
  });

  app.get("/api/cw/status", (_req, res) => {
    const pw = getPlaywrightService();
    res.json({
      ...state,
      liveExtractionPage: pw.liveExtractionPage,
      liveExtractionCount: pw.liveExtractionCount,
    });
  });

  app.post("/api/cw/reset", async (_req, res) => {
    if (otpRejecter) otpRejecter(new Error("Run cancelled"));
    const pw = getPlaywrightService();
    try { await pw.close(); } catch {}
    resetState();
    res.json({ reset: true });
  });

  app.get("/api/cw/report", (_req, res) => {
    if (!state.reportFile || !fs.existsSync(state.reportFile)) {
      return res.status(404).json({ error: "No report available" });
    }
    const date = new Date().toISOString().split("T")[0];
    res.download(state.reportFile, `cw-report-${date}.md`);
  });

  app.head("/api/cw/report", (_req, res) => {
    if (!state.reportFile || !fs.existsSync(state.reportFile)) {
      return res.status(404).end();
    }
    res.status(200).end();
  });
}
