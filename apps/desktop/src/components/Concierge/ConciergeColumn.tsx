// The Concierge column shell — the persistent left column that is the user's cross-project
// minder (PRD/sparkle/concierge-mode.md; look/feel from the canonical prototype). Fixed-width
// flex column on the deepForest sidebar surface: header (remaining-credit badge top-right, the
// Sparkle.ai mark centered inside the star field under it, then the voice waveform and scope +
// vitals), the chat thread, and the compose box. Verdana per the approved design — the concierge
// deliberately doesn't share the workspace's UI font.
//
// The THREAD is purely presentational: everything in it comes from the ConciergeViewModel and every
// gesture leaves through the ConciergeController (see ./types). The two BRAND-CHROME pieces in the
// header — the voice waveform and the credit badge — are the deliberate exception: they moved here
// from the builder column (PRD/sparkle/concierge-chrome-and-credits.md) and read their own stores,
// exactly as they did there. Routing them through the view-model would have meant teaching the
// concierge's data layer about the mic and the entitlement for no gain; the column stays a pure
// renderer of everything it is actually GIVEN.
import { C } from "../../theme/colors";
import { BalanceBadge } from "../BalanceBadge";
import { LogoWaveform } from "../LogoWaveform";
import { SparkleLogoLink } from "../SparkleLogoLink";
import { ComposeBox } from "./ComposeBox";
import { ConciergeThread } from "./ConciergeThread";
import { ScopeVitals } from "./ScopeVitals";
import { StarfieldWordmark } from "./StarfieldWordmark";
import type { ConciergeAnnouncement, ConciergeColumnProps, WordmarkMode } from "./types";

/** Nothing announced yet. Module-level so the default prop is referentially stable. */
const EMPTY_ANNOUNCEMENT: ConciergeAnnouncement = { seq: 0, text: "" };

/** LogoWaveform carries its own 14px side padding (it used to be a direct child of the builder
 *  column, which had none). Pull it back out so the bars line up with the mark above and the scope
 *  line below instead of sitting inset by header-padding + its own. */
const WAVEFORM_INSET = -14;

/** The wordmark's drive when the integration doesn't pass one explicitly: buzz hard while
 *  the mic is live, gently while Sparkle types, still otherwise. Exported pure for tests. */
export function deriveWordmarkMode(micLive: boolean, typing: boolean): WordmarkMode {
  if (micLive) return "listening";
  if (typing) return "speaking";
  return "idle";
}

export function ConciergeColumn({
  model,
  controller,
  micLive = false,
  wordmarkMode,
  width = 380,
  searchSlot,
  suggestionsSlot,
  interim = "",
  registerInsert,
  speakingMessageId = null,
  onTextEdit,
  announcement = EMPTY_ANNOUNCEMENT,
}: ConciergeColumnProps) {
  const mode = wordmarkMode ?? deriveWordmarkMode(micLive, model.typing ?? false);
  return (
    <section
      aria-label="Sparkle concierge"
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
        borderRight: `1px solid color-mix(in srgb, ${C.muted} 25%, transparent)`,
        color: C.cream,
        fontFamily: "Verdana, Geneva, sans-serif",
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div style={{ position: "relative", flex: "none", padding: "16px 16px 12px" }}>
        {/* The remaining-credit badge, alone on its own row, hard right — the prototype's
            top-right `.spend` pill position, as a flex row rather than the absolutely-positioned
            pill that used to sit here: an absolute pill can only be kept off the star field by
            hand-tuned offsets, and the field's canvas is the exact kind of neighbor that silently
            ends up underneath one. This shows credits REMAINING (counting down), which is the
            number the founder acts on — the deleted SpendPill showed a locally-derived trailing-24h
            spend ESTIMATE that only ever counted up and was never billed. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <BalanceBadge />
        </div>
        {/* The ONE brand mark in this header: the Sparkle.ai logo, centered inside the star
            field's box. The field used to paint the literal word "Sparkle" here, which — once the
            logo moved into this column — put the brand name on screen twice within ~80px, left-
            aligned above centered, with two adjacent elements whose accessible name was "Sparkle".
            Nesting the logo in the field keeps the founder's requested mark AND the field's
            voice-state animation (idle drift → buzz while listening/speaking), instead of trading
            one away for the other. Centered to match the scope/vitals lines underneath. */}
        <StarfieldWordmark mode={mode}>
          <SparkleLogoLink />
        </StarfieldWordmark>
        {/* The always-listening voice ring + waveform, directly under the mark as its name says.
            It followed the logo out of the builder column: the mic is Sparkle's, not a per-project
            build tool, and it belongs beside the box you talk into. Two voice surfaces here, not
            three, and they say different things: the star field is the CONVERSATION's state — it
            buzzes while Sparkle types a reply, which a mic meter can't show — and the waveform is
            the live level of your own microphone. */}
        <div style={{ marginLeft: WAVEFORM_INSET, marginRight: WAVEFORM_INSET }}>
          <LogoWaveform />
        </div>
        <ScopeVitals pinnedProjectName={model.scope.pinnedProjectName} counts={model.vitals} />
        {searchSlot && <div style={{ marginTop: 10 }}>{searchSlot}</div>}
      </div>
      <ConciergeThread
        messages={model.messages}
        typing={model.typing}
        onNudgeClick={controller.onNudgeClick}
        onNudgeAction={controller.onNudgeAction}
        onSpeak={controller.onSpeak}
        speakingMessageId={speakingMessageId}
        onRedirect={controller.onRedirect}
        onDigestClick={controller.onDigestClick}
      />
      {/* Recommended actions for the actively-shown build agent, pinned directly above the box —
          where they sat in the removed AgentPane composer. A SLOT, not a view-model field: the row
          owns a per-agent hook that must remount when the agent changes, so the host mounts it
          keyed (see ConciergeSuggestions) and this column stays a pure renderer. */}
      {suggestionsSlot}
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
      <ComposeBox
        onSend={controller.onSend}
        onMicToggle={controller.onMicToggle}
        onAttach={controller.onAttach}
        onRemoveAttachment={controller.onRemoveAttachment}
        attachments={model.attachments}
        dropActive={model.dropActive}
        micLive={micLive}
        interim={interim}
        registerInsert={registerInsert}
        onTextEdit={onTextEdit}
      />
    </section>
  );
}
