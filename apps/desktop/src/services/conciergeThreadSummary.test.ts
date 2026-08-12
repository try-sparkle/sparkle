import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  maybeRefreshThreadSummary,
  shouldRegenerate,
  pendingSince,
  _resetThreadSummaryForTests,
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
    await maybeRefreshThreadSummary(thread, { chat: never, timeoutMs: 5 });
    const ok = vi.fn(async () => "recovered");
    await expect(maybeRefreshThreadSummary(thread, { chat: ok })).resolves.toBe(true);
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
    await maybeRefreshThreadSummary(thread, { chat: failing });
    const ok = vi.fn(async () => "recovered");
    await expect(maybeRefreshThreadSummary(thread, { chat: ok })).resolves.toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
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
