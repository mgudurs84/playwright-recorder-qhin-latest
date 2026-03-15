import { useEffect } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction } from "@copilotkit/react-core";
import { Shield, Navigation, FileText, Monitor } from "lucide-react";
import { motion } from "framer-motion";
import { useActiveCwAgent } from "@/contexts/agent-context";
import { AgentStepper } from "@/components/agent-stepper";

export default function Home() {
  const { activeAgent, setActiveAgent } = useActiveCwAgent();

  useEffect(() => {
    setActiveAgent("cw-auth");
  }, [setActiveAgent]);

  useCopilotAction({
    name: "uiSwitchToNavigator",
    description: "Switches to the Navigator agent after auth is complete",
    parameters: [
      { name: "runId", type: "string", required: true },
    ],
    handler: async () => {
      setActiveAgent("cw-navigator");
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
      return null;
    },
  });

  useCopilotAction({
    name: "uiSwitchToReporter",
    description: "Switches to the Reporter agent after navigation and extraction are complete",
    parameters: [
      { name: "runId", type: "string", required: true },
    ],
    handler: async () => {
      setActiveAgent("cw-reporter");
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
      return null;
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
      return null;
    },
  });

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
        <div className="h-full rounded-2xl border border-border overflow-hidden bg-card/30 backdrop-blur-sm">
          <CopilotChat
            labels={{
              title: "CW Recorder Agent",
              initial:
                "Hi! I'm your CommonWell Recorder agent.\n\nI'll log into the CommonWell portal, extract transaction logs, and analyze errors for you.\n\nTry: *\"Get last 7 days of transaction errors\"*",
              placeholder: "e.g. Get last 7 days of transaction errors...",
            }}
            instructions="You are the CW Recorder agent. When the user asks to fetch transaction data, start with cwStartRun to create a run, then cwCheckSession to check for a saved session, then cwLogin if needed. After authentication, navigate and extract data. Finally, analyze and report errors. Always show screenshots when available."
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}
