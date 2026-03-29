import "dotenv/config";
import app from "./app.js";

const PORT = parseInt(process.env.PORT ?? "8000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[tx-analyzer-api] Server listening on port ${PORT}`);
});
