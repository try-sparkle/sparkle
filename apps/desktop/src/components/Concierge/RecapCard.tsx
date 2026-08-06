// The return-from-Away card: "here's what happened while you were gone."
//
// IT CARRIES NO ACTION BUTTONS, which is the design decision most likely to look like an omission.
// Every agent this card names as needing you is ALREADY in the thread as a nudge card, with its own
// "Show me" / "Approve" buttons (ConciergeHost.surfacedAgents). Duplicating those buttons here would
// give the same agent two live action surfaces one scroll apart, which is how a user ends up
// approving the same thing twice. So this card summarises and the nudge cards act.
//
// IT IS NOT, HOWEVER, INERT — and this header used to say it was. The agent pills are clickable
// (they reveal), and the "+N more" line is a disclosure BUTTON that expands its section in place
// (bead `sparkle-ws8gd`). Neither acts ON an agent; both only bring you to what is already there,
// which is the line this card actually holds. "Summarises rather than acts" is the rule; "nothing
// here responds to a click" was a description that had already stopped being true.
//
// ══ NEVER HIDE A ROW THAT NEEDS ACTION ══════════════════════════════════════════════════════════
// The founder's rule, verbatim: "We should never hide a row that needs action from me."
//
// The section cap may only ever collapse rows that ask nothing — `status: "done"`, i.e. finished
// AND landed (see `isActionableChange` in services/conciergeRecap, which owns the test). Rows that
// owe the reader something — everything under WANTS YOU, plus "Done — your turn" (`idle`) and
// "Needs merge" (`unmerged`) — render in full, however many there are.
//
// CONSEQUENCE, AND IT IS INTENDED: this card can grow tall when a lot of agents want you. That is
// the correct failure direction. Do NOT reintroduce a cap to control height — if height ever
// becomes a real problem, make the card scroll. A short card that has hidden the thing you needed
// to do is worse than a long one, which is the bug this rule exists to close.
//
// NO LIVE REGION HERE. The summary is announced through the concierge column's existing single
// `role="status"` node, fed by the host (`announce`). A second region would double-announce — that
// was learned and fixed once already during the auto-routing work.
//
// Accent is the brand cyan rather than the nudge sienna: this is not itself an alarm. It is a
// briefing that may CONTAIN alarms, and painting it red would make every return from lunch look
// like an incident.
import { useState, type CSSProperties } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { C, CARD_WASH_PCT, FONT_WEIGHT } from "../../theme/colors";
import { AgentPill } from "./AgentPill";
import {
  isActionableChange,
  recapSummary,
  type ConciergeRecapMessage,
  type GateDecision,
  type RecapChange,
} from "../../services/conciergeRecap";

const accent = C.accentInk;

/** `index.css`'s clip utility: `overflow: hidden` upgraded to `overflow: clip` under `@supports`.
 *
 *  A CLASS RATHER THAN AN INLINE `overflow`, and the reason is not style. `clip` clips without
 *  making the box a SCROLL CONTAINER, which matters here because these cells sit on a
 *  `align-items: baseline` flex line — a scroll container's alignment baseline is synthesised from
 *  its border box rather than taken from its text, so clipping the wrong way moves the cell against
 *  the line it is on. But `clip` is WebKit 16+ and `tauri.conf.json` still declares
 *  `minimumSystemVersion: "11.0"`, where the declaration is DROPPED — leaving `overflow: visible`,
 *  which takes `text-overflow: ellipsis` with it and puts the overflow straight back. `@supports`
 *  has no inline form, so the only way to have both is the class. Never also set `overflow`
 *  inline on these cells: it would win over the class and silently undo the upgrade.
 *
 *  Same constant and same reasoning as `AgentPill`'s `NAME_CLIP_CLASS`. */
const CLIP_CLASS = "clip-no-scroll";

const sectionLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: FONT_WEIGHT.bold,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: C.conciergeMuted,
  marginTop: 10,
  marginBottom: 4,
};

// ── THE ROW REFLOWS RATHER THAN OVERFLOWING (bead sparkle-kk9dg.1) ──────────────────────────────
// It used to be `display:flex; gap:6` with no wrap, and that combination could not fit its own
// contents. Each row is a `flex:none` project chip, an AgentPill (`white-space:nowrap`, so its
// min-content size is its FULL width and a flex item's default `min-width:auto` made it
// unshrinkable), and a muted status like "Done — your turn". The status was therefore the only
// child that could give, so it collapsed to its min-content width and stacked ONE WORD PER LINE —
// a ~150px-tall row — while the pill still overhung the card's right edge and was clipped mid-word.
//
// THIS WAS ALREADY WRONG AT THE 360px DEFAULT, not only when the column was dragged narrow.
// "@Concierge Says What It Is Doing" is ~190px at 12px, plus a ~55px project chip, ~105px of status,
// 26px of card padding and 12px of gaps — about 390px of content in a 360px column. Narrowing the
// column merely made an existing overflow impossible to miss.
//
// THE FIX IS `flex-wrap`, and the reason it is the right lever rather than a media query is that
// flexbox LINE-BREAKS BEFORE IT SHRINKS. So the founder's hybrid falls out for free at every width:
// wide, all three children fit on one line exactly as before; narrow, the status leaves the line
// WHOLE (it is `flex:0 0 auto; white-space:nowrap`, so it can neither shrink nor wrap word-by-word)
// and sits under the pill; very narrow, once the pill alone is wider than the line it is the only
// thing left to give and ellipsizes ("@Concierge Say…") while staying clickable.
//
// The gap is a ROW/COLUMN PAIR: 2px between wrapped lines, the original 6px between children on a
// line. A single `gap: 6` would inherit that 6px vertically too, so a reflowed row would open up a
// gap wider than the leading of the text it separates.
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  flexWrap: "wrap",
  gap: "2px 6px",
  fontSize: 12,
  color: C.cream,
  padding: "2px 0",
};

/** The chip and the pill as ONE flex item, so the wrap can only ever fall between the pill and the
 *  status — which is exactly the founder's hybrid and nothing else.
 *
 *  WITHOUT THIS NESTING THE ROW BREAKS IN THE WRONG PLACE, and it is not obvious from the source
 *  that it would: flexbox decides line breaks from each item's FLEX BASE SIZE, before any shrinking.
 *  With chip, pill and status as three siblings, a pill whose base size is ~202px does not fit
 *  beside a ~55px chip in a 254px content box, so the PILL wrapped to a line of its own and the
 *  status to a third — measured at 3.36 line-heights in a real browser at 280px. Grouping the chip
 *  with the pill gives the group one base size, so the only break point left is before the status.
 *
 *  `flex: "0 1 auto"` — basis stays at the group's max-content width, which is what forces the
 *  status off the line rather than squeezing the pill (line-breaking happens BEFORE shrinking, so a
 *  basis of 0 here would produce the always-one-line-truncate layout the founder rejected).
 *  `minWidth: 0` is what then lets the group shrink below the nowrap pill's min-content size once
 *  it IS alone on the line. */
/*  `flexWrap: "wrap"` IS THE LAST RESORT INSIDE THE GROUP, and it costs nothing above ~135px
 *  (roborev 58700). The chip is `flex: none` by the founder's decision — it is KEPT at every width —
 *  so at a ~24-100px content box the chip and the pill cannot share a line at all, and without a
 *  wrap here the pill was laid out starting past the chip and painted 16-22px outside the card. A
 *  wrap lets the pill take the line below the chip instead, which is legible and contained.
 *
 *  It cannot fire while both fit, because flexbox only breaks a line that has run out — so at 200px
 *  and above the group is still the single unbreakable unit the paragraph above describes, and the
 *  only break available to the ROW is still the one before the status. That is measured: the probe's
 *  "no change row exceeds 2.5 lines" and "a row that no longer fits moved its STATUS to its own
 *  line" both still pass at 520/360/280/200. Below `HYBRID_MIN_WIDTH` the row is allowed the extra
 *  line — see that constant in the probe for why containment, not the line budget, is the contract
 *  down there. */
const leadCell: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  flex: "0 1 auto",
  minWidth: 0,
  flexWrap: "wrap",
};

/** The pill's own item inside that group. `minWidth: 0` is the whole point — it defeats the
 *  `min-width: auto` floor that a nowrap pill would otherwise sit at, which is what lets the pill
 *  ellipsize at the very narrow end instead of overhanging the card. It is the pill rather than the
 *  `flex:none` chip that gives, which is why the project chip survives at every width.
 *
 *  A ZERO BASIS (`1 1 0%`) RATHER THAN `0 1 auto`, AND ONLY BECAUSE OF THE GROUP'S OWN WRAP
 *  (roborev 58700). `leadCell` has to be allowed to break internally at the extreme narrow end, or
 *  the pill is laid out starting past an unshrinkable chip and paints outside the card. But a wrap
 *  is decided from FLEX BASE SIZES, so with the pill's basis at its max-content (~202px) the group
 *  broke at 280px too — chip on one line, pill on the next, the exact wrong-place break the group
 *  exists to prevent, measured at 3.60 line-heights. A zero basis always fits, so the break can only
 *  happen once the chip ALONE has filled the line, which is the extreme band and nothing above it.
 *
 *  `flex-grow: 1` is not optional with a zero basis: without it the pill would be laid out at 0 and
 *  never take back the space it is entitled to. Growing is bounded by the group, which is itself
 *  `0 1 auto` and so never wider than its content — so at every width where things fit, the pill is
 *  exactly as wide as its text, and the measured row heights are unchanged (1.28 lines at 520,
 *  2.29 at 360/280/200 — identical before and after).
 *
 *  This is the same reasoning `decisionProse` already records one cell down, arrived at from the
 *  other direction: a basis that never fits costs a line. */
const pillCell: CSSProperties = {
  fontWeight: FONT_WEIGHT.semibold,
  flex: "1 1 0%",
  minWidth: 0,
};

/** The status text. `flex: "0 0 auto"` + `nowrap` is what makes it move as a UNIT: it may not
 *  shrink, so when it no longer fits beside the pill the wrap takes it to the next line whole,
 *  rather than compressing it to its min-content width and stacking "Done — your turn" one word per
 *  line (which is what shipped).
 *
 *  …AND THAT UNSHRINKABILITY IS ALSO WHY IT NEEDS CONTAINING (roborev 58700). Between
 *  `CONCIERGE_MIN_WIDTH` (50) and roughly 135px the status CANNOT stay inside the card by
 *  construction: it is ~105px of nowrap text with `flex: 0 0 auto` in a content box that has shrunk
 *  to ~24-109px, so once it is alone on its own wrapped line it still does not fit — and the card
 *  has `maxWidth: 100%` with no clipping of its own, so it escaped into the thread. The OLD code
 *  kept it inside at those widths by collapsing it to min-content and word-stacking it, which means
 *  the reflow traded a word-stack for the very overflow it exists to remove, in a band nothing
 *  measured. `maxWidth: 100%` + the clip + `textOverflow` make it ellipsize inside the card instead.
 *
 *  `minWidth: 0` IS LOAD-BEARING FOR THAT, not decoration: a flex item's `min-width: auto` floor is
 *  its min-content size, which for nowrap text is the WHOLE string — and min-width beats max-width,
 *  so without this the `maxWidth: 100%` above would simply be ignored.
 *
 *  NORMAL WIDTHS ARE BYTE-IDENTICAL. `maxWidth: 100%` is larger than the status at every width
 *  where it fits, and `flex-shrink: 0` still forbids the shrink that provoked the word-stack, so
 *  this engages only in the extreme band. The clip comes from the class, never inline — see
 *  `AgentPill`'s `NAME_CLIP_CLASS` for why (`@supports` has no inline form, and `clip` alone is
 *  dropped on the Big Sur WebKit `tauri.conf.json` still supports, taking the ellipsis with it). */
const statusCell: CSSProperties = {
  color: C.conciergeMuted,
  flex: "0 0 auto",
  whiteSpace: "nowrap",
  maxWidth: "100%",
  minWidth: 0,
  textOverflow: "ellipsis",
};

/** The "What I did" rows are the same shape one row over — a `flex:none` verb, then everything else
 *  — and they contain a pill too, so they break the same way and the founder sees them in the same
 *  card. This is the prose half.
 *
 *  `flex: "1 1 0%"` RATHER THAN `"0 1 auto"`, and the difference is a whole wasted line. This span
 *  is a SENTENCE, so its max-content width is the entire sentence — as a flex base size that never
 *  fits a narrow column, which would push the prose onto its own line and leave "Held for you"
 *  sitting alone on the first one. A basis of `0` always fits, so the prose starts beside its verb
 *  and wraps INSIDE itself, which is what prose is supposed to do. That is the opposite of the
 *  choice `statusCell` makes, and deliberately: a status is a label that must move as a unit, a
 *  decision is a sentence that must flow.
 *
 *  `minWidth: 0` for the same reason as everywhere else here — the nowrap pill embedded in the
 *  sentence would otherwise set an unshrinkable floor for the whole span. */
const decisionProse: CSSProperties = {
  color: C.conciergeMuted,
  flex: "1 1 0%",
  minWidth: 0,
};

/** The decision's leading verb. `flex: "none"` because "Sent" and "Held for you" are opposite facts
 *  and the verb is what the line is FOR — it may not be the thing that gives.
 *
 *  Contained for the same reason `statusCell` and `projectChip` are (roborev 58700): unshrinkable is
 *  not the same as unbounded, and below ~135px "Held for you" would otherwise word-stack and then
 *  paint outside the card. `nowrap` keeps it one unit, the clip and the ellipsis keep that unit
 *  inside the line. Nothing changes at any width where it fits. */
const decisionVerbCell: CSSProperties = {
  fontWeight: FONT_WEIGHT.semibold,
  flex: "none",
  whiteSpace: "nowrap",
  maxWidth: "100%",
  minWidth: 0,
  textOverflow: "ellipsis",
};

// The project name, at the smallest type on the card. INK IS `conciergeMuted`, NOT `C.amber`
// (roborev 53631-M4): amber is brand-constant across themes, and as 9.5px text on this card — an
// accent wash over `conciergeSurface` — it lands at 1.8:1 light / 3.3:1 dark against a 4.5:1
// requirement. `conciergeMuted` is the ink tuned for this column (theme/colors.ts, roborev
// 46254-L). Amber survives as the BORDER, which is a fill and legible as one — the same ink/fill
// split this card's sibling PresenceSlider now makes explicit. NudgeCard's identical chip moved
// with it, so the two cards don't disagree one scroll apart.
//
// KNOWN RESIDUAL: muted lands at 4.34:1 dark / 4.08:1 light on this card — better than amber by
// far, still shy of AA — because the wash moves the surface off the shade conciergeMuted was tuned
// against. That is true of every muted string on the card, not just this chip, so it belongs to the
// card's surface. Measured in theme/amberInk.test.ts; tracked in PRD/sparkle/concierge-presence.md.
//
// CONTAINED THE SAME WAY THE STATUS IS, and for the same reason (roborev 58700). `flex: none` is
// the founder's decision — the chip is KEPT at every width, so it may not shrink — but "may not
// shrink" and "may paint outside the card" are different things, and at a ~24px content box a ~55px
// chip does the second. `maxWidth: 100%` + `minWidth: 0` + the clip + the ellipsis bound it to the
// line it is on without touching what it does at any width where it fits. `whiteSpace: nowrap`
// keeps a two-word project name from word-stacking on the way there, which is the failure this
// card's status cell already exists to prevent one column over.
const projectChip: CSSProperties = {
  fontSize: 10,
  color: C.conciergeMuted,
  border: `1px solid color-mix(in srgb, ${C.amber} 40%, transparent)`,
  borderRadius: 4,
  padding: "1px 5px",
  flex: "none",
  maxWidth: "100%",
  minWidth: 0,
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

/** What the concierge did on your behalf, in the user's words. The `kind` is the whole point of the
 *  line — "I sent this" and "I held this back" are opposite facts — so it leads. */
function decisionVerb(kind: GateDecision["kind"]): string {
  switch (kind) {
    case "sent":
      return "Sent";
    case "queued":
      return "Held for you";
    case "cancelled":
      return "Cancelled";
    default: {
      // Exhaustiveness guard, matching the pattern the dispatch refusal taxonomy uses: a new
      // decision kind on the sibling branch must fail to compile here rather than render blank.
      const unhandled: never = kind;
      void unhandled;
      return "Did";
    }
  }
}

/**
 * SETTLED rows per section before the rest collapse into a count.
 *
 * READ THIS WITH `isActionableChange`, NOT ON ITS OWN. The cap no longer applies to a section's rows
 * — it applies only to the rows that ask nothing (`status: "done"`, finished AND landed). An
 * actionable row is never counted against it and never collapsed, however many there are, because
 * the founder's rule is that a row needing action is never hidden.
 *
 * WHAT THIS MEANS IN PRACTICE, stated plainly because the number below now does much less than it
 * looks like it does: `done` is the comparatively rare status and `idle` ("Done — your turn") is the
 * ordinary finish, so on the very case this cap was written for — a night away, thirty agents
 * finished — most rows are actionable and this collapses little or nothing.
 *
 * THE HEIGHT PROTECTION THEREFORE DOES NOT LIVE HERE ANY MORE. It is `maxHeight` + `overflowY` on
 * the card container (see the note there): the card scrolls rather than hiding, which keeps the
 * compose box on screen without putting an ask behind a click. This docblock used to claim "nothing
 * is lost by capping" — true when the cap was a display detail over rows the summary already
 * counted, and false the moment the rows it ate could carry work.
 *
 * Five is retained for the settled remainder: enough to recognise WHICH fleet moved, and the summary
 * sentence still carries the totals.
 */
const SECTION_CAP = 5;

/** The overflow line — A DISCLOSURE BUTTON, not a caption.
 *
 *  IT USED TO BE AN INERT `div`, and that is the bug (bead `sparkle-ws8gd`). The founder pointed at
 *  it and said two words: *"The '+11 more'"*. The terseness was the signal — flat grey text,
 *  visually identical to the muted captions around it, offering no way in. It announced that eleven
 *  things existed and gave no means of seeing them, on a card that had just claimed "16 finished".
 *
 *  SO IT LOOKS LIKE A CONTROL NOW, and that half matters as much as the behaviour: a chevron that
 *  turns, the cream ink the card uses for live text rather than the muted ink it uses for asides,
 *  and a pointer cursor. A control the reader cannot recognise is not a control.
 *
 *  `aria-expanded` is honest here in a way it is not on `AgentPill`'s retry button: this genuinely
 *  toggles both ways, so advertising it as expandable promises nothing it cannot do.
 *
 *  The night-away case this cap exists for overflows ALL THREE sections at once, so three bare
 *  "+7 more" lines need telling apart TWICE OVER, by two different readers (roborev 53655-M /
 *  53665-M / 53674-M): `data-section` is for the tests, and the section name is spoken via a
 *  VISUALLY HIDDEN span. That was originally needed because a bare `div` maps to ARIA's `generic`
 *  role, where name-from-author is PROHIBITED — so an `aria-label` was dropped by conforming
 *  browsers and invisible to exactly the users it was for. A `<button>` DOES take a name from the
 *  author, so the hidden span is no longer load-bearing for that reason — it is kept because it is
 *  what the tests and screen readers already read, and content is still the reliable carrier.
 *  Sighted users get the same fact from the heading directly above. */
function MoreLine({
  n,
  word,
  section,
  label,
  expanded,
  onToggle,
}: {
  n: number;
  word: string;
  section: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? FiChevronDown : FiChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="recap-more"
      data-section={section}
      style={{
        ...rowStyle,
        // A control, not an aside: the card's live ink rather than the muted ink of a caption.
        color: C.cream,
        border: "none",
        background: "transparent",
        font: "inherit",
        fontSize: 12,
        cursor: "pointer",
        textAlign: "left",
        // `rowStyle` is `align-items: baseline`; a button defaults to `center` and would sit the
        // chevron off the text it labels.
        alignItems: "baseline",
        width: "100%",
      }}
    >
      {/* An ICON, never a glyph typed into the string — this repo bans emoji-as-icons and uses
          react-icons/fi (Feather) for exactly this. `flex: none` so the narrow-column reflow never
          shrinks the one part that says "this opens". */}
      <Chevron size={12} aria-hidden style={{ flex: "none", alignSelf: "center" }} />
      <span>
        {expanded ? "Show fewer" : `+${n} ${word}`}
      </span>
      {/* Same clip-rect shape as the column's announcer (ConciergeColumn) — this codebase has no
          sr-only utility, and inventing a second one would be the thing that drifts. */}
      <span
        data-testid="recap-more-section"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {" "}
        in {label}
      </span>
    </button>
  );
}

/** Wraps a section's rows so the cap logic and the disclosure state live in ONE place rather than
 *  being re-derived by each caller. `hidden` is what the cap collapsed; `shown` is everything else,
 *  in the ORIGINAL order — the cap removes rows, it never reorders them, so an expanded section
 *  reads the same as an uncapped one. */
function useDisclosure(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(false);
  return [expanded, () => setExpanded((v) => !v)];
}

function ChangeSection({
  label,
  changes,
  section,
  onRevealAgent,
}: {
  label: string;
  changes: RecapChange[];
  section: string;
  onRevealAgent?: (agentId: string) => void;
}) {
  const [expanded, toggle] = useDisclosure();
  if (changes.length === 0) return null; // a section with nothing in it is a heading and a gap

  // ── THE CAP MAY ONLY EAT SETTLED ROWS ─────────────────────────────────────────────────────────
  // "We should never hide a row that needs action from me." So the overflow is computed over the
  // NON-ACTIONABLE rows alone: every actionable row is shown no matter how many there are, and only
  // settled ones past the cap can collapse. `isActionableChange` owns the test (see its docblock in
  // services/conciergeRecap) — this file must not re-decide it by reading the rendered label, which
  // is prose and gets reworded.
  //
  // ORDER IS PRESERVED. `hidden` is a set of ids removed from the original list rather than a
  // partition that hoists actionable rows to the top, so expanding a section reproduces exactly the
  // uncapped card instead of reshuffling it under the reader.
  const settled = changes.filter((c) => !isActionableChange(c));
  const hiddenIds = new Set(settled.slice(SECTION_CAP).map((c) => c.agentId));
  const shown = expanded ? changes : changes.filter((c) => !hiddenIds.has(c.agentId));
  return (
    <>
      <div style={sectionLabel}>{label}</div>
      {shown.map((c) => (
        <ChangeRow key={c.agentId} change={c} onRevealAgent={onRevealAgent} />
      ))}
      {hiddenIds.size > 0 && (
        <MoreLine
          n={hiddenIds.size}
          word="more"
          section={section}
          label={label}
          expanded={expanded}
          onToggle={toggle}
        />
      )}
    </>
  );
}

function ChangeRow({
  change,
  onRevealAgent,
}: {
  change: RecapChange;
  onRevealAgent?: (agentId: string) => void;
}) {
  return (
    <div style={rowStyle} data-testid="recap-change" data-status={change.status}>
      {/* The chip and the pill travel together — see `leadCell` for why the row cannot be three
          flat siblings without breaking in the wrong place. */}
      <span data-testid="recap-change-lead" style={leadCell}>
        <span className={CLIP_CLASS} style={projectChip}>
          {change.projectName}
        </span>
        {/* A PILL, not a bold span. This card is app-authored prose naming a build agent, and the
            rule is that every such mention is clickable — a recap that tells you three agents want
            you and then makes you go find them in the column is only half a recap. `RecapChange`
            has carried `agentId` all along, so nothing had to be threaded here.

            The card sits inside the thread, hence inside `AgentPillProvider`; a pill outside that
            provider degrades to plain prose, which is exactly what this was. */}
        <span data-testid="recap-change-pill-cell" style={pillCell}>
          <AgentPill
            agentId={change.agentId}
            fallbackName={change.agentName}
            onOpen={onRevealAgent ? () => onRevealAgent(change.agentId) : undefined}
          />
        </span>
      </span>
      <span data-testid="recap-change-status" className={CLIP_CLASS} style={statusCell}>
        {change.statusLabel}
      </span>
    </div>
  );
}

export function RecapCard({
  recap,
  onRevealAgent,
}: {
  recap: ConciergeRecapMessage;
  onRevealAgent?: (agentId: string) => void;
}) {
  return (
    <div
      data-testid="concierge-recap"
      style={{
        alignSelf: "stretch",
        maxWidth: "100%",
        // ── PROSE MAY BREAK MID-WORD RATHER THAN PAINT OUTSIDE THE CARD (roborev 58700) ─────────
        // Every containment rule on the cells below bounds an ELEMENT box; this bounds a TEXT RUN,
        // which nothing else here can. Below ~135px the card's content box is narrower than single
        // words in its own summary sentence ("While you were away — 12m: 1 needs you…"), and a word
        // that does not fit its line overflows it by default — invisibly to a box measurement, since
        // no element's rect grows. That is exactly how it was found: at 135px the card scrolled
        // horizontally with not one element past the content edge.
        //
        // INHERITED, so it covers the summary, the section headings and the decision prose in one
        // declaration rather than three that can drift. It changes NOTHING at any width where the
        // words fit — `anywhere` only breaks where there is no other break opportunity — and it does
        // not reach the nowrap cells (a box that suppresses line breaking has nowhere to apply it).
        //
        // `anywhere` rather than `break-word` deliberately: `break-word` is ignored when computing
        // min-content, so a flex/grid item sized from its content would keep the unbroken word's
        // width as a floor and overflow anyway.
        overflowWrap: "anywhere",
        // ── THE CARD IS BOUNDED, THE ROW SET IS NOT (roborev 59105) ────────────────────────────
        // `SECTION_CAP` may now only collapse SETTLED rows, and `done` is the rare status while
        // `idle` ("Done — your turn") is the ordinary finish — so on the very case the cap was
        // written for (a night away, thirty agents finished) almost every row is actionable and the
        // cap collapses nothing. Uncapped, that card pushes the chat off screen above the compose
        // box, which is exactly the failure the cap existed to prevent.
        //
        // So the height is bounded HERE instead, which is the founder's own instruction for this
        // situation: "If height becomes a real problem, make the card scroll rather than hide."
        // Scrolling keeps every actionable row REACHABLE — the rule is that nothing is hidden
        // behind a click, and a scroll container hides nothing; it just does not paint it all at
        // once. That is categorically different from "+N more", which required a click to learn
        // that the rows even existed.
        //
        // `vh` rather than a pixel constant so it scales with the window, and it is a MAX: a short
        // card is untouched, and `overflow-y: auto` shows no scrollbar until there is something to
        // scroll. 60% leaves the summary, the thread above and the compose box below all visible.
        maxHeight: "60vh",
        overflowY: "auto",
        background: `color-mix(in srgb, ${accent} ${CARD_WASH_PCT}%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
        borderRadius: 6,
        padding: "12px 13px",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        {recapSummary(recap)}
      </div>

      <ChangeSection
        label="Wants you"
        changes={recap.needsYou}
        section="needsYou"
        onRevealAgent={onRevealAgent}
      />
      <ChangeSection
        label="Finished"
        changes={recap.finished}
        section="finished"
        onRevealAgent={onRevealAgent}
      />

      <DecisionSection decisions={recap.decisions} onRevealAgent={onRevealAgent} />
    </div>
  );
}

/** "What I did" — the concierge's own actions, and the one section whose rows ask NOTHING of the
 *  reader: they are a record of what already happened. So the never-hide-an-action rule does not
 *  bite here and the plain cap stands; the line is expandable anyway, because a "+N earlier" that
 *  cannot be opened is the same dead end the change sections just stopped being. */
function DecisionSection({
  decisions,
  onRevealAgent,
}: {
  decisions: ConciergeRecapMessage["decisions"];
  onRevealAgent?: (agentId: string) => void;
}) {
  const [expanded, toggle] = useDisclosure();
  if (decisions.length === 0) return null;
  // Capped from the OTHER end than the change sections, and the marker leads rather than trails.
  // Decisions arrive oldest-first because the card reads as a narrative, but the ones you can still
  // do something about are the most RECENT — a cancelled deploy from two minutes ago must not be
  // the line that got dropped.
  const shown = expanded ? decisions : decisions.slice(-SECTION_CAP);
  return (
    <>
      <div style={sectionLabel}>What I did</div>
      {decisions.length > SECTION_CAP && (
        <MoreLine
          n={decisions.length - SECTION_CAP}
          word="earlier"
          section="decisions"
          label="What I did"
          expanded={expanded}
          onToggle={toggle}
        />
      )}
      {shown.map((d) => (
        <div key={d.id} style={rowStyle} data-testid="recap-decision" data-kind={d.kind}>
          <span className={CLIP_CLASS} style={decisionVerbCell}>
            {decisionVerb(d.kind)}
          </span>
          <span data-testid="recap-decision-prose" style={decisionProse}>
            {d.summary} —{" "}
            <AgentPill
              agentId={d.agentId}
              fallbackName={d.agentName}
              onOpen={onRevealAgent ? () => onRevealAgent(d.agentId) : undefined}
            />
          </span>
        </div>
      ))}
    </>
  );
}
