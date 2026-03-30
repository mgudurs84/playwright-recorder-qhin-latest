import { chromium, type Browser, type BrowserContextOptions, type Route } from "playwright";
import { loadSession } from "./auth.js";
import type { TransactionDetail } from "./direct-fetch.js";

const PORTAL_URL =
  process.env.CW_PORTAL_URL ??
  "https://integration.commonwellalliance.lkopera.com";

const DETAIL_URL = `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsDetailPartialView`;
const OID_REGEX = /\d+(?:\.\d+){5,}/g;

let pwBrowser: Browser | null = null;

async function ensurePwBrowser(): Promise<Browser> {
  if (pwBrowser?.isConnected()) return pwBrowser;
  pwBrowser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  pwBrowser.on("disconnected", () => { pwBrowser = null; });
  return pwBrowser;
}

function extractOids(text: string): string[] {
  const raw = text.match(OID_REGEX) ?? [];
  return [...new Set(raw.filter((m) => m.startsWith("2.16.840") || m.startsWith("1.3.6")))];
}

/** Convert a Kendo Grid JSON response {Data:[...], Total:N} to tab-separated lines */
function normalizeKendoJson(body: string): string | null {
  try {
    const json = JSON.parse(body) as unknown;
    if (
      typeof json !== "object" ||
      json === null ||
      !("Data" in json) ||
      !Array.isArray((json as { Data: unknown }).Data)
    ) return null;

    const rows = (json as { Data: Array<Record<string, unknown>> }).Data;
    if (rows.length === 0) return null;

    return rows
      .map((row) => {
        const ts = String(row["TimeStampDisplay"] ?? row["Timestamp"] ?? "");
        const level = String(row["Level"] ?? row["LogLevel"] ?? "Information");
        const component = String(row["Component"] ?? row["Source"] ?? "");
        const message = String(row["Message"] ?? row["Description"] ?? "");
        return `${ts}\t${level}\t${component}\t${message}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

/** Extract transaction detail fields from HTML using multiple patterns */
function extractFieldsFromHtml(html: string): Record<string, string> {
  const fields: Record<string, string> = {};

  // dl/dt/dd pairs (most common in portal partial views)
  const dlRegex = /<dl[^>]*>([\s\S]*?)<\/dl>/gi;
  for (const [, dlContent] of html.matchAll(dlRegex)) {
    const dtRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    for (const [, label, value] of dlContent.matchAll(dtRegex)) {
      const k = label.replace(/<[^>]+>/g, "").trim().replace(/:$/, "");
      const v = value.replace(/<[^>]+>/g, "").trim();
      if (k && v) fields[k] = v;
    }
  }

  // label + adjacent span/p/div in form groups
  const lgRegex =
    /<label[^>]*>([\s\S]*?)<\/label>[\s\S]*?<(?:span|p|div|input)[^>]*>([^<]*)</gi;
  for (const [, label, value] of html.matchAll(lgRegex)) {
    const k = label.replace(/<[^>]+>/g, "").trim().replace(/:$/, "");
    const v = value.trim();
    if (k && v && k.length < 80) fields[k] = v;
  }

  // 2-cell table rows  <td>Label</td><td>Value</td>
  const trRegex = /<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  for (const [, col1, col2] of html.matchAll(trRegex)) {
    const k = col1.replace(/<[^>]+>/g, "").trim().replace(/:$/, "");
    const v = col2.replace(/<[^>]+>/g, "").trim();
    if (k && v && k.length < 80 && !k.includes("\n")) fields[k] = v;
  }

  return fields;
}

interface CapturedResponse {
  url: string;
  contentType: string;
  body: string;
}

/**
 * Fetch a transaction detail using a real Playwright browser.
 *
 * The critical improvement over the first version: **network interception**.
 * We capture every AJAX response the portal makes once the detail partial view
 * is loaded.  The Kendo Grid fires its own data-source requests (e.g.
 * BindTransactionLogsHistory) to populate the grid rows — these responses
 * carry the complete Component + Message columns that the raw HTML skeleton
 * does not contain.
 *
 * Flow:
 *   1. Set up context-level route interception for all /TransactionLogs/* URLs
 *   2. Navigate to the portal transaction logs index
 *   3. Fetch + inject the detail partial view (same origin → cookies & CSRF valid)
 *   4. Re-run inline <script> tags so Kendo Grids initialise
 *   5. Wait for network to go idle (all Kendo AJAX calls complete)
 *   6. Parse captured responses: JSON grid data + HTML field extraction
 *   7. Also read rendered DOM for any additional fields
 */
export async function fetchTransactionDetailPlaywright(
  transactionId: string
): Promise<TransactionDetail> {
  const session = loadSession();
  if (!session) throw new Error("No valid session — please log in first");

  const browser = await ensurePwBrowser();
  const contextOptions: BrowserContextOptions = {
    storageState: session.storageState as BrowserContextOptions["storageState"],
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const captured: CapturedResponse[] = [];

  // Intercept every request under /TransactionLogs to capture AJAX responses
  await context.route(
    (url) => url.href.includes("/TransactionLogs/"),
    async (route: Route) => {
      try {
        const response = await route.fetch();
        const body = await response.text();
        captured.push({
          url: route.request().url(),
          contentType: response.headers()["content-type"] ?? "",
          body,
        });
        await route.fulfill({ response, body });
      } catch {
        await route.continue();
      }
    }
  );

  try {
    console.log(`[PlaywrightFetch] Loading portal for ${transactionId}`);
    await page.goto(`${PORTAL_URL}/TransactionLogs`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (page.url().toLowerCase().includes("login")) {
      throw new Error("Session expired — portal redirected to login");
    }

    // Get CSRF token from the live page
    const formToken: string | null = await page.evaluate((): string | null => {
      const el = document.querySelector<HTMLInputElement>(
        'input[name="__RequestVerificationToken"]'
      );
      return el?.value ?? null;
    });

    console.log(`[PlaywrightFetch] CSRF token: ${formToken ? "ok" : "missing"}`);

    // Fetch the detail partial view HTML from within the browser context
    // (same origin — cookies and CSRF token are automatically included)
    const rawHtml: string = await page.evaluate(
      async ({
        txId,
        url,
        token,
      }: {
        txId: string;
        url: string;
        token: string | null;
      }): Promise<string> => {
        const fd = new FormData();
        fd.append("TransactionId", txId);
        if (token) fd.append("__RequestVerificationToken", token);
        const res = await fetch(url, { method: "POST", body: fd });
        return res.text();
      },
      { txId: transactionId, url: DETAIL_URL, token: formToken }
    );

    if (rawHtml.toLowerCase().includes("login") && rawHtml.length < 5000) {
      throw new Error("Session expired — partial view returned login page");
    }

    console.log(`[PlaywrightFetch] Partial view HTML: ${rawHtml.length} chars`);

    // Inject HTML into the live portal page so Kendo Grid scripts initialise
    // with access to the portal's loaded JS libraries (jQuery, Kendo UI, etc.)
    await page.evaluate((html: string): void => {
      const existing = document.getElementById("pw-detail-root");
      if (existing) existing.remove();

      const container = document.createElement("div");
      container.id = "pw-detail-root";
      container.style.cssText =
        "position:absolute;top:0;left:0;width:1200px;min-height:100px;z-index:-1;visibility:hidden";
      container.innerHTML = html;
      document.body.appendChild(container);

      // Re-execute inline <script> tags so Kendo Grids bind to their data sources
      container
        .querySelectorAll<HTMLScriptElement>("script")
        .forEach((orig: HTMLScriptElement) => {
          if (!orig.textContent?.trim()) return;
          try {
            const s = document.createElement("script");
            s.textContent = orig.textContent;
            document.head.appendChild(s);
            s.remove();
          } catch {
            /* ignore */
          }
        });
    }, rawHtml);

    // Wait for network idle — this lets Kendo Grid finish all its AJAX data-source reads
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});

    // Also try to wait for any visible grid rows
    await page
      .waitForSelector("#pw-detail-root .k-grid tbody tr", { timeout: 8000 })
      .catch(() => {});

    // Extract rendered DOM fields (may be richer than plain HTML parsing)
    const domFields: Record<string, string> = await page.evaluate((): Record<string, string> => {
      const fields: Record<string, string> = {};
      const root = document.getElementById("pw-detail-root");
      if (!root) return fields;

      root.querySelectorAll("dl").forEach((dl: HTMLElement) => {
        const dts = dl.querySelectorAll("dt");
        const dds = dl.querySelectorAll("dd");
        dts.forEach((dt: Element, i: number) => {
          const k = dt.textContent?.trim().replace(/:$/, "") ?? "";
          const v = dds[i]?.textContent?.trim() ?? "";
          if (k && v) fields[k] = v;
        });
      });

      root.querySelectorAll("tr").forEach((tr: Element) => {
        const cells = tr.querySelectorAll("td, th");
        if (cells.length === 2) {
          const k = cells[0].textContent?.trim().replace(/:$/, "") ?? "";
          const v = cells[1].textContent?.trim() ?? "";
          if (k && v && !k.includes("\n") && k.length < 80) fields[k] = v;
        }
      });

      root.querySelectorAll(".form-group, .field-row").forEach((row: Element) => {
        const label =
          row.querySelector("label")?.textContent?.trim().replace(/:$/, "") ?? "";
        const val =
          row.querySelector("span, p, .field-value")?.textContent?.trim() ?? "";
        if (label && val) fields[label] = val;
      });

      return fields;
    });

    // Also extract rendered Kendo Grid rows directly from the DOM
    const domGridRows: string[][] = await page
      .$$eval(
        "#pw-detail-root .k-grid tbody tr",
        (rows: Element[]): string[][] =>
          rows.map((row) =>
            Array.from(row.querySelectorAll("td")).map(
              (cell) =>
                (cell as HTMLElement).innerText?.trim() ??
                cell.textContent?.trim() ??
                ""
            )
          )
      )
      .catch((): string[][] => []);

    console.log(
      `[PlaywrightFetch] Captured ${captured.length} intercepted responses, ` +
      `${domGridRows.length} DOM grid rows, ${Object.keys(domFields).length} DOM fields`
    );

    // ── Parse captured network responses ──────────────────────────────────────

    // HTML fields parsed from static HTML (detail partial view, full page HTML)
    const htmlFields = extractFieldsFromHtml(rawHtml);

    // Find the best log data from captured responses:
    //   preference: JSON (Kendo data source) > tab-separated text
    let bestLogs: string | undefined;
    let logSourceUrl: string | undefined;

    for (const r of captured) {
      const isJson =
        r.contentType.includes("json") ||
        r.body.trimStart().startsWith("{") ||
        r.body.trimStart().startsWith("[");

      if (isJson) {
        const normalized = normalizeKendoJson(r.body);
        if (normalized && normalized.length > (bestLogs?.length ?? 0)) {
          bestLogs = normalized;
          logSourceUrl = r.url;
        }
      } else {
        // Tab-separated or plain text log lines
        const hasCwFormat =
          /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\t(Information|Warning|Error|Debug|Critical)/i.test(
            r.body
          );
        if (hasCwFormat && r.body.length > (bestLogs?.length ?? 0)) {
          bestLogs = r.body;
          logSourceUrl = r.url;
        }
      }
    }

    // Fallback: if DOM scraping caught rows, use those
    if (!bestLogs && domGridRows.length > 0) {
      bestLogs = domGridRows
        .filter((r) => r.some((c) => c.length > 0))
        .map((r) => r.join("\t"))
        .join("\n");
      logSourceUrl = "Playwright DOM scrape";
    }

    console.log(
      `[PlaywrightFetch] Log source: ${logSourceUrl ?? "none"}, ` +
      `rows: ${bestLogs ? bestLogs.split("\n").length : 0}`
    );

    // Merge field sources: DOM rendering > HTML parsing (DOM is more complete)
    const mergedFields: Record<string, string> = { ...htmlFields, ...domFields };

    // Collect all HTML for OID extraction
    const allText =
      Object.values(mergedFields).join(" ") +
      " " +
      (bestLogs ?? "") +
      " " +
      rawHtml +
      " " +
      captured.map((r) => r.body).join(" ");
    const oids = extractOids(allText);

    const detail: TransactionDetail = {
      transactionId,
      rawFields: mergedFields,
      oids,
      rawHtml,
      rawLogs: bestLogs,
      logEndpointUsed: logSourceUrl
        ? `Playwright → ${logSourceUrl}`
        : undefined,
      endpointUsed: `Playwright → ${DETAIL_URL}`,
      timestamp:
        mergedFields["Start Time"] ??
        mergedFields["Timestamp"] ??
        mergedFields["Date"],
      transactionType:
        mergedFields["Transaction Type"] ?? mergedFields["Type"],
      status:
        mergedFields["Transaction Status"] ?? mergedFields["Status"],
      requestingOrg:
        mergedFields["Initiating Org Name"] ??
        mergedFields["Requesting Org Name"],
      requestingOid:
        mergedFields["Initiating Org ID"] ??
        mergedFields["Requesting OID"],
      responseCode:
        mergedFields["Status Code"] ??
        mergedFields["HTTP Status Code"] ??
        mergedFields["Response Code"],
      errorCode: mergedFields["Error Code"],
      errorMessage: mergedFields["Error Message"] ?? mergedFields["Error"],
      duration: mergedFields["Duration"] ?? mergedFields["Elapsed"],
    };

    console.log(
      `[PlaywrightFetch] Final — fields: ${Object.keys(mergedFields).length}, ` +
      `OIDs: ${oids.length}, logs: ${bestLogs ? "yes" : "no"}`
    );

    return detail;
  } finally {
    await context.close();
  }
}
