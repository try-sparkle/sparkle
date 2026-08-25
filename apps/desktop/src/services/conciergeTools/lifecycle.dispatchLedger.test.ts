// THE DELEGATION LEDGER at the concierge's two spawn tools (services/dispatchLedger).
//
// The 2026-08-22 failure was the concierge unable to recall its OWN dispatches, so the fact these
// tests exist to protect is provenance: a row that cannot say "I did this" cannot answer the
// question that caused the feature. Two halves, and they are structurally different:
//
//   • LOCAL — `spawn_build_agent` goes through `spawnBuildAgentInProject`, which writes the row.
//     This layer contributes exactly one fact (`dispatchedBy: "concierge"`) and must NOT write a
//     second row of its own; two rows for one spawn would double-count the delegation.
//   • CLOUD — `spawn_cloud_build_agent` never touches that helper at all, so it has its own write
//     site. Without it, "start it in the cloud" would be the one phrasing that makes a dispatch
//     unrememberable.
//
// `../buildAgentSpawn` is left REAL on the local half deliberately. Mocking it would let this file
// assert that an option was PASSED while the row it is supposed to produce went unwritten — the
// "defaulted seam every test injects" shape AGENTS.md names, on the exact seam under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../history";

const recordHistoryMock = vi.fn(async (_e: HistoryEntry) => ({ inserted: true, collided: false }));
// Mocked at `./history`, not at the ledger: the row's TEXT is what a recall query matches, so the
// assertions below run through the real `formatDispatchText`.
vi.mock("../history", () => ({
  recordHistory: (e: HistoryEntry) => recordHistoryMock(e),
}));

vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));
vi.mock("../closeAgentActions", () => ({
  shipAgent: vi.fn(),
  saveAgent: vi.fn(),
  discardAgentGit: vi.fn(),
  spinDownAgentGit: vi.fn(),
}));
vi.mock("../cloudAgents/terminate", () => ({ terminateIfCloud: vi.fn(async () => {}) }));

// The repo probe shells out to `gh` via Tauri — stubbed, exactly as lifecycle.cloudSpawn.test.ts
// stubs it.
const projectRepoUrl = vi.fn(
  async (_root: string): Promise<string | null> => "https://github.com/acme/demo",
);
vi.mock("../cloudAgents/repoUrl", () => ({ projectRepoUrl: (r: string) => projectRepoUrl(r) }));

const startSession = vi.fn(async (_i: unknown) => ({ sessionId: "sess-1" }));
const listProjects = vi.fn(
  async () => [] as Array<{ id: string; name: string; chiefProjectId?: string | null }>,
);
const createProject = vi.fn(async (name: string, _chiefProjectId?: string) => ({
  id: "cloud-p1",
  name,
}));
const getClaudeAuth = vi.fn(async () => ({ method: "byok" as const }));
vi.mock("../cloudAgents/api", () => ({
  cloudApi: {
    startSession: (i: unknown) => startSession(i),
    listProjects: () => listProjects(),
    createProject: (n: string, c?: string) => createProject(n, c),
    getClaudeAuth: () => getClaudeAuth(),
  },
}));

import { spawnBuildAgent } from "./lifecycle";
import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { resetVisitedProjects } from "../sessionProjects";
import type { Project } from "../../types";

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: "main",
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null,
  agents: [],
};

/** Everything the cloud gate needs, all green — the cloud tests turn exactly one thing off. */
function signedInAndFunded() {
  useAuthStore.setState({
    tokenPresent: true,
    me: { cloudAgentsEnabled: true, entitled: true, balanceCents: 5_000 },
    refresh: vi.fn(async () => {}),
  } as never);
  useCloudAuthStore.setState({ method: "byok", loaded: true } as never);
}

function dispatchRows(): HistoryEntry[] {
  return recordHistoryMock.mock.calls.map((c) => c[0]).filter((e) => e.source === "dispatch");
}

beforeEach(() => {
  vi.clearAllMocks();
  projectRepoUrl.mockResolvedValue("https://github.com/acme/demo");
  startSession.mockResolvedValue({ sessionId: "sess-1" });
  listProjects.mockResolvedValue([]);
  useProjectStore.setState({
    projects: [structuredClone(project)],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 8,
    effectiveMaxConcurrentWorkers: 8,
    machineMaxConcurrentWorkers: 8,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  } as never);
  resetVisitedProjects();
  signedInAndFunded();
});

describe("spawn_build_agent (local) — provenance travels, and only ONE row is written", () => {
  it("records the delegation as the CONCIERGE's, not as a button press", async () => {
    // NO `prompt`, for the reason lifecycle.test.ts states at its own forwarding case: a BRIEFED
    // spawn makes this tool await brief delivery — a 45s wait with no pane mounted to confirm it,
    // which times the test out rather than telling you anything about the row. `name` rides the
    // same opts argument and the row is written on the unbriefed path too (an empty agent is a
    // real delegation: "we opened one for that project" is an answer to "did we ever start").
    const r = await spawnBuildAgent({ projectId: "p1", name: "Preview Cards" });

    expect(r.ok).toBe(true);
    const rows = dispatchRows();
    // ONE row. The shared helper writes it; this layer must not add a second, or the recall path
    // reports one delegation as two.
    expect(rows).toHaveLength(1);
    // Without the `dispatchedBy` forwarding this reads `by human` — a concierge spawn is neither
    // background nor a hand on a control, so it is indistinguishable from the sidebar button until
    // this layer says otherwise.
    expect(rows[0]!.text).toContain("by concierge");
    expect(rows[0]!.text).toContain("Preview Cards");
    expect(rows[0]!.text).toContain("channel build");
  });

  it("writes NO row when the spawn is refused for a blank brief — paired with the same call succeeding", () => {
    // Refused above `addAgent`: nothing was created, so a row would name an agent that will never
    // exist. The pair is the test above, which proves the write site is still there.
    return spawnBuildAgent({ projectId: "p1", prompt: "   \n\t " }).then((r) => {
      expect(r.ok).toBe(false);
      expect(dispatchRows()).toEqual([]);
    });
  });
});

describe("spawn_cloud_build_agent — its own write site, because it bypasses the shared helper", () => {
  it("records the server session id, the cloud channel and the goal", async () => {
    const r = await spawnBuildAgent({
      projectId: "p1",
      runtime: "cloud",
      prompt: "fix the flaky checkout test and open a PR",
      name: "Checkout Fix",
    });

    expect(r.ok).toBe(true);
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The tab id IS the server session id — one handle for the store, the relay and the ledger.
    expect(row.agentId).toBe("sess-1");
    expect(row.text).toContain("channel cloud-build");
    expect(row.text).toContain("by concierge");
    // The GOAL is the whole of what a cloud agent was told: the runner seeds Claude Code with it via
    // stdin as the sandbox comes up, so it is this row's brief.
    expect(row.text).toContain("fix the flaky checkout test and open a PR");
    expect(row.text).toContain("Checkout Fix");
  });

  it("writes NOTHING when the server never returns a session id", async () => {
    // No id, no row: `targetId` is the ledger's only durable handle, and a row that names no agent
    // asserts a delegation nobody can look up. The pair is the success case above.
    startSession.mockRejectedValueOnce(new Error("cloud is down"));

    const r = await spawnBuildAgent({ projectId: "p1", runtime: "cloud", prompt: "ship it" });

    expect(r.ok).toBe(false);
    expect(dispatchRows()).toEqual([]);
  });
});
