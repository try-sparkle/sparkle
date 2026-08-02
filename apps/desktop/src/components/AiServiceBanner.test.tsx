// @vitest-environment jsdom
//
// The app-shell "AI service is sustaining failures" banner. These cover the render branches (hidden
// while healthy / below threshold / dismissed; shown while degraded) plus the copy invariants that
// are the whole point: it must name the affected feature, carry no raw error or PII, and not blame
// the user's balance or network.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiServiceBanner } from "./AiServiceBanner";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  SERVICE_DEGRADED_MAX_AGE_MS,
  useAiServiceHealthStore,
} from "../stores/aiServiceHealthStore";

beforeEach(() => useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE }));
afterEach(cleanup);

describe("AiServiceBanner", () => {
  it("renders nothing while the service is healthy", () => {
    const { container } = render(<AiServiceBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing while failures are below the sustained threshold (not yet degraded)", () => {
    useAiServiceHealthStore.setState({ consecutiveFailures: 2, degraded: false, reason: null });
    const { container } = render(<AiServiceBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("says the AI-Enhanced features are affected once degraded", () => {
    useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason: "unreachable" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("AI-Enhanced features are paused");
    expect(text).toContain("Claude Code");
  });

  it("names the rate-limited cause distinctly", () => {
    useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason: "rate_limited" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("rate-limiting");
    expect(text).not.toContain("Claude Code");
  });

  it("carries no raw error, no refill affordance, and does not blame the user's balance or network", () => {
    useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason: "unreachable" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/HTTP \d|502|refill|top up|upgrade|balance|offline|your network/i);
  });

  it("NEVER attributes the failure to a Sparkle-hosted service, for either reason", () => {
    // THE 2026-08-02 COPY BUG. Both sentences said "the AI service is …", which is a leftover from
    // the retired server-side proxy. These calls run on the user's OWN `claude` CLI now, so there
    // is no Sparkle AI service in this path that CAN be down — and a user whose own Claude
    // allowance was spent read that sentence as "Sparkle is broken" and filed a P0 against a
    // backend that answered 200 on every probe for the entire window.
    for (const reason of ["unreachable", "rate_limited"] as const) {
      cleanup();
      useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason });
      render(<AiServiceBanner />);
      const text = screen.getByRole("status").textContent ?? "";
      expect(text).not.toMatch(/the AI service|Sparkle is (down|broken|unavailable)|our service/i);
      // …and it must still name the thing that IS failing, or it says nothing useful at all.
      expect(text).toMatch(/Claude/);
    }
  });

  it("is dismissible, and stays hidden for the episode once dismissed", () => {
    useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason: "unreachable" });
    const { container } = render(<AiServiceBanner />);
    expect(container.innerHTML).not.toBe("");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(useAiServiceHealthStore.getState().dismissed).toBe(true);
    expect(container.innerHTML).toBe("");
  });

  it("retires itself when the service recovers (degraded cleared)", () => {
    useAiServiceHealthStore.setState({ degraded: true, degradedAt: Date.now(), reason: "unreachable" });
    const { container, rerender } = render(<AiServiceBanner />);
    expect(container.innerHTML).not.toBe("");
    useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
    rerender(<AiServiceBanner />);
    expect(container.innerHTML).toBe("");
  });
});

describe("stale degradation retires itself on an idle screen", () => {
  // The scenario the expiry exists for is precisely the one with NO store writes: the CLI is fixed,
  // so no failures are recorded, and no success is reported (the cached wrappers may not report
  // one). A selector calling Date.now() would never re-evaluate — "until the next render" means
  // "forever" on an idle screen — so the banner needs its own ticker, as ProviderUnavailableBanner
  // already documents.
  it("unmounts once the claim ages out, with no store activity at all", () => {
    vi.useFakeTimers();
    try {
      useAiServiceHealthStore.setState({
        degraded: true,
        degradedAt: Date.now(),
        reason: "unreachable",
        dismissed: false,
        consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      });
      render(<AiServiceBanner />);
      expect(screen.queryByRole("status")).not.toBeNull();

      // Nothing touches the store — only the clock moves.
      act(() => {
        vi.advanceTimersByTime(SERVICE_DEGRADED_MAX_AGE_MS + 61_000);
      });
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
