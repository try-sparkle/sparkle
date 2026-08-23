// DID THIS AGENT ACTUALLY REPORT? — the second source, and the one the retire dialog was blind to.
//
// ── WHY THIS EXISTS (bead sparkle-y2p4f) ─────────────────────────────────────────────────────────
// The retire confirm and the sidebar row read two DIFFERENT stores and contradicted each other on
// screen, in the same instant, for the same agent:
//
//   • the dialog read a `RetroReceipt` (`<app_data>/retro-receipts.json`) and said
//     "nothing has been recorded about what it learned"
//   • the row read BEADS labelled `agent:<id>` and showed "FEEDBACK 2"
//
// The founder caught it and his read was the correct one: the agent HAD reported. Nothing bridges
// the two stores — the real retro pipeline (`scripts/lib/retro-beads.sh`, via the merge hook or
// `file-retro-pain-point.sh`) writes beads ONLY and never writes a receipt.
//
// And the gap is TOTAL, not partial: there is no production writer of the `captured` receipt state
// at all (`services/retroReceipts.ts:recordRetroCaptured` has zero non-test callers). So
// `retroSettled()` is false for EVERY agent that ever filed a retro, and the dialog told 100% of
// them that nothing was recorded. 19 of the 29 override receipts on disk when this was written were
// against agents with 1–13 feedback beads apiece — permanent, false marks, in the one store the
// whole feature exists to make trustworthy.
//
// ── THE FIX IS A THIRD ANSWER, NOT A SECOND BOOLEAN ──────────────────────────────────────────────
// "No beads" and "could not read the beads" are different facts, and collapsing them is how the
// original bug happened. The beads store is shared, single-writer Dolt and is routinely starved
// (1.6 GB, 8 concurrent readers, single reads over 120s on the night this was filed), so "the
// snapshot is missing" is the NORMAL failure, not an edge. It must never render as an accusation.

/** The `Bead` surface this module needs. Structural on purpose: the engine stays free of the store
 *  so it can be tested without one, exactly like the rest of `engine/`. */
export interface LabelledBead {
  labels: readonly string[];
}

/**
 * What we know about whether this agent filed feedback.
 *
 * THE THIRD ARM IS THE POINT. `unknown` is what a starved or disabled beads store produces, and it
 * must be impossible to confuse with `none` — a dialog that says "nothing was recorded" over an
 * unreadable backlog is the original bug with a smaller window.
 */
export type FeedbackEvidence =
  /** At least one bead carries `agent:<id>`. This agent demonstrably reported. */
  | { kind: "reported"; count: number }
  /** The backlog was read successfully and recently, and it holds nothing from this agent. */
  | { kind: "none" }
  /** We cannot tell: beads are disabled, never loaded, or the last successful read is too old. */
  | { kind: "unknown" };

/**
 * How stale a successful beads read may be before a ZERO count stops being trustworthy.
 *
 * Deliberately generous relative to the 5s poll: this gate exists to catch a store that has stopped
 * answering, not to demand freshness. Under the starvation this was written for, `bd` reads were
 * exceeding 120s, so a threshold near the poll interval would report `unknown` constantly and bury
 * the honest `none` case that the gap note legitimately depends on.
 */
export const FEEDBACK_EVIDENCE_MAX_AGE_MS = 10 * 60_000;

/**
 * Read the feedback evidence for one agent out of an already-fetched beads snapshot.
 *
 * ── THIS NEVER SHELLS OUT, AND THAT IS THE WHOLE SAFETY ARGUMENT ─────────────────────────────────
 * Every input is a value the poller already put in memory. The retire dialog therefore CANNOT block
 * on the starved beads store — there is no `bd` invocation on this path and no promise to await. The
 * risk on this surface is the opposite one (asserting absence from data we never got), which is what
 * the `unknown` arm and the freshness gate below are for.
 *
 * ── STALENESS DOWNGRADES ONLY THE NEGATIVE ───────────────────────────────────────────────────────
 * A positive count is trusted no matter how old it is; a zero count is trusted only while fresh.
 * That asymmetry is deliberate and is the safety direction: beads on this path are only ever
 * created, so "I saw 3 of its beads ten minutes ago" is still proof it reported, while "I saw none
 * ten minutes ago" is no longer proof it didn't. The failure we are eliminating is the false
 * accusation, so every uncertainty resolves away from it.
 */
export function feedbackEvidence({
  beads,
  polledAt,
  agentId,
  now,
  maxAgeMs = FEEDBACK_EVIDENCE_MAX_AGE_MS,
}: {
  /** This project's snapshot, or `undefined` when beads are off / never loaded. */
  beads: readonly LabelledBead[] | undefined;
  /** `beadsStore.beadsPolledAt(projectId)` — stamped ONLY on a successful read, so a failing poller
   *  leaves it frozen and the gate below ages out. Never `ProjectSnapshot.loadedAt`, which tracks
   *  when the CONTENT last changed and stands still on a healthy but quiet backlog. */
  polledAt: number | undefined;
  agentId: string;
  now: number;
  maxAgeMs?: number;
}): FeedbackEvidence {
  // No snapshot at all — the `[tools].beads` off case and the never-polled case. Not an absence.
  if (beads === undefined) return { kind: "unknown" };

  const count = countAgentFeedbackBeads(beads, agentId);

  // Positive first, and BEFORE the freshness gate — see the asymmetry note above.
  if (count > 0) return { kind: "reported", count };

  // A zero we cannot vouch for is not a zero. `polledAt === undefined` means no read ever
  // completed, which can coexist with a non-undefined `beads` if a snapshot outlived a failing
  // poller, so it is checked here rather than being folded into the age arithmetic.
  if (polledAt === undefined) return { kind: "unknown" };
  if (now - polledAt > maxAgeMs) return { kind: "unknown" };

  return { kind: "none" };
}

/**
 * How many beads carry this agent's feedback label.
 *
 * THE SAME PREDICATE THE ROW'S PILL USES, and that is now a fact rather than an intention: this
 * commit's first version asserted it here while `components/AgentRow.tsx` kept its own inline
 * `beads.filter((b) => b.labels.includes(...))` (roborev). Two hand-written copies of the rule is
 * the SHAPE OF THE ORIGINAL DEFECT — the contradiction this module exists to remove was two
 * surfaces disagreeing about this exact number — so `AgentRow.feedbackCount` calls this, and a
 * change to the rule now moves the pill and the dialog together or neither.
 *
 * Counts the RAW list, not the bucketed board, so closed and auto-labelled beads still count: the
 * question is "did it report", not "is the report still open".
 */
export function countAgentFeedbackBeads(
  beads: readonly LabelledBead[],
  agentId: string,
): number {
  const label = agentFeedbackLabel(agentId);
  return beads.filter((b) => b.labels.includes(label)).length;
}

/**
 * THE label a bead carries when `agentId` filed it — the one spelling of the rule.
 *
 * Extracted so a caller that needs the count for MANY agents at once can invert the scan (count
 * every label once, then look each agent's up) WITHOUT writing a second `agent:` prefix test. The
 * header above explains why that matters here specifically: two hand-written copies of this
 * predicate disagreeing about one number is the exact defect this module exists to remove, and an
 * inverted copy would disagree in precisely the same way while looking nothing like a duplicate.
 * `components/AgentSidebar` reads it that way for the fleet's feedback pills.
 */
export function agentFeedbackLabel(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * The retirement standing of an agent — what the confirm dialog says, and whether retiring it
 * writes a gap note.
 *
 * FOUR ARMS, AND ONLY ONE OF THEM MAY ACCUSE. The old code had two (`receipt != null` or not) and
 * spent the negative arm on every agent in the fleet.
 */
export type RetroStanding =
  /** A receipt is on file. Unchanged behaviour — the dialog keys its lede on `receipt.state`. */
  | { kind: "settled" }
  /** No receipt, but the agent demonstrably filed feedback. NOT a gap; never accuse. */
  | { kind: "reported"; count: number }
  /** No receipt, and the backlog is unreadable. NOT a gap; we do not know. */
  | { kind: "unknown" }
  /** No receipt, and a trustworthy read found nothing. The ONLY state where "nothing has been
   *  recorded" is a true sentence, and the only one that may write a gap note. */
  | { kind: "absent" };

/**
 * Combine the receipt store and the beads store into the one answer the dialog renders.
 *
 * The receipt wins when present: it is the deliberate, human- or agent-authored record of the retro
 * STEP, and an `excused` receipt is a considered statement that no retro was filed, which bead
 * evidence should not silently overrule.
 */
export function retroStanding(
  receiptPresent: boolean,
  evidence: FeedbackEvidence,
): RetroStanding {
  if (receiptPresent) return { kind: "settled" };
  if (evidence.kind === "reported") return { kind: "reported", count: evidence.count };
  if (evidence.kind === "unknown") return { kind: "unknown" };
  return { kind: "absent" };
}

/**
 * May retiring this agent write an `overridden` "no retro was on file" receipt?
 *
 * ONLY `absent`. This single predicate is what stops the 19 false marks from becoming 20 — a gap
 * note is a permanent, undeletable accusation (there is no receipt delete path anywhere), so it is
 * written only from evidence that affirmatively supports it, never from the absence of evidence.
 */
export function mayRecordRetroGap(standing: RetroStanding): boolean {
  return standing.kind === "absent";
}
