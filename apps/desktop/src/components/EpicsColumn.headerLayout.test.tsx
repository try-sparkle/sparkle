// @vitest-environment jsdom
//
// WHERE "OPEN PLANNING BOARD" SITS IN THE EPICS HEADER.
//
// The founder, 2026-08-20, watching the column: *"I wanted the open planning board to be left
// justified and not right… It should just show to the right of the word epics."*
//
// The header is a `space-between` row, so "right-aligned" was never written down anywhere — it was
// EMERGENT from the link being the second of two children. That is exactly why a test here has to
// assert GROUPING rather than a style: there is no `justifyContent` on the link to read back, and
// asserting the header is still `space-between` would pass in both worlds. The discriminating fact
// is which parent the link shares.
//
// NOT A VACUOUS TEST — before this change `epics-open-plan-board` and `epics-clear-focus` were
// siblings in one right-hand control group, so `sharesParent(link, clear)` was TRUE and the
// title's group did not contain the link at all. Both assertions below flip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROJECT = { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents: [] } as unknown as Project;

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "epic", ...over } as Bead;
}

function seed(beads: Bead[], projectId = "p1") {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [projectId]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

beforeEach(() => {
  // Same reason as the sibling suites: a real poller shells out to `bd` and would clobber the
  // seeded snapshot asynchronously, which reads as a flake rather than a wrong assertion.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the Epics column header groups the board link with the TITLE, not with the controls", () => {
  it("keeps Open Planning Board in the title's own group", () => {
    seed([bead("ep-1")]);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const left = screen.getByTestId("epics-header-left");
    const link = screen.getByTestId("epics-open-plan-board");

    expect(left.contains(link)).toBe(true);
    expect(left.textContent).toContain("Epics");
  });

  it("does NOT group it with Clear, which is what parked it at the right edge", () => {
    // `Clear` renders only while an epic is focused, so this is the one arrangement in which both
    // controls exist at once — i.e. the only state in which the old grouping was observable.
    seed([bead("ep-1")]);
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const link = screen.getByTestId("epics-open-plan-board");
    const clear = screen.getByTestId("epics-clear-focus");

    // THE ASSERTION THAT FLIPS. These two were siblings; now they are in opposite groups.
    expect(link.parentElement === clear.parentElement).toBe(false);
    expect(screen.getByTestId("epics-header-left").contains(clear)).toBe(false);
  });

  it("still paints the title before the link, and the link before Clear", () => {
    // Grouping must not have reordered the header. `DOCUMENT_POSITION_FOLLOWING` = 4.
    seed([bead("ep-1")]);
    useUiStore.setState({ epicFocusBySide: { left: null, right: "ep-1" } } as never);
    render(<EpicsColumn project={PROJECT} side="right" />);

    const left = screen.getByTestId("epics-header-left");
    const link = screen.getByTestId("epics-open-plan-board");
    const clear = screen.getByTestId("epics-clear-focus");

    expect(left.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    expect(link.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
