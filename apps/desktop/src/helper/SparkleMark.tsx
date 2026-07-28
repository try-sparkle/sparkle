// The square sparkle mark, made safe to DRAG ON.
//
// Shared by the island (where the mark is the drag handle) and the minimized tab (where it is the
// whole affordance), because the reason it needs `draggable={false}` is easy to lose and expensive
// to rediscover:
//
// A bare <img> is natively draggable, and WebKit maps the HTML `draggable` content attribute onto
// the CSS `-webkit-user-drag` property, whose initial value for an image is `element`. So a
// press-and-move on an untouched <img> starts an OS IMAGE DRAG: WKWebView takes the gesture, emits
// `pointercancel`, and the `pointermove` listeners that move the helper window never hear another
// event. Every other part of the island strip dragged fine, which is exactly the report — "I want
// to click on the sparkle icon to use it as a grab handle to drag the island around, but it's not
// working."
//
// `draggable={false}` is the fix (it is what WebKit actually consults); the CSS and the dragstart
// handler are belt to its braces, covering the paths that do not go through the content attribute.
import type { CSSProperties } from "react";
/**
 * Everything that stops the platform from treating this image as draggable CONTENT.
 *
 * Hoisted and cast because `WebkitUserDrag` is not in csstype — it is WebKit-only and was never
 * standardised, so TypeScript rejects it in a style literal even though React passes any camelCased
 * key straight through to CSSStyleDeclaration, where WKWebView honours it. Spreading a
 * pre-typed object is the narrowest way to say that, rather than casting the whole style.
 */
const NO_NATIVE_DRAG = {
  WebkitUserDrag: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
} as CSSProperties;

export function SparkleMark({
  size,
  cursor,
  /** "" for the tab, whose <button> already carries the accessible name — an alt there would just
   *  say the same thing twice to a screen reader. */
  alt = "Sparkle",
}: {
  size: number;
  cursor: "grab" | "pointer";
  alt?: string;
}) {
  return (
    <img
      src="/sparkle-mark.svg"
      alt={alt}
      aria-hidden={alt === "" ? true : undefined}
      width={size}
      height={size}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      style={{
        width: size,
        height: size,
        // Never squashed: the mark is square artwork and the box it sits in must stay square, in
        // the island's flex row and inside the minimized tab alike.
        flex: "0 0 auto",
        cursor,
        ...NO_NATIVE_DRAG,
      }}
    />
  );
}
