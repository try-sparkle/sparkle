// @vitest-environment jsdom
//
// THE FOLDER-TRUST BACKSTOP, at the runtime layer: does `maybeAutoTrust` answer the dialog for a
// worktree Sparkle cut, REFUSE every other folder, and get the agent out of the founder's needs-you
// band when it answers?
//
// The safety case is the reason this file exists, and it is not hypothetical. The trust dialog
// already satisfies `approvalClassifier.looksLikePermission` ("Yes, I trust this folder" is a plain
// yes; "No, exit" is a plain no) and its body classifies as `bash` off the word "execute" — so with
// `bash = "always"` set, `maybeAutoApprove` presses it for ANY folder. Every refusal case below
// therefore asserts BOTH halves: that `maybeAutoTrust` declined, AND that the keystroke never went
// out even though the config would have pressed it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

vi.mock("../../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { maybeAutoTrust, maybeAutoApprove } from "./approvalsRuntime";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import { conciergeBand } from "../conciergeFeed";
import {
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  notePromptEpisodes,
  withBlockedPromptGrace,
  type PromptAnswerOutcome,
} from "../../engine/blockedPromptGrace";
import {
  FOLDER_TRUST_PROMPT,
  FOLDER_TRUST_PROMPT_REORDERED,
  FOLDER_TRUST_PROMPT_STICKY,
  BASH_PERMISSION_PROMPT,
  folderTrustPromptFor,
} from "./trustPrompt.fixture";
import type { AgentTabStatus } from "../../types";

const AGENT = "4cbc4a93-80c2-456f-9508-d64530a251cc";
const PROJECT = "ed5d0ece-8a38-4649-9f7c-0ab6203a7467";
// The real macOS shape, SPACE AND ALL — `~/Library/Application Support/ai.sparkle.desktop` is where
// `worktree_path()` actually mints these, and a path reader that stops at whitespace silently
// declines the exact case this backstop exists for.
const MANAGED = `/Users/dev/Library/Application Support/ai.sparkle.desktop/worktrees/${PROJECT}/${AGENT}`;

/** Seed the project store the way `setAgentWorktree` would have. */
function seedWorktree(worktreePath: string | null): void {
  useProjectStore.setState({
    projects: [{ id: PROJECT, rootPath: "/repo", agents: [{ id: AGENT, worktreePath }] }],
  } as never);
}

const reported = (agentId: string): PromptAnswerOutcome | undefined =>
  windowPromptGraceLedger().outcome.get(agentId)?.outcome;

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  resetPromptGraceLedgerForTests();
  writePty.mockReset();
  writePty.mockResolvedValue(undefined);
  aiFeatureVisibleNow.mockReturnValue(true);
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {}, planByRoot: {} });
  // `bash = "always"` throughout, deliberately: it is the config under which the dialog would be
  // pressed for any folder, so every refusal below is refusing something that WOULD have happened.
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask", planRule: "auto" });
  seedWorktree(MANAGED);
});

describe("maybeAutoTrust — the answer", () => {
  it("presses the ordinal carrying the trust LABEL for a Sparkle-managed worktree", async () => {
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("trusted");
    await settle();
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
    expect(reported(AGENT)).toBe("handled");
  });

  it("follows the label when the rows are REORDERED — never the ordinal", async () => {
    // Row 1 is "No, exit" here. An ordinal-matched answerer exits the agent.
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT_REORDERED, new Set())).toBe("trusted");
    await settle();
    expect(writePty).toHaveBeenCalledWith(AGENT, "2\n");
  });

  it("answers a dialog that names the managed path itself", async () => {
    expect(maybeAutoTrust(AGENT, folderTrustPromptFor(MANAGED), new Set())).toBe("trusted");
    await settle();
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  it("reports `unreachable` when the pane is gone, so the prompt surfaces at once", async () => {
    writePty.mockRejectedValueOnce(new Error("no such pty"));
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("trusted");
    await settle();
    expect(reported(AGENT)).toBe("unreachable");
  });

  it("never re-sends the keystroke for the same picker instance", async () => {
    const handled = new Set<string>();
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, handled)).toBe("trusted");
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, handled)).toBe("trusted");
    await settle();
    expect(writePty).toHaveBeenCalledTimes(1);
  });

  it("says nothing at all about a screen that is not the trust dialog", () => {
    expect(maybeAutoTrust(AGENT, BASH_PERMISSION_PROMPT, new Set())).toBeNull();
    expect(reported(AGENT)).toBeUndefined();
  });
});

// ── THE SAFETY PROPERTY ──────────────────────────────────────────────────────────────────────────
// Each case: a GENUINE, ANSWERABLE trust dialog that `maybeAutoApprove` would press under this
// config. The only thing standing in the way is the scope.
describe("maybeAutoTrust — a folder outside Sparkle's worktrees is NEVER auto-trusted", () => {
  it("refuses a dialog naming the founder's own repo, and claims it so nothing else presses it", async () => {
    const screen = folderTrustPromptFor("/Users/dev/Projects/some-random-repo");
    expect(maybeAutoTrust(AGENT, screen, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
    expect(reported(AGENT)).toBe("declined");
    // THE HALF THAT MAKES THIS A REAL ASSERTION. `bash = "always"` is set and this dialog classifies
    // as `bash`, so without the claim the very next answerer in the chain types "1" into it.
    expect(maybeAutoApprove(AGENT, screen, new Set())).toBe("bash");
    await settle();
    expect(writePty).toHaveBeenCalledWith(AGENT, "1\n");
  });

  it("refuses when the agent has no recorded worktree — fail closed, never open", async () => {
    seedWorktree(null);
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
    expect(reported(AGENT)).toBe("declined");
  });

  it("refuses when the agent is not in the project store at all", async () => {
    useProjectStore.setState({ projects: [] } as never);
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("refuses ANOTHER agent's managed worktree", async () => {
    expect(maybeAutoTrust("some-other-agent", FOLDER_TRUST_PROMPT, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("refuses a sibling directory whose name merely prefixes the worktree", async () => {
    expect(maybeAutoTrust(AGENT, folderTrustPromptFor(`${MANAGED}-scratch`), new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("refuses an affirmative that widens past this one folder", async () => {
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT_STICKY, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("declines — and still CLAIMS — when the master toggle is off", async () => {
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("asked");
    await settle();
    expect(writePty).not.toHaveBeenCalled();
    expect(reported(AGENT)).toBe("declined");
  });
});

// ── THE BAND ─────────────────────────────────────────────────────────────────────────────────────
// An agent parked on a prompt a machine is about to answer must not read as needing the human.
describe("an answered folder-trust dialog does not land in the needs-you band", () => {
  const NOW = 1_000_000;
  const agents = [{ id: AGENT }];

  /** Run one feed rebuild — episodes first, then the overlay — exactly as `useConciergeFeed` does,
   *  and report the band the founder's list would put this agent in. */
  function bandAfterRebuild(screen: string, status: AgentTabStatus, now: number): string {
    const statusMap: Record<string, AgentTabStatus> = { [AGENT]: status };
    const ledger = windowPromptGraceLedger();
    notePromptEpisodes(ledger, statusMap, () => ({ text: screen, at: now }), now, [AGENT]);
    return conciergeBand(withBlockedPromptGrace(agents, statusMap, ledger, now)[AGENT]);
  }

  it("is held out of needs_you once the keystroke lands", async () => {
    // The prompt is drawn and the feed rebuilds: the episode opens.
    expect(bandAfterRebuild(FOLDER_TRUST_PROMPT, "approval", NOW)).not.toBe("needs_you");
    expect(maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set())).toBe("trusted");
    await settle();
    expect(reported(AGENT)).toBe("handled");
    // …and it STAYS held while the answer takes effect — `handled` is deliberately not an end
    // condition, because the red clears on its own a beat later.
    expect(bandAfterRebuild(FOLDER_TRUST_PROMPT, "approval", NOW + 1_000)).not.toBe("needs_you");
  });

  // THE PAIR THAT MAKES THE ROW ABOVE MEAN SOMETHING. Same agent, same status, same rebuild — only
  // the folder differs. Without this, "not needs_you" could be true of every prompt in the app and
  // would prove nothing about the answer.
  it("…while the SAME dialog for an unmanaged folder surfaces to the founder immediately", async () => {
    const screen = folderTrustPromptFor("/Users/dev/Projects/some-random-repo");
    expect(bandAfterRebuild(screen, "approval", NOW)).not.toBe("needs_you"); // held while it is read
    expect(maybeAutoTrust(AGENT, screen, new Set())).toBe("asked");
    await settle();
    expect(reported(AGENT)).toBe("declined");
    // Declining IS the statement that the human decides this one — the hold ends at once.
    expect(bandAfterRebuild(screen, "approval", NOW + 1_000)).toBe("needs_you");
  });

  it("and an unreachable pane surfaces it too — nobody but the founder is going to answer", async () => {
    writePty.mockRejectedValueOnce(new Error("no such pty"));
    expect(bandAfterRebuild(FOLDER_TRUST_PROMPT, "approval", NOW)).not.toBe("needs_you");
    maybeAutoTrust(AGENT, FOLDER_TRUST_PROMPT, new Set());
    await settle();
    expect(reported(AGENT)).toBe("unreachable");
    expect(bandAfterRebuild(FOLDER_TRUST_PROMPT, "approval", NOW + 1_000)).toBe("needs_you");
  });
});
