// Shared fixtures + store seeding for the Workspace render-COST suites.
//
// Two suites measure what an interaction costs the cockpit — `Workspace.renderCost.test.tsx` (a
// concierge-seam drag) and `Workspace.switchCost.test.tsx` (an agent selection change). Both need the
// identical realistic shell: 60 panes, one project, every store seeded to a plain build-mode cockpit.
// That setup was duplicated verbatim between them, which is how it drifts — and drift here is
// expensive in a specific way: the failure is not a wrong measurement, it is both files failing to
// COLLECT for a reason unrelated to either measurement, with the explanation recorded in only one of
// them.
//
// WHAT IS **NOT** HERE, AND CANNOT BE: the `vi.mock(...)` registrations. Vitest hoists those by
// syntactically detecting the calls in each test FILE, so a shared module cannot register them on a
// caller's behalf — moving them here would silently disable them. They necessarily stay duplicated
// in both suites. Two consequences worth knowing before you edit either:
//
//   • The two mock blocks MUST stay in sync. If `Workspace.tsx` gains a module-scope import that
//     needs stubbing, both files need it or both fail to collect.
//   • Prefer `vi.mock(path, async (orig) => ({ ...(await orig()), … }))` over a wholesale stub.
//     A wholesale stub silently drops exports added later: `../services/sparkleAgent` gained
//     `SPARKLE_AGENT_ID` on main and a flat stub made the shell fail to collect for a reason that had
//     nothing to do with the test. Spreading the original is what keeps that from recurring.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

/** The pane count both cost suites measure at. Sixty agents is a real cockpit, not a stress test —
 *  it is the count the v0.63.0 jank log named (`"rendered":"AgentPane x62, Workspace x3"`). */
export const PANES = 60;

/** `a0`…`a59`, in order. `a0` is the initially selected agent. */
export const agentIds = Array.from({ length: PANES }, (_, i) => `a${i}`);

export function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

export function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

/**
 * Seed every store to a plain single-project, build-mode cockpit with {@link PANES} agents open.
 *
 * Call from `beforeEach`. Deliberately explicit about each store rather than relying on defaults:
 * these suites assert exact render COUNTS, so a store left at whatever a previous test wrote would
 * change the counts without changing the test — the worst kind of flake to chase.
 */
export function seedCockpit(): void {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", agentIds.map(mkAgent))],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: agentIds, status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
}

/** Tear down what {@link seedCockpit} set up. Call from `afterEach` (after `cleanup()`). */
export function resetCockpit(): void {
  resetCable();
  localStorage.clear();
}
