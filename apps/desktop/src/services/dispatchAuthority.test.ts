import { describe, expect, it } from "vitest";
import * as dispatchAuthorityModule from "./dispatchAuthority";
import {
  DISPATCH_AUTHORITY_KINDS,
  authorityRef,
  conciergeToolAuthority,
  describeAuthority,
  isDispatchAuthority,
  isHumanAuthored,
  type DispatchAuthority,
  type DispatchAuthorityKind,
} from "./dispatchAuthority";

/** One well-formed authority per kind — the table every exhaustiveness test below walks. Typed as
 *  a `Record` over the union key, so a new arm on DispatchAuthority fails to COMPILE here until it
 *  is given a sample. That is the test for the `never` guards: a missing arm can't reach runtime.
 *
 *  The `concierge-tool` sample goes through the FACTORY rather than being written inline, and not as
 *  a stylistic preference: its `policy` is a branded stamp only `conciergeToolAuthority` can mint, so
 *  an inline literal no longer compiles. A test suite that could hand-build the arm would be
 *  demonstrating the exact bypass the arm exists to prevent — see the `@ts-expect-error` case below. */
const SAMPLES: Record<DispatchAuthorityKind, DispatchAuthority> = {
  mention: { kind: "mention", agentId: "ag-1" },
  approval: { kind: "approval", proposalId: "prop-1" },
  countdown: { kind: "countdown", intentId: "intent-1" },
  mount: { kind: "mount", agentId: "ag-5" },
  redirect: { kind: "redirect", receiptId: "you-7" },
  "nudge-approve": { kind: "nudge-approve", agentId: "ag-2" },
  suggestion: { kind: "suggestion", agentId: "ag-3" },
  "concierge-tool": conciergeToolAuthority("call-1", { tier: "allow" })!,
  "goal-continue": { kind: "goal-continue", agentId: "ag-4" },
};

describe("DISPATCH_AUTHORITY_KINDS", () => {
  it("lists every kind the union declares", () => {
    expect([...DISPATCH_AUTHORITY_KINDS].sort()).toEqual(Object.keys(SAMPLES).sort());
  });
  it("covers the seven user gestures, plus the two machine arms", () => {
    // `concierge-tool` (an AI tool call under a resolved policy) and `goal-continue` (the goal
    // auto-continue runner) are the two writes NO human gesture authorizes. Each carries its own
    // arm so the audit line names the real cause rather than borrowing another's.
    //
    // `mount` is the seventh gesture: the user patched a cable into an agent and typed into it. It
    // exists so an IMMEDIATE mounted send need not claim a countdown that never ran.
    expect(DISPATCH_AUTHORITY_KINDS).toHaveLength(9);
  });
  // A mounted send is a HUMAN gesture, and its audit line must not describe it as a countdown —
  // that is the entire reason the arm was added rather than reusing `countdown`.
  it("treats a mounted send as human-authored, and never describes it as a countdown", () => {
    expect(isHumanAuthored(SAMPLES.mount)).toBe(true);
    expect(describeAuthority(SAMPLES.mount)).not.toMatch(/countdown/i);
    expect(describeAuthority(SAMPLES.mount)).toMatch(/mounted/i);
    expect(authorityRef(SAMPLES.mount)).toBe("ag-5");
  });
  // The arm that must NEVER exist. A heuristic verdict is not a user gesture, and neither is an AI
  // deciding to call a tool — `concierge-tool` is admissible only because it carries the POLICY
  // decision that permitted the write, which is why there is no bare `concierge` arm either.
  it("has no `router` or bare `concierge` arm", () => {
    expect(DISPATCH_AUTHORITY_KINDS).not.toContain("router");
    expect(DISPATCH_AUTHORITY_KINDS).not.toContain("concierge");
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

  // The kind is a lookup KEY into two plain object literals, so a `kind` naming an Object.prototype
  // member resolves to an inherited function rather than to `undefined`. It must be refused as an
  // unknown kind, not treated as a declared one whose maps happen to answer.
  it("rejects a kind that names an inherited Object.prototype member", () => {
    for (const kind of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(isDispatchAuthority({ kind, agentId: "ag-1", toolCallId: "c", policy: "allow" }), kind)
        .toBe(false);
    }
  });
  it("rejects a kind whose id is missing, blank, or the wrong field", () => {
    expect(isDispatchAuthority({ kind: "countdown" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: "" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: "   " })).toBe(false);
    // The redirect arm's id is `receiptId`; an agentId does not stand in for it.
    expect(isDispatchAuthority({ kind: "redirect", agentId: "ag-1" })).toBe(false);
    expect(isDispatchAuthority({ kind: "countdown", intentId: 7 })).toBe(false);
  });

  // The `concierge-tool` arm is the only one whose id is not sufficient. Its POLICY is the reason
  // the write is legal, so a shape carrying a perfectly good toolCallId and an unresolved or denied
  // policy must fail — otherwise the tool surface would authorize itself, which is the hole the
  // whole gate exists to close.
  it("rejects a concierge-tool authority whose policy did not authorize anything", () => {
    const id = "call-1";
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: id })).toBe(false);
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: id, policy: "ask" })).toBe(
      false,
    );
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: id, policy: "deny" })).toBe(
      false,
    );
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: id, policy: "" })).toBe(false);
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: id, policy: true })).toBe(
      false,
    );
  });
  it("accepts a concierge-tool authority under either authorizing policy", () => {
    expect(
      isDispatchAuthority({ kind: "concierge-tool", toolCallId: "c", policy: "allow" }),
    ).toBe(true);
    expect(
      isDispatchAuthority({ kind: "concierge-tool", toolCallId: "c", policy: "approved" }),
    ).toBe(true);
  });
});

// THE NARROW GATE. `conciergeToolAuthority` is the only way a tool call becomes a write, so what it
// refuses is the real security boundary — not what it permits.
describe("conciergeToolAuthority — an unresolved or denied policy yields NO authority", () => {
  it("mints an allow-tier authority", () => {
    expect(conciergeToolAuthority("call-1", { tier: "allow" })).toEqual({
      kind: "concierge-tool",
      toolCallId: "call-1",
      policy: "allow",
    });
  });

  it("mints an approved authority only once a human actually answered yes", () => {
    expect(
      conciergeToolAuthority("call-2", {
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "call-2",
      }),
    ).toEqual({
      kind: "concierge-tool",
      toolCallId: "call-2",
      policy: "approved",
    });
  });

  // AN APPROVAL IS NOT TRANSFERABLE. The arm exists to make a write attributable to the decision
  // that permitted it, so a `yes` the user gave for call A must not authorize call B — otherwise a
  // loosely-keyed approval map or a re-render reusing the last decision object silently re-opens the
  // attribution hole. Fail closed: the mismatch produces nothing, not a best guess.
  it("returns null when the approval was answered for a DIFFERENT tool call", () => {
    expect(
      conciergeToolAuthority("call-b", {
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "call-a",
      }),
    ).toBeNull();
  });

  // The ids are compared AFTER trimming on both sides, for the same reason the stored id is trimmed:
  // a padded id must not read as a different call in either direction.
  it("matches a padded approval id against the padded call it names", () => {
    expect(
      conciergeToolAuthority(" call-c ", {
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "call-c",
      }),
    ).toEqual({ kind: "concierge-tool", toolCallId: "call-c", policy: "approved" });
  });

  // A JS caller (or a decision rebuilt off the wire) can arrive with the binding missing entirely.
  // "Approved, for nothing in particular" is the un-attributable case, so it is refused.
  it("returns null for an approval that names no call at all", () => {
    const noBinding = { tier: "ask", approvedByUser: true } as unknown as Parameters<
      typeof conciergeToolAuthority
    >[1];
    expect(conciergeToolAuthority("call-d", noBinding)).toBeNull();
    const blankBinding = {
      tier: "ask",
      approvedByUser: true,
      approvedForToolCallId: "   ",
    } as unknown as Parameters<typeof conciergeToolAuthority>[1];
    expect(conciergeToolAuthority("   ", blankBinding)).toBeNull();
  });

  // "We showed the user a prompt" is not "the user approved it". An ask-tier tool whose prompt is
  // still on screen (or was dismissed) must produce nothing at all.
  it("returns null for an ask-tier decision nobody has approved", () => {
    expect(conciergeToolAuthority("call-3", { tier: "ask", approvedByUser: false })).toBeNull();
  });

  it("returns null for a denied decision", () => {
    expect(conciergeToolAuthority("call-4", { tier: "deny", reason: "not allowed" })).toBeNull();
    expect(conciergeToolAuthority("call-4", { tier: "deny" })).toBeNull();
  });

  // No id, no attribution — and an unattributable write is what the union exists to prevent.
  it("returns null without a tool-call id to attribute the write to", () => {
    expect(conciergeToolAuthority("", { tier: "allow" })).toBeNull();
    expect(conciergeToolAuthority("   ", { tier: "allow" })).toBeNull();
    expect(
      conciergeToolAuthority("  ", {
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "  ",
      }),
    ).toBeNull();
  });

  it("trims the id it stores, so a padded id can't read as a different call", () => {
    expect(authorityRef(conciergeToolAuthority(" call-5 ", { tier: "allow" })!)).toBe("call-5");
  });

  // Everything it DOES mint has to survive the runtime validator — a factory that produced a shape
  // the gate then refused would be a silently broken tool surface.
  it("only ever mints shapes the runtime gate accepts", () => {
    const minted = [
      conciergeToolAuthority("a", { tier: "allow" }),
      conciergeToolAuthority("b", {
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "b",
      }),
    ];
    for (const a of minted) expect(isDispatchAuthority(a)).toBe(true);
  });

  // THE FACTORY IS A BOUNDARY, NOT A CONVENTION. The doc comment has always said "the only path";
  // this is the line that makes it true. `policy` is a branded stamp, so a hand-written literal —
  // the shape any call site could previously reach for, this suite included — no longer typechecks.
  // A caller wanting an authority has to present a decision, which is the whole point.
  //
  // `@ts-expect-error` is the assertion: tsc FAILS this file if the literal ever compiles again.
  it("cannot be hand-built inline — only the factory mints the policy stamp", () => {
    // @ts-expect-error — `policy: "allow"` is a bare string, not a factory-minted ToolPolicyStamp.
    const forged: DispatchAuthority = { kind: "concierge-tool", toolCallId: "x", policy: "allow" };
    // It is still a valid runtime SHAPE — the brand is a compile-time boundary and the validator is
    // the wire one. That asymmetry is deliberate and is why `sendToAgentTerminal` re-checks at
    // runtime: an object off the wire never went through tsc at all.
    expect(isDispatchAuthority(forged)).toBe(true);
  });

  // The brand has to be UNNAMEABLE, not merely present. An exported `ToolPolicyStamp` would make the
  // literal above compile again with one ordinary assertion — `policy: "allow" as ToolPolicyStamp`,
  // no `as unknown` laundering, nothing that reads as a smell in review — and the guarantee would be
  // back to a convention. `@ts-expect-error` on the type reference is the assertion: tsc fails this
  // file the day the type is exported.
  it("does not export the brand, so a call site cannot name it to cast", () => {
    // @ts-expect-error — ToolPolicyStamp is module-private and must stay that way.
    type Stamp = import("./dispatchAuthority").ToolPolicyStamp;
    const unobtainable: Stamp | undefined = undefined;
    expect(unobtainable).toBeUndefined();
  });
});

// The extra-check map is TOTAL over the union key on purpose. A `Partial` map defaults a new arm to
// "nothing to prove", which is precisely the silent widening this module is built to prevent: the
// `concierge-tool` arm is itself an example of an arm whose legality rests on more than an id, and
// the next one like it must be a compile error until someone decides what it has to prove.
//
// Tested THROUGH the validator rather than against the map, because the map must stay module-private
// — it is the only thing standing between `{policy:"ask"}` and a PTY write, so an exported (and
// therefore assignable) table would let any module in the bundle overwrite the check away. The
// indirection costs nothing: a missing entry makes `isDispatchAuthority` refuse that kind outright,
// so a hole in the map surfaces as a well-formed authority being REFUSED, which is what these assert.
describe("the per-kind extra checks — total over the union, and not reachable to overwrite", () => {
  it("has a check for every declared kind, so no well-formed authority is refused", () => {
    for (const kind of DISPATCH_AUTHORITY_KINDS) {
      expect(isDispatchAuthority(SAMPLES[kind]), `${kind} has no extra-check entry`).toBe(true);
    }
  });

  it("still gates the one arm whose policy is the reason it is legal", () => {
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: "c" })).toBe(false);
    expect(isDispatchAuthority({ kind: "concierge-tool", toolCallId: "c", policy: "allow" })).toBe(
      true,
    );
  });

  // The map is not part of the module's surface. Nothing outside may hold a reference to it, because
  // a reference is a write: `AUTHORITY_EXTRA_CHECK["concierge-tool"] = () => true` disables the
  // policy check permanently, on a gate with nothing behind it.
  it("is not exported", () => {
    expect(dispatchAuthorityModule).not.toHaveProperty("AUTHORITY_EXTRA_CHECK");
    expect(dispatchAuthorityModule).not.toHaveProperty("AUTHORITY_REF_FIELD");
  });
});
