import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyCloudOutcome,
  FALLBACK_NOTICE_TTL_MS,
  noteCloudLate,
  noteCloudLateAttemptStart,
  OPEN_REFUSALS_BEFORE_WARNING,
  outcomeInstalledStream,
  sawCloudLateThisAttempt,
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

describe("a relay that CONNECTED is never reported as unreachable", () => {
  // THE LOAD-BEARING CASE — the founder's, measured on 2026-08-06. The relay opened 171 times and
  // was discarded 136 of those for landing after the utterance ended (0.96 s after stop_dictation in
  // one cycle, ~6 s in another) while his network was healthy: ping 1.1.1.1 0% loss / 20 ms,
  // api.deepgram.com connect 260 ms. Reporting that as "can't reach the cloud transcription service"
  // is a claim the completed handshake disproves outright.
  //
  // These assert `noteCloudConnectedLate`, NOT a pure classifier. There was one — and it took
  // `{exhausted, streamOpened}` as arguments, so its tests could only ever prove that a hardcoded
  // fact maps to a reason. Both production call sites passed the same literal, and going through it
  // is what let them escape the two invariants below (roborev 60355). The decision now lives with
  // the state it depends on, which is what makes these assertions about behaviour.

  it("calls a late-but-successful connection 'too-slow', not 'unavailable'", () => {
    read().noteCloudConnectedLate(true);
    expect(read().fallbackReason).toBe("too-slow");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("does NOT downgrade a standing out-of-credits — reachability says nothing about credits", () => {
    // Exhaustion is signalled mid-stream, so a zero-balance user's NEXT attempt still completes its
    // handshake; if that one lands late, the naive write replaced "You're out of Sparkle credits…
    // Refill" with copy naming no remedy they can act on — and re-nagged, because the reason
    // changed. This is the same precedence noteCloudOpenRefused already keeps.
    read().noteCloudUnavailable("exhausted");
    read().dismiss();
    read().noteCloudConnectedLate(true);
    expect(read().fallbackReason).toBe("exhausted");
    // …and the wave-away survives, because from the user's side nothing new was said.
    expect(read().dismissed).toBe(true);
  });

  it("does not renew the stamp of a reason it merely PRESERVED", () => {
    // Preserving is not observing: this seam saw a handshake, never a balance. Renewing here would
    // let a stale `exhausted` be pushed out indefinitely and never expire on its own TTL — the same
    // rule the refusal path states in the same words.
    vi.useFakeTimers();
    read().noteCloudUnavailable("exhausted");
    const stamped = read().observedAt!;
    vi.advanceTimersByTime(60_000);
    read().noteCloudConnectedLate(true);
    expect(read().observedAt).toBe(stamped);
    // The pair that stops this passing for a store that never stamps anything: an UNPRESERVED late
    // connect does take a fresh stamp, which is what keeps a real too-slow episode alive.
    read().noteCloudLive();
    read().noteCloudConnectedLate(true);
    expect(read().observedAt).toBeGreaterThan(stamped);
  });

  it("ZEROES the corroboration counter — a completed handshake is evidence of a live cloud", () => {
    // The sequence this exists to stop: refuse (1) → connect late → refuse (would be 2, the
    // threshold) → the banner claims Sparkle "can't reach the cloud transcription service" over a
    // relay that provably connected one utterance earlier, silently downgrading the honest reason.
    // That is the flap the counter exists to remove, straddling a proven-live connection.
    read().noteCloudOpenRefused();
    expect(read().openRefusals).toBe(1);
    read().noteCloudConnectedLate(true);
    expect(read().openRefusals).toBe(0);
    read().noteCloudOpenRefused();
    expect(read().openRefusals).toBe(1);
    expect(read().fallbackReason).toBe("too-slow"); // NOT downgraded to "unavailable"
  });

  it("takes the EVIDENCE but not the CLAIM in a window that is not dictating", () => {
    // `dictation://cloud-late` is an `app.emit`, so every open window runs the listener and every
    // project window paints its own banner (roborev 60368). "Connected too late for that utterance"
    // is about ONE window's utterance; painting it in three describes an utterance two of them had
    // no part in — and they cannot take it down, because every clearing path needs `isCapturable()`,
    // so it stands for the full notice TTL. What the handshake proves about the RELAY is app-wide.
    read().noteCloudOpenRefused();
    read().noteCloudConnectedLate(false);
    expect(read().fallbackReason).toBeNull(); // the claim stayed in the window that owns it…
    expect(read().openRefusals).toBe(0); // …and the evidence still landed everywhere
  });

  it("RETRACTS a standing 'unavailable' in that same non-dictating window", () => {
    // The half the assertion above cannot reach (roborev 60376): with one refusal charged,
    // `fallbackReason` is already null, so `toBeNull()` holds vacuously and a branch that zeroes the
    // counter while leaving the banner up passes it. Raise the banner first. A window that has been
    // shown the relay IS reachable must not go on claiming it is unreachable — and it is the one
    // window that can never take that back itself, since `noteCloudLive` and the interim-driven
    // clear both require it to be the capturable one. It would stand for the full TTL.
    read().noteCloudOpenRefused();
    read().noteCloudOpenRefused();
    expect(read().fallbackReason).toBe("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);

    read().noteCloudConnectedLate(false);
    expect(read().fallbackReason).toBeNull();
    expect(read().observedAt).toBeNull();
    expect(read().openRefusals).toBe(0);
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  // EVERY STATED REASON, NOT JUST `exhausted` (roborev 60394). The preservation rule was widened to
  // match `noteCloudOpenRefused` when 401/403 started arriving stated as `signed_out`/`not_entitled`
  // — but only `exhausted` was tested, so reverting the predicate to `stated === "exhausted"` left
  // the suite green while a late handshake overwrote "Sign in again" / "Unlock Sparkle" with copy
  // naming no remedy that works.
  it.each(["exhausted", "signed_out", "not_entitled"] as const)(
    "preserves a stated '%s' on both the CLAIM and the EVIDENCE lap",
    (reason) => {
      vi.useFakeTimers();
      read().noteCloudUnavailable(reason);
      const stamped = read().observedAt;
      vi.advanceTimersByTime(60_000);

      // speaks: false — the evidence-only lap must not retract it…
      read().noteCloudConnectedLate(false);
      expect(read().fallbackReason).toBe(reason);
      expect(read().observedAt).toBe(stamped);
      expect(read().openRefusals).toBe(0);

      // …and speaks: true must not DOWNGRADE it to "too-slow", nor renew a stamp it merely kept.
      read().noteCloudConnectedLate(true);
      expect(read().fallbackReason).toBe(reason);
      expect(read().observedAt).toBe(stamped);
    },
  );

  // `too_many_streams` is deliberately NOT in the preserved table above, and this is the pair that
  // pins the difference. The relay enforces the cap DURING the upgrade, so a handshake that
  // completed proves the account was under the cap at that moment — the reason is not merely
  // unproven, it is disproven. Keeping it would leave the banner telling the user to close another
  // Sparkle window to fix a condition that has already cleared.
  it("retracts a stated 'too_many_streams' on the evidence lap — a handshake disproves the cap", () => {
    read().noteCloudUnavailable("too_many_streams");
    expect(read().fallbackReason).toBe("too_many_streams");
    read().noteCloudConnectedLate(false);
    expect(read().fallbackReason).toBeNull();
  });

  it("re-reports a stated 'too_many_streams' as too-slow when the late connect speaks", () => {
    // The honest account of "refused at the cap, then connected after the user stopped talking" is
    // a timing fault, not a window count — and unlike a preserved reason, it takes a fresh stamp.
    vi.useFakeTimers();
    read().noteCloudUnavailable("too_many_streams");
    const stamped = read().observedAt!;
    vi.advanceTimersByTime(60_000);
    read().noteCloudConnectedLate(true);
    expect(read().fallbackReason).toBe("too-slow");
    expect(read().observedAt).toBeGreaterThan(stamped);
  });

  it("retracts ONLY 'unavailable' — a genuine too-slow of its own still stands", () => {
    // The counter-case that stops the table above from being satisfied by "never write anything":
    // an UNPRESERVED late connect does take the claim, and a following evidence-only lap leaves it.
    read().noteCloudLive();
    read().noteCloudConnectedLate(true); // raise a genuine too-slow…
    expect(read().fallbackReason).toBe("too-slow");
    read().noteCloudConnectedLate(false); // …and an evidence-only lap must leave it alone
    expect(read().fallbackReason).toBe("too-slow");
  });

  it("re-arms a dismissal when the reason changes from unavailable to too-slow", () => {
    // The store's existing rule across the NEW boundary: these are different things to tell the
    // user, so learning it was a timing fault must be able to speak even after the (wrong)
    // connectivity claim was waved away.
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    expect(shouldWarnLocalEngine(read())).toBe(false);
    read().noteCloudConnectedLate(true);
    expect(read().fallbackReason).toBe("too-slow");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });
});

describe("the corroboration count keeps climbing while the episode is live", () => {
  it("does not freeze at the threshold once the banner is up", () => {
    // The store's own comment says the count keeps climbing and explains why; the returned patch
    // omitted the key, so it froze at `OPEN_REFUSALS_BEFORE_WARNING - 1` instead. Invisible in the
    // UI — the banner is decided by `fallbackReason` — but it makes "does the count still support
    // this banner?" unanswerable — and one guard (the since-deleted orphan withdrawal) was written
    // against it before that was noticed.
    for (let i = 0; i < OPEN_REFUSALS_BEFORE_WARNING + 2; i += 1) read().noteCloudOpenRefused();
    expect(read().openRefusals).toBe(OPEN_REFUSALS_BEFORE_WARNING + 2);
    expect(read().fallbackReason).toBe("unavailable");
  });

  it("still zeroes on every documented end of an episode", () => {
    // The counterpart, so the change above cannot be read as "the count never comes down".
    for (let i = 0; i < OPEN_REFUSALS_BEFORE_WARNING + 1; i += 1) read().noteCloudOpenRefused();
    read().noteCloudLive();
    expect(read().openRefusals).toBe(0);

    for (let i = 0; i < OPEN_REFUSALS_BEFORE_WARNING + 1; i += 1) read().noteCloudOpenRefused();
    read().noteCloudUnavailable("exhausted");
    expect(read().openRefusals).toBe(0);
  });
});

describe("the cloud-late latch survives either race order", () => {
  // The event and start_cloud_stream's response race, and Tauri does not order them. A first
  // version of this wiring set the store from the event only -- so when the invoke resolved SECOND
  // it overwrote the true reason with the false one it exists to replace. Both orders are pinned
  // here because only one of them was broken, and the working one hid it.

  // WHAT THESE DO NOT PROVE, stated so nobody reads them as coverage of the wiring: they pin the
  // latch, which is a carrier. The three-way branch that READS it lives in `startCloudStream` and is
  // pinned in `useDictation.engine.test.tsx`, driving the real closure in both race orders — an
  // earlier version of this file composed the latch with a classifier by hand, which stayed green
  // when the call site was reverted.

  it("holds the fact when the event wins the race", () => {
    noteCloudLateAttemptStart();
    noteCloudLate(); // the event landed before the invoke resolved
    expect(sawCloudLateThisAttempt()).toBe(true);
  });

  it("reads false when no cloud-late arrived at all", () => {
    noteCloudLateAttemptStart();
    // Nothing connected — the genuine-outage path must reach the corroborating counter, not this.
    expect(sawCloudLateThisAttempt()).toBe(false);
  });

  it("does not carry a latch across attempts", () => {
    noteCloudLateAttemptStart();
    noteCloudLate(); // utterance 1 connected late
    noteCloudLateAttemptStart(); // utterance 2 begins
    // A stale latch here would report a REAL outage as a timing fault -- the same false banner
    // pointing the other way, which is why the clear happens before every invoke.
    expect(sawCloudLateThisAttempt()).toBe(false);
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
    ["too_many_streams", "too_many_streams"],
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

  // THE FALSE-OUTAGE GUARD FOR THE RELAY'S CONCURRENCY CAP. A 429 proves the relay is reachable and
  // healthy: it counted this account's own streams and answered. Before its client arm existed it
  // fell into the generic unmapped-status bucket, which resolves to `unreachable` → `ambiguous` →
  // the "Sparkle can't reach the cloud transcription service" copy. Asserted as a NON-equality
  // against that verdict, not just as an equality to the right one, because the failure being
  // guarded is specifically the collapse onto the ambiguous path.
  it("never reports a per-account stream cap as an unreachable relay", () => {
    expect(classifyCloudOutcome("too_many_streams")).not.toEqual({ kind: "ambiguous" });
    expect(classifyCloudOutcome("too_many_streams")).not.toEqual(
      classifyCloudOutcome("unreachable"),
    );
    expect(classifyCloudOutcome("too_many_streams")).not.toEqual({
      kind: "definitive",
      reason: "unavailable",
    });
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
