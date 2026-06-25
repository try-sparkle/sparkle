import { defineConfig } from "vitest/config";

// Coverage for the shared risk classifier. No thresholds yet — measurement first;
// a non-decreasing ratchet in CI is tracked as a follow-up bead so a mis-set floor
// can't redden the gate before it's tuned against the CI runner.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Glob the flat package layout so a future top-level source file is measured
      // automatically (an explicit file list would silently omit it).
      include: ["*.ts"],
      exclude: ["*.test.ts", "*.config.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
