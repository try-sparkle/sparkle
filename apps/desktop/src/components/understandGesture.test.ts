// @vitest-environment jsdom
//
// The pure decision behind drag-to-understand rung one (epic sparkle-0kbf4s), plus a guard on the
// two production sites that opt OUT of it.
//
// WHY THE OPT-OUT SITES ARE ASSERTED FROM SOURCE: every behavioural test in DragToUnderstand.test
// sets the attribute itself, so the lines in Terminal.tsx and Workspace.tsx that supply it in
// production are covered by nothing — delete either and the whole suite stays green while the
// affordance starts stacking a second copy chip over surfaces that already answer their own
// selections. That is the "defaulted seam" shape AGENTS.md names, and reading the source is the
// cheap way to close it: rendering either component in full costs a mount of the entire workspace.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_GESTURE_ATTR } from "./Concierge/controlGesture";
import {
  SELECTION_AFFORDANCE_ATTR,
  SELECTION_AFFORDANCE_OWN,
  ownsSelectionAffordance,
  understandGesture,
} from "./understandGesture";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A Selection stand-in — `understandGesture` reads only these three things. */
function sel(text: string, { collapsed = false, ranges = 1 } = {}): Selection {
  return {
    rangeCount: ranges,
    isCollapsed: collapsed,
    toString: () => text,
  } as unknown as Selection;
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.querySelector("[data-leaf]") as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ownsSelectionAffordance", () => {
  it("is false for ordinary content", () => {
    expect(ownsSelectionAffordance(mount(`<p data-leaf>hi</p>`))).toBe(false);
  });

  it("is true inside a surface that declared itself", () => {
    const leaf = mount(
      `<div ${SELECTION_AFFORDANCE_ATTR}="${SELECTION_AFFORDANCE_OWN}"><p data-leaf>hi</p></div>`,
    );
    expect(ownsSelectionAffordance(leaf)).toBe(true);
  });

  // THE REASON THIS IS A HAND-ROLLED WALK AND NOT `closest`. `closest` stops at the nearest element
  // CARRYING the attribute; if that one carries some other value it would report "not owned" for a
  // node that is nonetheless inside an owning surface further up.
  it("keeps climbing past an element whose value is not the opt-out", () => {
    const leaf = mount(
      `<div ${SELECTION_AFFORDANCE_ATTR}="${SELECTION_AFFORDANCE_OWN}">` +
        `<div ${SELECTION_AFFORDANCE_ATTR}="something-else"><p data-leaf>hi</p></div>` +
        `</div>`,
    );
    expect(ownsSelectionAffordance(leaf)).toBe(true);
  });

  it("reads a text node through its parent", () => {
    const leaf = mount(
      `<div ${SELECTION_AFFORDANCE_ATTR}="${SELECTION_AFFORDANCE_OWN}"><p data-leaf>hi</p></div>`,
    );
    expect(ownsSelectionAffordance(leaf.firstChild)).toBe(true);
  });

  it("is false for a null target", () => {
    expect(ownsSelectionAffordance(null)).toBe(false);
  });
});

describe("understandGesture", () => {
  const content = () => mount(`<p data-leaf>some words</p>`);

  it("accepts a real sweep over ordinary content", () => {
    expect(understandGesture({ selection: sel("some words"), pressTarget: content() })).toEqual({
      text: "some words",
    });
  });

  it("refuses a collapsed selection", () => {
    expect(
      understandGesture({ selection: sel("", { collapsed: true }), pressTarget: content() }),
    ).toBeNull();
  });

  it("refuses when there is no selection at all", () => {
    expect(understandGesture({ selection: null, pressTarget: content() })).toBeNull();
  });

  it("refuses a selection with no ranges", () => {
    expect(
      understandGesture({ selection: sel("x", { ranges: 0 }), pressTarget: content() }),
    ).toBeNull();
  });

  it("refuses whitespace, however much of it", () => {
    expect(understandGesture({ selection: sel("  \n\t "), pressTarget: content() })).toBeNull();
  });

  it("refuses a press that landed on a control", () => {
    const leaf = mount(`<div ${CONTROL_GESTURE_ATTR}="yes"><p data-leaf>some words</p></div>`);
    expect(understandGesture({ selection: sel("some words"), pressTarget: leaf })).toBeNull();
  });

  it("refuses a surface that owns its own affordance", () => {
    const leaf = mount(
      `<div ${SELECTION_AFFORDANCE_ATTR}="${SELECTION_AFFORDANCE_OWN}"><p data-leaf>some words</p></div>`,
    );
    expect(understandGesture({ selection: sel("some words"), pressTarget: leaf })).toBeNull();
  });

  // A press rarely lands on the control's own root — it lands on a label, an icon or a text node
  // inside it. The refusal has to climb, or every control with a child is unguarded.
  it("refuses a press on a node nested deep inside a control", () => {
    const leaf = mount(
      `<div ${CONTROL_GESTURE_ATTR}="yes"><span><em><p data-leaf>some words</p></em></span></div>`,
    );
    expect(understandGesture({ selection: sel("some words"), pressTarget: leaf })).toBeNull();
    // …and the same shape WITHOUT the control still reaches the affordance, so the refusal above
    // cannot be passing because of the nesting itself.
    const plain = mount(`<div><span><em><p data-leaf>some words</p></em></span></div>`);
    expect(understandGesture({ selection: sel("some words"), pressTarget: plain })).toEqual({
      text: "some words",
    });
  });
});

// ── THE SEAM GUARD ────────────────────────────────────────────────────────────────────────────────
describe("the surfaces that already answer their own selections declare it", () => {
  const declares = (relPath: string) =>
    readFileSync(join(HERE, relPath), "utf8").includes("SELECTION_AFFORDANCE_ATTR");

  it("the terminal pane opts out", () => {
    expect(declares("Terminal.tsx")).toBe(true);
  });

  it("the concierge column opts out", () => {
    expect(declares("Workspace.tsx")).toBe(true);
  });
});
