// The namespace that stops one app load's history rows from overwriting the previous load's.
//
// Every assertion here is written to fail against the pre-fix behaviour (`id: m.id`, no token at
// all): the round-trip cases would see a row id with no ":" in it, and the cross-load case would see
// two identical ids. See conciergeHistoryCapture.test.ts for the end-to-end collision test that
// drives the real capture path through a sink behaving like `INSERT OR IGNORE`.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  conciergeSessionToken,
  historyRowId,
  bubbleIdForCurrentSession,
  __resetConciergeSessionTokenForTest,
} from "./conciergeSessionToken";

beforeEach(() => {
  __resetConciergeSessionTokenForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetConciergeSessionTokenForTest();
});

describe("the session token", () => {
  it("is minted ONCE per app load — every call inside one load returns the same string", () => {
    // If it re-minted per call, `historyRowId` would give the SAME bubble two different row ids on
    // two store writes and the `seen`/INSERT OR IGNORE dedupe would both stop working — every
    // re-render would append a duplicate row.
    const a = conciergeSessionToken();
    const b = conciergeSessionToken();
    const c = historyRowId("you-1").split(":")[0];
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("is DIFFERENT on the next app load — which is the entire point", () => {
    const first = conciergeSessionToken();
    __resetConciergeSessionTokenForTest(); // ≙ the app reloaded
    const second = conciergeSessionToken();
    expect(second).not.toBe(first);
  });

  it("contains no ':' , so the row id stays unambiguously splittable", () => {
    expect(conciergeSessionToken()).not.toContain(":");
  });

  it("is long enough that two loads on the same day cannot plausibly collide", () => {
    // Guards against a future "let's shorten this" edit reintroducing the collision it exists to
    // prevent. A UUID is 36 chars; the fallback composite is ~20. 16 is the floor either clears.
    expect(conciergeSessionToken().length).toBeGreaterThanOrEqual(16);
  });

  it("falls back to a time+random composite when randomUUID is unavailable (jsdom, older WebKit)", () => {
    vi.stubGlobal("crypto", {}); // no randomUUID at all
    __resetConciergeSessionTokenForTest();
    const first = conciergeSessionToken();
    expect(first).toBeTruthy();
    expect(first).not.toContain(":");

    __resetConciergeSessionTokenForTest();
    const second = conciergeSessionToken();
    // Two loads inside the same millisecond still differ — the time half alone would not do this.
    expect(second).not.toBe(first);
  });

  it("falls back when randomUUID EXISTS but throws (non-secure origin)", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("randomUUID requires a secure context");
      },
    });
    __resetConciergeSessionTokenForTest();
    expect(() => conciergeSessionToken()).not.toThrow();
    expect(conciergeSessionToken()).not.toContain(":");
  });
});

describe("historyRowId", () => {
  it("namespaces the bubble id rather than passing it through", () => {
    // The pre-fix code returned the bare bubble id here. That is the defect.
    expect(historyRowId("you-1")).not.toBe("you-1");
    expect(historyRowId("you-1")).toBe(`${conciergeSessionToken()}:you-1`);
  });

  it("gives the same bubble id in two loads two DIFFERENT row ids", () => {
    const before = historyRowId("you-1");
    __resetConciergeSessionTokenForTest();
    expect(historyRowId("you-1")).not.toBe(before);
  });
});

describe("bubbleIdForCurrentSession — what the scrubber rail can jump to", () => {
  it("round-trips a row written by THIS load", () => {
    expect(bubbleIdForCurrentSession(historyRowId("you-7"))).toBe("you-7");
  });

  it("returns null for a row from a PREVIOUS load, whose bubble is not on screen", () => {
    // The bubble id is very likely reused by a DIFFERENT message on screen right now — that reuse is
    // the whole defect — so honouring it would scroll to somebody else's words.
    const stale = historyRowId("you-1");
    __resetConciergeSessionTokenForTest();
    expect(bubbleIdForCurrentSession(stale)).toBeNull();
  });

  it("returns null for a LEGACY un-namespaced row id with no ':' at all", () => {
    // history.db holds thousands of these. Nothing re-keys them and no migration is wanted; they
    // simply are not attributable to any session.
    expect(bubbleIdForCurrentSession("you-1")).toBeNull();
    expect(bubbleIdForCurrentSession("brain-7")).toBeNull();
    expect(bubbleIdForCurrentSession("approval-ran-3")).toBeNull();
  });

  it("splits on the FIRST colon only, so a bubble id containing ':' survives intact", () => {
    const rowId = historyRowId("weird:id:with:colons");
    expect(bubbleIdForCurrentSession(rowId)).toBe("weird:id:with:colons");
  });

  it("returns null for a trailing-colon row, which names no bubble", () => {
    expect(bubbleIdForCurrentSession(`${conciergeSessionToken()}:`)).toBeNull();
  });
});
