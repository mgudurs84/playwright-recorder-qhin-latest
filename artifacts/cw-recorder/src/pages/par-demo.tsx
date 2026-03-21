import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, RotateCcw, Download, Loader2, CheckCircle2, XCircle,
  Clock, Monitor, Eye, Zap, Search, Mail, KeyRound, Sparkles, ChevronDown, ChevronUp,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl } from "@/lib/utils";

type PARPhase = "PERCEIVE" | "ACT" | "REVIEW";
type DemoStatus = "idle" | "running" | "otp:waiting" | "complete" | "error";

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
  aiSummary: string | null;
  aiSummaryPending: boolean;
}

const PHASE_META: Record<PARPhase, { border: string; bg: string; text: string; badge: string; icon: typeof Eye }> = {
  PERCEIVE: { border: "border-blue-500/30", bg: "bg-blue-500/10", text: "text-blue-400", badge: "bg-blue-500/20 text-blue-300 border-blue-500/40", icon: Eye },
  ACT:      { border: "border-orange-500/30", bg: "bg-orange-500/10", text: "text-orange-400", badge: "bg-orange-500/20 text-orange-300 border-orange-500/40", icon: Zap },
  REVIEW:   { border: "border-emerald-500/30", bg: "bg-emerald-500/10", text: "text-emerald-400", badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", icon: Search },
};

function PhaseBadge({ phase }: { phase: PARPhase }) {
  const m = PHASE_META[phase];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wide border ${m.badge}`}>
      <Icon className="w-3 h-3" />{phase}
    </span>
  );
}

function AssertionChip({ passed }: { passed: boolean | null }) {
  if (passed === null) return null;
  return passed ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
      <CheckCircle2 className="w-3 h-3" />PASS
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 border border-red-500/30 text-red-400">
      <XCircle className="w-3 h-3" />FAIL
    </span>
  );
}

function StepCard({ step, index, active }: { step: PARStep; index: number; active: boolean }) {
  const m = PHASE_META[step.phase];
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, delay: index * 0.03 }}
      className={`rounded-xl border ${m.border} ${m.bg} p-3 ${active ? "ring-1 ring-primary/40" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <div className={`w-5 h-5 rounded-full border ${m.border} ${m.bg} flex items-center justify-center shrink-0 mt-0.5`}>
          <span className={`text-xs font-bold ${m.text}`}>{step.id}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
            <PhaseBadge phase={step.phase} />
            <span className="text-xs font-semibold text-foreground truncate">{step.label}</span>
            <AssertionChip passed={step.assertionPassed} />
          </div>
          <p className="text-xs text-muted-foreground leading-snug">{step.description}</p>
          <p className="text-xs text-muted-foreground/40 mt-0.5">
            <Clock className="w-2.5 h-2.5 inline mr-0.5" />
            {new Date(step.timestamp).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// Lightweight markdown renderer — no dependencies
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  const renderInline = (line: string) => {
    // **bold**, `code`
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, pi) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={pi} className="text-foreground font-semibold">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={pi} className="bg-muted/50 px-1 rounded text-xs font-mono text-emerald-300">{part.slice(1, -1)}</code>;
      }
      return part;
    });
  };

  while (i < lines.length) {
    const line = lines[i];

    // Table
    if (line.includes("|") && lines[i + 1]?.match(/^\s*\|[\s-|]+\|\s*$/)) {
      const headers = line.split("|").map((h) => h.trim()).filter(Boolean);
      i += 2; // skip separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter(Boolean));
        i++;
      }
      elements.push(
        <div key={i} className="overflow-x-auto my-2">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>{headers.map((h, hi) => <th key={hi} className="text-left px-2 py-1 border border-border/50 bg-muted/30 text-muted-foreground font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-t border-border/30">
                  {row.map((cell, ci) => <td key={ci} className="px-2 py-1 border border-border/30 text-foreground/80">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="text-sm font-bold text-foreground mt-3 mb-1 flex items-center gap-1.5">{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="text-sm font-bold text-foreground mt-4 mb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h2 key={i} className="text-base font-bold text-foreground mt-4 mb-1">{line.slice(2)}</h2>);
    // Bullets
    } else if (line.match(/^[-*] /)) {
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-muted-foreground leading-relaxed">
          <span className="text-primary shrink-0 mt-0.5">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
    // Numbered list
    } else if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1];
      elements.push(
        <div key={i} className="flex gap-1.5 text-xs text-muted-foreground leading-relaxed">
          <span className="text-primary shrink-0 font-medium w-4">{num}.</span>
          <span>{renderInline(line.replace(/^\d+\. /, ""))}</span>
        </div>
      );
    // Horizontal rule
    } else if (line.match(/^---+$/)) {
      elements.push(<hr key={i} className="border-border/30 my-2" />);
    // Empty line
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-1" />);
    // Normal paragraph
    } else {
      elements.push(<p key={i} className="text-xs text-muted-foreground leading-relaxed">{renderInline(line)}</p>);
    }
    i++;
  }
  return <div className="space-y-0.5">{elements}</div>;
}

// AI Summary panel
function AiSummaryPanel({ summary, pending }: { summary: string | null; pending: boolean }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!pending && !summary) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-violet-500/30 bg-violet-500/5 overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-violet-500/5 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center shrink-0">
          <Sparkles className="w-3.5 h-3.5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-violet-300">Vertex AI — Server Error Analysis</p>
          <p className="text-xs text-muted-foreground">
            {pending ? "Gemini 2.5 Flash is analysing…" : "Gemini 2.5 Flash · CDR error summary"}
          </p>
        </div>
        {pending ? (
          <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
        ) : (
          collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="px-4 pb-4 border-t border-violet-500/15">
          {pending && (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
              <span className="text-xs text-muted-foreground">Analysing server errors with Gemini 2.5 Flash…</span>
            </div>
          )}
          {summary && (
            <div className="mt-3">
              <SimpleMarkdown text={summary} />
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function OtpPanel({ onSubmit }: { onSubmit: (otp: string) => Promise<void> }) {
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const handleSubmit = async () => {
    if (!otp.trim()) { setErr("Enter the OTP code"); return; }
    setSubmitting(true); setErr("");
    try { await onSubmit(otp.trim()); }
    catch (e) { setErr((e as Error).message); setSubmitting(false); }
  };
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="mx-2 mb-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
          <Mail className="w-4 h-4 text-amber-400" />
        </div>
        <div>
          <p className="text-xs font-semibold text-amber-300">OTP sent to your email</p>
          <p className="text-xs text-muted-foreground">Enter the code to continue end-to-end</p>
        </div>
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input ref={inputRef} type="text" inputMode="numeric" value={otp}
            onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 8)); setErr(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Enter OTP code…"
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 tracking-widest font-mono" />
        </div>
        <button onClick={handleSubmit} disabled={submitting || !otp.length}
          className="px-4 py-2 rounded-lg bg-amber-500 text-black text-xs font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Submit OTP"}
        </button>
      </div>
      {err && <p className="text-xs text-red-400 mt-1.5">{err}</p>}
    </motion.div>
  );
}

// Double-buffered live browser panel
function LiveBrowserPanel({ status, lastStepScreenshot }: { status: DemoStatus; lastStepScreenshot: string | null }) {
  const running = status === "running" || status === "otp:waiting";
  const [frameA, setFrameA] = useState("");
  const [frameB, setFrameB] = useState("");
  const [active, setActive] = useState<"A" | "B">("A");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadingSlot = useRef<"A" | "B">("B");

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        const url = apiUrl(`/api/par-demo/live?t=${Date.now()}`);
        if (loadingSlot.current === "A") setFrameA(url);
        else setFrameB(url);
      }, 600);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (lastStepScreenshot) { setFrameA(apiUrl(lastStepScreenshot)); setFrameB(""); setActive("A"); loadingSlot.current = "B"; }
      else if (status === "idle") { setFrameA(""); setFrameB(""); }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [running, status, lastStepScreenshot]);

  const onLoadA = () => { if (loadingSlot.current === "A") { setActive("A"); loadingSlot.current = "B"; } };
  const onLoadB = () => { if (loadingSlot.current === "B") { setActive("B"); loadingSlot.current = "A"; } };

  return (
    <div className="flex flex-col h-full">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/30 shrink-0">
        <div className="flex gap-1.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
        </div>
        <div className="flex-1 flex items-center gap-1.5 mx-2 bg-background/50 border border-border rounded-md px-2 py-0.5 min-w-0">
          <Monitor className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate font-mono">integration.commonwellalliance.lkopera.com</span>
        </div>
        {status === "running" && (
          <span className="flex items-center gap-1 text-xs text-emerald-400 shrink-0 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />LIVE
          </span>
        )}
        {status === "otp:waiting" && (
          <span className="flex items-center gap-1 text-xs text-amber-400 shrink-0 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />PAUSED
          </span>
        )}
      </div>

      {/* Viewport */}
      <div className="flex-1 relative bg-zinc-950 overflow-hidden">
        {status === "idle" && !frameA && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-card/50 border border-border flex items-center justify-center">
              <Monitor className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground mb-1">Browser Preview</p>
              <p className="text-xs text-muted-foreground">
                Run the PAR Demo to watch Playwright navigate the CommonWell portal live
              </p>
            </div>
          </div>
        )}
        {frameA && (
          <img src={frameA} alt="Playwright live view" onLoad={onLoadA}
            className="absolute inset-0 w-full h-full object-contain object-top transition-opacity duration-150"
            style={{ opacity: active === "A" ? 1 : 0 }} />
        )}
        {frameB && (
          <img src={frameB} alt="Playwright live view" onLoad={onLoadB}
            className="absolute inset-0 w-full h-full object-contain object-top transition-opacity duration-150"
            style={{ opacity: active === "B" ? 1 : 0 }} />
        )}
        {status === "running" && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/70 backdrop-blur-sm border border-emerald-500/30 rounded-lg px-2.5 py-1 pointer-events-none">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-300 font-medium">Playwright · Live</span>
          </div>
        )}
        {status === "otp:waiting" && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/70 backdrop-blur-sm border border-amber-500/30 rounded-lg px-2.5 py-1 pointer-events-none">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs text-amber-300 font-medium">Waiting for OTP</span>
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
  } catch { return null; }
}

async function generateHtmlReport(steps: PARStep[], aiSummary: string | null): Promise<string> {
  const phaseColor: Record<PARPhase, string> = { PERCEIVE: "#3b82f6", ACT: "#f97316", REVIEW: "#10b981" };
  const summaryHtml = aiSummary
    ? `<div style="background:#1e1333;border:1px solid #7c3aed40;border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:16px">✨</span>
          <strong style="color:#c4b5fd">Vertex AI — Server Error Analysis</strong>
        </div>
        <pre style="color:#d4d4d8;font-size:12px;white-space:pre-wrap;font-family:system-ui">${aiSummary.replace(/</g, "&lt;")}</pre>
      </div>` : "";
  const rows = (await Promise.all(steps.map(async (s) => {
    const color = phaseColor[s.phase];
    const assertion = s.assertionPassed === null ? "" : s.assertionPassed
      ? '<span style="color:#10b981;font-weight:bold">✓ PASS</span>'
      : '<span style="color:#ef4444;font-weight:bold">✗ FAIL</span>';
    let imgHtml = "";
    if (s.screenshotUrl) {
      const uri = await fetchImageAsDataUri(apiUrl(s.screenshotUrl));
      if (uri) imgHtml = `<div style="margin-top:10px"><img src="${uri}" style="max-width:800px;width:100%;border-radius:8px;border:1px solid #374151" /></div>`;
    }
    return `<div style="background:#111827;border:1px solid ${color}40;border-radius:12px;padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <span style="background:${color}20;color:${color};border:1px solid ${color}60;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">${s.phase}</span>
        <strong style="color:#f9fafb">${s.id}. ${s.label}</strong>${assertion}
        <span style="margin-left:auto;color:#6b7280;font-size:11px">${new Date(s.timestamp).toLocaleTimeString()}</span>
      </div>
      <p style="color:#9ca3af;font-size:13px;margin:0">${s.description}</p>${imgHtml}</div>`;
  }))).join("");
  const pc = steps.filter((s) => s.assertionPassed === true).length;
  const fc = steps.filter((s) => s.assertionPassed === false).length;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>PAR Loop Demo — CommonWell CDR</title>
<style>body{background:#0d1117;color:#f9fafb;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;max-width:960px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px}.meta{color:#6b7280;font-size:13px;margin-bottom:24px}
.sum{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}.chip{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:8px 14px;font-size:13px}
.chip span{font-weight:700;font-size:16px;display:block}</style></head><body>
<h1>PAR Loop Demo — CommonWell CDR Observability</h1>
<p class="meta">Generated ${new Date().toLocaleString()} · Playwright portal visualiser</p>
<div class="sum">
  <div class="chip"><span>${steps.length}</span>Steps</div>
  <div class="chip"><span style="color:#3b82f6">${steps.filter((s) => s.phase === "PERCEIVE").length}</span>PERCEIVE</div>
  <div class="chip"><span style="color:#f97316">${steps.filter((s) => s.phase === "ACT").length}</span>ACT</div>
  <div class="chip"><span style="color:#10b981">${steps.filter((s) => s.phase === "REVIEW").length}</span>REVIEW</div>
  <div class="chip"><span style="color:#10b981">${pc}/${pc + fc}</span>Passed</div>
</div>
${summaryHtml}
${rows}</body></html>`;
}

export default function ParDemo() {
  const [demoState, setDemoState] = useState<DemoStatusResponse>({
    status: "idle", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false,
  });
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
        if (data.status === "running" || data.status === "otp:waiting") startPolling();
      }).catch(() => {});
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
        setDemoState((p) => ({ ...p, status: "error", errorMessage: err.error ?? "Failed to start" }));
        return;
      }
      setDemoState({ status: "running", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false });
      startPolling();
    } catch (err) {
      setDemoState((p) => ({ ...p, status: "error", errorMessage: (err as Error).message }));
    }
  }, [startPolling]);

  const handleReset = useCallback(async () => {
    stopPolling();
    await fetch(apiUrl("/api/par-demo/reset"), { method: "POST" }).catch(() => {});
    setDemoState({ status: "idle", steps: [], errorMessage: null, aiSummary: null, aiSummaryPending: false });
  }, [stopPolling]);

  const handleOtpSubmit = useCallback(async (otp: string) => {
    const res = await fetch(apiUrl("/api/par-demo/otp"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ otp }),
    });
    if (!res.ok) { const err = await res.json() as { error?: string }; throw new Error(err.error ?? "Failed"); }
  }, []);

  const handleDownload = useCallback(async () => {
    const html = await generateHtmlReport(demoState.steps, demoState.aiSummary);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `par-demo-cw-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [demoState.steps, demoState.aiSummary]);

  const { status, steps, errorMessage, aiSummary, aiSummaryPending } = demoState;
  const running = status === "running";
  const otpWaiting = status === "otp:waiting";
  const complete = status === "complete";
  const hasError = status === "error";
  const idle = status === "idle";
  const active = running || otpWaiting;

  const passCount = steps.filter((s) => s.assertionPassed === true).length;
  const failCount = steps.filter((s) => s.assertionPassed === false).length;
  const lastScreenshot = [...steps].reverse().find((s) => s.screenshotUrl)?.screenshotUrl ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0 gap-3">
        <div className="shrink-0">
          <h1 className="text-base font-bold text-foreground leading-tight" style={{ fontFamily: "var(--font-display)" }}>
            <span className="text-primary">PAR</span> Loop Demo
          </h1>
          <p className="text-xs text-muted-foreground">CommonWell Portal · Server Errors · Vertex AI</p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {(["PERCEIVE", "ACT", "REVIEW"] as PARPhase[]).map((p) => <PhaseBadge key={p} phase={p} />)}
          <div className="w-px h-4 bg-border mx-0.5" />
          {(idle || complete || hasError) && (
            <button onClick={handleRun}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors">
              <Play className="w-3 h-3" />{idle ? "Run PAR Demo" : "Run Again"}
            </button>
          )}
          {active && (
            <button disabled className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/60 text-primary-foreground text-xs font-medium cursor-not-allowed">
              <Loader2 className="w-3 h-3 animate-spin" />{otpWaiting ? "Waiting…" : "Running…"}
            </button>
          )}
          {complete && steps.length > 0 && (
            <button onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs text-foreground hover:bg-secondary transition-colors">
              <Download className="w-3 h-3" />Report
            </button>
          )}
          {(complete || hasError) && (
            <button onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs text-foreground hover:bg-secondary transition-colors">
              <RotateCcw className="w-3 h-3" />Reset
            </button>
          )}
        </div>
      </div>

      {/* Status banners */}
      <AnimatePresence>
        {hasError && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="mx-4 mb-1 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2">
            <p className="text-xs text-red-400 font-medium">Error: {errorMessage ?? "Unknown"}</p>
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

      {/* Split panel */}
      <div className="flex flex-1 overflow-hidden gap-2.5 px-4 pb-4 pt-1">

        {/* LEFT — step timeline + OTP + AI summary */}
        <div className="w-[42%] shrink-0 flex flex-col overflow-hidden rounded-2xl border border-border bg-card/20">
          <div className="px-3 py-2 border-b border-border shrink-0 flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {running ? "Live Timeline" : otpWaiting ? "Paused — OTP Required" : steps.length > 0 ? "Timeline" : "Steps"}
            </p>
            {steps.length > 0 && (
              <p className="text-xs text-muted-foreground/60">
                {steps.filter((s) => s.phase === "PERCEIVE").length}P · {steps.filter((s) => s.phase === "ACT").length}A · {steps.filter((s) => s.phase === "REVIEW").length}R
              </p>
            )}
          </div>

          <AnimatePresence>
            {otpWaiting && <OtpPanel onSubmit={handleOtpSubmit} />}
          </AnimatePresence>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {idle && steps.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-8 px-4">
                <Play className="w-7 h-7 text-muted-foreground/30 mb-3" />
                <p className="text-xs text-muted-foreground">Click Run PAR Demo to start</p>
                <p className="text-xs text-muted-foreground/50 mt-1">
                  Logs in → navigates to Transaction Logs → finds Server Errors → Vertex AI summary
                </p>
              </div>
            )}
            {steps.map((step, i) => (
              <StepCard key={step.id} step={step} index={i} active={active && i === steps.length - 1} />
            ))}
            {running && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card/20 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />Running next step…
              </motion.div>
            )}

            {/* AI Summary — appears inline after steps complete */}
            {(aiSummaryPending || aiSummary) && (
              <AiSummaryPanel summary={aiSummary} pending={aiSummaryPending} />
            )}

            <div ref={stepsEndRef} />
          </div>
        </div>

        {/* RIGHT — live browser */}
        <div className="flex-1 overflow-hidden rounded-2xl border border-border bg-zinc-950">
          <LiveBrowserPanel status={status} lastStepScreenshot={lastScreenshot} />
        </div>
      </div>
    </div>
  );
}
