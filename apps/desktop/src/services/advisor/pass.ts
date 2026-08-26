// THE SECOND-MODEL ADVISOR PASS — bead `sparkle-revqiv`.
//
// A plan reviewed by a DIFFERENT model than the one that wrote it catches what self-review
// structurally cannot. The evidence that bought this feature is not about reasoning quality: two
// agents read the same artifact-storage outage and reached OPPOSITE conclusions; two others
// concurrently purged the same store, burning each other's shared rate limit. Both were CONTEXT
// failures — each agent was right about what it could see. The advisor's leverage is that it can see
// the FLEET's in-flight state, where the planner sees one PRD.
//
// ══ FOUR PROPERTIES, EACH LOAD-BEARING ══════════════════════════════════════════════════════════
//
//  1. IT SPENDS NOTHING OUTSIDE THE SUBSCRIPTION. `./spendGate` is consulted from the LIVE usage
//     payload before every pass and fails closed. That gate, not `[advisor].enabled`, is what bounds
//     spend — which is why the flag ships true.
//
//  2. IT IS DISPATCHED, NEVER AWAITED. It rides `research.rs`, which returns before its child
//     finishes, pins its own model, carries real tools, and is cancellable. The one-shot sink was
//     measured out: `claude_oneshot` passes `--tools ""` so it can retrieve nothing (fatal for the
//     collision lens, which must be retrieval-fed or it hallucinates), and a headless `claude -p`
//     costs 15-27s wall clock — which would sit on the Build It click.
//
//  3. THE PASS IS REQUIRED; ITS FINDINGS ARE NOT. Enforced as an INVARIANT rather than a gate: every
//     handoff writes exactly one TERMINAL label — `advisor:reviewed`, or `advisor:skipped` plus a
//     bead comment naming why — before it returns. There is no reachable state in which an epic
//     reached execution with no verdict recorded. There is also no stall point: the handoff never
//     waits on the pass, and a verdict that arrives after the orchestrator bound upgrades the label
//     in place (see {@link settleAdvisorPass}).
//
//  4. FAILURE MEANS NO VERDICT EXISTS. Inherited verbatim from `judge.rs`, whose header calls this
//     the single most-cited incident in this codebase: an `Err` is never "approved" and never
//     "rejected". An advisor that cannot run MUST PAINT NOTHING — no finding, no reassurance, no
//     implied pass — because a silent advisor that reads as approval is worse than no advisor. Every
//     throw below is caught, recorded as `advisor:skipped`, and the handoff proceeds UNCHANGED.
//
// DEPENDENCY-INJECTED exactly like `services/epicDecompose`, so the whole core above is testable
// with no AI call, no Tauri and no clock.
import { AiBusyError, AiTransientError, AiUnavailableError } from "../anthropic";
import type { ClaudeModelOption } from "../models";
import {
  checkSpendGate,
  creditsMoved,
  SPEND_REFUSAL_TEXT,
  usedCreditsDelta,
  type UsagePayloadForGate,
} from "./spendGate";
import {
  ADVISOR_MODEL_SKIP_TEXT,
  resolveAdvisorModel,
} from "./model";
import {
  holdVerdict,
  renderAuditNote,
  renderSkipNote,
  type AdvisorFinding,
  type AdvisorLens,
  type AdvisorSeverity,
  type AdvisorVerdict,
} from "./findings";

/** The epic carries this once a second model has actually returned a verdict on its plan. */
export const ADVISOR_REVIEWED_LABEL = "advisor:reviewed";
/** …and this when no verdict exists. NEVER both — {@link settleAdvisorPass} swaps rather than adds. */
export const ADVISOR_SKIPPED_LABEL = "advisor:skipped";

/** `[advisor]` as the pass reads it. Mirrors `AdvisorConfig` in `config.rs`. */
export interface AdvisorConfigView {
  enabled: boolean;
  /** `null` when unset — resolution then falls to the catalog rule. */
  model: string | null;
}

/** What one dispatch needs to know about the epic under review. */
export interface AdvisorPassArgs {
  projectPath: string;
  /** ABSOLUTE path the research child runs in. Same value as `projectPath` in production; kept
   *  separate because `research.rs` refuses a non-absolute root outright and a caller that conflated
   *  the two would fail at dispatch rather than here. */
  projectRoot: string;
  projectId: string | null;
  epicId: string;
  epicTitle: string;
  /** The plan text under review — the PRD when there is one, else the epic's own description. */
  planText: string;
  /**
   * The OTHER epics currently in flight, so the collision lens has facts rather than imagination.
   *
   * TITLES WHEN THE CALLER HAS THEM, BEAD IDS WHEN IT DOES NOT — and the field is named for the
   * thing rather than for one of its forms, because `prepareHandoff` genuinely has only ids (the
   * orchestrator rows carry `epicId`, not a title) and calling them titles would be a small lie in
   * a payload whose whole purpose is that the model works from facts. An id is a perfectly good
   * handle for the collision lens: it can `bd show` one.
   *
   * Empty is a real state (nothing else in flight) and is passed as such rather than omitted.
   */
  siblingEpics?: readonly string[];
  /** What the fleet's agents currently claim to be working on, same reasoning as above. */
  agentClaims?: readonly string[];
}

export interface AdvisorPassDeps {
  /** The LIVE usage payload — never a cached constant. `null` when it could not be read, which the
   *  gate refuses on rather than treating as absence of a problem. */
  readUsage: () => Promise<UsagePayloadForGate | null>;
  /** The PLANNER's model id (`ai.rs` CHAT_MODEL via the `planner_chat_model` command). */
  plannerModel: () => Promise<string | null>;
  catalog: () => readonly ClaudeModelOption[];
  config: () => AdvisorConfigView;
  /** `research_dispatch`, with the advisor's model override. Returns the task id. */
  dispatchResearch: (input: {
    question: string;
    projectId: string | null;
    projectRoot: string;
    model: string;
  }) => Promise<{ id: string }>;
  labelBead: (
    projectPath: string,
    action: "add" | "remove",
    id: string,
    label: string,
  ) => Promise<void>;
  commentBead: (projectPath: string, id: string, text: string) => Promise<void>;
  /** The empirical credit latch — see {@link settleAdvisorPass}. */
  latch: AdvisorLatch;
  logError?: (message: string, error: unknown) => void;
}

/**
 * The empirical zero-spend latch's persistence seam.
 *
 * Injected rather than reached for, because the whole point of the latch is that it survives a
 * reload: a test that could not control it would be asserting against whatever the last test left in
 * `localStorage`.
 */
export interface AdvisorLatch {
  /** Has the advisor latched itself OFF? While true no pass is dispatched, at all, ever, until a
   *  human clears it. */
  isLatched: () => boolean;
  /** Latch off, recording why. Called only on an observed credit movement. */
  latch: (reason: string) => void;
  /** The `used_credits` reading taken immediately before the first gate-approved call, or null when
   *  that call has not happened yet (or the field was unreadable). */
  creditsBefore: () => number | null;
  /** Record the "before" reading for the FIRST approved call only. A later call must not overwrite
   *  it — the measurement is of the first call, and re-baselining on every pass would make a slow
   *  drift permanently invisible. */
  recordCreditsBefore: (value: number | null) => void;
  /** Has the first approved call's measurement already been settled? */
  measured: () => boolean;
  markMeasured: () => void;
}

/** Why a pass did not run. Free-form on purpose at the tail (a dispatch error carries the CLI's own
 *  words), but every structural refusal is one of the named constants so the tests enumerate them. */
export type AdvisorSkipReason = string;

export type AdvisorPassOutcome =
  | { state: "dispatched"; taskId: string; model: string }
  | { state: "skipped"; reason: AdvisorSkipReason };

/**
 * The advisor's brief to the research child.
 *
 * ══ EXACTLY THREE LENSES, AND THE THIRD IS RETRIEVAL-FED ════════════════════════════════════════
 *
 * Lens 3 (collision) is the one that hallucinates if it is asked to reason rather than to look, so
 * it is handed `scripts/pr-file-overlap.sh` (whose exit 10 is a REAL path intersection and 12 is
 * already-landed-on-the-base), the sibling epic titles, and the current agent claims. The model
 * JUDGES; it never guesses at facts.
 *
 * Lens 2 (goal) DEFERS to `packages/core/goalGate.ts` rather than restating its rules. Restating
 * them would put a second, drifting copy of the goal contract in a prompt, and the gate is the
 * authority — the advisor's job is only to ask whether a task AS PLANNED could produce a goal that
 * would pass it.
 *
 * DUPLICATE-BEAD DETECTION IS EXPLICITLY OUT OF SCOPE. PR #2150 is building exactly that at
 * bead-filing time; a second one here would be two mechanisms disagreeing about the same question.
 */
export function buildAdvisorQuestion(args: AdvisorPassArgs): string {
  const siblings = args.siblingEpics?.length
    ? args.siblingEpics.map((t) => `  - ${t}`).join("\n")
    : "  (none in flight)";
  const claims = args.agentClaims?.length
    ? args.agentClaims.map((c) => `  - ${c}`).join("\n")
    : "  (no agent claims recorded)";
  return [
    `You are an ADVISOR reviewing a build plan that ANOTHER MODEL wrote, before it is handed to an`,
    `orchestrator to execute. You are NOT the planner and you must NOT rewrite the plan. Comment; the`,
    `orchestrator decides.`,
    "",
    `EPIC ${args.epicId}: ${args.epicTitle}`,
    "",
    "── THE PLAN ──────────────────────────────────────────────────────────────────────────────",
    args.planText,
    "──────────────────────────────────────────────────────────────────────────────────────────",
    "",
    "Review it through EXACTLY THREE LENSES. Nothing else — not style, not naming, not whether you",
    "would have planned it differently, and NOT whether any bead duplicates an existing one (a",
    "separate mechanism owns that at filing time).",
    "",
    "1. SCOPE ONE AGENT CAN HOLD. The planner was told each task must be 'a self-contained unit a",
    "   single engineer can complete and verify'. Did it obey? Name any task that is really several,",
    "   or that cannot be verified without another task landing first.",
    "",
    "2. IS THE COMPLETION CRITERION ACTUALLY CHECKABLE? Do NOT restate the rules in",
    "   packages/core/goalGate.ts — read it and DEFER to it. Judge only whether each task AS PLANNED",
    "   could produce a goal that would pass that gate: an observable end state someone other than",
    "   the agent can check, adding information beyond the task itself.",
    "",
    "3. DOES THIS COLLIDE WITH WORK ALREADY IN FLIGHT? THIS LENS IS RETRIEVAL-FED — you must LOOK,",
    "   never guess. Run:",
    "     scripts/pr-file-overlap.sh <path-fragment>",
    "   for each area the plan touches. Exit 10 = a REAL path intersection with an open PR; exit 13 =",
    "   another LIVE worktree on this machine is changing a file this plan changes — its unpushed",
    "   commits AND its uncommitted edits are both scanned, so this is the only signal that fires for",
    "   an agent dispatched minutes ago that has committed nothing; exit 12 = a commit already on the",
    "   base changes a file this plan changes; 11 = a shared name only, which is NOT a collision.",
    "   Strictest wins (10 > 13 > 12 > 11) and the report names the others. Report ONLY what a command",
    "   actually printed, and cite the command.",
    "   Other epics in flight right now:",
    siblings,
    "   What the fleet's agents currently claim to be working on:",
    claims,
    "",
    "── HOW TO ANSWER ─────────────────────────────────────────────────────────────────────────",
    "Write your prose reasoning first. Then end your reply with ONE fenced json block, and nothing",
    "after it:",
    "",
    "```json",
    '{"findings":[{"lens":"scope|goal|collision","severity":"high|medium|low",',
    '  "summary":"one sentence","evidence":"the path, command output or PR number you cite"}]}',
    "```",
    "",
    "An EMPTY findings array is a legitimate and useful answer — report it rather than manufacturing",
    "a finding. A finding you cannot cite evidence for is a guess; leave it out.",
  ].join("\n");
}

/**
 * Pull the advisor's structured findings out of a research child's free-text answer.
 *
 * Returns `null` for anything it cannot read — an absent block, malformed JSON, a `findings` that is
 * not an array. `null` means NO VERDICT EXISTS and is recorded as `advisor:skipped`; it is
 * deliberately NOT an empty findings list, because "the advisor ran and raised nothing" and "we
 * could not tell what the advisor said" are different facts and only the first is an observation.
 *
 * Tolerant about the fence (the model may or may not tag it `json`) and takes the LAST block, since
 * the prose above it may well quote an example of the format it was asked for.
 */
export function parseAdvisorFindings(text: string | null | undefined): AdvisorFinding[] | null {
  if (!text) return null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const lenses: AdvisorLens[] = ["scope", "goal", "collision"];
  const severities: AdvisorSeverity[] = ["high", "medium", "low"];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1]?.trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const raw = (parsed as { findings?: unknown })?.findings;
    if (!Array.isArray(raw)) continue;
    const out: AdvisorFinding[] = [];
    for (const f of raw) {
      const o = f as Partial<AdvisorFinding>;
      // A finding whose lens or severity is off-contract is DROPPED rather than coerced. Coercing
      // it would invent a severity the model never assigned, and a `high` invented here would fire
      // the one revision round at the decompose seam on nothing.
      if (!o || typeof o.summary !== "string" || !o.summary.trim()) continue;
      if (!lenses.includes(o.lens as AdvisorLens)) continue;
      if (!severities.includes(o.severity as AdvisorSeverity)) continue;
      out.push({
        lens: o.lens as AdvisorLens,
        severity: o.severity as AdvisorSeverity,
        summary: o.summary.trim(),
        ...(typeof o.evidence === "string" && o.evidence.trim()
          ? { evidence: o.evidence.trim() }
          : {}),
      });
    }
    return out;
  }
  return null;
}

/** Is this an AI-layer failure the pass must swallow rather than propagate? Named explicitly rather
 *  than caught as a bare `catch`, so the failure contract in the module header is legible in code:
 *  every one of these means NO VERDICT EXISTS and the handoff proceeds unchanged. */
export function isAiFailure(e: unknown): boolean {
  return e instanceof AiUnavailableError || e instanceof AiBusyError || e instanceof AiTransientError;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * DISPATCH one advisor pass. Returns as soon as the research task EXISTS — never when it finishes.
 *
 * NEVER THROWS. Every failure, AI-layer or otherwise, becomes `{ state: "skipped" }` with a reason,
 * because a throw out of here would reach `prepareHandoff` — a synchronous click path — and turn an
 * advisory review into a broken Build It button.
 */
export async function runAdvisorPass(
  deps: AdvisorPassDeps,
  args: AdvisorPassArgs,
): Promise<AdvisorPassOutcome> {
  try {
    // THE LATCH FIRST. If a previous pass observed the credit meter move, nothing else matters: the
    // premise the spend gate rests on is in doubt and no further call may be dispatched on it.
    if (deps.latch.isLatched()) {
      return { state: "skipped", reason: "advisor is LATCHED OFF: a previous pass observed the credit meter move" };
    }
    const cfg = deps.config();
    if (!cfg.enabled) {
      return { state: "skipped", reason: "[advisor].enabled is false" };
    }

    // ── THE ZERO-SPEND GATE, ON THE LIVE PAYLOAD ────────────────────────────────────────────────
    // Read inside the try: a failed read must refuse, not throw. `readUsage` rejecting and
    // `readUsage` resolving null are the same verdict here and deliberately so — both are "the
    // meter is unreadable", and an unreadable meter is not permission.
    let usage: UsagePayloadForGate | null = null;
    try {
      usage = await deps.readUsage();
    } catch (e) {
      deps.logError?.("advisor: live usage read failed — refusing (fail closed)", e);
      usage = null;
    }
    const gate = checkSpendGate(usage);
    if (!gate.allowed) {
      return { state: "skipped", reason: SPEND_REFUSAL_TEXT[gate.reason] };
    }

    // ── A MODEL DIFFERENT FROM THE PLANNER'S ────────────────────────────────────────────────────
    let planner: string | null = null;
    try {
      planner = await deps.plannerModel();
    } catch (e) {
      deps.logError?.("advisor: could not read the planner's model — refusing (fail closed)", e);
      planner = null;
    }
    const resolved = resolveAdvisorModel({
      configured: cfg.model,
      catalog: deps.catalog(),
      plannerModel: planner,
    });
    if (resolved.model === null) {
      return { state: "skipped", reason: ADVISOR_MODEL_SKIP_TEXT[resolved.reason] };
    }

    // ── THE EMPIRICAL LATCH'S "BEFORE" READING ──────────────────────────────────────────────────
    // Taken from the SAME payload the gate approved on, and recorded only for the FIRST approved
    // call. See `AdvisorLatch.recordCreditsBefore` for why a later call must not re-baseline.
    if (!deps.latch.measured() && deps.latch.creditsBefore() === null) {
      deps.latch.recordCreditsBefore(gate.usedCreditsBefore);
    }

    const task = await deps.dispatchResearch({
      question: buildAdvisorQuestion(args),
      projectId: args.projectId,
      projectRoot: args.projectRoot,
      model: resolved.model,
    });
    return { state: "dispatched", taskId: task.id, model: resolved.model };
  } catch (e) {
    // The failure contract, in one place. An AI-layer error and an unexpected one are both recorded
    // as "no verdict" — they differ only in the words, never in the outcome.
    deps.logError?.(
      isAiFailure(e) ? "advisor: the AI layer was unavailable" : "advisor: dispatch failed",
      e,
    );
    return { state: "skipped", reason: `the advisor pass could not be dispatched: ${errorText(e)}` };
  }
}

// ── THE TERMINAL-STATE INVARIANT ───────────────────────────────────────────────────────────────

/** What a handoff recorded. Exactly one of the two labels, always. */
export interface AdvisorHandoffRecord {
  terminal: "reviewed" | "skipped";
  reason?: string;
  /**
   * The pass this handoff DISPATCHED, when it dispatched one. Returned rather than logged so the
   * caller can register it with the watcher — the task id and the model live nowhere else, and a
   * caller that had to recover them from `reason` would be parsing a sentence written for a human.
   *
   * Absent on every other path, including the reviewed one: a verdict already held means the plan
   * has been reviewed, and re-dispatching on each resume of the same epic would spend quota to
   * re-derive an answer already on the bead.
   */
  dispatched?: { taskId: string; model: string };
}

/**
 * How many times to try the durable audit write, and how long to pause between tries.
 *
 * Same numbers and the same reasoning as `epicSweepRunner`'s hardened audit write, which this reuses
 * verbatim rather than re-deriving: a Dolt lock is transient (one embedded store shared by every
 * worktree, polled every five seconds), so a couple of retries recover the common case without
 * turning best-effort bookkeeping into a stall.
 */
export const ADVISOR_AUDIT_ATTEMPTS = 3;
export const ADVISOR_AUDIT_BACKOFF_MS = 40;

/**
 * The lock/contention wordings that mean "the store was momentarily busy", so re-issuing the SAME
 * write is the right remedy.
 *
 * DELIBERATELY NARROW, and a TIMEOUT is deliberately absent: `bd comment` has no idempotency key, so
 * a timed-out write is genuinely ambiguous (it may have committed in the instant before the kill)
 * and retrying it would duplicate the note. Mirrors `epicSweepRunner`'s list for the same reason.
 */
const LOCK_CONTENTION_WORDINGS: readonly string[] = [
  "locked by another dolt process",
  "context canceled",
  "context cancelled",
  "context deadline exceeded",
  "database is locked",
  "could not acquire lock",
  "failed to acquire lock",
  "lock is held",
  "database is in use",
];

export function isTransientStoreLock(e: unknown): boolean {
  const lower = errorText(e).toLowerCase();
  return LOCK_CONTENTION_WORDINGS.some((w) => lower.includes(w));
}

function backoff(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** BEST-EFFORT BY CONTRACT — never throws. A persistently locked store must not turn an advisory
 *  audit note into a failed handoff. */
/** The last audit note SUCCESSFULLY written per epic — see the idempotence note in `writeAudit`. */
const lastAudit = new Map<string, string>();

/** Epics with a dispatched pass that has not settled — see `ensureAdvisorVerdict`'s dedupe. */
const inFlight = new Set<string>();

/** Test seam: forget the audit and in-flight bookkeeping. Both are module-level caches, so without
 *  this a test's writes leak into the next one and a genuine duplicate would read as deduped. */
export function resetAdvisorPassState(): void {
  lastAudit.clear();
  inFlight.clear();
}

async function writeAudit(
  deps: AdvisorPassDeps,
  projectPath: string,
  epicId: string,
  text: string,
  attempts = ADVISOR_AUDIT_ATTEMPTS,
  backoffMs = ADVISOR_AUDIT_BACKOFF_MS,
): Promise<void> {
  // IDEMPOTENCE, and it is not tidiness — `bd comment` APPENDS. Labels are idempotent, so re-stamping
  // one on every handoff is free; a comment is not. One epic is handed off repeatedly (Start, Build
  // It, `promote_plan_to_build`, the sweep's `sendToBuildAwaited`, and again after a restart), and
  // each of those would otherwise append an identical `advisor: …` note to a single-writer store the
  // desktop board re-reads every 5s. The note is a record of a terminal STATE, so writing it again
  // when the state has not changed adds no information and costs a write on a contended lock.
  if (lastAudit.get(epicId) === text) return;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deps.commentBead(projectPath, epicId, text);
      // Recorded only on SUCCESS: a write that failed left no note, so the next handoff must retry
      // it rather than believe its own bookkeeping.
      lastAudit.set(epicId, text);
      return;
    } catch (e) {
      lastErr = e;
      if (!isTransientStoreLock(e) || attempt === attempts) break;
      await backoff(backoffMs);
    }
  }
  deps.logError?.("advisor: could not write the audit note for an epic", lastErr);
}

/** Best-effort label write. A failed label is bookkeeping; it must not fail a handoff that already
 *  happened, and the next handoff of the same epic re-stamps it (both writes are idempotent). */
async function tryLabel(
  deps: AdvisorPassDeps,
  projectPath: string,
  action: "add" | "remove",
  epicId: string,
  label: string,
): Promise<void> {
  try {
    await deps.labelBead(projectPath, action, epicId, label);
  } catch (e) {
    deps.logError?.(`advisor: could not ${action} ${label} on ${epicId}`, e);
  }
}

/**
 * THE INVARIANT, called once per handoff: this epic reaches execution with a verdict RECORDED.
 *
 * Three outcomes, and every one of them writes exactly one terminal label:
 *
 *   • a verdict is already held  → `advisor:reviewed` + the audit note naming model, verdict and
 *     findings. The findings also ride the seed brief (see `./findings`), synchronously.
 *   • the gate refused, or no model resolved → `advisor:skipped` + a note naming why. NOTHING is
 *     painted into the brief.
 *   • a pass was dispatched and has not answered yet → `advisor:skipped` + a note saying exactly
 *     that, naming the research task. This is the honest reading: at the moment the orchestrator
 *     bound, no verdict existed. When the child answers, {@link settleAdvisorPass} swaps the label
 *     to `advisor:reviewed` and appends the real note — an upgrade in place, not a second record.
 *
 * NEVER BLOCKS and never throws. `prepareHandoff` calls it fire-and-forget, exactly as it already
 * does for `PROMOTED_LABEL`: blocking a click the founder just made on a `bd` write against a
 * single-writer store another worktree may hold is not a trade this path may make.
 */
export async function ensureAdvisorVerdict(
  deps: AdvisorPassDeps,
  args: AdvisorPassArgs,
  heldVerdictFor: (epicId: string) => AdvisorVerdict | null,
): Promise<AdvisorHandoffRecord> {
  try {
    const held = heldVerdictFor(args.epicId);
    if (held) {
      await tryLabel(deps, args.projectPath, "remove", args.epicId, ADVISOR_SKIPPED_LABEL);
      await tryLabel(deps, args.projectPath, "add", args.epicId, ADVISOR_REVIEWED_LABEL);
      await writeAudit(deps, args.projectPath, args.epicId, renderAuditNote(held));
      return { terminal: "reviewed" };
    }
    // ── IN-FLIGHT DEDUPE ────────────────────────────────────────────────────────────────────────
    //
    // A research child takes MINUTES to answer, and nothing held means "no answer yet" — not "none
    // was asked for". Without this, every handoff inside that window dispatches ANOTHER child for
    // the same epic: a double-clicked Build It, or a sweep landing on an epic a human just started,
    // multiplies concurrent second-opinion passes that will all review the same plan. "One dispatch
    // per handoff" was true and was never the property that bounds this; one per epic in flight is.
    //
    // It records a terminal verdict as usual — the invariant is that no epic reaches execution
    // without one, and "a pass is already running" is a perfectly good reason for `advisor:skipped`.
    if (inFlight.has(args.epicId)) {
      const reason = "a pass for this epic was already in flight and had not answered";
      await tryLabel(deps, args.projectPath, "add", args.epicId, ADVISOR_SKIPPED_LABEL);
      await writeAudit(deps, args.projectPath, args.epicId, renderSkipNote(reason));
      return { terminal: "skipped", reason };
    }
    const outcome = await runAdvisorPass(deps, args);
    const reason =
      outcome.state === "dispatched"
        ? `a pass was dispatched on ${outcome.model} (research task ${outcome.taskId}) but had not answered when the orchestrator bound`
        : outcome.reason;
    await tryLabel(deps, args.projectPath, "add", args.epicId, ADVISOR_SKIPPED_LABEL);
    await writeAudit(deps, args.projectPath, args.epicId, renderSkipNote(reason));
    if (outcome.state === "dispatched") inFlight.add(args.epicId);
    return {
      terminal: "skipped",
      reason,
      ...(outcome.state === "dispatched"
        ? { dispatched: { taskId: outcome.taskId, model: outcome.model } }
        : {}),
    };
  } catch (e) {
    // Unreachable by construction (every call above is already best-effort), and kept anyway: this
    // function's whole job is to be the thing that cannot fail, and a throw here would escape into
    // a fire-and-forget with nothing to catch it.
    deps.logError?.("advisor: recording the terminal verdict failed", e);
    return { terminal: "skipped", reason: `recording the verdict failed: ${errorText(e)}` };
  }
}

/**
 * A dispatched pass has ANSWERED — record the verdict and run the empirical credit check.
 *
 * ══ THE `used_credits` LATCH ════════════════════════════════════════════════════════════════════
 *
 * The spend gate rests on a claim: with credits disarmed, a call cannot bill outside the
 * subscription. Nobody has established which meter advisor usage actually hits, and this is the safe
 * empirical test of it — it can only ever run while credits are DISARMED, so its worst case is a
 * failed call, never a bill.
 *
 * If `used_credits` MOVED across the first approved call, the advisor LATCHES ITSELF OFF, writes a
 * bead comment naming the delta, and raises it. It does not retry, average, or wait for a second
 * data point: one movement is the whole finding. An unreadable reading on either side is `null` —
 * "we cannot say", never "it did not move" — and does NOT latch, because latching on an unreadable
 * meter would disable the advisor permanently on the first account whose payload omits the field.
 */
export async function settleAdvisorPass(
  deps: AdvisorPassDeps,
  args: {
    projectPath: string;
    epicId: string;
    taskId: string;
    model: string;
    /** The research child's answer, or null when it failed / was cancelled. */
    findingsText: string | null;
  },
): Promise<AdvisorHandoffRecord> {
  // The pass has ANSWERED, however it answered — so the epic is no longer in flight and a later
  // handoff may dispatch again. Released before anything that can fail, so a throw downstream cannot
  // strand the epic in a state where no pass can ever be dispatched for it again.
  inFlight.delete(args.epicId);
  const parsed = parseAdvisorFindings(args.findingsText);
  // Run the credit measurement FIRST, so a latch is recorded even for a pass whose answer could not
  // be parsed — the spend question is independent of whether the review was legible.
  await measureCreditsAfterFirstCall(deps, args.projectPath, args.epicId);

  if (parsed === null) {
    const reason = args.findingsText
      ? "the advisor answered but its findings block could not be read, so no verdict exists"
      : "the advisor pass failed or was cancelled before it answered, so no verdict exists";
    await tryLabel(deps, args.projectPath, "add", args.epicId, ADVISOR_SKIPPED_LABEL);
    await writeAudit(deps, args.projectPath, args.epicId, renderSkipNote(reason));
    return { terminal: "skipped", reason };
  }

  const verdict: AdvisorVerdict = { model: args.model, taskId: args.taskId, findings: parsed };
  holdVerdict(args.epicId, verdict);
  // SWAP, never add: an epic carrying both labels would be a record that contradicts itself, and the
  // removal is what makes "exactly one terminal label" true rather than "at least one".
  await tryLabel(deps, args.projectPath, "remove", args.epicId, ADVISOR_SKIPPED_LABEL);
  await tryLabel(deps, args.projectPath, "add", args.epicId, ADVISOR_REVIEWED_LABEL);
  await writeAudit(deps, args.projectPath, args.epicId, renderAuditNote(verdict));
  return { terminal: "reviewed" };
}

/** The "after" half of the empirical latch. Runs once, for the FIRST gate-approved call only. */
async function measureCreditsAfterFirstCall(
  deps: AdvisorPassDeps,
  projectPath: string,
  epicId: string,
): Promise<void> {
  if (deps.latch.measured()) return;
  const before = deps.latch.creditsBefore();
  let after: number | null = null;
  try {
    const usage = await deps.readUsage();
    const raw = usage?.extraUsage?.usedCredits;
    after = typeof raw === "number" ? raw : null;
  } catch (e) {
    deps.logError?.("advisor: could not re-read used_credits for the empirical latch", e);
    return; // NOT measured — an unreadable "after" is not evidence in either direction.
  }
  const delta = usedCreditsDelta(before, after);
  if (delta === null) return; // cannot say; leave unmeasured so a later pass can try.
  deps.latch.markMeasured();
  if (!creditsMoved(delta)) return;

  const reason = `used_credits moved by ${delta} across the first gate-approved advisor call (${before} -> ${after})`;
  deps.latch.latch(reason);
  await writeAudit(
    deps,
    projectPath,
    epicId,
    [
      "advisor: LATCHED OFF — RAISE THIS",
      reason,
      "The zero-spend gate permits a call only while extra_usage.is_enabled is FALSE, on the premise",
      "that a disarmed credit meter has no billable destination. That premise just failed its own",
      "empirical test: the meter moved across a call the gate approved. No further advisor pass will",
      "be dispatched on this machine until a human clears the latch. This measurement can only ever",
      "run with credits disarmed, so its worst case was a failed call — but the delta above means the",
      "gate's reading of which meter advisor usage hits is WRONG and must be re-established before",
      "the advisor runs again.",
    ].join("\n"),
  );
}
