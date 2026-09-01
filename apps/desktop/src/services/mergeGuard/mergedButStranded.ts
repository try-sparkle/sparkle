// THE ONE `Err` FROM RUST'S `merge_pr` THAT MEANS THE REPOSITORY *DID* MOVE.
//
// ── THE INVARIANT THIS FILE PROTECTS ───────────────────────────────────────────────────────────
// Every other error `merge_pr` can return is a REFUSAL: a gate declined, `gh` never ran, nothing
// merged, the repository is exactly where it was. Every consumer of that channel is written on that
// invariant and none can hold a third state on its own.
//
// THERE ARE **THREE** OF THEM, AND THIS LIST IS CLOSED — so it has to be right. The first version
// of this header named two and called them "both consumers"; the third was reading the report as an
// ordinary failure the whole time, and an auditor checking the contract never opened the file the
// list omitted (roborev 72459). A wrong closed list is worse than no list at all. If a fourth
// consumer appears, it belongs here and in `worktree.rs`'s header above
// `stranded_after_merge_report`.
//
//   • `conciergeTools/workflow.ts` buckets prose it does not recognise as `failed(op,
//     "unknown-error", msg)` — the bucket its own comment calls "a message a model retries
//     verbatim". So an unclassified post-merge fact invites the concierge to RE-MERGE a pull
//     request that is already merged. It now returns `ok(...)` with a `strandedWarning`.
//   • `components/OpenPrMenu.tsx` reaches `merged.push(prKey)` only on the success path, so the
//     row's probe-refusal ledger is never cleared and `humanizeMergeError` renders the text as a
//     merge failure. It now records the row as MERGED and still shows the report.
//   • `integration_assistant.rs::integration_merge` — a RUST consumer, which is why it survived two
//     TypeScript-side sweeps. A bare `?` there built no `MergeOutcome` at all, so a merge that
//     landed was recorded with `landed: false`, the ancestry proof and cleanup never ran, and the
//     entry stayed in `nextActionable`'s queue offering a second Merge click against an
//     already-merged PR. Its matcher is `worktree.rs::is_merged_but_stranded_report`, which applies
//     this file's rule character for character; the token below is the wire between them.
//
// `merge_landing_gate` (worktree.rs) is the exception: it runs AFTER the irreversible half and
// reports a merge that SUCCEEDED while leaving commits on the branch that landed nowhere (bead
// sparkle-a08oi0, roborev 72228). Rust leads that report with a `MERGED-BUT-STRANDED:` token
// precisely so this side can tell it apart from a refusal, and the detection is the valuable half —
// the whole bead is that `gh` exited 0 and nothing else was ever going to say so.
//
// ── WHY THIS ONE IS STRICT WHERE THE KNIGHTWATCH CLASSIFIERS ARE FORGIVING ─────────────────────
// `isKnightwatchRefusal` and `isBaseBranchRefusal` are allowed to be loose because BOTH of their
// error directions are cheap: everything they classify is a refusal, so a miss costs an affordance
// and a false hit costs an ignored override. The asymmetry here is the opposite and it is severe.
// A FALSE POSITIVE REPORTS A MERGE THAT NEVER HAPPENED AS ONE THAT DID — the caller stops
// retrying, the UI clears the row, and a PR that is genuinely stuck on a conflict looks landed.
// A false negative merely returns today's behaviour. So this matches the LEADING token and nothing
// else: no substring search, no synonym, no "contains SUCCEEDED".

/** The token Rust puts at the head of `stranded_after_merge_report`. Changing it is a wire break. */
export const MERGED_BUT_STRANDED_TOKEN = "MERGED-BUT-STRANDED:";

/**
 * Is `message` Rust's post-merge stranded-work report — i.e. did the merge SUCCEED?
 *
 * Anchored at the start of the trimmed message. An error that merely quotes or forwards the report
 * somewhere inside itself is NOT this: the token has to be the thing the message leads with, the
 * way Rust emits it. See the header for why this direction is not allowed to be generous.
 */
export function isMergedButStrandedReport(message: string): boolean {
  return (message || "").trimStart().startsWith(MERGED_BUT_STRANDED_TOKEN);
}
