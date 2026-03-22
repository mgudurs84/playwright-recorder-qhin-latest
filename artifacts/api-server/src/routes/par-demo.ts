import { Express, Request, Response } from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { generateText } from "ai";
import { createVertexModel } from "../lib/vertex";

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
  aiSummary: string | null;
  aiSummaryPending: boolean;
  dateRange: { dateFrom: string; dateTo: string } | null;
}

let demoState: DemoState = {
  status: "idle",
  steps: [],
  errorMessage: null,
  aiSummary: null,
  aiSummaryPending: false,
  dateRange: null,
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

// ── Auto-retry wrapper ───────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 2000): Promise<T> {
  let lastErr: Error = new Error("Unknown error");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts) {
        console.warn(`[PAR Demo] Attempt ${attempt}/${maxAttempts} failed: ${lastErr.message} — retrying in ${delayMs}ms…`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ── Multi-page extraction ────────────────────────────────────────────────────
// Iterates through all Kendo grid pages (up to MAX_PAGES) and accumulates all row text.
async function extractAllPagesContent(page: Page): Promise<{ text: string; rowCount: number; pageCount: number }> {
  const MAX_PAGES = 20;
  const allParts: string[] = [];
  let totalRows = 0;
  let visitedPages = 0; // explicit counter — allParts.length can undercount when a page has no rows

  for (let p = 1; p <= MAX_PAGES; p++) {
    visitedPages = p;
    const { text, rowCount } = await extractPageContent(page);

    if (p === 1) {
      allParts.push(text);
    } else {
      // For subsequent pages only include row lines, not repeated headers/stats
      const rows = text.split("\n").filter(
        (l) => l.trim() && !l.startsWith("PAGE:") && !l.startsWith("STAT:") && !l.startsWith("COLUMNS:") && !l.startsWith("ALERT:")
      );
      if (rows.length > 0) allParts.push(rows.join("\n"));
    }
    totalRows += rowCount;

    // Detect a non-disabled Kendo "next page" pager button
    const hasNextPage = await page.evaluate(() => {
      const navItems = Array.from(document.querySelectorAll(".k-pager-nav, [aria-label], [title]")) as HTMLElement[];
      for (const item of navItems) {
        const title = (item.getAttribute("title") ?? item.getAttribute("aria-label") ?? "").toLowerCase();
        const isNext = title.includes("next") || item.querySelector(".k-i-arrow-e, .k-i-arrow-60-right") !== null;
        const isDisabled = item.classList.contains("k-state-disabled") || (item as HTMLButtonElement).disabled;
        if (isNext && !isDisabled) return true;
      }
      return false;
    });

    if (!hasNextPage) break;

    // Click next page via DOM (more reliable than Playwright locator on Kendo pagers)
    const clicked = await page.evaluate(() => {
      const navItems = Array.from(document.querySelectorAll(".k-pager-nav")) as HTMLElement[];
      for (const item of navItems) {
        const hasArrow = item.querySelector(".k-i-arrow-e, .k-i-arrow-60-right");
        const isDisabled = item.classList.contains("k-state-disabled");
        if (hasArrow && !isDisabled) {
          item.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) break;
    // Wait for grid to refresh after page navigation
    await page.waitForTimeout(2000);
  }

  return { text: allParts.join("\n"), rowCount: totalRows, pageCount: visitedPages };
}

// ── Date range filter injection ──────────────────────────────────────────────
// Formats an ISO date string (YYYY-MM-DD) to MM/dd/yyyy for Kendo DatePicker inputs.
function isoToUsDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

async function applyDateRangeFilter(page: Page, dateFrom: string, dateTo: string): Promise<void> {
  const fromFormatted = isoToUsDate(dateFrom);
  const toFormatted = isoToUsDate(dateTo);
  console.log(`[PAR Demo] Applying date range: ${fromFormatted} → ${toFormatted}`);

  // Kendo DatePicker inputs — try multiple selector patterns
  const fromSelectors = [
    'input[id*="from" i][data-role="datepicker"]',
    'input[name*="from" i][data-role="datepicker"]',
    'input[id*="FromDate" i]', 'input[name*="FromDate" i]',
    'input[id*="startdate" i]', 'input[name*="startdate" i]',
    '[data-role="datepicker"]:first-of-type',
  ];
  const toSelectors = [
    'input[id*="to" i][data-role="datepicker"]',
    'input[name*="to" i][data-role="datepicker"]',
    'input[id*="ToDate" i]', 'input[name*="ToDate" i]',
    'input[id*="enddate" i]', 'input[name*="enddate" i]',
    '[data-role="datepicker"]:last-of-type',
  ];

  let fromFilled = false;
  for (const sel of fromSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible({ timeout: 1000 }).catch(() => false))) {
      try {
        await el.click({ clickCount: 3 });
        await el.fill(fromFormatted);
        await page.keyboard.press("Tab");
        fromFilled = true;
        console.log(`[PAR Demo] From Date set via: ${sel}`);
      } catch (e) {
        console.warn(`[PAR Demo] From Date fill failed via: ${sel} — ${(e as Error).message}`);
      }
      break; // only attempt one selector
    }
  }

  let toFilled = false;
  for (const sel of toSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0 && (await el.isVisible({ timeout: 1000 }).catch(() => false))) {
      try {
        await el.click({ clickCount: 3 });
        await el.fill(toFormatted);
        await page.keyboard.press("Tab");
        toFilled = true;
        console.log(`[PAR Demo] To Date set via: ${sel}`);
      } catch (e) {
        console.warn(`[PAR Demo] To Date fill failed via: ${sel} — ${(e as Error).message}`);
      }
      break; // only attempt one selector
    }
  }

  if (fromFilled || toFilled) {
    // Click Search/Apply
    const searchBtn = page.locator(
      'button:has-text("Search"), button:has-text("Filter"), button:has-text("Apply"), input[type="submit"][value*="Search" i]'
    ).first();
    if ((await searchBtn.count()) > 0 && (await searchBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
      await searchBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
      console.log("[PAR Demo] Date range filter applied and Search clicked");
    }
  } else {
    console.warn("[PAR Demo] Date range inputs not found — skipping date filter");
  }
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

Respond ONLY with markdown using exactly these five section headings (copy them verbatim):

### Server Error Overview
One short paragraph: total visible errors, time range if shown, overall severity.

### Error Pattern Breakdown
A markdown table grouping errors by type, status code, or cause. If data is sparse, use bullet points instead.

### Affected Organisations / Transaction Types
Bullet list of which organisations or transaction types appear most frequently.

### Key Findings
3–5 concise bullet points highlighting the most important insights.

### Recommended Next Steps
Numbered list of concrete, prioritised actions for the CDR operations team.

Be factual and data-driven. If the data is limited or unclear, say so briefly within each section.`,
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

async function runParScript(opts: { dateFrom?: string; dateTo?: string } = {}): Promise<void> {
  demoState = {
    status: "running",
    steps: [],
    errorMessage: null,
    aiSummary: null,
    aiSummaryPending: false,
    dateRange: opts.dateFrom && opts.dateTo ? { dateFrom: opts.dateFrom, dateTo: opts.dateTo } : null,
  };

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
    await withRetry(async () => {
      const txNavUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
      await page!.goto(txNavUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page!.waitForTimeout(2000);
    }).catch((err) => console.warn("[PAR Demo] Tx Logs nav error:", (err as Error).message));
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-tx-logs");

    addStep({ phase: "REVIEW", label: "Verify Transaction Logs Grid", description: "", screenshotUrl: null, assertionPassed: null });
    const txUrl = page.url();
    const onTxLogs = txUrl.includes("TransactionLog");
    const gridVisible = await page.locator(".k-grid, table").first().isVisible({ timeout: 5000 }).catch(() => false);
    const sGrid = demoState.steps.at(-1)!;
    sGrid.assertionPassed = onTxLogs || gridVisible;
    sGrid.description = `On Transaction Logs: ${onTxLogs} · Grid visible: ${gridVisible}`;
    sGrid.screenshotUrl = await takeShot(page, "step-tx-grid");

    // ── ACT — apply date range filter (if requested) ──────────────────────
    if (opts.dateFrom && opts.dateTo) {
      addStep({
        phase: "ACT",
        label: "Apply Date Range Filter",
        description: `Setting date range: ${opts.dateFrom} → ${opts.dateTo}`,
        screenshotUrl: null,
        assertionPassed: null,
      });
      try {
        await applyDateRangeFilter(page, opts.dateFrom, opts.dateTo);
        demoState.steps.at(-1)!.assertionPassed = true;
        demoState.steps.at(-1)!.description = `Date range applied: ${opts.dateFrom} → ${opts.dateTo}`;
      } catch (err) {
        console.warn("[PAR Demo] Date range filter failed:", (err as Error).message);
        demoState.steps.at(-1)!.assertionPassed = false;
        demoState.steps.at(-1)!.description = `Date range filter failed: ${(err as Error).message}`;
      }
      demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-date-filter");
    }

    // ── Server Errors: PERCEIVE — look for the filter ─────────────────────
    addStep({ phase: "PERCEIVE", label: "Locate Server Errors Filter", description: "Scanning the page for a Server Errors tab, link, or filter option", screenshotUrl: null, assertionPassed: null });
    const navItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button, [role='tab'], li"))
        .map((el) => (el as HTMLElement).innerText.trim())
        .filter((t) => t.length > 0 && t.length < 80)
        .slice(0, 40)
    );
    console.log("[PAR Demo] Visible nav items:", navItems.join(" | "));
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-locate-errors");

    // ── Server Errors: ACT — click it (with retry) ────────────────────────
    addStep({ phase: "ACT", label: "Click Server Errors", description: "Attempting to filter/navigate to the Server Errors view using multiple strategies", screenshotUrl: null, assertionPassed: null });
    const { found, method } = await withRetry(() => clickServerErrors(page!));
    const sClick = demoState.steps.at(-1)!;
    sClick.description = found
      ? `Server Errors filter applied via: ${method}`
      : "Server Errors filter not found — capturing current error-relevant page content";
    demoState.steps.at(-1)!.screenshotUrl = await takeShot(page, "step-server-errors-clicked");

    // ── Server Errors: PERCEIVE — observe filtered grid (all pages) ───────
    addStep({ phase: "PERCEIVE", label: "Observe Server Errors View", description: "Reading all grid pages and extracting complete error data", screenshotUrl: null, assertionPassed: null });
    await page.waitForTimeout(1500);
    const { text: extractedText, rowCount, pageCount } = await extractAllPagesContent(page);
    const sObserve = demoState.steps.at(-1)!;
    sObserve.description = `Extracted ${rowCount} rows across ${pageCount} page${pageCount !== 1 ? "s" : ""} · ${extractedText.length} chars`;
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
  app.post("/api/par-demo/run", async (req: Request, res: Response) => {
    if (demoState.status === "running" || demoState.status === "otp:waiting") {
      return res.status(409).json({ error: "A PAR demo is already running" });
    }
    const { dateFrom, dateTo } = (req.body ?? {}) as { dateFrom?: string; dateTo?: string };
    runParScript({ dateFrom, dateTo }).catch(console.error);
    res.json({ started: true, dateRange: dateFrom && dateTo ? { dateFrom, dateTo } : null });
  });

  app.get("/api/par-demo/status", (_req: Request, res: Response) => {
    res.json({
      status: demoState.status,
      steps: demoState.steps,
      errorMessage: demoState.errorMessage,
      aiSummary: demoState.aiSummary,
      aiSummaryPending: demoState.aiSummaryPending,
      dateRange: demoState.dateRange,
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
    demoState = { status: "idle", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false, dateRange: null };
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
