import { describe, it, expect } from "vitest";
import {
  REVIVE_LADDER_MS,
  SCROLLBACK_SCAN_LINES,
  classifyApiFailure,
  classifyFromScrollback,
  decideRevive,
  nextRungDueAt,
  revivePrompt,
  type ReviveInput,
} from "./apiRecovery";

const T0 = 1_700_000_000_000;

/** An input that WOULD ping: errored, retryable, reachable, first rung already due. */
function ready(over: Partial<ReviveInput> = {}): ReviveInput {
  return {
    status: "errored",
    failure: "retryable",
    now: T0 + REVIVE_LADDER_MS[0]!,
    erroredSince: T0,
    attempts: 0,
    lastPingAt: undefined,
    canAcceptInput: true,
    processAlive: true,
    ...over,
  };
}

describe("classifyApiFailure", () => {
  it("calls the real 5xx / overload banners RETRYABLE", () => {
    expect(classifyApiFailure("API Error: 529 Overloaded.")).toBe("retryable");
    expect(classifyApiFailure("API Error: 529 overloaded_error")).toBe("retryable");
    expect(classifyApiFailure("API Error: 500 Internal server error.")).toBe("retryable");
    expect(classifyApiFailure("API Error: 503 Service Unavailable")).toBe("retryable");
  });

  // THE NEGATION TRAP, and the reason the terminal pattern is anchored rather than a keyword search.
  // This real banner CONTAINS the substring "usage limit" while explicitly saying it is not one. It
  // is the most retryable string in the whole set — a transient server-side throttle — so a
  // classifier reaching for "limit" anywhere would invert the single most common case.
  it("calls the throttle banner RETRYABLE even though it contains the words 'usage limit'", () => {
    const line =
      "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(line).toContain("usage limit"); // the trap is really present in the input
    expect(classifyApiFailure(line)).toBe("retryable");
  });

  it("calls ACCOUNT exhaustion TERMINAL — retrying these cannot clear them", () => {
    // Both verbatim from this machine's own concierge transcript, 2026-07-29.
    expect(classifyApiFailure("You've hit your session limit · resets 8:40am (America/Bogota)")).toBe(
      "terminal",
    );
    expect(
      classifyApiFailure(
        "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      ),
    ).toBe("terminal");
    // Typographic apostrophe — the TUI may render ’ where the source has '.
    expect(classifyApiFailure("You’ve hit your session limit · resets 11:20am (America/Bogota)")).toBe(
      "terminal",
    );
  });

  // A wrong `terminal` is the expensive mistake (roborev 55422): it escalates at once asserting the
  // user is out of session window or spend — a claim about their BILLING that may be false — and
  // consumes ZERO rungs, so the row sits red for hours, reproducing the exact stall this feature
  // exists to end. So `terminal` has to EARN it via the message's distinctive "· resets …" /
  // "· raise it at …" tail, which paraphrase and partial quotation do not reproduce.
  it("does NOT call a PARAPHRASE or partial quote of the limit message terminal", () => {
    // The shape an agent's own prose takes when it talks about this — line-initial, no real tail.
    expect(classifyApiFailure("You've hit your session limit")).toBeNull();
    expect(classifyApiFailure("You've hit your monthly spend limit and everything stops")).toBeNull();
    expect(classifyApiFailure("You've hit your session limit, which means the agent stalls")).toBeNull();
    // Reasoning about the feature, which is what an agent working on THIS module writes.
    expect(
      classifyApiFailure("You've hit your spend limit is the terminal case we must not retry"),
    ).toBeNull();
  });

  it("still calls the REAL message terminal — the tail is what distinguishes it", () => {
    expect(classifyApiFailure("You've hit your session limit · resets 8:40am (America/Bogota)")).toBe(
      "terminal",
    );
    expect(
      classifyApiFailure("You've hit your monthly spend limit · raise it at claude.ai/settings/usage"),
    ).toBe("terminal");
  });

  // The tail must NOT be glued to the word "limit", and the separator must not be pinned to one glyph
  // (roborev 55447) — either rigidity silently disables the whole terminal check on a real variant.
  it("accepts a tail that is not adjacent, and separator variants", () => {
    expect(classifyApiFailure("You've hit your usage limit for Opus · resets 3pm")).toBe("terminal");
    expect(classifyApiFailure("You've hit your session limit • resets 8:40am")).toBe("terminal");
    expect(classifyApiFailure("You've hit your session limit | resets 8:40am")).toBe("terminal");
    expect(classifyApiFailure("You've hit your monthly spend limit - raise it at claude.ai")).toBe(
      "terminal",
    );
  });

  // The lean the module DOCUMENTS, now actually implemented (roborev 55447). The old five-pattern
  // whitelist defaulted everything unlisted to null, so these got ZERO rungs while the prose claimed
  // ambiguous vendor failures retry.
  it("treats ANY request-failure banner as retryable, not just the whitelisted five", () => {
    // The casualty that proved the whitelist wrong: this repo uses it as a real banner elsewhere, and
    // it is the commonest transient shape after 529 — 5\d{2} misses 429, "rate limited" misses
    // "rate_limit_error".
    expect(classifyApiFailure("API Error: 429 rate_limit_error")).toBe("retryable");
    expect(classifyApiFailure("API Error: Connection error.")).toBe("retryable");
    expect(classifyApiFailure("API Error: 400 invalid_request_error")).toBe("retryable");
    expect(classifyApiFailure("API Error: something Anthropic has not invented yet")).toBe("retryable");
  });

  it("returns null for prose ABOUT api errors, so narration never drives a retry", () => {
    expect(classifyApiFailure("I'll add handling for the API Error case")).toBeNull();
    expect(classifyApiFailure("The model can be overloaded, so we retry.")).toBeNull();
    expect(classifyApiFailure("API Error handling: returns 500.")).toBeNull();
    expect(classifyApiFailure("500 Internal Server Error")).toBeNull();
    // Mid-sentence mention of an account limit is prose, not an exhaustion line.
    expect(classifyApiFailure("when you've hit your session limit the agent stops")).toBeNull();
  });
});

describe("classifyFromScrollback", () => {
  it("finds the banner behind the TUI's ⏺ marker, as it actually appears on screen", () => {
    const sb = ["⏺ I'll run that command.", "", "⏺ API Error: 529 Overloaded."].join("\n");
    expect(classifyFromScrollback(sb)).toBe("retryable");
  });

  // The whole reason this does not reuse streamFailure.apiErrorFramesIn: the TERMINAL shape carries
  // no "API Error:" prefix, so an anchored-to-that-prefix scan finds every retryable banner and NO
  // terminal one — i.e. it would ping a spend cap through all eleven rungs.
  it("finds an account-exhaustion line, which carries NO 'API Error:' prefix", () => {
    const sb = ["⏺ Working on it.", "", "⏺ You've hit your monthly spend limit · raise it at claude.ai"].join(
      "\n",
    );
    expect(classifyFromScrollback(sb)).toBe("terminal");
  });

  it("judges the MOST RECENT failure when both shapes are present", () => {
    // Burned the session limit earlier, sitting on a 529 now → retry the 529.
    const recovered = [
      "You've hit your session limit · resets 8:40am (America/Bogota)",
      "⏺ Back to work.",
      "⏺ API Error: 529 Overloaded.",
    ].join("\n");
    expect(classifyFromScrollback(recovered)).toBe("retryable");
    // And the reverse order gives the reverse verdict, so this is really order-sensitive and not
    // just a retryable-wins rule.
    const capped = [
      "⏺ API Error: 529 Overloaded.",
      "⏺ Retried.",
      "You've hit your monthly spend limit · raise it at claude.ai",
    ].join("\n");
    expect(classifyFromScrollback(capped)).toBe("terminal");
  });

  it("ignores a stale banner scrolled far above the window", () => {
    const sb = [
      "⏺ API Error: 529 Overloaded.",
      ...Array.from({ length: SCROLLBACK_SCAN_LINES + 5 }, (_, i) => `⏺ line ${i} of ordinary work`),
    ].join("\n");
    expect(classifyFromScrollback(sb)).toBeNull();
  });

  // The divergence that made this module skip the ladder while the row was already red
  // (roborev 55440). A redraw can leave two markers, and `⏺+` collapses only ADJACENT glyphs — so the
  // local single-`replace` copy this function used to carry left one behind, returned null, and the
  // runner refused with "unclassified-failure" for ZERO rungs, while streamFailure's LOOPING stripper
  // had already painted the row errored. Now both call the same exported stripper.
  it("classifies through a DOUBLED marker, exactly as streamFailure's stripper does", () => {
    expect(classifyFromScrollback("⏺ ⏺ API Error: 529 Overloaded.")).toBe("retryable");
    expect(classifyFromScrollback("⏺⏺ API Error: 500 Internal server error.")).toBe("retryable");
  });

  // ANY marker count. The shared stripper used to be a loop bounded at 3 passes and failed OPEN past
  // it, which put the red-row-no-retry split one extra redraw away rather than closing it (55467).
  it("classifies through MORE markers than the old 3-pass bound allowed", () => {
    expect(classifyFromScrollback("⏺ ⏺ ⏺ ⏺ API Error: 529 Overloaded.")).toBe("retryable");
    expect(classifyFromScrollback("⏺ ⏺ ⏺ ⏺ ⏺ You've hit your session limit · resets 8:40am")).toBe("terminal");
  });

  // WHY EXCLUDING `⎿` FROM THE MARKER CLASS IS A CORRECTNESS REQUIREMENT OF *THIS* FUNCTION, not just
  // a false-red concern in streamFailure (roborev 55467 — the rationale was dropped from the comments
  // once, with no test holding the line; this is that test).
  //
  // The scan reads BACKWARDS and returns the FIRST line that classifies, so the LOWEST classifying
  // line wins. Tool output containing "API Error: 529" — a curl against a failing endpoint, a tailed
  // log, an agent debugging this very module — sits BELOW the genuine limit banner that actually ended
  // the turn. Strip `⎿` and that line wins the scan, inverting a real spend cap into "retryable" and
  // spending eleven prompts against a wall. `stripMarkers` leaves `⎿` alone, so `^api error:` cannot
  // anchor there and the scan walks past it. If someone re-adds `⎿` (it has flip-flopped twice), THIS
  // is what goes red.
  it("does not let a ⎿-marked API error BELOW a real limit banner invert the verdict", () => {
    const sb = [
      "⏺ You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      "⏺ Let me check what the endpoint returns.",
      "  ⎿  $ curl -sS https://example.test/v1",
      "  ⎿  API Error: 529 Overloaded.",
    ].join("\n");
    expect(classifyFromScrollback(sb)).toBe("terminal");
  });

  // ⚠️ THE SAME SHAPE WITH AN UNMARKED CONTINUATION ROW — the residual the comment above scopes
  // itself to, pinned so nobody reads that test as an invariant (roborev 55485). The TUI marks only
  // the FIRST row of a result with `⎿`; row 2 is plain indented text, the strip trims the indent, and
  // `^api error:` anchors — so the LOWER line wins the backwards scan and a real spend cap reads
  // `retryable`.
  //
  // THIS TEST ASSERTS THE BUG. Its harm is on the CHEAP side of this module's stated asymmetry
  // (eleven bounded prompts and a mis-worded escalation, not a false billing claim), which is why it
  // is recorded rather than rushed. Closing it — skipping rows inside an open tool-result block — must
  // flip this to "terminal", not delete it.
  it("STILL inverts a limit banner when the API error is an UNMARKED result row (known residual)", () => {
    const sb = [
      "⏺ You've hit your session limit · resets 8:40am (America/Bogota)",
      "⏺ Let me check what the endpoint returns.",
      "  ⎿  $ curl -sS https://example.test/v1",
      "     API Error: 529 Overloaded.",
    ].join("\n");
    expect(classifyFromScrollback(sb)).toBe("retryable");
  });

  // ── WRAPPED ROWS (roborev 55447) ────────────────────────────────────────────────────────────────
  // These are xterm buffer ROWS, hard-wrapped at the pane's column width, and Sparkle runs agents in
  // narrow grid panes. A ~62-char limit banner therefore arrives split in two, with the opener on one
  // row and the "· resets …" tail on the next — and before the unwrap NEITHER half classified.
  it("classifies a limit banner split across two buffer rows as terminal", () => {
    const wrapped = ["⏺ You've hit your session limit ·", "resets 8:40am (America/Bogota)"].join("\n");
    expect(classifyFromScrollback(wrapped)).toBe("terminal");
    const wrappedSpend = ["⏺ You've hit your monthly spend limit ·", "raise it at claude.ai/settings/usage"].join(
      "\n",
    );
    expect(classifyFromScrollback(wrappedSpend)).toBe("terminal");
  });

  // The consequence that made the wrap a REGRESSION rather than a cosmetic miss: with the split banner
  // unmatched, the backwards scan kept going, found an older 529, and classified a spend-capped account
  // RETRYABLE — eleven prompts against a wall, ending in the false "the outage is outlasting the
  // ladder". Verbatim the inversion this module's own note says must never happen.
  it("does not fall through a wrapped limit banner to an OLDER 529", () => {
    const sb = [
      "⏺ API Error: 529 Overloaded.",
      "⏺ Retrying.",
      "⏺ You've hit your monthly spend limit ·",
      "raise it at claude.ai/settings/usage",
    ].join("\n");
    expect(classifyFromScrollback(sb)).toBe("terminal");
  });

  it("only borrows a tail from the IMMEDIATELY following row", () => {
    // A wrap continues on the very next row. Reaching further would let an unrelated later line lend a
    // tail to an innocent opener — so an opener with a row of other output in between stays unmatched
    // as a limit, and (being no API banner either) classifies null.
    const sb = ["You've hit your session limit", "⏺ Doing unrelated work", "resets 8:40am"].join("\n");
    expect(classifyFromScrollback(sb)).toBeNull();
  });

  it("returns null for a healthy scrollback", () => {
    expect(classifyFromScrollback("⏺ All tests pass.\n  ⎿  120 passed")).toBeNull();
    expect(classifyFromScrollback("")).toBeNull();
  });
});

describe("decideRevive — gates", () => {
  it("pings when everything lines up", () => {
    expect(decideRevive(ready())).toEqual({
      action: "ping",
      attempt: 1,
      prompt: revivePrompt(1),
    });
  });

  it("acts ONLY on errored — never on a live question it would be answering blind", () => {
    // waiting/approval are a question the agent asked; typing a retry would answer something it
    // never read. blocked/idle/working are not this module's business either.
    for (const status of ["waiting", "approval", "blocked", "idle", "working", "done"] as const) {
      expect(decideRevive(ready({ status }))).toEqual({ action: "none", reason: "not-errored" });
    }
  });

  it("refuses to ping an UNCLASSIFIED failure rather than guessing it is transient", () => {
    expect(decideRevive(ready({ failure: null }))).toEqual({
      action: "none",
      reason: "unclassified-failure",
    });
  });

  it("escalates a TERMINAL failure immediately, without spending a rung or waiting one out", () => {
    // now === erroredSince: not even the 5s rung is due, and it still escalates at once, because no
    // amount of waiting clears a spend cap.
    const d = decideRevive(ready({ failure: "terminal", now: T0, attempts: 0 }));
    expect(d.action).toBe("escalate");
    expect(d).toMatchObject({ reason: expect.stringMatching(/ACCOUNT limit/) });
  });

  it("refuses when the agent cannot take input", () => {
    expect(decideRevive(ready({ canAcceptInput: false }))).toEqual({
      action: "none",
      reason: "cannot-accept-input",
    });
  });

  // `errored` is reachable from BOTH a live-process stream failure and StatusEngine.exit() on a dead
  // one, so it cannot witness its own liveness. Two DISTINCT refusals, because this reason is read
  // out to a human: saying "its process is gone" about an agent nobody looked up is a false positive
  // from silence, and would be said about every live agent whose liveness was simply not probed.
  it("gives two honest refusals for a dead vs an unprobed process", () => {
    expect(decideRevive(ready({ processAlive: false }))).toEqual({
      action: "none",
      reason: "process-gone",
    });
    expect(decideRevive(ready({ processAlive: undefined }))).toEqual({
      action: "none",
      reason: "liveness-unknown",
    });
  });
});

describe("decideRevive — the ladder's arithmetic", () => {
  it("waits out the first rung, then fires exactly at it", () => {
    const at = (dt: number) => decideRevive(ready({ now: T0 + dt })).action;
    expect(at(0)).toBe("none");
    expect(at(REVIVE_LADDER_MS[0]! - 1)).toBe("none");
    expect(at(REVIVE_LADDER_MS[0]!)).toBe("ping"); // due is inclusive
  });

  it("measures each later rung from the LAST PING, not from the start of the episode", () => {
    // Two attempts in, the third rung (30s) is measured from lastPingAt — so a long-running episode
    // does not make every remaining rung instantly due.
    const lastPingAt = T0 + 10 * 60_000; // ten minutes into the episode
    const base = { attempts: 2, erroredSince: T0, lastPingAt };
    expect(decideRevive(ready({ ...base, now: lastPingAt + REVIVE_LADDER_MS[2]! - 1 })).action).toBe(
      "none",
    );
    expect(decideRevive(ready({ ...base, now: lastPingAt + REVIVE_LADDER_MS[2]! })).action).toBe(
      "ping",
    );
  });

  it("walks every rung in order and reports a monotonic attempt number", () => {
    let lastPingAt: number | undefined = undefined;
    const erroredSince: number | undefined = T0;
    let clock = T0;
    const seen: number[] = [];
    for (let i = 0; i < REVIVE_LADDER_MS.length; i++) {
      clock += REVIVE_LADDER_MS[i]!; // advance exactly one rung
      const d = decideRevive(ready({ attempts: i, erroredSince, lastPingAt, now: clock }));
      expect(d.action).toBe("ping");
      if (d.action === "ping") seen.push(d.attempt);
      lastPingAt = clock;
    }
    expect(seen).toEqual(Array.from({ length: REVIVE_LADDER_MS.length }, (_, i) => i + 1));
  });

  it("escalates once the ladder is spent instead of pinging forever", () => {
    const d = decideRevive(
      ready({ attempts: REVIVE_LADDER_MS.length, lastPingAt: T0, now: T0 + 60 * 60_000 }),
    );
    expect(d.action).toBe("escalate");
    expect(d).toMatchObject({ reason: expect.stringMatching(/outlasting the ladder/) });
  });

  it("refuses rather than firing instantly when there is no anchor to measure from", () => {
    // An undefined erroredSince means "the caller could not say when this began" — which must not
    // read as "due now", or an episode with a missing timestamp would ping on the very first tick.
    expect(decideRevive(ready({ erroredSince: undefined, lastPingAt: undefined }))).toEqual({
      action: "none",
      reason: "waiting-for-next-rung",
    });
  });

  it("is the founder's ladder, verbatim", () => {
    // Pinned as a VALUE, not recomputed from a formula — the shape was specified, not derived, and a
    // refactor that "simplifies" it into exponential backoff would silently change behaviour.
    expect(REVIVE_LADDER_MS).toEqual([
      5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000,
      1_800_000,
    ]);
  });

  // Pinning the array is only as good as the array: the docs claimed the ladder spanned ~1h47m while
  // the arithmetic (and the escalation sentence the code actually emits) said 1h 27m, and nothing
  // caught the disagreement because no test asserted the TOTAL (roborev 55422). Assert both the sum
  // and the rendered span, so the value and every claim about it are locked together.
  it("spans exactly the total its docs and escalation copy claim", () => {
    const total = REVIVE_LADDER_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(5_210_000); // 5,210s
    expect(Math.round(total / 60_000)).toBe(87); // 1h 27m, NOT 1h 47m

    // The escalation sentence renders that same span, so the copy cannot drift from the array either.
    const spent = decideRevive(
      ready({ attempts: REVIVE_LADDER_MS.length, lastPingAt: T0, now: T0 + 3 * 60 * 60_000 }),
    );
    expect(spent.action).toBe("escalate");
    expect(spent).toMatchObject({ reason: expect.stringContaining("1h 27m") });
    expect(spent).toMatchObject({ reason: expect.not.stringContaining("1h 47m") });
  });
});

describe("nextRungDueAt", () => {
  it("returns the instant the pending rung comes due, so the mount sets one timer", () => {
    expect(nextRungDueAt({ attempts: 0, erroredSince: T0, lastPingAt: undefined, now: T0 })).toBe(
      T0 + REVIVE_LADDER_MS[0]!,
    );
    expect(nextRungDueAt({ attempts: 3, erroredSince: T0, lastPingAt: T0 + 999, now: T0 })).toBe(
      T0 + 999 + REVIVE_LADDER_MS[3]!,
    );
  });

  it("never returns a past instant, so a caller can use it as a timer without clamping", () => {
    const overdue = T0 + 10 * 60_000;
    expect(
      nextRungDueAt({ attempts: 0, erroredSince: T0, lastPingAt: undefined, now: overdue }),
    ).toBe(overdue);
  });

  it("returns null when nothing is pending", () => {
    expect(
      nextRungDueAt({
        attempts: REVIVE_LADDER_MS.length,
        erroredSince: T0,
        lastPingAt: T0,
        now: T0,
      }),
    ).toBeNull();
    expect(
      nextRungDueAt({ attempts: 0, erroredSince: undefined, lastPingAt: undefined, now: T0 }),
    ).toBeNull();
  });
});

describe("revivePrompt", () => {
  it("names the cause, forbids acknowledging, and offers an exit the agent can reach", () => {
    const p = revivePrompt(3);
    expect(p).toMatch(/529/); // names the actual failure, so "continue what?" can't happen
    expect(p).toMatch(/retry 3 of 11/);
    expect(p).toMatch(/[Dd]o not stop to acknowledge/);
    // Without a reachable exit, a genuinely blocked agent is pinged until the ladder is spent and
    // the human is then told the wrong thing about why.
    expect(p).toMatch(/blocked on something a retry cannot fix/);
  });
});
