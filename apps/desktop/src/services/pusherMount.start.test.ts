// THE BINDING ITSELF (roborev 57705). `pusherMount.test.ts` covers what the deps DO; this covers
// whether the sweep is ever started and whether its policy ever becomes enabled.
//
// WHY IT NEEDS ITS OWN FILE AND ITS OWN ASSERTIONS. The whole premise of this feature is that the
// decision core was correct and the BINDING was missing — the Pusher existed, was tested as
// arithmetic, and had no production caller for the whole of its life. `policy` starts at
// `PUSHERS_DISABLED` and is only lifted by a promise chain, so a renamed `eff.config.pushers`, a
// rejected `getConfig`, or a dropped `startPusher()` call returns the app to EXACTLY the state this
// work exists to fix — a Pusher that sweeps and refuses everything — with the entire suite green.
// That failure is silent by construction, which is the only kind worth a dedicated test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES_PER_HOUR } from "@sparkle/core";

const startPusherRunner = vi.hoisted(() =>
  vi.fn<(deps: unknown, intervalMs: number) => () => void>(() => stopRunner),
);
const stopRunner = vi.hoisted(() => vi.fn());
const getConfig = vi.hoisted(() => vi.fn());
const onConfigChanged = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("./pusherRunner", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startPusherRunner,
}));
vi.mock("./config", () => ({ getConfig, onConfigChanged }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import type { PusherRunnerDeps } from "./pusherRunner";

/**
 * A FRESH MODULE PER TEST, and this is not boilerplate.
 *
 * `policy` is module-level and starts at `PUSHERS_DISABLED`, so a test that ran after one which
 * enabled it would observe the previous test's value. That does not merely fail — it makes the
 * failure-path tests VACUOUS: "stays disabled when the config cannot be read" would pass because
 * some earlier test happened to leave it disabled, not because this one did anything. Resetting the
 * registry is what makes each assertion about the code under test.
 */
async function freshStartPusher() {
  vi.resetModules();
  return (await import("./pusherMount")) as typeof import("./pusherMount");
}

/** The deps object `startPusher` handed to the runner. */
const handedOver = (): PusherRunnerDeps =>
  startPusherRunner.mock.calls[0]![0] as PusherRunnerDeps;

beforeEach(() => {
  startPusherRunner.mockClear();
  stopRunner.mockClear();
  unlisten.mockClear();
  getConfig.mockResolvedValue({ config: { pushers: {} } });
  onConfigChanged.mockResolvedValue(unlisten);
});
afterEach(() => vi.clearAllMocks());

describe("startPusher — the sweep is actually started", () => {
  it("starts the runner, at the tick the module names", async () => {
    const { startPusher, MIN_TICK_MS } = await freshStartPusher();
    const stop = startPusher();
    expect(startPusherRunner).toHaveBeenCalledTimes(1);
    expect(startPusherRunner.mock.calls[0]![1]).toBe(MIN_TICK_MS);
    stop();
  });

  it("waking every minute is the point — a slower tick would delay every finding", async () => {
    const { MIN_TICK_MS } = await freshStartPusher();
    expect(MIN_TICK_MS).toBe(60_000);
  });

  it("ENABLES the policy once the config resolves — this is the silent-failure case", async () => {
    const { startPusher } = await freshStartPusher();
    // Asserts the SIDE EFFECT (a policy that permits speech), not that getConfig was called. Before
    // the promise settles the Pusher is deliberately disabled; if it never settles, or the payload
    // path is wrong, it stays that way forever and sweeps to no effect.
    const stop = startPusher();
    expect(handedOver().policy().enabled).toBe(false);

    await vi.waitFor(() => expect(handedOver().policy().enabled).toBe(true));
    expect(handedOver().policy().messagesPerHour).toBe(MESSAGES_PER_HOUR);
    stop();
  });

  it("reads the payload from where Rust actually puts it", async () => {
    const { startPusher } = await freshStartPusher();
    // The exact break the reviewer named: `eff.pushers` vs `eff.config.pushers`. A wrong path is not
    // a type error at runtime, it is `undefined`, and `resolvePusherPolicy(undefined)` is DISABLED.
    getConfig.mockResolvedValue({ config: { pushers: { enabled: false } } });
    const stop = startPusher();
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(handedOver().policy().enabled).toBe(false);
    stop();
  });

  it("follows a config change without a restart", async () => {
    const { startPusher } = await freshStartPusher();
    const stop = startPusher();
    await vi.waitFor(() => expect(handedOver().policy().enabled).toBe(true));

    const cb = onConfigChanged.mock.calls[0]![0] as (eff: unknown) => void;
    cb({ config: { pushers: { enabled: "off" } } });
    expect(handedOver().policy().enabled).toBe(false);
    stop();
  });

  it("stays disabled — never crashes — when the config cannot be read", async () => {
    getConfig.mockRejectedValue(new Error("bridge request timeout: get_config"));
    const { startPusher } = await freshStartPusher();
    const stop = startPusher();
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(handedOver().policy().enabled).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it("the stopper stops the sweep AND drops the config listener", async () => {
    const { startPusher } = await freshStartPusher();
    const stop = startPusher();
    await vi.waitFor(() => expect(onConfigChanged).toHaveBeenCalled());
    stop();
    expect(stopRunner).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens even when the subscription resolves AFTER the stopper ran", async () => {
    const { startPusher } = await freshStartPusher();
    // A window closed during boot. Without the `stopped` latch this leaks a listener for the life
    // of the process, and the next window's sweep is driven by a dead one's callback too.
    let resolveSub: (fn: () => void) => void = () => {};
    onConfigChanged.mockReturnValue(new Promise<() => void>((r) => (resolveSub = r)));
    const stop = startPusher();
    stop();
    resolveSub(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
