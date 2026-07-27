// Spoken concierge replies (bead sparkle-4562.2 / CM-U9) — the output half of the concierge voice
// pass. The audio path itself is the already-landed ElevenLabs service from the Living Sparkle
// Overlay batch (voice/tts/ttsService.ts); this module is only the GATE in front of it, so the
// concierge can never talk at someone who asked for quiet.
//
// Two entry points, deliberately gated differently:
//   • speakConciergeReply — AUTOPLAY. Fires only for a turn the user started BY VOICE, and only
//     while the do-not-interrupt store allows CONCIERGE_VOICE_TOPIC. A TYPED turn stays silent:
//     Concierge Mode v1 is text-first (PRD/sparkle/concierge-mode.md §3), so typing must not
//     suddenly make the app speak.
//   • speakOnDemand — the per-reply speaker button. An explicit click is not an interruption, so
//     the do-not-interrupt rule does not apply to it; the VOICE_ENABLED kill switch still does
//     (speak() itself returns "disabled" in that case).

import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { isVoiceEnabled, speak, stopVoice, type TtsPath } from "../voice/tts/ttsService";

/** The do-not-interrupt topic that mutes spoken concierge replies. Namespaced like the feed's
 *  topics (services/conciergeFeed.ts `conciergeTopics`) so one settings UI can list them together,
 *  and so muting a spoken reply can never be confused with muting an agent id. */
export const CONCIERGE_VOICE_TOPIC = "concierge:voice";

/** What actually happened to a speak request. "suppressed" = the gate refused before any audio. */
export type ConciergeSpeakResult = TtsPath | "suppressed";

export interface ConciergeVoiceGate {
  /** True when THIS turn was started by voice (the concierge mic was live at send time). */
  voiceTurn: boolean;
  /** Defaults to the ttsService kill switch. */
  voiceEnabled?: boolean;
  /** Defaults to the live sparklePrefsStore rule set. */
  shouldInterrupt?: (topic: string) => boolean;
}

/** May the concierge speak this reply unprompted? Pure given its deps, so the quiet rule is
 *  testable without touching audio. */
export function shouldSpeakConciergeReply(gate: ConciergeVoiceGate): boolean {
  if (!gate.voiceTurn) return false;
  if (!(gate.voiceEnabled ?? isVoiceEnabled())) return false;
  const mayInterrupt =
    gate.shouldInterrupt ?? ((t: string) => useSparklePrefsStore.getState().shouldInterrupt(t));
  return mayInterrupt(CONCIERGE_VOICE_TOPIC);
}

/** Speak a finished brain reply, but only when {@link shouldSpeakConciergeReply} allows it. */
export async function speakConciergeReply(
  text: string,
  gate: ConciergeVoiceGate,
): Promise<ConciergeSpeakResult> {
  const t = text.trim();
  if (!t) return "suppressed";
  if (!shouldSpeakConciergeReply(gate)) return "suppressed";
  return speak(t);
}

/** Speak a reply because the user asked for it (the speaker button on the bubble). */
export async function speakOnDemand(text: string): Promise<ConciergeSpeakResult> {
  const t = text.trim();
  if (!t) return "suppressed";
  return speak(t);
}

/** Cut playback short — barge-in when the user starts talking or sends a new turn. */
export function stopConciergeVoice(): void {
  stopVoice();
}
