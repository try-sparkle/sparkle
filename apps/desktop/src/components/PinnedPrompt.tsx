import { useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../clipboard";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, DANGER } from "../theme/colors";
import type { PromptHistoryEntry } from "../types";
import { formatAgo, oneLine } from "./promptHistory";

/** Outcome of a jump attempt: the terminal scrolled, or the prompt's marker is gone (a prior
 *  session, or trimmed out of scrollback) so there's nothing to scroll to. */
export type JumpResult = "scrolled" | "missing";

/**
 * Always-visible header showing the agent's most recent prompt (spec §7) — so you never have
 * to scroll up through terminal output to find what you last asked.
 *
 * With history, the header becomes a button that pulls down a dropdown of every prompt sent to
 * this agent (newest first). Each row is a select → act → expand control:
 *   - first click selects the row, revealing [Copy] and (when a composer is wired)
 *     [Send to Composer] on the right;
 *   - clicking the selected row again expands it to the full, selectable prompt text so you can
 *     drag-copy just part of it; clicking again collapses it.
 * Copy puts the whole prompt on the clipboard; Send to Composer hands it to the parent. Both
 * close the menu. Up/Down/Home/End move the selection, Enter/Space expand, Esc closes. There is
 * deliberately no hover tooltip — reading the full prompt is the expand interaction.
 */
export function PinnedPrompt({
  prompt,
  history = [],
  onSendToComposer,
  onJumpToPrompt,
}: {
  prompt: string;
  history?: PromptHistoryEntry[];
  onSendToComposer?: (text: string) => void;
  /** Scroll the terminal to where a prompt was sent. Returns whether it could (see JumpResult).
   *  When omitted, the Jump action isn't offered. */
  onJumpToPrompt?: (id: string) => JumpResult;
}) {
  const [open, setOpen] = useState(false);
  // The row whose last Jump attempt found no marker — shows an inline "scrolled out" note.
  const [scrolledOutId, setScrolledOutId] = useState<string | null>(null);
  // The selected (clicked / keyboard-active) row, and whether it's expanded to its full text.
  // -1 means nothing is selected yet. Only the selected row shows actions, and only it can expand.
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The dropdown is worth showing whenever there's any history to act on.
  const interactive = history.length > 0;
  // The store keeps history oldest-first; the dropdown shows newest-first.
  const items = useMemo(() => history.slice().reverse(), [history]);

  // Return focus to the trigger header (e.g. on keyboard dismiss / after an action) so a keyboard
  // user keeps their place instead of dropping to document.body when the list unmounts.
  const refocusHeader = () => requestAnimationFrame(() => headerRef.current?.focus());

  const close = () => {
    setOpen(false);
    refocusHeader();
  };

  // Close on outside click, or on Esc anywhere while open. The Esc listener is document-level
  // (not just on the list) so it still closes the menu if focus has Tabbed out of the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Mouse dismiss: don't steal focus back to the header — the user clicked elsewhere.
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        refocusHeader();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // If history empties out (shouldn't normally happen) while open, fold the menu away.
  useEffect(() => {
    if (!interactive && open) setOpen(false);
  }, [interactive, open]);

  // On open, clear any prior selection and move keyboard focus into the list so arrow keys work
  // immediately. Nothing is pre-selected — the user picks a row by click or arrow.
  useEffect(() => {
    if (!open) return;
    setSelectedIndex(-1);
    setExpanded(false);
    setScrolledOutId(null);
    const raf = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Click a row: a fresh row selects it (collapsed); clicking the already-selected row toggles its
  // expanded full-text view. (The "don't collapse mid-text-selection" guard lives in HistoryRow,
  // scoped to that row's own element.)
  const onRowClick = (i: number) => {
    if (i === selectedIndex) {
      setExpanded((e) => !e);
    } else {
      setSelectedIndex(i);
      setExpanded(false);
    }
  };

  const moveSelection = (next: number) => {
    setSelectedIndex(next);
    setExpanded(false);
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveSelection(selectedIndex < 0 ? 0 : Math.min(items.length - 1, selectedIndex + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        moveSelection(selectedIndex < 0 ? 0 : Math.max(0, selectedIndex - 1));
        break;
      case "Home":
        e.preventDefault();
        moveSelection(0);
        break;
      case "End":
        e.preventDefault();
        moveSelection(items.length - 1);
        break;
      case "Enter":
      case " ":
        if (selectedIndex >= 0) {
          e.preventDefault();
          setExpanded((v) => !v);
        }
        break;
      // Escape is handled by the document-level listener so it works even after a Tab-out.
    }
  };

  const doCopy = (entry: PromptHistoryEntry) => {
    void copyToClipboard(entry.text);
    close();
  };
  const doSend = (entry: PromptHistoryEntry) => {
    onSendToComposer?.(entry.text);
    close();
  };
  const doJump = (entry: PromptHistoryEntry) => {
    const result = onJumpToPrompt?.(entry.id);
    if (result === "missing") {
      // Nothing to scroll to — flag this row and leave the menu open so the note is visible.
      setScrolledOutId(entry.id);
      return;
    }
    close();
  };

  // The selected row's id, exposed to AT via the listbox's aria-activedescendant so a screen
  // reader announces selection as arrow keys move it (focus stays on the <ul>; rows aren't tab stops).
  const activeId = selectedIndex >= 0 ? items[selectedIndex]?.id : undefined;

  return (
    // position/zIndex so the dropdown overlays the terminal (a later sibling) below the header.
    <div ref={rootRef} style={{ position: "relative", zIndex: 20, flex: "0 0 auto" }}>
      <div
        ref={headerRef}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-haspopup={interactive ? "listbox" : undefined}
        aria-expanded={interactive ? open : undefined}
        aria-label={interactive ? "Show prompt history" : undefined}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                  e.preventDefault();
                  setOpen(true);
                }
              }
            : undefined
        }
        style={{
          padding: "8px 14px",
          background: C.deepForest,
          borderBottom: `1px solid ${C.forest}`,
          display: "flex",
          gap: 8,
          alignItems: "center",
          minHeight: 20,
          cursor: interactive ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <span style={{ color: C.accentInk, flex: "0 0 auto" }}>↩</span>
        <span
          style={{
            color: prompt ? C.cream : C.muted,
            fontWeight: prompt ? FONT_WEIGHT.medium : FONT_WEIGHT.regular,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {prompt || "No prompt yet — type below to start your agent"}
        </span>
        {interactive && (
          // Caret rotates to point up while the menu is open.
          <span
            aria-hidden="true"
            style={{
              color: C.muted,
              flex: "0 0 auto",
              fontSize: 10,
              transition: "transform 120ms ease",
              transform: open ? "rotate(180deg)" : "none",
            }}
          >
            ▾
          </span>
        )}
      </div>

      {interactive && open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Prompt history"
          aria-activedescendant={activeId ? `ph-opt-${activeId}` : undefined}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: C.deepForest,
            border: `1px solid ${CHAT_USER_BUBBLE}`,
            borderTop: "none",
            borderRadius: "0 0 8px 8px",
            maxHeight: 320,
            overflowY: "auto",
            boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
            outline: "none",
          }}
        >
          {items.map((entry, i) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              selected={i === selectedIndex}
              expanded={i === selectedIndex && expanded}
              showSend={!!onSendToComposer}
              showJump={!!onJumpToPrompt}
              scrolledOut={scrolledOutId === entry.id}
              onClick={() => onRowClick(i)}
              onCopy={() => doCopy(entry)}
              onSend={() => doSend(entry)}
              onJump={() => doJump(entry)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  selected,
  expanded,
  showSend,
  showJump,
  scrolledOut,
  onClick,
  onCopy,
  onSend,
  onJump,
}: {
  entry: PromptHistoryEntry;
  selected: boolean;
  expanded: boolean;
  showSend: boolean;
  showJump: boolean;
  scrolledOut: boolean;
  onClick: () => void;
  onCopy: () => void;
  onSend: () => void;
  onJump: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const collapsed = oneLine(entry.text) || "(empty prompt)";

  // Keep the selected row in view as Up/Down move past the visible window.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // A click is a select/expand/collapse — UNLESS it's the tail of a drag that selected text
  // *inside this row* (the user highlighting part of an expanded prompt to copy). Scope the guard
  // to this row's element (either selection endpoint, since a drag's anchor and focus can land on
  // different nodes) so a stray selection elsewhere in the UI never swallows a row click.
  const handleClick = () => {
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    const inRow =
      !!sel?.toString() &&
      ((!!sel.anchorNode && !!ref.current?.contains(sel.anchorNode)) ||
        (!!sel.focusNode && !!ref.current?.contains(sel.focusNode)));
    if (inRow) return;
    onClick();
  };

  return (
    // A listbox option (not role="button") so the revealed Copy / Send <button>s aren't nested in
    // another interactive control. Rows aren't tab stops: the parent <ul role="listbox"> owns focus
    // and points aria-activedescendant at the selected row, so AT announces selection as arrows move
    // it; Tab reaches the action buttons. Mouse users click the row to select/expand.
    <li
      ref={ref}
      id={`ph-opt-${entry.id}`}
      role="option"
      aria-selected={selected}
      data-testid={`ph-row-${entry.id}`}
      data-expanded={selected ? expanded : undefined}
      onClick={handleClick}
      style={{
        display: "flex",
        gap: 10,
        alignItems: expanded ? "flex-start" : "baseline",
        background: selected ? CHAT_USER_BUBBLE : "transparent",
        color: C.cream,
        borderRadius: 6,
        padding: "7px 9px",
        cursor: "pointer",
      }}
    >
      {expanded ? (
        // Full, selectable prompt: wrap and preserve newlines so the user can drag-select any part.
        // cursor:text (not pointer) signals it's now a text region, not a click target.
        <div
          data-testid={`ph-full-${entry.id}`}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
            userSelect: "text",
            cursor: "text",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {entry.text || "(empty prompt)"}
        </div>
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {collapsed}
        </span>
      )}

      {selected ? (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "flex-end",
            alignSelf: expanded ? "flex-start" : "center",
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            {showJump && <RowButton label="Jump" onClick={onJump} />}
            <RowButton label="Copy" onClick={onCopy} />
            {showSend && <RowButton label="Send to Composer" onClick={onSend} />}
          </div>
          {scrolledOut && (
            <span role="alert" style={{ fontSize: 10, color: DANGER, whiteSpace: "nowrap" }}>
              Scrolled out — not from this session
            </span>
          )}
        </div>
      ) : (
        <span style={{ flex: "0 0 auto", fontSize: 11, color: C.muted }}>
          {formatAgo(Date.now(), entry.at)}
        </span>
      )}
    </li>
  );
}

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      // Stop the click from bubbling to the row (which would toggle expand/collapse instead).
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        background: C.deepForest,
        color: C.cream,
        border: `1px solid ${C.forest}`,
        borderRadius: 6,
        padding: "3px 10px",
        fontSize: 12,
        fontFamily: '"IBM Plex Sans", sans-serif',
        fontWeight: FONT_WEIGHT.medium,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
