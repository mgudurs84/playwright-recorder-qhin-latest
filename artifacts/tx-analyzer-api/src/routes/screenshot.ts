import { type Express, type Request, type Response } from "express";
import { takeScreenshot } from "../services/auth.js";

export function registerScreenshotRoutes(app: Express): void {
  app.post("/api/screenshot", async (req: Request, res: Response) => {
    const { transactionId } = req.body as { transactionId?: string };
    if (!transactionId?.trim()) {
      res.status(400).json({ error: "transactionId is required" });
      return;
    }

    const screenshotUrl = await takeScreenshot(transactionId.trim());
    if (!screenshotUrl) {
      res.status(500).json({ error: "Screenshot failed — session may be expired or transaction not found" });
      return;
    }

    res.json({ screenshotUrl });
  });
}
