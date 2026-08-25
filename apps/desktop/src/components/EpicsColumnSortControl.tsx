// THE EPICS COLUMN'S SORT-BY CHIP — the founder's item 4 on `sparkle-huw924`: *"a sort-by control
// belongs to the right of the filter. He looked and it is not there."*
//
// ══ IT OWNS NO ORDER OF ITS OWN, AND THAT IS THE POINT ════════════════════════════════════════
// The comparator is `services/boardSort`'s (`sortEpicBoard`), the option identifiers are
// `services/boardFilters`' `SORT_OPTIONS`, and the words are its `SORT_LABEL` / `SORT_CHIP_LABEL`.
// This file contributes a TRIGGER and a MENU and nothing else. Bead `sparkle-hhb5re` owns the plan
// board's sort; a second comparator here — or a second hand-typed option list — is exactly how the
// board and this column would come to disagree about what "Newest" means, which is the failure the
// `boardFilters` header calls out for the labels and the `boardSort` header calls out for the order.
//
// ══ WHY NOT `BoardFilterBar`'s `ChipMenu` ═════════════════════════════════════════════════════
// That popover is module-private to `BoardFilterBar.tsx` and that file is owned by another change
// in flight, so exporting it was not available. The DUPLICATION HERE IS THE SHELL (a trigger, a
// portaled panel, the dismissal contract), never the data — hoisting the two shells into one shared
// `ChipMenu` is a worthwhile follow-up and is the only thing that should be merged, not the lists.
//
// ══ THE DISMISSAL CONTRACT IS THE APP'S, NOT A NEW ONE ════════════════════════════════════════
// Escape (yielding to whatever already consumed the key), a backdrop click, and a capture-phase
// scroll that kills a panel pinned to a stale anchor rect. Both the backdrop AND the panel carry
// `data-circuit`, because the cable's "did this press leave the circuit" test is DOM ANCESTRY and a
// portaled panel is a sibling of the whole app — without it, picking a sort order would unbind the
// concierge. The panel also carries `data-dismissible-open` so it OWNS Escape while it is up and one
// press peels one layer. `PriorityPill` and `BoardFilterBar` both record these two reasons already.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { CHIP } from "./labelTreatment";
import {
  SORT_CHIP_LABEL,
  SORT_LABEL,
  SORT_OPTIONS,
  type BoardSort,
} from "../services/boardFilters";

/** The same pair `BoardFilterBar` and `ModelPill` use — above the board, below a modal. */
const BACKDROP_Z = 60;
const MENU_Z = 61;

/**
 * The orders this column offers — `SORT_OPTIONS` MINUS `type`, derived from the one list rather
 * than written out again.
 *
 * ══ WHY `type` IS DROPPED HERE AND ONLY HERE ══════════════════════════════════════════════════
 * `byType` orders "all epics, then all tasks". Every row in this column IS an epic (`bucketEpics`
 * admits nothing else), so `a.epic - b.epic` is `0` for every pair and the comparator collapses
 * into `byPriority` exactly. Offering it would be a menu row that provably cannot change what the
 * user is looking at — the same "a control that visibly does nothing" objection `EpicsColumn` makes
 * about an ungated Open Planning Board link.
 *
 * THIS IS A FILTER OVER THE SHARED LIST, NOT A SECOND LIST: add a fifth order to `SORT_OPTIONS` and
 * it appears here too, with no edit to this file.
 */
export const EPICS_SORT_OPTIONS: readonly BoardSort[] = SORT_OPTIONS.filter((s) => s !== "type");

/**
 * The collapsed chip's word — `SORT_CHIP_LABEL` with its `"Sort: "` prefix removed.
 *
 * The board's bar sits in a full-width header where "Sort: Priority" fits beside three other chips.
 * This column is ~280px and already carries a title and the Open Planning Board link, so the prefix
 * is the part that has to go. It is STRIPPED FROM THE SHARED LABEL rather than re-typed, so the two
 * surfaces cannot name an order differently; the trigger's `aria-label` restores the full form, so
 * a screen reader still hears which control this is.
 */
const CHIP_PREFIX = "Sort: ";
function shortLabel(sort: BoardSort): string {
  const full = SORT_CHIP_LABEL[sort];
  return full.startsWith(CHIP_PREFIX) ? full.slice(CHIP_PREFIX.length) : full;
}

/** ALWAYS ACTIVE-STYLED, for `BoardFilterBar`'s reason: a sort has no off position — the column is
 *  always in one of these orders — so a muted chip would suggest an order that is not applied. */
const TRIGGER: CSSProperties = {
  ...CHIP,
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  padding: "1px 5px",
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.micro,
  background: C.pillFill,
  color: C.cream,
  border: `1px solid ${C.pillFill}`,
  flex: "0 0 auto",
  whiteSpace: "nowrap",
};

export function EpicsColumnSortControl({
  value,
  onPick,
  testId = "epics-sort",
}: {
  value: BoardSort;
  onPick: (next: BoardSort) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      anchor.current?.focus();
    };
    // Capture phase: this column SCROLLS, so the anchor moves out from under a panel positioned
    // once at open time. Closing beats chasing it.
    const onScroll = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-label={SORT_CHIP_LABEL[value]}
        onClick={() => {
          setRect(anchor.current?.getBoundingClientRect() ?? null);
          setOpen((v) => !v);
        }}
        style={TRIGGER}
      >
        {shortLabel(value)}
        {/* REACT-ICONS, NEVER A CHARACTER GLYPH — `glyphIcons.test.ts` is a falling ratchet on it,
            and a typographic chevron renders at whatever the platform font decides, so it would not
            line up with the board's own chips. */}
        <FiChevronDown size={10} aria-hidden />
      </button>
      {open &&
        rect &&
        createPortal(
          <>
            <div
              data-circuit
              onClick={() => setOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
            />
            <div
              data-testid={`${testId}-menu`}
              data-circuit
              data-dismissible-open="true"
              style={{
                position: "fixed",
                top: rect.bottom + 4,
                // LEFT-ALIGNED to the trigger, unlike the board bar's right-aligned panel: this
                // column can be the LEFT pair's, where a right-aligned 220px panel would hang over
                // the build column beside it rather than over the rows it orders.
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 236)),
                zIndex: MENU_Z,
                minWidth: 220,
                background: C.deepForest,
                border: `1px solid ${C.hairline}`,
                borderRadius: RADIUS.input,
                padding: 4,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {EPICS_SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`${testId}-option-${option}`}
                  onClick={() => {
                    onPick(option);
                    setOpen(false);
                  }}
                  style={{
                    textAlign: "left",
                    border: "none",
                    borderRadius: RADIUS.sm,
                    padding: "5px 8px",
                    cursor: "pointer",
                    fontFamily: FONT_UI,
                    fontSize: TYPE.small,
                    background: option === value ? C.pillFill : "transparent",
                    color: option === value ? C.cream : C.muted,
                  }}
                >
                  {/* The founder's exact wording for each order, from the ONE place it is written. */}
                  {SORT_LABEL[option]}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
