// The audit log: "what did it just do?", answerable after the fact.
//
// `describeApprovalArgs` is kept REAL — reusing the approval card's redactor is the design claim
// (the log and the prompt must describe a call the same way), and stubbing it would hide a drift.
import { describe, it, expect, beforeEach } from "vitest";

import {
  MAX_AUDIT_ENTRIES,
  noteConciergeAuditCall,
  recentConciergeAudit,
  _resetConciergeAuditForTests,
  useConciergeAudit,
} from "./conciergeAudit";

beforeEach(() => _resetConciergeAuditForTests());

describe("recording an attempt", () => {
  it("writes the call the moment it STARTS, before any reply", () => {
    noteConciergeAuditCall("tc-1", "workflow", "merge_pr", { number: 753 }, 1_000);

    const [entry] = useConciergeAudit.getState().entries;
    expect(entry).toMatchObject({
      toolCallId: "tc-1",
      domain: "workflow",
      op: "merge_pr",
      outcome: "running",
      startedAt: 1_000,
      settledAt: null,
      code: null,
    });
  });

  it("settles with the reply's own outcome", () => {
    const settle = noteConciergeAuditCall("tc-1", "board", "list_items", {}, 1_000);
    settle({ ok: true }, 1_200);

    const [entry] = useConciergeAudit.getState().entries;
    expect(entry).toMatchObject({ outcome: "ok", settledAt: 1_200, code: null, message: null });
  });

  // The entries that answer "why didn't it do the thing I asked?" are the REFUSED ones, so the log
  // has to carry the code and the sentence — not merely that it failed.
  it("records WHY a call was refused, not just that it was", () => {
    const settle = noteConciergeAuditCall("tc-2", "workflow", "merge_pr", { number: 9 }, 1_000);
    settle({ ok: false, code: "needs-approval", message: "merge_pr needs your go-ahead." }, 1_050);

    const [entry] = useConciergeAudit.getState().entries;
    expect(entry).toMatchObject({
      outcome: "refused",
      code: "needs-approval",
      message: "merge_pr needs your go-ahead.",
    });
  });

  // A log that only shows what RAN cannot answer the question it exists for. Denials, unapproved
  // ask-tier calls, bad-args and unknown-op are all attempts and all belong in the record.
  it("keeps refused attempts alongside successful ones", () => {
    noteConciergeAuditCall("a", "board", "list_items", {}, 1)({ ok: true }, 2);
    noteConciergeAuditCall("b", "board", "delete_item", { id: "x" }, 3)(
      { ok: false, code: "denied", message: "no" },
      4,
    );

    expect(useConciergeAudit.getState().entries.map((e) => [e.op, e.outcome])).toEqual([
      ["list_items", "ok"],
      ["delete_item", "refused"],
    ]);
  });

  // A call whose reply never arrives STAYS running. Implying it finished would be the one lie this
  // record must not tell.
  it("leaves an unsettled call visible as running rather than dropping it", () => {
    noteConciergeAuditCall("tc-3", "terminal", "send_to_agent_terminal", { agentId: "a1" }, 1_000);

    expect(recentConciergeAudit()[0]).toMatchObject({ outcome: "running", settledAt: null });
  });
});

describe("arguments are display-safe", () => {
  // The SAME redactor the approval card uses, so the log and the prompt describe a call identically.
  // A second redactor would drift, and both would still look plausible.
  it("stores redacted key/value LINES, never the raw argument object", () => {
    noteConciergeAuditCall("tc-1", "workflow", "merge_pr", { number: 753, confirm: true }, 1);

    const [entry] = useConciergeAudit.getState().entries;
    expect(Array.isArray(entry!.args)).toBe(true);
    for (const line of entry!.args) {
      expect(typeof line.key).toBe("string");
      expect(typeof line.value).toBe("string");
    }
    expect(entry!.args.map((a) => a.key)).toContain("number");
    // Not the object itself — nothing here holds raw model arguments.
    expect(entry as unknown as Record<string, unknown>).not.toHaveProperty("rawArgs");
  });

  it("survives arguments that are not an object at all", () => {
    expect(() => noteConciergeAuditCall("tc-1", "x", "y", "just a string", 1)).not.toThrow();
    expect(() => noteConciergeAuditCall("tc-2", "x", "y", undefined, 1)).not.toThrow();
  });
});

describe("the log is bounded", () => {
  it("evicts the OLDEST, so the newest call is never the one dropped", () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 5; i++) {
      noteConciergeAuditCall(`id-${i}`, "board", "list_items", {}, i);
    }

    const entries = useConciergeAudit.getState().entries;
    expect(entries).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(entries[0]!.toolCallId).toBe("id-5"); // the first five aged out
    expect(entries.at(-1)!.toolCallId).toBe(`id-${MAX_AUDIT_ENTRIES + 4}`);
  });

  // A settler whose row aged out mid-flight must not resurrect it — that would put an old call back
  // at a position the eviction already decided against.
  it("a settler for an evicted entry is a no-op", () => {
    const settle = noteConciergeAuditCall("old", "board", "list_items", {}, 0);
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 1; i++) {
      noteConciergeAuditCall(`filler-${i}`, "board", "list_items", {}, i + 1);
    }
    expect(() => settle({ ok: true }, 9_999)).not.toThrow();

    const entries = useConciergeAudit.getState().entries;
    expect(entries).toHaveLength(MAX_AUDIT_ENTRIES);
    expect(entries.some((e) => e.toolCallId === "old")).toBe(false);
  });

  // Two calls in flight at once settle independently — the join is by the wire toolCallId, which is
  // minted per call by the MCP server, so there is no counter to get out of step.
  it("settles concurrent calls independently, by id", () => {
    const first = noteConciergeAuditCall("tc-a", "board", "list_items", {}, 1);
    const second = noteConciergeAuditCall("tc-b", "board", "get_board", {}, 2);
    second({ ok: false, code: "beads-unavailable", message: "no bd" }, 3);
    first({ ok: true }, 4);

    const byId = Object.fromEntries(
      useConciergeAudit.getState().entries.map((e) => [e.toolCallId, e.outcome]),
    );
    expect(byId).toEqual({ "tc-a": "ok", "tc-b": "refused" });
  });
});

describe("reading it back", () => {
  it("returns NEWEST first — the order a 'what did it just do' surface reads in", () => {
    noteConciergeAuditCall("a", "board", "list_items", {}, 1);
    noteConciergeAuditCall("b", "board", "get_board", {}, 2);
    noteConciergeAuditCall("c", "plans", "list_plans", {}, 3);

    expect(recentConciergeAudit().map((e) => e.toolCallId)).toEqual(["c", "b", "a"]);
  });

  it("honours the limit, taking the most recent", () => {
    for (let i = 0; i < 10; i++) noteConciergeAuditCall(`id-${i}`, "board", "list_items", {}, i);
    expect(recentConciergeAudit(3).map((e) => e.toolCallId)).toEqual(["id-9", "id-8", "id-7"]);
  });
});

// THE JOIN KEY IS MINTED HERE, NOT TAKEN FROM THE WIRE.
//
// controlListener normalises a missing/non-string `toolCallId` to the EMPTY STRING and deliberately
// does not reject it. Joining on that would put every blank-id call under one key, and a settler
// would stamp the OLDEST matching row — so two blank-id calls could swap outcomes, with the second
// left `running` forever (roborev 55160).
describe("calls with a blank toolCallId still settle independently", () => {
  it("does not let one blank-id call stamp another's row", () => {
    const a = noteConciergeAuditCall("", "board", "list_items", {}, 1);
    const b = noteConciergeAuditCall("", "workflow", "merge_pr", { number: 9 }, 2);

    // B replies FIRST — the interleaving that produced the swap.
    b({ ok: false, code: "needs-approval", message: "needs your go-ahead" }, 3);
    a({ ok: true }, 4);

    const byOp = Object.fromEntries(
      useConciergeAudit.getState().entries.map((e) => [e.op, e]),
    );
    expect(byOp.list_items).toMatchObject({ outcome: "ok", code: null });
    expect(byOp.merge_pr).toMatchObject({ outcome: "refused", code: "needs-approval" });
    // …and neither is left in flight.
    expect(useConciergeAudit.getState().entries.some((e) => e.outcome === "running")).toBe(false);
  });

  // A second settle can only come from a bug; keeping the FIRST (true) reading beats overwriting it
  // with a later one. Mirrors conciergeActivity's guard.
  it("settles once — a repeat settle does not rewrite a recorded outcome", () => {
    const settle = noteConciergeAuditCall("tc-1", "board", "list_items", {}, 1);
    settle({ ok: true }, 2);
    settle({ ok: false, code: "denied", message: "no" }, 3);

    expect(useConciergeAudit.getState().entries[0]).toMatchObject({
      outcome: "ok",
      code: null,
      settledAt: 2,
    });
  });
});
