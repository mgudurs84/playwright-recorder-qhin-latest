import { useState, useRef } from "react";
import { api, type AnalysisResult } from "@/lib/api";
import { ResultCard } from "./ResultCard";

interface BatchModeProps {
  screenshotsEnabled: boolean;
}

function exportToCsv(results: AnalysisResult[]) {
  const headers = [
    "transactionId", "status", "type", "timestamp", "severity",
    "summary", "rootCause", "l1Actions", "l2Actions", "resolution", "organizations", "error"
  ];
  const rows = results.map((r) => [
    r.transactionId,
    r.detail.status ?? "",
    r.detail.transactionType ?? "",
    r.detail.timestamp ?? "",
    r.ai.severity,
    r.ai.summary,
    r.ai.rootCause,
    r.ai.l1Actions.join(" | "),
    r.ai.l2Actions.join(" | "),
    r.ai.resolution,
    r.organizations.map((o) => `${o.name}(${o.oid})`).join("; "),
    r.error ?? "",
  ]);

  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cw-tx-analysis-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function BatchMode({ screenshotsEnabled }: BatchModeProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setError("");
    setResults([]);
    try {
      const res = await api.batch(file, screenshotsEnabled);
      setResults(res.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const failed = results.filter((r) => r.error).length;
  const passed = results.length - failed;

  return (
    <div className="space-y-4">
      <div className="border-2 border-dashed border-border rounded-xl p-8 text-center">
        {file ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 text-sm text-foreground font-medium">
              <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {file.name}
            </div>
            <div className="flex gap-2 justify-center">
              <button
                onClick={handleUpload}
                disabled={loading}
                className="px-5 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Processing…
                  </span>
                ) : "Run Batch Analysis"}
              </button>
              <button
                onClick={() => { setFile(null); setResults([]); setError(""); }}
                className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <svg className="w-10 h-10 text-muted-foreground mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-sm text-muted-foreground">
              Upload a CSV with a <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">transactionId</code> column
            </p>
            <button
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 text-sm font-medium border border-primary text-primary rounded-lg hover:bg-primary/5 transition"
            >
              Choose File
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3 border border-destructive/20">
          {error}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{results.length} transactions</span>
              {passed > 0 && <span className="text-green-600">{passed} analyzed</span>}
              {failed > 0 && <span className="text-destructive">{failed} failed</span>}
            </div>
            <button
              onClick={() => exportToCsv(results)}
              className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>

          <div className="space-y-3">
            {results.map((r) => (
              <ResultCard key={r.transactionId} result={r} screenshotsEnabled={screenshotsEnabled} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
