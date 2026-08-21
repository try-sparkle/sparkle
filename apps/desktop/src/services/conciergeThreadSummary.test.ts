import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  maybeRefreshThreadSummary,
  shouldRegenerate,
  pendingSince,
  _resetThreadSummaryForTests,
  failureBackoffMs,
  SUMMARY_FAILURE_BACKOFF_MS,
  SUMMARY_FAILURE_BACKOFF_MAX_MS,
} from "./conciergeThreadSummary";
import {
  useConciergeThreadSummaryStore,
  SUMMARY_REGEN_EVERY,
} from "../stores/conciergeThreadSummaryStore";
import { CONTINUITY_RECENT_MESSAGES } from "../engine/conciergeContinuity";
import type { ConciergeMessage } from "../components/Concierge/types";

const msg = (id: string, text = "t"): ConciergeMessage =>
  ({ id, kind: "you", text }) as ConciergeMessage;

/** A thread with `n` conversation messages beyond the verbatim window. */
const threadWithOutside = (n: number): ConciergeMessage[] =>
  Array.from({ length: CONTINUITY_RECENT_MESSAGES + n }, (_, i) => msg(`m${i}`, `text ${i}`));

beforeEach(() => {
  _resetThreadSummaryForTests();
  useConciergeThreadSummaryStore.getState().clear();
});

describe("when a refresh is due", () => {
  it("does not fire below the threshold", async () => {
    const chat = vi.fn(async () => "nope");
    const ran = await maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY - 1), {
      chat,
    });
    expect(ran).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it("fires at the threshold and stores the reply", async () => {
    const chat = vi.fn(async () => "- founder asked about billing");
    const ran = await maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY), { chat });
    // BOTH: that it ran, and that the result actually landed. Asserting only the call would pass
    // against a summariser that threw the reply away.
    expect(ran).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(useConciergeThreadSummaryStore.getState().text).toBe("- founder asked about billing");
  });

  it("advances the covered marker to the NEWEST message it summarised", async () => {
    const chat = vi.fn(async () => "s");
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat });
    const outsideCount = SUMMARY_REGEN_EVERY;
    expect(useConciergeThreadSummaryStore.getState().throughMessageId).toBe(
      `m${outsideCount - 1}`,
    );
  });

  it("carries the EXISTING summary into the prompt so it folds rather than replaces", async () => {
    useConciergeThreadSummaryStore
      .getState()
      .set({ text: "PRIOR CONTEXT LINE", throughMessageId: "none" });
    // PARAMETERS DECLARED on purpose: an argument-less mock signature types every call as a
    // zero-length tuple, so reading `calls[0][1]` is a compile error at the assertion rather than at
    // the mock — the confusing end. (Same reasoning as the routed suites in ConciergeHost.test.)
    const chat = vi.fn(async (_system: string, _user: string) => "merged");
    await maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY), { chat });
    expect(chat.mock.calls[0]![1]).toContain("PRIOR CONTEXT LINE");
  });
});

describe("failure is never allowed to reach the turn", () => {
  it("swallows a rejection and keeps the previous summary", async () => {
    useConciergeThreadSummaryStore.getState().set({ text: "KEEP ME", throughMessageId: "m0" });
    const chat = vi.fn(async () => {
      throw new Error("no CLI");
    });
    const ran = await maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY + 5), {
      chat,
    });
    expect(ran).toBe(false);
    // The old summary survives AND the marker does not advance, so the same turns retry later.
    expect(useConciergeThreadSummaryStore.getState().text).toBe("KEEP ME");
    expect(useConciergeThreadSummaryStore.getState().throughMessageId).toBe("m0");
  });

  it("ignores an empty reply rather than blanking a good summary", async () => {
    useConciergeThreadSummaryStore.getState().set({ text: "KEEP ME", throughMessageId: "m0" });
    const chat = vi.fn(async () => "   ");
    const ran = await maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY + 5), {
      chat,
    });
    expect(ran).toBe(false);
    expect(useConciergeThreadSummaryStore.getState().text).toBe("KEEP ME");
  });
});

describe("the timeout branch, which only exists to be survivable", () => {
  it("gives up on a call that never settles, and keeps the old summary", async () => {
    useConciergeThreadSummaryStore.getState().set({ text: "KEEP ME", throughMessageId: "m0" });
    const never = vi.fn(() => new Promise<string>(() => {}));
    await expect(
      maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY + 5), {
        chat: never,
        timeoutMs: 5,
      }),
    ).resolves.toBe(false);
    expect(useConciergeThreadSummaryStore.getState().text).toBe("KEEP ME");
  });

  it("releases the latch when the timeout fires, or one wedged call kills summarising forever", async () => {
    const never = vi.fn(() => new Promise<string>(() => {}));
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: never, timeoutMs: 5, now: () => 0 });
    const ok = vi.fn(async () => "recovered");
    // Past the failure backoff a timeout also arms — otherwise this would assert the cooldown
    // rather than the latch, and would keep passing against a permanently wedged one.
    await expect(
      maybeRefreshThreadSummary(thread, { chat: ok, now: () => SUMMARY_FAILURE_BACKOFF_MS }),
    ).resolves.toBe(true);
  });

  it("a model call that rejects AFTER the timeout still settles to false, not a throw", async () => {
    // What is actually observable about the late-rejection case. There was a third test here
    // asserting no unhandled rejection escaped; it was deleted because it could not fail —
    // `Promise.race` attaches a reaction to every input, so the loser is handled either way. See
    // the note in `withTimeout`. This asserts the part a caller can actually depend on.
    const lateReject = vi.fn(
      () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("late failure")), 30)),
    );
    await expect(
      maybeRefreshThreadSummary(threadWithOutside(SUMMARY_REGEN_EVERY), {
        chat: lateReject,
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 60));
  });
});

describe("only one summariser at a time", () => {
  it("refuses a second call while the first is still running", async () => {
    let release: (v: string) => void = () => {};
    const chat = vi.fn(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    const first = maybeRefreshThreadSummary(thread, { chat });
    // A burst of turns: without the latch, the queue cap alone permits 50 of these, each spawning
    // its own `claude -p` and racing to write the same key.
    const second = await maybeRefreshThreadSummary(thread, { chat });
    expect(second).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    release("done");
    await expect(first).resolves.toBe(true);
  });

  it("clears the latch after a failure, so a later attempt can still run", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: failing, now: () => 0 });
    const ok = vi.fn(async () => "recovered");
    // Past the failure backoff, so this asserts the LATCH cleared and not merely that the cooldown
    // is still holding — two different reasons for a no-op, and only one of them is this test's.
    await expect(
      maybeRefreshThreadSummary(thread, { chat: ok, now: () => SUMMARY_FAILURE_BACKOFF_MS }),
    ).resolves.toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("backoff after a failed attempt", () => {
  const boom = () =>
    vi.fn(async () => {
      throw new Error("boom");
    });

  // The defect this guards: the failure path deliberately does not advance `throughMessageId`, and
  // the threshold it is re-tested against stays crossed — so before the cooldown, a sticky failure
  // (an exhausted subscription, which clears in hours) bought a fresh model call on EVERY turn.
  it("does not call the model again while the cooldown holds", async () => {
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: boom(), now: () => 1_000 });

    const second = boom();
    const ran = await maybeRefreshThreadSummary(thread, {
      chat: second,
      now: () => 1_000 + SUMMARY_FAILURE_BACKOFF_MS - 1,
    });
    expect(ran).toBe(false);
    // The SIDE EFFECT, not the return value: `false` is also what an ineligible thread returns.
    expect(second).not.toHaveBeenCalled();
  });

  // The paired direction. Absence alone is ambiguous — it would also pass against a summariser that
  // is simply broken — so the SAME thread and the SAME setup must reach the model once time passes.
  it("calls the model again once the cooldown lapses", async () => {
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: boom(), now: () => 1_000 });

    const later = vi.fn(async () => "recovered");
    const ran = await maybeRefreshThreadSummary(thread, {
      chat: later,
      now: () => 1_000 + SUMMARY_FAILURE_BACKOFF_MS,
    });
    expect(ran).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("doubles the wait for each consecutive failure, and clamps at the ceiling", () => {
    expect(failureBackoffMs(0)).toBe(0);
    expect(failureBackoffMs(1)).toBe(SUMMARY_FAILURE_BACKOFF_MS);
    expect(failureBackoffMs(2)).toBe(SUMMARY_FAILURE_BACKOFF_MS * 2);
    expect(failureBackoffMs(3)).toBe(SUMMARY_FAILURE_BACKOFF_MS * 4);
    expect(failureBackoffMs(50)).toBe(SUMMARY_FAILURE_BACKOFF_MAX_MS);
    // Every step is bounded by the ceiling, so a long outage can never schedule a retry past it.
    for (let n = 1; n <= 40; n++) {
      expect(failureBackoffMs(n)).toBeLessThanOrEqual(SUMMARY_FAILURE_BACKOFF_MAX_MS);
    }
  });

  it("keeps doubling across consecutive failures rather than restarting at the base", async () => {
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: boom(), now: () => 0 });
    // Second attempt, exactly when the FIRST backoff lapses — it runs, and fails again.
    await maybeRefreshThreadSummary(thread, {
      chat: boom(),
      now: () => SUMMARY_FAILURE_BACKOFF_MS,
    });

    // One base interval after the second failure is NOT enough: the second wait is doubled.
    const tooSoon = boom();
    await maybeRefreshThreadSummary(thread, {
      chat: tooSoon,
      now: () => SUMMARY_FAILURE_BACKOFF_MS * 2 + SUMMARY_FAILURE_BACKOFF_MS - 1,
    });
    expect(tooSoon).not.toHaveBeenCalled();

    const eventually = vi.fn(async () => "recovered");
    await maybeRefreshThreadSummary(thread, {
      chat: eventually,
      now: () => SUMMARY_FAILURE_BACKOFF_MS * 3,
    });
    expect(eventually).toHaveBeenCalledTimes(1);
  });

  it("a success resets the run, so the next failure waits one base interval again", async () => {
    // Two failures, so the run is at a doubled wait before the success clears it.
    const thread = threadWithOutside(SUMMARY_REGEN_EVERY);
    await maybeRefreshThreadSummary(thread, { chat: boom(), now: () => 0 });
    await maybeRefreshThreadSummary(thread, {
      chat: boom(),
      now: () => SUMMARY_FAILURE_BACKOFF_MS,
    });

    const ok = vi.fn(async () => "recovered");
    await expect(
      maybeRefreshThreadSummary(thread, { chat: ok, now: () => SUMMARY_FAILURE_BACKOFF_MS * 3 }),
    ).resolves.toBe(true);

    // A wider thread, because the success above advanced the covered marker past the first one.
    const wider = threadWithOutside(SUMMARY_REGEN_EVERY * 2);
    const t0 = SUMMARY_FAILURE_BACKOFF_MS * 10;
    await maybeRefreshThreadSummary(wider, { chat: boom(), now: () => t0 });

    // If the success had NOT reset the run, this failure would be the third and would wait 4×.
    const after = vi.fn(async () => "recovered again");
    await maybeRefreshThreadSummary(wider, {
      chat: after,
      now: () => t0 + SUMMARY_FAILURE_BACKOFF_MS,
    });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("pendingSince / shouldRegenerate", () => {
  it("counts only what the stored summary has not already covered", () => {
    const outside = [msg("a"), msg("b"), msg("c")];
    expect(pendingSince(outside, null)).toHaveLength(3);
    expect(pendingSince(outside, "a")).toHaveLength(2);
    expect(pendingSince(outside, "c")).toHaveLength(0);
  });

  it("re-covers everything when the marked message has itself been evicted", () => {
    // Deliberate: over-covering costs tokens, under-covering loses an ask.
    expect(pendingSince([msg("a"), msg("b")], "long-gone")).toHaveLength(2);
  });

  it("agrees with maybeRefresh about when work is due", () => {
    expect(shouldRegenerate(threadWithOutside(SUMMARY_REGEN_EVERY - 1), null)).toBe(false);
    expect(shouldRegenerate(threadWithOutside(SUMMARY_REGEN_EVERY), null)).toBe(true);
  });
});
