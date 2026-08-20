import { describe, it, expect, beforeEach, vi } from "vitest";

// The two levers `mountAgentAwaited` chooses between, mocked so which ROUTE ran is observable.
// Asserting "we called a function named open" is exactly what let a provable no-op ship twice
// (roborev 60241), so every case here asserts the lever, not the intent.
const restartPaneMock = vi.fn((_id: string) => false);
// `opts` is FORWARDED, not dropped. With it dropped, nothing in the suite could observe what budget
// phase 1 was given — so deleting the budget arithmetic entirely changed no test outcome, which is
// the "assertion already true before the change" shape. The deadline guard is now a VALUE assertion.
const restartPaneAwaitedMock = vi.fn(
  async (_id: string, _opts?: { readyTimeoutMs?: number; pollMs?: number }) =>
    "restarted" as string,
);
vi.mock("./paneControl", async (orig) => ({
  ...(await orig<typeof import("./paneControl")>()),
  restartPane: (id: string) => restartPaneMock(id),
  restartPaneAwaited: (id: string, o?: { readyTimeoutMs?: number; pollMs?: number }) =>
    restartPaneAwaitedMock(id, o),
}));

const admitAgentMock = vi.fn();
vi.mock("./resurrectionAdmission", async (orig) => ({
  ...(await orig<typeof import("./resurrectionAdmission")>()),
  admitAgent: (id: string) => admitAgentMock(id),
}));

// Route 2 waits for Workspace to mount the pane it arranged, so the test decides whether one ever
// registers. `unmounted` is the honest default here — there is no React render pass in this suite.
let paneStateValue = "unmounted";
vi.mock("./paneReadiness", async (orig) => ({
  ...(await orig<typeof import("./paneReadiness")>()),
  paneState: () => paneStateValue,
}));

const openMock = vi.fn();
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: openMock }) },
}));

import {
  mountAgentAwaited,
  mountedAwaited,
  MOUNT_MIN_ROUTE2_MS,
  type AwaitedMountResult,
} from "./agentMount";

const dead = () => false;

describe("mountAgentAwaited", () => {
  beforeEach(() => {
    restartPaneMock.mockReset();
    restartPaneMock.mockReturnValue(false);
    restartPaneAwaitedMock.mockReset();
    restartPaneAwaitedMock.mockResolvedValue("restarted");
    admitAgentMock.mockReset();
    openMock.mockReset();
    paneStateValue = "unmounted";
  });

  // ── THE LIVENESS GATE ────────────────────────────────────────────────────────────────────────
  // The caller does awaited work (a `bd` write against a single-writer store shared by every
  // worktree) between deciding "this agent is dead" and arriving here, so the decision is stale by
  // construction. This asks again at the last instant before the irreversible step.
  describe("refuses to restart an agent that is not provably dead", () => {
    it("does not pull the lever when the agent is observed ALIVE", async () => {
      const r = await mountAgentAwaited("a1", () => true, () => true);
      expect(r).toBe("already-live");
      expect(restartPaneAwaitedMock).not.toHaveBeenCalled();
    });

    it("does not pull the lever when liveness is UNOBSERVED", async () => {
      // `undefined` means nobody took a reading — an agent the user closed reads exactly that way.
      // Same polarity as `epicSweepRunner.candidateFor`'s own `alive(id) !== false`, and for the
      // reason it states: a wrong "alive" costs one skipped tick, a wrong "dead" tears down a live
      // PTY. Getting this backwards is destructive and silent.
      const r = await mountAgentAwaited("a1", () => true, () => undefined);
      expect(r).toBe("already-live");
      expect(restartPaneAwaitedMock).not.toHaveBeenCalled();
    });

    it("DOES pull the lever when the agent is observed dead", async () => {
      // The paired positive. Without it, the two cases above are equally satisfied by a function
      // that never restarts anything at all — which would pass while the feature was 100% broken.
      const r = await mountAgentAwaited("a1", () => true, dead);
      expect(r).toBe("restarted");
      expect(restartPaneAwaitedMock).toHaveBeenCalledWith("a1", expect.anything());
    });
  });

  // ── THE VERDICT MAP ──────────────────────────────────────────────────────────────────────────
  // Only "restarted" means the agent came back. Every other verdict must be reported as a failure,
  // because the caller spends a one-shot budget and then tells a human what it did.
  describe("maps the pane's verdict honestly", () => {
    const cases: Array<[string, AwaitedMountResult]> = [
      ["restarted", "restarted"],
      ["no-claude", "no-claude"],
      ["timed-out", "timed-out"],
      ["nothing-to-restart", "nothing-to-restart"],
      ["spawn-failed", "spawn-failed"],
      // Collapsed onto spawn-failed: no caller can act differently on "the lever raised" versus
      // "the pane gave up" — both mean do not report a relaunch.
      ["threw", "spawn-failed"],
    ];
    for (const [verdict, expected] of cases) {
      it(`${verdict} → ${expected}`, async () => {
        restartPaneAwaitedMock.mockResolvedValue(verdict);
        expect(await mountAgentAwaited("a1", () => true, dead)).toBe(expected);
      });
    }

    it("counts ONLY restarted as a success among the pane's own verdicts", async () => {
      for (const [verdict] of cases) {
        restartPaneAwaitedMock.mockResolvedValue(verdict);
        const r = await mountAgentAwaited("a1", () => true, dead);
        expect(mountedAwaited(r)).toBe(verdict === "restarted");
      }
    });

    it("does NOT default an unrecognised verdict to success", async () => {
      // Fails closed, like every other gate on this path: a `PaneRestartResult` that grew an arm
      // behind this function's back must not read as a relaunch.
      restartPaneAwaitedMock.mockResolvedValue("something-new");
      expect(await mountAgentAwaited("a1", () => true, dead)).toBe("spawn-failed");
    });
  });

  // ── ROUTE 2 ──────────────────────────────────────────────────────────────────────────────────
  describe("falls through to admission + open when no pane is mounted", () => {
    beforeEach(() => restartPaneAwaitedMock.mockResolvedValue("no-pane"));

    it("makes BOTH writes, which together are what mounts a pane", async () => {
      paneStateValue = "starting"; // Workspace mounted it
      const r = await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 300, pollMs: 10 });
      expect(r).toBe("opened");
      // Both, doing different jobs: admission unlocks the PROJECT's visited gate in Workspace's
      // `live` memo, and open is the persisted mount signal for the AGENT.
      expect(admitAgentMock).toHaveBeenCalledWith("a1");
      expect(openMock).toHaveBeenCalledWith("a1");
    });

    it("REFUSES, and writes nothing, for an id no Project.agents row names", async () => {
      // Both writes are effectively permanent for the session (the admission set is add-only and
      // nothing removes an id from openAgentIds on a PTY exit), so growing them for an id that can
      // never mount is pure garbage the caller would then report as a successful relaunch.
      const r = await mountAgentAwaited("a1", () => false, dead, {
        readyTimeoutMs: 300,
        pollMs: 10,
      });
      expect(r).toBe("no-agent-row");
      expect(mountedAwaited(r)).toBe(false);
      expect(admitAgentMock).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
    });

    it("does NOT report `opened` for a pane that never registers", async () => {
      // The two writes only ARRANGE a mount; `Workspace` performs it on its next render. Reporting
      // `opened` immediately made it a promise the caller could not use — a write into an
      // `unmounted` pane does not queue, it is refused as `pty-gone`, and by then the caller has
      // spent an irreversible budget. Fails closed: a pane that never appears is a timeout.
      paneStateValue = "unmounted";
      const r = await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 120, pollMs: 10 });
      expect(r).toBe("timed-out");
      expect(mountedAwaited(r)).toBe(false);
    });

    it("splits a SMALL budget in half — the cap branch, asserted exactly", async () => {
      // EXACT, not a bound. `toBeLessThan(budget)` was satisfied by a 1ms reservation (no usable
      // floor at all) and, because the pre-fix code read `deadline - Date.now()` a statement after
      // computing `deadline`, by `999` whenever the millisecond rolled over — so the revert-check
      // only went red probabilistically, in the one situation where it has to hold. An exact value
      // no clock read can produce removes both holes.
      paneStateValue = "starting";
      await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 1_000, pollMs: 10 });
      const [, o] = restartPaneAwaitedMock.mock.calls[0] as unknown as [
        string,
        { readyTimeoutMs: number },
      ];
      expect(o.readyTimeoutMs).toBe(500); // budget/2, because 1000 < 2 * MOUNT_MIN_ROUTE2_MS
    });

    it("reserves exactly 5s from a 20s budget — LITERALS, so the assertion is not an identity", async () => {
      // The previous cut derived the budget from the constant (`4 * C`) and asserted `budget - C`,
      // which reduces to `3C === 4C - C` — true for EVERY value of C. So it pinned the branch and the
      // arithmetic shape but not the magnitude, and the only real lower bound came from the other
      // test's fixed 1000/500 pair: `C >= 500`. A change from 5_000 to 600 passed the entire suite
      // while leaving route 2 ~600ms to observe a Workspace render plus PTY registration — the same
      // "no usable floor" failure as the 1ms case, an order of magnitude up.
      paneStateValue = "starting";
      await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 20_000, pollMs: 10 });
      const [, o] = restartPaneAwaitedMock.mock.calls[0] as unknown as [
        string,
        { readyTimeoutMs: number },
      ];
      expect(o.readyTimeoutMs).toBe(15_000);
    });

    it("keeps the floor big enough to be worth reserving", () => {
      // The magnitude, constrained from below FOR A STATED REASON rather than by mirroring whatever
      // the constant currently is. Route 2 is waiting on a React render pass followed by PTY
      // registration; that takes seconds, not hundreds of milliseconds. A floor smaller than this
      // satisfies every arithmetic assertion above and still guarantees nothing.
      expect(MOUNT_MIN_ROUTE2_MS).toBeGreaterThanOrEqual(5_000);
    });

    it("still has time to mount after a LATE `no-pane` — the floor is what makes that true", async () => {
      // THE REGRESSION THE FLOOR EXISTS FOR. `restartPaneAwaited` checks `unmounted` before it checks
      // its deadline, so it can return `no-pane` with ~0ms left. Without a reserved floor, route 2
      // then made its two PERMANENT writes and timed out on the first loop iteration — the caller
      // reported a failure and stayed silent, the epic's one-shot budget was already spent, and
      // `Workspace` mounted the pane anyway, leaving an orchestrator up with no delivered
      // instruction. Strictly worse than either phase failing alone.
      restartPaneAwaitedMock.mockImplementation(async (_id, o) => {
        await new Promise((r) => setTimeout(r, o?.readyTimeoutMs ?? 0)); // spend it ALL
        return "no-pane";
      });
      paneStateValue = "unmounted";
      setTimeout(() => {
        paneStateValue = "starting";
      }, 40);

      const r = await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 300, pollMs: 10 });

      expect(r).toBe("opened");
      expect(admitAgentMock).toHaveBeenCalledWith("a1");
    });

    it("writes NOTHING when the budget is already gone", async () => {
      // Keeps `no-agent-row`'s discipline: never make a permanent write for a mount this call cannot
      // stay around to observe. Both writes are effectively permanent for the session.
      restartPaneAwaitedMock.mockResolvedValue("no-pane");
      paneStateValue = "unmounted";
      const r = await mountAgentAwaited("a1", () => true, dead, { readyTimeoutMs: 0, pollMs: 10 });
      expect(r).toBe("timed-out");
      expect(admitAgentMock).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
    });

    it("returns as soon as the pane appears, rather than waiting out the budget", async () => {
      // The paired positive for the case above: without it, "never reports opened" is equally
      // satisfied by a function that can never report `opened` at all.
      paneStateValue = "unmounted";
      setTimeout(() => {
        paneStateValue = "starting";
      }, 30);
      const started = Date.now();
      const r = await mountAgentAwaited("a1", () => true, dead, {
        readyTimeoutMs: 5_000,
        pollMs: 10,
      });
      expect(r).toBe("opened");
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
