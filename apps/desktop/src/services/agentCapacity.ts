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
import {
  ceilingInPopulationOf,
  countWhenReadingArrived,
  currentMemoryAdmissionReading,
  refreshMemoryAdmission,
} from "./memoryAdmission";
import { mountedPaneCount } from "./paneResidencyAdmission";
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
  const reading = currentMemoryAdmissionReading();
  const admission = reading?.admission ?? null;
  // Set inside the load branch below: true when the MEMORY term is the one that produced `limit`,
  // even though Rust attributed the reading to the run queue. Drives which sentence the refusal
  // quotes; see the note at the assignment.
  let loadPathMemoryBinds = false;
  if (reading && admission && admission.sampled) {
    // ── EVERY CEILING ON THIS PAYLOAD IS DENOMINATED IN RESIDENTS. TRANSLATE ONCE, HERE (bead
    // `sparkle-ftapmp`) ──────────────────────────────────────────────────────────────────────────
    //
    // Rust's `sampled_admission` returns `in_use + available/per_agent`, and `pollMemoryAdmission`
    // sends `live` as that `in_use`. So `effective` and `memory_admitted` both count RESIDENT
    // agents — while the one comparison every consumer reads is `used >= limit`, which counts ROWS.
    // The load branch below was already fixed for exactly this class (`sparkle-e57k99.1`); the
    // memory term was not, and it is the same defect:
    //
    //   MEASURED 2026-09-04 — 60 rows, 21 residents, 26 GiB free, `memory_admitted` 39. `limit`
    //   became `min(static, 39)` and `used(60) >= 39` refused. Retiring one agent moved `used`
    //   60→59 AND `limit` 39→38, because the retire lowered `live` too — the gap stayed exactly
    //   21 and no action available to anyone could close it. Every dormant row cost a slot twice:
    //   it inflated the left side and contributed nothing to the right.
    //
    // So carry the HEADROOM across instead of the number, exactly as the load branch does: whatever
    // room the reading grants on top of the residents it measured, grant on top of the rows.
    //
    // THE HEADROOM IS SIGNED, and that is load-bearing rather than sloppy. A ceiling BELOW the
    // resident count is a real over-commit — `by_level` collapses `admitted` to `in_use` under
    // critical pressure, and `static_max` can clamp it under `in_use` outright — and clamping the
    // subtraction at zero would silently forgive it, turning "you are already past what memory
    // holds" into "no opinion". `Math.max(1, Math.min(staticLimit, …))` at each use site is what
    // keeps the two standing invariants: never below 1, and NEVER ABOVE `staticLimit`.
    //
    // `reading.inUse` — NOT `live` — is what the headroom is measured from. They are equal in
    // production (`pollMemoryAdmission` sends this module's own `live`), but only across a poll
    // boundary the fleet can move over, and `AGENTS.md` records the cost of subtracting a count of
    // your own from a number built on someone else's: it is how a rate's ceiling came to equal the
    // count it was compared against. `memoryAdmission` remembers what it SENT so this line does not
    // have to guess.
    // ONE shared translation, in `memoryAdmission` beside the denomination it is about, because
    // `orchestrationListener.globalGateBinds` needs the identical displacement against a WORKER-only
    // count and the first cut of this fix left that gate comparing raw (roborev 81139, High).
    //
    // ANCHORED, NOT LIVE (roborev 81142, High). Displacing by `used` AT GATE TIME puts it on both
    // sides of `used >= limit`, where it cancels: the comparison reduces to `headroom <= 0 || used >=
    // staticLimit`, so a reading saying "room for exactly one more" admits row after row up to the
    // static ceiling, spending the same allowance every call. The headroom is a per-SAMPLE grant, so
    // the count it is added to has to be the one that was true at that sample.
    //
    // THE ALLOWANCE THIS BRANCH ACTUALLY ENFORCES, so `countWhenReadingArrived` can tell a fleet
    // that grew INTO its ceiling (hold the anchor — that is the cancellation it exists to stop)
    // from one already PAST it (retake — the anchor is about a different fleet).
    //
    // NARROWEST, NOT WIDEST, and getting that backwards left the whole fix inert on the load branch
    // (roborev 81181, High). The enforced ceiling there is `min(anchor + memoryHeadroom,
    // anchor + load_headroom)` and `load_headroom` is 0 or 1 BY CONSTRUCTION, while
    // `memory_admitted` is `static_max` whenever RAM is not the constraint — which is precisely when
    // Rust attributes a reading to the queue. Asking the retake question with the max held the
    // anchor until the count passed `anchor + 81` while the gate refused at `anchor + 1`: on this
    // machine's own normal 2.6-5.9x per-core band, a render in the hydration gap anchored 0 and the
    // 60 rows that followed read as `limit = 1`, at capacity, quoting the throttle sentence.
    //
    // A term that is not anchor-relative contributes NO constraint, hence the infinity: a payload
    // predating `memory_admitted` puts the bare `staticLimit` into the `min` below, which the anchor
    // cannot move, so it must not narrow the retake question either.
    const memoryRoom =
      admission.memory_admitted === undefined
        ? Number.POSITIVE_INFINITY
        : Math.floor(admission.memory_admitted) - reading.inUse;
    const anchorRoom =
      admission.bound === "load"
        ? Math.min(memoryRoom, Math.max(0, Math.floor(admission.load_headroom ?? 0)))
        : Math.floor(admission.effective) - reading.inUse;
    const rowsAtReading = countWhenReadingArrived("rows", reading.seq, used, anchorRoom);
    const residentsToRows = (residents: number): number =>
      ceilingInPopulationOf(residents, rowsAtReading, reading.inUse);
    const narrowed = Math.max(
      1,
      Math.min(staticLimit, residentsToRows(Math.floor(admission.effective))),
    );
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
      // ANCHORED for the same reason the memory term is (roborev 81142, High): `used + headroom`
      // with a LIVE `used` cancels against `used >= limit`, so a trickle of 1 admitted rows without
      // bound within a poll window rather than the one per sample its own comment promises.
      const headroom = Math.max(0, Math.floor(admission.load_headroom ?? 0));
      // CLAMPED BY MEMORY TOO, because `bound` is not a partition (roborev, High). `bound === "load"`
      // does NOT mean memory declined to narrow — `load_binds` is true whenever the queue has an
      // opinion and memory is not already holding at or below it, so this branch is reached with a
      // real RAM-derived ceiling in hand. Spending run-queue headroom without it re-opens exactly the
      // jetsam path the memory sampler exists to close: measured on the failure this fix was reviewed
      // against, RAM said room for 6 and this branch would have admitted 31.
      //
      // …AND IT IS TRANSLATED TO ROWS FIRST (bead `sparkle-ftapmp`). `memory_admitted` is residents,
      // `byLoad` is rows, and this line used to `min` them directly — the very mismatch the comment
      // three lines below already NAMED, and then answered by fixing which SENTENCE gets quoted
      // rather than the arithmetic. Both terms are rows now, so the `min` compares like with like
      // and the memory clamp still binds whenever RAM is genuinely the tighter of the two.
      //
      // A payload PREDATING `memory_admitted` contributes `staticLimit` DIRECTLY, not
      // `residentsToRows(staticLimit)`. The field's own contract is "absent means memory had no
      // opinion", and a no-opinion term must be inert; pushing the static ceiling through the
      // translation would make it depend on `used - inUse`, so a reading taken while the fleet was
      // larger than it is now would narrow on the strength of a field that was never sent.
      const byMemory =
        admission.memory_admitted === undefined
          ? staticLimit
          : residentsToRows(Math.floor(admission.memory_admitted));
      const byLoad = rowsAtReading + headroom;
      limit = Math.max(1, Math.min(staticLimit, byMemory, byLoad));
      // WHICH TERM BOUND IS NOW A REAL QUESTION, and getting it wrong writes a dead instruction
      // (roborev, High). Rust attributes this reading to the queue — `load_binds` is true only when
      // the queue's ceiling is BELOW memory's, measured in RESIDENTS. Both terms are rows by the
      // time they reach this line, and the two orderings still come apart: the translation displaces
      // the memory term by `used - inUse` while the queue's is `used + headroom`, so with a stale or
      // simply different resident count the memory term can be the smaller one HERE while `bound`
      // still says `"load"`. Quoting the queue then tells a human to wait for it to drain, which
      // will never help, while available RAM is the actual constraint. That is the same
      // misattribution that once sent someone chasing memory 94% free, pointed the other way.
      loadPathMemoryBinds = byMemory < byLoad && byMemory < staticLimit;
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
      // Name the term that bound, not the dimension Rust attributed the reading to. `memory_basis`
      // is absent on a payload predating it, which falls back to exactly what this line said before.
      const preferred = loadPathMemoryBinds ? admission.memory_basis : undefined;
      basis = preferred?.trim() || admission.basis?.trim() || basis;
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
  //
  // ── IT MAY NOT CLAIM A PROCESS STATE IN EITHER DIRECTION, AND BOTH DIRECTIONS HAVE BEEN WRONG
  // HERE ────────────────────────────────────────────────────────────────────────────────────────
  //
  // The clause has now been corrected twice, in opposite directions, and the resolution is that it
  // must make no claim at all.
  //
  //   • BUG 1 OF THE CEILING AUDIT retracted "you haven't opened yet, and each one starts as soon as
  //     you do": closed-tab projects were observed with a running-agent count equal to their full
  //     roster, so the sentence sent a human hunting for processes that were already up.
  //   • THEN THAT CORRECTION OVERSHOT into "most are already running, they're just not on screen",
  //     and bead `sparkle-ftapmp` measured it false: on 2026-09-04 this machine held 60 rows while
  //     `ps -Ao rss,comm` found TWENTY real `claude` processes between them, 5.8 GiB in total. That
  //     sentence is why counting those rows against a memory ceiling read as defensible to every
  //     reviewer who looked at it.
  //
  // Both observations are true of different rows, and `live` cannot separate them: it measures
  // "has a mounted pane IN THIS WINDOW", which is neither "is running" nor "is not". So the clause
  // reports exactly that and stops — the count is of SLOTS, and the copy says so rather than
  // implying a process count in either direction.
  const dormant =
    capacity.live < capacity.used
      ? ` (${capacity.live} of them showing in this window; the rest are in project tabs that ` +
        `aren't open here — this window can't tell which of those still hold a running process, ` +
        `so the count is of slots, not of processes)`
      : "";
  // "N of its M slots taken" IS ONLY TRUE WHILE N <= M, and a runtime narrowing routinely breaks
  // that. `limit` is `min(staticLimit, effective)`, and `effective` lands BELOW the row count in
  // both dimensions: the run queue answers `in_use` plus a trickle, where `in_use` is `live` — a
  // strict subset of `used` from one walk in `localAgentRowIds` — and memory reaches the same shape
  // whenever a freshly-narrowed ceiling lands under a row count admitted before the pressure. So a
  // machine holding 40 rows with 20 panes mounted rendered "has 40 of its 21 agent slots taken", a
  // sentence whose own two numbers contradict each other, shown at the exact moment a human is
  // trying to work out what went wrong (bead `sparkle-e57k99.1`). It keys on the ARITHMETIC rather
  // than on `bound`, because the dimension that narrowed is not what makes the claim false.
  //
  // The over-ceiling wording stops presenting the pair as a fraction — there is no honest way to
  // call 21 a number of slots taken while 40 are occupied — but it deliberately KEEPS the phrase
  // "agent slots". That is not stylistic: `components/Concierge/refusalAudience` classifies a
  // refusal by matching `/\bagent slots?\b/i` to decide it is an internal gate the concierge can
  // route around rather than red text for the founder. Rewording this clause out of that lexicon
  // would silently reclassify every capacity refusal as founder-facing — a fix relocating a bug
  // into the copy that describes it, and nothing would go red for it, because the classifier's own
  // tests assert against strings hand-typed into its file. `agentCapacity.test.ts` pins the
  // coupling on the sentence this function actually produces, so the next rewrite fails loudly.
  const holding =
    capacity.used > capacity.limit
      ? `is holding ${capacity.used} agents against ${capacity.limit} agent slots — more than it ` +
        `can take right now`
      : `has ${capacity.used} of its ${capacity.limit} agent slots taken`;
  return (
    `${lead} This machine ${holding}${dormant}. ` +
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
 * ── THE ASYMMETRY THIS NOTE USED TO DEFEND IS GONE (bead `sparkle-ftapmp`) ────────────────────────
 * It read: "we ask the question in RESIDENT agents and enforce the answer against ROWS, because a
 * dormant row becomes resident the moment its tab is clicked, with no gate in between." The premise
 * was true and the conclusion did not follow. Spending a residents-denominated ceiling against rows
 * is not a conservative rounding — it is a ONE-WAY RATCHET, because retiring an agent lowers `used`
 * and `live` together and therefore lowers both sides of the comparison by one. Measured 2026-09-04:
 * two refusals 90 seconds apart with one retire between them moved `used` 60→59 and `limit` 39→38;
 * the gap stayed exactly 21, and no action available to the concierge or to a human could ever close
 * it. `localAgentCapacity` now translates the ceiling into rows before comparing.
 *
 * SO THE "NO GATE IN BETWEEN" HALF HAD TO BE SUPPLIED, and it was: `services/paneResidencyAdmission`
 * + `hooks/usePaneResidencyAdmission` hold back a dormant row's pane when the machine is genuinely at
 * its residents ceiling, visibly (a banner) and recoverably (the next poll releases it). That is the
 * gate whose absence justified the mismatch. Removing one without the other would over-commit the
 * machine, which is the jetsam path all of this exists to close.
 */
export function pollMemoryAdmission(): Promise<void> {
  // ── WHAT `live` IS A PROXY FOR, AND WHERE THE PROXY BROKE (roborev 81145, High) ───────────────
  //
  // `live` is `openAgentIds ∩ visited projects` — a good stand-in for "holds a process" right up
  // until something started DEFERRING those mounts, at which point it counts rows that hold nothing.
  // Feeding it back as `in_use` made the residency ceiling a function of the very count it is spent
  // against: Rust returns `in_use + available/per_agent` and a reading at or above the static
  // ceiling is discarded, so every surviving ceiling was `>= live` and the mount gate could never
  // bind. Verified exhaustively — zero deferrable states over the whole reachable space.
  //
  // The gate publishes what it has actually mounted, so send that. `null` means it has never run in
  // this window, and the fallback is the old number exactly: an unmeasured window is not an empty
  // one, and sending 0 would report a machine with no residents and narrow the ceiling on a fiction.
  return refreshMemoryAdmission(mountedPaneCount() ?? localAgentCapacity().live);
}

/**
 * THE CEILING IN RESIDENTS — how many agents may hold a process on this machine right now, or `null`
 * when there is no basis to hold anything back.
 *
 * The mount gate's counterpart to `localAgentCapacity().limit`, and the two are deliberately in
 * DIFFERENT denominations because they answer different questions. `limit` is rows, and gates
 * SPAWNING (may this machine acquire another row?). This is residents, and gates RESIDENCY (may
 * another row acquire a process?). Both are the same reading translated for the population being
 * counted; that they must agree in denomination with their own comparison is the whole of bead
 * `sparkle-ftapmp`.
 *
 * `null` — no reading, a stale one, `sampled: false`, or a reading in which MEMORY DID NOT NARROW —
 * means "no basis", and every caller must then behave byte-for-byte as it did before this existed.
 * The last of those four is the important one: a healthy machine's `memory_admitted` equals
 * `static_max`, and treating the static prediction as a residency ceiling would start deferring
 * panes on machines that have never been measured to be short of anything. A gate that fires when
 * nothing is wrong gets switched off, and then the class is unguarded.
 */
export function residentAdmissionCeiling(): number | null {
  return residentAdmission()?.ceiling ?? null;
}

/**
 * The SENTENCE that goes with {@link residentAdmissionCeiling}, or `null` when there is no ceiling.
 *
 * IT MUST NOT BE TAKEN FROM `CapacityReading.basis` (roborev 81141, High). That one explains the
 * ROW ceiling and is only replaced by a memory sentence when the ROW comparison narrowed —
 * `narrowed < staticLimit || bound === "load"` — which is a different condition from the one this
 * ceiling fires on. They come apart in exactly the shape this bead is about: at 60 rows, 21
 * residents and `memory_admitted` 39, the row ceiling is `60 + 18 = 78`, i.e. NOT narrowed, so
 * `basis` is still `"CPU-bound: 6 cores × 2 agents per core"` while the residents ceiling is a live
 * 39. A bar reading "this machine is at the number of agents its memory can hold (CPU-bound: …)"
 * is the wrong-dimension attribution `basis` exists to prevent, and it has already sent one human
 * chasing memory that was 94% free.
 *
 * So the number and its explanation come out of ONE branch, here. `memory_basis` is the sentence
 * Rust composed next to `memory_admitted`; `basis` is the fallback for a payload predating it, and a
 * blank one yields `null` rather than an empty parenthetical — a causeless number beats a wrong
 * cause, exactly as `localAgentCapacity` decides it.
 */
export function residentAdmissionBasis(): string | null {
  return residentAdmission()?.basis ?? null;
}

/** The residency ceiling and its sentence, derived together so the two cannot disagree. `null` when
 *  there is no basis to hold anything back — see {@link residentAdmissionCeiling}. */
function residentAdmission(): { ceiling: number; basis: string | null } | null {
  const reading = currentMemoryAdmissionReading();
  const admission = reading?.admission;
  if (!admission || !admission.sampled) return null;
  const admitted = admission.memory_admitted;
  // Memory had no opinion (absent field, or a ceiling that did not undercut the static one).
  if (admitted === undefined || !Number.isFinite(admitted) || admitted >= admission.static_max) {
    return null;
  }
  // Same one-directional rule as `limit`: a sample may only ever LOWER a ceiling. The `Math.min`
  // against the enforced cap is the frontend refusing to let a backend bug or a tampered payload
  // raise one (sparkle-01xv / sparkle-asz5); the `Math.max(1, …)` is so a squeezed machine still
  // lets the user see ONE pane rather than going blank.
  const staticLimit = Math.max(1, enforcedWorkerCap(useSettingsStore.getState()));
  return {
    ceiling: Math.max(1, Math.min(staticLimit, Math.floor(admitted))),
    basis: admission.memory_basis?.trim() || admission.basis?.trim() || null,
  };
}
