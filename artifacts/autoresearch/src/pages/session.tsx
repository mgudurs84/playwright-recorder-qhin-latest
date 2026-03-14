import React, { useMemo } from 'react';
import { useParams, Link } from 'wouter';
import { useGetResearchSession } from '@workspace/api-client-react';
import { useResearchStream } from '@/hooks/use-research-stream';
import { ResearchStepCard } from '@/components/research-step';
import { CopilotPopup } from '@copilotkit/react-ui';
import { useCopilotReadable } from '@copilotkit/react-core';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Session() {
  const { id } = useParams<{ id: string }>();

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

  const shouldStream = session && session.status !== 'complete' && session.status !== 'error';

  const {
    streamedSteps,
    isStreaming,
    error: streamError
  } = useResearchStream(id, !!shouldStream);

  const combinedSteps = useMemo(() => {
    if (!session) return [];
    const dbSteps = (session.steps || []) as any[];
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
    if (session.status === 'complete' && session.report && !hasCompleteStep) {
      allSteps.push({
        type: 'complete',
        content: session.report,
        timestamp: (session as any).completedAt || new Date().toISOString()
      });
    }

    return allSteps;
  }, [session, streamedSteps]);

  useCopilotReadable({
    description: "Current research session state",
    value: session ? {
      topic: session.topic,
      status: session.status,
      stepCount: combinedSteps.length,
      latestStep: combinedSteps[combinedSteps.length - 1]?.type || "none",
    } : null,
  });

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

  const isActuallyRunning = isStreaming || session.status === 'running' || session.status === 'pending';

  return (
    <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12 pb-24">

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10 space-y-4"
      >
        <Link href="/">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <ArrowLeft className="w-4 h-4" /> New Research
          </span>
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <span className="px-3 py-1 rounded-full bg-secondary text-muted-foreground border border-border text-xs font-mono">
            {session.id.slice(0, 8)}
          </span>
          {isActuallyRunning ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 text-xs">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Research in Progress
            </span>
          ) : session.status === 'complete' ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Complete
            </span>
          ) : (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-destructive/10 text-destructive border border-destructive/20 text-xs">
              <AlertCircle className="w-3 h-3" /> Failed
            </span>
          )}
        </div>

        <h1 className="text-3xl md:text-4xl font-bold text-foreground leading-tight">
          {session.topic}
        </h1>
      </motion.div>

      {streamError && (
        <div className="mb-8 p-4 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-3 text-destructive text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Stream Error</p>
            <p className="opacity-90">{streamError}</p>
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-0">
        {combinedSteps.length === 0 && isActuallyRunning && (
          <div className="flex items-center gap-4 p-6 rounded-2xl border border-border bg-secondary/10">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
            <p className="text-muted-foreground text-sm">Initializing research agent...</p>
          </div>
        )}

        {combinedSteps.map((step: any, index: number) => {
          const isLast = index === combinedSteps.length - 1;
          const isActive = isLast && isActuallyRunning && step.type !== 'complete' && step.type !== 'error';
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
          combinedSteps[combinedSteps.length - 1].type !== 'complete' &&
          combinedSteps[combinedSteps.length - 1].type !== 'error' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center mt-12 mb-8"
          >
            <div className="flex items-center gap-3 px-5 py-2.5 rounded-full bg-background border border-border shadow-lg">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span className="text-sm font-medium text-muted-foreground tracking-wide uppercase">Agent Working...</span>
            </div>
          </motion.div>
        )}
      </div>

      {/* CopilotKit floating chat popup for mid-research interaction */}
      <CopilotPopup
        labels={{
          title: "Research Agent",
          initial: `I'm actively researching "${session.topic}". Ask me to dig deeper into any area, clarify a finding, or adjust the research direction.`,
          placeholder: "Ask me to adjust the research...",
        }}
        instructions={`You are helping with an active research session on "${session.topic}" (session ID: ${id}). The user can ask you to add more steps, dig deeper into specific sub-questions, or synthesize findings. Use addResearchStep to add findings directly to this session.`}
        defaultOpen={false}
      />
    </div>
  );
}
