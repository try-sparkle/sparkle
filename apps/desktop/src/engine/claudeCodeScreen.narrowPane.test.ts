// A LIVE CLAUDE CODE IN A NARROW PANE IS STILL A LIVE CLAUDE CODE (bead sparkle-tbsvf).
//
// THE DEFECT THESE PIN. `claudeCodeScreen`'s family D — the composer box, and the module's one proof
// of a LIVE TUI — measured the box in ABSOLUTE columns: a rule line had to carry 20+ box-drawing
// characters, and the rounded form 10+ between its corners. A rule is drawn to the width of the
// GRID, so those constants are really a claim about how wide the pane is, and this app renders agent
// terminals far narrower than that. Its own code says so from two separately measured cases: a pane
// that "fits to a tiny size (cols≈12)" (components/Terminal.tsx) and one given "a fit of cols=23 in
// a box that holds ~43" (bead sparkle-l2xgf). Below ~20 columns family D cannot fire AT ALL, so
// `isClaudeCodeScreen` returns false on a perfectly ordinary idle Claude Code and the alternate
// buffer is read as `vim` — the founder's message bounced with "has a full-screen app open", from a
// pane he was looking straight at.
//
// This is the same narrow-pane class already fixed one module over: `engine/rejoinWrapped` exists
// because a picker footer "in a 13-column agent column landed on six rows" and every line-anchored
// matcher missed it (bead sparkle-99o9a). The reader was fixed there; this predicate's own width
// assumption was left behind.
//
// WHAT KEEPS THE NARROW ARM HONEST is not a smaller number — it is POSITION, the same argument
// families E and F already make. See `claudeCodeScreen`'s own header.
import { describe, expect, it } from "vitest";
import { claudeCodeMarkerFamilies, hasClaudeCodeComposerBox, isClaudeCodeScreen } from "./claudeCodeScreen";

/** Ink's own wrapping: break at word boundaries to `cols`, emitting REAL newlines.
 *
 *  THE WHOLE SCREEN IS WRAPPED, NOT ONLY THE RULES (roborev 64464, High). The first cut of this file
 *  narrowed the rules to 12 columns and left the status bar at its full 36 — a row no 12-column grid
 *  can render. That made the fixture pass while the founder's real screen would still have been
 *  refused: on a real narrow pane the bar arrives SPLIT, and only its first row carries the glyph
 *  `AMBIENT_CHROME_LINE` matches. A fixture that supplies rows the grid cannot produce is not
 *  evidence about that grid, and the assertions over it prove nothing about the case they name.
 *
 *  `engine/rejoinWrapped` does not put these back together, and that is the point: it rejoins rows
 *  the TERMINAL wrapped, via `isWrapped`. Ink wraps first and emits its own newline, so there is no
 *  flag to consult — see `screenClassifier`'s footer-join note (bead sparkle-99o9a). */
function wrapToGrid(line: string, cols: number): string[] {
  if (line.length <= cols) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > cols) {
    // Break at the last space that fits, as Ink does; fall back to a hard break for a long token.
    const cut = rest.lastIndexOf(" ", cols);
    const at = cut > 0 ? cut : cols;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(cut > 0 ? at + 1 : at);
  }
  out.push(rest);
  return out;
}

/** An idle Claude Code rendered into a `cols`-wide pane: the tail of the real captured screen
 *  (`IDLE_AFTER_TURN_2_1_220`), with every row — rules, transcript and status bar alike — drawn to
 *  that grid rather than to the 120 columns it was captured at. */
function idleClaudeCodeAt(cols: number): string {
  const rule = "─".repeat(cols);
  return [
    ...wrapToGrid("⏺ hello", cols),
    "",
    rule,
    "❯",
    rule,
    ...wrapToGrid("  ⏸ manual mode on · ? for shortcuts", cols),
  ].join("\n");
}

describe("the composer box is recognised at the widths this app actually renders", () => {
  // 120 columns — the width every captured fixture in this repo was taken at. Guards the narrow arm
  // from being a rewrite: whatever it does, the wide case must keep answering exactly as it did.
  it("still recognises the wide pane the fixtures were captured at", () => {
    expect(hasClaudeCodeComposerBox(idleClaudeCodeAt(120))).toBe(true);
    expect(isClaudeCodeScreen(idleClaudeCodeAt(120))).toBe(true);
  });

  // cols=23, measured on a real pane (bead sparkle-l2xgf).
  it("recognises a 23-column pane", () => {
    expect(hasClaudeCodeComposerBox(idleClaudeCodeAt(23))).toBe(true);
    expect(isClaudeCodeScreen(idleClaudeCodeAt(23))).toBe(true);
  });

  // cols≈12, measured on a real pane (components/Terminal.tsx). THE FOUNDER'S CASE: below 20 the old
  // constant made family D structurally impossible, so this screen scored 1 (the ⏺ glyph) and was
  // refused as a full-screen app.
  it("recognises a 12-column pane — the width family D could not previously reach", () => {
    expect(hasClaudeCodeComposerBox(idleClaudeCodeAt(12))).toBe(true);
    expect(isClaudeCodeScreen(idleClaudeCodeAt(12))).toBe(true);
  });

  it("counts the composer box as its own family in a narrow pane, not as a second reading of the glyph", () => {
    // ⏺ (family B) + the box (family D) = 2. Family C does NOT fire, and that is the POINT rather
    // than a gap: it stays line-anchored, so on a narrow pane — where Ink splits
    // "manual mode on · ? for shortcuts" across rows — it has nothing to match. Letting it read the
    // rejoined tail instead would count the SAME status bar the narrow composer arm already proved
    // itself with, satisfying `>= 2` from one marker (roborev 64482).
    //
    // Asserting the COUNT rather than the boolean is this module's convention, and this is exactly
    // the case it exists for: a change that collapsed two families into one would still satisfy
    // `>= 2` while this row goes to 3 and reddens.
    expect(claudeCodeMarkerFamilies(idleClaudeCodeAt(12))).toBe(2);
  });

  // ══ THE VIEWPORT WITH NO TOOL GLYPH AT ALL (roborev 64475, Medium) ════════════════════════════
  // THE SECOND ROUTE TO THE FOUNDER'S REFUSAL, and the one the fixture's convenient "⏺ hello" was
  // hiding. `isClaudeCodeScreen` wants the box PLUS one corroborating family. On a narrow pane
  // family C was going blind for the same line-anchoring reason family D was — Ink splits
  // "manual mode on · ? for shortcuts" across rows — so a viewport holding only a wrapped PROSE
  // reply, the composer, and the wrapped status bar had no second family and was refused even with
  // the box recognised. That is an ordinary state: any text-only answer, or anything after /clear.
  it("recognises a narrow pane whose viewport holds no tool glyph, only prose and chrome", () => {
    const proseOnly = [
      ...wrapToGrid("Yes — that reads the viewport, not the scrollback.", 12),
      "",
      "────────────",
      "❯",
      "────────────",
      ...wrapToGrid("  ⏸ manual mode on · ? for shortcuts", 12),
    ].join("\n");
    // ONE family, and recognised anyway — this is the row that pins the narrow box STANDING ALONE.
    // Family B is genuinely absent and family C cannot fire at this width, so a `>= 2` rule would
    // refuse this screen. It is recognised because the narrow arm's own proof already contains two
    // independent things: the box, and Claude's rejoined status bar beneath it. Counting that bar a
    // second time as family C would be the collapse roborev 64482 caught; standing alone is how the
    // screen keeps its answer without the double count.
    expect(claudeCodeMarkerFamilies(proseOnly)).toBe(1);
    expect(isClaudeCodeScreen(proseOnly)).toBe(true);
  });

  // ══ THE VERSION-CURRENT OPENER, `⏵` (roborev 64501, High) ═════════════════════════════════════
  // THE DEFECT THIS PINS. The anchor's leading-glyph class was written from 2.1.220's `▶` and did
  // not carry `⏵` (U+23F5), which is what Claude Code 2.1.231 actually draws — captured verbatim
  // TWICE in `capturedScreens.fixture.ts` as `  ⏵⏵ bypass permissions on (shift+tab to cycle)`,
  // both from this app's own worktrees. The cost is not a demotion: the anchored join fails, the
  // walk answers `no`, the closing rule is rejected and family D is lost ENTIRELY — so the ordinary
  // idle narrow pane on the current Claude version is refused, which is the bug this arm exists to
  // remove. Every other case here uses the one bar that opens with `⏸`, so nothing else sees it.
  it("recognises the 2.1.231 status bar, whose opener is ⏵ rather than ▶", () => {
    const screen = [
      "────────────",
      "❯",
      "────────────",
      ...wrapToGrid("  ⏵⏵ bypass permissions on (shift+tab to cycle)", 12),
    ].join("\n");
    expect(hasClaudeCodeComposerBox(screen)).toBe(true);
    expect(isClaudeCodeScreen(screen)).toBe(true);
  });

  // …and the 2.1.220 spelling keeps working, so the row above is an ADDITION rather than a swap.
  it("still recognises the 2.1.220 spelling of the same bar", () => {
    const screen = [
      "────────────",
      "❯",
      "────────────",
      ...wrapToGrid("▶▶ bypass permissions on (shift+tab to cycle)", 12),
    ].join("\n");
    expect(hasClaudeCodeComposerBox(screen)).toBe(true);
    expect(isClaudeCodeScreen(screen)).toBe(true);
  });

  // A DIVIDER BETWEEN THE BOX AND THE BAR MUST NOT COST FAMILY D (roborev 64501, High). A tail of
  // rules ALONE already terminates the grid, so a rule that merely precedes the bar pushing it out
  // of the anchor's reach would be strictly worse than drawing no bar at all.
  it("anchors past a rule drawn between the box and the status bar", () => {
    const screen = [
      "────────────",
      "❯",
      "────────────",
      "────────────",
      ...wrapToGrid("  ⏸ manual mode on · ? for shortcuts", 12),
    ].join("\n");
    expect(hasClaudeCodeComposerBox(screen)).toBe(true);
    expect(isClaudeCodeScreen(screen)).toBe(true);
  });

  // …and the skip's BOUNDARY, asserted rather than inferred (roborev 64564, Medium). Skipping
  // leading dividers must not become "skip until something matches": a rule followed by ordinary
  // prose is a document, and it has to answer `no` exactly as the undivided form does.
  it("does not let the divider skip walk past a rule into non-chrome prose", () => {
    const ruleThenProse = [
      "⏺ hello",
      "",
      "────────────",
      "❯",
      "────────────",
      "────────────",
      "notes.md 62%",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(ruleThenProse)).toBe(false);
    expect(isClaudeCodeScreen(ruleThenProse)).toBe(false);
  });

  // ══ CLAUDE'S OWN BARS THAT DO NOT OPEN WITH A GLYPH (roborev 64487, Medium) ═══════════════════
  // THE DEFECT THESE PIN. The arm briefly gated the FIRST row below the box on
  // `AMBIENT_CHROME_LINE`, which demands a leading status glyph, a 4+ rule or a bare caret. Two of
  // `CHROME_BAR`'s entries are captured verbatim in `capturedScreens.fixture.ts` as bars that start
  // with PLAIN TEXT, so wrapped to a narrow pane their first row is `paste again` / `Claude is` —
  // neither matches, and the arm could not fire on them at all. Every other narrow-pane case here
  // uses the one bar that happens to open with `⏸`, so nothing else catches this.
  it.each([
    ["the paste hint, which REPLACES the status bar", "  paste again to expand"],
    ["the computer-use bar", "Claude is using your computer · press Esc to stop"],
  ])("recognises a narrow pane whose status bar is %s", (_label, bar) => {
    const screen = [
      "────────────",
      "❯",
      "────────────",
      ...wrapToGrid(bar, 12),
    ].join("\n");
    // The bar is SPLIT, so family C — line-anchored over the whole snapshot — cannot see it either;
    // the box is the only family, and the screen is recognised on the rejoined tail alone. That is
    // the state `conciergeDispatch` creates itself when its own paste does not submit.
    expect(claudeCodeMarkerFamilies(screen)).toBe(1);
    expect(hasClaudeCodeComposerBox(screen)).toBe(true);
    expect(isClaudeCodeScreen(screen)).toBe(true);
  });
});

describe("a narrow rule is not a licence for a document that merely contains one", () => {
  // THE IMPOSTOR THE NARROW ARM MUST STILL EXCLUDE, and the reason the fix is positional rather than
  // simply a smaller constant. A pager showing a document that QUOTES a composer box reproduces the
  // shape exactly — a short rule, a `❯` line, a short rule — and at a wide grid a 12-character run is
  // an ordinary ASCII separator rather than the full width of anything.
  const quotedBox = [
    "# notes on the composer",
    "",
    "────────────",
    "❯ ",
    "────────────",
    "",
    "That is what Claude Code draws while it is idle.",
    "notes.md (END)",
  ].join("\n");

  it("refuses a quoted composer box that a pager is still drawing its own status row under", () => {
    expect(hasClaudeCodeComposerBox(quotedBox)).toBe(false);
    expect(isClaudeCodeScreen(quotedBox)).toBe(false);
  });

  it("refuses it even when the document also carries Claude Code's glyphs and status bar", () => {
    // Two families' worth of quoted evidence — exactly the "text ABOUT a TUI" case family D exists
    // to exclude. Without the position rule this is what a smaller constant would have let through.
    const quotedTranscript = [
      "⏺ hello",
      "  ⎿  done",
      "",
      "────────────",
      "❯ ",
      "────────────",
      "",
      "  ⏸ manual mode on · ? for shortcuts",
      "transcript.md lines 40-56/210 62%",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(quotedTranscript)).toBe(false);
    expect(isClaudeCodeScreen(quotedTranscript)).toBe(false);
  });

  // ══ A PAGER RUNNING *IN* A NARROW PANE — THE CASE A WIDTH BOUND CANNOT SEE (roborev 64475) ════
  // THE HOLE THIS CLOSES. An earlier cut of the narrow arm admitted every row below the box behind
  // "nothing may be wider than the rules", and that bound is VACUOUS here by construction: the pane
  // IS 12 columns, so nothing below can exceed 12 whatever it says. Only the first row was checked,
  // against `AMBIENT_CHROME_LINE`, which any line opening with `●` satisfies. So `less` showing a
  // document that quotes a composer box cleared family D, a `⏺` anywhere supplied the second
  // family, and `conciergeDispatch` would have pasted AND SUBMITTED into the pager — this module's
  // own stated worst case.
  it("refuses a pager in a narrow pane whose rows all fit the grid", () => {
    const pagerInNarrowPane = [
      "⏺ hello",
      "",
      "────────────",
      "❯",
      "────────────",
      "● note text",
      "more prose",
      ":",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(pagerInNarrowPane)).toBe(false);
    expect(isClaudeCodeScreen(pagerInNarrowPane)).toBe(false);
  });

  // The same shape without even a chrome-looking first row. Every row below the box FITS the grid,
  // so the width bound cannot reject it and the chrome test is the only thing that can — which is
  // what makes this the row that pins that test rather than one that merely passes alongside it.
  it("refuses a narrow box whose below-box rows fit the grid but are not chrome", () => {
    const notChrome = ["⏺ hello", "", "────────────", "❯", "────────────", "notes.md 62%"].join(
      "\n",
    );
    expect(hasClaudeCodeComposerBox(notChrome)).toBe(false);
    expect(isClaudeCodeScreen(notChrome)).toBe(false);
  });

  // ══ CHROME_BAR IS AN UNANCHORED SUBSTRING TEST (roborev 64482, High) ══════════════════════════
  // Its entries are phrases matched anywhere in the string, so requiring the rejoined tail to MATCH
  // one is not the same as requiring the tail to BE Claude's status bar: a document whose prose
  // happens to quote the phrase would clear it. The first content row below the box must therefore
  // also OPEN like chrome, which a document's tail — starting with its own text — does not.
  it("refuses a tail that merely quotes one of Claude's status phrases inside prose", () => {
    const quotesThePhrase = [
      "⏺ hello",
      "",
      "────────────",
      "❯",
      "────────────",
      "press ? for",
      "shortcuts to",
      "see the rest",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(quotesThePhrase)).toBe(false);
    expect(isClaudeCodeScreen(quotesThePhrase)).toBe(false);
  });

  // ══ A BARE TAIL PROVES NO CHROME, SO IT MAY NOT STAND ALONE (roborev 64487, High) ═════════════
  // THE HOLE THIS CLOSES. `narrowBoxTerminatesGrid` accepts a box with NOTHING below it and one with
  // only rules below it — correctly, neither is a document — but the standalone privilege was
  // justified by "a narrow box already carries the box AND the chrome", which is false on exactly
  // those two tails. A viewport carrying ZERO Claude markers therefore passed `isClaudeCodeScreen`
  // on the box SHAPE alone, and `conciergeDispatch` pastes AND SUBMITS behind that answer.
  it("refuses a narrow box with nothing below it when no other family is present", () => {
    const nothingBelow = ["# notes on the composer", "────────────", "❯", "────────────"].join("\n");
    // The box is still RECOGNISED — family D, one vote — which is what makes this a test of the
    // standalone rule rather than of the termination walk.
    expect(hasClaudeCodeComposerBox(nothingBelow)).toBe(true);
    expect(claudeCodeMarkerFamilies(nothingBelow)).toBe(1);
    expect(isClaudeCodeScreen(nothingBelow)).toBe(false);
  });

  it("refuses a narrow box whose tail is rules only — the vim/no-statusline shape", () => {
    const rulesOnly = [
      "# notes on the composer",
      "────────────",
      "❯",
      "────────────",
      "────────────",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(rulesOnly)).toBe(true);
    expect(claudeCodeMarkerFamilies(rulesOnly)).toBe(1);
    expect(isClaudeCodeScreen(rulesOnly)).toBe(false);
  });

  // THE PAIRED POSITIVE, so the two rows above are not passing because the shape stopped being
  // recognised at all. The identical bare box WITH a second, independent family is accepted by the
  // ordinary `>= 2` rule — the fall-through is a demotion, not a new refusal.
  it("accepts the same bare box when a second family corroborates it", () => {
    const withGlyph = ["⏺ hello", "  ⎿  done", "────────────", "❯", "────────────"].join("\n");
    expect(claudeCodeMarkerFamilies(withGlyph)).toBe(2);
    expect(isClaudeCodeScreen(withGlyph)).toBe(true);
  });

  // ══ THE EQUAL-WIDTH RULE, PINNED ON ITS OWN (roborev 64464, Medium) ═══════════════════════════
  // Both impostors above draw two rules of the SAME length, so the termination walk was rejecting
  // them single-handed and `closeWidth === topWidth` could have been deleted with the suite still
  // green — a conjunct the narrow arm's safety argument names explicitly, guarded by nothing. This
  // case is built so the equality is the ONLY thing that can reject it: everything below the box is
  // ambient chrome that fits the grid, exactly as on a real pane.
  it("refuses a box whose two rules are different widths, with nothing else to reject it", () => {
    // Everything below the box is Claude's own status bar, wrapped to the grid — so the chrome test
    // and the width bound both pass and the EQUALITY is the only thing left to reject this.
    const chrome = wrapToGrid("  ⏸ manual mode on · ? for shortcuts", 12);
    const mismatched = ["⏺ hello", "", "────────────", "❯", "──────────", ...chrome].join("\n");
    expect(hasClaudeCodeComposerBox(mismatched)).toBe(false);
    expect(isClaudeCodeScreen(mismatched)).toBe(false);

    // …and the same rows with the widths MADE equal are accepted, so the row above is failing on
    // the equality and not on some unrelated part of the shape.
    const matched = ["⏺ hello", "", "────────────", "❯", "────────────", ...chrome].join("\n");
    expect(hasClaudeCodeComposerBox(matched)).toBe(true);
  });

  // The rounded arm gets the same treatment — it has its own floor (`WIDE_BOX_RULE_MIN`) and its own
  // pair of borders, so a case that only exercises the bare-rule arm says nothing about it.
  it("applies the same width agreement to the rounded box form", () => {
    // Inner width 8 → a 10-column grid, which is what the chrome rows below are wrapped to.
    const chrome = wrapToGrid("⏸ manual mode on · ? for shortcuts", 10);
    const rounded = (top: number, bottom: number): string =>
      [
        "⏺ hello",
        "",
        `╭${"─".repeat(top)}╮`,
        `│ ❯ │`,
        `╰${"─".repeat(bottom)}╯`,
        ...chrome,
      ].join("\n");
    expect(hasClaudeCodeComposerBox(rounded(8, 8))).toBe(true);
    expect(hasClaudeCodeComposerBox(rounded(8, 7))).toBe(false);
  });
});

// ══ THE WIDE PATH MUST NOT REGRESS ON A SHORT RULE INSIDE THE BOX (roborev 64464, Medium) ════════
// Lowering `RULE_LINE` to `{8,}` had a consequence the first cut's own doc denied: an INDENTED run
// of 8-19 box characters inside a composer body started matching as a rule, so the scan stopped
// there, the width check failed it, and the box was abandoned before reaching the genuine
// 120-column closing rule. Under the old `{20,}` that row was a `CONTINUATION_ROW` and the scan
// carried on. A wide composer holding a pasted message containing a short rule would therefore have
// LOST family D — the very refusal this change exists to remove, reintroduced on the wide path.
describe("a short rule inside a wide composer body does not end the box", () => {
  it("still finds the real closing rule below a pasted separator", () => {
    const wide = "─".repeat(120);
    const screen = [
      "⏺ hello",
      "",
      wide,
      "❯ here is the snippet I mentioned",
      "    ────────────",
      "    and the line after it",
      wide,
      "  ⏸ manual mode on · ? for shortcuts",
    ].join("\n");
    expect(hasClaudeCodeComposerBox(screen)).toBe(true);
    expect(isClaudeCodeScreen(screen)).toBe(true);
  });
});
