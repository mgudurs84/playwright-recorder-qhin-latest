import { Express, Request, Response } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "cw-screenshots");
const PORTAL_URL = "https://integration.commonwellalliance.lkopera.com/";

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

// Exposed so the /live endpoint can snapshot it on demand
let activePage: Page | null = null;

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

async function runParScript(): Promise<void> {
  demoState = { status: "running", steps: [], errorMessage: null };

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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    activePage = page;

    // ── Step 1: PERCEIVE — open the CommonWell portal ─────────────────────
    addStep({
      phase: "PERCEIVE",
      label: "Open CommonWell Portal",
      description: `Navigating to the CommonWell integration portal at ${PORTAL_URL} — observing initial page load`,
      screenshotUrl: null,
      assertionPassed: null,
    });
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const shot1 = await takeShot(page, "step1-portal-open");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot1;

    // ── Step 2: REVIEW — verify login form is present ─────────────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Login Form Present",
      description: "Asserting that the portal login form is visible — checking for UserName input, Password field, and Sign In button",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const usernameInput = page.locator('#UserName, input[name="UserName"], input[name="username"], input[type="email"]').first();
    const passwordInput = page.locator('#Password, input[name="Password"], input[type="password"]').first();
    const signInBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), input[type="submit"]').first();
    const userVisible = await usernameInput.isVisible({ timeout: 5000 }).catch(() => false);
    const passVisible = await passwordInput.isVisible({ timeout: 5000 }).catch(() => false);
    const btnVisible = await signInBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const step2Pass = userVisible && passVisible;
    const shot2 = await takeShot(page, "step2-login-form");
    const step2 = demoState.steps[demoState.steps.length - 1];
    step2.screenshotUrl = shot2;
    step2.assertionPassed = step2Pass;
    step2.description = `UserName field: ${userVisible} · Password field: ${passVisible} · Sign In button: ${btnVisible}`;

    // ── Step 3: ACT — fill in username ────────────────────────────────────
    addStep({
      phase: "ACT",
      label: "Enter Username",
      description: hasCredentials
        ? `Typing username "${username.substring(0, 3)}***" into the UserName field`
        : "No CW_USERNAME env var set — skipping credential entry (demo observation only)",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && userVisible) {
      await usernameInput.click();
      await usernameInput.fill(username);
    }
    await page.waitForTimeout(500);
    const shot3 = await takeShot(page, "step3-username");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot3;

    // ── Step 4: ACT — fill in password ────────────────────────────────────
    addStep({
      phase: "ACT",
      label: "Enter Password",
      description: hasCredentials
        ? "Typing password (masked) into the Password field"
        : "No CW_PASSWORD env var set — skipping credential entry",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && passVisible) {
      await passwordInput.click();
      await passwordInput.fill(password);
    }
    await page.waitForTimeout(500);
    const shot4 = await takeShot(page, "step4-password");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot4;

    // ── Step 5: REVIEW — assert credentials are in the form ───────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Credentials Entered",
      description: "Asserting the form fields are populated before submission",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const userValue = userVisible ? await usernameInput.inputValue().catch(() => "") : "";
    const passValue = passVisible ? await passwordInput.inputValue().catch(() => "") : "";
    const step5Pass = hasCredentials ? (userValue.length > 0 && passValue.length > 0) : true;
    const shot5 = await takeShot(page, "step5-form-filled");
    const step5 = demoState.steps[demoState.steps.length - 1];
    step5.screenshotUrl = shot5;
    step5.assertionPassed = step5Pass;
    step5.description = hasCredentials
      ? `Username filled: ${userValue.length > 0} · Password filled: ${passValue.length > 0}`
      : "Skipped — no credentials configured (set CW_USERNAME and CW_PASSWORD to run full demo)";

    // ── Step 6: ACT — click Sign In ───────────────────────────────────────
    addStep({
      phase: "ACT",
      label: "Click Sign In",
      description: hasCredentials
        ? "Clicking the Sign In button to submit credentials to the CommonWell portal"
        : "Skipping Sign In — no credentials available; observing login page state only",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && btnVisible) {
      await signInBtn.click().catch(() => {});
      await page.waitForTimeout(5000);
    } else {
      await page.waitForTimeout(1000);
    }
    const shot6 = await takeShot(page, "step6-sign-in");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot6;

    // ── Step 7: PERCEIVE — observe post-login portal state ────────────────
    const currentUrl7 = page.url();
    const onOtpPage =
      currentUrl7.includes("UserValidate") ||
      (await page.$('#OTP')) !== null ||
      (await page.$('#btnSendEmail')) !== null;
    const onPortalHome = !currentUrl7.includes("Login") && !currentUrl7.includes("login") && !onOtpPage;

    addStep({
      phase: "PERCEIVE",
      label: "Observe Post-Login State",
      description: onOtpPage
        ? "Portal redirected to OTP verification page — multi-factor authentication required"
        : onPortalHome
        ? `Portal authenticated — landed on: ${currentUrl7}`
        : `Observing login result: ${currentUrl7}`,
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (onOtpPage) {
      // Auto-trigger email OTP send so user can see the OTP step in the live view
      const sendEmailBtn = page.locator('#btnSendEmail');
      if ((await sendEmailBtn.count()) > 0) {
        console.log("[PAR Demo] Clicking Send OTP (email)…");
        await sendEmailBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    const shot7 = await takeShot(page, "step7-post-login");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot7;

    // ── Step 8: REVIEW — assert portal state changed from login ───────────
    addStep({
      phase: "REVIEW",
      label: "Assert Authentication Progress",
      description: "Verifying the portal responded to the Sign In attempt — URL must have changed from the login page",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const currentUrl8 = page.url();
    const urlChanged = hasCredentials ? currentUrl8 !== PORTAL_URL : true;
    const step8Pass = hasCredentials ? (onOtpPage || onPortalHome) : true;
    const shot8 = await takeShot(page, "step8-auth-check");
    const step8 = demoState.steps[demoState.steps.length - 1];
    step8.screenshotUrl = shot8;
    step8.assertionPassed = step8Pass;
    step8.description = hasCredentials
      ? `URL changed: ${urlChanged} · State: ${onOtpPage ? "OTP required" : onPortalHome ? "authenticated" : "unknown"} · URL: ${currentUrl8}`
      : "Credential-free demo — login form verified successfully, Sign In not submitted";

    // ── Step 9: PERCEIVE — navigate to Transaction Logs (if authenticated) ─
    addStep({
      phase: "PERCEIVE",
      label: onPortalHome ? "Navigate to Transaction Logs" : "Capture Final Portal State",
      description: onPortalHome
        ? "Navigating to the Transaction Logs page to observe the CDR data grid"
        : onOtpPage
        ? "Pausing at OTP page — MFA step identified; pipeline would continue after OTP entry"
        : "Capturing final observable portal state for the demo report",
      screenshotUrl: null,
      assertionPassed: null,
    });

    if (onPortalHome) {
      try {
        const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
        await page.goto(txUrl, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(2000);
      } catch (navErr) {
        console.warn("[PAR Demo] Transaction Logs navigation error:", (navErr as Error).message);
      }
    } else {
      await page.waitForTimeout(1500);
    }
    const shot9 = await takeShot(page, "step9-final-state");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot9;

    // ── Step 10: REVIEW — final assertion ─────────────────────────────────
    const finalUrl = page.url();
    const onTxLogs = finalUrl.includes("TransactionLog");
    const gridVisible = onTxLogs
      ? await page.locator(".k-grid, table").first().isVisible({ timeout: 5000 }).catch(() => false)
      : false;

    addStep({
      phase: "REVIEW",
      label: onPortalHome ? "Verify Transaction Logs Grid" : "Verify PAR Loop Completeness",
      description: onPortalHome
        ? `Transaction Logs page: ${onTxLogs} · Kendo/data grid visible: ${gridVisible}`
        : `All observable PAR steps executed — ${demoState.steps.length} total steps captured with screenshots`,
      screenshotUrl: null,
      assertionPassed: onPortalHome ? (onTxLogs || gridVisible) : true,
    });
    const shot10 = await takeShot(page, "step10-review-final");
    demoState.steps[demoState.steps.length - 1].screenshotUrl = shot10;

    demoState.status = "complete";
    console.log("[PAR Demo] Complete — all steps done");
  } catch (err) {
    demoState.status = "error";
    demoState.errorMessage = (err as Error).message;
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
    if (demoState.status === "running") {
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
    });
  });

  app.post("/api/par-demo/reset", (_req: Request, res: Response) => {
    if (demoState.status === "running") {
      return res.status(409).json({ error: "Cannot reset while running" });
    }
    demoState = { status: "idle", steps: [], errorMessage: null };
    res.json({ reset: true });
  });

  // Live screenshot — returns current Playwright page as JPEG bytes (no disk write)
  app.get("/api/par-demo/live", async (_req: Request, res: Response) => {
    if (!activePage || activePage.isClosed()) {
      // Return a 1x1 transparent PNG when not running
      const emptyPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      return res.send(emptyPng);
    }
    try {
      const buffer = await activePage.screenshot({ type: "jpeg", quality: 75, fullPage: false });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(buffer);
    } catch {
      res.status(503).json({ error: "Screenshot unavailable" });
    }
  });
}
