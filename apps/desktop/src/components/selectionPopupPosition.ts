// Pure viewport-clamping math for the terminal selection popup. Prefers below-and-right of the
// cursor; flips to the other side of an edge it would overflow; always stays within `margin`.

export function popupPosition(
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  margin = 8,
): { left: number; top: number } {
  const gap = 8; // offset from the cursor so the popup doesn't sit under the pointer
  // Horizontal: default right of the cursor; if that overflows, pull left so the right edge fits.
  let left = cursor.x + gap;
  if (left + size.w + margin > viewport.w) {
    left = Math.min(viewport.w - size.w - margin, cursor.x - size.w - gap);
  }
  left = Math.max(margin, left);

  // Vertical: default below the cursor; if that overflows, place it above.
  let top = cursor.y + gap;
  if (top + size.h + margin > viewport.h) {
    top = cursor.y - size.h - gap;
  }
  top = Math.max(margin, top);

  return { left, top };
}
