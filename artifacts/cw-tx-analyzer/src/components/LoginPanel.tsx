import { useState } from "react";
import { api, type SessionStatus } from "@/lib/api";

interface LoginPanelProps {
  status: SessionStatus | null;
  onStatusChange: (s: SessionStatus) => void;
}

export function LoginPanel({ status, onStatusChange }: LoginPanelProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [phase, setPhase] = useState<"idle" | "logging-in" | "otp" | "done">("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const sessionActive = status?.valid === true;
  const expiresAt = status?.expiresAt ? new Date(status.expiresAt) : null;
  const hoursLeft = expiresAt
    ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 3600000))
    : null;

  async function handleLogin() {
    setError("");
    setPhase("logging-in");
    try {
      const result = await api.login(username || undefined, password || undefined);
      if (!result.success) {
        setError(result.message);
        setPhase("idle");
        return;
      }
      if (result.needsOtp) {
        setPhase("otp");
        setMessage("OTP sent to your email. Enter it below.");
      } else {
        setPhase("done");
        setMessage(result.message);
        const newStatus = await api.getSessionStatus();
        onStatusChange(newStatus);
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
    }
  }

  async function handleOtp() {
    setError("");
    try {
      const result = await api.submitOtp(otp);
      if (!result.success) {
        setError(result.message);
        return;
      }
      setPhase("done");
      setMessage("Authenticated successfully");
      const newStatus = await api.getSessionStatus();
      onStatusChange(newStatus);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (sessionActive) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 border border-green-200 rounded-lg">
        <span className="w-2.5 h-2.5 rounded-full bg-green-500 shrink-0" />
        <span className="text-sm font-medium text-green-800">
          Session active
          {hoursLeft !== null && <> — expires in {hoursLeft}h</>}
        </span>
        <button
          onClick={handleLogin}
          className="ml-auto text-xs text-green-700 underline hover:text-green-900"
        >
          Re-login
        </button>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
      <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
        <span className="w-1.5 h-5 bg-primary rounded-full" />
        CommonWell Portal Login
      </h2>

      {phase !== "otp" ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Username (email)
            </label>
            <input
              type="email"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Leave blank to use .env credentials"
              className="mt-1 w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to use .env credentials"
              className="mt-1 w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            onClick={handleLogin}
            disabled={phase === "logging-in"}
            className="w-full py-2.5 text-sm font-semibold bg-primary text-primary-foreground rounded-md hover:opacity-90 transition disabled:opacity-50"
          >
            {phase === "logging-in" ? "Launching browser login…" : "Login"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{message}</p>
          <input
            type="text"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="Enter OTP code"
            className="w-full px-3 py-2 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            onKeyDown={(e) => e.key === "Enter" && handleOtp()}
          />
          <div className="flex gap-2">
            <button
              onClick={handleOtp}
              className="flex-1 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-md hover:opacity-90 transition"
            >
              Verify OTP
            </button>
            <button
              onClick={() => { setPhase("idle"); setError(""); }}
              className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {!error && message && phase === "done" && (
        <p className="mt-3 text-sm text-green-700 bg-green-50 rounded-md px-3 py-2">{message}</p>
      )}
    </div>
  );
}
