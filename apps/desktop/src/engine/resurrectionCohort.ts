// resurrectionCohort — when N agents die of one cause, send ONE back first and make it prove the
// door is open before the rest follow.
//
// ── THE FAILURE THIS CLOSES ───────────────────────────────────────────────────────────────────
// On 2026-08-06 the desktop app quit at 18:20 — 54 SessionEnd in ONE minute — relaunched at 18:21,
// and 45 panes resumed in that single minute. Twenty-six minutes later it was down again, taking 49
// more agents, and exactly one came back. Whatever else was true that evening, "45 simultaneous
// `claude --resume` boots against one account" is not a recovery strategy; it is the same fleet-wide
// retry that burns a reset. Separately, 1,102 sessions have hit an account wall since 2026-07-01 and
// one of them retried into the closed door 45 times.
//
// So: a shared cause is ONE incident, not N problems, and it gets ONE probe.
//
// ── COHORT IDENTITY IS BORROWED, NOT INVENTED ─────────────────────────────────────────────────
// `packages/core/pusherFleet.sharedFailureCohorts` already groups agents by the VERBATIM failure
// message inside a 15-minute window with a >=2-victim floor. Its constants are imported here rather
// than restated. The ONE string this module synthesizes is for an app restart, which prints nothing
// at all because nobody was alive to print it — and an epoch is a fact, not a classification.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// A fleet-wide wall gates every LLM in the app behind the same account limit. Election, probation
// and release are comparisons over timestamps and ids.
//
// PURE. Data in, data out; the clock arrives as a parameter.
import { SHARED_FAILURE_MIN_VICTIMS, SHARED_FAILURE_WINDOW_MINUTES } from "@sparkle/core";

import type { DeathCause } from "./deathTypes";

/**
 * How long a canary must survive before the rest are released.
 *
 * A STARTING POLICY, not a measurement, and it must keep saying so until observation replaces it.
 * Chosen against two numbers that already exist: it is 4x `goalContinuation.IDLE_SETTLE_MS` (45s),
 * comfortably longer than a `--resume` transcript repaint, and small against the 1h26m respawn
 * ladder so a wrong guess costs one window rather than an hour.
 */
export const PROBATION_MS = 180_000;

/** Released per batch, and the gap between batches. A drain, not a flood: 49 agents return over
 *  ~4 minutes instead of in one minute, which is what the measured relaunch did. */
export const RELEASE_BATCH = 4;
export const RELEASE_BATCH_INTERVAL_MS = 20_000;

/** Canaries a cohort may burn before it gives up and asks a human. Each failure elects a DIFFERENT
 *  victim, so one poisoned worktree cannot condemn 48 healthy agents. */
export const MAX_CANARY_ATTEMPTS = 3;

/** One dead agent, as the cohort logic needs to see it. */
export interface CohortMember {
  agentId: string;
  cause: DeathCause;
  /** VERBATIM. Never trimmed or re-cased — grouping is exact-equality, and a shared-outage report
   *  has already silently never fired because two agents' bytes differed by a newline. */
  message: string | undefined;
  /** The app-launch epoch that owned this agent, for app-restart grouping. */
  epoch: string | undefined;
  diedAt: number;
  /** Durable respawn count, used only as a tie-break so election is deterministic. */
  attempts: number;
}

export type ProbationFailure =
  /** It died again. */
  | "exited"
  /** The wall came back. */
  | "re-walled"
  /** A fresh API banner, after the respawn. */
  | "api-banner"
  /** It booted but never proved it ran a turn. */
  | "no-turn-authority"
  /** It booted and ran nothing. */
  | "no-work";

export type CohortPhase =
  | { phase: "observed"; victims: readonly string[]; since: number }
  | { phase: "canary-elected"; canaryId: string; electedAt: number; attempt: number }
  | { phase: "probation"; canaryId: string; spawnedAt: number; attempt: number }
  | { phase: "released"; canaryId: string; releasedAt: number; drained: readonly string[] }
  | { phase: "failed"; canaryId: string; failedAt: number; attempt: number; why: ProbationFailure }
  | { phase: "abandoned"; at: number; why: string };

/**
 * The key that says "these deaths are the same incident".
 *
 * An app restart prints nothing — the process was killed, nobody wrote a banner — so it groups on
 * its dead epoch instead. This is the only synthesized key, and it is safe precisely because it
 * carries no judgement: an epoch either was or was not the one that died.
 */
export function cohortKeyOf(m: CohortMember): string {
  if (m.cause === "app-restart") return `app-restart:${m.epoch ?? "unknown-epoch"}`;
  return `${m.cause}:${m.message ?? ""}`;
}

/**
 * Group deaths into cohorts. A group of one is NOT a cohort — one agent's death is that agent's bad
 * luck, and treating it as an incident would put every single failure through a 3-minute probation.
 *
 * The window is RELATIVE: deaths are measured against EACH OTHER, not against `now`, so a cohort
 * discovered an hour later still groups correctly.
 *
 * ── HOW THE CLUSTERING GOT HERE, IN THREE STEPS, BECAUSE TWO OF THEM WERE WRONG ──────────────
 * The failure mode to keep in mind throughout: a member DROPPED from every cluster is read by the
 * caller as a lone death, which skips the canary and respawns it in parallel. That is the flood this
 * module exists to prevent, so dropping is far worse than over-including.
 *
 *  1. ANCHORED on each key's newest death (roborev 60067) — destroyed data. Given T, T+1s, T+60min,
 *     only the last survived the filter, fell below the victim floor, and the whole key vanished, so
 *     the pair that genuinely died together at T was returned in no cohort at all.
 *  2. GAP-TO-PREVIOUS (roborev 60074) — chained without bound. One death every 14 minutes against a
 *     15-minute window never opens a gap, so an afternoon of unrelated failures became one
 *     multi-hour "incident" and the canary held back agents with nothing to do with each other.
 *  3. LINK, THEN SPLIT, THEN RE-ATTACH (roborev 60081) — what is here now, and it exists because
 *     span-splitting ALONE reintroduced (1). Splitting greedily from a run's first member is a
 *     greedy cut: T, T+15m, T+16m puts the first two in a cluster and strands T+16m as a singleton,
 *     which the victim floor then discards — an agent that died 60 seconds after a cohort member, of
 *     the identical cause, respawned past the canary. That is the realistic account-wall shape, not
 *     a contrived one: agents hit a wall one at a time as each starts a turn.
 *
 * So: single-link by gap first (nothing linked is ever separated), split an over-long chain to keep
 * spans bounded, then re-attach any sub-floor remainder to the cluster it was cut from. A genuinely
 * isolated death, with no linked neighbour at all, is still correctly no cohort.
 *
 * SPAN BOUND, STATED HONESTLY: a cluster spans at most `SHARED_FAILURE_MIN_VICTIMS x window`, not a
 * flat 2x (roborev 60101). The re-attach can fold a sub-floor remainder into its neighbour, and at a
 * floor of 2 that is one extra window — hence 2x today. At a floor of 3 the fixed-point merge can
 * fold `[2,3,2]` into one cluster and the bound is 3x. The bound therefore tracks that imported
 * constant; it is not an independent property, and the previous flat claim was wrong.
 */
export function groupCohorts(members: readonly CohortMember[]): Map<string, CohortMember[]> {
  const windowMs = SHARED_FAILURE_WINDOW_MINUTES * 60_000;
  const byKey = new Map<string, CohortMember[]>();
  for (const m of members) {
    const key = cohortKeyOf(m);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else byKey.set(key, [m]);
  }

  const out = new Map<string, CohortMember[]>();
  for (const [key, bucket] of byKey) {
    const sorted = [...bucket].sort((a, b) => a.diedAt - b.diedAt);

    // 1. SINGLE-LINK by gap. Anything transitively within one window of a neighbour stays together,
    //    which is the property that makes dropping a linked member impossible below.
    const chains: CohortMember[][] = [];
    for (const m of sorted) {
      const chain = chains[chains.length - 1];
      const prev = chain?.[chain.length - 1];
      if (chain && prev && m.diedAt - prev.diedAt <= windowMs) chain.push(m);
      else chains.push([m]);
    }

    for (const chain of chains) {
      // 2. SPLIT an over-long chain so a slow drip cannot present as one hours-long incident.
      const clusters: CohortMember[][] = [];
      for (const m of chain) {
        const run = clusters[clusters.length - 1];
        const first = run?.[0];
        if (run && first && m.diedAt - first.diedAt <= windowMs) run.push(m);
        else clusters.push([m]);
      }

      // 3. RE-ATTACH a sub-floor remainder to the cluster it was cut from. Without this, the greedy
      //    cut in (2) strands a member the chain says belongs — the very data loss (1) and (2) were
      //    each written to remove.
      // Merge BACKWARD, then forward for the head, and iterate — so the guarantee does not quietly
      // depend on SHARED_FAILURE_MIN_VICTIMS happening to be 2 (roborev 60089). That constant is
      // imported from another package and can change without this file being touched; at a floor of
      // 3 a chain splitting as [A(2), B(3)] would leave A sub-floor at index 0, unmergeable by a
      // backward-only pass, and discarded — stranding the very linked members this exists to keep.
      let merged = true;
      while (merged && clusters.length > 1) {
        merged = false;
        for (let i = clusters.length - 1; i > 0; i--) {
          if (clusters[i]!.length < SHARED_FAILURE_MIN_VICTIMS) {
            clusters[i - 1]!.push(...clusters[i]!);
            clusters.splice(i, 1);
            merged = true;
          }
        }
        if (clusters.length > 1 && clusters[0]!.length < SHARED_FAILURE_MIN_VICTIMS) {
          clusters[1]!.unshift(...clusters[0]!);
          clusters.splice(0, 1);
          merged = true;
        }
      }

      for (const run of clusters) {
        // A lone death with no linked neighbour is not an incident — that is the one discard, and it
        // is correct: one agent's death is that agent's bad luck.
        if (run.length < SHARED_FAILURE_MIN_VICTIMS) continue;
        // KEY DERIVED FROM CONTENT, NEVER FROM POSITION (roborev 60081). A positional `#1` suffix is
        // not stable across recomputations: `groupCohorts` is pure and gets re-run as the death list
        // evolves, so when an earlier cluster's members are resurrected or age out, the next cluster
        // slides into index 0, changes key, and INHERITS whatever CohortPhase the caller stored
        // under the old key. If that phase were `released`, the caller would hand back a whole batch
        // with no canary. Anchoring on the first death makes a cluster's identity independent of
        // whether any sibling exists.
        out.set(`${key}@${run[0]!.diedAt}`, run);
      }
    }
  }
  return out;
}

/**
 * Keep a cohort's identity STABLE as its members are resurrected and leave the input.
 *
 * `groupCohorts` is a pure function of the CURRENT death list, and no pure function of that list can
 * give a cohort an identity that survives its own members leaving (roborev 60089). The anchor is the
 * earliest death — and `electCanary` picks the earliest death — so the canary is ALWAYS the member
 * whose departure changes the key. Left alone, that is not a corner case but the guaranteed path:
 * the moment a canary is resurrected, its cohort's `released` phase is orphaned, the remainder
 * restarts at a fresh canary and another full probation, and a 49-agent recovery degrades from one
 * drained release into ~3 minutes per agent, serialized. The mirror hazard is worse: a key can be
 * RE-CREATED later with different membership, and a stale `released` phase under it hands those new
 * members straight back with no canary at all.
 *
 * So identity is pinned OUTSIDE the grouping, here: once an agent has been seen in a cohort, it
 * keeps that cohort's key, and a cluster containing any already-bound agent inherits their key
 * rather than minting a new one. Still pure — the previous binding arrives as an argument — and it
 * is the caller's job to carry the returned binding forward with its phases.
 */
export function stabilizeCohortKeys(
  previous: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, CohortMember[]>,
): {
  groups: Map<string, CohortMember[]>;
  binding: Map<string, string>;
  /** For each freshly-minted key, the prior key it supersedes — when there was exactly one.
   *
   *  IDENTITY AND EVIDENCE ARE DIFFERENT QUESTIONS, and collapsing them starved the drain (roborev
   *  60113). Minting fresh for a newcomer is right for identity: the caller must not silently apply
   *  an older cohort's `released` to agents it never vetted. But discarding the cohort's evidence
   *  along with its name means one trickling death mid-drain sends 40 already-vetted agents back
   *  through a full probation — and since the next tick re-binds everyone again, a steady drip
   *  admits nothing but canaries and the drain never finishes. That is starvation, not the "slow is
   *  recoverable" cost claimed above.
   *
   *  So the fresh key is still minted, and this says what it replaced. A caller holding a `released`
   *  phase whose canary is still proven can carry it forward and append the newcomers to the drain
   *  queue; a caller looking at a genuinely unrelated incident sees no entry and starts clean. The
   *  decision stays with whoever holds the phase rather than being made here. */
  supersedes: Map<string, string>;
} {
  /** How long a departed member's binding still counts as "this incident" (roborev 60120).
   *
   *  Retention without an expiry is not memory, it is a permanent claim. A `wall-session` cohort
   *  that fully drains leaves every member bound to its key forever — so when the identical verbatim
   *  message recurs days later (spend-cap banners name no reset and repeat exactly), every member is
   *  bound, `allBound` holds, and an unrelated incident inherits the old `released` phase and
   *  releases the whole fleet with no canary. Bounding it by the widest a single incident can be
   *  makes a return a return and a recurrence a new incident. */
  const RETURN_WINDOW_MS =
    SHARED_FAILURE_MIN_VICTIMS * SHARED_FAILURE_WINDOW_MINUTES * 60_000;

  /** The anchor instant a key was minted from, or `undefined` if it does not parse. */
  const anchorOf = (key: string): number | undefined => {
    const at = key.lastIndexOf("@");
    if (at < 0) return undefined;
    const tail = key.slice(at + 1).split("~")[0] ?? "";
    const n = Number(tail);
    return Number.isFinite(n) ? n : undefined;
  };

  const outGroups = new Map<string, CohortMember[]>();
  // RETAINED, not rebuilt (roborev 60113). Carrying only the current members forward dropped a
  // respawned canary from the binding, so when it failed the way `advanceProbation` expects — and
  // re-entered the death list ~3 minutes later, inside its own cohort's window — it read as an
  // unbound NEWCOMER. One newcomer re-keyed the cohort, orphaning the phase that holds `attempt`
  // and the burned set, so `afterFailure` restarted at attempt 1 forever: MAX_CANARY_ATTEMPTS
  // unreachable, `abandoned` unreachable, no human ever asked, and a burned victim re-electable.
  // A member that LEAVES keeps its binding, so its return is a return rather than an arrival.
  const binding = new Map<string, string>(previous);
  const supersedes = new Map<string, string>();

  for (const [freshKey, members] of groups) {
    // INHERIT ONLY WHEN UNAMBIGUOUS. If this cluster's carried-over members all came from ONE prior
    // cohort, they keep its identity — that is the case that matters, an incident shrinking as its
    // members are resurrected, and it is what stops a 49-agent recovery restarting its probation
    // after every single one.
    //
    // If they came from SEVERAL prior cohorts, two identities have merged and no rule can preserve
    // both. Mint a fresh key rather than picking a winner: a fresh key means a fresh canary, which
    // costs one probation window, whereas inheriting the wrong one can hand a merged group to a
    // stale `released` phase and release it with no canary at all. Slow is recoverable; a flood is
    // the thing this module exists to prevent.
    // EVERY member must be bound, and to the SAME key. An unbound member is a newcomer, and a
    // cluster that GREW is not the cohort whose phase the caller stored (roborev 60101).
    //
    // Looking only at the members that happened to be bound was the same hazard one layer up:
    // cohort K={A,B} reaches `released` after canary A proves the door is open; B has not been
    // respawned yet; three fresh deaths C,D,E hit the same wall and cluster with B. C/D/E are
    // unbound, so the old rule saw priorKeys={K}, size 1, inherited K — and the caller's `released`
    // phase handed C, D and E straight back with no canary and no probation. A brand-new incident
    // released on the strength of an older one's evidence.
    const priorKeys = new Set<string>();
    const returning = new Set<string>();
    let allBound = true;
    for (const m of members) {
      const bound = previous.get(m.agentId);
      // A binding older than one incident's width is a RECURRENCE, not a return, so the agent reads
      // as unbound and a fresh key (and a fresh canary) is minted.
      // ANCHOR TO ANCHOR, not anchor to death (roborev 60127). Measuring the member's NEW death
      // against its old key's anchor is narrower than what `groupCohorts` can actually cluster: a
      // re-death may land up to `span bound + link window` (45 min) from the anchor and still be
      // single-linked into the same cohort, while this window is 30. That 15-minute band is where a
      // canary re-dies INTO its own cohort and yet reads as a stranger — 60113 verbatim, with the
      // attempt counter and burned set orphaned. Comparing the two keys' anchors bounds retention by
      // the incident itself, which is the thing being identified, and still fails a days-later
      // recurrence of the identical message.
      const boundAnchor = bound === undefined ? undefined : anchorOf(bound);
      const clusterAnchor = anchorOf(freshKey);
      const isReturn =
        bound !== undefined &&
        boundAnchor !== undefined &&
        clusterAnchor !== undefined &&
        Math.abs(clusterAnchor - boundAnchor) <= RETURN_WINDOW_MS;
      if (!isReturn) allBound = false;
      else {
        priorKeys.add(bound);
        returning.add(m.agentId);
      }
    }
    const candidate = priorKeys.size === 1 ? [...priorKeys][0]! : undefined;
    // …and the inherited key must belong to THIS cohort's namespace. A bound agent can die again
    // under a different cause, and without this an unrelated cause's key would be carried over.
    const sameNamespace =
      candidate !== undefined && candidate.slice(0, candidate.lastIndexOf("@")) === freshKey.slice(0, freshKey.lastIndexOf("@"));

    // A key already taken by another cluster is NOT merged into (roborev 60101). Concatenating two
    // clusters that `groupCohorts` deliberately separated undoes the span bounding, and because the
    // merge re-binds every member to that key it is STICKY — the next tick's split gets undone
    // again, so a drip chains into one multi-hour incident exactly as it did before the split
    // existed. The later cluster takes its own fresh key instead.
    const inherit = allBound && sameNamespace && !outGroups.has(candidate);
    // A "fresh" key must actually be DIFFERENT from the one it replaces. Anchoring on the earliest
    // death means a cohort that merely GAINED a member mints the identical string — so the caller
    // would apply the old `released` phase to the newcomers anyway, which is the whole hazard.
    // Adding the earliest newcomer's instant makes the generation explicit, and it stays stable for
    // as long as that newcomer is present; once it too is bound, the cluster is all-bound and keeps
    // its key by the rule above.
    let key = freshKey;
    if (inherit) {
      key = candidate;
    } else if (candidate !== undefined && sameNamespace) {
      // NOT-A-RETURN, not merely unbound (roborev 60140). Testing `previous.get(...) === undefined`
      // meant a member carrying a stale binding from some OTHER, long-finished incident counted as
      // neither a return nor a newcomer — so the cluster minted a bare key with no generation marker
      // and, worse, no `supersedes` entry, orphaning the drain's `released` phase with no evidence
      // link. `isReturn` is the question that was already being asked one loop up.
      const newcomer = members.find((m) => !returning.has(m.agentId));
      if (newcomer !== undefined) {
        key = `${freshKey}~${newcomer.diedAt}`;
        supersedes.set(key, candidate);
      }
      // NO `supersedes` on the collision branch. Reaching here with no newcomer means the candidate
      // key is already taken by another cluster this same tick — a split `groupCohorts` performed
      // deliberately so each half gets its OWN canary. Claiming supersession there would hand this
      // half the other half's evidence, which is the sticky-merge hazard through a different door.
    }
    outGroups.set(key, [...members]);
    for (const m of members) binding.set(m.agentId, key);
  }

  // A key that is STILL LIVE in this tick's output was not superseded by anything. Emitting it would
  // tell a caller following the documented contract to apply a running cluster's `released` phase to
  // a different cluster — releasing it with no probation — or, read as a move, to strip that phase
  // from a cluster whose canary is still running. Both re-open the hazard the split exists to close.
  for (const [fresh, prior] of supersedes) {
    if (outGroups.has(prior)) supersedes.delete(fresh);
  }

  // Prune bindings that can no longer describe a return, so the map cannot grow for the life of the
  // app. The newest death in this call is the only clock a pure function has.
  // ONLY departed agents. A member present in this tick's output was just bound above, and dropping
  // it here would make it read as a newcomer on the very next tick — re-keying a live cohort, which
  // is the bug the retention was added to fix.
  // SCOPED PER NAMESPACE, not to a global clock (roborev 60132). Pruning against the newest death
  // across every cluster in the tick let an UNRELATED incident evict the binding the return rule
  // depends on: a 20-agent app-restart cohort at +45min would delete a canary's binding from a
  // wall-session cohort anchored at 0, so its re-death at +35min — which single-links straight back
  // into its own cohort — read as unbound and re-keyed the cluster. That is the 60113 shape yet
  // again, arriving through the prune instead of through the test it feeds. A binding is judged
  // against the newest ANCHOR among live clusters that share its namespace, which is the only clock
  // that can say anything about whether its incident is over.
  // PRUNE ON WHETHER A RETURN IS STILL POSSIBLE, mirroring `isReturn` exactly (roborev 60140). An
  // earlier form kept a binding whenever its namespace had no live cluster — which reads as "we
  // cannot tell", but is in fact the NORMAL terminal state: a cohort drains, its deaths leave the
  // input, and the namespace never returns. For `app-restart:<epoch>` it is guaranteed, since an
  // epoch is a dead one-time id, so all 103 bindings from the measured 18:20/18:47 restarts would
  // have been permanent. Worse than the leak, a retained stale binding suppressed newcomer
  // detection, so a week-old member trickling into a live cohort orphaned its `released` phase with
  // no `supersedes` link — the starvation this module documents.
  const namespaceOf = (key: string) => key.slice(0, key.lastIndexOf("@"));
  const liveAnchors = new Map<string, number[]>();
  for (const key of outGroups.keys()) {
    const anchor = anchorOf(key);
    if (anchor === undefined) continue;
    const ns = namespaceOf(key);
    liveAnchors.set(ns, [...(liveAnchors.get(ns) ?? []), anchor]);
  }

  const present = new Set([...outGroups.values()].flat().map((m) => m.agentId));
  // The newest death anywhere is used ONLY as an age bound, never to decide whether a namespace's
  // incident is over. It can therefore only ever KEEP a binding longer than the live-cluster test
  // would, which is what makes it safe against roborev 60132 (where a global clock was used to
  // EVICT, letting an unrelated cohort delete a binding that was still needed).
  const newestDeath = Math.max(0, ...[...outGroups.values()].flat().map((m) => m.diedAt));
  for (const [agentId, key] of binding) {
    if (present.has(agentId)) continue;
    const anchor = anchorOf(key);
    if (anchor === undefined) continue;
    const liveClusterInReach = (liveAnchors.get(namespaceOf(key)) ?? []).some(
      (live) => Math.abs(live - anchor) <= RETURN_WINDOW_MS,
    );
    // A FULLY DRAINED cohort still has to age out rather than vanish (roborev, this round). Deleting
    // on "no live cluster" alone had no time component at all, so the binding went the instant the
    // last member left — which is exactly when a respawned canary is mid-probation and about to
    // re-die into it. That is the 60113 shape once more, and the third distinct route to it.
    const stillYoung = newestDeath - anchor <= RETURN_WINDOW_MS;
    if (!liveClusterInReach && !stillYoung) binding.delete(agentId);
  }

  return { groups: outGroups, binding, supersedes };
}

/**
 * Pick the canary. DETERMINISTIC, and the last tie-break earns its keep: if the cross-window
 * ownership election ever splits, both windows elect the SAME id, so a split-brain is a
 * double-decide rather than a double-spawn.
 *
 * Oldest death first (it has waited longest), then fewest prior attempts (do not keep burning the
 * same victim), then lexicographic id.
 */
export function electCanary(cohort: readonly CohortMember[], exclude: ReadonlySet<string> = new Set()):
  | string
  | null {
  const eligible = cohort.filter((m) => !exclude.has(m.agentId));
  if (eligible.length === 0) return null;
  const best = [...eligible].sort(
    (a, b) => a.diedAt - b.diedAt || a.attempts - b.attempts || a.agentId.localeCompare(b.agentId),
  )[0];
  return best?.agentId ?? null;
}

/** What was observed about a canary during its probation window. Every field is a fact from a
 *  mechanism that already exists; none of them is a judgement. */
export interface ProbationEvidence {
  /** Did it enter a dead status again? */
  exited: boolean;
  /** Is a quota wall back? */
  reWalled: boolean;
  /** A NEW API banner, at or after the respawn. */
  apiBannerAt: number | undefined;
  /**
   * Did a real hook event from Claude Code's own stream establish turn-end authority?
   *
   * This is the strongest witness available that the model actually connected and ran a turn, and
   * crucially A SPINNER CANNOT FAKE IT — which is why "it looks fine" is not one of these fields.
   */
  hasTurnAuthority: boolean;
  /** At least one PreToolUse/Stop-class event: work, not merely a boot. */
  didWork: boolean;
}

/**
 * Advance a probation.
 *
 * FAIL FAST, PASS SLOW. A canary that died, re-walled, or printed a fresh banner is decisive
 * immediately — waiting out the remaining window would waste three minutes to learn something
 * already known. The two positive conditions are judged only AT the deadline, because they are
 * expected to take time to become true.
 */
export function advanceProbation(
  state: CohortPhase,
  ev: ProbationEvidence,
  now: number,
): CohortPhase {
  if (state.phase !== "probation") return state;
  const { canaryId, spawnedAt, attempt } = state;

  const fail = (why: ProbationFailure): CohortPhase => ({
    phase: "failed",
    canaryId,
    failedAt: now,
    attempt,
    why,
  });

  if (ev.exited) return fail("exited");
  if (ev.reWalled) return fail("re-walled");
  if (ev.apiBannerAt !== undefined && ev.apiBannerAt >= spawnedAt) return fail("api-banner");

  if (now - spawnedAt < PROBATION_MS) return state; // still running
  if (!ev.hasTurnAuthority) return fail("no-turn-authority");
  if (!ev.didWork) return fail("no-work");

  return { phase: "released", canaryId, releasedAt: now, drained: [] };
}

/**
 * After a failure: elect a DIFFERENT victim, or give up and hand the cohort to a human.
 *
 * The just-failed canary is excluded HERE, not by the caller (roborev 60067). `electCanary` orders
 * by oldest death, and the failed canary was elected precisely BECAUSE it was oldest — so a caller
 * that passed an incomplete `burned` set would re-elect the same poisoned victim every time, burn
 * all three attempts on it, and abandon a cohort of 53 healthy agents. Rotation has to be a property
 * of this function rather than of the caller's diligence.
 */
export function afterFailure(
  state: CohortPhase,
  cohort: readonly CohortMember[],
  burned: ReadonlySet<string>,
  now: number,
): CohortPhase {
  if (state.phase !== "failed") return state;
  if (state.attempt >= MAX_CANARY_ATTEMPTS) {
    return { phase: "abandoned", at: now, why: `${MAX_CANARY_ATTEMPTS} canaries failed` };
  }
  const next = electCanary(cohort, new Set([...burned, state.canaryId]));
  if (next === null) return { phase: "abandoned", at: now, why: "no untried victim remains" };
  return { phase: "canary-elected", canaryId: next, electedAt: now, attempt: state.attempt + 1 };
}

/**
 * WHO MAY SPAWN RIGHT NOW. The single question the runner asks, and the one place the
 * canary-before-fleet guarantee is enforced.
 *
 * Before `released`, the answer is at most ONE id — the canary. That is the whole point, and it is
 * what stops a relaunch from firing 54 respawns in a minute.
 */
export function decideCohortAdmission(
  state: CohortPhase,
  cohort: readonly CohortMember[],
  capacity: number,
  now: number,
): readonly string[] {
  switch (state.phase) {
    case "canary-elected":
      return capacity >= 1 ? [state.canaryId] : [];
    // A probation already has its canary running; admitting anyone now would be the flood.
    case "probation":
    case "observed":
    case "failed":
    case "abandoned":
      return [];
    case "released": {
      // Drained release: a bounded batch per interval, further bounded by whatever capacity the
      // account evidence currently allows.
      const elapsed = now - state.releasedAt;
      const batchesDue = Math.floor(elapsed / RELEASE_BATCH_INTERVAL_MS) + 1;
      const allowedSoFar = batchesDue * RELEASE_BATCH;
      const remaining = cohort
        .map((m) => m.agentId)
        .filter((id) => id !== state.canaryId && !state.drained.includes(id));
      return remaining.slice(0, Math.max(0, Math.min(allowedSoFar - state.drained.length, capacity)));
    }
  }
}
