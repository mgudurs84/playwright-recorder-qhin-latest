import type { Express } from "express";
import { loadAllAgents, getCacheStatus } from "../skills/gcp-loader";
import { rebuildRuntime } from "./copilotkit";

export function registerAgentsRoute(app: Express) {
  /**
   * GET /api/agents/status
   * Returns the live state of the GCP-loaded agent configs (IDs, prompt sizes, cache age).
   */
  app.get("/api/agents/status", (_req, res) => {
    const status = getCacheStatus();
    res.json({
      gcpProject: "vertex-ai-demo-468112",
      gcpLocation: "us-central1",
      gcpConsoleUrl: "https://console.cloud.google.com/vertex-ai/reasoning-engines?project=vertex-ai-demo-468112",
      cacheAgeMs: status.cacheAge,
      cacheTtlMs: status.ttl,
      agents: status.agents,
    });
  });

  /**
   * POST /api/agents/reload
   * Force-reloads all agent configs from GCP (bypasses the 5-minute cache).
   * Also rebuilds the CopilotKit runtime so new prompts take effect immediately.
   * Useful after editing an agent description in the GCP console.
   */
  app.post("/api/agents/reload", async (_req, res) => {
    try {
      console.log("[AgentsRoute] Force-reloading agent configs from GCP...");
      const agents = await loadAllAgents(true);
      rebuildRuntime();

      const configs = Array.from(agents.values()).map((a) => ({
        role: a.role,
        displayName: a.displayName,
        source: a.source,
        agentId: a.agentId,
        promptChars: a.systemPrompt.length,
        version: a.version,
        loadedAt: a.loadedAt,
      }));

      console.log("[AgentsRoute] Reload + runtime rebuild complete.");
      res.json({ success: true, reloadedAt: new Date().toISOString(), agents: configs });
    } catch (err: unknown) {
      console.error("[AgentsRoute] Reload failed:", err);
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
}
