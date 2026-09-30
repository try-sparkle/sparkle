import { describe, it, expect, vi, beforeEach } from "vitest";

// bead sparkle-5wjy5a: the sweep restarted an epic because "no child bead has moved in 5h" while
// every open child had been fixed by PRs that already merged.
//
// `./beadLanded` is mocked at the MODULE boundary rather than injected, so these cases drive the
// sweep's PRODUCTION default (`opts.landedBeadIdsFor ?? landedBeadIds`). Injecting the seam in every
// case would leave that default executed by nothing — the shape AGENTS.md calls a defaulted seam.
const landedMock = vi.fn(
  async (_projectPath: string, _ids: readonly string[]): Promise<ReadonlySet<string> | null> => null,
);
vi.mock("./beadLanded", () => ({
  landedBeadIds: (p: string, ids: readonly string[]) => landedMock(p, ids),
}));

import { sweepEpics } from "./epicSweepRunner";
import type { Bead } from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
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

const stalledEpic = (): Bead[] => [
  bead({ id: "e1", title: "Ship the thing", type: "epic" }),
  bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
  bead({ id: "e1.2", parent: "e1", status: "in_progress", updatedAt: iso(STALE) }),
  bead({ id: "e1.3", parent: "e1", status: "closed", updatedAt: iso(STALE) }),
];

async function sweep(beads: Bead[]) {
  const restart = vi.fn(async (_p: string, _e: string) => ({ agentId: "x", verdict: "restarted" as const }));
  const out = await sweepEpics({
    now: NOW,
    ownsProject: () => true,
    projects: [
      {
        id: "p1",
        rootPath: "/proj",
        agents: [{ id: "a1", name: "a1", kind: "build", epicId: "e1", createdAt: STALE - 60_000 } as AgentTab],
      },
    ],
    beadsFor: () => beads,
    aliveFor: () => false,
    restartEnabled: true,
    restart,
    audit: vi.fn(async () => {}),
    mark: vi.fn(async () => {}),
    setLabel: vi.fn(async () => {}),
    notify: vi.fn(() => true),
    canNotify: () => true,
  });
  return { outcome: out.find((o) => o.epicId === "e1"), restart };
}

beforeEach(() => {
  landedMock.mockReset();
  landedMock.mockResolvedValue(null);
});

describe("sweepEpics — reads whether the remaining children already landed", () => {
  it("ESCALATES instead of restarting when every OPEN child is named by a landed commit", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1", "e1.2"]));
    const { outcome, restart } = await sweep(stalledEpic());

    // Not a silent skip (roborev 83233): the human is shown the epic, the restart is not spent.
    expect(outcome?.action).toBe("escalate");
    expect(outcome?.performed).toBe("escalated");
    expect(restart).not.toHaveBeenCalled();
    // It asks about the OPEN children only, against the project, through the production default.
    expect(landedMock).toHaveBeenCalledWith("/proj", ["e1.1", "e1.2"]);
  });

  it("PAIRED — one open child with no landed commit still restarts", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1"]));
    const { outcome, restart } = await sweep(stalledEpic());

    expect(outcome?.performed).toBe("restarted");
    expect(restart).toHaveBeenCalledWith("p1", "e1");
  });

  it("an unreadable reading changes nothing — the restart still happens", async () => {
    landedMock.mockResolvedValue(null);
    const { restart } = await sweep(stalledEpic());
    expect(restart).toHaveBeenCalledTimes(1);

    landedMock.mockRejectedValue(new Error("boom"));
    const again = await sweep(stalledEpic());
    expect(again.restart).toHaveBeenCalledTimes(1);
  });

  it("pays no git read on a tick that would not spend anything", async () => {
    const fresh = stalledEpic().map((b) => (b.id === "e1.1" ? { ...b, updatedAt: iso(NOW - 60_000) } : b));
    const { outcome } = await sweep(fresh);

    expect(outcome?.action).toBe("skip");
    expect(landedMock).not.toHaveBeenCalled();
  });
});
