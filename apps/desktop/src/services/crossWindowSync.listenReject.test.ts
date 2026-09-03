/**
 * crossWindowSync — the `listen` PROMISE's own rejection must not escape unhandled (bead
 * sparkle-6csa; recurrence surfaced via the coverage-shard unhandled-rejection flake, bead
 * sparkle-kxtbdy).
 *
 * WHY A SEPARATE FILE. The sibling `crossWindowSync.test.ts` mocks `listen` to RESOLVE
 * (`Promise.resolve(() => {})`), so the branch this file exercises — a `listen` that REJECTS — is
 * unreachable there. Tauri's subscribe/unlisten are async against the webview's listeners map, so a
 * `listen` racing a teardown resolves to a REJECTED promise rather than throwing; the production
 * `void listen(...).then(...)` must carry a `.catch` or that rejection leaks on `process`'s
 * `unhandledRejection` and reddens an otherwise-passing shard.
 *
 * NON-VACUITY. The `listen` mock is forced to reject with the real teardown-race "…handlerId"
 * message, and the test asserts NO such rejection escapes unhandled. Remove the `.catch` from the
 * production call site and the un-awaited rejected promise surfaces on `process`'s
 * `unhandledRejection` → the filtered array is non-empty → this test fails. (Verified by
 * mutation.)
 *
 * PLAIN function, never a vi.fn, for the rejecting listen: a vi.fn attaches its own handler to the
 * promise it returns (for `mock.results`), which marks the rejection HANDLED — so a dropped
 * rejection would never reach `unhandledRejection` and the test would be vacuous. This mirrors
 * satelliteWindows.test.ts / agentTransport.test.ts, the two sites already fixed for this class.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A REJECTING `listen` mimicking Tauri's async subscribe hitting a torn-down listeners map.
const rejectingListen = () =>
  Promise.reject(
    new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
  );

vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: () => rejectingListen(),
}));

import { subscribeToCrossWindowSync } from "./crossWindowSync";
import { useProjectStore } from "../stores/projectStore";
import { useDictationStore } from "../stores/dictationStore";

let unsub: () => void = () => {};

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useDictationStore.setState({ enabled: true });
  localStorage.clear();
  // Minimal window shim carrying the Tauri marker so `inTauri()` is true and the `listen` branch
  // under test actually runs.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __TAURI_INTERNALS__: {},
  };
});

afterEach(() => {
  unsub();
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** Run `trigger`, then wait past node's macrotask so any un-awaited rejection is reported; return
 *  only the teardown-race ("handlerId") rejections so unrelated noise cannot flip the assertion. */
async function teardownRaceRejections(trigger: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  try {
    trigger();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", handler);
  }
  return seen.filter((r) => (r instanceof Error ? r.message : String(r)).includes("handlerId"));
}

describe("subscribeToCrossWindowSync — a rejecting listen does not leak (sparkle-6csa)", () => {
  it("swallows the async subscribe-race rejection from listen", async () => {
    expect(
      await teardownRaceRejections(() => {
        unsub = subscribeToCrossWindowSync();
      }),
    ).toHaveLength(0);
  });
});
