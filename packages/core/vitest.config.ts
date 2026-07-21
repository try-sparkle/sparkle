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
    coverage: {
      provider: "v8",
      // Glob the flat package layout so a future top-level source file is measured
      // automatically (an explicit file list would silently omit it).
      include: ["*.ts"],
      exclude: ["*.test.ts", "*.config.ts"],
      reporter: ["text-summary", "json-summary"],
      // Blocking floor — a few points below the measured statement/line coverage.
      thresholds: {
        statements: 72,
        lines: 72,
      },
    },
  },
});
