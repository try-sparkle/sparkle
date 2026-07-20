import { describe, it, expect } from "vitest";
import { detectPendingQuestion, detectProseQuestion } from "./pendingQuestion";

// The chrome Claude Code paints below its last message — a real scrollback always has some of
// this between the agent's question and the end of the buffer, which is exactly why a
// last-line-only detector (the terminal-widget heuristics) can never see a prose question.
const TUI_CHROME = `
╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts                                    Bypassing Permissions
`;

describe("detectProseQuestion", () => {
  // REGRESSION — founder screenshot 2026-07-20: the agent ended its turn with
  // "Want me to do that — commit, then merge main in?" and the pill offered "Close Build Agent".
  // Note the "?" is mid-line here, not at end of line: the sentence continues after it. A
  // detector keyed on lines ENDING in "?" would miss this exact case.
  it("detects the founder's question with the ? mid-line", () => {
    const s = `
But my work being uncommitted is the risk here. My recommendation: let me commit it now.

Want me to do that — commit, then merge main in? I'd also add the PRD progress entry and run
a roborev pass as part of the commit, per your workflow.
${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(true);
  });

  // REGRESSION — founder screenshot 2 of the same report: the agent had ALREADY landed ("main now
  // contains the fix via a clean --no-ff merge") and closed with "Want me to push?", yet the pill
  // offered "Land to Main". Stage was doubly wrong here — land.sh had checked main out into the
  // worktree and deleted the agent branch — which is the point: the question is the reliable signal
  // about what the user was actually asked, and it doesn't depend on the branch probe being right.
  it("detects the question after an already-completed land", () => {
    const s = `
Nothing is pushed. main is 2 commits ahead of origin/main — your fix plus one other agent's
merge that was already sitting on local main. To publish:

git push origin main

Want me to push?
${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(true);
  });

  it.each([
    "Should I rebase onto origin/main first?",
    "Shall I go ahead and cut the DMG?",
    "Would you like me to open a PR for this?",
    "Do you want me to run the full suite before committing?",
    "Ready for me to land this?",
    "Want me to keep going?",
  ])("detects the direct question %j", (q) => {
    expect(detectProseQuestion(`Some preamble line.\n\n${q}\n${TUI_CHROME}`)).toBe(true);
  });

  it("detects a plain prose question with no known opener", () => {
    const s = `I found two candidate fixes for the race.\n
Which of these should I apply first?\n${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(true);
  });

  it("is false for a turn that ends in a statement", () => {
    const s = `
All 149 tests pass and typecheck is clean. I committed the work as 4f2a1cc and updated the
progress doc. Nothing is left to do on this branch.
${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(false);
  });

  it("is false for the TUI chrome alone — the '? for shortcuts' hint is not a question", () => {
    expect(detectProseQuestion(TUI_CHROME)).toBe(false);
  });

  // The scrollback is full of source code. Ternaries, optional chaining and nullish coalescing all
  // carry a "?" and must never read as the agent asking something.
  it.each([
    "const label = stage === 'merged' ? closeButton() : landButton();",
    "return ws?.hasRemote === true ? pushToOriginMainButton() : closeBuildAgentButton();",
    "const n = opts?.count ?? MAX_BUTTONS;",
    "  if (m?.[1] && m[2] !== undefined) continue;",
  ])("is false for the code line %j", (code) => {
    expect(detectProseQuestion(`Editing agentCta.ts\n${code}\n${TUI_CHROME}`)).toBe(false);
  });

  it("is false for a question buried far above the live tail", () => {
    const stale = "Want me to land this?";
    const filler = Array.from({ length: 60 }, (_, i) => `line ${i} of subsequent work output`);
    expect(detectProseQuestion([stale, ...filler, TUI_CHROME].join("\n"))).toBe(false);
  });

  // REGRESSION (roborev, Low): with a 30-line window, a question the user ALREADY answered stayed
  // in scope on the next settled turn whenever the agent's follow-up output was short — silently
  // demoting the stage CTA for a question nobody was still being asked. A modest amount of
  // subsequent work must be enough to retire it.
  it("is false once a modest amount of work follows the question", () => {
    const answered = "Want me to land this?";
    const work = Array.from({ length: 18 }, (_, i) => `Ran step ${i} and it completed cleanly.`);
    expect(detectProseQuestion([answered, ...work, TUI_CHROME].join("\n"))).toBe(false);
  });

  // The other side of that trade: chrome doesn't count against the window, so a question the agent
  // just asked stays live even with the full TUI frame painted below it.
  it("is true when only chrome separates the question from the end", () => {
    const s = `Want me to push?\n${TUI_CHROME}\n${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(true);
  });

  it("is false for empty or whitespace-only scrollback", () => {
    expect(detectProseQuestion("")).toBe(false);
    expect(detectProseQuestion("   \n\n  \t ")).toBe(false);
  });

  it("sees through ANSI colour codes", () => {
    const s = `\x1b[1mWant me to\x1b[0m commit, then merge main in?\n${TUI_CHROME}`;
    expect(detectProseQuestion(s)).toBe(true);
  });
});

describe("detectPendingQuestion", () => {
  it("is true for a prose question", () => {
    expect(detectPendingQuestion(`Should I land this?\n${TUI_CHROME}`)).toBe(true);
  });

  // A picker on screen is the agent waiting on an answer just as much as a prose question is —
  // and its options are far better CTA material than a stage-derived "Close Build Agent".
  it("is true when a Claude Code option picker is on screen", () => {
    const s = `
Which approach should we take?

  1. Rebase onto origin/main
  2. Merge origin/main in
❯ 3. Leave it alone

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    expect(detectPendingQuestion(s)).toBe(true);
  });

  it("is true for a y/n confirmation", () => {
    expect(detectPendingQuestion("Overwrite the existing file? [y/n]")).toBe(true);
  });

  it("is false for a settled statement with no prompt of any kind", () => {
    expect(detectPendingQuestion(`Done. Committed as 4f2a1cc.\n${TUI_CHROME}`)).toBe(false);
  });
});
