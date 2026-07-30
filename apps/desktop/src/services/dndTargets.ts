// Hit-testing for Tauri's webview-level drag-and-drop against specific DOM drop targets.
//
// Tauri's onDragDropEvent is window-global — the payload carries a cursor position but no
// notion of which ELEMENT the cursor is over (and with dragDropEnabled on, HTML5 drop events
// never fire, so there are no per-element handlers to lean on). Components that want to be a
// drop target mark their root with `data-dnd-target="<name>"`; drag handlers hit-test the
// event position against the DOM with elementFromPoint, which wants CSS pixels.
//
// GETTING TO CSS PIXELS IS PLATFORM-DEPENDENT, and assuming otherwise is what broke every drop
// target in the app (PRD/feat/drag-drop-image-attach.md). See dragPositionScale below.
import { log } from "../logger";

/** The "+ New Build Agent" button (both the sidebar row and the Workspace empty-state copy). */
export const NEW_BUILD_AGENT_DND_TARGET = "new-build-agent";

/** The concierge column — the whole left column, not just the box at the bottom of it. A file
 *  dropped ANYWHERE over the concierge attaches to the next prompt, because "somewhere on the
 *  panel I'm talking to" is the target a user actually aims at; the compose box alone is a ~90px
 *  strip and missing it silently did nothing. Still SCOPED to the column rather than the whole
 *  window because two other window-global drop listeners are live at the same time
 *  (useNewBuildAgentDrop, and historically the Sparkle pane's Composer — which is gone now that
 *  Improve Sparkle mounts the concierge like any other build agent); an unscoped listener would
 *  double-attach. The box the files land in paints the affordance (Concierge/ComposeBox). */
export const CONCIERGE_COLUMN_DND_TARGET = "concierge-column";

/** The terminal stage — the box in Workspace that every agent pane is stacked inside. Dropping
 *  files here pastes their paths into the VISIBLE agent's own terminal (hooks/useTerminalDrop).
 *
 *  DELIBERATELY NOT in FILE_DROP_TARGETS below, even though it does own its drops. That list is
 *  "surfaces the two window-global listeners must stand DOWN over", and the Sparkle pane's
 *  Composer renders INSIDE this stage — listing it here would make that composer refuse drops on
 *  its own box. The stage doesn't need the carve-out anyway: useTerminalDrop only listens while an
 *  agent pane is visible, and no agent pane is visible while the Sparkle pane is. */
export const TERMINAL_STAGE_DND_TARGET = "terminal-stage";

/** The SPARKLE pane's terminal — the box the Sparkle self-improve agent's CLI renders in, ABOVE
 *  its compose box.
 *
 *  It needs a target of its own because it is the one terminal in the app that is not inside
 *  TERMINAL_STAGE_DND_TARGET's owner: the Sparkle pane renders a Terminal and a catch-all Composer
 *  as siblings, and that composer claimed everything dropped anywhere in the pane. So a file
 *  dropped ON THE TERMINAL there did not paste its path the way it does on every other agent's
 *  terminal — it was loaded as a chat attachment instead, which reads the file, which the
 *  attachment loader can REFUSE (`refusing to read a path outside allowed directories` for
 *  anything under a dot-directory or outside $HOME/$TMPDIR/Volumes). The refusal is logged and
 *  nothing else happens, so the file simply vanished. Observed exactly that way: pngs dropped on a
 *  build agent's terminal pasted fine, a .txt dropped on the Sparkle pane's terminal produced
 *  `dropped 1 file(s) into chat` followed by `load dropped file failed`, and the user read the
 *  difference as "images work, .txt doesn't".
 *
 *  A pasted path reads nothing, so no loader can refuse it — which is why routing this box to the
 *  terminal-drop hook fixes the disappearance rather than just relocating it. The compose box
 *  itself is NOT part of this region and still takes its own drops as tiles. */
export const SPARKLE_TERMINAL_DND_TARGET = "sparkle-terminal";

/**
 * How far past the viewport a reported position must land before we conclude it CANNOT be CSS
 * pixels.
 *
 * A bare `x > innerWidth` has no slack, and plenty of perfectly good LOGICAL coordinates sit a hair
 * past the edge: sub-pixel drag positions at the right/bottom border, a webview frame that differs
 * from `innerWidth`/`innerHeight` by a scrollbar or window chrome, a resize landing mid-drag.
 * Dividing one of those sends the hit test into the upper-left quadrant — the exact silent misroute
 * this module exists to prevent — and `reportDropWithNoTarget` would often NOT catch it, because a
 * halved coordinate frequently lands on the concierge column, which is a known target. So the
 * correction only fires on an unambiguous overshoot (roborev 53893).
 */
export const OUT_OF_VIEWPORT_SLACK_PX = 32;

/**
 * How much to divide a Tauri drag position by to land in the CSS pixels elementFromPoint wants.
 *
 * THIS IS THE BUG THAT KILLED EVERY DROP TARGET. Tauri types the drag position as a
 * `PhysicalPosition` on all three platforms, but only Windows actually fills one:
 *
 *   - Windows (wry `webview2/drag_drop.rs`): the screen point goes through `ScreenToClient`,
 *     which yields PHYSICAL device pixels. Divide by devicePixelRatio.
 *   - macOS (wry `wkwebview/drag_drop.rs`): the point is built from
 *     `NSDraggingInfo.draggingLocation()` and the WKWebView's `NSView` frame — both AppKit
 *     POINTS — and `tauri-runtime-wry` wraps that tuple straight into `PhysicalPosition::new()`
 *     without ever multiplying by the backing scale factor. It is already CSS pixels.
 *   - Linux (wry `webkitgtk/drag_drop.rs`): raw GTK widget coordinates, also logical.
 *
 * So dividing unconditionally halved every coordinate on a Retina Mac (devicePixelRatio 2): the
 * hit test ran at a point in the upper-left quadrant of the window, which is neither the
 * concierge column nor, usually, the terminal stage. Nothing threw and nothing logged — the drop
 * was simply attributed to empty space. It was invisible to the suite because jsdom reports
 * devicePixelRatio 1, where the wrong formula and the right one agree.
 *
 * OBSERVED AGAINST wry 0.55.x / tauri-runtime-wry 2.11.x. That per-platform split is an upstream
 * INCONSISTENCY, not a contract — the type says `PhysicalPosition`, so a future release that
 * "fixes" macOS/Linux by multiplying in the backing scale factor is a likely change, and a UA rule
 * alone would re-break every target on Retina in exactly the same silent way. Bump either crate and
 * re-verify with a real drag; `reportDropWithNoTarget` below is the alarm if nobody does.
 *
 * So the rule is SELF-CORRECTING first and platform-declared only as a tiebreaker:
 *
 *   1. A position CLEARLY outside the viewport cannot be CSS pixels — the cursor was inside the
 *      window or there would be no drag event — so it must be physical. Divide, whatever the
 *      platform says. Two qualifications on "clearly", because a false positive here IS the silent
 *      misroute this module exists to prevent (roborev 53893):
 *        a. it must overshoot by {@link OUT_OF_VIEWPORT_SLACK_PX}, not by a hair;
 *        b. dividing must land INSIDE the viewport. If it doesn't, the physical reading is no more
 *           plausible than the logical one and we have no business rewriting the coordinate.
 *   2. Otherwise the two readings are genuinely ambiguous (physical 100 at dpr 2 and logical 100
 *      are both plausible points), so fall back to the UA rule above.
 *
 * `position` is optional only so callers that just want the platform rule (tests, diagnostics) can
 * ask for it; every hit test passes one.
 */
export function dragPositionScale(position?: { x: number; y: number }): number {
  const dpr = window.devicePixelRatio || 1;
  // Nothing to divide by, so neither branch below can change the answer.
  if (dpr === 1) return 1;
  // Rule 1. Guarded on a non-zero viewport: a headless/unlaid-out window reports 0 for both, which
  // would make EVERY position look out of bounds and reintroduce the unconditional division.
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (
    position &&
    w > 0 &&
    h > 0 &&
    (position.x > w + OUT_OF_VIEWPORT_SLACK_PX || position.y > h + OUT_OF_VIEWPORT_SLACK_PX) &&
    // The SAME tolerance on the way back (roborev 53914). An exact `<= w` here would contradict the
    // slack above: if the reported space really can differ from the viewport by chrome, a scrollbar
    // or sub-pixel rounding, then a genuine physical point in the last band divides to `w + ε`, the
    // check fails, and we decline to correct — restoring the very misroute rule 1 exists to prevent,
    // precisely for the edge-region drops.
    position.x / dpr <= w + OUT_OF_VIEWPORT_SLACK_PX &&
    position.y / dpr <= h + OUT_OF_VIEWPORT_SLACK_PX
  ) {
    return dpr;
  }
  // Rule 2. The webview's own UA is the platform signal: @tauri-apps/plugin-os is not a dependency,
  // and this has to be answerable synchronously inside a drag handler.
  return /Windows/i.test(navigator.userAgent || "") ? dpr : 1;
}

/** True when the drag position (as Tauri reports it) is over an element inside the named target. */
export function isOverDndTarget(position: { x: number; y: number }, target: string): boolean {
  const scale = dragPositionScale(position);
  // Optional call: jsdom lacks elementFromPoint — tests stub it; real webviews always have it.
  const el = document.elementFromPoint?.(position.x / scale, position.y / scale);
  return !!el?.closest(`[data-dnd-target="${target}"]`);
}

/** Surfaces a window-global listener must stand DOWN over, because something else owns the drop.
 *  One shared list rather than a private copy per listener (roborev 46911/49294): Composer.tsx
 *  reads it so a file can't double-attach, and a target added here reaches every consumer at once
 *  instead of silently regressing whichever copy was forgotten.
 *
 *  NOT every drop target belongs here — TERMINAL_STAGE_DND_TARGET owns its drops and is
 *  deliberately absent; see its comment above for why adding it would break the Sparkle pane's
 *  composer. SPARKLE_TERMINAL_DND_TARGET is the narrow region that CAN be listed: it covers the
 *  Sparkle pane's terminal box only, never the compose box below it, so standing down over it
 *  hands the terminal its own drops without the composer refusing drops on itself. */
export const FILE_DROP_TARGETS = [
  NEW_BUILD_AGENT_DND_TARGET,
  CONCIERGE_COLUMN_DND_TARGET,
  SPARKLE_TERMINAL_DND_TARGET,
] as const;

/** True when the drag position is over ANY surface that accepts the file itself. */
export function isOverFileDropTarget(position: { x: number; y: number } | undefined): boolean {
  if (!position) return false;
  return FILE_DROP_TARGETS.some((t) => isOverDndTarget(position, t));
}

/** Every surface that HANDLES a drop. Deliberately wider than FILE_DROP_TARGETS, which is the
 *  narrower "surfaces the window-global listeners must stand DOWN over" — the terminal stage owns
 *  its drops without anyone standing down. It ALSO used to cover the Sparkle pane's catch-all
 *  Composer, which rendered inside that stage; that composer is gone (Improve Sparkle mounts the
 *  concierge instead), so no catch-all is registered today and a drop outside these targets really
 *  is dead — see registerCatchAllDropTarget. */
const ALL_DND_TARGETS = [
  NEW_BUILD_AGENT_DND_TARGET,
  CONCIERGE_COLUMN_DND_TARGET,
  TERMINAL_STAGE_DND_TARGET,
  SPARKLE_TERMINAL_DND_TARGET,
] as const;

/** Last position already reported, so the four window-global listeners that each decline the same
 *  drop emit ONE line between them rather than four. They are all called synchronously from the
 *  same Tauri event dispatch, so comparing against the previous key is enough — no timer. The cost
 *  is that a second dead drop on the very same pixel goes unlogged, which is fine for a diagnostic
 *  whose whole job is to appear at least once. */
let lastDeadDropKey: string | null = null;

/** How many window-global CATCH-ALL drop listeners are live. See registerCatchAllDropTarget. */
let catchAllDropTargets = 0;

/**
 * Declare a window-global listener that accepts ANY drop not claimed by a `data-dnd-target`
 * surface, and get back its deregister fn.
 *
 * The Sparkle pane's Composer was exactly that: while it was the active pane it took drops on the
 * sidebar, the tab strip, the top bar — anywhere outside FILE_DROP_TARGETS. NOTHING REGISTERS ONE
 * TODAY: that composer was stripped when Improve Sparkle became a mounted build agent, so the
 * counter sits at 0 and reportDropWithNoTarget's warning is once again telling the truth. Kept
 * because the false-alarm shape below is a property of the mechanism, not of that one caller. `ALL_DND_TARGETS`
 * cannot see it, because a catch-all HAS no marked region; it only lists the terminal stage the
 * composer happens to render inside, which covers the drops that were never at risk anyway. So
 * without this, every successful catch-all drop outside the stage made
 * {@link reportDropWithNoTarget} warn that the drop was dead while the composer was attaching the
 * files — a false alarm on the SUCCESS path, diluting the one signal that helper exists to produce
 * (roborev 53893).
 *
 * A counter rather than a boolean: mounts and unmounts can overlap (StrictMode double-invokes
 * effects), and a boolean would be cleared by the first teardown while a live listener remained.
 * The returned fn is idempotent for the same reason.
 */
export function registerCatchAllDropTarget(): () => void {
  catchAllDropTargets += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    catchAllDropTargets -= 1;
  };
}

/**
 * Report a drop that resolved to NO drop target — the signature of a coordinate-space bug.
 *
 * Every drop branch in the app early-returns on a hit-test miss, and that silence is exactly why
 * the devicePixelRatio bug above survived to a user report: "drops do nothing" with an empty log.
 * Call this on the miss path and a dead drop leaves a trace with everything needed to tell a
 * coordinate bug ("scale 1 but the position is off the right edge") from a user who simply let go
 * over the tab bar.
 *
 * Silent when the position DOES match a known target — a listener declining a drop that another
 * one owns is the normal carve-out, not a failure.
 *
 * When a CATCH-ALL is live the line is DOWNGRADED to info, not dropped (roborev 53914/53929).
 * Suppressing it outright would turn off the alarm for the whole time the Sparkle pane is visible —
 * and under a future coordinate-space regression every hit test breaks together, so the concierge
 * would miss its own column while the composer swallowed the file, with zero log output. That
 * trades a false positive on the success path for total blindness on the failure path. Same payload
 * either way; only the level, and the claim the message makes, differ.
 */
export function reportDropWithNoTarget(position: { x: number; y: number }): void {
  if (ALL_DND_TARGETS.some((t) => isOverDndTarget(position, t))) return;
  const key = `${position.x},${position.y}`;
  if (key === lastDeadDropKey) return;
  lastDeadDropKey = key;
  const scale = dragPositionScale(position);
  const detail = {
    position,
    scale,
    hitTest: { x: position.x / scale, y: position.y / scale },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
  if (catchAllDropTargets > 0) {
    // log.INFO, not debug. `debugForwardEnabled` defaults to `Boolean(import.meta.env.DEV)` and
    // nothing in the app ever flips it, so a debug line in a shipped build reaches devtools and
    // NOWHERE ELSE — under the very regression this branch exists to stay diagnosable through, the
    // user reports "drops do nothing", support pulls the log, and it is empty. info/warn/error
    // always forward. Downgrading the ALARM must not mean discarding the RECORD.
    log.info("composer", "file drop matched no marked target; the catch-all composer takes it", detail);
    return;
  }
  log.warn("composer", "file drop landed on no drop target", detail);
}
