import { copyToClipboard } from "../clipboard";

/**
 * The dictation → clipboard mirror.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The founder's ask, verbatim: *"everything that I speak gets copied to my clipboard as an optional
 * setting that I can change in the settings menu. The reason I want this is that it doesn't always
 * paste into The chat, and I want to have it in my clipboard to be able to manually paste it in if
 * necessary."*
 *
 * The REASON is the specification. This is a recovery path for a transcript that never reached the
 * composer.
 *
 * ── STILL UNWIRED. THIS SECTION IS A CONTRACT FOR WHOEVER WIRES IT, NOT A DESCRIPTION ───────────
 * Nothing imports `mirrorDictatedSegment` yet, and an earlier version of this header described the
 * call site in the present tense as though it existed (roborev 59596). It does not. Two MUSTs for
 * the wiring change:
 *
 *   1. The feed MUST sit at the TOP of `deliverCommittedSegment` — above `isTerminalRoutable()`,
 *      above `isRoutable()`, above every gate that can drop a segment silently (`useDictation.ts`).
 *      A mirror placed after those gates copies only the text that already landed and goes quiet in
 *      exactly the cases it exists to rescue. Moving the call downward deletes the feature while
 *      leaving its tests green.
 *   2. The same change MUST wire `resetDictationClipboard()` at both boundaries named on that
 *      function — a send/dispatch, and a fresh dictation episode. Landing the feed WITHOUT the
 *      resets gives a buffer that never clears for the process lifetime, so every paste hands back
 *      the whole session's speech up to the cap. The cap is a safety valve, not a reset.
 *
 * ── NOT `dictationCopy.ts` ──────────────────────────────────────────────────────────────────────
 * There is a `voice/dictationCopy.ts` next to this file and it is NOT about the clipboard: "copy"
 * there means user-facing WORDING — placeholders and captions. The two names are one word apart and
 * mean unrelated things; clipboard logic belongs here, wording belongs there.
 *
 * ── THE UNIT: RUNNING TEXT, NOT THE LAST UTTERANCE ──────────────────────────────────────────────
 * The founder chose this over per-utterance. Each finalized segment replaces the clipboard with
 * EVERYTHING said since the buffer last reset, so one paste recovers a whole message even when it
 * spanned three pauses. Per-utterance would hand back only the final fragment — and a message that
 * came out in fragments is precisely when someone reaches for this.
 *
 * That choice is what makes the RESET BOUNDARIES load-bearing; see `resetDictationClipboard`.
 */

/**
 * The safety valve — and ONLY that. It is not a reset, and it is reachable today by construction:
 * no reset boundary is wired yet (see the header), so a long session walks straight into it. Once
 * both boundaries are wired it becomes the rare case it was written for — a Speak session left
 * armed for an hour with nothing ever dispatched — and exists so "the buffer is unbounded" is never
 * literally true.
 *
 * WHEN IT TRIPS IT KEEPS THE NEWEST TEXT. Dropping the START of a message would be the same silent
 * beginning-of-message loss this whole feature exists to prevent, so the cap trims from the front
 * and says so in the log.
 */
export const DICTATION_CLIPBOARD_CAP = 20_000;

/**
 * Join a new segment onto the running buffer.
 *
 * THIS IS THE ONE IMPLEMENTATION OF THE RULE. `appendDictated` in
 * `components/Concierge/ComposeBox.tsx` delegates to it, because the clipboard has to hold what the
 * composer should have held — a mirror that spaces its words differently from the box it mirrors is
 * a mirror you cannot trust to paste.
 *
 * It used to be re-implemented there, byte-identical, behind a comment claiming a cross-checking
 * test that did not exist (roborev 59596): the suite asserted this copy against hardcoded strings
 * and never imported the other one at all. Delegation replaced the guard-that-wasn't — the drift is
 * now unrepresentable rather than merely tested for. The direction matters: the React-free module
 * owns the rule, so reusing it never means importing a component.
 */
export function appendDictatedForClipboard(current: string, segment: string): string {
  const chunk = segment.trim();
  if (!chunk) return current;
  if (!current) return chunk;
  return current.endsWith(" ") ? `${current}${chunk}` : `${current} ${chunk}`;
}

/** Trim from the FRONT, never the back — see DICTATION_CLIPBOARD_CAP. */
export function capDictationBuffer(
  text: string,
  cap: number = DICTATION_CLIPBOARD_CAP,
): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(text.length - cap), truncated: true };
}

// ── THE BUFFER ──────────────────────────────────────────────────────────────────────────────────
// Module-level rather than a store field, and that is not laziness: nothing RENDERS this. It is
// written on a transcript arriving and read only to hand to the clipboard, so putting it in a
// zustand store would subscribe every mic surface to a value none of them paint and re-render the
// composer on every syllable.
let buffer = "";

/**
 * Clear the running buffer. ZERO PRODUCTION CALLERS TODAY — this is the other half of the wiring
 * contract in the header, and naming the boundaries here is what stops the feed landing without it.
 *
 * THE TWO BOUNDARIES, both required:
 *   - a SEND/DISPATCH of the composed message — the buffer's whole unit is "everything said since
 *     the last reset", so a message that has gone must not be glued to the next one; and
 *   - the START of a fresh dictation episode (the passive→active arm), which covers a session the
 *     user abandoned without sending.
 *
 * Wire the feed without these and the buffer never clears for the process lifetime: every paste
 * hands back the whole session's speech up to `DICTATION_CLIPBOARD_CAP`, which is a safety valve
 * and not a substitute for this.
 */
export function resetDictationClipboard(): void {
  buffer = "";
}

/** Test seam only — production reads the clipboard, not this. */
export function peekDictationClipboardBuffer(): string {
  return buffer;
}

/**
 * Fold one committed segment into the running buffer and return what the clipboard should now hold.
 * Returns `null` when there is nothing to write (a whitespace-only segment), so the caller can skip
 * a pointless clipboard write rather than stomping the clipboard with an unchanged value.
 *
 * PURE-ISH BY DESIGN: it mutates only this module's buffer and touches no store and no DOM, so the
 * unit rule and both reset boundaries are testable without jsdom or a mocked clipboard.
 */
export function noteDictatedSegment(segment: string): string | null {
  const next = appendDictatedForClipboard(buffer, segment);
  if (next === buffer) return null;
  const { text, truncated } = capDictationBuffer(next);
  if (truncated) {
    // The count, never the transcript — dictation captures whatever was said near the microphone,
    // which is not all of it meant for a log (the rule is stated at useDictation.ts and
    // src-tauri/src/dictation.rs::emit_partial).
    console.info("[dictation] clipboard buffer hit its cap; kept the newest text", {
      chars: text.length,
      dropped: next.length - text.length,
    });
  }
  buffer = text;
  return text;
}

/**
 * Write a committed segment to the clipboard, if the user has asked for that.
 *
 * `enabled` is passed in rather than read from the store here so the decision stays at the call
 * site and this module has no store dependency to mock.
 *
 * ── IT MUST NEVER BREAK DELIVERY ────────────────────────────────────────────────────────────────
 * The caller does NOT await this. `copyToClipboard` returns a boolean and never throws, but its
 * execCommand fallback synchronously steals focus and the selection before restoring them
 * (`clipboard.ts`), and a clipboard permission stall must not sit between a transcript and the
 * composer. Route first, mirror second — always.
 */
export async function mirrorDictatedSegment(segment: string, enabled: boolean): Promise<boolean> {
  // The buffer only advances when the feature is ON. Otherwise switching it on mid-session would
  // paste back words spoken while it was off — text the user never agreed to put on a system-wide
  // surface other applications can read.
  if (!enabled) return false;
  const text = noteDictatedSegment(segment);
  if (text === null) return false;
  return copyToClipboard(text);
}
