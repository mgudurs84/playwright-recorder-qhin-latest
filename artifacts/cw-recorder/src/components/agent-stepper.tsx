import { Shield, Navigation, FileText, Check } from "lucide-react";

interface AgentStepperProps {
  currentAgent: "cw-auth" | "cw-navigator" | "cw-reporter" | "complete";
}

const steps = [
  { id: "cw-auth", label: "Auth", icon: Shield },
  { id: "cw-navigator", label: "Navigate", icon: Navigation },
  { id: "cw-reporter", label: "Report", icon: FileText },
] as const;

export function AgentStepper({ currentAgent }: AgentStepperProps) {
  const currentIdx =
    currentAgent === "complete"
      ? 3
      : steps.findIndex((s) => s.id === currentAgent);

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-3 bg-card/50 rounded-xl border border-border/50">
      {steps.map((step, idx) => {
        const isActive = idx === currentIdx;
        const isDone = idx < currentIdx;
        const Icon = step.icon;

        return (
          <div key={step.id} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isDone
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : isActive
                  ? "bg-primary/10 text-primary border border-primary/20 animate-pulse"
                  : "bg-secondary/30 text-muted-foreground border border-transparent"
              }`}
            >
              {isDone ? (
                <Check className="w-3 h-3" />
              ) : (
                <Icon className="w-3 h-3" />
              )}
              {step.label}
            </div>
            {idx < steps.length - 1 && (
              <div
                className={`w-6 h-0.5 rounded-full ${
                  idx < currentIdx ? "bg-primary/50" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
