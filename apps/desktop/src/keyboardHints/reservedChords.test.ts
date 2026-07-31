// A recorded binding must be REFUSED when another handler already owns the chord.
//
// This exists because standing global handlers down during a capture (roborev 55310/55487) removed
// the collision's only symptom without removing the collision: recording ⌘K used to open the palette
// on top of the pane — ugly, but it told you the gesture was taken. Afterwards the capture completed
// cleanly and `setBinding` accepted it, so the conflict became permanent, persisted, and discoverable
// only by using the app later (roborev 55540).
//
// The reserved cases are checked through the OWNING handlers' exported predicates, so these tests
// also pin that the two cannot drift apart: change ⌘K's predicate and this file follows.
import { describe, expect, it, vi } from "vitest";
import { bindingConflict } from "./reservedChords";
import { SHORTCUT_DEFAULTS, SHORTCUT_LABELS, type ShortcutId } from "../stores/keybindingsStore";
import type { KeyBinding } from "./keybindings";

const chord = (key: string, over: Partial<Extract<KeyBinding, { kind: "chord" }>> = {}) =>
  ({ kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key, ...over }) as KeyBinding;

const defaults = (): Record<ShortcutId, KeyBinding> => ({ ...SHORTCUT_DEFAULTS });

describe("bindingConflict — reserved chords owned by non-rebindable handlers", () => {
  it("refuses ⌘K, which opens the command palette", () => {
    // The concrete bug: bind Composer ⇄ Terminal to ⌘K and every press both opens the palette and
    // jumps focus, forever, with Reset the only way out.
    expect(bindingConflict(chord("k"), defaults(), "toggleComposer")).toMatch(/command palette/);
  });

  it("refuses ⌘, which opens Settings", () => {
    expect(bindingConflict(chord(","), defaults(), "toggleComposer")).toMatch(/Settings/);
  });

  it("refuses Ctrl+K too — the palette predicate accepts either modifier", () => {
    expect(bindingConflict(chord("k", { meta: false, ctrl: true }), defaults(), "toggleComposer")).toMatch(
      /command palette/,
    );
  });

  it("allows a chord nobody owns", () => {
    expect(bindingConflict(chord("y"), defaults(), "toggleComposer")).toBeNull();
  });

  it("allows ⌥⌘K — the palette deliberately excludes Alt, so this really is free", () => {
    // Guards against a conflict check that is coarser than the predicate it defends.
    expect(bindingConflict(chord("k", { alt: true }), defaults(), "toggleComposer")).toBeNull();
  });

  it("does not treat a lone-modifier tap as colliding with a reserved chord", () => {
    // Reserved chords all require a non-modifier key, so a tap cannot fire them.
    expect(bindingConflict({ kind: "tap", modifier: "Alt" }, defaults(), "toggleHints")).toBeNull();
  });
});

// roborev 55581 raised a module-init cycle risk here. There is NO cycle — nothing in
// `keybindingsStore` or `keybindings` imports back into `reservedChords`, so the graph is a diamond,
// not a loop. But this file's own tests import `reservedChords` FIRST, which is the safe order, so
// they could not have detected one either way, and the concern deserved a real pin.
//
// THE FIRST VERSION OF THIS TEST WAS VACUOUS (roborev 55611): the static import at the top of this
// file had already evaluated all three modules in the safe leaf-first order before the body ran, and
// `await import(...)` returns the CACHED instance — so the three imports were no-ops and `late` was
// the very same function the rest of the file exercises. It could not have failed under any hazard.
// `vi.resetModules()` is what makes the order real: it clears the registry so the dynamic imports
// below genuinely re-evaluate, hook modules first.
describe("module init order (no cycle, and pinned rather than argued)", () => {
  it("resolves RESERVED when the owning hooks are evaluated BEFORE reservedChords", async () => {
    vi.resetModules();

    // Hazardous order on purpose: the modules that own the predicates first, the leaf that reads
    // them at module-init time last.
    await import("../components/Concierge/useCommandPalette");
    await import("../hooks/useSettingsShortcut");
    const fresh = await import("./reservedChords");

    // Proof this is not the cached module — without it the assertion below would pass on the
    // already-initialized instance and prove nothing, which is exactly how the first version failed.
    expect(fresh.bindingConflict).not.toBe(bindingConflict);
    // A RESERVED array built from an unresolved import would be empty or throw; a real verdict proves
    // the predicates were live when the leaf's module body ran.
    expect(fresh.bindingConflict(chord("k"), defaults(), "toggleComposer")).toMatch(/command palette/);
  });
});

describe("bindingConflict — collisions with our OWN other shortcuts", () => {
  it("refuses a chord another rebindable shortcut already uses, and names it", () => {
    // toggleComposer defaults to ⌘J; giving that to toggleHints would fire both.
    //
    // Asserted against SHORTCUT_LABELS rather than a literal, because the invariant is "the message
    // names the shortcut that owns the chord" — not any particular wording. A hardcoded string here
    // broke the moment main retitled this shortcut, which is a false failure: the code was right and
    // the test was pinning the copy.
    const conflict = bindingConflict(chord("j"), defaults(), "toggleHints");
    expect(conflict).toContain(SHORTCUT_LABELS.toggleComposer.title);
  });

  it("allows re-recording a shortcut to the value it already has", () => {
    // Excluding `forId` matters: otherwise a shortcut collides with itself and can never be re-set.
    expect(bindingConflict(chord("j"), defaults(), "toggleComposer")).toBeNull();
  });

  it("refuses a tap another shortcut already uses", () => {
    // toggleHints defaults to a Control tap. Named via SHORTCUT_LABELS for the same reason as above.
    expect(
      bindingConflict({ kind: "tap", modifier: "Control" }, defaults(), "toggleComposer"),
    ).toContain(SHORTCUT_LABELS.toggleHints.title);
  });

  it("compares every field of a chord, not just the key", () => {
    // ⌘⇧J is not ⌘J, so it must be allowed rather than reported as a duplicate.
    expect(bindingConflict(chord("j", { shift: true }), defaults(), "toggleHints")).toBeNull();
  });
});
