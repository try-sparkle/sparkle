import { describe, it, expect } from "vitest";
import {
  isApiErrorLine,
  isSelfPromptLine,
  StreamFailureDetector,
  STALL_REPEAT_THRESHOLD,
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

describe("isSelfPromptLine", () => {
  it("matches the self-ping churn the agent emits when wedged", () => {
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

  it("trips immediately on a self-prompt ping", () => {
    const d = new StreamFailureDetector();
    expect(d.observe("Are you there?")).toBe(true);
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
