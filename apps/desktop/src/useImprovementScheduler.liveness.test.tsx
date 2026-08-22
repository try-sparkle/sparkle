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
import {
  resetImproveDutyForTests,
  useImproveDutyStore,
} from "./services/improveDutySnapshot";
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
  resetImproveDutyForTests();
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

// ── THE DOT'S FACTS RIDE THE SAME 10s BEAT ─────────────────────────────────────────────────────
//
// Same charter as the block above, for the other half of the pinned row's honesty: the RULE is
// covered by `engine/sparkleDutyPaint.test.ts` and the READER by
// `services/improveDutySnapshot.test.ts`, and neither can see whether anything calls the reader.
// Wired to the FIVE-MINUTE scheduler tick instead of this one, every assertion in both of those
// suites stays green while the dot sits up to five minutes stale — which this file's own comment
// names as the symptom rather than the fix.
describe("useImprovementScheduler publishes the pinned row's standing duty", () => {
  it("publishes a snapshot on the first liveness beat, not on the five-minute tick", async () => {
    invokeMock.mockResolvedValue({ active: false, elapsedMs: null });
    // `never` is a real hold with a real sentence, and it parks the hourly tick at its first gate —
    // so anything published here demonstrably came from the liveness beat.
    useSettingsStore.setState({ sparkleImprovementConsent: "never" });
    expect(useImproveDutyStore.getState().at).toBe(0);

    renderHook(() => useImprovementScheduler(true));
    await advance(1_500);

    expect(useImproveDutyStore.getState().hold).toBe("consent-off");
    expect(useImproveDutyStore.getState().holdText).toBeTruthy();
    expect(useImproveDutyStore.getState().at).toBeGreaterThan(0);
  });

  it("keeps republishing, so a hold that clears stops being reported within ten seconds", async () => {
    invokeMock.mockResolvedValue({ active: false, elapsedMs: null });
    useSettingsStore.setState({ sparkleImprovementConsent: "never" });

    renderHook(() => useImprovementScheduler(true));
    await advance(1_500);
    expect(useImproveDutyStore.getState().hold).toBe("consent-off");

    // The user turns consent back on, with the clock already seeded.
    useSettingsStore.setState({
      sparkleImprovementConsent: "always",
      improvementLastRunAt: Date.now() - 60_000,
    });
    await advance(11_000);

    expect(useImproveDutyStore.getState().hold).toBeNull();
    expect(useImproveDutyStore.getState().nextPassAt).not.toBeNull();
  });

  it("publishes the live pass's age from the same beat that reads the process", async () => {
    invokeMock.mockResolvedValue({ active: true, elapsedMs: 8 * 60_000 });

    renderHook(() => useImprovementScheduler(true));
    await advance(1_500);

    expect(useImproveDutyStore.getState().passElapsedMs).toBe(8 * 60_000);
  });

  it("publishes nothing in a window the scheduler is disabled in", async () => {
    renderHook(() => useImprovementScheduler(false));
    await advance(30_000);

    expect(useImproveDutyStore.getState().at).toBe(0);
  });
});
