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
function repairStatusFilter(raw: unknown): Record<string, boolean> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of STATUS_BAND_KEYS) out[k] = typeof src[k] === "boolean" ? (src[k] as boolean) : true;
  return out;
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
  // The filter repair runs on EVERY rehydrate, deliberately NOT version-gated. uiStore's merge is a
  // shallow one, so a persisted `statusFilter` REPLACES the default object wholesale rather than
  // merging into it. Gate this on `version < 2` and the day someone adds a fourth band, every
  // existing user (already at v2, so the migration is skipped) rehydrates a three-key filter,
  // `visibleBands[newBand]` reads `undefined` → falsy, and that band's rows vanish from the Build
  // column with no visible cause and nothing failing — precisely what this repair exists to stop.
  // Running it unconditionally costs one object rebuild per launch and closes that hole for good.
  next = { ...next, statusFilter: repairStatusFilter(next.statusFilter) };
  return next;
}
