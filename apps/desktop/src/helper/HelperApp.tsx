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
  setHelperBounds, showHelper, hideHelper, type Vitals,
} from "../services/helper";
import { safeUnlisten } from "../services/safeUnlisten";
import { emitFocusTier, quitApp } from "../services/attention";
import { captureScreenRegion, showCaptureWindow } from "../screenshot";

const ZERO: Vitals = { needsYou: 0, running: 0 };
const FALLBACK_SCREEN: Rect = { x: 0, y: 0, width: 0, height: 0 };

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
  const [captureError, setCaptureError] = useState<string | null>(null);
  // Synchronous re-entrancy guard: captureBusy is read from the render closure, so two fast
  // clicks could both pass a state-only check. Same reasoning as the old TrayApp guard.
  const captureBusyRef = useRef(false);

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
      if (shot) await showCaptureWindow(shot);
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

  // The one place the OS window is shown or hidden. Skipped while a capture is in flight — that
  // flow hides the island deliberately, and re-showing it here would put it back in the shot.
  useEffect(() => {
    if (captureBusy) return;
    if (shouldShowHelper({ enabled, sparkleFrontmost: frontmost })) showHelper();
    else hideHelper();
  }, [enabled, frontmost, captureBusy]);

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
        return;
      }
      const pos = clampToScreen(want, { width, height }, screen);
      posRef.current = { x: pos.x, y: pos.y };
      setHelperBounds(pos.x, pos.y, width, height);
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
