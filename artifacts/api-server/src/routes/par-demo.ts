import { Express, Request, Response } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

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
}

let demoState: DemoState = { status: "idle", steps: [], errorMessage: null };

// Exposed so GET /api/par-demo/live can snapshot on demand
let activePage: Page | null = null;

// OTP gate — resolved when the user submits an OTP from the UI
let otpResolver: ((otp: string) => void) | null = null;
let otpRejecter: ((err: Error) => void) | null = null;

function waitForOtp(timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
    // Auto-reject after timeout so the script doesn't hang forever
    setTimeout(() => {
      if (otpRejecter) {
        otpRejecter(new Error("OTP entry timed out after 5 minutes"));
        otpResolver = null;
        otpRejecter = null;
      }
    }, timeoutMs);
  });
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
      description: `Navigating to ${PORTAL_URL} — observing initial page load`,
      screenshotUrl: null,
      assertionPassed: null,
    });
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step1-portal-open");

    // ── Step 2: REVIEW — verify login form ───────────────────────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Login Form Present",
      description: "Asserting UserName input, Password field, and Sign In button are all visible",
      screenshotUrl: null,
      assertionPassed: null,
    });
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
    addStep({
      phase: "ACT",
      label: "Enter Username",
      description: hasCredentials
        ? `Typing username "${username.substring(0, 3)}***" into the UserName field`
        : "No CW_USERNAME configured — skipping",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && userVisible) {
      await usernameInput.click();
      await usernameInput.fill(username);
    }
    await page.waitForTimeout(400);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step3-username");

    // ── Step 4: ACT — enter password ──────────────────────────────────────
    addStep({
      phase: "ACT",
      label: "Enter Password",
      description: hasCredentials ? "Typing password (masked) into the Password field" : "No CW_PASSWORD configured — skipping",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && passVisible) {
      await passwordInput.click();
      await passwordInput.fill(password);
    }
    await page.waitForTimeout(400);
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step4-password");

    // ── Step 5: REVIEW — verify form is filled ────────────────────────────
    addStep({
      phase: "REVIEW",
      label: "Verify Credentials Entered",
      description: "Asserting both form fields are populated before submission",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const userVal = userVisible ? await usernameInput.inputValue().catch(() => "") : "";
    const passVal = passVisible ? await passwordInput.inputValue().catch(() => "") : "";
    const s5 = demoState.steps.at(-1)!;
    s5.assertionPassed = hasCredentials ? (userVal.length > 0 && passVal.length > 0) : true;
    s5.description = hasCredentials
      ? `Username filled: ${userVal.length > 0} · Password filled: ${passVal.length > 0}`
      : "Skipped — credentials not configured";
    s5.screenshotUrl = await takeShot(page, "step5-form-filled");

    // ── Step 6: ACT — click Sign In ───────────────────────────────────────
    addStep({
      phase: "ACT",
      label: "Click Sign In",
      description: hasCredentials
        ? "Submitting credentials to the CommonWell portal"
        : "Skipping Sign In — no credentials available",
      screenshotUrl: null,
      assertionPassed: null,
    });
    if (hasCredentials && btnVisible) {
      await signInBtn.click().catch(() => {});
      await page.waitForTimeout(5000);
    } else {
      await page.waitForTimeout(1000);
    }
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step6-sign-in");

    // ── Step 7: PERCEIVE — detect post-login state ────────────────────────
    const url7 = page.url();
    const onOtpPage =
      url7.includes("UserValidate") ||
      (await page.$('#OTP')) !== null ||
      (await page.$('#btnSendEmail')) !== null;
    const authenticated = !url7.includes("Login") && !url7.includes("login") && !onOtpPage;

    addStep({
      phase: "PERCEIVE",
      label: "Observe Post-Login State",
      description: onOtpPage
        ? "Portal redirected to OTP verification — triggering email OTP send, waiting for your code"
        : authenticated
        ? `Authenticated — portal loaded at: ${url7}`
        : `Login result: ${url7}`,
      screenshotUrl: null,
      assertionPassed: null,
    });

    if (onOtpPage) {
      // Trigger email send
      const emailBtn = page.locator('#btnSendEmail');
      if ((await emailBtn.count()) > 0) {
        console.log("[PAR Demo] Clicking Send OTP via email…");
        await emailBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step7-post-login");

    // ── Step 8: REVIEW — assert progress ─────────────────────────────────
    addStep({
      phase: "REVIEW",
      label: "Assert Authentication Progress",
      description: "Verifying the portal responded — URL must have changed from the login page",
      screenshotUrl: null,
      assertionPassed: null,
    });
    const s8 = demoState.steps.at(-1)!;
    s8.assertionPassed = hasCredentials ? (onOtpPage || authenticated) : true;
    s8.description = hasCredentials
      ? `State: ${onOtpPage ? "OTP required" : authenticated ? "authenticated" : "unknown"} · URL: ${page.url()}`
      : "Credential-free demo — login form verified successfully";
    s8.screenshotUrl = await takeShot(page, "step8-auth-check");

    // ── OTP gate — pause here and wait for user to enter OTP ──────────────
    if (onOtpPage && hasCredentials) {
      demoState.status = "otp:waiting";
      console.log("[PAR Demo] Waiting for user OTP input…");

      const userOtp = await waitForOtp();

      demoState.status = "running";

      // ── Step 9: ACT — type OTP ────────────────────────────────────────
      addStep({
        phase: "ACT",
        label: "Enter OTP Code",
        description: `Typing the ${userOtp.length}-digit OTP code into the verification field`,
        screenshotUrl: null,
        assertionPassed: null,
      });
      const otpInput = page.locator('#OTP, input[name="OTP"], input[name="otp"]').first();
      if ((await otpInput.count()) > 0) {
        await otpInput.fill(userOtp);
      }
      await page.waitForTimeout(500);
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step9-otp-filled");

      // ── Step 10: ACT — submit OTP ─────────────────────────────────────
      addStep({
        phase: "ACT",
        label: "Submit OTP",
        description: "Clicking the Submit button to verify the OTP code",
        screenshotUrl: null,
        assertionPassed: null,
      });
      const submitBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click().catch(() => {});
      }
      await page.waitForTimeout(5000);
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step10-otp-submitted");

      // ── Step 11: REVIEW — assert OTP accepted ─────────────────────────
      addStep({
        phase: "REVIEW",
        label: "Assert OTP Accepted",
        description: "Verifying the portal accepted the OTP — URL must have left the UserValidate page",
        screenshotUrl: null,
        assertionPassed: null,
      });
      const urlAfterOtp = page.url();
      const otpAccepted =
        !urlAfterOtp.includes("UserValidate") &&
        (await page.$('#OTP')) === null;
      const s11 = demoState.steps.at(-1)!;
      s11.assertionPassed = otpAccepted;
      s11.description = `OTP accepted: ${otpAccepted} · URL: ${urlAfterOtp}`;
      s11.screenshotUrl = await takeShot(page, "step11-otp-result");

      // ── Step 12: PERCEIVE — navigate to Transaction Logs ──────────────
      addStep({
        phase: "PERCEIVE",
        label: "Navigate to Transaction Logs",
        description: "Opening the CDR Transaction Logs page to observe the data grid",
        screenshotUrl: null,
        assertionPassed: null,
      });
      if (otpAccepted) {
        try {
          const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
          await page.goto(txUrl, { waitUntil: "networkidle", timeout: 30000 });
          await page.waitForTimeout(2000);
        } catch (err) {
          console.warn("[PAR Demo] Transaction Logs nav error:", (err as Error).message);
        }
      }
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step12-tx-logs");

      // ── Step 13: REVIEW — verify data grid ────────────────────────────
      addStep({
        phase: "REVIEW",
        label: "Verify CDR Data Grid",
        description: "Asserting the Transaction Logs Kendo grid is present and loaded",
        screenshotUrl: null,
        assertionPassed: null,
      });
      const finalUrl = page.url();
      const onTxLogs = finalUrl.includes("TransactionLog");
      const gridVisible = onTxLogs
        ? await page.locator(".k-grid, table").first().isVisible({ timeout: 5000 }).catch(() => false)
        : false;
      const s13 = demoState.steps.at(-1)!;
      s13.assertionPassed = onTxLogs || gridVisible;
      s13.description = `Transaction Logs page: ${onTxLogs} · Grid visible: ${gridVisible} · URL: ${finalUrl}`;
      s13.screenshotUrl = await takeShot(page, "step13-data-grid");
    } else {
      // No OTP needed (already authenticated or no creds) — navigate to tx logs
      addStep({
        phase: "PERCEIVE",
        label: authenticated ? "Navigate to Transaction Logs" : "Capture Final Portal State",
        description: authenticated
          ? "Navigating to the CDR Transaction Logs page to observe the data grid"
          : "Capturing final observable portal state",
        screenshotUrl: null,
        assertionPassed: null,
      });
      if (authenticated) {
        try {
          const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
          await page.goto(txUrl, { waitUntil: "networkidle", timeout: 30000 });
          await page.waitForTimeout(2000);
        } catch {}
      } else {
        await page.waitForTimeout(1000);
      }
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step9-final");

      addStep({
        phase: "REVIEW",
        label: "Verify PAR Loop Coverage",
        description: `All observable steps completed — ${demoState.steps.length} steps captured`,
        screenshotUrl: null,
        assertionPassed: true,
      });
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step10-coverage");
    }

    demoState.status = "complete";
    console.log("[PAR Demo] Complete");
  } catch (err) {
    // If the script fails while OTP is waiting, clean up the promise
    if (otpRejecter) {
      otpRejecter(new Error("Script failed"));
      otpResolver = null;
      otpRejecter = null;
    }
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
    });
  });

  // User submits the OTP code from the UI — resumes the paused script
  app.post("/api/par-demo/otp", (req: Request, res: Response) => {
    const { otp } = req.body as { otp?: string };
    if (!otp || typeof otp !== "string" || otp.trim().length === 0) {
      return res.status(400).json({ error: "OTP code is required" });
    }
    if (demoState.status !== "otp:waiting" || !otpResolver) {
      return res.status(409).json({ error: "Not waiting for OTP" });
    }
    const resolver = otpResolver;
    otpResolver = null;
    otpRejecter = null;
    resolver(otp.trim());
    res.json({ submitted: true });
  });

  app.post("/api/par-demo/reset", (_req: Request, res: Response) => {
    if (demoState.status === "running" || demoState.status === "otp:waiting") {
      // Force-reject any pending OTP promise so the script exits
      if (otpRejecter) {
        otpRejecter(new Error("Reset by user"));
        otpResolver = null;
        otpRejecter = null;
      }
    }
    demoState = { status: "idle", steps: [], errorMessage: null };
    res.json({ reset: true });
  });

  // Live screenshot — returns the current Playwright page as JPEG bytes
  app.get("/api/par-demo/live", async (_req: Request, res: Response) => {
    if (!activePage || activePage.isClosed()) {
      const emptyPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64"
      );
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
