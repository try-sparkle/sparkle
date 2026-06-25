import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENTS } from "@sparkle/core";

// Safety-critical guarantee: with no VITE_PUBLIC_POSTHOG_KEY set (the default in
// tests / dev / CI), analytics must stay fully inert — initAnalytics() and
// capture() never throw and never touch the PostHog client. If they did, a
// missing key could break app launch.
vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(() => {
      throw new Error("posthog should not be initialized without a key");
    }),
    capture: vi.fn(() => {
      throw new Error("posthog should not capture without a key");
    }),
    register: vi.fn(),
    identify: vi.fn(),
  },
}));

describe("desktop analytics (no key configured)", () => {
  it("initAnalytics and capture are inert no-ops, never throwing", async () => {
    const { initAnalytics, capture, identifyUser } = await import("./analytics");
    expect(() => initAnalytics()).not.toThrow();
    expect(() => capture(ANALYTICS_EVENTS.APP_OPENED)).not.toThrow();
    expect(() => identifyUser("user_123")).not.toThrow();
  });
});
