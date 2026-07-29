import { describe, it, expect } from "vitest";
import { screenAwaitsInput, PICKER_FOOTER } from "./screenClassifier";
import {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  NON_PICKER_HINT_LINES_2_1_220,
  OTHER_PICKER_FOOTERS_2_1_220,
} from "./capturedScreens.fixture";

// These fixtures are plain-text snapshots of the *rendered* terminal screen (the visible
// xterm grid, ANSI already resolved) — exactly what `snapshotScreen()` hands the engine.
// `screenAwaitsInput` must return true ONLY when Claude (or a shell) is blocked on a
// specific answer from the user, and false for a finished turn sitting at the idle prompt.

describe("screenAwaitsInput", () => {
  it("flags Claude's permission box (❯ numbered choice menu)", () => {
    const screen = [
      "╭──────────────────────────────────────────────────╮",
      "│ Edit file                                          │",
      "│ src/foo.ts                                         │",
      "│                                                    │",
      "│ Do you want to make this edit to foo.ts?           │",
      "│ ❯ 1. Yes                                           │",
      "│   2. Yes, allow all edits this session             │",
      "│   3. No, and tell Claude what to do differently    │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a plan-mode selection menu", () => {
    const screen = [
      "Would you like to proceed?",
      "❯ 1. Yes, and auto-accept edits",
      "  2. Yes, and manually approve edits",
      "  3. No, keep planning",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags an AskUserQuestion menu (same ❯ numbered shape as the permission box) — sparkle-blpf", () => {
    // AskUserQuestion / ExitPlanMode are not intercepted by Sparkle — they render as Claude Code's
    // standard bordered ❯ numbered selection menu in the PTY, so the selection-cursor marker catches
    // them deterministically (no LLM needed). This pins that the question-tool shape stays red.
    const screen = [
      "╭─ Which date library should we use? ─────────────────╮",
      "│ ❯ 1. date-fns                                       │",
      "│   2. luxon                                          │",
      "│   3. dayjs                                          │",
      "╰─────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a command-approval prompt via its footer even when the cursor glyph is '>' (not ❯)", () => {
    // The founder-report bug: a blocked-on-approval agent showed GREEN/gray instead of RED because
    // the cursor rendered as ">" (not ❯), so the selection-cursor marker missed it. The picker
    // FOOTER is glyph-independent, so it catches the prompt regardless. Note: footer has NO
    // "Tab to amend" (Claude drops it when the highlighted option isn't the amendable "Yes").
    const screen = [
      "This command requires approval",
      "",
      "Do you want to proceed?",
      "  1. Yes",
      '> 2. Yes, and don\'t ask again for: echo "---- retry exit: $? ----"',
      "  3. No",
      "",
      "Esc to cancel · ctrl+e to explain",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a command-approval prompt whose footer keeps 'Tab to amend' (cursor on option 1)", () => {
    const screen = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for: roborev show *",
      "  3. No",
      "",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("does NOT flag prose that merely mentions 'esc to cancel' OR 'ctrl+e to explain' alone", () => {
    // The footer anchor requires BOTH phrases on one line, so an incidental prose mention of either
    // (a changelog note, a help snippet) must not trip a false red.
    expect(screenAwaitsInput("Tip: press esc to cancel the current operation.")).toBe(false);
    expect(screenAwaitsInput("The ctrl+e to explain shortcut opens the explainer.")).toBe(false);
  });

  it("flags a shell (y/n) prompt", () => {
    expect(screenAwaitsInput("Overwrite existing file? (y/n)")).toBe(true);
    expect(screenAwaitsInput("Continue? [Y/n]")).toBe(true);
  });

  it("flags a 'press enter to continue' prompt", () => {
    expect(screenAwaitsInput("Press enter to continue…")).toBe(true);
  });

  it("flags an ssh passphrase / password prompt", () => {
    expect(screenAwaitsInput("Enter passphrase for key '/Users/me/.ssh/id_ed25519':")).toBe(
      true,
    );
    expect(screenAwaitsInput("Password:")).toBe(true);
  });

  it("does NOT flag the idle input box (finished turn, awaiting your next prompt)", () => {
    const screen = [
      "╭────────────────────────────────────────────────────╮",
      "│ >                                                    │",
      "╰────────────────────────────────────────────────────╯",
      "  ? for shortcuts",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("does NOT flag a conversational numbered list Claude wrote as prose", () => {
    // Claude listing options in chat is not a blocking TUI prompt — the turn ended and
    // it's awaiting your normal reply (gray), not a specific selection (red). The tell is
    // the absence of the ❯ selection cursor.
    const screen = [
      "Here are three approaches:",
      "1. Hybrid spinner + screen classifier",
      "2. Send everything to Haiku",
      "3. Pure regex",
      "Let me know which direction you'd like.",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("does NOT flag prose that mentions a question mid-sentence", () => {
    const screen = [
      "I considered whether to proceed with the risky migration, but decided",
      "the safer path was to add a guard first. Done — tests pass.",
      "╭────────────────────────────────────────────────────╮",
      "│ >                                                    │",
      "╰────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("returns false on an empty snapshot", () => {
    expect(screenAwaitsInput("")).toBe(false);
    expect(screenAwaitsInput("   \n  \n")).toBe(false);
  });
});

// ── Regression pins against REAL Claude Code 2.1.220 screens ────────────────────────────────
// Everything below runs against verbatim captured viewports (see capturedScreens.fixture.ts for
// the capture recipe). They exist because the previous drift was found by a human noticing that
// agents looked calm — the cost of a missed picker is that the human is never told an agent is
// waiting on them, so the marker needs a test that fails the moment the TUI moves.
describe("screenAwaitsInput — captured Claude Code 2.1.220 screens", () => {
  it("flags the Bash command-approval dialog (footer: Esc to cancel · Tab to amend · ctrl+e to explain)", () => {
    expect(screenAwaitsInput(APPROVAL_2_1_220)).toBe(true);
    expect(PICKER_FOOTER.test(" Esc to cancel · Tab to amend · ctrl+e to explain")).toBe(true);
  });

  it("flags the approval dialog with the cursor on option 2", () => {
    expect(screenAwaitsInput(APPROVAL_OPTION_2_2_1_220)).toBe(true);
  });

  it("flags the AskUserQuestion picker (footer: Enter to select · ↑/↓ to navigate · Esc to cancel)", () => {
    expect(screenAwaitsInput(ASK_USER_QUESTION_2_1_220)).toBe(true);
    expect(PICKER_FOOTER.test("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(true);
  });

  it("flags the /model picker, whose footer shares NO literal with the other two", () => {
    // "Enter to set as default · s to use this session only · Esc to cancel" — no "Enter to
    // select", no "ctrl+e to explain". A literal-anchored footer marker misses it entirely, which
    // is why the marker is matched by shape.
    expect(
      PICKER_FOOTER.test("   Enter to set as default · s to use this session only · Esc to cancel"),
    ).toBe(true);
    expect(screenAwaitsInput(MODEL_PICKER_2_1_220)).toBe(true);
  });

  it("does NOT flag a finished turn at the idle input box", () => {
    expect(screenAwaitsInput(IDLE_AFTER_TURN_2_1_220)).toBe(false);
  });

  it("does NOT flag ambient chrome or prose that carries '·'-separated key hints", () => {
    // The false-GREEN guard's mirror: a marker loose enough to match the persistent
    // permission-mode bar (or an "Update installed · Restart to apply" toast) pins every agent
    // red forever, which trains the human to ignore red.
    for (const line of NON_PICKER_HINT_LINES_2_1_220) {
      expect(PICKER_FOOTER.test(line), `PICKER_FOOTER must not match: ${line}`).toBe(false);
      expect(screenAwaitsInput(line), `screenAwaitsInput must not flag: ${line}`).toBe(false);
    }
  });

  it("flags the OTHER footers 2.1.220 can draw, including the diff-review approval bar", () => {
    // "Enter to approve · r to retry · ↑/↓ to navigate · Esc to cancel" is a blocking approval,
    // and the old literal-anchored marker missed it too — a second false-calm case.
    for (const footer of OTHER_PICKER_FOOTERS_2_1_220) {
      expect(PICKER_FOOTER.test(footer), `PICKER_FOOTER must match: ${footer}`).toBe(true);
      expect(screenAwaitsInput(footer), `screenAwaitsInput must flag: ${footer}`).toBe(true);
    }
  });

  it("knowingly does NOT flag two hint bars that are not blocking dialogs", () => {
    // Recorded, not accidental. The first is the slash-command autocomplete, drawn WHILE the
    // human types — they are already at the keyboard, so it needs no red. The second is the
    // /tui settings screen, whose segments aren't "<key> to <verb>" at all ("Enter save").
    // If either ever needs to go red, that is a deliberate widening, not a silent drift.
    expect(PICKER_FOOTER.test("Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear")).toBe(
      false,
    );
    expect(
      PICKER_FOOTER.test("Scroll to feel it · ←/→ adjust · r reset to auto · Enter save · Esc cancel"),
    ).toBe(false);
  });

  it("does NOT flag a lone key hint, however footer-like, without a second one", () => {
    // One hint is how prose and single-purpose chrome read ("Press Esc to cancel"); a dialog
    // footer always offers at least two.
    expect(PICKER_FOOTER.test("Esc to cancel")).toBe(false);
    expect(PICKER_FOOTER.test("   ● High effort (default) ←/→ to adjust")).toBe(false);
    expect(PICKER_FOOTER.test(" /permissions to update rules")).toBe(false);
  });

  // roborev 54749b: `to cycle` was REMOVED from the disqualifier, and these tests are what make that
  // removal a decision instead of a drift. The finding's complaint was that rule 2 is a literal
  // denylist bolted onto a matcher whose thesis is "literals drift, match by shape", and that it was
  // UNPROVEN: every pinned line carrying `to cycle` ALSO carries `to interrupt`, so nothing in the
  // suite failed when `to cycle` was deleted — and, measured, nothing failed when the whole
  // lookahead was deleted either. All three legs of that trade are pinned below.
  describe("rule 2 (the `to …` disqualifier) is pinned to what it actually buys", () => {
    it("drops `to cycle` because rule 1 rejects the permission-mode bar UNAIDED", () => {
      // The only real chrome we have carrying `to cycle` is the permission-mode bar, and it also
      // says "esc to interrupt" — so the full line proves nothing about WHICH rule rejected it.
      // Stripped of that segment, it is still rejected, and only rule 1 can be doing it: the line
      // opens on "▶▶", which is not a key atom, and `^[ \t]*[│|┃]?[ \t]*` admits nothing else.
      // That is the whole justification for dropping `to cycle`; if it ever stops holding, this
      // goes red rather than the removal quietly becoming a false red on a running agent.
      expect(PICKER_FOOTER.test("▶▶ bypass permissions on (shift+tab to cycle) · PR #730")).toBe(
        false,
      );
    });

    it("drops `to cycle` because it is a plausible verb for a REAL blocking footer", () => {
      // CONSTRUCTED, not captured — flagged as such deliberately. The shape argument is the
      // evidence: the sibling footers in OTHER_PICKER_FOOTERS_2_1_220 use "to switch", "to
      // navigate" and "to adjust" for exactly this move-between-options affordance, so "to cycle"
      // sits squarely inside the space Claude already draws from. Denylisting it blanks the ENTIRE
      // line on one segment — false calm on a dialog, which this file's header calls strictly worse
      // than a false red. No "enter to select…cancel" pair here on purpose, so FOOTER_LEGACY cannot
      // match and this pins the SHAPE arm specifically. Re-add `to cycle` and this goes red.
      const footer = "shift+tab to cycle modes · ↑/↓ to navigate · Esc to cancel";
      expect(PICKER_FOOTER.test(footer)).toBe(true);
      expect(screenAwaitsInput(footer)).toBe(true);
    });

    it("keeps `to interrupt` because it ALONE rejects an all-hints spinner bar", () => {
      // The same "don't keep an untested guard" standard, applied to the verb that survived. Every
      // other line pinned against rule 2 opens on a non-key glyph ("▶▶", "✻", "⏸") and so is already
      // rejected by rule 1 — which is why the entire lookahead could be deleted with the suite still
      // green. This line is the case that is NOT true of: every segment IS a well-formed
      // "<key> to <verb>" hint, so rule 1 admits it and only rule 2 stands between a RUNNING turn
      // and a false red. Delete the lookahead and this goes red.
      const spinnerBar = "esc to interrupt · ctrl+t to show todos";
      expect(PICKER_FOOTER.test(spinnerBar)).toBe(false);
      expect(screenAwaitsInput(spinnerBar)).toBe(false);
    });
  });

  // roborev 54749: the "to interrupt" disqualifier must be scoped to ONE RENDERED LINE.
  //
  // `m` makes ^/$ break on \r as well as \n, but the lookahead was written `[^\n]*`, which scans
  // across \r. The ingest path is where that bites: statusEngine splits chunks only on \n and hands
  // the classifier `this.partial` — the unterminated in-place-redraw tail, whose shape is
  // "frame\rframe\rframe". So a footer in the first frame was suppressed by a spinner in a LATER
  // frame, i.e. a false GRAY on an agent that is actually blocked on a dialog. That is the failure
  // direction the shape matcher exists to eliminate, so it is pinned here per-footer rather than by
  // a single example.
  describe("a \\r redraw frame must not suppress a footer from an earlier frame", () => {
    const SPINNER_FRAME = "✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)";

    for (const footer of OTHER_PICKER_FOOTERS_2_1_220) {
      it(`keeps matching ${JSON.stringify(footer.slice(0, 44))}… before a spinner frame`, () => {
        // Sanity: the footer alone matches, so a failure below is the \r leak and nothing else.
        expect(PICKER_FOOTER.test(footer)).toBe(true);
        expect(PICKER_FOOTER.test(`${footer}\r${SPINNER_FRAME}`)).toBe(true);
        // And in the other order — the tail is what statusEngine actually forwards.
        expect(PICKER_FOOTER.test(`${SPINNER_FRAME}\r${footer}`)).toBe(true);
      });
    }

    it("still suppresses a spinner frame on its OWN line", () => {
      // The disqualifier must keep doing its job within one line; scoping it to \r must not have
      // widened what counts as a picker.
      expect(PICKER_FOOTER.test(SPINNER_FRAME)).toBe(false);
      expect(screenAwaitsInput(SPINNER_FRAME)).toBe(false);
    });
  });
});
