// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const openProjectInWindow = vi.fn((..._a: unknown[]) => Promise.resolve("created"));
const pickProjectFolder = vi.fn((..._a: unknown[]) => Promise.resolve("/tmp/picked"));
const resolveOpenTarget = vi.fn((..._a: unknown[]) => ({ kind: "existing", id: "p1" }));
const quitApp = vi.fn();
const addProject = vi.fn(() => "new-id");
const touchProjectOpened = vi.fn();

const storeState = {
  projects: [{ id: "p1", name: "Alpha", rootPath: "/a", createdAt: "1", lastOpenedAt: "2" }],
  addProject,
  touchProjectOpened,
};

vi.mock("../stores/projectStore", () => {
  const useProjectStore = (sel: (s: typeof storeState) => unknown) => sel(storeState);
  useProjectStore.getState = () => storeState;
  return { useProjectStore };
});
vi.mock("../services/projectWindows", () => ({
  openProjectInWindow: (...a: unknown[]) => openProjectInWindow(...a),
  defaultDeps: () => ({}),
}));
vi.mock("../services/dialog", () => ({
  pickProjectFolder: (...a: unknown[]) => pickProjectFolder(...a),
  basename: (p: string) => p.split("/").pop(),
}));
vi.mock("../services/openTarget", () => ({ resolveOpenTarget: (...a: unknown[]) => resolveOpenTarget(...a) }));
vi.mock("../services/attention", () => ({ quitApp: () => quitApp() }));
// BalanceBadge self-fetches over Tauri; stub it out for the chrome test.
vi.mock("../components/BalanceBadge", () => ({ BalanceBadge: () => null }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("TrayHeader", () => {
  it("renders the Sparkle logo and the Recent/Open/New actions", async () => {
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={() => {}} />);
    expect(screen.getByAltText("Sparkle")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("Recent ▾")).toBeTruthy();
  });

  it("opens a new project window via the picker, then signals onAction", async () => {
    const onAction = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={onAction} />);
    fireEvent.click(screen.getByText("New"));
    await waitFor(() => expect(openProjectInWindow).toHaveBeenCalledWith("p1", "new", expect.anything()));
    expect(pickProjectFolder).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalled();
  });

  it("expands Recent and opens the chosen project in a window", async () => {
    const onAction = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={onAction} />);
    fireEvent.click(screen.getByText("Recent ▾"));
    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(openProjectInWindow).toHaveBeenCalledWith("p1", "new", expect.anything()));
    expect(onAction).toHaveBeenCalled();
  });
});

describe("TrayFooter", () => {
  it("quits the app when Quit Sparkle is clicked", async () => {
    const { TrayFooter } = await import("./TrayChrome");
    render(<TrayFooter />);
    fireEvent.click(screen.getByText("Quit Sparkle"));
    expect(quitApp).toHaveBeenCalledTimes(1);
  });
});
