// `killPty` MUST DISPATCH `pty_kill` SYNCHRONOUSLY (roborev 61714).
//
// `SatelliteApp`'s teardown budgets `CLOSE_SETTLE_MS` (250ms) for exactly ONE round-trip before the
// webview is `destroy()`ed, and `Terminal`'s cleanup is `void`-ed so nothing awaits it. Any `await`
// placed in front of the `pty_kill` invoke moves it into a `.then` continuation that is torn down
// with the JS context if the first call has not resolved — and the PTY is then never killed at all,
// leaving an orphaned child with nothing holding a handle to it. A version of this function briefly
// did exactly that (it awaited `agent_life_retire` first), which is what these pin.
//
// The agent-life bookkeeping a deliberate stop needs now happens INSIDE `pty_kill` on the Rust side
// (`pty.rs::mark_stopped_before_kill`), where the ordering is guaranteed without a second
// round-trip; `agent_life.rs::a_deliberately_stopped_agent_is_neither_reaped_nor_reapable` asserts
// what that write buys. These assert the FRONTEND half: one command, issued now.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ cmd: string; args: unknown }> = [];
const invokeMock = vi.fn(async (cmd: string, args: unknown) => {
  calls.push({ cmd, args });
  return undefined;
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invokeMock(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { killPty } = await import("./pty");

describe("killPty dispatch", () => {
  beforeEach(() => {
    calls.length = 0;
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      return undefined;
    });
  });

  it("issues pty_kill SYNCHRONOUSLY — before any microtask can run", () => {
    // Deliberately NOT awaited: this is the state the webview is in at `destroy()` time. An
    // implementation that awaits anything first has issued only that first command by now, so this
    // assertion fails — which is precisely the regression.
    const pending = killPty("agent-1");

    expect(calls.map((c) => c.cmd)).toEqual(["pty_kill"]);
    expect(calls[0]?.args).toEqual({ id: "agent-1" });
    return pending;
  });

  it("issues exactly one command, ever — the retire moved to Rust", async () => {
    await killPty("agent-2");

    expect(calls.map((c) => c.cmd)).toEqual(["pty_kill"]);
    // A second round-trip is what the 250ms budget cannot afford. If a future change needs more
    // agent-life bookkeeping on a deliberate stop, it belongs inside `pty_kill`, not in front of it.
    expect(calls.some((c) => c.cmd === "agent_life_retire")).toBe(false);
  });

  it("propagates a real pty_kill failure rather than swallowing it", async () => {
    // Silently reporting success for a process that is still running is how a user ends up with an
    // agent they believe is stopped.
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "pty_kill") throw new Error("boom");
      return undefined;
    });

    await expect(killPty("agent-3")).rejects.toThrow("boom");
  });
});
