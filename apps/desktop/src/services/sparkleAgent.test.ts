// The Sparkle improvement agent's persona must BRANCH on the user's consent mode so its actual
// behavior matches what the consent banner promises (bead sparkle-4xwk.1): "always" auto-submits
// after the scrub gate, "case_by_case" never runs `gh pr create` without explicit approval, and
// "never" is chat-only (no log dir, no log-review instructions at all).
import { describe, expect, it } from "vitest";
import {
  sparklePersona,
  sparkleMissionPrompt,
  sparkleChatOnlyMissionPrompt,
} from "./sparkleAgent";

const LOG_DIR = "/app-data/logs/sparkle";
const REPO = "/app-data/";

describe("sparklePersona — consent branching", () => {
  it("always: instructs auto-submit via gh pr create with no per-PR approval", () => {
    const p = sparklePersona(LOG_DIR, REPO, "always");
    expect(p).toContain(LOG_DIR);
    expect(p).toContain("gh pr create");
    expect(p).toContain("submit automatically");
    expect(p).toContain("no per-PR approval is needed");
  });

  it("case_by_case: forbids unapproved gh pr create and requires present-then-STOP", () => {
    const p = sparklePersona(LOG_DIR, REPO, "case_by_case");
    expect(p).toContain(LOG_DIR);
    expect(p).toContain("MUST NOT submit a PR on your own");
    expect(p).toContain("NEVER run");
    expect(p).toContain("`gh pr create` (or `gh pr edit` / `gh pr reopen`)");
    expect(p).toContain("explicitly");
    expect(p).toContain("PRESENT the draft");
    expect(p).toContain("STOP");
  });

  it("never: omits the log dir and every log-review instruction (chat-only)", () => {
    const p = sparklePersona(LOG_DIR, REPO, "never");
    expect(p).not.toContain(LOG_DIR);
    expect(p).not.toContain("session logs are available");
    expect(p).not.toContain("Review the logs");
    expect(p).not.toContain("Treat the logs as sensitive");
    expect(p).toContain("CHAT-ONLY");
    // It still works on the app-owned clone and can act on user requests.
    expect(p).toContain(REPO);
  });

  it("never: user-directed PRs still require explicit approval before gh pr create", () => {
    const p = sparklePersona(LOG_DIR, REPO, "never");
    expect(p).toContain("explicit go-ahead");
    expect(p).toContain("`gh pr create`");
  });

  it.each(["always", "case_by_case", "never"] as const)(
    "%s: carries the hard scrub gate before any PR submission",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode);
      expect(p).toContain("PII SCRUB GATE");
      expect(p).toContain("scripts/sparkle-scrub.sh");
      expect(p).toContain("DO NOT SUBMIT");
      // The baseline privacy contract survives in every mode.
      expect(p).toContain("PRIVACY — THIS IS A HARD DEFAULT");
    },
  );
});

describe("mission prompts", () => {
  it("the standard mission prompt starts a log-review pass", () => {
    expect(sparkleMissionPrompt()).toContain("session logs");
  });

  it("the chat-only mission prompt introduces the agent and notes log evaluation is off", () => {
    const p = sparkleChatOnlyMissionPrompt();
    expect(p).toContain("Introduce yourself");
    expect(p).toContain("log evaluation");
    expect(p).not.toContain("skim");
  });
});
