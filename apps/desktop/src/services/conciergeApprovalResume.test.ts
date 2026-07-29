// The claim under test: approving a call RUNS it, from the arguments the human was shown.
//
// The bug this covers is one of omission, so the tests that matter are the ones that would have
// passed vacuously before: that a dispatch happens at all, that its arguments are the LEDGER's and
// not the model's, and that a long free-text argument — the case the fingerprint retry could never
// satisfy — goes through byte-for-byte.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeResumeOutcome,
  isReplayable,
  resumeApprovedCall,
  type ApprovalResumeDeps,
} from "./conciergeApprovalResume";
import {
  approvalFingerprint,
  approveApproval,
  clearConciergeApprovals,
  requestApproval,
  type ConciergeApproval,
} from "../stores/conciergeApprovals";

/** A brief of the kind that broke the old path: far past the card's 220-char display cap, and not
 *  something a model reproduces byte-identically on a later turn. */
const LONG_BRIEF = [
  "A freshly spawned agent with no brief and an empty prompt currently reports status: blocked,",
  "needsYou: true immediately, so it shows red and pushes a 'Needs you' notification. That's wrong",
  "— it has never asked the human anything. Add a distinct state for 'spawned, never briefed' that",
  "renders neutral (gray), not red, and does not raise a needs-you notification.",
].join(" ");

function ledgerEntry(over: Partial<ConciergeApproval> = {}): ConciergeApproval {
  const domain = over.domain ?? "terminal";
  const op = over.op ?? "send_to_agent_terminal";
  const rawArgs = "rawArgs" in over ? over.rawArgs : { agentId: "a1", text: LONG_BRIEF };
  return {
    id: "call-1",
    domain,
    op,
    summary: "Type a message into an agent's terminal, as if you had typed it.",
    riskClass: "disruptive",
    riskNote: "",
    args: [],
    rawArgs,
    configPath: `concierge.tools.${op}`,
    fingerprint: approvalFingerprint(domain, op, rawArgs),
    requestedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    outcome: "approved",
    resolvedAt: 0,
    spent: false,
    ...over,
  } as ConciergeApproval;
}

function fakeDeps(reply: unknown = { ok: true, domain: "terminal", op: "send_to_agent_terminal", data: {} }) {
  const dispatch = vi.fn(async () => reply as never);
  return { deps: { dispatch, policy: () => ({ tier: "allow" as const }) } as ApprovalResumeDeps, dispatch };
}

beforeEach(() => clearConciergeApprovals());

describe("resumeApprovedCall — approving is what runs the call", () => {
  it("DISPATCHES the approved call (the whole bug: it used to do nothing at all)", async () => {
    const { deps, dispatch } = fakeDeps();
    const outcome = await resumeApprovedCall(ledgerEntry(), deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "ran",
      reply: { ok: true, domain: "terminal", op: "send_to_agent_terminal", data: {} },
    });
  });

  it("replays the LEDGER's raw arguments verbatim, including a long free-text brief", async () => {
    const { deps, dispatch } = fakeDeps();
    await resumeApprovedCall(ledgerEntry(), deps);

    const [call] = dispatch.mock.calls[0] as unknown as [
      { domain: string; op: string; args: unknown; toolCallId: string },
    ];
    expect(call.domain).toBe("terminal");
    expect(call.op).toBe("send_to_agent_terminal");
    // The exact text the human read — not a paraphrase the model had to retype. This is the case
    // the fingerprint-matched retry could never satisfy.
    expect(call.args).toEqual({ agentId: "a1", text: LONG_BRIEF });
    expect((call.args as { text: string }).text.length).toBeGreaterThan(220);
  });

  it("reuses the SAME toolCallId, so the ledger authorises it by claim-by-id", async () => {
    const { deps, dispatch } = fakeDeps();
    await resumeApprovedCall(ledgerEntry({ id: "mcp-minted-42" }), deps);

    const [call] = dispatch.mock.calls[0] as unknown as [{ toolCallId: string }];
    expect(call.toolCallId).toBe("mcp-minted-42");
  });

  it("passes the real policy through, so the replay is gated exactly as a retry would be", async () => {
    const { deps, dispatch } = fakeDeps();
    await resumeApprovedCall(ledgerEntry(), deps);

    const [, opts] = dispatch.mock.calls[0] as unknown as [unknown, { policy: unknown }];
    expect(opts.policy).toBe(deps.policy);
  });

  it("reports a lapsed grant as unauthorized rather than as 'needs approval'", async () => {
    // The ledger refusing the replay means the window closed between click and dispatch. Telling
    // someone who just clicked Approve that it 'needs approval' would be nonsense.
    const { deps } = fakeDeps({
      ok: false,
      domain: "terminal",
      op: "send_to_agent_terminal",
      code: "needs-approval",
      message: "needs your go-ahead",
    });
    expect(await resumeApprovedCall(ledgerEntry(), deps)).toEqual({ kind: "unauthorized" });
  });

  it("surfaces the tool's OWN refusal instead of swallowing it", async () => {
    // Approved, dispatched, and then declined by the domain's own guards. The human authorised
    // something and is owed the truth about whether it happened.
    const reply = {
      ok: false,
      domain: "terminal",
      op: "send_to_agent_terminal",
      code: "unknown-agent",
      message: "That agent is gone.",
    };
    const { deps } = fakeDeps(reply);
    expect(await resumeApprovedCall(ledgerEntry(), deps)).toEqual({ kind: "ran", reply });
  });

  it("never throws out of a click handler", async () => {
    const deps = {
      dispatch: vi.fn(async () => {
        throw new Error("boom");
      }),
      policy: () => ({ tier: "allow" as const }),
    } as unknown as ApprovalResumeDeps;
    expect(await resumeApprovedCall(ledgerEntry(), deps)).toEqual({ kind: "unauthorized" });
  });

  it("does not replay an `app`-domain op — it has no registry dispatch to resume", async () => {
    const { deps, dispatch } = fakeDeps();
    const outcome = await resumeApprovedCall(ledgerEntry({ domain: "app", op: "set_config" }), deps);

    expect(outcome).toEqual({ kind: "not-replayable" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("classifies which domains can be replayed", () => {
    for (const domain of ["lifecycle", "terminal", "workflow", "workspace"]) {
      expect(isReplayable({ domain })).toBe(true);
    }
    expect(isReplayable({ domain: "app" })).toBe(false);
    expect(isReplayable({ domain: "" })).toBe(false);
  });
});

describe("the ledger retains raw arguments at all", () => {
  it("keeps the exact args, not the display-safe rendering", () => {
    // The display lines are truncated at 220 chars and mask secret-ish keys, so they are lossy by
    // construction. Replaying from them would send a clipped brief.
    const rawArgs = { agentId: "a1", text: LONG_BRIEF };
    const entry = requestApproval({
      id: "call-1",
      domain: "terminal",
      op: "send_to_agent_terminal",
      summary: "",
      riskClass: "disruptive",
      riskNote: "",
      args: [{ key: "text", value: `${LONG_BRIEF.slice(0, 219)}…` }],
      rawArgs,
      configPath: "concierge.tools.send_to_agent_terminal",
      fingerprint: approvalFingerprint("terminal", "send_to_agent_terminal", rawArgs),
    });
    expect(entry?.rawArgs).toEqual(rawArgs);
    expect(approveApproval("call-1")).toBe(true);
  });
});

describe("describeResumeOutcome — the receipt the thread shows", () => {
  const at = { domain: "terminal", op: "send_to_agent_terminal" };

  it("says plainly that it ran", () => {
    expect(
      describeResumeOutcome(at, { kind: "ran", reply: { ok: true, domain: "t", op: "o", data: 1 } }),
    ).toBe("Approved and ran terminal.send_to_agent_terminal.");
  });

  it("names the tool's refusal", () => {
    const text = describeResumeOutcome(at, {
      kind: "ran",
      reply: { ok: false, domain: "t", op: "o", code: "unknown-agent", message: "That agent is gone." },
    });
    expect(text).toContain("didn't run");
    expect(text).toContain("That agent is gone.");
  });

  it("admits a lapsed approval instead of implying success", () => {
    expect(describeResumeOutcome(at, { kind: "unauthorized" })).toContain("lapsed");
  });

  it("tells the human what is still needed for a non-replayable op", () => {
    expect(describeResumeOutcome({ domain: "app", op: "set_config" }, { kind: "not-replayable" })).toBe(
      "Approved app.set_config. Tell me to go ahead and I'll run it.",
    );
  });
});
