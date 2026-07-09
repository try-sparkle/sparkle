// @vitest-environment jsdom
//
// Regression guard for the "stray glyph until I mouse over it" bug (the "WThe" artifact): under the
// WebGL renderer a cell is occasionally mis-rasterized during live streaming. The 80ms settle path
// only does a bare term.refresh() (cheap — the common visible-streaming case), which the renderer's
// per-cell model cache SKIPS, so the wrong glyph persists until a scroll / pane-switch / mouse-hover
// forces those rows to redraw. A separate, longer-debounced IDLE SWEEP runs one forceFullRepaint
// (clearTextureAtlas) once output goes quiet, so stray glyphs self-heal within ~half a second.
//
// This asserts the WIRING (clearTextureAtlas is reached from the idle sweep, is debounced by fresh
// output, and does NOT fire from the cheap settle refresh). forceFullRepaint itself is unit-tested
// in terminalWebgl.test.ts; the renderer/addons/PTY are mocked to thin fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Shared spies + the captured PTY-output handler (hoisted so vi.mock can close over them).
const { clearTextureAtlas, refresh, ptyOutRef } = vi.hoisted(() => ({
  clearTextureAtlas: vi.fn(),
  refresh: vi.fn(),
  ptyOutRef: { handler: null as null | ((e: { id: string; chunk: string }) => void) },
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
    refresh = refresh;
    scrollLines(): void {}
    focus(): void {}
    scrollToLine(): void {}
    getSelection(): string {
      return "";
    }
    // Invoke the parse-complete callback synchronously so flow control settles like the real xterm.
    write(_d: string, cb?: () => void): void {
      cb?.();
    }
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
  setPtyPaused: vi.fn(() => Promise.resolve()),
  // Capture the output handler so the test can push chunks through it.
  onPtyOutput: vi.fn((cb: (e: { id: string; chunk: string }) => void) => {
    ptyOutRef.handler = cb;
    return Promise.resolve(() => {});
  }),
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

beforeEach(() => {
  clearTextureAtlas.mockClear();
  refresh.mockClear();
  ptyOutRef.handler = null;
  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
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
  // Run rAF synchronously so the become-active reveal repaint fires during render (then we clear
  // the spy) — matching Terminal.scrollRepaint.test.tsx.
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

// A burst comfortably above IDLE_SWEEP_MIN_BYTES (2048) — a real agent-output burst, where a
// mis-rasterized glyph is plausible and the sweep should run.
const BIG_BURST = "x".repeat(3000);

describe("Terminal idle sweep (stray glyph self-heal)", () => {
  it("forces one full repaint after a substantial burst goes quiet — but NOT from the cheap settle refresh", () => {
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    // Ignore the mount-time theme + become-active reveal repaints; assert the OUTPUT-driven ones.
    clearTextureAtlas.mockClear();
    expect(ptyOutRef.handler).toBeTypeOf("function");

    ptyOutRef.handler!({ id: "agent-1", chunk: BIG_BURST });

    // The 80ms settle does a bare refresh() (cache-respecting) — it must NOT clear the atlas.
    vi.advanceTimersByTime(80);
    expect(refresh).toHaveBeenCalled();
    expect(clearTextureAtlas).not.toHaveBeenCalled();

    // The idle sweep fires only once output has been quiet past the longer window.
    vi.advanceTimersByTime(500);
    expect(clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("debounces the sweep: fresh output before the window resets it (streaming pays it once)", () => {
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    clearTextureAtlas.mockClear();

    // Stream several substantial chunks under the idle window — the sweep must keep getting pushed out.
    for (let i = 0; i < 5; i += 1) {
      ptyOutRef.handler!({ id: "agent-1", chunk: BIG_BURST });
      vi.advanceTimersByTime(300); // < 500ms idle window: never lets the sweep fire mid-stream
      expect(clearTextureAtlas).not.toHaveBeenCalled();
    }

    // Once streaming stops, exactly one sweep lands.
    vi.advanceTimersByTime(500);
    expect(clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it("does NOT sweep after a trivial interactive echo (routine pause pays no cold repaint)", () => {
    // roborev Low #35218: a keystroke echo / one-line update must not trigger a full atlas clear on
    // every lull. Below the volume bar, an idle pause stays a cheap refresh — no clearTextureAtlas.
    vi.useFakeTimers();
    render(<Terminal {...baseProps} />);
    clearTextureAtlas.mockClear();

    ptyOutRef.handler!({ id: "agent-1", chunk: "y\n" }); // a few bytes — far below IDLE_SWEEP_MIN_BYTES
    vi.advanceTimersByTime(80);
    expect(refresh).toHaveBeenCalled(); // the settle refresh still runs
    vi.advanceTimersByTime(500);
    expect(clearTextureAtlas).not.toHaveBeenCalled(); // ...but the idle sweep is gated out

    // Cumulative small bursts still eventually heal: once their total crosses the bar, one sweep lands.
    for (let i = 0; i < 20; i += 1) {
      ptyOutRef.handler!({ id: "agent-1", chunk: "x".repeat(200) }); // 20 × 200 = 4000 > 2048
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(500);
    expect(clearTextureAtlas).toHaveBeenCalledTimes(1);
  });
});
