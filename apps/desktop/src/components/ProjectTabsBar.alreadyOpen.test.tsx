// @vitest-environment jsdom
//
// THE FOUNDER'S BUG, at the surface he hit it on: he had one repository open twice — `~/Projects/
// sparkle` in the right pair and `~/Projects/sparkle-desktop`, a linked git WORKTREE of it, in the
// left. Opening a project that is already open must focus the existing tab and SAY it is already
// open, never quietly create a second one.
//
// These assert the SIDE EFFECT, not the precondition (AGENTS.md): that `addProject` was NOT called
// and `focusExistingProject` WAS — not merely that a message rendered. Against main every one of
// the dedupe tests fails, because nothing compared two projects by repository at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pickProjectFolder = vi.fn(async (_t?: string) => "/repos/sparkle-desktop" as string | null);
vi.mock("../services/dialog", () => ({
  pickProjectFolder: (t?: string) => pickProjectFolder(t),
  basename: (p: string) => p.split("/").pop() ?? p,
}));

// The REAL resolver — this is the whole point. It maps the picked folder to a project by PATH, and
// for a linked worktree it correctly answers "new" (different folder). Mocking it would assume away
// the exact step the bug lives in.
vi.mock("../services/openTarget", async () => await vi.importActual("../services/openTarget"));

const openProjectTab = vi.fn();
const focusExistingProject = vi.fn();
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: (...a: unknown[]) => openProjectTab(...a),
  focusExistingProject: (...a: unknown[]) => focusExistingProject(...a),
}));

// The repo key is what git would answer. `sparkle-desktop` is a linked worktree of `sparkle`, so
// `git rev-parse --git-common-dir` from either resolves to the SAME `.git`.
const REPO = "/repos/sparkle/.git";
const repoKeyFor = vi.fn(async (path: string) =>
  path.startsWith("/repos/sparkle") ? REPO : `${path}/.git`,
);
vi.mock("../services/repoKey", () => ({
  backfillRepoKeys: async () => {},
  repoKeyFor: (p: string) => repoKeyFor(p),
  resolveRepoKeyFor: async () => null,
}));

vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => <div data-testid="topright" /> }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./TrialChrome", () => ({ TrialIndicator: () => <div data-testid="trial" /> }));
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
      <button data-testid="reopen-wt" onClick={() => onReopen("wt")}>
        Reopen worktree
      </button>
    </>
  ),
}));

import { ProjectTabsBar } from "./ProjectTabsBar";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import type { ConciergeFeed } from "../services/conciergeFeed";
import type { Project } from "../types";

function mkProject(id: string, name: string, rootPath: string, repoKey?: string | null): Project {
  return {
    id, name, rootPath, defaultBranch: null, repoKey,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
  };
}

const SPARKLE = mkProject("sparkle", "sparkle", "/repos/sparkle", REPO);
/** The linked worktree, as a project record that EXISTS but is closed. */
const WORKTREE = mkProject("wt", "sparkle-desktop", "/repos/sparkle-desktop", REPO);
const OTHER = mkProject("other", "tkmx", "/repos/tkmx", "/repos/tkmx/.git");

const feed: ConciergeFeed = {
  projects: [],
  counts: { needs_you: 0, running: 0, done: 0 },
} as unknown as ConciergeFeed;

function renderBar(side: "left" | "right" = "left") {
  return render(
    <ProjectTabsBar feed={feed} onOpenProjectSettings={() => {}} side={side} />,
  );
}

/** Open the "+" dialog and take the folder-picker path. */
async function pickFolder() {
  fireEvent.click(screen.getByTestId("tab-add"));
  fireEvent.click(await screen.findByTestId("from-folder"));
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    projects: [SPARKLE, WORKTREE, OTHER],
    selectedProjectId: "sparkle",
  });
  useUiStore.setState({
    // sparkle is open on the RIGHT; the worktree record exists but has no tab.
    openProjectIds: ["sparkle", "other"],
    pairAssignment: {},
    leftProjectId: null,
    pinnedProjectId: null,
  });
  useAuthStore.setState({ loading: false, tokenPresent: false, me: null, paywallDismissed: true });
  useTrialStore.setState({ started: false, loading: false });
});

afterEach(cleanup);

describe("picking the folder of a project whose REPOSITORY is already open", () => {
  it("does NOT create a second project, and focuses the one already open", async () => {
    const addSpy = vi.spyOn(useProjectStore.getState(), "addProject");
    const before = useProjectStore.getState().projects.length;
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });

    await waitFor(() => expect(screen.getByTestId("already-open-notice")).toBeTruthy());
    // THE SIDE EFFECT: no new record, and the incumbent was focused.
    expect(addSpy).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects.length).toBe(before);
    expect(focusExistingProject).toHaveBeenCalledWith("sparkle");
    expect(openProjectTab).not.toHaveBeenCalled();
  });

  it("names BOTH folders, because the tab the user is sent to has the other name", async () => {
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    const text = (await screen.findByTestId("already-open-notice")).textContent ?? "";
    expect(text).toMatch(/same repository/i);
    expect(text).toContain("sparkle-desktop");
    expect(text).toMatch(/right pair/);
  });

  it("offers Open anyway — two worktrees side by side is a legitimate workflow", async () => {
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    const anyway = await screen.findByTestId("already-open-anyway");

    await act(async () => {
      fireEvent.click(anyway);
    });
    // The override COMMITS the open it previously withheld — the escape hatch has to actually work,
    // or the gate is a refusal wearing a button.
    await waitFor(() => expect(openProjectTab).toHaveBeenCalled());
    expect(screen.queryByTestId("already-open-notice")).toBeNull();
  });

  it("re-gates the NEXT open: the override is one-shot, not a session opt-out", async () => {
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId("already-open-anyway"));
    });
    vi.clearAllMocks();
    // Same folder again. Whatever the first attempt created, the gate must fire again rather than
    // silently letting a third tab through.
    await act(async () => {
      await pickFolder();
    });
    await waitFor(() => expect(screen.getByTestId("already-open-notice")).toBeTruthy());
  });
});

describe("picking the folder of a project that ITSELF already has a tab", () => {
  // The other branch of the gate, and the one no test reached: `findDuplicateOpen` excludes the
  // candidate by id (a record is not a duplicate of itself), so this case is handled separately and
  // a regression that dropped it would leave every other test green.
  it("focuses it, says so, and offers NO override — a project cannot have two tabs", async () => {
    pickProjectFolder.mockResolvedValueOnce("/repos/sparkle");
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    await waitFor(() => expect(screen.getByTestId("already-open-notice")).toBeTruthy());
    expect(focusExistingProject).toHaveBeenCalledWith("sparkle");
    expect(openProjectTab).not.toHaveBeenCalled();
    // A second tab for ONE record is not representable, so there is nothing to override.
    expect(screen.queryByTestId("already-open-anyway")).toBeNull();
  });
});

describe("reopening a closed project whose repository is already open", () => {
  it("is gated too — covering only the picker is how this bug returns", async () => {
    renderBar("left");
    fireEvent.click(screen.getByTestId("tab-add"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("reopen-wt"));
    });
    await waitFor(() => expect(screen.getByTestId("already-open-notice")).toBeTruthy());
    expect(focusExistingProject).toHaveBeenCalledWith("sparkle");
    expect(openProjectTab).not.toHaveBeenCalled();
  });
});

describe("what must still work — the legitimate cases", () => {
  it("a genuinely different repository opens with no notice at all", async () => {
    pickProjectFolder.mockResolvedValueOnce("/repos/brand-new");
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    await waitFor(() => expect(openProjectTab).toHaveBeenCalled());
    expect(screen.queryByTestId("already-open-notice")).toBeNull();
  });

  it("a project whose repository is CLOSED reopens silently — nothing is on screen to collide", async () => {
    // Close sparkle, leaving only the worktree record open-able. This is the narrowing the picker
    // refusal already learned once: never claim "already open" about something open nowhere.
    act(() => {
      useUiStore.setState({ openProjectIds: ["other"] });
    });
    renderBar("left");
    await act(async () => {
      await pickFolder();
    });
    await waitFor(() => expect(openProjectTab).toHaveBeenCalled());
    expect(screen.queryByTestId("already-open-notice")).toBeNull();
  });
});
