// Unit cases for the predicate itself. The engine-level suite (approvalDeadEnd.test.ts) drives it
// through settle/re-check/mid-stream, but every positive fixture there carries a `❯`, so arm 1 was
// never driven TRUE and replacing its whole body with `return false` left the suite green
// (roborev 59613). These pin each arm, in both directions.
import { describe, it, expect } from "vitest";
import { screenOffersAnswer, streamOffersAnswer } from "./screenAnswerable";
import {
  APPROVAL_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
} from "./capturedScreens.fixture";

const FOOTER = " Esc to cancel · Tab to amend · ctrl+e to explain";

// Two plain numbered rows directly above the footer, NO selection cursor — the shape that only
// arm 1 can accept, and the one nothing used to cover.
const CURSORLESS_MENU = [" Do you want to proceed?", "   1. Yes", "   2. No", FOOTER].join("\n");

// The founder's screen: a stranded footer with its option block gone.
const FOOTER_ONLY = ["  Called sparkle-control 2 times", FOOTER].join("\n");

// The agent's own plan above a stranded footer. `parsePickerOptions` ACCEPTS this (it skips the
// intervening line while the numbers count down), so it is arm 1's belongs-to-this-footer check —
// not the parser — that must reject it.
const PROSE_LIST_ABOVE_FOOTER = [
  "⏺ Here is my plan:",
  "  1. Read the file",
  "  2. Patch it",
  "  3. Run the suite",
  "",
  "  Called sparkle-control 2 times",
  FOOTER,
].join("\n");

describe("screenOffersAnswer — arm 1, a parsed block that belongs to its footer", () => {
  it("accepts a cursor-less menu whose rows abut the footer", () => {
    // If arm 1 were deleted this goes red — nothing else in the suite reaches it.
    expect(screenOffersAnswer(CURSORLESS_MENU)).toBe(true);
  });

  it("REJECTS a numbered prose list separated from the footer by other output", () => {
    expect(screenOffersAnswer(PROSE_LIST_ABOVE_FOOTER)).toBe(false);
  });

  it("REJECTS a stranded footer with no option block at all", () => {
    expect(screenOffersAnswer(FOOTER_ONLY)).toBe(false);
  });
});

describe("screenOffersAnswer — arm 1 must be LIVE, not merely present", () => {
  it("REJECTS a complete cursored dialog once new output has streamed below it", () => {
    // The human already answered it; the agent is working again. `pickerBlockBounds` still finds the
    // block (it searches the last 50 non-empty lines), so without the live-tail anchor arm 1 — which
    // runs FIRST and is the most permissive — re-arms the band off a dialog nobody is sitting on.
    const answered = [" Do you want to proceed?", " ❯ 1. Yes", "   2. No", FOOTER].join("\n");
    const after = Array.from({ length: 14 }, (_, i) => `⏺ step ${i} done`).join("\n");
    expect(screenOffersAnswer(answered)).toBe(true); // control: live, it qualifies
    expect(screenOffersAnswer(`${answered}\n${after}`)).toBe(false);
  });

  it("ACCEPTS a live dialog with real chrome rendering BELOW its footer", () => {
    // The boundary a line budget got wrong: Ink keeps drawing below a live dialog, so anchoring by
    // DISTANCE rejected real pressable menus. The discriminator is WHAT is below the footer.
    //
    // TWO THINGS MAKE THIS NON-VACUOUS, and the first draft had neither (roborev):
    //   • the chrome lines really match AMBIENT_CHROME_LINE — `\u2500` (a rule) and `\u276f` (the
    //     empty composer caret). The draft used `\u23f5`, which is NOT in that class at all, so its
    //     premise was simply false.
    //   • NO selection cursor on the option rows, so arm 2 cannot supply the `true`. The draft's
    //     rows carried `❯`, so it passed through arm 2 and never exercised arm 1 at all.
    const dialog = [" Do you want to proceed?", "   1. Yes", "   2. No", FOOTER].join("\n");
    const chrome = ["  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", "  \u276f"].join("\n");
    expect(screenOffersAnswer(`${dialog}\n${chrome}`)).toBe(true);
  });

  it("ACCEPTS a bordered dialog whose box CLOSES beneath its footer", () => {
    // The one-closing-border allowance. A partial copy of the below-footer walk omitted it and so
    // rejected this shape — stricter than the rule it claimed to mirror, in exactly the "renders
    // below its footer" case (roborev 59690). Sharing the real function is what fixes it.
    const dialog = [" Do you want to proceed?", "   1. Yes", "   2. No", FOOTER].join("\n");
    expect(screenOffersAnswer(`${dialog}\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f`)).toBe(true);
  });

  it("ACCEPTS an answered dialog followed by status-glyph output — the documented residual", () => {
    // NOT the behaviour we would choose, and pinned so it cannot change by accident. The glyph
    // alternative is unanchored, so turn output reads as chrome and arm 1 stays alive. Rejecting the
    // class was tried and reverted: it also rejects Claude's REAL bottom status bars, costing a live
    // dialog its Approve relay, and arm 2's tail window cannot reach far enough to backstop it
    // (roborev 59920). Residual documented in screenAnswerable.ts and tracked in sparkle-7js2c.
    const answered = [" Do you want to proceed?", "   1. Yes", "   2. No", FOOTER].join("\n");
    const output = ["\u273b Churned for 3s", "\u2713 Wrote src/foo.ts", "\u25cf Running tests"].join("\n");
    expect(screenOffersAnswer(`${answered}\n${output}`)).toBe(true);
  });
});

describe("screenOffersAnswer — real captured screens are all answerable", () => {
  // These are live, fully-visible menus. The first draft's stricter walk counted them as 0-1 rows
  // (description rows and separators sit between their options), so they qualified only via the
  // cursor — the fallback PICKER_FOOTER exists precisely to not depend on.
  it.each([
    ["permission dialog", APPROVAL_2_1_220],
    ["AskUserQuestion", ASK_USER_QUESTION_2_1_220],
    ["/model picker", MODEL_PICKER_2_1_220],
  ])("accepts the %s", (_name, screen) => {
    expect(screenOffersAnswer(screen)).toBe(true);
  });
});

describe("screenOffersAnswer — arms 2 and 3 are BOTTOM-ANCHORED, not whole-snapshot", () => {
  it("accepts a shell confirmation at the bottom", () => {
    expect(screenOffersAnswer("rm -rf build/\nOverwrite? (y/n)")).toBe(true);
  });

  it("does NOT arm off prose scrolled far up the grid", () => {
    // "Overwrite?" matches SHELL_PROMPTS, and a `❯ 1.` line is a menu the human already left
    // behind. Neither is live, so neither may claim the band.
    const filler = Array.from({ length: 20 }, (_, i) => `  working on step ${i}`).join("\n");
    expect(screenOffersAnswer(`Overwrite? I'd rather not.\n ❯ 1. Yes\n${filler}`)).toBe(false);
  });

  it("is false on a blank screen", () => {
    expect(screenOffersAnswer("   \n  \n")).toBe(false);
  });
});

describe("streamOffersAnswer — the single-row stream form", () => {
  it("accepts a cursored row", () => {
    expect(streamOffersAnswer("❯ 1. Yes")).toBe(true);
  });

  it("does NOT accept an ordinary markdown list item", () => {
    // The stream form needs only one row, so without the cursor requirement any numbered prose
    // line would arm the approval band for the rest of the turn.
    expect(streamOffersAnswer("  2. Patch it")).toBe(false);
  });
});
