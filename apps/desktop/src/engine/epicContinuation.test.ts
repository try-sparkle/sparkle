import { describe, it, expect } from "vitest";
import {
  decideEpicSweep,
  decideEpicSweeps,
  EPIC_STALL_MS,
  EPIC_MAX_STALL_AGE_MS,
  type EpicSweepCandidate,
} from "./epicContinuation";

const NOW = 1_700_000_000_000;
const STALE = NOW - EPIC_STALL_MS - 1; // just past the window
const FRESH = NOW - 60_000;

/** The canonical STALLED-AND-RESTARTABLE epic: promoted, then planned, then abandoned. Each test
 *  overrides exactly the field it is about, so a case reads as "this situation, minus that one
 *  difference" and cannot pass for a reason it did not name. */
const stalled = (over: Partial<EpicSweepCandidate> = {}): EpicSweepCandidate => ({
  epicId: "e1",
  status: "planning",
  promoted: true,
  lastSweepRestartAt: null, // the sweep has not spent its one restart yet
  orchestratorAlive: false,
  lastChildProgressAt: STALE,
  alreadyEscalated: false,
  ...over,
});

const act = (over: Partial<EpicSweepCandidate> = {}) => decideEpicSweep(stalled(over), NOW).action;
const why = (over: Partial<EpicSweepCandidate> = {}) => decideEpicSweep(stalled(over), NOW).reason;

describe("decideEpicSweep — the case it exists for", () => {
  // The founder's whole complaint in one assertion: a build agent wrote the plan and stopped, and
  // two hours later nothing has picked it up.
  it("restarts an epic whose plan was written and then abandoned", () => {
    expect(act()).toBe("restart");
  });

  it("restarts a PARTLY built epic that stopped moving", () => {
    // "big tasks get partially done and do not get done to completion" — the half-finished case is
    // the one he actually loses work to, so it must not be narrower than `planning`.
    expect(act({ status: "in_progress" })).toBe("restart");
  });
});

describe("decideEpicSweep — what it must never touch", () => {
  it("skips an epic that was never promoted to Build", () => {
    // THE WATCH GATE, and the reason the sweep cannot run away: the store holds 23 de-facto epics
    // and thousands of retro beads. Without this, every one of them is a spawn candidate.
    expect(act({ promoted: false })).toBe("skip");
    expect(why({ promoted: false })).toBe("not-watched");
  });

  it("checks the watch gate BEFORE anything else, however stalled the epic looks", () => {
    // Ordering, asserted directly: an unwatched epic that is stalled, unescalated and long dead
    // still yields not-watched rather than any later rule's answer.
    const d = decideEpicSweep(
      stalled({ promoted: false, lastChildProgressAt: 0, status: "in_progress" }),
      NOW,
    );
    expect(d).toEqual({ epicId: "e1", action: "skip", reason: "not-watched" });
  });

  it("skips an epic with no children — there is no plan to execute", () => {
    // The `unplanned` / `planning` split is what makes this rule expressible. While both said
    // `not_started`, a restart here would hand a build agent an empty brief.
    expect(act({ status: "unplanned" })).toBe("skip");
    expect(why({ status: "unplanned" })).toBe("nothing-planned");
  });

  it("skips a finished epic", () => {
    expect(act({ status: "done" })).toBe("skip");
    expect(why({ status: "done" })).toBe("already-done");
  });

  it("skips an epic a build agent is on right now", () => {
    // A wedged-but-alive agent belongs to apiRecovery, and a dead one to resurrection. This sweep
    // fires only when the AGENT is gone and the WORK survives it.
    expect(act({ orchestratorAlive: true })).toBe("skip");
    expect(why({ orchestratorAlive: true })).toBe("orchestrator-alive");
  });

  it("skips an epic that stalled less than the window ago", () => {
    expect(act({ lastChildProgressAt: FRESH })).toBe("skip");
    expect(why({ lastChildProgressAt: FRESH })).toBe("too-soon");
  });

  it("refuses to act when the age of the last progress is unknown", () => {
    // FAIL CLOSED. An unreadable timestamp is not evidence of a stall, and must never be able to
    // authorize a spawn.
    expect(act({ lastChildProgressAt: null })).toBe("skip");
    expect(why({ lastChildProgressAt: null })).toBe("unknown-age");
  });

  it("treats the window as a real boundary, not an approximate one", () => {
    expect(act({ lastChildProgressAt: NOW - EPIC_STALL_MS + 1 })).toBe("skip");
    expect(act({ lastChildProgressAt: NOW - EPIC_STALL_MS })).toBe("restart");
  });
});

describe("decideEpicSweep — restart once, then escalate", () => {
  // The anti-loop property, and the reason the founder gets a bounded sweep rather than a spawner.
  it("escalates instead of restarting when the last handoff already came after the last progress", () => {
    const d = decideEpicSweep(stalled({ lastSweepRestartAt: STALE + 1 }), NOW);
    expect(d.action).toBe("escalate");
  });

  it("never restarts twice in a row with nothing in between", () => {
    // Walk the actual sequence rather than asserting a counter: restart, then a second sweep with
    // the handoff that restart created and no new child progress.
    const first = decideEpicSweep(stalled(), NOW);
    expect(first.action).toBe("restart");
    const afterRestart = stalled({ lastSweepRestartAt: NOW }); // the marker the restart wrote
    expect(decideEpicSweep(afterRestart, NOW + EPIC_STALL_MS * 2).action).toBe("escalate");
  });

  it("DOES restart again when the previous restart actually moved the work", () => {
    // One restart per STALL, not one per epic for all time. An epic this sweep rescued in March
    // must still be eligible when it stalls again in September.
    const rescuedThenStalledAgain = stalled({
      lastSweepRestartAt: NOW - 10 * EPIC_STALL_MS, // the sweep's restart…
      lastChildProgressAt: NOW - 2 * EPIC_STALL_MS, // …which produced real movement after it
    });
    expect(decideEpicSweep(rescuedThenStalledAgain, NOW).action).toBe("restart");
  });

  // REGRESSION (found in review, not by this suite). The budget used to be read off the newest
  // BOUND BUILD AGENT's creation time — but `sendToBuild` REUSES the agent already bound to an
  // epic, so that timestamp never advances past a restart. Since the watch gate guarantees such an
  // agent exists before anything can be restarted, escalate was unreachable and the sweep would
  // have restarted the same dead epic every ten minutes forever, telling the founder each time
  // that it would stop. The budget is now a marker only the sweep itself writes.
  it("a promotion the FOUNDER made does not spend the sweep's restart", () => {
    // He promotes an already-planned epic; the orchestrator dies. The sweep owes this epic its one
    // restart — escalating here would be a false claim about a restart nobody spent.
    expect(act({ promoted: true, lastSweepRestartAt: null })).toBe("restart");
  });

  it("a missing marker means OWED a restart, never already-tried", () => {
    // Reading null as "we already tried" would escalate every stall on sight, and the sweep would
    // never restart anything at all — the exact inverse of the infinite-loop bug, and just as bad.
    // A stale-but-in-reach epic; `0` would now be answered by the max-age cap instead.
    expect(act({ lastSweepRestartAt: null, lastChildProgressAt: STALE })).toBe("restart");
  });

  it("stays quiet once escalated — escalation stops the loop, it does not slow it", () => {
    expect(act({ alreadyEscalated: true, lastSweepRestartAt: STALE + 1 })).toBe("skip");
    expect(why({ alreadyEscalated: true, lastSweepRestartAt: STALE + 1 })).toBe("already-escalated");
  });
});

describe("decideEpicSweep — taking a stale escalation back off", () => {
  // A false alarm left sitting in the lane the human scans for real ones is worse than no alarm.
  it("clears the mark when the work starts moving again", () => {
    expect(act({ alreadyEscalated: true, lastChildProgressAt: NOW })).toBe("clear");
  });

  it("clears the mark when a build agent picks the epic up", () => {
    expect(act({ alreadyEscalated: true, orchestratorAlive: true })).toBe("clear");
  });

  it("clears the mark when the epic finishes", () => {
    expect(act({ alreadyEscalated: true, status: "done" })).toBe("clear");
  });

  // REGRESSION. The first version cleared on `lastChildProgressAt > lastHandoffAt` — "the last
  // thing that happened was work, not a handoff" — which is TRUE of an epic planned three weeks ago
  // and untouched since. That cleared the mark on exactly the dead epics escalation exists to
  // surface, and the next tick would re-escalate them, flapping the human's lane indefinitely.
  it("does NOT clear a still-stalled escalated epic", () => {
    expect(act({ alreadyEscalated: true })).toBe("skip");
    expect(why({ alreadyEscalated: true })).toBe("already-escalated");
  });

  it("never clears an epic outside the watch set", () => {
    // An epic that was never promoted cannot be carrying a mark this sweep wrote, so touching it
    // would mean writing to a bead on the strength of a label somebody else set.
    expect(act({ alreadyEscalated: true, promoted: false, status: "done" })).toBe("skip");
  });
});


// ── HOW FAR BACK THE SWEEP REACHES ─────────────────────────────────────────────────────────────
// The founder's call: beyond about two weeks a silent epic is a decision he already made, not a
// stall to recover. Measured against the live store, without this the FIRST run surfaces a
// 53-day-old epic alongside a 3-hour-old one and the recent stalls are lost in the noise.
describe("decideEpicSweep — the max-age reach cap", () => {
  const ANCIENT = NOW - EPIC_MAX_STALL_AGE_MS - 1;

  it("leaves an epic that stopped moving longer ago than the cap", () => {
    expect(act({ lastChildProgressAt: ANCIENT })).toBe("skip");
    expect(why({ lastChildProgressAt: ANCIENT })).toBe("too-old");
  });

  it("treats the cap as a real boundary", () => {
    expect(act({ lastChildProgressAt: NOW - EPIC_MAX_STALL_AGE_MS + 1 })).toBe("restart");
    expect(act({ lastChildProgressAt: NOW - EPIC_MAX_STALL_AGE_MS - 1 })).toBe("skip");
  });

  it("does not escalate an out-of-reach epic either", () => {
    // The cap sits ahead of BOTH act-branches, so an ancient epic is neither restarted nor newly
    // marked — it is left exactly as it is.
    expect(act({ lastChildProgressAt: ANCIENT, lastSweepRestartAt: NOW })).toBe("skip");
  });

  it("STILL clears a stale mark on an epic that is moving again", () => {
    // The cap is checked AFTER the freshness branch on purpose. An epic falling out of the window
    // must not strand a "this needs you" flag in the Blocked lane with nothing able to remove it.
    expect(act({ alreadyEscalated: true, lastChildProgressAt: NOW })).toBe("clear");
    expect(act({ alreadyEscalated: true, orchestratorAlive: true })).toBe("clear");
  });

  it("is an injectable window, not a hardcoded one", () => {
    expect(decideEpicSweep(stalled(), NOW, EPIC_STALL_MS, 60_000).action).toBe("skip");
    expect(decideEpicSweep(stalled(), NOW, EPIC_STALL_MS, 60_000).reason).toBe("too-old");
  });
});

describe("decideEpicSweeps", () => {
  it("returns one decision per candidate, skips included, in order", () => {
    // A sweep that silently drops candidates cannot be debugged from its own output.
    const out = decideEpicSweeps(
      [stalled({ epicId: "a" }), stalled({ epicId: "b", promoted: false }), stalled({ epicId: "c", status: "done" })],
      NOW,
    );
    expect(out.map((d) => d.epicId)).toEqual(["a", "b", "c"]);
    expect(out.map((d) => d.action)).toEqual(["restart", "skip", "skip"]);
  });

  it("honours a caller-supplied window", () => {
    const out = decideEpicSweeps([stalled({ lastChildProgressAt: FRESH })], NOW, 30_000);
    expect(out[0]?.action).toBe("restart");
  });
});
