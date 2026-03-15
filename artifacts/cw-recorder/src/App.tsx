import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopilotKit } from "@copilotkit/react-core";
import { Layout } from "@/components/layout";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";
import "@copilotkit/react-ui/styles.css";
import { CwAgentProvider, useActiveCwAgent } from "@/contexts/agent-context";

const queryClient = new QueryClient();

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CW_COPILOTKIT_URL = `${BASE}/api/cw-copilotkit`;

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function CopilotKitWrapper({ children }: { children: React.ReactNode }) {
  const { activeAgent } = useActiveCwAgent();
  return (
    <CopilotKit runtimeUrl={CW_COPILOTKIT_URL} agent={activeAgent}>
      {children}
    </CopilotKit>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CwAgentProvider>
          <CopilotKitWrapper>
            <WouterRouter base={BASE}>
              <Router />
            </WouterRouter>
            <Toaster />
          </CopilotKitWrapper>
        </CwAgentProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
