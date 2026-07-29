// The @-mention picker: the list that pops over the concierge composer when you type "@".
//
// A SIBLING OF CommandPalette, not a copy of it — same idiom (deepForest panel, gold selected rail,
// muted hairlines), different mechanics, and the difference is the whole design:
//
//   • The palette is a MODAL with its own input. This is an ANCHORED overlay with NO input and NO
//     focus of its own. The caret must stay in the textarea the entire time, because the query is
//     the text the user is still typing — a picker that stole focus would stop `@Bl` narrowing to
//     `@Blu` at the first keystroke, which is the founder's entire description of the feature.
//     So this component is PURELY presentational: ComposeBox owns `selected` and handles ↑↓/↩/Esc
//     on the textarea, and the two are tied together for assistive tech by `aria-activedescendant`
//     pointing from the textarea at the row id rendered here (the same wiring CommandPalette uses
//     between its input and its listbox).
//   • It is positioned bottom-up (`bottom: 100%`), so it grows INTO the thread rather than pushing
//     the compose box down. The box's height is a measured, drag-overridable, persisted quantity
//     (engine/composeBoxHeight); an overlay that changed it would fight that engine and re-measure
//     the placeholder floor on every keystroke of a query.
//
// NO EMOJI. Feather icons only (react-icons/fi), like every other control in this column.
import type { CSSProperties } from "react";
import { FiCornerDownLeft, FiSlash } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
// The type scale, not raw pixels: `theme/scale.test.ts` is a RATCHET on off-scale fontSize values,
// and the project line first shipped here at 11px — a size the scale does not have. Its rungs are
// 10/12/13/17, so the row's name is `body` (primary UI text, the same as the thread) and the
// secondary line under it is `small` (the chips-and-metadata rung).
import { TYPE } from "../../theme/scale";
import { bandColor } from "../../engine/statusBandLabels";
import { MENTION_SIGIL, type MentionAgent } from "./mentions";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

/** The id `aria-activedescendant` points at. Built here and read by ComposeBox, so the two cannot
 *  drift into naming different nodes — a mismatch is silent, and its only symptom is that a screen
 *  reader announces nothing as the user arrows through the list. */
export const mentionOptionId = (agentId: string) => `concierge-mention-opt-${agentId}`;

/** The id of the listbox itself, for the textarea's `aria-controls`. One picker per composer, so a
 *  constant rather than a hook. */
export const MENTION_LISTBOX_ID = "concierge-mention-listbox";

/** Why a row is offered but not choosable. Short, because it sits in a 360px column — and stated at
 *  all because "no such agent" and "that agent can't be prompted" are different facts, and hiding
 *  the row would collapse them into one (see orderMentionAgents). */
const CANNOT_TAKE_INPUT = "Can't take a message";

/** How many rows the list shows before it scrolls. Enough that a real fleet is browsable, few
 *  enough that the overlay never swallows the thread behind it. */
const MAX_VISIBLE_ROWS = 7;
const ROW_H = 42;

const dot = (band: MentionAgent["band"]): CSSProperties => ({
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: bandColor(band),
});

export function MentionPicker({
  agents,
  selected,
  onSelect,
  onHover,
}: {
  /** Already filtered and ordered by the caller (see mentions.orderMentionAgents) — this component
   *  renders a list, it never decides one. Empty means the picker should not be rendered at all;
   *  the caller closes it rather than showing an empty panel, because a panel that says "no matches"
   *  over a composer is a dead end the user has to dismiss, and typing on is the better exit. */
  agents: readonly MentionAgent[];
  /** Index of the highlighted row, owned by the composer (the caret never leaves the textarea). */
  selected: number;
  onSelect: (agent: MentionAgent) => void;
  onHover: (index: number) => void;
}) {
  if (agents.length === 0) return null;

  return (
    <div
      id={MENTION_LISTBOX_ID}
      data-testid="concierge-mention-picker"
      role="listbox"
      aria-label="Mention an agent"
      style={{
        position: "absolute",
        // Bottom-up: the list grows into the thread, never into the compose box's measured height.
        bottom: "100%",
        left: 0,
        right: 0,
        marginBottom: 6,
        zIndex: 5,
        maxHeight: MAX_VISIBLE_ROWS * ROW_H,
        overflowY: "auto",
        background: C.deepForest,
        border: `1px solid ${line}`,
        borderRadius: 6,
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      }}
    >
      {agents.map((a, i) => {
        const isSelected = i === selected;
        const disabled = !a.canAcceptInput;
        return (
          <div
            key={a.id}
            id={mentionOptionId(a.id)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled || undefined}
            data-testid="concierge-mention-option"
            data-agent-id={a.id}
            title={disabled ? CANNOT_TAKE_INPUT : `Send this message to ${a.name}`}
            onMouseEnter={() => onHover(i)}
            // onMouseDown, not onClick, and preventDefault with it: a click anywhere outside the
            // textarea blurs it first, and a blurred textarea has no selectionStart to insert at —
            // the pick would land at offset 0 or not at all. Preventing the default mousedown keeps
            // the caret exactly where the user left it, which is where the mention has to go.
            onMouseDown={(e) => {
              e.preventDefault();
              if (!disabled) onSelect(a);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              borderBottom: `1px solid ${line}`,
              // The concierge gold on the selected row, matching the palette's rail exactly — the
              // THEMED `goldFill` for the opaque rail (a literal vanishes on the light palette) and
              // an 8% wash for the translucent ground.
              borderLeft: isSelected ? `3px solid ${C.goldFill}` : "3px solid transparent",
              background: isSelected ? `color-mix(in srgb, ${C.gold} 8%, transparent)` : "transparent",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.55 : 1,
            }}
          >
            <span style={dot(a.band)} aria-hidden />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 1,
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  fontSize: TYPE.body,
                  color: C.cream,
                  fontWeight: isSelected ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {MENTION_SIGIL}
                {a.label ?? a.name}
              </span>
              {/* A second line only when the row owes the user a reason it cannot be chosen. It
                  used to also carry the PROJECT when two rows shared a name — that job moved into
                  the address itself (`@Docs (web)`, mentions.withMentionLabels), which is both
                  visible here AND carried by the message, so a duplicate is no longer distinguished
                  by a label that stops travelling the moment the message is sent. */}
              {disabled && (
                <span
                  style={{
                    fontSize: TYPE.small,
                    color: C.conciergeMuted,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <FiSlash size={10} aria-hidden />
                  {CANNOT_TAKE_INPUT}
                </span>
              )}
            </span>
            {/* The one affordance the list itself states: Enter takes the highlighted row. Only on
                that row, so it reads as an instruction rather than as decoration repeated N times. */}
            {isSelected && !disabled && (
              <FiCornerDownLeft size={12} aria-hidden style={{ flex: "0 0 auto", color: C.goldInk }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
