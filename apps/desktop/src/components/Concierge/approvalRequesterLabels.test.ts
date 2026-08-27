// The card's "Asked by" line has ONE job: two DIFFERENT callers must never read the same.
//
// The obvious implementation — map `requestedBy` to the agent's name — fails that on real data,
// which is why this resolver exists. `defaultAgentName` numbers within a single project, so every
// project mints its own "Build 1", while the approvals ledger and the concierge column are
// app-global. A name is therefore only a discriminator once it has been checked against the other
// cards on screen (bead `sparkle-tavx1`).
import { describe, expect, it } from "vitest";

import { UNIDENTIFIED_CALLER, resolveRequesterLabels } from "./approvalRequesterLabels";
import type { ConciergeApproval } from "../../stores/conciergeApprovals";
import type { Project } from "../../types";

function approval(id: string, requestedBy: string): ConciergeApproval {
  return {
    id,
    requestedBy,
    domain: "lifecycle",
    op: "discard_agent",
    summary: "Throw the agent's work away.",
    riskClass: "irreversible",
    riskNote: "",
    args: [],
    rawArgs: {},
    configPath: "concierge.tools.discard_agent",
    fingerprint: "lifecycle.discard_agent#{}",
    requestedAt: 0,
    expiresAt: 1,
    outcome: "pending",
    resolvedAt: null,
    spent: false,
  };
}

function project(id: string, name: string, agents: Array<{ id: string; name: string }>): Project {
  return { id, name, agents } as unknown as Project;
}

describe("resolveRequesterLabels", () => {
  it("uses the plain agent name when nothing on screen collides with it", () => {
    const labels = resolveRequesterLabels(
      [approval("call-a", "agent-a")],
      [project("p1", "Kraken", [{ id: "agent-a", name: "Build 1" }])],
    );
    // The readable form wins whenever it is unambiguous — qualifying every card would put noise on
    // the common case to solve a problem it does not have.
    expect(labels["call-a"]).toBe("Build 1");
  });

  it("separates two DIFFERENT agents that share a name in different projects", () => {
    // The measured collision: `defaultAgentName` numbers per project, so "Build 1" exists in every
    // one of them, and this column shows all projects at once.
    const labels = resolveRequesterLabels(
      [approval("call-a", "agent-a"), approval("call-b", "agent-b")],
      [
        project("p1", "Kraken", [{ id: "agent-a", name: "Build 1" }]),
        project("p2", "Stripe", [{ id: "agent-b", name: "Build 1" }]),
      ],
    );
    expect(labels["call-a"]).not.toBe(labels["call-b"]);
    // PRESENT, not merely different: an assertion that only proved inequality would be satisfied by
    // two equally useless strings.
    expect(labels["call-a"]).toContain("Kraken");
    expect(labels["call-b"]).toContain("Stripe");
  });

  it("still separates them when the PROJECT name collides too", () => {
    // Two projects can share a name as easily as two agents can. The fallback has to key on
    // something that is actually unique, which is the caller's own id.
    const labels = resolveRequesterLabels(
      [approval("call-a", "agent-aaaaaa"), approval("call-b", "agent-bbbbbb")],
      [
        project("p1", "Kraken", [{ id: "agent-aaaaaa", name: "Build 1" }]),
        project("p2", "Kraken", [{ id: "agent-bbbbbb", name: "Build 1" }]),
      ],
    );
    expect(labels["call-a"]).not.toBe(labels["call-b"]);
  });

  it("separates two UNATTRIBUTED cards, which share the empty requester string", () => {
    // Two entries nobody could attribute are two callers we could not identify, not one caller
    // asking twice — and they are exactly the pair an agent-keyed map cannot tell apart at all.
    const labels = resolveRequesterLabels([approval("call-a", ""), approval("call-b", "")], []);
    expect(labels["call-a"]).not.toBe(labels["call-b"]);
    expect(labels["call-a"]).toContain(UNIDENTIFIED_CALLER);
    expect(labels["call-b"]).toContain(UNIDENTIFIED_CALLER);
  });

  it("leaves ONE caller's two questions with the same plain name", () => {
    // Not an ambiguity: the same agent asked twice, and the cards differ by what they ask. Suffixing
    // here would be noise, and would suggest two callers where there is one.
    const labels = resolveRequesterLabels(
      [approval("call-a", "agent-a"), approval("call-b", "agent-a")],
      [project("p1", "Kraken", [{ id: "agent-a", name: "Build 1" }])],
    );
    expect([labels["call-a"], labels["call-b"]]).toEqual(["Build 1", "Build 1"]);
  });

  it("falls back to the raw id for an agent that is no longer mounted", () => {
    // An agent can be torn down while its question is still on screen. The id is ugly and still
    // discriminates, which is the job.
    const labels = resolveRequesterLabels([approval("call-a", "agent-gone")], []);
    expect(labels["call-a"]).toBe("agent-gone");
  });
});
