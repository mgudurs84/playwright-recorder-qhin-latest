import fs from "fs";
import path from "path";
import os from "os";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import { getPlaywrightService } from "./playwright-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CwTransactionRecord = Record<string, any>;

export interface PerTypeStat {
  type: string;
  total: number;
  downloads: number;
  errors: number;
  errorRate: number;
}

export interface HourlySnapshot {
  id: string;
  trigger: "scheduled" | "manual";
  status: "running" | "complete" | "error" | "auth_required";
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  totalRecords: number;
  downloadCount: number;
  errorCount: number;
  perTypeStats: PerTypeStat[];
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

const DATA_FILE = path.join(process.cwd(), "data", "hourly-snapshots.json");
const MAX_ENTRIES = 168;

function ensureDataDir(): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadSnapshots(): HourlySnapshot[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw) as HourlySnapshot[];
  } catch {
    return [];
  }
}

export function saveSnapshots(list: HourlySnapshot[]): void {
  ensureDataDir();
  const trimmed = list.slice(0, MAX_ENTRIES);
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

export function upsertSnapshot(snap: HourlySnapshot): void {
  const list = loadSnapshots();
  const idx = list.findIndex((s) => s.id === snap.id);
  if (idx >= 0) {
    list[idx] = snap;
  } else {
    list.unshift(snap);
  }
  saveSnapshots(list);
}

function isError(r: CwTransactionRecord): boolean {
  const s = (r.status ?? r.Status ?? "").toLowerCase();
  return s.includes("error") || s.includes("fail");
}

export function buildPerTypeStats(records: CwTransactionRecord[]): PerTypeStat[] {
  const map = new Map<string, { downloads: number; errors: number }>();

  for (const r of records) {
    const type = r.transaction_type ?? r["Transaction Type"] ?? r.transactionType ?? "Unknown";
    if (!map.has(type)) map.set(type, { downloads: 0, errors: 0 });
    const entry = map.get(type)!;
    if (isError(r)) {
      entry.errors += 1;
    } else {
      entry.downloads += 1;
    }
  }

  const stats: PerTypeStat[] = [];
  for (const [type, { downloads, errors }] of map.entries()) {
    const total = downloads + errors;
    stats.push({
      type,
      total,
      downloads,
      errors,
      errorRate: total > 0 ? Math.round((errors / total) * 10000) / 100 : 0,
    });
  }

  return stats.sort((a, b) => b.errors - a.errors);
}

function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GCP_SERVICE_ACCOUNT_JSON not set");
  const serviceAccount = JSON.parse(serviceAccountJson) as { project_id: string; private_key?: string };
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  const vertex = createVertex({
    project: serviceAccount.project_id,
    location: "us-central1",
    googleAuthOptions: { credentials: serviceAccount },
  });
  return vertex(process.env.VERTEX_MODEL_ID || "gemini-2.5-flash");
}

export async function generateHourlySummary(
  perTypeStats: PerTypeStat[],
  windowStart: string,
  windowEnd: string,
  prevSnapshot?: HourlySnapshot | null
): Promise<string> {
  const model = createVertexModel();

  const totalRecords = perTypeStats.reduce((s, p) => s + p.total, 0);
  const totalErrors = perTypeStats.reduce((s, p) => s + p.errors, 0);
  const totalDownloads = perTypeStats.reduce((s, p) => s + p.downloads, 0);
  const overallErrorRate = totalRecords > 0
    ? ((totalErrors / totalRecords) * 100).toFixed(1)
    : "0.0";

  const tableRows = perTypeStats
    .map((p) => `| ${p.type} | ${p.downloads} | ${p.errors} | ${p.errorRate}% |`)
    .join("\n");

  const tableHeader = `| Transaction Type | Downloads | Errors | Error Rate |\n|---|---|---|---|\n${tableRows}`;

  const top3 = [...perTypeStats]
    .filter((p) => p.errors > 0)
    .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors)
    .slice(0, 3)
    .map((p) => `  - ${p.type}: ${p.errors} errors (${p.errorRate}% error rate)`)
    .join("\n");

  let trendSection = "";
  if (prevSnapshot) {
    const delta = totalErrors - prevSnapshot.errorCount;
    const sign = delta > 0 ? "+" : "";
    trendSection = `\n## Trend vs Previous Snapshot\n- Previous error count: ${prevSnapshot.errorCount}\n- Current error count: ${totalErrors}\n- Delta: ${sign}${delta} errors\n- Previous window: ${prevSnapshot.windowStart} → ${prevSnapshot.windowEnd}\n`;
  }

  const prompt = `You are a CommonWell Health Alliance CDR monitoring analyst. Generate a concise hourly monitoring summary in markdown.

## Window
- Start: ${windowStart}
- End: ${windowEnd}

## Aggregate Stats
- Total records: ${totalRecords}
- Downloads (success): ${totalDownloads}
- Errors: ${totalErrors}
- Overall error rate: ${overallErrorRate}%

## Per-Transaction-Type Breakdown
${tableHeader}

## Top 3 Worst Transaction Types by Error Rate
${top3 || "  (none)"}
${trendSection}
---

Generate a concise monitoring summary with these sections:
1. **Window Summary** — what was observed, total transactions, error rate
2. **Error Breakdown** — highlight transaction types with high error rates
3. **Key Findings** — notable patterns or concerns
4. **Recommended Next Steps** — 1-3 actionable items

Use markdown tables where helpful. Be concise and data-driven.`;

  const { text } = await generateText({
    model,
    prompt,
    maxTokens: 2048,
  });

  return text;
}

export async function runHourlyCapture(opts: {
  id?: string;
  windowHours?: number;
  trigger: "scheduled" | "manual";
}): Promise<string> {
  const windowHours = opts.windowHours ?? 1;
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();

  const id = opts.id ?? Date.now().toString();
  const snap: HourlySnapshot = {
    id,
    trigger: opts.trigger,
    status: "running",
    windowHours,
    windowStart,
    windowEnd,
    totalRecords: 0,
    downloadCount: 0,
    errorCount: 0,
    perTypeStats: [],
    summary: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    completedAt: null,
  };
  upsertSnapshot(snap);

  const username = process.env.CW_USERNAME;
  const password = process.env.CW_PASSWORD;

  if (!username || !password) {
    snap.status = "error";
    snap.errorMessage = "CW_USERNAME or CW_PASSWORD not set";
    snap.completedAt = new Date().toISOString();
    upsertSnapshot(snap);
    console.error("[Hourly Monitor] Missing credentials");
    return id;
  }

  try {
    const pw = getPlaywrightService();
    const { needsOtp } = await pw.login(username, password);

    if (needsOtp) {
      console.warn("[Hourly Monitor] OTP required — session expired. Marking auth_required.");
      snap.status = "auth_required";
      snap.completedAt = new Date().toISOString();
      upsertSnapshot(snap);
      return id;
    }

    console.log(`[Hourly Monitor] Navigating to transaction logs (window: ${windowHours}h)...`);
    await pw.navigateToTransactionLogs();
    // Always use at least 1 day for the portal filter, then post-filter to the exact window
    const daysBack = Math.max(1, Math.ceil(windowHours / 24));
    await pw.applyDateFilter(daysBack);

    console.log("[Hourly Monitor] Extracting all transactions...");
    const { records: allRecords } = await pw.extractTransactions(0);

    // Post-filter to the exact window [windowStart, windowEnd]
    const windowStartMs = new Date(windowStart).getTime();
    const windowEndMs = new Date(windowEnd).getTime();
    const records = allRecords.filter((r) => {
      const ts = r.timestamp ?? r.Timestamp ?? r.created_at ?? r.createdAt ?? "";
      if (!ts) return true; // keep if no timestamp (cannot filter)
      const t = new Date(ts).getTime();
      return !isNaN(t) && t >= windowStartMs && t <= windowEndMs;
    });

    console.log(
      `[Hourly Monitor] Extracted ${allRecords.length} raw records, ${records.length} within window (${windowHours}h)`
    );

    const totalRecords = records.length;
    const errorCount = records.filter(isError).length;
    const downloadCount = totalRecords - errorCount;
    const perTypeStats = buildPerTypeStats(records);

    console.log(`[Hourly Monitor] Snapshot stats — ${totalRecords} records, ${errorCount} errors`);

    const snapshots = loadSnapshots();
    const prev = snapshots.find((s) => s.status === "complete" && s.id !== id) ?? null;

    let summary: string | null = null;
    try {
      summary = await generateHourlySummary(perTypeStats, windowStart, windowEnd, prev);
    } catch (summaryErr) {
      console.warn("[Hourly Monitor] Summary generation failed (skipped):", (summaryErr as Error).message);
    }

    snap.status = "complete";
    snap.totalRecords = totalRecords;
    snap.downloadCount = downloadCount;
    snap.errorCount = errorCount;
    snap.perTypeStats = perTypeStats;
    snap.summary = summary;
    snap.completedAt = new Date().toISOString();
    upsertSnapshot(snap);

    console.log(`[Hourly Monitor] Snapshot complete — ${totalRecords} records, ${errorCount} errors`);
  } catch (err) {
    snap.status = "error";
    snap.errorMessage = (err as Error).message;
    snap.completedAt = new Date().toISOString();
    upsertSnapshot(snap);
    console.error("[Hourly Monitor] Capture error:", snap.errorMessage);
  }

  return id;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function getNextRunIn(): string {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setMinutes(60, 0, 0);
  const diff = Math.max(0, nextHour.getTime() - now.getTime());
  const totalSeconds = Math.floor(diff / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function msAgo(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

export function getLastSnapshot(): HourlySnapshot | null {
  const list = loadSnapshots();
  return list.find((s) => s.status === "complete" || s.status === "error" || s.status === "auth_required") ?? null;
}

export { msAgo };
