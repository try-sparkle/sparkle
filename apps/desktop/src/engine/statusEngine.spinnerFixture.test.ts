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

import { isSpinnerFrame, LIVE_TAIL_ROWS } from "./statusEngine";

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
  liveTailRows: number;
  knownGaps: { why: string; screenIsWorkingMisses: string[] };
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

  // THE ONE NUMBER BOTH SCRAPERS MUST AGREE ON. It was module-private here and a separate literal
  // in `nudge_gate.rs`, so a one-sided retune of the live-tail window was completely silent — and a
  // boundary test that BUILDS its grids from the constant cannot catch that either, because changing
  // the value moves the test with it. The fixture is now the source and both sides assert against it.
  it("agrees with the Rust scraper about how far up a live status line may sit", () => {
    expect(LIVE_TAIL_ROWS).toBe(fixture.liveTailRows);
  });

  // THE RECORDED ASYMMETRY — ASSERTED ON THE ONE THING THIS SIDE CAN ACTUALLY DRIFT ON.
  //
  // roborev's third round caught the previous version as VACUOUS, correctly: every
  // `screenIsWorkingMisses` entry is also a `working` entry, and the `it.each(fixture.working)` case
  // above already asserts `isSpinnerFrame` is true for all of them — so no mutation could red this
  // test without reding that one first. It read as coverage of the cross-language asymmetry while
  // covering nothing.
  //
  // What this side CAN prove is that the gap list still describes frames this fixture carries. Edit
  // a `working` frame's text and the stale entry left in `knownGaps` would satisfy the Rust
  // assertions anyway (its regex matches any well-formed bare frame, and the veto path rejects all
  // of them), so the list could stop describing the shipped frames with both suites green.
  it("declares gaps that are real `working` frames, not stale or invented strings", () => {
    expect(
      fixture.knownGaps.screenIsWorkingMisses.length,
      "an empty gap list would make the Rust partition test vacuous",
    ).toBeGreaterThan(0);
    const working = new Set(fixture.working.map((s) => s.frame));
    const notWorking = new Set(fixture.notWorking.map((s) => s.frame));
    for (const frame of fixture.knownGaps.screenIsWorkingMisses) {
      expect(working.has(frame), `knownGaps names ${frame}, which is not a \`working\` frame`).toBe(
        true,
      );
      // A gap is a frame the Rust VETO PATH misses; a frame nobody should match at all belongs in
      // `notWorking`. Listing one in both would make the partition incoherent.
      expect(notWorking.has(frame), `${frame} is declared both a gap and a negative`).toBe(false);
    }
  });

  // The fixture's own contract prose is load-bearing — it is where the retune instruction lives —
  // so an edit that guts it should be deliberate rather than silent.
  it("carries its contract, which is where the retune rule is written down", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as { contract: string[] };
    expect(raw.contract.join(" ")).toMatch(/RETUNE POINT/);
  });
});
