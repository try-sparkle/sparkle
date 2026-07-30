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
import {
  setConciergeChat,
  useConciergeThreadStore,
  clearConciergeThread,
} from "../stores/conciergeThreadStore";
import {
  getConciergeSessionId,
  setConciergeSessionId,
  _resetConciergeForTests,
} from "./concierge";
import type { ConciergeMessage } from "../components/Concierge/types";

const NOW = 1_700_000_000_000;

/** The `localStorage` key `conciergeThreadStore`'s `persist` writes under. Spelled out rather than
 *  imported because the DURABLE copy is the thing under test: reading the literal key is what a
 *  fresh page load does, and a test that imported the name would follow a rename that broke it. */
const THREAD_STORAGE_KEY = "sparkle-concierge-thread";

function you(id: string, text: string): ConciergeMessage {
  return { id, kind: "you", text };
}
function sparkle(id: string, text: string): ConciergeMessage {
  return { id, kind: "sparkle", text };
}

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

/** Put something in every per-human store, the way the previous human's session would have. */
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
  setConciergeChat([
    you("m1", "what is my bank routing number again"),
    sparkle("m2", "I found it in the note you pasted earlier."),
  ]);
  setConciergeSessionId("session-belonging-to-user-a");
}

beforeEach(() => {
  _resetConciergeAuditForTests();
  clearConciergeApprovals();
  _resetConciergeEventLogForTests();
  clearConciergeThread();
  _resetConciergeForTests();
});

describe("resetConciergeIdentityState", () => {
  it("empties every per-human concierge store", () => {
    seedOneHumansSession();
    // The seed is real, so an all-empty assertion below cannot pass vacuously.
    expect(useConciergeAudit.getState().entries.length).toBeGreaterThan(0);
    expect(useConciergeApprovals.getState().entries.length).toBeGreaterThan(0);
    expect(latestEventSeq()).toBeGreaterThan(0);
    expect(listSubscriptions().length).toBeGreaterThan(0);
    expect(useConciergeThreadStore.getState().chat.length).toBeGreaterThan(0);
    expect(getConciergeSessionId()).not.toBeNull();

    resetConciergeIdentityState();

    expect(useConciergeAudit.getState().entries).toHaveLength(0);
    expect(useConciergeApprovals.getState().entries).toHaveLength(0);
    // The log's residue is the one a reader can still reach: `sparkle_events` drains it, so a
    // `since: 0` read after the next sign-in is the actual leak path.
    expect(drainEvents({ since: 0 }).events).toHaveLength(0);
    expect(listSubscriptions()).toHaveLength(0);
    expect(useConciergeThreadStore.getState().chat).toHaveLength(0);
    expect(getConciergeSessionId()).toBeNull();
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

  // THE DURABLE COPY IS THE HALF AN IN-MEMORY ASSERTION MISSES, and for this store it is the whole
  // point: the other three are process-lifetime memory, while the thread is `persist`ed to a fixed,
  // not-user-keyed `localStorage` name and replayed into the column by the store's own `merge` hook
  // on the next launch (roborev 55625). Emptying `chat` without touching the disk copy would leave
  // the previous human's conversation to come back at relaunch — the leak surviving the fix for it.
  //
  // Reading the raw key rather than the store is deliberate: this is what a fresh page load reads.
  it("removes the thread's DURABLE copy, not just the live one", () => {
    seedOneHumansSession();
    // `persist` writes synchronously, so the previous human's words really are on "disk" here —
    // which is what stops the null assertion below from passing vacuously.
    expect(localStorage.getItem(THREAD_STORAGE_KEY)).toContain("bank routing number");

    resetConciergeIdentityState();

    expect(localStorage.getItem(THREAD_STORAGE_KEY)).toBeNull();
  });

  // THE COLUMN AND THE BRAIN MOVE TOGETHER. Clearing the visible thread while leaving
  // `currentSessionId` pointing at the previous human's Claude session is the same leak made
  // invisible: the next human's first turn resumes a conversation they cannot see and did not have.
  // Asserted separately from the bulk case because a blank column reads as "reset" either way — only
  // the session id distinguishes a real reset from a cosmetic one.
  it("forgets the previous human's session, so the next turn cannot resume it", () => {
    setConciergeSessionId("session-belonging-to-user-a");
    expect(getConciergeSessionId()).toBe("session-belonging-to-user-a");

    resetConciergeIdentityState();

    expect(getConciergeSessionId()).toBeNull();
  });
});
