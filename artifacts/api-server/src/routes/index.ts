import { Router, type IRouter } from "express";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;
