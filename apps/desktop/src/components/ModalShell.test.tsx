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

afterEach(cleanup);

const noop = () => {};

/** The card is the scrim's only element child; the scrim is the outermost node rendered. */
function parts() {
  const card = screen.getByTestId("shell-body").parentElement as HTMLElement;
  const scrim = card.parentElement as HTMLElement;
  return { card, scrim };
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
