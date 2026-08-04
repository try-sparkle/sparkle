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
const OMNISCIENT_EVIDENCE: GoalVerifyEvidence = { landed: true };

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
   *   1. chosen for this goal — a real sign-off. Never invite its removal.
   *   2. carried across a RESTATEMENT of the same work — a real sign-off too, just re-worded.
   *      Agents restate constantly (`continuePrompt` replays goal text), so this is the LARGEST
   *      bucket, and treating it as un-chosen offered to drop a founder's approval one paraphrase in.
   *   3. manufactured, or carried onto genuinely unrelated work — nobody chose it for what the agent
   *      is doing. This is the sparkle-vfkqz population the take-back exists for.
   * `stated` separates 3 from 1+2; `chosenHere` separates 1 from 2. Both are needed.
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
      if (evidence?.landed === false) {
        return (
          "This goal is verified by the work being on origin/main, and git says it is not on " +
          "origin/main yet — so there is nothing to mark met. Land it (open a PR and merge it), and " +
          "you can mark this goal met yourself once the branch is reachable from origin/main."
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
      // The take-back is mentioned only when the check is NOT confirmed caller-chosen, and even then
      // as the secondary exit.
      const base =
        "This goal is verified by a person, so you cannot mark it met. Say what you finished and " +
        "why you believe it satisfies the goal, and leave it for the human to close — that report " +
        "is what closes it.";
      // THREE POPULATIONS, THREE SENTENCES (roborev 57827). A single boolean got one of them wrong
      // whichever way it folded: keyed on "ever chosen" it withheld the exit from inherited checks,
      // and keyed on "chosen here" it offered to drop a founder's sign-off one PARAPHRASE later —
      // and restating a goal is something agents do constantly.
      if (evidence?.chosenHere === true) return base;
      if (evidence?.stated === true) {
        // Carried from a check a caller really did choose, across a restatement. Still a genuine
        // sign-off, so no take-back is offered — only a way to flag a mismatch.
        return (
          base +
          " This check was chosen for earlier work that this goal restates, so it still stands. If " +
          "it no longer fits what you are actually doing, say so in your report rather than " +
          "assuming it carries over."
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
