// @vitest-environment jsdom
//
// THE EPIC TITLE IS ROW-SIZED, AND BOLD IS THE ONLY THING SEPARATING IT — bead `sparkle-huw924.13`.
//
// The founder, 2026-08-25, with this column open beside a screenshot of it: *"Also make the size of
// the epic title text in the epic column the same size as the row. The title should be the same
// size as the row. Should just be bold. The text should be the same size as the row text as well.
// This is in the EPIC column that we want to have smaller text sizes. You don't have to make any
// changes in the planning board."*
//
// ══ WHY THIS MOUNTS THE WHOLE COLUMN RATHER THAN THE CARD ══════════════════════════════════════
// His ask is a claim about a RELATIONSHIP between two elements — the ladder row and the title of
// the card that opens under it. A card mounted alone cannot answer it: the best such a suite could
// do is assert the title equals `TYPE.micro`, which is a claim about a TOKEN NAME. Two places can
// name the same token today and drift tomorrow the moment someone retunes `EpicRow`, and that suite
// would stay green through the whole drift while the founder's actual ask was broken on screen.
//
// So both elements are put in ONE TREE and their computed sizes compared to EACH OTHER. Nothing
// here names a number: retune `EpicRow` to any size at all and this file demands the title follow
// it, which is the property he asked for rather than the constant that currently expresses it.
//
// ══ THE 1.3 ZOOM IS DELIBERATELY NOT MODELLED ══════════════════════════════════════════════════
// The Epics columns run at zoom 1.3, so both numbers are multiplied by the same factor and equal-at
// -1.0 is equal-at-1.3. The zoom is also a founder-controlled setting and explicitly NOT the knob
// for this — the bead says so — so a suite that reached for it would be testing the wrong lever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { BeadCard } from "./BeadCard/BeadCard";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { WEIGHT } from "../theme/scale";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROJECT = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/alpha",
  agents: [],
} as unknown as Project;

const EPIC_ID = "ep-1";
const TASK_ID = "ep-1.a";

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "task", ...over } as Bead;
}

// A LONG TITLE ON PURPOSE. The founder's own case is a sentence-length epic name — the exact shape
// whose size difference he could see from across the room.
const EPIC = bead(EPIC_ID, {
  type: "epic",
  title: "Work decomposition contract: classify ask to epic to tasks to orchestrators to workers",
});
const TASK = bead(TASK_ID, { parent: EPIC_ID, title: "Wire the rows", status: "in_progress" });
const BEADS = [EPIC, TASK];

/** THE ARRAY HANDED TO THE COLUMN MUST BE THE VERY ONE IN THE STORE — the connected wrapper
 *  resolves its project by REFERENCE IDENTITY, and a copy renders nothing. Carried over verbatim
 *  from `EpicsColumn.taskFocus.test.tsx`, which carried it from `goalMount`. */
function seed(beads: Bead[] = BEADS, project: Project = PROJECT) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [project.id]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
  useProjectStore.setState({ projects: [project], selectedProjectId: project.id } as never);
}

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  // BOTH RUNGS RESET — `setBeadFocus` TOGGLES, so a value surviving an earlier case makes the next
  // click CLEAR rather than set and the file alternates pass/fail on identical code. Same reason
  // `EpicsColumn.taskFocus.test.tsx` documents at length.
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    workModeBySide: { left: "plan", right: "plan" },
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  seed();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Open the epic the way a user does — by clicking its ROW. Seeding the focus directly would skip
 *  the state transition the card's presence depends on. */
async function openTheEpic() {
  render(<EpicsColumn project={PROJECT} side="right" />);
  const row = await waitFor(() => screen.getByTestId("epic-row"));
  fireEvent.click(row);
  await waitFor(() => screen.getByTestId("epic-inline-card"));
  return row;
}

/**
 * The size actually painted, in px, read off the element or the nearest ancestor that sets one.
 *
 * INHERITANCE HAS TO BE WALKED BY HAND. jsdom loads no stylesheet and `getComputedStyle` resolves
 * no inherited inline `font-size`, so reading the title element alone would return `""` for any
 * element that inherits — which would make an assertion of "" === "" pass while proving nothing.
 * This walks up to the first box that states a size, which is what the browser would resolve to.
 */
function paintedFontSize(el: HTMLElement): string {
  for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) {
    if (n.style.fontSize !== "") return n.style.fontSize;
  }
  return "";
}

describe("sparkle-huw924.13 — the epic title is the size of the ladder row", () => {
  // POSITIVE CONTROL FIRST. Every comparison below is between two elements that must BOTH exist;
  // a column that never opened a card, or a row that vanished, would satisfy an equality of two
  // empty strings. AGENTS.md's fourth vacuous shape — absence proves nothing about a tree that is
  // not mounted — so the tree is proved first.
  it("renders both the ladder row and the open card's title", async () => {
    const row = await openTheEpic();
    const title = screen.getByTestId("epics-bead-card-title");
    expect(row.textContent).toContain("Work decomposition contract");
    expect(title.textContent).toBe(EPIC.title);
    expect(paintedFontSize(row)).not.toBe("");
    expect(paintedFontSize(title)).not.toBe("");
  });

  // THE ASK ITSELF. Note what is NOT written here: a number. The claim is that the two agree, so
  // the assertion compares them to each other and stays true across any retune of the row.
  it("paints the title at exactly the ladder row's font-size", async () => {
    const row = await openTheEpic();
    const title = screen.getByTestId("epics-bead-card-title");

    expect(paintedFontSize(title)).toBe(paintedFontSize(row));
  });

  // "SHOULD JUST BE BOLD" — the other half, and the half that makes the first half safe. Equal size
  // with equal weight would be a title indistinguishable from a row, which is a different bug and
  // one this suite would otherwise wave through.
  it("separates the title from the row by weight alone", async () => {
    const row = await openTheEpic();
    const title = screen.getByTestId("epics-bead-card-title");

    // ══ PINNED TO THE SPEC TOKEN, NOT TO THE STRING "600" ══════════════════════════════════
    // 600 is THIS design system's bold — `theme/scale.ts`: *"bold is 600 — not 700"* — and
    // `WEIGHT.bold` is that value extracted from `design-tokens.json` rather than retyped. A
    // literal here would be a SECOND place the number lives, which is exactly how this element
    // ended up with two suites asserting contradictory weights for one paint (roborev 69144).
    expect(title.style.fontWeight).toBe(String(WEIGHT.bold));
    // The row states no weight at all and inherits regular, so the two genuinely differ on screen.
    expect(row.style.fontWeight).toBe("");
  });
});

describe("sparkle-huw924.13 — the other two surfaces are untouched", () => {
  // *"You don't have to make any changes in the planning board."* Asked to choose between shrinking
  // the title everywhere and shrinking it in the Epics column alone, he chose the column alone — so
  // a change that leaked to the board would be the wrong fix, not an over-delivery.
  //
  // DRIVEN THROUGH `chrome="board"`, which is what every real board caller passes, rather than by
  // reaching for whatever knob currently implements the epics case. The shrink is keyed on `chrome`
  // (`BeadCard.tsx`), so mounting the OTHER discriminant value is the only thing that can catch a
  // change which drops the guard and shrinks every card on every surface.
  it("leaves a board-chrome card at the 17px heading size", async () => {
    render(
      <BeadCard
        chrome="board"
        bead={EPIC}
        stage="building_saved"
        id="card-1"
        workers={[]}
        collapsed={false}
      />,
    );
    const title = await waitFor(() => screen.getByTestId("board-bead-card-title"));
    expect(title.textContent).toBe(EPIC.title);
    expect(title.style.fontSize).toBe("17px");
  });

  // …AND THE EPICS CARD REALLY IS SMALLER THAN THAT. The pair is what pins the direction: the test
  // above alone passes if nothing anywhere changed, and the row-equality test above passes if the
  // ROW grew to meet a 17px title instead of the title shrinking to meet the row.
  it("draws the epics column's title smaller than the board's", async () => {
    await openTheEpic();
    const epicsTitle = screen.getByTestId("epics-bead-card-title");
    expect(Number.parseFloat(paintedFontSize(epicsTitle))).toBeLessThan(17);
  });
});
