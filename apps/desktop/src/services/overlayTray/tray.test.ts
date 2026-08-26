// The tray actually reaching a menu bar (bead sparkle-uz87.9).
//
// These tests are about the WIRING, not the mapping — `trayStatus.test.ts` owns the mapping. What
// is asserted here is the side effect: the host received the DERIVED status, and what the caller
// reports back is what the HOST said happened, not what the frontend hoped for.
import { describe, expect, it } from "vitest";
import { syncTray, type TrayBackend } from "./tray";
import type { SessionSnapshot } from "../sparkleSession";

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { state: "idle", generation: 0, muted: false, heard: "", ...over };
}

function backend(installed: boolean) {
  const seen: string[] = [];
  const b: TrayBackend = {
    sync: async (status) => {
      seen.push(`sync:${status}`);
      return installed;
    },
    gateOpen: async () => installed,
  };
  return { backend: b, seen };
}

describe("syncTray", () => {
  it("publishes the DERIVED status to the host, not the raw session state", async () => {
    const { backend: b, seen } = backend(true);
    // `processing` is a state the tray must NOT render as "listening" — the derivation collapses it
    // to `working`. Asserting on what the host received is what proves the derivation is in the
    // path at all; a wiring that forwarded `snapshot.state` verbatim would pass a shape check.
    const r = await syncTray({ enabled: true, snapshot: snapshot({ state: "processing" }) }, b);
    expect(seen).toEqual(["sync:working"]);
    expect(r.status).toBe("working");
    expect(r.tooltip).toBe("Sparkle overlay: thinking");
  });

  it("still asks the host when the feature is disabled, and says so in words", async () => {
    const { backend: b, seen } = backend(false);
    const r = await syncTray({ enabled: false, snapshot: snapshot({ state: "listening" }) }, b);
    // A disabled overlay may never publish `listening`, whatever the snapshot says.
    expect(seen).toEqual(["sync:disabled"]);
    expect(r.status).toBe("disabled");
    expect(r.tooltip).toBe("Sparkle overlay: off");
  });

  it("reports what the HOST said, not what the caller intended", async () => {
    // The gate lives in Rust and fails closed. A frontend that believes the overlay is enabled
    // must still report `installed: false` when the host declined — otherwise the frontend's
    // belief, rather than the menu bar, becomes the thing callers trust.
    const declining: TrayBackend = { sync: async () => false, gateOpen: async () => false };
    const r = await syncTray({ enabled: true, snapshot: snapshot({ state: "listening" }) }, declining);
    expect(r.status).toBe("listening");
    expect(r.installed).toBe(false);

    // PAIRED positive: the same inputs against a host that accepted DO report installed, so the
    // assertion above is a real negative and not a field hardcoded to false.
    const accepting: TrayBackend = { sync: async () => true, gateOpen: async () => true };
    expect(
      (await syncTray({ enabled: true, snapshot: snapshot({ state: "listening" }) }, accepting))
        .installed,
    ).toBe(true);
  });
});
