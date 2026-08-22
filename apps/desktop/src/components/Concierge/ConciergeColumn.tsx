// The Concierge column shell — the persistent left column that is the user's cross-project
// minder (PRD/sparkle/concierge-mode.md; look/feel from the canonical prototype). Fixed-width
// flex column on the deepForest sidebar surface: header (one row carrying the Sparkle.ai mark top-
// left and the remaining-credit pill top-right, then the voice waveform and scope + vitals), the
// chat thread, and the compose box. Verdana per the approved design — the concierge deliberately
// doesn't share the workspace's UI font.
//
// The THREAD is purely presentational: everything in it comes from the ConciergeViewModel and every
// gesture leaves through the ConciergeController (see ./types). The two BRAND-CHROME pieces in the
// header — the voice waveform and the credit badge — are the deliberate exception: they moved here
// from the builder column (PRD/sparkle/concierge-chrome-and-credits.md) and read their own stores,
// exactly as they did there. Routing them through the view-model would have meant teaching the
// concierge's data layer about the mic and the entitlement for no gain; the column stays a pure
// renderer of everything it is actually GIVEN.
import { useMemo, type ReactNode } from "react";
import { CONCIERGE_COLUMN_DND_TARGET } from "../../services/dndTargets";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { C } from "../../theme/colors";
import { useResolvedTheme } from "../../theme/theme";
import { bandColor } from "../../engine/statusBandLabels";
import { BalanceBadge } from "../BalanceBadge";
import { LogoWaveform } from "../LogoWaveform";
// From its own module, NOT from `../LogoWaveform`: ~40 suites mock that component wholesale, and a
// module mock is total — a constant re-exported from there is `undefined` in every one of them.
import { WAVE_HEIGHT } from "../waveGeometry";
import { SparkleLogoLink } from "../SparkleLogoLink";
import { ComposeBox } from "./ComposeBox";
import { PinnedBlockers } from "./PinnedBlockers";
import { PreviewCards } from "./PreviewCards";
import { ConciergeAiLocked } from "./ConciergeAiLocked";
import { ConciergeUnavailable } from "./ConciergeUnavailable";
import { useConciergeAiLock } from "./conciergeAiLock";
import { ConciergeThread } from "./ConciergeThread";
import { ThreadScrubber } from "./ThreadScrubber";
import type { ThreadScrubberController } from "./useThreadScrubber";
import { MountedAgentThread } from "./MountedAgentThread";
import { MountedNotice } from "./MountedNotice";
import { MountedAgentNotices } from "./MountedAgentNotices";
import { ConciergeTopRight } from "./KebabMenu";
import { WindowSpanButton } from "./WindowSpanButton";
import { PipelineHealthChip } from "./PipelineHealthChip";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { BeadPillHost } from "./BeadPill";
import { KeyPill } from "./KeyPill";
import { formatBinding } from "../../keyboardHints/keybindings";
import { useKeybindingsStore } from "../../stores/keybindingsStore";
import { pillStyle } from "./pillStyle";
import { wordmarkRamp } from "./wordmarkRamp";
import type {
  ConciergeAnnouncement,
  ConciergeColumnProps,
  ConciergeMessage,
  ConciergeNudge,
} from "./types";
import { FONT_UI, TYPE } from "../../theme/scale";
// The SAME dot the sidebar row draws, so the chip and the row cannot disagree about what
// green/gray/red mean — the chip exists to report how that agent is doing (bead sparkle-wj3ya).
import { StatusDot } from "../StatusDot";

/** Nothing announced yet. Module-level so the default prop is referentially stable. */
const EMPTY_ANNOUNCEMENT: ConciergeAnnouncement = { seq: 0, text: "" };

/** Nothing acknowledged. Module-level for the same reason as the line above: a fresh `[]` in the
 *  JSX would be a new identity on every render, so every memoised consumer downstream would see a
 *  changed prop on a tick where nothing changed. */
const EMPTY_ACKNOWLEDGED: ConciergeNudge[] = [];

/** LogoWaveform carries its own 14px side padding (it used to be a direct child of the builder
 *  column, which had none). Pull it back out so the bars line up with the column's own inset
 *  instead of sitting inset by strip-padding + its own. */
const WAVEFORM_INSET = -14;

/** `--hd-h` — the ONE header height in the cockpit. The concierge's header row and a pair's build
 *  header are the same height, which is what lets the eye read across the shell at that line. */
const HEADER_H = 34;

/** HOW FAR THE CREDIT PILL'S BACKDROP REACHES PAST ITS OWN GLYPHS, in px — the gutter that keeps
 *  the dictation waveform off the balance.
 *
 *  Founder, at a narrow concierge column (bead sparkle-kk9dg.3): "The dictation waveform runs right
 *  up against '$9972.67' with no separation."
 *
 *  MEASURED at a 190px column: `BalanceBadge` paints a filled pill with `padding: 3px 9px` and the
 *  overlay below hugged it EXACTLY — zero padding of its own — so the blurred region and the badge's
 *  own fill had the same edge. The bars therefore ran sharp right into that edge, and a 7px blur
 *  confined to a box that starts where the ink starts blurs nothing a reader can see. The blur was
 *  never wrong; it simply had no room to do its job.
 *
 *  Padding on the OVERLAY rather than on the badge, because the overlay is the box carrying
 *  `backdrop-filter`: widening it is what extends the softened region outward, and it costs the
 *  waveform nothing (the pill is absolutely positioned — see its render site).
 *
 *  THE BLUR IS THE WHOLE REASON, and it is the only one — this used to read "`backdrop-filter` and
 *  the drop shadow", which stopped being true the moment the gutter pushed the shadow off the pill
 *  and it was deleted (roborev 58712). A rationale resting on a property the box no longer has is
 *  the same defect as a comment describing geometry the code no longer has.
 *
 *  DO NOT "SIMPLIFY" THIS TO A SOLID FILL. The column's background floods on `data-wired`, so a
 *  scrim in a fixed colour is wrong half the time; the whole point of a backdrop blur is that it is
 *  background-agnostic. Widening the blurred region is the move that respects that. */
const CREDIT_BACKDROP_GUTTER = 10;

/** The blur radius over the moving bars, in px. It was 7 and that reads as "no separation" at a
 *  narrow column, where the bars run the full strip and reach the pill. Judged by eye in a real
 *  capture at 190px and 280px, light and dark — not derived from a number. */
const CREDIT_BACKDROP_BLUR = 14;

/** `--t-title` — the wordmark's type size. The mask is sized by HEIGHT alone (its width follows the
 *  asset's aspect), so this is the mark's height rather than a font-size. */
const WORDMARK_H = 17;

/** WHERE THE LIFTED COLUMN SITS IN THE STACK — above the pairs, so its shadow falls ON them, and
 *  strictly BELOW `PULL_TAB_RAIL_Z`.
 *
 *  That second half is not tidiness. The pull tab is ~17px wide centred in a 6px rail, so it
 *  OVERHANGS this column by ~5px; a column that outranks the rail paints over that overhang and
 *  swallows its hit area, leaving the seam control with part of its chrome and part of its click
 *  target gone. This was `6` when the lift landed and did exactly that (roborev 54712). The two
 *  values are asserted against each other in ConciergeColumn.wired.test.tsx, so neither can be
 *  bumped back into the other without a red test. */
export const CONCIERGE_LIFT_Z = 3;

/** The "ESC to unmount" hint's handle — shown ONLY while the cable is patched. Exported so the
 *  suite identifies it structurally rather than by matching the copy, which is expected to be
 *  reworded. See its render site for why it is gated and not merely styled. */
export const CONCIERGE_UNMOUNT_HINT_TESTID = "concierge-unmount-hint";

/** The "Chatting with ● <Agent>" chip's handle — shown ONLY while the cable is patched, on the same
 *  row as the unmount hint (bead sparkle-wj3ya). Exported so the suite identifies it structurally
 *  rather than by matching copy, exactly like its neighbour above. */
export const CONCIERGE_CHATTING_WITH_TESTID = "concierge-chatting-with";

// rev4's `.pill` MOVED to ./pillStyle — the PR badge one slot over needs the same box, and the
// founder asked for it as a chiclet matching this one rather than as a second chip shape.

/**
 * THE 8-DOT DRAG GRIP — `.grip` in MAPPING.md, 4×2 dots.
 *
 * It moves the concierge between the sides of the shell, which is a thing only the shell can do —
 * so this reports the gesture and renders nothing about the outcome, like every other control in
 * this column. Rendered only when a handler is supplied: a grip with nowhere to drag to is an
 * affordance that lies (the same rule the needs-you pill follows one slot over).
 *
 * A BUTTON, not a bare drag surface. The gesture the mock draws is a drag, but a drag-only control
 * is unreachable by keyboard and by assistive tech, and there are exactly two destinations — so
 * activating it moves the column to the other side and the drag is the enhancement, not the
 * contract.
 */
function ConciergeGrip({ onMoveSide }: { onMoveSide: () => void }) {
  return (
    <button
      type="button"
      data-testid="concierge-grip"
      aria-label="Move the concierge to the other side"
      title="Move the concierge to the other side"
      onClick={onMoveSide}
      style={{
        display: "grid",
        // 4 columns × 2 rows of dots — the mock's grip, which reads as a drag handle at a size
        // where an icon would not.
        gridTemplateColumns: "repeat(4, 2px)",
        gridAutoRows: "2px",
        gap: 2,
        flex: "0 0 auto",
        padding: 4,
        border: "none",
        background: "transparent",
        cursor: "grab",
        color: "inherit",
      }}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{ width: 2, height: 2, borderRadius: "50%", background: C.conciergeMuted }}
        />
      ))}
    </button>
  );
}

/**
 * THE SCRUBBER RAIL'S PASS-THROUGH — declared HERE rather than added to `ConciergeColumnProps`.
 *
 * `Concierge/types.ts` is the shared contract file and is edited on several branches at once; three
 * optional props that this column only forwards do not need to be in it, and putting them there
 * would put a merge conflict between this feature and every sibling branch that touches the model.
 * Everything below is straight through — the column composes none of it.
 */
export interface ConciergeScrubberProps {
  /** Older turns paged in from durable history, rendered above the live thread (ConciergeThread). */
  backlog?: ConciergeMessage[];
  /** The rail itself. The ORCHESTRATOR mounts `<ThreadScrubber>` here once both halves of bead
   *  sparkle-7m719 have merged; this column only reserves the slot and hands it down. */
  rail?: ReactNode;
  /** Scroll the thread to this message id. `{ id, seq }` so the same dot picked twice scrolls
   *  twice — see ConciergeThread's prop doc. */
  jumpRequest?: { id: string; seq: number };
  /**
   * The rail's controller — markers, scope, position, `onSeek`/`onPick`.
   *
   * MOUNTED at the `rail` prop below. Carried as a prop rather than reached for with
   * `useThreadScrubber()` here so there is exactly ONE controller instance for the column and the
   * host — two would fetch twice and disagree about `position` and `now`.
   *
   * `rail` still wins when given, so a test (or a future surface) can put its own thing in the
   * gutter without going through the controller.
   */
  scrubber?: ThreadScrubberController;
}

export function ConciergeColumn({
  model,
  controller,
  width = 380,
  searchSlot,
  prSlot,
  interim = "",
  registerInsert,
  onTextEdit,
  announcement = EMPTY_ANNOUNCEMENT,
  countdownSlot,
  approvalSlot,
  wired = "off",
  mountedAgent = null,
  routableMountedAgentId = null,
  mountedNotice = null,
  mentionAgents,
  preferredAgentId,
  copyOnSelection = true,
  autoSend,
  sendMode,
  onSendModeChange,
  autoSendOn,
  onAutoSendChange,
  trayInert,
  pttHeld,
  onComposedText,
  onMentionComposing,
  onPasted,
  onComposeInteraction,
  registerSubmit,
  onOpenAgent,
  onSeeAgentHistory,
  backlog,
  rail,
  jumpRequest,
  // Spread into `<ThreadScrubber>` at the `rail` prop below.
  scrubber,
}: ConciergeColumnProps & ConciergeScrubberProps) {
  // Why the paid half isn't running, or null when it is. Like the two brand-chrome pieces in the
  // header, this reaches for its own stores rather than the view-model (see ./conciergeAiLock).
  const aiLock = useConciergeAiLock();
  // Concrete hex for the three spec values with no CSS var of their own — the wordmark's two ends,
  // the terminal register this column floods to, and the lift it drops when it does. See
  // theme/blueprintSpec for why they are not in THEME_HEX, and ./wordmarkRamp for the ramp.
  const mode = useResolvedTheme();
  const isWired = wired !== "off";
  // ══ THE LOCK SELLS THE BRAIN; IT MUST NOT CONFISCATE THE CABLE (bead sparkle-voudj7) ══════════
  // THE FOUNDER'S REPORT: *"I don't have any terminal typing area."* Mounted, this column offered
  // him NO input surface of any kind — not a refusal he could read, not a disabled box, nothing.
  //
  // `aiLock && isWired` was a KNOWN state, described in four separate comments in this file, each
  // ending "and THERE IS NO COMPOSER AT ALL". Every one of them treated that as a fact to route
  // around — gate the neighbour off too, so nothing points at a composer that isn't there — and
  // none asked whether the composer should have been gone in the first place. It should not have
  // been, and `conciergeAiLock`'s own header says so: *"Only the CHAT (the paid `claude -p` brain)
  // and the tools hang off this."* The implementation took the composer as well.
  //
  // WHY THAT IS A BUG AND NOT A STRICTER READING OF THE PAYWALL: mounted, this box is not the paid
  // brain. The cable is patched by a sidebar row click, and what the human types then goes to their
  // OWN agent's PTY through `dispatchConciergeAnswer` — a keystroke relay that costs nothing, calls
  // no model, and is not a feature anyone is being sold. Locking it takes away the ability to talk
  // to a process they are already running, which no lock reason ("flag off", "not bought", "out of
  // credits") is a justification for.
  //
  // WHAT GUARDS THE PAID HALF NOW, STATED EXACTLY (roborev 64206/64231 — the first cut of this
  // comment overclaimed and the correction is the interesting part). The `@Sparkle` escape hatch is
  // the only path from this box to the brain, and it is gated by `startConciergeTurn`, which
  // refuses on `conciergeAiEnabled()` before spawning anything.
  //
  // THAT GATE IS NOT THE SAME RULE AS THIS LOCK, and the difference is deliberate rather than a
  // gap to close. `aiGate` treats the concierge as SUBSCRIPTION-FUNDED — `flag && (entitled ||
  // credits)` — while this lock also wants credits. `conciergeTools/policyBinding` says why in as
  // many words: "the concierge turn runs on the user's own Claude Code subscription and costs
  // Sparkle nothing, so a Sparkle balance cannot answer it". So an ENTITLED user with no balance
  // can still use the escape hatch from a mounted column, and should — a credit gate there was
  // removed on purpose, and an attempt to re-impose it here was reverted (see `askSparkle`).
  //
  // This lock therefore governs what the column RENDERS, not what may RUN. What is restored below
  // is the terminal relay, which neither rule was ever about.
  //
  // UNMOUNTED, NOTHING CHANGES. With no cable there is no PTY to relay to, so the column is the
  // paid brain and only the paid brain — it still floods to `ConciergeAiLocked` with no composer,
  // exactly as before.
  const lockBlanksColumn = aiLock !== null && !mountedAgent;
  // THE SECOND WAY OUT, named on screen (bead sparkle-thm9o). Subscribed to the LIVE binding rather
  // than formatted from `SHORTCUT_DEFAULTS`: `unmountCable` is rebindable in ⋯ Settings → Shortcuts,
  // and a hint naming a chord the user has since changed sends them to a key that does nothing —
  // which is the same failure as the Escape-only hint it is here to repair.
  const unmountChord = formatBinding(useKeybindingsStore((s) => s.bindings.unmountCable));
  const needsYou = model.vitals.needs_you;
  // The roster every agent pill in a concierge reply resolves against. MEMOIZED because it is a
  // context value: a fresh object each render would re-render every pill in the thread on every
  // keystroke in the compose box, which is the exact cost `<Markdown>`'s memo exists to avoid.
  // `mentionAgents` is already memoized upstream, so this changes only when the fleet does.
  const agentPills = useMemo<AgentPillContextValue>(
    () => ({
      agents: mentionAgents ?? [],
      // PASSED THROUGH UNDEFINED when the column has no reveal path wired, rather than defaulted to
      // a handler. Neither a silent no-op nor a `() => false` is right: the first is the dead click,
      // and the second makes the pill announce that a perfectly live agent is closed. Absent means
      // absent, and the pill renders inert prose for it (roborev 55548).
      onOpenAgent,
      onSeeHistory: onSeeAgentHistory,
    }),
    [mentionAgents, onOpenAgent, onSeeAgentHistory],
  );
  return (
    <section
      aria-label="Sparkle concierge"
      // The hit-test handle for the host's window-global drag listener (services/dndTargets). It
      // sits on the WHOLE column, not on the compose box: a file dropped anywhere over the
      // concierge attaches to the next prompt, and the box below paints the affordance showing
      // where it will land.
      data-dnd-target={CONCIERGE_COLUMN_DND_TARGET}
      // `data-wired` — the WHOLE connection feature, as one value, exactly as MAPPING.md requires:
      // every visual consequence below follows from it rather than from scattered component state.
      // It is mirrored onto the element so the state is inspectable in the running app and
      // assertable in a test without reading a style.
      data-wired={wired}
      style={{
        position: "relative",
        flex: "0 0 auto",
        width,
        // ── FULL HEIGHT, AND DELIBERATELY HEIGHT-AGNOSTIC ────────────────────────────────────
        // The concierge runs the full height of the window in the cockpit and has lost its project
        // tabs — tabs belong to the build+terminal PAIR now, since build and terminal are one
        // project and the concierge is not any project at all. What the column must NOT do is
        // hard-code that height: `Workspace` owns the shell's layout and is a concurrent worker's
        // file this pass, so this fills whatever box it is given and nothing here has to change
        // when the tabs move above the pairs.
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        // ── A LAYOUT ROOT, SO THE BLINKING CARET STOPS RE-LAYING-OUT THE WHOLE APP ────────────
        // This column owns the compose box, which owns the caret, and a caret is not a passive
        // thing: WebKit's `OpacityCaretAnimator` recomputes the caret RECT on every animation
        // frame, and `recomputeCaretRect` → `VisiblePosition::canonicalPosition` calls
        // `Document::updateLayout()` — a SYNCHRONOUS, DOCUMENT-WIDE layout flush. A `sample` of the
        // v0.103.0 renderer during the founder's 3-10s input lag put 15.1% of the main thread in
        // exactly that chain (7694 samples; see PRD/sparkle/renderer-input-lag.md), 12.9% of it
        // inside `RenderView::layout()` running ~50 nested levels of `RenderBlock::simplifiedLayout`
        // / `RenderFlexibleBox::layoutBlock` and bottoming out in `TextUtil::width()` measuring
        // glyphs one at a time.
        //
        // THE CARET IS THE VICTIM, NOT THE CAUSE. `updateLayout()` is cheap when layout is clean;
        // it cost 12.9% because something else in the shell dirties layout every frame (65 live
        // agent rows with ticking timers, panes streaming PTY output). Without containment a dirty
        // box marks its containing blocks all the way up to the `RenderView`, so ANY dirt anywhere
        // makes the caret's next flush re-lay-out EVERY column. `contain: layout` makes this
        // section its own layout root: dirt inside it stops here, and dirt outside it cannot reach
        // in. The agent sidebar column carries the same declaration for the same reason.
        //
        // WHY THIS IS BEHAVIOURALLY INERT HERE, which is the whole reason it is safe to apply to a
        // column this heavily commented. Layout containment does exactly four things, and this
        // element already had three of them:
        //   • independent formatting context — already, via `display: flex`;
        //   • stacking context — already, via `position: relative` + `zIndex` below;
        //   • containing block for ABSOLUTELY positioned descendants — already, via `position:
        //     relative`;
        //   • containing block for FIXED positioned descendants — the one real change.
        // So the only way this can regress anything is a `position: fixed` descendant, which would
        // be re-anchored to this ~360px column instead of the viewport. There is none: the palette
        // is mounted by `Workspace`, NOT inside this section, and `QuoteChiclet` /
        // `ConciergeSuggestions` are `createPortal`'d out of the tree. That is an invariant a later
        // change could break silently, so it is asserted rather than trusted — see
        // ConciergeColumn.containment.test.tsx.
        //
        // NOT `contain: strict` or `contain: paint`. Paint containment CLIPS descendants to the
        // border box, and this column paints a `boxShadow` outside its own box (the lift, below) —
        // the same trap the agent rows' `content-visibility` gate documents at AgentRow.tsx, where
        // paint containment would have squared off the fillets. Size containment would collapse the
        // column to zero. Layout is the one that buys the layout root and nothing else.
        //
        // NOT ON THE TERMINAL PANES, deliberately: panes render `position: fixed` surfaces that
        // exist to cover THIS column, and containing them would cap those to the pane. See the
        // `isolation: isolate` note in layers.ts and the `terminal-stage` note in Workspace.
        contain: "layout",
        // ── LIFT AT REST, FLOOD WHEN WIRED ───────────────────────────────────────────────────
        // UNWIRED it LIFTS: a soft shadow and NO colour change, so it reads as a layer above the
        // pairs. WIRED it DROPS FLUSH — loses the shadow and takes the TERMINAL's colour, which is
        // what says "this column is now one end of that cable". The two are alternatives: a
        // shadow AND a colour change would read as two unrelated effects rather than as one
        // control being plugged in.
        // UNWIRED takes `conciergeSurfaceLifted`, not `conciergeSurface`. The comment above says
        // "no colour change" and that was the design's own wording — but it was written for LIGHT,
        // where the column is #ffffff and a shadow is the only move available. In DARK the column
        // sat on exactly the ground colour, so the lift shadow had nothing to lift OFF and the
        // unplugged concierge read as one more dark column beside the build columns. The lifted
        // token is +16.3% L* in dark and IDENTICAL to `conciergeSurface` in light, so light is
        // untouched and the "shadow, not colour" reading still holds wherever it was ever true.
        background: isWired ? BLUEPRINT[mode].term : C.conciergeSurfaceLifted,
        boxShadow: isWired ? "none" : BLUEPRINT[mode].lift,
        // Above the pairs while it is lifted, so the shadow falls ON them rather than under them —
        // but BELOW the pull tab's rail. See CONCIERGE_LIFT_Z.
        zIndex: CONCIERGE_LIFT_Z,
        transition: "background .24s ease, box-shadow .24s ease, color .24s ease",
        // THE COLUMN'S EDGE, not a wash of one. This was `color-mix(muted 25%, transparent)` — a
        // quarter-strength tint, which on light mode's near-white planes is very nearly nothing.
        //
        // WHY THIS SEAM KEEPS A RULE WHILE THE BUILDER↔TERMINAL SEAM DROPPED ONE: nothing crosses
        // this boundary. The concierge column is a closed surface, so a 1px rule costs nothing and
        // buys an edge that does not depend on the fill step at all. The sidebar's seam removed its
        // rule because the ACTIVE ROW has to bleed through it into the terminal.
        //
        // That is a difference in what the seam has to DO, not in how big its step is — do not
        // re-derive it from a contrast number in either direction, and do not write one here. Two
        // review rounds went on exactly that: a stale ratio, then a corrected ratio that will go
        // stale the next time the ramp moves. The two seams are not even the same size in light,
        // and the rule is still the same for both. It lives beside the plane tokens in theme/colors;
        // chromeContrast holds the measurements.
        //
        // `hairline` is the token whose whole job is a 1px rule that must be SEEN, and it is held
        // to the chrome floor on every plane in both themes.
        //
        // ── …EXCEPT IT DOESN'T ANY MORE. THE RULE IS GONE IN EVERY STATE. FOUNDER CALL. ──────
        // EVERYTHING ABOVE IS THE ARGUMENT FOR A RULE THIS BOUNDARY NO LONGER GETS. It is kept
        // because the reasoning is sound and worth reading — "nothing crosses this seam, so a line
        // costs nothing" was true when the concierge was a closed surface on the same plane as the
        // ground. It is superseded, not wrong.
        //
        // THIS BORDER WAS THE VERTICAL LINE THE FOUNDER REPORTED THREE TIMES. It was written
        // unconditionally, so it painted in every state. Several rounds of seam work moved the
        // SIDEBAR's border (index.css, `[data-wired]`) and reported the seam fixed; none of them
        // touched this one, because it lives in a different file and reads as the concierge's own
        // edge rather than as half of a shared boundary. That is precisely why it survived every
        // previous fix — the line on screen was never the border being moved.
        //
        // Removed OUTRIGHT rather than suppressed while wired: the third instruction was to take
        // the concierge-side rule off the build columns "in both light and dark mode", mounted or
        // not. index.css does the same to the sidebar's facing edge; the two together are the
        // whole boundary.
        //
        // MEASURED, not eyeballed — and the measurement does NOT say "separation by fill".
        //
        // MOUNTED: the flooded column is `term` and the build column is `bridge`, 1.083:1 apart in
        // dark. Already continuous, so this 1px rule WAS the entire visible line, and continuity is
        // the point — the columns are meant to read as one circuit.
        //
        // UNMOUNTED: the column carries its own plane (`conciergeSurfaceLifted`, +16.3% L* in dark)
        // AND the `lift` shadow. It is the SHADOW that separates it. The fill step alone measures
        // 1.107:1 against `deepForest` — UNDER `EDGE_MIN_CONTRAST` (1.2) — so do not read the
        // lighter plane as having taken over the boundary, and do NOT drop `boxShadow` below on
        // that theory: it is the only thing left holding this edge apart.
        //
        // Said explicitly because the opposite claim was written here first. `chromeContrast.test.ts`
        // pins both halves (the fill step stays under the floor; the lift exists in both themes),
        // and its own header records that every previous version of this mistake shipped under a
        // comment asserting the separation held.
        //
        // `transparent` rather than dropping the declaration: `box-sizing: border-box` is global
        // and this column has an explicit `width`, so the border sits INSIDE that box. Removing it
        // would widen the content box by 1px and shift the thread. Keep the 1px, paint nothing.
        borderRight: "1px solid transparent",
        // The flood takes the TERMINAL's ink register with its plane — the two are a pair in the
        // spec (`--k-term` / `--k-term-ink`) and separating them would put shell ink on a terminal
        // surface. Set on the section so everything that inherits follows it in one place.
        color: isWired ? BLUEPRINT[mode].termInk : C.cream,
        fontFamily: FONT_UI,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {/* ── `.ahd` — ONE ROW ────────────────────────────────────────────────────────────────────
          wordmark · 8-dot grip · needs-you pill · PR/merge slot · span shortcut · avatar · kebab.

          The founder asked for this consolidation explicitly, and the reason it is worth a whole
          restructure is that the shell used to SCATTER these: the credit pill shared a row with the
          mark, the avatar and kebab lived over in the project tabs bar, and there was no global
          "just show me what needs me" control anywhere. Gathering them costs one row of header
          height — the column's scarcest space, since everything below it is the thread — and it
          puts every cross-project control in the one column that is about every project.

          AND THE ROW IS OTHERWISE SILENT (bead sparkle-ircc3). A scope/vitals line used to sit
          between the grip and the pill — "All projects · 2 here · 1 in mobile", "Pinned to <name> ·
          all calm" — and the founder asked for it gone TWICE, the second time about the pinned
          variant: "It should only be showing the red dot pill when there are issues. It shouldn't
          say anything else next to the sparkle logo." So the CALM state is the wordmark alone, and
          the needs-you pill is the one thing allowed to appear beside it. Do not reintroduce a
          status line here in any width — the previous fix made it narrower rather than absent,
          which is what earned the second ask. `ConciergeColumn.header.test.tsx` pins the row's
          whole `textContent` in the calm, alarm and pinned cases.

          Pinning is still VISIBLE, just not here: the pinned project's tab carries a solid,
          45°-rotated, `C.accentInk` pin held at full opacity while every other tab's is hidden
          until hover (ProjectTabs.tsx, `.concierge-tab-pin[data-pinned="true"]`).

          Nothing here is a second rendering of something that exists elsewhere. The avatar and
          kebab ARE `ConciergeTopRight`, and the count comes off the same view-model the thread
          does. */}
      <div
        data-testid="concierge-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: HEADER_H,
          flex: "0 0 auto",
          // The containing block for anything a header slot drops BELOW the row.
          //
          // THE PR MENU'S PANEL IS NO LONGER SUCH A THING, and this says so rather than leaving the
          // claim to rot. It used to anchor here and span the header (`left: 8; right: 8`), which
          // is what made every field in it — the Merge button, the branch, the reason a PR is red —
          // narrower than the column. It portals to the root layer and clamps to the WINDOW now
          // (see `panelPlacement` in ../OpenPrMenu.tsx), so it neither reads this box nor is
          // contained by it. Two consequences worth stating: this `position: relative` is kept for
          // any FUTURE slot rather than because something needs it today, and the column's own
          // `zIndex: CONCIERGE_LIFT_Z` stacking context no longer caps that panel's layer — which
          // it silently did, at 3, for as long as the panel lived in here.
          position: "relative",
          // Asymmetric, per the mock: the right edge keeps clearance so the kebab never sits under
          // the column's pull tab.
          padding: "0 20px 0 10px",
          borderBottom: `1px solid ${isWired ? BLUEPRINT[mode].termHair : C.hairline}`,
        }}
      >
        {/* THE WORDMARK, ramping DARK → LIGHT left to right and ending on a lighter blue. The paint
            is a per-theme TOKEN PAIR rather than a fixed order of `ink` and `primary`, because
            which of those two is the darker one flips between themes — see ./wordmarkRamp and the
            assertions in theme/blueprintSpec.test.ts. It replaces the gold SHEEN this header used
            to carry: Blueprint retired gold entirely, so a gold glint was the last gold left on
            screen. Still the same masked asset and the same accessible name. */}
        <SparkleLogoLink height={WORDMARK_H} fill={wordmarkRamp(mode)} />
        {/* SEARCH, BESIDE THE MARK — the founder's ask, verbatim: "I want the search to be up next
            to the Sparkle.ai logo." It used to sit two strips lower (below this row AND below the
            voice/waveform strip), which put the app's only global search behind the one control
            nobody scrolls to.

            IMMEDIATELY AFTER THE WORDMARK, and that adjacency is the requirement rather than mere
            ordering — "next to" is the whole instruction. It stays `flex: "0 0 auto"` so the row's
            single growing child is still `concierge-header-spacer`; a growing search box here would
            split the slack and drag the right-hand cluster back toward the mark, which is the exact
            regression that spacer was added to prevent (roborev 57364).

            The control itself rests as a bare magnifier in this row — see `PaletteTrigger`'s
            `compact` note for why the header form may not spell out the word "Search". */}
        {searchSlot && (
          <div data-testid="concierge-header-search" style={{ flex: "0 0 auto", display: "flex" }}>
            {searchSlot}
          </div>
        )}
        {controller.onMoveSide && <ConciergeGrip onMoveSide={controller.onMoveSide} />}
        {/* THE ROW'S ONLY FLEXIBLE CHILD, and the reason it is an empty box rather than nothing.
            The deleted scope line carried `flex: "1 1 auto"` and was the one item here that could
            give way; every remaining child is fixed-size (`ConciergeGrip` is `flex: "0 0 auto"`,
            the PR slot and `ConciergeTopRight` size to their content) and this row sets no
            `justifyContent`. So deleting the line without replacing its GROWTH packs the whole row
            left: the PR chip, the avatar and the kebab leave the right edge and crowd up against
            the wordmark, with dead space beside them — the opposite of what the founder asked for
            (roborev 57364).

            A spacer rather than `marginLeft: "auto"` on the right cluster, because the pill in
            front of it is CONDITIONAL: hang the auto margin on the first right-hand element and the
            row re-packs left in exactly the calm state this bead is about. This box is
            unconditional, states nothing, and is `aria-hidden` so it adds no accessible node.

            CAUGHT BY PHOTOGRAPHING THE HEADER, not by the suite — and that is the lesson worth
            keeping. Every assertion the scope-line deletion added is about TEXT (`textContent`,
            absent testids), and none of them can see where a box SITS, so the regression was fully
            green. The testid above exists so that is no longer true. */}
        <div data-testid="concierge-header-spacer" aria-hidden style={{ flex: "1 1 auto", minWidth: 0 }} />
        {/* THE GLOBAL NEEDS-YOU FILTER — the red pill. It focuses every open column at once, where
            a build column's own chips filter only themselves; that split is why it lives here and
            not there.

            RENDERED WHEN THERE IS SOMETHING TO FILTER **OR** THE FILTER IS ENGAGED. The second
            clause is the one that matters and it was missing: `vitals.needs_you` is the SCOPED
            count and is unaffected by the filter, so answering the last waiting agent takes it to
            zero — and with only the first clause the pill unmounted while the filter was still ON,
            leaving every open column showing needs-you items only, i.e. nothing, with no control
            anywhere to clear it. "A filter offering to hide nothing is a control with no state to
            be in" was the justification, and an ENGAGED filter is precisely a state it is in. */}
        {(needsYou > 0 || model.needsYouFilter === true) && controller.onNeedsYouFilterToggle && (
          <button
            type="button"
            data-testid="concierge-needs-filter"
            aria-pressed={model.needsYouFilter === true}
            aria-label={`Show only what needs you (${needsYou})`}
            title="Show only what needs you"
            onClick={controller.onNeedsYouFilterToggle}
            style={{
              ...pillStyle(model.needsYouFilter ? C.dangerInk : bandColor("needs_you")),
              // PRESSED fills; unpressed is the tier's colour on the edge and the numeral. The dot
              // alone is too small to carry state at 19px, which is the mistake the per-column
              // chips already corrected.
              //
              // THE PRESSED FILL IS `dangerInk`, NOT THE BAND COLOUR — and this crosses that
              // token's documented fill/ink split ON PURPOSE, because the split's whole rationale
              // is legibility and here it is the fill that has to carry text. Brand sienna
              // (`bandColor("needs_you")`, #e0533f) is a mid red: in LIGHT it measures 3.83:1
              // against `onGoldFill`'s white on this pill's 10px bold label — under AA, and
              // unreachable from that hue, since nothing lighter than near-black clears 4.5 on it
              // and white is the only light end available. The themed alarm ink is a deep red in
              // light and a light salmon in dark, so paired with `onGoldFill` it clears AA by a
              // wide margin at BOTH ends while staying the same colour the tier means.
              // Measured in theme/chromeContrast.test.ts — on the flooded column too.
              color: model.needsYouFilter ? C.onGoldFill : C.dangerInk,
              background: model.needsYouFilter ? C.dangerInk : "transparent",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: model.needsYouFilter ? C.onGoldFill : bandColor("needs_you"),
              }}
            />
            {needsYou}
          </button>
        )}
        {/* THE PR / MERGE CHIP, beside the ⋮ — a slot rather than a pill this column paints itself.
            It used to be a local `prsReady` button here, and it was DEAD: nothing in the app ever
            passed `prsReady` or `onPrClick`, so the chip could not render in production and the
            only PR affordance a user could actually reach was the wide "3 PRs waiting" pill over in
            the project tab strip. A count is not the whole job either — the click has to open the
            list, merge from it, and jump to the owning agent — so the integration layer hands the
            real menu in through here instead, and this directory stays presentational. */}
        {prSlot}
        {/* THE DEPLOYMENT-PIPELINE HEALTH ICON, beside the merge chiclet (bead sparkle-m6jov5).
            Green check = all pipeline infra healthy; amber triangle = a non-blocking issue (roborev
            wedged, runners saturated, or a probe we could not read); red exclamation = a deployment
            IS blocked (no CI runner can test, or the release runner is offline). Click for the
            per-component breakdown. Self-contained and store-driven like WindowSpanButton next door.
            Exists because a silent roborev wedge once stopped code review for ~1h36m with no surface
            to the founder — this makes such an outage visible. */}
        <PipelineHealthChip />
        {/* THE SPAN-ALL-DISPLAYS SHORTCUT, and its position here is the founder's literal ask:
            "Give me a little icon next to the three dot menu… Between the PR button and the three
            dot menu" (bead sparkle-6b96h). It is a shortcut to Settings → Appearance → Window's
            "Span all displays", sharing that pane's action path via hooks/useWindowSpan so the two
            cannot disagree about whether the window is spanned — a flag `useDisplayRespan` gates
            on. Icon only, and it hides itself when there is nothing to span across, so the calm
            row stays calm. */}
        <WindowSpanButton />
        {/* The signed-in avatar + the kebab, as one cluster. `ConciergeTopRight` is the same export
            the project tabs bar mounts today; the cockpit's tabs belong to a PAIR, and this cluster
            is about the human rather than about a project, so its home is this header. */}
        <ConciergeTopRight />
      </div>
      {/* ── BELOW the header, and deliberately NOT in it ────────────────────────────────────────
          The always-listening voice ring + waveform, and the remaining-credit pill.

          Neither is in the founder's list for `.ahd`, and the row above is already full — but
          neither could simply be deleted either. The ring is the app's SINGLE mic control
          (arm / mute / off) and it is what names the concierge as the voice surface, which is what
          steers dictated speech into the compose box; the badge is the only "Open credits" entry
          point in the shell and the only place a top-up done elsewhere shows up. So they keep a
          thin strip of their own rather than being folded into a header that consolidated
          precisely to stop carrying everything. */}
      <div
        data-testid="concierge-voice-strip"
        style={{
          flex: "0 0 auto",
          // The containing block for the floating credit pill below. NOT a flex row any more: the
          // pill used to be a flex SIBLING, so it consumed horizontal space and the waveform was
          // squeezed to `strip − padding − gap − pill`, dying well short of the right edge and
          // leaving the right of the bar dead. The waveform is now the strip's only flow child and
          // spans the whole width; the pill floats on top of it in z-order.
          position: "relative",
          padding: "6px 16px 0",
        }}
      >
        <div
          data-testid="concierge-waveform-slot"
          // BOTH insets, symmetrically. Only the left one existed, which is the other half of why
          // the bars stopped short on the right: LogoWaveform carries its own 14px side padding, so
          // cancelling it on one side only left the right edge inset by 14px on top of everything
          // the pill was already taking.
          style={{ marginLeft: WAVEFORM_INSET, marginRight: WAVEFORM_INSET }}
        >
          {/* The GESTURE, not the microphone — the status line under the waveform swaps to
              "Release ⌘ to send" on the keydown itself (sparkle-bbfsx). This column is already the
              conduit for the same value into the tray's held treatment (`pttHeld` below), so the
              two read one fact rather than two. */}
          <LogoWaveform pttHeld={pttHeld} />
        </div>
        <div
          data-testid="concierge-credit-overlay"
          style={{
            // OVERLAID, not laid out beside. Absolute so it takes zero width from the waveform —
            // the ask was explicitly "do not shrink the waveform to make room".
            position: "absolute",
            // THE BADGE KEEPS THE COLUMN'S 16px INSET; only its BACKDROP reaches past it. The
            // gutter below is padding, so it grows this box outward in both directions — pinning
            // the box at 16 would have shoved the visible pill 10px left of the search field and
            // the cards under it, i.e. fixed the crowding by breaking the column's one vertical
            // edge. Offsetting by the same gutter keeps every glyph exactly where it was and lets
            // the softened region be the only thing that moved.
            right: 16 - CREDIT_BACKDROP_GUTTER,
            // Centred on the WAVE STAGE — half the stage down from the strip's top padding, then
            // pulled back by half of its OWN height. Against the stage rather than the strip so it
            // sits on the bars instead of drifting with the caption block underneath them; and by
            // transform rather than by `height: WAVE_HEIGHT` because the box below is a BACKDROP.
            // Given the stage's height it became a 56px blurred slab with a 999px radius — a large
            // pale ellipse bleeding over the bars, which is worse than the clipping it replaced.
            // Sized to the badge, the same treatment reads as a pill behind the text.
            top: 6 + WAVE_HEIGHT / 2,
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            zIndex: 1,
            // LEGIBILITY OVER MOVING BARS. The column's background is dynamic (it floods on
            // data-wired), so a scrim painted in a fixed colour would be wrong half the time. A
            // local backdrop blur is background-agnostic: it turns whatever is behind the pill —
            // bars mid-animation included — into soft texture, and the pill's own fill does the
            // rest. The blur is confined to this box, so the waveform is untouched.
            borderRadius: 999,
            // THE GUTTER, and it is the actual fix for "the waveform runs right up against the
            // balance" (bead sparkle-kk9dg.3). This box used to hug `BalanceBadge` exactly, so the
            // blurred region began where the ink began and the bars met a hard edge. The padding
            // pushes the softened region past the glyphs on every side. See CREDIT_BACKDROP_GUTTER
            // for why it is here and not on the badge — and the block below for what the same
            // enlarged box cost the drop shadow that used to sit here.
            padding: `3px ${CREDIT_BACKDROP_GUTTER}px`,
            backdropFilter: `blur(${CREDIT_BACKDROP_BLUR}px)`,
            WebkitBackdropFilter: `blur(${CREDIT_BACKDROP_BLUR}px)`,
            // ── NO SHADOW ON THIS BOX, AND THE GUTTER IS WHY (roborev 58703) ──────────────────
            // It carried `0 1px 6px rgba(0,0,0,0.20)`, and that was RIGHT while this box hugged
            // `BalanceBadge`: the shadow fell on the badge's own edge and lifted the ink off the
            // bars. The gutter moves the border box ~10px out past the ink, and a shadow is drawn
            // from the BORDER BOX — so it stopped tracing the pill and started tracing a rounded
            // rectangle with nothing on it, ~10px away from the only visible object. That is the
            // "ring around the pill rather than lifting it off the bars" the old comment here was
            // written to prevent; the gutter walked straight into it from the other direction.
            //
            // Deleted rather than retuned because THE LIFT IS NO LONGER NEEDED. A shadow separated
            // ink from bars that reached it; the bars now stop a gutter's width short and the blur
            // softens everything inside that gutter, which is the same job done by the thing that
            // caused the problem. Checked the way the rest of this strip is: captured at 280px in
            // both themes with and without it, and without reads cleaner — the badge's fill is the
            // only edge on screen, and no contour floats beside it.
            //
            // If the pill ever needs a lift again it belongs on `BalanceBadge`, which is the box
            // that actually paints, not on this one — pinned by the header suite.
          }}
        >
          <BalanceBadge />
        </div>
      </div>
      {/* THE SEARCH USED TO RENDER HERE — it now sits in the header row beside the wordmark (see
          the `concierge-header-search` note above). Left as a marker rather than silently deleted
          because this position is load-bearing in the reader's mental model of the column: the
          strip order is header → voice/waveform → thread, and search was the thing between the
          second and third. It is not "also" in the header; it is only there. */}
      {/* THE LOCKED STATE swaps the paid half — the chat with the `claude -p` brain — for the
          upsell, and NOTHING above this line changes: the header, the scope line, the needs-you
          counts and the per-project segments are all derived from local app state, cost nothing to
          run, and stay live. That adjacency is the design: the lock sells what the human is missing
          while sitting next to live proof it would be useful (Concierge/ConciergeAiLocked). */}
      {lockBlanksColumn && aiLock ? (
        <ConciergeAiLocked reason={aiLock} />
      ) : mountedAgent ? (
        /* MOUNTED: this agent's own conversation, not Sparkle's.
         *
         * THE SWAP IS A SIBLING, NOT A MODE. `ConciergeThread` is not rendered at all here, which is
         * what makes "unmount restores the concierge conversation, including any draft" true by
         * construction rather than by a restore path that could be wrong: the concierge thread's
         * store is never read, never written and never unmounted-with-side-effects — the component
         * simply is not on screen, and comes back with its state exactly as it was.
         *
         * Keyed on the agent id so mounting a DIFFERENT agent remounts the thread. Without the key
         * React would reuse the instance and carry the previous agent's scroll position — and, for
         * the moment before the new transcript lands, its entries — into the new agent's view. */
        <MountedAgentThread
          key={mountedAgent.agentId}
          thread={mountedAgent.thread}
          // …and the id, so the thread can also show what is QUEUED for this agent and not yet in
          // its conversation (bead sparkle-zm0c8). The transcript alone is a projection of turns that
          // have already happened, which is exactly why a just-sent message appeared nowhere.
          agentId={mountedAgent.agentId}
          agentName={mountedAgent.name}
          onReachTop={mountedAgent.onReachTop}
          // The quote affordance follows the conversation on screen: mounted, a selection over the
          // AGENT's transcript stages into the same compose box below.
          onQuote={controller.onQuote}
        />
      ) : (
        // `BeadPillHost` supplies the LIVE beads board to every bead id in the thread, and keeps it
        // polling — see its docstring for why it has to start the poller itself. It wraps rather
        // than sits beside `AgentPillProvider` for no deeper reason than that both contexts must
        // cover the same subtree; neither depends on the other.
        <BeadPillHost>
          <AgentPillProvider value={agentPills}>
            <ConciergeThread
              wired={isWired}
              messages={model.messages}
              typing={model.typing}
              // The per-message status, straight through. The column does not compose or filter it
              // — the host owns which message is being worked on, and the row owns how it reads.
              statuses={model.statuses}
              turnFloor={model.turnFloor}
              // ── THE SCRUBBER RAIL, STRAIGHT THROUGH (bead sparkle-7m719) ──────────────────────
              // Not composed here and not conditioned on anything: the host owns which turns have
              // been paged in and which message the rail asked for, and the thread owns the layout.
              // MOUNTED-AGENT MODE DELIBERATELY GETS NONE OF IT — the sibling above is a different
              // agent's transcript, and a rail over the concierge's history sitting beside it would
              // be a control that scrolls a conversation that is not on screen.
              backlog={backlog}
              /* THE RAIL ITSELF (bead sparkle-7m719) — the founder's "vertical slider bar that
                 makes it easy to scroll up and down the chat page", asked for four times over
                 sixteen days. The view is presentational and the controller holds every decision,
                 so this is a spread of the controller's fields and nothing more. An explicit
                 `rail` prop still wins, which is what keeps the gutter injectable. */
              rail={
                rail ??
                (scrubber ? (
                  <ThreadScrubber
                    marks={scrubber.marks}
                    scope={scrubber.scope}
                    onScopeChange={scrubber.setScope}
                    now={scrubber.now}
                    /* MIN(created_at), so the scope menu can print "All — since Aug 12" rather than
                       leaving the founder to ask a person to measure the SQLite file. */
                    oldestMs={scrubber.oldestMs}
                    position={scrubber.position}
                    /* LIVE — every pointermove of a drag. This is what scrolls the thread now; see
                       useThreadScrubber's header for why the old mouseup-only design was reversed. */
                    onScrub={scrubber.onScrub}
                    onScrubEnd={scrubber.onScrubEnd}
                    onPick={scrubber.onPick}
                    /* So a rejected history query cannot read as a quiet week — both leave the cards
                       ageless, and only the rail can say which one this is (roborev 66429). */
                    failed={scrubber.failed}
                    /* What the store holds ABOVE the loaded thread, by aggregate count. The rail
                       must never imply that what is loaded is all there is. */
                    moreAbove={scrubber.moreAbove}
                  />
                ) : undefined)
              }
              jumpRequest={jumpRequest}
              /* THE CABLE THE RAIL SCROLLS THROUGH. The rail replaces this thread's scrollbar, so
                 its controller needs the scroller element itself — see ConciergeThread's prop doc
                 for why this is a callback rather than a shared ref. */
              onScrollerAttached={scrubber?.attachScroller}
              onNudgeClick={controller.onNudgeClick}
              onRevealAgent={controller.onRevealAgent}
              onNudgeAction={controller.onNudgeAction}
              onRedirect={controller.onRedirect}
              onDigestClick={controller.onDigestClick}
              copyOnSelection={copyOnSelection}
              // Straight through to the host, which speaks it into the ONE live region below. The
              // thread deliberately owns no announcer of its own.
              onCopied={controller.onCopied}
              // "Quote in response". Straight through as well: the thread raises the chiclet and
              // reports the snapshot, the host decides what a staged quote means.
              onQuote={controller.onQuote}
            />
          </AgentPillProvider>
        </BeadPillHost>
      )}
      {/* NO RECOMMENDED-ACTION ROW HERE any more. It used to sit in a `suggestionsSlot` directly
          above the compose box; it now renders over the terminal itself, pinned bottom-right on the
          CLI's input line, because the action is about the agent you are looking at. The host still
          mounts it (keyed per agent) — it just portals its output into the pane. See
          Concierge/ConciergeSuggestions. */}
      {/* Tool calls the concierge has STOPPED on, waiting for your yes or no
          (Concierge/ConciergeApprovals). Above the countdown deliberately: "may I do this at all?"
          precedes "this is about to go out", and an unanswered approval is the one thing here that
          has already halted a call. A slot, like the countdown, and for the same reason — it reads
          the pending-approval ledger and this column renders only what it is handed. */}
      {/* "Your concierge isn't answering" — sticky, and above the approval prompt because it is the
          precondition for it: an approval the brain will never come back to collect is not the next
          thing to read. Mounted DIRECTLY rather than through a slot (unlike `approvalSlot` and
          `countdownSlot`) because it takes no data from the host at all — it subscribes to
          services/conciergeLiveness itself, the way PresenceSlider and ConciergeSuggestions read
          their own stores. It renders null in every state but the sticky one.

          GATED ON THE AI LOCK for the same reason the thread is: when the paid half is switched off,
          unbought, or out of credits, there is no brain to be unresponsive and ConciergeAiLocked has
          already said the true thing about why. */}
      {/* THE "ACROSS THE FLEET" BOX USED TO MOUNT HERE, AND WAS DELETED ON PURPOSE (bead
          sparkle-d43bf). Do not reinstate this shape without reading that bead first.

          It aggregated quota walls, shutdown casualties, escalated goals, retirable agents and
          stalled standing duties into one card. The aggregation was the right instinct; the
          PRESENTATION was not. With nine goals escalated it rendered nine near-identical
          paragraphs, each repeating the agent name, "Auto-continued 3 times with no sign of
          progress", the goal text IN FULL, and "Something is blocking it that restarting cannot
          fix" — per-item boilerplate longer than the one fact that differed, and taller than the
          screen. The founder's verdict: "This isn't helpful and takes up too much space."

          The deeper reason a smaller version of the same card is NOT the fix: the escalation signal
          feeding it is largely FALSE. Agents that had shipped and said so on their own activity line
          were still listed as escalated, and one was escalated for a failure that lived entirely in
          the reporting channel — a bridge timeout stopped it marking its goal met while the
          auto-continue counter kept advancing. Nine escalations, most spurious, trains a reader to
          dismiss the box, and the one real escalation goes with them.

          Whatever replaces this must fix the SIGNAL first: these goals carry `verify:landed`, so
          "did it actually land" is answerable from git ancestry without asking the agent anything.

          THE BINDING IS WIRED NOW, AND NOT TO A CARD (2026-08-04, sparkle-4cd0x). When this display
          was deleted it took the only PRODUCTION caller of the decision logic with it, and the whole
          path went dormant — both modules sat in `scripts/dormant-modules.allow` and nothing in a
          running app computed or sent a fleet condition. That is no longer true: `services/
          pusherMount.ts` drives the sweep from `App.tsx`, and the fleet conditions are DELIVERED to
          the concierge as a proactive turn rather than rendered anywhere. Both allowlist entries are
          gone, so the guard now fails if either module goes dormant again.

          What that means for a replacement surface: the data IS flowing, and a card would be a
          second consumer of it rather than the thing that switches it on. Read the conditions; do
          not re-wire them.

          ONE THING WENT WITH IT THAT WAS NOT THE POINT: the improvement pass's "why the hourly pass
          is held / the pane is wedged" report (PRD/sparkle/pane-wedged-hold.md). `improvementHoldText`
          lived in the deleted binding and was the only thing turning `passHoldReason` into a
          rendered `PASS_HOLD_TEXT` sentence, so that report now has no surface anywhere and
          `improvementPass.paneBusySinceAt` is reachable only from its own tests. The pass itself is
          unaffected — `shouldRunImprovementPass` still calls `passHoldReason` — it is the REPORTING
          that is gone. A replacement surface owes this back, or `paneBusySinceAt` should go; bead
          sparkle-yo08a holds that decision. */}
      {!aiLock && <ConciergeUnavailable />}
      {approvalSlot}
      {/* Armed sends counting down (Concierge/CountdownBanner), directly above the box — the last
          thing between the user's words and an agent's terminal, so it sits where the eye already
          is after hitting Send. A SLOT, not a view-model field: the banner reads a module-level
          intent registry, and this column stays a pure renderer.
          It deliberately carries NO live region of its own — the single announcer below is fed by
          the host when an intent arms (a second region double-announces). */}
      {countdownSlot}
      {/* LIVE BLOCKERS, PINNED. The founder's 2026-08-07 ask: *"any sort of blocked notices… right
          above the compose window. And not in line in the chat thread… they should stay
          persistently above the composed window so that I see them regardless of how much the chat
          thread moves."*

          THIS ROW, and not a new region: the zone directly above the composer already holds the
          countdown banner and the mounted-agent pills, so a blocker joins a strip the eye is
          already trained on instead of inventing a fourth place to look.

          BELOW `countdownSlot` on purpose. The banner is a few-second countdown the reader may want
          to Cancel — it is the more perishable of the two, so it keeps the position nearest the eye
          after a send. A blocker persists until it is resolved and can afford to sit under it.

          GATED ON `!lockBlanksColumn` like every other member of this strip, and for the reason
          spelled out on its neighbours: a surface whose whole promise is "above the composer" must
          not render where no composer does. That condition used to be `!aiLock`, because a lock
          took the composer away in every state; it now takes it away only while UNMOUNTED, so the
          gate follows the composer rather than the lock (bead sparkle-voudj7). NOT gated on
          `isWired` — unlike the mounted pills, a blocker is about the FLEET rather than about the
          mounted agent, and the founder must see it whether or not a cable happens to be patched. */}
      {!lockBlanksColumn && (
        // ITS OWN `AgentPillProvider`, and this is NOT optional. The provider above wraps the
        // THREAD, and a blocker is no longer in the thread — so without this the strip's pills
        // resolve to nothing and render the "…is closed" dead-end variant, naming an agent the
        // reader cannot open. That is the exact failure `AgentPill.deadEnd.test.tsx` exists to
        // forbid, and it appears as a working-looking pill rather than as an error.
        //
        // A second provider rather than hoisting the first one around both: the thread's is inside
        // the mount SWAP (it is rendered on the unmounted branch only), and widening its scope
        // would put a context around a subtree that swaps out from under it. `agentPills` is one
        // memoised value, so both readers see the same roster.
        <AgentPillProvider value={agentPills}>
          <PinnedBlockers
            blockers={model.pinnedBlockers ?? []}
            acknowledged={model.acknowledgedBlockers ?? EMPTY_ACKNOWLEDGED}
            onNudgeClick={controller.onNudgeClick}
            onNudgeAction={controller.onNudgeAction}
          />
          {/* LIVE PREVIEWS, AS CARDS (bead sparkle-3475b.8). *"[dot color] [build agent name] has a
              preview for you to review: [preview card]"* — the founder's shape.

              INSIDE THIS PROVIDER, and that is why it is here rather than in a region of its own:
              the card names its agent with an `AgentPill`, which resolves the live name, the status
              dot and the click-through from this context. Outside it the pill would render the
              "…is closed" dead-end variant, naming an agent the reader cannot open — the exact
              failure `AgentPill.deadEnd.test.tsx` forbids, and it would look like a working pill.

              BELOW the blockers on purpose. A blocker is something that needs the reader NOW; a
              preview is an invitation. The more urgent thing keeps the position nearest the eye.

              NO PROPS: it reads `previewStore`/`projectStore` itself, so `ConciergeColumn` stays a
              pure renderer (the same split `MountedAgentNotices` below uses). It renders nothing at
              all when no preview is live, which is the ordinary state. */}
          <PreviewCards />
        </AgentPillProvider>
      )}
      {/* THE ONE EXPLANATION THAT SURVIVES THE MOUNT SWAP. Mounted, the thread above is the AGENT's
          transcript and `ConciergeThread` is not rendered at all — so a terminal refusal, or the
          @Sparkle escape hatch's reply, is written to a component that is off screen (roborev 57360).
          This row is outside the swap, like `countdownSlot` above and the unmount hint below, which
          is what makes it visible in the state the mounted-composer feature exists for.

          NOT gated on `mountedAgent`: the host only ever fills it on the mounted path, and gating it
          here as well would be a second place for "are we mounted" to be decided — the divergence
          that put the composer in the terminal's face while the send path refused to route. */}
      {!lockBlanksColumn && <MountedNotice notice={mountedNotice} />}
      {/* THE MOUNTED AGENT'S NOTICES, AS PILLS — bead sparkle-tyter, and the founder's second ask
          for it: *"when I click on the agent to mount the concierge, I get pills on top of the
          composed window that tell me any notices or warnings."*

          THIS ROW IS WHERE THE WORDS WENT. The sidebar row now renders one wordless glyph per notice
          class, because rendering the labels there squeezed the agent's NAME to zero width — eight
          rows on his screenshot had no name at all. Moving them off the row is only honest if they
          land somewhere with room, and this is that place.

          SAME THREE GATES AS ITS NEIGHBOURS, for the reasons spelled out at 650-680 rather than
          re-derived here. `!lockBlanksColumn` because pills claiming to sit "above the composer"
          must not render where no composer does — which, since sparkle-voudj7, is the unmounted
          lock rather than every lock. `isWired` because a pill row about the mounted agent must not
          outlive the cable. `mountedAgent` because that is where the id comes from.

          OUTSIDE THE MOUNT SWAP, like `countdownSlot` and `MountedNotice` above and the unmount hint
          below — which is what makes it visible in the one state the feature exists for.

          THE SIDE COMES FROM `wired` ITSELF, not from a new prop. `wired` IS the PairSide holding
          the cable ("off" | "left" | "right"), and the row mark that seeds `focusedNoticeBySide`
          patched the cable to that same side — so reading it here is reading the one value, rather
          than adding a second place for "which side am I" to be decided. The `isWired` gate above
          has already excluded "off", which is what makes the narrowing sound. */}
      {!lockBlanksColumn && isWired && mountedAgent && (
        <MountedAgentNotices agentId={mountedAgent.agentId} side={wired} />
      )}
      {/* THE WAY OUT OF THE MOUNT. Mounted, the human's typing goes to a build agent's terminal
          rather than to the concierge — a big change in where their words land, and Escape is the
          only gesture that undoes it. So the affordance is ON SCREEN while the state is live rather
          than learned once: the founder's placement is this row, directly above the composer (the
          one carrying the `>_ …` activity line), right-justified.

          GATED ON `isWired`, which is the whole point — a hint offering an exit from a state you are
          no longer in asserts the cable is still patched when it isn't, the same stale signal the
          unmount gestures exist to clear. It appears on mount and vanishes on unmount, with no
          state of its own: it is a projection of `wired`, like every other consequence of the cable
          (MAPPING.md — one value, every visual consequence follows from it).

          AND GATED ON `!lockBlanksColumn`, matching the ComposeBox below. This used to read
          `!aiLock`, and the reasoning recorded here was sound but rested on a premise that was
          itself the bug: `aiLock && isWired` is REACHABLE (the cable is patched by a sidebar row
          click, and that gesture knows nothing about the concierge AI entitlement), and in that
          state the thread was replaced by ConciergeAiLocked and THERE WAS NO COMPOSER AT ALL — so
          an un-gated hint would offer "the way out" of a typing-routes-elsewhere state whose input
          surface did not exist, an affordance with nothing behind it (roborev 55535).
          The premise is gone: mounted, the composer renders whatever the lock says (bead
          sparkle-voudj7 — the founder had no typing area at all in exactly this state). So the hint
          follows the composer, which is what it was always really tracking, and the founder's
          placement ("directly above the composer") holds by construction in both states. */}
      {!lockBlanksColumn && isWired && (
        // ══ THE CHIP SHARES THIS ROW, LEFT-ALIGNED (bead sparkle-wj3ya) ═══════════════════════════
        // The founder's placement, which supersedes the "next to the paperclip" one in that bead's
        // description: *"When the pane is mounted, it should be saying 'Chatting with [circle (red,
        // green etc)] [Agent name]' to the LEFT of where it says escape click to unmount."*
        //
        // THIS ROW IS THE RIGHT HOME because it already renders only while mounted: the indicator
        // and the way out cannot appear without each other, and neither can outlive the cable. That
        // is also why the chip needs no gate of its own — `isWired` above is the whole condition.
        //
        // `space-between` rather than a second container: the hint keeps its right edge exactly
        // where it was, so this adds a chip without moving anything that was already on screen.
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            padding: "0 12px 4px",
          }}
        >
          {mountedAgent ? (
            <span
              data-testid={CONCIERGE_CHATTING_WITH_TESTID}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: TYPE.small,
                color: C.conciergeMuted,
                // THE NAME DEGRADES, THE DOT NEVER DOES — the bead's explicit rule for narrow
                // columns ("Degrade the NAME first, never the dot"). The dot is a fixed-size flex
                // item outside this clamp; only the label truncates.
                minWidth: 0,
              }}
            >
              <span>Chatting with</span>
              {/* LIVE, and the same component the sidebar row draws, so the two cannot disagree
                  about what green/gray/red mean — the chip's whole job is to tell him WHO he is
                  talking to and HOW THAT AGENT IS DOING without leaving the composer. Omitted
                  rather than guessed when the status is not known yet. */}
              {mountedAgent.status !== undefined && (
                <StatusDot status={mountedAgent.status} size={7} />
              )}
              <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {mountedAgent.name}
              </span>
            </span>
          ) : (
            // Keeps the hint hard right when there is no chip to balance it against.
            <span />
          )}
          <span
            data-testid={CONCIERGE_UNMOUNT_HINT_TESTID}
            // Not a button. Escape is the gesture; drawing a control here would invite a click that
            // does the same thing two ways and take a tab stop for a key that already works.
            style={{
              // TYPE.small (12), not a bare 11. The scale's own doc calls `small` "secondary UI:
              // chips, HINTS, metadata" — which is exactly this row's register — and theme/scale's
              // ratchet holds the off-scale fontSize count at zero, so a literal here was both a
              // CI failure and a real drift away from the one type scale.
              fontSize: TYPE.small,
              color: C.conciergeMuted,
              whiteSpace: "nowrap",
              // Matches the activity line's register on the row it shares — muted, small, and
              // subordinate to the conversation above it.
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {/* A DRAWN KEY, not bracketed text. This was `[ESC]` inside a bare, borderless <kbd> —
                square brackets standing in for a keycap the app had no component to draw. KeyPill
                is that component; the brackets came out with it.

                PURPLE, and purple ONLY HERE: the tone paints the pill's border and glyph, while
                "to unmount" below keeps this row's muted ink. The hue is the open-PR badge's
                (OpenPrMenu) — taken as a token, so the two stay in step if it is retuned. See
                KeyPill's TONES for why the edge and the ink are different tokens of the same violet.

                NO `opacity` here or in KeyPill. This hint only ever renders on the FLOODED plane
                (background is BLUEPRINT[mode].term while wired), where chromeContrast.test.ts
                records light `conciergeMuted` as the tightest ink in the column — 4.76:1, i.e. 0.26
                of margin. An 0.9 opacity spends more than that: compositing #4f6284 at 0.9 over
                #d9e3f3 measures ~3.93:1, under the suite's 4.5 floor, on the ONE glyph a reader must
                actually read to know which key to press. The contrast suite measures token pairs and
                cannot see an inline opacity, so nothing would have caught it (roborev 55535).

                ══ AND THE SECOND KEY, BECAUSE THE FIRST ONE CAN BE DEAD (bead sparkle-thm9o) ══════
                The founder's app wedged with "I could not unmount the concierge", and this hint was
                part of the harm: Escape had been disabled app-wide by a leaked hidden dialog node,
                `unmountCable` DID still work, and the only affordance on screen named exclusively
                the key that no longer did anything. A hint offering a remedy that cannot work while
                a working one exists unmentioned is the "user-facing copy is code" failure AGENTS.md
                names — the remedy string has to be safe under the same conditions that broke the
                path it describes. The probe bug is fixed; naming both keys is what makes the hint
                survive the NEXT way Escape dies.

                Drawn from the LIVE binding, never a hard-coded "⌘⇧U": `unmountCable` is rebindable
                in ⋯ Settings → Shortcuts, and copy naming a chord the user has changed is the same
                defect one level along. */}
            <KeyPill tone="violet">ESC</KeyPill>
            {" or "}
            <KeyPill tone="violet">{unmountChord}</KeyPill> to unmount
          </span>
        </div>
      )}
      {/* The column's ONE live region. Visually hidden, polite, and fed only completed lines, so a
          screen-reader user hears the reply once — not once per chunk (roborev 52648/53010).
          Routing receipts land here too: with the send-target toggle gone this is the only way a
          screen-reader user learns where their message went.
          The region element itself is STABLE (an aria-live node must exist before the content it
          announces); only its child is replaced. */}
      <div
        data-testid="concierge-announcer"
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {/* Keyed on the WRITE COUNTER, never the text (roborev 53392). Rendering the bare string
            meant two identical consecutive lines — "Sent to CI Hardening." on each of two sends to
            the same pinned agent — spoke only once, because an aria-live region reacts to a content
            CHANGE and there wasn't one. The key makes React unmount and remount this node on every
            write, so each announcement is a genuine mutation whatever the text says. */}
        <span key={announcement.seq} data-announce-seq={announcement.seq}>
          {announcement.text}
        </span>
      </div>
      {/* No composer while locked AND UNMOUNTED — the structural half of the guarantee. A column in
          that state has nothing to type into and no Send to press, so a gated send can never be
          ATTEMPTED from here at all (the service-level refusal stays the backstop, not the only
          line).
          MOUNTED, THE BOX COMES BACK. The only route from here to the paid brain is the `@Sparkle`
          escape hatch, and `startConciergeTurn`'s own `conciergeAiEnabled()` check is what governs
          that — a different, deliberately looser rule than this lock, for the reason spelled out at
          `lockBlanksColumn`. What returns here is the PTY relay to the human's own agent, which
          neither rule was ever about. See `lockBlanksColumn` too for the founder report that made
          this a bug rather than a policy. */}
      {!lockBlanksColumn && (
        <ComposeBox
          /* One draft per conversation. Mounted, the box is addressed to that agent; unmounted it is
             addressed to Sparkle — and a half-typed message must not follow you from one to the
             other. See ComposeBox's `draftKey`. */
          draftKey={mountedAgent ? `agent:${mountedAgent.agentId}` : "concierge"}
          wired={isWired}
          onSend={controller.onSend}
          onAttach={controller.onAttach}
          onRemoveAttachment={controller.onRemoveAttachment}
          attachments={model.attachments}
          quote={model.quote}
          onRemoveQuote={controller.onRemoveQuote}
          dropActive={model.dropActive}
          attachNotice={model.attachNotice}
          onDismissAttachNotice={controller.onDismissAttachNotice}
          interim={interim}
          registerInsert={registerInsert}
          onTextEdit={onTextEdit}
          mentionAgents={mentionAgents}
          preferredAgentId={preferredAgentId}
          /* NOT `mountedAgent?.agentId` (roborev 57358/57361). The thread swap above keys off the
             DISPLAY mount — is the cable patched — which is the right question for "whose
             conversation is shown" and the wrong one for "where do my words go". The host gates this
             one on `promptTargetShown` as well, so the typeface can never claim a draft is bound for
             a PTY in a state where the send path has already decided it is not (Plan board up,
             Improve-Sparkle up, the agent's tab closed). The composer takes the ROUTING fact,
             because that is the fact its typeface is reporting. */
          mountedAgentId={routableMountedAgentId}
          autoSend={autoSend}
          sendMode={sendMode}
          onSendModeChange={onSendModeChange}
          autoSendOn={autoSendOn}
          onAutoSendChange={onAutoSendChange}
          trayInert={trayInert}
          pttHeld={pttHeld}
          onComposedText={onComposedText}
          onMentionComposing={onMentionComposing}
          onPasted={onPasted}
          onComposeInteraction={onComposeInteraction}
          registerSubmit={registerSubmit}
        />
      )}
    </section>
  );
}
