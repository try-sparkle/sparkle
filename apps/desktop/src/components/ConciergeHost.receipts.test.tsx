// @vitest-environment jsdom
//
// A RECEIPT REACHES THE THREAD — the WIRING, not the wording.
//
// ══ WHY THIS FILE HAD TO EXIST ══════════════════════════════════════════════════════════════════
// roborev 57866 (Medium), and the irony is the point. The defect this feature's last commit fixed
// was "an emitter with no subscriber, invisible to git and to the suite": three worker branches
// merged clean, every test green, and `recordConciergeActionReceipt` was fanning out to an empty
// listener set. The fix added the `useEffect` — with sixteen tests that all target the PURE
// `actionReceiptLine` and would stay green if that effect were deleted again.
//
// So the exact regression could silently recur, including via the `_resetConciergeReceiptsForTests`
// trap the module header warns about. A wiring bug needs a wiring test: this file renders the real
// `ConciergeHost`, records a real receipt, and asserts the sentence appears in the real thread.
// Verified to FAIL with the subscription removed.
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
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
    // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
    // 'turn not remembered', which the rotation degrades on.
    turnAccountFor: () => null,
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: h.startConciergeTurn,
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: () => false,
    onConciergeDelta: () => () => {},
    onConciergeDone: () => () => {},
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
import {
  _resetConciergeReceiptsForTests,
  clearPostedReceiptIds,
  nextReceiptId,
  recordConciergeActionReceipt,
  type ConciergeActionReceipt,
} from "../services/conciergeReceipts";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 1, done: 0 };
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

function receipt(over: Partial<ConciergeActionReceipt> = {}): ConciergeActionReceipt {
  return {
    id: nextReceiptId(),
    kind: "spawned",
    ok: true,
    agentId: AGENT_ID,
    agentName: "CI Hardening",
    at: 1_769_649_600_123,
    op: "lifecycle.spawn_build_agent",
    ...over,
  };
}

beforeEach(() => {
  // The thread is a MODULE-LEVEL persisted store, so it outlives `cleanup()`.
  useConciergeThreadStore.setState({ chat: [] });
  _resetConciergeReceiptsForTests();
  clearPostedReceiptIds();
  enableAiEnhancementsForTests();
  h.getConfig.mockResolvedValue({ config: {} });
  h.onConfigChanged.mockImplementation(async () => () => {});
});

afterEach(() => {
  cleanup();
  _resetConciergeReceiptsForTests();
  clearPostedReceiptIds();
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

describe("ConciergeHost — action receipts reach the thread", () => {
  it("posts the receipt's sentence into the thread", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    act(() => {
      recordConciergeActionReceipt(receipt());
    });

    // THE SIDE EFFECT: the sentence is on screen. Asserting that a listener was registered would
    // prove nothing — that is exactly the shape of test that let the missing subscriber ship.
    await waitFor(() => {
      expect(within(thread()).getByText(/The concierge spawned/)).toBeTruthy();
    });
  });

  it("posts a REFUSAL too — 'I couldn't' is the answer to 'why didn't it'", async () => {
    render(<ConciergeHost feed={feed()} />);
    await flush();

    act(() => {
      recordConciergeActionReceipt(
        receipt({ kind: "closed", ok: false, reason: "it is mid-commit" }),
      );
    });

    await waitFor(() => {
      expect(within(thread()).getByText(/Refused the concierge's close of/)).toBeTruthy();
    });
  });

  it("posts NOTHING for a receipt with no sentence — the positive control", async () => {
    // Without this the rows above would pass against a host that posts a line for everything,
    // including receipts the app cannot phrase.
    render(<ConciergeHost feed={feed()} />);
    await flush();
    const before = useConciergeThreadStore.getState().chat.length;

    act(() => {
      recordConciergeActionReceipt(
        receipt({ kind: "teleported" as ConciergeActionReceipt["kind"] }),
      );
    });
    await flush();

    expect(useConciergeThreadStore.getState().chat.length).toBe(before);
  });

  // ══ THE REPLAY + DEDUPE PAIR (roborev 57866) ══════════════════════════════════════════════════
  it("shows a receipt recorded while the host was UNMOUNTED", async () => {
    // App.tsx: "ConciergeHost unmounts when no project is open". A receipt settling in that window
    // used to be fanned out to an empty listener set and lost — which, in a feature whose contract
    // is that a MISSING receipt is evidence, invents proof that the action never happened.
    act(() => {
      recordConciergeActionReceipt(receipt({ kind: "merged", prNumber: 1184, agentId: undefined }));
    });

    render(<ConciergeHost feed={feed()} />);
    await flush();

    // READ THE THREAD'S `textContent`, NOT `getByText`. A PR number written by the app is now a
    // REFERENCE — `actionReceiptLine` composes this line with `pr()`, so the renderer hands the
    // number to `PrPill` and it lands in its own element (a chiclet when the number resolves to a
    // repository, a `display: contents` wrapper when it does not). `getByText`'s default matcher
    // reads only an element's DIRECT text-node children, so the paragraph now measures as
    // "Merged PR ." and matches nothing — the sentence the reader sees is unchanged, and the
    // assertion silently stopped being able to see it.
    //
    // This is the wiring test, so what it has to pin is that the SENTENCE reached the thread, and
    // `textContent` is the reading that survives the number being a pill, plain prose, or anything
    // between. The number stays in the assertion: a line that posted without it would be the
    // "Merged." fallback, which is a different receipt.
    await waitFor(() => {
      expect(thread().textContent).toContain("The concierge merged PR #1184.");
    });
  });

  it("does not double a line when the host remounts and the backlog replays", async () => {
    const { unmount } = render(<ConciergeHost feed={feed()} />);
    await flush();
    act(() => {
      recordConciergeActionReceipt(receipt({ kind: "goal" }));
    });
    await waitFor(() =>
      expect(within(thread()).getAllByText(/The concierge set a goal on/).length).toBe(1),
    );

    // Remount: the replay re-delivers the same receipt, and the id dedupe is what stops one action
    // becoming two lines. This is the assertion that makes `ConciergeActionReceipt.id` load-bearing.
    unmount();
    render(<ConciergeHost feed={feed()} />);
    await flush();

    expect(within(thread()).getAllByText(/The concierge set a goal on/).length).toBe(1);
  });
});
