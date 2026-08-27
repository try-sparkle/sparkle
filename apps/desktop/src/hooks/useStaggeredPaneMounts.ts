import { useEffect, useMemo, useState } from "react";

import { PANES_PER_MOUNT_RELEASE, scheduleMountRelease } from "../services/paneMountScheduler";

// WHICH OF THE PANES THAT *SHOULD* BE MOUNTED ARE ALLOWED TO MOUNT *YET* (bead sparkle-pqss6).
//
// `Workspace`'s `live` memo answers "which agents have a pane in this window". Until this hook it
// was fed straight into the pane list, so every id it gained arrived in ONE React commit — which on
// a fleet restore is every open agent across every visited project, and on a batch spawn is every
// agent of the batch. Each of those mounts an xterm, a WebGL context and a pane's worth of effects,
// and the renderer has no chance to produce a frame in between. Measured: `AgentPane` rendered 93
// times inside a single stall, and a 7-agent batch spawn starved rAF and setInterval for 10.2s.
//
// This hook is a QUEUE, not a filter. Every id handed to it is admitted, in bounded batches, as
// fast as the renderer can take them — see the status note below for why that distinction is the
// whole design and not a nicety.
//
// ── WHY IT MUST NOT BECOME A "MOUNT ONLY WHAT IS VISIBLE" VIRTUALISER ───────────────────────────
// `runtimeStore.status` has exactly ONE writer: a MOUNTED `AgentPane`. An agent whose pane is not
// mounted has no live status, no attention notifications and no observed activity — the app has
// already accepted that cost once, deliberately, for projects the user has not opened this session
// (see `live`'s visited-project gate), and it is a REAL user-visible cost each time. So the answer
// here is a delay measured in frames, never an exclusion:
//
//   • every pending id is released; nothing is dropped, ranked out, or made conditional on
//     visibility. The queue drains in ceil(N / PANES_PER_MOUNT_RELEASE) releases and then stops
//     rescheduling entirely, so the steady state is byte-for-byte the old behaviour;
//   • the scheduler races a timer against the frame, so a hidden window (no rAF) still drains;
//   • `priorityIds` — the pane each stage is actually SHOWING — skip the queue outright, so the
//     one pane whose absence a human could see never waits for a frame at all.
//
// The failure this shape rules out is the one that would be far worse than the freeze: a pane that
// never mounts leaves its agent's status frozen forever, which reads as a dead fleet.
//
// ── WHY RELEASED IDS ARE PRUNED WHEN THEY LEAVE `ids` ───────────────────────────────────────────
// Closing an agent removes it from `ids`; forgetting it here would let a close→reopen skip the
// queue on the way back, so a "close them all and reopen them all" gesture would reproduce exactly
// the burst this exists to spread. Pruning costs nothing — a released id that is gone is not
// mounted either way.

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Stable identity for a list of ids, so the effect below re-runs when the CONTENT changes rather
 *  than when the caller happens to allocate a new array. A newline cannot occur in an agent id, so
 *  no pair of distinct lists can collide on one key. */
function keyOf(ids: readonly (string | null)[]): string {
  return ids.join("\n");
}

/** Set equality. Compared by CONTENT and not by size, because the reconcile below both drops and
 *  adopts ids in one pass: an equal-sized-but-different result would otherwise be written off as a
 *  no-op, leaving a departed id parked in state where it would let that agent skip the queue if it
 *  ever came back. */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Gate `ids` so that at most {@link PANES_PER_MOUNT_RELEASE} newly appear per released frame.
 *
 * @param ids         every agent that should have a pane mounted in this window, in mount order.
 * @param priorityIds agents whose pane is on screen right now (`null` for a stage showing something
 *                    else). These bypass the queue: staggering a mount the user is staring at is a
 *                    blank stage, which is a worse bug than the one being fixed.
 * @returns the subset of `ids` that may be mounted in this commit. Grows monotonically, per id,
 *          until it equals `ids`.
 */
export function useStaggeredPaneMounts(
  ids: readonly string[],
  priorityIds: readonly (string | null)[],
): ReadonlySet<string> {
  const [released, setReleased] = useState<ReadonlySet<string>>(EMPTY);
  const idsKey = keyOf(ids);
  const priorityKey = keyOf(priorityIds);

  useEffect(() => {
    const present = new Set(ids);

    // RECONCILE FIRST, and return rather than releasing in the same pass: the release below has to
    // be computed against a settled set, or the batch size is wrong by however many ids the two
    // corrections below would have moved.
    //
    //   • DROP what has left `ids` — see the pruning note in this file's header.
    //   • ADOPT whatever the render path has already mounted because it was ON SCREEN. A priority
    //     mount MUST be sticky. Without this, a pane admitted only because its stage was showing it
    //     is dropped again the moment it stops being the visible one — selecting a sibling, or an
    //     epic filter hiding the row, is enough — and a `Terminal` unmount KILLS ITS PTY. That is a
    //     far worse bug than the burst this hook exists to spread, and it is silent: the pane comes
    //     straight back on the next selection, as a NEW instance with a respawned agent and no
    //     scrollback. Measured against the existing suites, which caught it as a pane node that was
    //     no longer the same object (`Workspace.tabs`, `Workspace.epicsColumn`, `Workspace.cockpit`).
    const settled = new Set<string>();
    for (const id of released) if (present.has(id)) settled.add(id);
    for (const id of priorityIds) if (id !== null && present.has(id)) settled.add(id);
    if (!sameIds(settled, released)) {
      setReleased(settled);
      return;
    }

    const pending = ids.filter((id) => !settled.has(id));
    if (pending.length === 0) return;

    // One release per effect run. `released` is a dependency, so admitting a batch re-runs this and
    // schedules the next — a self-terminating pump whose stop condition is the `pending.length === 0`
    // return above, not a counter that could get out of step with the list.
    return scheduleMountRelease(() => {
      const next = new Set(settled);
      for (const id of pending.slice(0, PANES_PER_MOUNT_RELEASE)) next.add(id);
      setReleased(next);
    });
    // `idsKey`/`priorityKey` stand in for the arrays they summarise: callers rebuild those arrays on
    // unrelated renders, and re-running on identity alone would cancel and reschedule the in-flight
    // release every time, starving the queue on a busy shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, priorityKey, released]);

  return useMemo(() => {
    const present = new Set(ids);
    const out = new Set<string>();
    // Released ids are filtered through `present` because pruning happens in an effect, one commit
    // later — without this, a closed agent's pane would survive that commit.
    for (const id of released) if (present.has(id)) out.add(id);
    for (const id of priorityIds) if (id !== null && present.has(id)) out.add(id);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, priorityKey, released]);
}
