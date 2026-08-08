import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyCloudOutcome,
  FALLBACK_NOTICE_TTL_MS,
  OPEN_REFUSALS_BEFORE_WARNING,
  outcomeInstalledStream,
  shouldWarnLocalEngine,
  useDictationEngineStore,
  type CloudStreamOutcome,
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
    // A DEFINITIVE REPORT NOW ZEROES THE COUNTER, and this line used to assert the opposite ("an
    // unambiguous report lights it without resetting", expecting 1). That was the state of the world
    // when only the ambiguous seam could raise a reason; it contradicted the newer rule the moment
    // `noteCloudOutcome` started ending the episode on a named answer, and the two were pinned in
    // opposite directions in the same file (roborev 60366). One rule now, asserted here and there.
    read().noteCloudUnavailable("unavailable");
    expect(read().openRefusals).toBe(0);
    // Re-arm so the rest of this case still exercises what it was written for: a counter that is
    // live when the notice goes stale.
    read().noteCloudOpenRefused();

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

describe("classifyCloudOutcome — one policy table, enumerated", () => {
  // THE FLAP, ASSERTED DIRECTLY. `already_routing` is the idempotent no-op on a repeated
  // passive→active edge onto a healthy socket and is the most common outcome in ordinary use. It
  // used to arrive as the same `false` as a refusal, which is what lit the banner while the relay
  // was fine. Reading it as anything other than `live` re-creates that bug.
  it("treats an already-routing socket as LIVE, not as a refusal", () => {
    expect(classifyCloudOutcome("already_routing")).toEqual({ kind: "live" });
  });

  it("treats a fresh open and a warm resume as live", () => {
    expect(classifyCloudOutcome("opened")).toEqual({ kind: "live" });
    expect(classifyCloudOutcome("resumed")).toEqual({ kind: "live" });
  });

  // A race is not evidence of anything. Counting it would be the flap in a narrower form.
  it("ignores a race entirely", () => {
    expect(classifyCloudOutcome("raced")).toEqual({ kind: "ignore" });
  });

  // Each named refusal must reach its OWN reason. Asserted as a table so a future variant that
  // silently falls through to `unavailable` fails here.
  it.each([
    ["signed_out", "signed_out"],
    ["unauthorized", "signed_out"],
    ["not_entitled", "not_entitled"],
    ["insufficient_credits", "exhausted"],
    ["relay_unconfigured", "unavailable"],
  ] as const)("reports %s definitively as %s", (outcome, reason) => {
    expect(classifyCloudOutcome(outcome)).toEqual({
      kind: "definitive",
      reason,
    });
  });

  // The ONE remaining ambiguous case — and it must stay ambiguous, because a transient network blip
  // is exactly what the corroboration counter exists for.
  it("keeps an unreachable relay ambiguous, so it still needs corroboration", () => {
    expect(classifyCloudOutcome("unreachable")).toEqual({ kind: "ambiguous" });
  });

  // `live` and `installed by this call` differ on exactly one outcome; if they ever collapse, a
  // raced stop would tear down a stream owned by an earlier call.
  it("separates 'the cloud is live' from 'this call installed it'", () => {
    expect(outcomeInstalledStream("already_routing")).toBe(false);
    expect(classifyCloudOutcome("already_routing")).toEqual({ kind: "live" });
    expect(outcomeInstalledStream("opened")).toBe(true);
    expect(outcomeInstalledStream("resumed")).toBe(true);
    expect(outcomeInstalledStream("raced")).toBe(false);
  });
});

describe("noteCloudOutcome — what the seam actually does with an outcome", () => {
  it("a known refusal speaks IMMEDIATELY, without waiting for corroboration", () => {
    // The whole point of naming the cause: one attempt is enough when the relay told us why.
    // Guarded against the threshold so this cannot pass by the counter happening to be 1.
    expect(OPEN_REFUSALS_BEFORE_WARNING).toBeGreaterThan(1);

    read().noteCloudOutcome("insufficient_credits");

    expect(read().fallbackReason).toBe("exhausted");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("names a stale session rather than blaming the network", () => {
    read().noteCloudOutcome("unauthorized");
    expect(read().fallbackReason).toBe("signed_out");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  // THE REGRESSION TEST FOR THE FOUNDER'S SYMPTOM. Repeated holds and focus-regains onto a healthy
  // socket produce a run of `already_routing`. Any number of them must leave the banner down.
  it("never warns across a long run of already-routing no-ops", () => {
    for (let i = 0; i < 10; i += 1) read().noteCloudOutcome("already_routing");

    expect(read().fallbackReason).toBeNull();
    expect(read().openRefusals).toBe(0);
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("a race moves nothing at all", () => {
    read().noteCloudOutcome("unreachable"); // one ambiguous refusal, below the threshold
    const before = read().openRefusals;

    read().noteCloudOutcome("raced");
    read().noteCloudOutcome("raced");

    expect(read().openRefusals).toBe(before);
    expect(read().fallbackReason).toBeNull();
  });

  it("still corroborates an unreachable relay before speaking", () => {
    read().noteCloudOutcome("unreachable");
    expect(shouldWarnLocalEngine(read())).toBe(false); // one is not enough

    read().noteCloudOutcome("unreachable");
    expect(read().fallbackReason).toBe("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  // A healthy no-op between two blips must clear the count — consecutive means consecutive.
  it("a live outcome resets the corroboration counter", () => {
    read().noteCloudOutcome("unreachable");
    read().noteCloudOutcome("already_routing");
    read().noteCloudOutcome("unreachable");

    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  // The relay's CURRENT verdict wins: a user who refills and then hits a genuine sign-out must be
  // told about the sign-out, not left reading a stale "you're out of credits".
  it("lets a newer definitive answer replace an older one", () => {
    read().noteCloudOutcome("insufficient_credits");
    expect(read().fallbackReason).toBe("exhausted");

    read().noteCloudOutcome("not_entitled");
    expect(read().fallbackReason).toBe("not_entitled");
  });

  // TOTALITY, ASSERTED AS A SIDE EFFECT RATHER THAN A SHAPE. Without the `default` arm this call
  // returns `undefined`, `noteCloudOutcome` reads `.kind` off it and THROWS — inside
  // `startCloudStream`, i.e. before `openCloudDictationWindow` reaches its teardown, so a socket the
  // backend really did install would never be closed on a raced stop and would keep billing. The
  // bool this replaced was total for anything the backend could send; this has to be too.
  it("does not throw on an outcome it does not recognise, and treats it as ambiguous", () => {
    const bogus = "AlreadyRouting" as CloudStreamOutcome; // e.g. a lost `rename_all` on the Rust side
    expect(() => classifyCloudOutcome(bogus)).not.toThrow();
    expect(classifyCloudOutcome(bogus)).toEqual({ kind: "ambiguous" });

    // …and the store dispatch survives it, corroborating rather than naming a cause we cannot read.
    expect(() => read().noteCloudOutcome(bogus)).not.toThrow();
    expect(read().openRefusals).toBe(1);
    expect(read().fallbackReason).toBeNull();
  });

  // A RELAY-STATED REASON MUST SURVIVE THE AMBIGUOUS SEAM — for EVERY stated reason, not just
  // `exhausted` (roborev 60356). The guard was written when `exhausted` was the only reason the
  // relay could state; 401 and 403 now arrive stated too, and both were being overwritten with the
  // generic "Sparkle can't reach the cloud transcription service" the moment corroboration landed.
  // That tells an unentitled user to retry forever while "Unlock Sparkle" — the only thing that
  // works — vanishes from the banner.
  it.each([
    ["unauthorized", "signed_out"],
    ["not_entitled", "not_entitled"],
    ["insufficient_credits", "exhausted"],
  ] as const)(
    "a stated %s survives corroborating unreachables instead of decaying to unavailable",
    (outcome, expected) => {
      read().noteCloudOutcome(outcome);
      expect(read().fallbackReason).toBe(expected);

      for (let i = 0; i < OPEN_REFUSALS_BEFORE_WARNING + 1; i++) {
        read().noteCloudOutcome("unreachable");
      }
      expect(read().fallbackReason).toBe(expected);
    },
  );

  // A NAMED ANSWER ENDS THE AMBIGUOUS EPISODE. Without zeroing the counter, a pre-existing count of
  // 1 survives the definitive report, so ONE later unreachable crosses the threshold — reaching the
  // downgrade path in a single blip rather than two.
  it("a definitive answer zeroes the corroboration counter", () => {
    read().noteCloudOutcome("unreachable");
    expect(read().openRefusals).toBe(1);

    read().noteCloudOutcome("not_entitled");
    expect(read().openRefusals).toBe(0);
  });

  it("every outcome is handled — no silent fall-through", () => {
    const all: CloudStreamOutcome[] = [
      "opened",
      "resumed",
      "already_routing",
      "raced",
      "signed_out",
      "unauthorized",
      "not_entitled",
      "insufficient_credits",
      "relay_unconfigured",
      "unreachable",
    ];
    for (const o of all) {
      expect(classifyCloudOutcome(o)).toBeDefined();
    }
  });
});
