import { type Express, type Request, type Response } from "express";
import { generateText } from "ai";
import { fetchTransactionDetail, type TransactionDetail } from "../services/direct-fetch.js";
import { fetchTransactionDetailPlaywright } from "../services/playwright-fetch.js";
import { resolveOidsWithLookup } from "../services/oid-resolver.js";
import { takeScreenshot } from "../services/auth.js";
import { createVertexModel } from "../lib/vertex.js";

export interface AnalysisResult {
  transactionId: string;
  detail: TransactionDetail;
  organizations: Array<{ oid: string; name: string }>;
  ai: {
    summary: string;
    rootCause: string;
    dataFlow: string;
    transactionCategory: string;
    fanoutOrgCount: string;
    documentsFound: string;
    durationMs: string;
    organizations: Array<{ oid: string; name: string; role: string }>;
    l1Actions: string[];
    l2Actions: string[];
    severity: "low" | "medium" | "high" | "critical";
    resolution: string;
  };
  screenshotUrl?: string;
  error?: string;
}

/**
 * Strip HTML tags and collapse whitespace for a compact text representation.
 * Used to give Gemini a readable version of the portal HTML.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|section|article)>/gi, "\n")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<th[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#[0-9]+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(
  detail: TransactionDetail,
  orgs: Array<{ oid: string; name: string }>
): string {
  const orgMap = Object.fromEntries(orgs.map((o) => [o.oid, o.name]));

  // Structured fields extracted by our parser (may be sparse or empty)
  const structuredFields = Object.entries(detail.rawFields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  // Plain-text version of the raw HTML — give Gemini the source of truth
  const rawText = detail.rawHtml
    ? htmlToText(detail.rawHtml).slice(0, 12000)  // cap at ~12k chars
    : null;

  // Raw FHIR / message payload from a discovered payload endpoint (may be XML or JSON)
  const rawPayloadText = detail.rawPayload
    ? detail.rawPayload.slice(0, 16000)  // cap at ~16k chars for FHIR payloads
    : null;

  // Broker log lines fetched from the portal log-lines endpoint
  // These are the most authoritative source for fanout details, per-org results, and errors
  const rawLogsText = detail.rawLogs
    ? detail.rawLogs.slice(0, 20000)  // cap at ~20k chars
    : null;

  const hasStructured = structuredFields.trim().length > 0;
  const hasRaw = rawText && rawText.trim().length > 0;

  // Calculate duration from start/end timestamps if available
  const startTime = detail.rawFields["Start Time"] ?? detail.timestamp;
  const endTime = detail.rawFields["End Time"];
  let durationHint = "unknown";
  if (startTime && endTime) {
    try {
      const diff = new Date(endTime).getTime() - new Date(startTime).getTime();
      if (!isNaN(diff) && diff >= 0) durationHint = `${diff}ms`;
    } catch { /* ignore */ }
  }

  // Infer transaction category from type and path
  const txType = detail.rawFields["Transaction Type"] ?? detail.transactionType ?? "";
  const path = detail.rawFields["Path"] ?? "";
  const queryString = detail.rawFields["Query String"] ?? "";
  let categoryHint = "unknown";
  if (/binary/i.test(txType) || /binary/i.test(path)) categoryHint = "Document Retrieve (Binary)";
  else if (/document.*ref/i.test(txType) || /DocumentReference/i.test(path)) categoryHint = "Document Query";
  else if (/patient.*search|patientsearch/i.test(txType) || /\/Patient\b/i.test(path)) categoryHint = "Patient Search";
  else if (/patient.*match/i.test(txType)) categoryHint = "Patient Match";
  else if (/document.*query|docquery/i.test(txType)) categoryHint = "Document Query";

  return `You are a CommonWell Health Alliance (CW) L1/L2 support analyst.
CVS Health operates as the CommonWell broker/intermediary that fans out requests to member organizations.

${
  rawLogsText
    ? `--- BROKER LOG LINES (MOST AUTHORITATIVE — use these for ALL fanout, per-org results, document counts, and errors) ---
${rawLogsText}
--- END BROKER LOG LINES ---

`
    : "NOTE: Broker log lines were NOT available for this transaction. Fanout details, per-org results, and document counts cannot be determined from the summary view alone. Be explicit about this limitation.\n\n"
}${
  rawPayloadText
    ? `--- RAW FHIR / MESSAGE PAYLOAD ---
${rawPayloadText}
--- END PAYLOAD ---

`
    : ""
}${
  hasRaw
    ? `--- RAW PORTAL PAGE TEXT ---
${rawText}
--- END PORTAL PAGE TEXT ---

`
    : ""
}EXTRACTED FIELDS:
TRANSACTION ID: ${detail.transactionId}
TRANSACTION TYPE: ${txType}
INFERRED CATEGORY: ${categoryHint}
STATUS: ${detail.rawFields["Transaction Status"] ?? detail.status ?? "unknown"}
HTTP STATUS CODE: ${detail.rawFields["Status Code"] ?? detail.responseCode ?? "unknown"}
START TIME: ${startTime ?? "unknown"}
END TIME: ${endTime ?? "unknown"}
CALCULATED DURATION: ${durationHint}
HTTP METHOD: ${detail.rawFields["Http Method"] ?? "unknown"}
PATH: ${path}
QUERY STRING: ${queryString}
INITIATING ORG ID: ${detail.rawFields["Initiating Org ID"] ?? detail.requestingOid ?? "unknown"}
INITIATING ORG NAME: ${detail.rawFields["Initiating Org Name"] ?? detail.requestingOrg ?? "unknown"}
MEMBER: ${detail.rawFields["Member Name"] ?? "unknown"}
ERROR CODE: ${detail.errorCode ?? "none"}
ERROR MESSAGE: ${detail.errorMessage ?? "none"}

${hasStructured ? `ALL EXTRACTED FIELDS:\n${structuredFields}\n` : ""}
OID-TO-ORG RESOLUTION:
${orgs.map((o) => `  ${o.oid} → ${o.name}`).join("\n") || "  (no OIDs resolved)"}

INSTRUCTIONS — answer every field below using the BROKER LOG LINES as the primary source when available:
1. TRANSACTION CATEGORY: Classify as one of: Document Query, Document Retrieve, Patient Search, Patient Match, Document Submission, or Other.
2. BROKERING CHAIN: Identify the full chain from log lines. Show: Initiating Org → CVS Health (broker) → each target org with its result (success/error/no match). If log lines are unavailable, say so explicitly.
3. FANOUT ORG COUNT: If broker log lines are available above, count the unique orgs and state the number. If NOT available, use "paste broker logs". Do NOT write a sentence — this field is a SHORT label for a stats tile (max 8 words).
4. DOCUMENTS FOUND: If broker log lines are available, state the count. If NOT available, use "paste broker logs". Do NOT write a sentence — this is a SHORT label for a stats tile (max 8 words).
5. DURATION: Calculate from Start Time and End Time. Long durations (>1s) indicate broker fanout.
6. ORGANIZATIONS: List every org with name (from OID resolution or log lines), OID, role, and outcome. Put per-org detail in the summary and l1Actions.
7. L1/L2 ACTIONS: Be highly specific. If broker log lines were not available, the first L1 action MUST be "Use the 'Paste Log Text' tab to paste the broker logs for this transaction — the portal audit log does not contain per-org fanout detail." Then list any errors visible from the summary fields.

CRITICAL FIELD LENGTH RULES — the stats bar tiles show these 4 fields directly:
- "transactionCategory": max 4 words
- "fanoutOrgCount": max 8 words, e.g. "104 organizations", "paste broker logs", "1 (direct)"
- "documentsFound": max 8 words, e.g. "8 documents retrieved", "0", "paste broker logs"
- "durationMs": max 10 chars, e.g. "4163ms", "unknown"
Never put sentences or explanations in these four fields. Explanations go in summary, l1Actions, l2Actions.

Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description covering: what type of operation, who requested it, which broker handled it, how many orgs were involved (if known from log lines), how many documents found (if applicable), and the outcome. If broker log lines were unavailable, note that the portal audit log only contains gateway-level entries and that broker fanout details require pasting the broker logs via the Paste Log Text tab.",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other",
  "fanoutOrgCount": "SHORT label only — e.g. '104 organizations' or '1 (direct)' or 'paste broker logs'",
  "documentsFound": "SHORT label only — e.g. '8 retrieved (29 fanout)' or '0' or 'paste broker logs'",
  "durationMs": "e.g. '3901ms' or 'unknown'",
  "dataFlow": "Step-by-step chain: 'Org A (requester) → CVS Health (broker) → 104 member orgs (fanout)'",
  "rootCause": "Root cause of any errors, or 'No errors detected'",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name", "role": "requester|responder|intermediary|broker"}
  ],
  "l1Actions": ["Specific action L1 should take — first action must be 'Use the Paste Log Text tab to paste broker logs' when broker log lines are unavailable"],
  "l2Actions": ["Engineering escalation action"],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution or 'No action required'"
}`;
}

export async function analyzeTransaction(
  transactionId: string,
  captureScreenshot = false,
  usePlaywright = false
): Promise<AnalysisResult> {
  console.log(`[Analyze] Mode: ${usePlaywright ? "Playwright" : "Direct API"} for ${transactionId}`);

  const [detail, screenshotUrl] = await Promise.all([
    usePlaywright
      ? fetchTransactionDetailPlaywright(transactionId)
      : fetchTransactionDetail(transactionId),
    captureScreenshot ? takeScreenshot(transactionId) : Promise.resolve(undefined),
  ]);

  // Log raw HTML preview to help diagnose parse failures
  if (detail.rawHtml) {
    const preview = detail.rawHtml.slice(0, 300).replace(/\s+/g, " ");
    console.log(`[Analyze] Raw HTML preview (300 chars): ${preview}`);
    console.log(`[Analyze] Extracted rawFields count: ${Object.keys(detail.rawFields).length}`);
  }

  const orgs = await resolveOidsWithLookup(detail.oids);

  let ai: AnalysisResult["ai"];
  try {
    const model = createVertexModel();
    const prompt = buildPrompt(detail, orgs);

    const { text } = await generateText({ model, prompt });

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as AnalysisResult["ai"];

    // Enforce short stats-tile values: if Gemini returned a sentence, truncate to first clause
    const trimStat = (val: string | undefined, fallback: string, maxChars = 50): string => {
      const s = (val ?? fallback).trim();
      // If it looks like a sentence (contains period or long phrase), truncate at first separator
      if (s.length <= maxChars) return s;
      const cut = s.search(/[.,(]/);
      return cut > 0 ? s.slice(0, cut).trim() : s.slice(0, maxChars).trim();
    };

    ai = {
      summary: parsed.summary ?? "No summary available",
      dataFlow: parsed.dataFlow ?? "",
      transactionCategory: trimStat(parsed.transactionCategory, "Unknown", 30),
      fanoutOrgCount: trimStat(parsed.fanoutOrgCount, "paste broker logs"),
      documentsFound: trimStat(parsed.documentsFound, "paste broker logs"),
      durationMs: trimStat(parsed.durationMs, "unknown", 20),
      rootCause: parsed.rootCause ?? "Unable to determine",
      organizations: Array.isArray(parsed.organizations)
        ? parsed.organizations
        : orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: Array.isArray(parsed.l1Actions) ? parsed.l1Actions : [],
      l2Actions: Array.isArray(parsed.l2Actions) ? parsed.l2Actions : [],
      severity: (
        ["low", "medium", "high", "critical"].includes(parsed.severity)
          ? parsed.severity
          : "medium"
      ) as AnalysisResult["ai"]["severity"],
      resolution: parsed.resolution ?? "No action required",
    };
  } catch (aiErr) {
    console.warn(
      `[Analyze] AI analysis failed for ${transactionId}:`,
      (aiErr as Error).message
    );
    ai = {
      summary: `Transaction ${transactionId} — status: ${detail.status ?? "unknown"}`,
      dataFlow: "",
      transactionCategory: "Unknown",
      fanoutOrgCount: "unknown",
      documentsFound: "unknown",
      durationMs: "unknown",
      rootCause: detail.errorMessage ?? "Unable to determine (AI unavailable)",
      organizations: orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: ["Review transaction details manually"],
      l2Actions: ["Escalate if error persists"],
      severity: "medium",
      resolution: "Manual investigation required",
    };
  }

  const result: AnalysisResult = { transactionId, detail, organizations: orgs, ai };
  if (screenshotUrl) result.screenshotUrl = screenshotUrl;
  return result;
}

// ---------------------------------------------------------------------------
// Log-text analysis
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
}

function parseLogLines(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Format: MM/DD/YYYY HH:MM:SS.mmm\tLevel\tComponent\tMessage
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+)\t(\w+)\t([^\t]+)\t(.+)$/);
    if (m) {
      entries.push({ timestamp: m[1], level: m[2], message: m[4], component: m[3] });
    } else {
      // Append continuation lines to the last entry if they don't match the pattern
      if (entries.length) entries[entries.length - 1].message += " " + line;
    }
  }
  return entries;
}

/**
 * Pre-compute key statistics from log lines server-side so that Gemini
 * cannot hallucinate counts even when the log contains hundreds of identical error lines.
 */
function computeLogStats(entries: LogEntry[]): {
  finalDocumentsRetrieved: number | null;
  finalDocsInFanout: number | null;
  fanoutOrgCount: number | null;
  patientSearchFanoutCount: number | null;
  patientsFound: number | null;
  perOrgDocResults: Array<{ org: string; docsFound: number; status: string; error?: string }>;
  perOrgPatientResults: Array<{ org: string; patientsFound: number; status: string; error?: string }>;
  errorTypes: Record<string, number>;
  overallStatus: string | null;
  durationMs: number | null;
} {
  let finalDocumentsRetrieved: number | null = null;
  let finalDocsInFanout: number | null = null;
  let fanoutOrgCount: number | null = null;
  let patientSearchFanoutCount: number | null = null;
  let patientsFound: number | null = null;
  let overallStatus: string | null = null;
  const perOrgDocResults: Array<{ org: string; docsFound: number; status: string; error?: string }> = [];
  const perOrgPatientResults: Array<{ org: string; patientsFound: number; status: string; error?: string }> = [];
  const errorTypes: Record<string, number> = {};

  for (const entry of entries) {
    const msg = entry.message;

    // "Completed brokered document search with X documents retrieved" — the authoritative deduplicated total
    const finalDocMatch = msg.match(/Completed brokered document search with (\d+) documents? retrieved/i);
    if (finalDocMatch) finalDocumentsRetrieved = parseInt(finalDocMatch[1], 10);

    // "Completed fanout document search request with status 'X', 'Y' documents, Z errors"
    const fanoutDocMatch = msg.match(/Completed fanout document search.*?'(\d+)' documents.*?(\d+) errors/i);
    if (fanoutDocMatch) finalDocsInFanout = parseInt(fanoutDocMatch[1], 10);

    // "Retrieved N organizations for fanout"
    const fanoutCountMatch = msg.match(/Retrieved (\d+) organizations for fanout/i);
    if (fanoutCountMatch) fanoutOrgCount = parseInt(fanoutCountMatch[1], 10);

    // "Completed fanout patient search. In N organizations X patients were found"
    const patSearchMatch = msg.match(/Completed fanout patient search.*In (\d+) organizations (\d+) patients? were found/i);
    if (patSearchMatch) {
      patientSearchFanoutCount = parseInt(patSearchMatch[1], 10);
      patientsFound = parseInt(patSearchMatch[2], 10);
    }

    // Per-org: document search request complete
    const docCompleteMatch = msg.match(/document search request complete to target organization "([^"]+)".*Status: (\w+).*documents found: (\d+).*error details: "([^"]*)"/i);
    if (docCompleteMatch) {
      perOrgDocResults.push({
        org: docCompleteMatch[1],
        status: docCompleteMatch[2],
        docsFound: parseInt(docCompleteMatch[3], 10),
        error: docCompleteMatch[4] || undefined,
      });
    }

    // Per-org: patient search request complete
    const patCompleteMatch = msg.match(/patient search request complete to target organization "([^"]+)".*Status: (\w+).*patients found: (\d+).*error details: "([^"]*)"/i);
    if (patCompleteMatch) {
      perOrgPatientResults.push({
        org: patCompleteMatch[1],
        status: patCompleteMatch[2],
        patientsFound: parseInt(patCompleteMatch[3], 10),
        error: patCompleteMatch[4] || undefined,
      });
    }

    // Track distinct error types from both "failure" lines and "error details" fields
    const errorTypeMatch = msg.match(/\[([A-Za-z]+(?:Error|Failure|Fault|Timeout|Organization|Gateway|Validation)[^\]]*)\]/i);
    if (errorTypeMatch) {
      const type = errorTypeMatch[1].trim();
      errorTypes[type] = (errorTypes[type] ?? 0) + 1;
    }

    // Overall status line
    const statusMatch = msg.match(/Response completed|PartialSuccess|Successful|Failed/i);
    if (statusMatch && !overallStatus) overallStatus = statusMatch[0];
  }

  // Duration: first ts to last ts
  let durationMs: number | null = null;
  if (entries.length >= 2) {
    const parseTs = (ts: string) => {
      const m = ts.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (!m) return null;
      return new Date(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`).getTime();
    };
    const t0 = parseTs(entries[0].timestamp);
    const t1 = parseTs(entries[entries.length - 1].timestamp);
    if (t0 && t1) durationMs = t1 - t0;
  }

  return {
    finalDocumentsRetrieved,
    finalDocsInFanout,
    fanoutOrgCount,
    patientSearchFanoutCount,
    patientsFound,
    perOrgDocResults,
    perOrgPatientResults,
    errorTypes,
    overallStatus,
    durationMs,
  };
}

function buildLogPrompt(transactionId: string, logText: string, orgs: Array<{ oid: string; name: string }>): string {
  const orgLines = orgs.map((o) => `  ${o.oid} → ${o.name}`).join("\n") || "  (none resolved)";

  const entries = parseLogLines(logText);
  const stats = computeLogStats(entries);

  // Build the pre-computed facts block — Gemini MUST use these numbers, not re-derive them
  const perOrgDocSummary = stats.perOrgDocResults.length
    ? stats.perOrgDocResults
        .map((r) => `    ${r.org}: ${r.docsFound} doc(s) — ${r.status}${r.error ? ` — ${r.error}` : ""}`)
        .join("\n")
    : "    (none recorded)";

  const perOrgPatSummary = stats.perOrgPatientResults.length
    ? stats.perOrgPatientResults
        .map((r) => `    ${r.org}: ${r.patientsFound} patient(s) — ${r.status}${r.error ? ` — ${r.error}` : ""}`)
        .join("\n")
    : "    (none recorded)";

  const errorTypeSummary = Object.entries(stats.errorTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `    [${type}]: ${count} occurrence(s)`)
    .join("\n") || "    (none)";

  // Collect distinct error messages from non-empty Reason fields
  const uniqueErrors = [
    ...new Set(
      entries
        .filter((e) => e.level === "Error" || e.level === "Warning")
        .map((e) => e.message)
        .filter((m) => {
          const r = m.match(/Reason: "([^"]+)"/);
          return r && r[1].trim().length > 0;
        })
        .slice(0, 20)
    ),
  ];
  const distinctErrorMessages = uniqueErrors.length
    ? uniqueErrors.map((m) => `    ${m}`).join("\n")
    : "    (see error types above)";

  const capText = logText.length > 18000 ? logText.slice(0, 18000) + "\n...[truncated]" : logText;

  return `You are a CommonWell Health Alliance (CW) L1/L2 support analyst.

IMPORTANT: The following COMPUTED STATISTICS were extracted server-side directly from the log lines.
These numbers are authoritative. Do NOT re-count or re-derive them — use them exactly as stated.

=== COMPUTED FACTS (DO NOT DEVIATE FROM THESE NUMBERS) ===
TRANSACTION ID: ${transactionId}
FINAL DOCUMENTS RETRIEVED (deduplicated, authoritative): ${stats.finalDocumentsRetrieved ?? "not found in log"}
TOTAL DOCUMENTS IN FANOUT (before dedup): ${stats.finalDocsInFanout ?? "not found in log"}
PATIENT SEARCH FANOUT ORG COUNT: ${stats.patientSearchFanoutCount ?? "not found in log"}
PATIENTS FOUND (patient search): ${stats.patientsFound ?? "not found in log"}
DOCUMENT SEARCH FANOUT ORG COUNT (from MPI): ${stats.fanoutOrgCount ?? "not found in log"}
TOTAL DURATION: ${stats.durationMs != null ? `${stats.durationMs}ms` : "unknown"}
OVERALL STATUS: ${stats.overallStatus ?? "unknown"}

PER-ORG DOCUMENT SEARCH RESULTS (from log):
${perOrgDocSummary}

PER-ORG PATIENT SEARCH RESULTS (from log):
${perOrgPatSummary}

ERROR TYPES (count):
${errorTypeSummary}

DISTINCT ERROR MESSAGES (up to 20, non-empty reasons only):
${distinctErrorMessages}
=== END COMPUTED FACTS ===

--- FULL LOG (for context only — numbers above are authoritative) ---
${capText}
--- END LOG ---

OID RESOLUTION:
${orgLines}

INSTRUCTIONS — use the COMPUTED FACTS above for all counts and numbers:
1. State the exact document count from "FINAL DOCUMENTS RETRIEVED" above — never guess from individual log lines.
2. Identify EVERY organization involved: requester, broker, fanout targets, which ones succeeded, which failed and why.
3. Classify every distinct error type (timeout, inactive org, SSL, registry error, audience validation, unknown gateway, etc.).
4. Determine overall transaction status using the computed facts.
5. Describe the end-to-end brokering chain with exact counts.
6. Provide specific L1/L2 support actions — name each org with errors by OID, state the error type and recommended fix.
7. Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description: operation type, requesting org, broker, patient search fanout (N orgs, X patients found), document search fanout (N orgs, Y docs total, Z deduplicated), overall outcome",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other",
  "fanoutOrgCount": "use COMPUTED FACTS: e.g. '14 orgs (patient search) → 104 orgs (document fanout)'",
  "documentsFound": "use COMPUTED FACTS: '8 documents retrieved (29 found in fanout before dedup)' — never guess",
  "durationMs": "from COMPUTED FACTS duration",
  "dataFlow": "Requester → CVS Health (broker) → N orgs patient search (X patients) → M orgs doc search (Y docs fanout, Z deduplicated)",
  "rootCause": "Primary root cause grouping the most impactful errors",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name", "role": "requester|responder|intermediary|broker"}
  ],
  "l1Actions": ["Specific L1 action naming org OID and error type"],
  "l2Actions": ["Engineering escalation action naming org OID and specific fix needed"],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution"
}`;
}

async function analyzeLogText(
  logText: string,
  transactionId: string
): Promise<AnalysisResult> {
  const oidRegex = /\d+(?:\.\d+){5,}/g;
  const rawOids = [...new Set((logText.match(oidRegex) ?? []).filter((o) => o.startsWith("2.16.840") || o.startsWith("1.3.6")))];
  const orgs = await resolveOidsWithLookup(rawOids);

  // Build a synthetic TransactionDetail so the UI renders consistently
  const entries = parseLogLines(logText);
  const stats = computeLogStats(entries);
  const firstTs = entries[0]?.timestamp ?? "";
  const lastTs = entries[entries.length - 1]?.timestamp ?? "";
  const errors = entries.filter((e) => e.level === "Error");
  const hasErrors = errors.length > 0;

  // Try to detect transaction type from log messages
  const allMessages = logText.toLowerCase();
  let txType = "Unknown";
  if (allMessages.includes("document retrieve") || allMessages.includes("getbinary")) txType = "DocumentRetrieve";
  else if (allMessages.includes("document search") || allMessages.includes("document query")) txType = "DocumentQuery";
  else if (allMessages.includes("patient search") || allMessages.includes("patient link")) txType = "PatientSearch";
  else if (allMessages.includes("patient match")) txType = "PatientMatch";

  // Determine status from computed stats
  const overallStatus =
    stats.overallStatus === "Successful" ? "Successful"
    : stats.finalDocumentsRetrieved != null && stats.finalDocumentsRetrieved > 0 ? "Partial Success"
    : hasErrors ? "Partial/Error"
    : "Successful";

  const syntheticDetail: TransactionDetail = {
    transactionId,
    timestamp: firstTs,
    transactionType: txType,
    status: overallStatus,
    rawFields: {
      "Transaction ID": transactionId,
      "Start Time": firstTs,
      "End Time": lastTs,
      "Transaction Type": txType,
      "Error Count": String(errors.length),
      "Total Log Lines": String(entries.length),
      ...(stats.finalDocumentsRetrieved != null
        ? { "Documents Retrieved": String(stats.finalDocumentsRetrieved) }
        : {}),
      ...(stats.patientsFound != null
        ? { "Patients Found": String(stats.patientsFound) }
        : {}),
      ...(stats.fanoutOrgCount != null
        ? { "Fanout Org Count": String(stats.fanoutOrgCount) }
        : {}),
    },
    oids: rawOids,
  };

  let ai: AnalysisResult["ai"];
  try {
    const model = createVertexModel();
    const prompt = buildLogPrompt(transactionId, logText, orgs);
    const { text } = await generateText({ model, prompt });
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as AnalysisResult["ai"];

    // Build authoritative numeric strings from server-computed stats
    // These OVERRIDE whatever Gemini returned — they are computed directly from the log
    const computedDocsFound = stats.finalDocumentsRetrieved != null
      ? stats.finalDocsInFanout != null && stats.finalDocsInFanout !== stats.finalDocumentsRetrieved
        ? `${stats.finalDocumentsRetrieved} documents retrieved (${stats.finalDocsInFanout} in fanout before dedup)`
        : `${stats.finalDocumentsRetrieved} documents retrieved`
      : (parsed.documentsFound ?? "unknown");

    const computedFanout = stats.patientSearchFanoutCount != null || stats.fanoutOrgCount != null
      ? [
          stats.patientSearchFanoutCount != null
            ? `${stats.patientSearchFanoutCount} orgs (patient search, ${stats.patientsFound ?? "?"} patients found)`
            : null,
          stats.fanoutOrgCount != null
            ? `${stats.fanoutOrgCount} orgs (document fanout)`
            : null,
        ].filter(Boolean).join(" → ")
      : (parsed.fanoutOrgCount ?? "unknown");

    const computedDuration = stats.durationMs != null
      ? `${stats.durationMs}ms`
      : (parsed.durationMs ?? "unknown");

    ai = {
      summary: parsed.summary ?? "No summary available",
      dataFlow: parsed.dataFlow ?? "",
      transactionCategory: parsed.transactionCategory ?? txType,
      fanoutOrgCount: computedFanout,
      documentsFound: computedDocsFound,
      durationMs: computedDuration,
      rootCause: parsed.rootCause ?? "Unable to determine",
      organizations: Array.isArray(parsed.organizations) ? parsed.organizations : orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: Array.isArray(parsed.l1Actions) ? parsed.l1Actions : [],
      l2Actions: Array.isArray(parsed.l2Actions) ? parsed.l2Actions : [],
      severity: (["low", "medium", "high", "critical"].includes(parsed.severity) ? parsed.severity : "medium") as AnalysisResult["ai"]["severity"],
      resolution: parsed.resolution ?? "No action required",
    };
  } catch (aiErr) {
    console.warn(`[LogAnalyze] AI failed for ${transactionId}:`, (aiErr as Error).message);
    ai = {
      summary: `Log analysis for transaction ${transactionId} — ${errors.length} errors, ${entries.length} log lines.`,
      dataFlow: "",
      transactionCategory: txType,
      fanoutOrgCount: stats.fanoutOrgCount != null ? `${stats.fanoutOrgCount} orgs` : "unknown",
      documentsFound: stats.finalDocumentsRetrieved != null ? `${stats.finalDocumentsRetrieved} documents retrieved` : "unknown",
      durationMs: stats.durationMs != null ? `${stats.durationMs}ms` : "unknown",
      rootCause: errors[0]?.message ?? "Unable to determine (AI unavailable)",
      organizations: orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: ["Review error lines manually"],
      l2Actions: ["Escalate if errors are systemic"],
      severity: hasErrors ? "high" : "low",
      resolution: "Manual investigation required",
    };
  }

  return { transactionId, detail: syntheticDetail, organizations: orgs, ai };
}

export function registerAnalyzeRoutes(app: Express): void {
  // Main analysis endpoint
  app.post("/api/analyze", async (req: Request, res: Response) => {
    const { transactionId, captureScreenshot, usePlaywright } = req.body as {
      transactionId?: string;
      captureScreenshot?: boolean;
      usePlaywright?: boolean;
    };

    if (!transactionId?.trim()) {
      res.status(400).json({ error: "transactionId is required" });
      return;
    }

    try {
      const result = await analyzeTransaction(
        transactionId.trim(),
        captureScreenshot === true,
        usePlaywright === true
      );
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[Analyze] Error for ${transactionId}:`, message);
      res.status(500).json({ error: message });
    }
  });

  // Log-text analysis — accepts raw pasted log lines, no portal fetch needed
  app.post("/api/analyze/logtext", async (req: Request, res: Response) => {
    const { logText, transactionId } = req.body as { logText?: string; transactionId?: string };
    if (!logText?.trim()) {
      res.status(400).json({ error: "logText is required" });
      return;
    }
    const txId = transactionId?.trim() || "log-paste-" + Date.now();
    try {
      const result = await analyzeLogText(logText.trim(), txId);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[LogAnalyze] Error for ${txId}:`, message);
      res.status(500).json({ error: message });
    }
  });

  // Rawtext endpoint — returns the plain text the parser actually works with.
  // Use this to diagnose why field extraction returns 0 results.
  app.get("/api/analyze/rawtext/:transactionId", async (req: Request, res: Response) => {
    const transactionId = req.params["transactionId"] as string;
    try {
      const detail = await fetchTransactionDetail(transactionId);
      const plainText = detail.rawHtml ? htmlToText(detail.rawHtml) : "";
      res.type("text/plain").send(
        `=== PLAIN TEXT (${plainText.length} chars) ===\n\n${plainText}\n\n` +
        `=== RAW FIELDS EXTRACTED (${Object.keys(detail.rawFields).length}) ===\n\n` +
        Object.entries(detail.rawFields).map(([k, v]) => `${k}: ${v}`).join("\n")
      );
    } catch (err) {
      res.status(500).type("text/plain").send(`Error: ${(err as Error).message}`);
    }
  });

  // Debug endpoint — returns raw HTML and parsed fields so you can inspect
  // what the portal actually sends back for a given transaction
  app.get("/api/analyze/debug/:transactionId", async (req: Request, res: Response) => {
    const transactionId = req.params["transactionId"] as string;
    try {
      const detail = await fetchTransactionDetail(transactionId);
      res.json({
        transactionId,
        endpointUsed: detail.endpointUsed,
        rawFieldsCount: Object.keys(detail.rawFields).length,
        rawFields: detail.rawFields,
        oidsFound: detail.oids,
        rawHtmlLength: detail.rawHtml?.length ?? 0,
        rawHtml: detail.rawHtml ?? null,
        payloadEndpointUsed: detail.payloadEndpointUsed ?? null,
        rawPayloadLength: detail.rawPayload?.length ?? 0,
        rawPayload: detail.rawPayload ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
