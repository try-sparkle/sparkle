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
  useTrialStore.setState({
    started: true,
    promptsUsed: 0,
    remaining: null,
    cap: null,
    blocked: false,
    loading: false,
  });
});
afterEach(() => {
  cleanup();
  useTrialStore.setState({
    started: false,
    promptsUsed: 0,
    remaining: null,
    cap: null,
    blocked: false,
    loading: true,
  });
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

  it("prefers the SERVER's remaining count over the local estimate", () => {
    // The mirror can drift while offline; once the server has answered, its number is the one shown.
    useTrialStore.setState({ promptsUsed: 3, remaining: 12, cap: 100 });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(screen.getByText(/12 prompts left/)).toBeTruthy();
  });

  it("renders nothing once the SERVER says the trial is exhausted (the upsell takes over)", () => {
    useTrialStore.setState({ promptsUsed: 100, remaining: 0, cap: 100, blocked: true });
    const { container } = render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("still renders at 0 cached prompts when the server has NOT blocked (offline drift)", () => {
    // Fail-open: an offline session can count its cache down to zero. That is not an expired trial,
    // so the counter must stay up and the upsell must NOT take over.
    useTrialStore.setState({ promptsUsed: 100, remaining: 0, cap: 100, blocked: false });
    render(<TrialIndicator onUnlock={vi.fn()} signInFailedUrl={null} />);
    expect(screen.getByTestId("trial-indicator")).toBeTruthy();
    expect(screen.getByText(/0 prompts left/)).toBeTruthy();
  });
});
