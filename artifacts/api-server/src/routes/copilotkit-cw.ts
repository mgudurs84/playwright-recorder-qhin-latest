import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
} from "@copilotkit/runtime";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { createVertex } from "@ai-sdk/google-vertex";
import { z } from "zod";
import type { CwTransactionRecord } from "@workspace/db";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { Express } from "express";
import { getPlaywrightService, takeScreenshotAsync } from "../services/playwright-service";

function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON environment variable is required");
  }
  const serviceAccount = JSON.parse(serviceAccountJson);
  const vertex = createVertex({
    project: serviceAccount.project_id || "vertex-ai-demo-468112",
    location: "us-central1",
    googleAuthOptions: { credentials: serviceAccount },
  });
  return vertex(process.env.VERTEX_MODEL_ID || "gemini-2.5-flash");
}

interface SkillDef {
  name: string;
  system_prompt: string;
  human_in_the_loop?: { message?: string };
}

function loadCwSkill(filename: string): SkillDef {
  const filePath = join(import.meta.dirname, "..", "skills", filename);
  const raw = readFileSync(filePath, "utf8");
  return yaml.load(raw) as SkillDef;
}

interface GroupedAnalysis {
  totalRecords: number;
  errorCount: number;
  statusBreakdown: Record<string, number>;
  errorsByType: Record<string, CwTransactionRecord[]>;
  errorsByOrg: Record<string, number>;
  errorsByHour: Record<string, number>;
}

const ERROR_PATTERNS = ["error", "fail", "failed", "reject", "rejected", "timeout", "exception", "unavailable", "denied", "unauthorized", "forbidden", "404", "500", "503"];

function isErrorRecord(record: CwTransactionRecord): boolean {
  const status = record.status?.toLowerCase() || "";
  if (ERROR_PATTERNS.some(p => status.includes(p))) return true;
  if (record.raw) {
    for (const [key, val] of Object.entries(record.raw)) {
      const lkey = key.toLowerCase();
      const lval = String(val).toLowerCase();
      if (/^\d+(\.\d+)?ms$/.test(val)) continue;
      if (lkey.includes("status") || lkey.includes("result") || lkey.includes("code")) {
        if (ERROR_PATTERNS.some(p => lval.includes(p))) return true;
      }
      if (ERROR_PATTERNS.some(p => lval === p)) return true;
    }
  }
  return false;
}

function groupTransactionsByStatus(records: CwTransactionRecord[]): GroupedAnalysis {
  const statusBreakdown: Record<string, number> = {};
  const errorsByType: Record<string, CwTransactionRecord[]> = {};
  const errorsByOrg: Record<string, number> = {};
  const errorsByHour: Record<string, number> = {};
  let errorCount = 0;

  for (const record of records) {
    const rawStatusVal = record.raw
      ? Object.entries(record.raw).find(([k]) => /status|result|code/i.test(k))?.[1]
      : undefined;
    const displayStatus = (rawStatusVal && !/^\d+(\.\d+)?ms$/.test(rawStatusVal))
      ? rawStatusVal.toLowerCase()
      : (record.status?.toLowerCase() || "unknown");

    statusBreakdown[displayStatus] = (statusBreakdown[displayStatus] || 0) + 1;

    if (isErrorRecord(record)) {
      errorCount++;
      const txType = record.transactionType || "Unknown";
      if (!errorsByType[txType]) errorsByType[txType] = [];
      errorsByType[txType].push(record);

      const org = record.initiatingOrgId || "Unknown";
      errorsByOrg[org] = (errorsByOrg[org] || 0) + 1;

      if (record.timestamp) {
        try {
          const date = new Date(record.timestamp);
          if (!isNaN(date.getTime())) {
            const hour = `${String(date.getHours()).padStart(2, "0")}:00`;
            errorsByHour[hour] = (errorsByHour[hour] || 0) + 1;
          }
        } catch {}
      }
    }
  }

  return { totalRecords: records.length, errorCount, statusBreakdown, errorsByType, errorsByOrg, errorsByHour };
}

function validateExtractedRecords(records: CwTransactionRecord[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (records.length === 0) issues.push("No records were extracted from the table");
  const requiredFields: Array<keyof CwTransactionRecord> = ["transactionId", "status"];
  for (let i = 0; i < Math.min(records.length, 5); i++) {
    for (const field of requiredFields) {
      if (!records[i][field]) issues.push(`Record ${i}: missing required field '${String(field)}'`);
    }
  }
  return { valid: issues.length === 0, issues };
}

interface CwSessionState {
  phase: string;
  daysBack: number;
  records: CwTransactionRecord[];
  recordCount: number;
  errorCount: number;
  report: string | null;
}

let cwSession: CwSessionState = {
  phase: "idle",
  daysBack: 7,
  records: [],
  recordCount: 0,
  errorCount: 0,
  report: null,
};

function resetCwSession(daysBack = 7): void {
  cwSession = {
    phase: "idle",
    daysBack,
    records: [],
    recordCount: 0,
    errorCount: 0,
    report: null,
  };
}

const cwCheckSessionTool = defineTool({
  name: "cwCheckSession",
  description: "Check if a valid saved session exists for the CommonWell portal.",
  parameters: z.object({}),
  execute: async () => {
    return { valid: false, reason: "Fresh session required — proceeding with full login" };
  },
});

const cwLoginTool = defineTool({
  name: "cwLogin",
  description: "Log into the CommonWell portal. Returns whether OTP is needed.",
  parameters: z.object({}),
  execute: async () => {
    const username = process.env.CW_USERNAME;
    const password = process.env.CW_PASSWORD;
    if (!username || !password) {
      return { success: false, needsOtp: false, error: "CW_USERNAME and CW_PASSWORD must be set" };
    }
    const pw = getPlaywrightService();
    try {
      const result = await pw.login(username, password);
      return { success: true, ...result };
    } catch (err) {
      const message = (err as Error).message;
      let screenshotUrl: string | undefined;
      try { const page = await pw.getPage(); screenshotUrl = await takeScreenshotAsync(page, "login-error"); } catch {}
      return { success: false, needsOtp: false, error: message, screenshotUrl };
    }
  },
});

const cwSubmitOtpTool = defineTool({
  name: "cwSubmitOtp",
  description: "Submit the OTP verification code to complete login. The user must provide this code from their email/SMS.",
  parameters: z.object({
    otp: z.string().describe("The one-time verification code from the user"),
  }),
  execute: async ({ otp }) => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "waitingForOtp" && phase !== "authenticating") {
      return { success: false, error: `Cannot submit OTP in '${phase}' phase — must be in 'waitingForOtp' phase` };
    }
    try {
      const result = await pw.submitOtp(otp);
      return result;
    } catch (err) {
      let screenshotUrl: string | undefined;
      try { const page = await pw.getPage(); screenshotUrl = await takeScreenshotAsync(page, "otp-error"); } catch {}
      return { success: false, error: (err as Error).message, screenshotUrl };
    }
  },
});

const cwAuthCompleteTool = defineTool({
  name: "cwAuthComplete",
  description: "Signal that authentication is complete. The Navigator will take over automatically.",
  parameters: z.object({
    daysBack: z.number().default(7).describe("How many days back to search for transactions"),
  }),
  execute: async ({ daysBack }) => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "authenticating" && phase !== "authenticated") {
      return { success: false, error: `Cannot complete auth in '${phase}' phase` };
    }
    pw.setPhase("authenticated");
    cwSession.phase = "authenticated";
    cwSession.daysBack = daysBack;
    console.log(`[CW] Auth complete. daysBack=${daysBack}`);
    return { success: true, nextAgent: "cw-navigator", currentPhase: "authenticated" };
  },
});

const cwNavigateToTransactionsTool = defineTool({
  name: "cwNavigateToTransactions",
  description: "Navigate to the Transaction Logs page in the CommonWell portal.",
  parameters: z.object({}),
  execute: async () => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "authenticated" && phase !== "navigating") {
      return { success: false, error: `Cannot navigate in '${phase}' phase — authentication must be completed first` };
    }
    try {
      const screenshotUrl = await pw.navigateToTransactionLogs();
      return { success: true, screenshotUrl };
    } catch (err) {
      const message = (err as Error).message;
      let errScreenshot: string | undefined;
      try { const page = await pw.getPage(); errScreenshot = await takeScreenshotAsync(page, "nav-error"); } catch {}
      return { success: false, error: message, screenshotUrl: errScreenshot };
    }
  },
});

const cwApplyDateFilterTool = defineTool({
  name: "cwApplyDateFilter",
  description: "Apply a date range filter on the Transaction Logs page.",
  parameters: z.object({
    daysBack: z.number().default(7).describe("Number of days back to filter"),
  }),
  execute: async ({ daysBack }) => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "authenticated" && phase !== "navigating") {
      return { success: false, error: `Cannot apply filter in '${phase}' phase — must navigate first` };
    }
    try {
      const screenshotUrl = await pw.applyDateFilter(daysBack);
      const dataLoaded = await pw.waitForDataLoaded();
      return { success: true, dataLoaded, screenshotUrl };
    } catch (err) {
      let errScreenshot: string | undefined;
      try { const page = await pw.getPage(); errScreenshot = await takeScreenshotAsync(page, "date-filter-error"); } catch {}
      return { success: false, error: (err as Error).message, screenshotUrl: errScreenshot };
    }
  },
});

const cwExtractTransactionsTool = defineTool({
  name: "cwExtractTransactions",
  description: "Extract all transaction records from the loaded table. Uses Kendo API (fast) with DOM pagination fallback.",
  parameters: z.object({
    maxRecords: z.number().default(0).describe("Max records to extract (0 = all)"),
  }),
  execute: async ({ maxRecords }) => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "navigating" && phase !== "authenticated") {
      return { success: false, error: `Cannot extract in '${phase}' phase — must navigate to transaction logs first` };
    }
    try {
      const { records, screenshotUrl } = await pw.extractTransactions(maxRecords);
      const validation = validateExtractedRecords(records);
      const grouped = groupTransactionsByStatus(records);

      cwSession.records = records;
      cwSession.recordCount = records.length;
      cwSession.errorCount = grouped.errorCount;

      if (!validation.valid) {
        return { success: false, totalRecords: records.length, validationIssues: validation.issues, screenshotUrl };
      }

      return {
        success: true,
        totalRecords: records.length,
        errorCount: grouped.errorCount,
        statusBreakdown: grouped.statusBreakdown,
        screenshotUrl,
      };
    } catch (err) {
      let errScreenshot: string | undefined;
      try { const page = await pw.getPage(); errScreenshot = await takeScreenshotAsync(page, "extraction-error"); } catch {}
      return { success: false, error: (err as Error).message, screenshotUrl: errScreenshot };
    }
  },
});

const cwNavigationCompleteTool = defineTool({
  name: "cwNavigationComplete",
  description: "Signal that navigation and extraction are complete. The Reporter will take over automatically.",
  parameters: z.object({}),
  execute: async () => {
    const pw = getPlaywrightService();
    const phase = pw.getCurrentPhase();
    if (phase !== "navigating" && phase !== "extracted") {
      return { success: false, error: `Cannot complete navigation in '${phase}' phase` };
    }
    pw.setPhase("extracted");
    cwSession.phase = "extracted";
    console.log(`[CW] Navigation complete. ${cwSession.recordCount} records, ${cwSession.errorCount} errors.`);
    return { success: true, nextAgent: "cw-reporter", currentPhase: "extracted" };
  },
});

const cwGetRunDataTool = defineTool({
  name: "cwGetRunData",
  description: "Retrieve the extracted transaction records for analysis, with pre-computed groupings by status, error type, and organization.",
  parameters: z.object({}),
  execute: async () => {
    const records = cwSession.records;
    if (records.length === 0) {
      return { error: "No records available. Navigation may not be complete yet." };
    }
    const grouped = groupTransactionsByStatus(records);
    return {
      totalRecords: grouped.totalRecords,
      errorCount: grouped.errorCount,
      statusBreakdown: grouped.statusBreakdown,
      errorsByType: Object.fromEntries(
        Object.entries(grouped.errorsByType).map(([type, recs]) => [
          type,
          { count: recs.length, samples: recs.slice(0, 5) },
        ])
      ),
      errorsByOrg: grouped.errorsByOrg,
      errorsByHour: grouped.errorsByHour,
      records,
    };
  },
});

const cwSaveReportTool = defineTool({
  name: "cwSaveReport",
  description: "Save the analysis report and mark the run complete.",
  parameters: z.object({
    report: z.string().describe("The markdown analysis report"),
  }),
  execute: async ({ report }) => {
    cwSession.report = report;
    cwSession.phase = "complete";
    const pw = getPlaywrightService();
    pw.setPhase("complete");
    await pw.close();
    console.log("[CW] Report saved. Run complete.");
    return { success: true };
  },
});

let cachedCwRuntime: CopilotRuntime | null = null;
let cachedCwHandler: ReturnType<typeof copilotRuntimeNodeHttpEndpoint> | null = null;

function buildCwRuntime(): CopilotRuntime {
  const model = createVertexModel();

  let authPrompt: string;
  let navigatorPrompt: string;
  let reporterPrompt: string;

  try {
    const authSkill = loadCwSkill("cw-auth-agent.yaml");
    authPrompt = authSkill.system_prompt;
  } catch {
    authPrompt = "You are the Auth Agent. Authenticate with the CommonWell portal using cwCheckSession, cwLogin, cwSubmitOtp, and cwAuthComplete tools.";
  }

  try {
    const navSkill = loadCwSkill("cw-navigator-agent.yaml");
    navigatorPrompt = navSkill.system_prompt;
  } catch {
    navigatorPrompt = "You are the Navigator Agent. Navigate to Transaction Logs, apply date filters, extract table data, then call cwNavigationComplete.";
  }

  try {
    const repSkill = loadCwSkill("cw-reporter-agent.yaml");
    reporterPrompt = repSkill.system_prompt;
  } catch {
    reporterPrompt = "You are the Reporter Agent. Call cwGetRunData, analyze errors, produce a markdown report, then call cwSaveReport.";
  }

  const authAgent = new BuiltInAgent({
    model,
    prompt: authPrompt,
    tools: [cwCheckSessionTool, cwLoginTool, cwSubmitOtpTool, cwAuthCompleteTool],
    maxSteps: 10,
  });

  const navigatorAgent = new BuiltInAgent({
    model,
    prompt: navigatorPrompt,
    tools: [cwNavigateToTransactionsTool, cwApplyDateFilterTool, cwExtractTransactionsTool, cwNavigationCompleteTool],
    maxSteps: 15,
  });

  const reporterAgent = new BuiltInAgent({
    model,
    prompt: reporterPrompt,
    tools: [cwGetRunDataTool, cwSaveReportTool],
    maxSteps: 10,
  });

  const runtime = new CopilotRuntime({
    agents: {
      "cw-auth": authAgent,
      "cw-navigator": navigatorAgent,
      "cw-reporter": reporterAgent,
    },
  });

  console.log("[CW Runtime] Initialized with 3 agents: cw-auth, cw-navigator, cw-reporter");
  return runtime;
}

const CW_COPILOTKIT_PATH = "/api/cw-copilotkit";

function getCwHandler(): ReturnType<typeof copilotRuntimeNodeHttpEndpoint> | null {
  if (!cachedCwHandler) {
    try {
      if (!cachedCwRuntime) cachedCwRuntime = buildCwRuntime();
      cachedCwHandler = copilotRuntimeNodeHttpEndpoint({
        endpoint: CW_COPILOTKIT_PATH,
        runtime: cachedCwRuntime,
      });
    } catch (err) {
      console.error("[CW Runtime] Failed to initialize:", (err as Error).message);
      return null;
    }
  }
  return cachedCwHandler;
}

export function registerCwCopilotKitRoute(app: Express) {
  app.get(`${CW_COPILOTKIT_PATH}/info`, (_req, res) => {
    res.json({
      version: "1.0.0",
      agents: {
        "cw-auth": { name: "cw-auth", description: "Authenticates with CommonWell portal" },
        "cw-navigator": { name: "cw-navigator", description: "Navigates and extracts transaction data" },
        "cw-reporter": { name: "cw-reporter", description: "Analyzes records and produces error reports" },
      },
    });
  });

  app.use(CW_COPILOTKIT_PATH, (req, res) => {
    const handler = getCwHandler();
    if (!handler) {
      res.status(503).json({ error: "CW CopilotKit runtime not available. Check GCP_SERVICE_ACCOUNT_JSON configuration." });
      return;
    }
    const originalUrl = req.url;
    const restoredUrl = CW_COPILOTKIT_PATH + (originalUrl === "/" ? "" : originalUrl);
    console.log(`[CW-CK] ${req.method} ${restoredUrl}`);
    req.url = restoredUrl;
    handler(req, res);
  });
}

export function registerCwStatusRoute(app: Express) {
  app.get("/api/cw/status", (_req, res) => {
    res.json({
      phase: cwSession.phase,
      daysBack: cwSession.daysBack,
      recordCount: cwSession.recordCount,
      errorCount: cwSession.errorCount,
    });
  });

  app.post("/api/cw/reset", async (_req, res) => {
    const pw = getPlaywrightService();
    try { await pw.close(); } catch {}
    pw.setPhase("idle");
    resetCwSession();
    console.log("[CW] Browser closed and session reset");
    res.json({ success: true });
  });
}
