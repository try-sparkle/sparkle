// AN ORCHESTRATOR THAT FINISHED HAS LEFT ITS EPIC AS UNSTAFFED AS ONE THAT DIED (bead
// `sparkle-70cu4y`).
//
// ══ THE MEASURED FAILURE ═══════════════════════════════════════════════════════════════════════
// The founder, for the third time: *"I still don't understand why you don't have any active epics
// showing."* Measured alongside it: 24 `in_progress` epics in the store, the Concierge sitting IDLE,
// and `[improvement].never_idle_armed` defaulting ON — so the never-idle watcher WAS armed and the
// unstaffed count it gates on was nonetheless zero.
//
// The reason is that every witness the staffing join reads is a question about the PROCESS, and a
// finished agent passes all of them. An orchestrator that marked its own goal `met` is up, its pane
// reads `idle`, and its hook log is FRESH because it was committing work minutes before it stopped.
// So `orchestratorLivenessOf` answered `true`, `decideEpicSweep` answered `skip:
// orchestrator-alive` on every tick, and the epic was never handed back to anybody.
//
// `pusherMount.improveUnstaffedEpics` had already learned this for the NUDGE path (bead
// `sparkle-nu7gd9`) and patched it locally. The EPIC SWEEP — the thing that actually restarts the
// epic — never asked the question at all. These cases pin the sweep's SIDE EFFECT: a real restart
// dispatched, not a decision enum.
import { describe, expect, it, vi } from "vitest";

const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));

import { sweepEpics, type EpicSweepOutcome } from "./epicSweepRunner";
import { PROMOTED_LABEL, STALLED_LABEL, type Bead } from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import type { AgentGoal, AgentTab } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import type { ObservedVerdict } from "../engine/observedAttention";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString();
/** Old enough that the epic is stalled, so every case below reaches the staffing question rather
 *  than stopping at `too-soon`. */
const STALE = NOW - EPIC_STALL_MS - 60_000;
/** FRESH. The whole point of the fixture: this orchestrator was working minutes ago, so no
 *  hook-log rule and no liveness rule can call it dead. Only its own goal can. */
const JUST_NOW = NOW - 60_000;

/** A live mandate — set an hour ago, well inside the default 4h TTL. */
const LIVE_GOAL: AgentGoal = {
  text: "build the epic",
  setAt: NOW - HOUR,
  ttlMs: 4 * HOUR,
  continues: 0,
  totalContinues: 0,
};
/** The measured shape: the agent declared itself done and stopped. */
const MET_GOAL: AgentGoal = { ...LIVE_GOAL, metAt: NOW - 30 * 60_000 };

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

/** One promoted, planned, STALLED epic with ONE bound orchestrator that is alive and was active a
 *  minute ago — every gate ahead of the staffing question satisfied, so the staffing question is
 *  the only thing any case below can be measuring. */
function scenario(
  over: {
    goal?: AgentGoal;
    alive?: boolean | undefined;
    status?: AgentTabStatus;
    attention?: ObservedVerdict;
    lastHookEventMs?: number | null;
  } = {},
) {
  const beads: Bead[] = [
    bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [PROMOTED_LABEL] }),
    bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
  ];
  const agents = [
    buildAgent({
      id: "a1",
      epicId: "e1",
      createdAt: STALE - 60_000,
      ...(over.goal === undefined ? {} : { goal: over.goal }),
    }),
  ];
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
  const run = (): Promise<EpicSweepOutcome[]> =>
    sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      // KEY PRESENCE, NOT `?? default` — an explicit `undefined` is the "this window never
      // observed the agent" case and has to stay expressible.
      aliveFor: () => ("alive" in over ? over.alive : true),
      statusFor: () => ("status" in over ? over.status : "idle"),
      ...(over.attention === undefined ? {} : { attentionFor: () => over.attention }),
      lastHookEventFor: () => (over.lastHookEventMs === undefined ? JUST_NOW : over.lastHookEventMs),
      deathCauseFor: () => undefined,
      restartEnabled: true,
      restart,
      mark,
      setLabel,
      notify,
      canNotify: () => true,
      audit: vi.fn(async () => {}),
    });
  return { run, restart, mark, notify, beads };
}

const forEpic = (out: EpicSweepOutcome[]) => out.find((x) => x.epicId === "e1");

describe("a bound orchestrator that FINISHED does not staff its epic", () => {
  // THE BUG, AS ONE TEST. Alive, pane `idle`, hook log a minute old — every existing witness says
  // STAFFING — and a goal it marked `met` half an hour ago. Before the fix this answered
  // `skip: orchestrator-alive` and dispatched nothing, forever.
  //
  // ASSERTS THE SIDE EFFECT: the restart was actually dispatched. A test on `action` alone would be
  // satisfied by a sweep that decided to restart and then handed the epic to nobody.
  it("hands back an epic whose orchestrator met its goal and stopped", async () => {
    const s = scenario({ goal: MET_GOAL });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(s.restart.mock.calls[0]?.[1]).toBe("e1");
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  // ── THE PAIRED CASE ─────────────────────────────────────────────────────────────────────────
  // The SAME fixture with ONE fact changed: the goal is still live. Without it the case above is
  // satisfied by a sweep that restarts every epic it looks at — which would spawn a rival against
  // every epic somebody is actively building, strictly worse than the bug being fixed.
  it("leaves alone the SAME epic when that orchestrator's goal is still live", async () => {
    const s = scenario({ goal: LIVE_GOAL });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("skip");
    expect(o?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  // NO GOAL RECORD IS NOT A QUIET GOAL. Most build agents never carry one, so reading an absent
  // record as "finished" would hand back every promoted epic in the store on the first tick.
  it("leaves alone an orchestrator that carries no goal record at all", async () => {
    const s = scenario({});
    expect(forEpic(await s.run())?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // A GOAL THAT ENDED BADLY IS NOT A FINISHED ONE. `expired` means the TTL ran out with work
  // outstanding — the agent may well still be mid-turn — so it must not authorize a handoff on the
  // strength of the goal alone. (It stays reachable through the hook-log rule, which is the witness
  // that can actually speak to whether anything is running.)
  it("does not treat an EXPIRED goal as finished", async () => {
    const s = scenario({ goal: { ...LIVE_GOAL, setAt: NOW - 9 * HOUR } });
    expect(forEpic(await s.run())?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // ── THE ONE THING A MET GOAL MUST NEVER BUY ────────────────────────────────────────────────
  // `sendToBuild` on an already-live orchestrator delivers its handoff as a bracketed paste plus
  // Enter into that agent's PTY. The grid reporting `awaiting` means a prompt is on screen RIGHT
  // NOW, so restarting would answer a pending permission dialog on the human's behalf. A goal
  // record is no evidence the PTY is gone and must not outrank the witness that can see one.
  it("never hands back an orchestrator the grid sees sitting at a prompt, met goal or not", async () => {
    const s = scenario({ goal: MET_GOAL, status: "approval", attention: "awaiting" });
    const o = forEpic(await s.run());
    expect(o?.action).toBe("skip");
    expect(o?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  // POSITIVE OBSERVATION IS REQUIRED (the lesson `pusherMount.agentIsFinished` records from roborev
  // 72653). A goal is PERSISTED on the agent tab, so after an app restart every row carries whatever
  // `metAt` it had while this window has observed none of them. Reading the goal alone would unstaff
  // the whole store at once on the strength of nobody having looked — the exact defect class the
  // staffing join was written to end.
  it("judges an UNOBSERVED orchestrator by its hook log, not by its persisted goal", async () => {
    const s = scenario({ goal: MET_GOAL, alive: undefined, status: undefined });
    expect(forEpic(await s.run())?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });
});
