import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import os from "os";
import { registerSessionRoutes } from "./routes/session.js";
import { registerAnalyzeRoutes } from "./routes/analyze.js";
import { registerBatchRoutes } from "./routes/batch.js";
import { registerScreenshotRoutes } from "./routes/screenshot.js";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "tx-screenshots");

app.use("/api/screenshots", express.static(SCREENSHOTS_DIR, {
  maxAge: "1h",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "private, max-age=3600");
  },
}));

app.get("/api/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

registerSessionRoutes(app);
registerAnalyzeRoutes(app);
registerBatchRoutes(app);
registerScreenshotRoutes(app);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

export default app;
