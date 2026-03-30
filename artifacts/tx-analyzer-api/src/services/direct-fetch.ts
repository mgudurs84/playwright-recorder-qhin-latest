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
  /**
   * Raw broker log lines fetched from a log-lines endpoint.
   * Contains per-org fanout results, document counts, error details.
   */
  rawLogs?: string;
  /** Which endpoint provided the rawLogs */
  logEndpointUsed?: string;
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
    // Normalize whitespace; strip trailing colon from label
    const key = k.replace(/\s+/g, " ").replace(/:$/, "").trim();
    const val = v.replace(/\s+/g, " ").trim();

    // Basic guards
    if (!key || !val) return;
    if (key.length > 80 || val.length === 0) return;

    // First write wins — later strategies may produce noisier data
    if (rawFields[key] !== undefined) return;

    // Reject JavaScript artifacts (leaked <script> text)
    if (/\$\s*\(|function\s*\(|\bvar\b|\bconst\b|\blet\b/.test(val)) return;

    // Reject if key is a UUID / transaction-ID hex string
    if (/^[0-9a-f]{16,}$/i.test(key)) return;

    // Reject short lowercase-only keys — almost always URL query params (dir, page, sort, field)
    if (key.length <= 5 && /^[a-z]+$/.test(key)) return;

    // Reject URI scheme prefixes leaking as keys (urn, oid, http, https, ftp, mailto)
    if (/^(urn|oid|http|https|ftp|mailto)$/i.test(key)) return;

    // Reject values that are themselves labels (end with ":")
    if (val.endsWith(":")) return;

    // Reject values that look like entire section text (contain 3+ "Word: value" pairs)
    const inlinePairs = (val.match(/\b\w[\w ]{1,30}:\s+\S/g) ?? []).length;
    if (inlinePairs > 2) return;

    rawFields[key] = val;
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

  // Strategy 4: <label> + next sibling element.
  // Uses parent.childNodes iteration (more reliable than nextElementSibling in node-html-parser).
  // Handles portal pattern: <div class="row gx-2"><label class="col-4">Field:</label><span class="col-8">Value</span></div>
  root.querySelectorAll("label").forEach((label) => {
    const parent = label.parentNode as typeof root | null;
    if (!parent) return;

    const elemChildren = parent.childNodes.filter(
      (n) => n.nodeType === 1
    ) as typeof root[];

    const idx = elemChildren.findIndex((n) => n === (label as unknown));
    if (idx !== -1 && idx + 1 < elemChildren.length) {
      const sibling = elemChildren[idx + 1];
      // strip icon/button text from sibling (e.g. copy-to-clipboard anchor)
      const val = sibling.querySelector("span, div")?.text ?? sibling.text;
      set(label.text.replace(/:$/, ""), val);
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

  // Strategy 9: Text-level extraction from plain text.
  // Two sub-strategies:
  //   9a: "Label: Value" on the SAME line (inline colon pattern)
  //   9b: Label line ends with ":" and Value is on the NEXT non-empty line
  //       (common in Bootstrap grid layouts where label and value are separate elements)
  const allText = root.text;
  const lines = allText.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 9a: inline "Key: Value"
    const colonIdx = line.indexOf(":");
    if (colonIdx > 2 && colonIdx < 60) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key && val && !key.includes("/") && !key.includes("http") && !/^\d+$/.test(key)) {
        set(key, val);
      }
    }

    // 9b: label-only line ending with ":" — value is on the next non-empty line
    // Common in Bootstrap grid where <label> and <span> render on separate text lines.
    if (line.endsWith(":") && line.length > 2 && line.length <= 80 && !line.includes("/") && !line.includes("http")) {
      const key = line.slice(0, -1).trim();
      // Look ahead up to 3 lines for the value
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nextLine = lines[j];
        if (!nextLine) continue;
        if (nextLine.endsWith(":")) continue; // another label — keep looking
        if (nextLine.length >= 300) break;    // too long — likely bulk text

        // Reject next-line if it looks like a section heading:
        // e.g. "Response Detail", "Request Detail", "Transaction Detail", "Original Claims"
        const isSectionHeading = /^([A-Z][a-z]+\s+){1,3}[A-Z][a-z]+$/.test(nextLine) && nextLine.split(" ").length <= 4;
        if (isSectionHeading) break;

        set(key, nextLine);
        break;
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
  // Also captures ASP.NET hidden/label elements: <strong id="hdnTransactionId">value</strong>
  root.querySelectorAll("[id]").forEach((el) => {
    const id = el.getAttribute("id") ?? "";
    // ASP.NET convention: hdn = hidden field, lbl = label, spn = span display field
    const prefixMatch = id.match(/^(hdn|lbl|spn|span|txt)([A-Z].*)$/);
    if (prefixMatch) {
      const fieldName = prefixMatch[2]
        .replace(/([A-Z][a-z])/g, " $1")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim();
      const value = el.getAttribute("value") ?? el.text.trim();
      if (value) set(fieldName, value);
    }
  });

  // Strategy 13: Bootstrap grid rows — .row with exactly two col-* children
  // Handles: <div class="row"><div class="col-4">Label</div><div class="col-8">Value</div></div>
  root.querySelectorAll(".row, [class*='row']").forEach((row) => {
    // Direct col-* children only (not deeply nested)
    const cols = row.childNodes.filter((n) => {
      if (n.nodeType !== 1) return false;
      const cls = (n as typeof root).getAttribute("class") ?? "";
      return /\bcol\b|col-/.test(cls);
    }) as typeof root[];

    if (cols.length === 2) {
      const label = cols[0].text.replace(/:$/, "").trim();
      const value = cols[1].text.trim();
      if (label && value && label.length <= 80 && !label.includes("\n")) {
        set(label, value);
      }
    }
  });

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

/**
 * Hardcoded candidate endpoints for broker log lines.
 * Based on the known detail endpoint naming pattern: LoadTransactionLogsDetailPartialView
 */
const CANDIDATE_LOG_ENDPOINTS: Array<{ url: string; method: "GET" | "POST" }> = [
  { url: `${PORTAL_URL}/TransactionLogs/LoadTransactionLogLinesPartialView`, method: "POST" },
  { url: `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsLogLinesPartialView`, method: "POST" },
  { url: `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsLogsPartialView`, method: "POST" },
  { url: `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsEventLogsPartialView`, method: "POST" },
  { url: `${PORTAL_URL}/TransactionLogs/GetTransactionLogLines`, method: "GET" },
  { url: `${PORTAL_URL}/TransactionLogs/GetLogLines`, method: "GET" },
  { url: `${PORTAL_URL}/TransactionLogs/GetLogs`, method: "GET" },
  { url: `${PORTAL_URL}/TransactionLogs/LogLines`, method: "GET" },
];

/**
 * Scan the detail HTML's script tags for any AJAX endpoint URLs referencing "log"
 * (e.g., Kendo Grid DataSource read URLs like { url: '/TransactionLogs/GetLogs' }).
 */
function extractLogEndpointsFromHtml(html: string): string[] {
  const found: string[] = [];
  const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, scriptContent] of scriptBlocks) {
    // Match string literals that look like portal paths containing "log"
    const urlLiterals = scriptContent.match(/['"](\/[A-Za-z/]+[Ll]og[A-Za-z/]*)['"]/g) ?? [];
    for (const lit of urlLiterals) {
      const path = lit.replace(/['"]/g, "");
      if (/log/i.test(path) && !/login/i.test(path)) {
        found.push(`${PORTAL_URL}${path}`);
      }
    }
  }
  return [...new Set(found)];
}

/**
 * Returns true if the response text looks like genuine log data
 * (contains timestamp-like patterns and log-level keywords — not a login redirect).
 */
function looksLikeLogData(text: string): boolean {
  if (text.length < 80) return false;
  if (text.includes("UserName") && text.includes("Password") && text.length < 5000) return false;
  // Log lines typically contain dates (MM/DD/YYYY or ISO) and log level words
  const hasDatePattern = /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/.test(text);
  const hasLogLevel = /\b(information|warning|error|debug|trace|critical)\b/i.test(text);
  // OR looks like a JSON array (Kendo DataSource response)
  const isJsonArray = text.trimStart().startsWith("[");
  return (hasDatePattern && hasLogLevel) || isJsonArray;
}

/**
 * Attempt to fetch broker log lines for a transaction.
 * Tries: discovered endpoints → extracted HTML endpoints → hardcoded candidates.
 * Returns null if none succeed.
 */
async function fetchLogLines(
  transactionId: string,
  cookieHeader: string,
  formToken: string | null,
  discoveredLogEndpoints: Array<{ url: string; method: string }>,
  detailHtml?: string
): Promise<{ logs: string; endpointUsed: string } | null> {
  const authHeaders: Record<string, string> = {
    ...BASE_HEADERS,
    Cookie: cookieHeader,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/html, application/json, */*",
    Referer: `${PORTAL_URL}/TransactionLogs/index`,
    ...(formToken ? { "__RequestVerificationToken": formToken } : {}),
  };

  // Build the ordered list of URLs to try
  const toTry: Array<{ url: string; method: "GET" | "POST" }> = [
    ...discoveredLogEndpoints.map((e) => ({ url: e.url, method: e.method as "GET" | "POST" })),
    ...(detailHtml ? extractLogEndpointsFromHtml(detailHtml).map((url) => ({ url, method: "POST" as const })) : []),
    ...CANDIDATE_LOG_ENDPOINTS,
  ];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const deduped = toTry.filter((e) => {
    const key = `${e.method}:${e.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const ep of deduped) {
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

      console.log(`[DirectFetch] Log probe ${ep.method} ${ep.url} → HTTP ${res.status}`);

      if (!res.ok) continue;

      const text = await res.text();
      if (looksLikeLogData(text)) {
        console.log(`[DirectFetch] Got log lines from ${ep.url} (${text.length} chars)`);
        return { logs: text, endpointUsed: ep.url };
      }
      console.log(`[DirectFetch] Response from ${ep.url} doesn't look like log data (${text.length} chars)`);
    } catch (err) {
      console.warn(`[DirectFetch] Log probe failed for ${ep.url}:`, (err as Error).message);
    }
  }

  console.log("[DirectFetch] No log lines endpoint found for this transaction");
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

  // Probe payload endpoints AND log lines endpoints in parallel
  const payloadEndpoints = endpoints?.payloadEndpoints ?? [];
  const logEndpoints = endpoints?.logEndpoints ?? [];

  const [payloadResult, logResult] = await Promise.all([
    payloadEndpoints.length > 0
      ? (console.log(`[DirectFetch] Probing ${payloadEndpoints.length} payload endpoint(s)...`),
         fetchRawPayload(transactionId, cookieHeader, formToken, payloadEndpoints))
      : (console.log("[DirectFetch] No payload endpoints discovered yet"), Promise.resolve(null)),
    (console.log(`[DirectFetch] Probing log lines (${logEndpoints.length} discovered + candidates)...`),
     fetchLogLines(transactionId, cookieHeader, formToken, logEndpoints, detail.rawHtml)),
  ]);

  if (payloadResult) {
    detail.rawPayload = payloadResult.payload;
    detail.payloadEndpointUsed = payloadResult.endpointUsed;
    console.log(`[DirectFetch] Raw payload captured (${payloadResult.payload.length} chars)`);
  } else {
    console.log("[DirectFetch] No payload data returned from any payload endpoint");
  }

  if (logResult) {
    detail.rawLogs = logResult.logs;
    detail.logEndpointUsed = logResult.endpointUsed;
    console.log(`[DirectFetch] Broker log lines captured (${logResult.logs.length} chars) from ${logResult.endpointUsed}`);
  } else {
    console.log("[DirectFetch] No broker log lines found — analysis will use summary fields only");
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
