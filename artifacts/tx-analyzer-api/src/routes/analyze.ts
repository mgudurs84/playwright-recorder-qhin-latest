import { type Express, type Request, type Response } from "express";
import { generateText } from "ai";
import { fetchTransactionDetail, type TransactionDetail } from "../services/direct-fetch.js";
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
3. FANOUT ORG COUNT: Count the orgs the request was fanned out to from the log lines. Name each org and its outcome. If some failed, state why (error code, timeout, no match). If log lines are unavailable, say "Not determinable — broker log lines not fetched" and explain what IS known from the summary.
4. DOCUMENTS FOUND / DOWNLOADED: From log lines, state how many docs each org returned and total docs returned. Which orgs returned docs? Which returned 0? Which failed with errors? If log lines are unavailable, state the known HTTP status and explicitly note that doc counts require checking the portal log lines tab manually.
5. DURATION: Calculate from Start Time and End Time. Long durations (>1s) indicate broker fanout.
6. ORGANIZATIONS: List every org with name (from OID resolution or log lines), OID, role, and outcome.
7. L1/L2 ACTIONS: Be highly specific. Name the orgs with errors. Provide the error codes. State exactly what to check in each case. Do NOT give generic advice like "verify with the initiating org if they received data".

Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description covering: what type of operation, who requested it, which broker handled it, how many orgs were involved (if known), how many documents found (if applicable), and the outcome",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other",
  "fanoutOrgCount": "exact number or descriptive string, e.g. '104 organizations' or '1 (direct)' or 'unknown — brokered (~2s duration)'",
  "documentsFound": "e.g. '3 documents' or '1 document retrieved' or '0' or 'unknown (HTTP 200)'",
  "durationMs": "e.g. '3901ms' or 'unknown'",
  "dataFlow": "Step-by-step chain: 'Org A (requester) → CVS Health (broker) → 104 member orgs (fanout)'",
  "rootCause": "Root cause of any errors, or 'No errors detected'",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name", "role": "requester|responder|intermediary|broker"}
  ],
  "l1Actions": ["Specific action L1 should take"],
  "l2Actions": ["Engineering escalation action"],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution or 'No action required'"
}`;
}

export async function analyzeTransaction(
  transactionId: string,
  captureScreenshot = false
): Promise<AnalysisResult> {
  const [detail, screenshotUrl] = await Promise.all([
    fetchTransactionDetail(transactionId),
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

    ai = {
      summary: parsed.summary ?? "No summary available",
      dataFlow: parsed.dataFlow ?? "",
      transactionCategory: parsed.transactionCategory ?? "Unknown",
      fanoutOrgCount: parsed.fanoutOrgCount ?? "unknown",
      documentsFound: parsed.documentsFound ?? "unknown",
      durationMs: parsed.durationMs ?? "unknown",
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

function buildLogPrompt(transactionId: string, logText: string, orgs: Array<{ oid: string; name: string }>): string {
  const orgLines = orgs.map((o) => `  ${o.oid} → ${o.name}`).join("\n") || "  (none resolved)";

  // Summarize errors for the prompt so Gemini doesn't have to scan 100+ lines
  const entries = parseLogLines(logText);
  const errors = entries.filter((e) => e.level === "Error" || e.level === "Warning");
  const errorSummary = errors.length
    ? errors.slice(0, 30).map((e) => `  [${e.level}][${e.component}] ${e.message}`).join("\n")
    : "  (none)";

  const capText = logText.length > 18000 ? logText.slice(0, 18000) + "\n...[truncated]" : logText;

  return `You are a CommonWell Health Alliance (CW) L1/L2 support analyst.

Below are the RAW TRANSACTION LOG LINES for transaction ID "${transactionId}".
The format is: Timestamp[TAB]Level[TAB]Component[TAB]Message
Levels: Information, Warning, Error

--- FULL LOG ---
${capText}
--- END LOG ---

ERROR / WARNING SUMMARY (first 30):
${errorSummary}

OID RESOLUTION:
${orgLines}

INSTRUCTIONS:
1. Identify the transaction type (patient search, document query, document retrieve, etc.).
2. Identify EVERY organization involved — requester, broker, all fanout targets — and their roles.
3. List all errors and classify them (timeout, inactive org, SSL, registry error, audience validation, unknown gateway, etc.).
4. Determine overall transaction status (success / partial success / failure).
5. Describe the end-to-end data brokering chain.
6. Provide L1/L2 support analysis.
7. Respond ONLY with a valid JSON object — no markdown, no code blocks:
{
  "summary": "3-4 sentence description: operation type, requesting org, broker, fanout org count, documents/patients found, overall outcome",
  "transactionCategory": "Document Query|Document Retrieve|Patient Search|Patient Match|Other",
  "fanoutOrgCount": "exact number from logs e.g. '104 organizations' or '14 (TEFCA)' or '1 (direct)'",
  "documentsFound": "e.g. '3 documents' or '0' or '1 patient matched'",
  "durationMs": "total duration from first to last log timestamp, e.g. '2044ms'",
  "dataFlow": "Step-by-step chain: 'Org A (requester) → CVS Health (broker) → 104 orgs (fanout)'",
  "rootCause": "Primary root cause of any errors, or 'No blocking errors detected'",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name", "role": "requester|responder|intermediary|broker"}
  ],
  "l1Actions": ["Specific L1 action"],
  "l2Actions": ["Engineering escalation action"],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution or 'No action required'"
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

  const syntheticDetail: TransactionDetail = {
    transactionId,
    timestamp: firstTs,
    transactionType: txType,
    status: hasErrors ? "Partial/Error" : "Successful",
    rawFields: {
      "Transaction ID": transactionId,
      "Start Time": firstTs,
      "End Time": lastTs,
      "Transaction Type": txType,
      "Error Count": String(errors.length),
      "Total Log Lines": String(entries.length),
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

    ai = {
      summary: parsed.summary ?? "No summary available",
      dataFlow: parsed.dataFlow ?? "",
      transactionCategory: parsed.transactionCategory ?? txType,
      fanoutOrgCount: parsed.fanoutOrgCount ?? "unknown",
      documentsFound: parsed.documentsFound ?? "unknown",
      durationMs: parsed.durationMs ?? "unknown",
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
      summary: `Log analysis for transaction ${transactionId} — ${errors.length} errors found across ${entries.length} log lines.`,
      dataFlow: "",
      transactionCategory: txType,
      fanoutOrgCount: "unknown",
      documentsFound: "unknown",
      durationMs: "unknown",
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
    const { transactionId, captureScreenshot } = req.body as {
      transactionId?: string;
      captureScreenshot?: boolean;
    };

    if (!transactionId?.trim()) {
      res.status(400).json({ error: "transactionId is required" });
      return;
    }

    try {
      const result = await analyzeTransaction(
        transactionId.trim(),
        captureScreenshot === true
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
