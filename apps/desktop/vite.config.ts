/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// In dev, surface the user's Chief PAT to the app as VITE_CHIEF_PAT so the Brainstorm agent
// works on localhost without pasting a token. We look (in order) at: the process env
// (CHIEF_API / VITE_CHIEF_PAT), Vite's own .env files, then a CHIEF_API line in the monorepo
// root .env.local — that's where it lives in this repo. NEVER baked into a production build.
function devChiefPat(mode: string): string {
  if (mode !== "development") return "";
  const fromEnv = loadEnv(mode, process.cwd(), "");
  const direct =
    process.env.CHIEF_API ||
    process.env.VITE_CHIEF_PAT ||
    fromEnv.CHIEF_API ||
    fromEnv.VITE_CHIEF_PAT;
  if (direct) return direct.trim();
  // Fall back to a CHIEF_API= line in a root .env.local (walk up from apps/desktop).
  for (const rel of ["../../.env.local", "../../../.env.local", ".env.local"]) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) {
      const m = readFileSync(p, "utf8").match(/^\s*CHIEF_API\s*=\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim();
    }
  }
  return "";
}

// Tauri expects a fixed dev port and an un-cleared console.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Keep a single React/React-DOM instance. The monorepo legitimately holds two
  // React versions (mobile/Expo pins 19.2.3; web + desktop use 19.2.4); the root
  // package.json pins 19.2.4 so @testing-library/react resolves the same copy
  // desktop uses (otherwise jsdom render hits a null dispatcher — "Cannot read
  // properties of null (reading 'useState')"). dedupe is belt-and-suspenders.
  resolve: { dedupe: ["react", "react-dom"] },
  clearScreen: false,
  define: {
    "import.meta.env.VITE_CHIEF_PAT": JSON.stringify(devChiefPat(mode)),
  },
  server: {
    port: 1420,
    strictPort: true,
    // Proxy Chief (Storytell) API calls so the browser localhost preview isn't blocked by
    // CORS. The frontend talks to "/chief-api/*" and Vite forwards to api.storytell.ai.
    // (In the packaged Tauri app this should move to the Tauri HTTP plugin — see epic .)
    proxy: {
      "/chief-api": {
        target: "https://api.storytell.ai",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/chief-api/, ""),
      },
    },
  },
  // Most tests run under node; test-setup.ts shims localStorage so the persist
  // middleware doesn't crash. Component tests opt into jsdom per-file via a
  // `// @vitest-environment jsdom` docblock (see Composer.dictation.test.tsx).
  test: {
    setupFiles: ["./src/test-setup.ts"],
    // Coverage measurement only (no thresholds yet — see the CI-ratchet bead). The
    // numbers are informational until a floor is tuned against the CI runner.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
}));
