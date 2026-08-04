// The rich (styled) stand-in for a native textarea placeholder.
//
// WHY AN OVERLAY AT ALL. A native `placeholder=` is one flat string: it cannot render "Hey Sparkle"
// bold + brand blue inside an otherwise muted sentence. So a composer keeps the native placeholder
// EMPTY in this state and paints the copy itself, absolutely positioned over the textarea's first
// text line.
//
// This module is the single home for everything subtle about that overlay — the click-through /
// stacking contract, the right-edge reservation for the suggestion pill, the per-voice-state copy,
// and the two failure notices that take the slot over. The Concierge ComposeBox is its first
// consumer. The build Composer (components/Composer.tsx) still carries its own inline copy of the
// same rendering, written before this module existed; the two agree today because both read the
// SAME words from voice/dictationCopy and the SAME state from voice/micPresentation, which is what
// bounds the drift. Migrating Composer.tsx onto these components is a mechanical follow-up and is
// the point of extracting them — do that rather than adding a third copy.
import type { CSSProperties, ReactNode } from "react";
import { FiAlertTriangle, FiDownloadCloud } from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { useDictationStore } from "../../stores/dictationStore";
import { SUGGESTION_PILL_ZONE } from "./SuggestionRow";
import {
  MICROPHONE_SETTINGS_URL,
  PAUSED_TERMINAL_ACTION,
  PAUSED_TERMINAL_HEADLINE,
  PREPARING_PREFIX,
  PREPARING_SUFFIX,
  PTT_COMPOSER_PLACEHOLDER,
  SPEAK_COMPOSER_PLACEHOLDER,
  modelPercent,
  pausedComposerPlaceholder,
  type VoiceErrorNotice,
} from "../../voice/dictationCopy";
import type { MicCaptionKind, MicPresentation } from "../../voice/micPresentation";
import type { PauseReason } from "../../voice/dictationFocus";

/** How much room the overlay must leave at the textarea's TRAILING-RIGHT edge.
 *
 *  SuggestionRow's "overlay" layout is absolutely pinned to that edge, NOT a width-eating sibling —
 *  so nothing in normal layout stops a long placeholder sentence from sliding underneath the
 *  (translucent) pill and rendering as two overlapping texts. The fix is this reservation: while a
 *  pill is up, the placeholder's right inset becomes the pill's OWN full footprint, so the copy
 *  wraps EARLY instead of colliding.
 *
 *  Derived from SUGGESTION_PILL_ZONE — which is itself derived from the pill's own max label width
 *  plus its chrome — rather than a magic number, so the reservation and the pill can never drift.
 *  `resting` is the composer's ordinary inset (its border + horizontal padding), which differs
 *  between composers, hence a parameter.
 *
 *  NOTE this only applies to the "overlay" pill layout. A host rendering SuggestionRow with
 *  layout="row" (a static strip in its own box, which is what the concierge column does) has no
 *  collision to avoid and passes `hasSuggestionPill: false`.
 *
 *  Pure + exported so the invariant is unit-tested directly. */
export function placeholderRightInset(hasSuggestionPill: boolean, resting: number): number {
  return hasSuggestionPill ? SUGGESTION_PILL_ZONE : resting;
}

/** Where the overlay's first text line sits, matching the textarea's border + padding so the
 *  painted copy lands exactly where a native placeholder would. */
export interface PlaceholderInset {
  top: number;
  left: number;
  /** The RESTING right inset (no pill up). See placeholderRightInset. */
  right: number;
  /** Optional bottom inset. Supply it in a FIXED-HEIGHT box: an absolute overlay is not clipped by
   *  the textarea the way a native placeholder is, so without a bottom edge, copy too long for the
   *  box spills out past it and paints over whatever sits below. With it (plus the `overflow:
   *  hidden` below) the copy clips at the box's edge exactly like a native placeholder would.
   *  Omit in an auto-growing box, which has no edge to clip against. */
  bottom?: number;
}

/** Type ramp of the textarea the overlay stands in for — must match it or the copy won't align. */
export interface PlaceholderType {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export function RichPlaceholderOverlay({
  inset,
  type,
  hasSuggestionPill,
  announce = false,
  testId,
  children,
}: {
  inset: PlaceholderInset;
  type: PlaceholderType;
  /** True when SuggestionRow's OVERLAY layout is painting its pill over this same textarea. */
  hasSuggestionPill: boolean;
  /** `true` → role="status" (the content is a state change a screen reader must hear, e.g. a voice
   *  failure). `false` → aria-hidden: a decorative stand-in for a placeholder, announced instead
   *  through the textarea's own accessible name. Note aria-hidden hides the WHOLE subtree with no
   *  way for a descendant to opt back in, which is why an announceable notice with its own controls
   *  must be a SIBLING overlay with `announce`, never a branch inside the decorative one. */
  announce?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    position: "absolute",
    // Stack ABOVE the textarea (which the host puts at zIndex 1). The overlay itself is
    // pointerEvents:none, so clicks on the placeholder still pass THROUGH to the textarea beneath
    // (focus works); but interactive children — the out-of-credits "Refill" link, the voice error's
    // Dismiss — re-enable pointerEvents on themselves, and they can only receive that click if the
    // overlay isn't buried under the textarea. Without this the textarea swallowed the click and
    // Refill looked clickable but did nothing.
    zIndex: 2,
    top: inset.top,
    left: inset.left,
    right: placeholderRightInset(hasSuggestionPill, inset.right),
    bottom: inset.bottom,
    // Only bites when `bottom` is set: keeps copy too long for a fixed-height box clipped at that
    // box's edge, the way a native placeholder is, instead of spilling out over its neighbours.
    overflow: inset.bottom === undefined ? undefined : "hidden",
    pointerEvents: "none",
    color: C.muted,
    fontFamily: type.fontFamily,
    fontSize: type.fontSize,
    lineHeight: type.lineHeight,
  };
  return announce ? (
    <div role="status" data-testid={testId} style={style}>
      {children}
    </div>
  ) : (
    <div aria-hidden data-testid={testId} style={style}>
      {children}
    </div>
  );
}

/** The one emphasized run inside an otherwise muted placeholder sentence: bold, in solid brand blue
 *  (C.teal). It is what a native `placeholder=` cannot do, and therefore the entire reason this
 *  overlay exists. Used for the wake phrase ("Hey Sparkle") and the stop phrase. (The cyan→blue
 *  gradient fade was dropped per design feedback.) */
export function PlaceholderEmphasis({ phrase }: { phrase: string }) {
  return <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.tealInk }}>{phrase}</span>;
}

/** The one-time voice-model download, shown in the placeholder slot. Deliberately quiet (the same
 *  muted voice as the wake-word copy it replaces) — this is a wait, not a problem. The
 *  download-cloud glyph matches the mic's own preparing glyph, so the two surfaces read as one
 *  state. `pct` is null when the backend reports no content-length. */
export function PreparingNotice({ pct }: { pct: number | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <FiDownloadCloud size={14} className="sparkle-pulse" aria-hidden style={{ flexShrink: 0 }} />
      <span>
        {PREPARING_PREFIX}
        {pct !== null ? (
          <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.tealInk }}> ({pct}%)</span>
        ) : (
          "…"
        )}
        {PREPARING_SUFFIX}
      </span>
    </span>
  );
}

/** Shared style for the inline actions in the voice-error notice — matches RefillLink's treatment
 *  in the out-of-credits notice (the sibling control in this same slot). `pointerEvents: auto` is
 *  required: the placeholder overlay these render inside is pointerEvents:none. */
const VOICE_ERROR_ACTION: CSSProperties = {
  pointerEvents: "auto",
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  font: "inherit",
  fontWeight: FONT_WEIGHT.bold,
  color: C.tealInk,
};

/** A dictation failure, rendered in a composer's placeholder slot — beside the mic the user
 *  actually clicked. Headline names what broke; detail names the remedy (or, for an unrecognized
 *  error, carries the raw backend string so the cause stays discoverable). Amber + an alert glyph
 *  make it legible without shouting; a heavier treatment (modal/banner) would be out of proportion
 *  for a mic that can simply be turned back on. Dismiss clears dictationStore.error, which also
 *  returns status to idle (see setError).
 *
 *  It carries its own controls, so its host must render it inside an `announce` overlay — an
 *  aria-hidden one would bury Dismiss from a screen reader (see RichPlaceholderOverlay). */
export function ComposerVoiceError({ notice }: { notice: VoiceErrorNotice }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 6, color: C.amber }}>
      <FiAlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        <span style={{ fontWeight: FONT_WEIGHT.bold }}>{notice.headline}</span>{" "}
        <span style={{ color: C.muted }}>{notice.detail}</span>{" "}
        {/* The separating space belongs INSIDE this branch, with the button it separates: hanging
            it off the ternary would also emit it when the branch renders null, double-spacing the
            non-permission notices (roborev 37737). */}
        {notice.kind === "permission" ? (
          // Only `permission` earns this: it is the one bucket whose remedy lives in a specific
          // System Settings pane we can deep-link to, and macOS will never re-prompt, so telling
          // the user to "turn the mic back on" alone would loop them straight back here. Reading a
          // path out of a sentence and then hunting for it in System Settings is the step users
          // actually drop out on; one click removes it. (A NotDetermined user never sees this —
          // the backend prompts them instead. See mic_permission.rs's `decide`.)
          <>
            <button
              type="button"
              onClick={() => {
                void openUrl(MICROPHONE_SETTINGS_URL).catch((e) =>
                  // The pane failing to open must not also swallow the notice — the detail line
                  // still spells out the path, so the user keeps a way through.
                  console.warn("voice: open microphone settings failed", e),
                );
              }}
              style={VOICE_ERROR_ACTION}
            >
              Open System Settings
            </button>{" "}
          </>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss voice error"
          // A bare clear, deliberately — same rule as Composer.tsx's Dismiss. Dismiss means "I've
          // read this", not "the mic works again"; only `dictation://audio-recovered` knows frames
          // resumed, so only that path restores "listening". Claiming it here would repaint a live
          // mic over one that is still dead — the very incident this notice exists to surface.
          onClick={() => useDictationStore.getState().setError(null)}
          style={VOICE_ERROR_ACTION}
        >
          Dismiss
        </button>
      </span>
    </span>
  );
}

/** The per-voice-state placeholder copy, straight out of voice/dictationCopy so no composer can
 *  reword it locally. Handles only the states whose copy is universal across composers.
 *
 *  `outOfCredits` and `error` are NOT this component's to paint: each carries an interactive
 *  control (Refill / Dismiss) whose plumbing belongs to the composer that owns the slot, so callers
 *  branch on those BEFORE delegating here. They render NOTHING rather than falling through to
 *  `fallback`, and that is the load-bearing part: a caller that forgets to branch gets an empty
 *  slot (visibly missing) instead of a composer cheerfully inviting the user to speak at the exact
 *  moment dictation has failed or the mic was refused for lack of credits.
 *
 *  `off` (master mute) has no universal answer either — the build Composer makes no voice promise
 *  at all (null), while the concierge box uses the slot to say what it is FOR — so it, and only it,
 *  renders `fallback`.
 *
 *  The switch is TOTAL: every MicPresentation member has its own arm and `default` is the `never`
 *  exhaustiveness guard, so a new member is a COMPILE error here rather than a silently-empty (or
 *  silently-wrong) slot in whichever composer forgot about it. */
export function VoicePlaceholderCopy({
  micPresentation,
  captionKind,
  modelProgress,
  pauseReason = null,
  fallback = null,
}: {
  micPresentation: MicPresentation;
  /**
   * WHICH live sentence to show, from the TRAY POSITION — the same value, from the same function
   * (voice/micPresentation `micCaptionKind`), that the sidebar caption renders from.
   *
   * ── WHY THE PRESENTATION IS NOT ENOUGH ON ITS OWN ─────────────────────────────────────────────
   * `micPresentation` answers "what is the microphone DOING" and it is still what selects the arm.
   * But the two LIVE arms need a second fact it cannot carry: WHICH MODE the user is working in.
   * `activeListening` is reached both by Speak and by a push-to-talk HOLD, and the true sentence
   * differs — Speak ends an utterance when you stop talking, a hold ends when you let go. Keyed on
   * the presentation alone, a hold was shown Speak's "pause when you're done", which is the same
   * defect that had push-to-talk showing wake-word copy: a caption describing the wrong mode.
   *
   * Taken as a PROP rather than read from the store here so this component stays pure (it renders
   * words, it decides nothing) — the caller reads it, exactly as it reads `micPresentation`.
   */
  captionKind: MicCaptionKind;
  modelProgress: { done: number; total: number | null } | null;
  /** WHY the mic is paused, for the `focusPaused` arm alone. A pause with no stated cause is what
   *  left the terminal case reading as a bug, so the arm names what took the keyboard. Defaults to
   *  null, which keeps the long-standing window wording — the honest general case. */
  pauseReason?: PauseReason | null;
  /** Rendered for `off` alone — the one state whose answer is the caller's to give. */
  fallback?: ReactNode;
}) {
  switch (micPresentation) {
    case "off":
      // Master mute: no voice promise to make, so the caller's own words (or nothing) take the slot.
      return <>{fallback}</>;
    case "error":
    case "outOfCredits":
      // Owned by the caller — see the doc block. Nothing here, deliberately: `fallback` would be an
      // invitation to speak over a mic that just failed.
      return null;
    case "preparing":
      // Honest + quiet: names the wait, shows progress when the backend gives a total, and points
      // at the box the user can still type in.
      return <PreparingNotice pct={modelPercent(modelProgress)} />;
    case "activeListening":
    case "passiveWaiting":
      // CAPTURE IS LIVE. Both live states share one arm because what separates them — is speech
      // routing at this instant — is NOT what the user needs the sentence to tell them. The mode is.
      // A push-to-talk hold (activeListening) and the same tray between holds (passiveWaiting) get
      // the same sentence, and it is true in both: "Hold ⌘ to talk". Splitting them by phase is what
      // made this slot flicker between two different promises mid-utterance.
      //
      // Each sentence subsumes the typing hint ("…or type here instead" / "pause when you're done")
      // so the slot stays put on focus rather than swapping to a muted hint.
      //
      // `none` means the tray is on Send while some OTHER surface holds the mic — this box is not
      // where that speech is going, so it promises nothing and yields the slot to the caller's own
      // words, exactly as the sidebar suppresses its caption in the same state.
      if (captionKind === "none") return <>{fallback}</>;
      return (
        <>
          {captionKind === "pushToTalk" ? PTT_COMPOSER_PLACEHOLDER : SPEAK_COMPOSER_PLACEHOLDER}
        </>
      );
    case "focusPaused":
      // Armed but NOT capturing (another window, the caret in a terminal, muted, or capture not
      // started yet). The mic can't hear anything, so — exactly like the sidebar's "Listening
      // paused" caption — say so instead of inviting the wake word. The words come from the same
      // module the sidebar's do, keyed on the same reason.
      //
      // THE TERMINAL CASE IS A TWO-LINE, CENTERED NOTICE (founder's copy) and the other causes are
      // NOT. That fork is deliberate, not an oversight: the cause is dropped here because on this
      // surface the user already knows why the caret left, whereas the general pause still has to
      // say what it is waiting for. Anything that is a real FAILURE never reaches this arm at all —
      // it renders through `error`/`voiceErrorNotice`, which names its own cause.
      //
      // Clickability is UNCHANGED. The whole overlay is `pointerEvents: none`, so this block is
      // painted over the textarea and the click lands on the textarea beneath — which is what
      // resumes listening. Do not give these spans a handler or `pointerEvents: auto` "to make the
      // notice clickable": that would MOVE the click target off the box and is the one way to break
      // a behaviour this change is not supposed to touch.
      if (pauseReason === "terminal") {
        return (
          <span style={{ display: "block", textAlign: "center" }}>
            <span style={{ display: "block", fontWeight: FONT_WEIGHT.bold }}>
              {PAUSED_TERMINAL_HEADLINE}
            </span>
            <span style={{ display: "block" }}>{PAUSED_TERMINAL_ACTION}</span>
          </span>
        );
      }
      return <>{pausedComposerPlaceholder(pauseReason)}</>;
    default: {
      // Unreachable: every member above has an arm. This is the exhaustiveness guard — adding a
      // MicPresentation member fails to compile here until someone decides what it should say.
      const unhandled: never = micPresentation;
      void unhandled;
      return null;
    }
  }
}
