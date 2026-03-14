import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { registerCopilotKitRoute, registerCopilotKitInfoRoute, initializeRuntime } from "./routes/copilotkit";
import { registerAgentsRoute } from "./routes/agents";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

registerCopilotKitInfoRoute(app);
registerCopilotKitRoute(app);
registerAgentsRoute(app);

app.use("/api", router);

export { initializeRuntime };
export default app;
