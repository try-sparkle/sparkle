// @vitest-environment jsdom
//
// WHICH MESSAGE THE STATUS IS ATTACHED TO. The interesting cases are all about NOT saying something
// — the turn floor, the absent activity, the older message — because the failure mode this surface
// invites is a confident line under the wrong question.
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useConciergeMessageStatuses, waitingLine } from "./conciergeMessageStatuses";
import {
  _resetConciergeActivityForTests,
  noteConciergeNativeToolCall,
  noteConciergePhase,
  useConciergeActivityStore,
} from "./conciergeActivity";
import {
  clearConciergeLiveness,
  noteConciergeProgress,
  noteConciergeSent,
} from "./conciergeLiveness";
import { useProjectStore } from "../stores/projectStore";
import { enqueue, EMPTY_TURN_QUEUE, turnFinished } from "../engine/conciergeTurnQueue";
import { conciergeActivityLine } from "../engine/conciergeActivityLine";

/** The counter as it stands now — what the host snapshots as the turn floor. */
/**
 * A fixed enqueue instant for every `QueuedTurn` this file builds.
 *
 * The field is REQUIRED on `QueuedTurn` (see `engine/conciergeTurnQueue`), and nothing in this
 * suite depends on the value — these tests are about which bubble reads "working" versus "3rd in
 * line", not about how long anything has waited. A constant says that plainly; a `Date.now()` here
 * would suggest the assertions turn on the clock, which they do not.
 */
const TURN_T0 = 1_700_000_000_000;

const seqNow = () => useConciergeActivityStore.getState().latest?.seq ?? -1;

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  clearConciergeLiveness();
});

describe("useConciergeMessageStatuses", () => {
  it("attaches the live status to the message whose turn is in flight", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    expect(Object.keys(result.current)).toEqual(["msg-1"]);
    expect(result.current["msg-1"]!.text.length).toBeGreaterThan(0);
  });

  it("attaches nothing when no turn is being awaited", () => {
    const floor = seqNow();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses(null, true, floor));
    expect(result.current).toEqual({});
  });

  it("attaches nothing once the turn has finished", () => {
    const floor = seqNow();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", false, floor));
    expect(result.current).toEqual({});
  });

  /**
   * THE TURN FLOOR, and this is the case worth having. An entry recorded during the PREVIOUS turn
   * must never be rendered under a NEW question — that is not a stale pixel, it is a false
   * statement about what the concierge is doing with the message the user just sent.
   *
   * Driven by recording activity and THEN taking the floor above it, which is the real sequence:
   * the host snapshots the counter when the turn starts, so everything already recorded is below.
   */
  it("ignores activity left over from an earlier turn", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/old"}');
    const floorForNewTurn = seqNow(); // everything so far belongs to the turn that just ended
    const { result } = renderHook(() =>
      useConciergeMessageStatuses("msg-2", true, floorForNewTurn),
    );
    expect(result.current).toEqual({});
  });

  it("shows an entry recorded AFTER the floor", () => {
    noteConciergeNativeToolCall("Read", '{"file_path":"/old"}');
    const floor = seqNow();
    noteConciergePhase("composing");
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-2", true, floor));
    expect(result.current["msg-2"]?.text).toBe("Composing");
  });

  // NO ACTIVITY, NO CLAIM — the same rule the column-level indicator degrades by. A turn that is
  // thinking and has called nothing yet must not be given a manufactured status.
  it("attaches nothing when the turn has produced no activity at all", () => {
    const floor = seqNow();
    noteConciergeSent();
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    expect(result.current).toEqual({});
  });

  /**
   * A stable empty map. The map is a prop on a memoised subtree, so a fresh `{}` per render would
   * change identity every tick and defeat the row memo for every message in the thread — the
   * drag-selection stutter ConciergeMessageRow's header exists to prevent.
   */
  it("returns a stable empty map across renders, so the thread's row memo holds", () => {
    const { result, rerender } = renderHook(() => useConciergeMessageStatuses(null, true, -1));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  /**
   * IT DOES NOT SUBSCRIBE TO THE LIVENESS CLOCK (roborev 57889-M2), and that is a fact about the
   * HOST, which is what calls this hook. `useConciergeLiveness` re-renders its caller once a second
   * for the whole of every turn and reads the liveness store with no selector, so it also re-renders
   * on every `noteConciergeProgress` — one per token chunk. Neither `ConciergeColumn` nor
   * `ConciergeThread` is memoised, so either path reconciles the entire transcript from the host.
   * The ink is read in a leaf instead (`MessageStatusLive`).
   *
   * Asserted on the CALLER RE-RENDERING, which is the mechanism, and driven by a real liveness write
   * rather than by a clock: `reduceProgress` returns a fresh state object every call, so an
   * unselectored subscription re-renders on it. Checking the returned map's identity alone would be
   * weaker — `useMemo` would hold it stable across a re-render this test is trying to detect.
   */
  it("does NOT re-render its caller when only the liveness store moves", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConciergeMessageStatuses("msg-1", true, floor);
    });
    expect(result.current["msg-1"]?.text).toBe("Composing");
    const before = renders;
    // A sign of life — in a real turn this arrives per token chunk and per tool call.
    act(() => noteConciergeProgress("tool"));
    expect(renders).toBe(before);
  });

  /**
   * NO TONE, AND NO CLOCK READING. The tone used to ride down from here; it is the leaf's now, and a
   * producer that grew one back would put the 1 Hz ticker in the host again (roborev 57889-M2).
   *
   * Asserted as the WHOLE SHAPE rather than a key census or a single forbidden name. What must never
 * appear is `tone`, or any other field whose value is a reading of elapsed time — and since such a
 * field can be called anything, the only assertion that actually enforces it is an exhaustive one.
 * See the body for the two weaker forms that were tried and why each failed.
   */
  it("hands down no tone and no clock reading", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    // THE WHOLE SHAPE, in the file's own idiom (roborev 58543). Two weaker forms were tried first
    // and both were wrong in opposite directions:
    //
    //   • a bare key census — `Object.keys(status).sort()` — which reads as a spelling test rather
    //     than the invariant, and contradicted the docstring above it;
    //   • `not.toHaveProperty("tone")` alone, which forbids ONE NAME. A producer that regrew a
    //     time-derived field as `ageMs`, `since`, `elapsedLabel` or `stale` would sail through, and
    //     that is precisely the regression that puts the 1 Hz ticker back in the host.
    //
    // An exhaustive `toEqual` closes both: any field the producer grows fails here, and the reader
    // sees the shape rather than a list of names. The claim that this over-constrains does not hold
    // against the rest of this file, which already pins waiting entries to `{ text }` exactly — a
    // new static field breaks those regardless, so nothing was bought by loosening this one.
    //
    // `icon` was added by sparkle-9ciay and this assertion is what caught it, which is the check
    // working rather than failing: a STATIC domain mark is admitted deliberately here, and anything
    // derived from a clock still cannot get past the exhaustive compare.
    expect(result.current["msg-1"]).toEqual({
      text: "Composing",
      icon: "workspace",
      live: true,
    });
  });

  /**
   * QUEUED MESSAGES CARRY THEIR OWN LINE (sparkle-t8wsj). Before sends queued, only one message
   * could ever have a status; now the founder's *"I don't know which one you are working on"* is
   * answered for every message he sent, not just the newest.
   *
   * The two kinds of line differ in nature and this asserts both: the working message's line is
   * OBSERVED (it names the tool actually running), while a waiting message's line is a fact about
   * the QUEUE and claims nothing about what the concierge is doing.
   */
  it("gives every queued message its own waiting line, and the working one the live tool line", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "msg-1", text: "first", enqueuedAt: TURN_T0 }).next;
    q = enqueue(q, { bubbleId: "msg-2", text: "second", enqueuedAt: TURN_T0 }).next;
    q = enqueue(q, { bubbleId: "msg-3", text: "third", enqueuedAt: TURN_T0 }).next;

    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor, q));
    // The one being worked on gets the observed tool line…
    expect(result.current["msg-1"]!.text).not.toMatch(/in line|Next up/);
    expect(result.current["msg-1"]!.text.length).toBeGreaterThan(0);
    // …and the ones behind it say only where they stand in the queue.
    expect(result.current["msg-2"]).toEqual({ text: "Next up" });
    expect(result.current["msg-3"]).toEqual({ text: "2nd in line" });
  });

  // A waiting line does NOT depend on the activity floor or on `typing`: a queued message has no
  // turn, so there is no activity that could describe it.
  it("still marks waiters when the running turn has produced no activity yet", () => {
    const floor = seqNow();
    noteConciergeSent();
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "msg-1", text: "first", enqueuedAt: TURN_T0 }).next;
    q = enqueue(q, { bubbleId: "msg-2", text: "second", enqueuedAt: TURN_T0 }).next;
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor, q));
    expect(result.current["msg-2"]).toEqual({ text: "Next up" });
  });




  /**
   * WHERE YOU STAND, NOT JUST THAT YOU ARE WAITING (the founder's *"a queue of effectively twenty to
   * fifty messages"*).
   *
   * Every waiter used to render the identical `"Waiting its turn"`. At the depth this queue is built
   * for that is a wall of twenty identical lines: it says a message is in the queue and withholds the
   * one thing the reader wants — how far off its answer is. `waitingCount` had computed the depth
   * since the queue landed and NOTHING read it.
   *
   * Asserted on the DISTINCTNESS of the lines across a burst, which is the property that failed
   * before: a producer that ignored position would still return a full map of plausible strings, so
   * a per-message assertion alone could pass while every line said the same thing.
   */
  it("tells each waiter its own place in the queue, so twenty lines are not identical", () => {
    const floor = seqNow();
    noteConciergeSent();
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
    for (let n = 1; n <= 20; n += 1) q = enqueue(q, { bubbleId: `w${n}`, text: `q${n}`, enqueuedAt: TURN_T0 }).next;

    const { result } = renderHook(() => useConciergeMessageStatuses("run", true, floor, q));
    const lines = Array.from({ length: 20 }, (_, i) => result.current[`w${i + 1}`]!.text);
    expect(new Set(lines).size).toBe(20);
    expect(lines[0]).toBe("Next up");
    expect(lines[1]).toBe("2nd in line");
    expect(lines[19]).toBe("20th in line");
  });

  /**
   * EVERY MESSAGE THE TURN IS ANSWERING CARRIES THE LIVE LINE (roborev 65842).
   *
   * A turn answers a RUN now (bead sparkle-agx4d8) and only its HEAD owns `awaitingId`. Attaching
   * the line to the head alone leaves the follow-ups with NO status at all — not "waiting" (they are
   * not in line), not "working", just blank — which on screen is indistinguishable from being
   * ignored. That is the exact symptom absorbing them was meant to remove, so the status layer must
   * not reintroduce it.
   *
   * EVERY OTHER ROW IN THIS FILE BUILDS ITS QUEUE VIA `enqueue`, which yields a run of length ONE,
   * so the loop this pins was never exercised and a revert to head-only left the suite green. This
   * row drives `turnFinished` with an always-related judge, which is how a real multi-message run is
   * formed.
   */
  it("puts the live line on EVERY message of an absorbed run, not just its head", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergeNativeToolCall("Grep", '{"pattern":"x"}');
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
    for (const id of ["a", "b", "c", "d"]) {
      q = enqueue(q, { bubbleId: id, text: `msg ${id}`, enqueuedAt: TURN_T0 }).next;
    }
    // The running turn ends and the drain absorbs a's run into ONE turn — but NOT `d`, which the
    // judge calls different. `walkRelated` stops on the first different verdict and leaves
    // everything it declines in `waiting`, which is what gives this row a message that is queued
    // and NOT part of the run. The judge's `next` is the candidate's TEXT, not the entry.
    const drained = turnFinished(q, (_run, next) => next !== "msg d");
    expect(drained.next.running?.entries.map((e) => e.bubbleId)).toEqual(["a", "b", "c"]);
    expect(drained.next.waiting.map((e) => e.bubbleId)).toEqual(["d"]);

    const { result } = renderHook(() => useConciergeMessageStatuses("a", true, floor, drained.next));
    const live = result.current["a"]!;
    // The head's line is the observed tool line, not a queue position…
    expect(live.text).not.toMatch(/in line|Next up/);
    // …and each absorbed follow-up carries THE SAME live line rather than nothing. Asserting the
    // shared value, not merely truthiness: a synthesised per-message phrase would be a claim about
    // work nobody observed.
    expect(result.current["b"]).toEqual(live);
    expect(result.current["c"]).toEqual(live);
    // ══ THE CONTROL HAS TO BE A MESSAGE THE HOOK KNOWS ABOUT (roborev 66301) ════════════════════
    // Asserting that some id never enqueued is `undefined` proves nothing: the map is built solely
    // from `queue.waiting`, `queue.delegated`, `queue.running.entries` and `awaitingId`, so an
    // unknown id is absent under EVERY implementation, including one that paints the live line on
    // all four of those. The risk worth excluding is the live line LEAKING onto a message that is
    // queued but not part of the run, and only `d` can show that — it is in `waiting`, so a
    // paint-everything implementation would hand it `live` instead of its position.
    expect(result.current["d"]).toEqual({ text: "Next up" });
    expect(result.current["d"]).not.toEqual(live);
  });

  /**
   * THE LINE MOVES. A position that is right once and then frozen would be worse than no position at
   * all — it would keep telling the reader they are third while they are actually next.
   *
   * ON ONE MOUNTED HOOK, via `rerender`, and that is the whole point of the case (roborev 58249-M1).
   * A second `renderHook` builds a FRESH instance, and a fresh instance recomputes no matter what the
   * `useMemo` dependency list says — so the obvious version of this test passes against an
   * implementation whose positions are frozen for the life of the turn. The concrete regression it
   * has to catch is `queue` being dropped from that dependency array: the host holds ONE long-lived
   * hook instance and mutates the queue on every enqueue and drain, so a stale memo there is exactly
   * the frozen line this docstring calls worse than nothing. Driven through the real reducer rather
   * than by hand-editing the queue.
   */
  it("promotes the next waiter on the SAME hook instance when the running turn finishes", () => {
    const floor = seqNow();
    noteConciergeSent();
    let q = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
    q = enqueue(q, { bubbleId: "a", text: "a", enqueuedAt: TURN_T0 }).next;
    q = enqueue(q, { bubbleId: "b", text: "b", enqueuedAt: TURN_T0 }).next;

    const { result, rerender } = renderHook(
      ({ queue, id }) => useConciergeMessageStatuses(id, true, floor, queue),
      { initialProps: { queue: q, id: "run" as string } },
    );
    // The running entry carries nothing here: this suite records no activity for it, and a
    // message with no observed activity gets no claim (see the call site).
    expect(result.current["run"]).toBeUndefined();
    expect(result.current["a"]).toEqual({ text: "Next up" });
    expect(result.current["b"]).toEqual({ text: "2nd in line" });

    // The running turn ends: `a` starts, and `b` moves up to the front of the line.
    rerender({ queue: turnFinished(q).next, id: "a" });
    expect(result.current["a"]).toBeUndefined();
    expect(result.current["b"]).toEqual({ text: "Next up" });
    // …and the finished message is no longer claimed by anything.
    expect(result.current["run"]).toBeUndefined();
  });

  /**
   * THE QUEUE ALONE MOVES THE LINES — the case that actually isolates the memo.
   *
   * The promotion case above changes `awaitingId` as well as the queue, and `awaitingId` is itself a
   * dependency, so it recomputes for a reason that has nothing to do with the queue: dropping `queue`
   * from the dependency list leaves that test green (verified by hand-mutation). This one holds
   * EVERY other input fixed and changes only the queue, which is the sole shape that can fail on a
   * stale memo.
   *
   * It is also the most common thing that happens in a burst: the founder sends again while the same
   * turn keeps running, so `awaitingId` does not move and the new bubble must still light up
   * immediately. With a stale memo it would render nothing at all — the message would look like it
   * had not been received, which is precisely the fear the queue was built to answer.
   */
  it("shows a newly enqueued message while the SAME turn keeps running", () => {
    const floor = seqNow();
    noteConciergeSent();
    const running = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "run", text: "running", enqueuedAt: TURN_T0 }).next;
    const withA = enqueue(running, { bubbleId: "a", text: "a", enqueuedAt: TURN_T0 }).next;

    const { result, rerender } = renderHook(
      ({ queue }) => useConciergeMessageStatuses("run", true, floor, queue),
      { initialProps: { queue: withA } },
    );
    expect(result.current["a"]).toEqual({ text: "Next up" });
    expect(result.current["b"]).toBeUndefined();

    // A third message arrives. Nothing else about the turn has changed — same running bubble, same
    // floor, same activity — so only the queue can carry this.
    rerender({ queue: enqueue(withA, { bubbleId: "b", text: "b", enqueuedAt: TURN_T0 }).next });
    expect(result.current["a"]).toEqual({ text: "Next up" });
    expect(result.current["b"]).toEqual({ text: "2nd in line" });
  });
});

/**
 * THE ORDINALS, over the range this queue is actually built for.
 *
 * The founder asked for *"twenty to fifty messages"*, which is exactly the span where the naive
 * `n + "th"`/`n % 10` rules break: the teens (11th, 12th, 13th) take `th` despite ending in 1/2/3,
 * and the twenties resume `st`/`nd`/`rd`. A queue capped at {@link MAX_QUEUED_TURNS} = 50 reaches all
 * of them, so these are live cases and not pedantry.
 */
describe("waitingLine", () => {
  it("calls the front of the queue what it is, rather than numbering it", () => {
    expect(waitingLine(1)).toBe("Next up");
  });

  it.each([
    [2, "2nd in line"],
    [3, "3rd in line"],
    [4, "4th in line"],
    [11, "11th in line"],
    [12, "12th in line"],
    [13, "13th in line"],
    [21, "21st in line"],
    [22, "22nd in line"],
    [23, "23rd in line"],
    [50, "50th in line"],
  ])("renders position %i as %s", (position, expected) => {
    expect(waitingLine(position)).toBe(expected);
  });
});

/**
 * THE GLYPH TRAVELS WITH THE PHRASE (sparkle-9ciay).
 *
 * The founder: *"I like how on the left side it gives me a little icon, I'd like to see that icon on
 * the right side as well."* The rail draws `line.icon`; this producer must hand the SAME field down
 * rather than letting the bubble derive one, or the two marks can disagree about what kind of work
 * is running — which is the failure the shared map in components/Concierge/activityIcons exists to
 * make impossible on the drawing side, and this is its other half.
 */
describe("the tool domain travels with the line", () => {
  it("carries the icon the rail would draw for the same activity", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    const { result } = renderHook(() => useConciergeMessageStatuses("msg-1", true, floor));
    // Read from the engine rather than hard-coded, so this asserts "the same value the rail gets"
    // instead of re-stating one file's opinion about which glyph "composing" deserves.
    const line = conciergeActivityLine(useConciergeActivityStore.getState().latest!)!;
    expect(result.current["msg-1"]!.icon).toBe(line.icon);
    // Not vacuous: the engine really did produce a domain, so `undefined === undefined` cannot pass.
    expect(line.icon).toBeTruthy();
  });

  it("gives a QUEUED message no icon — a position is not an observed call", () => {
    const floor = seqNow();
    noteConciergeSent();
    noteConciergePhase("composing");
    // Two sends: the first becomes `running`, so the second is the one that actually WAITS.
    let queue = enqueue(EMPTY_TURN_QUEUE, { bubbleId: "msg-1", text: "now", enqueuedAt: TURN_T0 }).next;
    queue = enqueue(queue, { bubbleId: "msg-2", text: "later", enqueuedAt: TURN_T0 }).next;
    const { result } = renderHook(() =>
      useConciergeMessageStatuses("msg-1", true, floor, queue),
    );
    expect(result.current["msg-2"]!.text.length).toBeGreaterThan(0);
    expect(result.current["msg-2"]!.icon).toBeUndefined();
    // …while the RUNNING one in the very same map does have one, so "no icon" is a property of the
    // waiting line and not of this fixture.
    expect(result.current["msg-1"]!.icon).toBeTruthy();
  });
});
