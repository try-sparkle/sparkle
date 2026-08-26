// The ONE machine-wide agent-capacity reading, and the ONE gate every spawn path goes through.
//
// It lives here rather than in services/conciergeTools/lifecycle because BOTH spawn paths need it
// and lifecycle already imports buildAgentSpawn — putting the gate there and importing it back
// would be a cycle. That import direction is exactly how the asymmetry arose: the concierge's
// `spawn_build_agent` refused at capacity while the human's "+ New Build Agent" button called
// `spawnBuildAgentInProject` directly and sailed past it, so one project was observed growing
// 4 → 15 agents while the machine-wide count was ALREADY over the ceiling.
//
// settingsStore's `enforcedWorkerCap` doc says every concurrency gate must read it; this module is
// how the spawn paths do. See the note on `limit` for the open question about what a pin means.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore, enforcedWorkerCap, concurrencyBasis } from "../stores/settingsStore";
import { currentMemoryAdmission, refreshMemoryAdmission } from "./memoryAdmission";
import { wasProjectVisited } from "./sessionProjects";

export interface CapacityReading {
  /**
   * Slots TAKEN against the machine-wide budget: every local build/worker ROW, in every project —
   * including rows whose pane isn't mounted right now. NOT a count of live processes; see `live`.
   */
  used: number;
  /**
   * Of those rows, how many actually have a mounted pane (and therefore a PTY) at this instant.
   * `live < used` is normal and not a bug: Workspace only mounts panes for agents in `openAgentIds`
   * that sit in a VISITED project tab, so a row in a tab the user hasn't opened yet holds a slot
   * without holding any RAM — until they open that tab, at which point it starts.
   *
   * BOTH halves of that condition are computed here (roborev 54225). `openAgentIds` alone is not it:
   * that list is PERSISTED, so on the first render after a restart every previously-open row is in
   * it while no pane has mounted anywhere — `live` would equal `used` and the refusal below would
   * drop its dormant clause and implicitly assert N running processes, the exact inaccuracy the
   * field exists to remove.
   */
  live: number;
  /**
   * The machine-wide ceiling actually ENFORCED. Reporting anything else here is how the app came to
   * refuse a spawn citing a limit it was not using.
   *
   * Normally `enforcedWorkerCap` — the same number every other gate compares against. It can be
   * LOWER when a fresh live memory reading says the machine cannot hold that many right now (see
   * the narrowing block in `localAgentCapacity`); it is never higher, in any state, for any reason.
   * So the sibling gates still agree with this one whenever they refuse: this one may additionally
   * refuse earlier, which is the direction that protects the machine.
   */
  limit: number;
  /**
   * WHY `limit` is that number, as a sentence fit to show a human: `"CPU-bound: 18 cores × 2 agents
   * per core"`, `"pinned to 32 in config.toml…"`, `"RAM-bound: 16 GiB installed − 6 GiB reserved…"`,
   * or — when a live reading is what's binding — `"refused: memory pressure (…)"`.
   *
   * Carried on the reading so a refusal cannot state the number without its cause. The refusal used
   * to hardcode "the ceiling is derived from installed RAM", which on the machine that reported this
   * bug was wrong twice over — it was CPU-bound at 36 and pinned at 32, with memory 94% free.
   */
  basis: string;
  atCapacity: boolean;
}

/**
 * The machine-wide budget a new local agent has to fit inside.
 *
 * The same BOUND `atCapacity` (services/orchestrationListener) enforces for worker spawns — same
 * number, though written as a different expression; see the note on `limit` — applied to the other
 * kind of process that costs the same: a build agent runs its own Claude Code
 * with its own V8 heap, so counting only workers would be the dimensional error that gate's comment
 * warns about — N build agents each sitting happily under a per-agent cap while the machine goes to
 * swap (sparkle-hfhs, and the jetsam incident before it). `enforcedWorkerCap` is a machine-wide
 * number (min of what RAM holds and what the cores can drive), so it is compared against a
 * machine-wide count of machine-resident agents.
 *
 * CLOUD agents are excluded: they run in a server sandbox and consume none of this machine's RAM.
 * Shell agents are excluded too — a shell is not a model process.
 *
 * IT COUNTS ROWS, NOT RUNNING PROCESSES, and that is deliberate (roborev 54175). A row in a project
 * tab the user hasn't visited has no mounted pane and no PTY yet — but it gets both the moment they
 * click that tab, with no gate in between. Counting only the mounted ones would admit spawns that
 * the machine cannot actually hold one click later, and would put this gate out of step with
 * orchestrationListener's `globalUsedSlots`, which counts worker rows the same way. So `used` stays
 * row-based and `live` reports the mounted subset, letting the refusal be honest about the
 * difference rather than claiming N processes are running when they aren't.
 *
 * `live` mirrors Workspace's `live` memo EXACTLY — in `openAgentIds` AND in a project whose tab has
 * been visited this session (or is the current tab, which Workspace unions in at render time). The
 * walk that decides membership (and why it must stay per-project rather than a flatMap) lives in
 * `localAgentRowIds`; this reads the LENGTHS of its two lists.
 */
/**
 * The ids of the local build/worker rows this machine's budget counts, split by liveness.
 *
 * `used` is EVERY local build/worker row (cloud agents and non-agent kinds excluded, exactly as
 * `localAgentProcessIds` does); `live` is the subset Workspace would mount a pane for right now (the
 * project is selected or has been visited this session) AND that carries an entry in `openAgentIds`.
 * `localAgentCapacity`'s `used`/`live` are the LENGTHS of these two lists, so a surface that needs
 * the IDS behind the live count — get_state's "fleet" directory has to say WHICH live agents it does
 * not list rather than assert there are none (bead sparkle-u1p68f) — reconciles with the capacity
 * reading BY CONSTRUCTION, not through a second predicate that can drift out of step with this one.
 *
 * A NESTED LOOP rather than a flatMap, and that is load-bearing: `mounted` is per-PROJECT, and a
 * flatten that discarded `p` is what once let a persisted `openAgentIds` report every restored row
 * as a running process (roborev 54225).
 */
export function localAgentRowIds(): { used: string[]; live: string[] } {
  const { projects, selectedProjectId } = useProjectStore.getState();
  const open = new Set(useRuntimeStore.getState().openAgentIds);
  const used: string[] = [];
  const live: string[] = [];
  for (const p of projects) {
    // Whether Workspace would mount ANY pane for this project right now.
    const mounted = p.id === selectedProjectId || wasProjectVisited(p.id);
    for (const a of p.agents) {
      if (a.runtime === "cloud" || (a.kind !== "build" && a.kind !== "worker")) continue;
      used.push(a.id);
      if (mounted && open.has(a.id)) live.push(a.id);
    }
  }
  return { used, live };
}

export function localAgentCapacity(): CapacityReading {
  // ONE population, counted once — `used`/`live` are the lengths of `localAgentRowIds`'s two lists,
  // so every surface that reports the live COUNT and every surface that needs the live IDS behind it
  // read from the same walk (see `localAgentRowIds`).
  const { used: usedIds, live: liveIds } = localAgentRowIds();
  const used = usedIds.length;
  const live = liveIds.length;
  const settings = useSettingsStore.getState();
  // `enforcedWorkerCap`, and the reason it stays is worth recording (roborev 54780 → 55036).
  //
  // 54780 read this as a dimensional error — `maxConcurrentWorkers` is labelled "per build agent"
  // in the ⋯-menu, so folding it into a machine-wide count would cap the whole machine at the
  // per-agent number. The redirect to `effectiveMaxConcurrentWorkers` that followed was a NO-OP:
  // `hydrateFromConfig` sets `maxConcurrentWorkers = pinned ?? derived` and
  // `effective = pinned === null ? derived : min(pinned, derived)`, so `effective <=
  // maxConcurrentWorkers` is an invariant and `enforcedWorkerCap(s) === effective` identically in
  // every hydrated state. The two expressions differ only in the few hundred ms between
  // `setMaxConcurrentWorkers` and the `config-changed` re-hydrate.
  //
  // SETTLED 2026-07-30 (bead `sparkle-axtkw`): a pin IS machine-wide. It was an open semantic
  // question — the ⋯-menu slider said "per build agent" while config.rs's clamp warning said
  // machine-wide — and the two gates were written as different expressions that agreed only by the
  // invariant above (roborev 55068). Both now read `enforcedWorkerCap` compared against a
  // machine-wide count, so grepping either finds the other.
  //
  // `orchestrationListener.globalGateBinds` is the SIBLING gate and the one that admits spawns; this
  // one is the reading the UI and the concierge quote.
  //
  // They share a THRESHOLD but count DIFFERENT POPULATIONS, and that difference is unresolved rather
  // than designed (roborev 56166, bead `sparkle-dv65b`). This function counts build agents AND workers
  // — a build agent runs its own Claude Code with its own V8 heap, so it costs what a worker costs.
  // `globalUsedSlots()` counts `kind === "worker"` only. So with `max_concurrent = 4`, 3 build agents
  // and 1 worker live, THIS reads at-capacity while the spawn gate sees 1 of 4 and will admit 3 more
  // workers: 7 model processes against a budget of 4. Do not "simplify" these two into one call
  // believing they already agree — they agree on the number, not on what it is counting.
  //
  // The genuinely pin-invariant field, if a future gate wants "what the hardware alone can carry",
  // is `machineMaxConcurrentWorkers` — which is what the ⋯-menu slider's track now uses.
  const staticLimit = Math.max(1, enforcedWorkerCap(settings));
  let limit = staticLimit;
  let basis = concurrencyBasis(settings);

  // Narrow by what the machine ACTUALLY has right now, if anything measured it recently.
  //
  // Everything above this line is a prediction made once at startup from installed RAM and core
  // count; it does not react to Chrome being resident, to an agent running away, or to the
  // compressor thrashing. services/memoryAdmission caches a live reading (polled in App.tsx) so
  // this gate — which must stay SYNCHRONOUS, because both spawn paths and several render paths
  // call it — can consult one without awaiting anything.
  //
  // Strictly one-directional: the sample may only ever LOWER the ceiling. The `Math.min` against
  // `staticLimit` is not redundant with the Rust side's `effective <= static_max` guarantee — it is
  // the frontend refusing to let a backend bug, a version skew, or a tampered payload raise a
  // ceiling that exists to stop the machine being jetsam-killed (sparkle-01xv / sparkle-asz5).
  //
  // No reading, a stale one, or `sampled: false` all mean "no basis to narrow" and leave the
  // reading byte-for-byte as it was before this block existed. An unmeasured machine is not a
  // squeezed one, and the failure mode of getting that backwards is refusing every spawn on the
  // strength of an unrelated backend error.
  const admission = currentMemoryAdmission();
  if (admission && admission.sampled) {
    const narrowed = Math.max(1, Math.min(staticLimit, Math.floor(admission.effective)));
    if (admission.bound === "load") {
      // ── THE LOAD CEILING IS IN A DIFFERENT POPULATION THAN THE COMPARISON (bead
      // `sparkle-e57k99.1`) ─────────────────────────────────────────────────────────────────────
      //
      // Every other number here is a machine CAPACITY — "this many agents fit" — so comparing rows
      // against it is sound, and the deliberate asymmetry documented on `pollMemoryAdmission`
      // (ask in residents, enforce in rows) is what makes a dormant row refuse before it becomes
      // resident one click later. The run-queue number is not that. It is computed FROM the live
      // count we sent (`in_use` + a trickle), so it is denominated in RESIDENT agents. Taking
      // `min(staticLimit, effective)` and comparing `used` against it silently mixed the two, and
      // because `live` is a strict subset of `used` — both come from the same walk in
      // `localAgentRowIds`, where every id pushed to `live` was already pushed to `used` — the
      // result was `used >= live`, which is a TAUTOLOGY. Past 2.0x per core this admitted ZERO
      // agents, permanently, at whatever fleet size was running when the line was crossed. The
      // eight different "limits" reported in one day (42, 62, 60, 53, 53, 50, 49, 49, 37, 20) were
      // never a ceiling; they were the live count at refusal time.
      //
      // So carry the HEADROOM across rather than the number: whatever room the run queue grants on
      // top of the residents, grant on top of the rows. `used >= limit` stays the single comparison
      // every consumer and every message already reads, `live`-vs-`used` never enters it, and the
      // two regimes fall out of the arithmetic — a trickle admits one more per sample, and the hard
      // stop (zero headroom) still refuses outright.
      //
      // The headroom is READ OFF THE WIRE rather than recovered as `effective - live`. The two are
      // equal in production, since `pollMemoryAdmission` sends exactly this `live` as `in_use` — but
      // only by a coupling across a process boundary that nothing checks, and the whole defect here
      // was a number meaning one population being spent against another.
      const headroom = Math.max(0, Math.floor(admission.load_headroom ?? 0));
      limit = Math.max(1, Math.min(staticLimit, used + headroom));
    } else if (narrowed < staticLimit) {
      limit = narrowed;
    }
    // Take the sampled basis ONLY when something actually refused, so the refusal names memory
    // instead of cores. A reading that agrees with the static ceiling must not relabel a CPU-bound
    // machine as memory-bound — naming the wrong dimension is the exact bug `basis` exists to close,
    // and it already sent one human chasing memory that was 94% free (roborev 54175).
    //
    // `bound === "load"` IS such a refusal even when its number does not undercut `staticLimit`
    // (bead `sparkle-iyxxin`). The run queue is a RATE, so its `effective` is "hold at what is
    // already running" — on a fleet already past the enforced cap that lands at or above
    // `staticLimit`, the number-based guard above discards it, and the refusal that DOES happen
    // (`used >= limit`) then cites the static ceiling. That tells a human at 21.5x per-core load to
    // think about hardware they cannot change, when the answer is to wait for the queue to drain.
    // `used >= live` always (see the load block above), which is why the load dimension may NOT be
    // enforced through `narrowed` — it is kept here only for the sentence a human reads.
    if (narrowed < staticLimit || admission.bound === "load") {
      basis = admission.basis?.trim() || basis;
    }
  }

  return { used, live, limit, basis, atCapacity: used >= limit };
}

/**
 * THE at-capacity sentence, in ONE place.
 *
 * Every gate that refuses a spawn has to say the same true things: how many slots are taken, how
 * many of those rows actually have a pane in THIS window, and WHY the ceiling is that number. Each
 * of those was got wrong at least once by a hand-written copy — the ceiling was asserted as
 * "derived from installed RAM" on a machine that was CPU-bound (roborev 54175), and the `live`
 * clause was dropped, which "sent a human looking for agents that would start later when they were
 * already running" (roborev 54225).
 *
 * A second refusal site immediately re-introduced the second of those (roborev 55136), which is the
 * argument for this function existing rather than for fixing the copy again: two gates that must
 * agree cannot be kept in agreement by discipline.
 *
 * `lead` is the caller's own first clause — what was refused and why it costs a slot — so each site
 * keeps its specific framing while sharing every factual claim.
 */
export function atCapacitySentence(capacity: CapacityReading, lead: string): string {
  // `live < used` is normal, not a bug: a row in a project tab the user hasn't opened holds a slot
  // without holding a process. Saying so is the difference between an actionable refusal and one
  // that reads as a miscount.
  const dormant =
    capacity.live < capacity.used
      ? ` (${capacity.live} of them showing in this window; the rest are in project tabs that ` +
        `aren't open here — most are already running, they're just not on screen)`
      : "";
  return (
    `${lead} This machine has ${capacity.used} of its ${capacity.limit} agent slots taken${dormant}. ` +
    `The ceiling is ${capacity.basis}. Close or finish one before starting another.`
  );
}

/**
 * One poll of the live memory reading. Called on an interval from `App.tsx`.
 *
 * This exists as a named function here, rather than as two lines inline in the effect, for one
 * reason: **which count gets sent is a correctness decision, and inline in `App.tsx` it was not
 * unit-testable.** It shipped wrong once (roborev 55383) — `used` instead of `live` — and nothing
 * could have caught it, because the only assertion available was that some number was forwarded.
 *
 * `live`, not `used`. Rust's `sampled_admission` returns `in_use + available/per_agent`, adding
 * `in_use` back because agents that are already running have already been subtracted from
 * `available_bytes`. That premise is true only of agents that actually hold memory. `used` counts
 * every row, including rows in project tabs the user has never opened — no PTY, no footprint — so
 * crediting them with a per-agent share inflates the ceiling by `(used - live) × per_agent`, in the
 * permissive direction, which stopped the available-memory bound from narrowing at all.
 *
 * Note the asymmetry with the gate below, which is deliberate: we ask the question in RESIDENT
 * agents (what memory has actually been consumed) and enforce the answer against ROWS (`used >=
 * limit`), because a dormant row becomes resident the moment its tab is clicked, with no gate in
 * between. Sending `live` and comparing `used` is what makes the ceiling mean "agents this machine
 * can hold" while still refusing rows it cannot hold one click later.
 */
export function pollMemoryAdmission(): Promise<void> {
  return refreshMemoryAdmission(localAgentCapacity().live);
}
