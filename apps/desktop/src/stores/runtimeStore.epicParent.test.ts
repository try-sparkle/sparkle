// EPIC LINKAGE ON THE POLL PATH — bead sparkle-f2tzxg, the sibling spawn path acceptance #1 names
// ("fix the call site … AND ANY SIBLING SPAWN PATH").
//
// `buildAgentSpawn` mints its auto-bead with the epic as parent. `runtimeStore.syncBeadLifecycle`
// mints one too, from the bead-lifecycle poll, for any deliverable Build agent that has no `beadId`
// yet — and it used `beads.createBead`, which takes NO parent argument. Every bead that path minted
// was therefore top-level.
//
// ── THE RACE, WHICH IS WHY THE POLL PATH IS REACHABLE AT ALL ─────────────────────────────────────
// `buildAgentSpawn` writes the row's `epicId` SYNCHRONOUSLY at spawn, then mints its bead
// fire-and-forget (`void createBeadFull(...).then(setAgentBeadId)`) with a `.catch` that swallows a
// failure. So for the whole window between those two the row reads `epicId` SET / `beadId` UNSET —
// which is exactly the `hasBead: false` condition this poll fires on. If the poll wins, the agent's
// work gets a parentless bead; if the spawn's promise rejected, permanently.
//
// ── WHAT THESE TESTS ASSERT, AND WHAT THEY DELIBERATELY DO NOT ───────────────────────────────────
// "`agentsForEpicSlices(roster, [], epic)` returns the agent" is NOT the assertion, because it is
// VACUOUS here: `epicIdForAgent` reads `epicId` FIRST and, against an empty bead snapshot, trusts it
// unresolved (`return agent.epicId ? claimed : null`). An agent whose row carries the epic is
// therefore returned whatever its bead's parent is — before this fix and after it. Asserting it
// would be a green test guarding a 100%-broken feature, which is this repo's #1 finding.
//
// The fact the parent edge actually buys is the SLICE: `agentsForEpicSlices` walks each agent's bead
// up through parents and dotted prefixes and keeps every id that is a CHILD of the epic. With a
// parentless bead that walk finds nothing, so the epic has no slice being carried (what
// `engine/epicGoalRollup` reads to decide whether a slice is covered or stranded) and the work never
// appears under the epic on the Plan board. So each test below builds the bead snapshot from EXACTLY
// the arguments the poll handed `bd`, reads the agent row back out of the REAL projectStore, and
// asks the REAL membership query — `sliceIds`, plus `childrenOf` for the board edge.
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Every `createBeadFull` call, positionally, so `parent` (the 5th) can be read back. */
let fullCalls: unknown[][] = [];
let nextFullId = "bd-parented-1";
let fullThrows: Error | null = null;
/** Runs INSIDE the `createBeadFull` await, so a test can land a competing write mid-flight — the
 *  interleaving the ordering hazard is about, driven rather than replayed after the fact. */
let duringCreate: (() => void) | null = null;

vi.mock("../services/tasks", () => ({
  createBeadFull: async (...a: unknown[]) => {
    fullCalls.push(a);
    // A real `bd` shell-out is not synchronous; yield so the hook lands in a separate microtask.
    await Promise.resolve();
    duringCreate?.();
    if (fullThrows) throw fullThrows;
    return nextFullId;
  },
}));
// Keep the real pure helpers (isBeadsUnavailable, the epic index) — the latches depend on them.
vi.mock("../services/beads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/beads")>()),
  createBead: vi.fn(),
  claimBead: vi.fn(),
  closeBead: vi.fn(),
  markBeadDelivered: vi.fn(),
}));

import { syncBeadLifecycle, __resetBeadLifecycleForTest, useRuntimeStore } from "./runtimeStore";
import { useProjectStore } from "./projectStore";
import * as beads from "../services/beads";
import { childrenOf, type Bead } from "../services/beads";
import { agentsForEpicSlices } from "../services/epicLadder";
import { rollUpEpicGoal, type RollupBead } from "../engine/epicGoalRollup";
import {
  useBeadsStore,
  __setBeadsPolledAtForTest,
  __setBeadsReadStartedAtForTest,
} from "./beadsStore";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentTab } from "../types";

const EPIC_ID = "sparkle-epic1";
const PROJECT_PATH = "/tmp/demo";

const bs = (ahead: number): BranchStatus => ({
  ahead,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
});

/** A project holding ONE build agent, in the state the race leaves it in when `epicId` is passed:
 *  the row carries the epic and has NO bead yet. Returns [projectId, agentId]. */
function projectWithAgent(epicId?: string): [string, string] {
  const projectId = useProjectStore.getState().addProject("Demo", PROJECT_PATH);
  const agentId = useProjectStore.getState().addAgent(projectId)!;
  // Exactly what `buildAgentSpawn` does synchronously at spawn, and the ONLY half of membership
  // that exists while its own `createBeadFull` promise is still in flight.
  if (epicId) useProjectStore.getState().setAgentEpicId(projectId, agentId, epicId);
  return [projectId, agentId];
}

function rowOf(projectId: string, agentId: string): AgentTab {
  const row = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  if (!row) throw new Error(`no agent row ${agentId}`);
  return row;
}

/** A `Bead` carrying only what the epic index reads, so a test states the EDGE and nothing else. */
function blankBead(id: string): Bead {
  return { id, title: id, description: "", status: "open", type: "task", labels: [] };
}

const epicBead: Bead = {
  id: EPIC_ID,
  title: "The epic",
  description: "",
  status: "open",
  type: "epic",
  labels: [],
};

/**
 * The bead snapshot the Plan board would poll, built from what the poll actually told `bd`.
 *
 * Derived from the recorded calls rather than hand-written on purpose: a fixture hardcoding
 * `parent: EPIC_ID` would go on passing after the production line stopped sending it.
 */
function beadsAsBdWouldReturn(): Bead[] {
  const minted: Bead[] = fullCalls.map((call, i) => ({
    id: i === fullCalls.length - 1 ? nextFullId : `bd-parented-${i}`,
    title: String(call[1]),
    description: String(call[2]),
    status: "open",
    type: String(call[3]),
    labels: String(call[6]).split(",").filter(Boolean),
    // `""` is normalized to ABSENT, the way bd itself reports a parentless bead.
    ...((call[4] as string) ? { parent: call[4] as string } : {}),
  }));
  // Everything `beads.createBead` minted: that wrapper has no parent argument at all, so these are
  // top-level by construction — the shape the bug produced.
  const flat: Bead[] = vi.mocked(beads.createBead).mock.calls.map((call, i) => ({
    id: `bd-flat-${i}`,
    title: String(call[1]),
    description: String(call[2]),
    status: "open",
    type: "task",
    labels: String(call[3] ?? "").split(",").filter(Boolean),
  }));
  return [epicBead, ...minted, ...flat];
}

/** The 5th positional argument of `createBeadFull` — `parent` (services/tasks). */
function parentOfLastFullCall(): unknown {
  const last = fullCalls.at(-1);
  if (!last) throw new Error("createBeadFull was never called");
  return last[4];
}

/** Seed the board snapshot the poll reads when resolving a write-ambiguous create. Passing
 *  `undefined` leaves the project UNREAD, which must never be read as "nothing landed". */
/** Seed the board AND its freshness clock.
 *
 *  `polledAt` is module-scope in `beadsStore` and is written only inside `refresh`'s success
 *  commit, so a snapshot seeded imperatively reads as NEVER-SUCCESSFULLY-POLLED. Since
 *  `resolvePendingAmbiguousCreate` now refuses to decide from a board read that predates the
 *  create, a seed without a stamp would make every adoption test vacuously "undecided". `polledAt`
 *  defaults to NOW so the common case is a fresh read; pass `polledAt` explicitly to drive the
 *  stale case. */
function seedBoard(
  projectId: string,
  beads: Bead[] | undefined,
  polledAt = Date.now(),
  readStartedAt = polledAt,
): void {
  useBeadsStore.setState({
    byProject: beads ? { [projectId]: { beads, board: { columns: [] } as never } as never } : {},
  });
  __setBeadsPolledAtForTest(projectId, beads ? polledAt : undefined);
  // The two clocks move together by default, which is the ordinary case. `readStartedAt` is
  // separable ONLY so a test can express the straddling read — a completion stamp that is fresher
  // than the contents it describes — which is unrepresentable if a fixture ties them.
  __setBeadsReadStartedAtForTest(projectId, beads ? readStartedAt : undefined);
}

/** The auto-bead bd would have committed for `title` under `EPIC_ID`. */
function committedAutoBead(id: string, title: string): Bead {
  return {
    id,
    title,
    description: "",
    status: "open",
    type: "task",
    labels: [beads.AUTO_LABEL],
    parent: EPIC_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useBeadsStore.setState({ byProject: {} });
  __resetBeadLifecycleForTest();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  fullCalls = [];
  fullThrows = null;
  duringCreate = null;
  nextFullId = "bd-parented-1";
});

describe("syncBeadLifecycle — the poll's auto-bead is parented to the agent's epic", () => {
  it("THE LOSING INTERLEAVING: epicId set, beadId still unset — the poll mints a bead UNDER the epic", async () => {
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    // The premise of the race, asserted rather than assumed: this is the state the poll sees.
    expect(rowOf(projectId, agentId).epicId).toBe(EPIC_ID);
    expect(rowOf(projectId, agentId).beadId).toBeUndefined();

    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "Build the thing" },
      "building_saved",
      bs(1),
      false,
    );

    // The parent-capable wrapper was used, and the epic went through it.
    expect(parentOfLastFullCall()).toBe(EPIC_ID);
    expect(beads.createBead).not.toHaveBeenCalled();

    // …and the SIDE EFFECT: the epic now has a slice, and this agent is the one carrying it.
    const snapshot = beadsAsBdWouldReturn();
    const roster = [rowOf(projectId, agentId)];
    const staffing = agentsForEpicSlices(roster, snapshot, EPIC_ID);
    expect(staffing.map((a) => a.id)).toContain(agentId);
    expect(staffing.find((a) => a.id === agentId)!.sliceIds).toContain(nextFullId);
    // The board edge: the work hangs under the epic, so the epic can show it at all.
    expect(childrenOf(snapshot, EPIC_ID).map((b) => b.id)).toContain(nextFullId);
    // And the poll bound the bead it minted to the row.
    expect(rowOf(projectId, agentId).beadId).toBe(nextFullId);
  });

  it("keeps AUTO_LABEL and files the bead as a task, so the board's exclude filter still applies", async () => {
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "Build the thing" },
      "building_saved",
      bs(1),
      false,
    );
    const call = fullCalls.at(-1)!;
    expect(call[3]).toBe("task");
    expect(call[6]).toBe(beads.AUTO_LABEL);
  });

  it("THE RACE LOST MID-AWAIT: the spawn's bead lands during the create — first writer wins, loser CLOSED", async () => {
    // The interleaving the ordering hazard is actually about, driven rather than simulated after the
    // fact: `createBeadFull` is a `bd` shell-out against a single-writer store under lock
    // contention, so the spawn's own bead can land INSIDE that await. The mock writes it there.
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const spawnBeadId = "bd-from-spawn";
    duringCreate = () => useProjectStore.getState().setAgentBeadId(projectId, agentId, spawnBeadId);

    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "Build the thing" },
      "building_saved",
      bs(1),
      false,
    );

    // FIRST WRITER WINS: the row keeps the spawn's id rather than being clobbered…
    expect(rowOf(projectId, agentId).beadId).toBe(spawnBeadId);
    // …and the bead the poll minted and lost with is CLOSED, not abandoned open under the epic.
    expect(beads.closeBead).toHaveBeenCalledWith(PROJECT_PATH, nextFullId);
  });

  it("THE RACE LOST MID-AWAIT: the closed loser costs the epic NOTHING in the goal rollup", async () => {
    // The assertion the previous version of this test was missing. `agentsForEpicSlices` alone
    // cannot see this: an unreferenced OPEN child of the epic is carried by no agent, so
    // `rollUpEpicGoal` calls that slice `stranded` the moment any sibling moves off `open`, and
    // `readyToClose` can never be true for the epic again. Closed, it reads `done` instead.
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const spawnBeadId = "bd-from-spawn";
    duringCreate = () => useProjectStore.getState().setAgentBeadId(projectId, agentId, spawnBeadId);
    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "Build the thing" },
      "building_saved",
      bs(1),
      false,
    );

    // The epic's children as bd would report them AFTER the close the poll performed: the spawn's
    // bead (carried by the agent) and the raced-out one, whose status follows the `closeBead` call
    // rather than being asserted into place.
    const closed = vi.mocked(beads.closeBead).mock.calls.some((c) => c[1] === nextFullId);
    const children: RollupBead[] = [
      { id: spawnBeadId, title: "Build the thing", status: "in_progress" },
      { id: nextFullId, title: "Build the thing", status: closed ? "closed" : "open" },
    ];
    const roster = [rowOf(projectId, agentId)];
    const staffing = agentsForEpicSlices(roster, [
      epicBead,
      { ...blankBead(spawnBeadId), parent: EPIC_ID },
      { ...blankBead(nextFullId), parent: EPIC_ID },
    ], EPIC_ID);
    const rollup = rollUpEpicGoal(
      children,
      staffing.map((a) => ({ id: a.id, beadId: a.beadId, epicId: a.epicId, sliceIds: a.sliceIds })),
      Date.now(),
    );

    expect(rollup.stranded).toBe(0);
    expect(rollup.slices.find((s) => s.beadId === nextFullId)!.state).toBe("done");
    // And the epic can still reach "everything done" — the property the stranded orphan destroyed.
    expect(rollup.done).toBe(1);
    expect(rollup.slices).toHaveLength(2);
  });

  it("RE-READ BEFORE THE CREATE: a bead bound since the projection was captured is ADOPTED, not duplicated", async () => {
    // `agent.beadId` is captured at the top of the tick; the spawn's `.then()` can land right after.
    // Without the live re-read this branch mints a second bead for an agent that already has one.
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    useProjectStore.getState().setAgentBeadId(projectId, agentId, "bd-from-spawn");

    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      // The STALE projection — no beadId, exactly what the poll was holding.
      { id: agentId, kind: "build", name: "Build the thing" },
      "building_saved",
      bs(1),
      false,
    );

    expect(fullCalls).toHaveLength(0);
    expect(beads.createBead).not.toHaveBeenCalled();
    expect(rowOf(projectId, agentId).beadId).toBe("bd-from-spawn");
    // …and the lifecycle carried on against the adopted bead rather than bailing.
    expect(beads.claimBead).toHaveBeenCalledWith(PROJECT_PATH, "bd-from-spawn");
  });

  it("StoreBusy RETRIES next poll — bd was never spawned, so nothing was written", async () => {
    // The REAL contention shape, quoted from beads_cmd.rs `queue_saturated`. bd never started, so
    // no bead exists and retrying is both safe and necessary — latching it would deny an epic-bound
    // agent a bead for the session and reproduce the very symptom this change removes.
    fullThrows = new Error(
      "bd was not started within 30s — the bd concurrency limit stayed saturated (the store is " +
        "contended), so nothing was run and nothing was written; retrying in a moment is safe",
    );
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(2); // retried — NOT latched
    expect(rowOf(projectId, agentId).beadId).toBe(nextFullId);
  });

  it("A bd TIMEOUT is write-AMBIGUOUS and LATCHES — a retry would mint a second epic child", async () => {
    // Quoted from beads_cmd.rs: the child is killed at its budget, so notes.rs says whether the
    // write landed is UNKNOWN and `bd create` is not idempotent. `bead_dup.rs` skips the fold for
    // AUTO_LABEL by construction, so a retry cannot be absorbed — it mints a SECOND bead, parented
    // to the epic, referenced by nothing. Retrying this shape is how the poll would accrete one
    // permanently-stranding epic child every 5s under exactly the contention this change cites.
    fullThrows = new Error("bd did not finish within 30s and was terminated");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1);
    fullThrows = null; // even with bd healthy again, the ambiguous attempt must not be repeated
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1); // latched — no second create
    expect(rowOf(projectId, agentId).beadId).toBeUndefined();
  });

  it("THE SPAWN LANDS LAST: our bound bead is clobbered, and the NEXT tick closes it", async () => {
    // The mirror of RE-READ #2, and the ordering the previous commit left unguarded: our create
    // resolves FIRST, we bind our id, and the spawn's fire-and-forget `.then()` clobbers it a beat
    // later. `setAgentBeadId` overwrites unconditionally, so our bead becomes an unreferenced OPEN
    // CHILD of the epic — stranded forever unless something notices.
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    const ourBead = nextFullId;
    expect(rowOf(projectId, agentId).beadId).toBe(ourBead);

    // …the spawn's promise resolves AFTER ours and clobbers the row.
    const spawnBeadId = "bd-from-spawn";
    useProjectStore.getState().setAgentBeadId(projectId, agentId, spawnBeadId);
    expect(beads.closeBead).not.toHaveBeenCalledWith(PROJECT_PATH, ourBead); // not yet — no tick

    // Next poll tick: the reconcile notices the row no longer holds what we wrote, and closes it.
    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { ...agent, beadId: spawnBeadId },
      "building_saved",
      bs(1),
      false,
    );
    expect(beads.closeBead).toHaveBeenCalledWith(PROJECT_PATH, ourBead);

    // …and the epic is whole: the closed loser reads `done`, so nothing is stranded.
    const closed = vi.mocked(beads.closeBead).mock.calls.some((c) => c[1] === ourBead);
    const rollup = rollUpEpicGoal(
      [
        { id: spawnBeadId, title: "Build the thing", status: "in_progress" },
        { id: ourBead, title: "Build the thing", status: closed ? "closed" : "open" },
      ] as RollupBead[],
      agentsForEpicSlices(
        [rowOf(projectId, agentId)],
        [epicBead, { ...blankBead(spawnBeadId), parent: EPIC_ID }, { ...blankBead(ourBead), parent: EPIC_ID }],
        EPIC_ID,
      ).map((a) => ({ id: a.id, beadId: a.beadId, epicId: a.epicId, sliceIds: a.sliceIds })),
      Date.now(),
    );
    expect(rollup.stranded).toBe(0);
    expect(rollup.slices.find((s) => s.beadId === ourBead)!.state).toBe("done");
  });

  it("the reconcile tries ONCE — a failing close does not re-issue a bd write every poll", async () => {
    vi.mocked(beads.closeBead).mockRejectedValue(new Error("bd offline"));
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    useProjectStore.getState().setAgentBeadId(projectId, agentId, "bd-from-spawn");
    const next = { ...agent, beadId: "bd-from-spawn" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, next, "building_saved", bs(1), false);
    const after1 = vi.mocked(beads.closeBead).mock.calls.length;
    await syncBeadLifecycle(projectId, PROJECT_PATH, next, "building_saved", bs(1), false);
    expect(vi.mocked(beads.closeBead).mock.calls.length).toBe(after1); // not retried
  });

  it("PAIRED NEGATIVE: an agent with NO epicId still mints a TOP-LEVEL bead, unchanged", async () => {
    vi.mocked(beads.createBead).mockResolvedValue("bd-flat-0");
    const [projectId, agentId] = projectWithAgent(undefined);

    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "Unbound build" },
      "building_saved",
      bs(1),
      false,
    );

    // The parentless wrapper, exactly as before — nothing was invented to parent it to.
    expect(fullCalls).toHaveLength(0);
    expect(beads.createBead).toHaveBeenCalledTimes(1);
    const snapshot = beadsAsBdWouldReturn();
    expect(snapshot.find((b) => b.id === "bd-flat-0")?.parent).toBeUndefined();
    // …and it is NOT attributed to the epic, which is the correct reading of "bound to nothing".
    const roster = [rowOf(projectId, agentId)];
    expect(agentsForEpicSlices(roster, snapshot, EPIC_ID).map((a) => a.id)).not.toContain(agentId);
    expect(childrenOf(snapshot, EPIC_ID)).toHaveLength(0);
  });

  it("A STALE BOARD READ DECIDES NOTHING — a snapshot from BEFORE the create cannot prove absence", async () => {
    // THE REGRESSION THIS PINS (roborev High on 013316699): the lookup accepted ANY snapshot. A
    // board read that predates the write finds 0 candidates, and reading that as "nothing landed"
    // drops the pending entry and latches — leaving the bead bd really did commit as an OPEN CHILD
    // of the epic bound to no agent, which `rollUpEpicGoal` reports `stranded` forever. Nothing
    // heals it afterwards: the pending record is gone and no `setAgentBeadId` writer binds an
    // orphan. And stale is the COMMON case here, not the exotic one — the beads poll runs on its
    // own cadence and `refresh` keeps the previous snapshot on failure, so under exactly the lock
    // contention that made this create time out the surviving snapshot can be minutes old.
    fullThrows = new Error(
      "bd did not finish within 30s and was terminated — bd itself finished successfully; what " +
        "was lost is its reply, not the write, so the change most likely LANDED.",
    );
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1);

    // A board WITHOUT the bead, read BEFORE the create. The absence here is meaningless.
    seedBoard(projectId, [epicBead], Date.now() - 600_000);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);

    // NOT re-created — that would mint the second epic child.
    expect(rowOf(projectId, agentId).beadId).toBeUndefined();
    expect(fullCalls).toHaveLength(1);

    // ── THE DISCRIMINATOR ────────────────────────────────────────────────────────────────────
    // The two assertions above CANNOT tell "undecided" from "latched": both leave `beadId` unset
    // and `fullCalls` at 1, so on their own this test passes with the freshness gate deleted
    // (measured — the mutant stayed green). What separates them is only observable LATER: a
    // latched agent has dropped its pending record and can never adopt, while an undecided one
    // still can. So drive the next poll, where the board — now read AFTER the create — shows the
    // bead bd really did commit.
    seedBoard(projectId, [epicBead, committedAutoBead("bd-landed", "Build the thing")], Date.now());
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);

    // ADOPTED. Without the gate the stale tick would have latched, this adoption would never
    // happen, and the committed bead would be a permanently stranded child of the epic.
    expect(rowOf(projectId, agentId).beadId).toBe("bd-landed");
    expect(fullCalls).toHaveLength(1);
  });

  it("A READ THAT STRADDLED THE CREATE DECIDES NOTHING — a fresh STAMP over stale CONTENTS", async () => {
    // THE REGRESSION THIS PINS (roborev High on 34174f08d): the first freshness gate compared
    // against `beadsPolledAt`, which stamps when the read FINISHED. A `bd list` already in flight
    // when bd committed our bead reads the store at its own start and commits afterwards, so the
    // stamp is NEWER than the create while the contents are OLDER. The gate passed, 0 candidates
    // were found, and the agent latched over a committed epic child — the same permanent stranding,
    // merely narrowed to the straddling read. And that straddle is the COMMON shape: the slow
    // create and the slow read have one cause, a single Dolt lock.
    fullThrows = new Error(
      "bd did not finish within 30s and was terminated — bd itself finished successfully; what " +
        "was lost is its reply, not the write, so the change most likely LANDED.",
    );
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1);

    // The straddle: contents WITHOUT the bead, read starting well before the create, committed
    // after it. `beadsPolledAt` would say fresh; `beadsReadStartedAt` says the data is older.
    const createdAround = Date.now();
    seedBoard(projectId, [epicBead], createdAround + 5_000, createdAround - 25_000);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1); // not re-created

    // THE DISCRIMINATOR, as in the sibling test: latched and undecided look identical here, and
    // only a later adoption can tell them apart. A read that genuinely STARTED after the create
    // now shows the bead, and it must still be adoptable.
    seedBoard(
      projectId,
      [epicBead, committedAutoBead("bd-landed", "Build the thing")],
      Date.now() + 60_000,
      Date.now() + 60_000,
    );
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(rowOf(projectId, agentId).beadId).toBe("bd-landed");
    expect(fullCalls).toHaveLength(1);
  });

  it("AMBIGUOUS CREATE, bead DID land: the next tick ADOPTS it instead of stranding it", async () => {
    // The drain path — notes.rs: "bd itself finished successfully; what was lost is its reply, not
    // the write, so the change most likely LANDED". Latching here leaves a committed OPEN CHILD of
    // the epic bound to no agent, which is a permanent `stranded` slice. So we go and look.
    fullThrows = new Error(
      "bd did not finish within 30s and was terminated — bd itself finished successfully; what " +
        "was lost is its reply, not the write, so the change most likely LANDED.",
    );
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1);
    expect(rowOf(projectId, agentId).beadId).toBeUndefined(); // not bound yet — undecided

    // The board poll now shows the bead bd really did commit.
    seedBoard(projectId, [epicBead, committedAutoBead("bd-landed", "Build the thing")]);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);

    expect(rowOf(projectId, agentId).beadId).toBe("bd-landed"); // ADOPTED
    expect(fullCalls).toHaveLength(1); // and NOT re-created — that would be the second epic child
    // The adopted bead is carried, so the epic has no stranded slice.
    const rollup = rollUpEpicGoal(
      [{ id: "bd-landed", title: "Build the thing", status: "open" }] as RollupBead[],
      agentsForEpicSlices(
        [rowOf(projectId, agentId)],
        [epicBead, committedAutoBead("bd-landed", "Build the thing")],
        EPIC_ID,
      ).map((a) => ({ id: a.id, beadId: a.beadId, epicId: a.epicId, sliceIds: a.sliceIds })),
      Date.now(),
    );
    expect(rollup.stranded).toBe(0);
  });

  it("AMBIGUOUS CREATE, nothing landed: the lookup finds none, so it latches exactly as before", async () => {
    fullThrows = new Error("bd did not finish within 30s and was terminated");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    seedBoard(projectId, [epicBead]); // board read: the bead is simply not there
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(rowOf(projectId, agentId).beadId).toBeUndefined();
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1); // latched — never re-issued
  });

  it("AMBIGUOUS CREATE, NO SNAPSHOT YET: absence of data must not be read as 'nothing landed'", async () => {
    // The one branch where reading an empty store as evidence re-creates the bug: it would latch
    // over a bead that has landed and simply not been polled yet.
    fullThrows = new Error("bd did not finish within 30s and was terminated");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    seedBoard(projectId, undefined); // never read
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1); // still undecided — no re-create…

    // …and once the snapshot arrives showing the bead, it is adopted rather than lost.
    seedBoard(projectId, [epicBead, committedAutoBead("bd-late", "Build the thing")]);
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(rowOf(projectId, agentId).beadId).toBe("bd-late");
  });

  it("AMBIGUOUS CREATE, two candidates: refuses to guess rather than bind another agent's work", async () => {
    fullThrows = new Error("bd did not finish within 30s and was terminated");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    seedBoard(projectId, [
      epicBead,
      committedAutoBead("bd-a", "Build the thing"),
      committedAutoBead("bd-b", "Build the thing"),
    ]);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(rowOf(projectId, agentId).beadId).toBeUndefined(); // no guess
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(fullCalls).toHaveLength(1); // latched, not re-created
  });

  it("a bead already bound to ANOTHER agent is never adopted", async () => {
    fullThrows = new Error("bd did not finish within 30s and was terminated");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const other = useProjectStore.getState().addAgent(projectId)!;
    useProjectStore.getState().setAgentBeadId(projectId, other, "bd-taken");
    const agent = { id: agentId, kind: "build", name: "Build the thing" };
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    seedBoard(projectId, [epicBead, committedAutoBead("bd-taken", "Build the thing")]);
    fullThrows = null;
    await syncBeadLifecycle(projectId, PROJECT_PATH, agent, "building_saved", bs(1), false);
    expect(rowOf(projectId, agentId).beadId).toBeUndefined();
    expect(rowOf(projectId, other).beadId).toBe("bd-taken"); // untouched
  });

  it("a project with no beads DB still latches project-wide from the parented path", async () => {
    // The one throw that must keep propagating: otherwise the per-project latch never arms and
    // every deliverable agent re-shells `bd` every poll for a project that does not use beads.
    fullThrows = new Error("no beads database found");
    const [projectId, agentId] = projectWithAgent(EPIC_ID);
    const other = useProjectStore.getState().addAgent(projectId)!;
    useProjectStore.getState().setAgentEpicId(projectId, other, EPIC_ID);

    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: agentId, kind: "build", name: "A" },
      "building_saved",
      bs(1),
      false,
    );
    expect(fullCalls).toHaveLength(1);
    await syncBeadLifecycle(
      projectId,
      PROJECT_PATH,
      { id: other, kind: "build", name: "B" },
      "building_saved",
      bs(1),
      false,
    );
    expect(fullCalls).toHaveLength(1); // project latched before any second shell-out
  });
});
