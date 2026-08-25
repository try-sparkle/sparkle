// THE DELEGATION LEDGER'S WRITE SITE at the shared local-build spawn (services/dispatchLedger).
//
// On 2026-08-22 the concierge answered a question about preview-card work as if it had never heard
// of it — eight minutes after spawning an agent to do exactly that. Nothing durable recorded the ACT
// of delegating. These tests pin the row that closes that hole, and they assert the SIDE EFFECT —
// a `source: "dispatch"` history row carrying this agent's id, channel and brief — never a
// precondition like "the agent exists".
//
// ── THE PAIRED SHAPE, AND WHY IT IS NOT OPTIONAL ────────────────────────────────────────────────
// `spawnBuildAgentInProject` has FOUR refusals ABOVE `addAgent` (capacity, torn-out, not-visited,
// and the attention hold), and each returns null with nothing created. A row written for one of them
// would be a FALSE POSITIVE on "did we ever do that work" — the founder told work was under way that
// nobody is doing. But a test that only proves ABSENCE is ambiguous: it passes just as well against
// a build where the `recordDispatch` call was deleted outright, which is the exact failure the
// ledger exists to prevent. So every absence case below is paired with a test showing the IDENTICAL
// setup DOES write the row once the refusal no longer applies.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HistoryEntry } from "./history";

const recordHistoryMock = vi.fn(async (_e: HistoryEntry) => ({ inserted: true, collided: false }));

// Mocked at `./history` rather than at `./dispatchLedger`: the row's TEXT is what the recall path
// searches, so the assertions below run through the real `formatDispatchText`. Stubbing the ledger
// itself would leave the one thing a reader has to match on — the words in the row — untested.
vi.mock("./history", () => ({
  recordHistory: (e: HistoryEntry) => recordHistoryMock(e),
}));
vi.mock("./tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { markProjectVisited, resetVisitedProjects } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import type { Project } from "../types";

function project(name = "Demo", root = "/tmp/demo"): Project {
  const id = useProjectStore.getState().addProject(name, root);
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

/** Every delegation row written so far. Narrowed by `source`, because the store's own writes (prompt
 *  capture, and anything a future step adds) share this seam — a bare call count would pass on a
 *  build that wrote the wrong kind of row entirely. */
function dispatchRows(): HistoryEntry[] {
  return recordHistoryMock.mock.calls.map((c) => c[0]).filter((e) => e.source === "dispatch");
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  resetVisitedProjects();
  recordHistoryMock.mockClear();
});

describe("spawnBuildAgentInProject writes the delegation to the ledger", () => {
  it("records the agent id, the channel and the brief the agent was actually given", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { prompt: "make preview cards inline in chat" });

    expect(id).toBeTruthy();
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // THE HANDLE. `agentId` is the only field still true after a rename or a restart, and it is what
    // dispatchRecall joins live state on.
    expect(row.agentId).toBe(id);
    expect(row.projectId).toBe(p.id);
    // …and the SUBJECT, in the indexed text. The founder asks about "the inline preview work", never
    // about an agent id, so a row whose text lost the brief is a row recall cannot find.
    expect(row.text).toContain("make preview cards inline in chat");
    expect(row.text).toContain("channel build");
  });

  it("records a spawn with NO brief too — 'we opened an empty agent for that' is still an answer", () => {
    // The "+ New Build Agent" button's shape. A ledger that skipped it would answer "we never
    // started on that" about an agent that exists, which is the false negative the whole feature
    // exists to remove.
    const p = project();

    const id = spawnBuildAgentInProject(p);

    expect(id).toBeTruthy();
    expect(dispatchRows().map((r) => r.agentId)).toEqual([id]);
  });

  it("attributes an ordinary spawn to the human and a background one to the machine", () => {
    const p = project();
    markProjectVisited(p.id); // background refuses a project that is not on screen

    const human = spawnBuildAgentInProject(p, { prompt: "by hand" });
    const machine = spawnBuildAgentInProject(p, { prompt: "on a timer", background: true });

    const byTarget = new Map(dispatchRows().map((r) => [r.agentId, r.text]));
    expect(byTarget.get(human!)).toContain("by human");
    // The babysit dispatcher's shape: nobody asked, so the row must not read as a person's gesture.
    expect(byTarget.get(machine!)).toContain("by machine");
  });

  it("lets a caller that knows better override the derivation — the concierge's case", () => {
    // The derivation's one blind spot, and the one the incident was about: a concierge spawn is
    // neither background nor a hand on a control, so without this it is recorded as a button press
    // and the concierge cannot tell its OWN dispatches from the founder's.
    const p = project();

    const id = spawnBuildAgentInProject(p, {
      prompt: "look into the preview cards",
      dispatchedBy: "concierge",
      ask: "can we make the preview cards inline?",
    });

    const row = dispatchRows().find((r) => r.agentId === id)!;
    expect(row.text).toContain("by concierge");
    // The ASK is the founder's own words, kept separately from the brief the agent was handed —
    // they diverge every time the concierge expands a half-sentence into a mission.
    expect(row.text).toContain("ASK: can we make the preview cards inline?");
  });

  it("carries the epic id as the bead the delegation serves", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { prompt: "slice 3", epicId: "sparkle-abc123" });

    expect(dispatchRows().find((r) => r.agentId === id)!.text).toContain("BEADS: sparkle-abc123");
  });
});

describe("a REFUSED spawn writes no row — paired with the same setup succeeding", () => {
  it("background into a project the human has not looked at: NO row", () => {
    const p = project();
    // Deliberately NOT visited. `spawnBuildAgentInProject` refuses before `addAgent`, so no agent
    // exists — and a ledger row here would name one that never will.
    expect(spawnBuildAgentInProject(p, { prompt: "on a timer", background: true })).toBeNull();
    expect(dispatchRows()).toEqual([]);
  });

  it("…and the IDENTICAL call DOES write one once that project is on screen", () => {
    // The other half of the pair. Without it, the test above passes against a build with no
    // `recordDispatch` call at all.
    const p = project();
    markProjectVisited(p.id);

    const id = spawnBuildAgentInProject(p, { prompt: "on a timer", background: true });

    expect(id).toBeTruthy();
    expect(dispatchRows().map((r) => r.agentId)).toEqual([id]);
  });

  it("at the machine-wide ceiling: NO row, though the spawns that filled it each wrote one", () => {
    const p = project();
    for (let i = 0; i < 3; i++) expect(spawnBuildAgentInProject(p)).toBeTruthy();
    expect(dispatchRows()).toHaveLength(3); // the fills are themselves delegations
    recordHistoryMock.mockClear();

    expect(spawnBuildAgentInProject(p, { prompt: "one too many" })).toBeNull();

    expect(dispatchRows()).toEqual([]);
  });
});
