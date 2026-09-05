import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  localAgentRowIds,
  residentAdmissionBasis,
  residentAdmissionCeiling,
} from "../services/agentCapacity";
import {
  MEMORY_ADMISSION_POLL_MS,
  memoryAdmissionVersion,
  onMemoryAdmissionChange,
} from "../services/memoryAdmission";
import {
  admitPaneResidency,
  publishMountedPaneCount,
  type PaneResidencyVerdict,
} from "../services/paneResidencyAdmission";

// THE REACT HALF OF THE MOUNT GATE (bead `sparkle-ftapmp`). The decision itself is pure and lives in
// `services/paneResidencyAdmission`; this supplies the three things it cannot compute for itself.
//
//  1. THE SUBSCRIPTION. The memory reading is a module-level cache refreshed on a 5s poll in
//     `App.tsx`, and a component cannot subscribe to a module variable. Without a token, a pane
//     deferred while the machine was squeezed would stay deferred until some UNRELATED write
//     happened to re-render `Workspace`. `memoryAdmission` bumps its version only when the residency
//     VERDICT moves, so a steady machine costs no renders at all.
//
//  2. STICKINESS. "Already resident" is not readable from any store: `runtimeStore.openAgentIds` is
//     persisted and says which panes SHOULD be mounted, not which ARE. The truthful answer is
//     simply what this hook admitted last time, so it keeps its own answer in a ref.
//
//     THE REF IS WRITTEN INSIDE THE MEMO, and the direction of the hazard is why that is acceptable.
//     React may discard a render, in which case the ref is "ahead" of what was committed — and ahead
//     here means MORE ids marked resident, which can only ever ADMIT more, never defer one that is
//     mounted. The opposite bookkeeping (recording in an effect, one commit late) has the opposite
//     hazard: a ceiling that drops between the mounting render and the effect would defer an id
//     whose pane is already up, and a `Terminal` unmount KILLS ITS PTY. Given a choice between
//     over-admitting for a frame and killing a live agent's terminal, this takes the frame.
//
//  3. A HEARTBEAT WHILE IT IS ACTUALLY DEFERRING (roborev 81141, High). The subscription cannot see
//     the ONE release path that is a function of the clock rather than of an event: TTL EXPIRY.
//     `notifyIfVerdictMoved` fires from `refreshMemoryAdmission`, `noteFailure` and
//     `resetMemoryAdmission` — never from a reading simply ageing out. The first version of this
//     hook claimed expiry was read "on the next render" and was wrong twice over: the verdict was
//     memoized on keys that do not move when a reading ages, and on an idle shell there may be no
//     next render at all.
//
//     That is not a theoretical gap. It is the STARVATION shape `memoryAdmission` already documents
//     and guards elsewhere — a sampler that forks `sysctl`/`vm_stat`, slowest exactly when memory is
//     tight, whose promise neither resolves nor rejects. No resolve, no reject, no version bump, no
//     re-render: the deferred panes would never mount, which is precisely the "silently never
//     mounts" failure this gate is not allowed to have.
//
//     So while — and only while — something is being held back, a self-terminating timer re-asks at
//     the poll interval. It costs one timer on a squeezed machine and NOTHING at all otherwise: the
//     effect returns immediately when `deferred` is empty, which is every healthy machine. Note the
//     ceiling is also a memo DEPENDENCY now rather than being read inside a memo keyed on something
//     else, so any render at all — this timer's or another component's — re-evaluates it.

/**
 * Which of `candidateIds` may hold a pane right now, which are held back for memory, and the
 * reading's own sentence for why.
 *
 * @param candidateIds every agent this window would mount a pane for, in mount order.
 * @param priorityIds  the pane each stage is SHOWING (`null` for a stage showing something else).
 *                     Never deferred; still counted against the ceiling.
 */
export function usePaneResidencyAdmission(
  candidateIds: readonly string[],
  priorityIds: readonly (string | null)[],
): PaneResidencyVerdict & { basis: string | null; gatedMounted: number } {
  // Stable identities for the two lists, so the memo re-runs on CONTENT rather than on the caller
  // happening to allocate a new array — `Workspace` rebuilds both on unrelated renders. A newline
  // cannot occur in an agent id, so no pair of distinct lists collides on one key.
  const candidateKey = candidateIds.join("\n");
  const priorityKey = priorityIds.join("\n");
  // Not read — subscribing is the point. A version bump re-renders this component, which is how a
  // NEW reading reaches the gate; the timer below covers the one transition a bump cannot express.
  useSyncExternalStore(onMemoryAdmissionChange, memoryAdmissionVersion);
  const [heartbeat, setHeartbeat] = useState(0);
  const residentRef = useRef<ReadonlySet<string>>(new Set<string>());

  // READ ON EVERY RENDER, and used as memo DEPENDENCIES. Reading these inside a memo keyed on the
  // id lists alone is what made TTL expiry unobservable: an aged-out reading returns `null` here,
  // and the memo has to be able to see that it changed.
  const ceiling = residentAdmissionCeiling();
  const basis = residentAdmissionBasis();
  // ── NO `residentsElsewhere` TERM ANY MORE, AND THE REASON IS THE PUBLISHED COUNT (roborev 81148,
  // High) ────────────────────────────────────────────────────────────────────────────────────────
  //
  // That term existed while `in_use` was `localAgentCapacity().live`, which counts torn-out
  // projects' rows that `candidateIds` excludes: the ceiling was then MACHINE-wide and the other
  // window's residents had to be subtracted from it.
  //
  // Since the gate publishes THIS WINDOW's mounted count, Rust returns
  // `thisWindowMounted + available_bytes/per_agent` — and `available_bytes` is the OS's own reading,
  // so every other window's agents are ALREADY subtracted from it. The ceiling is per-window by
  // construction and correct. Subtracting them again charged them twice and deferred panes the
  // machine genuinely had room for, persistently rather than for a poll — and the term's correctness
  // depended on WHICH BRANCH THE POLL TOOK, right on the `?? live` fallback and double-counting once
  // the gate had published, which is two denominations for one expression decided by ordering.
  //
  // What remains cross-window is smaller and self-correcting: two windows each see the same free
  // bytes, so each may admit that headroom, and the machine can over-admit by the headroom per extra
  // window. As either one mounts, `available_bytes` drops and the headroom shrinks for BOTH. Bead
  // `sparkle-8yea9v` carries it.

  const verdict = useMemo(() => {
    // ── ONLY LOCAL BUILD/WORKER PANES ARE GATED ON LOCAL RAM (roborev 81145, High) ──────────────
    //
    // `Workspace`'s `live` memo applies no `kind`/`runtime` filter, while the ceiling counts exactly
    // what `localAgentRowIds` counts: local `build`/`worker` rows. A cloud agent runs in a server
    // sandbox and a shell is not a model process — neither consumes a byte of the memory this gate
    // is rationing — so holding their panes back is a refusal for RAM they never take.
    //
    // It was also the ONLY population the gate could ever defer before the feedback loop was
    // broken, which is the sharpest way to say the gate was pointed at the wrong thing: exhaustive
    // search over the reachable state space found deferrals reachable ONLY when the candidate count
    // exceeded the local row count, i.e. only for the panes that should be exempt.
    const local = new Set(localAgentRowIds().used);
    const gated: string[] = [];
    const exempt: string[] = [];
    for (const id of candidateIds) (local.has(id) ? gated : exempt).push(id);

    const v = admitPaneResidency({
      candidateIds: gated,
      priorityIds,
      residentIds: [...residentRef.current],
      residentCeiling: ceiling,
    });
    // The exempt panes mount unconditionally and are not counted as residents by the gate, because
    // the ceiling they would be spent against does not count them either.
    const admitted = exempt.length === 0 ? v.admitted : new Set([...v.admitted, ...exempt]);
    residentRef.current = v.admitted;
    // `gatedMounted` is `v.admitted.size` — the GATED set, NOT the union (roborev 81148, High). It
    // is what goes back to the sampler as `in_use`, and `in_use` is local `build`/`worker` only:
    // that is the population `static_max` and `memory_admitted` are denominated in. Publishing the
    // union sent cloud and shell panes as local residents, which raised the residents ceiling by one
    // per exempt pane — the same denomination mismatch this whole change removes, on the exemption
    // axis, and self-reinforcing, because mounting more exempt panes raised it further. Past
    // `static_max` the reading is discarded outright and the gate switches itself off.
    return { admitted, deferred: v.deferred, basis, gatedMounted: v.admitted.size };
    // `candidateKey`/`priorityKey` stand in for the arrays they summarise; `ceiling`, `elsewhere` and
    // `basis` are the reading, read fresh above; `heartbeat` is what re-asks while deferring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, priorityKey, ceiling, basis, heartbeat]);

  // PUBLISH WHAT WE ACTUALLY MOUNTED, so the next poll measures residency rather than intent — the
  // feedback loop `services/paneResidencyAdmission`'s note describes. In an effect, not in the memo:
  // this is a side effect on module state, and a render React discards must not leave a count behind
  // that no pane corresponds to. One commit of lag is nothing against a 5s poll.
  const mountedCount = verdict.gatedMounted;
  useEffect(() => {
    publishMountedPaneCount(mountedCount);
  }, [mountedCount]);

  const deferring = verdict.deferred.length > 0;
  useEffect(() => {
    // NOTHING AT ALL on a healthy machine — no timer is created when nothing is held back, and the
    // effect stops rescheduling the moment the last deferral clears. Self-terminating by its own
    // stop condition rather than by a counter that could get out of step.
    if (!deferring) return;
    const t = setTimeout(() => setHeartbeat((n) => n + 1), MEMORY_ADMISSION_POLL_MS);
    return () => clearTimeout(t);
  }, [deferring, heartbeat]);

  return verdict;
}
