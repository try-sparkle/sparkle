// The "a fallback notice must be able to come down BY ITSELF" timer, extracted from
// DictationEngineBanner so the two notice surfaces share ONE copy of it (sparkle-cbyhg).
//
// WHY IT IS SHARED RATHER THAN LEFT WHERE IT WAS. `shouldWarnLocalEngine` going false at the TTL is
// not enough on its own: nothing re-renders when a deadline merely passes, so without a timer the
// notice sits there, painted, until some unrelated state change happens to wake the component —
// which for a user who has stopped dictating is "never, until you restart".
//
// Once `unavailable` moved to the mic surface, the banner stopped rendering it — but the banner was
// still the only thing arming this timer. A mic notice relying on that would be correct only while
// a DictationEngineBanner happened to be mounted somewhere, which is the kind of invisible coupling
// that survives every test and breaks the first time someone renders the mic on its own.
import { useEffect } from "react";
import { FALLBACK_NOTICE_TTL_MS, useDictationEngineStore } from "../stores/dictationEngineStore";

export function useRetireStaleNotice(
  reason: string | null,
  observedAt: number | null,
): void {
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
    // timer is armed. Every mounted surface arms from the same stamp, so they would all miss in
    // lockstep and the notice would be stuck permanently: precisely the failure this exists to
    // remove. Passing the deadline makes the fire self-consistent by construction.
    const deadline = observedAt + FALLBACK_NOTICE_TTL_MS + 1;
    const timer = setTimeout(
      () => useDictationEngineStore.getState().retireStaleNotice(deadline),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [reason, observedAt]);
}
