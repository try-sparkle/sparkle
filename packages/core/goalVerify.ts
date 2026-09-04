// HOW A GOAL GETS CHECKED — the difference between a goal that is *stated* and one that can be *proven*.
//
// ── THE HOLE THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────────────
// `goalGate` makes sure a goal EXISTS and reads like a criterion. Nothing made sure it was MET.
// `set_agent_goal_met` is documented to the agent as *"Mark your goal MET when you have actually
// finished it"* — the agent asserts it, `metAt` latches on its word, and `metAt` is THE ONLY signal
// that makes an idle agent count as done. So the original failure ("self-reports said done while the
// work sat local") survived one level down: the gate stopped a goalless dispatch, and then trusted
// the same agent to say whether it had hit the goal.
//
// A goal that names HOW to check it can be checked by someone other than the claimant. That is what
// makes "objectively verifiable" true rather than aspirational.
//
// ── THE THREE KINDS, AND WHY EXACTLY THESE ───────────────────────────────────────────────────────
//   command — a command that must exit 0. The strongest kind of EVIDENCE: a machine can run it, so
//             "met" is checkable by someone who is not the claimant.
//   landed  — the work is on origin/main, checkable by the same squash/rebase-safe proof the
//             unlanded-work surface uses, so it cannot be asserted. Ties a goal to shipping, which is
//             the outcome that actually matters.
//   human   — genuinely needs a person (a design call, a judgement). Naming this explicitly is the
//             honest option, not a dodge: it ROUTES THE DECISION TO THE HUMAN.
//
// NO STATED KIND MAY BE SELF-MARKED ON THE AGENT'S OWN WORD. See `canSelfMarkMet` —
// `set_agent_goal_met` latches `metAt`, so an agent allowed to call it has self-reported "done"
// regardless of which kind it declared. `landed` is the ONE kind that can be closed without a human,
// and only because a MACHINE answers it: the caller passes git's reading of the branch, the agent
// contributes nothing to that value, and no reading means no close (sparkle-vfkqz).
//
// There is deliberately NO "unverifiable" kind. `human` already covers "no machine can check this",
// and it covers it in the direction that costs the claimant something. An `unverifiable` kind would
// be a self-marking escape hatch wearing an honest label, which is worse than no label — every goal
// that was inconvenient to check would become one.
//
// ── WHAT THIS MODULE DOES AND DOES NOT DO ────────────────────────────────────────────────────────
// Pure: no clock, no I/O, no subprocess, no git. It decides the SHAPE of a check and WHO may declare
// the goal met. It never runs anything — executing a `command` and computing `landed` belong to the
// callers that own those capabilities, and keeping them out of here is what makes every rule below
// unit-testable.
//
// `landed` NOW HAS ONE (sparkle-vfkqz); `command` STILL DOES NOT. The desktop already computes
// branch reachability into origin/main for the unlanded-work surface, so `landed` is answered by a
// machine and `canSelfMarkMet` honours that answer when a caller supplies it. Nothing runs a
// `command`, so that kind still means a PERSON closes the goal — and every user-facing string here
// must keep saying so for `command`, because an agent told a proof is coming waits for one that
// never arrives. Whoever wires the command executor deletes the remaining caveats in the same
// change: in `selfMarkRefusal` below, the `verify` field describe in mcp-control's `server.ts`,
// `.claude/commands/goal.md`, and the sparkle-control SKILL.md.
//
// ── WHY `landed` GOT AN ANSWER FIRST, AND WHAT IT COST TO LEAVE IT UNANSWERED ─────────────────────
// Twice on 2026-08-04 a FINISHED agent was escalated to the founder over work that was already on
// main. Both had a `{kind:"human"}` check nobody chose — it was the blanket fallback an inherited
// check was downgraded to (see `chargeGoalDebt`) — so `set_agent_goal_met` refused, three
// auto-continues burned, and a red row demanded a human who had nothing to do. The gate exists to
// stop an agent declaring UNLANDED work done; firing it on LANDED work inverts it, and a wall of
// false red teaches the founder to ignore the one escalation that is real.
//
// Two rules follow, and they are opposite halves of one idea — the CLAIMANT never gets to answer:
//   • `canSelfMarkMet` accepts `landed` ONLY alongside evidence the caller computed from git. The
//     agent supplies no part of that; it cannot assert its way past it.
//   • `inferGoalVerify` reads a goal's own words to pick the fallback kind, so a goal phrased as a
//     landing question gets the check that can answer it instead of one that cannot.
//
// SECURITY NOTE for whoever wires `command` to real execution: `cmd` is a string a MODEL wrote. Do
// not treat validation here as sanitisation — it rejects a BLANK cmd and nothing else (see the note
// below on why there is no prose heuristic). An executor must decide its own policy: allowlist, no
// shell interpolation, a working directory, a timeout, and whether the user has approved command
// execution at all. This module is not that gate and must not be cited as one.

/** How a goal is proven met. See the header for why these three and no `unverifiable` kind. */
export type GoalVerify =
  /** `cmd` must exit 0. Proven by running it. */
  | { kind: "command"; cmd: string }
  /** The agent's work is on origin/main. Proven from git; cannot be asserted. */
  | { kind: "landed" }
  /** Needs a person. The one kind an agent may NOT mark met itself. */
  | { kind: "human" };

export type GoalVerifyKind = GoalVerify["kind"];

/** Every kind, for exhaustive iteration in tests and for a caller validating untrusted input. */
export const GOAL_VERIFY_KINDS: readonly GoalVerifyKind[] = ["command", "landed", "human"] as const;

/** Minimum characters in a `command` cmd. Shorter than this is not a runnable command. */
export const VERIFY_CMD_MIN_LEN = 3;

export interface VerifyRejected {
  ok: false;
  reason:
    | "verify-missing"
    | "verify-not-an-object"
    | "verify-unknown-kind"
    | "verify-cmd-missing";
  message: string;
}
export type VerifyVerdict = { ok: true; verify: GoalVerify } | VerifyRejected;

/**
 * ── WHY THERE IS NO "IS THIS PROSE?" CHECK HERE ──────────────────────────────────────────────────
 * There was one. It keyed on TRAILING SENTENCE PUNCTUATION, so `"Make sure the tests pass."` was
 * caught and `"make sure the tests pass"` — the likelier thing a model writes — was accepted as a
 * runnable command (roborev 55842). The obvious patch does not exist either: no cheap rule separates
 * `"npm test"` and `"make check"` from `"all tests are green"` without rejecting real two-word
 * commands, and a false rejection here BLOCKS a legitimate goal.
 *
 * So the check is deliberately gone rather than weakened further. A `cmd` that is not runnable fails
 * loudly the first time an executor runs it, the goal does not become met, and that failure names the
 * real problem — which is strictly better feedback than a heuristic refusal that is wrong in both
 * directions. What remains below is the part that IS decidable: a `cmd` must be present and non-blank.
 *
 * Do not reintroduce a prose heuristic without evidence it beats "just run it and report the failure".
 */

/**
 * Validate an untrusted `verify` value into a `GoalVerify`.
 *
 * `undefined`/`null` is a REJECTION (`verify-missing`), not a default. There is no sensible default:
 * guessing `human` would silently route work to the founder, and guessing `landed` would claim a git
 * proof the caller never asked for. The caller must say which.
 */
export function parseGoalVerify(input: unknown): VerifyVerdict {
  if (input === undefined || input === null) {
    return {
      ok: false,
      reason: "verify-missing",
      message:
        `a goal needs to say HOW it is checked: \`{ kind: "command", cmd }\` (must exit 0), ` +
        `\`{ kind: "landed" }\` (the work is on origin/main), or \`{ kind: "human" }\` (needs a ` +
        `person — an agent cannot mark this met itself).`,
    };
  }
  // A NON-OBJECT gets its own sentence. Reading `.kind` off a string yields `undefined`, and the
  // old message then said "unknown verify kind undefined" — naming a value the caller never passed
  // and never mentioning that an object was required. `parseGoalVerify("human")` is exactly what a
  // caller following the `check: human` shorthand tries first (roborev 55842).
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      reason: "verify-not-an-object",
      message:
        `verify must be an OBJECT, not ${JSON.stringify(input)} — e.g. \`{ kind: "human" }\` or ` +
        `\`{ kind: "command", cmd: "npm test" }\`. Legal kinds: ${GOAL_VERIFY_KINDS.join(", ")}.`,
    };
  }
  const kind = (input as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !(GOAL_VERIFY_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      reason: "verify-unknown-kind",
      message:
        `unknown verify kind ${JSON.stringify(kind)}. Use one of: ${GOAL_VERIFY_KINDS.join(", ")} ` +
        `— e.g. \`{ kind: "landed" }\`.`,
    };
  }
  if (kind === "command") {
    const raw = (input as { cmd?: unknown }).cmd;
    const cmd = typeof raw === "string" ? raw.trim() : "";
    if (!cmd) {
      return {
        ok: false,
        reason: "verify-cmd-missing",
        message: `\`{ kind: "command" }\` needs a \`cmd\` — the command that must exit 0.`,
      };
    }
    if (cmd.length < VERIFY_CMD_MIN_LEN) {
      return {
        ok: false,
        reason: "verify-cmd-missing",
        message:
          `\`cmd\` is too short to be a command (got ${JSON.stringify(cmd)}). Give the actual ` +
          `command, e.g. "pnpm --filter @sparkle/desktop exec vitest run src/x.test.ts".`,
      };
    }
    return { ok: true, verify: { kind: "command", cmd } };
  }
  return { ok: true, verify: { kind } as GoalVerify };
}

/**
 * Words that make a goal a GIT ANCESTRY QUESTION. Word-boundary anchored, never substrings: bare
 * `land` would fire on "landscape" and "Netherlands", turning an illustration goal into one closed
 * by a merge-base check.
 *
 * `\b` does not bound a `/`, so `origin/main` is spelled with an explicit alternation rather than
 * trusted to word boundaries.
 *
 * EVERY PATTERN HERE IS LOWERCASE, because {@link inferGoalVerify} casefolds before testing. Two of
 * them were written with a literal uppercase `PR` and no `i` flag and could therefore never match —
 * dead on arrival, and the test that appeared to cover them passed on `\bmerg…\b` in the same
 * sentence instead (roborev 57794). If you add a pattern, add a test whose ONLY matching pattern is
 * the new one, or a dead rule will look covered.
 */
const LANDING_PATTERNS: readonly RegExp[] = [
  /\bland(?:s|ed|ing)?\b/,
  /\bmerg(?:e|es|ed|ing)\b/,
  /\borigin\/(?:main|master)\b/,
  /\b(?:on|to|in|into|reaches|reached)\s+(?:the\s+)?main\b/,
  /\bmain\s+branch\b/,
  /\bancestor\s+of\b/,
  /\bpull\s+requests?\b/,
  // The `#` is OPTIONAL: "pr 1160" is as common as "pr #1160", and requiring the hash re-created the
  // dead-rule bug in miniature — the pattern looked fixed, and no test noticed because every string
  // covering it happened to contain a `#` (roborev 57796).
  /\bprs?\s*#?\s*\d/,
  /\bpr\s+is\b/,
];

/**
 * Words that mean a PERSON decides, and which VETO the patterns above.
 *
 * Precedence is deliberate and it is the direction that fails closed. "the founder approves the PR
 * copy" contains `PR`; inferring `landed` from it would attach an ancestry proof to a goal whose
 * real criterion is someone's taste — this bug pointed the other way, which is not an improvement.
 * A goal that names both is ambiguous, and ambiguity resolves to `human`.
 */
const HUMAN_JUDGEMENT_PATTERNS: readonly RegExp[] = [
  /\bfounder\b/,
  /\bhumans?\b/,
  /\ba\s+person\b/,
  /\bapprov(?:e|es|ed|al)\b/,
  /\bsign(?:s|ed)?[-\s]?off\b/,
  /\bsignoff\b/,
  /\bdecide[sd]?\b/,
  /\bjudge?ment\b/,
  /\bsubjective\b/,
  /\blooks?\s+(?:right|good|correct)\b/,
];

/**
 * Words that make a goal a RELEASE question, which ancestry against origin/main CANNOT answer.
 *
 * AGENTS.md states this as a standing trap: *"'It landed' and 'it shipped' are DIFFERENT questions
 * with different checks"*, and they diverge for the entire ~27-minute window a DMG is building —
 * exactly when someone asks. An agent has already reported work as released on the strength of an
 * origin/main check that could not support the claim. So a shipped-shaped goal falls through to
 * `human` rather than collecting a proof of the wrong fact.
 */
const RELEASE_PATTERNS: readonly RegExp[] = [
  /\bship(?:s|ped|ping)\b/,
  /\breleased?\b/,
  /\bDMG\b/i,
  /\btagg?(?:ed|ing)?\b/,
  /\bv\d+\.\d+\.\d+\b/,
];

/**
 * Read the CHECK out of a goal's own words — `{kind:"landed"}` when git can answer it, `undefined`
 * when it cannot be told confidently.
 *
 * `undefined` is "I cannot tell", NOT "no check". Callers fall back to `{kind:"human"}`, so an
 * un-inferable goal is exactly as gated as it was before this function existed. That asymmetry is
 * the whole safety argument: inference can only ever move a goal from "a person must close this" to
 * "git closes this once it is true", and only for goals that literally ask a git question.
 *
 * This is a HEURISTIC over model-written prose and it does not pretend otherwise. It is sound in the
 * direction that matters — a false `landed` cannot close a goal on its own, because
 * {@link canSelfMarkMet} still demands real ancestry evidence before anything is marked met, and a
 * goal whose text says "merged to main" while meaning something else is a goal that was already
 * mis-stated. A false `undefined` costs a human a click, which is the status quo.
 *
 * Pure, and deliberately not exported as a validator: a caller that KNOWS its check must pass it
 * explicitly to {@link parseGoalVerify}, which still refuses to default anything.
 */
export function inferGoalVerify(goalText: string): GoalVerify | undefined {
  const text = goalText.trim().toLowerCase();
  if (text === "") return undefined;
  if (HUMAN_JUDGEMENT_PATTERNS.some((re) => re.test(text))) return undefined;
  if (RELEASE_PATTERNS.some((re) => re.test(text))) return undefined;
  if (LANDING_PATTERNS.some((re) => re.test(text))) return { kind: "landed" };
  return undefined;
}

/** A stand-in `GoalVerify` for a kind, when only the KIND matters. `cmd` is never inspected there. */
function sampleOfKind(kind: GoalVerifyKind): GoalVerify {
  return kind === "command" ? { kind, cmd: "x" } : ({ kind } as GoalVerify);
}

/**
 * Evidence with every question answered YES — "the most a caller could ever know".
 *
 * Used only to ask the counterfactual *"is this kind closable by the claimant AT ALL?"*, never to
 * close a real goal. Add a field to {@link GoalVerifyEvidence} and it must be answered here too, or
 * the question stops meaning "given the best possible evidence".
 */
// `unlandedWork: false` is this bit's most-favourable value, not a typo: the question it answers is
// "is the branch holding work back", so NO is the reading that could never stand in the way of a
// close. Answering it keeps the counterfactual honest even though `canSelfMarkMet` ignores it.
// `landedSource: "git-probe"` is likewise the most-authoritative provenance a caller could hold —
// git itself, asked live. It changes nothing here (`canSelfMarkMet` never reads it), and is answered
// only to keep this constant's own contract: every question a caller could answer, answered.
const OMNISCIENT_EVIDENCE: GoalVerifyEvidence = {
  landed: true,
  unlandedWork: false,
  landedSource: "git-probe",
};

/**
 * Could the AGENT ITSELF ever close a goal carrying this kind of check, given the best evidence?
 *
 * `landed` yes (git answers it, so the app can close it without a person); `command` and `human` no,
 * whatever evidence turns up — nothing runs a command, and no reading substitutes for a person.
 *
 * ── DERIVED FROM `canSelfMarkMet`, NOT RESTATED (roborev 57806) ───────────────────────────────────
 * This was `kind === "landed"` while `canSelfMarkMet` independently hardcoded the same condition,
 * and the docstring claimed the two "cannot drift" — a property nothing enforced. The day someone
 * wires the command executor and gives `canSelfMarkMet` a `command` arm, a restated-as-`command`
 * check would become self-closing while this predicate still called it un-closable, silently
 * unlocking every goal the debt rules had protected.
 *
 * So it ASKS the authority instead of agreeing with it. One definition, no coupling to maintain.
 */
export function agentClosableKind(kind: GoalVerifyKind): boolean {
  return canSelfMarkMet(sampleOfKind(kind), OMNISCIENT_EVIDENCE);
}

/**
 * How STRONG a check is — how hard it is for the claimant to discharge. Higher binds tighter.
 *
 * ── WHY A RANK RATHER THAN A CLOSABLE/NOT PARTITION (roborev 57806) ──────────────────────────────
 * The debt rule was "an agent may not trade a check it cannot close for one it can", which made
 * `human` → `command` a permitted *lateral* move. It is not lateral. A founder's judgement call
 * becomes a command the AGENT ITSELF authored (`echo ok` passes), and the `command` refusal copy
 * then tells it to *"run it and show the result; a person closes the goal on that evidence"* — a
 * rubber-stamp close of a sign-off nobody gave, in one free-tier call. That is the same laundering
 * the `landed` arm was hardened against, one rung up.
 *
 * Ranking states the real invariant directly: **an agent may never make its own check weaker.**
 *   human   (2) — a person's judgement. Nothing an agent states may replace it.
 *   command (1) — a machine could settle it, but no executor exists, so a person still closes it.
 *   landed  (0) — git settles it, and the claimant may close on that. The weakest, by design.
 */
export function verifyStrength(kind: GoalVerifyKind): number {
  if (kind === "human") return 2;
  return agentClosableKind(kind) ? 0 : 1;
}

/**
 * May a caller-STATED `next` check replace the standing `prior` one?
 *
 * The ONE place the "never weaken your own check" rule is expressed, shared by both doors into a
 * goal's check (`projectStore`'s same-text re-assert and `chargeGoalDebt`'s new-text path). They
 * held two hand-written copies of it and drifted twice in three review rounds — one door hardened
 * while the other stayed open is this bug's signature failure.
 *
 * `undefined` prior means no standing check, so anything may be stated: adding a check to an
 * unverified goal is a legitimate move (roborev 55893), not a trade.
 */
export function mayReplaceVerify(
  prior: GoalVerify | undefined,
  next: GoalVerify,
  opts?: { sameGoal?: boolean },
): boolean {
  if (prior === undefined) return true;
  // ── TWO CASES THE RANK GETS WRONG, AND BOTH ARE ABOUT THE *SAME* GOAL (roborev 57813) ──────────
  //
  // Scoped to `sameGoal` deliberately. On genuinely NEW goal text the standing check describes work
  // the agent has moved on from, so swapping instruments is the legitimate "change your check" case
  // — refusing it there blocks an agent that simply started something else. On the SAME goal there
  // is no other work to point at, so a swap can only be an escape.
  //
  // 1. SAME KIND IS NOT THE SAME CHECK, for `command`. `{cmd:"pnpm test parser"}` → `{cmd:"true"}`
  //    scores 1 >= 1 and sailed through, shedding the obligation *inside* the kind — the check
  //    roborev 57801 hardened, laundered one level down. Once an executor exists it is a self-close
  //    on an agent-authored no-op.
  //
  // 2. `landed` → `command` IS NOT A STRENGTHENING, despite ranking higher. The rank measures "does
  //    a person have to close it", which for a landing goal points the opposite way from "can it be
  //    faked": `landed` is answered by GIT and cannot be asserted, while `command` is answered by a
  //    string THE AGENT WROTE. An agent that cannot land its work would otherwise swap the
  //    unforgeable proof for `echo ok` and hand a person the `command` refusal copy — "run it and
  //    show the result; a person closes the goal on that evidence" — i.e. ask them to rubber-stamp
  //    away an ancestry proof.
  if (opts?.sameGoal) {
    if (prior.kind === "command" && next.kind === "command") return prior.cmd === next.cmd;
    if (agentClosableKind(prior.kind) && next.kind === "command") return false;
  }
  return verifyStrength(next.kind) >= verifyStrength(prior.kind);
}

/**
 * What a caller has actually COMPUTED about a goal's check, for {@link canSelfMarkMet}.
 *
 * Every field is tri-state and `undefined` means NOT LOOKED UP — never "no". That distinction is
 * load-bearing here in the strictest direction available: only an explicit `true` unlocks anything,
 * so an unpolled agent and a genuinely unlanded one both stay refused.
 */
export interface GoalVerifyEvidence {
  /** Is this agent's work on origin/main? Computed from branch reachability — never agent-supplied. */
  landed?: boolean | undefined;
  /**
   * Does this agent hold COMMITTED WORK that is not on origin/main? Same provenance as `landed` —
   * read from the branch's ahead-count, never agent-supplied.
   *
   * ── WHY `landed: false` ALONE CANNOT PICK THE RIGHT SENTENCE ─────────────────────────────────
   * `landed` is computed as a positive test (a merge watermark, minus a new-work veto), so its
   * `false` covers agents that need OPPOSITE next actions:
   *   1. `unlandedWork: true` — the agent is holding commits main does not have. "Land it" is right.
   *   2. `unlandedWork: false` — nothing is being held back. This is the AMBIGUOUS one, and it is
   *      ambiguous all the way down: it is what an agent reads whose work MERGED and whose worktree
   *      was then parked or moved onto another branch (the watermark belongs to the branch it left),
   *      AND what an agent that has committed nothing at all reads, AND what an agent holding only
   *      uncommitted edits reads. Window-local state cannot separate them — only git can, which is
   *      why the copy for this arm asks the agent to run the ancestry check rather than telling it
   *      what happened.
   * Read ONLY by {@link selfMarkRefusal}, never by {@link canSelfMarkMet}: it decides what to TELL
   * the agent, never whether the goal may close. `undefined` ("not looked up") keeps the original
   * sentence, so a caller that does not compute it is unaffected.
   */
  unlandedWork?: boolean | undefined;
  /**
   * WHERE `landed` CAME FROM — the provenance that decides whether the copy may say "git says".
   *
   * ── WHY A `false` IS NOT AUTOMATICALLY GIT'S NO (sparkle-2668a7) ─────────────────────────────
   * Two completely different computations both hand this field `false`:
   *   • `"git-probe"` — a live ancestry check RAN and answered no (`agent_landed_probe` →
   *     `git merge-base --is-ancestor`). That is git's verdict, and the copy may quote it.
   *   • `"window-local"` — `landedEvidenceFor` read already-polled store state and its POSITIVE
   *     TEST FAILED: no merge watermark this window latched, and no live origin reading. It asked
   *     git NOTHING. Saying "git says it is not on origin/main yet" here is a statement of fact
   *     about a check that never ran, and it was measured live: a branch whose HEAD WAS an
   *     ancestor of origin/main, with a MERGED PR, was told git said otherwise and instructed to
   *     open a second PR for work already merged.
   * `undefined` means the caller did not record provenance, which is treated exactly like
   * `"window-local"`: an unrecorded source cannot license a claim about git. Read ONLY by
   * {@link selfMarkRefusal}, never by {@link canSelfMarkMet} — this changes the MESSAGE, not the
   * decision, and a caller that supplies it can never make a goal closable that was not already.
   */
  /** WHERE the `landed` reading came from — `selfMarkRefusal` may quote git only for a verdict git
   *  actually produced. `"git-probe-unproven"` is the third state and not a shade of the other two:
   *  git ran and answered ANCESTOR, and that answer was REFUSED because no authored work is
   *  provable on this branch. Dropping it back to `"window-local"` would make the copy deny git had
   *  spoken while git had, and would then hand the agent an ancestry argument to take to the
   *  concierge — converting a blocked self-latch into a human-mediated false close (roborev 72328). */
  landedSource?: "git-probe" | "window-local" | "git-probe-unproven" | undefined;
  /**
   * Did a caller EVER choose this check — for this goal or an earlier one it was carried from?
   *
   * `false`/`undefined` mean the app manufactured it, or nobody recorded (a check persisted before
   * provenance was tracked). Read only by {@link selfMarkRefusal}, never by {@link canSelfMarkMet} —
   * provenance decides what to TELL the agent, never whether the goal may close.
   */
  stated?: boolean | undefined;
  /**
   * Was it chosen for **this** goal, as opposed to carried over from an earlier one?
   *
   * ── WHY TWO BITS AND NOT ONE (roborev 57827) ─────────────────────────────────────────────────
   * There are THREE populations, and collapsing them to a boolean is wrong in one direction or the
   * other whichever way you fold it:
   *   1. chosen for THIS goal — a real sign-off, on this work. Never invite its removal.
   *   2. carried over from a goal a caller DID choose it for. That earlier goal may be a paraphrase
   *      of this one or unrelated work — **nothing records which** (`chargeGoalDebt` compares only
   *      the inferred kind), so this arm must not claim either. It says the check stands unless it
   *      does not fit, and still names the exit.
   *   3. manufactured, or nothing recorded — nobody chose it at all.
   * `stated` separates 3 from 1+2; `chosenHere` separates 1 from 2. Both are needed.
   *
   * Arms 2 and 3 both name the concierge take-back, deliberately: withholding it from 2 on a guess
   * about restatement is what swallowed the sparkle-vfkqz population (roborev 57832).
   */
  chosenHere?: boolean | undefined;
}

/**
 * May the AGENT ITSELF declare this goal met?
 *
 * **`false` for every stated kind the CLAIMANT would have to answer.** An earlier version returned
 * `true` for `command` and `landed`, reasoning that those claims were "admissible pending a check".
 * That distinction does not survive contact with the thing being prevented: `set_agent_goal_met`
 * LATCHES `metAt`, and `metAt` is the only signal that makes an idle agent count as done. So an
 * agent permitted to call it on its own say-so has self-reported "done" whatever the kind says — "I
 * ran the command and it passed" is exactly the self-report the mechanism exists to replace.
 *
 * **`landed` IS THE EXCEPTION, AND ONLY WITH EVIDENCE (sparkle-vfkqz).** The reasoning above turns
 * on *who answers the question*, and for `landed` the answer comes from git: branch reachability
 * into origin/main, computed by the caller, unforgeable from inside the agent. Refusing it anyway
 * treated a machine-checkable fact as an assertion and manufactured escalations out of finished
 * work — twice in one day, three wasted auto-continue cycles each, on PRs that were already merged.
 * The agent could see its own work on main and had no way to say so.
 *
 * So the rule is `evidence.landed === true`, never `verify.kind === "landed"` alone. `false` and
 * `undefined` ("nobody looked") both refuse. The agent contributes nothing to that value.
 *
 * What each remaining refusal means:
 *   command — the CHECK decides. Someone must run it and mark met on the result. No executor exists.
 *   landed  — GIT decides, and it has not said yes yet (or has not been asked).
 *   human   — a PERSON decides. Evidence of ANY kind is irrelevant here: ancestry does not tell you
 *             whether someone approved something, so it must never unlock this arm.
 *
 * `true` also when NO verify was stated. Every goal that predates this module is in that case, and
 * refusing them would break `set_agent_goal_met` for the whole installed base to enforce a rule they
 * never opted into. That is the compatibility seam, not a loophole: a goal with no stated check was
 * never claiming to be verifiable.
 *
 * This function does NOT decide who else may mark it — the human, and the concierge acting as the
 * human-driven surface, are outside its scope. It answers one question: may the CLAIMANT latch it.
 */
export function canSelfMarkMet(
  verify: GoalVerify | undefined,
  evidence?: GoalVerifyEvidence,
): boolean {
  if (!verify) return true;
  // `=== true` rather than a truthiness test, so `undefined` ("not looked up") can never pass.
  if (verify.kind === "landed") return evidence?.landed === true;
  return false;
}

/**
 * The refusal to hand an agent that tried to latch its own verified goal. Total over every kind.
 *
 * `evidence` is the same value passed to {@link canSelfMarkMet}, and the `landed` arm NEEDS it: "git
 * says your work is not on origin/main" and "nothing has read your branch yet" call for opposite
 * next actions (go land it / wait for a poll), so one sentence covering both sends half the agents
 * that read it the wrong way.
 */
export function selfMarkRefusal(verify: GoalVerify, evidence?: GoalVerifyEvidence): string {
  switch (verify.kind) {
    // THE `command` ARM NAMES A PERSON AS THE CLOSER, because that is still who closes it (roborev
    // 56154). It used to promise an automated closer — "let the check … close the goal" — and no
    // executor exists: nothing runs `cmd`. This is the copy an agent reads at the moment it is
    // BLOCKED, so a promised proof that never arrives leaves it waiting, un-closable (`verify: null`
    // is concierge-only) and auto-resumed until a person notices.
    case "command":
      return (
        `This goal is verified by running \`${verify.cmd}\`, so you cannot mark it met yourself — ` +
        "your saying the command passed is the self-report the check replaces. Run it and show the " +
        "result; a person closes the goal on that evidence, because nothing runs the check for you " +
        "today."
      );
    // THE `landed` ARM NO LONGER NAMES A PERSON, because code computes it now (sparkle-vfkqz). The
    // old copy — "a person closes the goal … because no code computes `landed` today" — was true
    // when written and is now false, and it is the exact sentence that taught a finished agent it
    // had no self-service path and left it escalating. A refusal that misdescribes the mechanism is
    // worse than no refusal: the agent stops looking for the door that exists. So each arm below
    // names the ACTION that will close the goal by itself.
    case "landed":
      // ── ONLY A REAL ANCESTRY CHECK MAY BE QUOTED AS ONE (sparkle-2668a7) ───────────────────────
      // This arm is FIRST because it is the only one entitled to speak for git. `landed: false` is
      // handed to this function by two unrelated computations — a live `git merge-base
      // --is-ancestor` verdict, and a window-local positive test that failed having asked git
      // nothing — and until `landedSource` existed the copy could not tell them apart, so every
      // watermark miss was reported as git's no. Measured live: a branch whose HEAD WAS an ancestor
      // of origin/main, carrying a MERGED PR, read "git says it is not on origin/main yet" and was
      // told to open a PR for work already on main.
      //
      // `=== "git-probe"` and nothing looser. `undefined` is "nobody recorded where this came from",
      // which is not evidence that git was asked, so it falls through to the honest copy below.
      //
      // ⚠️ `unlandedWork !== false` IS PART OF THE CONDITION, not decoration (roborev 72103). This
      // arm tells the agent to open a PR, and that is right only for a branch actually HOLDING
      // work. `{ landed: false, unlandedWork: false }` is the SQUASH/REBASE-MERGE shape — the work
      // is in main, the tip is not an ancestor of it — and it is reachable from a real git verdict
      // now that the probe runs on a `false` reading. Without this clause the git-probe arm shadows
      // the carefully hedged arm below and hands "open a PR and merge it" to a branch whose work has
      // ALREADY merged: the duplicate PR `scripts/pr-for-branch.sh` exists to prevent, reached by
      // obeying the refusal.
      if (
        evidence?.landed === false &&
        evidence?.landedSource === "git-probe" &&
        evidence?.unlandedWork !== false
      ) {
        return (
          "This goal is verified by the work being on origin/main, and git says it is not on " +
          "origin/main yet — so there is nothing to mark met. Land it (open a PR and merge it), and " +
          "you can mark this goal met yourself once the branch is reachable from origin/main."
        );
      }
      // ── A BRANCH HOLDING NOTHING BACK MUST NOT BE TOLD WHAT GIT SAID ───────────────────────────
      // `landed: false` is a POSITIVE test failing, not git's no. With `unlandedWork: false` the
      // honest reading is "nothing has been observed reaching origin/main, and nothing is
      // outstanding" — which is simultaneously what a landed-then-parked agent looks like (its merge
      // watermark belongs to the branch its worktree left), what an agent that committed nothing
      // looks like, and what an agent holding only uncommitted edits looks like. Window-local state
      // cannot tell those apart, so this arm must not claim ANY of them: the previous copy asserted
      // the work was unlanded and offered exactly one action, opening a PR — which for a
      // landed-then-parked agent duplicates merged work (the rival PR `scripts/pr-for-branch.sh`
      // exists to prevent, reached by obeying the refusal). Measured: an agent whose fix WAS an
      // ancestor of origin/main was told git said otherwise, across repeated auto-continues.
      //
      // So it states what is known, names BOTH branches conditionally, and hands the one check that
      // settles it to the party that can run it. EACH branch also names the action that CLOSES the
      // goal — self-close for the not-yet-committed reader, the concierge for the landed one — per
      // this case's own contract; the first cut dropped the self-close half, which is the sparkle-vfkqz
      // failure (an agent left escalating because the copy named no door it could open itself). `=== false` on both bits, never truthiness:
      // `unlandedWork: undefined` means nobody looked, and must keep the original copy rather than
      // manufacture advice out of a missing reading.
      //
      // IT IS PROVENANCE-AWARE (roborev 72103). Both populations reach here now that a real git
      // verdict can accompany `unlandedWork: false`, and they need different OPENINGS: quoting git
      // for a reading git never produced is the lie this whole change removes, and denying git said
      // anything when it did is that same lie mirrored. What must NOT differ is the ADVICE — in both
      // the tip is not an ancestor and nothing is outstanding, so opening a second PR is the wrong
      // move until the agent has checked whether the work is already in main by content.
      // ⚠️ GIT SAID ANCESTOR AND WE REFUSED IT — SAY SO, AND DO NOT HAND OVER THE ARGUMENT
      // (roborev 72328). This is the branch whose HEAD *is* reachable from origin/main purely
      // because it has committed nothing. Dropping that verdict back to "window-local" made the
      // copy deny git had spoken, then send the agent to run the very ancestry check that WILL say
      // ancestor, then invite it to take that to the concierge — who is exempt from this gate. A
      // blocked self-latch became a human-mediated false close plus a false escalation. So this
      // arm states git's actual finding, explains why ancestry is not evidence here, and asks for
      // the one thing that would be: authored commits.
      //
      // ⚠️ AND IT NAMES A DOOR (roborev 72416). This arm's population is EXACTLY the agent that can
      // never self-close: `canSelfMarkMet` requires `landed === true`, and the reading is pinned
      // `false` here because `authoredWorkSeen` is false — which is precisely what a squash-merged
      // PR followed by a worktree parked back on origin/main produces, and it will stay false. So
      // the concierge is the ONLY door. Asking for better evidence and then not saying where to
      // take it leaves a genuinely-landed agent gathering a merged PR, having nowhere to go,
      // re-marking met, being refused identically, and auto-continuing to escalation. That is the
      // sparkle-vfkqz shape the `unlandedWork === false` arm's own comment names — "an agent left
      // escalating because the copy named no door it could open itself" — and the first cut of
      // THIS arm reintroduced it. The ancestry prohibition stays; only the destination is added.
      if (evidence?.landed === false && evidence?.landedSource === "git-probe-unproven") {
        return (
          "This goal is verified by the work being on origin/main. A git ancestry check DOES say " +
          "this worktree's HEAD is reachable from origin/main — but that is not evidence of a " +
          "landing, because the branch that satisfies ancestry most easily is one that has done " +
          "NOTHING: cut from origin/main with no commits of its own, its HEAD simply IS the " +
          "ancestor. Nothing here can see any commits you authored on this branch, so this goal " +
          "cannot close on that `true`. Do NOT take the ancestry result to the concierge as proof " +
          "— it would close this goal over work that may not exist. If you HAVE landed work, show " +
          "what it was: `gh pr list --state merged --head <this branch>`, or the shas you " +
          "authored, and ask the concierge to close this goal on THAT evidence — never open a " +
          "second PR for work already merged. If you have not, the work still has to be committed " +
          "and landed."
        );
      }
      // ⚠️ THE SQUASH POPULATION GETS ITS OWN REMEDY, BECAUSE ANCESTRY CANNOT SETTLE IT
      // (roborev 72328). A remedy is an instruction the agent will follow, so it must be able to
      // SUCCEED under the conditions that produced the refusal. Here the probe has just run
      // `merge-base --is-ancestor` against a fresh fetch and answered NOT an ancestor — and for a
      // squash or rebase landing NO commit of the agent's will ever be an ancestor, so telling it
      // to re-run that check offers a test whose answer is already known and whose "if it IS an
      // ancestor" branch is unreachable. That left "commit it and land it" as the only live
      // instruction, which opens the duplicate PR this arm exists to prevent. Lineage cannot
      // answer a squash; CONTENT can.
      if (
        evidence?.landed === false &&
        evidence?.unlandedWork === false &&
        evidence?.landedSource === "git-probe"
      ) {
        return (
          "This goal is verified by the work being on origin/main. A git ancestry check says this " +
          "branch's tip is NOT reachable from origin/main — but the branch is holding no unlanded " +
          "commits either, and a SQUASH or REBASE merge produces exactly that pair: the work is in " +
          "main, the tip is not an ancestor of it. Do NOT re-run the ancestry check; it is the " +
          "check that just answered, and under a squash landing no commit of yours can ever be an " +
          "ancestor. Settle it by CONTENT instead: `gh pr list --state merged --head <this " +
          "branch>` for a merged PR, or `git diff origin/main -- <the files you changed>` for an " +
          "empty diff. If either shows your work is already on origin/main, say so and ask the " +
          "concierge to close this goal — never open a second PR for work already merged. If " +
          "neither does, then nothing on this branch has landed and there is nothing to mark met."
        );
      }
      if (evidence?.landed === false && evidence?.unlandedWork === false) {
        return (
          "This goal is verified by the work being on origin/main. Nothing has been observed " +
          "reaching origin/main for this branch, and it is holding no unlanded commits either — so " +
          "this is NOT git saying your work is unlanded, and which of the two it is depends on facts " +
          "only you can check. " +
          "If you have not committed the work yet, commit it and land it, then " +
          "mark this met again; no human is needed once the branch is reachable from origin/main. " +
          "If you believe it is ALREADY on origin/main — it merged and this worktree was then " +
          "parked or moved onto another branch, which reads exactly like this — run `git merge-base " +
          "--is-ancestor <sha> origin/main`; if it IS an ancestor, say so and ask the concierge to " +
          "close this goal rather than opening a second PR for work already merged."
        );
      }
      // ── THE SAME LIE, ONE POPULATION OVER: A WATERMARK MISS IS NOT GIT'S NO (sparkle-2668a7) ───
      // Reached when the reading is `false` and NOTHING asked git — either the caller recorded
      // `"window-local"`, or it recorded no provenance at all. The branch may well be holding
      // commits (`unlandedWork: true`), and "land it" is then the right action; what this copy may
      // NOT do is attribute the negative to git, because the identical `false` is what a
      // landed-then-parked worktree reads. So it names the mechanism that actually produced the
      // refusal, hands over the one command that settles it, and — crucially — says what to do when
      // that command says ANCESTOR, which is the branch the old sentence had no room for and which
      // ends in a duplicate PR for merged work.
      if (evidence?.landed === false) {
        return (
          "This goal is verified by the work being on origin/main. Nothing has been observed " +
          "reaching origin/main for this branch, and no git ancestry check was run — that is a " +
          "merge watermark this window has not latched, NOT git saying your work is unlanded. " +
          "Settle it yourself with `git merge-base --is-ancestor <sha> origin/main`. If it is not " +
          "an ancestor, land it (open a PR and merge it) and mark this goal met again — no human is " +
          "needed once the branch is reachable from origin/main. If it IS an ancestor, say so and " +
          "ask the concierge to close this goal rather than opening a second PR for work that has " +
          "already merged."
        );
      }
      return (
        "This goal is verified by the work being on origin/main, and your branch's git state has " +
        "not been read yet — so the proof is unavailable, not negative. Once a branch poll lands " +
        "(or once you have merged your PR), mark it met again; no human is needed if the work is " +
        "actually on origin/main."
      );
    // THE `human` ARM NAMES THE EXIT (roborev 57816). Far more traffic reaches it now that an
    // inherited `human` binds across every later goal, and "leave it for the human to close" left
    // both parties stuck: the agent could not tell a check a person CHOSE from one it inherited by
    // default, and the human who got the red row was not told which door closes it. That is the
    // sparkle-vfkqz shape — refuse, three auto-continues, escalate with nothing to do — so this
    // string owes the same treatment the `landed` arm already got: never misdescribe the mechanism,
    // and always name the action that ends the state.
    case "human": {
      // REPORTING COMPLETION IS THE PRIMARY PATH IN BOTH CASES (roborev 57819). The first version of
      // this arm asked the agent "if this check was not one you chose…" — a question the finding
      // that prompted it had just established the agent CANNOT answer, and which is true for every
      // worker under a concierge-set sign-off. It then called the take-back "the only way out",
      // contradicting "leave it for the human to close" one clause earlier and making the more
      // actionable of the two a request to DROP a check a person deliberately imposed. A remedy
      // string is an instruction the agent will follow, so it must not route a genuine sign-off
      // toward its own removal.
      //
      // The caller holds the provenance the copy was asking the agent to guess, so it is passed in.
      // The take-back is withheld ONLY from a check chosen for THIS goal — the one case where a
      // caller demonstrably bound itself to this work. Everywhere else it is named, always as the
      // secondary exit behind reporting completion.
      const base =
        "This goal is verified by a person, so you cannot mark it met. Say what you finished and " +
        "why you believe it satisfies the goal, and leave it for the human to close — that report " +
        "is what closes it.";
      // THREE POPULATIONS, THREE SENTENCES (roborev 57827, resolved by 57832). A single boolean got
      // one of them wrong whichever way it folded — keyed on "ever chosen" it withheld the exit from
      // inherited checks; keyed on "chosen here" it withheld nothing but over-claimed a restatement.
      //
      // WHERE THAT LANDED: arms 2 and 3 BOTH name the take-back, because restatement-vs-unrelated is
      // not recorded anywhere (`chargeGoalDebt` compares only the inferred kind) and withholding an
      // exit on that guess is what stranded the sparkle-vfkqz population. What still differs between
      // them is only what each may honestly SAY about who chose the check.
      if (evidence?.chosenHere === true) return base;
      if (evidence?.stated === true) {
        // CARRIED FROM A CHECK A CALLER CHOSE — for work that may or may not be this work.
        //
        // ⚠️ THIS ARM MAY NOT CLAIM "you restated it" (roborev 57832). Nothing records that:
        // `chargeGoalDebt` compares only the inferred KIND, and an owed `human` inherits on any text
        // that is not landing-shaped — a paraphrase and a completely unrelated goal alike. The first
        // version asserted the restatement anyway AND withheld the take-back on the strength of it,
        // which swallowed the sparkle-vfkqz population whole: an agent given genuinely new work
        // under an inherited check was told its goal "restates" work it had never seen, and offered
        // no door. A refusal that misdescribes the mechanism is worse than none.
        //
        // So it says only what is RECORDED — some CALLER chose this check for an earlier goal, not
        // this one — and still names the exit. The distinction from the manufactured arm below is
        // real but narrow: there, nobody chose the check at all.
        //
        // "a caller", NEVER "a person" (roborev 57840). Only `verifyStated` is recorded, and
        // `set_agent_goal` is reachable by the agent itself and by an orchestrator over its own
        // subtree — self-binding is an advertised path ("you may bind yourself harder"), so a
        // stated `human` is often the agent's OWN choice. Asserting a person signed off is the same
        // over-claim as "this goal restates", one clause down, and it is the sentence most likely to
        // stop an agent asking for the take-back the next sentence offers.
        return (
          base +
          " This check was carried over from an earlier goal a caller chose it for — not this one — " +
          "so it stands unless it does not fit what you are actually doing. If it does not, say so " +
          "in your report and the concierge can drop it with `verify: null`. That take-back is " +
          "theirs to make, not yours."
        );
      }
      return (
        base +
        " This check may not have been chosen for this goal — a goal that inherits an obligation " +
        "gets `human` by default — so if it does not fit the work, say so and the concierge can " +
        "drop it with `verify: null`. That take-back is theirs to make, not yours."
      );
    }
  }
}

/**
 * DOES THE COPY `selfMarkRefusal` JUST EMITTED NAME A DOOR THE AGENT CAN OPEN ALONE?
 *
 * ⚠️ THIS IS A PROPERTY OF THE COPY, NOT OF THE ARM, and that distinction is the whole reason it
 * exists (roborev job 80862, a HIGH). The caller's first cut keyed the same question on the
 * diagnostic ARM NAME — and `ancestry:git-probe-negative` is set for EVERY `landed === false`, a
 * population `selfMarkRefusal` then splits in two. One half is told "land it … and mark this goal
 * met again". The other is the SQUASH/REBASE half, whose copy says the opposite: do NOT re-run
 * ancestry, settle it by CONTENT, ask the concierge. Under a squash landing no commit of the
 * agent's can ever become an ancestor, so `landed` stays `false` permanently and there is no door
 * at all. Telling that agent to "mark it met again" is the sparkle-gj8s4n shape exactly — refused
 * identically, auto-continued to escalation — so an arm-keyed answer is wrong for a population the
 * arm cannot distinguish.
 *
 * ⚠️ ITS CONDITIONS MIRROR `selfMarkRefusal`'S LADDER AND MUST STAY IN STEP. Two functions reading
 * one set of facts is exactly the drift AGENTS.md warns about, so this is NOT left to care: the
 * suite renders the real refusal for every population and asserts the two agree — a copy that
 * offers a self-close must answer `true` here and one that does not must answer `false`. Add an arm
 * to the ladder without adding it here and that parity test goes red, which is the point.
 *
 * ⚠️ IT DECIDES NOTHING ABOUT ACCEPTANCE. Nothing here is read by `canSelfMarkMet`; the set of
 * accepted calls is identical with and without it. It chooses which sentence a REFUSAL ends with.
 */
export function selfMarkRefusalOffersSelfClose(
  verify: GoalVerify,
  evidence?: GoalVerifyEvidence,
): boolean {
  // `command` and `human` are never claimant-answerable, so neither names a door the agent opens.
  if (verify.kind !== "landed") return false;
  // Git said ANCESTOR and we refused it: the copy routes to the concierge and explicitly forbids
  // taking the ancestry result there as proof. No self-service step exists.
  if (evidence?.landed === false && evidence?.landedSource === "git-probe-unproven") return false;
  // THE SQUASH/REBASE POPULATION. Ancestry has just answered NO and can never answer otherwise for
  // this landing shape, so its copy sends the agent to settle by CONTENT and then to the concierge.
  if (
    evidence?.landed === false &&
    evidence?.unlandedWork === false &&
    evidence?.landedSource === "git-probe"
  ) {
    return false;
  }
  // Everything else the `landed` arm emits ends by naming a step the agent takes and then marks
  // met again itself.
  return true;
}


/** One-line human-readable rendering, for a row, a prompt, or a scoreboard. */
export function describeGoalVerify(verify: GoalVerify | undefined): string {
  if (!verify) return "no check stated";
  switch (verify.kind) {
    case "command":
      return `\`${verify.cmd}\` exits 0`;
    case "landed":
      return "the work is on origin/main";
    case "human":
      return "a person decides";
  }
}
