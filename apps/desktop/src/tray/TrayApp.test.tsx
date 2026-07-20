// @vitest-environment jsdom
//
// Smoke test for TrayApp: outside Tauri, getTrayRoster resolves null and listeners are no-ops,
// so TrayApp renders the empty state. Canvas is unavailable in jsdom — paintTrayIcon must not throw.
// Plus the capture flow (plan Task 2 Step 4): hide popover → crosshair → show capture window.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const hide = vi.fn(() => Promise.resolve());
const show = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    hide: () => hide(),
    show: () => show(),
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

const captureScreenRegion = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
const showCaptureWindow = vi.fn((_shot: unknown) => Promise.resolve());
vi.mock("../screenshot", () => ({
  captureScreenRegion: () => captureScreenRegion(),
  showCaptureWindow: (shot: unknown) => showCaptureWindow(shot),
}));

// Imported statically, AFTER the vi.mock calls above (which vitest hoists). This used to be an
// `await import("./TrayApp")` inside every test, which billed the cold module transform of TrayApp
// and its dep tree to the FIRST test's 5s timeout -- ~5.3s on a loaded machine, so the suite failed
// whenever the box was busy and passed only when a prior test file had already warmed the graph.
import { TrayApp } from "./TrayApp";

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("TrayApp", () => {
  it("renders the empty state with no Tauri backend", async () => {
    render(<TrayApp />);
    await waitFor(() => expect(screen.getByText("No projects running.")).toBeTruthy());
  });
});

describe("TrayApp capture flow", () => {
  const shot = { path: "/tmp/shot.png", dataUrl: "data:image/png;base64,AAA" };

  it("hides the popover, runs the crosshair picker, then shows the capture window with the shot", async () => {
    captureScreenRegion.mockResolvedValueOnce(shot);
    render(<TrayApp />);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalledWith(shot));
    // Popover must be hidden BEFORE the crosshair opens, so it isn't in the shot.
    expect(hide.mock.invocationCallOrder[0]!).toBeLessThan(captureScreenRegion.mock.invocationCallOrder[0]!);
  });

  it("does nothing further when the user cancels the crosshairs (null shot)", async () => {
    captureScreenRegion.mockResolvedValueOnce(null);
    render(<TrayApp />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    fireEvent.click(btn);
    // The button re-enabling is the deterministic "flow settled" point — only then is the
    // negative assertion meaningful.
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(showCaptureWindow).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled(); // Esc is silent — no popover re-show, no error line
  });

  it("disables the button while a capture is in flight, re-enables after", async () => {
    let resolveShot!: (v: unknown) => void;
    captureScreenRegion.mockImplementationOnce(() => new Promise((r) => { resolveShot = r; }));
    render(<TrayApp />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn); // re-entrancy: ignored while disabled
    resolveShot(null);
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(captureScreenRegion).toHaveBeenCalledTimes(1);
  });

  it("re-enables the button when the capture invoke rejects", async () => {
    captureScreenRegion.mockRejectedValueOnce(new Error("screencapture failed"));
    render(<TrayApp />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(showCaptureWindow).not.toHaveBeenCalled();
  });

  it("re-shows the popover with a one-line error when the capture flow fails (spec §9)", async () => {
    captureScreenRegion.mockRejectedValueOnce(new Error("TCC denied"));
    render(<TrayApp />);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(screen.getByText(/Screen Recording/)).toBeTruthy();
  });

  it("still settles when the popover re-show itself rejects", async () => {
    captureScreenRegion.mockRejectedValueOnce(new Error("TCC denied"));
    show.mockRejectedValueOnce(new Error("no window"));
    render(<TrayApp />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    fireEvent.click(btn);
    // The .catch on show() keeps the rejection handled and the flow settling: button
    // re-enables and the error line still renders.
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("clears the error line when a new capture attempt starts", async () => {
    captureScreenRegion.mockRejectedValueOnce(new Error("TCC denied"));
    render(<TrayApp />);
    const btn = screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/Screen Recording/)).toBeTruthy());
    captureScreenRegion.mockResolvedValueOnce(null);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText(/Screen Recording/)).toBeNull());
  });
});
