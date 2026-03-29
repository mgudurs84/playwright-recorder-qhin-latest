import { type Express, type Request, type Response } from "express";
import {
  login,
  submitOtp,
  getSessionStatus,
  getAuthState,
} from "../services/auth.js";

export function registerSessionRoutes(app: Express): void {
  app.post("/api/session/login", async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };

    const user = username ?? process.env.CW_USERNAME ?? "";
    const pass = password ?? process.env.CW_PASSWORD ?? "";

    if (!user || !pass) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const result = await login(user, pass);
    res.json(result);
  });

  app.post("/api/session/otp", async (req: Request, res: Response) => {
    const { otp } = req.body as { otp?: string };
    if (!otp) {
      res.status(400).json({ error: "otp is required" });
      return;
    }
    const result = await submitOtp(otp);
    res.json(result);
  });

  app.get("/api/session/status", (_req: Request, res: Response) => {
    const status = getSessionStatus();
    const authState = getAuthState();
    res.json({ ...status, authState });
  });
}
