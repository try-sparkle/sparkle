// @vitest-environment jsdom
//
// WHAT ONE REVEAL COSTS THE OTHER FIFTY-NINE ROWS — counted.
//
// `revealAgentId` and `revealAnchorY` are SCALARS, and every row used to subscribe to both. A
// scalar selector produces a new value for EVERY subscriber the moment it is written, so a single
// reveal re-rendered the whole column — twice, because the row that consumes the request writes it
// straight back to null (`clearRevealAgent`). On the founder's 60-agent fleet that is 120 renders
// of a ~2,200-line row body to scroll one row into view.
//
// `AgentRow` is `memo`'d behind a good comparator, and that is exactly why this was invisible: the
// comparator guards PROPS, and these were never props. A store subscription inside the row goes
// around it.
//
// ── HOW A ROW RENDER IS COUNTED ─────────────────────────────────────────────────────────────────
// `AgentRow` is declared inside `AgentSidebar.tsx`, so it cannot be mocked on its own. It calls
// `rowBoxFor` from the leaf `./rowAnatomy` module exactly once per render, unconditionally, near
// the end of its body — so the REAL function, wrapped in a counter, is a faithful per-row render
// tally. The other two callers of `rowBoxFor` (the Sparkle row, `PersonRow`) are distinguishable by
// their arguments: only `AgentRow` passes `depthIndent`.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));

const rowRenders = vi.hoisted(() => ({ n: 0 }));

vi.mock("./rowAnatomy", async (orig) => {
  const actual = await orig<typeof import("./rowAnatomy")>();
  return {
    ...actual,
    // The REAL implementation, counted. A stub would change the geometry every row paints with and
    // would measure a different component than the one that ships.
    rowBoxFor: (opts: Parameters<typeof actual.rowBoxFor>[0]) => {
      if ("depthIndent" in opts) rowRenders.n += 1;
      return actual.rowBoxFor(opts);
    },
  };
});

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";

const FLEET = 60;
/** The row the reveal names — mid-column, so nothing about the answer is an edge effect. */
const TARGET = "a30";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function seedFleet(n = FLEET): Project {
  const ids = Array.from({ length: n }, (_, i) => `a${i}`);
  const project: Project = {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: ids.map((id, i) => mkAgent(id, `Agent ${i}`)),
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    status: Object.fromEntries(ids.map((id) => [id, "working"])),
    branchStatus: {},
    workflowState: {},
    workflowStage: {},
    workflowShipped: {},
    openAgentIds: ids,
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

let scrolled: Element[];

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
    revealAgentId: null,
    revealAnchorY: null,
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  scrolled = [];
  // jsdom does not implement scrollIntoView at all — which is why production calls it optionally.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      scrolled.push(this);
    },
  });
  rowRenders.n = 0;
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("a reveal costs the column two row renders, not a hundred and twenty", () => {
  it("re-renders only the row being revealed", () => {
    render(<AgentSidebar project={seedFleet()} />);
    // Everything up to here is mount cost; the measurement is the delta across the reveal.
    const afterMount = rowRenders.n;

    act(() => useUiStore.getState().requestRevealAgent(TARGET));
    const cost = rowRenders.n - afterMount;

    console.log(`[revealRenderCost] row renders caused by one reveal of ${FLEET} rows: ${cost}`);

    // TWO: the target row when `revealMe` goes true, and the target row again when its own effect
    // clears the request and `revealMe` goes back to false. The other 59 rows see no change in the
    // boolean they subscribe to, so they are not re-rendered at all.
    //
    // Against the previous code — two scalar subscriptions per row — this read 120.
    expect(cost).toBe(2);
    // Belt and braces on the "only that row" half, in a form that survives the count changing:
    // fewer renders than there are rows means at minimum the whole column did not move.
    expect(cost).toBeLessThan(FLEET);
  });

  it("STILL REVEALS THE ROW — the request is consumed and the right element scrolls", () => {
    // THE PAIRED TEST. A row that ignored the request entirely would score ZERO renders and pass
    // every bound above while deleting the feature. What makes the cheap number meaningful is that
    // the work still happens.
    render(<AgentSidebar project={seedFleet()} />);
    act(() => useUiStore.getState().requestRevealAgent(TARGET));

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toBe(screen.getByText("Agent 30").closest('[data-hint="agent"]'));
    // One-shot: consumed, so a later remount cannot yank the column again.
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("still responds to a SECOND reveal of the same row", () => {
    // The narrowed subscription is an equality against `a.id`, so the edge it reacts to is
    // false→true. A row that consumed one request must be able to consume the next one for the same
    // id — otherwise clicking the same agent pill twice would work exactly once.
    render(<AgentSidebar project={seedFleet()} />);
    act(() => useUiStore.getState().requestRevealAgent(TARGET));
    expect(scrolled).toHaveLength(1);

    act(() => useUiStore.getState().requestRevealAgent(TARGET));
    expect(scrolled).toHaveLength(2);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("reads the anchor that travelled with THIS request, not a stale one", () => {
    // The anchor is no longer subscribed — it is read from the store inside the effect. That is only
    // sound if it is written in the same `set` as the id, so this pins the consequence: an anchored
    // request takes the anchored path (a direct scroll-offset write) and NOT the `scrollIntoView`
    // fallback, and the offset is computed from the anchor this request carried.
    const tops = new WeakMap<Element, number>();
    const writes: number[] = [];
    const patched = ["scrollTop", "scrollHeight", "clientHeight", "getBoundingClientRect"] as const;
    const originals = new Map(
      patched.map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const),
    );
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
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
          ? ({ top: 900, height: 40 } as DOMRect)
          : ({ top: 100, height: 600 } as DOMRect);
      },
    });
    try {
      render(<AgentSidebar project={seedFleet()} />);
      act(() => useUiStore.getState().requestRevealAgent(TARGET, { anchorY: 300 }));
      // [1, 0] is abandonReveal's perturbation-and-restore; 620 is the anchored scroll (row centre
      // 920 brought to the cursor at 300). A dropped anchor would take the fallback instead.
      expect(writes).toEqual([1, 0, 620]);
      expect(scrolled).toHaveLength(0);
    } finally {
      for (const k of patched) {
        const original = originals.get(k);
        if (original) Object.defineProperty(Element.prototype, k, original);
        else delete (Element.prototype as unknown as Record<string, unknown>)[k];
      }
    }
  });
});
