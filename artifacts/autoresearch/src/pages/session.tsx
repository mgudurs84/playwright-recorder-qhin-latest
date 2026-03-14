import React, { useMemo } from 'react';
import { useParams, Link } from 'wouter';
import { useGetResearchSession } from '@workspace/api-client-react';
import { useResearchStream } from '@/hooks/use-research-stream';
import { ResearchStepCard } from '@/components/research-step';
import { ArrowLeft, Loader2, Target, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Session() {
  const { id } = useParams<{ id: string }>();
  
  // Fetch initial session state
  const { 
    data: session, 
    isLoading: isSessionLoading,
    error: sessionError
  } = useGetResearchSession(id ?? "", {
    query: {
      enabled: !!id,
      refetchOnWindowFocus: false,
    }
  });

  // Only stream if session is not already complete/error
  const shouldStream = session && session.status !== 'complete' && session.status !== 'error';
  
  const { 
    streamedSteps, 
    isStreaming, 
    error: streamError 
  } = useResearchStream(id, !!shouldStream);

  // Combine DB steps with live streamed steps
  // Avoid duplicate rendering by checking timestamp + type combination
  const combinedSteps = useMemo(() => {
    if (!session) return [];
    const dbSteps = session.steps || [];
    
    const allSteps = [...dbSteps];
    const seen = new Set(dbSteps.map(s => `${s.type}-${s.timestamp}`));
    
    for (const step of streamedSteps) {
      const key = `${step.type}-${step.timestamp}`;
      if (!seen.has(key)) {
        allSteps.push(step);
        seen.add(key);
      }
    }
    
    // If the session object itself has a report but no 'complete' step exists,
    // inject a synthetic complete step so the UI renders the report.
    const hasCompleteStep = allSteps.some(s => s.type === 'complete');
    if (session.status === 'complete' && session.report && !hasCompleteStep) {
      allSteps.push({
        type: 'complete',
        content: session.report,
        timestamp: session.completedAt || new Date().toISOString()
      });
    }

    return allSteps;
  }, [session, streamedSteps]);

  if (isSessionLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="font-display tracking-widest uppercase text-sm">Loading Session...</p>
      </div>
    );
  }

  if (sessionError || !session) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>
        <h2 className="text-2xl font-display font-bold mb-2">Session Not Found</h2>
        <p className="text-muted-foreground mb-8">The research session you're looking for doesn't exist or an error occurred.</p>
        <Link href="/">
          <span className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Go Back Home
          </span>
        </Link>
      </div>
    );
  }

  const isActuallyRunning = isStreaming || session.status === 'running' || session.status === 'pending';

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
      
      {/* Header section */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-12 space-y-6"
      >
        <div className="flex items-center gap-3 text-sm font-medium">
          <span className="px-3 py-1 rounded-full bg-secondary text-muted-foreground border border-border">
            Session ID: <span className="font-mono">{session.id.slice(0,8)}</span>
          </span>
          {isActuallyRunning ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Research in Progress
            </span>
          ) : session.status === 'complete' ? (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Research Complete
            </span>
          ) : (
            <span className="flex items-center gap-2 px-3 py-1 rounded-full bg-destructive/10 text-destructive border border-destructive/20">
              <AlertCircle className="w-3 h-3" />
              Failed
            </span>
          )}
        </div>

        <h1 className="text-3xl md:text-4xl font-display font-bold text-foreground leading-tight">
          {session.topic}
        </h1>
      </motion.div>

      {streamError && (
        <div className="mb-8 p-4 rounded-xl bg-destructive/10 border border-destructive/20 flex items-start gap-3 text-destructive">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-bold">Stream Connection Error</h4>
            <p className="text-sm opacity-90">{streamError}</p>
          </div>
        </div>
      )}

      {/* Steps Timeline */}
      <div className="relative mt-8">
        
        {combinedSteps.length === 0 && isActuallyRunning && (
          <div className="flex items-center gap-4 p-6 rounded-2xl border border-border bg-secondary/10">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
            <p className="text-muted-foreground">Initializing research agent and planning approach...</p>
          </div>
        )}

        <div className="space-y-0">
          {combinedSteps.map((step, index) => {
            const isLast = index === combinedSteps.length - 1;
            // A step is considered "active" if it's the last one AND the overall process is still running.
            // If it's the complete step or error step, it's not "active" in the loading sense.
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
        </div>

        {/* Global Loading Indicator at the bottom if still streaming but waiting for next step */}
        {isActuallyRunning && combinedSteps.length > 0 && combinedSteps[combinedSteps.length - 1].type !== 'complete' && combinedSteps[combinedSteps.length - 1].type !== 'error' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center mt-12 mb-8"
          >
            <div className="flex items-center gap-3 px-5 py-2.5 rounded-full bg-background border border-border shadow-lg shadow-black/50">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
              <span className="text-sm font-medium text-muted-foreground tracking-wide uppercase">Agent Working...</span>
            </div>
          </motion.div>
        )}

      </div>
    </div>
  );
}
