// @vitest-environment jsdom
//
// The window-global drag hit test. Tauri's onDragDropEvent carries a cursor position but no
// element, and with dragDropEnabled on there are no HTML5 drop events to lean on — so every drag
// listener in the app hit-tests these helpers itself. That makes them the one place where
// "who owns this drop?" is decided, and the reason FILE_DROP_TARGETS is shared rather than copied:
// Composer stands down over those surfaces, and a target added there has to reach every consumer
// at once (roborev 52362).
//
// It is also where drag-and-drop was BROKEN for every target at once: the helper divided the
// reported position by devicePixelRatio on every platform, but only Windows reports physical
// pixels (see dragPositionScale). The `describe("dragPositionScale")` and
// "a Retina macOS drop" cases below are the regression coverage for that — they are written
// against a COORDINATE-SENSITIVE elementFromPoint, because a stub that ignores its arguments
// (which is what the hook-level suites use) cannot see a coordinate bug at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONCIERGE_COLUMN_DND_TARGET,
  FILE_DROP_TARGETS,
  NEW_BUILD_AGENT_DND_TARGET,
  dragPositionScale,
  isOverDndTarget,
  isOverFileDropTarget,
  OUT_OF_VIEWPORT_SLACK_PX,
  registerCatchAllDropTarget,
  reportDropWithNoTarget,
} from "./dndTargets";
import { log } from "../logger";

vi.mock("../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const realElementFromPoint = document.elementFromPoint;
const realDpr = window.devicePixelRatio;
const realUa = navigator.userAgent;
const realInnerWidth = window.innerWidth;
const realInnerHeight = window.innerHeight;
let box: HTMLDivElement;
let button: HTMLDivElement;
let inner: HTMLSpanElement;

/** Pretend to be one of the three webviews Sparkle can run in. */
function asPlatform(ua: string, devicePixelRatio: number) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: devicePixelRatio, configurable: true });
}
/** Narrow the window, so a position can be OUTSIDE it. jsdom's default is 1024x768. */
function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

/** A position in the unit Tauri reports it in — i.e. already CSS pixels everywhere but Windows. */
const at = (x: number) => ({ x: x * dragPositionScale(), y: 0 });

beforeEach(() => {
  box = document.createElement("div");
  box.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
  // A nested child, because the cursor is virtually never over the marked root itself.
  inner = document.createElement("span");
  box.append(inner);
  button = document.createElement("div");
  button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
  document.body.append(box, button);
  // Coordinate-SENSITIVE, in CSS pixels: this stub is the thing that would catch a scaling bug.
  document.elementFromPoint = vi.fn((x: number) =>
    x === 100 ? inner : x === 200 ? button : null,
  ) as unknown as typeof document.elementFromPoint;
});
afterEach(() => {
  document.elementFromPoint = realElementFromPoint;
  Object.defineProperty(navigator, "userAgent", { value: realUa, configurable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: realDpr, configurable: true });
  setViewport(realInnerWidth, realInnerHeight);
  box.remove();
  button.remove();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
  vi.mocked(log.info).mockClear();
  vi.restoreAllMocks();
});

// Tauri types the drag position as PhysicalPosition on all three platforms but only fills one that
// way on Windows; macOS and Linux hand back logical points that are already CSS pixels. Dividing
// them again is what silently moved every hit test into the top-left quadrant of the window.
describe("dragPositionScale", () => {
  it("is 1 on macOS even at 2x — wry reports AppKit POINTS, not device pixels", () => {
    asPlatform(MAC_UA, 2);
    expect(dragPositionScale()).toBe(1);
  });

  it("is 1 on Linux/GTK at any ratio — raw widget coordinates are logical too", () => {
    asPlatform(LINUX_UA, 2);
    expect(dragPositionScale()).toBe(1);
  });

  it("is devicePixelRatio on Windows — ScreenToClient really does return device pixels", () => {
    asPlatform(WINDOWS_UA, 1.5);
    expect(dragPositionScale()).toBe(1.5);
  });

  it("never returns 0 when the webview reports no ratio at all", () => {
    // A 0 divisor would send every coordinate to Infinity and quietly kill the hit test.
    asPlatform(WINDOWS_UA, 0);
    expect(dragPositionScale()).toBe(1);
  });

  // THE SELF-CORRECTING RULE (roborev 53785/53788). The UA rule above encodes a wry/tauri quirk,
  // not a contract; an upstream release that starts multiplying macOS positions by the backing
  // scale factor would re-break every target silently. A position OUTSIDE the viewport cannot be
  // CSS pixels — the cursor was inside the window or there would be no drag event — so it is
  // physical no matter what the UA says.
  it("divides an OUT-OF-VIEWPORT position even on macOS, whatever the UA says", () => {
    asPlatform(MAC_UA, 2);
    setViewport(1000, 800);
    expect(dragPositionScale({ x: 1800, y: 400 })).toBe(2);
    // The y axis is checked independently — a wide, short window trips on y first.
    expect(dragPositionScale({ x: 400, y: 1200 })).toBe(2);
  });

  it("leaves an IN-viewport position to the UA rule, where the two readings are ambiguous", () => {
    asPlatform(MAC_UA, 2);
    setViewport(1000, 800);
    // Physical 400 at dpr 2 and logical 400 are both plausible points inside a 1000px window;
    // nothing in the number can tell them apart, so the platform rule still decides.
    expect(dragPositionScale({ x: 400, y: 400 })).toBe(1);
  });

  it("does not treat an UNLAID-OUT window (0x0) as putting every position out of bounds", () => {
    // Without the guard this reintroduces the unconditional division that broke every drop target.
    asPlatform(MAC_UA, 2);
    setViewport(0, 0);
    expect(dragPositionScale({ x: 100, y: 100 })).toBe(1);
  });

  // THE BOUNDARY (roborev 53893). A bare `x > innerWidth` has no slack, and a LOGICAL coordinate
  // sitting a hair past the edge — a sub-pixel position at the border, a webview frame that differs
  // from innerWidth by a scrollbar, a resize mid-drag — would be divided and land in the upper-left
  // quadrant. That is the very misroute this rule exists to prevent, and reportDropWithNoTarget
  // often would NOT catch it: a halved coordinate frequently lands on some known target.
  describe("the out-of-viewport correction only fires on an UNAMBIGUOUS overshoot", () => {
    beforeEach(() => {
      asPlatform(MAC_UA, 2);
      setViewport(1000, 800);
    });

    it("leaves a position exactly AT the edge alone", () => {
      expect(dragPositionScale({ x: 1000, y: 0 })).toBe(1);
      expect(dragPositionScale({ x: 0, y: 800 })).toBe(1);
    });

    it("leaves a position a hair past the edge alone", () => {
      expect(dragPositionScale({ x: 1001, y: 0 })).toBe(1);
      expect(dragPositionScale({ x: 1000 + OUT_OF_VIEWPORT_SLACK_PX, y: 0 })).toBe(1);
    });

    it("corrects once the overshoot clears the slack", () => {
      expect(dragPositionScale({ x: 1000 + OUT_OF_VIEWPORT_SLACK_PX + 1, y: 0 })).toBe(2);
    });

    it("declines to correct when DIVIDING would not land inside the viewport either", () => {
      // 2500/2 = 1250, well past a 1000px window even with the slack. Neither reading is plausible,
      // so rewriting the coordinate is guesswork — fall back to the platform rule.
      expect(dragPositionScale({ x: 2500, y: 0 })).toBe(1);
      // …and the same on the y axis: 1700/2 = 850, past an 800px window plus its slack.
      expect(dragPositionScale({ x: 0, y: 1700 })).toBe(1);
    });

    it("corrects a genuine physical point in the EDGE band, where the two tolerances must agree", () => {
      // The inconsistency this pins (roborev 53914): the trigger allows slack because the reported
      // space can differ from the viewport by chrome or a scrollbar — so the plausibility check has
      // to allow the same, or a real physical point at the bottom-right divides to w+ε, fails an
      // exact check, and is left unconverted. 1990/2 = 995 and 1590/2 = 795 are inside here, but
      // the same reasoning holds a few px further out, which is what the shared slack buys.
      expect(dragPositionScale({ x: 1990, y: 1590 })).toBe(2);
      // Just past the viewport once divided, but inside the slack — still corrected.
      expect(dragPositionScale({ x: 2020, y: 0 })).toBe(2);
    });
  });
});

describe("isOverDndTarget", () => {
  it("matches through a nested child (closest, not the element itself)", () => {
    expect(isOverDndTarget(at(100), CONCIERGE_COLUMN_DND_TARGET)).toBe(true);
  });

  it("does not match a DIFFERENT target under the cursor", () => {
    expect(isOverDndTarget(at(100), NEW_BUILD_AGENT_DND_TARGET)).toBe(false);
  });

  it("is false over nothing at all (the terminal)", () => {
    expect(isOverDndTarget(at(999), CONCIERGE_COLUMN_DND_TARGET)).toBe(false);
  });

  // THE REGRESSION. On a Retina Mac the cursor is over the target at CSS x=100 and Tauri reports
  // exactly 100 — halving it to 50 hit empty space, which is why no drop target in the app worked.
  it("hits the target on a 2x Retina Mac, where the old /devicePixelRatio halved the position", () => {
    asPlatform(MAC_UA, 2);
    expect(isOverDndTarget({ x: 100, y: 0 }, CONCIERGE_COLUMN_DND_TARGET)).toBe(true);
    // And the halved coordinate the old code used lands nowhere, so this really is the difference.
    expect(isOverDndTarget({ x: 50, y: 0 }, CONCIERGE_COLUMN_DND_TARGET)).toBe(false);
  });

  it("still converts on a 2x Windows webview, where the position IS physical", () => {
    asPlatform(WINDOWS_UA, 2);
    expect(isOverDndTarget({ x: 200, y: 0 }, CONCIERGE_COLUMN_DND_TARGET)).toBe(true);
    expect(isOverDndTarget({ x: 100, y: 0 }, CONCIERGE_COLUMN_DND_TARGET)).toBe(false);
  });

  // The forward-compatibility case: pretend a future wry/tauri-runtime-wry DOES hand macOS a real
  // PhysicalPosition. The UA rule alone would divide by nothing and miss; the viewport check
  // notices the position cannot be CSS pixels and recovers the right hit test.
  it("still hits the target if macOS ever starts reporting genuinely physical positions", () => {
    asPlatform(MAC_UA, 2);
    setViewport(1000, 800);
    // The target sits at CSS x=900; a physical report of that point is x=1800, past the window.
    document.elementFromPoint = vi.fn((x: number) =>
      x === 900 ? inner : null,
    ) as unknown as typeof document.elementFromPoint;
    expect(isOverDndTarget({ x: 1800, y: 0 }, CONCIERGE_COLUMN_DND_TARGET)).toBe(true);
  });
});

// Every drop branch early-returns on a hit-test miss, and that silence is why the devicePixelRatio
// bug survived to a user report: "drops do nothing", empty log. One shared reporter, called from
// each miss path, so a dead drop leaves exactly one diagnosable line (roborev 53788).
describe("reportDropWithNoTarget", () => {
  it("logs the position, the scale and the viewport when a drop matched nothing", () => {
    asPlatform(MAC_UA, 2);
    reportDropWithNoTarget({ x: 999, y: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const detail = vi.mocked(log.warn).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(detail).toMatchObject({
      position: { x: 999, y: 0 },
      scale: 1,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: 2,
    });
    // The point actually hit-tested, which is the number that was wrong in the original bug.
    expect(detail.hitTest).toEqual({ x: 999, y: 0 });
  });

  it("stays SILENT when another target owns the drop — a carve-out is not a failure", () => {
    // Every window-global listener calls this on its miss path, and on any given drop all but one
    // of them miss by design. Logging those would bury the real signal in noise.
    reportDropWithNoTarget(at(100));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("emits ONE line when several listeners report the same dead drop", () => {
    reportDropWithNoTarget({ x: 997, y: 0 });
    reportDropWithNoTarget({ x: 997, y: 0 });
    reportDropWithNoTarget({ x: 997, y: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("still reports a dead drop at a DIFFERENT position", () => {
    reportDropWithNoTarget({ x: 996, y: 0 });
    reportDropWithNoTarget({ x: 995, y: 0 });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  // A CATCH-ALL MAKES EVERY DROP LIVE (roborev 53893). The Sparkle pane's Composer accepts any drop
  // outside FILE_DROP_TARGETS — sidebar, tab strip, top bar — and no `data-dnd-target` region
  // describes that, so the other listeners' miss paths were warning "dead drop" about drops the
  // composer was successfully attaching. A false alarm on the SUCCESS path is worse than no alarm:
  // it makes a genuinely dead drop indistinguishable from routine noise.
  it("DOWNGRADES rather than silences while a catch-all listener is registered", () => {
    // Not suppressed outright: that would turn the alarm off for the whole time the Sparkle pane is
    // visible, and under a coordinate regression every hit test breaks together — the concierge
    // misses its own column while the composer swallows the file, with zero log output. The
    // diagnostic payload survives at INFO — debug does not forward to the persistent log in a
    // shipped build, so it would be no record at all (53914, 53929).
    const release = registerCatchAllDropTarget();
    try {
      reportDropWithNoTarget({ x: 994, y: 0 });
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledTimes(1);
      const detail = vi.mocked(log.info).mock.calls[0]?.[2] as Record<string, unknown>;
      expect(detail).toMatchObject({ position: { x: 994, y: 0 } });
      // The same fields a dead-drop warn carries, so a support capture loses nothing.
      expect(detail).toHaveProperty("scale");
      expect(detail).toHaveProperty("hitTest");
      expect(detail).toHaveProperty("innerWidth");
      expect(detail).toHaveProperty("devicePixelRatio");
    } finally {
      release();
    }
  });

  it("reports again once the catch-all goes away", () => {
    registerCatchAllDropTarget()();
    reportDropWithNoTarget({ x: 993, y: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("counts catch-alls, so overlapping mount/unmount can't un-suppress early", () => {
    // Effects double-invoke under StrictMode, so a boolean would be cleared by the first teardown
    // while a live listener remained.
    const first = registerCatchAllDropTarget();
    const second = registerCatchAllDropTarget();
    first();
    reportDropWithNoTarget({ x: 992, y: 0 });
    expect(log.warn).not.toHaveBeenCalled();
    second();
    reportDropWithNoTarget({ x: 991, y: 0 });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("survives a release fn being called twice", () => {
    const release = registerCatchAllDropTarget();
    release();
    release(); // idempotent — a double teardown must not drive the count negative
    const other = registerCatchAllDropTarget();
    try {
      reportDropWithNoTarget({ x: 990, y: 0 });
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      other();
    }
  });
});

describe("isOverFileDropTarget", () => {
  it("is true over EITHER surface that owns its drops", () => {
    expect(isOverFileDropTarget(at(100))).toBe(true);
    expect(isOverFileDropTarget(at(200))).toBe(true);
  });

  it("is false over anything else", () => {
    expect(isOverFileDropTarget(at(999))).toBe(false);
  });

  it("is false with NO position rather than throwing", () => {
    // `over` events are position-only and `leave` carries nothing; a listener passing undefined
    // must get a plain "not over a target", not an exception inside a drag handler.
    expect(isOverFileDropTarget(undefined)).toBe(false);
  });

  it("covers exactly the two targets, so a new one can't be half-added", () => {
    expect([...FILE_DROP_TARGETS]).toEqual([
      NEW_BUILD_AGENT_DND_TARGET,
      CONCIERGE_COLUMN_DND_TARGET,
    ]);
  });
});
