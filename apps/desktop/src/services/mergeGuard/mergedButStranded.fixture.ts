// ONE FIXTURE, PARSED BY BOTH SUITES — the classifier's, and each consumer's.
//
// The report is written in Rust (`worktree.rs::stranded_after_merge_report`) and read in
// TypeScript, which is the shape AGENTS.md warns about: two halves can be wrong the same way and
// both suites stay green while the feature is inert in production. A single fixture does not fix
// that on its own, but it does guarantee the three TS suites cannot drift from EACH OTHER — so a
// wording change breaks them together rather than leaving one quietly asserting a string nothing
// emits any more. `worktree.rs`'s own test pins the same leading token from the writing side.
//
// Kept as prose rather than reduced to the token: both consumers pass this exact text through to a
// reader, and a fixture that is only the token cannot catch a classifier matching it anywhere.

/** Rust's `stranded_after_merge_report(2580, "sparkle/agent-x", "aaaa1111", "bbbb2222", 2)`. */
export const STRANDED_REPORT =
  "MERGED-BUT-STRANDED: merge_pr #2580 SUCCEEDED — the pull request IS merged and the repository " +
  "DID move, so do not call merge_pr again — but it did not land all of `sparkle/agent-x`. The " +
  "merge commit's second parent is aaaa1111, while the pushed branch head is bbbb2222: 2 commits " +
  "were not merged. `gh` exited 0, so nothing else will tell you this (bead sparkle-a08oi0); the " +
  "usual cause is a push that raced the merge. Its branch may already be deleted, so read the gap " +
  "with `git log --oneline aaaa1111..bbbb2222` and open a NEW pull request for those commits.";
