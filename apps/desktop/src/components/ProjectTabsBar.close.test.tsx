// @vitest-environment jsdom
//
// Closable project tabs, end to end through the REAL services and stores — deliberately not the
// mocked-openProjectTab setup ProjectTabsBar.test.tsx uses, because the one thing worth proving
// here is the round trip: a project that can be closed but never reopened is a bug, and only an
// unmocked open path can show that it comes back.
//
// The invariants, in the order the user meets them:
//   1. only OPEN projects get a tab (existing in the store is not enough);
//   2. × removes the tab and nothing else — the project, its agents and its worktrees stay;
//   3. closing the selected tab lands on a sensible neighbour;
//   4. closing the LAST tab leaves the welcome state, not a blank shell;
//   5. the closed project is one click from having its tab back.
// THE TAB ROLE LIVES ON THE LABEL (`tab-label-<id>`), NOT ON THE SLOT (`tab-<id>`) — bead
// sparkle-2mwl2m.1. A `role="tab"` flattens its whole subtree, which was silencing the close
// button, the pin and the stale badge inside it, so the role moved inward to the name and
// those controls became its siblings. `aria-selected` and the accessible name moved with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pickProjectFolder = vi.fn(async (_title?: string) => "/tmp/p2" as string | null);
vi.mock("../services/dialog", () => ({
  pickProjectFolder: (t?: string) => pickProjectFolder(t),
  basename: (p: string) => p.split("/").pop() ?? p,
}));

// Chrome that self-fetches over Tauri — out of scope here.
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => <div data-testid="topright" /> }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./TrialChrome", () => ({ TrialIndicator: () => <div data-testid="trial" /> }));

import { ProjectTabsBar } from "./ProjectTabsBar";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import type { ConciergeFeed } from "../services/conciergeFeed";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: `/wt/${id}`, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[] = []): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(),
    selectedAgentId: null, agents,
  };
}

const feed: ConciergeFeed = {
  projects: [],
  counts: { needs_you: 0, questions: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, questions: 0, running: 0, done: 0 },
  pinnedProjectId: null,
};

const bar = () => <ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />;
const openIds = () => useUiStore.getState().openProjectIds;
const selected = () => useProjectStore.getState().selectedProjectId;

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")]),
      mkProject("p2", "Beta"),
      mkProject("p3", "Gamma"),
    ],
    selectedProjectId: "p1",
    removedIds: {},
  } as never);
  useUiStore.setState({ pinnedProjectId: null, openProjectIds: null } as never);
  useAuthStore.setState({
    loading: false,
    tokenPresent: true,
    me: { clerkUserId: "u", entitled: true, balanceCents: 100, tokenVersion: 1 },
  } as never);
  useTrialStore.setState({ started: false, loading: false } as never);
});
afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

describe("only OPEN projects get a tab", () => {
  it("renders every project while nothing has been closed (the upgrade path)", () => {
    // Every existing install hydrates with no open set. If that blanked the tab bar it would be
    // the single worst outcome of this change, so it gets its own assertion.
    render(bar());
    expect(screen.getByTestId("tab-p1")).toBeTruthy();
    expect(screen.getByTestId("tab-p2")).toBeTruthy();
    expect(screen.getByTestId("tab-p3")).toBeTruthy();
  });

  it("renders ONLY the open ones once the set exists", () => {
    useUiStore.setState({ openProjectIds: ["p1", "p3"] } as never);
    render(bar());
    expect(screen.getByTestId("tab-p1")).toBeTruthy();
    expect(screen.queryByTestId("tab-p2")).toBeNull();
    expect(screen.getByTestId("tab-p3")).toBeTruthy();
    // …and the project is still very much there. "No tab" ≠ "deleted".
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps the tab order the project list gives, not the open set's", () => {
    useUiStore.setState({ openProjectIds: ["p3", "p1"] } as never);
    render(bar());
    // The tab ROLE is on the label (see the note at the top of this file), so the ids read
    // `tab-label-…`; the order is what this case is about and it is unchanged.
    const ids = screen.getAllByRole("tab").map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["tab-label-p1", "tab-label-p3"]);
  });
});

describe("× closes a tab", () => {
  it("removes the tab without deleting the project, its agents or its worktrees", () => {
    render(bar());
    fireEvent.click(screen.getByTestId("close-p1"));
    expect(screen.queryByTestId("tab-p1")).toBeNull();
    const p1 = useProjectStore.getState().projects.find((p) => p.id === "p1");
    expect(p1).toBeTruthy();
    expect(p1!.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(p1!.agents[0]!.worktreePath).toBe("/wt/a1");
    // No tombstone: projectStore's union merge deletes exactly what removedIds names, so writing
    // one here would make the close permanent AND evict the project across webviews.
    expect(useProjectStore.getState().removedIds ?? {}).toEqual({});
  });

  it("closes only the tab you clicked", () => {
    render(bar());
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(openIds()).toEqual(["p1", "p3"]);
    expect(screen.getByTestId("tab-p1")).toBeTruthy();
    expect(screen.getByTestId("tab-p3")).toBeTruthy();
  });

  it("closing the SELECTED tab selects its right-hand neighbour", () => {
    useProjectStore.setState({ selectedProjectId: "p2" } as never);
    render(bar());
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(selected()).toBe("p3");
    expect(screen.getByTestId("tab-label-p3").getAttribute("aria-selected")).toBe("true");
  });

  it("closing the selected LAST tab falls back to its left-hand neighbour", () => {
    useProjectStore.setState({ selectedProjectId: "p3" } as never);
    render(bar());
    fireEvent.click(screen.getByTestId("close-p3"));
    expect(selected()).toBe("p2");
  });

  it("closing an UNSELECTED tab leaves the selection where it was", () => {
    render(bar());
    fireEvent.click(screen.getByTestId("close-p3"));
    expect(selected()).toBe("p1");
    expect(screen.getByTestId("tab-label-p1").getAttribute("aria-selected")).toBe("true");
  });

  it("does NOT also select the tab it is closing", () => {
    // A <button> turns Enter/Space into a click and BOTH events bubble to the tab's own handlers.
    // Without stopPropagation, closing an unselected tab would select it on the way out — and
    // selectProject stamps lastOpenedAt, so the close would also bump the recency of a project the
    // user was putting away.
    const before = useProjectStore.getState().projects.find((p) => p.id === "p3")!.lastOpenedAt;
    render(bar());
    fireEvent.keyDown(screen.getByTestId("close-p3"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("close-p3"));
    expect(selected()).toBe("p1");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p3")!.lastOpenedAt).toBe(before);
  });

  it("gives the close control an accessible name that names the project", () => {
    // N tabs must not present N identical "Close" buttons, and a bare × next to a project reads as
    // "delete" — so the name says what closing does NOT do.
    render(bar());
    const btn = screen.getByTestId("close-p1");
    expect(btn.tagName).toBe("BUTTON"); // focusable and Enter/Space-activatable by construction
    expect(btn.getAttribute("aria-label")).toBe("Close Alpha — the project and its agents are kept");
    expect(screen.getByTestId("close-p2").getAttribute("aria-label")).toContain("Beta");
  });
});

describe("closing the LAST tab", () => {
  it("empties the bar, clears the selection, and keeps the way back on screen", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    render(bar());
    fireEvent.click(screen.getByTestId("close-p1"));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // A null selection is what routes the shell to its "Welcome to Sparkle — open a project with
    // the +" hint, which is a real state it already renders. Not a blank shell.
    expect(selected()).toBeNull();
    // The "+" survives an empty bar, so the app is never a dead end…
    expect(screen.getByTestId("tab-add")).toBeTruthy();
    // …and every project is still there to be reopened.
    expect(useProjectStore.getState().projects).toHaveLength(3);
  });

  it("distinguishes 'closed everything' from 'never opened anything'", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    render(bar());
    fireEvent.click(screen.getByTestId("close-p1"));
    // [] is a decision the app must honour on the next launch; null would mean "show them all".
    expect(openIds()).toEqual([]);
  });
});

describe("reopening a closed project", () => {
  it("lists it under the + and puts its tab back on one click", async () => {
    render(bar());
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(screen.queryByTestId("tab-p2")).toBeNull();

    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("reopen-p2"));

    await waitFor(() => expect(screen.getByTestId("tab-p2")).toBeTruthy());
    expect(openIds()).toContain("p2");
    expect(selected()).toBe("p2"); // reopening also brings you to it
  });

  it("also comes back through the folder picker, which is the path that survives a restart", async () => {
    // resolveOpenTarget maps the picked folder onto the EXISTING project (same rootPath), so the
    // "+ → choose a folder" flow reopens rather than creating a duplicate.
    render(bar());
    fireEvent.click(screen.getByTestId("close-p2"));
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByText("Choose a folder…"));

    await waitFor(() => expect(screen.getByTestId("tab-p2")).toBeTruthy());
    expect(useProjectStore.getState().projects).toHaveLength(3); // no duplicate project created
    expect(selected()).toBe("p2");
  });

  it("offers nothing to reopen while nothing is closed", () => {
    render(bar());
    fireEvent.click(screen.getByTestId("tab-add"));
    expect(screen.queryByTestId("reopen-section")).toBeNull();
  });

  it("survives a relaunch: the persisted open set is what the bar reads", () => {
    // Same store state a rehydrate would produce — p2 closed before quitting.
    useUiStore.setState({ openProjectIds: ["p1", "p3"] } as never);
    useProjectStore.setState({ selectedProjectId: "p1" } as never);
    render(bar());
    expect(screen.queryByTestId("tab-p2")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
});

describe("the pin follows the tab", () => {
  it("clears a pin whose project was just closed", () => {
    // The pin scopes the concierge's surfaced alerts; with no tab there is nothing to click to
    // clear it, so it would silently zero the vitals.
    useUiStore.setState({ pinnedProjectId: "p2" } as never);
    render(bar());
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });
});
