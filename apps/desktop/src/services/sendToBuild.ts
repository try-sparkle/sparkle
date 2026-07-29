// "Send to Build" handoff (bead sparkle-hiju.8): hand a beads epic + its PRD off to a Build agent
// (the orchestrator). ONE ORCHESTRATOR PER EPIC (bead sparkle-ctgd): reuses the build agent already
// bound to THIS epic if there is one, else creates a fresh one; opens it (mounts the pane / drives
// the PTY launch); and seeds it with a first prompt that points at the epic + PRD and tells it to
// execute the epic's children following the beads protocol.
import { useProjectStore } from "../stores/projectStore";
import { beadsProtocol } from "./buildAgent";
import { landInAgent } from "./landInAgent";
import { localAgentCapacity, atCapacitySentence } from "./agentCapacity";

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
}

/** Build the orchestrator's seed prompt. For an epic: point at the spec (the PRD when there is one,
 *  else the epic bead's own description) and tell it to fan the epic's children out across workers.
 *  For a single task: tell it to build THAT one bead on one isolated worker branch — no fan-out.
 *  Both keep the beads protocol addendum so the work graph stays in sync. */
function buildSeedPrompt(args: SendToBuildArgs): string {
  if (args.mode === "task") {
    const spec = args.prdPath
      ? `read the PRD at ${args.prdPath} for surrounding context, then`
      : "then";
    return [
      `Build bead ${args.epicId} (a single task).`,
      "",
      `Run \`bd show ${args.epicId}\` to read it, ${spec} implement it on ONE isolated worker`,
      "branch, verify it, and integrate that branch. Do not fan out into children — this is a single",
      "unit of work, not an epic.",
      "",
      "Follow the beads protocol below to keep the work graph in sync as you go:",
      "",
      beadsProtocol({ epicId: args.epicId }),
    ].join("\n");
  }
  const spec = args.prdPath
    ? `First, read the PRD at ${args.prdPath} to understand the goal, constraints, and acceptance`
    : `First, run \`bd show ${args.epicId}\` and read the epic's description for the goal and`;
  return [
    `Build epic ${args.epicId}.`,
    "",
    spec,
    "criteria. Then execute the epic's child tasks: decompose them across isolated worker agents,",
    "integrating each worker's branch into your build branch sequentially.",
    "",
    "Follow the beads protocol below to keep the work graph in sync as you go:",
    "",
    beadsProtocol({ epicId: args.epicId }),
  ].join("\n");
}

/** Hand the epic off to the project's Build agent. Returns the build agent id. */
export function sendToBuild(args: SendToBuildArgs): string {
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

  // LAND the user in it. "Start"/"Build It" are clicked FROM the Plan board, so `activeSpecial` is
  // "board" and the board owns the pane — this used to call `open()` alone, which mounts the pane
  // behind the board and changes nothing the user can see. On the reuse path it was worse still:
  // with an existing orchestrator `addAgent` never runs, so not even its default selection fired
  // and the handoff was completely invisible. landInAgent does all four steps (leave the board,
  // select, open, reveal the row) — see its header for why they travel together.
  //
  // No `requestComposeFocus`: the orchestrator arrives with a seeded prompt below, so there is
  // nothing for the user to type and the caret is not ours to take.
  landInAgent(args.projectId, agentId);

  // Seed the orchestrator's first message with the epic + PRD + beads protocol.
  useProjectStore.getState().appendPrompt(args.projectId, agentId, buildSeedPrompt(args));

  return agentId;
}
