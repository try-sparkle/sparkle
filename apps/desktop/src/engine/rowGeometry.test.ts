// The row box, as a rule rather than as four inline literals written for one pair.
//
// What these pin is the pair of invariants the mock states and the inline version could not hold:
// the geometry MIRRORS with the pair (a left pair's terminal is on its left), and the ink's inset
// from the column edge is CONSTANT across unselected / selected / wired — which is what stops the
// list twitching when you change agents.
import { describe, expect, it } from "vitest";
import { LIST_PAD_X, ROW_PAD_COMPENSATED, ROW_PAD_X, oppositeSide, rowBox } from "./rowGeometry";

const LEAD = 6;
const IDLE = 6;
const base = { leadRadius: LEAD, idleRadius: IDLE, padY: 4 };

/** Where the ink sits relative to the COLUMN's edge on a given side: the list's own padding, plus
 *  the row's margin (negative when it bleeds through), plus the row's padding. The whole point of
 *  compensating a bleed is that this number does not move. */
const inkInset = (box: ReturnType<typeof rowBox>, side: "left" | "right") => {
  // `padding` is the CSS shorthand: top right bottom left.
  const parts = box.padding.split(" ").map((p) => parseFloat(p));
  const pad = side === "left" ? parts[3]! : parts[1]!;
  const margin = side === "left" ? box.marginLeft : box.marginRight;
  return LIST_PAD_X + margin + pad;
};

describe("rowBox — the pane end", () => {
  it("bleeds toward the terminal, which is the RIGHT for a right-hand pair", () => {
    const box = rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true });
    expect(box.marginRight).toBe(-LIST_PAD_X);
    expect(box.marginLeft).toBe(0);
  });

  it("MIRRORS for a left-hand pair — the terminal is on its left, so the bleed is too", () => {
    // The regression this rule exists for. The inline version was written for one pair and hung the
    // bleed on `marginRight` unconditionally, so the left pair's row ran into the CONCIERGE.
    const box = rowBox({ ...base, paneSide: "left", jointOpen: false, isActive: true });
    expect(box.marginLeft).toBe(-LIST_PAD_X);
    expect(box.marginRight).toBe(0);
  });

  it("is never a radius — a radius necks the row down as it reaches the pane", () => {
    // TL TR BR BL. The pane corners are the two on the terminal side, and they stay square in every
    // state; the concave fillet is what opens them (MAPPING.md, "Geometry vocabulary").
    expect(rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true }).borderRadius)
      .toBe(`${LEAD}px 0 0 ${LEAD}px`);
    expect(rowBox({ ...base, paneSide: "left", jointOpen: false, isActive: true }).borderRadius)
      .toBe(`0 ${LEAD}px ${LEAD}px 0`);
  });

  it("carries a fillet on the pane end whenever the row is selected, wired or not", () => {
    expect(rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true }).filletEnds)
      .toEqual(["right"]);
    expect(rowBox({ ...base, paneSide: "left", jointOpen: false, isActive: true }).filletEnds)
      .toEqual(["left"]);
  });
});

describe("rowBox — the joint end opens only when the cable is patched", () => {
  it("holds a plain lead radius while unplugged, and draws no fillet there", () => {
    const box = rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true });
    expect(box.borderRadius).toBe(`${LEAD}px 0 0 ${LEAD}px`);
    expect(box.filletEnds).not.toContain("left");
  });

  it("squares that end and adds its fillet once this pair holds the cable", () => {
    // Wired = all four corners are mouths: concierge ← row → terminal, a length of cable seated in
    // two sockets. This is the half the app never had.
    const box = rowBox({ ...base, paneSide: "right", jointOpen: true, isActive: true });
    expect(box.borderRadius).toBe("0 0 0 0");
    expect(box.filletEnds).toEqual(["right", "left"]);
  });

  it("mirrors that too — a wired LEFT pair opens toward the concierge on its right", () => {
    const box = rowBox({ ...base, paneSide: "left", jointOpen: true, isActive: true });
    expect(box.borderRadius).toBe("0 0 0 0");
    expect(box.filletEnds).toEqual(["left", "right"]);
  });

  it("bleeds the joint end through the column edge, on the concierge side of the pair", () => {
    expect(rowBox({ ...base, paneSide: "right", jointOpen: true, isActive: true }).marginLeft)
      .toBe(-LIST_PAD_X);
    expect(rowBox({ ...base, paneSide: "left", jointOpen: true, isActive: true }).marginRight)
      .toBe(-LIST_PAD_X);
  });
});

describe("rowBox — layout never keys off selection", () => {
  // The list-twitch bug, as an assertion. `marginRight: isActive ? -8 : 0` narrowed the row's
  // CONTENT BOX the instant you selected it, so the title under the pointer jumped ~10px on click
  // and jumped back on the next row.
  for (const paneSide of ["left", "right"] as const) {
    for (const jointOpen of [false, true]) {
      it(`gives selected and unselected rows the identical box (${paneSide}, joint ${jointOpen ? "open" : "shut"})`, () => {
        const on = rowBox({ ...base, paneSide, jointOpen, isActive: true });
        const off = rowBox({ ...base, paneSide, jointOpen, isActive: false });
        expect(off.padding).toBe(on.padding);
        expect(off.marginLeft).toBe(on.marginLeft);
        expect(off.marginRight).toBe(on.marginRight);
      });
    }
  }

  it("paints nothing extra on an unselected row", () => {
    const off = rowBox({ ...base, paneSide: "right", jointOpen: true, isActive: false });
    expect(off.filletEnds).toEqual([]);
    expect(off.borderRadius).toBe(IDLE);
  });
});

describe("rowBox — the ink does not move", () => {
  // Compensation is the whole reason a bleed is safe: every end that reaches through the column's
  // edge pays the same distance back in padding. If these diverge, selecting an agent or patching
  // the cable shifts every title in the column sideways.
  for (const paneSide of ["left", "right"] as const) {
    for (const jointOpen of [false, true]) {
      it(`holds the ink at a constant inset on both edges (${paneSide}, joint ${jointOpen ? "open" : "shut"})`, () => {
        const box = rowBox({ ...base, paneSide, jointOpen, isActive: true });
        expect(inkInset(box, "left")).toBe(LIST_PAD_X + ROW_PAD_X);
        expect(inkInset(box, "right")).toBe(LIST_PAD_X + ROW_PAD_X);
      });
    }
  }

  it("compensates a bleeding end by exactly the list padding, no more and no less", () => {
    expect(ROW_PAD_COMPENSATED).toBe(ROW_PAD_X + LIST_PAD_X);
  });
});

describe("rowBox — the worker indent", () => {
  it("moves the INK right by the indent in both pairs, since the text runs left-to-right", () => {
    // Asserted on the ink rather than on `marginLeft`, which was the mistake the old case encoded:
    // it pinned the ARITHMETIC (`32 - LIST_PAD_X`) and so froze the bug in place as the contract.
    for (const paneSide of ["left", "right"] as const) {
      for (const jointOpen of [false, true]) {
        const plain = rowBox({ ...base, paneSide, jointOpen, isActive: false });
        const nested = rowBox({ ...base, paneSide, jointOpen, isActive: false, depthIndent: 32 });
        expect(inkInset(nested, "left")).toBe(inkInset(plain, "left") + 32);
      }
    }
  });

  // THE REGRESSION THIS RULE EXISTS FOR. The indent used to be added to `marginLeft` outright, so on
  // a left end that was OPEN it cancelled the bleed and then some: a depth-1 worker in a LEFT pair
  // got `-8 + 32 = 24`, positive, and the selected row stopped touching its terminal — with the
  // concave mouths still drawn at the row's edge, opening onto the column instead of onto the pane.
  // The right pair hit the identical thing the moment the cable was patched (`jointOpen` opens its
  // left end too); it only ever looked correct because unwired-right is the one case where the
  // indent lands on the SHUT side.
  it("never lets the indent pull an OPEN end back off the column's edge", () => {
    for (const paneSide of ["left", "right"] as const) {
      for (const jointOpen of [false, true]) {
        for (const depthIndent of [0, 32, 64]) {
          const box = rowBox({ ...base, paneSide, jointOpen, isActive: true, depthIndent });
          if (paneSide === "left" || jointOpen) expect(box.marginLeft).toBe(-LIST_PAD_X);
          // The right end never carries the indent, so it is unaffected at every depth.
          expect(box.marginRight).toBe(paneSide === "right" || jointOpen ? -LIST_PAD_X : 0);
        }
      }
    }
  });

  it("carries the indent in MARGIN on a shut end and in PADDING on an open one", () => {
    // Both spellings put the ink in the same place; the difference is whether the BOX still reaches
    // the column's edge, which is what the mouths are drawn against.
    const shut = rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true, depthIndent: 32 });
    expect(shut.marginLeft).toBe(32);
    expect(shut.padding.split(" ")[3]).toBe(`${ROW_PAD_X}px`);

    const open = rowBox({ ...base, paneSide: "left", jointOpen: false, isActive: true, depthIndent: 32 });
    expect(open.marginLeft).toBe(-LIST_PAD_X);
    expect(open.padding.split(" ")[3]).toBe(`${ROW_PAD_COMPENSATED + 32}px`);
  });
});

describe("rowBox — the PINNED row reaches the same ink line from a different baseline", () => {
  // The Improve Sparkle footer sits outside the padded scroll container, so it already touches the
  // column's edges: its open end takes margin 0 rather than a negative one, and its shut end is
  // held off by a POSITIVE margin. Two baselines, ONE ink line — which is the whole claim that the
  // pinned row and a build row are the same anatomy.
  const inset = (box: ReturnType<typeof rowBox>, side: "left" | "right") => {
    const parts = box.padding.split(" ").map((p) => parseFloat(p));
    const pad = side === "left" ? parts[3]! : parts[1]!;
    return (side === "left" ? box.marginLeft : box.marginRight) + pad;
  };

  for (const paneSide of ["left", "right"] as const) {
    for (const jointOpen of [false, true]) {
      it(`lands the ink at the same inset as a list row (${paneSide}, joint ${jointOpen ? "open" : "shut"})`, () => {
        const box = rowBox({ ...base, paneSide, jointOpen, isActive: true, pinned: true });
        // No list padding to add: this row is outside the container.
        expect(inset(box, "left")).toBe(LIST_PAD_X + ROW_PAD_X);
        expect(inset(box, "right")).toBe(LIST_PAD_X + ROW_PAD_X);
      });
    }
  }

  it("never bleeds — a pinned row is already at the edge, so its open end takes margin 0", () => {
    const box = rowBox({ ...base, paneSide: "right", jointOpen: false, isActive: true, pinned: true });
    expect(box.marginRight).toBe(0);
    expect(box.marginLeft).toBe(LIST_PAD_X);
  });

  it("mirrors its inset for a left pair", () => {
    const box = rowBox({ ...base, paneSide: "left", jointOpen: false, isActive: true, pinned: true });
    expect(box.marginLeft).toBe(0);
    expect(box.marginRight).toBe(LIST_PAD_X);
  });

  it("paints exactly what a list row paints — same corners, same mouths", () => {
    for (const paneSide of ["left", "right"] as const) {
      for (const jointOpen of [false, true]) {
        const list = rowBox({ ...base, paneSide, jointOpen, isActive: true });
        const pin = rowBox({ ...base, paneSide, jointOpen, isActive: true, pinned: true });
        expect(pin.borderRadius).toBe(list.borderRadius);
        expect(pin.filletEnds).toEqual(list.filletEnds);
      }
    }
  });
});

describe("oppositeSide", () => {
  it("is the other one", () => {
    expect(oppositeSide("left")).toBe("right");
    expect(oppositeSide("right")).toBe("left");
  });
});
