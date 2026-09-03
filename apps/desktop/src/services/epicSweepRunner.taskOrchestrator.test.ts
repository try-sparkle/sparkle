// TWO RULES OVER ONE FIELD — and until this file existed, NOTHING anywhere asserted whether they
// agree (bead `sparkle-n2feho.5`).
//
// `AgentTab.epicId` is the BINDING. `epicSweepRunner.boundAgentsFor` matched it RAW; `epicLadder`
// resolves `epicId ?? beadId` UP to the owning epic. A `mode: "task"` handoff stamps a TASK bead id
// into that field (`sendToBuild.prepareHandoff`), so it satisfied every RESOLVING reader and no raw
// one — and the board then contradicted itself inside one tick: `agentsForEpicSlices` found the
// agent so the Epics column rendered the epic STAFFED, while the sweep read it unstaffed and the
// pusher counted it toward the three-alarm fire.
//
// The fix is NOT "resolve everywhere". Three reads deliberately stay RAW and each has its own case
// below, because a raw read that quietly became resolved is how this defect would come back wearing
// the opposite face:
//   • the WATCH GATE (`candidateFor`'s `promoted`) and the MARKER SELF-HEAL in `sweepEpics` — both
//     answer "was this EPIC handed over", and `sendToBuild` refuses to stamp `PROMOTED_LABEL` for a
//     task handoff on purpose;
//   • `sendToBuild.prepareHandoff` / `planView.orchestratorNameForEpic` — the one-orchestrator-per-
//     task reuse rule and its mirror, which `docs/orchestrators-per-task.md` requires to agree.
//     Untouched by this change; the reuse case is pinned in `sendToBuild`'s own suite.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));

import {
  boundAgentsFor,
  candidateFor,
  staffingAgentsFor,
  sweepEpics,
  type EpicSweepOutcome,
} from "./epicSweepRunner";
import { epicIdForAgent } from "./epicLadder";
import { PROMOTED_LABEL, STALLED_LABEL, type Bead } from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import { useRuntimeStore } from "../stores/runtimeStore";
import { _resetDeadSessionRegistryForTests } from "./deadSessionRegistry";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
/** Old enough that the epic is stalled, so every sweep case below reaches the staffing question. */
const STALE = NOW - EPIC_STALL_MS - 60_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

/** `e1`, promoted and planned, with ONE stalled child `e1.t1`. */
const promotedEpic = (): Bead[] => [
  bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [PROMOTED_LABEL] }),
  bead({ id: "e1.t1", parent: "e1", updatedAt: iso(STALE) }),
];

/** Exactly what `sendToBuild.prepareHandoff` writes in `mode: "task"`: the TASK id in BOTH fields. */
const taskOrchestrator = buildAgent({
  id: "orch-task",
  epicId: "e1.t1",
  beadId: "e1.t1",
  createdAt: STALE - 60_000,
});

/** The ordinary `mode: "epic"` shape, for every PAIRED case. */
const epicOrchestrator = buildAgent({
  id: "orch-epic",
  epicId: "e1",
  beadId: "e1",
  createdAt: STALE - 60_000,
});

beforeEach(() => {
  useRuntimeStore.setState({ status: {}, agentMovement: {} } as never);
  _resetDeadSessionRegistryForTests();
});

describe("the raw binding and the resolved ladder, on a mode:'task' orchestrator", () => {
  it("DISAGREE, and the disagreement is the defect: raw finds nobody, the ladder finds the agent", () => {
    const beads = promotedEpic();
    // The raw predicate is `a.epicId === "e1"`, and this agent's `epicId` is the CHILD's id.
    expect(boundAgentsFor([taskOrchestrator], "e1")).toEqual([]);
    // The sanctioned resolver walks it up to the owning epic…
    expect(epicIdForAgent(taskOrchestrator, beads)).toBe("e1");
    // …and the staffing read agrees with the resolver, which is the whole contract of this helper.
    expect(staffingAgentsFor([taskOrchestrator], beads, "e1")).toEqual([taskOrchestrator]);
  });

  it("AGREE on an ordinary mode:'epic' orchestrator — the resolution is not a rewrite", () => {
    const beads = promotedEpic();
    expect(boundAgentsFor([epicOrchestrator], "e1")).toEqual([epicOrchestrator]);
    expect(staffingAgentsFor([epicOrchestrator], beads, "e1")).toEqual([epicOrchestrator]);
  });

  it("the staffing read is bounded by the PARENT EDGE, not by 'a build agent exists'", () => {
    const beads = [
      ...promotedEpic(),
      bead({ id: "e2", title: "Something else", type: "epic" }),
      bead({ id: "e2.t1", parent: "e2" }),
    ];
    const other = buildAgent({ id: "orch-other", epicId: "e2.t1", beadId: "e2.t1" });
    expect(staffingAgentsFor([other], beads, "e1")).toEqual([]);
    expect(staffingAgentsFor([other], beads, "e2")).toEqual([other]);
  });

  it("WORKERS are excluded — the sweep and the pusher ask about ORCHESTRATORS", () => {
    const beads = promotedEpic();
    const worker = { name: "w1", id: "w1", kind: "worker", beadId: "e1.t1" } as unknown as AgentTab;
    expect(epicIdForAgent(worker, beads)).toBe("e1"); // the ladder does place it under e1…
    expect(staffingAgentsFor([worker], beads, "e1")).toEqual([]); // …and this read still excludes it
  });
});

// ── THE SIDE EFFECT, NOT THE HELPER'S ARRAY LENGTH ─────────────────────────────────────────────
// `sweepEpics` on a stalled, promoted epic RESTARTS it when nobody is driving it. These cases are
// about which agents "nobody" counts.
function sweep(agents: AgentTab[], beads: Bead[], over: { alive?: boolean } = {}) {
  const restart = vi.fn(async (_projectId: string, _epicId: string) => ({
    agentId: "new-agent",
    verdict: "restarted" as const,
  }));
  const setLabel = vi.fn(
    async (_path: string, action: "add" | "remove", id: string, label: string) => {
      const b = beads.find((x) => x.id === id);
      if (!b) return;
      b.labels =
        action === "add"
          ? [...b.labels.filter((l) => l !== label), label]
          : b.labels.filter((l) => l !== label);
    },
  );
  const notify = vi.fn((_text: string) => true);
  const run = (): Promise<EpicSweepOutcome[]> =>
    sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => over.alive,
      restartEnabled: true,
      restart,
      mark: vi.fn(async (path: string, action: "add" | "remove", id: string) =>
        setLabel(path, action, id, STALLED_LABEL),
      ),
      setLabel,
      notify,
      canNotify: () => true,
      audit: vi.fn(async () => {}),
      // A FRESH hook event, so the liveness join reads a live agent as live rather than as a silent
      // one. Injected rather than left to `runtimeStore` so the case is about membership only.
      lastHookEventFor: () => NOW - 1000,
      deathCauseFor: () => undefined,
    });
  return { run, restart, setLabel, notify };
}

const forEpic = (out: EpicSweepOutcome[]) => out.find((x) => x.epicId === "e1");

describe("the sweep does not hand back an epic a task-level orchestrator is building", () => {
  it("SKIPS the restart when the only agent is a LIVE mode:'task' orchestrator", async () => {
    const s = sweep([taskOrchestrator], promotedEpic(), { alive: true });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("skip");
    expect(o?.reason).toBe("orchestrator-alive");
    expect(o?.performed).toBe("none");
    expect(s.restart).not.toHaveBeenCalled();
  });

  it("PAIRED — RESTARTS when that same task-level orchestrator is observed DEAD", async () => {
    // Without this, the case above is satisfied by a sweep that never restarts anything: resolving
    // membership must not also fold away the liveness verdict it feeds.
    const s = sweep([taskOrchestrator], promotedEpic(), { alive: false });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  it("PAIRED — RESTARTS when the live task orchestrator belongs to ANOTHER epic", async () => {
    const beads = [
      ...promotedEpic(),
      bead({ id: "e2", title: "Something else", type: "epic" }),
      bead({ id: "e2.t1", parent: "e2" }),
    ];
    const other = buildAgent({ id: "orch-other", epicId: "e2.t1", beadId: "e2.t1" });
    const s = sweep([other], beads, { alive: true });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
  });
});

// ── THE THREE READS THAT STAY RAW ─────────────────────────────────────────────────────────────
describe("the WATCH GATE and the MARKER SELF-HEAL stay raw", () => {
  /** An epic with NO promoted marker — the precondition the self-heal actually needs. */
  const unmarkedEpic = (): Bead[] => [
    bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [] }),
    bead({ id: "e1.t1", parent: "e1", updatedAt: iso(STALE) }),
  ];

  it("a task-level orchestrator does NOT put an unpromoted epic into the watch set", () => {
    // `promoted` is the gate that decides whether the sweep looks at this epic at all. Resolving it
    // would enrol an epic nobody promoted for as long as one task orchestrator's tab existed.
    const beads = unmarkedEpic();
    const c = candidateFor(beads, [taskOrchestrator], beads[0] as Bead, () => true);
    expect(c.promoted).toBe(false);
    // …and it is genuinely staffing it, which is exactly why the two answers must differ.
    expect(c.orchestratorAlive).toBe(true);
  });

  it("PAIRED — an epic-level orchestrator DOES put it into the watch set", () => {
    const beads = unmarkedEpic();
    const c = candidateFor(beads, [epicOrchestrator], beads[0] as Bead, () => true);
    expect(c.promoted).toBe(true);
  });

  it("does NOT heal the promoted marker off a task-level orchestrator", async () => {
    // `sendToBuild` refuses to stamp PROMOTED_LABEL for a `mode: "task"` handoff — "stamping it
    // would aim the sweep at ordinary tasks". A resolved read here would write the very label that
    // path declines to, permanently, from one click on one child bead.
    const beads = unmarkedEpic();
    const s = sweep([taskOrchestrator], beads, { alive: true });
    await s.run();
    expect(
      s.setLabel.mock.calls.filter((c) => c[3] === PROMOTED_LABEL && c[2] === "e1"),
    ).toEqual([]);
  });

  it("PAIRED — DOES heal it off an epic-level orchestrator, so the heal is not dead code", async () => {
    const beads = unmarkedEpic();
    const s = sweep([epicOrchestrator], beads, { alive: true });
    await s.run();
    expect(
      s.setLabel.mock.calls.filter((c) => c[3] === PROMOTED_LABEL && c[2] === "e1").length,
    ).toBe(1);
  });
});
