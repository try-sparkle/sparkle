import { describe, it, expect } from "vitest";
import {
  advanceAlertRecord,
  isAlertSuppressed,
  dismissedRecord,
  reenabledRecord,
  deEscalatedStatus,
  alertControlKind,
  withDismissedAlerts,
  EMPTY_ALERT,
  type AgentAlertRecord,
} from "./alertDismissal";
import type { AgentTabStatus } from "../types";

// Drive a sequence of statuses through the reducer, starting from `seed`.
function run(statuses: (AgentTabStatus | undefined)[], seed?: AgentAlertRecord): AgentAlertRecord {
  let rec: AgentAlertRecord | undefined = seed;
  for (const s of statuses) rec = advanceAlertRecord(rec, s);
  return rec ?? EMPTY_ALERT;
}

describe("advanceAlertRecord — episode counting", () => {
  it("bumps seq entering red from non-red (null → waiting)", () => {
    expect(run(["working", "waiting"]).seq).toBe(1);
  });

  it("does NOT bump while a red status merely persists", () => {
    expect(run(["waiting", "waiting", "waiting"]).seq).toBe(1);
  });

  it("returns the SAME reference when the red signature is unchanged (no write needed)", () => {
    const first = advanceAlertRecord(EMPTY_ALERT, "waiting"); // null → waiting
    const again = advanceAlertRecord(first, "waiting"); // waiting → waiting
    expect(again).toBe(first);
  });

  it("bumps on a DIFFERENT red kind without passing through non-red (waiting → approval)", () => {
    expect(run(["waiting", "approval"]).seq).toBe(2);
  });

  it("bumps again when it leaves red and re-enters the same red (waiting → working → waiting)", () => {
    const rec = run(["waiting", "working", "waiting"]);
    expect(rec.seq).toBe(2);
    expect(rec.lastRed).toBe("waiting");
  });

  it("leaving red clears lastRed but does not bump seq", () => {
    const rec = run(["waiting", "idle"]);
    expect(rec.seq).toBe(1);
    expect(rec.lastRed).toBeNull();
  });

  it("seeded from a persisted still-red record does NOT re-bump (persist across restart)", () => {
    const persisted: AgentAlertRecord = { seq: 3, lastRed: "waiting", dismissedSeq: 3 };
    // On restart the live status re-arrives as the same "waiting".
    const rec = advanceAlertRecord(persisted, "waiting");
    expect(rec).toBe(persisted); // no change → dismissal preserved
  });

  it("a DIFFERENT red status after restart is a genuine new episode (re-alert)", () => {
    const persisted: AgentAlertRecord = { seq: 3, lastRed: "waiting", dismissedSeq: 3 };
    const rec = advanceAlertRecord(persisted, "errored");
    expect(rec.seq).toBe(4);
    expect(rec.dismissedSeq).toBe(3); // stale dismissal now < seq → not suppressed
  });
});

describe("isAlertSuppressed", () => {
  it("is false for a non-red status regardless of record", () => {
    const rec: AgentAlertRecord = { seq: 2, lastRed: null, dismissedSeq: 2 };
    expect(isAlertSuppressed(rec, "working")).toBe(false);
    expect(isAlertSuppressed(rec, "idle")).toBe(false);
  });

  it("is true when red and dismissedSeq matches the current seq", () => {
    const rec: AgentAlertRecord = { seq: 2, lastRed: "waiting", dismissedSeq: 2 };
    expect(isAlertSuppressed(rec, "waiting")).toBe(true);
  });

  it("is false once a new episode has advanced seq past dismissedSeq (re-alert)", () => {
    const rec: AgentAlertRecord = { seq: 3, lastRed: "errored", dismissedSeq: 2 };
    expect(isAlertSuppressed(rec, "errored")).toBe(false);
  });

  it("is false when undefined or never dismissed", () => {
    expect(isAlertSuppressed(undefined, "waiting")).toBe(false);
    expect(isAlertSuppressed({ seq: 1, lastRed: "waiting", dismissedSeq: null }, "waiting")).toBe(
      false,
    );
  });
});

describe("dismiss / re-enable round trip", () => {
  it("dismiss then re-enable restores the alerting state", () => {
    const live = advanceAlertRecord(EMPTY_ALERT, "waiting"); // seq 1
    const dismissed = dismissedRecord(live);
    expect(isAlertSuppressed(dismissed, "waiting")).toBe(true);
    const reenabled = reenabledRecord(dismissed);
    expect(isAlertSuppressed(reenabled, "waiting")).toBe(false);
    expect(reenabled.seq).toBe(1); // seq/lastRed untouched by the toggle
    expect(reenabled.lastRed).toBe("waiting");
  });
});

describe("deEscalatedStatus", () => {
  it("waiting/approval → idle, errored → stopped", () => {
    expect(deEscalatedStatus("waiting")).toBe("idle");
    expect(deEscalatedStatus("approval")).toBe("idle");
    expect(deEscalatedStatus("errored")).toBe("stopped");
  });
});

describe("alertControlKind", () => {
  it("red & not dismissed → dismiss; red & dismissed → reenable; non-red → null", () => {
    const live: AgentAlertRecord = { seq: 1, lastRed: "waiting", dismissedSeq: null };
    const dismissed: AgentAlertRecord = { seq: 1, lastRed: "waiting", dismissedSeq: 1 };
    expect(alertControlKind(live, "waiting")).toBe("dismiss");
    expect(alertControlKind(dismissed, "waiting")).toBe("reenable");
    expect(alertControlKind(live, "working")).toBeNull();
    expect(alertControlKind(undefined, "idle")).toBeNull();
  });
});

describe("withDismissedAlerts", () => {
  const agent = (id: string, alert?: AgentAlertRecord) => ({ id, alert });

  it("de-escalates only suppressed red agents; leaves others untouched", () => {
    const agents = [
      agent("w", { seq: 1, lastRed: "waiting", dismissedSeq: 1 }), // dismissed
      agent("e", { seq: 1, lastRed: "errored", dismissedSeq: null }), // red, live
      agent("g", undefined), // non-red
    ];
    const statusMap: Record<string, AgentTabStatus> = {
      w: "waiting",
      e: "errored",
      g: "working",
    };
    const out = withDismissedAlerts(agents, statusMap);
    expect(out.w).toBe("idle"); // suppressed → de-escalated
    expect(out.e).toBe("errored"); // live red → untouched
    expect(out.g).toBe("working"); // non-red → untouched
  });

  it("errored suppressed de-escalates to stopped (dormant tier)", () => {
    const agents = [agent("e", { seq: 2, lastRed: "errored", dismissedSeq: 2 })];
    const out = withDismissedAlerts(agents, { e: "errored" });
    expect(out.e).toBe("stopped");
  });

  it("returns the SAME reference when nothing is suppressed (no churn)", () => {
    const agents = [agent("a", { seq: 1, lastRed: "waiting", dismissedSeq: null })];
    const statusMap: Record<string, AgentTabStatus> = { a: "waiting" };
    expect(withDismissedAlerts(agents, statusMap)).toBe(statusMap);
  });

  it("does not mutate the input map", () => {
    const agents = [agent("w", { seq: 1, lastRed: "waiting", dismissedSeq: 1 })];
    const statusMap: Record<string, AgentTabStatus> = { w: "waiting" };
    withDismissedAlerts(agents, statusMap);
    expect(statusMap.w).toBe("waiting");
  });
});

// ── `blocked` is dismissible (2026-07-26) ───────────────────────────────────────────────────────
// It was added to the RedStatus UNION in one commit and to nothing else, so the claim "blocked is
// now dismissible" was inert: every gate in the module routes through a predicate that was still
// `needsAttention`, which excludes it. Roborev caught that the type widened while the behavior did
// not. These pin the behavior end-to-end so the union and the gate can't drift apart again.
//
// It matters because `blocked` has a producer that is nothing like a stalled PTY:
// services/improvementPass sets it on every failed hourly pass, and it sits on the pinned Sparkle
// row until the next one — a permanent red with no way to acknowledge it.
describe("blocked is a dismissible red", () => {
  it("offers a Dismiss control (and Re-enable once dismissed)", () => {
    expect(alertControlKind(EMPTY_ALERT, "blocked")).toBe("dismiss");
    const dismissed = dismissedRecord(run(["blocked"]));
    expect(alertControlKind(dismissed, "blocked")).toBe("reenable");
  });

  it("records an episode, so `lastRed` can actually hold it", () => {
    expect(run(["blocked"]).lastRed).toBe("blocked");
    expect(run(["blocked"]).seq).toBe(1);
  });

  it("suppresses once dismissed, and de-escalates to idle (not stopped — it still has a process)", () => {
    const rec = dismissedRecord(run(["blocked"]));
    expect(isAlertSuppressed(rec, "blocked")).toBe(true);
    expect(deEscalatedStatus("blocked")).toBe("idle");
    const agents = [{ id: "a", alert: rec }];
    expect(withDismissedAlerts(agents, { a: "blocked" }).a).toBe("idle");
  });

  it("re-alerts on a NEW blocked episode after a dismissal", () => {
    // A failed improvement pass, dismissed; the row recovers; the next pass fails again. That second
    // failure is a new episode and must raise red again rather than stay acknowledged forever.
    const dismissed = dismissedRecord(run(["blocked"]));
    const afterRecovery = run(["idle", "blocked"], dismissed);
    expect(isAlertSuppressed(afterRecovery, "blocked")).toBe(false);
  });

  it("a dismissed blocked does not suppress a LATER, different red", () => {
    // Through the real path: `advanceAlertRecord` is what makes a changed red signature a new
    // episode, and the sidebar runs it on every status change. Asking `isAlertSuppressed` directly
    // with a different status would prove nothing — by design it only compares dismissedSeq to seq
    // (see the isAlertSuppressed block above), for every status, not just this one.
    const dismissed = dismissedRecord(run(["blocked"]));
    const nowAsking = run(["waiting"], dismissed);
    expect(isAlertSuppressed(nowAsking, "waiting")).toBe(false);
  });
});
