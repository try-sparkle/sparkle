// The concierge command palette (bead sparkle-2yqm / CM-U5) — ⌘K history search, per the PRD
// (§4: "a command-palette / search field in the concierge that searches conversation + agent
// history"). A modal overlay in the concierge idiom (deepForest ink, amber accent, Verdana):
// type-to-search over the REAL historyStore (which owns the debounce + the Tauri FTS call),
// arrow keys move the selection, Enter jumps to the hit's source agent via the same routing
// HistorySearch uses (see ./paletteJump), Esc closes.
//
// Mount-ready for the shell integrator (U7): render <CommandPalette> anywhere (it's a fixed
// overlay), drive it with useCommandPalette() (owns the ⌘K binding), and drop <PaletteTrigger>
// wherever the concierge column wants its search affordance.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { FiSearch } from "react-icons/fi";
import { BADGE_EDGE_PCT, C, DANGER, FONT_WEIGHT } from "../../theme/colors";
import { useHistoryStore } from "../../stores/historyStore";
import type { HistoryHit, RetentionTier } from "../../services/history";
import { relativeTime, renderSnippet } from "../HistorySearch";
import { defaultJumpDeps, jumpToHit, type JumpOutcome } from "./paletteJump";
import { FONT_UI } from "../../theme/scale";
import { KeyPill } from "./KeyPill";

/** Shown on a row whose source agent no longer exists (closing an agent deletes its worktree,
 *  so there's nothing to reopen — say so honestly, same wording as HistorySearch). */
export const AGENT_CLOSED_MESSAGE = "This agent was closed — its workspace no longer exists.";
/** How long the "agent closed" notice lingers before it auto-dismisses. */
const NOTICE_TIMEOUT_MS = 4000;

/** Human label for the active retention window, shown in the empty state + footer. */
const RETENTION_LABEL: Record<RetentionTier, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  "90d": "the last 90 days",
  "1y": "the last year",
  indefinite: "all time",
};

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;



const kindBadge = (kind: HistoryHit["kind"]): CSSProperties => ({
  flex: "0 0 auto",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: FONT_WEIGHT.semibold,
  padding: "1px 5px",
  borderRadius: 4,
  // THE KIND IS CARRIED BY EDGE WEIGHT, ON THE THEMED INK. Three attempts converged here and the
  // dead ends are worth recording, because each one looked right (roborev 54169 → 54231 → 54253).
  //
  // 1. `kind === "prompt" ? C.goldInk : C.accentInk` stopped meaning anything when Blueprint
  //    retired gold: both tokens became the same value, so the ternary painted one colour twice.
  // 2. Replacing it with solid-vs-outline used `C.accent`, an UNTHEMED cyan literal. On the dark
  //    panel that reads; on the LIGHT panel it composites to almost nothing, so the badge had no
  //    visible edge at all in light mode and the distinction still did not exist. The comment
  //    claiming otherwise also measured a plane the badge never renders on — it renders on
  //    `C.deepForest`, the palette panel, or the selected-row wash.
  // 3. A heavier FILL cannot carry it either, and this is the constraint that decides the design:
  //    the label is `accentInk` and the fill would be a tint of `accentInk`, so the two collide.
  //    The label drops under AA at even a slight fill and keeps falling as the fill grows —
  //    anything strong enough to see makes the text it contains unreadable.
  //
  // So both kinds keep a transparent ground and the same ink, and the WEIGHT of the themed edge is
  // the signal. NO RATIOS HERE: this comment has now been wrong about its own numbers twice, and
  // the guard is the contract. `chromeContrast.test.ts` measures these exact composites — both
  // weights, on both surfaces, in both themes, plus that the two weights stay distinguishable and
  // that the label clears AA on the ground it sits on.
  color: C.accentInk,
  background: "transparent",
  border: `1px solid color-mix(in srgb, ${C.accentInk} ${BADGE_EDGE_PCT[kind === "prompt" ? "prompt" : "other"]}%, transparent)`,
});

export interface CommandPaletteProps {
  /** Overlay visibility — owned by the integrator (see useCommandPalette). */
  open: boolean;
  /** Close request: Esc, backdrop click, or after a successful jump. */
  onClose: () => void;
  /** Route a hit to its source agent. Injected in tests; defaults to the real store/window
   *  wiring (the same paths HistorySearch routes through). */
  jump?: (hit: HistoryHit) => JumpOutcome;
  /** Observation hook for the integrator (e.g. analytics, toasts). Fires on every activation,
   *  including the non-navigating outcomes. */
  onJumped?: (hit: HistoryHit, outcome: JumpOutcome) => void;
}

export function CommandPalette({ open, onClose, jump, onJumped }: CommandPaletteProps) {
  const query = useHistoryStore((s) => s.query);
  const results = useHistoryStore((s) => s.results);
  const entitlement = useHistoryStore((s) => s.entitlement);
  const searching = useHistoryStore((s) => s.searching);
  const setQuery = useHistoryStore((s) => s.setQuery);

  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);

  // A transient "that agent has been closed" notice, keyed by the row that triggered it.
  const [closedHitId, setClosedHitId] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  // Fresh results restart the selection at the top and invalidate any stale closed-notice —
  // adjusted during render (not in an effect) so there's no flash of a stale selection.
  const [lastResults, setLastResults] = useState(results);
  if (results !== lastResults) {
    setLastResults(results);
    setSelected(0);
    setClosedHitId(null);
  }

  // Focus (and pre-select) the input every time the palette opens.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Closing clears the shared store query so the legacy sidebar HistorySearch (same store)
  // doesn't reopen its dropdown over stale palette input. The open→false effect covers every
  // close path, including external ones (⌘K toggle, closePalette()) that bypass close().
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) setQuery("");
    wasOpen.current = open;
  }, [open, setQuery]);

  const close = useCallback(() => {
    setQuery("");
    onClose();
  }, [setQuery, onClose]);

  const activate = useCallback(
    (h: HistoryHit) => {
      if (!h.projectId) return; // unknown/deleted project — row is disabled
      const outcome = (jump ?? ((hit: HistoryHit) => jumpToHit(hit, defaultJumpDeps())))(h);
      onJumped?.(h, outcome);
      if (outcome.kind === "agent-closed") {
        setClosedHitId(h.id);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setClosedHitId(null), NOTICE_TIMEOUT_MS);
        return; // stay open — the user will pick another row
      }
      close();
    },
    [jump, onJumped, close],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = results[selected];
      if (h) activate(h);
    }
  };

  // Backdrop click closes; clicks inside the panel don't reach the backdrop handler.
  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  if (!open) return null;

  const hasQuery = query.trim().length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search history"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        background: "rgba(2, 6, 18, 0.55)",
        fontFamily: FONT_UI,
      }}
    >
      <div
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "64vh",
          display: "flex",
          flexDirection: "column",
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${line}`,
          borderRadius: 6,
          boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 14px",
            borderBottom: `1px solid ${line}`,
          }}
        >
          <FiSearch size={15} aria-hidden style={{ color: C.goldInk, flex: "0 0 auto" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything you and your agents have said…"
            aria-label="Search history"
            role="combobox"
            aria-expanded={hasQuery}
            aria-controls="concierge-palette-results"
            aria-activedescendant={
              hasQuery && results[selected] ? `palette-opt-${results[selected].id}` : undefined
            }
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: C.cream,
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
          {/* Was a hand-rolled <kbd> whose style had already drifted from its twin below (2px vs
              0px vertical padding). Both now come from KeyPill — the app's one keycap. */}
          <KeyPill>esc</KeyPill>
        </div>

        <div id="concierge-palette-results" role="listbox" aria-label="History results" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {!hasQuery ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "18px 16px", lineHeight: 1.5 }}>
              Type to search your conversation and agent history — prompts and replies, across
              every project.
            </div>
          ) : results.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "18px 16px" }}>
              {searching ? "Searching…" : `No matches in ${RETENTION_LABEL[entitlement]}.`}
            </div>
          ) : (
            results.map((h, i) => {
              const disabled = !h.projectId;
              const isSelected = i === selected;
              return (
                <div
                  key={h.id}
                  id={`palette-opt-${h.id}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={disabled || undefined}
                  data-testid="palette-result"
                  title={disabled ? "This project is no longer available" : "Jump to this agent"}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => activate(h)}
                  style={{
                    borderBottom: `1px solid ${line}`,
                    // The selected row carries the concierge gold. The rail is OPAQUE, so it
                    // takes the themed `goldFill` (BRAND.gold is a constant and vanishes on the
                    // light palette's panel); the 8% wash below stays literal, because a
                    // translucent tint composites against whatever is behind it.
                    borderLeft: isSelected ? `3px solid ${C.goldFill}` : "3px solid transparent",
                    background: isSelected
                      ? `color-mix(in srgb, ${C.gold} 8%, transparent)`
                      : "transparent",
                    cursor: disabled ? "default" : "pointer",
                    opacity: disabled ? 0.5 : 1,
                    padding: "9px 13px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={kindBadge(h.kind)}>{h.kind}</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: C.muted,
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {[h.projectName, h.agentName].filter(Boolean).join(" · ") || "—"}
                    </span>
                    <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 12 }}>
                      {relativeTime(h.createdAt)}
                    </span>
                  </div>
                  <div
                    style={{
                      color: isSelected ? C.cream : C.muted,
                      fontSize: 12,
                      lineHeight: 1.45,
                      // Clamp the snippet to two lines so a long hit can't blow out the row.
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {renderSnippet(h.snippet)}
                  </div>
                  {closedHitId === h.id && (
                    <div
                      role="alert"
                      style={{
                        marginTop: 4,
                        color: DANGER,
                        fontSize: 12,
                        fontWeight: FONT_WEIGHT.semibold,
                      }}
                    >
                      {AGENT_CLOSED_MESSAGE}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 14px",
            borderTop: `1px solid ${line}`,
            color: C.muted,
            fontSize: 10,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            Searching {RETENTION_LABEL[entitlement]}
          </span>
          <span style={{ flex: "0 0 auto" }}>↑↓ navigate · ↩ jump · esc close</span>
        </div>
      </div>
    </div>
  );
}

/** The small search affordance for the concierge column — attach-button idiom (muted hairline
 *  pill) with the shortcut spelled out. U7 drops this near the wordmark/scope header. */
export function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Search history (⌘K)"
      title="Search history (⌘K)"
      onClick={onOpen}
      style={{
        fontSize: 12,
        color: C.muted,
        background: "transparent",
        border: `1px solid ${line}`,
        borderRadius: 6,
        padding: "5px 9px",
        cursor: "pointer",
        display: "inline-flex",
        gap: 5,
        alignItems: "center",
        fontFamily: FONT_UI,
      }}
    >
      <FiSearch size={12} aria-hidden />
      Search
      <KeyPill>⌘K</KeyPill>
    </button>
  );
}
