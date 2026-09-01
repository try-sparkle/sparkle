// The sweep must judge an orchestrator by EVIDENCE OF WORK, not by a status enum nobody refreshed.
//
// Its own file rather than more cases in `epicSweepRunner.test.ts`, for the reason that file's
// header gives about mocking at the module boundary: these cases need `runtimeStore` seeded and the
// dead-session registry reset, and mixing that setup into a 1,900-line suite that deliberately
// injects every seam would make it ambiguous which default each case is exercising.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));

import { sweepEpics, type EpicSweepOutcome } from "./epicSweepRunner";
import { PROMOTED_LABEL, SWEEP_RESTART_PREFIX, STALLED_LABEL, type Bead } from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import { ORCHESTRATOR_SILENT_MS } from "../engine/orchestratorLiveness";
import { useRuntimeStore } from "../stores/runtimeStore";
import { _resetDeadSessionRegistryForTests, noteAgentDeath } from "./deadSessionRegistry";
import type { DeathCause } from "../engine/deathTypes";
import type { AgentTab } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import type { ObservedVerdict } from "../engine/observedAttention";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString();
/** Old enough that the epic is stalled, so every case below reaches the staffing question. */
const STALE = NOW - EPIC_STALL_MS - 60_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

/** One promoted, planned, stalled epic with ONE orchestrator bound to it — the exact shape of the
 *  founder's 17 measured rows. */
function scenario(
  over: {
    /** `undefined` = this window never observed the agent, which is what a fleet-wide death leaves
     *  behind: no surviving pane, so `runtimeStore.status` holds nothing for anyone. */
    alive?: boolean | undefined;
    /** The RAW observed status, when the case is about one. */
    status?: AgentTabStatus;
    /** The Rust nudger's grid verdict — the witness that retracts. */
    attention?: ObservedVerdict;
    /** Does the durable ledger record the orchestrator as dead? */
    deathRecorded?: boolean;
    lastHookEventMs?: number | null;
    deathCause?: DeathCause;
    /** Omit BOTH artifact seams so the production defaults run. */
    useRealSeams?: boolean;
  } = {},
) {
  const beads: Bead[] = [
    bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [PROMOTED_LABEL] }),
    bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
  ];
  const agents = [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })];
  const restart = vi.fn(async (_projectId: string, _epicId: string) => ({
    agentId: "new-agent",
    verdict: "restarted" as const,
  }));
  const notify = vi.fn((_text: string) => true);
  const setLabel = vi.fn(
    async (_path: string, action: "add" | "remove", id: string, label: string) => {
      const b = beads.find((x) => x.id === id);
      if (!b) return;
      b.labels =
        action === "add"
          ? [...b.labels.filter((l) => l !== label), label]
          : b.labels.filter((l) => l !== label);
    },
  );
  const mark = vi.fn(async (path: string, action: "add" | "remove", id: string) =>
    setLabel(path, action, id, STALLED_LABEL),
  );
  const audit = vi.fn(async () => {});
  const run = (): Promise<EpicSweepOutcome[]> =>
    sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => over.alive,
      ...(over.status === undefined ? {} : { statusFor: () => over.status }),
      ...(over.attention === undefined ? {} : { attentionFor: () => over.attention }),
      ...(over.deathRecorded === undefined
        ? {}
        : { deathRecordedFor: () => over.deathRecorded as boolean }),
      restartEnabled: true,
      restart,
      mark,
      setLabel,
      notify,
      // The production default is `conciergeNotifierAvailable`, which is false outside a window
      // that hosts a ConciergeHost — so without this every restart below would refuse with
      // `cannot-notify` and the cases would assert nothing about staffing. That refusal has its own
      // coverage in `epicSweepRunner.test.ts`; here it is deliberately out of the way.
      canNotify: () => true,
      audit,
      // The seams under test. Omitted entirely when `useRealSeams`, so the runner's own defaults —
      // `runtimeStore.agentMovement` and `deadSessionRegistry.deathCauseForAgent` — are what run.
      ...(over.useRealSeams
        ? {}
        : {
            lastHookEventFor: () => over.lastHookEventMs ?? null,
            deathCauseFor: () => over.deathCause,
          }),
    });
  return { run, restart, mark, setLabel, notify, beads };
}

const forEpic = (out: EpicSweepOutcome[]) => out.find((x) => x.epicId === "e1");

describe("an orchestrator is judged by evidence of work, not by a latched status", () => {
  // ══ THE MEASURED FAILURE ════════════════════════════════════════════════════════════════════
  // 25 epics `in_progress`, 17 naming an orchestrator, every one idle with an activity timestamp
  // 93-121 hours old, and zero work happening on any of them for five days. The sweep ran every ten
  // minutes throughout and answered `skip: orchestrator-alive` every time, because
  // `processAliveFor` returns `undefined` for an agent whose pane this window is not hosting and
  // the old expression read `undefined !== false` as ALIVE.
  //
  // ASSERTS THE SIDE EFFECT, not the decision: a test on `action` alone would be satisfied by a
  // sweep that decided to restart and dispatched nothing.
  it("restarts an epic whose orchestrator has produced no hook event for 121 hours", async () => {
    const s = scenario({ alive: undefined, lastHookEventMs: NOW - 121 * HOUR });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(s.restart.mock.calls[0]?.[1]).toBe("e1");
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  // The other half of the same incident. The pane IS mounted and the status map says alive — a
  // latch written days ago that nothing retracts — while the hook log proves nothing has run. The
  // measurement has to beat the latch or an orchestrator that died with its pane open is immortal.
  it("a stale hook log beats an OBSERVED-ALIVE status", async () => {
    const s = scenario({ alive: true, lastHookEventMs: NOW - 93 * HOUR });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
  });

  // ── THE PAIRED CASE ─────────────────────────────────────────────────────────────────────────
  // Same fixture, same everything, ONE fact different: the orchestrator acted a minute ago. Without
  // this the test above passes for a sweep that simply restarts everything, which would be strictly
  // worse than the bug — it would spawn a rival against every epic somebody is actually building.
  it("does NOT restart an epic whose orchestrator acted a minute ago", async () => {
    const s = scenario({ alive: undefined, lastHookEventMs: NOW - 60_000 });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("skip");
    expect(o?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // A single long tool call emits no `PostToolUse` until it finishes. The window has to outlast the
  // longest legitimate one or the sweep invents deaths for agents that are working.
  it("tolerates a long single tool call right up to the window", async () => {
    const s = scenario({ alive: undefined, lastHookEventMs: NOW - ORCHESTRATOR_SILENT_MS + 1000 });
    expect(forEpic(await s.run())?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // FAIL CLOSED. No artifact reading and no observation is not an all-clear and not a death — it is
  // a missing reading, and the engine already refuses to act on one. The old code answered `true`
  // here, which is how an unread state became a permanent claim of health.
  it("names the missing reading instead of guessing, when no witness answers", async () => {
    const s = scenario({ alive: undefined, lastHookEventMs: null });
    const o = forEpic(await s.run());
    expect(o?.reason).toBe("staffing-unknown");
    expect(s.restart).not.toHaveBeenCalled();
  });
});

// ── THE ONE THING THE SWEEP MUST NEVER DO ───────────────────────────────────────────────────────
// roborev 72648 (High). An orchestrator sitting at a permission prompt reports ALIVE
// (`processAliveFor`'s DEAD set is only done|errored|stopped) and its hook log FREEZES at the
// unanswered `PreToolUse`. Read as a death, the sweep hands the epic back — and `sendToBuild` on an
// already-live orchestrator writes the handoff text into that PTY as a bracketed paste plus Enter,
// which ANSWERS the pending question with the handoff text. A permission decision the human never
// made, taken while they are away. The remedy gate cannot catch it: `blocked-on-human` is a DEATH
// cause and a LIVE blocked agent has no death record, so `deathCauseFor` returns undefined and
// `restartRemedyFor` answers "restart".
describe("an orchestrator waiting on a human is staffing, not dead", () => {
  it.each(["questions", "waiting", "approval", "blocked"] as const)(
    "never restarts an epic whose orchestrator sits at a prompt (%s)",
    async (status) => {
      const s = scenario({
        alive: true,
        status,
        attention: "awaiting",
        lastHookEventMs: NOW - 121 * HOUR,
      });
      const o = forEpic(await s.run());
      expect(o?.action).toBe("skip");
      expect(o?.reason).toBe("orchestrator-alive");
      // THE SIDE EFFECT that matters: nothing was handed back, so nothing was typed into the open
      // prompt. Asserting only the reason would pass for a sweep that skipped for another cause.
      expect(s.restart).not.toHaveBeenCalled();
      expect(s.notify).not.toHaveBeenCalled();
    },
  );

  // ── AND THE EXEMPTION EXPIRES (roborev 73028) ─────────────────────────────────────────────
  // The same latched `waiting`, but the grid has RETRACTED (its `gone` verdict clears the entry when
  // the PTY is swept) — i.e. the orchestrator died at the prompt. Without corroboration the epic
  // would read staffed forever, which is the original incident for the exact rows the bead named.
  // It does NOT restart either: `null` is `staffing-unknown`, which spends nothing and — unlike the
  // `true` it replaces — cannot clear a real escalation.
  it("a latched wait with no grid reading is staffing-UNKNOWN, not staffed", async () => {
    const s = scenario({ alive: true, status: "waiting", lastHookEventMs: NOW - 121 * HOUR });
    const o = forEpic(await s.run());
    expect(o?.reason).toBe("staffing-unknown");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // `calm` IS NOT PERMISSION TO ACT. `observed_attention.rs` maps a prompt found only by
  // `nudge_gate`'s live-region arm to `Verdict::Calm` BY CONSTRUCTION, so treating it as "no prompt"
  // re-opens the paste hazard through the witness added to close it.
  it("does not restart on a `calm` grid reading over a latched wait", async () => {
    const s = scenario({
      alive: true,
      status: "waiting",
      attention: "calm",
      lastHookEventMs: NOW - 121 * HOUR,
    });
    const o = forEpic(await s.run());
    expect(o?.reason).toBe("staffing-unknown");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // THE ARM THAT RECOVERS THE BATCH-KILL POPULATION, and the only way a latched wait reaches a
  // restart: the DURABLE ledger positively records the session as ended, so there is no prompt left
  // to type into.
  it("restarts a latched wait once the durable ledger records the death", async () => {
    const s = scenario({
      alive: true,
      status: "waiting",
      deathRecorded: true,
      lastHookEventMs: NOW - 121 * HOUR,
    });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  // PAIRED, or the cases above are satisfiable by a sweep that stopped restarting anything. `idle`
  // is not a human wait, and it is one of the three statuses the bead actually recorded.
  it("…but an IDLE orchestrator with the same stale log is still restarted", async () => {
    const s = scenario({ alive: true, status: "idle", lastHookEventMs: NOW - 121 * HOUR });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });
});

describe("a restart is one remedy, not the default one", () => {
  // The founder's machine has an intermittent DNS fault that kills agents in BATCHES on
  // `API Error: ... (ENOTFOUND)`. This is the death a restart genuinely fixes, and it must happen
  // without a human noticing.
  it("restarts a transport death — the batch-death signature", async () => {
    const s = scenario({
      alive: undefined,
      lastHookEventMs: NOW - 121 * HOUR,
      deathCause: "transport-transient",
    });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  // A spend cap opens when a human raises it; a spawn moves nothing. 2,273 account-wall records
  // across 1,102 sessions were measured on this machine, one session retrying 45 times.
  it("declines behind a spend wall — and spends neither the budget nor a false alarm", async () => {
    const s = scenario({
      alive: undefined,
      lastHookEventMs: NOW - 121 * HOUR,
      deathCause: "wall-spend",
    });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("none");
    expect(o?.note).toBe("wall");
    expect(s.restart).not.toHaveBeenCalled();
    // NOTHING WAS SPENT AND NOTHING WAS CLAIMED. No `sweep-restarted` stamp (which would burn the
    // epic's one-shot budget on an attempt never made) and no `stalled` mark (which would put a
    // false alarm in the lane the founder scans for real ones). The epic is fully eligible next
    // tick, which is the whole point of declining rather than escalating.
    expect(s.beads[0]?.labels.some((l) => l.startsWith(SWEEP_RESTART_PREFIX))).toBe(false);
    expect(s.beads[0]?.labels).not.toContain(STALLED_LABEL);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("declines behind a session wall, which lifts on its own clock", async () => {
    const s = scenario({
      alive: undefined,
      lastHookEventMs: NOW - 121 * HOUR,
      deathCause: "wall-session",
    });
    expect(forEpic(await s.run())?.note).toBe("wall");
    expect(s.restart).not.toHaveBeenCalled();
  });

  it("declines when a human deliberately stopped the orchestrator", async () => {
    const s = scenario({
      alive: undefined,
      lastHookEventMs: NOW - 121 * HOUR,
      deathCause: "human-stopped",
    });
    expect(forEpic(await s.run())?.note).toBe("human-blocked");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // Reads backwards until you note WHICH question is asked. `isResurrectable` refuses a met goal,
  // correctly, about the AGENT. This is about the EPIC, which is demonstrably not done — and 17 of
  // the founder's 17 named orchestrators had goals reading `met` or `expired`.
  it("restarts an epic whose orchestrator marked its OWN goal met", async () => {
    const s = scenario({
      alive: undefined,
      lastHookEventMs: NOW - 121 * HOUR,
      deathCause: "clean-goal-met",
    });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
  });
});

// ── THE DEFAULTS, DRIVEN ────────────────────────────────────────────────────────────────────────
// Every case above injects both new seams, so the lines that supply the REAL values would be
// covered by nothing — delete them and the whole suite stays green while the bug walks back in.
// These inject neither.
describe("against the real stores", () => {
  beforeEach(() => {
    _resetDeadSessionRegistryForTests();
    useRuntimeStore.getState().setAgentMovement({});
    useRuntimeStore.getState().seedObservedAttention({});
  });
  afterEach(() => {
    _resetDeadSessionRegistryForTests();
    useRuntimeStore.getState().setAgentMovement({});
    useRuntimeStore.getState().seedObservedAttention({});
  });

  it("reads the hook log out of runtimeStore.agentMovement, with no seam injected", async () => {
    useRuntimeStore.getState().setAgentMovement({
      a1: {
        lastEvent: "PostToolUse",
        lastEventMs: NOW - 121 * HOUR,
        sessionId: "s1",
        toolsRecent: 0,
      },
    });
    const s = scenario({ alive: undefined, useRealSeams: true });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
  });

  it("…and does not restart when that same map says the orchestrator just acted", async () => {
    useRuntimeStore.getState().setAgentMovement({
      a1: { lastEvent: "PostToolUse", lastEventMs: NOW - 30_000, sessionId: "s1", toolsRecent: 4 },
    });
    const s = scenario({ alive: undefined, useRealSeams: true });
    expect(forEpic(await s.run())?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // ── THE ATTENTION SEAM'S DEFAULT, DRIVEN ─────────────────────────────────────────────────────
  // Without this, the line that reads `runtimeStore.observedAttention` is executed by nothing: every
  // other case injects `attentionFor`, and the one case that omits it asserts the EMPTY-store answer
  // (`null`), which is already true before the lookup runs. A typo there — the wrong map, the wrong
  // field — would make the `awaiting` exemption dead code, leave every waiting orchestrator
  // permanently `staffing-unknown`, and red no test. That is the defaulted-seam shape AGENTS.md
  // records as `sparkle-lgbwf`.
  it("reads the grid verdict out of runtimeStore.observedAttention, with no seam injected", async () => {
    useRuntimeStore.getState().setObservedAttention("a1", {
      verdict: "awaiting",
      alternate: false,
      atMs: NOW - 30 * 60_000,
    });
    useRuntimeStore.getState().setAgentMovement({
      a1: {
        lastEvent: "PreToolUse",
        lastEventMs: NOW - 121 * HOUR,
        sessionId: "s1",
        toolsRecent: 0,
      },
    });
    const s = scenario({ alive: true, status: "waiting", useRealSeams: true });
    const o = forEpic(await s.run());
    // The real store answered `awaiting`, so the epic is STAFFED and nothing is typed anywhere.
    expect(o?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // ── THE DEATH SEAM'S DEFAULT, DRIVEN, AND COUPLED TO THE REMEDY GATE ────────────────────────
  // `deathRecordedFor` defaults to `deathCauseFor(id) !== undefined` and every other case INJECTS
  // it, so the production line was executed by nothing: mutate it to `() => false` and no test reds,
  // while the batch-kill recovery arm — the whole point of the death witness — goes permanently
  // inert. Same defaulted-seam shape as the attention seam above (`sparkle-lgbwf`).
  //
  // It also pins the COUPLING the two-layer design turns on, which no test covered: in production
  // `deathRecordedFor` and `deathCauseFor` are the SAME reading, so a latched wait released by the
  // liveness layer arrives at the remedy gate carrying a real cause — and for a wall or a human
  // stop that gate must still refuse. Injecting the two independently (as the other cases do) can
  // hold a pair production cannot.
  it("releases a latched wait via the REAL registry, then the remedy gate refuses a wall", async () => {
    useRuntimeStore.getState().setAgentMovement({
      a1: {
        lastEvent: "PreToolUse",
        lastEventMs: NOW - 121 * HOUR,
        sessionId: "s1",
        toolsRecent: 0,
      },
    });
    // No grid entry at all, so the death record is the only witness — and it is read from the real
    // registry, by the real default, for BOTH layers.
    noteAgentDeath("a1", "wall-spend");
    const s = scenario({ alive: true, status: "waiting", useRealSeams: true });
    const o = forEpic(await s.run());
    // Liveness released the latch (otherwise this would be `staffing-unknown`, never a `restart`
    // decision) and the remedy gate then refused it, because a spawn cannot open a spend cap.
    expect(o?.action).toBe("restart");
    expect(o?.note).toBe("wall");
    expect(s.restart).not.toHaveBeenCalled();
  });

  it("…and the same path RESTARTS when the real cause is a transport death", async () => {
    useRuntimeStore.getState().setAgentMovement({
      a1: {
        lastEvent: "PreToolUse",
        lastEventMs: NOW - 121 * HOUR,
        sessionId: "s1",
        toolsRecent: 0,
      },
    });
    noteAgentDeath("a1", "transport-transient");
    const s = scenario({ alive: true, status: "waiting", useRealSeams: true });
    expect(forEpic(await s.run())?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  it("reads the death cause out of the real registry, with no seam injected", async () => {
    useRuntimeStore.getState().setAgentMovement({
      a1: {
        lastEvent: "PostToolUse",
        lastEventMs: NOW - 121 * HOUR,
        sessionId: "s1",
        toolsRecent: 0,
      },
    });
    noteAgentDeath("a1", "wall-spend");
    const s = scenario({ alive: undefined, useRealSeams: true });
    const o = forEpic(await s.run());
    expect(o?.note).toBe("wall");
    expect(s.restart).not.toHaveBeenCalled();
  });
});
