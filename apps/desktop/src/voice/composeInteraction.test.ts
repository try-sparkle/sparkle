// The shared predicate, on its own — no clock, no DOM, no React (bead sparkle-wfwypy).
//
// This file exists because the rule it proves is the one thing that must NOT be re-derived at each
// call site. The countdown grew a separate `||` term per founder report before this module existed;
// the point of collapsing them is that a fourth trigger changes ONE function, and these rows are
// what say that function still means what it meant.
import { describe, expect, it } from "vitest";
import {
  NO_COMPOSE_INTERACTION,
  TYPING_SETTLE_MS,
  interactionEdits,
  interactionInFlight,
  isCaretGestureKey,
  noteComposeInteraction,
  type ComposeInteractionTerms,
} from "./composeInteraction";

const IDLE: ComposeInteractionTerms = {
  composingMention: false,
  attachPickerOpen: false,
  lastGestureAt: null,
};

describe("interactionInFlight — the one question every caller asks", () => {
  it("is FALSE when nothing is happening — the countdown's normal case", () => {
    // The paired negative for every row below: a predicate stuck at true would satisfy all of them
    // and would freeze the countdown permanently.
    expect(interactionInFlight(IDLE, 1_000)).toBe(false);
  });

  it.each([
    ["an unfinished @-address", { composingMention: true }],
    ["a screenshot or Finder panel on screen", { attachPickerOpen: true }],
  ])("is TRUE while %s — held by an edge, with no settle window", (_l, term) => {
    const t = { ...IDLE, ...term };
    expect(interactionInFlight(t, 1_000)).toBe(true);
    // A stateful term has an observable end, so it never expires on its own however long it lasts.
    expect(interactionInFlight(t, 1_000 + 60 * 60_000)).toBe(true);
  });

  it("is TRUE for TYPING_SETTLE_MS after a discrete gesture, then false", () => {
    const t = { ...IDLE, lastGestureAt: 5_000 };
    expect(interactionInFlight(t, 5_000)).toBe(true);
    expect(interactionInFlight(t, 5_000 + TYPING_SETTLE_MS - 1)).toBe(true);
    // The boundary is exclusive: at exactly the settle instant the hold is over.
    expect(interactionInFlight(t, 5_000 + TYPING_SETTLE_MS)).toBe(false);
  });

  it("ORs its terms — a settled keystroke does not un-hold an open picker", () => {
    // The composition property the module is built for. `pauseCountdown` is idempotent and the
    // resume runs only when EVERY term is false, so whichever term drops first, the clock stays
    // frozen — and it is one full threshold on the way out, never two.
    const t = { composingMention: false, attachPickerOpen: true, lastGestureAt: 5_000 };
    expect(interactionInFlight(t, 5_000 + TYPING_SETTLE_MS + 1)).toBe(true);
  });
});

describe("interactionEdits — which gestures make a draft HAND-EDITED", () => {
  it("only an edit does", () => {
    expect(interactionEdits("edit")).toBe(true);
    // Aiming at a draft is not changing it: a dictated sentence you merely arrow through keeps the
    // speech ladder's fast lane. See TYPED_EDIT_MIN_THRESHOLD_MS.
    expect(interactionEdits("caret")).toBe(false);
    expect(interactionEdits("mention")).toBe(false);
  });
});

describe("isCaretGestureKey — user gestures, never machine-driven selection", () => {
  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])(
    "%s moves the caret",
    (key) => expect(isCaretGestureKey({ key })).toBe(true),
  );

  it("select-all counts on both platforms' modifier", () => {
    expect(isCaretGestureKey({ key: "a", metaKey: true })).toBe(true);
    expect(isCaretGestureKey({ key: "A", ctrlKey: true })).toBe(true);
  });

  it("SELECT-ALL IS THE ONLY MODIFIED KEY THAT COUNTS — ⌘X/⌘V/⌘Z are edits", () => {
    // The modifier is not what makes a gesture a caret move; the KEY is. Cut, paste and undo all
    // change the draft, so they arrive through `onChange` as edits — which floor the threshold.
    // Reporting them here as well would tag the same keystroke "caret", and the later report wins,
    // so a hand-edited draft would silently keep the speech ladder's fast lane.
    expect(isCaretGestureKey({ key: "x", metaKey: true })).toBe(false);
    expect(isCaretGestureKey({ key: "v", metaKey: true })).toBe(false);
    expect(isCaretGestureKey({ key: "z", metaKey: true })).toBe(false);
  });

  it("A BARE LETTER DOES NOT — it types, and onChange counts it once", () => {
    // Without this the character keys would be reported twice per keystroke, and the second report
    // carries kind "caret" — which does not floor the threshold, so the last word would win and a
    // hand-edited draft would silently keep the fast lane.
    expect(isCaretGestureKey({ key: "a" })).toBe(false);
    expect(isCaretGestureKey({ key: "Enter" })).toBe(false);
    expect(isCaretGestureKey({ key: "Backspace" })).toBe(false);
  });
});

describe("noteComposeInteraction — a COUNT, because gestures are instants", () => {
  it("bumps once per gesture so two keystrokes cannot collapse into one", () => {
    const a = noteComposeInteraction(NO_COMPOSE_INTERACTION, "edit");
    const b = noteComposeInteraction(a, "edit");
    expect([a.seq, b.seq]).toEqual([1, 2]);
  });

  it("carries what the LATEST gesture was", () => {
    const typed = noteComposeInteraction(NO_COMPOSE_INTERACTION, "edit");
    expect(typed.edited).toBe(true);
    expect(noteComposeInteraction(typed, "caret").edited).toBe(false);
  });

  it("starts at zero — the sentinel that means nobody has touched the box", () => {
    expect(NO_COMPOSE_INTERACTION.seq).toBe(0);
  });
});
