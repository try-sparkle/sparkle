import { describe, it, expect } from "vitest";
import {
  isApiErrorLine,
  isSelfPromptLine,
  apiErrorFramesIn,
  countApiErrorFrames,
  StreamFailureDetector,
  stripMarkers,
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

  // ── The MESSAGE MARKER glyph (sparkle-onzu) ───────────────────────────────────────────────────
  // The banner does NOT arrive bare. Claude Code renders an API error as a synthetic ASSISTANT
  // message, and the TUI prefixes every assistant message with "⏺ " — so what the PTY actually
  // carries is "⏺ API Error: 529 Overloaded.", which `^api error:` could never match.
  //
  // The ABSENCE of that strip is what kept every 529'd agent GREEN/GRAY while the row's whole purpose
  // was to go red. (Attribution: the cause was the missing `⏺` strip — NOT the exclusion of the
  // tool-result glyph `⎿`, which is correct and is kept. See the negative tests below.)
  //
  // The evidence is in-repo and authoritative by this repo's own standard — engine/
  // capturedScreens.fixture.ts is a byte-for-byte replay of a real Claude Code 2.1.220 viewport,
  // and it renders assistant text as "⏺ I'll run that command." and tool results as "  ⎿  $ …".
  // Per that fixture's header: absence in `strings` is not evidence about the UI; only a captured
  // screen is.
  it("matches a banner behind the ⏺ assistant-message marker the TUI actually prints", () => {
    expect(isApiErrorLine("⏺ API Error: 529 Overloaded.")).toBe(true);
    expect(isApiErrorLine("⏺ API Error: 500 Internal server error.")).toBe(true);
    expect(isApiErrorLine("  ⏺ API Error: 529 Overloaded.")).toBe(true);
    // Fused onto a spinner redraw, which is how it arrives mid-turn (cf. the \r-frame test above).
    expect(isApiErrorLine("✻ Cooked for 3m 43s\r⏺ API Error: 529 Overloaded.")).toBe(true);
  });

  // The ASSISTANT marker only — NOT the tool-result marker (roborev 55416). `⎿` prefixes the output
  // of a command the agent RAN, so treating it as a banner marker would paint a healthy agent RED
  // whenever it curls a failing endpoint, tails a server log, or cats a saved error payload. A real
  // banner never arrives this way — it is a synthetic ASSISTANT message, so it wears `⏺`.
  //
  // SCOPE OF THIS GUARD, narrowed deliberately (roborev 55440): it covers the result HEAD — the one
  // line the TUI actually marks. It does NOT close the "logs the agent is reading" class in general;
  // see the companion test below for the residual that remains open.
  it("does NOT treat a MARKED tool-result line as a banner", () => {
    expect(isApiErrorLine("  ⎿  API Error: 500 Internal server error.")).toBe(false);
    expect(isApiErrorLine("⎿ API Error: 529 Overloaded.")).toBe(false);
    // The shape the fixture actually captures, with a plausible failing-request body.
    expect(isApiErrorLine("  ⎿  API Error: 429 rate_limit_error")).toBe(false);
  });

  // The RESIDUAL, pinned as the current behaviour rather than left as an unstated gap. The TUI marks
  // only the FIRST line of a tool result; line 2+ is plain indented text, and this matcher trims
  // leading whitespace before anchoring — so an unmarked continuation line still reads as a banner.
  // This is PRE-EXISTING (a bare "API Error: …" line has always matched; stripping `⏺` neither caused
  // nor widened it) and closing it needs tool-result-block tracking, which could suppress a genuine
  // banner. Asserted as `true` on purpose: if someone closes the gap, this test fails and points them
  // at the comment explaining what changed. Bead sparkle-onzu.
  it("STILL matches an unmarked continuation line of a tool result (known residual)", () => {
    expect(isApiErrorLine("    API Error: 500 Internal server error.")).toBe(true);
  });

  // Two markers, which a redraw can leave: `⏺+` collapses only ADJACENT glyphs, so glyph-space-glyph
  // needs the repetition to span the separator. engine/apiRecovery had a single-`replace` copy of this
  // rule that failed exactly here — it left a glyph behind, classified the failure as null, and skipped
  // the retry ladder while this module had already painted the row red (roborev 55440).
  it("strips a doubled marker left by a redraw", () => {
    expect(isApiErrorLine("⏺ ⏺ API Error: 529 Overloaded.")).toBe(true);
    expect(stripMarkers("⏺ ⏺ API Error: 529 Overloaded.")).toBe("API Error: 529 Overloaded.");
  });

  // ANY count, not "up to N". This was a loop bounded at 3 passes, which failed OPEN past the bound:
  // four markers left a glyph, so `classifyFromScrollback` returned null and the ladder was skipped on
  // an already-red row — the same red-row-no-retry split, just needing one more redraw to reach
  // (roborev 55467). A bounded loop over an unbounded input is the wrong shape; there is no bound now.
  it("strips ANY number of markers, including past the old 3-pass bound", () => {
    for (const n of [1, 2, 3, 4, 5, 9]) {
      const line = `${"⏺ ".repeat(n)}API Error: 529 Overloaded.`;
      expect(stripMarkers(line)).toBe("API Error: 529 Overloaded.");
      expect(isApiErrorLine(line)).toBe(true);
    }
    // Adjacent glyphs and no separator at all, mixed in.
    expect(stripMarkers("⏺⏺⏺ ⏺⏺API Error: 529")).toBe("API Error: 529");
  });

  it("stripping the marker does NOT reopen the narration false-positives (16153/16171)", () => {
    // The COLON is still what separates a banner from a heading, marker or not — so an agent
    // narrating about API errors in its own reply stays green even though its line carries "⏺ ".
    expect(isApiErrorLine("⏺ API Error handling: returns 500.")).toBe(false);
    expect(isApiErrorLine("⏺ API Error responses now return 529.")).toBe(false);
    expect(isApiErrorLine("⏺ I'll add handling for the API Error case")).toBe(false);
    expect(isApiErrorLine("⏺ Internal server error handling: returns 500.")).toBe(false);
    // Only the markers the TUI itself emits are stripped. A markdown bullet the AGENT authored is
    // prose, so a quoted banner inside its own reply must not paint the row red.
    expect(isApiErrorLine("- API Error: 529 Overloaded.")).toBe(false);
    expect(isApiErrorLine("* API Error: 529 Overloaded.")).toBe(false);
    expect(isApiErrorLine("> API Error: 529 Overloaded.")).toBe(false);
    expect(isApiErrorLine("• API Error: 529 Overloaded.")).toBe(false);
    expect(isApiErrorLine("1. API Error: 529 Overloaded.")).toBe(false);
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

  // MARKER COVERAGE FOR THE CHUNK EXTRACTOR (roborev 55416). The marker fix changed this function's
  // matching AND its return values, but the original marker tests all went through isApiErrorLine —
  // leaving the path that actually fires for the production shape untested. A banner fused onto a
  // spinner redraw with NO trailing newline is caught only by StatusEngine's partial-TAIL diff, which
  // goes through here, not by the completed-line loop.
  it("returns frames MARKER-STRIPPED — a contract downstream consumers rely on", () => {
    // engine/apiRecovery documents a dependency on these frames being marker-free, so the stripped
    // return value is part of the interface, not an implementation detail.
    expect(apiErrorFramesIn("⏺ API Error: 529 Overloaded.")).toEqual(["API Error: 529 Overloaded."]);
    expect(apiErrorFramesIn("  ⏺ API Error: 500\n⏺ API Error: 529")).toEqual([
      "API Error: 500",
      "API Error: 529",
    ]);
  });

  it("excludes tool-result frames, so a command's output is not an arrival", () => {
    expect(apiErrorFramesIn("  ⎿  API Error: 500 Internal server error.")).toEqual([]);
    // A real banner alongside a tool result that merely reads like one: only the banner counts.
    expect(apiErrorFramesIn("  ⎿  API Error: 429 rate_limit_error\n⏺ API Error: 529")).toEqual([
      "API Error: 529",
    ]);
  });
});

describe("countApiErrorFrames — under message markers", () => {
  it("counts the marker-prefixed banner fused onto a spinner redraw (the production shape)", () => {
    // Verbatim the shape from the founder's screenshot: a spinner frame, then the banner behind ⏺,
    // with no newline between them.
    expect(countApiErrorFrames("✻ Cooked for 3m 43s\r⏺ API Error: 529 Overloaded.")).toBe(1);
    expect(countApiErrorFrames("⏺ API Error: 500\r⏺ API Error: 500")).toBe(2); // verbatim retry loop
  });

  it("keeps the base/tail delta arithmetic correct under markers", () => {
    // StatusEngine computes apiErrorFramesIn(base + tail).slice(countApiErrorFrames(base)), so a
    // marker-prefixed banner straddling the join must read as exactly ONE arrival.
    const base = "⏺ API Er";
    const tail = "ror: 529 Overloaded.";
    expect(countApiErrorFrames(base)).toBe(0);
    expect(countApiErrorFrames(base + tail)).toBe(1);
    expect(apiErrorFramesIn(base + tail).slice(countApiErrorFrames(base))).toEqual([
      "API Error: 529 Overloaded.",
    ]);
  });

  it("does not count tool-result output", () => {
    expect(countApiErrorFrames("  ⎿  API Error: 500 Internal server error.")).toBe(0);
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
