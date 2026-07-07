import { describe, it, expect } from "vitest";
import { attentionBodySource } from "./useAttentionNotifications";

// Phase-2c gate (sparkle-rl84): classify what actually supplied a needs-you notification body —
// a fresh self-report, the paid Haiku ask-summary, or the generic reason copy — so we can measure
// how often the paid path is avoided. Pure classifier; carries no identifying data.
describe("attentionBodySource — body-source classification", () => {
  it("self_report wins whenever a self-reported body is present (even if Haiku also had one)", () => {
    expect(attentionBodySource("Wiring the relay", null)).toBe("self_report");
    // Self-report short-circuits BEFORE Haiku is ever called, so haikuBody is null in practice; but
    // even defensively, the self-report takes precedence.
    expect(attentionBodySource("Wiring the relay", "some haiku body")).toBe("self_report");
  });

  it("paid_haiku when there's no self-report but the paid summary produced a body", () => {
    expect(attentionBodySource(null, "Approve deleting the build dir?")).toBe("paid_haiku");
  });

  it("generic_fallback when neither a self-report nor a usable Haiku body exists", () => {
    expect(attentionBodySource(null, null)).toBe("generic_fallback");
  });
});
