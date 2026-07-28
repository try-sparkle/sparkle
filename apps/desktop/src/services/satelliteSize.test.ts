// Node environment on purpose: this test READS THE RUST SOURCE, and `import.meta.url` is only a
// file: URL outside jsdom (where vitest rewrites it to an http: one).
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { POOL_EXHAUSTED_MARKER, SATELLITE_SIZE, tearOffErrorMessage } from "./satelliteWindows";

// The satellite's footprint is decided in Rust (project_window.rs) but the DROP POSITION is computed
// here from a mirrored copy — so the two can drift, and when they do the window lands off-centre or
// half off the screen edge with nothing failing. Reading the Rust source is the only way to notice.
describe("SATELLITE_SIZE mirrors the Rust window builder", () => {
  const rust = readFileSync(
    new URL("../../src-tauri/src/project_window.rs", import.meta.url),
    "utf8",
  );

  it.each([
    ["DEFAULT_W", SATELLITE_SIZE.width],
    ["DEFAULT_H", SATELLITE_SIZE.height],
  ])("%s matches", (name, ours) => {
    const m = new RegExp(`const ${name}: f64 = ([0-9.]+);`).exec(rust);
    expect(m, `${name} not found in project_window.rs — did the constant get renamed?`).toBeTruthy();
    expect(Number(m![1])).toBe(ours);
  });
});

// The pool-exhaustion message is a STRING MATCH ACROSS A LANGUAGE BOUNDARY, and it was wrong on
// first write: the frontend tested for "no free", which Rust never says, so the one tear-off failure
// a user can act on ("bring a window back first") fell through to the generic message with nothing
// failing. Same shape of guard as the size constants above, for the same reason.
describe("pool-exhaustion message matches what Rust actually returns", () => {
  const rust = readFileSync(
    new URL("../../src-tauri/src/project_window.rs", import.meta.url),
    "utf8",
  );

  it("the marker appears in project_window.rs", () => {
    expect(rust).toContain(POOL_EXHAUSTED_MARKER);
  });

  it("maps the real Rust error to the actionable message", () => {
    // The exact string project_window.rs formats when every POOL slot is taken.
    const real = "all 4 satellite windows are already open";
    expect(tearOffErrorMessage(real)).toContain("Bring one back");
  });

  it("falls back to the generic message for anything else", () => {
    expect(tearOffErrorMessage(new Error("webview failed to build"))).toBe(
      "Could not open that project in its own window.",
    );
  });
});
