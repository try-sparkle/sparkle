// @vitest-environment jsdom
//
// The project-tab staleness badge (bead sparkle-cuv2h).
//
// WHAT THIS GUARDS. A checkout at a canonical-looking path is the one most likely to be READ and
// least likely to be PULLED — the founder's sat 1,694 commits behind on a six-day-old `main` while
// every agent worktree was current, and answers drawn from it were reported as current code. The
// badge is the visible half of the fix, so the assertions below are about what a person can
// actually SEE and a screen reader can actually HEAR: the count, the base it is behind, and the
// instruction to read from that base instead.
//
// The fail-closed property is the one worth stating twice: a project we could not MEASURE and a
// project that is FRESH are both simply absent from `stalenessByProject`. There is no third
// rendering, so an `unknown` reading from `repo_freshness` can never surface as a reassuring badge.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { StatusBand } from "../engine/buildSections";
import { ProjectTabs, staleTitle, type ProjectTabStaleness } from "./ProjectTabs";

function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, questions: 0, running: 0, done: 0, ...over };
}

const projects = [
  { id: "sparkle", name: "sparkle" },
  { id: "website", name: "drodio-website" },
];

afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderTabs(
  staleness?: Record<string, ProjectTabStaleness>,
  selected: string | null = "sparkle",
) {
  return render(
    <ProjectTabs
      projects={projects}
      selectedProjectId={selected}
      pinnedProjectId={null}
      countsByProject={{ sparkle: counts(), website: counts() }}
      onSelect={() => {}}
      onTogglePin={() => {}}
      stalenessByProject={staleness}
    />,
  );
}

const STALE: ProjectTabStaleness = { behind: 1696, base: "origin/main" };

describe("project tab staleness badge", () => {
  it("shows the behind-count on a stale project", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    // The NUMBER is on screen, thousands-separated — 1696 bare is hard to size at a glance.
    expect(badge.textContent).toContain("1,696");
    expect(badge.getAttribute("data-behind")).toBe("1696");
  });

  // The whole point of the badge is the sentence, not the number: "1,696" alone does not tell you
  // what it is behind or what to do instead. Both the tooltip and the accessible name carry it.
  it("names the base and says what to do instead", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    const title = badge.getAttribute("title") ?? "";
    expect(title).toBe(staleTitle("sparkle", STALE));
    expect(title).toContain("origin/main");
    expect(title).toContain("STALE");
    expect(title).toMatch(/read from origin\/main instead/i);
    // Spoken name matches the tooltip, so the badge is not silent to a screen reader.
    expect(badge.getAttribute("aria-label")).toBe(title);
  });

  // FAIL-CLOSED. Absence must render nothing at all — never a "0 behind"/"fresh" affordance. A
  // project we could not measure is absent for the same reason a fresh one is, so a badge can only
  // ever mean "measured, and behind".
  it("renders nothing for a project that is absent from the map", () => {
    renderTabs({ sparkle: STALE });
    expect(screen.queryByTestId("stale-website")).toBeNull();
  });

  it("renders nothing at all when no staleness is supplied", () => {
    renderTabs(undefined);
    expect(screen.queryByTestId("stale-sparkle")).toBeNull();
    expect(screen.queryByTestId("stale-website")).toBeNull();
  });

  // The divergence from TabCountBadge that is easiest to regress by "consistency" refactor: the
  // alarm badge hides on the tab you are looking at, this one must NOT. A stale checkout matters
  // most while you are working in it.
  it("stays visible on the ACTIVE tab, unlike the needs-you count badge", () => {
    renderTabs({ sparkle: STALE, website: { behind: 40, base: "origin/main" } }, "sparkle");
    expect(screen.getByTestId("stale-sparkle")).toBeTruthy(); // active
    expect(screen.getByTestId("stale-website")).toBeTruthy(); // inactive
  });

  it("badges each project with its own count and name", () => {
    renderTabs({
      sparkle: STALE,
      website: { behind: 7, base: "origin/trunk" },
    });
    expect(screen.getByTestId("stale-sparkle").textContent).toContain("1,696");
    const web = screen.getByTestId("stale-website");
    expect(web.textContent).toContain("7");
    // The base is per-project, not hardcoded to origin/main.
    expect(web.getAttribute("title")).toContain("origin/trunk");
    expect(web.getAttribute("title")).toContain("drodio-website");
  });

  // No emoji-as-icon anywhere in this repo — the warning mark is a react-icons SVG.
  it("uses an icon, not an emoji", () => {
    renderTabs({ sparkle: STALE });
    const badge = screen.getByTestId("stale-sparkle");
    expect(badge.querySelector("svg")).toBeTruthy();
    expect(badge.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("staleTitle", () => {
  it("thousands-separates the count and names both ends", () => {
    expect(staleTitle("proj", { behind: 1696, base: "origin/main" })).toBe(
      "proj is 1,696 commits behind origin/main — this checkout is STALE. Reading files from it returns old code; read from origin/main instead.",
    );
  });
});
