// UNBACKED-CLAIM — the concierge said it DID something and made no tool call that could have done it.
//
// ══ THE FAILURE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// "I sent this to Stripe Checkout Flow." / "I spawned an agent on it." / "I closed it." / "I filed
// that bead." / "I merged it." Each is a receipt, and a receipt the human cannot check is worse than
// no receipt: it retires the task in their head. `ask-without-action` catches the opposite failure
// (described accurately, then stopped short). This catches the one that costs more, because the
// human stops watching.
//
// It is DETERMINISTIC and there is no model in the path. The reply says a send happened; `ctx.
// toolCalls` is the list of calls the turn actually made; a send with no send call in it is the
// finding. Nothing here judges whether the send went to the RIGHT agent — that is a different
// question and not one a regex can answer.
//
// ══ THE GRAMMAR IS CALIBRATED — LOOSENING IT IS THE REGRESSION ══════════════════════════════════
// Derived by mining all 19 concierge transcripts (1,490 turns). A naive "sent|spawned|closed" scan
// flagged 23% of turns at roughly 70% false positives — a check nobody would leave on. This grammar
// flags 2.1%. Three properties do that work, and each one is load-bearing:
//
//   A. AN EXPLICIT FIRST-PERSON SUBJECT GOVERNS THE VERB. `I` / `I've` / `I have` / `I just` / `I'm`
//      / `I am`, immediately before the verb (one optional `just|already|now` between them). A bare
//      verb is not a claim: "sent at 14:02", "the message sent to it", "closing notes" are all
//      prose ABOUT a send, not a claim to have made one.
//   B. TWO TENSES, and only two. Perfect/past ("I sent", "I've sent") and progressive ("I'm
//      sending") are claims about THIS turn. FUTURE — "I'll send", "I will send", "I'm going to
//      send" — is a PROMISE about a later turn and is deliberately invisible here. A promise that
//      is never kept is a real failure, and it is a different mechanism with a different evidence
//      window (it needs the NEXT turn, which this check cannot see). Flagging it here would be
//      wrong on every promise the concierge then keeps.
//   C. FOUR EXCLUSIONS, each one a real false positive from the corpus. See EXCLUSIONS below.
//
// ══ WHY IT WARNS AND NEVER AUTOFIXES ═══════════════════════════════════════════════════════════
// `warn`, `action: "warned"`. The compliant form of a false-positive sentence is a DIFFERENT
// sentence that only the model can write, so there is nothing to substitute; and the compliant form
// of a TRUE positive is not a rewrite at all — it is the tool call the concierge did not make.
// Blocking would also be an unkept promise today: nothing consumes `blocked` (see
// `conciergeLintRegistry.test.ts`).
//
// ══ WHAT BACKS A CLAIM ══════════════════════════════════════════════════════════════════════════
// Each family names the ops that could have produced it, typed as `ConciergeToolName` so a RENAMED
// OP IS A TYPECHECK FAILURE rather than a family that silently stops being backable — the drift a
// `string[]` cannot catch. Two calls arrive outside that union and are matched by shape instead: a
// `Bash` running `bd create` / `gh pr` / `git push` is a real filing or a real merge, and refusing
// to count it would make the check fire on the concierge's most common way of doing those.

import type { Check, LintContext, LintToolCall, Severity, Violation } from "../types";
import { proseSpans } from "../mdast";
import type { ConciergeToolName } from "../../conciergeTools/policy";
import { conciergeOpWrites } from "../../conciergeTools/registry";
// REUSED, NOT REIMPLEMENTED. `catalogNameFor` unwraps `mcp__sparkle-control__sparkle_terminal` →
// `input.op` → `send_to_agent_terminal`; without it every Sparkle call reads as the DISPATCHER's
// name and no family is ever backed, which would make this check fire on every honest receipt the
// concierge writes. `sentenceAround` already handles version strings and closing quotes. A second
// copy of either is the drift this repo keeps paying for.
import { catalogNameFor, dispatcherDomain, sentenceAround } from "./askWithoutAction";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const UNBACKED_CLAIM_CHECK_ID = "unbacked-claim";

/** The six things the concierge claims to have done that a tool call can prove. */
export type ClaimFamily = "send" | "spawn" | "close" | "goal" | "filed" | "merged";

/**
 * The FIRST-PERSON SUBJECT, requirement (A). Everything a family matches is anchored behind this.
 *
 * CASE-SENSITIVE on purpose (the family regexes carry `g` and not `gi`). English capitalizes the
 * first-person pronoun, so `I` is a reliable token, while a case-insensitive `\bi\b` would start
 * matching the `i` of a bare identifier or a list marker. The verbs that follow are lowercase in
 * every reply in the corpus — they sit mid-sentence by construction, since a subject precedes them.
 *
 * The optional adverb is `just|already|now`, per the calibration. Nothing else may intervene: an
 * adverb slot that accepted any word would re-admit the future ("I am going to send").
 */
const SUBJECT = String.raw`\b(?:I['’]ve|I['’]m|I have|I am|I)\s+(?:just\s+|already\s+|now\s+)?`;

/** One claim family: how it is written, and what could have produced it. */
interface FamilySpec {
  family: ClaimFamily;
  /** Regex sources for the verb phrase that must follow {@link SUBJECT}. Past/perfect and
   *  progressive only — see requirement (B). No infinitive, so no future form can match. */
  verbs: readonly string[];
  /**
   * Ops that back this family. `ConciergeToolName` is the union of the domains' own operation
   * unions, so a rename in `conciergeTools/` fails `tsc` HERE.
   */
  tools: readonly ConciergeToolName[];
  /** Lowercased fragments that back it when they appear in a `Bash` call's arguments. */
  bash?: readonly string[];
  /** How the violation names the family in `detail`. */
  label: string;
}

export const CLAIM_FAMILIES: readonly FamilySpec[] = [
  {
    family: "send",
    // `relayed` is the concierge's own word for the same act and appears throughout the corpus.
    verbs: ["sent", "sending", "relayed", "relaying"],
    tools: ["send_to_agent_terminal", "inbox_send", "inbox_broadcast"],
    label: "send",
  },
  {
    family: "spawn",
    // "spun up" / "spinning up" is how the concierge says it more often than "spawned".
    verbs: ["spawned", "spawning", String.raw`spun\s+up`, String.raw`spinning\s+up`],
    tools: ["spawn_build_agent", "spawn_cloud_build_agent"],
    label: "spawn",
  },
  {
    family: "close",
    verbs: [
      "closed",
      "closing",
      String.raw`spun\s+down`,
      String.raw`spinning\s+down`,
      String.raw`shut\s+down`,
      String.raw`shutting\s+down`,
      "discarded",
      "discarding",
    ],
    tools: ["close_agent", "spin_down_worker", "discard_agent", "ship_agent", "save_agent"],
    // `bd close` BACKS A CLOSE CLAIM, and that is not scope creep — it removes a false positive.
    // "I closed sparkle-kr2jz" is a bead, not an agent, and the concierge closes beads by shell.
    // Nothing in the sentence distinguishes the two objects, so the only way to avoid punishing an
    // honest bead close is to let the shell call back it.
    bash: ["bd close"],
    label: "close",
  },
  {
    family: "goal",
    // The object is REQUIRED here, unlike every other family: a bare `set` is one of the most
    // common verbs in English ("I set that aside", "I set the threshold to 200") and would be a
    // false positive generator. `(?:\w+\s+){0,2}` covers "its goal", "the goal", "his goal met".
    verbs: [String.raw`(?:set|setting|marked|marking)\s+(?:\w+\s+){0,2}goal\b`],
    tools: ["set_agent_goal", "set_agent_goal_met"],
    label: "goal update",
  },
  {
    family: "filed",
    // `filed` alone is unambiguous in this app's vocabulary; `created`/`opened` are not, so they
    // require the object.
    verbs: [
      "filed",
      "filing",
      String.raw`(?:created|creating|opened|opening)\s+(?:a|the)\s+bead`,
    ],
    tools: ["create_item"],
    bash: ["bd create", "file-retro-pain-point"],
    label: "bead filing",
  },
  {
    family: "merged",
    verbs: [
      "merged",
      "merging",
      "landed",
      "landing",
      "pushed",
      "pushing",
      String.raw`(?:opened|opening)\s+(?:a|the)\s+(?:pr\b|pull\s+request)`,
    ],
    tools: ["merge_pr", "land_agent_branch", "push_agent_branch", "open_agent_pr"],
    bash: ["gh pr", "git push"],
    label: "merge",
  },
];

/** One compiled matcher per family. Built once; each use gets a fresh `lastIndex` reset. */
const FAMILY_MATCHERS: readonly { spec: FamilySpec; re: RegExp }[] = CLAIM_FAMILIES.map((spec) => ({
  spec,
  re: new RegExp(`${SUBJECT}(?:${spec.verbs.join("|")})\\b`, "g"),
}));

/**
 * EXCLUSION 1 — CONDITIONAL / OFFER. "I'm sending it if you confirm" is an OFFER, not a receipt.
 *
 * Every phrase here is a real corpus false positive. Note the overlap with `askWithoutAction`'s
 * offer patterns is intentional and not shared code: that check asks "did this offer instead of
 * acting", this one asks "is this sentence a claim at all", and the answers are allowed to diverge
 * (`let me know` is a weak offer there and a full exclusion here).
 */
export const CONDITIONAL_PATTERNS: readonly RegExp[] = [
  /\bif you\b/i,
  /\bunless you\b/i,
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bwould you like\b/i,
  /\bsay the word\b/i,
  /\blet me know\b/i,
];

/**
 * EXCLUSION 3 — PAST-TURN SCOPE. "I closed exactly one agent today" is TRUE and is about a
 * different turn. This check sees one turn's tool calls and has no window into earlier ones, so a
 * sentence that explicitly scopes itself to the past is outside what it can judge. Staying silent
 * is the only honest answer available.
 */
export const PAST_TURN_PATTERNS: readonly RegExp[] = [
  /\btoday\b/i,
  /\byesterday\b/i,
  /\bearlier\b/i,
  /\blast time\b/i,
  /\bthis morning\b/i,
  /\bthis afternoon\b/i,
  /\bpreviously\b/i,
  /\bbefore\b/i,
  // Covers "a few turns ago", "twenty minutes ago", "an hour ago" without enumerating quantities.
  /\bago\b/i,
];

/**
 * EXCLUSION 2 — RELATIVE CLAUSE. Words that may legitimately sit immediately before a MAIN-clause
 * `I`: coordinators and discourse connectives. Anything else immediately before the pronoun is a
 * noun or determiner, which makes the verb part of a noun phrase referring to an EARLIER turn —
 * "the agent I spawned", "every agent I spawn", "the ones I sent".
 *
 * `that` / `which` / `who` are deliberately ABSENT: they are relative pronouns, so "the agent that
 * I spawned" must stay excluded. Punctuation before the pronoun (`.`, `,`, `;`, `—`) is a clause
 * boundary and is handled by the regex in {@link inRelativeClause} finding no preceding word at all.
 */
export const CLAUSE_LINKERS: ReadonlySet<string> = new Set([
  "and",
  "but",
  "so",
  "then",
  "or",
  "yet",
  "also",
  "however",
  "therefore",
  "meanwhile",
  "because",
  "since",
  "while",
]);

/** Is the claim at `index` sitting inside a noun phrase rather than governing a main clause? */
export function inRelativeClause(value: string, index: number): boolean {
  const before = value.slice(0, index).replace(/\s+$/, "");
  const word = /([A-Za-z][A-Za-z'’-]*)$/.exec(before)?.[1];
  // Nothing before it, or punctuation before it — a main clause either way.
  if (!word) return false;
  return !CLAUSE_LINKERS.has(word.toLowerCase());
}

/** A tool call's arguments as one lowercased searchable string. Shape-agnostic on purpose: the
 *  harness spells a shell command `input.command`, but nothing in `LintToolCall` promises that, and
 *  a missed `git push` here means a false accusation of an unbacked merge. */
function callText(input: unknown): string {
  if (typeof input === "string") return input.toLowerCase();
  try {
    return JSON.stringify(input ?? "").toLowerCase();
  } catch {
    // Circular or otherwise unstringifiable — no text, so no Bash-shaped backing. Never throws:
    // `lintReply` treats a thrown check as clean, which would silently disable this one.
    return "";
  }
}

/**
 * Which families this turn's tool calls could have produced.
 *
 * The `conciergeOpWrites` gate is the same predicate the approval path uses — reused rather than
 * re-derived (roborev 56103's lesson). It only ever REMOVES backing: an op that the dispatcher says
 * changes nothing cannot be the receipt for a claim that something changed. Today no family lists a
 * non-writing op, so the gate is a guard against a later reclassification quietly turning a preview
 * into proof.
 */
export function backedFamilies(calls: readonly LintToolCall[] | undefined): Set<ClaimFamily> {
  const backed = new Set<ClaimFamily>();
  for (const call of calls ?? []) {
    const name = catalogNameFor(call);
    if (name.length === 0) continue;
    if (name === "bash") {
      const text = callText(call?.input);
      for (const spec of CLAIM_FAMILIES) {
        if (spec.bash?.some((fragment) => text.includes(fragment))) backed.add(spec.family);
      }
      continue;
    }
    const domain = dispatcherDomain(call);
    if (domain && conciergeOpWrites(domain, name) === false) continue;
    for (const spec of CLAIM_FAMILIES) {
      if ((spec.tools as readonly string[]).includes(name)) backed.add(spec.family);
    }
  }
  return backed;
}

export const unbackedClaimCheck: Check = {
  id: UNBACKED_CLAIM_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx.policy?.checks?.[UNBACKED_CLAIM_CHECK_ID];
    const severity: Severity = policy?.severity ?? "warn";
    const backed = backedFamilies(ctx.toolCalls);

    const violations: Violation[] = [];
    // EXCLUSION 4 — NOT PROSE. `proseSpans` drops fenced blocks and inline code spans structurally,
    // and `excludeBlockquote` drops the human's own words quoted back ("you said: > I sent it") —
    // blaming the concierge for those is the wrong-target mistake `hedgeWords` documents.
    for (const span of proseSpans(text, { excludeBlockquote: true })) {
      for (const { spec, re } of FAMILY_MATCHERS) {
        // A backed family is not scanned at all: the turn produced the receipt, and the sentence's
        // shape stops mattering.
        if (backed.has(spec.family)) continue;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(span.value)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          if (inRelativeClause(span.value, m.index)) continue;
          // Scoped to the claim's OWN sentence, not the paragraph — the roborev 55713 lesson next
          // door: `proseSpans` emits one span per markdown text node, so a paragraph-wide exclusion
          // test lets one incidental "if you" anywhere switch the whole check off.
          const sentence = sentenceAround(span.value, m.index);
          if (CONDITIONAL_PATTERNS.some((p) => p.test(sentence))) continue;
          if (PAST_TURN_PATTERNS.some((p) => p.test(sentence))) continue;
          violations.push({
            check: UNBACKED_CLAIM_CHECK_ID,
            severity,
            // Always `"warned"`: nothing revises a reply yet, and claiming otherwise would inflate
            // the correction-rate rollup this log exists to make trustworthy (roborev 55981).
            action: "warned",
            // METADATA ONLY — a character COUNT, never the matched text. `detail` names the family
            // and what was missing, and carries no reply prose (see `Violation`'s doc comment).
            span: m[0].length,
            detail: `claimed a ${spec.label} with no ${spec.label} call`,
          });
        }
      }
    }
    // One violation per unbacked claim: three sentences each claiming a send is three findings, and
    // collapsing them would hide how much of the reply was unverifiable.
    return { text, violations };
  },
};
