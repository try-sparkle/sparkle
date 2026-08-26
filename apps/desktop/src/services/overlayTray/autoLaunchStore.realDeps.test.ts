// The REAL auto-launch wiring, with NOTHING injected (bead sparkle-uz87.9).
//
// WHY THIS FILE EXISTS SEPARATELY. Every test in `autoLaunch.test.ts` supplies its own
// `AutoLaunchStore` — which is what makes those tests fast, and also what would leave
// `defaultAutoLaunchStore()` covered by nothing at all. That is a known way to ship a dead feature
// in this repo (`sparkle-lgbwf`, seen 4x): delete the line supplying the real value and the suite
// stays green while nothing ever reaches the operating system. The whole point of bead .9's
// auto-launch half is that a LaunchAgent gets written, so the assertion below is not "a preference
// was stored" — it is "the OS registration command was invoked, and it was invoked BEFORE the
// preference was persisted".
//
// Only the Tauri IPC boundary is mocked, because a vitest process has no Tauri host. Everything on
// this side of it — the store, the ordering rule, the tri-state parse — is the shipping code.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  AUTO_LAUNCH_IS_ENABLED_COMMAND,
  AUTO_LAUNCH_PREFERENCE_KEY,
  AUTO_LAUNCH_SET_COMMAND,
  defaultAutoLaunchStore,
  osAutoLaunchRegistered,
  setAutoLaunchPreference,
} from "./autoLaunchStore";
import { parseAutoLaunchPreference } from "./autoLaunch";

/**
 * One ordered log of everything that left the module: IPC calls and storage writes interleaved.
 * The ORDER is the assertion — two separate spies could each be satisfied while the writes
 * happened in the wrong sequence, which is precisely the bug the ordering rule exists to prevent.
 */
function recordOrder(): string[] {
  const order: string[] = [];
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    order.push(`invoke:${cmd}:${JSON.stringify(args ?? {})}`);
    return undefined;
  });
  const real = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((k: string, v: string) => {
    order.push(`store:${k}=${v}`);
    real(k, v);
  });
  return order;
}

beforeEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  localStorage.removeItem(AUTO_LAUNCH_PREFERENCE_KEY);
});

describe("defaultAutoLaunchStore — the real OS registration", () => {
  it("REGISTERS WITH THE OS, and does it before persisting the preference", async () => {
    const order = recordOrder();

    await setAutoLaunchPreference(true);

    // The side effect, not the precondition. An OS call had to happen, with the right command name
    // and the right argument key — both matched by NAME at runtime, so nothing else can catch a
    // typo here — and it had to happen FIRST.
    expect(order).toEqual([
      `invoke:${AUTO_LAUNCH_SET_COMMAND}:{"enable":true}`,
      `store:${AUTO_LAUNCH_PREFERENCE_KEY}=on`,
    ]);
  });

  it("unregisters through the OS as well, in the same order", async () => {
    localStorage.setItem(AUTO_LAUNCH_PREFERENCE_KEY, "on");
    const order = recordOrder();

    await setAutoLaunchPreference(false);

    expect(order).toEqual([
      `invoke:${AUTO_LAUNCH_SET_COMMAND}:{"enable":false}`,
      `store:${AUTO_LAUNCH_PREFERENCE_KEY}=off`,
    ]);
  });

  it("persists NOTHING when the OS registration fails", async () => {
    invoke.mockRejectedValue(new Error("launchd refused"));

    await expect(setAutoLaunchPreference(true)).rejects.toThrow("launchd refused");

    // A stored "on" with no LaunchAgent behind it is a setting that lies, which is worse than no
    // setting at all — so the preference must still read as never-answered.
    expect(localStorage.getItem(AUTO_LAUNCH_PREFERENCE_KEY)).toBeNull();
    expect(parseAutoLaunchPreference(localStorage.getItem(AUTO_LAUNCH_PREFERENCE_KEY))).toBe(
      "unknown",
    );
  });

  it("reads the preference back out of real storage, tri-state intact", async () => {
    const store = defaultAutoLaunchStore();
    // Never asked.
    expect(parseAutoLaunchPreference(await store.read())).toBe("unknown");
    // Answered.
    await store.write("on");
    expect(parseAutoLaunchPreference(await store.read())).toBe("on");
    expect(localStorage.getItem(AUTO_LAUNCH_PREFERENCE_KEY)).toBe("on");
  });

  it("a storage read that THROWS is unknown, never a silent off", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const store = defaultAutoLaunchStore();
    await expect(store.read()).resolves.toBeUndefined();
    expect(parseAutoLaunchPreference(await store.read())).toBe("unknown");
  });

  it("asks the OS what it actually has registered", async () => {
    invoke.mockResolvedValue(true);
    await expect(osAutoLaunchRegistered()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(AUTO_LAUNCH_IS_ENABLED_COMMAND);
  });
});
