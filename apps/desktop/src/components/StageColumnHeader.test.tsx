// @vitest-environment jsdom
//
// The board's "Define …" CTA is a live consumer of ROW_ACTIVE_BUBBLE, and it was the one site that
// paired that THEMED fill with ON_BRAND_FILL — the constant-cream ink.
//
// That constant is correct for a fill that does NOT change across themes (the teal/cyan brand
// shapes: the fill stays put, so its ink must stay light in both). ROW_ACTIVE_BUBBLE is not one of
// those. It is themed, and in light mode it becomes a mid blue on which a constant light ink falls
// under the AA floor — so the button's own label was the least readable thing on the column. The
// themed fill takes the themed ink, which is what DefineStageModal's primary button (same token)
// already did.
//
// The ink VALUES are floored in theme/chromeContrast.test.ts ("`cream` stays readable ON every
// chrome FILL"). What this pins is that the site reaches for the themed pair at all.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DefineStageCta } from "./StageColumnHeader";
import { C, ROW_ACTIVE_BUBBLE } from "../theme/colors";

afterEach(() => cleanup());

describe("StageColumnHeader — the Define CTA is a themed fill/ink PAIR", () => {
  // THE LOAD-BEARING ASSERTION IS `toBe(C.cream)`. It is an EQUALITY, so it already excludes every
  // other value including the old `ON_BRAND_FILL` — reverting the source to that constant fails
  // this line, which is what makes the guard real.
  //
  // A trailing `expect(cta.style.color).not.toBe(ON_BRAND_FILL)` used to sit here and CANNOT FAIL,
  // for two independent reasons: the equality above has already fixed the value, and `ON_BRAND_FILL`
  // is a hex literal that jsdom re-serializes to `rgb(...)` on read, so the comparison never matches
  // in either direction. Its comment claimed the opposite ("this genuinely rules the old pairing
  // out"), which is exactly how a dead assertion survives review. Same class as the two deleted in
  // roborev 53570 — deleted for the same reason rather than carried a third time.
  //
  // The ink VALUES are floored separately in theme/chromeContrast.test.ts ("`cream` stays readable
  // ON every chrome FILL"); what this test pins is that the site reaches for the themed pair at all.
  it("the CTA takes the themed cream on the themed row fill, never the constant on-brand ink", () => {
    render(<DefineStageCta stageKey="done" label="Done" onDefine={vi.fn()} />);
    const cta = screen.getByRole("button", { name: /Define “Done”/ });
    expect(cta.style.background).toBe(ROW_ACTIVE_BUBBLE);
    expect(cta.style.color).toBe(C.cream);
  });
});
