// WHY A STALE CHECKOUT NEEDS A DIAGNOSIS AND NOT JUST A NUMBER (bead sparkle-7h01z).
//
// The tab badge already says `⚠ 1,935` — measured, and behind. That is the whole of what it knows,
// and it is not enough to act on: the ONE thing a person wants at that moment is "make it not be
// stale", and whether that is possible depends on facts the badge never asked about. A clean
// checkout sitting on the default branch is a `git merge --ff-only` away from current. A checkout
// with local edits is the same command with a real chance of refusal. A checkout parked on a
// feature branch needs a checkout first. And a linked worktree whose branch is held by ANOTHER
// worktree cannot be moved at all, from here or ever, by any button this app could draw.
//
// So the backend answers the diagnosis question, and this module is a thin wrapper over it —
// deliberately shaped like `services/openPrs.ts`: `invoke` calls and types, no store, no derived
// state. The one rule that matters at this seam:
//
//   `cause` IS THE BACKEND'S SENTENCE AND IS RENDERED VERBATIM.
//
// Not a code the UI switches on to pick wording. The backend is the only layer that knows which
// worktree holds the branch, how many files are dirty, and what the base resolved to — so it is the
// only layer that can write a true sentence about it. Re-deriving the wording in TS means two
// descriptions of one fact that drift the first time either side changes, and the one on screen is
// the one that goes wrong. `remedy` decides WHICH CONTROL (if any) to draw; `cause` decides what is
// SAID. Those are the only two jobs these fields have.
import { invoke } from "@tauri-apps/api/core";

/**
 * What can be DONE about a stale checkout — the field that decides which control the panel draws.
 *
 * - `none` — nothing to do (not stale, or already current).
 * - `fast-forward` — clean tree, on the default branch, a strict ancestor of the base. `git merge
 *   --ff-only` cannot lose anything here. It is NOT the only automatic shape, though it reads that
 *   way in older comments: `fast-forward-dirty` with an empty and KNOWN blocking set is automatic
 *   too, for the same reason — see the next bullet, and branch on
 *   {@link StaleDiagnosis.autoSafe} rather than on the remedy kind.
 * - `fast-forward-dirty` — the same fast-forward, but with uncommitted changes in the tree. Offered
 *   with a warning naming the files, because git may still refuse it and the person should know
 *   what is at stake before pressing. NOTE this does NOT imply `autoSafe: false` any more: dirt the
 *   fast-forward would not touch blocks nothing, so a `fast-forward-dirty` with an empty
 *   {@link StaleDiagnosis.blockingPaths} is still automatic. `autoSafe` is the field to branch on,
 *   never the remedy kind.
 * - `blocked-detached` — HEAD is on no branch. NO BUTTON, deliberately: the fast-forwardability we
 *   measured was against the DETACHED head, so a "check out the branch, then fast-forward" action
 *   would move a commit the check never covered — and a diverged local branch would let the
 *   checkout succeed (claiming the branch away from every other worktree) before the fast-forward
 *   failed. The cause names the manual step instead. See `repo_freshness.rs` arm 6b.
 * - `blocked-held-elsewhere` — a linked worktree whose branch is checked out in a DIFFERENT
 *   worktree. Git allows a branch in exactly one worktree, so this is not a transient condition and
 *   there is no button. See the panel for why offering one anyway would be worse than nothing.
 * - `blocked-diverged` — the checkout has commits the base does not, so no fast-forward exists and
 *   any automatic move would be a merge or a rebase decision that is not this app's to make.
 * - `unknown` — could not work it out. Renders the cause and no control, on the same fail-closed
 *   rule the badge itself follows: never offer a confident action over an answer we do not have.
 */
export type StaleRemedy =
  | "none"
  | "fast-forward"
  | "fast-forward-dirty"
  | "blocked-detached"
  | "blocked-held-elsewhere"
  | "blocked-diverged"
  | "unknown";

/** Everything the panel needs about ONE checkout. Mirrors the Rust `StaleDiagnosis` (camelCase). */
export interface StaleDiagnosis {
  /** Commits this checkout is behind `base`. */
  behind: number;
  /** What it is behind, e.g. `origin/main`. */
  base: string;
  /** The branch this checkout is actually on (empty when detached). */
  headBranch: string;
  /** The repository's default branch, named in the `blocked-detached` cause sentence. */
  defaultBranch: string;
  /** HEAD is not on a branch at all. */
  detached: boolean;
  /** This root is a linked worktree rather than the main checkout. */
  linkedWorktree: boolean;
  /** The worktree path holding `headBranch`, when another one does; empty otherwise. */
  heldBy: string;
  /** How many files have uncommitted changes. */
  dirtyCount: number;
  /** A sample of those paths — enough to recognise what is at risk, not the whole list. */
  dirtySample: string[];
  /**
   * THE PATHS THAT WOULD ACTUALLY STOP THE FAST-FORWARD — dirty AND changed between HEAD and base.
   *
   * `dirtyCount > 0` is not a reason to refuse: git declines a fast-forward only over paths it
   * would itself touch. Empty (with {@link blockersKnown}) means `merge --ff-only` provably cannot
   * refuse. This is what an escalation names, because "dirty tree" is not something anyone can act
   * on — measured on the founder's shared checkout, where one of five dirty entries was a real
   * blocker and the other four had been declining a safe merge every 60s for ten days
   * (bead sparkle-v38y1n).
   */
  blockingPaths: string[];
  /** Whether {@link blockingPaths} could be computed at all. False means WE DO NOT KNOW — never
   *  "there are none". An empty list under `blockersKnown: false` is fail-closed, not a green light. */
  blockersKnown: boolean;
  /** Whether a `--ff-only` merge would succeed on the tree as it stands. */
  canFastForward: boolean;
  /** Which control to draw. See {@link StaleRemedy}. */
  remedy: StaleRemedy;
  /**
   * A COMPLETE SENTENCE explaining the situation, written by the backend.
   *
   * Rendered verbatim. Never re-derived, never templated over, never switched on — see the module
   * header for why the only layer that can write a true sentence about a checkout is the one that
   * inspected it.
   */
  cause: string;
  /**
   * May this be fixed with NO CLICK AT ALL?
   *
   * True only for the provably-lossless shape: on the default branch, a strict ancestor of the
   * base, and with NO {@link blockingPaths} — i.e. no dirt the fast-forward would actually touch.
   * The founder's ruling is that automation is allowed exactly where it cannot destroy anything and
   * nowhere else, and "cannot destroy anything" is a question about collisions, not about whether
   * the tree is pristine. This stays a SEPARATE field from `remedy` rather than being inferred from
   * it, because the same `fast-forward-dirty` verdict can be automatic or not depending on where
   * the dirt sits.
   */
  autoSafe: boolean;
  /**
   * The diagnosis could not be made. Fail-closed exactly like `RootStaleness.unknown`: this is never
   * "nothing is wrong", it is "we could not look", and it draws no action.
   */
  unknown: boolean;
}

/** What came of trying a remedy. `reason` is the backend's own sentence — including git's refusal
 *  text when git refused — and is shown verbatim beside the row that asked for it. */
export interface RemedyOutcome {
  ok: boolean;
  /** Why it failed, or what it did. Rendered verbatim; never re-worded here. */
  reason: string;
  /** What was actually attempted, e.g. `merge --ff-only`. */
  action: string;
  beforeBehind: number;
  afterBehind: number;
}

/** Diagnose one checkout. Rejects on an IPC failure; an undiagnosable tree is a SUCCESSFUL answer
 *  with `unknown: true`, so callers distinguish "could not ask" from "asked, and don't know". */
export function diagnoseStale(root: string): Promise<StaleDiagnosis> {
  return invoke<StaleDiagnosis>("repo_stale_diagnose", { root });
}

/**
 * One in-flight remedy per checkout, PROCESS-WIDE.
 *
 * There are two independent callers — the staleness poll's unattended `autoSafe` fast-forward and
 * the panel's click — and neither can see the other's guard. Without this, pressing "Fast-forward"
 * while the 60s poll is mid-flight on the same root runs two concurrent `git merge --ff-only` in
 * one checkout: the second dies on `index.lock`, or lands "already current" as a red failure, and
 * either way the user is shown a scary refusal for a remedy that actually worked (roborev 59437).
 *
 * A Map of the in-flight promise rather than a Set of roots, so the late caller AWAITS the winner's
 * real outcome instead of being told nothing happened — the two callers want the same answer, and
 * a silent skip would leave the panel's row spinning forever.
 */
const inFlight = new Map<string, { unattended: boolean; p: Promise<RemedyOutcome> }>();

/** Apply whatever remedy the diagnosis named. Rejects on an IPC failure; a git refusal comes back as
 *  a resolved `{ ok: false, reason }` so the panel can show git's own words rather than a toast.
 *  Concurrent calls for the SAME root share one invocation — see `inFlight`.
 *
 *  `unattended` is the POLICY, not a hint: the backend re-diagnoses and acts on its own fresh
 *  reading, so it is the only thing that stops the background poll from taking an action that
 *  stopped being automatic in the meantime. Omitting it means "a human clicked". */
export function remedyStale(
  root: string,
  { unattended = false }: { unattended?: boolean } = {},
): Promise<RemedyOutcome> {
  const running = inFlight.get(root);
  // SHARING IS NOT SYMMETRIC. An unattended caller may ride on any run — a click is strictly more
  // permissive, and its outcome is a real answer to "is this checkout advanced now". A CLICK must
  // never inherit an unattended REFUSAL: that run declines anything not `auto_safe`, so the user
  // would read their own deliberate press as a failure of a remedy the panel had just offered them.
  if (running && (unattended || !running.unattended)) return running.p;
  // A click arriving mid-poll waits that poll out rather than racing it — two `merge --ff-only`
  // processes on one root is the thing this map exists to prevent.
  //
  // …and it takes its own turn ONLY if that poll did not already do the job. THE REFUSAL IS THE
  // THING A CLICK MUST NOT INHERIT, not the run: a SUCCEEDED poll advanced this checkout, which is
  // exactly what the button asked for, so it is the click's answer too. Re-running there would
  // re-diagnose a checkout that is now up to date, get `StaleRemedy::None` back as `ok:false`
  // ("up to date with origin/main"), and the panel paints every `!ok` outcome in its DANGER colour
  // — a red refusal for a fast-forward that had just succeeded, which is the exact failure this
  // map was written to prevent (roborev 59437).
  if (running)
    return running.p.then(
      (out) => (out.ok ? out : remedyStale(root)),
      () => remedyStale(root),
    );
  const p = invoke<RemedyOutcome>("repo_stale_remedy", { root, unattended }).finally(() => {
    // Cleared unconditionally, including on rejection — a root left in the map would be
    // permanently unfixable for the rest of the session.
    inFlight.delete(root);
  });
  inFlight.set(root, { unattended, p });
  return p;
}

/** Is unattended fast-forwarding turned on for this repo? Consulted ONLY on the `autoSafe` path —
 *  the click-driven remedies are the user's deliberate act and are never gated by it. */
export function autoFastForwardEnabled(root: string): Promise<boolean> {
  return invoke<boolean>("repo_auto_fast_forward", { root });
}
