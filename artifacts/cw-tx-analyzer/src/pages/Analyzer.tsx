import { useState, useEffect } from "react";
import { api, type SessionStatus } from "@/lib/api";
import { LoginPanel } from "@/components/LoginPanel";
import { SingleMode } from "@/components/SingleMode";
import { BatchMode } from "@/components/BatchMode";
import { LogTextMode } from "@/components/LogTextMode";

type Mode = "single" | "batch" | "logtext";

export default function Analyzer() {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [mode, setMode] = useState<Mode>("single");
  const [screenshotsEnabled, setScreenshotsEnabled] = useState(false);

  useEffect(() => {
    api.getSessionStatus()
      .then(setStatus)
      .catch(() => setStatus({ valid: false, authState: "idle" }));
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-[#CC0000] text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-white rounded-sm flex items-center justify-center">
              <div className="w-5 h-5 bg-[#CC0000] rounded-[2px]" />
            </div>
            <span className="font-bold text-lg tracking-tight">CW Transaction Analyzer</span>
          </div>
          <span className="text-xs text-red-200 font-medium ml-1 hidden sm:inline">CVS Health · CommonWell</span>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer select-none">
              <span className="text-red-100">Screenshots</span>
              <button
                role="switch"
                aria-checked={screenshotsEnabled}
                onClick={() => setScreenshotsEnabled((p) => !p)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  screenshotsEnabled ? "bg-white" : "bg-red-400"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
                    screenshotsEnabled ? "translate-x-4 bg-[#CC0000]" : "translate-x-1 bg-white"
                  }`}
                />
              </button>
            </label>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <LoginPanel status={status} onStatusChange={setStatus} />

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="flex border-b border-border">
            <TabButton label="Single Transaction" active={mode === "single"} onClick={() => setMode("single")} />
            <TabButton label="Batch CSV Upload" active={mode === "batch"} onClick={() => setMode("batch")} />
            <TabButton label="Paste Log Text" active={mode === "logtext"} onClick={() => setMode("logtext")} />
          </div>

          <div className="p-5">
            {mode !== "logtext" && !status?.valid && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-3 mb-4">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
                </svg>
                Log in to the CommonWell portal first to enable transaction fetching.
              </div>
            )}
            {mode === "single" && <SingleMode screenshotsEnabled={screenshotsEnabled} />}
            {mode === "batch" && <BatchMode screenshotsEnabled={screenshotsEnabled} />}
            {mode === "logtext" && <LogTextMode />}
          </div>
        </div>

        <p className="text-xs text-center text-muted-foreground pb-4">
          CW Transaction Analyzer · CVS Health Internal Tool · Session-based authentication required
        </p>
      </main>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-sm font-medium transition-colors ${
        active
          ? "text-primary border-b-2 border-primary bg-primary/5"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      {label}
    </button>
  );
}
