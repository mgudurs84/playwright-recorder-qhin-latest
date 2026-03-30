import { chromium, type Browser, type BrowserContextOptions } from "playwright";
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

/**
 * Fetch a transaction detail using a real Playwright browser so that:
 *  1. Kendo Grid initialisation scripts run inside the portal's JS context
 *  2. All grid columns (including Component + Message) are fully rendered
 *  3. We can extract rows that are blank in the raw API response
 *
 * Flow:
 *   navigate to portal index  →  get CSRF token  →  fetch partial-view HTML
 *   via page.evaluate (same origin, cookies work)  →  inject HTML into live DOM
 *   →  re-run inline <script> tags  →  wait for grid render  →  scrape rows + fields
 */
export async function fetchTransactionDetailPlaywright(
  transactionId: string
): Promise<TransactionDetail> {
  const session = loadSession();
  if (!session) {
    throw new Error("No valid session — please log in first");
  }

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

  try {
    console.log(`[PlaywrightFetch] Navigating to portal for ${transactionId}`);
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

    console.log(`[PlaywrightFetch] CSRF token: ${formToken ? "obtained" : "not found"}`);

    const rawHtml: string = await page.evaluate(
      async ({ txId, url, token }: { txId: string; url: string; token: string | null }): Promise<string> => {
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

    await page.evaluate((html: string): void => {
      const existing = document.getElementById("pw-detail-root");
      if (existing) existing.remove();

      const container = document.createElement("div");
      container.id = "pw-detail-root";
      container.style.cssText =
        "position:absolute;left:-9999px;visibility:hidden;width:1200px";
      container.innerHTML = html;
      document.body.appendChild(container);

      container.querySelectorAll<HTMLScriptElement>("script").forEach((orig: HTMLScriptElement) => {
        try {
          const s = document.createElement("script");
          if (orig.src) {
            s.src = orig.src;
          } else {
            s.textContent = orig.textContent;
          }
          document.head.appendChild(s);
          if (!orig.src) s.remove();
        } catch {
          /* ignore script errors */
        }
      });
    }, rawHtml);

    const gridRendered = await page
      .waitForSelector("#pw-detail-root .k-grid tbody tr", { timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    console.log(`[PlaywrightFetch] Kendo grid rendered: ${gridRendered}`);

    const logRows: string[][] = await page
      .$$eval(
        "#pw-detail-root .k-grid tbody tr",
        (rows: Element[]): string[][] =>
          rows.map((row) =>
            Array.from(row.querySelectorAll("td")).map(
              (cell) => (cell as HTMLElement).innerText?.trim() ?? cell.textContent?.trim() ?? ""
            )
          )
      )
      .catch((): string[][] => []);

    console.log(`[PlaywrightFetch] Log rows extracted: ${logRows.length}`);

    const colHeaders: string[] = await page
      .$$eval(
        "#pw-detail-root .k-grid thead th",
        (ths: Element[]): string[] =>
          ths.map((th) => (th as HTMLElement).innerText?.trim() ?? th.textContent?.trim() ?? "")
      )
      .catch((): string[] => []);

    const detailFields: Record<string, string> = await page.evaluate((): Record<string, string> => {
      const fields: Record<string, string> = {};
      const root = document.getElementById("pw-detail-root");
      if (!root) return fields;

      root.querySelectorAll("dl").forEach((dl: HTMLElement) => {
        const dts = dl.querySelectorAll("dt");
        const dds = dl.querySelectorAll("dd");
        dts.forEach((dt: Element, i: number) => {
          const key = dt.textContent?.trim().replace(/:$/, "") ?? "";
          const val = dds[i]?.textContent?.trim() ?? "";
          if (key && val) fields[key] = val;
        });
      });

      root.querySelectorAll("tr").forEach((tr: Element) => {
        const cells = tr.querySelectorAll("td, th");
        if (cells.length === 2) {
          const key = cells[0].textContent?.trim().replace(/:$/, "") ?? "";
          const val = cells[1].textContent?.trim() ?? "";
          if (key && val && !key.includes("\n") && key.length < 80) {
            fields[key] = val;
          }
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

    const rawLogs =
      logRows.length > 0
        ? logRows
            .filter((r) => r.some((c) => c.length > 0))
            .map((r) => r.join("\t"))
            .join("\n")
        : undefined;

    const allText =
      Object.values(detailFields).join(" ") +
      " " +
      (rawLogs ?? "") +
      " " +
      rawHtml;
    const oids = extractOids(allText);

    console.log(
      `[PlaywrightFetch] Done — fields: ${Object.keys(detailFields).length}, ` +
        `log rows: ${logRows.length}, OIDs: ${oids.length}, ` +
        `col headers: ${colHeaders.join("|") || "none"}`
    );

    const detail: TransactionDetail = {
      transactionId,
      rawFields: detailFields,
      oids,
      rawHtml,
      rawLogs,
      logEndpointUsed: rawLogs ? `Playwright → ${DETAIL_URL}` : undefined,
      endpointUsed: `Playwright → ${DETAIL_URL}`,
      timestamp:
        detailFields["Start Time"] ??
        detailFields["Timestamp"] ??
        detailFields["Date"],
      transactionType:
        detailFields["Transaction Type"] ?? detailFields["Type"],
      status:
        detailFields["Transaction Status"] ?? detailFields["Status"],
      requestingOrg:
        detailFields["Initiating Org Name"] ??
        detailFields["Requesting Org Name"],
      requestingOid:
        detailFields["Initiating Org ID"] ??
        detailFields["Requesting OID"],
      responseCode:
        detailFields["Status Code"] ??
        detailFields["HTTP Status Code"] ??
        detailFields["Response Code"],
      errorCode: detailFields["Error Code"],
      errorMessage:
        detailFields["Error Message"] ?? detailFields["Error"],
      duration: detailFields["Duration"] ?? detailFields["Elapsed"],
    };

    return detail;
  } finally {
    await context.close();
  }
}
