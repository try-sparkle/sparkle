import { describe, it, expect } from "vitest";
import { detectClaudeCodePicker, detectTerminalPrompts } from "./heuristics";

// The exact rendered screen from the reporting bug (IMG_7383): Claude Code's AskUserQuestion
// picker with a ❯ pointer on option 1, hard-wrapped option bodies, free-text entry underscores,
// and — crucially — the task checklist rendered BELOW the dialog, so the footer is nowhere near
// the last line.
const ASK_USER_QUESTION_SCREEN = [
  " □ Auto-top-up",
  "",
  "How configurable should low-balance auto-top-up be?",
  "",
  "❯ 1. User picks threshold + pack (Recommended)",
  "     Opt-in toggle; user chooses the trigger threshold",
  "(e.g. below $5) and which pack to auto-buy",
  "($10/$25/$100). Defaul",
  "ts: below",
  "     $5, buy $25. Card saved during any checkout.",
  "  2. Fixed policy, just a toggle",
  '     One switch: "Auto-refill $25 when below $5." Zero',
  "config, fastest to ship; less control for heavy users.",
  "  3. Defer auto-top-up to v1.1",
  "     Ship balance, buy, history, and promo now; add",
  "auto-top-up in a follow-up once the top-up flow is",
  "proven in the wil",
  "d.",
  "  4. Type something.",
  "____",
  "____",
  "__",
  "__",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
  " ❯ I'd also like to have packs for $500 and $1,000.",
  "",
  "6 tasks (1 done, 1 in progress, 4 open)",
  "■ Ask clarifying questions",
  "□ Propose 2-3 approaches with trade-offs",
  "□ Present design and get approval",
  "□ Write design doc + self-review",
  "□ User reviews spec, then invoke writing-plans",
  "… +1 completed",
].join("\n");

// Claude Code's Bash-command approval prompt renders a DIFFERENT footer than the standard picker —
// "Esc to cancel · Tab to amend · ctrl+e to explain" (no "Enter to select …" text) — and a plain
// Yes / Yes-remember / No option block under a "Do you want to proceed?" header. The detector must
// anchor on the amend/explain footer, which sits below the options like the standard footer does.
const BASH_APPROVAL_SCREEN = [
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

describe("detectClaudeCodePicker", () => {
  it("parses a Bash-command approval prompt whose footer is the amend/explain variant", () => {
    const out = detectClaudeCodePicker(BASH_APPROVAL_SCREEN);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n"]);
    expect(out[0]?.label).toBe("1 · Yes");
    expect(out[2]?.label.startsWith("3 · No")).toBe(true);
    expect(out.every((b) => b.kind === "terminal" && b.source === "heuristic")).toBe(true);
  });

  it("parses the AskUserQuestion picker from the reporting screenshot", () => {
    const out = detectClaudeCodePicker(ASK_USER_QUESTION_SCREEN);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n", "4\n", "5\n"]);
    expect(out[0]?.label.startsWith("1 · User picks threshold + pack")).toBe(true);
    expect(out.map((b) => b.label).slice(1)).toEqual([
      "2 · Fixed policy, just a toggle",
      "3 · Defer auto-top-up to v1.1",
      "4 · Type something.",
      "5 · Chat about this",
    ]);
    expect(out.every((b) => b.kind === "terminal" && b.source === "heuristic")).toBe(true);
  });

  it("truncates long option labels with an ellipsis", () => {
    const label = detectClaudeCodePicker(ASK_USER_QUESTION_SCREEN)[0]?.label ?? "";
    expect(label.length).toBeLessThanOrEqual("1 · ".length + 40);
    expect(label.endsWith("…")).toBe(true);
  });

  it("wins over the generic heuristics inside detectTerminalPrompts", () => {
    const out = detectTerminalPrompts(ASK_USER_QUESTION_SCREEN);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n", "4\n", "5\n"]);
  });

  it("returns nothing without the picker footer", () => {
    const noFooter = ASK_USER_QUESTION_SCREEN.replace(/Enter to select.*$/m, "");
    expect(detectClaudeCodePicker(noFooter)).toEqual([]);
  });

  it("only parses options above the LAST footer (an answered earlier picker is stale)", () => {
    const stale = [
      "❯ 1. Old choice A",
      "  2. Old choice B",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "…answered…",
      "❯ 1. Fresh choice A",
      "  2. Fresh choice B",
      "  3. Fresh choice C",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const out = detectClaudeCodePicker(stale);
    expect(out.map((b) => b.label)).toEqual([
      "1 · Fresh choice A",
      "2 · Fresh choice B",
      "3 · Fresh choice C",
    ]);
  });

  it("survives a wrapped body line that itself looks like an option below the real run", () => {
    // Option 5's description wraps such that a line starting "2. do that" lands between the
    // last real option and the footer — it must not anchor the countdown and truncate the run.
    const wrapped = [
      "❯ 1. First",
      "  2. Second",
      "  3. Third",
      "  4. Fourth",
      "  5. Do this then",
      "2. do that",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const out = detectClaudeCodePicker(wrapped);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n", "4\n", "5\n"]);
    expect(out[4]?.label).toBe("5 · Do this then");
  });

  it("caps at 6 buttons for an oversized option list (7+ silently dropped by design)", () => {
    const big = [
      "❯ 1. a",
      "  2. b",
      "  3. c",
      "  4. d",
      "  5. e",
      "  6. f",
      "  7. g",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(detectClaudeCodePicker(big).map((b) => b.value)).toEqual([
      "1\n",
      "2\n",
      "3\n",
      "4\n",
      "5\n",
      "6\n",
    ]);
  });

  it("requires a contiguous run starting at 1 (a lone high number is not a picker)", () => {
    const junk = ["  7. not really an option", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join(
      "\n",
    );
    expect(detectClaudeCodePicker(junk)).toEqual([]);
  });
});

describe("detectTerminalPrompts", () => {
  it("detects a y/n confirmation as Approve/Deny", () => {
    const out = detectTerminalPrompts("Do you want to continue? (y/n) ");
    expect(out.map((b) => b.label)).toEqual(["Approve", "Deny"]);
    expect(out.map((b) => b.value)).toEqual(["y\n", "n\n"]);
    expect(out.every((b) => b.kind === "terminal" && b.source === "heuristic")).toBe(true);
  });

  it("detects [Y/n] default-yes prompts", () => {
    const out = detectTerminalPrompts("Overwrite file? [Y/n]");
    expect(out.map((b) => b.label)).toEqual(["Approve", "Deny"]);
  });

  it("detects a numbered menu and emits one button per option (max 3)", () => {
    const menu = [
      "Select an option:",
      "  1) Keep current",
      "  2) Use incoming",
      "  3) Merge both",
      "Enter your choice: ",
    ].join("\n");
    const out = detectTerminalPrompts(menu);
    expect(out.map((b) => b.label)).toEqual(["1", "2", "3"]);
    expect(out.map((b) => b.value)).toEqual(["1\n", "2\n", "3\n"]);
  });

  it("caps a longer numbered menu at the first 3 options", () => {
    const menu = "1. a\n2. b\n3. c\n4. d\n5. e\n? ";
    expect(detectTerminalPrompts(menu).map((b) => b.label)).toEqual(["1", "2", "3"]);
  });

  it("returns nothing for ordinary output", () => {
    expect(detectTerminalPrompts("Compiling... done in 4.2s\n$ ")).toEqual([]);
  });

  it("only considers the tail, not stale earlier prompts", () => {
    const txt = "Continue? (y/n)\n" + "build log line\n".repeat(80) + "All done.\n$ ";
    expect(detectTerminalPrompts(txt)).toEqual([]);
  });

  it("does NOT treat a numbered changelog ending in a header colon as a menu", () => {
    const log = ["Changes:", "  1. Fixed foo", "  2. Added bar", "Results:"].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("ignores a single numbered option (needs >= 2)", () => {
    expect(detectTerminalPrompts("1) only one\nEnter your choice: ")).toEqual([]);
  });

  it("ignores scattered / non-1-based option numbers", () => {
    const log = ["7) seven", "9) nine", "Pick one: "].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("ignores duplicate option numbers (non-contiguous run)", () => {
    const log = ["1) retry attempt", "1) retry attempt", "? "].join("\n");
    expect(detectTerminalPrompts(log)).toEqual([]);
  });

  it("detects a real menu even if a stray numbered line precedes it in the tail", () => {
    const txt = ["3) old log entry", "Select an option:", "  1) a", "  2) b", "Pick one: "].join("\n");
    expect(detectTerminalPrompts(txt).map((b) => b.label)).toEqual(["1", "2"]);
  });
});
