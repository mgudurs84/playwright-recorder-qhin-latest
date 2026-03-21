import { useEffect, useRef, useState, useCallback } from "react";
import { Play, RotateCcw, Download, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
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

const PHASE_COLORS: Record<PARPhase, { bg: string; text: string; border: string; badge: string }> = {
  PERCEIVE: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    badge: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  },
  ACT: {
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    border: "border-orange-500/30",
    badge: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  },
  REVIEW: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  },
};

function PhaseBadge({ phase }: { phase: PARPhase }) {
  const c = PHASE_COLORS[phase];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold tracking-wide border ${c.badge}`}>
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

function StepCard({ step, index }: { step: PARStep; index: number }) {
  const c = PHASE_COLORS[step.phase];
  const [imgExpanded, setImgExpanded] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className={`rounded-2xl border ${c.border} ${c.bg} backdrop-blur-sm p-4`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-7 h-7 rounded-full border ${c.border} ${c.bg} flex items-center justify-center shrink-0 mt-0.5`}>
          <span className={`text-xs font-bold ${c.text}`}>{step.id}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <PhaseBadge phase={step.phase} />
            <span className="text-sm font-semibold text-foreground truncate">{step.label}</span>
            <AssertionChip passed={step.assertionPassed} />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{step.description}</p>
          <p className="text-xs text-muted-foreground/50 mt-1">
            <Clock className="w-3 h-3 inline mr-1" />
            {new Date(step.timestamp).toLocaleTimeString()}
          </p>
        </div>
      </div>
      {step.screenshotUrl && (
        <div className="mt-3 ml-10">
          <img
            src={apiUrl(step.screenshotUrl)}
            alt={`Step ${step.id} screenshot`}
            onClick={() => setImgExpanded(!imgExpanded)}
            className={`rounded-lg border border-border cursor-zoom-in object-cover transition-all duration-300 hover:opacity-90 ${
              imgExpanded ? "w-full max-h-none" : "max-w-xs max-h-40"
            }`}
          />
          {!imgExpanded && (
            <p className="text-xs text-muted-foreground/50 mt-1">Click to expand</p>
          )}
        </div>
      )}
    </motion.div>
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
      const fullUrl = apiUrl(s.screenshotUrl);
      const dataUri = await fetchImageAsDataUri(fullUrl);
      if (dataUri) {
        imgHtml = `<div style="margin-top:10px"><img src="${dataUri}" style="max-width:480px;border-radius:8px;border:1px solid #374151" /></div>`;
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
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>PAR Loop Demo Report — CDR Observability</title>
<style>
  body { background:#0d1117; color:#f9fafb; font-family: system-ui, -apple-system, sans-serif; margin:0; padding:24px; }
  h1 { color:#f9fafb; font-size:22px; margin-bottom:4px; }
  .meta { color:#6b7280; font-size:13px; margin-bottom:24px; }
  .summary { display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
  .chip { background:#1f2937; border:1px solid #374151; border-radius:8px; padding:8px 16px; font-size:13px; }
  .chip span { font-weight:700; font-size:16px; display:block; }
</style>
</head>
<body>
<h1>PAR Loop Demo — CDR Observability</h1>
<p class="meta">Generated ${new Date().toLocaleString()} · Playwright visualiser report · All screenshots embedded as data URIs (offline-safe)</p>
<div class="summary">
  <div class="chip"><span>${steps.length}</span>Total Steps</div>
  <div class="chip"><span style="color:#3b82f6">${steps.filter(s => s.phase === "PERCEIVE").length}</span>PERCEIVE</div>
  <div class="chip"><span style="color:#f97316">${steps.filter(s => s.phase === "ACT").length}</span>ACT</div>
  <div class="chip"><span style="color:#10b981">${steps.filter(s => s.phase === "REVIEW").length}</span>REVIEW</div>
  <div class="chip"><span style="color:#10b981">${passCount} / ${passCount + failCount}</span>Assertions Passed</div>
</div>
${rows}
</body>
</html>`;
}

export default function ParDemo() {
  const [demoState, setDemoState] = useState<DemoStatusResponse>({ status: "idle", steps: [], errorMessage: null });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(apiUrl("/api/par-demo/status"));
        if (!res.ok) return;
        const data = await res.json() as DemoStatusResponse;
        setDemoState(data);
        if (data.status === "complete" || data.status === "error") {
          stopPolling();
        }
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
    a.download = `par-demo-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
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

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-2">
        <h1 className="text-xl font-bold text-foreground" style={{ fontFamily: "var(--font-display)" }}>
          <span className="text-primary">PAR</span> Loop Demo
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Playwright Visualiser · Perceive → Act → Review in real time
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-2 pb-4 space-y-3">
        {/* Control card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-border bg-card/30 backdrop-blur-sm p-5"
        >
          <div className="flex flex-wrap items-center gap-3 mb-3">
            {/* Phase legend */}
            <div className="flex items-center gap-2 flex-wrap">
              {(["PERCEIVE", "ACT", "REVIEW"] as PARPhase[]).map((p) => (
                <PhaseBadge key={p} phase={p} />
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              {(idle || complete || hasError) && (
                <button
                  onClick={handleRun}
                  disabled={running}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4" />
                  {idle ? "Run PAR Demo" : "Run Again"}
                </button>
              )}
              {running && (
                <button
                  disabled
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary/60 text-primary-foreground text-sm font-medium cursor-not-allowed"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running…
                </button>
              )}
              {(complete || hasError) && (
                <>
                  {complete && steps.length > 0 && (
                    <button
                      onClick={handleDownload}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-sm text-foreground hover:bg-secondary transition-colors"
                    >
                      <Download className="w-4 h-4" /> Download Report
                    </button>
                  )}
                  <button
                    onClick={handleReset}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-sm text-foreground hover:bg-secondary transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" /> Reset
                  </button>
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            This demo launches a real Playwright browser that drives the CW Recorder UI from the outside,
            annotating each action as <strong className="text-blue-400">PERCEIVE</strong> (observe),{" "}
            <strong className="text-orange-400">ACT</strong> (interact), or{" "}
            <strong className="text-emerald-400">REVIEW</strong> (assert). Screenshots are captured at each step.{" "}
            <span className="text-muted-foreground/60">Manual use only — one run at a time.</span>
          </p>

          {/* Summary stats when steps exist */}
          {steps.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <span className="px-2.5 py-1 rounded-lg bg-secondary/50 border border-border text-foreground">
                <strong>{steps.length}</strong> steps
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <strong>{steps.filter((s) => s.phase === "PERCEIVE").length}</strong> PERCEIVE
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400">
                <strong>{steps.filter((s) => s.phase === "ACT").length}</strong> ACT
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <strong>{steps.filter((s) => s.phase === "REVIEW").length}</strong> REVIEW
              </span>
              {(passCount + failCount) > 0 && (
                <span className={`px-2.5 py-1 rounded-lg border text-xs ${failCount > 0 ? "bg-red-500/10 border-red-500/20 text-red-400" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"}`}>
                  <strong>{passCount}/{passCount + failCount}</strong> assertions passed
                </span>
              )}
            </div>
          )}
        </motion.div>

        {/* Error banner */}
        <AnimatePresence>
          {hasError && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-2xl border border-red-500/30 bg-red-500/5 backdrop-blur-sm p-4"
            >
              <p className="text-sm font-medium text-red-400 mb-1">Demo encountered an error</p>
              <p className="text-xs text-muted-foreground">{errorMessage ?? "Unknown error"}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Complete banner */}
        <AnimatePresence>
          {complete && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 backdrop-blur-sm p-4 flex items-center gap-3"
            >
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-emerald-400">PAR Demo complete</p>
                <p className="text-xs text-muted-foreground">
                  {steps.length} steps captured · {passCount} assertions passed · {failCount} failed
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Idle placeholder */}
        {idle && steps.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-2xl border border-border bg-card/20 backdrop-blur-sm p-8 text-center"
          >
            <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
              <Play className="w-7 h-7 text-primary" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">Ready to run</p>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Click "Run PAR Demo" to launch a Playwright browser that drives this app and streams annotated steps live.
            </p>
          </motion.div>
        )}

        {/* Timeline */}
        {steps.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">
              {running ? "Live Timeline" : "Annotated Timeline"}
            </p>
            {steps.map((step, i) => (
              <StepCard key={step.id} step={step} index={i} />
            ))}
            {running && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 px-4 py-3 rounded-xl border border-border bg-card/20 text-muted-foreground text-xs"
              >
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                Running next step…
              </motion.div>
            )}
            <div ref={stepsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
