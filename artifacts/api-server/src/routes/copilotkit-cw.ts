import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
} from "@copilotkit/runtime";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { createVertex } from "@ai-sdk/google-vertex";
import { z } from "zod";
import { db, cwRuns } from "@workspace/db";
import type { CwTransactionRecord } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
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

function groupTransactionsByStatus(records: CwTransactionRecord[]): GroupedAnalysis {
  const statusBreakdown: Record<string, number> = {};
  const errorsByType: Record<string, CwTransactionRecord[]> = {};
  const errorsByOrg: Record<string, number> = {};
  const errorsByHour: Record<string, number> = {};
  let errorCount = 0;

  for (const record of records) {
    const status = record.status?.toLowerCase() || "unknown";
    statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;

    if (status.includes("error") || status.includes("fail")) {
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

  return {
    totalRecords: records.length,
    errorCount,
    statusBreakdown,
    errorsByType,
    errorsByOrg,
    errorsByHour,
  };
}

function validateExtractedRecords(records: CwTransactionRecord[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (records.length === 0) {
    issues.push("No records were extracted from the table");
  }
  const requiredFields: Array<keyof CwTransactionRecord> = ["transactionId", "status"];
  for (let i = 0; i < Math.min(records.length, 5); i++) {
    for (const field of requiredFields) {
      if (!records[i][field]) {
        issues.push(`Record ${i}: missing required field '${String(field)}'`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

const cwStartRunTool = defineTool({
  name: "cwStartRun",
  description: "Create a new CommonWell automation run. Returns a runId to use in all subsequent calls.",
  parameters: z.object({
    daysBack: z.number().default(7).describe("How many days back to search for transactions"),
  }),
  execute: async ({ daysBack }) => {
    const pw = getPlaywrightService();
    const runId = await pw.createRun({ daysBack, startedAt: new Date().toISOString() });
    await pw.addRunStep({ type: "authenticating", content: "Starting automation run" });
    return { runId, daysBack };
  },
});

const cwCheckSessionTool = defineTool({
  name: "cwCheckSession",
  description: "Check if a valid saved session exists for the CommonWell portal.",
  parameters: z.object({}),
  execute: async () => {
    const username = process.env.CW_USERNAME;
    if (!username) return { valid: false, reason: "CW_USERNAME not configured" };

    const pw = getPlaywrightService();
    const loaded = await pw.loadSessionFromDb(username);
    if (!loaded) return { valid: false, reason: "No saved session or session expired" };

    const valid = await pw.validateSession();
    if (valid) {
      await pw.addRunStep({ type: "authenticating", content: "Existing session is valid — skipping login" });
    }
    return { valid, reason: valid ? "Session is valid" : "Session expired or invalid" };
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
      if (!result.needsOtp) {
        await pw.saveSessionToDb(username);
      }
      await pw.addRunStep({
        type: "authenticating",
        content: result.needsOtp ? "Login submitted — OTP required. Please provide the verification code." : "Login successful — session saved",
        screenshotUrl: result.screenshotUrl,
      });
      return { success: true, ...result };
    } catch (err) {
      const message = (err as Error).message;
      let screenshotUrl: string | undefined;
      try { const page = await pw.getPage(); screenshotUrl = await takeScreenshotAsync(page, "login-error"); } catch {}
      await pw.addRunStep({ type: "error", content: `Login failed: ${message}`, screenshotUrl });
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
    try {
      const result = await pw.submitOtp(otp);
      if (result.success) {
        const username = process.env.CW_USERNAME!;
        await pw.saveSessionToDb(username);
        await pw.addRunStep({
          type: "authenticating",
          content: "OTP verified — session saved",
          screenshotUrl: result.screenshotUrl,
        });
      } else {
        await pw.addRunStep({
          type: "error",
          content: "OTP verification failed — please try again",
          screenshotUrl: result.screenshotUrl,
        });
      }
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
  description: "Signal that authentication is complete and the Navigator should take over.",
  parameters: z.object({
    runId: z.string().optional().describe("The automation run ID (auto-detected if omitted)"),
  }),
  execute: async ({ runId: providedRunId }) => {
    const pw = getPlaywrightService();
    const runId = providedRunId || pw.getRunId();
    await pw.updateRun({ status: "authenticated" });
    await pw.addRunStep({ type: "authenticating", content: "Authentication complete" });
    return { success: true, runId, nextAgent: "cw-navigator" };
  },
});

const cwNavigateToTransactionsTool = defineTool({
  name: "cwNavigateToTransactions",
  description: "Navigate to the Transaction Logs page in the CommonWell portal.",
  parameters: z.object({}),
  execute: async () => {
    const pw = getPlaywrightService();
    try {
      const screenshotUrl = await pw.navigateToTransactionLogs();
      await pw.addRunStep({
        type: "navigating",
        content: "Navigated to Transaction Logs",
        screenshotUrl,
      });
      return { success: true, screenshotUrl };
    } catch (err) {
      const message = (err as Error).message;
      let errScreenshot: string | undefined;
      try { const page = await pw.getPage(); errScreenshot = await takeScreenshotAsync(page, "nav-error"); } catch {}
      await pw.addRunStep({ type: "error", content: `Navigation failed: ${message}`, screenshotUrl: errScreenshot });
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
    try {
      const screenshotUrl = await pw.applyDateFilter(daysBack);
      const dataLoaded = await pw.waitForDataLoaded();
      await pw.addRunStep({
        type: "navigating",
        content: dataLoaded
          ? `Date filter applied (${daysBack} days) — data loaded`
          : `Date filter applied (${daysBack} days) — no data found`,
        screenshotUrl,
      });
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
    try {
      const { records, screenshotUrl } = await pw.extractTransactions(maxRecords);
      const validation = validateExtractedRecords(records);
      const grouped = groupTransactionsByStatus(records);

      await pw.updateRun({
        records,
        recordCount: records.length,
        errorCount: grouped.errorCount,
      });

      if (!validation.valid) {
        await pw.addRunStep({
          type: "extracting",
          content: `Extraction completed with issues: ${validation.issues.join("; ")}`,
          screenshotUrl,
        });
        return {
          success: false,
          totalRecords: records.length,
          validationIssues: validation.issues,
          screenshotUrl,
        };
      }

      await pw.addRunStep({
        type: "extracting",
        content: `Extracted ${records.length} transactions (${grouped.errorCount} errors)`,
        screenshotUrl,
      });

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
  description: "Signal that navigation and extraction are complete. The Reporter should take over.",
  parameters: z.object({
    runId: z.string().optional().describe("The automation run ID (auto-detected if omitted)"),
  }),
  execute: async ({ runId: providedRunId }) => {
    const pw = getPlaywrightService();
    const runId = providedRunId || pw.getRunId();
    await pw.updateRun({ status: "extracted" });
    await pw.addRunStep({ type: "extracting", content: "Extraction complete" });
    return { success: true, runId, nextAgent: "cw-reporter" };
  },
});

const cwGetRunDataTool = defineTool({
  name: "cwGetRunData",
  description: "Retrieve the extracted transaction records for analysis, with pre-computed groupings by status, error type, and organization.",
  parameters: z.object({
    runId: z.string().optional().describe("The automation run ID (auto-detected if omitted)"),
  }),
  execute: async ({ runId: providedRunId }) => {
    const pw = getPlaywrightService();
    const runId = providedRunId || pw.getRunId();
    if (!runId) return { error: "No active run ID" };
    const run = await db.select().from(cwRuns).where(eq(cwRuns.id, runId)).limit(1);
    if (!run[0]) return { error: "Run not found" };

    const records = (run[0].records as CwTransactionRecord[]) || [];
    const grouped = groupTransactionsByStatus(records);

    return {
      runId,
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
      parameters: run[0].parameters,
      steps: run[0].steps,
    };
  },
});

const cwSaveReportTool = defineTool({
  name: "cwSaveReport",
  description: "Save the analysis report to the run and mark it complete.",
  parameters: z.object({
    runId: z.string().optional().describe("The automation run ID (auto-detected if omitted)"),
    report: z.string().describe("The markdown analysis report"),
  }),
  execute: async ({ runId: providedRunId, report }) => {
    const pw = getPlaywrightService();
    const runId = providedRunId || pw.getRunId();
    if (!runId) return { error: "No active run ID" };
    await db
      .update(cwRuns)
      .set({ report, status: "complete", completedAt: new Date() })
      .where(eq(cwRuns.id, runId));

    await pw.addRunStep({ type: "complete", content: "Report saved" });
    await pw.close();

    return { success: true, runId };
  },
});

const cwListRunsTool = defineTool({
  name: "cwListRuns",
  description: "List recent automation runs.",
  parameters: z.object({
    limit: z.number().default(10).describe("Max runs to return"),
  }),
  execute: async ({ limit }) => {
    const runs = await db
      .select({
        id: cwRuns.id,
        status: cwRuns.status,
        recordCount: cwRuns.recordCount,
        errorCount: cwRuns.errorCount,
        startedAt: cwRuns.startedAt,
        completedAt: cwRuns.completedAt,
        parameters: cwRuns.parameters,
      })
      .from(cwRuns)
      .orderBy(desc(cwRuns.startedAt))
      .limit(limit);
    return { runs };
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
    authPrompt = "You are the Auth Agent. Authenticate with the CommonWell portal using cwCheckSession, cwLogin, and cwSubmitOtp tools. When OTP is required, ask the user for the verification code and use cwSubmitOtp.";
  }

  try {
    const navSkill = loadCwSkill("cw-navigator-agent.yaml");
    navigatorPrompt = navSkill.system_prompt;
  } catch {
    navigatorPrompt = "You are the Navigator Agent. Navigate to Transaction Logs, apply date filters, and extract table data.";
  }

  try {
    const repSkill = loadCwSkill("cw-reporter-agent.yaml");
    reporterPrompt = repSkill.system_prompt;
  } catch {
    reporterPrompt = "You are the Reporter Agent. Analyze extracted JSON records and produce an error summary report. Use the pre-computed groupings (statusBreakdown, errorsByType, errorsByOrg) to build your analysis.";
  }

  const authAgent = new BuiltInAgent({
    model,
    prompt: authPrompt,
    tools: [cwStartRunTool, cwCheckSessionTool, cwLoginTool, cwSubmitOtpTool, cwAuthCompleteTool],
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
    tools: [cwGetRunDataTool, cwSaveReportTool, cwListRunsTool],
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

export function registerCwRunsRoute(app: Express) {
  app.get("/api/cw/runs", async (_req, res) => {
    try {
      const runs = await db
        .select({
          id: cwRuns.id,
          status: cwRuns.status,
          recordCount: cwRuns.recordCount,
          errorCount: cwRuns.errorCount,
          parameters: cwRuns.parameters,
          screenshotUrls: cwRuns.screenshotUrls,
          startedAt: cwRuns.startedAt,
          completedAt: cwRuns.completedAt,
        })
        .from(cwRuns)
        .orderBy(desc(cwRuns.startedAt))
        .limit(20);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/cw/runs/:id", async (req, res): Promise<void> => {
    try {
      const run = await db.select().from(cwRuns).where(eq(cwRuns.id, req.params.id)).limit(1);
      if (!run[0]) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(run[0]);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
