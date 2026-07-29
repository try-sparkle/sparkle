// @vitest-environment jsdom
//
// The app-shell "AI service is sustaining failures" banner. These cover the render branches (hidden
// while healthy / below threshold / dismissed; shown while degraded) plus the copy invariants that
// are the whole point: it must name the affected feature, carry no raw error or PII, and not blame
// the user's balance or network.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiServiceBanner } from "./AiServiceBanner";
import { HEALTHY_SERVICE, useAiServiceHealthStore } from "../stores/aiServiceHealthStore";

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

  it("shows the unavailable message with the 'unreachable' cause once degraded", () => {
    useAiServiceHealthStore.setState({ degraded: true, reason: "unreachable" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("AI-Enhanced features are temporarily unavailable");
    expect(text).toContain("unreachable");
  });

  it("names the rate-limited cause distinctly", () => {
    useAiServiceHealthStore.setState({ degraded: true, reason: "rate_limited" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("rate-limited");
    expect(text).not.toContain("unreachable");
  });

  it("carries no raw error, no refill affordance, and does not blame the user's balance or network", () => {
    useAiServiceHealthStore.setState({ degraded: true, reason: "unreachable" });
    render(<AiServiceBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/HTTP \d|502|refill|top up|upgrade|balance|offline|your network/i);
  });

  it("is dismissible, and stays hidden for the episode once dismissed", () => {
    useAiServiceHealthStore.setState({ degraded: true, reason: "unreachable" });
    const { container } = render(<AiServiceBanner />);
    expect(container.innerHTML).not.toBe("");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(useAiServiceHealthStore.getState().dismissed).toBe(true);
    expect(container.innerHTML).toBe("");
  });

  it("retires itself when the service recovers (degraded cleared)", () => {
    useAiServiceHealthStore.setState({ degraded: true, reason: "unreachable" });
    const { container, rerender } = render(<AiServiceBanner />);
    expect(container.innerHTML).not.toBe("");
    useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
    rerender(<AiServiceBanner />);
    expect(container.innerHTML).toBe("");
  });
});
