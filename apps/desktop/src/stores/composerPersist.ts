// Pure migration for the persisted `sparkle-ui` store, extracted so it can be unit-tested
// without standing up the zustand store (a regression here silently changes every existing
// user's stored composer height).
//
// v1: the composer's rest height shrank from 128 to the compact COMPOSER_SNAP. Reset only the
// users still parked on the OLD default so they pick up the new cover height, while preserving
// any height someone deliberately dragged to.

// The composer rest height before v1 (the value to reset off of).
export const OLD_COMPOSER_DEFAULT = 128;

export interface PersistedUi {
  composerHeight?: number;
  [k: string]: unknown;
}

export function migratePersistedUi(
  persisted: PersistedUi | undefined,
  version: number,
  snap: number,
): PersistedUi | undefined {
  if (persisted && version < 1 && persisted.composerHeight === OLD_COMPOSER_DEFAULT) {
    return { ...persisted, composerHeight: snap };
  }
  return persisted;
}
