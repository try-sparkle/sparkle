// @vitest-environment jsdom
//
// The nudge card's contract: P1 renders gold, P0 renders red, the project chip names the
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

const p1Nudge: ConciergeNudge = {
  id: "n1",
  kind: "nudge",
  priority: "p1",
  projectName: "drodio-website",
  agentName: "OG Image Pipeline",
  text: "OG Image Pipeline hit a build warning that needs your call — look, or let it ride?",
  actions: [
    { id: "show", label: "Show me", kind: "primary" },
    { id: "ride", label: "Let it ride", kind: "ghost" },
  ],
};

const p0Nudge: ConciergeNudge = {
  ...p1Nudge,
  id: "n0",
  priority: "p0",
  projectName: "sparkle-mobile",
  agentName: "Live Remote Mirror",
  text: "EAS build just failed — a dependency didn't resolve.",
  actions: [{ id: "fix", label: "Auto-fix", kind: "primary" }],
};

describe("nudgeAccent — the prototype's gold/red mapped onto brand tokens", () => {
  it("P1 → amber (gold), P0 → sienna (red)", () => {
    expect(nudgeAccent("p1")).toBe(C.amber);
    expect(nudgeAccent("p0")).toBe(C.sienna);
  });
});

describe("NudgeCard — rendering", () => {
  it("a P1 nudge renders the gold accent, project chip, badge, and its actions", () => {
    render(
      <NudgeCard nudge={p1Nudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />,
    );
    const card = screen.getByRole("button", {
      name: "P1 — OG Image Pipeline (drodio-website)",
    });
    expect(card.getAttribute("data-priority")).toBe("p1");
    // The left accent bar is the card's strongest priority signal — literal brand amber.
    expect(card.style.borderLeft).toContain(rgb(C.amber));
    expect(screen.getByText("P1")).toBeTruthy();
    expect(screen.getByText("drodio-website")).toBeTruthy();
    expect(screen.getByText("Show me")).toBeTruthy();
    expect(screen.getByText("Let it ride")).toBeTruthy();
  });

  it("a P0 nudge renders the red accent instead", () => {
    render(
      <NudgeCard nudge={p0Nudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />,
    );
    const card = screen.getByRole("button", {
      name: "P0 — Live Remote Mirror (sparkle-mobile)",
    });
    expect(card.getAttribute("data-priority")).toBe("p0");
    expect(card.style.borderLeft).toContain(rgb(C.sienna));
    expect(screen.getByText("P0")).toBeTruthy();
  });
});

describe("NudgeCard — click routing", () => {
  it("clicking the card body fires onNudgeClick with the nudge", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<NudgeCard nudge={p1Nudge} onNudgeClick={onClick} onNudgeAction={onAction} />);
    fireEvent.click(screen.getByText(p1Nudge.text));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(p1Nudge);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("clicking an action fires onNudgeAction and does NOT bubble into onNudgeClick", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<NudgeCard nudge={p1Nudge} onNudgeClick={onClick} onNudgeAction={onAction} />);
    fireEvent.click(screen.getByText("Let it ride"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(p1Nudge, "ride");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Enter on the focused card acts like a card click (it's a div, not a <button>)", () => {
    const onClick = vi.fn();
    render(<NudgeCard nudge={p0Nudge} onNudgeClick={onClick} onNudgeAction={vi.fn()} />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "P0 — Live Remote Mirror (sparkle-mobile)" }),
      { key: "Enter" },
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
