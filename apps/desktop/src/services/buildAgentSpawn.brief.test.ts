// A BRIEFED SPAWN MUST NOT LEAVE ITS BRIEF IN THE PTY QUEUE.
//
// `spawnBuildAgentInProject` used to `queuePendingSend` the opening brief, which delivers it by
// pasting into the agent's PTY once the pane reports ready. That path reliably delivered the TEXT and
// reliably lost the SUBMIT: `ptyReady` fires when `pty_spawn` returns — the child has been forked,
// but claude's TUI is not reading stdin yet — so the brief sat at the prompt with the cursor after it
// until a human pressed Enter. Measured against a real claude in a real pty, a paste+CR at +0.11s and
// even at +9.8s (after output had been idle 2.5s) both failed to submit; only argv delivery and a
// paste at +35s worked. Full table in services/agentBrief.
//
// So the assertion is about WHERE the brief went: attached for the launch argv, and NOT sitting in
// the pending-send queue. `pendingSendCount === 0` is the half that fails against the old code.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { resetVisitedProjects } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { pendingSendCount, resetPendingSends } from "./pendingSends";
import { briefForLaunch, hasUndeliveredBrief, resetAgentBriefs } from "./agentBrief";
import type { Project } from "../types";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
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
  resetPendingSends();
  resetAgentBriefs();
});

const BRIEF = "Investigate the dead pill and report what resolves it.";

describe("spawnBuildAgentInProject: brief delivery route", () => {
  it("attaches the brief to the LAUNCH and leaves nothing in the PTY queue", () => {
    const id = spawnBuildAgentInProject(project(), { prompt: BRIEF })!;
    expect(id).toBeTruthy();
    // The brief is waiting for the launch that will carry it as claude's positional prompt…
    expect(hasUndeliveredBrief(id)).toBe(true);
    expect(briefForLaunch(id, false)).toBe(BRIEF);
    // …and NOT queued for a post-ready PTY paste. This is the line that fails against the old code,
    // where the count was 1 and the submit was lost.
    expect(pendingSendCount(id)).toBe(0);
  });

  it("does not record the brief as a delivered prompt at spawn time", () => {
    const id = spawnBuildAgentInProject(project(), { prompt: BRIEF })!;
    const agent = useProjectStore
      .getState()
      .projects.flatMap((p) => p.agents)
      .find((a) => a.id === id)!;
    // The prompt surfaces (pinned header, history) must stay empty until the brief has ACTUALLY been
    // launched — the pane records the side-effects on the delivery path. Seeding them here is the
    // "falsely calm agent idling at an empty prompt, with the header confidently showing the brief
    // that was never sent" failure (roborev 55057).
    expect(agent.lastPrompt ?? "").toBe("");
    expect(agent.promptHistory ?? []).toHaveLength(0);
  });

  it("an UNBRIEFED spawn holds no brief, so it is not treated as an undelivered one", () => {
    const id = spawnBuildAgentInProject(project(), {})!;
    expect(hasUndeliveredBrief(id)).toBe(false);
    expect(briefForLaunch(id, false)).toBeUndefined();
    expect(pendingSendCount(id)).toBe(0);
  });
});
