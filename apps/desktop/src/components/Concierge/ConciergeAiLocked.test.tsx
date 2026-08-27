// @vitest-environment jsdom
//
// The locked panel that stands in for the concierge's thread + composer when AI enhancements are
// not running. The subject here is that each of the three reasons offers the RIGHT remedy — the
// pitch is shared, the action is not:
//   flag_off     → turn the setting back on (⋯ Settings → AI features). Never a purchase.
//   not_entitled → the existing $99 AiLockedNotice.
//   no_credits   → the existing Refill seam, and emphatically NOT a "buy the app" upsell: this
//                  user already bought it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// AiLockedNotice's own checkout rails would otherwise reach for Tauri; its behavior is covered by
// AiLockedNotice.test. Here we only care that this panel mounts it for the not_entitled reason.
vi.mock("../../services/sparkleApi", () => ({
  openPaywall: vi.fn(() => Promise.resolve(true)),
  PAYWALL_URL: "https://sparkle.ai/paywall",
}));
vi.mock("../../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(() => Promise.resolve(true)),
  lastCheckoutUrl: vi.fn(() => null),
}));

import {
  ConciergeAiLocked,
  CONCIERGE_AI_PITCH,
  CONCIERGE_DEV_UNLOCK_COMMAND,
  CONCIERGE_DEV_UNLOCK_TESTID,
} from "./ConciergeAiLocked";
import { useUiStore } from "../../stores/uiStore";

beforeEach(() => useUiStore.setState({ settingsRequest: null }));
afterEach(() => cleanup());

describe("ConciergeAiLocked — the shared half", () => {
  it("sells the enhancement with the badge and the pitch, whatever the reason", () => {
    for (const reason of ["flag_off", "not_entitled", "no_credits"] as const) {
      render(<ConciergeAiLocked reason={reason} />);
      expect(screen.getByText("Sparkle + AI enhancements")).toBeTruthy();
      expect(screen.getByText(CONCIERGE_AI_PITCH)).toBeTruthy();
      cleanup();
    }
  });
});

describe("ConciergeAiLocked — flag_off routes to settings, not to a checkout", () => {
  it("offers 'Turn on AI enhancements' and deep-opens the AI features pane", () => {
    render(<ConciergeAiLocked reason="flag_off" />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on AI enhancements" }));
    expect(useUiStore.getState().settingsRequest).toBe("ai");
  });

  it("never pitches the $99 — the feature is switched off, not unbought", () => {
    render(<ConciergeAiLocked reason="flag_off" />);
    expect(screen.queryByRole("button", { name: /Unlock Sparkle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refill" })).toBeNull();
  });
});

describe("ConciergeAiLocked — not_entitled hands off to the existing paywall notice", () => {
  it("mounts AiLockedNotice rather than a second, private upsell", () => {
    render(<ConciergeAiLocked reason="not_entitled" />);
    expect(screen.getByRole("button", { name: /Unlock Sparkle/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on AI enhancements" })).toBeNull();
  });
});

describe("ConciergeAiLocked — no_credits routes to a top-up", () => {
  it("offers Refill, which deep-opens the Credits pane", () => {
    render(<ConciergeAiLocked reason="no_credits" />);
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  it("shows NO buy-the-app upsell — this user already bought Sparkle", () => {
    render(<ConciergeAiLocked reason="no_credits" />);
    expect(screen.queryByRole("button", { name: /Unlock Sparkle/i })).toBeNull();
    expect(screen.queryByText(/\$99/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on AI enhancements" })).toBeNull();
  });
});

// ══ THE DEV-BUILD ROUTE OUT (bead sparkle-wfev6) ══════════════════════════════════════════════
// A fresh dev profile has no Sparkle account, so this panel is what a developer sent to "verify the
// concierge in a running build" actually gets — and the only remedy it offered was a checkout they
// are not going to run. The panel now names the dev unlock beside it. The condition has two halves
// and BOTH are asserted, because each alone would pass for a broken version of the other:
//   • present on not_entitled / no_credits — otherwise the hint is dead code and the wall is back;
//   • ABSENT on flag_off — the bypass sets an entitled `me`, it does not turn a switched-off
//     setting on, so offering it there is an instruction that does nothing. That is the exact
//     unfollowable-remedy failure AGENTS.md records, and it is the assertion with teeth here.
// vitest runs with `import.meta.env.DEV` true, which is the dev build this hint is scoped to; the
// release direction is enforced by the inline `import.meta.env.DEV` vite statically replaces, and
// is covered where that gate lives (dev/devBypassAuth.test.ts).
describe("ConciergeAiLocked — the dev-build unlock hint", () => {
  it("names the exact command on not_entitled — the fresh dev profile the bead reports", () => {
    render(<ConciergeAiLocked reason="not_entitled" />);
    expect(screen.getByTestId(CONCIERGE_DEV_UNLOCK_TESTID).textContent).toContain(
      CONCIERGE_DEV_UNLOCK_COMMAND,
    );
  });

  it("names it on no_credits too — an entitled dev at a zero balance is still walled off", () => {
    render(<ConciergeAiLocked reason="no_credits" />);
    expect(screen.getByTestId(CONCIERGE_DEV_UNLOCK_TESTID).textContent).toContain(
      CONCIERGE_DEV_UNLOCK_COMMAND,
    );
  });

  it("stays OFF on flag_off, where the bypass would change nothing", () => {
    render(<ConciergeAiLocked reason="flag_off" />);
    expect(screen.queryByTestId(CONCIERGE_DEV_UNLOCK_TESTID)).toBeNull();
    // And the branch that DOES work there is still the only thing offered.
    expect(screen.getByRole("button", { name: "Turn on AI enhancements" })).toBeTruthy();
  });
});
