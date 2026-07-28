// @vitest-environment jsdom
//
// A severe jank stall says WHAT froze (`ms`) but, until now, only said WHY when an interaction was
// in flight. In a real session most severe stalls carry no `during` at all — they come from a
// background poll or a periodic timer — so a once-a-minute second-long freeze reported nothing to
// chase. `rendered` diffs the render counters across the frozen frame and names the busiest
// components, which is attribution the WKWebView Long Tasks API cannot supply.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pending: FrameRequestCallback | null = null;
let nowMs = 0;

const warn = vi.fn();

vi.mock("./logger", () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: (...a: unknown[]) => warn(...a) },
}));

/** Advance the clock by `ms` and run one rAF tick, as the browser would after a gap of that size. */
function tick(ms: number) {
  nowMs += ms;
  const cb = pending;
  pending = null;
  cb?.(nowMs);
}

describe("renderBurst", () => {
  it("names the busiest components, largest delta first", async () => {
    const { renderBurst } = await import("./perfTrace");
    const before = new Map([["AgentPane", 10], ["Sidebar", 5]]);
    const after = new Map([["AgentPane", 52], ["Sidebar", 12]]);
    expect(renderBurst(before, after)).toBe("AgentPane×42, Sidebar×7");
  });

  it("counts a component that mounted inside the window at its full total", async () => {
    const { renderBurst } = await import("./perfTrace");
    expect(renderBurst(new Map(), new Map([["Toast", 3]]))).toBe("Toast×3");
  });

  it("drops a single render's multiplier so the line reads as a name", async () => {
    const { renderBurst } = await import("./perfTrace");
    expect(renderBurst(new Map([["Sidebar", 1]]), new Map([["Sidebar", 2]]))).toBe("Sidebar");
  });

  it("is undefined when nothing rendered — the field is then omitted entirely", async () => {
    const { renderBurst } = await import("./perfTrace");
    const same = new Map([["AgentPane", 10]]);
    expect(renderBurst(same, new Map(same))).toBeUndefined();
  });

  it("caps the list, so a hundred-component session cannot flood one log line", async () => {
    const { renderBurst } = await import("./perfTrace");
    const after = new Map([["A", 4], ["B", 3], ["C", 2], ["D", 1]]);
    expect(renderBurst(new Map(), after)).toBe("A×4, B×3, C×2");
  });

  // Map iteration order is insertion order, which is whichever component happened to mount first —
  // not something a human reading two log lines side by side should have to reason about.
  it("breaks ties by name so the line is stable across runs", async () => {
    const { renderBurst } = await import("./perfTrace");
    expect(renderBurst(new Map(), new Map([["Zed", 2], ["Ace", 2]]))).toBe("Ace×2, Zed×2");
  });
});

describe("renderTotalsByComponent", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  // The per-key half of a render id is an agent id or a path. Collapsing here rather than at the
  // call site is what makes `rendered` safe to write to the shared log at all.
  it("collapses the per-key tail, summing the keys of one component", async () => {
    const { perfRender, renderTotalsByComponent, __resetRenderTraceForTest } = await import(
      "./perfTrace"
    );
    __resetRenderTraceForTest();
    perfRender("AgentPane", "agent-secret-id");
    perfRender("AgentPane", "agent-secret-id");
    perfRender("AgentPane", "another-secret-id");
    perfRender("Sidebar", "root");
    const totals = renderTotalsByComponent();
    expect(totals.get("AgentPane")).toBe(3);
    expect(totals.get("Sidebar")).toBe(1);
    expect([...totals.keys()].join()).not.toContain("secret");
  });
});

describe("startJankMonitor render attribution", () => {
  beforeEach(async () => {
    vi.resetModules();
    warn.mockClear();
    pending = null;
    nowMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names what rendered during a severe stall that no interaction explains", async () => {
    const { startJankMonitor, perfRender, __resetRenderTraceForTest, __resetTracesForTest } =
      await import("./perfTrace");
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16); // one healthy frame establishes the baseline
    for (let i = 0; i < 40; i++) perfRender("AgentPane", "a");
    perfRender("Sidebar", "root");
    tick(1200);
    expect(warn).toHaveBeenCalledWith(
      "perf",
      "jank stall",
      expect.objectContaining({ ms: 1200, rendered: "AgentPane×40, Sidebar" }),
    );
    // No interaction was in flight — the case that used to report nothing actionable.
    expect(warn.mock.calls[0]?.[2]).not.toHaveProperty("during");
  });

  // Without a re-baseline on the reporting tick, the second stall would re-report the first one's
  // renders and read as twice the thrash.
  it("does not re-report the previous stall's renders on the next one", async () => {
    const { startJankMonitor, perfRender, __resetRenderTraceForTest, __resetTracesForTest } =
      await import("./perfTrace");
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    for (let i = 0; i < 40; i++) perfRender("AgentPane", "a");
    tick(1200);
    for (let i = 0; i < 3; i++) perfRender("AgentPane", "a");
    tick(1100);
    expect(warn).toHaveBeenLastCalledWith(
      "perf",
      "jank stall",
      expect.objectContaining({ ms: 1100, rendered: "AgentPane×3" }),
    );
  });

  it("omits the field when the freeze was not React work", async () => {
    const { startJankMonitor, __resetRenderTraceForTest, __resetTracesForTest } = await import(
      "./perfTrace"
    );
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    tick(1200);
    expect(warn).toHaveBeenCalledWith("perf", "jank stall", expect.objectContaining({ ms: 1200 }));
    expect(warn.mock.calls[0]?.[2]).not.toHaveProperty("rendered");
  });
});
