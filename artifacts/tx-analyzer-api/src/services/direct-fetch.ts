import { parse as parseHtml } from "node-html-parser";
import { loadSession, loadEndpoints, type SessionData } from "./auth.js";

const PORTAL_URL = process.env.CW_PORTAL_URL ?? "https://integration.commonwellalliance.lkopera.com";
const FALLBACK_DETAIL_URL = `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsDetailPartialView`;

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface TransactionDetail {
  transactionId: string;
  timestamp?: string;
  transactionType?: string;
  status?: string;
  requestingOrg?: string;
  requestingOid?: string;
  respondingOrg?: string;
  respondingOid?: string;
  patientId?: string;
  memberId?: string;
  errorCode?: string;
  errorMessage?: string;
  responseCode?: string;
  duration?: string;
  rawFields: Record<string, string>;
  oids: string[];
  rawHtml?: string;
  endpointUsed?: string;
}

function buildCookieHeader(cookies: SessionData["cookies"]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Extract the __RequestVerificationToken from the page HTML.
 * ASP.NET Core antiforgery uses TWO tokens:
 *   1. Cookie (.AspNetCore.Antiforgery.*) — sent automatically via Cookie header
 *   2. Form/header token — must come from a hidden <input> or <meta> in the page HTML
 * Using the cookie value as the form token is WRONG and causes HTTP 400.
 */
function extractFormToken(html: string): string | null {
  const root = parseHtml(html);

  // Most common: hidden input field
  const input = root.querySelector('input[name="__RequestVerificationToken"]');
  if (input) return input.getAttribute("value") ?? null;

  // Some pages use a meta tag
  const meta = root.querySelector('meta[name="__RequestVerificationToken"]');
  if (meta) return meta.getAttribute("content") ?? null;

  // Regex fallback for dynamic pages
  const match = html.match(/__RequestVerificationToken[^>]*value="([^"]+)"/);
  if (match) return match[1];

  return null;
}

function extractOids(text: string): string[] {
  const oidRegex = /\d+(?:\.\d+){5,}/g;
  const matches = text.match(oidRegex) ?? [];
  return [
    ...new Set(
      matches.filter((m) => m.startsWith("2.16.840") || m.startsWith("1.3.6"))
    ),
  ];
}

function parseHtmlDetail(html: string, transactionId: string): TransactionDetail {
  const root = parseHtml(html);
  const rawFields: Record<string, string> = {};

  root.querySelectorAll("tr").forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length >= 2) {
      rawFields[cells[0].text.trim()] = cells[1].text.trim();
    }
  });

  root.querySelectorAll("dl dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") {
      rawFields[dt.text.trim()] = dd.text.trim();
    }
  });

  root.querySelectorAll(".field-label, .label").forEach((label) => {
    const value = label.nextElementSibling;
    if (value) {
      rawFields[label.text.trim()] = value.text.trim();
    }
  });

  const allText = root.text;
  const oids = extractOids(allText);

  const getValue = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const found = Object.entries(rawFields).find(([k]) =>
        k.toLowerCase().includes(key.toLowerCase())
      );
      if (found) return found[1];
    }
    return undefined;
  };

  const reqOidMatch = allText.match(/requesting[^:]*oid[^:]*:\s*([0-9.]+)/i);
  const resOidMatch = allText.match(/responding[^:]*oid[^:]*:\s*([0-9.]+)/i);

  return {
    transactionId,
    timestamp: getValue("timestamp", "date", "created"),
    transactionType: getValue("type", "transaction type", "request type"),
    status: getValue("status", "result", "outcome"),
    requestingOrg: getValue("requesting org", "requester"),
    requestingOid: reqOidMatch?.[1] ?? oids[0],
    respondingOrg: getValue("responding org", "responder"),
    respondingOid: resOidMatch?.[1] ?? oids[1],
    patientId: getValue("patient id", "patient"),
    memberId: getValue("member id", "member"),
    errorCode: getValue("error code", "fault code"),
    errorMessage: getValue("error message", "fault message", "error detail"),
    responseCode: getValue("response code", "http status"),
    duration: getValue("duration", "elapsed"),
    rawFields,
    oids,
    rawHtml: html,
  };
}

/**
 * Fetch the TransactionLogs index page to grab a fresh CSRF form token.
 * This is required before any POST — the antiforgery form token lives in the HTML,
 * not in the cookies.
 */
async function fetchCsrfFormToken(cookieHeader: string): Promise<string | null> {
  try {
    const res = await fetch(`${PORTAL_URL}/TransactionLogs/index`, {
      method: "GET",
      headers: {
        ...BASE_HEADERS,
        Cookie: cookieHeader,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      console.warn(`[DirectFetch] CSRF page fetch returned ${res.status}`);
      return null;
    }
    const html = await res.text();
    const token = extractFormToken(html);
    if (token) {
      console.log("[DirectFetch] Got fresh CSRF form token from page");
    } else {
      console.warn("[DirectFetch] No __RequestVerificationToken found in page HTML");
    }
    return token;
  } catch (err) {
    console.warn("[DirectFetch] Failed to fetch CSRF token:", (err as Error).message);
    return null;
  }
}

/**
 * POST using application/x-www-form-urlencoded (preferred by ASP.NET Core).
 * Falls back to multipart/form-data if the first attempt returns 400.
 */
async function postDetail(
  url: string,
  transactionId: string,
  cookieHeader: string,
  formToken: string | null
): Promise<string> {
  const commonHeaders: Record<string, string> = {
    ...BASE_HEADERS,
    Cookie: cookieHeader,
    Accept: "text/html, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Origin: PORTAL_URL,
    Referer: `${PORTAL_URL}/TransactionLogs/index`,
  };

  if (formToken) {
    commonHeaders["__RequestVerificationToken"] = formToken;
    console.log("[DirectFetch] Sending CSRF token in request header");
  }

  // Attempt 1: application/x-www-form-urlencoded
  let body: string | FormData = new URLSearchParams({ transactionId }).toString();
  let contentType = "application/x-www-form-urlencoded";

  // Include form token in body too (some ASP.NET endpoints check the body, not just headers)
  if (formToken) {
    body = new URLSearchParams({
      transactionId,
      __RequestVerificationToken: formToken,
    }).toString();
  }

  let response = await fetch(url, {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": contentType },
    body,
  });

  console.log(`[DirectFetch] urlencoded POST → HTTP ${response.status}`);

  // Attempt 2: fall back to multipart if urlencoded got 400/415
  if (response.status === 400 || response.status === 415) {
    console.log("[DirectFetch] Retrying with multipart/form-data...");
    const formData = new FormData();
    formData.append("transactionId", transactionId);
    if (formToken) formData.append("__RequestVerificationToken", formToken);

    response = await fetch(url, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": undefined as unknown as string,  // let fetch set multipart boundary
      },
      body: formData,
    });
    console.log(`[DirectFetch] multipart POST → HTTP ${response.status}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[DirectFetch] Portal error body (first 500 chars):", body.slice(0, 500));
    throw new Error(`Portal returned HTTP ${response.status}: ${response.statusText}`);
  }

  return response.text();
}

export async function fetchTransactionDetail(transactionId: string): Promise<TransactionDetail> {
  const session = loadSession();
  if (!session) {
    throw new Error("No valid session — please log in first");
  }

  const cookieHeader = buildCookieHeader(session.cookies);

  // Always fetch a fresh CSRF form token from the page before POSTing
  const formToken = await fetchCsrfFormToken(cookieHeader);

  const endpoints = loadEndpoints();
  const detailUrl =
    endpoints?.detailHtml ??
    endpoints?.all.find(
      (e) => e.url.includes("Detail") || e.url.includes("LoadTransaction")
    )?.url ??
    FALLBACK_DETAIL_URL;

  console.log(`[DirectFetch] Fetching detail for ${transactionId} via ${detailUrl}`);

  const html = await postDetail(detailUrl, transactionId, cookieHeader, formToken);

  if (html.includes("UserName") && html.includes("Password") && html.length < 5000) {
    throw new Error("Session expired — portal returned login page");
  }

  const detail: TransactionDetail = {
    ...parseHtmlDetail(html, transactionId),
    endpointUsed: detailUrl,
  };

  // Optionally augment with discovered JSON endpoint
  if (endpoints?.detailJson && endpoints.detailJson !== detailUrl) {
    try {
      const jsonRes = await fetch(
        `${endpoints.detailJson}?transactionId=${encodeURIComponent(transactionId)}`,
        {
          headers: {
            ...BASE_HEADERS,
            Cookie: cookieHeader,
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            ...(formToken ? { "__RequestVerificationToken": formToken } : {}),
          },
        }
      );
      if (jsonRes.ok) {
        const jsonData = await jsonRes.json() as Record<string, unknown>;
        Object.assign(
          detail.rawFields,
          Object.fromEntries(Object.entries(jsonData).map(([k, v]) => [k, String(v)]))
        );
        console.log("[DirectFetch] Augmented with JSON endpoint data");
      }
    } catch (jsonErr) {
      console.warn("[DirectFetch] JSON endpoint fallback failed:", (jsonErr as Error).message);
    }
  }

  return detail;
}
