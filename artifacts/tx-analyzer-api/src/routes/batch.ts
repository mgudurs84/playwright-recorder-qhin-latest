import { type Express, type Request, type Response } from "express";
import multer from "multer";
import { analyzeTransaction } from "./analyze.js";
import type { AnalysisResult } from "./analyze.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const CONCURRENCY = 5;

function parseTransactionIds(csvText: string): string[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  const hasHeader = header.includes("transactionid") || header.includes("transaction_id") || header.includes("id");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => {
      const parts = line.split(",");
      return (parts[0] ?? "").replace(/["']/g, "").trim();
    })
    .filter(Boolean);
}

async function runBatch(
  ids: string[],
  captureScreenshot = false
): Promise<Array<AnalysisResult & { error?: string }>> {
  const results: Array<AnalysisResult & { error?: string }> = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (id) => {
        try {
          return await analyzeTransaction(id, captureScreenshot);
        } catch (err) {
          return {
            transactionId: id,
            error: (err as Error).message,
            detail: { transactionId: id, rawFields: {}, oids: [] },
            organizations: [],
            ai: {
              summary: "Error fetching transaction",
              dataFlow: "",
              rootCause: (err as Error).message,
              organizations: [],
              l1Actions: ["Verify transaction ID and session"],
              l2Actions: [],
              severity: "medium" as const,
              resolution: "Retry after re-login",
            },
          };
        }
      })
    );
    results.push(...chunkResults);
  }

  return results;
}

export function registerBatchRoutes(app: Express): void {
  app.post(
    "/api/batch",
    upload.single("file"),
    async (req: Request, res: Response) => {
      let ids: string[] = [];
      const captureScreenshot =
        (req.body as { captureScreenshot?: string | boolean })?.captureScreenshot === true ||
        (req.body as { captureScreenshot?: string | boolean })?.captureScreenshot === "true";

      if (req.file) {
        const csvText = req.file.buffer.toString("utf8");
        ids = parseTransactionIds(csvText);
      } else if (req.body && Array.isArray((req.body as { transactionIds?: string[] }).transactionIds)) {
        ids = (req.body as { transactionIds: string[] }).transactionIds.map((s) => s.trim()).filter(Boolean);
      }

      if (ids.length === 0) {
        res.status(400).json({ error: "No transaction IDs found. Upload a CSV with a transactionId column or send transactionIds array." });
        return;
      }

      if (ids.length > 500) {
        res.status(400).json({ error: "Batch limit is 500 transactions per request" });
        return;
      }

      console.log(`[Batch] Processing ${ids.length} transactions (screenshot: ${captureScreenshot})`);

      try {
        const results = await runBatch(ids, captureScreenshot);
        res.json({ count: results.length, results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  );
}
