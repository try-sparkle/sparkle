// ASK-INSTEAD-OF-ACT — the concierge investigated, described the situation accurately, and then
// handed the decision back instead of taking it.
//
// ══ THE FAILURE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// Accurate description feels like the deliverable because it cannot be wrong, and asking permission
// offloads the outcome so the concierge never owns it. On 2026-07-29 the human said four separate
// times, in one session, to default to action — "I would rather have to stop you and slow you down
// than nudge you to do something", "when you have identified the obvious next action and it is
// reversible, just do it", "default to action", "do it" — and twenty minutes after the last one a
// reply still ended with "Want me to run that?" while 45+ branches sat holding unlanded work.
//
// Four restatements of a rule in prose did not hold it for twenty minutes. That is the argument for
// this being a check rather than a fifteenth guideline bullet.
//
// ══ WHY IT BLOCKS ══════════════════════════════════════════════════════════════════════════════
// `block`, with the one permitted auto-revision. A logged-and-rendered violation would be the same
// passivity one level up: it hands the human a note about the concierge's passivity to read and act
// on, which is exactly the thing that was wrong with the reply. The compliant form is a different
// reply — one where the action was taken — so there is nothing to autofix; only the model can
// produce it.
//
// ══ THE TEST IS TWO-SIDED ══════════════════════════════════════════════════════════════════════
// An offer to act is only a violation when the turn took NO state-changing action. "I merged #864
// and spun the worker down — want me to do the same for the other three?" is a fine reply: the
// concierge acted and is asking about scope beyond what it did. The violation is investigating and
// then stopping short.
//
// ══ THE EXEMPTION IS KEYED OFF TOOL IDENTITY, NOT PHRASING ═════════════════════════════════════
// A genuine question about an irreversible or spend-bearing action is legitimate and must not be
// blocked. But keying the exemption off PHRASING would be self-defeating: phrasing is precisely what
// a model under a linter learns to game, and "just to confirm, shall I..." would become the universal
// prefix. So the exemption is derived from `CONCIERGE_TOOL_CATALOG`'s risk classification — the same
// table the approval gate uses — and a tool moving into an exempt class extends the exemption
// automatically, with no vocabulary to maintain here.
//
// `mutates-main` (`merge_pr`, `land_agent_branch`) is deliberately NOT exempt. Landing is gated by
// GitHub, the human's standing instruction is that a merge request is a cue to run the merge, and
// "want me to merge it?" against a fleet of unlanded branches is the single most expensive instance
// of the failure this check exists to catch. Exempting it would leave the main case uncovered.

import type { Check, LintContext, LintToolCall, Severity, Violation } from "../types";
import { proseSpans } from "../mdast";
import {
  CONCIERGE_TOOL_CATALOG,
  type ConciergeRiskClass,
} from "../../conciergeTools/policy";
import { conciergeOpWrites } from "../../conciergeTools/registry";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const ASK_WITHOUT_ACTION_CHECK_ID = "ask-without-action";

/**
 * Risk classes whose tools NEVER count as taking action.
 *
 * `privacy-sensitive` is a screen capture: it reads, it changes nothing, and a reply that screenshots
 * a window and then asks permission is the exact passivity under test.
 */
export const NON_ACTING_RISK_CLASSES: readonly ConciergeRiskClass[] = [
  "read-only",
  "privacy-sensitive",
];

/**
 * Risk classes where ASKING FIRST IS CORRECT and the check stands down.
 *
 * Derived from the human's own examples of a legitimate question: publishing a production release
 * (`outward-facing` — it leaves this machine and cannot be recalled), deleting a branch and removing
 * a project (`irreversible`), funding an API key (`costs-money`).
 *
 * Note what is absent, and why: `mutates-main` (see the header), `disruptive` and `rewrites-branch`.
 * The last two are the recoverable direction — stopping an agent or refreshing a branch can be
 * undone — so they are the reversible actions the rule is aimed at, not exceptions to it.
 */
export const EXEMPT_RISK_CLASSES: readonly ConciergeRiskClass[] = [
  "irreversible",
  "costs-money",
  "outward-facing",
];

/**
 * English the concierge actually writes, mapped to the exempt tool whose identity it names.
 *
 * ══ WHY THIS IS CURATED RATHER THAN DERIVED FROM TOOL NAMES ═════════════════════════════════════
 * The first version also split each exempt tool's name into tokens and matched those, so that a
 * newly-exempt tool needed no entry here. Its own test killed it: `delete_agent_branch` is
 * `irreversible`, so it contributed the token "branch" — and every reply that so much as MENTIONS a
 * branch was therefore exempt, which is most of them. An exemption that broad does not weaken the
 * check, it deletes it.
 *
 * Leading-token-only fails differently: `spawn_cloud_build_agent` (`costs-money`) and
 * `spawn_build_agent` (`routine`) share the verb "spawn", so deriving from it would exempt "want me
 * to spawn a worker?" — the failure itself.
 *
 * So the terms are curated, and `every_exempt_tool_has_a_term` asserts that every tool in an exempt
 * risk class appears here. Adding a tool to an exempt class fails the suite until someone chooses a
 * term for it — drift becomes a red test rather than a silent hole in either direction.
 *
 * Still keyed off tool IDENTITY, not phrasing: each entry names a tool, and `namesExemptAction`
 * honours the entry only while that tool is still in an exempt class.
 */
export const EXEMPT_SYNONYMS: Readonly<Record<string, string>> = {
  // outward-facing — leaves this machine and cannot be recalled
  publish: "ship_agent",
  "cut the release": "ship_agent",
  "cut a release": "ship_agent",
  notarize: "ship_agent",
  dmg: "ship_agent",
  "open a pr": "open_agent_pr",
  "open the pr": "open_agent_pr",
  "push the branch": "push_agent_branch",
  "push to origin": "push_agent_branch",
  "save the agent": "save_agent",
  "save this agent": "save_agent",
  // irreversible
  delete: "delete_agent_branch",
  destroy: "delete_agent_branch",
  "if merged": "delete_agent_branch_if_merged",
  "remove the project": "remove_project",
  relocate: "relocate_project",
  "move the project": "relocate_project",
  discard: "discard_agent",
  quit: "quit_app",
  "close the item": "delete_item",
  "change the config": "set_config",
  "edit the config": "set_config",
  // costs-money
  spend: "spawn_cloud_build_agent",
  fund: "spawn_cloud_build_agent",
  billing: "spawn_cloud_build_agent",
  "costs money": "spawn_cloud_build_agent",
  charge: "spawn_cloud_build_agent",
  "cloud agent": "spawn_cloud_build_agent",
  "cloud worker": "spawn_cloud_build_agent",
};

/** Lowercased tool names whose risk class this module can resolve. */
const RISK_BY_TOOL: ReadonlyMap<string, ConciergeRiskClass> = new Map(
  CONCIERGE_TOOL_CATALOG.map((e) => [e.name.toLowerCase(), e.riskClass]),
);

/**
 * Read-only tools OUTSIDE the concierge catalog — the harness tools the concierge also holds.
 *
 * Needed because the catalog only knows the app's own ops. `Bash` is deliberately absent: it can do
 * either, and since an unrecognized tool is treated as ACTION (see `tookAction`), leaving it out is
 * the direction that avoids a false block.
 */
const NON_ACTING_HARNESS_TOOLS = new Set(
  [
    "read",
    "grep",
    "glob",
    "webfetch",
    "websearch",
    "toolsearch",
    "notebookread",
    "task",
    "agent",
    "tasklist",
    "taskget",
    "taskoutput",
    "cronlist",
  ].map((s) => s.toLowerCase()),
);

/**
 * The name a tool call arrives under, reduced to something {@link RISK_BY_TOOL} can answer.
 *
 * ══ WITHOUT THIS THE CHECK IS INERT IN PRODUCTION (roborev 56084, High) ═════════════════════════
 * `ConciergeToolCall.name` is captured verbatim from Claude Code's `tool_use` blocks, so it is the
 * MCP wire name — `mcp__sparkle-control__sparkle_workflow` — and the Sparkle surface is exposed as a
 * dozen per-DOMAIN DISPATCHER tools (`sparkle_lifecycle`, `sparkle_workflow`, …) with the operation
 * passed as an `op` argument. The catalog, meanwhile, is keyed by per-OP ids (`merge_pr`,
 * `agent_branch_status`) because that is what `[concierge.tools]` policy paths address.
 *
 * So a raw lookup missed on EVERY real concierge call and fell through to the acting-by-default
 * fallback below. The consequence was not a mild loss of precision — it silenced the check on its
 * headline case: a turn that investigates with reads only (`sparkle_workflow {op:
 * "agent_branch_status"}`) and then closes with "Want me to merge #864?" scored as having acted, so
 * the check returned at its `tookAction` guard. "Investigated accurately, then handed the decision
 * back" is the exact complaint this module's header quotes.
 *
 * Two reductions, in order, each a no-op when it does not apply:
 *   1. Strip a leading `mcp__<server>__`.
 *   2. If what remains is a dispatcher, take the op out of the call's own `input.op` — already
 *      parsed by the runner — and classify THAT.
 * Anything unresolvable falls through unchanged and keeps the acting-by-default behaviour.
 */
export function catalogNameFor(call: LintToolCall): string {
  const raw = (call?.name ?? "").trim().toLowerCase();
  // `mcp__<server>__<tool>` — take everything after the LAST `__` pair, so a server name containing
  // an underscore cannot split it wrongly.
  const bare = raw.startsWith("mcp__") ? (raw.split("__").pop() ?? raw) : raw;
  // A dispatcher carries its real operation in `input.op`; the dispatcher's own name says only which
  // domain it belongs to and classifies nothing.
  if (bare.startsWith("sparkle_")) {
    const input = call?.input;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const op = (input as Record<string, unknown>).op;
      if (typeof op === "string" && op.trim().length > 0) return op.trim().toLowerCase();
    }
  }
  return bare;
}

/**
 * Ops that do no work toward an offer: they move the viewport, or keep process-local bookkeeping.
 *
 * ══ WHY THESE NEED NAMING EVEN THOUGH THE DISPATCHER CLASSIFIES WRITES ══════════════════════════
 * Most domains derive `write` from `risk !== "read-only"`, and these are `routine`, so the
 * dispatcher calls them writes. For the APPROVAL question that is right — selecting a project does
 * change app state and should be allowed unasked. For THIS question it is wrong: moving the human's
 * viewport is not "took the action it offered."
 *
 * It is not hypothetical (roborev 56103). `navigate` is described in the catalog as the constantly
 * used "put me where the work is", and the screenshot domain ships a refusal instructing the
 * concierge to call `select_project` BEFORE re-attempting a capture. So `select_project` →
 * `capture_agent` → "Want me to merge #864?" does no work toward the offer, yet one `.some(isActing)`
 * hit would silence the whole turn — the same door as `preview_close`, one room over.
 *
 * WHAT IS DELIBERATELY ABSENT: `set_theme`, `set_zoom` and `unpin_agent`. A first draft included
 * them and that was a regression (roborev 56111) — they write durable, human-observable preferences,
 * so "Switched you to dark mode. Want me to bump the zoom too?" is a reply that DID what was asked
 * and is asking about scope beyond it, which `run()` documents as fine. Calling them non-acting
 * turned that into a blocking false positive: the costly error this module's header names.
 */
export const VIEW_ONLY_OPS: readonly string[] = [
  // ── Viewport only: change what is ON SCREEN and nothing else ──────────────────────────────────
  "navigate",
  "select_project",
  "open_project_tab",
  "jump_to_history_hit",
  "show_main_window",
  // ── Process-local bookkeeping: mutate module state, change nothing a human can observe ─────────
  // `events.ts` says both halves itself — "they DO mutate module state" (why the approval path
  // calls them writes) and "nothing but a cursor in this process's memory" (why they are not work
  // toward an offer). The registry has one bit for two questions, so it answers the approval one;
  // these stay named here until `DomainEntry` can express both (roborev 56111).
  //
  // The concierge brain is ONE PROCESS PER TURN, so a turn with no cursor must `subscribe` before it
  // can `read_events` — making subscribe→read→offer as canonical as preview→offer.
  "subscribe",
  "unsubscribe",
];
const VIEW_ONLY_OP_SET = new Set(VIEW_ONLY_OPS);

/** The dispatcher domain a call belongs to (`sparkle_lifecycle` → `lifecycle`), or null when the
 *  call is not a Sparkle dispatcher at all. Derived from the same name {@link catalogNameFor}
 *  reduces, so the two cannot disagree about which call is a dispatcher. */
function dispatcherDomain(call: LintToolCall): string | null {
  const raw = (call?.name ?? "").trim().toLowerCase();
  const bare = raw.startsWith("mcp__") ? (raw.split("__").pop() ?? raw) : raw;
  return bare.startsWith("sparkle_") ? bare.slice("sparkle_".length) : null;
}

/** Does this single call change state? */
function isActing(call: LintToolCall): boolean {
  const name = catalogNameFor(call);
  if (name.length === 0) return false;
  // Presentation only — see VIEW_ONLY_OPS. Checked first because the dispatcher classifies these as
  // writes for the approval question, which is a different question.
  if (VIEW_ONLY_OP_SET.has(name)) return false;
  // THE DISPATCHER'S OWN ANSWER, ahead of the risk class. `routine` is the approval vocabulary's
  // "may proceed unasked" and says nothing about whether the world changed: `close_agent` is
  // `routine` and removes worktrees, `preview_close` is `routine` and only computes. `write` is the
  // question we actually mean, and for lifecycle and screenshot it is a `Record<Op, boolean>` — so a
  // new preview op is a typecheck failure over there rather than a silent hole here (roborev 56103).
  const domain = dispatcherDomain(call);
  if (domain) {
    const writes = conciergeOpWrites(domain, name);
    if (writes === false) return false;
  }
  const risk = RISK_BY_TOOL.get(name);
  if (risk) return !NON_ACTING_RISK_CLASSES.includes(risk);
  if (NON_ACTING_HARNESS_TOOLS.has(name)) return false;
  // UNRECOGNIZED COUNTS AS ACTION, deliberately. This check blocks and forces a revision, so the
  // costly error is firing on a reply that DID act. A new mutating tool therefore suppresses the
  // check until it is classified, rather than producing a spurious block on real work.
  return true;
}

/** Did the turn take any state-changing action at all? */
export function tookAction(calls: readonly LintToolCall[] | undefined): boolean {
  return (calls ?? []).some(isActing);
}

/**
 * The offer-to-act patterns, as anchored regexes over prose.
 *
 * Each is a way of handing the decision back. `let me know if` and `I can … if you` are included
 * because they are the passive-voice forms of the same move — the concierge names the action and
 * then makes the human initiate it.
 */
// ══ TWO STRENGTHS, because not every turn HAS an action to take (roborev 55713, Medium) ══════════
// The check's precondition is "no state-changing call this turn", and a large class of legitimate
// turns cannot take one: answering a factual question, explaining a design, reporting a refusal.
// Those routinely close with "let me know if" or "just say", and blocking them forces a revision
// whose compliant form does not exist — there was nothing to act on — so the retry returns the same
// closing and lands on `rendered_marked`. That is a false positive on a BLOCKING check, which this
// module's own header calls the costly error.
//
// So the patterns that are unambiguously an offer to act ("want me to", "shall I") keep the
// configured severity, and the weak ones that are usually just an open door are capped at `warn`.
// `just say` in particular fires on ordinary prose ("just say unknown, not yes").
const OFFER_PATTERNS: readonly {
  readonly re: RegExp;
  readonly label: string;
  /** Cap this pattern at `warn` however the check is configured. */
  readonly weak?: true;
}[] = [
  { re: /\bwant me to\b/i, label: "want me to" },
  { re: /\bdo you want me to\b/i, label: "do you want me to" },
  { re: /\bwould you like me to\b/i, label: "would you like me to" },
  { re: /\bshould i\b/i, label: "should I" },
  { re: /\bshall i\b/i, label: "shall I" },
  { re: /\bsay the word\b/i, label: "say the word" },
  { re: /\bif you'?d like me to\b/i, label: "if you'd like me to" },
  { re: /\blet me know if\b/i, label: "let me know if", weak: true },
  { re: /\blet me know whether\b/i, label: "let me know whether", weak: true },
  { re: /\bjust say\b/i, label: "just say", weak: true },
  // "I can X if you Y" — the offer split across a conditional. Bounded repetition rather than `.*`
  // so it cannot span the whole reply and pair an unrelated "I can" with a distant "if you".
  { re: /\bi can\b[^.!?]{0,120}\bif you\b/i, label: "I can … if you", weak: true },
];

/**
 * Closing quotes and brackets that may sit BETWEEN a sentence terminator and the whitespace after it.
 *
 * ONE definition, used by both `isTerminator` (to skip them when deciding a boundary) and
 * `sentenceAround` (to strip them off the front of the window). It was spelled twice, and the two
 * copies are only correct while they agree — the failure mode being a terminator the scan accepts and
 * a window that keeps the bracket, or worse, the reverse (roborev 55825).
 */
const CLOSERS = "\"'\u2019\u201d)\\]";

/**
 * The sentence containing `index`, so the exemption is judged on the offer and not its paragraph.
 *
 * Boundaries are decided by {@link isTerminator}, NOT by a bare `/[.!?]/` — see it for why. The
 * cost of a mis-split is not "a clause too wide or too narrow" as this comment once claimed: it can
 * lose the exempting term entirely and BLOCK a legitimate question, or run past a real boundary and
 * restore the paragraph-wide exemption. Both have happened. Exported for the tests.
 */
export function sentenceAround(value: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (isTerminator(value, i)) {
      start = i + 1;
      break;
    }
  }
  let end = value.length;
  for (let i = index; i < value.length; i++) {
    if (isTerminator(value, i)) {
      end = i + 1;
      break;
    }
  }
  // Strip the closers the backward scan stopped just before, so the window starts at the sentence
  // rather than at ") — cosmetic for matching, but it makes the exported helper's result the thing a
  // reader expects and keeps the tests honest about what the window IS.
  return value.slice(start, end).replace(new RegExp(`^[\\s${CLOSERS}]+`), "").trim();
}

/**
 * Is `value[i]` a real sentence terminator?
 *
 * NOT just `/[.!?]/` (roborev 55734, Medium). This concierge writes version strings constantly, and
 * a naive scan split `"Should I tag v0.62.0 and publish the DMG?"` into the window
 * `"Should I tag v0."` — losing both `publish` and `dmg`, so a genuine `outward-facing` question was
 * BLOCKED at the shipped default severity, forcing a revision whose compliant form does not exist.
 * That is a blocking false positive, not the "a clause too wide or too narrow" the earlier comment
 * claimed was the only cost of a mis-split.
 *
 * Two guards, and note the SECOND is not "must be followed by whitespace" — that was the rule, and
 * it caused roborev 55757 by making `.` before `)` or `"` not a boundary, which let the window
 * swallow the next sentence and restored the paragraph-wide exemption. The rule is: a `.` between
 * digits is a decimal or a version, and a terminator must be followed by whitespace or
 * end-of-string AFTER any run of closing quotes/brackets. See the loop below.
 */
function isTerminator(value: string, i: number): boolean {
  const c = value[i];
  if (c !== "." && c !== "!" && c !== "?") return false;
  if (c === "." && /\d/.test(value[i - 1] ?? "") && /\d/.test(value[i + 1] ?? "")) return false;
  // Skip trailing closers before demanding whitespace (roborev 55757, Medium). Requiring whitespace
  // immediately after meant `.` before `)` or `"` was not a terminator at all, so the window ran past
  // it and swallowed the neighbouring sentence — reinstating the paragraph-wide exemption the
  // sentence scoping exists to kill. "(I already published the DMG.) Want me to merge #864?" went
  // back to exempt. Parenthetical and quoted sentence-enders are ordinary in this concierge's prose.
  let j = i + 1;
  while (new RegExp(`[${CLOSERS}]`).test(value[j] ?? "")) j++;
  const next = value[j];
  return next === undefined || /\s/.test(next);
}

/** Is this text exempt because it names an irreversible or spend-bearing tool's identity? */
function namesExemptAction(value: string): string | null {
  const lower = value.toLowerCase();
  for (const [term, tool] of Object.entries(EXEMPT_SYNONYMS)) {
    const risk = RISK_BY_TOOL.get(tool);
    // The synonym is live ONLY while its tool is still in an exempt class — that is what keeps this
    // keyed to tool identity rather than to the word.
    if (!risk || !EXEMPT_RISK_CLASSES.includes(risk)) continue;
    if (new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower)) {
      return `${term} (${tool}, ${risk})`;
    }
  }
  return null;
}

/** Every tool in an exempt risk class, for the coverage test that keeps `EXEMPT_SYNONYMS` honest. */
export function exemptToolNames(): string[] {
  return CONCIERGE_TOOL_CATALOG.filter((e) => EXEMPT_RISK_CLASSES.includes(e.riskClass))
    .map((e) => e.name)
    .sort();
}

export const askWithoutActionCheck: Check = {
  id: ASK_WITHOUT_ACTION_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx.policy?.checks?.[ASK_WITHOUT_ACTION_CHECK_ID];
    const severity: Severity = policy?.severity ?? "block";

    // THE SECOND HALF OF THE TEST. Acting and then asking about scope beyond what was done is fine;
    // checked first because it is the cheap way out and makes the common case free.
    if (tookAction(ctx.toolCalls)) return { text, violations: [] };

    const violations: Violation[] = [];
    // Blockquotes excluded: "you asked: > should I merge it?" is the HUMAN's question quoted back,
    // and blaming the concierge for it is the same wrong-target mistake `hedgeWords` documents.
    for (const span of proseSpans(text, { excludeBlockquote: true })) {
      for (const { re, label, weak } of OFFER_PATTERNS) {
        // EVERY match, not just the first (roborev 55734, Medium). `re.exec` on a non-global regex
        // returns match #1 only, so an EXEMPT offer earlier in the paragraph masked a non-exempt one
        // later in it — the same masking shape as the sentence-scoping High, one level down.
        // "Want me to publish the release? And want me to merge #864 while it is green?" produced
        // ZERO violations: match #1 was exempted by `publish`, and the merge offer the check exists
        // for went unflagged. A fresh global copy per span keeps `lastIndex` from leaking between
        // spans (the patterns are module-level constants).
        const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
        let m: RegExpExecArray | null = null;
        let hit: RegExpExecArray | null = null;
        while ((m = all.exec(span.value)) !== null) {
          if (m[0].length === 0) {
            all.lastIndex += 1;
            continue;
          }
          if (!namesExemptAction(sentenceAround(span.value, m.index))) {
            hit = m;
            break;
          }
        }
        if (!hit) continue;
        // A weak pattern never blocks, however the check is configured — see OFFER_PATTERNS.
        const fired: Severity = weak && severity === "block" ? "warn" : severity;
        if (fired === "off") continue;
        // SCOPED TO THE OFFER'S OWN SENTENCE, not the span (roborev 55713, High). The exemption test
        // itself now lives in the match loop above, so each occurrence is judged on its own sentence.
        //
        // `proseSpans` emits one span per markdown text node — i.e. a whole paragraph. Testing the
        // paragraph meant any incidental mention anywhere in it switched the check off, which is the
        // SAME failure as the earlier "branch" token bug one level over: the term list got narrower,
        // the scope did not. The case that proved it is the one the check exists for — "PR #864 is
        // green, I can push the merge commit once CI settles. Want me to merge it?" — where `push`
        // exempted the whole paragraph and the offer to merge went unflagged. Every exemption test
        // was a single sentence whose only content was the exempt term, so none of them caught it.
        violations.push({
          check: ASK_WITHOUT_ACTION_CHECK_ID,
          severity: fired,
          // HONEST AT DETECTION TIME (roborev 55713, then 55981). Always `"warned"` — never
          // `"revised"`, not even on the `block` path.
          //
          // `"revised"` claims the concierge was re-prompted and produced a correction. NOTHING
          // re-prompts yet: the mount consumes `LintResult.text` and discards `blocked`. Stamping
          // `"revised"` on the block path recorded a revision that never happened, in the exact
          // rollup this log exists to make trustworthy — and it did so on EVERY hit, so the
          // correction-rate readout would have read 100% while no reply was ever corrected. A
          // number that is confidently wrong is worse than a missing one.
          //
          // Only the component that performs a revision can honestly claim one, so whatever
          // implements the re-prompt upgrades this to `"revised"` (or `"rendered_marked"` when the
          // one permitted retry is exhausted) at that point.
          action: "warned",
          span: hit[0].length,
          detail: `offered to act ("${label}") without taking any action this turn`,
        });
        // One violation per span, not per pattern: a sentence containing both "want me to" and
        // "should I" is one instance of the failure, and counting it twice would overstate a
        // number the human is meant to trust.
        break;
      }
    }
    return { text, violations };
  },
};
