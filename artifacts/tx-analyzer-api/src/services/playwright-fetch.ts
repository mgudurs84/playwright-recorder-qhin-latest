import { chromium, type Browser, type BrowserContextOptions, type Route } from "playwright";
import { loadSession } from "./auth.js";
import type { TransactionDetail } from "./direct-fetch.js";

const PORTAL_URL =
  process.env.CW_PORTAL_URL ??
  "https://integration.commonwellalliance.lkopera.com";

const DETAIL_URL = `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsDetailPartialView`;
const OID_REGEX = /\d+(?:\.\d+){5,}/g;

// Kendo Grid ID confirmed from portal DOM inspection
const GRID_SELECTOR = "#gridTransactionLogsHistoryList";
const GRID_ROWS_SELECTOR = `${GRID_SELECTOR} .k-grid-content tbody tr, ${GRID_SELECTOR} tbody tr`;

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

/**
 * Convert a Kendo Grid JSON data-source response to tab-separated log lines.
 *
 * Handles both formats returned by the portal:
 *   Classic:  { TimeStampDisplay, Level, Component, Message }
 *   OTel:     { TimeStampDisplay, logLevel, "service.name", message }
 */
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

    const lines = rows.map((row) => {
      const ts = String(
        row["TimeStampDisplay"] ?? row["Timestamp"] ?? row["timestamp"] ?? ""
      );
      // OTel uses "logLevel" (lowercase), classic uses "Level"
      const level = String(
        row["logLevel"] ?? row["Level"] ?? row["LogLevel"] ?? "information"
      );
      // OTel uses "service.name" (dotted), classic uses "Component"
      const service = String(
        row["service.name"] ?? row["Component"] ?? row["Source"] ?? ""
      );
      // OTel uses "message" (lowercase), classic uses "Message"
      const message = String(
        row["message"] ?? row["Message"] ?? row["Description"] ?? ""
      );
      return `${ts}\t${level}\t${service}\t${message}`;
    });

    return lines.join("\n");
  } catch {
    return null;
  }
}

/** Extract transaction detail fields from partial view HTML */
function extractFieldsFromHtml(html: string): Record<string, string> {
  const fields: Record<string, string> = {};

  const dlRegex = /<dl[^>]*>([\s\S]*?)<\/dl>/gi;
  for (const [, dlContent] of html.matchAll(dlRegex)) {
    const pairRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    for (const [, label, value] of dlContent.matchAll(pairRegex)) {
      const k = label.replace(/<[^>]+>/g, "").trim().replace(/:$/, "");
      const v = value.replace(/<[^>]+>/g, "").trim();
      if (k && v) fields[k] = v;
    }
  }

  const trRegex =
    /<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
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
 * Key approach — read #gridTransactionLogsHistoryList directly from the DOM:
 *   The portal embeds a Kendo Grid with id="gridTransactionLogsHistoryList" that
 *   has four columns confirmed from DOM inspection:
 *     TimeStampDisplay | logLevel | service.name | message
 *   Once Playwright has the page loaded and Kendo has bound its data source,
 *   those rows are in the DOM — we read them directly instead of calling
 *   BindTransactionLogsHistory separately.
 *
 * We also intercept all /TransactionLogs/* network responses so that if the
 * Kendo Grid loads via AJAX, we capture the JSON too.
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

  // Intercept all /TransactionLogs/* responses — captures Kendo data-source JSON
  const captured: CapturedResponse[] = [];
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

    const formToken: string | null = await page.evaluate((): string | null => {
      const el = document.querySelector<HTMLInputElement>(
        'input[name="__RequestVerificationToken"]'
      );
      return el?.value ?? null;
    });

    console.log(`[PlaywrightFetch] CSRF: ${formToken ? "ok" : "missing"}`);

    // Fetch the detail partial view from within the browser (same origin)
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

    console.log(`[PlaywrightFetch] Partial view: ${rawHtml.length} chars`);

    // Inject the partial view into the live portal page
    // The portal page has Kendo UI, jQuery, etc. already loaded —
    // the inline scripts in rawHtml will initialise #gridTransactionLogsHistoryList
    // and its data source, which fires AJAX to populate the rows.
    await page.evaluate((html: string): void => {
      const existing = document.getElementById("pw-detail-root");
      if (existing) existing.remove();

      const container = document.createElement("div");
      container.id = "pw-detail-root";
      container.style.cssText =
        "position:absolute;top:0;left:0;width:1200px;min-height:200px;z-index:-1;visibility:hidden";
      container.innerHTML = html;
      document.body.appendChild(container);

      // Re-execute inline scripts so Kendo Grid initialises and calls its data source
      container
        .querySelectorAll<HTMLScriptElement>("script")
        .forEach((orig: HTMLScriptElement) => {
          if (!orig.textContent?.trim()) return;
          try {
            const s = document.createElement("script");
            s.textContent = orig.textContent;
            document.head.appendChild(s);
            s.remove();
          } catch { /* ignore */ }
        });
    }, rawHtml);

    // Wait for the specific grid rows to appear in the DOM
    // This is the grid confirmed from portal DOM inspection:
    //   #gridTransactionLogsHistoryList — columns: Timestamp | Level | Service | Message
    const gridAppeared = await page
      .waitForSelector(GRID_ROWS_SELECTOR, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);

    // If grid didn't render rows, wait for network idle as fallback
    if (!gridAppeared) {
      await page
        .waitForLoadState("networkidle", { timeout: 10000 })
        .catch(() => {});
    }

    console.log(`[PlaywrightFetch] Grid rows visible: ${gridAppeared}`);

    // ── Read the grid directly from the DOM ───────────────────────────────────
    // Columns (confirmed from portal HTML): Timestamp | logLevel | service.name | message
    const gridRows: string[][] = await page
      .$$eval(
        GRID_ROWS_SELECTOR,
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

    console.log(`[PlaywrightFetch] Grid rows read from DOM: ${gridRows.length}`);

    // ── Extract detail metadata fields from rendered DOM ──────────────────────
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

      return fields;
    });

    // ── Determine best log source ─────────────────────────────────────────────

    // 1. DOM grid rows (preferred — fully rendered, includes service.name + message)
    let bestLogs: string | undefined;
    let logSourceUrl: string | undefined;

    const nonEmptyGridRows = gridRows.filter((r) =>
      r.length >= 2 && r.some((c) => c.trim().length > 0)
    );

    if (nonEmptyGridRows.length > 0) {
      bestLogs = nonEmptyGridRows.map((r) => r.join("\t")).join("\n");
      logSourceUrl = `DOM #gridTransactionLogsHistoryList (${nonEmptyGridRows.length} rows)`;
      console.log(
        `[PlaywrightFetch] Using DOM grid rows — sample: ${nonEmptyGridRows[0]?.join(" | ")}`
      );
    }

    // 2. Intercepted JSON (fallback — in case DOM read was empty)
    if (!bestLogs || bestLogs.trim().length === 0) {
      for (const r of captured) {
        const normalized = normalizeKendoJson(r.body);
        if (normalized && normalized.length > (bestLogs?.length ?? 0)) {
          bestLogs = normalized;
          logSourceUrl = `Intercepted JSON: ${r.url}`;
        }
      }
    }

    // 3. Tab-separated text from intercepted responses
    if (!bestLogs || bestLogs.trim().length === 0) {
      for (const r of captured) {
        const hasCwFormat =
          /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\t/i.test(r.body);
        if (hasCwFormat && r.body.length > (bestLogs?.length ?? 0)) {
          bestLogs = r.body;
          logSourceUrl = `Intercepted text: ${r.url}`;
        }
      }
    }

    console.log(
      `[PlaywrightFetch] Log source: ${logSourceUrl ?? "none"}, ` +
        `rows: ${bestLogs ? bestLogs.split("\n").length : 0}`
    );

    // Merge fields: HTML parse + DOM rendering
    const htmlFields = extractFieldsFromHtml(rawHtml);
    const mergedFields: Record<string, string> = { ...htmlFields, ...domFields };

    const allText =
      Object.values(mergedFields).join(" ") +
      " " + (bestLogs ?? "") +
      " " + rawHtml +
      " " + captured.map((r) => r.body).join(" ");
    const oids = extractOids(allText);

    console.log(
      `[PlaywrightFetch] Final — fields: ${Object.keys(mergedFields).length}, ` +
        `OIDs: ${oids.length}, logs: ${bestLogs ? "yes" : "no"}`
    );

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

    return detail;
  } finally {
    await context.close();
  }
}
