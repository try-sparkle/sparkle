// A satellite READS the app's persisted UI preferences and never writes them back.
//
// `uiStore` persists to the single `sparkle-ui` blob and is NOT cross-window synced. Every window
// hydrates its own copy at boot and zustand's `persist` writes the WHOLE partialized state on every
// change — so a satellite flipping a status-filter chip would republish its own stale snapshot of
// `openProjectIds`, `pinnedProjectId` and everything else over whatever the main window had written
// since. The user closes a tab in main, changes a filter in a satellite, relaunches, and the closed
// tab is back. That is the exact clobber the tear-off PRD warns about ("ownership must live in
// windowRegistry, NOT uiStore — a satellite writing it would clobber the main window's whole
// `sparkle-ui` blob").
//
// The fix is one-directional persistence rather than a second store: the satellite still inherits
// the user's theme, zoom and filters at launch (which is what makes it feel like the same app), and
// its own changes are simply session-scoped. Main stays the sole writer of `sparkle-ui`.
//
// Read-THROUGH, not a snapshot: `getItem` still delegates to real localStorage, because zustand may
// not have hydrated yet when this runs (hydration order depends on module evaluation) and a shim
// that returned null would blank the inherited preferences instead of freezing the writes.

import { createJSONStorage } from "zustand/middleware";
import { useUiStore } from "../stores/uiStore";

/** localStorage for reads, /dev/null for writes. */
export function readOnlyLocalStorage() {
  return {
    getItem: (name: string): string | null => {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    // Named (unused) parameters rather than `()`: zustand calls these with arguments, and a
    // zero-arity type makes the shim uncallable-with-args for anyone else — including its own test.
    setItem: (_name: string, _value: string): void => {},
    removeItem: (_name: string): void => {},
  };
}

/** Make this webview's `uiStore` read-only against localStorage. Call once, during satellite boot,
 *  before the React tree mounts. */
export function freezeUiPersistence(): void {
  useUiStore.persist.setOptions({ storage: createJSONStorage(readOnlyLocalStorage) });
}
