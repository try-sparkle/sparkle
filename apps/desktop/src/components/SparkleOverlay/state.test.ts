// State-machine transitions: every (anchor × mode) pair derives the DOM-facing flags
// deterministically, so the render layer can never disagree with the design grammar
// (dim only front-and-center, orb text never on 'row', ripple only while listening).
import { describe, expect, it } from "vitest";
import { deriveFlags, divesOnTransition, type Anchor, type Mode } from "./state";

const ANCHORS: Anchor[] = ["perch", "center", "card", "row"];
const MODES: Mode[] = ["still", "listening", "speaking"];

describe("deriveFlags", () => {
  it("dims the app ONLY while front-and-center", () => {
    for (const a of ANCHORS) {
      for (const m of MODES) {
        expect(deriveFlags(a, m).dimmed).toBe(a === "center");
      }
    }
  });

  it("infuses the card only on 'card' and the row only on 'row'", () => {
    for (const a of ANCHORS) {
      for (const m of MODES) {
        const f = deriveFlags(a, m);
        expect(f.cardInfused).toBe(a === "card");
        expect(f.rowInfused).toBe(a === "row");
      }
    }
  });

  it("shows orb text on center/card always, at perch only while listening, never on row", () => {
    for (const m of MODES) {
      expect(deriveFlags("center", m).orbTextVisible).toBe(true);
      expect(deriveFlags("card", m).orbTextVisible).toBe(true);
      expect(deriveFlags("row", m).orbTextVisible).toBe(false);
      expect(deriveFlags("perch", m).orbTextVisible).toBe(m === "listening");
    }
  });

  it("marks the home vacated whenever Sparkle is away from the perch", () => {
    for (const m of MODES) {
      expect(deriveFlags("perch", m).homeAway).toBe(false);
      expect(deriveFlags("center", m).homeAway).toBe(true);
      expect(deriveFlags("card", m).homeAway).toBe(true);
      expect(deriveFlags("row", m).homeAway).toBe(true);
    }
  });

  it("exposes listening/speaking as plain mode mirrors", () => {
    const f = deriveFlags("perch", "listening");
    expect(f.listening).toBe(true);
    expect(f.speaking).toBe(false);
    const g = deriveFlags("center", "speaking");
    expect(g.listening).toBe(false);
    expect(g.speaking).toBe(true);
  });
});

describe("divesOnTransition", () => {
  it("pours a fixed subset (ix < .45) into a card, keeping the rest as the shell", () => {
    expect(divesOnTransition("card", 0.1)).toBe(true);
    expect(divesOnTransition("card", 0.44)).toBe(true);
    expect(divesOnTransition("card", 0.45)).toBe(false);
    expect(divesOnTransition("card", 0.9)).toBe(false);
  });

  it("pours the WHOLE swarm into a row (the handoff absorbs Sparkle entirely)", () => {
    expect(divesOnTransition("row", 0)).toBe(true);
    expect(divesOnTransition("row", 0.99)).toBe(true);
  });

  it("never dives when heading home or front-and-center", () => {
    for (const ix of [0, 0.3, 0.9]) {
      expect(divesOnTransition("perch", ix)).toBe(false);
      expect(divesOnTransition("center", ix)).toBe(false);
    }
  });
});
