import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { registerCopilotKitRoute, registerCopilotKitInfoRoute } from "./routes/copilotkit";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

registerCopilotKitInfoRoute(app);
registerCopilotKitRoute(app);

app.use("/api", router);


export default app;
