// The bead's priority, as a control rather than a readout — the DETAIL-CARD trigger.
//
// ══ THE MENU LIVES IN `PriorityMenu`, AND THIS FILE IS NOW JUST THE TRIGGER ════════════════════
// Everything genuinely hard about the popover — the body portal, Escape's cable etiquette, the
// `data-circuit` marker, capture-phase scroll teardown, the `data-bead-card-menu` marker other
// surfaces probe for — moved to `./PriorityMenu` when the board's `BeadPriorityChip` became
// editable too. Read that file's header for why each piece exists; nothing was dropped, and the
// testids (`-menu`, `-backdrop`, `-option-<n>`) are unchanged, because three suites read them.
//
// `BEAD_CARD_MENU_ATTR` and `beadCardMenuIsOpen` are RE-EXPORTED from here rather than moved,
// because `BoardView` and `Concierge/BeadPill` import them from this path and are owned elsewhere.
//
// ══ WHAT IS STILL SPECIFIC TO THIS PILL ════════════════════════════════════════════════════════
// Two things. The trigger is a real `<button>`, which is correct HERE — the detail card renders it
// inside `<Markdown>`'s `<p>` in the concierge chrome, i.e. inside phrasing content, not inside
// another button. (The board chip cannot do that; see `BeadPriorityChip`.) And it can be DISABLED,
// because unlike a model choice this pill performs a real write against a heavily contended
// database — a second pick while the first is still in flight would race two writes whose order
// nobody controls.
import { useEffect, useRef, useState } from "react";
import { C } from "../../theme/colors";
import { tag } from "../labelTreatment";
import { isUrgentPriority, priorityShort } from "./beadPriority";
import { PriorityMenu, type PriorityMenuAnchor } from "./PriorityMenu";

export { BEAD_CARD_MENU_ATTR, beadCardMenuIsOpen } from "./PriorityMenu";

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
  // once is safe because `PriorityMenu` dismisses itself the moment anything could move the
  // trigger, so the position can never be observed stale.
  const [anchor, setAnchor] = useState<PriorityMenuAnchor | null>(null);
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
    setAnchor(r ? { top: r.bottom + 4, left: Math.max(8, r.left) } : null);
    setOpen(true);
  };

  // A PICK WHILE A WRITE IS IN FLIGHT MUST NOT BE POSSIBLE, and disabling the trigger is only half
  // of it: the menu can already be open when the previous pick starts writing. Closing it here is
  // what makes `disabled` true of the whole control rather than just of its button.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const urgent = isUrgentPriority(priority);
  // `tag()` from the shared treatment — the same call `ConciergeAuditPane`'s `codePill` makes. It
  // carries the mono face, the micro step, the near-square `RADIUS.sm` and the ink as BOTH text and
  // edge. Nothing here types a colour or a radius of its own; a capsule (`borderRadius: 999`) is
  // exactly what the treatment exists to refuse.
  const ink = urgent ? C.dangerInk : C.muted;
  return (
    // stopPropagation keeps the pill's clicks off whatever the card is sitting in — the board's
    // detail overlay closes on a click that reaches its scrim. `PriorityMenu` now contains its own
    // presses as well, so this covers the trigger; the two together are belt and braces.
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
        // `menu` is now HONEST: `PriorityMenu` implements arrow-key navigation and carries
        // `role="menu"`, so announcing a menu describes what the reader actually gets.
        aria-haspopup="menu"
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
      {open && (
        <PriorityMenu
          anchor={anchor}
          priority={priority}
          testId={testId}
          onClose={close}
          // No focus handoff on this path: `close()`'s `trigger.focus()` scrolls the pill into
          // view, which would fight the very scroll that caused the dismissal.
          onDismiss={() => setOpen(false)}
          onPick={(p) => {
            close();
            onChange(p);
          }}
        />
      )}
    </span>
  );
}
