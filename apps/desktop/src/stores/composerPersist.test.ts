import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  migratePersistedUi,
  repairSendMode,
  repairZoomByColumn,
  OLD_COMPOSER_DEFAULT,
} from "./composerPersist";
import { ZOOM_COLUMNS, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from "../engine/columnZoom";
import { STATUS_BANDS } from "../engine/buildSections";
import { SEND_MODES } from "../voice/sendMode";

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
    // `themePref` rather than `zoom` as the passthrough witness: `zoom` is no longer an inert field,
    // it is what the v4 migration CONSUMES (see below), so using it here would conflate "unknown
    // keys survive" with "the zoom migration ran".
    const out = migratePersistedUi(
      { composerHeight: OLD_COMPOSER_DEFAULT, themePref: "dark", composerMinimized: true },
      0,
      SNAP,
    );
    expect(out).toMatchObject({ composerHeight: SNAP, themePref: "dark", composerMinimized: true });
  });
});

// ── v3: the auto-send SWITCH became the send TRAY's position ────────────────────────────────────
//
// This is the upgrade path, and it is the half a migration test usually skips. A fresh install is
// covered by the store's own default; what needs proving is that a blob written by the PREVIOUS
// build lands somewhere sensible. Someone who deliberately armed auto-send and then relaunched into
// a microphone-off tray would dictate, watch nothing happen, and have nothing on screen telling them
// their setting had been dropped — a silent reset is worse than a visible migration.
describe("v3 — the armed boolean becomes a tray position", () => {
  it("ARMED becomes Speak, which is the position that actually counts down", () => {
    // Not `ptt`: push-to-talk sends on a key RELEASE and runs no countdown at all, so landing an
    // upgrading user there hands them a mode they never chose and whose gesture nobody showed them.
    const out = migratePersistedUi({ conciergeAutoSend: true }, 2, SNAP);
    expect(out?.conciergeSendMode).toBe("speak");
  });

  it("DISARMED becomes Send", () => {
    const out = migratePersistedUi({ conciergeAutoSend: false }, 2, SNAP);
    expect(out?.conciergeSendMode).toBe("send");
  });

  it("drops the retired key, so a dead boolean cannot be carried forward forever", () => {
    // uiStore's merge is shallow and passes unknown keys through untouched, so without the delete
    // the old flag would sit in every blob indefinitely, contradicting the new field for anyone who
    // later moved the tray.
    const out = migratePersistedUi({ conciergeAutoSend: true }, 2, SNAP);
    expect(out && "conciergeAutoSend" in out).toBe(false);
  });

  it("leaves the mode UNSET when the blob never had the old key — the store's default applies", () => {
    const out = migratePersistedUi({ themePref: "dark" }, 2, SNAP);
    expect(out && "conciergeSendMode" in out).toBe(false);
    expect(out?.themePref).toBe("dark");
  });

  it("COERCES an unrecognised position to Send", () => {
    // Fail-closed: the mic mapping must never be handed a value it resolves to "live".
    expect(repairSendMode("shout")).toBe("send");
    expect(repairSendMode(7)).toBe("send");
    expect(repairSendMode(null)).toBe("send");
    expect(repairSendMode(undefined)).toBe("send");
  });

  it("the repair is reachable from the path that ACTUALLY runs on an ordinary launch", () => {
    // zustand runs `migrate` ONLY on a version mismatch, so a blob written by a partial rollout, a
    // hand edit, or a rolled-back future value is already at the current version and skips it
    // entirely. A repair living only in the migrator is unreachable for exactly the population it
    // names — which is what this coercion was, while its own comment and test title claimed
    // otherwise and the test called the migrator directly (roborev 56071).
    //
    // `repairActiveSpecial` and `repairStatusFilter` are both wired into uiStore's `merge` for this
    // reason. This asserts the wiring, not just the function: read the source rather than mock a
    // store rehydrate, because what regressed was a missing CALL SITE, not a broken repair.
    const uiStoreSrc = readFileSync(new URL("./uiStore.ts", import.meta.url), "utf8");
    const merge = uiStoreSrc.slice(uiStoreSrc.indexOf("merge: (persisted, current)"));
    expect(merge.slice(0, merge.indexOf("},"))).toContain("repairSendMode");
  });

  it("leaves every REAL position alone", () => {
    // The other half: a repair that clobbers valid values would pass the row above and silently
    // reset everyone to Send on launch.
    for (const m of ["send", "ptt", "speak"]) {
      expect(repairSendMode(m)).toBe(m);
    }
  });

  it("the accepted list IS the app's list — the literals here cannot drift from SEND_MODES", () => {
    // composerPersist spells the three positions as literals because a value import of
    // voice/sendMode would close a runtime cycle (it reaches components/MicButton → theme/colors,
    // and theme/theme imports uiStore, which imports this). A hand-copied list needs the pin the
    // status-band list already has: add a fourth position and, without this, the migration would
    // coerce it to Send on every launch and nothing would fail.
    for (const m of SEND_MODES) {
      expect(repairSendMode(m)).toBe(m);
    }
  });

  it("does not re-run on a blob already at v3 — a later choice is the user's to keep", () => {
    // The armed boolean can only be translated ONCE. Re-running it would take someone who upgraded,
    // moved the tray to Send, and relaunched, and put them back on Speak with a live microphone.
    const out = migratePersistedUi(
      { conciergeAutoSend: true, conciergeSendMode: "send" },
      3,
      SNAP,
    );
    expect(out?.conciergeSendMode).toBe("send");
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
    const out = migratePersistedUi({ statusFilter: { needs_you: true, questions: true, running: true, done: false } }, 2, 72) as {
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

// ── v4: THE GLOBAL ZOOM BECAME ONE LEVEL PER COLUMN ─────────────────────────────────────────────
//
// The upgrade path, which is the half a migration test usually skips. A fresh install is covered by
// the store's default; what needs proving is that a blob written by the PREVIOUS build lands
// somewhere sensible. The old `zoom` was a real preference — the text size someone had set for their
// terminals — so a migration that reset it to 1.0 would silently undo a setting with nothing on
// screen to explain it.
describe("v4 — the global zoom becomes one level per column", () => {
  it("SEEDS every column from the old global number", () => {
    const out = migratePersistedUi({ zoom: 1.4 }, 3, SNAP);
    const map = out?.zoomByColumn as Record<string, number>;
    for (const key of ZOOM_COLUMNS) expect(map[key]).toBe(1.4);
  });

  it("DELETES the retired key so `merge` cannot carry a dead global forward forever", () => {
    // The same treatment `conciergeAutoSend` got. A key left behind is one a later build can read
    // back by accident, silently overwriting the per-column levels the user has since chosen.
    const out = migratePersistedUi({ zoom: 1.4 }, 3, SNAP);
    expect(out && "zoom" in out).toBe(false);
  });

  it("falls back to the default when the old blob carried no zoom at all", () => {
    const out = migratePersistedUi({ themePref: "dark" }, 3, SNAP);
    const map = out?.zoomByColumn as Record<string, number>;
    for (const key of ZOOM_COLUMNS) expect(map[key]).toBe(ZOOM_DEFAULT);
  });

  it("clamps a corrupt or out-of-range global rather than seeding it everywhere", () => {
    expect((migratePersistedUi({ zoom: 99 }, 3, SNAP)?.zoomByColumn as Record<string, number>)["concierge"]).toBe(ZOOM_MAX);
    expect((migratePersistedUi({ zoom: -5 }, 3, SNAP)?.zoomByColumn as Record<string, number>)["concierge"]).toBe(ZOOM_MIN);
    expect((migratePersistedUi({ zoom: NaN }, 3, SNAP)?.zoomByColumn as Record<string, number>)["concierge"]).toBe(ZOOM_DEFAULT);
  });

  it("does NOT re-seed a blob already at v4 — its per-column levels are the truth", () => {
    // The mirror image of the seeding rule. `migrate` is skipped for a blob at the current version
    // anyway, but a stray `zoom` key must not resurrect itself through this path either.
    const out = migratePersistedUi({ zoom: 1.4, zoomByColumn: { concierge: 1.1 } }, 4, SNAP);
    const map = out?.zoomByColumn as Record<string, number>;
    expect(map["concierge"]).toBe(1.1);
    expect(map["build-left"]).toBe(ZOOM_DEFAULT); // filled from the default, NOT from the stale 1.4
  });
});

// ── THE COMPLETENESS REPAIR — WHY A PARTIAL MAP IS A BLANK TERMINAL ────────────────────────────
//
// uiStore's merge is SHALLOW, so a persisted map REPLACES the complete default rather than filling
// in around it. A blob carrying four of six keys hydrates `undefined` for the rest, and `undefined`
// is not "unzoomed" — it multiplies into `NaN`, reaches `term.options.fontSize`, and blanks that
// column on every launch until localStorage is edited by hand. Same hazard `repairStatusFilter`
// documents for the band filter, answered the same way.
describe("repairZoomByColumn", () => {
  it("fills EVERY missing column, so a partial blob cannot hydrate undefined", () => {
    const out = repairZoomByColumn({ concierge: 1.3 });
    expect(out.concierge).toBe(1.3);
    for (const key of ZOOM_COLUMNS) expect(typeof out[key]).toBe("number");
    expect(Object.keys(out).sort()).toEqual([...ZOOM_COLUMNS].sort());
  });

  it("clamps a stored value and replaces a non-numeric one", () => {
    const out = repairZoomByColumn({ concierge: 99, "build-left": "big", "terminal-left": null });
    expect(out.concierge).toBe(ZOOM_MAX);
    expect(out["build-left"]).toBe(ZOOM_DEFAULT);
    expect(out["terminal-left"]).toBe(ZOOM_DEFAULT);
  });

  it("survives a non-object, which is what a hand-edited blob looks like", () => {
    for (const junk of [null, undefined, 3, "1.2", []]) {
      const out = repairZoomByColumn(junk);
      for (const key of ZOOM_COLUMNS) expect(out[key]).toBe(ZOOM_DEFAULT);
    }
  });

  it("DROPS a key that is not a known column rather than carrying it forward", () => {
    const out = repairZoomByColumn({ concierge: 1.2, "build-middle": 1.5 }) as Record<string, number>;
    expect("build-middle" in out).toBe(false);
  });
});
