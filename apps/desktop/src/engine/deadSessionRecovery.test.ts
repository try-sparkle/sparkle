// A DEAD SESSION RECOVERS ITSELF — IT DOES NOT PAINT A FALSE RED AT THE FOUNDER.
//
// The founder's objection, verbatim, on a row of workers dead for 45+ minutes offering him nothing
// but `Resume this session with: claude --resume <uuid>`:
//
//     "there's nothing I can do to resolve this. So why am I seeing this?"
//
// He cannot type into a terminal that is not running. This file pins the whole fix, and the two
// halves are asserted TOGETHER on purpose — either one alone is a worse bug than the thing being
// fixed. Quiet without recovery is a silently abandoned agent; recovery without quiet leaves the
// false red that started this.
//
// ── THE COUPLING THIS UNDOES ──────────────────────────────────────────────────────────────────
// `agent_life::mark_stopped_at` (the ledger half of "the user clicked stop") wrote
// `{cause: unknown, evidence: pty-exit}`. An ordinary CRASH lands on the same pair — `deathRecord`
// Gate 5 maps a bare `pty-exit` there — so `isResurrectable("unknown")` HAD to be false, or the
// fleet would restart agents their owner had just killed. One overloaded cause therefore made every
// unexplained death permanently unrecoverable: 25 of 76 records on the founder's v0.95.0 install.
//
// The stop now has its own cause and its own evidence, so `unknown` means what it says. Test 3
// below is the safety property that PAYS for that; without it this change is a regression.
import { beforeEach, describe, expect, it } from "vitest";

import { StatusEngine } from "./statusEngine";
import { needsAttention } from "./attention";
import { bandOfStatus } from "./buildSections";
import { isRedStatus } from "../services/windowStatus";
import { causeOf, isResurrectable, type DeathCause, type DeathEvidence } from "./deathTypes";
import { classifyDeath, type DeathObservation } from "./deathRecord";
import {
  MAX_RESURRECTS_PER_AGENT_PER_DAY,
  RESURRECT_LADDER_CEILING_MS,
  RESURRECT_LADDER_MS,
  armsOnSlowestRung,
  decideResurrection,
  nextRungDueAt,
  type ResurrectionInput,
} from "./resurrection";
import { RECOVERING_DEAD_STATUS, withDeadSessionCalm } from "./deadSessionAttention";
import { publishedStatusFor } from "../useAttentionNotifications";
import {
  _resetDeadSessionRegistryForTests,
  deathCauseForAgent,
  forgetAgentDeath,
  noteAgentDeath,
} from "../services/deadSessionRegistry";
import type { AgentTab, AgentTabStatus } from "../types";

const T0 = 1_754_534_400_000;
/** The FAST first rung — 60s. Pinned by value, this repo's discipline, so an upstream edit to the
 *  ladder is noticed here rather than silently inherited. */
const FAST_RUNG = RESURRECT_LADDER_MS[0]!;

function mk(id: string, kind: AgentTab["kind"], parentId: string | null): AgentTab {
  return {
    id, name: id, kind, parentId, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "briefed",
    // A real `PromptHistoryEntry`, not a bare string. The agent must read as BRIEFED here — a
    // briefless one is overlaid `new` by `withNewAgentCalm` before this suite's overlay ever runs,
    // which would make every assertion below pass for the wrong reason.
    promptHistory: [{ id: "p1", text: "briefed", at: T0 }],
    namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

const NO_STAGE = () => undefined as never;
const HEAD_AND_WORKER = [mk("head", "build", null), mk("w1", "worker", "head")];

/** The REAL published chain, with a death reading injected at the outermost boundary — the same
 *  seam production fills from `services/deadSessionRegistry`. */
function published(
  status: Record<string, AgentTabStatus>,
  deaths: Record<string, DeathCause> = {},
): Record<string, AgentTabStatus> {
  return publishedStatusFor(
    HEAD_AND_WORKER,
    status,
    new Set(["head", "w1"]),
    {},
    NO_STAGE,
    undefined,
    undefined,
    {},
    () => undefined,
    () => undefined,
    (id) => deaths[id],
  );
}

/** A dead agent's resurrection input. `processAlive: false` is required by the gate and is the fact
 *  that makes this module's population disjoint from `apiRecovery`'s. */
function dead(over: Partial<ResurrectionInput> = {}): ResurrectionInput {
  return {
    cause: "unknown",
    processAlive: false,
    notBeforeMs: undefined,
    attemptsThisEpisode: 0,
    lastAttemptAt: undefined,
    diedAt: T0,
    recentAttemptsAt: [],
    now: T0,
    ...over,
  };
}

beforeEach(() => _resetDeadSessionRegistryForTests());

// ══ THE VOCABULARY IS ONE SET ACROSS THE WIRE ════════════════════════════════════════════════════
//
// The Rust half asserts the same thing from the other side (`agent_life::
// the_serde_strings_match_deathtypes_ts` parses THIS file's unions with `include_str!` and compares
// them as sets against serde's vocabulary). This block is the TS-side half: it pins that the two new
// members exist under the exact wire strings serde emits, and that the total function over the
// evidence union has an arm for the new one — a `causeOf` that fell through would be a compile
// error, but a `causeOf` that returned the WRONG cause would not.
describe("the new vocabulary, and the serde strings it crosses the wire as", () => {
  it("names the deliberate stop and its evidence with kebab-case wire strings", () => {
    // Written as literals, not derived, because the STRING is the contract: `#[serde(rename_all =
    // "kebab-case")]` turns `HumanStopped` into exactly this, and a rename on either side makes one
    // end read the other's records as an unknown variant.
    const cause: DeathCause = "human-stopped";
    const evidence: DeathEvidence = "user-stop";
    expect(causeOf(evidence)).toBe(cause);
  });

  it("keeps `pty-exit` meaning `unknown` — the stop no longer borrows it", () => {
    // The other half of the split. If `pty-exit` had been re-pointed at `human-stopped`, every
    // ordinary crash would become unrecoverable again with nothing to show for it.
    expect(causeOf("pty-exit")).toBe("unknown");
    expect(causeOf("session-end-hook")).toBe("unknown");
  });
});

// ══ 1. AN EXITED SESSION IS NOT FOUNDER-FACING ═══════════════════════════════════════════════════
//
// Three predicates, asserted separately because they are three different questions in this codebase
// and they have drifted before: `isRedStatus` is the COLOUR, `needsAttention` is the BADGE, and
// `bandOfStatus` is the BAND the concierge digest counts and the red filter chip narrows.
describe("1. a dead session with a recoverable cause is amber — not red, not counted, not notified", () => {
  it("de-reds the `errored` that statusEngine ACTUALLY writes on exit", () => {
    // THE REAL PRODUCER, not a hand-built status. `statusEngine.exit()` settles to `errored` when a
    // recent error was seen, and that `errored` bands `needs_you` — which is the exact red the
    // founder was looking at. Driving the engine is what makes this test about the app rather than
    // about a string literal.
    const seen: AgentTabStatus[] = [];
    const engine = new StatusEngine({ agentId: "w1", onStatus: (s) => seen.push(s) });
    engine.ingest("Error: cannot find module 'foo'\n");
    engine.exit();
    const onExit = seen[seen.length - 1]!;

    // THE CONTROL. Without this the assertions below could pass against a status that was never red.
    expect(onExit).toBe("errored");
    expect(isRedStatus(onExit)).toBe(true);
    expect(needsAttention(onExit)).toBe(true);
    expect(bandOfStatus(onExit)).toBe("needs_you");

    const out = published({ head: "idle", w1: onExit }, { w1: "unknown" });

    expect(out.w1).toBe(RECOVERING_DEAD_STATUS);
    expect(needsAttention(out.w1!)).toBe(false);
    expect(bandOfStatus(out.w1!)).not.toBe("needs_you");
    expect(isRedStatus(out.w1!)).toBe(false);
  });

  it("…and the orchestrator does not inherit the dead worker's red either", () => {
    // The de-redding runs on the RAW map, before `withRedWorkerAttention` bubbles. Move it after the
    // bubbles and this goes red while the leg above stays green — the head would be red for a worker
    // the app is about to restart, which is the founder's complaint one level up.
    const out = published({ head: "idle", w1: "errored" }, { w1: "unknown" });
    expect(isRedStatus(out.head!)).toBe(false);
    expect(bandOfStatus(out.head!)).not.toBe("needs_you");
  });

  it("KEEPS the red when there is NO death reading — the paired negative", () => {
    // Without this, "the row went calm" would also pass for a chain that had stopped painting red at
    // all. An absent reading means "we did not look", never "it is fine", so it must demote nothing.
    const out = published({ head: "idle", w1: "errored" });
    expect(out.w1).toBe("errored");
    expect(bandOfStatus(out.w1!)).toBe("needs_you");
    expect(bandOfStatus(out.head!)).toBe("needs_you");
  });

  it("is AMBER and not calm gray — a de-redded row must never go silent", () => {
    // `redAttentionTaxonomy` makes this argument about its own narrowing: the amber IS the
    // justification for removing the red. A row that fell through to `idle` would be an agent
    // nobody ever comes back to, which is a worse bug than the false alarm.
    expect(RECOVERING_DEAD_STATUS).toBe("lapsed");
    expect(published({ w1: "errored" }, { w1: "unknown" }).w1).not.toBe("idle");
  });

  it("leaves a WORKING agent alone — present-tense liveness beats a stale record", () => {
    // The one error this module must not make. The registry is cleared on every pane mount, so this
    // should be unreachable; the guard is cheaper than the argument that it cannot happen.
    expect(withDeadSessionCalm(HEAD_AND_WORKER, { w1: "working" }, () => "unknown").w1).toBe(
      "working",
    );
  });

  it("returns the SAME map reference when nothing is calmed, and never mutates the input", () => {
    const status: Record<string, AgentTabStatus> = { w1: "errored" };
    expect(withDeadSessionCalm(HEAD_AND_WORKER, status, () => undefined)).toBe(status);
    withDeadSessionCalm(HEAD_AND_WORKER, status, () => "unknown");
    expect(status.w1).toBe("errored");
  });
});

// ══ 2. …AND IT IS ACTUALLY HANDLED AUTOMATICALLY ═════════════════════════════════════════════════
//
// The half that stops the block above from being the WORSE bug. A row that merely went quiet is an
// agent nobody is coming back to; these assertions prove the recovery fires.
describe("2. the same agent is genuinely respawned once its rung is due", () => {
  it("respawns an unexplained death at the conservative rung", () => {
    expect(decideResurrection(dead({ now: T0 + RESURRECT_LADDER_CEILING_MS }))).toEqual({
      action: "respawn",
      attempt: 1,
    });
  });

  it("and the SAME reading drives both halves — amber row, live recovery", () => {
    // The two are asserted over ONE cause value rather than two independently chosen ones, because
    // the bug this file guards against is precisely a row that is quiet for one reason while nothing
    // is acting for another.
    const cause: DeathCause = "unknown";
    expect(published({ w1: "errored" }, { w1: cause }).w1).toBe(RECOVERING_DEAD_STATUS);
    expect(
      decideResurrection(dead({ cause, now: T0 + RESURRECT_LADDER_CEILING_MS })).action,
    ).toBe("respawn");
  });

  it("does NOT take the fast rung — `unknown` recovers at the most conservative pace", () => {
    // The requirement `deathTypes` states in words: an unexplained death "can move to the most
    // conservative pace rather than to a refusal". At the fast 60s rung it is still waiting.
    expect(decideResurrection(dead({ now: T0 + FAST_RUNG }))).toEqual({
      action: "none",
      reason: "waiting-for-next-rung",
    });
    expect(armsOnSlowestRung("unknown")).toBe(true);
    expect(nextRungDueAt({ cause: "unknown", attemptsThisEpisode: 0, lastAttemptAt: undefined, diedAt: T0 })).toBe(
      T0 + RESURRECT_LADDER_CEILING_MS,
    );
  });

  it("…while a KNOWN, retryable fault still takes the fast rung — the paired control", () => {
    // Without this the leg above would also pass for a ladder that had simply been slowed down for
    // everyone, which would cost every transport death 29 extra minutes of downtime.
    expect(armsOnSlowestRung("transport-transient")).toBe(false);
    expect(decideResurrection(dead({ cause: "transport-transient", now: T0 + FAST_RUNG }))).toEqual({
      action: "respawn",
      attempt: 1,
    });
    expect(FAST_RUNG).toBeLessThan(RESURRECT_LADDER_CEILING_MS);
  });

  it("still refuses a LIVE process — the mirror gate with apiRecovery is untouched", () => {
    // `errored + alive` is apiRecovery's population and `errored + dead` is this one's. Flipping
    // `unknown` must not let this module reach into the other's, which would orphan a live child.
    expect(decideResurrection(dead({ processAlive: undefined, now: T0 + RESURRECT_LADDER_CEILING_MS })).action).toBe(
      "none",
    );
    expect(decideResurrection(dead({ processAlive: true, now: T0 + RESURRECT_LADDER_CEILING_MS }))).toEqual({
      action: "none",
      reason: "already-live",
    });
  });

  it("classifies a bare PTY exit as the cause that now recovers — end to end", () => {
    // The producer, so the chain is proved rather than assumed: `classifyDeath` is what turns a real
    // observed exit into the record `isResurrectable` then reads.
    const observed: DeathObservation = {
      quota: undefined,
      lastFailure: undefined,
      recentFailure: undefined,
      liveness: "local",
      goal: undefined,
      blockingTool: undefined,
      terminator: "pty-exit",
      now: T0,
    };
    const verdict = classifyDeath(observed);
    expect(verdict).toEqual({ cause: "unknown", evidence: "pty-exit" });
    expect(isResurrectable(verdict.cause)).toBe(true);
  });
});

// ══ 3. A DELIBERATE HUMAN STOP IS STILL NEVER RESURRECTED ════════════════════════════════════════
//
// THE SAFETY PROPERTY THAT PAYS FOR TEST 2. Without it, flipping `unknown` is a regression: the
// fleet would restart agents their owner had just killed, which this taxonomy has always ranked as
// strictly worse than a missed recovery.
describe("3. a stop the user asked for is never undone", () => {
  it("is not resurrectable, and the gate refuses it BY NAME", () => {
    expect(isResurrectable("human-stopped")).toBe(false);
    // By name rather than through the exhaustive backstop: a stop routed into `unclassified-death`
    // would be correct today and unreadable in a log, and it would stop discriminating the moment
    // another cause joined that arm.
    expect(
      decideResurrection(dead({ cause: "human-stopped", now: T0 + RESURRECT_LADDER_CEILING_MS })),
    ).toEqual({ action: "none", reason: "human-stopped" });
  });

  it("refuses it however long it has waited and however few attempts it has spent", () => {
    // Terminal classifications are checked FIRST, before rungs and caps, so a stop can never
    // resurface as `waiting-for-next-rung` and then become due.
    for (const now of [T0, T0 + FAST_RUNG, T0 + RESURRECT_LADDER_CEILING_MS * 100]) {
      expect(decideResurrection(dead({ cause: "human-stopped", now })).action).toBe("none");
    }
  });

  it("and its row is NOT painted as recovering — nothing is coming for it", () => {
    // The overlay's gate is `isResurrectable`, so this follows from the line above rather than from
    // a second list that could drift. Asserted anyway: the claim "amber means something is acting"
    // is only true if a cause nothing acts on cannot wear it.
    expect(published({ w1: "errored" }, { w1: "human-stopped" }).w1).toBe("errored");
  });

  it("…and neither is a FINISHED agent, for the opposite reason", () => {
    expect(isResurrectable("clean-goal-met")).toBe(false);
    expect(decideResurrection(dead({ cause: "clean-goal-met" }))).toEqual({
      action: "none",
      reason: "clean-goal-met",
    });
  });
});

// ══ 4. `blocked-on-human` IS STILL RED ═══════════════════════════════════════════════════════════
//
// The de-redding must not reach a genuine ask. `RED = THE FOUNDER IS THE ONLY ACTOR WHO CAN UNBLOCK
// THIS` (engine/redAttentionTaxonomy.test.ts) — and here he is.
describe("4. a genuine ask keeps its red", () => {
  it("does not calm a `waiting` row whose death was blocked-on-human", () => {
    const out = published({ head: "idle", w1: "waiting" }, { w1: "blocked-on-human" });
    expect(out.w1).toBe("waiting");
    expect(isRedStatus(out.w1!)).toBe(true);
    expect(needsAttention(out.w1!)).toBe(true);
    expect(bandOfStatus(out.w1!)).toBe("needs_you");
  });

  it("…and it still bubbles to the orchestrator, so the ask is not hidden one level up", () => {
    expect(bandOfStatus(published({ head: "idle", w1: "waiting" }, { w1: "blocked-on-human" }).head!)).toBe(
      "needs_you",
    );
  });

  it("is unreachable by construction, not by a second list", () => {
    // The overlay imports `isResurrectable` rather than restating which causes calm, so this cause
    // cannot be admitted by an edit that forgets to update a duplicate.
    expect(isResurrectable("blocked-on-human")).toBe(false);
    expect(decideResurrection(dead({ cause: "blocked-on-human" }))).toEqual({
      action: "none",
      reason: "blocked-on-human",
    });
  });
});

// ══ THE REGISTRY'S LIFECYCLE ═════════════════════════════════════════════════════════════════════
//
// The window-local half is what makes any of the above reachable from a synchronous render, so its
// two edges are pinned. The one direction that must never fail is claiming a running agent is dead.
describe("the window-local death registry mirrors the ledger's own two edges", () => {
  it("remembers a death and forgets it on the next spawn", () => {
    expect(deathCauseForAgent("w1")).toBeUndefined();
    noteAgentDeath("w1", "unknown");
    expect(deathCauseForAgent("w1")).toBe("unknown");
    forgetAgentDeath("w1");
    expect(deathCauseForAgent("w1")).toBeUndefined();
  });

  it("so a respawned agent stops rendering as recovering", () => {
    noteAgentDeath("w1", "unknown");
    expect(published({ w1: "idle" }, { w1: deathCauseForAgent("w1")! }).w1).toBe(
      RECOVERING_DEAD_STATUS,
    );
    forgetAgentDeath("w1");
    expect(published({ w1: "idle" }, {}).w1).toBe("idle");
  });
});

// ══ THE DAILY CAP IS STILL THE ONLY TERMINAL BOUND ═══════════════════════════════════════════════
describe("the exhausted budget", () => {
  it("refuses with `daily-cap-spent`, which is what routes the agent to the concierge", () => {
    const spent = Array.from({ length: MAX_RESURRECTS_PER_AGENT_PER_DAY }, (_, i) => T0 + i);
    expect(
      decideResurrection(
        dead({ recentAttemptsAt: spent, now: T0 + RESURRECT_LADDER_CEILING_MS }),
      ),
    ).toEqual({ action: "none", reason: "daily-cap-spent" });
  });
});
