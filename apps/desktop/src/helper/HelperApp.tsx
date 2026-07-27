// Root of the `helper` webview: the floating island / pull tab (spec §5).
//
// This file owns the wiring — drag, visibility, capture, context menu — while the two
// presentational components own the pixels. Position math lives in helperGeometry (pure) and the
// show/hide rule in helperVisibility (pure), so what is left here is genuinely just plumbing.
import { useCallback, useEffect, useRef, useState } from "react";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import { C } from "@sparkle/ui";
import { HelperIsland, type Tier } from "./HelperIsland";
import { HelperTab } from "./HelperTab";
import { useHelperPrefs, type HelperMode } from "./helperPrefs";
import { shouldShowHelper } from "./helperVisibility";
import {
  clampToScreen, snapTabToEdge, screenFor, windowSize, hitTestPoint, pillSize, type Rect,
} from "./helperGeometry";
import {
  getHelperVitals, onHelperVitalsChanged, getFrontmost, onFrontmostChanged, onCaptureRequested,
  onCaptureClosed, onCaptureSend, getTakeoverOpen, setHelperBounds, showHelper, hideHelper,
  showMainWindow, type Vitals,
} from "../services/helper";
import { safeUnlisten } from "../services/safeUnlisten";
import { emitFocusTier, quitApp } from "../services/attention";
import { captureScreenRegion, showCaptureWindow } from "../screenshot";

const ZERO: Vitals = { needsYou: 0, running: 0 };
const FALLBACK_SCREEN: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** How long the island stays suppressed after a takeover DISMISSAL, waiting for `frontmost` to
 *  settle. Short — nothing is being raised on this path, so this only absorbs the ordering race
 *  between `capture://send` and `capture://closed` (two separate IPC messages from the same
 *  webview, so their arrival order here is not guaranteed). */
const CLOSE_SETTLE_MS = 250;
/** …and after a SEND, where a raise really is coming. `handleCaptureSend` selects the project,
 *  dispatches to a build agent or the plan flow, and only then calls `focusThisWindow()`, so this
 *  has to outlast a dispatch. It is a safety valve, not a schedule: the first `frontmost = true`
 *  clears it immediately, and it exists only so a send that never routes (no owning window, a
 *  throw) cannot suppress the island forever. */
const SEND_RAISE_GRACE_MS = 3000;

/** Read the monitor layout in LOGICAL pixels. Tauri reports monitor geometry in PHYSICAL pixels,
 *  so everything is divided by the scale factor — helperGeometry works in logical space, and
 *  mixing the two silently doubles every coordinate on a retina display. */
function toRect(m: {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
}): Rect {
  return {
    x: m.position.x / m.scaleFactor,
    y: m.position.y / m.scaleFactor,
    width: m.size.width / m.scaleFactor,
    height: m.size.height / m.scaleFactor,
  };
}

async function readScreens(): Promise<{ screens: Rect[]; current: Rect | null }> {
  try {
    const [all, cur] = await Promise.all([availableMonitors(), currentMonitor()]);
    return { screens: all.map(toRect), current: cur ? toRect(cur) : null };
  } catch (e) {
    // Outside Tauri (tests) there are no monitors and this is expected.
    //
    // INSIDE Tauri this is NOT benign — every position then clamps against a zero rect and the
    // island parks at the origin — so read the rejection message rather than guessing. It is NOT a
    // missing monitor permission: `core:default` → `core:window:default` already grants
    // available-monitors / current-monitor / primary-monitor (see core:window.default_permission
    // in gen/schemas/acl-manifests.json), and re-adding them explicitly is a no-op the capability
    // test now warns against. The likelier causes are the window label missing from
    // `capabilities/default.json.windows` — which yields ZERO permissions for every command, not
    // just these — or a platform-side failure.
    console.debug("helper: monitor query failed; island will fall back to the origin", e);
    return { screens: [], current: null };
  }
}

export function HelperApp() {
  const { enabled, mode, x, y, edge, setEnabled, setMode, setPosition, setEdge } = useHelperPrefs();
  const [vitals, setVitals] = useState<Vitals>(ZERO);
  const [frontmost, setFrontmost] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  // The takeover is on screen. SEPARATE from captureBusy, which only spans the capture FLOW:
  // showCaptureWindow resolves when the takeover is shown, not when the user dismisses it, so
  // captureBusy flips false while the annotation session is just beginning. The island is
  // always-on-top and the takeover fills the monitor, so without this the island floats over it
  // for the whole session — with a live Capture button that starts a SECOND crosshair capture on
  // top of the open takeover.
  //
  // NOT event-only. It is SEEDED on mount and RE-POLLED on every frontmost gain (`is_capture_open`),
  // exactly like `vitals` and `frontmost` below, and for the same reason: `capture://closed` is a
  // single edge, and an edge is the wrong shape for a webview that may mount, reload, or crash and
  // reload at any point in the session. The event-only version broke both ways — a helper mounting
  // under an open takeover started `false` and painted over it, and a close edge that never arrived
  // (⌘W destroying the key window, a failed `win.hide()`, a webview crash) suppressed the island for
  // the whole session with no route back: it is hidden, so its context menu is unreachable, and
  // re-enabling it from the main window hits this same suppression (roborev 53341-M2).
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  // A real takeover edge has been observed here (opened by this webview, or `capture://closed`), so
  // the mount seed's in-flight round-trip must no longer overwrite it. Same staleness guard the
  // vitals and frontmost seeds use, hoisted to a ref because two effects share it.
  const sawTakeoverEdgeRef = useRef(false);
  // Non-null while the island must stay suppressed WAITING FOR `frontmost` TO SETTLE, and the grace
  // it is waiting out. Cleared by the first `frontmost = true`, or when the grace elapses.
  //
  // This is the send flash (roborev 53339-M1). `CaptureApp.send()` emits `capture://send` and calls
  // `hideCaptureWindow()` immediately, so Rust emits `capture://closed` and the suppression lifts
  // while `frontmost` is STILL false — the takeover is excluded from the frontmost policy and the
  // main window has not been raised yet. The visibility rule then says "show", and the raise at the
  // end of `handleCaptureSend` hides it again a beat later: the island popped onto the screen and
  // vanished on every send from outside Sparkle, which is the primary flow. (Rust's added
  // `frontmost::note_focus_event(false)` does not help — it re-polls to `false`, the value that
  // causes the show.)
  const [raiseGraceMs, setRaiseGraceMs] = useState<number | null>(null);
  // Never SHORTENS an existing grace: a send arms the long one and the `capture://closed` that
  // follows it must not downgrade that to the dismissal grace.
  const armRaiseGrace = useCallback((ms: number) => {
    setRaiseGraceMs((cur) => Math.max(cur ?? 0, ms));
  }, []);
  const [captureError, setCaptureError] = useState<string | null>(null);
  // Synchronous re-entrancy guard: captureBusy is read from the render closure, so two fast
  // clicks could both pass a state-only check. Same reasoning as the old TrayApp guard.
  const captureBusyRef = useRef(false);
  // True once the geometry effect has pushed a real position. The island must not be SHOWN before
  // it has been PLACED: `init_helper_window` builds the window with no `.position(...)`, so it
  // appears at whatever origin the OS assigned and then jumps. The visibility effect wins the race
  // by default — `frontmost` initialises false and `enabled` hydrates synchronously true — so on
  // every launch showHelper() fired while setHelperBounds was still behind `await readScreens()`.
  //
  // A ref would not do: this has to re-run the visibility effect once placement lands.
  const [placed, setPlaced] = useState(false);

  // Where the window ACTUALLY is, including the computed default before the user has ever dragged
  // it. A drag must start from here, not from the persisted `x`/`y` — those are null on first run,
  // and treating null as 0 teleports the island to the corner on the very first drag.
  //
  // NULL until the geometry effect's async monitor read resolves. That is deliberate: fabricating
  // {0,0} in the meantime would reproduce the same teleport in a narrower window, since the island
  // becomes clickable at first paint — before the IPC round-trip completes.
  const posRef = useRef<{ x: number; y: number } | null>(null);
  // A drag of the pull tab ends with pointerup on the same <button>, which synthesizes a click —
  // so without this the tab would expand into the island every time you tried to reposition it.
  const draggedRef = useRef(false);

  // Only the island renders the capture-failure notice, so a failure while collapsed must display
  // as an island. DERIVED, never persisted: writing `mode` for a transient notice would undo a
  // deliberate collapse for anyone who quits or reloads inside the 8s window, and would propagate
  // the temporary value to the main window through the storage bridge.
  const renderMode: HelperMode = captureError ? "island" : mode;

  // The OS window must be big enough to COMPOSITE the overlays, not just to contain the pill —
  // a webview draws nothing outside its native bounds. See windowSize.
  const { width, height } = windowSize(renderMode, { menuOpen, hasError: captureError !== null });
  // The PILL's own footprint, independent of any overlay. It drives the wrapper's layout and the
  // FRESH default origin — it is deliberately NOT used to place a position that was already
  // persisted; see hitTestPoint for why measuring a stored coordinate by any footprint is what
  // kept teleporting the window to the wrong monitor.
  const { width: pillW, height: pillH } = pillSize(renderMode);
  // NOTE: `x`/`y` are always the PILL's top-left, never the window's. They are only written while
  // no overlay is open (a drag cannot coexist with the menu — the scrim swallows the pointerdown),
  // so the two coincide at write time.

  // Vitals: seed once (covering a reload that missed the last push), then follow pushes.
  useEffect(() => {
    let alive = true;
    // Same staleness guard as the frontmost seed below: a pushed update must win over a slower seed.
    let sawEvent = false;
    void getHelperVitals().then((v) => { if (alive && !sawEvent && v) setVitals(v); });
    const un = onHelperVitalsChanged((v) => { sawEvent = true; setVitals(v); });
    return () => { alive = false; void safeUnlisten(un); };
  }, []);

  // Frontmost: Rust reports the raw boolean; shouldShowHelper applies the policy. Seed first —
  // the event only fires on TRANSITIONS, so a webview that mounts while Sparkle is already
  // frontmost would otherwise assume false and paint the island over the app.
  useEffect(() => {
    let alive = true;
    // The seed is an async round-trip; an event can land first. Applying a stale seed on top of a
    // fresher event would hide the island again until the NEXT focus transition.
    let sawEvent = false;
    void getFrontmost().then((f) => { if (alive && !sawEvent && f !== null) setFrontmost(f); });
    const un = onFrontmostChanged((f) => { sawEvent = true; setFrontmost(f); });
    return () => { alive = false; void safeUnlisten(un); };
  }, []);

  // Capture: hide FIRST so the island isn't in the shot. null = the user pressed Esc at the
  // crosshairs, which is a silent, successful no-op — not an error.
  // Auto-dismiss the failure notice. Nothing else clears it, and it inflates the window while it
  // is up — a permanently enlarged always-on-top panel swallowing clicks is worse than the lost
  // message.
  useEffect(() => {
    if (!captureError) return;
    const t = setTimeout(() => setCaptureError(null), 8000);
    return () => clearTimeout(t);
  }, [captureError]);

  const capture = useCallback(async () => {
    if (captureBusyRef.current) return;
    captureBusyRef.current = true;
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      hideHelper();
      setCaptureError(null);
      const shot = await captureScreenRegion();
      if (shot) {
        await showCaptureWindow(shot);
        // Only after it actually opened. An Esc at the crosshairs (null shot) and a throw both
        // leave this false, so the island comes back as it should.
        sawTakeoverEdgeRef.current = true;
        setTakeoverOpen(true);
      }
    } catch (e) {
      console.error("helper: capture flow failed", e);
      // A failure must not be indistinguishable from an Esc: the island is already hidden, so
      // bring it back with a one-line notice. Any of the awaits can throw, but a first-run TCC
      // Screen Recording denial is the expected one, so the copy names it.
      setCaptureError(
        "Capture failed — if this is your first capture, check Screen Recording in System Settings.",
      );
      // No showHelper() here on purpose. Clearing captureBusy below re-runs the visibility effect,
      // which re-shows the island only if it SHOULD be visible. Calling showHelper() directly would
      // resurrect an island the user had hidden — the shortcut can trigger this path too.
    } finally {
      captureBusyRef.current = false;
      setCaptureBusy(false);
    }
  }, []);

  // The global capture shortcut, forwarded from Rust so the shortcut and the button run the same
  // code path rather than drifting apart.
  useEffect(() => {
    const un = onCaptureRequested(() => { void capture(); });
    return () => { void safeUnlisten(un); };
  }, [capture]);

  // Takeover state: seed once (covering a helper that mounted while the takeover was already up),
  // then follow the closing edge. Same shape as the vitals seed above, and the same staleness
  // guard — a real edge must win over a slower seed.
  useEffect(() => {
    let alive = true;
    void getTakeoverOpen().then((open) => {
      if (alive && !sawTakeoverEdgeRef.current && open !== null) setTakeoverOpen(open);
    });
    const un = onCaptureClosed(() => {
      sawTakeoverEdgeRef.current = true;
      setTakeoverOpen(false);
      // NOT an immediate un-suppression: `frontmost` has not spoken yet. See raiseGraceMs.
      armRaiseGrace(CLOSE_SETTLE_MS);
    });
    return () => { alive = false; void safeUnlisten(un); };
  }, [armRaiseGrace]);

  // A send is routing, so a raise is coming. Arms the long grace BEFORE `capture://closed` lands
  // (CaptureApp emits the send first), which is the whole point — the close edge must not be able
  // to un-suppress the island in the window between the takeover going away and the main window
  // coming forward.
  useEffect(() => {
    const un = onCaptureSend(() => armRaiseGrace(SEND_RAISE_GRACE_MS));
    return () => { void safeUnlisten(un); };
  }, [armRaiseGrace]);

  // The grace's own expiry. A safety valve only: the normal end of a grace is a `frontmost = true`
  // below, which clears it at once. Without the timer, a send that never routes anywhere would
  // suppress the island indefinitely — the failure mode this whole section exists to remove.
  useEffect(() => {
    if (raiseGraceMs === null) return;
    const t = setTimeout(() => setRaiseGraceMs(null), raiseGraceMs);
    return () => clearTimeout(t);
  }, [raiseGraceMs]);

  // Sparkle came forward: end any grace, and RE-POLL the takeover rather than trusting the latch.
  //
  // This is the recovery valve. `capture://closed` has exactly one emitter, and the ways it goes
  // missing are real — ⌘W closing the key window (the takeover, while it is up), a webview crash or
  // reload, a `win.hide()` that fails. Without a second opinion, any of those suppresses the island
  // permanently. Re-polling is safe rather than merely tolerable: if the takeover really is still up
  // it stays suppressed, and while Sparkle is frontmost the island is hidden by the ordinary rule
  // anyway, so this can never race a show onto the screen.
  //
  // Both writes land in the re-poll's callback, not the effect body: the grace exists to bridge the
  // gap until frontmost is known, and the answer to "is the takeover still up" arrives with it — so
  // there is no moment where the grace has lifted while `takeoverOpen` is still the stale latch.
  useEffect(() => {
    if (!frontmost) return;
    let alive = true;
    void getTakeoverOpen().then((open) => {
      if (!alive) return;
      setRaiseGraceMs(null);
      if (open !== null) setTakeoverOpen(open);
    });
    return () => { alive = false; };
  }, [frontmost]);

  // The one place the OS window is shown or hidden. Four suppressions, all of them "not yet":
  //   - captureBusy: a capture is in flight; that flow hides the island deliberately and
  //     re-showing it here would put it back in the shot.
  //   - takeoverOpen: the full-monitor takeover is up and the island is always-on-top.
  //   - raiseGraceMs: the takeover just went away but `frontmost` has not settled, so the rule
  //     below would read a stale `false` and flash the island for one dispatch.
  //   - !placed: geometry has not landed, so a show would flash the window at the OS-assigned
  //     origin before jumping to its real position.
  // The window is BUILT hidden, so skipping the hide() in those states is a no-op, not a leak.
  useEffect(() => {
    if (captureBusy || takeoverOpen || raiseGraceMs !== null || !placed) return;
    if (shouldShowHelper({ enabled, sparkleFrontmost: frontmost })) showHelper();
    else hideHelper();
  }, [enabled, frontmost, captureBusy, takeoverOpen, raiseGraceMs, placed]);

  // Push geometry to the OS window whenever mode or position changes, clamped to the display the
  // window actually sits on — this is what rescues a position persisted against a monitor that
  // has since been unplugged.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { screens, current } = await readScreens();
      if (!alive) return;
      const fallback = current ?? screens[0] ?? FALLBACK_SCREEN;
      // Narrowing, not a cast: `persisted` carries the non-null-ness into `want`, so a later edit
      // to this predicate cannot let `null` reach clampToScreen (where Math.min(null, …) coerces
      // to 0 and the pill silently parks at the screen origin, with no type error and no test).
      const persisted = x !== null && y !== null ? { x, y } : null;
      const fresh = persisted === null;
      // Default when nothing is remembered: near the top-right of the current display, expressed
      // as a PILL origin so it does not shift when an overlay inflates the window.
      const want = persisted ?? {
        x: fallback.x + fallback.width - pillW - 24,
        y: fallback.y + 24,
      };
      const screen = screenFor(
        hitTestPoint(want, fresh, { width: pillW, height: pillH }),
        screens.length ? screens : [fallback],
      );
      if (renderMode === "tab") {
        const snapped = snapTabToEdge(want, screen, { width, height });
        // One authoritative edge. The window's x comes from the edge snapTabToEdge DERIVES, while
        // the pill is anchored from the persisted one — and the island's drag-release writes a
        // position without an edge, so the two can disagree (drag the island left, then collapse:
        // x is on the left while edge is still "right"). Persist what was derived, so layout and
        // placement cannot drift apart.
        if (snapped.edge !== edge) setEdge(snapped.edge);
        posRef.current = { x: snapped.x, y: snapped.y };
        setHelperBounds(snapped.x, snapped.y, width, height);
        setPlaced(true);
        return;
      }
      const pos = clampToScreen(want, { width, height }, screen);
      posRef.current = { x: pos.x, y: pos.y };
      setHelperBounds(pos.x, pos.y, width, height);
      // Releases the visibility effect's first-show gate. Set on BOTH placement paths and AFTER
      // setHelperBounds, never before — the whole point is that the show follows the placement.
      // readScreens() swallows its own failures and falls through to a fallback rect, so there is
      // no branch that reaches here without having placed the window.
      setPlaced(true);
    })();
    return () => { alive = false; };
  }, [renderMode, x, y, width, height, pillW, pillH, edge, setEdge]);

  // Drag: pointer-driven setPosition rather than Tauri's startDragging, which hands the drag to
  // the OS and gives no release hook — and the release is exactly where the tab must snap.
  const onDragStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.screenX;
    const startY = e.screenY;
    // Position not resolved yet — ignore the drag rather than start it from a made-up origin.
    if (!posRef.current) return;
    const { x: originX, y: originY } = posRef.current;
    let lastX = originX;
    let lastY = originY;
    draggedRef.current = false;

    // Commit at most one position per frame. Every setHelperBounds is a main-thread Tauri IPC, and
    // pointermove fires far faster than the compositor can use — unthrottled, a single drag floods
    // the IPC channel with positions nobody ever sees.
    let raf = 0;
    const commit = () => {
      raf = 0;
      posRef.current = { x: lastX, y: lastY };
      setHelperBounds(lastX, lastY, width, height);
    };
    const DRAG_SLOP = 3; // px of travel before a press counts as a drag rather than a click
    const onMove = (ev: PointerEvent) => {
      lastX = originX + (ev.screenX - startX);
      lastY = originY + (ev.screenY - startY);
      if (Math.abs(ev.screenX - startX) > DRAG_SLOP || Math.abs(ev.screenY - startY) > DRAG_SLOP) {
        draggedRef.current = true;
      }
      // Move live and unclamped for a responsive feel; the clamp/snap happens once on release.
      if (!raf) raf = requestAnimationFrame(commit);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Drop any frame still pending so it can't land AFTER the clamp/snap below and undo it.
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      void (async () => {
        const { screens, current } = await readScreens();
        const fallback = current ?? screens[0] ?? FALLBACK_SCREEN;
        // A dragged position is a proposal, not a clamped result, so it is measured from its
        // centre — the `fresh` case in hitTestPoint.
        const screen = screenFor(
          hitTestPoint({ x: lastX, y: lastY }, true, { width: pillW, height: pillH }),
          screens.length ? screens : [fallback],
        );
        if (renderMode === "tab") {
          const snapped = snapTabToEdge({ x: lastX, y: lastY }, screen, { width, height });
          posRef.current = { x: snapped.x, y: snapped.y };
          setEdge(snapped.edge);
          setPosition(snapped.x, snapped.y);
        } else {
          const clamped = clampToScreen({ x: lastX, y: lastY }, { width, height }, screen);
          posRef.current = clamped;
          setPosition(clamped.x, clamped.y);
        }
      })();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [renderMode, width, height, pillW, pillH, setPosition, setEdge]);

  const onChiclet = useCallback((band: Tier) => {
    emitFocusTier({ band });
  }, []);

  const visible = shouldShowHelper({ enabled, sparkleFrontmost: frontmost });
  // Rust hides the OS window, but the React tree stays mounted so subscriptions survive; render
  // nothing while hidden so a stray frame can't paint.
  if (!visible) return null;

  return (
    <div
      data-testid="helper-root"
      style={{ position: "relative", width: "100vw", height: "100vh", overflow: "visible" }}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          // Explicit footprint. Without it the wrapper shrink-to-fits, the island's flex spacer
          // collapses, Capture and the chevron stop being right-aligned, and the painted pill
          // ends up narrower than the window the user positioned.
          width: pillW,
          // The window grows inward from the docked edge when an overlay opens. Anchoring the pill
          // to that same edge keeps it visually still; laying it out at the window's left instead
          // made a right-docked tab jump 152px inward on every right-click, out from under the
          // cursor that opened the menu.
          ...(renderMode === "tab" && edge === "right" ? { right: 0 } : { left: 0 }),
        }}
      >
      {renderMode === "island" ? (
        <HelperIsland
          vitals={vitals}
          captureBusy={captureBusy}
          captureError={captureError}
          // Aims the collapse chevrons at the edge the tab will actually dock to.
          edge={edge}
          onCapture={() => void capture()}
          onCollapse={() => setMode("tab")}
          onChiclet={onChiclet}
          onDragStart={onDragStart}
        />
      ) : (
        <HelperTab
          edge={edge}
          // Suppress the click synthesized at the end of a drag, or repositioning the tab would
          // always un-collapse it.
          onExpand={() => { if (!draggedRef.current) setMode("island"); }}
          onDragStart={onDragStart}
        />
      )}
      </div>

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: "absolute", top: 4, right: 4, zIndex: 10,
            background: C.forest, borderRadius: 8, padding: 4,
            display: "flex", flexDirection: "column", gap: 2,
            border: `1px solid ${C.deepForest}`,
          }}
          // Any click inside the menu is handled by its buttons; a click elsewhere dismisses it.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* The discoverable way back into the app. The main window's close path only HIDES it,
              the tray's "Open" item was deleted with the tray, and the macOS Dock icon — the
              documented route — is not visible as an affordance from out here. The only other
              remaining route is clicking a P0/P1 chiclet, which does not read as "open Sparkle". */}
          <button style={menuItem} onClick={() => { setMenuOpen(false); showMainWindow(); }}>
            Open Sparkle
          </button>
          <button style={menuItem} onClick={() => { setMenuOpen(false); setEnabled(false); }}>
            Hide Helper
          </button>
          <button
            style={{ ...menuItem, color: C.sienna }}
            onClick={() => { setMenuOpen(false); quitApp(); }}
          >
            Quit Sparkle
          </button>
        </div>
      )}

      {/* Dismiss the menu on any click outside it. Rendered BEHIND the menu (zIndex 9). */}
      {menuOpen && (
        <div
          data-testid="helper-menu-scrim"
          style={{ position: "fixed", inset: 0, zIndex: 9 }}
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

const menuItem = {
  all: "unset" as const,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 12,
  color: C.cream,
  padding: "5px 10px",
  borderRadius: 5,
  whiteSpace: "nowrap" as const,
};
