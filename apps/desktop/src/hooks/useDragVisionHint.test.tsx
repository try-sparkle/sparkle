// @vitest-environment jsdom
//
// Covers the drag-vision hint listener (spec 2026-07-02, Unit A):
//  - the image-path filter (dragPayloadHasImage)
//  - the listener is gated to `enabled` ONLY (off → never subscribes; on → subscribes)
//  - an image drag reveals the pill; a non-image drag does not; dismiss hides it
// Boundary mock mirrors Composer.dropTarget.test.tsx (capture the onDragDropEvent handler).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  listenCalls: 0,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handler = h;
      captured.listenCalls += 1;
      return Promise.resolve(() => {
        captured.handler = null;
      });
    },
  }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dragPayloadHasImage, useDragVisionHint } from "./useDragVisionHint";
import {
  CONCIERGE_COMPOSE_DND_TARGET,
  NEW_BUILD_AGENT_DND_TARGET,
} from "../services/dndTargets";

const fire = (payload: unknown) => act(() => captured.handler!({ payload }));

// The hit test uses document.elementFromPoint, which jsdom does not implement. Two real targets
// live at x=100 (the compose box) and x=200 (the new-build-agent button); everything else — the
// terminal — is nothing. Built and torn down per test, and the stub is restored rather than left
// on the shared document for whatever runs next (roborev 49293/49294).
let boxEl: HTMLDivElement;
let buttonEl: HTMLDivElement;
const realElementFromPoint = document.elementFromPoint;

/** A drag position in PHYSICAL pixels (isOverDndTarget divides by devicePixelRatio). */
const at = (x: number) => ({ x: x * (window.devicePixelRatio || 1), y: 0 });
/** Over the terminal: a real Tauri enter/drop ALWAYS carries a position, so every case here does. */
const OVER_TERMINAL = at(999);

beforeEach(() => {
  captured.handler = null;
  captured.listenCalls = 0;
  boxEl = document.createElement("div");
  boxEl.setAttribute("data-dnd-target", CONCIERGE_COMPOSE_DND_TARGET);
  buttonEl = document.createElement("div");
  buttonEl.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
  document.body.append(boxEl, buttonEl);
  document.elementFromPoint = vi.fn((x: number) =>
    x === 100 ? boxEl : x === 200 ? buttonEl : null,
  ) as unknown as typeof document.elementFromPoint;
});
afterEach(() => {
  vi.clearAllMocks();
  document.elementFromPoint = realElementFromPoint;
  boxEl.remove();
  buttonEl.remove();
});

describe("dragPayloadHasImage", () => {
  it("is true when any path is an image", () => {
    expect(dragPayloadHasImage({ paths: ["/tmp/a.png"] })).toBe(true);
    expect(dragPayloadHasImage({ paths: ["/tmp/notes.txt", "/tmp/b.JPG"] })).toBe(true);
  });
  it("is false for non-image or empty payloads", () => {
    expect(dragPayloadHasImage({ paths: ["/tmp/notes.txt"] })).toBe(false);
    expect(dragPayloadHasImage({ paths: [] })).toBe(false);
    expect(dragPayloadHasImage({})).toBe(false);
  });
});

describe("useDragVisionHint", () => {
  it("does NOT subscribe when disabled (composer on)", () => {
    const { result } = renderHook(() => useDragVisionHint(false));
    expect(captured.listenCalls).toBe(0);
    expect(captured.handler).toBeNull();
    expect(result.current.show).toBe(false);
  });

  it("subscribes when enabled and shows the pill on an image drag", () => {
    const { result } = renderHook(() => useDragVisionHint(true));
    expect(captured.listenCalls).toBe(1);
    fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
    expect(result.current.show).toBe(true);
  });

  it("ignores a non-image drag", () => {
    const { result } = renderHook(() => useDragVisionHint(true));
    fire({ type: "enter", paths: ["/tmp/notes.txt"], position: OVER_TERMINAL });
    expect(result.current.show).toBe(false);
    fire({ type: "drop", paths: ["/tmp/notes.txt"], position: OVER_TERMINAL });
    expect(result.current.show).toBe(false);
  });

  it("shows on drop too, and dismiss() hides it", () => {
    const { result } = renderHook(() => useDragVisionHint(true));
    fire({ type: "drop", paths: ["/tmp/pic.gif"], position: OVER_TERMINAL });
    expect(result.current.show).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.show).toBe(false);
  });

  // roborev 46911: the pill's copy is an INSTRUCTION ("Drop it on the Sparkle box instead"). With
  // no hit-test it fired on any image drag anywhere in the window, so obeying it re-armed the pill
  // over the terminal — telling the user to do the thing they had just done — for the full 8s.
  describe("hit-testing (the pill is about the TERMINAL, not the whole window)", () => {
    it("stays quiet while the drag is over the concierge compose box", () => {
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: at(100) });
      expect(result.current.show).toBe(false);
    });

    it("stays quiet over the new-build-agent target too", () => {
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: at(200) });
      expect(result.current.show).toBe(false);
    });

    it("still fires over the terminal (no target under the cursor)", () => {
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
      expect(result.current.show).toBe(true);
    });

    it("moving the drag ONTO the box clears a pill the terminal had already raised", () => {
      // The REAL sequence the OS sends when the user follows the pill's advice: ONE `enter` (with
      // paths) as the drag crosses into the webview, then position-only `over` events as it moves.
      // Waiting for the drop means the pill spends the whole approach arguing with a user who has
      // already agreed — and hit-testing only `enter`/`drop` never sees the approach at all
      // (roborev 52362/52363).
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
      expect(result.current.show).toBe(true);
      fire({ type: "over", position: at(100) }); // no paths — Tauri never sends them on `over`
      expect(result.current.show).toBe(false);
    });

    it("an `over` back on the terminal does NOT re-raise a pill that was cleared", () => {
      // Wandering off the box is not a new request for the hint; re-raising would flicker it at a
      // user who already acted on it.
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
      fire({ type: "over", position: at(100) });
      expect(result.current.show).toBe(false);
      fire({ type: "over", position: OVER_TERMINAL });
      expect(result.current.show).toBe(false);
    });

    it("an `over` from a NON-image drag is ignored entirely", () => {
      // The latch is what makes position-only events meaningful; a text-file drag must not clear
      // (or raise) anything.
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/notes.txt"], position: OVER_TERMINAL });
      expect(result.current.show).toBe(false);
      fire({ type: "over", position: at(100) });
      expect(result.current.show).toBe(false);
    });

    it("the image latch is dropped when the drag LEAVES the window", () => {
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
      fire({ type: "leave" });
      // A stale latch would let the NEXT drag — a text file, say — clear or raise the pill on a
      // position-only event.
      fire({ type: "over", position: at(100) });
      expect(result.current.show).toBe(true); // untouched by the post-leave `over`
    });

    it("a drop that LANDS on the box clears a pill the drag had already raised", () => {
      // The real sequence when the user follows the advice: enter over the terminal (pill shows),
      // then drop on the box. The drop worked, so the pill must go — not linger for 8s.
      const { result } = renderHook(() => useDragVisionHint(true));
      fire({ type: "enter", paths: ["/tmp/shot.png"], position: OVER_TERMINAL });
      expect(result.current.show).toBe(true);
      fire({ type: "drop", paths: ["/tmp/shot.png"], position: at(100) });
      expect(result.current.show).toBe(false);
    });
  });

  it("tears down and hides when it flips to disabled", () => {
    const { result, rerender } = renderHook(({ on }) => useDragVisionHint(on), {
      initialProps: { on: true },
    });
    fire({ type: "enter", paths: ["/tmp/pic.webp"], position: OVER_TERMINAL });
    expect(result.current.show).toBe(true);
    rerender({ on: false });
    expect(result.current.show).toBe(false);
  });
});
