// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The auto-answer executor is the one place a keystroke is emitted, so mock the PTY write + the
// feature gate and drive the real classifier + effective-rule resolution through the actual stores.
const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({ writePty: (id: string, data: string) => writePty(id, data) }));

// Auto-approve is gated on the flag-only VISIBLE read (aiFeatureVisibleNow), NOT the credit-gated
// aiFeatureNow — it spends no AI credits, so an out-of-credit user must still be unblocked.
const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

import {
  maybeAutoApprove,
  maybeAutoResume,
  effectiveResumeRule,
  pickerSignature,
} from "./approvalsRuntime";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";

const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const RESUME_FOOTER = "Enter to confirm · Esc to cancel";
const RESUME_PROMPT = [
  "This session is 6h 54m old and 196.3k tokens.",
  "Resuming the full session will consume a substantial portion of your usage limits.",
  "❯ 1. Resume from summary (recommended)",
  "  2. Resume full session as-is",
  "  3. Don't ask me again",
  "",
  RESUME_FOOTER,
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

// Same bash prompt, but the real Claude Code amend/explain footer instead of the standard one. The
// original bug: this footer wasn't recognized, so maybeAutoApprove bailed before the bash rule check.
const BASH_PROMPT_AMEND_FOOTER = [
  "Bash command",
  "  rm -rf build/",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for rm commands",
  "  3. No, and tell Claude what to do differently",
  "",
  "Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

beforeEach(() => {
  writePty.mockClear();
  aiFeatureVisibleNow.mockReturnValue(true);
  // No project in context → effectiveApprovalRule falls back to the global settings mirror.
  useProjectStore.setState({ projects: [] });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {} });
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask" });
});

describe("maybeAutoApprove", () => {
  it("auto-answers a picker instance exactly once (signature de-dupe)", () => {
    const handled = new Set<string>();
    const first = maybeAutoApprove("a1", BASH_PROMPT, handled);
    expect(first).toBe("bash");
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith("a1", "1\n"); // the plain-Yes keystroke

    // A re-rendered/settled copy of the SAME picker hashes identically → suppress buttons but never
    // re-send the keystroke.
    const second = maybeAutoApprove("a1", BASH_PROMPT, handled);
    expect(second).toBe("bash");
    expect(writePty).toHaveBeenCalledTimes(1);
  });

  it("auto-answers a bash prompt whose footer is the amend/explain variant", () => {
    const result = maybeAutoApprove("a1", BASH_PROMPT_AMEND_FOOTER, new Set());
    expect(result).toBe("bash");
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith("a1", "1\n");
  });

  it("does not auto-answer when the feature is off", () => {
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("does not auto-answer when the effective rule is 'never'", () => {
    useSettingsStore.setState({ approvals: { bash: "never" } });
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("does not auto-answer when the effective rule is unset", () => {
    useSettingsStore.setState({ approvals: {} });
    expect(maybeAutoApprove("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("does not auto-answer a non-permission prompt (fail safe)", () => {
    expect(maybeAutoApprove("a1", "Compiling... done\n$ ", new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("a different picker instance gets its own keystroke", () => {
    const handled = new Set<string>();
    maybeAutoApprove("a1", BASH_PROMPT, handled);
    expect(writePty).toHaveBeenCalledTimes(1);
    // A second, DIFFERENT bash prompt (different command → different signature) answers again.
    const other = BASH_PROMPT.replace("rm -rf build/", "git push --force");
    expect(pickerSignature(other)).toBe(pickerSignature(BASH_PROMPT)); // labels drive the sig...
    // ...so change an OPTION label to make it a genuinely distinct instance.
    const distinct = [
      "Bash command",
      "  git push --force",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for git push commands",
      "  3. No, and tell Claude what to do differently",
      "",
      FOOTER,
    ].join("\n");
    expect(pickerSignature(distinct)).not.toBe(pickerSignature(BASH_PROMPT));
    maybeAutoApprove("a1", distinct, handled);
    expect(writePty).toHaveBeenCalledTimes(2);
  });
});

describe("maybeAutoResume", () => {
  it("auto-picks the summary option when the rule is 'summary'", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBe("summary");
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith("a1", "1\n");
  });

  it("auto-picks the full-session option when the rule is 'full'", () => {
    useSettingsStore.setState({ resumeRule: "full" });
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBe("full");
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith("a1", "2\n"); // the OTHER digit
  });

  it("does not auto-resume when the rule is 'ask' (default)", () => {
    useSettingsStore.setState({ resumeRule: "ask" });
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("does not auto-resume when the master toggle is off", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("does not auto-resume a non-resume picker (fail safe)", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    // A generic permission picker is not a resume prompt → never answered by this path.
    expect(maybeAutoResume("a1", BASH_PROMPT, new Set())).toBeNull();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("answers a resume picker instance exactly once (signature de-dupe)", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    const handled = new Set<string>();
    expect(maybeAutoResume("a1", RESUME_PROMPT, handled)).toBe("summary");
    expect(writePty).toHaveBeenCalledTimes(1);
    // A re-rendered copy of the SAME prompt hashes identically → suppress but never re-send.
    expect(maybeAutoResume("a1", RESUME_PROMPT, handled)).toBe("summary");
    expect(writePty).toHaveBeenCalledTimes(1);
  });

  it("honors a per-project resume override over the global rule", () => {
    const root = "/tmp/proj";
    useProjectStore.setState({
      projects: [{ id: "p1", rootPath: root, agents: [{ id: "a1" }] }] as never,
    });
    useSettingsStore.setState({ resumeRule: "ask" }); // global says ask...
    useApprovalsStore.setState({ resumeByRoot: { [root]: "full" } }); // ...project says full
    expect(maybeAutoResume("a1", RESUME_PROMPT, new Set())).toBe("full");
    expect(writePty).toHaveBeenCalledWith("a1", "2\n");
  });
});

describe("effectiveResumeRule", () => {
  it("a project 'ask' overrides a global summary/full (the per-project opt-out)", () => {
    const root = "/tmp/proj";
    useSettingsStore.setState({ resumeRule: "summary" }); // all-projects auto-resumes...
    useApprovalsStore.setState({ resumeByRoot: { [root]: "ask" } }); // ...but this project opts out
    expect(effectiveResumeRule(root)).toBe("ask");
  });

  it("falls back to the global rule when the project has no override loaded", () => {
    useSettingsStore.setState({ resumeRule: "full" });
    useApprovalsStore.setState({ resumeByRoot: {} });
    expect(effectiveResumeRule("/tmp/proj")).toBe("full");
  });

  it("returns the global rule when there is no project in context", () => {
    useSettingsStore.setState({ resumeRule: "summary" });
    expect(effectiveResumeRule(null)).toBe("summary");
  });
});
