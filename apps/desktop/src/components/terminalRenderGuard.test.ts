import { describe, it, expect, vi } from "vitest";
import {
  guardTerminalRenderRows,
  shouldLogSwallow,
  SWALLOW_LOG_HEARTBEAT,
} from "./terminalRenderGuard";

// A minimal stand-in for xterm's structure: `term._core._renderService._renderRows`. The real
// RenderDebouncer calls `this._renderRows(start, end)` off the live instance every frame, so
// replacing the instance property is exactly what the guard relies on — modelled here as a plain
// object whose `_renderRows` we reassign and then invoke.
function fakeTerm(renderRows: (start: number, end: number) => unknown) {
  const renderService = { _renderRows: renderRows };
  return { term: { _core: { _renderService: renderService } }, renderService };
}

describe("guardTerminalRenderRows", () => {
  it("swallows a throw from the render pass instead of letting it propagate", () => {
    // The production symptom: renderRows throws `undefined is not an object (evaluating 'a.loadCell')`
    // from inside xterm's rAF. Before the guard this escaped to window.onerror as an uncaught ERROR.
    const { term, renderService } = fakeTerm(() => {
      throw new TypeError("undefined is not an object (evaluating 'a.loadCell')");
    });
    const onSwallowed = vi.fn();

    guardTerminalRenderRows(term, onSwallowed);

    // The SIDE EFFECT under test: invoking the (now-wrapped) render callback the way the debouncer
    // does must NOT throw — the frame is dropped and the error is reported, not raised.
    expect(() => renderService._renderRows(0, 42)).not.toThrow();
    expect(onSwallowed).toHaveBeenCalledTimes(1);
    const [err, count] = onSwallowed.mock.calls[0]!;
    expect(count).toBe(1); // count is 1 on the first swallow
    expect(err).toBeInstanceOf(TypeError);
  });

  it("increments the swallow count across repeated throwing frames", () => {
    const { term, renderService } = fakeTerm(() => {
      throw new Error("boom");
    });
    const onSwallowed = vi.fn();
    guardTerminalRenderRows(term, onSwallowed);

    renderService._renderRows(0, 1);
    renderService._renderRows(0, 1);
    renderService._renderRows(0, 1);

    expect(onSwallowed).toHaveBeenCalledTimes(3);
    expect(onSwallowed.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
  });

  it("calls the original through and returns its value when it does NOT throw", () => {
    // Guards the healthy path: the wrapper must be transparent — same args in, same return out, and
    // no spurious swallow report. (A mutation that always returned undefined, or always reported a
    // swallow, fails here.)
    const original = vi.fn((start: number, end: number) => `rendered ${start}-${end}`);
    const { term, renderService } = fakeTerm(original);
    const onSwallowed = vi.fn();
    guardTerminalRenderRows(term, onSwallowed);

    const result = renderService._renderRows(3, 9);

    expect(result).toBe("rendered 3-9");
    expect(original).toHaveBeenCalledWith(3, 9);
    expect(onSwallowed).not.toHaveBeenCalled();
  });

  it("preserves `this` so the original method sees its own instance", () => {
    const seen: unknown[] = [];
    const renderService = {
      marker: "svc",
      _renderRows(this: { marker: string }, _s: number, _e: number) {
        seen.push(this.marker);
      },
    };
    const term = { _core: { _renderService: renderService } };
    guardTerminalRenderRows(term, vi.fn());

    renderService._renderRows(0, 0);

    expect(seen).toEqual(["svc"]);
  });

  it("restores the original _renderRows on unpatch (only if ours is still installed)", () => {
    const original = vi.fn();
    const { term, renderService } = fakeTerm(original);
    const unpatch = guardTerminalRenderRows(term, vi.fn());

    expect(renderService._renderRows).not.toBe(original); // wrapped
    unpatch();
    expect(renderService._renderRows).toBe(original); // restored
  });

  it("does NOT clobber a wrapper someone installed after us", () => {
    const original = vi.fn();
    const { term, renderService } = fakeTerm(original);
    const unpatch = guardTerminalRenderRows(term, vi.fn());

    const laterWrapper = vi.fn();
    renderService._renderRows = laterWrapper; // a third party re-wraps after us

    unpatch();
    expect(renderService._renderRows).toBe(laterWrapper); // left intact
  });

  it("degrades to a warning no-op when the xterm internals are not shaped as expected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onSwallowed = vi.fn();

    // No _core / _renderService at all.
    const unpatch = guardTerminalRenderRows({}, onSwallowed);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => unpatch()).not.toThrow();

    // _renderRows present but not a function.
    guardTerminalRenderRows({ _core: { _renderService: { _renderRows: 5 } } }, onSwallowed);
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
});

describe("shouldLogSwallow", () => {
  it("logs the FIRST swallow so the condition is visible once", () => {
    expect(shouldLogSwallow(1)).toBe(true);
  });

  it("suppresses the frames between heartbeats so it can't reproduce the 281x/day flood", () => {
    expect(shouldLogSwallow(2)).toBe(false);
    expect(shouldLogSwallow(50)).toBe(false);
    expect(shouldLogSwallow(SWALLOW_LOG_HEARTBEAT - 1)).toBe(false);
  });

  it("emits a heartbeat every SWALLOW_LOG_HEARTBEAT frames", () => {
    expect(shouldLogSwallow(SWALLOW_LOG_HEARTBEAT)).toBe(true);
    expect(shouldLogSwallow(SWALLOW_LOG_HEARTBEAT * 2)).toBe(true);
    expect(shouldLogSwallow(SWALLOW_LOG_HEARTBEAT + 1)).toBe(false);
  });
});
