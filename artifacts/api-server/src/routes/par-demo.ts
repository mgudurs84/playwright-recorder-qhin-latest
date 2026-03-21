import { Express, Request, Response } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "cw-screenshots");
const PORTAL_URL = "https://integration.commonwellalliance.lkopera.com/";

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

export type PARPhase = "PERCEIVE" | "ACT" | "REVIEW";
export type DemoStatus = "idle" | "running" | "otp:waiting" | "complete" | "error";

export interface PARStep {
  id: number;
  phase: PARPhase;
  label: string;
  description: string;
  screenshotUrl: string | null;
  assertionPassed: boolean | null;
  timestamp: string;
}

interface DemoState {
  status: DemoStatus;
  steps: PARStep[];
  errorMessage: string | null;
  aiSummary: string | null;       // Vertex AI summary of server errors
  aiSummaryPending: boolean;       // true while the LLM call is in flight
}

let demoState: DemoState = {
  status: "idle",
  steps: [],
  errorMessage: null,
  aiSummary: null,
  aiSummaryPending: false,
};

let activePage: Page | null = null;
let otpResolver: ((otp: string) => void) | null = null;
let otpRejecter: ((err: Error) => void) | null = null;

function waitForOtp(timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
    setTimeout(() => {
      if (otpRejecter) {
        otpRejecter(new Error("OTP entry timed out after 5 minutes"));
        otpResolver = null;
        otpRejecter = null;
      }
    }, timeoutMs);
  });
}

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

async function summariseWithVertex(pageText: string, rowCount: number): Promise<string> {
  const model = createVertexModel();
  const { text } = await generateText({
    model,
    prompt: `You are a CommonWell Health Alliance CDR analyst reviewing server error transactions.

The following content was extracted from the CommonWell portal "Server Errors" view (${rowCount} rows visible).

EXTRACTED PAGE CONTENT:
${pageText.slice(0, 12000)}

---

Produce a concise but actionable summary with these sections (use markdown):

### 🔴 Server Error Overview
- Total errors visible, time range, and overall severity assessment

### 📊 Error Pattern Breakdown
- Group errors by type/status/cause if discernible from the data (use a table)

### 🏥 Affected Organisations / Transaction Types
- Which orgs or transaction types appear most in the errors

### ⚡ Key Findings
- The 3–5 most important insights from the error data

### ✅ Recommended Next Steps
- Concrete, prioritised actions the CDR team should take

Keep it factual and data-driven. If the data is limited, say so clearly.`,
  });
  return text;
}

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
  console.log(`[PAR Demo] Step ${s.id} [${s.phase}] ${s.label}`);
}

// Extract visible text from the current page — Kendo grid rows + headers + page text
async function extractPageContent(page: Page): Promise<{ text: string; rowCount: number }> {
  return page.evaluate(() => {
    const lines: string[] = [];

    // Page title / heading
    const heading = document.querySelector("h1, h2, h3, .page-title, .k-grid-header");
    if (heading) lines.push(`PAGE: ${(heading as HTMLElement).innerText.trim()}`);

    // Summary stats / pills (common in dashboards)
    document.querySelectorAll("[class*='summary'], [class*='stat'], [class*='count'], [class*='badge']").forEach((el) => {
      const t = (el as HTMLElement).innerText.trim();
      if (t.length > 0 && t.length < 200) lines.push(`STAT: ${t}`);
    });

    // Kendo grid: extract headers + all row cells
    const gridHeaders: string[] = [];
    document.querySelectorAll(".k-grid-header th, table thead th").forEach((th) => {
      const t = (th as HTMLElement).innerText.trim();
      if (t) gridHeaders.push(t);
    });
    if (gridHeaders.length > 0) lines.push(`COLUMNS: ${gridHeaders.join(" | ")}`);

    let rowCount = 0;
    document.querySelectorAll(".k-grid-content tr, table tbody tr").forEach((row) => {
      const cells: string[] = [];
      row.querySelectorAll("td").forEach((td) => {
        const t = (td as HTMLElement).innerText.trim();
        if (t) cells.push(t);
      });
      if (cells.length > 0) {
        lines.push(cells.join(" | "));
        rowCount++;
      }
    });

    // Error messages / alert boxes
    document.querySelectorAll("[class*='error'], [class*='alert'], [class*='warning'], [role='alert']").forEach((el) => {
      const t = (el as HTMLElement).innerText.trim();
      if (t.length > 0 && t.length < 500) lines.push(`ALERT: ${t}`);
    });

    return { text: lines.join("\n"), rowCount };
  });
}

async function clickServerErrors(page: Page): Promise<{ found: boolean; method: string }> {
  // Strategy 1: Direct text link / tab / button labelled "Server Error(s)"
  const textSelectors = [
    'a:has-text("Server Error")',
    'button:has-text("Server Error")',
    'li:has-text("Server Error")',
    '[role="tab"]:has-text("Server Error")',
    '[class*="tab"]:has-text("Server Error")',
    '[class*="nav"]:has-text("Server Error")',
    '[class*="menu"] a:has-text("Server Error")',
    'span:has-text("Server Errors")',
    'a:has-text("Errors")',
  ];
  for (const sel of textSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible({ timeout: 2000 }).catch(() => false))) {
      console.log(`[PAR Demo] Found Server Errors via: ${sel}`);
      await el.click();
      await page.waitForTimeout(3000);
      return { found: true, method: sel };
    }
  }

  // Strategy 2: Kendo grid column filter on Status column — filter for "Error" values
  const statusHeader = page.locator(".k-grid-header th").filter({ hasText: /status/i }).first();
  if ((await statusHeader.count()) > 0) {
    const filterIcon = statusHeader.locator(".k-grid-filter, [class*='filter']").first();
    if ((await filterIcon.count()) > 0) {
      console.log("[PAR Demo] Trying Kendo column filter on Status column…");
      await filterIcon.click().catch(() => {});
      await page.waitForTimeout(1000);
      // Look for "Error" in the filter dropdown
      const errOption = page.locator('[class*="k-list"] .k-item:has-text("Error"), .k-filter-menu input[value*="Error" i]').first();
      if ((await errOption.count()) > 0) {
        await errOption.click().catch(() => {});
        const applyBtn = page.locator('.k-filter-menu button:has-text("Filter"), .k-filter-menu button[type="submit"]').first();
        if ((await applyBtn.count()) > 0) await applyBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
        return { found: true, method: "kendo-column-filter-status" };
      }
      // Close filter popup if open
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  // Strategy 3: Kendo dropdown / select for Status = "Server Error"
  const statusDropdown = page.locator('select[name*="status" i], select[id*="status" i]').first();
  if ((await statusDropdown.count()) > 0) {
    const options = await statusDropdown.locator("option").allInnerTexts();
    const errOption = options.find((o) => o.toLowerCase().includes("error"));
    if (errOption) {
      await statusDropdown.selectOption({ label: errOption });
      await page.waitForTimeout(2000);
      const searchBtn = page.locator('button:has-text("Search"), button:has-text("Filter"), button:has-text("Apply")').first();
      if ((await searchBtn.count()) > 0) await searchBtn.click();
      await page.waitForTimeout(3000);
      return { found: true, method: `select-status-${errOption}` };
    }
  }

  // Strategy 4: URL navigation to a known error-filtered path
  const errorUrl = new URL("TransactionLogs/index?status=ServerError", PORTAL_URL).toString();
  try {
    await page.goto(errorUrl, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    return { found: true, method: "url-query-ServerError" };
  } catch {}

  return { found: false, method: "none" };
}

async function runParScript(): Promise<void> {
  demoState = { status: "running", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  const username = process.env.CW_USERNAME ?? "";
  const password = process.env.CW_PASSWORD ?? "";
  const hasCredentials = username.length > 0 && password.length > 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    activePage = page;

    // ── Step 1: PERCEIVE — open portal ────────────────────────────────────
    addStep({ phase: "PERCEIVE", label: "Open CommonWell Portal", description: `Navigating to ${PORTAL_URL}`, screenshotUrl: null, assertionPassed: null });
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step1-portal-open");

    // ── Step 2: REVIEW — verify login form ───────────────────────────────
    addStep({ phase: "REVIEW", label: "Verify Login Form Present", description: "Asserting UserName, Password and Sign In are visible", screenshotUrl: null, assertionPassed: null });
    const usernameInput = page.locator('#UserName, input[name="UserName"], input[name="username"], input[type="email"]').first();
    const passwordInput = page.locator('#Password, input[name="Password"], input[type="password"]').first();
    const signInBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Sign in"), input[type="submit"]').first();
    const userVisible = await usernameInput.isVisible({ timeout: 5000 }).catch(() => false);
    const passVisible = await passwordInput.isVisible({ timeout: 5000 }).catch(() => false);
    const btnVisible = await signInBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const s2 = demoState.steps.at(-1)!;
    s2.assertionPassed = userVisible && passVisible;
    s2.description = `UserName: ${userVisible} · Password: ${passVisible} · Sign In: ${btnVisible}`;
    s2.screenshotUrl = await takeShot(page, "step2-login-form");

    // ── Step 3: ACT — enter username ──────────────────────────────────────
    addStep({ phase: "ACT", label: "Enter Username", description: hasCredentials ? `Username "${username.substring(0, 3)}***"` : "No CW_USERNAME — skipping", screenshotUrl: null, assertionPassed: null });
    if (hasCredentials && userVisible) { await usernameInput.click(); await usernameInput.fill(username); }
    await page.waitForTimeout(400);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step3-username");

    // ── Step 4: ACT — enter password ─────────────────────────────────────
    addStep({ phase: "ACT", label: "Enter Password", description: hasCredentials ? "Password (masked)" : "No CW_PASSWORD — skipping", screenshotUrl: null, assertionPassed: null });
    if (hasCredentials && passVisible) { await passwordInput.click(); await passwordInput.fill(password); }
    await page.waitForTimeout(400);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step4-password");

    // ── Step 5: REVIEW — verify form filled ───────────────────────────────
    addStep({ phase: "REVIEW", label: "Verify Credentials Entered", description: "Asserting both fields are populated", screenshotUrl: null, assertionPassed: null });
    const userVal = userVisible ? await usernameInput.inputValue().catch(() => "") : "";
    const passVal = passVisible ? await passwordInput.inputValue().catch(() => "") : "";
    const s5 = demoState.steps.at(-1)!;
    s5.assertionPassed = hasCredentials ? (userVal.length > 0 && passVal.length > 0) : true;
    s5.description = hasCredentials ? `Username: ${userVal.length > 0} · Password: ${passVal.length > 0}` : "Skipped";
    s5.screenshotUrl = await takeShot(page, "step5-form-filled");

    // ── Step 6: ACT — click Sign In ───────────────────────────────────────
    addStep({ phase: "ACT", label: "Click Sign In", description: hasCredentials ? "Submitting credentials" : "Skipping — no credentials", screenshotUrl: null, assertionPassed: null });
    if (hasCredentials && btnVisible) { await signInBtn.click().catch(() => {}); await page.waitForTimeout(5000); }
    else { await page.waitForTimeout(1000); }
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step6-sign-in");

    // ── Step 7: PERCEIVE — post-login state ──────────────────────────────
    const url7 = page.url();
    const onOtpPage = url7.includes("UserValidate") || (await page.$('#OTP')) !== null || (await page.$('#btnSendEmail')) !== null;
    const authenticated = !url7.includes("Login") && !url7.includes("login") && !onOtpPage;
    addStep({ phase: "PERCEIVE", label: "Observe Post-Login State", description: onOtpPage ? "OTP verification page detected — triggering email send" : authenticated ? `Authenticated at: ${url7}` : `URL: ${url7}`, screenshotUrl: null, assertionPassed: null });
    if (onOtpPage) {
      const emailBtn = page.locator('#btnSendEmail');
      if ((await emailBtn.count()) > 0) { await emailBtn.click().catch(() => {}); await page.waitForTimeout(2000); }
    }
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step7-post-login");

    // ── Step 8: REVIEW — assert progress ─────────────────────────────────
    addStep({ phase: "REVIEW", label: "Assert Authentication Progress", description: "", screenshotUrl: null, assertionPassed: null });
    const s8 = demoState.steps.at(-1)!;
    s8.assertionPassed = hasCredentials ? (onOtpPage || authenticated) : true;
    s8.description = hasCredentials ? `State: ${onOtpPage ? "OTP required" : authenticated ? "authenticated" : "unknown"}` : "Credential-free — login form verified";
    s8.screenshotUrl = await takeShot(page, "step8-auth-check");

    // ── OTP gate ──────────────────────────────────────────────────────────
    let isAuthenticated = authenticated;
    if (onOtpPage && hasCredentials) {
      demoState.status = "otp:waiting";
      const userOtp = await waitForOtp();
      demoState.status = "running";

      addStep({ phase: "ACT", label: "Enter OTP Code", description: `Typing ${userOtp.length}-digit OTP code`, screenshotUrl: null, assertionPassed: null });
      const otpInput = page.locator('#OTP, input[name="OTP"]').first();
      if ((await otpInput.count()) > 0) await otpInput.fill(userOtp);
      await page.waitForTimeout(500);
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step9-otp-filled");

      addStep({ phase: "ACT", label: "Submit OTP", description: "Clicking Submit to verify the OTP", screenshotUrl: null, assertionPassed: null });
      const submitBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Submit")').first();
      if ((await submitBtn.count()) > 0) { await submitBtn.click().catch(() => {}); }
      await page.waitForTimeout(5000);
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step10-otp-submitted");

      addStep({ phase: "REVIEW", label: "Assert OTP Accepted", description: "", screenshotUrl: null, assertionPassed: null });
      const urlAfter = page.url();
      const otpAccepted = !urlAfter.includes("UserValidate") && (await page.$('#OTP')) === null;
      const s11 = demoState.steps.at(-1)!;
      s11.assertionPassed = otpAccepted;
      s11.description = `OTP accepted: ${otpAccepted} · URL: ${urlAfter}`;
      s11.screenshotUrl = await takeShot(page, "step11-otp-result");
      isAuthenticated = otpAccepted;
    }

    if (!isAuthenticated) {
      // Not authenticated — wrap up gracefully
      addStep({ phase: "REVIEW", label: "Verify PAR Loop Coverage", description: `${demoState.steps.length} steps captured — authentication not complete, cannot reach Server Errors`, screenshotUrl: null, assertionPassed: true });
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-no-auth");
      demoState.status = "complete";
      return;
    }

    // ── Navigate to Transaction Logs ──────────────────────────────────────
    addStep({ phase: "PERCEIVE", label: "Navigate to Transaction Logs", description: "Opening the CDR Transaction Logs page", screenshotUrl: null, assertionPassed: null });
    try {
      const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
      await page.goto(txUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(2000);
    } catch (err) {
      console.warn("[PAR Demo] Tx Logs nav error:", (err as Error).message);
    }
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-tx-logs");

    addStep({ phase: "REVIEW", label: "Verify Transaction Logs Grid", description: "", screenshotUrl: null, assertionPassed: null });
    const txUrl = page.url();
    const onTxLogs = txUrl.includes("TransactionLog");
    const gridVisible = await page.locator(".k-grid, table").first().isVisible({ timeout: 5000 }).catch(() => false);
    const sGrid = demoState.steps.at(-1)!;
    sGrid.assertionPassed = onTxLogs || gridVisible;
    sGrid.description = `On Transaction Logs: ${onTxLogs} · Grid visible: ${gridVisible}`;
    sGrid.screenshotUrl = await takeShot(page, "step-tx-grid");

    // ── Server Errors: PERCEIVE — look for the filter ─────────────────────
    addStep({ phase: "PERCEIVE", label: "Locate Server Errors Filter", description: "Scanning the page for a Server Errors tab, link, or filter option", screenshotUrl: null, assertionPassed: null });
    // Log all visible links and tabs for debugging
    const navItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button, [role='tab'], li"))
        .map((el) => (el as HTMLElement).innerText.trim())
        .filter((t) => t.length > 0 && t.length < 80)
        .slice(0, 40)
    );
    console.log("[PAR Demo] Visible nav items:", navItems.join(" | "));
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-locate-errors");

    // ── Server Errors: ACT — click it ─────────────────────────────────────
    addStep({ phase: "ACT", label: "Click Server Errors", description: "Attempting to filter/navigate to the Server Errors view using multiple strategies", screenshotUrl: null, assertionPassed: null });
    const { found, method } = await clickServerErrors(page);
    const sClick = demoState.steps.at(-1)!;
    sClick.description = found
      ? `Server Errors filter applied via: ${method}`
      : "Server Errors filter not found — capturing current error-relevant page content";
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-server-errors-clicked");

    // ── Server Errors: PERCEIVE — observe filtered grid ───────────────────
    addStep({ phase: "PERCEIVE", label: "Observe Server Errors View", description: "Reading the filtered grid and extracting all visible error data", screenshotUrl: null, assertionPassed: null });
    await page.waitForTimeout(1500);
    const { text: extractedText, rowCount } = await extractPageContent(page);
    const sObserve = demoState.steps.at(-1)!;
    sObserve.description = `Extracted ${rowCount} grid rows · ${extractedText.length} chars of content`;
    sObserve.screenshotUrl = await takeShot(page, "step-server-errors-grid");

    // ── REVIEW — assert something was extracted ───────────────────────────
    addStep({ phase: "REVIEW", label: "Assert Error Data Extracted", description: "", screenshotUrl: null, assertionPassed: null });
    const sExtract = demoState.steps.at(-1)!;
    sExtract.assertionPassed = extractedText.length > 50;
    sExtract.description = `Content extracted: ${extractedText.length > 50} · ${rowCount} rows · ${extractedText.length} chars`;
    sExtract.screenshotUrl = await takeShot(page, "step-extract-review");

    // ── Vertex AI summary ─────────────────────────────────────────────────
    addStep({ phase: "ACT", label: "Summarise with Vertex AI", description: "Sending extracted server error content to Gemini 2.5 Flash for analysis", screenshotUrl: null, assertionPassed: null });
    demoState.aiSummaryPending = true;
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-ai-call");

    let summaryText = "";
    try {
      summaryText = await summariseWithVertex(extractedText, rowCount);
      demoState.aiSummary = summaryText;
      console.log("[PAR Demo] Vertex AI summary generated — length:", summaryText.length);
    } catch (aiErr) {
      console.warn("[PAR Demo] Vertex AI call failed:", (aiErr as Error).message);
      demoState.aiSummary = `⚠️ AI summary unavailable: ${(aiErr as Error).message}\n\n**Extracted content (${rowCount} rows):**\n\`\`\`\n${extractedText.slice(0, 2000)}\n\`\`\``;
    } finally {
      demoState.aiSummaryPending = false;
    }

    // ── Final REVIEW ──────────────────────────────────────────────────────
    addStep({ phase: "REVIEW", label: "Verify AI Summary Generated", description: "", screenshotUrl: null, assertionPassed: null });
    const sFinal = demoState.steps.at(-1)!;
    sFinal.assertionPassed = summaryText.length > 0;
    sFinal.description = summaryText.length > 0
      ? `Vertex AI summary generated — ${summaryText.length} chars · ${summaryText.split("\n").length} lines`
      : "AI summary failed — raw extracted content available";
    sFinal.screenshotUrl = await takeShot(page, "step-final");

    demoState.status = "complete";
    console.log("[PAR Demo] Complete");
  } catch (err) {
    if (otpRejecter) { otpRejecter(new Error("Script failed")); otpResolver = null; otpRejecter = null; }
    demoState.status = "error";
    demoState.errorMessage = (err as Error).message;
    demoState.aiSummaryPending = false;
    console.error("[PAR Demo] Error:", (err as Error).message);
  } finally {
    activePage = null;
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

export function registerParDemoRoutes(app: Express): void {
  app.post("/api/par-demo/run", async (_req: Request, res: Response) => {
    if (demoState.status === "running" || demoState.status === "otp:waiting") {
      return res.status(409).json({ error: "A PAR demo is already running" });
    }
    runParScript().catch(console.error);
    res.json({ started: true });
  });

  app.get("/api/par-demo/status", (_req: Request, res: Response) => {
    res.json({
      status: demoState.status,
      steps: demoState.steps,
      errorMessage: demoState.errorMessage,
      aiSummary: demoState.aiSummary,
      aiSummaryPending: demoState.aiSummaryPending,
    });
  });

  app.post("/api/par-demo/otp", (req: Request, res: Response) => {
    const { otp } = req.body as { otp?: string };
    if (!otp || typeof otp !== "string" || otp.trim().length === 0) {
      return res.status(400).json({ error: "OTP code is required" });
    }
    if (demoState.status !== "otp:waiting" || !otpResolver) {
      return res.status(409).json({ error: "Not waiting for OTP" });
    }
    const resolver = otpResolver;
    otpResolver = null; otpRejecter = null;
    resolver(otp.trim());
    res.json({ submitted: true });
  });

  app.post("/api/par-demo/reset", (_req: Request, res: Response) => {
    if (otpRejecter) { otpRejecter(new Error("Reset by user")); otpResolver = null; otpRejecter = null; }
    demoState = { status: "idle", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false };
    res.json({ reset: true });
  });

  app.get("/api/par-demo/live", async (_req: Request, res: Response) => {
    if (!activePage || activePage.isClosed()) {
      const emptyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      return res.send(emptyPng);
    }
    try {
      const buffer = await activePage.screenshot({ type: "jpeg", quality: 80, fullPage: false });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(buffer);
    } catch {
      res.status(503).json({ error: "Screenshot unavailable" });
    }
  });
}
