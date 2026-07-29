import { describe, it, expect, beforeEach } from "vitest";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  classifyServiceFailure,
  reduceFailure,
  reduceSuccess,
  useAiServiceHealthStore,
  type AiServiceHealth,
  type AiServiceReason,
} from "./aiServiceHealthStore";

/** Fold n identical service failures into a fresh state. */
function failTimes(n: number, reason: AiServiceReason): AiServiceHealth {
  let s = HEALTHY_SERVICE;
  for (let i = 0; i < n; i += 1) s = reduceFailure(s, reason);
  return s;
}

describe("classifyServiceFailure", () => {
  it("maps every 5xx the proxy surfaces to 'unreachable'", () => {
    for (const code of [500, 502, 503, 504, 529, 599]) {
      expect(classifyServiceFailure(`ai request failed (HTTP ${code})`)).toBe("unreachable");
    }
  });

  it("maps a transport failure (no HTTP status at all) to 'unreachable'", () => {
    expect(classifyServiceFailure("ai_unreachable")).toBe("unreachable");
  });

  it("maps 429 to 'rate_limited' and does NOT treat it as unreachable", () => {
    expect(classifyServiceFailure("ai request failed (HTTP 429)")).toBe("rate_limited");
  });

  it("does not count per-request 4xx (other than 429) — the service is up, the call is wrong", () => {
    for (const code of [400, 401, 403, 404, 408]) {
      expect(classifyServiceFailure(`ai request failed (HTTP ${code})`)).toBeNull();
    }
  });

  it("does not count classes another banner already owns", () => {
    // $0 user balance → ZeroCreditBanner; provider-account sentinel → ProviderUnavailableBanner.
    expect(classifyServiceFailure("insufficient_credits:0")).toBeNull();
    expect(classifyServiceFailure("insufficient_credits:1234")).toBeNull();
    expect(classifyServiceFailure("ai_unconfigured")).toBeNull();
    expect(classifyServiceFailure("ai_unconfigured:provider_unfunded")).toBeNull();
    expect(classifyServiceFailure("ai_unconfigured:provider_key_rejected")).toBeNull();
  });

  it("does not read a bare number in prose as a status", () => {
    expect(classifyServiceFailure("upstream returned 502 for the request")).toBeNull();
    expect(classifyServiceFailure("")).toBeNull();
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
    const at = reduceFailure(below, "unreachable");
    expect(at.degraded).toBe(true);
    expect(at.reason).toBe("unreachable");
  });

  it("carries the latest reason so the banner names the current cause", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.reason).toBe("unreachable");
    s = reduceFailure(s, "rate_limited");
    expect(s.reason).toBe("rate_limited");
    expect(s.degraded).toBe(true);
  });

  it("a non-service outcome resets the consecutive run — a 4xx can't accumulate to degraded", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD - 1, "unreachable");
    s = reduceFailure(s, null); // e.g. a 400
    expect(s.consecutiveFailures).toBe(0);
    s = reduceFailure(s, "unreachable");
    expect(s.degraded).toBe(false); // run restarted, threshold not reached
  });

  it("a non-service outcome does NOT clear an already-degraded banner — only success proves recovery", () => {
    let s = failTimes(AI_SERVICE_DEGRADED_THRESHOLD, "unreachable");
    expect(s.degraded).toBe(true);
    s = reduceFailure(s, null);
    expect(s.degraded).toBe(true);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("returns the SAME reference when a repeated non-service outcome changes nothing", () => {
    const s = reduceFailure(HEALTHY_SERVICE, null); // already zero run
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
