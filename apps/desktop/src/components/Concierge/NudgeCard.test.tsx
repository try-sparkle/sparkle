// @vitest-environment jsdom
//
// The nudge card's contract: ONE red treatment (the gold "wants you eventually" accent is gone with
// the tier that justified it), the badge reads the band's own words, the project chip names the
// origin, the WHOLE card is one click target (→ onNudgeClick), and an action button fires
// onNudgeAction WITHOUT also counting as a card click.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { C } from "../../theme/colors";
import { NudgeCard, nudgeAccent } from "./NudgeCard";
import type { ConciergeNudge } from "./types";

afterEach(() => cleanup());

/** jsdom serializes inline colors as rgb(...) — compare in that form. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
}

const nudge: ConciergeNudge = {
  id: "n1",
  kind: "nudge",
  band: "needs_you",
  projectName: "drodio-website",
  agentName: "OG Image Pipeline",
  text: "OG Image Pipeline hit a build warning that needs your call — look, or let it ride?",
  actions: [
    { id: "show", label: "Show me", kind: "primary" },
    { id: "ride", label: "Let it ride", kind: "ghost" },
  ],
};

const otherNudge: ConciergeNudge = {
  ...nudge,
  id: "n0",
  projectName: "sparkle-mobile",
  agentName: "Live Remote Mirror",
  text: "EAS build just failed — a dependency didn't resolve.",
  actions: [{ id: "fix", label: "Auto-fix", kind: "primary" }],
};

describe("nudgeAccent — one red, no gold", () => {
  it("is brand sienna, and never amber", () => {
    // The amber accent belonged to the "wants you eventually" tier (`blocked`). That tier merged
    // into Needs-you, so a second alarm color on these cards would be a distinction the user can't
    // act on differently — both mean "go look".
    expect(nudgeAccent()).toBe(C.sienna);
    expect(nudgeAccent()).not.toBe(C.amber);
  });
});

describe("NudgeCard — rendering", () => {
  it("renders the red accent, the band label as its badge, the project chip, and its actions", () => {
    render(<NudgeCard nudge={nudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
    const card = screen.getByRole("button", {
      name: "Needs you — OG Image Pipeline (drodio-website)",
    });
    expect(card.getAttribute("data-band")).toBe("needs_you");
    // The band reads from the card's border tint and badge — literal brand sienna, never amber
    // (the gold tier is gone). There is deliberately NO left-edge stripe either (founder
    // 2026-07-24), so assert the POSITIVE shape: a uniform 1px border on all four edges. A bare
    // `not.toBe("3px")` passed for a 2px stripe, a 4px stripe, or any re-added asymmetric
    // borderLeft — this cannot.
    expect(card.style.border).toContain(rgb(C.sienna));
    expect(card.style.border).not.toContain(rgb(C.amber));
    expect(card.style.borderLeftWidth).toBe("1px");
    expect(card.style.borderLeftColor).toBe(card.style.borderTopColor);
    expect(card.style.borderLeftStyle).toBe(card.style.borderTopStyle);
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("drodio-website")).toBeTruthy();
    expect(screen.getByText("Show me")).toBeTruthy();
    expect(screen.getByText("Let it ride")).toBeTruthy();
  });

  it("a second card takes the SAME red — there is no per-nudge accent left to drift", () => {
    render(<NudgeCard nudge={otherNudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
    const card = screen.getByRole("button", {
      name: "Needs you — Live Remote Mirror (sparkle-mobile)",
    });
    expect(card.getAttribute("data-band")).toBe("needs_you");
    expect(card.style.border).toContain(rgb(C.sienna));
    expect(card.style.borderLeftWidth).toBe("1px");
    expect(card.style.borderLeftColor).toBe(card.style.borderTopColor);
    expect(screen.getByText("Needs you")).toBeTruthy();
  });
});

// The accent/ink split. `nudgeAccent()` stays the LITERAL sienna because it is interpolated into
// color-mix() for the card's fill, border and glow (and read back here as jsdom's rgb()); the
// BADGE on top of that fill is text, and raw sienna is under the AA floor on the near-black
// concierge column — under it by a hair, which is exactly how it stays missed.
//
// The floor lives in theme/chromeContrast.test.ts, and note WHAT it measures: the badge's label
// sits three layers up (the column, the card's sienna gradient, and then the badge's OWN
// `color-mix(sienna 16%)` fill), so the guard composites all three. It used to stop at the
// gradient, which let a `dangerInk` that clears 4.5 on the card but NOT on the badge ship under a
// test named for the badge. Structural note for anyone editing `badgeStyle`: if the badge ever
// stops painting its own fill, or paints a different percentage, that guard's stack has to move
// with it — it is a model of this component, not of the token.
describe("NudgeCard — the accent fills, dangerInk reads", () => {
  it("the badge's label is the THEMED dangerInk, not the literal accent", () => {
    render(<NudgeCard nudge={nudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
    const badge = screen.getByText("Needs you");
    expect(badge.style.color).toBe(C.dangerInk);
    expect(badge.style.color).not.toBe(rgb(C.sienna));
    // …while the fill under it still composites the LITERAL, which is what color-mix() needs.
    expect(badge.style.background).toContain(rgb(C.sienna));
  });

  it("the project chip is concierge GOLD — the prototype's `.nudge .proj`, never amber", () => {
    render(<NudgeCard nudge={nudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
    const chip = screen.getByText("drodio-website");
    expect(chip.style.color).toBe(C.goldInk);
    expect(chip.style.color).not.toBe(rgb(C.amber));
    expect(chip.style.border).toContain(rgb(C.gold));
  });
});

describe("NudgeCard — click routing", () => {
  it("clicking the card body fires onNudgeClick with the nudge", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<NudgeCard nudge={nudge} onNudgeClick={onClick} onNudgeAction={onAction} />);
    fireEvent.click(screen.getByText(nudge.text));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(nudge);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("clicking an action fires onNudgeAction and does NOT bubble into onNudgeClick", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<NudgeCard nudge={nudge} onNudgeClick={onClick} onNudgeAction={onAction} />);
    fireEvent.click(screen.getByText("Let it ride"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(nudge, "ride");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Enter on the focused card acts like a card click (it's a div, not a <button>)", () => {
    const onClick = vi.fn();
    render(<NudgeCard nudge={otherNudge} onNudgeClick={onClick} onNudgeAction={vi.fn()} />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Needs you — Live Remote Mirror (sparkle-mobile)" }),
      { key: "Enter" },
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
