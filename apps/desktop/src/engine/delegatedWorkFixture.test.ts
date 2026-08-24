// THE SHARED DELEGATED-WORK FIXTURE, TYPESCRIPT HALF — one file, two suites, no drift.
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
// `apps/desktop/shared/delegated-work.fixture.json` is parsed HERE and by `observed_attention.rs`'s
// test module. Both languages now answer "is delegated work visible on this grid?", and they answer
// it for DIFFERENT populations: this side reads a MOUNTED pane's snapshot, the Rust side reads a
// headless vt100 grid for every PTY whether or not anybody has opened it. Two readers, one question
// — which is exactly the shape AGENTS.md records as measured: two halves built in parallel against
// a frozen list, both suites green, the shipped feature never once running.
//
// THE FAILURE MODE IS SILENCE. A matcher that stops matching raises nothing and asserts nothing of
// its own; it reports "no delegation" forever while a fanned-out agent's row goes gray. So when the
// Claude Code TUI moves, add the new shape to the FIXTURE — never to one suite alone.
//
// ── THE PARTITION IS DERIVED, NOT RESTATED ──────────────────────────────────────────────────────
// This asks the parser about every screen and compares to the fixture's own `delegating` flag. It
// does not carry a list of which screens are which: such a list is the vacuous shape AGENTS.md calls
// the #1 fleet-wide finding, since it passes with the matcher deleted. The two emptiness guards make
// BOTH directions red — a matcher stuck on "yes" and one stuck on "no".
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDelegatedWorkCount } from "./backgroundTaskFooter";
import { parseObservedReading } from "./observedAttention";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Screen {
  why: string;
  delegating: boolean;
  lines: string[];
}

const screens = (
  JSON.parse(
    readFileSync(resolve(HERE, "../../shared/delegated-work.fixture.json"), "utf8"),
  ) as { screens: Screen[] }
).screens;

const wire = JSON.parse(
  readFileSync(resolve(HERE, "../../shared/observed-attention.fixture.json"), "utf8"),
) as { samples: { why: string; payload: Record<string, unknown> }[] };

describe("the shared delegated-work fixture", () => {
  it("carries screens of BOTH kinds, or one half of this suite is vacuous", () => {
    expect(screens.length).toBeGreaterThan(0);
    // A matcher stuck on `false` passes a fixture with no delegating screens; one stuck on `true`
    // passes a fixture with no idle ones. Both must be impossible.
    expect(screens.some((s) => s.delegating)).toBe(true);
    expect(screens.some((s) => !s.delegating)).toBe(true);
  });

  it.each(screens)("$why", ({ delegating, lines }) => {
    const count = parseDelegatedWorkCount(lines.join("\n"));
    // `null` is ABSENCE, never zero — every reader keeps one definition of "in motion".
    expect(count !== null).toBe(delegating);
    if (delegating) expect(count).toBeGreaterThan(0);
  });
});

describe("the delegating verdict on the wire", () => {
  // The Rust producer emits this token; if the parser here does not accept it the payload is
  // DROPPED for that one agent and the feature is inert for every unopened row — silently, which is
  // the precise failure the shared fixture exists to make loud.
  const sample = wire.samples.find((s) => s.payload.verdict === "delegating");

  it("is carried by the shared wire fixture", () => {
    expect(sample, "observed-attention.fixture.json has no `delegating` sample").toBeDefined();
  });

  it("parses rather than being discarded as an unknown token", () => {
    const parsed = parseObservedReading(sample!.payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.reading.verdict).toBe("delegating");
    expect(parsed?.agentId).toBe(sample!.payload.agentId);
  });
});
