// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  useHelperPrefs, migrateHelperPrefs, HELPER_PREFS_KEY, HELPER_PREFS_VERSION,
} from "./helperPrefs";

const DEFAULTS = { enabled: true, mode: "island", x: null, y: null, edge: "right" };

function reset() {
  localStorage.clear();
  useHelperPrefs.setState(DEFAULTS as never);
}

describe("helperPrefs", () => {
  beforeEach(reset);

  it("defaults to an enabled island with no remembered position", () => {
    const s = useHelperPrefs.getState();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe("island");
    expect(s.x).toBeNull();
    expect(s.y).toBeNull();
  });

  it("setEnabled(false) records the hidden preference", () => {
    useHelperPrefs.getState().setEnabled(false);
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });

  // The native menu handler runs in Rust and cannot read this store, so it can only ask for a flip.
  // A setter would need Rust to hold its own copy of the value, which is exactly the second source
  // of truth this design avoids.
  it("toggleEnabled flips the flag in both directions", () => {
    useHelperPrefs.getState().toggleEnabled();
    expect(useHelperPrefs.getState().enabled).toBe(false);
    useHelperPrefs.getState().toggleEnabled();
    expect(useHelperPrefs.getState().enabled).toBe(true);
  });

  it("setMode switches between island and tab", () => {
    useHelperPrefs.getState().setMode("tab");
    expect(useHelperPrefs.getState().mode).toBe("tab");
    useHelperPrefs.getState().setMode("island");
    expect(useHelperPrefs.getState().mode).toBe("island");
  });

  it("setPosition records both coordinates", () => {
    useHelperPrefs.getState().setPosition(120, 340);
    expect(useHelperPrefs.getState()).toMatchObject({ x: 120, y: 340 });
  });

  it("setEdge records the docked edge", () => {
    useHelperPrefs.getState().setEdge("left");
    expect(useHelperPrefs.getState().edge).toBe("left");
  });

  it("writes through to localStorage under the shared key, stamped with the version", () => {
    useHelperPrefs.getState().setMode("tab");
    const raw = localStorage.getItem(HELPER_PREFS_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.mode).toBe("tab");
    // Without the stamp the migration below would re-run on every hydrate and keep clearing a
    // deliberate hide — the persisted dismissal would silently never survive a restart.
    expect(JSON.parse(raw!).version).toBe(HELPER_PREFS_VERSION);
  });

  // THE STALE-RECORD COLLISION (roborev 53791-M). §6 deleted `enabled` from the type and the initial
  // state but left every persisted record alone, so an installation that used the old Hide Helper
  // still carries `enabled: false` — merged back by `persist` on every hydrate as an unread extra
  // key. Reintroducing the field makes that value load-bearing again, and the user would come back
  // from an upgrade to an invisible island because of a click made in a different version.
  //
  // Policy: EVERYONE STARTS VISIBLE. The migration drops any pre-version-1 `enabled` so the initial
  // `true` wins, and only a hide performed after this change persists.
  describe("migrateHelperPrefs", () => {
    it("drops a stale `enabled: false` written before the flag came back", () => {
      const stale = { enabled: false, mode: "tab", x: 10, y: 20, edge: "left" };
      const migrated = migrateHelperPrefs(stale, 0) as Record<string, unknown>;
      expect("enabled" in migrated).toBe(false);
      // Everything else the user chose is theirs to keep — only the dismissal is discarded.
      expect(migrated).toMatchObject({ mode: "tab", x: 10, y: 20, edge: "left" });
    });

    it("drops a stale `enabled: true` too, so the version is the only thing consulted", () => {
      const migrated = migrateHelperPrefs({ enabled: true, mode: "island" }, 0);
      expect("enabled" in (migrated as object)).toBe(false);
    });

    it("leaves a current-version record alone, so a deliberate hide survives a restart", () => {
      const record = { enabled: false, mode: "island" };
      expect(migrateHelperPrefs(record, HELPER_PREFS_VERSION)).toEqual(record);
    });

    it("does not mutate the record it was handed", () => {
      const stale = { enabled: false, mode: "island" };
      migrateHelperPrefs(stale, 0);
      expect(stale.enabled).toBe(false);
    });

    it("survives a non-object persisted blob", () => {
      expect(migrateHelperPrefs(null, 0)).toBeNull();
      expect(migrateHelperPrefs("junk", 0)).toBe("junk");
    });
  });

  // End to end through `persist`, not just the pure function: the wiring (version + migrate) is
  // what actually protects the upgrade, and it is one deleted option away from being inert.
  it("hydrating a pre-upgrade record leaves the island VISIBLE", async () => {
    localStorage.setItem(
      HELPER_PREFS_KEY,
      // version 0 is what every record written before this change carries.
      JSON.stringify({ state: { ...DEFAULTS, enabled: false, mode: "tab" }, version: 0 }),
    );
    await useHelperPrefs.persist.rehydrate();
    expect(useHelperPrefs.getState().enabled).toBe(true);
    // …while the rest of that record is still honoured.
    expect(useHelperPrefs.getState().mode).toBe("tab");
  });

  it("hydrating a post-upgrade hide keeps the island hidden", async () => {
    localStorage.setItem(
      HELPER_PREFS_KEY,
      JSON.stringify({
        state: { ...DEFAULTS, enabled: false },
        version: HELPER_PREFS_VERSION,
      }),
    );
    await useHelperPrefs.persist.rehydrate();
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });

  // This record is shared BY ORIGIN, so a second document of the same origin can write it. zustand's
  // persist writes localStorage but does not listen to it, so without the storage-event bridge every
  // other webview holds a stale copy until it reloads.
  it("rehydrates when another webview writes the shared key", async () => {
    useHelperPrefs.getState().setEnabled(false);
    expect(useHelperPrefs.getState().enabled).toBe(false);

    // Simulate the OTHER webview writing, then the browser delivering its storage event here.
    localStorage.setItem(
      HELPER_PREFS_KEY,
      JSON.stringify({
        state: { ...DEFAULTS, enabled: true },
        version: HELPER_PREFS_VERSION,
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: HELPER_PREFS_KEY }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useHelperPrefs.getState().enabled).toBe(true);
  });

  it("ignores storage events for unrelated keys", async () => {
    useHelperPrefs.getState().setEnabled(false);
    localStorage.setItem("sparkle-ui", JSON.stringify({ state: {}, version: 0 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "sparkle-ui" }));
    await Promise.resolve();
    expect(useHelperPrefs.getState().enabled).toBe(false);
  });
});
