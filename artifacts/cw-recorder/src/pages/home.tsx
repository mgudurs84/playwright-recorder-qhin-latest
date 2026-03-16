import { useEffect, useRef, useState, useCallback } from "react";
import { Shield, Navigation, FileText, Monitor, KeyRound, RotateCcw, Download, Loader2, Play, Search, AlertCircle, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AgentStepper } from "@/components/agent-stepper";
import { apiUrl } from "@/lib/utils";

type RunnerPhase =
  | "idle"
  | "login:started"
  | "otp:waiting"
  | "navigating"
  | "extracting"
  | "reporting"
  | "complete"
  | "error";

interface RunStatus {
  phase: RunnerPhase;
  daysBack: number;
  transactionId: string | null;
  searchMode: "date" | "transaction_id";
  recordCount: number;
  errorCount: number;
  errorMessage: string | null;
  reportFile: string | null;
  screenshotUrls: string[];
  liveExtractionPage: number;
  liveExtractionCount: number;
}

function phaseToStep(phase: RunnerPhase): "cw-auth" | "cw-navigator" | "cw-reporter" | "complete" {
  if (phase === "login:started" || phase === "otp:waiting") return "cw-auth";
  if (phase === "navigating" || phase === "extracting") return "cw-navigator";
  if (phase === "reporting" || phase === "complete") return "cw-reporter";
  return "cw-auth";
}

function phaseLabel(phase: RunnerPhase, liveExtractionPage: number, liveExtractionCount: number): string {
  switch (phase) {
    case "login:started": return "Logging in…";
    case "otp:waiting": return "Waiting for OTP";
    case "navigating": return "Navigating to Transaction Logs…";
    case "extracting":
      return liveExtractionPage > 0
        ? `Extracting page ${liveExtractionPage} · ${liveExtractionCount.toLocaleString()} records so far…`
        : "Starting extraction…";
    case "reporting": return "Generating report with AI…";
    case "complete": return "Complete";
    case "error": return "Error";
    default: return "";
  }
}

const isRunning = (phase: RunnerPhase) =>
  phase !== "idle" && phase !== "complete" && phase !== "error";

export default function Home() {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [otpValue, setOtpValue] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(apiUrl("/api/cw/status"));
        if (!res.ok) return;
        const s = await res.json() as RunStatus;
        setStatus(s);
        if (s.phase === "complete" || s.phase === "error" || s.phase === "idle") {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
        }
      } catch {}
    }, 2000);
  }, []);

  useEffect(() => {
    fetch(apiUrl("/api/cw/status"))
      .then((r) => r.json())
      .then((s: RunStatus) => {
        setStatus(s);
        if (isRunning(s.phase) || s.phase === "otp:waiting") startPolling();
      })
      .catch(() => {});
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [startPolling]);

  const handleStart = useCallback(async (query?: string) => {
    setStartError(null);
    const q = (query ?? searchInput).trim();
    let daysBack = 7;
    let transactionId: string | null = null;
    let maxRecords = 0;

    if (q) {
      // "last 20 transactions" / "20 transactions" / "last 20 records"
      const countMatch = q.match(/(?:last\s+)?(\d+)\s*(?:transaction|record|result|row)s?/i);
      // "last 20" (with "last" keyword but no "day")
      const lastNMatch = !countMatch && q.match(/^last\s+(\d+)$/i);
      // "7 days" / "last 7 days" / "7d"
      const dayMatch = !countMatch && !lastNMatch && q.match(/(?:last\s+)?(\d+)\s*d(?:ay)?s?/i);
      // bare number — treat as days
      const bareNum = !countMatch && !lastNMatch && !dayMatch && /^\d+$/.test(q);

      if (countMatch) {
        maxRecords = parseInt(countMatch[1], 10);
      } else if (lastNMatch) {
        maxRecords = parseInt(lastNMatch[1], 10);
      } else if (dayMatch) {
        daysBack = parseInt(dayMatch[1], 10);
      } else if (bareNum) {
        daysBack = parseInt(q, 10);
      } else {
        transactionId = q;
      }
    }

    try {
      const res = await fetch(apiUrl("/api/cw/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daysBack, transactionId, maxRecords }),
      });
      const data = await res.json() as { started?: boolean; error?: string; phase?: string };
      if (!res.ok) {
        setStartError(data.error ?? "Failed to start");
        return;
      }
      setSearchInput("");
      startPolling();
    } catch (err) {
      setStartError((err as Error).message);
    }
  }, [searchInput, startPolling]);

  const handleOtpSubmit = useCallback(async () => {
    if (!otpValue.trim()) return;
    setOtpSubmitting(true);
    try {
      await fetch(apiUrl("/api/cw/otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otpValue.trim() }),
      });
      setOtpValue("");
    } finally {
      setOtpSubmitting(false);
    }
  }, [otpValue]);

  const handleReset = useCallback(async () => {
    await fetch(apiUrl("/api/cw/reset"), { method: "POST" }).catch(() => {});
    setStatus(null);
    setOtpValue("");
    setStartError(null);
  }, []);

  const phase = status?.phase ?? "idle";
  const running = isRunning(phase) || phase === "otp:waiting";
  const complete = phase === "complete";
  const hasError = phase === "error";

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-8 pb-4 text-center">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-4">
            <Monitor className="w-3.5 h-3.5 text-primary animate-pulse" />
            <span className="text-xs font-medium text-foreground/70 tracking-wide">
              Playwright Automation · CommonWell Portal · Gemini 2.5 Flash
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2" style={{ fontFamily: "var(--font-display)" }}>
            CommonWell{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Recorder</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-lg mx-auto">
            Automated transaction log extraction and error analysis for the CommonWell Health Alliance portal.
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="flex flex-wrap items-center justify-center gap-3 mt-4">
          {[
            { icon: Shield, label: "Auto Login + OTP" },
            { icon: Navigation, label: "DOM Table Extraction" },
            { icon: FileText, label: "AI Error Analysis" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary/30 border border-border/50 text-xs text-muted-foreground">
              <Icon className="w-3 h-3 text-primary" />
              {label}
            </div>
          ))}
        </motion.div>

        <div className="mt-4">
          <AgentStepper currentAgent={complete ? "complete" : phaseToStep(phase)} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">

        {!running && !complete && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-card/30 backdrop-blur-sm p-5">
            <p className="text-sm text-muted-foreground mb-3">
              Enter a date range or a specific transaction ID to search for.
            </p>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                  placeholder="e.g. 'last 7 days', 'last 20 transactions', or a transaction ID"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <button
                onClick={() => handleStart()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Play className="w-4 h-4" />
                Run
              </button>
            </div>
            {startError && (
              <p className="mt-2 text-xs text-red-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {startError}
              </p>
            )}
          </motion.div>
        )}

        <AnimatePresence>
          {running && phase !== "otp:waiting" && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-2xl border border-border bg-card/30 backdrop-blur-sm p-5 flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
              <span className="text-sm text-foreground/80">
                {phaseLabel(phase, status?.liveExtractionPage ?? 0, status?.liveExtractionCount ?? 0)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {phase === "otp:waiting" && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 backdrop-blur-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <KeyRound className="w-4 h-4 text-yellow-400" />
                <span className="text-sm font-medium text-yellow-400">Verification Code Required</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Check your email for the one-time code sent by CommonWell and enter it below.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otpValue}
                  onChange={(e) => setOtpValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleOtpSubmit()}
                  placeholder="Enter OTP code…"
                  autoFocus
                  disabled={otpSubmitting}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:border-yellow-500/50 focus:ring-1 focus:ring-yellow-500/20"
                />
                <button
                  onClick={handleOtpSubmit}
                  disabled={otpSubmitting || !otpValue.trim()}
                  className="px-5 py-2.5 rounded-xl bg-yellow-500 text-black text-sm font-medium hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {otpSubmitting ? "Submitting…" : "Submit"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {hasError && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-2xl border border-red-500/30 bg-red-500/5 backdrop-blur-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-sm font-medium text-red-400">Run failed</span>
              </div>
              <p className="text-xs text-muted-foreground mb-3">{status?.errorMessage ?? "Unknown error"}</p>
              <button
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary/50 border border-border text-sm text-foreground hover:bg-secondary transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Try Again
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {complete && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 backdrop-blur-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-400">Run complete</span>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Extracted <strong className="text-foreground">{status?.recordCount.toLocaleString()}</strong> records
                {" · "}
                <strong className="text-red-400">{status?.errorCount.toLocaleString()}</strong> errors found
              </p>
              <div className="flex gap-2 flex-wrap">
                <a
                  href={apiUrl("/api/cw/report")}
                  download
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-colors"
                >
                  <Download className="w-4 h-4" /> Download Report
                </a>
                <button
                  onClick={handleReset}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-foreground text-sm hover:bg-secondary transition-colors"
                >
                  <RotateCcw className="w-4 h-4" /> New Search
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {(status?.screenshotUrls?.length ?? 0) > 0 && (
          <div className="rounded-2xl border border-border bg-card/30 backdrop-blur-sm p-4">
            <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">Screenshots</p>
            <div className="flex flex-wrap gap-3">
              {status!.screenshotUrls.map((url, i) => (
                <a key={i} href={apiUrl(url)} target="_blank" rel="noopener noreferrer">
                  <img
                    src={apiUrl(url)}
                    alt={`Step ${i + 1}`}
                    className="rounded-lg border border-border object-cover cursor-zoom-in hover:opacity-90 transition-opacity"
                    style={{ maxWidth: 280, maxHeight: 180 }}
                  />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
