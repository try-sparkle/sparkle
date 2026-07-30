// @vitest-environment jsdom
//
// The rebindable-shortcut registry. Three things are pinned here, each of which is a way a new
// shortcut can be added and silently not work:
//
//   1. Its DEFAULT actually is the chord the design chose, and does not collide with an existing one.
//   2. It has a Settings ROW. `KeyboardShortcutsMenu`'s id list is hand-maintained (the order is a
//      design decision, not object-key order), so an id absent from it is unreachable in the UI —
//      the shortcut works but cannot be seen, changed, or reset.
//   3. An older persisted blob that predates the id still resolves to a usable binding.
import { describe, expect, it } from "vitest";

import {
  SHORTCUT_DEFAULTS,
  SHORTCUT_LABELS,
  useKeybindingsStore,
  type ShortcutId,
} from "./keybindingsStore";
import { SHORTCUT_ROW_ORDER } from "../components/KeyboardShortcutsMenu";
import { matchesChord, type KeyEventLike } from "../keyboardHints/keybindings";

/** A ⌘⇧U keydown, with any field overridden. Typed as `KeyEventLike` so the overrides are the
 *  EVENT's field names (`metaKey`) and not the binding's (`meta`) — the two vocabularies are easy to
 *  mix up, and the compiler should be the one to notice. */
const chord = (over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: "u",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  type: "keydown",
  ...over,
});

describe("unmountCable — the chord that unmounts from inside a terminal", () => {
  it("defaults to ⌘⇧U", () => {
    expect(SHORTCUT_DEFAULTS.unmountCable).toEqual({
      kind: "chord",
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: "u",
    });
  });

  it("matches ⌘⇧U and nothing looser", () => {
    const b = SHORTCUT_DEFAULTS.unmountCable;
    expect(matchesChord(chord(), b)).toBe(true);
    // A bare U is ordinary typing; ⌘U without shift is a different combo; a wrong key is not it.
    expect(matchesChord(chord({ metaKey: false, shiftKey: false }), b)).toBe(false);
    expect(matchesChord(chord({ shiftKey: false }), b)).toBe(false);
    expect(matchesChord(chord({ key: "j" }), b)).toBe(false);
    // Extra modifiers are NOT a match — `matchesChord` compares every flag exactly.
    expect(matchesChord(chord({ ctrlKey: true }), b)).toBe(false);
    expect(matchesChord(chord({ altKey: true }), b)).toBe(false);
  });

  // The app had no other ⌘⇧ chord when this was chosen. Asserted as a property over the whole
  // registry rather than as a spot check, so adding a colliding default fails here.
  it("does not collide with any other shortcut's default", () => {
    const others = (Object.keys(SHORTCUT_DEFAULTS) as ShortcutId[]).filter(
      (id) => id !== "unmountCable",
    );
    for (const id of others) {
      expect(matchesChord(chord(), SHORTCUT_DEFAULTS[id])).toBe(false);
    }
  });

  it("is not offered a tap binding — it is matched on keydown, where a tap never fires", () => {
    expect(SHORTCUT_LABELS.unmountCable.allowsTap).toBe(false);
  });
});

describe("the registry stays internally consistent", () => {
  // THE HAND-MAINTAINED LIST. `SHORTCUT_DEFAULTS` and `SHORTCUT_LABELS` are `Record<ShortcutId, …>`
  // so the compiler already forces those to be total; the Settings row order is a plain array and is
  // the one place a new id can go missing without any error at all.
  it("gives every shortcut a Settings row", () => {
    const ids = Object.keys(SHORTCUT_DEFAULTS) as ShortcutId[];
    expect([...SHORTCUT_ROW_ORDER].sort()).toEqual([...ids].sort());
  });

  it("lists no row for a shortcut that does not exist", () => {
    for (const id of SHORTCUT_ROW_ORDER) {
      expect(SHORTCUT_DEFAULTS[id]).toBeDefined();
      expect(SHORTCUT_LABELS[id]).toBeDefined();
    }
  });

  // A user who has run an older build has a persisted blob with only the ids that existed then.
  // The store's `merge` layers persisted values OVER the defaults precisely so a newly-added id is
  // still bound; without it, `bindings.unmountCable` would be undefined and `matchesChord` would
  // throw on the first keystroke after upgrading.
  it("backfills a newly-added shortcut for a user upgrading from an older build", () => {
    const legacy = { bindings: { toggleComposer: SHORTCUT_DEFAULTS.toggleComposer } };
    const merged = (
      useKeybindingsStore.persist.getOptions().merge as (
        p: unknown,
        c: unknown,
      ) => { bindings: Record<ShortcutId, unknown> }
    )(legacy, useKeybindingsStore.getState());
    expect(merged.bindings.unmountCable).toEqual(SHORTCUT_DEFAULTS.unmountCable);
    // …and the user's own choice is not clobbered by the backfill.
    expect(merged.bindings.toggleComposer).toEqual(SHORTCUT_DEFAULTS.toggleComposer);
  });
});
