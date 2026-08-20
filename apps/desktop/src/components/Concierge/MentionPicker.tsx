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
import { useEffect, useRef, type CSSProperties } from "react";
import { FiCornerDownLeft, FiHash, FiSlash } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
// The type scale, not raw pixels: `theme/scale.test.ts` is a RATCHET on off-scale fontSize values,
// and the project line first shipped here at 11px — a size the scale does not have. Its rungs are
// 10/12/13/17, so the row's name is `body` (primary UI text, the same as the thread) and the
// secondary line under it is `small` (the chips-and-metadata rung).
import { TYPE } from "../../theme/scale";
import { bandColor } from "../../engine/statusBandLabels";
import { isBeadMentionId, MENTION_SIGIL, parseBeadMentionId, type MentionAgent } from "./mentions";

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

/**
 * Can this row be PICKED at all?
 *
 * ══ WHY IT IS NOT `canAcceptInput`, AND WHY THE ANSWER LIVES HERE ═══════════════════════════════
 * Those two questions used to be the same one, and beads split them apart. A bead carries
 * `canAcceptInput: false` — honestly, because a unit of work genuinely cannot receive a prompt — but
 * it is entirely pickable: choosing it writes a REFERENCE into the draft. Reading deliverability as
 * choosability would leave every bead row in the list, greyed, refusing Enter and refusing the
 * mouse, which is the founder's feature not working while looking deliberate.
 *
 * Exported because `ComposeBox.chooseMention` makes the same refusal on the keyboard path, and two
 * copies of this rule is exactly how the picker ends up offering a row that Enter silently drops.
 *
 * Keyed on the ID (`isBeadMentionId`), not on `kind`: this is the ROUTING-shaped question — what may
 * happen when the row is taken — and the id is the total answer, surviving `rosterFromMentions`,
 * which rebuilds a roster from `{agentId, name}` pairs and has nowhere to carry a kind. `kind` is
 * read below for the opposite kind of question: what the row SAYS.
 */
export function mentionRowIsChoosable(a: MentionAgent): boolean {
  return a.canAcceptInput || isBeadMentionId(a.id);
}

/** How many rows the list shows before it scrolls. Enough that a real fleet is browsable, few
 *  enough that the overlay never swallows the thread behind it.
 *
 *  HOW MANY ONE-LINE ROWS FIT, which is not the same as how many ROWS fit — a two-line row costs
 *  {@link ROW_H_TWO_LINE}. The budget that actually clips is {@link LIST_MAX_H}, and `mentions.ts`
 *  is held to that in PIXELS.
 *
 *  IT IS 9, NOT 7, AND THE NUMBER IS DERIVED (roborev 65738). The guard has to be true at the
 *  shipped constants, and at 7 it was not: three agent rows above three bead rows is 306px of
 *  content against a 294px window, so the assertion named a property the layout did not have while
 *  staying green. Worse, it was loose enough that raising the bead cap from 3 to 4 still passed
 *  (7 x 42 = 294) while painting 366px — the smallest raise, and the one a mutation check that only
 *  tried 3 -> 30 never exercised. The window is now sized for the WORST case of the whole reserved
 *  block, every row two-line: (3 + 3) x 60 = 360 <= 378. */
export const MAX_VISIBLE_ROWS = 9;

/**
 * A ONE-LINE row: an agent that can take input, drawn as a single line of label.
 *
 * TRUE BY CONSTRUCTION, not by estimate (roborev 65730). Both of these used to be hand-written
 * numbers with nothing tying them to the row's actual box — the height came from the padding, the
 * two line boxes, the gap and the border, none of which the invariant could read. That is the same
 * failure as the row-count guard this replaced, one level up: give the bead row a third line and
 * the real height passes the constant while the arithmetic stays green. The rows now take these as
 * an explicit `height` with `overflow: hidden`, so the constant IS the rendered height.
 */
export const ROW_H = 42;

/**
 * A TWO-LINE row, as an UPPER BOUND for budgeting rather than a measured value.
 *
 * Rows are not uniform, and that is what made the first version of the visible-window guarantee
 * wrong (roborev 65710). A bead row carries the bead id on a second line; an agent that cannot take
 * input carries the "Can't take a message" reason on one. So a window sized `MAX_VISIBLE_ROWS *
 * ROW_H` shows SEVEN rows only when every row happens to be one-line — and the guard that beads sit
 * inside it counted ROWS, which can be satisfied while the pixels say otherwise.
 *
 * Applied as an explicit `height` on the rows that carry a second line, for the reason given on
 * {@link ROW_H}: a budgeting constant that the layout does not actually obey is a guard in name
 * only.
 */
export const ROW_H_TWO_LINE = 60;

/** The overlay's own height budget, in pixels — what actually clips. */
export const LIST_MAX_H = MAX_VISIBLE_ROWS * ROW_H;

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
  // ══ KEEP THE HIGHLIGHTED ROW ON SCREEN (roborev 65677) ════════════════════════════════════════
  // The list clips at MAX_VISIBLE_ROWS with `overflowY: "auto"` and nothing ever scrolled it, so
  // ↑/↓ walked the highlight straight out of the visible window: the founder holds Down, the
  // selection and `aria-activedescendant` keep advancing, and the panel shows the same seven rows.
  // It is worst exactly where the list is longest, which is the uncapped agent half.
  //
  // `block: "nearest"` rather than "center", because this overlay sits directly above the compose
  // box: centring would jump the list on every arrow press even when the row was already visible.
  // Declared BEFORE the empty-list early return — hooks may not sit behind a conditional.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  // THE LIST'S IDENTITY, not just the index (roborev 65710). `scrollTop` survives a re-render but
  // the row AT a given index does not, so keying the effect on `selected` alone misses the case
  // where the row set changes underneath an unmoved highlight: wheel-scroll a 60-row fleet down,
  // type another character, and ComposeBox calls `setSelected(0)` when `selected` is ALREADY 0 —
  // no state change, no effect, and the container stays parked twenty rows below the highlight.
  // That is precisely the symptom this effect exists to remove, so the row set has to be a dep.
  const rowKey = agents.map((a) => a.id).join("\u0000");
  useEffect(() => {
    // Optional-called: jsdom implements no layout and does not define scrollIntoView at all, so an
    // unguarded call would throw in every test that renders this picker — the tests that DO assert
    // this install the method themselves.
    //
    // It carries more weight than it used to. The ordering rule in mentions.ts guarantees the FIRST
    // bead row is visible without scrolling; beads two and three are reachable only by scrolling, so
    // this effect is what makes them selectable rather than a nicety on top of the ordering.
    selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, rowKey]);

  if (agents.length === 0) return null;

  return (
    <div
      id={MENTION_LISTBOX_ID}
      data-testid="concierge-mention-picker"
      role="listbox"
      // BOTH KINDS. The list has held beads since sparkle-1cpomd, and a label naming only agents is
      // the one description a screen-reader user gets of what this overlay is for.
      aria-label="Mention an agent or a bead"
      style={{
        position: "absolute",
        // Bottom-up: the list grows into the thread, never into the compose box's measured height.
        bottom: "100%",
        left: 0,
        right: 0,
        marginBottom: 6,
        zIndex: 5,
        maxHeight: LIST_MAX_H,
        overflowY: "auto",
        background: C.deepForest,
        border: `1px solid ${line}`,
        borderRadius: 6,
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      }}
    >
      {agents.map((a, i) => {
        const isSelected = i === selected;
        const disabled = !mentionRowIsChoosable(a);
        // WHAT THE ROW IS, for everything it SAYS and DRAWS below — the status dot, the second line,
        // the tooltip. Branching on `kind` rather than on the id prefix is deliberate and is the
        // division `MentionAgent.kind` exists for: the id answers "what may this do" (see
        // `mentionRowIsChoosable`), the field answers "what does this look like". Re-deriving
        // bead-ness from a string prefix at paint time is coupling that drifts.
        const isBead = a.kind === "bead";
        // Null for an agent, and for a bead whose id somehow does not parse — in which case the row
        // simply shows no second line rather than printing `null` at the founder.
        const beadId = isBead ? parseBeadMentionId(a.id) : null;
        // ══ WHICH SECOND LINE THIS ROW DRAWS — COMPUTED ONCE (roborev 65738) ═══════════════════
        // The height above and the two conditional blocks below used to test the same thing in
        // three places, one of them a hand-maintained duplicate (`beadId !== null || disabled`).
        // Add a third second-line variant, or one where both conditions fire, and the duplicate
        // silently under-reports — the row keeps the one-line height and `overflow: hidden` clips
        // the new line with no error, no reflow and no failing test. That is precisely the silent
        // clipping this change exists to prevent, so the predicate and the render read one value.
        const secondLine: "reason" | "bead" | null = disabled
          ? "reason"
          : beadId !== null
            ? "bead"
            : null;
        return (
          <div
            key={a.id}
            ref={isSelected ? selectedRowRef : undefined}
            id={mentionOptionId(a.id)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={disabled || undefined}
            data-testid="concierge-mention-option"
            data-agent-id={a.id}
            // THE HEIGHT IS THE CONSTANT, so the pixel invariant in mentions.test.ts is a statement
            // about what paints rather than about two numbers that were written down.
            // `overflow: hidden` is what makes the height a ceiling and not merely a floor.
            data-two-line={secondLine === null ? undefined : secondLine}
            // A BEAD IS NEVER A DESTINATION, so "Send this message to …" is not merely unhelpful on
            // one — it is false, and it is false in the direction that matters: it invites the
            // founder to believe he is aiming a message at a task. The composer refuses that
            // (`composerRoute` returns no address for a leading bead), so the copy has to agree with
            // the routing or the tooltip becomes the thing he trusts.
            title={
              isBead
                ? `Reference ${a.label ?? a.name}`
                : disabled
                  ? CANNOT_TAKE_INPUT
                  : `Send this message to ${a.name}`
            }
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
              height: secondLine === null ? ROW_H : ROW_H_TWO_LINE,
              boxSizing: "border-box",
              overflow: "hidden",
              borderLeft: isSelected ? `3px solid ${C.goldFill}` : "3px solid transparent",
              background: isSelected ? `color-mix(in srgb, ${C.gold} 8%, transparent)` : "transparent",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.55 : 1,
            }}
          >
            {/* The leading glyph says WHICH KIND of thing this row is. An agent gets its live status
                dot; a bead gets a quiet hash, because `bandColor` is a claim about a running process
                and a bead has none — a bead painted `done`-coloured would read as an agent that had
                finished, which is a different and wrong fact. */}
            {isBead ? (
              <FiHash size={11} aria-hidden style={{ flex: "0 0 auto", color: C.conciergeMuted }} />
            ) : (
              <span style={dot(a.band)} aria-hidden />
            )}
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
              {secondLine === "reason" && (
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
              {/* A BEAD'S SECOND LINE IS ITS ID, and it is not decoration. `beadMentionLabel`
                  truncates a title at 48 characters, and a backlog holds near-duplicate titles
                  ("Fix the login flow" twice, in two epics) — so the id is what tells two offered
                  rows apart. It is also the handle the founder greps and pastes to other agents,
                  which is why `BeadPill` shows the id and never the author's label.

                  Deliberately NOT the disabled row's shape: no `FiSlash`, no reason-it-cannot-be-
                  chosen. A bead row is fully choosable (see `mentionRowIsChoosable`), and dressing
                  it as a refused agent would be the picker telling the founder his feature is
                  broken. Quiet — the muted small rung the project line used to occupy. */}
              {secondLine === "bead" && (
                <span
                  data-testid="concierge-mention-bead-id"
                  style={{
                    fontSize: TYPE.small,
                    color: C.conciergeMuted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {beadId}
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
