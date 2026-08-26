// The REAL tray backend, with nothing injected (bead sparkle-uz87.9).
//
// `tray.test.ts` injects a `TrayBackend`, which leaves `defaultTrayBackend()` — the line that turns
// a derived status into an actual menu-bar icon — covered by nothing. This file pins it. The two
// things it asserts are the two things a typecheck cannot see: the Tauri command NAME and the
// ARGUMENT KEY, both matched by name at runtime, where a mismatch is a silent no-op rather than an
// error.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { defaultTrayBackend, syncTray } from "./tray";
import type { SessionSnapshot } from "../sparkleSession";

const LISTENING: SessionSnapshot = {
  state: "listening",
  generation: 1,
  muted: false,
  heard: "what is the fleet doing",
};

beforeEach(() => invoke.mockReset());

describe("defaultTrayBackend — the real host call", () => {
  it("syncTray with NO injected backend reaches the host command", async () => {
    invoke.mockResolvedValue(true);

    // No second argument: this is the production path, defaults and all.
    const r = await syncTray({ enabled: true, snapshot: LISTENING });

    expect(invoke).toHaveBeenCalledWith("overlay_tray_sync", { status: "listening" });
    expect(r.installed).toBe(true);
  });

  it("forwards the derived status, so a disabled overlay never asks for a listening icon", async () => {
    invoke.mockResolvedValue(false);

    const r = await syncTray({ enabled: false, snapshot: LISTENING });

    // The wire value is the serde snake_case name `overlay_tray.rs` deserialises.
    expect(invoke).toHaveBeenCalledWith("overlay_tray_sync", { status: "disabled" });
    expect(r.installed).toBe(false);
  });

  it("gateOpen asks the host, because the gate is the host's and fails closed there", async () => {
    invoke.mockResolvedValue(false);
    await expect(defaultTrayBackend().gateOpen()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("overlay_tray_gate_open");
  });
});
