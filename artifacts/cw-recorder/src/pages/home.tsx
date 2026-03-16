import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotChat } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import { Shield, Navigation, FileText, Monitor, KeyRound, RotateCcw, Download, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AgentStepper } from "@/components/agent-stepper";
import { apiUrl } from "@/lib/utils"; // used for Download Report href

// Map server phase → stepper display step
function phaseToStep(phase: string): "cw-auth" | "cw-navigator" | "cw-reporter" | "complete" {
  if (phase === "authenticated" || phase === "navigating") return "cw-navigator";
  if (phase === "extracted" || phase === "complete") return "cw-reporter";
  return "cw-auth";
}

// Map server phase → chat instructions
function phaseToInstructions(phase: string, daysBack: number, transactionId: string | null): string {
  if (phase === "authenticated" || phase === "navigating") {
    if (transactionId) {
      return `You are the CW Navigator. Authentication is complete. IMMEDIATELY call cwNavigateToTransactions, then cwSearchByTransactionId("${transactionId}"), then cwExtractTransactions, then cwNavigationComplete. Do NOT call auth tools.`;
    }
    return `You are the CW Navigator. Authentication is complete. IMMEDIATELY call cwNavigateToTransactions, then cwApplyDateFilter(${daysBack}), then cwExtractTransactions, then cwNavigationComplete. Do NOT call auth tools.`;
  }
  if (phase === "extracted" || phase === "complete") {
    return "You are the CW Reporter. IMMEDIATELY call cwGetRunData. Analyze errors. Call cwSaveReport(report) with your full markdown analysis. Do NOT call any other tools after cwSaveReport.";
  }
  return "You are the CW Auth agent. From the user's request extract EITHER: (a) daysBack — a number of days e.g. 'last 3 days' → daysBack=3 (default 7), OR (b) a transactionId — a specific ID string. Call cwCheckSession — if valid, call cwAuthComplete(daysBack, transactionId) immediately. Otherwise call cwLogin. If OTP is needed, say 'Please enter the verification code sent to your email.' and WAIT. When the user provides the code, call cwSubmitOtp(otp). After success call cwAuthComplete(daysBack, transactionId). STOP.";
}

export default function Home() {
  const [phase, setPhase] = useState("idle");
  const [daysBack, setDaysBack] = useState(7);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<"date" | "transaction_id">("date");
  const [newSearchInput, setNewSearchInput] = useState("");
  const [liveExtractionPage, setLiveExtractionPage] = useState(0);
  const [liveExtractionCount, setLiveExtractionCount] = useState(0);
  const [otpMode, setOtpMode] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [runComplete, setRunComplete] = useState(false);
  const [pollingActive, setPollingActive] = useState(false);

  const navTriggeredRef = useRef(false);
  const repTriggeredRef = useRef(false);

  const { messages, appendMessage, reset } = useCopilotChat({
    onSubmitMessage: () => { setPollingActive(true); },
  });

  // Keep a stable ref to appendMessage so the polling interval never restarts
  // just because CopilotKit changed the function reference during streaming.
  const appendMessageRef = useRef(appendMessage);
  useEffect(() => { appendMessageRef.current = appendMessage; }, [appendMessage]);

  // Clear stale chat on mount
  useLayoutEffect(() => { reset(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: restore runComplete if server already has a report (e.g. after page refresh)
  useEffect(() => {
    fetch(apiUrl("/api/cw/report"), { method: "HEAD" }).then(res => {
      if (res.ok) setRunComplete(true);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show OTP panel when agent text mentions a code/verification
  useEffect(() => {
    if (phase !== "idle" && phase !== "authenticating" && phase !== "waitingForOtp") return;
    if (otpMode) return;
    const msgs = Array.isArray(messages) ? messages : [];
    const last = [...msgs].reverse().find(m => m.role === MessageRole.Assistant && "content" in m);
    if (last && "content" in last) {
      const t = (last.content as string).toLowerCase();
      if (t.includes("otp") || t.includes("verification code") || t.includes("enter the code") || t.includes("check your email")) {
        setOtpMode(true);
      }
    }
  }, [messages, phase, otpMode]);

  // Poll /api/cw/status — update phase, fire trigger messages for navigator & reporter.
  // Depends only on pollingActive/runComplete — appendMessage comes from ref to avoid
  // restarting the interval every time CopilotKit changes the function reference mid-stream.
  useEffect(() => {
    if (!pollingActive || runComplete) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl("/api/cw/status"));
        if (!res.ok) return;
        const status = await res.json() as { phase: string; daysBack: number; transactionId: string | null; searchMode: "date" | "transaction_id"; recordCount: number; errorCount: number; liveExtractionPage: number; liveExtractionCount: number };

        setPhase(status.phase);
        setLiveExtractionPage(status.liveExtractionPage ?? 0);
        setLiveExtractionCount(status.liveExtractionCount ?? 0);

        // Trigger navigator — fires once when auth completes
        if (status.phase === "authenticated" && !navTriggeredRef.current) {
          navTriggeredRef.current = true;
          setDaysBack(status.daysBack ?? 7);
          setTransactionId(status.transactionId ?? null);
          setSearchMode(status.searchMode ?? "date");
          const navMsg = status.transactionId
            ? `[SYSTEM] Call cwNavigateToTransactions() now. Then call cwSearchByTransactionId("${status.transactionId}"). Then call cwExtractTransactions(). Then call cwNavigationComplete(). Do not output any text — call tools only.`
            : `[SYSTEM] Call cwNavigateToTransactions() now. Then call cwApplyDateFilter(${status.daysBack ?? 7}). Then call cwExtractTransactions(). Then call cwNavigationComplete(). Do not output any text — call tools only.`;
          appendMessageRef.current(new TextMessage({
            id: `nav-${Date.now()}`, role: MessageRole.User,
            content: navMsg,
          }));
        }

        // Trigger reporter — fires once when extraction completes
        if (status.phase === "extracted" && !repTriggeredRef.current) {
          repTriggeredRef.current = true;
          appendMessageRef.current(new TextMessage({
            id: `rep-${Date.now()}`, role: MessageRole.User,
            content: `[SYSTEM] Extraction complete (${status.recordCount} records). Call cwGetRunData() now. Then call cwSaveReport(report) with your full markdown error analysis. Do not output any text before calling these tools.`,
          }));
        }

        if (status.phase === "complete") {
          setRunComplete(true);
          setPollingActive(false);
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [pollingActive, runComplete]); // appendMessage accessed via ref — no restart on reference change

  const handleOtpSubmit = useCallback(async () => {
    if (!otpValue.trim()) return;
    setOtpSubmitting(true);
    try {
      await appendMessage(new TextMessage({
        id: `otp-${Date.now()}`, role: MessageRole.User,
        content: `My OTP code is: ${otpValue.trim()}`,
      }));
      setOtpValue("");
      setOtpMode(false);
    } finally { setOtpSubmitting(false); }
  }, [otpValue, appendMessage]);

  const handleRunAgain = useCallback(async (query?: string) => {
    const searchQuery = query ?? (searchMode === "transaction_id" && transactionId
      ? `Find transaction ID ${transactionId}`
      : `Get the last ${daysBack} days of transaction errors`);
    try { await fetch(apiUrl("/api/cw/reset"), { method: "POST" }); } catch {}
    navTriggeredRef.current = false;
    repTriggeredRef.current = false;
    setPhase("idle");
    setRunComplete(false);
    setOtpMode(false);
    setTransactionId(null);
    setSearchMode("date");
    setNewSearchInput("");
    setPollingActive(true);
    reset();
    await appendMessage(new TextMessage({
      id: `rerun-${Date.now()}`, role: MessageRole.User,
      content: searchQuery,
    }));
  }, [daysBack, transactionId, searchMode, appendMessage, reset]);

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
            { icon: FileText, label: "Error Analysis" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary/30 border border-border/50 text-xs text-muted-foreground">
              <Icon className="w-3 h-3 text-primary" />
              {label}
            </div>
          ))}
        </motion.div>

        <div className="mt-4">
          <AgentStepper currentAgent={runComplete ? "complete" : phaseToStep(phase)} />
        </div>
      </div>

      <div className="flex-1 overflow-hidden px-4 pb-4">
        <div className="h-full rounded-2xl border border-border overflow-hidden bg-card/30 backdrop-blur-sm flex flex-col">
          <div className={`flex-1 overflow-hidden ${otpMode ? "copilot-otp-mode" : ""}`}>
            <CopilotChat
              labels={{
                title: "CW Recorder Agent",
                initial: "Hi! I'm your CommonWell Recorder agent.\n\nI'll log into the portal, extract transaction logs, and analyze errors.\n\nTry:\n- *\"Get last 7 days of transaction errors\"*\n- *\"Find transaction ID abc-1234-xyz\"*",
                placeholder: otpMode ? "Enter OTP code..." : "e.g. Get last 7 days of errors, or find transaction ID abc-123...",
              }}
              instructions={phaseToInstructions(phase, daysBack, transactionId)}
              className="h-full"
            />
          </div>

          <AnimatePresence>
            {phase === "navigating" && liveExtractionPage > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="border-t border-border bg-card/60 backdrop-blur-sm px-4 py-2.5 flex items-center gap-3"
              >
                <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                <span className="text-sm text-foreground/80">
                  Extracting page <span className="font-semibold text-primary">{liveExtractionPage}</span>
                  {" · "}
                  <span className="font-semibold text-primary">{liveExtractionCount.toLocaleString()}</span> records so far…
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {otpMode && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="border-t border-border bg-card/80 backdrop-blur-sm p-4">
                <div className="flex items-center gap-2 mb-2">
                  <KeyRound className="w-4 h-4 text-yellow-400" />
                  <span className="text-sm font-medium text-yellow-400">Enter Verification Code</span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={otpValue}
                    onChange={(e) => setOtpValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleOtpSubmit()}
                    placeholder="Enter OTP code..."
                    autoFocus
                    className="flex-1 px-4 py-2.5 rounded-xl bg-secondary/50 border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                    disabled={otpSubmitting}
                  />
                  <button
                    onClick={handleOtpSubmit}
                    disabled={otpSubmitting || !otpValue.trim()}
                    className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {otpSubmitting ? "Submitting..." : "Submit OTP"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {runComplete && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="border-t border-border bg-card/80 backdrop-blur-sm p-4 space-y-2">
                <div className="flex gap-2">
                  <a
                    href={apiUrl("/api/cw/report")}
                    download
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Download Report
                  </a>
                  <button
                    onClick={() => handleRunAgain()}
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {searchMode === "transaction_id" ? `Search Again` : `Run Again (${daysBack}d)`}
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newSearchInput}
                    onChange={(e) => setNewSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && newSearchInput.trim() && handleRunAgain(newSearchInput.trim())}
                    placeholder="New search: e.g. 'last 3 days' or 'transaction ID xyz-123'"
                    className="flex-1 px-4 py-2 rounded-xl bg-secondary/50 border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                  />
                  <button
                    onClick={() => newSearchInput.trim() && handleRunAgain(newSearchInput.trim())}
                    disabled={!newSearchInput.trim()}
                    className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Go
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
