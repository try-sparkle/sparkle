// WHAT AN AGENT SAYS IS BLOCKING IT, AND WHO CAN ACT ON THAT — the typed half of the loop.
//
// ── WHY THE ANSWER IS A GRAMMAR AND NOT PROSE ────────────────────────────────────────────────────
// The re-query used to ask "can you give me a brief status update on where things stand?" and four
// agents answered it, verbatim and well: each wrote a paragraph about what it had read and what
// remained, and then STOPPED — several ending by asking a question back. The prompt asked for a
// report, so it got a report. An agent that answers it correctly ends its turn MORE stuck than it
// started, because it has now spent a turn narrating instead of merging.
//
// So the ask changes shape twice over. It asks the two questions that move work — what is BLOCKING
// you from merging, and what will you do next WITHOUT asking — and it requires the answer in a
// fenced block with a five-word vocabulary, so the thing that reads it is a parser rather than
// another model call. That second part is not tidiness. `pusherFleet`'s header records why no rung
// of this system may call a model: `claude_oneshot` runs on the user's OWN subscription login, so a
// Pusher that needed a model to understand its fleet would be dead exactly when the fleet is
// quota-blocked — the one moment it is most needed. A parser is not.
//
// ── THE VOCABULARY IS A ROUTING TABLE, NOT A TAXONOMY ────────────────────────────────────────────
// Every state below exists because a DIFFERENT party can act on it. That is the only reason any of
// them exists, and it is the test for adding a sixth: if two states route to the same party with the
// same action, they are one state wearing two names, and the extra name only makes the agent's
// choice harder.
//
//   • blocked-on-ci             → the concierge reads the failing job. The agent already looked.
//   • blocked-on-another-agent  → the concierge arbitrates. Neither party can, by construction.
//   • blocked-on-quota          → NOBODY. Suppressed until the wall lifts (see `routeBlocker`).
//   • blocked-on-human          → the founder. The ONLY state that reaches him.
//   • not-blocked               → the agent itself. It said it can act; it is asked to.
//
// ── FAIL CLOSED, AND HERE THAT MEANS "SILENT" ───────────────────────────────────────────────────
// An unparseable answer yields `undefined`, and `undefined` never routes anywhere — it does not
// become `blocked-on-human` "to be safe". Guessing toward the founder is what turns a watchdog into
// a pager: an agent whose reply got garbled would page him, and the failure that produces garbled
// replies is fleet-wide by nature, so he would be paged once per agent for one bug. Nothing is said
// until something is understood.
//
// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
// No clock (callers pass `now`), no store, no I/O, no model.

/**
 * The five answers an agent may give. Ordered most-blocked to least, which is also the order
 * `routeBlocker` treats as decreasing urgency.
 */
export const BLOCKER_STATES = [
  "blocked-on-human",
  "blocked-on-ci",
  "blocked-on-another-agent",
  "blocked-on-quota",
  "not-blocked",
] as const;

export type BlockerState = (typeof BLOCKER_STATES)[number];

/**
 * The fence tag the answer is wrapped in.
 *
 * Tagged rather than a bare ``` fence because an agent's reply routinely contains OTHER fenced
 * blocks — the command it ran, the diff it is about to push — and a parser that took the first fence
 * it found would read a shell transcript as a blocker report. The tag makes the block addressable in
 * a document the agent is otherwise free to write however it likes.
 */
export const BLOCKER_FENCE = "sparkle-blocker";

/** One agent's answer, parsed. */
export interface BlockerReport {
  state: BlockerState;
  /**
   * The single free-text line the agent supplied: what it will do next, or what it needs.
   *
   * Empty string when the agent gave a state and no line. That is legal — the state alone is
   * routable — and it is kept distinct from an absent REPORT, which is `undefined` from the parser.
   */
  detail: string;
  /** Epoch ms this answer was read. */
  at: number;
}

/** Is this string one of the five? Narrowing helper, so callers need not import the tuple. */
export function isBlockerState(value: string): value is BlockerState {
  return (BLOCKER_STATES as readonly string[]).includes(value);
}

/**
 * THE ASK. One shared constant, because it is delivered from two places now — the connectivity edge
 * and the Pusher's own sweep — and a second copy would drift.
 *
 * Three properties are load-bearing and each was a failure in the version this replaces:
 *
 *   1. It names the merge as the goal. "Where things stand" invites a status report; "what is
 *      blocking you from MERGING" has an answer that is either a blocker or nothing.
 *   2. It forbids asking back. The old prompt's most common ending was a question to the founder,
 *      which converts an agent that was merely idle into one that is genuinely waiting on a human.
 *   3. It puts the machine-readable block LAST and shows it filled in. A schema described in prose
 *      gets paraphrased; a schema shown as the literal bytes to emit gets copied.
 *
 * It deliberately does NOT say "I'm back online" any more. The re-query is no longer tied to the
 * connectivity edge — a 529 is not a network blink, and a stuck agent is stuck either way — so a
 * sentence about the network would be false on most deliveries.
 *
 * ── AND IT CONTAINS NO DIGITS, WHICH IS A HARD CONSTRAINT RATHER THAN A STYLE ────────────────────
 * This text is APPENDED to a Pusher challenge, and `pusherGate.checkCitations` refuses any number in
 * a challenge that is not in that trigger's `measured` list. A numbered list ("1." / "2.") reads to
 * `numbersIn` as exactly that: two fabricated citations, which fails the whole challenge — so the
 * agent would receive nothing at all, silently, and the trigger would burn its cooldown on a message
 * the gate ate. Bullets carry the same meaning and no numbers. A test pins this.
 */
export const BLOCKER_ASK =
  "Status check — do not answer this with a narrative and do not ask me a question back.\n" +
  "\n" +
  "Two things, then act:\n" +
  "• What is BLOCKING you from merging your work to main right now?\n" +
  "• What will you do next WITHOUT asking anyone? Do that thing in this same turn.\n" +
  "\n" +
  "End your reply with exactly this block, filled in:\n" +
  "\n" +
  "```" +
  BLOCKER_FENCE +
  "\n" +
  "blocked: <one of: " +
  BLOCKER_STATES.join(" | ") +
  ">\n" +
  "next: <one line: what you are doing about it>\n" +
  "```";

/**
 * Pull the last `sparkle-blocker` block out of an agent's reply.
 *
 * THE LAST ONE, NOT THE FIRST (this is the whole reason the function is not a one-line regex): the
 * text handed in is a terminal transcript or an inbox thread, so it accumulates. It contains the ASK
 * itself — which embeds a literal example of the block — and it may contain the agent's answers from
 * previous cycles. Reading the first match returns the example every single time, i.e. a parser that
 * always reports the placeholder and never the answer. Reading the last returns the freshest thing
 * the agent actually wrote.
 *
 * The placeholder is additionally rejected on its own merits: `<one of: …>` is not a state, so even
 * a transcript containing ONLY the ask parses to `undefined` rather than to a wrong answer.
 */
export function parseBlockerReport(text: string, now: number): BlockerReport | undefined {
  // Fences are matched with a permissive tail so ```sparkle-blocker and ``` sparkle-blocker both
  // work, and the closing fence may be the end of the string (a reply truncated mid-write still
  // carries a usable answer if the two lines arrived).
  const re = new RegExp("```[ \\t]*" + BLOCKER_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)(?:```|$)", "g");

  let body: string | undefined;
  for (const m of text.matchAll(re)) body = m[1];
  if (body === undefined) return undefined;

  let state: BlockerState | undefined;
  let detail = "";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const blocked = /^blocked[ \t]*:[ \t]*(.*)$/i.exec(line);
    if (blocked) {
      // Lowercased and stripped of any surrounding decoration an agent may add (`backticks`,
      // "quotes", **bold**) — the vocabulary is the contract, its typography is not.
      const word = (blocked[1] ?? "")
        .trim()
        .replace(/^[`"'*_]+|[`"'*_.,;]+$/g, "")
        .toLowerCase();
      if (isBlockerState(word)) state = word;
      continue;
    }
    const next = /^next[ \t]*:[ \t]*(.*)$/i.exec(line);
    if (next) detail = (next[1] ?? "").trim();
  }

  if (state === undefined) return undefined;
  return { state, detail, at: now };
}

/**
 * What the asker knows before it decides whether to ask at all.
 *
 * See {@link buildAsk}. Every field is cheap and non-model: a parsed previous answer, one boolean
 * the caller derived from state it already polls, and a list of sentences about what moved.
 */
export interface AskInput {
  /** The agent's previous answer, if one could be read out of its output. */
  previous?: BlockerReport;
  /**
   * Was the agent's last known state TERMINAL — goal met, nothing unlanded, nothing outstanding?
   *
   * Supplied rather than derived from `previous` because the answer is not in the answer.
   * `not-blocked` means "I can act", which is true of an agent about to open a PR and of one that
   * merged an hour ago; only the caller's own view of the goal and the branch tells those apart.
   */
  terminal: boolean;
  /**
   * What has measurably changed since the last ask, as finished sentences.
   *
   * MUST BE DIGIT-FREE when the result will be appended to a Pusher challenge — `checkCitations`
   * refuses any number not in that trigger's `measured` list, so "main moved 12 commits" would fail
   * the whole challenge and the agent would receive nothing at all. Say "main has moved since you
   * last looked" instead. A test pins that this function's own composition adds no digits, ARM BY
   * ARM — including the one that quotes the agent back to itself, which is the only path that can
   * smuggle a number in from outside.
   */
  changes: readonly string[];
  /**
   * How long since we last asked this agent ANYTHING, in ms. `undefined` means never.
   *
   * THE SILENCE HAS TO BE BOUNDED, and this is what bounds it — see arm 1. Without it, suppression
   * is permanent by construction: `changes` can only carry a sentence when a measurement MOVES, and
   * a wedged agent's measurements never move. So one wrong `terminal` reading silences that agent
   * for the life of the process, which is precisely the failure this whole loop exists to prevent.
   *
   * MUST BE NON-NEGATIVE, and a negative value is treated as unusable rather than as "very recent".
   * Callers compute this as `now - askedAt`, which goes negative whenever the wall clock steps
   * BACKWARDS — an NTP correction after sleep/wake, a VM resume, a manual clock change. Read
   * naively, that is a large negative number, which compares as less than any threshold and so reads
   * as "asked a moment ago": the unbounded silence this field exists to prevent, re-entered through
   * the bound itself, and lasting until wall time catches back up to a stale stamp.
   */
  msSinceLastAsk?: number;
}

/**
 * The longest an agent may go unasked because it looked finished.
 *
 * One hour. The suppression exists to stop re-asking a finished agent every few minutes, and an
 * hourly check costs one turn against a fleet-wide saving of many — while capping the damage of a
 * wrong `terminal` at an hour of silence instead of forever.
 *
 * The wrong-`terminal` case is not hypothetical. `goal.metAt` is LATCHED and only cleared when the
 * goal is re-set, so an agent re-tasked without a new goal reads terminal indefinitely; so does one
 * that died before committing anything, which is exactly the 529 case this branch is built around —
 * clean branch, met goal, dead process, nothing ever moving again.
 */
export const MAX_SILENCE_MS = 60 * 60_000;

/** Longest quoted-back detail. Beyond this it is the agent's essay, not a reminder of its answer. */
export const MAX_QUOTED_DETAIL = 160;

/**
 * THE ASK, COMPOSED — or nothing at all, which is the case that matters most.
 *
 * ── WHY A FIXED STRING WAS NOT ENOUGH ────────────────────────────────────────────────────────────
 * The founder ranked two real exchanges. The one that WORKED: asked for status, told PR #1104 is
 * merged with the commit and the ancestry check. The one that did NOT:
 *
 *   | I'm back online. Can you give me a brief status update on where things stand?
 *   | Same as last check: everything is done and landed. No new information since — I re-verified
 *   | a moment ago and nothing has moved.
 *
 * His reading, and it is the right one: *"The second is not a bad ANSWER; it is a bad QUESTION."*
 * The agent had already reported done-and-landed, nothing had changed, and it was asked anyway —
 * burning a full turn (context load, tool calls, response) to be told what we already knew. At
 * fleet scale that is the dominant cost of asking, and it is pure waste.
 *
 * So the ask is a function of two things, and only one of its three arms is a question:
 *
 *   1. NOTHING CHANGED + last state TERMINAL → ask nothing. Return `undefined`, send no message.
 *      This is the arm that produced the bad example, and it must never generate one.
 *   2. NOTHING CHANGED + last state BLOCKED → ask about THAT blocker by name. Naming it is what
 *      makes the turn worth spending; a generic status question re-asks something already answered.
 *   3. SOMETHING CHANGED → lead with the change, then ask. The change is the new information that
 *      justifies the interruption.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────────
 * Not a replacement for the fixed string, and the two must not be merged. `BLOCKER_ASK` still
 * exists and is still sent verbatim in the first-contact case, because a canned line is the only
 * thing that works when every model is down — that is the whole point of the deterministic layer
 * (`sparkle-a94sr`), and this composed layer sits above it. Nothing here calls a model either;
 * "composed" means assembled from measurements, exactly like every other sentence in this package.
 */
export function buildAsk(input: AskInput): string | undefined {
  const changed = input.changes.filter((c) => c.trim() !== "");

  // ARM 1 — the waste case. Silence is the answer, and it is returned as `undefined` rather than as
  // an empty string so a caller cannot accidentally send it.
  //
  // THREE CONDITIONS, NOT ONE, AND THE EXTRA TWO ARE WHAT MAKE IT SAFE (roborev 57707). Suppressing
  // on `terminal` alone is permanent: `changes` only carries a sentence when a measurement MOVES,
  // and a wedged agent's measurements never move — so one wrong reading silences that agent for the
  // life of the process. Two independent bounds:
  //
  //   • CORROBORATION. The agent must have SAID it is not blocked. `terminal` is our inference from
  //     a latched `goal.metAt` and a clean branch; `previous` is the agent's own report. An agent we
  //     have never heard from is asked, which is also what the reconnect trigger is for — its whole
  //     justification is that every agent's picture may have gone stale at once.
  //   • EXPIRY. Even fully corroborated, the silence lapses after `MAX_SILENCE_MS`. One ask per
  //     stuck agent per hour is cheap; never asking again is the failure mode this loop exists to
  //     prevent, and it is the one the founder keeps finding.
  //   • A USABLE ELAPSED READING. `undefined` (never asked) and any NEGATIVE value (the clock
  //     stepped backwards) both fail this comparison and both mean the same thing here: we cannot
  //     show the silence is recent, so we do not stay silent. There is deliberately no separate
  //     `!== undefined` clause — `undefined >= 0` is already false, and a redundant clause is one a
  //     mutation cannot break, which is the vacuous shape this repo gates on.
  const askedRecently =
    (input.msSinceLastAsk as number) >= 0 && (input.msSinceLastAsk as number) < MAX_SILENCE_MS;

  if (
    changed.length === 0 &&
    input.terminal &&
    input.previous?.state === "not-blocked" &&
    askedRecently
  ) {
    return undefined;
  }

  const lead = changed.length > 0 ? `${changed.map((c) => `• ${c}`).join("\n")}\n\n` : "";

  // ARM 2 — nothing moved, and the agent last said it was blocked on something specific. Ask about
  // that, by name. `detail` is the agent's own words, so quoting it is what makes the question read
  // as a follow-up rather than as the same generic prompt arriving again.
  const previous = input.previous;
  if (changed.length === 0 && previous !== undefined && previous.state !== "not-blocked") {
    // QUOTED ONLY IF IT IS SAFE TO QUOTE (roborev 57707). `detail` is an unbounded line of the
    // agent's own output — "shard 4 is red", "waiting on PR #1104", "CI run 12345" — and this is the
    // one arm that interpolates outside text into a composed ask. A number in it would fail
    // `checkCitations` for the whole challenge and the agent would receive NOTHING, silently, while
    // the trigger burned its cooldown.
    //
    // Dropped rather than scrubbed: a detail with the numbers stripped out ("shard is red") reads
    // like a quote and is not one, and misquoting an agent back to itself is worse than not quoting
    // it. The state name alone still makes the follow-up specific.
    const quotable =
      previous.detail.length > 0 &&
      previous.detail.length <= MAX_QUOTED_DETAIL &&
      !/\d/.test(previous.detail);
    const named = quotable ? ` — you said: ${previous.detail}` : "";
    return (
      `Nothing has moved since you last reported "${previous.state}"${named}.\n\n` +
      `Do not restate that. Either it is now clear and you proceed and land, or name in one line ` +
      `what is STILL blocking you and who has to act on it.\n\n${machineBlock()}`
    );
  }

  // ARM 3 (and first contact) — lead with whatever changed, then the standing ask. With no changes
  // and no previous answer this is `BLOCKER_ASK` verbatim, which is the honest default: we have
  // nothing to be specific about yet.
  return changed.length === 0 ? BLOCKER_ASK : `${lead}${BLOCKER_ASK}`;
}

/** The fenced block, shared by every arm that asks a question. */
function machineBlock(): string {
  return (
    "End your reply with exactly this block, filled in:\n\n```" +
    BLOCKER_FENCE +
    "\nblocked: <one of: " +
    BLOCKER_STATES.join(" | ") +
    ">\nnext: <one line: what you are doing about it>\n```"
  );
}

/** Who a finding is handed to. `none` is a real answer, not a failure — see `routeBlocker`. */
export type PushTarget = "agent" | "concierge" | "founder" | "none";

/** One routed finding: who to push, why, and the sentence to deliver. */
export interface BlockerRoute {
  target: PushTarget;
  /** Stable id for the log and for the no-repeat rule. Never shown to a human. */
  reason: string;
  /**
   * What to say. Empty when `target` is `none`.
   *
   * Built here rather than by the caller so the routing decision and the words that carry it cannot
   * drift apart — the failure `user-facing copy is code` names: a fix that changes WHEN something
   * happens, leaving the string that described the old timing in place.
   */
  text: string;
}

/** What the router knows about the agent besides its own answer. */
export interface BlockerContext {
  /** The agent's display label, quoted into anything addressed to a third party. */
  label: string;
  /**
   * How many times this agent has already been pushed about this same episode WITHOUT moving.
   *
   * The founder's rule, and it is the one that makes the loop terminate: an agent pushed twice that
   * did not move is no longer an agent problem. It escalates to the concierge whatever it SAID was
   * blocking it, because the thing it said is now demonstrably not the whole story.
   */
  unmovedPushes: number;
  /** Epoch ms the agent's quota wall lifts, when one is known. Suppresses `blocked-on-quota`. */
  quotaResetAt?: number;
  now: number;
}

/**
 * How many unproductive pushes an agent gets before the finding goes to the concierge instead.
 *
 * TWO, from the founder: *"a build agent that has been pushed twice and did not move"*. The value
 * matters less than the property — that the same agent cannot be pushed about the same episode
 * forever — which is what stops this loop becoming the thing it exists to fix.
 */
export const UNMOVED_PUSH_LIMIT = 2;

/**
 * Route one answer to the party that can act on it.
 *
 * ORDER OF PREFERENCE, and it is the founder's, not an implementation detail: push the BUILD AGENT
 * when the agent itself can act; push the CONCIERGE when only the concierge can; reach the FOUNDER
 * only when neither can. Escalating earlier than that is the failure mode — every watchdog before
 * this one pointed at build agents and none pointed at the thing supposed to be watching them, so
 * "stuck" persisted rather than self-clearing, and the only party who ever noticed was the founder.
 */
export function routeBlocker(report: BlockerReport, ctx: BlockerContext): BlockerRoute {
  // THE STALL OVERRIDE, CHECKED FIRST AND DELIBERATELY SO. An agent that has been pushed twice
  // without moving has falsified its own answer by not acting on it, so its answer no longer selects
  // the route. The one exception is quota, which is checked below it: a walled agent has not failed
  // to move, it has been unable to, and escalating that would page a human about arithmetic.
  if (ctx.unmovedPushes >= UNMOVED_PUSH_LIMIT && report.state !== "blocked-on-quota") {
    return {
      target: "concierge",
      reason: "pushed-twice-unmoved",
      text:
        `${ctx.label} has been pushed ${ctx.unmovedPushes} times and has not moved. ` +
        `It reports "${report.state}"` +
        (report.detail ? `: ${report.detail}` : "") +
        `. Read its terminal and decide whether to unblock it, respawn it, or retire it.`,
    };
  }

  switch (report.state) {
    // NOBODY CAN ACT, AND THAT IS THE FINDING. A walled agent cannot execute anything until a
    // wall-clock time, so there is no push that helps — and it must NOT reach the founder, because
    // a quota wall is the one blocker that resolves itself on a clock he cannot beat. Suppressed
    // rather than reported, exactly as `sweepPushers` already suppresses challenges to walled
    // partners.
    case "blocked-on-quota":
      return { target: "none", reason: "quota-suppressed", text: "" };

    case "blocked-on-ci":
      return {
        target: "concierge",
        reason: "ci-needs-reading",
        text:
          `${ctx.label} is blocked on CI` +
          (report.detail ? `: ${report.detail}` : "") +
          `. Read the failing job and either dispatch a fix or state the exact failure — ` +
          `the agent has already looked and could not clear it.`,
      };

    case "blocked-on-another-agent":
      return {
        target: "concierge",
        reason: "cross-agent-collision",
        text:
          `${ctx.label} is blocked on another agent` +
          (report.detail ? `: ${report.detail}` : "") +
          `. Name both agents and tell the blocker to land or step aside — neither of them can ` +
          `arbitrate this.`,
      };

    // THE ONLY ROUTE THAT REACHES A HUMAN, and it carries ONE question on ONE line. A blocker that
    // needs the founder and cannot be stated in a line is a blocker the concierge should be reading
    // the terminal for, not one he should be paged about.
    case "blocked-on-human":
      return {
        target: "founder",
        reason: "needs-human-decision",
        text: report.detail
          ? `${ctx.label} needs you: ${report.detail}`
          : `${ctx.label} says it is blocked on you and did not say what it needs.`,
      };

    // NOT BLOCKED. It said it can act, so it is asked to — and this is the arm that produced the
    // whole bug: an agent that answers "not blocked" and then ends its turn is exactly the silent
    // build agent the founder keeps finding. The push quotes its own words back, because the thing
    // it said it would do is the thing it did not do.
    case "not-blocked":
      return {
        target: "agent",
        reason: "not-blocked-but-idle",
        text: report.detail
          ? `You reported "not-blocked" and said you would: ${report.detail}. ` +
            `You have not done it. Do it now, then land your work — do not reply to this.`
          : `You reported "not-blocked" and then stopped. Land your work now — do not reply to this.`,
      };
  }
}

/**
 * The report an agent NEVER GAVE — the case that matters most, because it is the observed one.
 *
 * "Mount Tells The Truth" died on an Anthropic 529 after 21 minutes of good work and sat `errored`
 * for the rest of the night. It did not answer a re-query, because it could not: there was no
 * process left to answer. Every route above is keyed on an ANSWER, so an agent that cannot speak
 * would fall through all of them — which is precisely the hole the founder found, restated one layer
 * up. Silence has to be routable too.
 *
 * A transient failure (529, overloaded, a socket reset) is retried on the caller's backoff and NOT
 * reported anywhere until the retries are spent; a non-transient one goes straight to the concierge,
 * because a build agent that is not running cannot be pushed to do anything about not running.
 */
/**
 * An agent held behind an ACCOUNT LIMIT — alive, reachable, and unable to do anything about it.
 *
 * ── WHY THIS IS NOT `routeSilence` (roborev 57773) ───────────────────────────────────────────────
 * It was, briefly, and both of that router's factual claims were wrong here. `decideRevive` escalates
 * `failure === "terminal"` BEFORE the `canAcceptInput` / `processAlive` gates, so a walled agent is
 * typically RUNNING and accepting input — it simply cannot make progress. `routeSilence` opens with
 * "is not running and cannot be pushed", which is false, and ends with "restart it or take its
 * branch over" — and restarting an agent whose session window has not reset just re-fails, which is
 * the precise harm the fix that introduced this was written to prevent. A concierge following that
 * instruction does the wrong thing.
 *
 * Silence and a wall are different states and they need different words. This one says the agent is
 * alive, says waiting is what clears it, and says explicitly not to restart.
 *
 * Still the CONCIERGE and never the founder, for the same reason as every other route here: taking a
 * branch over is something the concierge can do, and a limit that resets on a clock is not something
 * to page a human about. `pusherFleet` already suppresses quota conditions from "needs you" for the
 * same reason.
 */
export function routeAccountLimit(input: {
  label: string;
  /** The verbatim banner, which is the only place the reset time and the remedy path appear. */
  message?: string;
}): BlockerRoute {
  return {
    target: "concierge",
    reason: "account-limited",
    text:
      `${input.label} is running but blocked on an account limit` +
      (input.message ? `: ${input.message}` : "") +
      `. Retrying cannot clear it and DO NOT restart it — a restart re-fails until the window ` +
      `resets or the cap is raised. Take its branch over if the work cannot wait.`,
  };
}

export function routeSilence(input: {
  label: string;
  /** True when the agent's last error reads as self-clearing — see `isTransientFailure`. */
  transient: boolean;
  /** Retries already spent against this episode. */
  retries: number;
  /** How many are allowed before it escalates. */
  retryLimit: number;
  /** The verbatim error, quoted so the concierge reads what the agent read. */
  message?: string;
}): BlockerRoute {
  if (input.transient && input.retries < input.retryLimit) {
    return { target: "none", reason: "transient-retrying", text: "" };
  }
  return {
    target: "concierge",
    reason: input.transient ? "transient-retries-exhausted" : "errored-not-transient",
    text:
      `${input.label} is not running and cannot be pushed` +
      (input.message ? `: ${input.message}` : "") +
      (input.transient
        ? `. It was retried ${input.retries} times and stayed dead. Restart it or take its branch over.`
        : `. Read its terminal, then restart it or take its branch over.`),
  };
}

/**
 * Does this failure read as self-clearing?
 *
 * MATCHED ON THE VERBATIM MESSAGE, because that is the only durable channel: an agent that dies
 * mid-turn leaves its error text and its file mtimes, and nothing else. The list is deliberately
 * narrow — every entry is a failure whose own documentation says to retry it — because the cost of a
 * wrong `true` is an agent quietly retried into the ground while the founder is told nothing, and
 * the cost of a wrong `false` is one early, correct escalation to the concierge. Those are not
 * symmetric, so this fails toward escalating.
 *
 * 529 is the case this was built for and it is worth naming: Anthropic returns it for `overloaded`,
 * it is transient by definition, and nothing in this app retried it.
 */
export function isTransientFailure(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("529") ||
    m.includes("overloaded") ||
    m.includes("rate_limit") ||
    m.includes("rate limit") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("temporarily unavailable")
  );
}

/**
 * Backoff for a transient failure, in ms: 1m, 4m, 9m, 16m … capped.
 *
 * QUADRATIC RATHER THAN EXPONENTIAL, and the reason is the observed case. A 529 clears in minutes,
 * so doubling (1, 2, 4, 8, 16, 32m) spends most of its budget waiting long after the wall lifted;
 * the agent in the founder's example was recoverable within the first few minutes and sat dead for
 * hours. Quadratic reaches the same total delay while checking back several more times inside the
 * window where recovery actually happens.
 *
 * `attempt` is 0-based: the first retry waits `RETRY_BASE_MS`.
 */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 15 * 60_000;

export function retryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt)) + 1;
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * n * n);
}

/**
 * How many times a transient failure is retried before the concierge is told.
 *
 * Four, which with {@link retryDelayMs} spans 1 + 4 + 9 + 15 = 29 minutes of patience. Long enough
 * that a genuine 529 episode is ridden out without anybody hearing about it; short enough that a
 * dead agent is somebody's problem inside half an hour rather than overnight, which is the failure
 * this exists to prevent.
 */
export const TRANSIENT_RETRY_LIMIT = 4;
