// @vitest-environment jsdom
//
// Regression guard for the renderer-after-dispose crash: a ResizeObserver tick (or a theme
// re-render / queued rAF) that fires AFTER the terminal is disposed must NOT call fit()/refresh()
// on the freed xterm core. xterm's RenderService then reads `this._renderer.value.dimensions` on a
// torn-down core → the uncaught "undefined is not an object (...dimensions)" TypeError seen in logs.
//
// The fix: a `disposedRef` sentinel flipped in cleanup, guarded safeFit/safeRefresh helpers that
// no-op once disposed, and nulled term/fit refs. This test drives a ResizeObserver callback after
// unmount and asserts the disposed terminal's fit()/refresh() are never invoked (and nothing throws,
// even though the mock renderer throws if touched post-dispose — modeling the real crash).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const { fit, refresh, disposed, ptyHandlers } = vi.hoisted(() => ({
  fit: vi.fn(),
  refresh: vi.fn(),
  disposed: { value: false },
  // The handlers Terminal registers with the PTY layer, captured so a test can fire one AFTER
  // unmount — which is exactly what the async, fire-and-forget unlisten allows in production.
  ptyHandlers: { exit: undefined as undefined | (() => void) },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      // xterm's WebglAddon appends its own webgl2 canvas here. Terminal locates it to release the
      // GPU context and to watch for webglcontextlost, and REFUSES to keep a renderer whose canvas
      // it cannot find (an unwatchable renderer goes solid black on context loss). A mock without
      // this canvas is not a WebGL-rendered terminal, so it cannot exercise the WebGL paths below.
      const glCanvas = document.createElement("canvas");
      Object.defineProperty(glCanvas, "getContext", {
        value: (id: string) =>
          id === "webgl2" ? { getExtension: () => ({ loseContext: () => {} }) } : null,
        configurable: true,
      });
      el.appendChild(glCanvas);
      parent.appendChild(el);
      this.element = el;
    }
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    // Record the call FIRST (so the test detects a post-dispose call even though it's caught), then
    // model the real crash: touching the renderer after dispose throws the dimensions TypeError.
    refresh(start: number, end: number): void {
      refresh(start, end);
      if (disposed.value) throw new Error("undefined is not an object (this._renderer.value.dimensions)");
    }
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {
      disposed.value = true;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {
      fit();
      if (disposed.value) throw new Error("undefined is not an object (this._renderer.value.dimensions)");
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {
  constructor(_handler: unknown) {}
} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

vi.mock("../pty", () => ({
  spawnPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
  onPtyOutput: vi.fn(() => Promise.resolve(() => {})),
  // NOTE the payload field is `id`, not `agentId`: agentTransport.onExit filters with
  // `e.id === this.id`, so a mock that emits the wrong key silently never invokes the handler and
  // any test built on it passes for the wrong reason (caught by mutation-checking this file).
  onPtyExit: vi.fn((cb: (e: { id: string }) => void) => {
    ptyHandlers.exit = () => cb({ id: "agent-1" });
    return Promise.resolve(() => {});
  }),
  ignorePtyGone: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../engine/statusEngine", () => ({
  StatusEngine: class {
    constructor(_opts: unknown) {}
    ingest(): void {}
    exit(): void {}
    dispose(): void {}
  },
}));
vi.mock("../theme/theme", () => ({ useResolvedTheme: () => "dark" }));

import { Terminal } from "./Terminal";

const baseProps = {
  agentId: "agent-1",
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  onStatus: () => {},
};

// Captured ResizeObserver callback so the test can fire a tick at will (incl. after unmount).
let roCallback: (() => void) | undefined;

beforeEach(() => {
  fit.mockClear();
  refresh.mockClear();
  disposed.value = false;
  roCallback = undefined;
  ptyHandlers.exit = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Terminal dispose guard", () => {
  it("a ResizeObserver tick after dispose is a no-op (no throw, never touches the freed renderer)", () => {
    const { unmount } = render(<Terminal {...baseProps} active={true} />);
    expect(roCallback).toBeTypeOf("function");

    unmount(); // cleanup flips disposedRef, disposes the terminal, nulls the refs
    expect(disposed.value).toBe(true);
    fit.mockClear();
    refresh.mockClear();

    // A ResizeObserver tick can still be queued past disconnect(); firing it must NOT reach the
    // disposed renderer. Pre-fit this threw (caught) but still CALLED fit/refresh; the guard now
    // bails first, so neither is called.
    expect(() => roCallback?.()).not.toThrow();
    expect(fit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a ResizeObserver tick while mounted still fits and refreshes", () => {
    render(<Terminal {...baseProps} active={true} />);
    fit.mockClear();
    refresh.mockClear();

    roCallback?.();

    // While mounted the observer must still drive a fit + repaint — the guard must not over-block.
    expect(fit).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("late PTY events after cleanup", () => {
  // roborev 55107. Cleanup flips `disposed` and then calls `void safeUnlisten(off)` — async and
  // fire-and-forget — so the handlers registered by the OLD effect survive the round trip to Rust
  // and can still fire. Silencing the status engine was not enough: the listener itself calls
  // `onExit?.()` and `setSpawnFail("exited")`, which on a "Start again" paints "Agent exited —
  // Start again" over the freshly spawned, HEALTHY agent. A user who acts on that kills a working
  // session, which is why the guard belongs at the source rather than in each consumer.
  it("a stale pty:exit does not report an exit for the live pane", async () => {
    const onExit = vi.fn();
    const { unmount } = render(<Terminal {...baseProps} active={true} onExit={onExit} />);
    // Let the async spawn/registration settle so the handler is captured.
    await vi.waitFor(() => expect(ptyHandlers.exit).toBeTypeOf("function"));

    unmount();
    onExit.mockClear();
    ptyHandlers.exit?.(); // the dead PTY's exit, arriving after the unlisten was requested
    expect(onExit).not.toHaveBeenCalled();
  });
});
