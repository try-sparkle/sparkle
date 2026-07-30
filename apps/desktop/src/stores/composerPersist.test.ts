import { describe, it, expect } from "vitest";
import { migratePersistedUi, OLD_COMPOSER_DEFAULT } from "./composerPersist";
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
    const out = migratePersistedUi(
      { composerHeight: OLD_COMPOSER_DEFAULT, zoom: 1.2, composerMinimized: true },
      0,
      SNAP,
    );
    expect(out).toMatchObject({ composerHeight: SNAP, zoom: 1.2, composerMinimized: true });
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
    const out = migratePersistedUi({ zoom: 1.2 }, 2, SNAP);
    expect(out && "conciergeSendMode" in out).toBe(false);
    expect(out?.zoom).toBe(1.2);
  });

  it("COERCES an unrecognised position to Send, on every rehydrate, not just at v3", () => {
    // Ungated on purpose, like the statusFilter repair: a blob written by a partial rollout (or by a
    // future value that got rolled back) is already at v3 and would skip a version-gated repair. The
    // direction is fail-closed — the mic mapping must never be handed a value it resolves to "live".
    expect(migratePersistedUi({ conciergeSendMode: "shout" }, 3, SNAP)?.conciergeSendMode).toBe("send");
    expect(migratePersistedUi({ conciergeSendMode: 7 }, 3, SNAP)?.conciergeSendMode).toBe("send");
    expect(migratePersistedUi({ conciergeSendMode: null }, 3, SNAP)?.conciergeSendMode).toBe("send");
  });

  it("leaves every REAL position alone", () => {
    // The other half: a repair that clobbers valid values would pass the row above and silently
    // reset everyone to Send on launch.
    for (const m of ["send", "ptt", "speak"]) {
      expect(migratePersistedUi({ conciergeSendMode: m }, 3, SNAP)?.conciergeSendMode).toBe(m);
    }
  });

  it("the accepted list IS the app's list — the literals here cannot drift from SEND_MODES", () => {
    // composerPersist spells the three positions as literals because a value import of
    // voice/sendMode would close a runtime cycle (it reaches components/MicButton → theme/colors,
    // and theme/theme imports uiStore, which imports this). A hand-copied list needs the pin the
    // status-band list already has: add a fourth position and, without this, the migration would
    // coerce it to Send on every launch and nothing would fail.
    for (const m of SEND_MODES) {
      expect(migratePersistedUi({ conciergeSendMode: m }, 3, SNAP)?.conciergeSendMode).toBe(m);
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
