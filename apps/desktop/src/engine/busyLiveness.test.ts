import { describe, it, expect } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import type { MovementEvidence } from "./movementRetraction";
import {
  withBusyLivenessReconciliation,
  movementAgeMs,
  STALE_AFTER_MS,
} from "./busyLiveness";

const NOW = 1_000_000_000_000;

/** A movement snapshot whose last event fired `ageMs` before NOW. */
function ev(ageMs: number, over: Partial<MovementEvidence> = {}): MovementEvidence {
  return { lastEvent: "PostToolUse", lastEventMs: NOW - ageMs, sessionId: "s", toolsRecent: 1, ...over };
}

const agents = (...ids: string[]) => ids.map((id) => ({ id }));

describe("movementAgeMs — the freshness read that decides a downgrade", () => {
  it("returns the age of a real past timestamp", () => {
    expect(movementAgeMs(ev(5 * 60_000), NOW)).toBe(5 * 60_000);
  });
  it("is null for absent evidence — we cannot claim death on nothing (header note 2)", () => {
    expect(movementAgeMs(undefined, NOW)).toBeNull();
  });
  it("is null for a null / zero / non-finite timestamp", () => {
    expect(movementAgeMs(ev(0, { lastEventMs: null }), NOW)).toBeNull();
    expect(movementAgeMs(ev(0, { lastEventMs: 0 }), NOW)).toBeNull();
    expect(movementAgeMs(ev(0, { lastEventMs: Number.NaN }), NOW)).toBeNull();
  });
  it("is null for a FUTURE timestamp — a broken clock is not evidence of life", () => {
    expect(movementAgeMs(ev(-60_000), NOW)).toBeNull(); // lastEventMs = NOW + 60s
  });
});

describe("withBusyLivenessReconciliation — a dead worker's busy pill is retracted to stopped", () => {
  // THE SIDE EFFECT (bead sparkle-dlze6u). A worker still reporting `working` whose freshest artifact
  // is older than the bound reads `stopped`. This is the assertion that fails if the reconcile is a
  // no-op — it would stay `working`.
  it("downgrades a `working` row with stale movement to `stopped`", () => {
    const status: Record<string, AgentTabStatus> = { w: "working" };
    const move = { w: ev(STALE_AFTER_MS + 60_000) }; // one minute past the bound
    const out = withBusyLivenessReconciliation(agents("w"), status, (id) => move[id as "w"], NOW);
    expect(out.w).toBe("stopped");
  });

  // PAIRED with the above (AGENTS.md: a test proving absence is ambiguous; the pair pins the cause).
  // A genuinely-running worker — fresh artifact inside the bound — KEEPS `working`, and the SAME
  // reference is returned so nothing re-renders. Without this, a reconcile that downgraded every
  // `working` row would also pass the first test.
  it("keeps a `working` row whose movement is fresh (and returns the same reference)", () => {
    const status: Record<string, AgentTabStatus> = { w: "working" };
    const move = { w: ev(STALE_AFTER_MS - 60_000) }; // one minute inside the bound
    const out = withBusyLivenessReconciliation(agents("w"), status, (id) => move[id as "w"], NOW);
    expect(out.w).toBe("working");
    expect(out).toBe(status);
  });

  it("does NOT downgrade a `working` row with NO movement evidence — unobserved is not dead", () => {
    const status: Record<string, AgentTabStatus> = { w: "working" };
    const out = withBusyLivenessReconciliation(agents("w"), status, () => undefined, NOW);
    expect(out.w).toBe("working");
    expect(out).toBe(status);
  });

  it("leaves non-`working` statuses untouched even when stale (only the green tier is a busy claim)", () => {
    const status: Record<string, AgentTabStatus> = {
      a: "waiting",
      b: "blocked",
      c: "idle",
      d: "unmerged",
    };
    const move: Record<string, MovementEvidence> = {
      a: ev(STALE_AFTER_MS + 60_000),
      b: ev(STALE_AFTER_MS + 60_000),
      c: ev(STALE_AFTER_MS + 60_000),
      d: ev(STALE_AFTER_MS + 60_000),
    };
    const out = withBusyLivenessReconciliation(agents("a", "b", "c", "d"), status, (id) => move[id], NOW);
    expect(out).toEqual(status);
    expect(out).toBe(status); // untouched → same reference
  });

  it("reconciles only the stale worker in a mixed fleet, leaving the fresh one green", () => {
    const status: Record<string, AgentTabStatus> = { dead: "working", live: "working" };
    const move: Record<string, MovementEvidence> = {
      dead: ev(STALE_AFTER_MS + 5 * 60_000),
      live: ev(30_000),
    };
    const out = withBusyLivenessReconciliation(agents("dead", "live"), status, (id) => move[id], NOW);
    expect(out.dead).toBe("stopped");
    expect(out.live).toBe("working");
    // input never mutated
    expect(status.dead).toBe("working");
  });

  // The boundary matches fleetVerdict.progressOf, whose bound STALE_AFTER_MS aliases: `age < bound`
  // is still alive ("quiet"), `age >= bound` is "silent" / not-thinking. So exactly AT the bound
  // downgrades, and one ms under it does not.
  it("downgrades AT the bound and holds one ms under it (matches fleetVerdict.progressOf)", () => {
    const atBound = withBusyLivenessReconciliation(
      agents("w"),
      { w: "working" } as Record<string, AgentTabStatus>,
      () => ev(STALE_AFTER_MS),
      NOW,
    );
    expect(atBound.w).toBe("stopped");
    const underBound = withBusyLivenessReconciliation(
      agents("w"),
      { w: "working" } as Record<string, AgentTabStatus>,
      () => ev(STALE_AFTER_MS - 1),
      NOW,
    );
    expect(underBound.w).toBe("working");
  });
});
