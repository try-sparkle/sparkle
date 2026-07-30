// THE SEAM'S OWN TEST, which its header promised before this file existed (roborev 55593).
//
// Why that mattered enough to fix rather than to reword: the module tells its future editor that a
// newly added per-human store "is one line here and is covered by this module's test". With no such
// test, coverage was entirely indirect — two SettingsDialog cases that click Sign out — so a fourth
// clear could be added wrong and ship green, and the whole function could be gutted to `{}` with only
// those component tests catching it. A comment asserting something untrue at the highest-authority
// location is the exact defect this branch spent the day correcting.
//
// EVERY ASSERTION IS ON STORE CONTENTS, never on a spy. A spy proves the call happened; it does not
// prove the store is empty, and "the reset was invoked" is the claim that was already true of both
// stores for months while nothing called them.
import { describe, it, expect, beforeEach } from "vitest";

import { resetConciergeIdentityState } from "./conciergeIdentityReset";
import {
  noteConciergeAuditCall,
  useConciergeAudit,
  _resetConciergeAuditForTests,
} from "./conciergeAudit";
import {
  clearConciergeApprovals,
  requestApproval,
  useConciergeApprovals,
  type ConciergeApprovalRequest,
} from "../stores/conciergeApprovals";
import {
  drainEvents,
  eventLogEpoch,
  latestEventSeq,
  listSubscriptions,
  openSubscription,
  recordConciergeEvent,
  _resetConciergeEventLogForTests,
} from "../stores/conciergeEventLog";

const NOW = 1_700_000_000_000;

function approvalRequest(): ConciergeApprovalRequest {
  return {
    id: "call-1",
    domain: "workflow",
    op: "merge_pr",
    summary: "Merge a pull request.",
    riskClass: "mutates-main",
    riskNote: "Changes the branch everything else is measured against.",
    args: [],
    rawArgs: { number: 753, token: "verbatim-not-redacted" },
    configPath: "concierge.tools.merge_pr",
    fingerprint: "fp-1",
  };
}

/** Put something in all three stores, the way the previous human's session would have. */
function seedOneHumansSession(): void {
  noteConciergeAuditCall("call-1", "workspace", "add_project_from_folder", {
    path: "/Users/ada/Projects/secret-thing",
  })({ ok: true });
  requestApproval(approvalRequest(), NOW);
  recordConciergeEvent(
    { kind: "agent_status", agentId: "a", from: "working", to: "done", trigger: "quiet-settle" },
    NOW,
  );
  openSubscription([], NOW);
}

beforeEach(() => {
  _resetConciergeAuditForTests();
  clearConciergeApprovals();
  _resetConciergeEventLogForTests();
});

describe("resetConciergeIdentityState", () => {
  it("empties every per-human concierge store", () => {
    seedOneHumansSession();
    // The seed is real, so an all-empty assertion below cannot pass vacuously.
    expect(useConciergeAudit.getState().entries.length).toBeGreaterThan(0);
    expect(useConciergeApprovals.getState().entries.length).toBeGreaterThan(0);
    expect(latestEventSeq()).toBeGreaterThan(0);
    expect(listSubscriptions().length).toBeGreaterThan(0);

    resetConciergeIdentityState();

    expect(useConciergeAudit.getState().entries).toHaveLength(0);
    expect(useConciergeApprovals.getState().entries).toHaveLength(0);
    // The log's residue is the one a reader can still reach: `sparkle_events` drains it, so a
    // `since: 0` read after the next sign-in is the actual leak path.
    expect(drainEvents({ since: 0 }).events).toHaveLength(0);
    expect(listSubscriptions()).toHaveLength(0);
  });

  // THE EPOCH IS PART OF THE RESET, and this is the half a plain "the arrays are empty" assertion
  // misses. Clearing the ring without minting a new epoch leaves the previous human's cursors and
  // subscription ids resolving against the fresh log as though nothing had happened — `since: 5`
  // against a log restarted at 1 reads as continuous — which is precisely what `log-restarted` exists
  // to refuse.
  it("mints a new epoch, so the previous session's cursors are refused rather than re-based", () => {
    seedOneHumansSession();
    const before = eventLogEpoch();

    resetConciergeIdentityState();

    expect(eventLogEpoch()).not.toBe(before);
  });

  // A pending card is the actionable residue: left behind, the NEXT human answers the previous one's
  // question. Asserted separately from the bulk case because "the ledger is empty" and "no live
  // question survived" are different claims, and only the second one is about authority.
  it("leaves no PENDING approval for the next human to answer", () => {
    requestApproval(approvalRequest(), NOW);
    expect(useConciergeApprovals.getState().entries[0]!.outcome).toBe("pending");

    resetConciergeIdentityState();

    expect(useConciergeApprovals.getState().entries.filter((e) => e.outcome === "pending")).toEqual(
      [],
    );
  });
});
