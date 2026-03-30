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
  /** Raw FHIR / message payload fetched from a discovered payload endpoint */
  rawPayload?: string;
  /** Which endpoint provided the rawPayload */
  payloadEndpointUsed?: string;
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

  const set = (k: string, v: string) => {
    const key = k.replace(/\s+/g, " ").trim();
    const val = v.replace(/\s+/g, " ").trim();
    if (key && val && key.length < 120 && val.length > 0) rawFields[key] = val;
  };

  // Strategy 1: <tr> with 2+ <td> cells
  root.querySelectorAll("tr").forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length >= 2) set(cells[0].text, cells[1].text);
  });

  // Strategy 2: <tr> with <th> label + <td> value
  root.querySelectorAll("tr").forEach((row) => {
    const th = row.querySelector("th");
    const td = row.querySelector("td");
    if (th && td) set(th.text, td.text);
  });

  // Strategy 3: <dl><dt> + <dd>
  root.querySelectorAll("dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") set(dt.text, dd.text);
  });

  // Strategy 4: <label> + next sibling element (Bootstrap / generic forms)
  root.querySelectorAll("label").forEach((label) => {
    const next = label.nextElementSibling;
    if (next) {
      const val = next.getAttribute("value") ?? next.text;
      set(label.text.replace(/:$/, ""), val);
    }
    // Also check parent's next sibling (two-column grid layout)
    const parent = label.parentNode;
    if (parent) {
      const parentNext = (parent as typeof label).nextElementSibling;
      if (parentNext) set(label.text.replace(/:$/, ""), parentNext.text);
    }
  });

  // Strategy 5: Any element with class containing "label", "field-name", "caption", "key"
  const labelClassPattern = /\b(label|field[-_]?name|field[-_]?label|caption|form[-_]?label|col[-_]?form[-_]?label)\b/i;
  root.querySelectorAll("*").forEach((el) => {
    const cls = el.getAttribute("class") ?? "";
    if (labelClassPattern.test(cls)) {
      const next = el.nextElementSibling;
      if (next) set(el.text.replace(/:$/, ""), next.text);
    }
  });

  // Strategy 6: Kendo UI field patterns (k-label, k-form-field)
  root.querySelectorAll(".k-label, .k-form-field label, .k-form-label").forEach((el) => {
    const next = el.nextElementSibling;
    if (next) set(el.text.replace(/:$/, ""), next.text);
  });

  // Strategy 7: data-field attribute on any element — use it as the key
  root.querySelectorAll("[data-field]").forEach((el) => {
    const field = el.getAttribute("data-field");
    if (field) set(field, el.text);
  });

  // Strategy 8: Bootstrap card/list-group items — alternating label/value children
  root.querySelectorAll(".list-group-item, .card-body > .row").forEach((container) => {
    const children = container.childNodes.filter(
      (n) => n.nodeType === 1 && (n as typeof root).text.trim().length > 0
    ) as typeof root[];
    for (let i = 0; i + 1 < children.length; i += 2) {
      set(children[i].text.replace(/:$/, ""), children[i + 1].text);
    }
  });

  // Strategy 9: Text-level regex — extract "Some Label: some value" patterns from plain text
  const allText = root.text;
  const linePatterns = allText.split(/[\n\r]+/);
  for (const line of linePatterns) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 2 && colonIdx < 60) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key && val && !key.includes("/") && !key.includes("http") && !/^\d+$/.test(key)) {
        set(key, val);
      }
    }
  }

  // Strategy 10: JSON embedded in <script> tags — portals often bootstrap data this way
  root.querySelectorAll("script").forEach((script) => {
    const src = script.text;
    // Find any JSON object literals in the script
    const jsonMatches = src.matchAll(/\{[^{}]{20,}["'][a-zA-Z][^"']*["']\s*:\s*["'][^"']+["'][^{}]*\}/g);
    for (const m of jsonMatches) {
      try {
        const obj = JSON.parse(m[0]) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            set(k, String(v));
          }
        }
      } catch {
        // not valid JSON — try key-value regex instead
        const kvMatches = src.matchAll(/["']([a-zA-Z][a-zA-Z0-9_ ]{1,40})["']\s*:\s*["']([^"']{1,200})["']/g);
        for (const kv of kvMatches) {
          set(kv[1], kv[2]);
        }
      }
    }
    // Also match simple var/const assignments: var fieldName = "value"
    const assignMatches = src.matchAll(/(?:var|let|const)\s+([a-zA-Z][a-zA-Z0-9_]{1,40})\s*=\s*["']([^"']{1,200})["']/g);
    for (const a of assignMatches) {
      set(a[1], a[2]);
    }
  });

  // Strategy 11: Adjacent sibling div/span pairs — label+value without colons
  // Handles Bootstrap rows like: <div class="row"><div class="col">Label</div><div class="col">Value</div></div>
  root.querySelectorAll("div, li, section").forEach((container) => {
    const children = container.childNodes
      .filter((n) => {
        if (n.nodeType !== 1) return false;
        const el = n as typeof root;
        const tag = el.tagName?.toLowerCase() ?? "";
        return ["div", "span", "p", "td", "th"].includes(tag) && el.text.trim().length > 0;
      }) as typeof root[];

    // Two-child pattern: [label, value]
    if (children.length === 2) {
      const label = children[0].text.replace(/:$/, "").trim();
      const value = children[1].text.trim();
      if (label.length > 0 && label.length <= 60 && value.length > 0 && !label.includes("\n")) {
        set(label, value);
      }
    }

    // Even/odd pattern: label at even index, value at odd index
    if (children.length >= 4 && children.length % 2 === 0) {
      for (let i = 0; i + 1 < children.length; i += 2) {
        const label = children[i].text.replace(/:$/, "").trim();
        const value = children[i + 1].text.trim();
        if (label.length > 0 && label.length <= 60 && value.length > 0 && !label.includes("\n")) {
          set(label, value);
        }
      }
    }
  });

  // Strategy 12: <strong> or <b> as inline label with following text node or sibling
  root.querySelectorAll("strong, b").forEach((el) => {
    const labelText = el.text.replace(/:$/, "").trim();
    if (!labelText || labelText.length > 60) return;

    // Check next element sibling
    const next = el.nextElementSibling;
    if (next && next.text.trim()) {
      set(labelText, next.text.trim());
      return;
    }

    // Check next text node in parent
    const parent = el.parentNode as typeof root | null;
    if (parent) {
      const parentText = parent.text.replace(el.text, "").replace(/:/, "").trim();
      if (parentText.length > 0 && parentText.length < 300) {
        set(labelText, parentText);
      }
    }
  });

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

/**
 * Probe discovered payload endpoints to retrieve the raw FHIR / message content
 * for a transaction. Tries GET (query param) then POST (form body) for each endpoint.
 * Returns the first non-empty, non-login-page response.
 */
async function fetchRawPayload(
  transactionId: string,
  cookieHeader: string,
  formToken: string | null,
  payloadEndpoints: Array<{ url: string; method: string }>
): Promise<{ payload: string; endpointUsed: string } | null> {
  const authHeaders: Record<string, string> = {
    ...BASE_HEADERS,
    Cookie: cookieHeader,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, application/xml, text/xml, text/html, */*",
    ...(formToken ? { "__RequestVerificationToken": formToken } : {}),
  };

  for (const ep of payloadEndpoints) {
    try {
      let res: Response;

      if (ep.method === "POST") {
        const body = new URLSearchParams({ transactionId });
        if (formToken) body.set("__RequestVerificationToken", formToken);
        res = await fetch(ep.url, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } else {
        const url = `${ep.url}${ep.url.includes("?") ? "&" : "?"}transactionId=${encodeURIComponent(transactionId)}`;
        res = await fetch(url, { method: "GET", headers: authHeaders });
      }

      if (!res.ok) {
        console.log(`[DirectFetch] Payload endpoint ${ep.url} → HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();
      // Skip login redirect pages
      if (text.includes("UserName") && text.includes("Password") && text.length < 5000) continue;
      // Skip empty or very short responses
      if (text.trim().length < 50) continue;

      console.log(`[DirectFetch] Got payload from ${ep.url} (${text.length} chars)`);
      return { payload: text, endpointUsed: ep.url };
    } catch (err) {
      console.warn(`[DirectFetch] Payload probe failed for ${ep.url}:`, (err as Error).message);
    }
  }
  return null;
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

  // Only accept a discovered URL if it genuinely points to a detail endpoint.
  // "List" and "Index" endpoints must never be used here.
  const isDetailEndpoint = (url: string): boolean => {
    const u = url.toLowerCase();
    return (
      u.includes("detail") &&
      !u.includes("list") &&
      !u.includes("index")
    );
  };

  const discoveredDetail =
    endpoints?.detailHtml && isDetailEndpoint(endpoints.detailHtml)
      ? endpoints.detailHtml
      : endpoints?.all.find((e) => isDetailEndpoint(e.url))?.url;

  const detailUrl = discoveredDetail ?? FALLBACK_DETAIL_URL;

  console.log(`[DirectFetch] Fetching detail for ${transactionId} via ${detailUrl}`);

  const html = await postDetail(detailUrl, transactionId, cookieHeader, formToken);

  if (html.includes("UserName") && html.includes("Password") && html.length < 5000) {
    throw new Error("Session expired — portal returned login page");
  }

  const detail: TransactionDetail = {
    ...parseHtmlDetail(html, transactionId),
    endpointUsed: detailUrl,
  };

  // Probe discovered payload endpoints (raw FHIR / message body)
  const payloadEndpoints = endpoints?.payloadEndpoints ?? [];
  if (payloadEndpoints.length > 0) {
    console.log(`[DirectFetch] Probing ${payloadEndpoints.length} payload endpoint(s)...`);
    const payloadResult = await fetchRawPayload(
      transactionId,
      cookieHeader,
      formToken,
      payloadEndpoints
    );
    if (payloadResult) {
      detail.rawPayload = payloadResult.payload;
      detail.payloadEndpointUsed = payloadResult.endpointUsed;
      console.log(`[DirectFetch] Raw payload captured (${payloadResult.payload.length} chars)`);
    } else {
      console.log("[DirectFetch] No payload data returned from any payload endpoint");
    }
  } else {
    console.log("[DirectFetch] No payload endpoints discovered yet — re-login to trigger discovery");
  }

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
