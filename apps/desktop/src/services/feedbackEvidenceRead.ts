// "DID THIS AGENT ACTUALLY FILE ANY FEEDBACK?" — the one store-reading wrapper around the pure rule.
//
// `engine/retroEvidence.feedbackEvidence` is the rule; this supplies it the two store readings it
// needs. It lived as a private helper inside `components/AgentSidebar.tsx` until the concierge's
// `retire_agent` verb needed the same answer, and a second hand-written copy is precisely the shape
// of the original defect in this area: `countAgentFeedbackBeads`'s own header records that the
// contradiction it was written to remove was two surfaces disagreeing about this exact number. So
// there is one implementation, and the dialog and the concierge move together or neither does.
//
// ── IT NEVER SHELLS OUT, AND THAT IS DELIBERATE (bead sparkle-y2p4f) ─────────────────────────────
// Every caller is on a retire path that ends in an irreversible teardown, so this must not be able
// to block: every input is already in memory, there is no `bd` invocation and nothing to await. A
// retire path that hung waiting on the (routinely starved, shared, single-writer) beads store would
// be worse than one that was merely wrong.
//
// The cost of not blocking is that the answer can be MISSING, which is exactly why
// `FeedbackEvidence` is three-valued: a snapshot we could not get resolves to `unknown`, never to
// "this agent reported nothing". Only `absent` — a trustworthy read that found nothing — may ever
// license writing the permanent gap mark, and `mayRecordRetroGap` is what enforces that.
//
// `beadsPolledAt` — NOT `snapshot.loadedAt`. `loadedAt` records when the CONTENT last changed and
// deliberately stands still on a healthy-but-quiet backlog, so it cannot answer "is this data
// stale". `beadsPolledAt` is stamped only on a successful read, which is the freshness clock.
import { feedbackEvidence, type FeedbackEvidence } from "../engine/retroEvidence";
import { useBeadsStore, beadsPolledAt } from "../stores/beadsStore";

/** This agent's feedback-filing evidence, read from the in-memory beads snapshot. Never blocks. */
export function feedbackEvidenceFor(projectId: string, agentId: string): FeedbackEvidence {
  return feedbackEvidence({
    beads: useBeadsStore.getState().byProject[projectId]?.beads,
    polledAt: beadsPolledAt(projectId),
    agentId,
    now: Date.now(),
  });
}
