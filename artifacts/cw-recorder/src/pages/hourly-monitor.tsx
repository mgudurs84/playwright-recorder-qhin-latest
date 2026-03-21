import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
  BarChart3, Lightbulb, ArrowRight, Sparkles, ChevronDown, ChevronRight,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl } from "@/lib/utils";

interface PerTypeStat {
  type: string;
  total: number;
  downloads: number;
  errors: number;
  errorRate: number;
}

interface HourlySnapshot {
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

interface StatusResponse {
  nextRunIn: string;
  lastSnapshot: HourlySnapshot | null;
}

interface SnapshotsResponse {
  snapshots: HourlySnapshot[];
}

const SECTION_DEFS: {
  match: RegExp;
  icon: typeof AlertTriangle;
  label: string;
  color: string;
  border: string;
  bg: string;
}[] = [
  { match: /window|summary/i,    icon: AlertTriangle, label: "Window Summary",        color: "text-red-400",     border: "border-red-500/25",     bg: "bg-red-500/5"     },
  { match: /breakdown|error/i,   icon: BarChart3,     label: "Error Breakdown",       color: "text-orange-400",  border: "border-orange-500/25",  bg: "bg-orange-500/5"  },
  { match: /finding|insight/i,   icon: Lightbulb,     label: "Key Findings",          color: "text-yellow-400",  border: "border-yellow-500/25",  bg: "bg-yellow-500/5"  },
  { match: /next step|recommend/i,icon: ArrowRight,   label: "Recommended Next Steps",color: "text-emerald-400", border: "border-emerald-500/25", bg: "bg-emerald-500/5" },
];

function parseSections(text: string) {
  const chunks = text.split(/^#{1,3} .+$/m).filter((_, i) => i > 0);
  const headings = [...text.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]);
  return headings.map((heading, i) => {
    const bodyLines = (chunks[i] ?? "").split("\n").filter((l) => l !== undefined);
    const def = SECTION_DEFS.find((d) => d.match.test(heading)) ?? {
      icon: Sparkles,
      label: heading.replace(/^[^\w]+/, "").trim(),
      color: "text-violet-400",
      border: "border-violet-500/25",
      bg: "bg-violet-500/5",
    };
    return { heading, bodyLines, def };
  });
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`rounded animate-pulse bg-white/8 ${className ?? ""}`} />;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return <code key={i} className="font-mono text-[10px] bg-white/8 px-1 rounded">{p.slice(1, -1)}</code>;
    return p;
  });
}

function SectionBody({ lines }: { lines: string[] }) {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const tableLines = nonEmpty.filter((l) => l.trim().startsWith("|"));
  const textLines = nonEmpty.filter((l) => !l.trim().startsWith("|"));

  return (
    <div className="space-y-1">
      {tableLines.length > 1 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse">
            <tbody>
              {tableLines
                .filter((l) => !l.match(/^\|\s*[-:]+\s*\|/))
                .map((row, i) => {
                  const cells = row.split("|").filter((_, ci) => ci > 0 && ci < row.split("|").length - 1);
                  const isHeader = i === 0;
                  return (
                    <tr key={i} className={isHeader ? "border-b border-white/10" : ""}>
                      {cells.map((cell, ci) => (
                        <td
                          key={ci}
                          className={`px-2 py-1 ${isHeader ? "font-semibold text-muted-foreground/80" : "text-muted-foreground"}`}
                        >
                          {renderInline(cell.trim())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {textLines.map((line, i) => {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <p key={i} className="text-[11px] text-muted-foreground flex gap-1.5">
              <span className="mt-1.5 w-1 h-1 rounded-full bg-muted-foreground/50 shrink-0" />
              <span>{renderInline(line.slice(2))}</span>
            </p>
          );
        }
        return (
          <p key={i} className="text-[11px] text-muted-foreground leading-relaxed">
            {renderInline(line)}
          </p>
        );
      })}
    </div>
  );
}

function AiSummaryPanel({ summary, pending }: { summary: string | null; pending: boolean }) {
  if (!pending && !summary) return null;
  const sections = summary ? parseSections(summary) : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-violet-500/20 bg-[#0f0a1e] overflow-hidden"
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-violet-500/15">
        <div className="w-6 h-6 rounded-md bg-violet-500/15 border border-violet-500/30 flex items-center justify-center shrink-0">
          <Sparkles className="w-3 h-3 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-violet-300 leading-none mb-0.5">Vertex AI · Hourly Summary</p>
          <p className="text-[10px] text-muted-foreground/60 leading-none">Gemini 2.5 Flash</p>
        </div>
        {pending && <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin shrink-0" />}
        {!pending && summary && (
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            Done
          </span>
        )}
      </div>
      <div className="p-3 space-y-2">
        {pending && !summary && (
          <>
            {[80, 60, 90, 50, 70].map((w, i) => (
              <div key={i} className="rounded-lg border border-white/6 bg-white/[0.02] p-3 space-y-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className={`h-2.5 w-[${w}%]`} />
                <Skeleton className="h-2.5 w-3/4" />
              </div>
            ))}
          </>
        )}
        {sections.length > 0 &&
          sections.map(({ heading, bodyLines, def }) => {
            const Icon = def.icon;
            return (
              <div key={heading} className={`rounded-lg border ${def.border} ${def.bg} p-3`}>
                <div className={`flex items-center gap-1.5 mb-2 ${def.color}`}>
                  <Icon className="w-3 h-3 shrink-0" />
                  <span className="text-[10px] font-bold uppercase tracking-wide">{def.label}</span>
                </div>
                <SectionBody lines={bodyLines} />
              </div>
            );
          })}
        {!pending && summary && sections.length === 0 && (
          <div className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{summary}</div>
        )}
      </div>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: HourlySnapshot["status"] }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
        <CheckCircle2 className="w-3 h-3" />complete
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-500/10 border border-amber-500/30 text-amber-400">
        <Loader2 className="w-3 h-3 animate-spin" />running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400">
        <XCircle className="w-3 h-3" />error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-muted/30 border border-border text-muted-foreground">
      <Clock className="w-3 h-3" />auth required
    </span>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function PerTypeTable({ stats }: { stats: PerTypeStat[] }) {
  if (stats.length === 0) {
    return <p className="text-xs text-muted-foreground">No per-type data available.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground/70">Type</th>
            <th className="text-right px-2 py-1.5 font-semibold text-muted-foreground/70">Downloads</th>
            <th className="text-right px-2 py-1.5 font-semibold text-muted-foreground/70">Errors</th>
            <th className="text-right px-2 py-1.5 font-semibold text-muted-foreground/70">Error Rate</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.type} className="border-b border-white/5 hover:bg-white/[0.02]">
              <td className="px-2 py-1.5 text-foreground font-medium">{s.type}</td>
              <td className="px-2 py-1.5 text-right text-emerald-400">{s.downloads}</td>
              <td className="px-2 py-1.5 text-right text-red-400">{s.errors}</td>
              <td className={`px-2 py-1.5 text-right font-semibold ${s.errorRate > 10 ? "text-red-400" : s.errorRate > 5 ? "text-amber-400" : "text-emerald-400"}`}>
                {s.errorRate.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpandedRow({ snap }: { snap: HourlySnapshot }) {
  if (snap.status === "auth_required") {
    return (
      <div className="px-4 py-4 bg-muted/10 border-t border-border/50">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-300 font-medium mb-1">Session expired</p>
          <p className="text-xs text-muted-foreground">
            Run the PAR Demo once to refresh credentials, then trigger a new capture.
          </p>
        </div>
      </div>
    );
  }

  if (snap.status === "error") {
    return (
      <div className="px-4 py-4 bg-muted/10 border-t border-border/50">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-red-300 font-medium mb-1">Error</p>
          <p className="text-xs text-muted-foreground font-mono">{snap.errorMessage ?? "Unknown error"}</p>
        </div>
      </div>
    );
  }

  if (snap.status === "running") {
    return (
      <div className="px-4 py-4 bg-muted/10 border-t border-border/50">
        <div className="flex items-center gap-2 text-amber-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <p className="text-sm">Capture in progress…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 bg-muted/10 border-t border-border/50 space-y-4">
      <div className="rounded-xl border border-border/50 bg-background/50 overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-border/30 bg-muted/10">
          <p className="text-xs font-semibold text-foreground">Per-Transaction-Type Breakdown</p>
        </div>
        <div className="p-3">
          <PerTypeTable stats={snap.perTypeStats} />
        </div>
      </div>
      <AiSummaryPanel summary={snap.summary} pending={false} />
    </div>
  );
}

function SnapshotRow({ snap }: { snap: HourlySnapshot }) {
  const [expanded, setExpanded] = useState(false);

  const totalRate =
    snap.totalRecords > 0
      ? ((snap.errorCount / snap.totalRecords) * 100).toFixed(1)
      : "—";

  return (
    <>
      <tr
        className="border-b border-border/30 hover:bg-muted/10 cursor-pointer transition-colors"
        onClick={() => setExpanded((p) => !p)}
      >
        <td className="px-4 py-3 text-sm text-foreground">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            )}
            {formatTime(snap.createdAt)}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 pl-5">{timeAgo(snap.createdAt)}</div>
        </td>
        <td className="px-4 py-3 text-sm text-muted-foreground">{snap.windowHours}h</td>
        <td className="px-4 py-3 text-sm text-right tabular-nums">{snap.totalRecords || "—"}</td>
        <td className="px-4 py-3 text-sm text-right tabular-nums text-emerald-400">
          {snap.downloadCount || "—"}
        </td>
        <td className="px-4 py-3 text-sm text-right tabular-nums text-red-400">
          {snap.errorCount || "—"}
        </td>
        <td className={`px-4 py-3 text-sm text-right tabular-nums font-semibold ${
          snap.status === "complete"
            ? parseFloat(totalRate) > 10
              ? "text-red-400"
              : parseFloat(totalRate) > 5
              ? "text-amber-400"
              : "text-emerald-400"
            : "text-muted-foreground"
        }`}>
          {snap.status === "complete" ? `${totalRate}%` : "—"}
        </td>
        <td className="px-4 py-3">
          <StatusBadge status={snap.status} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <AnimatePresence>
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <ExpandedRow snap={snap} />
              </motion.div>
            </AnimatePresence>
          </td>
        </tr>
      )}
    </>
  );
}

export default function HourlyMonitor() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [snapshots, setSnapshots] = useState<HourlySnapshot[]>([]);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const snapshotIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/hourly-monitor/status"));
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, []);

  const fetchSnapshots = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/hourly-monitor/snapshots"));
      if (r.ok) {
        const data: SnapshotsResponse = await r.json();
        setSnapshots(data.snapshots);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchSnapshots();

    statusIntervalRef.current = setInterval(fetchStatus, 30000);

    return () => {
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
      if (snapshotIntervalRef.current) clearInterval(snapshotIntervalRef.current);
    };
  }, [fetchStatus, fetchSnapshots]);

  useEffect(() => {
    if (snapshotIntervalRef.current) clearInterval(snapshotIntervalRef.current);
    const hasRunning = snapshots.some((s) => s.status === "running");
    snapshotIntervalRef.current = setInterval(fetchSnapshots, hasRunning ? 5000 : 60000);
  }, [snapshots, fetchSnapshots]);

  const handleRunNow = async () => {
    setTriggering(true);
    setTriggerError(null);
    try {
      const r = await fetch(apiUrl("/api/hourly-monitor/trigger"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowHours: 1 }),
      });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.error ?? "Trigger failed");
      }
      await new Promise((res) => setTimeout(res, 800));
      await fetchSnapshots();
      await fetchStatus();
    } catch (e) {
      setTriggerError((e as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  const lastSnap = status?.lastSnapshot;
  const lastAgo = lastSnap ? timeAgo(lastSnap.createdAt) : null;

  return (
    <div className="min-h-full bg-background p-4 md:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            Hourly Monitor
          </h1>
          <p className="text-sm text-muted-foreground">Automated CDR transaction log capture — every hour</p>
        </div>
        <button
          onClick={handleRunNow}
          disabled={triggering}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0"
        >
          {triggering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Run Now
        </button>
      </div>

      {triggerError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {triggerError}
        </div>
      )}

      {/* Status bar */}
      <div className="rounded-xl border border-border/50 bg-card/50 p-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <div>
            <p className="text-xs text-muted-foreground font-medium">Next scheduled run</p>
            <p className="text-lg font-bold tabular-nums" style={{ fontFamily: "var(--font-display)" }}>
              {status?.nextRunIn ?? "--:--:--"}
            </p>
          </div>
        </div>
        <div className="hidden sm:block w-px h-10 bg-border/50" />
        <div>
          <p className="text-xs text-muted-foreground font-medium">Last snapshot</p>
          {lastSnap ? (
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={lastSnap.status} />
              <span className="text-sm text-muted-foreground">{lastAgo}</span>
              {lastSnap.status === "complete" && (
                <span className="text-sm text-muted-foreground">
                  — {lastSnap.totalRecords.toLocaleString()} records
                </span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">None yet</p>
          )}
        </div>
        <button
          onClick={() => { fetchStatus(); fetchSnapshots(); }}
          className="ml-auto p-1.5 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Snapshots table */}
      <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden">
        <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
          <p className="text-sm font-semibold">Snapshot History</p>
          <p className="text-xs text-muted-foreground">{snapshots.length} of 168 max</p>
        </div>
        {snapshots.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-4">
            <Clock className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No snapshots yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Snapshots run automatically every hour, or click "Run Now" to capture immediately.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/30 bg-muted/10">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Time</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Window</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Total</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Downloads</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Errors</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Error Rate</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => (
                  <SnapshotRow key={snap.id} snap={snap} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
