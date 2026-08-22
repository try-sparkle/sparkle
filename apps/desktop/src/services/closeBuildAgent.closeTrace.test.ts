// PER-SITE LEAK COVERAGE — `closeBuildAgent` (bead sparkle-bxidpw).
//
// `projectStore.removeAgent` opens a `close:<id>` perf trace, and only a mounted `AgentPane`'s
// unmount cleanup can ever end one. Panes mount LAZILY per project, so a row removed without a pane
// used to leak the entry for the life of the process — after which `openTraceKinds()` named that
// ghost as an in-flight interaction on EVERY subsequent jank stall line. Measured in a real session
// log as `"during":"close×37"` on every stall for hours, whatever the actual cause, while a
// user-visible freeze was being diagnosed.
//
// WHY THIS SITE GETS ITS OWN FILE RATHER THAN A CASE IN `closeBuildAgent.test.ts`. That suite mocks
// `../stores/projectStore` wholesale (`removeAgent` is a `vi.fn()`), so it can assert the teardown
// ORDER but can never observe what the real store does to the trace map — the exact thing under test
// here. Mocking the store would be testing the stand-in.
//
// WHY A PER-SITE TEST AT ALL, when the fix is one shared gate in the store. AGENTS.md's
// `sparkle-50m03`: a fix landing at N call sites reads as verified the moment ANY ONE of them is
// covered, and a site that later grows its own `perfStart` — or stops routing through the store —
// regresses in silence. Each site therefore states its own contract.
//
// WHAT IS SPECIFIC TO THIS SITE: it `await`s `spinDownAgentGit` BEFORE `removeAgent`. So by the time
// the row is dropped, React has long since committed the unmount of any pane that existed, and this
// path leaked UNCONDITIONALLY rather than only for never-visited projects. It is also why gating
// costs nothing here — the pane's `perfEnd` ran against a trace that had not been started yet, so
// this site emitted no `close … (total)` waterfall even when a pane had been open. Pure leak.
//
// The mounted-pane counterpart — proving the waterfall still fires where it fires today — needs a
// real pane and a real unmount, and is owned by `components/AgentPane.closeTrace.test.tsx`.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Only the boundaries are mocked: the git teardown and the cloud sandbox DELETE. Both stores are
// REAL, which is the whole point of this file.
const spinDownAgentGit = vi.fn().mockResolvedValue(undefined);
vi.mock("./closeAgentActions", () => ({
  spinDownAgentGit: (...a: unknown[]) => spinDownAgentGit(...a),
}));
const deleteCloudSession = vi.fn().mockResolvedValue(undefined);
vi.mock("./agentTransport", () => ({ deleteCloudSession: (id: string) => deleteCloudSession(id) }));

import { closeBuildAgent } from "./closeBuildAgent";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { openTraceKinds } from "../perfTrace";

beforeEach(() => {
  vi.clearAllMocks();
  spinDownAgentGit.mockResolvedValue(undefined);
  deleteCloudSession.mockResolvedValue(undefined);
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {}, workflowStage: {} });
  useSettingsStore.setState({ deleteMergedBranch: false });
  // NOTE: no `__resetTracesForTest()`. That helper empties the very map whose residue is the defect,
  // so a beforeEach reset would mask a regression that re-introduced the leak (AGENTS.md). Nothing
  // in this file needs it: `perfStart` is keyed per agent id and the assertion names `close`.
});

describe("closeBuildAgent leaves no phantom close: trace behind", () => {
  it("leaves NO open close entry when the build agent's pane was never mounted", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    // No pane is registered for this row — the normal case for a project the user has not opened
    // this session, and the exact condition under which this site used to leak.

    // `true` = the human confirmed, so the retirement gate is not what this test is measuring.
    const r = await closeBuildAgent(buildId, true);
    expect(r.ok).toBe(true);

    // The row really is gone — so any `close` entry still open is a ghost, not a live interaction.
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === buildId)).toBe(false);
    expect(spinDownAgentGit).toHaveBeenCalledTimes(1); // the real teardown path really did run

    // THE SIDE EFFECT: precisely what the jank monitor would print in its `during` field. Asserted
    // as `undefined` rather than "does not contain close" because on this path nothing else opens a
    // trace either — which also pins the shape the stall line embeds verbatim: never `""`, never
    // `"close×0"`.
    expect(openTraceKinds()).toBeUndefined();
  });

  it("leaves nothing behind for the WORKERS it cascades to either", async () => {
    // `removeAgent` cascades to a build agent's workers, and a fan-out orchestrator is the highest-
    // volume producer of never-mounted panes there is — so the cascade is where a per-agent leak
    // would multiply fastest.
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    for (let i = 0; i < 3; i++) {
      const w = store.addAgent(projectId, { kind: "worker", parentId: buildId, select: false })!;
      store.setAgentWorktree(projectId, w, `/wt/w${i}`, `sparkle/agent-w${i}`);
    }

    await closeBuildAgent(buildId, true);

    expect(useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents).toEqual([]);
    expect(openTraceKinds()).toBeUndefined();
  });
});
