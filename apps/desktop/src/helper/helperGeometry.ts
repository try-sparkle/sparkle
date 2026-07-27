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

/** Island: wide enough for the sparkle glyph, two count chiclets, Capture, and the collapse
 *  handle without wrapping at the 13px base font. */
export const ISLAND_W = 268;
export const ISLAND_H = 44;

/** Pull tab: a thin vertical sliver, tall enough to be an easy click target at a screen edge. */
export const TAB_W = 16;
export const TAB_H = 64;

/** Right-click menu ("Hide Helper" / "Quit Sparkle") and the capture-failure notice. */
export const MENU_W = 168;
export const MENU_H = 68;
export const ERROR_H = 48;

/**
 * The OS window size needed to actually SHOW what is rendered.
 *
 * This exists because a webview composites nothing outside its native window. The island is only
 * 268×44 (and the tab 16×64), so an absolutely-positioned context menu or error notice is simply
 * invisible — which is how "Quit Sparkle" ended up unclickable and the one user-facing error
 * string ("check Screen Recording") could never be read. Overlays must grow the window, not just
 * the DOM.
 */
export function windowSize(
  mode: "island" | "tab",
  overlays: { menuOpen: boolean; hasError: boolean },
): { width: number; height: number } {
  let width = mode === "island" ? ISLAND_W : TAB_W;
  let height = mode === "island" ? ISLAND_H : TAB_H;
  if (overlays.menuOpen) {
    width = Math.max(width, MENU_W);
    height += MENU_H;
  }
  if (overlays.hasError) {
    // The notice is full-width prose; a 16px-wide tab could never show it.
    width = Math.max(width, ISLAND_W);
    height += ERROR_H;
  }
  return { width, height };
}

/** The pill's footprint for a mode. One definition, used by both the render and the hit-test —
 *  duplicating it is what let the two drift apart. */
export function pillSize(mode: "island" | "tab"): { width: number; height: number } {
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
 * `screenRight - TAB_W` would push 152px of it — including the menu — off the screen, which is how
 * "Quit Sparkle" stayed unreachable for a right-docked tab even after the window started growing.
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
