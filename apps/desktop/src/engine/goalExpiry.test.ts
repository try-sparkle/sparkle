import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL_TTL_MS,
  abandonGoal,
  dischargeGoal,
  escalateGoal,
  goalDeadline,
  goalStateOf,
  markGoalMet,
  newGoal,
  noteContinue,
  rearmGoal,
  resetGoalRetries,
  type AgentGoal,
} from "./agentGoal";
import { stallReport } from "./agentStall";
import { escalationFor } from "./stallEscalation";
import {
  MAX_TTL_REARMS,
  REARM_TTL_MS,
  decideExpiry,
  type ExpiryInput,
  type ExpiryProof,
} from "./goalExpiry";

const T0 = 1_700_000_000_000;

/** A goal that has JUST lapsed — one ms past its deadline, nothing else unusual about it. */
function lapsed(over: Partial<AgentGoal> = {}): AgentGoal {
  return { ...newGoal("Land the retry PR", T0), ...over };
}

/** The instant `lapsed()` expires. Derived rather than written, so a test cannot drift from the rule. */
const EXPIRED_AT = T0 + DEFAULT_GOAL_TTL_MS;

/** Evidence that says "this agent finished": landed, clean, nothing outstanding. */
function proofLanded(over: Partial<ExpiryProof> = {}): ExpiryProof {
  return {
    landed: true,
    clean: true,
    unlanded: false,
    hasOpenPr: false,
    worktreeOnBranch: true,
    tipSha: "a1b2c3d",
    baseSha: "d4e5f6a",
    ...over,
  };
}

/** Evidence that says "this agent is still holding work nobody has landed". */
function proofUnlanded(over: Partial<ExpiryProof> = {}): ExpiryProof {
  return proofLanded({ landed: false, clean: true, unlanded: true, ...over });
}

/** The same unlanded evidence with NO PR READING — the key ABSENT, not set to `undefined`.
 *
 *  Built by deletion because the distinction is the thing under test: a key present holding
 *  `undefined` reads as a supplied answer to anything that inspects the object, and `expiryProofFor`
 *  spreads-when-known precisely so it never produces that shape. A fixture that spread
 *  `{ hasOpenPr: undefined }` would be testing an object the producer cannot emit. */
function proofNoPrReading(over: Partial<ExpiryProof> = {}): ExpiryProof {
  const p = proofUnlanded(over);
  delete p.hasOpenPr;
  return p;
}

/** An expired agent that WOULD be adjudicated — every gate satisfied. Each test changes exactly one
 *  thing, so a test expecting `none` proves its own change caused the refusal rather than inheriting
 *  a fixture that never qualified. */
function ready(over: Partial<ExpiryInput> = {}): ExpiryInput {
  return {
    now: EXPIRED_AT,
    // The re-arm count lives ON THE GOAL, never beside it — see ExpiryInput. A test that wants a
    // spent budget passes `goal: lapsed({ ttlRearms: MAX_TTL_REARMS })`, so the count and the record
    // it describes cannot disagree the way a parallel parameter could.
    goal: lapsed({ ttlRearms: 0 }),
    runtime: "local",
    hasWorktree: true,
    proof: proofUnlanded(),
    ...over,
  };
}

describe("the baseline actually adjudicates", () => {
  // If this fixture stops qualifying, every `none` assertion below becomes vacuous — they would pass
  // against an input that could never have been adjudicated in the first place.
  it("re-arms an expired agent that still holds unlanded work", () => {
    expect(decideExpiry(ready()).action).toBe("rearm");
  });
});

describe("goalDeadline — the clock's origin moves, `setAt` does not", () => {
  it("reads from setAt until a re-arm, and from rearmedAt after one", () => {
    const g = lapsed();
    expect(goalDeadline(g)).toBe(T0 + DEFAULT_GOAL_TTL_MS);

    const armed = rearmGoal(g, EXPIRED_AT, REARM_TTL_MS);
    expect(goalDeadline(armed)).toBe(EXPIRED_AT + REARM_TTL_MS);
  });

  it("leaves setAt untouched, so a re-armed goal does not report as newborn", () => {
    // `goalRemainingMs` and the row's "active · 3h 20m left" badge are derived from the birth fact.
    // Overwriting `setAt` to extend the clock would make a four-hour-old goal claim it was just set,
    // which is the reading a human uses to decide whether an agent is worth waiting for.
    const armed = rearmGoal(lapsed(), EXPIRED_AT, REARM_TTL_MS);
    expect(armed.setAt).toBe(T0);
  });
});

describe("re-arm extends the CLOCK and nothing else", () => {
  it("returns an expired goal to unmet", () => {
    const g = lapsed();
    expect(goalStateOf(g, EXPIRED_AT)).toBe("expired");
    expect(goalStateOf(rearmGoal(g, EXPIRED_AT, REARM_TTL_MS), EXPIRED_AT)).toBe("unmet");
  });

  it("does NOT refill the retry budget", () => {
    // THE ANTI-LAUNDERING ASSERTION. Re-arm restores the MANDATE (the clock); it must not restore
    // the BUDGET (the retries). `continues`/`totalContinues` are what bound how much Sparkle may
    // spend restarting an agent that is getting nowhere, and a clock extension is not evidence that
    // restarting has started working. Written in the shape of `noteContinue` (purely additive), NOT
    // `resetGoalRetries` (the human's lever, which clears everything).
    const spent = noteContinue(noteContinue(lapsed(), "m1"), "m1");
    const armed = rearmGoal(spent, EXPIRED_AT, REARM_TTL_MS);
    expect(armed.continues).toBe(spent.continues);
    expect(armed.totalContinues).toBe(spent.totalContinues);
    expect(armed.mark).toBe(spent.mark);
  });

  it("counts itself, starting from an ABSENT counter", () => {
    // `ttlRearms` is optional because every goal already in the persisted store deserializes without
    // it. Read undefined-unsafely, `undefined >= MAX` is false (re-arm always allowed) and
    // `undefined + 1` is NaN (the counter never climbs) — an unbounded re-arm loop that typechecks.
    const virgin = lapsed();
    expect(virgin.ttlRearms).toBeUndefined();
    expect(rearmGoal(virgin, EXPIRED_AT, REARM_TTL_MS).ttlRearms).toBe(1);
    expect(rearmGoal(lapsed({ ttlRearms: 2 }), EXPIRED_AT, REARM_TTL_MS).ttlRearms).toBe(3);
  });

  it("never un-latches an escalation", () => {
    const esc = escalateGoal(lapsed(), T0 + 1, "a human owns this now");
    expect(rearmGoal(esc, EXPIRED_AT, REARM_TTL_MS).escalatedAt).toBe(T0 + 1);
  });
});

describe("discharge — the proof-backed close", () => {
  it("latches the state and records BOTH shas", () => {
    const d = dischargeGoal(lapsed(), EXPIRED_AT, "a1b2c3d", "d4e5f6a");
    expect(goalStateOf(d, EXPIRED_AT)).toBe("discharged");
    expect(d.dischargedSha).toBe("a1b2c3d");
    // The base is recorded because "commit X is contained in origin/main" is unfalsifiable after a
    // force-push, while "X was contained when origin/main was Y" stays checkable forever. A discharge
    // nobody can audit is not proof — it is an assertion.
    expect(d.dischargedBaseSha).toBe("d4e5f6a");
  });

  it("is idempotent — a second discharge keeps the FIRST timestamp", () => {
    const once = dischargeGoal(lapsed(), EXPIRED_AT, "a1b2c3d", "d4e5f6a");
    expect(dischargeGoal(once, EXPIRED_AT + 9_999, "zzz", "yyy").dischargedAt).toBe(EXPIRED_AT);
  });

  it("does NOT outrank an escalation", () => {
    // The two are mutually exclusive by the writer's gate, but a record that can express both must
    // order them so the impossible case renders LOUD rather than calm-and-finished.
    const both = dischargeGoal(escalateGoal(lapsed(), T0 + 1, "handed over"), EXPIRED_AT, "a", "b");
    expect(goalStateOf(both, EXPIRED_AT)).toBe("escalated");
  });

  it("does not outrank a goal the agent already marked met", () => {
    const met = { ...lapsed(), metAt: T0 + 5 };
    expect(goalStateOf(dischargeGoal(met, EXPIRED_AT, "a", "b"), EXPIRED_AT)).toBe("met");
  });
});

describe("abandon — an annotation ON an escalation, not a state beside it", () => {
  it("escalates, so nothing retries it and the human is told once", () => {
    // Writing THROUGH escalateGoal is what keeps this from becoming a second dead letter: it
    // inherits the `already-escalated` circuit breaker in decideContinuation, the existing
    // notifyAttention path, the amber `escalated-goal` floor (so the row can never fall back to
    // gray even if the red cause is later demoted), and any future ager built for escalations.
    const a = abandonGoal(lapsed(), EXPIRED_AT, "3 commits, none on origin/main");
    expect(goalStateOf(a, EXPIRED_AT)).toBe("escalated");
    expect(a.escalatedAt).toBe(EXPIRED_AT);
    expect(a.abandonedAt).toBe(EXPIRED_AT);
    expect(a.escalationReason).toContain("origin/main");
  });

  it("keeps the ORIGINAL escalation reason when one was already latched", () => {
    const esc = escalateGoal(lapsed(), T0 + 1, "auto-continue gave up");
    const a = abandonGoal(esc, EXPIRED_AT, "3 commits, none on origin/main");
    expect(a.escalationReason).toBe("auto-continue gave up");
    expect(a.abandonedAt).toBe(EXPIRED_AT);
  });
});

describe("resetGoalRetries — the human's lever clears the new counters too", () => {
  it("clears the re-arm budget and both latches", () => {
    const messy = abandonGoal(
      dischargeGoal(rearmGoal(lapsed(), EXPIRED_AT, REARM_TTL_MS), EXPIRED_AT, "a", "b"),
      EXPIRED_AT,
      "held work",
    );
    const clean = resetGoalRetries(messy);
    expect(clean.ttlRearms ?? 0).toBe(0);
    expect(clean.dischargedAt).toBeUndefined();
    expect(clean.dischargedSha).toBeUndefined();
    expect(clean.abandonedAt).toBeUndefined();
    expect(clean.escalatedAt).toBeUndefined();
  });

  it("leaves the CLOCK alone, so the lever cannot hand back an instantly-expired goal", () => {
    // A re-arm leaves a shorter `ttlMs` behind it. Clearing `rearmedAt` while keeping that lifetime
    // would recompute the deadline from the goal's original birth — moving it earlier, and normally
    // into the past. The human's own lever would then return a goal that expires the instant they
    // let go of it.
    const armed = rearmGoal(lapsed(), EXPIRED_AT, REARM_TTL_MS);
    const clean = resetGoalRetries(armed);
    expect(goalDeadline(clean)).toBe(EXPIRED_AT + REARM_TTL_MS);
    expect(goalStateOf(clean, EXPIRED_AT + 1)).toBe("unmet");
  });
});

describe("decideExpiry — rule order", () => {
  it("refuses anything that is not expired", () => {
    // Rule 1 is what makes it structurally impossible for this arm to touch a met, escalated, or
    // merely-unmet goal, however the evidence reads.
    expect(decideExpiry(ready({ now: T0 + 1 })).action).toBe("none");
    expect(decideExpiry(ready({ goal: { ...lapsed(), metAt: T0 + 5 } })).action).toBe("none");
  });

  it("discharges a landed, clean agent BEFORE considering a re-arm", () => {
    // Re-arming a finished agent is how slots get held all night: it would be resumed, find nothing
    // to do, and lapse again three more times before anyone was told.
    const d = decideExpiry(ready({ proof: proofLanded() }));
    expect(d.action).toBe("discharge");
    if (d.action !== "discharge") throw new Error("unreachable");
    expect(d.sha).toBe("a1b2c3d");
    expect(d.baseSha).toBe("d4e5f6a");
  });

  it("stops re-arming at the ceiling", () => {
    expect(decideExpiry(ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS - 1 }) })).action).toBe("rearm");
    expect(decideExpiry(ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }) })).action).toBe("abandon");
  });

  describe("fail-closed gates — each one alone must stop an adjudication", () => {
    it("refuses when the evidence was never read", () => {
      // The load-bearing one. `undefined` means "we did not look", and a latch written on a reading
      // nobody took is exactly the false `done` this whole mechanism exists to prevent.
      const d = decideExpiry(ready({ proof: undefined, goal: lapsed({ ttlRearms: MAX_TTL_REARMS }) }));
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("evidence-unreadable");
    });

    it("refuses a PARKED worktree, whose git state describes another branch", () => {
      // Measured on the founder's machine: 21 of ~48 worktrees sit off their minted branch, because
      // `git checkout -b <topic>` is what descriptive branch names look like. For those, `ahead` and
      // `dirty` describe the minted branch (usually empty), so the evidence reads "clean, nothing
      // unlanded" for an agent doing real work. Attribution is unknown, so nothing may be latched.
      const parked = decideExpiry(
        ready({ proof: proofLanded({ worktreeOnBranch: false }), goal: lapsed({ ttlRearms: MAX_TTL_REARMS }) }),
      );
      expect(parked.action).toBe("none");
      if (parked.action !== "none") throw new Error("unreachable");
      expect(parked.reason).toBe("worktree-parked");
    });

    it("refuses a CLOUD agent, whose work does not live in the local worktree", () => {
      // A cloud agent's branch is in a remote sandbox; the local worktree is clean and empty, which
      // reads as `landed && clean` — a discharge on the strength of a tree that was never the work.
      const d = decideExpiry(ready({ runtime: "cloud", proof: proofLanded() }));
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("cloud-runtime");
    });

    it("refuses an agent with no worktree at all", () => {
      const d = decideExpiry(ready({ hasWorktree: false, proof: undefined }));
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("no-worktree");
    });
  });

  describe("abandonment cannot fire on an agent that is not visibly holding work", () => {
    // PAIRED, deliberately. A single test proving absence is ambiguous — it passes just as well when
    // an earlier gate short-circuited for a reason unrelated to the rule under test. The control leg
    // is what pins the cause.
    it("does NOT abandon a clean, landed agent whose budget is spent", () => {
      expect(decideExpiry(ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofLanded() })).action).toBe(
        "discharge",
      );
    });

    it("DOES abandon the same agent once the work is visibly unlanded", () => {
      expect(decideExpiry(ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded() })).action).toBe(
        "abandon",
      );
    });

    it("does NOT abandon while a PR is open — that work is with CI, not with the founder", () => {
      const d = decideExpiry(
        ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded({ hasOpenPr: true }) }),
      );
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("pr-open");
    });

    it("refuses QUIETLY when the PR state was never read — and says which reading is missing", () => {
      // `undefined` is "we did not ask", never "there is no PR", so abandonment is withheld. The
      // reason is distinct from `evidence-unreadable` because the concierge reads these out and the
      // two send a human to different places.
      //
      // ⚠️ AN ESCALATION HERE WAS WRITTEN AND REVERTED, and the reason belongs in the test as much as
      // in the source: `readOpenPr` answers `undefined` for an ABSENT `workflowState` too, and the PR
      // probe is gated on a mounted pane — so a louder arm fires for every CLOSED-PANE agent whatever
      // its PR state, including work sitting safely with CI. Irreversibly, since `goalStateOf`
      // short-circuits on `escalatedAt` before `expired`. Quiet is recoverable; a wall of amber that
      // only a human can clear is not. Tracked as `sparkle-nmqcb`.
      const d = decideExpiry(
        ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofNoPrReading() }),
      );
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("pr-state-unknown");
    });

    it("…and the SAME agent abandons once that reading arrives — the pair", () => {
      // The control. Without it, "escalate rather than abandon" is satisfied by an implementation
      // that never abandons at all.
      expect(
        decideExpiry(
          ready({
            goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
            proof: proofUnlanded({ hasOpenPr: false }),
          }),
        ).action,
      ).toBe("abandon");
    });

    it("does NOT let a missing PR reading pre-empt the arms it has nothing to do with", () => {
      // THE ORDERING FIX. `pr-state-unknown` sat above these three, and `prState: null` is the
      // ORDINARY reading — so a landed agent with a dirty tree was told "we never asked about its
      // PR" instead of the true, actionable sentence, and the same for an agent that committed
      // nothing. A field read by ONE arm may withhold ONE decision; that is the whole basis on which
      // this file admits it as optional.
      const dirty = decideExpiry(
        ready({
          goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
          proof: proofNoPrReading({ landed: true, unlanded: false, clean: false }),
        }),
      );
      expect(dirty.action).toBe("none");
      if (dirty.action !== "none") throw new Error("unreachable");
      expect(dirty.reason).toBe("landed-but-dirty");

      const nothing = decideExpiry(
        ready({
          goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
          proof: proofNoPrReading({ landed: false, unlanded: false }),
        }),
      );
      expect(nothing.action).toBe("none");
      if (nothing.action !== "none") throw new Error("unreachable");
      expect(nothing.reason).toBe("budget-spent-nothing-proved");

      const contradictory = decideExpiry(
        ready({
          goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
          proof: proofNoPrReading({ landed: true, unlanded: true, clean: false }),
        }),
      );
      expect(contradictory.action).toBe("none");
      if (contradictory.action !== "none") throw new Error("unreachable");
      expect(contradictory.reason).toBe("evidence-contradictory");
    });

    it("re-arms that SAME unreadable-PR agent while budget remains — the gap withholds ONE decision", () => {
      // The control leg, and the reason `hasOpenPr` was made optional at all. Requiring it for the
      // whole proof made the producer answer `undefined` for every no-PR branch, so this agent — the
      // exact one the mechanism exists to rescue — was refused `evidence-unreadable` and never
      // re-armed. Only ABANDON may be withheld by a missing PR reading.
      expect(decideExpiry(ready({ goal: lapsed({ ttlRearms: 0 }), proof: proofNoPrReading() })).action).toBe("rearm");
    });

    it("still DISCHARGES an unreadable-PR agent that finished — the gap is not a freeze", () => {
      expect(
        decideExpiry(ready({ goal: lapsed({ ttlRearms: 0 }), proof: proofNoPrReading({ landed: true, unlanded: false }) }))
          .action,
      ).toBe("discharge");
    });

    it("does NOT abandon on `unlanded` alone when `landed` is not a positive NO", () => {
      // `unlanded` is reached through `bs.ahead > 0`, and `ahead` never returns to zero after a
      // squash merge — so it is true for every squash-landed agent forever. Two independent readings
      // must agree before the loudest signal in the app fires.
      //
      // ⚠️ `clean: false` IS LOad-BEARING, and this test proved nothing without it. With a clean tree
      // the DISCHARGE gate two rules earlier fires first, so the run never reached the rule under
      // test and the assertion passed on an outcome decided upstream of it — mutation-check caught
      // exactly that (the `!proof.landed` term could be deleted with this test still green). Dirty
      // the tree so discharge is refused and the abandon rule is actually the one answering.
      const d = decideExpiry(
        ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded({ landed: true, clean: false }) }),
      );
      // Asserting the REASON, not merely "not abandon": the weaker form is satisfied by every one of
      // the seven refusals above it, so it cannot tell this rule from any other gate.
      //
      // AND THE REASON IS `evidence-contradictory`, NOT "nothing proved". These reasons are sentences
      // the concierge reads out, and "the agent simply never committed anything" is FALSE for this
      // input — its evidence says it committed plenty, and merely disagrees with itself about where
      // that work ended up. Pinning the wrong sentence here would have cemented it.
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("evidence-contradictory");
    });

    it("distinguishes landed-with-leftovers from a contradiction — one reading true, not both", () => {
      // THE DISCRIMINATING CASE, and it exists because of a mutation that survived: with every other
      // input reaching this arm carrying `landed === unlanded`, flipping `&&` to `||` was invisible.
      // Only a case where exactly ONE reading is positive can tell the two apart. It is a real state
      // too — the work landed, the tree still holds uncommitted leftovers, so the discharge gate
      // refused for the dirt alone — and it must not be told it "produced no work".
      const d = decideExpiry(
        ready({
          goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
          proof: proofLanded({ landed: true, unlanded: false, clean: false }),
        }),
      );
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("landed-but-dirty");
    });

    it("does NOT abandon an agent that never committed anything — and says THAT instead", () => {
      // The `proof.unlanded` conjunct, which no test could falsify before: every case reaching this
      // arm carried `unlanded: true`, so deleting `proof.unlanded &&` left the suite green — and that
      // mutation would abandon (paint red, escalate, page a human) every expired agent that never
      // wrote a line. The dirty tree keeps the discharge gate from answering first.
      const d = decideExpiry(
        ready({
          goal: lapsed({ ttlRearms: MAX_TTL_REARMS }),
          proof: proofUnlanded({ landed: false, unlanded: false, clean: false }),
        }),
      );
      expect(d.action).toBe("none");
      if (d.action !== "none") throw new Error("unreachable");
      expect(d.reason).toBe("budget-spent-nothing-proved");
    });

    it("names the shas when it has them, and reads as a SENTENCE when it does not", () => {
      // The evidence is not a log line — it is the notification body a human reads and the
      // `abandonedEvidence` the row keeps. The shas are optional, and absent is their ONLY state
      // through the real mount today (`BranchStatus` carries none), so the unguarded template
      // rendered "committed work that undefined does not contain (branch tip undefined)".
      const withShas = decideExpiry(
        ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded({ tipSha: "a1b2c3d", baseSha: "d4e5f6a" }) }),
      );
      if (withShas.action !== "abandon") throw new Error("unreachable");
      expect(withShas.evidence).toContain("d4e5f6a");
      expect(withShas.evidence).toContain("branch tip a1b2c3d");

      const noShas = decideExpiry(
        ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded({ tipSha: undefined, baseSha: undefined }) }),
      );
      if (noShas.action !== "abandon") throw new Error("unreachable");
      expect(noShas.evidence).not.toContain("undefined");
      expect(noShas.evidence).toContain("the default branch does not contain");
    });

    it("DOES abandon the same dirty agent once `landed` is a positive NO", () => {
      // The control for the test above — without it, "did not abandon" is ambiguous between "the
      // rule refused" and "the fixture could never have abandoned".
      expect(
        decideExpiry(
          ready({ goal: lapsed({ ttlRearms: MAX_TTL_REARMS }), proof: proofUnlanded({ landed: false, clean: false }) }),
        ).action,
      ).toBe("abandon");
    });
  });
});

describe("the RED cause is unreachable except through a real abandonment", () => {
  // THE PRODUCER HALF. `redAttentionTaxonomy.test.ts` pins that `abandoned-goal` MAPS to red; this
  // pins that a clean agent cannot PRODUCE it. Both are needed — a cause that is correctly classified
  // but wrongly raised is exactly the false red that got expiry cut from the tier in the first place.
  const stallOf = (goal: AgentGoal) =>
    stallReport({
      status: "idle",
      now: EXPIRED_AT,
      goal,
      hasOpenPr: false,
      hasUnlandedWork: false,
      hasUncommittedChanges: false,
    });

  it("a lapsed goal on a spotless agent stays CALM — sparkle-biezi survives this change", () => {
    // The exact shape that produced four false red rows in one screenshot: idle, spotless worktree,
    // zero commits, goal merely out of time. It must still be gray.
    const report = stallOf(lapsed());
    expect(report.causes).toContain("expired-goal");
    expect(report.causes).not.toContain("abandoned-goal");
    expect(escalationFor(report)).toBe(undefined);
  });

  it("the same agent goes RED once the abandonment latch is actually written", () => {
    // The control. Without it, the assertion above cannot tell "the gate refused" from "this fixture
    // could never have gone red".
    const report = stallOf(abandonGoal(lapsed(), EXPIRED_AT, "3 commits, none on origin/main"));
    expect(report.causes).toContain("abandoned-goal");
    expect(escalationFor(report)).toBe("blocked");
    // ...and the amber floor is still underneath it, because `abandonGoal` writes through
    // `escalateGoal`. If the red cause is ever demoted the row drops to amber, never to calm.
    expect(report.causes).toContain("escalated-goal");
    expect(report.detail).toContain("origin/main");
    // …and it says so ONCE. The two causes always coexist and `abandonGoal` puts the SAME string in
    // `escalationReason` and `abandonedEvidence`, so an unguarded detail printed that ~40-word
    // paragraph twice, in every pill.
    expect(report.detail.match(/origin\/main/g)?.length).toBe(1);
  });

  it("STOPS being red once that same goal is marked met — the latch must not outlive its state", () => {
    // THE PERMANENT-RED CASE, and the reason this cause is gated on `goalState` rather than read off
    // the raw latch. `goalStateOf` returns `met` BEFORE `escalated`, and nothing in `markGoalMet`
    // clears `abandonedAt` — so an abandoned agent whose branch is later landed, and whose goal then
    // self-marks met, used to render RED and ALONE: `escalated-goal` skipped (wrong state), the red
    // cause raised anyway, its amber floor gone, and the detail asserting it "gave up holding work
    // nobody landed" about work that demonstrably landed.
    const abandoned = abandonGoal(lapsed(), EXPIRED_AT, "3 commits, none on origin/main");
    const landedAfterAll = markGoalMet(abandoned, EXPIRED_AT + 60_000);
    const report = stallOf(landedAfterAll);
    expect(goalStateOf(landedAfterAll, EXPIRED_AT + 60_000)).toBe("met");
    expect(report.causes).not.toContain("abandoned-goal");
    expect(escalationFor(report)).toBe(undefined);
    // The evidence itself is KEPT — it is the record of why that escalation happened, and clearing it
    // would lose the history. It simply stops painting the row.
    expect(landedAfterAll.abandonedEvidence).toBe("3 commits, none on origin/main");
  });

  // ⚠️ A THIRD CASE WAS DELETED HERE rather than kept: it asserted that `resetGoalRetries` clears the
  // red cause, which is TRUE but vacuous as a guard for this gate — `resetGoalRetries` destructures
  // `abandonedAt` and `abandonedEvidence` out of the goal, so the latch is simply gone afterwards and
  // the OLD ungated `if (goal?.abandonedAt !== undefined)` would not have pushed the cause either.
  // Reverting the gate left it green. The case above is the one that discriminates, because there the
  // latch SURVIVES while the state moves — which is the only shape that can tell the two apart.
});

describe("a discharge without its shas is refused, not faked", () => {
  // THE DEGRADED PATH, and it is the one most likely to be got wrong: the shas come from a branch
  // reading that does not carry them yet, so this is the state the module actually ships in. It must
  // leave re-arm and abandon fully working while blocking only the decision the shas are FOR.
  it("refuses to discharge when the proving shas are absent", () => {
    const d = decideExpiry(
      ready({ proof: proofLanded({ tipSha: undefined, baseSha: undefined }) }),
    );
    expect(d.action).toBe("none");
    if (d.action !== "none") throw new Error("unreachable");
    expect(d.reason).toBe("proof-unauditable");
  });

  it("does NOT fall through to re-arming a finished agent", () => {
    // Re-arming something landed and clean is how a slot gets held all night: resumed to do nothing,
    // lapsing three more times, then paging a human. The refusal above must be terminal for this
    // sweep, not a step on the way to `rearm`.
    expect(
      decideExpiry(ready({ proof: proofLanded({ tipSha: undefined, baseSha: undefined }) })).action,
    ).not.toBe("rearm");
  });

  // ⚠️ TWO TESTS WERE DELETED HERE, and the deletion is the fix rather than a tidy-up. They asserted
  // that re-arm and abandon "still work without any shas" — but `decideExpiry` never read the shas on
  // either path, so both were byte-identical to cases already covered (the baseline at the top of
  // this file, and the abandon control above). Reverting `tipSha`/`baseSha` to REQUIRED would have
  // left them green, and would not even have failed typecheck: `Partial<ExpiryProof>` widens a
  // required `tipSha: string` to `tipSha?: string | undefined`, so the fixture still compiles. They
  // named a failure they were structurally incapable of detecting.
  //
  // The property they were reaching for is real, and it is guarded where it actually lives now: the
  // optionality is a TYPE fact about the producer, and the one RUNTIME consumer of an absent sha is
  // the abandon evidence sentence — pinned, in both directions, by "names the shas when it has them"
  // above. Prefer a test that can fail over a test that reads reassuringly.
});
