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

// The repair must NOT be version-gated: uiStore's merge is shallow, so a persisted statusFilter
// replaces the default wholesale. A user already at the current version must still have a missing
// band healed, or adding a band later silently hides its rows for everyone (roborev 53411).
describe("migratePersistedUi — the filter repair is not version-gated", () => {
  it("repairs a short filter even for a blob already at the CURRENT version", () => {
    const out = migratePersistedUi({ statusFilter: { needs_you: true } }, 2, 72) as {
      statusFilter: Record<string, boolean>;
    };
    expect(Object.keys(out.statusFilter).sort()).toEqual(STATUS_BANDS.map((b) => b.id).sort());
    expect(out.statusFilter.running).toBe(true);
    expect(out.statusFilter.done).toBe(true);
  });

  it("still preserves a deliberately-hidden band at the current version", () => {
    const out = migratePersistedUi({ statusFilter: { needs_you: true, running: true, done: false } }, 2, 72) as {
      statusFilter: Record<string, boolean>;
    };
    expect(out.statusFilter.done).toBe(false);
  });

  it("gives a blob with no filter at all a complete, all-visible one", () => {
    const out = migratePersistedUi({ composerHeight: 90 }, 2, 72) as {
      statusFilter: Record<string, boolean>;
    };
    for (const b of STATUS_BANDS) expect(out.statusFilter[b.id]).toBe(true);
  });
});

// THE RETIRED `activeSpecial: "board"`. Unlike the transient keys, `activeSpecial` is PERSISTED
// (deliberately absent from uiStore's TRANSIENT_UI_KEYS), and it used to carry a third value. The
// Plan board became per-column state (`workModeBySide`), so a blob written before that change
// carries a view nothing renders — and it merges back in as a TRUTHY value that nothing clears
// (`openProjectTab` only clears "sparkle"). Every consequence is silent: no sidebar row reads as
// selected, `reconcileWorkMode` is permanently neutered, and `capture_agent` refuses every
// screenshot with `special-view-showing: "board"` until the user happens to press Build.
describe("migratePersistedUi — the retired activeSpecial: \"board\"", () => {
  it("maps a persisted \"board\" to null", () => {
    const out = migratePersistedUi({ activeSpecial: "board" }, 2, 72) as { activeSpecial: unknown };
    expect(out.activeSpecial).toBeNull();
  });

  it("preserves \"sparkle\", which this build still renders", () => {
    const out = migratePersistedUi({ activeSpecial: "sparkle" }, 2, 72) as { activeSpecial: unknown };
    expect(out.activeSpecial).toBe("sparkle");
  });

  it("leaves an explicit null alone", () => {
    const out = migratePersistedUi({ activeSpecial: null }, 2, 72) as { activeSpecial: unknown };
    expect(out.activeSpecial).toBeNull();
  });

  // Not version-gated, same reasoning as the filter repair above: the blob can be written by ANY
  // build (a partial rollout, a downgrade, a hand edit), so "this ran once at v2→v3" is a weaker
  // guarantee than "whatever is on disk, what we hydrate is something we render".
  it("repairs it even for a blob already at the CURRENT version", () => {
    const out = migratePersistedUi({ activeSpecial: "board" }, 2, 72) as { activeSpecial: unknown };
    expect(out.activeSpecial).toBeNull();
  });

  // A blob that never carried the key must not GAIN one — the store default already answers null,
  // and inventing keys here would defeat uiStore's "unknown keys pass through untouched" contract.
  it("does not add the key to a blob that never had it", () => {
    const out = migratePersistedUi({ composerHeight: 90 }, 2, 72) as Record<string, unknown>;
    expect("activeSpecial" in out).toBe(false);
  });
});
