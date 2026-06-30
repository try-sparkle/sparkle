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
// `widthCtl` lets a test simulate a display:none→flex reveal that lays out only after N frames:
// the mocked terminal element reads its clientWidth from widthCtl.value live.
const { clearTextureAtlas, refresh, widthCtl } = vi.hoisted(() => ({
  clearTextureAtlas: vi.fn(),
  refresh: vi.fn(),
  widthCtl: { value: 720 },
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
      // clientWidth is read LIVE from widthCtl so a test can model a pane that lays out only after
      // a few frames (display:none→flex). >0 means laid-out/paintable (the reveal path's check).
      Object.defineProperty(el, "clientWidth", { get: () => widthCtl.value, configurable: true });
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
import { resizePty } from "../pty";
import { CONVERGE_MAX_FRAMES } from "./terminalSize";

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
  vi.mocked(resizePty).mockClear();
  widthCtl.value = 720; // default: laid out. Individual tests override to model a delayed reveal.
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

  it("keeps retrying across frames until a slow display:none→flex reveal lays out, then syncs + repaints", () => {
    // The core "stays wonky for multiple seconds" race: the pane becomes active but its box hasn't
    // laid out yet for the first frames. The OLD code fit + synced exactly once and lost — leaving
    // the PTY at a stale size (wrong wrap column) until an incidental resize fixed it. The reveal
    // loop must WAIT across frames and only sync + repaint once the box genuinely lays out.
    const queue: FrameRequestCallback[] = [];
    const step = () => {
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(0);
    };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    widthCtl.value = 0; // revealed but NOT laid out yet
    const { rerender } = render(<Terminal {...baseProps} active={false} />);
    step(); // drain mount-time frames
    clearTextureAtlas.mockClear();
    vi.mocked(resizePty).mockClear();

    rerender(<Terminal {...baseProps} active={true} />); // schedules the reveal tick

    // A few frames pass with the box still collapsed: no size pushed, no repaint — just retries.
    step();
    step();
    step();
    expect(resizePty).not.toHaveBeenCalled();
    expect(clearTextureAtlas).not.toHaveBeenCalled();

    // Now the pane finally lays out. The next tick must sync the true size and (next frame) repaint.
    widthCtl.value = 720;
    step(); // tick sees laidOut → syncPtySize + schedules the deferred repaint
    step(); // deferred repaint frame runs forceFullRepaint

    expect(resizePty).toHaveBeenCalled();
    expect(clearTextureAtlas).toHaveBeenCalled();
  });

  it("gives up (bounded) when a revealed pane never lays out — no endless rAFs, no size push", () => {
    // Belt-and-suspenders: a pane that stays collapsed past the frame budget (pathological — e.g.
    // it's revealed but immediately re-hidden) must STOP retrying rather than spin forever, and
    // must never push a (stale/0-width) size or repaint. The ResizeObserver remains the backstop.
    const queue: FrameRequestCallback[] = [];
    let scheduled = 0;
    const step = () => {
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(0);
    };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      scheduled += 1;
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    widthCtl.value = 0; // revealed but NEVER lays out
    const { rerender } = render(<Terminal {...baseProps} active={false} />);
    step(); // drain mount-time frames
    clearTextureAtlas.mockClear();
    vi.mocked(resizePty).mockClear();
    scheduled = 0;

    rerender(<Terminal {...baseProps} active={true} />); // schedules the reveal tick

    // Run well past the budget. The loop must stop scheduling once framesLeft is exhausted.
    for (let i = 0; i < CONVERGE_MAX_FRAMES + 5; i++) step();

    expect(queue.length).toBe(0); // converged to a stop — nothing left pending
    expect(scheduled).toBeLessThanOrEqual(CONVERGE_MAX_FRAMES + 1); // bounded by the budget
    expect(resizePty).not.toHaveBeenCalled(); // never pushed a size for an unmeasured pane
    expect(clearTextureAtlas).not.toHaveBeenCalled(); // never repainted
  });

  it("cancels the pending reveal rAFs on unmount so no paint reaches a disposed terminal", () => {
    // The reveal repaint runs across two requestAnimationFrame hops. If the pane is unmounted
    // (agent closed / webview reload) in that window, the leftover frame would call fit.fit()/
    // forceFullRepaint against a torn-down xterm core, which schedules an internal RenderService
    // frame that reads `this._renderer.value.dimensions` after dispose() → the uncaught TypeError
    // still seen in logs after the #231 dispose-ordering fix. The effect cleanup must cancel both
    // rAFs so nothing is queued in the teardown window. We drive rAF manually here (the global
    // beforeEach runs them synchronously, which can't model the unmount-before-frame race).
    const queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
    let nextId = 1;
    const cancelled = new Set<number>();
    const flush = () => {
      while (queue.length) {
        const { id, cb } = queue.shift()!;
        if (!cancelled.has(id)) cb(0);
      }
    };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.push({ id, cb });
      return id;
    });
    const cancelSpy = vi.fn((id: number) => cancelled.add(id));
    vi.stubGlobal("cancelAnimationFrame", cancelSpy);

    const { rerender, unmount } = render(<Terminal {...baseProps} active={false} />);
    flush(); // drain mount-time frames
    clearTextureAtlas.mockClear();

    rerender(<Terminal {...baseProps} active={true} />); // schedules the reveal rAF (queued, not run)
    unmount(); // effect cleanup must cancel the pending reveal rAF
    flush(); // run any rAF that was NOT cancelled

    expect(cancelSpy).toHaveBeenCalled();
    // The reveal repaint must never fire after unmount — cancellation (and the `cancelled` guard)
    // keeps clearTextureAtlas from touching the disposed terminal.
    expect(clearTextureAtlas).not.toHaveBeenCalled();
  });
});
