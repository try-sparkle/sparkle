// nudgeLoopCalm — a row Sparkle has been pinging into silence is not a row asking you a question.
//
// THE REPORT (bead sparkle-hpbkw). The founder, 2026-08-09: *"Why are agents like @Preview Work In A
// Browser and @Typing Never Wedges red dots? they don't seem to be blocked by me"*.
//
// Agent 6d644864 read status `waiting`, needsYou TRUE, goal `met` — having swallowed FOUR of
// Sparkle's own automated pings with nothing to show for any of them. The app nudged it, the nudge
// moved nothing, the app nudged again, and the wedge that produced was then reported to him as
// though he were the blocker. His instruction, verbatim: *"an automated ping that loops should be
// detected and reported as a NUDGE FAILURE, never as 'needs you'."*
//
// `engine/agentThrash` now DETECTS that (the `nudge-loop` verdict). This module is the other half —
// making the row stop asking — and it is deliberately the SMALLEST thing that does so.
//
// ── WHY THIS IS NARROW, AND WHAT THE WIDER RULE WOULD COST ──────────────────────────────────────
// Asked what red should mean in general, the founder chose the strict rule: *only a gesture from YOU
// clears it*, i.e. `needsYou === false ⇒ never red`. That rule is coherent and it would subsume this
// module — but implementing it is a REDESIGN, not a fix, and the evidence is concrete: wiring it
// into `composeRollup` turned SEVEN pinned expectations red, including
// `publishedRollupAgreement.test.ts`'s stated (not derived) *"head in motion + WAITING worker still
// asks"* — a folded head whose worker is sitting on a real question. Silencing that is the failure
// Sparkle's standing rule exists to prevent, and it is not a decision this module may take on its
// own. It is written up as an open question rather than smuggled in here.
//
// So this covers exactly the measured case and nothing else. Everything it does is gated on positive
// evidence from `agentThrash` that OUR OWN pings have been going nowhere — never on an inference
// about what a quiet row probably means.
import { bandOfStatus } from "./buildSections";
import { type StatusMap } from "./attention";
import { LAPSED_STATUS } from "./stallEscalation";
import type { ThrashReport } from "./agentThrash";
import type { AgentTabStatus } from "../types";

/**
 * The two reds a nudge loop may overrule, and the line is drawn on how each was DERIVED.
 *
 * `waiting` and `blocked` are the INFERRED reds — a prose heuristic, a followup judge, a silence
 * timer. Those are the two a nudge loop is genuine counter-evidence against: if the screen really
 * held something the founder could answer, the ladder's `blocked-on-human` stand-down
 * (`nudge_ladder.rs`, `Standdown::AwaitHuman`) would have raised a Founder escalation instead of
 * pinging into silence three more times.
 *
 * `approval`, `questions` and `errored` are NOT here and must not be added. The first two are
 * STRUCTURAL — Claude Code renders a specific bordered ❯ menu and the classifier matches it, so they
 * are observations rather than guesses, and a loop is not licence to silence a prompt somebody is
 * actually sitting on. `errored` means the agent crashed, and restarting it IS his gesture.
 *
 * ⚠️ THE ARGUMENT ABOVE LEANED ON THE LADDER BEHAVING, AND IT IS NOW CHECKED (2026-08-18). This
 * paragraph used to end "the escalation level lives in Rust and is not published to the frontend
 * today. Plumbing it through and gating on it directly is the durable fix." It has been plumbed
 * through — `services/authRecovery` publishes the flag, `engine/humanBlock` reads it, and
 * `agentStall` raises a `blocked-on-human` cause from it — so the `humanBlocked` parameter on
 * {@link isNudgeLoopCalmed} is that durable fix, and the reasoning above is no longer load-bearing
 * for the case it names.
 *
 * ⚠️ WITHOUT THAT PARAMETER THIS RULE SILENTLY UNDID THE WHOLE `blocked-on-human` RED (roborev
 * 65357), and on the SAME population rather than an overlapping one. `agentThrash` raises
 * `nudge-loop` at three nudge-opened turns that ran no tool — which is exactly what an agent does
 * when it ANSWERS the ladder's question in prose. So the flag is *produced by* the same nudging that
 * produces the verdict: every row the new red was written for arrived here carrying both, and
 * `blocked` is in this set, so it was demoted straight back to amber. The founder's original
 * symptom — a row saying blocked-on-human while drawing amber — reappeared one layer further down,
 * with the escalation raised, read, and then discarded by the rule that assumed it had not been.
 *
 * The set itself is unchanged: `blocked` is still demotable when the red was INFERRED, which is
 * everything this module was commissioned for.
 */
const NUDGE_DEMOTABLE: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["waiting", "blocked"]);

/** Should this row stop asking, given what we know about our own pings to it? Exported so the rule
 *  has ONE spelling — a caller or a test that re-stated it would be a second copy of the taxonomy,
 *  and a second copy of this taxonomy is what has drifted twice already (see the `blocked` and
 *  `unmerged` notes in packages/ui/tokens.ts).
 *
 *  `humanBlocked` is the durable fix the ⚠️ on {@link NUDGE_DEMOTABLE} asked for — see it for why an
 *  answered ladder question is the one thing that must survive this demotion. */
export function isNudgeLoopCalmed(
  status: AgentTabStatus | undefined,
  thrash: ThrashReport | undefined,
  humanBlocked = false,
): boolean {
  if (status === undefined) return false;
  // THE AGENT ANSWERED. Everything below is reasoning about what a SILENT row probably means; this
  // is the one case where it spoke, so the inference has nothing left to do (roborev 65357).
  if (humanBlocked) return false;
  if (thrash?.verdict !== "nudge-loop") return false;
  return NUDGE_DEMOTABLE.has(status);
}

/**
 * Demote every row whose red is our own nudge loop, to the amber `lapsed` ("Unfinished, not yours").
 *
 * Pure, and in the same shape as every other overlay: returns the SAME reference when nothing
 * changes (no render churn) and never mutates the input. Composed LAST, so it sees the status that
 * would actually be painted.
 *
 * AMBER IS NOT GRAY, and that is the point rather than a compromise. `lapsed` leaves the calm tier,
 * keeps its dot and its chip, and stays filterable — the row is still there and still says something
 * is unfinished. What it no longer does is claim the founder is the one holding it up.
 */
export function withNudgeLoopCalm<T extends { id: string }>(
  agents: readonly T[],
  published: StatusMap,
  thrashOf: (id: string) => ThrashReport | undefined,
  /** Did the agent itself answer that a PERSON is blocking it?
   *
   *  ⚠️ REQUIRED, NOT DEFAULTED, AND THAT IS THE WHOLE GUARD (roborev 65373). It defaulted to
   *  `() => false` — which is exactly the demoting behaviour this parameter exists to prevent —
   *  while every test injected its own predicate, so the one line supplying the real value was
   *  covered by nothing: deleting it left the suite green and sent the founder's row back to amber.
   *  That is the `sparkle-lgbwf` defaulted-seam shape verbatim. Required makes a dropped argument a
   *  TYPECHECK failure instead of a silent behaviour revert — which is also how the second
   *  production caller (`useAttentionNotifications`) was found to be missing it. */
  humanBlockedOf: (id: string) => boolean,
): StatusMap {
  let out: StatusMap | null = null;
  const ensure = (): StatusMap => (out ??= { ...published });
  for (const a of agents) {
    const p = published[a.id];
    // Nothing published for this agent: there is no red to demote, and writing one here would make
    // this a PRODUCER of state rather than a filter on it.
    if (p === undefined) continue;
    if (bandOfStatus(p) !== "needs_you") continue;
    if (!isNudgeLoopCalmed(p, thrashOf(a.id), humanBlockedOf(a.id))) continue;
    ensure()[a.id] = LAPSED_STATUS;
  }
  return out ?? published;
}
