// The AUTHORITY GATE at the text→PTY chokepoint — the runtime half of the forwarding-bug fix.
//
// See docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A1 and §4 ("Gate"). The other
// suites in this folder exercise DELIVERY and pass a valid authority to get past this check; this one
// is about the check itself. Its whole job is to pin two properties:
//
//   1. an un-authorized dispatch is REFUSED, and refused BEFORE anything is written; and
//   2. the refusal is FAIL-CLOSED — a malformed authority is not "close enough".
//
// Property 2 is the one worth having tests for. TypeScript already stops a call site that forgets
// `authority` outright, so every shape below is one the compiler cannot see: a JS consumer, an
// object rebuilt from a store round trip, a hand-written literal with the wrong id field. Those are
// exactly the paths a gate gets quietly widened on.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return { writePtyChainedStrict: vi.fn(async () => {}), submitPrompt: vi.fn(async () => {}), PtyGoneError };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]),
}));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import {
  DISPATCH_AUTHORITY_KINDS,
  conciergeToolAuthority,
  type DispatchAuthority,
} from "./dispatchAuthority";

/** One well-formed authority per kind, built from the union's OWN key list so a new arm added to
 *  `DispatchAuthority` shows up here as an undefined sample rather than as silent under-coverage. */
const SAMPLES: Record<string, DispatchAuthority> = {
  mention: { kind: "mention", agentId: "a1" },
  approval: { kind: "approval", proposalId: "p1" },
  countdown: { kind: "countdown", intentId: "i1" },
  // The concierge is mounted to this agent and the user pressed Send, so the send goes IMMEDIATELY
  // with no countdown. Skipping the countdown is not skipping the gate — this walk is what says so.
  mount: { kind: "mount", agentId: "a1" },
  redirect: { kind: "redirect", receiptId: "r1" },
  "nudge-approve": { kind: "nudge-approve", agentId: "a1" },
  suggestion: { kind: "suggestion", agentId: "a1" },
  // The one arm that is not a user GESTURE: it names the policy decision that permitted a concierge
  // tool call to write (services/conciergeTools/terminal). Both authorizing policies deliver; the
  // non-authorizing ones are unrepresentable and are pinned in dispatchAuthority.test.ts.
  // Built through the FACTORY, which is now the only thing that can build it: the arm's `policy` is
  // a branded stamp, so an inline literal no longer typechecks anywhere — including here.
  "concierge-tool": conciergeToolAuthority("call-1", { tier: "allow" })!,
  // The other non-gesture arm: goal auto-continue restarting a turn that ended with the goal unmet
  // (services/goalContinuationRunner). What makes it legal is the decision in
  // engine/goalContinuation, not anything on the authority — so the gate simply has to DELIVER for
  // it, which is what this walk asserts.
  "goal-continue": { kind: "goal-continue", agentId: "a1" },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("the gate — every declared gesture is accepted", () => {
  it("delivers under each of the union's kinds", async () => {
    for (const kind of DISPATCH_AUTHORITY_KINDS) {
      const authority = SAMPLES[kind];
      // A missing sample means the union grew and this suite did not. Fail loudly rather than
      // skipping the new arm — an untested authority is an ungated one.
      if (!authority) throw new Error(`no sample for authority kind "${kind}"`);
      const r = await dispatchConciergeAnswer("a1", "add retry logic", {
        authority,
        userPrompt: true,
      });
      expect(r.ok, `kind "${kind}" was refused`).toBe(true);
    }
  });
});

describe("the gate — an un-authorized dispatch is refused", () => {
  /** Every shape TypeScript can't stop. Cast at the boundary, exactly as a real JS caller would
   *  arrive: the point is that the RUNTIME refuses them. */
  const BAD: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a bare string", "countdown"],
    ["a number", 7],
    ["an empty object", {}],
    ["a kind with no id at all", { kind: "countdown" }],
    ["a kind whose id is blank", { kind: "countdown", intentId: "" }],
    ["a kind whose id is whitespace", { kind: "countdown", intentId: "   " }],
    ["a kind whose id is non-string", { kind: "countdown", intentId: 12 }],
    ["the id on the WRONG field", { kind: "countdown", agentId: "a1" }],
    // The one that matters most: the heuristic router's verdict has no arm in the union, and this
    // is what keeps it from acquiring one by improvisation at a call site.
    ["an invented 'router' kind", { kind: "router", agentId: "a1" }],
    ["a brain-initiated kind", { kind: "brain", agentId: "a1" }],
  ];

  for (const [name, authority] of BAD) {
    it(`refuses ${name} — and writes NOTHING`, async () => {
      const r = await dispatchConciergeAnswer("a1", "rm -rf build", {
        authority: authority as DispatchAuthority,
        userPrompt: true,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.path).toBe("unauthorized");
      // The assertion the refusal is actually FOR. A result object saying "unauthorized" while the
      // keystrokes had already gone into the PTY would be a gate in name only.
      expect(writePtyChainedStrict).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
    });
  }

  it("refuses BEFORE the emptiness check, so the reason it reports is the real one", async () => {
    // Empty text is also refusable, and it is checked immediately after the gate. If the order were
    // reversed an un-authorized empty send would report "empty" — a misleading audit line for the
    // more serious of the two problems.
    const r = await dispatchConciergeAnswer("a1", "   ", {
      authority: undefined as unknown as DispatchAuthority,
      userPrompt: true,
    });
    expect(r.ok === false && r.path).toBe("unauthorized");
  });
});
