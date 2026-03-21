import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, RotateCcw, Download, Loader2, CheckCircle2, XCircle, Clock,
  Monitor, Eye, Zap, Search,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl } from "@/lib/utils";

type PARPhase = "PERCEIVE" | "ACT" | "REVIEW";
type DemoStatus = "idle" | "running" | "complete" | "error";

interface PARStep {
  id: number;
  phase: PARPhase;
  label: string;
  description: string;
  screenshotUrl: string | null;
  assertionPassed: boolean | null;
  timestamp: string;
}

interface DemoStatusResponse {
  status: DemoStatus;
  steps: PARStep[];
  errorMessage: string | null;
}

const PHASE_META: Record<PARPhase, { bg: string; text: string; border: string; badge: string; icon: typeof Eye }> = {
  PERCEIVE: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/40",
    icon: Eye,
  },
  ACT: {
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    border: "border-orange-500/30",
    badge: "bg-orange-500/20 text-orange-300 border-orange-500/40",
    icon: Zap,
  },
  REVIEW: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    icon: Search,
  },
};

function PhaseBadge({ phase }: { phase: PARPhase }) {
  const m = PHASE_META[phase];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wide border ${m.badge}`}>
      <Icon className="w-3 h-3" />
      {phase}
    </span>
  );
}

function AssertionChip({ passed }: { passed: boolean | null }) {
  if (passed === null) return null;
  return passed ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
      <CheckCircle2 className="w-3 h-3" /> PASS
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400">
      <XCircle className="w-3 h-3" /> FAIL
    </span>
  );
}

function StepCard({ step, index, active }: { step: PARStep; index: number; active: boolean }) {
  const m = PHASE_META[step.phase];
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className={`rounded-xl border ${m.border} ${m.bg} p-3 ${active ? "ring-1 ring-primary/40" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <div className={`w-6 h-6 rounded-full border ${m.border} ${m.bg} flex items-center justify-center shrink-0 mt-0.5`}>
          <span className={`text-xs font-bold ${m.text}`}>{step.id}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <PhaseBadge phase={step.phase} />
            <span className="text-xs font-semibold text-foreground truncate">{step.label}</span>
            <AssertionChip passed={step.assertionPassed} />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{step.description}</p>
          <p className="text-xs text-muted-foreground/40 mt-0.5">
            <Clock className="w-2.5 h-2.5 inline mr-0.5" />
            {new Date(step.timestamp).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// Live browser panel — polls /api/par-demo/live every 500ms while running
function LiveBrowserPanel({
  status,
  lastStepScreenshot,
}: {
  status: DemoStatus;
  lastStepScreenshot: string | null;
}) {
  const [liveUrl, setLiveUrl] = useState<string>("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const running = status === "running";

  useEffect(() => {
    if (running) {
      // Bust the cache on every tick so the browser fetches fresh bytes
      intervalRef.current = setInterval(() => {
        setLiveUrl(apiUrl(`/api/par-demo/live?t=${Date.now()}`));
      }, 500);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // When done, show the last step screenshot if available
      if (lastStepScreenshot) {
        setLiveUrl(apiUrl(lastStepScreenshot));
      } else if (status === "idle") {
        setLiveUrl("");
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running, status, lastStepScreenshot]);

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/30 shrink-0">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
        </div>
        <div className="flex-1 flex items-center gap-1.5 mx-2 bg-background/50 border border-border rounded-md px-2 py-0.5">
          <Monitor className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate font-mono">
            integration.commonwellalliance.lkopera.com
          </span>
        </div>
        {running && (
          <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      {/* Viewport */}
      <div className="flex-1 relative bg-zinc-950 overflow-hidden">
        {status === "idle" && !liveUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-card/50 border border-border flex items-center justify-center">
              <Monitor className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground mb-1">Browser Preview</p>
              <p className="text-xs text-muted-foreground">
                Run the PAR Demo to see a live view of Playwright navigating the CommonWell portal
              </p>
            </div>
          </div>
        )}

        {liveUrl && (
          <img
            key={liveUrl}
            src={liveUrl}
            alt="Playwright live browser view"
            className="w-full h-full object-contain object-top"
            onError={() => {/* silent — next tick will retry */}}
          />
        )}

        {running && !liveUrl && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        )}

        {/* Overlay badge when live */}
        {running && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/70 backdrop-blur-sm border border-emerald-500/30 rounded-lg px-2.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-300 font-medium">Playwright · Live</span>
          </div>
        )}
      </div>
    </div>
  );
}

async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function generateHtmlReport(steps: PARStep[]): Promise<string> {
  const phaseColor: Record<PARPhase, string> = {
    PERCEIVE: "#3b82f6",
    ACT: "#f97316",
    REVIEW: "#10b981",
  };
  const rowsAsync = steps.map(async (s) => {
    const color = phaseColor[s.phase];
    const assertion =
      s.assertionPassed === null
        ? ""
        : s.assertionPassed
        ? '<span style="color:#10b981;font-weight:bold">✓ PASS</span>'
        : '<span style="color:#ef4444;font-weight:bold">✗ FAIL</span>';
    let imgHtml = "";
    if (s.screenshotUrl) {
      const dataUri = await fetchImageAsDataUri(apiUrl(s.screenshotUrl));
      if (dataUri) {
        imgHtml = `<div style="margin-top:10px"><img src="${dataUri}" style="max-width:800px;width:100%;border-radius:8px;border:1px solid #374151" /></div>`;
      }
    }
    return `
      <div style="background:#111827;border:1px solid ${color}40;border-radius:12px;padding:16px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
          <span style="background:${color}20;color:${color};border:1px solid ${color}60;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:0.05em">${s.phase}</span>
          <strong style="color:#f9fafb">${s.id}. ${s.label}</strong>
          ${assertion}
          <span style="margin-left:auto;color:#6b7280;font-size:11px">${new Date(s.timestamp).toLocaleTimeString()}</span>
        </div>
        <p style="color:#9ca3af;font-size:13px;margin:0">${s.description}</p>
        ${imgHtml}
      </div>`;
  });
  const rows = (await Promise.all(rowsAsync)).join("");
  const passCount = steps.filter((s) => s.assertionPassed === true).length;
  const failCount = steps.filter((s) => s.assertionPassed === false).length;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>PAR Loop Demo — CommonWell CDR Observability</title>
<style>
  body{background:#0d1117;color:#f9fafb;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;max-width:960px;margin:0 auto;}
  h1{font-size:22px;margin-bottom:4px;}
  .meta{color:#6b7280;font-size:13px;margin-bottom:24px;}
  .summary{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;}
  .chip{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px 14px;font-size:13px;}
  .chip span{font-weight:700;font-size:16px;display:block;}
</style>
</head>
<body>
<h1>PAR Loop Demo — CommonWell CDR Observability</h1>
<p class="meta">Generated ${new Date().toLocaleString()} · Playwright portal visualiser · Screenshots embedded as data URIs (offline-safe)</p>
<div class="summary">
  <div class="chip"><span>${steps.length}</span>Total Steps</div>
  <div class="chip"><span style="color:#3b82f6">${steps.filter((s) => s.phase === "PERCEIVE").length}</span>PERCEIVE</div>
  <div class="chip"><span style="color:#f97316">${steps.filter((s) => s.phase === "ACT").length}</span>ACT</div>
  <div class="chip"><span style="color:#10b981">${steps.filter((s) => s.phase === "REVIEW").length}</span>REVIEW</div>
  <div class="chip"><span style="color:#10b981">${passCount}/${passCount + failCount}</span>Assertions Passed</div>
</div>
${rows}
</body></html>`;
}

export default function ParDemo() {
  const [demoState, setDemoState] = useState<DemoStatusResponse>({ status: "idle", steps: [], errorMessage: null });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(apiUrl("/api/par-demo/status"));
        if (!res.ok) return;
        const data = await res.json() as DemoStatusResponse;
        setDemoState(data);
        if (data.status === "complete" || data.status === "error") stopPolling();
      } catch {}
    }, 1000);
  }, [stopPolling]);

  useEffect(() => {
    fetch(apiUrl("/api/par-demo/status"))
      .then((r) => r.ok ? r.json() : null)
      .then((data: DemoStatusResponse | null) => {
        if (!data || !Array.isArray(data.steps)) return;
        setDemoState(data);
        if (data.status === "running") startPolling();
      })
      .catch(() => {});
    return stopPolling;
  }, [startPolling, stopPolling]);

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [demoState.steps?.length]);

  const handleRun = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/par-demo/run"), { method: "POST" });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setDemoState((prev) => ({ ...prev, status: "error", errorMessage: err.error ?? "Failed to start" }));
        return;
      }
      setDemoState({ status: "running", steps: [], errorMessage: null });
      startPolling();
    } catch (err) {
      setDemoState((prev) => ({ ...prev, status: "error", errorMessage: (err as Error).message }));
    }
  }, [startPolling]);

  const handleReset = useCallback(async () => {
    stopPolling();
    await fetch(apiUrl("/api/par-demo/reset"), { method: "POST" }).catch(() => {});
    setDemoState({ status: "idle", steps: [], errorMessage: null });
  }, [stopPolling]);

  const handleDownload = useCallback(async () => {
    const html = await generateHtmlReport(demoState.steps);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `par-demo-cw-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [demoState.steps]);

  const { status, steps, errorMessage } = demoState;
  const running = status === "running";
  const complete = status === "complete";
  const hasError = status === "error";
  const idle = status === "idle";

  const passCount = steps.filter((s) => s.assertionPassed === true).length;
  const failCount = steps.filter((s) => s.assertionPassed === false).length;
  const lastScreenshot = [...steps].reverse().find((s) => s.screenshotUrl)?.screenshotUrl ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <div>
          <h1 className="text-lg font-bold text-foreground leading-tight" style={{ fontFamily: "var(--font-display)" }}>
            <span className="text-primary">PAR</span> Loop Demo
          </h1>
          <p className="text-xs text-muted-foreground">
            CommonWell Portal · Perceive → Act → Review in real time
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Phase legend */}
          {(["PERCEIVE", "ACT", "REVIEW"] as PARPhase[]).map((p) => <PhaseBadge key={p} phase={p} />)}
          <div className="w-px h-4 bg-border mx-1" />
          {(idle || complete || hasError) && (
            <button
              onClick={handleRun}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {idle ? "Run PAR Demo" : "Run Again"}
            </button>
          )}
          {running && (
            <button disabled className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary/60 text-primary-foreground text-xs font-medium cursor-not-allowed">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…
            </button>
          )}
          {complete && steps.length > 0 && (
            <button onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/50 border border-border text-xs text-foreground hover:bg-secondary transition-colors">
              <Download className="w-3.5 h-3.5" /> Report
            </button>
          )}
          {(complete || hasError) && (
            <button onClick={handleReset} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary/50 border border-border text-xs text-foreground hover:bg-secondary transition-colors">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
          )}
        </div>
      </div>

      {/* ── Status banners ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {hasError && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="mx-4 mb-1 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5">
            <p className="text-xs font-medium text-red-400">Demo error: {errorMessage ?? "Unknown error"}</p>
          </motion.div>
        )}
        {complete && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="mx-4 mb-1 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <p className="text-xs text-emerald-400 font-medium">
              Complete · {steps.length} steps · {passCount} passed · {failCount} failed
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Split panel ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden gap-3 px-4 pb-4 pt-1">

        {/* LEFT: Step timeline */}
        <div className="w-[42%] shrink-0 flex flex-col overflow-hidden rounded-2xl border border-border bg-card/20">
          <div className="px-3 py-2 border-b border-border shrink-0">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {running ? "Live Timeline" : steps.length > 0 ? "Annotated Timeline" : "Steps"}
            </p>
            {steps.length > 0 && (
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                {steps.filter((s) => s.phase === "PERCEIVE").length}P · {steps.filter((s) => s.phase === "ACT").length}A · {steps.filter((s) => s.phase === "REVIEW").length}R
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {idle && steps.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-8 px-4">
                <Play className="w-8 h-8 text-muted-foreground/30 mb-3" />
                <p className="text-xs text-muted-foreground">Click Run PAR Demo to start</p>
              </div>
            )}
            {steps.map((step, i) => (
              <StepCard
                key={step.id}
                step={step}
                index={i}
                active={running && i === steps.length - 1}
              />
            ))}
            {running && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card/20 text-muted-foreground text-xs">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                Running next step…
              </motion.div>
            )}
            <div ref={stepsEndRef} />
          </div>
        </div>

        {/* RIGHT: Live browser */}
        <div className="flex-1 overflow-hidden rounded-2xl border border-border bg-zinc-950">
          <LiveBrowserPanel status={status} lastStepScreenshot={lastScreenshot} />
        </div>
      </div>
    </div>
  );
}
