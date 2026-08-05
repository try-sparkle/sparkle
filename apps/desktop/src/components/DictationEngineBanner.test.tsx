// @vitest-environment jsdom
//
// The "dictation fell back to the local engine" banner. These assert what RENDERS, never a
// precondition the store already satisfied: the resting state paints nothing, each coarse reason
// paints its own distinct sentence, the ✕ actually removes it, and a NEW reason gets through a
// dismissal. The copy invariants are load-bearing too — the banner exists to name what was LOST
// (the live preview), and it must not blame the network or the user's Claude allowance, which are
// other banners' jobs.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DictationEngineBanner } from "./DictationEngineBanner";
import { useDictationEngineStore } from "../stores/dictationEngineStore";

beforeEach(() => useDictationEngineStore.setState({ fallbackReason: null, dismissed: false }));
afterEach(cleanup);

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
});
