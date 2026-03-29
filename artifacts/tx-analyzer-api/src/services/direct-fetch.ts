import { parse as parseHtml } from "node-html-parser";
import { loadSession, loadEndpoints, type SessionData } from "./auth.js";

const PORTAL_URL = process.env.CW_PORTAL_URL ?? "https://integration.commonwellalliance.lkopera.com";

const FALLBACK_DETAIL_URL = `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsDetailPartialView`;

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

function extractCsrfToken(cookies: SessionData["cookies"]): string | null {
  const antiforgeryCookie = cookies.find(
    (c) =>
      c.name.startsWith(".AspNetCore.Antiforgery") ||
      c.name.toLowerCase().includes("antiforgery")
  );
  return antiforgeryCookie?.value ?? null;
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

async function postMultipart(
  url: string,
  transactionId: string,
  cookieHeader: string,
  csrfToken: string | null
): Promise<string> {
  const formData = new FormData();
  formData.append("transactionId", transactionId);

  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "text/html, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Origin: PORTAL_URL,
    Referer: `${PORTAL_URL}/TransactionLogs/index`,
  };

  if (csrfToken) {
    headers["__RequestVerificationToken"] = csrfToken;
  }

  const response = await fetch(url, { method: "POST", headers, body: formData });
  if (!response.ok) {
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
  const csrfToken = extractCsrfToken(session.cookies);

  const endpoints = loadEndpoints();
  const detailUrl =
    endpoints?.detailHtml ??
    endpoints?.all.find(
      (e) => e.url.includes("Detail") || e.url.includes("LoadTransaction")
    )?.url ??
    FALLBACK_DETAIL_URL;

  console.log(`[DirectFetch] Fetching detail for ${transactionId} via ${detailUrl}`);

  const html = await postMultipart(detailUrl, transactionId, cookieHeader, csrfToken);

  if (html.includes("UserName") && html.includes("Password") && html.length < 5000) {
    throw new Error("Session expired — portal returned login page");
  }

  const detail: TransactionDetail = { ...parseHtmlDetail(html, transactionId), endpointUsed: detailUrl };

  if (endpoints?.detailJson && endpoints.detailJson !== detailUrl) {
    try {
      const jsonHeaders: Record<string, string> = {
        Cookie: cookieHeader,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      };
      if (csrfToken) jsonHeaders["__RequestVerificationToken"] = csrfToken;

      const jsonRes = await fetch(`${endpoints.detailJson}?transactionId=${encodeURIComponent(transactionId)}`, {
        headers: jsonHeaders,
      });
      if (jsonRes.ok) {
        const jsonData = await jsonRes.json() as Record<string, unknown>;
        Object.assign(detail.rawFields, Object.fromEntries(
          Object.entries(jsonData).map(([k, v]) => [k, String(v)])
        ));
        console.log(`[DirectFetch] Augmented with JSON endpoint data`);
      }
    } catch (jsonErr) {
      console.warn("[DirectFetch] JSON endpoint fallback failed:", (jsonErr as Error).message);
    }
  }

  return detail;
}
