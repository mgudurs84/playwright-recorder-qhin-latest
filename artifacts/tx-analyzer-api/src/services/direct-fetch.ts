import { parse as parseHtml } from "node-html-parser";
import { loadSession, type SessionData } from "./auth.js";

const PORTAL_URL = process.env.CW_PORTAL_URL ?? "https://integration.commonwellalliance.lkopera.com";

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
}

function buildCookieHeader(cookies: SessionData["cookies"]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function extractCsrfToken(cookies: SessionData["cookies"]): string | null {
  const antiforgeryCookie = cookies.find(
    (c) => c.name.startsWith(".AspNetCore.Antiforgery") || c.name.toLowerCase().includes("antiforgery")
  );
  return antiforgeryCookie?.value ?? null;
}

function extractOids(text: string): string[] {
  const oidRegex = /\d+(?:\.\d+){5,}/g;
  const matches = text.match(oidRegex) ?? [];
  return [...new Set(matches.filter((m) => m.startsWith("2.16.840") || m.startsWith("1.3.6")))];
}

function parseHtmlDetail(html: string, transactionId: string): TransactionDetail {
  const root = parseHtml(html);
  const rawFields: Record<string, string> = {};

  root.querySelectorAll("tr, .field-row, dl dt, dl dd").forEach((el) => {
    const text = el.text.trim();
    if (text) {
      const cells = el.querySelectorAll("td, dd");
      if (cells.length >= 2) {
        rawFields[cells[0].text.trim()] = cells[1].text.trim();
      }
    }
  });

  root.querySelectorAll(".detail-label, .label, th").forEach((label) => {
    const value = label.nextElementSibling;
    if (value) {
      rawFields[label.text.trim()] = value.text.trim();
    }
  });

  const allText = root.text;
  const oids = extractOids(allText);

  const getValue = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const found = Object.entries(rawFields).find(
        ([k]) => k.toLowerCase().includes(key.toLowerCase())
      );
      if (found) return found[1];
    }
    return undefined;
  };

  const oidMatches = allText.match(/(?:requesting|requester)[^:]*oid[^:]*:\s*([0-9.]+)/i);
  const respondOidMatches = allText.match(/(?:responding|responder)[^:]*oid[^:]*:\s*([0-9.]+)/i);

  return {
    transactionId,
    timestamp: getValue("timestamp", "date", "time"),
    transactionType: getValue("type", "transaction type", "request type"),
    status: getValue("status", "result", "outcome"),
    requestingOrg: getValue("requesting org", "requester", "requesting organization"),
    requestingOid: oidMatches?.[1] ?? oids[0],
    respondingOrg: getValue("responding org", "responder", "responding organization"),
    respondingOid: respondOidMatches?.[1] ?? oids[1],
    patientId: getValue("patient id", "patient identifier"),
    memberId: getValue("member id", "member"),
    errorCode: getValue("error code", "fault code"),
    errorMessage: getValue("error message", "fault message", "error detail"),
    responseCode: getValue("response code", "http status"),
    duration: getValue("duration", "elapsed", "time ms"),
    rawFields,
    oids,
    rawHtml: html,
  };
}

export async function fetchTransactionDetail(transactionId: string): Promise<TransactionDetail> {
  const session = loadSession();
  if (!session) {
    throw new Error("No valid session — please log in first");
  }

  const cookieHeader = buildCookieHeader(session.cookies);
  const csrfToken = extractCsrfToken(session.cookies);

  const formData = new FormData();
  formData.append("transactionId", transactionId);

  const url = `${PORTAL_URL}/TransactionLogs/LoadTransactionLogsDetailPartialView`;

  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "text/html, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Origin: PORTAL_URL,
    Referer: `${PORTAL_URL}/TransactionLogs/index`,
  };

  if (csrfToken) {
    headers["__RequestVerificationToken"] = csrfToken;
  }

  console.log(`[DirectFetch] Fetching detail for transaction ${transactionId}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Portal returned HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();

  if (html.includes("login") || html.includes("UserName") || html.length < 50) {
    throw new Error("Session expired — portal returned login page");
  }

  return parseHtmlDetail(html, transactionId);
}
