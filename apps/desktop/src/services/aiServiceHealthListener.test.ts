// The recovery path the cached wrappers could not provide. These assert the SIDE EFFECT — that a
// real spawn actually retires a degraded latch — not merely that a listener was registered.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Captures the handler `listen` was given, so a test can fire the event the way Rust would.
 *
 *  The fake `unlisten` REMOVES the handler rather than just recording the call. That detail is
 *  load-bearing: with a bare `vi.fn()` the teardown test would still be firing a handler the real
 *  Tauri bus had already detached, so it would pass no matter what `cleanup()` did. */
let handlers: Array<() => void> = [];
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: () => void) => {
    handlers.push(cb);
    return Promise.resolve(() => {
      handlers = handlers.filter((h) => h !== cb);
      unlisten();
    });
  }),
}));

import { listen } from "@tauri-apps/api/event";
import {
  AI_SPAWN_OK_EVENT,
  startAiServiceHealthListener,
} from "./aiServiceHealthListener";
import {
  AI_SERVICE_DEGRADED_THRESHOLD,
  HEALTHY_SERVICE,
  useAiServiceHealthStore,
} from "../stores/aiServiceHealthStore";

/** A latched banner: a full run of real service failures, already past the threshold. */
function degradedLatch() {
  useAiServiceHealthStore.setState({
    consecutiveFailures: AI_SERVICE_DEGRADED_THRESHOLD,
    degraded: true,
    degradedAt: Date.now(),
    reason: "unreachable",
    dismissed: false,
  });
}

beforeEach(async () => {
  handlers = [];
  unlisten.mockClear();
  vi.mocked(listen).mockClear();
  useAiServiceHealthStore.setState({ ...HEALTHY_SERVICE });
  // Tear down any singleton left by a previous test so each one arms its own listener.
  const cleanup = await startAiServiceHealthListener();
  cleanup();
  handlers = [];
  vi.mocked(listen).mockClear();
});

describe("startAiServiceHealthListener", () => {
  it("subscribes to the event name Rust emits", async () => {
    await startAiServiceHealthListener();
    expect(vi.mocked(listen)).toHaveBeenCalledWith(AI_SPAWN_OK_EVENT, expect.any(Function));
    // Pinned as a literal too: this string is a CONTRACT with claude_oneshot::AI_SPAWN_OK_EVENT,
    // and a rename on either side is silent — the listener simply never fires again.
    expect(AI_SPAWN_OK_EVENT).toBe("ai://spawn-ok");
  });

  it("CLEARS a degraded latch when a cached wrapper reports a real spawn", async () => {
    // THE POINT OF THE WHOLE CHANGE. Before this, judge/naming/attention could never report a
    // success, so a user who had switched the learned-suggestions tier off had nothing that could
    // retire this banner except the staleness expiry.
    await startAiServiceHealthListener();
    degradedLatch();
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);

    handlers.forEach((h) => h()); // Rust emitted: a real `claude` child answered

    expect(useAiServiceHealthStore.getState()).toMatchObject({
      degraded: false,
      consecutiveFailures: 0,
      reason: null,
    });
  });

  it("also ends the EPISODE, so a later distinct outage gets to speak again", async () => {
    await startAiServiceHealthListener();
    degradedLatch();
    useAiServiceHealthStore.setState({ dismissed: true });

    handlers.forEach((h) => h());

    expect(useAiServiceHealthStore.getState().dismissed).toBe(false);
  });

  it("stops reporting once torn down", async () => {
    const cleanup = await startAiServiceHealthListener();
    cleanup();
    expect(unlisten).toHaveBeenCalled();

    degradedLatch();
    handlers.forEach((h) => h()); // the handler Rust would have reached is no longer subscribed
    // The store must be untouched by a listener that has been torn down; asserting the LATCH still
    // stands is what proves the teardown did something, rather than that nothing ever fired.
    expect(useAiServiceHealthStore.getState().degraded).toBe(true);
  });

  it("registers exactly ONE subscription across repeated starts (StrictMode / HMR)", async () => {
    await startAiServiceHealthListener();
    await startAiServiceHealthListener();
    await startAiServiceHealthListener();
    expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
  });
});
