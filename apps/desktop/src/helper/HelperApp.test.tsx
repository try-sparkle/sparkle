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
const setHelperMenuState = vi.fn();

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

// The input-release hatch subscribes here. Mocked deliberately rather than left to reject: without
// it every test in this file exercises the `listen`-rejection branch, and the helper's own hatch
// coverage below could not tell a wired subscriber from an unwired one.
let fireInputRelease: (() => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_e: string, cb: () => void) => {
    fireInputRelease = cb;
    return () => {};
  }),
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
// The native menu bar's "View → Hide/Show Helper", which Rust forwards as a payload-free
// `helper://toggle-requested`. It is the guaranteed way back for a dismissed island, so a test has
// to be able to play it — nothing else in the webview can re-enable the helper.
let fireMenuToggle: (() => void) | null = null;
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
  onHelperToggleRequested: async (cb: () => void) => {
    fireMenuToggle = cb;
    return () => {};
  },
  setHelperMenuState: (...a: unknown[]) => setHelperMenuState(...a),
}));

import { availableMonitors } from "@tauri-apps/api/window";
import { HelperApp } from "./HelperApp";
import { resetInputReleaseCoalescing } from "../services/inputRelease";
import { useHelperPrefs } from "./helperPrefs";
// Derived, never hand-copied: a change to TAB_W in helperGeometry moves this test with it. The
// invariant it relies on is stated once, at STRADDLE_INSET below.
import { TAB_W, TAB_H, ISLAND_W, ISLAND_H, ERROR_W } from "./helperGeometry";

const DEFAULTS = { enabled: true, mode: "island", x: null, y: null, edge: "right" };

afterEach(cleanup);

describe("HelperApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fireCaptureShortcut = null;
  // Reset like its five siblings: a stale capture makes a later case pass for the wrong reason —
  // `waitFor(() => expect(fireInputRelease).not.toBeNull())` would be satisfied instantly by an
  // EARLIER test's assignment, and the captured handler closes over module state with no per-install
  // identity, so firing it still performs a full release. That made the mutation-check result
  // ordering-dependent rather than structural (roborev 59717).
  fireInputRelease = null;
  // The release is DEBOUNCED (services/inputRelease), and successive cases run milliseconds apart —
  // well inside the window — so without this the second and later release cases are suppressed by
  // the FIRST one's release rather than exercising their own trigger.
  resetInputReleaseCoalescing();
    fireCaptureClosed = null;
    fireCaptureSend = null;
    fireFrontmost = null;
    fireMenuToggle = null;
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

  // THE HELPER GETS THE HATCH TOO. `app_menu.rs` broadcasts the release to every webview on the
  // stated grounds that "a wedged helper webview deserves the same escape as the main one", and that
  // broadcast landed nowhere until HelperApp subscribed — documented-but-absent, which is the exact
  // failure bead sparkle-thm9o is about. Asserts a real side effect (a seeded drag shield being
  // swept) rather than that a listener was registered.
  const seedShield = () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "column-drag-shield");
    document.body.appendChild(el);
    return el;
  };
  const shieldGone = () => document.querySelector('[data-testid="column-drag-shield"]') == null;

  it("releases input in the helper window when the native menu broadcasts", async () => {
    render(<HelperApp />);
    await waitFor(() => expect(fireInputRelease).not.toBeNull());
    seedShield();
    expect(shieldGone()).toBe(false);

    fireInputRelease!();

    expect(shieldGone()).toBe(true);
  });

  it("releases input in the helper window on the keyboard fallback", async () => {
    render(<HelperApp />);
    await waitFor(() => expect(fireInputRelease).not.toBeNull());
    seedShield();

    fireEvent.keyDown(window, { key: "Escape", shiftKey: true, metaKey: true });

    expect(shieldGone()).toBe(true);
  });

  it("stops listening once the helper unmounts", async () => {
    render(<HelperApp />);
    await waitFor(() => expect(fireInputRelease).not.toBeNull());
    cleanup();
    const shield = seedShield();

    fireEvent.keyDown(window, { key: "Escape", shiftKey: true, metaKey: true });

    // Still there: a listener that outlives its window keeps firing, and both roots mount one.
    expect(shieldGone()).toBe(false);
    shield.remove();
  });

  it("renders the island with vitals fetched on mount", async () => {
    render(<HelperApp />);
    await waitFor(() => expect(screen.getByTestId("helper-needs-you").textContent).toContain("3"));
    expect(screen.getByTestId("helper-running").textContent).toContain("7");
  });

  it("renders nothing while Sparkle is frontmost", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    await waitFor(() => expect(fireFrontmost).toBeTypeOf("function"));
    fireFrontmost!(true);
    await waitFor(() => expect(screen.queryByTestId("helper-root")).toBeNull());
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
    // shows the island before emitting — capture must work either way. Driven by the PERSISTED
    // hide rather than frontmost: that is the state that outlives the session, so it is the one
    // where a webview that stopped listening while hidden would break the shortcut for good.
    useHelperPrefs.setState({ ...DEFAULTS, enabled: false } as never);
    const shot = { path: "/tmp/a.png" };
    captureScreenRegion.mockResolvedValue(shot);
    render(<HelperApp />);
    await waitFor(() => expect(screen.queryByTestId("helper-root")).toBeNull());
    await waitFor(() => expect(fireCaptureShortcut).toBeTypeOf("function"));
    fireCaptureShortcut!();
    await waitFor(() => expect(showCaptureWindow).toHaveBeenCalledWith(shot));
  });

  it("a failed shortcut capture does not resurrect a hidden island", async () => {
    // The error path must never call showHelper() itself: clearing captureBusy re-runs the
    // visibility effect, which re-shows the island only if it SHOULD be visible. An unconditional
    // show would paint it over a frontmost Sparkle, where the rule says it has no business being.
    captureScreenRegion.mockRejectedValue(new Error("TCC denied"));
    render(<HelperApp />);
    await waitFor(() => expect(fireFrontmost).toBeTypeOf("function"));
    fireFrontmost!(true);
    // The mount, before frontmost arrived, legitimately showed it once. Only what happens AFTER the
    // island is hidden is under test, so drop that first show rather than assert around it.
    await waitFor(() => expect(hideHelper).toHaveBeenCalled());
    showHelper.mockClear();
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
      // ERROR_W, not the island's own width: the island hugs its content now, so the window is
      // widened to the notice's floor whenever the notice is up. Either way the width proves this
      // is the island-with-notice placement and not a leftover tab one — the tab is 36 wide.
      expect(bw).toBe(ERROR_W);
      // Exact, not a half-plane: resolving the right DISPLAY but clamping against the wrong rect
      // would still satisfy "somewhere on the secondary screen".
      expect(bx).toBe(SECOND.position.x + SECOND.size.width - ERROR_W);
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

  // ---- item 1: the WINDOW hugs the island, not just the DOM ----
  //
  // The island is a real OS window, so `width: max-content` on the strip alone would only have
  // moved the founder's "big block of blue space" from the pill into the window background — on a
  // transparent always-on-top panel that is equally visible, and it still swallows clicks. These
  // pin the measurement actually reaching set_size.

  /** A stubbed layout box. jsdom measures everything as 0×0, which `usableContentSize` rejects, so
   *  a test that wants to exercise the measured path has to supply one. */
  const stubBox = (width: number, height: number) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
      toJSON: () => ({}),
    } as DOMRect);

  it("sizes the window to the MEASURED island, not to a reserved constant", async () => {
    const box = stubBox(150, 30);
    try {
      render(<HelperApp />);
      await waitFor(() => expect(lastBounds().slice(2)).toEqual([150, 30]));
    } finally {
      box.mockRestore();
    }
  });

  it("falls back to the constants when the box cannot be measured", async () => {
    // jsdom's 0×0 — and, in the app, any frame before layout. Sizing the window to zero would make
    // the island invisible, which is a worse bug than a slightly-wrong first frame.
    render(<HelperApp />);
    await waitFor(() => expect(lastBounds().slice(2)).toEqual([ISLAND_W, ISLAND_H]));
  });

  it("sizes the MINIMIZED window to the icon, so a small mark cannot sit in a wide window", async () => {
    useHelperPrefs.setState({ ...DEFAULTS, mode: "tab" } as never);
    render(<HelperApp />);
    await waitFor(() => expect(lastBounds().slice(2)).toEqual([TAB_W, TAB_H]));
    // Square: the "flat pancake" was a 16x64 window, and no DOM inside one can look otherwise.
    const [, , w, h] = lastBounds();
    expect(w).toBe(h);
  });

  it("does not re-issue the resize IPC when a re-measure reports the same box", async () => {
    // Every setHelperBounds is a main-thread Tauri round-trip. The window must resize when the
    // content GENUINELY changes, not whenever the observer happens to fire.
    const box = stubBox(150, 30);
    let remeasure: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) { remeasure = cb; }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    try {
      render(<HelperApp />);
      await waitFor(() => expect(lastBounds().slice(2)).toEqual([150, 30]));
      await waitFor(() => expect(remeasure).toBeTypeOf("function"));
      const before = setHelperBounds.mock.calls.length;
      remeasure!();
      remeasure!();
      remeasure!();
      await new Promise((r) => setTimeout(r, 20));
      expect(setHelperBounds.mock.calls.length).toBe(before);
    } finally {
      vi.unstubAllGlobals();
      box.mockRestore();
    }
  });

  // ---- item 2: press-and-drag on the sparkle mark moves the island; a click does not ----

  it("drags the island by the sparkle mark and persists where it lands", async () => {
    render(<HelperApp />);
    const mark = await screen.findByAltText("Sparkle");
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    const [originX, originY] = lastBounds();

    // Down on the MARK — the handle the founder reaches for — then move well past DRAG_SLOP.
    // Left and down, so the destination is comfortably inside PRIMARY and the release clamp has
    // nothing to correct; a drag that merely hit the clamp would prove nothing about the drag.
    fireEvent.pointerDown(mark, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(window, { screenX: 200, screenY: 700 });
    fireEvent.pointerUp(window, { screenX: 200, screenY: 700 });

    await waitFor(() => {
      const { x, y } = useHelperPrefs.getState();
      expect(x).toBe(originX - 300);
      expect(y).toBe(originY + 200);
    });
  });

  it("moves the WINDOW as the pointer moves, not only on release", async () => {
    render(<HelperApp />);
    const mark = await screen.findByAltText("Sparkle");
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    const [originX, originY] = lastBounds();
    setHelperBounds.mockClear();

    fireEvent.pointerDown(mark, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(window, { screenX: 200, screenY: 700 });

    // The live frame lands before pointerup — the island has to follow the cursor, not teleport
    // when the button comes back up.
    await waitFor(() => {
      expect(setHelperBounds).toHaveBeenCalled();
      expect(lastBounds().slice(0, 2)).toEqual([originX - 300, originY + 200]);
    });

    // FINISH the gesture. The drag listeners live on `window`, which outlives both the component
    // and RTL's cleanup — a test that leaves a drag open leaks its handlers into the NEXT test,
    // where they answer that test's pointer events from this test's closure. (Found the hard way:
    // it made the click-vs-drag case below persist a 2px "drag" that nothing in it performed.)
    fireEvent.pointerUp(window, { screenX: 200, screenY: 700 });
  });

  it("treats a press-and-release with no travel as a CLICK, persisting nothing", async () => {
    // The two gestures share a pointerdown, so they must be told apart by TRAVEL. Before this, the
    // release handler clamped and persisted an x/y on every click of the island — writing a
    // position the user never chose, and re-running the placement effect to do it.
    render(<HelperApp />);
    const mark = await screen.findByAltText("Sparkle");
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());

    fireEvent.pointerDown(mark, { button: 0, screenX: 500, screenY: 500 });
    // Inside DRAG_SLOP: the hand-tremor every real click has.
    fireEvent.pointerMove(window, { screenX: 502, screenY: 501 });
    fireEvent.pointerUp(window, { screenX: 502, screenY: 501 });

    await new Promise((r) => setTimeout(r, 30));
    expect(useHelperPrefs.getState().x).toBeNull();
    expect(useHelperPrefs.getState().y).toBeNull();
  });

  it("does not twitch the window for a sub-slop press", async () => {
    render(<HelperApp />);
    const mark = await screen.findByAltText("Sparkle");
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    setHelperBounds.mockClear();

    fireEvent.pointerDown(mark, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(window, { screenX: 502, screenY: 501 });
    fireEvent.pointerUp(window, { screenX: 502, screenY: 501 });

    await new Promise((r) => setTimeout(r, 30));
    expect(setHelperBounds).not.toHaveBeenCalled();
  });

  it("stops listening when the OS takes the gesture away (pointercancel, no pointerup)", async () => {
    // A native drag or a system swipe ends the gesture with pointercancel and NO pointerup. Without
    // a listener for it the move handler outlives the drag, and the island then follows the cursor
    // around with no button held down.
    render(<HelperApp />);
    const mark = await screen.findByAltText("Sparkle");
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());
    const [originX, originY] = lastBounds();

    fireEvent.pointerDown(mark, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerCancel(window, { screenX: 500, screenY: 500 });
    setHelperBounds.mockClear();
    fireEvent.pointerMove(window, { screenX: 900, screenY: 900 });

    await new Promise((r) => setTimeout(r, 30));
    expect(setHelperBounds).not.toHaveBeenCalled();
    // …and nothing was persisted from a gesture the user never completed.
    expect(useHelperPrefs.getState().x).toBeNull();
    expect(originX).toBeTypeOf("number");
    expect(originY).toBeTypeOf("number");
  });

  // ---- the drag latch is ONE-SHOT: it suppresses the drag's own click, and nothing after it ----

  it("repositioning the tab does not un-collapse it", async () => {
    // The gesture ends with pointerup on the same <button>, which synthesizes a click. Without the
    // latch, every attempt to move the tab would expand it into the island instead.
    useHelperPrefs.setState({ ...DEFAULTS, mode: "tab" } as never);
    render(<HelperApp />);
    const tab = await screen.findByRole("button", { name: /show sparkle helper/i });
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());

    fireEvent.pointerDown(tab, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(window, { screenX: 500, screenY: 700 });
    fireEvent.pointerUp(window, { screenX: 500, screenY: 700 });
    fireEvent.click(tab); // the click the browser synthesizes at the end of that drag

    await new Promise((r) => setTimeout(r, 30));
    expect(useHelperPrefs.getState().mode).toBe("tab");
  });

  it("still restores the island from the KEYBOARD after the tab has been dragged", async () => {
    // A <button> fires `click` from Enter/Space with NO pointerdown before it. The latch is cleared
    // on pointerdown, so a latch left standing after a drag had nothing to clear it: the tab went
    // permanently dead to keyboard activation, and the only documented way back out of the
    // minimized state stopped working for anyone not using a mouse. Same failure shape as the
    // takeover latch in e5504f7fc — a latch that can strand is a latch that will.
    useHelperPrefs.setState({ ...DEFAULTS, mode: "tab" } as never);
    render(<HelperApp />);
    const tab = await screen.findByRole("button", { name: /show sparkle helper/i });
    await waitFor(() => expect(setHelperBounds).toHaveBeenCalled());

    // Drag it somewhere, which arms the latch and consumes it on the synthesized click.
    fireEvent.pointerDown(tab, { button: 0, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(window, { screenX: 500, screenY: 700 });
    fireEvent.pointerUp(window, { screenX: 500, screenY: 700 });
    fireEvent.click(tab);
    await new Promise((r) => setTimeout(r, 30));
    expect(useHelperPrefs.getState().mode).toBe("tab");

    // Now activate it by keyboard: a bare click, no pointer gesture at all.
    fireEvent.click(tab);
    await waitFor(() => expect(useHelperPrefs.getState().mode).toBe("island"));
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

  // §6 inverted this into "offers NO Hide Helper". It is BACK, and the inversion is undone: an
  // always-on-top panel floating over every other app has to be dismissable. What makes the
  // persisted hide safe this time is the native menu bar, covered by the two tests below.
  it("right-click → Hide Helper disables it and persists the choice", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    // The menu really is open, so the item found below is the one in it.
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide helper/i }));
    expect(useHelperPrefs.getState().enabled).toBe(false);
    // …and it actually goes away, rather than only recording a preference nothing reads.
    await waitFor(() => expect(screen.queryByTestId("helper-root")).toBeNull());
    await waitFor(() => expect(hideHelper).toHaveBeenCalled());
  });

  it("the three context-menu items are all present", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    expect(await screen.findByRole("menu")).toBeTruthy();
    // MENU_H is sized for THREE items (helperGeometry.ts); the window would clip a fourth.
    expect(screen.getByRole("button", { name: /open sparkle/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hide helper/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /quit sparkle/i })).toBeTruthy();
  });

  // THE WAY BACK. This is the whole reason the persisted hide is allowed to exist again: the item
  // lives in the native menu bar, which cannot itself be hidden. Nothing inside the helper webview
  // can re-enable the island — it is not rendered — so if this bridge breaks, Hide Helper is a
  // one-way door once more.
  it("the native View menu toggles the island back on and off", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    await waitFor(() => expect(fireMenuToggle).toBeTypeOf("function"));

    fireMenuToggle!();
    await waitFor(() => expect(screen.queryByTestId("helper-root")).toBeNull());
    expect(useHelperPrefs.getState().enabled).toBe(false);

    // …and back, from a menu item that is the ONLY affordance still reachable at this point.
    fireMenuToggle!();
    expect(await screen.findByTestId("helper-root")).toBeTruthy();
    expect(useHelperPrefs.getState().enabled).toBe(true);
  });

  // The item's LABEL is derived in Rust from this value (app_menu::helper_label), so the menu can
  // never offer "Hide Helper" for an island that is already hidden. That only holds if the webview
  // keeps pushing the state — including after a hide made from the island's OWN menu, which Rust
  // has no other way to learn about.
  it("pushes the current preference to the native menu on mount and on every change", async () => {
    render(<HelperApp />);
    await screen.findByTestId("helper-needs-you");
    // Mount: corrects the default-labelled item for a hydrated preference.
    await waitFor(() => expect(setHelperMenuState).toHaveBeenCalledWith(true));

    setHelperMenuState.mockClear();
    fireEvent.contextMenu(screen.getByTestId("helper-root"));
    fireEvent.click(await screen.findByRole("button", { name: /hide helper/i }));
    await waitFor(() => expect(setHelperMenuState).toHaveBeenCalledWith(false));

    setHelperMenuState.mockClear();
    fireMenuToggle!();
    await waitFor(() => expect(setHelperMenuState).toHaveBeenCalledWith(true));
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
