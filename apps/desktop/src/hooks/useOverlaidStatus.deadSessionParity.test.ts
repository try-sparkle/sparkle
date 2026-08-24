// @vitest-environment jsdom
//
// A DIED-BUT-RECOVERING AGENT IS AMBER IN THE BUILD COLUMN TOO — the chain the ROW reads, not just
// the published map every other surface reads.
//
// ══ THE BUG THIS PINS, TRACED END TO END ═══════════════════════════════════════════════════════
// An upstream 529 kills a session. `statusEngine.exit()` writes `errored`. `recordDeath` classifies
// it `transport-transient` and `noteAgentDeath` parks that in `services/deadSessionRegistry`.
//
//   • The DOCK BADGE, the TOPBAR and the CONCIERGE FEED read `composeRollup`, which has applied
//     `withDeadSessionCalm` at its "step 0b" all along ⇒ amber `lapsed`.
//   • The BUILD ROW's `st` comes from `hooks/useOverlaidStatus`, which did NOT ⇒ still `errored`.
//     `errored` is not in `stallEscalation.GRAY_STATUSES`, so `grayFloorFor` → undefined, so
//     `dotFillFor` → undefined, so `StatusDot` paints `AGENT_STATUS.errored.color`. RED.
//
// THE TWO CHAINS DISAGREED ABOUT THE SAME AGENT. One 529 wave painted ~40 rows "needs you" in a
// single night, every one of them asking the founder to fix something only the resurrection sweep
// can fix — the founder's objection, verbatim, is the reason `engine/deadSessionAttention` exists:
// *"there's nothing I can do to resolve this. So why am I seeing this?"*
//
// ══ WHY THIS FILE EXISTS AND `publishedRollupAgreement.test.ts` CANNOT SUBSTITUTE ══════════════
// Both files under `useOverlaidStatus.ts:16-20` and `useAttentionNotifications.ts:383-386` record
// that these two parallel chains diverging is a LIVE failure mode, and that the agreement test is
// STRUCTURALLY BLIND to it: both maps it compares come out of the one `composeRollup`, so it can
// never see this parallel copy. Extending it would have gone green against the very bug. So every
// case below drives `useOverlaidStatus` INDEPENDENTLY, and the headline case reads BOTH chains and
// asserts they reach the same answer.
//
// ══ ON NON-VACUITY ════════════════════════════════════════════════════════════════════════════
// The repo's standing finding is that a test proving only that a demotion FIRES is the half that
// keeps biting (a green suite over a rule that de-reds everything looks identical). So each
// demotion here is paired with the opposite direction: `blocked-on-human` / `human-stopped` stay
// red, an agent with NO death record is left exactly as it was, a `working` agent is never demoted,
// and the placement case has a paired fixture where the head DOES redden.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { AGENT_STATUS } from "@sparkle/ui/tokens";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useOverlaidStatus } from "./useOverlaidStatus";
import { publishedStatusFor } from "../useAttentionNotifications";
import { bandOfStatus } from "../engine/buildSections";
import { isResurrectable, type DeathCause } from "../engine/deathTypes";
import { RECOVERING_DEAD_STATUS } from "../engine/deadSessionAttention";
import {
  noteAgentDeath,
  _resetDeadSessionRegistryForTests,
} from "../services/deadSessionRegistry";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import type { AgentTab, AgentTabStatus } from "../types";

/** A briefed, long-lived agent. Both halves matter: without `lastPrompt` and an old `createdAt`,
 *  step (0) `calmNewAgent` grays the row to `new` REGARDLESS of anything this file asserts, and the
 *  dead-session step would never be the thing under test — green for the wrong reason. */
function mk(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "briefed",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    createdAt: Date.now() - 60 * 60_000,
    ...over,
  } as unknown as AgentTab;
}

/** A worker with a real brief under `head`. `task` is route 3 of `isBriefless` — without it the
 *  worker is calmed to `new` before it can ever reach the bubbles the placement case is about. */
function worker(id: string): AgentTab {
  return mk(id, { kind: "worker", parentId: "head", task: "do the thing", worktreePath: "/tmp/wt" });
}

function seed(status: Record<string, AgentTabStatus>, over: Record<string, unknown> = {}) {
  useRuntimeStore.setState({
    status,
    openAgentIds: [],
    lastObserved: {},
    observedAttention: {},
    branchStatus: {},
    workflowStage: {},
    ...over,
  } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
}

/** How many rungs `useOverlaidStatus`'s wake-up ladder has. Restated rather than imported because
 *  the ladder is a private detail of that file; the test only needs an ORDER OF MAGNITUDE to tell a
 *  bounded ladder from an interval, so a drift here weakens the bound slightly and can never make
 *  the assertion wrong in the direction that matters. */
const DEAD_SESSION_WAKE_RUNGS = 3;

const NO_PANES = new Set<string>();
const NO_STAGE = () => undefined as never;

/** What the BUILD ROW paints — the chain under test, driven through the real store. */
function buildChain(
  agents: readonly AgentTab[],
  id: string,
  deathCauseOf?: (id: string) => DeathCause | undefined,
) {
  const { result } = renderHook(() =>
    deathCauseOf === undefined
      ? // THE DEFAULT SEAM, EXERCISED. bead sparkle-lgbwf: a seam every test overrides leaves the
        // line supplying the real value covered by nothing — delete `= deathCauseForAgent` and a
        // suite that always injects stays green while the row goes red again in production.
        useOverlaidStatus(agents)
      : useOverlaidStatus(agents, () => false, deathCauseOf),
  );
  return result.current.status[id];
}

/** What every OTHER surface reads — the published map out of `composeRollup`. */
function publishedChain(agents: readonly AgentTab[], id: string) {
  return publishedStatusFor(agents, useRuntimeStore.getState().status, NO_PANES, {}, NO_STAGE)[id];
}

/**
 * EVERY `DeathCause`, as an exhaustive record rather than a hand-kept array.
 *
 * Typed `Record<DeathCause, true>` on purpose: adding a cause to `engine/deathTypes` without adding
 * it here is a COMPILE error, so the table cannot silently stop covering the vocabulary it claims
 * to. The expectation below is derived from `isResurrectable`, never hand-listed, so the demotion
 * rule and this test cannot drift apart either.
 */
const ALL_CAUSES: Record<DeathCause, true> = {
  "transport-transient": true,
  "wall-session": true,
  "wall-spend": true,
  "clean-goal-met": true,
  "blocked-on-human": true,
  "app-restart": true,
  "process-gone": true,
  "human-stopped": true,
  unknown: true,
};
const CAUSES = Object.keys(ALL_CAUSES) as DeathCause[];

beforeEach(() => _resetDeadSessionRegistryForTests());
afterEach(() => {
  cleanup();
  _resetDeadSessionRegistryForTests();
  useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
});

describe("the Build column and the published map agree about a died-but-recovering agent", () => {
  it("a 529-killed `errored` agent reads `lapsed` on the chain the ROW paints from", () => {
    // The exact production shape: `transport-transient` is what `causeOf("api-banner")` returns for
    // an upstream 529, and `errored` is what `statusEngine.exit()` writes on the way out.
    const agents = [mk("a")];
    seed({ a: "errored" });
    noteAgentDeath("a", "transport-transient");

    const st = buildChain(agents, "a");

    // THE SIDE EFFECT, not the precondition — the value, its band, and the colour actually painted.
    expect(st).toBe(RECOVERING_DEAD_STATUS);
    expect(st).not.toBe("errored");
    expect(bandOfStatus(st!)).not.toBe("needs_you");
    expect(AGENT_STATUS[st!].color).not.toBe(AGENT_STATUS.errored.color);
  });

  it("…and the two chains reach the SAME answer, which no agreement test can see", () => {
    // THE HEADLINE. `publishedRollupAgreement.test.ts` compares two maps that both come out of
    // `composeRollup`; this compares `useOverlaidStatus` against `composeRollup`, which is where the
    // divergence actually lived. Neither side is injected here, so both drive the real registry.
    const agents = [mk("a")];
    seed({ a: "errored" });
    noteAgentDeath("a", "transport-transient");

    const viaRow = buildChain(agents, "a");
    const viaPublished = publishedChain(agents, "a");

    expect(viaRow, "the Build chain diverged from the published chain").toBe(viaPublished);
    // …and the comparison is not "red === red": the published side genuinely demoted.
    expect(viaPublished).toBe(RECOVERING_DEAD_STATUS);
  });
});

describe("every DeathCause, with the expectation derived from isResurrectable", () => {
  for (const cause of CAUSES) {
    const recovers = isResurrectable(cause);
    it(`${cause} → ${recovers ? "lapsed (amber)" : "errored (still red)"}`, () => {
      const agents = [mk("a")];
      seed({ a: "errored" });

      const st = buildChain(agents, "a", () => cause);

      expect(st).toBe(recovers ? RECOVERING_DEAD_STATUS : "errored");
      // Stated as the BAND as well, because the band is what the digest counts and the chip narrows.
      expect(bandOfStatus(st!)).toBe(recovers ? "done" : "needs_you");
    });
  }

  // ── THE OTHER DIRECTION, NAMED. A table that only ever demotes would pass against a rule that
  // demoted EVERYTHING, and these two causes are the ones the taxonomy is built to protect:
  // `blocked-on-human` is a genuine ask, `human-stopped` is a decision a person already made.
  // Asserted by name and not merely swept up by the loop, so deleting them from the table cannot
  // quietly delete the guarantee.
  it("`blocked-on-human` STAYS RED — a person, not a process, is the thing it waits on", () => {
    const agents = [mk("a")];
    seed({ a: "errored" });
    expect(buildChain(agents, "a", () => "blocked-on-human")).toBe("errored");
    expect(bandOfStatus(buildChain(agents, "a", () => "blocked-on-human")!)).toBe("needs_you");
  });

  it("`human-stopped` STAYS RED — the human already decided; nothing is coming to restart it", () => {
    const agents = [mk("a")];
    seed({ a: "errored" });
    expect(buildChain(agents, "a", () => "human-stopped")).toBe("errored");
  });
});

describe("an absence of evidence demotes nothing", () => {
  it("leaves the row EXACTLY as it was when `deathCauseOf` returns undefined", () => {
    // `undefined` is "this window has no reading", never "the agent is alive" — manufacturing an
    // amber row from an absence would calm a genuinely red agent this window simply has no ledger
    // entry for. Evidence, not inference: assert the value, not that "nothing crashed".
    const agents = [mk("a")];
    seed({ a: "errored" });

    const st = buildChain(agents, "a", () => undefined);

    expect(st).toBe("errored");
    expect(bandOfStatus(st!)).toBe("needs_you");
    expect(AGENT_STATUS[st!].color).toBe(AGENT_STATUS.errored.color);
  });

  it("the same holds through the DEFAULT seam with an empty registry", () => {
    const agents = [mk("a")];
    seed({ a: "errored" });
    // Nothing noted. The real `deathCauseForAgent` returns undefined and nothing is demoted.
    expect(buildChain(agents, "a")).toBe("errored");
  });
});

describe("a live PTY outranks a past-tense registry entry", () => {
  it("never demotes a `working` agent, whatever the death record says", () => {
    // `deadSessionAttention.ts:86` refuses this, and the refusal is the one error that module must
    // not make. Pinned HERE because the wiring is what could lose it: an overlay applied at a
    // different point, or against a different map, would reintroduce exactly this.
    const agents = [mk("a")];
    seed({ a: "working" });
    noteAgentDeath("a", "transport-transient");

    const st = buildChain(agents, "a");

    expect(st).toBe("working");
    expect(bandOfStatus(st!)).toBe("running");
  });
});

describe("the step runs BEFORE the worker bubbles — the placement, not just the rule", () => {
  it("a dead worker's false red never reaches its orchestrator", () => {
    // `deadSessionAttention`'s header: *"a bubbled red is indistinguishable from a parent's own once
    // it lands, so a dead worker's false red has to be corrected BEFORE it can spread"*. Move the
    // step after `withRedWorkerAttention` and the WORKER goes amber while the HEAD stays red — the
    // founder's complaint one level up, and a case only this assertion can see.
    const agents = [mk("head"), worker("w")];
    seed({ head: "idle", w: "errored" });
    noteAgentDeath("w", "transport-transient");

    const { result } = renderHook(() => useOverlaidStatus(agents));

    expect(result.current.status["w"]).toBe(RECOVERING_DEAD_STATUS);
    expect(bandOfStatus(result.current.status["head"]!)).not.toBe("needs_you");
  });

  it("…but a worker dead on a NON-recoverable cause still reddens its head — the paired case", () => {
    // Without this, "the head is calm" would also pass against a chain that had lost the red bubble
    // entirely, or against one that demoted every dead worker regardless of cause.
    const agents = [mk("head"), worker("w")];
    seed({ head: "idle", w: "errored" });
    noteAgentDeath("w", "blocked-on-human");

    const { result } = renderHook(() => useOverlaidStatus(agents));

    expect(result.current.status["w"]).toBe("errored");
    expect(bandOfStatus(result.current.status["head"]!)).toBe("needs_you");
  });
});

describe("the wake-up ladder — a registry write with no store write behind it", () => {
  // WHY THIS IS NOT OPTIONAL COVERAGE. `statusEngine.exit()` writes the terminal status FIRST and
  // only then calls `reportDeath`, which awaits one `agent_life_close` IPC before `noteAgentDeath`
  // lands. So the store write that would have recomputed the memo has already happened by the time
  // the cause exists — and after a fleet-wide 529 there is no surviving agent left to write another
  // one. Without a wake-up the row sits RED forever in exactly the scenario the amber tier is for.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-reads the registry after a death recorded with no accompanying status write", () => {
    const agents = [mk("a")];
    seed({ a: "errored" });

    const { result } = renderHook(() => useOverlaidStatus(agents));
    // Before: nothing observed, so the row is honestly red.
    expect(result.current.status["a"]).toBe("errored");

    // The death lands out-of-band, exactly as `recordDeath` does it: no store write, no re-render.
    noteAgentDeath("a", "transport-transient");
    expect(result.current.status["a"], "a bare registry write must not repaint by itself").toBe(
      "errored",
    );

    act(() => void vi.advanceTimersByTime(1_000));

    expect(result.current.status["a"]).toBe(RECOVERING_DEAD_STATUS);
  });

  it("disarms: a quiet app stops re-rendering once the ladder is spent", () => {
    // The ladder is FINITE by design — an unbounded interval here would be a permanent re-render
    // heartbeat under the whole sidebar, paid forever by every user, to observe an event that
    // happens seconds after a status change or not at all. Asserting it actually STOPS is what
    // keeps that true, and the honest measure is the RE-RENDER (what a poller would cost), not
    // `vi.getTimerCount()` — the environment holds unrelated timers this hook did not arm, so that
    // reading would be about the wrong thing and go red for a reason unconnected to the ladder.
    const agents = [mk("a")];
    seed({ a: "idle" });

    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useOverlaidStatus(agents);
    });

    // ONE `act` PER STEP, and that detail is load-bearing rather than stylistic. `act` defers the
    // React flush to the END of its callback, so a single `advanceTimersByTime(60_000)` runs every
    // rung's timer while the component has not re-rendered even once — the effect never re-runs, so
    // it never arms the NEXT rung, and the ladder appears to stop after one step. That is an
    // artifact of the harness, not of the code: in the app each timer callback flushes React
    // synchronously. Stepping the clock in separate `act`s reproduces the real interleaving, and
    // without it this test would "pass" against a ladder that had not actually finished.
    const step = () => act(() => void vi.advanceTimersByTime(30_000));
    for (let i = 0; i < 10; i += 1) step();
    const afterLadder = renders;
    for (let i = 0; i < 10; i += 1) step();

    // Five more minutes of a completely idle app, flushed ten times, buy zero additional renders.
    expect(renders).toBe(afterLadder);
    // …and the ladder was BOUNDED on the way there, not merely finite in the limit: a handful of
    // wake-ups, not one per tick. Stated as an upper bound so the rung count can be retuned without
    // rewriting the test, but tight enough that an interval could never satisfy it.
    expect(afterLadder).toBeLessThanOrEqual(2 * (DEAD_SESSION_WAKE_RUNGS + 1));
  });
});
