// Which colour a failed hourly improvement pass earns. The whole point of this module is that an
// auto-retried failure must NOT wear the alarm colour, and that an account wall still must — so
// every test here asserts the RESOLVED STATUS (and, for the two guards, the resolved HEX from the
// one shared table), never that some helper was consulted.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import {
  classifyPassFailure,
  isTransientPassFailure,
  passFailureStatus,
  type PassFailureClass,
} from "./passFailureStatus";

/** The instant a failure is observed. Any fixed number: nothing here depends on the wall clock,
 *  and passing one is what keeps the classifier pure. */
const AT = Date.UTC(2026, 7, 22, 12, 0, 0);

/** Classify and resolve in one step — the pair as production calls it, so a test can never pass
 *  because the classifier is right and the mapping is wrong. */
function statusFor(message: string) {
  return passFailureStatus(classifyPassFailure(message, AT));
}

/** Every arm of the union, written out rather than derived, so adding a class makes this a type
 *  error at the callers below instead of silently shrinking the guard tests' coverage. */
// ⚠️ EXHAUSTIVENESS IS ENFORCED, NOT ASSERTED IN A COMMENT (roborev 67806). This list previously
// omitted "auth" while its comment claimed a missing member would be a type error — it is not: a
// `readonly PassFailureClass[]` annotation accepts a SHORT array happily. So the guard below, marked
// REQUIRED BY NAME, never evaluated the one arm it was added to protect. Deriving the list from a
// total Record makes a new class a real compile error.
const CLASS_KEYS: Record<PassFailureClass, true> = {
  quota: true,
  auth: true,
  transient: true,
  other: true,
};
const ALL_CLASSES = Object.keys(CLASS_KEYS) as PassFailureClass[];

describe("classifyPassFailure", () => {
  it("calls an account SESSION limit a quota wall", () => {
    // Verbatim, as Claude Code prints it. The `·`-plus-`resets` TAIL is the load-bearing part —
    // `apiRecovery.ACCOUNT_LIMIT_TAIL` requires it precisely so a PARAPHRASE never matches.
    const msg = "You've hit your session limit · resets 8:40am (America/Bogota)";
    expect(classifyPassFailure(msg, AT)).toBe("quota");
    expect(statusFor(msg)).toBe("blocked");
  });

  it("calls a monthly SPEND cap a quota wall", () => {
    const msg = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
    expect(classifyPassFailure(msg, AT)).toBe("quota");
    expect(statusFor(msg)).toBe("blocked");
  });

  it("QUOTA OUTRANKS TRANSIENT even when the message carries both", () => {
    // The ordering is load-bearing, and this is the case that proves it: a message that also
    // contains a transient shape must not be demoted to amber and quietly re-attempted against a
    // wall no retry can clear. Asking transient first would return "transient" here.
    const msg =
      "read ECONNRESET\nYou've hit your session limit · resets 8:40am (America/Bogota)";
    expect(isTransientPassFailure(msg)).toBe(true); // the transient arm WOULD have matched
    expect(classifyPassFailure(msg, AT)).toBe("quota");
    expect(statusFor(msg)).toBe("blocked");
  });

  // The connectivity + truncated-stream shapes. These are the ones the app itself re-attempts
  // within minutes (`armRetryIfTransient`), which is the entire reason they stopped being red.
  it.each([
    ["API Error: Connection closed mid-response. The response above may be incomplete.", "closed mid-response"],
    ["API Error: Response stalled mid-stream. The response above may be incomplete.", "stalled mid-stream"],
    ["read ECONNRESET", "ECONNRESET"],
    ["API Error: Unable to connect to API (ENOTFOUND)", "unable to connect"],
    ["getaddrinfo EAI_AGAIN api.example", "getaddrinfo"],
    ["socket hang up", "socket hang up"],
    [
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
      "529 Overloaded",
    ],
    ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded_error"],
  ])("%s is transient, and transient is AMBER", (message) => {
    expect(classifyPassFailure(message, AT)).toBe("transient");
    expect(statusFor(message)).toBe("lapsed");
  });

  it("a QUOTA WALL that also says overloaded is still blocked, not re-attempted", () => {
    // Same ordering guard as ECONNRESET above, for the shape this change adds: a 429 rate limit can
    // legitimately mention overload, and re-attempting a wall within minutes clears nothing.
    const msg =
      "API Error: 429 Overloaded\nYou've hit your session limit · resets 8:40am (America/Bogota)";
    expect(isTransientPassFailure(msg)).toBe(true); // the transient arm WOULD have matched
    expect(classifyPassFailure(msg, AT)).toBe("quota");
    expect(statusFor(msg)).toBe("blocked");
  });

  // PROSE ABOUT AN OVERLOAD IS NOT AN OVERLOAD. `sparkle_improve.rs::failure_message` falls back
  // to the child's PLAIN STDOUT when stderr is empty and the stream carried no structured detail —
  // and the crate's own comment records that the hourly pass's child "frequently dies with EMPTY
  // stderr". So the string this classifier is handed is, on that path, the AGENT'S OWN NARRATION.
  // A bare `overloaded` substring therefore matches a pass that merely discussed the topic — and
  // `engine/streamFailure` already reached this conclusion for the same keyword and deliberately
  // dropped it ("they false-trip on prose and on logs the agent is reading").
  //
  // The cost is not cosmetic: a false transient burns `retryUsed` for the hour, so a genuinely
  // transient failure arriving later in that same hour gets NO re-attempt — the exact harm the
  // quota-ordering guard above exists to prevent, reached by a different route.
  it.each([
    ["I'll add handling for when the upstream model is overloaded, then retry.", "narration"],
    ["  ⎿  tail: server.log: 529 Overloaded", "a log line the agent is reading"],
    ["docs: explain that the API returns overloaded_error under load", "a commit subject"],
  ])("prose mentioning overload (%s) is NOT transient", (message) => {
    expect(isTransientPassFailure(message)).toBe(false);
    expect(classifyPassFailure(message, AT)).toBe("other");
  });

  it("a TIMEOUT is 'other', and 'other' is AMBER too", () => {
    // The 30-minute watchdog. Nothing is armed for it, but the next hourly slot re-attempts by
    // itself within the hour — so the founder is not the actor who clears it either.
    const msg = "pass timed out after 30 minutes and was killed";
    expect(classifyPassFailure(msg, AT)).toBe("other");
    expect(statusFor(msg)).toBe("lapsed");
  });

  it.each([
    "exited with code 1",
    "git exploded",
    "event bus unavailable",
    "",
  ])("an unrecognised failure (%j) is 'other' → AMBER", (message) => {
    expect(classifyPassFailure(message, AT)).toBe("other");
    expect(statusFor(message)).toBe("lapsed");
  });

  // ⚠️ THIS TEST ASSERTED THE BUG AND WAS CORRECTED. It read:
  //
  //     expect(statusFor("Claude usage limit reached")).toBe("lapsed");
  //
  // calling that string a "paraphrase". It is not a paraphrase — it is the REAL message, pinned by
  // the crate's own `failure_message_surfaces_claude_detail_when_stderr_empty`, which asserts it is
  // exactly what the recurring exit-1-with-empty-stderr hourly failure produces. Asserting amber for
  // it pins the very defect the founder screenshotted: a session-limited agent wearing a calm colour.
  //
  // THE DISCIPLINE WAS INHERITED ACROSS AN INPUT-SHAPE BOUNDARY, which is the deeper mistake.
  // `apiRecovery`'s "an agent WRITING about session limits stays green" rule exists because its input
  // is a TERMINAL LINE — text an agent may have typed, quoted or tailed from a log. This classifier's
  // input is `outcome.text`: a MACHINE-GENERATED failure reason (the child's stderr, or claude's
  // structured `result` detail). An agent's prose never reaches it. Carrying the rule across cost the
  // feature the only case it was built for.
  it("a real limit named in the failure detail is a wall, not prose", () => {
    expect(classifyPassFailure("Claude usage limit reached", AT)).toBe("quota");
    expect(statusFor("Claude usage limit reached")).toBe("blocked");
    expect(classifyPassFailure("You've hit your monthly spend limit", AT)).toBe("quota");
  });

  // The negative that still matters HERE: a failure that names no wall at all stays amber, because
  // the hourly slot re-attempts it without the founder doing anything.
  it("a failure naming no wall still waits out the hour in amber", () => {
    expect(classifyPassFailure("the worktree probe timed out", AT)).toBe("other");
    expect(statusFor("could not read the pass log")).toBe("lapsed");
  });
});

describe("passFailureStatus colour guards", () => {
  // REQUIRED BY NAME. This bug has recurred across several states — a state that means "stopped,
  // unfinished" rendered in the calm hue that means "nothing is stopping you" — and a test is the
  // only thing that has ever stopped it happening again.
  it("no PassFailureClass maps to a GRAY status", () => {
    // The gray reference is READ from the shared table (`idle` is the canonical gray), never
    // hardcoded: a repalette that changed the gray hex must not silently disarm this guard.
    const GRAY = AGENT_STATUS.idle.color;
    expect(AGENT_STATUS.stopped.color).toBe(GRAY); // the gray tier really is one colour
    for (const cls of ALL_CLASSES) {
      const status = passFailureStatus(cls);
      expect(AGENT_STATUS[status].color).not.toBe(GRAY);
    }
  });

  // REQUIRED BY NAME. The founder marked this NON-OVERRIDABLE: "the colours work the same between
  // [the Improve Sparkle row] and [the build agents], and don't let any instruction ever override
  // that." The self row's quota colour must be the VERY VALUE a build row's quota wall gets, read
  // from the one shared table with no override in between.
  it("a quota wall on the self row is the same colour as a quota wall on a build row", () => {
    expect(AGENT_STATUS[passFailureStatus("quota")].color).toBe(AGENT_STATUS.blocked.color);
  });

  it("the amber arms are amber, and are NOT the red the quota arm gets", () => {
    // Stated as a relation rather than a hex so it survives a repalette, and asserted in BOTH
    // directions: "is lapsed" alone would pass if `blocked` were also amber.
    for (const cls of ["transient", "other"] as const) {
      expect(passFailureStatus(cls)).toBe("lapsed");
      expect(AGENT_STATUS[passFailureStatus(cls)].color).toBe(AGENT_STATUS.lapsed.color);
      expect(AGENT_STATUS[passFailureStatus(cls)].color).not.toBe(AGENT_STATUS.blocked.color);
    }
  });
});

// ══ THE SEAM THAT WOULD HAVE SHIPPED THIS INERT ═════════════════════════════════════════════════
// `quotaBlockIn` alone reaches NONE of these. It is a SCROLLBACK detector and the headless pass
// never produces a PTY — `sparkle_improve.rs::failure_message` hands TS claude's structured detail
// instead. Every string below is one this repo has actually captured, and every one leads with
// "Claude", so the `^You've hit your …` opener cannot anchor and the `· resets` tail is absent.
//
// A test written against the pretty scrollback wording passes with the broken implementation. These
// do not — verified by mutation: dropping the `hardStopFailureKind` arm reds every case here.
describe("classifyPassFailure — the structured-detail seam", () => {
  it.each([
    // VERBATIM from the crate's own `failure_message_surfaces_claude_detail_when_stderr_empty`,
    // which asserts this is the message for the recurring exit-1-with-empty-stderr hourly failure.
    "Claude usage limit reached",
    "Claude AI usage limit reached|1787412000",
    "Claude usage limit reached. Your limit resets at 5:00pm.",
    "Claude usage limit reached - resuming at 5pm",
    "Claude usage limit reached — will reset at 3pm (America/Bogota)",
  ])("paints the real headless quota message %# RED, not amber", (msg) => {
    expect(classifyPassFailure(msg, 0)).toBe("quota");
    expect(passFailureStatus(classifyPassFailure(msg, 0))).toBe("blocked");
  });

  it("paints an OAuth lapse RED — no retry clears an expired credential", () => {
    const msg = "Failed to authenticate: OAuth session expired and could not be refreshed";
    expect(classifyPassFailure(msg, 0)).toBe("auth");
    expect(passFailureStatus(classifyPassFailure(msg, 0))).toBe("blocked");
  });

  it("still parks an auto-retried failure on AMBER", () => {
    expect(passFailureStatus(classifyPassFailure("stalled mid-stream", 0))).toBe("lapsed");
    expect(
      passFailureStatus(classifyPassFailure("claude exited without a successful result (exit code 1)", 0)),
    ).toBe("lapsed");
  });

  // THE GUARD, by name: a hard stop must never wear a calm colour. This defect has recurred across
  // several states and the pattern is always a status stamped once and never re-derived.
  it("never lets a quota or auth failure resolve to a GRAY or AMBER status", () => {
    for (const msg of [
      "Claude usage limit reached",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    ]) {
      const st = passFailureStatus(classifyPassFailure(msg, 0));
      expect(AGENT_STATUS[st].color).toBe(AGENT_STATUS.blocked.color);
      expect(AGENT_STATUS[st].color).not.toBe(AGENT_STATUS.lapsed.color);
      expect(AGENT_STATUS[st].color).not.toBe(AGENT_STATUS.idle.color);
    }
  });
});

// ══ THE CASES THE TRIAGE ADDED (roborev 67806 / 67814) ══════════════════════════════════════════
describe("classifyPassFailure — ordering and the retry gate", () => {
  it("a message carrying BOTH a dropped connection and a wall is a QUOTA wall", () => {
    // The combined payload. Before the caller was fixed it armed the early re-attempt AND painted
    // red — re-running minutes later against a wall no retry can clear, and burning `retryUsed`.
    const msg = "read ECONNRESET\nYou've hit your session limit · resets 8:40am";
    expect(classifyPassFailure(msg, AT)).toBe("quota");
    expect(statusFor(msg)).toBe("blocked");
  });

  it("a SHORT-WINDOW rate limit is not a wall — it stays amber", () => {
    for (const msg of [
      'API Error: 429 {"type":"rate_limit_error"}',
      "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
    ]) {
      expect(statusFor(msg)).toBe("lapsed");
    }
  });

  it("an auth failure whose text mentions a rate limit is still AUTH", () => {
    // `classify` returns on its FIRST hit and tests QUOTA before AUTH, so this used to fall to null.
    const msg = "rate_limit_error while refreshing: OAuth session expired and could not be refreshed";
    expect(classifyPassFailure(msg, AT)).toBe("auth");
    expect(statusFor(msg)).toBe("blocked");
  });

  it("catches wall wordings that carry a verb other than 'reached'", () => {
    expect(statusFor("You have reached your usage limit for Opus")).toBe("blocked");
    expect(statusFor("Usage limit exceeded")).toBe("blocked");
  });
});
