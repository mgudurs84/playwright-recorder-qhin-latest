import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopilotKit } from "@copilotkit/react-core";
import { Layout } from "@/components/layout";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";
import "@copilotkit/react-ui/styles.css";

const queryClient = new QueryClient();

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CW_COPILOTKIT_URL = `${BASE}/api/cw-copilotkit`;

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CopilotKit runtimeUrl={CW_COPILOTKIT_URL} agent="cw-combined">
          <WouterRouter base={BASE}>
            <Layout>
              <Switch>
                <Route path="/" component={Home} />
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </WouterRouter>
          <Toaster />
        </CopilotKit>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
