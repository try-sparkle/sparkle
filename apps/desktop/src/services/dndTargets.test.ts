// @vitest-environment jsdom
//
// The window-global drag hit test. Tauri's onDragDropEvent carries a cursor position but no
// element, and with dragDropEnabled on there are no HTML5 drop events to lean on — so every drag
// listener in the app hit-tests these helpers itself. That makes them the one place where
// "who owns this drop?" is decided, and the reason FILE_DROP_TARGETS is shared rather than copied:
// Composer stands down over those surfaces, and a target added there has to reach every consumer
// at once (roborev 52362).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONCIERGE_COMPOSE_DND_TARGET,
  FILE_DROP_TARGETS,
  NEW_BUILD_AGENT_DND_TARGET,
  isOverDndTarget,
  isOverFileDropTarget,
} from "./dndTargets";

const realElementFromPoint = document.elementFromPoint;
let box: HTMLDivElement;
let button: HTMLDivElement;
let inner: HTMLSpanElement;

/** Physical pixels, the unit Tauri reports (the helpers divide by devicePixelRatio). */
const at = (x: number) => ({ x: x * (window.devicePixelRatio || 1), y: 0 });

beforeEach(() => {
  box = document.createElement("div");
  box.setAttribute("data-dnd-target", CONCIERGE_COMPOSE_DND_TARGET);
  // A nested child, because the cursor is virtually never over the marked root itself.
  inner = document.createElement("span");
  box.append(inner);
  button = document.createElement("div");
  button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
  document.body.append(box, button);
  document.elementFromPoint = vi.fn((x: number) =>
    x === 100 ? inner : x === 200 ? button : null,
  ) as unknown as typeof document.elementFromPoint;
});
afterEach(() => {
  document.elementFromPoint = realElementFromPoint;
  box.remove();
  button.remove();
  vi.restoreAllMocks();
});

describe("isOverDndTarget", () => {
  it("matches through a nested child (closest, not the element itself)", () => {
    expect(isOverDndTarget(at(100), CONCIERGE_COMPOSE_DND_TARGET)).toBe(true);
  });

  it("does not match a DIFFERENT target under the cursor", () => {
    expect(isOverDndTarget(at(100), NEW_BUILD_AGENT_DND_TARGET)).toBe(false);
  });

  it("is false over nothing at all (the terminal)", () => {
    expect(isOverDndTarget(at(999), CONCIERGE_COMPOSE_DND_TARGET)).toBe(false);
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
      CONCIERGE_COMPOSE_DND_TARGET,
    ]);
  });
});
