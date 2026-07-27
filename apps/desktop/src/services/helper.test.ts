// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn<(...a: unknown[]) => unknown>();
const listen = vi.fn<(...a: unknown[]) => Promise<() => void>>(async () => () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...(a as unknown[])) }));

import {
  publishHelperVitals, getHelperVitals, setHelperBounds, showHelper, hideHelper,
  onHelperVitalsChanged, onFrontmostChanged, onCaptureRequested,
} from "./helper";

// jsdom has no __TAURI_INTERNALS__, so every binding must no-op rather than throw. This is the
// contract that lets the island's components be rendered in plain unit tests.
describe("helper bindings outside Tauri", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockClear();
    // These bindings captured `hasTauri` at module load, before any test set the flag.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("publishHelperVitals does not invoke", () => {
    publishHelperVitals(3, 7);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("getHelperVitals resolves null", async () => {
    await expect(getHelperVitals()).resolves.toBeNull();
  });

  it("setHelperBounds, showHelper, hideHelper do not invoke", () => {
    setHelperBounds(1, 2, 3, 4);
    showHelper();
    hideHelper();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("subscriptions resolve to a callable no-op unlisten", async () => {
    const un1 = await onHelperVitalsChanged(() => {});
    const un2 = await onFrontmostChanged(() => {});
    const un3 = await onCaptureRequested(() => {});
    expect(() => { un1(); un2(); un3(); }).not.toThrow();
    expect(listen).not.toHaveBeenCalled();
  });
});

// The Tauri path. Command names, argument shapes, and event names are a contract with helper.rs
// and frontmost.rs; every call site swallows rejections into console.debug, so a typo on either
// side compiles, passes the no-op tests above, and fails silently in the shipped app.
describe("helper bindings inside Tauri", () => {
  let mod: typeof import("./helper");

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockClear();
    (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    mod = await import("./helper");
  });

  it("publishes vitals as publish_helper_vitals { needsYou, running }", () => {
    mod.publishHelperVitals(3, 7);
    // camelCase on the wire: the Rust Vitals struct carries #[serde(rename_all = "camelCase")],
    // and a mismatch here renders `undefined` on the island with no type error on either side.
    expect(invoke).toHaveBeenCalledWith("publish_helper_vitals", { needsYou: 3, running: 7 });
  });

  it("seeds vitals via get_helper_vitals", () => {
    void mod.getHelperVitals();
    expect(invoke).toHaveBeenCalledWith("get_helper_vitals");
  });

  it("seeds frontmost via get_frontmost", () => {
    void mod.getFrontmost();
    expect(invoke).toHaveBeenCalledWith("get_frontmost");
  });

  it("moves and resizes as set_helper_bounds { x, y, width, height }", () => {
    mod.setHelperBounds(10, 20, 268, 44);
    expect(invoke).toHaveBeenCalledWith("set_helper_bounds", { x: 10, y: 20, width: 268, height: 44 });
  });

  it("shows and hides via show_helper / hide_helper", () => {
    mod.showHelper();
    expect(invoke).toHaveBeenCalledWith("show_helper");
    mod.hideHelper();
    expect(invoke).toHaveBeenCalledWith("hide_helper");
  });

  it("subscribes to the exact event names Rust emits", async () => {
    await mod.onHelperVitalsChanged(() => {});
    await mod.onFrontmostChanged(() => {});
    await mod.onCaptureRequested(() => {});
    const events = listen.mock.calls.map((c) => c[0]);
    expect(events).toEqual([
      "helper://vitals-changed",
      "app://frontmost-changed",
      "helper://capture-requested",
    ]);
  });
});
