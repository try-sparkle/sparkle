// @vitest-environment jsdom
//
// ══ THE CHAT PANE IN THE TERMINAL STAGE — the U5 wiring (bead `sparkle-xnjil.10`) ══════════════
//
// Three claims, and the bead names the failure mode behind each:
//
//   1. `ChatPane` is a DIRECT CHILD of `terminal-stage`, not a `PaneHost` portal. `PaneHost` exists
//      solely to keep a PTY alive across re-parenting; a chat pane has none.
//   2. `paneVisibleAgentId.right` is NULL while a chat is active, "or two panes paint at once" —
//      and NON-NULL when it is not. Both directions: one alone is ambiguous, because "null" is also
//      what a workspace with no selected agent produces.
//   3. The agent pane goes `visibility: hidden` WHILE STILL LAID OUT. The bead calls this out by
//      name as the paneVisibility bug class: asserting the node is ABSENT is the wrong test, and it
//      passes for the `display: none` implementation that caused the original 11-column-terminal
//      bug (see paneVisibility.ts's history note).
//
// ── WHAT THE AgentPane STUB DOES AND WHY ───────────────────────────────────────────────────────
// It applies the REAL `paneVisibilityStyle`, imported rather than reimplemented. That is what makes
// claim 3 an assertion about production behaviour: if `paneVisibilityStyle` ever went back to
// `display: none`, this file goes red. (The other half — that `AgentPane` itself spreads that style
// — is pinned by `paneVisibility.test.ts` and `SparkleAgentPane.terminal.test.tsx`; a full
// `AgentPane` render here would drag in xterm and a PTY for no extra coverage.)
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
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// The stub agent pane, wearing the REAL hide-style. See the header.
vi.mock("./AgentPane", async () => {
  const { createElement } = await import("react");
  const { paneVisibilityStyle } = await import("./paneVisibility");
  const Pane = ({ agent, visible }: { agent: { id: string }; visible: boolean }) =>
    createElement("div", {
      "data-testid": `pane-${agent.id}`,
      "data-visible": String(visible),
      style: { position: "absolute", inset: 0, ...paneVisibilityStyle(visible) },
    });
  return { AgentPane: Pane };
});
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => <div data-testid="sidebar" /> }));
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
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useSocialStore } from "../stores/socialStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { personAgentId } from "../engine/social";
import type { AgentTab, Project } from "../types";

const ADA = "soc-ada";
const GRACE = "soc-grace";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, agents: AgentTab[]): Project {
  return {
    id, name: id.toUpperCase(), rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", [mkAgent("p1-a")])],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["p1-a"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    activeChatUserId: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  useSocialStore.setState({
    people: {
      [ADA]: { socialId: ADA, username: "ada", displayName: "Ada L.", availability: "available", relationship: "connected" },
      [GRACE]: { socialId: GRACE, username: "grace", displayName: null, availability: "offline", relationship: "connected" },
    },
  } as never);
  resetVisitedProjects();
  markProjectVisited("p1");
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  localStorage.clear();
  useUiStore.setState({ activeChatUserId: null, activeSpecial: null } as never);
  useSocialStore.setState({ people: {} } as never);
});

/** Render and wait for the lazy pane chunk — `AgentPane` is `React.lazy`, so a synchronous render
 *  leaves the stage on `PaneFallback` with nothing mounted. */
async function mount() {
  render(<Workspace />);
  await screen.findByTestId("pane-p1-a");
}

const openChat = (socialId: string) =>
  act(() => {
    useUiStore.getState().setActiveChatUserId(socialId);
  });
const closeChat = () =>
  act(() => {
    useUiStore.getState().setActiveChatUserId(null);
  });

describe("the chat pane's place in the stage", () => {
  it("is not rendered at all until a chat is opened", async () => {
    await mount();
    expect(screen.queryByTestId("chat-pane")).toBeNull();
  });

  it("mounts as a DIRECT CHILD of terminal-stage, not through a pane portal", async () => {
    await mount();
    openChat(ADA);
    const pane = await screen.findByTestId("chat-pane");
    const stage = screen.getByTestId("terminal-stage");
    // `parentElement`, not `closest`: a `PaneHost` portal would put a host div in between, and
    // `closest` cannot tell the two apart. This is the assertion that fails if someone "tidies" the
    // mount into the portal that exists to keep PTYs alive.
    expect(pane.parentElement).toBe(stage);
  });

  it("carries the person's mount id, minted through engine/social", async () => {
    await mount();
    openChat(ADA);
    const pane = await screen.findByTestId("chat-pane");
    expect(pane.dataset.chatSocialId).toBe(ADA);
    // The pane is addressed by the `person:` id, not a bare social id — one id convention.
    expect(personAgentId(ADA)).toBe("person:soc-ada");
  });
});

describe("paneVisibleAgentId.right while a chat is active — BOTH directions", () => {
  // THE PAIRED NEGATIVE, AND IT COMES FIRST DELIBERATELY. Without it, "the pane is hidden while a
  // chat is up" passes for a workspace where the pane is hidden ALWAYS — and this whole file would
  // be green against an app whose terminal never paints at all.
  it("is NON-NULL with no chat up: the selected agent's pane is the visible one", async () => {
    await mount();
    const pane = screen.getByTestId("pane-p1-a");
    expect(pane.dataset.visible).toBe("true");
    expect(getComputedStyle(pane).visibility).toBe("visible");
  });

  it("is NULL while a chat is active — or two panes paint at once", async () => {
    await mount();
    openChat(ADA);
    await screen.findByTestId("chat-pane");
    expect(screen.getByTestId("pane-p1-a").dataset.visible).toBe("false");
  });

  it("comes BACK when the chat closes — the guard is not a one-way door", async () => {
    await mount();
    openChat(ADA);
    await screen.findByTestId("chat-pane");
    closeChat();
    expect(screen.getByTestId("pane-p1-a").dataset.visible).toBe("true");
  });

  // ══ THE paneVisibility BUG CLASS, VERBATIM FROM THE BEAD ═══════════════════════════════════════
  // "assert the terminal pane is visibility:hidden while STILL LAID OUT (computed style), NOT that
  // the node is absent." A `display: none` pane collapses to a 0×0 box, its xterm FitAddon measures
  // zero width, and the terminal comes back as an ~11-column strip. That bug was patched five times
  // before the cause was found; this assertion is what stops a sixth.
  it("hides the terminal pane WITHOUT removing it or collapsing its box", async () => {
    await mount();
    const pane = screen.getByTestId("pane-p1-a");
    openChat(ADA);
    await screen.findByTestId("chat-pane");

    // STILL IN THE DOM — the same node, not a replacement.
    expect(screen.getByTestId("pane-p1-a")).toBe(pane);
    const style = getComputedStyle(pane);
    expect(style.visibility).toBe("hidden");
    // STILL LAID OUT. This is the load-bearing half: `display: none` here is the whole bug.
    expect(style.display).toBe("flex");
    expect(style.display).not.toBe("none");
    // And inert, so the hidden pane cannot swallow a click meant for the chat above it.
    expect(style.pointerEvents).toBe("none");
  });

  it("the chat pane paints while the agent pane does not — one surface at a time", async () => {
    await mount();
    openChat(ADA);
    const chat = await screen.findByTestId("chat-pane");
    expect(getComputedStyle(chat).visibility).toBe("visible");
    expect(getComputedStyle(screen.getByTestId("pane-p1-a")).visibility).toBe("hidden");
  });

  // The OTHER pre-existing surface still wins where it should: opening Improve Sparkle closes the
  // chat (the exclusion lives in `uiStore`), so the two can never both be up.
  it("selecting Improve Sparkle takes the stage back from the chat", async () => {
    await mount();
    openChat(ADA);
    await screen.findByTestId("chat-pane");
    act(() => {
      useUiStore.getState().setActiveSpecial("sparkle");
    });
    expect(screen.queryByTestId("chat-pane")).toBeNull();
    // …and the agent pane stays hidden, because the Sparkle pane covers the stage now.
    expect(screen.getByTestId("pane-p1-a").dataset.visible).toBe("false");
  });
});

describe("switching people keeps the pane and swaps the thread", () => {
  it("keeps the same pane element across a person switch", async () => {
    await mount();
    openChat(ADA);
    const pane = await screen.findByTestId("chat-pane");
    openChat(GRACE);
    // Same DOM node — the pane was NOT keyed at the top, so its state survives.
    expect(screen.getByTestId("chat-pane")).toBe(pane);
    expect(pane.dataset.chatSocialId).toBe(GRACE);
    // …and it is still the stage's own child, not something re-parented on the way.
    expect(pane.parentElement).toBe(screen.getByTestId("terminal-stage"));
  });
});
