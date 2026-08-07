import { describe, expect, it } from "vitest";

import {
  type CohortMember,
  type CohortPhase,
  MAX_CANARY_ATTEMPTS,
  PROBATION_MS,
  RELEASE_BATCH,
  RELEASE_BATCH_INTERVAL_MS,
  advanceProbation,
  afterFailure,
  cohortKeyOf,
  decideCohortAdmission,
  electCanary,
  groupCohorts,
  stabilizeCohortKeys,
} from "./resurrectionCohort";

const NOW = 1_754_534_400_000;
const SESSION_WALL = "You've hit your session limit · resets 10:30pm (America/Los_Angeles)";

function member(over: Partial<CohortMember> & { agentId: string }): CohortMember {
  return {
    cause: "app-restart",
    message: undefined,
    epoch: "epoch-A",
    diedAt: NOW,
    attempts: 0,
    ...over,
  };
}

/** The measured 18:20 event: 54 agents killed by one app quit, within the same minute. */
function theAppQuitCohort(n = 54): CohortMember[] {
  return Array.from({ length: n }, (_, i) =>
    member({ agentId: `agent-${String(i).padStart(3, "0")}`, diedAt: NOW + i * 1_000 }),
  );
}

function goodEvidence() {
  return { exited: false, reWalled: false, apiBannerAt: undefined, hasTurnAuthority: true, didWork: true };
}

describe("cohort identity", () => {
  it("groups an app restart on its dead epoch, since nothing was printed", () => {
    expect(cohortKeyOf(member({ agentId: "a", cause: "app-restart", epoch: "epoch-A" }))).toBe(
      "app-restart:epoch-A",
    );
  });

  it("groups walls on the VERBATIM message", () => {
    const key = cohortKeyOf(
      member({ agentId: "a", cause: "wall-session", message: SESSION_WALL, epoch: undefined }),
    );
    expect(key).toContain(SESSION_WALL);
  });

  it("does not group two different epochs together", () => {
    const a = cohortKeyOf(member({ agentId: "a", epoch: "epoch-A" }));
    const b = cohortKeyOf(member({ agentId: "b", epoch: "epoch-B" }));
    expect(a).not.toBe(b);
  });

  it("treats a lone death as NOT a cohort", () => {
    // One agent's death is that agent's bad luck. Putting it through a 3-minute probation would
    // slow every single ordinary failure.
    const groups = groupCohorts([member({ agentId: "only" })]);
    expect(groups.size).toBe(0);
  });

  it("groups the 54 deaths from one app quit into ONE incident", () => {
    const groups = groupCohorts(theAppQuitCohort());
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(54);
  });

  it("splits deaths that are more than the shared-failure window apart", () => {
    const early = member({ agentId: "early", diedAt: NOW });
    const lateA = member({ agentId: "lateA", diedAt: NOW + 60 * 60_000 });
    const lateB = member({ agentId: "lateB", diedAt: NOW + 60 * 60_000 + 1_000 });
    const groups = groupCohorts([early, lateA, lateB]);
    const all = [...groups.values()].flat().map((m) => m.agentId);
    expect(all).toEqual(["lateA", "lateB"]);
  });

  it("does NOT let a later death erase an earlier genuine cluster (roborev 60067)", () => {
    // The destroyed-data case: an anchored window kept only the late death, dropped below the victim
    // floor, and removed the key ENTIRELY — so the pair that really died together was returned in no
    // cohort at all, read as two lone deaths, and respawned in parallel past the canary.
    const pairA = member({ agentId: "pair-a", diedAt: NOW });
    const pairB = member({ agentId: "pair-b", diedAt: NOW + 1_000 });
    const late = member({ agentId: "late", diedAt: NOW + 60 * 60_000 });

    const groups = groupCohorts([pairA, pairB, late]);
    const clusters = [...groups.values()];

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.map((m) => m.agentId)).toEqual(["pair-a", "pair-b"]);
  });

  it("never strands a member that a linked neighbour says belongs (roborev 60081)", () => {
    // The greedy-cut regression: with a 15-minute window, [T, T+15m, T+16m] put the first two in a
    // cluster and left T+16m a singleton, which the victim floor then DISCARDED — an agent that died
    // 60 seconds after a cohort member, of the identical cause, returned in no cohort and respawned
    // past the canary. This is the realistic account-wall shape: agents hit the wall one at a time
    // as each starts a turn.
    const trickle = [
      member({ agentId: "t0", cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: NOW }),
      member({
        agentId: "t1",
        cause: "wall-session",
        message: SESSION_WALL,
        epoch: undefined,
        diedAt: NOW + 15 * 60_000,
      }),
      member({
        agentId: "t2",
        cause: "wall-session",
        message: SESSION_WALL,
        epoch: undefined,
        diedAt: NOW + 16 * 60_000,
      }),
    ];
    const seen = [...groupCohorts(trickle).values()].flat().map((m) => m.agentId).sort();
    expect(seen).toEqual(["t0", "t1", "t2"]);
  });

  it("still discards a genuinely isolated death, which is the one correct discard", () => {
    const lonely = member({ agentId: "lonely", diedAt: NOW });
    const pair = [
      member({ agentId: "p0", diedAt: NOW + 5 * 60 * 60_000 }),
      member({ agentId: "p1", diedAt: NOW + 5 * 60 * 60_000 + 1_000 }),
    ];
    const seen = [...groupCohorts([lonely, ...pair]).values()].flat().map((m) => m.agentId);
    expect(seen).toEqual(["p0", "p1"]);
  });

  it("gives a cluster a key that does not change when an earlier cluster disappears", () => {
    // A positional suffix let cluster `k#1` slide to `k` once cluster 0's members were resurrected,
    // inheriting whatever CohortPhase the caller had stored under `k` — a `released` phase there
    // would hand back a whole batch with no canary.
    const early = [
      member({ agentId: "e0", diedAt: NOW }),
      member({ agentId: "e1", diedAt: NOW + 1_000 }),
    ];
    const late = [
      member({ agentId: "l0", diedAt: NOW + 5 * 60 * 60_000 }),
      member({ agentId: "l1", diedAt: NOW + 5 * 60 * 60_000 + 1_000 }),
    ];

    const keyWithBoth = [...groupCohorts([...early, ...late]).entries()].find(([, v]) =>
      v.some((m) => m.agentId === "l0"),
    )?.[0];
    const keyAlone = [...groupCohorts(late).entries()].find(([, v]) =>
      v.some((m) => m.agentId === "l0"),
    )?.[0];

    expect(keyWithBoth).toBeDefined();
    expect(keyAlone).toBe(keyWithBoth);
  });

  it("pins the 2x span bound with a drip that ACTUALLY re-attaches (roborev 60089)", () => {
    // The 12-death drip splits into exact pairs, so re-attach never fires there and the 2x
    // assertion would have passed at 1x — it could not catch a regression that doubled spans.
    // Thirteen deaths leaves a sub-floor remainder, which forces the merge.
    const drip = Array.from({ length: 13 }, (_, i) =>
      member({ agentId: `drip-${i}`, diedAt: NOW + i * 14 * 60_000 }),
    );
    const clusters = [...groupCohorts(drip).values()];
    const windowMs = 15 * 60_000;
    const spanOf = (c: typeof clusters[number]) => c[c.length - 1]!.diedAt - c[0]!.diedAt;

    // Nobody is dropped…
    expect(clusters.flat()).toHaveLength(13);
    // …exactly one cluster shows the re-attach, and it is bounded by 2x, not more.
    const reattached = clusters.filter((c) => spanOf(c) > windowMs);
    expect(reattached).toHaveLength(1);
    expect(spanOf(reattached[0]!)).toBeLessThanOrEqual(2 * windowMs);
    // …and every other cluster still fits inside a single window.
    for (const c of clusters.filter((c) => spanOf(c) <= windowMs)) {
      expect(spanOf(c)).toBeLessThanOrEqual(windowMs);
    }
  });

  it("does NOT chain a slow drip into one unbounded incident (roborev 60074)", () => {
    // My own fix for the anchored-window bug introduced this one: bounding by the GAP to the
    // previous death means a death every 14 minutes against a 15-minute window never opens a gap,
    // so an agent failing all afternoon becomes a single cohort spanning hours. A window measures an
    // incident, so it must bound the incident's total SPAN.
    const drip = Array.from({ length: 12 }, (_, i) =>
      member({ agentId: `drip-${i}`, diedAt: NOW + i * 14 * 60_000 }),
    );
    const groups = groupCohorts(drip);
    const windowMs = 15 * 60_000;

    expect(groups.size).toBeGreaterThan(1);
    for (const cluster of groups.values()) {
      const span = cluster[cluster.length - 1]!.diedAt - cluster[0]!.diedAt;
      // 2x the window, not 1x, and that is the honest guarantee rather than a weaker assertion:
      // re-attaching a sub-floor remainder (roborev 60081) can extend a cluster by up to one more
      // window, which is the deliberate price of never orphaning a member.
      expect(span).toBeLessThanOrEqual(2 * windowMs);
    }
    // …and the whole 2h34m drip is emphatically not one incident.
    const largest = Math.max(...[...groups.values()].map((c) => c.length));
    expect(largest).toBeLessThan(drip.length);
  });

  it("still keeps the 54-agent app quit whole, since it really did span one minute", () => {
    // Guards the fix against over-correcting: the span bound must not fragment a genuine burst.
    const groups = groupCohorts(theAppQuitCohort());
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(54);
  });

  it("keeps TWO separate clusters under one key when both meet the floor", () => {
    const first = [
      member({ agentId: "a1", diedAt: NOW }),
      member({ agentId: "a2", diedAt: NOW + 1_000 }),
    ];
    const second = [
      member({ agentId: "b1", diedAt: NOW + 60 * 60_000 }),
      member({ agentId: "b2", diedAt: NOW + 60 * 60_000 + 1_000 }),
    ];
    const groups = groupCohorts([...first, ...second]);
    expect(groups.size).toBe(2);
    const flat = [...groups.values()].flat().map((m) => m.agentId).sort();
    expect(flat).toEqual(["a1", "a2", "b1", "b2"]);
  });
});

describe("cohort identity survives its own canary being resurrected (roborev 60089)", () => {
  // The guaranteed path, not a corner case: electCanary picks the earliest death, and the key is
  // anchored on the earliest death, so the canary is ALWAYS the member whose departure changes it.
  const drip = [0, 14, 28, 42, 56].map((min) =>
    member({ agentId: `d${min}`, diedAt: NOW + min * 60_000 }),
  );

  it("re-keys without stabilization — which is the bug", () => {
    const before = groupCohorts(drip);
    const after = groupCohorts(drip.slice(1)); // the canary was resurrected and left the list
    const keyOf = (g: Map<string, CohortMember[]>, id: string) =>
      [...g.entries()].find(([, v]) => v.some((m) => m.agentId === id))?.[0];
    expect(keyOf(after, "d28")).not.toBe(keyOf(before, "d28"));
  });

  it("keeps the key when a cohort merely SHRINKS — the case that actually matters", () => {
    // The measured shape: one app quit, 54 agents, drained back a few at a time. Every resurrection
    // removes a member, and without this the survivors re-key after each one — restarting the canary
    // and another full probation, turning one drained release into ~3 minutes per agent.
    const cohort = theAppQuitCohort(10);
    const first = stabilizeCohortKeys(new Map(), groupCohorts(cohort));
    const key = first.binding.get("agent-000");
    expect(key).toBeDefined();

    let binding = first.binding;
    for (let removed = 1; removed <= 5; removed++) {
      const survivors = cohort.slice(removed);
      const next = stabilizeCohortKeys(binding, groupCohorts(survivors));
      for (const m of survivors) {
        expect(next.binding.get(m.agentId)).toBe(key);
      }
      binding = next.binding;
    }
  });

  it("mints a FRESH key when two prior cohorts merge, rather than inheriting one", () => {
    // Two identities cannot both survive a merge. Choosing a winner risks handing the merged group
    // to a stale `released` phase and releasing it with no canary; a fresh key costs one probation
    // window instead. Slow is recoverable, a flood is not.
    const first = stabilizeCohortKeys(new Map(), groupCohorts(drip));
    const priorKeys = new Set(drip.map((m) => first.binding.get(m.agentId)));
    expect(priorKeys.size).toBeGreaterThan(1); // guards the premise

    const second = stabilizeCohortKeys(first.binding, groupCohorts(drip.slice(1)));
    // d14 and d28 came from different prior cohorts and are now clustered together.
    const merged = second.binding.get("d28");
    expect(merged).toBe(second.binding.get("d14"));
    expect(priorKeys.has(merged)).toBe(false);
  });

  it("mints FRESH when a cohort GROWS, so newcomers never ride a stale released phase", () => {
    // roborev 60101, the High: looking only at members that happened to be bound meant a cohort
    // K={A,B} that reached `released` after canary A proved the door, then joined by three fresh
    // deaths on the same wall, still keyed K — and the caller's released phase handed C, D and E
    // straight back with no canary at all. A brand-new incident released on older evidence.
    const wall = (id: string, min: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: NOW + min * 60_000 });

    const first = stabilizeCohortKeys(new Map(), groupCohorts([wall("A", 0), wall("B", 1)]));
    const releasedKey = first.binding.get("B");
    expect(releasedKey).toBeDefined();

    // A is resurrected; B remains; three newcomers hit the same wall inside the window.
    const grown = [wall("B", 1), wall("C", 2), wall("D", 3), wall("E", 4)];
    const second = stabilizeCohortKeys(first.binding, groupCohorts(grown));

    for (const id of ["B", "C", "D", "E"]) {
      expect(second.binding.get(id)).not.toBe(releasedKey);
    }
  });

  it("does not let sticky merging chain an incremental drip into one long incident", () => {
    // roborev 60101: merging two clusters under one inherited key undid the span split, and because
    // the merge re-bound every member it was sticky — the next tick's split was undone again.
    const windowMs = 15 * 60_000;
    let binding = new Map<string, string>();
    const deaths: CohortMember[] = [];

    for (const min of [0, 14, 28, 42, 56, 70]) {
      deaths.push(member({ agentId: `d${min}`, diedAt: NOW + min * 60_000 }));
      const step = stabilizeCohortKeys(binding, groupCohorts(deaths));
      binding = step.binding;
      for (const cluster of step.groups.values()) {
        const span = cluster[cluster.length - 1]!.diedAt - cluster[0]!.diedAt;
        expect(span).toBeLessThanOrEqual(2 * windowMs);
      }
    }
  });

  it("keeps the key when its own canary is respawned and then RE-DIES (roborev 60113)", () => {
    // The central path, not an edge: advanceProbation expects a canary to fail by exiting or
    // re-walling. Rebuilding the binding from current members only dropped the respawned canary, so
    // its re-death ~3 minutes later read as a NEWCOMER, re-keyed the cohort, and orphaned the phase
    // holding `attempt` and the burned set — afterFailure restarting at 1 forever, so
    // MAX_CANARY_ATTEMPTS was unreachable and a human was never asked.
    const cohort = theAppQuitCohort(3);
    const first = stabilizeCohortKeys(new Map(), groupCohorts(cohort));
    const key = first.binding.get("agent-000");

    // The canary is respawned, so it leaves the death list…
    const midFlight = stabilizeCohortKeys(first.binding, groupCohorts(cohort.slice(1)));
    // …then fails and re-dies, inside its own cohort's window.
    const returned = [
      ...cohort.slice(1),
      member({ agentId: "agent-000", diedAt: NOW + 3 * 60_000 }),
    ];
    const after = stabilizeCohortKeys(midFlight.binding, groupCohorts(returned));

    expect(after.binding.get("agent-000")).toBe(key);
    expect(after.binding.get("agent-001")).toBe(key);
    expect(after.supersedes.size).toBe(0);
  });

  it("names the prior key it superseded, so a drain need not restart (roborev 60113)", () => {
    // Minting fresh for a genuine newcomer is right for IDENTITY. Discarding the cohort's evidence
    // with it is what starved the drain: one trickling death mid-release sent the already-vetted
    // remainder back through a full probation, and the next tick did it again.
    const wall = (id: string, min: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: NOW + min * 60_000 });

    const first = stabilizeCohortKeys(new Map(), groupCohorts([wall("A", 0), wall("B", 1)]));
    const releasedKey = first.binding.get("A");

    const grown = [wall("A", 0), wall("B", 1), wall("C", 2)];
    const second = stabilizeCohortKeys(first.binding, groupCohorts(grown));
    const newKey = second.binding.get("C");

    // Identity is fresh — the newcomer was never vetted…
    expect(newKey).not.toBe(releasedKey);
    // …but the caller can see WHICH phase this replaces, and carry the evidence forward itself.
    expect(second.supersedes.get(newKey!)).toBe(releasedKey);
  });

  it("recognises a canary that re-dies at the far edge of its cohort's reach (roborev 60127)", () => {
    // The 15-minute band: `groupCohorts` single-links a re-death up to span-bound + link-window
    // (45 min) from the anchor, but the return test was measuring against a 30-minute window — so a
    // canary re-dying at +35 min clustered with its own cohort while reading as a stranger, which is
    // roborev 60113 all over again (attempt counter and burned set orphaned).
    const a = member({ agentId: "A", diedAt: NOW });
    const b = member({ agentId: "B", diedAt: NOW + 14 * 60_000 });
    const c = member({ agentId: "C", diedAt: NOW + 28 * 60_000 });

    const first = stabilizeCohortKeys(new Map(), groupCohorts([a, b, c]));
    const key = first.binding.get("A");

    // A is the canary (earliest death), is respawned, then fails at +35 min.
    const midFlight = stabilizeCohortKeys(first.binding, groupCohorts([b, c]));
    const after = stabilizeCohortKeys(
      midFlight.binding,
      groupCohorts([b, c, member({ agentId: "A", diedAt: NOW + 35 * 60_000 })]),
    );

    expect(after.binding.get("A")).toBe(key);
    expect(after.binding.get("B")).toBe(key);
    expect(after.binding.get("C")).toBe(key);
  });

  it("keeps the return working when an UNRELATED cohort dies later (roborev 60132)", () => {
    // The prune used the newest death across every cluster in the tick, in every namespace — so a
    // big app-restart cohort arriving later evicted a wall-session canary's binding and its return
    // re-keyed the cluster. The property the previous test pins only held in a single-cohort world.
    const wall = (id: string, min: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: NOW + min * 60_000 });
    const unrelated = Array.from({ length: 20 }, (_, i) =>
      member({ agentId: `restart-${i}`, epoch: "epoch-Z", diedAt: NOW + 45 * 60_000 + i * 1_000 }),
    );

    const first = stabilizeCohortKeys(
      new Map(),
      groupCohorts([wall("A", 0), wall("B", 14), wall("C", 28), ...unrelated]),
    );
    const key = first.binding.get("A");

    // A is respawned; the unrelated cohort is still dying at +45min.
    const midFlight = stabilizeCohortKeys(
      first.binding,
      groupCohorts([wall("B", 14), wall("C", 28), ...unrelated]),
    );
    // …then A fails and re-dies at +35min, single-linking back into its own cohort.
    const after = stabilizeCohortKeys(
      midFlight.binding,
      groupCohorts([wall("B", 14), wall("C", 28), wall("A", 35), ...unrelated]),
    );

    expect(after.binding.get("A")).toBe(key);
    expect(after.binding.get("B")).toBe(key);
  });

  it("never claims to supersede a key that is still live this tick (roborev 60120)", () => {
    // The split-cluster hazard through the evidence channel: a cluster that groupCohorts split off
    // precisely so it gets its OWN canary must not be handed the other half's phase.
    let binding = new Map<string, string>();
    const deaths: CohortMember[] = [];
    for (const min of [0, 14, 28, 42]) {
      deaths.push(member({ agentId: `d${min}`, diedAt: NOW + min * 60_000 }));
      const step = stabilizeCohortKeys(binding, groupCohorts(deaths));
      binding = step.binding;
      for (const prior of step.supersedes.values()) {
        expect(step.groups.has(prior)).toBe(false);
      }
    }
  });

  it("treats the same agents re-dying days later as a NEW incident (roborev 60120)", () => {
    // Retention without expiry is a permanent claim: a fully drained cohort left every member bound
    // forever, so an identical verbatim message days later inherited the stale `released` phase and
    // would have released the whole fleet with no canary.
    const wall = (id: string, at: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: at });

    const first = stabilizeCohortKeys(
      new Map(),
      groupCohorts([wall("A", NOW), wall("B", NOW + 1_000)]),
    );
    const oldKey = first.binding.get("A");
    expect(oldKey).toBeDefined();

    const daysLater = NOW + 3 * 24 * 60 * 60_000;
    const recurrence = stabilizeCohortKeys(
      first.binding,
      groupCohorts([wall("A", daysLater), wall("B", daysLater + 1_000)]),
    );

    expect(recurrence.binding.get("A")).not.toBe(oldKey);
    expect([...recurrence.supersedes.values()]).not.toContain(oldKey);
  });

  it("prunes bindings that can no longer describe a return", () => {
    const wall = (id: string, at: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: at });
    const first = stabilizeCohortKeys(
      new Map(),
      groupCohorts([wall("A", NOW), wall("B", NOW + 1_000)]),
    );

    const daysLater = NOW + 3 * 24 * 60 * 60_000;
    const later = stabilizeCohortKeys(
      first.binding,
      groupCohorts([wall("C", daysLater), wall("D", daysLater + 1_000)]),
    );

    // A and B are long gone and their bindings can never describe a return again.
    expect(later.binding.has("A")).toBe(false);
    expect(later.binding.has("B")).toBe(false);
  });

  it("binds every PRESENT agent to a cohort that actually contains it", () => {
    // Agents that have LEFT deliberately keep their binding (that is what makes a re-death a return
    // rather than an arrival), so the invariant is about members currently in a group.
    const first = stabilizeCohortKeys(new Map(), groupCohorts(drip));
    const second = stabilizeCohortKeys(first.binding, groupCohorts(drip.slice(1)));
    const present = new Set([...second.groups.values()].flat().map((m) => m.agentId));
    for (const [agentId, key] of second.binding) {
      if (!present.has(agentId)) continue;
      expect(second.groups.get(key)!.some((m) => m.agentId === agentId)).toBe(true);
    }
  });
});

describe("election is deterministic", () => {
  it("picks the oldest death, and the SAME one from any input order", () => {
    // If the cross-window ownership election ever splits, both windows must elect the same id — that
    // turns a split-brain into a double-decide instead of a double-spawn.
    const cohort = theAppQuitCohort(10);
    const forward = electCanary(cohort);
    const reversed = electCanary([...cohort].reverse());
    expect(forward).toBe("agent-000");
    expect(reversed).toBe(forward);
  });

  it("prefers a victim with fewer prior attempts at equal death time", () => {
    const burnt = member({ agentId: "aaa", attempts: 3 });
    const fresh = member({ agentId: "zzz", attempts: 0 });
    expect(electCanary([burnt, fresh])).toBe("zzz");
  });

  it("skips excluded victims and returns null when none remain", () => {
    const cohort = theAppQuitCohort(2);
    expect(electCanary(cohort, new Set(["agent-000"]))).toBe("agent-001");
    expect(electCanary(cohort, new Set(["agent-000", "agent-001"]))).toBeNull();
  });
});

describe("EXACTLY ONE canary is attempted before the rest — the whole point", () => {
  it("admits one id, not 54, for the measured app-quit cohort", () => {
    const cohort = theAppQuitCohort();
    const canaryId = electCanary(cohort)!;
    const state: CohortPhase = { phase: "canary-elected", canaryId, electedAt: NOW, attempt: 1 };

    const admitted = decideCohortAdmission(state, cohort, 80, NOW);

    expect(admitted).toHaveLength(1);
    expect(admitted).toEqual([canaryId]);
    // The failure this exists to prevent, stated as an assertion rather than a comment.
    expect(admitted.length).toBeLessThan(cohort.length);
  });

  it("admits NOBODY while the canary is on probation", () => {
    const cohort = theAppQuitCohort();
    const state: CohortPhase = { phase: "probation", canaryId: "agent-000", spawnedAt: NOW, attempt: 1 };
    expect(decideCohortAdmission(state, cohort, 80, NOW + 60_000)).toEqual([]);
  });

  it("admits nobody merely because deaths were observed", () => {
    const cohort = theAppQuitCohort();
    const state: CohortPhase = { phase: "observed", victims: cohort.map((m) => m.agentId), since: NOW };
    expect(decideCohortAdmission(state, cohort, 80, NOW)).toEqual([]);
  });

  it("admits nobody after the cohort is abandoned", () => {
    const cohort = theAppQuitCohort();
    const state: CohortPhase = { phase: "abandoned", at: NOW, why: "3 canaries failed" };
    expect(decideCohortAdmission(state, cohort, 80, NOW)).toEqual([]);
  });
});

describe("probation — fail fast, pass slow", () => {
  const probation: CohortPhase = {
    phase: "probation",
    canaryId: "agent-000",
    spawnedAt: NOW,
    attempt: 1,
  };

  it.each([
    ["exited", { exited: true }, "exited"],
    ["re-walled", { reWalled: true }, "re-walled"],
    ["a fresh API banner", { apiBannerAt: NOW + 1_000 }, "api-banner"],
  ] as const)("fails IMMEDIATELY on %s, without waiting out the window", (_label, over, why) => {
    const next = advanceProbation(probation, { ...goodEvidence(), ...over }, NOW + 5_000);
    expect(next.phase).toBe("failed");
    expect(next.phase === "failed" && next.why).toBe(why);
    // Decisive well before the deadline — the point of failing fast.
    expect(NOW + 5_000 - NOW).toBeLessThan(PROBATION_MS);
  });

  it("ignores an API banner that PREDATES the respawn", () => {
    // Otherwise the banner that killed it in the first place fails its own recovery forever.
    const next = advanceProbation(probation, { ...goodEvidence(), apiBannerAt: NOW - 1_000 }, NOW + 1_000);
    expect(next.phase).toBe("probation");
  });

  it("stays in probation until the deadline even when everything looks good", () => {
    const next = advanceProbation(probation, goodEvidence(), NOW + PROBATION_MS - 1);
    expect(next.phase).toBe("probation");
  });

  it("releases only when a real hook event proved a turn ran AND work happened", () => {
    const next = advanceProbation(probation, goodEvidence(), NOW + PROBATION_MS);
    expect(next.phase).toBe("released");
  });

  it("fails a canary that booted but never proved it ran a turn", () => {
    // "It looks fine" is not one of the conditions: a spinner cannot produce turn-end authority,
    // which is why that is the witness rather than the screen.
    const next = advanceProbation(
      probation,
      { ...goodEvidence(), hasTurnAuthority: false },
      NOW + PROBATION_MS,
    );
    expect(next.phase === "failed" && next.why).toBe("no-turn-authority");
  });

  it("fails a canary that ran no work", () => {
    const next = advanceProbation(probation, { ...goodEvidence(), didWork: false }, NOW + PROBATION_MS);
    expect(next.phase === "failed" && next.why).toBe("no-work");
  });
});

describe("re-election rotates, then gives up", () => {
  it("elects a DIFFERENT victim after a failure, WITHOUT the caller having to say so", () => {
    // roborev 60067: passing `burned` by hand proved the caller's diligence, not the function's
    // guarantee. `electCanary` orders by oldest death and the failed canary was elected BECAUSE it
    // was oldest, so an empty `burned` used to re-elect the same poisoned victim every time — three
    // attempts burned on one agent, and a cohort of 53 healthy ones abandoned.
    const cohort = theAppQuitCohort(5);
    const failed: CohortPhase = {
      phase: "failed",
      canaryId: "agent-000",
      failedAt: NOW,
      attempt: 1,
      why: "exited",
    };
    const next = afterFailure(failed, cohort, new Set(), NOW);
    expect(next.phase).toBe("canary-elected");
    expect(next.phase === "canary-elected" && next.canaryId).not.toBe("agent-000");
    expect(next.phase === "canary-elected" && next.canaryId).toBe("agent-001");
    expect(next.phase === "canary-elected" && next.attempt).toBe(2);
  });

  it("still honours a caller-supplied burned set on top of its own exclusion", () => {
    const cohort = theAppQuitCohort(5);
    const failed: CohortPhase = {
      phase: "failed",
      canaryId: "agent-001",
      failedAt: NOW,
      attempt: 1,
      why: "exited",
    };
    const next = afterFailure(failed, cohort, new Set(["agent-000"]), NOW);
    expect(next.phase === "canary-elected" && next.canaryId).toBe("agent-002");
  });

  it("abandons the cohort after MAX_CANARY_ATTEMPTS rather than looping", () => {
    const cohort = theAppQuitCohort(10);
    const failed: CohortPhase = {
      phase: "failed",
      canaryId: "agent-002",
      failedAt: NOW,
      attempt: MAX_CANARY_ATTEMPTS,
      why: "exited",
    };
    expect(afterFailure(failed, cohort, new Set(), NOW).phase).toBe("abandoned");
  });

  it("abandons when every victim has been burned", () => {
    const cohort = theAppQuitCohort(2);
    const failed: CohortPhase = {
      phase: "failed",
      canaryId: "agent-000",
      failedAt: NOW,
      attempt: 1,
      why: "exited",
    };
    const next = afterFailure(failed, cohort, new Set(["agent-001"]), NOW);
    expect(next.phase).toBe("abandoned");
  });
});

describe("release is a drain, not a flood", () => {
  const cohort = theAppQuitCohort();
  const released: CohortPhase = {
    phase: "released",
    canaryId: "agent-000",
    releasedAt: NOW,
    drained: [],
  };

  it("admits one batch immediately, never the whole cohort", () => {
    const admitted = decideCohortAdmission(released, cohort, 80, NOW);
    expect(admitted).toHaveLength(RELEASE_BATCH);
    expect(admitted).not.toContain("agent-000"); // the canary is already back
  });

  it("widens by one batch per interval", () => {
    const after3 = decideCohortAdmission(released, cohort, 80, NOW + 3 * RELEASE_BATCH_INTERVAL_MS);
    expect(after3).toHaveLength(4 * RELEASE_BATCH);
  });

  it("is still bounded by capacity, so an account-narrowed cap wins", () => {
    const admitted = decideCohortAdmission(released, cohort, 2, NOW + 10 * RELEASE_BATCH_INTERVAL_MS);
    expect(admitted).toHaveLength(2);
  });

  it("never re-admits an agent already drained", () => {
    const partial: CohortPhase = { ...released, drained: ["agent-001", "agent-002"] };
    const admitted = decideCohortAdmission(partial, cohort, 80, NOW);
    expect(admitted).not.toContain("agent-001");
    expect(admitted).not.toContain("agent-002");
  });

  it("takes minutes, not one minute, to bring 54 agents back", () => {
    // The measured relaunch resumed 45 panes inside a single minute. This asserts the new shape.
    const perMinute = Math.floor(60_000 / RELEASE_BATCH_INTERVAL_MS) * RELEASE_BATCH;
    expect(perMinute).toBeLessThan(45);
    const minutesFor54 = (54 / perMinute) * 1;
    expect(minutesFor54).toBeGreaterThan(3);
  });
});

describe("a finished incident's bindings do not outlive it (roborev 60140)", () => {
  it("prunes a drained app-restart cohort, whose namespace can never recur", () => {
    // An epoch is a dead one-time id, so `app-restart:<epoch>` never has a live cluster again.
    // Keeping those bindings "because we cannot tell" made every one of them permanent.
    const cohort = theAppQuitCohort(5);
    const first = stabilizeCohortKeys(new Map(), groupCohorts(cohort));
    expect(first.binding.size).toBe(5);

    // The whole cohort is resurrected; a different incident is all that remains.
    const later = [
      member({ agentId: "other-0", epoch: "epoch-Z", diedAt: NOW + 5 * 60 * 60_000 }),
      member({ agentId: "other-1", epoch: "epoch-Z", diedAt: NOW + 5 * 60 * 60_000 + 1_000 }),
    ];
    const after = stabilizeCohortKeys(first.binding, groupCohorts(later));

    for (const m of cohort) expect(after.binding.has(m.agentId)).toBe(false);
  });

  it("lets a stale-bound member read as a newcomer, so the drain keeps its evidence link", () => {
    // The regression: a member carrying a binding from a long-finished incident was neither a
    // return nor a newcomer, so the cluster minted a bare key with NO supersedes entry and the
    // drain's `released` phase was orphaned with no way to carry it forward.
    const wall = (id: string, min: number) =>
      member({ agentId: id, cause: "wall-session", message: SESSION_WALL, epoch: undefined, diedAt: NOW + min * 60_000 });

    // X is bound to an old, unrelated app-restart incident.
    const old = stabilizeCohortKeys(new Map(), groupCohorts([
      member({ agentId: "X", epoch: "epoch-Q", diedAt: NOW - 7 * 24 * 60 * 60_000 }),
      member({ agentId: "Y", epoch: "epoch-Q", diedAt: NOW - 7 * 24 * 60 * 60_000 + 1_000 }),
    ]));

    const cohort = stabilizeCohortKeys(old.binding, groupCohorts([wall("A", 0), wall("B", 1)]));
    const releasedKey = cohort.binding.get("B");

    // X trickles into the live cohort days later.
    const grown = stabilizeCohortKeys(cohort.binding, groupCohorts([wall("B", 1), wall("X", 5)]));
    const newKey = grown.binding.get("X");

    expect(newKey).not.toBe(releasedKey);
    expect(grown.supersedes.get(newKey!)).toBe(releasedKey);
  });
});

describe("a drained cohort's bindings age out rather than vanishing", () => {
  it("keeps a canary's binding through the probation window after the cohort empties", () => {
    // Deleting on 'no live cluster' alone had no time component, so the binding went the instant the
    // last member left — precisely when a respawned canary is mid-probation and about to re-die.
    const cohort = theAppQuitCohort(3);
    const first = stabilizeCohortKeys(new Map(), groupCohorts(cohort));
    const key = first.binding.get("agent-000");

    // The whole cohort is respawned; nothing of it is in the death list any more.
    const drained = stabilizeCohortKeys(first.binding, groupCohorts([]));
    expect(drained.binding.get("agent-000")).toBe(key);

    // The canary then fails and re-dies with a survivor, still inside the incident's width.
    const returned = stabilizeCohortKeys(
      drained.binding,
      groupCohorts([
        member({ agentId: "agent-000", diedAt: NOW + 3 * 60_000 }),
        member({ agentId: "agent-001", diedAt: NOW + 3 * 60_000 + 1_000 }),
      ]),
    );
    expect(returned.binding.get("agent-000")).toBe(key);
  });
});
