// PersonRow — a human in the Build column, reading as a peer of an agent row. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §9 (U3), §10 "Key UI design calls".
//
// ══ WHY THIS IS A NEW FILE AND NOT A REUSE OF `AgentRow` ═══════════════════════════════════════
// The spec is explicit and the reason is mechanical, not taste: `AgentRow`'s props type is ~40
// fields keyed on `Project` / `AgentTab` / `BranchStatus` / `WorkflowStageId` / `BuildSectionId`,
// and `agentRowPropsEqual` is a HAND-MAINTAINED exhaustive comparator whose own docstring says that
// omitting a data prop leaves the row painting stale data. A person has none of those facts, so
// reusing that row means either widening 40 fields with nullable person cases or passing fakes
// through a comparator that cannot know they are fakes. Its props here are its own ~6.
//
// ══ WHAT IT DOES SHARE, AND WHY THAT IS THE WHOLE POINT ════════════════════════════════════════
// The build column is scannable straight down only because every row in it is the SAME row. That
// rule is written down in `SparkleAgentRow`'s docstring (AgentSidebar.tsx) — "same disc slot
// (DOT_SLOT_W / DOT_SIZE), same box (ROW_PAD_*, LIST_PAD_X), same title size (AGENT_NAME_FONT_SIZE)
// and neutral ink" — and it is IMPORTABLE because `components/rowAnatomy.tsx` exists. So this row
// calls `rowBoxFor` for its box and renders `<ActiveFillets>` when selected, exactly as the two
// existing row types do. NOTHING here re-derives a number from that module; a literal `10` or `24`
// in this file is the drift the extraction was done to end.
//
// ══ THE LEADING SLOT ═══════════════════════════════════════════════════════════════════════════
// An agent row puts a `StatusDot` in a 24×20 slot; a person puts a `PersonAvatar` in the same one.
// `GLYPH_SLOT_H` (20) is the binding constraint and the avatar is 18, so it fits with air to spare.
// The availability dot is PersonAvatar's OWN overlay, composed there at one overlap ratio so the
// row (18) and the top bar (28) can never disagree — do NOT hand-place a second dot beside it.
//
// ══ THE NAME COMES FROM `personName`, ALWAYS ═══════════════════════════════════════════════════
// Never `person.username` directly. `personName` is display-name-else-username, and it is one
// function precisely so the row, the avatar's letter and a future `@mention` address cannot end up
// naming the same human three ways.
//
// ══ COLOUR IS NOT THE INFORMATION ══════════════════════════════════════════════════════════════
// The row's accessible name carries the availability IN WORDS via `availabilityLabel`, and the
// unread count too. The avatar and its dot are `aria-hidden` beneath that name, so nothing is read
// twice and nothing is conveyed by a green disc alone (WCAG 1.4.1).

import { memo, type KeyboardEvent } from "react";

import { C } from "../theme/colors";
import { AGENT_NAME_FONT_SIZE, rowTitleWeight } from "./FittedAgentName";
import { chip } from "./labelTreatment";
import { PersonAvatar } from "./PersonAvatar";
import { availabilityLabel } from "./AvailabilityDot";
import { ActiveFillets, rowBoxFor } from "./rowAnatomy";
import { DOT_SLOT_W, GLYPH_SLOT_H, type PairSide } from "../engine/rowGeometry";
import { personName, type Person } from "../stores/socialStore";

/** The avatar's diameter in a sidebar row. 18 inside the 24×20 glyph slot — see the header. */
export const PERSON_ROW_AVATAR_SIZE = 18;

export const PERSON_ROW_TESTID = "person-row";

/** The spoken name of a row: who, how reachable, and how much is waiting.
 *
 *  ONE function rather than an inline template so the test asserts the same string the row paints,
 *  and so the availability word is `availabilityLabel`'s — never a paraphrase invented here, which
 *  is how two surfaces end up calling the same state different things. */
export function personRowLabel(person: Person, unread: number): string {
  const base = `${personName(person)} — ${availabilityLabel(person.availability)}`;
  return unread > 0 ? `${base} — ${unread} unread` : base;
}

export interface PersonRowProps {
  person: Person;
  isActive: boolean;
  /**
   * Does this row's selection actually claim the terminal pane?
   *
   * ══ WHY THIS IS NOT JUST `isActive` ════════════════════════════════════════════════════════
   * On an agent row the two are the same fact, which is why neither `AgentRow` nor
   * `SparkleAgentRow` needs the distinction: selecting one IS what puts that agent in the pane.
   * A person row can be selected without owning anything — before stage U6 lands the mount,
   * clicking a person changes only this component's own state, and the terminal keeps showing
   * whichever agent `project.selectedAgentId` names.
   *
   * ══ WHAT IT SUPPRESSES: THE WHOLE JUNCTION, NOT JUST THE MOUTHS ════════════════════════════
   * `rowAnatomy` records the pane-end mouth as the statement *"this row feeds its terminal"*, so a
   * selected person row painting one beside a selected agent row puts two mouths in one column,
   * each claiming a pane only one of them owns. But the mouth is only HALF of how `rowBox` says
   * that: `isActive` also SQUARES the pane-side corner, on a row that already bleeds
   * `-LIST_PAD_X` into the seam. Gating only the fillets is therefore worse than gating neither —
   * the row still runs under the seam with a hard edge and merely loses the construction that
   * renders that edge as an opening, which is the pale squared stub `rowGeometry` says the 26×9
   * fillet exists to end. So this feeds `rowBoxFor`'s `isActive` (via `claimsPane`) and the
   * fillets fall out of it: an unmounted selected row takes the IDLE radius and no mouths.
   *
   * The fill and `aria-selected` are unaffected: "the row you picked" is a true and separate
   * claim, and it is the whole of what selection means here today.
   */
  ownsPane: boolean;
  /** Same two geometry inputs every row in this column takes: the pair's side, and whether this
   *  pair holds the live cable. See `engine/rowGeometry` for what each end does. */
  paneSide: PairSide;
  jointOpen: boolean;
  /** Unread messages from this person. 0 → no badge at all. */
  unread: number;
  /** Takes the `socialId` rather than closing over it, so the list can hand every row ONE stable
   *  handler. A fresh arrow per row defeats the memo below completely — see `ChatSection`. */
  onSelect: (socialId: string) => void;
}

/** `React.memo`'d with primitives plus one frozen store object and a stable `onSelect`, for the
 *  same reason `SparkleAgentRow` is: one peer's availability flip must re-render one row, not the
 *  whole column. That only holds if the caller's `onSelect` really is stable — which is why the
 *  prop takes the id as an argument instead of being closed over per row. No hand-written
 *  comparator: the props are shallow-comparable by construction, which is exactly the property
 *  `agentRowPropsEqual` had to give up. */
export const PersonRow = memo(function PersonRow({
  person,
  isActive,
  ownsPane,
  paneSide,
  jointOpen,
  unread,
  onSelect,
}: PersonRowProps) {
  // THE JUNCTION IS ONE FACT, DERIVED ONCE, AND IT FEEDS BOTH HALVES OF THE PAINT.
  //
  // `rowBox` turns `isActive` into TWO things — the squared pane-side corner and the fillet ends —
  // and they are the same claim said twice: "this row runs into the pane." Gating only the fillets
  // (which is what the first cut of `ownsPane` did) is strictly worse than gating neither, because
  // the row still bleeds `-LIST_PAD_X` into the seam and still squares the corner, but drops the
  // construction that makes that edge read as an opening. `rowGeometry`'s own comment forbids
  // exactly that state — "the pane end is NEVER a radius … the mouth below does that work" — and
  // the result is the squared pale stub at the seam the 26×9 fillet was written to end.
  //
  // So the two are computed from ONE local. A selected-but-unmounted person row takes the IDLE
  // radius and no fillets: fill and `aria-selected` carry "you picked this", and nothing claims a
  // junction. `filletEnds` is then empty by construction, which is why the render site below can
  // read this same value rather than re-deriving the condition.
  const claimsPane = isActive && ownsPane;
  const box = rowBoxFor({ paneSide, jointOpen, isActive: claimsPane });
  const name = personName(person);
  const select = () => onSelect(person.socialId);

  // Enter and Space activate, and BOTH are prevented: Space on a focused non-button scrolls the
  // list, which would move the row out from under the user at the moment they picked it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    select();
  };

  return (
    <div
      role="treeitem"
      aria-selected={isActive}
      aria-label={personRowLabel(person, unread)}
      data-testid={PERSON_ROW_TESTID}
      data-social-id={person.socialId}
      // Roving-tabstop-free for now: the chat tree is its own tree (the build tree's `tabStopId` /
      // `renderedRowIds` ring is agent-shaped and must not be widened), so every row is reachable
      // by Tab until that ring exists here. A row that cannot be focused cannot be activated by
      // keyboard at all, which is the worse failure of the two.
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
      style={{
        flex: "0 0 auto",
        // The fillets are absolutely positioned against this box.
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        // THE SHARED RULE, not a second copy of it. Nothing here is conditional on `isActive`:
        // geometry belongs to every row, never only the selected one — a margin that changes on
        // selection narrows the content box under the pointer and the title jumps (the list-twitch
        // bug `rowGeometry`'s header records).
        margin: `0 ${box.marginRight}px 0 ${box.marginLeft}px`,
        padding: box.padding,
        cursor: "pointer",
        // Same selected fill the build rows use, and keyed on `isActive` rather than on
        // `claimsPane`: "you picked this row" is true whether or not the row owns the pane, and it
        // is the ONLY thing selection means here until U6. On a row that DOES claim the pane the
        // squared edge and the mouths do the heavy lifting and this step is reinforcement; on one
        // that does not, this and `aria-selected` are the whole of the signal.
        background: isActive ? C.forest : "transparent",
        borderRadius: box.borderRadius,
      }}
    >
      {/* The same fixed slot a build row gives its disc: fixed height so the title beside it sits on
          the glyph's line, fixed width with the glyph CENTERED so its left edge lands on the
          column's one vertical line. */}
      <div
        style={{
          flex: "0 0 auto",
          width: DOT_SLOT_W,
          height: GLYPH_SLOT_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PersonAvatar
          name={name}
          availability={person.availability}
          size={PERSON_ROW_AVATAR_SIZE}
          // The surface this row paints on, so the dot's ring separates it from the avatar fill.
          // `forest` while selected — the fill changes underneath it and a ring in the wrong colour
          // is a visible halo on exactly the row the user is looking at.
          ringColor={isActive ? C.forest : C.deepForest}
        />
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: GLYPH_SLOT_H,
        }}
      >
        <span
          data-testid="person-row-name"
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            // NEUTRAL INK and the column's one title size — the rule `SparkleAgentRow` records.
            // Colour in this column means STATUS; spending it on a name is what took the pinned row
            // years to undo.
            color: C.cream,
            fontSize: AGENT_NAME_FONT_SIZE,
            fontWeight: rowTitleWeight(isActive),
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {unread > 0 && (
          // `chip()`, the app's drawn count treatment (mono, tabular-nums, near-square corner), not
          // a hand-rolled capsule. `aria-hidden` because the row's own accessible name already says
          // "N unread" — a badge that announced itself would double up on every pass.
          <span
            aria-hidden
            data-testid="person-row-unread"
            style={{ flex: "0 0 auto", ...chip(C.accentInk) }}
          >
            {unread}
          </span>
        )}
      </div>
      {/* THE SAME COMPONENT a selected build row draws, not a copy — the mouths are what make the
          low-contrast fill step read as selection, so they are not decoration.
          `box.filletEnds` is ALREADY empty unless the row claims the pane (see `claimsPane` above),
          so this needs no condition of its own — and must not grow one, because a second copy of
          that rule is how the radius and the mouths would end up disagreeing, which is the exact
          half-gated state this row shipped for one commit. */}
      <ActiveFillets ends={box.filletEnds} paneSide={paneSide} />
    </div>
  );
});
