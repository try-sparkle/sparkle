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
import { DictationEngineBanner } from "./DictationEngineBanner";
import { FALLBACK_NOTICE_TTL_MS, useDictationEngineStore } from "../stores/dictationEngineStore";

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

  it("carries no raw error or status code, and blames neither the network nor Claude", () => {
    for (const reason of ["unavailable", "exhausted"] as const) {
      cleanup();
      useDictationEngineStore.setState({ fallbackReason: reason, dismissed: false });
      render(<DictationEngineBanner />);
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).not.toMatch(/HTTP \d|\b4\d\d\b|\b5\d\d\b|websocket|deepgram|sherpa|@/i);
      expect(text).not.toMatch(/your network|you're offline|you are offline|Claude|rate.?limit/i);
    }
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
