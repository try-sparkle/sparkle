// THE PROPERTY: a driver starts only on ENUMERATED evidence that has been true TWICE, only when no
// other driver holds the PR, and only inside the cost ceilings — and every refusal names itself.
//
// Every assertion below reads the RETURNED DECISION — the `hold` value, the `evidence` contents —
// never merely that the function was called. AGENTS.md's #1 fleet-wide finding is the vacuous test:
// a green suite guarding a broken feature because the assertion was already true before the change.
// The two shapes most at risk here are pinned deliberately:
//
//   * `probes: undefined` must hold `probe-read-unknown`, NOT `no-evidence`. Collapsing UNKNOWN into
//     its neighbour is the bug `knightwatch.rs` and `services/mergeGuard/types.ts` both exist to
//     prevent, and an assertion of `dispatch === false` alone would pass either way.
//   * The `⏸ knightwatch paused` repost storm must produce ZERO dispatches over MANY sweeps. A test
//     that ran one sweep would pass on the two-observation rule alone, which is exactly the defence
//     a repost storm defeats — so the storm is simulated to saturation.
import { describe, it, expect } from "vitest";
import {
  BABYSIT_COOLDOWN_MS,
  BABYSIT_DISPATCHES_PER_HOUR,
  BABYSIT_RATE_WINDOW_MS,
  BABYSIT_RECOVERY_COOLDOWN_MS,
  babysitEvidenceFor,
  babysitEvidenceIds,
  decideBabysitDispatch,
  resolveBabysitConfig,
  type BabysitDecision,
  type BabysitDispatchInput,
  type BabysitProbe,
  type BabysitProbeGate,
  type BabysitPrSnapshot,
} from "./babysitDispatch";

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

function probe(over: Partial<BabysitProbe> = {}): BabysitProbe {
  return {
    commentId: 900_001,
    index: 1,
    severity: "blocking",
    from: "security",
    text: "This drops the auth check on the retry path.",
    url: "https://github.com/drodio/sparkle/pull/1176#issuecomment-900001",
    answered: false,
    ...over,
  };
}

/**
 * The AUTHORITATIVE state: the PR carries knightwatch comments, we asked, and these are the probes.
 * `[]` is "asked; none" — a real answer, and NOT the same fact as `NOT_APPLICABLE_GATE` below.
 */
function gate(probes: BabysitProbe[], over: Partial<BabysitProbeGate> = {}): BabysitProbeGate {
  return { applicable: true, probes, error: null, overridden: false, ...over };
}

/** UNKNOWN: `applicable: true, probes: undefined` — mirrors Rust `ProbeGate::unknown`. */
const UNKNOWN_GATE: BabysitProbeGate = {
  applicable: true,
  probes: undefined,
  error: "could not read PR #1176's comments: gh exited 1",
  overridden: false,
};

/** NOT-APPLICABLE: the read succeeded and the PR carries no knightwatch comment at all. */
const NOT_APPLICABLE_GATE: BabysitProbeGate = {
  applicable: false,
  probes: [],
  error: null,
  overridden: false,
};

function snapshot(over: Partial<BabysitPrSnapshot> = {}): BabysitPrSnapshot {
  return {
    repo: "drodio/sparkle",
    number: 1176,
    state: "open",
    mergeStateStatus: "CLEAN",
    checks: "passing",
    gate: gate([]),
    ...over,
  };
}

/**
 * A decision whose defaults are the HEALTHY case: open PR, free lease, ample budget, and a prior
 * observation that already saw whatever the current sweep sees. So any hold a test provokes is
 * caused by the one field that test overrode, and nothing else.
 */
function decide(over: Partial<BabysitDispatchInput> = {}): BabysitDecision {
  const pr = over.pr ?? snapshot();
  return decideBabysitDispatch({
    now: T0,
    config: resolveBabysitConfig({}),
    lease: "free",
    // Default prior = "this was all true last sweep too", so the two-observation rule is satisfied
    // unless a test deliberately withholds it.
    prior: { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(pr)) },
    fleet: { recentDispatchAt: [], freeAgentSlots: 3 },
    ...over,
    pr,
  });
}

/** Narrowing helper — a test that means to read `hold` must fail loudly on a dispatch. */
function holdOf(d: BabysitDecision): string {
  if (d.dispatch) throw new Error(`expected a hold, got a dispatch with ${d.evidence.length} evidence`);
  return d.hold;
}

describe("evidence — rule 1: enumerated, never a schedule", () => {
  it("a clean, green, probe-free PR yields no evidence at all", () => {
    expect(babysitEvidenceFor(snapshot())).toEqual([]);
    expect(holdOf(decide())).toBe("no-evidence");
  });

  it("an unanswered blocking probe is evidence, and carries the probe itself", () => {
    const p = probe({ index: 2 });
    const evidence = babysitEvidenceFor(snapshot({ gate: gate([p]) }));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("unanswered-blocking-probe");
    expect(evidence[0]?.probe).toEqual(p);
    expect(evidence[0]?.detail).toContain("This drops the auth check on the retry path.");
  });

  it("an ANSWERED probe is not evidence — the whole point of the gate", () => {
    const pr = snapshot({ gate: gate([probe({ answered: true })]) });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("no-evidence");
  });

  it("an unanswered [open] probe is its own evidence kind", () => {
    const evidence = babysitEvidenceFor(snapshot({ gate: gate([probe({ severity: "open" })]) }));
    expect(evidence.map((e) => e.kind)).toEqual(["unanswered-open-probe"]);
  });

  it("blocking probes are reported before open ones, whatever order they arrived in", () => {
    const pr = snapshot({
      gate: gate([
        probe({ index: 1, severity: "open" }),
        probe({ index: 2, severity: "blocking" }),
        probe({ index: 3, severity: "open" }),
      ]),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "unanswered-blocking-probe",
      "unanswered-open-probe",
      "unanswered-open-probe",
    ]);
  });

  it("an overridden gate contributes no probe evidence — a human already waved these through", () => {
    const pr = snapshot({ gate: gate([probe()], { overridden: true }) });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("no-evidence");
  });

  it("an override suppresses PROBE evidence ONLY — broken checks on the same PR still dispatch", () => {
    // Pins the SCOPE of the override, which the case above cannot: with a clean, green snapshot the
    // probe is the only possible evidence, so a broadened override ("an overridden PR is never
    // dispatched") would pass it unchanged — and would silently stop watching a PR forever, however
    // badly it later broke, while reporting the healthy-sounding `no-evidence`.
    const pr = snapshot({
      gate: gate([probe()], { overridden: true }),
      checks: "failing",
      mergeStateStatus: "DIRTY",
    });
    expect(babysitEvidenceFor(pr).map((e) => e.id)).toEqual(["merge-conflicting", "checks-failing"]);

    const d = decide({ pr });
    expect(d.dispatch).toBe(true);
    if (!d.dispatch) throw new Error("unreachable");
    expect(d.evidence.every((e) => e.probe === undefined)).toBe(true);
  });

  it("a failing check rollup is evidence", () => {
    const evidence = babysitEvidenceFor(snapshot({ checks: "failing" }));
    expect(evidence.map((e) => e.id)).toEqual(["checks-failing"]);
  });

  it("a DIRTY merge state is evidence, case-insensitively, and suppresses the absent-checks echo", () => {
    const evidence = babysitEvidenceFor(snapshot({ mergeStateStatus: "dirty", checks: "absent" }));
    // One cause, reported once: a conflicting PR has no checks BECAUSE it is conflicting.
    expect(evidence.map((e) => e.id)).toEqual(["merge-conflicting"]);
  });

  it("absent checks are evidence on their own when the PR is not conflicting", () => {
    expect(babysitEvidenceFor(snapshot({ checks: "absent" })).map((e) => e.id)).toEqual(["checks-absent"]);
  });

  it("pending checks and an unread rollup are never evidence", () => {
    expect(babysitEvidenceFor(snapshot({ checks: "pending" }))).toEqual([]);
    expect(babysitEvidenceFor(snapshot({ checks: undefined }))).toEqual([]);
    expect(babysitEvidenceFor(snapshot({ mergeStateStatus: undefined }))).toEqual([]);
  });

  it("an unrecognised mergeStateStatus is not treated as conflicting", () => {
    expect(babysitEvidenceFor(snapshot({ mergeStateStatus: "BEHIND" }))).toEqual([]);
    expect(babysitEvidenceFor(snapshot({ mergeStateStatus: "SOMETHING_NEW" }))).toEqual([]);
  });

  it("evidence ids are stable across sweeps for the same condition", () => {
    const pr = snapshot({ gate: gate([probe({ commentId: 7, index: 3 })]), checks: "failing" });
    expect(babysitEvidenceIds(babysitEvidenceFor(pr))).toEqual([
      "blocking-probe:7#3",
      "checks-failing",
    ]);
    // And the same probe raised under a DIFFERENT review is a different condition — numbering
    // restarts per review, so the index alone names nothing.
    const other = snapshot({ gate: gate([probe({ commentId: 8, index: 3 })]) });
    expect(babysitEvidenceIds(babysitEvidenceFor(other))).toEqual(["blocking-probe:8#3"]);
  });
});

describe("the dispatch case", () => {
  it("unanswered blocking probe + free lease + two observations ⇒ dispatch naming that probe", () => {
    const p = probe({ commentId: 900_002, index: 4 });
    const pr = snapshot({ gate: gate([p]) });
    const d = decide({ pr, lease: "free" });

    expect(d.dispatch).toBe(true);
    if (!d.dispatch) throw new Error("unreachable");
    expect(d.repo).toBe("drodio/sparkle");
    expect(d.pr).toBe(1176);
    expect(d.evidence.map((e) => e.id)).toEqual(["blocking-probe:900002#4"]);
    expect(d.evidence[0]?.probe).toEqual(p);
  });

  it("reports everything true now, not only the condition that persisted", () => {
    const pr = snapshot({ gate: gate([probe()]), checks: "failing" });
    // Only the probe was seen last sweep; the failing checks are brand new this sweep.
    const d = decide({ pr, prior: { evidenceIds: ["blocking-probe:900001#1"] } });
    if (!d.dispatch) throw new Error(`expected a dispatch, got ${d.hold}`);
    expect(d.evidence.map((e) => e.id)).toEqual(["blocking-probe:900001#1", "checks-failing"]);
  });
});

describe("rule 4 — one driver per PR", () => {
  it("held-live holds with driver-alive", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, lease: "held-live" }))).toBe("driver-alive");
  });

  it("unknown holds with lease-unknown — fail CLOSED against dispatch", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, lease: "unknown" }))).toBe("lease-unknown");
  });

  it("held-dead DISPATCHES — a driver whose app restarted is gone, and the PR needs restarting", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    const d = decide({ pr, lease: "held-dead" });
    expect(d.dispatch).toBe(true);
    if (!d.dispatch) throw new Error("unreachable");
    expect(d.evidence.map((e) => e.kind)).toEqual(["unanswered-blocking-probe"]);
  });

  it("the lease is judged before the evidence — a live driver holds even on a clean PR", () => {
    expect(holdOf(decide({ lease: "held-live" }))).toBe("driver-alive");
  });

  it("held-dead recovery runs on the SHORT clock, not the full cooldown", () => {
    // The scenario the invariant was written for: an app restart kills the driver, so its dispatch
    // and its observed exit are both several minutes old. Charging the full 30-minute cooldown would
    // hold the recovery on exactly the PR rule 4 promises to restart.
    const at = T0 - (BABYSIT_RECOVERY_COOLDOWN_MS + MIN);
    const fleet = { recentDispatchAt: [at], freeAgentSlots: 3, lastDispatchAt: at, lastDriverExitAt: at };
    const pr = snapshot({ gate: gate([probe()]) });
    expect(decide({ pr, lease: "held-dead", fleet }).dispatch).toBe(true);
    // Same fleet, a lease that is merely free: the FULL cooldown still applies. Without this half
    // "the short clock is used for a dead lease" and "the cooldown was deleted" read identically.
    expect(holdOf(decide({ pr, lease: "free", fleet }))).toBe("cooling-down");
  });

  it("a held-dead driver dispatched SECONDS ago still holds — the loop has a per-PR limiter", () => {
    // Without this the exemption has no limiter at all: at a 180 s sweep, a PR whose driver dies on
    // every start would spend the whole FLEET-WIDE hourly budget in about nine minutes, and every
    // healthy PR would then report `rate-limited` — a reason naming the ceiling, not the PR burning
    // it. It is also the grace period that tolerates a wrong liveness read.
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - 30 * 1000 };
    expect(holdOf(decide({ pr: snapshot({ gate: gate([probe()]) }), lease: "held-dead", fleet }))).toBe(
      "cooling-down",
    );
  });

  it("the held-dead loop is bounded by the capacity and hourly ceilings too", () => {
    const recentDispatchAt = Array.from({ length: BABYSIT_DISPATCHES_PER_HOUR }, (_, i) => T0 - (i + 1) * MIN);
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, lease: "held-dead", fleet: { recentDispatchAt, freeAgentSlots: 3 } }))).toBe(
      "rate-limited",
    );
    expect(holdOf(decide({ pr, lease: "held-dead", fleet: { recentDispatchAt: [], freeAgentSlots: 0 } }))).toBe(
      "at-capacity",
    );
  });

  it("held-dead still has to clear the two-observation rule", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, lease: "held-dead", prior: undefined }))).toBe("single-observation");
  });
});

describe("three states — the read that could not look", () => {
  it("probes: undefined holds probe-read-unknown, NOT no-evidence", () => {
    const pr = snapshot({ gate: UNKNOWN_GATE });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("probe-read-unknown");
  });

  it("THE WIRE FORM: probes: null holds probe-read-unknown too, NOT no-evidence", () => {
    // The case above builds `undefined` by hand; the PRODUCER never sends that. `probes` mirrors
    // Rust `Option<Vec<Probe>>` with no `skip_serializing_if`, so an unreadable read arrives over IPC
    // as literal `null`. The old `=== undefined` guard missed it and returned `no-evidence` — the
    // fail-OPEN direction, claiming "we looked; this PR is fine" about a PR nobody could look at.
    const pr = snapshot({ gate: { ...UNKNOWN_GATE, probes: null } });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("probe-read-unknown");
  });

  it("applicable: false with green checks is no-evidence, not probe-read-unknown", () => {
    const pr = snapshot({ gate: NOT_APPLICABLE_GATE, checks: "passing" });
    expect(holdOf(decide({ pr }))).toBe("no-evidence");
  });

  it("probes: [] is 'asked; none' — no-evidence, and distinct from the unknown above", () => {
    expect(holdOf(decide({ pr: snapshot({ gate: gate([]) }) }))).toBe("no-evidence");
  });

  it("an unknown probe read does NOT block a dispatch that other evidence already justifies", () => {
    // The unknown is not evidence and manufactures nothing; it is only the reason we cannot claim
    // "no evidence" when the list came back empty. With a conflicting PR it did not come back empty.
    const pr = snapshot({ gate: UNKNOWN_GATE, mergeStateStatus: "DIRTY" });
    const d = decide({ pr });
    expect(d.dispatch).toBe(true);
    if (!d.dispatch) throw new Error("unreachable");
    expect(d.evidence.map((e) => e.id)).toEqual(["merge-conflicting"]);
  });
});

describe("rule 3 — the two-observation rule", () => {
  it("the first sweep that sees a condition holds with single-observation", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, prior: { evidenceIds: [] } }))).toBe("single-observation");
  });

  it("no prior sweep at all also holds with single-observation", () => {
    const pr = snapshot({ gate: gate([probe()]) });
    expect(holdOf(decide({ pr, prior: undefined }))).toBe("single-observation");
  });

  it("a DIFFERENT condition last sweep does not satisfy it", () => {
    const pr = snapshot({ gate: gate([probe({ commentId: 5, index: 1 })]) });
    expect(holdOf(decide({ pr, prior: { evidenceIds: ["blocking-probe:5#2"] } }))).toBe(
      "single-observation",
    );
  });

  it("the same condition twice in a row dispatches, even as the rest of the PR changes around it", () => {
    const p = probe({ commentId: 5, index: 1 });
    const sweep1 = snapshot({ gate: gate([p]), checks: "pending" });
    expect(holdOf(decide({ pr: sweep1, prior: { evidenceIds: [] } }))).toBe("single-observation");

    const sweep2 = snapshot({ gate: gate([p]), checks: "failing" });
    const d = decide({ pr: sweep2, prior: { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(sweep1)) } });
    expect(d.dispatch).toBe(true);
  });
});

describe("rule 2 — the ⏸ knightwatch paused repost storm", () => {
  it("N consecutive status-only readings produce ZERO dispatches", () => {
    // A lifecycle status post carries the review marker and lists no probes, so the read is
    // AUTHORITATIVE with an empty probe list however many times the bot reposts. Thirty sweeps is an
    // hour of a two-minute repost cycle — well past the two sightings the persistence rule needs.
    const holds: string[] = [];
    let prior: { evidenceIds: string[] } = { evidenceIds: [] };
    for (let i = 0; i < 30; i++) {
      const pr = snapshot({ gate: { applicable: true, probes: [], error: null, overridden: false } });
      const d = decide({ pr, prior, now: T0 + i * 2 * MIN });
      holds.push(holdOf(d));
      prior = { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(pr)) };
    }
    expect(holds).toHaveLength(30);
    expect(new Set(holds)).toEqual(new Set(["no-evidence"]));
  });
});

describe("the PR itself", () => {
  it("a merged PR holds with pr-not-open even carrying an unanswered blocking probe", () => {
    const pr = snapshot({ state: "merged", gate: gate([probe()]) });
    expect(holdOf(decide({ pr }))).toBe("pr-not-open");
  });

  it("a closed PR holds with pr-not-open", () => {
    expect(holdOf(decide({ pr: snapshot({ state: "closed", gate: gate([probe()]) }) }))).toBe("pr-not-open");
  });

  it("an unreadable PR state has its OWN hold, never pr-not-open", () => {
    const pr = snapshot({ state: "unknown", gate: gate([probe()]) });
    expect(holdOf(decide({ pr }))).toBe("pr-state-unknown");
  });
});

describe("cost ceilings", () => {
  const withProbe = () => snapshot({ gate: gate([probe()]) });

  it("disabled holds with disabled, ahead of everything else", () => {
    expect(holdOf(decide({ pr: withProbe(), config: resolveBabysitConfig({ enabled: false }) }))).toBe(
      "disabled",
    );
  });

  it("a dispatch inside the cooldown holds with cooling-down", () => {
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - BABYSIT_COOLDOWN_MS + MIN };
    expect(holdOf(decide({ pr: withProbe(), fleet }))).toBe("cooling-down");
  });

  it("the cooldown clears exactly at its boundary", () => {
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - BABYSIT_COOLDOWN_MS };
    expect(decide({ pr: withProbe(), fleet }).dispatch).toBe(true);
  });

  it("a driver that just EXITED cools down even when its dispatch is ancient", () => {
    // The half the dispatch timestamp alone cannot cover: a pass longer than the cooldown would
    // otherwise be re-dispatched the moment it ended.
    const fleet = {
      recentDispatchAt: [],
      freeAgentSlots: 3,
      lastDispatchAt: T0 - 10 * BABYSIT_COOLDOWN_MS,
      lastDriverExitAt: T0 - MIN,
    };
    expect(holdOf(decide({ pr: withProbe(), fleet }))).toBe("cooling-down");
  });

  it("a dispatch that was never followed by an observed exit still cools down", () => {
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - MIN, lastDriverExitAt: undefined };
    expect(holdOf(decide({ pr: withProbe(), fleet }))).toBe("cooling-down");
  });

  it("no free slot holds with at-capacity, never queues silently", () => {
    const fleet = { recentDispatchAt: [], freeAgentSlots: 0 };
    expect(holdOf(decide({ pr: withProbe(), fleet }))).toBe("at-capacity");
  });

  it("a spent hourly ceiling holds with rate-limited", () => {
    const recentDispatchAt = Array.from({ length: BABYSIT_DISPATCHES_PER_HOUR }, (_, i) => T0 - (i + 1) * MIN);
    expect(holdOf(decide({ pr: withProbe(), fleet: { recentDispatchAt, freeAgentSlots: 3 } }))).toBe(
      "rate-limited",
    );
  });

  it("dispatches older than the window roll off the ceiling", () => {
    const recentDispatchAt = Array.from(
      { length: BABYSIT_DISPATCHES_PER_HOUR },
      () => T0 - BABYSIT_RATE_WINDOW_MS,
    );
    expect(decide({ pr: withProbe(), fleet: { recentDispatchAt, freeAgentSlots: 3 } }).dispatch).toBe(true);
  });

  it("a ceiling of zero means measure-but-never-dispatch, and says so", () => {
    const d = decide({
      pr: withProbe(),
      config: resolveBabysitConfig({ maxDispatchesPerHour: 0 }),
      fleet: { recentDispatchAt: [], freeAgentSlots: 3 },
    });
    expect(holdOf(d)).toBe("rate-limited");
  });

  it("the ceilings are judged AFTER the evidence, so they only ever fire on a PR that would have gone", () => {
    // A healthy PR at capacity must still read `no-evidence`. If capacity were checked first, every
    // quiet PR on a busy machine would report `at-capacity` and bury the one case worth seeing.
    const fleet = { recentDispatchAt: [T0, T0, T0, T0], freeAgentSlots: 0, lastDispatchAt: T0 };
    expect(holdOf(decide({ fleet }))).toBe("no-evidence");
  });
});

describe("resolveBabysitConfig", () => {
  it("defaults are the documented constants", () => {
    expect(resolveBabysitConfig()).toEqual({
      enabled: true,
      cooldownMs: BABYSIT_COOLDOWN_MS,
      recoveryCooldownMs: BABYSIT_RECOVERY_COOLDOWN_MS,
      maxDispatchesPerHour: BABYSIT_DISPATCHES_PER_HOUR,
    });
    // The recovery clock is SHORTER than the normal one, or the `held-dead` path would be a
    // pessimisation wearing the name of a recovery.
    expect(BABYSIT_RECOVERY_COOLDOWN_MS).toBeLessThan(BABYSIT_COOLDOWN_MS);
  });

  it("explicit values win", () => {
    expect(
      resolveBabysitConfig({ enabled: false, cooldownMs: 9 * MIN, recoveryCooldownMs: 2 * MIN, maxDispatchesPerHour: 9 }),
    ).toEqual({ enabled: false, cooldownMs: 9 * MIN, recoveryCooldownMs: 2 * MIN, maxDispatchesPerHour: 9 });
  });

  it("a recovery clock LONGER than the normal cooldown is clamped, not honoured", () => {
    // Validating each field in isolation is not enough: the held-dead path rests on the recovery
    // clock being the shorter one, and an inverted config would make a DEAD lease wait longer than a
    // merely free one — the "silently stops being watched" outcome, delivered by the code added to
    // prevent it.
    const config = resolveBabysitConfig({ cooldownMs: 30 * MIN, recoveryCooldownMs: 90 * MIN });
    expect(config.recoveryCooldownMs).toBe(30 * MIN);

    // And the clamp is load-bearing on the decision, not merely on the returned object: at 45 min
    // old, the honoured 90-minute clock would have held a dead lease that the free one dispatches.
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - 45 * MIN };
    const pr = snapshot({ gate: gate([probe()]) });
    expect(decide({ pr, lease: "held-dead", config, fleet }).dispatch).toBe(true);
  });

  it("the clamp binds against the RESOLVED cooldownMs, not against the default constant", () => {
    // The more plausible operator edit is LOWERING the normal cooldown, not typing a 90-minute
    // recovery clock — and a clamp written against `BABYSIT_COOLDOWN_MS` instead of the resolved
    // field survives every other test here, because every other config leaves `cooldownMs` at its
    // default. It would leave the 5-minute default recovery in place under a 2-minute cooldown, so a
    // DEAD lease would wait 2.5x longer than a merely free one: the inversion, reintroduced.
    const config = resolveBabysitConfig({ cooldownMs: 2 * MIN });
    expect(config.recoveryCooldownMs).toBe(2 * MIN);

    const pr = snapshot({ gate: gate([probe()]) });
    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - 3 * MIN };
    expect(decide({ pr, lease: "held-dead", config, fleet }).dispatch).toBe(true);
  });

  it("the configured recovery clock is what the held-dead path actually reads", () => {
    // Cut with a SHORTER clock than the default cooldown, so the case being pinned is a legal
    // config. 90 s since the dispatch is inside the configured 2-minute recovery clock (⇒ hold) and
    // 3 min is outside it (⇒ dispatch) — while both are far inside the 30-minute cooldown a free
    // lease uses, which is what distinguishes "reads recoveryCooldownMs" from "reads cooldownMs"
    // AND from "has no cooldown".
    const config = resolveBabysitConfig({ recoveryCooldownMs: 2 * MIN });
    const pr = snapshot({ gate: gate([probe()]) });
    const at = (ago: number) => ({ recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - ago });

    expect(holdOf(decide({ pr, lease: "held-dead", config, fleet: at(90 * 1000) }))).toBe("cooling-down");
    expect(decide({ pr, lease: "held-dead", config, fleet: at(3 * MIN) }).dispatch).toBe(true);
    expect(holdOf(decide({ pr, lease: "free", config, fleet: at(3 * MIN) }))).toBe("cooling-down");
  });

  it("a NaN or negative number falls back rather than silently deleting the limit", () => {
    // NaN compares false against everything, so an unguarded NaN cooldown removes the cooldown
    // entirely — the failure this branch exists to catch.
    const c = resolveBabysitConfig({ cooldownMs: Number.NaN, recoveryCooldownMs: -5, maxDispatchesPerHour: -1 });
    expect(c.cooldownMs).toBe(BABYSIT_COOLDOWN_MS);
    expect(c.recoveryCooldownMs).toBe(BABYSIT_RECOVERY_COOLDOWN_MS);
    expect(c.maxDispatchesPerHour).toBe(BABYSIT_DISPATCHES_PER_HOUR);

    const fleet = { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 - MIN };
    expect(holdOf(decide({ pr: snapshot({ gate: gate([probe()]) }), config: c, fleet }))).toBe("cooling-down");
  });
});

describe("every hold reason is reachable", () => {
  it("covers the whole union", () => {
    const p = () => snapshot({ gate: gate([probe()]) });
    const reached = [
      holdOf(decide({ pr: p(), config: resolveBabysitConfig({ enabled: false }) })),
      holdOf(decide()),
      holdOf(decide({ pr: p(), lease: "held-live" })),
      holdOf(decide({ pr: p(), lease: "unknown" })),
      holdOf(decide({ pr: snapshot({ gate: UNKNOWN_GATE }) })),
      holdOf(decide({ pr: p(), prior: undefined })),
      holdOf(decide({ pr: p(), fleet: { recentDispatchAt: [], freeAgentSlots: 0 } })),
      holdOf(
        decide({
          pr: p(),
          fleet: { recentDispatchAt: [T0, T0, T0, T0], freeAgentSlots: 3 },
        }),
      ),
      holdOf(decide({ pr: p(), fleet: { recentDispatchAt: [], freeAgentSlots: 3, lastDispatchAt: T0 } })),
      holdOf(decide({ pr: snapshot({ state: "closed" }) })),
      holdOf(decide({ pr: snapshot({ state: "unknown" }) })),
    ];
    expect(new Set(reached)).toEqual(
      new Set([
        "disabled",
        "no-evidence",
        "driver-alive",
        "lease-unknown",
        "probe-read-unknown",
        "single-observation",
        "at-capacity",
        "rate-limited",
        "cooling-down",
        "pr-not-open",
        "pr-state-unknown",
      ]),
    );
  });
});

// THE STRUCTURAL BUG THIS CLOSES: knightwatch GATES the merge but TRIGGERS on PR-open, so the gate
// is satisfiable and then silently invalidated — answer the probes, gate clears, push more code,
// merge code nobody reviewed. Every assertion below reads the returned evidence/decision, and the
// headline test walks the whole steady state rather than asserting a single snapshot.
describe("evidence — commits pushed since the last review", () => {
  const HEAD_OLD = `9c65efe${"0".repeat(33)}`;
  const HEAD_NEW = `4d3030a${"1".repeat(33)}`;

  /** The HEALTHY state: the newest review really did read this head. */
  function covered(head: string): BabysitPrSnapshot {
    return snapshot({
      headSha: head,
      gate: gate([], { reviewedHead: head.slice(0, 7), reviewStale: false }),
    });
  }

  /** The head has moved past what was reviewed. */
  function uncovered(head: string, reviewed: string): BabysitPrSnapshot {
    return snapshot({ headSha: head, gate: gate([], { reviewedHead: reviewed }) });
  }

  it("THE BUG: a push after a CLEARED gate re-triggers a driver", () => {
    // 1. Settled and healthy — probes answered, checks green, review covers the head.
    const settled = covered(HEAD_OLD);
    expect(babysitEvidenceFor(settled)).toEqual([]);
    expect(holdOf(decide({ pr: settled }))).toBe("no-evidence");

    // 2. Someone pushes. Nothing else about the PR changed; the review now covers a superseded sha.
    const pushed = uncovered(HEAD_NEW, HEAD_OLD.slice(0, 7));
    expect(babysitEvidenceFor(pushed).map((e) => e.kind)).toEqual([
      "commits-pushed-since-last-review",
    ]);

    // 3. Rule 3 is NOT bypassed. The first sweep that sees it only remembers it — which is also what
    //    debounces a burst of pushes into one dispatch.
    const first = decide({
      pr: pushed,
      prior: { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(settled)) },
    });
    expect(holdOf(first)).toBe("single-observation");

    // 4. The next sweep, head unchanged, DISPATCHES. The gate re-armed itself.
    const second = decide({
      pr: pushed,
      prior: { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(pushed)) },
    });
    expect(second.dispatch).toBe(true);
    if (!second.dispatch) throw new Error("unreachable");
    expect(second.evidence.map((e) => e.kind)).toEqual(["commits-pushed-since-last-review"]);
    expect(second.evidence[0]?.detail).toContain("4d3030a");
  });

  /**
   * THE DETAIL MUST NOT NAME A REVIEWER. Both inputs it is built from (`reviewStale`,
   * `reviewedHead`) come from `probe-gate.sh --json`, whose `coverage_of` counts a
   * `<!-- sparkle-reviewer:auto-post -->` review identically to a knightwatch one — so this string
   * is emitted for reviews `scripts/pr-review.sh` produced, and naming knightwatch attributed them
   * to a bot that never touched the PR.
   *
   * This is asserted because the SAME misattribution existed in THREE emitters and a change that
   * fixed two of them missed this one (roborev 67322). A copy-only fix with nothing pinning it is
   * exactly what comes back; both branches are covered because the stale branch and the
   * moved-head branch are separate strings and only one is exercised by the test above.
   */
  it("names no reviewer — the same string covers knightwatch and Sparkle reviews alike", () => {
    const movedHead = babysitEvidenceFor(uncovered(HEAD_NEW, HEAD_OLD.slice(0, 7)));
    const stale = babysitEvidenceFor(
      snapshot({ headSha: HEAD_NEW, gate: gate([], { reviewedHead: HEAD_NEW.slice(0, 7), reviewStale: true }) }),
    );

    for (const [label, evidence] of [
      ["moved head", movedHead],
      ["self-labelled stale", stale],
    ] as const) {
      const detail = evidence.find((e) => e.kind === "commits-pushed-since-last-review")?.detail;
      expect(detail, `${label}: this branch must produce the evidence at all`).toBeTruthy();
      expect(detail, `${label}: must not attribute the review to a specific bot`).not.toMatch(
        /knightwatch|srosro|sparkle-reviewer/i,
      );
      expect(detail, `${label}: still says the head is unreviewed`).toContain("unreviewed");
    }
  });

  it("a 7-char abbreviation covering the 40-char head is not evidence", () => {
    expect(babysitEvidenceFor(covered(HEAD_NEW))).toEqual([]);
  });

  it("the prefix test runs SHORT-against-LONG, never the reverse", () => {
    // Flipping the operands (`reviewedHead.startsWith(headSha)`) would report this as covered — and
    // would report almost every genuinely-uncovered PR as covered too. Pins the direction.
    const pr = snapshot({ headSha: "9c65efe", gate: gate([], { reviewedHead: HEAD_OLD }) });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "commits-pushed-since-last-review",
    ]);
  });

  it("the stale self-label is evidence even when the status form is unparseable", () => {
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: undefined, reviewStale: true }),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "commits-pushed-since-last-review",
    ]);
  });

  it("the stale self-label outranks our own sha arithmetic", () => {
    // The bot knows what it actually diffed; believing the shas over its own label is how #1273's
    // last four commits went unreviewed.
    const pr = snapshot({
      headSha: HEAD_OLD,
      gate: gate([], { reviewedHead: HEAD_OLD.slice(0, 7), reviewStale: true }),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "commits-pushed-since-last-review",
    ]);
  });

  it("UNKNOWN coverage manufactures nothing — the repost-storm defence still holds", () => {
    // `⏸ knightwatch paused` carries the marker, names no sha, and reposts every ~2 minutes. Reading
    // that as "unreviewed" would spend a full Claude session per repost, during the exact window the
    // account is already in trouble.
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: undefined, reviewStale: false }),
    });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("THE WIRE FORM: reviewedHead: null is UNKNOWN, and does not throw out of the sweep", () => {
    // The case above hand-builds `undefined`; Rust `Option<String>` reaches this code as `null`, and
    // the old guard read `null !== undefined` as "a head was named" and then dereferenced `.length`.
    // The throw escaped all the way to `sweepAllProjects`' per-project catch, so ONE PR in this state
    // aborted its whole project's sweep and every PR after it went unswept.
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: null, reviewStale: false }),
    });
    expect(() => babysitEvidenceFor(pr)).not.toThrow();
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("THE WIRE FORM: a null head with a STALE self-label still reports uncovered", () => {
    // The null must not swallow the other half of the fix: `reviewStale` is authoritative on its own,
    // so a paused-then-stale review still yields evidence rather than being silenced by the guard.
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: null, reviewStale: true }),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toContain("commits-pushed-since-last-review");
  });

  it("a PR with no knightwatch at all yields nothing, however far the head has moved", () => {
    // As Rust actually builds it: `not_applicable()` carries no coverage, so what stops this is the
    // UNKNOWN-coverage guard, not the `applicable` one. Pinned separately below for that reason.
    expect(babysitEvidenceFor(snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE }))).toEqual([]);
  });

  it("`applicable: false` suppresses coverage even if the producer sends coverage anyway", () => {
    // This pair cannot occur today — Rust's `not_applicable()` never emits `reviewedHead` — which is
    // exactly why the guard needs a test that ISOLATES it. Deleting the `applicable` check leaves the
    // realistic fixture above still green (it is stopped by the unknown guard), so that test alone
    // would be vacuous cover: a mutation run proved it passes with the guard removed. `readProbeGate`
    // CASTS its IPC reply, so a drifted producer reaches this module unchecked — and without this
    // check every PR in every non-Sparkle project would dispatch a driver, forever.
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: {
        applicable: false,
        probes: [],
        error: null,
        overridden: false,
        reviewedHead: "1111111",
        reviewStale: true,
      },
    });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("an unread head yields nothing — no identity to carry across sweeps", () => {
    const pr = snapshot({ headSha: undefined, gate: gate([], { reviewedHead: "9c65efe" }) });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("the id is keyed on the HEAD, so a moving head never clears rule 3 but a settled one does", () => {
    const a = babysitEvidenceFor(uncovered(HEAD_OLD, "1111111"))[0];
    const b = babysitEvidenceFor(uncovered(HEAD_NEW, "1111111"))[0];
    expect(a?.id).not.toBe(b?.id);
    // A settled head keeps ONE identity across sweeps, which is what lets the gate ever open.
    expect(babysitEvidenceFor(uncovered(HEAD_NEW, "1111111"))[0]?.id).toBe(b?.id);
  });

  it("sorts after the probe kinds and before the CI conditions", () => {
    const pr = snapshot({
      headSha: HEAD_NEW,
      checks: "failing",
      gate: gate([probe()], { reviewedHead: "1111111" }),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "unanswered-blocking-probe",
      "commits-pushed-since-last-review",
      "checks-failing",
    ]);
  });

  it("a probe override does not suppress it — waiving probes says nothing about coverage", () => {
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([probe()], { overridden: true, reviewedHead: "1111111" }),
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "commits-pushed-since-last-review",
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
// `never-reviewed` — the FIRST review, which nothing else in the repo produces
// -------------------------------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS. `[review].require_review` (knightwatch.rs `coverage_for_repo`,
// probe-gate.sh `compute_coverage`) refuses a PR that carries no review of any kind. The gate is
// correct and its test is non-vacuous under mutation — but it ships OFF and cannot safely be armed,
// because NOTHING produces a first review: no CI workflow runs `scripts/pr-review.sh`, and every
// `BabysitEvidenceKind` above presupposes either a review that already exists
// (`commits-pushed-since-last-review` is defined against the head the newest review read) or a
// failing/absent check. A green, unreviewed, non-conflicting PR therefore generates no evidence at
// all, is never picked up, and would be born blocked the moment the key is turned on.
//
// THE SHAPE THAT KEEPS RULE 1 INTACT. "This PR carries no review of any kind" is a STANDING FACT
// re-derived every sweep, not an event: it is false forever once any review lands. That is the same
// test `commits-pushed-since-last-review` passes and `pr-opened` fails, so admitting it does not
// re-open the dispatch-on-schedule door the header closes.
//
// EVERY ASSERTION READS THE EMITTED EVIDENCE, and the inert cases are paired with a live one on the
// SAME fixture — a test that only proved absence would stay green if the rule were keyed to the
// wrong field entirely (AGENTS.md, "an earlier guard short-circuits the path").
describe("`never-reviewed` — a PR nobody has ever reviewed", () => {
  /** A full 40-char head, as `headRefOid` sends it. Local: the sibling block's copy is not in scope. */
  const HEAD_NEW = `4d3030a${"1".repeat(33)}`;
  /** The armed repo: the key is on AND a reviewer exists to satisfy it. */
  const ARMED = { requireReview: true, prReviewer: "sparkle-reviewer" } as const;

  it("fires when the repo has armed require_review and the PR carries no review at all", () => {
    const pr = snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE, ...ARMED });
    const evidence = babysitEvidenceFor(pr);
    expect(evidence.map((e) => e.kind)).toEqual(["never-reviewed"]);
    expect(evidence[0]?.id).toBe(`never-reviewed:${HEAD_NEW}`);
    // Case-insensitive on purpose: the phrase is the claim, its position in the sentence is not.
    expect(evidence[0]?.detail).toMatch(/no review of any kind/i);
    // The head is NAMED — a refusal an author has to act on must say which commit is unreviewed.
    expect(evidence[0]?.detail).toContain(HEAD_NEW.slice(0, 7));
  });

  it("PAIRED WITH THE ABOVE: that same PR actually reaches a dispatch", () => {
    // Absence-only assertions pass for a rule that never fires at all. This proves the evidence
    // survives every LATER gate in `decideBabysitDispatch` and produces the driver the key needs.
    const pr = snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE, ...ARMED });
    const d = decide({ pr });
    expect(d.dispatch).toBe(true);
    if (!d.dispatch) throw new Error(`expected a dispatch, got ${d.hold}`);
    expect(d.evidence.map((e) => e.kind)).toContain("never-reviewed");
  });

  it("is INERT when the repo has not armed the key — the shipped default", () => {
    // `requireReview: undefined` is the state of every repo today, and of every non-Sparkle project.
    const pr = snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("no-evidence");
  });

  it("is INERT when the key is explicitly off", () => {
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: NOT_APPLICABLE_GATE,
      requireReview: false,
      prReviewer: "sparkle-reviewer",
    });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("THE `none` HATCH SITS ABOVE THE KEY: a repo with no reviewer never dispatches", () => {
    // Mirrors the ordering `coverage_for_repo` states in its own words: a repo with no PR-scoped
    // reviewer cannot produce the review this evidence would demand, so honouring the key there
    // would dispatch a driver forever against work nobody can ever satisfy. AGENTS.md: collapsing
    // the hatch into the gate is "the one way to get this gate wrong".
    const pr = snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE, requireReview: true, prReviewer: "none" });
    expect(babysitEvidenceFor(pr)).toEqual([]);
    expect(holdOf(decide({ pr }))).toBe("no-evidence");
  });

  it("does NOT fire once ANY review exists — that is the other kind's job", () => {
    // The whole point of the key is telling "never reviewed" apart from "reviewed and passed". A
    // PR whose review covers its head is CLEAR, and must stay clear with the key armed.
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: HEAD_NEW.slice(0, 7) }),
      ...ARMED,
    });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("holds when we never read the head — no stable id to carry across sweeps", () => {
    const pr = snapshot({ headSha: undefined, gate: NOT_APPLICABLE_GATE, ...ARMED });
    expect(babysitEvidenceFor(pr)).toEqual([]);
  });

  it("holds on an UNKNOWN gate read — `applicable: true, probes: undefined` is not `no review`", () => {
    // "We could not look" must never render as "nobody has ever looked": the first is a broken read,
    // the second is a claim about the PR. Collapsing them is the bug this module repeatedly guards.
    const pr = snapshot({ headSha: HEAD_NEW, gate: UNKNOWN_GATE, ...ARMED });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).not.toContain("never-reviewed");
  });

  it("ranks with the review-coverage facts, ahead of the CI and merge conditions", () => {
    const pr = snapshot({
      headSha: HEAD_NEW,
      gate: NOT_APPLICABLE_GATE,
      mergeStateStatus: "dirty",
      checks: "failing",
      ...ARMED,
    });
    expect(babysitEvidenceFor(pr).map((e) => e.kind)).toEqual([
      "never-reviewed",
      "merge-conflicting",
      "checks-failing",
    ]);
  });

  it("the id is STANDING, not an event: it survives a sweep and clears when a review lands", () => {
    const before = snapshot({ headSha: HEAD_NEW, gate: NOT_APPLICABLE_GATE, ...ARMED });
    // Same condition, second sweep — the id must be EQUAL or rule 3 could never be satisfied.
    expect(babysitEvidenceIds(babysitEvidenceFor(before))).toEqual(
      babysitEvidenceIds(babysitEvidenceFor(before)),
    );
    // A review lands on the very same head: the fact is now false, forever.
    const after = snapshot({
      headSha: HEAD_NEW,
      gate: gate([], { reviewedHead: HEAD_NEW.slice(0, 7) }),
      ...ARMED,
    });
    expect(babysitEvidenceIds(babysitEvidenceFor(after))).toEqual([]);
  });
});
