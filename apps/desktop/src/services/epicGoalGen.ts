// epicGoalGen — the ASYNC generator that fills an epic's goal (bead `sparkle-wab4lm`).
//
// The store half (`engine/epicGoal` + `projectStore`) can hold a goal; this is the one thing that
// WRITES one without a person typing it. It is a PAID AI call, so it inherits every safety rule
// `services/epicDecompose` records — read that file's header first, it is the worked example — and
// adds two constraints the founder stated directly:
//
//   1. LATENCY IS OFF THE CREATE PATH. "Do not put a call of that latency synchronously on the
//      epic-creation path; generate async and fill the field when it lands." So the only production
//      caller (`conciergeTools/plans.createPlan`) fires this FIRE-AND-FORGET, and nothing here may
//      make a create slower or make it fail. Every exit is an outcome value, never a throw.
//   2. ON FAILURE, NO GOAL — NOT A BAD ONE. "On failure or timeout, NO goal rather than a bad one.
//      An empty field is honest; a hallucinated objective is worse than nothing." Concretely:
//      `deps.setEpicGoal` is called on EXACTLY ONE line in this file, at the end of the success
//      path. Every other exit routes through {@link fail}, which writes `noteEpicGoalFailure` — a
//      record with NO text. A timeout is a failure, not a wait: the call is raced against
//      {@link EPIC_GOAL_GEN_TIMEOUT_MS} and the loser is discarded.
//
// ── WHY THERE IS NO WATCHER ────────────────────────────────────────────────────────────────────
// The obvious next step — sweep the board and generate for every goal-less epic — is deliberately
// NOT here. The store holds ~39 epics, so a board-wide watcher is a first-run burst of ~39 paid
// calls the moment the feature ships. That is the exact money/safety landmine `epicDecompose`'s
// header records as bead `sparkle-ynn8` ("label absent" ≠ "please spend"). Generation fires only
// from a CREATION site, where a human just asked for this one epic, or from an explicit `force`.
//
// ── THE INJECTION SEAM ─────────────────────────────────────────────────────────────────────────
// {@link epicGoalGenDeps} is ONE exported object holding the real backends, and the production call
// site passes that object. It is deliberately NOT a `deps = realThing` default written inline at
// the call site: when every test injects its own object, the line that supplies the real value is
// covered by nothing — delete it and the suite stays green while the feature is inert (AGENTS.md,
// "A defaulted seam every test injects"). Because the seam is one shared object, a test can drive
// the PRODUCTION path — the real latch, the real store writes — while replacing only the paid call.
// Both halves are injectable on purpose: controlling only the model would leave "the goal was
// written" and "the goal was written to the real store" indistinguishable.
import {
  GOAL_MAX_LEN,
  GOAL_MIN_LEN,
  parseGoalVerify,
  type GoalVerify,
} from "@sparkle/core";

import {
  EPIC_GOAL_VERIFY_KINDS,
  epicGoalTextRejection,
  epicVerifyOf,
  isEpicVerifyKind,
  type EpicGoalSource,
} from "../engine/epicGoal";
import { childrenOf, listBeads, type Bead } from "./beads";
import { structuredJson, type Metering } from "./anthropic";
import { aiFeatureMode, useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { log } from "../logger";

/**
 * How long the model gets. A TIMEOUT IS A FAILURE, NOT A WAIT — the epic's goal field stays empty
 * with a recorded reason rather than filling minutes later under a reader who has moved on.
 *
 * 25s sits under the concierge bridge's own 50s kill and well above a normal one-sentence turn, so
 * expiring here means something is genuinely wrong rather than merely slow.
 */
export const EPIC_GOAL_GEN_TIMEOUT_MS = 25_000;

/** One sentence plus a small verify object needs nothing more, and a tight cap bounds the spend. */
export const EPIC_GOAL_MAX_TOKENS = 512;

/** Longest slice of an epic's description handed to the model (a PRD-sized body is not needed to
 *  name an end state, and the whole of one would dominate the prompt). */
const DESCRIPTION_BUDGET = 1200;
/** How many child titles are shown, and how long each may be. */
const MAX_CHILDREN = 25;
const CHILD_TITLE_BUDGET = 120;

/**
 * What happened. Every one of these is a NORMAL return — this function never throws, because its
 * only production caller is fire-and-forget on a path that must not be able to fail.
 *
 *   `generated` — a usable goal was validated and written.
 *   `failed`    — something went wrong; a failure RECORD was written, and NO goal text.
 *   `latched`   — the store refused (a human has had an opinion, or the field is already filled).
 *                 Nothing was spent.
 *   `ai-off`    — the master AI gate is off. Nothing was spent.
 *   `in-flight` — an identical request is already running. Nothing was spent.
 */
export type EpicGoalGenOutcome = "generated" | "failed" | "latched" | "ai-off" | "in-flight";

export interface EpicGoalGenArgs {
  projectId: string;
  projectPath: string;
  epicId: string;
  /** The explicit human ask ("regenerate the goal"). The ONLY thing that beats the human latch. */
  force?: boolean;
}

/** Every backend this generator touches, in one object. See the header for why it is one object. */
export interface EpicGoalGenDeps {
  /** The latch, read from the store (`engine/epicGoal.mayAutoGenerate` under it). */
  mayGenerate: (projectId: string, epicId: string, force?: boolean) => boolean;
  /** Master AI gate — when off, nothing here may fire a paid call. */
  aiEnabled: () => boolean;
  /** The bead snapshot this epic and its children are read out of. */
  readBeads: (projectPath: string) => Promise<Bead[]>;
  /** THE PAID CALL. */
  structuredJson: <T>(
    system: string,
    user: string,
    maxTokens?: number,
    metering?: Metering,
  ) => Promise<T>;
  /** The success write. Called on exactly one line in this file. */
  setEpicGoal: (
    projectId: string,
    epicId: string,
    text: string,
    source: EpicGoalSource,
    verify?: GoalVerify,
  ) => void;
  /** The failure write — a record with NO goal text. */
  noteFailure: (projectId: string, epicId: string, reason: string) => void;
  /** Failure reporting seam (log.error in prod). */
  logError?: (message: string, error: unknown) => void;
}

/**
 * THE REAL BACKENDS. The production call site passes this object; a test overrides one member of a
 * copy of it and drives everything else for real.
 *
 * The store members re-read `getState()` on every call rather than capturing an action at module
 * load: zustand hands out a fresh action set on each state transition, and a captured one would
 * write into a store snapshot that has since been replaced.
 */
export const epicGoalGenDeps: EpicGoalGenDeps = {
  mayGenerate: (projectId, epicId, force) =>
    useProjectStore.getState().mayGenerateEpicGoal(projectId, epicId, force),
  aiEnabled: () => aiFeatureMode(useSettingsStore.getState()) !== "off",
  readBeads: listBeads,
  structuredJson,
  setEpicGoal: (projectId, epicId, text, source, verify) =>
    useProjectStore.getState().setEpicGoal(projectId, epicId, text, source, verify),
  noteFailure: (projectId, epicId, reason) =>
    useProjectStore.getState().noteEpicGoalFailure(projectId, epicId, reason),
  logError: (message, error) => log.error("epicGoalGen", message, error),
};

// ── In-flight guard ────────────────────────────────────────────────────────────────────────────
// Module scope, like epicDecompose's `sweepInFlight`. A create can be retried by a human within the
// 25s window, and two overlapping calls would spend twice to write the same field.
let inFlight = new Set<string>();

/** Test seam: the module-scope guard above survives across tests otherwise. */
export function __resetEpicGoalGenStateForTests(): void {
  inFlight = new Set();
}

/** The dedupe key. `\0` cannot appear in either id, so no pair of ids can collide on it. */
export function epicGoalGenKey(projectId: string, epicId: string): string {
  return `${projectId}\0${epicId}`;
}

// ── Prompts ────────────────────────────────────────────────────────────────────────────────────

/**
 * What we ask for: ONE sentence naming the OBSERVABLE END STATE.
 *
 * The two failure shapes worth naming explicitly are a restatement of the title (which tells a
 * reader nothing they did not already have) and a list of the tasks (which is what the child beads
 * already are). The length bounds are `@sparkle/core`'s shared worker-goal bounds — the same rule
 * `epicGoalTextRejection` enforces on the way back in — so the model is told the gate it must pass
 * rather than being refused by a number it never saw.
 */
export function epicGoalSystemPrompt(): string {
  return [
    "You write the GOAL for one epic in a software project's work graph.",
    "",
    "Answer with ONE sentence naming the OBSERVABLE END STATE: what will be TRUE when this epic is",
    "achieved, and how anyone could check it. Do NOT restate the title. Do NOT list the tasks — the",
    "child items below already are the tasks. Do NOT describe work in progress; describe the world",
    "after the work is done.",
    "",
    `The sentence must be between ${GOAL_MIN_LEN} and ${GOAL_MAX_LEN} characters.`,
    "",
    "Also say how the goal is CHECKED:",
    '  {"kind":"command","cmd":"<a command that exits 0 exactly when the goal is met>"} — ONLY when',
    "  a real, runnable command proves it.",
    '  {"kind":"human"} — otherwise. When in doubt, use "human".',
    "",
    'Reply shape: {"goal":"<one sentence>","verify":{"kind":"human"}}',
  ].join("\n");
}

/** The epic, its body, and what its children are called — the whole of what the model sees. */
export function epicGoalUserPrompt(epic: Bead, children: readonly Bead[]): string {
  const body = epic.description.trim().slice(0, DESCRIPTION_BUDGET);
  const titles = children
    .slice(0, MAX_CHILDREN)
    .map((c) => `- ${c.title.trim().slice(0, CHILD_TITLE_BUDGET)}`);
  return [
    `EPIC: ${epic.title.trim()}`,
    ...(body ? ["", "DESCRIPTION:", body] : []),
    ...(titles.length ? ["", "CHILD ITEMS:", ...titles] : []),
  ].join("\n");
}

// ── The generator ──────────────────────────────────────────────────────────────────────────────

/** The model's reply, read as UNTRUSTED: every field is validated before anything is written. */
interface EpicGoalReply {
  goal?: unknown;
  verify?: unknown;
}

/** Bound a promise. The timer is always cleared, so a call that wins the race leaves nothing
 *  pending — a stray 25s timer would keep a test process (and a real one) awake for nothing.
 *
 *  The race is deliberately its OWN statement on the return line rather than an expression buried
 *  inside a `.finally` callback: that is the decision this function exists to make, and a decision
 *  a mutation check cannot target is a decision no test can be proven to guard. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (handle !== undefined) clearTimeout(handle);
  };
  const expiry = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  // THE RACE. A timeout is a real competitor, not an advisory: when it wins, the caller gets a
  // rejection and the model's answer is discarded whenever it eventually arrives.
  return Promise.race([p, expiry]).finally(clear);
}

/** ONE SHORT SENTENCE. The reason is shown on a card, so a stack trace or a 4KB model reply is
 *  worse than useless there. */
function oneSentence(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = (raw.split("\n")[0] ?? "").trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : first || "unknown error";
}

/**
 * THE ONLY FAILURE EXIT. Writes a record with NO text — the founder's constraint, in one place so
 * there is nowhere else for a goal string to leak onto a failure path.
 */
function fail(
  deps: EpicGoalGenDeps,
  projectId: string,
  epicId: string,
  reason: string,
): EpicGoalGenOutcome {
  deps.noteFailure(projectId, epicId, reason);
  return "failed";
}

/**
 * Generate (or regenerate) the goal for one epic. NEVER THROWS and never awaits anything the
 * caller is blocked on — see the header.
 *
 * Gates, in order, each of which spends NOTHING: the human latch, the master AI gate, and the
 * in-flight dedupe. Only past all three does a paid call happen.
 */
export async function requestEpicGoal(
  deps: EpicGoalGenDeps,
  args: EpicGoalGenArgs,
): Promise<EpicGoalGenOutcome> {
  const { projectId, epicId, force = false } = args;
  // THE LATCH, first and cheapest. A human has had an opinion about this goal (or it is already
  // filled), so the machine does not get to spend money rewording it under them.
  if (!deps.mayGenerate(projectId, epicId, force)) return "latched";
  // THE SPEND GATE. Everything below this line can cost money.
  if (!deps.aiEnabled()) return "ai-off";
  const key = epicGoalGenKey(projectId, epicId);
  // DEDUPE. A second concurrent request for the same epic spends nothing and writes nothing.
  if (inFlight.has(key)) return "in-flight";
  inFlight.add(key);
  try {
    return await generateOnce(deps, args);
  } finally {
    // In a `finally` so a throw from anywhere below cannot wedge this epic for the session.
    inFlight.delete(key);
  }
}

/** The part past the gates. Split out so the gate sequence above reads as the safety contract it
 *  is, rather than as the first third of a long function. */
async function generateOnce(
  deps: EpicGoalGenDeps,
  args: EpicGoalGenArgs,
): Promise<EpicGoalGenOutcome> {
  const { projectId, projectPath, epicId } = args;
  // The bead + its children, from the ordinary list read every other surface uses. No new bd
  // command: this is a display field, and minting a read path for it would be a second way to ask
  // a question `services/beads` already answers.
  let beads: Bead[];
  try {
    beads = await deps.readBeads(projectPath);
  } catch (e) {
    deps.logError?.(`could not read beads for epic ${epicId}`, e);
    return fail(deps, projectId, epicId, `could not read the work graph — ${oneSentence(e)}`);
  }
  const epic = beads.find((b) => b.id === epicId);
  if (!epic) {
    // A RECORDED absence, deliberately. `mayAutoGenerate` then declines to retry on its own, so a
    // create whose row had not landed yet is retried by a human gesture (`force`) rather than by a
    // timer that would spend on every poll.
    return fail(deps, projectId, epicId, `epic ${epicId} is not in the work graph`);
  }
  let reply: EpicGoalReply;
  try {
    reply = await withTimeout(
      deps.structuredJson<EpicGoalReply>(
        epicGoalSystemPrompt(),
        epicGoalUserPrompt(epic, childrenOf(beads, epicId)),
        EPIC_GOAL_MAX_TOKENS,
        // `background: true` — the app fired this itself off a create; nobody is watching a
        // spinner for it, so it belongs in the background concurrency tier rather than competing
        // with calls a human is blocked on.
        { purpose: "epic-goal", project: projectPath, background: true },
      ),
      EPIC_GOAL_GEN_TIMEOUT_MS,
      `generation timed out after ${Math.round(EPIC_GOAL_GEN_TIMEOUT_MS / 1000)}s`,
    );
  } catch (e) {
    deps.logError?.(`epic-goal generation failed for ${epicId}`, e);
    return fail(deps, projectId, epicId, oneSentence(e));
  }
  // A non-string `goal` (absent, null, a number, an object) becomes "" and is refused as `empty` by
  // the same rule that refuses a one-word goal — one branch, not two.
  const goalText = typeof reply?.goal === "string" ? reply.goal : "";
  const rejection = epicGoalTextRejection(goalText);
  if (rejection !== null) return fail(deps, projectId, epicId, `unusable goal text — ${rejection}`);
  const verify = readVerify(reply?.verify);
  if (typeof verify === "string") return fail(deps, projectId, epicId, verify);
  // THE ONE WRITE. Everything above either reached here with validated text or returned through
  // `fail`, which writes no text at all.
  deps.setEpicGoal(projectId, epicId, goalText, "auto", verify);
  return "generated";
}

/**
 * The model's `verify`, or a REJECTION REASON (a string).
 *
 * `landed` is refused rather than narrowed here. `epicVerifyOf` would fold it to `human`, which is
 * right for a value arriving from a human or from inference — but this value came from a model that
 * was told the two legal kinds, so a third one means the reply is not the shape we asked for, and
 * the founder's rule for a reply we cannot trust is NO goal rather than a salvaged one. The
 * `epicVerifyOf` call stays on the accepted path as defence in depth: it is the one narrowing
 * function, and routing through it means a future kind added to `GoalVerify` cannot reach an epic
 * without passing it.
 */
function readVerify(raw: unknown): GoalVerify | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  const verdict = parseGoalVerify(raw);
  // `verdict.message`, NOT `verdict.reason` (roborev 65858). `reason` is a machine slug
  // (`verify-cmd-missing`), and this string is stored as `generationFailureReason`, which
  // `oneSentence`'s own docstring says "is shown on a card, not in a log" — so the slug reached the
  // user verbatim. `VerifyVerdict` carries `message` written for exactly this.
  if (!verdict.ok) return oneSentence(`unusable verify — ${verdict.message}`);
  if (!isEpicVerifyKind(verdict.verify.kind)) {
    return `verify kind "${verdict.verify.kind}" is not one of ${EPIC_GOAL_VERIFY_KINDS.join("/")}`;
  }
  return epicVerifyOf(verdict.verify);
}
