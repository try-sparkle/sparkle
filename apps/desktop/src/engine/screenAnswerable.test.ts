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
