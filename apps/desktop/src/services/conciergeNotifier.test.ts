// The concierge push sink — and specifically that a notice's KIND reaches it.
//
// The kind is not cosmetic. `PUSHER_NOTICE_PREAMBLE` instructs the concierge to "act on each one
// now … do not simply relay them to him", which is right for a Pusher finding and the exact inverse
// of what a retirement report needs: that already happened, and relaying it plainly IS the
// deliverable. A kind that is accepted here and dropped on the way through would put finished work
// under an instruction to go and do something about it, silently.
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { NoticeKind } from "./conciergeProactive";
import {
  setConciergeNotifier,
  clearConciergeNotifier,
  notifyConcierge,
  conciergeNotifierAvailable,
  _resetConciergeNotifierForTests,
  type ConciergeNotifier,
} from "./conciergeNotifier";

beforeEach(() => {
  _resetConciergeNotifierForTests();
});

describe("notifyConcierge — the kind reaches the sink", () => {
  it("passes an explicit kind through", () => {
    const sink = vi.fn((_text: string, _kind?: NoticeKind, _revalidate?: () => boolean) => true);
    setConciergeNotifier(sink);
    expect(notifyConcierge("Retired “Kraken Auth”.", "report")).toBe(true);
    // THE SIDE EFFECT: what the sink actually received. Asserting only the `true` return would pass
    // against a version that dropped the kind on the floor, which is the whole defect this guards.
    // The third slot is the delivery-time revalidator (bead sparkle-st06sq): absent for a report.
    expect(sink).toHaveBeenCalledWith("Retired “Kraken Auth”.", "report", undefined);
  });

  it("defaults to `pusher`, so every existing caller keeps its meaning", () => {
    const sink = vi.fn((_text: string, _kind?: NoticeKind, _revalidate?: () => boolean) => true);
    setConciergeNotifier(sink);
    notifyConcierge("Two agents are walled.");
    expect(sink).toHaveBeenCalledWith("Two agents are walled.", "pusher", undefined);
  });

  it("forwards the delivery-time revalidator to the sink (bead sparkle-st06sq)", () => {
    // A picker notice carries a predicate the scheduler re-tests at delivery. If `notifyConcierge`
    // dropped it on the way through, the scheduler could never drop a stale menu — so the predicate
    // reaching the sink verbatim is the load-bearing side effect, exactly as the kind is.
    const sink = vi.fn((_text: string, _kind?: NoticeKind, _revalidate?: () => boolean) => true);
    setConciergeNotifier(sink);
    const revalidate = () => false;
    notifyConcierge("Agent A is STOPPED at a menu", "pusher", revalidate);
    expect(sink).toHaveBeenCalledWith("Agent A is STOPPED at a menu", "pusher", revalidate);
  });
});

describe("notifyConcierge — a refusal is still propagated as a refusal", () => {
  it("returns false when the sink declines, whatever the kind", () => {
    // The property bead sparkle-qogah turns on: a sink that says no must not be reported as a
    // delivery, or the finding is stamped as spoken and suppressed at source.
    setConciergeNotifier(() => false);
    expect(notifyConcierge("Retired something.", "report")).toBe(false);
  });

  it("returns false when the sink throws", () => {
    setConciergeNotifier(() => {
      throw new Error("sink exploded");
    });
    expect(notifyConcierge("Retired something.", "report")).toBe(false);
  });

  it("returns false when no sink is registered at all", () => {
    expect(conciergeNotifierAvailable()).toBe(false);
    expect(notifyConcierge("Retired something.", "report")).toBe(false);
  });

  it("returns false after the sink is cleared", () => {
    const sink: ConciergeNotifier = () => true;
    setConciergeNotifier(sink);
    expect(notifyConcierge("a", "report")).toBe(true);
    clearConciergeNotifier(sink);
    expect(notifyConcierge("b", "report")).toBe(false);
  });
});
