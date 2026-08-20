// @vitest-environment jsdom
//
// The founder asked for the ERROR variant of the mounted notice to read as inline RED text: red ink
// (the themed `dangerInk` token, not a hardcoded hex), no bordered box wider than the composer, and
// no `>_` terminal prompt glyph. The INFO variant is unchanged — muted, boxed, with the glyph.
//
// These rows pin the SIDE EFFECT of the tone branch, not a precondition: the actual rendered
// `color`, the actual `padding`/`border`/`borderRadius` on the node, and the actual presence or
// absence of the `>_` text. Colours are compared through a PROBE element set to the same token, so
// the assertion holds regardless of how jsdom normalises a `var(--c-*)` value — the same technique
// LogoWaveform.render.test.tsx uses. A test that read the raw `var(...)` string on only one side
// would pass even if the component painted the wrong token.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MountedNotice, MOUNTED_NOTICE_TESTID } from "./MountedNotice";
import type { MountedNoticeModel } from "./MountedNotice";
import { C } from "../../theme/colors";

afterEach(() => cleanup());

const warn: MountedNoticeModel = {
  text: "Kraken's screen is busy right now — I'll send that the moment it clears.",
  tone: "warn",
  seq: 1,
};
const info: MountedNoticeModel = {
  text: "Said it would do it.",
  tone: "info",
  seq: 1,
};

/** Read a token back through the DOM's own colour normalisation, so both sides of an equality are
 *  compared in the same serialised form (rgb(...), the raw var, whatever jsdom keeps). */
function normalizedColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = token;
  return probe.style.color;
}

describe("MountedNotice — error variant is red, unboxed, glyph-free", () => {
  it("warn: red dangerInk ink, no box (no padding/border/radius), no >_ glyph", () => {
    render(<MountedNotice notice={warn} />);
    const el = screen.getByTestId(MOUNTED_NOTICE_TESTID);

    // 1. RED text, via the themed token — not muted, and not a hardcoded value.
    expect(el.style.color).toBe(normalizedColor(C.dangerInk));
    expect(el.style.color).not.toBe(normalizedColor(C.conciergeMuted));

    // 2. NO box: none of the three properties that drew the bordered container are set.
    expect(el.style.border).toBe("");
    expect(el.style.padding).toBe("");
    expect(el.style.borderRadius).toBe("");

    // 3. NO `>_` glyph, but the sentence itself still renders in full.
    expect(el.textContent).not.toContain(">_");
    expect(el.textContent).toContain("busy right now");
  });

  it("info: unchanged — muted ink, boxed, with the >_ glyph", () => {
    render(<MountedNotice notice={info} />);
    const el = screen.getByTestId(MOUNTED_NOTICE_TESTID);

    // Muted register, and specifically NOT the red the warn tone uses.
    expect(el.style.color).toBe(normalizedColor(C.conciergeMuted));
    expect(el.style.color).not.toBe(normalizedColor(C.dangerInk));

    // Still boxed: padding + radius are the box that warn drops.
    expect(el.style.padding).toBe("5px 8px");
    expect(el.style.borderRadius).toBe("4px");

    // Still carries the terminal prompt mark.
    expect(el.textContent).toContain(">_");
    expect(el.textContent).toContain("Said it would do it.");
  });
});
