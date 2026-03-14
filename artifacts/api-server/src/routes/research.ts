import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { db, researchSessions } from "@workspace/db";
import type { ResearchStep, ResearchSource } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { StartResearchBody } from "@workspace/api-zod";

const router: IRouter = Router();

const sessionEmitters = new Map<string, EventEmitter>();

function getOrCreateEmitter(sessionId: string): EventEmitter {
  if (!sessionEmitters.has(sessionId)) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    sessionEmitters.set(sessionId, emitter);
  }
  return sessionEmitters.get(sessionId)!;
}

async function addStep(sessionId: string, step: ResearchStep) {
  const session = await db
    .select()
    .from(researchSessions)
    .where(eq(researchSessions.id, sessionId))
    .limit(1);

  if (!session[0]) return;

  const currentSteps = (session[0].steps as ResearchStep[]) || [];
  const updatedSteps = [...currentSteps, step];

  await db
    .update(researchSessions)
    .set({ steps: updatedSteps })
    .where(eq(researchSessions.id, sessionId));

  const emitter = sessionEmitters.get(sessionId);
  if (emitter) {
    emitter.emit("step", step);
  }
}

async function runResearch(sessionId: string, topic: string) {
  try {
    await db
      .update(researchSessions)
      .set({ status: "running" })
      .where(eq(researchSessions.id, sessionId));

    await addStep(sessionId, {
      type: "planning",
      content: `Breaking down "${topic}" into focused sub-questions...`,
      timestamp: new Date().toISOString(),
    });

    const planningResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a research assistant. When given a research topic, break it down into 3-4 specific, focused sub-questions that together would provide comprehensive coverage of the topic. Return ONLY a JSON array of strings, no explanation.",
        },
        {
          role: "user",
          content: `Topic: ${topic}\n\nProvide 3-4 focused sub-questions as a JSON array of strings.`,
        },
      ],
    });

    const planningText = planningResponse.choices[0]?.message?.content || "[]";
    let subQuestions: string[] = [];
    try {
      const jsonMatch = planningText.match(/\[[\s\S]*\]/);
      subQuestions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      subQuestions = [topic];
    }

    if (subQuestions.length === 0) subQuestions = [topic];

    await addStep(sessionId, {
      type: "planning",
      content: `Identified ${subQuestions.length} research angles:\n${subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      timestamp: new Date().toISOString(),
    });

    const subAnswers: { question: string; answer: string; sources: ResearchSource[] }[] = [];

    for (const subQuestion of subQuestions) {
      await addStep(sessionId, {
        type: "searching",
        subQuestion,
        content: `Searching for information about: "${subQuestion}"`,
        timestamp: new Date().toISOString(),
      });

      const searchResponse = await openai.chat.completions.create({
        model: "gpt-5.2",
        max_completion_tokens: 2048,
        messages: [
          {
            role: "system",
            content: `You are a research expert. Answer the research question comprehensively. Also suggest 2-3 real, credible sources (websites, papers, articles) that would be relevant. Return your response as JSON with this structure:
{
  "answer": "your detailed answer here",
  "sources": [
    { "title": "Source Title", "url": "https://example.com" }
  ]
}`,
          },
          {
            role: "user",
            content: `Research question: ${subQuestion}\n\nContext: This is part of research on the broader topic: "${topic}"`,
          },
        ],
      });

      const searchText = searchResponse.choices[0]?.message?.content || "{}";
      let answer = "";
      let sources: ResearchSource[] = [];
      try {
        const jsonMatch = searchText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          answer = parsed.answer || searchText;
          sources = parsed.sources || [];
        } else {
          answer = searchText;
        }
      } catch {
        answer = searchText;
      }

      subAnswers.push({ question: subQuestion, answer, sources });

      await addStep(sessionId, {
        type: "reading",
        subQuestion,
        content: answer,
        sources,
        timestamp: new Date().toISOString(),
      });
    }

    await addStep(sessionId, {
      type: "synthesizing",
      content: "Synthesizing all findings into a comprehensive report...",
      timestamp: new Date().toISOString(),
    });

    const synthesisContent = subAnswers
      .map((sa) => `## ${sa.question}\n\n${sa.answer}`)
      .join("\n\n");

    const synthesisResponse = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      messages: [
        {
          role: "system",
          content:
            "You are a research writer. Synthesize the following research findings into a well-structured, comprehensive markdown report. Include an executive summary, key findings, and a conclusion. Use proper markdown headers, bullet points, and formatting.",
        },
        {
          role: "user",
          content: `Topic: ${topic}\n\nResearch Findings:\n\n${synthesisContent}`,
        },
      ],
    });

    const report =
      synthesisResponse.choices[0]?.message?.content ||
      "Unable to generate report.";

    await db
      .update(researchSessions)
      .set({
        status: "complete",
        report,
        completedAt: new Date(),
      })
      .where(eq(researchSessions.id, sessionId));

    await addStep(sessionId, {
      type: "complete",
      content: report,
      timestamp: new Date().toISOString(),
    });

    const emitter = sessionEmitters.get(sessionId);
    if (emitter) {
      emitter.emit("done");
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await db
      .update(researchSessions)
      .set({ status: "error" })
      .where(eq(researchSessions.id, sessionId));

    await addStep(sessionId, {
      type: "error",
      content: `Research failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
    });

    const emitter = sessionEmitters.get(sessionId);
    if (emitter) {
      emitter.emit("done");
    }
  } finally {
    setTimeout(() => {
      sessionEmitters.delete(sessionId);
    }, 60000);
  }
}

router.post("/start", async (req, res) => {
  const parsed = StartResearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { topic } = parsed.data;
  const sessionId = randomUUID();

  await db.insert(researchSessions).values({
    id: sessionId,
    topic,
    status: "pending",
    steps: [],
  });

  runResearch(sessionId, topic).catch(console.error);

  res.json({ sessionId, topic });
});

router.get("/sessions", async (_req, res) => {
  const sessions = await db
    .select()
    .from(researchSessions)
    .orderBy(desc(researchSessions.createdAt))
    .limit(50);

  const formatted = sessions.map((s) => ({
    id: s.id,
    topic: s.topic,
    status: s.status,
    steps: s.steps || [],
    report: s.report || undefined,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() || undefined,
  }));

  res.json({ sessions: formatted });
});

router.get("/sessions/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = await db
    .select()
    .from(researchSessions)
    .where(eq(researchSessions.id, sessionId))
    .limit(1);

  if (!session[0]) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const s = session[0];
  res.json({
    id: s.id,
    topic: s.topic,
    status: s.status,
    steps: s.steps || [],
    report: s.report || undefined,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() || undefined,
  });
});

router.get("/:sessionId/stream", async (req, res) => {
  const { sessionId } = req.params;

  const session = await db
    .select()
    .from(researchSessions)
    .where(eq(researchSessions.id, sessionId))
    .limit(1);

  if (!session[0]) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const existingSteps = (session[0].steps as ResearchStep[]) || [];
  for (const step of existingSteps) {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  }

  if (session[0].status === "complete" || session[0].status === "error") {
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
    return;
  }

  const emitter = getOrCreateEmitter(sessionId);

  const onStep = (step: ResearchStep) => {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  };

  const onDone = () => {
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  };

  emitter.on("step", onStep);
  emitter.on("done", onDone);

  req.on("close", () => {
    emitter.off("step", onStep);
    emitter.off("done", onDone);
  });
});

export default router;
