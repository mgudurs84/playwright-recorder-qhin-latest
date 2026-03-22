import { createVertex } from "@ai-sdk/google-vertex";

export function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.VERTEX_LOCATION || "us-central1";
  const modelId = process.env.VERTEX_MODEL_ID || "gemini-2.5-flash";

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as {
      project_id: string;
      private_key?: string;
    };
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }
    const vertex = createVertex({
      project: serviceAccount.project_id,
      location,
      googleAuthOptions: { credentials: serviceAccount },
    });
    return vertex(modelId);
  }

  if (!projectId) {
    throw new Error(
      "GCP auth not configured. " +
      "Set GCP_SERVICE_ACCOUNT_JSON (local dev with a service account JSON file) " +
      "or GCP_PROJECT_ID (GKE / Cloud Run with Workload Identity / ADC)."
    );
  }

  const vertex = createVertex({ project: projectId, location });
  return vertex(modelId);
}
