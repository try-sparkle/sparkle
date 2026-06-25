// Build @sparkle/mcp-orchestrator and copy its self-contained dist/server.js into the Tauri
// resources dir so it is bundled into the app (and resolvable via BaseDirectory::Resource in dev
// and in the packaged .app). Run automatically by apps/desktop's pre(dev|build) scripts.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // apps/desktop/scripts -> repo root
const dist = resolve(repoRoot, "apps/mcp-orchestrator/dist/server.js");
const destDir = resolve(here, "../src-tauri/resources");
const dest = resolve(destDir, "mcp-orchestrator-server.js");

// (Re)build the bundle. NOTE: this always runs a full tsup build — the orchestrator's tsup config
// uses `clean: true`, so each invocation wipes dist/ and re-bundles the SDK + zod (~700ms). It is
// idempotent (same source → same output) but NOT a cached no-op; it runs on every pre(dev|build).
execSync("pnpm --filter @sparkle/mcp-orchestrator build", { cwd: repoRoot, stdio: "inherit" });

if (!existsSync(dist)) {
  console.error(`[copy-mcp-server] expected build output missing: ${dist}`);
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(dist, dest);
console.log(`[copy-mcp-server] ${dist} -> ${dest}`);
