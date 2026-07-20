// Trial chrome shown while the user is in the anonymous "100 free prompts" trial. Two pieces:
//   • TrialIndicator — the small "Free trial · N prompts left" counter + Unlock button. It now
//     lives INLINE inside the TopBar row (rendered by TopBar, left of the Recent/Open/⋯
//     cluster) as plain bar text — NOT a floating pill. The old version was a position:fixed pill
//     pinned top-right, which sat on top of and covered the TopBar's action buttons; rendering it
//     in normal bar flow is the fix, so it can never overlap them.
//   • TrialChrome — once the 100 prompts are spent, a full-bleed upsell that reuses the Welcome
//     screen with an exhausted banner. The Workspace stays mounted underneath (workers keep
//     running) until the user converts.
import { useEffect, useState, type CSSProperties } from "react";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { useTrialStore, trialPromptsLeft, TRIAL_LIMIT } from "../stores/trialStore";
import { copyToClipboard } from "../clipboard";
import { WelcomeScreen } from "./WelcomeScreen";

// Plain in-bar layout — deliberately NO background / border / fixed positioning. It reads as bar
// text alongside the other TopBar controls. minWidth:0 + flexShrink lets it yield space rather
// than push the action buttons off the right edge (the very overlap this component set out to fix).
const indicator: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  fontSize: 12,
  color: C.cream,
  fontFamily: '"IBM Plex Sans", sans-serif',
  minWidth: 0,
  flexShrink: 1,
  overflow: "hidden",
};
const counterText: CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
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
  flexShrink: 0,
  whiteSpace: "nowrap",
};
// Bounded so the fallback can't widen the bar and shove the action buttons off-screen.
const failNote: CSSProperties = { color: DANGER, fontSize: 11, whiteSpace: "nowrap" };
const copyLinkBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

/**
 * The small in-bar trial indicator (counter + Unlock). Rendered by TopBar in trial mode only.
 * Returns null once the trial is exhausted — the full-screen TrialChrome upsell takes over then.
 * `onUnlock` MUST route through the shared paywall handler (see performTrialUnlock), never bare
 * sign-in, so a signed-in user converts via one-click Stripe.
 */
export function TrialIndicator({
  onUnlock,
  signInFailedUrl,
}: {
  onUnlock: () => void;
  signInFailedUrl: string | null;
}) {
  const promptsUsed = useTrialStore((s) => s.promptsUsed);
  const left = trialPromptsLeft({ promptsUsed });
  const [copied, setCopied] = useState(false);
  // Reset the "Copied" affordance whenever the fallback URL changes, so a later hand-off failure
  // (a different link) doesn't falsely read as already-copied.
  useEffect(() => setCopied(false), [signInFailedUrl]);
  if (promptsUsed >= TRIAL_LIMIT) return null;
  return (
    <div style={indicator} data-testid="trial-indicator">
      <span style={counterText}>
        Free trial · {left} prompt{left === 1 ? "" : "s"} left
      </span>
      <button style={unlockBtn} onClick={onUnlock}>
        Unlock
      </button>
      {signInFailedUrl && (
        // The browser hand-off failed. Show a compact, bounded fallback — a "Copy" button rather
        // than the raw (often long Stripe/sign-in) URL inline, so the note can never widen the
        // TopBar AND the user can actually recover the link in one click.
        <span style={failNote} role="alert">
          Couldn&apos;t open your browser.{" "}
          <button
            style={copyLinkBtn}
            onClick={() => {
              void copyToClipboard(signInFailedUrl).then((ok) => ok && setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy sign-in link"}
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * Full-screen upsell shown once the 100 free prompts are spent. Rendered by AuthGate in the trial
 * branch; a no-op (null) until the trial is exhausted, so the Workspace shows through until then.
 */
export function TrialChrome({
  onUnlock,
  signInFailedUrl,
}: {
  onUnlock: () => void;
  signInFailedUrl: string | null;
}) {
  const promptsUsed = useTrialStore((s) => s.promptsUsed);
  if (promptsUsed < TRIAL_LIMIT) return null;
  // Omit onTryFree so WelcomeScreen hides the free box — the only action here is to convert.
  return (
    <WelcomeScreen
      onSignIn={onUnlock}
      signInFailedUrl={signInFailedUrl}
      banner="You've used all 100 free prompts."
    />
  );
}
