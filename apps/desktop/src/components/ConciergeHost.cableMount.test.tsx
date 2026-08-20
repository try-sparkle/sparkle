// @vitest-environment jsdom
//
// THE MOUNT IS THE CABLE — the founder's words follow the gesture he made, not the pane he is
// looking at (bead sparkle-9gsjqm, a P0 he has reported repeatedly).
//
// ══ WHY THIS IS A SEPARATE FILE FROM `ConciergeHost.mounted.test.tsx` ═══════════════════════════
// That suite is STRUCTURALLY INCAPABLE of seeing this defect, and that incapacity — not the routing
// bug — is why the bug kept coming back. Two of its fixtures do it:
//
//   • it MOCKS `hooks/useEffectiveWired` and drives the mount through that one knob. But
//     `useEffectiveWired` is a DRAWING projection ("USE THIS FOR VISUAL TREATMENT ONLY", its own
//     header), and the defect is precisely that a drawing rule was being used as a routing
//     authority. A suite that stubs it has replaced the collaborator under test with an oracle;
//   • it passes `promptTarget` in as a PROP, so the state that matters — CABLE ON, `promptTarget`
//     NULL — is unreachable there. Its one "goes to the concierge" row gets there by setting
//     `wired` to `"off"`, i.e. by unmounting.
//
// So NOTHING here mocks the cable, the projection, or the resolution. The cable store is REAL and is
// patched exactly as `AgentRow`/`AgentSidebar` patch it (`useCableStore.getState().patch(side, id)`),
// the roster is the REAL `projectStore`, and `useEffectiveWired` runs its real join. Every row below
// FAILS on `origin/main`, and each one fails by delivering the founder's words to the concierge (or
// to the wrong PTY) rather than to the agent he mounted.
//
// ══ WHAT EACH ROW ASSERTS, AND WHY BOTH HALVES ═════════════════════════════════════════════════
// Absence alone is half a test: "no concierge turn" passes for a build that delivers NOTHING. So the
// routing rows assert the POSITIVE too — `dispatchConciergeAnswer` was called, at that agent, with
// those words — which is the capability the founder is asking for, not an internal label.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  useHasAiCredits: vi.fn(() => true),
  aiEnhancementsEnabled: vi.fn(() => true),
  ConciergeAiDisabledError: class ConciergeAiDisabledError extends Error {},
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(
    async (_agentId: string, _text: string, _opts?: unknown) =>
      ({ ok: true, path: "free-text" }) as { ok: boolean; path: string; heldReason?: "screen" },
  ),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
  viewport: vi.fn((_agentId: string) => CLEAN as null | { text: string; alternateBuffer: boolean }),
  /** The live `onDeferredSendOutcome` listener, captured at mount so the hold-expiry row can fire a
   *  real outcome at the host rather than asserting against a stub that never calls back. */
  deferredOutcome: undefined as
    | undefined
    | ((r: {
        ok: boolean;
        agentId: string;
        path: string;
        heldReason?: "screen";
        sent?: string;
        display?: string;
      }) => void),
}));

/** A terminal sitting at an ordinary Claude Code prompt — nothing that blocks a write. */
const CLEAN = { text: "> \n", alternateBuffer: false };

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  ConciergeAiDisabledError: h.ConciergeAiDisabledError,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeTool: () => () => {},
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
  agentCanAcceptInput: (id: string) => h.agentCanAcceptInput(id),
  agentCanAcceptPrompt: (id: string) => h.agentCanAcceptInput(id),
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: (id: string, t: string) => h.answersLivePicker(id, t),
  onDeferredSendOutcome: (cb: NonNullable<typeof h.deferredOutcome>) => {
    h.deferredOutcome = cb;
    return () => {};
  },
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
// ══ NOT MOCKED, DELIBERATELY: `hooks/useEffectiveWired` ════════════════════════════════════════
// See this file's header. Stubbing it is what made the sibling suite blind, and re-stubbing it here
// would reproduce that blindness rather than the bug.
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: (id: string) => h.viewport(id),
  registerViewport: () => () => {},
  resetViewportRegistry: () => {},
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: h.useHasAiCredits,
  aiEnhancementsEnabled: h.aiEnhancementsEnabled,
}));

// The app-owned Improve-Sparkle agent is DELIBERATELY never a `project.agents` member
// (services/knownAgents), so `isPromptableTarget`/`agentStillExists` reach it through the `sparkle`
// arm alone. Unmocked, both answer "no such agent" and a send aimed at it is reduced to "no usable
// aim" BEFORE routing matters — which would make the Improve-Sparkle rows below pass against the
// unfixed code. `importOriginal` so only this one arm is steered.
vi.mock("../services/knownAgents", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/knownAgents")>();
  return {
    ...real,
    findKnownAgent: (agentId: string) =>
      agentId.startsWith("__sparkle_self__")
        ? { id: agentId, name: "Sparkle", source: "sparkle" as const, runtime: "local" as const }
        : real.findKnownAgent(agentId),
  };
});

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
  mergeOpenAgentIds: vi.fn((inMemory: string[], persisted: string[], add?: string) => [
    ...new Set([...inMemory, ...persisted, ...(add ? [add] : [])]),
  ]),
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { armedIntents, clearAllIntents, fireIntent } from "../services/dispatchIntent";
import { usePresenceStore } from "../stores/presenceStore";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useCableStore, resetCable } from "../stores/cableStore";
import { useUiStore, SPARKLE_PANE_SIDE } from "../stores/uiStore";
import { MOUNTED_NOTICE_TESTID } from "./Concierge/MountedNotice";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";

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
    band: "done" as const,
    inScope: true,
    muted: false,
    topLevel: true,
  };
}
const COUNTS = { needs_you: 0, questions: 0, running: 0, done: 2 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [agent("ag1", "Blueprint UI/UX"), agent("ag2", "Kraken Auth")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** What `Workspace` hands down while the Improve-Sparkle pane is the visible surface: its
 *  `sparkleTarget`, which WINS over the roster path inside `decidePromptTarget`. Spelled with the
 *  real constants because the defect is a consequence of those exact values. */
const SPARKLE_TARGET: ConciergePromptTarget = {
  projectId: "",
  agentId: SPARKLE_AGENT_ID,
  name: SPARKLE_AGENT_NAME,
};

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const notice = () => screen.getByTestId(MOUNTED_NOTICE_TESTID);

/** The REAL roster the mount resolves its name and project through. */
function seedRoster() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: [
          { id: "ag1", name: "Blueprint UI/UX", worktreePath: "/tmp/wt/ag1" },
          { id: "ag2", name: "Kraken Auth", worktreePath: "/tmp/wt/ag2" },
        ],
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
}

/** THE MOUNTING GESTURE, spelled exactly as `AgentRow`/`AgentSidebar` spell it. Nothing else in this
 *  file mounts anything — that is the point of the suite. */
function mountCableAt(side: "left" | "right", agentId: string) {
  act(() => {
    useCableStore.getState().patch(side, agentId);
  });
}

beforeEach(() => {
  h.useHasAiCredits.mockReturnValue(true);
  h.aiEnhancementsEnabled.mockReturnValue(true);
  useSettingsStore.setState({ aiConcierge: true } as never);
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.dispatchConciergeAnswer.mockReset();
  h.dispatchConciergeAnswer.mockResolvedValue({ ok: true, path: "free-text" });
  h.startConciergeTurn.mockReset();
  h.startConciergeTurn.mockResolvedValue(null);
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.agentCanAcceptInput.mockReset();
  h.agentCanAcceptInput.mockReturnValue(true);
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
  h.viewport.mockReset();
  h.viewport.mockReturnValue(CLEAN);
  // HERE, so a mounted send takes the immediate path rather than arming a countdown.
  usePresenceStore.getState().reset();
  resetCable();
  useUiStore.setState({ activeSpecial: null } as never);
  seedRoster();
});
afterEach(() => {
  vi.useRealTimers();
  clearAllIntents();
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [] });
  resetCable();
  useUiStore.setState({ activeSpecial: null } as never);
});

async function send(text: string) {
  const ta = box();
  fireEvent.change(ta, {
    target: { value: text, selectionStart: text.length, selectionEnd: text.length },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

/** Let any armed countdown elapse. A no-op after an immediate mounted send — kept so a regression
 *  that re-armed one surfaces on the `armedIntents()` assertions rather than being absorbed here. */
async function elapse() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Which agent did the founder's words actually reach? `null` when nothing was dispatched. */
function dispatchedTo(): { agentId: string; text: string } | null {
  const call = h.dispatchConciergeAnswer.mock.calls[0];
  return call ? { agentId: call[0], text: call[1] } : null;
}

describe("ConciergeHost — a mounted send follows the CABLE, never the surface", () => {
  // ══ (a) THE HEADLINE STATE: CABLE ON, `promptTarget` NULL ═════════════════════════════════════
  // The state the sibling suite cannot reach at all. On `origin/main` `mountedAgentId` is
  // `wired !== "off" ? target?.agentId : null` — both halves fail here (the projection reads the far
  // end as unoccupied, and there is no prompt target) — so the route is `via: "default"` and the
  // founder's line becomes a concierge turn with nothing on screen to say so.
  it("routes a plain message to the PINNED agent even with no promptTarget at all", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt("left", "ag1");
    await send("move the header down 5px");
    await elapse();

    // THE POSITIVE HALF — the capability the founder is asking for: his words reached that agent.
    expect(dispatchedTo()).toEqual({ agentId: "ag1", text: "move the header down 5px" });
    // …and the negative one. Asserting only this would pass for a build that delivers nothing.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // ══ (b) REPRODUCTION A — MOUNT IMPROVE SPARKLE, THEN NAVIGATE THE RIGHT COLUMN AWAY ══════════
  // `sparkleTarget` is non-null ONLY while `activeSpecial === "sparkle"`, so navigating to a build
  // tab, the Plan board or Preview nulls `promptTarget` — while the cable stays patched FOREVER,
  // because `engine/cable.pinnedFarEndIsGone` deliberately exempts the app-owned agent from the
  // unbind. Cable patched, route null: every message from then on went to the concierge.
  it("keeps routing to Improve Sparkle after the right column navigates elsewhere", async () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const view = render(<ConciergeHost feed={FEED} promptTarget={SPARKLE_TARGET} />);
    mountCableAt(SPARKLE_PANE_SIDE, SPARKLE_AGENT_ID);

    // He navigates away: the pane is no longer the active surface, so Workspace stops producing a
    // `sparkleTarget`. NOTHING unpatches the cable — that is the whole shape of the bug.
    act(() => {
      useUiStore.setState({ activeSpecial: null } as never);
    });
    view.rerender(<ConciergeHost feed={FEED} promptTarget={null} />);

    await send("check whether the retry lands");
    await elapse();

    expect(dispatchedTo()).toEqual({
      agentId: SPARKLE_AGENT_ID,
      text: "check whether the retry lands",
    });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // ══ (c) REPRODUCTION B — A BUILD AGENT IS MOUNTED, THEN THE IMPROVE-SPARKLE PANE OPENS ═══════
  // `decidePromptTarget`'s `special` arm "wins over the roster path", so merely REVEALING that pane
  // re-aimed `promptTarget` — and therefore the mount — at `__sparkle_self__`. The founder's words
  // went to the wrong PTY because a different pane became visible. A pane becoming visible is not a
  // mounting gesture.
  it("does not re-aim a mounted build agent at Sparkle when the Improve-Sparkle pane appears", async () => {
    const view = render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt(SPARKLE_PANE_SIDE, "ag1");

    // The Improve-Sparkle pane is revealed. `activeSpecial` flips and Workspace's `sparkleTarget`
    // takes over `promptTarget` — exactly what it hands down in this state.
    act(() => {
      useUiStore.setState({ activeSpecial: "sparkle" } as never);
    });
    view.rerender(<ConciergeHost feed={FEED} promptTarget={SPARKLE_TARGET} />);

    await send("ship the branch");
    await elapse();

    expect(dispatchedTo()).toEqual({ agentId: "ag1", text: "ship the branch" });
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // ══ (d) A MOUNT THAT CANNOT BE RESOLVED REFUSES WHERE HE CAN SEE IT ══════════════════════════
  // The one state where the pin and the resolved mount legitimately differ. It must NOT collapse
  // into "nothing is mounted": that is `via: "default"`, i.e. the silent concierge turn this whole
  // bead is about. The words stay in the box and the notice names who they were for.
  it("refuses visibly and keeps the draft when the pinned agent cannot be resolved", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt("right", "ag1");
    // The roster goes away underneath a live cable — a project closing, a cold reload. The cable is
    // still patched, so he is still mounted; this window just cannot name the far end right now.
    act(() => {
      useProjectStore.setState({ projects: [] });
    });

    await send("do not lose these words");
    await elapse();

    // NO concierge turn, and no dispatch at an id nothing could resolve.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // VISIBLE, on the surface a mounted column actually shows, and it NAMES the agent it was for.
    expect(notice().textContent).toContain("Blueprint UI/UX");
    // And his words are still his. This is the half that makes the refusal cost nothing.
    expect(box().value).toContain("do not lose these words");
  });

  // ══ THE LAST ROAD TO THE CONCIERGE, CLOSED ═══════════════════════════════════════════════════
  // `deliver`'s `addressed && !addressable` arm posted an explanation and then FELL THROUGH to
  // `askSparkle`, with no `restoreDraft` and no retract — so even a perfectly resolvable mount became
  // a concierge turn the moment `agentCanAcceptPrompt` said no, which for the app-owned agent
  // includes a transient `liveness === "unknown"`. The founder's rule from today's interview is that
  // the concierge must NOT answer a mounted send, so this refuses and hands the words back instead.
  it("refuses rather than asking the concierge when the mounted agent cannot take a prompt", async () => {
    h.agentCanAcceptInput.mockReturnValue(false);
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt("left", "ag1");
    await send("try this branch instead");
    await elapse();

    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(notice().textContent).toContain("Blueprint UI/UX");
    expect(box().value).toContain("try this branch instead");
  });

  // ══ (e) A HELD MOUNTED SEND THAT AGES OUT HANDS THE WORDS BACK ═══════════════════════════════
  // A screen hold is created by exactly one caller — a MOUNTED send — so a dropped one is the
  // founder's mounted message. It used to be QUOTED into a Sparkle chat line with only the
  // attachments restored, which is this same conversion arriving by the slow road: the copy told him
  // to send it again while the words existed nowhere he could send them from.
  it("restores the draft when a held mounted send expires", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt("left", "ag1");
    expect(box().value).toBe("");

    await act(async () => {
      h.deferredOutcome?.({
        ok: false,
        agentId: "ag1",
        path: "expired",
        heldReason: "screen",
        sent: "the thing I asked for",
        display: "the thing I asked for",
      });
      await Promise.resolve();
    });

    expect(box().value).toContain("the thing I asked for");
  });

  // ══ AND THE ESCAPE HATCH IS UNTOUCHED ════════════════════════════════════════════════════════
  // Deriving the mount from the cable must not weaken the one documented way OUT of a mount, which
  // is the founder's own rule. Without this row, "route everything at the pin" would pass every
  // assertion above while having silently swallowed `@Sparkle`.
  it("still lets a leading @Sparkle reach the concierge from inside a mount", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    mountCableAt("left", "ag1");
    await send("@Sparkle what is Blueprint up to?");
    await elapse();

    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // ══ AND AN UNPATCHED CABLE IS STILL THE CONCIERGE ════════════════════════════════════════════
  // The mirror of (a), and the row that keeps the fix from being "always route at something". With
  // nothing patched there is no mount and no pin, so a plain message is a question for the brain —
  // which is what it has always been.
  it("sends a plain message to the concierge when nothing is patched", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={null} />);
    await send("what should I look at next?");
    await elapse();

    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });
});
