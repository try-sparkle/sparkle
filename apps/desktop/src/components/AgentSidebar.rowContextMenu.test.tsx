// @vitest-environment jsdom
//
// RIGHT CLICK OPENS A MENU. DOUBLE CLICK ONLY EVER MOUNTS. The founder's rule, 2026-08-13.
//
// Verbatim: *"Renaming of the builder row should now go into right click of the builder row. It
// should be an option in the right click menu."* Asked which shape, the founder chose a small menu
// with the detail card kept behind an item:
//
//     ┌─────────────────────┐
//     │  Rename             │
//     │  Open details…      │
//     │  ─────────────────  │
//     │  Close agent        │
//     └─────────────────────┘
//
// ══ WHY THIS FILE EXISTS BESIDE `AgentSidebar.rowMountGesture.test.tsx` ═════════════════════════
// That file pins WHICH GESTURE DOES WHAT — single click selects, double click mounts. This one pins
// the SURFACE the third gesture now opens, and the two halves of the founder's ask that no gesture
// table can express: that the menu's Rename item reaches the same inline editor, and that the row's
// right click has exactly ONE answer everywhere on it.
//
// ══ THE STATE BEFORE THIS CHANGE, WHICH IS WHY "ANYWHERE" IS THE WHOLE POINT ════════════════════
// A right click had TWO different answers depending on where it landed, and neither was a menu:
// over the agent NAME it began an inline rename instantly (`beginRename`), and anywhere else on the
// row it threw the detail card across the pane (`openCard`). The name span is `flex: 1`, so it
// covers the row's entire flexible width — the two zones were not remotely equal in size, and which
// one you hit was not predictable from anything on screen.
//
// ══ WHAT IS ASSERTED IS THE SIDE EFFECT ════════════════════════════════════════════════════════
// The rename case types a new name and presses Enter, then reads it back out of `projectStore` —
// not that an `<input>` appeared. An editor that opens and drops what you type is the failure this
// menu is most likely to introduce, and "the input is on screen" cannot see it.
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  pushAgentBranch: vi.fn(() => Promise.resolve("pushed")),
  openAgentPr: vi.fn(() => Promise.resolve("https://pr/1")),
  deleteAgentBranch: vi.fn(() => Promise.resolve()),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));
// The close path reaps the worktree and the pty in the background; both cross the Tauri boundary,
// which does not exist under jsdom. Stubbed so the teardown is deterministic and never rejects into
// a test — the retirement FLOW itself is owned by AgentSidebar.closeAgent.test.tsx.
vi.mock("../services/worktree", () => ({ removeAgentWorkspace: vi.fn(() => Promise.resolve()) }));
vi.mock("../pty", () => ({ killPty: vi.fn(() => Promise.resolve()) }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { resetPaneFocus } from "../stores/paneFocusStore";
import { C } from "../theme/colors";
import { doubleClickRow, openAgentCard, openRowMenu, rowMenu } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

const OTHER = "Concierge column layout";
const SELECTED = "Stripe checkout retry";

const PROJECT: Project = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: "a1",
  agents: [mkAgent("a1", SELECTED), mkAgent("a2", OTHER)],
};

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

/** The agent NAME inside a row — the span that used to swallow the double press for rename, and
 *  that covers the row's whole flexible width. */
const nameIn = (row: HTMLElement) => within(row).getByTestId("row-agent-name");

const wired = () => useCableStore.getState().wired;
const card = () => screen.queryByTestId("agent-hover-card");
const agentIds = () =>
  useProjectStore.getState().projects.find((x) => x.id === "p1")?.agents.map((a) => a.id) ?? [];
const nameOf = (id: string) =>
  useProjectStore.getState().projects.find((x) => x.id === "p1")?.agents.find((a) => a.id === id)
    ?.name ?? null;
const selectedAgentId = () =>
  useProjectStore.getState().projects.find((x) => x.id === "p1")?.selectedAgentId ?? null;

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({
    openAgentIds: ["a1", "a2"],
    status: {},
    // Clean and level with the base: `shouldPromptOnClose` is false, so Close agent retires the row
    // outright instead of raising the Ship/Save/Discard dialog. That dialog has its own file; what
    // this one needs is an OBSERVABLE outcome for the menu item.
    branchStatus: {
      a1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0, branch: "sparkle/agent-a1" },
      a2: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0, branch: "sparkle/agent-a2" },
    },
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  useUiStore.setState({
    activeSpecial: null,
    collapsedOrchestrators: {},
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  resetCable();
  resetPaneFocus();
});
afterEach(() => {
  cleanup();
  resetCable();
  resetPaneFocus();
});

// ══ TEST 1 — THE REGRESSION GUARD ══════════════════════════════════════════════════════════════
// v0.102.0 shipped with `FittedAgentName` owning `onDoubleClick` for rename. That span is `flex: 1`,
// so it covers the row's whole flexible width: double-clicking a row where a person actually aims
// renamed it and never mounted anything. `2602a9e9f` moved rename off the double click, and this is
// what stops it coming back — including via the new menu, which must not re-acquire the gesture.
describe("a double click on a builder row", () => {
  it("mounts the concierge and opens NO rename field — aimed at the agent name", () => {
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(nameIn(rowFor(OTHER)));
    // Both halves, because either alone is satisfiable by the broken build: the shipped version
    // opened the editor and did not mount, so a test asserting only the absence of the editor would
    // pass against a row that does nothing at all.
    expect(wired()).toBe("right");
    expect(screen.queryByDisplayValue(OTHER)).toBeNull();
  });

  it("…on the LETTERS themselves, where the retired handler actually sat", () => {
    // `nameIn` is the OUTER span; the `dblclick` that swallowed the mount lived on the INNER one
    // holding the text. A synthetic event propagates UPWARD from its target, so an event dispatched
    // on the outer span never traverses the inner one — aiming there cannot see the old handler at
    // all. Both are here for that reason (roborev 63223 made the same correction next door).
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(screen.getByText(OTHER));
    expect(wired()).toBe("right");
    expect(screen.queryByDisplayValue(OTHER)).toBeNull();
  });

  it("…and the menu never appears on a double press", () => {
    // The new failure mode this feature could introduce: a menu wired to a gesture the mount needs.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(nameIn(rowFor(OTHER)));
    expect(rowMenu()).toBeNull();
  });
});

// ══ TEST 2 — THE MENU ITSELF ═══════════════════════════════════════════════════════════════════
describe("the builder row's right-click menu", () => {
  it("opens at the cursor, with the founder's three items", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER), { clientX: 120, clientY: 80 });
    const menu = rowMenu();
    expect(menu).not.toBeNull();
    expect(menu!.getAttribute("role")).toBe("menu");
    // Anchored where the pointer was, not at a fixed corner.
    expect(menu!.style.left).toBe("120px");
    expect(menu!.style.top).toBe("80px");
    expect(
      within(menu!)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["Rename", "Open details…", "Close agent"]);
  });

  it("opens over the agent NAME too — one answer, no dead zone", () => {
    // The half the founder asked for by name. The name used to claim `contextmenu` for an instant
    // rename and stop it propagating, so the row's own right click was dead over its largest target.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(nameIn(rowFor(OTHER)));
    expect(rowMenu()).not.toBeNull();
    // …and on the LETTERS, which is a strictly longer propagation path — see the double-click case.
    fireEvent.keyDown(document, { key: "Escape" });
    openRowMenu(screen.getByText(OTHER));
    expect(rowMenu()).not.toBeNull();
  });

  it("does NOT open the detail card any more — that moved behind an item", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(card()).toBeNull();
  });

  it("leaves no native menu standing behind it", () => {
    render(<AgentSidebar project={PROJECT} />);
    const row = rowFor(OTHER);
    const ev = createEvent.contextMenu(row);
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does not touch the cable just by opening", () => {
    // Asserted from BOTH resting states: an unpatched cable staying off could be a handler that
    // never ran at all.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(rowMenu()).not.toBeNull();
    expect(wired()).toBe("off");
    cleanup();
    useCableStore.getState().patch("right", null);
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(wired()).toBe("right");
  });

  it("is PART OF THE LIVE CIRCUIT — dismissing it must not drop the cable", () => {
    // The menu and its backdrop are portalled to `document.body`, so the cable's "did this press
    // leave the circuit" test — which walks DOM ancestry — cannot tie either back to the row that
    // owns it. Portal roots opt in explicitly (engine/cable's CIRCUIT_SELECTOR); without the marker
    // dismissing this menu drops the cable, which is roborev 54821 relocated.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(rowMenu()!.hasAttribute("data-circuit")).toBe(true);
    expect(screen.getByTestId("row-context-menu-backdrop").hasAttribute("data-circuit")).toBe(true);
  });
});

describe("Rename, in the menu", () => {
  it("opens the inline editor on THAT row and the typed name LANDS", () => {
    // THE SIDE EFFECT, not the input. An editor that opens and drops what you type would satisfy
    // `getByDisplayValue` and fail the user completely.
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByDisplayValue(OTHER)).toBeNull();
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-rename"));

    const input = screen.getByDisplayValue(OTHER) as HTMLInputElement;
    expect(input).toBeInstanceOf(HTMLInputElement);
    // …and it is THIS row's editor, not the SELECTED row's. A menu that renamed whatever happened
    // to be selected would satisfy a bare "an input exists" check from any row in the column.
    expect(input.closest('[data-hint="agent"]')).not.toBe(rowFor(SELECTED));
    expect(nameOf("a2")).toBe(OTHER);

    fireEvent.change(input, { target: { value: "Renamed by menu" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(nameOf("a2")).toBe("Renamed by menu");
    // The OTHER row is untouched — the rename landed on the row that was right-clicked.
    expect(nameOf("a1")).toBe(SELECTED);
  });

  it("dismisses the menu once chosen", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-rename"));
    expect(rowMenu()).toBeNull();
  });

  it("does not mount the concierge", () => {
    // Rename is not a mount, and the menu sits over the row that owns it — a click that reached the
    // row underneath would both select and (on a second press) patch.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-rename"));
    expect(wired()).toBe("off");
  });
});

describe("Open details…, in the menu", () => {
  it("opens the detail card the right click used to open directly", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(card()).toBeNull();
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-open-details"));
    expect(card()).not.toBeNull();
    expect(rowMenu()).toBeNull();
  });

  it("selects the row first, so the card and the terminal show the same agent", () => {
    // `openCard`'s old contract, kept: the card is a detail view of an agent, and opening one for a
    // row the pane is not showing put the two surfaces on different agents.
    render(<AgentSidebar project={PROJECT} />);
    expect(selectedAgentId()).toBe("a1");
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-open-details"));
    expect(selectedAgentId()).toBe("a2");
  });
});

describe("Close agent, in the menu", () => {
  it("retires the row — the same outcome as the × on it", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(agentIds()).toEqual(["a1", "a2"]);
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-close-agent"));
    expect(agentIds()).toEqual(["a1"]);
  });

  it("is the DESTRUCTIVE item, and reads as one", () => {
    // The founder asked for it below a separator in the app's destructive ink. `dangerInk`, not the
    // `sienna` FILL the helper's menu uses: `theme/linkContrast.test.ts` forbids painting text with
    // a fill token, and this menu is new code.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    const close = screen.getByTestId("row-menu-close-agent");
    expect(close.style.color).toBe(C.dangerInk);
    // …and the two above it are NOT — otherwise the ink says nothing.
    expect(screen.getByTestId("row-menu-rename").style.color).not.toBe(C.dangerInk);
    expect(screen.getByTestId("row-context-menu-separator")).toBeTruthy();
  });
});

describe("dismissing the menu", () => {
  it("Escape closes it", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(rowMenu()).not.toBeNull(); // or "it closed" is satisfied by a menu that never opened
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rowMenu()).toBeNull();
  });

  it("a press outside closes it", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(rowMenu()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(rowMenu()).toBeNull();
  });

  it("a press INSIDE does not", () => {
    // The paired case. Without it, a dismissal that fired on every pointerdown would satisfy the
    // one above while making the menu unusable.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    fireEvent.pointerDown(screen.getByTestId("row-menu-rename"));
    expect(rowMenu()).not.toBeNull();
  });

  it("clicking the backdrop closes it", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    expect(rowMenu()).not.toBeNull();
    fireEvent.click(screen.getByTestId("row-context-menu-backdrop"));
    expect(rowMenu()).toBeNull();
  });

  it("a second right click re-anchors it rather than leaving the first standing", () => {
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER), { clientX: 120, clientY: 80 });
    openRowMenu(rowFor(SELECTED), { clientX: 40, clientY: 200 });
    expect(screen.getAllByTestId("row-context-menu")).toHaveLength(1);
    expect(rowMenu()!.style.left).toBe("40px");
  });
});

describe("a double press ON THE MENU never reaches the row underneath", () => {
  it("does not mount the concierge", () => {
    // `stopPropagation` ON A CLICK DOES NOT STOP A DBLCLICK — the trap that made every chip on this
    // row leak the mount (roborev 63145). The menu is portalled, and a portal's React events bubble
    // through the OWNER tree rather than the DOM one, so the row's `contains`-based control bail
    // cannot see a press inside it. What keeps this honest is WHERE the menu is rendered: a sibling
    // of the row element, not a child of it. Move it inside the row and this goes red.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    const item = screen.getByTestId("row-menu-open-details");
    fireEvent.click(item, { detail: 1 });
    fireEvent.click(item, { detail: 2 });
    fireEvent.doubleClick(item, { detail: 2 });
    expect(wired()).toBe("off");
  });
});

describe("while a rename is in progress", () => {
  it("a right click inside the input gets the NATIVE menu, not this one", () => {
    // The column's only text field. `preventDefault` here would suppress cut/copy/paste inside it —
    // the reason `openCard` returned early on `editing` in the first place (roborev 53814).
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-rename"));
    const input = screen.getByDisplayValue(OTHER);

    const ev = createEvent.contextMenu(input);
    fireEvent(input, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(rowMenu()).toBeNull();
  });

  it("…and a right click on the ROW while it is editing opens nothing either", () => {
    // Same rule stated at the row, because the input does not fill it: the gutter beside the field
    // is still the row, and `editing` is the row's state rather than the input's.
    render(<AgentSidebar project={PROJECT} />);
    openRowMenu(rowFor(OTHER));
    fireEvent.click(screen.getByTestId("row-menu-rename"));
    const row = screen.getByDisplayValue(OTHER).closest('[data-hint="agent"]') as HTMLElement;
    const ev = createEvent.contextMenu(row);
    fireEvent(row, ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(rowMenu()).toBeNull();
  });
});

describe("the keyboard path — Shift+F10 / the Menu key", () => {
  it("opens the menu on the focused row, and Rename is reachable with arrows and Enter", () => {
    // The row is focusable (roving tabstop), and a focused element receives `contextmenu` from
    // Shift+F10 and the Menu key. That is the FIRST keyboard route to rename this app has ever had —
    // there is no shortcut for it — so it is a gain rather than a restoration, and it is the reason
    // the items are real `role="menuitem"` buttons rather than divs.
    render(<AgentSidebar project={PROJECT} />);
    const row = rowFor(OTHER);
    row.focus();
    // No cursor position: a keyboard-raised contextmenu carries clientX/clientY of 0, so the menu
    // anchors to the ROW's rect instead. (jsdom reports every rect as 0, so the position itself is
    // not assertable here — that it OPENS at all is.)
    fireEvent.contextMenu(row);
    const menu = rowMenu();
    expect(menu).not.toBeNull();

    const items = within(menu!).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]); // focus lands inside the menu on open
    fireEvent.keyDown(menu!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    // Enter on a focused <button> is a click in every engine; jsdom does not synthesise it, so the
    // activation is driven directly — what this pins is that the focused item IS the rename item.
    expect(items[0]).toBe(screen.getByTestId("row-menu-rename"));
    fireEvent.click(items[0]!);
    expect(screen.getByDisplayValue(OTHER)).toBeInstanceOf(HTMLInputElement);
  });
});

// ══ THE HELPER'S OWN CONTRACT ══════════════════════════════════════════════════════════════════
// `openAgentCard` is used by ~30 cases across six files to reach the detail card. Right-clicking the
// row no longer opens it, so the helper now drives the menu — and this pins that it still delivers
// what its name promises, because every one of those files depends on it silently.
describe("testing/rowGestures.openAgentCard", () => {
  it("still opens the detail card, now through the menu", () => {
    render(<AgentSidebar project={PROJECT} />);
    openAgentCard(rowFor(OTHER));
    expect(card()).not.toBeNull();
    // …and leaves no menu standing over it.
    expect(rowMenu()).toBeNull();
  });
});
