// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SparkleConsentBanner, consentCopy } from "./SparkleConsentBanner";
import { useSettingsStore } from "../stores/settingsStore";

afterEach(cleanup);
beforeEach(() => {
  // Reset to the default mode before each test so selection assertions are deterministic.
  useSettingsStore.getState().setSparkleImprovementConsent("case_by_case");
});

describe("consentCopy — per-mode wording", () => {
  it("case_by_case promises per-PR review before submission", () => {
    const { bullets } = consentCopy("case_by_case");
    expect(bullets.some((b) => b.includes("You review and approve every PR before it is submitted"))).toBe(
      true,
    );
    expect(bullets.some((b) => b.includes("No PII, secrets, code snippets"))).toBe(true);
  });

  it("always states PRs are submitted automatically", () => {
    const { bullets } = consentCopy("always");
    expect(bullets.some((b) => b.includes("submitted automatically"))).toBe(true);
    // Even on Always, the scrubbing promise is still shown.
    expect(bullets.some((b) => b.includes("No PII, secrets, code snippets"))).toBe(true);
  });

  it("never says logs are not evaluated and stay on-device", () => {
    const { lead, bullets } = consentCopy("never");
    expect(lead).toContain("will not evaluate your logs");
    expect(bullets.some((b) => b.includes("stay on your device"))).toBe(true);
  });
});

describe("SparkleConsentBanner", () => {
  it("defaults to Case by case selected (aria-pressed)", () => {
    render(<SparkleConsentBanner />);
    expect(screen.getByRole("button", { name: "Case by case" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Always" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("collapses the detail by default and reveals it only on hover", () => {
    render(<SparkleConsentBanner />);
    const region = screen.getByRole("region", { name: "Sparkle improvement consent" });
    // The question + control are always visible; the "how it works" detail is not.
    expect(screen.getByText(/improve Sparkle\?/)).toBeTruthy();
    expect(screen.queryByText(/Here's how it works/)).toBeNull();
    // Hover reveals it; leaving hides it again.
    fireEvent.mouseEnter(region);
    expect(screen.getByText(/Here's how it works/)).toBeTruthy();
    fireEvent.mouseLeave(region);
    expect(screen.queryByText(/Here's how it works/)).toBeNull();
  });

  it("clicking a mode persists it and (on hover) swaps the detail copy", () => {
    render(<SparkleConsentBanner />);
    const region = screen.getByRole("region", { name: "Sparkle improvement consent" });
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("always");
    expect(screen.getByRole("button", { name: "Always" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.mouseEnter(region);
    expect(within(region).getByText(/submitted automatically/)).toBeTruthy();
  });

  it("Never selection shows the no-evaluation copy on hover", () => {
    render(<SparkleConsentBanner />);
    const region = screen.getByRole("region", { name: "Sparkle improvement consent" });
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    expect(useSettingsStore.getState().sparkleImprovementConsent).toBe("never");
    fireEvent.mouseEnter(region);
    expect(screen.getByText(/will not evaluate your logs/)).toBeTruthy();
  });

  it("the disclosure toggle reveals/hides the detail on click (touch/click parity)", () => {
    render(<SparkleConsentBanner />);
    const toggle = screen.getByRole("button", { name: "How it works" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // While collapsed, aria-controls must not dangle (its target is rendered only when open).
    expect(toggle.getAttribute("aria-controls")).toBeNull();
    expect(screen.queryByText(/Here's how it works/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("sparkle-consent-detail");
    expect(document.getElementById("sparkle-consent-detail")).not.toBeNull();
    expect(screen.getByText(/Here's how it works/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Here's how it works/)).toBeNull();
  });

  it("tap-to-open works even when the button gains focus first (Chromium webview ordering)", () => {
    // On Chromium/WebView2 a button focuses before the click fires. Reproduce that ordering on a
    // CLOSED toggle and assert the net result is OPEN (not a flash-then-close). Because `open` is
    // not tied to focus-within, the focus is a no-op and the click pins it open.
    render(<SparkleConsentBanner />);
    const toggle = screen.getByRole("button", { name: "How it works" });
    fireEvent.focus(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Here's how it works/)).toBeTruthy();
  });

  it("a click-pinned detail stays open after the mouse leaves, and collapses on a second click", () => {
    render(<SparkleConsentBanner />);
    const region = screen.getByRole("region", { name: "Sparkle improvement consent" });
    const toggle = screen.getByRole("button", { name: "How it works" });
    fireEvent.click(toggle); // pin open
    fireEvent.mouseEnter(region);
    fireEvent.mouseLeave(region); // hover gone, but pin keeps it open
    expect(screen.getByText(/Here's how it works/)).toBeTruthy();
    fireEvent.click(toggle); // un-pin
    expect(screen.queryByText(/Here's how it works/)).toBeNull();
  });
});
