import { Router, type IRouter } from "express";
import healthRouter from "./health";
import researchRouter from "./research";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/research", researchRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;
