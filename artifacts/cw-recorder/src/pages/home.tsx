import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotChat } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import { Shield, Navigation, FileText, Monitor, KeyRound, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useActiveCwAgent } from "@/contexts/agent-context";
import { AgentStepper } from "@/components/agent-stepper";
import { apiUrl } from "@/lib/utils";

export default function Home() {
  const { activeAgent, setActiveAgent } = useActiveCwAgent();
  const [otpMode, setOtpMode] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [runComplete, setRunComplete] = useState(false);
  const [navDaysBack, setNavDaysBack] = useState(7);

  const [pollingActive, setPollingActive] = useState(false);

  const navSwitchDoneRef = useRef(false);
  const repSwitchDoneRef = useRef(false);
  const activeAgentRef = useRef(activeAgent);
  const pendingNavTriggerRef = useRef(false);
  const pendingRepTriggerRef = useRef(false);
  useEffect(() => { activeAgentRef.current = activeAgent; }, [activeAgent]);

  const { messages, appendMessage, reset } = useCopilotChat({
    onSubmitMessage: () => {
      setPollingActive(true);
    },
  });
  // Keep refs always pointing to the latest appendMessage/reset so timeouts
  // that fire 1200ms after an agent switch always call the fresh versions.
  const appendMessageRef = useRef(appendMessage);
  const resetRef = useRef(reset);
  useEffect(() => { appendMessageRef.current = appendMessage; }, [appendMessage]);
  useEffect(() => { resetRef.current = reset; }, [reset]);

  // Auto-show OTP input when the auth agent mentions OTP/verification in its reply.
  // This avoids calling uiRequestOtp as an LLM tool (which leaves dangling tool calls
  // and causes MissingToolResultsError when the next message is sent).
  useEffect(() => {
    if (activeAgent !== "cw-auth" || otpMode) return;
    const lastAgentMsg = (Array.isArray(messages) ? [...messages] : []).reverse().find(
      (m) => m.role === MessageRole.Assistant && "content" in m
    );
    if (lastAgentMsg && "content" in lastAgentMsg) {
      const text = (lastAgentMsg.content as string).toLowerCase();
      if (
        text.includes("otp") ||
        text.includes("verification code") ||
        text.includes("enter the code") ||
        text.includes("enter your code") ||
        text.includes("check your email")
      ) {
        setOtpMode(true);
      }
    }
  }, [messages, activeAgent, otpMode]);

  useLayoutEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveAgent("cw-auth");
    setRunComplete(false);
    setOtpMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Agent-change trigger effect ─────────────────────────────────────────────
  // Fires AFTER CopilotKit has re-rendered with the new agent and fresh hook refs.
  // Using a 1200ms delay gives CopilotKit time to fully reconnect before we call
  // appendMessage — this prevents stale-ref issues that broke the 500ms setTimeout
  // approach that lived inside the polling closure.
  const navDaysBackRef = useRef(navDaysBack);
  useEffect(() => { navDaysBackRef.current = navDaysBack; }, [navDaysBack]);

  useEffect(() => {
    if (pendingNavTriggerRef.current && activeAgent === "cw-navigator") {
      pendingNavTriggerRef.current = false;
      const days = navDaysBackRef.current;
      const timer = setTimeout(() => {
        resetRef.current();
        appendMessageRef.current(
          new TextMessage({
            id: `nav-trigger-${Date.now()}`,
            role: MessageRole.User,
            content: `Authentication complete. Navigate to Transaction Logs, apply a ${days}-day date filter, extract all table rows, then call cwNavigationComplete.`,
          })
        );
      }, 1200);
      return () => clearTimeout(timer);
    }
    if (pendingRepTriggerRef.current && activeAgent === "cw-reporter") {
      pendingRepTriggerRef.current = false;
      const timer = setTimeout(() => {
        resetRef.current();
        appendMessageRef.current(
          new TextMessage({
            id: `rep-trigger-${Date.now()}`,
            role: MessageRole.User,
            content: `Extraction complete. Call cwGetRunData, analyze the transactions, and generate the full error analysis report. Then call cwSaveReport with the report.`,
          })
        );
      }, 1200);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent]);

  // ─── Status Polling ─────────────────────────────────────────────────────────
  // Poll /api/cw/status (in-memory, no DB) every 3 seconds.
  // Drives agent transitions based on phase changes — ONLY sets agent/flags here,
  // never calls appendMessage directly (avoids stale-closure issues).
  useEffect(() => {
    if (!pollingActive || runComplete) return;

    const poll = async () => {
      try {
        const res = await fetch(apiUrl("/api/cw/status"));
        if (!res.ok) return;
        const status = await res.json() as {
          phase: string;
          daysBack: number;
          recordCount: number;
          errorCount: number;
        };

        const agent = activeAgentRef.current;

        if (
          status.phase === "authenticated" &&
          agent === "cw-auth" &&
          !navSwitchDoneRef.current
        ) {
          navSwitchDoneRef.current = true;
          setNavDaysBack(status.daysBack ?? 7);
          pendingNavTriggerRef.current = true;
          setActiveAgent("cw-navigator");
        } else if (
          status.phase === "extracted" &&
          agent === "cw-navigator" &&
          !repSwitchDoneRef.current
        ) {
          repSwitchDoneRef.current = true;
          pendingRepTriggerRef.current = true;
          setActiveAgent("cw-reporter");
        } else if (status.phase === "complete" && agent === "cw-reporter") {
          setRunComplete(true);
          setPollingActive(false);
        }
      } catch {
        // Silently ignore polling errors
      }
    };

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pollingActive, runComplete, setActiveAgent]);

  const handleOtpSubmit = useCallback(async () => {
    if (!otpValue.trim()) return;
    setOtpSubmitting(true);
    try {
      await appendMessage(
        new TextMessage({
          id: `otp-${Date.now()}`,
          role: MessageRole.User,
          content: `My OTP code is: ${otpValue.trim()}`,
        })
      );
      setOtpValue("");
      setOtpMode(false);
    } finally {
      setOtpSubmitting(false);
    }
  }, [otpValue, appendMessage]);

  const handleRunAgain = useCallback(async () => {
    try {
      await fetch(apiUrl("/api/cw/reset"), { method: "POST" });
    } catch {}

    navSwitchDoneRef.current = false;
    repSwitchDoneRef.current = false;

    setActiveAgent("cw-auth");
    setRunComplete(false);
    setOtpMode(false);
    setPollingActive(true);

    reset();
    await appendMessage(
      new TextMessage({
        id: `rerun-${Date.now()}`,
        role: MessageRole.User,
        content: `Run again — get the last ${navDaysBack} days of transaction errors`,
      })
    );
  }, [navDaysBack, setActiveAgent, appendMessage, reset]);

  // ─── Frontend Actions ───────────────────────────────────────────────────────
  useCopilotAction({
    name: "uiReportComplete",
    description: "Called when the report is saved and the run is complete",
    parameters: [
      { name: "report", type: "string", required: true },
    ],
    handler: async () => {
      setRunComplete(true);
      return { complete: true };
    },
    render: ({ status }) => {
      if (status === "complete") {
        return (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Report saved successfully
          </div>
        );
      }
      return <></>;
    },
  });

  useCopilotAction({
    name: "uiShowScreenshot",
    description: "Display an inline screenshot from the automation",
    parameters: [
      { name: "screenshotUrl", type: "string", required: true },
      { name: "caption", type: "string", required: false },
    ],
    handler: async () => {
      return { displayed: true };
    },
    render: ({ args }) => {
      if (!args?.screenshotUrl) return <></>;
      return (
        <div className="space-y-1">
          <img
            src={apiUrl(args.screenshotUrl as string)}
            alt={args.caption as string || "Automation screenshot"}
            className="w-full rounded-lg border border-border"
          />
          {args.caption && (
            <p className="text-xs text-muted-foreground">{args.caption as string}</p>
          )}
        </div>
      );
    },
  });

  // ─── Per-agent instructions ─────────────────────────────────────────────────
  const chatInstructions =
    activeAgent === "cw-auth"
      ? "You are the CW Auth agent. Extract the daysBack value from the user's request (default 7). Call cwCheckSession — if the session is valid, call cwAuthComplete(daysBack) immediately. If not, call cwLogin. If OTP is required, tell the user 'Please enter the verification code sent to your email.' and WAIT for their reply. When they provide the code, call cwSubmitOtp(otp). After authentication succeeds call cwAuthComplete(daysBack). Then STOP — do NOT call any other actions."
      : activeAgent === "cw-navigator"
      ? `You are the CW Navigator agent. Authentication is complete. IMMEDIATELY call cwNavigateToTransactions, then cwApplyDateFilter(${navDaysBack}), then cwExtractTransactions, then cwNavigationComplete. The system will automatically switch to the Reporter. Do NOT call any switch actions.`
      : "You are the CW Reporter agent. IMMEDIATELY call cwGetRunData to retrieve the extracted transactions. Analyze the data for errors across all status/result/code fields. Call cwSaveReport(report) with your full markdown analysis. Then call uiReportComplete(report). Present the complete error analysis to the user.";

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-8 pb-4 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-4">
            <Monitor className="w-3.5 h-3.5 text-primary animate-pulse" />
            <span className="text-xs font-medium text-foreground/70 tracking-wide">
              Playwright Automation · CommonWell Portal · Gemini 2.5 Flash
            </span>
          </div>
          <h1
            className="text-3xl md:text-4xl font-bold tracking-tight mb-2"
            style={{ fontFamily: "var(--font-display)" }}
          >
            CommonWell{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">
              Recorder
            </span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-lg mx-auto">
            Automated transaction log extraction and error analysis for the
            CommonWell Health Alliance portal.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-3 mt-4"
        >
          {[
            { icon: Shield, label: "Auto Login + OTP" },
            { icon: Navigation, label: "DOM Table Extraction" },
            { icon: FileText, label: "Error Analysis" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary/30 border border-border/50 text-xs text-muted-foreground"
            >
              <Icon className="w-3 h-3 text-primary" />
              {label}
            </div>
          ))}
        </motion.div>

        <div className="mt-4">
          <AgentStepper currentAgent={activeAgent} />
        </div>
      </div>

      <div className="flex-1 overflow-hidden px-4 pb-4">
        <div className="h-full rounded-2xl border border-border overflow-hidden bg-card/30 backdrop-blur-sm flex flex-col">
          <div className={`flex-1 overflow-hidden ${otpMode ? "copilot-otp-mode" : ""}`}>
            <CopilotChat
              labels={{
                title: "CW Recorder Agent",
                initial:
                  "Hi! I'm your CommonWell Recorder agent.\n\nI'll log into the CommonWell portal, extract transaction logs, and analyze errors for you.\n\nTry: *\"Get last 7 days of transaction errors\"*",
                placeholder: otpMode ? "Enter OTP code..." : "e.g. Get last 7 days of transaction errors...",
              }}
              instructions={chatInstructions}
              className="h-full"
            />
          </div>

          <AnimatePresence>
            {otpMode && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="border-t border-border bg-card/80 backdrop-blur-sm p-4"
              >
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
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="border-t border-border bg-card/80 backdrop-blur-sm p-4"
              >
                <button
                  onClick={handleRunAgain}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  Run Again ({navDaysBack} days)
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
