// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SparkleConsentBanner, consentCopy } from "./SparkleConsentBanner";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

// The banner now routes mode changes through setImprovementConsent, which mirrors the choice to
// config.toml via setConfigValue → a Tauri invoke that is absent under jsdom. Stub just that write
// (keeping the rest of the module real) so a click updates the store without a caught invoke error.
vi.mock("../services/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/config")>()),
  setConfigValue: vi.fn().mockResolvedValue(undefined),
}));

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

// These bullets are the ONLY place the user is told what leaves their machine, so they must match
// the Rust gate in src-tauri/src/crash.rs (`upload_allowed` / `logs_allowed`) exactly. The pipeline
// went dark because the copy said "crash reports are only sent on 'Always'" while the gate disagreed
// — pin each mode's promise here so a future gate change can't silently make the app lie again.
describe("consentCopy — crash-report promises match the Rust upload gate", () => {
  /** The crash-report bullets for a mode (the copy that makes the upload promise). */
  const crashBullets = (mode: Parameters<typeof consentCopy>[0]) =>
    consentCopy(mode).bullets.filter((b) => /crash/i.test(b));

  it("case_by_case says the crash report IS uploaded but the recent logs are NOT", () => {
    const bullets = crashBullets("case_by_case");
    // It uploads (matching upload_allowed("case_by_case") === true)...
    expect(bullets.some((b) => b.includes("we securely upload a scrubbed crash report"))).toBe(true);
    expect(bullets.some((b) => b.includes("message and backtrace only"))).toBe(true);
    expect(bullets.some((b) => b.includes("never any PII, secrets, or code"))).toBe(true);
    // ...but without the log tail (matching logs_allowed("case_by_case") === false).
    const all = consentCopy("case_by_case").bullets.join(" ");
    expect(all).toContain("Your recent logs are NOT sent on this setting");
    // It must NOT claim crash reports stay on-device — the old lie this test exists to prevent.
    expect(bullets.some((b) => /only uploaded on 'Always'|stay on your device/.test(b))).toBe(false);
  });

  it("always says the crash report AND the recent logs are uploaded", () => {
    const bullets = crashBullets("always");
    expect(bullets.some((b) => b.includes("we securely upload a scrubbed crash report"))).toBe(true);
    // The log tail is the "Always"-only tier (logs_allowed("always") === true).
    const all = consentCopy("always").bullets.join(" ");
    expect(all).toContain("recent logs (last ~hour)");
    expect(all).toContain("On 'Always'");
  });

  // Attribution was added to the crash payload (an optional Authorization: Bearer resolved from the
  // keychain, plus the build channel and git sha). That widened what a consenting upload reveals, so
  // BOTH consenting tiers must say so — and "never" must still promise none of it leaves the machine.
  it("both consenting tiers disclose the account + build attribution, and its signed-out fallback", () => {
    for (const mode of ["case_by_case", "always"] as const) {
      const all = consentCopy(mode).bullets.join(" ");
      expect(all, mode).toContain("which install and which build it came from");
      expect(all, mode).toContain("only if you are signed in");
      expect(all, mode).toContain("Signed out, it stays anonymous");
    }
  });

  it("no consenting tier still calls the crash report flatly anonymized", () => {
    // It is anonymous only when signed OUT; an unqualified "anonymized" is now a false promise.
    for (const mode of ["case_by_case", "always"] as const) {
      const bullets = crashBullets(mode);
      expect(bullets.some((b) => /backtrace only, anonymized/.test(b)), mode).toBe(false);
    }
  });

  it("never promises no account or build information either", () => {
    const all = consentCopy("never").bullets.join(" ");
    expect(all).toContain("no account or build information");
    expect(all).not.toContain("only if you are signed in");
  });

  it("the HEADLINE makes no unqualified anonymity promise either", () => {
    // The per-tier bullets are test-pinned, but the overarching question is what most users
    // actually read — and it used to say "anonymous logs & crash reports", contradicting the
    // bullets the moment a signed-in user's report carries their account.
    render(<SparkleConsentBanner />);
    const headline = screen.getByText(/Can we use your .*logs .* crash reports/);
    expect(headline.textContent).not.toMatch(/anonymous/i);
  });

  it("never says nothing is uploaded", () => {
    const bullets = crashBullets("never");
    expect(bullets.some((b) => b.includes("nothing is uploaded"))).toBe(true);
    expect(bullets.some((b) => b.includes("no crash reports, no logs, and no account or build information"))).toBe(true);
    // No mode may promise an upload on "never" (upload_allowed("never") === false).
    expect(bullets.some((b) => b.includes("we securely upload"))).toBe(false);
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

// ── THE BANNER MUST NOT SET ITS COLUMN'S FLOOR ────────────────────────────────────────────────
//
// THE LOCKOUT THIS PINS. The founder: "I can't zoom the right terminal … zoomed out enough to be
// able to log back in because it's the always / case by case / never row that's keeping it from
// zooming." A consent banner denied him access to the agent behind it.
//
// Two causes, and both are asserted here:
//   1. The Always / Case by case / Never row was an unbreakable `inline-flex` with no `minWidth: 0`,
//      so its min-content width was a floor the pane could not shrink below.
//   2. `Cmd -` on a terminal column only ever shrank xterm's FONT, so this React chrome kept its
//      full height while the terminal got smaller — zooming out bought fewer rows than it should.
//
// WHAT jsdom CAN AND CANNOT ANSWER. It has no layout engine, so "does this impose a floor" is not
// askable of the rendered DOM — every rect is 0. So these assert the STRUCTURAL properties that make
// shrinking possible at all, which is the same split `ComposeBox.narrow.test.tsx` documents. The
// measured result was verified in real WebKit: the banner's min-content width drops from 250px to
// 80px, and zooming to 0.7 returns 35px of height to the terminal.
describe("the banner does not prop its column open", () => {
  it("lets every box in its chain shrink below its content", () => {
    // `min-width: auto` — a flex item's default — is what refuses to shrink. Without overriding it
    // no amount of wrapping downstream helps, because the ancestor never gets smaller in the first
    // place. Asserted on every level, because ONE missing link restores the floor.
    render(<SparkleConsentBanner />);
    const region = screen.getByRole("region", { name: "Sparkle improvement consent" });
    expect(region.style.minWidth).toBe("0");
    const group = screen.getByRole("group", { name: "Consent mode" });
    expect(group.style.minWidth).toBe("0");
    // …and the three buttons may stack rather than demanding one unbreakable row.
    expect(group.style.flexWrap).toBe("wrap");
  });

  it("SCALES with its column's zoom, so zooming out returns height to the terminal", () => {
    // The half that actually unlocked the founder. The banner is not xterm, so the terminal's font
    // scaling never touched it; reading the same per-column level makes "zoom this column out" mean
    // the whole column. Asserted as the rendered `zoom`, which is the thing that gives the height
    // back — not as "the hook was called", which would be a precondition.
    useUiStore.getState().resetAllZoom();
    const { rerender } = render(<SparkleConsentBanner />);
    const at = () =>
      screen.getByRole("region", { name: "Sparkle improvement consent" }).style.zoom;
    expect(at()).toBe("1");

    act(() => useUiStore.getState().setColumnZoom("terminal-right", 0.7));
    rerender(<SparkleConsentBanner />);
    expect(at()).toBe("0.7");

    // …and it is THIS column's level, not any other. Zooming a different column must not move it —
    // that independence is the whole point of the per-column work this rides on.
    act(() => useUiStore.getState().setColumnZoom("concierge", 1.8));
    rerender(<SparkleConsentBanner />);
    expect(at()).toBe("0.7");
  });
});
