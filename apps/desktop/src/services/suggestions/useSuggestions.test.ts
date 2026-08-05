import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRecompute,
  hashScrollback,
  withinRetryBudget,
  failuresFor,
  NO_FAILURES,
  retryBackoffMs,
  isTerminalComputeError,
  computeDeferralReason,
  RETRY_BACKOFF_MS,
  isYourTurnFor,
} from "./useSuggestions";
import {
  noteHooksLive,
  resetTurnEndAuthority,
  trackAgent,
} from "../../engine/turnEndAuthority";
import { SuggestionOfflineError } from "./engine";
import { AiUnavailableError, AiUnreachableError, ClaudeAuthError } from "../anthropic";
import { OutOfCreditsError } from "../credits";

describe("computeDeferralReason (a shut gate is not a failure of this state)", () => {
  it("defers both offline shapes — the pre-compute gate and a mid-flight drop", () => {
    expect(computeDeferralReason(new SuggestionOfflineError())).toBe("offline");
    expect(computeDeferralReason(new AiUnreachableError())).toBe("offline");
  });

  it("defers an out-of-credits refusal — no backoff can clear a zero balance", () => {
    expect(computeDeferralReason(new OutOfCreditsError(0))).toBe("credits");
    // A 402 that reports a leftover balance too small for the server's hold is the same story.
    expect(computeDeferralReason(new OutOfCreditsError(7))).toBe("credits");
  });

  it("does NOT defer an unavailable backend — nothing closes a gate behind it, so it stays on the bounded-retry path", () => {
    expect(computeDeferralReason(new AiUnavailableError())).toBe(null);
  });

  it("does NOT defer ordinary rejections — those keep their retry budget", () => {
    expect(computeDeferralReason(new Error("Claude request failed: ai request failed (HTTP 502)"))).toBe(
      null,
    );
    expect(computeDeferralReason(new Error("bad JSON: unexpected token"))).toBe(null);
    expect(computeDeferralReason("some string rejection")).toBe(null);
    expect(computeDeferralReason(undefined)).toBe(null);
  });
});

describe("isTerminalComputeError (skips retries that can't succeed)", () => {
  // The message shape the proxy/anthropic layer actually throws.
  const proxy = (code: number) => `Claude request failed: ai request failed (HTTP ${code})`;

  it("treats a 4xx as permanent — an identical retry only wastes a paid call", () => {
    expect(isTerminalComputeError(proxy(404))).toBe(true);
    expect(isTerminalComputeError(proxy(400))).toBe(true);
    expect(isTerminalComputeError(proxy(401))).toBe(true);
  });

  it("keeps retrying the codes that mean 'try again later'", () => {
    expect(isTerminalComputeError(proxy(408))).toBe(false);
    expect(isTerminalComputeError(proxy(429))).toBe(false);
  });

  it("keeps retrying 5xx — that's the transient gateway blip the backoff exists for", () => {
    expect(isTerminalComputeError(proxy(500))).toBe(false);
    expect(isTerminalComputeError(proxy(502))).toBe(false);
    expect(isTerminalComputeError(proxy(503))).toBe(false);
  });

  it("retries anything with no HTTP status (transport errors, unknown rejections)", () => {
    expect(isTerminalComputeError("Claude request failed: ai request failed")).toBe(false);
    expect(isTerminalComputeError("bad JSON: unexpected token")).toBe(false);
    expect(isTerminalComputeError("")).toBe(false);
  });
});

describe("a broken credential is terminal — via the TYPE, not the message", () => {
  // Guards the invariant the terminal decision actually rests on, and the one whose quiet removal
  // would resurrect a measured incident: a single expired session driving hundreds of doomed
  // suggestion calls, each spending a full 3-attempt budget on a rejection ~5s of backoff could
  // never clear.
  //
  // The chain: Rust `classify_cli_failure` maps "failed to authenticate" / "session expired" to
  // `claude_not_authenticated` -> `parseUnavailableReason` -> `cli_not_authenticated` ->
  // `chatOnce` throws `ClaudeAuthError`. `terminal` reads `err instanceof AiUnavailableError`, so
  // the SUBCLASS RELATION is load-bearing: flatten it and auth silently becomes retryable again,
  // with no test failing anywhere near the change.

  it("ClaudeAuthError is an AiUnavailableError, which is what makes it terminal", () => {
    expect(new ClaudeAuthError() instanceof AiUnavailableError).toBe(true);
  });

  // Deliberately NOT asserting `isTerminalComputeError(new ClaudeAuthError().message) === false`.
  // That reads like it proves the message classifier cannot see a credential failure, and it does
  // not: `.message` is Sparkle's own remedy copy ("Sign in to Claude Code…"), never a CLI rejection
  // body, and the assertion would pass for any sentence without an `(HTTP nnn)` suffix — i.e.
  // against every possible implementation of the classifier. The two cases here carry the invariant.

  it("is not deferred — there is no dep that flips when a credential is fixed", () => {
    // Deferral is for conditions with an effect dep that recovers (`isOnline`, `learnedOn`).
    // Auth has none, so deferring would leave the gate open and let every re-render buy another
    // doomed call. Terminal spends the budget once and stops.
    expect(computeDeferralReason(new ClaudeAuthError())).toBeFalsy();
  });
});

describe("withinRetryBudget (bounds persistent-rejection retries)", () => {
  it("allows retries below the cap (3) and stops at it", () => {
    expect(withinRetryBudget(0)).toBe(true);
    expect(withinRetryBudget(1)).toBe(true);
    expect(withinRetryBudget(2)).toBe(true);
    expect(withinRetryBudget(3)).toBe(false);
    expect(withinRetryBudget(4)).toBe(false);
  });
});

describe("failuresFor (keeps the budget attached to the state that spent it)", () => {
  it("reports the count only for the hash it was spent on", () => {
    const spent = { hash: "h1", count: 2 };
    expect(failuresFor(spent, "h1")).toBe(2);
  });

  it("gives every OTHER state a full budget without disturbing the failing one", () => {
    const spent = { hash: "h1", count: 3 };
    // The pass-through state starts fresh...
    expect(failuresFor(spent, "h2")).toBe(0);
    // ...and asking about it must not have refunded h1, which is the whole point: an exhausted
    // state stays exhausted no matter how many other states are computed in between.
    expect(failuresFor(spent, "h1")).toBe(3);
  });

  it("starts with a full budget before anything has failed", () => {
    expect(failuresFor(NO_FAILURES, "h1")).toBe(0);
  });
});

describe("retryBackoffMs (spaces out failed-compute retries)", () => {
  it("grows exponentially from the base delay", () => {
    // `failures` = attempts already failed (1 after the first failure).
    expect(retryBackoffMs(1)).toBe(RETRY_BACKOFF_MS);
    expect(retryBackoffMs(2)).toBe(RETRY_BACKOFF_MS * 2);
    expect(retryBackoffMs(3)).toBe(RETRY_BACKOFF_MS * 4);
  });
  it("never returns less than the base (guards failures <= 0)", () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_MS);
    expect(retryBackoffMs(-5)).toBe(RETRY_BACKOFF_MS);
  });
  it("is capped so it never stalls the UI", () => {
    expect(retryBackoffMs(100)).toBeLessThanOrEqual(4000);
  });
});

describe("suggestion recompute gating", () => {
  it("recomputes on a new scrollback hash", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: true })).toBe(true);
  });
  it("skips when hash unchanged", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "x", composerEmpty: true })).toBe(false);
  });
  it("skips when composer is non-empty", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: false })).toBe(false);
  });
  it("recomputes on first run (null lastHash)", () => {
    expect(shouldRecompute({ lastHash: null, nextHash: "y", composerEmpty: true })).toBe(true);
  });
});

describe("hashScrollback", () => {
  it("is stable for the same input", () => {
    expect(hashScrollback("abc")).toBe(hashScrollback("abc"));
  });
  it("differs on change", () => {
    expect(hashScrollback("abc")).not.toBe(hashScrollback("abd"));
  });
});

describe("isYourTurnFor — a witness-less idle STILL opens the CTA gate", () => {
  // Regression guard for roborev's finding on the commit that briefly gated this on
  // turnEndAuthority. On the fallback path `idle` is the TERMINAL resting state, so that gate never
  // reopened: a finished agent with no hooks and no spinner lost Open Pull Request / Merge PR /
  // Close Build Agent on desktop AND phone, permanently and silently. These tests fail if the gate
  // is ever re-added — see isYourTurnFor's doc comment for why the busy gate may do what this must not.
  beforeEach(() => resetTurnEndAuthority());

  it("offers the CTA to a tracked agent that never got a turn-end witness", () => {
    trackAgent("a1");
    expect(isYourTurnFor("a1", "idle")).toBe(true);
  });

  it("still offers it with a witness present", () => {
    trackAgent("a1");
    noteHooksLive("a1");
    expect(isYourTurnFor("a1", "idle")).toBe(true);
  });

  it("holds the rest of the your-turn set, and nothing outside it", () => {
    for (const s of ["waiting", "approval", "errored", "done"] as const) {
      expect(isYourTurnFor("a1", s)).toBe(true);
    }
    expect(isYourTurnFor("a1", "working")).toBe(false);
    expect(isYourTurnFor("a1", undefined)).toBe(false);
  });
});
