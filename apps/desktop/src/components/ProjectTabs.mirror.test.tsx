// @vitest-environment jsdom
//
// THE LEFT-HAND PAIR'S STRIP IS MIRRORED BY A CSS SELECTOR THAT LIVES IN ANOTHER FILE, and nothing
// connected the two. `index.css` reverses the flex flow so the active tab hugs the CENTRE on both
// sides; the markup it aims at is `ProjectTabs`'s. A rename or a change of nesting on either side
// un-mirrors the left strip SILENTLY — no error, no failing test, just a bar that reads outward on
// one side of the window and inward on the other.
//
// It already happened once in the making of this change. The rule was
// `.ptabstrip[data-side="left"] > [role="tablist"]`, valid while the tablist was ProjectTabs' root;
// the hover expansion (bead sparkle-z24dl) split the bar into an outer `.concierge-tabbar` and an
// inner scrolling tablist, which made the tablist a GRANDCHILD and the `>` combinator stop matching.
//
// So this test does not compare strings. It reads the real selectors out of the real stylesheet and
// runs them against the real rendered markup — the only check that fails when either side moves.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectTabs } from "./ProjectTabs";

const CSS = readFileSync(join(__dirname, "..", "index.css"), "utf8");

/** Every selector in the `data-side="left"` mirror rule, as authored. */
function mirrorSelectors(): string[] {
  // The rule is a comma-separated selector list terminated by `{`. Anchored on the attribute
  // selector so an unrelated `.ptabstrip` rule elsewhere in the file cannot be picked up instead.
  const m = CSS.match(/\n((?:[^\n{}]*\.ptabstrip\[data-side="left"\][^{}]*?))\{\s*flex-direction:\s*row-reverse;/);
  if (!m?.[1]) throw new Error("no `.ptabstrip[data-side=left]` row-reverse rule found in index.css");
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderInLeftPair(): void {
  render(
    <div className="ptabstrip" data-side="left">
      <ProjectTabs
        projects={[{ id: "a", name: "alpha" }]}
        selectedProjectId="a"
        pinnedProjectId={null}
        countsByProject={{}}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        reversed
      />
    </div>,
  );
}

describe("the left pair's mirrored tab strip", () => {
  it("reverses BOTH boxes — the bar chrome and the tabs themselves", () => {
    // Two selectors, not one, and they are different jobs: the outer box puts the "+" and the
    // top-right cluster on the pair's outer edge, the inner one makes the tabs read inward toward
    // the concierge. Reversing only the outer leaves the tabs running the wrong way.
    const sels = mirrorSelectors();
    expect(sels.some((s) => s.endsWith(".concierge-tabbar"))).toBe(true);
    expect(sels.some((s) => s.includes('[role="tablist"]'))).toBe(true);
  });

  it("every one of those selectors actually MATCHES the markup ProjectTabs renders", () => {
    renderInLeftPair();
    for (const sel of mirrorSelectors()) {
      expect(document.querySelector(sel), `index.css selector matches nothing: ${sel}`).not.toBeNull();
    }
  });

  it("guards the guard — a selector aimed at the OLD nesting matches nothing", () => {
    // The assertion above is only worth something if a wrong selector would fail it. This is the
    // exact rule that used to be in index.css, and it must now come back empty.
    renderInLeftPair();
    expect(document.querySelector('.ptabstrip[data-side="left"] > [role="tablist"]')).toBeNull();
  });
});
