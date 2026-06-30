// The `@`-triggered mention picker for the Think composer. Typing `@` opens this searchable
// dropdown over `@chief` + the static expert roster (services/expertRoster.ts). Choosing an entry
// routes the next message to that target. Presentational + controlled: the composer owns the query
// (parsed from the text after `@`) and the open/closed state; this component renders the filtered
// list, handles its own keyboard navigation, and calls back on pick/close.
//
// This replaces ExpertVoicesRail's clipping rail — the list is scrollable with a bounded max-height,
// so the full roster is always reachable (fixes "only scrolled to letter C").
import { useEffect, useMemo, useRef, useState } from "react";
import { FiUsers, FiStar } from "react-icons/fi";
import { C, ROW_ACTIVE_BUBBLE } from "../theme/colors";
import { searchVoices } from "../services/expertRoster";

export type MentionKind = "chief" | "voice";

export interface MentionPick {
  /** "chief" for the Chief entry, or the expert voice's kebab-case handle. */
  handle: string;
  kind: MentionKind;
}

export interface MentionPickerProps {
  /** The text typed after `@` (without the `@`). Filters the roster; "" shows everything. */
  query: string;
  /** Called when the user picks a row (click or Enter). */
  onPick: (item: MentionPick) => void;
  /** Called on Escape (or when the picker should otherwise close). */
  onClose: () => void;
  /**
   * Whether the picker should grab focus on open so its own Arrow/Enter/Escape handler works
   * standalone. Defaults to false: the conventional contract is that the composer keeps focus
   * (so type-to-filter keeps updating `query`) and FORWARDS Arrow/Enter/Escape to this element's
   * onKeyDown. Set true only when the composer is NOT forwarding keys — focusing here would
   * otherwise steal focus from the composer and break type-to-filter.
   */
  autoFocus?: boolean;
  /**
   * Optional CONTROLLED highlight. When provided, the composer owns the active row (it keeps focus
   * for type-to-filter and forwards Arrow/Enter/Escape), and this component renders that row as
   * highlighted instead of tracking its own. Mouse hover reports back via {@link onActiveIndexChange}.
   * When omitted, the picker is uncontrolled and manages its own highlight + keyboard nav.
   */
  activeIndex?: number;
  /** Report a hover-driven highlight change up to the controlling composer. */
  onActiveIndexChange?: (index: number) => void;
}

// The fixed Chief entry that always leads the list. It isn't part of the roster — Chief answers
// directly, grounded in the project library, rather than through a persona lens.
const CHIEF_HANDLE = "chief";
const CHIEF_DESCRIPTOR = "Ask Chief directly — grounded in your project library";

/**
 * Pure index math for keyboard navigation: move `current` by `delta` within `[0, count)`, wrapping
 * around both ends. Returns 0 for an empty list. Exported so the wrap-around behavior is unit-tested
 * independently of the component.
 */
export function nextIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

export function MentionPicker({
  query,
  onPick,
  onClose,
  autoFocus = false,
  activeIndex,
  onActiveIndexChange,
}: MentionPickerProps) {
  // The full ordered list: @chief first, then the filtered roster. Recomputed as the query changes.
  // `voiceCount` is tracked separately so the empty-state can react to "no voices matched" — `rows`
  // always contains @chief, so `rows.length` is never 0.
  const { rows, voiceCount } = useMemo(() => {
    const voices = searchVoices(query).map(
      (v): { kind: MentionKind; handle: string; label: string; descriptor: string } => ({
        kind: "voice",
        handle: v.handle,
        label: v.label,
        descriptor: v.oneLiner,
      }),
    );
    return {
      rows: [
        { kind: "chief" as MentionKind, handle: CHIEF_HANDLE, label: "Chief", descriptor: CHIEF_DESCRIPTOR },
        ...voices,
      ],
      voiceCount: voices.length,
    };
  }, [query]);

  const [activeUncontrolled, setActiveUncontrolled] = useState(0);
  // CONTROLLED when the composer passes activeIndex; otherwise the picker owns its own highlight.
  const controlled = activeIndex != null;
  const active = controlled ? activeIndex : activeUncontrolled;
  const setActive = (updater: number | ((i: number) => number)) => {
    if (controlled) {
      const next = typeof updater === "function" ? updater(active) : updater;
      onActiveIndexChange?.(next);
    } else {
      setActiveUncontrolled(updater);
    }
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset the highlight to the top whenever the result set changes (new query, fewer rows), so the
  // active index never points past the end of the list. Only when uncontrolled — a controlling
  // composer resets its own index as it re-parses the query.
  useEffect(() => {
    if (!controlled) setActiveUncontrolled(0);
  }, [query, controlled]);

  // OPT-IN focus on open (autoFocus). The default contract is that the composer keeps focus — so
  // type-to-filter keeps updating `query` — and forwards Arrow/Enter/Escape to this element's
  // onKeyDown. Only when the composer is NOT forwarding keys should the caller pass autoFocus, so
  // this listbox can own keyboard nav. Stealing focus unconditionally would break live filtering.
  useEffect(() => {
    if (autoFocus) rootRef.current?.focus?.();
  }, [autoFocus]);

  // Keep the highlighted row scrolled into view as the user arrows through a long roster.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    // scrollIntoView is unimplemented in jsdom (test env); guard so it's a no-op there.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => nextIndex(i, 1, rows.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => nextIndex(i, -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) onPick({ handle: row.handle, kind: row.kind });
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      ref={rootRef}
      data-testid="mention-picker"
      role="listbox"
      aria-label="Mention a voice"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        background: C.forest,
        border: `1px solid ${C.deepForest}`,
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        overflow: "hidden",
        width: 320,
        outline: "none",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${C.deepForest}`,
          color: C.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <FiUsers aria-hidden size={13} /> Mention a voice
      </div>

      {/* Scrollable, height-bounded list so a long roster never clips. */}
      <div
        ref={listRef}
        data-testid="mention-picker-list"
        style={{ maxHeight: 320, overflowY: "auto" }}
      >
        {rows.map((row, i) => {
          const isChief = row.kind === "chief";
          const isActive = i === active;
          return (
            <button
              key={`${row.kind}:${row.handle}`}
              type="button"
              role="option"
              aria-selected={isActive}
              data-row={i}
              // Track the hovered row so mouse and keyboard share one highlight.
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick({ handle: row.handle, kind: row.kind })}
              style={{
                width: "100%",
                textAlign: "left",
                background: isActive ? ROW_ACTIVE_BUBBLE : "transparent",
                border: "none",
                borderBottom: `1px solid ${C.deepForest}`,
                padding: "8px 12px",
                cursor: "pointer",
                color: C.cream,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {isChief ? (
                <FiStar aria-hidden size={14} style={{ color: C.accentInk, flexShrink: 0 }} />
              ) : (
                <FiUsers aria-hidden size={14} style={{ color: C.muted, flexShrink: 0 }} />
              )}
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.accentInk }}>
                  @{row.handle}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: C.muted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.descriptor}
                </span>
              </span>
            </button>
          );
        })}

        {/* @chief always renders above; this signals when the query matched zero expert voices. */}
        {voiceCount === 0 && (
          <div style={{ padding: "10px 12px", color: C.muted, fontSize: 12 }}>
            No matching voices
          </div>
        )}
      </div>
    </div>
  );
}
