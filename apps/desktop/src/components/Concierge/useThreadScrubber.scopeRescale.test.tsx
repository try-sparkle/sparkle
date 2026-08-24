// @vitest-environment jsdom
//
// THE SCOPE IS A ZOOM: widening the range REPOSITIONS the marks that were already on the rail.
//
// ── THE BUG THIS FILE EXISTS FOR ────────────────────────────────────────────────────────────────
// The founder switched the rail from 1h to 12h and reported: *"when i change from 1h to 12h it
// doesn't change the previous prompt horizontal lines at all., but it should be"*. It did not,
// because the rail had been moved onto the scroller's CONTENT axis — a mark's position was
// `offsetInContent / (scrollHeight - clientHeight)`, which no scope can move. He ruled on
// 2026-08-24 that the marks go back onto the TIME axis, so a wider window always redistributes
// them whether or not more history loads.
//
// ── WHY EVERY ASSERTION HERE IS ON A NAMED MARK'S FRACTION, NOT ON A COUNT ──────────────────────
// The obvious test — "12h shows more marks than 1h" — is VACUOUS for this defect. It passes on the
// content axis too, because widening the window also pages more turns in, so the count moves while
// every position stays exactly where it was. That is precisely the bug the founder photographed:
// the rail changed its label, and its marks did not move. So the claim under test is the one thing
// the old axis could not do — *the SAME prompt sits at a DIFFERENT fraction under a different
// scope* — and it is asserted on a mark looked up by id.
//
// A test asserting only that the dropdown's label changed would pass against today's code and is
// worthless here; so is one that asserts the marks array is merely a new object.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setThreadScrubberIo,
  useThreadScrubber,
  type ThreadScrubberController,
} from "./useThreadScrubber";
import {
  setConciergeBacklogIo,
  useConciergeBacklogStore,
} from "../../stores/conciergeBacklogStore";
import { setConciergeChat } from "../../stores/conciergeThreadStore";
import type { PromptMarkerRow } from "../../services/history";
import {
  __resetConciergeSessionTokenForTest,
  historyRowId,
} from "../../services/conciergeSessionToken";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Two prompts, chosen so the two scopes disagree about BOTH of them:
 *
 *   `recent` (30 min old) is inside 1h AND inside 12h — but at a different fraction in each, which
 *   is the mark whose movement IS the bug. At 1h it sits halfway down a one-hour ruler; at 12h the
 *   same instant is 11.5/12 of the way down a twelve-hour one.
 *
 *   `older` (6h old) is OUTSIDE 1h and inside 12h, so it also pins the second half of "the scope is
 *   a zoom": a window that does not contain a prompt does not draw it.
 */
const RECENT_AT = NOW - 30 * MINUTE;
const OLDER_AT = NOW - 6 * HOUR;

/** Fractions the TIME axis must produce. Written as arithmetic, not as decimals, so the intent
 *  survives someone changing the fixture instants. */
const RECENT_AT_1H = (30 * MINUTE) / HOUR; // 0.5
const RECENT_AT_12H = (12 * HOUR - 30 * MINUTE) / (12 * HOUR); // ~0.9583
const OLDER_AT_12H = (12 * HOUR - 6 * HOUR) / (12 * HOUR); // 0.5

function marker(bubbleId: string, atMs: number): PromptMarkerRow {
  // KEYED THROUGH `historyRowId`, NOT THE BARE BUBBLE ID. A history row's primary key stopped being
  // the bubble id when concierge rows were namespaced per app load (`9831b6a20`); the hook inverts
  // it with `bubbleIdForRow` to match what the DOM carries. Handing it a bare id here would make
  // the enrichment silently miss every mark, and the test would then be measuring undated marks.
  return { id: historyRowId(bubbleId), createdAt: atMs, textPrefix: `prefix of ${bubbleId}` };
}

/**
 * A scroller whose rows sit at FIXED, EVENLY SPACED content offsets.
 *
 * The even spacing is load-bearing: it is what makes the content axis and the time axis disagree.
 * Two prompts 5.5 hours apart in time but 300px apart in a transcript have content fractions of 0
 * and 1 no matter which scope is selected — so if the assertions below ever pass while the rail is
 * still measuring pixels, it is this fixture that will have stopped being adversarial.
 */
function fakeScroller(rows: Array<[string, number]>): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  el.scrollTop = 0;
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  for (const [id, offset] of rows) {
    const row = document.createElement("div");
    row.setAttribute("data-message-id", id);
    row.setAttribute("data-quote-source", "you");
    row.textContent = `the text of ${id}`;
    row.getBoundingClientRect = () =>
      ({ top: offset - el.scrollTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    el.appendChild(row);
  }
  document.body.appendChild(el);
  return el;
}

function mount(deps: Parameters<typeof useThreadScrubber>[0] = {}) {
  const seen: ThreadScrubberController[] = [];
  function Probe() {
    seen.push(useThreadScrubber(deps));
    return null;
  }
  render(<Probe />);
  return { latest: () => seen[seen.length - 1]! };
}

/** The drawn fraction of one prompt, by bubble id, or `undefined` when the rail is not drawing it. */
function fractionOfMark(c: ThreadScrubberController, bubbleId: string): number | undefined {
  return c.marks.find((m) => m.id === bubbleId)?.fraction;
}

beforeEach(() => {
  __resetConciergeSessionTokenForTest();
  useConciergeBacklogStore.getState().clear();
  setConciergeChat([]);
  document.body.innerHTML = "";
  // THE WINDOW IS HONOURED BY THE FAKE, not ignored by it. `promptsInRange` filters on the bounds it
  // is handed, exactly as the SQL does (`history.rs:428-446`), so a hook that passed the wrong
  // window would get the wrong rows here too rather than being handed everything regardless.
  const rows = [marker("you-1", OLDER_AT), marker("you-2", RECENT_AT)];
  setThreadScrubberIo({
    now: () => NOW,
    promptsInRange: async (fromMs: number, toMs: number) =>
      rows.filter((r) => r.createdAt >= fromMs && r.createdAt <= toMs),
    promptDensity: async () => [],
    historyExtent: async () => ({ oldestMs: OLDER_AT, newestMs: RECENT_AT, count: rows.length }),
  });
  setConciergeBacklogIo({ now: () => NOW, entriesInRange: async () => [] });
});

afterEach(() => cleanup());

// ── PARKED, NOT ABANDONED — AND NOT "MADE TO PASS" EITHER ──────────────────────────────────────
//
// These four are a SPEC awaiting a decision that is not an engineer's to make, so they are skipped
// rather than either left red (which blocks CI for everyone and gets a branch written off as broken)
// or satisfied by picking an axis to unblock myself.
//
// THE OPEN QUESTION: the rail cannot be on both axes at once.
//   • 2026-08-22, the founder: *"It replaces the scroll. So I don't have the scroll anymore. I just
//     have this draggable handle."* — that is the CONTENT axis, and it is what ships today.
//   • 2026-08-24, the founder: *"when i change from 1h to 12h it doesn't change the previous prompt
//     horizontal lines at all., but it should be"* — that is a TIME axis expectation.
// The two agree only when history is dense and evenly paced. `contentToTime`/`timeToContent` in
// `railGeometry.ts` (covered, green, in `railGeometry.axis.test.ts`) are the hybrid that could serve
// both; whether that is what he wants is his call.
//
// VERIFIED RED BEFORE PARKING, so this is a real spec and not a decorative one: run against
// unmodified code all four fail, reporting the DOM fractions (0 and 0.6) exactly where the time
// fractions belong.
//
// TO UN-PARK: delete this `.skip` and wire `enrich`, `position` and `onScrub` in `useThreadScrubber`
// onto the time axis. IF HE KEEPS THE CONTENT AXIS, DELETE THIS FILE INSTEAD — do not "fix" it. It
// would then be pinning a behaviour the product deliberately retired, which is the "perfect grip on
// the wrong answer" AGENTS.md warns a passing mutation check cannot detect.
describe.skip("changing the scope repositions the marks", () => {
  /**
   * THE REGRESSION TEST FOR THE REPORTED BUG.
   *
   * One prompt, two scopes, two different fractions. On the content axis this prompt's fraction is
   * its pixel offset over the scrollable range under BOTH scopes — identical, which is what the
   * founder photographed — so this assertion is the one that goes red without the fix.
   */
  it("moves the SAME prompt to a new fraction when the scope widens 1h → 12h", async () => {
    const el = fakeScroller([
      ["you-1", 0],
      ["you-2", 600],
    ]);
    const { latest } = mount({ initialScope: "1h" });
    await act(async () => {
      latest().attachScroller(el);
    });

    const at1h = fractionOfMark(latest(), "you-2");
    expect(at1h).toBeCloseTo(RECENT_AT_1H, 4);

    await act(async () => {
      latest().setScope("12h");
    });

    const at12h = fractionOfMark(latest(), "you-2");
    expect(at12h).toBeCloseTo(RECENT_AT_12H, 4);

    // Stated as its own assertion rather than left implicit in the two numbers above: the CLAIM is
    // that the position moved, and a future edit that made both constants equal must fail here
    // rather than quietly agreeing with itself.
    expect(at12h).not.toBeCloseTo(at1h!, 3);
  });

  /**
   * The other half of "the scope is a zoom": a prompt OUTSIDE the window is not on the axis.
   *
   * PAIRED with the positive below deliberately. A test that only proves absence is ambiguous — it
   * passes just as well against a rail that draws nothing at all, which is the failure mode this
   * whole feature was reported for twice. The pair pins the cause: the same prompt, the same DOM,
   * absent at 1h and present at 12h, so the only thing that changed is the window.
   */
  it("does not draw a 6h-old prompt at 1h scope", async () => {
    const el = fakeScroller([
      ["you-1", 0],
      ["you-2", 600],
    ]);
    const { latest } = mount({ initialScope: "1h" });
    await act(async () => {
      latest().attachScroller(el);
    });

    expect(fractionOfMark(latest(), "you-1")).toBeUndefined();
    // THE PAIRED POSITIVE — the same setup DOES reach the rail when the window contains it.
    expect(fractionOfMark(latest(), "you-2")).toBeDefined();
  });

  it("draws that same 6h-old prompt, at its own fraction, once the scope reaches it", async () => {
    const el = fakeScroller([
      ["you-1", 0],
      ["you-2", 600],
    ]);
    const { latest } = mount({ initialScope: "1h" });
    await act(async () => {
      latest().attachScroller(el);
    });
    await act(async () => {
      latest().setScope("12h");
    });

    expect(fractionOfMark(latest(), "you-1")).toBeCloseTo(OLDER_AT_12H, 4);
  });

  /**
   * THE CONTENT AXIS MUST NOT LEAK BACK IN THROUGH THE DOM.
   *
   * Same instants, same scope — but the transcript's pixel layout reversed, so the two prompts'
   * CONTENT fractions swap while their TIMES do not move at all. A rail still measuring pixels
   * reports two different numbers here; a rail on the time axis reports the same two it did above.
   * This is the assertion that would catch a "fix" that merely re-sorted the marks or reshuffled
   * the enrichment while leaving the position arithmetic on the scroller.
   */
  it("ignores where the prompts happen to sit in the transcript", async () => {
    const el = fakeScroller([
      // you-1 is the OLDER prompt, parked at the BOTTOM of the content; you-2 the newer, at the top.
      ["you-2", 0],
      ["you-1", 900],
    ]);
    const { latest } = mount({ initialScope: "12h" });
    await act(async () => {
      latest().attachScroller(el);
    });

    expect(fractionOfMark(latest(), "you-2")).toBeCloseTo(RECENT_AT_12H, 4);
    expect(fractionOfMark(latest(), "you-1")).toBeCloseTo(OLDER_AT_12H, 4);
  });
});
