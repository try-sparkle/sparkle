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

const { fit, refresh, disposed } = vi.hoisted(() => ({
  fit: vi.fn(),
  refresh: vi.fn(),
  disposed: { value: false },
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
  onPtyExit: vi.fn(() => Promise.resolve(() => {})),
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
