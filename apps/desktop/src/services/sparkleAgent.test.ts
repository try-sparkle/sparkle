// The Sparkle improvement agent's persona must BRANCH on the user's consent mode so its actual
// behavior matches what the consent banner promises (bead sparkle-4xwk.1): "always" auto-submits
// after the scrub gate, "case_by_case" never runs `gh pr create` without explicit approval, and
// "never" is chat-only (no log dir, no log-review instructions at all).
import { describe, expect, it } from "vitest";
import {
  sparklePersona,
  sparkleMissionPrompt,
  sparkleChatOnlyMissionPrompt,
  sparkleAgentIdFor,
  sparkleOpenSetWhitelist,
  SPARKLE_AGENT_ID,
} from "./sparkleAgent";

describe("sparkleOpenSetWhitelist — cross-window open-set reconcile", () => {
  const MAIN = SPARKLE_AGENT_ID;
  const WIN_A = `${SPARKLE_AGENT_ID}-win-aaaa`;
  const WIN_B = `${SPARKLE_AGENT_ID}-win-bbbb`;

  it("a SECONDARY window preserves every open Sparkle id (never evicts another window's live pane)", () => {
    // Window A boots while the main window AND window B are live — their ids must survive reconcile.
    const kept = sparkleOpenSetWhitelist({
      isMainWindow: false,
      ownId: WIN_A,
      openIds: ["proj-agent-1", MAIN, WIN_B],
    });
    expect(kept).toContain(MAIN); // main window's live pane not evicted
    expect(kept).toContain(WIN_B); // window B's live pane not evicted
    expect(kept).toContain(WIN_A); // own id, even if not yet in the set
    expect(kept).not.toContain("proj-agent-1"); // only Sparkle-namespace ids
  });

  it("own id is included even when absent from the open set (first open)", () => {
    expect(sparkleOpenSetWhitelist({ isMainWindow: false, ownId: WIN_A, openIds: [] })).toEqual([WIN_A]);
  });

  it("the MAIN window's cold boot prunes DEAD secondary ids (only its canonical id survives)", () => {
    // At cold start only the main window is live (multi-window restore deferred), so leftover
    // per-window ids from last session are dead and must be dropped to avoid unbounded growth.
    const kept = sparkleOpenSetWhitelist({
      isMainWindow: true,
      ownId: MAIN,
      openIds: [MAIN, WIN_A, WIN_B],
    });
    expect(kept).toEqual([MAIN]);
    expect(kept).not.toContain(WIN_A);
    expect(kept).not.toContain(WIN_B);
  });
});

describe("sparkleAgentIdFor — per-window identity", () => {
  it("main window uses the canonical id (shared with the hourly pass)", () => {
    expect(sparkleAgentIdFor("main")).toBe(SPARKLE_AGENT_ID);
  });

  it("a secondary window gets a distinct id derived from its label", () => {
    const id = sparkleAgentIdFor("win-abc123");
    expect(id).toBe(`${SPARKLE_AGENT_ID}-win-abc123`);
    expect(id).not.toBe(SPARKLE_AGENT_ID);
  });

  it("distinct windows get distinct ids (so distinct worktrees)", () => {
    expect(sparkleAgentIdFor("win-a")).not.toBe(sparkleAgentIdFor("win-b"));
  });

  it("every id satisfies the Rust worktree validate_id allowlist [A-Za-z0-9_-]", () => {
    // The id is joined into a filesystem path and a git branch name; anything outside this set is
    // rejected by validate_id in worktree.rs. Real labels are "main" / "win-<uuid>".
    for (const label of ["main", "win-01234567-89ab-cdef-0123-456789abcdef"]) {
      expect(sparkleAgentIdFor(label)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sparkleAgentIdFor(label).length).toBeLessThanOrEqual(128);
    }
  });
});

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
