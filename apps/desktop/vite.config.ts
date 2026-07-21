/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testPoolOptions } from "../../vitest.pool.mjs";

// In dev, surface the user's Chief PAT to the app as VITE_CHIEF_PAT so the Think agent
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
export default defineConfig(({ mode, command }) => {
  // Resolve the Chief PAT once so we can BOTH inject it (dev) and assert it's absent from any
  // build. `command === "build"` is the export boundary (tauri build runs `vite build`); a packaged
  // bundle must never embed the PAT, even if someone builds with `--mode development`. devChiefPat
  // already returns "" outside development, but key the hard gate on the build command — not on
  // mode — so a misconfigured mode/NODE_ENV can't slip a real dev PAT into the public artifact.
  const chiefPat = devChiefPat(mode);
  if (command === "build" && chiefPat) {
    throw new Error(
      "Refusing to build: VITE_CHIEF_PAT would be embedded in the shipped bundle. The Chief PAT " +
        "is dev-serve only. Unset CHIEF_API / VITE_CHIEF_PAT (and don't build with --mode development).",
    );
  }
  return {
  plugins: [react()],
  build: {
    // The app only ever runs inside a system WebView — WKWebView on macOS (bundle
    // minimumSystemVersion 11.0 ⇒ Safari 14) and evergreen WebView2 on Windows. Target that
    // baseline explicitly (Safari 14 is the binding floor) so esbuild stops downleveling to the
    // older browsers in Vite's default matrix, shrinking the shipped bundle. NOT 'esnext': Safari
    // 14 can't run every latest-syntax feature, so an unbounded target risks a blank WebView on
    // macOS 11. Minify stays at Vite's default (esbuild).
    target: "safari14",
    rollupOptions: {
      output: {
        // Peel the heaviest third-party libraries into their own async vendor chunks (bead
        // sparkle-alrm.5, #9). Function form (not object) so React's multiple entry points —
        // react, react-dom AND react/jsx-runtime — are matched precisely by path: react-markdown
        // depends on React, so if jsx-runtime isn't pinned to vendor-react, Rollup folds it into
        // vendor-markdown, and because the eager shell also needs React that drags the whole
        // markdown chunk into the initial load. Pinning React FIRST keeps it shared/eager and
        // leaves react-markdown/remark-gfm genuinely async (reachable only via the lazy AgentPane →
        // ThinkPanel). xterm/posthog/socket.io are split for parallel download + long-lived caching
        // even where an eager module still references them. Their transitive deps that fall through
        // here are only reachable from already-async chunks, so Rollup keeps them async too.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Segment after the LAST node_modules/ — robust to pnpm's nested .pnpm store paths.
          const pkg = id.split("node_modules/").pop() ?? "";
          // Trailing-slash boundaries so "react/" never captures "react-markdown/".
          if (/^(react|react-dom|scheduler)\//.test(pkg)) return "vendor-react";
          if (pkg.startsWith("posthog-js/")) return "vendor-posthog";
          if (pkg.startsWith("@xterm/")) return "vendor-xterm";
          if (
            pkg.startsWith("socket.io-client/") ||
            pkg.startsWith("socket.io-parser/") ||
            pkg.startsWith("engine.io-client/") ||
            pkg.startsWith("engine.io-parser/")
          )
            return "vendor-socketio";
          if (pkg.startsWith("react-markdown/") || pkg.startsWith("remark-gfm/"))
            return "vendor-markdown";
          return undefined;
        },
      },
    },
  },
  // Keep a single React/React-DOM instance. The monorepo legitimately holds two
  // React versions (mobile/Expo pins 19.2.3; web + desktop use 19.2.4); the root
  // package.json pins 19.2.4 so @testing-library/react resolves the same copy
  // desktop uses (otherwise jsdom render hits a null dispatcher — "Cannot read
  // properties of null (reading 'useState')"). dedupe is belt-and-suspenders.
  resolve: { dedupe: ["react", "react-dom"] },
  clearScreen: false,
  define: {
    "import.meta.env.VITE_CHIEF_PAT": JSON.stringify(chiefPat),
    // App version baked in at build time (analytics super-property). Resolved
    // relative to THIS config file (not cwd) so a release script invoking the
    // build from the monorepo root still reads the desktop package's version.
    __SPARKLE_APP_VERSION__: JSON.stringify(
      (
        JSON.parse(
          readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
        ) as { version?: string }
      ).version ?? "0.0.0",
    ),
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
    // Bound the worker pool (sparkle-jl3y) — see vitest.pool.mjs. This is the largest suite in
    // the repo, so it is also the biggest single contributor to the process storm.
    poolOptions: testPoolOptions(),
    setupFiles: ["./src/test-setup.ts"],
    // Coverage with a blocking ratchet (bead .1): CI fails if statement/line
    // coverage regresses below the floor below. The floor is set a few points UNDER the
    // measured coverage so it doesn't flake on the CI runner; raise it as coverage climbs,
    // but never above the current measured value.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts", "src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      // Blocking floor — a few points below the measured statement/line coverage.
      thresholds: {
        statements: 30,
        lines: 30,
      },
    },
  },
  };
});
