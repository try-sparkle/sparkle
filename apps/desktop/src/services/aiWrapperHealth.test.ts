// @vitest-environment jsdom
// The health-reporting CONTRACT, at the wrapper level.
//
// Raised in three consecutive reviews and genuinely absent until now: every existing test for this
// exercises `chatOnce` or the exported note* helpers, so the three CACHED wrappers —
// `summarize_attention`, `generate_agent_name`, `judge_turn_followup` — had nothing pinning either
// half of their contract. Both halves could revert silently, in either direction, with the suite
// green. They flipped back and forth across four commits for exactly that reason.
//
// The contract these lock:
//   1. A SUCCESS from a cached wrapper touches NEITHER store. claude_oneshot serves a cache hit
//      before acquiring a permit or spawning anything, so the reply may never have touched the CLI;
//      reporting healthy from one would zero the failure run and mask a wedged CLI behind a banner
//      saying everything is fine.
//   2. A FAILURE from a cached wrapper DOES feed both detectors — that is the whole reason the
//      wiring exists, and wiring only some wrappers was measured to leave the detector starved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
// summarizeAttention no-ops outside Tauri. `hasTauri` is computed from `window` at module load, so
// the marker has to exist BEFORE the import below — hence the hoisted assignment rather than a mock.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= g;
  (g.window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

import { summarizeAttention } from "./attention";
import { useAiProviderStore } from "../stores/aiProviderStore";
import { HEALTHY_SERVICE, useAiServiceHealthStore } from "../stores/aiServiceHealthStore";

beforeEach(() => {
  invokeMock.mockReset();
  useAiProviderStore.setState({ outage: null });
  useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
});

afterEach(() => {
  useAiProviderStore.setState({ outage: null });
  useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
});

describe("summarizeAttention — a cached wrapper's health contract", () => {
  it("a SUCCESS leaves both stores untouched — it may have been a cache hit", () => {
    // The invariant the whole cache-hit finding is about. If this wrapper reported healthy, a
    // persistent unanswered prompt (which hits the cache on every tick, by design — see
    // attention_summary.rs) would keep zeroing the failure run of a wedged CLI.
    useAiServiceHealthStore.setState({
      ...HEALTHY_SERVICE,
      consecutiveFailures: 2,
    });
    invokeMock.mockResolvedValue("Wants you to confirm the deploy");

    return summarizeAttention("some screen").then((out) => {
      expect(out).toBe("Wants you to confirm the deploy");
      // Neither store moved: the run is intact and no outage was cleared.
      expect(useAiServiceHealthStore.getState().consecutiveFailures).toBe(2);
      expect(useAiProviderStore.getState().outage).toBeNull();
    });
  });

  it("a success does NOT clear a recorded provider outage", async () => {
    // The other direction of the same hazard: clearing a real outage on a cache hit would retire a
    // banner that is still true.
    useAiProviderStore.setState({ outage: { reason: "cli_not_authenticated", at: 1 } });
    invokeMock.mockResolvedValue("something");
    await summarizeAttention("screen");
    expect(useAiProviderStore.getState().outage?.reason).toBe("cli_not_authenticated");
  });

  it("a TIMEOUT feeds the service detector — the reason the wiring exists", async () => {
    invokeMock.mockRejectedValue("ai_timeout");
    await summarizeAttention("screen");
    expect(useAiServiceHealthStore.getState().consecutiveFailures).toBe(1);
  });

  it("a saturated pool is NEUTRAL — it must not advance or reset the run", async () => {
    // ai_busy is the concurrency cap declining to ask. It comes from the same wedged CLI as the
    // timeouts, so counting it as either would break the detector (see classifyServiceFailure).
    useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE, consecutiveFailures: 2 });
    invokeMock.mockRejectedValue("ai_busy");
    await summarizeAttention("screen");
    expect(useAiServiceHealthStore.getState().consecutiveFailures).toBe(2);
  });

  it("an auth failure records the NAMED reason and yields the service run", async () => {
    // claude_not_authenticated belongs to the named-reason banner, which tells the user what to fix.
    // The vaguer service banner must step aside rather than stack on top of it.
    useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE, consecutiveFailures: 3 });
    invokeMock.mockRejectedValue("claude_not_authenticated");
    await summarizeAttention("screen");
    expect(useAiProviderStore.getState().outage?.reason).toBe("cli_not_authenticated");
    expect(useAiServiceHealthStore.getState().consecutiveFailures).toBe(0);
  });

  it("never throws — the caller falls back to the generic notification body", async () => {
    invokeMock.mockRejectedValue("ai_timeout");
    await expect(summarizeAttention("screen")).resolves.toBeNull();
  });
});
