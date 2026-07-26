// @vitest-environment jsdom
//
// The scope + vitals strings the founder reads all day, pinned exactly: "Following all
// projects" / "Pinned to X", and "all calm" vs "1·P0 · 2·P1".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScopeVitals, scopeText, vitalsParts } from "./ScopeVitals";

afterEach(() => cleanup());

describe("scopeText / vitalsParts (pure)", () => {
  it("scope follows all projects unless pinned", () => {
    expect(scopeText()).toBe("Following all projects");
    expect(scopeText("drodio-website")).toBe("Pinned to drodio-website");
  });

  it("vitals list only the non-zero tiers, P0 first; both zero → null (all calm)", () => {
    expect(vitalsParts(0, 0)).toBeNull();
    expect(vitalsParts(1, 2)).toEqual(["1·P0", "2·P1"]);
    expect(vitalsParts(0, 3)).toEqual(["3·P1"]);
    expect(vitalsParts(2, 0)).toEqual(["2·P0"]);
  });
});

describe("ScopeVitals — rendered", () => {
  it('calm renders "all calm"', () => {
    render(<ScopeVitals p0={0} p1={0} />);
    expect(screen.getByText("all calm")).toBeTruthy();
    expect(screen.getByText("Following all projects")).toBeTruthy();
  });

  it('attention renders "1·P0 · 2·P1" as one line', () => {
    const { container } = render(<ScopeVitals p0={1} p1={2} />);
    expect(container.textContent).toContain("1·P0 · 2·P1");
  });

  it("pinned scope names the project", () => {
    render(<ScopeVitals pinnedProjectName="sparkle-mobile" p0={0} p1={0} />);
    expect(screen.getByText("Pinned to sparkle-mobile")).toBeTruthy();
  });
});
