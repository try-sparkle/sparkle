// The words and colors every band-showing surface reads — pinned here so no surface has to own the
// grammar itself.
//
// The founder was explicit about the count label agreeing in number: "1 Needs you" but "3 Need you".
// That rule has exactly one interesting input (n === 1) and four places that render it (the project
// tab badge, the concierge vitals line, the brain snapshot, and the sidebar chips), so it lives in
// ONE helper and is tested ONCE. A per-surface copy is a rule that drifts silently — nothing goes red
// when the fourth surface gets it wrong.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { STATUS_BANDS, type StatusBand } from "./buildSections";
import { bandColor, bandCountLabel, bandLabel } from "./statusBandLabels";

describe("bandLabel", () => {
  it("is the band's own label from STATUS_BANDS, not a second copy of the words", () => {
    expect(bandLabel("needs_you")).toBe("Needs you");
    expect(bandLabel("running")).toBe("Running");
    expect(bandLabel("done")).toBe("Done");
    for (const b of STATUS_BANDS) expect(bandLabel(b.id)).toBe(b.label);
  });
});

describe("bandCountLabel — agrees in number", () => {
  it("uses the singular verb for exactly one and the plural for anything else", () => {
    expect(bandCountLabel("needs_you", 1)).toBe("1 Needs you");
    expect(bandCountLabel("needs_you", 2)).toBe("2 Need you");
    expect(bandCountLabel("needs_you", 27)).toBe("27 Need you");
  });

  it("still says 'Need you' at zero — English agrees zero with the plural", () => {
    // Surfaces gate on the count before rendering, so this string is rarely shown; getting it wrong
    // anyway would be the kind of thing that only surfaces in a screenshot.
    expect(bandCountLabel("needs_you", 0)).toBe("0 Need you");
  });

  it("leaves the adjectival bands alone — they never inflect", () => {
    expect(bandCountLabel("running", 1)).toBe("1 Running");
    expect(bandCountLabel("running", 4)).toBe("4 Running");
    expect(bandCountLabel("done", 1)).toBe("1 Done");
    expect(bandCountLabel("done", 9)).toBe("9 Done");
  });

  it("always starts with the number and then the band's words", () => {
    for (const b of STATUS_BANDS) {
      for (const n of [0, 1, 2, 40]) {
        expect(bandCountLabel(b.id, n).startsWith(`${n} `)).toBe(true);
      }
    }
  });
});

describe("bandColor", () => {
  it("is taken from the band's own colorFrom status, never a hardcoded hex", () => {
    for (const b of STATUS_BANDS) {
      expect(bandColor(b.id)).toBe(AGENT_STATUS[b.colorFrom].color);
    }
  });

  it("paints Needs-you the alarm red and Done the calm gray — one alarm color total", () => {
    expect(bandColor("needs_you")).toBe(AGENT_STATUS.waiting.color);
    expect(bandColor("done")).toBe(AGENT_STATUS.idle.color);
    expect(bandColor("running")).not.toBe(bandColor("needs_you"));
    // Every band is a DIFFERENT color; two bands sharing one would make the chips unreadable.
    const seen = new Set<string>(STATUS_BANDS.map((b) => bandColor(b.id as StatusBand)));
    expect(seen.size).toBe(STATUS_BANDS.length);
  });
});
