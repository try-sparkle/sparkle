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
import { useEffect, type CSSProperties } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import {
  FALLBACK_NOTICE_TTL_MS,
  shouldWarnLocalEngine,
  useDictationEngineStore,
  type DictationFallbackReason,
} from "../stores/dictationEngineStore";

/** One sentence per coarse reason — FOUR of them now that the relay's answer is carried through
 *  (`unavailable`, `exhausted`, `signed_out`, `not_entitled`). The two paragraphs below were written
 *  when there were two; the rules they state apply to every reason added since, and the test sweeps
 *  `WARNING`'s own keys so a new reason cannot ship without meeting them.
 *
 *  THE CAUSE LEADS, and that is a correction. Both strings used to open with the identical clause
 *  "Live dictation preview is off — ", so the only words that DISCRIMINATE — unreachable relay vs.
 *  out of credits, whose remedies have nothing in common — arrived 30 characters in, after a
 *  half-sentence the reader had already seen before.
 *
 *  NOT a truncation bug: this bar wraps (no `whiteSpace: nowrap`, no ellipsis), so the whole
 *  sentence is on screen. It is a RECOGNITION bug, which is worse in the way that matters — nothing
 *  is hidden, so nothing prompts a re-read. An amber bar opening with a clause you have read before
 *  is pattern-matched as "that banner again" and dismissed at a glance, which is exactly what the
 *  founder reported: he quoted the shared prefix back and said he had no idea why it was there.
 *  What was lost still gets said, immediately after; leading with the cause is what makes the two
 *  reasons tellable apart without reading to the end.
 *
 *  AND BOTH NAME A REMEDY. Only `exhausted` used to, which left the common case stating a problem
 *  and no action — the shape that reads as noise. `unavailable` does have one: the relay recovers by
 *  itself and the next dictation re-tries it, so "try again in a moment" is true and actionable
 *  rather than a placeholder.
 *
 *  Neither carries a raw error, a status code, or any PII. */
export const WARNING: Record<DictationFallbackReason, string> = {
  unavailable:
    // THE CREDITS HEDGE IS GONE, AND ITS REMOVAL IS THE POINT (it was added under roborev 59930).
    // That tail — "if it keeps happening, check your Sparkle credits" — existed only because this
    // seam could not tell WHY the relay refused, so the sentence had to stay true even when the real
    // cause was an empty balance. It can tell now: an empty balance arrives as `exhausted` and gets
    // its own copy below. Keeping the hedge would send a user whose network blipped off to inspect a
    // balance that is fine, which is the same class of misdirection the hedge was written to avoid.
    // `unavailable` now means only "we could not reach the relay, or the relay itself is
    // misconfigured" — neither of which the user can fix by refilling.
    "Sparkle can't reach the cloud transcription service. Live dictation preview is off — dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. It usually reconnects on its own, so try dictating again in a moment",
  exhausted:
    "You're out of Sparkle credits. Live dictation preview is off — dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Refill your credits to get the live preview back",
  // DELIBERATELY SAYS NOTHING ABOUT CONNECTIVITY. This reason is only reached once a stream has
  // actually opened, which proves the service was reachable — so any mention of the network here
  // would be false, and it is precisely the false claim that sent the founder (and an investigating
  // agent) hunting a connectivity fault that did not exist. It also does not offer a remedy,
  // because there is nothing the user can do: the handshake being slower than a short utterance is
  // ours to fix, not theirs. Saying "try again" would be the remedy-that-is-unsafe-under-its-own-
  // trigger shape AGENTS.md warns about — the retry hits the same race.
  "too-slow":
    "Live dictation preview is off — the cloud transcription service connected too late for that utterance, so it was transcribed on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Longer utterances usually get the live preview",
  // ── THE ONE BANNER THAT MUST NOT SAY "YOUR WORDS ARE STILL CAPTURED" ────────────────────────────
  // Every other string here ends with some form of that sentence, and every one of them is telling
  // the truth: a relay failure still leaves the on-device engine holding the audio. This condition
  // is the exception — the microphone had not finished starting when the key came up, so there is no
  // recording anywhere. Reusing the reassurance here is what made the founder report the mic as
  // broken while the UI insisted his words were safe.
  //
  // SAYS NOTHING ABOUT THE DEVICE, because the device is fine: it bound successfully 41/41 times on
  // the machine where this was diagnosed while this very condition was firing. Blaming the mic, the
  // permission, or another app would send the user to check three things that are all working — the
  // same false-lead shape that made `too-slow` stop mentioning the network.
  //
  // THE REMEDY IS REAL AND SAFE UNDER ITS OWN TRIGGER, which `too-slow` deliberately has none of.
  // There, retrying hits the identical race, so offering one would be the unsafe-remedy shape
  // AGENTS.md warns about. Here it genuinely works: the capture takes a few hundred ms on an idle
  // machine and a couple of seconds on a loaded one, so a longer hold clears it every time. It is
  // still ours to fix properly, which is why the copy owns the failure rather than blaming the user.
  mic_missed_hold:
    "That was too quick for the microphone — it was still starting when you let go, so nothing was recorded. Try holding the key a moment longer before you speak. Sparkle is slower to open the mic while your machine is busy",
  // The two conditions that were previously invisible — both reported as a generic outage, sending
  // the user to debug a network that was never the problem.
  signed_out:
    "Sparkle can't verify your account, so live dictation preview is off — dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Sign in again to get the live preview back",
  // THE APP'S OWN VERB, NOT AN INVENTED ONE. This copy first said "Your Sparkle plan doesn't
  // include cloud dictation… Upgrade" — but there is no plan and no Upgrade. The relay's 403 comes
  // from `user.paidAt == null`, i.e. the ONE-TIME $99 purchase, and every other surface for that
  // exact condition says "Buy Sparkle" / "Unlock Sparkle — $99" (AiLockedNotice). Naming a remedy
  // the product does not offer sends the user hunting for a control that does not exist — the same
  // rule that made `exhausted` say "Refill" rather than inventing a synonym.
  not_entitled:
    "Cloud dictation needs the full Sparkle app, so live dictation preview is off — dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Unlock Sparkle to get the live preview back",
  // SAYS NOTHING ABOUT THE SERVICE BEING DOWN, because it is not: the relay answered, having counted
  // this account's own streams. Naming the real cause is the whole point — this used to fall into
  // the generic unmapped-status bucket and render `unavailable`, sending a user with two Sparkle
  // windows open off to debug a cloud outage that never existed.
  //
  // "try again in a moment" IS safe under its own trigger here, unlike `too-slow`: the cap frees a
  // slot as soon as a previous socket's warm-standby window lapses, so the retry can genuinely
  // succeed. The window-closing remedy is offered first because it is the one the user controls.
  too_many_streams:
    "Too many Sparkle windows are dictating at once, so live dictation preview is off here — dictation is running on the local engine. Your words are still captured; they appear when you finish speaking instead of word by word. Close another dictating window, or try again in a moment, to get the live preview back",
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
  const observedAt = engine.observedAt;

  // THE BAR HAS TO BE ABLE TO COME DOWN BY ITSELF. `shouldWarnLocalEngine` going false at the TTL is
  // not enough on its own: nothing re-renders when a deadline merely passes, so without this the
  // notice would sit there, painted, until some unrelated state change happened to wake the
  // component — which for a user who has stopped dictating is "never, until you restart". Arming a
  // timer for the exact remaining lifetime is what turns the rule into an observable side effect.
  //
  // Re-armed whenever the stamp changes, so a re-report during a live outage pushes the deadline out
  // rather than leaving a timer aimed at the old one.
  useEffect(() => {
    if (reason === null || observedAt === null) return;
    // The deadline this timer is aimed at, computed ONCE and then handed to the action — the timer
    // must not re-derive staleness from a clock it did not schedule against.
    //
    // THE TIMER GETS EXACTLY ONE SHOT, SO IT MUST NOT BE ABLE TO MISS (roborev 59930). `setTimeout`
    // counts on the MONOTONIC clock while `Date.now()` is WALL time, and the two disagree across a
    // backward NTP step, a suspend/resume correction, or ordinary drift over 300 s. Letting
    // `retireStaleNotice()` re-read `Date.now()` meant a callback that fired a millisecond "early"
    // by wall time found the notice not-yet-stale and retired nothing — and because that no-op
    // leaves `reason` and `observedAt` untouched, the effect's deps never change and NO replacement
    // timer is armed. Every mounted banner arms from the same stamp, so they would all miss in
    // lockstep and the bar would be stuck permanently: precisely the failure this whole change
    // exists to remove. Passing the deadline makes the fire self-consistent by construction.
    const deadline = observedAt + FALLBACK_NOTICE_TTL_MS + 1;
    const timer = setTimeout(
      () => useDictationEngineStore.getState().retireStaleNotice(deadline),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [reason, observedAt]);

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
