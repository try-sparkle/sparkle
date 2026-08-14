import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  refreshAgentWatchdog,
  resetAgentWatchdog,
  setAgentWatchdogKiller,
  type WatchdogReport,
  type WatchdogVerdict,
} from "./agentMemoryWatchdog";
import { useAgentWatchdogStore } from "../stores/agentWatchdogStore";

const MIB = 1024 * 1024;

function verdict(over: Partial<WatchdogVerdict> = {}): WatchdogVerdict {
  return {
    agent_id: "agent-1",
    root_pid: 4242,
    rss_bytes: 1100 * MIB,
    proc_count: 2,
    level: "ok",
    kill_offered: false,
    auto_kill: false,
    message: "",
    ...over,
  };
}

function report(over: Partial<WatchdogReport> = {}): WatchdogReport {
  return {
    verdicts: [],
    sample: null,
    coalition_bytes: 0,
    unavailable: false,
    ...over,
  };
}

/** A verdict for an agent the Rust side has decided to auto-kill (opted in + past kill tier). */
function runaway(id = "runaway"): WatchdogVerdict {
  return verdict({
    agent_id: id,
    rss_bytes: 9000 * MIB,
    proc_count: 5,
    level: "critical",
    kill_offered: true,
    auto_kill: true,
    message: "8.8 GiB across 5 process(es) — past the 8192 MiB kill threshold.",
  });
}

let kill: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke.mockReset();
  kill = vi.fn().mockResolvedValue(undefined);
  setAgentWatchdogKiller((id) => kill(id));
  resetAgentWatchdog();
  useAgentWatchdogStore.setState({ report: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setAgentWatchdogKiller();
  resetAgentWatchdog();
  vi.restoreAllMocks();
});

describe("refreshAgentWatchdog — the ACT half (auto-kill)", () => {
  it("kills an agent the Rust side marked auto_kill — the side effect the feature exists for", async () => {
    invoke.mockResolvedValue(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("boom");
  });

  it("does NOT kill a warn-level agent (over warn, under kill) — warn before kill", async () => {
    invoke.mockResolvedValue(
      report({
        verdicts: [
          verdict({ agent_id: "busy", rss_bytes: 5000 * MIB, level: "warn", message: "past warn" }),
        ],
      }),
    );
    await refreshAgentWatchdog();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does NOT kill a critical agent when the user did NOT opt in (auto_kill false)", async () => {
    // kill_offered true, but auto_kill false: the Rust gate says surface + offer, do not auto-kill.
    invoke.mockResolvedValue(
      report({
        verdicts: [
          verdict({
            agent_id: "big",
            rss_bytes: 9000 * MIB,
            level: "critical",
            kill_offered: true,
            auto_kill: false,
          }),
        ],
      }),
    );
    await refreshAgentWatchdog();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does NOT kill a normal/building agent (level ok)", async () => {
    invoke.mockResolvedValue(report({ verdicts: [verdict({ agent_id: "building" })] }));
    await refreshAgentWatchdog();
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills a runaway ONCE across repeated ticks — the process is still resident next poll", async () => {
    invoke.mockResolvedValue(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    await refreshAgentWatchdog();
    await refreshAgentWatchdog();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("re-kills only after the agent has left AND returned on a real reading", async () => {
    invoke.mockResolvedValueOnce(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    // A real reading with the agent gone prunes the actioned entry.
    invoke.mockResolvedValueOnce(report({ verdicts: [] }));
    await refreshAgentWatchdog();
    // Same id back (would never happen with real session ids, but proves the prune is real).
    invoke.mockResolvedValueOnce(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("does NOT prune the actioned set on an UNAVAILABLE reading, so it can't re-kill mid-teardown", async () => {
    invoke.mockResolvedValueOnce(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    // ps read failed: empty verdicts but unavailable — must NOT clear the actioned set.
    invoke.mockResolvedValueOnce(report({ verdicts: [], unavailable: true }));
    await refreshAgentWatchdog();
    // Agent still resident (kill hasn't landed): a second real tick must not re-issue the kill.
    invoke.mockResolvedValueOnce(report({ verdicts: [runaway("boom")] }));
    await refreshAgentWatchdog();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe("refreshAgentWatchdog — the SURFACE half", () => {
  it("pushes the report to the store so the UI can render warn/critical agents", async () => {
    const rep = report({ verdicts: [runaway("boom")], coalition_bytes: 9000 * MIB });
    invoke.mockResolvedValue(rep);
    await refreshAgentWatchdog();
    expect(useAgentWatchdogStore.getState().report).toEqual(rep);
  });

  it("warns once on the rising transition, not on every sustained tick", async () => {
    const warn = vi.spyOn(console, "warn");
    // warn appears, then stays warn: exactly one transition-warn (kill line never fires, auto_kill off).
    const busy = verdict({ agent_id: "busy", rss_bytes: 5000 * MIB, level: "warn", message: "past warn" });
    invoke.mockResolvedValue(report({ verdicts: [busy] }));
    await refreshAgentWatchdog();
    await refreshAgentWatchdog();
    const surfaceCalls = warn.mock.calls.filter((c) => String(c[0]).includes("busy"));
    expect(surfaceCalls).toHaveLength(1);
  });
});

describe("refreshAgentWatchdog — robustness", () => {
  it("a REJECTED invoke does not throw and does not touch the store (older backends reject every tick)", async () => {
    invoke.mockRejectedValue(new Error("Command agent_memory_watchdog not found"));
    await expect(refreshAgentWatchdog()).resolves.toBeUndefined();
    expect(useAgentWatchdogStore.getState().report).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it("invokes the command with no args", async () => {
    invoke.mockResolvedValue(report());
    await refreshAgentWatchdog();
    expect(invoke).toHaveBeenCalledWith("agent_memory_watchdog");
  });
});
