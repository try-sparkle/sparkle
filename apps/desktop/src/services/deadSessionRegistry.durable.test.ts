// THE DURABLE FALLBACK, END TO END (bead sparkle-nu7gd9, Defect #1).
//
// The founder's report: an ENOTFOUND / 529 wave kills agents and the row renders RED — "there's
// nothing I can do to resolve this. So why am I seeing this?" — while the app is ALREADY restarting
// them off the durable Rust ledger. The classification (`transport-transient`), the resurrectability
// rule (`isResurrectable`) and the de-red overlay (`withDeadSessionCalm`) were all already correct;
// the gap was that the overlay reads `deathCauseForAgent`, which only knew about deaths THIS WINDOW
// mounted (`classifyDeath` Gate 0). The common wave death — an unmounted pane, or a fleet-wide wave
// with no surviving pane to record anything — was sealed only in the durable ledger, which
// `revival.rs` restarts from and `services/resurrectionRunner` now mirrors into
// `stores/resurrectableDeadStore`. This file pins that a durable-only resurrectable death is
// de-redded exactly as an observed one is, driving the REAL `deathCauseForAgent` into the REAL
// `withDeadSessionCalm`.
//
// ── NON-VACUITY ──────────────────────────────────────────────────────────────────────────────────
// Every "goes amber" case is paired with a "STAYS RED" one, because a rule that de-reds everything
// would pass every demotion assertion: a genuine human-blocked failure (which the ledger never lists
// as due, so it reaches the fallback as `undefined`) must stay red, and a respawned agent (cleared by
// `forgetAgentDeath`) must stop being amber. The mutation that matters — reverting
// `deathCauseForAgent` to `deaths.get(agentId)` alone — turns the headline case red again and is
// caught here.
import { afterEach, describe, expect, it } from "vitest";
import { withDeadSessionCalm, RECOVERING_DEAD_STATUS } from "../engine/deadSessionAttention";
import {
  deathCauseForAgent,
  noteAgentDeath,
  forgetAgentDeath,
  _resetDeadSessionRegistryForTests,
} from "./deadSessionRegistry";
import {
  useResurrectableDeadStore,
  _resetResurrectableDeadStoreForTests,
} from "../stores/resurrectableDeadStore";
import { publishedStatusFor } from "../useAttentionNotifications";
import type { StatusMap } from "../engine/attention";
import type { AgentTab } from "../types";

/** The minimal agent the overlay reads — it only ever touches `id`. */
function agent(id: string): AgentTab {
  return { id } as unknown as AgentTab;
}

/** A briefed, long-lived agent — so `composeRollup`'s step (0) `calmNewAgent` does not gray it to
 *  `new` before the dead-session step is the thing under test. */
function briefed(id: string): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    lastPrompt: "briefed",
    namePinned: true,
    createdAt: Date.now() - 60 * 60_000,
  } as unknown as AgentTab;
}

/** Seed the durable store exactly as `resurrectionRunner`'s sweep does, from a `revival_due` list. */
function seedDurable(entries: Array<{ agentId: string; cause: Parameters<typeof noteAgentDeath>[1] }>) {
  useResurrectableDeadStore.getState().syncDurable(entries);
}

afterEach(() => {
  _resetDeadSessionRegistryForTests();
  _resetResurrectableDeadStoreForTests();
});

describe("deathCauseForAgent — durable fallback and precedence", () => {
  it("returns the durable ledger's cause for a death this window never observed", () => {
    // No `noteAgentDeath` — this window mounted nothing for `a`. The Rust reaper sealed it and the
    // resurrection sweep mirrored it here.
    seedDurable([{ agentId: "a", cause: "process-gone" }]);
    expect(deathCauseForAgent("a")).toBe("process-gone");
  });

  it("the OBSERVED reading wins over the durable one — a mounted pane is fresher evidence", () => {
    // A window that watched the death has the stronger, more specific reading. Both are resurrectable
    // here, so the colour is unchanged either way; the precedence is about which cause a reader sees.
    noteAgentDeath("a", "unknown");
    seedDurable([{ agentId: "a", cause: "transport-transient" }]);
    expect(deathCauseForAgent("a")).toBe("unknown");
  });

  it("is undefined when NEITHER source has a reading — an absence, never 'alive'", () => {
    expect(deathCauseForAgent("ghost")).toBeUndefined();
  });
});

describe("withDeadSessionCalm over the durable fallback — the founder's wave", () => {
  it("a transient death known ONLY to the durable ledger is de-redded to amber, not left red", () => {
    // The exact shape: `errored` written by `statusEngine.exit()`, the death visible only in the
    // durable ledger (`transport-transient`), which is what an ENOTFOUND banner classifies as.
    seedDurable([{ agentId: "a", cause: "transport-transient" }]);
    const out = withDeadSessionCalm([agent("a")], { a: "errored" } as StatusMap, deathCauseForAgent);
    expect(out["a"]).toBe(RECOVERING_DEAD_STATUS);
    expect(out["a"]).not.toBe("errored");
  });

  it("PAIRED: a genuine human-blocked failure STAYS RED — the ledger never lists it as due", () => {
    // `blocked-on-human` is not resurrectable, so `revival::due_at` never emits it and it never
    // reaches the durable fallback. This window observed it; it must stay `errored` (red) — a person,
    // not a restart, is the thing it waits on. Without this the headline above would pass against a
    // rule that de-reds everything.
    noteAgentDeath("a", "blocked-on-human");
    const out = withDeadSessionCalm([agent("a")], { a: "errored" } as StatusMap, deathCauseForAgent);
    expect(out["a"]).toBe("errored");
  });

  it("PAIRED: an agent in NEITHER source stays exactly as it was — absence demotes nothing", () => {
    const out = withDeadSessionCalm([agent("a")], { a: "errored" } as StatusMap, deathCauseForAgent);
    expect(out["a"]).toBe("errored");
  });

  it("a respawn clears the durable entry, so the row stops being amber", () => {
    seedDurable([{ agentId: "a", cause: "transport-transient" }]);
    expect(
      withDeadSessionCalm([agent("a")], { a: "errored" } as StatusMap, deathCauseForAgent)["a"],
    ).toBe(RECOVERING_DEAD_STATUS);

    // `openDeathRecord` runs on the respawn's pane mount and calls this; it must clear the durable
    // fallback too, or a working agent keeps rendering amber.
    forgetAgentDeath("a");
    expect(deathCauseForAgent("a")).toBeUndefined();
    expect(
      withDeadSessionCalm([agent("a")], { a: "errored" } as StatusMap, deathCauseForAgent)["a"],
    ).toBe("errored");
  });
});

describe("the composeRollup surface (epic square / Build-column band) reads the durable fallback", () => {
  // The band and the rolled-up disc come from `publishedStatusFor` → `composeRollup`, which defaults
  // `deathCauseOf` to the durable-aware `deathCauseForAgent`. This guards that DATA path — the surface
  // the founder reported (roborev 70464) — independently of the row-status chain above. The reactivity
  // ANCHOR that makes the memo re-run is the `durableDead` subscription each consumer now lists.
  const NO_PANES = new Set<string>();
  const NO_STAGE = () => undefined as never;

  it("de-reds a durable-only transient death on the published rollup map", () => {
    seedDurable([{ agentId: "a", cause: "transport-transient" }]);
    const published = publishedStatusFor(
      [briefed("a")],
      { a: "errored" },
      NO_PANES,
      {},
      NO_STAGE,
    );
    expect(published["a"]).toBe(RECOVERING_DEAD_STATUS);
    expect(published["a"]).not.toBe("errored");
  });

  it("PAIRED: leaves it red when the durable ledger has no reading — absence demotes nothing", () => {
    const published = publishedStatusFor(
      [briefed("a")],
      { a: "errored" },
      NO_PANES,
      {},
      NO_STAGE,
    );
    expect(published["a"]).toBe("errored");
  });
});
