// Trial overlay chrome shown over the Workspace while the user is in the anonymous trial:
// a small "Free trial · N prompts left" pill with an Unlock button, and — once the 100 are
// spent — a full-bleed upsell that reuses the Welcome screen with an exhausted banner. The
// Workspace stays mounted underneath (workers keep running) until the user converts.
import type { CSSProperties } from "react";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { useTrialStore, trialPromptsLeft, TRIAL_LIMIT } from "../stores/trialStore";
import { WelcomeScreen } from "./WelcomeScreen";

const pill: CSSProperties = {
  position: "fixed",
  top: 10,
  right: 12,
  zIndex: 9998,
  display: "flex",
  gap: 10,
  alignItems: "center",
  background: C.deepForest,
  border: `1px solid ${C.muted}`,
  borderRadius: 4,
  padding: "6px 12px",
  fontSize: 12,
  color: C.cream,
  fontFamily: '"IBM Plex Sans", sans-serif',
};
const unlockBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const failNote: CSSProperties = { color: DANGER, fontSize: 11, maxWidth: 220 };

export function TrialChrome({
  onUnlock,
  signInFailedUrl,
}: {
  onUnlock: () => void;
  signInFailedUrl: string | null;
}) {
  const promptsUsed = useTrialStore((s) => s.promptsUsed);
  const left = trialPromptsLeft({ promptsUsed });
  const exhausted = promptsUsed >= TRIAL_LIMIT;

  if (exhausted) {
    // Omit onTryFree so WelcomeScreen hides the free box — the only action here is to convert.
    return (
      <WelcomeScreen
        onSignIn={onUnlock}
        signInFailedUrl={signInFailedUrl}
        banner="You've used all 100 free prompts."
      />
    );
  }
  return (
    <div style={pill}>
      <span>
        Free trial · {left} prompt{left === 1 ? "" : "s"} left
      </span>
      <button style={unlockBtn} onClick={onUnlock}>
        Unlock
      </button>
      {signInFailedUrl && (
        <span style={failNote} role="alert">
          Couldn&apos;t open your browser —{" "}
          <span style={{ color: C.cream, userSelect: "text", wordBreak: "break-all" }}>{signInFailedUrl}</span>
        </span>
      )}
    </div>
  );
}
