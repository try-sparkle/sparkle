// THE TEST IS TWO-SIDED, and that is the founder's explicit acceptance criterion for this check.
//
// Every exclusion below is paired with a POSITIVE CONTROL: the same sentence with the exempting
// phrase removed, asserted to FIRE. Without that pair a check that never fired at all would pass
// every exclusion test in this file — the vacuous-test shape AGENTS.md names as the #1 fleet-wide
// finding. Read an `it(...)` block that only asserts `toHaveLength(0)` as unfinished.
import { describe, expect, it } from "vitest";
import {
  DEFECT_WITHOUT_DISPOSITION_CHECK_ID,
  defectWithoutDispositionCheck,
  hasNegativeSubject,
  sentenceIsExempt,
  tookDisposition,
} from "./defectWithoutDisposition";
import { tookAction } from "./askWithoutAction";
import { lintReply } from "../index";
import { LINT_CHECK_IDS } from "../../../stores/conciergeLintMetrics";
import type { LintContext, LintPolicy, LintToolCall } from "../types";

/** This check at its shipped default (`warn`) and nothing else configured, so an assertion about a
 *  violation is an assertion about THIS check and not a neighbour that happens to fire too. */
function policy(
  over: Partial<{ severity: "block" | "warn" | "off"; enabled: boolean }> = {},
): LintPolicy {
  return {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      [DEFECT_WITHOUT_DISPOSITION_CHECK_ID]: {
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

/** The SIDE EFFECT under test everywhere below: the violations the check emitted. */
const run = (text: string, calls: LintToolCall[] = []) =>
  defectWithoutDispositionCheck.run(text, ctx(calls));
const count = (text: string, calls: LintToolCall[] = []) => run(text, calls).violations.length;

/** A Sparkle dispatcher call as the harness really delivers it: the MCP wire name plus `input.op`.
 *  Every disposition test goes through this shape, because a check that only recognises bare op
 *  names is inert in production (the failure `catalogNameFor`'s header records). */
const dispatch = (domain: string, op: string, args: Record<string, unknown> = {}): LintToolCall => ({
  name: `mcp__sparkle-control__sparkle_${domain}`,
  input: { op, ...args },
});

/** ONE defect assertion, used for every disposition case so the only variable is the tool calls. */
const DEFECT = "There is a bug in the plan-approval path: the pill never fires.";

/**
 * THE REAL MISS, RECONSTRUCTED. The concierge diagnosed a plan-approval prompt that raises no pill,
 * traced it to `workerRollup.ts`, and filed nothing.
 *
 * Written as ONE sentence (an em dash is not a sentence terminator) so it also pins the
 * one-violation-per-asserted-defect rule: two frames match here — `negative behaviour` on "never
 * fires" and `attribution` on "traced it to" — and the check must report the defect once.
 */
const RECONSTRUCTED_MISS =
  "The plan-approval prompt never fires a pill — I traced it to workerRollup.ts, where the " +
  "rollup only counts agents whose status is needs_input.";

/** Calls that READ and change nothing. The originating turn's investigation, in the shape the
 *  harness delivers it. */
const READ_ONLY: LintToolCall[] = [
  dispatch("workflow", "agent_branch_status", { agentId: "ag1" }),
  dispatch("terminal", "read_agent_terminal", { agentId: "ag1" }),
  { name: "Read", input: { file_path: "apps/desktop/src/stores/workerRollup.ts" } },
  { name: "Grep", input: { pattern: "needs_input" } },
];

describe("defectWithoutDisposition — named a defect and attached nothing to it", () => {
  // ══ SIDE ONE: IT FIRES ════════════════════════════════════════════════════════════════════════
  it("fires on a defect assertion when the turn made NO tool calls at all", () => {
    const { violations } = run(DEFECT);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.check).toBe(DEFECT_WITHOUT_DISPOSITION_CHECK_ID);
    expect(violations[0]!.detail).toBe(
      "asserted a defect (existence) with no bead, agent, or stated reason",
    );
  });

  it("fires on the REAL MISS reconstructed — a diagnosis whose only calls are READ-ONLY", () => {
    // The turn this check exists for: it investigated, it was right, and it recorded nothing.
    const { violations } = run(RECONSTRUCTED_MISS, READ_ONLY);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.check).toBe(DEFECT_WITHOUT_DISPOSITION_CHECK_ID);
  });

  it("fires with NO QUESTION anywhere in the reply — the miss contained no interrogative", () => {
    // `ask-without-action` keys entirely on OFFER_PATTERNS ("want me to", "should I", "let me know
    // if"), all of which are interrogative. Pinning the absence of a `?` makes it impossible to
    // "fix" this check later by quietly reintroducing a question requirement.
    expect(RECONSTRUCTED_MISS).not.toContain("?");
    expect(count(RECONSTRUCTED_MISS, READ_ONLY)).toBe(1);
  });

  it("fires where ask-without-action returns clean — a WRITE is not a disposition", () => {
    // The second confirmed reason the existing check missed this. `askWithoutAction` bails at
    // `if (tookAction(ctx.toolCalls))`, and `tookAction` accepts any state-changing call. Closing an
    // agent is a real write and does nothing about a defect the reply just named.
    const wrote = [
      dispatch("lifecycle", "close_agent", { agentId: "ag1" }),
      dispatch("workflow", "merge_pr", { prNumber: 864 }),
      { name: "mcp__sparkle-control__set_agent_goal", input: { goal: "land it" } },
    ];
    expect(tookAction(wrote), "precondition: these ARE actions to ask-without-action").toBe(true);
    expect(tookDisposition(wrote)).toBe(false);
    expect(count(DEFECT, wrote)).toBe(1);
  });

  it("fires on every frame in the grammar", () => {
    for (const assertion of [
      "There is a bug in the rollup.",
      "There was a race between the two writers.",
      "The pill is broken.",
      "That's a regression.",
      "It is a no-op.",
      "This is dead code.",
      "The guard is inert.",
      "The bug is in the status filter.",
      "The root cause is the status filter.",
      "I traced it to the rollup selector.",
      "The pill never fires.",
      "The guard does not fire on a plan approval.",
      "The rollup no longer surfaces those rows.",
      "A plan-approval prompt raises no pill.",
      "The listener is not wired.",
      "The guard misfires on an empty roster.",
      "The shard is failing.",
      "The gate fails to reject an empty body.",
      "The renderer crashes on a null roster.",
      "The watcher leaks a handle per reconnect.",
    ]) {
      expect(count(assertion), `must fire: ${assertion}`).toBe(1);
    }
  });

  // ══ SIDE TWO: A DISPOSITION CLEARS IT ═════════════════════════════════════════════════════════
  it("passes when the same defect text ALSO filed a bead", () => {
    expect(count(DEFECT, [{ name: "Bash", input: { command: "bd create -t 'plan approval pill'" } }])).toBe(0);
    expect(count(DEFECT, [dispatch("board", "create_item", { title: "plan approval pill" })])).toBe(0);
  });

  it("passes when the same defect text ALSO spawned an agent", () => {
    expect(count(DEFECT, [dispatch("lifecycle", "spawn_build_agent", { task: "fix the pill" })])).toBe(0);
  });

  // ══ THE ORIGINATING MISS ITSELF — A MESSAGE IS NOT A DISPOSITION ══════════════════════════════
  // The reply that prompted this check messaged an existing agent and filed nothing. The founder's
  // brief listed a message as a valid disposition, which would have exempted exactly that turn; asked
  // to choose, he ruled that a newly-asserted defect needs a bead or a spawn. This is that ruling as
  // a test, and it is the case the whole check exists for — if it ever goes green at 0, the check has
  // stopped covering the failure it was built for.
  it("FIRES when the turn only messaged an agent and filed nothing", () => {
    expect(
      count(DEFECT, [dispatch("terminal", "send_to_agent_terminal", { text: "the pill never fires" })]),
    ).toBe(1);
    expect(count(DEFECT, [dispatch("fleet", "inbox_send", { text: "have a look" })])).toBe(1);
  });

  it("passes when a message is accompanied by a bead — messaging is fine IN ADDITION", () => {
    expect(
      count(DEFECT, [
        dispatch("terminal", "send_to_agent_terminal", { text: "the pill never fires" }),
        { name: "Bash", input: { command: "bd create -t 'plan approval pill'" } },
      ]),
    ).toBe(0);
  });

  it("names exactly two families as a disposition — and no others", () => {
    // The design decision, asserted rather than left implicit: closing, merging, setting a goal and
    // SENDING are real writes and none of them puts a defect anywhere a human finds it again. If a
    // later edit widens `tookDisposition` back to include `send`, this fails.
    expect(tookDisposition([dispatch("board", "create_item", { title: "x" })])).toBe(true);
    expect(tookDisposition([dispatch("lifecycle", "spawn_build_agent", { task: "x" })])).toBe(true);
    expect(tookDisposition([dispatch("terminal", "send_to_agent_terminal", { text: "x" })])).toBe(false);
    expect(tookDisposition([dispatch("fleet", "inbox_send", { text: "x" })])).toBe(false);
    expect(tookDisposition([dispatch("lifecycle", "close_agent", { agentId: "a" })])).toBe(false);
    expect(tookDisposition([dispatch("workflow", "merge_pr", { prNumber: 1 })])).toBe(false);
    expect(tookDisposition([{ name: "mcp__sparkle-control__set_agent_goal", input: { goal: "x" } }])).toBe(false);
    expect(tookDisposition(READ_ONLY)).toBe(false);
    expect(tookDisposition([])).toBe(false);
    expect(tookDisposition(undefined)).toBe(false);
  });

  // ══ EXCLUSION A — ALREADY HANDLED (the founder's constraint 4) ═════════════════════════════════
  it("passes the founder's named sentence verbatim, with empty toolCalls", () => {
    // VERBATIM, as he wrote it. It passes on two independent grounds and both are asserted: the
    // grammar does not read a bare noun phrase as an assertion that a defect EXISTS, and — the part
    // that would still hold if the grammar widened — the sentence is exempt as already handled.
    const SENTENCE = "The TypeScript error, already fixed on main.";
    expect(count(SENTENCE)).toBe(0);
    expect(sentenceIsExempt(SENTENCE)).toBe(true);
  });

  it("excludes an ALREADY-HANDLED defect", () => {
    for (const handled of [
      "There is a bug in the rollup, already fixed on main.",
      "There is a bug in the rollup — it was fixed by the pill branch.",
      "The pill is broken, but that landed on main this morning.",
      "The guard does not fire; known issue.",
      "The pill never fires — covered by sparkle-ugohl.",
      "The pill never fires, already tracked as a bead.",
      "There is a regression in the rollup, tracked under the lint epic.",
      "The pill never fires; that already has a bead.",
      "The guard is broken and PR #1315 fixes it.",
    ]) {
      expect(count(handled), `must be excluded: ${handled}`).toBe(0);
    }
  });

  it("POSITIVE CONTROL: the same sentences without the already-handled tail DO fire", () => {
    // Without this pair the exclusion test above would pass against a check that never fires.
    for (const bare of [
      "There is a bug in the rollup.",
      "The pill is broken.",
      "The guard does not fire.",
      "The pill never fires.",
      "There is a regression in the rollup.",
    ]) {
      expect(count(bare), `must fire: ${bare}`).toBe(1);
    }
  });

  // ══ EXCLUSION B — A STATED REASON FOR NOT ACTING (constraint 2) ════════════════════════════════
  it("excludes a defect with a STATED REASON for not acting, with empty toolCalls", () => {
    for (const declined of [
      "There is a bug in the rollup, but it is not worth filing — it only affects the empty roster.",
      "The pill never fires for a plan approval, and that is by design.",
      "The guard does not fire on an empty roster; that is intentional.",
      "The rollup is a no-op for cloud agents deliberately.",
      "The pill never fires there — working as intended.",
      "The guard does not fire on a preview, which is expected behaviour.",
      "The counter is broken only in the sense that it rounds down; that is not a bug.",
      "There is a bug in the rollup and I am not filing it: the surface is being deleted this week.",
      "The pill never fires on a stale row — leaving it, no bead.",
    ]) {
      expect(count(declined), `must be excluded: ${declined}`).toBe(0);
    }
  });

  it("POSITIVE CONTROL: the same sentences without the stated reason DO fire", () => {
    for (const bare of [
      "There is a bug in the rollup.",
      "The pill never fires for a plan approval.",
      "The guard does not fire on an empty roster.",
      "The rollup is a no-op for cloud agents.",
      "The counter is broken.",
    ]) {
      expect(count(bare), `must fire: ${bare}`).toBe(1);
    }
  });

  // ══ EXCLUSION C — HYPOTHETICAL / CONDITIONAL / FUTURE ═════════════════════════════════════════
  it("excludes a HYPOTHETICAL — an assertion is present or past indicative", () => {
    for (const hypothetical of [
      "If it were broken the pill would be missing.",
      "That could regress once the rollup moves.",
      "This might be a bug in the selector.",
      "The pill may be broken under a fast reconnect.",
      "Reordering those two would break the rollup.",
      "Whether the guard fires is not something the pill never tells us.",
      "Unless the status is set, the pill never fires.",
      "The rollup will break if the status enum grows.",
    ]) {
      expect(count(hypothetical), `must be excluded: ${hypothetical}`).toBe(0);
    }
  });

  it("POSITIVE CONTROL: the indicative forms of those sentences DO fire", () => {
    for (const indicative of [
      "It is broken and the pill is missing.",
      "That regressed once the rollup moved: the pill never fires.",
      "This is a bug in the selector.",
      "The pill is broken under a fast reconnect.",
      "The rollup is broken now that the status enum grew.",
    ]) {
      expect(count(indicative), `must fire: ${indicative}`).toBe(1);
    }
  });

  // ══ EXCLUSION D — THE HUMAN'S OWN CLAIM ═══════════════════════════════════════════════════════
  it("excludes a defect ATTRIBUTED to the human", () => {
    for (const attributed of [
      "You said the pill never fires on a plan approval.",
      "You reported that the rollup is broken.",
      "You're seeing a bug in the plan-approval path.",
      "Your report says the guard does not fire.",
    ]) {
      expect(count(attributed), `must be excluded: ${attributed}`).toBe(0);
    }
  });

  it("excludes the human's words quoted back in a blockquote", () => {
    const quoted = ["You wrote:", "", "> There is a bug in the rollup.", "", "Here is what I found."].join("\n");
    expect(count(quoted)).toBe(0);
  });

  it("POSITIVE CONTROL: the same claims in the concierge's own voice DO fire", () => {
    for (const own of [
      "The pill never fires on a plan approval.",
      "The rollup is broken.",
      "There is a bug in the plan-approval path.",
      "The guard does not fire.",
    ]) {
      expect(count(own), `must fire: ${own}`).toBe(1);
    }
  });

  // ══ EXCLUSION E — NOT PROSE ═══════════════════════════════════════════════════════════════════
  it("does not fire inside a fenced block or an inline code span", () => {
    const fenced = ["From the log:", "", "```", "There is a bug in the rollup.", "```"].join("\n");
    expect(count(fenced)).toBe(0);
    expect(count("The pattern matches `there is a bug` in prose only.")).toBe(0);
  });

  // ══ NO DEFECT ASSERTION AT ALL ════════════════════════════════════════════════════════════════
  it("stays silent on a reply that asserts no defect", () => {
    for (const clean of [
      "Three agents are running and two are waiting on you.",
      "The suite is green: 14,753 passed, 0 failed.",
      "I filed the bead and moved the epic to ready.",
      "The bug bead is at the top of the ready queue.",
      "Regression tests cover the rollup selector now.",
      "There is no bug in the rollup — the pill was suppressed by the filter you set.",
      "That is not broken; the row is collapsed.",
      "Nothing is broken there.",
      "The branch is stale by 53 commits, so rebase before you verify.",
      "The check does not run when its severity is off.",
    ]) {
      expect(count(clean), `must stay silent: ${clean}`).toBe(0);
    }
  });

  it("does not fire on a NEGATIVE SUBJECT — the concierge saying nothing is wrong", () => {
    // The one false positive this grammar produced in development, and the worst direction to be
    // wrong in: it fired on the replies that had nothing to report. `FILLER`'s lookahead guards what
    // comes AFTER the frame and cannot see the subject.
    for (const fine of [
      "Nothing is broken there.",
      "None was broken by that merge.",
      "Nothing is a no-op here.",
      "Neither is broken.",
    ]) {
      expect(count(fine), `must stay silent: ${fine}`).toBe(0);
    }
    expect(hasNegativeSubject("Nothing is broken", "Nothing ".length)).toBe(true);
    expect(hasNegativeSubject("The rollup is broken", "The rollup ".length)).toBe(false);
    expect(hasNegativeSubject("is broken", 0)).toBe(false);
  });

  it("POSITIVE CONTROL: the same predicates with a real subject DO fire", () => {
    // Without this the negative-subject guard could be widened until it silenced everything.
    for (const bare of [
      "The rollup is broken there.",
      "The selector was broken by that merge.",
      "The handler is a no-op here.",
      "The guard is broken.",
    ]) {
      expect(count(bare), `must fire: ${bare}`).toBe(1);
    }
  });

  // ══ SCOPING AND COUNTING ══════════════════════════════════════════════════════════════════════
  it("scopes every exemption to the assertion's OWN sentence, not the paragraph", () => {
    // roborev 55713, a High that has recurred twice in this folder: `proseSpans` emits one span per
    // markdown text node — a whole paragraph — so a paragraph-wide test lets one incidental "already
    // fixed" anywhere switch the check off for every assertion beside it.
    const reply = "The import cycle is already fixed on main. There is a bug in the plan-approval path.";
    expect(count(reply)).toBe(1);
    const reverse = "There is a bug in the plan-approval path. The import cycle is already fixed on main.";
    expect(count(reverse)).toBe(1);
  });

  it("reports ONE violation per asserted defect, even when several frames match one sentence", () => {
    // `negative behaviour` and `attribution` both match RECONSTRUCTED_MISS. Counting it twice would
    // overstate a number the human is meant to trust.
    expect(count(RECONSTRUCTED_MISS)).toBe(1);
    // …and two DIFFERENT sentences are two findings.
    expect(count("There is a bug in the rollup. The guard is inert.")).toBe(2);
  });

  // ══ THE VIOLATION IS METADATA ONLY ════════════════════════════════════════════════════════════
  it("reports a character COUNT and a frame name, never the reply's prose", () => {
    const { violations } = run("The plan-approval pill never fires for CI Hardening.");
    const v = violations[0]!;
    expect(typeof v.span).toBe("number");
    expect(v.span).toBe("never fires".length);
    expect(v.action).toBe("warned");
    expect(v.severity).toBe("warn");
    expect(v.detail).toBe("asserted a defect (negative behaviour) with no bead, agent, or stated reason");
    expect(v.detail).not.toContain("CI Hardening");
    expect(v.detail).not.toContain("plan-approval");
  });

  it("stamps action \"warned\" even at severity block — nothing revises a reply yet", () => {
    // roborev 55981, non-negotiable: `"revised"` claims a correction the app never made, and it
    // would read as a 100% correction rate in the rollup this log exists to make trustworthy.
    const blocking = defectWithoutDispositionCheck.run(DEFECT, ctx([], { policy: policy({ severity: "block" }) }));
    expect(blocking.violations[0]!.severity).toBe("block");
    expect(blocking.violations[0]!.action).toBe("warned");
  });

  it("leaves the reply text byte-identical — it never autofixes", () => {
    expect(defectWithoutDispositionCheck.run(DEFECT, ctx()).text).toBe(DEFECT);
  });

  // ══ MALFORMED INPUT — THIS CHECK MUST NEVER THROW ═════════════════════════════════════════════
  it("handles empty, missing and malformed input without throwing", () => {
    expect(() => defectWithoutDispositionCheck.run(DEFECT, ctx(undefined as never))).not.toThrow();
    expect(defectWithoutDispositionCheck.run("", ctx()).violations).toEqual([]);
    expect(() => run(DEFECT, [{ name: "", input: null }, { name: "   ", input: undefined }])).not.toThrow();
    const circular: Record<string, unknown> = { command: "bd create" };
    circular.self = circular;
    // A circular input cannot be stringified, so it backs nothing — the check must still run rather
    // than throw (`lintReply` treats a thrown check as CLEAN, which would silently disable it).
    expect(count(DEFECT, [{ name: "Bash", input: circular }])).toBe(1);
  });

  it("does not leak regex state between replies", () => {
    // The patterns are module-level and carry `g`; a missed `lastIndex` reset makes the SECOND
    // identical reply score clean, which is the worst possible failure for a check that runs once
    // per turn for the life of the process.
    for (let i = 0; i < 5; i++) expect(count(DEFECT), `run ${i}`).toBe(1);
  });

  // ══ REGISTRATION AND POLICY PLUMBING ══════════════════════════════════════════════════════════
  it("runs through lintReply and does not block at its shipped severity", () => {
    const result = lintReply(DEFECT, ctx());
    expect(result.violations.map((v) => v.check)).toContain(DEFECT_WITHOUT_DISPOSITION_CHECK_ID);
    // Shipped `warn` on purpose: `lintReply` computes `blocked` and no production caller reads it,
    // so shipping `block` would promise a gate the app does not have.
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(DEFECT);
  });

  it("is countable — an id the metrics store lacks is a permanent zero on the readout", () => {
    expect(LINT_CHECK_IDS).toContain(DEFECT_WITHOUT_DISPOSITION_CHECK_ID);
  });

  it("honours severity and enabled from the config, so a misfiring check is cheap to disable", () => {
    for (const off of [policy({ severity: "off" }), policy({ enabled: false })]) {
      const result = lintReply(DEFECT, ctx([], { policy: off }));
      expect(result.violations.map((v) => v.check)).not.toContain(DEFECT_WITHOUT_DISPOSITION_CHECK_ID);
    }
  });
});
