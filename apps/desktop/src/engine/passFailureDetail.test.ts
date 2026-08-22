import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { hardStopFailureKind } from "./passFailureDetail";

// ⚠️ THE STRINGS BELOW ARE THE POINT. A test written against the pretty scrollback wording
// ("You've hit your session limit · resets 9:30am") passes today and proves NOTHING about the
// headless path, because that path never sees scrollback. These are the shapes
// `sparkle_improve.rs::failure_message` actually produces.

/** VERBATIM from the crate's own test `failure_message_surfaces_claude_detail_when_stderr_empty`,
 *  which asserts this is the message for the recurring exit-1-with-empty-stderr hourly failure.
 *  If the Rust side ever changes this wording, THIS is the test that must go red. */
const RUST_PINNED_USAGE_LIMIT = "Claude usage limit reached";

describe("hardStopFailureKind — the headless failure seam", () => {
  it("catches the exact usage-limit string the Rust side pins", () => {
    expect(hardStopFailureKind(RUST_PINNED_USAGE_LIMIT)).toBe("quota");
  });

  it("catches the reset-stamped variant the CLI also emits", () => {
    expect(hardStopFailureKind("Claude AI usage limit reached|1787412000")).toBe("quota");
  });

  // ══ THE REPO'S OWN VERIFIED WORDINGS, and every one of them LEADS WITH "Claude" ═══════════════
  // These are not invented. They are the live fixtures this codebase already carries, and they are
  // the reason an opener anchored on `^usage limit reached` cannot be the whole answer:
  //   • rateLimitWatch.test.ts — "Claude usage limit reached — will reset at 3pm (America/Bogota)"
  //   • claude_oneshot.rs tests — "Claude usage limit reached - resuming at 5pm",
  //                               "Claude usage limit reached|resets 5pm"
  // The Rust side already gets this right: `claude_oneshot.rs::is_account_limit` matches
  // "usage limit reached" ANYWHERE, unanchored, and its header says each phrase is "a fragment of a
  // real message, verified against captures". This pins that the TS headless seam agrees with it.
  it.each([
    "Claude usage limit reached. Your limit resets at 5:00pm.",
    "Claude usage limit reached - resuming at 5pm",
    "Claude usage limit reached — will reset at 3pm (America/Bogota)",
    "Claude usage limit reached|resets 5pm",
    "[agent-7] Claude usage limit reached - resuming at 5pm.",
  ])("catches the verified real wording %#, which leads with 'Claude'", (msg) => {
    expect(hardStopFailureKind(msg)).toBe("quota");
  });

  // The weekly cap is the same wall with a different noun (bead sparkle-hbyae) — detection must be
  // agnostic to session-vs-weekly, or a weekly-walled account returns to rotation while still walled.
  it("treats a WEEKLY limit exactly like a session one", () => {
    expect(hardStopFailureKind("You've hit your weekly limit · resets 4pm")).toBe("quota");
  });

  it("catches the scrollback wording too, so the two paths agree", () => {
    expect(hardStopFailureKind("You've hit your session limit · resets 9:30am")).toBe("quota");
    expect(
      hardStopFailureKind("You've hit your monthly spend limit · raise it at claude.ai/settings/usage"),
    ).toBe("quota");
  });

  // The miss that cost the founder an onboarding: the CLI says "session", the old pattern said
  // "token", so the most unambiguous auth failure fell through and told him to retry.
  it("catches an OAuth lapse, which no retry can clear", () => {
    expect(
      hardStopFailureKind("Failed to authenticate: OAuth session expired and could not be refreshed"),
    ).toBe("auth");
    expect(hardStopFailureKind("Not logged in · Please run /login")).toBe("auth");
  });

  // Ordering is load-bearing and inherited from conciergeFailureNotice: a rate limit is a quota
  // fact, not a credential one, even when the message mentions authorization.
  // The ordering is inherited from conciergeFailureNotice and still matters: a wall that also
  // mentions authorization is a QUOTA fact, not a credential one, so it must not be read as `auth`
  // and sent to the wrong remedy ("sign in again" does not clear a spend cap).
  //
  // ⚠️ THE FIXTURE WAS A BARE RATE LIMIT AND THAT WAS WRONG. It read
  // "429 rate_limit_error: unauthorized for this quota", which since the durable-wall gate is
  // correctly NOT a hard stop at all — so the test was pinning the ordering through an input that no
  // longer reaches either arm. A durable wall carrying the same authorization noise asks the real
  // question.
  it("reads a DURABLE wall that mentions authorization as QUOTA, not auth", () => {
    expect(
      hardStopFailureKind("Claude usage limit reached — unauthorized for this quota"),
    ).toBe("quota");
  });

  it("returns null for failures the hourly slot re-attempts by itself", () => {
    expect(hardStopFailureKind("claude exited without a successful result (exit code 1)")).toBeNull();
    expect(hardStopFailureKind("ECONNRESET")).toBeNull();
    expect(hardStopFailureKind("stalled mid-stream")).toBeNull();
    expect(hardStopFailureKind("")).toBeNull();
  });

  // A SHORT-WINDOW RATE LIMIT IS NOT A HARD STOP. The next hourly pass clears it with no founder
  // action, so it must not reach the red tier (roborev 67788).
  it.each([
    "API Error: 429 rate_limit_error",
    "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
  ])("returns null for the short-window rate limit %#, so the caller parks it on amber", (msg) => {
    expect(hardStopFailureKind(msg)).toBeNull();
  });

  // ⚠️ THE PREVIOUS GUARD HERE WAS VACUOUS AND WAS REPLACED (roborev 67788). It read
  // `expect(gray.has(AGENT_STATUS.blocked.color)).toBe(false)` inside a loop over messages — an
  // assertion about the tokens.ts table that is loop-INVARIANT, independent of the message, and
  // independent of this module entirely. It would have stayed green if the classifier returned null
  // for every input. The honest form asserts something that VARIES WITH THE INPUT.
  it("separates hard stops from auto-retried failures by input, not by constant", () => {
    const hardStops = [
      "Claude usage limit reached",
      "You've hit your weekly limit · resets 4pm",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    ];
    const retried = [
      "API Error: 429 rate_limit_error",
      "claude exited without a successful result (exit code 1)",
      "stalled mid-stream",
    ];
    expect(hardStops.map(hardStopFailureKind)).toEqual(["quota", "quota", "auth"]);
    expect(retried.map(hardStopFailureKind)).toEqual([null, null, null]);
  });

  // Kept, but named for what it actually is: a claim about the TOKEN TABLE, not about this module.
  // It is here so a future edit that made `blocked` calm would be caught somewhere.
  it("tokens.ts still gives `blocked` a colour distinct from the calm and amber tiers", () => {
    // ⚠️ RESTORED (roborev 67814). The rewrite dropped this equality, and nothing else in
    // apps/desktop/src tied the two — so a token edit giving `blocked` a different red from
    // `errored` would have gone uncaught. It is the founder's non-overridable rule: "the colours
    // work the same between [the Improve Sparkle row] and [the build agents]".
    expect(AGENT_STATUS.blocked.color).toBe(AGENT_STATUS.errored.color);
    expect(AGENT_STATUS.blocked.color).not.toBe(AGENT_STATUS.lapsed.color);
    expect(AGENT_STATUS.blocked.color).not.toBe(AGENT_STATUS.idle.color);
    expect(AGENT_STATUS.blocked.color).not.toBe(AGENT_STATUS.stopped.color);
  });
});
