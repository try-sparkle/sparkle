import { describe, it, expect } from "vitest";
import { migratePersistedUi, OLD_COMPOSER_DEFAULT } from "./composerPersist";
import { STATUS_BANDS } from "../engine/buildSections";

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

// The band list the migration repairs against must BE the band list the app renders. It used to be
// a hand-written second copy, justified by a comment claiming this very assertion existed — it did
// not. Add a fourth band to STATUS_BANDS and, without this, the migration keeps emitting a 3-key
// filter, the new band hydrates `undefined` → falsy, and its rows vanish from the Build column with
// no visible cause (roborev 53371).
describe("migratePersistedUi — statusFilter repair covers every band", () => {
  it("repairs to exactly the bands STATUS_BANDS declares", () => {
    const out = migratePersistedUi({ statusFilter: {} }, 1, 72) as {
      statusFilter: Record<string, boolean>;
    };
    expect(Object.keys(out.statusFilter).sort()).toEqual(STATUS_BANDS.map((b) => b.id).sort());
  });

  it("defaults an unknown-shaped band to VISIBLE, never hidden", () => {
    // The safe direction: showing a row the user filtered out is a minor annoyance they can re-hide;
    // hiding one they expected to see looks like data loss.
    const out = migratePersistedUi(
      { statusFilter: { needs_you: "yes", running: null } },
      1,
      72,
    ) as { statusFilter: Record<string, boolean> };
    for (const b of STATUS_BANDS) expect(out.statusFilter[b.id]).toBe(true);
  });

  it("preserves a band the user genuinely hid", () => {
    const out = migratePersistedUi({ statusFilter: { done: false } }, 1, 72) as {
      statusFilter: Record<string, boolean>;
    };
    expect(out.statusFilter.done).toBe(false);
    expect(out.statusFilter.needs_you).toBe(true);
  });
});
