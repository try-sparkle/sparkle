import { describe, it, expect } from "vitest";
import {
  MERGED_BUT_STRANDED_TOKEN,
  isMergedButStrandedReport,
} from "./mergedButStranded";
import { STRANDED_REPORT } from "./mergedButStranded.fixture";


describe("isMergedButStrandedReport", () => {
  it("recognises Rust's post-merge report", () => {
    expect(isMergedButStrandedReport(STRANDED_REPORT)).toBe(true);
    // Rust errors reach the consumers as bare strings as often as Errors, and leading whitespace
    // survives a few of the paths in between.
    expect(isMergedButStrandedReport(`\n  ${STRANDED_REPORT}`)).toBe(true);
  });

  // ── THE EXPENSIVE DIRECTION ──────────────────────────────────────────────────────────────────
  // A false positive here reports a merge that NEVER HAPPENED as one that did: the concierge stops
  // retrying and the PR menu clears the row's refusal ledger. Every one of these is a genuine
  // refusal or failure — nothing merged — so each must stay false.
  it("does not fire on any error where the repository did NOT move", () => {
    for (const msg of [
      "Pull request is not mergeable",
      "GraphQL: Required status checks have not passed",
      "GraphQL: Head branch was modified. Review and try the merge again.",
      "PR #7 still carries 1 unanswered knightwatch [blocking] probe.",
      "Refusing merge_pr: the base is a peer agent's in-flight branch (sparkle-hvenv2)",
      "gh: command not found",
      "",
      // The words, without the token: prose that merely TALKS about a stranded merge — a log line
      // quoting one, an error that forwards it — is not Rust declaring one.
      "merge failed; see the MERGED-BUT-STRANDED report from the previous run",
      "the merge SUCCEEDED but the branch tip was not merged",
    ])
      expect(isMergedButStrandedReport(msg), msg).toBe(false);
  });

  it("keys on the leading token, which is Rust's wire contract", () => {
    expect(STRANDED_REPORT.startsWith(MERGED_BUT_STRANDED_TOKEN)).toBe(true);
    // Pinned literally: `worktree.rs::stranded_after_merge_report` writes this string and its own
    // test asserts the same prefix. Renaming one side alone silently un-wires both consumers.
    expect(MERGED_BUT_STRANDED_TOKEN).toBe("MERGED-BUT-STRANDED:");
  });
});
