// @vitest-environment jsdom
//
// Wiring tests for the "+ New Build Agent" webview drop target: drag-over lights the shared
// buildAgentHover flag (the same visual as a mouse hover), a drop on the button spawns a build
// agent and queues the dropped paths for its composer, and drops anywhere else are left alone.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the webview drag handler so tests can fire synthetic drag events through it.
type DragEventPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths?: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };
const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  spawn: vi.fn<() => string | null>(() => "new-agent-1"),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handler = h;
      return Promise.resolve(() => {
        captured.handler = null;
      });
    },
  }),
}));
vi.mock("./useSpawnBuildAgent", () => ({ useSpawnBuildAgent: () => captured.spawn }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useNewBuildAgentDrop } from "./useNewBuildAgentDrop";
import { useUiStore } from "../stores/uiStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";

function Host() {
  useNewBuildAgentDrop(null); // the mocked spawn hook ignores the project
  return null;
}

// The hit test uses document.elementFromPoint (unimplemented in jsdom) — stub it to return the
// marked button element or the body depending on where the "cursor" is.
const button = document.createElement("button");
button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
let overButton = false;
const elementFromPoint = vi.fn(() => (overButton ? button : document.body));

const fire = (payload: DragEventPayload) => act(() => captured.handler!({ payload }));

beforeEach(() => {
  captured.spawn.mockClear();
  elementFromPoint.mockClear();
  overButton = false;
  document.elementFromPoint = elementFromPoint;
  useUiStore.getState().setBuildAgentHover(false);
  usePendingAttachmentsStore.setState({ pending: {} });
  render(<Host />);
});
afterEach(() => cleanup());

describe("useNewBuildAgentDrop", () => {
  it("lights buildAgentHover while dragging over the button, clears it elsewhere", () => {
    overButton = true;
    fire({ type: "over", position: { x: 10, y: 10 } });
    expect(useUiStore.getState().buildAgentHover).toBe(true);
    overButton = false;
    fire({ type: "over", position: { x: 500, y: 500 } });
    expect(useUiStore.getState().buildAgentHover).toBe(false);
  });

  it("clears the hover on leave", () => {
    overButton = true;
    fire({ type: "enter", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });
    expect(useUiStore.getState().buildAgentHover).toBe(true);
    fire({ type: "leave" });
    expect(useUiStore.getState().buildAgentHover).toBe(false);
  });

  it("converts physical drop coordinates to logical ones (devicePixelRatio)", () => {
    const prev = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    fire({ type: "over", position: { x: 100, y: 60 } });
    expect(elementFromPoint).toHaveBeenLastCalledWith(50, 30);
    Object.defineProperty(window, "devicePixelRatio", { value: prev, configurable: true });
  });

  it("drop on the button spawns a build agent and queues the paths for its composer", () => {
    overButton = true;
    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png", "/tmp/b.txt"] });
    expect(captured.spawn).toHaveBeenCalledTimes(1);
    expect(usePendingAttachmentsStore.getState().drain("new-agent-1")).toEqual([
      "/tmp/a.png",
      "/tmp/b.txt",
    ]);
    expect(useUiStore.getState().buildAgentHover).toBe(false);
  });

  it("drop anywhere else spawns nothing and queues nothing", () => {
    overButton = false;
    fire({ type: "drop", position: { x: 500, y: 500 }, paths: ["/tmp/a.png"] });
    expect(captured.spawn).not.toHaveBeenCalled();
    expect(usePendingAttachmentsStore.getState().pending).toEqual({});
  });

  it("an empty drop on the button spawns nothing", () => {
    overButton = true;
    fire({ type: "drop", position: { x: 10, y: 10 }, paths: [] });
    expect(captured.spawn).not.toHaveBeenCalled();
  });

  it("a spawn refusal (no project) queues nothing", () => {
    captured.spawn.mockReturnValueOnce(null);
    overButton = true;
    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });
    expect(usePendingAttachmentsStore.getState().pending).toEqual({});
  });
});
