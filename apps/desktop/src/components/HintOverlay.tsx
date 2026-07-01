import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { C, FONT, ON_BRAND_FILL_DARK } from "../theme/colors";
import { useHintMode } from "../keyboardHints/useHintMode";
import { AGENT_HINT, assignLabels } from "../keyboardHints/hintTargets";

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
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

// Normalize a KeyboardEvent.key to a label character: letters lowercased, digits and "." as-is.
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : "";
}

// Scan the DOM for tagged controls and assign each a label. Agents (data-hint="agent") are numbered
// top-to-bottom (then left-to-right); chrome controls keep their fixed mnemonic. Returns the placed
// chiclets in render order.
function collectChiclets(): Chiclet[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>("[data-hint]"),
  ).filter(isVisible);

  const agents = nodes
    .filter((el) => el.dataset.hint === AGENT_HINT)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
  const chrome = nodes.filter((el) => el.dataset.hint !== AGENT_HINT);

  // Agents first so they consume the 1..9 numbering in visual order; chrome keeps fixed keys.
  const ordered = [...agents, ...chrome];
  return assignLabels(ordered.map((el) => ({ hintId: el.dataset.hint ?? "", el })))
    .filter((t): t is typeof t & { label: string } => t.label !== null)
    .map((t) => ({ label: t.label, el: t.el, rect: t.el.getBoundingClientRect() }));
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
            // Top-left corner of the control (Vimium convention), nudged out so it overlaps the
            // icon — e.g. the ⚒ pickaxe at the left of an agent row, or the mic at the waveform's left.
            top: Math.max(2, c.rect.top - 6),
            left: Math.max(2, c.rect.left - 6),
            background: C.amber, // gold #e0982f
            color: ON_BRAND_FILL_DARK, // dark navy #0a1a3f, constant across themes
            font: `700 12px/1 ${FONT.mono}`,
            letterSpacing: 0.5,
            padding: "2px 5px",
            borderRadius: 4,
            border: `1px solid ${ON_BRAND_FILL_DARK}`,
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
