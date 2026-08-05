// The app-shell "dictation fell back to the local engine" banner.
//
// WHAT IT COVERS THAT ITS SIBLINGS DO NOT. Dictation has two engines (see `dictation.rs`): the
// Deepgram relay, which streams live word-by-word INTERIM text — the provisional italic preview —
// and the on-device sherpa `OfflineRecognizer`, which decodes only CLOSED VAD segments and so has no
// interim results at all (`dictationStore.interim` is documented as `""` on that path). When the
// relay refuses, capture keeps working and the words still land, so nothing LOOKS broken — but the
// live preview STRUCTURALLY disappears. That is the specific failure this names.
//
// WHY IT IS WORTH A BANNER. The founder chased this twice as a bug — once as "the Deepgram text is
// still showing above the actual text", once hunting missing italics — because a silent engine swap
// is indistinguishable from a broken feature. A feature that vanishes without saying so is a TRUST
// failure, not an accuracy one: the transcript is fine, and the user is left believing the app is
// broken when it has merely changed engines. Per the founder's own framing, the place to say that is
// a bar across the TOP of the window naming the problem AND the remedy — nothing inside the composer
// or the mic UI, which is where they went looking and found nothing.
//
// Its siblings answer different questions: OfflineBanner is about the MACHINE's connectivity,
// ZeroCreditBanner about the BALANCE, and AiServiceBanner/ProviderUnavailableBanner about the user's
// own `claude` CLI. None of them fires when Sparkle's own transcription relay declines while the
// network, the balance and Claude Code are all fine — which is the common case here.
//
// COPY RULES, inherited from those siblings (AiServiceBanner's header states them):
//   • no PII, no raw error text, no status codes — the store only ever holds a coarse reason;
//   • don't blame the user's network (OfflineBanner's job) or their Claude allowance
//     (AiServiceBanner's job) — this is Sparkle's OWN dictation relay, so it is ours to own;
//   • say plainly WHAT IS LOST. That is the entire point: the live preview while you speak. Saying
//     only "degraded" would leave the user hunting for the missing italics all over again;
//   • state the remedy. Only the `exhausted` reason has one the user can act on, and it is phrased
//     as "Refill" so it cannot contradict ZeroCreditBanner / OutOfCreditsNotice, which is where the
//     actual affordance lives (no second Refill control here — at $0 that banner is already up).
//
// DISMISSIBLE, like AiServiceBanner: the user cannot fix an outage, and dictation keeps working
// underneath, so a ✕ that hides the nag for the episode is reasonable. The re-arm rule — a NEW
// reason speaks even over a dismissal, the same one does not — lives in the store, not here.
import { type CSSProperties } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import {
  shouldWarnLocalEngine,
  useDictationEngineStore,
  type DictationFallbackReason,
} from "../stores/dictationEngineStore";

/** One sentence per coarse reason. Both open with the SAME first clause — what was lost — because
 *  that is what the user noticed; the cause and the remedy follow. Neither carries a raw error, a
 *  status code, or any PII. */
const WARNING: Record<DictationFallbackReason, string> = {
  unavailable:
    "Live dictation preview is off — Sparkle can't reach the cloud transcription service, so dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word",
  exhausted:
    "Live dictation preview is off — you're out of Sparkle credits, so dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Refill your credits to get the live preview back",
};

// Brand amber is the theme-CONSTANT caution fill, so its ink is the constant brand navy (matching
// ZeroCreditBanner / AiServiceBanner) rather than the themed cream.
const INK = ON_BRAND_FILL_DARK;

const bar: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Positioning context for the out-of-flow ✕ (see ZeroCreditBanner for why it is pinned, not
  // pushed with marginLeft:auto).
  position: "relative",
  gap: 8,
  background: C.amber,
  color: INK,
  padding: "6px 32px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
};

const dismissBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  border: "none",
  padding: 2,
  margin: 0,
  cursor: "pointer",
  color: INK,
  lineHeight: 0,
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
};

export function DictationEngineBanner() {
  // Subscribe to the whole state and let the STORE decide — `shouldWarnLocalEngine` is the single
  // place that rule lives, so re-deriving `fallbackReason !== null && !dismissed` here would be a
  // second copy of it to drift.
  const engine = useDictationEngineStore((s) => s);
  const reason = engine.fallbackReason;

  // `reason` is always set when the predicate is true; the null check narrows it for the lookup
  // below so a partial state can never index `WARNING` with null.
  if (!shouldWarnLocalEngine(engine) || reason === null) return null;

  return (
    <div style={bar}>
      <FiAlertTriangle size={14} style={{ flex: "none" }} aria-hidden />
      {/* The live region wraps ONLY the sentence — with the ✕ inside it some screen readers
          re-announce the whole warning on the button's focus/state changes. */}
      <span role="status" aria-live="polite">
        {WARNING[reason]}.
      </span>
      <button
        type="button"
        // BOTH, deliberately: `title` is accname's last-resort name source, so a button whose only
        // child is aria-hidden must not depend on it for its name (see ZeroCreditBanner).
        aria-label="Dismiss"
        title="Dismiss"
        style={dismissBtn}
        onClick={() => useDictationEngineStore.getState().dismiss()}
      >
        <FiX size={14} aria-hidden />
      </button>
    </div>
  );
}
