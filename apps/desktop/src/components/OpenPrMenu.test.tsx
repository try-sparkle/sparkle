// @vitest-environment jsdom
// Component coverage for the TopBar open-PR menu: render/hide by the null-vs-zero rule, the dropdown
// list, the per-PR + "merge all" merge paths, the check-status gate, and the "Open agent" hand-off.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => h.openUrl(u) }));

import {
  OpenPrMenu,
  agentLinkForBranch,
  agentLinkForPr,
  prBadgeTitle,
  type PrAgentLink,
} from "./OpenPrMenu";
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
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await waitFor(() =>
      expect(screen.getByTestId("open-pr-badge").textContent).toContain("2 PRs waiting"),
    );
  });

  it("renders NOTHING at a known-empty list, and NOTHING when the probe couldn't run", async () => {
    stubList([]);
    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();

    stubList(null);
    rerender(<OpenPrMenu rootPath="/repo2" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await waitFor(() => expect(screen.queryByTestId("open-pr-badge")).toBeNull());
  });

  it("opens the dropdown and lists each PR", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    expect(await screen.findByTestId("merge-1")).toBeTruthy();
    expect(screen.getByTestId("merge-2")).toBeTruthy();
  });

  it("gates merge on checks: a failing PR's Merge is disabled, a passing one's is enabled", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    expect((await screen.findByTestId("merge-1")).hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("merge-2").hasAttribute("disabled")).toBe(true);
  });

  it("merges a single PR through the Rust command", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("merge-1"));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("merge_pr", { root: "/repo", number: 1 }),
    );
  });

  it("'Merge all ready' merges only the eligible PRs, skipping the failing one", async () => {
    stubList([PASS, FAILING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
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
    const resolve = (pr: PrRow) => (pr.headRefName === PASS.headRefName ? link : null);
    const onOpen = vi.fn();
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={resolve} onOpenAgent={onOpen} />);
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
  render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
  fireEvent.click(await screen.findByTestId("open-pr-badge"));
  const panel = await screen.findByTestId("open-pr-panel");
  return { panel, rect: panel.getBoundingClientRect(), restore };
}

describe("OpenPrMenu (containment — §12a)", () => {
  it("anchors the panel to the badge's RIGHT edge, never its left", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
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
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
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
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
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

describe("agentLinkForPr", () => {
  const agent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
    ({ kind: "build", parentId: null, name: over.id, branch: null, ...over }) as AgentTab;
  const project = (id: string, agents: AgentTab[]): Project =>
    ({ id, name: id, rootPath: `/${id}`, createdAt: "2026-01-01T00:00:00Z", agents }) as Project;
  const pr = (over: Partial<PrRow>): PrRow => ({ ...PASS, ...over });

  it("resolves a PR on a DESCRIPTIVE branch — no agent id in the name — from the recorded owner", () => {
    // THE HEADLINE CASE. `sparkle/left-pair` (#806) has no id to parse, so the branch-name join
    // below can never answer it; the durable `agentId` can, and that is the whole point of recording
    // the mapping instead of re-deriving it from a string.
    const projects = [
      project("p1", [agent({ id: "cockpit", branch: "sparkle/left-pair", name: "Left Pair" })]),
    ];
    const row = pr({ number: 806, headRefName: "sparkle/left-pair", agentId: "cockpit" });
    expect(agentLinkForPr(row, projects, "p1")).toEqual({
      agentId: "cockpit",
      agentName: "Left Pair",
      projectId: "p1",
      isCurrentProject: true,
    });
    // Prove the branch name is doing NO work: the same recorded owner still resolves when the
    // branch has been renamed to something the roster join cannot match at all.
    const renamed = pr({ number: 806, headRefName: "totally/unrelated", agentId: "cockpit" });
    expect(agentLinkForPr(renamed, projects, "p1")?.agentId).toBe("cockpit");
  });

  it("prefers the recorded owner over the branch join when the two disagree", () => {
    // A branch can be handed between agents; the recorded owner is who OPENED the PR, and it wins.
    const projects = [
      project("p1", [
        agent({ id: "opener", branch: "some/other-branch", name: "Opener" }),
        agent({ id: "squatter", branch: "shared/branch", name: "Squatter" }),
      ]),
    ];
    const row = pr({ headRefName: "shared/branch", agentId: "opener" });
    expect(agentLinkForPr(row, projects, "p1")?.agentId).toBe("opener");
  });

  it("falls back to the branch join for a PR recorded before the mapping existed", () => {
    const projects = [
      project("p1", [agent({ id: "a", branch: "sparkle/agent-a", name: "Alpha" })]),
    ];
    const row = pr({ headRefName: "sparkle/agent-a", agentId: null });
    expect(agentLinkForPr(row, projects, "p1")?.agentId).toBe("a");
  });

  it("returns null rather than the nearest plausible agent when nothing matches", () => {
    // A link is only useful if it OPENS the agent it names. A recorded id for an agent that has left
    // the roster, and a PR nothing identifies at all, must both be null — never a neighbour's id.
    const projects = [
      project("p1", [agent({ id: "a", branch: "sparkle/agent-a", name: "Alpha" })]),
    ];
    expect(agentLinkForPr(pr({ headRefName: "sparkle/left-pair", agentId: "gone" }), projects, "p1"))
      .toBeNull();
    expect(agentLinkForPr(pr({ headRefName: "sparkle/left-pair", agentId: null }), projects, "p1"))
      .toBeNull();
  });

  it("a KNOWN owner that left the roster is null — it never falls through to the branch join", () => {
    // roborev 55253. The branch here DOES match a live agent, so the fallback would happily return
    // "Squatter" — an agent we already know did not open the PR. "The owner left" and "nobody
    // recorded an owner" are different facts, and re-attributing the first by branch name is exactly
    // the wrong-pill failure the durable mapping exists to prevent.
    const projects = [
      project("p1", [agent({ id: "squatter", branch: "shared/branch", name: "Squatter" })]),
    ];
    const row = pr({ headRefName: "shared/branch", agentId: "departed" });
    expect(agentLinkForPr(row, projects, "p1")).toBeNull();
    // …and the same row with NO recorded owner does use the join, which is what makes the case above
    // a real divergence rather than a branch that simply never matched.
    expect(agentLinkForPr({ ...row, agentId: null }, projects, "p1")?.agentId).toBe("squatter");
  });
});

/** PR #779 to the life: every check green, and completely unmergeable. */
const CONFLICTING: PrRow = {
  number: 779,
  title: "fix(worktree): ignore agent scratch worktrees",
  headRefName: "sparkle/ignore-agent-scratch-worktrees",
  url: "https://github.com/o/r/pull/779",
  checks: "passing",
  mergeable: "conflicting",
};

describe("OpenPrMenu (the dot reflects MERGEABILITY, not just checks)", () => {
  it("does not render green for a green-CI PR that conflicts (#779)", async () => {
    stubList([CONFLICTING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const dot = await screen.findByTestId("pr-dot-779");
    // The assertion is on the RENDERED tone, so it fails against the old checks-only dot — which
    // painted this exact row green.
    expect(dot.getAttribute("data-tone")).toBe("blocked");
    expect(dot.getAttribute("data-tone")).not.toBe("ready");
    // …and the reason is actually stated to the reader rather than implied by a colour.
    expect(dot.getAttribute("title")).toMatch(/conflict/i);
    expect(dot.getAttribute("aria-label")).toMatch(/conflict/i);
  });

  it("still renders green for a genuinely ready PR", async () => {
    // Guards the fix against over-correcting into "nothing is ever green".
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    expect((await screen.findByTestId("pr-dot-1")).getAttribute("data-tone")).toBe("ready");
  });

  it("disables Merge on a conflicting PR and says why in the tooltip", async () => {
    stubList([CONFLICTING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const btn = (await screen.findByTestId("merge-779")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/conflict/i);
    // A disabled control must also be INERT — clicking it must not fire a merge that silently fails.
    fireEvent.click(btn);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(0);
  });

  it("keeps a conflicting PR out of 'Merge all ready'", async () => {
    stubList([CONFLICTING]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    const all = (await screen.findByTestId("merge-all")) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    fireEvent.click(all);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(0);
  });
});

describe("OpenPrMenu (merge error surfacing)", () => {
  it("surfaces the gh error text when a merge is declined", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve([PASS]);
      if (cmd === "merge_pr") return Promise.reject(new Error("required status check is pending"));
      return Promise.resolve(null);
    });
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    fireEvent.click(await screen.findByTestId("open-pr-badge"));
    fireEvent.click(await screen.findByTestId("merge-1"));
    await waitFor(() =>
      expect(screen.getByTestId("merge-error").textContent).toContain("required status check is pending"),
    );
  });
});

// ── The trust rule: a Merge button may only exist when the answer is YES ────────────────────────
//
// The reported defect was five PR rows with yellow, green and red dots and an ENABLED Merge button
// on every one, under a header that said "Merge all ready (1)". The app knew only one was ready and
// offered one-click merge on the other four anyway.
//
// These three fixtures are the PRs that were actually open at the time, as `gh` described them.
// #934/#925 are the trap: GitHub reports them MERGEABLE — you genuinely can merge — while a
// non-required check is red, so "mergeable" and "safe to merge" come apart.
const PR_944: PrRow = {
  number: 944,
  title: "fix(status): a quota-walled agent reads BLOCKED",
  headRefName: "sparkle/quota-wall",
  url: "https://github.com/o/r/pull/944",
  checks: "pending",
  mergeable: "conflicting",
  mergeStateStatus: "dirty",
  failingChecks: [],
  pendingChecks: ["Vercel Agent Review"],
};
const PR_934: PrRow = {
  number: 934,
  title: "feat(concierge-lint): mount the linter",
  headRefName: "sparkle/mount-linter",
  url: "https://github.com/o/r/pull/934",
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["Node — coverage (shard 3/4)", "Node — typecheck · test · build"],
  pendingChecks: [],
};
const PR_925: PrRow = {
  number: 925,
  title: "A verified goal can no longer be closed by its own claimant",
  headRefName: "sparkle/goal-claimant",
  url: "https://github.com/o/r/pull/925",
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["Desktop Rust — cargo check · test"],
  pendingChecks: [],
};
/** Amber, and the case that produced the report: GitHub has not finished computing mergeability. */
const PR_UNKNOWN: PrRow = {
  number: 900,
  title: "just opened",
  headRefName: "sparkle/just-opened",
  url: "https://github.com/o/r/pull/900",
  checks: "passing",
  mergeable: "unknown",
  mergeStateStatus: "unknown",
  failingChecks: [],
  pendingChecks: [],
};

const openMenu = async () => fireEvent.click(await screen.findByTestId("open-pr-badge"));

describe("OpenPrMenu — no Merge affordance when the answer is not yes", () => {
  it("offers a one-click Merge ONLY on the green row", async () => {
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();

    // Green: enabled.
    const green = await screen.findByTestId("merge-1");
    expect((green as HTMLButtonElement).disabled).toBe(false);

    // Conflicting and unknown-mergeability: present but DISABLED, never a live button.
    for (const n of [944, 900]) {
      const btn = screen.getByTestId(`merge-${n}`) as HTMLButtonElement;
      expect(btn.disabled, `PR #${n} offered a live Merge`).toBe(true);
    }

    // The two UNSTABLE ones do not get the plain Merge button at all — they get an override.
    expect(screen.queryByTestId("merge-934")).toBeNull();
    expect(screen.queryByTestId("merge-925")).toBeNull();
    expect(screen.getByTestId("merge-override-934")).toBeTruthy();
    expect(screen.getByTestId("merge-override-925")).toBeTruthy();
  });

  it("REGRESSION: an amber dot never sits next to an enabled Merge button", async () => {
    // The founder's words: "it's a little bit scary as a user to be clicking on a button that has a
    // yellow dot instead of a green dot." Asserted as a PROPERTY over the whole rendered list, so it
    // cannot be satisfied by fixing one row. Fails against the old build, where unknown-mergeability
    // painted amber and left the button live.
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    await screen.findByTestId("merge-1");

    for (const pr of [PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]) {
      const tone = screen.getByTestId(`pr-dot-${pr.number}`).getAttribute("data-tone");
      const btn = screen.queryByTestId(`merge-${pr.number}`) as HTMLButtonElement | null;
      const live = btn !== null && !btn.disabled;
      expect(live, `#${pr.number} (${tone}) offered a one-click merge`).toBe(tone === "ready");
    }
  });

  it("gives every non-green row a WORD, so the state is not colour-only", async () => {
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    await screen.findByTestId("merge-1");

    expect(screen.getByTestId("pr-state-944").textContent).toBe("Conflicts");
    expect(screen.getByTestId("pr-state-934").textContent).toBe("2 checks failing");
    expect(screen.getByTestId("pr-state-925").textContent).toBe("1 check failing");
    expect(screen.getByTestId("pr-state-900").textContent).toMatch(/checking mergeability/i);
    // The green row needs no word — its enabled button says it.
    expect(screen.queryByTestId("pr-state-1")).toBeNull();
  });

  it("names the failing check on an UNSTABLE PR rather than just counting it", async () => {
    stubList([PR_925]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    const dot = await screen.findByTestId("pr-dot-925");
    expect(dot.getAttribute("title")).toContain("Desktop Rust — cargo check · test");
  });

  it("requires TWO deliberate clicks to override, and merges only on the second", async () => {
    stubList([PR_934]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    const btn = await screen.findByTestId("merge-override-934");
    expect(btn.getAttribute("data-armed")).toBe("no");
    expect(btn.textContent).toMatch(/merge anyway/i);

    // First click ARMS only — nothing is merged.
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByTestId("merge-override-934").getAttribute("data-armed")).toBe("yes"),
    );
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(0);

    // Second click merges.
    fireEvent.click(screen.getByTestId("merge-override-934"));
    await waitFor(() =>
      expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1),
    );
    expect(h.invoke.mock.calls.find((c) => c[0] === "merge_pr")?.[1]).toMatchObject({ number: 934 });
  });

  it("counts ONLY green in 'Merge all ready', and merges only those", async () => {
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    const all = await screen.findByTestId("merge-all");
    expect(all.textContent).toContain("(1)");

    fireEvent.click(all);
    await waitFor(() =>
      expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1),
    );
    // Exactly the green one — not the conflicting, unstable or unknown rows.
    expect(h.invoke.mock.calls.find((c) => c[0] === "merge_pr")?.[1]).toMatchObject({ number: 1 });
  });

  it("disables 'Merge all ready' outright when nothing is green", async () => {
    stubList([PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    const all = (await screen.findByTestId("merge-all")) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    expect(all.textContent).not.toContain("(");
  });

  it("discards an armed override when the panel is closed", async () => {
    // Arming is a deliberate act about a specific PR; it must not survive the user walking away.
    stubList([PR_934]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId("merge-override-934"));
    await waitFor(() =>
      expect(screen.getByTestId("merge-override-934").getAttribute("data-armed")).toBe("yes"),
    );

    fireEvent.click(screen.getByTestId("open-pr-badge")); // close
    fireEvent.click(screen.getByTestId("open-pr-badge")); // reopen
    await waitFor(() =>
      expect(screen.getByTestId("merge-override-934").getAttribute("data-armed")).toBe("no"),
    );
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(0);
  });
});

// ── THE COMPACT (CONCIERGE-HEADER) BADGE ──────────────────────────────────────────────────────
// The wide bordered "N PRs waiting" pill in the project tab strip MOVED here, beside the ⋮, as an
// icon and a number. Only the badge and the panel's anchor change; every merge rule above is shared,
// which is the point of it being the same component rather than a second PR affordance.
describe("OpenPrMenu, compact", () => {
  const compact = () => (
    <OpenPrMenu compact rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />
  );

  it("shows the PR icon and the GREEN count, not the total", async () => {
    // Five open PRs, exactly one of them green. The number must be the green one.
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(compact());
    const badge = await screen.findByTestId("open-pr-badge");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge.textContent).toBe("1");
    // Specifically NOT the old wide pill's wording, which is what this replaced.
    expect(badge.textContent).not.toMatch(/waiting/i);
  });

  it("shows the icon with NO number when nothing is green — never a zero", async () => {
    stubList([PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(compact());
    const badge = await screen.findByTestId("open-pr-badge");
    expect(badge.querySelector("svg")).not.toBeNull();
    // A "0" would be a count of nothing, and reads as a state rather than an absence.
    expect(badge.textContent).toBe("");
    expect(badge.getAttribute("data-ready")).toBe("no");
  });

  // NO EMOJI AS ICONS — a standing founder rule for this repo, and a small chip beside the ⋮ is
  // exactly the kind of control that attracts one. It draws the Feather git-pull-request glyph.
  it("draws a Feather glyph, never an emoji", async () => {
    stubList([PASS]);
    render(compact());
    const badge = await screen.findByTestId("open-pr-badge");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge.textContent ?? "").not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  // CONTAINMENT. The concierge is a ~380px column that the user can dock to either side, so a panel
  // hung off this badge's own edge would leave the window on one of them. Compact therefore takes
  // its positioning from the header instead: the wrapper contributes none, and the panel spans.
  it("anchors its panel to the header, spanning it, rather than to the badge", async () => {
    stubList([PASS]);
    render(compact());
    await openMenu();
    const panel = await screen.findByTestId("open-pr-panel");
    expect(panel.style.left).toBe("8px");
    expect(panel.style.right).toBe("8px");
    // The wrapper must NOT be the positioned ancestor, or the panel anchors to the badge after all.
    expect(screen.getByTestId("open-pr-menu").style.position).toBe("static");
  });

  it("keeps the wide pill and its own containment clamps when NOT compact", async () => {
    stubList([PASS]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    const badge = await screen.findByTestId("open-pr-badge");
    expect(badge.textContent).toContain("1 PR waiting");
    await openMenu();
    const panel = await screen.findByTestId("open-pr-panel");
    expect(panel.style.left).toBe("");
    expect(panel.style.right).toBe("0px");
    expect(screen.getByTestId("open-pr-menu").style.position).toBe("relative");
  });

  it("merges from the compact form exactly as it does from the wide one", async () => {
    // The move is placement and size — not function. A green PR still merges in one click here.
    stubList([PASS, PR_944]);
    render(compact());
    await openMenu();
    fireEvent.click(await screen.findByTestId("merge-1"));
    await waitFor(() =>
      expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1),
    );
    expect(h.invoke.mock.calls.find((c) => c[0] === "merge_pr")?.[1]).toMatchObject({ number: 1 });
    // …and the conflicting one is still not offered a live Merge.
    expect((screen.getByTestId("merge-944") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── THE BADGE HAS TO SAY WHAT IT IS ───────────────────────────────────────────────────────────
// Compact's entire visible content is an `aria-hidden` glyph and a bare numeral, and `title` stops
// contributing to the accessible name the moment an element has text content — so without an
// explicit label the app's ONLY pull-request entry point announces itself as "1, button". Both
// affordances this replaced were named (the wide pill by its "3 PRs waiting" text, the old concierge
// chip by an aria-label), so this is a regression the move could silently introduce.
describe("OpenPrMenu — the badge is named for assistive tech", () => {
  it("names the compact badge by its meaning, not by its numeral", async () => {
    stubList([PASS, PR_944, PR_934, PR_925, PR_UNKNOWN]);
    render(
      <OpenPrMenu compact rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    const badge = await screen.findByRole("button", { name: /ready to merge/i });
    expect(badge.getAttribute("data-testid")).toBe("open-pr-badge");
    expect(badge.getAttribute("aria-label")).toBe("1 of 5 open pull requests ready to merge");
    // The visible text is still just the count — the name is carried, not painted.
    expect(badge.textContent).toBe("1");
  });

  it("names it when NOTHING is green, where there is no numeral at all", async () => {
    stubList([PR_944, PR_934]);
    render(
      <OpenPrMenu compact rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    const badge = await screen.findByRole("button", { name: /none ready to merge/i });
    expect(badge.textContent).toBe("");
  });

  it("names the wide badge the same way", async () => {
    stubList([PASS, PR_944]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await screen.findByRole("button", { name: "1 of 2 open pull requests ready to merge" });
  });

  it("says 'request' not 'requests' for a single PR", () => {
    expect(prBadgeTitle("1 PR waiting", 1, 1)).toBe("1 of 1 open pull request ready to merge");
  });
});

// ── THE ESCAPE HATCH THAT MAKES BLOCKING ON `unknown` AFFORDABLE ──────────────────────────────
// The gate withholds Merge while GitHub has not finished computing mergeability, which is the
// honest answer — but GitHub invalidates mergeability on every push to the base, so merging one PR
// routinely leaves the REST of the list `unknown`. With only the 3-minute poll that is a panel with
// every control dead and no way to re-ask (roborev 56050).
describe("OpenPrMenu — Refresh re-asks GitHub on demand", () => {
  it("re-probes when pressed, without closing the panel", async () => {
    stubList([PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    await screen.findByTestId("open-pr-panel");
    const before = h.invoke.mock.calls.filter((c) => c[0] === "project_open_prs").length;

    fireEvent.click(screen.getByTestId("pr-refresh"));
    await waitFor(() =>
      expect(
        h.invoke.mock.calls.filter((c) => c[0] === "project_open_prs").length,
      ).toBeGreaterThan(before),
    );
    // Still open — this is a refresh, not a close-and-reopen.
    expect(screen.getByTestId("open-pr-panel")).toBeTruthy();
  });

  it("is the ONLY control on an all-unknown list, and the merge paths stay shut", async () => {
    stubList([PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    expect((await screen.findByTestId("merge-all")).hasAttribute("disabled")).toBe(true);
    expect((screen.getByTestId(`merge-${PR_UNKNOWN.number}`) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId(`merge-override-${PR_UNKNOWN.number}`)).toBeNull();
    expect((screen.getByTestId("pr-refresh") as HTMLButtonElement).disabled).toBe(false);
  });

  // The disabled tooltip listed only checks and conflicts, so the state that now blocks most often
  // was the one it never named.
  it("says unknown mergeability is a reason nothing is ready", async () => {
    stubList([PR_UNKNOWN]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    const all = await screen.findByTestId("merge-all");
    expect(all.getAttribute("title")).toMatch(/has not finished working out/i);
  });
});

// ── A FAILED PROBE MUST NOT ERASE THE CONTROL YOU JUST PRESSED ────────────────────────────────
// `fetchOpenPrs` collapses every failure into `null`, and `null` renders no badge at all — so a
// rate-limited or offline `gh` used to make the whole PR chip vanish from the header, panel and
// Refresh button included. That is bad for the background poll and worse for Refresh, whose entire
// purpose is recovering from a state where nothing else works (roborev 56164).
describe("OpenPrMenu — a probe that fails keeps what we already knew", () => {
  /** First call succeeds with `rows`; every later `project_open_prs` returns null (the probe failed). */
  function stubThenFail(rows: PrRow[]) {
    let asked = 0;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve(asked++ === 0 ? rows : null);
      if (cmd === "merge_pr") return Promise.resolve(null);
      return Promise.resolve(null);
    });
  }

  it("keeps the list and the panel up, and says the list may be stale", async () => {
    stubThenFail([PASS, PR_944]);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    await screen.findByTestId("open-pr-panel");

    fireEvent.click(screen.getByTestId("pr-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("pr-stale-notice").textContent).toMatch(/last list/i),
    );
    // The whole point: everything is still there.
    expect(screen.getByTestId("open-pr-badge")).toBeTruthy();
    expect(screen.getByTestId("open-pr-panel")).toBeTruthy();
    expect(screen.getByTestId("pr-refresh")).toBeTruthy();
    expect(screen.getByTestId("merge-1")).toBeTruthy();
  });

  it("clears its own notice once a probe succeeds again", async () => {
    let asked = 0;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve(asked++ === 1 ? null : [PASS]);
      return Promise.resolve(null);
    });
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId("pr-refresh")); // the failing one
    await waitFor(() => expect(screen.getByTestId("pr-stale-notice")).toBeTruthy());
    fireEvent.click(screen.getByTestId("pr-refresh")); // succeeds
    await waitFor(() => expect(screen.queryByTestId("pr-stale-notice")).toBeNull());
  });

  // The badge's unknown-vs-zero rule is unchanged where there is nothing to preserve: a probe that
  // has NEVER succeeded still renders nothing, because "0 PRs" would be a claim we cannot make.
  it("still renders nothing when the FIRST probe fails", async () => {
    stubList(null);
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
  });

  it("says it is working while the probe is in flight", async () => {
    let release: (v: PrRow[] | null) => void = () => {};
    let asked = 0;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd !== "project_open_prs") return Promise.resolve(null);
      if (asked++ === 0) return Promise.resolve([PASS]);
      return new Promise((res) => {
        release = res;
      });
    });
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId("pr-refresh"));
    await waitFor(() =>
      expect((screen.getByTestId("pr-refresh") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId("pr-refresh").textContent).toMatch(/refreshing/i);
    release([PASS]);
    await waitFor(() =>
      expect((screen.getByTestId("pr-refresh") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  // A SWITCH still wipes: keeping the previous repo's PRs under the new repo's name is the exact
  // thing the reset exists to prevent, and is a different failure from "we couldn't ask".
  it("does not hold the old repo's list across a project switch", async () => {
    stubThenFail([PASS, PR_944]);
    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await screen.findByTestId("open-pr-badge");
    rerender(
      <OpenPrMenu rootPath="/other" projectId="p2" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    // The new repo's probe fails, and there is nothing legitimate to show under its name.
    await waitFor(() => expect(screen.queryByTestId("open-pr-badge")).toBeNull());
  });
});

// ── THE TWO BUGS THE KEEP-WHAT-WE-KNOW RULE INTRODUCED ────────────────────────────────────────
// Preserving a list across a failed probe is only safe if the list is definitely THIS repo's, and
// only kind if it does not eat the message explaining a failed merge. Both were wrong in the commit
// that added it (roborev 56167), and both fail as a wrong action rather than as a cosmetic slip.
describe("OpenPrMenu — preserving a stale list must not preserve the WRONG list", () => {
  // `aliveRef` was a plain boolean the effect set back to `true` on every re-run, and React runs the
  // old cleanup and the new body back-to-back — so a slow probe for the PREVIOUS repo resolving
  // afterwards wrote through. On its own that was a stale paint the next poll corrected; combined
  // with the preserve rule it PINS the old repo's rows under the new repo's name, and every Merge
  // there calls mergePr(newRoot, <a number from the old repo>) — a merge in the wrong repository.
  it("discards a probe that lands after a project switch", async () => {
    let releaseFirst: (v: PrRow[] | null) => void = () => {};
    let asked = 0;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd !== "project_open_prs") return Promise.resolve(null);
      // First probe (project p1) never resolves until we say so; every later one fails.
      if (asked++ === 0)
        return new Promise((res) => {
          releaseFirst = res;
        });
      return Promise.resolve(null);
    });

    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    rerender(
      <OpenPrMenu rootPath="/other" projectId="p2" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    // …and only NOW does /repo's probe come back, with rows that belong to /repo.
    releaseFirst([PASS, PR_944]);

    await waitFor(() => expect(asked).toBeGreaterThan(1));
    // Nothing from /repo may appear under /other's name — not the badge, and above all not a row
    // whose Merge button would target /other.
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
    expect(screen.queryByTestId(`merge-${PASS.number}`)).toBeNull();
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(0);
  });

  // `runMerge` sets the merge failure and then immediately refetches. When `gh` is down — the most
  // likely reason the merge just failed — that probe fails too, so sharing one slot meant the
  // staleness notice DETERMINISTICALLY ate the only text saying why the merge failed.
  it("keeps a merge error readable alongside the staleness notice", async () => {
    let listed = 0;
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve(listed++ === 0 ? [PASS] : null);
      if (cmd === "merge_pr") return Promise.reject(new Error("Pull request is not mergeable"));
      return Promise.resolve(null);
    });
    render(<OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId(`merge-${PASS.number}`));

    // BOTH, in their own slots. The reason the merge failed is the one the user acts on.
    await waitFor(() =>
      expect(screen.getByTestId("merge-error").textContent).toMatch(/not mergeable/i),
    );
    await waitFor(() => expect(screen.getByTestId("pr-stale-notice")).toBeTruthy());
  });
});

// ── A MERGE IN FLIGHT ACROSS A PROJECT SWITCH ─────────────────────────────────────────────────
// `ConciergePrChip` renders this menu UNKEYED, so a project switch is a prop change on the same
// instance — not a remount. The generation guard went onto `refetch` and `runMerge` was left on
// `aliveRef`, which answers unmount only, so a merge still running when the user switched landed its
// results under the new repo's name (roborev 56187).
describe("OpenPrMenu — a merge in flight must not follow you to another repo", () => {
  /** `merge_pr` hangs until released; `project_open_prs` always serves `rows`. */
  function stubHangingMerge(rows: PrRow[]) {
    let release: () => void = () => {};
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve(rows);
      if (cmd === "merge_pr")
        return new Promise((_res, rej) => {
          release = () => rej(new Error("Pull request is not mergeable"));
        });
      return Promise.resolve(null);
    });
    return () => release();
  }

  it("does not paint the old repo's merge error into the new repo's panel", async () => {
    const fail = stubHangingMerge([PASS]);
    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await openMenu();
    fireEvent.click(await screen.findByTestId(`merge-${PASS.number}`));
    await waitFor(() =>
      expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1),
    );

    rerender(
      <OpenPrMenu rootPath="/other" projectId="p2" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    fail(); // the /repo merge finally fails, after the switch
    await waitFor(() => expect(screen.getByTestId("open-pr-badge")).toBeTruthy());
    await openMenu();
    // "PR #1: …" would name a number that means a DIFFERENT pull request in the repo now on screen.
    expect(screen.queryByTestId("merge-error")).toBeNull();
  });

  // `merging` is keyed by PR NUMBER, and numbers collide across repositories.
  it("does not leave the new repo's same-numbered row stuck on 'Merging…'", async () => {
    stubHangingMerge([PASS]);
    const { rerender } = render(
      <OpenPrMenu rootPath="/repo" projectId="p1" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await openMenu();
    fireEvent.click(await screen.findByTestId(`merge-${PASS.number}`));
    await waitFor(() =>
      expect((screen.getByTestId(`merge-${PASS.number}`) as HTMLButtonElement).disabled).toBe(true),
    );

    rerender(
      <OpenPrMenu rootPath="/other" projectId="p2" resolveAgent={noAgent} onOpenAgent={noop} />,
    );
    await openMenu();
    // Same number, different repository — and nothing about it is mid-merge.
    const row = (await screen.findByTestId(`merge-${PASS.number}`)) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    expect(row.textContent).not.toMatch(/merging/i);
    expect((screen.getByTestId("merge-all") as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── THE GUARD IS REPO IDENTITY, NOT "HAS ANYTHING HAPPENED SINCE" ─────────────────────────────
// A generation COUNTER only increments, so returning to the repo you started in yields a different
// number for the same repo — and the merge failure that arrives is discarded as "not yours" while
// the user is looking straight at the panel it belongs to (roborev 56193). `refreshing` had the
// same shape of bug on the panel's own recovery control.
describe("OpenPrMenu — switching away and BACK is not the same as switching away", () => {
  function stubHangingMerge(rows: PrRow[]) {
    let release: () => void = () => {};
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "project_open_prs") return Promise.resolve(rows);
      if (cmd === "merge_pr")
        return new Promise((_res, rej) => {
          release = () => rej(new Error("Pull request is not mergeable"));
        });
      return Promise.resolve(null);
    });
    return () => release();
  }

  it("SHOWS a merge failure that lands after you switch away and come back", async () => {
    const fail = stubHangingMerge([PASS]);
    const props = { resolveAgent: noAgent, onOpenAgent: noop };
    const { rerender } = render(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId(`merge-${PASS.number}`));
    await waitFor(() =>
      expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1),
    );

    rerender(<OpenPrMenu rootPath="/other" projectId="p2" {...props} />);
    rerender(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />); // …and back again
    fail();

    await openMenu();
    // The user is in front of the right repo and their merge failed. Saying nothing is the bug.
    await waitFor(() =>
      expect(screen.getByTestId("merge-error").textContent).toMatch(/not mergeable/i),
    );
  });

  // `merging` is keyed by repo+number now, so it needs no reset — which is what makes the spinner
  // survive the round trip instead of being cleared out from under an in-flight merge.
  it("keeps the row's spinner across the round trip, so a second click cannot double-merge", async () => {
    stubHangingMerge([PASS]);
    const props = { resolveAgent: noAgent, onOpenAgent: noop };
    const { rerender } = render(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />);
    await openMenu();
    fireEvent.click(await screen.findByTestId(`merge-${PASS.number}`));
    await waitFor(() =>
      expect((screen.getByTestId(`merge-${PASS.number}`) as HTMLButtonElement).disabled).toBe(true),
    );

    rerender(<OpenPrMenu rootPath="/other" projectId="p2" {...props} />);
    rerender(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />);
    await openMenu();

    const row = (await screen.findByTestId(`merge-${PASS.number}`)) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    // Still exactly one — the merge already running was not issued a second time.
    expect(h.invoke.mock.calls.filter((c) => c[0] === "merge_pr")).toHaveLength(1);
  });

  // Refresh is the panel's designated escape hatch, so it going dead for another repo's round trip
  // is the worst possible control to leave unscoped.
  //
  // THE HANGING PROBE IS SELECTED BY A FLAG, not by call index, and that is the whole test. Picking
  // "the second `project_open_prs`" hangs the OPEN-MENU refetch — `openMenu` clicks the badge and
  // the badge's onClick refetches — so the Refresh got a call that resolved immediately, its
  // `.finally` cleared the flag on the next microtask, and both assertions then held with nothing
  // refreshing anywhere. That version passed against a plain boolean: it proved nothing (roborev
  // 56201). Gating on a flag flipped immediately before the click makes the Refresh's OWN probe the
  // one left in flight across the switch, which is the only state in which the bug is visible.
  it("does not leave Refresh disabled in one repo for another repo's probe", async () => {
    let hangNext = false;
    let releaseRefresh: (v: PrRow[] | null) => void = () => {};
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd !== "project_open_prs") return Promise.resolve(null);
      if (hangNext) {
        hangNext = false;
        return new Promise((res) => {
          releaseRefresh = res;
        });
      }
      return Promise.resolve([PASS]);
    });
    const props = { resolveAgent: noAgent, onOpenAgent: noop };
    const { rerender } = render(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />);
    await openMenu();
    await screen.findByTestId("open-pr-panel");

    hangNext = true;
    const probesBefore = h.invoke.mock.calls.filter((c) => c[0] === "project_open_prs").length;
    fireEvent.click(screen.getByTestId("pr-refresh"));
    // THE HANG LANDED ON THE REFRESH'S OWN PROBE — asserted against the MOCK, not against the
    // button. `fetchOpenPrs` calls `invoke` synchronously, so the flag is consumed before the click
    // returns, by exactly one new `project_open_prs`: this one. Reading `disabled` here instead
    // cannot make that claim at all — the click itself set it, synchronously, and no number of
    // microtask flushes separates "still in flight" from "resolved, `.finally` not yet run"
    // (roborev 56209).
    expect(hangNext).toBe(false);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "project_open_prs")).toHaveLength(
      probesBefore + 1,
    );
    // Now let everything that CAN settle settle — a macrotask drains the whole microtask chain and
    // React's scheduler, where two `await Promise.resolve()` did not even reach the `.finally`. The
    // button is still busy because the probe is genuinely hung, not because nothing has run yet.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect((screen.getByTestId("pr-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("pr-refresh").textContent).toMatch(/refreshing/i);

    // …and now, with /repo's refresh genuinely still in flight, the OTHER repo's button is free.
    rerender(<OpenPrMenu rootPath="/other" projectId="p2" {...props} />);
    await openMenu();
    const other = (await screen.findByTestId("pr-refresh")) as HTMLButtonElement;
    expect(other.disabled).toBe(false);
    expect(other.textContent).not.toMatch(/refreshing/i);

    // THE MIRROR CASE, which is the half a reset-on-switch fix would lose: come back to /repo and
    // your own refresh is still running, so the button still says so.
    rerender(<OpenPrMenu rootPath="/repo" projectId="p1" {...props} />);
    await openMenu();
    const back = (await screen.findByTestId("pr-refresh")) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(back.textContent).toMatch(/refreshing/i);

    releaseRefresh([PASS]);
    await waitFor(() =>
      expect((screen.getByTestId("pr-refresh") as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
