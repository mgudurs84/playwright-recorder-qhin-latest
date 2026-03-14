import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { CopilotChat } from '@copilotkit/react-ui';
import { useCopilotAction } from '@copilotkit/react-core';
import { useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, Globe, FileText, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { useActiveAgent } from '@/contexts/agent-context';

export default function Home() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { setActiveAgent } = useActiveAgent();

  useEffect(() => {
    setActiveAgent("planner");
  }, [setActiveAgent]);

  const [lastSessionId, setLastSessionId] = useState<string | null>(null);

  useCopilotAction({
    name: "startResearch",
    description: "Navigates to the research session page when a session is started",
    parameters: [
      {
        name: "sessionId",
        type: "string",
        description: "The research session ID returned from the backend",
        required: true,
      },
    ],
    handler: async ({ sessionId }) => {
      setLastSessionId(sessionId);
      queryClient.invalidateQueries({ queryKey: ["listResearchSessions"] });
      setLocation(`/session/${sessionId}`);
      return { navigated: true };
    },
    render: ({ status, args }) => {
      if (status === "executing" || status === "complete") {
        return (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20 text-primary text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Opening research session...
          </div>
        );
      }
      return null;
    },
  });

  return (
    <div className="flex flex-col h-full">
      {/* Hero header */}
      <div className="px-6 pt-8 pb-4 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-4">
            <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
            <span className="text-xs font-medium text-foreground/70 tracking-wide">
              Powered by Vertex AI Gemini 2.5 Flash · Human-in-the-Loop
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            Research <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Anything</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-lg mx-auto">
            Your AI research agent breaks down any topic, asks clarifying questions at each step, and synthesizes a comprehensive report.
          </p>
        </motion.div>

        {/* Feature pills */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="flex flex-wrap items-center justify-center gap-3 mt-4"
        >
          {[
            { icon: BrainCircuit, label: "Intelligent Planning" },
            { icon: Globe, label: "Multi-Step Research" },
            { icon: FileText, label: "Markdown Report" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary/30 border border-border/50 text-xs text-muted-foreground">
              <Icon className="w-3 h-3 text-primary" />
              {label}
            </div>
          ))}
        </motion.div>
      </div>

      {/* CopilotKit Chat */}
      <div className="flex-1 overflow-hidden px-4 pb-4">
        <div className="h-full rounded-2xl border border-border overflow-hidden bg-card/30 backdrop-blur-sm">
          <CopilotChat
            labels={{
              title: "AutoResearch Agent",
              initial: "Hi! I'm your autonomous research agent powered by Gemini 2.5 Flash.\n\nJust tell me what you want to research — I'll break the topic into focused sub-questions, gather findings step by step, **pause to ask for your input** at key moments, and produce a comprehensive report.\n\nTry: *\"Research the latest developments in solid-state batteries\"*",
              placeholder: "What would you like to research today?",
            }}
            instructions="You are an AutoResearch agent. When the user asks to research a topic, call the startResearch backend tool, then guide the research step by step using addResearchStep. After starting the research session, also call the frontend startResearch action to navigate the user to the session page."
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}
