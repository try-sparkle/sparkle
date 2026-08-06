// The bead's priority, as a control rather than a readout.
//
// ══ THIS IS `ModelPill` WITH A DIFFERENT LIST, AND THAT IS DELIBERATE ═══════════════════════════
// `components/ModelPill.tsx` is already a pill that opens a pick-one-of-N list, and it has been
// through five rounds of review for the parts that are genuinely hard. Everything load-bearing here
// is carried across rather than re-derived:
//
//   * BOTH the backdrop AND the menu are portaled to `document.body`. This is the one that matters
//     most for THIS pill: it renders inside the concierge column, which is narrow and scrolls, and
//     a menu left in the tree would be clipped by the column and swallowed by its stacking context.
//   * Escape with CABLE ETIQUETTE — bail on `e.defaultPrevented`, then `preventDefault()` — so one
//     press peels this layer only instead of every Escape listener in the app at once.
//   * `data-circuit` on the backdrop, because the cable's "did the press leave the circuit" test
//     walks DOM ancestry and cannot reach a body-level portal from the row it belongs to.
//   * Capture-phase scroll/resize teardown, because the menu's position was captured at open time
//     and the trigger moves under it.
//   * Focus handed back to the trigger on close — but NOT on the scroll path, where refocusing
//     would scroll the pill into view and fight the very scroll that dismissed the menu.
//   * NO `role="menu"`. That announces arrow-key navigation this plain-buttons popover does not
//     implement; `aria-expanded` alone states what is true.
//
// ══ WHAT IS NEW ════════════════════════════════════════════════════════════════════════════════
// Two things. The pill is built from `<span>`s, because it renders inside `<Markdown>`'s `<p>` in
// the concierge chrome (`<button>` is already phrasing content, so the controls need no help). And
// it can be DISABLED, because unlike a model choice this pill performs a real write against a
// heavily contended database — a second pick while the first is still in flight would race two
// writes whose order nobody controls.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { tag } from "../labelTreatment";
import { PRIORITY_OPTIONS, isUrgentPriority, priorityShort } from "./beadPriority";

// Root-context layer order: the menu must paint (and hit-test) above its own backdrop.
const BACKDROP_Z = 60;
const MENU_Z = 61;

/**
 * Marks the portaled layers as belonging to an open bead-card menu.
 *
 * ══ WHY A DOM MARKER RATHER THAN SHARED STATE ══════════════════════════════════════════════════
 * The card that contains this pill has its own Escape and click-outside dismissal. Both portals
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

export function PriorityPill({
  priority,
  onChange,
  disabled = false,
  testId = "bead-card-priority",
}: {
  /** The priority to SHOW — the caller's optimistic value while a write is in flight. */
  priority: number | undefined;
  onChange: (priority: number) => void;
  /** True while a write is in flight: the pill still reads, it just cannot be picked from again. */
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  // The trigger's viewport rect, captured at open time, positions the body-portaled menu. Captured
  // once is safe because the effect below dismisses the menu the moment anything could move the
  // trigger, so the position can never be observed stale.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus(); // hand focus back to the pill (menu rows can hold it)
  };
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    // LEFT-aligned under the pill, where `ModelPill` right-aligns. The difference is the column:
    // that pill sits at the right edge of an agent card, this one sits at the left edge of a card
    // in a narrow column, and a right-aligned menu there would hang off the side it is anchored to.
    setMenuPos(r ? { top: r.bottom + 4, left: Math.max(8, r.left) } : null);
    setOpen(true);
  };

  // A PICK WHILE A WRITE IS IN FLIGHT MUST NOT BE POSSIBLE, and disabling the trigger is only half
  // of it: the menu can already be open when the previous pick starts writing. Closing it here is
  // what makes `disabled` true of the whole control rather than just of its button.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // CABLE ETIQUETTE, both halves. Honour a prior consumer, then consume — so one press peels
      // THIS layer and the card behind it stays open.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    // No focus handoff on this path: `close()`'s `trigger.focus()` scrolls the pill into view, which
    // would fight the very scroll that caused the dismissal.
    const onMove = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const urgent = isUrgentPriority(priority);
  // `tag()` from the shared treatment — the same call `ConciergeAuditPane`'s `codePill` makes. It
  // carries the mono face, the micro step, the near-square `RADIUS.sm` and the ink as BOTH text and
  // edge. Nothing here types a colour or a radius of its own; a capsule (`borderRadius: 999`) is
  // exactly what the treatment exists to refuse.
  const ink = urgent ? C.dangerInk : C.muted;
  return (
    // stopPropagation keeps the pill's clicks off whatever the card is sitting in — the board's
    // detail overlay closes on a click that reaches its scrim. Backdrop/menu clicks bubble through
    // the portals' REACT tree back to this wrapper, so they are stopped here too.
    <span
      data-testid={testId}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: "inline-flex", flex: "0 0 auto", verticalAlign: "baseline" }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid={`${testId}-trigger`}
        data-priority={priority === undefined ? "" : String(priority)}
        disabled={disabled}
        title={
          disabled
            ? "Saving priority…"
            : `Priority ${priorityShort(priority)} — click to change how soon this gets done`
        }
        // No `aria-haspopup`: "true" is an ARIA synonym for "menu", which would announce arrow-key
        // navigation this plain-buttons popover does not implement.
        aria-expanded={open}
        onClick={toggle}
        style={{
          ...tag(ink),
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "transparent",
          padding: "1px 6px",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 auto",
            width: 6,
            height: 6,
            // A DOT IS A CIRCLE, not a radius decision — `borderRadius: "50%"` is what every other
            // status dot in the app uses and is exempt from the radius ratchet for that reason.
            borderRadius: "50%",
            // `sienna` as a FILL only. It measures 3.83:1 on the light theme, so it can never be
            // text ink; the label above is `dangerInk`, which is the themed twin that clears.
            background: urgent ? C.sienna : C.muted,
          }}
        />
        {priorityShort(priority)}
      </button>
      {open &&
        createPortal(
          <>
            <div
              data-testid={`${testId}-backdrop`}
              {...{ [BEAD_CARD_MENU_ATTR]: "" }}
              // PART OF THE LIVE CIRCUIT. Portaled to `document.body`, so the cable's ancestry walk
              // cannot reach it from the row it belongs to, and dismissing this menu would otherwise
              // drop the cable.
              data-circuit
              onClick={close}
              style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
            />
            <div
              data-testid={`${testId}-menu`}
              {...{ [BEAD_CARD_MENU_ATTR]: "" }}
              data-circuit
              // While this menu is up it owns Escape. Without a marker the cable's DOM probe finds
              // nothing dismissible and `unbindsOnKey` returns true, so the press that closes the
              // menu ALSO unbinds the concierge — the same defect the board overlay was fixed for.
              data-dismissible-open="true"
              style={{
                position: "fixed",
                top: menuPos?.top ?? 8,
                left: menuPos?.left ?? 8,
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
                  // Real buttons: Tab-reachable, Enter/Space-activatable, and no `role="menuitem"`
                  // for the reason the header gives. The active option (or the first, when the bead
                  // carries no priority at all) takes focus on open so a keyboard user lands inside
                  // the list rather than behind it.
                  <button
                    key={o.value}
                    type="button"
                    data-testid={`${testId}-option-${o.value}`}
                    autoFocus={active || (i === 0 && priority === undefined)}
                    onClick={() => {
                      close();
                      onChange(o.value);
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
        )}
    </span>
  );
}
