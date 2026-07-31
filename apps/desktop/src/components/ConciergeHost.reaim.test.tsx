// @vitest-environment jsdom
//
// RE-AIMING the compose box between two agents, through the REAL suggestion engine.
//
// ConciergeHost.test.tsx STUBS both `ConciergeSuggestions` and the dispatch layer, so its rows test
// the host's routing rather than the engine — which is right for those rows and useless for this
// one. The finding here is precisely that the hook's state used to outlive a change of `agentId`,
// and a stub that returns a constant cannot express it. This file therefore mounts the real
// component and the real hook (with only their leaf dependencies mocked) and re-aims the box the
// way the app does: by moving `promptTarget`, which is what selecting a different agent does.
//
// What must not ship: agent A's computed buttons rendering under agent B's name, because a click in
// that window sends A's prompt into B's TERMINAL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(
    async (_agentId: string, _text: string, _opts?: unknown) => ({ ok: true, path: "free-text" }),
  ),
  setInterruptPreference: vi.fn(),
  computeSuggestions: vi.fn(),
  pushSuggestions: vi.fn(),
  /** Per-agent terminal screens. Two agents are live at once here, which is the whole point. */
  screens: {} as Record<string, string>,
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false, // no picker on screen in these rows
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: h.setInterruptPreference }) },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));

// The suggestion engine's leaves — everything BELOW useSuggestions. The hook itself is REAL.
const { SuggestionOfflineError, AiUnavailableError, AiUnreachableError } = vi.hoisted(() => {
  class SuggestionOfflineError extends Error {}
  class AiUnavailableError extends Error {}
  class AiUnreachableError extends Error {}
  return { SuggestionOfflineError, AiUnavailableError, AiUnreachableError };
});
vi.mock("../services/suggestions/engine", () => ({
  computeSuggestions: (...a: unknown[]) => h.computeSuggestions(...a),
  SuggestionOfflineError,
}));
vi.mock("../services/anthropic", () => ({ AiUnavailableError, AiUnreachableError }));
// PARTIAL mock, via importOriginal. This file only needs `getAgentScrollback` stubbed, but a
// wholesale replacement drops every other export — and the column's approval card now reaches the
// tool registry (Concierge/ConciergeApprovals → services/conciergeApprovalResume), which reads
// `SNAPSHOT_MAX_LINES` from here at module scope. A total mock made that a load-time crash for the
// whole suite, which is a mocking artefact rather than anything about re-aiming.
vi.mock("../services/terminalScrollback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/terminalScrollback")>()),
  getAgentScrollback: (id: string) => h.screens[id] ?? null,
}));
// `useHasAiCredits` is a newer gate on the compute path (added to aiGate on main after this
// suite was written). Omit it from the mock and the module factory throws; return false and the
// engine never runs, so every pill assertion below would pass VACUOUSLY. These tests are about
// which agent the engine is scoped to, not about billing — so credits are present throughout.
// `aiEnhancementsEnabled` joins it for the same reason: the concierge column reads it to decide
// whether its paid half is locked (Concierge/conciergeAiLock). Omit it and the factory throws;
// return false and the column renders the upsell instead of the thread, so every assertion here
// would fail for a billing reason that isn't this suite's subject.
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
}));
vi.mock("../services/relayClient", () => ({ pushSuggestions: h.pushSuggestions }));
// Both agents are your-turn; neither has a stage that yields a CTA (no branchStatus / stage →
// building_unsaved → deriveCta returns null), so the pill shows the raw computed set.
const RUNTIME = {
  status: { ag1: "idle", ag2: "idle" },
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import { resetSuggestionMemory } from "../services/suggestions/useSuggestions";
import type { ConciergeFeed } from "../useConciergeFeed";
import { useConnectionStore } from "../stores/connectionStore";
import type { SuggestionButton } from "../services/suggestions/types";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);

/** A's recommended action. `value` is what a click SENDS — the string that must never reach B. */
const A_ACTION: SuggestionButton = {
  id: "a-land",
  label: "Land A to Main",
  value: "Land agent A's work to main.",
  kind: "prompt",
  source: "control",
};
const B_ACTION: SuggestionButton = {
  id: "b-tests",
  label: "Fix B's tests",
  value: "Fix agent B's tests.",
  kind: "prompt",
  source: "control",
};

function agent(id: string, name: string) {
  return {
    id,
    name,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    // `done`, not `needs_you`: these rows are about the compose box, and a surfaced agent would
    // add nudge cards that have nothing to do with what is being tested.
    band: "done" as const,
    inScope: true,
    muted: false,
  };
}
const COUNTS = { needs_you: 0, running: 0, done: 2 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [agent("ag1", "Agent A"), agent("ag2", "Agent B")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

const AIM_A: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: "Agent A" };
const AIM_B: ConciergePromptTarget = { projectId: "p1", agentId: "ag2", name: "Agent B" };

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

// THE PILL LIVES ON THE TERMINAL NOW, so it needs a stage to portal into.
//
// `ConciergeSuggestions` renders through a portal into the aimed agent's terminal stage (published
// by AgentPane's callback ref into stores/terminalOverlayStore) rather than into a strip above the
// compose box. This suite renders the HOST alone — there is no AgentPane, so without a registered
// stage the portal has no target and every pill assertion below fails on an element that was never
// mounted. Registering one detached div per agent is the smallest thing that restores what these
// rows are actually about: which agent the suggestions are SCOPED to when the box re-aims.
// ATTACHED to document.body, not merely created: testing-library's queries walk the document, so a
// detached stage node would host the portal somewhere `screen` can never see and every row would
// fail exactly as if the pill had not rendered at all.
function registerStages() {
  for (const id of ["ag1", "ag2"]) {
    const el = document.createElement("div");
    el.dataset.stage = id;
    document.body.appendChild(el);
    useTerminalOverlayStore.getState().setStage(id, el);
  }
}

function clearStages() {
  for (const id of ["ag1", "ag2"]) {
    useTerminalOverlayStore.getState().setStage(id, null);
    document.querySelector(`[data-stage="${id}"]`)?.remove();
  }
}

beforeEach(() => {
  registerStages();
  h.computeSuggestions.mockReset();
  h.dispatchConciergeAnswer.mockClear();
  h.pushSuggestions.mockReset();
  resetSuggestionMemory();
  h.screens = { ag1: "Agent A is done. Committed abc.", ag2: "Agent B is done. Committed def." };
  useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
});
afterEach(() => {
  cleanup();
  // The overlay store is module-level and the stage nodes are real DOM, so both outlive `cleanup()`
  // and would leak a stale portal target into the next row.
  clearStages();
  vi.clearAllMocks();
});

describe("ConciergeHost — the box re-aimed from one agent to another", () => {
  /** Aim at A, let A's action compute, then re-aim at B the way selecting another agent does. */
  async function aimAtAThenB(bResult?: { buttons: SuggestionButton[] }) {
    h.computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    const { rerender } = render(<ConciergeHost feed={FEED} promptTarget={AIM_A} />);
    await screen.findByText(A_ACTION.label);
    h.computeSuggestions.mockReset();
    if (bResult) h.computeSuggestions.mockResolvedValue(bResult);
    // B's compute never settles, so anything on screen afterwards can only be A's.
    else h.computeSuggestions.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      rerender(<ConciergeHost feed={FEED} promptTarget={AIM_B} />);
    });
    return { rerender };
  }

  it("stops offering A's action once the box points at B", async () => {
    await aimAtAThenB();
    // The pill is gone entirely — not merely relabelled.
    expect(screen.queryByText(A_ACTION.label)).toBeNull();
    expect(screen.queryByTestId("suggestion-pill")).toBeNull();
  });

  // THE finding, stated as the harm rather than the symptom. The click is performed for real if any
  // pill is up, so a regression that re-renders A's action under B doesn't just fail a
  // queryByText — it actually dispatches, and the routing assertion below catches it by name.
  it("cannot route A's prompt into B's terminal", async () => {
    await aimAtAThenB();
    // Click A's action if it is anywhere on screen. `queryByText` on the LABEL (not the pill's
    // container div, which carries no handler) is what makes this a real click rather than a
    // no-op that would pass regardless.
    const stale = screen.queryByText(A_ACTION.label);
    if (stale) fireEvent.click(stale);
    await Promise.resolve();
    // The routing assertion is by VALUE, so it names the exact harm: A's prose reaching B's PTY.
    const sentToB = h.dispatchConciergeAnswer.mock.calls.filter((c) => c[1] === A_ACTION.value);
    expect(sentToB).toEqual([]);
    // …and nothing at all was dispatched, because there was nothing to click.
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // The user's DRAFT must survive a re-aim. Resetting the suggestion state by remounting the COLUMN
  // (the other candidate fix) would have taken ComposeBox's text down with it — turning a fix for
  // one silent data loss into another, on the surface whose own comments call retyping a paragraph
  // "the worst possible outcome of a failed send". The keyed remount that IS used is scoped to
  // ConciergeSuggestions, a sibling of the compose box, precisely so this holds.
  it("keeps the user's typed draft across the re-aim", async () => {
    h.computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    const { rerender } = render(<ConciergeHost feed={FEED} promptTarget={AIM_A} />);
    fireEvent.change(box(), { target: { value: "a paragraph nobody wants to retype" } });
    await act(async () => {
      rerender(<ConciergeHost feed={FEED} promptTarget={AIM_B} />);
    });
    expect(box().value).toBe("a paragraph nobody wants to retype");
  });

  // …and the box keeps working afterwards: a draft that survives but can no longer be sent, or is
  // sent to the agent the user aimed AWAY from, would be a hollow guarantee.
  it("sends that surviving draft to B, not to A", async () => {
    h.computeSuggestions.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<ConciergeHost feed={FEED} promptTarget={AIM_A} />);
    fireEvent.change(box(), { target: { value: "carry on" } });
    await act(async () => {
      rerender(<ConciergeHost feed={FEED} promptTarget={AIM_B} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    // The router is stubbed to "sparkle", so nothing reaches a PTY — what matters is that the
    // draft was still there to send and the box cleared normally.
    expect(box().value).toBe("");
    expect(h.startConciergeTurn).toHaveBeenCalledWith(expect.stringContaining("carry on"));
  });

  it("offers B's OWN action once B's compute lands, and sends B's text", async () => {
    await aimAtAThenB({ buttons: [B_ACTION] });
    await screen.findByText(B_ACTION.label);
    await act(async () => {
      fireEvent.click(screen.getByText(B_ACTION.label));
    });
    // Through the SAME dispatch a typed message takes — userPrompt: true, with the display and
    // naming renderings a typed prompt would carry, and now the authority every concierge-
    // originated dispatch must declare (services/dispatchAuthority). A pill click is a direct user
    // gesture on a named agent, so it carries `suggestion` and dispatches IMMEDIATELY — no
    // countdown, unlike a routed typed message, which arms an intent first.
    await waitFor(() =>
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag2", B_ACTION.value, {
        userPrompt: true,
        display: B_ACTION.value,
        namingBasis: B_ACTION.value,
        // FALSE for every send in this file: none of them is @-addressed, so each keeps the
        // picker-keystroke path it always had (services/conciergeDispatch neverPickerAnswer).
        neverPickerAnswer: false,
        authority: { kind: "suggestion", agentId: "ag2" },
      }),
    );
  });

  // The engine is re-scoped to the agent the box now points at — it must not keep reading (and,
  // with learned actions on, keep BUYING computes against) the agent the user aimed away from.
  it("re-scopes the engine to B rather than continuing to compute for A", async () => {
    await aimAtAThenB();
    await waitFor(() => expect(h.computeSuggestions).toHaveBeenCalled());
    for (const call of h.computeSuggestions.mock.calls as [{ agentId: string }][]) {
      expect(call[0].agentId).toBe("ag2");
    }
  });

  // Default cross-project Sparkle mode: no agent selected. The row must show NOTHING, and the
  // engine must be fully inert — no scrollback read, no metered compute.
  it("shows no pill and buys no compute when the box is aimed at no agent", async () => {
    h.computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    await act(async () => {});
    expect(screen.queryByTestId("suggestion-pill")).toBeNull();
    expect(h.computeSuggestions).not.toHaveBeenCalled();
  });
});
