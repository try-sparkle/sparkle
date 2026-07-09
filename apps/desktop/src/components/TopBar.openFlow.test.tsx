// @vitest-environment jsdom
//
// Open / New must ask "replace this window's project, or open a new window?" BEFORE popping the
// native folder picker — when a project is already open in the window. The regression we guard
// against: clicking Open/New went straight to the OS finder, skipping the choice (the picker
// fired before the dialog). Recent (target already known, no picker) must still ask first too.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native folder picker — the thing that must NOT fire until the user has chosen a mode.
const pickProjectFolder = vi.fn<(title?: string) => Promise<string | null>>();
vi.mock("../services/dialog", () => ({
  pickProjectFolder: (title?: string) => pickProjectFolder(title),
  basename: (p: string) => p.split("/").pop() || p,
}));

const openProjectInWindow = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/projectWindows", () => ({
  openProjectInWindow: (...a: unknown[]) => openProjectInWindow(...a),
  defaultDeps: () => ({}),
}));

// One project already open in this window → the dialog is expected.
vi.mock("../windowContext", () => ({
  useCurrentProjectId: () => "proj-open",
  useReplaceCurrentProject: () => vi.fn(),
  useCurrentWindowLabel: () => "main",
}));

const projectStoreState = {
  projects: [{ id: "proj-open", name: "Open One", rootPath: "/tmp/open-one", agents: [] }],
  addProject: vi.fn(() => "proj-new"),
  touchProjectOpened: vi.fn(),
};
vi.mock("../stores/projectStore", () => ({
  useProjectStore: Object.assign((sel: (s: typeof projectStoreState) => unknown) => sel(projectStoreState), {
    getState: () => projectStoreState,
  }),
}));
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: (sel: (s: { status: Record<string, string> }) => unknown) => sel({ status: {} }),
}));
const uiState = {
  activeSpecial: null,
  zoom: 1,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn(),
  setActiveSpecial: vi.fn(),
};
vi.mock("../stores/uiStore", () => ({
  useUiStore: Object.assign((sel: (s: typeof uiState) => unknown) => sel(uiState), {
    getState: () => uiState,
  }),
}));

// Menu-only children that pull their own stores — irrelevant to the open flow.
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./AiFeaturesMenu", () => ({ AiFeaturesMenu: () => null }));
vi.mock("./ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("./AgentOrderToggle", () => ({ AgentOrderToggle: () => null }));
vi.mock("./AccountsScreen", () => ({ AccountsScreen: () => null }));
vi.mock("./AccountLoginModal", () => ({ AccountLoginModal: () => null }));
vi.mock("../services/accountSelection", () => ({ invalidateAccountState: vi.fn() }));

import { TopBar } from "./TopBar";

afterEach(() => cleanup());
beforeEach(() => {
  pickProjectFolder.mockReset();
  pickProjectFolder.mockResolvedValue("/tmp/picked-folder");
  openProjectInWindow.mockClear();
});

const DIALOG_COPY = /Replace the project in this window/i;

describe("TopBar Open/New flow", () => {
  it("Open asks replace-vs-new-window BEFORE the folder picker", async () => {
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    // The choice dialog must appear, and the native picker must NOT have fired yet.
    expect(screen.getByText(DIALOG_COPY)).toBeTruthy();
    expect(pickProjectFolder).not.toHaveBeenCalled();

    // Only after choosing a mode does the folder picker run.
    fireEvent.click(screen.getByRole("button", { name: "Replace current project" }));
    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalledOnce());
  });

  it("New opens the New Project dialog; From folder then runs today's ask-first picker flow", async () => {
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    // New now opens the tabbed New Project dialog (not straight to the folder flow).
    expect(screen.getByRole("tab", { name: "From folder" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "From GitHub" })).toBeTruthy();
    expect(pickProjectFolder).not.toHaveBeenCalled();

    // "From folder" is the default tab → choosing a folder runs the SAME startOpen path, which (a
    // project is open) still asks replace-vs-new BEFORE the picker.
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(screen.getByText(DIALOG_COPY)).toBeTruthy();
    expect(pickProjectFolder).not.toHaveBeenCalled();

    // Exercise the "new window" branch to prove the post-choice picker path isn't special-cased.
    fireEvent.click(screen.getByRole("button", { name: "Open in new window" }));
    await waitFor(() => expect(pickProjectFolder).toHaveBeenCalledOnce());
  });
});
