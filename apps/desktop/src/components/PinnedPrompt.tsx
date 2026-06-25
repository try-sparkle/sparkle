import { useEffect, useMemo, useRef, useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../theme/colors";
import type { PromptHistoryEntry } from "../types";
import { formatAgo, oneLine } from "./promptHistory";

/**
 * Always-visible header showing the agent's most recent prompt (spec §7) — so you never have
 * to scroll up through terminal output to find what you last asked.
 *
 * When `onSelectPrompt` is provided and there's history, the header becomes a button that pulls
 * down a dropdown of every prompt sent to this agent (newest first). Picking one asks the parent
 * to scroll the terminal back to where that prompt was sent. The dropdown is a proper listbox:
 * Up/Down/Home/End move the active option, Enter/Space picks it, Esc closes. With no
 * handler/history it renders as the original static, non-interactive header.
 */
export function PinnedPrompt({
  prompt,
  history = [],
  onSelectPrompt,
}: {
  prompt: string;
  history?: PromptHistoryEntry[];
  onSelectPrompt?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The dropdown only makes sense when we can act on a pick and there's something to show.
  const interactive = !!onSelectPrompt && history.length > 0;
  // The store keeps history oldest-first; the dropdown shows newest-first.
  const items = useMemo(() => history.slice().reverse(), [history]);

  // Return focus to the trigger header (e.g. on keyboard dismiss) so a keyboard user keeps
  // their place instead of dropping to document.body when the list unmounts.
  const refocusHeader = () => requestAnimationFrame(() => headerRef.current?.focus());

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

  // On open, start at the top and move keyboard focus into the list so arrow keys work immediately.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => listRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    refocusHeader();
    onSelectPrompt?.(id);
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(items.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(items.length - 1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const it = items[activeIndex];
        if (it) pick(it.id);
        break;
      }
      // Escape is handled by the document-level listener so it works even after a Tab-out.
    }
  };

  const activeId = interactive && open ? items[activeIndex]?.id : undefined;

  return (
    // position/zIndex so the dropdown overlays the terminal (a later sibling) below the header.
    <div ref={rootRef} style={{ position: "relative", zIndex: 20, flex: "0 0 auto" }}>
      <div
        ref={headerRef}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-haspopup={interactive ? "listbox" : undefined}
        aria-expanded={interactive ? open : undefined}
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
        title={
          interactive
            ? prompt
              ? `${oneLine(prompt)} — show history`
              : "Show prompt history"
            : prompt || undefined
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
              active={i === activeIndex}
              onPick={() => pick(entry.id)}
              onActivate={() => setActiveIndex(i)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  active,
  onPick,
  onActivate,
}: {
  entry: PromptHistoryEntry;
  active: boolean;
  onPick: () => void;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const text = oneLine(entry.text) || "(empty prompt)";

  // Keep the keyboard-active row in view as Up/Down move past the visible window.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <li
      ref={ref}
      id={`ph-opt-${entry.id}`}
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseEnter={onActivate}
      title={text}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        background: active ? CHAT_USER_BUBBLE : "transparent",
        color: C.cream,
        borderRadius: 6,
        padding: "7px 9px",
        cursor: "pointer",
      }}
    >
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
        {text}
      </span>
      <span style={{ flex: "0 0 auto", fontSize: 11, color: C.muted }}>
        {formatAgo(Date.now(), entry.at)}
      </span>
    </li>
  );
}
