// @vitest-environment jsdom
//
// The live tab bar (bead sparkle-qd80 / CM-U7) — the chrome that replaced TopBar. What must hold:
// the per-tab P0/P1 badges come from the concierge feed, "+" opens a project by selecting its TAB
// (never a window), and the project-settings entry TopBar's project button used to own still exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
// `onReopen` is rendered too: without it the reopen-list path was unreachable from the suite, which
// is why the stale-banner clear could land on `pickAndOpen` alone and look covered (roborev 55211).
vi.mock("./NewProjectDialog", () => ({
  NewProjectDialog: ({
    onOpenFromFolder,
    onReopen,
  }: {
    onOpenFromFolder: () => void;
    onReopen: (id: string) => void;
  }) => (
    <>
      <button data-testid="from-folder" onClick={onOpenFromFolder}>
        From folder
      </button>
      <button data-testid="reopen-p2" onClick={() => onReopen("p2")}>
        Reopen Beta
      </button>
    </>
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
    // Alpha needs you twice over; Beta only has work in flight, which must not badge.
    // `scopedCounts` mirrors `counts` here — nothing is muted or pinned away in this fixture. The
    // BADGES read `counts` (the raw truth); the concierge header reads the scoped share.
    { id: "p1", name: "Alpha", inScope: true, counts: { needs_you: 2, running: 1, done: 0 }, scopedCounts: { needs_you: 2, running: 1, done: 0 }, agents: [] },
    { id: "p2", name: "Beta", inScope: true, counts: { needs_you: 0, running: 3, done: 4 }, scopedCounts: { needs_you: 0, running: 3, done: 4 }, agents: [] },
  ],
  counts: { needs_you: 2, running: 4, done: 4 },
  scopedCounts: { needs_you: 2, running: 4, done: 4 },
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
  it("keys each project's raw per-band totals by project id", () => {
    expect(countsFromFeed(feed)).toEqual({
      p1: { needs_you: 2, running: 1, done: 0 },
      p2: { needs_you: 0, running: 3, done: 4 },
    });
  });
  it("is empty for an empty feed (no tab claims a count it doesn't have)", () => {
    expect(countsFromFeed({ ...feed, projects: [] })).toEqual({});
  });
});

describe("ProjectTabsBar", () => {
  it("badges each tab from the feed — only Needs-you badges, and it agrees in number", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.getByTestId("count-p1").textContent).toBe("2 Need you");
    // Beta is 3 running / 4 done and gets NO badge — in-flight work is not an alert.
    expect(screen.queryByTestId("count-p2")).toBeNull();
  });

  it("shows no badge for a calm project", () => {
    const calm = {
      ...feed,
      projects: feed.projects.map((p) => ({ ...p, counts: { needs_you: 0, running: 0, done: 0 } })),
    };
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

  it("selects another project's tab through the one open path", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-p2"));
    expect(openProjectTab).toHaveBeenCalledWith("p2");
  });

  it("does NOTHING when the already-selected tab is clicked", () => {
    // A re-click isn't a navigation: routing it through openProjectTab would clear the app-global
    // Improve Sparkle pane, closing what the user is working in for no reason (roborev 46280-M).
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-p1")); // p1 is the selected project
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

  // THE TOP-RIGHT CLUSTER IS NOT HERE ANY MORE. `ConciergeTopRight` (kebab + signed-in avatar)
  // moved into the concierge's own header when that consolidated to one row: this bar belongs to a
  // PAIR, and neither the avatar nor the app menu is a per-project control.
  //
  // This assertion is INVERTED rather than deleted, because the failure mode of the move is that
  // both copies render at once — which is what shipped for one commit (roborev 54712). Note it can
  // only speak about the stub, since this file mocks the module; the real double-mount is counted
  // with both surfaces live in ProjectTabsBar.duplicateChrome.test.tsx.
  it("no longer carries the top-right cluster — it lives in the concierge header", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} />);
    expect(screen.queryByTestId("topright")).toBeNull();
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

// ── THE SECOND PAIR ───────────────────────────────────────────────────────────────────────────
//
// These exist because their absence is what let a fix regress: every existing picker test renders
// the DEFAULT `side="right"`, where `sideOf(...) !== side` can never be true, so the whole left-strip
// branch was unreachable from the suite. (roborev 55200)
describe("ProjectTabsBar — the left strip", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [mkProject("p1", "Alpha"), mkProject("p2", "Beta")],
      selectedProjectId: "p1",
    } as never);
    openProjectTab.mockClear();
  });

  it("refuses a folder whose project is OPEN in the other pair, and says where it is", () => {
    // p2 is right-assigned (absent from the map) and its tab is open, so the left strip genuinely
    // cannot show it — and moving it would remount its panes and kill its PTYs.
    useUiStore.setState({ pairAssignment: {}, openProjectIds: ["p1", "p2"] } as never);
    render(<ProjectTabsBar side="left" feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    return waitFor(() => {
      expect(screen.getByTestId("tear-off-error").textContent).toContain("right pair");
      expect(openProjectTab).not.toHaveBeenCalled();
    });
  });

  it("REOPENS a closed project instead of claiming it is open elsewhere", () => {
    // The regression the refusal introduced: `sideOf` answers "which pair owns it", not "does it
    // have a tab", so a closed project tripped the refusal and was told it was already open — a
    // sentence describing a state that did not exist, on a path that used to reopen it.
    useUiStore.setState({ pairAssignment: {}, openProjectIds: ["p1"] } as never);
    render(<ProjectTabsBar side="left" feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    return waitFor(() => {
      expect(openProjectTab).toHaveBeenCalledWith("p2");
      // …and it SAYS where the tab went. Reopening on its own side is right (moving it would kill
      // its PTYs) but doing it silently from this strip is the defect the reopen-list filter exists
      // to prevent: the tab lands in the other pair and this strip shows nothing.
      expect(screen.getByTestId("tear-off-error").textContent).toContain("reopened in the right pair");
    });
  });

  it("clears a stale refusal on the REOPEN path too, not just the picker", () => {
    // The clear used to live in `pickAndOpen`, so the reopen list — reached by hitting "+" again
    // after the dialog closed on the refusing click — still showed the old message over a project
    // it had nothing to do with.
    useUiStore.setState({ pairAssignment: {}, openProjectIds: ["p1", "p2"] } as never);
    render(<ProjectTabsBar side="left" feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    return waitFor(() => expect(screen.getByTestId("tear-off-error")).toBeTruthy()).then(() => {
      fireEvent.click(screen.getByTestId("reopen-p2"));
      expect(screen.queryByTestId("tear-off-error")).toBeNull();
    });
  });

  it("expires the reopened-elsewhere notice on the next tab selection", () => {
    // It is an EVENT in a banner with no timeout. Selecting a tab is the next deliberate act on
    // this strip, by which point the notice has been read.
    // p2 is CLOSED and left-assigned, so picking its folder from the right strip reopens it on its
    // own side and announces where it went — rather than refusing, which needs it to be OPEN there.
    useUiStore.setState({ pairAssignment: { p2: "left" }, openProjectIds: ["p1"] } as never);
    render(<ProjectTabsBar side="right" feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    return waitFor(() => {
      expect(screen.getByTestId("tear-off-error").textContent).toContain("reopened in the left pair");
    }).then(() => {
      fireEvent.click(screen.getByTestId("tab-p1"));
      expect(screen.queryByTestId("tear-off-error")).toBeNull();
    });
  });

  it("clears a stale refusal once a later pick succeeds", () => {
    // The banner only ever got set, so a refusal outlived the situation it described and sat over a
    // freshly opened project telling the user it was somewhere else.
    useUiStore.setState({ pairAssignment: {}, openProjectIds: ["p1", "p2"] } as never);
    render(<ProjectTabsBar side="left" feed={feed} onOpenProjectSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("tab-add"));
    fireEvent.click(screen.getByTestId("from-folder"));
    return waitFor(() => expect(screen.getByTestId("tear-off-error")).toBeTruthy()).then(() => {
      // Now the same pick resolves to a project this strip CAN open. `act`, so the component
      // actually re-reads the assignment rather than refusing again off a stale closure.
      act(() => {
        useUiStore.setState({ pairAssignment: { p2: "left" } } as never);
      });
      fireEvent.click(screen.getByTestId("from-folder"));
      return waitFor(() => {
        expect(openProjectTab).toHaveBeenCalledWith("p2");
        expect(screen.queryByTestId("tear-off-error")).toBeNull();
      });
    });
  });
});
