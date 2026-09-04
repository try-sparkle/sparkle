import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUMAN_GATED_LABEL,
  REENGAGE_COOLDOWN_MS,
  decideReEngage,
  isHumanGated,
  isIdleLegitimate,
  isP0OrP1,
  partitionReadyBacklog,
  resetReEngageForTests,
  runIdleReEngage,
  selectTopActionableBead,
  type ReEngageDeps,
  type ReEngageInput,
} from "./improvementReadiness";
import type { Bead } from "./services/beads";
import type { AgentTabStatus } from "./types";
import type { SparkleImprovementConsent } from "./stores/settingsStore";

// A ready bead. `priority` is bd's numeric band (0 = P0); omit it for an ungraded bead.
function bead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: `title ${overrides.id}`,
    description: "",
    status: "open",
    labels: [],
    ...overrides,
  };
}

describe("isHumanGated — the human-gated classifier", () => {
  it("is true for a bead carrying the explicit label", () => {
    expect(isHumanGated(bead({ id: "a", labels: [HUMAN_GATED_LABEL] }))).toBe(true);
  });

  it("is true when a gating phrase appears in the title", () => {
    expect(isHumanGated(bead({ id: "b", title: "Founder must decide the pricing tier" }))).toBe(true);
  });

  it("is true when a gating phrase appears in the description", () => {
    expect(
      isHumanGated(bead({ id: "c", title: "Rotate the API creds", description: "The token has expired" })),
    ).toBe(true);
  });

  it("is FALSE for ordinary work — err toward actionable", () => {
    // The dangerous direction is false-human-gated (it lets the fleet idle). A normal coding bead
    // that merely MENTIONS a credential/token must stay actionable.
    expect(isHumanGated(bead({ id: "d", title: "Fix credential parsing bug in auth service" }))).toBe(
      false,
    );
    expect(isHumanGated(bead({ id: "e", title: "Rotate log files nightly", description: "cron" }))).toBe(
      false,
    );
    expect(isHumanGated(bead({ id: "f", title: "Add token bucket rate limiter" }))).toBe(false);
  });
});

describe("isP0OrP1", () => {
  it("counts P0 and P1, not P2+ or ungraded", () => {
    expect(isP0OrP1(bead({ id: "a", priority: 0 }))).toBe(true);
    expect(isP0OrP1(bead({ id: "b", priority: 1 }))).toBe(true);
    expect(isP0OrP1(bead({ id: "c", priority: 2 }))).toBe(false);
    expect(isP0OrP1(bead({ id: "d" }))).toBe(false); // ungraded
  });
});

describe("partitionReadyBacklog", () => {
  it("splits actionable from human-gated and isolates the P0/P1 actionable subset", () => {
    const beads = [
      bead({ id: "p0", priority: 0 }),
      bead({ id: "p1", priority: 1 }),
      bead({ id: "p2", priority: 2 }),
      bead({ id: "gated", priority: 0, labels: [HUMAN_GATED_LABEL] }),
    ];
    const part = partitionReadyBacklog(beads);
    expect(part.actionable.map((b) => b.id)).toEqual(["p0", "p1", "p2"]);
    expect(part.humanGated.map((b) => b.id)).toEqual(["gated"]);
    expect(part.actionableP0P1.map((b) => b.id)).toEqual(["p0", "p1"]);
  });
});

describe("selectTopActionableBead", () => {
  it("picks the highest-priority NON-human-gated ready bead, skipping a higher-priority gated one", () => {
    const beads = [
      bead({ id: "gated-p0", priority: 0, labels: [HUMAN_GATED_LABEL] }),
      bead({ id: "actionable-p1", priority: 1 }),
      bead({ id: "actionable-p2", priority: 2 }),
    ];
    // The P0 is human-gated, so the top ACTIONABLE item is the P1 — a human-gated bead is never
    // handed over as work.
    expect(selectTopActionableBead(beads)?.id).toBe("actionable-p1");
  });

  it("returns null when every ready bead is human-gated", () => {
    expect(
      selectTopActionableBead([bead({ id: "g", priority: 0, labels: [HUMAN_GATED_LABEL] })]),
    ).toBeNull();
  });
});

describe("isIdleLegitimate — the founder's rule stated once", () => {
  it("is FALSE when an actionable P0 is ready (idle is NOT allowed → re-engage)", () => {
    expect(isIdleLegitimate([bead({ id: "p0", priority: 0 })], 0)).toBe(false);
  });

  it("is FALSE when an actionable P1 is ready", () => {
    expect(isIdleLegitimate([bead({ id: "p1", priority: 1 })], 0)).toBe(false);
  });

  it("is TRUE when every ready bead is human-gated (resting is correct)", () => {
    const beads = [
      bead({ id: "g0", priority: 0, labels: [HUMAN_GATED_LABEL] }),
      bead({ id: "g1", priority: 1, title: "Founder must decide" }),
    ];
    expect(isIdleLegitimate(beads, 0)).toBe(true);
  });

  it("is FALSE for an unstaffed epic alone, even with an empty ready column", () => {
    expect(isIdleLegitimate([], 1)).toBe(false);
  });

  it("is TRUE for an empty backlog and no unstaffed epics", () => {
    expect(isIdleLegitimate([], 0)).toBe(true);
  });

  it("is TRUE when only P2+ actionable work is ready — the rule names P0/P1 only", () => {
    expect(isIdleLegitimate([bead({ id: "p2", priority: 2 }), bead({ id: "ung" })], 0)).toBe(true);
  });
});

// ── decideReEngage — the pure re-engage gate ──────────────────────────────────────────────────────

function input(overrides: Partial<ReEngageInput> = {}): ReEngageInput {
  return {
    consent: "always",
    paneStatus: "idle",
    selfReportedBlockedOnHuman: false,
    passRunning: false,
    retryArmed: false,
    online: true,
    boardReadable: true,
    readyBeads: [bead({ id: "p0", priority: 0 })], // actionable P0 by default → idle illegitimate
    unstaffedEpicCount: 0,
    lastReEngageAt: null,
    now: 1_000_000,
    cooldownMs: REENGAGE_COOLDOWN_MS,
    ...overrides,
  };
}

describe("decideReEngage", () => {
  it("RE-ENGAGES an idle agent when an actionable P0 is ready, naming the item", () => {
    const d = decideReEngage(input());
    expect(d).toMatchObject({ reEngage: true, actionableP0P1Count: 1 });
    if (d.reEngage) expect(d.focus?.id).toBe("p0");
  });

  it("RE-ENGAGES a BLOCKED pane that self-reports blocked-on-human over actionable work (the founder's case)", () => {
    const d = decideReEngage(
      input({ paneStatus: "blocked", selfReportedBlockedOnHuman: true }),
    );
    expect(d.reEngage).toBe(true);
  });

  it("does NOT re-engage when idle is legitimate — every ready bead is human-gated", () => {
    const d = decideReEngage(
      input({ readyBeads: [bead({ id: "g", priority: 0, labels: [HUMAN_GATED_LABEL] })] }),
    );
    expect(d).toEqual({ reEngage: false, reason: "idle-legitimate" });
  });

  it("does NOT re-engage a working agent", () => {
    expect(decideReEngage(input({ paneStatus: "working" }))).toEqual({
      reEngage: false,
      reason: "not-resting",
    });
  });

  it("does NOT re-engage a working agent even when it self-reports blocked-on-human (working wins)", () => {
    expect(
      decideReEngage(input({ paneStatus: "working", selfReportedBlockedOnHuman: true })),
    ).toEqual({ reEngage: false, reason: "not-resting" });
  });

  it("stands down while a pass is already running", () => {
    expect(decideReEngage(input({ passRunning: true }))).toEqual({
      reEngage: false,
      reason: "already-running",
    });
  });

  it("defers to the hourly slot when a connectivity retry is armed", () => {
    expect(decideReEngage(input({ retryArmed: true }))).toEqual({
      reEngage: false,
      reason: "retry-armed",
    });
  });

  it("stands down while offline — a pass would fail from its first networked step", () => {
    expect(decideReEngage(input({ online: false }))).toEqual({
      reEngage: false,
      reason: "offline",
    });
  });

  it("stands down on an unreadable board (absence of a reading is not a reading of absence)", () => {
    expect(decideReEngage(input({ boardReadable: false, readyBeads: [] }))).toEqual({
      reEngage: false,
      reason: "board-unreadable",
    });
  });

  it("is rate-limited within the cooldown", () => {
    const now = 2_000_000;
    expect(
      decideReEngage(input({ now, lastReEngageAt: now - (REENGAGE_COOLDOWN_MS - 1) })),
    ).toEqual({ reEngage: false, reason: "rate-limited" });
  });

  it("fires again once the cooldown has elapsed", () => {
    const now = 2_000_000;
    expect(decideReEngage(input({ now, lastReEngageAt: now - REENGAGE_COOLDOWN_MS })).reEngage).toBe(
      true,
    );
  });

  it("bars consent=never (chat-only may not be told to mine backlog)", () => {
    expect(decideReEngage(input({ consent: "never" }))).toEqual({
      reEngage: false,
      reason: "consent-never",
    });
  });

  it("re-engages on an unstaffed epic alone (focus null — no single item to name)", () => {
    const d = decideReEngage(input({ readyBeads: [], unstaffedEpicCount: 1 }));
    expect(d).toMatchObject({ reEngage: true, unstaffedEpicCount: 1 });
    if (d.reEngage) expect(d.focus).toBeNull();
  });
});

// ── runIdleReEngage — the wire-in the scheduler calls ─────────────────────────────────────────────

function makeDeps(
  overrides: Partial<{
    consent: SparkleImprovementConsent;
    paneStatus: AgentTabStatus | undefined;
    selfReportedBlockedOnHuman: boolean;
    passRunning: boolean;
    retryArmed: boolean;
    online: boolean;
    boardReadable: boolean;
    readyBeads: readonly Bead[];
    unstaffedEpicCount: number;
    now: number;
  }> = {},
): { deps: ReEngageDeps; reEngage: ReturnType<typeof vi.fn> } {
  const reEngage = vi.fn();
  const o = {
    consent: "always" as SparkleImprovementConsent,
    paneStatus: "idle" as AgentTabStatus | undefined,
    selfReportedBlockedOnHuman: false,
    passRunning: false,
    retryArmed: false,
    online: true,
    boardReadable: true,
    readyBeads: [bead({ id: "p0", priority: 0 })] as readonly Bead[],
    unstaffedEpicCount: 0,
    now: 1_000_000,
    ...overrides,
  };
  return {
    reEngage,
    deps: {
      now: () => o.now,
      consent: () => o.consent,
      paneStatus: () => o.paneStatus,
      selfReportedBlockedOnHuman: () => o.selfReportedBlockedOnHuman,
      passRunning: () => o.passRunning,
      retryArmed: () => o.retryArmed,
      online: () => o.online,
      readyBacklog: () => ({ boardReadable: o.boardReadable, readyBeads: o.readyBeads }),
      unstaffedEpicCount: () => o.unstaffedEpicCount,
      reEngage,
    },
  };
}

describe("runIdleReEngage — the scheduler wire-in", () => {
  beforeEach(() => resetReEngageForTests());

  it("STARTS A PASS when the agent is idle and the backlog has actionable P0/P1 work", () => {
    const { deps, reEngage } = makeDeps();
    const d = runIdleReEngage(deps);
    expect(d.reEngage).toBe(true);
    expect(reEngage).toHaveBeenCalledTimes(1);
  });

  it("does NOT start a pass when idle is legitimate (backlog is all human-gated)", () => {
    const { deps, reEngage } = makeDeps({
      readyBeads: [bead({ id: "g", priority: 0, labels: [HUMAN_GATED_LABEL] })],
    });
    const d = runIdleReEngage(deps);
    expect(d).toEqual({ reEngage: false, reason: "idle-legitimate" });
    expect(reEngage).not.toHaveBeenCalled();
  });

  it("re-engages a blocked-on-human self-report standing over an actionable P0", () => {
    const { deps, reEngage } = makeDeps({
      paneStatus: "blocked",
      selfReportedBlockedOnHuman: true,
    });
    runIdleReEngage(deps);
    expect(reEngage).toHaveBeenCalledTimes(1);
  });

  it("stamps the cooldown only on a real re-engage, so a second immediate tick is rate-limited", () => {
    const { deps, reEngage } = makeDeps({ now: 5_000_000 });
    runIdleReEngage(deps); // fires, stamps lastReEngageAt = now
    const second = runIdleReEngage(deps); // same now → within cooldown
    expect(second).toEqual({ reEngage: false, reason: "rate-limited" });
    expect(reEngage).toHaveBeenCalledTimes(1);
  });

  it("a run of stand-downs never advances the cooldown, so the first idle-with-work fires immediately", () => {
    // Working agent: stands down. Then it goes idle: must fire at once, not be blocked by a phantom
    // cooldown from the stand-down.
    const { deps: working } = makeDeps({ paneStatus: "working" });
    runIdleReEngage(working);
    const { deps: idle, reEngage } = makeDeps({ paneStatus: "idle" });
    runIdleReEngage(idle);
    expect(reEngage).toHaveBeenCalledTimes(1);
  });
});
