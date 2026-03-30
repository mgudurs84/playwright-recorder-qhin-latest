import { useState } from "react";
import { api, type AnalysisResult } from "@/lib/api";
import { ResultCard } from "./ResultCard";

const PLACEHOLDER = `03/29/2026 13:10:18.088\tInformation\tGateway\tRequest received.
03/29/2026 13:10:18.091\tInformation\tGateway\tRequest successfully authenticated.
03/29/2026 13:10:18.093\tInformation\tBroker\tRetrieving patient links for organization '"2.16.840.1.113883.3.5958.1000.2.300"'…`;

export function LogTextMode() {
  const [txId, setTxId] = useState("");
  const [logText, setLogText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState("");

  async function handleAnalyze() {
    if (!logText.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await api.analyzeLogs(logText.trim(), txId.trim() || undefined);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const lineCount = logText.trim() ? logText.trim().split(/\r?\n/).length : 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            placeholder="Transaction ID (optional — auto-generated if blank)"
            className="flex-1 px-4 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
        </div>

        <div className="relative">
          <textarea
            value={logText}
            onChange={(e) => setLogText(e.target.value)}
            placeholder={PLACEHOLDER}
            rows={12}
            className="w-full px-4 py-3 text-xs bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring font-mono resize-y leading-relaxed"
            spellCheck={false}
          />
          {lineCount > 0 && (
            <span className="absolute bottom-3 right-3 text-xs text-muted-foreground bg-background/80 px-1.5 py-0.5 rounded">
              {lineCount} line{lineCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Paste CommonWell log lines directly — no portal login required.
            Expected format: <code className="bg-muted px-1 rounded">MM/DD/YYYY HH:MM:SS.mmm[TAB]Level[TAB]Component[TAB]Message</code>
          </p>
          <button
            onClick={handleAnalyze}
            disabled={loading || !logText.trim()}
            className="ml-4 shrink-0 px-5 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50 whitespace-nowrap"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Analyzing…
              </span>
            ) : "Analyze Logs"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3 border border-destructive/20">
          {error}
        </div>
      )}

      {result && <ResultCard result={result} screenshotsEnabled={false} />}
    </div>
  );
}
