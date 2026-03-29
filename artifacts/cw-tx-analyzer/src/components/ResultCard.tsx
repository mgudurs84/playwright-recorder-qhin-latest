import { useState } from "react";
import { api, type AnalysisResult } from "@/lib/api";

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  critical: "bg-red-100 text-red-800 border-red-200",
};

interface ResultCardProps {
  result: AnalysisResult;
  screenshotsEnabled?: boolean;
}

export function ResultCard({ result, screenshotsEnabled = false }: ResultCardProps) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [loadingScreenshot, setLoadingScreenshot] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const { ai, detail, organizations } = result;
  const severityClass = SEVERITY_COLORS[ai.severity] ?? SEVERITY_COLORS.medium;

  async function loadScreenshot() {
    setLoadingScreenshot(true);
    try {
      const res = await api.screenshot(result.transactionId);
      setScreenshotUrl(res.screenshotUrl);
    } catch (err) {
      console.error("Screenshot failed:", err);
    } finally {
      setLoadingScreenshot(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-muted/30 transition"
        onClick={() => setExpanded((p) => !p)}
      >
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${severityClass} uppercase tracking-wide`}>
          {ai.severity}
        </span>
        <span className="font-mono text-sm font-medium text-foreground flex-1 truncate">
          {result.transactionId}
        </span>
        <span className="text-xs text-muted-foreground">{detail.transactionType ?? "Unknown type"}</span>
        <span className="text-xs text-muted-foreground ml-2">{detail.timestamp ?? ""}</span>
        <svg
          className={`w-4 h-4 text-muted-foreground ml-1 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-border/60">
          {result.error && (
            <div className="mt-4 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              Error: {result.error}
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
            <MetaRow label="Status" value={detail.status} />
            <MetaRow label="Type" value={detail.transactionType} />
            <MetaRow label="Timestamp" value={detail.timestamp} />
            <MetaRow label="Duration" value={detail.duration} />
            <MetaRow label="Response Code" value={detail.responseCode} />
            <MetaRow label="Error Code" value={detail.errorCode} />
          </div>

          {organizations.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Organizations
              </h4>
              <div className="flex flex-wrap gap-2">
                {organizations.map((org) => (
                  <span
                    key={org.oid}
                    className="text-xs bg-secondary text-secondary-foreground rounded-md px-2.5 py-1 border border-secondary-border/50"
                    title={org.oid}
                  >
                    {org.name !== org.oid ? org.name : org.oid}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              Summary
            </h4>
            <p className="text-sm text-foreground leading-relaxed">{ai.summary}</p>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              Root Cause
            </h4>
            <p className="text-sm text-foreground leading-relaxed">{ai.rootCause}</p>
          </div>

          {ai.l1Actions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-2">
                L1 Actions (Support)
              </h4>
              <ul className="space-y-1">
                {ai.l1Actions.map((a, i) => (
                  <li key={i} className="text-sm text-foreground flex gap-2">
                    <span className="text-blue-500 font-bold shrink-0">{i + 1}.</span>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ai.l2Actions.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-2">
                L2 Actions (Engineering / Escalation)
              </h4>
              <ul className="space-y-1">
                {ai.l2Actions.map((a, i) => (
                  <li key={i} className="text-sm text-foreground flex gap-2">
                    <span className="text-purple-500 font-bold shrink-0">{i + 1}.</span>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              Resolution
            </h4>
            <p className="text-sm text-foreground">{ai.resolution}</p>
          </div>

          {detail.errorMessage && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Raw Error Message
              </h4>
              <p className="text-sm font-mono bg-muted px-3 py-2 rounded-md text-destructive break-all">
                {detail.errorMessage}
              </p>
            </div>
          )}

          {screenshotsEnabled && (
            <div className="pt-2 border-t border-border/60">
              {!screenshotUrl ? (
                <button
                  onClick={loadScreenshot}
                  disabled={loadingScreenshot}
                  className="text-xs text-muted-foreground hover:text-foreground underline disabled:opacity-50"
                >
                  {loadingScreenshot ? "Capturing screenshot…" : "Capture portal screenshot"}
                </button>
              ) : (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Portal Screenshot</p>
                  <img
                    src={screenshotUrl}
                    alt={`Screenshot for ${result.transactionId}`}
                    className="w-full rounded-lg border border-border shadow-sm"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 min-w-[120px]">{label}:</span>
      <span className="text-foreground font-medium">{value}</span>
    </div>
  );
}
