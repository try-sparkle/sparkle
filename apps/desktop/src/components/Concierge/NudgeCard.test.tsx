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
    // The left accent bar is the card's strongest signal — literal brand sienna.
    expect(card.style.borderLeft).toContain(rgb(C.sienna));
    expect(card.style.borderLeft).not.toContain(rgb(C.amber));
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
    expect(card.style.borderLeft).toContain(rgb(C.sienna));
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
