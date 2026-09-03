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

import { roborevRemediation } from "./pipelineHealthEscalation";

// fileURLToPath, never `new URL(...).pathname`: every worktree on this machine lives under a path
// containing a space ("Application Support"), which a URL pathname percent-encodes into a directory
// that does not exist. AGENTS.md records this as the only case here, not an edge case.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLASSIFIER = join(HERE, "..", "..", "..", "..", "scripts", "lib", "pipeline-health.sh");

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
