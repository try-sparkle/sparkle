// LIVE BLOCKERS ARE PINNED ABOVE THE COMPOSER. They are not chat messages and they do not scroll.
//
// ══ THE REPORT ═══════════════════════════════════════════════════════════════════════════════════
// Founder, 2026-08-07, verbatim: *"I want any sort of blocked notices to be right above the compose
// window. And not in line in the chat thread. So they should not flow upwards with the chat thread.
// If there is any real block notices, they should stay persistently above the composed window so
// that I see them regardless of how much the chat thread moves."*
//
// ══ WHY A CHAT MESSAGE WAS THE WRONG SHAPE ═══════════════════════════════════════════════════════
// A chat message is IMMUTABLE HISTORY AT A FIXED POSITION. A blocker is neither: it is live, and it
// stays relevant until it is resolved. Rendering it inline gave it both wrong properties at once —
// it went stale AND it scrolled out of sight. `engine/resolvedNudges` fixed the staleness half (bead
// `sparkle-9adzg`); this is the visibility half, and they are the same root error.
//
// So the split is now by KIND OF FACT, not by kind of item:
//   • a LIVE blocker  → pinned here, above the composer, never scrolls          (this file)
//   • a RESOLVED one  → a grey receipt in the transcript, where history belongs (NudgeCard)
//
// ══ WHAT MAY NOT REGRESS ═════════════════════════════════════════════════════════════════════════
// Sparkle's standing rule is that nothing which needs the founder may be hidden, and MOVING alerts
// is the gesture most likely to break it by accident. Two consequences are load-bearing here:
//
//   • THE STACK NEVER SWALLOWS THE COMPOSER. Several blockers at once is the normal case on a busy
//     fleet — the card wall that created `conciergeDigest` was twenty-seven of them. The zone is
//     height-capped and scrolls INSIDE itself, so the composer keeps its position no matter how many
//     are live. A pinned region that grew without bound would take the input surface off screen,
//     which is a worse failure than the one this fixes.
//   • [x] ACKNOWLEDGES **AND** LEAVES A CHIP. The founder's own answer: a dismissed-but-still-live
//     blocker "collapses to a quiet chip, never vanishes". Both halves are load-bearing and they
//     used to be in tension. `[x]` is still the app's per-episode acknowledgement — the same
//     transitive `dismissAlert` the inline card wrote, which is what calms the Build row and stops
//     the whack-a-mole where each dismissed rollup re-raised as its descendants (roborev
//     55986/56000). But acknowledging de-escalates the published band, so the agent falls out of
//     the live set and the row would simply VANISH from the one surface built so it cannot. The
//     chip is what closes that: the host keeps a snapshot of what was acknowledged and renders it
//     quietly here until the agent leaves the fleet or goes red again.
import { useCallback, useRef, useState, type CSSProperties } from "react";
import { FiBellOff, FiRefreshCw, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { RADIUS, TYPE } from "../../theme/scale";
import { AgentPill } from "./AgentPill";
import { NUDGE_DISMISS_ACTION, NUDGE_MUTE_ACTION, NUDGE_REDRAW_ACTION } from "./NudgeCard";
import type { ConciergeNudge } from "./types";

/** How a test finds the pinned zone. */
export const PINNED_BLOCKERS_TESTID = "concierge-pinned-blockers";
/** One entry, expanded — the full "BLOCKED: @agent in project" line. */
export const PINNED_BLOCKER_TESTID = "concierge-pinned-blocker";
/** One entry, ACKNOWLEDGED — the quiet chip a [x] leaves behind. Still names its agent. */
export const PINNED_BLOCKER_CHIP_TESTID = "concierge-pinned-blocker-chip";
/** The "BLOCKED:" word itself — how a test/probe finds it to check whether it is showing. */
export const PINNED_BLOCKER_LABEL_TESTID = "concierge-pinned-blocker-label";
/** The action button (Approve/Open) — how a test/probe finds it to check whether it is showing. */
export const PINNED_BLOCKER_ACTION_TESTID = "concierge-pinned-blocker-action";
/** The row's REASON sentence — what this blocker actually wants. See its render site for why a row
 *  without it is the concealment `docs/never-hide-actionable-rows.md` forbids. */
export const PINNED_BLOCKER_REASON_TESTID = "concierge-pinned-blocker-reason";
/** The Force-redraw control — see its render site, and `services/forceRedraw` for why a resize
 *  round-trip is the only repaint trigger that is safe on a screen the app refuses to type into. */
export const PINNED_BLOCKER_REDRAW_TESTID = "concierge-pinned-blocker-redraw";
/** Clear an acknowledged chip off the strip. The LAST removal gesture, and the only one that takes
 *  a blocker off this surface on purpose — see the header for why [x] is not it. */
export const PINNED_CLEAR_ACTION = "pinned-clear";

/** The lead word, identical to the inline card's so the two read as one vocabulary. */
const LEAD = "BLOCKED:";

// ══ THE ORDER OF SACRIFICE (founder, 2026-08-13, bead sparkle-jaq7n) ══════════════════════════════
//
// His own screenshot: at a narrow pane, the Approve button painted directly over the agent name.
// His framing: *"Maybe we don't show that button at all when it's too narrow... why don't you
// figure it out?"* — an invitation to design the degradation, not a literal spec. The rule applied
// here: elements must never overlap, and as the column narrows the row gives up the LEAST useful
// thing first.
//
//   1. widest    — dot, "BLOCKED:", the full agent name, the full Approve/Open button.
//   2. narrower  — "BLOCKED:" drops to just the dot. The word is the most redundant pixel in the
//                  row: the dot already carries the state, and `aria-label` on the row still says
//                  the word for anyone not reading it visually.
//   3. narrower  — the agent name ellipsizes (AgentPill's own truncation — see PILL_FENCE below).
//                  The button stays FULL SIZE: it is the point of the row, the one thing that
//                  actually unblocks the agent, so it is the last thing to give.
//   4. narrowest — only here does the button itself disappear, and ONLY because the ROW's own
//                  area is wired to fire the exact same action in that state (see the row's own
//                  `onClick`/`onKeyDown` below) — a block you can see but cannot act on would be
//                  worse than a cramped row. THE PILL IS A PURE CARVE-OUT, not a second approval
//                  path: every form it can render — the live button, a closed pill's disclosure
//                  toggle, the notice prose that toggle can reveal, its own "See what it did"
//                  button, or a fully inert unwired span — keeps ONLY its own honest behavior
//                  (open the agent, toggle an explanation, navigate to history, or nothing at
//                  all) and NEVER also triggers the approval; the fence around it exists solely to
//                  `stopPropagation()` so none of that bubbles up and double-fires the row's own
//                  handler. "The entire row remains clickable" is satisfied by the ROW's own area
//                  — its padding, the dot, the "in {project}" text — and by Enter/Space on the row
//                  itself, never by the pill sub-region. The name keeps its tooltip regardless
//                  (AgentPill already carries one — see `AgentPill`'s `title`), so a truncated
//                  name is always recoverable on hover.
//
// WHY MEASURED WIDTH RATHER THAN A CSS BREAKPOINT: this row lives in a COLUMN the user drags, not
// the window — a `@media` query cannot see it. Mirrors `ComposeBox.tsx`'s own `columnWidth`
// (ResizeObserver on the PARENT, not this element, for the same non-settling-loop reason spelled
// out there): observing THIS row's own box would have the row's collapse change the very width
// being measured.

/** Below this column width, "BLOCKED:" drops to just the dot — tier 2.
 *
 *  MEASURED, not guessed: `visual:blocked-row-narrow` was run with the label always shown, and the
 *  row stays overlap-free (the name simply ellipsizes further) all the way down to
 *  `PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX`. So this threshold is not load-bearing for
 *  containment — nothing breaks if it were 0 — it exists purely so the row does not spend its
 *  narrowing budget on the word before the name has had a chance to shrink at all. 260px leaves a
 *  comfortably legible name (`Sparkle Preview Agent Eyes` still reads past a dozen characters) at
 *  `CONCIERGE_DEFAULT_WIDTH` (360) and above, and starts shedding the label well before the name
 *  is squeezed to nothing.
 */
export const PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX = 260;

/** Below this column width, the Approve/Open button itself disappears — tier 4, the last resort.
 *
 *  MEASURED: `visual:blocked-row-narrow --widths=170,160,150,140` shows the row painting clean and
 *  contained with the button still full-size down to 150px; below that the dot + icon buttons +
 *  button's own min-content width no longer leave the name any room to ellipsize into, and the row
 *  starts to overhang. 140 is the highest multiple of ten under that floor, so this fires only
 *  where it has to.
 */
export const PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX = 140;

/** Does the row show the "BLOCKED:" word at this measured column width? `0` (not yet measured)
 *  reads as roomy, matching `ComposeBox.toolbarShowsLabels`'s convention — so the row does not
 *  flash collapsed before the first real measurement lands. */
export function pinnedBlockerShowsLabel(columnWidth: number): boolean {
  return columnWidth === 0 || columnWidth >= PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX;
}

/** Does the row show its Approve/Open button at this measured column width? Same "unmeasured
 *  reads as roomy" convention as {@link pinnedBlockerShowsLabel}. */
export function pinnedBlockerShowsButton(columnWidth: number): boolean {
  return columnWidth === 0 || columnWidth >= PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX;
}

/** What the ROW ITSELF does when activated (clicked, or Enter/Space on it): it OPENS THE AGENT.
 *  Always. At every width, with or without a visible button.
 *
 *  ══ THIS REVERSES AN EARLIER RULE, ON THE FOUNDER'S EXPLICIT INSTRUCTION (2026-08-20) ══════════
 *  It used to fire the APPROVAL when the button was hidden (below
 *  `PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX`), citing the founder's own earlier words: "only if
 *  the entire row remains clickable and lands on the same approval". Asked again, with that quote
 *  put back to him and the hazard named, he reversed it. So the quote is retired rather than
 *  contradicted in silence — it is preserved here because a file that simply dropped it would look
 *  like it had never been told.
 *
 *  WHY IT WAS WRONG: at a narrow column the button is invisible, so the row carries no visible
 *  affordance at all — and clicking a row is the gesture a human makes to INVESTIGATE it. That
 *  gesture then fired an irreversible one-tap relay into a live terminal, approving whatever the
 *  agent happened to be asking, which the human had by definition not read (the pane was not open;
 *  that is what they were clicking to do). A destructive action triggered by an investigative
 *  gesture is backwards, and it is worst precisely where the human has the least information.
 *
 *  THE APPROVAL IS NOT LOST, it is relocated to where it can only be pressed deliberately: open the
 *  agent, read the question, answer it there. Below the button threshold there is now no one-tap
 *  approve, and that is the intended trade — see the founder's answer, which chose exactly this over
 *  keeping the button at all widths.
 *
 *  THE SIGNATURE IS KEPT rather than inlined at the call site. Both parameters are now unused by the
 *  decision, and that is the point: the row's behaviour must not silently re-acquire a dependence on
 *  width or on which action a blocker happens to carry. A pure function with its own unit test is
 *  what makes "the row never approves" a property something can assert, and jsdom cannot assert it
 *  through rendering — it never lays out, so it never fires the ResizeObserver that drives
 *  `columnWidth`, leaving a rendered instance permanently stuck at the roomy default. */
export function pinnedBlockerRowActivation(
  _showButton: boolean,
  _primaryActionId: string | undefined,
): { kind: "action"; actionId: string } | { kind: "open" } {
  return { kind: "open" };
}

/** Roughly three expanded rows. Past that the zone scrolls rather than grows — see the header: the
 *  composer's position is not negotiable, and a busy fleet can produce a dozen of these at once. */
const MAX_ZONE_HEIGHT = 132;

const row = (): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  padding: "5px 9px",
  borderRadius: RADIUS.sm,
  border: `1px solid ${C.sienna}`,
  // NO GLOW, unlike the inline card. The card needed one to stand out from a scrolling transcript;
  // a pinned row is already the only thing that never moves, and a glow on a permanently-visible
  // strip reads as alarm fatigue rather than as urgency.
  background: "transparent",
  cursor: "pointer",
  // CLIP, NEVER ESCAPE — the containment floor below the last sacrifice tier. The zone's own
  // horizontal padding plus this row's padding can, at `CONCIERGE_MIN_WIDTH` (50px), leave less
  // room than the dot + mute + dismiss icons need even with the label, button, name and project
  // text all fully collapsed — measured via `visual:blocked-row-narrow`: without this, the mute
  // and dismiss buttons (pushed by `marginLeft: "auto"`) laid out tens of px past the row's own
  // box and past the column's right edge, invisible to a check that only compares the row's own
  // rect against the column's. Same principle `RecapCard`'s narrow cells use ("clip instead of
  // escaping"): below the floor where everything fits, the least-recently-sacrificed control is
  // clipped rather than painting into the composer or the next row.
  overflow: "hidden",
});

const chip = (): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
  maxWidth: "100%",
  padding: "2px 7px",
  borderRadius: RADIUS.sm,
  // MUTED, not sienna: the reader has said "I have seen this one". It stays legible and it stays
  // present — it just stops competing with the blockers they have not looked at yet.
  border: `1px solid ${C.muted}`,
  background: "transparent",
  cursor: "pointer",
  fontSize: TYPE.small,
  color: C.conciergeMuted,
});

const iconButton = (): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: 18,
  height: 18,
  padding: 0,
  border: "none",
  background: "transparent",
  color: C.conciergeMuted,
  cursor: "pointer",
});

/**
 * The pinned zone. Renders nothing at all when there is nothing live — an empty bordered strip
 * above the composer would be permanent furniture claiming the fleet is fine, which is a statement,
 * not a container.
 *
 * `acknowledged` is what `[x]` left behind — snapshots, not live feed items, because an acknowledged
 * agent has been de-escalated out of the live set and so is no longer derivable from the feed at
 * all. The host holds them for the same reason it holds the resolved ledger: the moment a card stops
 * being derivable, a card nobody remembered is a card that is gone.
 */
export function PinnedBlockers({
  blockers,
  acknowledged,
  onNudgeClick,
  onNudgeAction,
}: {
  blockers: ConciergeNudge[];
  acknowledged: readonly ConciergeNudge[];
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
}) {
  // A LIVE ENTRY WINS over its own acknowledged snapshot. An agent that went red again is loud
  // again — rendering both would state the opposite fact about one agent twice, and would duplicate
  // its React key.
  const live = new Set(blockers.map((b) => b.id));
  const shut = acknowledged.filter((a) => !live.has(a.id));
  const open = blockers;

  // ── HOW WIDE THE COLUMN IS — MEASURED OUTSIDE THIS ZONE, NOT INSIDE IT ─────────────────────────
  // Same technique and same reason as `ComposeBox.tsx`'s own `columnWidth`: this zone lives in the
  // concierge COLUMN, which the user resizes independently of the window, so window width cannot
  // answer "how much room does this row have". Observing the PARENT rather than this zone's own
  // root avoids a non-settling loop — this zone's box would itself change size the moment a tier
  // fires, which would move the very thing being measured.
  //
  // 0 means "not measured yet" and the tiers below read that as the roomy form (see
  // `pinnedBlockerShowsLabel`/`pinnedBlockerShowsButton`), so the row does not flash collapsed
  // before the first real measurement lands.
  const [columnWidth, setColumnWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  // A CALLBACK REF, NOT `useRef` + a `useEffect([])` — this component RETURNS NULL when there is
  // nothing live (the ordinary starting state: no blocker yet), so the div this ref names is not
  // in the DOM on first mount at all. A `useEffect([])` runs exactly once, on that first mount,
  // finds `rootRef.current` still `null`, and gives up for the lifetime of the component — so the
  // observer NEVER attaches on the transition that actually matters (idle → a blocker appears),
  // and every tier in this file is permanently inert in the ordinary case (roborev 64001). A
  // callback ref is invoked by React every time the underlying DOM node changes — including from
  // absent to present, on every open→null→open cycle a busy fleet produces — so re-attaching here
  // happens exactly when there is something to attach to, with no dependency array to get stale.
  //
  // `useCallback([])`, NOT AN INLINE ARROW (roborev 64032). React detaches and re-attaches a
  // callback ref whenever ITS OWN IDENTITY changes, not only when the DOM node changes — so an
  // inline arrow, which is a fresh function on every render, tore the observer down and rebuilt it
  // on every render of `PinnedBlockers`: every column-drag frame, and every unrelated re-render
  // from its parent (`ConciergeColumn.tsx`), not merely the mount transition this fix targets.
  // That did not visibly break anything only because `setColumnWidth`'s `prev === w ? prev : w`
  // guard swallowed the redundant callback each fresh observer immediately re-delivered on
  // `observe()` — but it is real, avoidable churn the empty dependency array below removes.
  const rootRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    const el = node?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setColumnWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  const showLabel = pinnedBlockerShowsLabel(columnWidth);
  const showButton = pinnedBlockerShowsButton(columnWidth);

  if (open.length === 0 && shut.length === 0) return null;

  return (
    <div
      ref={rootRef}
      data-testid={PINNED_BLOCKERS_TESTID}
      // THE MEASURED WIDTH, EXPOSED — purely so a probe/test can wait for the ResizeObserver to
      // have actually fired before reading the tier it produced. Without this, `visual:blocked-row-
      // narrow` raced the observer: `waitForFunction` on the harness's ready flag resolves after
      // two animation frames, which does not guarantee the observer's first callback has already
      // run, so the probe sometimes measured the row at its "unmeasured" (0 → roomy) default
      // regardless of the width under test.
      data-column-width={columnWidth}
      // A LANDMARK, not a log. `role="region"` with a name is what lets a screen-reader user jump to
      // it deliberately; `aria-live` would be wrong — this content persists rather than arriving,
      // and the column already has exactly one live region (see ConciergeColumn's announcer).
      role="region"
      aria-label={`${open.length} blocked`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "0 12px 6px",
        // THE CAP AND THE SCROLL ARE ONE MECHANISM — see the header. `maxHeight` alone would clip
        // the overflow silently, which hides a blocker rather than moving it.
        maxHeight: MAX_ZONE_HEIGHT,
        overflowY: "auto",
        flex: "0 0 auto",
      }}
    >
      {open.map((b) => {
        // TIER 4's WIRING — see {@link pinnedBlockerRowActivation}. `actions[0]` rather than a
        // "primary" kind lookup: today's producer (`services/nudgeActions`) emits at most one
        // action, and a future second one is still better served by the first (Approve/Open) than
        // by silently picking none.
        const activation = pinnedBlockerRowActivation(showButton, b.actions[0]?.id);
        const rowActivate = () =>
          activation.kind === "action" ? onNudgeAction(b, activation.actionId) : onNudgeClick(b);
        return (
        <div
          key={b.id}
          data-testid={PINNED_BLOCKER_TESTID}
          data-agent-id={b.id}
          role="button"
          tabIndex={0}
          // ONE ACCESSIBLE NAME AT EVERY WIDTH, because the row now does ONE thing at every width:
          // it opens the agent. This used to branch — below the button threshold the row fired an
          // irreversible Approve relay, and the name had to warn a screen-reader user about a
          // behaviour change they had no visual cue for (roborev 64058: "the behavior moved, the
          // string that narrates it did not"). That behaviour is gone (see
          // `pinnedBlockerRowActivation`), so the warning is gone with it rather than left standing
          // to describe a relay that no longer happens — which would be the same defect 64058
          // charged, pointing the other way.
          //
          // THE REASON IS DELIBERATELY NOT APPENDED HERE. It is rendered as its own text node inside
          // the row, so a screen reader reaches it by walking in; repeating it in the name would
          // read it twice.
          aria-label={`${LEAD} ${b.agentName} in ${b.projectName}`}
          onClick={rowActivate}
          onKeyDown={(e) => {
            // ONLY THE ROW ITSELF, matching NudgeCard: a keydown on the nested fold button bubbles
            // here, and preventDefault would cancel the button's own Enter/Space activation.
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            rowActivate();
          }}
          style={row()}
        >
          <span
            style={{ flex: "0 0 auto", width: 7, height: 7, borderRadius: "50%", background: C.sienna }}
            aria-hidden
          />
          {/* TIER 2: the word is the most redundant pixel in the row — the dot beside it already
              carries the state, and the row's own `aria-label` above still says "BLOCKED:" for a
              screen-reader user regardless of whether this renders. THE THEMED ink, not raw
              sienna: the accent is under the AA floor as TEXT on this column. Same split, and
              same reason, as the inline card's. */}
          {showLabel && (
            <strong
              data-testid={PINNED_BLOCKER_LABEL_TESTID}
              style={{ color: C.dangerInk, fontWeight: FONT_WEIGHT.bold, letterSpacing: "0.02em" }}
            >
              {LEAD}
            </strong>
          )}
          {/* A FENCE around the pill's own click, exactly as the inline card does it — without it
              one click runs the reveal twice. */}
          <span
            // NO explicit `flex` — deliberately left at its CSS default (`0 1 auto`: grow 0,
            // shrink 1, basis auto), which is what actually lets this box shrink and clip. An
            // earlier draft wrote `flex: "1 1 0%"` (roborev 63961): flex-grow:1 makes the fence
            // consume ALL positive free space at a roomy width, opening a gap between the name and
            // "in {project}" that does not exist today, and flex-basis:0% meant it got no shrink
            // allocation under negative free space, collapsing toward 0 before its sibling gave up
            // any width at all. Grow must stay 0. A LATER DRAFT then wrote `flex: "0 1 auto"`
            // explicitly (roborev 64018) — which is a no-op, since that IS the default every flex
            // item already has, and src/index.css sets no different default. Writing it out was
            // false documentation: it read as "grow-vs-shrink is guarded here" when nothing does.
            // `minWidth: 0` and `overflow: "hidden"` below are the two declarations that actually
            // do the work — the fix is that this box was left ALONE, not that it was configured.
            style={{ display: "inline-flex", minWidth: 0, overflow: "hidden" }}
            // A PURE CLICK SINK, NOT A SECOND APPROVAL PATH (roborev 64112, retiring two drafts —
            // 64079, 64095 — that tried to give this fence its own tier-4 fallback). This span has
            // no padding and no gap, and it holds exactly ONE flex child that always fills its
            // content box (the live pill's button, or the shipping disclosure form's inline
            // wrapper) — so there is no "fence's own bare space" a real pointer event can ever
            // land on; `e.target` is always some descendant of the pill, never the fence itself.
            // A fallback keyed on that condition was dead code that only a synthetic jsdom event
            // (which can set `target` to whatever it likes, unconstrained by real hit-testing —
            // docs/jsdom-test-caveats.md) could ever exercise.
            //
            // That is not a gap in the founder's "the entire row remains clickable" bar: this
            // fence covers only the narrow pill sub-region, and the REST of the row — its own
            // padding, the dot, the "in {project}" text, the gaps between every element — already
            // reaches the row's own `onClick` (nothing here stops THAT propagation from firing for
            // clicks outside this fence). What `stopPropagation` has to do is exactly what its
            // original comment above says: keep the pill's own click from ALSO bubbling into the
            // row's, which would double-fire whatever the pill did (open the agent, toggle a
            // disclosure, navigate to history) alongside an unrelated approval.
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <AgentPill agentId={b.id} fallbackName={b.agentName} onOpen={() => onNudgeClick(b)} />
          </span>
          <span
            style={{
              color: C.conciergeMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            in {b.projectName}
          </span>
          {/* ══ THE REASON, IN WORDS. A ROW THAT SAYS "BLOCKED" AND NOTHING ELSE IS CONCEALMENT ══
              This strip rendered the dot, the word BLOCKED, the agent name, the project and the
              buttons — and never once said WHAT WAS WANTED. The nudge has always carried that
              sentence (`engine/conciergeNudges.agentToNudge` builds `text`), but ConciergeHost
              deliberately routes live blockers here and OUT of the transcript, so `NudgeCard` — the
              only component that rendered `text` — never saw them. The founder's report is the
              exact shape of the gap: "You're showing it as blocked ... But there's nothing that it
              says it needs from me."

              `docs/never-hide-actionable-rows.md` is what this violates. Showing a row while
              withholding the one fact that makes it actionable is hiding it in the way that matters
              — the human is told to act and given nothing to act on.

              RENDERED AFTER "in {project}" and BEFORE the buttons, so the sacrifice order in this
              file's header still holds: it is the last text element, so it is the first to
              ellipsize as the column narrows, and it never competes with the agent name for width.
              Empty `text` renders nothing rather than an empty node — `agentToNudge` always fills
              it, but the type permits "" and a stray separator dangling after the project name
              would read as a rendering fault. */}
          {(b.reason ?? "").trim() !== "" && (
            <span
              data-testid={PINNED_BLOCKER_REASON_TESTID}
              style={{
                color: C.conciergeMuted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              — {b.reason}
            </span>
          )}
          {/* EVERY AFFORDANCE THE INLINE CARD CARRIED COMES WITH IT. Moving a surface must not
              quietly drop what could be done from it: Approve is a one-tap relay into a live
              terminal with no other home in the app, and Open is the cloud agent's substitute for
              it (`services/nudgeActions` picks which). A blocker you can see but no longer act on
              is a worse surface than the scrolling one it replaced.
              TIER 4: hidden ONLY below `PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX`, and only
              because `rowActivate` above wires the row's own click to the same action in that
              state — never hidden without that wiring, or the block would be un-actable. */}
          {showButton &&
            b.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={PINNED_BLOCKER_ACTION_TESTID}
                onClick={(e) => {
                  e.stopPropagation();
                  onNudgeAction(b, a.id);
                }}
                style={{
                  flex: "0 0 auto",
                  padding: "2px 8px",
                  borderRadius: RADIUS.sm,
                  border: `1px solid ${C.sienna}`,
                  background: "transparent",
                  color: C.dangerInk,
                  fontSize: TYPE.small,
                  fontWeight: FONT_WEIGHT.bold,
                  cursor: "pointer",
                }}
              >
                {a.label}
              </button>
            ))}
          {/* ══ FORCE REDRAW — THE RECOVERY ACTION ON A ROW WHOSE PANE SHOWS NOTHING ═════════════
              The founder: "we specifically need to get it to re render or whatever is required so I
              can actually do something." A row can insist it needs him while the pane behind it
              renders nothing readable; this makes the agent re-emit its current screen so the app
              can read it again and the question becomes answerable.

              AN ICON, NOT A LABELLED BUTTON, and `marginLeft: "auto"` moved onto it since it is now
              the first of the trailing control cluster. This strip's scarcest resource is width
              (see the sacrifice order in the header) and a second labelled button would compete
              with the agent name at every size. Mute already set the precedent for a control that
              earns its place at icon width.

              IT WRITES NO BYTES TO THE TERMINAL. `services/forceRedraw` changes the PTY window size
              and changes it back — SIGWINCH, not a keystroke. That distinction is the whole reason
              this is safe to offer here: every keystroke that would force a repaint is a WRITE into
              a terminal the app has just admitted it cannot read, and `esc` — the most tempting —
              DECLINES whatever is being asked. So this control does not weaken the alternate-screen
              refusal; it is the thing that makes honouring that refusal survivable.

              OFFERED ON EVERY ROW rather than only on ones detected as unreadable: the failure it
              rescues IS a detection failure, so gating it on detection would withhold it exactly
              when detection is what broke. */}
          <button
            type="button"
            data-testid={PINNED_BLOCKER_REDRAW_TESTID}
            aria-label={`Force ${b.agentName}'s terminal to redraw`}
            title="Force redraw — make this agent repaint its screen"
            onClick={(e) => {
              e.stopPropagation();
              onNudgeAction(b, NUDGE_REDRAW_ACTION);
            }}
            style={{ ...iconButton(), marginLeft: "auto" }}
          >
            <FiRefreshCw size={12} />
          </button>
          {/* MUTE, on the same handle as before. A durable preference about the AGENT rather than
              about this episode, and this strip is now its only call site — dropping it here would
              delete do-not-interrupt from the app. */}
          <button
            type="button"
            data-testid="concierge-nudge-mute"
            aria-label={`Mute alerts about ${b.agentName}`}
            title="Don't interrupt me about this agent"
            onClick={(e) => {
              e.stopPropagation();
              onNudgeAction(b, NUDGE_MUTE_ACTION);
            }}
            // NO `marginLeft: "auto"` ANY MORE — the Force-redraw button above is now the first of
            // the trailing cluster and carries it. Two auto margins in one flex row would put a gap
            // BETWEEN these icons rather than one gap before them both, spreading the cluster across
            // the row's free space and stealing exactly the width the agent name ellipsizes into.
            style={iconButton()}
          >
            <FiBellOff size={12} />
          </button>
          {/* THE SAME TESTID THE INLINE CARD USED, because it is the SAME GESTURE — the app's
              per-episode acknowledgement, writing the same transitive `dismissAlert`. Keeping the
              handle stable is what lets the cases that pin the rollup/subtree dismissal keep
              working across the move; a new id would have quietly orphaned them. */}
          <button
            type="button"
            data-testid="concierge-nudge-dismiss"
            aria-label={`Dismiss this alert about ${b.agentName}`}
            title="Acknowledge — it stays here as a chip"
            onClick={(e) => {
              e.stopPropagation();
              onNudgeAction(b, NUDGE_DISMISS_ACTION);
            }}
            style={{ ...iconButton() }}
          >
            <FiX size={12} />
          </button>
        </div>
        );
      })}
      {shut.length > 0 && (
        // The acknowledged ones share ONE wrapping row: a dozen of them should cost a line or two,
        // not a dozen. They stay in DOM order beneath the loud ones, so what the reader has NOT
        // looked at is always nearest the composer.
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {shut.map((b) => (
            <span
              key={b.id}
              data-testid={PINNED_BLOCKER_CHIP_TESTID}
              data-agent-id={b.id}
              // STILL SAYS BLOCKED. The chip is quieter, not vaguer — a reader scanning the strip
              // must be able to tell an acknowledged blocker from any other chip without opening it.
              aria-label={`${LEAD} ${b.agentName} in ${b.projectName} (acknowledged)`}
              style={chip()}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  // HOLLOW, like the resolved card's dot — the redundant signal for a reader who
                  // cannot separate two greys, or who has the two states in different themes.
                  boxSizing: "border-box",
                  background: "transparent",
                  borderStyle: "solid",
                  borderWidth: 1,
                  borderColor: C.muted,
                }}
                aria-hidden
              />
              {/* THE NAME STILL OPENS THE AGENT. Acknowledging says "I have seen this", not "I have
                  dealt with it" — the way to deal with it is to go there, and that has to stay one
                  click away or the chip is a dead end. */}
              <button
                type="button"
                onClick={() => onNudgeClick(b)}
                title={`Open ${b.agentName}`}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {b.agentName}
              </button>
              <button
                type="button"
                data-testid="concierge-pinned-clear"
                aria-label={`Clear ${b.agentName}`}
                title="Clear from this strip"
                onClick={() => onNudgeAction(b, PINNED_CLEAR_ACTION)}
                style={{ ...iconButton(), width: 14, height: 14 }}
              >
                <FiX size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
