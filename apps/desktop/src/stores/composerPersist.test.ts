import { describe, it, expect } from "vitest";
import { migratePersistedUi, OLD_COMPOSER_DEFAULT } from "./composerPersist";

const SNAP = 72;

describe("migratePersistedUi", () => {
  it("v0 → resets the stale old default height to the snap height", () => {
    const out = migratePersistedUi({ composerHeight: OLD_COMPOSER_DEFAULT }, 0, SNAP);
    expect(out?.composerHeight).toBe(SNAP);
  });

  it("v0 → leaves a deliberately-dragged height untouched", () => {
    const out = migratePersistedUi({ composerHeight: 300 }, 0, SNAP);
    expect(out?.composerHeight).toBe(300);
  });

  it("does not touch state already at/after v1", () => {
    const out = migratePersistedUi({ composerHeight: OLD_COMPOSER_DEFAULT }, 1, SNAP);
    expect(out?.composerHeight).toBe(OLD_COMPOSER_DEFAULT);
  });

  it("passes through undefined persisted state", () => {
    expect(migratePersistedUi(undefined, 0, SNAP)).toBeUndefined();
  });

  it("preserves other fields while migrating", () => {
    const out = migratePersistedUi(
      { composerHeight: OLD_COMPOSER_DEFAULT, zoom: 1.2, composerMinimized: true },
      0,
      SNAP,
    );
    expect(out).toMatchObject({ composerHeight: SNAP, zoom: 1.2, composerMinimized: true });
  });
});
