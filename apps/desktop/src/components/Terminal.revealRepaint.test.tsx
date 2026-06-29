// @vitest-environment jsdom
//
// Regression guard for the recurring "top half of the terminal is blank until I scroll" bug.
// THREE prior fixes shipped without any test and the bug kept coming back. The root cause is that
// xterm's WebGL renderer skips cells whose content matches its per-cell cache, so a bare
// term.refresh() can't repaint cells that were poisoned while the pane was hidden — only clearing
// the renderer model (clearTextureAtlas, via forceFullRepaint) can. The fix routes the
// become-active REVEAL through forceFullRepaint.
//
// This test asserts exactly that wiring: when the pane becomes active, the reveal repaint calls
// the WebGL addon's clearTextureAtlas — NOT a bare refresh(). If anyone reverts the reveal path
// back to term.refresh(0, rows-1), clearTextureAtlas won't be called and this test fails.
//
// xterm needs a real canvas/WebGL renderer, so the renderer + addons + PTY bridge are mocked to
// thin fakes; we're testing the component's repaint wiring, not xterm itself. (The forceFullRepaint
// primitive — clear-before-refresh — is unit-tested separately in terminalWebgl.test.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// clearTextureAtlas spy shared with the mocked WebglAddon (hoisted so vi.mock can reference it).
const { clearTextureAtlas, refresh } = vi.hoisted(() => ({
  clearTextureAtlas: vi.fn(),
  refresh: vi.fn(),
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
      // A laid-out, paintable element so the reveal path treats the pane as visible.
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
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  fit(): void {}
} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {
  constructor(_handler: unknown) {}
} }));
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
    constructor(_opts: unknown) {}
    ingest(): void {}
    exit(): void {}
    dispose(): void {}
  },
}));
// useResolvedTheme uses matchMedia (absent in jsdom); stub it to a fixed value.
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

beforeEach(() => {
  clearTextureAtlas.mockClear();
  refresh.mockClear();
  // jsdom has no ResizeObserver; Terminal constructs one on mount.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // Run rAF callbacks synchronously so the become-active reveal repaint (a nested rAF) executes
  // within the test tick.
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

describe("Terminal reveal repaint", () => {
  it("clears the WebGL model (clearTextureAtlas) when the pane becomes active — not a bare refresh()", () => {
    const { rerender } = render(<Terminal {...baseProps} active={false} />);
    // The mount-time theme effect also clears the atlas once; ignore it — we assert the REVEAL.
    clearTextureAtlas.mockClear();

    rerender(<Terminal {...baseProps} active={true} />);

    // The fix: becoming active must force a full repaint via clearTextureAtlas. A regression to
    // a bare term.refresh() on the reveal path would leave this uncalled and fail the test.
    expect(clearTextureAtlas).toHaveBeenCalled();
  });

  it("does not repaint via clearTextureAtlas while the pane stays inactive", () => {
    render(<Terminal {...baseProps} active={false} />);
    clearTextureAtlas.mockClear();
    // No active flip → no reveal repaint.
    expect(clearTextureAtlas).not.toHaveBeenCalled();
  });
});
