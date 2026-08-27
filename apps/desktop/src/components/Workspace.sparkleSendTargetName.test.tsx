// @vitest-environment jsdom
//
// THE SECOND PRODUCER OF THE "Sent to: @Sparkle" LABEL (bead sparkle-w3yxlo).
//
// DROdio: *"why does it say sparkle and not improve sparkle in the sent to slot?"* The mount lookup
// in `ConciergeHost` was the producer his screenshot caught, and it has its own rows in
// `ConciergeHost.mounted.test.tsx`. THIS file covers the other one, which renders the identical
// wrong label from a completely different code path and would have survived that fix untouched:
//
//   • MOUNTED — the cable is patched at `__sparkle_self__`. The name comes from `ConciergeHost`'s own
//     mount lookup, and the prop is ignored.
//   • PANE ACTIVE, NOTHING MOUNTED — the Improve-Sparkle pane owns the shell, so `Workspace`'s
//     `sparkleTarget` WINS over the roster path inside `decidePromptTarget` and becomes
//     `promptTarget`. `ConciergeHost` writes its send receipt from `aim.name`, which on this path is
//     whatever `Workspace` put in that object. Fixing only the host leaves this half saying
//     "Sparkle".
//
// ══ WHAT THIS PINS IS THE PROP `Workspace` PASSES ════════════════════════════════════════════════
// Asserting through a STUBBED `ConciergeHost` is what makes the prop the subject. A test that
// rendered the real host and read the receipt off the DOM would go green the moment EITHER producer
// was fixed — which is exactly the coverage gap being closed here, one level up.
//
// ══ AND THE NEGATIVE HALF IS NOT OPTIONAL ════════════════════════════════════════════════════════
// "Improve Sparkle" contains "Sparkle", so a `toContain` alone passes against the pre-fix build.
// Every row below asserts the exact string, and the mounted-name row asserts the handle is NOT what
// was handed down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
// PARTIAL, and the two constants under test are deliberately NOT stubbed: the real
// `SPARKLE_AGENT_NAME` / `SPARKLE_AGENT_DISPLAY_NAME` are what this file is about, so replacing them
// would leave it asserting its own fixture. Only the launch-side helpers are replaced.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => <div data-testid="sidebar" /> }));
// THE STUB RECORDS THE PROP. `"none"` and `""` are different facts — no target at all versus a target
// with a blank name — so the absent case is spelled rather than flattened into a missing attribute.
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ promptTarget }: { promptTarget?: { agentId: string; name: string } | null }) => (
    <div
      data-testid="concierge"
      data-target-name={promptTarget ? promptTarget.name : "none"}
      data-target-agent-id={promptTarget ? promptTarget.agentId : "none"}
    />
  ),
}));
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
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { SPARKLE_AGENT_DISPLAY_NAME, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId,
    agents,
  };
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  markProjectVisited("p1");
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const targetName = () => screen.getByTestId("concierge").getAttribute("data-target-name");
const targetAgentId = () => screen.getByTestId("concierge").getAttribute("data-target-agent-id");

describe("Workspace hands the concierge the app-owned agent's DISPLAY name", () => {
  it("names the Improve-Sparkle send target 'Improve Sparkle', not the @-mention handle", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    render(<Workspace />);
    // The precondition — `sparkleTarget` really did win over the roster path. Without this the row
    // below would pass for a build that stopped aiming at the pane at all, which is a worse bug.
    expect(targetAgentId()).toBe("sparkle");
    // THE FIX. `ConciergeHost` writes its receipt from this object's `name`, so this string IS the
    // "Sent to:" slot DROdio was reading.
    expect(targetName()).toBe(SPARKLE_AGENT_DISPLAY_NAME);
    // AND THE NEGATIVE HALF, which is the assertion that reds against the pre-fix build: "Improve
    // Sparkle" contains "Sparkle", so an exact-equality check is the only one that can tell them
    // apart, and this states the losing value outright so the row cannot go quiet if the constants
    // are ever merged.
    expect(targetName()).not.toBe(SPARKLE_AGENT_NAME);
  });

  it("still produces NO sparkle target while the pane is not the active surface", () => {
    // The other half of the memo, and the reason the row above means something: `sparkleTarget` is
    // non-null ONLY while `activeSpecial === "sparkle"`. A build that hard-coded the display name
    // unconditionally would satisfy the first row and break this one.
    render(<Workspace />);
    expect(targetAgentId()).not.toBe("sparkle");
  });
});
