// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const captureScreenRegion = vi.fn();
const showCaptureWindow = vi.fn();
const emitFocusTier = vi.fn();
const quitApp = vi.fn();
const setHelperBounds = vi.fn();
const hideHelper = vi.fn();
const showHelper = vi.fn();

// Two REAL displays, so the placement path runs for real instead of the degenerate zero-rect
// fallback jsdom otherwise forces (availableMonitors rejects there, and every test then exercises
// the same empty-screens branch). This is what makes the `fresh` wiring testable — the part that
// has broken three times, while the pure math around it stayed green.
const PRIMARY = { position: { x: 0, y: 0 }, size: { width: 1440, height: 900 }, scaleFactor: 1 };
const SECOND = { position: { x: 1440, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
// vi.fn() rather than plain async literals, so a test can override one call and still exercise
// the readScreens() catch branch, which is a real in-Tauri failure path.
vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: vi.fn(async () => [PRIMARY, SECOND]),
  currentMonitor: vi.fn(async () => PRIMARY),
}));

vi.mock("../screenshot", () => ({
  captureScreenRegion: (...a: unknown[]) => captureScreenRegion(...a),
  showCaptureWindow: (...a: unknown[]) => showCaptureWindow(...a),
}));
vi.mock("../services/attention", () => ({
  emitFocusTier: (...a: unknown[]) => emitFocusTier(...a),
  quitApp: (...a: unknown[]) => quitApp(...a),
}));
// Captured so a test can fire the global capture shortcut the way Rust does.
let fireCaptureShortcut: (() => void) | null = null;
vi.mock("../services/helper", () => ({
  getHelperVitals: async () => ({ needsYou: 3, running: 7 }),
  onHelperVitalsChanged: async () => () => {},
  getFrontmost: async () => false,
  onFrontmostChanged: async () => () => {},
  onCaptureRequested: async (cb: () => void) => {
    fireCaptureShortcut = cb;
    return () => {};
  },
  setHelperBounds: (...a: unknown[]) => setHelperBounds(...a),
  showHelper: (...a: unknown[]) => showHelper(...a),
  hideHelper: (...a: unknown[]) => hideHelper(...a),
}));

import { availableMonitors } from "@tauri-apps/api/window";
import { HelperApp } from "./HelperApp";
import { useHelperPrefs } from "./helperPrefs";
// Derived, never hand-copied: a change to TAB_W in helperGeometry moves this test with it. The
// invariant it relies on is stated once, at STRADDLE_INSET below.
import { TAB_W, TAB_H, ISLAND_W } from "./helperGeometry";

const DEFAULTS = { enabled: true, mode: "island", x: null, y: null, edge: "right" };

afterEach(cleanup);

describe("HelperApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fireCaptureShortcut = null;
    // mockRejectedValue below is persistent, and clearAllMocks does not reset implementations —
    // restore the resolving default so one failure test cannot leak into the next case.
    vi.mocked(availableMonitors).mockResolvedValue([PRIMARY, SECOND] as never);
    // Same reasoning, and it applies to every persistent seeding in this file — the resolved ones
    // as much as the rejected ones. Both halves are needed: mockReset drains any one-shot queue
    // (mockResolvedValue replaces the persistent implementation but leaves *Once entries to be
    // consumed by a later test), and the explicit default then NAMES the behaviour an unseeded
    // test gets. null is the Esc path — same as the undefined a bare reset leaves, but chosen
    // rather than incidental, matching the restore-a-default pattern two lines up.
    captureScreenRegion.mockReset();
    captureScreenRegion.mockResolvedValue(null);
    useHelperPrefs.setState(DEFAULTS as never);
  });

  it("renders the island with vitals fetched on mount", async () => {
    render(<HelperApp />);
    await waitFor(() => expect(screen.getByTestId("helper-needs-you").textContent).toContain("3"));
    expect(screen.getByTestId("helper-running").textContent).toContain("7");
  });

  it("renders nothing while the helper is disabled", () => {
    useHelperPrefs.setState({ ...DEFAULTS, enabled: false } as never);
    render(<HelperApp />);
    expect(screen.queryByTestId("helper-root")).toBeNull();
  });

  it("collapsing switches to the tab and persists the mode", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /minimize helper/i }));
    expect(await screen.findByRole("button", { name: /show sparkle helper/i })).toBeTruthy();
    expect(useHelperPrefs.getState().mode).toBe("tab");
  });

  it("clicking the tab restores the island", async () => {
    useHelperPrefs.setState({ ...DEFAULTS, mode: "tab" } as never);
    render(<HelperApp />);
    fireEvent.click(await screen.findByRole("button", { name: /show sparkle helper/i }));
    expect(await screen.findByTestId("helper-needs-you")).toBeTruthy();
  });

  it("capture hides the island BEFORE capturing, then shows the capture window", async () => {
    const shot = { path: "/tmp/a.png" };
    captureScreenRegion.mockResolvedValue(shot);
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalledWith(shot));
    // The island must be out of frame before the crosshairs appear, or it lands in the shot.
    expect(hideHelper).toHaveBeenCalled();
    const hideAt = hideHelper.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const captureAt = captureScreenRegion.mock.invocationCallOrder[0] ?? -1;
    expect(hideAt).toBeLessThan(captureAt);
  });

  it("an Esc at the crosshairs (null) opens no capture window and shows no error", async () => {
    captureScreenRegion.mockResolvedValue(null);
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalled());
    expect(showCaptureWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed capture surfaces the Screen Recording notice", async () => {
    captureScreenRegion.mockRejectedValue(new Error("TCC denied"));
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Screen Recording");
  });

  it("the global shortcut still captures while the island is hidden", async () => {
    // The helper webview stays mounted (and subscribed) when hidden, which is why Rust no longer
    // shows the island before emitting — capture must work either way.
    useHelperPrefs.setState({ ...DEFAULTS, enabled: false } as never);
    const shot = { path: "/tmp/a.png" };
    captureScreenRegion.mockResolvedValue(shot);
    render(<HelperApp />);
    await waitFor(() => expect(fireCaptureShortcut).toBeTypeOf("function"));
    fireCaptureShortcut!();
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalledWith(shot));
  });

  it("a failed shortcut capture does not resurrect a hidden island", async () => {
    // Hide Helper is persisted, so an unconditional showHelper() in the error path would put back
    // an island the user had deliberately dismissed.
    useHelperPrefs.setState({ ...DEFAULTS, enabled: false } as never);
    captureScreenRegion.mockRejectedValue(new Error("TCC denied"));
    render(<HelperApp />);
    await waitFor(() => expect(fireCaptureShortcut).toBeTypeOf("function"));
    fireCaptureShortcut!();
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalled());
    expect(showHelper).not.toHaveBeenCalled();
  });

  it("a failed capture while COLLAPSED shows the notice without persisting the expansion", async () => {
    // Only the island renders the notice, so the display must expand — but `mode` is persisted, and
    // a quit or reload inside the notice window would otherwise undo a deliberate collapse for good.
    useHelperPrefs.setState({ ...DEFAULTS, mode: "tab" } as never);
    captureScreenRegion.mockRejectedValue(new Error("TCC denied"));
    render(<HelperApp />);
    await waitFor(() => expect(fireCaptureShortcut).toBeTypeOf("function"));
    fireCaptureShortcut!();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Screen Recording");
    // The island is what's on screen...
    expect(screen.getByTestId("helper-needs-you")).toBeTruthy();
    // ...but the user's collapsed preference is untouched.
    expect(useHelperPrefs.getState().mode).toBe("tab");
  });

  // The display hit-test has caused three "it jumped to the other monitor" bugs, always by
  // measuring a PERSISTED coordinate with a footprint it was not written under. These two pin the
  // wiring of the PLACEMENT call site — which `fresh` it passes — which the pure hitTestPoint
  // tests cannot reach.
  //
  // Scope, stated plainly: the OTHER hit-test call site, in the drag-release handler, hardcodes
  // `fresh: true` and is NOT covered here — nothing in this file exercises onDragStart. Its `true`
  // is correct (a dragged position is a proposal, not a clamped result), but it is unguarded.
  //
  // Both assertions below are exact, not half-planes: each fails if the placement call site is
  // changed to hitTestPoint(want, true, …).
  const lastBounds = () => setHelperBounds.mock.calls.at(-1) as [number, number, number, number];
  // How far inside PRIMARY to seed the tab. Must be >= 1 AND < TAB_W / 2, so the tab's centre
  // crosses onto SECOND while its top-left stays on PRIMARY — the whole basis of the straddle test
  // below. The Math.max enforces the lower bound rather than merely documenting it: at TAB_W < 4
  // a bare floor gives 0, putting the top-left on the boundary, which screenFor counts as SECOND.
  const STRADDLE_INSET = Math.max(1, Math.floor(TAB_W / 4));

  it("places a persisted tab by its top-left, not its centre", () => {
    // x straddles the PRIMARY/SECOND boundary: the stored top-left is on PRIMARY, while a centre
    // computed from the tab footprint is on SECOND. Testing the top-left is correct, so the tab
    // must snap to PRIMARY's right edge.
    //
    // Both values sit a few px clear of the 1440 boundary on purpose. Landing the mutated centre
    // exactly on it would make this test's discriminating power depend on screenFor's half-open
    // interval — flip that convention, or add rounding to toRect, and the test would quietly go
    // vacuous again, which is the very thing it exists to prevent.
    useHelperPrefs.setState({
      enabled: true, mode: "tab", x: PRIMARY.size.width - STRADDLE_INSET, y: 400, edge: "right",
    } as never);
    render(<HelperApp />);
    return waitFor(() => {
      expect(setHelperBounds).toHaveBeenCalled();
      // If the centre were used, the hit-test resolves to SECOND; nearerEdge then measures the
      // tab against SECOND's own midpoint, finds it in the left half, and snaps to SECOND's LEFT
      // edge — i.e. 1440, not 1424. Different display, different edge, still caught.
      expect(lastBounds()[0]).toBe(PRIMARY.size.width - TAB_W);
    });
  });

  it("keeps a right-docked tab on its display when a capture failure renders it as an island",
    async () => {
    useHelperPrefs.setState({
      enabled: true,
      mode: "tab",
      x: SECOND.position.x + SECOND.size.width - TAB_W,
      y: 400,
      edge: "right",
    } as never);
    captureScreenRegion.mockRejectedValue(new Error("TCC denied"));
    render(<HelperApp />);

    // Let the initial TAB placement land, then forget it — otherwise the assertion below could be
    // satisfied by that earlier call and would prove nothing about the island one.
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    setHelperBounds.mockClear();

    await waitFor(() => expect(fireCaptureShortcut).toBeTypeOf("function"));
    fireCaptureShortcut!();
    await screen.findByRole("alert");

    await waitFor(() => {
      expect(setHelperBounds).toHaveBeenCalled();
      const [bx, , bw] = lastBounds();
      // Width proves this really is the island placement, not a leftover tab one.
      expect(bw).toBe(ISLAND_W);
      // Exact, not a half-plane: resolving the right DISPLAY but clamping against the wrong rect
      // would still satisfy "somewhere on the secondary screen".
      expect(bx).toBe(SECOND.position.x + SECOND.size.width - ISLAND_W);
    });
  });

  it("still places the window when the monitor query fails", async () => {
    // The readScreens() catch branch — a real in-Tauri failure path. Seeded in TAB mode with no
    // remembered position so the degraded placement runs through snapTabToEdge against the zero
    // rect FALLBACK_SCREEN.
    //
    // What that actually covers, precisely: the fresh default is `fallback.width - pillW - 24`,
    // which on a zero rect is -40, so nearerEdge always returns "left" and wantX is screen.x = 0.
    // The right-edge formula is unreachable on this path. The value under test is clampToScreen's
    // maxX of -16 being floored back to 0 — i.e. the window is placed on-screen rather than off
    // its left edge.
    //
    // mockRejectedValue, NOT ...Once: that "left" disagrees with the seeded "right", so setEdge
    // fires and re-runs the effect — a one-shot rejection would already be spent and the second
    // pass would resolve normally, quietly measuring a non-degraded placement instead.
    vi.mocked(availableMonitors).mockRejectedValue(new Error("no monitors"));
    useHelperPrefs.setState({
      enabled: true, mode: "tab", x: null, y: null, edge: "right",
    } as never);
    render(<HelperApp />);
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    // Exact, and it pins the MODE: the tab seed is the point of this case, but an island-mode
    // placement of (0, 0, 268, 44) would satisfy any "on-screen" half-plane just as well, so
    // dropping the seed would silently revert this to covering clampToScreen only.
    expect(lastBounds()).toEqual([0, 0, TAB_W, TAB_H]);
  });

  it("clicking a chiclet asks the app to focus that tier", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByTestId("helper-needs-you"));
    expect(emitFocusTier).toHaveBeenCalledWith({ band: "needs_you" });
    fireEvent.click(screen.getByTestId("helper-running"));
    expect(emitFocusTier).toHaveBeenCalledWith({ band: "running" });
  });

  it("right-click → Hide Helper disables it and persists the choice", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    fireEvent.click(await screen.findByRole("button", { name: /hide helper/i }));
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });

  it("right-click → Quit Sparkle exits the app", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    fireEvent.click(await screen.findByRole("button", { name: /quit sparkle/i }));
    expect(quitApp).toHaveBeenCalledTimes(1);
  });

  it("dismisses the context menu on an outside click", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("helper-menu-scrim"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
