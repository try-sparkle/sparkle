/**
 * Regression cover for the two roborev-54750 findings on the closed-agent status sweep
 * (`AgentSidebar`'s probed/local batch split feeding `pollProjectStatus`).
 *
 * Both bugs live in the SEAM between the two batches, which is why neither the store's per-agent
 * tests nor the sidebar's render tests caught them: each batch is correct in isolation.
 *
 *  1. HIGH — the first-poll force must be PER-AGENT (`forcedOnce`), not one module-level boolean.
 *     A boolean is consumed by whichever batch runs first (the probed one), leaving the LOCAL batch
 *     to run unforced against a Rust fingerprint cache that is still warm — so every quiet closed
 *     agent answers `changed:false` and its `branchStatus` stays `undefined` forever.
 *  2. Medium — the sweep widened `applyWorkflowState`'s bead/consent side effects to rows nobody is
 *     watching. The local batch passes `driveLifecycle:false` so a closed build agent holding
 *     commits cannot silently shell out `bd create`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { AgentStatusInput, AgentStatusResult, WorkflowState } from "../services/branchStatus";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const projectAgentsStatus = vi.fn();
vi.mock("../services/branchStatus", () => ({
  agentBranchStatus: vi.fn(),
  agentWorkflowState: vi.fn(),
  projectAgentsStatus: (...a: unknown[]) => projectAgentsStatus(...a),
}));

// Spy the bd shell-outs (keep the rest of beads.ts real — the no-DB latch reads its pure helpers).
const createBead = vi.fn();
const claimBead = vi.fn();
const closeBead = vi.fn();
vi.mock("../services/beads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/beads")>()),
  createBead: (...a: unknown[]) => createBead(...a),
  claimBead: (...a: unknown[]) => claimBead(...a),
  closeBead: (...a: unknown[]) => closeBead(...a),
}));

vi.mock("../services/chiefSync", () => ({
  syncProjectMarkdown: vi.fn(),
  MARKDOWN_DIRS: ["PRD", "docs/superpowers/specs"],
}));

const bs = (ahead: number) => ({
  ahead,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
});
const ws = (p: Partial<WorkflowState> = {}): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...p,
});

/**
 * Model the Rust `status_cache()` as it actually behaves on the reload / second-window path: it is a
 * process-global keyed by worktree path, so it is ALREADY WARM when this JS module boots fresh. A
 * quiet agent (refs unmoved since the cache was filled) therefore answers `changed:false` unless the
 * CALLER forces a recompute — which is the entire reason `forcedOnce` exists.
 */
function warmRustCache(work: Record<string, { ahead: number }>) {
  projectAgentsStatus.mockImplementation(
    async (_root: string, _pid: string, agents: AgentStatusInput[]): Promise<AgentStatusResult[]> =>
      agents.map((a) =>
        a.force
          ? { agentId: a.agentId, changed: true, branch: bs(work[a.agentId]?.ahead ?? 0), workflow: ws() }
          : { agentId: a.agentId, changed: false, branch: null, workflow: null },
      ),
  );
}

/** A fresh module graph = a webview reload / a brand-new second window (module state boots clean). */
async function freshWindow() {
  vi.resetModules();
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
  const runtime = await import("./runtimeStore");
  const projects = await import("./projectStore");
  const settings = await import("./settingsStore");
  return { runtime, projects, settings };
}

/** The exact shape `AgentSidebar`'s `toInput` builds. `force` is the agent's OWN liveness flag. */
const toInput = (id: string, kind: string, force = false, beadId?: string) => ({
  id,
  kind,
  baseBranch: "main",
  parentBranch: "",
  beadId,
  name: "Build 1",
  parentId: null,
  force,
});

/** Flush the fire-and-forget `void syncBeadLifecycle(...)` inside applyWorkflowState. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  projectAgentsStatus.mockReset();
  createBead.mockReset().mockResolvedValue("bd-new");
  claimBead.mockReset().mockResolvedValue(undefined);
  closeBead.mockReset().mockResolvedValue(undefined);
});

describe("pollProjectStatus — first-poll force is per-agent (roborev 54750, High)", () => {
  it("recomputes a quiet CLOSED agent on the local batch even though the probed batch ran first", async () => {
    // The reload / second-window path. Window A has been running, so the Rust cache is warm; the
    // user reloads (or opens a second window) and this module re-executes with an EMPTY branchStatus.
    const { runtime, projects } = await freshWindow();
    const pid = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    warmRustCache({ open1: { ahead: 0 }, closed1: { ahead: 11 } });

    // One sidebar tick, exactly as AgentSidebar issues it: probed (open panes, PR probe on) first,
    // then local (every closed row, PR probe off). Neither agent is "working", so both carry
    // force:false — the first-poll force is the ONLY thing that can recompute them.
    const poll = runtime.useRuntimeStore.getState().pollProjectStatus;
    await poll("/root", pid, [toInput("open1", "build")], true);
    await poll("/root", pid, [toInput("closed1", "build")], false);

    // Before the fix the probed batch consumed the single boolean latch, the local batch ran
    // unforced, Rust answered changed:false, and this stayed `undefined` — permanently, since a
    // closed idle agent's refs never move. That is the "11 commits read as an empty agent" symptom.
    expect(runtime.useRuntimeStore.getState().branchStatus.closed1?.ahead).toBe(11);
    expect(runtime.useRuntimeStore.getState().branchStatus.open1).toBeDefined();

    // The force is spent per agent, not per call: a steady-state tick honors each agent's own flag.
    const forcedOnSecondTick: boolean[] = [];
    projectAgentsStatus.mockImplementation(async (_r: string, _p: string, agents: AgentStatusInput[]) => {
      forcedOnSecondTick.push(...agents.map((a) => a.force));
      return agents.map((a) => ({ agentId: a.agentId, changed: false, branch: null, workflow: null }));
    });
    await poll("/root", pid, [toInput("closed1", "build")], false);
    expect(forcedOnSecondTick).toEqual([false]);
  });

  it("does not spend an agent's one free force on a poll that threw", async () => {
    const { runtime, projects } = await freshWindow();
    const pid = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    const poll = runtime.useRuntimeStore.getState().pollProjectStatus;

    projectAgentsStatus.mockRejectedValueOnce(new Error("rust unavailable"));
    await poll("/root", pid, [toInput("closed1", "build")], false);
    expect(runtime.useRuntimeStore.getState().branchStatus.closed1).toBeUndefined();

    // Next tick still forces it — the failed call produced nothing to keep.
    warmRustCache({ closed1: { ahead: 4 } });
    await poll("/root", pid, [toInput("closed1", "build")], false);
    expect(runtime.useRuntimeStore.getState().branchStatus.closed1?.ahead).toBe(4);
  });
});

describe("pollProjectStatus — the closed sweep drives no lifecycle (roborev 54750, Medium)", () => {
  it("does NOT auto-create a bead for a closed build agent holding commits", async () => {
    const { runtime, projects } = await freshWindow();
    const pid = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    warmRustCache({ closed1: { ahead: 3 } });

    // The local sweep: a BUILD agent with real work and no beadId — precisely the row
    // `beadLifecycleActions` would emit `create` for. On a 46-agent fleet the un-gated version
    // shells out `bd create` + `claim` for every one of them on the first tick, with no user action.
    await runtime.useRuntimeStore
      .getState()
      .pollProjectStatus("/root", pid, [toInput("closed1", "build")], false);
    await flush();

    expect(createBead).not.toHaveBeenCalled();
    expect(claimBead).not.toHaveBeenCalled();
    // The sweep's ACTUAL job still happens: "does this branch hold unmerged work?" is answered.
    expect(runtime.useRuntimeStore.getState().branchStatus.closed1?.ahead).toBe(3);
    expect(runtime.useRuntimeStore.getState().workflowStage.closed1).toBeDefined();
  });

  it("still drives the lifecycle for the PROBED (open-pane) batch — the gate is the split, not a mute", async () => {
    const { runtime, projects } = await freshWindow();
    const pid = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    warmRustCache({ open1: { ahead: 3 } });

    await runtime.useRuntimeStore
      .getState()
      .pollProjectStatus("/root", pid, [toInput("open1", "build")], true);
    await flush();

    expect(createBead).toHaveBeenCalledTimes(1);
  });

  it("does not raise the roborev consent modal from a background sweep", async () => {
    const { runtime, projects, settings } = await freshWindow();
    settings.useSettingsStore.setState({
      roborevEnabled: true,
      roborevConsentPrompted: false,
      roborevConsentOpen: false,
    });
    const pid = projects.useProjectStore.getState().addProject("Sparkle-Desktop", "/root");
    warmRustCache({ closed1: { ahead: 2 } });

    // `close()` wipes workflowStage, so a closed row's `prev` is null and every sweep looks like a
    // fresh crossing into building_saved — a modal raised for work the user is not watching.
    await runtime.useRuntimeStore
      .getState()
      .pollProjectStatus("/root", pid, [toInput("closed1", "build")], false);
    await flush();
    expect(settings.useSettingsStore.getState().roborevConsentOpen).toBe(false);

    // The same crossing on an OPEN pane does prompt.
    warmRustCache({ open1: { ahead: 2 } });
    await runtime.useRuntimeStore
      .getState()
      .pollProjectStatus("/root", pid, [toInput("open1", "build")], true);
    await flush();
    expect(settings.useSettingsStore.getState().roborevConsentOpen).toBe(true);
  });
});
