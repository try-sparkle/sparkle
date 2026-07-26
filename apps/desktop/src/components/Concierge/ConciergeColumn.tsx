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
import type { ConciergeColumnProps, WordmarkMode } from "./types";

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
        <ScopeVitals
          pinnedProjectName={model.scope.pinnedProjectName}
          p0={model.vitals.p0}
          p1={model.vitals.p1}
        />
        {searchSlot && <div style={{ marginTop: 10 }}>{searchSlot}</div>}
      </div>
      <ConciergeThread
        messages={model.messages}
        typing={model.typing}
        onNudgeClick={controller.onNudgeClick}
        onNudgeAction={controller.onNudgeAction}
      />
      <ComposeBox
        onSend={controller.onSend}
        onMicToggle={controller.onMicToggle}
        onAttach={controller.onAttach}
        micLive={micLive}
        send={model.send}
        onToggleSendTarget={controller.onToggleSendTarget}
      />
    </section>
  );
}
