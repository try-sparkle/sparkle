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
const startBabysitDispatcher = vi.hoisted(() =>
  vi.fn<(cfg?: unknown) => () => void>(() => stopBabysit),
);
const stopBabysit = vi.hoisted(() => vi.fn());

vi.mock("./pusherRunner", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startPusherRunner,
}));
vi.mock("./config", () => ({ getConfig, onConfigChanged }));
vi.mock("./babysitDispatcher", () => ({
  startBabysitDispatcher: (cfg?: unknown) => startBabysitDispatcher(cfg),
}));
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
  startBabysitDispatcher.mockClear();
  stopBabysit.mockClear();
  startBabysitDispatcher.mockImplementation(() => stopBabysit);
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
    // TWO subscriptions now — the Pusher policy's and the babysit switch's — and BOTH must be
    // dropped. A leaked one outlives the window: its callback keeps re-resolving state for a mount
    // that is gone, which is the failure the test below describes for the async-resolve case.
    expect(unlisten).toHaveBeenCalledTimes(2);
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
    // Both late-resolving subscriptions unlisten — see the note above on why there are two.
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(2));
  });
});

// ── THE BABYSIT KILL SWITCH MUST FAIL CLOSED (roborev 58645) ────────────────────────────────────
//
// `[babysit].enabled = false` stops a loop that spends a full Claude session per dispatch on the
// founder's own quota. Every assertion here is about the ONE direction that cannot be recovered by
// the user noticing later: the switch being honoured turning into the sweep running anyway.
describe("startPusher — the babysit switch", () => {
  it("passes enabled: false straight through", async () => {
    getConfig.mockResolvedValue({ config: { pushers: {}, babysit: { enabled: false } } });
    const { startPusher } = await freshStartPusher();
    startPusher();
    await vi.waitFor(() => expect(startBabysitDispatcher).toHaveBeenCalled());
    expect(startBabysitDispatcher.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it("a THROW on the configured-start path does NOT fall back to enabled: true", async () => {
    // The bug this pins: with `.catch` on the whole chain rather than on the read, a throw from
    // startBabysitDispatcher ran the recovery arm, which starts with NO ARGUMENT — i.e. enabled
    // defaults true — so `enabled = false` silently failed OPEN.
    getConfig.mockResolvedValue({ config: { pushers: {}, babysit: { enabled: false } } });
    startBabysitDispatcher.mockImplementation(() => {
      throw new Error("boom");
    });
    const { startPusher } = await freshStartPusher();
    startPusher();
    await vi.waitFor(() => expect(startBabysitDispatcher).toHaveBeenCalled());

    // It may be called ONCE, with the user's setting. It must never be re-called bare.
    for (const call of startBabysitDispatcher.mock.calls) {
      expect(call[0]).toMatchObject({ enabled: false });
    }
  });

  it("an UNREADABLE config starts on shipped defaults — a failed read is not a request to stop", async () => {
    // The opposite direction, stated so the fix above cannot be "never start on error": the sweep
    // is compiled into this build, and a read that errored is not a user switching it off.
    getConfig.mockRejectedValue(new Error("no backend"));
    const { startPusher } = await freshStartPusher();
    startPusher();
    await vi.waitFor(() => expect(startBabysitDispatcher).toHaveBeenCalled());
    expect(startBabysitDispatcher.mock.calls[0]?.[0]).toEqual({});
  });

  it("a LIVE config change to enabled: false restarts the sweep with the switch off", async () => {
    getConfig.mockResolvedValue({ config: { pushers: {}, babysit: { enabled: true } } });
    const { startPusher } = await freshStartPusher();
    startPusher();
    await vi.waitFor(() => expect(startBabysitDispatcher).toHaveBeenCalled());

    // Drive the subscription the way the ⋯ Advanced panel would. There are TWO subscriptions —
    // the Pusher policy's and the babysit switch's — and this asserts the babysit one exists rather
    // than indexing blindly, so a future reorder fails here instead of silently testing the wrong
    // callback and passing.
    await vi.waitFor(() => expect(onConfigChanged.mock.calls.length).toBe(2));
    const onChange = onConfigChanged.mock.calls.at(-1)?.[0] as (eff: unknown) => void;
    onChange({ config: { pushers: {}, babysit: { enabled: false } } });

    expect(stopBabysit).toHaveBeenCalled();
    const last = startBabysitDispatcher.mock.calls.at(-1);
    expect(last?.[0]).toMatchObject({ enabled: false });
  });
});
