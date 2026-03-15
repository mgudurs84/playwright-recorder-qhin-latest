import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import router from "./routes";
import { registerCopilotKitRoute, registerCopilotKitInfoRoute, initializeRuntime } from "./routes/copilotkit";
import { registerAgentsRoute } from "./routes/agents";
import { registerCwCopilotKitRoute, registerCwRunsRoute } from "./routes/copilotkit-cw";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api/screenshots", express.static("/tmp/cw-screenshots", {
  maxAge: "1d",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
  },
}));

registerCopilotKitInfoRoute(app);
registerCopilotKitRoute(app);
registerAgentsRoute(app);

registerCwCopilotKitRoute(app);
registerCwRunsRoute(app);

app.use("/api", router);

export { initializeRuntime };
export default app;
