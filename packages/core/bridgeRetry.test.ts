import { describe, it, expect } from "vitest";
import {
  CONNECT_RETRY_DELAYS_MS,
  RETRYABLE_CONNECT_CODES,
  isRetryableConnectError,
} from "./bridgeRetry";

// This module is the SINGLE definition of the connect-phase retry policy that apps/mcp-control and
// apps/mcp-orchestrator both import. The two clients drifted once when this logic was copy-pasted
// (sparkle-i95d landed on one twin, not the other); these tests pin the shared policy's behavior so
// a change to it is a change to BOTH clients at once — which is the whole point of extracting it.

describe("bridgeRetry — shared connect-phase retry policy", () => {
  it("retries exactly the transient rebind-window codes and nothing else", () => {
    // The behavioral guard: these two codes are the entire safe-to-retry set. ECONNREFUSED is the
    // orphaned-socket-file case, ENOENT the removed-and-not-yet-rebound case.
    expect(isRetryableConnectError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRetryableConnectError({ code: "ENOENT" })).toBe(true);

    // Anything past a successful connect must NOT retry — retrying could double-execute a
    // non-idempotent op like spawn_worker. A permission error, a reset mid-request, a wrong socket
    // type, and a timeout are all terminal on the first try.
    expect(isRetryableConnectError({ code: "EACCES" })).toBe(false);
    expect(isRetryableConnectError({ code: "ECONNRESET" })).toBe(false);
    expect(isRetryableConnectError({ code: "ENOTSOCK" })).toBe(false);
    expect(isRetryableConnectError({ code: "ETIMEDOUT" })).toBe(false);
  });

  it("classifies non-error / codeless values as non-retryable rather than throwing", () => {
    expect(isRetryableConnectError(undefined)).toBe(false);
    expect(isRetryableConnectError(null)).toBe(false);
    expect(isRetryableConnectError("ENOENT")).toBe(false);
    expect(isRetryableConnectError(new Error("no code"))).toBe(false);
    expect(isRetryableConnectError({ code: undefined })).toBe(false);
  });

  it("the retry-code SET and the classifier agree — every listed code is retryable", () => {
    // Keeps the exported set and the function that reads it from silently disagreeing.
    for (const code of RETRYABLE_CONNECT_CODES) {
      expect(isRetryableConnectError({ code })).toBe(true);
    }
    expect(RETRYABLE_CONNECT_CODES.has("ECONNREFUSED")).toBe(true);
    expect(RETRYABLE_CONNECT_CODES.has("ENOENT")).toBe(true);
    expect(RETRYABLE_CONNECT_CODES.size).toBe(2);
  });

  it("pins the shared backoff schedule (~2.25 s across four ascending attempts)", () => {
    // Both clients default to this exact schedule; pinning it here means a drift shows up as a failed
    // test in @sparkle/core rather than as one twin silently retrying differently from the other.
    expect(CONNECT_RETRY_DELAYS_MS).toEqual([150, 300, 600, 1200]);
    // Strictly ascending — each attempt waits longer than the last.
    for (let i = 1; i < CONNECT_RETRY_DELAYS_MS.length; i++) {
      expect(CONNECT_RETRY_DELAYS_MS[i]!).toBeGreaterThan(CONNECT_RETRY_DELAYS_MS[i - 1]!);
    }
    const total = CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(2250);
  });
});
