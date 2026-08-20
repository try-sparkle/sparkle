// The fleet CI-budget governor wired to the REAL shipAgent (end-to-end): with the budget at N and N
// ships in flight, a new ship must be HELD — it must NOT call pushAgentBranch / openAgentPr (the
// actual CI-triggering side effect) — and must proceed once a slot frees. This drives the real
// `shipAgent` and the real singleton `ciBudgetGovernor`; only the git/PR boundary is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./branchStatus", () => ({
  landAgentBranch: vi.fn(),
  pushAgentBranch: vi.fn(),
  openAgentPr: vi.fn(),
  deleteAgentBranch: vi.fn(),
  deleteAgentBranchIfMerged: vi.fn(),
}));
vi.mock("./beads", () => ({
  closeBead: vi.fn(),
  markBeadDelivered: vi.fn(),
  recordBeadMergeSha: vi.fn(),
  deleteBead: vi.fn(),
}));
vi.mock("./worktree", () => ({ removeAgentWorkspace: vi.fn() }));

import { shipAgent } from "./closeAgentActions";
import { ciBudgetGovernor } from "./ciBudgetGovernor";
import * as branch from "./branchStatus";
import * as beads from "./beads";

const ship = (id: string) =>
  shipAgent({
    root: "/repo",
    projectId: "proj",
    agentId: id,
    targetBranch: "main",
    prTitle: `PR ${id}`,
    beadId: `bead-${id}`,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
  vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/x");
  vi.mocked(beads.closeBead).mockResolvedValue(undefined);
  // Real singleton, configured for this test: budget 1, a short lease, a healthy pool.
  ciBudgetGovernor.configure({
    budget: 1,
    leaseMs: 1000,
    loadProbe: () => ({ releaseInProgress: false }),
  });
});

afterEach(() => {
  // Drain any leaked in-flight slot BEFORE discarding the fake timers (a pending lease timer would
  // otherwise strand a slot into the next test), then return the singleton to its inert default.
  ciBudgetGovernor.reset();
  ciBudgetGovernor.configure({ budget: 0, leaseMs: 900_000, loadProbe: () => ({ releaseInProgress: null }) });
  vi.mocked(branch.pushAgentBranch).mockReset();
  vi.mocked(branch.openAgentPr).mockReset();
  vi.mocked(beads.closeBead).mockReset();
  vi.useRealTimers();
});

describe("shipAgent under the fleet CI budget", () => {
  it("holds the 2nd ship (no push, no PR) while the 1st occupies the only slot, then drains it", async () => {
    const p1 = ship("one");
    const p2 = ship("two"); // synchronously queued: the 1st already took the single slot at acquire

    await p1; // the 1st ship's push + PR complete; its slot is now held by the lease

    // SIDE EFFECT: exactly ONE ship has pushed / opened a PR. The 2nd is HELD, not merely delayed in
    // its bookkeeping — the git/PR calls that trigger CI have not happened for it.
    expect(branch.pushAgentBranch).toHaveBeenCalledTimes(1);
    expect(branch.pushAgentBranch).toHaveBeenCalledWith("/repo", "one");
    expect(branch.openAgentPr).toHaveBeenCalledTimes(1);

    // A slot frees (the presumed CI run completes) → the queued ship drains and finally pushes.
    await vi.advanceTimersByTimeAsync(1000);
    await p2;

    expect(branch.pushAgentBranch).toHaveBeenCalledTimes(2);
    expect(branch.pushAgentBranch).toHaveBeenCalledWith("/repo", "two");
    expect(branch.openAgentPr).toHaveBeenCalledTimes(2);
  });

  it("dedupes a re-clicked ship for the SAME agent: a 2nd call while one is in flight pushes ONCE", async () => {
    // A held ship keeps the row + Ship affordance around, so a user/concierge can fire it again.
    // Without dedupe, both drain and the 2nd openAgentPr fails on 'PR already exists' (a spurious
    // pushed-no-pr for work that shipped). The 2nd call must return the SAME in-flight promise.
    const first = ship("dup");
    const second = ship("dup");
    expect(second).toBe(first); // same promise, not a second ship

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);

    // The agent was pushed / had a PR opened exactly ONCE despite two ship calls.
    expect(branch.pushAgentBranch).toHaveBeenCalledTimes(1);
    expect(branch.openAgentPr).toHaveBeenCalledTimes(1);
  });
});
