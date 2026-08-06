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
    /** "Every turn in flight has been orphaned" — carries no id and no text, on purpose. Raised by a
     *  sign-out and by a deliberate session set alike; the host's teardown is the same either way. */
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
    // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
    // the host's other wiring, and a mock that simply OMITS an export the host calls does not
    // degrade — vitest throws on the missing property and every case in the file dies at mount.
    onConciergeTool: () => () => {},
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
    onConciergeTurnsAbandoned: (cb: NonNullable<typeof h.brain.reset>) => {
      h.brain.reset = cb;
      return () => {};
    },
  };
});
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
import { SUPERSEDED_DETAILS } from "../services/concierge";
import { noteConciergeToolCall } from "../services/conciergeActivity";
import { THINKING_INDICATOR_TESTID } from "./Concierge/ThinkingIndicator";
import { UNKNOWN_FAILURE_HEADLINE } from "../engine/conciergeFailureNotice";
import {
  _resetConciergeLivenessForTests,
  noteConciergeSent,
  useConciergeLivenessStore,
} from "../services/conciergeLiveness";
import {
  FAILURE_OUTAGE_RUN,
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
} from "../engine/conciergeLiveness";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { MAX_QUEUED_TURNS } from "../engine/conciergeTurnQueue";
import { waitingLine } from "../services/conciergeMessageStatuses";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const COUNTS: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 1, done: 0 };

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

describe("a displaced message never claims it went unanswered", () => {
  // THE 20:18-20:31 BURST is why the host still STAMPS a displaced bubble (`ConciergeReceipt
  // .unanswered`): each send kills the turn before it and the killed reader emits NOTHING, so the
  // moment of the next send is the only place displacement can be detected at all.
  //
  // But the stamp no longer produces a receipt line. It used to render "→ Replaced by your next
  // message — never answered"; that was deleted on 2026-07-31 because a displaced turn is FREQUENTLY
  // answered a couple of messages later — the follow-up carries enough of the earlier question that
  // the brain addresses both — so the line asserted something the app cannot know. These rows now
  // pin its ABSENCE end-to-end through the real column, each paired with a positive count of THE
  // USER'S OWN BUBBLES, so they cannot pass on a thread that simply rendered nothing (which is
  // exactly how the originals first failed).
  //
  // NOT a count of receipts, and the distinction is load-bearing now: `RoutingReceipt` returns null
  // for a concierge-answered message, so there is no receipt under these turns to count. See
  // `sentBubbleCount`'s own docblock below.
/**
 * How many of the user's own messages the thread is showing.
 *
 * ══ WHY THIS COUNTS BUBBLES AND NOT RECEIPTS ═══════════════════════════════════════════════════
 * These rows originally counted the literal "Answered here"; when that text was removed they were
 * re-pointed at the receipt ELEMENT, which survived only because it hosted the "Also ask" redirect.
 * That button has now been removed too (founder: *"you can just take that out completely"*), so a
 * concierge-answered message renders no receipt at all and the element is no longer countable.
 *
 * The POSITIVE CONTROL is the point and it is preserved: each row pairs a
 * `not.toContain("never answered")` with a positive count, so it cannot pass on a thread that
 * simply rendered nothing — which is exactly how the originals first failed. The user's bubble is
 * the right anchor for that now: it is present for every sent message regardless of how the turn
 * was routed or whether it was ever answered, which is more robust than either thing this helper
 * previously counted.
 */
function sentBubbleCount(): number {
  return screen.queryAllByTestId("you-bubble").length;
}

  // RENAMED (the receipt is gone; `d23f186`/`f57e1ff` removed the sentence and then the row). What
  // these rows have always been about is the DELETED "never answered" claim, and they now say so:
  // the bubble survives and carries no accusation. A name promising "the ordinary receipt" over an
  // assertion counting bubbles is the stale-name shape this file has been bitten by before.
  it("leaves a bubble nothing ever came back for un-accused", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    expect(sentBubbleCount()).toBeGreaterThan(0);
    expect(threadText()).not.toContain("never answered");

    await send("what needs me right now?");
    expect(threadText()).not.toContain("never answered");
    expect(threadText()).not.toContain("Replaced by your next message");
    // Both bubbles survive and neither is accused — the displaced one reads exactly like the live one.
    expect(sentBubbleCount()).toBe(2);
  });

  // A TOOL CALL IS NOT AN ANSWER (roborev 55442-M1) — reading state or a terminal before replying is
  // the concierge's normal FIRST move, so this is the ORDINARY shape of a displaced question, not a
  // corner case. It is kept as its own row because it is the shape most likely to regress: whatever
  // the host decides about a tool-only turn, that turn must not attract the deleted "never answered"
  // claim. (It used to say "the receipt under it must stay the ordinary one" — there is no receipt
  // under it any more, so that sentence sent a reader hunting for a surface that cannot render.)
  it("leaves a bubble whose turn only called a tool un-accused", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "ag1" }));

    await send("what needs me right now?");
    expect(threadText()).not.toContain("never answered");
    expect(threadText()).not.toContain("Replaced by your next message");
    expect(sentBubbleCount()).toBe(2);
  });

  // A turn that streamed a partial answer the user then interrupted is NOT this. They got words;
  // stamping it "never answered" would be the same class of lie in the other direction.
  it("leaves a bubble alone when its turn did stream something", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.delta?.({ id: "7", text: "Three agents " }));
    expect(sentBubbleCount()).toBeGreaterThan(0);

    await send("what needs me right now?");
    expect(threadText()).not.toContain("never answered");
  });

  it("leaves an ANSWERED bubble alone when the user simply asks something else", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.done?.({ id: "7", sessionId: "s1", text: "Nothing right now." }));
    expect(sentBubbleCount()).toBeGreaterThan(0);

    await send("and after that?");
    expect(threadText()).not.toContain("never answered");
  });

  // A failure already told the user what happened. Stamping "never answered" on top of the error it
  // is carrying would be a second, contradictory account of the same turn.
  it("leaves a bubble that got an ERROR alone", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    act(() => h.brain.error?.({ id: "7", detail: "boom" }));
    expect(sentBubbleCount()).toBeGreaterThan(0);

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
    for (let i = 0; i < FAILURE_OUTAGE_RUN + 1; i += 1) {
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

  it("clears a LATCHED red, so B is not told about a turn A sent", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    // A real failure, so `failure` and `failureRun` are whatever the production path writes. The
    // latch itself is seeded rather than driven: `reduceTick` is the only thing that sets it and it
    // needs the one-second interval to run, which is the timing suite's subject, not this one's. What is
    // under test here is what the RESET does to the state, however it was reached.
    act(() => h.brain.error?.({ id: "f0", detail: "boom" }));
    act(() => useConciergeLivenessStore.setState({ stalledLatched: true }));
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(true);
    expect(useConciergeLivenessStore.getState().failure).not.toBeNull();

    act(() => h.brain.reset?.());

    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(false);
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

// ── THE COLOUR, SPOKEN ─────────────────────────────────────────────────────────────────────────
//
// The no-answer signal is a colour and nothing else, which a screen reader cannot read. The step is
// therefore announced — through the column's ONE live region, fed by the host, like every other line
// the column says.
//
// THIS LIVES HERE, not in ThinkingIndicator, and that placement IS the fix (roborev 56122-M2). Two
// attempts to give the indicator its own region failed: an `aria-label`-only change is not reliably
// announced at all, and a clip-rect region of its own violates the thread's "no announcer of its
// own" rule (ConciergeThread.roleLabels asserts it, and caught the second attempt) — besides being
// muted outright when nested inside the row, which is `aria-hidden` whenever there is no activity
// line, i.e. exactly the stalled-and-silent case it existed for.
describe("the liveness colour is spoken, through the column's one announcer", () => {
  const announcer = () => screen.getByTestId("concierge-announcer").textContent ?? "";

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("says nothing at all while the wait is normal, then speaks each step once", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");

    // GRAY IS SILENT. Announcing it would tell the user their concierge is behaving, every turn.
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS - 2_000);
    });
    expect(announcer()).not.toContain("Still waiting");

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(announcer()).toContain("Still waiting");
    expect(announcer()).not.toContain("nothing has come back");

    await act(async () => {
      vi.advanceTimersByTime(STALLED_AFTER_MS - SLOW_AFTER_MS);
    });
    expect(announcer()).toContain("nothing has come back");
  });

  // ── AN INHERITED TURN IS DISCARDED, NOT MERELY SILENCED ─────────────────────────────────────
  //
  // roborev 56177-M1 then 56194. The liveness store is module-level and outlives the host, which
  // unmounts whenever no project is open (App.tsx). A turn in flight at that moment loses its
  // terminal listeners and leaves `silentSince` set forever.
  //
  // The first fix muted only the WORDS, with a per-mount ref. That was not enough, and these rows
  // pin all three consequences it missed — each of which passes against a mute-only version:
  //   1. the row still painted RED on frame one of a brand-new question,
  //   2. the mount latched `stalledLatched`, making that red survive even a hard failure,
  //   3. and with the ref seeded `stalled` and nothing but observed output unlatching, the announcer
  //      could stay mute for the WHOLE mount — going dark in the degraded case it exists for.
  it("discards a stalled turn it inherits, rather than silently carrying it forward", async () => {
    // The abandoned turn, established with NO host mounted — exactly the closed-project window.
    noteConciergeSent();
    await act(async () => {
      vi.advanceTimersByTime(STALLED_AFTER_MS * 5);
    });
    expect(useConciergeLivenessStore.getState().silentSince).not.toBeNull();

    render(<ConciergeHost feed={feed()} />);
    await flush();

    expect(announcer()).toBe("");
    // THE STATE ITSELF, not just the text. Muting the words while keeping the wrong colour is the
    // worst of both, and is what the first attempt shipped.
    expect(useConciergeLivenessStore.getState().silentSince).toBeNull();
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(false);
  });

  it("still announces the next real turn's escalation after inheriting a stale one", async () => {
    noteConciergeSent();
    await act(async () => {
      vi.advanceTimersByTime(STALLED_AFTER_MS * 5);
    });
    render(<ConciergeHost feed={feed()} />);
    await flush();

    // A brand-new question, and the colour must start over from gray. Asserted on the liveness
    // WORDING rather than on an empty region: the send writes its own routing receipt through the
    // same announcer, which is the column working as designed.
    await send("what needs me?");
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS - 2_000);
    });
    expect(announcer()).not.toContain("Still waiting");

    // …and the escalation is spoken. A mute-only fix seeds the ref with `stalled`, so this step is
    // never a CHANGE and the announcer stays dark for the rest of the mount.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(announcer()).toContain("Still waiting");
  });

  // NOT ONCE PER RENDER. `announce` bumps a write counter so identical repeats still speak (roborev
  // 53392) — which is exactly why a per-render call would re-announce "Still waiting" every second
  // for as long as the turn stayed slow. Asserted on the write counter, because the TEXT would look
  // identical either way; this is the one reading that can tell the two apart.
  it("does not re-announce the same step on every tick", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me?");
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS);
    });
    const seq = screen
      .getByTestId("concierge-announcer")
      .querySelector("[data-announce-seq]")
      ?.getAttribute("data-announce-seq");

    await act(async () => {
      vi.advanceTimersByTime(20_000); // still yellow, twenty more ticks
    });
    expect(
      screen
        .getByTestId("concierge-announcer")
        .querySelector("[data-announce-seq]")
        ?.getAttribute("data-announce-seq"),
    ).toBe(seq);
  });
});

// ── THE QUEUE, SPOKEN ──────────────────────────────────────────────────────────────────────────
//
// The per-message status line is NOT a live region and must not become one: this column owns exactly
// ONE announcer, and a second in the subtree double-announces (Concierge/MessageStatus's header;
// ConciergeThread.roleLabels asserts it). That placement was justified on the AT reader getting the
// same information through the column's announcer — true while the line only repeated things
// announced elsewhere, and FALSE the moment it started carrying a queue position, which nothing else
// says anywhere.
describe("the queue is spoken, through the column's one announcer", () => {
  const announcer = () => screen.getByTestId("concierge-announcer").textContent ?? "";
  /** The region's write counter — bumped per announcement, so a SECOND write is visible even when
   *  the first is immediately overwritten and the rendered text looks unchanged. */
  const announceSeq = (): number =>
    Number(
      screen
        .getByTestId("concierge-announcer")
        .querySelector("[data-announce-seq]")
        ?.getAttribute("data-announce-seq") ?? -1,
    );

  it("says where a queued send landed, and says nothing about a queue for an ordinary send", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("the first question");
    // An ordinary send starts immediately — there is no queue to report, and inventing one would be
    // noise on the overwhelmingly common path.
    expect(announcer()).not.toMatch(/Queued/);

    await send("the second question");
    expect(announcer()).toContain("Queued — Next up");

    await send("the third question");
    expect(announcer()).toContain("Queued — 2nd in line");
  });

  /**
   * A DROPPED MESSAGE IS SPOKEN, folded into the SAME write as the position.
   *
   * At {@link MAX_QUEUED_TURNS} the reducer evicts the OLDEST waiter. The thread gets a `failure`
   * bubble naming the lost text — but this column's aria-live region does not read the thread, so
   * this is the only channel it has. Announcing the position alone would hand a screen-reader user a
   * reassuring receipt for the new message while an older question disappeared without a word.
   *
   * ONE write, not two: the region is a single `{ seq, text }`, so a second write would say only the
   * second thing. Loss first, position after.
   */
  it("says which question was lost when the queue overflows, and still says where the new one sits", async () => {
    render(<ConciergeHost feed={feed()} />);
    // This one DISPATCHES, so it is the running turn and never a waiter — the cap is about the
    // queue behind it.
    await send("the running question");
    // Fill the queue to exactly the cap, so the next send is the one that evicts.
    for (let n = 0; n < MAX_QUEUED_TURNS; n += 1) await send(`waiter ${n}`);
    expect(announcer()).not.toMatch(/dropped/i);

    await send("the one that pushes it over");
    // The OLDEST waiter goes — `waiter 0`, not the running turn and not the newest message. The
    // reducer drops from the front deliberately: refusing the newest would throw away the thing the
    // user is still looking at.
    expect(announcer()).toContain("One queued message was dropped: waiter 0");
    // THE POSITION'S VALUE, not merely its presence. This number is the one boundary-sensitive value
    // in the folded string: it is read from `outcome.next` AFTER the reducer has both shift()ed the
    // evicted waiter and appended the new one, so an off-by-one either way — 49th, 51st, or the
    // pre-drop state — would leave a `/in line/` match green. Tied to the cap constant so it cannot
    // drift from MAX_QUEUED_TURNS.
    expect(announcer()).toContain(`Queued — ${waitingLine(MAX_QUEUED_TURNS)}.`);
  });

  /**
   * NO ANNOUNCEMENT WHEN A QUEUED MESSAGE IS PROMOTED, asserted so the omission is deliberate.
   *
   * ══ NOT BECAUSE ONE REGION CAN ONLY CARRY ONE FACT ═════════════════════════════════════════════
   * The drop notice above folds two facts into one string, so that was never the constraint. The
   * reason that survives folding is what the reader could otherwise KNOW. A destroyed question is
   * unrecoverable and mentioned nowhere else — if the region does not say it, it is gone. A
   * PROMOTION is derivable: the answer to message N arriving is itself the signal that N+1 is next,
   * and the position lines already said where it sat. Folding it into the reply's write would push
   * the ANSWER — the thing the user is waiting for — behind a detail they can infer, on the one
   * channel a screen-reader user has.
   *
   * ══ WHAT THIS ACTUALLY PINS, STATED HONESTLY (roborev 58518) ═══════════════════════════════════
   * The `seq` check catches a SECOND write — an `announce()` placed inside `drainQueue`. It does NOT
   * by itself catch the fold-into-the-reply variant, which is still one write. The exact-text
   * assertion is what closes that: appending "Now answering: …" to the reply's own string makes the
   * region read something other than the reply, and this goes red.
   */
  it("writes the region exactly ONCE across the drain and the reply, with only the reply in it", async () => {
    render(<ConciergeHost feed={feed()} />);
    await send("what needs me");
    await send("and is CI green");

    const before = announceSeq();
    act(() => h.brain.done?.({ id: "1", sessionId: "s1", text: "all calm" }));
    await flush();

    expect(announceSeq()).toBe(before + 1);
    // EXACT, not `toContain` — see the docblock. `toContain("all calm")` survives a fold.
    expect(announcer()).toBe("all calm");
  });
});
