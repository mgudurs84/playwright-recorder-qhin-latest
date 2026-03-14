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
import { buildSystemPrompt } from "../skills/loader";

function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("GCP_SERVICE_ACCOUNT_JSON environment variable is required");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  const vertex = createVertex({
    project: serviceAccount.project_id || "vertex-ai-demo-468112",
    location: "us-central1",
    googleAuthOptions: {
      credentials: serviceAccount,
    },
  });

  const modelId = process.env.VERTEX_MODEL_ID || "gemini-2.5-flash";
  console.log(`Using Vertex AI model: ${modelId}`);
  return vertex(modelId);
}

const startResearchTool = defineTool({
  name: "startResearch",
  description: "Start a new research session on a given topic",
  parameters: z.object({
    topic: z.string().describe("The research topic or question"),
  }),
  execute: async ({ topic }) => {
    const sessionId = randomUUID();
    await db.insert(researchSessions).values({
      id: sessionId,
      topic,
      status: "pending",
      steps: [],
    });
    return { sessionId, topic, message: `Research session started for: "${topic}"` };
  },
});

const addResearchStepTool = defineTool({
  name: "addResearchStep",
  description: "Add a step/finding to an existing research session",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
    type: z.enum(["planning", "searching", "reading", "synthesizing", "complete", "error"]).describe("Step type"),
    content: z.string().describe("The content/findings of this step"),
    subQuestion: z.string().optional().describe("The sub-question being addressed"),
    sources: z.array(z.object({
      title: z.string(),
      url: z.string(),
    })).optional().describe("Relevant sources for this step"),
  }),
  execute: async ({ sessionId, type, content, subQuestion, sources }) => {
    const session = await db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
    if (!session[0]) throw new Error(`Session ${sessionId} not found`);

    const step: ResearchStep = {
      type,
      content,
      timestamp: new Date().toISOString(),
      ...(subQuestion && { subQuestion }),
      ...(sources && { sources }),
    };

    const currentSteps = (session[0].steps as ResearchStep[]) || [];

    let newStatus = session[0].status;
    if (type === "complete") newStatus = "complete";
    else if (type === "error") newStatus = "error";
    else if (session[0].status === "pending") newStatus = "running";

    await db.update(researchSessions).set({
      steps: [...currentSteps, step],
      status: newStatus,
      ...(type === "complete" && { completedAt: new Date(), report: content }),
    }).where(eq(researchSessions.id, sessionId));

    return { success: true, stepAdded: type, sessionId };
  },
});

const getResearchSessionTool = defineTool({
  name: "getResearchSession",
  description: "Get the current state of a research session",
  parameters: z.object({
    sessionId: z.string().describe("The research session ID"),
  }),
  execute: async ({ sessionId }) => {
    const session = await db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
    if (!session[0]) throw new Error(`Session ${sessionId} not found`);
    return {
      id: session[0].id,
      topic: session[0].topic,
      status: session[0].status,
      stepCount: ((session[0].steps as ResearchStep[]) || []).length,
    };
  },
});

const SYSTEM_PROMPT = buildSystemPrompt();

let cachedRuntime: CopilotRuntime | null = null;

function getRuntime(): CopilotRuntime {
  if (!cachedRuntime) {
    const model = createVertexModel();
    const agent = new BuiltInAgent({
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools: [startResearchTool, addResearchStepTool, getResearchSessionTool],
      maxSteps: 20,
    });
    cachedRuntime = new CopilotRuntime({
      agents: { default: agent },
    });
  }
  return cachedRuntime;
}

const COPILOTKIT_PATH = "/api/copilotkit";

export function registerCopilotKitRoute(app: Express) {
  const runtime = getRuntime();
  const handler = copilotRuntimeNodeHttpEndpoint({
    endpoint: COPILOTKIT_PATH,
    runtime,
  });

  app.use(COPILOTKIT_PATH, (req, res) => {
    const originalUrl = req.url;
    req.url = COPILOTKIT_PATH + (originalUrl === "/" ? "" : originalUrl);
    handler(req, res);
  });
}

export function registerCopilotKitInfoRoute(app: Express) {
  app.get(`${COPILOTKIT_PATH}/info`, (_req, res) => {
    res.json({
      version: "1.54.0",
      agents: { default: { name: "default", description: "AutoResearch Agent", className: "BuiltInAgent" } },
      audioFileTranscriptionEnabled: false,
      a2uiEnabled: false,
    });
  });
}
