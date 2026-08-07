import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { applyModelToRunningAgent } from "./agentModel";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import {
  registerLineScan,
  unregisterLineScan,
  noteUserInput,
} from "../components/terminalSubmit";

const CLEAR_LINE = "\x05\x15"; // Ctrl-E + Ctrl-U — whole-line clear regardless of cursor position

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useRuntimeStore.setState({ openAgentIds: [], status: {} });
  useTerminalOverlayStore.setState({ drafts: {} });
  // A LIVE SCANNER, as a mounted Terminal would have: without one the registry falls back to
  // writing the derived flag, which is exactly the blind path these cases exist to rule out.
  registerLineScan("a1");
});

afterEach(() => {
  unregisterLineScan("a1");
});

describe("applyModelToRunningAgent (mid-session /model, sparkle-i6rw)", () => {
  it("clears the line (Ctrl-U) + types /model <id>, then Enter in a SECOND write (popup-safe)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      await vi.runAllTimersAsync();
      await p;
      expect(invoke).toHaveBeenNthCalledWith(1, "pty_write", {
        id: "a1",
        data: `${CLEAR_LINE}/model claude-opus-4-8`,
      });
      expect(invoke).toHaveBeenNthCalledWith(2, "pty_write", { id: "a1", data: "\r" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes rapid picks on the same agent — no interleaved writes (roborev 23524)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      // Both fired inside the submit-delay window; the chain must fully deliver the first
      // (text + Enter) before the second starts, so the last pick lands as its own command.
      const p1 = applyModelToRunningAgent("a1", "claude-opus-4-8");
      const p2 = applyModelToRunningAgent("a1", "claude-haiku-4-5");
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
        "\r",
        `${CLEAR_LINE}/model claude-haiku-4-5`,
        "\r",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the trailing Enter if a live question pops up DURING the submit delay", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"], status: { a1: "working" } });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      // Let the command text land, then a permission prompt appears mid-delay — the Enter
      // would confirm IT, so it must be skipped (text is left benignly in the composer).
      await vi.advanceTimersByTimeAsync(0);
      useRuntimeStore.setState({ status: { a1: "approval" } });
      await vi.runAllTimersAsync();
      await p;
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks liveness at DELIVERY time: a queued pick is dropped if the PTY closes mid-wait", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p1 = applyModelToRunningAgent("a1", "claude-opus-4-8");
      const p2 = applyModelToRunningAgent("a1", "claude-haiku-4-5");
      // Let the first delivery start (type its command, enter the submit-delay wait)…
      await vi.advanceTimersByTimeAsync(0);
      // …then the agent closes while it waits; the queued second pick must see the closed PTY
      // when its turn comes and write nothing.
      useRuntimeStore.setState({ openAgentIds: [] });
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);
      // The in-flight delivery's Enter AND the whole queued pick are dropped — the pre-Enter
      // re-check sees the closed PTY too.
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is fire-and-forget safe: a PTY write rejection is swallowed, not surfaced", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    invoke.mockRejectedValue(new Error("pty backend exploded"));
    // Must resolve (not reject) — the void call site would otherwise raise an unhandled rejection.
    await expect(applyModelToRunningAgent("a1", "claude-opus-4-8")).resolves.toBeUndefined();
  });

  it("writes nothing while the REPL shows a live question — Enter must not confirm a dialog", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"], status: { a1: "approval" } });
    await applyModelToRunningAgent("a1", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
    useRuntimeStore.setState({ status: { a1: "waiting" } });
    await applyModelToRunningAgent("a1", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes nothing when the agent has no live PTY (store-only change, applies next spawn)", async () => {
    await applyModelToRunningAgent("closed-agent", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes nothing for the 'default' sentinel (no /model unset; next spawn drops the flag)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    await applyModelToRunningAgent("a1", "default");
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ══ WHAT THIS DELIVERY DOES TO THE CLI INPUT LINE, PUBLISHED ═════════════════════════════════════
// `terminalOverlayStore.drafts[agentId]` answers "does this agent's prompt hold an unsubmitted
// line". Its other writer is xterm's `onData`, which sees only what the USER types — so this
// module's writes are invisible to it, and the flag desyncs exactly the way `pty.ts`'s did
// (roborev 59689). It matters twice here: the Ctrl-U CLEARS the user's pending line, and the Enter
// submits what replaced it. Two consumers read the flag — the terminal-anchored action pill and the
// compose-focus veto — so a stale `true` declines every compose-focus pull with the caret in this
// terminal until it unmounts.
describe("the /model delivery publishes the input line it rewrites", () => {
  it("leaves the line EMPTY after the Enter, even if the user had one pending", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    useTerminalOverlayStore.getState().setDraft("a1", true); // the user was mid-command
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(useTerminalOverlayStore.getState().drafts.a1).toBeFalsy();
  });

  it("leaves it PENDING when the Enter is skipped — the /model text is still sitting there", async () => {
    // The bail-out path: a permission prompt appears during the submit delay, so the Enter is
    // withheld and `/model …` stays on the line. That IS unsent input, and the same benign text the
    // implementation comment describes — so the flag must say so rather than reporting an empty
    // prompt the user would then lose the caret from.
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      await vi.advanceTimersByTimeAsync(0);
      useRuntimeStore.setState({ status: { a1: "approval" } });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(useTerminalOverlayStore.getState().drafts.a1).toBe(true);
    // AND IT SURVIVES THE USER'S NEXT KEYSTROKE. The publish alone did not: `Terminal.tsx`
    // recomputes the flag from the line scanner on every chunk, so an arrow key wrote `false` back
    // over it while `/model …` sat on the prompt (roborev 59742). Driving `noteUserInput` — the same
    // function that handler calls — is what makes this assertion able to fail.
    noteUserInput("a1", "\x1b[D");
    expect(useTerminalOverlayStore.getState().drafts.a1).toBe(true);
  });

  it("clears the claim when the PTY turned out to be GONE, leaving nothing stale behind", async () => {
    // `writePty` is the TOLERANT variant, so the command write above resolves even when it never
    // landed — and the dead-PTY case takes the same bail as a modal prompt. Left as-is the `true`
    // has no writer to retract it (clearDraft fires on teardown, which has already run), and agent
    // ids are stable across respawn, so the NEXT terminal for this agent would open declining every
    // compose-focus pull (roborev 59742).
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      await vi.advanceTimersByTimeAsync(0);
      useRuntimeStore.setState({ openAgentIds: [] }); // the pane closed mid-delivery
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(useTerminalOverlayStore.getState().drafts.a1).toBeFalsy();
    noteUserInput("a1", "\x1b[D");
    expect(useTerminalOverlayStore.getState().drafts.a1).toBeFalsy();
  });
});
