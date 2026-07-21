import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../clipboard";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, DANGER } from "../theme/colors";
import type { PromptHistoryEntry } from "../types";
import { formatAgo, oneLine } from "./promptHistory";

/** Outcome of a jump attempt: the terminal scrolled, or the prompt's marker is gone (a prior
 *  session, or trimmed out of scrollback) so there's nothing to scroll to. */
export type JumpResult = "scrolled" | "missing";

/**
 * Header showing the agent's recent prompts as a breadcrumb (spec §7) — so you never have to
 * scroll up through terminal output to find what you last asked. It shows the last up to FOUR
 * prompts, oldest→newest with the most recent on the right (`p1 › p2 › p3 › p4`); each segment
 * shares the row width equally and truncates with "…" so four always fit on one line. Until the
 * agent has its first prompt the header renders nothing at all (no placeholder).
 *
 * Clicking a breadcrumb segment opens the history dropdown with that prompt already selected and
 * expanded (full text + Copy/Jump/Send actions right there). With history, the header also pulls
 * down that dropdown of every prompt sent to this agent (newest first) on hover — moving the
 * pointer over the bar opens it; leaving it closes it (clicking and keyboard still work too).
 * Each row reveals its actions on hover:
 *   - hovering a row shows [Copy], [Jump], and (when a composer is wired) [Send to Composer] on
 *     the right, without needing a click;
 *   - clicking a row selects it; clicking the selected row expands it to the full, selectable
 *     prompt text so you can drag-copy just part of it; clicking again collapses it.
 * Copy puts the whole prompt on the clipboard; Send to Composer hands it to the parent. Both
 * close the menu. Up/Down/Home/End move the selection, Enter/Space expand, Esc closes.
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
  // The caret button; also the focus-return target on keyboard dismiss (see refocusTrigger).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // When a breadcrumb segment is clicked while the dropdown is closed, this remembers which entry
  // the on-open effect should select+expand (that effect otherwise opens with nothing selected).
  const pendingSelectId = useRef<string | null>(null);
  // The dropdown is worth showing whenever there's any history to act on.
  const interactive = history.length > 0;
  // The store keeps history oldest-first; the dropdown shows newest-first.
  const items = useMemo(() => history.slice().reverse(), [history]);
  // The bar shows up to the last 4 prompts as a breadcrumb, oldest→newest (newest on the right).
  // history's last entry is the current prompt (=== lastPrompt), so this ends with it. These four
  // map to the top four rows of the newest-first dropdown, so a crumb click never has to scroll.
  const recent = useMemo(() => history.slice(-4), [history]);

  // Return focus to the caret trigger button (e.g. on keyboard dismiss / after an action) so a
  // keyboard user keeps their place instead of dropping to document.body when the list unmounts.
  const refocusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());

  const close = () => {
    setOpen(false);
    refocusTrigger();
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
        refocusTrigger();
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

  // On open, move keyboard focus into the list so arrow keys work immediately. A breadcrumb click
  // may have asked for a specific row to open selected+expanded (pendingSelectId); honor it,
  // otherwise open with a clean slate (nothing pre-selected — user picks by click or arrow).
  useEffect(() => {
    if (!open) return;
    const wantId = pendingSelectId.current;
    pendingSelectId.current = null;
    const wantIdx = wantId ? items.findIndex((it) => it.id === wantId) : -1;
    setSelectedIndex(wantIdx);
    setExpanded(wantIdx >= 0);
    setScrolledOutId(null);
    const raf = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(raf);
    // Runs only on the open transition; `items` is read fresh at that moment, and we deliberately
    // don't re-fire when history changes mid-open. (The exhaustive-deps suppression this rationale
    // was attached to is gone — the rule no longer fires here — but the intent still holds.)
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

  // Click a breadcrumb segment → open the history dropdown with that prompt selected + expanded, so
  // its full text and row actions (Copy / Jump / Send) are immediately there. If the dropdown is
  // already open (via hover), select it directly; otherwise stash the id for the on-open effect.
  const onCrumbClick = (entry: PromptHistoryEntry) => {
    const idx = items.findIndex((it) => it.id === entry.id);
    if (idx < 0) return;
    if (open) {
      setSelectedIndex(idx);
      setExpanded(true);
      setScrolledOutId(null);
    } else {
      pendingSelectId.current = entry.id;
      setOpen(true);
    }
  };

  // The selected row's id, exposed to AT via the listbox's aria-activedescendant so a screen
  // reader announces selection as arrow keys move it (focus stays on the <ul>; rows aren't tab stops).
  const activeId = selectedIndex >= 0 ? items[selectedIndex]?.id : undefined;

  // Nothing to show until there's a current prompt — render nothing (no placeholder header) so the
  // bar simply doesn't exist yet. Gating on `prompt` alone (not also `!interactive`) avoids a blank
  // bar in the degenerate case where history exists but the current prompt is empty.
  if (!prompt) return null;

  return (
    // position/zIndex so the dropdown overlays the terminal (a later sibling) below the header.
    // Hover anywhere over the header+dropdown opens it; leaving the whole control closes it. The
    // handlers live on the root (not the header) so sliding the pointer from header into the list
    // doesn't cross a gap that would close the menu.
    <div
      ref={rootRef}
      data-testid="pinned-prompt-root"
      onMouseEnter={interactive ? () => setOpen(true) : undefined}
      onMouseLeave={interactive ? () => setOpen(false) : undefined}
      style={{ position: "relative", zIndex: 20, flex: "0 0 auto" }}
    >
      {/* A plain container (not itself a button) so the interactive controls it holds — the crumb
          buttons and the caret button — aren't nested inside another interactive control. Opening
          on hover is handled by the root above; keyboard users reach the caret + crumb buttons. */}
      <div
        style={{
          padding: "8px 14px",
          // The last-prompt bar sits directly under the top bar and reads as part of the same
          // chrome, so it uses the lighter barSurface (not the darker sidebar deepForest). The
          // history dropdown it opens (below) stays deepForest, like the app's other menus.
          background: C.barSurface,
          borderBottom: `1px solid ${C.forest}`,
          display: "flex",
          gap: 8,
          alignItems: "center",
          minHeight: 20,
          userSelect: "none",
        }}
      >
        {recent.length > 0 ? (
          // Breadcrumb of the last ≤4 prompts, oldest→newest. Each segment shares the row width
          // equally (flex 1 1 0) and truncates with "…", so four always fit on one line; thin ›
          // separators sit between. Each segment is a real <button> so it's clickable AND keyboard-
          // /screen-reader-reachable (Enter/Space activate it natively); it opens the dropdown on
          // that prompt. recent is non-empty only when history is, so `interactive` is always true
          // here — no per-segment guard needed.
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>
            {recent.map((entry, i) => (
              <Fragment key={entry.id}>
                {i > 0 && (
                  <span
                    aria-hidden="true"
                    style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, padding: "0 6px" }}
                  >
                    ›
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`ph-crumb-${entry.id}`}
                  title={oneLine(entry.text)}
                  onClick={() => onCrumbClick(entry)}
                  style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textAlign: "left",
                    background: "none",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    color: C.cream,
                    fontFamily: '"IBM Plex Sans", sans-serif',
                    fontWeight: FONT_WEIGHT.regular,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {oneLine(entry.text)}
                </button>
              </Fragment>
            ))}
          </div>
        ) : (
          // No history yet (degenerate: a current prompt but no recorded history) — show it plain.
          <span
            style={{
              color: C.cream,
              fontWeight: FONT_WEIGHT.regular,
              fontSize: 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {prompt}
          </span>
        )}
        {interactive && (
          // The caret is the "open the full history" affordance: a real button (Enter/Space open it
          // natively; ArrowDown too), opening the dropdown with a clean slate (no crumb pre-selected).
          // It's also the focus-return target on keyboard dismiss. Rotates up while the menu is open.
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Show prompt history"
            onClick={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "none",
              padding: 0,
              margin: 0,
              color: C.muted,
              fontSize: 10,
              cursor: "pointer",
              transition: "transform 120ms ease",
              transform: open ? "rotate(180deg)" : "none",
            }}
          >
            ▾
          </button>
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
  // Hovering a row reveals its actions (Jump / Copy / Send) without requiring a click to select it.
  const [hovered, setHovered] = useState(false);
  // The row shows its actions when either the keyboard selection is on it or the pointer is over it.
  const showActions = selected || hovered;

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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        gap: 10,
        alignItems: expanded ? "flex-start" : "baseline",
        background: showActions ? CHAT_USER_BUBBLE : "transparent",
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

      {showActions ? (
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
