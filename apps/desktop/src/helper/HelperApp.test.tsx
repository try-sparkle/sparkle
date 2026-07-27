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
const showMainWindow = vi.fn();

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
// Likewise for `capture://closed`, which Rust emits from hide_capture_window when the user is done
// with the takeover. Without a way to fire it, the takeover-suppression tests could only prove the
// island stays hidden, never that it comes back.
let fireCaptureClosed: (() => void) | null = null;
// `capture://send`, emitted by CaptureApp.send() a beat BEFORE it asks Rust to hide the takeover.
let fireCaptureSend: (() => void) | null = null;
// …and the frontmost transitions, so a test can play the real send ordering: closed (frontmost
// still false, the takeover is excluded from the policy) THEN the raise at the end of the dispatch.
let fireFrontmost: ((f: boolean) => void) | null = null;
// The seed. Mirrors getFrontmost/getHelperVitals; a test overrides it to mount the helper under an
// already-open takeover, or to hand the recovery re-poll a "the takeover is gone" answer.
const getTakeoverOpen = vi.fn(async (): Promise<boolean | null> => false);
vi.mock("../services/helper", () => ({
  getHelperVitals: async () => ({ needsYou: 3, running: 7 }),
  onHelperVitalsChanged: async () => () => {},
  getFrontmost: async () => false,
  onFrontmostChanged: async (cb: (f: boolean) => void) => {
    fireFrontmost = cb;
    return () => {};
  },
  onCaptureRequested: async (cb: () => void) => {
    fireCaptureShortcut = cb;
    return () => {};
  },
  onCaptureClosed: async (cb: () => void) => {
    fireCaptureClosed = cb;
    return () => {};
  },
  onCaptureSend: async (cb: () => void) => {
    fireCaptureSend = cb;
    return () => {};
  },
  getTakeoverOpen: () => getTakeoverOpen(),
  setHelperBounds: (...a: unknown[]) => setHelperBounds(...a),
  showHelper: (...a: unknown[]) => showHelper(...a),
  hideHelper: (...a: unknown[]) => hideHelper(...a),
  showMainWindow: (...a: unknown[]) => showMainWindow(...a),
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
    fireCaptureClosed = null;
    fireCaptureSend = null;
    fireFrontmost = null;
    // Same restore-a-default pattern as availableMonitors below: mockReset drains any *Once queue a
    // previous case left behind, and the explicit default NAMES what an unseeded test gets — no
    // takeover on screen, which is the ordinary mount.
    getTakeoverOpen.mockReset();
    getTakeoverOpen.mockResolvedValue(false);
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

  // ---- the island must never float over the takeover (roborev 53320-M) ----
  //
  // showCaptureWindow resolves when the takeover is SHOWN, not when the user dismisses it. So
  // captureBusy flips false while the annotation session is only just starting, the visibility
  // effect re-runs, and — because the capture panel is deliberately excluded from `frontmost` —
  // `frontmost` is STILL false, so the rule says "show". The island (always-on-top) then sat over
  // the full-monitor takeover with a live Capture button, which starts a second crosshair capture
  // on top of the open one. The deleted TrayApp did not have this bug.

  it("does NOT re-show the island once the takeover is up", async () => {
    captureScreenRegion.mockResolvedValue({ path: "/tmp/a.png" });
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    // The mount placement releases the first-show gate; forget that show so the assertion below is
    // about the takeover and nothing else.
    await waitFor(() => expect(showHelper).toHaveBeenCalled());
    showHelper.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalled());

    // Let every pending effect settle — the bug is precisely a LATER effect run, so asserting
    // immediately after the await would pass even unfixed.
    await new Promise((r) => setTimeout(r, 20));
    expect(showHelper).not.toHaveBeenCalled();
  });

  it("brings the island back when the takeover closes", async () => {
    // The other half: suppression that never lifts is just a differently-broken island.
    captureScreenRegion.mockResolvedValue({ path: "/tmp/a.png" });
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    showHelper.mockClear();

    await waitFor(() => expect(fireCaptureClosed).toBeTypeOf("function"));
    fireCaptureClosed!();
    await waitFor(() => expect(showHelper).toHaveBeenCalled());
  });

  // ---- the takeover latch must not flash, and must not strand (roborev 53339 / 53341-M) ----

  /** Drive a capture through to an open takeover, then forget every show that got us there, so the
   *  assertions below are about what happens NEXT and nothing else. */
  async function openTakeover() {
    captureScreenRegion.mockResolvedValue({ path: "/tmp/a.png" });
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    showHelper.mockClear();
  }

  it("does not flash the island between a send and the main window being raised", async () => {
    // The primary flow, in its real order. CaptureApp.send() emits `capture://send` and then calls
    // hideCaptureWindow(), so Rust's `capture://closed` arrives while `frontmost` is STILL false —
    // the takeover is deliberately excluded from the frontmost policy and the main window has not
    // been raised yet. Lifting the suppression on that edge showed the island, and the raise at the
    // tail of handleCaptureSend (selectProject → dispatch → focusThisWindow) hid it again a beat
    // later: pop-and-vanish on every send from outside Sparkle.
    await openTakeover();
    await waitFor(() => expect(fireCaptureSend).toBeTypeOf("function"));

    fireCaptureSend!();
    fireCaptureClosed!();

    // Long enough to outlast the dismissal settle — the suppression must be held by the SEND, not
    // merely deferred by a few frames. A dispatch is slower than this.
    await new Promise((r) => setTimeout(r, 400));
    expect(showHelper).not.toHaveBeenCalled();

    // …and when the raise finally lands, the rule hides the island because Sparkle is frontmost.
    // It must never have been shown in between.
    fireFrontmost!(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(showHelper).not.toHaveBeenCalled();
    expect(hideHelper).toHaveBeenCalled();
  });

  it("seeds the takeover state on mount, so a helper that reloads under it does not paint over it",
    async () => {
    // `capture://closed` is an EDGE. A helper webview that mounts (or crashes and reloads) while
    // the takeover is up misses every edge that came before it, so an event-only latch starts false
    // and the island paints itself over the full-monitor takeover — the exact bug the latch was
    // added to fix, reintroduced by the fix's own shape. Hence the seed, like vitals and frontmost.
    getTakeoverOpen.mockResolvedValue(true);
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    // Placement lands and would otherwise release the first-show gate; wait past it.
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(showHelper).not.toHaveBeenCalled();
  });

  it("recovers the island when `capture://closed` never arrives", async () => {
    // ⌘W on the key window (the takeover, by design, while it is up), a webview crash, or a
    // `win.hide()` that fails — all reach the same place: the close edge is never emitted. With one
    // clearing edge and no fallback, the island is then suppressed for the REST OF THE SESSION with
    // no way back: it is hidden, so its context menu is unreachable, and re-enabling it from the
    // main window hits the same early return. The frontmost gain re-polls Rust instead of trusting
    // the latch, so the suppression can never outlive the window it describes.
    await openTakeover();
    // The takeover really is gone; nothing told the island.
    getTakeoverOpen.mockResolvedValue(false);
    await waitFor(() => expect(fireFrontmost).toBeTypeOf("function"));

    // The user Cmd-Tabs to Sparkle and back out again. No `capture://closed` at any point.
    fireFrontmost!(true);
    await new Promise((r) => setTimeout(r, 20));
    fireFrontmost!(false);

    await waitFor(() => expect(showHelper).toHaveBeenCalled());
  });

  it("an Esc at the crosshairs (null) opens no capture window and shows no error", async () => {
    captureScreenRegion.mockResolvedValue(null);
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.click(screen.getByRole("button", { name: /capture/i }));
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalled());
    expect(showCaptureWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    // No takeover opened, so nothing suppresses the island: it must come back on its own rather
    // than wait for a `capture://closed` that Rust will never emit.
    await waitFor(() => expect(showHelper).toHaveBeenCalled());
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

  // ---- the island must be PLACED before it is SHOWN (roborev 53320-M) ----

  it("does not show the island until its geometry has landed", async () => {
    // `init_helper_window` builds the window with no `.position(...)`, so a show before the first
    // setHelperBounds puts it at whatever origin the OS assigned and it then jumps. The visibility
    // effect wins that race by default: `frontmost` initialises false and `enabled` hydrates
    // synchronously true, so showHelper() fired while placement was still behind `await
    // readScreens()`. Every launch flashed the island in the wrong place.
    render(<HelperApp />);
    await waitFor(() => expect(showHelper).toHaveBeenCalled());
    // Ordinals, not "was it called": both calls happen either way — only the ORDER is the bug.
    expect(setHelperBounds.mock.invocationCallOrder[0]).toBeLessThan(
      showHelper.mock.invocationCallOrder[0]!,
    );
  });

  it("still shows the island when the monitor query fails", async () => {
    // The gate must be released on the DEGRADED placement path too, or an in-Tauri monitor failure
    // would leave the island permanently invisible — a worse bug than the flash it replaces.
    vi.mocked(availableMonitors).mockRejectedValue(new Error("no monitors"));
    render(<HelperApp />);
    await waitFor(() => expect(showHelper).toHaveBeenCalled());
  });

  it("right-click → Open Sparkle reveals the main window", async () => {
    // The Dock icon is the documented way back, but it is not discoverable from out here, and the
    // tray's "Open" item was deleted with the tray (roborev 53313-H).
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    fireEvent.click(await screen.findByRole("button", { name: /open sparkle/i }));
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    // …and the menu closes behind it, like every other item.
    expect(screen.queryByRole("menu")).toBeNull();
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
