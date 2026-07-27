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

  it("draws the line at the window itself — measured across the ABSENCE", () => {
    // The clock has to run between the build that DROPS `x` and the one that brings it back; that
    // span is the absence. Advancing before the dropping call instead times a stretch in which `x`
    // was on screen the whole while, which is what roborev 53651 caught this test doing — it put
    // the boundary in the wrong place and so passed either way.
    const justUnder = createArrivalOrder();
    const a = clock();
    orderByArrival(justUnder, [m("x"), m("y")], a.now());
    orderByArrival(justUnder, [m("y")], a.now()); // x goes absent here
    a.advance(ARRIVAL_GRACE_MS); // ...and comes back exactly at the boundary
    expect(ids(orderByArrival(justUnder, [m("y"), m("x")], a.now()))).toEqual(["x", "y"]);

    const justOver = createArrivalOrder();
    const b = clock();
    orderByArrival(justOver, [m("x"), m("y")], b.now());
    orderByArrival(justOver, [m("y")], b.now());
    b.advance(ARRIVAL_GRACE_MS + 1); // ...just past it
    expect(ids(orderByArrival(justOver, [m("y"), m("x")], b.now()))).toEqual(["y", "x"]);
  });

  it("a long RENDER GAP re-slots nothing — reading is not absence", () => {
    // The bug this pair of conditions exists to prevent. The memo only runs when its inputs change,
    // so a reader who pauses produces no rebuild at all. An elapsed-time test on its own then finds
    // EVERY on-screen id stale on the next keystroke and renumbers all of them into the caller's
    // [chat, digests, nudges] order — the original out-of-sequence layout, delivered as a jump,
    // triggered by nothing but reading (roborev 53594).
    const o = createArrivalOrder();
    const c = clock();
    // digest sits BETWEEN the two chat turns, which is the placement being defended.
    orderByArrival(o, [m("chat1"), m("digest"), m("chat2")], c.now());

    // The user reads for half a minute. Nothing re-renders.
    c.advance(30_000);

    // Then types. The memo runs, concatenated as [chat…, digests…] — the order that must NOT win.
    const after = orderByArrival(o, [m("chat1"), m("chat2"), m("chat3"), m("digest")], c.now());
    expect(ids(after)).toEqual(["chat1", "digest", "chat2", "chat3"]);
  });

  it("charges the window to the ABSENCE, not to the quiet stretch before it", () => {
    // roborev 53651. The window has to measure how long the id was GONE. Measuring from the last
    // build that contained it charges the preceding silence to the absence — and silence is the
    // normal state of this memo, which is the whole premise of the render-gap fix above.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("digest"), m("chat")], c.now());

    // Twelve seconds in which nobody types and no agent crosses `needs_you`. The memo is keyed on
    // feed/chat identity, so it does not run at all — the digest is on screen the entire time.
    c.advance(12_000);
    orderByArrival(o, [m("chat")], c.now()); // the group dips below its >=2-agent threshold...
    c.advance(200);

    // ...and re-forms 200ms later. That is a textbook flicker, and the digest must not move.
    expect(ids(orderByArrival(o, [m("chat"), m("digest")], c.now()))).toEqual(["digest", "chat"]);
  });

  it("stops the clock once a flickering id is back — a survived dip is not a running absence", () => {
    // The other half of measuring from `absentSince`: it has to be CLEARED on return. Left set, a
    // dip the id survived keeps ticking underneath it, and the id re-slots later for a gap it is no
    // longer in — a jump with no event behind it at all.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("digest"), m("chat")], c.now());
    orderByArrival(o, [m("chat")], c.now()); // dips...
    c.advance(200);
    orderByArrival(o, [m("chat"), m("digest")], c.now()); // ...and is back well inside the window

    // It then sits on screen through an ordinary stretch of conversation.
    c.advance(ARRIVAL_GRACE_MS * 3);
    expect(ids(orderByArrival(o, [m("chat"), m("digest")], c.now()))).toEqual(["digest", "chat"]);
  });

  it("a re-raised alert keeps its NEW slot afterwards", () => {
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("alert"), m("chat")], c.now());
    orderByArrival(o, [m("chat")], c.now()); // answered; the card goes...
    c.advance(ARRIVAL_GRACE_MS * 5); // ...and stays gone well past the window
    expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now())).at(-1)).toBe("alert");
    for (let i = 0; i < 3; i++) {
      c.advance(500);
      expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now())).at(-1)).toBe("alert");
    }
  });

  it("a CONTINUOUSLY present id never goes stale, however long it stays", () => {
    // ORDER-SENSITIVE on purpose. Feeding the ids in the order the ledger already holds makes
    // re-slotting invisible — the churned result matches the input either way, so the assertion
    // passes while the ledger renumbers on every iteration (roborev 53594). Feeding the REVERSE
    // order means only a ledger that held its slots can produce the expected output.
    const o = createArrivalOrder();
    const c = clock();
    orderByArrival(o, [m("alert"), m("chat")], c.now());
    for (let i = 0; i < 60; i++) {
      c.advance(60_000);
      expect(ids(orderByArrival(o, [m("chat"), m("alert")], c.now()))).toEqual(["alert", "chat"]);
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
