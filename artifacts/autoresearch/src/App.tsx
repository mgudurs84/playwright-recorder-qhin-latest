import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopilotKit } from "@copilotkit/react-core";
import { Layout } from "@/components/layout";
import Home from "@/pages/home";
import Session from "@/pages/session";
import NotFound from "@/pages/not-found";
import "@copilotkit/react-ui/styles.css";
import { AgentProvider, useActiveAgent } from "@/contexts/agent-context";

const queryClient = new QueryClient();

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const COPILOTKIT_URL = `${BASE}/api/copilotkit`;

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/session/:id" component={Session} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function CopilotKitWrapper({ children }: { children: React.ReactNode }) {
  const { activeAgent } = useActiveAgent();
  return (
    <CopilotKit runtimeUrl={COPILOTKIT_URL} agent={activeAgent}>
      {children}
    </CopilotKit>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AgentProvider>
          <CopilotKitWrapper>
            <WouterRouter base={BASE}>
              <Router />
            </WouterRouter>
            <Toaster />
          </CopilotKitWrapper>
        </AgentProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
