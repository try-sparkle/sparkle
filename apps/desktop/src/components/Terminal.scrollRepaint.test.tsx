// @vitest-environment jsdom
//
// Regression guards for two WebGL-renderer staleness bugs that show as garbled terminal text:
//   1. DROPPED GLYPHS — the terminal opens and writes output before the async webfont (Source Code
//      Pro, display=swap) finishes loading; the WebGL atlas caches those glyphs with the fallback
//      font and never rebuilds on font swap. Fix: forceFullRepaint (clearTextureAtlas) once
//      document.fonts.ready resolves.
//   2. SCROLL REMNANTS — scrolling the scrollback (scrollLines/scrollToLine) leaves stale glyph
//      fragments because the WebGL model cache + atlas aren't invalidated. Fix: a debounced
//      forceFullRepaint after a scroll settles.
//
// Both assert the WIRING (clearTextureAtlas is reached) — a regression to a bare refresh(), or
// dropping the trigger entirely, fails here. forceFullRepaint itself is unit-tested in
// terminalWebgl.test.ts; the renderer/addons/PTY are mocked to thin fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Shared spies + the captured custom-wheel handler (hoisted so vi.mock can close over them).
const { clearTextureAtlas, refresh, scrollLines, wheelRef } = vi.hoisted(() => ({
  clearTextureAtlas: vi.fn(),
  refresh: vi.fn(),
  scrollLines: vi.fn(),
  wheelRef: { handler: null as null | ((e: { deltaY: number; deltaMode: number }) => boolean) },
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
    attachCustomWheelEventHandler(h: (e: { deltaY: number; deltaMode: number }) => boolean): void {
      wheelRef.handler = h;
    }
    registerMarker(): null {
      return null;
    }
    refresh = refresh;
    scrollLines = scrollLines;
    focus(): void {}
    scrollToLine(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { constructor(_h: unknown) {} } }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas = clearTextureAtlas;
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
    constructor(_o: unknown) {}
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
  active: true,
  onStatus: () => {},
};

// document.fonts isn't in jsdom — install a controllable stub so the font-ready repaint can fire.
let fontsReady: Promise<unknown>;
beforeEach(() => {
  clearTextureAtlas.mockClear();
  refresh.mockClear();
  scrollLines.mockClear();
  wheelRef.handler = null;
  fontsReady = Promise.resolve();
  Object.defineProperty(document, "fonts", {
    value: { ready: fontsReady },
    configurable: true,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
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
  vi.useRealTimers();
});

describe("Terminal font-ready repaint (dropped glyphs)", () => {
  it("forces a full repaint (clearTextureAtlas) once document.fonts.ready resolves", async () => {
    render(<Terminal {...baseProps} />);
    // The mount-time theme effect also clears the atlas once; ignore it — assert the FONT-READY one.
    clearTextureAtlas.mockClear();

    await fontsReady; // resolve the webfont gate
    await Promise.resolve(); // let the .then microtask run

    expect(clearTextureAtlas).toHaveBeenCalled();
  });
});

describe("Terminal scroll repaint (scroll remnants)", () => {
  it("forces a full repaint after a wheel scroll settles", () => {
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    clearTextureAtlas.mockClear();
    expect(wheelRef.handler).toBeTypeOf("function");

    // A real scroll: 100px down → several lines on the normal buffer.
    const handled = wheelRef.handler!({ deltaY: 100, deltaMode: 0 });
    expect(handled).toBe(false); // taken over from the app
    expect(scrollLines).toHaveBeenCalled();
    // Repaint is debounced — nothing yet, then it fires after the settle window.
    expect(clearTextureAtlas).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(clearTextureAtlas).toHaveBeenCalled();
  });

  it("does not repaint when a wheel tick scrolls zero lines", () => {
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    clearTextureAtlas.mockClear();
    scrollLines.mockClear();

    // 2px is below one cell height → trunc to 0 lines → no scroll, no repaint scheduled.
    wheelRef.handler!({ deltaY: 2, deltaMode: 0 });
    expect(scrollLines).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(clearTextureAtlas).not.toHaveBeenCalled();
  });
});
