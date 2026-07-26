// @vitest-environment jsdom
//
// The live tab bar (bead sparkle-qd80 / CM-U7) — the chrome that replaced TopBar. What must hold:
// the per-tab P0/P1 badges come from the concierge feed, "+" opens a project by selecting its TAB
// (never a window), and the project-settings entry TopBar's project button used to own still exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pickProjectFolder = vi.fn(async (_title?: string) => "/tmp/picked" as string | null);
vi.mock("../services/dialog", () => ({
  pickProjectFolder: (t?: string) => pickProjectFolder(t),
  basename: (p: string) => p.split("/").pop() ?? p,
}));
const resolveOpenTarget = vi.fn(() => ({ kind: "existing", id: "p2" }) as const);
vi.mock("../services/openTarget", () => ({ resolveOpenTarget: () => resolveOpenTarget() }));

const openProjectTab = vi.fn();
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: (...a: unknown[]) => openProjectTab(...a),
}));

// Chrome that self-fetches over Tauri — out of scope here.
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => <div data-testid="topright" /> }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./TrialChrome", () => ({ TrialIndicator: () => <div data-testid="trial" /> }));
vi.mock("./NewProjectDialog", () => ({
  NewProjectDialog: ({ onOpenFromFolder }: { onOpenFromFolder: () => void }) => (
    <button data-testid="from-folder" onClick={onOpenFromFolder}>
      From folder
    </button>
  ),
}));

import { ProjectTabsBar, countsFromFeed } from "./ProjectTabsBar";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import type { ConciergeFeed } from "../services/conciergeFeed";
import type { Project } from "../types";

function mkProject(id: string, name: string): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
  };
}

const feed: ConciergeFeed = {
  projects: [
    { id: "p1", name: "Alpha", inScope: true, counts: { p0: 2, p1: 1 }, agents: [] },
    { id: "p2", name: "Beta", inScope: true, counts: { p0: 0, p1: 3 }, agents: [] },
  ],
  counts: { p0: 2, p1: 4 },
  scopedCounts: { p0: 2, p1: 4 },
  pinnedProjectId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha"), mkProject("p2", "Beta")],
    selectedProjectId: "p1",
  } as never);
  useUiStore.setState({ pinnedProjectId: null } as never);
  // Entitled + loaded → not in trial, so the trial chip stays out of the way by default.
  useAuthStore.setState({
    loading: false,
    tokenPresent: true,
    me: { clerkUserId: "u", entitled: true, balanceCents: 100, tokenVersion: 1 },
  } as never);
  useTrialStore.setState({ started: false, loading: false } as never);
});
afterEach(() => cleanup());

describe("countsFromFeed", () => {
  it("keys each project's raw P0/P1 totals by project id", () => {
    expect(countsFromFeed(feed)).toEqual({ p1: { p0: 2, p1: 1 }, p2: { p0: 0, p1: 3 } });
  });
  it("is empty for an empty feed (no tab claims a count it doesn't have)", () => {
    expect(countsFromFeed({ ...feed, projects: [] })).toEqual({});
  });
});

describe("ProjectTabsBar", () => {
  it("badges each tab from the feed — P0 wins over P1", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.getByTestId("count-p1").textContent).toBe("2·P0");
    expect(screen.getByTestId("count-p2").textContent).toBe("3·P1");
  });

  it("shows no badge for a calm project", () => {
    const calm = { ...feed, projects: feed.projects.map((p) => ({ ...p, counts: { p0: 0, p1: 0 } })) };
    render(<ProjectTabsBar feed={calm} onOpenProjectSettings={() => {}} />);
    expect(screen.queryByTestId("count-p1")).toBeNull();
  });

  it('"+" → picker → selects the resolved project\'s TAB (never opens a window)', async () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    await waitFor(() => expect(openProjectTab).toHaveBeenCalledWith("p2"));
    expect(pickProjectFolder).toHaveBeenCalled();
  });

  it("a cancelled picker opens nothing", async () => {
    pickProjectFolder.mockResolvedValueOnce(null as unknown as string);
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalled());
    expect(openProjectTab).not.toHaveBeenCalled();
  });

  it("double-clicking a tab opens that project's settings (TopBar's old entry point)", () => {
    const onOpenProjectSettings = vi.fn();
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={onOpenProjectSettings} />);
    fireEvent.doubleClick(screen.getByTestId("tab-p2"));
    expect(onOpenProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p2", name: "Beta" }),
    );
  });

  it("carries the top-right cluster (kebab + avatar)", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.getByTestId("topright")).toBeTruthy();
  });

  it("shows the trial counter only while in trial (parity #14)", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.queryByTestId("trial")).toBeNull();
    cleanup();
    // Anonymous trial: no token, no `me`, trial started.
    useAuthStore.setState({ loading: false, tokenPresent: false, me: null } as never);
    useTrialStore.setState({ started: true, loading: false } as never);
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.getByTestId("trial")).toBeTruthy();
  });
});
