import { describe, it, expect } from "vitest";
import { classifyApproval } from "./approvalClassifier";

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
