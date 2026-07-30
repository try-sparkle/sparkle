// @vitest-environment jsdom
//
// §13, sidebar half: the row named by uiStore.revealAgentId scrolls itself into view (the house
// `scrollIntoView({ block: "nearest" })` pattern, see PinnedPrompt.tsx) and then CLEARS the
// request, so it is one-shot. Only the named row reacts — every other row leaves the column where
// the user put it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { REVEAL_REQUEST_TTL_MS, useUiStore } from "../stores/uiStore";
import type { Project, AgentTab } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: `/tmp/demo/.worktrees/${id}`,
    branch: `sparkle/agent-${id}`,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: { title: name, description: "" },
    shellCommand: null,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

// jsdom has no layout, so it does not implement scrollIntoView at all — install a spy that records
// BOTH the element it was called on and the options. (That absence is exactly why the production
// code calls it optionally.)
let scrolled: { el: Element; opts: unknown }[];

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" }, revealAgentId: null });
  scrolled = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element, opts: unknown) {
      scrolled.push({ el: this, opts });
    },
  });
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("AgentRow — reveal-on-request", () => {
  it("scrolls the requested row into view and clears the one-shot request", () => {
    useUiStore.setState({ revealAgentId: "a2" });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.opts).toEqual({ block: "nearest" });
    // The REQUESTED row is the one that scrolled, not just any row.
    expect(scrolled[0]!.el).toBe(screen.getByText("Second").closest('[data-hint="agent"]'));
    // One-shot: consumed, so a later remount can't yank the column again.
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("does nothing when no reveal is pending", () => {
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(scrolled).toHaveLength(0);
  });

  it("ignores a request that names an agent this list doesn't have", () => {
    useUiStore.setState({ revealAgentId: "ghost" });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First")])} />);
    expect(scrolled).toHaveLength(0);
    // Left pending FOR NOW: the row may simply not have mounted yet (a filtered band, a collapsed
    // parent). It does not stay pending forever — see the expiry block below.
    expect(useUiStore.getState().revealAgentId).toBe("ghost");
  });
});

// THE ORDERING CONTRACT (roborev 53907/53929/53940). The reveal must call `abandonReveal(true)`
// BEFORE it scrolls: it drives the same container the hover coordinator does, and an ease-back —
// pending or already animating — would otherwise drag the column straight back and undo the reveal.
// Calling it afterwards would race the animation instead of preventing it.
//
// Observed through the REAL coordinator rather than a stub api: `AgentSidebar` renders its own
// `SidebarScrollContext.Provider` internally, so a provider wrapped around it never reaches the
// rows. That is the better test anyway — `abandonReveal(true)`'s defining action IS the direct
// scroll-offset write that aborts an in-flight smooth scroll, so watching for the write proves the
// abort happens rather than that a spy was called.
//
// The write is a PERTURBATION (`here ± 1`, then `here`), because writing the identical value back
// can be elided by the engine's zero-delta early return. Hence two writes, ending where it started.
//
// What this file still cannot pin: the visual outcome. That needs layout jsdom does not have.
describe("AgentRow — reveal abandons the ease-back BEFORE it scrolls", () => {
  const realScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");

  /** Scroll-offset writes and scrollIntoView land in ONE log, so ORDER is visible, not just count. */
  function renderLoggingScrollOps(agents: AgentTab[]) {
    const calls: string[] = [];
    const tops = new WeakMap<Element, number>();
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        calls.push("abandon");
        tops.set(this, v);
      },
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        calls.push("scroll");
      },
    });
    render(<AgentSidebar project={mkProject(agents)} />);
    return calls;
  }

  afterEach(() => {
    if (realScrollTop) Object.defineProperty(Element.prototype, "scrollTop", realScrollTop);
  });

  it("abandons, THEN scrolls, for the requested row", () => {
    useUiStore.setState({ revealAgentId: "a2" });
    const calls = renderLoggingScrollOps([mkAgent("a1", "First"), mkAgent("a2", "Second")]);
    // Two abandon writes (the perturbation and the restore), then the scroll. Deleting the
    // abandonReveal call drops them; moving it below scrollIntoView reorders them; passing `false`
    // instead of `true` drops them too.
    expect(calls).toEqual(["abandon", "abandon", "scroll"]);
  });

  it("does neither for a row nobody asked for", () => {
    const calls = renderLoggingScrollOps([mkAgent("a1", "First"), mkAgent("a2", "Second")]);
    expect(calls).toEqual([]);
  });

  // NOT PINNED HERE, and worth knowing: the OTHER side of the same parameter. The hover card's
  // user-scroll handler calls `abandonReveal()` WITHOUT the abort, because it runs from inside a
  // live user gesture and writing the scroll offset there cancels trackpad momentum. Changing that
  // call site to pass `true` is a one-character regression no test in this suite catches.
  //
  // Reaching it needs the hover card actually OPEN, and the card opens from a strip inside the
  // overlay via a delayed `armSelect`, not from the `data-hint="agent"` wrapper — so driving it
  // means timers plus the overlay's own render path. The explicit parameter and the api's doc
  // comment are what guard this direction today; the reveal direction above is fully pinned.
});

// THE DELAYED-FIRING CASE (roborev 53784). The row that clears the request is not guaranteed to
// mount: the status filter bar can hide the new agent's band, `mode === "plan"` renders no list at
// all, and the project can be switched or closed. The policy chosen for that is an EXPIRY on the
// request itself (uiStore REVEAL_REQUEST_TTL_MS) — one mechanism covering every escape hatch —
// rather than teaching the store about removals, project lifecycle and selection. These pin it from
// the consumer's side: within the window the reveal still works; past it, re-showing the row is
// silent.
describe("AgentRow — a reveal request does not outlive its window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("still reveals a row that mounts LATE but inside the window", () => {
    act(() => useUiStore.getState().requestRevealAgent("a2"));
    // The band is hidden, so only a1 is on screen and nothing consumes the request.
    const { rerender } = render(<AgentSidebar project={mkProject([mkAgent("a1", "First")])} />);
    expect(scrolled).toHaveLength(0);

    act(() => void vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS - 100));
    // Band re-enabled just inside the window: the user is still in the moment they spawned it.
    rerender(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(scrolled).toHaveLength(1);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("does NOT yank the column when the band is re-enabled after the request expired", () => {
    // The regression: without an expiry this scroll fired minutes later, when the user re-enabled a
    // filter band or flipped back to Build, moving their column to a row they never asked to see.
    act(() => useUiStore.getState().requestRevealAgent("a2"));
    const { rerender } = render(<AgentSidebar project={mkProject([mkAgent("a1", "First")])} />);

    act(() => void vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS));
    expect(useUiStore.getState().revealAgentId).toBeNull();

    rerender(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(scrolled).toHaveLength(0);
  });
});

// ── THE ANCHORED REVEAL ─────────────────────────────────────────────────────────────────────────
// A reveal that carries `revealAnchorY` brings the row to the READER'S CURSOR instead of asking
// `scrollIntoView` to get it on screen somewhere. The founder's report: clicking an agent pill lands
// on the right agent, but the builder column runs well past a screenful, so the row that answered
// ends up anywhere in it — or off it — and has to be hunted for. `block: "nearest"` cannot help,
// because it does nothing at all when the row is already visible, however far from the eye.
//
// The ARITHMETIC lives in components/anchoredScroll and is tested against real numbers there (jsdom
// has no layout, so it is the only place it CAN be tested honestly). What these rows pin is the
// wiring: that the anchor is read, that the container's offset is actually written, that the
// `scrollIntoView` fallback is skipped, and that an un-anchored request still takes the old path.
describe("AgentRow — an anchored reveal lands the row at the cursor", () => {
  // SAVED AND RESTORED, never deleted. `scrollHeight`, `clientHeight` and `getBoundingClientRect`
  // are NATIVE jsdom prototype members: `delete`ing them in cleanup removes them from the
  // environment for the rest of the file rather than putting them back. Two ways that bites — this
  // block's `afterEach` runs BEFORE the file-level `cleanup()`, so React would unmount against a
  // prototype with no `getBoundingClientRect`; and any test added below would then run with the
  // production guard seeing `typeof … !== "function"` and quietly taking the un-anchored branch —
  // a test passing while exercising the opposite path, which is the vacuous shape this repo's
  // guidance calls its #1 finding (roborev 56060).
  const PATCHED = ["scrollTop", "scrollHeight", "clientHeight", "getBoundingClientRect"] as const;
  const originals = new Map(
    PATCHED.map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const),
  );

  /** Give jsdom the layout it does not have: a scrollable container and a row at a known height. */
  function withLayout(opts: {
    rowTop: number;
    rowHeight?: number;
    containerTop?: number;
    /** Seed the container's offset, so a clamp toward the TOP of the range is distinguishable from
     *  a no-op — at offset 0 both produce no write and the mutation survives. */
    initialScrollTop?: number;
  }) {
    const writes: number[] = [];
    const tops = new WeakMap<Element, number>();
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? opts.initialScrollTop ?? 0;
      },
      set(this: Element, v: number) {
        writes.push(v);
        tops.set(this, v);
      },
    });
    // 2000 of content in a 600 viewport → 1400 of scroll range to work with.
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 600 });
    // The ROW and the CONTAINER must measure DIFFERENTLY, or the container's visible band collapses
    // onto the row's own position and the band clamp becomes untestable (it would always be
    // satisfied). Rows are the `data-hint="agent"` wrappers; everything else answers as the
    // container, whose band here is viewport y 100–700.
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        return this.closest?.('[data-hint="agent"]') === this
          ? ({ top: opts.rowTop, height: opts.rowHeight ?? 40 } as DOMRect)
          : ({ top: opts.containerTop ?? 100, height: 600 } as DOMRect);
      },
    });
    return writes;
  }

  afterEach(() => {
    for (const k of PATCHED) {
      const original = originals.get(k);
      if (original) Object.defineProperty(Element.prototype, k, original);
      else delete (Element.prototype as unknown as Record<string, unknown>)[k];
    }
  });

  it("scrolls the container so the row's centre reaches the anchor", () => {
    // Row centre 920 (top 900 + half of 40), cursor at 300 → the content moves up by 620.
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 300 });
    const writes = withLayout({ rowTop: 900 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);

    // [1, 0] is abandonReveal's perturbation-and-restore; 620 is the anchored scroll itself.
    expect(writes).toEqual([1, 0, 620]);
    // And the fallback did NOT also run — a double scroll would fight itself.
    expect(scrolled).toHaveLength(0);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("clamps at the top of the range instead of overscrolling", () => {
    // Row already near the top, cursor near the BOTTOM OF THE BAND (690, inside 100–700): the move
    // it wants is impossible, so it goes as far as the range allows — which here is nowhere, since
    // the container is already at 0.
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 690 });
    const writes = withLayout({ rowTop: 20 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(writes).toEqual([1, 0]); // abandonReveal only — no anchored write
    // AND the fallback stayed off. Without this the row passes when the anchored branch is deleted
    // entirely, since "no anchored write" is equally true of code that never anchors: the anchored
    // path DECIDED not to move, which is a different fact from never having looked.
    expect(scrolled).toHaveLength(0);
  });

  it("does not move the column when the row is ALREADY at the cursor", () => {
    // Centre 320 against a cursor at 318: two pixels. Scrolling would shift every other row to fix
    // something the reader cannot see.
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 318 });
    const writes = withLayout({ rowTop: 300 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(writes).toEqual([1, 0]);
    expect(scrolled).toHaveLength(0);
  });

  it("falls back to scrollIntoView when the request carries NO anchor", () => {
    // A spawn, a concierge tool call, a keyboard activation: no cursor behind it, so the old
    // get-it-on-screen behaviour is still what these get.
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: null });
    const writes = withLayout({ rowTop: 900 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(writes).toEqual([1, 0]);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.opts).toEqual({ block: "nearest" });
  });

  it("anchors only the REQUESTED row, leaving the others alone", () => {
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 300 });
    const writes = withLayout({ rowTop: 900 });
    render(
      <AgentSidebar
        project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second"), mkAgent("a3", "Third")])}
      />,
    );
    // One anchored write, not one per row.
    expect(writes.filter((w) => w === 620)).toHaveLength(1);
  });
});

// ── THE COMPONENT FEEDS THE *CONTAINER'S* BAND, NOT THE ROW'S OR THE WINDOW'S ───────────────────
// The arithmetic is covered in anchoredScroll.test.ts, but that file cannot see WHICH values the
// component passes. Every other row here uses an anchor inside the band, so `containerTop: box.top`
// and `containerHeight: sc.clientHeight` both survived mutation — swap either for a plausible
// neighbour (`0`, `sc.scrollHeight`) and the suite stayed green while production lost a clamp
// (roborev 56063). These two rows put the anchor OUTSIDE the band in each direction, which is the
// only place those arguments are observable.
describe("AgentRow — the anchor is clamped by the container the row lives in", () => {
  const realScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const PATCHED = ["scrollTop", "scrollHeight", "clientHeight", "getBoundingClientRect"] as const;
  const originals = new Map(
    PATCHED.map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const),
  );
  afterEach(() => {
    for (const k of PATCHED) {
      const original = originals.get(k);
      if (original) Object.defineProperty(Element.prototype, k, original);
      else delete (Element.prototype as unknown as Record<string, unknown>)[k];
    }
    if (realScrollTop) Object.defineProperty(Element.prototype, "scrollTop", realScrollTop);
  });

  /** Same stubs as the describe above; duplicated rather than shared so neither block's cleanup can
   *  pull the prototype out from under the other. Band is viewport y 100–700 (clientHeight 600). */
  function withLayout(opts: { rowTop: number; initialScrollTop?: number }) {
    const writes: number[] = [];
    const tops = new WeakMap<Element, number>();
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? opts.initialScrollTop ?? 0;
      },
      set(this: Element, v: number) {
        writes.push(v);
        tops.set(this, v);
      },
    });
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        return this.closest?.('[data-hint="agent"]') === this
          ? ({ top: opts.rowTop, height: 40 } as DOMRect)
          : ({ top: 100, height: 600 } as DOMRect);
      },
    });
    return writes;
  }

  it("clamps an anchor ABOVE the list's top edge to the band, not to the raw click", () => {
    // The reported failure: a receipt pill clicked high in the transcript, above the builder
    // column's first visible pixel. Honoured literally the row parks in the clipped region.
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 20 });
    const writes = withLayout({ rowTop: 900 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    // Row centre 920, clamped anchor 120 (band top + half a row) → 800.
    // `containerTop: 0` would give band [20, 580], anchor 20, and a write of 900.
    expect(writes).toEqual([1, 0, 800]);
  });

  it("clamps an anchor BELOW the list's bottom edge to the band, not to the range floor", () => {
    // Seeded offset, because at 0 the correct answer and the mutant's both round to "no write".
    useUiStore.setState({ revealAgentId: "a2", revealAnchorY: 1500 });
    const writes = withLayout({ rowTop: 20, initialScrollTop: 700 });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    // Row centre 40, clamped anchor 680 (band bottom - half a row) → 700 - 640 = 60.
    // `containerHeight: sc.scrollHeight` would widen the band to [120, 2080], leave the anchor at
    // 1500, and drive the offset to the range floor of 0 instead.
    expect(writes).toEqual([699, 700, 60]);
  });
});
