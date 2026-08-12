// @vitest-environment jsdom
//
// THE ANSWERER THAT COULD NOT REPORT (engine/blockedPromptGrace).
//
// `maybeAutoApprove` is what actually disposes of the founder's routine permission prompts, and
// before this change it had no channel to say so: its write was the TOLERANT `writePtyChained`,
// which resolves even when the PTY is dead, so ANSWERED and FAILED-TO-REACH were the same
// observation. A prompt on a dead pane therefore stayed hidden for the full 30s ceiling — the exact
// case the grace window's header calls out as common and says must surface at once.
//
// EVERY ASSERTION HERE READS THE LEDGER AFTERWARDS, never the return value on its own. The return
// values were already what they are; what is new is that something is recorded. Delete the wiring
// and each case reads `undefined`.
import { describe, it, expect, vi, beforeEach } from "vitest";

// STRICT, matching the module — the whole point is that a dead PTY now REJECTS, because a tolerant
// write gives this test nothing to distinguish.
const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

const logWarn = vi.fn();
vi.mock("../../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn() },
}));

import { maybeAutoApprove, maybeAutoResume } from "./approvalsRuntime";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../../engine/blockedPromptGrace";

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const RESUME_PROMPT = [
  "This session is 6h 54m old and 196.3k tokens.",
  "Resuming the full session will consume a substantial portion of your usage limits.",
  "❯ 1. Resume from summary (recommended)",
  "  2. Resume full session as-is",
  "  3. Don't ask me again",
  "",
  "Enter to confirm · Esc to cancel",
].join("\n");
const BASH_PROMPT = [
  "Bash command",
  "  rm -rf build/",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");
// The documented veto hole: the bash rule matches the word "command" inside the tool's OWN
// arguments, so a denied MCP tool lands in the `bash` category and a `bash = "always"` config would
// otherwise spawn a worker with no prompt.
const DENIED_TOOL_PROMPT = [
  'sparkle-orchestrator - spawn_worker(task: "run the build command")',
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");
const MCP_NARRATION_PROMPT = [
  'sparkle-control - set_agent_activity(activity: "Mapping the retro loop")',
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently",
  "",
  FOOTER,
].join("\n");

/** THE SIDE EFFECT UNDER TEST. `undefined` is the pre-change behaviour: nothing reported. */
const reported = (agentId: string): PromptAnswerOutcome | undefined =>
  windowPromptGraceLedger().outcome.get(agentId)?.outcome;

/** The write's outcome is observed on a promise the caller deliberately does not await (the
 *  keystroke stays fire-and-forget), so let its handlers run. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  resetPromptGraceLedgerForTests();
  writePty.mockReset();
  writePty.mockResolvedValue(undefined);
  logWarn.mockClear();
  aiFeatureVisibleNow.mockReturnValue(true);
  useProjectStore.setState({ projects: [] });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask" });
});

// ── THE PAIR ─────────────────────────────────────────────────────────────────────────────────────
// Identical config, identical prompt, identical entry point — only the PTY's answer differs. Assert
// just the failing side and an unconditional `notePromptAnswerOutcome(id, "unreachable")` passes.
describe("maybeAutoApprove — the keystroke's fate is reported BOTH ways", () => {
  it("a delivered auto-approve reports `handled`", async () => {
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBe("bash");
    await settle();
    expect(reported("a1")).toBe("handled");
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("…and the SAME auto-approve onto a dead PTY reports `unreachable` and warns", async () => {
    writePty.mockRejectedValueOnce(new Error("no such pty"));
    // It still returns the category — the classification was right, the pane was not there. That is
    // precisely why the return value cannot stand in for the outcome.
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBe("bash");
    await settle();
    expect(reported("a1")).toBe("unreachable");
    expect(logWarn).toHaveBeenCalledWith(
      "approvals",
      expect.stringContaining("never reached the pane"),
      expect.objectContaining({ agentId: "a1" }),
    );
  });

  it("a rejected write does not become an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    writePty.mockRejectedValueOnce(new Error("no such pty"));
    maybeAutoApprove("a1", BASH_PROMPT, new Set());
    await settle();
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

// ── THE DECLINE ARMS ─────────────────────────────────────────────────────────────────────────────
// Each of these is the answerer reading a real prompt and handing it to the human. Declining IS the
// statement that the founder decides this one, so each must surface the row immediately.
describe("maybeAutoApprove — every read-then-refuse arm reports `declined`", () => {
  it("auto-approve switched off", () => {
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });

  it("the denied-tool veto", () => {
    useSettingsStore.setState({ approvals: { bash: "always" } });
    expect(maybeAutoApprove("a1", DENIED_TOOL_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
    expect(reported("a1")).toBe("declined");
  });

  it("an MCP tool the per-tool policy will not auto-answer", () => {
    useSettingsStore.setState({ approvals: { mcp: "never" } });
    expect(maybeAutoApprove("a1", MCP_NARRATION_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });

  it("a category rule that is not 'always'", () => {
    useSettingsStore.setState({ approvals: { bash: "never" } });
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });
});

// ── THE TWO ARMS THAT MUST STAY SILENT ───────────────────────────────────────────────────────────
describe("maybeAutoApprove — what is NOT a decline", () => {
  // The load-bearing one. This function runs against whatever is on screen, so reporting here would
  // stamp `declined` on every build log and idle shell — ending the hold for whatever prompt the
  // agent draws next, i.e. switching the feature off while looking wired up.
  it("an unclassifiable screen reports nothing at all", () => {
    expect(maybeAutoApprove("a1", "Compiling... done\n$ ", new Set())).toBeNull();
    expect(reported("a1")).toBeUndefined();
  });

  // A re-hash of the same settled picker. The answer that settled it already reported; re-stating a
  // `handled` here would overwrite an `unreachable` the write may have just recorded.
  it("the already-answered early return reports nothing", async () => {
    const handled = new Set<string>();
    expect(maybeAutoApprove("a1", BASH_PROMPT, handled)).toBe("bash");
    await settle();
    resetPromptGraceLedgerForTests(); // forget the first answer's report
    expect(maybeAutoApprove("a1", BASH_PROMPT, handled)).toBe("bash");
    await settle();
    expect(writePty).toHaveBeenCalledTimes(1); // no second keystroke...
    expect(reported("a1")).toBeUndefined(); // ...and no second report
  });
});

// ── THE SIBLING PATH ─────────────────────────────────────────────────────────────────────────────
// A clean parallel: same master toggle, same signature de-dupe, same one write — so it gets the
// same treatment rather than being left as the one answerer that still cannot report.
describe("maybeAutoResume — the same channel, the same both-ways proof", () => {
  it("a delivered auto-resume reports `handled`", async () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBe("summary");
    await settle();
    expect(reported("a1")).toBe("handled");
  });

  it("…and the SAME auto-resume onto a dead PTY reports `unreachable`", async () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    writePty.mockRejectedValueOnce(new Error("no such pty"));
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBe("summary");
    await settle();
    expect(reported("a1")).toBe("unreachable");
  });

  it("a resume rule left at 'ask' reports `declined` — the user decides this one", () => {
    useSettingsStore.setState({ resumeRule: "ask" });
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });

  it("the master toggle being off reports `declined`", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });

  it("a screen that is not the resume prompt reports nothing", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    expect(maybeAutoResume("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBeUndefined();
  });
});
