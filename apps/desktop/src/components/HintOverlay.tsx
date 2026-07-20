import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { C, FONT, ON_BRAND_FILL_DARK } from "../theme/colors";
import { useHintMode } from "../keyboardHints/useHintMode";
import {
  AGENT_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  assignLabels,
} from "../keyboardHints/hintTargets";

// A single placed chiclet: the label and the screen rect of the control it sits on.
type Chiclet = { label: string; rect: DOMRect; el: HTMLElement };

// True for elements that are actually on screen and clickable: laid out (offsetParent), non-zero
// size, and at least partially within the viewport. Filters out display:none / collapsed / mode-
// gated controls (e.g. Think behind a flag, the account badge when there are no accounts).
function isVisible(el: HTMLElement): boolean {
  // A disabled control can't be clicked, so don't offer a (dead) chiclet for it.
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (!(r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth)) {
    return false;
  }
  return !isClippedByAncestor(el, r);
}

// getBoundingClientRect reports an element's UNCLIPPED layout box, so a row scrolled out of an
// overflow container still reports a plausible on-screen rect. Without this check the Recent
// dropdown (maxHeight + overflowY:auto) hands out badges for rows nobody can see, and they get
// drawn below the popover over unrelated page content. Walk the ancestor chain and reject the
// element if the point we anchor its badge to falls outside any clipping ancestor's box.
function isClippedByAncestor(el: HTMLElement, r: DOMRect): boolean {
  const anchorX = r.left;
  const anchorY = r.top + r.height / 2;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    // Test THIS ancestor's own clip box before considering whether to stop — a container can be
    // both `position: fixed` and a scroller, and it still clips its own overflowing children.
    if (CLIPS.test(s.overflowX) || CLIPS.test(s.overflowY)) {
      const pr = p.getBoundingClientRect();
      // A zero-size ancestor isn't laid out, so there's nothing meaningful to clip against.
      if (pr.width > 0 || pr.height > 0) {
        if (anchorY < pr.top || anchorY > pr.bottom || anchorX < pr.left || anchorX > pr.right) {
          return true;
        }
      }
    }
    // A `fixed` element is positioned against the viewport, so nothing ABOVE it can clip it.
    if (s.position === "fixed") return false;
  }
  return false;
}

const CLIPS = /^(auto|scroll|hidden|clip)$/;

// Badge box metrics. These are the single source of truth: the style block below reads them, and
// BADGE_H is DERIVED from them, so restyling the chiclet can't silently un-center it.
const BADGE_LINE_H = 12; // font line-height, px
const BADGE_PAD_Y = 2; // vertical padding, px
const BADGE_PAD_X = 5; // horizontal padding, px
const BADGE_BORDER = 1; // border width, px
const BADGE_H = BADGE_LINE_H + 2 * BADGE_PAD_Y + 2 * BADGE_BORDER;

// Normalize a KeyboardEvent.key to a label character: letters lowercased, digits and "." as-is.
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : "";
}

// Top-to-bottom, then left-to-right — the reading order used to number positional hints.
function byVisualOrder(a: HTMLElement, b: HTMLElement): number {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return ra.top - rb.top || ra.left - rb.left;
}

// Label a set of already-ordered elements and turn them into placed chiclets, dropping any that
// couldn't be assigned a label (e.g. a 27th recent row, or an unknown chrome id).
function place(els: HTMLElement[]): Chiclet[] {
  return assignLabels(els.map((el) => ({ hintId: el.dataset.hint ?? "", el })))
    .filter((t): t is typeof t & { label: string } => t.label !== null)
    .map((t) => ({ label: t.label, el: t.el, rect: t.el.getBoundingClientRect() }));
}

// Scan the DOM for tagged controls and assign each a label. Agents (data-hint="agent") are numbered
// top-to-bottom (then left-to-right); chrome controls keep their fixed mnemonic. Returns the placed
// chiclets in render order.
function collectChiclets(): Chiclet[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-hint]"),
  ).filter(isVisible);

  // Recent-dropdown mode: when its rows are on screen, this is a focused "pick a project" moment.
  // Show ONLY the row badges (lettered a–z top to bottom) and suppress chrome/agents, so the whole
  // alphabet is collision-free and the eye goes straight to the list being chosen from.
  const recentItems = nodes
    .filter((el) => el.dataset.hint === RECENT_HINT)
    .sort(byVisualOrder);
  if (recentItems.length > 0) {
    // Every row before any Switch button: assignLabels walks one shared counter, so the rows claim
    // a.. in list order and the switches continue from there (13 rows → switches start at "n").
    const switches = nodes
      .filter((el) => el.dataset.hint === RECENT_SWITCH_HINT)
      .sort(byVisualOrder);
    return place([...recentItems, ...switches]);
  }

  const agents = nodes
    .filter((el) => el.dataset.hint === AGENT_HINT)
    .sort(byVisualOrder);
  // A Switch button only exists inside a Recent row, so if we got here there are none — but filter
  // it out anyway so it can never leak into the chrome bucket and resolve to a null label.
  const chrome = nodes.filter(
    (el) =>
      el.dataset.hint !== AGENT_HINT &&
      el.dataset.hint !== RECENT_HINT &&
      el.dataset.hint !== RECENT_SWITCH_HINT,
  );

  // Agents first so they consume the 1..9 numbering in visual order; chrome keeps fixed keys.
  return place([...agents, ...chrome]);
}

// The keyboard-hint overlay. Mounted once at the app root; renders nothing until a clean ⌘ tap opens
// it (see useHintMode). When open it draws a gold chiclet over each tagged control and activates the
// matching control on a label keypress by firing that element's existing click handler.
export function HintOverlay() {
  const { active, close } = useHintMode();
  const [chiclets, setChiclets] = useState<Chiclet[]>([]);

  const refresh = useCallback(() => setChiclets(collectChiclets()), []);

  // Compute placements as soon as we open (and on resize while open). Scroll dismisses instead of
  // re-placing (handled in useHintMode), so positions never go stale under the chiclets.
  useLayoutEffect(() => {
    if (!active) {
      setChiclets([]);
      return;
    }
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [active, refresh]);

  // Label-key selection. Capture phase so we intercept the key before xterm/inputs consume it.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Nothing to select and nothing rendered (see the chiclets.length guard below) — don't
      // swallow keys, or an invisible-but-active overlay would silently eat keystrokes.
      if (chiclets.length === 0) return;
      if (e.key === "Escape" || e.key === "Meta" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = normalizeKey(e.key);
      // Non-printable keys (arrows, Tab, …) pass through so the user can still navigate/escape.
      if (!key) return;
      // Printable keys are swallowed while the overlay is open — it's a modal-feeling layer, so a
      // stray non-hint key must NOT leak into the focused terminal/composer underneath.
      e.preventDefault();
      e.stopPropagation();
      const hit = chiclets.find((c) => c.label === key);
      if (!hit) return; // unassigned key: no-op, stay open
      close();
      // Fire the control's own click handler. Deferred a tick so React has torn down the overlay
      // first (a synchronous click could re-enter layout while we're mid-update).
      const { el } = hit;
      setTimeout(() => el.click(), 0);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, chiclets, close]);

  if (!active || chiclets.length === 0) return null;

  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000, // above every modal/menu/tooltip
        pointerEvents: "none",
      }}
    >
      {chiclets.map((c, i) => (
        <div
          key={`${c.label}-${i}`}
          style={{
            position: "fixed",
            // Left edge of the control, vertically CENTERED on it. Anchoring to the top-left corner
            // (the Vimium convention) makes a badge straddle the boundary between two list rows, so
            // in a dense list it reads as belonging to the row above — the "letters don't track the
            // options" complaint. Centering ties each badge unambiguously to one row.
            top: Math.max(2, c.rect.top + c.rect.height / 2 - BADGE_H / 2),
            left: Math.max(2, c.rect.left - 6),
            background: C.amber, // gold #e0982f
            color: ON_BRAND_FILL_DARK, // dark navy #0a1a3f, constant across themes
            font: `700 ${BADGE_LINE_H}px/1 ${FONT.mono}`,
            letterSpacing: 0.5,
            padding: `${BADGE_PAD_Y}px ${BADGE_PAD_X}px`,
            borderRadius: 4,
            border: `${BADGE_BORDER}px solid ${ON_BRAND_FILL_DARK}`,
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            textTransform: "uppercase",
          }}
        >
          {c.label}
        </div>
      ))}
    </div>,
    document.body,
  );
}
