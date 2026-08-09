import { describe, it, expect } from "vitest";
import { classifyApproval } from "./approvalClassifier";
import {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  MODEL_PICKER_2_1_220,
  ASK_USER_QUESTION_2_1_220,
} from "../../engine/capturedScreens.fixture";

// Captured-style Claude Code permission dialogs, one per category. Each mirrors the real Ink render:
// a header describing the action, the numbered Yes / Yes-and-remember / No options (option 1 is the
// plain Yes, pointed at with ❯), and the picker footer. Following the heuristics.test.ts fixture style.
const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

const SKILL = [
  "Use skill artifact-design?",
  "",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for artifact-design",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

const BASH = [
  "Bash command",
  "  rm -rf build/",
  "  Remove the build directory",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands in this project",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

// The real Claude Code Bash-command approval prompt uses a DIFFERENT footer than the standard picker
// ("Esc to cancel · Tab to amend · ctrl+e to explain"). Without recognizing that footer the whole
// classify path bails and bash prompts never auto-approve — this is the regression under test.
const BASH_AMEND_FOOTER = [
  "Bash command",
  "  rm -rf build/",
  "  Remove the build directory",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands in this project",
  "  3. No, and tell Claude what to do differently",
  "",
  "Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

// Claude Code DROPS "Tab to amend" from the approval footer whenever the highlighted option is not
// the amendable "Yes" — i.e. when the cursor sits on option 2/3 — leaving just
// "Esc to cancel · ctrl+e to explain". A footer regex anchored on "tab to amend" silently missed
// these frames, so the agent sat stuck on the prompt with no auto-approve. This fixture (cursor on
// option 2, no "Tab to amend", trailing Ink content BELOW the footer as the real render shows) is
// the regression the "esc to cancel … ctrl+e to explain" anchor fixes.
const BASH_NO_AMEND_FOOTER = [
  "This command requires approval",
  "",
  "Do you want to proceed?",
  "  1. Yes",
  '❯ 2. Yes, and don\'t ask again for: echo "---- retry exit: $? ----"',
  "  3. No",
  "",
  "Esc to cancel · ctrl+e to explain",
  "",
  "5 tasks (0 done, 1 in progress, 4 open)",
].join("\n");

// The highlighted-option glyph also drifts (❯ → › → ">"); the classifier must still parse the
// options and pick the plain Yes regardless. Same no-amend footer, "›" cursor.
const BASH_NO_AMEND_ALT_CURSOR = BASH_NO_AMEND_FOOTER.replace("❯", "›");

const EDIT = [
  "Edit file",
  "  src/main.ts",
  "",
  "Do you want to make this edit to main.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

const MCP = [
  "Use tool mcp__playwright__browser_navigate?",
  "  navigate the browser to https://example.com/docs",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for this tool",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

const FETCH = [
  "WebFetch(https://example.com/docs)",
  "  Fetch the page and summarize it",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for example.com",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

const OTHER = [
  "Do you want to proceed with this action?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

// An AskUserQuestion clarifying picker — arbitrary option labels, NO yes/no shape. Must classify to
// null so the executor never auto-answers it (fail safe).
const ASK_USER_QUESTION = [
  "How configurable should low-balance auto-top-up be?",
  "",
  "❯ 1. User picks threshold + pack (Recommended)",
  "  2. Fixed policy, just a toggle",
  "  3. Defer auto-top-up to v1.1",
  "",
  FOOTER,
].join("\n");

describe("classifyApproval", () => {
  it("classifies a skill permission prompt and extracts the plain-Yes keystroke", () => {
    expect(classifyApproval(SKILL)).toEqual({ category: "skill", approveOption: "1\n" });
  });

  it("classifies a bash/command permission prompt", () => {
    expect(classifyApproval(BASH)).toEqual({ category: "bash", approveOption: "1\n" });
  });

  it("classifies a bash prompt that uses the amend/explain footer (the regression)", () => {
    expect(classifyApproval(BASH_AMEND_FOOTER)).toEqual({ category: "bash", approveOption: "1\n" });
  });

  it("classifies a bash prompt whose footer DROPS 'Tab to amend' (cursor on option 2)", () => {
    // The primary regression from the founder report: option 2/3 highlighted → no "Tab to amend" →
    // previously classified null and the agent hung. Must now auto-approve to the plain Yes (opt 1).
    expect(classifyApproval(BASH_NO_AMEND_FOOTER)).toEqual({ category: "bash", approveOption: "1\n" });
  });

  it("classifies the no-amend footer regardless of the cursor glyph (❯ → ›)", () => {
    expect(classifyApproval(BASH_NO_AMEND_ALT_CURSOR)).toEqual({ category: "bash", approveOption: "1\n" });
  });

  it("classifies a file-edit permission prompt", () => {
    expect(classifyApproval(EDIT)).toEqual({ category: "edit", approveOption: "1\n" });
  });

  it("classifies an MCP tool-call permission prompt (mcp wins over the URL in its body)", () => {
    expect(classifyApproval(MCP)).toEqual({ category: "mcp", approveOption: "1\n" });
  });

  it("classifies a web-fetch permission prompt", () => {
    expect(classifyApproval(FETCH)).toEqual({ category: "fetch", approveOption: "1\n" });
  });

  it("falls back to 'other' for a permission prompt with no category signal", () => {
    expect(classifyApproval(OTHER)).toEqual({ category: "other", approveOption: "1\n" });
  });

  it("returns null for an AskUserQuestion picker (not a yes/no permission prompt)", () => {
    expect(classifyApproval(ASK_USER_QUESTION)).toBeNull();
  });

  it("returns null when there is no picker at all", () => {
    expect(classifyApproval("Compiling... done in 4.2s\n$ ")).toBeNull();
  });

  it("returns null for an ordinary picker whose option 1 is 'Yes' but has no 'No' option", () => {
    // Fail-safe: an arbitrary picker (option 1 literally "Yes", another option merely containing
    // "and") must NOT be treated as a permission prompt just because a label says "and".
    const ordinary = [
      "How should I land this?",
      "❯ 1. Yes, ship it",
      "  2. Merge and rebase first",
      "  3. Squash the commits",
      "",
      FOOTER,
    ].join("\n");
    expect(classifyApproval(ordinary)).toBeNull();
  });

  it("classifies from the header, not the remember-option text (no false 'bash' from option labels)", () => {
    // An EDIT prompt whose "don't ask again" option mentions "commands"/"execute" must NOT be pulled
    // into the destructive `bash` category — the numbered option lines are excluded from category
    // classification (headerRegion), so only the header ("Edit file …") drives it.
    const editWithCommandyOption = [
      "Edit file",
      "  src/deploy.ts",
      "",
      "Do you want to make this edit to deploy.ts?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for commands I execute in this project",
      "  3. No, and tell Claude what to do differently",
      "",
      FOOTER,
    ].join("\n");
    expect(classifyApproval(editWithCommandyOption)).toEqual({ category: "edit", approveOption: "1\n" });
  });

  it("selects the PLAIN Yes, never the native 'don't ask again' option", () => {
    // Even if the plain Yes is not literally option 1, we pick it — never option 2's continuation.
    const reordered = [
      "Use skill foo?",
      "❯ 1. Yes, and don't ask again for foo",
      "  2. Yes",
      "  3. No",
      "",
      FOOTER,
    ].join("\n");
    expect(classifyApproval(reordered)).toEqual({ category: "skill", approveOption: "2\n" });
  });
});

// ── Same shared PICKER_FOOTER, third consumer ──
// The category is read from the header region ABOVE the footer, so a footer the marker cannot
// find means no category — and this is the tier that produces an auto-answer keystroke, so the
// fail-safe direction matters as much as the hit. Verbatim Claude Code 2.1.220 screens.
describe("classifyApproval — captured Claude Code 2.1.220 screens", () => {
  it("classifies the real Bash command-approval dialog", () => {
    expect(classifyApproval(APPROVAL_2_1_220)).toEqual({ category: "bash", approveOption: "1\n" });
  });

  it("classifies it identically with the cursor parked on 'No'", () => {
    // The keystroke is read off the parsed options, never off which one is highlighted.
    expect(classifyApproval(APPROVAL_OPTION_2_2_1_220)).toEqual({
      category: "bash",
      approveOption: "1\n",
    });
  });

  it("returns null for pickers that are not permission dialogs (fail safe)", () => {
    // Both are real pickers the footer marker now finds — and neither may ever be auto-answered:
    // they have no plain Yes / explicit No pair. A regression here types a digit into a menu
    // whose option 1 is an arbitrary choice.
    expect(classifyApproval(MODEL_PICKER_2_1_220)).toBeNull();
    expect(classifyApproval(ASK_USER_QUESTION_2_1_220)).toBeNull();
  });
});

// ── THE HEADER REGION SURVIVES A WRAPPED FOOTER (roborev 61836) ───────────────────────────────
// `headerRegion` slices the lines just ABOVE the footer. With no footer found it falls back to the
// whole tail window, so unrelated output higher up starts driving the category. Routing this
// classifier through the pair-aware matcher is what keeps that from happening on a narrow pane —
// and reverting it to the raw single-line `PICKER_FOOTER.test` must turn this red.
describe("a permission dialog whose footer wrapped", () => {
  // Scrolled-past output that would hijack the category via the `bash` rule ("command") if the
  // footer were missed and the whole window were classified. The dialog itself is an EDIT.
  //
  // It has to sit further than PICKER_SPAN (30) above the footer, or `headerRegion` includes it on
  // BOTH paths and the comparison proves nothing — which is exactly what the first version of this
  // fixture did, and the test caught it.
  const NOISE_ABOVE = [
    "\u23fa I ran the command `git status` to check the tree first.",
    ...Array.from({ length: 32 }, (_, i) => `  step ${i + 1}: reviewed a hunk`),
  ];
  const DIALOG = [
    " Edit src/app/page.tsx?",
    " \u276f 1. Yes",
    "   2. Yes, and don't ask again",
    "   3. No, and tell Claude what to do differently",
  ];

  it("classifies off the dialog's own header, not output scrolled above it", () => {
    const split = [...NOISE_ABOVE, ...DIALOG, " Enter to select \u00b7 Tab/Arrow keys to", " navigate \u00b7 Esc to cancel"].join("\n");
    const whole = [...NOISE_ABOVE, ...DIALOG, " Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel"].join("\n");

    // The unwrapped screen is the reference — this is what the founder sees on a wide pane.
    expect(classifyApproval(whole)?.category).toBe("edit");
    // Narrowing the pane must not change the answer.
    expect(classifyApproval(split)?.category).toBe("edit");
  });
});
