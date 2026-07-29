// @vitest-environment jsdom
//
// The "Sparkle's AI provider is down" banner — the counterpart to ZeroCreditBanner for the failure
// that is OURS. These cover the render branches plus the three things the copy must never do, which
// are the whole point of the component: offer a Refill (the user's balance is fine), blame their
// network, or render nothing at all while AI is dead.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderUnavailableBanner } from "./ProviderUnavailableBanner";
import { OUTAGE_MAX_AGE_MS, useAiProviderStore } from "../stores/aiProviderStore";

beforeEach(() => useAiProviderStore.setState({ outage: null }));
afterEach(cleanup);

describe("ProviderUnavailableBanner", () => {
  it("renders nothing while the provider is healthy", () => {
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names an unfunded provider account and says it is ours to fix", () => {
    useAiProviderStore.setState({ outage: { reason: "provider_unfunded", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("out of credit");
    // The load-bearing half: the user must not read this as their own balance.
    expect(text).toContain("ours to fix");
    expect(text).toContain("your credits and network are fine");
  });

  it("distinguishes a rejected key from an unfunded account", () => {
    useAiProviderStore.setState({ outage: { reason: "provider_key_rejected", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("rejected our credentials");
    expect(text).not.toContain("out of credit");
  });

  it("offers NO refill affordance — taking the user's money would fix nothing", () => {
    useAiProviderStore.setState({ outage: { reason: "provider_unfunded", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/refill|top up|upgrade|buy/i);
  });

  it("has no dismiss control — an outage the user cannot act on must not be re-hidden", () => {
    // ZeroCreditBanner has a ✕ because the user can act on it and may not want to now. Here a ✕
    // would restore exactly the silence that let a 12-hour outage go unnoticed.
    useAiProviderStore.setState({ outage: { reason: "provider_unfunded", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("renders the inline variant for Settings → Credits", () => {
    useAiProviderStore.setState({ outage: { reason: "provider_unfunded", at: Date.now() } });
    render(<ProviderUnavailableBanner inline />);
    expect(screen.getByRole("status").textContent ?? "").toContain("out of credit");
  });

  it("does not assert a STALE observation — a forgotten clear cannot strand a false banner", () => {
    // Second line of defence behind "every proxied wrapper reports success" (roborev 54761). The
    // banner has no dismiss control, so an un-cleared record would otherwise claim a broken provider
    // for the rest of the session while it is healthy.
    useAiProviderStore.setState({
      outage: { reason: "provider_unfunded", at: Date.now() - OUTAGE_MAX_AGE_MS - 1 },
    });
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("disappears on its own once the provider recovers", () => {
    useAiProviderStore.setState({ outage: { reason: "provider_unfunded", at: Date.now() } });
    const { container, rerender } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).not.toBe("");
    useAiProviderStore.setState({ outage: null });
    rerender(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });
});
