// The pick-one-of-four priority popover, shared by BOTH priority controls.
//
// ══ WHY THIS IS ITS OWN FILE ═══════════════════════════════════════════════════════════════════
// It used to live inside `PriorityPill`, which was fine while the pill was the only editable
// priority surface. The founder then asked for the board's CHIP to be editable too ("I also want to
// be able to click on the chicklet to change the priority… it should give me a little drop down"),
// and every hard part of this popover is hard for reasons that have nothing to do with which
// trigger opened it: the body portal, the Escape etiquette, the `data-circuit` marker, the
// capture-phase scroll teardown. Copying them into a second component is how two menus start
// drifting apart, so the menu moved here and both triggers mount it.
//
// Everything load-bearing is carried across verbatim from `PriorityPill` (which carried it from
// `ModelPill`, after five rounds of review) — see that file's header for why each one exists:
//
//   * BOTH the backdrop AND the menu are portaled to `document.body`, so a narrow scrolling column
//     cannot clip the menu and its stacking context cannot swallow it.
//   * Escape with CABLE ETIQUETTE — bail on `e.defaultPrevented`, then `preventDefault()`.
//   * `data-circuit` on both layers, because the cable's "did the press leave the circuit" test
//     walks DOM ancestry and cannot reach a body-level portal from the row it belongs to.
//   * Capture-phase scroll/resize teardown, because the position was captured at open time.
//   * The active option takes focus on open, so a keyboard user lands inside the list.
//
// ══ WHAT IS NEW HERE, AND WHY ══════════════════════════════════════════════════════════════════
// Two additions, both forced by the chip's call sites rather than invented:
//
//   1. THE PORTALED LAYERS STOP THEIR OWN PROPAGATION. React events bubble through the REACT tree,
//      not the DOM one, so a click on a menu row re-emerges at whatever JSX contains the portal.
//      `PriorityPill` contained that with a wrapper `<span>` around trigger AND portal. The chip
//      cannot use that trick: it renders INSIDE a row that is itself a `<button>` (the epic row and
//      the board card both), and its own trigger must stay a single element so `data-testid` and
//      `data-priority` keep pointing at the thing callers already read. Containing the press HERE
//      makes the menu safe under any parent, which is the property a shared component needs.
//   2. ARROW-KEY NAVIGATION, and therefore honest `role="menu"` / `role="menuitemradio"`.
//      `PriorityPill` deliberately omitted those roles because it announced navigation it did not
//      implement; the fix is to implement it, not to keep the promise small. Home/End included,
//      wrapping at both ends, because a four-row list is faster to wrap than to bound. The rows are
//      `menuitemRADIO` rather than plain `menuitem` because exactly one is current and `menuitem`
//      does not support `aria-checked` — see the row itself.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { C } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { PRIORITY_OPTIONS, isUrgentPriority } from "./beadPriority";

// Root-context layer order: the menu must paint (and hit-test) above its own backdrop.
const BACKDROP_Z = 60;
const MENU_Z = 61;

/**
 * Marks the portaled layers as belonging to an open bead-card menu.
 *
 * ══ WHY A DOM MARKER RATHER THAN SHARED STATE ══════════════════════════════════════════════════
 * The card that contains the trigger has its own Escape and click-outside dismissal. Both portals
 * live at `document.body`, i.e. OUTSIDE the card — so the card's outside-click guard would read a
 * click on a menu row as a click outside itself and close the card under the reader's cursor, and
 * its Escape handler (registered first, since the card opened first) would close the card instead
 * of the menu.
 *
 * The card therefore asks the DOM whether a menu is open before acting on either. A marker
 * attribute is the smallest thing that answers it, needs no context or store, and is true exactly
 * while the portal is mounted — there is no state to get out of step.
 */
export const BEAD_CARD_MENU_ATTR = "data-bead-card-menu";

/** True when a bead-card menu is currently open anywhere. See {@link BEAD_CARD_MENU_ATTR}. */
export function beadCardMenuIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector(`[${BEAD_CARD_MENU_ATTR}]`) !== null;
}

/** Where the menu paints, in VIEWPORT coordinates, captured by the trigger at open time. */
export interface PriorityMenuAnchor {
  top: number;
  left: number;
}

/**
 * The popover itself. Mounted only while open — "open" is expressed by whether this is in the
 * tree, so there is no second boolean to get out of step with the portal.
 */
export function PriorityMenu({
  anchor,
  priority,
  onPick,
  onClose,
  onDismiss,
  testId,
}: {
  /** Captured by the trigger at open time; `null` falls back to the viewport corner. */
  anchor: PriorityMenuAnchor | null;
  /** The priority to mark as active — the caller's optimistic value while a write is in flight. */
  priority: number | undefined;
  onPick: (priority: number) => void;
  /** Escape or a backdrop click. The caller hands focus back to its trigger on this path. */
  onClose: () => void;
  /**
   * Scroll or resize moved the trigger out from under a position captured at open time.
   *
   * SEPARATE FROM `onClose` ON PURPOSE: refocusing the trigger here would scroll it back into view
   * and fight the very scroll that dismissed the menu.
   */
  onDismiss: () => void;
  testId: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // CABLE ETIQUETTE, both halves. Honour a prior consumer, then consume — so one press peels
      // THIS layer and the card behind it stays open.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    const onMove = () => onDismiss();
    window.addEventListener("keydown", onKey);
    // CAPTURE, because a scroll inside a column does not bubble to `window`.
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [onClose, onDismiss]);

  // ROVING FOCUS. The options are real buttons, so this only has to MOVE focus — it never has to
  // synthesise activation, which Enter and Space already do natively on each row.
  function onMenuKeyDown(e: React.KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const rows = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button[data-priority-option]") ?? [],
    );
    if (rows.length === 0) return;
    const here = rows.indexOf(document.activeElement as HTMLButtonElement);
    // WRAPPING AT BOTH ENDS. Four rows is a short enough list that running off the bottom and
    // landing back at the top is faster than being stopped there; `%` on a negative needs the
    // second `+ rows.length` to stay in range.
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? rows.length - 1
          : e.key === "ArrowDown"
            ? (here + 1 + rows.length) % rows.length
            : (here - 1 + rows.length) % rows.length;
    e.preventDefault();
    // The row this menu sits in may itself be a control that moves selection on arrow keys.
    e.stopPropagation();
    rows[next]?.focus();
  }

  // THE PRESS MUST NOT RE-EMERGE AT THE PARENT. See item 1 of the header: React bubbles portal
  // events through the JSX tree, so without this a menu row's click reaches the row `<button>` the
  // chip renders inside and toggles it — the exact behaviour the founder asked to prevent.
  const contain = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };

  return createPortal(
    <>
      <div
        data-testid={`${testId}-backdrop`}
        {...{ [BEAD_CARD_MENU_ATTR]: "" }}
        // PART OF THE LIVE CIRCUIT. Portaled to `document.body`, so the cable's ancestry walk
        // cannot reach it from the row it belongs to, and dismissing this menu would otherwise
        // drop the cable.
        data-circuit
        {...contain}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
      />
      <div
        ref={menuRef}
        data-testid={`${testId}-menu`}
        {...{ [BEAD_CARD_MENU_ATTR]: "" }}
        data-circuit
        // While this menu is up it owns Escape. Without a marker the cable's DOM probe finds
        // nothing dismissible and `unbindsOnKey` returns true, so the press that closes the
        // menu ALSO unbinds the concierge — the same defect the board overlay was fixed for.
        data-dismissible-open="true"
        role="menu"
        aria-label="Priority"
        {...contain}
        onKeyDown={onMenuKeyDown}
        style={{
          position: "fixed",
          top: anchor?.top ?? 8,
          left: anchor?.left ?? 8,
          minWidth: 240,
          background: C.deepForest,
          border: `1px solid ${C.hairline}`,
          borderRadius: RADIUS.modal,
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          padding: 6,
          zIndex: MENU_Z,
        }}
      >
        {PRIORITY_OPTIONS.map((o, i) => {
          const active = o.value === priority;
          return (
            // Real buttons: Enter/Space-activatable for free. The active option (or the first, when
            // the bead carries no priority at all) takes focus on open so a keyboard user lands
            // inside the list rather than behind it.
            <button
              key={o.value}
              type="button"
              data-testid={`${testId}-option-${o.value}`}
              data-priority-option={String(o.value)}
              // `menuitemradio`, NOT `menuitem`: `aria-checked` is not a supported attribute of
              // `menuitem`, so a plain menuitem carrying it announces a state the role does not
              // define — the reader is told nothing about which level is current. This is the same
              // pick-one-of-N shape `AudioInputPicker` already uses, and the same role it picked.
              role="menuitemradio"
              aria-checked={active}
              autoFocus={active || (i === 0 && priority === undefined)}
              onClick={(e) => {
                e.stopPropagation();
                onPick(o.value);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                border: "none",
                borderRadius: RADIUS.modal,
                cursor: "pointer",
                fontFamily: FONT_UI,
                fontSize: TYPE.small,
                color: C.cream,
                // `pillFill`, not `forest`: the selected row's fill IS the selection, and
                // forest is a hair from the `deepForest` menu it sits on.
                background: active ? C.pillFill : "transparent",
                whiteSpace: "nowrap",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  flex: "0 0 auto",
                  background: isUrgentPriority(o.value) ? C.sienna : C.muted,
                  opacity: active ? 1 : 0.45,
                }}
              />
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
