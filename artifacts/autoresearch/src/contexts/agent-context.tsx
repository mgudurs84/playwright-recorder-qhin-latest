import { createContext, useContext, useState, ReactNode } from "react";

type AgentName = "planner" | "searcher" | "synthesizer";

interface AgentContextValue {
  activeAgent: AgentName;
  setActiveAgent: (agent: AgentName) => void;
}

const AgentContext = createContext<AgentContextValue>({
  activeAgent: "planner",
  setActiveAgent: () => {},
});

export function AgentProvider({ children }: { children: ReactNode }) {
  const [activeAgent, setActiveAgent] = useState<AgentName>("planner");
  return (
    <AgentContext.Provider value={{ activeAgent, setActiveAgent }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useActiveAgent() {
  return useContext(AgentContext);
}
