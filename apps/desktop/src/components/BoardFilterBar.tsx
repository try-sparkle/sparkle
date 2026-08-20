// apps/desktop/src/components/BoardFilterBar.tsx
//
// The plan board's priority + date-range filter controls. The founder: "I want to have filters so I
// want to be able to only look at cards of a certain priority status and also a certain date range."
//
// ONE COMPONENT, TWO MOUNTS. The board's top row is owned by its HOSTS — `PlanBoardSlot` in
// Workspace.tsx and the satellite window's board header — not by BoardView, which deliberately has
// no title row of its own. Two call sites means two chances to drift, so every control lives here
// and the hosts pass only `side`.
import { useState, useRef, useEffect, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { FiChevronDown, FiFilter, FiX } from "react-icons/fi";
import { C } from "../theme/colors";
import { RADIUS, TYPE, FONT_UI, WEIGHT } from "../theme/scale";
import { CHIP } from "./labelTreatment";
import { useUiStore } from "../stores/uiStore";
import type { PairSide } from "../engine/cable";
import {
  boardFilterIsActive,
  clearBoardFilter,
  isDateSort,
  FILTERABLE_PRIORITIES,
  PRIORITY_LABEL,
  SORT_CHIP_LABEL,
  SORT_LABEL,
  SORT_OPTIONS,
  WINDOW_LABEL,
  type BoardFilter,
  type BoardSort,
  type DateField,
  type DateWindow,
} from "../services/boardFilters";

/** Layered above the board but below a modal — the same pair ModelPill uses. */
const BACKDROP_Z = 60;
const MENU_Z = 61;

const trigger = (active: boolean): CSSProperties => ({
  ...CHIP,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 7px",
  cursor: "pointer",
  fontFamily: FONT_UI,
  fontSize: TYPE.micro,
  background: active ? C.pillFill : "transparent",
  color: active ? C.cream : C.muted,
  border: `1px solid ${active ? C.pillFill : C.hairline}`,
});

/**
 * A pick-one-of-N menu on a chip trigger.
 *
 * PORTALED, like `ModelPill`'s and for its reason: left inside the board's column the menu is
 * covered by any `zIndex`/`filter` ancestor and its clicks are swallowed. Dismissal is the
 * established popover contract — Escape (yielding to whatever already consumed the key, so one
 * press peels one layer), a backdrop click, and a capture-phase scroll that kills a panel pinned to
 * a stale anchor rect.
 */
function ChipMenu<T extends string | number | null>({
  label,
  active,
  options,
  value,
  onPick,
  testId,
}: {
  label: string;
  active: boolean;
  options: { value: T; label: string }[];
  value: T;
  onPick: (v: T) => void;
  testId: string;
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
    // Capture phase: a scrolling board moves the anchor out from under a panel that was positioned
    // once, at open time. Closing beats chasing it.
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
        onClick={() => {
          setRect(anchor.current?.getBoundingClientRect() ?? null);
          setOpen((v) => !v);
        }}
        style={trigger(active)}
      >
        {label}
        <FiChevronDown size={10} aria-hidden />
      </button>
      {open &&
        rect &&
        createPortal(
          <>
            <div
              // `data-circuit` or dismissing this backdrop also drops the cable — the same
              // requirement every portaled overlay in this app carries.
              data-circuit
              onClick={() => setOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
            />
            <div
              data-testid={`${testId}-menu`}
              // ══ BOTH MARKERS, ON THE PANEL — NOT JUST ON THE BACKDROP ═══════════════════════
              // `data-circuit`: the cable's "did this press leave the circuit" test is DOM
              // ANCESTRY, and a portaled panel is a sibling of the whole app — so without this a
              // click on a filter option reads as a press outside the circuit and unbinds the
              // concierge alongside the filter it was meant to set. `PriorityPill` marks both its
              // backdrop AND its panel for exactly this reason; only the backdrop was marked here.
              //
              // `data-dismissible-open`: while this panel is up it OWNS Escape, so
              // `dismissibleSurfaceOpen` must see it or `unbindsOnKey` returns true and one press
              // both closes the menu and drops the cable. Not `role="menu"` — that would promise
              // arrow-key navigation this plain-buttons popover does not implement (PriorityPill
              // records the same decision).
              data-circuit
              data-dismissible-open="true"
              style={{
                position: "fixed",
                // Right-aligned to the trigger: this bar sits at the board's top RIGHT, so a
                // left-aligned panel would hang off the window edge.
                top: rect.bottom + 4,
                right: Math.max(8, window.innerWidth - rect.right),
                zIndex: MENU_Z,
                minWidth: 180,
                background: C.deepForest,
                border: `1px solid ${C.hairline}`,
                borderRadius: RADIUS.input,
                padding: 4,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {options.map((o) => (
                <button
                  key={String(o.value)}
                  type="button"
                  onClick={() => {
                    onPick(o.value);
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
                    background: o.value === value ? C.pillFill : "transparent",
                    color: o.value === value ? C.cream : C.muted,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

// FILTERABLE_PRIORITIES, not a literal [0,1,2,3] — bd's domain is 0-4 and the filter has to be able
// to isolate a P4 (the retro pain-point path files at P4 by default). The editable pill's menu is
// deliberately shorter; see PRIORITY_LABEL's note.
const PRIORITY_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Any priority" },
  ...FILTERABLE_PRIORITIES.map((p) => ({
    value: p as number | null,
    label: PRIORITY_LABEL[p] ?? `P${p}`,
  })),
];

const WINDOW_OPTIONS: { value: DateWindow; label: string }[] = (
  ["all", "24h", "7d", "30d"] as DateWindow[]
).map((w) => ({ value: w, label: WINDOW_LABEL[w] }));

const FIELD_OPTIONS: { value: DateField; label: string }[] = [
  { value: "updated", label: "By last updated" },
  { value: "created", label: "By created" },
];

/** The sort menu, DERIVED from `SORT_OPTIONS` + `SORT_LABEL` rather than restated here — the
 *  founder gave exact wording for all four rows, and a second hand-maintained copy of it is how a
 *  menu ends up naming an order the comparator does not implement. */
const SORT_MENU_OPTIONS: { value: BoardSort; label: string }[] = SORT_OPTIONS.map((value) => ({
  value,
  label: SORT_LABEL[value],
}));

export function BoardFilterBar({ side }: { side: PairSide }) {
  const filter = useUiStore((s) => s.boardFilterBySide[side]);
  const setBoardFilter = useUiStore((s) => s.setBoardFilter);
  const set = (patch: Partial<BoardFilter>) => setBoardFilter(side, { ...filter, ...patch });
  const active = boardFilterIsActive(filter);

  return (
    <span
      data-testid="board-filter-bar"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}
    >
      {/* A MARK, NOT A CONTROL. The founder asked for "a little filter icon next to priority and
          date" — it names what the group is, which matters more now that the row's first item is a
          "Close Planning Board" link rather than a mode toggle. Deliberately inert: `aria-hidden`
          and `pointerEvents: none`, so it adds nothing to the tab order and cannot swallow a press
          aimed at the chip beside it. A react-icon rather than a character, per `glyphIcons.test`. */}
      <FiFilter
        data-testid="board-filter-mark"
        aria-hidden
        size={12}
        style={{ color: C.muted, flex: "0 0 auto", pointerEvents: "none" }}
      />
      <ChipMenu
        testId="board-filter-priority"
        label={filter.priority === null ? "Priority" : `P${filter.priority}`}
        active={filter.priority !== null}
        options={PRIORITY_OPTIONS}
        value={filter.priority}
        onPick={(priority) => set({ priority })}
      />
      <ChipMenu
        testId="board-filter-window"
        label={filter.dateWindow === "all" ? "Date" : WINDOW_LABEL[filter.dateWindow]}
        active={filter.dateWindow !== "all"}
        options={WINDOW_OPTIONS}
        value={filter.dateWindow}
        onPick={(dateWindow) => set({ dateWindow })}
      />
      {/* The created/updated switch is only meaningful once a window is chosen — with "Any date" it
          selects which date a filter that is not running would measure. Hiding it then keeps the bar
          from offering a control that cannot do anything.

          ── A DATE SORT MAKES IT MEANINGFUL WITH NO WINDOW AT ALL ────────────────────────────────
          The founder's call is that "Date: Newest First" orders by whichever of created/updated
          this chip selects, so the board holds ONE date concept rather than two that can disagree.
          That makes this control load-bearing the moment a date sort is picked — and gating it on
          the WINDOW alone would leave the sort reading a field the user can neither see nor change.
          Either reason shows it; neither alone is sufficient. */}
      {(filter.dateWindow !== "all" || isDateSort(filter.sortBy)) && (
        <ChipMenu
          testId="board-filter-field"
          label={filter.dateField === "created" ? "Created" : "Updated"}
          active
          options={FIELD_OPTIONS}
          value={filter.dateField}
          onPick={(dateField) => set({ dateField })}
        />
      )}
      {/* SORT SITS RIGHTMOST, after both date controls — it is the founder's placement ("to the
          right of the existing Priority and Date dropdowns") and it reads correctly: the chips to
          its left decide WHICH cards, this one decides in what ORDER.

          ALWAYS ACTIVE-STYLED, unlike every chip beside it. The others have an off position and
          render muted in it; a sort does not — the board is always in one of the four orders, so a
          muted "Sort: Priority" would suggest an order that is not currently applied. */}
      <ChipMenu
        testId="board-filter-sort"
        label={SORT_CHIP_LABEL[filter.sortBy]}
        active
        options={SORT_MENU_OPTIONS}
        value={filter.sortBy}
        onPick={(sortBy) => set({ sortBy })}
      />
      {active && (
        <button
          type="button"
          data-testid="board-filter-clear"
          title="Clear filters"
          // CLEARS THE FILTERS, KEEPS THE ORDER. The button says "Clear filters" and a sort is not
          // a filter — see `clearBoardFilter` for why `dateField` survives it too.
          onClick={() => setBoardFilter(side, clearBoardFilter(filter))}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            background: "transparent",
            border: "none",
            padding: "2px 4px",
            cursor: "pointer",
            color: C.accentInk,
            fontFamily: FONT_UI,
            fontSize: TYPE.micro,
            fontWeight: WEIGHT.med,
          }}
        >
          <FiX size={10} aria-hidden />
          Clear
        </button>
      )}
    </span>
  );
}
