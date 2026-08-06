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
import { FiChevronDown, FiX } from "react-icons/fi";
import { C } from "../theme/colors";
import { RADIUS, TYPE, FONT_UI, WEIGHT } from "../theme/scale";
import { CHIP } from "./labelTreatment";
import { useUiStore } from "../stores/uiStore";
import type { PairSide } from "../engine/cable";
import {
  NO_BOARD_FILTER,
  boardFilterIsActive,
  FILTERABLE_PRIORITIES,
  PRIORITY_LABEL,
  WINDOW_LABEL,
  type BoardFilter,
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
          from offering a control that cannot do anything. */}
      {filter.dateWindow !== "all" && (
        <ChipMenu
          testId="board-filter-field"
          label={filter.dateField === "created" ? "Created" : "Updated"}
          active
          options={FIELD_OPTIONS}
          value={filter.dateField}
          onPick={(dateField) => set({ dateField })}
        />
      )}
      {active && (
        <button
          type="button"
          data-testid="board-filter-clear"
          title="Clear filters"
          onClick={() => setBoardFilter(side, NO_BOARD_FILTER)}
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
