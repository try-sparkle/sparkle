// THE PROMISE LEDGER — "I'll send it" recorded, and reported when it never happens (sparkle-gfume).
//
// ══ THE NUMBER THIS EXISTS FOR ══════════════════════════════════════════════════════════════════
// Measured over all 19 concierge transcripts, 1,490 turns (2026-07-26 → 08-04). The concierge is a
// `claude -p` child, so its reply text and that turn's `tool_use` blocks sit in one file and
// claim-vs-action is decidable rather than anecdotal:
//
//   PROMISES ("I'll send it", "I'll spawn it")   45 made
//   kept (the action happened in the next turn)   9
//   DROPPED                                      35   = 78%
//
//   per family:  merge 100% dropped | bead 100% | close 80% | send 75% | spawn 50%
//
// Compare the past-tense gap `unbacked-claim` covers: 113 backed vs 32 unbacked = 22% miss. THE
// PROMISE DROP IS THE BIGGER NUMBER AND NOTHING TRACKED IT.
//
// ══ WHY IT CANNOT BE A LINT CHECK ═══════════════════════════════════════════════════════════════
// `unbacked-claim` compares a claim against THE SAME TURN's tool calls, and deliberately ignores
// future tense — a reply that says "I'll do that next" is honest, and flagging it would punish the
// honest form. A promise is by construction about a LATER turn, so deciding it needs state ACROSS
// turns, which nothing in the lint path has. Hence a ledger and not a seventeenth check.
//
// ══ WHAT THE DROPPED PROMISES ACTUALLY LOOK LIKE ════════════════════════════════════════════════
// Reading all 35, the dominant shape is not forgetfulness — it is DEFERENCE:
//
//   "Say go and I'll spawn it."   "say the word and I'll close it."
//   "approve it there and tell me to go ahead, and I'll send the brief."
//
// The founder has said what he wants about this, in these words (2026-07-29): "I want you to default
// to action ... I would rather have to stop you and slow you down than nudge you to do something."
//
// That shape is ALSO what `ask-without-action` detects, so a turn can produce both a lint mark and
// an open promise for one sentence. {@link openPromises} is deliberately the only producer here and
// the surface is expected to dedupe; see the note on {@link PromiseRecord.sentence}.
//
// ══ MECHANICAL, NO MODEL, AND THAT IS THE POINT ═════════════════════════════════════════════════
// Same posture as `nudge_ladder.rs`: regexes and a counter. A detector for "did you do what you
// said" must not itself depend on the thing whose reliability is in question, and must keep working
// through a provider outage — which is exactly when the fleet needs it most.
import {
  CLAIM_FAMILIES,
  backedFamilies,
  type ClaimFamily,
} from "./conciergeLint/checks/unbackedClaim";
import type { LintToolCall } from "./conciergeLint";

/**
 * The FUTURE-tense first-person subject. The deliberate mirror of `unbacked-claim`'s `SUBJECT`,
 * which matches past/perfect/progressive and cannot match these.
 *
 * `I'd` is EXCLUDED. "I'd send it immediately" is conditional mood — an opinion about what would be
 * right, not an undertaking — and the corpus is full of it ("I'd send immediately on release").
 * Counting those as promises would inflate the number this ledger exists to make trustworthy.
 */
const FUTURE_SUBJECT = String.raw`\b(?:I['’]ll|I will|I['’]m going to|I am going to)\s+(?:just\s+|then\s+|also\s+)?`;

/**
 * The INFINITIVE forms, per family — declared, not derived.
 *
 * The first version stemmed `unbacked-claim`'s past/progressive verbs mechanically so the two lists
 * could not drift. It produced garbage on English's irregulars — `sent` → `sen`, `closed` → `clos`,
 * `landed` → `lan`, `spinning` → `spinn` — and the tests caught it immediately. A promise needs the
 * infinitive and there is no reliable rule from one to the other, so it is written out.
 *
 * The no-drift property is kept by a TEST rather than by a derivation: `every family has a future
 * form` asserts this map covers `CLAIM_FAMILIES` exactly, so a family added there fails the suite
 * here instead of silently never producing a promise.
 */
const FUTURE_VERBS: Record<ClaimFamily, readonly string[]> = {
  send: ["send", "relay", "pass on", "forward"],
  spawn: ["spawn", "spin up", "start", "launch", "kick off"],
  close: ["close", "spin down", "shut down", "stop", "retire"],
  goal: ["set (?:a |its |the )?goal", "re-?aim"],
  filed: ["file", "open a bead", "raise a bead", "log it"],
  merged: ["merge", "land", "push", "ship"],
};

/** One matcher per family. `(?:be\s+)?` accepts "I'll be sending"; the `s|ing` tail accepts the
 *  gerund the concierge sometimes uses ("I'll be spinning it up"). */
const FUTURE_MATCHERS: readonly { family: ClaimFamily; label: string; re: RegExp }[] =
  CLAIM_FAMILIES.map((spec): { family: ClaimFamily; label: string; re: RegExp } | null => {
    const body = (FUTURE_VERBS[spec.family] ?? [])
      .map((v) => {
        const [head, ...rest] = v.split(/\s+/);
        const tail = rest.length ? `\\s+${rest.join("\\s+")}` : "";
        return `(?:be\\s+)?${head}(?:s|ing)?${tail}`;
      })
      .join("|");
    // AN EMPTY BODY WOULD MATCH THE SUBJECT ALONE. `(?:)` matches the empty string, so a family with
    // no verbs — the shape a typo'd key produces, and the one that actually happened here (`merge`
    // vs the real `merged`) — turns into a regex that fires on EVERY future-tense sentence and
    // reports every family at once. Refusing to build it makes the drift test's "matches nothing"
    // row the thing that catches a bad key, rather than a flood of false promises in production.
    if (body.length === 0) return null;
    return {
      family: spec.family,
      label: spec.label,
      re: new RegExp(`${FUTURE_SUBJECT}(?:${body})\\b`, "gi"),
    };
  }).filter((m): m is { family: ClaimFamily; label: string; re: RegExp } => m !== null);

/**
 * How each family reads in "You said you'd ___".
 *
 * SEPARATE FROM `CLAIM_FAMILIES.label` (roborev 58101). Those labels are NOUN phrases, written for
 * the same-turn check's `detail` string ("claimed a bead filing with no bead filing call") — so
 * dropping them into this sentence produced "You said you'd goal update" and "You said you'd bead
 * filing". A verb phrase and a noun phrase are not interchangeable, and reusing one as the other is
 * the same broken-copy failure as splicing a paragraph into a clause.
 */
const PROMISE_VERB_PHRASE: Record<ClaimFamily, string> = {
  send: "send that",
  spawn: "spawn an agent",
  close: "close it",
  goal: "set a goal",
  filed: "file that",
  merged: "merge it",
};

/** The verb phrase for a family, for the reporting surface. */
export function promiseVerbPhrase(family: ClaimFamily): string {
  return PROMISE_VERB_PHRASE[family] ?? "do that";
}

/** Exported for the drift test — the families this module can produce a promise for. */
export const FUTURE_FAMILIES: readonly ClaimFamily[] = Object.keys(FUTURE_VERBS) as ClaimFamily[];

/** One promise the concierge made and has not yet kept. */
export interface PromiseRecord {
  /** Which family of action was undertaken — the same vocabulary the same-turn check uses. */
  family: ClaimFamily;
  /** Human label for the family, for the surface's wording. */
  label: string;
  /**
   * The sentence that made it, VERBATIM.
   *
   * Carried because the whole value of the report is being able to quote what was said back — "You
   * said you'd send this to X" is checkable in a way "a send promise is open" is not. It is also
   * what a surface should dedupe on when the same sentence produced an `ask-without-action` mark,
   * so the founder gets ONE signal for one failure rather than two.
   */
  sentence: string;
  /** The turn that made it. */
  turnId: string;
  /** Epoch ms, supplied by the caller — this module takes no clock, so it is testable without one. */
  at: number;
  /** How many concierge turns have completed since, not counting the one that made it. */
  turnsSince: number;
}

/**
 * The future-tense promises in one reply.
 *
 * PURE. Takes the reply text and returns what it undertook — no state, no clock, no I/O.
 *
 * Exclusions are NOT applied here, and that is deliberate: `unbacked-claim`'s conditional exclusion
 * exists because "I'm sending it if you confirm" is an offer rather than a report. For a PROMISE the
 * conditional is the normal and most common form — "say the word and I'll spawn it" IS the promise,
 * and it is the single most frequent shape among the 35 that were dropped. Excluding it would blind
 * the ledger to the majority of its own subject matter.
 */
export function promisesIn(text: string, turnId: string, at: number): PromiseRecord[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found: PromiseRecord[] = [];
  const seen = new Set<ClaimFamily>();
  for (const { family, label, re } of FUTURE_MATCHERS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m || seen.has(family)) continue;
    seen.add(family);
    found.push({ family, label, sentence: sentenceAt(text, m.index), turnId, at, turnsSince: 0 });
  }
  return found;
}

/** The sentence containing `index`, bounded so one runaway paragraph cannot become the quote. */
function sentenceAt(text: string, index: number): string {
  const start = Math.max(0, lastBoundaryBefore(text, index) + 1);
  const after = text.slice(index).search(/[.!?\n]/);
  const end = after === -1 ? text.length : index + after + 1;
  return text.slice(start, end).trim().slice(0, 240);
}

function lastBoundaryBefore(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "\n") return i;
  }
  return -1;
}

/**
 * Advance the ledger by one completed turn.
 *
 * `open` in, `open` out — pure, so the whole policy is testable as arithmetic with no clock and no
 * store, exactly as `nudge_ladder`'s `step` is.
 *
 * A promise is KEPT the moment a later turn makes a call that could have produced it. That is the
 * same `backedFamilies` predicate the same-turn check uses, so "what counts as doing it" cannot
 * drift between the two.
 */
export function advanceLedger(
  open: readonly PromiseRecord[],
  turn: { id: string; text: string; toolCalls?: readonly LintToolCall[]; at: number },
): { open: PromiseRecord[]; kept: PromiseRecord[] } {
  const backed = backedFamilies(turn.toolCalls);
  const kept: PromiseRecord[] = [];
  const still: PromiseRecord[] = [];

  for (const p of open) {
    // A promise made in THIS turn is not yet owed — it is owed from the next one. Without this a
    // turn that promises and immediately acts would be recorded as kept-and-open simultaneously.
    if (p.turnId === turn.id) {
      still.push(p);
      continue;
    }
    if (backed.has(p.family)) {
      kept.push(p);
      continue;
    }
    still.push({ ...p, turnsSince: p.turnsSince + 1 });
  }

  // Newly made promises join AFTER the sweep, carrying this turn's id so the guard above holds.
  for (const made of promisesIn(turn.text, turn.id, turn.at)) {
    // One open promise per family. A concierge that says "I'll send it" three turns running has one
    // outstanding obligation, not three, and three lines about it would read as noise.
    if (!still.some((p) => p.family === made.family)) still.push(made);
  }

  return { open: still, kept };
}

/**
 * How many turns a promise may stay open before the ledger says so.
 *
 * TWO, not one. The concierge frequently promises and then acts in the very next turn — 9 of 45
 * were kept exactly that way — so reporting at one turn would fire on the honest path. Two turns is
 * past every kept case in the corpus.
 */
export const PROMISE_GRACE_TURNS = 2;

/**
 * The promises now overdue enough to report.
 *
 * Separate from {@link advanceLedger} so the POLICY (when to speak) is testable apart from the
 * BOOKKEEPING (what is owed), and so a surface can change the threshold without touching the ledger.
 */
export function overduePromises(
  open: readonly PromiseRecord[],
  grace: number = PROMISE_GRACE_TURNS,
): PromiseRecord[] {
  return open.filter((p) => p.turnsSince >= grace);
}

// ══ THE LIVE LEDGER ═════════════════════════════════════════════════════════════════════════════
// The pure core above is the policy; this is the one piece of state that carries it across turns.
// Module-level rather than a React ref for the same reason `postedReceipts` is: it describes the
// CONVERSATION, and `ConciergeHost` unmounts whenever no project is open (App.tsx says so). A ref
// would be rebuilt empty at exactly the moment a promise is ageing.

let openLedger: PromiseRecord[] = [];

/**
 * Record one finished concierge turn, and return the promises now overdue enough to report.
 *
 * Called from `ConciergeHost` at `concierge:done` — the same seam the linter and the receipt path
 * already use, so "a turn happened" is decided in one place.
 *
 * NOT DEDUPED AGAINST `ask-without-action`, and it does not need to be: that check marks the turn
 * that MADE the promise, while this reports two turns later. They are the same failure seen at
 * different moments — the mark says "it offered instead of acting", the report says "and it still
 * hasn't" — so the founder gets one signal per turn, not two at once.
 */
export function noteConciergeTurnForPromises(turn: {
  id: string;
  text: string;
  toolCalls?: readonly LintToolCall[];
  at: number;
}): PromiseRecord[] {
  const { open } = advanceLedger(openLedger, turn);
  openLedger = open;
  const overdue = overduePromises(openLedger);
  // REPORTED ONCE. Dropping them here is what stops the same unkept promise being announced on
  // every subsequent turn — an alarm that repeats forever is one the reader learns to ignore, which
  // is the failure `sparkle-b3coh` records for the attention banner.
  if (overdue.length > 0) {
    const reported = new Set(overdue.map((p) => p.family));
    openLedger = openLedger.filter((p) => !reported.has(p.family));
  }
  return overdue;
}

/** Drop the ledger. Called by the identity reset — an unkept promise belongs to the human it was
 *  made to, and reporting it to the next one would be nonsense. Also the test reset. */
export function clearPromiseLedger(): void {
  openLedger = [];
}
