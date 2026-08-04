import { describe, expect, it } from "vitest";
import {
  CLAIM_FAMILIES,
  UNBACKED_CLAIM_CHECK_ID,
  backedFamilies,
  inRelativeClause,
  unbackedClaimCheck,
} from "./unbackedClaim";
import { CONCIERGE_TOOL_CATALOG } from "../../conciergeTools/policy";
import { lintReply } from "../index";
import { LINT_CHECK_IDS } from "../../../stores/conciergeLintMetrics";
import type { LintContext, LintPolicy, LintToolCall } from "../types";

/** This check at its shipped default (`warn`) and nothing else configured, so an assertion about a
 *  violation is an assertion about THIS check and not a neighbour that happens to fire too. */
function policy(over: Partial<{ severity: "block" | "warn" | "off"; enabled: boolean }> = {}): LintPolicy {
  return {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      [UNBACKED_CLAIM_CHECK_ID]: {
        enabled: over.enabled ?? true,
        severity: over.severity ?? "warn",
        autofix: false,
      },
    },
  };
}

function ctx(toolCalls: LintToolCall[] = [], over: Partial<LintContext> = {}): LintContext {
  return {
    roster: [],
    toolCalls,
    refusals: [],
    prevReply: null,
    policy: policy(),
    ...over,
  };
}

/** The SIDE EFFECT under test everywhere below: the violations the check emitted. Never "a helper
 *  was called" — see AGENTS.md, "Tests must assert the SIDE EFFECT, not the precondition". */
const run = (text: string, calls: LintToolCall[] = []) => unbackedClaimCheck.run(text, ctx(calls));
const details = (text: string, calls: LintToolCall[] = []) =>
  run(text, calls).violations.map((v) => v.detail);

/** A Sparkle dispatcher call as the harness really delivers it: the MCP wire name plus `input.op`.
 *  Every backed-family test goes through this shape, because a check that only recognises bare op
 *  names is inert in production (the failure `catalogNameFor`'s header records). */
const dispatch = (domain: string, op: string, args: Record<string, unknown> = {}): LintToolCall => ({
  name: `mcp__sparkle-control__sparkle_${domain}`,
  input: { op, ...args },
});

describe("unbackedClaim — said it did something, and made no call that could have done it", () => {
  // ══ THE SIX FAMILIES, BOTH SIDES ══════════════════════════════════════════════════════════════
  // Each family gets an UNBACKED reply (must fire) and a BACKED one (must not). Without the second
  // half the check would pass while flagging every honest receipt the concierge writes.
  const FAMILIES: {
    family: string;
    claim: string;
    backing: LintToolCall;
    label: string;
  }[] = [
    {
      family: "send",
      claim: "I sent the rebase instructions to CI Hardening.",
      backing: dispatch("terminal", "send_to_agent_terminal", { text: "rebase onto main" }),
      label: "send",
    },
    {
      family: "spawn",
      claim: "I spawned a worker on the disjoint file set.",
      backing: dispatch("lifecycle", "spawn_build_agent", { task: "lint core" }),
      label: "spawn",
    },
    {
      family: "close",
      claim: "I closed the agent and removed its worktree.",
      backing: dispatch("lifecycle", "close_agent", { agentId: "ag1" }),
      label: "close",
    },
    {
      family: "goal",
      claim: "I set its goal to landing the retry PR.",
      backing: { name: "mcp__sparkle-control__set_agent_goal", input: { goal: "land the retry PR" } },
      label: "goal update",
    },
    {
      family: "filed",
      claim: "I filed that as a bead.",
      backing: dispatch("board", "create_item", { title: "retry" }),
      label: "bead filing",
    },
    {
      family: "merged",
      claim: "I merged #864.",
      backing: dispatch("workflow", "merge_pr", { prNumber: 864 }),
      label: "merge",
    },
  ];

  for (const { family, claim, backing, label } of FAMILIES) {
    it(`fires on an unbacked ${family} claim`, () => {
      const { violations } = run(claim);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.check).toBe(UNBACKED_CLAIM_CHECK_ID);
      expect(violations[0]!.detail).toBe(`claimed a ${label} with no ${label} call`);
    });

    it(`stays silent when the turn actually made the ${family} call`, () => {
      expect(run(claim, [backing]).violations).toHaveLength(0);
    });

    it(`is not backed by a call from a DIFFERENT family (${family})`, () => {
      // The families are independent evidence. A turn that spawned something has not thereby
      // proved it also sent something, and a check that pooled the calls would clear a reply whose
      // most consequential claim is the unbacked one.
      const other = FAMILIES.find((f) => f.family !== family)!;
      expect(run(claim, [other.backing]).violations).toHaveLength(1);
    });
  }

  it("catches every family in one reply, one violation each", () => {
    const reply = FAMILIES.map((f) => f.claim).join(" ");
    expect(details(reply)).toEqual(FAMILIES.map((f) => `claimed a ${f.label} with no ${f.label} call`));
  });

  // ══ THE SUBJECT REQUIREMENT (A) ═══════════════════════════════════════════════════════════════
  it("requires an explicit first-person subject — a bare verb is not a claim", () => {
    for (const notAClaim of [
      "The message sent at 14:02.",
      "Closing notes are in the progress doc.",
      "Two agents were spawned by the orchestrator.",
      "The branch merged cleanly.",
      "Sent. The worker has it.",
    ]) {
      expect(run(notAClaim).violations, `must not fire: ${notAClaim}`).toHaveLength(0);
    }
  });

  it("accepts every subject form the grammar names, with and without the adverb", () => {
    for (const claim of [
      "I sent it.",
      "I've sent it.",
      "I have sent it.",
      "I just sent it.",
      "I already sent it.",
      "I've just sent it.",
      "I'm sending it.",
      "I am sending it.",
      "I'm now sending it.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
  });

  // ══ TENSE (B) — FUTURE IS OUT OF SCOPE ════════════════════════════════════════════════════════
  it("does not flag the FUTURE — a promise is a different mechanism", () => {
    // An unkept promise is a real failure, but its evidence is in the NEXT turn, which this check
    // cannot see. Flagging it here would be wrong on every promise the concierge then keeps.
    for (const promise of [
      "I'll send it to the worker.",
      "I will send it to the worker.",
      "I'm going to send it to the worker.",
      "I am going to merge #864 once CI is green.",
      "I'll spawn a worker for the migration.",
      "I will close it after the branch lands.",
    ]) {
      expect(run(promise).violations, `must not fire: ${promise}`).toHaveLength(0);
    }
  });

  it("POSITIVE CONTROL for the future rule: the same sentences in the past DO fire", () => {
    // The exclusion above is only meaningful if the check would otherwise have caught these. Without
    // this pair a check that never fired at all would pass the future test.
    for (const claim of [
      "I sent it to the worker.",
      "I merged #864 once CI was green.",
      "I spawned a worker for the migration.",
      "I closed it after the branch landed.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
  });

  // ══ EXCLUSION 1 — CONDITIONAL / OFFER ═════════════════════════════════════════════════════════
  it("excludes a CONDITIONAL or an OFFER — that is not a receipt", () => {
    for (const offer of [
      "I'm sending it if you confirm.",
      "I'm closing it unless you want it kept.",
      "I've filed the bead — want me to close it too?",
      "I'm merging it, should I wait for the second review?",
      "Shall I, or have I already spawned enough workers?",
      "Would you like the summary of what I merged?",
      "Say the word and I'm sending it.",
      "Let me know and I'm spawning two more.",
    ]) {
      expect(run(offer).violations, `must be excluded: ${offer}`).toHaveLength(0);
    }
  });

  it("POSITIVE CONTROL: the same sentences without the conditional DO fire", () => {
    for (const claim of [
      "I'm sending it now.",
      "I'm closing it.",
      "I've filed the bead.",
      "I'm merging it.",
      "I'm spawning two more.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
  });

  it("scopes the conditional exclusion to the claim's OWN sentence, not the paragraph", () => {
    // `proseSpans` emits one span per markdown text node — a whole paragraph. A paragraph-wide test
    // would let one incidental "if you" switch the check off for every claim beside it, which is the
    // masking bug roborev 55713 found next door in `askWithoutAction`.
    const reply = "I can hold the merge if you prefer. I sent the retry instructions to it.";
    expect(details(reply)).toEqual(["claimed a send with no send call"]);
  });

  // ══ EXCLUSION 2 — RELATIVE CLAUSE ═════════════════════════════════════════════════════════════
  it("excludes a claim inside a NOUN PHRASE — it refers to an earlier turn", () => {
    for (const phrase of [
      "The agent I spawned is still running.",
      "Every agent I spawned that week is landed.",
      "The ones I sent are all acknowledged.",
      "The bead I filed covers it.",
      "The PR I merged is the one you are looking at.",
      "The worker that I closed had no commits.",
      "Both branches I pushed are green.",
    ]) {
      expect(run(phrase).violations, `must be excluded: ${phrase}`).toHaveLength(0);
    }
  });

  it("POSITIVE CONTROL: the same verbs governing a MAIN clause DO fire", () => {
    for (const claim of [
      "I spawned an agent and it is still running.",
      "I sent them, and they are all acknowledged.",
      "I filed the bead that covers it.",
      "I merged the PR you are looking at.",
      "I pushed both branches; they are green.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
  });

  it("treats a coordinator or a connective before the pronoun as a MAIN clause", () => {
    // The exclusion keys off "a bare noun/determiner immediately precedes the pronoun". Coordinators
    // do too, positionally, so they are named explicitly — without that, "and I sent it" would be
    // read as a relative clause and half of all real claims would go silent.
    for (const claim of [
      "The branch is green and I merged it.",
      "It was blocked, so I closed it.",
      "The suite passed, then I merged it.",
      "It was stalled, therefore I closed it.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
    expect(inRelativeClause("the agent I spawned", "the agent ".length)).toBe(true);
    expect(inRelativeClause("and I spawned one", "and ".length)).toBe(false);
    expect(inRelativeClause("I spawned one", 0)).toBe(false);
    expect(inRelativeClause("It is done. I spawned one", "It is done. ".length)).toBe(false);
  });

  // ══ EXCLUSION 3 — PAST-TURN SCOPE ═════════════════════════════════════════════════════════════
  it("excludes a sentence scoped to an EARLIER turn — this check sees one turn's calls", () => {
    for (const past of [
      "I closed exactly one agent today.",
      "I sent that yesterday.",
      "I merged it earlier.",
      "I spawned two the last time you asked.",
      "I filed the bead this morning.",
      "I closed it this afternoon.",
      "I previously sent it to the same worker.",
      "I sent it before you asked.",
      "I spawned that one a few turns ago.",
    ]) {
      expect(run(past).violations, `must be excluded: ${past}`).toHaveLength(0);
    }
  });

  it("POSITIVE CONTROL: the same sentences without the past-time adverbial DO fire", () => {
    for (const claim of [
      "I closed exactly one agent.",
      "I sent that.",
      "I merged it.",
      "I spawned two.",
      "I filed the bead.",
    ]) {
      expect(run(claim).violations, `must fire: ${claim}`).toHaveLength(1);
    }
  });

  // ══ EXCLUSION 4 — NOT PROSE ═══════════════════════════════════════════════════════════════════
  it("does not fire inside a fenced block or an inline code span", () => {
    const fenced = ["Here is the transcript line:", "", "```", "I sent it to the worker.", "```"].join("\n");
    expect(run(fenced).violations).toHaveLength(0);
    expect(run("The linter matches `I sent` with an explicit subject.").violations).toHaveLength(0);
  });

  it("does not fire on the human's own words quoted back in a blockquote", () => {
    const quoted = ["You said:", "", "> I sent it to the worker.", "", "That was a different turn."].join("\n");
    expect(run(quoted).violations).toHaveLength(0);
  });

  it("POSITIVE CONTROL: the same sentence as ordinary prose DOES fire", () => {
    // Without this pair, a check whose `proseSpans` call returned nothing at all would pass both
    // exclusion tests above while being completely dead.
    expect(details("I sent it to the worker.")).toEqual(["claimed a send with no send call"]);
  });

  // ══ WHAT COUNTS AS BACKING ════════════════════════════════════════════════════════════════════
  it("accepts the MCP DISPATCHER shape, which is how every Sparkle call really arrives", () => {
    // The raw name is `mcp__sparkle-control__sparkle_terminal`; the operation is in `input.op`. A
    // check that compared the raw name would back nothing and would fire on every honest receipt.
    expect(backedFamilies([dispatch("terminal", "send_to_agent_terminal")])).toEqual(new Set(["send"]));
    expect(backedFamilies([dispatch("fleet", "inbox_broadcast")])).toEqual(new Set(["send"]));
    expect(backedFamilies([dispatch("lifecycle", "spin_down_worker")])).toEqual(new Set(["close"]));
    expect(backedFamilies([dispatch("workflow", "land_agent_branch")])).toEqual(new Set(["merged"]));
  });

  it("accepts a bare op name too, so a non-dispatcher call still backs its family", () => {
    expect(backedFamilies([{ name: "set_agent_goal_met", input: { met: true } }])).toEqual(
      new Set(["goal"]),
    );
  });

  it("accepts a shell call that really did the thing", () => {
    expect(run("I filed that as a bead.", [{ name: "Bash", input: { command: "bd create -t retry" } }]).violations).toHaveLength(0);
    expect(
      run("I filed that as a bead.", [
        { name: "Bash", input: { command: "scripts/file-retro-pain-point.sh --summary x" } },
      ]).violations,
    ).toHaveLength(0);
    expect(run("I merged #864.", [{ name: "Bash", input: { command: "gh pr merge 864 --merge" } }]).violations).toHaveLength(0);
    expect(run("I pushed the branch.", [{ name: "Bash", input: { command: "git push origin HEAD" } }]).violations).toHaveLength(0);
    // A bead close is a shell call too, and nothing in "I closed it" says whether the object was an
    // agent or a bead — so the shell call has to count, or an honest bead close is punished.
    expect(run("I closed it.", [{ name: "Bash", input: { command: "bd close sparkle-kr2jz" } }]).violations).toHaveLength(0);
  });

  it("does not let an unrelated shell call back a claim", () => {
    for (const command of ["git status", "ls -la", "pnpm test"]) {
      expect(
        run("I merged #864.", [{ name: "Bash", input: { command } }]).violations,
        `must still fire after: ${command}`,
      ).toHaveLength(1);
    }
    // And a shell call that DID push proves nothing about a send.
    expect(run("I sent it to the worker.", [{ name: "Bash", input: { command: "git push" } }]).violations).toHaveLength(1);
  });

  it("does not accept a READ as the receipt for a write", () => {
    const reads: LintToolCall[] = [
      dispatch("lifecycle", "preview_close", { agentId: "ag1" }),
      dispatch("terminal", "read_agent_terminal", { agentId: "ag1" }),
      dispatch("workflow", "agent_branch_status", { agentId: "ag1" }),
      { name: "Read", input: { file_path: "/x" } },
    ];
    expect(backedFamilies(reads)).toEqual(new Set());
    expect(run("I closed the agent.", reads).violations).toHaveLength(1);
  });

  // ══ MALFORMED INPUT — THIS CHECK MUST NEVER THROW ═════════════════════════════════════════════
  it("handles empty, missing and malformed tool calls without throwing", () => {
    expect(backedFamilies([])).toEqual(new Set());
    expect(backedFamilies(undefined)).toEqual(new Set());
    expect(backedFamilies([{ name: "", input: {} }, { name: "   ", input: null }])).toEqual(new Set());
    // A dispatcher with no `op`, a null input, a string input, an array input.
    expect(
      backedFamilies([
        { name: "mcp__sparkle-control__sparkle_terminal", input: {} },
        { name: "mcp__sparkle-control__sparkle_terminal", input: null },
        { name: "Bash", input: null },
        { name: "Bash", input: "git push" },
        { name: "Bash", input: [1, 2, 3] },
      ]),
    ).toEqual(new Set(["merged"]));

    // A circular input cannot be stringified; the check must survive it rather than take the whole
    // reply down with it (`lintReply` treats a thrown check as CLEAN, which would silently disable
    // this one — the failure is invisible, so it gets a test).
    const circular: Record<string, unknown> = { command: "git push" };
    circular.self = circular;
    expect(() => backedFamilies([{ name: "Bash", input: circular }])).not.toThrow();
    expect(backedFamilies([{ name: "Bash", input: circular }])).toEqual(new Set());

    expect(() => unbackedClaimCheck.run("I merged it.", ctx(undefined as never))).not.toThrow();
    expect(unbackedClaimCheck.run("", ctx()).violations).toEqual([]);
  });

  // ══ THE VIOLATION IS METADATA ONLY ════════════════════════════════════════════════════════════
  it("reports a character COUNT and a family name, never the reply's prose", () => {
    // `Violation.span` is documented as a count and the violation log refuses prose. A `detail` or a
    // `span` carrying the matched text would put concierge prose on disk.
    const { violations } = run("I sent the rebase instructions to CI Hardening.");
    const v = violations[0]!;
    expect(typeof v.span).toBe("number");
    expect(v.span).toBe("I sent".length);
    expect(v.action).toBe("warned");
    expect(v.severity).toBe("warn");
    expect(v.detail).toBe("claimed a send with no send call");
    expect(v.detail).not.toContain("CI Hardening");
    expect(v.detail).not.toContain("rebase");
  });

  it("leaves the reply text byte-identical — it never autofixes", () => {
    const reply = "I merged #864 and I sent the worker a note.";
    expect(unbackedClaimCheck.run(reply, ctx()).text).toBe(reply);
  });

  // ══ REGISTRATION AND POLICY PLUMBING ══════════════════════════════════════════════════════════
  it("runs through lintReply and does not block at its shipped severity", () => {
    const result = lintReply("I merged #864.", ctx());
    expect(result.violations.map((v) => v.check)).toContain(UNBACKED_CLAIM_CHECK_ID);
    // The design decision, asserted: a false positive here must cost the human nothing but a note.
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("I merged #864.");
  });

  it("is countable — an id the metrics store lacks is a permanent zero on the readout", () => {
    expect(LINT_CHECK_IDS).toContain(UNBACKED_CLAIM_CHECK_ID);
  });

  it("honours severity and enabled from the config, so a misfiring check is cheap to disable", () => {
    for (const off of [policy({ severity: "off" }), policy({ enabled: false })]) {
      const result = lintReply("I merged #864.", ctx([], { policy: off }));
      expect(result.violations.map((v) => v.check)).not.toContain(UNBACKED_CLAIM_CHECK_ID);
    }
  });

  it("names only real tools, so a family cannot silently stop being backable", () => {
    // The typed `ConciergeToolName` makes a rename a typecheck failure; this is the runtime mirror,
    // and it also catches a name that is real in the type but absent from the shipped catalog.
    const real = new Set<string>(CONCIERGE_TOOL_CATALOG.map((e) => e.name));
    for (const spec of CLAIM_FAMILIES) {
      const missing = spec.tools.filter((t) => !real.has(t));
      expect(missing, `${spec.family} names tools that are not in the catalog: ${missing.join(", ")}`).toEqual([]);
      expect(spec.tools.length, `${spec.family} has no backing tools at all`).toBeGreaterThan(0);
    }
  });
});
