// @vitest-environment jsdom
//
// THE EPIC PARAMETER ON THE CONCIERGE'S OWN SPAWN — bead sparkle-o05vcs.1.
//
// The seam already existed: `services/buildAgentSpawn` writes BOTH halves of epic membership when a
// caller hands it an `epicId` (bead sparkle-f2tzxg). What was missing was a way for the CONCIERGE to
// say the epic — `SpawnBuildAgentInput` had no field and `registry.ts` forwarded none. So every agent
// the founder started from chat was minted with a parentless auto-bead and no row `epicId`, which is
// exactly the input `epicLadder.agentsForEpicSlices` answers `[]` for; `engine/epicHealth([])` is
// `gray` BY DEFINITION and `rungForEpicHealth('gray')` is `unstaffed`. The audit that opened this
// bead — 6 of 67 epics with a build agent bound, "Build: Active 1" — was that missing argument, not a
// display bug.
//
// ── WHY THESE TESTS GO THROUGH `dispatchConciergeTool` AND ASSERT THROUGH `agentsForEpicSlices` ────
// Two decisions, and each closes a way this could have shipped green and dead:
//
//   1. THE ENTRY POINT IS THE WIRE, not `spawnBuildAgent(...)` called directly. `spawnArgs` in
//      registry.ts is `.strict()`, so an `epicId` the schema does not declare is refused as
//      `bad-args` before the domain ever runs — a test that called the domain function directly would
//      pass with the schema half of this change missing, and the concierge could never send the field.
//   2. THE ASSERTION IS THE SIDE EFFECT, not a mock's arguments. "createBeadFull was called with the
//      epic id" proves an argument moved; it does not prove the resulting graph is one the Epics
//      column can read, and the second is the claim the bead is about. So each test drives the real
//      dispatch, reads the real row back out of the real projectStore, builds the bead snapshot from
//      exactly the arguments the spawn handed `bd`, and asks the REAL membership query whether the
//      epic is staffed. Nothing here re-derives epic membership
//      (scripts/lib/epic-membership-guard.sh) — `agentsForEpicSlices` is composed, not copied.
//
// Modelled on services/buildAgentSpawn.epic.test.ts, which owns the seam; this file owns the caller.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

/** Every `createBeadFull` call, positionally, so the 5th argument — `parent` — can be read back.
 *  bd is not available in a unit test and the spawn's `bd create` is best-effort anyway. */
let beadCalls: unknown[][] = [];
const NEXT_BEAD_ID = "bd-auto-1";
vi.mock("../tasks", () => ({
  createBeadFull: async (...a: unknown[]) => {
    beadCalls.push(a);
    return NEXT_BEAD_ID;
  },
}));
vi.mock("../landInAgent", () => ({ landInAgent: () => {} }));

const { dispatchConciergeTool } = await import("./registry");
const { useProjectStore } = await import("../../stores/projectStore");
const { useRuntimeStore } = await import("../../stores/runtimeStore");
const { useSettingsStore } = await import("../../stores/settingsStore");
const { agentsForEpicSlices } = await import("../epicLadder");
const { resetVisitedProjects } = await import("../sessionProjects");
type Bead = import("../beads").Bead;

const EPIC_ID = "sparkle-epic1";
const TOOL_CALL_ID = "tc-spawn-epic-1";

/** The bead snapshot the Plan board would poll, built from what the spawn actually told `bd`.
 *  Deliberately DERIVED from `beadCalls` rather than hand-written: a fixture hardcoding
 *  `parent: EPIC_ID` would go on passing after the forward stopped sending it, which is the vacuous
 *  shape this repo's contract calls its #1 finding. */
function beadsAsBdWouldReturn(): Bead[] {
  const epic: Bead = {
    id: EPIC_ID,
    title: "The epic",
    description: "",
    status: "open",
    type: "epic",
    labels: [],
  };
  const minted: Bead[] = beadCalls.map((call, i) => ({
    id: i === beadCalls.length - 1 ? NEXT_BEAD_ID : `bd-auto-${i}`,
    title: String(call[1]),
    description: String(call[2]),
    status: "open",
    type: String(call[3]),
    labels: String(call[6]).split(",").filter(Boolean),
    // EXACTLY what the spawn passed — `""` included, normalized to absent the way bd itself
    // reports a parentless bead.
    ...((call[4] as string) ? { parent: call[4] as string } : {}),
  }));
  return [epic, ...minted];
}

/** Dispatch a spawn over the concierge wire and return the new agent's id. No `prompt` is passed:
 *  a briefed spawn WAITS for a mounting pane to report the launch (agentBrief), and the brief is not
 *  this file's subject — the epic binding is written synchronously, before any of that. */
async function spawnOverTheWire(args: Record<string, unknown>): Promise<string> {
  const r = await dispatchConciergeTool({
    domain: "lifecycle",
    op: "spawn_build_agent",
    args,
    toolCallId: TOOL_CALL_ID,
  });
  if (!r.ok) throw new Error(`spawn refused: ${r.code} — ${r.message}`);
  return (r.data as { agentId: string }).agentId;
}

function agentRow(projectId: string, agentId: string) {
  const row = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  if (!row) throw new Error(`no agent row ${agentId}`);
  return row;
}

/** The roster the Epics column would hold: the spawn's own `.then` binds the minted bead, so do
 *  that here too rather than asserting against a row the board would never see. */
function rosterWithBeadBound(projectId: string, agentId: string) {
  useProjectStore.getState().setAgentBeadId(projectId, agentId, NEXT_BEAD_ID);
  return useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
}

let projectId = "";

beforeEach(() => {
  vi.clearAllMocks();
  beadCalls = [];
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    attentionScreen: {},
  } as never);
  useSettingsStore.setState({
    maxConcurrentWorkers: 8,
    effectiveMaxConcurrentWorkers: 8,
    machineMaxConcurrentWorkers: 8,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 8 cores × 2 agents per core",
  } as never);
  // Module state, and half the pane-mount gate — a project marked visited by another test would
  // otherwise decide this one's spawn.
  resetVisitedProjects();
  projectId = useProjectStore.getState().addProject("Demo", "/tmp/demo");
});

describe("concierge spawn_build_agent: an agent started AGAINST AN EPIC staffs it", () => {
  it("carries epicId across the registry and writes BOTH halves of membership", async () => {
    const agentId = await spawnOverTheWire({ projectId, epicId: EPIC_ID });

    // The row half — readable immediately, before `bd` has answered. This is what the sidebar epic
    // pill and `epicLadder.epicIdForAgent` read.
    expect(agentRow(projectId, agentId).epicId).toBe(EPIC_ID);
    // The bead half — the durable edge, and the one that outlives the tab. `createBeadFull` is
    // fire-and-forget inside the spawn, so let its microtask land before reading the calls.
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    expect(beadCalls[0]![4]).toBe(EPIC_ID);
  });

  it("…so agentsForEpicSlices reports the epic STAFFED — the thing the column reads", async () => {
    // THE SIDE EFFECT THE BEAD IS ABOUT. `engine/epicHealth` is fed exactly this list, and `[]` is
    // `gray`/`unstaffed` by definition — which is why an assertion on the forwarded argument alone
    // would not have caught the state that shipped.
    const agentId = await spawnOverTheWire({ projectId, epicId: EPIC_ID });
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));

    const staffing = agentsForEpicSlices(
      rosterWithBeadBound(projectId, agentId),
      beadsAsBdWouldReturn(),
      EPIC_ID,
    );

    expect(staffing.map((a) => a.id)).toContain(agentId);
  });

  it("refuses an EMPTY epicId as bad-args rather than binding the agent to nothing", async () => {
    // `""` is the value that reads as "an epic" to every `if (opts.epicId)` downstream while binding
    // nothing — the parentless-bead state this argument exists to end, reached through its own field.
    const r = await dispatchConciergeTool({
      domain: "lifecycle",
      op: "spawn_build_agent",
      args: { projectId, epicId: "" },
      toolCallId: TOOL_CALL_ID,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("epicId");
    // And nothing was created: the schema gate runs before the domain.
    expect(useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents).toEqual([]);
  });
});

describe("concierge spawn_build_agent: NO epic is a normal, supported state", () => {
  // THE PAIRED TESTS. One test proving linkage is ambiguous on its own — a spawn that stamped every
  // agent with some epic would pass it. These pin that the epic is written ONLY when the caller
  // supplied one, so the ordinary "start me an agent" keeps producing a standalone agent.
  it("mints a PARENTLESS bead and leaves epicId unset — exactly as before", async () => {
    const agentId = await spawnOverTheWire({ projectId });

    expect(agentRow(projectId, agentId).epicId).toBeUndefined();
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    expect(beadCalls[0]![4]).toBe("");
  });

  it("and that agent staffs NO epic", async () => {
    const agentId = await spawnOverTheWire({ projectId });
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));

    expect(
      agentsForEpicSlices(
        rosterWithBeadBound(projectId, agentId),
        beadsAsBdWouldReturn(),
        EPIC_ID,
      ),
    ).toEqual([]);
  });
});
