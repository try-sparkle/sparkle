// @vitest-environment jsdom
//
// `.grp` — the Build column's stage-ladder group header, ported from the blueprint cockpit mock
// (PRD/sparkle/ui-directions/rev4.html).
//
//   .grp{…gap:7px;padding:7px 10px 4px;font:500 var(--t-micro)/1 var(--k-mono);
//        letter-spacing:.1em;text-transform:uppercase;color:var(--k-faint)}
//   .grp .rule{flex:1;height:1px;background:var(--k-rule)}
//
// THREE PARTS IN ONE ORDER: label · rule · count. The rule is the part the header did not have, and
// it is not decoration — it is what carries the flex. Before, the LABEL took `flex:1`, so the header
// was a line of text with a number stranded at the far right and nothing joining them; the ladder
// read as loose spans rather than as a drawn instrument. Pinning the ORDER as well as the flex is
// deliberate: a rule that renders after the count still fills a gap and still looks plausible in
// isolation, and would silently move the tally away from the column's right edge.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StageSectionHeader } from "./StageSectionHeader";
import { sectionMeta } from "../engine/buildSections";
import { C } from "../theme/colors";
import { FONT_MONO, TYPE } from "../theme/scale";

afterEach(cleanup);

const meta = sectionMeta("local_committed");
const renderHeader = (count = 3) => {
  render(<StageSectionHeader meta={meta} count={count} />);
  return screen.getByTestId(`stage-header-${meta.id}`);
};

describe("`.grp` — the stage-ladder group header", () => {
  it("lays out label · rule · count, in that order", () => {
    const header = renderHeader();
    const [label, rule, count] = Array.from(header.children) as HTMLElement[];

    expect(label!.textContent).toBe(meta.label);
    expect(rule!.dataset.testid).toBe(`stage-header-rule-${meta.id}`);
    expect(count!.textContent).toBe("3");
  });

  it("gives the RULE the flex, not the label — so the line fills what is left", () => {
    const header = renderHeader();
    const [label, rule, count] = Array.from(header.children) as HTMLElement[];

    // jsdom expands the `flex: 1` shorthand; grow is the part that matters.
    expect(rule!.style.flexGrow).toBe("1");
    expect(rule!.style.height).toBe("1px");
    // The label sizes to its own words and the count never moves off the right edge.
    expect(label!.style.flexGrow).not.toBe("1");
    expect(count!.style.flex).toBe("0 0 auto");
  });

  // The design's single most characteristic mark (theme/scale.ts calls it exactly that), and the
  // one the column had none of: mono, 10px, uppercase, tracked. It was system-ui at letterSpacing
  // 0.6 — a different typeface saying a similar thing, which is most of why the running app read as
  // a different product from the design.
  it("takes the tracked mono LABEL treatment", () => {
    const header = renderHeader();
    expect(header.style.fontFamily).toBe(FONT_MONO);
    expect(header.style.fontSize).toBe(`${TYPE.micro}px`);
    expect(header.style.textTransform).toBe("uppercase");
    expect(header.style.letterSpacing).toBe("0.1em");
  });

  // THE TREATMENT IS PORTED; THE INK IS NOT, and that is deliberate. The mock paints every tracked
  // micro label `--k-faint` — `agentIdle` here — and on the surface this header actually paints on
  // (`deepForest`, which IS the spec's own `bridge`) that measures 3.377:1 in light and 4.353:1 in
  // dark. Both are under AA, for what is 10px UI TEXT rather than a dot; `muted` is 5.678 / 7.169
  // on the same surface. Asserted as a PAIRING, not just `=== C.muted`: `agentIdle` has no
  // ink-floor sweep anywhere (statusInk.test.ts pins only the mapping), so naming the rejected
  // token is the only thing that makes the next "let's match the spec exactly" pass go red here
  // instead of silently shipping a label nobody can read.
  it("keeps the readable secondary ink — the spec's faint tier is under AA on this column", () => {
    const header = renderHeader();
    expect(header.style.color).toBe(C.muted);
    expect(header.style.color).not.toBe(C.agentIdle);
  });

  // Tabular numerals: a section gaining a tenth row must not shift the label beside it.
  it("holds the count's width as the number changes", () => {
    const header = renderHeader(9);
    const count = header.children[2] as HTMLElement;
    expect(count.style.fontVariantNumeric).toBe("tabular-nums");
  });
});
