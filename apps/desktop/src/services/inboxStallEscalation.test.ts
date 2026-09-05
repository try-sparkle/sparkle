// The recurrence guard for beads sparkle-6yrvqd / sparkle-eou3y0.1.
//
// THE TWO DIRECTIONS THESE TESTS PIN, and they are the whole point of the file:
//   • NARROWING the trigger must red `reports the measured outage` — the stuck inbox must still be
//     reported. That is the fault that went unnoticed for days.
//   • WIDENING it must red `stays silent for a healthy inbox whose counters retention reset` — and
//     that fixture is deliberately BYTE-IDENTICAL to the outage in every counter (`delivered: 0`,
//     `acknowledged: 0`, `pending` at the ceiling). Only the AGE of the oldest pending record
//     differs. A guard keyed on the counters alone cannot tell them apart, and that guard was
//     written once already and caught in review; this pair is what stops it coming back.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxStatusRow } from "./conciergeTools/fleet";
import {
  RESTATE_AFTER_MS,
  __resetInboxStallStateForTests,
  composeInboxStallReport,
  resolveInboxStalls,
  runInboxStallSweep,
  type InboxStallDeps,
  type InboxStallFinding,
} from "./inboxStallEscalation";

const NOW = 1_788_500_000_000;
const HOUR = 60 * 60 * 1000;

/** Every field is a parameter with a default — no field is pinned to a literal no test can vary,
 *  which is the shape `AGENTS.md` calls a vacuous fixture. */
function row(over: Partial<InboxStatusRow> = {}): InboxStatusRow {
  return {
    agentId: "__sparkle_self__",
    pending: 42,
    delivered: 0,
    acknowledged: 0,
    awaitingAck: 0,
    pendingIds: [],
    oldestPendingMs: NOW - 11.6 * HOUR,
    fyiCeiling: 40,
    actCeiling: 50,
    ...over,
  };
}

interface Harness {
  deps: InboxStallDeps;
  notify: ReturnType<typeof vi.fn>;
  setRows(rows: InboxStatusRow[]): void;
  setNow(ms: number): void;
  failRead(err: unknown): void;
}

function harness(initial: InboxStatusRow[], accept = true): Harness {
  let rows = initial;
  let now = NOW;
  let readError: unknown = null;
  const notify = vi.fn(() => accept);
  const deps: InboxStallDeps = {
    agentIds: () => ["__sparkle_self__", "peer-1"],
    inboxStatus: async () => {
      if (readError !== null) throw readError;
      return rows;
    },
    notifyConcierge: notify,
    nameOf: (id) => (id === "__sparkle_self__" ? "Sparkle" : null),
    now: () => now,
  };
  return {
    deps,
    notify,
    setRows: (r) => {
      rows = r;
    },
    setNow: (ms) => {
      now = ms;
    },
    failRead: (e) => {
      readError = e;
    },
  };
}

/** `noUncheckedIndexedAccess` is on, and a `!` would hide exactly the failure worth seeing: an empty
 *  result read as a passing assertion. These THROW naming what was missing instead. */
function one<T>(xs: readonly T[], what: string): T {
  expect(xs, what).toHaveLength(1);
  const x = xs[0];
  if (x === undefined) throw new Error(`${what}: expected one, got none`);
  return x;
}

/** The text of the nth concierge push. Throws if that push never happened. */
function said(notify: ReturnType<typeof vi.fn>, i: number): string {
  const call = notify.mock.calls[i];
  if (call === undefined) throw new Error(`expected a concierge push #${i}; none was made`);
  return String(call[0]);
}

beforeEach(() => {
  __resetInboxStallStateForTests();
});

describe("resolveInboxStalls — the trigger", () => {
  it("reports the measured outage: delivered 0, pending at the ceiling, oldest queued 11.6h", () => {
    const f = one(resolveInboxStalls([row()], NOW), "the measured outage must produce a finding");
    expect(f.agentId).toBe("__sparkle_self__");
    expect(f.diagnosis).toBe("never-drained");
    expect(f.pending).toBe(42);
    expect(Math.round(f.waitedMs / HOUR)).toBe(12);
  });

  it("stays silent for a healthy inbox whose counters retention reset", () => {
    // IDENTICAL COUNTERS TO THE OUTAGE ABOVE — `delivered: 0`, `acknowledged: 0`, `pending` at the
    // ceiling — because `retention::reap_inbox` compacts the record file at 24h, so a long-lived
    // agent that delivered and acked yesterday reads exactly this today. The ONLY difference is that
    // its oldest queued message arrived five minutes ago, which is inside any turn. A counter-keyed
    // guard accuses this agent; the age-keyed one must not.
    const healthy = row({ oldestPendingMs: NOW - 5 * 60 * 1000 });
    expect(healthy.delivered, "the fixture must match the outage's counters or it proves nothing")
      .toBe(0);
    expect(healthy.acknowledged).toBe(0);
    expect(healthy.pending).toBeGreaterThanOrEqual(healthy.fyiCeiling as number);
    expect(resolveInboxStalls([healthy], NOW), "a healthy agent must produce NOTHING").toEqual([]);
  });

  it("stays silent for an idle inbox with nothing queued at all", () => {
    // `oldest_pending_ms` is `Option<i64>` in Rust and arrives as an explicit `null` when nothing is
    // queued. An unreadable age is "cannot say", never "not draining".
    expect(resolveInboxStalls([row({ pending: 0, oldestPendingMs: null })], NOW)).toEqual([]);
  });

  it("stays silent below the fyi ceiling even when the queue is old", () => {
    // The second conjunct, on its own. 11.6h stale but only 12 queued: not yet the capacity deadlock
    // sparkle-eou3y0.1 names, and reporting every slow drain would be the noise that mutes the guard.
    expect(resolveInboxStalls([row({ pending: 12 })], NOW)).toEqual([]);
  });

  it("refuses to guess when the row carries no ceilings", () => {
    const noCeilings = row({ fyiCeiling: undefined, actCeiling: undefined });
    expect(resolveInboxStalls([noCeilings], NOW)).toEqual([]);
  });
});

describe("the diagnosis — NEVER DRAINED vs STALLED AFTER DELIVERING", () => {
  it("calls the outage NEVER DRAINED and denies the reply-was-lost theory in words", () => {
    const f = one(resolveInboxStalls([row()], NOW), "the outage must be found");
    const text = composeInboxStallReport(f);
    expect(text).toContain("NEVER DRAINED");
    // The wrong theory that circulated for days was "my message is delivered to it, but its reply
    // doesn't route back". The report has to refute that where a reader will see it.
    expect(text).toContain("the reply was");
    expect(text).toContain("nothing has ever arrived");
    expect(text).toContain("`Stop`");
    expect(text).toContain("settings.local.json");
    expect(text).not.toContain("STALLED AFTER DELIVERING");
  });

  it("calls a stall on a previously-working inbox STALLED AFTER DELIVERING, with the other remedy", () => {
    const f = one(
      resolveInboxStalls([row({ delivered: 3, acknowledged: 2 })], NOW),
      "a previously-working inbox that stalled must be found",
    );
    expect(f.diagnosis).toBe("stalled-after-delivering");
    const text = composeInboxStallReport(f);
    expect(text).toContain("STALLED AFTER DELIVERING");
    expect(text).toContain("not hook registration");
    expect(text).toContain("liveness");
    expect(text).not.toContain("NEVER DRAINED");
  });

  it("treats a single acknowledgement as evidence the drain once ran", () => {
    // `delivered` can be 0 with `acknowledged` non-zero: `status_of` counts a record in exactly one
    // bucket, so an acked message is no longer counted as delivered. Reading only `delivered` would
    // call this inbox never-drained and send the operator after a hook that is correctly installed.
    const f = one(
      resolveInboxStalls([row({ delivered: 0, acknowledged: 1 })], NOW),
      "an acked-but-stalled inbox must be found",
    );
    expect(f.diagnosis).toBe("stalled-after-delivering");
  });
});

describe("runInboxStallSweep — it reaches the concierge without anyone calling inbox_status", () => {
  it("pushes the measured outage to the concierge on the first sweep", async () => {
    const h = harness([row()]);
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.announced).toHaveLength(1);
    expect(sweep.undelivered).toEqual([]);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(said(h.notify, 0)).toContain("INBOX NOT DRAINING");
    expect(said(h.notify, 0)).toContain("Sparkle (__sparkle_self__)");
  });

  it("says nothing at all when every inbox is healthy", async () => {
    const h = harness([row({ oldestPendingMs: NOW - 5 * 60 * 1000 })]);
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.found).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("noise control", () => {
  it("announces the edge once and stays quiet while the same stall persists", async () => {
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.setNow(NOW + 30 * 60 * 1000);
    const second = await runInboxStallSweep(h.deps);
    expect(second.announced).toEqual([]);
    expect(second.suppressed).toHaveLength(1);
    expect(h.notify, "a steady stall must not re-page every beat").toHaveBeenCalledTimes(1);
  });

  it("restates a stall that outlives the restate window", async () => {
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.setNow(NOW + RESTATE_AFTER_MS);
    const later = await runInboxStallSweep(h.deps);
    expect(later.announced).toHaveLength(1);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("re-announces immediately when the DIAGNOSIS changes", async () => {
    // never-drained → stalled-after-delivering is a different fault with a different remedy.
    // Suppressing it would leave the reader acting on the superseded one.
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.setRows([row({ delivered: 4 })]);
    h.setNow(NOW + 60_000);
    const second = await runInboxStallSweep(h.deps);
    expect(second.announced).toHaveLength(1);
    expect(said(h.notify, 1)).toContain("STALLED AFTER DELIVERING");
  });
});

describe("a refused push stays OWED", () => {
  it("does not record the edge when the concierge refuses, and retries next sweep", async () => {
    // `notifyConcierge` returns false when no concierge window is mounted — a real state, not a
    // defect. Recording the edge there would spend the alarm on a push that reached nobody, which is
    // the one shape a watchdog must never produce.
    const h = harness([row()], /* accept */ false);
    const first = await runInboxStallSweep(h.deps);
    expect(first.announced).toEqual([]);
    expect(first.undelivered).toHaveLength(1);
    const second = await runInboxStallSweep(h.deps);
    expect(second.undelivered, "the finding is still owed").toHaveLength(1);
    expect(second.suppressed).toEqual([]);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });
});

describe("recovery", () => {
  it("sends one all-clear when an ANNOUNCED stall clears", async () => {
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.setRows([row({ pending: 0, oldestPendingMs: null })]);
    h.setNow(NOW + HOUR);
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.recovered).toEqual(["__sparkle_self__"]);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(said(h.notify, 1)).toContain("INBOX DRAINING AGAIN");
  });

  it("sends no all-clear for a stall whose push was never accepted", async () => {
    const h = harness([row()], /* accept */ false);
    await runInboxStallSweep(h.deps);
    h.setRows([row({ pending: 0, oldestPendingMs: null })]);
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.recovered, "an all-clear for an alarm nobody heard is pure noise").toEqual([]);
  });

  it("does not treat an UNOBSERVED agent as recovered", async () => {
    // A batch that did not answer for the agent says nothing about it. Clearing the record here
    // would drop a live fault the moment its pane closed and re-announce it when it reopened.
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.setRows([row({ agentId: "peer-1", pending: 0, oldestPendingMs: null })]);
    h.setNow(NOW + HOUR);
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.recovered).toEqual([]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps an announced stall recorded when the status read FAILS", async () => {
    const h = harness([row()]);
    await runInboxStallSweep(h.deps);
    h.failRead(new Error("status-failed: ipc down"));
    const sweep = await runInboxStallSweep(h.deps);
    expect(sweep.found).toEqual([]);
    expect(sweep.recovered, "unreadable is not recovered").toEqual([]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe("the clock is a real seam", () => {
  it("resolveInboxStalls defaults nothing about time — the age is judged against the passed clock", () => {
    const r = row({ oldestPendingMs: NOW - 3 * HOUR });
    expect(resolveInboxStalls([r], NOW), "3h past the 2h threshold").toHaveLength(1);
    expect(
      resolveInboxStalls([r], NOW - 2 * HOUR),
      "the same row read one hour after it queued is not a stall",
    ).toEqual([]);
  });
});

describe("the report is legible without a code dive", () => {
  it("leads with the verdict, then the diagnosis, and names the sender-side symptom", () => {
    const f: InboxStallFinding = one(resolveInboxStalls([row()], NOW), "the outage must be found");
    const text = composeInboxStallReport(f);
    expect(text.startsWith("INBOX NOT DRAINING")).toBe(true);
    // The symptom every sender saw and mis-read as success.
    expect(text).toContain('`state: "queued"`');
    // `hoursOf` FLOORS, so 11.6h reads as 11h — the report never rounds a wait UP.
    expect(text).toContain("11h");
    expect(text).toContain("40-message");
  });
});
