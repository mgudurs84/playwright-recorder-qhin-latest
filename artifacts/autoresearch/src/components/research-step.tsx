import React from 'react';
import { motion } from 'framer-motion';
import { ResearchStep } from '@workspace/api-client-react';
import { MarkdownRenderer } from './markdown-renderer';
import { 
  CheckCircle2, 
  Search, 
  BookOpen, 
  BrainCircuit, 
  AlertCircle,
  Loader2,
  ExternalLink,
  Target
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ResearchStepCardProps {
  step: ResearchStep;
  isLast: boolean;
  isActive: boolean;
}

export function ResearchStepCard({ step, isLast, isActive }: ResearchStepCardProps) {
  
  const getStepConfig = () => {
    switch (step.type) {
      case 'planning':
        return {
          icon: Target,
          color: 'text-accent',
          bg: 'bg-accent/10',
          border: 'border-accent/20',
          title: 'Planning & Decomposition'
        };
      case 'searching':
        return {
          icon: Search,
          color: 'text-blue-400',
          bg: 'bg-blue-400/10',
          border: 'border-blue-400/20',
          title: 'Gathering Information'
        };
      case 'reading':
        return {
          icon: BookOpen,
          color: 'text-amber-400',
          bg: 'bg-amber-400/10',
          border: 'border-amber-400/20',
          title: 'Analyzing Sources'
        };
      case 'synthesizing':
        return {
          icon: BrainCircuit,
          color: 'text-primary',
          bg: 'bg-primary/10',
          border: 'border-primary/20',
          title: 'Synthesizing Intelligence'
        };
      case 'complete':
        return {
          icon: CheckCircle2,
          color: 'text-emerald-400',
          bg: 'bg-emerald-400/10',
          border: 'border-emerald-400/20',
          title: 'Final Report Generation'
        };
      case 'error':
        return {
          icon: AlertCircle,
          color: 'text-destructive',
          bg: 'bg-destructive/10',
          border: 'border-destructive/20',
          title: 'Process Error'
        };
      default:
        return {
          icon: Loader2,
          color: 'text-muted-foreground',
          bg: 'bg-secondary',
          border: 'border-border',
          title: 'Processing...'
        };
    }
  };

  const config = getStepConfig();
  const Icon = config.icon;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="relative flex gap-6 pb-12 last:pb-0"
    >
      {/* Timeline connector line */}
      {!isLast && (
        <div className="absolute left-[1.375rem] top-12 bottom-0 w-px bg-gradient-to-b from-border to-transparent z-0" />
      )}
      
      {/* Icon node */}
      <div className="relative z-10 shrink-0">
        <div className={cn(
          "w-11 h-11 rounded-2xl flex items-center justify-center border shadow-lg transition-all duration-500",
          config.bg, config.border,
          isActive ? "shadow-[0_0_20px_rgba(0,0,0,0)]" : "",
          isActive && step.type === 'searching' ? "animate-pulse" : ""
        )}>
          {isActive && step.type !== 'complete' && step.type !== 'error' ? (
            <Loader2 className={cn("w-5 h-5 animate-spin", config.color)} />
          ) : (
            <Icon className={cn("w-5 h-5", config.color)} />
          )}
        </div>
      </div>

      {/* Content Card */}
      <div className={cn(
        "flex-1 rounded-2xl border p-6 transition-all duration-500",
        isActive 
          ? "bg-secondary/30 border-primary/30 shadow-lg shadow-primary/5" 
          : "bg-secondary/10 border-border shadow-md",
        step.type === 'complete' ? "glass-panel bg-background/50 border-primary/20 shadow-2xl shadow-primary/10" : ""
      )}>
        <div className="flex flex-col gap-4">
          
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 pb-3">
            <h3 className="font-display font-semibold text-lg text-foreground flex items-center gap-2">
              {config.title}
              {isActive && step.type !== 'complete' && step.type !== 'error' && (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-widest font-sans font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                  Active
                </span>
              )}
            </h3>
            <span className="text-xs font-mono text-muted-foreground/60">
              {new Date(step.timestamp).toLocaleTimeString()}
            </span>
          </div>

          {/* Context specifics based on type */}
          {step.subQuestion && (
            <div className="flex items-start gap-3 bg-background/50 rounded-xl p-4 border border-border/50">
              <Search className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-sm font-medium text-foreground/90 font-display">
                "{step.subQuestion}"
              </p>
            </div>
          )}

          {/* Main content area */}
          <div className={cn(
            "text-sm text-muted-foreground leading-relaxed",
            step.type === 'complete' && "text-base text-foreground mt-2"
          )}>
            {step.type === 'complete' ? (
              <MarkdownRenderer content={step.content} />
            ) : (
              <p className="font-mono text-xs p-3 rounded-lg bg-background border border-border/50 shadow-inner">
                {step.content}
              </p>
            )}
          </div>

          {/* Sources list */}
          {step.sources && step.sources.length > 0 && (
            <div className="mt-2 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                <BookOpen className="w-3.5 h-3.5" /> Sources Discovered
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {step.sources.map((source, idx) => (
                  <a 
                    key={idx} 
                    href={source.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="group flex flex-col gap-1.5 p-3 rounded-xl bg-background border border-border hover:border-primary/50 hover:bg-primary/5 transition-all duration-300"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground group-hover:text-primary line-clamp-1">
                        {source.title}
                      </span>
                      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
                    </div>
                    <span className="text-xs text-muted-foreground/60 line-clamp-1 font-mono break-all">
                      {source.url}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
