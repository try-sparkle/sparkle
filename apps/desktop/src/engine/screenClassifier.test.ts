import { describe, it, expect } from "vitest";
import { screenAwaitsInput } from "./screenClassifier";

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
