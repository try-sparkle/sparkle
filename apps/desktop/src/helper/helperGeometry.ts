// Pure position math for the floating helper island (spec §5.2).
//
// Everything here is deliberately free of Tauri and DOM so the cases that are painful to
// reproduce by hand — a monitor unplugged out from under a persisted position, a tab dragged
// past the bottom of a secondary display — are covered by ordinary unit tests.
//
// All coordinates are LOGICAL screen pixels in Tauri's global space, where a multi-monitor
// desktop is one continuous plane and a secondary display has a non-zero origin. Nothing here
// may assume the screen starts at (0, 0).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Edge = "left" | "right";

/**
 * The island's FALLBACK footprint — what to use for the frame or two before the DOM has been
 * measured, and in jsdom, where every box measures 0.
 *
 * It is not a reserved width. The island used to be a hard 268×44 with a `flex: 1` spacer holding
 * its right-hand controls out to that edge, which left ~88px of bare C.deepForest (#0f2350) across
 * the middle — the "big block of blue space" in the founder's report. The island now sizes to its
 * content (`width: max-content`) and the MEASURED box drives the window; these numbers are just a
 * close estimate of that content so the first painted frame is not visibly wrong.
 */
export const ISLAND_W = 196;
export const ISLAND_H = 38;

/**
 * Minimized: the sparkle mark alone, docked at a screen edge. SQUARE, because the thing inside it
 * is a square icon.
 *
 * This was a 16×64 sliver holding three grip dots, and it read as a squashed flat pancake with
 * nothing recognisable in it. A mark cannot keep its aspect ratio inside a 16px-wide window, so the
 * shape of the window is the fix, not the artwork.
 */
export const TAB_W = 36;
export const TAB_H = 36;

/** Right-click menu ("Hide Helper" / "Quit Sparkle") and the capture-failure notice. */
export const MENU_W = 168;
export const MENU_H = 68;
/** The failure notice is a line of prose, so it needs its OWN width floor — it can no longer
 *  borrow the island's, which is now only as wide as two counts and two buttons happen to need. */
export const ERROR_W = 268;
export const ERROR_H = 48;

/** A measured box in whatever units the caller measured it in (a DOMRect, in practice). */
export interface Size {
  width: number;
  height: number;
}

/**
 * A measurement worth acting on, rounded UP to whole pixels — or null.
 *
 * Two things are rejected, and both are real: a non-positive box (jsdom reports 0×0, and so does
 * any frame before layout — sizing the OS window to it makes the island invisible), and a
 * non-finite one (`set_size` would take NaN straight to the platform). Callers fall back to the
 * constants above. The ceil matters because `getBoundingClientRect` returns sub-pixel floats:
 * flooring 195.2 to 195 clips the last glyph of the collapse chevron.
 */
export function usableContentSize(m: Size | null | undefined): Size | null {
  if (!m) return null;
  if (!Number.isFinite(m.width) || !Number.isFinite(m.height)) return null;
  if (m.width <= 0 || m.height <= 0) return null;
  return { width: Math.ceil(m.width), height: Math.ceil(m.height) };
}

/** Whole-pixel equality. The resize path is a main-thread IPC round-trip, so it must fire when the
 *  content genuinely changes — a menu opening, a count going from 9 to 10 — and not on every
 *  render or every sub-pixel re-layout. */
export function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * The OS window size needed to actually SHOW what is rendered.
 *
 * This exists because a webview composites nothing outside its native window. The pill is small,
 * so an absolutely-positioned context menu or error notice is simply invisible — which is how
 * "Quit Sparkle" ended up unclickable and the one user-facing error string ("check Screen
 * Recording") could never be read. Overlays must grow the window, not just the DOM.
 *
 * `content` is the measured pill box. Passing it is what makes the window HUG the island instead of
 * reserving a fixed width: shrinking only the DOM would have moved the same empty region into the
 * window's own background, which on a transparent always-on-top panel is just as visible.
 */
export function windowSize(
  mode: "island" | "tab",
  overlays: { menuOpen: boolean; hasError: boolean },
  content?: Size | null,
): { width: number; height: number } {
  const base = pillSize(mode, content);
  let width = base.width;
  let height = base.height;
  if (overlays.menuOpen) {
    width = Math.max(width, MENU_W);
    height += MENU_H;
  }
  if (overlays.hasError) {
    // The notice is full-width prose; neither a 36px tab nor a content-hugged island could show it.
    width = Math.max(width, ERROR_W);
    height += ERROR_H;
  }
  return { width, height };
}

/** The pill's footprint for a mode: the measured box when there is a usable one, else the fallback
 *  constant. One definition, used by the render, the placement and the hit-test — duplicating it is
 *  what let those drift apart. */
export function pillSize(mode: "island" | "tab", content?: Size | null): Size {
  const measured = usableContentSize(content);
  if (measured) return measured;
  return mode === "island"
    ? { width: ISLAND_W, height: ISLAND_H }
    : { width: TAB_W, height: TAB_H };
}

/**
 * The point to ask `screenFor` about when placing the window.
 *
 * For a PERSISTED position this is the stored top-left itself, deliberately: `clampToScreen` and
 * `snapTabToEdge` both guarantee the value they wrote lies inside the screen they were given, so
 * the top-left is always on the right display — no matter what footprint it was written under, or
 * what is being rendered now. Adding half a footprint is what broke this repeatedly: the mode can
 * change without rewriting the coordinate (a tab→island expand, or a capture failure expanding a
 * collapsed tab), and a centre computed from the wrong width lands off every display, so
 * `screenFor` falls back to the first one and the window teleports to another monitor.
 *
 * A FRESH position has no such guarantee — it is a proposal, not a clamped result — so it is
 * measured from its centre.
 */
export function hitTestPoint(
  want: { x: number; y: number },
  fresh: boolean,
  pill: { width: number; height: number },
): { x: number; y: number } {
  return fresh ? { x: want.x + pill.width / 2, y: want.y + pill.height / 2 } : { ...want };
}

/** Keep a window fully inside `screen`. The `Math.max` against the screen origin runs LAST so a
 *  window larger than the display pins to the top-left rather than being pushed off-screen by a
 *  negative max-position. */
export function clampToScreen(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  screen: Rect,
): { x: number; y: number } {
  const maxX = screen.x + screen.width - size.width;
  const maxY = screen.y + screen.height - size.height;
  return {
    x: Math.max(screen.x, Math.min(pos.x, maxX)),
    y: Math.max(screen.y, Math.min(pos.y, maxY)),
  };
}

/** Which vertical edge of `screen` the window's centre is closer to. Ties go RIGHT — an
 *  arbitrary but fixed choice, so a tab released dead-centre always lands the same way. */
export function nearerEdge(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  screen: Rect,
): Edge {
  const centreX = pos.x + size.width / 2;
  const screenCentreX = screen.x + screen.width / 2;
  return centreX < screenCentreX ? "left" : "right";
}

/**
 * Park the pull tab flush against the nearer edge, preserving its vertical position.
 *
 * `size` is the size of the WINDOW being placed, which is not always the bare tab: an open context
 * menu or a capture-failure notice inflates it (see `windowSize`). Anchoring a 168px-wide window at
 * `screenRight - TAB_W` would push everything past the tab's own 36px — the menu included — off the
 * screen, which is how "Quit Sparkle" stayed unreachable for a right-docked tab even after the
 * window started growing.
 * Which EDGE it snaps to is still decided by the tab's own footprint, so an overlay opening cannot
 * make it jump sides.
 */
export function snapTabToEdge(
  pos: { x: number; y: number },
  screen: Rect,
  size: { width: number; height: number } = { width: TAB_W, height: TAB_H },
): { x: number; y: number; edge: Edge } {
  const edge = nearerEdge(pos, { width: TAB_W, height: TAB_H }, screen);
  const wantX = edge === "left" ? screen.x : screen.x + screen.width - size.width;
  // Clamp BOTH axes. On a screen narrower than the window — including the zero rect screenFor
  // returns for an empty display list — the right-edge formula yields a negative x.
  const { x, y } = clampToScreen({ x: wantX, y: pos.y }, size, screen);
  return { x, y, edge };
}

/** The display containing `center`. Falls back to the first display when the point is on none —
 *  which is exactly what happens when a persisted position refers to a monitor that has since
 *  been unplugged. An empty display list yields a zero rect, so callers still get a Rect and the
 *  clamp above degrades to pinning at the origin rather than throwing. */
export function screenFor(center: { x: number; y: number }, screens: Rect[]): Rect {
  const hit = screens.find(
    (s) =>
      center.x >= s.x &&
      center.x < s.x + s.width &&
      center.y >= s.y &&
      center.y < s.y + s.height,
  );
  return hit ?? screens[0] ?? { x: 0, y: 0, width: 0, height: 0 };
}
