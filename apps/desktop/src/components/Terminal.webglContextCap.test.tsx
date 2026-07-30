// @vitest-environment jsdom
//
// Regression guard for the GARBAGE-GLYPH bug: terminal text rendering as mojibake — correct layout,
// correct colors, WRONG glyphs — intermittently, recovering and re-corrupting. That signature is a
// renderer drawing from a dead or empty texture atlas, i.e. a WebGL context taken away underneath
// it. The human runs 60-80 agents deliberately, so the renderer has to scale to the fleet; capping
// the fleet is not an option.
//
// The engine's real budget is MEASURED, not assumed: scripts/measure-webgl-context-limit.mjs reports
// 16 concurrent webgl2 contexts on WebKit 26.5 (and Chromium 149), with the 17th creation evicting
// context #0 — the OLDEST. So the victim of exhaustion is whichever context has lived longest, which
// under Sparkle's churn is the terminal the human is looking at.
//
// EVERY test in this file fails against the pre-fix code:
//   · attachment was bounded only by how many panes believed they were visible, with no ceiling;
//   · xterm's WebglAddon.dispose() never calls WEBGL_lose_context.loseContext() (verified: the
//     string does not appear in @xterm/addon-webgl 0.19.0), so teardown leaked the GPU context;
//   · a lost context was handled only via the addon's onContextLoss, which fires 3 SECONDS late.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const {
  addonCtors,
  disposeSpy,
  loseContext,
  lostListeners,
  clearTextureAtlas,
  refresh,
  termDispose,
  canvasPresent,
} = vi.hoisted(() => ({
  addonCtors: { count: 0 },
  disposeSpy: vi.fn(),
  loseContext: vi.fn(),
  // Every webglcontextlost listener registered on a mock canvas, so a test can dispatch the event
  // the way the engine would.
  lostListeners: [] as Array<() => void>,
  clearTextureAtlas: vi.fn(),
  refresh: vi.fn(),
  termDispose: vi.fn(),
  // Lets a test model an xterm whose WebGL canvas cannot be located.
  canvasPresent: { value: true },
}));

// A canvas that answers getContext("webgl2") — jsdom's real canvas returns null for WebGL, so the
// component could never find a context to release without this. Registers its webglcontextlost
// listeners into the shared array.
function makeGlCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const gl = {
    getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null),
  };
  Object.defineProperty(canvas, "getContext", {
    value: (id: string) => (id === "webgl2" ? gl : null),
    configurable: true,
  });
  const realAdd = canvas.addEventListener.bind(canvas);
  Object.defineProperty(canvas, "addEventListener", {
    value: (type: string, fn: EventListenerOrEventListenerObject) => {
      if (type === "webglcontextlost") lostListeners.push(fn as () => void);
      realAdd(type, fn);
    },
    configurable: true,
  });
  return canvas;
}

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
      // xterm puts a 2d link layer next to the WebGL canvas; include one so the probe has to
      // discriminate rather than grabbing the first canvas it sees.
      const layer = document.createElement("canvas");
      Object.defineProperty(layer, "getContext", {
        value: (id: string) => (id === "2d" ? {} : null),
        configurable: true,
      });
      el.appendChild(layer);
      if (canvasPresent.value) el.appendChild(makeGlCanvas());
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
    dispose = termDispose;
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_handler: unknown) {}
  },
}));
// Counts constructions — one construction == one GPU context allocated.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      addonCtors.count++;
    }
    onContextLoss(_cb: () => void): void {}
    clearTextureAtlas = clearTextureAtlas;
    dispose = disposeSpy;
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
import {
  MAX_WEBGL_CONTEXTS,
  liveWebglPermitCount,
  resetWebglPermits,
  isWebglCanvasUnfindable,
} from "./webglContextRegistry";

const baseProps = {
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  onStatus: () => {},
};

beforeEach(() => {
  addonCtors.count = 0;
  disposeSpy.mockClear();
  loseContext.mockClear();
  clearTextureAtlas.mockClear();
  refresh.mockClear();
  termDispose.mockClear();
  lostListeners.length = 0;
  canvasPresent.value = true;
  // Also clears the process-wide canvas-unfindable latch.
  resetWebglPermits();
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
  }));
});

afterEach(() => {
  cleanup();
  resetWebglPermits();
});

// THE HEADLINE INVARIANT: contexts scale with VISIBLE terminals, never with agent count.
describe("WebGL context count vs agent count", () => {
  it("allocates NO context for the 40 hidden panes of a 40-agent fleet", () => {
    for (let i = 0; i < 40; i++) {
      render(<Terminal {...baseProps} agentId={`agent-${i}`} active={false} />);
    }
    expect(addonCtors.count).toBe(0);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("stays bounded by MAX_WEBGL_CONTEXTS even when 40 panes ALL claim to be active", () => {
    // This is the case a layout refactor reintroduces: several stages/pairs/portalled panes each
    // believing they are visible. Pre-fix this allocated one context per pane — 40 of them, well
    // past the measured budget of 16 — and the engine evicted the oldest, corrupting a live pane.
    for (let i = 0; i < 40; i++) {
      render(<Terminal {...baseProps} agentId={`agent-${i}`} active />);
    }
    expect(addonCtors.count).toBeLessThanOrEqual(MAX_WEBGL_CONTEXTS);
    expect(liveWebglPermitCount()).toBeLessThanOrEqual(MAX_WEBGL_CONTEXTS);
  });

  it("WARNS when it refuses a renderer, so a recurrence is self-diagnosing rather than silent", () => {
    // The original exhaustion went unnoticed until it corrupted the screen. Falling back to the DOM
    // renderer is correct but must never be silent — otherwise "why is my box-drawing fuzzy" and
    // "why did my glyphs turn to mojibake" are both invisible in the logs.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < MAX_WEBGL_CONTEXTS + 3; i++) {
        render(<Terminal {...baseProps} agentId={`agent-${i}`} active />);
      }
      const refusedAgents = new Set(
        warn.mock.calls
          .filter((c) => String(c[0]).includes("webgl renderer capped"))
          .map((c) => c[1] as string),
      );
      // Assert on DISTINCT agents, not raw call count: a pane attempts attach from both the mount
      // effect and the visibility effect, so a refused pane warns twice. Attach is idempotent so
      // the duplicate is only log noise — what matters is that every refused pane is named.
      expect(refusedAgents).toEqual(
        new Set([`agent-${MAX_WEBGL_CONTEXTS}`, `agent-${MAX_WEBGL_CONTEXTS + 1}`, `agent-${MAX_WEBGL_CONTEXTS + 2}`]),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("grows contexts with VISIBLE count, not fleet size (10x the agents, same context count)", () => {
    // The property stated as a comparison, so it cannot be satisfied by accidentally capping
    // everything to zero: one visible pane in a 4-agent fleet and one in a 40-agent fleet must
    // allocate the SAME number of contexts.
    for (let i = 0; i < 4; i++) {
      render(<Terminal {...baseProps} agentId={`small-${i}`} active={i === 0} />);
    }
    const smallFleet = addonCtors.count;

    cleanup();
    resetWebglPermits();
    addonCtors.count = 0;

    for (let i = 0; i < 40; i++) {
      render(<Terminal {...baseProps} agentId={`big-${i}`} active={i === 0} />);
    }
    expect(addonCtors.count).toBe(smallFleet);
    expect(smallFleet).toBe(1); // and it really is attaching for the visible one
  });
});

// THE LEAK. xterm's dispose() only removes the canvas from the DOM; the context survives until GC.
// Contexts therefore accumulated across a whole session (103 attaches were logged in one) until the
// engine's 16-context budget was exhausted and it evicted the oldest — the visible terminal.
describe("GPU context release", () => {
  it("RELEASES the context (loseContext) when a pane becomes hidden, not just dispose()", () => {
    const { rerender } = render(<Terminal {...baseProps} agentId="a" active />);
    expect(addonCtors.count).toBe(1);
    loseContext.mockClear();

    rerender(<Terminal {...baseProps} agentId="a" active={false} />);

    // dispose() alone is what shipped before, and it is NOT sufficient — assert the actual
    // hand-back to the engine.
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("RELEASES the context on unmount (closing a tab must not leak a context)", () => {
    const { unmount } = render(<Terminal {...baseProps} agentId="a" active />);
    expect(addonCtors.count).toBe(1);
    loseContext.mockClear();

    unmount();

    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("does not drift across 60 hide/show cycles — the cumulative shape that exhausted the engine", () => {
    const { rerender } = render(<Terminal {...baseProps} agentId="a" active />);
    for (let i = 0; i < 60; i++) {
      rerender(<Terminal {...baseProps} agentId="a" active={false} />);
      rerender(<Terminal {...baseProps} agentId="a" active />);
    }
    // 61 attaches, 60 releases, exactly one context still held: the visible one.
    expect(liveWebglPermitCount()).toBe(1);
    expect(loseContext).toHaveBeenCalledTimes(60);
    // And a slot is still available for another pane — the cap was never silently consumed.
    expect(liveWebglPermitCount()).toBeLessThan(MAX_WEBGL_CONTEXTS);
  });
});

// THE 3-SECOND GARBAGE WINDOW — what made the bug unrecoverable rather than merely likely.
// xterm's handler preventDefaults and waits 3000ms before firing onContextLoss (and never fires it
// at all if the engine restores the context first), so the terminal renders through a dead context
// for up to three seconds, then snaps back, then does it again.
describe("webglcontextlost fallback", () => {
  it("falls back to the DOM renderer SYNCHRONOUSLY on webglcontextlost — no 3s wait, no timers", () => {
    render(<Terminal {...baseProps} agentId="a" active />);
    expect(lostListeners.length).toBeGreaterThan(0); // we listen at all — pre-fix we did not
    disposeSpy.mockClear();
    loseContext.mockClear();

    // Dispatch the event the engine dispatches. No fake timers are installed, so anything deferred
    // behind the addon's setTimeout(3000) simply would not run — if this passes, the fallback is
    // genuinely immediate.
    lostListeners.forEach((fn) => fn());

    expect(disposeSpy).toHaveBeenCalled(); // renderer swapped out at once
    expect(liveWebglPermitCount()).toBe(0); // and its slot handed back
  });

  it("repaints after the fallback so the dead frame cannot linger as garbage", () => {
    render(<Terminal {...baseProps} agentId="a" active />);
    refresh.mockClear();

    lostListeners.forEach((fn) => fn());

    // Disposing swaps the renderer but paints nothing; without this the corrupted frame stays on
    // screen until the next PTY write.
    expect(refresh).toHaveBeenCalled();
  });

  it("handles a repeated webglcontextlost without double-releasing the permit", () => {
    render(<Terminal {...baseProps} agentId="a" active />);
    const listeners = [...lostListeners];
    listeners.forEach((fn) => fn());
    listeners.forEach((fn) => fn());
    listeners.forEach((fn) => fn());
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("frees the slot for another pane after a loss (a loss must not permanently shrink the cap)", () => {
    const { unmount } = render(<Terminal {...baseProps} agentId="a" active />);
    lostListeners.forEach((fn) => fn());
    unmount();
    addonCtors.count = 0;

    render(<Terminal {...baseProps} agentId="b" active />);
    // If the loss path leaked its permit, MAX_WEBGL_CONTEXTS losses would leave no pane able to
    // ever get a WebGL renderer again.
    expect(addonCtors.count).toBe(1);
  });
});

// THE SOLID BLACK PANE. A pane whose context is lost must reach a renderer that actually paints,
// WITHOUT the remount the human had to perform by hand.
//
// Why it went black rather than showing garbage — from @xterm/addon-webgl 0.19.0:
//   webglcontextrestored → clearTimeout(timer); removeTerminalFromCache(); _initializeWebGLState();
//                          _requestRedrawViewport()
//   clearTextureAtlas()      = _charAtlas.clearTexture() + _clearModel(true) + redraw
//   _requestRedrawViewport() = _onRequestRedraw.fire({start:0, end:rows-1})   ← and NOTHING else
// On restore the atlas is emptied but the per-cell MODEL is never cleared, so _updateModel skips
// every cell, nothing is uploaded into the empty atlas, and the GPU draws nothing — permanently,
// because the restore also cleared the 3s timer so onContextLoss never fires. Disposing inside the
// LOSS dispatch (below) means that restore path is never reached at all.
describe("a mounted terminal whose WebGL context is lost", () => {
  it("REPAINTS the full viewport without a remount", () => {
    render(<Terminal {...baseProps} agentId="a" active />);
    expect(addonCtors.count).toBe(1);
    refresh.mockClear();
    termDispose.mockClear();

    lostListeners.forEach((fn) => fn());

    // The whole point: recovery must not require the remount the human did by hand...
    expect(termDispose).not.toHaveBeenCalled();
    // ...and the repaint must cover the WHOLE viewport (rows-1 == 23). A partial range leaves the
    // rest of the pane black, which is the bug.
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });
});

// SCROLLBACK. Not asserted here on purpose. The buffer — viewport and scrollback — is xterm CORE
// state, so no jsdom mock of xterm can demonstrate that the fallback preserves it: the component
// cannot mutate the mock's buffer either way, which would make any such assertion vacuous by
// construction. It is established instead by reading @xterm/addon-webgl 0.19.0: `clearScrollback`
// appears zero times, `buffer.active` only in read paths (e.g. cursorY), and the teardown's
// `removeTerminalFromCache` splices the shared glyph-ATLAS array and disposes the atlas, never the
// buffer. `term.dispose()` is separately asserted above never to run on this path.

// A renderer we cannot manage is strictly worse than no renderer: it can be neither watched for
// context loss nor released, so it is exposed to exactly the black-pane path above with nothing to
// rescue it. The DOM renderer has no atlas and no model cache and cannot fail that way.
describe("when the WebGL canvas cannot be found", () => {
  it("REFUSES to keep the renderer, and does not drive it on the reveal repaint", () => {
    canvasPresent.value = false;

    render(<Terminal {...baseProps} agentId="a" active />);

    // The addon must be constructed before its canvas can exist, so the contract is "never KEEP".
    expect(disposeSpy).toHaveBeenCalled();
    expect(liveWebglPermitCount()).toBe(0);
    // The discriminating assertion: under the old warn-and-keep behavior webglRef stayed set, so
    // the become-active reveal repaint drove clearTextureAtlas on the very renderer we cannot
    // manage. After the refusal webglRef is null, so forceFullRepaint(null, term) is a bare
    // refresh. `termDispose not called` would NOT discriminate — it is true on every attach path.
    expect(clearTextureAtlas).not.toHaveBeenCalled();
    // And the pane still renders — refusing WebGL means the DOM renderer, not a dead pane.
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });

  it("LATCHES after repeated failures — and the suppression is the LATCH, not a dead effect", () => {
    // The control comes first: with a findable canvas, an off/on cycle really does re-run
    // attachWebgl and construct another addon. Without establishing that, a later "count stayed 1"
    // could equally mean the effect never re-ran, and the test would pass with the latch deleted.
    const healthy = render(<Terminal {...baseProps} agentId="control" active />);
    expect(addonCtors.count).toBe(1);
    healthy.rerender(<Terminal {...baseProps} agentId="control" active={false} />);
    healthy.rerender(<Terminal {...baseProps} agentId="control" active />);
    expect(addonCtors.count).toBe(2); // activation DOES re-attach — the loop below has teeth
    healthy.unmount();
    resetWebglPermits();
    addonCtors.count = 0;

    // Two distinct agents fail the probe → systemic, so the latch arms.
    canvasPresent.value = false;
    render(<Terminal {...baseProps} agentId="a" active />);
    render(<Terminal {...baseProps} agentId="b" active />);
    expect(isWebglCanvasUnfindable()).toBe(true);
    const afterLatch = addonCtors.count;

    // Now make the canvas findable again and hammer activations. If the latch is what suppresses
    // construction, the count cannot move — even though attachWebgl is being re-entered and would
    // now succeed. This is the assertion the earlier version of this test could not make.
    canvasPresent.value = true;
    const { rerender } = render(<Terminal {...baseProps} agentId="c" active />);
    for (let i = 0; i < 20; i++) {
      rerender(<Terminal {...baseProps} agentId="c" active={false} />);
      rerender(<Terminal {...baseProps} agentId="c" active />);
    }
    expect(addonCtors.count).toBe(afterLatch);
    expect(liveWebglPermitCount()).toBe(0);
  });

  it("does NOT latch on a single one-off failure — one unlucky pane must not disable the session", () => {
    // A process-wide, one-way latch costs every pane its renderer if it fires wrongly, while a
    // missed latch costs one stranded context. So one failure is not enough evidence.
    canvasPresent.value = false;
    const { rerender } = render(<Terminal {...baseProps} agentId="unlucky" active />);
    expect(isWebglCanvasUnfindable()).toBe(false);

    // Declining to latch is only SAFE because the pane itself stops re-allocating. An addon has to
    // be CONSTRUCTED before its canvas can be probed, and a construction we then cannot release
    // strands a webgl2 context for the life of the process — so "we chose not to disable WebGL"
    // must not silently mean "this pane leaks a context per activation instead". The latch
    // assertion below cannot see that: it stays false either way. This is the direct bound.
    const afterFirst = addonCtors.count;

    // ...not even across hide/show cycles. attachWebgl runs TWICE for a pane that mounts active
    // (mount effect + visibility effect) and again on every activation, so counting ATTACHES rather
    // than PANES would let this one pane spend the whole evidence budget on itself and disable
    // WebGL for the session. Rendering once would not have caught that.
    for (let i = 0; i < 5; i++) {
      rerender(<Terminal {...baseProps} agentId="unlucky" active={false} />);
      rerender(<Terminal {...baseProps} agentId="unlucky" active />);
      expect(isWebglCanvasUnfindable()).toBe(false);
      // The per-instance probeFailedRef guard, not the process-wide latch, is what holds this line.
      expect(addonCtors.count).toBe(afterFirst);
    }

    // ...and a pane that probes fine afterwards still gets WebGL.
    canvasPresent.value = true;
    addonCtors.count = 0;
    render(<Terminal {...baseProps} agentId="healthy" active />);
    expect(addonCtors.count).toBe(1);
  });

  it("does not arm the SYSTEMIC clause across a successful probe — those failures must be consecutive", () => {
    // A successful probe is direct proof this build puts its canvas where we look, refuting the
    // systemic hypothesis. Two unrelated blips separated by a working pane must not add up to a
    // permanent, session-wide disable.
    canvasPresent.value = false;
    render(<Terminal {...baseProps} agentId="blip-1" active />);

    canvasPresent.value = true;
    render(<Terminal {...baseProps} agentId="working" active />); // counter-evidence

    canvasPresent.value = false;
    render(<Terminal {...baseProps} agentId="blip-2" active />);

    // Two distinct agents failed, but not consecutively — still disarmed.
    expect(isWebglCanvasUnfindable()).toBe(false);
  });

  it("never arms on the HEALTHY paths — hide, unmount and context-loss all route through teardown", () => {
    // teardownWebgl is shared by hide / unmount / context-loss. An over-eager latch set anywhere in
    // it would permanently disable WebGL for the session, and every other test in this file resets
    // the latch in beforeEach, so nothing else here would notice.
    const { rerender, unmount } = render(<Terminal {...baseProps} agentId="a" active />);
    rerender(<Terminal {...baseProps} agentId="a" active={false} />); // hide
    rerender(<Terminal {...baseProps} agentId="a" active />); // show
    lostListeners.forEach((fn) => fn()); // context loss
    unmount(); // unmount
    expect(isWebglCanvasUnfindable()).toBe(false);

    // And WebGL is still attempted for the next pane.
    addonCtors.count = 0;
    render(<Terminal {...baseProps} agentId="next" active />);
    expect(addonCtors.count).toBe(1);
  });
});
