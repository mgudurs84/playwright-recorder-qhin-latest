import { useState } from "react";
import { api, toProxiedUrl, type AnalysisResult } from "@/lib/api";

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  critical: "bg-red-100 text-red-800 border-red-200",
};

const ROLE_COLORS: Record<string, string> = {
  requester: "bg-blue-50 text-blue-700 border-blue-200",
  responder: "bg-emerald-50 text-emerald-700 border-emerald-200",
  intermediary: "bg-purple-50 text-purple-700 border-purple-200",
  broker: "bg-purple-50 text-purple-700 border-purple-200",
  unknown: "bg-secondary text-secondary-foreground border-border",
};

const ROLE_ARROW: Record<string, string> = {
  requester: "→",
  intermediary: "⇄",
  broker: "⇄",
  responder: "",
  unknown: "→",
};

interface ResultCardProps {
  result: AnalysisResult;
  screenshotsEnabled?: boolean;
}

type ActiveTab = "analysis" | "portal-logs";

/** Parse tab-separated CW log lines into structured rows */
function parseLogRows(raw: string): Array<{ ts: string; level: string; component: string; message: string }> {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length >= 4) {
        return { ts: parts[0], level: parts[1], component: parts[2], message: parts.slice(3).join("\t") };
      }
      return { ts: "", level: "", component: "", message: line };
    });
}

const LEVEL_COLORS: Record<string, string> = {
  Information: "text-blue-600",
  Warning:     "text-yellow-600",
  Error:       "text-red-600",
  Critical:    "text-red-700 font-bold",
  Debug:       "text-gray-400",
};

export function ResultCard({ result, screenshotsEnabled = false }: ResultCardProps) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(result.screenshotUrl ?? null);
  const [loadingScreenshot, setLoadingScreenshot] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>("analysis");
  const [orgsExpanded, setOrgsExpanded] = useState(false);

  const { ai, detail, organizations } = result;
  const severityClass = SEVERITY_COLORS[ai.severity] ?? SEVERITY_COLORS.medium;

  // Build a deduplicated org list: merge AI-identified orgs (have roles) with OID-resolved orgs
  const aiOrgMap = new Map(ai.organizations.map((o) => [o.oid, o]));
  const resolvedOrgMap = new Map(organizations.map((o) => [o.oid, o.name]));

  // All orgs: AI ones first, then any extra from OID resolution that AI missed
  const allOrgs: Array<{ oid: string; name: string; role: string }> = [
    ...ai.organizations,
    ...organizations
      .filter((o) => !aiOrgMap.has(o.oid))
      .map((o) => ({ oid: o.oid, name: o.name, role: "unknown" })),
  ].map((o) => ({
    ...o,
    // Prefer the resolved org name if available
    name: resolvedOrgMap.get(o.oid) ?? o.name,
  }));

  // Order for data flow: requester → intermediary/broker → responder
  const roleOrder: Record<string, number> = {
    requester: 0,
    intermediary: 1,
    broker: 1,
    responder: 2,
    unknown: 3,
  };
  const flowOrgs = [...allOrgs].sort(
    (a, b) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3)
  );

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
      {/* Header row */}
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
        <div className="px-5 pb-5 space-y-5 border-t border-border/60">
          {result.error && (
            <div className="mt-4 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              Error: {result.error}
            </div>
          )}

          {/* Tab switcher */}
          <div className="mt-4 flex gap-1 border-b border-border/60">
            {(["analysis", "portal-logs"] as ActiveTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-xs font-semibold rounded-t-md transition-colors ${
                  activeTab === tab
                    ? "bg-background border border-b-background border-border/60 text-foreground -mb-px"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab === "analysis" ? "Analysis" : "Portal Logs"}
                {tab === "portal-logs" && detail.rawLogs && (
                  <span className="ml-1.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px]">
                    {parseLogRows(detail.rawLogs).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Key stats bar */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox
              icon="🔄"
              label="Category"
              value={ai.transactionCategory ?? detail.transactionType ?? "—"}
            />
            <StatBox
              icon="🏢"
              label="Orgs Brokered To"
              value={ai.fanoutOrgCount ?? "—"}
              highlight={ai.fanoutOrgCount && ai.fanoutOrgCount !== "unknown"}
            />
            <StatBox
              icon="📄"
              label="Documents / Results"
              value={ai.documentsFound ?? "—"}
              highlight={ai.documentsFound && ai.documentsFound !== "unknown"}
            />
            <StatBox
              icon="⏱"
              label="Duration"
              value={ai.durationMs ?? detail.duration ?? "—"}
            />
          </div>

          {/* ── ANALYSIS TAB ── */}
          {activeTab === "analysis" && (<>

          {/* Transaction metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
            <MetaRow label="Status" value={detail.status} />
            <MetaRow label="Type" value={detail.transactionType} />
            <MetaRow label="Timestamp" value={detail.timestamp} />
            <MetaRow label="HTTP Status" value={detail.responseCode} />
            <MetaRow label="Error Code" value={detail.errorCode} />
          </div>

          {/* Data flow chain */}
          {flowOrgs.length > 0 && (() => {
            // Split into featured (requester / broker) vs fanout targets
            const featured = flowOrgs.filter(
              (o) => o.role === "requester" || o.role === "broker" || o.role === "intermediary"
            );
            const targets = flowOrgs.filter(
              (o) => o.role !== "requester" && o.role !== "broker" && o.role !== "intermediary"
            );
            return (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Data Flow
                </h4>

                {/* AI data flow sentence — primary description */}
                {ai.dataFlow && (
                  <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-2 mb-3">
                    {ai.dataFlow}
                  </p>
                )}

                {/* Compact visual chain: featured orgs + summary node */}
                <div className="flex flex-wrap items-center gap-1 mb-2">
                  {featured.map((org) => (
                    <div key={org.oid} className="flex items-center gap-1">
                      <div className={`flex flex-col rounded-lg border px-3 py-2 ${ROLE_COLORS[org.role] ?? ROLE_COLORS.unknown}`}>
                        <span className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-0.5">
                          {org.role}
                        </span>
                        <span className="text-xs font-semibold leading-tight">
                          {org.name !== org.oid ? org.name : org.oid}
                        </span>
                        <span className="text-[10px] font-mono opacity-50 mt-0.5 truncate max-w-[180px]">
                          {org.oid}
                        </span>
                      </div>
                      <span className="text-muted-foreground font-bold text-sm px-1">→</span>
                    </div>
                  ))}

                  {/* Fanout summary node */}
                  {targets.length > 0 && (
                    <button
                      onClick={() => setOrgsExpanded((p) => !p)}
                      className="flex flex-col rounded-lg border px-3 py-2 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 transition-colors text-left"
                    >
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-0.5">
                        fanout targets
                      </span>
                      <span className="text-xs font-semibold leading-tight">
                        {targets.length} organization{targets.length !== 1 ? "s" : ""}
                      </span>
                      <span className="text-[10px] opacity-60 mt-0.5">
                        {orgsExpanded ? "▲ collapse" : "▼ expand"}
                      </span>
                    </button>
                  )}
                </div>

                {/* Expandable responder list */}
                {orgsExpanded && targets.length > 0 && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-72 overflow-y-auto rounded-lg border border-border/60 p-2 bg-muted/20">
                    {targets.map((org) => (
                      <div
                        key={org.oid}
                        className={`flex flex-col rounded border px-2 py-1.5 ${ROLE_COLORS[org.role] ?? ROLE_COLORS.unknown}`}
                      >
                        <span className="text-[10px] font-bold uppercase opacity-60 mb-0.5">
                          {org.role}
                        </span>
                        <span className="text-xs font-medium leading-tight truncate">
                          {org.name !== org.oid ? org.name : ""}
                        </span>
                        <span className="text-[10px] font-mono opacity-50 truncate">
                          {org.oid}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Summary */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              Summary
            </h4>
            <p className="text-sm text-foreground leading-relaxed">{ai.summary}</p>
          </div>

          {/* Root cause */}
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
                    src={toProxiedUrl(screenshotUrl)}
                    alt={`Screenshot for ${result.transactionId}`}
                    className="w-full rounded-lg border border-border shadow-sm"
                  />
                </div>
              )}
            </div>
          )}

          {/* end analysis tab */}
          </>)}

          {/* ── PORTAL LOGS TAB ── */}
          {activeTab === "portal-logs" && (
            <div>
              {detail.logEndpointUsed && (
                <p className="text-[11px] font-mono text-muted-foreground mb-3 break-all">
                  Source: <span className="text-foreground">{detail.logEndpointUsed}</span>
                </p>
              )}

              {detail.rawLogs ? (() => {
                const rows = parseLogRows(detail.rawLogs);
                return (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/60 border-b border-border">
                          <th className="text-left px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap">Timestamp</th>
                          <th className="text-left px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap">Level</th>
                          <th className="text-left px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap">Component</th>
                          <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => (
                          <tr key={i} className={`border-b border-border/40 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                            <td className="px-3 py-1.5 font-mono whitespace-nowrap text-muted-foreground">{row.ts}</td>
                            <td className={`px-3 py-1.5 font-semibold whitespace-nowrap ${LEVEL_COLORS[row.level] ?? "text-foreground"}`}>
                              {row.level}
                            </td>
                            <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{row.component}</td>
                            <td className="px-3 py-1.5 text-foreground break-all">{row.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })() : (
                <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  No portal log data available for this transaction.
                  <br />
                  <span className="text-xs mt-1 block">
                    Portal logs are fetched automatically during analysis — re-run if missing, or use the
                    <span className="font-semibold text-foreground"> Paste Log Text</span> tab for broker logs.
                  </span>
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

function StatBox({
  icon,
  label,
  value,
  highlight,
}: {
  icon: string;
  label: string;
  value: string;
  highlight?: boolean | string | null;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${highlight ? "bg-primary/5 border-primary/20" : "bg-muted/40 border-border"}`}>
      <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
        <span>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="text-sm font-semibold text-foreground leading-tight">{value || "—"}</div>
    </div>
  );
}
