// DO NOT RESURRECT INTO AN ALREADY-SATURATED FLEET (bead sparkle-5j6re3).
//
// `MAX_RESPAWNS_PER_SWEEP` bounds the RATE of respawns per tick, but nothing bounded how many panes
// the resurrector would MOUNT. Every new `AgentPane` mount forces a full-document layout across
// every other mounted pane (sparkle-gw36j), so an app restart that leaves hundreds of agents due
// turns resurrection into an O(N) layout paid once per admitted mount — measured on v0.130.0 as a
// 7.7s main-thread stall after the fleet reached 40 panes, with the founder's own spawns landing
// ~7s late behind it.
//
// The gate refuses BRAND-NEW pane mounts once the mounted fleet is at the ceiling, and ONLY those:
// an agent whose pane is already mounted recovers via a cheap route-1 PTY restart that adds no pane
// and pays no layout, so the common one-at-a-time transport death still recovers on a full fleet.
//
// ── THE SIGNAL IS THE IN-PROCESS PANE REGISTRY, NOT `openAgentIds` ────────────────────────────
// The last block below is the regression that a HIGH-severity review caught: `openAgentIds` is
// PERSISTED to localStorage and restored at boot, so after a restart it names last session's open
// agents — none of which has a pane in this process. Keying "already mounted" on it would read every
// due agent in the restart storm as already-mounted and admit the whole flood, while refusing the
// few that were genuinely absent. The gate must read `services/paneControl`'s in-process restart
// registry — the exact set `restartPane` (and so `mountAgent`'s route choice) consults.
//
// Every assertion is on the SIDE EFFECT — which agents were actually handed to `mount` — not on the
// outcome string alone, because a broken gate would still report the string correctly while mounting
// the whole flood.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_MOUNTED_PANES_FOR_RESURRECTION,
  MAX_RESPAWNS_PER_SWEEP,
  type DueAgent,
  type ResurrectionSweepOptions,
  _resetResurrectionRunnerForTests,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";
import { MAX_RESURRECTS_PER_AGENT_PER_DAY } from "../engine/resurrection";
import { registerPaneRestart, unregisterPaneRestart } from "./paneControl";
import { useRuntimeStore } from "../stores/runtimeStore";

const NOW = 1_754_534_400_000;

/** A dead, resurrectable, DUE solo agent. A DISTINCT `message` per agent gives each its own
 *  `cohortKeyOf` key, so `groupCohorts` returns each as a lone death and it flows through the
 *  admission loop the mount ceiling guards — rather than clustering and taking the canary path. */
function dead(id: string): DueAgent {
  return {
    agentId: id,
    projectId: "proj-1",
    worktree: `/wt/${id}`,
    cause: "transport-transient",
    epoch: "epoch-that-died",
    diedAt: NOW - 60_000,
    notBeforeMs: NOW - 60_000,
    message: `distinct banner for ${id}`,
    attemptsAt: [],
  };
}

/** An app-restart cohort: N agents sharing one dead epoch, so `cohortKeyOf` groups them into ONE
 *  cohort — the exact shape of the measured storm (a restart seals every agent under one epoch).
 *  `r0` is the oldest death, so `electCanary` picks it as the canary. */
function restartCohort(n: number): DueAgent[] {
  return Array.from({ length: n }, (_, i) => ({
    agentId: `r${i}`,
    projectId: "proj-1",
    worktree: `/wt/r${i}`,
    cause: "app-restart" as const,
    epoch: "dead-epoch",
    // 60s in the past so the ladder's first rung has already elapsed by `NOW` (r0 oldest), and
    // spread by 1s so all three stay inside one shared-failure window and cluster into one cohort.
    diedAt: NOW - 60_000 + i * 1_000,
    notBeforeMs: NOW - 60_000,
    message: null,
    attemptsAt: [],
  }));
}

interface Harness {
  opts: ResurrectionSweepOptions;
  /** Every agent id actually handed to `mount`, in order — the side effect that costs a layout. */
  mounted: string[];
}

/**
 * @param mountedPaneIds when an array, injected as the mounted-pane source; when `"default"`, the
 *   option is OMITTED so the sweep uses its real default (the in-process pane registry).
 */
function harness(due: DueAgent[], mountedPaneIds: string[] | "default"): Harness {
  const mounted: string[] = [];
  const opts: ResurrectionSweepOptions = {
    now: NOW,
    ownsProject: () => true,
    projectTornOut: () => false,
    hasAgentRow: () => true,
    due: () => Promise.resolve(due),
    liveSessions: () => Promise.resolve([]),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    mount: (agentId) => {
      mounted.push(agentId);
      return "opened" as const;
    },
    suppress: () => {},
    escalate: () => true,
  };
  if (mountedPaneIds !== "default") opts.mountedPaneIds = () => mountedPaneIds;
  return { mounted, opts };
}

/** ids registered in the in-process pane registry this test, torn down in afterEach. */
const registered: string[] = [];
function mountPane(id: string): void {
  registerPaneRestart(id, () => {});
  registered.push(id);
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

afterEach(() => {
  for (const id of registered) unregisterPaneRestart(id);
  registered.length = 0;
  useRuntimeStore.setState({ openAgentIds: [] });
});

describe("the resurrection mount ceiling (bead sparkle-5j6re3)", () => {
  it("mounts NO new pane once the fleet is at the ceiling", async () => {
    // Three due agents — deliberately FEWER than MAX_RESPAWNS_PER_SWEEP, so a green result cannot be
    // the per-sweep rate cap doing the work. Only the mount ceiling can refuse these.
    expect(3).toBeLessThan(MAX_RESPAWNS_PER_SWEEP);
    const fullFleet = Array.from({ length: MAX_MOUNTED_PANES_FOR_RESURRECTION }, (_, i) => `m-${i}`);
    const h = harness([dead("a1"), dead("a2"), dead("a3")], fullFleet);

    const outcomes = await sweepResurrections(h.opts);

    expect(h.mounted).toEqual([]);
    expect(outcomes).toEqual([
      { agentId: "a1", action: "none", detail: "fleet-at-mount-ceiling" },
      { agentId: "a2", action: "none", detail: "fleet-at-mount-ceiling" },
      { agentId: "a3", action: "none", detail: "fleet-at-mount-ceiling" },
    ]);
  });

  it("PAIRED POSITIVE: on an empty fleet the same agents ARE mounted", async () => {
    // Without this the test above would pass just as well against a sweep that mounts nothing ever.
    const h = harness([dead("a1"), dead("a2"), dead("a3")], []);

    const outcomes = await sweepResurrections(h.opts);

    expect([...h.mounted].sort()).toEqual(["a1", "a2", "a3"]);
    expect(outcomes.every((o) => o.action === "respawn")).toBe(true);
  });

  it("still recovers an ALREADY-MOUNTED agent on a full fleet — the gate is new-pane-only", async () => {
    // "a1" is one of the mounted panes. Recovering it adds no pane, so the ceiling must not touch it
    // even though the fleet is otherwise completely full.
    const mountedIds = [
      ...Array.from({ length: MAX_MOUNTED_PANES_FOR_RESURRECTION - 1 }, (_, i) => `m-${i}`),
      "a1",
    ];
    expect(mountedIds).toHaveLength(MAX_MOUNTED_PANES_FOR_RESURRECTION);
    // Two due agents: "a1" (already mounted → allowed) and "b1" (needs a new pane → refused).
    const h = harness([dead("a1"), dead("b1")], mountedIds);

    const outcomes = await sweepResurrections(h.opts);

    expect(h.mounted).toEqual(["a1"]);
    // Order-independent: the outcome list interleaves selection-time refusals and final-loop
    // respawns, and their relative order is an implementation detail. What matters is the verdict
    // per agent.
    expect(outcomes.find((o) => o.agentId === "a1")).toEqual({
      agentId: "a1",
      action: "respawn",
      detail: "attempt 1 (opened)",
    });
    expect(outcomes.find((o) => o.agentId === "b1")).toEqual({
      agentId: "b1",
      action: "none",
      detail: "fleet-at-mount-ceiling",
    });
  });

  it("admits exactly the remaining headroom of new mounts, and refuses the rest", async () => {
    // One pane short of the ceiling: headroom is exactly 1 new mount for the whole sweep.
    const nearlyFull = Array.from(
      { length: MAX_MOUNTED_PANES_FOR_RESURRECTION - 1 },
      (_, i) => `m-${i}`,
    );
    const h = harness([dead("a1"), dead("a2"), dead("a3")], nearlyFull);

    const outcomes = await sweepResurrections(h.opts);

    // Exactly ONE new mount landed; the headroom is spent across the sweep, not re-granted per agent.
    expect(h.mounted).toEqual(["a1"]);
    expect(outcomes.find((o) => o.agentId === "a1")).toEqual({
      agentId: "a1",
      action: "respawn",
      detail: "attempt 1 (opened)",
    });
    expect(outcomes.filter((o) => o.agentId === "a2" || o.agentId === "a3")).toEqual([
      { agentId: "a2", action: "none", detail: "fleet-at-mount-ceiling" },
      { agentId: "a3", action: "none", detail: "fleet-at-mount-ceiling" },
    ]);
  });

  it("does NOT let ceiling-refused new mounts starve the sweep budget for a route-1 restart", async () => {
    // roborev finding: the ceiling once ran AFTER `planned` was spent, so ceiling-refused new-pane
    // agents consumed the sweep's MAX_RESPAWNS_PER_SWEEP slots. The due list order is stable, so the
    // same head-of-list new-pane agents burned the whole budget every sweep and an already-mounted
    // agent later in id order got `sweep-cap` forever and never recovered.
    //
    // Backlog LARGER than the sweep cap, all needing new panes, with the one already-mounted agent
    // at the TAIL. On a full fleet the new-pane agents are all ceiling-refused WITHOUT spending the
    // budget, so the tail route-1 agent still reaches mount.
    const newPaneBacklog = Array.from({ length: MAX_RESPAWNS_PER_SWEEP + 2 }, (_, i) => dead(`new-${i}`));
    expect(newPaneBacklog.length).toBeGreaterThan(MAX_RESPAWNS_PER_SWEEP);
    const mountedIds = [
      ...Array.from({ length: MAX_MOUNTED_PANES_FOR_RESURRECTION - 1 }, (_, i) => `m-${i}`),
      "z1", // the route-1 agent already has a pane; the fleet is exactly at the ceiling
    ];
    const h = harness([...newPaneBacklog, dead("z1")], mountedIds);

    const outcomes = await sweepResurrections(h.opts);

    // The tail route-1 agent recovered; NONE of the backlog mounted; and not one of them was refused
    // with `sweep-cap` — every refusal is the ceiling, proving the budget was never spent on them.
    expect(h.mounted).toEqual(["z1"]);
    expect(outcomes.find((o) => o.agentId === "z1")).toEqual({
      agentId: "z1",
      action: "respawn",
      detail: "attempt 1 (opened)",
    });
    const backlogOutcomes = outcomes.filter((o) => o.agentId.startsWith("new-"));
    expect(backlogOutcomes).toHaveLength(newPaneBacklog.length);
    expect(backlogOutcomes.every((o) => o.detail === "fleet-at-mount-ceiling")).toBe(true);
    expect(outcomes.some((o) => o.detail === "sweep-cap")).toBe(false);
  });

  it("does not let a GATE-DECLINED head-of-list agent reserve the headroom a revivable one needs", async () => {
    // roborev finding: the ceiling reserved a slot BEFORE the per-agent gate ran, so an agent the
    // gate declines (here `daily-cap-spent`, which is stable for hours) would consume the only
    // headroom slot every sweep, mount nothing, and — because the due-list order is stable — starve
    // a revivable agent behind it forever, with a slot physically free.
    const spent = Array.from({ length: MAX_RESURRECTS_PER_AGENT_PER_DAY }, (_, i) => NOW - 1_000 - i);
    const capped = { ...dead("a-capped"), attemptsAt: spent }; // gate will decline: daily-cap-spent
    const good = dead("b-good"); // fully revivable, also needs a new pane
    // One pane short of the ceiling: exactly one new mount may land this sweep.
    const nearlyFull = Array.from(
      { length: MAX_MOUNTED_PANES_FOR_RESURRECTION - 1 },
      (_, i) => `m-${i}`,
    );
    const h = harness([capped, good], nearlyFull);

    const outcomes = await sweepResurrections(h.opts);

    // The revivable agent got the free slot; the declined one reserved nothing and never mounted.
    expect(h.mounted).toEqual(["b-good"]);
    expect(outcomes.find((o) => o.agentId === "a-capped")).toEqual({
      agentId: "a-capped",
      action: "none",
      detail: "daily-cap-spent",
    });
    expect(outcomes.find((o) => o.agentId === "b-good")?.action).toBe("respawn");
  });

  // ── THE DEFAULT SEAM: the in-process registry, not persisted openAgentIds ────────────────────
  // These omit `mountedPaneIds`, so they drive the REAL default the app uses. That default line is
  // otherwise covered by nothing — the injected cases above would pass against a default reading
  // `openAgentIds`, which is the exact HIGH-severity defect this block exists to pin.

  it("default seam: reads the in-process pane registry, so a restart-persisted id is a NEW mount", async () => {
    // The restart storm, faithfully: openAgentIds is rehydrated from localStorage naming last
    // session's open agents (including "b1"), but NO pane is mounted for any of them in this process.
    useRuntimeStore.setState({
      openAgentIds: ["b1", ...Array.from({ length: 60 }, (_, i) => `stale-${i}`)],
    });
    // The real in-process registry is at the ceiling with genuinely-mounted panes. "b1" is NOT here.
    for (let i = 0; i < MAX_MOUNTED_PANES_FOR_RESURRECTION; i++) mountPane(`real-${i}`);

    const h = harness([dead("b1")], "default");
    const outcomes = await sweepResurrections(h.opts);

    // If the gate read openAgentIds, "b1" would look already-mounted and be admitted — the storm.
    // Reading the registry, "b1" needs a new pane and the fleet is full, so it is refused.
    expect(h.mounted).toEqual([]);
    expect(outcomes).toEqual([{ agentId: "b1", action: "none", detail: "fleet-at-mount-ceiling" }]);
  });

  it("default seam: an agent WITH a registered pane recovers even at the ceiling", async () => {
    // openAgentIds is EMPTY, proving admission comes from the registry, not the persisted set.
    useRuntimeStore.setState({ openAgentIds: [] });
    for (let i = 0; i < MAX_MOUNTED_PANES_FOR_RESURRECTION - 1; i++) mountPane(`real-${i}`);
    mountPane("a1"); // a real mounted pane → registry holds it; fleet now exactly at the ceiling

    const h = harness([dead("a1")], "default");
    const outcomes = await sweepResurrections(h.opts);

    expect(h.mounted).toEqual(["a1"]);
    expect(outcomes).toEqual([{ agentId: "a1", action: "respawn", detail: "attempt 1 (opened)" }]);
  });
});

describe("the mount ceiling on the cohort / app-restart path (bead sparkle-5j6re3)", () => {
  it("refuses the canary's new-pane mount when the fleet is at the ceiling", async () => {
    // The measured storm's own path: a restart seals every agent under ONE epoch, so they form ONE
    // cohort and the sweep admits only the canary (r0) on the first tick. On a full fleet that mount
    // is a new pane, so the ceiling must refuse it — the cohort waits rather than melting the app.
    const fullFleet = Array.from({ length: MAX_MOUNTED_PANES_FOR_RESURRECTION }, (_, i) => `m-${i}`);
    const h = harness(restartCohort(3), fullFleet);

    const outcomes = await sweepResurrections(h.opts);

    expect(h.mounted).toEqual([]);
    expect(outcomes.find((o) => o.agentId === "r0")).toEqual({
      agentId: "r0",
      action: "none",
      detail: "fleet-at-mount-ceiling",
    });
  });

  it("PAIRED POSITIVE: on an empty fleet the cohort's canary IS mounted", async () => {
    const h = harness(restartCohort(3), []);

    const outcomes = await sweepResurrections(h.opts);

    // Exactly the canary mounts — the cohort machinery still holds the others behind probation.
    expect(h.mounted).toEqual(["r0"]);
    expect(outcomes.find((o) => o.agentId === "r0")?.action).toBe("respawn");
  });
});
