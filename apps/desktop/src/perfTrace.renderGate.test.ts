// Bead sparkle-abv2: perfRender's per-render log line is a main-thread Tauri IPC
// (log.debug → logger.ts forward() → invoke("frontend_log")). A real 6.5h session wrote 145K of
// them, 73% for INVISIBLE panes, alongside 11,274 jank stalls totalling 5,077s.
//
// Coalescing alone does not fix that — measured on a replayed day it drops ~38% of lines at the
// shipped 1s window, and perfTrace's own note says the remainder "is breadth, not burst". These
// tests pin the other half: the log is OFF by default and costs nothing, while the COUNTING stays
// exact so `sparklePerf.counts()` still answers "which pane is thrashing?".
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { log } from "./logger";
import {
  __resetRenderTraceForTest,
  perfRender,
  perfRenderLoggingEnabled,
  renderCounts,
  setPerfRenderLogging,
} from "./perfTrace";

function renderLines(debug: ReturnType<typeof vi.spyOn>) {
  return debug.mock.calls.filter(
    ([, msg]) => typeof msg === "string" && msg.startsWith("render "),
  );
}

/** Hand-driven clock, mirroring perfTrace.render.test.ts. Needed because the gate sits IN FRONT of
 *  the 1s coalescing window: without advancing past it, a post-toggle render is suppressed by
 *  coalescing rather than by the gate, and the test would be measuring the wrong mechanism. */
function clock() {
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("perfRender logging gate (sparkle-abv2)", () => {
  let debug: ReturnType<typeof vi.spyOn>;

  let time: ReturnType<typeof clock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    time = clock();
    debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    __resetRenderTraceForTest();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes NOTHING by default — the flood is gone, not merely thinned", () => {
    expect(perfRenderLoggingEnabled()).toBe(false);
    // Including the very first render for a key: an ungated "mount always logs" is one IPC per
    // key, and a busy session keeps ~60 keys alive.
    for (let i = 0; i < 500; i++) perfRender("AgentPane", `agent-${i % 60}`, { visible: false });
    expect(renderLines(debug)).toHaveLength(0);
  });

  it("still COUNTS exactly while logging is off, so the signal survives the gate", () => {
    for (let i = 0; i < 150; i++) perfRender("Workspace", "w1");
    expect(renderLines(debug)).toHaveLength(0);
    // 150 renders counted with zero IPC — this is what makes logging-off tolerable rather than blind.
    expect(renderCounts()["Workspace:w1"]).toBe(150);
  });

  it("logs once turned on, and the count carries across the flip", () => {
    for (let i = 0; i < 10; i++) perfRender("AgentPane", "a1");
    expect(renderLines(debug)).toHaveLength(0);
    setPerfRenderLogging(true);
    // Past the coalescing window, so what we observe is the GATE opening rather than the 1s
    // window happening to suppress the next line.
    time.advance(1_500);
    perfRender("AgentPane", "a1");
    expect(renderLines(debug)).toHaveLength(1);
    // 10 silent + 1 logged: the counter never reset, so the logged line reports the true total.
    expect(renderCounts()["AgentPane:a1"]).toBe(11);
  });

  it("an explicit OFF sticks across a reload even when the build default is ON (roborev 40823)", () => {
    // The subtle bug: turning off via removeItem leaves NO localStorage value, so the next read
    // falls through to VITE_PERF_RENDER_LOG and silently turns logging back ON. The off-state must
    // be PERSISTED, and a present-but-falsy value must beat the env default.
    setPerfRenderLogging(false);
    expect(localStorage.getItem("sparkle.perf.renderLog")).toBe("0");

    vi.stubEnv("VITE_PERF_RENDER_LOG", "1"); // a build where the default is ON
    __resetRenderTraceForTest(); // re-reads the flag, i.e. simulates a webview reload

    expect(perfRenderLoggingEnabled()).toBe(false);
    perfRender("AgentPane", "a1");
    expect(renderLines(debug)).toHaveLength(0);
  });

  it("an ABSENT value does consult the env default", () => {
    // The flip side of the test above: only an explicit stored value overrides the build default,
    // otherwise VITE_PERF_RENDER_LOG=1 would be impossible to opt into.
    localStorage.clear();
    vi.stubEnv("VITE_PERF_RENDER_LOG", "1");
    __resetRenderTraceForTest();
    expect(perfRenderLoggingEnabled()).toBe(true);
  });

  it("survives localStorage throwing (private mode) instead of breaking the app it measures", () => {
    // Stub the localStorage GLOBAL rather than spying on Storage.prototype: the `Storage`
    // constructor is not defined in every Node the suite runs on (CI's node exposes the
    // localStorage global without it), so a prototype spy passes locally and dies in CI with
    // "Storage is not defined" — which is exactly what happened on the first push.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      clear: () => {},
    });

    expect(() => __resetRenderTraceForTest()).not.toThrow();
    expect(() => perfRender("AgentPane", "a1")).not.toThrow();
    // The toggle must also survive a write failure — flipping in memory is still better than
    // throwing out of a debug affordance.
    expect(() => setPerfRenderLogging(true)).not.toThrow();
    expect(perfRenderLoggingEnabled()).toBe(true);
  });
});
