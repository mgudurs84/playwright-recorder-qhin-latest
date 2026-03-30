import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "tx-screenshots");
const SESSION_FILE = path.resolve(process.env.SESSION_FILE ?? "data/session.json");
const ENDPOINTS_FILE = path.resolve(process.env.ENDPOINTS_FILE ?? "data/endpoints.json");
const PORTAL_URL = process.env.CW_PORTAL_URL ?? "https://integration.commonwellalliance.lkopera.com";
const SESSION_MAX_AGE_HOURS = parseInt(process.env.SESSION_MAX_AGE_HOURS ?? "24", 10);
const DEFAULT_TIMEOUT = 60000;

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!existsSync(path.dirname(SESSION_FILE))) mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export interface SessionData {
  cookies: CookieEntry[];
  storageState: {
    cookies: CookieEntry[];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  savedAt: string;
  expiresAt: string;
}

export interface EndpointEntry {
  url: string;
  method: string;
  contentType: string;
  trigger: string;
}

export interface DiscoveredEndpoints {
  detailHtml?: string;
  detailJson?: string;
  orgLookup?: string;
  /** Endpoints that likely carry raw FHIR / message payload data */
  payloadEndpoints: EndpointEntry[];
  /** Endpoints that likely carry per-transaction broker log lines */
  logEndpoints: EndpointEntry[];
  all: EndpointEntry[];
  discoveredAt: string;
}

export interface LoginResult {
  success: boolean;
  needsOtp: boolean;
  message: string;
  expiresAt?: string;
}

export interface OtpResult {
  success: boolean;
  message: string;
  expiresAt?: string;
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let currentState: "idle" | "authenticating" | "waitingForOtp" | "authenticated" = "idle";

async function ensureBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  browser.on("disconnected", () => {
    browser = null;
    context = null;
    page = null;
    currentState = "idle";
  });
  return browser;
}

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  const b = await ensureBrowser();
  context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
  return page;
}

async function saveSession(): Promise<string> {
  if (!context) throw new Error("No browser context");
  const cookies = await context.cookies();
  const storageState = await context.storageState();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3600 * 1000).toISOString();
  const sessionData: SessionData = {
    cookies,
    storageState,
    savedAt: new Date().toISOString(),
    expiresAt,
  };
  writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), "utf8");
  console.log(`[AuthService] Session saved, expires: ${expiresAt}`);
  return expiresAt;
}

export function loadSession(): SessionData | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionData;
    if (new Date() > new Date(raw.expiresAt)) {
      console.log("[AuthService] Saved session expired");
      return null;
    }
    return raw;
  } catch (err) {
    console.warn("[AuthService] Failed to load session:", (err as Error).message);
    return null;
  }
}

export function loadEndpoints(): DiscoveredEndpoints | null {
  if (!existsSync(ENDPOINTS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ENDPOINTS_FILE, "utf8")) as DiscoveredEndpoints;
  } catch {
    return null;
  }
}

/**
 * Validate session by making a real authenticated HEAD request to the portal homepage.
 * Returns false if the session is expired, invalid, or redirects to a login page.
 */
export async function probePortalSession(cookies: CookieEntry[]): Promise<boolean> {
  try {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(`${PORTAL_URL}/`, {
      method: "HEAD",
      headers: {
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "manual",
    });
    const loc = res.headers.get("location") ?? "";
    const isRedirectedToLogin =
      loc.toLowerCase().includes("login") ||
      loc.toLowerCase().includes("signin") ||
      res.status === 302 || res.status === 301;
    if (isRedirectedToLogin) {
      console.log("[AuthService] Portal probe: session expired (redirect to login)");
      return false;
    }
    console.log(`[AuthService] Portal probe: HTTP ${res.status} — session valid`);
    return true;
  } catch (err) {
    console.warn("[AuthService] Portal probe failed:", (err as Error).message);
    return false;
  }
}

export async function getSessionStatus(): Promise<{ valid: boolean; expiresAt?: string }> {
  const session = loadSession();
  if (!session) return { valid: false };

  const liveValid = await probePortalSession(session.cookies);
  if (!liveValid) return { valid: false };

  return { valid: true, expiresAt: session.expiresAt };
}

/** URL keyword patterns that indicate raw payload / FHIR message data */
const PAYLOAD_KEYWORDS = [
  "payload", "rawpayload", "message", "body", "fhir",
  "download", "export", "raw", "request", "response",
  "getbinary", "getcontent", "getdocument", "document",
];

/** URL keyword patterns that indicate broker log line data */
const LOG_KEYWORDS = [
  "logline", "loglines", "log_line", "eventlog", "eventlogs",
  "getlogs", "getlog", "logdata", "transactionlog",
];

function isPayloadEndpoint(url: string): boolean {
  const u = url.toLowerCase();
  return PAYLOAD_KEYWORDS.some((kw) => u.includes(kw)) && u.startsWith(PORTAL_URL.toLowerCase());
}

function isLogEndpoint(url: string): boolean {
  const u = url.toLowerCase();
  // Must be in the portal and look like a log-lines endpoint (not the detail view itself)
  return (
    u.startsWith(PORTAL_URL.toLowerCase()) &&
    LOG_KEYWORDS.some((kw) => u.includes(kw)) &&
    !u.includes("detail")
  );
}

async function runNetworkDiscovery(p: Page): Promise<DiscoveredEndpoints> {
  const captured: EndpointEntry[] = [];
  const seen = new Set<string>();

  // Capture ALL requests from the portal — not just XHR — to find download/export URLs
  p.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith(PORTAL_URL) || seen.has(url)) return;
    seen.add(url);

    const method = req.method();
    const headers = req.headers();
    const contentType = headers["content-type"] ?? "";
    const accept = headers["accept"] ?? "";
    const isXhr = headers["x-requested-with"] === "XMLHttpRequest";
    const isApi = accept.includes("application/json") || accept.includes("text/html");
    const isPost = method === "POST";
    const isPotentialPayload = isPayloadEndpoint(url);

    // Capture XHR, POSTs, API calls, and anything that looks like a payload endpoint
    if (isXhr || isApi || isPost || isPotentialPayload) {
      const trigger = url.includes("Detail") ? "row-expand"
        : url.includes("Load") ? "partial-view"
        : isPotentialPayload ? "payload-probe"
        : "page-load";
      captured.push({ url, method, contentType, trigger });
    }
  });

  try {
    const txUrl = `${PORTAL_URL}/TransactionLogs/index`;
    await p.goto(txUrl, { waitUntil: "networkidle", timeout: 60000 });
    await p.waitForTimeout(3000);

    // Step 1: expand the first transaction row
    const rows = p.locator("tr.k-master-row, tr[data-uid], tbody tr").first();
    if ((await rows.count()) > 0) {
      try {
        await rows.click({ timeout: 5000 });
        await p.waitForTimeout(2500);
        console.log("[Discovery] Clicked first transaction row");
      } catch {
        console.log("[Discovery] Could not expand a row — may need real transaction data");
      }
    }

    // Step 2: look for and click log-lines tabs/buttons first (highest priority for log discovery)
    const logTabSelectors = [
      "a:has-text('Log Lines')",
      "a:has-text('Logs')",
      "a:has-text('Event Log')",
      "a:has-text('Log')",
      "button:has-text('Log Lines')",
      "button:has-text('Logs')",
      "li:has-text('Log Lines') a",
      "li:has-text('Logs') a",
      "[href*='log']",
      "[data-tab='logs']",
      "[data-target*='log']",
    ];

    for (const selector of logTabSelectors) {
      try {
        const btn = p.locator(selector).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 3000 });
          await p.waitForTimeout(2000);
          console.log(`[Discovery] Clicked log tab: ${selector}`);
          break;
        }
      } catch {
        // not found — continue
      }
    }

    // Step 3: look for and click payload-revealing buttons in the expanded detail panel
    // (e.g. "View", "Download", "Raw", "FHIR", "Message Body", "Request", "Response")
    const payloadButtonSelectors = [
      "button:has-text('View')",
      "button:has-text('Download')",
      "button:has-text('Raw')",
      "button:has-text('FHIR')",
      "button:has-text('Message')",
      "button:has-text('Request')",
      "button:has-text('Response')",
      "a:has-text('Download')",
      "a:has-text('View Raw')",
      "a:has-text('Payload')",
      "[data-action='download']",
      "[data-action='view-payload']",
    ];

    for (const selector of payloadButtonSelectors) {
      try {
        const btn = p.locator(selector).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 3000 });
          await p.waitForTimeout(1500);
          console.log(`[Discovery] Clicked payload button: ${selector}`);
          break;
        }
      } catch {
        // button not found or not clickable — continue
      }
    }

    // Step 4: also wait for any lazy-loaded content
    await p.waitForTimeout(2000);
  } catch (err) {
    console.warn("[Discovery] Navigation failed:", (err as Error).message);
  }

  // Classify captured endpoints
  const isDetailUrl = (url: string) => {
    const u = url.toLowerCase();
    return u.includes("detail") && !u.includes("list") && !u.includes("index");
  };

  const detailEntry = captured.find((e) => isDetailUrl(e.url));
  const jsonEntry = captured.find(
    (e) => e.url.includes("json") || (e.url.includes("data") && e.contentType.includes("json"))
  );
  const orgEntry = captured.find(
    (e) => e.url.toLowerCase().includes("org") || e.url.toLowerCase().includes("organization")
  );
  const payloadEntries = captured.filter(
    (e) => isPayloadEndpoint(e.url) && !isDetailUrl(e.url)
  );
  const logEntries = captured.filter((e) => isLogEndpoint(e.url));

  console.log(`[Discovery] Found ${payloadEntries.length} potential payload endpoint(s):`);
  payloadEntries.forEach((e) => console.log(`  [${e.method}] ${e.url}`));
  console.log(`[Discovery] Found ${logEntries.length} potential log line endpoint(s):`);
  logEntries.forEach((e) => console.log(`  [${e.method}] ${e.url}`));

  const discovered: DiscoveredEndpoints = {
    detailHtml: detailEntry?.url,
    detailJson: jsonEntry?.url,
    orgLookup: orgEntry?.url,
    payloadEndpoints: payloadEntries,
    logEndpoints: logEntries,
    all: captured,
    discoveredAt: new Date().toISOString(),
  };

  writeFileSync(ENDPOINTS_FILE, JSON.stringify(discovered, null, 2), "utf8");
  console.log(`[Discovery] Saved ${captured.length} total endpoints to ${ENDPOINTS_FILE}`);
  return discovered;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const p = await getPage();
    currentState = "authenticating";

    await p.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const hasLoginForm = await p
      .locator('#UserName, input[name="UserName"], input[type="email"]')
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!hasLoginForm) {
      currentState = "authenticated";
      const expiresAt = await saveSession();
      void runNetworkDiscovery(p).catch((e) =>
        console.warn("[AuthService] Background discovery error:", (e as Error).message)
      );
      return { success: true, needsOtp: false, message: "Already authenticated", expiresAt };
    }

    await p.locator('#UserName, input[name="UserName"], input[type="email"]').first().fill(username);
    await p.locator('#Password, input[name="Password"], input[type="password"]').first().fill(password);
    await p.locator('#btnLogin, button[type="submit"], button:has-text("Sign in")').first().click();
    await p.waitForTimeout(5000);

    const onOtpPage =
      p.url().includes("UserValidate") ||
      (await p.$("#OTP")) !== null ||
      (await p.$("#btnSendEmail")) !== null;

    if (onOtpPage) {
      currentState = "waitingForOtp";
      const sendEmailBtn = p.locator("#btnSendEmail");
      if ((await sendEmailBtn.count()) > 0) {
        await sendEmailBtn.click();
        await p.waitForTimeout(2000);
      }
      return { success: true, needsOtp: true, message: "OTP required — check your email" };
    }

    const isLoggedIn = !p.url().toLowerCase().includes("login");
    if (isLoggedIn) {
      currentState = "authenticated";
      const expiresAt = await saveSession();
      void runNetworkDiscovery(p).catch((e) =>
        console.warn("[AuthService] Background discovery error:", (e as Error).message)
      );
      return { success: true, needsOtp: false, message: "Login successful", expiresAt };
    }

    currentState = "idle";
    return { success: false, needsOtp: false, message: "Login failed — check credentials" };
  } catch (err) {
    currentState = "idle";
    return { success: false, needsOtp: false, message: `Login error: ${(err as Error).message}` };
  }
}

export async function submitOtp(otp: string): Promise<OtpResult> {
  try {
    const p = await getPage();
    await p.locator('#OTP, input[name="OTP"], input[name="otp"]').first().fill(otp);
    await p.locator('#btnLogin, button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first().click();
    await p.waitForTimeout(5000);

    const stillOnOtp =
      p.url().includes("UserValidate") ||
      (await p.$("#OTP")) !== null;

    if (!stillOnOtp) {
      currentState = "authenticated";
      const expiresAt = await saveSession();
      void runNetworkDiscovery(p).catch((e) =>
        console.warn("[AuthService] Background discovery error:", (e as Error).message)
      );
      return { success: true, message: "OTP accepted", expiresAt };
    }

    return { success: false, message: "Invalid OTP — try again" };
  } catch (err) {
    return { success: false, message: `OTP error: ${(err as Error).message}` };
  }
}

export async function takeScreenshot(transactionId: string): Promise<string | null> {
  try {
    const session = loadSession();
    if (!session) return null;

    const b = await ensureBrowser();
    const ctx = await b.newContext({
      storageState: session.storageState,
      viewport: { width: 1440, height: 900 },
    });
    await ctx.addCookies(session.cookies);
    const p = await ctx.newPage();
    p.setDefaultTimeout(DEFAULT_TIMEOUT);

    const url = `${PORTAL_URL}/TransactionLogs/index?transactionId=${encodeURIComponent(transactionId)}`;
    await p.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    const filename = `tx-${transactionId.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await p.screenshot({ path: filepath, fullPage: true });
    await ctx.close();

    return `/api/screenshots/${filename}`;
  } catch (err) {
    console.error("[AuthService] Screenshot failed:", (err as Error).message);
    return null;
  }
}

export function getAuthState() {
  return currentState;
}
