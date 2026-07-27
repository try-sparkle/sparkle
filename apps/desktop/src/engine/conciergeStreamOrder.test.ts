import { describe, it, expect } from "vitest";
import { ARRIVAL_GRACE_MS, createArrivalOrder, orderByArrival } from "./conciergeStreamOrder";

const m = (id: string) => ({ id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

/** A hand-cranked clock, so the grace window is exercised without waiting on real time. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      return t;
    },
  };
}

describe("orderByArrival — placement", () => {
  it("keeps first-seen order on the first pass", () => {
    const c = clock();
    expect(ids(orderByArrival(createArrivalOrder(), [m("a"), m("b"), m("c")], c.now()))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("places a LATER arrival after everything already seen", () => {
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("chat1"), m("chat2")], c.now());
    c.advance(1000);
    expect(ids(orderByArrival(o, [m("chat1"), m("chat2"), m("digest")], c.now()))).toEqual([
      "chat1",
      "chat2",
      "digest",
    ]);
  });

  it("keeps an EARLIER arrival above chat that came after it — the original bug", () => {
    // The whole feature. The digest arrived between two chat turns, so it stays between them. The
    // old code appended every digest below all chat, which is what made the notices look stuck to
    // the bottom of the pane.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("chat1"), m("digest")], c.now());
    c.advance(1000);
    expect(ids(orderByArrival(o, [m("chat1"), m("chat2"), m("digest")], c.now()))).toEqual([
      "chat1",
      "digest",
      "chat2",
    ]);
  });

  it("is immune to the ORDER the caller concatenates in, once ids are known", () => {
    // The host builds `[...chat, ...digests, ...nudges]`; that grouping must not survive into the
    // rendered order for items already placed.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("a"), m("digest"), m("b")], c.now());
    expect(ids(orderByArrival(o, [m("a"), m("b"), m("digest")], c.now()))).toEqual([
      "a",
      "digest",
      "b",
    ]);
  });

  it("does not mutate or reuse the caller's array", () => {
    const items = [m("b"), m("a")];
    const out = orderByArrival(createArrivalOrder(), items, clock().now());
    expect(ids(items)).toEqual(["b", "a"]);
    expect(out).not.toBe(items);
  });

  it("handles an empty stream", () => {
    expect(orderByArrival(createArrivalOrder(), [], clock().now())).toEqual([]);
  });
});

describe("orderByArrival — the grace window is WALL-CLOCK, not a rebuild count", () => {
  it("holds a digest's slot across a brief dip, even with unrelated churn meanwhile", () => {
    // roborev 53581, the "too fast" half. A fleet busy enough to warrant a digest has other agents
    // entering and leaving `needs_you` constantly. Under a rebuild-counting window that churn blew
    // through the grace period while the group was collapsed, and the line yanked to the bottom.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("chat"), m("digest")], c.now());

    // Group dips below 2 agents; meanwhile four unrelated agents flip in and out.
    for (const other of ["other1", "other2", "other3", "other4"]) {
      c.advance(200);
      orderByArrival(o, [m("chat"), m(other)], c.now());
    }

    // Under a second of real time has passed, so this is still a flicker: the line stays put.
    c.advance(200);
    expect(ids(orderByArrival(o, [m("chat"), m("digest")], c.now()))).toEqual(["chat", "digest"]);
  });

  it("re-slots a long-absent id even when NOTHING else in the stream changed", () => {
    // roborev 53581, the "too slow" half — and the common case. A quiet fleet produces a
    // byte-identical id set, so a rebuild counter barely moves and a forty-minute absence looked
    // exactly like a two-second flicker.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("alert"), m("chat1")], c.now());
    c.advance(1000);
    orderByArrival(o, [m("alert"), m("chat1"), m("chat2")], c.now());

    // Answered; the card goes. The agent then works for forty minutes and NOTHING else happens —
    // the id set is identical on every rebuild.
    c.advance(500);
    for (let i = 0; i < 50; i++) {
      c.advance(48_000);
      orderByArrival(o, [m("chat1"), m("chat2")], c.now());
    }

    // It asks again — a new event, and it belongs where the reader is looking.
    c.advance(1000);
    expect(ids(orderByArrival(o, [m("chat1"), m("chat2"), m("alert")], c.now()))).toEqual([
      "chat1",
      "chat2",
      "alert",
    ]);
  });

  it("draws the line at the window itself", () => {
    const justUnder = createArrivalOrder();
    const a = clock();
    orderByArrival(justUnder, [m("x"), m("y")], a.now());
    a.advance(ARRIVAL_GRACE_MS); // absent, exactly at the boundary
    expect(ids(orderByArrival(justUnder, [m("y"), m("x")], a.now()))).toEqual(["x", "y"]);

    const justOver = createArrivalOrder();
    const b = clock();
    orderByArrival(justOver, [m("x"), m("y")], b.now());
    b.advance(ARRIVAL_GRACE_MS + 1);
    expect(ids(orderByArrival(justOver, [m("y"), m("x")], b.now()))).toEqual(["y", "x"]);
  });

  it("a re-raised alert keeps its NEW slot afterwards", () => {
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("alert"), m("chat")], c.now());
    c.advance(ARRIVAL_GRACE_MS * 5);
    orderByArrival(o, [m("chat")], c.now());
    c.advance(1000);
    expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now())).at(-1)).toBe("alert");
    for (let i = 0; i < 3; i++) {
      c.advance(500);
      expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now())).at(-1)).toBe("alert");
    }
  });

  it("a CONTINUOUSLY present id never goes stale, however long it stays", () => {
    // Its lastSeenAt refreshes on every call, so a card the user leaves on screen for an hour must
    // not silently re-slot itself out from under them.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("alert"), m("chat")], c.now());
    for (let i = 0; i < 60; i++) {
      c.advance(60_000);
      expect(ids(orderByArrival(o, [m("alert"), m("chat")], c.now()))).toEqual(["alert", "chat"]);
    }
  });
});

describe("orderByArrival — idempotent for repeated calls", () => {
  it("repeated calls at the same instant move nothing", () => {
    // React may re-run or discard a render (StrictMode double-invokes outright), so the number of
    // calls is not something we control.
    const o = createArrivalOrder();
    const c = clock();
    const items = [m("a"), m("digest"), m("b")];
    const first = ids(orderByArrival(o, items, c.now()));
    for (let i = 0; i < 5; i++) expect(ids(orderByArrival(o, items, c.now()))).toEqual(first);
  });

  it("extra calls do not age an absent id toward losing its slot", () => {
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("chat"), m("alert")], c.now());
    c.advance(100);
    // The alert is gone, and React renders this same set 30 times in a fraction of a second.
    for (let i = 0; i < 30; i++) orderByArrival(o, [m("chat")], c.now());
    c.advance(100);
    expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now()))).toEqual(["chat", "alert"]);
  });
});
