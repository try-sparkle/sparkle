// pipelineHealthRemedyDrift — the roborev remedy keys on phrases owned by ANOTHER FILE.
//
// `roborevRemediation()` picks its text by matching phrases that `ph_classify_roborev_not_answering`
// in `scripts/lib/pipeline-health.sh` emits. That is a CROSS-FILE, CROSS-LANGUAGE coupling with no
// compiler and no import edge, so nothing tells either side when it breaks.
//
// THE FAILURE IS SILENT, AND IT IS SILENT IN THE SAFE DIRECTION, WHICH IS WHY IT NEEDS A TEST.
// If the shell wording drifts — "this is SLOW, not wedged" becomes "the store is slow, not wedged",
// say — every match falls through to the diagnose-first default. Nothing throws, nothing reds, no
// alert looks wrong: the operator simply stops being told that the retention sweep is the fix for a
// bloated store, and gets generic advice forever. A guard keyed on the OUTCOME cannot see this
// (the default is a legitimate outcome), and the unit tests cannot see it either because they use
// their own copies of the strings. Only reading the real shell source can.
//
// So this asserts the COUPLING, not the behaviour: every phrase the TS matches on still exists in
// the shell file that is supposed to produce it. It deliberately does NOT assert the full sentence
// — that would red on ordinary rewording that leaves the keyed fragment intact, and a guard that
// reds on correct edits gets deleted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { knightwatchRemediation, roborevRemediation } from "./pipelineHealthEscalation";

// fileURLToPath, never `new URL(...).pathname`: every worktree on this machine lives under a path
// containing a space ("Application Support"), which a URL pathname percent-encodes into a directory
// that does not exist. AGENTS.md records this as the only case here, not an edge case.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLASSIFIER = join(HERE, "..", "..", "..", "..", "scripts", "lib", "pipeline-health.sh");
// The RUST classifier is what actually produces the detail the app reads at runtime (the shell
// twin serves the CLI). `restart_remedy` there owns the reviewer phrases keyed on below.
const RUST_CLASSIFIER = join(HERE, "..", "..", "src-tauri", "src", "pipeline_health.rs");

/** The phrases `roborevRemediation` discriminates on, paired with the arm each one selects. */
const KEYED_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["genuine WEDGE", "the one arm where restarting is correct"],
  ["no roborev daemon process", "the daemon is absent and must be STARTED, not restarted"],
  ["SLOW, not wedged", "a bloated store — the arm that must never say restart"],
  ["THROTTLED by lock contention", "contention, which a restart provably does not clear"],
  ["UNDETERMINED", "the probe could not look — diagnose, never restart blind"],
];

describe("the roborev remedy's coupling to the shell classifier", () => {
  const source = readFileSync(CLASSIFIER, "utf8");

  // Anti-vacuity: if the path were wrong, readFileSync would throw — but a TRUNCATED or unexpectedly
  // small read would let every `toContain` below pass against a file that is not the classifier.
  it("actually read the classifier, not an empty or unrelated file", () => {
    expect(source.length, `suspiciously small read of ${CLASSIFIER}`).toBeGreaterThan(2000);
    expect(source, "this is not ph_classify_roborev_not_answering's file").toContain(
      "ph_classify_roborev_not_answering",
    );
  });

  it.each(KEYED_PHRASES)(
    "the shell still emits %s — the phrase selecting %s",
    (phrase, _why) => {
      expect(
        source,
        `roborevRemediation() matches on "${phrase}", but scripts/lib/pipeline-health.sh no longer ` +
          `contains it. Nothing breaks loudly: that arm silently falls through to the diagnose-first ` +
          `default, and the operator quietly stops getting the specific guidance. Re-key the regex in ` +
          `pipelineHealthEscalation.ts to the new wording, or restore the phrase.`,
      ).toContain(phrase);
    },
  );

  // The other half of the coupling: a phrase present in the shell must still SELECT its arm here.
  // Asserting only that the shell contains the text would pass if the TS side dropped the branch.
  it("each phrase still selects a distinct remedy on the TS side", () => {
    const remedies = KEYED_PHRASES.map(([p]) => roborevRemediation(`... ${p} ...`));
    expect(new Set(remedies).size, "two arms collapsed to the same remedy").toBe(KEYED_PHRASES.length);
    // And none of them is the default, which would mean the branch stopped matching.
    const fallback = roborevRemediation("");
    for (const [i, r] of remedies.entries()) {
      expect(r, `"${KEYED_PHRASES[i]![0]}" fell through to the default`).not.toBe(fallback);
    }
  });
});

// ── The reviewer remedy keys on phrases owned by `restart_remedy` in pipeline_health.rs ─────────
//
// Same coupling, same silent failure, one component over (bead `sparkle-0wb6zp`).
// `knightwatchRemediation()` cannot see `[review].pr_reviewer` — the health component carries no
// reviewer field — so it reads which reviewer is configured out of the RESTART SENTENCE the Rust
// classifier already appended to the detail. If that sentence is reworded, every arm falls through
// to the reviewer-agnostic default: nothing throws, nothing reds, and the operator silently stops
// being told which reviewer to trigger. That is safe (the default names no reviewer) but it is a
// capability quietly lost, which is precisely the shape this file exists to catch.
describe("the reviewer remedy's coupling to the Rust classifier", () => {
  const rust = readFileSync(RUST_CLASSIFIER, "utf8");
  // Read again in this block: the first describe's `source` is scoped to that block.
  const shell = readFileSync(CLASSIFIER, "utf8");

  /** The phrases `knightwatchRemediation` discriminates on, paired with the arm each selects. */
  const REVIEWER_PHRASES: ReadonlyArray<readonly [string, string]> = [
    ["/srosro-update-review", "knightwatch — another machine, nothing here to restart"],
    ["scripts/pr-review.sh", "sparkle-reviewer — the local sweep, which IS the thing to check"],
  ];

  // Anti-vacuity: a truncated or wrong read would let every `toContain` below pass.
  it("actually read pipeline_health.rs, not an empty or unrelated file", () => {
    expect(rust.length, `suspiciously small read of ${RUST_CLASSIFIER}`).toBeGreaterThan(2000);
    expect(rust, "this is not classify_knightwatch's file").toContain("fn restart_remedy(");
  });

  it.each(REVIEWER_PHRASES)("the Rust still emits %s — selecting %s", (phrase, _why) => {
    expect(
      rust,
      `knightwatchRemediation() matches on "${phrase}", but pipeline_health.rs no longer contains ` +
        `it. Nothing breaks loudly: that arm falls through to the reviewer-agnostic default and the ` +
        `operator stops being told which reviewer to trigger. Re-key the regex in ` +
        `pipelineHealthEscalation.ts to the new wording, or restore the phrase.`,
    ).toContain(phrase);
  });

  // The other half: a phrase present in the Rust must still SELECT a distinct arm here.
  it("each phrase still selects a distinct remedy on the TS side", () => {
    const remedies = REVIEWER_PHRASES.map(([p]) => knightwatchRemediation(`... ${p} ...`));
    expect(new Set(remedies).size, "two arms collapsed to the same remedy").toBe(
      REVIEWER_PHRASES.length,
    );
    const fallback = knightwatchRemediation("");
    for (const [i, r] of remedies.entries()) {
      expect(r, `"${REVIEWER_PHRASES[i]![0]}" fell through to the default`).not.toBe(fallback);
    }
  });

  // Both classifiers are documented as keeping these sentences byte-identical, so the CLI twin must
  // carry them too — otherwise `scripts/pipeline-health-scan.sh` and the app disagree about the
  // remedy for the same reading.
  it.each(REVIEWER_PHRASES)("the shell twin still emits %s as well", (phrase, _why) => {
    expect(
      shell,
      `pipeline_health.rs and scripts/lib/pipeline-health.sh are documented as byte-identical on ` +
        `the restart sentence, but the shell no longer contains "${phrase}".`,
    ).toContain(phrase);
  });
});
