import { useEffect, useRef, useState } from "react";
import { FiX, FiCheck, FiChevronDown } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
import type { SuggestionButton } from "../../services/suggestions/types";

// The recommended one-click action, shown when an agent is waiting on the user and the composer
// is empty. Rendered as an ABSOLUTE OVERLAY pinned to the trailing-right edge of the textarea
// (vertically centered) rather than a width-eating sibling — so the composer keeps its full width
// and the caret/placeholder sit at the left. Only `buttons[0]` (most-likely) renders at rest.
// The pill = [ label ⌄ ×]: clicking the label sends the top action; clicking × dismisses the pill.
// When more candidates exist (`buttons.length > 1`), a caret between label and × discloses a
// popover — opening UPWARD (the composer sits at the bottom of the window) — that lists the next
// candidates (#2, #3) as clickable action pills. Every click routes through `onClick`, so history
// recording (recordEvent) and terminal/prompt/control handling stay identical for all candidates.
interface Props {
  buttons: SuggestionButton[];
  visible: boolean;
  onClick: (b: SuggestionButton) => void;
  onDismiss: (id: string) => void;
}

// Max width of the pill's label text (it ellipsizes past this). Kept modest because the pill is an
// overlay inside the textarea, not a full-width bottom row.
export const SUGGESTION_PILL_LABEL_MAX = 176;
// The horizontal zone the whole pill occupies at the textarea's trailing-right edge. The composer
// reserves this much placeholder room so a long hint can't slide under the pill. Derived from the
// pill's OWN layout — label max + label padding (12+6) + caret (padLeft 2 + icon ~14 + padRight 4
// ≈ 20) + × button (padLeft 2 + icon ~13 + padRight 8 ≈ 23) + right anchor (8) + a small margin
// (8) — so the reservation and the pill width can't drift apart (a fixed magic number could be
// overrun by a near-max-width label). The caret's footprint is always reserved even for a single
// candidate: over-reserving ~20px just wraps a long placeholder a touch early, which is harmless.
export const SUGGESTION_PILL_ZONE = SUGGESTION_PILL_LABEL_MAX + 18 + 20 + 23 + 8 + 8;

// Ties the caret (aria-controls) to the disclosure popover it opens. Only one composer/suggestion
// row is ever mounted, so a stable id is safe.
const POPOVER_ID = "suggestion-more-popover";

export function SuggestionRow({ buttons, visible, onClick, onDismiss }: Props) {
  // Local popover state: whether the "other candidates" list is open. Hooks must run before the
  // early return below, so they live at the top regardless of visibility.
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Whenever the row hides (composer gains typed/interim content) OR the extra candidates go away,
  // force the popover shut so it can never reappear stale when the row becomes visible again.
  const hasMore = buttons.length > 1;
  useEffect(() => {
    if ((!visible || !hasMore) && open) setOpen(false);
  }, [visible, hasMore, open]);

  // While open: Escape closes it, and an outside pointerdown closes it. The caret/popover live
  // inside wrapRef, so clicks on them are ignored here (the caret's own onClick toggles instead).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Cap at one at the render layer (the engine caps the SET at MAX_BUTTONS=3); take index [0], the
  // top-ranked "most likely" action, since the array is ordered most-likely-first.
  const b = buttons[0];
  if (!visible || !b) return null;
  const extras = buttons.slice(1);
  // Control buttons (e.g. Close Build Agent) render as a filled green success pill with a
  // check; suggestion pills are neutral/translucent. White text reads on both green shades.
  const control = b.kind === "control";
  const fg = control ? "#ffffff" : C.cream;

  const runButton = (btn: SuggestionButton) => {
    setOpen(false);
    onClick(btn);
  };

  return (
    // Overlay wrapper: pinned right, vertically centered over the textarea, above it in the stack.
    // pointer-events:none so the wrapper itself never steals clicks/focus from the textarea; the
    // interactive children re-enable pointer-events so they stay clickable while the textarea keeps
    // focus. Positioned relative so the upward popover can anchor to it, right-aligned.
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        right: 8,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 2,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          position: "relative",
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          height: 32,
          borderRadius: 8,
          background: control ? C.successInk : "rgba(255,255,255,0.06)",
          border: control ? "none" : `1px solid ${C.muted}`,
          boxShadow: "0 1px 6px rgba(0,0,0,0.28)",
        }}
      >
        <button
          onClick={() => runButton(b)}
          title={control ? b.label : b.value}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            color: fg,
            padding: "0 6px 0 12px",
            height: "100%",
            cursor: "pointer",
            maxWidth: SUGGESTION_PILL_LABEL_MAX,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 13,
          }}
        >
          {control && <FiCheck size={14} />}
          {b.label}
        </button>
        {hasMore && (
          <button
            aria-label="More suggested actions"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={POPOVER_ID}
            onClick={() => setOpen((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              borderLeft: `1px solid ${control ? "rgba(255,255,255,0.25)" : C.muted}`,
              color: fg,
              paddingLeft: 2,
              paddingRight: 4,
              height: "100%",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              opacity: 0.8,
            }}
          >
            <FiChevronDown size={14} />
          </button>
        )}
        <button
          aria-label={`Dismiss ${b.label}`}
          onClick={() => onDismiss(b.id)}
          style={{
            background: "transparent",
            border: "none",
            color: fg,
            paddingRight: 8,
            paddingLeft: 2,
            height: "100%",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            opacity: 0.6,
          }}
        >
          <FiX size={13} />
        </button>
        {open && extras.length > 0 && (
          // Popover of the other candidates. Opens UPWARD (bottom: 100%) since the composer sits at
          // the bottom of the window, right-aligned to the pill. Each item runs its OWN button
          // through the same onClick routing, then closes. It's a plain disclosure (a group of
          // buttons), NOT an ARIA menu widget — using role="menu"/"menuitem" would promise
          // roving-focus/arrow-key keyboarding we don't implement, so we keep native <button>
          // semantics and tie them to the caret via aria-controls + aria-haspopup instead.
          <div
            id={POPOVER_ID}
            role="group"
            aria-label="Other suggested actions"
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              right: 0,
              minWidth: 160,
              maxWidth: 260,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: 6,
              borderRadius: 10,
              background: C.deepForest,
              border: `1px solid ${C.muted}`,
              boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
              pointerEvents: "auto",
            }}
          >
            {extras.map((x) => (
              <button
                key={x.id}
                onClick={() => runButton(x)}
                title={x.kind === "control" ? x.label : x.value}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  borderRadius: 6,
                  color: C.cream,
                  padding: "6px 8px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: FONT_WEIGHT.semibold,
                  fontFamily: '"IBM Plex Sans", sans-serif',
                  fontSize: 13,
                }}
              >
                {x.kind === "control" && <FiCheck size={14} />}
                {x.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
