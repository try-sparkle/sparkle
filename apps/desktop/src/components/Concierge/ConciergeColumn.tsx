// The Concierge column shell — the persistent left column that is the user's cross-project
// minder (PRD/sparkle/concierge-mode.md; look/feel from the canonical prototype). Fixed-width
// flex column on the deepForest sidebar surface: star-field wordmark header (spend pill
// top-right, scope + vitals under it), the chat thread, and the compose box. Verdana per the
// approved design — the concierge deliberately doesn't share the workspace's UI font.
//
// Purely presentational: everything rendered comes from the ConciergeViewModel, every gesture
// leaves through the ConciergeController (see ./types). The integration unit mounts and
// drives it; this file never touches app state.
import { C } from "../../theme/colors";
import { ComposeBox } from "./ComposeBox";
import { ConciergeThread } from "./ConciergeThread";
import { ScopeVitals } from "./ScopeVitals";
import { SpendPill } from "./SpendPill";
import { StarfieldWordmark } from "./StarfieldWordmark";
import type { ConciergeAnnouncement, ConciergeColumnProps, WordmarkMode } from "./types";

/** Nothing announced yet. Module-level so the default prop is referentially stable. */
const EMPTY_ANNOUNCEMENT: ConciergeAnnouncement = { seq: 0, text: "" };

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
        <SpendPill amountText={model.spend.amountText} />
        <StarfieldWordmark mode={mode} />
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
