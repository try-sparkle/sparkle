// THE WIRING TEST for the mount-independent attention verdict — and it drives the DEFAULT seam.
//
// `engine/observedAttention` is unit-tested in isolation, and that proves the RULE. It cannot prove
// the rule is REACHED: `composeRollup` takes `observed` as an injected parameter defaulting to the
// live `runtimeStore.observedAttention`, and a suite that always passes its own map would leave the
// one line that supplies the real value covered by nothing — delete it and every other test stays
// green while the founder's rows go back to being green until you click them. That is a defect
// shape this repo has recorded four times (bead sparkle-lgbwf), so this file does the opposite: it
// writes through the REAL store and calls `publishedStatusFor` / `rollupViewFor` with no `observed`
// argument at all, exactly as production does.
//
// It also pins the OTHER standing risk: the sidebar chain and the published chain are parallel
// copies, and an overlay wired into only one makes the Build column band differently from the dock
// badge and the concierge feed with nothing failing. Every case below asserts BOTH.
import { afterEach, describe, expect, it } from "vitest";
import { publishedStatusFor, rollupViewFor } from "./useAttentionNotifications";
import { useRuntimeStore } from "./stores/runtimeStore";
import { bandOfStatus } from "./engine/buildSections";
import type { ObservedReading } from "./engine/observedAttention";
import type { AgentTab, AgentTabStatus } from "./types";

function mk(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "briefed",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

const reading = (
  verdict: ObservedReading["verdict"],
  alternate = false,
): ObservedReading => ({ verdict, alternate, atMs: 1_787_251_205_196 });

const NO_STAGE = () => undefined as never;

/** NOBODY HAS OPENED THIS AGENT — an EMPTY open set is the whole premise of the feature, so it is
 *  spelled out rather than defaulted. With the pane mounted there is a live writer and the overlay
 *  correctly stands down. */
const NO_PANES = new Set<string>();

const published = (agents: AgentTab[], status: Record<string, AgentTabStatus>) =>
  publishedStatusFor(agents, status, NO_PANES, {}, NO_STAGE);

const own = (agents: AgentTab[], status: Record<string, AgentTabStatus>) =>
  rollupViewFor(agents, status, NO_PANES, {}, NO_STAGE).own;

/** Write a verdict through the REAL store, the way the Tauri listener does. */
function observe(agentId: string, r: ObservedReading) {
  useRuntimeStore.getState().setObservedAttention(agentId, r);
}

afterEach(() => useRuntimeStore.getState().seedObservedAttention({}));

describe("an agent blocked on a human goes RED without anyone opening its pane", () => {
  it("reaches the needs-you band through the REAL store, with no `observed` argument passed", () => {
    const agents = [mk("a")];
    observe("a", reading("awaiting"));

    // The latched green the founder saw: a hook stream that died mid-turn, no pane to correct it.
    const out = published(agents, { a: "working" });

    expect(out.a).toBe("waiting");
    expect(bandOfStatus(out.a!)).toBe("needs_you");
    // …and the Build column's own map agrees, so the two chains cannot band differently.
    expect(own(agents, { a: "working" }).a).toBe("waiting");
  });

  it("THE PAIRED CASE — the same agent with NO verdict recorded keeps its green", () => {
    // Without this, "the row is red" would also pass for a change that reddened every agent in the
    // fleet, which is the opposite bug and the more expensive one. It is also what proves the red
    // above came from the verdict rather than from anything else in the chain.
    const agents = [mk("a")];
    const out = published(agents, { a: "working" });
    expect(out.a).toBe("working");
    expect(bandOfStatus(out.a!)).not.toBe("needs_you");
  });

  it("stands down when a pane IS mounted — that writer is live and richer", () => {
    const agents = [mk("a")];
    observe("a", reading("awaiting"));
    const out = publishedStatusFor(agents, { a: "working" }, new Set(["a"]), {}, NO_STAGE);
    expect(out.a).toBe("working");
  });

  it("survives step (0)'s de-escalation of a BRIEFLESS agent", () => {
    // The ordering claim the wiring comment makes, asserted rather than argued: `calmNewAgent`
    // de-escalates a never-briefed agent to `new` (gray), but exempts `waiting`/`approval` because
    // "a real ask goes red immediately, at any age, briefed or not". A positively-read on-screen
    // prompt is exactly that, and must outrank the stall-timer inference.
    const briefless = {
      ...mk("a"), lastPrompt: "", promptHistory: [], createdAt: Date.now(),
    } as AgentTab;
    observe("a", reading("awaiting"));
    const out = published([briefless], { a: "blocked" });
    expect(out.a).toBe("waiting");

    // Paired: the same briefless agent with NO verdict is still calmed to `new`, so the exemption
    // above is doing the work rather than step (0) having been broken.
    useRuntimeStore.getState().seedObservedAttention({});
    expect(published([briefless], { a: "blocked" }).a).toBe("new");
  });
});

describe("an unreadable screen makes no claim at all", () => {
  it("does not relabel a live agent's green as a finished session, on EITHER chain", () => {
    const agents = [mk("a")];
    observe("a", reading("unreadable"));
    expect(published(agents, { a: "working" }).a).toBe("working");
    expect(own(agents, { a: "working" }).a).toBe("working");
  });

  it("never raises an alarm — a calm row stays exactly as it was", () => {
    const agents = [mk("a")];
    observe("a", reading("unreadable"));
    const out = published(agents, { a: "idle" });
    expect(bandOfStatus(out.a!)).not.toBe("needs_you");
    expect(out.a).toBe("idle");
  });

  it("never lowers a red — an unread screen is not evidence the question was answered", () => {
    const agents = [mk("a")];
    observe("a", reading("unreadable"));
    const out = published(agents, { a: "waiting" });
    expect(out.a).toBe("waiting");
    expect(bandOfStatus(out.a!)).toBe("needs_you");
  });
});

describe("`calm` does not retract anything", () => {
  it("leaves a red row red — retraction belongs to movementRetraction", () => {
    const agents = [mk("a")];
    observe("a", reading("calm"));
    expect(published(agents, { a: "waiting" }).a).toBe("waiting");
  });
});

describe("THE CHAIN-POSITION DIVERGENCE — the case no agreement test could see", () => {
  // `publishedRollupAgreement.test.ts` compares `publishedStatusFor` with `rollupViewFor`, and BOTH
  // come out of the one `composeRollup` — so it is structurally blind to AgentSidebar's parallel
  // copy of the chain. This is the case that separated them (roborev 67199): a briefless agent
  // inside NEW_AGENT_GRACE_MS, status `errored`, verdict `awaiting`.
  //
  //   overlay AFTER step (0):  calmNewAgent greys `errored` -> `new`, which `applyVerdict` DOES
  //                            rewrite -> `waiting` (red, needs_you)
  //   overlay BEFORE step (0): `errored` is left alone (it is already surfacing), then
  //                            calmNewAgent's red backstop -> `new` (gray, calm band)
  //
  // The Build column would band it red while the dock badge and the concierge feed called it calm.
  // Both chains now apply the overlay BEFORE step (0), so this pins the agreed answer.
  const briefless = () =>
    ({ ...mk("a"), lastPrompt: "", promptHistory: [], createdAt: Date.now() }) as AgentTab;

  it("resolves a briefless, freshly-spawned `errored` agent the same way on both chains", () => {
    observe("a", reading("awaiting"));
    const agents = [briefless()];
    const viaPublished = published(agents, { a: "errored" });
    const viaOwn = own(agents, { a: "errored" });
    expect(viaPublished.a).toBe(viaOwn.a);
    // …and the agreed answer is the calm one: an `errored` row is ALREADY surfacing, so the
    // overlay leaves it, and step (0)'s red backstop then holds it for the grace window.
    expect(viaPublished.a).toBe("new");
    expect(bandOfStatus(viaPublished.a!)).not.toBe("needs_you");
  });

  it("the SAME agent past the grace window keeps its red on both chains", () => {
    // The paired case: "they agree" would also pass for two chains that were both wrong.
    observe("a", reading("awaiting"));
    const old = { ...briefless(), createdAt: 1 } as AgentTab;
    const agents = [old];
    expect(published(agents, { a: "errored" }).a).toBe("errored");
    expect(own(agents, { a: "errored" }).a).toBe("errored");
  });
});

describe("the verdict reaches an agent with no status entry at all", () => {
  it("raises a row this window has never observed", () => {
    const agents = [mk("a")];
    observe("a", reading("awaiting"));
    expect(published(agents, {}).a).toBe("waiting");
  });
});
