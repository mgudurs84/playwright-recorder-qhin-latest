import { useState } from "react";
import { api, type AnalysisResult } from "@/lib/api";
import { ResultCard } from "./ResultCard";

interface SingleModeProps {
  screenshotsEnabled: boolean;
}

type FetchMode = "api" | "playwright";

export function SingleMode({ screenshotsEnabled }: SingleModeProps) {
  const [txId, setTxId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [fetchMode, setFetchMode] = useState<FetchMode>("api");

  async function handleAnalyze() {
    if (!txId.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await api.analyze(
        txId.trim(),
        screenshotsEnabled,
        fetchMode === "playwright"
      );
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Fetch mode toggle */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground font-medium shrink-0">Fetch mode:</span>
        <div className="flex rounded-lg border border-input overflow-hidden text-xs font-semibold">
          <button
            onClick={() => setFetchMode("api")}
            className={`px-3 py-1.5 transition-colors ${
              fetchMode === "api"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            Direct API
          </button>
          <button
            onClick={() => setFetchMode("playwright")}
            className={`px-3 py-1.5 border-l border-input transition-colors flex items-center gap-1.5 ${
              fetchMode === "playwright"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="w-3.5 h-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <rect x="3" y="4" width="18" height="14" rx="2" />
              <circle cx="9" cy="11" r="2" />
              <path d="M15 9l-2 4 2 2" strokeLinecap="round" />
            </svg>
            Playwright
          </button>
        </div>
        {fetchMode === "playwright" && (
          <span className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
            Renders JS — slower, richer data
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={txId}
          onChange={(e) => setTxId(e.target.value)}
          placeholder="Paste a CommonWell Transaction ID…"
          className="flex-1 px-4 py-2.5 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
        />
        <button
          onClick={handleAnalyze}
          disabled={loading || !txId.trim()}
          className="px-5 py-2.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition disabled:opacity-50 whitespace-nowrap"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              {fetchMode === "playwright" ? "Rendering…" : "Analyzing…"}
            </span>
          ) : "Analyze"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3 border border-destructive/20">
          {error}
        </div>
      )}

      {result && (
        <>
          {result.detail.endpointUsed?.startsWith("Playwright") && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Fetched via Playwright — Kendo grid JS rendered — Portal Logs tab may contain richer data
            </div>
          )}
          <ResultCard result={result} screenshotsEnabled={screenshotsEnabled} />
        </>
      )}
    </div>
  );
}
