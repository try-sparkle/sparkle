// @vitest-environment jsdom
//
// The "Sparkle's AI provider is down" banner — the counterpart to ZeroCreditBanner for the failure
// that is OURS. These cover the render branches plus the three things the copy must never do, which
// are the whole point of the component: offer a Refill (the user's balance is fine), blame their
// network, or render nothing at all while AI is dead.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderUnavailableBanner, PROVIDER_UNAVAILABLE_BAR_TESTID } from "./ProviderUnavailableBanner";
import { OUTAGE_MAX_AGE_MS, useAiProviderStore } from "../stores/aiProviderStore";

beforeEach(() => useAiProviderStore.setState({ outage: null }));
afterEach(cleanup);

describe("ProviderUnavailableBanner", () => {
  it("renders nothing while the provider is healthy", () => {
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names the missing CLI and tells the user how to fix it", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Claude Code CLI");
    // The load-bearing half: the user must not read this as their own balance.
    // The copy used to say "ours to fix" and give the user nothing to do, because the cause was
    // Sparkle's own unfunded vendor account. Every remaining cause is theirs to act on, so the
    // sentence has to carry an action.
    expect(text).toContain("Install it");
    // The old copy reassured "your credits and network are fine", which was right when the cause
    // was Sparkle's own unfunded account. It is the wrong shape now — the cause IS the user's
    // setup — but the property underneath it survives and still matters: never send someone to the
    // credits screen for a problem a top-up cannot fix.
    expect(text).not.toMatch(/credit/i);
  });

  it("distinguishes a rejected key from an unfunded account", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_not_authenticated", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("sign in");
    expect(text).not.toContain("Install it");
  });

  it("offers NO refill affordance — taking the user's money would fix nothing", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/refill|top up|upgrade|buy/i);
  });

  it("has no dismiss control — an outage the user cannot act on must not be re-hidden", () => {
    // ZeroCreditBanner has a ✕ because the user can act on it and may not want to now. Here a ✕
    // would restore exactly the silence that let a 12-hour outage go unnoticed.
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("renders the inline variant for Settings → Credits", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner inline />);
    expect(screen.getByRole("status").textContent ?? "").toContain("Claude Code CLI");
  });

  it("does not assert a STALE observation — a forgotten clear cannot strand a false banner", () => {
    // Second line of defence behind "every proxied wrapper reports success" (roborev 54761). The
    // banner has no dismiss control, so an un-cleared record would otherwise claim a broken provider
    // for the rest of the session while it is healthy.
    useAiProviderStore.setState({
      outage: { reason: "cli_missing", at: Date.now() - OUTAGE_MAX_AGE_MS - 1 },
    });
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("disappears on its own once the provider recovers", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    const { container, rerender } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).not.toBe("");
    useAiProviderStore.setState({ outage: null });
    rerender(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });
});

/**
 * ── THE NARROW-WINDOW GUARD (bead sparkle-kk9dg.2) ─────────────────────────────────────────────
 *
 * jsdom has NO LAYOUT ENGINE, so nothing here can observe wrapping, overflow or clipping — a test
 * claiming to see the banner clipped would measure nothing at all (docs/jsdom-test-caveats.md).
 * These assert the STYLE SHAPE only. The pixels are proven separately, in real Chrome, by
 * BannerStack.layout.test.ts; this block is the cheap always-runs guard that the two properties
 * that shape survive are still on the element.
 */
describe("the bar's layout shape at a narrow window", () => {
  it("top-anchors its content rather than centring it", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const bar = screen.getByTestId(PROVIDER_UNAVAILABLE_BAR_TESTID);
    // `center` is the ONE value that can place the sentence's first line ABOVE this box's top
    // edge, where an ancestor with hidden overflow eats it — i.e. "the subject is cut off above
    // the viewport", with the reader unable to tell what the banner is even about.
    expect(bar.style.alignItems).toBe("flex-start");
  });

  it("never caps its own height — wrapping to more lines is the whole remedy", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const bar = screen.getByTestId(PROVIDER_UNAVAILABLE_BAR_TESTID);
    // A taller banner is fine; a clipped one is not. Anything that fixes the height here would
    // reintroduce "a box shorter than its content" with the centring gone but the damage back.
    expect(bar.style.height).toBe("");
    expect(bar.style.maxHeight).toBe("");
    // ...and the shell (a flex column) must not be able to squash it either.
    expect(bar.style.flexShrink).toBe("0");
  });

  it("lets the sentence wrap instead of spilling off both edges", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const sentence = screen.getByRole("status");
    // A flex item's default `min-width: auto` floor is min-content, which makes a long sentence
    // OVERFLOW a narrow bar rather than wrap — and under `justify-content: center` it overflows
    // equally at both ends, leaving exactly the middle. That is the founder's fragment.
    expect(sentence.style.minWidth).toBe("0");
    expect(sentence.style.overflowWrap).toBe("break-word");
  });
});
