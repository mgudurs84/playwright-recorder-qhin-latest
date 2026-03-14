/**
 * One-time script: push full system prompts from YAML skill files into the GCP
 * Vertex AI Reasoning Engine descriptions. After this runs, the GCP agents are
 * the source of truth — edit the description JSON in GCP console to update prompts.
 */
import { GoogleAuth } from "google-auth-library";
import { buildPlannerPrompt, buildSearcherPrompt, buildSynthesizerPrompt } from "./skills/loader";

const PROJECT = "vertex-ai-demo-468112";
const LOCATION = "us-central1";
const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;

const GCP_AGENTS: Record<string, { id: string; promptBuilder: () => string; displayName: string }> = {
  planner:     { id: process.env.GCP_AGENT_PLANNER     || "2955468563764215808", promptBuilder: buildPlannerPrompt,     displayName: "AutoResearch Planner" },
  searcher:    { id: process.env.GCP_AGENT_SEARCHER    || "3132797799091929088", promptBuilder: buildSearcherPrompt,    displayName: "AutoResearch Searcher" },
  synthesizer: { id: process.env.GCP_AGENT_SYNTHESIZER || "7777134914817753088", promptBuilder: buildSynthesizerPrompt, displayName: "AutoResearch Synthesizer" },
};

const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON!);
const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

async function getToken() {
  const client = await auth.getClient();
  return (await client.getAccessToken()).token!;
}

async function updateAgent(role: string, def: typeof GCP_AGENTS[string]) {
  const token = await getToken();
  const systemPrompt = def.promptBuilder();
  
  const metadata = JSON.stringify({
    version: "1.1",
    role,
    systemPrompt,
    updatedAt: new Date().toISOString(),
    source: "autoresearch-yaml-skills",
  });

  const url = `${BASE}/reasoningEngines/${def.id}?updateMask=description`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description: metadata }),
  });

  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}: ${await res.text()}`);
  const op = await res.json() as Record<string, unknown>;
  console.log(`  ✓ ${def.displayName}: pushed ${systemPrompt.length} chars`);
  console.log(`    Operation: ${String(op.name).split("/").pop()}`);
  return op;
}

async function main() {
  console.log(`\nPushing system prompts to GCP Vertex AI Agent Engine`);
  console.log(`Project: ${PROJECT}  Location: ${LOCATION}`);
  console.log("=".repeat(60));

  for (const [role, def] of Object.entries(GCP_AGENTS)) {
    console.log(`\n[${role}] Agent ID: ${def.id}`);
    try {
      await updateAgent(role, def);
    } catch (err: unknown) {
      console.error(`  ✗ ${role}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅  All system prompts pushed to GCP successfully!");
  console.log("\nGCP Console (view/edit agents):");
  console.log(`  https://console.cloud.google.com/vertex-ai/reasoning-engines?project=${PROJECT}`);
  console.log("\nThe backend will now load prompts FROM GCP at startup (with YAML fallback).");
}

main().catch((err) => { console.error("\n✗ Fatal:", err.message); process.exit(1); });
