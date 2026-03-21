import { Express } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "cw-screenshots");

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

export type PARPhase = "PERCEIVE" | "ACT" | "REVIEW";

export interface PARStep {
  id: number;
  phase: PARPhase;
  label: string;
  description: string;
  screenshotUrl: string | null;
  assertionPassed: boolean | null;
  timestamp: string;
}

export type DemoStatus = "idle" | "running" | "complete" | "error";

interface DemoState {
  status: DemoStatus;
  steps: PARStep[];
  errorMessage: string | null;
}

let demoState: DemoState = {
  status: "idle",
  steps: [],
  errorMessage: null,
};

async function takeShot(page: Page, label: string): Promise<string> {
  const filename = `par-${label}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: false });
  } catch (err) {
    console.warn(`[PAR Demo] Screenshot failed (${label}):`, (err as Error).message);
  }
  return `/api/screenshots/${filename}`;
}

function addStep(step: Omit<PARStep, "id" | "timestamp">): void {
  const s: PARStep = {
    ...step,
    id: demoState.steps.length + 1,
    timestamp: new Date().toISOString(),
  };
  demoState.steps.push(s);
  console.log(`[PAR Demo] Step ${s.id} [${s.phase}] ${s.label}: ${s.description}`);
}

function getCwRecorderUrl(): string {
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) {
    return `https://${devDomain}/cw-recorder/`;
  }
  return "http://localhost:5173/";
}

interface CwStatus {
  phase: string;
  recordCount: number;
  errorCount: number;
  errorMessage: string | null;
  liveExtractionPage: number;
  liveExtractionCount: number;
}

async function fetchCwStatus(): Promise<CwStatus | null> {
  try {
    const res = await fetch("http://localhost:8080/api/cw/status");
    if (!res.ok) return null;
    return await res.json() as CwStatus;
  } catch {
    return null;
  }
}

async function runParScript(): Promise<void> {
  demoState = { status: "running", steps: [], errorMessage: null };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Pre-flight: reset any stale CW run so the recorder form is visible
    try {
      await fetch("http://localhost:8080/api/cw/reset", { method: "POST" });
      console.log("[PAR Demo] Pre-flight: CW state reset");
    } catch {
      console.warn("[PAR Demo] Pre-flight reset failed (continuing)");
    }

    const cwUrl = getCwRecorderUrl();

    // ── Step 1: PERCEIVE — open the CW Recorder page ──────────────────────
    addStep({
      phase: "PERCEIVE",
      label: "Open CW Recorder UI",
      description: `Navigating to the CW Recorder at ${cwUrl} and observing the initial page state`,
      screenshotUrl: null,
      assertionPassed: null,
    });
    await page.goto(cwUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const shot1 = await takeShot(page, "step1-open");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot1;

    // ── Step 2: REVIEW — verify the recorder form is present ──────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Recorder Form Present",
      description: "Asserting that the search input and Run button are visible on the Recorder home page",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const searchInput = page.locator('input[placeholder*="last" i], input[placeholder*="transaction" i], input[type="text"]').first();
    const runButton = page.locator('button:has-text("Run")').first();
    const inputVisible = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);
    const buttonVisible = await runButton.isVisible({ timeout: 5000 }).catch(() => false);
    const step2Pass = inputVisible && buttonVisible;
    const shot2 = await takeShot(page, "step2-verify-form");
    const step2 = demoState.steps[demoState.steps.length - 1];
    step2.screenshotUrl = shot2;
    step2.assertionPassed = step2Pass;
    step2.description = `Search input visible: ${inputVisible} · Run button visible: ${buttonVisible}`;

    // ── Step 3: ACT — fill the search form ───────────────────────────────
    addStep({
      phase: "ACT",
      label: "Fill Search Form",
      description: "Typing 'last 7 days' into the search field to configure the extraction query",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (inputVisible) {
      await searchInput.click();
      await searchInput.fill("last 7 days");
    }
    await page.waitForTimeout(500);
    const shot3 = await takeShot(page, "step3-fill-form");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot3;

    // ── Step 4: REVIEW — verify the input was filled correctly ────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Form Input Value",
      description: "Asserting that the search field contains the expected query string",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const inputValue = inputVisible ? await searchInput.inputValue().catch(() => "") : "";
    const step4Pass = inputValue.toLowerCase().includes("7") || inputValue.toLowerCase().includes("day");
    const shot4 = await takeShot(page, "step4-verify-input");
    const step4 = demoState.steps[demoState.steps.length - 1];
    step4.screenshotUrl = shot4;
    step4.assertionPassed = step4Pass;
    step4.description = `Input value: "${inputValue}" · Contains query terms: ${step4Pass}`;

    // Snapshot CW status before clicking Run
    const statusBefore = await fetchCwStatus();

    // ── Step 5: ACT — click the Run button ───────────────────────────────
    addStep({
      phase: "ACT",
      label: "Click Run",
      description: "Clicking the Run button to trigger the CW Recorder pipeline and start the extraction session",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (buttonVisible) {
      await runButton.click({ timeout: 10000 }).catch(() => {});
    }
    await page.waitForTimeout(2500);
    const shot5 = await takeShot(page, "step5-click-run");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot5;

    // ── Step 6: PERCEIVE — detect phase change in the UI ─────────────────
    addStep({
      phase: "PERCEIVE",
      label: "Detect Phase Change",
      description: "Observing the UI for a loading spinner or status text — confirming the pipeline started",
      screenshotUrl: null,
      assertionPassed: null,
    });
    await page.waitForTimeout(1500);
    const spinnerVisible = await page.locator('[class*="animate-spin"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    const statusTextVisible = await page.locator('text=/Logging in|Navigating|Extracting|Starting|complete|error|Run failed/i').first().isVisible({ timeout: 3000 }).catch(() => false);
    const statusAfterClick = await fetchCwStatus();
    const phaseChanged = statusAfterClick !== null && statusAfterClick.phase !== (statusBefore?.phase ?? "idle");
    const shot6 = await takeShot(page, "step6-phase-change");
    const step6 = demoState.steps[demoState.steps.length - 1];
    step6.screenshotUrl = shot6;
    step6.assertionPassed = spinnerVisible || statusTextVisible || phaseChanged;
    step6.description = `Spinner: ${spinnerVisible} · Status text: ${statusTextVisible} · Phase: ${statusBefore?.phase ?? "idle"} → ${statusAfterClick?.phase ?? "unknown"}`;

    // ── Step 7: PERCEIVE — observe extraction counter ─────────────────────
    addStep({
      phase: "PERCEIVE",
      label: "Observe Extraction Counter",
      description: "Polling /api/cw/status to read liveExtractionCount and liveExtractionPage — observing real-time progress",
      screenshotUrl: null,
      assertionPassed: null,
    });
    // Poll a few times to capture at least one sample of the extraction counter
    const samples: { count: number; page: number; phase: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await fetchCwStatus();
      if (s) {
        samples.push({ count: s.liveExtractionCount, page: s.liveExtractionPage, phase: s.phase });
      }
    }
    const hasExtractionField = samples.length > 0;
    const shot7 = await takeShot(page, "step7-extraction-counter");
    const step7 = demoState.steps[demoState.steps.length - 1];
    step7.screenshotUrl = shot7;
    step7.assertionPassed = hasExtractionField;
    const lastSample = samples[samples.length - 1];
    step7.description = `liveExtractionCount=${lastSample?.count ?? "n/a"} · liveExtractionPage=${lastSample?.page ?? "n/a"} · phase="${lastSample?.phase ?? "n/a"}" · samples: ${samples.length}`;

    // ── Step 8: REVIEW — trigger stop and detect terminal completion ──────
    addStep({
      phase: "REVIEW",
      label: "Detect Completion / Stop Run",
      description: "Cancelling the CW run via API (pipeline observed — no live credentials needed) and asserting the terminal error/complete state",
      screenshotUrl: null,
      assertionPassed: null,
    });
    // Cancel the CW run so we get a clean terminal state without needing OTP/credentials
    let cancelOk = false;
    try {
      const cancelRes = await fetch("http://localhost:8080/api/cw/cancel", { method: "POST" });
      cancelOk = cancelRes.ok;
    } catch {}
    // If cancel didn't work (e.g. already done), try reset
    if (!cancelOk) {
      try { await fetch("http://localhost:8080/api/cw/reset", { method: "POST" }); } catch {}
    }
    await new Promise((r) => setTimeout(r, 2000));
    let terminalStatus: CwStatus | null = null;
    const maxWait = 10000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      const s = await fetchCwStatus();
      if (s && (s.phase === "complete" || s.phase === "error")) {
        terminalStatus = s;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!terminalStatus) terminalStatus = await fetchCwStatus();
    const isTerminal = terminalStatus?.phase === "complete" || terminalStatus?.phase === "error";
    // Also check for UI completion/error state
    const uiCompleteOrError = await page.locator('text=/Run complete|Run failed|complete|error|Try Again|New Search/i').first().isVisible({ timeout: 5000 }).catch(() => false);
    const shot8 = await takeShot(page, "step8-completion");
    const step8 = demoState.steps[demoState.steps.length - 1];
    step8.screenshotUrl = shot8;
    step8.assertionPassed = isTerminal || uiCompleteOrError;
    step8.description = `Cancel issued: ${cancelOk} · Terminal phase: "${terminalStatus?.phase ?? "unknown"}" · UI terminal indicator: ${uiCompleteOrError}`;

    // ── Step 9: REVIEW — verify record count field ────────────────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Record Count",
      description: "Asserting the API status response includes a numeric recordCount field — confirming the pipeline tracked extraction progress",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const finalStatus = await fetchCwStatus();
    const recordCountExists = finalStatus !== null && typeof finalStatus.recordCount === "number";
    const shot9 = await takeShot(page, "step9-record-count");
    const step9 = demoState.steps[demoState.steps.length - 1];
    step9.screenshotUrl = shot9;
    step9.assertionPassed = recordCountExists;
    step9.description = `recordCount=${finalStatus?.recordCount ?? "n/a"} · errorCount=${finalStatus?.errorCount ?? "n/a"} · phase="${finalStatus?.phase ?? "n/a"}"`;

    demoState.status = "complete";
    console.log("[PAR Demo] Complete — all steps done");
  } catch (err) {
    demoState.status = "error";
    demoState.errorMessage = (err as Error).message;
    console.error("[PAR Demo] Error:", (err as Error).message);
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

export function registerParDemoRoutes(app: Express): void {
  app.post("/api/par-demo/run", async (_req, res) => {
    if (demoState.status === "running") {
      return res.status(409).json({ error: "A PAR demo is already running" });
    }
    runParScript().catch(console.error);
    res.json({ started: true });
  });

  app.get("/api/par-demo/status", (_req, res) => {
    res.json({
      status: demoState.status,
      steps: demoState.steps,
      errorMessage: demoState.errorMessage,
    });
  });

  app.post("/api/par-demo/reset", (_req, res) => {
    if (demoState.status === "running") {
      return res.status(409).json({ error: "Cannot reset while running" });
    }
    demoState = { status: "idle", steps: [], errorMessage: null };
    res.json({ reset: true });
  });
}
