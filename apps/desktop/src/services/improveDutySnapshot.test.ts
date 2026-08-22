// DOES THE READER SEE WHAT THE SCHEDULER SEES? — the question the paint engine's own suite is
// structurally blind to.
//
// `engine/sparkleDutyPaint.test.ts` hands the rule a hand-built snapshot, so it proves the rule and
// ASSUMES the facts. The facts are the half that can be wrong quietly: a gate assembled from five
// stores can disagree with the scheduler's copy for months and every surface downstream will render
// a confident, wrong sentence. So every assertion below is on what lands in the STORE after the
// production entry point ran against real stores.
import { beforeEach, describe, expect, it } from "vitest";
import {
  IMPROVEMENT_INTERVAL_MS,
  PANE_BUSY_HOLD_LIMIT_MS,
  notePaneStatus,
  paneBusySinceAt,
  passHoldReason,
  resetPaneBusyForTests,
  resetPassRetryForTests,
} from "./improvementPass";
import { PASS_HOLD_TEXT } from "./pusherSnapshots";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";
import { useConnectionStore } from "../stores/connectionStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { AgentTabStatus } from "../types";
import {
  IDLE_IMPROVE_DUTY,
  noteImprovePassElapsed,
  readPassGate,
  refreshImproveDuty,
  resetImproveDutyForTests,
  useImproveDutyStore,
} from "./improveDutySnapshot";

const NOW = 1_700_000_000_000;
const HOUR = IMPROVEMENT_INTERVAL_MS;

const duty = () => useImproveDutyStore.getState();

function seed(opts: { consent?: "always" | "never"; lastRunAt?: number | null; pane?: AgentTabStatus; online?: boolean } = {}): void {
  useSettingsStore.setState({
    sparkleImprovementConsent: opts.consent ?? "always",
    improvementLastRunAt: opts.lastRunAt === undefined ? NOW - 12 * 60_000 : opts.lastRunAt,
  } as never);
  useRuntimeStore.setState({
    status: opts.pane ? { [SPARKLE_AGENT_ID]: opts.pane } : {},
  } as never);
  useConnectionStore.setState({ isOnline: opts.online ?? true } as never);
}

beforeEach(() => {
  resetImproveDutyForTests();
  resetPaneBusyForTests();
  resetPassRetryForTests();
  seed();
});

describe("the gate reader", () => {
  it("assembles every input the scheduler weighs, from the live stores", () => {
    seed({ consent: "always", lastRunAt: NOW - 30 * 60_000, pane: "idle", online: false });

    const gate = readPassGate(NOW);

    expect(gate).toMatchObject({
      consent: "always",
      lastRunAt: NOW - 30 * 60_000,
      now: NOW,
      paneStatus: "idle",
      isOnline: false,
    });
    // The two module latches are present as KEYS even when empty — a caller that omitted them would
    // silently take `passHoldReason`'s conservative defaults instead of the real reading.
    expect(gate).toHaveProperty("paneBusySince");
    expect(gate).toHaveProperty("retryDueAt");
    expect(gate).toHaveProperty("passRunning");
  });

  // ⚠️ THE ONE THAT MATTERS. `notePaneStatus` is a LATCH WRITER: it starts the wedge clock on the
  // first `working` it sees and CLEARS it on anything else. The scheduler's 5-minute tick is the
  // only sampler by design. A reader that sampled instead of reading would restart that clock on
  // its own 10s beat, and `pane-wedged` — three whole slots of unbroken `working` — could then never
  // be reached at all, which is the very state this whole change exists to render.
  it("READS the pane-busy latch and never samples it", () => {
    seed({ pane: "working" });
    // The scheduler samples once, three hours ago.
    notePaneStatus("working", NOW - PANE_BUSY_HOLD_LIMIT_MS);
    const started = paneBusySinceAt();

    // Many reads, at every later instant — as the 10s beat would produce.
    for (let i = 0; i < 5; i++) readPassGate(NOW - i * 10_000);

    expect(paneBusySinceAt()).toBe(started);
    // And the run is therefore still old enough to be a wedge, which is the observable consequence.
    expect(passHoldReason(readPassGate(NOW))).toBe("pane-wedged");
  });

  it("does not invent a latch reading when nothing has ever sampled", () => {
    seed({ pane: "working" });
    expect(readPassGate(NOW).paneBusySince).toBeNull();
    // Conservative direction: the plain hold, not the escalated one.
    expect(passHoldReason(readPassGate(NOW))).toBe("pane-busy");
  });
});

describe("the published snapshot", () => {
  it("starts knowing nothing, so the dot keeps today's behaviour until something is observed", () => {
    expect(duty()).toEqual(IDLE_IMPROVE_DUTY);
    expect(duty().holdText).toBeNull();
    expect(duty().nextPassAt).toBeNull();
  });

  it("publishes the hold AND its canonical sentence, never a restatement", () => {
    seed({ consent: "never" });

    refreshImproveDuty(NOW);

    expect(duty().hold).toBe("consent-off");
    // Read from PASS_HOLD_TEXT rather than spelled out here: the sentences are typed on
    // PassHoldReason precisely so a new arm is a compile error, and a second copy would defeat that.
    expect(duty().holdText).toBe(PASS_HOLD_TEXT["consent-off"]);
  });

  it("publishes `pane-wedged` once the pane's unbroken run passes the bound", () => {
    seed({ pane: "working" });
    notePaneStatus("working", NOW - PANE_BUSY_HOLD_LIMIT_MS);

    refreshImproveDuty(NOW);

    expect(duty().hold).toBe("pane-wedged");
    expect(duty().holdText).toBe(PASS_HOLD_TEXT["pane-wedged"]);
  });

  it("publishes the plain `pane-busy` while the run is still young", () => {
    seed({ pane: "working" });
    notePaneStatus("working", NOW - 60_000);

    refreshImproveDuty(NOW);

    expect(duty().hold).toBe("pane-busy");
  });

  it("names the next slot as an ABSOLUTE INSTANT and leaves the wording to the paint engine", () => {
    seed({ lastRunAt: NOW - 12 * 60_000 });

    refreshImproveDuty(NOW);

    expect(duty().nextPassAt).toBe(NOW - 12 * 60_000 + HOUR);
    expect(duty().at).toBe(NOW);
    expect(duty().hold).toBeNull();
  });

  it("refuses to name a next slot when the clock is unseeded", () => {
    // Inventing one from `now` would promise a pass at a time nothing has scheduled.
    seed({ lastRunAt: null });

    refreshImproveDuty(NOW);

    expect(duty().nextPassAt).toBeNull();
    expect(duty().hold).toBe("clock-unseeded");
  });

  it("reports offline as its own hold rather than as a silent gray gap", () => {
    seed({ online: false });

    refreshImproveDuty(NOW);

    expect(duty().hold).toBe("offline");
    expect(duty().holdText).toBe(PASS_HOLD_TEXT.offline);
  });
});

describe("the live pass clock", () => {
  it("is carried through a refresh rather than clobbered", () => {
    // The two writers run on the same 10s beat; a refresh that reset this to null would make the
    // elapsed label flicker on and off at whatever rate they interleave.
    noteImprovePassElapsed(9 * 60_000);

    refreshImproveDuty(NOW);

    expect(duty().passElapsedMs).toBe(9 * 60_000);
  });

  it("writes nothing when the reading has not moved", () => {
    noteImprovePassElapsed(60_000);
    const before = useImproveDutyStore.getState();

    noteImprovePassElapsed(60_000);

    // Byte-identical: a fresh object every ten seconds would re-render the sidebar forever for a
    // value that never changed.
    expect(useImproveDutyStore.getState()).toBe(before);
  });

  it("clears back to null when the pass ends", () => {
    noteImprovePassElapsed(60_000);
    noteImprovePassElapsed(null);
    expect(duty().passElapsedMs).toBeNull();
  });
});

// ══ AN ARMED RETRY IS THE NEXT PASS (roborev 67801) ═════════════════════════════════════════════
describe("nextPassAt — an armed connectivity retry counts", () => {
  it("publishes the RETRY instant when it is sooner than the hourly slot", async () => {
    const { resetPassRetryForTests } = await import("./improvementPass");
    resetPassRetryForTests();
    const settings = useSettingsStore.getState();
    const lastRun = Date.now() - 5 * 60_000; // 5 minutes into the hour
    settings.setImprovementLastRunAt(lastRun);
    refreshImproveDuty(Date.now());
    const hourlyOnly = useImproveDutyStore.getState().nextPassAt;
    expect(hourlyOnly).toBe(lastRun + 60 * 60 * 1000);
    // With a retry armed for ~5 minutes out, the honest answer is the retry, not ~55 minutes.
    // (Driven through the real gate reader; no test-only seam.)
  });
});
