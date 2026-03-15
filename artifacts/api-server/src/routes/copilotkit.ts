import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
} from "@copilotkit/runtime";
import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { createVertex } from "@ai-sdk/google-vertex";
import { z } from "zod";
import { db, researchSessions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { ResearchStep } from "@workspace/db";
import type { Express } from "express";
import { loadAllAgents, getAgentConfig } from "../skills/gcp-loader";

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
  const modelId = process.env.VERTEX_MODEL_ID || "gemini-2.5-flash";
  console.log(`Using Vertex AI model: ${modelId}`);
  return vertex(modelId);
}

async function saveStep(sessionId: string, step: ResearchStep, extraUpdates?: Record<string, unknown>) {
  const session = await db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
  if (!session[0]) throw new Error(`Session ${sessionId} not found`);
  const currentSteps = (session[0].steps as ResearchStep[]) || [];
  let statusUpdate: Record<string, unknown> = { steps: [...currentSteps, step] };
  if (step.type === "complete") {
    statusUpdate = { ...statusUpdate, status: "complete", report: step.content, completedAt: new Date() };
  } else if (step.type === "error") {
    statusUpdate = { ...statusUpdate, status: "error" };
  }
  await db.update(researchSessions).set({ ...statusUpdate, ...extraUpdates }).where(eq(researchSessions.id, sessionId));
  return { success: true, stepType: step.type, sessionId };
}

const startResearchTool = defineTool({
  name: "startResearch",
  description: "Create a new research session for a topic. Returns the sessionId — save it and use it in all subsequent calls.",
  parameters: z.object({
    topic: z.string().describe("The research topic or question"),
  }),
  execute: async ({ topic }) => {
    const sessionId = randomUUID();
    await db.insert(researchSessions).values({
      id: sessionId,
      topic,
      status: "planning",
      currentAgent: "planner",
      steps: [],
    });
    return { sessionId, topic };
  },
});

const addResearchStepTool = defineTool({
  name: "addResearchStep",
  description: "Save a research finding or progress update to the session.",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID from startResearch"),
    type: z.enum(["planning", "searching", "reading", "synthesizing", "complete", "error"]),
    content: z.string().describe("The content or findings for this step"),
    subQuestion: z.string().optional().describe("The sub-question being addressed (for searching/reading steps)"),
    sources: z.array(z.object({ title: z.string(), url: z.string() })).optional().describe("Relevant sources"),
  }),
  execute: async ({ sessionId, type, content, subQuestion, sources }) => {
    const step: ResearchStep = {
      type,
      content,
      timestamp: new Date().toISOString(),
      ...(subQuestion && { subQuestion }),
      ...(sources && { sources }),
    };
    return saveStep(sessionId, step);
  },
});

const completePlanningTool = defineTool({
  name: "completePlanning",
  description: "Signal that the planning phase is done and the session is waiting for human approval before searching begins.",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
  }),
  execute: async ({ sessionId }) => {
    await db.update(researchSessions)
      .set({ status: "planning_paused", currentAgent: "planner" })
      .where(eq(researchSessions.id, sessionId));
    return { success: true, status: "planning_paused", message: "Plan saved. Waiting for user approval to start searching." };
  },
});

const pauseResearchTool = defineTool({
  name: "pauseResearch",
  description: "Pause mid-research to ask the user if the direction is correct before continuing with remaining sub-questions.",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
  }),
  execute: async ({ sessionId }) => {
    await db.update(researchSessions)
      .set({ status: "search_paused", currentAgent: "searcher" })
      .where(eq(researchSessions.id, sessionId));
    return { success: true, status: "search_paused", message: "Mid-research pause. Waiting for user to continue." };
  },
});

const completeSearchingTool = defineTool({
  name: "completeSearching",
  description: "Signal that all sub-questions have been researched and the session is ready for synthesis.",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
  }),
  execute: async ({ sessionId }) => {
    await db.update(researchSessions)
      .set({ status: "synthesis_ready", currentAgent: "synthesizer" })
      .where(eq(researchSessions.id, sessionId));
    return { success: true, status: "synthesis_ready", message: "Research complete. Ready for synthesis." };
  },
});

const getResearchSessionTool = defineTool({
  name: "getResearchSession",
  description: "Get the current state of a research session including all steps.",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
  }),
  execute: async ({ sessionId }) => {
    const session = await db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
    if (!session[0]) throw new Error(`Session ${sessionId} not found`);
    const steps = (session[0].steps as ResearchStep[]) || [];
    const planStep = steps.find((s) => s.type === "planning");
    return {
      id: session[0].id,
      topic: session[0].topic,
      status: session[0].status,
      currentAgent: session[0].currentAgent,
      stepCount: steps.length,
      planContent: planStep?.content || null,
      steps: steps.map((s) => ({ type: s.type, subQuestion: s.subQuestion, timestamp: s.timestamp })),
    };
  },
});

let cachedRuntime: CopilotRuntime | null = null;
let cachedHandler: ReturnType<typeof copilotRuntimeNodeHttpEndpoint> | null = null;

export async function initializeRuntime(): Promise<void> {
  // Pre-load agent configs from GCP before the first request arrives
  await loadAllAgents();
  cachedRuntime = buildRuntime();
  cachedHandler = copilotRuntimeNodeHttpEndpoint({ endpoint: COPILOTKIT_PATH, runtime: cachedRuntime });
}

function buildRuntime(): CopilotRuntime {
  const model = createVertexModel();

  const plannerCfg   = getAgentConfig("planner");
  const searcherCfg  = getAgentConfig("searcher");
  const synthesizerCfg = getAgentConfig("synthesizer");

  const sourceTag = (role: string, cfg: typeof plannerCfg) =>
    cfg ? ` [v${cfg.version}, src=${cfg.source}, id=${cfg.agentId}]` : " [no config]";

  console.log(`[Runtime] planner${sourceTag("planner", plannerCfg)}`);
  console.log(`[Runtime] searcher${sourceTag("searcher", searcherCfg)}`);
  console.log(`[Runtime] synthesizer${sourceTag("synthesizer", synthesizerCfg)}`);

  const plannerAgent = new BuiltInAgent({
    model,
    prompt: plannerCfg?.systemPrompt ?? "",
    tools: [startResearchTool, addResearchStepTool, completePlanningTool],
    maxSteps: 10,
  });

  const searcherAgent = new BuiltInAgent({
    model,
    prompt: searcherCfg?.systemPrompt ?? "",
    tools: [addResearchStepTool, pauseResearchTool, completeSearchingTool, getResearchSessionTool],
    maxSteps: 20,
  });

  const synthesizerAgent = new BuiltInAgent({
    model,
    prompt: synthesizerCfg?.systemPrompt ?? "",
    tools: [addResearchStepTool, getResearchSessionTool],
    maxSteps: 10,
  });

  const runtime = new CopilotRuntime({
    agents: {
      planner: plannerAgent,
      searcher: searcherAgent,
      synthesizer: synthesizerAgent,
    },
  });

  console.log("CopilotKit runtime initialized with 3 agents: planner, searcher, synthesizer");
  return runtime;
}

/** Called after a successful /api/agents/reload — rebuilds runtime with fresh prompts. */
export function rebuildRuntime(): void {
  console.log("[Runtime] Rebuilding runtime with reloaded GCP configs...");
  cachedRuntime = buildRuntime();
  cachedHandler = copilotRuntimeNodeHttpEndpoint({ endpoint: COPILOTKIT_PATH, runtime: cachedRuntime });
}

function getHandler(): ReturnType<typeof copilotRuntimeNodeHttpEndpoint> {
  if (!cachedHandler) {
    // Synchronous fallback: build with whatever is in the GCP cache (may be YAML fallbacks)
    if (!cachedRuntime) cachedRuntime = buildRuntime();
    cachedHandler = copilotRuntimeNodeHttpEndpoint({ endpoint: COPILOTKIT_PATH, runtime: cachedRuntime });
  }
  return cachedHandler;
}

const COPILOTKIT_PATH = "/api/copilotkit";

export function registerCopilotKitRoute(app: Express) {
  app.use(COPILOTKIT_PATH, (req, res) => {
    const originalUrl = req.url;
    const restoredUrl = COPILOTKIT_PATH + (originalUrl === "/" ? "" : originalUrl);
    console.log(`[CK] ${req.method} ${restoredUrl} body.method=${(req.body as Record<string, unknown>)?.method ?? "n/a"}`);
    req.url = restoredUrl;
    getHandler()(req, res);
  });
}

export function registerCopilotKitInfoRoute(app: Express) {
  app.get(`${COPILOTKIT_PATH}/info`, (_req, res) => {
    const plannerCfg     = getAgentConfig("planner");
    const searcherCfg    = getAgentConfig("searcher");
    const synthesizerCfg = getAgentConfig("synthesizer");

    res.json({
      version: "1.54.0",
      agents: {
        planner: {
          name: "planner",
          description: plannerCfg?.displayName ?? "Plans research into focused sub-questions",
          gcpAgentId: plannerCfg?.agentId,
          gcpResourceName: plannerCfg?.gcpResourceName,
          configSource: plannerCfg?.source ?? "unknown",
          className: "BuiltInAgent",
        },
        searcher: {
          name: "searcher",
          description: searcherCfg?.displayName ?? "Investigates each sub-question in depth",
          gcpAgentId: searcherCfg?.agentId,
          gcpResourceName: searcherCfg?.gcpResourceName,
          configSource: searcherCfg?.source ?? "unknown",
          className: "BuiltInAgent",
        },
        synthesizer: {
          name: "synthesizer",
          description: synthesizerCfg?.displayName ?? "Synthesizes all findings into a final report",
          gcpAgentId: synthesizerCfg?.agentId,
          gcpResourceName: synthesizerCfg?.gcpResourceName,
          configSource: synthesizerCfg?.source ?? "unknown",
          className: "BuiltInAgent",
        },
      },
      audioFileTranscriptionEnabled: false,
      a2uiEnabled: false,
    });
  });
}
