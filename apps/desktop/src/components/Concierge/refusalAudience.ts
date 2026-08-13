// WHO A TOOL REFUSAL IS FOR — the founder, or the concierge that called the tool.
//
// ══ THE REPORT ══════════════════════════════════════════════════════════════════════════════════
// "This didn't merge refuse stuff is about, and why am I seeing it? Do I need to be seeing that?"
//
// He was being shown, verbatim and repeatedly, things like:
//
//   Didn't merge — Refused: roborev is the review gate on this machine and its state for
//   sparkle/agent-61b8881b-… could not be read. That is "I could not find out", not "it is
//   clean"… roborev row(s) 59204, 59203, 59177, 59169, 59166, 59040 carry no branch…
//
//   Didn't merge — Refused: Checks running (2): Node — shell and Node — coverage — merging now
//   is merging blind.
//
//   Couldn't spawn that agent — I can't start another agent right now. This machine has 90 of
//   its 81 agent slots taken…
//
// Every one of those is a gate working exactly as designed, addressed to the CONCIERGE, which read
// it and took another route — the merge usually completed a minute later. Rendered into the
// founder's thread they read as a wall of red failure text about work that was, in fact, fine. A
// self-correcting system was made to look broken.
//
// ══ WHAT THIS IS NOT ════════════════════════════════════════════════════════════════════════════
// It is NOT permission to swallow failures. That is the same silent-failure bug as a stale PR row
// presented as current: degrade honestly, never invisibly. A refusal only the founder can clear —
// lost credentials, a permission he has to grant, a billing block — has to reach him, or the app is
// simply lying by omission.
//
// AND IT IS NOT PERMISSION TO DROP THE ROW (roborev 63249, Medium). The first cut returned `null`
// for an internal gate, which deleted the receipt entirely — and the receipt is the ONLY surface
// that can contradict the concierge's own prose. `services/conciergeReceipts.ts` records why that
// matters: 32 of 145 measured past-tense claims ("I merged it") had no matching tool call, and a
// settle once reported a REFUSED merge as "Merged PR #753". Delete the row and a turn claiming
// "Merged PR #753" renders with zero counter-evidence, which is the silence the whole receipts
// feature was built to end. His complaint was the PARAGRAPHS, not the existence of a line — so what
// is withheld is the tool's verbose TEXT, replaced by a short gist. "Didn't merge — waiting on
// checks" answers "why am I seeing this" without reopening the hole.
//
// ══ WHY AN ALLOWLIST, POINTING THE WAY IT DOES ══════════════════════════════════════════════════
// The two mistakes are not equal. Showing an internal refusal costs NOISE, which is what the
// founder complained about. Hiding a founder-actionable one costs him the one message that would
// have told him why his app is stuck, and he cannot know to go looking for it. So the default is
// SHOW, and only a reason positively recognised as an internal gate is withheld:
//
//   • an unrecognised reason        → founder. A refusal shape nobody has classified yet can never
//                                     be silently swallowed, which is the property that makes this
//                                     safe to extend.
//   • no reason at all              → founder. Absence is not evidence of anything.
//   • a founder signal ANYWHERE     → founder, even if an internal phrase also matches. Checked
//                                     FIRST for exactly that reason: "roborev could not be read:
//                                     unauthorized" is an auth problem wearing a gate's words, and
//                                     reading it as internal is the one failure that costs real
//                                     time.
//
// The internal list is deliberately narrow and literal. Widening it is a decision to show the
// founder less, so it should be made deliberately, with a case, and with a test.

/** Who needs to read this refusal. */
export type RefusalAudience =
  /** Show it. Either he alone can clear it, or we do not recognise it and will not gamble. */
  | "founder"
  /** A gate aimed at the concierge, which has already read it and adapted. Not thread material. */
  | "internal";

/**
 * Signals that a HUMAN has to do something — credentials, permissions, money, an approval.
 *
 * Matched before anything else. These are the refusals whose cost of being hidden is unbounded:
 * the app stops working and the only person who can fix it is never told.
 */
const FOUNDER_SIGNALS: readonly RegExp[] = [
  // Auth — the single most common "only you can fix this".
  /\bunauthori[sz]ed\b/i,
  /\bnot authenticated\b/i,
  /\bauthentication\b/i,
  /\bgh auth\b/i,
  /\blog ?in again\b/i,
  /\bcredential/i,
  /\btoken (is )?(expired|invalid|missing)\b/i,
  /\b401\b/,
  // Permissions — he has to grant them, or ask someone who can.
  /\bpermission/i,
  /\bnot allowed\b/i,
  /\bforbidden\b/i,
  /\b403\b/,
  // Money — a spending cap or a lapsed plan stops everything and only he can lift it.
  /\bbilling\b/i,
  /\bquota\b/i,
  /\bspending (cap|limit)\b/i,
  /\bpayment\b/i,
  /\bsubscription\b/i,
  /\bplan (limit|expired)\b/i,
  /\b402\b/,
  // An explicit ask for a human decision.
  /\bneeds? (your|human) (approval|decision|input)\b/i,
  /\bask the (founder|user|human)\b/i,
  // ── THE TOOL ITSELF IS NOT THERE (roborev 63249, Medium) ──────────────────────────────────────
  //
  // A missing binary, a dead daemon or a refused socket is PERMANENTLY blocking and only a human can
  // fix it — and it arrives wearing the gate's vocabulary, because `mergeGuard/roborev.ts` splices
  // the raw probe error into "roborev is the gate on this branch and this reading cannot be
  // trusted: <error>". Matched here, ahead of the gates, so a machine whose roborev is down says so
  // once instead of refusing every merge in silence forever. This is not hypothetical: the daemon
  // went down during this very session and printed exactly "failed to connect to daemon (is it
  // running?)".
  /\bcommand not found\b/i,
  /\bnot installed\b/i,
  /\bno such file or directory\b/i,
  /\bENOENT\b/,
  /\bfailed to connect\b/i,
  /\bconnection refused\b/i,
  /\bis the daemon running\b/i,
  /\bdaemon (is )?(not running|unavailable|down)\b/i,
];

/**
 * Gates aimed at the concierge. Each names a condition the concierge itself resolves — by waiting,
 * by retrying, by draining a queue, or by taking another route entirely.
 *
 * Every entry here corresponds to a refusal the founder was actually shown, or to its immediate
 * siblings from the same gate.
 */
// EACH ENTRY MATCHES A GATE'S OWN PHRASING, NOT ITS SUBSYSTEM'S NAME (roborev 63249, Medium).
//
// The first cut listed a bare `/\broborev\b/i`, which is a whole subsystem rather than a gate — and
// `mergeGuard/roborev.ts` interpolates the raw probe error into its refusal, so `roborev: command
// not found`, a dead daemon and `connection refused` ALL arrive as reasons containing "roborev".
// Every one of them is permanently blocking and only a human can clear it, and every one of them
// would have been withheld forever while every merge silently refused. Matching the literal gate
// sentences keeps the pattern honest, and anything the gate did not phrase falls through to the
// default — which is to SHOW it.
//
// The `gist` is what the founder reads in place of the paragraph. Short, plain, and about HIS
// situation rather than the machinery's: he does not need job ids, he needs to know it is held and
// not lost.
const INTERNAL_GATES: readonly { re: RegExp; gist: string }[] = [
  // ── The roborev review gate, by its actual sentences (mergeGuard/roborev.ts, workflow.ts) ──
  { re: /review round is still IN FLIGHT/i, gist: "a code review is still running" },
  { re: /reviews? in flight on this branch/i, gist: "a code review is still running" },
  {
    re: /open FAIL-verdict roborev reviews/i,
    gist: "there are review findings to work through",
  },
  {
    re: /carry open FAIL verdicts that have not been read/i,
    gist: "there are review findings to work through",
  },
  {
    re: /ended without a readable verdict/i,
    gist: "a code review has to be re-run",
  },
  // THE FOUNDER'S OWN PARAGRAPH, and the reason it is matched on this phrase rather than on the
  // "could not be read" it opens with. Both a repairable store and a DEAD roborev produce that
  // opening; only this one names rows whose branch is missing, which is a record to repair and not
  // a tool to install. The bare "could not be read" is deliberately left unmatched, so the generic
  // unreadable case falls through to the default and is SHOWN — see the header on why the
  // tool-unavailable shapes are founder signals.
  { re: /carry no branch/i, gist: "the review gate has records to repair" },
  // CI not settled. Resolves itself, and the concierge waits it out.
  { re: /\bmerging now is merging blind\b/i, gist: "waiting on checks" },
  { re: /\bchecks? (are |is )?(still )?(running|pending)\b/i, gist: "waiting on checks" },
  { re: /\bwait(ing)? for checks\b/i, gist: "waiting on checks" },
  // GitHub has not finished computing mergeability — a beat of latency, not a problem.
  {
    re: /\bhas not finished working out whether\b/i,
    gist: "GitHub is still working out whether it can merge",
  },
  { re: /\bmergeability\b/i, gist: "GitHub is still working out whether it can merge" },
  // The merge is already happening. Not a failure at all; the row leaves on its own.
  { re: /\bmerge already in progress\b/i, gist: "GitHub is already merging it" },
  // Knightwatch probes — the concierge answers or overrides them; both are its own job.
  { re: /\bunanswered .*\bprobe/i, gist: "there are review probes to answer" },
  { re: /\bknightwatch\b/i, gist: "there are review probes to answer" },
  // Fleet capacity. "90 of its 81 agent slots taken" is a queue, and the concierge retries.
  { re: /\bagent slots?\b/i, gist: "no free agent slot right now" },
  { re: /\bslots? (taken|in use|available)\b/i, gist: "no free agent slot right now" },
  { re: /\btimed out waiting for a free slot\b/i, gist: "no free agent slot right now" },
  { re: /\bat capacity\b/i, gist: "no free agent slot right now" },
  // The branch is behind its base — the concierge updates it.
  { re: /\bbehind (its|the) base\b/i, gist: "the branch needs updating first" },
];

/**
 * Who should see this refusal.
 *
 * `reason` is the tool's own refusal text off the receipt. Undefined, empty or whitespace-only is
 * `"founder"`: a refusal that stated no reason gives us no grounds to call it internal, and the
 * existing line for it ("Couldn't close X", with no tail) is already quiet.
 */
/**
 * The SHORT phrase that stands in for an internal gate's paragraph, or `null` when the reason is the
 * founder's to read and must be shown verbatim.
 *
 * The whole answer to "do I need to be seeing that": the row survives — so a refused action still
 * contradicts a turn that claims it succeeded — while the roborev job ids, the check names and the
 * slot arithmetic do not.
 */
export function refusalGist(reason: string | undefined | null): string | null {
  const text = (reason ?? "").trim();
  if (matchesAny(FOUNDER_SIGNALS, text)) return null;
  for (const gate of INTERNAL_GATES) if (gate.re.test(text)) return gate.gist;
  return null;
}

export function refusalAudience(reason: string | undefined | null): RefusalAudience {
  // NO SEPARATE EMPTY-STRING GUARD, deliberately. An early `if (!text) return "founder"` reads as
  // defensive but is behaviourally inert: the default at the bottom is already "founder", so
  // deleting the guard changes nothing and NO test can go red for it — an equivalent mutant, which
  // would sit in this file forever as a line mutation-check can only ever report as uncovered.
  // Falling through to the one default is the same answer by the same route.
  // ONE IMPLEMENTATION, not two rules that must agree: the audience IS "did we find a gist".
  return refusalGist(reason) === null ? "founder" : "internal";
}

/** Does `text` match any of `patterns`? A named loop rather than `.some(re => …)` so each call site
 *  above is a line `scripts/mutation-check.sh` can mutate without an arrow's `=>` breaking the
 *  parse — the branch is only as trustworthy as our ability to prove a test catches it. */
function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  for (const re of patterns) if (re.test(text)) return true;
  return false;
}
