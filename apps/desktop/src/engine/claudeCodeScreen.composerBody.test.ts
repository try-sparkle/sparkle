// THE COMPOSER BOX HAS A BODY — a message sitting in it is not a full-screen app (bead sparkle-v7k3y).
//
// ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────────────────────────
// `hasComposerBox` required the box to be exactly THREE CONSECUTIVE rows — `lines[i]` a rule,
// `lines[i+1]` the prompt, `lines[i+2]` a rule. Every screen in `capturedScreens.fixture` was
// captured at Claude Code 2.1.220 with an EMPTY composer, which is exactly that shape, so the whole
// suite was green against a predicate that could only recognise an empty input box.
//
// A composer with a MESSAGE IN IT is four or more rows, because Claude Code soft-wraps the box's own
// contents and reserves a row beneath a short one. Family D is MANDATORY in `isClaudeCodeScreen`, so
// the moment anything was typed into an agent and not submitted, that agent stopped being
// recognisable as Claude Code and every subsequent write was refused `alternate-screen`.
//
// ── WHY THAT CASCADES ─────────────────────────────────────────────────────────────────────────────
// The state this fails on is the state the app itself creates. `services/conciergeDispatch` and the
// nudger both TYPE INTO the composer; anything that lands there unsubmitted puts the agent into the
// unrecognisable shape permanently. `goalContinuationRunner` then escalates after
// MAX_UNDELIVERED_CONTINUES failed reaches, and an escalated goal needs a human. So one unsubmitted
// message strands the agent — which is the "five agents sat red overnight holding correct answers
// that had been typed and never sent" case `nudge_gate.rs` already names for the Rust side, arriving
// here through a different door. The Rust twin (`looks_like_claude_prompt`) never had this hole: it
// asks for a rule line and an input line ANYWHERE, with no adjacency requirement.
//
// ── THE FIXTURES ARE REAL ─────────────────────────────────────────────────────────────────────────
// All five screens below were captured by replaying a genuine pty byte stream through
// `@xterm/headless` and this repo's own `snapshotScreen` — the same path production reads. They are
// not hand-written approximations, which matters here specifically: a hand-written "composer with
// text" would have encoded the author's GUESS about the layout, and the guess (a tight three-row
// box) is precisely what was wrong.
import { describe, it, expect } from "vitest";
import {
  isClaudeCodeScreen,
  hasClaudeCodeComposerBox,
  claudeCodeMarkerFamilies,
} from "./claudeCodeScreen";
import {
  CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231,
  CLAUDE_COMPOSER_PADDED_TEXT_2_1_231,
  VIM_ON_A_MARKDOWN_FILE,
  LESS_ON_A_MARKDOWN_FILE,
  CLAUDE_COMPOSER_PASTED_TEXT_2_1_231,
  IDLE_AFTER_TURN_2_1_220,
} from "./capturedScreens.fixture";

describe("a Claude Code composer holding an unsubmitted message is still Claude Code", () => {
  it("recognises a message that WRAPPED onto a second row", () => {
    expect(hasClaudeCodeComposerBox(CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231)).toBe(true);
    expect(isClaudeCodeScreen(CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231)).toBe(true);
  });

  it("recognises a short message with the reserved blank row beneath it", () => {
    expect(hasClaudeCodeComposerBox(CLAUDE_COMPOSER_PADDED_TEXT_2_1_231)).toBe(true);
    expect(isClaudeCodeScreen(CLAUDE_COMPOSER_PADDED_TEXT_2_1_231)).toBe(true);
  });

  it("still recognises the EMPTY composer it always did (2.1.220)", () => {
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
  });

  // ── THE PASTED CASE NEEDED MORE THAN THE BODY FIX, WHICH IS WHY IT IS A SEPARATE CASE ─────────
  // The bounded body alone was not enough here. A paste ALSO removes the persistent chrome bar —
  // Claude Code swaps it for `paste again to expand` — so the composer box was the only surviving
  // family and `isClaudeCodeScreen`'s `>= 2` corroboration rule failed anyway. Found by replaying a
  // real pasted-message capture, not by reasoning about the code: the box test passed and the
  // screen was still refused.
  it("recognises a PASTED message whose chrome bar was replaced by the paste hint", () => {
    expect(hasClaudeCodeComposerBox(CLAUDE_COMPOSER_PASTED_TEXT_2_1_231)).toBe(true);
    expect(isClaudeCodeScreen(CLAUDE_COMPOSER_PASTED_TEXT_2_1_231)).toBe(true);
  });

  // ── THE PASTE HINT IS INDEPENDENT EVIDENCE, AND THAT IS THE WHOLE POINT ────────────────────────
  // The corroborating family must be evidence SEPARATE from the box, or `>= 2` is satisfied by one
  // marker. `[Pasted text #N]` was briefly in CHROME_BAR and is not, because Claude Code draws it
  // INSIDE the box on the prompt line (roborev 63610) — so the count below is asserted, not just
  // the boolean: 2 means the box AND something else, which is the invariant that was at risk.
  const rule = "─".repeat(120);
  const pasteScreen = [
    rule,
    "❯ some pasted message",
    "  wrapped onto a second row",
    rule,
    "  paste again to expand",
  ].join("\n");

  it("the paste hint corroborates the composer box, as a DISTINCT family", () => {
    expect(isClaudeCodeScreen(pasteScreen)).toBe(true);
    expect(claudeCodeMarkerFamilies(pasteScreen)).toBe(2);
  });

  // The impostor pairing every widening in this module carries: the same string in a document
  // whose box shape is broken must stay refused, so the hint can never carry a screen alone.
  it("a document merely CONTAINING the paste hint is still refused", () => {
    const quoted = ["  Some notes about the paste hint.", "  paste again to expand", "  and more prose."].join("\n");
    expect(isClaudeCodeScreen(quoted)).toBe(false);
    expect(claudeCodeMarkerFamilies(quoted)).toBe(1);
  });

  // And the marker that was REMOVED: a pager quoting a composer capture must not clear the bar.
  // This is the exact screen that returned true while `[Pasted text #N]` was in CHROME_BAR.
  it("a pager quoting a composer capture is refused", () => {
    const quoted = [rule, "❯ [Pasted text #1]", "  and a continuation row", rule, "  nothing familiar here"].join("\n");
    expect(isClaudeCodeScreen(quoted)).toBe(false);
  });
});

describe("a genuine full-screen app is still refused", () => {
  // These two are the reason the widening above is bounded rather than "any two rules with
  // something between them". `less` here is paging AGENTS.md, a document that QUOTES Claude Code's
  // chrome verbatim — the exact impostor `claudeCodeScreen`'s header says a content heuristic must
  // not fall for.
  it("vim is not Claude Code", () => {
    expect(hasClaudeCodeComposerBox(VIM_ON_A_MARKDOWN_FILE)).toBe(false);
    expect(isClaudeCodeScreen(VIM_ON_A_MARKDOWN_FILE)).toBe(false);
  });

  it("less is not Claude Code, even paging a file that quotes Claude Code", () => {
    expect(hasClaudeCodeComposerBox(LESS_ON_A_MARKDOWN_FILE)).toBe(false);
    expect(isClaudeCodeScreen(LESS_ON_A_MARKDOWN_FILE)).toBe(false);
  });

  // ── THE BOUND IS LOAD-BEARING, so it gets its own case ──────────────────────────────────────────
  // Without a cap on the box body, ANY two full-width rules anywhere on the grid with a `❯` line
  // after the first would form a "composer" — which is a document with a horizontal rule near the
  // top and another near the bottom, i.e. a very ordinary page in a pager.
  it("two rules a whole screen apart are NOT a composer box", () => {
    const rule = "─".repeat(120);
    const farApart = [rule, "❯ this is not really a prompt", ...Array(20).fill("filler"), rule].join(
      "\n",
    );
    expect(hasClaudeCodeComposerBox(farApart)).toBe(false);
  });

  // ── THE ADVERSARIAL CASE THE vim/less FIXTURES CANNOT COVER (roborev 63601) ────────────────────
  // Neither captured full-screen app contains a single box-drawing rule OR a prompt line, so both
  // short-circuit before the body walk and would pass with ANY body rule. They prove the guard
  // still refuses a pager; they cannot prove the WIDENING is safe. This can: a boxed shell
  // transcript inside a paged document is exactly `rule / ❯ command / output / rule`, and its
  // output is FLUSH LEFT, which is what Claude Code's indented continuation never is.
  it("a boxed shell transcript in a pager is NOT a composer box", () => {
    const rule = "─".repeat(120);
    const transcript = [
      "  Some documentation above the example.",
      rule,
      "❯ npm run build",
      "Build succeeded in 4.2s",
      "3 files written",
      rule,
      "  …and prose below it.",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(transcript)).toBe(false);
    expect(isClaudeCodeScreen(transcript)).toBe(false);
  });

  // ── THE CAP IS PINNED IN BOTH DIRECTIONS ──────────────────────────────────────────────────────
  // Previously only a 20-filler case existed, so `MAX_COMPOSER_BODY_ROWS` could have been anything
  // from 1 to 19 with the suite still green. These two straddle the boundary, so the constant
  // cannot drift silently in either direction.
  const boxWithBody = (bodyRows: number) => {
    const rule = "─".repeat(120);
    return [rule, "❯ a message", ...Array(bodyRows).fill("  continuation"), rule].join("\n");
  };

  it("a body at exactly the bound still closes the box", () => {
    expect(hasClaudeCodeComposerBox(boxWithBody(24))).toBe(true);
  });

  it("a body one row past the bound does not", () => {
    expect(hasClaudeCodeComposerBox(boxWithBody(25))).toBe(false);
  });

  // ── THE ROUNDED-BOX ARM HAS A BODY TOO, AND NOTHING COVERED IT (roborev 63623) ─────────────────
  // Every rounded-box screen in this repo is the tight three-row EMPTY composer, which returns on
  // the FIRST iteration of the body walk and so never reaches `isBoxBodyRow` at all. That arm's
  // body predicate could be stubbed to `return true` with the whole suite green — which is how it
  // shipped accepting `/^\s*[│|]/`, a pattern that filters nothing, since every row between `╭…╮`
  // and `╰…╯` starts with a border by construction. These three cover it in both directions.
  // `BOX_PROMPT` requires the row to CLOSE with a border, so rows are padded to a fixed width —
  // which is how Claude Code draws them anyway.
  const W = 40;
  const row = (inner: string) => "│ " + inner.padEnd(W) + " │";
  const rounded = (bodyRows: string[]) =>
    ["╭" + "─".repeat(W + 2) + "╮", row("> a message"), ...bodyRows, "╰" + "─".repeat(W + 2) + "╯"].join(
      "\n",
    );

  it("a rounded composer with an indented body is recognised", () => {
    expect(hasClaudeCodeComposerBox(rounded([row("  a wrapped continuation"), row("")]))).toBe(true);
  });

  it("a rounded box holding flush-left command output is NOT a composer", () => {
    // The rounded-box twin of the boxed-transcript case above: a bordered panel whose contents are
    // output rather than an indented continuation. `│ Build succeeded` is flush against the border,
    // exactly as a TUI panel or a quoted transcript draws it.
    const panel = rounded([row("Build succeeded in 4.2s"), row("3 files written")]);
    expect(hasClaudeCodeComposerBox(panel)).toBe(false);
    expect(isClaudeCodeScreen(panel)).toBe(false);
  });

  it("the rounded body keeps its OWN, smaller bound", () => {
    // Deliberately NOT the bare-rule bound: no capture shows a real rounded body, so that arm was
    // never given the widened window. Pinning it here is what stops it drifting up by accident.
    expect(hasClaudeCodeComposerBox(rounded(Array(12).fill(row("  continuation"))))).toBe(true);
    expect(hasClaudeCodeComposerBox(rounded(Array(13).fill(row("  continuation"))))).toBe(false);
  });

  // ── THE PROMPT LINE IS LOAD-BEARING, AND ONLY THIS PINS IT ─────────────────────────────────────
  // Added because `mutation-check --line 202,212,221,222` FLAGGED the prompt-line test: the body
  // walk that follows it could still return the right answer for every other case in this file with
  // that condition stubbed out, so nothing here proved a `❯` was required at all. Without it the
  // predicate degrades to "two full-width rules within 13 rows of each other", which a document
  // with a boxed code block satisfies — and family D is supposed to be the ONE marker that
  // distinguishes a live TUI from text about one.
  it("two nearby rules with NO prompt line between them are not a composer box", () => {
    const rule = "─".repeat(120);
    expect(hasClaudeCodeComposerBox([rule, "just some prose", rule].join("\n"))).toBe(false);
    // A markdown blockquote is the specific near-miss `PROMPT_LINE` already excludes: a bare `>`
    // WITH text is not a prompt, so this must stay false even though the rules are adjacent.
    expect(hasClaudeCodeComposerBox([rule, "> quoted prose", rule].join("\n"))).toBe(false);
  });
});
