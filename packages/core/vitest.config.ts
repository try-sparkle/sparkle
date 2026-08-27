import { defineConfig } from "vitest/config";
import { testPoolOptions } from "../../vitest.pool.mjs";

// Coverage for the shared risk classifier with a blocking ratchet (bead .1):
// CI fails if statement/line coverage regresses below the floor below. The floor is set
// a few points UNDER the measured coverage so it doesn't flake on the CI runner; raise it
// as coverage climbs, but never above the current measured value.
export default defineConfig({
  test: {
    // Bound the worker pool (sparkle-jl3y) — see vitest.pool.mjs.
    poolOptions: testPoolOptions(),
    // Hold ONE machine-wide build-slot for the whole run (../../vitest.build-slot.mjs). poolOptions
    // caps workers PER run; this caps concurrent RUNS. It was wired into apps/desktop alone, so
    // every other package's `pnpm --filter <pkg> exec vitest run` — the command AGENTS.md tells
    // agents to use — was ungated: 25 concurrent vitest processes and a load average of 354 on 18
    // cores, with a 1.5s test file taking 904s wall clock (sparkle-fh0nuk, sparkle-8jut3h,
    // sparkle-v1e3q5). Fail-open by contract and skipped under CI, where the box is single-tenant.
    globalSetup: ["../../vitest.build-slot.mjs"],
    coverage: {
      provider: "v8",
      // Glob the flat package layout so a future top-level source file is measured
      // automatically (an explicit file list would silently omit it).
      include: ["*.ts"],
      exclude: ["*.test.ts", "*.config.ts"],
      reporter: ["text-summary", "json-summary"],
      // Blocking floor — a few points below the measured statement/line coverage.
      thresholds: {
        statements: 85,
        lines: 85,
      },
    },
  },
});
