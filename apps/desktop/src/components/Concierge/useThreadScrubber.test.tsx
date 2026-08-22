// @vitest-environment jsdom
//
// useThreadScrubber — the rail's controller (beads sparkle-7m719, sparkle-bjbhw6).
//
// EVERY ASSERTION IS ON WHAT THE CONTROLLER PRODUCED — the marks it exposes, the scroll offset it
// wrote, the id it jumped to, the backlog it grew — never on whether a query or a loader was merely
// called. "loadBack ran" is the precondition; "the turn is now loaded and the jump went to it" is
// the claim.
//
// ── HOW A LAYOUT-LESS ENVIRONMENT TESTS A SCROLL CONTROLLER ────────────────────────────────────
// jsdom implements no layout: `scrollHeight`, `clientHeight` and every `getBoundingClientRect` read
// 0, and `scrollTop` is a plain settable property with no clamping. So `fakeScroller` below installs
// the four numbers this controller reads and nothing else. That is not a workaround — it is what
// makes the arithmetic assertable at all, and it is why `measurePromptMarks` is exported as a
// function over an element rather than living inside the hook where only a rendered rail could
// reach it (docs/jsdom-test-caveats.md).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCOPE_MS,
  fractionOf,
  measurePromptMarks,
  PROMPT_ROW_SELECTOR,
  setThreadScrubberIo,
  useThreadScrubber,
  type ThreadScrubberController,
} from "./useThreadScrubber";
import {
  setConciergeBacklogIo,
  useConciergeBacklogStore,
} from "../../stores/conciergeBacklogStore";
import { setConciergeChat, useConciergeThreadStore } from "../../stores/conciergeThreadStore";
import type { HistoryRangeRow, PromptMarkerRow } from "../../services/history";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

function marker(id: string, atMs: number): PromptMarkerRow {
  return { id, createdAt: atMs, textPrefix: `prefix of ${id}` };
}

/**
 * A scroller with the four numbers the controller reads, and rows at known offsets.
 *
 * Offsets are installed via `getBoundingClientRect` because that is what `measurePromptMarks` reads
 * — `offsetTop` is not implemented in jsdom either, and stubbing the property the code does NOT use
 * would make the test pass against a controller that measured nothing.
 */
function fakeScroller(opts: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
  /** [message id, offset within the scrolled content] */
  rows: Array<[string, number]>;
}): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: opts.clientHeight, configurable: true });
  el.scrollTop = opts.scrollTop ?? 0;
  el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  for (const [id, offset] of opts.rows) {
    const row = document.createElement("div");
    row.setAttribute("data-message-id", id);
    // The SAME attribute `ConciergeMessageRow` puts on the founder's own bubbles — reused rather
    // than invented, which is what lets the rail measure real prompts with no second attribute for
    // the next message kind to forget.
    row.setAttribute("data-quote-source", "you");
    row.textContent = `the text of ${id}`;
    // Rows are positioned in CONTENT space; the viewport reading is content offset minus scrollTop.
    row.getBoundingClientRect = () =>
      ({ top: offset - el.scrollTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    el.appendChild(row);
  }
  document.body.appendChild(el);
  return el;
}

/** Mount the hook and expose its latest controller. */
function mount(deps: Parameters<typeof useThreadScrubber>[0] = {}) {
  const seen: ThreadScrubberController[] = [];
  function Probe() {
    seen.push(useThreadScrubber(deps));
    return null;
  }
  const utils = render(<Probe />);
  return { ...utils, latest: () => seen[seen.length - 1]!, renders: () => seen.length };
}

beforeEach(() => {
  useConciergeBacklogStore.getState().clear();
  setConciergeChat([]);
  document.body.innerHTML = "";
  setThreadScrubberIo({
    now: () => NOW,
    promptsInRange: async () => [],
    promptDensity: async () => [],
    historyExtent: async () => ({ oldestMs: null, newestMs: null, count: 0 }),
  });
  setConciergeBacklogIo({ now: () => NOW, entriesInRange: async () => [] });
});

afterEach(() => cleanup());

// ── MEASUREMENT: the DOM is the authority on POSITION ───────────────────────────────────────────
describe("measuring prompts on the scroller's own axis", () => {
  // THE DENOMINATOR IS THE THING THAT CAN BE WRONG. `scrollHeight - clientHeight` is what the handle
  // is measured against too, so a mark at fraction f and the handle at f must name the same scroll
  // position. Dividing by `scrollHeight` instead puts every mark systematically ABOVE the handle
  // that reaches it — off by one viewport, which at the bottom of the thread is everything. These
  // exact values only come out right for the scrollable range: 300/600 = 0.5, not 300/1000 = 0.3.
  it("divides by the SCROLLABLE RANGE, not by the content height", () => {
    const el = fakeScroller({
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [["a", 0], ["b", 300], ["c", 600]],
    });
    expect(measurePromptMarks(el).map((m) => m.fraction)).toEqual([0, 0.5, 1]);
  });

  it("reports positions in CONTENT space — unchanged by where the reader has scrolled to", () => {
    const rows: Array<[string, number]> = [["a", 0], ["b", 300], ["c", 600]];
    const top = measurePromptMarks(fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows }));
    document.body.innerHTML = "";
    const scrolled = measurePromptMarks(
      fakeScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 275, rows }),
    );
    // A rail whose marks slid under the handle as the reader scrolled would be unusable, and a
    // viewport-relative read produces exactly that.
    expect(scrolled.map((m) => m.fraction)).toEqual(top.map((m) => m.fraction));
  });

  it("numbers marks 1-based in document order and carries each row's id", () => {
    const el = fakeScroller({
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [["you-7", 0], ["you-8", 300]],
    });
    expect(measurePromptMarks(el).map((m) => [m.id, m.index])).toEqual([
      ["you-7", 1],
      ["you-8", 2],
    ]);
  });

  it("measures ONLY the founder's own bubbles", () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["mine", 0]] });
    const theirs = document.createElement("div");
    theirs.setAttribute("data-message-id", "brain-1");
    theirs.setAttribute("data-quote-source", "sparkle");
    el.appendChild(theirs);
    expect(measurePromptMarks(el).map((m) => m.id)).toEqual(["mine"]);
    expect(el.querySelectorAll(PROMPT_ROW_SELECTOR)).toHaveLength(1);
  });

  // A thread with nothing to scroll has every row at the TOP. Dividing by the zero range would
  // report NaN, which places every mark at `NaN%` and paints nothing at all.
  it("puts every mark at 0 — never NaN — in a thread with nothing to scroll", () => {
    const el = fakeScroller({ scrollHeight: 300, clientHeight: 400, rows: [["a", 0], ["b", 100]] });
    expect(measurePromptMarks(el).map((m) => m.fraction)).toEqual([0, 0]);
  });
});

// ── DEFECT 2 / 11: a scrub writes the scroller ─────────────────────────────────────────────────
describe("scrubbing scrolls the thread", () => {
  it("writes scrollTop from the fraction, on the scroller it was handed", async () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["a", 0]] });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));

    // THE SIDE EFFECT — the offset the thread is actually at, not "onScrub was called". 0.25 of a
    // 600px travel is 150.
    act(() => h.latest().onScrub(0.25));
    expect(el.scrollTop).toBe(150);
    act(() => h.latest().onScrub(1));
    expect(el.scrollTop).toBe(600);
    act(() => h.latest().onScrub(0));
    expect(el.scrollTop).toBe(0);
  });

  // The handle must not lag the content by a frame: `position` is set from the value just written
  // rather than waiting for the scroll event to come back round.
  it("moves the handle in the same tick it moves the thread", async () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["a", 0]] });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    act(() => h.latest().onScrub(0.4));
    expect(h.latest().position).toBeCloseTo(0.4, 10);
  });

  it("clamps a scrub that ran off either end", async () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["a", 0]] });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    act(() => h.latest().onScrub(-4));
    expect(el.scrollTop).toBe(0);
    expect(h.latest().position).toBe(0);
    act(() => h.latest().onScrub(9));
    expect(el.scrollTop).toBe(600);
    expect(h.latest().position).toBe(1);
  });

  // Attaching must MEASURE, not merely remember: a thread the reader never scrolls would otherwise
  // show an empty rail forever, which is the "the rail is broken" reading this feature exists to
  // avoid.
  it("measures the moment the scroller is attached, with no scroll needed", async () => {
    const el = fakeScroller({
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [["a", 0], ["b", 600]],
    });
    const h = mount();
    await act(async () => {});
    expect(h.latest().marks).toHaveLength(0);
    act(() => h.latest().attachScroller(el));
    expect(h.latest().marks.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

// ── DEFECT 3: the true extent, and the scope as a paging request ────────────────────────────────
describe("the scope", () => {
  it("surfaces MIN(created_at) so the menu can print how far back history goes", async () => {
    const OLDEST = NOW - 10 * DAY;
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: OLDEST, newestMs: NOW, count: 255 }),
    });
    const h = mount();
    await act(async () => {});
    expect(h.latest().oldestMs).toBe(OLDEST);
  });

  // "ALL" MUST QUERY FROM THE MEASURED EDGE, not from a nominal century. Asserting the WINDOW that
  // reached the store is the only version of this that can go red — a controller that ignored the
  // extent still exposes the same `oldestMs`.
  it("queries All from the measured oldest row", async () => {
    const OLDEST = NOW - 10 * DAY;
    const windows: Array<[number, number]> = [];
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: OLDEST, newestMs: NOW, count: 255 }),
      promptsInRange: async (fromMs, toMs) => {
        windows.push([fromMs, toMs]);
        return [];
      },
    });
    mount({ initialScope: "all" });
    await act(async () => {});
    expect(windows[0]).toEqual([OLDEST, NOW]);
  });

  it("queries a bounded scope from its own edge, ignoring the extent", async () => {
    const windows: Array<[number, number]> = [];
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: NOW - 400 * DAY, newestMs: NOW, count: 9 }),
      promptsInRange: async (fromMs, toMs) => {
        windows.push([fromMs, toMs]);
        return [];
      },
    });
    mount({ initialScope: "3h" });
    await act(async () => {});
    expect(windows[0]).toEqual([NOW - SCOPE_MS["3h"], NOW]);
  });

  // ON A CONTENT AXIS A SCOPE IS A PAGING REQUEST. His sentence — "if it has one week at the top of
  // the slider, it takes me all the way back to one week ago" — is only true if a week of turns is
  // actually IN the thread. The assertion is on the backlog the store grew, not on loadBack firing.
  //
  // ON THE CHANGE, NOT ON MOUNT, and the pair below is what pins the distinction: paging inserts
  // turns ABOVE the live window, so doing it at mount would put a day of history the founder never
  // asked for on screen every time the column opens.
  it("pages history back to the scope's edge when the reader CHANGES it", async () => {
    const asked: Array<[number, number]> = [];
    setConciergeBacklogIo({
      now: () => NOW,
      entriesInRange: async (fromMs, toMs): Promise<HistoryRangeRow[]> => {
        asked.push([fromMs, toMs]);
        return [
          { id: "old-1", kind: "prompt", createdAt: NOW - 6 * DAY, text: "a week ago" },
          { id: "old-2", kind: "response", createdAt: NOW - 6 * DAY + 1, text: "answered" },
        ];
      },
    });
    const h = mount({ initialScope: "1h" });
    await act(async () => {});
    // THE PRECONDITION: mounting alone pages NOTHING.
    expect(useConciergeBacklogStore.getState().backlog).toHaveLength(0);
    expect(asked).toHaveLength(0);

    await act(async () => {
      h.latest().setScope("7d");
    });
    await act(async () => {});
    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toContain("old-1");
    expect(asked[0]![0]).toBeLessThanOrEqual(NOW - SCOPE_MS["7d"]);
    expect(h.latest().scope).toBe("7d");
  });

  // THE OTHER HALF, stated on its own so "mounting pages nothing" cannot be satisfied by a
  // controller that never pages at all.
  it("pages nothing at mount, however wide the scope it opens on", async () => {
    const asked: number[] = [];
    setConciergeBacklogIo({
      now: () => NOW,
      entriesInRange: async (fromMs): Promise<HistoryRangeRow[]> => {
        asked.push(fromMs);
        return [{ id: "old-1", kind: "prompt", createdAt: NOW - 300 * DAY, text: "ancient" }];
      },
    });
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: NOW - 300 * DAY, newestMs: NOW, count: 9 }),
    });
    mount({ initialScope: "all" });
    await act(async () => {});
    expect(asked).toHaveLength(0);
    expect(useConciergeBacklogStore.getState().backlog).toHaveLength(0);
  });
});

// ── DEFECT 7: the rail must not claim the loaded thread is all there is ─────────────────────────
describe("what is still above the loaded window", () => {
  // COUNTED BY AGGREGATE, never by fetching rows — the founder's own constraint, because the table
  // reaches ~1 GB/year and he wants all of it kept. The assertion is on the NUMBER the rail reports
  // and on the window the aggregate was taken over, so a controller that counted the rows it already
  // had (and therefore could never see what it did not fetch) goes red.
  it("reports the aggregate count of older prompts", async () => {
    const OLDEST = NOW - 100 * DAY;
    const LOADED_FROM = NOW - 1 * DAY;
    const ranges: Array<[number, number, number]> = [];
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: OLDEST, newestMs: NOW, count: 2514 }),
      promptsInRange: async () => [marker("a", LOADED_FROM), marker("b", NOW - MINUTE)],
      promptDensity: async (fromMs, toMs, _source, buckets) => {
        ranges.push([fromMs, toMs, buckets]);
        return [
          {
            index: 0,
            startMs: fromMs,
            endMs: toMs,
            count: 2311,
            firstAtMs: fromMs,
            newestAtMs: toMs,
            newestId: "x",
            newestTextPrefix: "x",
          },
        ];
      },
    });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});
    expect(h.latest().moreAbove).toBe(2311);
    // ONE bucket over everything strictly older than the oldest loaded row — a COUNT, not a profile.
    expect(ranges[0]).toEqual([OLDEST, LOADED_FROM - 1, 1]);
  });

  it("reports nothing older when the loaded window already reaches the oldest row", async () => {
    const OLDEST = NOW - 2 * DAY;
    const density = vi.fn(async () => []);
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: OLDEST, newestMs: NOW, count: 3 }),
      promptsInRange: async () => [marker("a", OLDEST)],
      promptDensity: density,
    });
    const h = mount({ initialScope: "all" });
    await act(async () => {});
    expect(h.latest().moreAbove).toBe(0);
    // …and it does not ask: there is provably nothing above, so a query would be a round trip whose
    // answer is already known.
    expect(density).not.toHaveBeenCalled();
  });

  // A count we could not take is reported as "none known", never as a guess — the handle's label
  // then omits the clause rather than claiming a number that is not true.
  it("reports 0 rather than guessing when the aggregate rejects", async () => {
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: NOW - 100 * DAY, newestMs: NOW, count: 9 }),
      promptsInRange: async () => [marker("a", NOW - DAY)],
      promptDensity: async () => {
        throw new Error("bridge down");
      },
    });
    const h = mount({ initialScope: "1d" });
    await act(async () => {});
    expect(h.latest().moreAbove).toBe(0);
  });
});

// ── THE CARDS: the store is the authority on TIME ───────────────────────────────────────────────
describe("enriching a measured mark with what the store knows", () => {
  it("takes the instant and the prompt text from the store, keeping the measured position", async () => {
    const AT = NOW - 3 * DAY;
    setThreadScrubberIo({
      historyExtent: async () => ({ oldestMs: AT, newestMs: NOW, count: 1 }),
      promptsInRange: async () => [marker("you-1", AT)],
    });
    const el = fakeScroller({
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [["you-1", 300]],
    });
    const h = mount({ initialScope: "all" });
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    const mark = h.latest().marks[0]!;
    expect(mark.createdAt).toBe(AT);
    // The STORED prefix wins over the rendered node's textContent, which carries the row's chrome.
    expect(mark.textPrefix).toBe("prefix of you-1");
    expect(mark.fraction).toBe(0.5);
  });

  // A live bubble has a rendered row before it has a history row. It must still get a mark — the
  // prompt he just sent is the one he is most likely to scrub back to — and its age is genuinely
  // unknown rather than "just now".
  it("still marks a bubble the store has never heard of, with no invented instant", async () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["brand-new", 600]] });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    const mark = h.latest().marks[0]!;
    expect(mark.id).toBe("brand-new");
    expect(mark.createdAt).toBeUndefined();
    expect(mark.textPrefix).toBe("the text of brand-new");
  });
});

// ── A REJECTED QUERY IS NOT A QUIET WEEK ────────────────────────────────────────────────────────
describe("a failed history read", () => {
  it("is recorded, not swallowed", async () => {
    setThreadScrubberIo({
      historyExtent: async () => {
        throw new Error("bridge down");
      },
    });
    const h = mount();
    await act(async () => {});
    expect(h.latest().failed).toBe(true);
  });

  // THE MARKS SURVIVE IT, which is the difference the content axis makes. The rail draws what is
  // RENDERED; SQLite only supplies the ages. A bridge that cannot answer costs the cards their
  // timestamps, not the rail its marks — the previous design lost every dot.
  it("still draws every rendered prompt", async () => {
    setThreadScrubberIo({
      historyExtent: async () => {
        throw new Error("bridge down");
      },
    });
    const el = fakeScroller({
      scrollHeight: 1000,
      clientHeight: 400,
      rows: [["a", 0], ["b", 600]],
    });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    expect(h.latest().failed).toBe(true);
    expect(h.latest().marks.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("clears once a later query succeeds", async () => {
    let fail = true;
    setThreadScrubberIo({
      historyExtent: async () => {
        if (fail) throw new Error("bridge down");
        return { oldestMs: NOW - DAY, newestMs: NOW, count: 1 };
      },
    });
    const h = mount({ initialScope: "1h" });
    await act(async () => {});
    expect(h.latest().failed).toBe(true);
    fail = false;
    act(() => h.latest().setScope("6h"));
    await act(async () => {});
    expect(h.latest().failed).toBe(false);
  });
});

// ── THE STALE-FETCH GUARD ───────────────────────────────────────────────────────────────────────
describe("a superseded scope's answer is ignored", () => {
  // A REAL RACE, NOT A HYPOTHETICAL. The wide query scans everything and very often resolves AFTER
  // the narrow one it was superseded by; without the ticket the rail then describes a year of
  // prompts on an axis that says one hour. Asserted on the VALUE that survived.
  it("keeps the newest scope's answer when an older one resolves last", async () => {
    const gates: Array<() => void> = [];
    setThreadScrubberIo({
      historyExtent: async () => {
        const which = gates.length;
        await new Promise<void>((res) => gates.push(res));
        return which === 0
          ? { oldestMs: 111, newestMs: NOW, count: 1 }
          : { oldestMs: 222, newestMs: NOW, count: 2 };
      },
    });
    const h = mount({ initialScope: "all" });
    await act(async () => {});
    act(() => h.latest().setScope("1h"));
    await act(async () => {});
    expect(gates).toHaveLength(2);

    // The SECOND (current) query answers first, then the superseded first one answers last.
    await act(async () => {
      gates[1]!();
    });
    await act(async () => {
      gates[0]!();
    });
    expect(h.latest().oldestMs).toBe(222);
  });
});

// ── PICKING A MARK ──────────────────────────────────────────────────────────────────────────────
describe("picking a mark", () => {
  it("jumps straight to a turn already on screen", async () => {
    setConciergeChat([
      { id: "you-1", kind: "you", text: "hello" },
    ] as Parameters<typeof setConciergeChat>[0]);
    const jumps: string[] = [];
    const h = mount({ onJump: (id) => jumps.push(id) });
    await act(async () => {});
    await act(async () => {
      h.latest().onPick({ id: "you-1", fraction: 0.5, textPrefix: "hello", index: 1, createdAt: NOW });
    });
    expect(jumps).toEqual(["you-1"]);
  });

  // THE ORDERING IS THE FEATURE. `jumpTo` scans the thread's scroller and returns silently when it
  // finds nothing, so a jump issued before the load is a click that does nothing at all — which is
  // what the rail did in every previous attempt at this bead. Asserted by the turn being LOADED
  // when the jump happens, not by the two calls' order.
  it("pages an old turn in FIRST, then jumps to it", async () => {
    const AT = NOW - 9 * DAY;
    setConciergeBacklogIo({
      now: () => NOW,
      entriesInRange: async (): Promise<HistoryRangeRow[]> => [
        { id: "old-1", kind: "prompt", createdAt: AT, text: "nine days ago" },
      ],
    });
    const loadedWhenJumped: boolean[] = [];
    const h = mount({
      onJump: () => {
        loadedWhenJumped.push(
          useConciergeBacklogStore.getState().backlog.some((m) => m.id === "old-1"),
        );
      },
    });
    await act(async () => {});
    await act(async () => {
      await h.latest().onPick({ id: "old-1", fraction: 0, textPrefix: "x", index: 1, createdAt: AT });
    });
    expect(loadedWhenJumped).toEqual([true]);
  });

  it("moves the handle before it awaits the load", async () => {
    const h = mount();
    await act(async () => {});
    act(() => {
      h.latest().onPick({ id: "nope", fraction: 0.7, textPrefix: "x", index: 1, createdAt: NOW });
    });
    expect(h.latest().position).toBeCloseTo(0.7, 10);
  });
});

describe("fractionOf", () => {
  it("places an instant on a [now - span, now] track, clamped", () => {
    expect(fractionOf(NOW, NOW, DAY)).toBe(1);
    expect(fractionOf(NOW - DAY, NOW, DAY)).toBe(0);
    expect(fractionOf(NOW - DAY / 2, NOW, DAY)).toBeCloseTo(0.5, 10);
    expect(fractionOf(NOW - 5 * DAY, NOW, DAY)).toBe(0);
    expect(fractionOf(NOW + DAY, NOW, DAY)).toBe(1);
    // A degenerate span collapses to the newest end rather than dividing by zero.
    expect(fractionOf(NOW, NOW, 0)).toBe(1);
  });
});

describe("the live thread store still drives a refresh", () => {
  it("re-measures when the founder sends a new prompt", async () => {
    const el = fakeScroller({ scrollHeight: 1000, clientHeight: 400, rows: [["you-1", 0]] });
    const h = mount();
    await act(async () => {});
    act(() => h.latest().attachScroller(el));
    expect(h.latest().marks).toHaveLength(1);

    // A new bubble lands in the DOM and the store at the same time; the store change is what tells
    // the controller to look again, because appending a row fires no scroll event of its own.
    const row = document.createElement("div");
    row.setAttribute("data-message-id", "you-2");
    row.setAttribute("data-quote-source", "you");
    row.getBoundingClientRect = () => ({ top: 600, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    el.appendChild(row);
    await act(async () => {
      setConciergeChat([
        { id: "you-2", kind: "you", text: "new" },
      ] as Parameters<typeof setConciergeChat>[0]);
    });
    expect(useConciergeThreadStore.getState().chat).toHaveLength(1);
    expect(h.latest().marks.map((m) => m.id)).toEqual(["you-1", "you-2"]);
  });
});
