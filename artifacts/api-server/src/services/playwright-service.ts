import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { db, cwSessions, cwRuns } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

const SCREENSHOTS_DIR = "/tmp/cw-screenshots";
const PORTAL_URL = "https://integration.commonwellalliance.lkopera.com/";
const DEFAULT_TIMEOUT = 60000;
const SESSION_MAX_AGE_HOURS = parseInt(process.env.SESSION_MAX_AGE_HOURS || "24", 10);

if (!existsSync(SCREENSHOTS_DIR)) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, backoffMs = 1000, onRetry } = opts;
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isStaleElement =
        lastError.message.includes("stale") ||
        lastError.message.includes("detached") ||
        lastError.message.includes("Target closed") ||
        lastError.message.includes("frame was detached");
      const isTimeout =
        lastError.message.includes("Timeout") ||
        lastError.message.includes("timeout");
      const isNetworkError =
        lastError.message.includes("net::") ||
        lastError.message.includes("ERR_") ||
        lastError.message.includes("ECONNREFUSED");

      if (attempt < maxAttempts && (isStaleElement || isTimeout || isNetworkError)) {
        onRetry?.(attempt, lastError);
        const delay = backoffMs * Math.pow(2, attempt - 1);
        console.log(
          `[PlaywrightService] Retry ${attempt}/${maxAttempts} after ${delay}ms: ${lastError.message.substring(0, 100)}`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

export function takeScreenshot(page: Page, label: string): string {
  const filename = `${label}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  page.screenshot({ path: filepath, fullPage: true }).catch((err) => {
    console.error(`[PlaywrightService] Screenshot failed (${label}):`, err.message);
  });
  return `/api/screenshots/${filename}`;
}

export async function takeScreenshotAsync(page: Page, label: string): Promise<string> {
  const filename = `${label}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: true });
  } catch (err: unknown) {
    console.error(`[PlaywrightService] Screenshot failed (${label}):`, (err as Error).message);
  }
  return `/api/screenshots/${filename}`;
}

export class PlaywrightService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private runId: string | null = null;

  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    console.log("[PlaywrightService] Launching browser...");
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    this.browser.on("disconnected", () => {
      console.warn("[PlaywrightService] Browser disconnected unexpectedly");
      this.browser = null;
      this.context = null;
      this.page = null;
    });
    return this.browser;
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    const browser = await this.ensureBrowser();
    this.context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    return this.page;
  }

  async saveSessionToDb(username: string): Promise<void> {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    const storageState = await this.context.storageState();
    const sessionData = { cookies, storageState };
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 60 * 60 * 1000);
    const id = `session-${username}`;

    const existing = await db.select().from(cwSessions).where(eq(cwSessions.id, id)).limit(1);
    if (existing.length > 0) {
      await db
        .update(cwSessions)
        .set({ sessionData, savedAt: new Date(), expiresAt })
        .where(eq(cwSessions.id, id));
    } else {
      await db.insert(cwSessions).values({ id, username, sessionData, expiresAt });
    }
    console.log(`[PlaywrightService] Session saved for ${username}, expires: ${expiresAt.toISOString()}`);
  }

  async loadSessionFromDb(username: string): Promise<boolean> {
    const id = `session-${username}`;
    const rows = await db.select().from(cwSessions).where(eq(cwSessions.id, id)).limit(1);
    if (rows.length === 0) return false;

    const session = rows[0];
    if (new Date() > session.expiresAt) {
      console.log(`[PlaywrightService] Session for ${username} expired`);
      return false;
    }

    try {
      const data = session.sessionData as { cookies: any[]; storageState: any };
      const browser = await this.ensureBrowser();
      this.context = await browser.newContext({
        storageState: data.storageState,
        viewport: { width: 1280, height: 800 },
      });
      if (data.cookies?.length > 0) {
        await this.context.addCookies(data.cookies);
      }
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
      console.log(`[PlaywrightService] Session restored for ${username}`);
      return true;
    } catch (err) {
      console.error("[PlaywrightService] Failed to restore session:", (err as Error).message);
      return false;
    }
  }

  async validateSession(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const url = this.page.url();
      const isLoginPage =
        url.includes("login") ||
        url.includes("signin") ||
        url.includes("auth") ||
        (await this.page.$('input[type="password"]')) !== null;

      if (isLoginPage) {
        console.log("[PlaywrightService] Session invalid — redirected to login");
        return false;
      }
      console.log("[PlaywrightService] Session valid — portal loaded");
      return true;
    } catch {
      return false;
    }
  }

  async login(username: string, password: string): Promise<{ needsOtp: boolean; screenshotUrl: string }> {
    const page = await this.getPage();

    return withRetry(
      async () => {
        await page.goto(PORTAL_URL, { waitUntil: "networkidle", timeout: 60000 });
        const screenshotLogin = await takeScreenshotAsync(page, "login-page");

        const usernameInput = page.locator('input[type="email"], input[name="username"], input[name="email"], #username, #email');
        const passwordInput = page.locator('input[type="password"]');

        await usernameInput.first().fill(username);
        await passwordInput.first().fill(password);

        const submitBtn = page.locator(
          'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")'
        );
        await submitBtn.first().click();

        await page.waitForTimeout(3000);

        const needsOtp =
          (await page.$('input[name="otp"]')) !== null ||
          (await page.$('input[name="code"]')) !== null ||
          (await page.$('input[name="verificationCode"]')) !== null ||
          (await page.getByText("verification code").count()) > 0 ||
          (await page.getByText("one-time").count()) > 0 ||
          (await page.getByText("OTP").count()) > 0;

        const screenshotUrl = await takeScreenshotAsync(page, needsOtp ? "otp-required" : "post-login");

        return { needsOtp, screenshotUrl };
      },
      {
        maxAttempts: 2,
        backoffMs: 2000,
        onRetry: (attempt, err) =>
          console.warn(`[PlaywrightService] Login retry ${attempt}: ${err.message}`),
      }
    );
  }

  async submitOtp(otp: string): Promise<{ success: boolean; screenshotUrl: string }> {
    const page = await this.getPage();

    return withRetry(async () => {
      const otpInput = page.locator(
        'input[name="otp"], input[name="code"], input[name="verificationCode"], input[type="tel"][maxlength]'
      );
      await otpInput.first().fill(otp);

      const verifyBtn = page.locator(
        'button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm")'
      );
      await verifyBtn.first().click();

      await page.waitForTimeout(3000);

      const stillOnOtpPage =
        (await page.$('input[name="otp"]')) !== null ||
        (await page.$('input[name="code"]')) !== null;

      const screenshotUrl = await takeScreenshotAsync(page, stillOnOtpPage ? "otp-failed" : "otp-success");

      return { success: !stillOnOtpPage, screenshotUrl };
    });
  }

  async navigateToTransactionLogs(): Promise<string> {
    const page = await this.getPage();

    return withRetry(async () => {
      const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
      await page.goto(txUrl, { waitUntil: "networkidle", timeout: 60000 });
      return await takeScreenshotAsync(page, "transaction-logs");
    });
  }

  async applyDateFilter(daysBack: number): Promise<string> {
    const page = await this.getPage();

    return withRetry(async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      const formatDate = (d: Date) =>
        `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

      const startInput = page.locator(
        'input[name="startDate"], input[placeholder*="start"], input[aria-label*="start"], input[name="fromDate"]'
      );
      const endInput = page.locator(
        'input[name="endDate"], input[placeholder*="end"], input[aria-label*="end"], input[name="toDate"]'
      );

      if ((await startInput.count()) > 0 && (await endInput.count()) > 0) {
        await startInput.first().fill(formatDate(startDate));
        await endInput.first().fill(formatDate(endDate));

        const searchBtn = page.locator(
          'button:has-text("Search"), button:has-text("Filter"), button:has-text("Apply"), input[type="submit"]'
        );
        if ((await searchBtn.count()) > 0) {
          await searchBtn.first().click();
        }
        await page.waitForTimeout(3000);
      }

      return await takeScreenshotAsync(page, "date-filter-applied");
    });
  }

  async waitForDataLoaded(): Promise<boolean> {
    const page = await this.getPage();

    for (let attempt = 1; attempt <= 15; attempt++) {
      const hasData = await page.evaluate(() => {
        const grid = document.querySelector(".k-grid-content table tbody");
        if (!grid) return false;
        const rows = grid.querySelectorAll("tr");
        if (rows.length === 0) return false;
        const firstCell = rows[0].querySelector("td");
        if (firstCell && firstCell.textContent?.trim() === "No data found") return false;
        return true;
      });

      if (hasData) {
        console.log(`[PlaywrightService] Data loaded (attempt ${attempt})`);
        return true;
      }
      console.log(`[PlaywrightService] Waiting for data... (${attempt}/15)`);
      await page.waitForTimeout(2000);
    }
    return false;
  }

  async extractViaKendoDataSource(maxRecords: number): Promise<any[] | null> {
    const page = await this.getPage();

    try {
      const records = await page.evaluate((max) => {
        const grid = (document.querySelector("[data-role='grid']") as any);
        if (!grid?.kendoGrid) return null;
        const ds = grid.kendoGrid.dataSource;
        if (!ds) return null;
        const allData = ds.data();
        const results: any[] = [];
        for (let i = 0; i < Math.min(allData.length, max || allData.length); i++) {
          const item = allData[i];
          results.push({
            timestamp: item.Timestamp || item.timestamp || "",
            transactionId: item.TransactionId || item.transactionId || "",
            transactionType: item.TransactionType || item.transactionType || "",
            memberName: item.MemberName || item.memberName || "",
            initiatingOrgId: item.InitiatingOrgId || item.initiatingOrgId || "",
            duration: item.Duration || item.duration || "",
            status: item.Status || item.status || "",
          });
        }
        return results;
      }, maxRecords);

      if (records && records.length > 0) {
        console.log(`[PlaywrightService] Kendo DataSource extraction: ${records.length} records`);
        return records;
      }
    } catch (err) {
      console.log(`[PlaywrightService] Kendo DataSource not available: ${(err as Error).message}`);
    }
    return null;
  }

  async extractViaDOMPagination(maxRecords: number): Promise<any[]> {
    const page = await this.getPage();
    const allTransactions: any[] = [];
    let pageNum = 1;

    while (true) {
      const pageTransactions = await withRetry(async () => {
        return page.evaluate(() => {
          const rows = document.querySelectorAll(".k-grid-content table tbody tr");
          const txns: any[] = [];
          rows.forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 7) {
              txns.push({
                timestamp: cells[0]?.textContent?.trim() || "",
                transactionId: cells[1]?.textContent?.trim() || "",
                transactionType: cells[2]?.textContent?.trim() || "",
                memberName: cells[3]?.textContent?.trim() || "",
                initiatingOrgId: cells[4]?.textContent?.trim() || "",
                duration: cells[5]?.textContent?.trim() || "",
                status: cells[6]?.textContent?.trim() || "",
              });
            }
          });
          return txns;
        });
      });

      console.log(`[PlaywrightService] Page ${pageNum}: ${pageTransactions.length} transactions`);
      allTransactions.push(...pageTransactions);

      if (maxRecords > 0 && allTransactions.length >= maxRecords) {
        console.log(`[PlaywrightService] Max records (${maxRecords}) reached`);
        break;
      }

      const nextButton = page.getByRole("button", { name: "Next" });
      const hasNext = (await nextButton.count()) > 0 && !(await nextButton.isDisabled().catch(() => true));
      if (!hasNext) break;

      await nextButton.click();
      await page.waitForTimeout(2000);
      pageNum++;
    }

    return allTransactions;
  }

  async extractTransactions(maxRecords: number = 0): Promise<{
    records: any[];
    screenshotUrl: string;
  }> {
    let records = await this.extractViaKendoDataSource(maxRecords);
    if (!records) {
      records = await this.extractViaDOMPagination(maxRecords);
    }

    const page = await this.getPage();
    const screenshotUrl = await takeScreenshotAsync(page, "extraction-complete");

    return { records, screenshotUrl };
  }

  async createRun(parameters: Record<string, unknown>): Promise<string> {
    const runId = randomUUID();
    await db.insert(cwRuns).values({
      id: runId,
      status: "running",
      parameters,
      records: [],
      steps: [],
      screenshotUrls: [],
    });
    this.runId = runId;
    return runId;
  }

  async updateRun(updates: Partial<{
    status: string;
    recordCount: number;
    errorCount: number;
    records: any[];
    steps: any[];
    screenshotUrls: string[];
    report: string;
    completedAt: Date;
  }>): Promise<void> {
    if (!this.runId) return;
    await db.update(cwRuns).set(updates).where(eq(cwRuns.id, this.runId));
  }

  async addRunStep(step: { type: string; content: string; screenshotUrl?: string }): Promise<void> {
    if (!this.runId) return;
    const run = await db.select().from(cwRuns).where(eq(cwRuns.id, this.runId)).limit(1);
    if (!run[0]) return;
    const currentSteps = (run[0].steps as any[]) || [];
    const currentScreenshots = (run[0].screenshotUrls as string[]) || [];
    const newStep = { ...step, timestamp: new Date().toISOString() };
    const newScreenshots = step.screenshotUrl
      ? [...currentScreenshots, step.screenshotUrl]
      : currentScreenshots;
    await db
      .update(cwRuns)
      .set({ steps: [...currentSteps, newStep], screenshotUrls: newScreenshots })
      .where(eq(cwRuns.id, this.runId));
  }

  getRunId(): string | null {
    return this.runId;
  }

  async close(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch {
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
    console.log("[PlaywrightService] Browser closed");
  }
}

let _instance: PlaywrightService | null = null;

export function getPlaywrightService(): PlaywrightService {
  if (!_instance) {
    _instance = new PlaywrightService();
  }
  return _instance;
}
