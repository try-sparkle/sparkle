// WHAT GITHUB SAID ABOUT MERGE-READINESS, published where the concierge can read it.
//
// THE PROBLEM THIS SOLVES (bead `sparkle-mf501`, the founder's 2026-08-09 report). The concierge's
// "4 need merge in sparkle" line counts AGENTS whose committed work has not reached `main` — a git
// fact, derived in `engine/unmergedAttention` with no reference to GitHub at all. Whether any of
// that work can actually be merged is a GitHub fact, and it lived exclusively inside `OpenPrMenu`'s
// component state. So the sentence promising a merge and the data saying whether one was possible
// were in the same window, one component apart, and never spoke.
//
// A STORE RATHER THAN A PROP because the two are siblings, not relatives: `ConciergePrChip` mounts
// `OpenPrMenu` into the concierge header as a SLOT (`ConciergeColumnProps.prSlot`) precisely so the
// presentational column stays free of repo wiring, and threading readiness back up through that slot
// would undo the separation that extraction was for.
//
// ONE WRITER, AND THAT IS LOAD-BEARING. `OpenPrMenu` is the only component that probes GitHub for
// pull requests, and it is mounted exactly once (the concierge header). A second writer would make
// "did we look" ambiguous in the one direction this store must never be ambiguous in — see
// `probedProjectIds`.
//
// NO PERSISTENCE. Every field here is a claim about GitHub RIGHT NOW; a value restored from disk at
// launch would state a readiness nobody has checked since the last session, which is precisely the
// stale-confident-answer failure the `known`/`pending` distinction in `services/fleetPrs` exists to
// refuse. An unwritten store reads as "not probed", which is the correct pre-probe state.
import { create } from "zustand";

export interface PrReadinessState {
  /**
   * Projects whose pull-request probe has ANSWERED at least once. Readiness may be claimed only
   * about these.
   *
   * ABSENCE IS "WE DID NOT LOOK", NEVER "NOTHING IS READY". `gh` can be missing, unauthed, offline
   * or rate-limited, and the probe runs on a three-minute poll — so a consumer that reads an empty
   * `readyAgentIds` without checking this is asserting a confident zero on the strength of a
   * question that was never asked. That is the same defect as the false promise this store exists
   * to remove, pointed the other way, and it is why the two fields are separate rather than one map.
   */
  probedProjectIds: string[];
  /** Agents that own an open pull request whose `prMergeReadiness` tone is `ready` — i.e. one a
   *  click could genuinely merge. Flat across projects: an agent's PR may live in another repo. */
  readyAgentIds: string[];
  /** Replace the snapshot. Called by `OpenPrMenu` after every probe settles. */
  publishPrReadiness: (next: { probedProjectIds: string[]; readyAgentIds: string[] }) => void;
}

/** Order-insensitive equality over the two id lists — the guard that keeps a three-minute poll from
 *  re-rendering the concierge every time it re-confirms the same answer. The arrays are built by
 *  iterating a `Set`, so their ORDER is an implementation detail of insertion and must not count as
 *  a change; comparing sorted joins is what makes a re-publish of identical content a no-op. */
function sameSnapshot(
  a: Pick<PrReadinessState, "probedProjectIds" | "readyAgentIds">,
  b: { probedProjectIds: string[]; readyAgentIds: string[] },
): boolean {
  // `\u0000` AS THE ESCAPE, never a literal NUL in the source — `services/sourceIsText.test.ts`
  // fails the build on a raw one, because git then treats the whole file as BINARY and it gets no
  // diff and no review. The runtime string is identical. The separator itself is deliberate: no
  // project id or agent id can contain it, so two different lists cannot join to one key.
  const key = (xs: readonly string[]) => [...xs].sort().join("\u0000");
  return (
    key(a.probedProjectIds) === key(b.probedProjectIds) &&
    key(a.readyAgentIds) === key(b.readyAgentIds)
  );
}

export const usePrReadinessStore = create<PrReadinessState>((set, get) => ({
  probedProjectIds: [],
  readyAgentIds: [],
  publishPrReadiness: (next) => {
    // NO-OP WHEN NOTHING CHANGED. `OpenPrMenu` republishes on every poll tick and on every render
    // that rebuilds its groups; without this, each one would hand the concierge fresh array
    // identities and re-run the whole digest for an answer that did not move.
    if (sameSnapshot(get(), next)) return;
    set({ probedProjectIds: next.probedProjectIds, readyAgentIds: next.readyAgentIds });
  },
}));
