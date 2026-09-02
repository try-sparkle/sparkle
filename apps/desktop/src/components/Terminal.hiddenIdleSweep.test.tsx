// @vitest-environment jsdom
//
// REGRESSION GUARD for bead sparkle-7izq1: the OUTPUT-DRIVEN IDLE SWEEP must skip a backgrounded
// pane, so the renderer cost of PTY output does not scale with the number of mounted-but-hidden
// panes.
//
// THE DEFECT THIS PINS. Terminal.tsx has two output-driven repaint timers side by side:
//
//   · the 80ms SETTLE repaint — gated on `isOnScreen()` (activeRef && clientWidth > 0) since
//     bead sparkle-nwpf, so a hidden pane resolves to `skip`. Guarded by
//     Terminal.hiddenSettleRepaint.test.tsx.
//   · the 500ms IDLE SWEEP — a `forceFullRepaint` that heals stray glyphs. Its comment claimed it
//     was "Skipped while the pane is hidden", but it gated on `isPaintable()` ALONE, and
//     paneVisibility.ts keeps every backgrounded pane `display: flex` at full size (hidden only by
//     `visibility`), so `clientWidth > 0` is TRUE for all of them. The guard was inert: EVERY hidden
//     pane that streamed past IDLE_SWEEP_MIN_BYTES and then went quiet ran a full repaint.
//
// WHY THAT IS THE FLEET-SCALE WEDGE, not a rounding error. `forceFullRepaint` does two things, and
// both are expensive at N panes:
//   1. `term.refresh(0, rows - 1)` — marks the WHOLE viewport dirty. Past MAX_WEBGL_CONTEXTS (4)
//      a pane is on xterm's DOM renderer, so that is thousands of text spans rewritten for a pane
//      nobody is looking at. `content-visibility: hidden` (bead sparkle-gw36j) drops the hidden
//      subtree out of LAYOUT; it does not stop this JS from running or the DOM from being mutated.
//   2. `clearSharedAtlasEverywhere` — the WebGL texture atlas is shared PROCESS-WIDE, so a hidden
//      pane that still holds an addon wipes the shared bitmap and makes every peer (including the
//      pane the human is actually watching) re-clear its model and redraw its full viewport.
//
// Under fleet load every background agent is bursty: each one going quiet costs one of the above,
// so the total is O(N) full-viewport repaints per idle window, driven purely by output nobody sees.
//
// THE ASSERTION IS THE SIDE EFFECT, NOT A FLAG, AND IT IS A RELATIONSHIP, NOT A NUMBER (the
// load-sensitive-test trap, bead sparkle-ov6te): identical output is driven through 1 visible pane
// plus N hidden panes for two very different N, and the repaint count must be the SAME for both.
// Nothing here reads a clock or a wall-time budget, so a busy machine cannot flake it.
//
// Every pane's element is given clientWidth 720 — hidden ones included — so a skip can only come
// from off-screen-ness and never from a collapsed box (the vacuous outcome that would make this
// test pass against the buggy code for the wrong reason).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const { refresh, clearTextureAtlas, outputHandlers, els } = vi.hoisted(() => ({
  refresh: vi.fn(),
  clearTextureAtlas: vi.fn(),
  outputHandlers: new Map<string, (e: { chunk: string; bytes: number }) => void>(),
  els: [] as HTMLElement[],
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
      // The bug's precondition: a backgrounded pane is visibility:hidden but STILL LAID OUT, so its
      // clientWidth is a real positive number and `isPaintable()` returns true for it.
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      const glCanvas = document.createElement("canvas");
      Object.defineProperty(glCanvas, "getContext", {
        value: (id: string) =>
          id === "webgl2" ? { getExtension: () => ({ loseContext: () => {} }) } : null,
        configurable: true,
      });
      el.appendChild(glCanvas);
      parent.appendChild(el);
      this.element = el;
      els.push(el);
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
    write(_data: string, cb?: () => void): void {
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
  spawnPty: vi.fn(() => Promise.resolve(7)),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
  setPtyPaused: vi.fn(() => Promise.resolve()),
  ptyAck: vi.fn(() => Promise.resolve()),
  onPtyOutput: vi.fn((id: string, handler: (e: { chunk: string; bytes: number }) => void) => {
    outputHandlers.set(id, handler);
    return Promise.resolve(() => outputHandlers.delete(id));
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
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  onStatus: () => {},
};

const SETTLE_MS = 80;
const IDLE_SWEEP_MS = 500;
// Comfortably above IDLE_SWEEP_MIN_BYTES (2048) — a real agent-output burst, the volume at which
// the sweep is meant to run at all.
const BIG_BURST = "x".repeat(3000);

beforeEach(() => {
  refresh.mockClear();
  clearTextureAtlas.mockClear();
  outputHandlers.clear();
  els.length = 0;
  vi.useFakeTimers();
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Mount one VISIBLE pane plus `hidden` backgrounded ones, push an identical burst through every
 * pane's real onOutput seam, then let both repaint timers fire. Returns the repaint work observed.
 *
 * This is the whole measurement: the same output per pane at two very different fleet sizes, with
 * only the number of hidden panes changing.
 */
function streamToFleet(hidden: number): { refreshes: number; atlasClears: number } {
  render(<Terminal {...baseProps} agentId="visible" active={true} />);
  for (let i = 0; i < hidden; i += 1) {
    render(<Terminal {...baseProps} agentId={`bg-${i}`} active={false} />);
  }
  if (outputHandlers.size !== hidden + 1) {
    throw new Error(`expected ${hidden + 1} output handlers, got ${outputHandlers.size}`);
  }
  // Ignore mount-time / become-active reveal repaints; count only the OUTPUT-driven ones.
  refresh.mockClear();
  clearTextureAtlas.mockClear();

  for (const handler of outputHandlers.values()) handler({ chunk: BIG_BURST, bytes: BIG_BURST.length });
  vi.advanceTimersByTime(SETTLE_MS);
  vi.advanceTimersByTime(IDLE_SWEEP_MS);

  return { refreshes: refresh.mock.calls.length, atlasClears: clearTextureAtlas.mock.calls.length };
}

describe("PTY output repaint cost does not scale with hidden panes (sparkle-7izq1)", () => {
  it("streams to 1 visible + N hidden panes: repaint work is the SAME at N=1 and N=32", () => {
    const small = streamToFleet(1);
    cleanup();
    refresh.mockClear();
    clearTextureAtlas.mockClear();
    outputHandlers.clear();
    els.length = 0;
    const large = streamToFleet(32);

    // NON-VACUITY, asserted first: the mechanism must actually be live, or "same at both N" would
    // pass for a build that simply stopped repainting anything.
    expect(small.refreshes).toBeGreaterThan(0);

    // THE RELATIONSHIP. 31 extra hidden panes, each handed the same burst, must buy ZERO extra
    // repaint work. A wall-clock or exact-count assertion would flake on a busy machine
    // (sparkle-ov6te); this is a pure equality between two runs of the same harness.
    expect(large.refreshes).toBe(small.refreshes);
    expect(large.atlasClears).toBe(small.atlasClears);
  });

  it("a HIDDEN pane's burst going quiet triggers no repaint at all", () => {
    render(<Terminal {...baseProps} agentId="bg" active={false} />);
    expect(els.at(-1)?.clientWidth).toBe(720); // the bug's precondition: really laid out
    refresh.mockClear();
    clearTextureAtlas.mockClear();

    outputHandlers.get("bg")!({ chunk: BIG_BURST, bytes: BIG_BURST.length });
    vi.advanceTimersByTime(SETTLE_MS + IDLE_SWEEP_MS);

    // Pre-fix the idle sweep fired here — a full-viewport repaint plus a process-wide atlas wipe
    // for a pane nobody is looking at.
    expect(clearTextureAtlas).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a VISIBLE pane still sweeps — the skip is a gate, not a dead feature", () => {
    render(<Terminal {...baseProps} agentId="fg" active={true} />);
    refresh.mockClear();
    clearTextureAtlas.mockClear();

    outputHandlers.get("fg")!({ chunk: BIG_BURST, bytes: BIG_BURST.length });
    vi.advanceTimersByTime(SETTLE_MS);
    vi.advanceTimersByTime(IDLE_SWEEP_MS);

    // The stray-glyph self-heal the sweep exists for still runs where it can be seen.
    expect(clearTextureAtlas).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });
});
