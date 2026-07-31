// @vitest-environment jsdom
//
// WHAT A RESIZE COSTS ACROSS SIXTY PANES, COUNTED — the terminal-side companion to
// `Workspace.renderCost.test.tsx`.
//
// That file bounds the REACT work a drag provokes (pane renders, pane reconciliation). It cannot see
// this one: it stubs `AgentPane` out entirely, so no xterm ever mounts under it, and jsdom has no
// layout engine — a pointer drag there moves a number in a store and never changes an element's box,
// so no ResizeObserver would fire even if a real pane were mounted. The fan-out this file measures is
// therefore driven the only honest way it can be: sixty real `Terminal`s, and the observer callbacks
// fired directly, once per step of the same 30-step drag shape.
//
// WHY THE BOUND IS A NUMBER RATHER THAN A VIBE. From one day of a real session's log (bead
// sparkle-atp1), one `terminal-resize` span per pane:
//
//     43 panes → 167ms mean/pane → ~7.2s per fan-out
//     55 panes → 499ms mean/pane → ~27.4s per fan-out
//     1,245 spans, 299 SECONDS of main-thread block, in ~29 fan-outs
//
// and the worst watchdog wedge of that day — 59.5s — contained 106 of these spans summing 52.9s.
// At most two panes (one per pair) are ever on screen, so ~52 of every 54 of those reflows were work
// nobody could see.
//
// THE ASSERTION IS THE SIDE EFFECT, NOT THE PRECONDITION. "The observer fired" and "the pane still
// exists" were both already true before the fix and prove nothing. What these tests assert is that
// `term.resize()` — the call fit() makes, and the one that re-wraps the 8000-line scrollback — is NOT
// reached for a hidden pane, and IS reached for it on reveal. Against the pre-fix code the headline
// bound below reads 60, not 1.
//
// jsdom cannot verify the milliseconds; it can only pin which panes do the expensive call. Real-app
// measurement of the ms is a separate job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// ── The instrument ─────────────────────────────────────────────────────────────────────────────
// Every mocked xterm gets a serial id; `fullFits` records the id of each terminal whose buffer was
// actually re-wrapped (fit() → term.resize()), and `proposals` records each cheap measurement-only
// read. Counting DISTINCT ids is what turns "how many calls" into "how many PANES paid", which is the
// quantity the log above is denominated in.
const { fullFits, proposals, ros, widthCtl, propose, termSize, ptyPushes, spawnPushes } = vi.hoisted(() => ({
  fullFits: [] as number[],
  proposals: [] as number[],
  ros: [] as Array<() => void>,
  widthCtl: { value: 720 },
  // The size proposeDimensions()/fit() report. A test flips this to model the box actually changing.
  propose: { cols: 100, rows: 30 },
  // The live xterm dimensions, and every size ever pushed to the child PAIRED with what xterm was
  // sized to at that instant. That pairing is the whole point: the invariant under test is that the
  // two never disagree, and a spy that recorded only the push could not see a disagreement at all.
  // Single-terminal tests only — with sixty panes mounted this is whichever one resized last.
  termSize: { cols: 80, rows: 24 },
  ptyPushes: [] as Array<{ pty: { cols: number; rows: number }; term: { cols: number; rows: number } }>,
  // The size the CHILD was spawned with, paired the same way. Kept apart from ptyPushes because it
  // happens during mount — `settleMount` clears ptyPushes, so a spawn-time disagreement recorded
  // there would be thrown away before any assertion could see it (roborev 56083).
  spawnPushes: [] as Array<{ pty: { cols: number; rows: number }; term: { cols: number; rows: number } }>,
}));

vi.mock("@xterm/xterm", () => {
  let nextId = 1;
  class Terminal {
    id = nextId++;
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    loadAddon(addon: { activate?: (t: unknown) => void }): void {
      // xterm calls activate() on load; the FitAddon mock needs the terminal it belongs to so a
      // fit can be attributed to a specific PANE rather than counted in the aggregate.
      addon.activate?.(this);
    }
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { get: () => widthCtl.value, configurable: true });
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
    }
    // THE EXPENSIVE CALL. In the real xterm this re-wraps the whole 8000-line scrollback when the
    // column count changes; here it just names the pane that paid for it.
    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
      termSize.cols = cols;
      termSize.rows = rows;
      fullFits.push(this.id);
    }
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    refresh(): void {}
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

vi.mock("@xterm/addon-fit", () => ({
  // Models the real FitAddon faithfully in the one respect this file measures: proposeDimensions()
  // only MEASURES, while fit() goes on to call term.resize() — the reflow — when the size differs.
  FitAddon: class {
    private term: { id: number; cols: number; rows: number; resize(c: number, r: number): void } | null =
      null;
    activate(term: never): void {
      this.term = term;
    }
    proposeDimensions(): { cols: number; rows: number } | undefined {
      if (this.term) proposals.push(this.term.id);
      // The real FitAddon returns undefined for a 0-dimension box — and fit() then no-ops, leaving
      // xterm at its constructed size. That is precisely the case the spawn fallback diverges in,
      // so a mock that always proposed a plausible size could never exercise it.
      if (widthCtl.value <= 0) return undefined;
      return { ...propose };
    }
    fit(): void {
      const dims = this.proposeDimensions();
      if (!this.term || !dims) return;
      if (this.term.cols === dims.cols && this.term.rows === dims.rows) return;
      this.term.resize(dims.cols, dims.rows);
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_handler: unknown) {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

vi.mock("../pty", () => ({
  spawnPty: vi.fn((opts: { cols: number; rows: number }) => {
    spawnPushes.push({ pty: { cols: opts.cols, rows: opts.rows }, term: { ...termSize } });
    return Promise.resolve();
  }),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn((_id: string, cols: number, rows: number) => {
    ptyPushes.push({ pty: { cols, rows }, term: { ...termSize } });
    return Promise.resolve();
  }),
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

// perfSpan is spied CALLING THROUGH — a stub that dropped `fn()` would disable the very work these
// tests count and every bound would pass for the wrong reason.
const { spans } = vi.hoisted(() => ({ spans: [] as Array<{ name: string; meta?: unknown }> }));
vi.mock("../perfTrace", async (orig) => ({
  ...(await orig<typeof import("../perfTrace")>()),
  perfSpan: (name: string, fn: () => unknown, meta?: unknown) => {
    spans.push({ name, meta });
    return fn();
  },
}));

import { Terminal } from "./Terminal";
import { resizePty } from "../pty";

const PANES = 60;
const DRAG_STEPS = 30;

const baseProps = {
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  onStatus: () => {},
};

/** rAF is driven by hand: the coalescing this file measures is defined in terms of frames, so a
 *  stub that ran callbacks synchronously would erase the very behaviour under test. */
let rafQueue: FrameRequestCallback[] = [];
const flushFrames = () => {
  // Drain iteratively — a callback may schedule another frame.
  for (let guard = 0; guard < 10 && rafQueue.length; guard++) {
    const due = rafQueue;
    rafQueue = [];
    for (const cb of due) cb(0);
  }
};

beforeEach(() => {
  fullFits.length = 0;
  proposals.length = 0;
  ptyPushes.length = 0;
  spawnPushes.length = 0;
  ros.length = 0;
  spans.length = 0;
  termSize.cols = 80;
  termSize.rows = 24;
  rafQueue = [];
  widthCtl.value = 720;
  propose.cols = 100;
  propose.rows = 30;
  vi.mocked(resizePty).mockClear();
  // jsdom has no ResizeObserver. This one keeps every live callback so a test can fire the whole
  // fan-out the way one layout change does in the app.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {
        ros.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        const i = ros.indexOf(this.cb);
        if (i >= 0) ros.splice(i, 1);
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
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

/** A cockpit: `panes` terminals, exactly `visible` of them on screen — the real ratio, where at most
 *  one pane per pair is ever painted. */
function Cockpit({ panes, visible }: { panes: number; visible: number }) {
  return (
    <>
      {Array.from({ length: panes }, (_, i) => (
        <Terminal key={`a${i}`} {...baseProps} agentId={`a${i}`} active={i < visible} />
      ))}
    </>
  );
}

/** Let mount finish before any counter is read. The spawn chain is ASYNC (`await transport.spawn`)
 *  and does its OWN fit once the PTY exists, so a counter cleared straight after `render()` still
 *  catches that fit a microtask later and bills it to the drag. Draining frames alone is not enough
 *  — the awaits have to run too. */
async function settleMount() {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      flushFrames();
      await Promise.resolve();
    }
  });
  fullFits.length = 0;
  proposals.length = 0;
  ptyPushes.length = 0;
  vi.mocked(resizePty).mockClear();
  spans.length = 0;
}

/** One layout change: tick every mounted pane's observer, then let the frame run. */
function fanOut() {
  act(() => {
    for (const cb of [...ros]) cb();
    flushFrames();
  });
}

/** The same 30-step shape `Workspace.renderCost.test.tsx` drives: a drag is not one event. */
function dragFanOut(steps = DRAG_STEPS) {
  for (let i = 0; i < steps; i++) fanOut();
}

const distinct = (ids: number[]) => new Set(ids).size;

describe("resize fan-out across a 60-pane cockpit", () => {
  it("mounts 60 panes with one on screen — the precondition, stated so it cannot pass as the result", () => {
    render(<Cockpit panes={PANES} visible={1} />);
    // One observer per mounted Terminal. A suite that silently mounted zero panes would report
    // "0 reflows" and pass forever.
    expect(ros).toHaveLength(PANES);
  });

  it("a 30-step drag reflows AT MOST 2 panes, not 60 — the measurement", async () => {
    render(<Cockpit panes={PANES} visible={1} />);
    await settleMount(); // so the counts below are the drag's alone, not the mount's

    // Model the boxes actually changing: without a size change fit() early-returns and every pane
    // would look cheap for the wrong reason.
    propose.cols = 140;
    dragFanOut();

    // THE BOUND. Two, because a five-column cockpit paints one pane per pair — never sixty.
    // Against the pre-gate code this is 60: every pane ran fit() → term.resize() on every tick.
    expect(distinct(fullFits)).toBeLessThanOrEqual(2);
    // …and the drag really happened, so the bound above is a skip and not a no-op: the pane that IS
    // on screen went all the way through. A zero here would satisfy the bound with a dead observer.
    expect(distinct(fullFits)).toBeGreaterThanOrEqual(1);
  });

  it("the ON-SCREEN pane still reflows — the inverse, without which the bound above is a dead feature", async () => {
    render(<Cockpit panes={PANES} visible={1} />);
    await settleMount();

    propose.cols = 140;
    fanOut();

    // Exactly one pane paid, and it is the visible one. If this ever goes to zero the gate has
    // stopped resizing anything and the bound above would still be green.
    expect(distinct(fullFits)).toBe(1);
  });

  it("a hidden pane does NOTHING — no reflow, and no PTY resize either", async () => {
    // WHY THE PTY PUSH IS DEFERRED TOO (roborev 56073 caught the first version keeping it live).
    // A hidden pane keeps ingesting output — the onOutput handler writes to the buffer with no
    // visibility gate — so telling the child a width xterm is not sized to makes a TUI emit box
    // drawing and absolute cursor addressing for one grid into another. Those rows are baked in as
    // they are written, and the reveal's fit() only rejoins soft-wrapped lines; it cannot re-place
    // escape sequences that already landed. That damage is permanent in scrollback.
    render(<Terminal {...baseProps} agentId="hidden" active={false} />);
    await settleMount();

    propose.cols = 140;
    fanOut();

    expect(fullFits).toHaveLength(0); // no buffer reflow off screen
    expect(resizePty).not.toHaveBeenCalled(); // …and the child is not told a width xterm lacks
  });

  it("does not diverge AT SPAWN either, when the box is unmeasured and the pane stays hidden", async () => {
    // The hole the drag test above could not see (roborev 56083). With an unmeasured container
    // fit() no-ops — xterm stays at its constructed 80x24 — while spawnSize DELIBERATELY hands the
    // child the 120x30 fallback so the CLI never starts life wrapping into a thin column. That is a
    // 40-column disagreement, and the ResizeObserver tick that used to heal it does nothing for a
    // hidden pane now. Output keeps arriving the whole time, so the mismatch bakes mis-positioned
    // rows into scrollback — the same damage the deferral exists to prevent, seeded at spawn.
    widthCtl.value = 0; // unmeasured box: fit() cannot propose anything
    render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    // The pane never becomes visible; a drag ticks its observer regardless.
    propose.cols = 140;
    dragFanOut();

    expect(spawnPushes).toHaveLength(1); // the child really was spawned
    // …at a size xterm agrees with. Pre-fix this is { cols: 120 } vs { cols: 80 }.
    expect(spawnPushes[0]!.pty).toEqual(spawnPushes[0]!.term);
    // And nothing since has moved either side independently.
    for (const { pty, term } of ptyPushes) expect(pty).toEqual(term);
  });

  it("NEVER lets the child's width and xterm's width diverge, across a whole drag", async () => {
    // THE INVARIANT, asserted directly rather than inferred from call counts: every size the child is
    // ever told must equal what xterm is sized to at that instant. This is what makes the deferral
    // above safe, and it is the assertion that would catch a future "just keep the PTY current"
    // optimization reintroducing the mismatch.
    const { rerender } = render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    // Hidden through a full drag, then revealed, then dragged again while visible.
    propose.cols = 140;
    dragFanOut();
    rerender(<Terminal {...baseProps} agentId="a0" active={true} />);
    act(() => flushFrames());
    propose.cols = 92;
    dragFanOut();

    // The drag actually pushed sizes — otherwise "they never disagreed" is vacuously true.
    expect(ptyPushes.length).toBeGreaterThan(0);
    for (const { pty, term } of ptyPushes) expect(pty).toEqual(term);
  });

  // ── The residual v0.68.0 cost: syncing a size the child ALREADY HAS ────────────────────────────
  // The fan-out gate above cut the drag from ~60 panes to ≤2, which is what made resizing usable.
  // What was left was measured on a real v0.68.0 build and is a different bug: `terminal-resize` was
  // 536ms of which `terminal-resize.syncPty` was 534ms, while `.fit` and `.repaint` never once
  // cleared the 16ms span floor across the WHOLE log. That combination pins the cause exactly —
  // fit() ran and early-returned, so the proposed cols/rows had NOT changed, and syncPtySize then
  // forced a layout read and fired a `pty_resize` IPC telling the child a size it already had. Every
  // frame. A divider drag moves the box a few pixels at a time, which is far less than one cell, so
  // this was the common case rather than an edge one.
  it("a drag that does NOT change the cell count pushes NOTHING to the child — the v0.68.0 latency", async () => {
    render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    // `propose` is deliberately LEFT ALONE: the box moves, the cell count does not. This is the case
    // every other test in this file steps around by flipping propose.cols first.
    dragFanOut();

    // THE ASSERTION — the side effect, not the precondition. Against the pre-fix code this is 30:
    // one redundant IPC per frame, each of which cost 330-536ms in the field.
    expect(resizePty).not.toHaveBeenCalled();
    // …and the drag was real: fit() was asked to measure on every step, it just had nothing to do.
    // Without this a suite that mounted a dead pane would satisfy the line above forever.
    expect(proposals.length).toBeGreaterThanOrEqual(DRAG_STEPS);
    // No reflow either, for the same reason — so the skip above is not hiding a resize that happened.
    expect(fullFits).toHaveLength(0);
  });

  it("…but a drag that DOES change the cell count still pushes — the inverse", async () => {
    // Without this, "we stopped telling the child anything" would pass the test above with flying
    // colours. The memo must suppress only the redundant push, never a real one.
    render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    propose.cols = 140;
    fanOut();

    expect(resizePty).toHaveBeenCalled();
    expect(ptyPushes.at(-1)?.pty).toEqual({ cols: 140, rows: 30 });
    // And it is pushed exactly ONCE for the one size change, not once per frame.
    vi.mocked(resizePty).mockClear();
    dragFanOut();
    expect(resizePty).not.toHaveBeenCalled();
  });

  it("still tracks a size that changes on EVERY step — the memo is per-size, not a one-shot latch", async () => {
    // A latch that fired once and then went quiet would pass both rows above. Drive a drag where the
    // cell count genuinely moves each step and require the child to be told each time.
    render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    for (let i = 0; i < 5; i++) {
      propose.cols = 110 + i * 7;
      fanOut();
    }

    expect(vi.mocked(resizePty).mock.calls).toHaveLength(5);
    expect(ptyPushes.at(-1)?.pty).toEqual({ cols: 138, rows: 30 });
    // The invariant this file exists to protect still holds on every one of them.
    for (const { pty, term } of ptyPushes) expect(pty).toEqual(term);
  });

  it("pays the deferred reflow ON REVEAL — the work the hidden pane skipped is not lost", async () => {
    // The other half of the gate, and the assertion that keeps it from being "we stopped resizing".
    const { rerender } = render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    propose.cols = 140;
    fanOut(); // resized while hidden → skipped, debt recorded
    expect(fullFits).toHaveLength(0);

    rerender(<Terminal {...baseProps} agentId="a0" active={true} />);
    act(() => flushFrames());

    // The reflow the hidden resize deferred lands here, on the one pane now being looked at.
    expect(fullFits.length).toBeGreaterThanOrEqual(1);
    // …and the reveal reports that it WAS a deferred one, which is the field that keeps the fix from
    // moving cost between spans invisibly.
    const revealFit = spans.filter((s) => s.name === "Terminal.revealFit");
    expect(revealFit.at(-1)?.meta).toMatchObject({ deferredResize: true });
  });

  it("a reveal with no pending resize is NOT reported as deferred", async () => {
    // The inverse of the field above: if it were hardcoded true it would be worthless as a signal.
    const { rerender } = render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    rerender(<Terminal {...baseProps} agentId="a0" active={true} />);
    act(() => flushFrames());

    const revealFit = spans.filter((s) => s.name === "Terminal.revealFit");
    expect(revealFit.at(-1)?.meta).toMatchObject({ deferredResize: false });
  });

  it("CONSUMES the debt: a second reveal with no resize in between is no longer deferred", async () => {
    // The row above cannot see this, and a hand-mutation proved it: commenting out the line that
    // CLEARS the flag left every test green, because nothing ever revealed a pane twice. A debt that
    // is recorded and never discharged reports every later reveal as a deferred reflow, which is
    // exactly the kind of instrument that reads plausible and measures nothing.
    const { rerender } = render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    propose.cols = 140;
    fanOut(); // resized while hidden → debt recorded

    rerender(<Terminal {...baseProps} agentId="a0" active={true} />); // reveal #1 pays it
    act(() => flushFrames());
    expect(spans.filter((s) => s.name === "Terminal.revealFit").at(-1)?.meta).toMatchObject({
      deferredResize: true,
    });

    rerender(<Terminal {...baseProps} agentId="a0" active={false} />); // hide again…
    act(() => flushFrames());
    rerender(<Terminal {...baseProps} agentId="a0" active={true} />); // …and reveal, with NO resize
    act(() => flushFrames());

    // Nothing was deferred this time, so nothing may be reported as deferred.
    expect(spans.filter((s) => s.name === "Terminal.revealFit").at(-1)?.meta).toMatchObject({
      deferredResize: false,
    });
  });

  it("coalesces many observer ticks in ONE frame into ONE pass per pane", async () => {
    // A pointer drag emits dozens of events per second and a single layout change can tick an
    // observer more than once. Without the rAF dedupe each tick paid its own pass.
    render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    act(() => {
      for (let i = 0; i < DRAG_STEPS; i++) for (const cb of [...ros]) cb();
      flushFrames(); // one frame for thirty ticks
    });

    // One pass — one measurement — for the whole burst. Pre-coalesce this was 30.
    expect(proposals).toHaveLength(1);
  });

  it("decomposes the resize into fit / syncPty / repaint spans, inside the original one", async () => {
    // STEP 0 of the fix, pinned: "167ms per pane" could not say whether the time went to the forced
    // layout, the PTY round-trip or the GPU upload. The outer name is kept so the historical samples
    // stay comparable; the inner three are what make the next measurement answerable.
    render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    propose.cols = 140;
    fanOut();

    const names = spans.map((s) => s.name);
    expect(names).toContain("terminal-resize");
    expect(names).toContain("terminal-resize.fit");
    expect(names).toContain("terminal-resize.syncPty");
    expect(names).toContain("terminal-resize.repaint");
    // Every one of them carries the fan-out width — the field that says whether a slow resize is an
    // O(1) or an O(N) problem.
    for (const s of spans.filter((x) => x.name.startsWith("terminal-resize"))) {
      expect(s.meta).toMatchObject({ panes: expect.any(Number) });
    }
  });

  it("an off-screen pane emits the outer span only — never the fit/syncPty/repaint ones", async () => {
    render(<Terminal {...baseProps} agentId="a0" active={false} />);
    await settleMount();

    propose.cols = 140;
    fanOut();

    const names = spans.map((s) => s.name);
    // The outer span still fires, so the fan-out stays countable in the log — it is just cheap now.
    expect(names).toContain("terminal-resize");
    expect(names).not.toContain("terminal-resize.fit");
    expect(names).not.toContain("terminal-resize.syncPty");
    expect(names).not.toContain("terminal-resize.repaint");
  });

  it("a queued frame never touches a terminal disposed in the meantime", async () => {
    // The coalesce moved the work a frame LATER than the tick that asked for it, so the `disposed`
    // bail that used to sit in the observer body has to survive that hop — the #231/#258 class of
    // bug (a paint reaching a freed renderer) is exactly what a naive rAF would reintroduce.
    const { unmount } = render(<Terminal {...baseProps} agentId="a0" active={true} />);
    await settleMount();

    propose.cols = 140;
    act(() => {
      for (const cb of [...ros]) cb(); // tick queued…
    });
    unmount(); // …pane torn down before the frame runs
    act(() => flushFrames());

    expect(fullFits).toHaveLength(0);
    expect(proposals).toHaveLength(0);
    expect(resizePty).not.toHaveBeenCalled();
  });
});
