// ONE RULE FOR "IS A HEADLESS IMPROVEMENT PASS IN FLIGHT", asserted where both consumers see it.
//
// The write gate (conciergeTools/terminal, and the restart/stop lifecycle ops) and the roster row
// (controlListener's `activity`) both read this. The failure these guard against is not "the
// predicate is wrong" but "the two consumers disagree": a gate refusing while the roster says idle
// reads to a language model as a broken tool, and it retries — against an agent whose worktree a
// second claude is writing. Bead sparkle-x0pvw.
//
// WHAT IS DELIBERATELY *NOT* A HOLD: the interactive pane being mid-turn. See `sparkleBusyNow` —
// holding on that made Improve Sparkle the one agent you cannot type at while it thinks, which a
// pre-existing parity test in terminal.test.ts rejects outright.
//
// NOTHING IS MOCKED HERE. The latch lives in the leaf `improvementPassLatch`, which exports
// `claimPass`/`releasePass` — so these cases drive the REAL predicate the app reads, rather than a
// stand-in whose agreement with the real one nothing checks. That the latch is reachable without
// pulling in `improvementPass` is the point of the split; see that module's header.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sparkleBusyNow, sparkleActivityLine } from "./sparkleBusy";
import { claimPass, releasePass } from "./improvementPassLatch";

const T0 = 1_700_000_000_000;

beforeEach(() => releasePass());
afterEach(() => releasePass());

describe("sparkleBusyNow", () => {
  it("is null when no pass is in flight — the state a send is allowed in", () => {
    // The inverse guard for everything below. Without it, a predicate hardwired to "busy" would
    // satisfy every case here while blocking the concierge permanently.
    expect(sparkleBusyNow(T0)).toBeNull();
    expect(sparkleActivityLine(T0)).toBeNull();
  });

  it("reports the pass, and says WAIT rather than retry", () => {
    claimPass();
    const busy = sparkleBusyNow(T0)!;
    expect(busy.kind).toBe("improvement-pass-running");
    // The advice is the load-bearing part. A refusal a model reads as transient gets retried, and
    // every retry is another writer aimed at the shared worktree.
    expect(busy.detail).toEqual(expect.stringContaining("wait"));
    expect(busy.detail).toEqual(expect.stringContaining("worktree"));
    expect(busy.detail).not.toMatch(/try again/i);
  });

  it("clears the moment the pass ends — the hold tracks the latch, it is not sticky", () => {
    // This is the property the first cut got wrong by keying on `paneBusySince`, whose only writer
    // is a 5-minute scheduler tick: it kept refusing for minutes after the work ended, with a
    // non-retryable sentence, so the message was simply dropped (roborev 58865).
    claimPass();
    expect(sparkleBusyNow(T0)).not.toBeNull();
    releasePass();
    expect(sparkleBusyNow(T0 + 1000)).toBeNull();
  });
});

describe("sparkleActivityLine — the roster's short form", () => {
  it("is shorter than the refusal detail, and cannot contradict it", () => {
    claimPass();
    const line = sparkleActivityLine(T0)!;
    const detail = sparkleBusyNow(T0)!.detail;
    expect(line).toBe("running its hourly improvement pass");
    // The roster is the index, not the article — controlListener documents that token budget.
    expect(line.length).toBeLessThan(detail.length);
    // Both derive from ONE predicate, so a caller cannot be told "idle" by the roster and "busy" by
    // the refusal. That disagreement is what this module exists to make unrepresentable.
    expect(sparkleBusyNow(T0)).not.toBeNull();
  });

  it("says nothing about the pane being mid-turn — the row's own `status` carries that", () => {
    // Repeating it here would be a second, staler copy of a fact the row already states properly.
    expect(sparkleActivityLine(T0)).toBeNull();
  });
});
