import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C, FONT, ON_GOLD_FILL } from "../theme/colors";
import { useHintMode } from "../keyboardHints/useHintMode";
import {
  AGENT_HINT,
  PROJECT_TAB_HINT,
  RECENT_HINT,
  RECENT_SWITCH_HINT,
  RECENT_TRIGGER_HINT,
  HINT_JUMP_ATTR,
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
  // Project tabs read left to right along one row, which byVisualOrder gives us for free (equal
  // tops → compare lefts).
  const tabs = nodes
    .filter((el) => el.dataset.hint === PROJECT_TAB_HINT)
    .sort(byVisualOrder);
  // A Switch button only exists inside a Recent row, so if we got here there are none — but filter
  // it out anyway so it can never leak into the chrome bucket and resolve to a null label.
  const chrome = nodes.filter(
    (el) =>
      el.dataset.hint !== AGENT_HINT &&
      el.dataset.hint !== PROJECT_TAB_HINT &&
      el.dataset.hint !== RECENT_HINT &&
      el.dataset.hint !== RECENT_SWITCH_HINT,
  );

  // Tabs first, then agents, then chrome: tabs claim the head of the shared overflow pool in
  // left-to-right order, agents take 1..9 in visual order and resume the pool after the tabs, and
  // chrome keeps its fixed keys. (assignLabels counts the tabs up front, so this order is for
  // readable, stable placement rather than something the labels depend on.)
  return place([...tabs, ...agents, ...chrome]);
}

// The keyboard-hint overlay. Mounted once at the app root; renders nothing until a clean ⌘ tap opens
// it (see useHintMode). When open it draws a gold chiclet over each tagged control and activates the
// matching control on a label keypress by firing that element's existing click handler.
export function HintOverlay() {
  const { active, close } = useHintMode();
  const [chiclets, setChiclets] = useState<Chiclet[]>([]);

  // The keydown listener below reads the CURRENT chiclets through this ref rather than closing over
  // the `chiclets` state. Those are not equivalent, and the difference was a dropped keystroke.
  //
  // Binding the listener from an effect that depends on `chiclets` means the handler that is live
  // at any instant is the one from the last COMMITTED effect pass. React runs passive effects after
  // paint, so between "the new badges are on screen" and "the listener that knows about them is
  // bound" there is a real window. A key pressed in that window resolves against the stale array,
  // finds no match, and is swallowed by the printable-key guard — silently, since an unmatched
  // label is a deliberate no-op.
  //
  // That window is exactly where this feature asks the user to type. Opening the Recent dropdown
  // with "r" keeps hint mode active precisely so a project can be picked in the same breath, so the
  // fastest users — the ones the chaining flow is for — are the likeliest to lose the second key.
  // It surfaced as a CI flake (HintOverlay.test.tsx, "an a–z letter selects that project"): under
  // coverage instrumentation the effect flush shifts far enough to lose the race almost every run,
  // which is the same defect the product has, just made reproducible.
  //
  // A ref updated in the same tick as the state has no such window: the handler always sees the
  // latest placements. It also stops the listener being torn down and rebound on every re-collect.
  const chicletsRef = useRef<Chiclet[]>([]);
  const applyChiclets = useCallback((next: Chiclet[]) => {
    chicletsRef.current = next;
    setChiclets(next);
  }, []);

  const refresh = useCallback(() => applyChiclets(collectChiclets()), [applyChiclets]);

  // Compute placements as soon as we open (and on resize while open). Scroll dismisses instead of
  // re-placing (handled in useHintMode), so positions never go stale under the chiclets.
  useLayoutEffect(() => {
    if (!active) {
      applyChiclets([]);
      return;
    }
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [active, refresh, applyChiclets]);

  // Label-key selection. Capture phase so we intercept the key before xterm/inputs consume it.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Nothing to select and nothing rendered (see the chiclets.length guard below) — don't
      // swallow keys, or an invisible-but-active overlay would silently eat keystrokes.
      const current = chicletsRef.current;
      if (current.length === 0) return;
      if (e.key === "Escape" || e.key === "Meta" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = normalizeKey(e.key);
      // Non-printable keys (arrows, Tab, …) pass through so the user can still navigate/escape.
      if (!key) return;
      // Printable keys are swallowed while the overlay is open — it's a modal-feeling layer, so a
      // stray non-hint key must NOT leak into the focused terminal/composer underneath.
      e.preventDefault();
      e.stopPropagation();
      const hit = current.find((c) => c.label === key);
      if (!hit) return; // unassigned key: no-op, stay open
      const { el } = hit;
      // Opening the Recent-projects dropdown by keyboard is a "chain straight into picking a
      // project" moment: keep hint mode ACTIVE instead of closing, so the dropdown's a–z row
      // badges appear at once and the user can pick without tapping the trigger again. Click to
      // open the dropdown, then re-collect after a double rAF — that gives React time to mount the
      // rows, so collectChiclets finds the recent-item rows and switches to its dropdown mode.
      // A programmatic el.click() dispatches a "click", not a "mousedown", so useHintMode's
      // mousedown-closes-overlay listener never fires — the overlay correctly stays open. (Every
      // OTHER control, including the dropdown's own recent-item rows, falls through to close+click.)
      if (el.dataset.hint === RECENT_TRIGGER_HINT) {
        el.click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const next = collectChiclets();
            // Dropdown opened with rows → show their a–z badges and stay open to chain a pick.
            // Opened empty (no recent projects) → there's nothing to pick, so close instead of
            // stranding the user on a "stuck open" chrome overlay still showing the r badge.
            if (next.some((c) => c.el.dataset.hint === RECENT_HINT)) applyChiclets(next);
            else close();
          }),
        );
        return;
      }
      close();
      // Fire the control's own click handler. Deferred a tick so React has torn down the overlay
      // first (a synchronous click could re-enter layout while we're mid-update).
      //
      // MARKED while it fires. A hint jump means "take me to this thing", and a handler may
      // reasonably do less for it than for a real click — the Build column's agent rows fold their
      // worker subtree on click, and a jump that also folded (and PERSISTED that fold) made
      // repeated jumps flip-flop a subtree the user never touched. The attribute is the explicit
      // signal for that. Sniffing `event.detail === 0` was tried instead and is wrong: detail
      // describes the DISPATCH MECHANISM, so AT activations (VoiceOver/Switch Control AXPress) look
      // identical to this and would silently lose the fold too.
      setTimeout(() => {
        el.setAttribute(HINT_JUMP_ATTR, "");
        try {
          el.click();
        } finally {
          el.removeAttribute(HINT_JUMP_ATTR);
        }
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // `chiclets` is deliberately NOT a dependency: the handler reads chicletsRef, so rebinding on
    // every re-collect would buy nothing and reintroduce the stale-listener window described above.
  }, [active, close, applyChiclets]);

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
            // The themed opaque-gold PAIR (fill + the ink that sits on it): the prototype's
            // gold under near-black in dark, a deep gold under light ink in light. These badges
            // float over whatever is on screen, including light mode's white terminal. This said
            // "gold #e0982f" while painting the amber STATUS token; the gold token exists now.
            background: C.goldFill,
            color: ON_GOLD_FILL,
            font: `700 ${BADGE_LINE_H}px/1 ${FONT.mono}`,
            letterSpacing: 0.5,
            padding: `${BADGE_PAD_Y}px ${BADGE_PAD_X}px`,
            borderRadius: 4,
            border: `${BADGE_BORDER}px solid ${ON_GOLD_FILL}`,
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
