/**
 * GCP Agent Loader — fetches live agent configurations from Vertex AI Agent Engine.
 * The three AutoResearch reasoning engines are the source of truth for system prompts.
 * Falls back to the local YAML skill files if GCP is unreachable.
 */
import { GoogleAuth } from "google-auth-library";
import { buildPlannerPrompt, buildSearcherPrompt, buildSynthesizerPrompt } from "./loader";

const PROJECT = "vertex-ai-demo-468112";
const LOCATION = "us-central1";
const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1`;

const GCP_AGENTS: Record<string, string> = {
  planner:     process.env.GCP_AGENT_PLANNER     || "2955468563764215808",
  searcher:    process.env.GCP_AGENT_SEARCHER    || "3132797799091929088",
  synthesizer: process.env.GCP_AGENT_SYNTHESIZER || "7777134914817753088",
};

export interface GcpAgentConfig {
  role: string;
  version: string;
  displayName: string;
  systemPrompt: string;
  agentId: string;
  gcpResourceName: string;
  source: "gcp" | "yaml-fallback";
  loadedAt: string;
}

let _cache: Map<string, GcpAgentConfig> = new Map();
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) {
    const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON!);
    _auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  }
  return _auth;
}

async function getToken(): Promise<string> {
  const client = await getAuth().getClient();
  return (await client.getAccessToken()).token!;
}

async function fetchReasoningEngine(agentId: string): Promise<Record<string, unknown>> {
  const token = await getToken();
  const url = `${BASE}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${agentId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GCP fetch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function parseAgentDescription(raw: string | undefined): { version: string; systemPrompt: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.systemPrompt) {
      return { version: String(parsed.version ?? "1.0"), systemPrompt: String(parsed.systemPrompt) };
    }
  } catch {
    // not JSON — treat as plain description, not a system prompt
  }
  return null;
}

const YAML_FALLBACKS: Record<string, () => string> = {
  planner:     buildPlannerPrompt,
  searcher:    buildSearcherPrompt,
  synthesizer: buildSynthesizerPrompt,
};

async function loadAgentFromGcp(role: string): Promise<GcpAgentConfig> {
  const agentId = GCP_AGENTS[role];
  const gcpResourceName = `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${agentId}`;

  try {
    const engine = await fetchReasoningEngine(agentId);
    const parsed = parseAgentDescription(engine.description as string | undefined);
    const displayName = String(engine.displayName ?? role);

    if (parsed?.systemPrompt) {
      return {
        role,
        version: parsed.version,
        displayName,
        systemPrompt: parsed.systemPrompt,
        agentId,
        gcpResourceName,
        source: "gcp",
        loadedAt: new Date().toISOString(),
      };
    }

    // GCP agent exists but has no embedded prompt yet — use YAML and log
    console.warn(`[GcpLoader] ${role}: no systemPrompt in GCP description, using YAML fallback`);
    return {
      role,
      version: "1.0",
      displayName,
      systemPrompt: YAML_FALLBACKS[role]?.() ?? "",
      agentId,
      gcpResourceName,
      source: "yaml-fallback",
      loadedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    console.warn(`[GcpLoader] ${role}: GCP fetch failed (${(err as Error).message}), using YAML fallback`);
    return {
      role,
      version: "1.0",
      displayName: `AutoResearch ${role.charAt(0).toUpperCase() + role.slice(1)}`,
      systemPrompt: YAML_FALLBACKS[role]?.() ?? "",
      agentId,
      gcpResourceName,
      source: "yaml-fallback",
      loadedAt: new Date().toISOString(),
    };
  }
}

export async function loadAllAgents(forceRefresh = false): Promise<Map<string, GcpAgentConfig>> {
  const now = Date.now();
  if (!forceRefresh && _cache.size > 0 && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cache;
  }

  console.log("[GcpLoader] Loading agent configs from Vertex AI Agent Engine...");
  const results = await Promise.all(
    Object.keys(GCP_AGENTS).map((role) => loadAgentFromGcp(role))
  );

  _cache = new Map(results.map((r) => [r.role, r]));
  _cacheTimestamp = now;

  for (const r of results) {
    console.log(`[GcpLoader] ${r.role}: source=${r.source} prompt_chars=${r.systemPrompt.length}`);
  }

  return _cache;
}

export function getAgentConfig(role: string): GcpAgentConfig | null {
  return _cache.get(role) ?? null;
}

export function getCacheStatus(): {
  cacheAge: number;
  ttl: number;
  agents: Array<{ role: string; source: string; agentId: string; promptChars: number; loadedAt: string }>;
} {
  return {
    cacheAge: _cacheTimestamp ? Date.now() - _cacheTimestamp : -1,
    ttl: CACHE_TTL_MS,
    agents: Array.from(_cache.values()).map((a) => ({
      role: a.role,
      source: a.source,
      agentId: a.agentId,
      promptChars: a.systemPrompt.length,
      loadedAt: a.loadedAt,
    })),
  };
}
