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
    /** "A different human is here now" — carries no id and no text, on purpose. */
    reset?: () => void;
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
    onConciergeIdentityReset: (cb: NonNullable<typeof h.brain.reset>) => {
      h.brain.reset = cb;
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
import { THINKING_INDICATOR_TESTID } from "./Concierge/ThinkingIndicator";
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

  // THE EFFECT THE GUARD IS FOR (roborev 55468-M2). The two rows above only prove the push does not
  // post a bubble or feed the detector — both of which happen BELOW `setTyping(false)`, so they went
  // green with the guard sitting in the wrong place. This is the one that pins the placement: the
  // user has a question genuinely in flight, a push fails underneath it, and the indicator they are
  // watching must not be the casualty. `offDone` wraps its own `setTyping(false)` in exactly this
  // condition for exactly this reason.
  it("leaves the typing indicator alone for the user turn actually in flight", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    // Precondition, stated rather than assumed — a row that starts with no indicator would "pass"
    // by asserting the absence of something that was never there.
    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).not.toBeNull();

    h.proactiveIds = ["99"];
    act(() => h.brain.error?.({ id: "99", detail: "boom" }));

    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).not.toBeNull();
  });

  // The control: the same detail on a turn the USER started does everything above.
  it("but a user turn's failure still does all of it", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "boom" }));
    expect(screen.getByTestId("concierge-failure")).toBeTruthy();
    expect(useConciergeLivenessStore.getState().failureRun).toBe(1);
    // ...including standing the indicator down, which is what makes the row above a placement test
    // and not just "the guard returns early sometimes".
    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A DIFFERENT HUMAN SIGNS IN MID-TURN (roborev 55813).
//
// services/concierge gates the delta/done/error fan-out on identity, so a turn the previous human
// started has its terminal event DROPPED. That is right for the CONTENT — it is their answer, and
// the column has just been emptied — but `done`/`error` are also the only two signals that stand the
// indicator down, unlatch the liveness escalation, and release the awaiting-bubble marker. None of
// that is store state `resetConciergeIdentityState` can reach, and this component stays mounted
// across sign-out.
//
// So the gate needs a lifecycle signal beside it. These rows pin what the next human must NOT
// inherit: a spinner over an empty column, a sticky "isn't answering" about a turn they never sent.
describe("sign-out mid-turn leaves the next human nothing to inherit", () => {
  it("stands the typing indicator down even though the turn's `done` is refused", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    // Stated, not assumed: a row that starts with no indicator would pass vacuously.
    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).not.toBeNull();

    // The human signs out. The turn is still in flight, so services/concierge bumps the epoch and
    // will swallow the `done` when it lands.
    act(() => h.brain.reset?.());

    expect(screen.queryByTestId(THINKING_INDICATOR_TESTID)).toBeNull();
  });

  it("clears a LATCHED unavailable, so B is not told about a turn A sent", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    // A real failure, so `failure` and `failureRun` are whatever the production path writes. The
    // latch itself is seeded rather than driven: `reduceTick` is the only thing that sets it and it
    // needs the 500ms interval to run, which is the timing suite's subject, not this one's. What is
    // under test here is what the RESET does to the state, however it was reached.
    act(() => h.brain.error?.({ id: "f0", detail: "boom" }));
    act(() => useConciergeLivenessStore.setState({ unavailableLatched: true }));
    expect(useConciergeLivenessStore.getState().unavailableLatched).toBe(true);
    expect(useConciergeLivenessStore.getState().failure).not.toBeNull();

    act(() => h.brain.reset?.());

    expect(useConciergeLivenessStore.getState().unavailableLatched).toBe(false);
    // The whole detector, not just the latch: `failure` is what the sticky strip QUOTES, so leaving
    // it behind would show B the previous human's verbatim error the next time anything escalates.
    expect(useConciergeLivenessStore.getState().failure).toBeNull();
    expect(useConciergeLivenessStore.getState().failureRun).toBe(0);
  });

  it("does not stamp the next human's first send onto the previous human's bubble", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("A's question");
    // A's bubble is outstanding — no `done` ever arrives for it, so nothing on the normal paths
    // releases `awaitingBubbleRef`.
    act(() => h.brain.reset?.());

    // B's first message. If the marker still held A's bubble, this send would stamp it "never
    // answered" — a receipt on a message B cannot see, about a question B did not ask.
    await send("B's question");

    expect(threadText()).not.toContain("never answered");
  });
});
