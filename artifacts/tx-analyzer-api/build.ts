import { build } from "esbuild";
import { existsSync, mkdirSync } from "fs";

if (!existsSync("dist")) mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/index.cjs",
  external: ["playwright", "playwright-core"],
  sourcemap: false,
  minify: false,
}).catch(() => process.exit(1));

console.log("[build] tx-analyzer-api built successfully");
