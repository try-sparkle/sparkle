// A HOLD DOES NOT BECOME VOID BECAUSE THE FOUNDER LOOKED AWAY (bead sparkle-9gsjqm).
//
// `hooks/useScreenHoldDrain`'s header promises exactly that: a hold can outlive the mount that
// created it — he types into a busy pane, then unmounts (⌘⇧U) or switches the cable — and "the
// message he was promised must still arrive". The code contradicted it. The drain refused to flush
// on ANY non-null `terminalWriteRefusal`, and `no-viewport` (the pane simply is not mounted in this
// window) is one of them, so a held send for a hidden pane could only ever age out to `expired`
// after MAX_AGE_MS and then be dropped.
//
// WHY THE FIX IS THE CLOCK, WHICH IS ALSO WHY THESE ROWS LOOK THE WAY THEY DO. Merely skipping the
// sweep changes nothing observable — the next flush classifies the entry `expired` by the same age
// rule and hands it back undelivered. So the unreadable stretch must not COUNT toward the ceiling,
// and the row that proves it has to run the clock past MAX_AGE_MS. The paired row runs the identical
// timeline with no `deferScreenHoldsWhileHidden` call and pins that it expires and writes nothing,
// so neither row can pass on the strength of the other's setup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn((): SuggestionButton[] => []),
}));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt } from "../pty";
import { getAgentViewport } from "./terminalViewport";
import {
  deferScreenHoldsWhileHidden,
  dispatchConciergeAnswer,
  flushScreenHeldSends,
  onDeferredSendOutcome,
} from "./conciergeDispatch";
import { MAX_AGE_MS, resetScreenHeldSends, screenHeldSendCount } from "./screenHoldQueue";

const AGENT = "agent-1";
const TYPED = "when this finishes, run the shell suite";

/** The founder's mounted composer send — the one caller `holdForScreenClear` admits. */
const MOUNTED = {
  authority: { kind: "mount", agentId: AGENT } as const,
  userPrompt: true,
  neverPickerAnswer: true,
  holdForScreenClear: true,
};

/** A `vim` session, as far as the guard can tell — the screen state that produces the hold. */
function onFullScreenApp(): void {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "~\n~\n~", alternateBuffer: true });
}
/** The screen the founder comes back to: readable, ordinary, safe to write. */
function atAPrompt(): void {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "$ ", alternateBuffer: false });
}

/** What the drain does on each `no-viewport` poll tick while the pane is hidden. */
function hiddenPollTicks(count: number, msApart: number): void {
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(Date.now() + msApart);
    deferScreenHoldsWhileHidden(AGENT);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(getAgentViewport).mockReturnValue(null);
  resetScreenHeldSends();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("a hold whose pane is hidden", () => {
  // THE PAIRED CONTROL, AND THE PROOF THE CEILING IS NOT REMOVED. Same timeline, nothing stopping
  // the clock: this is what the founder was getting — his message handed back as `expired`, never
  // written, after fifteen minutes of not being looked at. It is also what a VISIBLE-but-blocked
  // pane still gets, since the drain never defers on that branch; the 15-minute rule is unchanged,
  // it is simply measured against time the screen could actually be read.
  it("expires and is never written when the hidden stretch counts against its TTL", async () => {
    onFullScreenApp();
    const held = await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);
    expect(held.path).toBe("queued");

    // Sixteen minutes with the pane not mounted in this window, and nothing stopping the clock.
    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);

    atAPrompt();
    const [outcome] = await flushScreenHeldSends(AGENT);
    expect(outcome?.path).toBe("expired");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // THE ROW THE FIX EXISTS FOR. Identical timeline, except the drain's `no-viewport` branch stops
  // the clock each tick — so when a viewport comes back and reads clear, the words are still there
  // and are DELIVERED. Asserting `submitPrompt`, not merely a queue count: "still held" and
  // "actually arrived" are different facts and only the second is the promise.
  it("survives the same sixteen minutes and delivers once a viewport returns and reads clear", async () => {
    onFullScreenApp();
    const held = await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);
    expect(held.path).toBe("queued");

    // 640 ticks × 1.5s ≈ 16 minutes of the drain finding no viewport to read.
    hiddenPollTicks(640, 1500);
    expect(screenHeldSendCount(AGENT)).toBe(1);

    atAPrompt();
    const [flushed] = await flushScreenHeldSends(AGENT);
    expect(flushed?.ok).toBe(true);
    expect(flushed?.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, TYPED, expect.anything());
  });

  // NOTHING IS REPORTED WHILE IT WAITS. An `expired` (or any other) outcome emitted during the
  // hidden stretch would tell the founder his message was dropped while it is in fact still coming.
  it("emits no outcome at all while the pane stays hidden", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);

    const outcomes: Array<{ path: string }> = [];
    const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
    hiddenPollTicks(640, 1500);
    unsubscribe();
    expect(outcomes).toEqual([]);
  });

  // ══ THE SHIFT IS ONE DELTA, SO ORDER SURVIVES ═════════════════════════════════════════════════
  // Re-stamping every entry to `now` would flatten them onto one instant, and
  // `reinstateScreenHeldSends` sorts by `at` — a message that arrived DURING the hidden stretch
  // would then sort ahead of the ones it follows, delivering a follow-up before its own subject.
  // That is roborev 64289's ordering inversion arriving through a new door, so it is pinned here.
  it("keeps held messages in the order they were typed, including one that arrived while hidden", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, "first message", MOUNTED);
    vi.setSystemTime(Date.now() + 1000);
    await dispatchConciergeAnswer(AGENT, "second message", MOUNTED);

    hiddenPollTicks(10, 1500);
    // A third arrives while the pane is still hidden — it must land BEHIND the two before it.
    vi.setSystemTime(Date.now() + 1000);
    await dispatchConciergeAnswer(AGENT, "third message", MOUNTED);
    hiddenPollTicks(10, 1500);

    atAPrompt();
    // One delivery per flush, by design — see flushScreenHeldSends. Three flushes, in order.
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "first message", expect.anything());
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "second message", expect.anything());
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "third message", expect.anything());
  });

  // ══ IT PROTECTS THE LIVE ENTRIES, IT DOES NOT RESURRECT DEAD ONES ═════════════════════════════
  // An entry can only reach the hidden branch ALREADY expired by aging out for a reason that is not
  // the unreadable screen — it was visible and blocked, or nothing polled at all (a sleeping machine
  // fires no interval). Un-expiring those would deliver a message typed an hour ago into a session
  // that has moved on. It is reported through the same path the blocked branch uses, and — the half
  // that makes this row worth having — a still-live sibling beside it is untouched and delivers.
  it("reports an already-expired hold rather than un-expiring it", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, "typed long ago", MOUNTED);
    // The machine was asleep: `setInterval` fires nothing while it is, so no tick stopped this
    // one's clock and it genuinely aged past the ceiling.
    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);

    const outcomes: Array<{ path: string; sent?: string }> = [];
    const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
    hiddenPollTicks(5, 1500);
    unsubscribe();
    expect(outcomes).toEqual([
      expect.objectContaining({ path: "expired", heldReason: "screen", sent: "typed long ago" }),
    ]);

    // Reported AND cleared: it is not still sitting there waiting to be delivered by a later flush.
    expect(screenHeldSendCount(AGENT)).toBe(0);
    atAPrompt();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("is a no-op for an agent with nothing held", () => {
    expect(() => deferScreenHoldsWhileHidden("nobody")).not.toThrow();
    expect(screenHeldSendCount("nobody")).toBe(0);
  });
});
