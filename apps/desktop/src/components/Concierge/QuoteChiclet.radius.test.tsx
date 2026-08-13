// @vitest-environment jsdom
//
// THE "QUOTE IN RESPONSE" CHICLET IS NOT A PILL. Founder, 2026-08-12:
//
//   *"Make this quote response button less rounded I can't stand the rounded buttons like that."*
//
// It was `borderRadius: PILL` (999) — a full capsule — and the comment beside it argued the capsule
// was a deliberate choice. It was; it has been overruled.
//
// ── WHY THIS IS PINNED AT ALL, GIVEN IT IS ONE NUMBER ──────────────────────────────────────────
//
// Because "less rounded" has no natural floor, and the next person to touch this file has no way of
// knowing the capsule was rejected rather than never considered. Without a test, the reflex that put
// `PILL` here once puts it back — the same reflex `theme/scale.ts` keeps `ALLOWED_RADIUS` for.
//
// It asserts against the SCALE rather than against a literal 4. `RADIUS.input` is the app's own
// workhorse step ("inputs, buttons, cards, the chat bubble"), so this says *"this control is rounded
// like every other button"*, which is the durable form of the instruction — a repo-wide re-tint of
// the scale should move this control with it, and only a re-tint that made buttons capsules should
// fail here.
//
// The PIXELS are `scripts/visual/quote-surface-probe.mjs`, which reads the computed radius in Chrome
// in both themes. This file and that one are not redundant: a token could be re-pointed at a capsule
// value and this test, reading the same token, would move with it — the probe reads px.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuoteChiclet, QUOTE_CHICLET_TESTID } from "./QuoteChiclet";
import { PILL, RADIUS } from "../../theme/scale";

afterEach(() => cleanup());

function renderChiclet() {
  render(<QuoteChiclet x={10} y={10} onQuote={vi.fn()} onDismiss={vi.fn()} />);
  return screen.getByTestId(QUOTE_CHICLET_TESTID);
}

describe("the quote-response chiclet's corners", () => {
  it("uses the scale's BUTTON step, not a capsule", () => {
    expect(renderChiclet().style.borderRadius).toBe(`${RADIUS.input}px`);
  });

  it("is not the PILL token — the shape the founder rejected, named", () => {
    // Stated separately and in terms of the rejected value. The assertion above would also fail if
    // someone moved this to `RADIUS.sm`, which is a different (and defensible) mistake; this one
    // fails only for the thing he actually objected to, so a future reader can tell the two apart
    // from the failure message alone.
    const radius = renderChiclet().style.borderRadius;
    expect(radius).not.toBe(`${PILL}px`);
    expect(Number.parseFloat(radius)).toBeLessThanOrEqual(RADIUS.modal);
  });
});
