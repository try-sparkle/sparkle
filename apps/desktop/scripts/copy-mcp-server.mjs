// Build the bundled MCP servers and copy each self-contained dist/server.js into the Tauri
// resources dir so they are bundled into the app (and resolvable via BaseDirectory::Resource in dev
// and in the packaged .app). Run automatically by apps/desktop's pre(dev|build) scripts.
//   - @sparkle/mcp-orchestrator -> resources/mcp-orchestrator-server.js (per-Build-agent orchestration)
//   - @sparkle/mcp-control      -> resources/mcp-control-server.js      (app-level UI control)
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // apps/desktop/scripts -> repo root
const destDir = resolve(here, "../src-tauri/resources");

// Each MCP server bundled by tsup (clean:true → full rebuild each run, idempotent but not cached).
const servers = [
  { pkg: "@sparkle/mcp-orchestrator", dist: "apps/mcp-orchestrator/dist/server.js", out: "mcp-orchestrator-server.js" },
  { pkg: "@sparkle/mcp-control", dist: "apps/mcp-control/dist/server.js", out: "mcp-control-server.js" },
];

mkdirSync(destDir, { recursive: true });
for (const { pkg, dist, out } of servers) {
  const distPath = resolve(repoRoot, dist);
  const dest = resolve(destDir, out);
  execSync(`pnpm --filter ${pkg} build`, { cwd: repoRoot, stdio: "inherit" });
  if (!existsSync(distPath)) {
    console.error(`[copy-mcp-server] expected build output missing: ${distPath}`);
    process.exit(1);
  }
  copyFileSync(distPath, dest);
  console.log(`[copy-mcp-server] ${distPath} -> ${dest}`);
}
