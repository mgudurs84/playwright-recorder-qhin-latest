import { GoogleAuth } from "google-auth-library";
import { writeFileSync } from "fs";

const PROJECT = "vertex-ai-demo-468112";
const LOCATION = "us-central1";
const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;

const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON!);
const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function getToken() {
  const client = await auth.getClient();
  return (await client.getAccessToken()).token!;
}

async function apiFetch(method: string, path: string, body?: object) {
  const token = await getToken();
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function pollOperation(opName: string, maxWaitMs = 120_000) {
  const start = Date.now();
  // opName is like "projects/.../locations/.../reasoningEngines/.../operations/..."
  // The full URL needs /v1/ prefixed
  const opUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/${opName}`;
  while (Date.now() - start < maxWaitMs) {
    const op = await apiFetch("GET", opUrl);
    if (op.done) {
      if (op.error) throw new Error(`Operation failed: ${JSON.stringify(op.error)}`);
      return op.response;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("Operation timed out");
}

async function deleteTestAgent() {
  console.log("Cleaning up test agent...");
  try {
    const list = await apiFetch("GET", "/reasoningEngines");
    const test = (list.reasoningEngines || []).find((e: any) => e.displayName.includes("[TEST]"));
    if (test) {
      // test.name is "projects/.../reasoningEngines/ID" — use it directly as path suffix
      const resourcePath = test.name; // already in "projects/..." format
      await apiFetch("DELETE", `https://${LOCATION}-aiplatform.googleapis.com/v1/${resourcePath}`);
      console.log(`  Deleted: ${test.displayName}`);
    } else {
      console.log("  No test agent found");
    }
  } catch (e: any) {
    console.warn("  Could not delete test agent:", e.message);
  }
}

const agentDefs = [
  {
    key: "planner",
    displayName: "AutoResearch Planner",
    description:
      "Planning specialist in the AutoResearch pipeline. Breaks a research topic into 3-4 focused, non-overlapping sub-questions ordered logically from foundational to advanced. Produces an explicit research plan and pauses for human approval before any information gathering begins.",
    systemPrompt: `You are the Planning specialist in the AutoResearch pipeline.

Given a research topic, your job is to:
1. Understand the scope and context of what the user wants to know
2. Decompose the topic into 3-4 focused, non-overlapping sub-questions
3. Order the sub-questions logically (foundational → advanced)
4. Briefly explain why each sub-question matters

Output format:
- A short summary of your research approach (2-3 sentences)
- A numbered list of sub-questions
- Estimated depth level: surface / intermediate / deep

STOP after presenting the plan — wait for human approval before any searching begins.`,
    methods: [
      {
        name: "plan",
        description: "Generate a structured research plan with 3-4 sub-questions for a given topic",
        parameters: {
          type: "object",
          required: ["topic"],
          properties: {
            topic: { type: "string", description: "The research topic or question" },
            depth: { type: "string", enum: ["surface", "intermediate", "deep"], description: "Desired research depth" },
          },
        },
      },
    ],
  },
  {
    key: "searcher",
    displayName: "AutoResearch Searcher",
    description:
      "Search specialist in the AutoResearch pipeline. Investigates each sub-question from the approved plan, gathering findings, data points, examples, conflicting viewpoints, and relevant sources. Pauses for human feedback after the first two sub-questions.",
    systemPrompt: `You are the Search specialist in the AutoResearch pipeline.

For each sub-question you are given:
1. Clearly state what angle you are researching
2. Share the key findings you discover
3. Include specific examples, data points, or quotes where possible
4. Note any conflicting viewpoints or uncertainties
5. List relevant sources (with URLs where you know them)

Be thorough but focused — stay on the specific sub-question.
After sub-questions 1 and 2, PAUSE and ask the user if the direction looks right before continuing.`,
    methods: [
      {
        name: "search",
        description: "Research a specific sub-question and return findings with sources",
        parameters: {
          type: "object",
          required: ["subQuestion", "sessionId"],
          properties: {
            subQuestion: { type: "string", description: "The sub-question to research" },
            sessionId: { type: "string", description: "The research session ID" },
            context: { type: "string", description: "Context from the research plan" },
          },
        },
      },
    ],
  },
  {
    key: "synthesizer",
    displayName: "AutoResearch Synthesizer",
    description:
      "Synthesis specialist in the AutoResearch pipeline. Integrates all research findings into a coherent, comprehensive Markdown report with executive summary, thematic sections, key takeaways, areas for further research, and sources.",
    systemPrompt: `You are the Synthesis specialist in the AutoResearch pipeline.

Given all the sub-question findings, your job is to:
1. Identify the most important themes and insights across all findings
2. Reconcile any conflicting information
3. Draw connections between different sub-questions
4. Write a comprehensive, well-structured Markdown report

Report structure:
## Executive Summary
A 3-5 sentence overview of the key findings.

## [Topic Section 1]
Detailed findings for the first major theme.

## [Topic Section 2]  
Detailed findings for the second major theme.

(continue as needed)

## Key Takeaways
- Bullet points of the most important insights

## Areas for Further Research
What important questions remain unanswered?

## Sources
Full list of sources referenced.

Use clear, accessible language. Use tables, bullet points, and code blocks where appropriate.`,
    methods: [
      {
        name: "synthesize",
        description: "Generate a comprehensive Markdown research report from all session findings",
        parameters: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", description: "The research session ID with all findings" },
            reportLength: { type: "string", enum: ["brief", "comprehensive", "exhaustive"], description: "Desired report length" },
          },
        },
      },
    ],
  },
];

async function createAgent(def: typeof agentDefs[0]) {
  console.log(`\nCreating: ${def.displayName} ...`);

  const op = await apiFetch("POST", "/reasoningEngines", {
    displayName: def.displayName,
    description: def.description,
    spec: {
      classMethods: def.methods.map((m) => ({
        name: m.name,
        description: m.description,
        parameters: m.parameters,
      })),
    },
  });

  // op.name is like "projects/.../reasoningEngines/ID/operations/OP_ID"
  const opResourceName: string = op.name;
  process.stdout.write("  Waiting for creation");
  const result = await pollOperation(opResourceName);
  console.log(" done!");

  // Derive the agent resource name by stripping the /operations/... suffix
  const agentName: string = result?.name ?? opResourceName.replace(/\/operations\/[^/]+$/, "");
  const agentId = agentName.split("/").pop()!;
  console.log(`  ✓ Agent ID: ${agentId}`);
  console.log(`  ✓ Full name: ${agentName}`);

  return { key: def.key, displayName: def.displayName, agentId, agentName };
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Creating 3 AutoResearch agents in GCP project: ${PROJECT}`);
  console.log(`Service: Vertex AI Agent Engine (Reasoning Engine)`);
  console.log(`Location: ${LOCATION}`);
  console.log(`${"=".repeat(60)}`);

  await deleteTestAgent();

  const results: Array<{ key: string; displayName: string; agentId: string; agentName: string }> = [];

  for (const def of agentDefs) {
    const result = await createAgent(def);
    results.push(result);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("✅  All 3 agents created successfully!\n");

  console.log("Environment variables to add:");
  results.forEach((r) => {
    console.log(`  GCP_AGENT_${r.key.toUpperCase()}="${r.agentId}"`);
  });

  const out: Record<string, { agentId: string; agentName: string; displayName: string }> = {};
  results.forEach((r) => {
    out[r.key] = { agentId: r.agentId, agentName: r.agentName, displayName: r.displayName };
  });

  const outPath = new URL("../../gcp-agents.json", import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nAgent details saved to: ${outPath}`);
  console.log("\nView in GCP Console:");
  console.log(`  https://console.cloud.google.com/vertex-ai/reasoning-engines?project=${PROJECT}`);
}

main().catch((err) => { console.error("\n✗ Fatal:", err.message); process.exit(1); });
