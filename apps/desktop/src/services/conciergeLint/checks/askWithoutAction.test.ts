import { describe, expect, it } from "vitest";
import {
  ASK_WITHOUT_ACTION_CHECK_ID,
  EXEMPT_RISK_CLASSES,
  EXEMPT_SYNONYMS,
  VIEW_ONLY_OPS,
  NON_ACTING_RISK_CLASSES,
  askWithoutActionCheck,
  exemptToolNames,
  sentenceAround,
  tookAction,
} from "./askWithoutAction";
import { CONCIERGE_TOOL_CATALOG } from "../../conciergeTools/policy";
import { conciergeOpWrites } from "../../conciergeTools/registry";
import { lintReply } from "../index";
import type { LintContext, LintPolicy, LintToolCall } from "../types";

/** Policy with this check at its shipped default (`block`) and everything else off, so a test
 *  asserting a block is asserting THIS check and not a neighbour. */
function policy(over: Partial<{ severity: "block" | "warn" | "off"; enabled: boolean }> = {}): LintPolicy {
  return {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      [ASK_WITHOUT_ACTION_CHECK_ID]: {
        enabled: over.enabled ?? true,
        severity: over.severity ?? "block",
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

const run = (text: string, calls: LintToolCall[] = []) =>
  askWithoutActionCheck.run(text, ctx(calls));

describe("askWithoutAction — the reply that investigated and then handed the decision back", () => {
  it("every VIEW_ONLY_OP is a real catalog op — the list cannot rot silently", () => {
    // The list names ops by string, so a rename in the catalog would leave a dead entry here and
    // silently restore the bug it exists to prevent (a viewport move scoring as action).
    const known = new Set<string>(CONCIERGE_TOOL_CATALOG.map((t) => t.name));
    expect(VIEW_ONLY_OPS.filter((op) => !known.has(op))).toEqual([]);
  });

  it("defers to the DISPATCHER's write classification, so a new preview op needs no list edit", () => {
    // The completeness a hand-list cannot have (roborev 56103). `LIFECYCLE_WRITE` is a
    // `Record<Op, boolean>`, so a new preview op is a typecheck failure over there and is correct
    // here for free. Asserted through the exported helper rather than by re-listing the ops.
    expect(conciergeOpWrites("lifecycle", "preview_close")).toBe(false);
    expect(conciergeOpWrites("lifecycle", "close_agent")).toBe(true);
    expect(conciergeOpWrites("nonsense-domain", "whatever")).toBeUndefined();
  });

  it("does not count a VIEWPORT move as action", () => {
    // `select_project` → `capture_agent` → offer. The screenshot domain's own refusal instructs the
    // concierge to select a project before re-attempting a capture, so this sequence is prescribed
    // by the tools — and neither call does any work toward the offer. Both are classified `routine`
    // (workspace) and `privacy-sensitive` (screenshot), so only VIEW_ONLY_OPS keeps this firing.
    const result = lintReply(
      "Looked at the board. Want me to merge #864?",
      ctx([
        {
          name: "mcp__sparkle-control__sparkle_workspace",
          input: { op: "select_project", projectId: "p1" },
        },
        {
          name: "mcp__sparkle-control__sparkle_screenshot",
          input: { op: "capture_agent", agentId: "ag1" },
        },
      ]),
    );
    expect(result.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  it("does not count subscribing to the event cursor as action", () => {
    // The concierge brain is one process per turn, so a turn with no cursor MUST subscribe before it
    // can read. `events.ts` calls these "nothing but a cursor in this process's memory" — the
    // registry's `write` bit says otherwise because it answers the APPROVAL question (roborev 56111).
    const result = lintReply(
      "Agent CI Hardening finished. Want me to merge #864?",
      ctx([
        { name: "mcp__sparkle-control__sparkle_events", input: { op: "subscribe", kinds: ["agent"] } },
        { name: "mcp__sparkle-control__sparkle_events", input: { op: "read_events" } },
      ]),
    );
    expect(result.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  it("keeps ALL THREE preference writes out of VIEW_ONLY_OPS, not just the one with a row", () => {
    // The doc comment excludes three; the behavioural row below drives only `set_theme`. Since
    // VIEW_ONLY_OP_SET is consulted before both conciergeOpWrites and RISK_BY_TOOL — and these are
    // `app`-domain tools that bypass the dispatcher entirely — re-adding `set_zoom` or
    // `unpin_agent` is a one-line edit that silently restores a BLOCKING false positive with the
    // suite still green. The rot guard cannot catch it either: they are real catalog ops.
    // So the exclusion is an assertion, not a comment (roborev 56118).
    for (const op of ["set_theme", "set_zoom", "unpin_agent"]) {
      expect(VIEW_ONLY_OPS, `${op} writes durable preferences — it is not a viewport move`).not.toContain(op);
    }
  });

  it("treats a PREFERENCE write as acting — it is not a viewport move", () => {
    // The mirror guard, and it pins a regression rather than a hypothetical: a draft of
    // VIEW_ONLY_OPS included set_theme/set_zoom/unpin_agent, which write durable human-observable
    // state. That made "did what you asked, now offering the next step" — explicitly fine per
    // `run()` — into a BLOCKING false positive, the costly error this module's header names.
    const result = lintReply(
      "Switched you to dark mode. Want me to bump the zoom too?",
      ctx([{ name: "mcp__sparkle-control__set_theme", input: { theme: "dark" } }]),
    );
    expect(result.violations.map((v) => v.check)).not.toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  it("treats a preview op as NOT acting, so preview-then-ask still fires", () => {
    // The canonical turn: the shipped sparkle_lifecycle description tells the concierge to use
    // preview_close BEFORE close_agent, so this is the flow the tool prescribes.
    const result = lintReply(
      "The worktree is clean and the branch is landed. Want me to close it?",
      ctx([
        {
          name: "mcp__sparkle-control__sparkle_lifecycle",
          input: { op: "preview_close", agentId: "ag1" },
        },
      ]),
    );
    expect(result.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  it("still treats close_agent as acting, though it is `routine` too", () => {
    // The other side of the same word: close_agent removes worktrees. If the non-acting rules were widened
    // to "everything routine", this would go silent.
    const result = lintReply(
      "Closed the agent. Want me to close the other three?",
      ctx([
        { name: "mcp__sparkle-control__sparkle_lifecycle", input: { op: "close_agent", agentId: "ag1" } },
      ]),
    );
    expect(result.violations.map((v) => v.check)).not.toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  // ══ THE CASE FROM THE INCIDENT ═══════════════════════════════════════════════════════════════
  // The literal reply ending, twenty minutes after the fourth "default to action", with 45+
  // branches holding unlanded work and no tool call in the turn.
  it("fires on \"Want me to run that?\" when the turn took no action", () => {
    const { violations } = run(
      "45 branches are holding unlanded work. The fix is a single sweep. Want me to run that?",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.check).toBe(ASK_WITHOUT_ACTION_CHECK_ID);
    expect(violations[0]!.severity).toBe("block");
    expect(violations[0]!.detail).toContain("want me to");
  });

  it("blocks the reply end-to-end through lintReply, not merely records a note", () => {
    const result = lintReply("The obvious next step is a rebase. Should I do it?", ctx());
    // THE SIDE EFFECT: `blocked` is what forces the revision. Asserting only that a violation was
    // recorded would pass against a build where nothing acted on it.
    expect(result.blocked).toBe(true);
    expect(result.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);
  });

  // ══ THE SECOND HALF OF THE TEST — required by the spec ════════════════════════════════════════
  it("does NOT fire when the turn contained a spawn", () => {
    const { violations } = run(
      "Spawned four workers on the disjoint file sets. Want me to fan out further?",
      [{ name: "spawn_build_agent", input: { task: "lint core" } }],
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT fire when the turn contained a send", () => {
    const { violations } = run(
      "Sent the retry instructions along. Should I also narrow its task?",
      [{ name: "send_to_agent_terminal", input: { text: "rebase onto main" } }],
    );
    expect(violations).toHaveLength(0);
  });

  it("still fires when the turn only READ — investigating is not acting", () => {
    // The exact shape of the failure: the concierge went and looked, then stopped short.
    const readOnly: LintToolCall[] = [
      { name: "project_open_prs", input: {} },
      { name: "agent_branch_status", input: {} },
      { name: "get_state", input: {} },
      { name: "Read", input: { file_path: "/x" } },
      { name: "Grep", input: { pattern: "x" } },
    ];
    const { violations } = run("I checked all 45 branches. Want me to land them?", readOnly);
    expect(violations).toHaveLength(1);
  });

  it("treats a screen capture as reading, not acting", () => {
    const { violations } = run("Here is what the column shows. Shall I fix it?", [
      { name: "capture_window", input: {} },
    ]);
    expect(violations).toHaveLength(1);
  });

  // ══ THE EXEMPTION, KEYED OFF TOOL IDENTITY ═══════════════════════════════════════════════════
  // NOTE ON SCOPING: the exemption reads the OFFER'S OWN SENTENCE, so a bare trailing "Want me to?"
  // whose action sits in the previous sentence DOES fire. That is deliberate and it is the safe
  // direction — the remedy is for the concierge to name what it is asking about ("Should I delete the
  // branch?"), which is better copy and much harder to game than a detached pronoun. The companion
  // test below pins the firing case.
  it("exempts a genuine question about an irreversible or spend-bearing action", () => {
    for (const legit of [
      "The tag is ready. Want me to publish the release?",
      "Shall I spawn a cloud agent for it — that spends real money?",
      "Want me to discard the agent and its worktree?",
      "Should I quit the app to clear it?",
    ]) {
      expect(run(legit).violations, `must be exempt: ${legit}`).toHaveLength(0);
    }
  });

  it("does NOT exempt a merge — mutates-main is deliberately outside the exemption", () => {
    // The most expensive instance of the failure. If `mutates-main` were exempt, the main case this
    // check exists for would be uncovered, so this test pins the exclusion.
    expect(EXEMPT_RISK_CLASSES).not.toContain("mutates-main");
    const { violations } = run("PR #864 is green. Want me to merge it?");
    expect(violations).toHaveLength(1);
  });

  it("does not exempt the reversible classes the rule is aimed at", () => {
    for (const cls of ["disruptive", "rewrites-branch", "routine"] as const) {
      expect(EXEMPT_RISK_CLASSES).not.toContain(cls);
    }
    // `refresh_agent_branch` is rewrites-branch and recoverable; asking about it is the failure.
    expect(run("The branch is 28 behind. Want me to refresh it?").violations).toHaveLength(1);
  });

  // ══ THE SCOPING BUG (roborev 55713, High) ════════════════════════════════════════════════════
  // The exemption used to be tested against the whole prose SPAN, which `proseSpans` emits per
  // markdown text node — a whole paragraph. With single-word English keys, an incidental mention
  // anywhere in the paragraph switched the check off. These are the cases that prove it is scoped to
  // the offer's own sentence now; every one of them was silently exempt before.
  it("fires when the exempt word is in a DIFFERENT sentence from the offer", () => {
    for (const reply of [
      // The reviewer's example: `push` exempted the offer to merge.
      "PR #864 is green, I can push the merge commit once CI settles. Want me to merge it?",
      "That would save you a round trip. Want me to run it?",
      "The cloud worker finished. Should I land it?",
      "Deleting the old branch is a separate question. Want me to rebase this one?",
      "The release notes mention it. Want me to refresh the branch?",
    ]) {
      expect(run(reply).violations, `must still fire: ${reply}`).toHaveLength(1);
    }
  });

  it("still exempts when the offer's OWN sentence names the irreversible action", () => {
    for (const reply of [
      "CI is green and the tag is cut. Want me to publish the release?",
      "The worker is merged. Should I delete its branch?",
      "That would discard the agent and its worktree — shall I?",
      "Everything is landed. Want me to remove the project from the sidebar?",
    ]) {
      expect(run(reply).violations, `must be exempt: ${reply}`).toHaveLength(0);
    }
  });

  it("fires on a DETACHED offer whose action sits in the previous sentence", () => {
    // The other side of the scoping decision, pinned so nobody "fixes" it back into a
    // previous-sentence window — that window would re-exempt the reviewer's `cloud worker` case.
    for (const detached of [
      "This would remove the project from your sidebar. Want me to?",
      "That would delete the branch and its findings. Should I?",
    ]) {
      expect(run(detached).violations, `must fire: ${detached}`).toHaveLength(1);
    }
  });

  // ══ MASKING WITHIN ONE PATTERN (roborev 55734, Medium) ═══════════════════════════════════════
  it("an exempt offer does not mask a later NON-exempt offer using the SAME phrase", () => {
    // `re.exec` on a non-global regex returns match #1 only, so the exempt "publish" offer used to
    // suppress the merge offer entirely — zero violations for a reply whose second half is the exact
    // failure the check exists for. The existing multi-phrase test used two DIFFERENT phrases and so
    // could not catch this.
    const both = "Want me to publish the release? And want me to merge #864 while it is green?";
    expect(run(both).violations).toHaveLength(1);
    expect(lintReply(both, ctx()).blocked).toBe(true);

    const shallI = "The tag is cut — shall I publish it? Also, shall I land the other three?";
    expect(run(shallI).violations).toHaveLength(1);
  });

  it("does not exempt a mutates-main offer that merely mentions a release noun", () => {
    // `"the release"` was a key, and it matched INSIDE the offer sentence — so "merge the release PR"
    // was exempt, re-opening the case the header pins as never exempt. Sentence scoping cannot help
    // when the term is in the offer itself; the key had to go.
    for (const reply of [
      "Want me to merge the release PR?",
      "Should I land the release branch?",
      "Want me to refresh the release worktree?",
    ]) {
      expect(run(reply).violations, `must fire: ${reply}`).toHaveLength(1);
    }
  });

  it("does not split a sentence inside a version string", () => {
    // A naive `.` scan gave the window "Should I tag v0." — losing the exempting term and BLOCKING a
    // genuine release question at the default severity.
    expect(sentenceAround("Should I tag v0.62.0 and publish the DMG?", 0)).toBe(
      "Should I tag v0.62.0 and publish the DMG?",
    );
    expect(run("Should I tag v0.62.0 and publish the DMG?").violations).toHaveLength(0);
    expect(run("Want me to delete the v0.45.1 tag?").violations).toHaveLength(0);
    // A decimal mid-sentence must not split it either.
    expect(sentenceAround("It is 3.5 hours. Want me to run it?", 20)).toBe("Want me to run it?");
  });

  it("treats a terminator followed by a closing bracket or quote as a real boundary", () => {
    // roborev 55757 (Medium): requiring whitespace immediately after the terminator meant `.` before
    // `)` was not a boundary, so the window ran past it and the paragraph-wide exemption came back —
    // the masking shape the sentence scoping exists to kill, reintroduced by the version-string guard.
    for (const reply of [
      "(I already published the DMG.) Want me to merge #864?",
      '"I published the release." Want me to merge #864?',
      "(Want me to merge it?) I already published the DMG.",
    ]) {
      expect(run(reply).violations, `must fire: ${reply}`).toHaveLength(1);
    }
    expect(sentenceAround("(I published the DMG.) Want me to merge #864?", 23)).toBe(
      "Want me to merge #864?",
    );
  });

  it("sentenceAround narrows to the offer's clause", () => {
    const text = "I can push the branch. Want me to merge it?";
    const at = text.indexOf("Want me to");
    expect(sentenceAround(text, at)).toBe("Want me to merge it?");
    // First sentence, no preceding terminator.
    expect(sentenceAround(text, 0)).toBe("I can push the branch.");
  });

  // ══ THE WEAK PATTERNS (roborev 55713, Medium) ════════════════════════════════════════════════
  // A turn that answers a question CANNOT take action, so blocking it forces a revision whose
  // compliant form does not exist. The weak patterns warn instead, however the check is configured.
  it("warns rather than blocks on an open-door phrase in a pure Q&A turn", () => {
    const qa =
      "The two questions are different: ancestry against origin/main answers whether it landed. " +
      "Let me know if you want the tag check too.";
    const result = lintReply(qa, ctx());
    expect(result.blocked, "a Q&A turn must not be blocked — there was nothing to act on").toBe(false);
    expect(result.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);
    expect(result.violations.find((v) => v.check === ASK_WITHOUT_ACTION_CHECK_ID)!.severity).toBe("warn");
  });

  it("still BLOCKS the unambiguous offers even though the weak ones only warn", () => {
    for (const strong of ["Want me to run that?", "Shall I land it?", "Say the word and I will."]) {
      expect(lintReply(strong, ctx()).blocked, `must block: ${strong}`).toBe(true);
    }
  });

  it("records `warned` on BOTH paths, because nothing revises anything yet", () => {
    // roborev 55713, then 55981. `action` was first hardcoded to "revised" at detection time; the
    // fix for that made it conditional on the severity — `block` still claimed "revised". That was
    // still wrong, and more subtly: NOTHING re-prompts. The mount consumes `LintResult.text` and
    // discards `blocked`, so a "revised" on the block path recorded a correction that never
    // happened, on every hit — the correction-rate rollup would have read 100% while no reply was
    // ever corrected.
    //
    // Only the component that performs a revision can honestly claim one. When the re-prompt lands
    // it upgrades this at that point, and this test changes with it.
    const warned = lintReply("Want me to run that?", ctx([], { policy: policy({ severity: "warn" }) }));
    expect(warned.violations.find((x) => x.check === ASK_WITHOUT_ACTION_CHECK_ID)!.action).toBe("warned");
    const blocked = lintReply("Want me to run that?", ctx());
    expect(blocked.violations.find((x) => x.check === ASK_WITHOUT_ACTION_CHECK_ID)!.action).toBe("warned");
    // The SEVERITY still differs — only the claimed action is held back.
    expect(blocked.violations.find((x) => x.check === ASK_WITHOUT_ACTION_CHECK_ID)!.severity).toBe("block");
  });

  // ══ FALSE POSITIVES ══════════════════════════════════════════════════════════════════════════
  it("does not fire on the human's own question quoted back in a blockquote", () => {
    const quoted = ["You asked:", "", "> Should I merge it?", "", "It is already merged."].join("\n");
    expect(run(quoted).violations).toHaveLength(0);
  });

  it("does not fire inside a fence or an inline code span", () => {
    const fenced = ["Here is the prompt I sent:", "", "```", "Want me to run that?", "```"].join("\n");
    expect(run(fenced).violations).toHaveLength(0);
    expect(run("The banned phrase is `want me to` per rule 17.").violations).toHaveLength(0);
  });

  it("does not pair a distant \"I can\" with an unrelated \"if you\"", () => {
    const long =
      "I can confirm the suite is green. " +
      "That took three runs because the first was a flake unrelated to this branch, " +
      "and the second hit a stale base that a rebase cleared. " +
      "The runner setup files were never deleted; main had simply advanced. " +
      "None of that changes anything if you were expecting a different number.";
    expect(run(long).violations).toHaveLength(0);
  });

  it("counts a sentence with two offer phrases once, not twice", () => {
    // The number is meant to be trusted, so one instance of the failure is one violation.
    const { violations } = run("Want me to run it, or should I wait?");
    expect(violations).toHaveLength(1);
  });

  // ══ POLICY PLUMBING ══════════════════════════════════════════════════════════════════════════
  it("honours severity and enabled from the config, so a bad check is cheap to disable", () => {
    const warn = lintReply("Want me to run that?", ctx([], { policy: policy({ severity: "warn" }) }));
    expect(warn.blocked).toBe(false);
    expect(warn.violations.map((v) => v.check)).toContain(ASK_WITHOUT_ACTION_CHECK_ID);

    for (const off of [policy({ severity: "off" }), policy({ enabled: false })]) {
      const result = lintReply("Want me to run that?", ctx([], { policy: off }));
      expect(result.violations.map((v) => v.check)).not.toContain(ASK_WITHOUT_ACTION_CHECK_ID);
      expect(result.blocked).toBe(false);
    }
  });

  it("has a term for every exempt tool, so a newly-exempt tool cannot silently lose its exemption", () => {
    // The companion to the "branch" bug: the derived-token version exempted every reply mentioning a
    // branch, so terms are curated now. Curation's failure mode is the opposite one — a tool added to
    // an exempt class with no term would be silently unexempt — and this is the test that catches it.
    const covered = new Set(Object.values(EXEMPT_SYNONYMS));
    const missing = exemptToolNames().filter((t) => !covered.has(t));
    expect(missing, `exempt tools with no term in EXEMPT_SYNONYMS: ${missing.join(", ")}`).toEqual([]);
  });

  it("names only real tools in the synonym map", () => {
    // A typo'd tool name would make its term dead: `namesExemptAction` resolves the risk class by
    // name and skips an entry it cannot resolve, so the exemption would silently never apply.
    const real = new Set(CONCIERGE_TOOL_CATALOG.map((e) => e.name));
    for (const [term, tool] of Object.entries(EXEMPT_SYNONYMS)) {
      expect(real.has(tool as never), `${term} → ${tool} is not a real tool name`).toBe(true);
    }
  });

  describe("tookAction", () => {
    it("is false for no calls and for read-only calls", () => {
      expect(tookAction([])).toBe(false);
      expect(tookAction(undefined)).toBe(false);
      expect(tookAction([{ name: "get_config", input: {} }])).toBe(false);
    });

    it("is true for a mutating call, and for an UNRECOGNIZED one", () => {
      expect(tookAction([{ name: "merge_pr", input: {} }])).toBe(true);
      // Unrecognized counts as action on purpose: this check blocks, so the costly error is firing
      // on a reply that did act. A new mutating tool must not produce a spurious block.
      expect(tookAction([{ name: "some_future_tool", input: {} }])).toBe(true);
      expect(tookAction([{ name: "Bash", input: { command: "git push" } }])).toBe(true);
    });

    it("ignores a blank tool name rather than counting it as action", () => {
      expect(tookAction([{ name: "", input: {} }, { name: "   ", input: {} }])).toBe(false);
    });

    it("classifies every catalog risk class as acting or not, with no gaps", () => {
      // WAS VACUOUS (roborev 55713, Medium): this built `known` from a hardcoded literal and then
      // asserted `known.size >= 9` — an assertion about the literal it had just written, which never
      // read the catalog at all. A tenth risk class (which `isActing` silently treats as ACTING,
      // suppressing the check for every tool in it) left it green, while its comment claimed the
      // opposite. Now derived at RUNTIME and compared for set equality, so a new class fails here.
      const actual = new Set(CONCIERGE_TOOL_CATALOG.map((e) => e.riskClass));
      const accounted = new Set<string>([
        ...NON_ACTING_RISK_CLASSES,
        ...EXEMPT_RISK_CLASSES,
        "routine",
        "disruptive",
        "rewrites-branch",
        "mutates-main",
      ]);
      const unaccounted = [...actual].filter((c) => !accounted.has(c));
      expect(
        unaccounted,
        `risk classes this check has never decided about: ${unaccounted.join(", ")}`,
      ).toEqual([]);
    });
  });
});
