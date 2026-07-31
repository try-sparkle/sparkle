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
// NO STATED KIND MAY BE SELF-MARKED. See `canSelfMarkMet` — `set_agent_goal_met` latches `metAt`, so
// an agent allowed to call it has self-reported "done" regardless of which kind it declared.
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
// AND NO CALLER DOES EITHER ONE YET. `verify` is read only by `canSelfMarkMet`/`selfMarkRefusal`,
// carried by `chargeGoalDebt`, and rendered by `describeGoalVerify` — so today a stated check means
// a PERSON closes the goal, whichever kind it names. That is a real gap, not an implementation
// detail: every user-facing string here must say so, because an agent told a proof is coming waits
// for one that never arrives. Whoever adds the executor should delete those caveats in the same
// change — they are in `selfMarkRefusal` below, the `verify` field describe in mcp-control's
// `server.ts`, `.claude/commands/goal.md`, and the sparkle-control SKILL.md.
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
 * May the AGENT ITSELF declare this goal met?
 *
 * **`false` for EVERY stated verify kind.** An earlier version returned `true` for `command` and
 * `landed`, reasoning that those claims were "admissible pending a check". That distinction does not
 * survive contact with the thing being prevented: `set_agent_goal_met` LATCHES `metAt`, and `metAt`
 * is the only signal that makes an idle agent count as done. So an agent permitted to call it has
 * self-reported "done" whatever the kind says — "I ran the command and it passed" is exactly the
 * self-report the whole mechanism exists to replace, and nothing downstream re-checks it.
 *
 * What each kind means once this returns `false`:
 *   command — the CHECK decides. Someone must run it and mark met on the result.
 *   landed  — GIT decides. The proof is computed, never asserted.
 *   human   — a PERSON decides.
 *
 * `true` only when NO verify was stated. Every goal that predates this module is in that case, and
 * refusing them would break `set_agent_goal_met` for the whole installed base to enforce a rule they
 * never opted into. That is the compatibility seam, not a loophole: a goal with no stated check was
 * never claiming to be verifiable.
 *
 * This function does NOT decide who else may mark it — the human, and the concierge acting as the
 * human-driven surface, are outside its scope. It answers one question: may the CLAIMANT latch it.
 */
export function canSelfMarkMet(verify: GoalVerify | undefined): boolean {
  return !verify;
}

/** The refusal to hand an agent that tried to latch its own verified goal. Total over every kind. */
export function selfMarkRefusal(verify: GoalVerify): string {
  switch (verify.kind) {
    // BOTH ARMS NAME A PERSON AS THE CLOSER, because that is who closes it (roborev 56154). They
    // used to promise an automated closer — "let the check … close the goal", "the proof closes the
    // goal" — and no executor exists: nothing runs `cmd`, nothing computes `landed`. This is the
    // copy an agent reads at the moment it is BLOCKED, so a promised proof that never arrives leaves
    // it waiting, un-closable (`verify: null` is concierge-only) and auto-resumed until a person
    // notices. Telling it the truth before it acts and a falsehood once it is stuck is the worst of
    // both.
    case "command":
      return (
        `This goal is verified by running \`${verify.cmd}\`, so you cannot mark it met yourself — ` +
        "your saying the command passed is the self-report the check replaces. Run it and show the " +
        "result; a person closes the goal on that evidence, because nothing runs the check for you " +
        "today."
      );
    case "landed":
      return (
        "This goal is verified by the work being on origin/main, so you cannot assert it. Get it " +
        "landed and say so; a person closes the goal on that evidence, because no code computes " +
        "`landed` today."
      );
    case "human":
      return (
        "This goal is verified by a person, so you cannot mark it met. Say what you finished and why " +
        "you believe it satisfies the goal, and leave it for the human to close."
      );
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
