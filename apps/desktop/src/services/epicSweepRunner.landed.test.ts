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

import { sweepEpics, EPIC_READY_TO_CLOSE_LABEL } from "./epicSweepRunner";
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

async function sweep(beads: Bead[], over: { lastSweepRestartAt?: number; canNotify?: boolean } = {}) {
  const restart = vi.fn(async (_p: string, _e: string) => ({ agentId: "x", verdict: "restarted" as const }));
  const audit = vi.fn(async (_p: string, _id: string, _text: string) => {});
  const mark = vi.fn(async (_p: string, _a: "add" | "remove", _id: string) => {});
  const setLabel = vi.fn(async (_p: string, _a: "add" | "remove", _id: string, _l: string) => {});
  const notify = vi.fn((_text: string) => true);
  if (over.lastSweepRestartAt !== undefined) {
    const epic = beads.find((b) => b.id === "e1");
    if (epic) epic.labels = [...epic.labels, `sweep-restarted:${over.lastSweepRestartAt}`];
  }
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
    audit,
    mark,
    setLabel,
    notify,
    canNotify: () => over.canNotify ?? true,
  });
  // What the sweep WROTE, as (bead, label) pairs, so a case asserts the store side effect itself.
  const added = setLabel.mock.calls.filter((c) => c[1] === "add").map((c) => `${c[2]}:${c[3]}`);
  // Every label write (add OR remove) aimed at a CHILD. Must stay empty in every outcome: a child's
  // `updatedAt` is the sweep's own stall clock, so writing to one would read as progress next tick
  // (roborev 83478).
  const childWrites = setLabel.mock.calls.filter((c) => c[2] !== "e1").map((c) => `${c[1]} ${c[2]}:${c[3]}`);
  return { outcome: out.find((o) => o.epicId === "e1"), restart, audit, mark, setLabel, notify, added, childWrites };
}

beforeEach(() => {
  landedMock.mockReset();
  landedMock.mockResolvedValue(null);
});

describe("sweepEpics — reads whether the remaining children already landed", () => {
  it("a FULLY-LANDED epic is flagged ready-to-close — NOT restarted and NOT sent to Blocked", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1", "e1.2"]));
    const { outcome, restart, mark, added, notify, audit, childWrites } = await sweep(stalledEpic());

    expect(outcome?.action).toBe("ready-to-close");
    expect(outcome?.performed).toBe("ready-to-close");
    expect(restart).not.toHaveBeenCalled();
    // THE BLOCKED LANE IS THE `stalled` MARK — it must never be written for a finished epic.
    expect(mark).not.toHaveBeenCalled();
    // It asks about the OPEN children only, against the project, through the production default.
    expect(landedMock).toHaveBeenCalledWith("/proj", ["e1.1", "e1.2"]);
    // The EPIC carries the non-Blocked flag; NO child is written to (a child write would move the
    // stall clock and retract this very flag on the next tick).
    expect(added).toContain(`e1:${EPIC_READY_TO_CLOSE_LABEL}`);
    expect(childWrites).toEqual([]);
    // The founder is told it needs a CLOSE, not that it is blocked.
    const said = notify.mock.calls[0]?.[0] ?? "";
    expect(said).toMatch(/ready to close/i);
    // The copy must describe what happened: the epic was labelled, the children were not.
    expect(said).toMatch(/labelled the epic/i);
    expect(said).not.toMatch(/marked those children/i);
    expect(said).not.toMatch(/moved it to Blocked/i);
    expect(said).toContain("e1.1");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[2]).toContain("e1.2");
  });

  it("REGRESSION (roborev 83514) — a window that CANNOT notify writes nothing and flags nothing", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1", "e1.2"]));
    const { outcome, setLabel, notify, audit, mark, restart } = await sweep(stalledEpic(), { canNotify: false });

    expect(outcome?.note).toBe("cannot-notify");
    expect(outcome?.performed).toBe("none");
    // The terminal flag is the thing that would hide the epic, so it must not be written here.
    expect(setLabel.mock.calls.filter((c) => c[3] === EPIC_READY_TO_CLOSE_LABEL)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("a fully-landed epic whose one restart is ALREADY SPENT still reads ready-to-close, not Blocked", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1", "e1.2"]));
    const { outcome, mark } = await sweep(stalledEpic(), { lastSweepRestartAt: STALE + 1 });

    expect(outcome?.performed).toBe("ready-to-close");
    expect(mark).not.toHaveBeenCalled();
  });

  it("PAIRED — a spent restart with nothing landed is still a genuine Blocked escalation", async () => {
    landedMock.mockResolvedValue(new Set());
    const { outcome, mark } = await sweep(stalledEpic(), { lastSweepRestartAt: STALE + 1 });

    expect(outcome?.performed).toBe("escalated");
    expect(mark).toHaveBeenCalledWith("/proj", "add", "e1");
  });

  it("an epic ALREADY flagged ready-to-close is left alone — no second notice, no git read", async () => {
    const beads = stalledEpic().map((b) => (b.id === "e1" ? { ...b, labels: [EPIC_READY_TO_CLOSE_LABEL] } : b));
    landedMock.mockResolvedValue(new Set(["e1.1", "e1.2"]));
    const { outcome, notify, added, restart } = await sweep(beads);

    expect(outcome?.reason).toBe("awaiting-close");
    expect(notify).not.toHaveBeenCalled();
    // (The pre-existing promoted-marker self-heal may still write; nothing of THIS rule does.)
    expect(added.filter((a) => a.includes(EPIC_READY_TO_CLOSE_LABEL))).toEqual([]);
    expect(restart).not.toHaveBeenCalled();
    expect(landedMock).not.toHaveBeenCalled();
  });

  it("RETRACTS the ready-to-close flag once a child moves — without touching the Blocked mark", async () => {
    const beads = stalledEpic().map((b) =>
      b.id === "e1"
        ? { ...b, labels: [EPIC_READY_TO_CLOSE_LABEL] }
        : b.id === "e1.1"
          ? { ...b, updatedAt: iso(NOW - 60_000) }
          : b,
    );
    const { outcome, setLabel, mark } = await sweep(beads);

    expect(outcome?.performed).toBe("cleared");
    expect(setLabel).toHaveBeenCalledWith("/proj", "remove", "e1", EPIC_READY_TO_CLOSE_LABEL);
    // It was never in Blocked, so there is no `stalled` mark to retract.
    expect(mark).not.toHaveBeenCalled();
  });

  it("a MIXED epic restarts, writes to NO child, and names the landed subset in the brief", async () => {
    landedMock.mockResolvedValue(new Set(["e1.1"]));
    const { outcome, restart, added, audit, notify, childWrites } = await sweep(stalledEpic());

    expect(outcome?.performed).toBe("restarted");
    expect(restart).toHaveBeenCalledWith("p1", "e1");
    expect(childWrites).toEqual([]);
    expect(added).not.toContain(`e1:${EPIC_READY_TO_CLOSE_LABEL}`);
    // The durable brief on the epic (which the resumed orchestrator reads) lists the landed subset
    // and tells it to skip them; the still-open child is not in that list.
    const note = audit.mock.calls[0]?.[2] ?? "";
    expect(note).toMatch(/ALREADY LANDED.*e1\.1/);
    expect(note).not.toMatch(/ALREADY LANDED.*e1\.2/);
    expect(note).toMatch(/skip/i);
    expect(note).toMatch(/NOT labelled/);
    const said = notify.mock.calls[0]?.[0] ?? "";
    expect(said).toContain("e1.1");
    expect(said).toMatch(/did not label or close anything/);
  });

  it("REGRESSION (roborev 83478) — no outcome writes to a child, so the sweep cannot move its own stall clock", async () => {
    for (const landed of [new Set(["e1.1", "e1.2"]), new Set(["e1.1"]), new Set<string>()]) {
      landedMock.mockResolvedValue(landed);
      const { childWrites } = await sweep(stalledEpic());
      expect(childWrites, `landed=${[...landed].join(",")}`).toEqual([]);
    }
  });

  it("an epic with NO landed child restarts exactly as before — nothing marked, no landed line", async () => {
    landedMock.mockResolvedValue(new Set());
    const { outcome, restart, childWrites, audit } = await sweep(stalledEpic());

    expect(outcome?.performed).toBe("restarted");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(childWrites).toEqual([]);
    expect(audit.mock.calls[0]?.[2] ?? "").not.toMatch(/ALREADY LANDED/);
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
