// @vitest-environment jsdom
//
// The Recent dropdown shows a "Switch" button on a row ONLY when that project is already open
// in a DIFFERENT window (a live registry label that isn't this window's). Clicking it must
// raise that window (route → openProjectInWindow) WITHOUT triggering the row's normal
// replace-vs-new-window flow — i.e. stopPropagation keeps the row's open handler from firing,
// so no choice dialog appears.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openProjectInWindow = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/projectWindows", () => ({
  openProjectInWindow: (...a: unknown[]) => openProjectInWindow(...a),
  defaultDeps: () => ({}),
}));

// proj-other is open in another window ("win-other"); proj-open is THIS window ("main").
const findWindowForProject = vi.fn((pid: string) =>
  pid === "proj-other" ? "win-other" : pid === "proj-open" ? "main" : null,
);
vi.mock("../services/windowRegistry", () => ({
  findWindowForProject: (pid: string) => findWindowForProject(pid),
}));

// This window currently shows proj-open; its label is "main".
vi.mock("../windowContext", () => ({
  useCurrentProjectId: () => "proj-open",
  useReplaceCurrentProject: () => vi.fn(),
  useCurrentWindowLabel: () => "main",
}));

const projectStoreState = {
  projects: [
    { id: "proj-open", name: "Open One", rootPath: "/tmp/open-one", createdAt: "2026-01-01T00:00:00Z", agents: [] },
    { id: "proj-other", name: "Other Two", rootPath: "/tmp/other-two", createdAt: "2026-01-02T00:00:00Z", agents: [] },
  ],
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
const uiState = { zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), resetZoom: vi.fn() };
vi.mock("../stores/uiStore", () => ({
  useUiStore: Object.assign((sel: (s: typeof uiState) => unknown) => sel(uiState), {
    getState: () => uiState,
  }),
}));

// Menu-only children that pull their own stores — irrelevant here.
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./AiFeaturesMenu", () => ({ AiFeaturesMenu: () => null }));
vi.mock("./ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("./AgentOrderToggle", () => ({ AgentOrderToggle: () => null }));
vi.mock("./AccountsScreen", () => ({ AccountsScreen: () => null }));
vi.mock("./AccountLoginModal", () => ({ AccountLoginModal: () => null }));
vi.mock("../services/accountSelection", () => ({ invalidateAccountState: vi.fn() }));

import { TopBar } from "./TopBar";

afterEach(() => cleanup());
beforeEach(() => openProjectInWindow.mockClear());

const DIALOG_COPY = /Replace the project in this window/i;

describe("TopBar Recent — Switch affordance", () => {
  it("shows Switch only for a project open in another window", () => {
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Recent ▾" }));

    // proj-other is open in "win-other" → exactly one Switch button; proj-open (this window) has none.
    const switches = screen.getAllByRole("button", { name: "Switch" });
    expect(switches).toHaveLength(1);
  });

  it("clicking Switch raises the existing window and does NOT open the choice dialog", () => {
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Recent ▾" }));

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    // Routes the already-open project to be focused (openProjectInWindow short-circuits to focus).
    expect(openProjectInWindow).toHaveBeenCalledTimes(1);
    const [projectId, mode] = openProjectInWindow.mock.calls[0] ?? [];
    expect(projectId).toBe("proj-other");
    expect(mode).toBe("new");
    // stopPropagation kept the row's open handler from firing → no replace-vs-new-window dialog.
    expect(screen.queryByText(DIALOG_COPY)).toBeNull();
  });
});
