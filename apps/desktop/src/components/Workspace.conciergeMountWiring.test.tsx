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
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
// `__sparkle_self__` is the REAL app-owned Sparkle agent id (services/sparkleAgent.SPARKLE_AGENT_ID),
// not a placeholder: the routing block below gates on the real `isSparkleAgentId`, which only matches
// that namespace, so a stand-in like "sparkle" would resolve to a normal agent and route to the brain.
const SPARKLE_ID = "__sparkle_self__";
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "__sparkle_self__",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
// The Sparkle agent's terminal write is the SIDE EFFECT this suite's routing cases assert — so the
// PTY dispatcher is spied, and ONLY it: `agentCanAcceptInput`/`onDeferredSendOutcome` stay real so
// the mount still has to resolve as a promptable local PTY (services/knownAgents) to reach the spy.
const disp = vi.hoisted(() => ({
  dispatchConciergeAnswer: vi.fn(async (agentId: string) => ({
    ok: true,
    path: "free-text" as const,
    agentId,
  })),
}));
vi.mock("../services/conciergeDispatch", async (orig) => ({
  ...(await orig<typeof import("../services/conciergeDispatch")>()),
  dispatchConciergeAnswer: disp.dispatchConciergeAnswer,
}));
// The concierge's PAID brain — stubbed because nothing here sends anything. The column itself still
// renders in full (thread + composer), which is the point, and the first case below ASSERTS that
// rather than assuming it.
vi.mock("../services/concierge", () => ({
  startConciergeTurn: vi.fn(async () => null),
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
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
import { registerViewport, resetViewportRegistry } from "../services/terminalViewport";
import { startConciergeTurn } from "../services/concierge";
import { MOUNTED_THREAD_TESTID } from "./Concierge/MountedAgentThread";
import { armedIntents, cancelIntent, fireIntent } from "../services/dispatchIntent";
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
  // ══ THE UNLOCKED PREMISE, ENFORCED WHERE IT CANNOT BE BYPASSED (roborev 55745) ═════════════════
  // The premise case below states this, but no other case goes THROUGH it — they all call
  // `columnWired()`, and the selector above resolves the section identically whether or not the AI
  // gate is shut (`data-wired` sits on the section above the `aiLock ?` branch). So the exact drift
  // this file was rewritten to fix could recur in every case but the premise one: any future edit
  // that nulls `me` for a single case — and `BalanceBadge`'s mount-time `refresh()` is a live
  // instance the helpers already stub around — would leave the other rows green while once again
  // pinning the wire through a column with no thread and no composer. Checked here, every caller
  // inherits it for free.
  if (el.querySelector('[data-testid="concierge-ai-locked"]')) {
    throw new Error(
      "the concierge column is AI-LOCKED — this suite pins the wire through the UNLOCKED column " +
        "(thread + composer mounted). Something nulled `me` after enableAiEnhancementsForTests().",
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
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
    collapsedOrchestrators: {},
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
  // The viewport registry is a module singleton, so a screen left registered by one case would
  // silently decide the guard's answer in the next — the exact class of cross-case leak the intent
  // queue is cancelled for below.
  resetViewportRegistry();
  disp.dispatchConciergeAnswer.mockClear();
  vi.mocked(startConciergeTurn).mockClear();
});
afterEach(() => {
  // An armed countdown outlives its render (the intent registry is a module singleton) — cancel any
  // the routing cases left standing so the next case starts from an empty queue.
  for (const i of armedIntents()) cancelIntent(i.id);
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
    // ANCHORED INSIDE THE COLUMN, not document-wide (roborev 55745). The claim is "the CONCIERGE's
    // composer mounted", and the shell is not textbox-free by construction — `AgentSidebar`'s rename
    // input and `CommandPalette`'s both carry role=textbox under the same render. A bare
    // `screen.getByRole("textbox")` would pass against a composerless column whenever either of
    // those is present, and throw "found multiple elements" whenever both are, failing the premise
    // for a reason that has nothing to do with the premise.
    expect(within(columnEl()).getByRole("textbox")).not.toBeNull();
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

// ══ THE ROUTING HALF THE MOUNT WIRING NEVER PINNED (beads sparkle-0rf5, sparkle-gw8yi) ══════════
//
// The suite above pins the PRESENTATIONAL wire and its own header disclaims the rest: "It does NOT
// pin that a mounted message is ROUTED to the mounted agent … That is the unbuilt half, and … gets
// its own coverage when the routing work lands." This is that coverage, for the Improve-Sparkle
// surface specifically.
//
// ══ THE FOUR CELLS, AND WHY THEY ARE ALL HERE ═══════════════════════════════════════════════════
// The founder's contract, both halves, verbatim: *"When that row is mounted … If I'm typing into
// Sparkle with the row mounted, it should be going into that terminal JUST LIKE WITH ANY OTHER BUILD
// AGENT"* and *"If I've escaped and unmounted out, but I can still see the row, then I should be able
// to communicate with Sparkle."* Two of the four combinations were never covered, and that is how a
// P0 survived six PRs on this cluster:
//
//   MOUNTED, plain text          → the Sparkle agent's terminal
//   MOUNTED, leading @Sparkle    → the concierge (the escape hatch)
//   NOT MOUNTED, pane on screen  → the concierge   ← THE BUG HE PROVED HIMSELF
//   NOT MOUNTED, looking away    → the concierge
//
// Two of them run with the agent's screen in a state the write-guard REFUSES (a `vim` alternate
// buffer). That is not incidental: the defect was the guard being consulted for a message bound for
// the concierge, and a cell that runs against a permissive screen cannot see it. The concierge is not
// a PTY — it has no screen — so no screen state may change where these land.
//
// A VIEWPORT IS REGISTERED because the pane is on screen in every one of these states, and
// `SparkleAgentPane` is stubbed to null in this file (so nothing else would register one). Without it
// every mounted case refuses with `no-viewport` and the suite pins nothing about routing at all.
//
// WHICH CELL IS LOAD-BEARING, stated because the mutation says so and a reader should not have to
// re-run it: restoring the removed `mountAddress` reddens CELL 3 and nothing else. Cell 2's escape
// hatch sets `via: "address"`, which suppressed the old special case anyway, and cell 4 has no prompt
// target to build one from — both are NON-REGRESSION guards, kept because they are two of the four
// combinations the founder named and their silence is what a future change must not break.
describe("the Improve-Sparkle mount routes to the Sparkle agent, through the real shell", () => {
  /** A calm Claude Code prompt — the ordinary state, which the write-guard permits. */
  const CLEAN_SCREEN = { text: "> \n", alternateBuffer: false };
  /** A genuine full-screen app. `isClaudeCodeScreen` rejects it (none of its marker families are
   *  drawn), so `terminalWriteRefusal` returns `alternate-screen` — a REAL refusal, not the
   *  busy-Claude-Code false positive PR #1143 removed. */
  const VIM_SCREEN = { text: '~\n~\n"notes.md" 12L, 340B', alternateBuffer: true };

  function mountSparkle(
    agents: AgentTab[],
    selectedAgentId: string | null = null,
    opts: { cable?: boolean; paneUp?: boolean; screen?: { text: string; alternateBuffer: boolean } } = {},
  ) {
    const { cable = true, paneUp = true, screen = CLEAN_SCREEN } = opts;
    useProjectStore.setState({
      projects: [mkProject("p1", "Alpha", agents, selectedAgentId)],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({
      openAgentIds: [SPARKLE_ID, ...agents.map((a) => a.id)],
      status: {},
    } as never);
    useUiStore.setState({
      activeSpecial: paneUp ? "sparkle" : null,
      workModeBySide: { left: "build", right: "build" },
      pinnedProjectId: null,
      openProjectIds: null,
      pairAssignment: {},
      leftProjectId: null,
      collapsedOrchestrators: {},
    } as never);
    // The pane's own terminal, which is what makes the screen readable at all.
    registerViewport(SPARKLE_ID, () => screen);
    // What the click leaves behind: the cable patched into the pair the row sits in. Omitted for the
    // UNMOUNTED cells — Escape unpatches the cable and leaves the pane on screen, which is exactly
    // the state the founder was in when he could no longer reach the concierge.
    if (cable) act(() => useCableStore.getState().patch("right"));
    render(<Workspace />);
  }

  /** Type into the CONCIERGE column's own composer and press Send, then let the armed countdown —
   *  the same cancellable gate an @-addressed send passes through — elapse to the dispatch. */
  async function sendToMount(text: string) {
    const ta = within(columnEl()).getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
    await act(async () => {
      fireEvent.click(within(columnEl()).getByRole("button", { name: "Send" }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    await act(async () => {
      for (const i of armedIntents()) fireIntent(i.id);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  /** Did anything on screen tell the founder his message was refused? The exact sentence he was
   *  shown — *"@Sparkle has a full-screen app open"* — is `terminalRefusalLine`'s copy, and the
   *  headline above it is the receipt's. Both are searched, because the refusal renders in two
   *  places and covering one would let the other survive. */
  const refusalOnScreen = () =>
    /full-screen app|couldn't take it|can't take a message/i.test(
      document.body.textContent ?? "",
    );

  // ── THE MOUNT MUST ALSO BE VISIBLE, NOT ONLY ROUTABLE (bead sparkle-gw8yi, half 1) ─────────────
  // His words: *"When I click on the Improve Sparkle agent, I want it to MOUNT THE CONCIERGE INTO
  // THAT AGENT just like it would a regular builder agent. THAT'S NOT HAPPENING RIGHT NOW"* — and
  // earlier, that clicking it *"showed a mounted version of Concierge content, which is wrong."*
  //
  // The routing cases above cannot see this: the send reached the right terminal the whole time. What
  // was broken is that `mountedRow` is a scan of `project.agents`, which this agent is deliberately
  // never in, so the COLUMN never swapped and went on rendering the Sparkle conversation under a lit
  // cable. Asserted on the mounted thread's own testid — the element that only exists when the host
  // resolved a mounted agent.
  it("swaps the column to the Sparkle agent's own conversation when mounted", () => {
    mountSparkle([]);
    expect(within(columnEl()).getByTestId(MOUNTED_THREAD_TESTID)).toBeTruthy();
  });

  it("swaps back to the concierge conversation once the cable is unpatched", () => {
    // The other side of the same fact: unmounted, the founder is talking to Sparkle and must see the
    // Sparkle thread. An always-on mounted view would be the reported bug pointing the other way.
    mountSparkle([], null, { cable: false });
    expect(within(columnEl()).queryByTestId(MOUNTED_THREAD_TESTID)).toBeNull();
  });

  it("lights the cable with NO build agents — the visual no-op the bead names", () => {
    mountSparkle([]);
    // effectiveWired darkens the cable when the patched side has no selected agent; the Sparkle mount
    // is a valid far end, so the column stays lit on the patched side. Without the fix this reads
    // "off" (the reported no-op), which is the transition this case pins.
    expect(columnWired()).toBe("right");
  });

  // ── CELL 1: MOUNTED, plain text → that agent's terminal ────────────────────────────────────────
  it("routes a concierge send into the Sparkle agent's terminal, with NO build agents", async () => {
    mountSparkle([]);
    await sendToMount("tighten the retry backoff");
    // THE SIDE EFFECT: the PTY dispatcher was driven at the Sparkle agent's own id. Before the fix
    // the resolved target is null/absent (the Sparkle agent is not a feed member) and the send falls
    // to the brain — dispatchConciergeAnswer is never called.
    expect(disp.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(disp.dispatchConciergeAnswer.mock.calls[0]![0]).toBe(SPARKLE_ID);
  });

  it("routes to the Sparkle agent even when build agents exist and one is selected", async () => {
    // A build agent is present and selected, but the Sparkle pane owns the surface — the send must
    // still reach Sparkle, not the build agent the pair happens to hold.
    mountSparkle([mkAgent("a1", "Stripe checkout retry")], "a1");
    await sendToMount("rename the flag");
    expect(disp.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(disp.dispatchConciergeAnswer.mock.calls[0]![0]).toBe(SPARKLE_ID);
  });

  // ── CELL 2: MOUNTED, leading @Sparkle → the concierge, WHATEVER the agent's screen shows ───────
  it("takes the @Sparkle escape hatch out of the mount even with the agent in a full-screen app", async () => {
    mountSparkle([], null, { screen: VIM_SCREEN });
    await sendToMount("@Sparkle what is that agent stuck on?");
    // The escape hatch exists FOR this state: mounted, and the founder wants the concierge instead.
    // A screen check here is what made it unusable — the mounted agent's `vim` session vetoing a
    // message that was never going to its terminal.
    expect(disp.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(refusalOnScreen()).toBe(false);
  });

  // ── CELL 3: NOT MOUNTED, pane still on screen → the concierge. THE BUG HE PROVED. ──────────────
  it("reaches the concierge when the pane is on screen but UNMOUNTED, however busy that agent is", async () => {
    // Escape has unpatched the cable; the row is still visible and still the active surface. His
    // words: *"If I've escaped and unmounted out, but I can still see the row, then I should be able
    // to communicate with Sparkle. But I couldn't."*
    mountSparkle([], null, { cable: false, screen: VIM_SCREEN });
    await sendToMount("why did the last pass not open a PR?");
    // BEFORE THE FIX: `mountAddress` was built from the prompt target, which this surface sets from
    // `activeSpecial === "sparkle"` alone — so with no cable at all the message was still aimed at
    // that agent's PTY, met the screen guard, and came back as "@Sparkle has a full-screen app open".
    expect(disp.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(refusalOnScreen()).toBe(false);
    // AND IT ACTUALLY REACHED THE BRAIN — "was not dispatched to a terminal" is only half the claim,
    // and the half that a message silently dropped on the floor would also satisfy.
    expect(vi.mocked(startConciergeTurn)).toHaveBeenCalled();
  });

  // ── AND CELL 3 REACHED THE WAY HE REACHED IT — through the real Escape handler ─────────────────
  // The cell above SETS the unmounted state; this one ARRIVES at it. That gap is worth closing on
  // its own: his sentence is *"If I've escaped and unmounted out, but I can still see the row"*, and
  // a fix verified only against a hand-built state proves nothing about whether Escape produces it.
  // So this presses the key and then asserts BOTH halves of his premise before sending — the cable is
  // off, and the pane is still the surface he is looking at.
  it("Escape unmounts the row but leaves it on screen — and the next message still reaches Sparkle", async () => {
    mountSparkle([], null, { screen: VIM_SCREEN });
    expect(columnWired()).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useCableStore.getState().wired).toBe("off");
    // "…but I can still see the row" — Escape drops the cable, not the pane. If this ever stops
    // holding, the case above is no longer testing the state he was in.
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    await sendToMount("so what did the last improvement pass actually change?");
    expect(disp.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(refusalOnScreen()).toBe(false);
    expect(vi.mocked(startConciergeTurn)).toHaveBeenCalled();
  });

  // ── CELL 4: NOT MOUNTED, looking elsewhere → the concierge ─────────────────────────────────────
  it("reaches the concierge when the founder is not looking at the pane at all", async () => {
    mountSparkle([mkAgent("a1", "Stripe checkout retry")], "a1", {
      cable: false,
      paneUp: false,
      screen: VIM_SCREEN,
    });
    await sendToMount("give me the fleet status");
    expect(disp.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(refusalOnScreen()).toBe(false);
    expect(vi.mocked(startConciergeTurn)).toHaveBeenCalled();
  });
});
