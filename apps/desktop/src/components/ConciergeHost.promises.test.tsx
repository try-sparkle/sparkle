// @vitest-environment jsdom
//
// AN OVERDUE PROMISE REACHES THE THREAD — the WIRING, not the wording.
//
// ══ WHY THIS FILE HAD TO EXIST (roborev 58101) ══════════════════════════════════════════════════
// THE THIRD TIME THIS SHAPE HAS APPEARED IN THIS LINE OF WORK. The commit before this one existed
// precisely because CI's dormant-module guard refused a ledger reachable only from its own test —
// and it wired the ledger WITHOUT a test of the wiring. Every promise-ledger assertion targeted the
// pure core and would stay green if the `concierge:done` block were deleted again.
//
// A wiring bug needs a wiring test: this renders the real `ConciergeHost`, drives real `done`
// events, and asserts the overdue line appears in the real thread. Verified to FAIL with the block
// removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  getConfig: vi.fn(async () => ({ config: {} })),
  onConfigChanged: vi.fn(async () => () => {}),
  delta: undefined as ((e: { id: string; text: string }) => void) | undefined,
  done: undefined as
    | ((e: { id: string; sessionId: string; text: string; toolCalls?: unknown[] }) => void)
    | undefined,
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: h.startConciergeTurn,
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: () => false,
    onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
      h.delta = cb;
      return () => {};
    },
    onConciergeDone: (cb: (e: { id: string; sessionId: string; text: string; toolCalls?: unknown[] }) => void) => {
      h.done = cb;
      return () => {};
    },
    onConciergeError: () => () => {},
    // The live per-tool status channel (`concierge:tool`). This mock is TOTAL — the host imports
    // every subscriber it uses — so a new one must be stubbed here or the module throws at import
    // and every case in the file dies before it runs. Git merged the two branches cleanly; nothing
    // but the suite could catch that the mock had gone stale.
    onConciergeTool: () => () => {},
    onConciergeTurnsAbandoned: () => () => {},
  };
});
vi.mock("../services/config", () => ({
  getConfig: h.getConfig,
  onConfigChanged: h.onConfigChanged,
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { CONCIERGE_THREAD_TESTID } from "../engine/composeBoxHeight";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { clearPromiseLedger } from "../services/conciergePromiseLedger";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, running: 1, done: 0 };
const AGENT_ID = "11111111-2222-3333-4444-555555555555";

function feed(): ConciergeFeed {
  const agent = {
    id: AGENT_ID,
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "working",
    statusColor: "#e0533f",
    statusLabel: "Working",
    band: "running" as StatusBand,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      {
        id: "p1",
        name: "sparkle",
        inScope: true,
        counts: COUNTS,
        scopedCounts: COUNTS,
        agents: [agent],
      },
    ],
    counts: COUNTS,
    scopedCounts: COUNTS,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

beforeEach(() => {
  // The thread is a MODULE-LEVEL persisted store, so it outlives `cleanup()`.
  useConciergeThreadStore.setState({ chat: [] });
  clearPromiseLedger();
  enableAiEnhancementsForTests();
  h.getConfig.mockResolvedValue({ config: {} });
  h.onConfigChanged.mockImplementation(async () => () => {});
});

afterEach(() => {
  cleanup();
  clearPromiseLedger();
  vi.resetAllMocks();
});

/** The THREAD, not the document. The column also mounts a single aria-live announcer that carries
 *  the same spoken sentence, so an unscoped `getByText` matches twice and throws. */
function thread(): HTMLElement {
  return screen.getByTestId(CONCIERGE_THREAD_TESTID);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ConciergeHost — an overdue promise reaches the thread", () => {
  /** Drive one finished concierge turn. */
  function turn(id: string, text: string, toolCalls: unknown[] = []) {
    act(() => {
      h.done?.({ id, sessionId: "s1", text, toolCalls });
    });
  }

  it("posts the overdue line after the grace window, quoting what was said", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    turn("t1", "Say go and I'll spawn it.");
    turn("t2", "Still looking at it.");
    turn("t3", "Nothing new.");

    // ONE element carrying both halves — the report AND the quote. Asserting the quote on its own
    // would match the original reply bubble too, which is still in the thread and should be.
    await waitFor(() => {
      expect(
        within(thread()).getByText(/You said you'd spawn an agent.*I'll spawn it.*hasn't happened/),
      ).toBeTruthy();
    });
  });

  it("stays quiet inside the grace window — the positive control", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    turn("t1", "Say go and I'll spawn it.");
    turn("t2", "Still looking.");
    await flush();

    expect(within(thread()).queryByText(/You said you'd/)).toBeNull();
  });

  it("says nothing when the promise was KEPT", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    turn("t1", "I'll spawn it.");
    turn("t2", "Done.", [
      { name: "mcp__sparkle-control__sparkle_lifecycle", input: JSON.stringify({ op: "spawn_build_agent", args: {} }) },
    ]);
    turn("t3", "Anything else?");
    await flush();

    expect(within(thread()).queryByText(/You said you'd/)).toBeNull();
  });

  it("reports ONCE, not on every later turn", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    turn("t1", "Say go and I'll spawn it.");
    turn("t2", "…");
    turn("t3", "…");
    await waitFor(() => expect(within(thread()).getAllByText(/You said you'd/).length).toBe(1));

    turn("t4", "…");
    turn("t5", "…");
    await flush();

    // An alarm that repeats every turn is one the reader learns to ignore.
    expect(within(thread()).getAllByText(/You said you'd/).length).toBe(1);
  });

  it("detects a promise on a turn whose `done` carries NO text", async () => {
    // The handler documents that a `done` can arrive with no text — "a turn whose deltas said
    // everything". Reading only `e.text` skipped detection for every one of those (roborev 58101).
    render(<ConciergeHost feed={feed()} />);
    await flush();

    act(() => {
      h.delta?.({ id: "t1", text: "Say go and I'll spawn it." });
      h.done?.({ id: "t1", sessionId: "s1", text: "", toolCalls: [] });
    });
    turn("t2", "…");
    turn("t3", "…");

    await waitFor(() => {
      expect(within(thread()).getByText(/You said you'd spawn an agent/)).toBeTruthy();
    });
  });
});
