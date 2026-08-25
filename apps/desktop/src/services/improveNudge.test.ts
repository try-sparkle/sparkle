import { beforeEach, describe, expect, it } from "vitest";
import {
  ADVANCE_IDLE_MS,
  NEVER_IDLE_CADENCE_MS,
  NEVER_IDLE_NUDGE_TEXT,
  NEVER_IDLE_ESCALATED_NUDGE_TEXT,
  NEVER_IDLE_ESCALATE_AFTER,
  neverIdleNudgeText,
  respinFleetNudgeText,
  _resetImproveNudgeForTests,
  decideImproveNudge,
  improveLastNudgedAt,
  sweepImproveNudge,
  type ImproveNudgeDeps,
  type ImproveNudgeInput,
} from "./improveNudge";
import type { AgentTabStatus } from "../types";

// ── A deps builder that RECORDS the side effect (the nudge send) into an array ────────────────────
// The contract this feature exists for is "a nudge was DELIVERED to the Improve Sparkle agent", so
// every test asserts on `sent`, never on the decision's return value alone. `send` resolves true by
// default (a confirmed delivery); a test overrides it to model a transport failure.
//
// `fingerprint` models the agent's concrete-output summary. Because advance is judged across sweeps,
// tests that exercise it drive several sweeps with the same or a changed fingerprint at chosen times.
function makeDeps(
  overrides: Partial<{
    now: number;
    armed: boolean;
    ownsProject: boolean;
    consentIsNever: boolean;
    paneStatus: AgentTabStatus | undefined;
    fingerprint: string | null;
    ready: number;
    p1PipelineHealth: number;
    freeSlots: number;
    activeWorkers: number;
    sendResult: boolean;
  }> = {},
): { deps: ImproveNudgeDeps; sent: string[] } {
  const sent: string[] = [];
  const o = {
    now: 1_000_000,
    armed: true,
    ownsProject: true,
    consentIsNever: false,
    paneStatus: "idle" as AgentTabStatus | undefined,
    fingerprint: "idle" as string | null,
    ready: 3,
    p1PipelineHealth: 0,
    // DEFAULT: workers already draining, so the default idle-with-backlog case takes the GENERIC
    // reminder path (which the escalation/rate-limit/grace suites below exercise). The re-spin suite
    // overrides `activeWorkers: 0` to reach the specific push.
    freeSlots: 4,
    activeWorkers: 2,
    sendResult: true,
    ...overrides,
  };
  return {
    sent,
    deps: {
      now: () => o.now,
      armed: () => o.armed,
      ownsProject: () => o.ownsProject,
      consentIsNever: () => o.consentIsNever,
      paneStatus: () => o.paneStatus,
      advanceFingerprint: () => o.fingerprint,
      readyBacklog: () => ({ ready: o.ready, p1PipelineHealth: o.p1PipelineHealth }),
      capacity: () => ({ freeSlots: o.freeSlots, activeWorkers: o.activeWorkers }),
      send: async (text: string) => {
        sent.push(text);
        return o.sendResult;
      },
    },
  };
}

/** Sweep at t0 to establish the fingerprint baseline (grace interval), then sweep again `after` ms
 *  later with the SAME fingerprint (i.e. no concrete advance in between). Returns the second sweep's
 *  sent array so a test can assert whether the stale-idle nudge fired. */
async function sweepStaleThen(
  after: number,
  overrides: Parameters<typeof makeDeps>[0] = {},
): Promise<string[]> {
  const t0 = 5_000_000;
  await sweepImproveNudge(makeDeps({ ...overrides, now: t0 }).deps); // baseline
  const second = makeDeps({ ...overrides, now: t0 + after });
  await sweepImproveNudge(second.deps);
  return second.sent;
}

describe("sweepImproveNudge — the side effect, keyed off concrete advance not children", () => {
  beforeEach(() => _resetImproveNudgeForTests());

  it("idle with a FLAT fingerprint past the idle interval + ready backlog → sends the nudge", async () => {
    // No commit/edit/bead in the whole interval — the agent is idle-watching or resting. This is the
    // case a 'children exist' gate would have wrongly suppressed; here it nudges.
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS);
    expect(sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  // ── THE RE-SPIN PUSH (bead sparkle-4hwu2i) — the SIDE EFFECT: given idle + ready backlog + free
  //    slots + zero active workers, the SPECIFIC "spin a drain fleet NOW" message naming the numbers
  //    is what actually lands in the inbox, not the generic reminder. ───────────────────────────────
  it("idle + ready backlog + free slots + ZERO active workers → sends the SPECIFIC re-spin message with the numbers", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 7, freeSlots: 5, activeWorkers: 0 });
    expect(sent).toEqual([respinFleetNudgeText(7, 5)]);
    // and it is DISTINCT from the generic reminder — the whole point of the bead.
    expect(sent[0]).not.toBe(NEVER_IDLE_NUDGE_TEXT);
  });

  it("the re-spin message names the exact ready-bead and free-slot counts, and 0 workers", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 4, freeSlots: 9, activeWorkers: 0 });
    expect(sent[0]).toContain("4 ready beads");
    expect(sent[0]).toContain("9 free agent slots");
    expect(sent[0]).toContain("0 active workers");
    expect(sent[0]).toContain("spin maximally");
  });

  it("idle + ready backlog + free slots but workers ALREADY draining → keeps the GENERIC reminder", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 7, freeSlots: 5, activeWorkers: 3 });
    expect(sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  it("idle + ready backlog + zero workers but NO free slots (machine full) → keeps the GENERIC reminder", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 7, freeSlots: 0, activeWorkers: 0 });
    expect(sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  // THE ESCALATION (the durable fix for an agent that answers the nudge instead of shipping). Keyed on
  // the advance fingerprint — a reworded deferral does not move it, so only a real artifact resets it.
  const tick = async (t: number, fingerprint: string): Promise<string[]> => {
    const d = makeDeps({ now: t, fingerprint });
    await sweepImproveNudge(d.deps);
    return d.sent;
  };

  it("the pure selector: soft below the threshold, escalated at or above it", () => {
    expect(neverIdleNudgeText(0)).toBe(NEVER_IDLE_NUDGE_TEXT);
    expect(neverIdleNudgeText(NEVER_IDLE_ESCALATE_AFTER - 1)).toBe(NEVER_IDLE_NUDGE_TEXT);
    expect(neverIdleNudgeText(NEVER_IDLE_ESCALATE_AFTER)).toBe(NEVER_IDLE_ESCALATED_NUDGE_TEXT);
    expect(neverIdleNudgeText(NEVER_IDLE_ESCALATE_AFTER + 3)).toBe(NEVER_IDLE_ESCALATED_NUDGE_TEXT);
  });

  it("escalates after repeated flat-signal nudges without a concrete advance", async () => {
    const t0 = 5_000_000;
    const C = NEVER_IDLE_CADENCE_MS; // == ADVANCE_IDLE_MS
    await tick(t0, "idle"); // baseline (grace) — no nudge
    const n1 = await tick(t0 + C, "idle"); // nudge #1
    const n2 = await tick(t0 + 2 * C, "idle"); // nudge #2
    const n3 = await tick(t0 + 3 * C, "idle"); // nudge #3 — the streak is now past the threshold
    expect(n1).toEqual([NEVER_IDLE_NUDGE_TEXT]);
    expect(n2).toEqual([NEVER_IDLE_NUDGE_TEXT]);
    expect(n3).toEqual([NEVER_IDLE_ESCALATED_NUDGE_TEXT]);
  });

  it("a concrete ADVANCE resets the streak — the next nudge is SOFT again, never carried-over escalated", async () => {
    // THE PAIRED CONTROL: without the reset an agent that ships once would still be shouted at. The
    // advance (a changed fingerprint) must return the next idle stretch to the soft reminder.
    const t0 = 5_000_000;
    const C = NEVER_IDLE_CADENCE_MS;
    await tick(t0, "idle"); // baseline
    await tick(t0 + C, "idle"); // nudge #1
    await tick(t0 + 2 * C, "idle"); // nudge #2 — one more flat nudge would escalate
    await tick(t0 + 2 * C + 1_000, "shipped-a-commit"); // ADVANCE → resets the streak, no nudge
    // A fresh flat stretch on the new fingerprint, a full interval later: it nudges SOFT, not escalated.
    const nAfter = await tick(t0 + 3 * C + 1_000, "shipped-a-commit");
    expect(nAfter).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  it("a fingerprint that MOVED within the interval → does NOT send (it advanced something concrete)", async () => {
    const t0 = 5_000_000;
    await sweepImproveNudge(makeDeps({ now: t0, fingerprint: "idle" }).deps);
    // It committed something a minute later — fingerprint moves, advance clock re-stamps.
    await sweepImproveNudge(makeDeps({ now: t0 + 60_000, fingerprint: "working" }).deps);
    // Now well past the interval, but measured from the LAST advance, not the baseline.
    const late = makeDeps({ now: t0 + 60_000 + ADVANCE_IDLE_MS - 1, fingerprint: "working" });
    const out = await sweepImproveNudge(late.deps);
    expect(out.detail).toBe("advanced-recently");
    expect(late.sent).toEqual([]);
  });

  it("within one interval of the baseline → does NOT send (grace)", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS - 1);
    expect(sent).toEqual([]);
  });

  it("a null fingerprint (nothing readable) never baselines → does NOT send (fail closed)", async () => {
    // Two sweeps far apart, but the outputs were never readable, so we never claim it went idle.
    const t0 = 5_000_000;
    await sweepImproveNudge(makeDeps({ now: t0, fingerprint: null }).deps);
    const later = makeDeps({ now: t0 + 10 * ADVANCE_IDLE_MS, fingerprint: null });
    const out = await sweepImproveNudge(later.deps);
    expect(out.detail).toBe("advanced-recently");
    expect(later.sent).toEqual([]);
  });

  it("a fingerprint that goes UNREADABLE (null) after a baseline never manufactures idle (66016)", async () => {
    // Baseline at t0, then the read breaks (status entry deleted while the pane is closed). A run of
    // nulls must NOT freeze the clock into an idle verdict — that would nudge an agent that may be
    // committing.
    const t0 = 5_000_000;
    await sweepImproveNudge(makeDeps({ now: t0, fingerprint: "idle" }).deps);
    const broken = makeDeps({ now: t0 + 10 * ADVANCE_IDLE_MS, fingerprint: null });
    const out = await sweepImproveNudge(broken.deps);
    expect(out.detail).toBe("advanced-recently");
    expect(broken.sent).toEqual([]);
  });

  it("does NOT nudge on the FIRST readable sample after a null outage — the blind stretch is not idle time (66023/66024)", async () => {
    // baseline → long null run (pane closed, status deleted) → pane reopens with the SAME status.
    // The nudge must NOT fire on that first sample; the outage restarted the clock, so a fresh full
    // interval of readable-flat signal is required first.
    const t0 = 5_000_000;
    await sweepImproveNudge(makeDeps({ now: t0, fingerprint: "idle" }).deps); // baseline
    await sweepImproveNudge(makeDeps({ now: t0 + 3 * ADVANCE_IDLE_MS, fingerprint: null }).deps); // blind
    // Pane reopens; same fingerprint, but only a moment after the outage — must be grace, not a nudge.
    const reopened = makeDeps({ now: t0 + 3 * ADVANCE_IDLE_MS + 1000, fingerprint: "idle" });
    const out = await sweepImproveNudge(reopened.deps);
    expect(out.detail).toBe("advanced-recently");
    expect(reopened.sent).toEqual([]);
    // …and a full fresh interval later, with the signal still flat, it DOES nudge.
    const later = makeDeps({ now: t0 + 3 * ADVANCE_IDLE_MS + 1000 + ADVANCE_IDLE_MS, fingerprint: "idle" });
    await sweepImproveNudge(later.deps);
    expect(later.sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  it("a throwing dep is contained — the sweep returns errored and never rejects", async () => {
    const throwing = {
      ...makeDeps().deps,
      readyBacklog: () => {
        throw new Error("store wedged");
      },
    };
    const out = await sweepImproveNudge(throwing);
    expect(out).toEqual({ sent: false, detail: "errored" });
  });

  it("idle + FLAT fingerprint but EMPTY backlog → does NOT send (it may rest — guardrail a)", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 0, p1PipelineHealth: 0 });
    expect(sent).toEqual([]);
  });

  it("idle + FLAT fingerprint + no backlog but an open P1 pipeline-health bead → sends (the OR arm)", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ready: 0, p1PipelineHealth: 1 });
    expect(sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });

  it("not armed → does NOT send (ships inert)", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { armed: false });
    expect(sent).toEqual([]);
  });

  it("another window owns sparkle-self → does NOT send", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { ownsProject: false });
    expect(sent).toEqual([]);
  });

  it("chat-only consent (never) → does NOT send", async () => {
    const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { consentIsNever: true });
    expect(sent).toEqual([]);
  });

  it.each(["working", "waiting", "approval", "blocked"] as const)(
    "own pane status %s is not at rest → does NOT send",
    async (status) => {
      const sent = await sweepStaleThen(ADVANCE_IDLE_MS, { paneStatus: status });
      expect(sent).toEqual([]);
    },
  );
});

describe("sweepImproveNudge — rate limiting (guardrail c: respect the cadence)", () => {
  beforeEach(() => _resetImproveNudgeForTests());

  it("a second sweep within the cadence does NOT re-nudge, even while still stale-idle-with-backlog", async () => {
    // Baseline, then go stale and nudge.
    const t0 = 5_000_000;
    await sweepImproveNudge(makeDeps({ now: t0 }).deps);
    const nudge = makeDeps({ now: t0 + ADVANCE_IDLE_MS });
    await sweepImproveNudge(nudge.deps);
    expect(nudge.sent).toHaveLength(1);
    expect(improveLastNudgedAt()).toBe(t0 + ADVANCE_IDLE_MS);

    // A minute later (< 10-minute nudge cadence): still stale, still backlog, but muted.
    const soon = makeDeps({ now: t0 + ADVANCE_IDLE_MS + 60_000 });
    const out = await sweepImproveNudge(soon.deps);
    expect(out.detail).toBe("rate-limited");
    expect(soon.sent).toEqual([]);
  });

  it("an UNCONFIRMED send does not start the cadence, so the next tick retries", async () => {
    const t0 = 7_000_000;
    await sweepImproveNudge(makeDeps({ now: t0, sendResult: false }).deps); // baseline
    const drop = makeDeps({ now: t0 + ADVANCE_IDLE_MS, sendResult: false });
    const out = await sweepImproveNudge(drop.deps);
    expect(out).toEqual({ sent: false, detail: "transport-failed" });
    expect(drop.sent).toHaveLength(1);
    expect(improveLastNudgedAt()).toBeNull();

    // Next tick, one minute later: retried because nothing was confirmed.
    const retry = makeDeps({ now: t0 + ADVANCE_IDLE_MS + 60_000, sendResult: true });
    await sweepImproveNudge(retry.deps);
    expect(retry.sent).toEqual([NEVER_IDLE_NUDGE_TEXT]);
  });
});

// ── The pure decision, asserted directly so each guardrail is pinned as arithmetic and the whole
//    rule is mutation-checkable without spies. `advancedRecently` is a plain boolean here — the
//    fingerprint→clock derivation is exercised by the sweep tests above. ───────────────────────────
describe("decideImproveNudge — the idle-and-has-backlog rule", () => {
  // DEFAULT: workers already draining (activeWorkers > 0), so `base` fires the GENERIC nudge. The
  // re-spin arm is exercised by its own tests below, which set `activeWorkers: 0` + free slots.
  const base: ImproveNudgeInput = {
    armed: true,
    ownsProject: true,
    consentIsNever: false,
    paneStatus: "idle",
    advancedRecently: false,
    readyBacklogCount: 2,
    p1PipelineHealthCount: 0,
    freeSlots: 4,
    activeWorkers: 1,
    lastNudgedAt: null,
    now: 1_000_000,
    cadenceMs: NEVER_IDLE_CADENCE_MS,
  };

  it("fires the GENERIC nudge when idle with backlog but workers are already draining", () => {
    expect(decideImproveNudge(base)).toEqual({ nudge: true, kind: "generic" });
  });

  it("fires on an unmerged (resting-with-work) status too", () => {
    expect(decideImproveNudge({ ...base, paneStatus: "unmerged" })).toEqual({
      nudge: true,
      kind: "generic",
    });
  });

  // ── THE RE-SPIN ARM (bead sparkle-4hwu2i), pinned as arithmetic on the pure decision ────────────
  it("returns kind:respin with the numbers when idle + ready backlog + free slots + zero active workers", () => {
    expect(
      decideImproveNudge({ ...base, readyBacklogCount: 6, freeSlots: 8, activeWorkers: 0 }),
    ).toEqual({ nudge: true, kind: "respin", readyCount: 6, freeSlots: 8 });
  });

  it.each<[Partial<ImproveNudgeInput>, string]>([
    [{ readyBacklogCount: 6, freeSlots: 8, activeWorkers: 1 }, "active workers present"],
    [{ readyBacklogCount: 6, freeSlots: 0, activeWorkers: 0 }, "no free slots"],
    // P1-only work (no ready backlog to dispatch a fleet across) is generic even with slots + 0 workers.
    [{ readyBacklogCount: 0, p1PipelineHealthCount: 1, freeSlots: 8, activeWorkers: 0 }, "P1-only, no ready backlog"],
  ])("stays GENERIC when the re-spin condition is not fully met (%o — %s)", (patch) => {
    expect(decideImproveNudge({ ...base, ...patch })).toEqual({ nudge: true, kind: "generic" });
  });

  it.each<[Partial<ImproveNudgeInput>, string]>([
    [{ armed: false }, "not-armed"],
    [{ ownsProject: false }, "not-owner"],
    [{ consentIsNever: true }, "consent-never"],
    [{ paneStatus: "working" }, "not-idle"],
    [{ paneStatus: undefined }, "not-idle"],
    [{ advancedRecently: true }, "advanced-recently"],
    [{ readyBacklogCount: 0, p1PipelineHealthCount: 0 }, "no-ready-backlog"],
    [{ lastNudgedAt: 999_000, now: 1_000_000 }, "rate-limited"], // 1s < 10min cadence
  ])("refuses (%o) with reason %s", (patch, reason) => {
    expect(decideImproveNudge({ ...base, ...patch })).toEqual({ nudge: false, reason });
  });

  it("the armed gate is checked FIRST — an unarmed build refuses even with a full stall signature", () => {
    expect(decideImproveNudge({ ...base, armed: false, readyBacklogCount: 50 })).toEqual({
      nudge: false,
      reason: "not-armed",
    });
  });

  it("a nudge exactly at the cadence boundary is allowed (>=, not >)", () => {
    expect(
      decideImproveNudge({ ...base, lastNudgedAt: 0, now: NEVER_IDLE_CADENCE_MS }),
    ).toEqual({ nudge: true, kind: "generic" });
  });
});
