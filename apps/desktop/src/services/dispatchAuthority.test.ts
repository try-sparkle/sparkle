import { describe, expect, it } from "vitest";
import {
  DISPATCH_AUTHORITY_KINDS,
  authorityRef,
  describeAuthority,
  isDispatchAuthority,
  type DispatchAuthority,
  type DispatchAuthorityKind,
} from "./dispatchAuthority";

/** One well-formed authority per kind — the table every exhaustiveness test below walks. Typed as
 *  a `Record` over the union key, so a new arm on DispatchAuthority fails to COMPILE here until it
 *  is given a sample. That is the test for the `never` guards: a missing arm can't reach runtime. */
const SAMPLES: Record<DispatchAuthorityKind, DispatchAuthority> = {
  mention: { kind: "mention", agentId: "ag-1" },
  approval: { kind: "approval", proposalId: "prop-1" },
  countdown: { kind: "countdown", intentId: "intent-1" },
  redirect: { kind: "redirect", receiptId: "you-7" },
  "nudge-approve": { kind: "nudge-approve", agentId: "ag-2" },
  suggestion: { kind: "suggestion", agentId: "ag-3" },
};

describe("DISPATCH_AUTHORITY_KINDS", () => {
  it("lists every kind the union declares", () => {
    expect([...DISPATCH_AUTHORITY_KINDS].sort()).toEqual(Object.keys(SAMPLES).sort());
  });
  it("covers the six gestures the design names", () => {
    expect(DISPATCH_AUTHORITY_KINDS).toHaveLength(6);
  });
});

describe("authorityRef — exhaustive over the union", () => {
  it("returns the id each arm carries", () => {
    for (const kind of DISPATCH_AUTHORITY_KINDS) {
      const ref = authorityRef(SAMPLES[kind]);
      expect(ref, `${kind} must expose its id`).not.toBe("");
    }
    expect(authorityRef(SAMPLES.countdown)).toBe("intent-1");
    expect(authorityRef(SAMPLES.redirect)).toBe("you-7");
    expect(authorityRef(SAMPLES.approval)).toBe("prop-1");
  });
});

describe("describeAuthority — exhaustive over the union", () => {
  it("gives every kind its own non-empty audit line", () => {
    const lines = DISPATCH_AUTHORITY_KINDS.map((k) => describeAuthority(SAMPLES[k]));
    for (const line of lines) expect(line).not.toBe("");
    // Distinct: an audit line shared by two gestures answers "who authorized this?" with a guess.
    expect(new Set(lines).size).toBe(lines.length);
    // The `never` default must stay unreachable — no arm may degrade to it.
    expect(lines).not.toContain("unknown authority");
  });
  it("names the countdown as the elapsed-without-cancel case", () => {
    expect(describeAuthority(SAMPLES.countdown)).toMatch(/countdown/i);
  });
});

describe("isDispatchAuthority — fails closed", () => {
  it("accepts every well-formed sample", () => {
    for (const kind of DISPATCH_AUTHORITY_KINDS) {
      expect(isDispatchAuthority(SAMPLES[kind]), kind).toBe(true);
    }
  });
  it("rejects a missing or non-object authority", () => {
    expect(isDispatchAuthority(undefined)).toBe(false);
    expect(isDispatchAuthority(null)).toBe(false);
    expect(isDispatchAuthority("countdown")).toBe(false);
    expect(isDispatchAuthority(42)).toBe(false);
  });
  it("rejects an unknown kind — a new gesture must be declared, not assumed", () => {
    expect(isDispatchAuthority({ kind: "router", agentId: "ag-1" })).toBe(false);
    expect(isDispatchAuthority({ agentId: "ag-1" })).toBe(false);
  });
  it("rejects a kind whose id is missing, blank, or the wrong field", () => {
    expect(isDispatchAuthority({ kind: "countdown" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: "" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: "   " })).toBe(false);
    // The redirect arm's id is `receiptId`; an agentId does not stand in for it.
    expect(isDispatchAuthority({ kind: "redirect", agentId: "ag-1" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: 7 })).toBe(false);
  });
});
