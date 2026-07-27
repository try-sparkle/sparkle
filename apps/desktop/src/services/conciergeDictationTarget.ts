// Who receives dictated text (bead sparkle-4562.2 / CM-U9).
//
// dictationStore holds exactly ONE insert target for the whole app, and the visible agent composer
// registers itself for it (components/Composer.tsx). The concierge compose box therefore must NOT
// hold the target merely because it is mounted — the column is on screen for the whole session, so
// an unconditional claim would silently take wake-word dictation away from every agent composer.
// It BORROWS the target only while the user has the concierge mic live, and hands it straight back
// on release.
//
// Both functions are pure over an injected store handle, so the borrow/return protocol is testable
// without React, Tauri, or a live dictation session.

export type InsertFn = (text: string) => void;

/** The slice of dictationStore this protocol needs. */
export interface DictationTargetStore {
  getInsertTarget: () => InsertFn | null;
  registerInsert: (fn: InsertFn | null) => void;
}

/**
 * Take the insert target for `append` and return whoever held it, so a later
 * {@link releaseDictationTarget} can restore them. Call once per ownership episode: calling it
 * again while we already hold the target would record OURSELVES as the displaced holder and strand
 * the real one, so a re-claim reports null instead.
 */
export function claimDictationTarget(
  store: DictationTargetStore,
  append: InsertFn,
): InsertFn | null {
  const displaced = store.getInsertTarget();
  store.registerInsert(append);
  return displaced === append ? null : displaced;
}

/**
 * Hand the target back to `displaced` — but ONLY if we still hold it. A composer that registered
 * after us owns it legitimately (it mounted, or its pane became visible mid-session) and must not
 * be evicted by our teardown; this mirrors the `insertTarget === append` guard every composer
 * already uses when it unregisters.
 */
export function releaseDictationTarget(
  store: DictationTargetStore,
  append: InsertFn,
  displaced: InsertFn | null,
): void {
  if (store.getInsertTarget() !== append) return;
  store.registerInsert(displaced);
}

/** The live dictationStore, adapted to {@link DictationTargetStore}. Split out so the hook can be
 *  pointed at a fake in tests. */
export function dictationTargetStore(store: {
  getState: () => { insertTarget: InsertFn | null; registerInsert: (fn: InsertFn | null) => void };
}): DictationTargetStore {
  return {
    getInsertTarget: () => store.getState().insertTarget,
    registerInsert: (fn) => store.getState().registerInsert(fn),
  };
}
