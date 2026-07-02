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

const fire = (payload: unknown) => act(() => captured.handler!({ payload }));

beforeEach(() => {
  captured.handler = null;
  captured.listenCalls = 0;
});
afterEach(() => vi.clearAllMocks());

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
    fire({ type: "enter", paths: ["/tmp/shot.png"] });
    expect(result.current.show).toBe(true);
  });

  it("ignores a non-image drag", () => {
    const { result } = renderHook(() => useDragVisionHint(true));
    fire({ type: "enter", paths: ["/tmp/notes.txt"] });
    expect(result.current.show).toBe(false);
    fire({ type: "drop", paths: ["/tmp/notes.txt"] });
    expect(result.current.show).toBe(false);
  });

  it("shows on drop too, and dismiss() hides it", () => {
    const { result } = renderHook(() => useDragVisionHint(true));
    fire({ type: "drop", paths: ["/tmp/pic.gif"] });
    expect(result.current.show).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.show).toBe(false);
  });

  it("tears down and hides when it flips to disabled", () => {
    const { result, rerender } = renderHook(({ on }) => useDragVisionHint(on), {
      initialProps: { on: true },
    });
    fire({ type: "enter", paths: ["/tmp/pic.webp"] });
    expect(result.current.show).toBe(true);
    rerender({ on: false });
    expect(result.current.show).toBe(false);
  });
});
