// A PERMISSION PROMPT RAISED FOR ONE AGENT MUST NOT BE DELIVERED INTO ANOTHER'S TRANSCRIPT.
//
// ── THE REPORT (bead `sparkle-tavx1`, seen twice) ───────────────────────────────────────────────
// *"A permission prompt belonging to a different agent's window was injected into this agent's
// transcript as if it were user input… A prompt for another agent's `sparkle_fleet` call arrived
// inline with a real founder message, framed as if awaiting this agent's decision. An agent acting
// on it would have sent a message it never composed, to a peer it was not talking to."*
//
// ── WHAT THE PATH ACTUALLY IS ───────────────────────────────────────────────────────────────────
// An agent has no way to READ a prompt except by being handed one, and there is exactly one surface
// that hands one over: the `approvals` domain, reached as the `sparkle_approvals` MCP tool, whose
// reply lands in the calling agent's transcript. Its own description promises "See YOUR OWN pending
// approval requests" — and it was answered out of `stores/conciergeApprovals`, which is ONE
// app-wide array. Nothing on an entry said whose call it was, so nothing downstream could tell, and
// every caller was served every caller's questions, arguments included.
//
// ── WHY THE FIX IS AT THE DELIVERY END, NOT THE READING END ─────────────────────────────────────
// A filter applied by the reader is a rule the next reader has to remember. Instead the QUESTION
// now carries its own addressee: `requestedBy` is stamped at raise from the caller identity Rust
// mints from the socket the request arrived on, and both agent-facing reads compare against it
// (`approvalBelongsTo`, fail-closed on a blank either side). The human's column is deliberately
// untouched — there is one human, and every card is theirs to answer.
//
// ── WHAT THIS SUITE ASSERTS, AND WHY BOTH HALVES ARE HERE ───────────────────────────────────────
// Absence alone is worthless: "B cannot see it" passes trivially if the prompt went NOWHERE — the
// measured failure shape AGENTS.md warns about, an absence asserted on something never mounted. So
// every case below mounts BOTH agents, raises ONE prompt through the real production entry point,
// and asserts it is PRESENT for A in the same breath as it asserts it is ABSENT for B.
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "../../stores/authStore";
import {
  approveApproval,
  clearConciergeApprovals,
  findApproval,
  pendingApprovals,
  useConciergeApprovals,
} from "../../stores/conciergeApprovals";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { appOpPolicy, configuredToolPolicy } from "./policyBinding";
import { dispatchConciergeTool, type ConciergeToolReply } from "./registry";

/** The two agents. Both are real rows in the project store for the length of every case — see the
 *  header for why an absence assertion against an unmounted agent proves nothing. */
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

const PROJECT_ID = "proj-1";

/** The concierge's AI gate is a precondition for every tool call; opened explicitly here for the
 *  same reason `policyBinding.test.ts` opens it — this suite is about routing, not entitlement. */
function openConciergeAiGate(): void {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

/** MOUNT BOTH AGENTS. A prompt "not appearing for B" is only evidence when B is a live caller that
 *  the app can see and that really performs the read. */
function mountBothAgents(): void {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: "demo",
        rootPath: "/repos/demo",
        agents: [
          { id: AGENT_A, name: "Agent A" },
          { id: AGENT_B, name: "Agent B" },
        ],
      },
    ],
  } as never);
}

/** One `sparkle_approvals` call, exactly as the MCP surface makes it: the caller identity is a
 *  stamped field on the call, never an argument the model chose. */
function readApprovals(callerAgentId: string, op: string, args: unknown = {}) {
  return dispatchConciergeTool(
    { domain: "approvals", op, args, toolCallId: `read-${callerAgentId}-${op}`, callerAgentId },
    { policy: configuredToolPolicy },
  );
}

/** The ids `list_pending_approvals` handed this caller — i.e. what lands in its transcript. */
function listedIdsFor(reply: ConciergeToolReply): string[] {
  expect(reply.ok, `list_pending_approvals refused: ${reply.ok ? "" : reply.message}`).toBe(true);
  if (!reply.ok) return [];
  return (reply.data as Array<{ id: string }>).map((v) => v.id);
}

/**
 * Raise ONE ask-tier prompt as `callerAgentId`, through the real dispatch.
 *
 * `workspace.remove_project` is `irreversible`, so its default decision is `ask` — the dispatch
 * consults the real bound policy, whose `resolveAskTier` mints the card as a SIDE EFFECT. Driving
 * the whole dispatch rather than calling the policy directly is deliberate: the wiring from
 * `ConciergeToolCall.callerAgentId` through the policy query to the stamped entry is itself part of
 * what is under test, and a test that skipped it would pass with that wiring deleted.
 */
async function raisePromptAs(callerAgentId: string, toolCallId: string): Promise<void> {
  const reply = await dispatchConciergeTool(
    {
      domain: "workspace",
      op: "remove_project",
      args: { projectId: PROJECT_ID, confirm: true },
      toolCallId,
      callerAgentId,
    },
    { policy: configuredToolPolicy },
  );
  // The dispatch is TOTAL: an ask-tier call with nobody's approval resolves to `needs-approval`.
  // Asserting it here is the precondition, not the claim — if this ever came back `allow`, no card
  // was minted and every assertion below would be about an empty ledger.
  expect(reply.ok).toBe(false);
  if (!reply.ok) expect(reply.code).toBe("needs-approval");
  expect(pendingApprovals(useConciergeApprovals.getState().entries).map((e) => e.id)).toContain(
    toolCallId,
  );
}

beforeEach(() => {
  openConciergeAiGate();
  mountBothAgents();
  useSettingsStore.setState({ conciergeToolPolicy: {}, conciergeToolPolicyHydrated: true });
  clearConciergeApprovals();
});

describe("a prompt is addressed to the caller that raised it", () => {
  it("stamps the raising caller onto the ledger entry", async () => {
    await raisePromptAs(AGENT_A, "call-a");
    expect(findApproval("call-a")?.requestedBy).toBe(AGENT_A);
  });

  it("lists it for A and NOT for B — both agents mounted, both reading", async () => {
    await raisePromptAs(AGENT_A, "call-a");

    // PRESENT for the agent whose call it is. Without this half the next assertion would pass for a
    // prompt that reached nobody at all.
    expect(listedIdsFor(await readApprovals(AGENT_A, "list_pending_approvals"))).toEqual(["call-a"]);
    // ABSENT for the agent it was never addressed to — the delivery this bead is about.
    expect(listedIdsFor(await readApprovals(AGENT_B, "list_pending_approvals"))).toEqual([]);
  });

  it("keeps two callers' questions apart when both are pending at once", async () => {
    // NOTE both calls below are BYTE-IDENTICAL — same domain, same op, same args — and differ only
    // in who made them. That is deliberate, and it is the hardest case: `requestApproval` collapses
    // a still-pending question onto an existing card by FINGERPRINT, and a fingerprint is
    // `domain + op + args` with nothing about the caller in it. Before the requester became half
    // that key, B's call was handed A's entry outright.
    await raisePromptAs(AGENT_A, "call-a");
    await raisePromptAs(AGENT_B, "call-b");

    // Each sees exactly its own, which is stronger than "B sees nothing": a filter keyed on the
    // wrong side would empty both lists and still satisfy an absence-only assertion.
    expect(listedIdsFor(await readApprovals(AGENT_A, "list_pending_approvals"))).toEqual(["call-a"]);
    expect(listedIdsFor(await readApprovals(AGENT_B, "list_pending_approvals"))).toEqual(["call-b"]);
  });

  it("mints a SEPARATE card per caller for byte-identical calls, so one click cannot spend two", async () => {
    await raisePromptAs(AGENT_A, "call-a");
    await raisePromptAs(AGENT_B, "call-b");

    // TWO entries, not one reused. Collapsing them would gate B on a card stamped `agent-a` — which
    // B can no longer even see — and, because `claimApproval` authorises by id, would let a single
    // human click spend one grant against both agents' calls.
    const a = findApproval("call-a");
    const b = findApproval("call-b");
    expect([a?.requestedBy, b?.requestedBy]).toEqual([AGENT_A, AGENT_B]);
    // Same question, genuinely — so the collapse this defeats was not a far-fetched shape.
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it("hands A its own approval by id, and refuses B the same id", async () => {
    await raisePromptAs(AGENT_A, "call-a");

    const mine = await readApprovals(AGENT_A, "get_approval", { id: "call-a" });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect((mine.data as { id: string }).id).toBe("call-a");

    const theirs = await readApprovals(AGENT_B, "get_approval", { id: "call-a" });
    expect(theirs.ok).toBe(false);
    // Its OWN reason. Folding this into `unknown-approval` would tell a model to retry with a
    // different id, which is a different — and false — instruction.
    if (!theirs.ok) expect(theirs.code).toBe("not-your-approval");
  });

  it("does not describe the foreign call in the refusal — the refusal must not become the leak", async () => {
    await raisePromptAs(AGENT_A, "call-a");

    const theirs = await readApprovals(AGENT_B, "get_approval", { id: "call-a" });
    expect(theirs.ok).toBe(false);
    if (theirs.ok) return;
    // The raised call was `workspace.remove_project` against `proj-1`. None of that may appear.
    expect(theirs.message).not.toContain("remove_project");
    expect(theirs.message).not.toContain(PROJECT_ID);
  });

  it("still shows the human EVERY pending card — the column is not scoped, there is one human", async () => {
    await raisePromptAs(AGENT_A, "call-a");
    await raisePromptAs(AGENT_B, "call-b");

    // `pendingApprovals` is what components/Concierge/ConciergeApprovals renders. Scoping it would
    // be a regression: a card nobody can answer is worse than one addressed to somebody else.
    expect(pendingApprovals(useConciergeApprovals.getState().entries).map((e) => e.id)).toEqual([
      "call-a",
      "call-b",
    ]);
  });
});

describe("the CONTROL-OP raise path stamps its caller too", () => {
  // `concierge_tool` is concierge-only, so the entry point EVERY agent can reach is a control op
  // (`appOpPolicy` / `chiefOpPolicy`). That makes it the path most able to put one agent's question
  // in front of another, and it is wired separately — so it is asserted separately.
  it("addresses an app-op prompt to the agent whose control request raised it", async () => {
    const decision = appOpPolicy("quit_app", {
      requestId: "req-a",
      callerAgentId: AGENT_A,
      args: {},
    });
    expect(decision.tier).toBe("ask");
    expect(findApproval("req-a")?.requestedBy).toBe(AGENT_A);

    expect(listedIdsFor(await readApprovals(AGENT_A, "list_pending_approvals"))).toEqual(["req-a"]);
    expect(listedIdsFor(await readApprovals(AGENT_B, "list_pending_approvals"))).toEqual([]);
  });
});

describe("an unidentified reader and an unattributed question both fail closed", () => {
  it("serves nothing to a call that carries no caller identity", async () => {
    await raisePromptAs(AGENT_A, "call-a");

    // A dispatch that arrived without a stamped id is "nobody", and nobody owns anything. Reading
    // the whole ledger here is exactly the bug; reading none of it costs a poll.
    expect(listedIdsFor(await readApprovals("", "list_pending_approvals"))).toEqual([]);
    const byId = await readApprovals("", "get_approval", { id: "call-a" });
    expect(byId.ok).toBe(false);
    if (!byId.ok) expect(byId.code).toBe("not-your-approval");
  });

  it("serves an unattributed entry to nobody, while leaving it answerable by the human", async () => {
    // The shape a raiser that could not name its caller produces. It must not become everyone's.
    await raisePromptAs(AGENT_A, "call-a");
    useConciergeApprovals
      .getState()
      .replace(
        useConciergeApprovals.getState().entries.map((e) => ({ ...e, requestedBy: "" })),
      );

    expect(listedIdsFor(await readApprovals(AGENT_A, "list_pending_approvals"))).toEqual([]);
    expect(listedIdsFor(await readApprovals(AGENT_B, "list_pending_approvals"))).toEqual([]);
    // …and the human can still press it, which is what makes fail-closed cheap here.
    expect(pendingApprovals(useConciergeApprovals.getState().entries).map((e) => e.id)).toEqual([
      "call-a",
    ]);
  });
});

describe("the human's YES is spendable only by the caller they answered", () => {
  // THE SPENDING HALF. Scoping the READ stops one agent from seeing another's question; it does
  // nothing about the grant, and the grant is the sharper end — `claimApproval`'s identity branch
  // is the ONLY way a retry can spend one (a fresh `toolCallId` per call never matches by id), so a
  // fingerprint-only key hands agent B the authority a human gave agent A.
  //
  // Driven on the CONTROL-OP path deliberately: `conciergeApprovalResume` does not replay `app`
  // ops, so an approved entry sits unspent for the whole grant window with nothing but the
  // fingerprint guarding it. That is the widest version of the hole, not a contrived one.
  /** Ask for `app.quit_app` as `agent`, and answer the only question that matters: did the ledger
   *  AUTHORISE it? The `ask` tier is asserted rather than assumed — a decision that came back
   *  `allow` or `deny` would make every claim below a statement about nothing. */
  const grantedTo = (agent: string, reqId: string): boolean => {
    const d = appOpPolicy("quit_app", { requestId: reqId, callerAgentId: agent, args: {} });
    expect(d.tier).toBe("ask");
    return d.tier === "ask" && d.approvedByUser === true;
  };

  it("refuses agent B the grant the human gave agent A, and leaves it for A", async () => {
    expect(grantedTo(AGENT_A, "req-a")).toBe(false);
    expect(approveApproval("req-a")).toBe(true);

    // Byte-identical call — same domain, same op, same args — from the other agent.
    expect(grantedTo(AGENT_B, "req-b")).toBe(false);
    // PRESENT for the agent it was given to, in the same breath: an assertion that only proved B
    // was refused would pass just as well if approving had granted nothing at all.
    expect(findApproval("req-a")?.spent).toBe(false);
    expect(grantedTo(AGENT_A, "req-a-retry")).toBe(true);
    expect(findApproval("req-a")?.spent).toBe(true);

    // And B's own refused call is on the human's screen as B's question, not silently dropped.
    expect(findApproval("req-b")?.requestedBy).toBe(AGENT_B);
    // B still cannot read A's card by id — the read half, unchanged by any of this.
    const theirs = await readApprovals(AGENT_B, "get_approval", { id: "req-a" });
    expect(theirs.ok).toBe(false);
  });
});
