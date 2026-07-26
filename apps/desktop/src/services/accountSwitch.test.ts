import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  isSafeToSwitch,
  planSwitch,
  readyToMove,
  advanceSwitch,
  moveAgent,
  isSwitchComplete,
  type SwitchPlan,
} from "./accountSwitch";
import { getPin, clearAllPins } from "./accountStore";
import type { AgentTabStatus } from "../types";

beforeEach(() => clearAllPins());

describe("isSafeToSwitch", () => {
  it("refuses to switch an agent that is mid-turn", () => {
    // `working` = Claude Code actively producing output. Re-spawning here loses in-flight work and
    // can interrupt a tool call — the exact risk that made Phase 1 decline to switch at all.
    expect(isSafeToSwitch("working")).toBe(false);
  });

  it("allows every status where the turn is over", () => {
    const safe: AgentTabStatus[] = [
      "idle",
      "waiting",
      "approval",
      "blocked",
      "errored",
      "unmerged",
      "done",
      "stopped",
    ];
    for (const s of safe) expect(isSafeToSwitch(s)).toBe(true);
  });

  it("treats an unknown status as safe (no pane / not reporting)", () => {
    expect(isSafeToSwitch(undefined)).toBe(true);
  });
});

describe("planSwitch", () => {
  it("enrolls only agents on the account being left", () => {
    const plan = planSwitch("a", "b", { one: "a", two: "b", three: "a", four: undefined });
    expect(plan.pending.sort()).toEqual(["one", "three"]);
    expect(plan.moved).toEqual([]);
    expect(plan.fromAccountId).toBe("a");
    expect(plan.toAccountId).toBe("b");
  });

  it("produces an already-complete plan when nothing is on that account", () => {
    const plan = planSwitch("a", "b", { one: "b" });
    expect(plan.pending).toEqual([]);
    expect(isSwitchComplete(plan)).toBe(true);
  });
});

describe("readyToMove / advanceSwitch — each agent switches at its OWN safe moment", () => {
  const base: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: ["x", "y", "z"], moved: [] };

  it("moves only the agents that are currently idle, leaving busy ones pending", () => {
    const statuses: Record<string, AgentTabStatus> = { x: "idle", y: "working", z: "waiting" };
    expect(readyToMove(base, statuses).sort()).toEqual(["x", "z"]);

    const restart = vi.fn(() => true);
    const { plan, movedNow } = advanceSwitch(base, statuses, restart);
    expect(movedNow.sort()).toEqual(["x", "z"]);
    expect(plan.pending).toEqual(["y"]); // still busy — deliberately not yanked
    expect(plan.moved.sort()).toEqual(["x", "z"]);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(isSwitchComplete(plan)).toBe(false);
  });

  it("finishes the straggler on a later pass, once it goes idle", () => {
    const restart = vi.fn(() => true);
    const first = advanceSwitch(base, { x: "idle", y: "working", z: "idle" }, restart).plan;
    const second = advanceSwitch(first, { y: "idle" }, restart);
    expect(second.movedNow).toEqual(["y"]);
    expect(isSwitchComplete(second.plan)).toBe(true);
    expect(second.plan.moved.sort()).toEqual(["x", "y", "z"]);
  });

  it("is a no-op pass when every pending agent is busy", () => {
    const restart = vi.fn(() => true);
    const { plan, movedNow } = advanceSwitch(base, { x: "working", y: "working", z: "working" }, restart);
    expect(movedNow).toEqual([]);
    expect(plan).toBe(base); // unchanged reference — nothing to rewrite
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("moveAgent", () => {
  it("pins BEFORE restarting, so the re-spawn picks up the new account", () => {
    // Order is load-bearing: the spawn path reads the pin while building the exec, so pinning after
    // the restart would re-spawn onto the OLD account and silently do nothing.
    const order: string[] = [];
    const restart = vi.fn((id: string) => {
      order.push(`restart:${id}`);
      order.push(`pin-at-restart:${getPin(id)}`);
      return true;
    });
    moveAgent("x", "b", restart);
    expect(order).toEqual(["restart:x", "pin-at-restart:b"]);
    expect(getPin("x")).toBe("b");
  });

  it("still records the pin when no pane is mounted to restart", () => {
    // A closed agent has no pane; it must still come back on the new account next time it spawns.
    const restart = vi.fn(() => false);
    expect(moveAgent("gone", "b", restart)).toBe(false);
    expect(getPin("gone")).toBe("b");
  });
});

describe("a switch actually changes the account the agent runs under", () => {
  // REGRESSION GUARD for the highest-severity defect found in review of this branch.
  //
  // The first implementation registered `Terminal.restart()` as the pane's switch lever. That only
  // bumps Terminal's internal `attempt`; its spawn effect is keyed on [agentId, attempt] and
  // re-reads the `args` PROP, which still held the exec string built by the last prepare() — with
  // the OLD account's CLAUDE_CONFIG_DIR baked in. So every "switch" re-spawned onto the same
  // account while reporting success, the pane re-registered the old account, and the next poll
  // re-issued the same recommendation — accepting repeatedly would churn the whole fleet while the
  // quota kept draining on the account it was supposed to leave.
  //
  // The invariant that makes a switch real: the pin must be readable BEFORE the exec is rebuilt,
  // and the rebuilt exec must carry the new config dir. This test pins exactly that.
  it("the exec rebuilt after a move carries the NEW account's config dir", async () => {
    const { buildClaudeExec } = await import("./claudeSpawn");
    const dirFor: Record<string, string> = { a: "/cfg/old-account", b: "/cfg/new-account" };

    // Stand-in for AgentPane's prepare(): reads the pin, then builds the exec from it — the same
    // order the real path uses (chooseAccountForAgent → getPin → buildClaudeExec).
    const rebuildExec = (agentId: string) => {
      const pinned = getPin(agentId) ?? "a";
      return buildClaudeExec("/bin/claude", false, { configDir: dirFor[pinned] });
    };

    expect(rebuildExec("x")).toContain("/cfg/old-account");

    // A restart lever that RE-PREPARES (rebuilds the exec) rather than merely re-spawning.
    let lastExec = "";
    const reprepare = (agentId: string) => {
      lastExec = rebuildExec(agentId);
      return true;
    };

    moveAgent("x", "b", reprepare);

    expect(lastExec).toContain("/cfg/new-account");
    expect(lastExec).not.toContain("/cfg/old-account");
    // And a fresh rebuild keeps landing on the new account, so the pane re-registers it.
    expect(rebuildExec("x")).toContain("/cfg/new-account");
  });
});
