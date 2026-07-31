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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { resetCable, useCableStore } from "../stores/cableStore";
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

/** `rel` resolved against the nearest ancestor of the cwd that contains it — so the one test below
 *  that reads a real file works whether the runner was started in `apps/desktop` or at the repo
 *  root. Throws rather than returning a miss: a silently unread stylesheet would make its
 *  assertions pass on an empty string. */
function resolveFromRoot(rel: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const hit = join(dir, rel);
    if (existsSync(hit)) return hit;
    if (dirname(dir) === dir) throw new Error(`cannot find ${rel} above ${process.cwd()}`);
  }
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
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  // The cable decides whether the CONCIERGE end of every row is open, so every assertion here has
  // to say which state it is measuring. Default: at rest.
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

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

// ── THE PAIR DECIDES WHICH END IS WHICH ────────────────────────────────────────────────────────
//
// `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. In the LEFT pair the terminal is on the row's LEFT, so
// every number above mirrors. The inline version this replaced was written when the app had one
// pair, on the right, and hung the bleed on `marginRight`, the leading radius on the left corners
// and both fillets at `right: 0` — so once the left pair shipped it drew that pair BACKWARDS: the
// row ran into the concierge, and the mouths opened away from the pane they were supposed to feed.
describe("Build column — the geometry mirrors with the pair", () => {
  const leftPair = () =>
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);

  it("bleeds LEFT — toward its own terminal — for a left-assigned project", () => {
    leftPair();
    render(<AgentSidebar project={seed("a1")} />);
    const box = boxOf(rowFor("Alpha"));
    expect(box.marginLeft).toBe("-8px");
    expect(box.marginRight).toBe("0px");
    // …and the padding pays it back on that same side, so the ink does not move.
    expect(box.paddingLeft).toBe("18px");
    expect(box.paddingRight).toBe("10px");
  });

  it("puts the leading radius on the CONCIERGE end, which is now the right", () => {
    leftPair();
    render(<AgentSidebar project={seed("a1")} />);
    expect(rowFor("Alpha").style.borderRadius).toBe(
      `0 ${RADIUS.modal}px ${RADIUS.modal}px 0`,
    );
  });

  it("anchors the mouths on the left, with the arc bitten out of the RIGHT corner", () => {
    // The anchor mirrors with the end. Left at `left` and the left pair's bank sweeps the wrong way
    // — it hooks back into the row instead of away from it, which is the "rounded backwards" report.
    leftPair();
    render(<AgentSidebar project={seed("a1")} />);
    const row = rowFor("Alpha");
    const top = row.querySelector<HTMLElement>('[data-testid="row-mouth-top"]')!;
    const bottom = row.querySelector<HTMLElement>('[data-testid="row-mouth-bottom"]')!;
    expect(top.style.left).toBe("0px");
    expect(top.style.right).toBe("");
    expect(top.style.background).toContain("at top right");
    expect(bottom.style.background).toContain("at bottom right");
  });

  it("still gives EVERY row the mirrored bleed, not just the selected one", () => {
    // Rule 1 again, on the other side: if the mirror were applied only to `.on`, the list would
    // twitch in the left pair exactly as it used to in the right.
    leftPair();
    render(<AgentSidebar project={seed("a1")} />);
    expect(boxOf(rowFor("Beta"))).toEqual(boxOf(rowFor("Alpha")));
  });
});

// ── WIRED: THE CONCIERGE END OPENS TOO ─────────────────────────────────────────────────────────
//
// Unplugged, the selected row is joined to its own terminal and nothing else — one mouth and one
// plain leading edge. Patch the cable and the SAME row extends the opposite way into the concierge,
// completing `concierge ← row → terminal`: all four corners are mouths and the row reads as a
// length of cable seated in two sockets (MAPPING.md's wired table). The app had only ever drawn the
// first half.
describe("Build column — the wired joint bridges the row into the concierge", () => {
  const joint = (row: HTMLElement) => ({
    top: row.querySelector<HTMLElement>('[data-testid="row-joint-top"]'),
    bottom: row.querySelector<HTMLElement>('[data-testid="row-joint-bottom"]'),
  });

  it("draws no joint while the cable is unplugged", () => {
    render(<AgentSidebar project={seed("a1")} />);
    expect(joint(rowFor("Alpha")).top).toBeNull();
  });

  it("opens the concierge end once THIS pair holds the cable", () => {
    useCableStore.getState().patch("right");
    render(<AgentSidebar project={seed("a1")} />);
    const row = rowFor("Alpha");
    expect(joint(row).top).toBeTruthy();
    expect(joint(row).bottom).toBeTruthy();
    // Square at both ends now: a radius on the concierge end would neck the row down exactly where
    // it is supposed to open into the column it is plugged into.
    expect(row.style.borderRadius).toBe("0 0 0 0");
  });

  it("leaves the OTHER pair alone — one live circuit, not two", () => {
    // The project is right-assigned; patching LEFT must not open its joint.
    useCableStore.getState().patch("left");
    render(<AgentSidebar project={seed("a1")} />);
    const row = rowFor("Alpha");
    expect(joint(row).top).toBeNull();
    expect(row.style.borderRadius).toBe(`${RADIUS.modal}px 0 0 ${RADIUS.modal}px`);
  });

  it("mirrors the joint too — a wired LEFT pair opens toward the concierge on its right", () => {
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    useCableStore.getState().patch("left");
    render(<AgentSidebar project={seed("a1")} />);
    const top = joint(rowFor("Alpha")).top!;
    expect(top.style.right).toBe("0px");
    expect(top.style.background).toContain("at top left");
  });

  it("paints the joint in the very colour the concierge floods to, so the seam has nothing to show", () => {
    // THIS is what makes the joint correct in BOTH themes without a second token: wiring floods the
    // concierge to the terminal register (ConciergeColumn: `BLUEPRINT[mode].term`), and `C.forest`
    // IS that plane (theme/colors derives `forest` from `BLUEPRINT[mode].term`). The fillet's fill
    // and the surface it opens onto are therefore the same value in light and in dark. A bespoke
    // colour here would have to be re-derived per theme and would drift the moment either moved.
    useCableStore.getState().patch("right");
    render(<AgentSidebar project={seed("a1")} />);
    const { top, bottom } = joint(rowFor("Alpha"));
    for (const strip of [top!, bottom!]) {
      expect(strip.style.background).toContain(`${C.forest} 100%`);
      expect(strip.style.background).toContain("ellipse farthest-side");
      expect(strip.style.background).toContain("calc(100% - .5px)");
    }
  });

  it("bleeds every row's joint end, so patching in does not move the ink", () => {
    // Geometry belongs to every row: the concierge-side bleed lands on `.row`, and the padding pays
    // it back one-for-one. Unselected rows are transparent, so nothing but the selected row's fill
    // actually reaches further — but the BOXES must agree or the list twitches when you plug in.
    useCableStore.getState().patch("right");
    render(<AgentSidebar project={seed("a1")} />);
    const box = boxOf(rowFor("Beta"));
    expect(box.marginLeft).toBe("-8px");
    expect(box.paddingLeft).toBe("18px");
    expect(boxOf(rowFor("Alpha"))).toEqual(box);
  });
});

// ── THE COLUMN'S OWN HAIRLINE MIRRORS TOO ──────────────────────────────────────────────────────
//
// The row opening into the concierge is only half of it: the COLUMN draws a 1px `hairline` of its
// own, one pixel inside the padding box, so the selected row's fill can paint over it and break the
// rule exactly where the row bleeds through (see `sidebar-terminal-seam`'s note in AgentSidebar).
// It marks this column's edge against ITS OWN TERMINAL — the boundary that is never erased.
//
// Which edge that is flips with the pair, and this element was the one anchor in the column that
// never learned: `right: 0`, written when the only pair was the right one, where right IS the
// terminal edge. The overlay anchor beside it and the pull-tab rail below it were both mirrored;
// this was not. So a LEFT pair (`TERM │ BUILD │ CONCIERGE`) painted it on the CONCIERGE edge — a
// full-height rule standing exactly where a mounted row runs through into the concierge, on the one
// boundary `[data-wired]` exists to erase, while the terminal edge it was meant to mark got nothing.
//
// SCOPE, stated because jsdom cannot say otherwise: the OTHER half of that boundary is the column's
// `border-inline` in index.css, whose `[data-wired]` rule turns it transparent. No stylesheet is
// applied here, so these assertions cover the inline seam — the half that lives in the component and
// the half that ships wrong.
describe("Build column — the terminal seam is drawn on the pane side, not always on the right", () => {
  const seam = () => screen.getByTestId("sidebar-terminal-seam");

  it("keeps the hairline off a wired LEFT pair's concierge edge", () => {
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    useCableStore.getState().patch("left");
    render(<AgentSidebar project={seed("a1")} />);

    // The joint mouth names the concierge end — right, for a left pair. The seam must be on the
    // other one, or it crosses the very end the mount just opened.
    const jointEnd = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-joint-top"]')!;
    expect(jointEnd.style.right).toBe("0px");
    expect(seam().style.right).toBe("");
    expect(seam().style.left).toBe("0px");
  });

  it("still draws it on the right for a right pair, where right IS the terminal edge", () => {
    useCableStore.getState().patch("right");
    render(<AgentSidebar project={seed("a1")} />);
    expect(seam().style.right).toBe("0px");
    expect(seam().style.left).toBe("");
  });

  // THE OTHER HALF OF THE SAME BOUNDARY, and the half that cannot be seen from this file alone.
  // index.css owns the column's border: `border-inline: none`, one border on the CONCIERGE side per
  // pair, and a `[data-wired]` rule that turns THAT LONGHAND transparent when the cable is patched
  // in. An inline declaration of the property outranks every selector, so an inline border here is
  // not a harmless duplicate — it deletes the mechanism. `borderRight: "none"` shipped on this
  // column and did exactly that to the left pair, whose concierge edge is its right: no seam
  // unplugged, and nothing left for the wired rule to erase plugged in.
  //
  // BOTH SIDES ARE READ FROM DISK, not restated here, so the stylesheet and the component cannot
  // drift into agreeing only on paper. And the component side has to be read as SOURCE rather than
  // rendered, which is the one thing worth saying out loud: jsdom's CSS engine DISCARDS
  // `border-right: none` outright — the style attribute comes back `"display: flex;"` and
  // `el.style.borderRight` is `""`, identical to never having set it. So the shipped bug is
  // literally unobservable through the DOM, and a render-based assertion here would pass against
  // the broken code (it did — that draft was thrown away). Reading the declaration is the only
  // instrument that can fail for the stated reason.
  it("declares no border inline, or the wired rule in index.css cannot erase the concierge edge", () => {
    const css = readFileSync(resolveFromRoot("src/index.css"), "utf8");
    const wiredRules = [
      ...css.matchAll(
        /\.shell\[data-wired="(?:left|right)"\][^{]*agent-sidebar-column"\]\s*\{([^}]*)\}/g,
      ),
    ].map(([, body]) => body);
    // Both pairs, or the assertion below guards a mechanism that isn't there.
    expect(wiredRules).toHaveLength(2);
    const erased = wiredRules.join(" ");
    expect(erased).toContain("border-right-color: transparent");
    expect(erased).toContain("border-left-color: transparent");

    // The column's own JSX, from its testid down to the seam element that closes the style object.
    const src = readFileSync(resolveFromRoot("src/components/AgentSidebar.tsx"), "utf8");
    const from = src.indexOf('data-testid="agent-sidebar-column"');
    const to = src.indexOf('data-testid="sidebar-terminal-seam"');
    expect(from, "column testid").toBeGreaterThan(-1);
    expect(to, "seam testid, after the column's").toBeGreaterThan(from);
    const declarations = src
      .slice(from, to)
      .split("\n")
      .map((line) => line.trim())
      // Prose about the bug names the property; only real declarations count.
      .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
    expect(declarations.filter((line) => /^border[A-Za-z]*\s*:/.test(line))).toEqual([]);
  });
});
