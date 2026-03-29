import { type Express, type Request, type Response } from "express";
import { generateText } from "ai";
import { fetchTransactionDetail, type TransactionDetail } from "../services/direct-fetch.js";
import { resolveOidsWithLookup } from "../services/oid-resolver.js";
import { createVertexModel } from "../lib/vertex.js";

export interface AnalysisResult {
  transactionId: string;
  detail: TransactionDetail;
  organizations: Array<{ oid: string; name: string }>;
  ai: {
    summary: string;
    rootCause: string;
    organizations: Array<{ oid: string; name: string; role: string }>;
    l1Actions: string[];
    l2Actions: string[];
    severity: "low" | "medium" | "high" | "critical";
    resolution: string;
  };
  error?: string;
}

function buildPrompt(detail: TransactionDetail, orgs: Array<{ oid: string; name: string }>): string {
  const orgMap = Object.fromEntries(orgs.map((o) => [o.oid, o.name]));
  const fields = Object.entries(detail.rawFields)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return `You are a CommonWell Health Alliance (CW) L1/L2 support analyst. Analyze the following transaction log and provide a structured support recommendation.

TRANSACTION ID: ${detail.transactionId}
STATUS: ${detail.status ?? "unknown"}
TYPE: ${detail.transactionType ?? "unknown"}
TIMESTAMP: ${detail.timestamp ?? "unknown"}
REQUESTING ORG: ${detail.requestingOrg ?? orgMap[detail.requestingOid ?? ""] ?? detail.requestingOid ?? "unknown"}
RESPONDING ORG: ${detail.respondingOrg ?? orgMap[detail.respondingOid ?? ""] ?? detail.respondingOid ?? "unknown"}
ERROR CODE: ${detail.errorCode ?? "none"}
ERROR MESSAGE: ${detail.errorMessage ?? "none"}
RESPONSE CODE: ${detail.responseCode ?? "unknown"}
DURATION: ${detail.duration ?? "unknown"}

FIELD DETAILS:
${fields || "  (no structured fields extracted)"}

OID RESOLUTION:
${orgs.map((o) => `  ${o.oid} → ${o.name}`).join("\n") || "  (no OIDs found)"}

Respond ONLY with a valid JSON object in this exact format (no markdown, no code block):
{
  "summary": "1-2 sentence plain-English description of what happened",
  "rootCause": "identified root cause or 'No errors detected'",
  "organizations": [
    {"oid": "2.16.840.1.x", "name": "Org Name", "role": "requester|responder|intermediary"}
  ],
  "l1Actions": [
    "Concrete action L1 support should take immediately"
  ],
  "l2Actions": [
    "Engineering/escalation action if L1 cannot resolve"
  ],
  "severity": "low|medium|high|critical",
  "resolution": "Recommended resolution path or 'No action required'"
}`;
}

async function analyzeTransaction(transactionId: string): Promise<AnalysisResult> {
  const detail = await fetchTransactionDetail(transactionId);
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
      rootCause: parsed.rootCause ?? "Unable to determine",
      organizations: Array.isArray(parsed.organizations) ? parsed.organizations : orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: Array.isArray(parsed.l1Actions) ? parsed.l1Actions : [],
      l2Actions: Array.isArray(parsed.l2Actions) ? parsed.l2Actions : [],
      severity: (["low", "medium", "high", "critical"].includes(parsed.severity) ? parsed.severity : "medium") as AnalysisResult["ai"]["severity"],
      resolution: parsed.resolution ?? "No action required",
    };
  } catch (aiErr) {
    console.warn(`[Analyze] AI analysis failed for ${transactionId}:`, (aiErr as Error).message);
    ai = {
      summary: `Transaction ${transactionId} — status: ${detail.status ?? "unknown"}`,
      rootCause: detail.errorMessage ?? "Unable to determine (AI unavailable)",
      organizations: orgs.map((o) => ({ ...o, role: "unknown" })),
      l1Actions: ["Review transaction details manually"],
      l2Actions: ["Escalate if error persists"],
      severity: "medium",
      resolution: "Manual investigation required",
    };
  }

  return { transactionId, detail, organizations: orgs, ai };
}

export function registerAnalyzeRoutes(app: Express): void {
  app.post("/api/analyze", async (req: Request, res: Response) => {
    const { transactionId } = req.body as { transactionId?: string };
    if (!transactionId?.trim()) {
      res.status(400).json({ error: "transactionId is required" });
      return;
    }

    try {
      const result = await analyzeTransaction(transactionId.trim());
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[Analyze] Error for ${transactionId}:`, message);
      res.status(500).json({ error: message });
    }
  });
}

export { analyzeTransaction };
