import { describe, it, expect } from "vitest";
import {
  isFolderTrustDialog,
  detectTrustPrompt,
  workspacePathFromDialog,
  isManagedWorktreePath,
  trustAnswerFor,
} from "./trustPrompt";
import {
  FOLDER_TRUST_PROMPT,
  FOLDER_TRUST_PROMPT_WRAPPED,
  FOLDER_TRUST_PROMPT_REORDERED,
  FOLDER_TRUST_PROMPT_STICKY,
  BASH_PERMISSION_PROMPT,
  STALE_TRUST_QUESTION_OVER_BASH_PROMPT,
  FOLDER_TRUST_PROMPT_NO_FOOTER,
  folderTrustPromptFor,
  boxedFolderTrustPromptFor,
} from "./trustPrompt.fixture";

const AGENT = "4cbc4a93-80c2-456f-9508-d64530a251cc";
const PROJECT = "ed5d0ece-8a38-4649-9f7c-0ab6203a7467";
const MANAGED = `/Users/dev/Library/Application Support/ai.sparkle.desktop/worktrees/${PROJECT}/${AGENT}`;

describe("isFolderTrustDialog", () => {
  it("recognises the real dialog", () => {
    expect(isFolderTrustDialog(FOLDER_TRUST_PROMPT)).toBe(true);
  });

  it("recognises it hard-wrapped inside Ink's box borders", () => {
    expect(isFolderTrustDialog(FOLDER_TRUST_PROMPT_WRAPPED)).toBe(true);
  });

  it("recognises it with NO footer row — both parser fallbacks have to carry it", () => {
    expect(isFolderTrustDialog(FOLDER_TRUST_PROMPT_NO_FOOTER)).toBe(true);
    expect(detectTrustPrompt(FOLDER_TRUST_PROMPT_NO_FOOTER)?.trustOption).toBe("1\n");
  });

  it("refuses an ordinary permission prompt", () => {
    expect(isFolderTrustDialog(BASH_PERMISSION_PROMPT)).toBe(false);
  });

  it("refuses a bash prompt drawn under a STALE trust question", () => {
    // The keystroke would be chosen for a question that is no longer the one on screen — and it
    // would also take the prompt away from `maybeAutoApprove`, silently breaking `bash = "always"`.
    expect(isFolderTrustDialog(STALE_TRUST_QUESTION_OVER_BASH_PROMPT)).toBe(false);
  });
});

describe("detectTrustPrompt", () => {
  it("answers with the ordinal carrying the trust LABEL", () => {
    expect(detectTrustPrompt(FOLDER_TRUST_PROMPT)?.trustOption).toBe("1\n");
  });

  it("follows the LABEL when the rows are reordered, never the ordinal", () => {
    // "No, exit" is row 1 here. An ordinal-matched detector exits the agent.
    expect(detectTrustPrompt(FOLDER_TRUST_PROMPT_REORDERED)?.trustOption).toBe("2\n");
  });

  it("refuses an affirmative that widens past this one folder", () => {
    expect(detectTrustPrompt(FOLDER_TRUST_PROMPT_STICKY)).toBeNull();
  });

  // EVERY widening phrasing `TRUST_STICKY_LABEL`'s doc comment enumerates must actually be refused.
  //
  // The regression this pins shipped: the comment listed "…this directory and its subdirectories"
  // as excluded while the alternation matched none of it, so that option passed the affirmative
  // test, escaped the guard, and would have been auto-pressed — answering a question about ONE
  // folder with a RECURSIVE grant over a whole tree. One case per phrasing, so a future edit to the
  // pattern cannot quietly drop a branch; the affirmative below proves the pattern is not simply
  // refusing everything.
  it.each([
    ["subdirectory tree", "Yes, I trust this directory and its subdirectories"],
    ["subdirectories, hyphenated", "Yes, trust this folder and its sub-directories"],
    ["recursive wording", "Yes, trust this folder recursively"],
    ["parent directory", "Yes, and trust the parent directory"],
    ["all directories", "Yes, and trust all directories below it"],
    ["every folder", "Yes, and trust every folder in this directory"],
    ["all folders", "Yes, trust all folders here"],
    ["don't ask again", "Yes, and don't ask again"],
    ["always trust", "Yes, always trust this"],
  ])("refuses a %s affirmative", (_name, label) => {
    const screen = [
      "Quick safety check: Is this a project you created or one you trust?",
      "Claude Code'll be able to read, edit, and execute files here.",
      `❯ 1. ${label}`,
      "  2. No, exit",
    ].join("\n");
    expect(detectTrustPrompt(screen)).toBeNull();
  });

  it("still presses the plain single-folder affirmative", () => {
    // The other half of the pair: without this, a pattern that refused EVERY label would pass the
    // nine cases above while disabling the backstop entirely.
    const screen = [
      "Quick safety check: Is this a project you created or one you trust?",
      "Claude Code'll be able to read, edit, and execute files here.",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
    ].join("\n");
    expect(detectTrustPrompt(screen)?.trustOption).toBe("1\n");
  });

  it("returns null for a screen that is not the trust dialog", () => {
    expect(detectTrustPrompt(BASH_PERMISSION_PROMPT)).toBeNull();
  });
});

describe("workspacePathFromDialog", () => {
  it("reads the path the dialog prints", () => {
    expect(workspacePathFromDialog(folderTrustPromptFor(MANAGED))).toBe(MANAGED);
  });

  it("reads a SPACE-BEARING path off a fully-boxed dialog row", () => {
    // The real macOS location. A token-scanning reader returns "/Users/dev/Library/Application"
    // here — a path that fails containment, so the backstop silently declines the case it exists for.
    expect(workspacePathFromDialog(boxedFolderTrustPromptFor(MANAGED))).toBe(MANAGED);
    expect(trustAnswerFor(boxedFolderTrustPromptFor(MANAGED), AGENT, MANAGED)).toBe("1\n");
  });

  it("is null when the dialog prints none — absence is normal, not a failure", () => {
    expect(workspacePathFromDialog(FOLDER_TRUST_PROMPT)).toBeNull();
  });
});

describe("isManagedWorktreePath", () => {
  it("accepts the layout worktree_path() mints for THIS agent", () => {
    expect(isManagedWorktreePath(MANAGED, AGENT)).toBe(true);
  });

  it("rejects another agent's managed worktree", () => {
    expect(isManagedWorktreePath(MANAGED, "some-other-agent")).toBe(false);
  });

  it("rejects a folder that merely lives under something called worktrees", () => {
    expect(isManagedWorktreePath(`/Users/dev/worktrees/${AGENT}`, AGENT)).toBe(false);
    expect(isManagedWorktreePath(`/repo/.claude/worktrees/a/b/${AGENT}`, AGENT)).toBe(false);
  });

  it("rejects a relative path, a traversal, and a missing one", () => {
    expect(isManagedWorktreePath(`worktrees/${PROJECT}/${AGENT}`, AGENT)).toBe(false);
    expect(isManagedWorktreePath(`/app/worktrees/../../${PROJECT}/${AGENT}`, AGENT)).toBe(false);
    expect(isManagedWorktreePath(null, AGENT)).toBe(false);
  });
});

describe("trustAnswerFor — THE SAFETY SCOPE", () => {
  it("answers the dialog for a folder Sparkle minted for this agent", () => {
    expect(trustAnswerFor(FOLDER_TRUST_PROMPT, AGENT, MANAGED)).toBe("1\n");
  });

  it("REFUSES a dialog naming a path outside the Sparkle worktrees root", () => {
    // The founder opened his own repo and Claude Code asked whether he trusts it. That is the one
    // question this dialog exists for; answering it by machine deletes the control. The agent's
    // recorded worktree is managed and the dialog is genuine — the ONLY thing refusing here is that
    // the folder being asked about is somewhere else.
    const screen = folderTrustPromptFor("/Users/dev/Projects/some-random-repo");
    expect(isFolderTrustDialog(screen)).toBe(true); // the dialog IS recognised…
    expect(detectTrustPrompt(screen)?.trustOption).toBe("1\n"); // …and IS answerable…
    expect(trustAnswerFor(screen, AGENT, MANAGED)).toBeNull(); // …but the scope refuses it.
  });

  it("REFUSES when the agent has no recorded worktree — fail closed, never open", () => {
    expect(trustAnswerFor(FOLDER_TRUST_PROMPT, AGENT, null)).toBeNull();
  });

  it("REFUSES a sibling directory whose name merely prefixes the worktree", () => {
    // `startsWith` would accept this; the boundary-aware containment test must not.
    expect(trustAnswerFor(folderTrustPromptFor(`${MANAGED}-scratch`), AGENT, MANAGED)).toBeNull();
  });

  it("accepts a subdirectory OF the managed worktree", () => {
    expect(trustAnswerFor(folderTrustPromptFor(`${MANAGED}/apps/desktop`), AGENT, MANAGED)).toBe("1\n");
  });
});
