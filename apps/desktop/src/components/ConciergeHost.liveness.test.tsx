// @vitest-environment jsdom
//
// WHAT THE HUMAN SEES when a concierge turn fails or is silently killed.
//
// Both halves of the 2026-07-29 incident are pinned here, end to end through the real column:
//
//   1. A failed turn used to render one fixed sentence — "I couldn't reach my brain just now" — for
//      every failure there has ever been. All fifteen failures that day carried a quota message with
//      a RESET TIME in it, and the host threw it away at ConciergeHost's error handler. The human
//      spent the day assuming a 529 overload.
//   2. A turn killed by the user's own next message emits nothing at all — no `done`, no `error`, no
//      log — so the displaced question sits in the thread looking answered-by-silence. That happened
//      to 149 of 378 turns that day, and to 12 of the 14 in the 20:18-20:31 burst.
//
// Neither needs a clock, which is why they live here rather than in the timing suites
// (services/conciergeLiveness.test, Concierge/ThinkingIndicator.test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  /** Turn ids the PROACTIVE push channel opened. A knob, so a row can drive an error for a turn
   *  nobody asked for — the real module keeps this list itself (services/concierge). */
  proactiveIds: [] as string[],
  // HOISTED, not inline in the factory below. `vi.resetAllMocks()` in afterEach strips a mock's
  // implementation, and a router that resolves `undefined` leaves `deliver` never reaching
  // `setReceipt` — so every row after the first would assert against a thread with no receipts at
  // all and the orphan-stamp rows would pass vacuously. Restored in afterEach.
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; sessionId: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
  },
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// The REAL sentinels and the REAL matcher pulled through the factory, so the superseded rows below
// use the same literals Rust emits rather than hand-copies that can drift.
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: h.startConciergeTurn,
    startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
    isProactiveTurn: (id: string) => h.proactiveIds.includes(id),
    onConciergeDelta: (cb: NonNullable<typeof h.brain.delta>) => {
      h.brain.delta = cb;
      return () => {};
    },
    onConciergeDone: (cb: NonNullable<typeof h.brain.done>) => {
      h.brain.done = cb;
      return () => {};
    },
    onConciergeError: (cb: NonNullable<typeof h.brain.error>) => {
      h.brain.error = cb;
      return () => {};
    },
  };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: () => true,
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
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));

import { ConciergeHost } from "./ConciergeHost";
import { SUPERSEDED_DETAILS } from "../services/concierge";
import { noteConciergeToolCall } from "../services/conciergeActivity";
import { UNKNOWN_FAILURE_HEADLINE } from "../engine/conciergeFailureNotice";
import {
  _resetConciergeLivenessForTests,
  useConciergeLivenessStore,
} from "../services/conciergeLiveness";
import { UNAVAILABLE_FAILURE_RUN } from "../engine/conciergeLiveness";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, running: 1, done: 0 };

/** A one-agent feed — enough for the column to render its thread. */
function feed(): ConciergeFeed {
  const agent = {
    id: "ag1",
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
  enableAiEnhancementsForTests();
  _resetConciergeLivenessForTests();
  h.proactiveIds = [];
});

afterEach(() => {
  cleanup();
  // resetAllMocks, not clearAllMocks — see the main host suite. Both mocks the send path actually
  // depends on have to be put back, or the NEXT row silently loses its routing.
  vi.resetAllMocks();
  h.startConciergeTurn.mockResolvedValue(null);
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
});

/** Routing is a promise and every delivery chains behind the last, so nothing lands in the tick the
 *  click happens in. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function send(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByText("Send"));
  await flush();
}

function threadText(): string {
  return screen.getByTestId("concierge-thread").textContent ?? "";
}

describe("a turn that FAILS says what actually went wrong", () => {
  // THE REGRESSION TEST. Every one of these strings was logged on 2026-07-29 and shown to the human
  // as "I couldn't reach my brain just now". The reset time is the single most useful thing the app
  // knows at that moment and it cannot be re-derived from anywhere else.
  it.each([
    "You've hit your session limit · resets 8:40am (America/Bogota)",
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
  ])("renders %s verbatim in the thread", async (detail) => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail }));
    expect(threadText()).toContain(detail);
  });

  it("stops telling the user to retry a limit that retrying cannot clear", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() =>
      h.brain.error?.({
        id: "7",
        detail: "You've hit your session limit · resets 8:40am (America/Bogota)",
      }),
    );
    // The old copy is the WRONG advice here — this is the sentence the fix exists to stop showing
    // for a quota failure, and asserting only on the new text would let it come back alongside.
    expect(threadText()).not.toContain(UNKNOWN_FAILURE_HEADLINE);
  });

  // The classifier must never become the thing that decides whether the user is told anything. An
  // unrecognised failure keeps the sentence the column has always shown AND gains the evidence.
  it("carries the evidence for a failure it cannot classify", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "zsh: command not found: claude" }));
    expect(threadText()).toContain(UNKNOWN_FAILURE_HEADLINE);
    expect(threadText()).toContain("zsh: command not found: claude");
  });

  // Evidence goes through NO markdown renderer: it is a machine string, and `_` / `*` in a stderr
  // dump are characters, not formatting. A renderer would silently eat them.
  it("does not let markdown syntax in the evidence be interpreted", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "failed at _step_ *2*" }));
    expect(screen.getByTestId("concierge-failure-evidence").textContent).toBe("failed at _step_ *2*");
  });

  // PR #649 decided which failures must STAY silent. A supersede sentinel is the user's own newer
  // send displacing this turn, not a failure to report — surfacing it would undo that.
  it.each(SUPERSEDED_DETAILS.map((d) => [d] as const))(
    "stays silent for the %s sentinel",
    async (detail) => {
      render(<ConciergeHost feed={feed()} />);
      await send("what needs me?");
      act(() => h.brain.error?.({ id: "9", detail }));
      expect(screen.queryByTestId("concierge-failure")).toBeNull();
    },
  );
});

describe("a message the brain never answered says so", () => {
  // THE 20:18-20:31 BURST. Each send kills the turn before it; the killed reader emits NOTHING, so
  // the only place this can be detected is here, locally, at the moment of the next send.
  it("stamps the displaced bubble when nothing ever came back for it", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    // The receipt EXISTS before the second send. Without this the row below could pass simply
    // because no receipt renders at all in this harness (which is exactly how it first failed).
    expect(threadText()).toContain("Answered here");
    expect(threadText()).not.toContain("never answered");

    await send("what needs me right now?");
    expect(threadText()).toContain("Replaced by your next message — never answered");
  });

  // A TOOL CALL IS NOT AN ANSWER (roborev 55442-M1). Reading state or a terminal before replying is
  // the concierge's normal FIRST move, so this is the ORDINARY shape of a dropped question, not a
  // corner case. Asking the liveness flag — which a tool call sets — exempted exactly these bubbles
  // and left them reading "Answered here".
  it("still stamps a bubble whose turn only called a tool", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "ag1" }));

    await send("what needs me right now?");
    expect(threadText()).toContain("Replaced by your next message — never answered");
  });

  // A turn that streamed a partial answer the user then interrupted is NOT this. They got words;
  // stamping it "never answered" would be the same class of lie in the other direction.
  it("leaves a bubble alone when its turn did stream something", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.delta?.({ id: "7", text: "Three agents " }));
    expect(threadText()).toContain("Answered here");

    await send("what needs me right now?");
    expect(threadText()).not.toContain("never answered");
  });

  it("leaves an ANSWERED bubble alone when the user simply asks something else", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.done?.({ id: "7", sessionId: "s1", text: "Nothing right now." }));
    expect(threadText()).toContain("Answered here");

    await send("and after that?");
    expect(threadText()).not.toContain("never answered");
  });

  // A failure already told the user what happened. Stamping "never answered" on top of the error it
  // is carrying would be a second, contradictory account of the same turn.
  it("leaves a bubble that got an ERROR alone", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "boom" }));
    expect(threadText()).toContain("Answered here");

    await send("try again?");
    expect(threadText()).not.toContain("never answered");
  });
});

// ── A PUSH NOBODY ASKED FOR IS NOT A QUESTION THAT WENT UNANSWERED ──────────────────────────────
//
// roborev 55442-M2. `offDone` already stands down for the proactive channel; `offError` did not, so
// a push's failure posted a bubble and fed the outage detector for a conversation the user never
// started — three failed pushes would raise the sticky strip on their own. services/concierge
// filters pushes before the fan-out today, so this was latent rather than live; the asymmetry and
// the invariant engine/conciergeLiveness's header claims were both real.
describe("the proactive push channel drives none of this", () => {
  it("posts no failure bubble for a push the user never requested", async () => {
    render(<ConciergeHost feed={feed()} />);
    h.proactiveIds = ["99"];
    act(() => h.brain.error?.({ id: "99", detail: "boom" }));
    expect(screen.queryByTestId("concierge-failure")).toBeNull();
  });

  it("a run of failed pushes cannot raise the outage state", async () => {
    render(<ConciergeHost feed={feed()} />);
    h.proactiveIds = ["99"];
    for (let i = 0; i < UNAVAILABLE_FAILURE_RUN + 1; i += 1) {
      act(() => h.brain.error?.({ id: "99", detail: "boom" }));
    }
    expect(useConciergeLivenessStore.getState().failureRun).toBe(0);
  });

  // The control: the same detail on a turn the USER started does everything above.
  it("but a user turn's failure still does all of it", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "boom" }));
    expect(screen.getByTestId("concierge-failure")).toBeTruthy();
    expect(useConciergeLivenessStore.getState().failureRun).toBe(1);
  });
});
