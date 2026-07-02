// @vitest-environment jsdom
//
// Improvement A: the "Free trial · N prompts left" counter + Unlock moved OUT of a floating,
// position:fixed pill (which covered the TopBar action buttons) into plain in-bar text. These
// tests pin the new rendering contract: real counter/plural text, an Unlock button, NO fixed
// positioning / pill chrome, and a null render once the trial is spent (the full-screen upsell
// takes over then).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TrialIndicator } from "./TrialChrome";
import { useTrialStore } from "../stores/trialStore";

beforeEach(() => {
  useTrialStore.setState({ started: true, promptsUsed: 0, loading: false });
});
afterEach(() => {
  cleanup();
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: true });
});

describe("TrialIndicator (in-bar trial counter)", () => {
  it("renders the remaining-prompt count and an Unlock button", () => {
    useTrialStore.setState({ promptsUsed: 3 });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(screen.getByText(/97 prompts left/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unlock/ })).toBeTruthy();
  });

  it("pluralizes correctly for a single remaining prompt", () => {
    useTrialStore.setState({ promptsUsed: 99 });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(screen.getByText(/1 prompt left/)).toBeTruthy();
    expect(screen.queryByText(/1 prompts left/)).toBeNull();
  });

  it("is plain bar text — NOT a floating pill that could cover the TopBar buttons", () => {
    useTrialStore.setState({ promptsUsed: 3 });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    const el = screen.getByTestId("trial-indicator");
    // The regression this feature fixes: the old pill was position:fixed with a background/border,
    // pinned top-right, so it sat ON TOP of the action buttons. The in-bar version must do none of
    // that — it flows in the row like the other controls.
    expect(el.style.position).not.toBe("fixed");
    expect(el.style.background).toBe("");
    expect(el.style.border).toBe("");
  });

  it("invokes the provided Unlock handler when clicked", () => {
    useTrialStore.setState({ promptsUsed: 3 });
    const onUnlock = vi.fn();
    render(<TrialIndicator onUnlock={onUnlock} signInFailedUrl={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a bounded copy-link fallback (not the raw URL) when the browser hand-off failed", () => {
    useTrialStore.setState({ promptsUsed: 3 });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl="https://checkout.stripe.com/c/pay/very-long-session-url" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    // The raw URL must NOT be rendered inline (a long Stripe/sign-in URL would either widen the bar
    // or ellipsis-truncate to something unusable). The recovery is a one-click Copy button instead.
    expect(screen.getByRole("button", { name: /copy sign-in link/i })).toBeTruthy();
    expect(screen.queryByText("https://checkout.stripe.com/c/pay/very-long-session-url")).toBeNull();
  });

  it("renders nothing once the trial is exhausted (the full-screen upsell takes over)", () => {
    useTrialStore.setState({ promptsUsed: 100 });
    const { container } = render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(container.firstChild).toBeNull();
  });
});
