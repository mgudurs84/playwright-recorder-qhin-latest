import { Express } from "express";
import cron from "node-cron";
import {
  loadSnapshots,
  runHourlyCapture,
  getNextRunIn,
  getLastSnapshot,
} from "../services/hourly-monitor";

cron.schedule("0 * * * *", () => {
  console.log("[Hourly Monitor] Scheduled capture starting...");
  runHourlyCapture({ trigger: "scheduled" }).catch(console.error);
});

export function registerHourlyMonitorRoutes(app: Express) {
  app.get("/api/hourly-monitor/status", (_req, res) => {
    const nextRunIn = getNextRunIn();
    const lastSnapshot = getLastSnapshot();
    res.json({ nextRunIn, lastSnapshot });
  });

  app.get("/api/hourly-monitor/snapshots", (_req, res) => {
    const snapshots = loadSnapshots();
    res.json({ snapshots });
  });

  app.get("/api/hourly-monitor/snapshots/:id", (req, res) => {
    const snapshots = loadSnapshots();
    const snap = snapshots.find((s) => s.id === req.params.id);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    res.json(snap);
  });

  app.post("/api/hourly-monitor/trigger", (req, res) => {
    const raw = req.body as { windowHours?: unknown };
    let windowHours = 1;
    if (raw.windowHours !== undefined) {
      const parsed = Number(raw.windowHours);
      if (!isFinite(parsed) || parsed <= 0 || parsed > 168) {
        return res.status(400).json({ error: "windowHours must be a finite positive number ≤ 168" });
      }
      windowHours = parsed;
    }
    const id = Date.now().toString();
    runHourlyCapture({ id, windowHours, trigger: "manual" }).catch(console.error);
    res.status(202).json({ id });
  });
}
