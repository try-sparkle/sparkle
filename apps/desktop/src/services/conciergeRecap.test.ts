import { describe, expect, it } from "vitest";
import {
  buildRecap,
  formatAwayFor,
  recapSummary,
  MIN_AWAY_MS,
  type AwaySnapshot,
  type GateDecision,
  type RecapAgentInfo,
} from "./conciergeRecap";
import type { StatusMap } from "../engine/attention";

const T0 = 1_700_000_000_000;

const info: Record<string, RecapAgentInfo> = {
  a: { name: "Kraken Auth", projectName: "sparkle", statusLabel: "Needs you" },
  b: { name: "OG Images", projectName: "drodio-website", statusLabel: "Done" },
  c: { name: "CI Hardening", projectName: "sparkle", statusLabel: "Errored / stalled" },
};

function snap(status: StatusMap, agentIds = Object.keys(info)): AwaySnapshot {
  return { status, agentIds, at: T0 };
}

function build(
  prev: StatusMap,
  next: StatusMap,
  decisions: GateDecision[] = [],
  now = T0 + 12 * 60_000,
) {
  return buildRecap({ snapshot: snap(prev), next, info, decisions, now, id: "recap-1" });
}

describe("buildRecap", () => {
  it("is NULL when nothing changed — no card at all", () => {
    const s: StatusMap = { a: "working", b: "working", c: "idle" };
    expect(build(s, s)).toBeNull();
  });

  it("is NULL when statuses moved but into nothing worth reporting", () => {
    // idle → working is progress, not news. A recap that fires for this is a recap nobody reads.
    expect(build({ a: "idle" }, { a: "working" })).toBeNull();
  });

  it("reports agents that newly entered a wants-you status", () => {
    const recap = build({ a: "working", c: "working" }, { a: "waiting", c: "errored" });
    expect(recap).not.toBeNull();
    expect(recap!.needsYou.map((c) => c.agentId)).toEqual(["a", "c"]);
    expect(recap!.needsYou[0]).toMatchObject({
      agentName: "Kraken Auth",
      projectName: "sparkle",
      status: "waiting",
      statusLabel: "Needs you",
    });
    expect(recap!.finished).toEqual([]);
  });

  it("buckets `done` as finished, not as wanting you", () => {
    const recap = build({ b: "working" }, { b: "done" });
    expect(recap!.finished.map((c) => c.agentId)).toEqual(["b"]);
    expect(recap!.needsYou).toEqual([]);
  });

  it("reports the ORDINARY finish — working → idle", () => {
    // The whole scenario the card exists for. `idle` ("Done — your turn") is what the Stop hook
    // emits at the end of a turn; `done` additionally means LANDED and is comparatively rare. A
    // recap that only knew `done` said nothing at all on the walk-away-and-come-back case.
    const recap = build({ a: "working" }, { a: "idle" });
    expect(recap).not.toBeNull();
    expect(recap!.finished.map((c) => c.agentId)).toEqual(["a"]);
    expect(recap!.needsYou).toEqual([]);
  });

  it("buckets `unmerged` as finished — the LABEL carries the 'needs merge' nuance", () => {
    const recap = build({ b: "working" }, { b: "unmerged" });
    expect(recap!.finished.map((c) => c.status)).toEqual(["unmerged"]);
    expect(recap!.needsYou).toEqual([]);
  });

  it("reports a finish the agent made out of a RED status", () => {
    // It was asking; it isn't any more. Whatever unblocked it, the ask is over and that is news.
    const recap = build({ a: "waiting" }, { a: "idle" });
    expect(recap!.finished.map((c) => c.agentId)).toEqual(["a"]);
  });

  describe("overlay churn is not a finish (roborev 53652)", () => {
    // The map being diffed is the DERIVED one, whose overlays move agents between resting states
    // with no agent activity at all. Each of these used to post a "1 finished" row for an agent
    // that did nothing while the user was out.

    it("ignores the unmerged branch poll repopulating after a relaunch", () => {
      // `branchStatus` boots empty, so every persisted agent reads idle/stopped until the first
      // poll escalates it. Launch, ⌘-tab away, come back — one row per agent with an old branch.
      expect(build({ a: "idle" }, { a: "unmerged" })).toBeNull();
      expect(build({ a: "stopped" }, { a: "unmerged" })).toBeNull();
    });

    it("ignores a branch LANDING — the finish was already reported", () => {
      expect(build({ a: "unmerged" }, { a: "idle" })).toBeNull();
      expect(build({ a: "unmerged" }, { a: "done" })).toBeNull();
    });

    it("STILL reports an agent that started and finished entirely while you were out", () => {
      // The same two endpoints as the boot-time branch poll above — `idle → unmerged` — and the
      // opposite meaning. Only mid-stretch evidence tells them apart: an orchestrator handing a
      // resting worker another unit of work, or the concierge dispatching one itself, must not go
      // unreported just because the agent was resting at the blur instant (roborev 53669-M).
      const recap = buildRecap({
        snapshot: snap({ a: "idle" }),
        next: { a: "unmerged" },
        info,
        decisions: [],
        sawWorking: new Set(["a"]),
        now: T0 + 12 * 60_000,
        id: "r",
      });
      expect(recap!.finished.map((c) => c.agentId)).toEqual(["a"]);
    });

    it("reports the ORDINARY finish, whose two endpoints are identical", () => {
      // `idle → working → idle`: the agent was resting, was handed work, ran, and the Stop hook
      // put it back at `idle`. A whole unit of work with NOTHING to diff — so the evidence has to
      // produce the row, not just permit one the diff already made (roborev 53674-M).
      const recap = buildRecap({
        snapshot: snap({ a: "idle" }),
        next: { a: "idle" },
        info,
        decisions: [],
        sawWorking: new Set(["a"]),
        now: T0 + 12 * 60_000,
        id: "r",
      });
      expect(recap!.finished.map((c) => c.agentId)).toEqual(["a"]);
      expect(recap!.finished[0]!.status).toBe("idle");
    });

    it("adds no row for an agent still WORKING on the way back", () => {
      // Seen working, and still working — that is not a finish, and the evidence must not invent
      // one out of an agent that is mid-turn.
      expect(
        buildRecap({
          snapshot: snap({ a: "idle" }),
          next: { a: "working" },
          info,
          decisions: [],
          sawWorking: new Set(["a"]),
          now: T0 + 12 * 60_000,
          id: "r",
        }),
      ).toBeNull();
    });

    it("does not resurrect an agent that left the snapshot's fleet", () => {
      // `agentIds` is the fence for the evidence path too, exactly as it is for the diff.
      expect(
        buildRecap({
          snapshot: { status: {}, agentIds: [], at: T0 },
          next: { a: "idle" },
          info,
          decisions: [],
          sawWorking: new Set(["a"]),
          now: T0 + 12 * 60_000,
          id: "r",
        }),
      ).toBeNull();
    });

    it("does not let LAST stretch's evidence vouch for this one", () => {
      // The host clears the set at both edges; this pins that the parameter is per-stretch by
      // showing the same diff going quiet when nobody was seen working.
      const args = {
        snapshot: snap({ a: "stopped" }),
        next: { a: "unmerged" } as StatusMap,
        info,
        decisions: [],
        now: T0 + 12 * 60_000,
        id: "r",
      };
      expect(buildRecap({ ...args, sawWorking: new Set() })).toBeNull();
      expect(buildRecap({ ...args, sawWorking: new Set(["b"]) })).toBeNull();
    });

    it("does NOT catch a red-worker paint releasing — an accepted false positive", () => {
      // An orchestrator painted `waiting` by engine/workerAttention returns to `idle` when its
      // worker recovers, having done nothing itself, and this reports it. Accepted, not
      // overlooked: telling it from "you were asked, and now it's done" needs a discriminator for
      // whose red it was, which the status map doesn't carry (see RESTING_STATUSES). Pinned so the
      // limitation is visible rather than folded into a passing suite.
      expect(build({ a: "waiting" }, { a: "idle" })!.finished).toHaveLength(1);
      // What the gate DOES stop is the resting-to-resting version of the same churn.
      expect(build({ a: "idle" }, { a: "done" })).toBeNull();
    });
  });

  it("says nothing about an agent that went `stopped`", () => {
    // `stopped` is the de-escalation target for a DISMISSED `errored` alert (engine/alertDismissal
    // deEscalatedStatus), and the recap now reads that same derived map — so reporting it would
    // re-raise alarms the user explicitly silenced. See RECAP_STATUSES.
    expect(build({ a: "working" }, { a: "stopped" })).toBeNull();
  });

  it("buckets `blocked` as wanting you", () => {
    // Not in the notification-attention set, but the concierge's needs_you band surfaces it, so a
    // recap that filed it under "finished" — or dropped it — would contradict the thread's cards.
    const recap = build({ a: "working" }, { a: "blocked" });
    expect(recap!.needsYou.map((c) => c.status)).toEqual(["blocked"]);
  });

  it("ignores an agent that stayed put, even in a reportable status", () => {
    // Already waiting when you left, still waiting: you knew about it. The diff is INTO, not IN.
    expect(build({ a: "waiting" }, { a: "waiting" })).toBeNull();
  });

  it("counts a status change WITHIN the reportable set — the ask itself changed", () => {
    const recap = build({ a: "waiting" }, { a: "approval" });
    expect(recap!.needsYou.map((c) => c.status)).toEqual(["approval"]);
  });

  it("drops an agent the caller can no longer name", () => {
    // It left the feed while the user was out. "That agent needs you" is worse than silence in a
    // summary the user is meant to act on.
    const recap = buildRecap({
      snapshot: { status: { z: "working" }, agentIds: ["z"], at: T0 },
      next: { z: "waiting" },
      info,
      decisions: [],
      now: T0 + 1000,
      id: "r",
    });
    expect(recap).toBeNull();
  });

  it("restricts the diff to the agents present at snapshot time", () => {
    // A brand-new agent that appeared and went straight to waiting is not part of "what happened
    // while you were gone" as measured against the fleet you left behind.
    const recap = buildRecap({
      snapshot: { status: {}, agentIds: [], at: T0 },
      next: { a: "waiting" },
      info,
      decisions: [],
      now: T0 + 1000,
      id: "r",
    });
    expect(recap).toBeNull();
  });

  it("records the away duration", () => {
    const recap = build({ b: "working" }, { b: "done" }, [], T0 + 90 * 60_000);
    expect(recap!.awayMs).toBe(90 * 60_000);
  });
});

describe("buildRecap — the minimum-stretch gate", () => {
  it("says nothing about status changes on a stretch shorter than MIN_AWAY_MS", () => {
    // ⌘-tab to Slack for eight seconds is a complete Away→Here stretch (blur → Away is immediate
    // and unconditional, by design). On any live fleet an agent moves in that window, so without
    // this gate the card — and its screen-reader announcement — fires on routine app switching.
    expect(build({ a: "working" }, { a: "waiting" }, [], T0 + 8_000)).toBeNull();
    expect(build({ a: "working" }, { a: "idle" }, [], T0 + MIN_AWAY_MS - 1)).toBeNull();
  });

  it("reports them once the stretch reaches MIN_AWAY_MS", () => {
    const recap = build({ a: "working" }, { a: "waiting" }, [], T0 + MIN_AWAY_MS);
    expect(recap!.needsYou.map((c) => c.agentId)).toEqual(["a"]);
  });

  // roborev 53677-M. The gate is enforced in TWO places — once for the `entered` diff, and again
  // where `sawWorking` evidence produces rows — and every test above reaches only the first,
  // because `build()` passes no `sawWorking` and they all rely on a status CHANGE. The evidence
  // path is the wider door: `sawWorking` is accumulated on every feed update while blurred with no
  // duration condition, so an eight-second ⌘-tab in which any agent lands on a finished status
  // would post a card and announce it — reachable with identical endpoints, i.e. with no status
  // change at all, which the diff-only version could never do.
  it("also gates the sawWorking evidence path, which needs no status change at all", () => {
    const brief = buildRecap({
      snapshot: snap({ a: "idle" }),
      next: { a: "idle" },
      info,
      decisions: [],
      sawWorking: new Set(["a"]),
      now: T0 + MIN_AWAY_MS - 1,
      id: "recap-brief",
    });
    expect(brief).toBeNull();

    const long = buildRecap({
      snapshot: snap({ a: "idle" }),
      next: { a: "idle" },
      info,
      decisions: [],
      sawWorking: new Set(["a"]),
      now: T0 + MIN_AWAY_MS,
      id: "recap-long",
    });
    expect(long!.finished.map((c) => c.agentId)).toEqual(["a"]);
  });

  it("still reports what the concierge DID, however brief the stretch", () => {
    // A gate decision is never routine — "I sent this while you were out" is news at eight seconds
    // exactly as it is at eight hours, and it can't fire on an idle ⌘-tab the way a status can.
    const s: StatusMap = { a: "working" };
    const recap = build(s, { a: "waiting" }, [
      { id: "d", kind: "sent", agentName: "A", summary: "Re-ran the tests", at: T0 + 1_000 },
    ], T0 + 8_000);
    expect(recap!.decisions).toHaveLength(1);
    // …but the status half is still suppressed: brevity gates the diff, not the log.
    expect(recap!.needsYou).toEqual([]);
  });
});

describe("buildRecap — the gate-decision seam", () => {
  const dec = (over: Partial<GateDecision>): GateDecision => ({
    id: "d1",
    kind: "queued",
    agentName: "Kraken Auth",
    summary: "Delete the staging database",
    at: T0 + 60_000,
    ...over,
  });

  it("renders a card for decisions alone, with no status change at all", () => {
    const s: StatusMap = { a: "working" };
    const recap = build(s, s, [dec({})]);
    expect(recap).not.toBeNull();
    expect(recap!.decisions).toHaveLength(1);
    expect(recap!.needsYou).toEqual([]);
  });

  it("excludes decisions taken BEFORE this away stretch began", () => {
    const s: StatusMap = { a: "working" };
    expect(build(s, s, [dec({ at: T0 - 1 })])).toBeNull();
    // The boundary itself counts — a decision at the instant of the transition is part of it.
    expect(build(s, s, [dec({ at: T0 })])).not.toBeNull();
  });

  it("orders decisions oldest first — the recap reads as a narrative", () => {
    const s: StatusMap = { a: "working" };
    const recap = build(s, s, [
      dec({ id: "late", at: T0 + 5 * 60_000 }),
      dec({ id: "early", at: T0 + 60_000 }),
    ]);
    expect(recap!.decisions.map((d) => d.id)).toEqual(["early", "late"]);
  });
});

describe("formatAwayFor", () => {
  it("rounds to the minute and says 'a moment' under one", () => {
    expect(formatAwayFor(20_000)).toBe("a moment");
    expect(formatAwayFor(60_000)).toBe("1 minute");
    expect(formatAwayFor(12 * 60_000)).toBe("12 minutes");
  });

  it("breaks into hours past sixty minutes", () => {
    expect(formatAwayFor(60 * 60_000)).toBe("1 hour");
    expect(formatAwayFor(65 * 60_000)).toBe("1 hour 5 minutes");
    expect(formatAwayFor(121 * 60_000)).toBe("2 hours 1 minute");
  });
});

describe("recapSummary", () => {
  it("reads like a sentence a person wants, not a count dump", () => {
    const recap = build({ a: "working", b: "working" }, { a: "waiting", b: "done" })!;
    expect(recapSummary(recap)).toBe("While you were away — 12 minutes: 1 needs you, 1 finished.");
  });

  it("agrees the verb with the count — this sentence is also the announcement", () => {
    const recap = build({ a: "working", c: "working" }, { a: "waiting", c: "errored" })!;
    expect(recapSummary(recap)).toBe("While you were away — 12 minutes: 2 need you.");
  });

  it("names what the concierge did on your behalf", () => {
    const s: StatusMap = { a: "working" };
    const recap = build(s, s, [
      { id: "1", kind: "sent", agentName: "A", summary: "Re-ran the tests", at: T0 + 1 },
      { id: "2", kind: "queued", agentName: "B", summary: "Dropped the DB", at: T0 + 2 },
      { id: "3", kind: "cancelled", agentName: "C", summary: "Force push", at: T0 + 3 },
    ])!;
    expect(recapSummary(recap)).toBe(
      "While you were away — 12 minutes: 1 sent for you, 1 waiting on your say-so, 1 cancelled.",
    );
  });
});

// ── A head standing in for its subtree is not a head that finished ────────────────────────────
//
// engine/workerRollup promotes a calm orchestrator to `working` when its workers roll up green, so
// every surface bands the fleet the same way. The recap must NOT read that promotion as the head
// doing a unit of work: without this, one worker finishing produced TWO "finished" rows — the
// worker, and the orchestrator promoted on its behalf (roborev 53886/53917).
describe("buildRecap — a rolled-up head does not report its worker's finish as its own", () => {
  const both: Record<string, RecapAgentInfo> = {
    orch: { name: "Kraken Auth", projectName: "sparkle", statusLabel: "Done" },
    w1: { name: "Parser Worker", projectName: "sparkle", statusLabel: "Done" },
  };

  // THE COMMON SHAPE, and the one a first fix that only covered mid-stretch promotion left broken:
  // the head was ALREADY promoted when the user walked away, so the snapshot holds `working` for it
  // and the diff reads working → idle. Only `rolledUpGreen` on the snapshot can tell that apart from
  // a head that was genuinely running.
  it("skips a head promoted BEFORE the away edge", () => {
    const recap = buildRecap({
      snapshot: {
        status: { orch: "working", w1: "working" },
        agentIds: ["orch", "w1"],
        rolledUpGreen: ["orch"],
        at: T0,
      },
      next: { orch: "idle", w1: "idle" },
      info: both,
      decisions: [],
      now: T0 + 12 * 60_000,
      id: "recap-1",
    });
    expect(recap!.finished.map((f) => f.agentId)).toEqual(["w1"]);
  });

  // A head that really was working still reports — the fix must not silence genuine finishes.
  it("keeps a head that was working under its own steam", () => {
    const recap = buildRecap({
      snapshot: {
        status: { orch: "working", w1: "working" },
        agentIds: ["orch", "w1"],
        rolledUpGreen: [],
        at: T0,
      },
      next: { orch: "idle", w1: "idle" },
      info: both,
      decisions: [],
      now: T0 + 12 * 60_000,
      id: "recap-1",
    });
    expect(recap!.finished.map((f) => f.agentId).sort()).toEqual(["orch", "w1"]);
  });

  // A snapshot written before the field existed reads as "none promoted" — the pre-rollup behavior,
  // so an in-flight away stretch spanning an app update doesn't change meaning.
  it("treats a missing rolledUpGreen as none", () => {
    const recap = buildRecap({
      snapshot: { status: { orch: "working", w1: "working" }, agentIds: ["orch", "w1"], at: T0 },
      next: { orch: "idle", w1: "idle" },
      info: both,
      decisions: [],
      now: T0 + 12 * 60_000,
      id: "recap-1",
    });
    expect(recap!.finished.map((f) => f.agentId).sort()).toEqual(["orch", "w1"]);
  });
});
