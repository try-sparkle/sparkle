import { afterEach, describe, expect, it } from "vitest";
import { setConciergeTurnOrigin } from "../conciergeReceipts";
import { classifyConciergeActionReceipt } from "../conciergeReceiptClassifier";
import { refuseUnaddressedRelay } from "./relayGate";
import { CONCIERGE_TOOL_OPS, RELAY_GATED_OPS } from "./registry";

const FOUNDER_QUESTION = "You should have better memory now. can you tell me if that's true?";

/** Put a live founder turn on the module state, the way ConciergeHost does at dispatch. */
function inTurn(text: string, mentionedAgentIds: readonly string[] = []) {
  setConciergeTurnOrigin("bubble-1", { text, mentionedAgentIds });
}

afterEach(() => setConciergeTurnOrigin(null));

describe("a relay to an agent the founder never named is REFUSED", () => {
  it("refuses a verbatim forward of his message", () => {
    inTurn(FOUNDER_QUESTION);
    const refusal = refuseUnaddressedRelay(["ag-publishing"], FOUNDER_QUESTION);
    expect(refusal).not.toBeNull();
  });

  it("refuses his words wrapped in the concierge's own framing", () => {
    inTurn(FOUNDER_QUESTION);
    expect(
      refuseUnaddressedRelay(
        ["ag-publishing"],
        `The founder asks: ${FOUNDER_QUESTION} Please answer him.`,
      ),
    ).not.toBeNull();
  });

  it("names BOTH legal ways forward, so the concierge does not retry the same call", () => {
    // A bare denial produces a loop: same call, same word, and his instruction never lands by any
    // route. The refusal has to teach, so this asserts the two exits are actually in the sentence.
    inTurn(FOUNDER_QUESTION);
    const refusal = refuseUnaddressedRelay(["ag-publishing"], FOUNDER_QUESTION)!;
    expect(refusal.toLowerCase()).toContain("your own brief");
    expect(refusal.toLowerCase()).toContain("name the agent");
  });
});

describe("what the gate must NOT block", () => {
  it("allows a brief the concierge composed itself — his visibility is not the bug", () => {
    inTurn(FOUNDER_QUESTION);
    // The two real sends from the reported incident. Both are the concierge's own judgement.
    expect(
      refuseUnaddressedRelay(["ag-publishing"], "STOP — you are 42 commits ahead of origin/main"),
    ).toBeNull();
    expect(refuseUnaddressedRelay(["ag-eyes"], "commit your untracked files")).toBeNull();
  });

  it("allows a relay to an agent he DID name", () => {
    inTurn(FOUNDER_QUESTION, ["ag-publishing"]);
    expect(refuseUnaddressedRelay(["ag-publishing"], FOUNDER_QUESTION)).toBeNull();
  });

  it("still refuses a relay to a DIFFERENT agent in the same turn", () => {
    // He named one agent; that does not open his words to the rest of the fleet.
    inTurn(FOUNDER_QUESTION, ["ag-publishing"]);
    expect(refuseUnaddressedRelay(["ag-eyes"], FOUNDER_QUESTION)).not.toBeNull();
  });

  it("allows any send made outside a user turn", () => {
    // The concierge's autonomous work — overnight sweeps, nudges, follow-ups. There is no founder
    // text for such a send to carry, so it can never be a relay.
    setConciergeTurnOrigin(null);
    expect(refuseUnaddressedRelay(["ag-eyes"], FOUNDER_QUESTION)).toBeNull();
  });

  it("allows a send in a turn whose text the host did not publish", () => {
    // Fail-OPEN for the refusal (see relayGate's header): an unprovable case must not block work.
    setConciergeTurnOrigin("bubble-1");
    expect(refuseUnaddressedRelay(["ag-eyes"], FOUNDER_QUESTION)).toBeNull();
  });
});

describe("turn state cannot leak across turns", () => {
  it("drops the founder's text and his named agents when the turn ends", () => {
    inTurn(FOUNDER_QUESTION, ["ag-publishing"]);
    setConciergeTurnOrigin(null);
    // Stale founder text would let a send in the NEXT turn be judged a relay of the LAST one's
    // words — which is the turn-proximity error this whole change is removing, one level down.
    expect(refuseUnaddressedRelay(["ag-eyes"], FOUNDER_QUESTION)).toBeNull();
  });

  it("replaces, rather than accumulates, the named agents from turn to turn", () => {
    inTurn(FOUNDER_QUESTION, ["ag-publishing"]);
    inTurn(FOUNDER_QUESTION, ["ag-other"]);
    // `ag-publishing` was named LAST turn. That permission does not survive into this one.
    expect(refuseUnaddressedRelay(["ag-publishing"], FOUNDER_QUESTION)).not.toBeNull();
    expect(refuseUnaddressedRelay(["ag-other"], FOUNDER_QUESTION)).toBeNull();
  });
});

// ══ EVERY MESSAGE-CARRYING OP IS GATED — roborev 64191 ═══════════════════════════════════════════
//
// The first version gated `send_to_agent_terminal` alone, which left the founder's ruling walkable
// one tool over: `fleet.inbox_send` takes the same `text`, classifies to the same `kind: "sent"`,
// and the badge gate admits `channel: "inbox"`. So his verbatim words could reach an agent he never
// named — unrefused, and with the card on his bubble. Same symptom, different op.
//
// A HAND-KEPT LIST IS THE HOLE, so this cross-checks it against the RECEIPT CLASSIFIER, which is the
// other place that knows which ops carry a message. Add a message-carrying op and forget the gate,
// and this goes red instead of shipping a walkable ruling.
describe("the gated-op list covers every op that carries a message", () => {
  /** What kind of receipt this op mints, per the classifier — the app's own answer, not a guess. */
  const kindOf = (domain: string, op: string) =>
    classifyConciergeActionReceipt({
      domain,
      op,
      args: {},
      ok: true,
      data: {},
      reason: undefined,
      id: "r-1",
      at: 0,
    })?.kind;

  it("gates every op the classifier calls a `sent`", () => {
    const carriesAMessage: string[] = [];
    for (const [domain, ops] of Object.entries(CONCIERGE_TOOL_OPS)) {
      for (const op of ops) if (kindOf(domain, op) === "sent") carriesAMessage.push(op);
    }
    // The list is non-empty, or the loop proves nothing — the assertion below would hold vacuously
    // against a classifier that had stopped returning `sent` at all.
    expect(carriesAMessage.length).toBeGreaterThan(0);
    for (const op of carriesAMessage) {
      expect(
        RELAY_GATED_OPS.has(op),
        `${op} mints a "sent" receipt but is not in RELAY_GATED_OPS — the founder's words could be relayed through it to an agent he never named`,
      ).toBe(true);
    }
  });

  it("names the ops we know carry one, so the cross-check cannot silently narrow", () => {
    // Belt and braces: if the classifier ever stops classifying these, the row above goes quiet
    // while the hole reopens. These three are the message-carrying surface as of this change.
    expect(RELAY_GATED_OPS.has("send_to_agent_terminal")).toBe(true);
    expect(RELAY_GATED_OPS.has("inbox_send")).toBe(true);
    expect(RELAY_GATED_OPS.has("inbox_broadcast")).toBe(true);
  });
});

describe("a broadcast is refused unless he named EVERY recipient", () => {
  const FOUNDER_TEXT = "You should have better memory now. can you tell me if that's true?";

  it("refuses when his words would reach even one agent he did not name", () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER_TEXT, mentionedAgentIds: ["ag-a"] });
    // Naming one agent is not consent for his words to go to the rest of the fleet alongside it,
    // and there is no partial send to fall back to.
    expect(refuseUnaddressedRelay(["ag-a", "ag-b"], FOUNDER_TEXT)).not.toBeNull();
  });

  it("allows a broadcast when he named all of them", () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER_TEXT, mentionedAgentIds: ["ag-a", "ag-b"] });
    expect(refuseUnaddressedRelay(["ag-a", "ag-b"], FOUNDER_TEXT)).toBeNull();
  });

  it("allows a broadcast of the concierge's OWN words to anyone", () => {
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER_TEXT, mentionedAgentIds: [] });
    expect(refuseUnaddressedRelay(["ag-a", "ag-b"], "Push your branch before you do anything else.")).toBeNull();
  });

  it("says 'every agent it would reach' for a fan-out, not 'this agent'", () => {
    // The refusal is read by a model deciding what to do next; a plural send described in the
    // singular invites it to retry with one recipient removed and call the problem solved.
    setConciergeTurnOrigin("bubble-1", { text: FOUNDER_TEXT, mentionedAgentIds: [] });
    expect(refuseUnaddressedRelay(["ag-a", "ag-b"], FOUNDER_TEXT)).toContain("every agent it would reach");
    expect(refuseUnaddressedRelay(["ag-a"], FOUNDER_TEXT)).toContain("this agent");
  });
});
