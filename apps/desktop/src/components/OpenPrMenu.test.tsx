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
