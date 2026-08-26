/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testPoolOptions } from "../../vitest.pool.mjs";
import { TAURI_SHIM } from "./scripts/visual/tauriShim.mjs";
import { PREVIEW_MODE } from "./src/dev/devBypassAuth";

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
      // `m?.[1]` rather than `m[1]`: this file is now inside the typechecked program (a test
      // imports it to pin the PAT gate), and `noUncheckedIndexedAccess` types a capture group as
      // possibly-undefined. Behaviour is identical — `(.+)` is not optional, so a match always
      // participates — this just states it in a way tsc can see.
      const raw = m?.[1];
      if (raw !== undefined) return raw.replace(/^["']|["']$/g, "").trim();
    }
  }
  return "";
}

/**
 * SERVES THE DEV-ONLY TAURI IPC BRIDGE TO THE AGENT PREVIEW SERVER (bead sparkle-bg6868).
 *
 * THE BUG. `.sparkle/config.toml`'s `[preview]` block points every agent's preview at this
 * package's vite dev server. A plain browser has no Tauri IPC, so `trialApi.fetchTrial()` —
 * `invoke("trial_status")` — rejects, `trialStore` sets `error`, and `AuthGate` paints
 * WelcomeScreen: "We couldn't load your free-trial status." That, and not the app, is what every
 * preview card has been showing, and the founder's screenshots are exactly it.
 *
 * WHY NOT JUST THE AUTH BYPASS. Setting `VITE_SPARKLE_DEV_BYPASS_AUTH=1` alone was tried and
 * MEASURED WORSE (`PRD/sparkle/preview-usable.md`): the tree then mounts and every `invoke()`
 * inside it throws, so the app lands on its own error boundary ("Something broke", 19 DOM nodes)
 * instead of the gate's correctly-styled page (38). The bypass gets you PAST the gate; the shim is
 * what lets the app behind it actually run. The visual harness has always used BOTH — that pairing
 * is what this reproduces.
 *
 * WHAT MAKES IT UNREACHABLE IN A RELEASE BUILD — the point that is not optional, because this
 * fakes the answer to an entitlement check. Three independent gates, any one of which suffices:
 *   1. This function returns `undefined` unless `command === "serve"`. `vite build` — the command
 *      `tauri build` runs to produce the shipped bundle — is `command === "build"`, so the plugin
 *      is never even constructed and the shim string is never referenced by anything Rollup walks.
 *   2. `apply: "serve"`, vite's own belt-and-braces for the same thing.
 *   3. `mode === PREVIEW_MODE`. `--mode preview` is passed by exactly one caller in this repo, the
 *      `[preview]` override in `.sparkle/config.toml`. A packaged build is mode `production`, and
 *      a developer's own `pnpm dev` / `pnpm tauri dev` is mode `development` — so neither the
 *      shipped app nor the ordinary dev loop is touched by this at all.
 * `previewTauriShimGate.test.ts` asserts all three directions.
 *
 * `head-prepend`, not `head`: the shim must be evaluated before `<script type="module"
 * src="/src/main.tsx">`, which is deferred — so a classic inline script at the top of <head> is
 * already in place when the first app module runs. That is the same ordering guarantee the harness
 * gets from `Page.addScriptToEvaluateOnNewDocument`.
 */
function previewTauriShim(mode: string, command: "serve" | "build"): Plugin | undefined {
  if (command !== "serve" || mode !== PREVIEW_MODE) return undefined;
  return {
    name: "sparkle-preview-tauri-shim",
    apply: "serve",
    transformIndexHtml() {
      return [{ tag: "script", children: TAURI_SHIM, injectTo: "head-prepend" as const }];
    },
  };
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
  const shim = previewTauriShim(mode, command);
  return {
  // A ternary rather than `[react(), shim].filter(Boolean)`: the filter form types the array as
  // `(Plugin | undefined)[]`, which hides exactly the thing worth seeing here — that the shim is
  // in the list only when `previewTauriShim` decided it may be.
  plugins: shim ? [react(), shim] : [react()],
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
      // Chief's hosted MCP server — a DIFFERENT host from the REST API above, so it needs its own
      // proxy entry here and its own allow-list entry in src-tauri/capabilities/default.json.
      // Missing either one surfaces as a bare "Load failed" rather than a CORS/CSP message (the
      // failure mode bead `` documents for api.storytell.ai). Streamable HTTP, so the
      // proxy must not buffer: `text/event-stream` responses are read incrementally.
      "/chief-mcp": {
        target: "https://mcp.storytell.ai",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/chief-mcp/, ""),
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
    // Hold ONE machine-wide build-slot for the whole run (../../vitest.build-slot.mjs). poolOptions
    // caps workers PER run; this caps concurrent RUNS, so N agents each starting their own vitest
    // cannot all compile+test at once — the ungated storm measured at 25 concurrent runs. Fail-open
    // and skipped under CI; the biggest suite is where it matters most.
    globalSetup: ["../../vitest.build-slot.mjs"],
    setupFiles: ["./src/test-setup.ts"],
    // Keep the per-test deadline strictly above Testing Library's async default so a slow
    // real-timer waitFor under coverage instrumentation surfaces its own RTL error/DOM dump
    // rather than a bare vitest timeout ().
    testTimeout: 15000,
    // Bounded retry (sparkle-jjqj). CI now runs this suite ONCE — instrumented and sharded — as
    // both the correctness and the coverage gate; the redundant plain pass was dropped. A single
    // async-settling flake under instrumentation load would therefore turn the whole gate red, so
    // a failed test is retried up to twice before it counts. This is a backstop for rare DOM-timing
    // flakes (e.g. a getAllByTestId count observed once under max pool contention), NOT a licence to
    // leave a genuinely broken test — a test that fails all three attempts still fails the gate.
    retry: 2,
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
        statements: 82,
        lines: 82,
      },
    },
  },
  };
});
