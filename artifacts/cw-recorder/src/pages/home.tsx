import { useEffect, useRef, useState, useCallback } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotChat } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import { Shield, Navigation, FileText, Monitor, KeyRound, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useActiveCwAgent } from "@/contexts/agent-context";
import { AgentStepper } from "@/components/agent-stepper";
import { apiUrl } from "@/lib/utils";

type PendingSwitch =
  | { type: "navigator"; runId: string; daysBack: number }
  | { type: "reporter"; runId: string };

export default function Home() {
  const { activeAgent, setActiveAgent } = useActiveCwAgent();
  const [otpMode, setOtpMode] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [runComplete, setRunComplete] = useState(false);
  const [lastRunParams, setLastRunParams] = useState<{ daysBack: number } | null>(null);

  // Persisted context for instructions per agent
  const [navContext, setNavContext] = useState<{ runId: string; daysBack: number } | null>(null);
  const [repContext, setRepContext] = useState<string | null>(null);

  // Pending agent switch — applied with delay AFTER the current stream ends
  // This avoids disrupting the ongoing streaming connection
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);

  // Ref to always access current activeAgent in handlers without stale closures
  const activeAgentRef = useRef(activeAgent);
  useEffect(() => { activeAgentRef.current = activeAgent; }, [activeAgent]);

  useEffect(() => {
    setActiveAgent("cw-auth");
    setRunComplete(false);
    setOtpMode(false);
  }, [setActiveAgent]);

  const { appendMessage, reset } = useCopilotChat();

  // ─── Delayed agent switch ──────────────────────────────────────────────────
  // When pendingSwitch is set by a handler, wait 800ms for the current
  // agent's streaming response to fully complete, THEN switch the agent.
  useEffect(() => {
    if (!pendingSwitch) return;
    const timer = setTimeout(() => {
      if (pendingSwitch.type === "navigator") {
        const { runId, daysBack } = pendingSwitch;
        setNavContext({ runId, daysBack });
        setActiveAgent("cw-navigator");
        // After agent switch renders, reset message history and send trigger
        setTimeout(() => {
          reset();
          appendMessage(
            new TextMessage({
              id: `nav-trigger-${Date.now()}`,
              role: MessageRole.User,
              content: `Authentication complete. Navigate to Transaction Logs, apply a ${daysBack}-day date filter, and extract all table rows. Run ID: ${runId}`,
            })
          );
        }, 400);
      } else {
        const { runId } = pendingSwitch;
        setRepContext(runId);
        setActiveAgent("cw-reporter");
        // After agent switch renders, reset message history and send trigger
        setTimeout(() => {
          reset();
          appendMessage(
            new TextMessage({
              id: `rep-trigger-${Date.now()}`,
              role: MessageRole.User,
              content: `Extraction complete. Analyze the transaction data and generate the error analysis report. Run ID: ${runId}`,
            })
          );
        }, 400);
      }
      setPendingSwitch(null);
    }, 900);
    return () => clearTimeout(timer);
  }, [pendingSwitch, appendMessage, reset, setActiveAgent]);

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
    setActiveAgent("cw-auth");
    setRunComplete(false);
    setOtpMode(false);
    setNavContext(null);
    setRepContext(null);
    setPendingSwitch(null);
    const days = lastRunParams?.daysBack ?? 7;
    // Clear messages for fresh auth run
    reset();
    await appendMessage(
      new TextMessage({
        id: `rerun-${Date.now()}`,
        role: MessageRole.User,
        content: `Run again — get the last ${days} days of transaction errors`,
      })
    );
  }, [lastRunParams, setActiveAgent, appendMessage, reset]);

  // ─── Frontend Actions ──────────────────────────────────────────────────────

  useCopilotAction({
    name: "uiSwitchToNavigator",
    description: "Switches to the Navigator agent after auth is complete. Pass daysBack so the navigator knows how far back to filter.",
    parameters: [
      { name: "runId", type: "string", required: true },
      { name: "daysBack", type: "number", required: false },
    ],
    handler: async ({ runId, daysBack }) => {
      // Guard: only the auth agent should switch to navigator
      if (activeAgentRef.current !== "cw-auth") {
        console.warn("[uiSwitchToNavigator] Blocked — called from wrong agent:", activeAgentRef.current);
        return { switched: false, blocked: true };
      }
      const days = (daysBack as number) || lastRunParams?.daysBack || 7;
      setLastRunParams({ daysBack: days });
      setOtpMode(false);
      // Don't switch agent here — set pending switch so the useEffect applies it
      // AFTER the current streaming response finishes (avoids MissingToolResultsError)
      setPendingSwitch({ type: "navigator", runId: runId as string, daysBack: days });
      return { switched: true };
    },
    render: ({ status }) => {
      if (status === "executing" || status === "complete") {
        return (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-primary text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Authentication complete — switching to Navigator...
          </div>
        );
      }
      return <></>;
    },
  });

  useCopilotAction({
    name: "uiSwitchToReporter",
    description: "Switches to the Reporter agent after navigation and extraction are complete",
    parameters: [
      { name: "runId", type: "string", required: true },
    ],
    handler: async ({ runId }) => {
      // Guard: only the navigator agent should switch to reporter
      if (activeAgentRef.current !== "cw-navigator") {
        console.warn("[uiSwitchToReporter] Blocked — called from wrong agent:", activeAgentRef.current);
        return { switched: false, blocked: true };
      }
      // Don't switch agent here — set pending switch so the useEffect applies it
      // AFTER the current streaming response finishes (avoids Thread already running)
      setPendingSwitch({ type: "reporter", runId: runId as string });
      return { switched: true };
    },
    render: ({ status }) => {
      if (status === "executing" || status === "complete") {
        return (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-primary text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Extraction complete — switching to Reporter...
          </div>
        );
      }
      return <></>;
    },
  });

  useCopilotAction({
    name: "uiReportComplete",
    description: "Called when the report is saved and the run is complete",
    parameters: [
      { name: "runId", type: "string", required: true },
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
    name: "uiRequestOtp",
    description: "Show the OTP input field when the portal requires a verification code",
    parameters: [
      { name: "screenshotUrl", type: "string", required: false },
    ],
    handler: async () => {
      setOtpMode(true);
      return { otpRequested: true };
    },
    render: ({ status, args }) => {
      if (status === "executing" || status === "complete") {
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm font-medium">
              <KeyRound className="w-4 h-4" />
              OTP verification required — please enter the code below
            </div>
            {args?.screenshotUrl && (
              <img
                src={apiUrl(args.screenshotUrl as string)}
                alt="OTP page screenshot"
                className="w-full rounded-lg border border-border"
              />
            )}
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

  useCopilotAction({
    name: "uiTrackRunParams",
    description: "Track run parameters for Run Again functionality",
    parameters: [
      { name: "daysBack", type: "number", required: true },
    ],
    handler: async ({ daysBack }) => {
      setLastRunParams({ daysBack: daysBack as number });
      return { tracked: true };
    },
  });

  // ─── Per-agent instructions ───────────────────────────────────────────────
  const chatInstructions =
    activeAgent === "cw-auth"
      ? "You are the CW Auth agent. When the user asks for transaction data, extract the daysBack value (default 7). Call cwStartRun(daysBack), then cwCheckSession. If session is valid skip login. If not, call cwLogin, handle OTP with uiRequestOtp. After authentication, call cwAuthComplete then immediately call uiSwitchToNavigator(runId, daysBack). Also call uiTrackRunParams(daysBack)."
      : activeAgent === "cw-navigator"
      ? `You are the CW Navigator agent. Authentication is complete. Run ID: ${navContext?.runId ?? "see trigger message"}. Date range: last ${navContext?.daysBack ?? 7} days. IMMEDIATELY call cwNavigateToTransactions, then cwApplyDateFilter(${navContext?.daysBack ?? 7}), then cwExtractTransactions, then cwNavigationComplete("${navContext?.runId ?? ""}"), then call uiSwitchToReporter("${navContext?.runId ?? ""}"). Do not wait for user input.`
      : `You are the CW Reporter agent. Extraction is complete. Run ID: ${repContext ?? "see trigger message"}. IMMEDIATELY call cwGetRunData("${repContext ?? ""}"), analyze the records for errors (check all status/result/code fields for error patterns), call cwSaveReport("${repContext ?? ""}", report), then call uiReportComplete("${repContext ?? ""}", report). Present the full error analysis to the user.`;

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
                  Run Again{lastRunParams ? ` (${lastRunParams.daysBack} days)` : ""}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
