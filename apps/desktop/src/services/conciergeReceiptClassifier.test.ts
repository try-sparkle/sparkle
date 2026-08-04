import { describe, it, expect } from "vitest";
import {
  classifyConciergeActionReceipt,
  CONCIERGE_RECEIPT_APP_OPS,
  type ConciergeReceiptInput,
} from "./conciergeReceiptClassifier";

// Every case asserts the RECEIPT — the thing the human ends up able to check — never that the
// classifier was consulted. A test that asserted "we called the classifier" would pass against a
// classifier that returned null for everything, which is the exact silence this feature exists to
// end (AGENTS.md: "Tests must assert the SIDE EFFECT, not the precondition").

/** One settled call, with the two recorder-supplied fields filled in so each case states only what
 *  it is about. `id`/`at` are parameters rather than minted inside, which is what keeps the
 *  classifier pure — asserted directly in its own case below. */
function call(over: Partial<ConciergeReceiptInput>): ConciergeReceiptInput {
  return {
    domain: "workspace",
    op: "list_projects",
    args: {},
    ok: true,
    data: undefined,
    reason: undefined,
    id: "receipt-1",
    at: 1_700_000_000_000,
    ...over,
  };
}

describe("classifyConciergeActionReceipt", () => {
  // ── spawn: the one call whose subject does not exist until it returns ───────────────────────────
  //
  // The id is in the REPLY and nowhere else, so a classifier that read the arguments (as every other
  // op's does) would find `{ projectId }` and either name the project as the new agent or emit a
  // receipt with no id at all — a line the reader cannot click. This is the case that would silently
  // regress, so it is asserted with a positive control: the same call with the id present in the
  // ARGS and absent from the reply must NOT produce one.
  describe("a successful spawn_build_agent", () => {
    const spawned = classifyConciergeActionReceipt(
      call({
        domain: "lifecycle",
        op: "spawn_build_agent",
        args: { projectId: "p1", prompt: "build the thing" },
        ok: true,
        data: { agentId: "agent-77", projectId: "p1", provisionalName: "Kraken Auth" },
      }),
    );

    it("is a `spawned` receipt", () => {
      expect(spawned).toMatchObject({ kind: "spawned", ok: true, op: "lifecycle.spawn_build_agent" });
    });

    it("takes the agent id FROM THE REPLY DATA", () => {
      expect(spawned?.agentId).toBe("agent-77");
      expect(spawned?.agentName).toBe("Kraken Auth");
    });

    // THE CONTROL. A spawn's arguments cannot carry the new agent's id, so a classifier reading them
    // is reading the wrong side — and this is what proves the read is not merely "whichever side has
    // one". `projectId: "p1"` is present in the args of both cases; if the args were consulted, the
    // receipt below would carry an id.
    it("does NOT fall back to the arguments when the reply names no agent", () => {
      const noId = classifyConciergeActionReceipt(
        call({
          domain: "lifecycle",
          op: "spawn_build_agent",
          args: { projectId: "p1", agentId: "an-id-the-args-should-not-be-trusted-for" },
          ok: true,
          data: { projectId: "p1" },
        }),
      );
      expect(noId).toMatchObject({ kind: "spawned" });
      expect(noId?.agentId).toBeUndefined();
    });
  });

  // ── the channel distinction — bead sparkle-zm0c8 ───────────────────────────────────────────────
  //
  // A terminal write lands in the PTY now; an inbox message is queued and invisible until the
  // recipient's next turn boundary. "Sent to X" without saying which is the ambiguity the founder has
  // been burned by, so the two are asserted against each other rather than one at a time.
  it("distinguishes a terminal send from an inbox send", () => {
    const terminal = classifyConciergeActionReceipt(
      call({
        domain: "terminal",
        op: "send_to_agent_terminal",
        args: { agentId: "agent-1", text: "please rebase" },
        data: { delivered: true },
      }),
    );
    const inbox = classifyConciergeActionReceipt(
      call({
        domain: "fleet",
        op: "inbox_send",
        args: { agentId: "agent-1", text: "please rebase" },
        data: { queued: true },
      }),
    );
    expect(terminal).toMatchObject({ kind: "sent", channel: "terminal", agentId: "agent-1" });
    expect(inbox).toMatchObject({ kind: "sent", channel: "inbox", agentId: "agent-1" });
    // Same recipient, same text, DIFFERENT visibility — the pair is the assertion.
    expect(terminal?.channel).not.toBe(inbox?.channel);
  });

  it("marks a broadcast as inbox, and names no single recipient", () => {
    const r = classifyConciergeActionReceipt(
      call({
        domain: "fleet",
        op: "inbox_broadcast",
        args: { agentIds: ["a1", "a2", "a3"], text: "standup" },
        data: { queued: 3 },
      }),
    );
    expect(r).toMatchObject({ kind: "sent", channel: "inbox" });
    // Naming one of three recipients would be worse than naming none.
    expect(r?.agentId).toBeUndefined();
  });

  // ── the remaining four kinds ───────────────────────────────────────────────────────────────────
  it("maps close_agent to `closed`, carrying the agent from the arguments", () => {
    expect(
      classifyConciergeActionReceipt(
        call({ domain: "lifecycle", op: "close_agent", args: { agentId: "agent-9" } }),
      ),
    ).toMatchObject({ kind: "closed", ok: true, agentId: "agent-9", op: "lifecycle.close_agent" });
  });

  it("maps set_agent_goal to `goal`", () => {
    expect(
      classifyConciergeActionReceipt(
        call({
          domain: "app",
          op: "set_agent_goal",
          args: { agentId: "agent-4", goal: "PR #900 is merged" },
          data: { ok: true, goal: { text: "PR #900 is merged" } },
        }),
      ),
    ).toMatchObject({ kind: "goal", ok: true, agentId: "agent-4", op: "app.set_agent_goal" });
  });

  it("maps create_item to `filed`, with the bead id from the reply", () => {
    expect(
      classifyConciergeActionReceipt(
        call({
          domain: "board",
          op: "create_item",
          args: { projectId: "p1", title: "Fix the seam" },
          data: { id: "sparkle-kr2jz" },
        }),
      ),
    ).toMatchObject({ kind: "filed", ok: true, beadId: "sparkle-kr2jz" });
  });

  it("maps merge_pr to `merged`, with the PR number from the reply", () => {
    expect(
      classifyConciergeActionReceipt(
        call({
          domain: "workflow",
          op: "merge_pr",
          args: { projectId: "p1", number: 753 },
          data: { number: 753, merged: true },
        }),
      ),
    ).toMatchObject({ kind: "merged", ok: true, prNumber: 753 });
  });

  // Two routes to main, one fact to the reader — which is the whole reason the vocabulary is sized
  // for the human rather than for the registry.
  it("maps land_agent_branch to `merged` as well", () => {
    expect(
      classifyConciergeActionReceipt(
        call({ domain: "workflow", op: "land_agent_branch", args: { agentId: "agent-2" } }),
      ),
    ).toMatchObject({ kind: "merged", agentId: "agent-2", op: "workflow.land_agent_branch" });
  });

  // ── a refusal is a receipt ─────────────────────────────────────────────────────────────────────
  //
  // `dispatchConciergeTool` is TOTAL, so a denial arrives as an ordinary resolved reply. Assuming
  // success here is what once reported a refused merge as "Merged PR #753" beside the approval
  // request it was still waiting on.
  describe("a REFUSED call", () => {
    const refused = classifyConciergeActionReceipt(
      call({
        domain: "workflow",
        op: "merge_pr",
        args: { projectId: "p1", number: 753 },
        ok: false,
        data: undefined,
        reason: "merge_pr needs your go-ahead.",
      }),
    );

    it("still produces a receipt, and it is NOT a success", () => {
      expect(refused).not.toBeNull();
      expect(refused?.ok).toBe(false);
    });

    it("carries the tool's own words as the reason", () => {
      expect(refused?.reason).toBe("merge_pr needs your go-ahead.");
    });

    // The refusal carries no `data`, so the number has to come from the arguments — otherwise the
    // line reads "Couldn't merge the PR" and the human has to go and work out which one.
    it("still names the PR it could not merge", () => {
      expect(refused?.prNumber).toBe(753);
    });

    // THE CONTROL: the same op, the same arguments, differing only in the reply's own `ok`.
    it("differs from the success receipt in exactly `ok` and `reason`", () => {
      const succeeded = classifyConciergeActionReceipt(
        call({
          domain: "workflow",
          op: "merge_pr",
          args: { projectId: "p1", number: 753 },
          ok: true,
          data: { number: 753 },
          reason: undefined,
        }),
      );
      expect(succeeded?.ok).toBe(true);
      expect(succeeded?.reason).toBeUndefined();
      expect(succeeded?.kind).toBe(refused?.kind);
    });

    // A success must never carry a caveat — the field's contract is "the refusal, when ok is false".
    it("drops a stray reason on a successful call", () => {
      const r = classifyConciergeActionReceipt(
        call({
          domain: "lifecycle",
          op: "close_agent",
          args: { agentId: "a1" },
          ok: true,
          reason: "left over from somewhere",
        }),
      );
      expect(r?.reason).toBeUndefined();
    });
  });

  // ── read-only ops earn nothing ─────────────────────────────────────────────────────────────────
  //
  // The concierge reads constantly; a receipt per read would bury the six lines that matter.
  it.each([
    ["workspace", "list_projects"],
    ["board", "list_items"],
    ["terminal", "read_agent_terminal"],
    ["fleet", "fleet_digest"],
    ["diff", "list_commits"],
    ["approvals", "list_pending_approvals"],
  ])("returns null for the read-only op %s.%s", (domain, op) => {
    expect(classifyConciergeActionReceipt(call({ domain, op, args: { agentId: "a1" } }))).toBeNull();
  });

  // WRITE-tier, but with no arm in a six-word vocabulary. Recorded as a case because "we decided
  // null" and "nobody decided" must not look the same — the `Record<Op, …>` tables make the second
  // a typecheck failure, and this pins the first.
  it.each([
    ["workflow", "push_agent_branch"],
    ["workflow", "open_agent_pr"],
    ["board", "update_item"],
    ["workspace", "select_project"],
    ["review", "close_finding"],
    ["screenshot", "capture_window"],
    ["app", "set_agent_goal_met"],
  ])("returns null for the write-tier op %s.%s, which has no reader-facing arm", (domain, op) => {
    expect(classifyConciergeActionReceipt(call({ domain, op, args: { agentId: "a1" } }))).toBeNull();
  });

  it("returns null for an unknown domain and for an unknown op inside a known domain", () => {
    expect(classifyConciergeActionReceipt(call({ domain: "teleport", op: "go" }))).toBeNull();
    expect(classifyConciergeActionReceipt(call({ domain: "workflow", op: "squash_pr" }))).toBeNull();
  });

  // ── total and pure ─────────────────────────────────────────────────────────────────────────────
  //
  // Everything here crossed a wire a model assembled, so nothing may be assumed to be the type it
  // claims. A malformed reply degrades the receipt; it never throws it away and never throws.
  it.each([
    ["a null reply", null],
    ["a string reply", "boom"],
    ["a numeric reply", 7],
  ])("survives %s on a spawn, emitting a receipt with no id", (_label, data) => {
    const r = classifyConciergeActionReceipt(
      call({ domain: "lifecycle", op: "spawn_build_agent", args: { projectId: "p1" }, data }),
    );
    expect(r).toMatchObject({ kind: "spawned" });
    expect(r?.agentId).toBeUndefined();
  });

  it("survives malformed arguments", () => {
    const r = classifyConciergeActionReceipt(
      call({ domain: "lifecycle", op: "close_agent", args: "not an object" }),
    );
    expect(r).toMatchObject({ kind: "closed" });
    expect(r?.agentId).toBeUndefined();
  });

  // PURITY, asserted as a property rather than described in a comment: the two non-deterministic
  // fields are inputs, so the same call twice is the same receipt. A classifier that reached for
  // `Date.now()` or a module-level counter would fail this.
  it("is pure — the same input yields an identical receipt", () => {
    const input = call({
      domain: "fleet",
      op: "inbox_send",
      args: { agentId: "a1", text: "hi" },
      id: "receipt-42",
      at: 1_234_567,
    });
    const first = classifyConciergeActionReceipt(input);
    const second = classifyConciergeActionReceipt(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ id: "receipt-42", at: 1_234_567 });
  });

  // The seam in `controlListener.dispatch` gates on this list; deriving it from the rule table is
  // what stops the two drifting into "classified but never settled".
  it("publishes the app-domain ops the seam has to settle", () => {
    expect(CONCIERGE_RECEIPT_APP_OPS).toContain("set_agent_goal");
  });
});

// ══ THE CLASSIFIER HALF OF THE FAN-OUT (roborev 57905) ═════════════════════════════════════════
// Every wording assertion lives in actionReceiptLine.test.ts and is fed a HAND-BUILT receipt that
// already contains fanout/queued/failed — so those rows pass identically whether or not the
// classifier ever populates them. That is the vacuous shape AGENTS.md names as the #1 fleet-wide
// finding. These rows assert the classifier actually reads a real inboxBroadcast reply.
describe("a broadcast's plurality and counts come from the classifier", () => {
  const broadcast = (data: unknown, ok = true) =>
    classifyConciergeActionReceipt({
      domain: "fleet",
      op: "inbox_broadcast",
      args: { agentIds: ["a1", "a2", "a3"], text: "hi" },
      ok,
      data,
      reason: ok ? undefined : "Name at least one agentId to broadcast to.",
      id: "receipt-1",
      at: 1,
    });

  it("carries queued and failed off a real inboxBroadcast reply", () => {
    const r = broadcast({ outcomes: [{}, {}, {}, {}, {}], queued: 3, failed: 2 });
    expect(r).toMatchObject({ kind: "sent", channel: "inbox", fanout: true, queued: 3, failed: 2 });
  });

  it("marks a broadcast REFUSAL as a fan-out even though it carries no counts", () => {
    const r = broadcast(undefined, false);
    expect(r).toMatchObject({ fanout: true, ok: false });
    expect(r?.queued).toBeUndefined();
    expect(r?.failed).toBeUndefined();
  });

  it("does NOT mark a single inbox_send as a fan-out, even with count-shaped data", () => {
    // THE ROW THAT MATTERS: `channel: "inbox"` has two producers, and the renderer keys plurality on
    // `fanout` alone. If inbox_send ever picked this up, a one-recipient call would read "those
    // agents" — the rule-1 inversion this whole change removed from the terminal channel.
    const r = classifyConciergeActionReceipt({
      domain: "fleet",
      op: "inbox_send",
      args: { agentId: "a1", text: "hi" },
      ok: true,
      data: { queued: 3, failed: 2 },
      reason: undefined,
      id: "receipt-2",
      at: 1,
    });
    expect(r).toMatchObject({ kind: "sent", channel: "inbox" });
    expect(r?.fanout).toBeUndefined();
    expect(r?.queued).toBeUndefined();
  });

  it("drops malformed counts rather than fabricating zeros", () => {
    const r = broadcast({ queued: "3", failed: null });
    expect(r?.fanout).toBe(true);
    expect(r?.queued).toBeUndefined();
    expect(r?.failed).toBeUndefined();
  });
});
