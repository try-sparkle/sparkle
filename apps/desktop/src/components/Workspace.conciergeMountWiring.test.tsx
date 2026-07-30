// @vitest-environment jsdom
//
// THE MOUNT REACHES THE CONCIERGE COLUMN ITSELF — with the REAL ConciergeHost in the tree.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT IN Workspace.conciergeMount.test.tsx.
//
// That suite was written to close a seam: two green suites, each assuming the other half worked. The
// sidebar's own suite clicked a real row and stopped at the store; the cockpit suite mocked the
// sidebar and started at the store. Neither ran a click through to the DOM, and the mount was
// broken end to end while both stayed green.
//
// It then re-created a smaller copy of that same seam, and roborev 55529 was right to say so: it
// mocks `ConciergeHost`. But `wired`'s ONLY consumer in the shell below the root is
// `ConciergeHost → ConciergeColumn wired={wired}`. With the host stubbed, that suite stops at the
// shell root's `data-wired` while `ConciergeColumn.wired.test.tsx` supplies the prop by hand — so a
// break in the host's prop wiring, the half the founder actually SEES (the column flooding to
// terminal material), stayed invisible to a fully green suite. Exactly the failure mode the other
// file's own header describes.
//
// `vi.mock` is hoisted per FILE, so the host cannot be left unmocked for one case among many. Hence
// a second file, whose entire purpose is that one seam. It asserts `data-wired` on the concierge
// column's OWN element, reached through the real host, from a real click on a real sidebar row.
//
// WHAT THIS FILE DOES *NOT* CLAIM, stated so nobody reads it as broader than it is. It pins the
// PRESENTATIONAL wire — the projection the founder sees. It does NOT pin that a mounted message is
// ROUTED to the mounted agent: `engine/shellResolve.decidePromptTarget` contains no reference to
// `wired` or `cable` at all, so routing today is a separate, cable-blind auto-router that merely
// AGREES with the cable in the common case. That is the unbuilt half, and a test asserting today's
// prompt target would be asserting the agreement, not the rule. It gets its own coverage when the
// routing work lands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// Needed HERE and not in the sibling suite: with the real ConciergeHost mounted, the drop hooks
// (useNewBuildAgentDrop, useConciergeAttachments) actually run, and the real `getCurrentWebview()`
// throws outside a Tauri window — an unhandled rejection that fails every case in the file before a
// single assertion is reached.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
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
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
// The concierge's PAID brain — stubbed because nothing here sends anything. The column itself still
// renders in full (thread + composer), which is the point, and the first case below ASSERTS that
// rather than assuming it.
vi.mock("../services/concierge", () => ({
  startConciergeTurn: vi.fn(async () => null),
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));

// NOT MOCKED, and this is the entire reason the file exists: ConciergeHost, and the
// ConciergeColumn below it. Everything else heavy is stubbed so the failure surface stays the wire.
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable, useCableStore } from "../stores/cableStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string | null): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: selectedAgentId as never, agents,
  };
}

const SLIDER = "Talk/Send Mode Slider";
const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

/**
 * The concierge column's OWN projection — not the shell root's. This is the assertion the mocked
 * host made impossible, and the one the founder reads as "the concierge went black".
 *
 * FAILS LOUDLY, and deliberately not with `??` fallbacks (roborev 55704). A `?? null` chain makes
 * "the column is absent" indistinguishable from "the column reads null", and a two-branch chain can
 * match a DIFFERENT element in each branch — so a tree with more than one `data-wired` under the
 * concierge root would silently pick the first in document order, which need not be the column's own
 * projection. Since this file's whole premise is "break `wired={wired}` and ONLY this fails", the
 * element it reads has to be unambiguous or the premise is unfounded.
 */
function columnEl(): HTMLElement {
  const root = document.querySelector("[data-concierge-root]");
  if (!root) throw new Error("no [data-concierge-root] in the tree");
  // ANCHORED ON THE COLUMN'S OWN ROOT — `ConciergeColumn`'s <section aria-label="Sparkle concierge">
  // (ConciergeColumn.tsx:185-196) — NOT on "any descendant carrying the attribute".
  //
  // An earlier cut demanded that exactly ONE `[data-wired]` exist under the concierge root and threw
  // otherwise. That invariant is FALSE of the production tree: `data-wired` is deliberately mirrored
  // on three elements — this section, `ComposeBox` (:1033) and `ConciergeThread`'s you-bubble (:296)
  // — and the latter two render whenever `!aiLock`. The guard only held because the fixture was
  // accidentally LOCKED, and it would have thrown in every case here the moment the column was
  // unlocked, which is the state the founder actually sees (roborev 55718). The correct element was
  // never ambiguous; it just had to be named.
  const el = root.querySelector('section[aria-label="Sparkle concierge"][data-wired]');
  if (!el) {
    throw new Error(
      "no <section aria-label='Sparkle concierge'> carrying [data-wired] under the concierge root",
    );
  }
  return el as HTMLElement;
}
const columnWired = () => columnEl().getAttribute("data-wired");

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1", "Stripe checkout retry"), mkAgent("a2", SLIDER)], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workMode: "build", pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
    collapsedOrchestrators: {}, autoExpandedOrchestrators: {},
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  // LAST, and it must stay last. This suite's whole point is the wire into the column the founder
  // SEES — thread and composer mounted. An earlier cut called this first and then set
  // `{ me: null }` two lines later, which re-shut the AI gate (`aiEnhancementsEnabled(null)` is
  // false): ConciergeAiLocked replaced the thread, no ComposeBox mounted, and the suite silently
  // pinned the wire through the LOCKED column while its header claimed the opposite (roborev 55718).
  // Anything that nulls `me` after this line puts the file back in that state.
  enableAiEnhancementsForTests();
  resetVisitedProjects();
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("the mount reaches the concierge column, through the real host", () => {
  // THE FIXTURE'S PREMISE, asserted before anything else in the file relies on it. Every case here
  // claims to exercise the column the founder sees; if the AI gate is shut, the thread is replaced
  // by ConciergeAiLocked and no composer mounts, and the rest of the file would still pass while
  // pinning something much weaker. That is precisely what happened (roborev 55718), so it is now a
  // case rather than a comment.
  it("renders the UNLOCKED column — thread and composer both mounted", () => {
    render(<Workspace />);
    expect(screen.queryByTestId("concierge-ai-locked")).toBeNull();
    expect(screen.getByRole("textbox")).not.toBeNull();
  });

  it("leaves the column unwired at rest", () => {
    render(<Workspace />);
    // The precondition, asserted so the case below is a genuine transition and not a lucky default.
    expect(columnWired()).toBe("off");
  });

  // THE SEAM. A real row click, through the real ConciergeHost, landing on the real
  // ConciergeColumn's own `data-wired`. Break `wired={wired}` in the host and ONLY this fails:
  // the shell root keeps projecting correctly, and ConciergeColumn.wired.test.tsx keeps passing
  // because it supplies the prop itself.
  it("floods the column when a row is clicked", () => {
    render(<Workspace />);
    expect(columnWired()).toBe("off");
    fireEvent.click(rowFor(SLIDER));
    expect(columnWired()).toBe("right");
  });

  // And it must come back DOWN through the same wire. A mount that cannot be undone at the column
  // leaves the founder looking at terminal material with no cable behind it.
  it("clears the column's flood on Escape", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    expect(columnWired()).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(columnWired()).toBe("off");
    expect(useCableStore.getState().wired).toBe("off");
  });
});
