// THE SHARED SPINNER FIXTURE, TYPESCRIPT HALF — one file, two suites, no drift.
//
// ══ WHY THIS FILE EXISTS (bead sparkle-s4c0xe) ═════════════════════════════════════════════════
// `apps/desktop/shared/spinner-frames.fixture.json` is parsed HERE and by `nudge_gate.rs`'s test
// module. The two scrapers had drifted and nothing could see it: this side grew
// `SPINNER_BARE_FRAME` when Claude Code 2.1.237 dropped the parenthetical from its status line, and
// the Rust side never got that arm — so `screen_is_working` was effectively DEAD on the shipped TUI.
//
// That mattered more on the far side than here. The Rust scraper is the MOUNT-INDEPENDENT one: it
// reads a headless vt100 grid for every PTY, so it is what can judge an agent nobody has opened.
// This one only ever runs inside a mounted pane. The blind half was the half with no backstop.
//
// THE FAILURE MODE IS SILENCE, which is the whole argument for a shared fixture rather than two
// independent test files. A matcher that stops matching raises no error and fails no assertion of
// its own — it just reports "not working" forever while the row goes gray on a live agent. AGENTS.md
// records the same shape for the Rust→TS wire payload: two halves built in parallel, both suites
// green, the feature never once ran.
//
// SO: add a frame in TODAY's shape to the FIXTURE when the TUI moves, never to one suite alone.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isSpinnerFrame } from "./statusEngine";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/spinner-frames.fixture.json",
);

interface Sample {
  why: string;
  frame: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  working: Sample[];
  notWorking: Sample[];
};

describe("the shared spinner fixture — the same bytes nudge_gate.rs asserts", () => {
  // NON-VACUITY FIRST. Every assertion below is a loop, and a loop over an empty array passes while
  // proving nothing — which is exactly how a fixture-driven guard dies without saying so.
  it("is not empty on either side, so the loops below prove something", () => {
    expect(fixture.working.length).toBeGreaterThanOrEqual(5);
    expect(fixture.notWorking.length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixture.working)("reads $frame as WORKING ($why)", ({ frame, why }) => {
    expect(isSpinnerFrame(frame), `Rust calls this working and this side does not — ${why}`).toBe(
      true,
    );
  });

  // THE FALSE-GREEN GUARD, and it is the more expensive direction: a matcher widened until it
  // accepts ordinary output paints a FINISHED agent green, and nothing retracts it.
  it.each(fixture.notWorking)("refuses $frame ($why)", ({ frame, why }) => {
    expect(isSpinnerFrame(frame), `this must never read as working — ${why}`).toBe(false);
  });

  // The fixture's own contract prose is load-bearing — it is where the retune instruction lives —
  // so an edit that guts it should be deliberate rather than silent.
  it("carries its contract, which is where the retune rule is written down", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as { contract: string[] };
    expect(raw.contract.join(" ")).toMatch(/RETUNE POINT/);
  });
});
