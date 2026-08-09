// @vitest-environment jsdom
//
// ModalShell is the chrome for eleven dialogs, so it is the ONE place worth pinning the modal
// plane's identity. The values it used to carry were `deepForest` (the BUILDER COLUMN's plane) plus
// two hand-typed black constants, and the reason that survived so long is that nothing could see it:
// a contrast guard measures tokens against each other and never asks which token a component
// reached for, and every dialog looked self-consistently fine while sitting a plane too dark.
//
// These assert the tokens by NAME, on the rendered element. That is deliberate — the check has to
// fail when someone re-points the surface at another plane, which a colour-value check written
// against `var(--c-…)` strings cannot do, and which no amount of contrast measurement will catch.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModalShell } from "./ModalShell";
import { RADIUS } from "../theme/scale";
import { expectBoundedCard } from "./dialogCardGeometryTestUtils";

afterEach(cleanup);

const noop = () => {};

/** scrim > card > body > children. The body is the SCROLLPORT and the card is the painted plane —
 *  they are separate elements because the card must be bounded to the viewport while something
 *  inside it scrolls, so every assertion below has to name which of the two it means. */
function parts() {
  const body = screen.getByTestId("modal-shell-body");
  const card = body.parentElement as HTMLElement;
  const scrim = card.parentElement as HTMLElement;
  return { body, card, scrim };
}

function renderShell() {
  render(
    <ModalShell onCancel={noop}>
      <div data-testid="shell-body">body</div>
    </ModalShell>,
  );
  return parts();
}

describe("ModalShell paints the spec's modal plane", () => {
  // Fifteen dialogs inherit this card, so this is the highest-leverage place the geometry rule is
  // pinned: bounded to the viewport, and the scroll on the BODY rather than the card — a card that
  // is its own scrollport carries whatever pinned chrome a consumer put at the top off the screen.
  it("is bounded to the viewport and scrolls its body, not the card", () => {
    const { body, card } = renderShell();
    expectBoundedCard({ card, scrollport: body });
  });

  it("the card takes the DIALOG surface, not the builder column's plane", () => {
    const { card } = renderShell();
    expect(card.style.background).toBe("var(--c-dialog-surface)");
    // The regression guarded against, named so a revert reads as a revert: `deepForest` is the
    // builder column, and a modal is not a panel inside the shell.
    expect(card.style.background).not.toContain("deep-forest");
  });

  it("the card's outline is the modal's OWN edge, not the shell's column seam", () => {
    const { card } = renderShell();
    // `dialogEdge` is a full step stronger than `hairline` in dark — a floating surface needs a
    // harder boundary than an interior rule, and the spec draws them as different tokens.
    expect(card.style.border).toBe("1px solid var(--c-dialog-edge)");
  });

  it("the scrim and the shadow are THEMED, not the flat black every dialog used to hand-type", () => {
    const { card, scrim } = renderShell();
    expect(scrim.style.background).toBe("var(--k-scrim)");
    expect(card.style.boxShadow).toBe("var(--k-shadow)");
    // The literal that was there. In light mode it washed a near-white shell in half-black.
    expect(scrim.style.background).not.toContain("rgba");
    expect(card.style.boxShadow).not.toContain("rgba");
  });

  it("the corner is the modal radius from the scale — near-square, not a pill", () => {
    const { card } = renderShell();
    expect(card.style.borderRadius).toBe(`${RADIUS.modal}px`);
    expect(RADIUS.modal).toBe(6);
  });
});
