import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { registerCwRunnerRoutes } from "./routes/cw-runner";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["*"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api/screenshots", express.static("/tmp/cw-screenshots", {
  maxAge: "1d",
  setHeaders: (res) => {
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    const origin = devDomain ? `https://${devDomain}` : "http://localhost";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Cache-Control", "private, max-age=86400");
  },
}));

registerCwRunnerRoutes(app);

app.use("/api", router);

export default app;
