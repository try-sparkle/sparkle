// @vitest-environment jsdom
//
// WHICH PROJECT DOES THE CLOUD CREATE DIALOG CREATE IN? — the WIRING, not the store write.
//
// `NewAgentButtons.test.tsx` proves the click STORES the clicked project's id. That passes while the
// feature is still broken, because the dialog is a SINGLETON rendered by the Workspace and it used
// to be handed the live front `project`. With two columns those are different projects: clicking
// "+ Cloud Agent" in the LEFT pair opened a dialog that would create in the RIGHT one, and switching
// the right tab while it was open silently retargeted it — a BILLED action landing in a repo the
// user never chose.
//
// So this asserts the side effect that matters: the project the dialog actually receives. Reverting
// `project={cloudCreateTarget}` to `project={project}` leaves every other suite green (roborev
// 58576), which is why this file exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
// The `sparkleAgent` mock below SPREADS THE ORIGINAL rather than replacing it — the same shape
// `Workspace.cockpit.test.tsx` uses, and for a reason worth keeping: a full-replacement mock breaks
// the moment the module gains an export some unrelated transitive import needs. That is not
// hypothetical, it is why this line changed — `SPARKLE_AGENT_ID` arrived on main and
// `conciergeTools/terminal.ts` reads it at module scope, so a replacement mock made this whole file
// fail to LOAD (0 tests collected) while the suite still reported "no tests failed".
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// Inert stubs from here down — this file asserts ONE prop on ONE child, and everything else in the
// shell exists only so `Workspace` can mount. (Keyed by side because the shell renders two.)
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide }: { slotSide?: "left" | "right" }) => (
    <div data-testid={`sidebar-${slotSide ?? "right"}`} data-zoom-column={`build-${slotSide ?? "right"}`} />
  ),
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
// THE STUB PUBLISHES THE PROJECT IT WAS HANDED. A stub rendering null would make this whole file
// vacuous — the wrong project could be passed and nothing would notice, which is exactly the
// defect being pinned.
vi.mock("./NewCloudAgentDialog", () => ({
  NewCloudAgentDialog: ({ project }: { project: { id: string; name: string } }) => (
    <div data-testid="cloud-dialog" data-project-id={project.id} data-project-name={project.name} />
  ),
}));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

function seedTwoProjects() {
  const store = useProjectStore.getState();
  const front = store.addProject("Front Project", "/tmp/front");
  const other = useProjectStore.getState().addProject("Other Project", "/tmp/other");
  // The FRONT tab is deliberately not the captured one — that difference is the whole test.
  useProjectStore.setState({ selectedProjectId: front });
  return { front, other };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useUiStore.setState({ cloudCreateProjectId: null });
});
afterEach(cleanup);

// EVERY ASSERTION GOES THROUGH `findByTestId` FIRST, and the negative cases mount the dialog for
// real before flipping to the state under test. The dialog is `lazy()`-loaded behind
// `<Suspense fallback={null}>` (Workspace.tsx), so a synchronous `queryByTestId(...) === null`
// cannot tell "the guard rendered nothing" — the thing being pinned — from "the chunk has not
// resolved yet". Such a test passes with the guard deleted entirely whenever it runs first in the
// file, which is the vacuous shape this suite exists to avoid (roborev 58583).
describe("Workspace — the cloud dialog opens on the CAPTURED project", () => {
  it("hands the dialog the captured project, not the one in front", async () => {
    const { front, other } = seedTwoProjects();
    useUiStore.setState({ cloudCreateProjectId: other });

    render(<Workspace />);

    const dialog = await screen.findByTestId("cloud-dialog");
    expect(dialog.getAttribute("data-project-id")).toBe(other);
    expect(dialog.getAttribute("data-project-name")).toBe("Other Project");
    // Stated as its own assertion so a revert to the front project is what goes red.
    expect(dialog.getAttribute("data-project-id")).not.toBe(front);
  });

  it("does not retarget when the front tab changes while it is open", async () => {
    const { front, other } = seedTwoProjects();
    useUiStore.setState({ cloudCreateProjectId: other });
    render(<Workspace />);
    await screen.findByTestId("cloud-dialog");

    // The user switches tabs with the dialog up.
    act(() => useProjectStore.setState({ selectedProjectId: front }));

    expect(screen.getByTestId("cloud-dialog").getAttribute("data-project-id")).toBe(other);
  });

  it("renders nothing when no project was captured", async () => {
    const { other } = seedTwoProjects();
    // Mount it for real first, so the null below is the GUARD and not an unresolved fallback.
    useUiStore.setState({ cloudCreateProjectId: other });
    render(<Workspace />);
    await screen.findByTestId("cloud-dialog");

    act(() => useUiStore.setState({ cloudCreateProjectId: null }));

    expect(screen.queryByTestId("cloud-dialog")).toBeNull();
  });

  it("renders nothing when the captured project has since closed", async () => {
    const { other } = seedTwoProjects();
    useUiStore.setState({ cloudCreateProjectId: other });
    render(<Workspace />);
    await screen.findByTestId("cloud-dialog");

    // ONLY the captured project closes — the front tab stays, and is what a fallback would grab.
    // Falling back to it would be the original bug in its worst form: a dialog whose origin the
    // user cannot see, creating somewhere they never clicked.
    act(() =>
      useProjectStore.setState({
        projects: useProjectStore.getState().projects.filter((p) => p.id !== other),
      }),
    );

    expect(screen.queryByTestId("cloud-dialog")).toBeNull();
  });
});
