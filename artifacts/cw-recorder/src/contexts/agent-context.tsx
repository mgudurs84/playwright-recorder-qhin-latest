import { createContext, useContext, useState, ReactNode } from "react";

type CwAgentName = "cw-auth" | "cw-navigator" | "cw-reporter";

interface CwAgentContextValue {
  activeAgent: CwAgentName;
  setActiveAgent: (agent: CwAgentName) => void;
}

const CwAgentContext = createContext<CwAgentContextValue>({
  activeAgent: "cw-auth",
  setActiveAgent: () => {},
});

export function CwAgentProvider({ children }: { children: ReactNode }) {
  const [activeAgent, setActiveAgent] = useState<CwAgentName>("cw-auth");
  return (
    <CwAgentContext.Provider value={{ activeAgent, setActiveAgent }}>
      {children}
    </CwAgentContext.Provider>
  );
}

export function useActiveCwAgent() {
  return useContext(CwAgentContext);
}
