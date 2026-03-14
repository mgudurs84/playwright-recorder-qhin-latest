import React, { useMemo, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'wouter';
import { useGetResearchSession } from '@workspace/api-client-react';
import { useResearchStream } from '@/hooks/use-research-stream';
import { ResearchStepCard } from '@/components/research-step';
import { CopilotPopup } from '@copilotkit/react-ui';
import { useCopilotReadable } from '@copilotkit/react-core';
import { useActiveAgent } from '@/contexts/agent-context';
import { ArrowLeft, Loader2, AlertCircle, PlayCircle, SkipForward, FlaskConical, BrainCircuit, Search, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function updateSessionPhase(sessionId: string, phase: string, currentAgent: string) {
  await fetch(`${BASE}/api/research/sessions/${sessionId}/phase`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase, currentAgent }),
  });
}

const AGENT_ICONS: Record<string, React.ElementType> = {
  planner: BrainCircuit,
  searcher: Search,
  synthesizer: FileText,
};

const AGENT_LABELS: Record<string, string> = {
  planner: "Planner",
  searcher: "Searcher",
  synthesizer: "Synthesizer",
};

const STATUS_AGENT_MAP: Record<string, string> = {
  planning: "planner",
  planning_paused: "planner",
  searching: "searcher",
  search_paused: "searcher",
  synthesis_ready: "synthesizer",
  synthesizing: "synthesizer",
  complete: "synthesizer",
  error: "planner",
};

function AgentPhaseBadge({ agent, status }: { agent: string; status: string }) {
  const Icon = AGENT_ICONS[agent] || BrainCircuit;
  const isActive = !["planning_paused", "search_paused", "complete", "error"].includes(status);
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-full bg-background border border-border shadow-sm">
      <Icon className="w-3.5 h-3.5 text-primary" />
      <span className="text-xs font-medium text-foreground/70 tracking-wide uppercase">
        {AGENT_LABELS[agent] || agent} Agent
      </span>
      {isActive && status !== "complete" && (
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
      )}
    </div>
  );
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const { setActiveAgent } = useActiveAgent();
  const [isHandingOff, setIsHandingOff] = useState(false);

  const {
    data: session,
    isLoading: isSessionLoading,
    error: sessionError,
    refetch,
  } = useGetResearchSession(id ?? "", {
    query: {
      enabled: !!id,
      refetchInterval: 3000,
      refetchOnWindowFocus: false,
    }
  });

  const currentStatus = (session as any)?.status ?? "pending";
  const currentAgent = ((session as any)?.currentAgent as string) ?? "planner";
  const synthAutoTriggered = useRef(false);

  useEffect(() => {
    if (!session) return;
    const mappedAgent = STATUS_AGENT_MAP[currentStatus];
    if (mappedAgent) {
      setActiveAgent(mappedAgent as any);
    }
  }, [currentStatus, setActiveAgent]);

  const shouldStream = session && !["complete", "error"].includes(currentStatus);

  const {
    streamedSteps,
    isStreaming,
    error: streamError
  } = useResearchStream(id, !!shouldStream);

  const combinedSteps = useMemo(() => {
    if (!session) return [];
    const dbSteps = ((session as any).steps || []) as any[];
    const allSteps = [...dbSteps];
    const seen = new Set(dbSteps.map((s: any) => `${s.type}-${s.timestamp}`));

    for (const step of streamedSteps) {
      const key = `${step.type}-${step.timestamp}`;
      if (!seen.has(key)) {
        allSteps.push(step);
        seen.add(key);
      }
    }

    const hasCompleteStep = allSteps.some((s: any) => s.type === 'complete');
    if (currentStatus === 'complete' && (session as any).report && !hasCompleteStep) {
      allSteps.push({
        type: 'complete',
        content: (session as any).report,
        timestamp: (session as any).completedAt || new Date().toISOString()
      });
    }

    return allSteps;
  }, [session, streamedSteps, currentStatus]);

  useCopilotReadable({
    description: "Current research session state",
    value: session ? {
      sessionId: id,
      topic: (session as any).topic,
      status: currentStatus,
      currentAgent,
      stepCount: combinedSteps.length,
      latestStep: combinedSteps[combinedSteps.length - 1]?.type || "none",
      planContent: combinedSteps.find((s: any) => s.type === "planning")?.content || null,
    } : null,
  });

  const planStep = combinedSteps.find((s: any) => s.type === "planning");
  const searchSteps = combinedSteps.filter((s: any) => ["searching", "reading"].includes(s.type));
  const isActuallyRunning = isStreaming ||
    ["planning", "searching", "synthesizing"].includes(currentStatus);

  const handleApproveAndSearch = async () => {
    if (!id) return;
    setIsHandingOff(true);
    try {
      await updateSessionPhase(id, "searching", "searcher");
      setActiveAgent("searcher");
      await refetch();
    } finally {
      setIsHandingOff(false);
    }
  };

  const handleContinueSearch = async () => {
    if (!id) return;
    setIsHandingOff(true);
    try {
      await updateSessionPhase(id, "searching", "searcher");
      setActiveAgent("searcher");
      await refetch();
    } finally {
      setIsHandingOff(false);
    }
  };

  const handleStartSynthesis = async () => {
    if (!id) return;
    setIsHandingOff(true);
    try {
      await updateSessionPhase(id, "synthesizing", "synthesizer");
      setActiveAgent("synthesizer");
      await refetch();
    } finally {
      setIsHandingOff(false);
    }
  };

  if (isSessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm tracking-widest uppercase">Loading Session...</p>
      </div>
    );
  }

  if (sessionError || !session) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>
        <h2 className="text-2xl font-bold mb-2">Session Not Found</h2>
        <p className="text-muted-foreground mb-8">This research session doesn't exist or an error occurred.</p>
        <Link href="/">
          <span className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Start New Research
          </span>
        </Link>
      </div>
    );
  }

  const agentInstructions = currentAgent === "planner"
    ? `You are the Planner agent helping with research on "${(session as any).topic}" (session: ${id}). You have already created a plan. If the user asks for changes, update the plan and call completePlanning again.`
    : currentAgent === "searcher"
    ? `You are the Searcher agent for session ${id} on "${(session as any).topic}". The plan has been approved. Continue researching sub-questions using addResearchStep. The plan is: ${planStep?.content || "see session steps"}. Call pauseResearch after 2 questions, then completeSearching when all done.`
    : `You are the Synthesizer agent for session ${id} on "${(session as any).topic}". All research is done. Call getResearchSession(${id}) to see the findings, then write the final report using addResearchStep with type="synthesizing" then type="complete".`;

  return (
    <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12 pb-32">

      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-10 space-y-4">
        <Link href="/">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <ArrowLeft className="w-4 h-4" /> New Research
          </span>
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <span className="px-3 py-1 rounded-full bg-secondary text-muted-foreground border border-border text-xs font-mono">
            {(session as any).id?.slice(0, 8)}
          </span>

          {currentStatus === "complete" ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Complete
            </span>
          ) : currentStatus === "error" ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-destructive/10 text-destructive border border-destructive/20 text-xs">
              <AlertCircle className="w-3 h-3" /> Failed
            </span>
          ) : (
            <AgentPhaseBadge agent={currentAgent} status={currentStatus} />
          )}
        </div>

        <h1 className="text-3xl md:text-4xl font-bold text-foreground leading-tight">
          {(session as any).topic}
        </h1>

        <div className="flex items-center gap-2 mt-2">
          {(["planner", "searcher", "synthesizer"] as const).map((agent, i) => {
            const Icon = AGENT_ICONS[agent];
            const agentStatuses: Record<string, string[]> = {
              planner: ["planning", "planning_paused"],
              searcher: ["searching", "search_paused", "synthesis_ready"],
              synthesizer: ["synthesizing", "complete"],
            };
            const isDone = agentStatuses[agent]?.some(s =>
              currentStatus === "complete" ? true : s === currentStatus
            ) || (agent === "planner" && !["planning", "pending"].includes(currentStatus));
            const isCurrentAgent = currentAgent === agent && currentStatus !== "complete";
            return (
              <React.Fragment key={agent}>
                {i > 0 && <div className={`flex-1 h-px ${isDone ? "bg-primary/50" : "bg-border"}`} />}
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                  isCurrentAgent
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : isDone
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
                    : "bg-secondary/30 border-border/50 text-muted-foreground"
                }`}>
                  <Icon className="w-3 h-3" />
                  {AGENT_LABELS[agent]}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </motion.div>

      {streamError && (
        <div className="mb-8 p-4 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-3 text-destructive text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div><p className="font-bold">Stream Error</p><p className="opacity-90">{streamError}</p></div>
        </div>
      )}

      <div className="space-y-0">
        {combinedSteps.length === 0 && isActuallyRunning && (
          <div className="flex items-center gap-4 p-6 rounded-2xl border border-border bg-secondary/10">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
            <p className="text-muted-foreground text-sm">Agent working...</p>
          </div>
        )}

        {combinedSteps.map((step: any, index: number) => {
          const isLast = index === combinedSteps.length - 1;
          const isActive = isLast && isActuallyRunning && !["complete", "error"].includes(step.type);
          return (
            <ResearchStepCard
              key={`${step.type}-${step.timestamp}-${index}`}
              step={step}
              isLast={isLast}
              isActive={isActive}
            />
          );
        })}

        {isActuallyRunning && combinedSteps.length > 0 &&
          !["complete", "error"].includes(combinedSteps[combinedSteps.length - 1]?.type) && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-center mt-12 mb-8">
            <div className="flex items-center gap-3 px-5 py-2.5 rounded-full bg-background border border-border shadow-lg">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span className="text-sm font-medium text-muted-foreground tracking-wide uppercase">Agent Working...</span>
            </div>
          </motion.div>
        )}
      </div>

      <AnimatePresence>
        {currentStatus === "planning_paused" && planStep && (
          <motion.div
            key="approve-plan"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4"
          >
            <div className="bg-background border border-primary/30 rounded-2xl shadow-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Plan ready — your turn</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Review the plan above. You can ask the Planner agent to revise it via the chat, or approve it to start searching.
              </p>
              <button
                onClick={handleApproveAndSearch}
                disabled={isHandingOff}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isHandingOff ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                Approve Plan &amp; Start Searching
              </button>
            </div>
          </motion.div>
        )}

        {currentStatus === "search_paused" && (
          <motion.div
            key="continue-search"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4"
          >
            <div className="bg-background border border-primary/30 rounded-2xl shadow-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Mid-research check-in</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The Searcher has covered the first sub-questions. Does the direction look right? Use the chat to redirect or click Continue to finish remaining questions.
              </p>
              <button
                onClick={handleContinueSearch}
                disabled={isHandingOff}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isHandingOff ? <Loader2 className="w-4 h-4 animate-spin" /> : <SkipForward className="w-4 h-4" />}
                Continue Research
              </button>
            </div>
          </motion.div>
        )}

        {currentStatus === "synthesis_ready" && (
          <motion.div
            key="start-synthesis"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4"
          >
            <div className="bg-background border border-emerald-500/30 rounded-2xl shadow-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-foreground">All research complete — ready to synthesize</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                All sub-questions have been researched. The Synthesizer will now write your comprehensive report.
              </p>
              <button
                onClick={handleStartSynthesis}
                disabled={isHandingOff}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {isHandingOff ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Generate Final Report
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CopilotPopup
        labels={{
          title: `${AGENT_LABELS[currentAgent] || "Research"} Agent`,
          initial: currentAgent === "planner"
            ? `I'm the Planner for "${(session as any).topic}". Ask me to revise the plan or adjust the sub-questions.`
            : currentAgent === "searcher"
            ? `I'm the Searcher for "${(session as any).topic}" (session: ${id}). I'll investigate each sub-question and save findings. Type "continue" to resume after a pause.`
            : `I'm the Synthesizer for "${(session as any).topic}" (session: ${id}). Type "start" and I'll write your comprehensive report from all the research findings.`,
          placeholder: currentAgent === "planner"
            ? "Ask me to change the plan..."
            : currentAgent === "searcher"
            ? 'Type "continue" to keep researching...'
            : 'Type "start" to write the report...',
        }}
        instructions={agentInstructions}
        defaultOpen={["planning_paused", "search_paused", "synthesis_ready", "searching", "synthesizing"].includes(currentStatus)}
      />
    </div>
  );
}
