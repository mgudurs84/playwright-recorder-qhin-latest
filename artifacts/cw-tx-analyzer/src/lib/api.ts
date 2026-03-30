const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Convert a server-relative URL like /api/screenshots/x.png to a proxy-routed URL */
export const toProxiedUrl = (serverPath: string): string => {
  if (!serverPath.startsWith("/")) return serverPath;
  return `${BASE}${serverPath}`;
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) errMsg = body.error;
    } catch {}
    throw new Error(errMsg);
  }
  return res.json() as Promise<T>;
}

export interface SessionStatus {
  valid: boolean;
  expiresAt?: string;
  authState: string;
  discoveryComplete?: boolean;
  discoveredAt?: string;
}

export interface LoginResult {
  success: boolean;
  needsOtp: boolean;
  message: string;
  expiresAt?: string;
}

export interface OtpResult {
  success: boolean;
  message: string;
  expiresAt?: string;
}

export interface TransactionDetail {
  transactionId: string;
  timestamp?: string;
  transactionType?: string;
  status?: string;
  requestingOrg?: string;
  requestingOid?: string;
  respondingOrg?: string;
  respondingOid?: string;
  patientId?: string;
  memberId?: string;
  errorCode?: string;
  errorMessage?: string;
  responseCode?: string;
  duration?: string;
  rawFields: Record<string, string>;
  oids: string[];
  endpointUsed?: string;
  rawPayload?: string;
  payloadEndpointUsed?: string;
  /** Tab-separated log lines from BindTransactionLogsHistory */
  rawLogs?: string;
  /** The endpoint URL that served rawLogs */
  logEndpointUsed?: string;
}

export interface AiAnalysis {
  summary: string;
  dataFlow: string;
  transactionCategory: string;
  fanoutOrgCount: string;
  documentsFound: string;
  durationMs: string;
  rootCause: string;
  organizations: Array<{ oid: string; name: string; role: string }>;
  l1Actions: string[];
  l2Actions: string[];
  severity: "low" | "medium" | "high" | "critical";
  resolution: string;
}

export interface AnalysisResult {
  transactionId: string;
  detail: TransactionDetail;
  organizations: Array<{ oid: string; name: string }>;
  ai: AiAnalysis;
  screenshotUrl?: string;
  error?: string;
}

export interface BatchResult {
  count: number;
  results: AnalysisResult[];
}

export const api = {
  getSessionStatus: () => apiRequest<SessionStatus>("/api/session/status"),

  login: (username?: string, password?: string) =>
    apiRequest<LoginResult>("/api/session/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  submitOtp: (otp: string) =>
    apiRequest<OtpResult>("/api/session/otp", {
      method: "POST",
      body: JSON.stringify({ otp }),
    }),

  analyze: (transactionId: string, captureScreenshot = false, usePlaywright = false) =>
    apiRequest<AnalysisResult>("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ transactionId, captureScreenshot, usePlaywright }),
    }),

  analyzeLogs: (logText: string, transactionId?: string) =>
    apiRequest<AnalysisResult>("/api/analyze/logtext", {
      method: "POST",
      body: JSON.stringify({ logText, transactionId }),
    }),

  batch: async (file: File, captureScreenshot = false): Promise<BatchResult> => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("captureScreenshot", captureScreenshot ? "true" : "false");
    const url = `${BASE}/api/batch`;
    const res = await fetch(url, { method: "POST", body: formData });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) errMsg = body.error;
      } catch {}
      throw new Error(errMsg);
    }
    return res.json() as Promise<BatchResult>;
  },

  screenshot: (transactionId: string) =>
    apiRequest<{ screenshotUrl: string }>("/api/screenshot", {
      method: "POST",
      body: JSON.stringify({ transactionId }),
    }),

  analyzeScreenshot: async (file: File): Promise<AnalysisResult> => {
    const formData = new FormData();
    formData.append("image", file);
    const url = `${BASE}/api/analyze/screenshot`;
    const res = await fetch(url, { method: "POST", body: formData });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) errMsg = body.error;
      } catch {}
      throw new Error(errMsg);
    }
    return res.json() as Promise<AnalysisResult>;
  },
};
