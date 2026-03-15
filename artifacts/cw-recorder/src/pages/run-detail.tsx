import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircle,
  AlertTriangle,
  Clock,
  FileText,
  ArrowLeft,
} from "lucide-react";
import { Link } from "wouter";
import { apiUrl } from "@/lib/utils";

interface CwTransactionRecord {
  timestamp: string;
  transactionId: string;
  transactionType: string;
  memberName: string;
  initiatingOrgId: string;
  duration: string;
  status: string;
}

interface CwRunStep {
  type: string;
  content: string;
  screenshotUrl?: string;
  timestamp: string;
}

interface CwRun {
  id: string;
  status: string;
  parameters: Record<string, unknown>;
  recordCount: number | null;
  errorCount: number | null;
  records: CwTransactionRecord[];
  steps: CwRunStep[];
  screenshotUrls: string[];
  report: string | null;
  startedAt: string;
  completedAt: string | null;
}

export default function RunDetail() {
  const params = useParams();
  const id = params?.id;
  const [run, setRun] = useState<CwRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const fetchRun = async () => {
      try {
        const res = await fetch(apiUrl(`/api/cw/runs/${id}`));
        if (res.ok) setRun(await res.json());
      } catch {
      } finally {
        setLoading(false);
      }
    };
    fetchRun();
    const interval = setInterval(fetchRun, 5000);
    return () => clearInterval(interval);
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertTriangle className="w-12 h-12 text-muted-foreground/30" />
        <p className="text-muted-foreground">Run not found</p>
        <Link
          href="/"
          className="text-primary text-sm hover:underline flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>
      </div>
    );
  }

  const statusColor =
    run.status === "complete"
      ? "text-emerald-400"
      : run.status === "error" || run.status === "failed"
      ? "text-destructive"
      : "text-primary";

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Link
          href="/"
          className="text-muted-foreground text-sm hover:text-foreground flex items-center gap-1 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1
              className="text-2xl font-bold"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Run Details
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {new Date(run.startedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 text-sm font-medium ${statusColor}`}>
              {run.status === "complete" ? (
                <CheckCircle className="w-4 h-4" />
              ) : run.status === "error" ? (
                <AlertTriangle className="w-4 h-4" />
              ) : (
                <Clock className="w-4 h-4 animate-pulse" />
              )}
              {run.status}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="p-4 rounded-xl bg-card border border-border">
            <p className="text-xs text-muted-foreground mb-1">Total Records</p>
            <p className="text-2xl font-bold">{run.recordCount ?? 0}</p>
          </div>
          <div className="p-4 rounded-xl bg-card border border-border">
            <p className="text-xs text-muted-foreground mb-1">Errors</p>
            <p className="text-2xl font-bold text-destructive">
              {run.errorCount ?? 0}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-card border border-border">
            <p className="text-xs text-muted-foreground mb-1">Duration</p>
            <p className="text-2xl font-bold">
              {run.completedAt
                ? `${Math.round(
                    (new Date(run.completedAt).getTime() -
                      new Date(run.startedAt).getTime()) /
                      1000
                  )}s`
                : "..."}
            </p>
          </div>
        </div>
      </motion.div>

      {run.steps.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-display)" }}>
            Steps
          </h2>
          {run.steps.map((step, idx) => (
            <div
              key={idx}
              className="p-3 rounded-lg bg-card/50 border border-border/50 flex items-start gap-3"
            >
              <div
                className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                  step.type === "error"
                    ? "bg-destructive"
                    : step.type === "complete"
                    ? "bg-emerald-500"
                    : "bg-primary"
                }`}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm">{step.content}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(step.timestamp).toLocaleTimeString()}
                </p>
              </div>
              {step.screenshotUrl && (
                <a
                  href={apiUrl(step.screenshotUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  <img
                    src={apiUrl(step.screenshotUrl)}
                    alt="Screenshot"
                    className="w-24 h-16 object-cover rounded border border-border/50 hover:border-primary/50 transition-colors"
                  />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {run.report && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2" style={{ fontFamily: "var(--font-display)" }}>
            <FileText className="w-5 h-5 text-primary" />
            Analysis Report
          </h2>
          <div className="p-6 rounded-xl bg-card border border-border prose prose-invert max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-a:text-primary prose-strong:text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {run.report}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {run.screenshotUrls.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-display)" }}>
            Screenshots
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {run.screenshotUrls.map((url, idx) => (
              <a
                key={idx}
                href={apiUrl(url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src={apiUrl(url)}
                  alt={`Screenshot ${idx + 1}`}
                  className="w-full rounded-lg border border-border hover:border-primary/50 transition-colors"
                />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
