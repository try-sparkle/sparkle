// @vitest-environment jsdom
//
// REGRESSION GUARD for bead sparkle-nwpf: the output-settle repaint must SKIP a backgrounded pane.
//
// The headline win of the settleRepaintPlan work is that an off-screen pane no longer pays a
// term.refresh() per output settle. paneVisibility.ts hides an inactive pane with `visibility:
// hidden` while keeping it `display: flex` at full size — so its element's `clientWidth` stays > 0.
// The settle call site used to gate on `isPaintable()` (just `clientWidth > 0`), which is TRUE for
// such a pane, so the plan came back `refresh` and every one of dozens of background agents repainted
// on every settle — exactly the work the optimization claimed to eliminate.
//
// The fix gates the settle on `isOnScreen()` (which ALSO requires `activeRef`), so a hidden pane
// resolves to `skip`. THE ASSERTION IS THE SIDE EFFECT, NOT THE PRECONDITION: we drive real output
// through a real <Terminal> and assert that `term.refresh()` — the thing a `refresh` plan does, and
// the wasted work — is NOT reached for a hidden pane, and IS reached for a visible one. The pane's
// element is given clientWidth 720 in BOTH cases, so the skip is due to off-screen-ness and not a
// 0-width box (which would skip even under the buggy `isPaintable()` code — the vacuous outcome the
// existing settleRepaintPlan(false,false) unit test could not rule out). Reverting the call site to
// `isPaintable()` turns the hidden-pane assertion RED.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// refresh — the settle repaint's side effect. outputHandlers — the captured onOutput callback per
// agent id, so a test can push a real chunk through the same seam the PTY does. els — every mocked
// terminal's element, so a test can prove the hidden pane really is clientWidth > 0 (i.e. the bug's
// precondition holds and the skip is not an artefact of a collapsed box).
const { refresh, outputHandlers, els } = vi.hoisted(() => ({
  refresh: vi.fn(),
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
      // The crux of the bug: a backgrounded pane is visibility:hidden but STILL LAID OUT, so its
      // clientWidth is a real positive number. Give every pane — hidden or not — a real width, so a
      // `skip` can only come from off-screen-ness, never from a 0-width element.
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
    // The onOutput handler calls term.write(chunk, cb); invoking cb keeps the flow-control path
    // honest, though this test only cares about the settle repaint it schedules afterward.
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
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

// The PTY seam. onPtyOutput captures the per-id handler so a test can emit output through the exact
// path LocalTransport.onOutput subscribes to.
vi.mock("../pty", () => ({
  spawnPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
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

beforeEach(() => {
  refresh.mockClear();
  outputHandlers.clear();
  els.length = 0;
  vi.useFakeTimers();
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

/** Push a chunk through the same onOutput seam the PTY uses, then let the 80ms settle timer fire. */
function emitAndSettle(id: string) {
  const handler = outputHandlers.get(id);
  if (!handler) throw new Error(`no output handler captured for ${id} — the effect never subscribed`);
  refresh.mockClear(); // ignore any mount-time refresh; count only the settle-driven one
  handler({ chunk: "hello world\n", bytes: 12 });
  vi.advanceTimersByTime(SETTLE_MS); // fire the debounced settle repaint
}

describe("Terminal output-settle repaint gates on isOnScreen, not isPaintable (sparkle-nwpf)", () => {
  it("a BACKGROUND pane (visibility:hidden, clientWidth > 0) settles to SKIP — no term.refresh()", () => {
    render(<Terminal {...baseProps} agentId="bg" active={false} />);

    // The bug's precondition, stated so a green result cannot be an artefact of a 0-width box: the
    // hidden pane's element is genuinely laid out, so isPaintable() would return true for it.
    expect(els.at(-1)?.clientWidth).toBe(720);

    emitAndSettle("bg");

    // THE SIDE EFFECT. Pre-fix (isPaintable() at the call site) this pane repainted on every settle;
    // the fix makes it skip. If this ever goes non-zero the background-pane optimization is dead.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an ON-SCREEN pane still settles to REFRESH — the inverse, so the skip is not a dead feature", () => {
    render(<Terminal {...baseProps} agentId="fg" active={true} />);

    emitAndSettle("fg");

    // The visible pane must still repaint after output settles — otherwise the gate has simply
    // stopped repainting everything and the assertion above would pass for the wrong reason.
    expect(refresh).toHaveBeenCalled();
  });
});
