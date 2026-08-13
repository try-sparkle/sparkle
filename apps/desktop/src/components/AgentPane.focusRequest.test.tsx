// @vitest-environment jsdom
//
// A SINGLE CLICK ON A BUILD ROW PUTS THE CARET IN THAT AGENT'S TERMINAL — the pane's half.
//
// Founder, 2026-08-12: a single click on a build row selects it and *"moves keyboard focus to that
// agent's terminal pane"*; the concierge mount moved to the double click. The sidebar half (the click
// records the request) is `AgentSidebar.rowMountGesture.test.tsx`. This file closes the chain: given a
// request, the pane actually hands its terminal the caret.
//
// ══ WHY THE CHAIN NEEDED A THIRD TEST AND NOT TWO ══════════════════════════════════════════════
// `paneFocusStore.test.ts` proves the reducer, and the sidebar test proves the click writes a request.
// Neither can see the wire between them, and a channel with a live producer and no consumer is the
// defect this very feature shipped once already: every reader of `wired` was correct while NOTHING in
// app code patched it, so the connection feature was inert in shipped builds with a green suite
// (roborev 55221). The assertion below is therefore the SIDE EFFECT — `focus()` on the terminal handle
// AgentPane holds — not that an effect exists or a store was read.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  /** Every time the pane calls the terminal's imperative focus(). */
  focusCalls: 0,
  /** Whether the app claimed authorship of the caret move — see the auto-focus note below. */
  autoFocusMarks: 0,
  /** Stands in for "the user has unsent text in the focused field". */
  typing: false,
}));

// THE HALF-TYPED-MESSAGE GUARD, DRIVEN FROM THE TEST. `isTypingInProgress` reads the live
// `document.activeElement`, so the only honest way to exercise the guard from here is to control the
// answer. A partial mock: AgentPane imports other members of this module on paths this file's render
// reaches, and a whole-module mock would drop them.
vi.mock("../engine/focusGuard", async (orig) => ({
  ...(await orig<typeof import("../engine/focusGuard")>()),
  isTypingInProgress: () => captured.typing,
}));

vi.mock("./Terminal", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    // Publishes a focus handle exactly as the real Terminal does, and reports itself ready so the
    // pane's `ptyReady` gate opens.
    Terminal: (p: {
      focusRef?: { current: (() => void) | null };
      onReady?: () => void;
    }) => {
      if (p.focusRef) p.focusRef.current = () => captured.focusCalls++;
      React.useEffect(() => {
        p.onReady?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    },
  };
});
// The pane marks every caret move IT initiates. A row click is one of those (the user aimed at a row,
// not at the terminal), and getting it wrong flips the Escape ladder for the ordinary case — so the
// mark is asserted, not assumed. Counting it here rather than reaching into the real module's private
// state, which is what the module's own tests are for.
vi.mock("../services/terminalFocusIntent", async (orig) => ({
  ...(await orig<typeof import("../services/terminalFocusIntent")>()),
  markTerminalAutoFocus: () => captured.autoFocusMarks++,
}));
vi.mock("../services/paneReadiness", () => ({
  setPaneReady: () => {},
  setPaneFailed: () => {},
  unregisterPane: () => {},
}));
vi.mock("../services/conciergeDispatch", () => ({
  flushPendingSends: () => Promise.resolve(),
  abandonPendingSends: () => {},
  recordPromptSideEffects: () => {},
}));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./TerminalDropOverlay", () => ({ TerminalDropOverlay: () => null }));
vi.mock("./TerminalDropPill", () => ({ TerminalDropPill: () => null }));
vi.mock("../services/worktree", () => ({
  prewarmProjectCaches: vi.fn(),
  warmWorktreePool: vi.fn(() => Promise.resolve()),
  prepareAgentWorkspace: vi.fn(() => Promise.resolve({ path: "/wt", branch: "b" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installAgentHooks: vi.fn(() => Promise.resolve("/log")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));

import { act } from "react";
import { AgentPane } from "./AgentPane";
import { resetPaneFocus, usePaneFocusStore } from "../stores/paneFocusStore";
import type { AgentTab, Project } from "../types";

// A SHELL agent, for the same reason AgentPane.runtimeFlip.test.tsx uses one: the local branch yields
// a deterministic command without the claude worktree/preflight/bridge machinery.
const AGENT: AgentTab = {
  id: "a1",
  name: "Runner",
  kind: "shell",
  parentId: null,
  runtime: "local",
  worktreePath: null,
  branch: null,
  baseBranch: null,
  lastPrompt: "",
  promptHistory: [],
  namePinned: true,
  autoNameBasis: null,
  autoNameVariants: null,
  shellCommand: "echo hi",
};

const PROJECT: Project = {
  id: "p1",
  name: "Proj",
  rootPath: "/proj/root",
  defaultBranch: "main",
  createdAt: "",
  agents: [AGENT],
  selectedAgentId: "a1",
};

/** Let the pane's requestAnimationFrame land — every caret move it makes is deferred a frame so a
 *  just-revealed surface can mount first. */
async function flushFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await Promise.resolve();
  });
}

beforeEach(() => {
  captured.focusCalls = 0;
  captured.autoFocusMarks = 0;
  captured.typing = false;
  resetPaneFocus();
});
afterEach(() => {
  cleanup();
  resetPaneFocus();
});

describe("AgentPane consumes a pane-focus request", () => {
  it("focuses its terminal when a request lands for THIS agent", async () => {
    render(<AgentPane project={PROJECT} agent={AGENT} visible />);
    // Settle the pane's own on-reveal auto-focus first, so what this test counts is the REQUEST and
    // not that effect. Zeroing after it is what keeps the two apart — otherwise this passes on the
    // auto-focus alone and would stay green with the request path deleted entirely.
    await flushFrame();
    captured.focusCalls = 0;

    act(() => usePaneFocusStore.getState().request("a1"));
    await flushFrame();

    expect(captured.focusCalls).toBe(1);
    // …and the request is spent, so it cannot re-fire on the next unrelated re-render.
    await waitFor(() => expect(usePaneFocusStore.getState().requests["a1"]).toBeUndefined());
  });

  it("ignores a request aimed at a DIFFERENT agent", async () => {
    render(<AgentPane project={PROJECT} agent={AGENT} visible />);
    await flushFrame();
    captured.focusCalls = 0;

    act(() => usePaneFocusStore.getState().request("someone-else"));
    await flushFrame();

    expect(captured.focusCalls).toBe(0);
    // And it is still pending for whoever it was meant for — this pane must not eat it.
    expect(usePaneFocusStore.getState().requests["someone-else"]).toBeDefined();
  });

  it("HOLDS a request that arrives while the pane is hidden, and spends it on reveal", async () => {
    const { rerender } = render(<AgentPane project={PROJECT} agent={AGENT} visible={false} />);
    await flushFrame();
    captured.focusCalls = 0;

    act(() => usePaneFocusStore.getState().request("a1"));
    await flushFrame();
    expect(captured.focusCalls).toBe(0);

    rerender(<AgentPane project={PROJECT} agent={AGENT} visible />);
    await flushFrame();
    expect(captured.focusCalls).toBeGreaterThanOrEqual(1);
  });

  it("DECLINES while the user is mid-message — and spends the ask rather than deferring it", async () => {
    // Never out from under a half-typed message: the concierge is the app's one compose surface, so
    // yanking the caret mid-sentence is worse than not honouring the click.
    //
    // THE SECOND HALF IS THE ONE THAT MATTERS. A guard that only returns early leaves the request
    // PENDING, and a pending request fires on the next change to any of its inputs — so the caret
    // would land in a terminal at some arbitrary later moment with no gesture behind it. That is a
    // worse bug than the one being prevented, and it is invisible unless a test looks for it.
    render(<AgentPane project={PROJECT} agent={AGENT} visible />);
    await flushFrame();
    captured.focusCalls = 0;

    captured.typing = true;
    act(() => usePaneFocusStore.getState().request("a1"));
    await flushFrame();
    expect(captured.focusCalls).toBe(0);

    // Spent, not deferred — and the pane cannot come back for it once the typing stops.
    expect(usePaneFocusStore.getState().requests["a1"]).toBeUndefined();
    captured.typing = false;
    await flushFrame();
    expect(captured.focusCalls).toBe(0);
  });

  it("records the caret move as the APP's, not the user's", async () => {
    // LOAD-BEARING FOR ESCAPE. `engine/terminalEscape` costs a one-press toll before Escape releases
    // the cable when the user put the caret in a terminal themselves. They aimed at a ROW here — the
    // app parked the caret on their behalf — so marking this deliberate would quietly make
    // ESC-to-unmount a two-press gesture in the ordinary case, which is founder-confirmed behaviour
    // (roborev 55614). Their first real keystroke promotes provenance honestly via xterm's onData.
    render(<AgentPane project={PROJECT} agent={AGENT} visible />);
    await flushFrame();
    captured.autoFocusMarks = 0;

    act(() => usePaneFocusStore.getState().request("a1"));
    await flushFrame();

    expect(captured.autoFocusMarks).toBe(1);
  });
});
