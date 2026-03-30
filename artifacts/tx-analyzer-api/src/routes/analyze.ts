import { type Express, type Request, type Response } from "express";
import { generateText } from "ai";
import multer from "multer";
import { fetchTransactionDetail, type TransactionDetail } from "../services/direct-fetch.js";
import { fetchTransactionDetailPlaywright } from "../services/playwright-fetch.js";
import { resolveOidsWithLookup } from "../services/oid-resolver.js";
import { takeScreenshot } from "../services/auth.js";
import { createVertexModel } from "../lib/vertex.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are supported"));
    }
  },
});

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

  // Pre-compute key statistics from raw logs so Gemini cannot hallucinate counts
  const logStats = detail.rawLogs
    ? computeLogStats(parseLogLines(detail.rawLogs))
    : null;

  const computedFactsBlock = logStats
    ? `=== COMPUTED FACTS (DO NOT DEVIATE FROM THESE NUMBERS) ===
FINAL DOCUMENTS RETRIEVED (deduplicated, authoritative): ${logStats.finalDocumentsRetrieved ?? "not found in log"}
TOTAL DOCUMENTS IN FANOUT (before dedup): ${logStats.finalDocsInFanout ?? "not found in log"}
PATIENT SEARCH FANOUT ORG COUNT: ${logStats.patientSearchFanoutCount ?? "not found in log"}
PATIENTS FOUND (patient search): ${logStats.patientsFound ?? "not found in log"}
DOCUMENT SEARCH FANOUT ORG COUNT: ${logStats.fanoutOrgCount ?? "not found in log"}
TOTAL DURATION: ${logStats.durationMs != null ? `${logStats.durationMs}ms` : "unknown"}
OVERALL STATUS: ${logStats.overallStatus ?? "unknown"}
=== END COMPUTED FACTS ===

`
    : "";

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

${computedFactsBlock}${
  rawLogsText
    ? `--- BROKER LOG LINES (for context and per-org error details — use COMPUTED FACTS above for all counts) ---
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

INSTRUCTIONS — use COMPUTED FACTS above for all counts; use BROKER LOG LINES for per-org error details:
1. TRANSACTION CATEGORY: Classify as one of: Document Query, Document Retrieve, Patient Search, Patient Match, Document Submission, or Other.
2. BROKERING CHAIN: Show: Initiating Org → CVS Health (broker) → each target org with its result. Use exact counts from COMPUTED FACTS.
3. FANOUT ORG COUNT: Use COMPUTED FACTS. Format as short label, e.g. "14 orgs (patient search) → 104 orgs (document fanout)". Do NOT count from log lines.
4. DOCUMENTS FOUND: Use COMPUTED FACTS "FINAL DOCUMENTS RETRIEVED" value. Do NOT count from individual per-org lines.
5. DURATION: Use COMPUTED FACTS "TOTAL DURATION". Fallback to CALCULATED DURATION from extracted fields.
6. ORGANIZATIONS: List every org with name, OID, role, and outcome. Put per-org detail in the summary and l1Actions.
7. L1/L2 ACTIONS: Be highly specific. If broker log lines were not available, the first L1 action MUST be "Use the 'Paste Log Text' tab to paste the broker logs for this transaction." Then list errors from summary fields.

CRITICAL FIELD LENGTH RULES — the stats bar tiles show these 4 fields directly:
- "transactionCategory": max 4 words
- "fanoutOrgCount": max 8 words, e.g. "14 orgs (patient search) → 104 orgs (doc fanout)", "paste broker logs", "1 (direct)"
- "documentsFound": max 8 words, e.g. "8 retrieved (29 fanout)", "0", "paste broker logs"
- "durationMs": max 10 chars, e.g. "4163ms", "unknown"
Never put sentences or explanations in these four fields. Explanations go in summary, l1Actions, l2Actions.

Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description: operation type, requesting org, broker, patient search fanout (exact count from COMPUTED FACTS), document search fanout (exact count from COMPUTED FACTS), documents retrieved (exact count from COMPUTED FACTS), outcome. If broker logs unavailable note the limitation.",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other",
  "fanoutOrgCount": "use COMPUTED FACTS — e.g. '14 orgs (patient search) → 104 orgs (document fanout)'",
  "documentsFound": "use COMPUTED FACTS — e.g. '8 retrieved (29 in fanout)' or '0'",
  "durationMs": "use COMPUTED FACTS duration, e.g. '3901ms'",
  "dataFlow": "Exact chain using COMPUTED FACTS counts: 'Requester Org (requester) → CVS Health (broker) → 14 orgs patient search (4 patients found) → 104 orgs document fanout (8 docs retrieved)'",
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

    // Override stats with values computed directly from rawLogs (if available).
    // This prevents the AI from under-counting when it sees many "0 documents"
    // per-org lines and misses the authoritative "Completed brokered document
    // search with N documents retrieved" summary line.
    if (detail.rawLogs) {
      const rawEntries = parseLogLines(detail.rawLogs);
      const rawStats = computeLogStats(rawEntries);

      if (rawStats.finalDocumentsRetrieved != null) {
        const docs =
          rawStats.finalDocsInFanout != null &&
          rawStats.finalDocsInFanout !== rawStats.finalDocumentsRetrieved
            ? `${rawStats.finalDocumentsRetrieved} retrieved (${rawStats.finalDocsInFanout} in fanout)`
            : `${rawStats.finalDocumentsRetrieved} retrieved`;
        ai = { ...ai, documentsFound: docs };
      }

      const hasFanoutData =
        rawStats.patientSearchFanoutCount != null || rawStats.fanoutOrgCount != null;
      if (hasFanoutData) {
        const parts = [
          rawStats.patientSearchFanoutCount != null
            ? `${rawStats.patientSearchFanoutCount} orgs (patient search, ${rawStats.patientsFound ?? "?"} patients found)`
            : null,
          rawStats.fanoutOrgCount != null
            ? `${rawStats.fanoutOrgCount} orgs (document fanout)`
            : null,
        ].filter(Boolean);
        ai = { ...ai, fanoutOrgCount: parts.join(" → ") };
      }

      if (rawStats.durationMs != null && ai.durationMs === "unknown") {
        ai = { ...ai, durationMs: `${rawStats.durationMs}ms` };
      }
    }
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
    // Component column may be empty (double-tab) — use [^\t]* (zero or more)
    const m = line.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+)\t(\w+)\t([^\t]*)\t(.+)$/);
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

    // Document Retrieve (not search): a single document is returned per transaction
    // "Completed brokered document retrieve with result document '...'"
    if (
      finalDocumentsRetrieved === null &&
      /Completed brokered document retrieve with result document/i.test(msg)
    ) {
      finalDocumentsRetrieved = 1;
    }

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

    // Per-org: document retrieve request complete (different format — no "documents found" field)
    // "Brokered document retrieve request complete to target organization '...' ... Status: Success, error count: 0, error details: ''"
    const docRetrieveCompleteMatch = msg.match(
      /[Bb]rokered document retrieve request complete to target organization "([^"]+)".*?Status:\s*(\w+).*?error count:\s*(\d+).*?error details:\s*"([^"]*)"/i
    );
    if (docRetrieveCompleteMatch) {
      const status = docRetrieveCompleteMatch[2];
      const errCount = parseInt(docRetrieveCompleteMatch[3], 10);
      perOrgDocResults.push({
        org: docRetrieveCompleteMatch[1],
        status,
        docsFound: /success/i.test(status) && errCount === 0 ? 1 : 0,
        error: docRetrieveCompleteMatch[4] || undefined,
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

  // For Document Retrieve transactions there is no "Retrieved N organizations for fanout" line.
  // Infer the fanout org count from the number of per-org retrieve completions captured above.
  if (fanoutOrgCount === null && perOrgDocResults.length > 0 && finalDocumentsRetrieved !== null) {
    fanoutOrgCount = perOrgDocResults.length;
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

function buildScreenshotPrompt(context?: string): string {
  const contextBlock = context?.trim()
    ? `\nADDITIONAL CONTEXT FROM THE SUPPORT ENGINEER:\n${context.trim()}\n\nUse this context to focus your analysis and tailor the L1/L2 actions accordingly.\n`
    : "";

  return `You are a CommonWell Health Alliance (CW) L1/L2 support analyst.
CVS Health operates as the CommonWell broker/intermediary that fans out requests to member organizations.
${contextBlock}
The attached image is a screenshot from a support investigation. It may be from:
- GCP Cloud Logging or GCP Error Reporting
- The CommonWell portal (transaction detail page, log viewer, or error screen)
- A FHIR server response or error UI
- Any other system relevant to a CW transaction investigation

Analyze everything visible in the screenshot: error messages, log lines, transaction IDs, OIDs, HTTP status codes, timestamps, org names, counts, and any other relevant details.

Extract any OIDs you see (format: digits separated by dots, starting with 2.16 or 1.3.6) and list them in the organizations array.

CRITICAL FIELD LENGTH RULES — the stats bar tiles show these 4 fields directly:
- "transactionCategory": max 4 words
- "fanoutOrgCount": max 8 words, e.g. "14 orgs (patient search) → 104 orgs (doc fanout)", "not visible", "1 (direct)"
- "documentsFound": max 8 words, e.g. "8 retrieved (29 fanout)", "0", "not visible"
- "durationMs": max 10 chars, e.g. "4163ms", "unknown"
Never put sentences or explanations in these four fields. Explanations go in summary, l1Actions, l2Actions.

Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description of what is visible in the screenshot: what system, what error or event, any transaction IDs, org names, counts, or timestamps visible.",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other|Unknown",
  "fanoutOrgCount": "number of orgs visible in screenshot, or 'not visible'",
  "documentsFound": "document count visible, or 'not visible'",
  "durationMs": "duration if visible, e.g. '3901ms', or 'unknown'",
  "dataFlow": "Data flow chain inferred from screenshot, e.g. 'Requester → CVS Health (broker) → target orgs', or 'not determinable from screenshot'",
  "rootCause": "Root cause of any errors visible, or 'No errors visible'",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name or OID if name not visible", "role": "requester|responder|intermediary|broker|unknown"}
  ],
  "l1Actions": ["Specific action L1 should take based on what is visible in the screenshot"],
  "l2Actions": ["Engineering escalation action if applicable"],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution based on screenshot content"
}`;
}

async function analyzeScreenshotImage(
  imageBuffer: Buffer,
  mimeType: string,
  context?: string
): Promise<AnalysisResult> {
  const imageBase64 = imageBuffer.toString("base64");
  const txId = "screenshot-" + Date.now();

  const syntheticDetail: TransactionDetail = {
    transactionId: txId,
    timestamp: new Date().toISOString(),
    transactionType: "Screenshot Analysis",
    status: "Analyzed",
    rawFields: {
      "Analysis Type": "Screenshot / Image Upload",
      "Image MIME Type": mimeType,
      "Analyzed At": new Date().toISOString(),
      ...(context?.trim() ? { "Engineer Context": context.trim() } : {}),
    },
    oids: [],
  };

  let ai: AnalysisResult["ai"];
  try {
    const model = createVertexModel();
    const prompt = buildScreenshotPrompt(context);

    const { text } = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image" as const,
              image: imageBase64,
              mediaType: mimeType as `image/${string}`,
            },
            {
              type: "text" as const,
              text: prompt,
            },
          ],
        },
      ],
    });

    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as AnalysisResult["ai"];

    const trimStat = (val: string | undefined, fallback: string, maxChars = 50): string => {
      const s = (val ?? fallback).trim();
      if (s.length <= maxChars) return s;
      const cut = s.search(/[.,(]/);
      return cut > 0 ? s.slice(0, cut).trim() : s.slice(0, maxChars).trim();
    };

    // Extract OIDs from two sources and merge:
    // 1. parsed.organizations[].oid (structured output)
    // 2. regex scan of raw Gemini response text (catches OIDs mentioned in summary/rootCause/dataFlow)
    const oidRegex = /\d+(?:\.\d+){5,}/g;
    const textOids = [...new Set(
      (text.match(oidRegex) ?? []).filter((o) => o.startsWith("2.16.840") || o.startsWith("1.3.6"))
    )];
    const structuredOids = Array.isArray(parsed.organizations)
      ? parsed.organizations.map((o: { oid: string }) => o.oid).filter(Boolean)
      : [];
    const rawOids = [...new Set([...structuredOids, ...textOids])];
    const orgs = await resolveOidsWithLookup(rawOids);
    const resolvedNames = new Map(orgs.map((o) => [o.oid, o.name]));

    // Update syntheticDetail with discovered OIDs
    syntheticDetail.oids = rawOids;

    const structuredOrgMap = new Map(
      Array.isArray(parsed.organizations)
        ? parsed.organizations.map((o: { oid: string; name: string; role: string }) => [o.oid, o])
        : []
    );
    // Merge: structured orgs with resolved names + any extra OIDs found only by regex
    const aiOrgs = [
      ...Array.from(structuredOrgMap.values()).map((o: { oid: string; name: string; role: string }) => ({
        ...o,
        name: resolvedNames.get(o.oid) ?? o.name,
      })),
      ...orgs
        .filter((o) => !structuredOrgMap.has(o.oid))
        .map((o) => ({ oid: o.oid, name: o.name, role: "unknown" as const })),
    ];

    ai = {
      summary: parsed.summary ?? "No summary available",
      dataFlow: parsed.dataFlow ?? "",
      transactionCategory: trimStat(parsed.transactionCategory, "Unknown", 30),
      fanoutOrgCount: trimStat(parsed.fanoutOrgCount, "not visible"),
      documentsFound: trimStat(parsed.documentsFound, "not visible"),
      durationMs: trimStat(parsed.durationMs, "unknown", 20),
      rootCause: parsed.rootCause ?? "Unable to determine",
      organizations: aiOrgs,
      l1Actions: Array.isArray(parsed.l1Actions) ? parsed.l1Actions : [],
      l2Actions: Array.isArray(parsed.l2Actions) ? parsed.l2Actions : [],
      severity: (
        ["low", "medium", "high", "critical"].includes(parsed.severity)
          ? parsed.severity
          : "medium"
      ) as AnalysisResult["ai"]["severity"],
      resolution: parsed.resolution ?? "No action required",
    };

    return { transactionId: txId, detail: syntheticDetail, organizations: orgs, ai };
  } catch (aiErr) {
    console.warn("[ScreenshotAnalyze] AI failed:", (aiErr as Error).message);
    ai = {
      summary: "Screenshot analysis failed. The image could not be processed by the AI model.",
      dataFlow: "",
      transactionCategory: "Unknown",
      fanoutOrgCount: "unknown",
      documentsFound: "unknown",
      durationMs: "unknown",
      rootCause: (aiErr as Error).message ?? "AI unavailable",
      organizations: [],
      l1Actions: ["Review the screenshot manually"],
      l2Actions: ["Check AI model configuration"],
      severity: "medium",
      resolution: "Manual investigation required",
    };
    return { transactionId: txId, detail: syntheticDetail, organizations: [], ai };
  }
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

  // Screenshot analysis endpoint — accepts a multipart image upload and runs Gemini Vision
  app.post(
    "/api/analyze/screenshot",
    (req: Request, res: Response, next) => {
      upload.single("image")(req, res, (err) => {
        if (err) {
          const multerErr = err as { code?: string; message?: string };
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "Image file exceeds the 20 MB size limit" });
          } else if (multerErr.code === "LIMIT_UNEXPECTED_FILE") {
            res.status(400).json({ error: "Unexpected file field — use multipart field name 'image'" });
          } else {
            res.status(400).json({ error: multerErr.message ?? "File upload error" });
          }
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "image file is required (multipart field: image)" });
        return;
      }
      const context = typeof req.body?.context === "string" ? req.body.context : undefined;
      try {
        const result = await analyzeScreenshotImage(file.buffer, file.mimetype, context);
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        console.error("[ScreenshotAnalyze] Error:", message);
        res.status(500).json({ error: message });
      }
    }
  );
}
