// THE ADVISOR'S OUTPUT — what it found, how that text is held, and how it reaches the model that
// acts on it.
//
// ══ THE ADVISOR NEVER REWRITES A PLAN ═══════════════════════════════════════════════════════════
//
// It comments; the orchestrator decides. Nothing in this file mutates a plan, a bead body, or a task
// list — the findings are APPENDED to the orchestrator's opening brief and written to the bead as a
// durable audit note, and that is the whole delivery surface. A version of this that edited the plan
// would put a second, unreviewed author on the work with no record of which half came from where.
//
// ══ THE ONE DELIVERY CHANNEL THAT WORKS IS ARGV ═════════════════════════════════════════════════
//
// `sendToBuild.seedDraft` records the measurement: a store write alone DELIVERS NOTHING. Twelve
// orchestrators were created with an empty prompt because `briefForLaunch` reads `agentBrief`'s held
// map and nothing else, and the seed was only ever `appendPrompt`ed. So the findings block is folded
// into the seed prompt STRING before `attachBrief` sees it — riding the same argv the mission does —
// rather than dispatched, appended, or written anywhere a launch does not read.
//
// That constrains the shape of everything below: the block must be available SYNCHRONOUSLY at
// handoff, because `prepareHandoff`/`seedDraft` are on the click path and a board click cannot wait
// on a research child that takes minutes. Hence a held map (the same posture `agentBrief` takes) that
// an asynchronously-completing pass writes into, and a synchronous read at seed time.

/** How severe one finding is. The advisor's verdict is ADVISORY at every level — `high` triggers the
 *  single revision round at the decompose seam and nothing else; it never blocks a handoff. */
export type AdvisorSeverity = "high" | "medium" | "low";

/** Which of the three lenses produced a finding. Closed, because the lens set is the contract with
 *  the persona: a fourth lens has to be added in both places or `tsc` says so. */
export type AdvisorLens =
  /** Is the scope one agent can hold? */
  | "scope"
  /** Is the completion criterion actually checkable? (DEFERS to `packages/core/goalGate.ts`.) */
  | "goal"
  /** Does this collide with work already in flight? (Retrieval-fed; never guessed.) */
  | "collision";

export interface AdvisorFinding {
  lens: AdvisorLens;
  severity: AdvisorSeverity;
  /** One sentence stating what the advisor found. */
  summary: string;
  /** The evidence — a path, a command's output, a PR number. Empty when the advisor cited none,
   *  which is itself worth showing rather than hiding. */
  evidence?: string;
}

/** A completed advisor verdict for one epic. */
export interface AdvisorVerdict {
  /** The model that produced it — recorded on the bead, because "a second opinion" is only a fact
   *  if the second model is named. */
  model: string;
  /** The research task this came from, so the full transcript is findable later. */
  taskId: string;
  findings: AdvisorFinding[];
}

/** Does this verdict carry anything the planner should act on before beads are written? The trigger
 *  for the ONE revision round at the decompose seam — see `pass.ts` for why it is exactly one. */
export function hasHighFinding(v: AdvisorVerdict | null | undefined): boolean {
  return Boolean(v?.findings.some((f) => f.severity === "high"));
}

const LENS_TITLE: Record<AdvisorLens, string> = {
  scope: "Scope one agent can hold",
  goal: "Completion criterion is checkable",
  collision: "Collides with work in flight",
};

/**
 * Render the findings as the block appended to the orchestrator's opening brief.
 *
 * ══ AN EMPTY VERDICT PAINTS NOTHING — RETURNS "" ════════════════════════════════════════════════
 *
 * Not "the advisor found no problems", not a reassuring header with an empty list. This is the
 * failure contract inherited verbatim from `judge.rs`: **Err means NO VERDICT EXISTS** — never
 * "approved", never "rejected". A silent advisor that reads as approval is worse than no advisor,
 * because the orchestrator then carries a sentence saying the plan was checked when nothing checked
 * it. So a null verdict, a verdict with no findings, and a pass that could not run all render the
 * SAME empty string, and the brief goes out exactly as it would have without this feature.
 *
 * A verdict that genuinely ran and genuinely found nothing is recorded as such ON THE BEAD (the
 * durable audit channel), where it is attributable to a named model and a task id. It is not put in
 * front of the orchestrator, because "no findings" is not information it can act on.
 */
export function renderFindingsBlock(verdict: AdvisorVerdict | null | undefined): string {
  if (!verdict || verdict.findings.length === 0) return "";
  const order: AdvisorSeverity[] = ["high", "medium", "low"];
  const sorted = [...verdict.findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  const lines = [
    "",
    "── ADVISOR FINDINGS ──────────────────────────────────────────────────────────────────────",
    `A second model (${verdict.model}) reviewed this plan before you were handed it. These are`,
    "ADVISORY: nothing here blocks you, the advisor never rewrote the plan, and YOU decide what to",
    "act on. Its leverage is context you do not have — it can see the rest of the fleet's in-flight",
    "work, where you can see one plan.",
    "",
  ];
  for (const f of sorted) {
    lines.push(`[${f.severity.toUpperCase()}] ${LENS_TITLE[f.lens]}: ${f.summary}`);
    if (f.evidence?.trim()) lines.push(`         evidence: ${f.evidence.trim()}`);
  }
  lines.push("");
  lines.push(`(advisor research task ${verdict.taskId})`);
  lines.push("──────────────────────────────────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

/**
 * Fold the findings into a seed prompt. Returns the prompt UNCHANGED when there is nothing to say —
 * which is the ordinary case on a first handoff, and every case where the pass could not run.
 */
export function appendFindingsToBrief(
  seed: string,
  verdict: AdvisorVerdict | null | undefined,
): string {
  const block = renderFindingsBlock(verdict);
  return block ? `${seed}\n${block}` : seed;
}

/** Render the durable bead comment for a COMPLETED pass: the model used, the verdict, the findings.
 *  This is the one place "the advisor ran and found nothing" is stated, and it is stated to the bead
 *  rather than to the orchestrator — see {@link renderFindingsBlock}. */
export function renderAuditNote(verdict: AdvisorVerdict): string {
  const head = [
    "advisor: reviewed",
    `model: ${verdict.model}`,
    `research task: ${verdict.taskId}`,
  ];
  if (verdict.findings.length === 0) {
    head.push("verdict: ran, no findings raised");
    return head.join("\n");
  }
  head.push(`verdict: ${verdict.findings.length} finding(s)`);
  for (const f of verdict.findings) {
    head.push(`  [${f.severity}] ${f.lens}: ${f.summary}`);
    if (f.evidence?.trim()) head.push(`      evidence: ${f.evidence.trim()}`);
  }
  return head.join("\n");
}

/** Render the durable bead comment for a pass that did NOT run. Names why, and says plainly that no
 *  verdict exists — so a reader three days later cannot mistake the absence for an approval. */
export function renderSkipNote(reason: string): string {
  return [
    "advisor: skipped",
    `reason: ${reason}`,
    "NO VERDICT EXISTS for this plan — this is not an approval, and nothing about the plan was",
    "checked by a second model. The handoff proceeded unchanged.",
  ].join("\n");
}

// ── THE HELD VERDICTS ──────────────────────────────────────────────────────────────────────────
//
// Module-level and NOT persisted, matching `agentBrief` and `pendingSends`: this is a hand-off
// across a dispatch, not a durable outbox. The DURABLE record is the bead comment; this map only has
// to survive between "the research child answered" and "the next handoff seeds a brief". An app
// restart legitimately starts empty — the pass re-dispatches and the bead still carries every
// earlier verdict.

const verdicts = new Map<string, AdvisorVerdict>();

/** Record a completed verdict for an epic, replacing any earlier one (a re-run supersedes). */
export function holdVerdict(epicId: string, verdict: AdvisorVerdict): void {
  verdicts.set(epicId, verdict);
  // A NEW verdict is deliverable again on every channel. Without this line a re-run's findings would
  // be suppressed by the previous run's delivery marks — the consumption below is meant to stop the
  // SAME verdict repeating, never to stop a fresh one arriving.
  for (const channel of CHANNELS) delivered.delete(key(epicId, channel));
}

/** The consumers of a held verdict. Each takes it AT MOST ONCE, independently of the other. */
export type VerdictChannel = "seed" | "revision";
const CHANNELS: readonly VerdictChannel[] = ["seed", "revision"];

const delivered = new Set<string>();
const key = (epicId: string, channel: VerdictChannel) => `${epicId}\u0000${channel}`;

/**
 * Take this epic's verdict FOR ONE CHANNEL, or null if that channel already had it.
 *
 * ══ WHY A VERDICT IS CONSUMED RATHER THAN JUST READ ═════════════════════════════════════════════
 *
 * `heldVerdict` is a plain read, and a plain read is wrong for both consumers because neither runs
 * exactly once. `prepareHandoff` is reached from the board's Start and Build It buttons, the
 * concierge's `promote_plan_to_build`, and the sweep's `sendToBuildAwaited` — so one epic is handed
 * off repeatedly, and a plain read re-injects the SAME findings block into every later seed, long
 * after the orchestrator has acted on it. The decompose seam is worse than untidy: a sweep retry
 * after a cleared `decompose-failed` badge would spend ANOTHER planner call re-litigating findings a
 * previous round already addressed, so the documented "exactly ONE revision round" bound would hold
 * only within a single `decomposeEpic` call rather than per verdict.
 *
 * The two channels are tracked separately on purpose: the seed and the revision round are different
 * consumers with different jobs, and one taking the verdict must not blind the other.
 *
 * The verdict itself is KEPT, not deleted — `advisor:reviewed` and the bead's audit note describe a
 * review that happened, and the record of it should not evaporate because a brief consumed it.
 */
export function consumeVerdict(epicId: string, channel: VerdictChannel): AdvisorVerdict | null {
  const v = verdicts.get(epicId);
  if (!v) return null;
  const k = key(epicId, channel);
  if (delivered.has(k)) return null;
  delivered.add(k);
  return v;
}

/** The verdict held for this epic, or null. SYNCHRONOUS by design — see the module header: the seed
 *  path is a click handler and cannot await. */
export function heldVerdict(epicId: string): AdvisorVerdict | null {
  return verdicts.get(epicId) ?? null;
}

/** Test seam: forget every held verdict. */
export function resetHeldVerdicts(): void {
  verdicts.clear();
  delivered.clear();
}
