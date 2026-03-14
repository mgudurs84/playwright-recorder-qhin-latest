import app, { initializeRuntime } from "./app";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Load agent configs from GCP before accepting any requests
initializeRuntime()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((err: unknown) => {
    console.error("[Startup] Failed to initialize GCP agents:", err);
    console.warn("[Startup] Starting anyway with YAML fallback agents...");
    app.listen(port, () => {
      console.log(`Server listening on port ${port} (YAML fallback mode)`);
    });
  });
