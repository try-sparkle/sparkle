import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetConciergeReceiptsForTests,
  nextReceiptId,
  onConciergeActionReceipt,
  recordConciergeActionReceipt,
  type ConciergeActionReceipt,
} from "./conciergeReceipts";

function receipt(over: Partial<ConciergeActionReceipt> = {}): ConciergeActionReceipt {
  return {
    id: nextReceiptId(),
    kind: "sent",
    ok: true,
    agentId: "a1",
    agentName: "Left Pair",
    channel: "inbox",
    at: 1_769_649_600_123,
    op: "fleet.inbox_send",
    ...over,
  };
}

afterEach(() => _resetConciergeReceiptsForTests());

describe("conciergeReceipts", () => {
  it("delivers a recorded receipt to every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    onConciergeActionReceipt(a);
    onConciergeActionReceipt(b);

    const r = receipt();
    recordConciergeActionReceipt(r);

    // THE SIDE EFFECT: both listeners were called with the receipt itself, not merely registered.
    expect(a).toHaveBeenCalledWith(r);
    expect(b).toHaveBeenCalledWith(r);
  });

  it("stops delivering after unsubscribe", () => {
    const cb = vi.fn();
    const off = onConciergeActionReceipt(cb);
    recordConciergeActionReceipt(receipt());
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    recordConciergeActionReceipt(receipt());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("records a REFUSED action too — 'I couldn't' is the answer to 'why didn't it'", () => {
    const cb = vi.fn();
    onConciergeActionReceipt(cb);

    recordConciergeActionReceipt(
      receipt({ ok: false, reason: "Left Pair couldn't take it", channel: "terminal" }),
    );

    // Asserted through the call itself rather than indexed out of `mock.calls`: under
    // `noUncheckedIndexedAccess` a bare `calls[0][0]` is `possibly undefined` and fails the
    // typecheck, and a non-null assertion would only hide that the listener might never have run.
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, reason: "Left Pair couldn't take it" }),
    );
  });

  it("a throwing listener costs neither the other listeners nor the caller", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const survivor = vi.fn();
    onConciergeActionReceipt(() => {
      throw new Error("renderer blew up");
    });
    onConciergeActionReceipt(survivor);

    // Reaching the next line at all is half the assertion: a throw here would fail the tool call
    // that produced the receipt, which is the one thing this module may never do.
    expect(() => recordConciergeActionReceipt(receipt())).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ══ REPLAY (roborev 57866) ══════════════════════════════════════════════════════════════════
  describe("a receipt recorded while nothing is listening is not lost", () => {
    it("replays to a subscriber that arrives AFTER the receipt", () => {
      // The real scenario: ConciergeHost unmounts when no project is open (App.tsx says so, and it
      // is why ApiRecovery is a sibling of the columns). A merge_pr settling in that window used to
      // be fanned out to an empty listener set and lost — which, in a feature whose contract is
      // that a MISSING receipt is evidence, manufactures false "it never happened" evidence.
      const r = receipt({ kind: "merged", prNumber: 1184 });
      recordConciergeActionReceipt(r); // nobody listening

      const late = vi.fn();
      onConciergeActionReceipt(late);

      expect(late).toHaveBeenCalledWith(r);
    });

    it("replays in the order the actions happened", () => {
      const a = receipt({ kind: "spawned" });
      const b = receipt({ kind: "closed" });
      recordConciergeActionReceipt(a);
      recordConciergeActionReceipt(b);

      const late = vi.fn();
      onConciergeActionReceipt(late);

      expect(late.mock.calls.map((c) => (c[0] as ConciergeActionReceipt).kind)).toEqual([
        "spawned",
        "closed",
      ]);
    });

    it("bounds the backlog so it cannot grow without limit", () => {
      for (let i = 0; i < 200; i += 1) recordConciergeActionReceipt(receipt());
      const late = vi.fn();
      onConciergeActionReceipt(late);
      // The exact cap is REPLAY_MAX; asserting "bounded and non-empty" pins the property without
      // hard-coding a tuning number this test does not own.
      expect(late.mock.calls.length).toBeGreaterThan(0);
      expect(late.mock.calls.length).toBeLessThanOrEqual(64);
    });

    it("a listener that throws on a replayed receipt costs neither the backlog nor the caller", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      recordConciergeActionReceipt(receipt());
      recordConciergeActionReceipt(receipt());

      let seen = 0;
      expect(() =>
        onConciergeActionReceipt(() => {
          seen += 1;
          throw new Error("renderer blew up");
        }),
      ).not.toThrow();
      // BOTH replayed items were attempted — a throw on the first must not abandon the rest.
      expect(seen).toBe(2);
      warn.mockRestore();
    });
  });

  it("the test reset actually STOPS delivery to already-registered listeners", () => {
    // roborev 57839 (Medium): this function was exported, used only in `afterEach`, and asserted
    // NOWHERE — so replacing its body with `{}` left the whole suite green. Every other test
    // registers its own fresh mock, so a leaked subscriber from the test before is a different mock
    // and cannot fail anything. The one behaviour that matters therefore had zero coverage, and a
    // broken reset would have shipped while leaking a stale subscriber across every teardown.
    const before = vi.fn();
    onConciergeActionReceipt(before);

    _resetConciergeReceiptsForTests();
    recordConciergeActionReceipt(receipt());

    expect(before).not.toHaveBeenCalled();

    // The companion assertion, without which the one above passes against a module that has simply
    // stopped delivering to anyone: a listener registered AFTER the reset still receives receipts.
    //
    // TWO calls, not one, and the difference is the REPLAY working: `after` gets the receipt
    // recorded above (replayed from the backlog on subscribe) and then the fresh one. Asserting 1
    // here would be asserting that the roborev 57866 fix is absent.
    const after = vi.fn();
    onConciergeActionReceipt(after);
    recordConciergeActionReceipt(receipt());

    expect(after).toHaveBeenCalledTimes(2);
    expect(before).not.toHaveBeenCalled();
  });

  it("mints a distinct id per call, so same-millisecond actions cannot collide", () => {
    // A broadcast is N sends in one tick; a colliding key would make React drop one of the lines,
    // silently losing exactly the evidence this feature exists to produce.
    const ids = Array.from({ length: 50 }, () => nextReceiptId());
    expect(new Set(ids).size).toBe(50);
  });
});

// ══ THE PRODUCER HALF OF THE ORIGIN JOIN ════════════════════════════════════════════════════════
// The consumer (the concierge host turning a receipt into a black "sent to an agent" card) is
// covered in ConciergeHost.test.tsx. This is the half that had nothing (roborev 62756): the settler
// attaching the origin, and the module state it reads from.
//
// It matters because the WHOLE POINT of carrying the origin is that it is captured at a different
// moment from when it is used. A test that only drives the consumer proves the card renders for a
// receipt that already has the field, and says nothing about whether anything ever puts it there.
describe("the turn origin a receipt carries", () => {
  afterEach(() => _resetConciergeReceiptsForTests());

  // NOTE ON SCOPE, so these are not mistaken for coverage of the capture. The settler only FORWARDS
  // a value it is handed; the mechanism the feature turns on — reading the origin at CALL ENTRY so a
  // late settle cannot re-date it — lives in `handleConciergeTool` and is pinned in
  // controlListener.test.ts, by a case that moves the origin mid-call so entry and settle disagree.
  // These three cover the parameter contract only, which is the part that lives in this module.
  it("is what the settler stamps, and it survives to the listener", async () => {
    const { settleConciergeReceipt } = await import("./conciergeReceiptSettle");
    const { setConciergeTurnOrigin } = await import("./conciergeReceipts");
    const seen: ConciergeActionReceipt[] = [];
    onConciergeActionReceipt((r) => void seen.push(r));
    setConciergeTurnOrigin("bubble-7");
    settleConciergeReceipt(
      "terminal",
      "send_to_agent_terminal",
      { agentId: "a1", text: "hi" },
      true,
      { ok: true, agentId: "a1", agentName: "Left Pair" },
      undefined,
      undefined,
      // Captured by the caller at CALL ENTRY — here, stated explicitly.
      "bubble-7",
    );
    expect(seen.at(-1)?.originBubbleId).toBe("bubble-7");
  });

  it("is ABSENT when the caller does not know it — the fail-closed half", async () => {
    const { settleConciergeReceipt } = await import("./conciergeReceiptSettle");
    const { setConciergeTurnOrigin } = await import("./conciergeReceipts");
    const seen: ConciergeActionReceipt[] = [];
    onConciergeActionReceipt((r) => void seen.push(r));
    // `conciergeApprovalResume` settles from a click handler and cannot know the bubble, so it
    // passes nothing.
    //
    // A LIVE VALUE IS SET FIRST, and that is what makes this test mean anything. With the module
    // already null at rest, the assertion was satisfied by a PRECONDITION rather than by the
    // settler's behaviour — introduce the exact defect the design forbids (`originBubbleId ??
    // currentConciergeTurnOrigin()` at settle time) and it stayed green (roborev 62814). Setting a
    // conflicting value means only the omission itself can produce `undefined`.
    setConciergeTurnOrigin("bubble-that-must-not-be-picked-up");
    settleConciergeReceipt(
      "terminal",
      "send_to_agent_terminal",
      { agentId: "a1", text: "hi" },
      true,
      { ok: true, agentId: "a1", agentName: "Left Pair" },
      undefined,
    );
    expect(seen.at(-1)).toBeTruthy();
    expect(seen.at(-1)?.originBubbleId).toBeUndefined();
  });

  it("reads back what was set, and clears to null — the unmount contract", async () => {
    const { setConciergeTurnOrigin, currentConciergeTurnOrigin } = await import(
      "./conciergeReceipts"
    );
    // The host clears this when it unmounts. Without that, the last bubble the column ever awaited
    // outlives the column, and a call settling afterwards is stamped with it — message ids survive
    // rehydration, so a remounted thread can contain that very id.
    setConciergeTurnOrigin("bubble-9");
    expect(currentConciergeTurnOrigin()).toBe("bubble-9");
    setConciergeTurnOrigin(null);
    expect(currentConciergeTurnOrigin()).toBeNull();
  });
});
