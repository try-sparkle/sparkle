// @vitest-environment jsdom
// The roster command/event names are a contract with src-tauri/src/roster.rs. Both failure modes
// are silent by construction — getRoster ends in .catch(() => null) and onRosterChanged simply
// never fires — so a one-sided rename would quietly degrade the cross-window P0/P1 completeness
// the aggregator exists to provide, with a green suite.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn<(...a: unknown[]) => unknown>();
const listen = vi.fn<(...a: unknown[]) => Promise<() => void>>(async () => () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as unknown[])) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: unknown[]) => listen(...(a as unknown[])),
  emit: vi.fn(),
}));

describe("roster bindings inside Tauri", () => {
  let mod: typeof import("./attention");

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    mod = await import("./attention");
  });

  it("fetches the merged roster via get_roster", () => {
    void mod.getRoster();
    expect(invoke).toHaveBeenCalledWith("get_roster");
  });

  it("subscribes to roster://changed", async () => {
    await mod.onRosterChanged(() => {});
    expect(listen.mock.calls[0]?.[0]).toBe("roster://changed");
  });

  it("publishes a window slice via publish_window_roster", () => {
    mod.publishWindowRoster("main", []);
    expect(invoke).toHaveBeenCalledWith("publish_window_roster", { label: "main", projects: [] });
  });
});
