// @vitest-environment jsdom
//
// THE FULL-WIDTH GRAY BAR THE "Column" LINK LEFT BEHIND — bead sparkle-huw924.15.
//
// ══ THE REPORT ═════════════════════════════════════════════════════════════════════════════════
// The founder, 2026-08-26 ~5:24 AM PT, verbatim: *"when i click on 'column' view i get a gray bar
// all the way across. i think that's the color square getting messed up"*.
//
// ══ WHAT IT ACTUALLY WAS — NEITHER OF THE TWO HYPOTHESES ═══════════════════════════════════════
// It is NOT the colour square, and it is NOT an empty row. Both are ruled out by evidence rather
// than by argument, and both rulings are asserted below so they cannot quietly become true later:
//
//   (a) NOT THE SQUARE. The revealed row is a STANDALONE task, and `EpicsColumn` renders it with
//       `health={null}` on purpose ("a bead with no children has no roll-up to report"). There is
//       no swatch in that row AT ALL, so no swatch can have stretched. `renders no health square`
//       below pins that.
//   (b) NOT AN EMPTY ROW. The founder's own screenshot shows the title, the close X and the P1
//       chiclet all painted inside the bar. `renders its real children` below pins that.
//
// THE BAR IS THE ROW'S OWN `<button>` FALLING BACK TO THE UA `ButtonFace` DEFAULT, because the
// reveal's flash DELETED the row's background and never put it back. Measured, not reasoned:
// sampling the founder's screenshot gives the bar `#c0c0c0` and the card directly beneath it
// `#1d3362` (`--c-epic-card-fill`, dark). `#c0c0c0` is WebKit's `ButtonFace` — the colour a
// `<button>` takes when NOTHING declares its background. Reproduced end to end in real WebKit and
// real Chromium (playwright, both engines) with the exact declaration `EpicRow` emits:
//
//   button style="background: var(--c-epic-card-fill)"
//   el.style.backgroundColor                    -> ""                       <- the flash's snapshot
//   el.style.backgroundColor = "#e0982f"        -> paints                   <- the flash
//   el.style.backgroundColor = ""               -> computed rgb(192,192,192) <- the undo, WebKit
//                                                  computed rgb(239,239,239) <- the undo, Chromium
//
// The mechanism is one line of CSSOM: a SHORTHAND carrying a `var()` gives its longhands
// "pending-substitution" values, and a longhand read of one returns the EMPTY STRING. So
// `applyFlash` snapshotted `""`, wrote a rival `background-color` longhand over the top, and on undo
// removed that longhand — which takes the shorthand's colour with it. React never repaints it,
// because the `background` PROP never changed, so the gray is permanent until the row unmounts.
//
// ══ WHY THE ASSERTIONS BELOW READ THE DECLARATION AND NOT THE PAINTED COLOUR ═══════════════════
// jsdom never lays out and has no UA stylesheet to fall back to, so it cannot show you the gray:
// `getComputedStyle(row).backgroundColor` reports nothing useful and there is no `ButtonFace` here.
// What jsdom DOES reproduce faithfully is the CSSOM half — the part that is actually broken. Both
// halves are asserted on the DECLARATION, which is the observable that differs:
//
//   * DURING the flash, the row's own `background` must BE the flash fill. Before the fix the flash
//     wrote a rival `background-color` longhand instead, which leaves the shorthand unserializable
//     (`""`) — i.e. the row's own declaration is no longer readable, let alone restorable.
//   * AFTER the flash, `background` must be the epic card fill again. Before the fix it is `""`:
//     the declaration is gone, which in a real engine is exactly the `#c0c0c0` bar.
//
// Both red before the fix and green after it. The colour a real engine then paints over that empty
// declaration is engine-specific (WebKit `#c0c0c0`, Chromium `#efefef`) and is deliberately NOT
// asserted here — pinning an engine default would be pinning the defect's symptom rather than the
// cause. The playwright probe above is where that half was measured.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import { C } from "../theme/colors";
import type { Project } from "../types";

const PROJECT = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/alpha",
  agents: [],
} as unknown as Project;

const EPIC_ID = "ep-1";
const CHILD_ID = "ep-1.a";
/** A PARENTLESS, CHILDLESS TASK — the founder's own case (his bar carried `sparkle-plmpnm`), and
 *  the common one: `EpicsColumn` records 45 of 46 agent-linked beads taking this path. */
const LONE_ID = "lone-1";
const LONE_TITLE = "Judge lanes should draw on the rotation fleet";

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "task", ...over } as Bead;
}

const BEADS = [
  bead(EPIC_ID, { type: "epic", title: "The epic being worked" }),
  bead(CHILD_ID, { parent: EPIC_ID, title: "Wire the rows" }),
  bead(LONE_ID, { title: LONE_TITLE, priority: 1 }),
];

/** THE ARRAY HANDED TO THE COLUMN MUST BE THE VERY ONE IN THE STORE — the connected wrapper
 *  resolves its project by REFERENCE IDENTITY. Carried over from `EpicsColumn.taskFocus.test.tsx`. */
function seed() {
  useBeadsStore.setState(
    (prev) =>
      ({
        ...prev,
        byProject: {
          ...(prev as { byProject: Record<string, unknown> }).byProject,
          [PROJECT.id]: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 },
        },
        error: {},
      }) as never,
  );
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id } as never);
}

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    columnRevealBySide: { left: null, right: null },
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

/** Press "Column" on the lone task, exactly as `BeadCard`'s handler does — `revealBeadInColumn` is
 *  the store action that link calls. Driving the STORE rather than the link keeps this file off
 *  `BeadCard.tsx`, which a sibling worker owns and is restyling right now. */
async function pressColumnOn(beadId: string) {
  render(<EpicsColumn project={PROJECT} side="right" />);
  await waitFor(() => screen.getByTestId("epics-column-list"));
  useUiStore.getState().revealBeadInColumn("right", beadId);
  return await waitFor(() => screen.getByTestId("epics-standalone-reveal"));
}

/** The row the flash actually landed on. `data-bead-flash` is `applyFlash`'s own marker. */
async function flashedRow(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-bead-flash]");
    if (el === null) throw new Error("no row is flashing yet");
    return el;
  });
}

describe("pressing 'Column' on a parentless task", () => {
  // ── THE REPRO ──────────────────────────────────────────────────────────────────────────────
  it("flashes the row by REPLACING its own background declaration, not by shadowing it", async () => {
    await pressColumnOn(LONE_ID);
    const row = await flashedRow();

    // The row is the SELECTED standalone row, so at rest it declares `background:
    // var(--c-epic-card-fill)` — the shorthand, with a var in it. That is the declaration the flash
    // has to take over.
    expect(row.dataset.revealId).toBe(LONE_ID);

    // ══ THE ONE THAT REDS BEFORE THE FIX ══════════════════════════════════════════════════════
    // The flash must own the SAME property the row declares. Before the fix it wrote the
    // `background-color` LONGHAND instead, leaving the row's own `background` shorthand still
    // saying `var(--c-epic-card-fill)` underneath it — and it is removing that rival longhand on
    // undo which deletes the shorthand's colour in WebKit and leaves the founder's `#c0c0c0` bar.
    expect(row.style.getPropertyValue("background")).toBe(C.epicPillFill);
    // ...and nothing is left shadowing it. Two background declarations on one node is the shape
    // whose teardown is unsound; one is the shape whose teardown is exact.
    expect(row.style.getPropertyValue("background-color")).toBe("");

    // The paired ink is still applied — the row must not lose its text for the 1.2s it is amber.
    expect(row.style.getPropertyValue("color")).toBe(C.onEpicPillFill);
  });

  it("puts the row's own fill back, byte for byte, when the flash ends", async () => {
    await pressColumnOn(LONE_ID);
    const row = await flashedRow();

    await waitFor(
      () => {
        if (row.hasAttribute("data-bead-flash")) throw new Error("still flashing");
      },
      { timeout: 4000 },
    );

    // THE OTHER HALF OF THE REPRO. Before the fix this read `""` — the row's fill was simply gone,
    // which is the founder's bar. A future "simplification" of the teardown that drops the saved
    // shorthand, or restores only one of the two forms, reds here again.
    expect(row.style.getPropertyValue("background")).toBe(C.epicCardFill);
    expect(row.style.getPropertyValue("background-color")).toBe("");
    expect(row.style.getPropertyValue("color")).toBe(C.cream);
  });

  // ── THE PAIR: THE ROW THE REVEAL DID NOT TOUCH ────────────────────────────────────────────────
  // One test proving a property of the flashed row is ambiguous — it passes just as well against a
  // flash that paints every row in the column. This pins the cause to the ONE row the gesture named.
  it("leaves every other row's background declaration exactly as it was", async () => {
    await pressColumnOn(LONE_ID);
    const flashed = await flashedRow();

    const others = screen
      .getAllByTestId("epic-row")
      .filter((r) => r !== flashed && r.dataset.revealId !== LONE_ID);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(other.hasAttribute("data-bead-flash")).toBe(false);
      // Unselected rows declare `transparent` through the SAME shorthand; an unfocused row must
      // read exactly as it did before the gesture. (`transparent` carries no `var()`, so CSSOM
      // expands it into longhands normally — which is precisely why the UNSELECTED path never
      // showed this bug and only the selected, `var()`-filled row went gray.)
      expect(other.style.getPropertyValue("background")).toBe("transparent");
      expect(other.style.getPropertyValue("background-color")).toBe("transparent");
    }
  });

  // ── HYPOTHESIS (b): THE ROW DID PAINT ITS CHILDREN ────────────────────────────────────────────
  it("renders its real children — the bar was never an empty row", async () => {
    const standalone = await pressColumnOn(LONE_ID);
    const row = within(standalone).getByTestId("epic-row");

    // The title, the close X (the count slot's substitution while the card is open) and the
    // priority chiclet — the three things the founder's screenshot shows INSIDE the gray bar.
    expect(row.textContent ?? "").toContain(LONE_TITLE);
    expect(within(row).getByTestId("epic-row-close")).toBeTruthy();
    expect(within(row).getByTestId("epic-row-priority")).toBeTruthy();
  });

  // ── HYPOTHESIS (a): THERE IS NO SWATCH IN THIS ROW TO GET "MESSED UP" ─────────────────────────
  it("renders no health square at all on a standalone task row", async () => {
    const standalone = await pressColumnOn(LONE_ID);
    const row = within(standalone).getByTestId("epic-row");
    // `health={null}` by design. Asserted so that adding one later is a deliberate, visible change
    // rather than a silent re-opening of the founder's own reading of this bug.
    expect(within(row).queryByTestId("epic-health")).toBeNull();
  });
});
