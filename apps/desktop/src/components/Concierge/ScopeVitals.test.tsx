// @vitest-environment jsdom
//
// The scope + vitals strings the founder reads all day, pinned exactly: "Following all
// projects" / "Pinned to X", and "all calm" vs "1 Needs you · 2 Running".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusBand } from "../../engine/buildSections";
import { ScopeVitals, scopeText, vitalsParts } from "./ScopeVitals";

afterEach(() => cleanup());

/** Counts with only the named bands set — every surface takes the full Record now. */
function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, running: 0, done: 0, ...over };
}

describe("scopeText / vitalsParts (pure)", () => {
  it("scope follows all projects unless pinned", () => {
    expect(scopeText()).toBe("Following all projects");
    expect(scopeText("drodio-website")).toBe("Pinned to drodio-website");
  });

  it("vitals list only the non-zero bands, Needs-you first; none → null (all calm)", () => {
    expect(vitalsParts(counts())).toBeNull();
    expect(vitalsParts(counts({ needs_you: 1, running: 2 }))).toEqual(["1 Needs you", "2 Running"]);
    expect(vitalsParts(counts({ running: 3 }))).toEqual(["3 Running"]);
    expect(vitalsParts(counts({ needs_you: 2 }))).toEqual(["2 Need you"]);
  });

  it("agrees in number at the n=1 boundary — the verb changes, nothing else does", () => {
    expect(vitalsParts(counts({ needs_you: 1 }))).toEqual(["1 Needs you"]);
    expect(vitalsParts(counts({ needs_you: 2 }))).toEqual(["2 Need you"]);
    // "Running" is an adjective; it never inflects.
    expect(vitalsParts(counts({ running: 1 }))).toEqual(["1 Running"]);
  });

  it('a fleet that is only "Done" still reads "all calm"', () => {
    // `done` is not a vital sign: on a resting fleet it is nearly every agent, so reporting it would
    // mean the line reads "40 Done" forever and the all-calm state could never appear.
    expect(vitalsParts(counts({ done: 40 }))).toBeNull();
  });
});

describe("ScopeVitals — rendered", () => {
  it('calm renders "all calm"', () => {
    render(<ScopeVitals counts={counts()} />);
    expect(screen.getByText("all calm")).toBeTruthy();
    expect(screen.getByText("Following all projects")).toBeTruthy();
  });

  it('attention renders "1 Needs you · 2 Running" as one line', () => {
    const { container } = render(<ScopeVitals counts={counts({ needs_you: 1, running: 2 })} />);
    expect(container.textContent).toContain("1 Needs you · 2 Running");
  });

  it("pinned scope names the project", () => {
    render(<ScopeVitals pinnedProjectName="sparkle-mobile" counts={counts()} />);
    expect(screen.getByText("Pinned to sparkle-mobile")).toBeTruthy();
  });
});
