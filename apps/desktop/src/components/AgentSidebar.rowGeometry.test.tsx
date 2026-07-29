// @vitest-environment jsdom
//
// THE BUILD COLUMN'S ROW GEOMETRY — the `.row` / `.row.on` contract from the blueprint cockpit
// (PRD/sparkle/ui-directions/rev4.html, and MAPPING.md's "Geometry vocabulary" section).
//
// Two rules, and this file exists because breaking either one is invisible to every other test in
// the suite:
//
//   1. GEOMETRY BELONGS TO EVERY ROW, NEVER ONLY THE SELECTED ONE. The margins and the padding that
//      pays them back live on `.row`; `.on` may change only what is PAINTED. When the margin was
//      conditional on selection (`marginRight: isActive ? -8 : 0`) the row's CONTENT BOX narrowed
//      the instant you clicked it, so the title under the pointer jumped ~10px and jumped back on
//      the next row — the list twitched every time the user changed agents. The founder reported
//      exactly that. It is a layout property wearing a selection style's clothes, which is why no
//      colour or class assertion anywhere else could catch it.
//
//   2. THE PANE-SIDE END IS A MOUTH, NOT A CORNER. A `border-radius` curves IN: it cuts material
//      away and the row necks DOWN as it reaches the terminal. A mouth curves OUT — the channel
//      widens and the pane's bank sweeps away from the row. No radius value produces that at any
//      size; it is a concave fillet, drawn by rounding the BUILD COLUMN's corner away rather than
//      the row's own. ~20 review rounds died on that distinction, so the assertions below pin the
//      construction (which corner the circle sits at, and which side is transparent) rather than
//      just "there is a gradient".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

/** Two sibling top-level rows, so one can be selected while the other is not — the comparison the
 *  twitch bug is invisible without. */
function seed(selectedAgentId: string | null = null): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId,
    agents: [mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status: {},
    openAgentIds: ["a1", "a2"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

/** The four numbers that decide where a row's ink lands. If these differ between two rows, the text
 *  moves when selection moves — which is the whole bug. */
const boxOf = (el: HTMLElement) => ({
  marginLeft: el.style.marginLeft,
  marginRight: el.style.marginRight,
  paddingLeft: el.style.paddingLeft,
  paddingRight: el.style.paddingRight,
});

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
});
afterEach(cleanup);

describe("Build column — the row's box does not move when selection does", () => {
  it("gives an unselected and a selected row the identical content inset", () => {
    const project = seed("a1");
    render(<AgentSidebar project={project} />);

    // Alpha is selected, Beta is not. Same box, or the ink shifts under the pointer on every click.
    expect(boxOf(rowFor("Alpha"))).toEqual(boxOf(rowFor("Beta")));
  });

  it("keeps the SAME row's box identical before and after it becomes selected", () => {
    const { rerender } = render(<AgentSidebar project={seed(null)} />);
    const unselected = boxOf(rowFor("Alpha"));

    rerender(<AgentSidebar project={seed("a1")} />);
    const selected = boxOf(rowFor("Alpha"));

    expect(selected).toEqual(unselected);
  });

  // The guard that keeps the two above honest: they would also pass if NO row reached the seam.
  // Every row has to carry the bleed, which is what makes the selected one able to paint into it.
  it("gives EVERY row the pane-side bleed, not just the selected one", () => {
    const project = seed("a1");
    render(<AgentSidebar project={project} />);

    for (const name of ["Alpha", "Beta"]) {
      expect(rowFor(name).style.marginRight).toBe("-8px");
    }
  });

  // …and the padding pays the margin back one-for-one. Changing the margin without this is how the
  // inset drifts even when both rows agree with each other.
  it("compensates that bleed with padding, so the ink inset is unchanged", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const row = rowFor("Alpha");

    const bleed = -parseInt(row.style.marginRight, 10); // 8
    const padRight = parseInt(row.style.paddingRight, 10); // 18
    const padLeft = parseInt(row.style.paddingLeft, 10); // 10

    // Inset from the COLUMN's pane-side edge, which is where the row's border box now ends.
    expect(padRight - bleed).toBe(padLeft);
  });

  // THE BLEED AND THE LIST'S PADDING ARE ONE NUMBER, and nothing above can see them disagree: every
  // assertion so far derives the bleed from the row's own `marginRight`, i.e. from the same
  // constant. Change the scroll container to `0 12px` and every row falls 4px short of the seam —
  // the active row's fill stops lapping the seam element and the fillets flare from a shape that no
  // longer touches the pane — with all of the above still green. This is the assertion that reads
  // the OTHER side.
  it("bleeds by exactly the list's own padding, no more and no less", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const list = screen.getByTestId("agent-list-scroll");
    const row = rowFor("Alpha");

    expect(list.style.paddingRight).toBe("8px");
    expect(row.style.marginRight).toBe(`-${parseInt(list.style.paddingRight, 10)}px`);
    // An over-large bleed does not degrade gracefully either: the container is `overflowY: auto`,
    // which computes overflow-x to `auto`, so the overhang clips or grows a horizontal scrollbar.
    expect(parseInt(row.style.paddingRight, 10) - parseInt(list.style.paddingRight, 10)).toBe(
      parseInt(row.style.paddingLeft, 10),
    );
  });
});

describe("Build column — the pane-side end is a mouth, not a corner", () => {
  const mouths = (row: HTMLElement) => ({
    top: row.querySelector<HTMLElement>('[data-testid="row-mouth-top"]'),
    bottom: row.querySelector<HTMLElement>('[data-testid="row-mouth-bottom"]'),
  });

  it("draws a fillet above and below the selected row's pane-side edge", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = mouths(rowFor("Alpha"));
    expect(top).toBeTruthy();
    expect(bottom).toBeTruthy();
  });

  it("draws none on an unselected row", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = mouths(rowFor("Beta"));
    expect(top).toBeNull();
    expect(bottom).toBeNull();
  });

  // THE CONSTRUCTION, not merely "a gradient exists". The circle sits at the corner FURTHEST from
  // the junction and the INSIDE of it is transparent — that is what makes the bank sweep outward.
  // Flip either half (circle at the near corner, or transparent/pane swapped) and you get a convex
  // corner: the shape that has been rejected ~20 times.
  it("puts the arc at the corner furthest from the junction, transparent side in", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = mouths(rowFor("Alpha"));

    // The strip ABOVE the row joins it along the strip's BOTTOM edge, at the pane-side (right)
    // end — so the far corner is TOP LEFT.
    expect(top!.style.background).toContain("at top left");
    // …and BELOW the row the junction is the strip's top edge, so the far corner is BOTTOM LEFT.
    expect(bottom!.style.background).toContain("at bottom left");

    for (const strip of [top!, bottom!]) {
      // transparent FIRST (inside the arc, where the build column shows through), pane colour
      // second (outside it).
      const transparentAt = strip.style.background.indexOf("transparent");
      const paneAt = strip.style.background.indexOf(C.forest);
      expect(transparentAt).toBeGreaterThanOrEqual(0);
      expect(paneAt).toBeGreaterThan(transparentAt);
    }
  });

  // ── 26 × 9, NOT 9 × 9 — AND THIS IS THE SHAPE THE FOUNDER REJECTED ONCE ──────────────────────
  // A circular 9×9 corner-round is 78% quarter-disc, so it packs the whole flare into the last
  // ~4px before the seam: the near-white build column ran flush beside the row right up to the
  // pane and stopped in a rounded stub — two pale claws pinching the row where it enters the
  // terminal. That is the "white lines shouldn't be there when rounded" report, and nothing was
  // stray; it was a corner-round doing what a corner-round does.
  //
  // Stretched over `--m-run` the same 9px rise leaves the row with a horizontal tangent and meets
  // the seam with a vertical one, so it is smooth at both ends. Asserted as a run/rise PAIR plus an
  // explicit `not 9px` on the width, because "there is an arc of some size" is exactly what passed
  // last time.
  it("runs the fillet 26px back from the seam for its 9px of rise", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = mouths(rowFor("Alpha"));
    for (const strip of [top!, bottom!]) {
      expect(strip.style.width).toBe("26px");
      expect(strip.style.height).toBe("9px");
      // RELATIONAL, not `not.toBe("9px")` — that guard was unreachable behind the exact-26px
      // assertion above, so it read as protection against the rejected square while providing
      // none. This one fails for ANY run that collapses back toward the rise, which is the
      // property that actually matters.
      expect(parseInt(strip.style.width, 10)).toBeGreaterThan(
        2 * parseInt(strip.style.height, 10),
      );
    }
  });

  // `farthest-side` sets the ending SHAPE; the color stops are what tie the arc to the box. Both
  // halves are asserted because either one alone is an escape hatch — and the stops are the one
  // this block previously lost: `ellipse farthest-side at top left, transparent 0 8.5px, <pane> 9px`
  // inside the 26×9 box satisfies the shape keyword, the anchor, the stop ORDER and the box's
  // dimensions, while px stops resolve along the 26px horizontal radius and collapse the arc to
  // about a third of the run — i.e. it renders exactly the 9px-scale claw the founder rejected.
  // The stops must be RELATIVE (`calc(100% - .5px)` → `100%`) for the shape to follow the box.
  it("scales the arc to the box with relative stops, not px", () => {
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = mouths(rowFor("Alpha"));
    for (const strip of [top!, bottom!]) {
      expect(strip.style.background).toContain("ellipse farthest-side");
      expect(strip.style.background).toContain("calc(100% - .5px)");
      expect(strip.style.background).toContain(`${C.forest} 100%`);
      // A px-scaled revert is the specific regression: no px length may appear in the stop list.
      expect(strip.style.background).not.toMatch(/transparent\s+0\s+[\d.]+px/);
    }
  });

  // The mouth end must never ALSO be a radius: a radius there necks the row down and the fillet
  // then flares out of a shape that has already pulled away from the seam.
  it("leaves the selected row's pane-side corners square", () => {
    render(<AgentSidebar project={seed("a1")} />);
    // leading (concierge-side) corners rounded, pane-side corners 0 — in that order.
    expect(rowFor("Alpha").style.borderRadius).toBe(
      `${RADIUS.modal}px 0 0 ${RADIUS.modal}px`,
    );
  });
});
