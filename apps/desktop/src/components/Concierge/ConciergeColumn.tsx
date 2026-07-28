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
import { CONCIERGE_COLUMN_DND_TARGET } from "../../services/dndTargets";
import { C } from "../../theme/colors";
import { BalanceBadge } from "../BalanceBadge";
import { LogoWaveform } from "../LogoWaveform";
import { SparkleLogoLink } from "../SparkleLogoLink";
import { GOLD_SHEEN } from "../SparkleWordmark";
import { ComposeBox } from "./ComposeBox";
import { ConciergeAiLocked } from "./ConciergeAiLocked";
import { useConciergeAiLock } from "./conciergeAiLock";
import { ConciergeThread } from "./ConciergeThread";
import { ScopeVitals } from "./ScopeVitals";
import type { ConciergeAnnouncement, ConciergeColumnProps } from "./types";

/** Nothing announced yet. Module-level so the default prop is referentially stable. */
const EMPTY_ANNOUNCEMENT: ConciergeAnnouncement = { seq: 0, text: "" };

/** LogoWaveform carries its own 14px side padding (it used to be a direct child of the builder
 *  column, which had none). Pull it back out so the bars line up with the mark above and the scope
 *  line below instead of sitting inset by header-padding + its own. */
const WAVEFORM_INSET = -14;

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
}: ConciergeColumnProps) {
  // Why the paid half isn't running, or null when it is. Like the two brand-chrome pieces in the
  // header, this reaches for its own stores rather than the view-model (see ./conciergeAiLock).
  const aiLock = useConciergeAiLock();
  return (
    <section
      aria-label="Sparkle concierge"
      // The hit-test handle for the host's window-global drag listener (services/dndTargets). It
      // sits on the WHOLE column, not on the compose box: a file dropped anywhere over the
      // concierge attaches to the next prompt, and the box below paints the affordance showing
      // where it will land.
      data-dnd-target={CONCIERGE_COLUMN_DND_TARGET}
      style={{
        position: "relative",
        flex: "0 0 auto",
        width,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        // Depth layer ① — the LIGHTEST of the shell's three planes (PRD §3: Sparkle lightest →
        // builder → terminal darkest). See theme/colors THEME_HEX.conciergeSurface.
        background: C.conciergeSurface,
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
        color: C.cream,
        fontFamily: "Verdana, Geneva, sans-serif",
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div style={{ position: "relative", flex: "none", padding: "16px 16px 12px" }}>
        {/* THE HEADER'S ONE ROW: brand mark hard left, remaining-credit pill hard right — the two
            top corners, with `space-between` doing the pushing rather than a spacer or a margin.
            Both are flex children of the same row, so neither can drift onto the other's line as
            the column is resized.

            The mark used to sit CENTERED on its own line below this row, nested inside a star-field
            canvas that painted drifting particles behind it. Both are gone: the field is deleted
            outright (not hidden — see SparkleLogo.placement.test), and with it the last reason the
            mark needed a line of its own. That reclaims a whole row of header height above the
            thread, which is the column's scarcest space.

            The pill shows credits REMAINING (counting down) — the number the founder acts on. The
            deleted SpendPill showed a locally-derived trailing-24h spend ESTIMATE that only ever
            counted up and was never billed. */}
        <div
          data-testid="concierge-brand-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
          }}
        >
          {/* The SHEEN fill, not the flat one (founder, 2026-07-27: "make the logo sparklier").
              Still the same masked mark and the same themed gold — see SparkleWordmark.GOLD_SHEEN
              for why it is a gold glint rather than the asset's own cyan gradient. */}
          <SparkleLogoLink fill={GOLD_SHEEN} />
          <BalanceBadge />
        </div>
        {/* The always-listening voice ring + waveform, directly under the brand row. It followed
            the logo out of the builder column: the mic is Sparkle's, not a per-project build tool,
            and it belongs beside the box you talk into. Now the header's ONLY voice surface — the
            star field showed the CONVERSATION's state (it buzzed while Sparkle typed a reply), and
            with it deleted this is the sole live indicator, reading your own microphone level. */}
        <div style={{ marginLeft: WAVEFORM_INSET, marginRight: WAVEFORM_INSET }}>
          <LogoWaveform />
        </div>
        {/* ONE line, not two: scope + who needs you (`All projects · 2 here · 1 in mobile`). See
            ScopeVitals' header for what was dropped and why — the founder's "it's taking up too
            much space", 2026-07-27. */}
        <ScopeVitals
          pinnedProjectName={model.scope.pinnedProjectName}
          counts={model.vitals}
          byProject={model.needsYouByProject}
          onProjectClick={controller.onProjectClick}
        />
        {searchSlot && <div style={{ marginTop: 10 }}>{searchSlot}</div>}
      </div>
      {/* THE LOCKED STATE swaps the paid half — the chat with the `claude -p` brain — for the
          upsell, and NOTHING above this line changes: the header, the scope line, the needs-you
          counts and the per-project segments are all derived from local app state, cost nothing to
          run, and stay live. That adjacency is the design: the lock sells what the human is missing
          while sitting next to live proof it would be useful (Concierge/ConciergeAiLocked). */}
      {aiLock ? (
        <ConciergeAiLocked reason={aiLock} />
      ) : (
        <ConciergeThread
          messages={model.messages}
          typing={model.typing}
          onNudgeClick={controller.onNudgeClick}
          onNudgeAction={controller.onNudgeAction}
          onRedirect={controller.onRedirect}
          onDigestClick={controller.onDigestClick}
        />
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
      {approvalSlot}
      {/* Armed sends counting down (Concierge/CountdownBanner), directly above the box — the last
          thing between the user's words and an agent's terminal, so it sits where the eye already
          is after hitting Send. A SLOT, not a view-model field: the banner reads a module-level
          intent registry, and this column stays a pure renderer.
          It deliberately carries NO live region of its own — the single announcer below is fed by
          the host when an intent arms (a second region double-announces). */}
      {countdownSlot}
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
          onSend={controller.onSend}
          onAttach={controller.onAttach}
          onRemoveAttachment={controller.onRemoveAttachment}
          attachments={model.attachments}
          dropActive={model.dropActive}
          interim={interim}
          registerInsert={registerInsert}
          onTextEdit={onTextEdit}
        />
      )}
    </section>
  );
}
