// @vitest-environment jsdom
//
// The "dictation fell back to the local engine" banner. These assert what RENDERS, never a
// precondition the store already satisfied: the resting state paints nothing, each coarse reason
// paints its own distinct sentence, the ✕ actually removes it, and a NEW reason gets through a
// dismissal. The copy invariants are load-bearing too — the banner exists to name what was LOST
// (the live preview), and it must not blame the network or the user's Claude allowance, which are
// other banners' jobs.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationEngineBanner, WARNING } from "./DictationEngineBanner";
import {
  FALLBACK_NOTICE_TTL_MS,
  useDictationEngineStore,
  type DictationFallbackReason,
} from "../stores/dictationEngineStore";

beforeEach(() =>
  useDictationEngineStore.setState({
    fallbackReason: null,
    dismissed: false,
    observedAt: null,
    openRefusals: 0,
  }),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DictationEngineBanner", () => {
  it("renders nothing at rest — no fallback has been reported", () => {
    const { container } = render(<DictationEngineBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names what was lost, and the local engine, once the relay is unavailable", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    render(<DictationEngineBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    // WHAT IS LOST is the whole point — a banner that only said "degraded" would send the user
    // hunting for the missing italics all over again.
    expect(text).toContain("Live dictation preview is off");
    expect(text).toContain("local engine");
    // …and it must say the words still land, or it reads as "dictation is broken".
    expect(text).toMatch(/still captured/i);
  });

  it("gives the exhausted case DIFFERENT copy, naming the refill remedy", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    render(<DictationEngineBanner />);
    const unavailable = screen.getByRole("status").textContent ?? "";

    cleanup();
    useDictationEngineStore.setState({ fallbackReason: "exhausted", dismissed: false });
    render(<DictationEngineBanner />);
    const exhausted = screen.getByRole("status").textContent ?? "";

    expect(exhausted).not.toBe(unavailable);
    // The one reason the user can act on. "Refill" is the app's own verb (ZeroCreditBanner /
    // OutOfCreditsNotice) — a different one here would contradict the affordance they'll click.
    expect(exhausted).toMatch(/refill/i);
    expect(exhausted).toMatch(/credits/i);
    // The unavailable case has no such remedy and must not invent one.
    expect(unavailable).not.toMatch(/refill/i);
  });

  // SWEPT OFF `WARNING`'S OWN KEYS, NOT A HAND-WRITTEN LIST. It used to iterate
  // `["unavailable", "exhausted"] as const`, which could not grow with the union: two new reasons
  // (`signed_out`, `not_entitled`) were added and neither was covered by the invariants this file
  // calls load-bearing. `Record<DictationFallbackReason, string>` only forces a string to EXIST — it
  // says nothing about what is in it, so the type could not stand in for this.
  it("carries no raw error or status code, and blames neither the network nor Claude — EVERY reason", () => {
    const reasons = Object.keys(WARNING) as DictationFallbackReason[];
    // Guard the sweep itself: an empty or shrunken map would satisfy every assertion below
    // vacuously, which is the one way this test could go quiet without anyone noticing.
    expect(reasons).toEqual(
      expect.arrayContaining(["unavailable", "exhausted", "signed_out", "not_entitled"]),
    );

    for (const reason of reasons) {
      cleanup();
      useDictationEngineStore.setState({ fallbackReason: reason, dismissed: false });
      render(<DictationEngineBanner />);
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).not.toMatch(/HTTP \d|\b4\d\d\b|\b5\d\d\b|websocket|deepgram|sherpa|@/i);
      expect(text).not.toMatch(/your network|you're offline|you are offline|Claude|rate.?limit/i);
      // ── NARROWED FROM "EVERY REASON" TO "EVERY RELAY REASON" (roborev 61695) ──────────────────
      // These three sentences are the RELAY fallback's contract: the preview is gone, the local
      // engine took over, and the words still land. They were asserted over every reason because
      // until now every reason WAS a relay reason. `mic_missed_hold` is not — the microphone never
      // started, so there is no preview to lose, no engine that ran, and nothing captured. Asserting
      // them there would force the banner to state three things that are all false, which is the
      // exact defect that reason was added to fix.
      //
      // The sweep still covers it for the no-raw-errors and no-false-blame rules above; only this
      // relay-shaped promise is scoped. See the paired test below, which pins the OPPOSITE for the
      // mic reason so neither can drift into the other's copy.
      if (reason === "mic_missed_hold") continue;
      // What was LOST and that the words still land — the reason the banner exists at all — must be
      // said by every relay reason, not just the two that were written first.
      expect(text).toMatch(/live dictation preview is off/i);
      expect(text).toMatch(/local engine/i);
      expect(text).toMatch(/still captured/i);
    }
  });

  it("NEVER tells a user their words were captured when the mic never started", () => {
    // THE PAIRED OPPOSITE of the sweep above, and the whole point of the reason existing. The
    // founder reported "it doesn't seem to be recognizing the mic" while the UI showed him a banner
    // promising his words were safe — they were not, because no capture was ever built. A copy that
    // reassures here is worse than no banner: it tells him to go looking for a transcript that does
    // not exist.
    //
    // Asserted as an ABSENCE plus a positive claim, because absence alone would pass against an
    // empty string.
    useDictationEngineStore.setState({ fallbackReason: "mic_missed_hold", dismissed: false });
    render(<DictationEngineBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/still captured/i);
    expect(text).not.toMatch(/local engine/i);
    // It must say what actually happened...
    expect(text).toMatch(/nothing was recorded/i);
    // ...and must not blame the device, the permission, or another app: all three were verified
    // working while this fired (the input device bound 41/41 times with zero failures).
    expect(text).not.toMatch(/permission|another app|no microphone|not found|unavailable/i);
  });

  // EACH REASON MUST SAY SOMETHING DIFFERENT, or naming the cause bought nothing: the whole point of
  // carrying the relay's status through is that a user can tell a stale session from an empty
  // balance from an outage. Distinctness across the WHOLE map, so a new reason pasted from an
  // existing one fails here.
  it("gives every reason its own distinct sentence", () => {
    const seen = new Map<string, DictationFallbackReason>();
    for (const reason of Object.keys(WARNING) as DictationFallbackReason[]) {
      cleanup();
      useDictationEngineStore.setState({ fallbackReason: reason, dismissed: false });
      render(<DictationEngineBanner />);
      const text = screen.getByRole("status").textContent ?? "";
      expect(seen.has(text)).toBe(false);
      seen.set(text, reason);
    }
    expect(seen.size).toBe(Object.keys(WARNING).length);
  });

  // THE REMEDY EACH ONE NAMES IS THE APP'S OWN VERB. A remedy string is an instruction the user will
  // follow, so it has to point at a control that exists: "Refill" is ZeroCreditBanner's,
  // "Unlock Sparkle" is AiLockedNotice's $99 paywall. `not_entitled` first said "Upgrade" against a
  // "plan" — neither of which the product has.
  it("names remedies the product actually offers", () => {
    useDictationEngineStore.setState({ fallbackReason: "not_entitled", dismissed: false });
    render(<DictationEngineBanner />);
    const notEntitled = screen.getByRole("status").textContent ?? "";
    expect(notEntitled).toMatch(/unlock sparkle/i);
    expect(notEntitled).not.toMatch(/upgrade|plan|subscription/i);

    cleanup();
    useDictationEngineStore.setState({ fallbackReason: "signed_out", dismissed: false });
    render(<DictationEngineBanner />);
    const signedOut = screen.getByRole("status").textContent ?? "";
    expect(signedOut).toMatch(/sign in/i);
    // It must not send a signed-out user to the credits screen — that was the hedge this change
    // removed from `unavailable`, and re-introducing it here would be the same misdirection.
    expect(signedOut).not.toMatch(/refill|credits/i);
  });

  // THE HEDGE IS GONE FROM `unavailable`, AND ITS ABSENCE IS THE ASSERTION. It said "if it keeps
  // happening, check your Sparkle credits" only because this seam could not tell why the relay
  // refused. It can now — an empty balance arrives as `exhausted` — so the hedge would send a user
  // whose network blipped to inspect a balance that is fine.
  it("no longer sends an unreachable-relay user to check their credits", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    render(<DictationEngineBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/credits/i);
    expect(text).toMatch(/try dictating again in a moment/i);
  });

  it("uses a react-icons glyph, never an emoji, for the caution mark", () => {
    // Standing founder rule: no emoji as icons anywhere in the product.
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    const { container } = render(<DictationEngineBanner />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("disappears when the ✕ is clicked", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    const { container } = render(<DictationEngineBanner />);
    expect(container.innerHTML).not.toBe("");

    fireEvent.click(screen.getByLabelText("Dismiss"));

    // The SIDE EFFECT: the bar is gone from the DOM, not merely that a flag flipped.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("comes back for a DIFFERENT reason after a dismissal", () => {
    // A plain outage waved away must not silence the actionable out-of-credits case: that one has a
    // remedy, so it has something new to say.
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    const { container } = render(<DictationEngineBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(container.innerHTML).toBe("");

    act(() => useDictationEngineStore.getState().noteCloudUnavailable("exhausted"));

    expect(container.innerHTML).not.toBe("");
    expect(screen.getByRole("status").textContent ?? "").toMatch(/refill/i);
  });

  it("stays hidden when the SAME reason is re-reported after a dismissal", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    const { container } = render(<DictationEngineBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss"));

    act(() => useDictationEngineStore.getState().noteCloudUnavailable("unavailable"));

    expect(container.innerHTML).toBe("");
  });

  it("retires itself when a cloud stream comes back", () => {
    useDictationEngineStore.setState({ fallbackReason: "unavailable", dismissed: false });
    const { container } = render(<DictationEngineBanner />);
    expect(container.innerHTML).not.toBe("");

    act(() => useDictationEngineStore.getState().noteCloudLive());

    expect(container.innerHTML).toBe("");
  });

  // ══ THE FOUNDER'S REPORT: "I have no idea why" ═════════════════════════════════════════════════
  // Two failures, and they compound. (1) BOTH sentences opened with the identical 30-character
  // clause "Live dictation preview is off —", so the part that DISCRIMINATES — unreachable relay vs
  // out of credits, which have completely different remedies — arrived after a half-sentence the
  // reader had already seen before. The bar WRAPS rather than truncating (no `whiteSpace: nowrap`,
  // no ellipsis), so this is a recognition failure and not a clipping one: nothing is hidden, so
  // nothing prompts a re-read, and an opening you recognise gets dismissed as "that banner again".
  // (2) Only the `exhausted` case ever named a remedy, so the common case told the user what broke
  // and nothing they could do. A banner you cannot act on and cannot tell apart from its sibling is
  // indistinguishable from noise.

  it("leads with the CAUSE, so the two reasons are told apart at a glance", () => {
    useDictationEngineStore.setState({
      fallbackReason: "unavailable",
      dismissed: false,
    });
    render(<DictationEngineBanner />);
    const unavailable = screen.getByRole("status").textContent ?? "";

    cleanup();
    useDictationEngineStore.setState({
      fallbackReason: "exhausted",
      dismissed: false,
    });
    render(<DictationEngineBanner />);
    const exhausted = screen.getByRole("status").textContent ?? "";

    // A shared prefix is exactly what let the two be conflated: the opening clause is what a reader
    // takes in at a glance, so the opening clause has to be the part that differs.
    expect(unavailable.slice(0, 30)).not.toBe(exhausted.slice(0, 30));
  });

  it("gives the UNAVAILABLE case a remedy too — not just the billable one", () => {
    useDictationEngineStore.setState({
      fallbackReason: "unavailable",
      dismissed: false,
    });
    render(<DictationEngineBanner />);
    const text = screen.getByRole("status").textContent ?? "";

    // The relay recovers by itself and the next dictation re-tries it, so there IS something to
    // tell the user. Saying nothing is what left the founder with "I have no idea why".
    expect(text).toMatch(/try (dictating )?again/i);
  });

  // ══ NO BANNER WHEN THE RELAY IS ACTUALLY WORKING ═══════════════════════════════════════════════
  // The bar used to come down for exactly one reason: a LATER `start_cloud_stream` returning true.
  // Nothing else cleared it — so a transient refusal (tonight: repeated ENOTFOUND waves) left a
  // present-tense outage notice standing over a relay that had been healthy for hours, and the only
  // way out was a restart.

  it("takes itself down once the outage stops being observed — no restart, no re-dictation", () => {
    vi.useFakeTimers();
    act(() =>
      useDictationEngineStore.getState().noteCloudUnavailable("unavailable"),
    );
    const { container } = render(<DictationEngineBanner />);
    expect(container.innerHTML).not.toBe("");

    // The relay healed on its own and the user never dictated again, so nothing re-reported.
    act(() => void vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS + 1000));

    // THE SIDE EFFECT: the bar is gone from the DOM — not merely that a timestamp went stale.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("comes down even when the wall clock lags the timer — the deadline travels with the timer", () => {
    // roborev 59968, and a correction to my own earlier test. `setTimeout` counts MONOTONIC time
    // while `isStale` compares WALL time, and `vi.advanceTimersByTime` moves both together — so no
    // amount of advancing exercises the skew, and the store-level test I wrote first passed against
    // the pre-fix tree because the store already accepted a `now` override. The defect lives at the
    // CALL SITE (dropping the argument), so the test has to be here, and the skew has to be forced.
    //
    // If the effect calls `retireStaleNotice()` bare, the store re-reads a wall clock that is 1 ms
    // short of the deadline, retires nothing, and — since `reason`/`observedAt` never change — no
    // replacement timer is armed and the bar is stuck forever.
    vi.useFakeTimers();
    act(() => useDictationEngineStore.getState().noteCloudUnavailable("unavailable"));
    const observedAt = useDictationEngineStore.getState().observedAt as number;
    const { container } = render(<DictationEngineBanner />);
    expect(container.innerHTML).not.toBe("");

    // `vi.setSystemTime` is NOT enough on its own, and that is the subtlety: running the pending
    // timer advances vitest's faked clock, and the faked `Date` moves with it — erasing the very
    // divergence under test. (My first draft did exactly that and passed against the broken code.)
    // Spying on `Date.now` pins WALL time independently of the TIMER clock, which is precisely the
    // real-world condition: an NTP step or a sleep/wake correction between arming and firing.
    const wallClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(observedAt + FALLBACK_NOTICE_TTL_MS); // 1 ms short of the deadline
    try {
      // The timer fires anyway — it counted its own elapsed delay, not the wall clock.
      act(() => void vi.runOnlyPendingTimers());
      expect(container.innerHTML).toBe("");
    } finally {
      wallClock.mockRestore();
    }
  });

  it("stays up while the outage is still live — expiry must not swallow a real one", () => {
    vi.useFakeTimers();
    act(() =>
      useDictationEngineStore.getState().noteCloudUnavailable("unavailable"),
    );
    const { container } = render(<DictationEngineBanner />);

    // Nearly stale, then the user dictates again and the relay refuses again.
    act(() => void vi.advanceTimersByTime(FALLBACK_NOTICE_TTL_MS - 1000));
    act(() =>
      useDictationEngineStore.getState().noteCloudUnavailable("unavailable"),
    );
    act(() => void vi.advanceTimersByTime(2000));

    expect(container.innerHTML).not.toBe("");
  });
});
