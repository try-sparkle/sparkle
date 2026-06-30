// Global kill-switch for native HTML `title=` tooltips across the whole app.
//
// The webview shows a `title` tooltip a fraction of a second after the pointer settles on an
// element that carries one. We strip the `title` attribute on `mouseover` (capture phase) —
// which fires the instant the pointer enters an element, well before that delay — so the OS
// tooltip never gets a chance to appear. We walk from the hovered element up through its
// ancestors, since the browser also surfaces a `title` inherited from a parent.
//
// React may re-add `title` on a later render; the next hover strips it again. One document-level
// listener covers every component (and any `title=` added in the future), so individual call
// sites don't each have to opt out.
//
// Accessibility: for an icon-only control whose `title` is its ONLY accessible name (no
// aria-label, no visible text), we move the text to `aria-label` before removing `title`, so the
// AX tree still announces it — we suppress the visual tooltip without stripping the name. When the
// control already has a name (visible text or aria-label), `title` was never its accessible name,
// so we just drop it.
export function disableNativeTooltips(): void {
  document.addEventListener(
    "mouseover",
    (e) => {
      let el: Element | null = e.target instanceof Element ? e.target : null;
      while (el) {
        if (el.hasAttribute("title")) {
          const title = el.getAttribute("title") ?? "";
          const alreadyNamed = el.hasAttribute("aria-label") || (el.textContent ?? "").trim() !== "";
          if (title && !alreadyNamed) el.setAttribute("aria-label", title);
          el.removeAttribute("title");
        }
        el = el.parentElement;
      }
    },
    true,
  );
}
