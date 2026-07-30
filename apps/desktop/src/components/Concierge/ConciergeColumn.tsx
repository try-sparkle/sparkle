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
import { FiGitPullRequest } from "react-icons/fi";
import { useMemo } from "react";
import { CONCIERGE_COLUMN_DND_TARGET } from "../../services/dndTargets";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { useResolvedTheme } from "../../theme/theme";
import { bandColor } from "../../engine/statusBandLabels";
import { BalanceBadge } from "../BalanceBadge";
import { LogoWaveform } from "../LogoWaveform";
import { SparkleLogoLink } from "../SparkleLogoLink";
import { ComposeBox } from "./ComposeBox";
import { ConciergeAiLocked } from "./ConciergeAiLocked";
import { ConciergeUnavailable } from "./ConciergeUnavailable";
import { useConciergeAiLock } from "./conciergeAiLock";
import { ConciergeThread } from "./ConciergeThread";
import { ConciergeTopRight } from "./KebabMenu";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { ScopeVitals } from "./ScopeVitals";
import { KeyPill } from "./KeyPill";
import { wordmarkRamp } from "./wordmarkRamp";
import type { ConciergeAnnouncement, ConciergeColumnProps } from "./types";
import { FONT_UI, TYPE } from "../../theme/scale";

/** Nothing announced yet. Module-level so the default prop is referentially stable. */
const EMPTY_ANNOUNCEMENT: ConciergeAnnouncement = { seq: 0, text: "" };

/** LogoWaveform carries its own 14px side padding (it used to be a direct child of the builder
 *  column, which had none). Pull it back out so the bars line up with the column's own inset
 *  instead of sitting inset by strip-padding + its own. */
const WAVEFORM_INSET = -14;

/** `--hd-h` — the ONE header height in the cockpit. The concierge's header row and a pair's build
 *  header are the same height, which is what lets the eye read across the shell at that line. */
const HEADER_H = 34;

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

/** rev4's `.pill`: a squared 19px chip, not a capsule. The direction draws boxes. */
const pillStyle = (edge: string) =>
  ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flex: "0 0 auto",
    height: 19,
    padding: "0 6px",
    borderRadius: 3,
    border: `1px solid ${edge}`,
    background: "transparent",
    font: "inherit",
    fontSize: 10,
    fontWeight: FONT_WEIGHT.bold,
    lineHeight: 1,
    color: C.conciergeMuted,
    cursor: "pointer",
  }) as const;

/**
 * THE 8-DOT DRAG GRIP — `.grip` in MAPPING.md, 4×2 dots.
 *
 * It moves the concierge between the sides of the shell, which is a thing only the shell can do —
 * so this reports the gesture and renders nothing about the outcome, like every other control in
 * this column. Rendered only when a handler is supplied: a grip with nowhere to drag to is an
 * affordance that lies (the same rule ScopeVitals' segment buttons follow).
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

export function ConciergeColumn({
  model,
  controller,
  width = 380,
  searchSlot,
  interim = "",
  registerInsert,
  onTextEdit,
  announcement = EMPTY_ANNOUNCEMENT,
  countdownSlot,
  approvalSlot,
  wired = "off",
  mentionAgents,
  preferredAgentId,
  copyOnSelection = true,
  autoSend,
  sendMode,
  onSendModeChange,
  trayInert,
  onComposedText,
  registerSubmit,
  onOpenAgent,
  onSeeAgentHistory,
}: ConciergeColumnProps) {
  // Why the paid half isn't running, or null when it is. Like the two brand-chrome pieces in the
  // header, this reaches for its own stores rather than the view-model (see ./conciergeAiLock).
  const aiLock = useConciergeAiLock();
  // Concrete hex for the three spec values with no CSS var of their own — the wordmark's two ends,
  // the terminal register this column floods to, and the lift it drops when it does. See
  // theme/blueprintSpec for why they are not in THEME_HEX, and ./wordmarkRamp for the ramp.
  const mode = useResolvedTheme();
  const isWired = wired !== "off";
  const needsYou = model.vitals.needs_you;
  const prsReady = model.prsReady ?? 0;
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
        // ── LIFT AT REST, FLOOD WHEN WIRED ───────────────────────────────────────────────────
        // UNWIRED it LIFTS: a soft shadow and NO colour change, so it reads as a layer above the
        // pairs. WIRED it DROPS FLUSH — loses the shadow and takes the TERMINAL's colour, which is
        // what says "this column is now one end of that cable". The two are alternatives: a
        // shadow AND a colour change would read as two unrelated effects rather than as one
        // control being plugged in.
        background: isWired ? BLUEPRINT[mode].term : C.conciergeSurface,
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
        borderRight: `1px solid ${C.hairline}`,
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
          wordmark · 8-dot grip · scope pill · needs-you filter · PR/merge pill · avatar · kebab.

          The founder asked for this consolidation explicitly, and the reason it is worth a whole
          restructure is that the shell used to SCATTER these: the scope line had its own centred
          block, the credit pill shared a row with the mark, the avatar and kebab lived over in the
          project tabs bar, and there was no global "just show me what needs me" control anywhere.
          Gathering them costs one row of header height — the column's scarcest space, since
          everything below it is the thread — and it puts every cross-project control in the one
          column that is about every project.

          Nothing here is a second rendering of something that exists elsewhere. The scope pill IS
          ScopeVitals (`dense`), the avatar and kebab ARE `ConciergeTopRight`, and the counts come
          off the same view-model the thread does. */}
      <div
        data-testid="concierge-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: HEADER_H,
          flex: "0 0 auto",
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
        {controller.onMoveSide && <ConciergeGrip onMoveSide={controller.onMoveSide} />}
        {/* Scope + who needs you (`All projects · 2 here · 1 in mobile`), inline. */}
        <ScopeVitals
          dense
          pinnedProjectName={model.scope.pinnedProjectName}
          counts={model.vitals}
          byProject={model.needsYouByProject}
          onProjectClick={controller.onProjectClick}
        />
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
        {/* THE PR / MERGE PILL. Green and filled once something is actually mergeable — that is the
            one state in the shell where the next action is a single click, so it is the one pill
            allowed to shout. Hidden at zero for the same reason as the filter above. */}
        {prsReady > 0 && controller.onPrClick && (
          <button
            type="button"
            data-testid="concierge-pr-pill"
            data-ready="yes"
            aria-label={`${prsReady} pull request${prsReady === 1 ? "" : "s"} ready to merge`}
            title={`${prsReady} pull request${prsReady === 1 ? "" : "s"} ready to merge`}
            onClick={controller.onPrClick}
            style={{
              ...pillStyle(C.successInk),
              color: C.onGoldFill,
              background: C.successInk,
            }}
          >
            <FiGitPullRequest size={11} aria-hidden />
            {prsReady}
          </button>
        )}
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
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 16px 0",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, marginLeft: WAVEFORM_INSET }}>
          <LogoWaveform />
        </div>
        <BalanceBadge />
      </div>
      {searchSlot && <div style={{ flex: "0 0 auto", padding: "10px 16px 0" }}>{searchSlot}</div>}
      {/* THE LOCKED STATE swaps the paid half — the chat with the `claude -p` brain — for the
          upsell, and NOTHING above this line changes: the header, the scope line, the needs-you
          counts and the per-project segments are all derived from local app state, cost nothing to
          run, and stay live. That adjacency is the design: the lock sells what the human is missing
          while sitting next to live proof it would be useful (Concierge/ConciergeAiLocked). */}
      {aiLock ? (
        <ConciergeAiLocked reason={aiLock} />
      ) : (
        <AgentPillProvider value={agentPills}>
          <ConciergeThread
            wired={isWired}
            messages={model.messages}
            typing={model.typing}
            onNudgeClick={controller.onNudgeClick}
            onRevealAgent={controller.onRevealAgent}
            onNudgeAction={controller.onNudgeAction}
            onRedirect={controller.onRedirect}
            onDigestClick={controller.onDigestClick}
            copyOnSelection={copyOnSelection}
            // Straight through to the host, which speaks it into the ONE live region below. The
            // thread deliberately owns no announcer of its own.
            onCopied={controller.onCopied}
          />
        </AgentPillProvider>
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
      {!aiLock && <ConciergeUnavailable />}
      {approvalSlot}
      {/* Armed sends counting down (Concierge/CountdownBanner), directly above the box — the last
          thing between the user's words and an agent's terminal, so it sits where the eye already
          is after hitting Send. A SLOT, not a view-model field: the banner reads a module-level
          intent registry, and this column stays a pure renderer.
          It deliberately carries NO live region of its own — the single announcer below is fed by
          the host when an intent arms (a second region double-announces). */}
      {countdownSlot}
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

          AND GATED ON `!aiLock`, matching both its neighbours (ConciergeUnavailable above,
          ComposeBox below). `aiLock && isWired` is REACHABLE, because the cable is patched by a
          sidebar row click and that gesture knows nothing about the concierge AI entitlement: the
          column floods to terminal material, the thread is replaced by ConciergeAiLocked, and THERE
          IS NO COMPOSER AT ALL. Un-gated, the hint would sit at the bottom of that column offering
          "the way out" of a typing-routes-elsewhere state whose input surface does not exist — an
          affordance with nothing behind it, which is the one thing this file's own rules forbid, and
          it would break the founder's placement ("directly above the composer") by construction
          (roborev 55535). */}
      {!aiLock && isWired && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 12px 4px" }}>
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
                cannot see an inline opacity, so nothing would have caught it (roborev 55535). */}
            <KeyPill tone="violet">ESC</KeyPill> to unmount
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
      {/* No composer while locked — the structural half of the guarantee. A column in this state
          has nothing to type into and no Send to press, so a gated send can never be ATTEMPTED
          from here at all (the service-level refusal stays the backstop, not the only line). */}
      {!aiLock && (
        <ComposeBox
          wired={isWired}
          onSend={controller.onSend}
          onAttach={controller.onAttach}
          onRemoveAttachment={controller.onRemoveAttachment}
          attachments={model.attachments}
          dropActive={model.dropActive}
          attachNotice={model.attachNotice}
          onDismissAttachNotice={controller.onDismissAttachNotice}
          interim={interim}
          registerInsert={registerInsert}
          onTextEdit={onTextEdit}
          mentionAgents={mentionAgents}
          preferredAgentId={preferredAgentId}
          autoSend={autoSend}
          sendMode={sendMode}
          onSendModeChange={onSendModeChange}
          trayInert={trayInert}
          onComposedText={onComposedText}
          registerSubmit={registerSubmit}
        />
      )}
    </section>
  );
}
