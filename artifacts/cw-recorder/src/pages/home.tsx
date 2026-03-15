import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotChat } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import { Shield, Navigation, FileText, Monitor, KeyRound, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AgentStepper } from "@/components/agent-stepper";
import { apiUrl } from "@/lib/utils";

// Map server phase → stepper display step
function phaseToStep(phase: string): "cw-auth" | "cw-navigator" | "cw-reporter" | "complete" {
  if (phase === "authenticated" || phase === "navigating") return "cw-navigator";
  if (phase === "extracted" || phase === "complete") return "cw-reporter";
  return "cw-auth";
}

// Map server phase → chat instructions
function phaseToInstructions(phase: string, daysBack: number): string {
  if (phase === "authenticated" || phase === "navigating") {
    return `You are the CW Navigator. Authentication is complete. IMMEDIATELY call cwNavigateToTransactions, then cwApplyDateFilter(${daysBack}), then cwExtractTransactions, then cwNavigationComplete. Do NOT call auth tools.`;
  }
  if (phase === "extracted" || phase === "complete") {
    return "You are the CW Reporter. IMMEDIATELY call cwGetRunData. Analyze errors. Call cwSaveReport(report) with your full markdown analysis. Then call uiReportComplete(report).";
  }
  return "You are the CW Auth agent. Extract the daysBack value from the user's request (default 7). Call cwCheckSession — if valid, call cwAuthComplete(daysBack) immediately. Otherwise call cwLogin. If OTP is needed, say 'Please enter the verification code sent to your email.' and WAIT. When the user provides the code, call cwSubmitOtp(otp). After success call cwAuthComplete(daysBack). STOP.";
}

export default function Home() {
  const [phase, setPhase] = useState("idle");
  const [daysBack, setDaysBack] = useState(7);
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

  // Clear stale chat on mount
  useLayoutEffect(() => { reset(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Poll /api/cw/status — update phase, fire trigger messages for navigator & reporter
  useEffect(() => {
    if (!pollingActive || runComplete) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(apiUrl("/api/cw/status"));
        if (!res.ok) return;
        const status = await res.json() as { phase: string; daysBack: number; recordCount: number; errorCount: number };

        setPhase(status.phase);

        // Trigger navigator — fires once when auth completes
        if (status.phase === "authenticated" && !navTriggeredRef.current) {
          navTriggeredRef.current = true;
          setDaysBack(status.daysBack ?? 7);
          appendMessage(new TextMessage({
            id: `nav-${Date.now()}`, role: MessageRole.User,
            content: `Authentication complete. Navigate to Transaction Logs, apply a ${status.daysBack ?? 7}-day date filter, extract all table rows, then call cwNavigationComplete.`,
          }));
        }

        // Trigger reporter — fires once when extraction completes
        if (status.phase === "extracted" && !repTriggeredRef.current) {
          repTriggeredRef.current = true;
          appendMessage(new TextMessage({
            id: `rep-${Date.now()}`, role: MessageRole.User,
            content: `Extraction complete (${status.recordCount} records, ${status.errorCount} errors). Call cwGetRunData, analyze the transactions, generate the full error analysis report, then call cwSaveReport.`,
          }));
        }

        if (status.phase === "complete") {
          setRunComplete(true);
          setPollingActive(false);
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [pollingActive, runComplete, appendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleRunAgain = useCallback(async () => {
    try { await fetch(apiUrl("/api/cw/reset"), { method: "POST" }); } catch {}
    navTriggeredRef.current = false;
    repTriggeredRef.current = false;
    setPhase("idle");
    setRunComplete(false);
    setOtpMode(false);
    setPollingActive(true);
    reset();
    await appendMessage(new TextMessage({
      id: `rerun-${Date.now()}`, role: MessageRole.User,
      content: `Run again — get the last ${daysBack} days of transaction errors`,
    }));
  }, [daysBack, appendMessage, reset]);

  useCopilotAction({
    name: "uiReportComplete",
    description: "Called when the report is saved and the run is complete",
    parameters: [{ name: "report", type: "string", required: true }],
    handler: async () => { setRunComplete(true); return { complete: true }; },
    render: ({ status }) => status === "complete" ? (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        Report saved successfully
      </div>
    ) : <></>,
  });

  useCopilotAction({
    name: "uiShowScreenshot",
    description: "Display an inline screenshot from the automation",
    parameters: [
      { name: "screenshotUrl", type: "string", required: true },
      { name: "caption", type: "string", required: false },
    ],
    handler: async () => ({ displayed: true }),
    render: ({ args }) => !args?.screenshotUrl ? <></> : (
      <div className="space-y-1">
        <img src={apiUrl(args.screenshotUrl as string)} alt={args.caption as string || "Automation screenshot"} className="w-full rounded-lg border border-border" />
        {args.caption && <p className="text-xs text-muted-foreground">{args.caption as string}</p>}
      </div>
    ),
  });

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
                initial: "Hi! I'm your CommonWell Recorder agent.\n\nI'll log into the CommonWell portal, extract transaction logs, and analyze errors for you.\n\nTry: *\"Get last 7 days of transaction errors\"*",
                placeholder: otpMode ? "Enter OTP code..." : "e.g. Get last 7 days of transaction errors...",
              }}
              instructions={phaseToInstructions(phase, daysBack)}
              className="h-full"
            />
          </div>

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
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="border-t border-border bg-card/80 backdrop-blur-sm p-4">
                <button onClick={handleRunAgain} className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/20 transition-colors">
                  <RotateCcw className="w-4 h-4" />
                  Run Again ({daysBack} days)
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
