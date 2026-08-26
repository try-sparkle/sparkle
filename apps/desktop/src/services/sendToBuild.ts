// "Send to Build" handoff (bead sparkle-hiju.8): hand a beads epic + its PRD off to a Build agent
// (the orchestrator). ONE ORCHESTRATOR PER EPIC (bead sparkle-ctgd): reuses the build agent already
// bound to THIS epic if there is one, else creates a fresh one; opens it (mounts the pane / drives
// the PTY launch); and seeds it with a first prompt that points at the epic + PRD and tells it to
// execute the epic's children following the beads protocol.
import { useProjectStore } from "../stores/projectStore";
import { useBeadsStore } from "../stores/beadsStore";
import { hasEpicGoalText } from "../engine/epicGoal";
import { parentEpicOf } from "./beads";
import { beadReadFallback, beadsProtocol } from "./buildAgent";
import { landInAgent } from "./landInAgent";
import { attentionHold } from "../engine/attentionGuard";
import { localAgentCapacity, atCapacitySentence } from "./agentCapacity";
import {
  mountAgent,
  mounted,
  mountAgentAwaited,
  mountedAwaited,
  type AwaitedMountResult,
} from "./agentMount";
import { labelBead, PROMOTED_LABEL } from "./beads";
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import { useRuntimeStore } from "../stores/runtimeStore";
import { log } from "../logger";
import { EPIC_RESUME_PROMPT_MARKER } from "../engine/agentOriginated";
import { processAliveFor } from "./goalContinuationRunner";
import { attachBrief } from "./agentBrief";
import { advisorBriefFor, advisorHandoffHook } from "./advisor";
import { recordDispatch } from "./dispatchLedger";

/** Thrown when the handoff would need a NEW build agent and the machine is at its ceiling. A named
 *  class so callers can map it to their own vocabulary — the concierge to a typed `at-capacity`
 *  refusal — instead of string-matching a generic Error. */
export class AtCapacityError extends Error {
  readonly atCapacity = true;
  constructor(message: string) {
    super(message);
    this.name = "AtCapacityError";
  }
}

/** Thrown when a machine-driven handoff could not RELAUNCH the agent.
 *
 *  A named class for the same reason {@link AtCapacityError} is one, and for a sharper one besides:
 *  a caller that reports "I restarted it" on a relaunch that never happened is exactly the failure
 *  several review rounds kept finding here. Throwing makes the silent-success shape unavailable —
 *  `services/epicSweepRunner` catches it, records `spawn-failed`, and says nothing to the founder.
 *
 *  ── WHAT IT CARRIES, AND WHY THAT CHANGED ───────────────────────────────────────────────────
 *  It used to mean one thing: "no `Project.agents` row names this id". That condition is
 *  UNREACHABLE from this module and always was — {@link prepareHandoff} either finds an existing
 *  row or calls `addAgent`, which inserts one, so by the time any mount runs the row is present by
 *  construction. The check re-read the store and could only ever answer `true`, which made this
 *  whole channel dead code dressed as a safety net: the sweep's `spawn-failed` branch, its test,
 *  and the reasoning in three review rounds all rested on a throw that could not fire.
 *
 *  So the refusal is spent on the failures that ACTUALLY occur, which are the ones only waiting can
 *  see: the pane gave up, Claude is missing, the re-spawn timed out, or nothing re-spawned at all.
 *  `reason` carries which — see `AwaitedMountResult`. */
export class MountRefusedError extends Error {
  readonly mountRefused = true;
  /** The `AwaitedMountResult` that refused, so a caller can log the cause rather than a string. */
  readonly reason: string;
  constructor(message: string, reason = "no-agent-row") {
    super(message);
    this.name = "MountRefusedError";
    this.reason = reason;
  }
}

// `agentRowPresent` USED TO LIVE HERE, and its removal is the point rather than tidying. It re-read
// the store to ask whether a `Project.agents` row named the id — a question `prepareHandoff` has
// just answered by either finding that row or calling `addAgent` to insert one. So it could only
// ever return `true`, which is what made `MountRefusedError`'s original `no-agent-row` case
// unreachable while three review rounds reasoned about it as a live guard. Both mount call sites now
// pass `() => true` and say why. `services/resurrectionRunner` keeps its OWN, differently-shaped
// `agentRowPresent`: that caller has no such guarantee, so there the question is real.

/**
 * The refusal's first clause, matched to what was actually asked for.
 *
 * `atCapacitySentence`'s `lead` exists precisely so each site keeps an accurate opening while
 * sharing every factual claim. "Build It" on a single task builds ONE bead on ONE worker branch —
 * there is no plan in it — and the sentence is shown verbatim in the overlay, so calling it a plan
 * would describe something the user did not ask for (roborev 55143).
 */
function capacityLead(mode: SendToBuildArgs["mode"]): string {
  return mode === "task"
    ? "Building this task would need another agent."
    : "Starting this plan would need another agent.";
}

/**
 * Would {@link sendToBuild} refuse this handoff? Returns the reason, or null if it would proceed.
 *
 * ASK BEFORE YOU MUTATE. Every board handoff `claimBead`s the epic to `in_progress` BEFORE calling
 * sendToBuild. That was harmless while sendToBuild only threw for an unknown project — a state the
 * caller had already ruled out — but the capacity throw makes claim-then-fail a ROUTINE path: the
 * epic would be left marked in progress with no orchestrator bound, and nothing un-claims it. For a
 * backlog card it is worse than untidy, because the claim moves the card out of the `backlog`
 * column that renders the Start button at all, so the affordance the user just clicked disappears
 * and the retry is only reachable through the detail overlay (roborev 55139).
 *
 * Same reading as the gate itself, so the two cannot disagree — this is a PREFLIGHT, not a second
 * policy. The gate stays authoritative: a caller that skips this check is still refused.
 */
export function sendToBuildBlockedReason(
  projectId: string,
  epicId: string,
  mode: SendToBuildArgs["mode"] = "epic",
): string | null {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return null; // not our error to report; sendToBuild throws its own for this
  const existing = project.agents.find((a) => a.kind === "build" && a.epicId === epicId);
  if (existing) return null; // resuming a bound orchestrator consumes no slot
  const capacity = localAgentCapacity();
  return capacity.atCapacity ? atCapacitySentence(capacity, capacityLead(mode)) : null;
}

export interface SendToBuildArgs {
  projectId: string;
  epicId: string;
  /** Repo-relative PRD path, or null for a PRD-less epic (e.g. one created directly in bd, or a
   *  backlog epic Started before a PRD exists) — the seed then points the orchestrator at the epic
   *  bead itself instead of blocking on a PRD that isn't there. */
  prdPath: string | null;
  /** What kind of bead we're handing off. "epic" (the default) tells the orchestrator to fan the
   *  epic's child tasks out across workers; "task" tells it to build THIS ONE bead on a single
   *  isolated worker branch without fanning out. `epicId` still names the target bead in both. */
  mode?: "epic" | "task";
  /**
   * Should the handoff TAKE THE VIEW — leave the board, select the agent, open its pane and scroll
   * its row into sight? Defaults to `true` because every board click wants exactly that.
   *
   * PASS `false` FOR A HANDOFF NOBODY CLICKED. `landInAgent`'s own header says to call it "ONLY for
   * a hand-off the user actually asked for", and names `services/workerSpawn` — which passes
   * `select: false` — as the precedent: an agent the user never asked for must not take their
   * terminal. Calling it unconditionally was fine while every caller was a click, and stopped being
   * fine the moment `services/epicSweepRunner` began handing epics over on a ten-minute timer: that
   * yanks the founder off whatever board or agent he is reading, with no gesture behind it.
   *
   * It gates ONLY the reveal. The binding, the capacity check and the seeded prompt all still
   * happen, because they are what the handoff IS — this decides whether he gets moved to watch it.
   */
  reveal?: boolean;
  /**
   * Did a PERSON press something to cause this? Defaults to `"user"`, which is NEVER declined.
   *
   * DISTINCT FROM `reveal`, and the two are not redundant. `reveal: false` means "this caller has
   * not earned the view at all"; `attention` means "it has, unless taking it right now would pull
   * the founder out of a terminal he is typing in" (engine/attentionGuard). A caller that passes
   * neither behaves exactly as it always has.
   *
   * `"auto"` is opt-in for the same reason it is on SpawnBuildAgentOpts: three of this function's
   * four callers are button handlers, and a declined click is the regression `landInAgent` exists
   * to prevent. Today only `conciergeTools/plans` passes it.
   */
  attention?: "user" | "auto";
  /**
   * Did a PERSON trigger this handoff? Defaults to `true` because every board click is one.
   *
   * IT MATTERS ONLY ON THE REUSE PATH, and that is exactly the path a machine can drive (roborev
   * 55721). A brand-new orchestrator owes no goal debt, so the flag cannot change anything for it.
   * But this function REUSES an orchestrator already bound to the epic — its own docstring
   * advertises that a bound plan "RESUMES that agent" — and `promotePlanToBuild` is the concierge's
   * tool layer. So an LLM calling `promote_plan_to_build` on an epic whose orchestrator is
   * ESCALATED reached `appendPrompt` with the default and ran `releaseGoalDebt`: escalation
   * un-latched, `totalContinues` zeroed, `goalDebt` dropped. `projectStore.releaseGoalDebt` says
   * that bound must not be reachable from a machine dispatch, and here it was.
   *
   * The fourth site of one hole. The other three are in `conciergeDispatch` (direct send, queued
   * flush, picker answer); this is the only production `appendPrompt` outside that file a concierge
   * tool can drive.
   */
  humanAuthored?: boolean;
}

/**
 * The epic goal this handoff ladders up to — the epic it belongs to, and that epic's goal text.
 *
 * TWO MODES, TWO DIFFERENT QUESTIONS, which is the whole reason this is a function rather than one
 * store read at the call site:
 *
 *   `mode: "epic"` — `args.epicId` IS the epic, and its goal is the ORCHESTRATOR'S OWN objective.
 *   `mode: "task"` — `args.epicId` names a TASK bead (the field is misnamed; see `SendToBuildArgs`).
 *     Its goal is the PARENT epic's, resolved through `beads.parentEpicOf`, and it is the objective
 *     this one task LADDERS UP TO rather than one anybody here is expected to meet.
 *
 * Returns null for every shape that has no goal to state — an unknown project, a task with no
 * parent epic, an epic nobody has written a goal for, and a goal record left behind by a FAILED
 * generation (`hasEpicGoalText` rejects the empty text those carry). Null is what keeps the seed
 * prompt byte-identical to what it produced before this feature existed, which is not a nicety: a
 * change that silently reworded every brief in flight would be a regression, not a feature.
 *
 * Reads the board snapshot the app already polls rather than shelling out to `bd`. `prepareHandoff`
 * is synchronous and on the click path — see the `labelBead` note below for why a `bd` round trip
 * does not belong here — and a snapshot that has not loaded yet degrades to "no goal", which is the
 * same no-op as an epic that has none.
 */
function epicGoalLadder(
  args: Pick<SendToBuildArgs, "projectId" | "epicId" | "mode">,
): { epicId: string; text: string; setAt: number } | null {
  let epicId: string | null = args.epicId;
  if (args.mode === "task") {
    const beads = useBeadsStore.getState().byProject[args.projectId]?.beads ?? [];
    const bead = beads.find((b) => b.id === args.epicId);
    epicId = bead ? (parentEpicOf(beads, bead)?.id ?? null) : null;
  }
  if (epicId === null) return null;
  // NO `if (!project) return null` guard, deliberately: both callers run AFTER `prepareHandoff`'s
  // own unknown-project throw, so it is unreachable — an inert line no test could catch regressing
  // (mutation-check, cause 4). Optional chaining covers the shape without pretending to a check.
  const goal = useProjectStore.getState().projects.find((p) => p.id === args.projectId)
    ?.epicGoals?.[epicId];
  if (!hasEpicGoalText(goal)) return null;
  return { epicId, text: goal.text, setAt: goal.setAt };
}

/** The parent-objective paragraph for a SINGLE-TASK handoff. A separate function, not an inline
 *  spread, so the conditional that includes it is one mutable line — a multi-line `...(x ? [ … ]
 *  : [])` cannot be judged by `scripts/mutation-check.sh` at all, which is how a whole branch ends
 *  up unverified while the check reports the change as covered. */
function taskLadderLines(ladder: { epicId: string; text: string }): string[] {
  return [
    "",
    `THIS TASK LADDERS UP TO EPIC ${ladder.epicId}, whose goal, verbatim, is:`,
    `  ${ladder.text}`,
    "",
    "This one task does NOT achieve that on its own, so the `goal` you pass to `spawn_worker`",
    "must not restate it. Give the worker a NARROWED SLICE: the observable end state THIS",
    "task leaves behind, checkable by someone other than the worker, and stated so that its",
    "being true is demonstrably in service of the sentence above. A goal that merely",
    "restates the task is not one either — the task is what to DO, the goal is what will be",
    "TRUE when it is done.",
  ];
}

/** The orchestrator's OWN objective, for an epic handoff. Split out for the same reason as
 *  {@link taskLadderLines}. */
function epicLadderLines(ladder: { epicId: string; text: string }): string[] {
  return [
    "",
    "THE GOAL OF THIS EPIC — your own objective, verbatim:",
    `  ${ladder.text}`,
    "",
    "That is what the whole epic is judged by. Fan it OUT rather than handing it down: every",
    "worker you spawn gets a goal that is a NARROWED SLICE of it — the observable end state for",
    "that one task, demonstrably in service of the sentence above — never a restatement of that",
    "sentence, and never merely a restatement of the task.",
  ];
}

/** Build the orchestrator's seed prompt. For an epic: point at the spec (the PRD when there is one,
 *  else the epic bead's own description) and tell it to fan the epic's children out across workers.
 *  For a single task: tell it to build THAT one bead on one isolated worker branch — no fan-out.
 *  Both keep the beads protocol addendum so the work graph stays in sync.
 *
 *  `ladder` is the epic goal in force (see {@link epicGoalLadder}); null reproduces the exact prompt
 *  this function produced before epic goals existed. */
function buildSeedPrompt(
  args: SendToBuildArgs,
  ladder: { epicId: string; text: string } | null = null,
): string {
  if (args.mode === "task") {
    const spec = args.prdPath
      ? `read the PRD at ${args.prdPath} for surrounding context, then`
      : "then";
    return [
      `Build bead ${args.epicId} (a single task).`,
      "",
      // `bash scripts/bead-brief.sh`, not `bd show`: the raw thread is unbounded (one machine
      // comment per recurrence sighting, repeating one recommendation verbatim), and the `--json`
      // form the orchestrator persona used to carry strips comments outright. The brief is the one
      // read that gives an agent the bead AND the humans' notes on it without flooding the seed.
      // Bead sparkle-mzgqt.6.
      `Run \`bash scripts/bead-brief.sh ${args.epicId}\` from the repo root to read it — the bead`,
      `and every human comment on it, bounded (${beadReadFallback(args.epicId)});`,
      `${spec} implement it on ONE isolated worker`,
      "branch, verify it, and integrate that branch. Do not fan out into children — this is a single",
      "unit of work, not an epic.",
      // THE PARENT OBJECTIVE, stated here and NOT handed to `beadsProtocol`. In this mode the id
      // below is a TASK, so `beadsProtocol({ epicId: args.epicId })` is already calling a task an
      // epic; feeding it the epic goal too would print "the goal of epic <task-id>", attaching the
      // parent's objective to the wrong bead in the one place the orchestrator is told to read it.
      ...(ladder ? taskLadderLines(ladder) : []),
      "",
      "Follow the beads protocol below to keep the work graph in sync as you go:",
      "",
      beadsProtocol({ epicId: args.epicId }),
    ].join("\n");
  }
  const spec = args.prdPath
    ? `First, read the PRD at ${args.prdPath} to understand the goal, constraints, and acceptance`
    : `First, run \`bash scripts/bead-brief.sh ${args.epicId}\` from the repo root`
      + ` (${beadReadFallback(args.epicId)}) and read the epic's description AND`
      + ` the human comments on it for the goal and`;
  return [
    `Build epic ${args.epicId}.`,
    "",
    spec,
    "criteria. Then execute the epic's child tasks: decompose them across isolated worker agents,",
    "integrating each worker's branch into your build branch sequentially.",
    // THE ORCHESTRATOR'S OWN OBJECTIVE. Stated up here as well as inside the beads protocol below
    // because they are two different instructions to the same reader: this one says what YOU are
    // judged by, the protocol's says what every worker you spawn must be judged by.
    ...(ladder ? epicLadderLines(ladder) : []),
    "",
    "Follow the beads protocol below to keep the work graph in sync as you go:",
    "",
    beadsProtocol({ epicId: args.epicId, ...(ladder ? { epicGoal: ladder.text } : {}) }),
  ].join("\n");
}

/**
 * What a machine-driven handoff actually did.
 *
 * THE VERDICT TRAVELS, rather than being collapsed into the agent id. A caller that reports to a
 * human needs to distinguish "I restarted your orchestrator" from "it was already running and I
 * handed the epic back to it" — both are real handoffs, only one is a restart, and saying the wrong
 * one is the same class of false claim this whole path exists to remove. Collapsing them is how the
 * defect got RELOCATED from the mount layer to the reporting layer once the mount was fixed.
 */
export interface BuildHandoff {
  agentId: string;
  verdict: AwaitedMountResult;
}

/** Did this handoff actually RELAUNCH the agent, as opposed to finding it already up? The predicate
 *  a caller needs before writing the word "restarted" into a notice or a durable record. */
export function didRelaunch(h: BuildHandoff): boolean {
  return h.verdict !== "already-live";
}

/** What the shared prologue settled, before either entry point decides how to mount. */
interface PreparedHandoff {
  agentId: string;
  /** Was an EXISTING orchestrator reused (rather than a fresh one created)? The reuse path is the
   *  only one where a resume can happen, and so the only one that needs the seed DELIVERED rather
   *  than merely appended — see {@link sendToBuildAwaited}. */
  reused: boolean;
}

/**
 * Everything both entry points do identically: find the project, enforce the cap, get the
 * orchestrator, bind the epic to it.
 *
 * ONE COPY, deliberately. This module's own header records what happened the last time a second
 * handoff path re-derived half of a shared rule (`services/agentMount` exists because of it), and
 * the prologue is where the load-bearing invariants live — one orchestrator per epic, the
 * machine-wide capacity ceiling, and the two id bindings that make the board's Shipped column
 * reachable. A second copy that drifts on any of those is a bug in a place nobody looks.
 */
function prepareHandoff(args: SendToBuildArgs): PreparedHandoff {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === args.projectId);
  if (!project) throw new Error(`unknown project ${args.projectId}`);

  // ONE ORCHESTRATOR PER EPIC (bead sparkle-ctgd): reuse a build agent ONLY when it is already
  // bound to THIS epic, so a new epic never lands on an orchestrator busy with — or finished on —
  // other work. This is the mirror of planView.ts's `orchestratorNameForEpic`, which reads the link
  // back with the same `a.kind === "build" && a.epicId === epicId`; the two must agree for the
  // epic↔orchestrator link to be 1:1.
  //
  // An UNBOUND build agent (no epicId) is deliberately not reused: it may be one the user started
  // by hand and is talking to.
  const existing = project.agents.find((a) => a.kind === "build" && a.epicId === args.epicId);
  // THE MACHINE-WIDE CAP, enforced HERE rather than in the callers (roborev 55135).
  //
  // This function reaches `store.addAgent` directly, and addAgent has no capacity check — the other
  // gates live in `spawnBuildAgentInProject` and the concierge's `spawn_build_agent`, neither of
  // which this path touches. It was first gated in ONE caller (the concierge's
  // promote_plan_to_build), which left the four Plan-board handoffs — "Start", "Build It",
  // "Build It (task)", and the epic-row button in BoardView — sailing straight past it. That is the
  // same asymmetry agentCapacity's own header records from the last occurrence, and the reason the
  // gate belongs on the shared path: a cap enforced on some callers is not a cap.
  //
  // Only when a NEW agent would be created: reusing the orchestrator already bound to this epic
  // consumes no slot, and refusing that would leave an at-capacity machine unable to resume work it
  // had already started.
  //
  // THROWS, because every caller already has a failure channel for it: the concierge maps it to a
  // typed `at-capacity` refusal, and the board's click handlers surface it the way they surface any
  // other handoff failure. Returning null would have been silently ignored by the click paths.
  if (!existing) {
    const capacity = localAgentCapacity();
    if (capacity.atCapacity) {
      throw new AtCapacityError(atCapacitySentence(capacity, capacityLead(args.mode)));
    }
  }
  const agentId = existing ? existing.id : store.addAgent(args.projectId, { kind: "build" });
  // addAgent returns null only for an unknown project, which the guard above already rejected —
  // keep the check anyway so a future reorder can't turn it into a silent phantom-id path.
  if (!agentId) throw new Error(`unknown project ${args.projectId}`);

  // Bind the epic to the orchestrator right away (spec §8): the sidebar epic pill reads
  // AgentTab.epicId, so it shows immediately — before any worker binds to a bead.
  store.setAgentEpicId(args.projectId, agentId, args.epicId);

  // …and bind that SAME human-filed bead as the orchestrator's `beadId` (bead sparkle-0bhr). This is
  // the seam that makes the board's "Shipped" column reachable for hand-filed work. Without it, the
  // ONLY thing that ever set a build agent's beadId was the AUTO path (buildAgentSpawn +
  // syncBeadLifecycle's `create`), which stamps `sparkle-auto` — telemetry the board deliberately
  // HIDES. So every delivered bead was a hidden auto-bead, and a bead a human filed by hand, handed
  // to Build, and shipped had no agent linkage at all: `shipAgent` reads `agent.beadId` and marks it
  // delivered on land, but that field was empty for the human's bead, so it could never reach
  // Shipped. Linking the epic here routes the human bead through the exact same ship/lifecycle path
  // the auto-beads already use — and because the orchestrator now HAS a bead, syncBeadLifecycle's
  // `create` gate is satisfied, so no redundant `sparkle-auto` duplicate is minted for it either.
  store.setAgentBeadId(args.projectId, agentId, args.epicId);

  // ── AND THE ORCHESTRATOR'S OWN GOAL IS THE EPIC'S GOAL ──────────────────────────────────────
  //
  // The prompt above TELLS it the objective; this makes the objective READABLE — by engine/agentStall
  // (is this idle row done or stalled?), by engine/goalContinuation, and by the human reading the
  // row. Without it an orchestrator driving a goal-bearing epic is, to every one of those readers,
  // a goalless agent.
  //
  // THREE GUARDS, each closing a specific way this could do harm:
  //
  //   EPIC MODE ONLY. In "task" mode `args.epicId` is a TASK, and the goal `epicGoalLadder` finds is
  //   its PARENT epic's — an objective no single task achieves. Writing it here would hand this
  //   orchestrator a goal it can never meet, which is precisely the "cannot be told apart from one
  //   that stopped" failure the whole feature exists to avoid. The prompt still STATES that parent
  //   goal in task mode, because reading it and being judged by it are different things.
  //
  //   ONLY WHEN THE AGENT HAS NO GOAL YET. A reused orchestrator may have reworded its objective, or
  //   a human may have written one; a handoff must not overwrite either. `existing` is the same row
  //   the reuse branch above found — a freshly `addAgent`ed one has no goal by construction.
  //
  //   `actor: "agent"`, NOT the `"human"` default. This is a machine-driven write (the board's Start
  //   button, the concierge's tool layer, and the epic sweep's timer all reach here), and
  //   `setAgentGoal`'s own docstring says `"human"` "starts genuinely new text on a clean budget and
  //   releases any stashed debt". Passing it would let a machine handoff launder an escalation and
  //   refill the retry budget — the exact bound `SendToBuildArgs.humanAuthored` exists to protect one
  //   layer up. `"agent"` carries `totalContinues` and any escalation forward, which is the
  //   conservative direction and the only correct one for a caller that is not a person typing.
  //
  //   ── THE EPIC GOAL'S CHECK DOES NOT TRAVEL, AND THAT IS SETTLED ────────────────────────────
  //   Three review rounds tried to carry it and each produced a worse bug than the one it fixed
  //   (roborev 65868 → 65882 → 65890 → 65892):
  //     • Passing nothing left the copy self-markable — the original complaint.
  //     • Falling back to `{kind:"human"}` was worse: `newGoal` records ANY verify it is handed as
  //       `verifyStated: true`, so a check nobody chose became caller-chosen and BINDING —
  //       re-creating sparkle-vfkqz (sticky, undischargeable, escalates forever) and firing
  //       `agentStall`'s red `human-verified-goal` cause.
  //     • Copying only a "stated" check did not help: `newEpicGoal` stamps `verifyStated` for the
  //       GENERATOR's model-written check too, which is the default path.
  //     • Copying only `source: "human"` checks did not help either, and this is the one that
  //       settles it: NO human-facing surface can attach a check to an epic goal at all. The row
  //       calls `setEpicGoal(…, "human")` with no verify. The sole writer of human+verify is the
  //       concierge tool, where `verify` is a MODEL-AUTHORED tool argument. So `source` separates
  //       generator-model from concierge-model — never model from person.
  //
  //   There is therefore no check here that a PERSON chose, and binding an agent to a model's
  //   suggestion is exactly what the two paid-for bugs above are. So none travels.
  //
  //   THAT IS NOT A HOLE. Whether the EPIC is achieved is answered by `engine/epicGoalRollup`, over
  //   CHILD BEADS, which no agent's claim can move; an orchestrator marking its own goal met is a
  //   fact about that agent, and `engine/epicContinuation` is what notices an epic with nobody on
  //   it. If a human-chosen check is ever wanted here, the fix is to record provenance the concierge
  //   cannot stamp for itself — not to guess from a label.
  //
  //   ── AND A STALE COPY IS RE-SYNCED, BUT ONLY IF IT IS A COPY (roborev 65882) ────────────────
  //   `services/epicLadder`'s header rejects freezing the epic goal into children because a copied
  //   string goes stale. This write is the one place a copy is unavoidable, so it must be
  //   refreshable — but `AgentGoal` records no AUTHOR, so `setAt` alone cannot tell a stale ladder
  //   copy from the objective a human deliberately wrote for this orchestrator. Keyed on `setAt`
  //   alone it destroyed the second, on a path that includes the epic sweep's TIMER.
  //   `fromEpicGoalAt` is the marker this code stamps at copy time; a goal without one is never
  //   re-synced.
  //
  //   IDENTICAL TEXT IS NOT STALE. `setEpicGoal` re-stamps `setAt` on EVERY write, so re-saving the
  //   same sentence would call `setAgentGoal` with byte-identical text — which takes its
  //   unchanged-text branch and STRIPS `metAt`, reverting a met orchestrator to unmet and
  //   re-entering auto-continue because someone re-saved a field they had not changed.
  if ((args.mode ?? "epic") === "epic") {
    const ladder = epicGoalLadder(args);
    const prior = existing?.goal;
    const copied = prior?.fromEpicGoalAt;
    // Each rule on its OWN line: mutation-check cannot judge a line whose mutant does not parse.
    const textChanged = ladder !== null && ladder.text.trim() !== (prior?.text.trim() ?? "");
    const newer = ladder !== null && copied !== undefined && ladder.setAt > copied;
    const stale = newer && textChanged;
    if (ladder && (prior === undefined || stale)) {
      store.setAgentGoal(args.projectId, agentId, ladder.text, undefined, "agent");
      // The annotation is a SEPARATE call so it cannot disturb `setAgentGoal`'s guards. It is what
      // makes the next handoff able to tell this copy from a goal a person wrote.
      store.markAgentGoalFromEpic(args.projectId, agentId, ladder.setAt);
    }
  }

  // …and record the handoff ON THE BEAD, which is what puts the epic in the epic sweep's watch set
  // and KEEPS it there. The two `store.set…` calls above are the same fact written to a tab, and a
  // tab is closed, retired and relaunched all the time; this is the fact written to the work. See
  // `beads.PROMOTED_LABEL` for the measurement that made this necessary — deriving the watch gate
  // from the roster alone left the sweep unable to act on any epic, ever, since v0.114.0.
  //
  // FIRE AND FORGET, DELIBERATELY. `prepareHandoff` is synchronous and is on the click path for the
  // board's Start button; blocking a handoff the user just asked for on a `bd` write — against a
  // single-writer store another worktree may hold the lock on — would stall the UI for the length of
  // that queue. A missed label costs one un-watched epic that the next handoff re-stamps; a stalled
  // click costs the founder the interaction. `labelBead` is idempotent, so re-stamping is free.
  //
  // "task" mode is EXCLUDED: it hands over a single bead to build on one worker, not a plan to be
  // driven to completion, and the sweep's whole premise is an epic with children that stopped
  // moving. Stamping it would aim the sweep at ordinary tasks.
  if ((args.mode ?? "epic") === "epic") {
    void labelBead(project.rootPath, "add", args.epicId, PROMOTED_LABEL).catch((e: unknown) => {
      log.warn("epics", "could not mark an epic as promoted to build", {
        epic: args.epicId,
        error: String(e),
      });
    });

    // ── THE SECOND-MODEL ADVISOR PASS (bead `sparkle-revqiv`) ────────────────────────────────
    //
    // THIS is the choke point, which is the whole reason the hook sits here rather than in the four
    // callers: every route by which an epic becomes a build orchestrator — the board's Start and
    // Build It buttons, the concierge's `promote_plan_to_build`, and the epic sweep through
    // `sendToBuildAwaited` — passes through `prepareHandoff`. A hook in one caller is not a hook.
    //
    // It is deliberately NOT attached to `epicDecompose`'s `decompose:requested` label instead: NO
    // UI EVER SETS THAT LABEL (it is defined, read and removed only inside `epicDecompose.ts`, and
    // applied by hand), so an advisor riding on it alone would essentially never run.
    //
    // FIRE AND FORGET, for exactly the reason the `labelBead` above is: this function is synchronous
    // and on the click path, and the hook writes to the same single-writer `bd` store. It never
    // throws, never rejects, and never blocks — the findings from a pass it dispatches reach the
    // NEXT handoff of this epic, and the terminal verdict (`advisor:reviewed` | `advisor:skipped`)
    // is recorded on the bead either way. `epicSweepRunner`'s "makes NO model call on any path"
    // header stays true of the SWEEP: the only call here is gated on the live usage payload and
    // refuses unless usage credits are disarmed.
    void advisorHandoffHook({
      projectPath: project.rootPath,
      projectRoot: project.rootPath,
      projectId: args.projectId,
      epicId: args.epicId,
      epicTitle: args.epicId,
      planText: args.prdPath
        ? `The plan for this epic is the PRD at ${args.prdPath} — read it.`
        : `This epic has no PRD; run \`bash scripts/bead-brief.sh ${args.epicId}\` from the repo`
          + ` root (${beadReadFallback(args.epicId)}) and read its description and the human`
          + ` comments on it as the plan.`,
      // IDS, not titles — this store holds `epicId` and nothing richer. See `AdvisorPassArgs`.
      siblingEpics: project.agents
        .filter((a) => a.kind === "build" && a.epicId && a.epicId !== args.epicId)
        .map((a) => a.epicId as string),
      agentClaims: project.agents
        .filter((a) => a.beadId && a.beadId !== args.epicId)
        .map((a) => `${a.name ?? a.id}: ${a.beadId}`),
    });
  }

  return { agentId, reused: Boolean(existing) };
}

/**
 * Seed the orchestrator's opening mission — as a LAUNCH BRIEF, and as composer bookkeeping.
 *
 * ══ THE STORE WRITE ALONE DELIVERS NOTHING, AND ITS DOC USED TO CLAIM OTHERWISE ═══════════════
 *
 * This function used to call `appendPrompt` and stop, on the stated theory that "on a FRESH agent
 * that is exactly right, because `briefForLaunch` picks the draft up and the spawn carries it into
 * the session." **`briefForLaunch` has never read the draft.** It reads `agentBrief`'s module-level
 * `held` map, which is populated by `attachBrief` and by nothing else — and `sendToBuild` /
 * `sendToBuildAwaited` never called it. So `AgentPane`'s `briefForLaunch(agent.id, resume)` returned
 * `undefined` on the fresh path too, `initialPrompt` was omitted from the assembled spawn, and claude
 * was exec'd WITH NO PROMPT AT ALL.
 *
 * Measured cost before this line existed: twelve orchestrators created by `epicSweepRunner` sat with
 * an empty prompt, each one's transcript holding exactly one user message — the nudger's automated
 * ping, not its brief. Six epics spent their one-shot sweep-restart budget on an agent that was never
 * told anything.
 *
 * The store write is KEPT, and it is not redundant: it is what puts the mission in the pinned header
 * and the prompt history a human reads in the pane. But it is bookkeeping. `attachBrief` is delivery.
 *
 * ══ WHY ATTACHING UNCONDITIONALLY IS SAFE ON THE RESUME PATH ══════════════════════════════════
 *
 * `briefForLaunch(agentId, true)` returns `undefined` before it ever consults `held`, so a RESUMING
 * agent cannot emit this text as argv no matter what is attached — which is what keeps this from
 * double-delivering alongside the `resumeInstruction` that `sendToBuildAwaited` dispatches on that
 * branch. The brief simply stays held (`attachBrief` replaces rather than accumulates, so repeated
 * sweeps of one epic hold one entry, and `clearBrief` discards it when the row goes away).
 *
 * The one behaviour that follows from holding it: if that same agent LATER launches fresh — its
 * session gone, "Start again" after a crash — it will carry this brief as its argv instead of coming
 * up blank. That is the desirable direction, and it is the same retention rule `noteBriefFailed`
 * already relies on for Retry.
 *
 * The known accepted cost is unchanged and documented at the delivery branch in
 * {@link sendToBuildAwaited}: a bound-but-never-opened agent is `reused` yet spawns FRESH, so it now
 * gets both the argv brief and the terse resume instruction. The two agree, and the alternative —
 * misclassifying the far more common resume as fresh — delivers nothing at all.
 */
function seedDraft(args: SendToBuildArgs, agentId: string): void {
  // THE ADVISOR FINDINGS RIDE THE ARGV PATH, and folding them in HERE is what makes that true.
  //
  // `attachBrief` below is the one channel a launch actually reads (`briefForLaunch` consults the
  // held map and nothing else), so the findings have to be part of the STRING that goes into it —
  // not appended afterwards, not written to the store, not dispatched. This module's own header
  // records the cost of believing otherwise: twelve orchestrators created with an empty prompt.
  //
  // SYNCHRONOUS and never throws: it returns the prompt UNCHANGED when no verdict is held, which is
  // the ordinary first-handoff case and every case where the pass could not run. An advisor that
  // cannot run paints nothing.
  //
  // It folds BEFORE the `appendPrompt` below on purpose. The two consumers must receive the same
  // string: the record's `promptId` rides the brief precisely so the pane completes the row we
  // wrote rather than writing a second one, and a store row missing the findings the argv carries
  // would make the jump-to-prompt show a mission the orchestrator never received.
  const prompt = advisorBriefFor(args.epicId, buildSeedPrompt(args, epicGoalLadder(args)));
  const humanAuthored = args.humanAuthored ?? true;
  // BOOKKEEPING FIRST, so its `promptId` can ride the brief. Authorship is forwarded rather than
  // defaulted — see `SendToBuildArgs.humanAuthored` for why it is load-bearing on the REUSE path.
  const promptId = useProjectStore
    .getState()
    .appendPrompt(args.projectId, agentId, prompt, "composer", humanAuthored);
  // DELIVERY. Emitted as claude's positional prompt by the pane's next fresh launch, which claude
  // submits itself at startup — see `services/agentBrief` for why argv is the only channel that
  // cannot lose the submit.
  //
  // THE RECORD IS NOT OPTIONAL HERE. The pane runs `recordPromptSideEffects` after an argv launch,
  // which writes the prompt to the store again and releases goal debt as a HUMAN send. Handing it
  // what we already wrote is what keeps one mission to one `promptHistory` row and keeps a machine
  // handoff from un-latching an escalation — see `BriefRecord` for both bugs in full.
  attachBrief(agentId, prompt, { promptId, humanAuthored });
}

/** Hand the epic off to the project's Build agent. Returns the build agent id.
 *
 *  THE CLICK PATH. Synchronous, because every caller is a button handler and a board click wants the
 *  view to move now. For the machine-driven path — a timer, with a budget to spend and a human to
 *  report to — use {@link sendToBuildAwaited}. */
export function sendToBuild(args: SendToBuildArgs): string {
  const { agentId } = prepareHandoff(args);

  // ══ THE DELEGATION LEDGER (services/dispatchLedger) ═══════════════════════════════════════════
  //
  // ITS OWN WRITE SITE, because this path reaches `projectStore.addAgent` DIRECTLY — through
  // `prepareHandoff` — and never passes through `spawnBuildAgentInProject`, where every local build
  // spawn is recorded. Without a line here, "Start"/"Build It" on the Plan board would be a
  // delegation the founder can ask about and the concierge cannot find, which is exactly the
  // 2026-08-22 failure the ledger exists to close (see that module's header).
  //
  // ── A REUSED ORCHESTRATOR IS RECORDED TOO, AND THAT IS A DECISION ───────────────────────────
  // `prepareHandoff` has two branches: it adopts the build agent already bound to this epic, or it
  // creates one. The row is written on BOTH, deliberately. What the ledger records is the ACT OF
  // DELEGATING — "we handed this plan item to an agent" — not the act of creating a row, and that
  // act is equally true when the epic went back to the orchestrator that already had it. Recording
  // only fresh creations would make every RESUMED epic invisible to recall, and a resumed epic is
  // the likeliest thing to be asked about twice, because it is the work that has been going on
  // longest. The cost of the choice is two rows for one epic handed over twice; `dispatchRecall`
  // reads rows keyed by target, so those collapse onto the same agent rather than reading as two
  // separate delegations.
  //
  // `void`, never awaited: this function is synchronous and on the board's click path, for the same
  // reason `labelBead` and the advisor hook above it are fire-and-forget. `recordDispatch` cannot
  // throw or reject.
  void recordDispatch({
    targetId: agentId,
    channel: "plan",
    // The name at dispatch, read from the row `prepareHandoff` just settled — `null` for a fresh
    // orchestrator, which has no name until auto-naming catches up. The ledger treats a name as a
    // historical fact and joins to the LIVE one at read time, so a missing one costs nothing.
    nameAtDispatch:
      useProjectStore
        .getState()
        .projects.find((p) => p.id === args.projectId)
        ?.agents.find((a) => a.id === agentId)?.name ?? null,
    projectId: args.projectId,
    projectName:
      useProjectStore.getState().projects.find((p) => p.id === args.projectId)?.name ?? null,
    // The bead in hand IS the ask on this path: the board hands over an epic (or, in "task" mode, a
    // single bead), and the seed prompt is generated from it below. Naming the id is what makes the
    // row findable by the work rather than only by the agent.
    beads: [args.epicId],
    // ── THE BRIEF IS A SUMMARY, NOT THE SEED PROMPT, AND THAT IS DELIBERATE ────────────────────
    // `buildSeedPrompt` (below, in `seedDraft`) is mostly `beadsProtocol` — thirty lines of the same
    // boilerplate on every hand-off. Storing it would spend the row's 1,500-char budget on prose
    // identical across the whole ledger, which is worse than useless in an FTS index: it matches
    // every query and distinguishes nothing. What recall actually needs is the SUBJECT, because the
    // founder asks about "the inline preview work" and never about a bead id. So the row carries the
    // ids plus the EPIC GOAL — the one sentence in that prompt that says what this work is.
    brief: [
      `${args.mode ?? "epic"} ${args.epicId}`,
      args.prdPath ? `PRD ${args.prdPath}` : null,
      epicGoalLadder(args)?.text ?? null,
    ]
      .filter((x): x is string => x !== null)
      .join(" — "),
    // NO `mode`. The ledger's `mode` is the agent's PERMISSION mode ("plan" starts it researching
    // before it edits), which this path never sets — `SendToBuildArgs.mode` is a different axis
    // entirely ("epic" fans children out, "task" builds one bead), and it is recorded in the brief
    // above. Stamping one field with the other's vocabulary would make the row answer a question
    // nobody asked, wrongly.
    // `humanAuthored` is this function's existing answer to "did a PERSON trigger this handoff?" —
    // it defaults to true because every board click is one, and `conciergeTools/plans` is the caller
    // that passes false. Reusing it keeps one answer to that question rather than a second one that
    // can disagree with the goal-debt rule it already governs.
    by: args.humanAuthored === false ? "machine" : "human",
  });

  // No `requestComposeFocus`: the orchestrator arrives with a seeded prompt above, so there is
  // nothing for the user to type and the caret is not ours to take.
  //
  // ── `reveal: false` DROPS THE VIEW STEPS AND STILL RELAUNCHES ───────────────────────────────
  // A machine-driven handoff must not take the user's screen, but it MUST actually bring the agent
  // back — otherwise it binds the epic, seeds a prompt, reports success and relaunches nothing.
  // `runtimeStore.open` alone does NOT do that; `services/agentMount` owns the full rule and the
  // argument for it.
  //
  // THE ROW IS PRESENT BY CONSTRUCTION HERE, so this reports what it dispatched and cannot refuse:
  // `prepareHandoff` above either found an existing `Project.agents` row or called `addAgent`, which
  // inserted one. Passing a predicate that re-reads the store would be asking a question whose
  // answer this function just wrote — which is precisely how the old `MountRefusedError` branch
  // became unreachable code that three review rounds nonetheless reasoned about as a live guard.
  //
  // A synchronous caller gets a DISPATCH RECEIPT and nothing better is available to it. That is
  // acceptable here only because no click path reports "I restarted it" to anyone — the user is
  // looking at the pane and can see for themselves. It is NOT acceptable for the sweep.
  // Seed the orchestrator's first message with the epic + PRD + beads protocol, BEFORE the mount —
  // for the same reason `sendToBuildAwaited` states at its own call: on any branch that spawns fresh,
  // the brief is read DURING the mount (`AgentPane.prepare` → `briefForLaunch`), so attaching it
  // afterwards races the launch that is supposed to carry it. Ordering it here makes "the brief is
  // attached before anything can read it" true by construction rather than true because React
  // happens not to render inside a synchronous function.
  seedDraft(args, agentId);

  // LAND the user in it. "Start"/"Build It" are clicked FROM the Plan board, so `activeSpecial` is
  // "board" and the board owns the pane — this used to call `open()` alone, which mounts the pane
  // behind the board and changes nothing the user can see. On the reuse path it was worse still:
  // with an existing orchestrator `addAgent` never runs, so not even its default selection fired
  // and the handoff was completely invisible. landInAgent does all four steps (leave the board,
  // select, open, reveal the row) — see its header for why they travel together.
  //
  // ── AND THE FOUNDER'S CARET IS THE THIRD WAY TO REACH THE `reveal: false` BRANCH ────────────
  // `reveal: false` says "the CALLER did not earn the view"; a held attention says "the caller did,
  // but right now taking it would yank the founder out of a terminal he is typing in". Both want
  // the identical outcome — relaunch, don't move him — so they resolve to the identical branch
  // rather than to a second, subtly-different quiet path. It has to be `mountAgent` and not
  // `landInAgent`'s degraded `open`: this function REUSES an orchestrator that may be closed, and
  // `runtimeStore.open` alone does not bring one back (see the paragraph above).
  //
  // NOTE THE ORDER, which the merge with the brief-before-mount change made load-bearing: the seed
  // is attached ABOVE, unconditionally, so a held hand-off is quiet in the view and complete in
  // every other respect. Holding must never gate the seeding.
  //
  // GATED ON `attention`, and this function is the reason that field exists rather than a bare DOM
  // read. Three of its four callers are BUTTON HANDLERS (BoardView, and both paths in
  // useBeadBuildActions); only conciergeTools/plans is machine-driven. Declining a click would
  // reinstate the exact regression `landInAgent` was written to fix — "Build It" pressed, board
  // still up, nothing visibly changed. `buildOne` makes it worse still: it `await`s `claimBead`
  // first, a round trip against a single-writer store shared by every worktree, so the caret would
  // be sampled at an arbitrary later instant than the gesture.
  const held = args.attention === "auto" && args.reveal !== false && attentionHold() !== null;
  if (args.reveal !== false && !held) {
    landInAgent(args.projectId, agentId);
  } else {
    mounted(mountAgent(agentId, () => true));
  }

  return agentId;
}

/**
 * Hand the epic off, WAIT until the orchestrator is genuinely back, and DELIVER the instruction to
 * its terminal. Returns the build agent id.
 *
 * THE MACHINE PATH — `services/epicSweepRunner`, on a ten-minute timer. It differs from
 * {@link sendToBuild} in the only two ways that matter to a caller which spends a one-shot budget
 * and then tells a human what it did. Both were live defects, in different layers, and neither is
 * visible from the click path.
 *
 * ── 1. IT WAITS, SO WHAT IT REPORTS IS TRUE ──────────────────────────────────────────────────
 * `restartPane` returns a DISPATCH RECEIPT. `paneControl` says so outright: "`true` here means
 * DISPATCHED, not restarted … It is NOT fine for a caller that reports an outcome to a human."
 * Measured on v0.107.0, three agents restarted through the concierge all acked `{ok:true}` and were
 * all still `errored` on the next status read. This awaits the pane's own readiness verdict and
 * THROWS {@link MountRefusedError} on every non-success, so "I restarted your epic" is only ever
 * sent about a restart that happened.
 *
 * ── 2. IT DELIVERS THE SEED, WHICH THE RESUME PATH OTHERWISE SWALLOWS ────────────────────────
 * This is the defect that made the whole feature inert, and it hides behind a successful restart.
 * `restartPane` re-spawns a session that EXISTS, so the spawn resumes (`claude --resume`) — and on
 * a resume `briefForLaunch` returns `undefined` by design, because "the resumed conversation
 * already contains the mission". `appendPrompt` is store bookkeeping and writes nothing to a
 * terminal. So the pre-existing code path restarted a dead orchestrator, told it NOTHING, and left
 * the epic sitting exactly as it was — while reporting a successful handoff.
 *
 * The channel that actually reaches a terminal is the concierge dispatcher, which is what
 * `goalContinuationRunner` and `fleetWatch` use for the same job. So the seed goes through
 * `dispatchConciergeAnswer` under an `epic-restart` authority, and the RESULT of that dispatch is
 * checked — a refused or queued send is not a delivery, and this reports it as a failure rather
 * than assuming the send arrived.
 *
 * The seed is still written on the OTHER branch, because it is the right mechanism there: a freshly
 * created orchestrator has no session to resume, so `briefForLaunch` returns the brief `seedDraft`
 * ATTACHED and the spawn carries it into claude's argv. Both halves are needed; neither covers both
 * cases. (Read `seedDraft`: it is the attached brief, never the composer draft, that a launch reads —
 * believing otherwise is what made every fresh orchestrator start with an empty prompt.)
 */
export async function sendToBuildAwaited(
  args: SendToBuildArgs,
  opts: {
    /** Returns `undefined` for UNOBSERVED, which is a third answer and not a synonym for dead — see
     *  `mountAgentAwaited`. Typed to admit it so a caller cannot forget the case exists; the
     *  production default (`processAliveFor`) returns it routinely. */
    isLive?: (id: string) => boolean | undefined;
    readyTimeoutMs?: number;
    pollMs?: number;
    deliver?: (agentId: string, text: string, epicId: string) => Promise<boolean>;
  } = {},
): Promise<BuildHandoff> {
  const { agentId, reused } = prepareHandoff(args);

  // The SAME predicate the sweep gated on when it decided this agent was dead — injected for the
  // reason `agentMount` states: two copies could answer differently, and the pairing that matters
  // in production would then be untested by construction.
  const isLive =
    opts.isLive ??
    ((id: string) => {
      const rt = useRuntimeStore.getState();
      return processAliveFor(id, rt.status, new Set(rt.openAgentIds));
    });

  // ── THE GATE IS ONLY ASKED ABOUT A REUSED AGENT, AND THAT IS LOAD-BEARING ────────────────────
  // A brand-new id has no `runtimeStore.status` entry — `addAgent` created it moments ago and no
  // pane has ever mounted for it — so `processAliveFor` returns `undefined`, meaning UNOBSERVED.
  // `mountAgentAwaited` correctly treats unobserved as alive (a wrong "dead" tears down a live PTY),
  // and the two correct rules compose into a wrong one: the fresh agent reads `already-live`, so it
  // is never admitted, never opened, never spawned — and `mountedAwaited("already-live")` is true,
  // so the handoff is reported as a SUCCESS that started nothing at all.
  //
  // A freshly created agent is not alive; that is not an observation, it is a fact about having just
  // minted the id. So the gate is skipped rather than answered. This must NOT be expressed by
  // passing `() => false` from the test seam — that is precisely the reading production can never
  // produce, and a test that injects it asserts against code the app never runs.
  const liveGate = reused ? isLive : () => false;

  // Seed FIRST, and UNCONDITIONALLY. It has to be attached before the mount, because on any branch
  // that spawns fresh the brief is read during the mount (`AgentPane.prepare` → `briefForLaunch`) —
  // write it after and it arrives too late to be picked up.
  //
  // DO NOT narrow this to `if (!reused)`, even though the delivery below is narrowed that way. The
  // two conditions look like they should match and do not: `reused` means an agents ROW was bound
  // to this epic, which is NOT the same as a Claude SESSION existing. A row created by an earlier
  // handoff that the user never opened has no session, so mounting it spawns FRESH — and a fresh
  // spawn is exactly the case that reads the draft. Skipping the write there would hand that
  // orchestrator nothing at all, which is the same inert state this function exists to prevent.
  //
  // The cost of writing it on the resume path, where nothing reads it, is an unread draft sitting in
  // that agent's composer and a held brief nothing consumes. Both are cosmetic; the alternative is a
  // silent no-brief spawn. See `seedDraft` for why the held brief cannot double-deliver on a resume.
  seedDraft(args, agentId);

  const verdict = await mountAgentAwaited(agentId, () => true, liveGate, {
    readyTimeoutMs: opts.readyTimeoutMs,
    pollMs: opts.pollMs,
  });
  if (!mountedAwaited(verdict)) {
    throw new MountRefusedError(`could not relaunch agent ${agentId}: ${verdict}`, verdict);
  }

  // ── DELIVERY ────────────────────────────────────────────────────────────────────────────────
  // Only where the seed is otherwise swallowed. A brand-new orchestrator has no session to resume,
  // so `briefForLaunch` carries the ATTACHED brief into its spawn's argv and dispatching on top would
  // deliver the mission twice.
  //
  // `already-live` is included even though nothing was restarted — the agent is up and idle on a
  // stalled epic, which is exactly the case where telling it to resume is the entire point.
  //
  // The known imprecision, stated rather than hidden: a bound-but-never-opened agent is `reused`
  // yet spawns fresh, so it gets BOTH the drafted seed and this instruction. Harmless (the two
  // agree, and the second is three lines), and the safe direction — the alternative misclassifies
  // the far more common resume as fresh and delivers nothing at all. Distinguishing them would take
  // a session-exists probe that no store here holds.
  if (!reused) return { agentId, verdict };

  const deliver = opts.deliver ?? defaultDeliver;
  const delivered = await deliver(agentId, resumeInstruction(args), args.epicId);
  if (!delivered) {
    // NOT a silent success. The restart happened, so the agent is up — but the instruction did not
    // reach it, which leaves exactly the inert state this function exists to prevent. Reported as a
    // refusal so the sweep records a failure and does NOT tell the founder it handed the epic back.
    throw new MountRefusedError(
      `relaunched agent ${agentId} but could not deliver the epic instruction`,
      "undelivered",
    );
  }
  return { agentId, verdict };
}

/**
 * What a RESUMED orchestrator is told.
 *
 * Terse on purpose, and that is a decision rather than an economy: the agent is resuming its own
 * conversation, which already holds the epic, the PRD and the beads protocol from its first brief.
 * Re-sending `buildSeedPrompt` would spend thousands of tokens restating what is already in context
 * a few turns up. What it does NOT have is the one fact only the sweep knows — that time passed and
 * nothing moved — so that is what this says.
 */
export function resumeInstruction(args: SendToBuildArgs): string {
  const where = args.prdPath
    ? `Its plan is at ${args.prdPath}.`
    : `Run \`bash scripts/bead-brief.sh ${args.epicId}\` for the plan (${beadReadFallback(args.epicId)}).`;
  // BUILT FROM THE MARKER, never a literal that happens to match it. `agentOriginated` recognises
  // Sparkle's own sends by this opening; if the two drifted apart the detector would go silently
  // blind and this prose would start counting as the agent's own activity.
  return [
    `${EPIC_RESUME_PROMPT_MARKER}Resume epic ${args.epicId}.`,
    "",
    `${where} Its plan was written and then nothing moved on it, so you were restarted`,
    "automatically. Pick up the epic's ready child beads and continue the work — decompose them",
    "across isolated worker agents and integrate each worker's branch sequentially, as before.",
    "",
    `If the epic is genuinely blocked rather than stalled, say so and stop: \`bd comment ${args.epicId}\``,
    "with the reason is more useful than a retry.",
  ].join("\n");
}

/**
 * The production delivery seam: the concierge dispatcher, the same channel `goalContinuationRunner`
 * and `fleetWatch` use to reach a terminal.
 *
 * Returns whether the text will reach the agent. `ok` alone is not that fact — the dispatcher has
 * refusal paths that report `ok: false` and several that never deliver — so the accepting paths are
 * named explicitly and EVERYTHING else counts as undelivered. Fails closed, like the rest of this
 * seam.
 *
 * ── WHY `queued` COUNTS, when `goalContinuationRunner` treats it as undelivered ───────────────
 * A deliberate divergence, not an oversight, and it turns on the difference between the two
 * callers. `queued` means the agent's PTY is not up yet and the text is held until it reports ready.
 *
 * The auto-continue runner refuses it because it fires every ~45s against an agent that is supposed
 * to be ALREADY RUNNING: a queued send there means something is wrong, and the runner gets another
 * attempt in under a minute at no cost. Neither is true here. This caller has just RESTARTED the
 * PTY, so "not up yet" is the expected state rather than a symptom. Rejecting `queued` would report
 * such a restart as a failure even though it worked and the instruction is in the app's own
 * hand-off queue for it.
 *
 * ⚠️ AND `queued` REQUIRES A PANE THAT EXISTS. An earlier version of this comment claimed the
 * `opened` route made `queued` the only possible outcome; that was backwards, and the code was
 * wrong with it. `conciergeDispatch` decides its hold on `paneState(id) === "starting"`, so a pane
 * that has not registered at all — `"unmounted"`, which is exactly what route 2 leaves behind until
 * `Workspace` renders — does not queue. It is refused as `pty-gone`, and the epic loses its one-shot
 * budget to a delivery that was never attemptable. That is fixed in `mountAgentAwaited`, which now
 * waits for the pane to register before reporting `opened`, so by the time this runs there is a
 * pane for the queue to belong to.
 *
 * And the pessimistic direction is not free here: this caller spends a ONE-SHOT budget, so a false
 * failure costs the epic its only automatic restart AND tells the founder nothing.
 *
 * The case `queued` gets wrong — the PTY never comes up and the send expires — is not silent
 * either: no child bead moves, so the next sweep finds the epic still stalled with its budget spent
 * and ESCALATES it into the Blocked lane in front of the founder. That is the designed backstop,
 * one stall window later, which is strictly better than burning the restart now for nothing.
 */
async function defaultDeliver(agentId: string, text: string, epicId: string): Promise<boolean> {
  const r = await dispatchConciergeAnswer(agentId, text, {
    authority: { kind: "epic-restart", agentId, epicId },
  });
  // `picker-option` is not listed: a stalled orchestrator has no live picker by construction, and if
  // one somehow matched, this text would have been swallowed as a menu keystroke rather than read as
  // an instruction — which is a failure to deliver the instruction, whatever the dispatcher says.
  const delivered = r.ok && (r.path === "free-text" || r.path === "queued");
  if (!delivered) {
    log.warn("epics", "epic restart instruction was not delivered", {
      agent: agentId,
      epic: epicId,
      path: r.path,
      ok: r.ok,
    });
  } else if (r.path === "queued") {
    log.info("epics", "epic restart instruction queued for a PTY still coming up", {
      agent: agentId,
      epic: epicId,
    });
  }
  return delivered;
}
