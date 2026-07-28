// @vitest-environment jsdom
// Component coverage for the TopBar open-PR menu: render/hide by the null-vs-zero rule, the dropdown
// list, the per-PR + "merge all" merge paths, the check-status gate, and the "Open agent" hand-off.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => h.openUrl(u) }));

import { OpenPrMenu, agentLinkForBranch, type PrAgentLink } from "./OpenPrMenu";
import type { PrRow } from "../services/openPrs";
import type { AgentTab, Project } from "../types";

const PASS: PrRow = {
  number: 1,
  title: "fix: a thing",
  headRefName: "sparkle/agent-abc",
  url: "https://github.com/o/r/pull/1",
  checks: "passing",
  mergeable: "mergeable",
};
const FAILING: PrRow = {
  number: 2,
  title: "wip: broken",
  headRefName: "sparkle/agent-def",
  url: "https://github.com/o/r/pull/2",
  checks: "failing",
  mergeable: "mergeable",
};

/** Route `project_open_prs` to a canned list (or null), and record `merge_pr` calls. */
function stubList(rows: PrRow[] | null) {
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "project_open_prs") return Promise.resolve(rows);
    if (cmd === "merge_pr") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  h.invoke.mockReset();
  h.openUrl.mockReset();
});
afterEach(cleanup);

const noAgent = () => null;
const noop = () => {};

describe("OpenPrMenu", () => {
  it("renders the count when PRs are waiting", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    await waitFor(() =>
      expect(screen.getByTestId("open-pr-badge").textContent).toContain("2 PRs waiting"),
    );
  });

  it("renders NOTHING at a known-empty list, and NOTHING when the probe couldn't run", async () => {
    stubList([]);
    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();

    stubList(null);
    rerender(<OpenPrMenu rootPath="/repo2" resolveAgent={noAgent} onOpenAgent={noop} />);
    await waitFor(() => expect(screen.queryByTestId("open-pr-badge")).toBeNull());
  });

  it("opens the dropdown and lists each PR", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    expect(await screen.findByTestId("merge-1")).toBeTruthy();
    expect(screen.getByTestId("merge-2")).toBeTruthy();
  });

  it("gates merge on checks: a failing PR's Merge is disabled, a passing one's is enabled", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    expect((await screen.findByTestId("merge-1")).hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("merge-2").hasAttribute("disabled")).toBe(true);
  });

  it("merges a single PR through the Rust command", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("merge-1"));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("merge_pr", { root: "/repo", number: 1 }),
    );
  });

  it("'Merge all ready' merges only the eligible PRs, skipping the failing one", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("merge-all"));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("merge_pr", { root: "/repo", number: 1 }),
    );
    // The failing PR (#2) must never be merged by "merge all".
    expect(h.invoke).not.toHaveBeenCalledWith("merge_pr", { root: "/repo", number: 2 });
  });

  it("shows 'Open agent' only when a live agent matches the PR branch, and calls back on click", async () => {
    stubList([PASS]);
    const link: PrAgentLink = {
      agentId: "abc",
      agentName: "Fixer",
      projectId: "p1",
      isCurrentProject: true,
    };
    const resolve = (branch: string) => (branch === PASS.headRefName ? link : null);
    const onOpen = vi.fn();
    render(<OpenPrMenu rootPath="/repo" resolveAgent={resolve} onOpenAgent={onOpen} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("open-agent-1"));
    expect(onOpen).toHaveBeenCalledWith(link);
  });
});

/** The badge cluster's own geometry in the model below: flush right, 20px of chrome beyond it. */
const BADGE_RIGHT_INSET = 20;
const BADGE_WIDTH = 110;
/** The window's enforced floor (src-tauri/tauri.conf.json `minWidth`). The panel's containment
 *  guarantee is stated at this width, so the tests state it at this width too. */
const MIN_WINDOW_WIDTH = 900;

/** Split `340px, calc(100vw - 16px)` on TOP-LEVEL commas only, so a nested `min(...)` survives. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Resolve the small subset of CSS length syntax the panel uses — `min(a, b)`, `calc(100vw - Npx)`,
 * `Npx`, `100vw` — against a viewport width.
 *
 * jsdom computes no layout, so the model below has to do this itself. Doing it from the ELEMENT'S
 * OWN style string is the point (roborev 53787): the old stub hardcoded `Math.min(460, innerWidth
 * - 16)`, so deleting either clamp from the component failed no test at all. Returns null for
 * anything unrecognised — including an EMPTY string, i.e. a clamp that was removed — and the model
 * turns that into an unbounded width, which the containment assertions then catch.
 */
function cssLength(value: string, innerWidth: number): number | null {
  const v = value.trim();
  const min = /^min\((.*)\)$/.exec(v);
  if (min) {
    const parts = splitTopLevel(min[1]!).map((p) => cssLength(p, innerWidth));
    return parts.some((p) => p === null) ? null : Math.min(...(parts as number[]));
  }
  const calc = /^calc\(100vw\s*-\s*([\d.]+)px\)$/.exec(v);
  if (calc) return innerWidth - Number(calc[1]);
  const px = /^([\d.]+)px$/.exec(v);
  if (px) return Number(px[1]);
  if (v === "100vw") return innerWidth;
  return null;
}

/**
 * A deliberately small layout model for jsdom, which computes no geometry of its own. The badge sits
 * flush right in the tab bar; the panel hangs off whichever badge edge its own style anchors it to
 * (so a regression back to `left: 0` really does move the rect), at the width its OWN `min-width` /
 * `max-width` resolve to.
 *
 * `restore()` puts BOTH stubs back. It used to restore only `getBoundingClientRect`, leaving
 * `window.innerWidth` permanently redefined at 1200 — then 300 after the resize test — for every
 * later test in the file, while their rects fell back to jsdom's all-zero geometry (roborev 53787).
 */
function stubLayout(innerWidth: number) {
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  const realInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.testid !== "open-pr-panel") return realRect.call(this);
    const minW = cssLength(this.style.minWidth, innerWidth);
    const maxW = cssLength(this.style.maxWidth, innerWidth);
    // The panel's content fills to its max width; min-width then BEATS max-width in the cascade,
    // which is exactly why clamping only one of the two is a bug. An unreadable (or deleted) clamp
    // resolves to null and widens the panel without bound, so the assertions fail loudly.
    const width = Math.max(minW ?? 0, maxW ?? Number.POSITIVE_INFINITY);
    const badgeRight = innerWidth - BADGE_RIGHT_INSET;
    // Right-anchored: the panel's right edge meets the badge's. Left-anchored (the bug): its left
    // edge meets the badge's left, and the panel runs off the window from there.
    const left = this.style.right === "0px" ? badgeRight - width : badgeRight - BADGE_WIDTH;
    return {
      left,
      right: left + width,
      width,
      top: 40,
      bottom: 40 + 420,
      height: 420,
      x: left,
      y: 40,
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    if (realInnerWidth) Object.defineProperty(window, "innerWidth", realInnerWidth);
  };
}

/** Open the menu at a stubbed viewport width and hand back the panel plus its modelled rect. */
async function openPanelAt(innerWidth: number) {
  const restore = stubLayout(innerWidth);
  stubList([PASS, FAILING]);
  render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
  fireEvent.click(await screen.findByTestId("open-pr-badge"));
  const panel = await screen.findByTestId("open-pr-panel");
  return { panel, rect: panel.getBoundingClientRect(), restore };
}

describe("OpenPrMenu (containment — §12a)", () => {
  it("anchors the panel to the badge's RIGHT edge, never its left", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const panel = await screen.findByTestId("open-pr-panel");
    expect(panel.style.right).toBe("0px");
    // `left: 0` is what pushed a 340–460px panel off the window when the badge sits flush right.
    expect(panel.style.left).toBe("");
  });

  // THE CLAMPS THEMSELVES, asserted against the real style string rather than a model of it. Both
  // are load-bearing: min-width beats max-width in the cascade, so clamping only max-width leaves a
  // 340px floor that a narrow viewport cannot honour. The commit that added them said so; nothing
  // tested it (roborev 53787).
  it("clamps BOTH min-width and max-width to the viewport", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const panel = await screen.findByTestId("open-pr-panel");
    expect(panel.style.minWidth).toBe("min(340px, calc(100vw - 16px))");
    expect(panel.style.maxWidth).toBe("min(460px, calc(100vw - 16px))");
  });

  it("sits fully inside the window at the ENFORCED minimum window width", async () => {
    // 900 is the floor tauri.conf.json enforces, and the whole containment argument rests on it: a
    // ≤460px panel anchored to a right-hand badge lands hundreds of px inside a 900px window. No
    // measured nudge is involved any more — this is what the CSS alone buys.
    const { rect, restore } = await openPanelAt(MIN_WINDOW_WIDTH);
    try {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      restore();
    }
  });

  it("sits fully inside the window at a roomy width", async () => {
    const { rect, restore } = await openPanelAt(1200);
    try {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      restore();
    }
  });

  it("never grows wider than the viewport, even below the enforced floor", async () => {
    // 300px is below anything the window manager will hand us, so full containment is not the claim
    // here — the panel is anchored to a badge that is itself near the right edge. What the clamps DO
    // guarantee at any width is that the panel is no wider than the viewport less its margin, and
    // that is the property either clamp being dropped breaks: an unclamped min-width floors it at
    // 340, an unclamped max-width at 460, both past a 284px allowance.
    const { rect, restore } = await openPanelAt(300);
    try {
      expect(rect.width).toBeLessThanOrEqual(300 - 16);
    } finally {
      restore();
    }
  });

  it("stays scrollable at small window heights (the list can never outgrow the window)", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const panel = await screen.findByTestId("open-pr-panel");
    expect(panel.style.overflowY).toBe("auto");
    // The cap is the smaller of the design height and what the window actually has.
    expect(panel.style.maxHeight).toBe("min(420px, calc(100vh - 80px))");
  });

  it("leaves window.innerWidth exactly as it found it", async () => {
    // The teardown guarantee itself, so the leak that made every later test in this file run at a
    // stubbed 1200 (then 300) with zero-geometry rects cannot come back unnoticed.
    const before = window.innerWidth;
    const { restore } = await openPanelAt(1200);
    expect(window.innerWidth).toBe(1200);
    restore();
    expect(window.innerWidth).toBe(before);
  });
});

describe("agentLinkForBranch", () => {
  const agent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
    ({ kind: "build", parentId: null, name: over.id, branch: null, ...over }) as AgentTab;
  const project = (id: string, agents: AgentTab[]): Project =>
    ({ id, name: id, rootPath: `/${id}`, createdAt: "2026-01-01T00:00:00Z", agents }) as Project;

  it("matches the agent whose branch equals the PR's headRefName", () => {
    const projects = [
      project("p1", [
        agent({ id: "a", branch: "sparkle/agent-a", name: "Alpha" }),
        agent({ id: "b", branch: "sparkle/agent-b" }),
      ]),
    ];
    expect(agentLinkForBranch("sparkle/agent-a", projects, "p1")).toEqual({
      agentId: "a",
      agentName: "Alpha",
      projectId: "p1",
      isCurrentProject: true,
    });
  });

  it("marks isCurrentProject false for an agent in a different project", () => {
    const projects = [
      project("p1", [agent({ id: "x", branch: "sparkle/agent-x" })]),
      project("p2", [agent({ id: "y", branch: "sparkle/agent-y" })]),
    ];
    const link = agentLinkForBranch("sparkle/agent-y", projects, "p1");
    expect(link?.projectId).toBe("p2");
    expect(link?.isCurrentProject).toBe(false);
  });

  it("never matches a null branch (unstarted / think agents) — even against an empty PR branch", () => {
    const projects = [project("p1", [agent({ id: "n", branch: null })])];
    expect(agentLinkForBranch("", projects, "p1")).toBeNull();
    expect(agentLinkForBranch("sparkle/agent-n", projects, "p1")).toBeNull();
  });

  it("returns null when no agent owns the branch (the common orphaned-PR case)", () => {
    const projects = [project("p1", [agent({ id: "a", branch: "sparkle/agent-a" })])];
    expect(agentLinkForBranch("sparkle/agent-gone", projects, "p1")).toBeNull();
  });
});

describe("OpenPrMenu (merge error surfacing)", () => {
  it("surfaces the gh error text when a merge is declined", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve([PASS]);
      if (cmd === "merge_pr") return Promise.reject(new Error("required status check is pending"));
      return Promise.resolve(null);
    });
    render(<OpenPrMenu rootPath="/repo" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("merge-1"));
    await waitFor(() =>
      expect(screen.getByTestId("merge-error").textContent).toContain("required status check is pending"),
    );
  });
});
