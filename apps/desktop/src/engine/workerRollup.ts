// What an ORCHESTRATOR's status dot says when its workers are folded away.
//
// The build column collapses subtrees by default, so the row you see is usually a head standing in
// for work you cannot see. Painting that head from its own PTY status made it lie in exactly the
// case that matters: an orchestrator sitting in `idle` while three of its workers are blocked on a
// question renders GRAY — "nothing to do here" — and the fold hides the only rows that disagree.
//
// THE LAW, in one sentence: grey is ignored; red and green together make orange. Plus one
// exception — an orchestrator's OWN red wins outright, because a question the head is asking is one
// you are directly blocking, and healthy workers must not paint over it.
//
// Two deliberate non-symmetries, both load-bearing:
//   • own RED wins, own GREEN does not. A head busy delegating while every worker under it is
//     blocked is not a healthy row; "all red → red" is flat.
//   • grey is absorbed, never mixed. A finished worker beside a running one says "still going",
//     not "partly done" — there is no fourth color for that and there shouldn't be.
//
// TIERS COME FROM `bandOfStatus`, NOT FROM A LIST SPELLED OUT HERE. That function is already pinned
// 1:1 to the three AGENT_STATUS color tiers by engine/statusBandLabels.test.ts, so a status added
// later gets tiered once, in one place. Writing `status === "working" || …` here would be a second
// copy of the taxonomy, and the taxonomy is precisely what has drifted twice before (see the
// `blocked` / `unmerged` notes in packages/ui/tokens.ts).
//
// Do NOT reach for `needsAttention` to find the red workers. It answers a different question ("is
// this stopping ME right now?") and excludes `blocked`; substituting it for the red predicate is
// the bug that shipped twice, most recently leaving a blocked worker unable to bubble to its
// orchestrator at all. `bandOfStatus(...) === "needs_you"` is the "is this row painted red?" test.
import { bandOfStatus, type StatusBand } from "./buildSections";
import type { AgentTabStatus } from "../types";

/** The four marks a head row's disc can take. `orange` is NOT an agent status — there is no such
 *  PTY state — it is a summary of disagreement among workers, which is why it lives here and not in
 *  AGENT_STATUS (that enum's three color tiers are pinned to the three filter bands). */
export type RollupDot = "green" | "red" | "orange" | "gray";

/** The dot for a row, given its own status and the statuses of the workers folded under it.
 *
 *  Pass an EMPTY worker list for a childless row or a worker row; the result is then just that
 *  agent's own tier, so every row in the column can go through this one function. */
export function rollupDot(
  ownStatus: AgentTabStatus,
  workerStatuses: readonly AgentTabStatus[],
): RollupDot {
  const ownBand = bandOfStatus(ownStatus);

  // The exception, checked first: a head asking you something is red no matter what is underneath.
  if (ownBand === "needs_you") return "red";

  // No subtree → nothing to summarize. This is also the worker-row and shell-row path.
  if (workerStatuses.length === 0) return dotOfBand(ownBand);

  let anyRed = false;
  let anyGreen = false;
  for (const s of workerStatuses) {
    const band = bandOfStatus(s);
    if (band === "needs_you") anyRed = true;
    else if (band === "running") anyGreen = true;
    // "done" is grey and deliberately contributes nothing.
  }

  if (anyRed && anyGreen) return "orange";
  if (anyRed) return "red";
  // GREEN DOES NOT OVERRIDE `unmerged`. Every other calm status means "nothing here wants you", so
  // letting a running worker speak for the row loses nothing. `unmerged` is different: it is gray by
  // deliberate choice (tokens.ts — a LANDING state, not an alarm) but it is still an ASK, "open or
  // merge the PR". Painting that head green would replace a specific, actionable thing you can do
  // with a vague "something's running", and downstream it is worse — the published map would carry
  // `working` instead of `unmerged`, so the "Needs merge" label, conciergeRecap's finished/resting
  // classification and isCalmBand's desaturation of an un-landed branch all silently lose the fact
  // (roborev 53886). The subtree is still reachable: the head keeps its `+N` badge and its workers.
  if (anyGreen) return ownStatus === "unmerged" ? "gray" : "green";
  // Every worker is grey. The head's own tier can only be running-or-done here (needs_you returned
  // above), and a head that is itself WORKING with only calm workers is genuinely running.
  return dotOfBand(ownBand);
}

/** Which filter chip should find a row painted this way.
 *
 *  Stated rather than derived, because `orange` has no AGENT_STATUS entry to ask. Orange files under
 *  "Needs you" on purpose: the whole reason the color exists is that SOMETHING under this row wants
 *  you, and a chip that couldn't surface it would leave the signal visible but unfindable. */
export function bandOfRollup(dot: RollupDot): StatusBand {
  switch (dot) {
    case "red":
    case "orange":
      return "needs_you";
    case "green":
      return "running";
    case "gray":
      return "done";
  }
}

/** Build the `id → RollupDot` accessor for a whole agent list, bucketing workers by parent once.
 *
 *  THIS IS THE SHARED ENTRY POINT, and it exists because the build column has (at least) three
 *  independent places that decide what a row looks like or whether it renders: the row's own disc,
 *  the ladder's band filter, and `engine/ladderSelection.firstLadderRowId`. The stage-ladder work
 *  already recorded that these drift. A row painted red by one and filed under "Done" by another is
 *  that drift in its worst form — the color tells you something needs you and the chip that should
 *  find it doesn't.
 *
 *  Only `kind: "worker"` children are rolled up, matching engine/workerExpansion.workerCounts: they
 *  are the only children that render as rows, so a nested shell must not tint its parent's disc. */
export function rollupDotAccessor<
  T extends { id: string; kind: string; parentId: string | null },
>(
  agents: readonly T[],
  statusOf: (id: string) => AgentTabStatus,
  /** The head's OWN status, with any worker-attention bubbling stripped out. Defaults to `statusOf`.
   *
   *  This parameter is not optional decoration — without it the "own red wins" rule eats the orange
   *  case entirely. The sidebar's status map already composites `withRedWorkerAttention`, which
   *  paints an orchestrator red whenever any worker is red. Feed that back in as the head's "own"
   *  status and every mixed subtree reports own-red and returns RED before it ever counts a green
   *  worker. The bubbled red IS the workers' red; treating it as the head's own is a category error,
   *  and the rollup is the thing that replaces that overlay's job anyway — better, because it can
   *  tell all-red from some-red. */
  ownStatusOf: (id: string) => AgentTabStatus = statusOf,
  opts: RollupOptions = {},
): (id: string) => RollupDot {
  const { isDismissed = () => false, isInMotion = () => false } = opts;
  const workersByParent = new Map<string, AgentTabStatus[]>();
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    const ws = statusOf(a.id);
    // IN-MOTION SUPPRESSION, mirroring engine/workerAttention.withRedWorkerAttention exactly: a red
    // that is NOT asking you anything (`blocked` — went quiet, might need unsticking) does not
    // surface on a parent that is visibly progressing. Without this the rollup reinstates the report
    // that suppression was added for, painting a working orchestrator red and floating it into
    // "Needs you" while you watch it produce output. A worker that genuinely needs you now always
    // gets through, however busy its parent is.
    if (bandOfStatus(ws) === "needs_you" && !isAsk(ws) && isInMotion(a.parentId)) continue;
    const arr = workersByParent.get(a.parentId);
    if (arr) arr.push(ws);
    else workersByParent.set(a.parentId, [ws]);
  }
  return (id) => {
    const dot = rollupDot(ownStatusOf(id), workersByParent.get(id) ?? []);
    // DISMISSAL BEATS THE ROLLUP. "Dismiss Alert" exists to calm a row whose red is bubbled up from
    // a worker — that is its main case. Left unhandled, dismissing did nothing visible: the head's
    // own status went calm, but the rollup re-read the worker's still-red status, repainted the row
    // red and re-filed it under "Needs you". De-escalating to the head's own tier is what the
    // pre-existing withDismissedAlerts did to the bubbled red before the rollup replaced it.
    if ((dot === "red" || dot === "orange") && isDismissed(id)) {
      // Drop the REDS and re-roll — do not collapse to an empty list. Dismissal silences an alarm;
      // it does not mean "nothing is happening here". A dismissed head with a `waiting` worker AND a
      // `working` one collapsed to GRAY under the first cut, so a folded subtree with live work in
      // it read "nothing to do" — the exact lie this whole module exists to remove — and with the
      // Done chip off, the head and its running subtree vanished from the column entirely.
      // Dropping just the reds degrades that head to GREEN, which is the truth.
      const calm = (workersByParent.get(id) ?? []).filter(
        (s) => bandOfStatus(s) !== "needs_you",
      );
      return rollupDot(ownStatusOf(id), calm);
    }
    return dot;
  };
}

export interface RollupOptions {
  /** Has the user dismissed this row's alert? A dismissed head's rolled-up red/orange collapses to
   *  its own tier — see the note in the accessor. */
  isDismissed?: (id: string) => boolean;
  /** Is this parent visibly progressing? Gates the non-ask reds, as withRedWorkerAttention does. */
  isInMotion?: (parentId: string) => boolean;
}

/** "This worker is stopping YOU, right now" — waiting/approval/errored, but NOT `blocked`.
 *
 *  Spelled out here rather than importing `needsAttention` so this module keeps one dependency
 *  direction, but it is the SAME distinction, and the distinction is load-bearing: `blocked` is red
 *  (the row is painted) yet nothing is waiting on your answer, which is exactly the red the
 *  in-motion rule is allowed to swallow. packages/ui/tokens.ts and engine/workerAttention.ts both
 *  carry the warning that conflating these two has shipped a bug twice. */
function isAsk(status: AgentTabStatus): boolean {
  return status === "waiting" || status === "approval" || status === "errored";
}

// `rollupBandAccessor` USED TO LIVE HERE and was deleted rather than left unused. It wrapped
// `bandOfRollup(rollupDotAccessor(...)(id))` and its last call site (engine/ladderSelection) went
// away when publishedStatusFor started carrying the rollup itself.
//
// It is not coming back as a convenience. Its extra inputs — ownStatusOf, isDismissed, isInMotion —
// were all OPTIONAL, so `rollupBandAccessor(agents, statusOf)` type-checked and silently produced a
// different band than the column for a dismissed head and for an in-motion head with a `blocked`
// worker. That is exactly the divergence firstLadderRowId shipped (roborev 53858), and a dead
// two-arg-friendly helper sitting here is how the next caller reproduces it. Compose
// `bandOfRollup(rollupDotAccessor(...)(id))` explicitly and pass every input on purpose.

/** The tooltip for a head whose disc is reporting its WORKERS rather than itself.
 *
 *  Used only when the rollup disagrees with the row's own band — when they agree, the row keeps its
 *  own more specific status label ("Blocked" says more than "Workers need you"). A disc painted
 *  from one thing while hovering as another is the kind of small lie that makes people stop
 *  trusting the column. */
export function rollupLabel(dot: RollupDot): string {
  switch (dot) {
    case "red":
      return "Workers need you";
    case "orange":
      return "Workers running — some need you";
    case "green":
      return "Workers running";
    case "gray":
      return "Workers done";
  }
}

function dotOfBand(band: StatusBand): RollupDot {
  switch (band) {
    case "needs_you":
      return "red";
    case "running":
      return "green";
    case "done":
      return "gray";
  }
}

/** Promote a CALM orchestrator to `working` when its workers roll up green.
 *
 *  This is the rollup's one edit to the shared, app-wide status map (useAttentionNotifications.
 *  publishedStatusFor). The Build column paints its own discs straight from `rollupDotAccessor`, so
 *  without this the column and every other surface disagreed: an `idle` head with a `working` worker
 *  read GREEN / "Running" in the column and gray / "Done" in the TopBar dot cluster and the
 *  concierge digest — which is exactly the column↔feed drift conciergeFeed.ts's header warns about.
 *
 *  GREEN ONLY, and that is not an arbitrary limit. Red and orange already agree across surfaces,
 *  because `withRedWorkerAttention` has bubbled a red worker onto its orchestrator for far longer
 *  than this rollup has existed; both sides land in `needs_you`. Green was the one tier with no
 *  equivalent pass, so it is the only gap to close — and closing it by PROMOTION (never demotion)
 *  means this cannot mask a red or quiet an alarm.
 *
 *  Nothing new is relayed as a result: the phone/badge set is waiting|approval|errored
 *  (`isRelayRed`), and `working` is not in it. What DOES change beyond the dot is `isCalmBand` — a
 *  promoted head stops reading as calm, so the terminal's own xterm theme no longer desaturates it.
 *  That was an accepted consequence of making one truth for every surface, not an oversight.
 *
 *  Returns the SAME reference when nothing is promoted, so an unchanged frame costs no re-render. */
export function withWorkerRollupGreen<
  T extends { id: string; kind: string; parentId: string | null },
  M extends Record<string, AgentTabStatus>,
>(
  agents: readonly T[],
  statusMap: M,
  dotOf: (id: string) => RollupDot,
  /** Receives every id this promoted. An OUT-PARAM rather than a second return value so the many
   *  callers that don't care are unchanged — but the away-recap does care, and badly: a promoted
   *  head transitions idle→working→idle purely because its worker ran, which the recap reads as the
   *  head finishing a job it never started, reporting it alongside the worker that actually did the
   *  work. Recomputing "was this promoted?" downstream would mean a second copy of this
   *  composition, which is the drift trap this module exists to avoid. */
  promoted?: Set<string>,
): M {
  let out: M | null = null;
  for (const a of agents) {
    // Heads only: a worker has no subtree, so its "rollup" is just itself and promoting it would be
    // inventing a status out of nothing.
    if (a.kind !== "build") continue;
    const current = statusMap[a.id];
    if (current === "working") continue; // already there
    // NEVER DEMOTE A RED. `rollupDotAccessor` won't hand us green for a red head (own-red wins
    // returns first), so this is belt-and-braces — but this step runs LAST in the published chain,
    // after four overlays have worked to establish that red, one of them a worker's bubbled alarm.
    // A caller passing a different `dotOf` must not be able to quietly silence it from here.
    if (current !== undefined && bandOfStatus(current) === "needs_you") continue;
    // `unmerged` is gray but it is still an ASK ("open or merge the PR"). rollupDot already refuses
    // to return green for it; this is the second lock, because THIS function is what writes into
    // the shared map and losing `unmerged` there costs the label, the recap classification and
    // isCalmBand all at once.
    if (current === "unmerged") continue;
    if (dotOf(a.id) !== "green") continue;
    out ??= { ...statusMap };
    (out as Record<string, AgentTabStatus>)[a.id] = "working";
    promoted?.add(a.id);
  }
  return out ?? statusMap;
}
