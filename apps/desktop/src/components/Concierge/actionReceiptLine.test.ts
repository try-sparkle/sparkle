import { describe, expect, it } from "vitest";
import { actionReceiptLine } from "./actionReceiptLine";
import type { ConciergeActionReceipt } from "../../services/conciergeReceipts";

const AGENT = { id: "11111111-2222-3333-4444-555555555555", name: "Left Pair" };
const resolve = (id: string) => (id === AGENT.id ? AGENT : null);
const noneResolve = () => null;

function receipt(over: Partial<ConciergeActionReceipt> = {}): ConciergeActionReceipt {
  return {
    id: "receipt-1",
    kind: "sent",
    ok: true,
    agentId: AGENT.id,
    agentName: AGENT.name,
    channel: "terminal",
    at: 1_769_649_600_123,
    op: "terminal.send_to_agent_terminal",
    ...over,
  };
}

describe("actionReceiptLine", () => {
  // ══ THE ONE THAT CLOSES sparkle-zm0c8 ═════════════════════════════════════════════════════════
  // The founder was told a message was in the inbox and could find no trace of it. Both facts were
  // true: an inbox message is queued and invisible until the agent's next turn boundary. The line
  // has to carry that, or it reproduces the complaint.
  it("says an inbox message is DELAYED, and a terminal send is not", () => {
    const inbox = actionReceiptLine(receipt({ channel: "inbox" }), resolve);
    expect(inbox?.spoken).toBe("Left Left Pair a message — it delivers at their next turn.");

    // The positive control: the terminal arm must NOT carry the delay clause, or the distinction
    // this test exists for is cosmetic.
    const terminal = actionReceiptLine(receipt({ channel: "terminal" }), resolve);
    expect(terminal?.spoken).toBe("Sent to Left Pair's terminal.");
    expect(terminal?.spoken).not.toContain("next turn");
  });

  it("names the agent as a clickable pill when the id resolves", () => {
    const l = actionReceiptLine(receipt(), resolve);
    expect(l?.md).toContain(`sparkle-agent:${AGENT.id}`);
  });

  it("degrades to words rather than inventing a reference when the agent is gone", () => {
    // A pill carrying a guessed id opens the WRONG agent and the reader cannot tell — strictly
    // worse than no pill. The name still shows because the tool call reported it.
    const l = actionReceiptLine(receipt(), noneResolve);
    expect(l?.md).not.toContain("sparkle-agent:");
    expect(l?.spoken).toBe("Sent to Left Pair's terminal.");
  });

  // ══ THE BROADCAST ARM (roborev 57866) ═════════════════════════════════════════════════════════
  // `fleet.inbox_broadcast` classifies to {kind:"sent", channel:"inbox"} and carries `agentIds`,
  // not `agentId` — so the singular arm rendered a message sent to N agents as "Left that agent a
  // message". Understating a fan-out is as untrue as overstating a single send, in the one module
  // whose contract is never to claim more than the tool reported.
  describe("a broadcast is never described as a single recipient", () => {
    // Shaped as the CLASSIFIER now builds it: `fanout` comes from the op, and the counts only when
    // the reply carried them. conciergeReceiptClassifier.test.ts pins that this is what it produces.
    const broadcast = (channel: "inbox" | "terminal") =>
      receipt({ channel, agentId: undefined, agentName: undefined, fanout: true });

    it("counts the recipients when the classifier carried them", () => {
      const l = actionReceiptLine(
        receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 5, failed: 0 }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Left a message for 5 agents — it delivers at each one's next turn.");
    });

    // roborev 57888: `inboxBroadcast` reports a PARTIAL failure as an OK reply carrying
    // {queued, failed}. Keying only on `ok` claimed a delivery the tool never reported.
    it("states a PARTIAL failure instead of claiming delivery", () => {
      const l = actionReceiptLine(
        receipt({ channel: "inbox", agentId: undefined, agentName: undefined, fanout: true, queued: 3, failed: 2 }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Left a message for 3 agents — 2 couldn't be reached.");
      expect(l?.spoken).not.toContain("delivers at each");
    });

    it("says a bare SEVERAL when there are no counts — the refusal shape", () => {
      const l = actionReceiptLine(broadcast("inbox"), noneResolve);
      expect(l?.spoken).toBe(
        "Left a message for several agents — it delivers at each one's next turn.",
      );
      expect(l?.spoken).not.toContain("that agent");
    });

    // roborev 57888: the refusal arm was left singular, so a refused broadcast still said
    // "Not sent to that agent" — the same misstatement, on the path where nothing went out.
    it("a REFUSED broadcast is plural too", () => {
      const l = actionReceiptLine(
        receipt({
          channel: "inbox",
          agentId: undefined,
          agentName: undefined,
          fanout: true,
          ok: false,
          reason: "Name at least one agentId to broadcast to.",
        }),
        noneResolve,
      );
      expect(l?.spoken).toBe(
        "Not sent to those agents — Name at least one agentId to broadcast to.",
      );
    });

    // A subject-less TERMINAL send is NOT a fan-out: send_to_agent_terminal is its only producer and
    // always carries an agentId, so the only way to get here is a single send whose id failed to
    // parse. Calling that "several agents" would OVERSTATE — the failure rule 1 exists to prevent.
    // THE ROW roborev 57905 ASKED FOR: `channel:"inbox"` has TWO producers, so a subject-less inbox
    // receipt is just as likely a single `inbox_send` whose args were refused. Without the carried
    // flag it must stay SINGULAR — pluralising it is the same rule-1 inversion removed from terminal.
    it("keeps a subject-less inbox send SINGULAR when it is not a fan-out", () => {
      const l = actionReceiptLine(
        receipt({
          channel: "inbox",
          agentId: undefined,
          agentName: undefined,
          ok: false,
          reason: "agentId is required.",
        }),
        noneResolve,
      );
      expect(l?.spoken).toBe("Not sent to that agent — agentId is required.");
      expect(l?.spoken).not.toContain("those agents");
    });

    it("the positive control: a receipt that DOES name one agent stays singular", () => {
      // Without this, the assertions above would pass against a module that had simply stopped
      // naming anyone at all.
      expect(actionReceiptLine(receipt({ channel: "inbox" }), resolve)?.spoken).toBe(
        "Left Left Pair a message — it delivers at their next turn.",
      );
    });
  });

  it("falls back to 'that agent' when there is no name either", () => {
    const l = actionReceiptLine(receipt({ agentName: undefined }), noneResolve);
    expect(l?.spoken).toBe("Sent to that agent's terminal.");
  });

  describe("each kind reads as what happened", () => {
    it("spawned", () => {
      expect(actionReceiptLine(receipt({ kind: "spawned" }), resolve)?.spoken).toBe(
        "Spawned Left Pair.",
      );
    });
    it("closed", () => {
      expect(actionReceiptLine(receipt({ kind: "closed" }), resolve)?.spoken).toBe(
        "Closed Left Pair.",
      );
    });
    it("goal", () => {
      expect(actionReceiptLine(receipt({ kind: "goal" }), resolve)?.spoken).toBe(
        "Set a goal on Left Pair.",
      );
    });
    it("filed, with the bead as a pill", () => {
      const l = actionReceiptLine(
        receipt({ kind: "filed", beadId: "sparkle-kr2jz", agentId: undefined }),
        resolve,
      );
      expect(l?.spoken).toBe("Filed sparkle-kr2jz.");
      expect(l?.md).toContain("sparkle-bead:sparkle-kr2jz");
    });
    it("filed with an unusable bead id keeps the line and loses only the pill", () => {
      const l = actionReceiptLine(receipt({ kind: "filed", beadId: "  " }), resolve);
      expect(l?.spoken).toBe("Filed a task.");
    });
    it("merged, with the PR number", () => {
      expect(
        actionReceiptLine(receipt({ kind: "merged", prNumber: 1175 }), resolve)?.spoken,
      ).toBe("Merged PR #1175.");
    });
  });

  // ══ THE REFUSAL ARM ═══════════════════════════════════════════════════════════════════════════
  describe("a refused action still posts a line, and never borrows the success wording", () => {
    it("a refused send says NOT sent", () => {
      const l = actionReceiptLine(
        receipt({ ok: false, reason: "its terminal is showing a full-screen app" }),
        resolve,
      );
      expect(l?.spoken).toBe("Not sent to Left Pair — its terminal is showing a full-screen app");
      // The regression this guards: a settle that assumed success once reported a REFUSED merge as
      // "Merged PR #753". A refusal must not read like the thing having happened.
      expect(l?.spoken).not.toMatch(/^Sent to/);
    });

    it("a refused merge does not say 'Merged'", () => {
      const l = actionReceiptLine(
        receipt({ kind: "merged", ok: false, prNumber: 753, reason: "checks are still pending" }),
        resolve,
      );
      expect(l?.spoken).toBe("Didn't merge — checks are still pending");
      expect(l?.spoken).not.toMatch(/^Merged/);
    });

    it("a refusal with no stated reason still posts, just without the tail", () => {
      const l = actionReceiptLine(receipt({ kind: "closed", ok: false, reason: "  " }), resolve);
      expect(l?.spoken).toBe("Couldn't close Left Pair");
    });

    it("covers every kind, so no refusal can fall through to silence", () => {
      for (const kind of ["spawned", "sent", "closed", "goal", "filed", "merged"] as const) {
        const l = actionReceiptLine(receipt({ kind, ok: false, reason: "nope" }), resolve);
        expect(l, `${kind} must produce a refusal line`).not.toBeNull();
        expect(l?.spoken).toContain("nope");
      }
    });
  });

  it("posts NOTHING for an unrecognized kind — a line means the thing happened", () => {
    const l = actionReceiptLine(
      receipt({ kind: "teleported" as ConciergeActionReceipt["kind"] }),
      resolve,
    );
    expect(l).toBeNull();
  });

  it("survives a malformed receipt instead of throwing into the render path", () => {
    expect(actionReceiptLine(undefined as never, resolve)).toBeNull();
    expect(actionReceiptLine({} as ConciergeActionReceipt, resolve)).toBeNull();
  });
});
