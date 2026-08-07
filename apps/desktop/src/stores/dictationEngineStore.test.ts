import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_NOTICE_TTL_MS,
  shouldWarnLocalEngine,
  useDictationEngineStore,
  type DictationEngineState,
} from "./dictationEngineStore";

const read = (): DictationEngineState => useDictationEngineStore.getState();

beforeEach(() => {
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dictationEngineStore", () => {
  it("stays silent at rest — no stream is open, and nothing is wrong", () => {
    // The resting state is NOT "cloud is live": at rest no relay stream exists at all. A banner
    // keyed on "is cloud streaming right now" would be lit permanently while nothing was broken.
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("warns once a cloud attempt has been refused", () => {
    read().noteCloudUnavailable("unavailable");
    expect(read().fallbackReason).toBe("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("retires the warning when a cloud stream comes back", () => {
    read().noteCloudUnavailable("unavailable");
    read().noteCloudLive();
    expect(read().fallbackReason).toBeNull();
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("stays hidden for the rest of an episode once dismissed", () => {
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    expect(shouldWarnLocalEngine(read())).toBe(false);
    // Re-reporting the SAME reason must not nag — every subsequent refusal in one outage would
    // otherwise re-open a banner the user deliberately waved away.
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("re-arms a dismissal for a DIFFERENT reason", () => {
    // Out-of-credits is the one reason the user can act on, so it has to be able to speak even
    // after a plain outage was dismissed. This is the assertion that fails if `dismissed` is
    // carried over unconditionally.
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    read().noteCloudUnavailable("exhausted");
    expect(read().fallbackReason).toBe("exhausted");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("re-arms after a recovery, so a later distinct outage is not silenced by one dismissal", () => {
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    read().noteCloudLive();
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  // ══ THE OBSERVATION EXPIRES — A REFUSAL IS A PAST EVENT, NOT A STANDING CLAIM ══════════════════
  // The banner speaks in the PRESENT tense ("Sparkle can't reach…"), but the only thing that ever
  // cleared it was a LATER successful `start_cloud_stream`. That call happens only when the user
  // dictates again with the cloud prefs on — so after one transient refusal (a DNS blip, a relay
  // restart) the notice stood indefinitely, asserting an outage that had healed minutes later, and
  // no amount of waiting brought it down. Stamping the observation and letting it go stale is what
  // makes the banner able to come down on its own.

  it("retires an observation nobody has renewed — the outage is no longer being seen", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);

    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);

    // THE SIDE EFFECT: the predicate that paints the bar now says no. Nothing "recovered" — the
    // point is that an un-renewed observation stops being asserted.
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("keeps warning while the outage is still being re-observed", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("unavailable");
    // Most of the way to expiry, then the user dictates again and the relay refuses again.
    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS - 1000);
    read().noteCloudUnavailable("unavailable");
    // That re-observation renews the stamp, so passing the ORIGINAL deadline changes nothing.
    vi.advanceTimersByTime(2000);
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("settles the state itself, so a stale notice is gone rather than merely unpainted", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("unavailable");
    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);

    read().retireStaleNotice();

    expect(read().fallbackReason).toBeNull();
    expect(read().observedAt).toBeNull();
  });

  it("retireStaleNotice leaves a FRESH notice alone — it expires the stale, never the live", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("exhausted");
    vi.advanceTimersByTime(1000);

    read().retireStaleNotice();

    expect(read().fallbackReason).toBe("exhausted");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  // ══ THE OPEN SEAM IS AMBIGUOUS, SO IT MUST BE CORROBORATED ═════════════════════════════════════
  // `start_cloud_stream` returns a bare bool, and `cloud_reuse` answers `AlreadyRouting -> Ok(false)`
  // for a socket that is ALIVE, matches the project and is actively routing. So `false` means BOTH
  // "the relay refused" and "one is already running". Raising the banner on one of those raised it
  // on every repeated passive→active edge and every focus-regain onto a warm socket — the founder's
  // "popping up and going away… very sensitive", with the relay verified healthy throughout.

  it("stays silent on a SINGLE open refusal — it cannot tell that from an already-live stream", () => {
    read().noteCloudOpenRefused();
    expect(shouldWarnLocalEngine(read())).toBe(false);
    expect(read().fallbackReason).toBeNull();
  });

  it("speaks once a second consecutive refusal corroborates the first", () => {
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    expect(read().fallbackReason).toBe("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("CONSECUTIVE means consecutive — a working stream between two refusals resets the count", () => {
    read().noteCloudOpenRefused();
    read().noteCloudLive(); // the already-routing no-op is followed by a stream that works
    read().noteCloudOpenRefused();
    // Two refusals total, but not in a row: no verdict.
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  // ══ CORROBORATION IS PER-EPISODE (roborev 59941) ═══════════════════════════════════════════════
  // Left armed, the whole mechanism was one-shot per process: after the first genuine outage the
  // count never came back down, so the next LONE ambiguous refusal incremented past the threshold
  // and re-raised the banner against a healthy relay — the flap, permanently reinstated.
  //
  // The counter is reset in TWO places and each is asserted on its OWN postcondition, deliberately.
  // A purely behavioural test cannot tell them apart: either reset alone (or `noteCloudLive`) is
  // enough to make the end-to-end scenario pass, so a single mutation leaves it green. The first
  // draft of these two tests was exactly that vacuous.

  it("every further refusal RENEWS the stamp while the episode is live", () => {
    // roborev 59971. The counter briefly reset when the warning fired, which broke this: the
    // sub-threshold branch carries no stamp, so only every OTHER refusal renewed `observedAt` and a
    // sustained outage whose attempts are more than TTL/2 apart expired its own notice underneath
    // itself. Staying armed is what makes each further attempt a re-report.
    vi.useFakeTimers();
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    const firstStamp = read().observedAt as number;

    vi.advanceTimersByTime(60_000);
    read().noteCloudOpenRefused();

    expect(read().observedAt).toBe(firstStamp + 60_000);
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("retiring a stale notice resets the counter — the expiry closes its episode too", () => {
    vi.useFakeTimers();
    read().noteCloudOpenRefused(); // counter 1, below the threshold, nothing raised
    read().noteCloudUnavailable("unavailable"); // an unambiguous report lights it without resetting
    expect(read().openRefusals).toBe(1);

    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);
    read().retireStaleNotice();

    expect(read().openRefusals).toBe(0);
  });

  it("end to end: an episode that ends leaves the next lone refusal silent", () => {
    vi.useFakeTimers();
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    expect(shouldWarnLocalEngine(read())).toBe(true);

    // The relay recovers, but the user does not dictate again, so only the expiry ends it.
    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);
    read().retireStaleNotice();
    read().noteCloudOpenRefused();

    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("preserving `exhausted` does NOT renew its stamp — the seam never observed it", () => {
    // roborev 59968. Re-stamping made a preserved `exhausted` unbounded in time: every pair of
    // ambiguous refusals pushed its deadline out, so a user who refills and THEN hits a real outage
    // would be told "you're out of Sparkle credits… Refill" forever — the mirror image of the false
    // remedy this branch set out to remove.
    vi.useFakeTimers();
    read().noteCloudUnavailable("exhausted");
    const stampedAt = read().observedAt;

    vi.advanceTimersByTime(60_000);
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();

    expect(read().fallbackReason).toBe("exhausted");
    expect(read().observedAt).toBe(stampedAt);
  });

  it("…so a STALE exhausted expires and the ambiguous seam then reports honestly", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("exhausted");
    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);
    read().retireStaleNotice();

    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();

    expect(read().fallbackReason).toBe("unavailable");
  });

  it("an ambiguous refusal does NOT downgrade a specific out-of-credits reason", () => {
    // roborev 59930. The open seam always says "unavailable" because it cannot know better, but
    // `exhausted` came from the relay saying so. Overwriting it tells a user at zero credits to
    // check their network and never mentions the one remedy that works.
    read().noteCloudUnavailable("exhausted");
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    expect(read().fallbackReason).toBe("exhausted");
  });

  it("…and a dismissal of that specific reason survives the ambiguous re-report", () => {
    read().noteCloudUnavailable("exhausted");
    read().dismiss();
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    // The reason did not change, so this is the SAME episode — it must not nag again.
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("retireStaleNotice honours the deadline it is GIVEN, not the wall clock", () => {
    // roborev 59930. `setTimeout` counts monotonic time while `Date.now()` is wall time; across a
    // backward NTP step or a suspend/resume correction the callback can fire a hair "early" by wall
    // time. Re-deriving staleness there retired nothing — and the no-op leaves reason/observedAt
    // untouched, so the component's effect never re-arms and the bar sticks forever.
    vi.useFakeTimers();
    read().noteCloudUnavailable("unavailable");
    const observedAt = read().observedAt as number;

    // Wall clock is 1 ms SHORT of the deadline; the timer's own deadline is passed explicitly.
    vi.setSystemTime(observedAt + FALLBACK_NOTICE_TTL_MS);
    read().retireStaleNotice(observedAt + FALLBACK_NOTICE_TTL_MS + 1);

    expect(read().fallbackReason).toBeNull();
  });

  it("the mid-stream teardown still speaks IMMEDIATELY — that signal is not ambiguous", () => {
    // `cloud-ended` is the relay telling us the stream died. Nothing to corroborate, and delaying it
    // would leave the user watching the preview vanish with no explanation.
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("a retired notice re-arms cleanly — the next outage is not swallowed by the old dismissal", () => {
    vi.useFakeTimers();
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1);
    read().retireStaleNotice();

    read().noteCloudUnavailable("unavailable");

    expect(shouldWarnLocalEngine(read())).toBe(true);
  });
});
