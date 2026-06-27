// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";

afterEach(() => cleanup());

describe("WelcomeScreen", () => {
  it("renders both boxes, the headline, and the AI-enhancements badge", () => {
    render(<WelcomeScreen onSignIn={vi.fn()} onTryFree={vi.fn()} signInFailedUrl={null} />);
    expect(screen.getByText(/You are/)).toBeTruthy();
    expect(screen.getByText(/Sparkle \+ AI enhancements/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Log in \/ Sign up/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try it now/ })).toBeTruthy();
  });

  it("renders the manual-link fallback when sign-in launch failed", () => {
    render(
      <WelcomeScreen
        onSignIn={vi.fn()}
        onTryFree={vi.fn()}
        signInFailedUrl="https://sparkle.ai/desktop/callback"
      />,
    );
    expect(screen.getByText(/Couldn.t open your browser/)).toBeTruthy();
    expect(screen.getByText("https://sparkle.ai/desktop/callback")).toBeTruthy();
  });
  it("wires the two actions", () => {
    const onSignIn = vi.fn();
    const onTryFree = vi.fn();
    render(<WelcomeScreen onSignIn={onSignIn} onTryFree={onTryFree} signInFailedUrl={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Try it now/ }));
    fireEvent.click(screen.getByRole("button", { name: /Log in \/ Sign up/ }));
    expect(onTryFree).toHaveBeenCalledOnce();
    expect(onSignIn).toHaveBeenCalledOnce();
  });
  it("hides the free-trial box when onTryFree is omitted (exhausted upsell)", () => {
    render(
      <WelcomeScreen onSignIn={vi.fn()} signInFailedUrl={null} banner="You've used all 100 free prompts." />,
    );
    expect(screen.getByRole("button", { name: /Log in \/ Sign up/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Try it now/ })).toBeNull();
    expect(screen.queryByText(/Try it free for 100 prompts/)).toBeNull();
  });

  it("shows a banner when provided (exhausted state)", () => {
    render(
      <WelcomeScreen
        onSignIn={vi.fn()}
        onTryFree={vi.fn()}
        signInFailedUrl={null}
        banner="You've used all 100 free prompts."
      />,
    );
    expect(screen.getByText(/used all 100 free prompts/)).toBeTruthy();
  });
});
