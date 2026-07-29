import { describe, it, expect, beforeEach } from "vitest";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  classifyServiceFailure,
  reduceFailure,
  reduceSuccess,
  useAiServiceHealthStore,
  type AiServiceHealth,
} from "./aiServiceHealthStore";

/** Fold n genuine service failures (same reason) into a fresh state. */
function failTimes(n: number, reason: "unreachable" | "rate_limited"): AiServiceHealth {
  let s = HEALTHY_SERVICE;
  for (let i = 0; i < n; i += 1) s = reduceFailure(s, { kind: "degrade", reason });
  return s;
}

describe("classifyServiceFailure", () => {
  it("degrades on every 5xx the proxy surfaces, as 'unreachable'", () => {
    for (const code of [500, 502, 503, 504, 529, 599]) {
      expect(classifyServiceFailure(`ai request failed (HTTP ${code})`)).toEqual({
        kind: "degrade",
        reason: "unreachable",
      });
    }
  });

  it("degrades on 429 as 'rate_limited', distinct from unreachable", () => {
    expect(classifyServiceFailure("ai request failed (HTTP 429)")).toEqual({
      kind: "degrade",
      reason: "rate_limited",
    });
  });

  it("IGNORES the local transport sentinel — offline is OfflineBanner's, not the service's", () => {
    // Finding: `ai_unreachable` means the machine has no network path; counting it would blame
    // Sparkle's service for the user's dead link and stack a banner on top of OfflineBanner.
    expect(classifyServiceFailure("ai_unreachable")).toEqual({ kind: "ignore" });
  });

  it("ignores per-request 4xx (other than 429) — the service is up, the call is wrong", () => {
    for (const code of [400, 401, 403, 404, 408]) {
      expect(classifyServiceFailure(`ai request failed (HTTP ${code})`)).toEqual({ kind: "ignore" });
    }
    expect(classifyServiceFailure("upstream returned 502 for the request")).toEqual({ kind: "ignore" });
    expect(classifyServiceFailure("")).toEqual({ kind: "ignore" });
  });

  it("YIELDS to the more specific banners rather than double-warning", () => {
    // $0 user balance → ZeroCreditBanner; provider-account sentinel → ProviderUnavailableBanner.
    expect(classifyServiceFailure("insufficient_credits:0")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("insufficient_credits:1234")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured:provider_unfunded")).toEqual({ kind: "yield" });
    expect(classifyServiceFailure("ai_unconfigured:provider_key_rejected")).toEqual({ kind: "yield" });
  });
});

describe("reduceFailure — the sustained-failure detector", () => {
  it("stays healthy below the threshold — a lone blip does NOT light the banner", () => {
    const s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    expect(s.degraded).toBe(false);
    expect(s.consecutiveFailures).toBe(AI_SERVICE_DEGRADED_THRESHOLD - 1);
  });

  it("goes degraded EXACTLY on the threshold-th consecutive failure", () => {
    const below = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    expect(below.degraded).toBe(false);
    const at = reduceFailure(below, { kind: "degrade", reason: "unreachable" });
    expect(at.degraded).toBe(true);
    expect(at.reason).toBe("unreachable");
  });

  it("carries the latest reason so the banner names the current cause", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.reason).toBe("unreachable");
    s = reduceFailure(s, { kind: "degrade", reason: "rate_limited" });
    expect(s.reason).toBe("rate_limited");
    expect(s.degraded).toBe(true);
  });

  it("an IGNORE outcome resets the run — a 4xx or offline blip can't accumulate to degraded", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    s = reduceFailure(s, { kind: "ignore" }); // e.g. a 400, or ai_unreachable
    expect(s.consecutiveFailures).toBe(0);
    s = reduceFailure(s, { kind: "degrade", reason: "unreachable" });
    expect(s.degraded).toBe(false); // run restarted, threshold not reached
  });

  it("an IGNORE outcome does NOT clear an already-degraded banner — only success/yield does", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, { kind: "ignore" });
    expect(s.degraded).toBe(true);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("a YIELD outcome CLEARS an already-degraded banner — the specific banner takes over", () => {
    // Finding: 502s degrade us, then the server returns ai_unconfigured/insufficient_credits and its
    // dedicated banner lights. Ours must step aside so the user never sees two stacked amber bars.
    let s: AiServiceHealth = { ...failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable"), dismissed: true };
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, { kind: "yield" });
    expect(s).toEqual(HEALTHY_SERVICE);
  });

  it("returns the SAME reference when a repeated ignore changes nothing", () => {
    const s = reduceFailure(HEALTHY_SERVICE, { kind: "ignore" }); // already zero run
    expect(s).toBe(HEALTHY_SERVICE);
  });
});

describe("reduceSuccess", () => {
  it("clears degradation AND a prior dismissal, so a later outage speaks again", () => {
    const degradedDismissed: AiServiceHealth = {
      consecutiveFailures: 9,
      degraded: true,
      reason: "unreachable",
      dismissed: true,
    };
    expect(reduceSuccess(degradedDismissed)).toEqual(HEALTHY_SERVICE);
  });

  it("returns the same reference when already healthy (no needless notify)", () => {
    expect(reduceSuccess(HEALTHY_SERVICE)).toBe(HEALTHY_SERVICE);
  });
});

describe("useAiServiceHealthStore wiring", () => {
  beforeEach(() => useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE }));

  it("sustained 502s flip the store to degraded/unreachable; a success clears it", () => {
    const { noteFailure, noteSuccess } = useAiServiceHealthStore.getState();
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD; i += 1) {
      noteFailure("ai request failed (HTTP 502)");
    }
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);
    expect(useAiServiceHealthStore.getState().reason).toBe("unreachable");
    noteSuccess();
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
    expect(useAiServiceHealthStore.getState().reason).toBeNull();
  });

  it("a single blip interleaved with a success never degrades", () => {
    const { noteFailure, noteSuccess } = useAiServiceHealthStore.getState();
    noteFailure("ai request failed (HTTP 502)");
    noteSuccess();
    noteFailure("ai request failed (HTTP 502)");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("a sustained OFFLINE run (ai_unreachable) never degrades — OfflineBanner owns that", () => {
    const { noteFailure } = useAiServiceHealthStore.getState();
    for (let i = 0; i < AI_SERVICE_DEGRADED_THRESHOLD + 2; i += 1) noteFailure("ai_unreachable");
    expect(useAiServiceHealthStore.getState().degraded).toBe(false);
  });

  it("dismiss() hides the banner idempotently for the episode", () => {
    useAiServiceHealthStore.setState({
      consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
      degraded: true,
      reason: "unreachable",
      dismissed: false,
    });
    useAiServiceHealthStore.getState().dismiss();
    expect(useAiServiceHealthStore.getState().dismissed).toBe(true);
    const ref = useAiServiceHealthStore.getState();
    ref.dismiss();
    expect(useAiServiceHealthStore.getState()).toBe(ref); // idempotent, same reference
  });
});
