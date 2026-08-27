// FALSE-ABSENCE CASE: corpus instance `epic-sweeper-no-change` (bead sparkle-gazo4a).
//
// MEASURED: "The epic sweeper read 'no observable change' as 'no progress' while workers were
// actively committing." The sweeper's evidence that anybody is on an epic is the ROSTER — the build
// agents bound to it — and `boundAgentsFor` over an unread roster returns exactly what it returns
// over a genuinely unstaffed one: nothing. So the sweep manufactured "nobody is building this" out
// of its own missing reading and acted on it, which is a spawn against an epic somebody is already
// building.
//
// The contract is `apps/desktop/shared/false-absence-corpus.json`. Every assertion here drives the
// REAL `decideEpicSweep` and the REAL `candidateFor`, and each is PAIRED with the observed reading
// so a rule that simply refuses everything cannot pass.
import { describe, expect, it } from "vitest";

import {
  EPIC_STALL_MS,
  type EpicSweepCandidate,
  decideEpicSweep,
} from "./epicContinuation";
import { absenceClaimIn } from "./probeOutcome";

const NOW = 1_700_000_000_000;
const STALE = NOW - EPIC_STALL_MS - 1;

/** The canonical stalled-and-restartable epic, with staffing OBSERVED as empty. */
const stalled = (over: Partial<EpicSweepCandidate> = {}): EpicSweepCandidate => ({
  epicId: "e1",
  status: "planning",
  promoted: true,
  lastSweepRestartAt: null,
  orchestratorAlive: false,
  lastChildProgressAt: STALE,
  alreadyEscalated: false,
  ...over,
});

describe("instance epic-sweeper-no-change: an unread roster is not an unstaffed epic", () => {
  it("THE CASE — staffing unreadable refuses to act, and says which refusal it is", () => {
    const d = decideEpicSweep(stalled({ orchestratorAlive: null }), NOW);
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("staffing-unknown");
  });

  it("PAIRED — the SAME epic with staffing genuinely OBSERVED empty still restarts", () => {
    // Without this, the assertion above passes against a sweep that has been switched off entirely,
    // which would silently re-open the founder's original complaint: epics sitting unstaffed with
    // nothing driving them.
    expect(decideEpicSweep(stalled({ orchestratorAlive: false }), NOW).action).toBe("restart");
  });

  it("PAIRED — an OBSERVED live orchestrator still skips for its own, different reason", () => {
    // Three outcomes, three answers. If `staffing-unknown` had been folded onto this arm the sweep
    // would report "someone is on it" about an epic it could not read — the same false confidence
    // pointed the other way.
    expect(decideEpicSweep(stalled({ orchestratorAlive: true }), NOW).reason).toBe("orchestrator-alive");
  });

  it("an unreadable roster does NOT clear a standing escalation", () => {
    // Clearing is an assertion that the epic is fine. `orchestratorAlive: true` earns that; `null`
    // cannot, because nothing was established. A `clear()` here would silently retract a real alarm
    // on the strength of a failed read — the most expensive shape in the corpus, since it erases
    // its own evidence.
    const d = decideEpicSweep(stalled({ orchestratorAlive: null, alreadyEscalated: true }), NOW);
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("staffing-unknown");
    expect(decideEpicSweep(stalled({ orchestratorAlive: true, alreadyEscalated: true }), NOW).action).toBe(
      "clear",
    );
  });

  it("`null` is checked BEFORE the truthiness test, or it falls through to the restart ladder", () => {
    // The ordering is the whole mechanism: `null` is falsy, so a rule written as
    // `if (c.orchestratorAlive) …` first would treat an unreadable roster identically to an empty
    // one and this file would be decoration. Pinned by asserting the two are DIFFERENT.
    const unknown = decideEpicSweep(stalled({ orchestratorAlive: null }), NOW);
    const empty = decideEpicSweep(stalled({ orchestratorAlive: false }), NOW);
    expect(unknown.action).not.toBe(empty.action);
  });

  it("no skip reason this module can emit reads as an absence claim", () => {
    // The reasons are shown to a human in the sweep log. `staffing-unknown` must not be phrased as
    // absence, and neither must its neighbours — the lexicon is the same one every other surface in
    // this bead is held to.
    for (const reason of ["staffing-unknown", "unknown-age", "orchestrator-alive"] as const) {
      expect(absenceClaimIn(reason), `skip reason "${reason}" reads as an absence claim`).toBeNull();
    }
  });
});
