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
  useUiStore.setState({ workMode: "build", revealAgentId: null });
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
