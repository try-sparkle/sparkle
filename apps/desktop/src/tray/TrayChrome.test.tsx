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
  it("renders the Sparkle logo and the Recent/Open actions (New merged into Open)", async () => {
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={() => {}} onCapture={() => {}} />);
    expect(screen.getByAltText("Sparkle")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    // "New" was merged into the single "Open" button — it no longer renders on its own.
    expect(screen.queryByText("New")).toBeNull();
    expect(screen.getByText("Recent ▾")).toBeTruthy();
  });

  it("opens a project window via the picker, then signals onAction", async () => {
    const onAction = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={onAction} onCapture={() => {}} />);
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => expect(openProjectInWindow).toHaveBeenCalledWith("p1", "new", expect.anything()));
    expect(pickProjectFolder).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalled();
  });

  it("expands Recent and opens the chosen project in a window", async () => {
    const onAction = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={onAction} onCapture={() => {}} />);
    fireEvent.click(screen.getByText("Recent ▾"));
    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(openProjectInWindow).toHaveBeenCalledWith("p1", "new", expect.anything()));
    expect(onAction).toHaveBeenCalled();
  });
});

describe("TrayHeader Capture button", () => {
  it("renders a Capture button with a 4px radius and the camera+waveform stroke icon", async () => {
    const { TrayHeader } = await import("./TrayChrome");
    const { container } = render(<TrayHeader onAction={() => {}} onCapture={() => {}} />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    expect(btn.style.borderRadius).toBe("4px");
    // Approved icon: inline stroke SVG (no emoji) — camera body + lens circle + waveform bars.
    const svg = container.querySelector('svg[viewBox="0 0 30 24"]');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.querySelector("circle")).toBeTruthy();
    expect(svg!.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });

  it("fires onCapture on click without also firing onAction (the flow hides the popover itself)", async () => {
    const onAction = vi.fn();
    const onCapture = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={onAction} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("is disabled while a capture is in flight (re-entrancy guard)", async () => {
    const onCapture = vi.fn();
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={() => {}} onCapture={onCapture} captureBusy />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("renders the one-line capture error as an alert when captureError is set", async () => {
    const { TrayHeader } = await import("./TrayChrome");
    render(<TrayHeader onAction={() => {}} onCapture={() => {}} captureError="Capture failed — check Screen Recording in System Settings." />);
    // role="alert" so assistive tech announces the failure — query by role to pin it.
    expect(screen.getByRole("alert").textContent).toMatch(/Screen Recording/);
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
