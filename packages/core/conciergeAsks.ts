// THE ASK QUEUE — what the founder asked for, written down by CODE so the model cannot forget it.
//
// ══ THE FAILURE THIS CLOSES ═════════════════════════════════════════════════════════════════════
// On 2026-08-09 the founder asked, in one sitting, what had become of four things he had previously
// asked for. Two of them — a set of "Gary Tan ideas" and a request for research agents the concierge
// could dispatch to — had left NO trace anywhere: no bead, no agent, no board row, nothing in any
// project's history. They had not been refused, deprioritised or deferred. They had evaporated.
//
// His question was the right one: *"why am I having to ask you so many questions about stuff that I
// already asked you to build?"*
//
// ══ WHY THEY EVAPORATED — A STRUCTURAL HOLE, NOT A LAPSE ════════════════════════════════════════
// `engine/conciergeSnapshot.buildSnapshot` is the concierge's ENTIRE per-turn context, and it is two
// things: the live agent roster, and the message the founder just typed. That is all. There is no
// record of anything he asked for previously.
//
// So an ask survives its turn ONLY if the concierge happens to mint an artifact — a bead, a spawned
// agent — inside that same turn. If it merely replies "I'll get that started", the request lives
// exactly as long as the model's context and then ceases to exist. Nothing in the app ever knew
// about it, so nothing in the app can surface it, and the founder is the only remaining copy.
//
// A guideline telling the concierge to file a bead the instant an ask arrives is a behavioural patch
// on a structural hole. It fails in precisely the case that matters: `conciergePromiseLedger`
// measured 45 promises across 1,490 turns and 78% of them were DROPPED. An instruction to remember
// is not a memory.
//
// ══ SO THE CAPTURE IS MECHANICAL — the founder's ruling, interviewed 2026-08-09 ═════════════════
// Asked whether an ask should be recorded by code or declared by the concierge through a tool call,
// he chose CODE, and the reason generalises: a detector for "did you drop something" must not depend
// on the thing whose reliability is in question. Same posture as `nudge_ladder.rs` and
// `conciergePromiseLedger` — regexes and a counter, no model on any path, so it keeps working during
// the outage that takes the concierge down.
//
// The concierge DISCHARGES (it closes the bead when the work is really done); it does not decide
// what counted as an ask. Those are different authorities on purpose: forgetting to record is the
// bug, and the party prone to it does not get to hold the pen.
//
// ══ WHY OVER-CAPTURE IS THE SAFE DIRECTION, AND WHERE IT STOPS ══════════════════════════════════
// The two costs are not symmetric. A false positive is one extra bead the founder closes in a
// second. A false negative is the bug — silent, invisible, and discoverable only by him remembering
// unaided weeks later. So the predicate leans permissive.
//
// It is not unbounded, though, and the limit is CONTENT rather than confidence. A bead has to be
// readable months later by someone who was not in the conversation, so a sentence carrying no
// subject matter cannot become one. That is what {@link MIN_ASK_WORDS} enforces, and it is why bare
// approvals ("go", "do it", "yes please") are deliberately not asks: a bead titled "do it" is
// indistinguishable from every other bead titled "do it", which makes the queue less useful rather
// than more complete. Those words authorise an ask that already exists; they are not a new one.
//
// ══ PURE ═══════════════════════════════════════════════════════════════════════════════════════
// No clock (callers pass `at`), no store, no I/O, no model. Data in, data out.

/** One thing the founder asked for, as captured from a single message. */
export interface AskRecord {
  /**
   * The dedupe key — stable across turns, app restarts and re-asks.
   *
   * This is what makes re-asking IDEMPOTENT. The founder repeating himself is the single strongest
   * evidence an ask matters, and it must escalate the one bead rather than mint a second: two beads
   * for one ask is how a queue becomes unreadable, and an unreadable queue is the state this whole
   * mechanism exists to leave behind. Same rule, and the same reasoning, as the `fbkey-` key on
   * retro pain points (`scripts/lib/retro-beads.sh`).
   */
  key: string;
  /**
   * The founder's own sentence, VERBATIM.
   *
   * Never summarised, and not merely out of fidelity: the bead's title is the thing he will scan
   * weeks later, and he recognises his own words. A paraphrase is a second artifact to reconcile
   * against the transcript, which is the labour this is supposed to remove.
   */
  sentence: string;
  /** The concierge turn this arrived in. */
  turnId: string;
  /** Epoch ms, supplied by the caller — this module has no clock. */
  at: number;
}

/**
 * The shortest sentence that can become a bead, in words.
 *
 * FOUR. Tuned against the shape that actually recurs rather than picked round: the corpus is full of
 * bare authorisations ("go", "do it", "yes go ahead", "ship it") which are one to three words and
 * are never new asks, and the shortest genuine ask observed ("build ten homepage designs") is four.
 * Set it lower and every approval mints a contentless bead; set it higher and real asks are dropped,
 * which is the failure this file exists to prevent.
 */
export const MIN_ASK_WORDS = 4;

/**
 * The most asks one message may produce.
 *
 * A cap is needed — a long paste can contain dozens of imperative sentences and turning each into a
 * bead would bury the queue. But a SILENT cap is exactly the concealment `docs/never-hide-actionable-rows.md`
 * forbids, so {@link asksIn} never drops quietly: see {@link AskCapture.dropped}.
 */
export const MAX_ASKS_PER_TURN = 4;

/** What one message yielded, including what the cap withheld. */
export interface AskCapture {
  /** The asks to file, in the order they were said. At most {@link MAX_ASKS_PER_TURN}. */
  asks: AskRecord[];
  /**
   * How many further asks the cap withheld — NEVER silently discarded.
   *
   * The caller must surface this. A queue that says "3 asks" while holding back a fourth reports a
   * count that sounds complete while concealing work, which is the precise failure mode
   * `docs/never-hide-actionable-rows.md` was written about.
   */
  dropped: number;
}

/**
 * Ways of framing a request that do not begin with an imperative verb.
 *
 * Ordered loosest-last. `please` is here rather than in the verb list because it can precede any
 * verb at all ("please could you have a look"), so matching it as a frame covers forms the verb list
 * would need to enumerate.
 */
const REQUEST_FRAMES: readonly RegExp[] = [
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bwill you\b/i,
  /\bplease\b/i,
  /\bi want (?:you )?to\b/i,
  /\bi['’]?d like (?:you )?to\b/i,
  /\bi need (?:you )?to\b/i,
  /\bwe (?:should|need to|ought to)\b/i,
  /\blet['’]?s\b/i,
  /\bgo ahead and\b/i,
  /\bwhy don['’]?t (?:you|we)\b/i,
  /\bmake sure\b/i,
  /\bi'?d love (?:it if )?(?:you )?\b/i,
];

/**
 * Verbs that make a leading imperative an ask.
 *
 * DECLARED, NOT DERIVED, and the same choice `conciergePromiseLedger` made for its own verb list:
 * stemming these mechanically from some other list produces forms nobody says and misses forms
 * everybody does. Every entry here was observed in the founder's own messages.
 */
const IMPERATIVE_VERBS: readonly string[] = [
  "add",
  "build",
  "change",
  "check",
  "close",
  "create",
  "design",
  "dig",
  "draft",
  "figure",
  "find",
  "fix",
  "get",
  "give",
  "go",
  "have",
  "investigate",
  "look",
  "make",
  "merge",
  "move",
  "open",
  "pull",
  "put",
  "read",
  "rebuild",
  "remove",
  "rename",
  "research",
  "review",
  "run",
  "send",
  "set",
  "ship",
  "show",
  "sort",
  "spawn",
  "start",
  "stop",
  "take",
  "tell",
  "try",
  "turn",
  "update",
  "use",
  "wire",
  "work",
  "write",
];

const IMPERATIVE_RE = new RegExp(`^(?:${IMPERATIVE_VERBS.join("|")})\\b`, "i");

/**
 * Question openers that are a LOOKUP about existing work, not a new ask.
 *
 * These are the sentences the founder should never have needed to type — "what happened to the Gary
 * Tan ideas" is the symptom this whole feature exists to remove, not a fifth thing to go and build.
 * Filing it as an ask would answer his question by adding to the pile it was asked about.
 *
 * A lookup is still evidence, and deliberately not thrown away: {@link isFollowUp} exposes it so a
 * caller can RE-SURFACE the matching open ask instead of minting a new one.
 */
const LOOKUP_FRAMES: readonly RegExp[] = [
  /^what(?:ever)? happened (?:to|with)\b/i,
  /^what[' ]?s (?:the )?(?:status|going on|happening)\b/i,
  /^where (?:is|are|did|do)\b/i,
  /^did (?:you|we|that|it|they)\b/i,
  /^is (?:that|it|this|there)\b/i,
  /^are (?:you|we|they|those)\b/i,
  /^how (?:many|much|far|long|is|are|did)\b/i,
  /^any (?:update|progress|news|word)\b/i,
  /^who(?:'s| is| are)\b/i,
  /^why (?:am|are|is|did|do|does|can[' ]?t|haven[' ]?t)\b/i,
];

/**
 * Openers that sit in FRONT of a lookup without changing what it is.
 *
 * "Can you tell me what happened to the homepage designs?" is the same question as "what happened to
 * the homepage designs?" — but the first one also matches the `can you` request frame, so before
 * this existed it was captured as a brand-new ask and minted a duplicate bead for something already
 * in the queue (roborev 61845). Politeness in front of a question does not make it a request for new
 * work.
 *
 * Stripped iteratively, because they stack: "hey, so can you remind me where is …".
 */
const LOOKUP_PREFIXES: readonly RegExp[] = [
  /^(?:hey|hi|ok|okay|so|and|also|but|btw|quick question)\b[,:]?\s*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:tell me|remind me|let me know|check|say)\s+/i,
  /^(?:do|did)\s+you\s+(?:know|remember)\s+/i,
  /^(?:i(?:'| a)?m\s+)?(?:just\s+)?(?:curious|wondering)\s+(?:about\s+)?/i,
  /^(?:remind me|tell me|let me know)\s+/i,
  /^please\s+/i,
];

/**
 * Is this sentence a question ABOUT existing work rather than a request for new work?
 *
 * The lookup frames are anchored to the start on purpose — an unanchored `\bwhere is\b` would swallow
 * ordinary requests that merely mention a location ("check where the config is"). So instead of
 * unanchoring, known lead-ins are peeled off first and the anchored test is applied to what remains.
 */
export function isFollowUp(sentence: string): boolean {
  let s = sentence.trim();
  // Bounded: each pass must shorten the string, so this cannot spin on a zero-width match.
  for (let i = 0; i < LOOKUP_PREFIXES.length * 2; i++) {
    const before = s;
    for (const re of LOOKUP_PREFIXES) s = s.replace(re, "");
    if (s === before) break;
  }
  return LOOKUP_FRAMES.some((re) => re.test(s.trim()));
}

/**
 * Normalise a sentence down to its dedupe identity.
 *
 * Case, punctuation, filler politeness and whitespace all collapse, so "Build ten homepage designs"
 * and "please build ten homepage designs!" are ONE ask. Word order and content words are preserved,
 * so two genuinely different requests never collide.
 */
function normalize(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(?:please|just|also|really|maybe|actually|can|could|would|you|i|we|to|the|a|an)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A stable, dependency-free 32-bit hash (FNV-1a) rendered as hex.
 *
 * NOT cryptographic and does not need to be — it keys a local dedupe table, so the only property
 * required is that the same sentence yields the same key on every machine and every run. `@sparkle/core`
 * is a leaf package with no dependencies, and pulling one in for this would be the larger cost.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, done in parts so it stays exact in a double.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The dedupe key for a sentence — see {@link AskRecord.key}. */
export function askKey(sentence: string): string {
  return `ask-${fnv1a(normalize(sentence))}`;
}

/**
 * Split a message into candidate sentences.
 *
 * Newlines split as hard as full stops, because the founder writes lists. A bullet's leading marker
 * is stripped so `- build the thing` reads as an imperative rather than as punctuation.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((s) => s.length > 0);
}

function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

/**
 * Words that carry no subject matter — the vocabulary of AUTHORISING rather than of asking.
 *
 * `MIN_ASK_WORDS` alone counts these, so "yes go ahead and do it" is six words and used to mint a
 * bead whose title says nothing (roborev 61845). Length was never the property that mattered; having
 * something to be about is.
 */
const FILLER_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "please", "thanks", "thank",
  "go", "ahead", "do", "it", "that", "this", "them", "now", "then", "and", "so",
  "just", "also", "really", "lets", "let", "us", "we", "i", "you", "the", "a", "an",
  "to", "for", "of", "on", "in", "at", "is", "are", "be", "can", "could", "would", "will",
]);

/**
 * How many words remain once the pure-authorisation vocabulary is removed.
 *
 * TWO is the floor, not four. A stricter content threshold would start dropping real asks — "fix the
 * login bug now" has only three substantive words — and dropping a real ask is the failure this file
 * exists to prevent, so the test is deliberately weak: it rejects sentences that are ENTIRELY filler
 * and essentially nothing else.
 */
const MIN_SUBSTANTIVE_WORDS = 2;

function substantiveWordCount(sentence: string): number {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w)).length;
}

/** Does this sentence ask for something? */
function isAsk(sentence: string): boolean {
  const s = sentence.trim();
  if (wordCount(s) < MIN_ASK_WORDS) return false;
  // …and it must be ABOUT something. See MIN_SUBSTANTIVE_WORDS.
  if (substantiveWordCount(s) < MIN_SUBSTANTIVE_WORDS) return false;
  // A lookup about existing work is a follow-up, never a new ask — see LOOKUP_FRAMES.
  if (isFollowUp(s)) return false;
  if (REQUEST_FRAMES.some((re) => re.test(s))) return true;
  return IMPERATIVE_RE.test(s);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE BEADS MAPPING — pure, so the whole filing policy is testable without a `bd` anywhere near it.
//
// The founder chose beads as the store (interviewed 2026-08-09) rather than a new ask-specific
// surface: it is already durable, already the work graph, already on the board, and the concierge
// already has tools for it. Nothing here talks to `bd` — this half decides WHAT should be written,
// and `services/conciergeAskQueue` performs it.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The label that marks a bead as one of the founder's captured asks. */
export const ASK_LABEL = "concierge-ask";

/** The line embedded in an ask bead's body that carries its {@link askKey}. */
const KEY_MARKER = "ask-key:";

/** Label prefix recording how many times he has asked — `ask-seen-3`. */
const SEEN_PREFIX = "ask-seen-";

/**
 * The bead body for a captured ask.
 *
 * It carries the dedupe key in a parseable line for the same reason the retro path does
 * (`scripts/lib/retro-beads.sh`): without a key on the artifact itself, the only way to tell a
 * re-ask from a new ask is fuzzy title matching, and that gets it wrong in both directions.
 */
export function askBeadBody(ask: AskRecord): string {
  return [
    `${KEY_MARKER} ${ask.key}`,
    "",
    "Captured automatically from what the founder said to the concierge — he did not file this by",
    "hand, and it is here so that the request outlives the conversation it arrived in.",
    "",
    "His words, verbatim:",
    `  ${ask.sentence}`,
    "",
    "Close this bead when the thing is actually done. It is shown to the concierge at the top of",
    "every turn until then.",
  ].join("\n");
}

/** Recover the dedupe key from a bead body, or `null` if this bead does not carry one. */
export function askKeyOf(body: string): string | null {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith(KEY_MARKER)) {
      const key = t.slice(KEY_MARKER.length).trim();
      return key.length > 0 ? key : null;
    }
  }
  return null;
}

/** The `ask-seen-<n>` label for a count. */
export function seenLabel(n: number): string {
  return `${SEEN_PREFIX}${n}`;
}

/**
 * How many times this ask has been made, read off its labels.
 *
 * Defaults to 1: a bead that carries no `ask-seen-` label was filed once and never repeated. An
 * unparseable label is ignored rather than throwing — a hand-edited bead must not break the queue.
 */
export function timesAskedOf(labels: readonly string[]): number {
  let best = 1;
  for (const l of labels) {
    if (!l.startsWith(SEEN_PREFIX)) continue;
    const n = Number.parseInt(l.slice(SEEN_PREFIX.length), 10);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/** An existing ask bead, as the queue needs to see it. */
export interface AskBead {
  id: string;
  body: string;
  labels: readonly string[];
  /** `true` for anything not closed — an open ask is one still owed. */
  open: boolean;
}

/** What one message's capture implies for the store. */
export interface AskPlan {
  /** Asks with no existing bead — file these. */
  create: AskRecord[];
  /**
   * Asks that already have an OPEN bead — bump the recurrence instead of filing a duplicate.
   *
   * The bump is the point rather than a nicety: him repeating himself is the strongest available
   * evidence that something matters, and it has to land on the ONE bead so the evidence accumulates
   * where a reader will see it.
   */
  bump: Array<{ beadId: string; from: number; to: number; ask: AskRecord }>;
  /**
   * Asks whose bead exists but is CLOSED, and he has asked again.
   *
   * Deliberately its own bucket rather than folded into `create` or `bump`. Re-opening silently
   * would erase the fact that somebody judged this done, and filing a duplicate would hide it — but
   * "he asked for a thing we already closed" is exactly the disagreement a human should see, so it
   * is surfaced as its own outcome and a fresh bead is filed citing the old one.
   */
  reasked: Array<{ closedBeadId: string; ask: AskRecord }>;
}

/**
 * Decide what to write, given what was just said and what is already on the board.
 *
 * PURE — no `bd`, no clock, no I/O. The caller supplies the existing ask beads.
 */
export function planAsks(captured: readonly AskRecord[], existing: readonly AskBead[]): AskPlan {
  const byKey = new Map<string, AskBead>();
  for (const b of existing) {
    const key = askKeyOf(b.body);
    if (key === null) continue;
    // An OPEN bead always wins over a closed one with the same key: the open one is the live
    // obligation, and bumping it is what the recurrence evidence is for.
    const seen = byKey.get(key);
    if (seen === undefined || (!seen.open && b.open)) byKey.set(key, b);
  }

  const plan: AskPlan = { create: [], bump: [], reasked: [] };
  for (const ask of captured) {
    const bead = byKey.get(ask.key);
    if (bead === undefined) {
      plan.create.push(ask);
    } else if (bead.open) {
      const from = timesAskedOf(bead.labels);
      plan.bump.push({ beadId: bead.id, from, to: from + 1, ask });
    } else {
      plan.reasked.push({ closedBeadId: bead.id, ask });
    }
  }
  return plan;
}

/**
 * One still-open ask, as the concierge is shown it at the top of every turn.
 *
 * This is the READ side of the queue, and it is the half that actually closes the hole: capturing an
 * ask into beads makes it durable, but durability alone changed nothing for the founder — the board
 * was always there and the concierge still never mentioned the two dropped items, because nothing
 * put them in front of it. An ask survives a context ending only if the NEXT context is handed it.
 */
export interface OpenAsk {
  /** The bead this ask was filed as — the id the founder and the concierge both cite. */
  beadId: string;
  /** His words, verbatim (see {@link AskRecord.sentence}). */
  sentence: string;
  /**
   * How many times he has asked for this — 1 on first capture, incremented by the dedupe key.
   *
   * Rendered only when >1, and it is the single most useful number in the block: a re-ask is the
   * founder telling you, without saying so, that something you did not do mattered.
   */
  timesAsked: number;
}

/**
 * Render the open-ask block for the concierge's per-turn context, or `null` when there is nothing
 * outstanding.
 *
 * ── NEVER TRUNCATED, AND THAT IS A RULE RATHER THAN A CHOICE ────────────────────────────────────
 * Every row here is work the founder is owed, so `docs/never-hide-actionable-rows.md` binds
 * directly: caps and "+N more" apply only to rows carrying no action, and if the block gets long
 * that is correct. The whole defect being closed is a request going unseen; a cap here would
 * reintroduce it wearing the justification of brevity. {@link MAX_ASKS_PER_TURN} bounds how many
 * asks one MESSAGE may mint — it does not bound how many open asks may be shown.
 */
export function renderOpenAsks(asks: readonly OpenAsk[]): string | null {
  if (asks.length === 0) return null;
  const lines = asks.map((a) => {
    const again = a.timesAsked > 1 ? ` (asked ${a.timesAsked}×)` : "";
    return `  - [${a.beadId}] ${a.sentence}${again}`;
  });
  return (
    `STILL OPEN — things he asked you for that are not done yet. He should not have to ask again; ` +
    `if one is finished, close its bead.\n${lines.join("\n")}`
  );
}

/**
 * Capture every ask in one founder message.
 *
 * Duplicates WITHIN a message collapse by {@link askKey}, so a founder who restates the same request
 * twice in one breath produces one ask. Duplicates ACROSS messages are the caller's job — that is
 * the same key, and re-asking is meant to find the existing bead rather than mint a new one.
 */
export function asksIn(text: string, turnId: string, at: number): AskCapture {
  const seen = new Set<string>();
  const found: AskRecord[] = [];

  for (const sentence of sentencesOf(text)) {
    if (!isAsk(sentence)) continue;
    const key = askKey(sentence);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ key, sentence, turnId, at });
  }

  return {
    asks: found.slice(0, MAX_ASKS_PER_TURN),
    dropped: Math.max(0, found.length - MAX_ASKS_PER_TURN),
  };
}
