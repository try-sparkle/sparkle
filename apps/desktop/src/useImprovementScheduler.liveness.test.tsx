// @vitest-environment jsdom
// THE WIRING, not the rule. `services/improvePassLiveness.test.ts` proves the writer does the right
// thing when it runs; this proves SOMETHING RUNS IT — the half that ships inert if the mount is
// forgotten, and the half a service-level test is structurally blind to.
//
// It drives the real hook with real timers faked, so the only thing standing between "a pass child
// is alive" and "the pinned row's status key says working" is production code. Delete the interval
// from `useImprovementScheduler` and this goes red while every other suite stays green.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { SPARKLE_AGENT_ID } from "./services/sparkleAgent";
import { resetImprovePassLiveness } from "./services/improvePassLiveness";
import { useImprovementScheduler } from "./useImprovementScheduler";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** Let the polled promise settle inside act(), so the store write lands before we read it. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  resetImprovePassLiveness();
  useRuntimeStore.setState({ openAgentIds: [], status: {} });
  // "never" parks the hourly tick at its first gate, so nothing here can start a real pass; the
  // liveness poll sits deliberately outside that gating and must run anyway.
  useSettingsStore.setState({ sparkleImprovementConsent: "never" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useImprovementScheduler mounts the row's process-truth writer", () => {
  it("turns the pinned row's status key to working while a pass child is alive", async () => {
    invokeMock.mockResolvedValue({ active: true, elapsedMs: 30_000 });

    renderHook(() => useImprovementScheduler(true));
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBeUndefined();

    await advance(1_500);

    expect(invokeMock).toHaveBeenCalledWith("sparkle_improve_active");
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("working");
  });

  it("leaves the row alone when no pass child is alive", async () => {
    invokeMock.mockResolvedValue({ active: false, elapsedMs: null });
    useRuntimeStore.setState({ status: { [SPARKLE_AGENT_ID]: "stopped" } });

    renderHook(() => useImprovementScheduler(true));
    await advance(1_500);

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("stopped");
  });

  it("keeps polling after the first reading, so a pass that starts later still turns the row green", async () => {
    invokeMock.mockResolvedValue({ active: false, elapsedMs: null });

    renderHook(() => useImprovementScheduler(true));
    await advance(1_500);
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBeUndefined();

    invokeMock.mockResolvedValue({ active: true, elapsedMs: 500 });
    await advance(11_000);

    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBe("working");
  });

  it("does not mount the writer in a window the scheduler is disabled in", async () => {
    invokeMock.mockResolvedValue({ active: true, elapsedMs: 30_000 });

    renderHook(() => useImprovementScheduler(false));
    await advance(30_000);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().status[SPARKLE_AGENT_ID]).toBeUndefined();
  });
});
