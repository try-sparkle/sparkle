// @vitest-environment jsdom
//
// The mode strip's INACTIVE state, tied to the palette measurement that justifies it.
//
// theme/chromeContrast.test.ts measures the grayscaled gold against `onGoldFill` — but it measures
// TOKENS, and a token test cannot see what the component paints. Re-adding `opacity: 0.9`, softening
// the filter to `grayscale(0.6)` or dropping it entirely all leave that measurement green while the
// 13px label goes back under AA (5.17:1 → 4.28:1 in light, because opacity composites the label as
// well as the fill). This file is the other half: what the button actually carries (roborev 54025).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanBuildToggle } from "./PlanBuildToggle";
import { C, ON_GOLD_FILL } from "../theme/colors";
import { RADIUS } from "../theme/scale";

afterEach(cleanup);

const props = { beadsEnabled: true, onPickPlan: vi.fn(), onPickBuild: vi.fn() };
const chevron = (hint: "plan" | "build") =>
  document.querySelector<HTMLElement>(`[data-hint="${hint}"]`)!;

describe("PlanBuildToggle — the inactive chevron desaturates and NOTHING else", () => {
  it("grayscales the mode that is not active", () => {
    render(<PlanBuildToggle mode="build" {...props} />);
    expect(chevron("plan").style.filter).toBe("grayscale(1)");
    expect(chevron("build").style.filter).toBe("none");
  });

  it("carries no opacity in either state — that is what took the label under AA", () => {
    // Not "opacity is 1": an explicit 0.9 is the regression, and an empty string is the only state
    // that proves the property was never set rather than set back to a safe-looking value.
    render(<PlanBuildToggle mode="build" {...props} />);
    expect(chevron("plan").style.opacity).toBe("");
    expect(chevron("build").style.opacity).toBe("");
  });

  it("paints the MEASURED pair — goldFill under onGoldFill — on both chevrons", () => {
    // Identity, not just equality (roborev 54038). Asserting the two chevrons match each other is
    // true by construction, since both read the same constant regardless of `active`: repointing
    // that constant at another token would keep this file green AND keep chromeContrast's
    // grayscaled-gold measurement green, because that test reads THEME_HEX and never reads the
    // component. Naming the tokens is what makes the measured pair and the painted pair one pair.
    render(<PlanBuildToggle mode="plan" {...props} />);
    for (const hint of ["plan", "build"] as const) {
      expect(chevron(hint).style.background).toBe(C.goldFill);
      expect(chevron(hint).style.color).toBe(ON_GOLD_FILL);
    }
  });

  it("drops Plan entirely when Beads is off, rather than showing a dead chevron", () => {
    render(<PlanBuildToggle mode="build" {...props} beadsEnabled={false} />);
    expect(document.querySelector('[data-hint="plan"]')).toBeNull();
    expect(screen.getByText("Build")).toBeTruthy();
  });
});

// ── THE `.mini` VARIANT — the blueprint cockpit's `.bhd` segment ───────────────────────────────
//
// The Build column's header is a 34px band holding the mode segment AND the status-filter chips.
// The chevron strip cannot live there: it is taller than the band and full-width by construction.
// The alternative to a variant was a SECOND Plan/Build control drawn inline in AgentSidebar — two
// implementations of one mode selector, left to drift. What is pinned here is that `mini` is the
// same CONTROL (same handlers, same `data-hint` handles the keyboard-hint overlay finds it by),
// only drawn as the mock draws it: a bordered `--r-sm` box, `--t-micro` labels, no chevron geometry.
describe("PlanBuildToggle — the `.bhd` mini segment", () => {
  const mini = () => screen.getByTestId("plan-build-mini");

  it("is a bordered, near-square box — not the chevron strip", () => {
    render(<PlanBuildToggle mode="build" variant="mini" {...props} />);
    expect(mini().style.border).toBe(`1px solid ${C.pillFill}`);
    expect(mini().style.borderRadius).toBe(`${RADIUS.sm}px`);
    // The chevron tessellation is the thing that does not fit a 34px band.
    expect(chevron("build").style.clipPath).toBe("");
  });

  it("keeps BOTH handles and both handlers, so it is the same control", () => {
    const spies = { ...props, onPickPlan: vi.fn(), onPickBuild: vi.fn() };
    render(<PlanBuildToggle mode="build" variant="mini" {...spies} />);
    fireEvent.click(chevron("plan"));
    expect(spies.onPickPlan).toHaveBeenCalledTimes(1);
    fireEvent.click(chevron("build"));
    expect(spies.onPickBuild).toHaveBeenCalledTimes(1);
  });

  // `.mini span.on{background:var(--k-primary);color:var(--k-on-primary)}` — the SAME measured pair
  // the chevron strip paints, so the accent does not have two answers in two placements.
  it("fills only the active segment, with the measured accent pair", () => {
    render(<PlanBuildToggle mode="build" variant="mini" {...props} />);
    expect(chevron("build").style.background).toBe(C.goldFill);
    expect(chevron("build").style.color).toBe(ON_GOLD_FILL);
    expect(chevron("plan").style.background).toBe("transparent");
    expect(chevron("plan").style.color).toBe(C.muted);
  });

  it("announces the mode as a pressed state", () => {
    render(<PlanBuildToggle mode="plan" variant="mini" {...props} />);
    expect(chevron("plan").getAttribute("aria-pressed")).toBe("true");
    expect(chevron("build").getAttribute("aria-pressed")).toBe("false");
  });

  // Beads-gated exactly like the chevron strip: no Plan board, no Plan segment.
  it("drops Plan when beads are off", () => {
    render(<PlanBuildToggle mode="build" variant="mini" {...props} beadsEnabled={false} />);
    expect(document.querySelector('[data-hint="plan"]')).toBeNull();
    expect(chevron("build")).toBeTruthy();
  });

  it("still renders the chevron strip by default — the Plan column is unchanged", () => {
    render(<PlanBuildToggle mode="build" {...props} />);
    expect(screen.queryByTestId("plan-build-mini")).toBeNull();
    expect(chevron("build").style.clipPath).toContain("polygon");
  });
});
