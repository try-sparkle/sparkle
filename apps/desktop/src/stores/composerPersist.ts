// Pure migration for the persisted `sparkle-ui` store, extracted so it can be unit-tested
// without standing up the zustand store (a regression here silently changes every existing
// user's stored composer height).
//
// v1: the composer's rest height shrank from 128 to the compact COMPOSER_SNAP. Reset only the
// users still parked on the OLD default so they pick up the new cover height, while preserving
// any height someone deliberately dragged to.
//
// v2: the Build column stopped sorting rows by live status (see engine/buildSections.ts), so the
// `agentOrdering` preference no longer selects between anything and is dropped. Its replacement,
// `statusFilter`, is REPAIRED rather than trusted: a blob written by a partial rollout — or hand-
// edited — could carry a filter with a missing or non-boolean band, and a single `undefined` there
// reads as falsy and would silently hide a third of the user's agents with no visible cause.
//
// v3: the auto-send rail's boolean armed switch became the send tray's three-position mode
// (voice/sendMode). The two are the same decision — "does this go on its own?" — so carrying the
// old preference across is not a courtesy, it is the difference between an upgrade and a silent
// reset: someone who deliberately armed auto-send would otherwise relaunch into `send`, dictate,
// and watch nothing happen, with no message anywhere saying their setting had been dropped.

import { STATUS_BANDS } from "../engine/buildSections";

// The composer rest height before v1 (the value to reset off of).
export const OLD_COMPOSER_DEFAULT = 128;

// Every band that must be present in a persisted `statusFilter`, DERIVED from the one band table
// rather than hand-copied. A second literal list here was the exact failure `repairStatusFilter`
// exists to prevent: add a fourth band and the migration would keep emitting a 3-key filter, the
// new band would hydrate `undefined` → falsy, and its rows would vanish from the Build column with
// no visible cause and no failing test. (The type-only-import constraint that forces uiStore to
// spell its default inline does not apply here — composerPersist is not in the theme → uiStore
// cycle, so it can import the value.)
const STATUS_BAND_KEYS = STATUS_BANDS.map((b) => b.id);

export interface PersistedUi {
  composerHeight?: number;
  [k: string]: unknown;
}

// Coerce whatever is on disk into a complete {band: boolean} record. A missing or non-boolean entry
// defaults to VISIBLE — the safe direction: showing a row the user filtered out is a minor
// annoyance they can re-hide, while hiding one they expected to see looks like data loss.
export function repairStatusFilter(raw: unknown): Record<string, boolean> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of STATUS_BAND_KEYS) out[k] = typeof src[k] === "boolean" ? (src[k] as boolean) : true;
  return out;
}

/**
 * Coerce a persisted `activeSpecial` to a value this build still renders.
 *
 * `activeSpecial` is PERSISTED (deliberately absent from uiStore's TRANSIENT_UI_KEYS), and it used
 * to carry a third value, `"board"`. The Plan board is per-column state now (`workModeBySide`), so
 * `"board"` names a view nothing renders — but a blob written before that change merges it straight
 * back in as a TRUTHY value, and nothing clears it: `openProjectTab` only clears `"sparkle"`. The
 * damage is all silent — no sidebar row reads as selected, `reconcileWorkMode` is permanently
 * neutered, and `capture_agent` refuses every screenshot with `special-view-showing: "board"` —
 * until the user happens to press Build.
 *
 * CALLED FROM uiStore's `merge`, NOT from this file's `migratePersistedUi`. That distinction is the
 * whole point: zustand runs `migrate` ONLY when the stored version differs from the configured one
 * (middleware.js — `deserializedStorageValue.version !== options.version`). Every blob that can
 * carry `activeSpecial: "board"` was written at the CURRENT version, so a repair wired through
 * `migrate` is unreachable for exactly the population it exists to fix. `merge` runs on every
 * rehydrate. It is also applied here for a version-mismatched blob, so both paths are covered.
 */
export function repairActiveSpecial(raw: unknown): "sparkle" | null {
  return raw === "sparkle" ? "sparkle" : null;
}

export function migratePersistedUi(
  persisted: PersistedUi | undefined,
  version: number,
  snap: number,
): PersistedUi | undefined {
  if (!persisted) return persisted;
  let next = persisted;
  if (version < 1 && next.composerHeight === OLD_COMPOSER_DEFAULT) {
    next = { ...next, composerHeight: snap };
  }
  if (version < 2) {
    // Drop the retired ordering preference. Version-gated because it only ever needs to happen once.
    const { agentOrdering: _agentOrdering, ...rest } = next;
    next = rest;
  }
  if (version < 3) {
    // ARMED → "speak", DISARMED → "send". `speak` (not `ptt`) is the honest translation: the old
    // switch armed a countdown that fires on its own when you stop talking, and that is exactly
    // what `speak` is. `ptt` sends on a key RELEASE and has no countdown at all, so landing an
    // upgrading user there would hand them a mode they never chose and whose gesture they have
    // never been shown.
    //
    // A blob with no `conciergeAutoSend` at all (a fresh-ish install written before the key
    // existed) leaves `conciergeSendMode` unset, so the store's own default applies. Deleting the
    // retired key is what keeps `merge` from carrying a dead boolean forward forever.
    const { conciergeAutoSend, ...rest } = next;
    next = conciergeAutoSend === undefined
      ? rest
      : { ...rest, conciergeSendMode: conciergeAutoSend ? "speak" : "send" };
  }
  // The tray position is REPAIRED on every rehydrate, deliberately NOT version-gated — same
  // reasoning as the filter repair below, but a sharper failure. uiStore's merge is shallow, so an
  // unrecognised `conciergeSendMode` (a partial rollout, a hand-edited blob, a future value rolled
  // back) hydrates verbatim, and the mic mapping has to do SOMETHING with it. Coercing here means
  // the one thing it can never do is take the microphone live on a value nobody recognises, with no
  // pill reading selected to explain it. Fail closed, twice: `micIntentForMode` also defaults to
  // "off" rather than "active", because a single guard for "spends credits and captures audio" is
  // one guard too few.
  //
  // Spelled as literals rather than importing SEND_MODES: voice/sendMode reaches components/MicButton
  // for `MicIntent`, and this module is loaded by uiStore, which theme/theme.ts imports — the value
  // import would close that into a runtime cycle. Pinned against the real list by a test.
  if (next.conciergeSendMode !== undefined
      && !["send", "ptt", "speak"].includes(next.conciergeSendMode as string)) {
    next = { ...next, conciergeSendMode: "send" };
  }
  // The filter repair runs on EVERY rehydrate, deliberately NOT version-gated. uiStore's merge is a
  // shallow one, so a persisted `statusFilter` REPLACES the default object wholesale rather than
  // merging into it. Gate this on `version < 2` and the day someone adds a fourth band, every
  // existing user (already at v2, so the migration is skipped) rehydrates a three-key filter,
  // `visibleBands[newBand]` reads `undefined` → falsy, and that band's rows vanish from the Build
  // column with no visible cause and nothing failing — precisely what this repair exists to stop.
  // Running it unconditionally costs one object rebuild per launch and closes that hole for good.
  next = { ...next, statusFilter: repairStatusFilter(next.statusFilter) };
  // Same unconditional treatment, same reason — see repairActiveSpecial. Only applied when the key
  // is actually present, so a blob that never carried one is passed through untouched (the store
  // default already answers null) rather than gaining a key it did not have.
  if ("activeSpecial" in next) {
    next = { ...next, activeSpecial: repairActiveSpecial(next.activeSpecial) };
  }
  return next;
}
