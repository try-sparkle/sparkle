import { describe, it, expect } from "vitest";
import {
  isApiErrorLine,
  isSelfPromptLine,
  apiErrorFramesIn,
  countApiErrorFrames,
  StreamFailureDetector,
  STALL_REPEAT_THRESHOLD,
  SELF_PROMPT_REPEAT_THRESHOLD,
} from "./streamFailure";

describe("isApiErrorLine", () => {
  it("matches the real-world mid-stream API banners (all start with 'API Error')", () => {
    expect(
      isApiErrorLine(
        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
      ),
    ).toBe(true);
    expect(isApiErrorLine("API Error: 529 overloaded_error")).toBe(true);
    expect(isApiErrorLine("API Error: 500 Internal server error")).toBe(true);
  });

  it("catches a banner in any \\r-frame, whichever side of a spinner redraw it lands on (16169)", () => {
    // spinner-then-banner
    expect(
      isApiErrorLine("✻ Cogitating… (12s · esc to interrupt)\rAPI Error: Rate limited"),
    ).toBe(true);
    // banner-then-spinner (reverse order — last frame is the spinner, not the banner)
    expect(isApiErrorLine("API Error: Rate limited\r✻ Cogitating…")).toBe(true);
  });

  it("does NOT match narration ABOUT errors/rate-limits/overload, incl. line-initial (16153/16171)", () => {
    expect(isApiErrorLine("I'll add handling for the API Error case")).toBe(false);
    expect(isApiErrorLine("The model can be overloaded, so we retry.")).toBe(false);
    expect(isApiErrorLine("the request was rate limited earlier")).toBe(false);
    expect(isApiErrorLine("I added error handling to the API client.")).toBe(false);
    expect(isApiErrorLine("Wrote the rate-limit watcher tests.")).toBe(false);
    // Line-INITIAL narration about these topics must also stay green (roborev 16171): a bare
    // standalone "Internal server error" (e.g. a server log the agent is reading) no longer trips.
    expect(isApiErrorLine("Internal server error handling: returns 500.")).toBe(false);
    expect(isApiErrorLine("Internal server error")).toBe(false);
    expect(isApiErrorLine("500 Internal Server Error")).toBe(false);
    // Even a line that STARTS with "API Error" stays green unless the colon-framed banner follows:
    // a heading/narration like "API Error handling: …" has a word after "API Error", not ":".
    expect(isApiErrorLine("API Error handling: returns 500.")).toBe(false);
    expect(isApiErrorLine("API Error responses now return 529.")).toBe(false);
  });
});

describe("countApiErrorFrames", () => {
  // The StatusEngine partial-banner check subtracts one count from another to learn how many banners
  // ARRIVED in a chunk, so the arithmetic properties matter. Unlike isApiErrorLine (a per-line `some`),
  // this splits on BOTH \r and \n so one chunk carrying several frames is counted correctly.
  it("counts zero when there is no banner", () => {
    expect(countApiErrorFrames("✻ Cogitating… (12s · esc to interrupt)")).toBe(0);
    expect(countApiErrorFrames("")).toBe(0);
    expect(countApiErrorFrames("API Er")).toBe(0); // a bare prefix frame is not a banner
  });

  it("counts one banner whichever framing delimiter carries it", () => {
    expect(countApiErrorFrames("API Error: 500 Internal server error")).toBe(1);
    expect(countApiErrorFrames("✻ Cogitating…\rAPI Error: Rate limited")).toBe(1); // \r-fused
    expect(countApiErrorFrames("some line\nAPI Error: overloaded")).toBe(1); // \n-separated
  });

  it("counts every banner frame in a multi-frame chunk", () => {
    expect(countApiErrorFrames("API Error: 500\rAPI Error: 500")).toBe(2); // verbatim retry loop
    expect(countApiErrorFrames("API Error: 500\n✻ working\nAPI Error: 529")).toBe(2);
  });

  it("treats a \\r\\n empty frame as no banner (no double-count, no phantom)", () => {
    expect(countApiErrorFrames("API Error: 500\r\nnext line")).toBe(1);
    expect(countApiErrorFrames("\r\n")).toBe(0);
  });

  it("ignores narration ABOUT errors, same as isApiErrorLine", () => {
    expect(countApiErrorFrames("I'll add handling for the API Error case\nAPI Error handling: 500")).toBe(0);
  });

  it("trims leading whitespace before matching the line-initial anchor", () => {
    // The StatusEngine partial can hand it a frame with leading spaces; the impl trims, so pin it.
    expect(countApiErrorFrames("   API Error: 500 Internal server error")).toBe(1);
  });

  it("counts a banner straddling a base/tail concat boundary once (the delta contract)", () => {
    // StatusEngine computes count(base + tail) - count(base); a banner split across the join must
    // read as one arrival, not zero (missed) or two (double).
    const base = "API Er";
    const tail = "ror: 500 Internal server error";
    expect(countApiErrorFrames(base)).toBe(0); // the prefix alone is not yet a banner
    expect(countApiErrorFrames(base + tail)).toBe(1); // the joined frame is
  });
});

describe("apiErrorFramesIn", () => {
  it("returns the trimmed banner frames in order (StatusEngine diffs these for arrivals)", () => {
    expect(apiErrorFramesIn("✻ working\rAPI Error: 500\nAPI Error: 529")).toEqual([
      "API Error: 500",
      "API Error: 529",
    ]);
    expect(apiErrorFramesIn("no banners here")).toEqual([]);
  });
});

describe("isSelfPromptLine", () => {
  // isSelfPromptLine stays a PURE phrase-matcher (other modules/tests import it) — a single match is
  // reported true here; whether a single match is a WEDGE is the detector's repetition-gate call.
  it("matches the self-ping churn phrases the agent emits when wedged", () => {
    expect(isSelfPromptLine("Are you there?")).toBe(true);
    expect(isSelfPromptLine("Hey, Sparkler. Are you there?")).toBe(true);
    expect(isSelfPromptLine("Are you still there")).toBe(true);
  });

  it("does not match ordinary output", () => {
    expect(isSelfPromptLine("There are 3 failing tests.")).toBe(false);
  });
});

describe("StreamFailureDetector", () => {
  it("trips immediately on an API-error banner", () => {
    const d = new StreamFailureDetector();
    expect(d.observe("compiling…")).toBe(false);
    expect(d.observe("API Error: Rate limited")).toBe(true);
  });

  it("does NOT trip on a SINGLE self-prompt ping (Bug A: a lone utterance / prose quote is not a wedge)", () => {
    const d = new StreamFailureDetector();
    expect(d.observe("Are you there?")).toBe(false);
  });

  it("trips once a self-prompt phrase REPEATS to the threshold (a real self-ping loop)", () => {
    const d = new StreamFailureDetector();
    let tripped = false;
    for (let i = 0; i < SELF_PROMPT_REPEAT_THRESHOLD; i++) tripped = d.observe("Are you there?");
    expect(tripped).toBe(true);
  });

  it("counts DISTINCT self-prompt phrasings toward the same repeat gate", () => {
    const d = new StreamFailureDetector();
    // Two different wedge pings in a row (not the same string) still constitute a loop.
    expect(d.observe("Are you there?")).toBe(false);
    expect(d.observe("Hey, Sparkler.")).toBe(SELF_PROMPT_REPEAT_THRESHOLD <= 2);
  });

  it("reset() clears the self-prompt counter so a later lone utterance doesn't trip", () => {
    const d = new StreamFailureDetector();
    d.observe("Are you there?"); // 1 — under threshold
    d.reset(); // progress resumed
    expect(d.observe("Are you there?")).toBe(false); // counter restarted — single again
  });

  it("trips after enough identical short repeats (a churn loop)", () => {
    const d = new StreamFailureDetector();
    let tripped = false;
    for (let i = 0; i < STALL_REPEAT_THRESHOLD; i++) tripped = d.observe(".");
    expect(tripped).toBe(true);
  });

  it("does NOT trip on a couple of repeats, nor on varied output", () => {
    const d = new StreamFailureDetector();
    expect(d.observe("step 1")).toBe(false);
    expect(d.observe("step 2")).toBe(false);
    expect(d.observe("step 3")).toBe(false);
    // Two repeats is under the threshold.
    expect(d.observe("same")).toBe(false);
    expect(d.observe("same")).toBe(false);
  });

  it("does not treat a repeated LONG line as churn (it's real output)", () => {
    const d = new StreamFailureDetector();
    const long = "x".repeat(200);
    let tripped = false;
    for (let i = 0; i < 10; i++) tripped = d.observe(long);
    expect(tripped).toBe(false);
  });

  it("reset() clears the repeat counter so post-recovery output starts fresh", () => {
    const d = new StreamFailureDetector();
    d.observe("ping");
    d.observe("ping"); // 2 — under threshold
    d.reset();
    expect(d.observe("ping")).toBe(false); // counter restarted at 1
    expect(d.observe("ping")).toBe(false);
  });
});
