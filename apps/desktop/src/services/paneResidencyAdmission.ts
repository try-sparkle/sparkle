// WHICH DORMANT ROWS MAY BECOME RESIDENT RIGHT NOW — the gate that was missing (bead
// `sparkle-ftapmp`).
//
// ══ WHY THIS EXISTS AT ALL ══════════════════════════════════════════════════════════════════════
// `services/agentCapacity` used to spend a RESIDENTS-denominated memory ceiling against a count of
// ROWS, and `pollMemoryAdmission`'s own doc defended the mismatch in as many words: "we ask the
// question in RESIDENT agents and enforce the answer against ROWS, because a dormant row becomes
// resident the moment its tab is clicked, WITH NO GATE IN BETWEEN."
//
// The premise was true. The conclusion was not: comparing across denominations is a ONE-WAY
// RATCHET, because retiring an agent lowers `used` and `live` together and so lowers BOTH sides.
// Measured 2026-09-04 — 60 rows, 21 residents, 26 GiB free, memory admitting 39; two refusals 90
// seconds apart with one retire between them moved `used` 60→59 and `limit` 39→38, and the gap
// stayed exactly 21. Nothing anyone could do closed it.
//
// So the comparison was fixed, which means the premise it was standing on now has to be answered
// directly: THIS is the gate in between. When the machine is genuinely at its residents ceiling, a
// dormant row's pane is DEFERRED rather than mounted, so the fleet cannot over-commit RAM by the
// back door of a tab click.
//
// ══ WHAT IT IS NOT ══════════════════════════════════════════════════════════════════════════════
// It is NOT a virtualiser, and `hooks/useStaggeredPaneMounts`'s header explains at length why that
// distinction is the whole design: `runtimeStore.status` has exactly ONE writer, a MOUNTED
// `AgentPane`, so an unmounted pane means a frozen status, no attention notifications and no
// observed activity for that agent. A pane that silently never mounts is worse than the bug this
// closes. Hence three properties, each load-bearing:
//
//   • NO BASIS → NO GATE. A null ceiling admits everything, byte-for-byte as before. See
//     `agentCapacity.residentAdmissionCeiling` for the four ways that happens — the important one
//     being "memory did not narrow", so a healthy machine never defers a thing.
//   • NOTHING IS EVER UNMOUNTED. An id that is already resident stays admitted whatever the
//     ceiling says. A `Terminal` unmount KILLS ITS PTY, so a shrinking ceiling that evicted panes
//     would destroy live work to save memory — and would do it to the agent that was already
//     paying for itself honestly.
//   • ONLY LOCAL BUILD/WORKER PANES ARE GATED. The ceiling counts exactly what `localAgentRowIds`
//     counts, so a cloud agent (a server sandbox) and a shell (not a model process) must be exempt —
//     holding their panes back is a refusal for RAM they never take. `hooks/usePaneResidencyAdmission`
//     applies that filter before calling in here; this module rules on whatever it is given. The
//     exempt panes are also kept OUT of the count published back to the sampler — see
//     `publishMountedPaneCount` below.
//   • THE PANE THE USER IS LOOKING AT NEVER WAITS. A blank stage under a live tab is the failure
//     mode `useStaggeredPaneMounts` calls worse than the burst it exists to spread. Priority ids
//     are admitted unconditionally; they still COUNT against the ceiling, so they displace a
//     dormant candidate rather than being exempt from the budget.
//
// And the deferral is REPORTED, not silent: `deferred` is returned so the shell can say so
// (`components/PaneResidencyBanner`). A gate whose effect a human cannot see is indistinguishable
// from a hang.
//
// ══ WHAT IS STILL OPEN: CROSS-WINDOW ACCOUNTING (bead `sparkle-8yea9v`) ═════════════════════════
// The ceiling is PER-WINDOW by construction, and correct as far as it goes: the gate publishes THIS
// window's mounted count, Rust returns `thisWindowMounted + available_bytes/per_agent`, and
// `available_bytes` is the OS's own reading, so every other window's agents are already subtracted
// from it. A `residentsElsewhere` term used to sit here and was REMOVED (roborev 81148, High) —
// once the published count became window-local, subtracting the other window's residents charged
// them twice and deferred panes the machine genuinely had room for.
//
// What remains is smaller and self-correcting: two windows read the same free bytes, so each may
// admit that headroom, and the machine can over-admit by the headroom per extra window. As either
// one mounts, `available_bytes` falls and the headroom shrinks for BOTH. Closing it exactly needs
// each window to publish its mounted count through the existing cross-window sync so one number
// describes the machine. Written down here rather than left to be rediscovered, because
// `agentCapacity` relaxed its row-side comparison ON THE GROUNDS THAT THIS GATE EXISTS.

/** Everything the decision needs. Pure in, pure out — no stores, no hooks, no clock. */
export interface PaneResidencyInput {
  /** Every agent this window would mount a pane for right now, in mount order. */
  candidateIds: readonly string[];
  /** The pane each stage is actually SHOWING (`null` for a stage showing something else). Admitted
   *  unconditionally; still counted against the ceiling. */
  priorityIds: readonly (string | null)[];
  /** Agents whose pane is ALREADY mounted in this window. Never deferred — see the header. */
  residentIds: readonly string[];
  /** How many agents may hold a process on this machine, or `null` when there is no basis to hold
   *  anything back. `agentCapacity.residentAdmissionCeiling()` in production. */
  residentCeiling: number | null;
}

export interface PaneResidencyVerdict {
  /** The subset of `candidateIds` that may mount in this commit. */
  admitted: ReadonlySet<string>;
  /** Candidates held back, in `candidateIds` order. Empty whenever the gate is not binding. */
  deferred: readonly string[];
}

/**
 * Decide which candidates may become resident.
 *
 * DETERMINISTIC AND ORDER-STABLE: the answer is a function of the four inputs alone, and candidates
 * are considered in the order given, so the same fleet against the same reading always defers the
 * same agents. A gate that reshuffled its answer between renders would mount and unmount panes on
 * nothing but a re-render — and an unmount kills a PTY.
 */
export function admitPaneResidency(input: PaneResidencyInput): PaneResidencyVerdict {
  const { candidateIds, priorityIds, residentIds, residentCeiling } = input;

  // NO BASIS TO NARROW. Not "zero available" — the same contract every other consumer of the memory
  // reading is built on. Returning early rather than falling through with a huge ceiling keeps that
  // path free of arithmetic that could ever produce a deferral.
  if (residentCeiling === null || !Number.isFinite(residentCeiling)) {
    return { admitted: new Set(candidateIds), deferred: [] };
  }
  // A ceiling of zero would blank the window. One pane always mounts; the same floor `limit` and
  // Rust's own `sampled_admission` both apply, and for the same reason.
  const ceiling = Math.max(1, Math.floor(residentCeiling));

  const candidates = new Set(candidateIds);
  const resident = new Set(residentIds);
  const admitted = new Set<string>();

  // ── PASS 1: the ids that are admitted whatever the budget says ──────────────────────────────────
  // Already resident (unmounting kills a PTY) and on screen (a blank stage is the worse bug). Both
  // are filtered through `candidates`: an id that has left the mount set is not mounted either way,
  // and admitting it would let it skip the budget if it ever came back.
  for (const id of candidateIds) if (resident.has(id)) admitted.add(id);
  for (const id of priorityIds) if (id !== null && candidates.has(id)) admitted.add(id);

  // ── PASS 2: spend whatever budget is left, in mount order ───────────────────────────────────────
  // `admitted.size` may ALREADY exceed the ceiling after pass 1 — a machine whose reading just
  // narrowed under its current residency is the normal way to arrive here — in which case this loop
  // admits nothing and defers the rest. That is the correct shape: hold the line where it is, never
  // walk it back.
  const deferred: string[] = [];
  for (const id of candidateIds) {
    if (admitted.has(id)) continue;
    if (admitted.size < ceiling) admitted.add(id);
    else deferred.push(id);
  }

  return { admitted, deferred };
}

// ══ THE COUNT THAT GOES BACK TO THE SAMPLER ═════════════════════════════════════════════════════
//
// **PUBLISH THE GATED COUNT, NEVER THE UNION** (roborev 81148, High). `in_use` is denominated in
// local `build`/`worker` agents — the population `static_max` and `memory_admitted` are built on —
// so sending the exempt cloud and shell panes with it raises the residents ceiling by one per exempt
// pane. That is this bead's own denomination mismatch on the exemption axis, and it is
// self-reinforcing: mounting more exempt panes raises the ceiling further, and past `static_max` the
// reading is discarded outright and the gate switches itself off.
//
// ── THE FEEDBACK LOOP THIS BREAKS (roborev 81145, High) ─────────────────────────────────────────
// `pollMemoryAdmission` used to send `localAgentCapacity().live` as Rust's `in_use`, and Rust
// returns `admitted = min(static_max, in_use + available/per_agent, by_level)` with
// `by_level ∈ {∞, in_use}`. So `admitted >= min(static_max, in_use)`, and a reading where
// `admitted >= static_max` is discarded as "memory had no opinion" — every SURVIVING reading
// therefore has `ceiling >= in_use`.
//
// That would be fine if `in_use` meant "panes that are mounted". It did not: `live` is
// `openAgentIds ∩ visited projects`, which counts the very rows this gate may be DEFERRING. So the
// ceiling was computed from the count it was about to be spent against, and it could never bind.
// Verified exhaustively over the reachable state space (static ceiling 9, every `live`, candidate
// count, headroom and pressure level): with the candidate set restricted to local rows there are
// ZERO states in which a pane can be deferred. The gate was inert, and the row-side relaxations in
// `agentCapacity` and `orchestrationListener` were both justified on the grounds that it exists.
//
// So the gate publishes what it has actually MOUNTED, and the poll sends that instead. The loop is
// broken because the published number does not move when a pane is deferred — deferring lowers it,
// which lowers the measured `in_use`, which is the truth the sampler needs.
//
// NULL UNTIL THE GATE HAS RUN, and that is the safe direction: `pollMemoryAdmission` falls back to
// `live` exactly as before, so a window that never renders a pane list (or a build predating this)
// behaves byte-for-byte as it did. Publishing 0 instead would report a machine with no residents at
// all and narrow the ceiling on a fiction.

let mountedPanes: number | null = null;

/** The gate's own count of panes it has admitted — what `pollMemoryAdmission` sends as `in_use`. */
export function publishMountedPaneCount(n: number): void {
  mountedPanes = Math.max(0, Math.floor(n));
}

/** What the gate last published, or `null` if it has never run in this window. */
export function mountedPaneCount(): number | null {
  return mountedPanes;
}

/** Tests only: module state outlives a component tree. */
export function resetMountedPaneCount(): void {
  mountedPanes = null;
}
