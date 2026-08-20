// THE BUSY STATUS LINE MOVED AGAIN, AND THE MATCHER WENT BLIND TO IT (Claude Code 2.1.237).
//
// ══ WHAT BROKE ══════════════════════════════════════════════════════════════════════════════════
// `isSpinnerFrame` requires a glyph-led frame PLUS one of: a parenthetical clock, a token counter,
// or the legacy `esc to interrupt` tail. Claude Code 2.1.237 draws NEITHER of the first two on an
// ordinary turn. Captured from a live session and replayed through `@xterm/headless`:
//
//     ✶ Schlepping…            ← no clock at all
//     ✽ Enchanting…
//     ✻ Crunched for 2s        ← elapsed, but NOT parenthesised
//
// All of them were rejected. The consequence is the FALSE GRAY this module's own header describes:
// once spinner mode is latched only a marker frame re-arms the settle timer, so a couple of seconds
// into every turn the engine records `idle` — a calm dot on a plainly working agent. That `idle`
// also opens the CTA gate, which is how "Merge PR" comes to be offered over live work, and it pins
// `isInMotion` false, removing the in-motion suppression on the worker-red bubble.
//
// ══ WHY THE FIX KEYS ON THE GLYPH SET, NOT ON THE WORDING ═══════════════════════════════════════
// The tempting fix is a loose `for <N>s` tail. It is WRONG, and dangerously so: `SPINNER_GLYPH`
// accepts `*` and `+` — an ordinary markdown bullet and a diff line — so a loose tail matches
// `* run the suite for 30s` and pins that agent green forever. This module's header calls false
// green "the more dangerous one" precisely because it hides a real question behind a healthy dot.
//
// So the new arm accepts only Claude's OWN spinner glyphs, never the ASCII fallbacks, and anchors
// the WHOLE FRAME. The controls below are what pin that boundary.
import { describe, expect, it } from "vitest";
import { isSpinnerFrame, SPINNER_GLYPH_CLASS } from "./statusEngine";

/** Verbatim frames from Claude Code 2.1.237, recovered by replaying a live pty stream through
 *  `@xterm/headless` and sampling the rendered grid at byte intervals. Raw line-splitting does NOT
 *  work here — the spinner redraws in place with carriage returns, so a naive split yields
 *  fragments like `✻c` and `✶pn`. */
const REAL_2_1_237 = [
  "✶ Schlepping…",
  "✽ Enchanting…",
  "✻ Crunched for 2s",
  "✻ Crunched for 7s",
  // INDEPENDENTLY CORROBORATED, and this one is not mine: `engine/composerOcclusion` has documented
  // this exact shape in its own comment ("✽ Baked for 2m 24s") since before this change. A sibling
  // module knew the busy line looked like this while `statusEngine` did not — which is precisely the
  // drift SPINNER_GLYPH's comment warns about ("letting them drift apart is how one of them silently
  // stops matching"). It also exercises the h/m/s arm, which the captured frames do not.
  "✽ Baked for 2m 24s",
  // THE `·` BEAT (roborev 65910). An earlier cut excluded this glyph on the stated grounds that it
  // is not one of Claude's own — which `composerOcclusion` contradicts: it lists `·` in its
  // SPINNER_GLYPH and quotes "· Thinking… (esc to interrupt)" verbatim. Excluding it left a frame
  // drawn on this beat rejected by BOTH arms, i.e. the false gray still open for a slice of frames.
  "· Schlepping…",
  "· Thinking…",
];

/** EVERY CODEPOINT IN THE CLASS, PINNED — AND **DERIVED**, NEVER RE-TYPED (roborev 65985, 66000).
 *
 *  `SPINNER_BARE_FRAME` builds its glyph class from `\u` ESCAPES, which trades a class a reviewer
 *  could check by eye for an opaque string only a test can validate. Two directions can break it,
 *  and they need different guards:
 *
 *   • MISTYPE / DROP an escape. Closed by asserting each codepoint below forms a real frame.
 *   • ADD a beat. This is the one that recurs, because it is the natural edit: Claude Code rotates
 *     its glyph set (2.1.218 → 2.1.237 is this file's whole premise), someone adds the new glyph to
 *     the greppable literal class, and the escaped one silently does not carry it. A hand-typed
 *     list HERE cannot catch that — it would be copied from the same edit that forgot it, which is
 *     how a fourth copy of one set came to exist with nothing asserting any two agreed.
 *
 *  ══ AND COUNT COVERAGE BY THE **ARM**, NOT BY THE TREE (roborev 66000) ═══════════════════════
 *  An earlier note here claimed "two of the seven were matched by no frame anywhere in the tree",
 *  and that reasoning is the trap, not the fix. Grepping the tree finds frames for `✳`
 *  (`redAttentionTaxonomy`, `pickerFingerprint.stability`) — but they are LEGACY-tail frames, which
 *  clear through `SPINNER_GLYPH` + `WORKING_PATTERNS` and never reach `SPINNER_BARE_FRAME` at all.
 *  Same for `✢`, whose only frames are the parenthesised
 *  `"✢ Metamorphosing… (40m 17s · ↓ 66.9k tokens)"`.
 *
 *  So by the measure that matters for THIS pattern, THREE escapes were unvalidated — `✢`, `✳`, `∗`
 *  — not two, and a reader re-deriving coverage from a tree-wide grep would conclude two of those
 *  are safe to leave unpinned. "A frame exists somewhere" is not "this arm was exercised".
 *
 *  So the list is UNESCAPED FROM THE PRODUCTION CLASS rather than restated. Adding a beat is now one
 *  edit, and every codepoint in it is exercised here automatically. */
const EVERY_CLAUDE_GLYPH = [
  ...SPINNER_GLYPH_CLASS.replace(/\\u([0-9a-f]{4})/gi, (_m, hex) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  ),
];

/** The shapes that already worked, kept so a fix cannot quietly drop them. */
const LEGACY = [
  "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)",
  "✢ Metamorphosing… (40m 17s · ↓ 66.9k tokens)",
];

/** THE FALSE-GREEN CONTROLS THE GLYPH CLASS ALONE REJECTS. Ordinary agent output a loose tail on
 *  `WORKING_PATTERNS` would have matched, since `SPINNER_GLYPH` accepts `*` and `+`. */
const REJECTED_BY_GLYPH = [
  "* run the suite for 30s",
  "+ waited for 5s",
  "* Schlepping…",
  "+ Enchanting…",
];

/** ══ THE CONTROLS THAT ACTUALLY EXERCISE THE ANCHOR (roborev 65910, Medium) ═════════════════════
 *  Every control in the first cut of this suite started with `*` or `+`, so the GLYPH CLASS alone
 *  rejected all of them — and the anchor, which the pattern's docblock calls the load-bearing
 *  property, had ZERO coverage. Loosening `SPINNER_BARE_FRAME` to an unanchored
 *  `/^\s*[✻✽✢✶✳∗·].*\bfor\s+\d+\s*s/` left the entire suite GREEN. A test that cannot fail
 *  against the defect it names is the vacuous shape AGENTS.md calls the #1 fleet-wide finding, and
 *  the comment claiming these "pin the boundary" was true only of the glyph half.
 *
 *  Each of these carries a REAL Claude glyph, so it clears the class and can only be rejected by
 *  the anchor, the capital rule, or the length bound — the three properties that were unpinned. */
const REJECTED_BY_ANCHOR_OR_PHRASE = [
  // Trailing clause after a well-formed status line — the anchor is the only thing that stops it.
  "✻ Crunched for 2s, then it failed",
  "· Baked for 2m 24s and then gave up",
  // Prose continuing past the ellipsis.
  "✻ Cogitating… let me check the logs",
  // A leading digit: the initial-capital rule is what rejects this.
  "✻ 3 files changed for 2s of savings",
  // Lower-case prose bullet — the case that motivated excluding `·` in the first place, now handled
  // by the capital rule INSTEAD of a glyph ban, so `· Schlepping…` can still be recognised.
  "· item one",
  "· plain prose that mentions 12s somewhere",
  // ══ THE WRAPPED PICKER FOOTER — LIFTED FROM THIS REPO, NOT INVENTED (roborev 65949) ══════════
  // `screenClassifier` documents that Claude Code's footer wraps at Ink widths 44-58, stranding
  // these as lines of their own; `capturedScreens.fixture`'s OTHER_PICKER_FOOTERS carries them.
  // Each is glyph-led, capitalised and digit-free, so an initial-capital rule admits it — and
  // `ingest` would then set `working` on a chunk whose only content is a dialog AWAITING THE HUMAN.
  // The single-word rule is what rejects them; these two pin that direction.
  "· Esc to cancel",
  "· Esc to close",
  // ══ A BARE CAPITALISED WORD — NO ELLIPSIS, NO CLOCK (roborev 65998) ═══════════════════════════
  // Both tails were optional, so `<glyph> Word` matched: these are ordinary one-word bullets an
  // agent prints when it is FINISHED, and each one made `ingest` set `working` and re-arm the
  // settle timer on completed output. Nothing in the captured corpus ever needed a bare word to
  // match — every real frame carries an ellipsis or an elapsed clock — so requiring one costs
  // nothing and closes this.
  "· Verified",
  "· Done",
  "✻ Fixed",
  "✽ Passed",
  // Past the {1,40} phrase bound.
  `✻ ${"Verylongphrase".repeat(4)} for 2s`,
];

const NOT_A_STATUS_LINE = [...REJECTED_BY_GLYPH, ...REJECTED_BY_ANCHOR_OR_PHRASE];

describe("isSpinnerFrame — Claude Code 2.1.237's busy status line", () => {
  for (const frame of REAL_2_1_237) {
    it(`reads ${JSON.stringify(frame)} as WORKING`, () => {
      expect(isSpinnerFrame(frame)).toBe(true);
    });
  }

  for (const frame of LEGACY) {
    it(`still reads legacy ${JSON.stringify(frame.slice(0, 20))}… as WORKING`, () => {
      expect(isSpinnerFrame(frame)).toBe(true);
    });
  }

  // ══ THE HALF THAT PROTECTS THE DOT ════════════════════════════════════════════════════════════
  // Without these the suite would pass against `/./`, and this module's whole argument is that a
  // false GREEN is worse than a false gray: it hides a question rather than merely mistiming one.
  for (const frame of NOT_A_STATUS_LINE) {
    it(`does NOT read ordinary output ${JSON.stringify(frame)} as working`, () => {
      expect(isSpinnerFrame(frame)).toBe(false);
    });
  }

  for (const glyph of EVERY_CLAUDE_GLYPH) {
    it(`recognises a frame led by ${JSON.stringify(glyph)} — the escape is transcribed correctly`, () => {
      expect(isSpinnerFrame(`${glyph} Schlepping…`)).toBe(true);
      expect(isSpinnerFrame(`${glyph} Crunched for 2s`)).toBe(true);
    });

    it(`still refuses a wrapped key hint led by ${JSON.stringify(glyph)}`, () => {
      // The paired inverse per glyph: admitting a codepoint must not admit the picker footer with
      // it. Without this, "pin every codepoint" could be satisfied by a pattern that accepts
      // anything glyph-led.
      expect(isSpinnerFrame(`${glyph} Esc to cancel`)).toBe(false);
    });
  }

  it("derives its glyph list from the production class — seven beats, none hand-typed", () => {
    // THE ASSERTION THAT KEEPS THE LOOP HONEST. If the unescape ever yields nothing (a renamed
    // export, a changed escape syntax), every per-glyph case below would vacuously pass by
    // iterating an empty list — the failure mode of a derived fixture.
    expect(EVERY_CLAUDE_GLYPH).toHaveLength(7);
    expect(EVERY_CLAUDE_GLYPH).toContain("✻");
    expect(EVERY_CLAUDE_GLYPH).toContain("·");
    // The ASCII fallbacks are deliberately NOT in the bare-frame class.
    expect(EVERY_CLAUDE_GLYPH).not.toContain("*");
    expect(EVERY_CLAUDE_GLYPH).not.toContain("+");
  });

  it("does not treat a bare glyph with no phrase as a status line", () => {
    expect(isSpinnerFrame("✻")).toBe(false);
    expect(isSpinnerFrame("✻ ")).toBe(false);
  });
});
