// The pending-approval ledger. Every test here is about ONE property: `claimApproval` returns
// `true` only where a human pressed a button, and returns `false` on every ambiguous path.
import { beforeEach, describe, expect, it } from "vitest";

import {
  APPROVAL_GRANT_TTL_MS,
  APPROVAL_REQUEST_TTL_MS,
  ARG_VALUE_MAX_CHARS,
  MAX_RETAINED_APPROVALS,
  approvalFingerprint,
  approveApproval,
  claimApproval,
  clearConciergeApprovals,
  denyApproval,
  describeApprovalArgs,
  findApproval,
  pendingApprovals,
  requestApproval,
  useConciergeApprovals,
  type ConciergeApprovalRequest,
} from "./conciergeApprovals";

const T0 = 1_000_000;

function ask(
  id: string,
  overrides: Partial<ConciergeApprovalRequest> = {},
  now = T0,
): ConciergeApprovalRequest {
  const domain = overrides.domain ?? "lifecycle";
  const op = overrides.op ?? "discard_agent";
  const req: ConciergeApprovalRequest = {
    id,
    domain,
    op,
    summary: "Throw the agent's work away.",
    riskClass: "irreversible",
    riskNote: "Permanently destroys something that cannot be recovered.",
    args: [{ key: "agentId", value: "a1" }],
    configPath: `concierge.tools.${op}`,
    fingerprint: approvalFingerprint(domain, op, { agentId: "a1" }),
    ...overrides,
  };
  requestApproval(req, now);
  return req;
}

beforeEach(() => clearConciergeApprovals());

describe("conciergeApprovals — the ledger that makes `ask` mean something", () => {
  it("records a pending question and shows it to the human", () => {
    const req = ask("call-1");
    const pending = pendingApprovals(useConciergeApprovals.getState().entries, T0);
    expect(pending.map((e) => e.id)).toEqual(["call-1"]);
    expect(pending[0]!.op).toBe("discard_agent");
    expect(pending[0]!.configPath).toBe("concierge.tools.discard_agent");
    expect(pending[0]!.fingerprint).toBe(req.fingerprint);
  });

  it("does not grant anything until a human approves", () => {
    const req = ask("call-1");
    // Merely having been ASKED is not permission — this is the whole point of the ask tier.
    expect(claimApproval("call-1", req.fingerprint, T0)).toBe(false);
    expect(approveApproval("call-1", T0 + 1)).toBe(true);
    expect(claimApproval("call-1", req.fingerprint, T0 + 2)).toBe(true);
  });

  it("spends an approval EXACTLY once", () => {
    const req = ask("call-1");
    approveApproval("call-1", T0 + 1);
    expect(claimApproval("call-1", req.fingerprint, T0 + 2)).toBe(true);
    // "Approve this discard" must never become "may always discard".
    expect(claimApproval("call-1", req.fingerprint, T0 + 3)).toBe(false);
    expect(findApproval("call-1")?.spent).toBe(true);
  });

  // THE RETRY. `toolCallId` is minted fresh per call by the MCP server, so the turn that retries
  // carries a DIFFERENT id — an id-only ledger could never honour an approval at all.
  describe("surviving into the next turn", () => {
    it("lets a retry of the SAME call spend the approval under a new toolCallId", () => {
      const req = ask("call-1");
      approveApproval("call-1", T0 + 1);
      expect(claimApproval("call-2-fresh-uuid", req.fingerprint, T0 + 2)).toBe(true);
      expect(findApproval("call-1")?.spent).toBe(true);
    });

    it("refuses a retry that changed the arguments", () => {
      ask("call-1");
      approveApproval("call-1", T0 + 1);
      // Approved: discard agent a1. Asked for: discard agent a2. Not the same thing.
      const other = approvalFingerprint("lifecycle", "discard_agent", { agentId: "a2" });
      expect(claimApproval("call-2", other, T0 + 2)).toBe(false);
    });

    it("refuses a retry of a DIFFERENT op", () => {
      ask("call-1");
      approveApproval("call-1", T0 + 1);
      const other = approvalFingerprint("lifecycle", "ship_agent", { agentId: "a1" });
      expect(claimApproval("call-2", other, T0 + 2)).toBe(false);
    });

    it("spends only ONE grant when two identical calls were approved", () => {
      const req = ask("call-1");
      ask("call-2");
      approveApproval("call-1", T0 + 1);
      approveApproval("call-2", T0 + 1);
      expect(claimApproval("retry-a", req.fingerprint, T0 + 2)).toBe(true);
      expect(findApproval("call-1")?.spent).toBe(true);
      expect(findApproval("call-2")?.spent).toBe(false);
    });
  });

  describe("fails CLOSED on every ambiguous path", () => {
    it("an UNKNOWN toolCallId with no matching grant", () => {
      expect(claimApproval("never-seen", "lifecycle.discard_agent#{}", T0)).toBe(false);
    });

    it("a BLANK toolCallId with no matching grant", () => {
      expect(claimApproval("", "lifecycle.discard_agent#{}", T0)).toBe(false);
      expect(claimApproval("   ", "lifecycle.discard_agent#{}", T0)).toBe(false);
    });

    it("a blank id cannot even be REGISTERED — there is nothing to attribute it to", () => {
      expect(requestApproval({ ...ask("x"), id: "" }, T0)).toBeNull();
      expect(requestApproval({ ...ask("y"), id: "  " }, T0)).toBeNull();
    });

    it("a DENIED entry, by id and by identity", () => {
      const req = ask("call-1");
      expect(denyApproval("call-1", T0 + 1)).toBe(true);
      expect(claimApproval("call-1", req.fingerprint, T0 + 2)).toBe(false);
      // And the retry must not route around the "no" via the identity path.
      expect(claimApproval("call-2", req.fingerprint, T0 + 2)).toBe(false);
    });

    it("a denied entry can never later be approved", () => {
      ask("call-1");
      denyApproval("call-1", T0 + 1);
      expect(approveApproval("call-1", T0 + 2)).toBe(false);
      expect(findApproval("call-1")?.outcome).toBe("denied");
    });

    it("a PENDING entry for this exact id (the human has not answered yet)", () => {
      const req = ask("call-1");
      expect(claimApproval("call-1", req.fingerprint, T0 + 5)).toBe(false);
    });

    it("an EXPIRED request — the question lapsed unanswered", () => {
      const req = ask("call-1");
      const late = T0 + APPROVAL_REQUEST_TTL_MS + 1;
      expect(approveApproval("call-1", late)).toBe(false);
      expect(claimApproval("call-1", req.fingerprint, late)).toBe(false);
      expect(findApproval("call-1")?.outcome).toBe("expired");
      expect(pendingApprovals(useConciergeApprovals.getState().entries, late)).toEqual([]);
    });

    it("an EXPIRED grant — approved, but nobody came back for it", () => {
      const req = ask("call-1");
      approveApproval("call-1", T0 + 1);
      const late = T0 + 1 + APPROVAL_GRANT_TTL_MS + 1;
      expect(claimApproval("call-1", req.fingerprint, late)).toBe(false);
      expect(claimApproval("retry", req.fingerprint, late)).toBe(false);
    });

    it("an ALREADY-USED grant, claimed by identity the second time", () => {
      const req = ask("call-1");
      approveApproval("call-1", T0 + 1);
      expect(claimApproval("call-1", req.fingerprint, T0 + 2)).toBe(true);
      expect(claimApproval("retry", req.fingerprint, T0 + 3)).toBe(false);
    });

    it("re-asking about a resolved id NEVER resets it back to pending", () => {
      const req = ask("call-1");
      denyApproval("call-1", T0 + 1);
      // A model that simply calls again with the same id must not erase the human's "no".
      requestApproval(req, T0 + 2);
      expect(findApproval("call-1")?.outcome).toBe("denied");
      expect(pendingApprovals(useConciergeApprovals.getState().entries, T0 + 2)).toEqual([]);
    });

    it("re-asking about a pending id does not duplicate the prompt", () => {
      const req = ask("call-1");
      requestApproval(req, T0 + 1);
      requestApproval(req, T0 + 2);
      expect(pendingApprovals(useConciergeApprovals.getState().entries, T0 + 3)).toHaveLength(1);
    });
  });

  it("keeps the ledger bounded, evicting resolved entries before pending ones", () => {
    for (let i = 0; i < MAX_RETAINED_APPROVALS; i += 1) {
      ask(`resolved-${i}`, { fingerprint: `f-${i}` }, T0 + i);
      denyApproval(`resolved-${i}`, T0 + i);
    }
    ask("still-pending", { fingerprint: "f-pending" }, T0 + MAX_RETAINED_APPROVALS);
    const entries = useConciergeApprovals.getState().entries;
    expect(entries.length).toBeLessThanOrEqual(MAX_RETAINED_APPROVALS);
    expect(entries.some((e) => e.id === "still-pending")).toBe(true);
  });

  describe("fingerprints", () => {
    it("ignores the order a model happened to write the keys in", () => {
      expect(approvalFingerprint("workflow", "merge_pr", { projectId: "p", number: 7 })).toBe(
        approvalFingerprint("workflow", "merge_pr", { number: 7, projectId: "p" }),
      );
    });

    it("treats absent arguments and `{}` as the same call", () => {
      expect(approvalFingerprint("workspace", "quit_app", undefined)).toBe(
        approvalFingerprint("workspace", "quit_app", {}),
      );
    });

    it("keeps a confirmed call distinct from an unconfirmed one", () => {
      expect(approvalFingerprint("workspace", "quit_app", {})).not.toBe(
        approvalFingerprint("workspace", "quit_app", { confirm: true }),
      );
    });

    it("separates the same op name in different domains", () => {
      expect(approvalFingerprint("app", "set_config", {})).not.toBe(
        approvalFingerprint("workspace", "set_config", {}),
      );
    });
  });

  describe("display-safe arguments", () => {
    it("renders one line per argument", () => {
      expect(describeApprovalArgs({ agentId: "a1", confirm: true })).toEqual([
        { key: "agentId", value: "a1" },
        { key: "confirm", value: "true" },
      ]);
    });

    it("truncates a value long enough to swamp the card", () => {
      const line = describeApprovalArgs({ text: "x".repeat(5000) })[0]!;
      expect(line.value.length).toBe(ARG_VALUE_MAX_CHARS);
      expect(line.value.endsWith("…")).toBe(true);
    });

    it("redacts anything that names itself a credential", () => {
      expect(describeApprovalArgs({ apiKey: "sk-live-123", token: "t" })).toEqual([
        { key: "apiKey", value: "••••••" },
        { key: "token", value: "••••••" },
      ]);
    });

    it("survives the shapes a model can actually send", () => {
      expect(describeApprovalArgs(undefined)).toEqual([]);
      expect(describeApprovalArgs(null)).toEqual([]);
      expect(describeApprovalArgs("just a string")).toEqual([
        { key: "arguments", value: "just a string" },
      ]);
      expect(describeApprovalArgs([1, 2])).toEqual([{ key: "arguments", value: "[1,2]" }]);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(describeApprovalArgs(cyclic)).toEqual([{ key: "self", value: "(unreadable)" }]);
    });

    it("shows a nested object rather than [object Object]", () => {
      expect(describeApprovalArgs({ intent: { confirm: "TOKEN" } })).toEqual([
        { key: "intent", value: '{"confirm":"TOKEN"}' },
      ]);
    });
  });
});
