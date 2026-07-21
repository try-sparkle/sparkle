import { describe, expect, it } from "vitest";
import { classifyJankGap } from "./perfTrace";

const THRESHOLD = 150;

describe("classifyJankGap", () => {
  it("ignores gaps under the threshold", () => {
    expect(classifyJankGap(16, THRESHOLD, false)).toBe("ignore");
    expect(classifyJankGap(THRESHOLD - 1, THRESHOLD, false)).toBe("ignore");
  });

  it("reports a real main-thread freeze as a stall", () => {
    expect(classifyJankGap(THRESHOLD, THRESHOLD, false)).toBe("stall");
    expect(classifyJankGap(3326, THRESHOLD, false)).toBe("stall");
  });

  it("classifies a machine-sleep-sized gap as a resume, not a stall", () => {
    expect(classifyJankGap(30_000, THRESHOLD, false)).toBe("resume");
    expect(classifyJankGap(600_000, THRESHOLD, false)).toBe("resume");
  });

  // The 10–30s band is where the everyday machine pauses land (App Nap, display sleep, occlusion).
  // It used to be warned about as a freeze; a gap this long is a wake, and 3326ms above still has
  // to stay a stall so lowering the bar doesn't start swallowing genuine multi-second freezes.
  it("treats the 10-30s band as a resume rather than a multi-second freeze", () => {
    expect(classifyJankGap(10_000, THRESHOLD, false)).toBe("resume");
    expect(classifyJankGap(26_245, THRESHOLD, false)).toBe("resume");
    expect(classifyJankGap(9_999, THRESHOLD, false)).toBe("stall");
  });

  // The regression this function exists for: rAF is paused while the window is hidden, so the gap
  // covering a backgrounded interval is only ever observed by a tick running after the window is
  // visible again. Keying off the latched hidden state (rather than document.hidden sampled at tick
  // time, which by then always reads "visible") is what keeps it out of the log.
  it("drops a multi-second gap accrued while the window was hidden", () => {
    expect(classifyJankGap(2952, THRESHOLD, true)).toBe("ignore");
  });

  it("drops a hidden gap even at suspend size, rather than calling it a resume", () => {
    expect(classifyJankGap(45_000, THRESHOLD, true)).toBe("ignore");
  });

  it("still reports a stall on the tick after the hidden flag is consumed", () => {
    expect(classifyJankGap(400, THRESHOLD, true)).toBe("ignore");
    expect(classifyJankGap(400, THRESHOLD, false)).toBe("stall");
  });
});
