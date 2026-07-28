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
} from "./dndTargets";

const realElementFromPoint = document.elementFromPoint;
const realDpr = window.devicePixelRatio;
const realUa = navigator.userAgent;
let box: HTMLDivElement;
let button: HTMLDivElement;
let inner: HTMLSpanElement;

/** Pretend to be one of the three webviews Sparkle can run in. */
function asPlatform(ua: string, devicePixelRatio: number) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window, "devicePixelRatio", { value: devicePixelRatio, configurable: true });
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
  box.remove();
  button.remove();
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
