// The render counter's job is to make render THRASH obvious. Its failure mode isn't missing the
// thrash — it's drowning it: a line per render means the burst you're hunting is spread over
// thousands of lines that you have to count by hand, in a file where every other line is also a
// render. These tests pin the coalescing that keeps the fingerprint (how many renders, how fast)
// while bounding what a burst can write.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { log } from "./logger";
import { __resetRenderTraceForTest, perfRender } from "./perfTrace";

/** Hand-driven clock, so a "burst" is just many calls at the same instant. */
function clock() {
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

/** The render lines actually written, as `{ key, count, since, ms }` payloads. */
function renderLines(debug: ReturnType<typeof vi.spyOn>) {
  return debug.mock.calls
    .filter(([, msg]) => typeof msg === "string" && msg.startsWith("render "))
    .map(([, , meta]) => meta as Record<string, unknown>);
}

describe("perfRender", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetRenderTraceForTest();
  });

  it("logs the first render of a key immediately", () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    clock();

    perfRender("AgentPane", "a");

    expect(renderLines(debug)).toMatchObject([{ key: "a", count: 1 }]);
  });

  it("coalesces a burst into a single line instead of one line per render", () => {
    // Deliberately an order of magnitude past the worst per-key burst seen in real traffic (~150
    // renders in a second): the guard is per-key rate, so it must hold however hard one key spins.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    for (let i = 0; i < 1700; i++) perfRender("AgentPane", "a");
    c.advance(1_000);
    perfRender("AgentPane", "a"); // first render past the window flushes the burst

    const lines = renderLines(debug);
    expect(lines).toHaveLength(2); // NOT 1701
    // The burst is still fully accounted for: of the 1700 loop renders the first was logged and
    // 1699 were suppressed, so this flush line's `since` covers those 1699 plus itself, and `count`
    // is all 1700 plus itself.
    expect(lines[1]).toMatchObject({ key: "a", count: 1701, since: 1700, ms: 1_000 });
  });

  it("keeps the cumulative count exact across coalesced windows", () => {
    // `count` is what makes a thrashing pane obvious at a glance, so suppression must never cost a
    // render: a line's count is the true total, not the number of lines written.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 50; i++) perfRender("AgentPane", "a");
      c.advance(1_000);
    }
    perfRender("AgentPane", "a");

    const lines = renderLines(debug);
    expect(lines.at(-1)).toMatchObject({ count: 151 });
  });

  it("tracks each key independently", () => {
    // A quiet pane must not have its first render swallowed by a noisy pane's window.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    clock();

    perfRender("AgentPane", "noisy");
    perfRender("AgentPane", "noisy");
    perfRender("AgentPane", "quiet");

    expect(renderLines(debug)).toMatchObject([
      { key: "noisy", count: 1 },
      { key: "quiet", count: 1 },
    ]);
  });

  it("gives two components sharing a key their own windows", () => {
    // Both real call sites pass key "main"-ish values, so the same key under different components
    // must not coalesce. (This pins the component/key pairing only — NOT delimiter ambiguity
    // between them, which the `${component}:${key}` id doesn't defend against and doesn't need to:
    // component names are hardcoded literals here, none containing ":".)
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    clock();

    perfRender("Workspace", "main");
    perfRender("AgentPane", "main");

    expect(renderLines(debug)).toHaveLength(2);
  });

  it("passes caller meta through on the lines it writes", () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    clock();

    perfRender("AgentPane", "a", { visible: false });

    expect(renderLines(debug)[0]).toMatchObject({ visible: false });
  });

  it("passes caller meta through on a coalesced line too", () => {
    // The coalesced branch builds its payload independently of the first-render branch, so meta
    // pass-through has to be pinned on both or a regression in one goes unnoticed.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    perfRender("AgentPane", "a", { visible: false });
    c.advance(1_000);
    perfRender("AgentPane", "a", { visible: false });

    expect(renderLines(debug)[1]).toMatchObject({ visible: false, since: 1, ms: 1_000 });
  });

  it("does not let caller meta clobber the instrument's own fields", () => {
    // `ms` is a plausible name for a caller to pass (perfSpan uses it as a meta name in this same
    // file). If caller meta won, the coalesced line's `ms` would be the caller's number and the
    // rate signal this whole guard exists to preserve would read as a lie.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    perfRender("AgentPane", "a");
    c.advance(1_000);
    perfRender("AgentPane", "a", { ms: 12, count: 999, since: 7 });

    expect(renderLines(debug)[1]).toMatchObject({ ms: 1_000, count: 2, since: 1 });
  });

  it("reports ms as the span since the previous line, not the burst's arrival span", () => {
    // The documented limit of `since`/`ms` as a rate. Renders cluster at the front of the window and
    // then stop; the flush only happens when some later render arrives, so `ms` covers the idle gap
    // too and the derived rate reads far below the burst's real one. Pinned deliberately: `count`
    // and `since` stay exact (the burst is never hidden), and the rate only understates once the key
    // has stopped thrashing. If this ever changes, it should change on purpose.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    perfRender("AgentPane", "a"); // logs; opens the window
    for (let i = 0; i < 399; i++) perfRender("AgentPane", "a"); // 400-render burst, all at t=0
    c.advance(60_000); // ...then the pane goes quiet
    perfRender("AgentPane", "a"); // the render that finally flushes it

    const line = renderLines(debug)[1];
    expect(line).toMatchObject({ count: 401, since: 400, ms: 60_000 });
    // i.e. ~7/sec derived, for a burst that really ran at ~2000/sec — but `since` is still 400.
  });

  it("does not coalesce a steady low render rate into silence", () => {
    // Coalescing is a burst guard, not a sampler: renders spaced past the window each get a line.
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const c = clock();

    for (let i = 0; i < 4; i++) {
      perfRender("AgentPane", "a");
      c.advance(1_500);
    }

    expect(renderLines(debug)).toHaveLength(4);
  });
});
