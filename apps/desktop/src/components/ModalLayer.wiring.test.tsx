// @vitest-environment jsdom
//
// ── THE TEST THAT WOULD HAVE CAUGHT IT, AND THE ONES THAT DID NOT ──────────────────────────────
//
// The defect: the concierge column's pull tab painted ON TOP OF the settings modal and its scrim.
// Not because any z-index was wrong — every one of them was right — but because of WHERE the modal
// was rendered. `ConciergeColumn`'s root `<section>` is `position: relative` + `CONCIERGE_LIFT_Z`
// (3), which makes it a STACKING CONTEXT; `Concierge/KebabMenu` renders `<SettingsDialog>` inside
// it; so the dialog's `zIndex: 41` never meant 41, it meant "layer 3 of the shell". `ColumnPullTab`'s
// rail is a SIBLING at `PULL_TAB_RAIL_Z` (4). Four beats three, and the tab painted over an
// app-modal dialog.
//
// `SettingsDialog.test.tsx` renders the dialog on its own and passes. It passed all the way through
// this bug and would pass again if the portal were reverted, because a dialog rendered at the root
// of a test container is already in the root stacking context — the test constructs the very
// condition the app fails to provide. `Concierge/KebabMenu.test.tsx` is worse for this purpose: it
// `vi.mock`s SettingsDialog out entirely, so it asserts the mount decision and nothing about the
// surface. Both are correct tests of what they cover. Neither can see this class of bug.
//
// So this file asserts the WIRING: the real `ConciergeColumn`, the real `KebabMenu` inside it, the
// real `SettingsDialog` opened through it, and the question "did the dialog escape the column's
// stacking context". jsdom cannot compare paint order, so escape-by-parentage is the mechanism
// standing in for the pixels — but it is the exact mechanism that was broken, and reverting the
// portal turns this file red.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks: the column's IPC-touching leaves ────────────────────────────────────────────────────
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── mocks: the settings panes' writers and probes ──────────────────────────────────────────────
// PARTIAL (spreads the real module) for the same reason SettingsDialog.test.tsx gives: the dialog
// mounts a whole pane, and an exhaustive factory silently makes every export it forgot `undefined`.
vi.mock("../services/configActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/configActions")>()),
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  setPluginEnabled: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
  setBuilderIndexEnabled: vi.fn().mockResolvedValue(undefined),
  refreshPluginInstallState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/sparkleApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/sparkleApi")>()),
  openSignIn: vi.fn().mockResolvedValue(true),
  signOut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/trialApi", () => ({ fetchTrial: vi.fn(() => new Promise(() => {})) }));
vi.mock("./CreditsPanel", () => ({ CreditsPanel: () => null }));
vi.mock("./OnePasswordPane", () => ({
  OnePasswordPane: () => <div data-testid="onepassword-pane" />,
}));

import { CONCIERGE_LIFT_Z, ConciergeColumn } from "./Concierge/ConciergeColumn";
import { PULL_TAB_RAIL_Z } from "./ColumnPullTab";
import type { ConciergeController, ConciergeViewModel } from "./Concierge/types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);
afterEach(cleanup);

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  messages: [],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

/** The production nesting, not an approximation of it: ConciergeColumn renders ConciergeTopRight,
 *  which renders KebabMenu, which mounts SettingsDialog. Nothing here is stubbed between the column
 *  and the dialog — that chain IS the thing under test. */
function openSettingsFromTheColumn() {
  render(<ConciergeColumn model={model} controller={controller()} />);
  // ONE click. The kebab used to open a one-item dropdown that this helper then had to click
  // through; that menu is gone (see Concierge/KebabMenu) and the trigger opens Settings directly.
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  return screen.getByLabelText("Sparkle concierge");
}

describe("a modal opened from inside the lifted concierge column", () => {
  it("has a host that really is a stacking context — the precondition the bug needed", () => {
    // Stated first and separately so the escape assertions below cannot be read as vacuous. If this
    // ever goes false the column stopped lifting, and the rest of this file is testing a hazard that
    // no longer exists — which is a thing to notice, not to silently keep passing.
    const column = openSettingsFromTheColumn();
    expect(column.style.position).toBe("relative");
    expect(Number(column.style.zIndex)).toBe(CONCIERGE_LIFT_Z);
    // And the tab that beat it is a sibling one layer up. This pair is the whole bug in two numbers.
    expect(PULL_TAB_RAIL_Z).toBeGreaterThan(CONCIERGE_LIFT_Z);
  });

  it("is NOT a descendant of the column — it is parented to document.body", () => {
    const column = openSettingsFromTheColumn();

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const backdrop = screen.getByTestId("settings-backdrop");

    // THE ASSERTION. Inside the column, `zIndex: 41` is capped at the column's 3 and the pull tab
    // at 4 paints over it. Outside, 41 is 41.
    expect(column.contains(dialog)).toBe(false);
    expect(column.contains(backdrop)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(backdrop.parentElement).toBe(document.body);
  });

  it("is not trapped by ANY stacking context between it and the root", () => {
    // The column is the one that bit us, but the guarantee has to be stronger than "not that one" —
    // the header, the top-right cluster and the kebab's own `position: relative` wrapper are all
    // ancestors that a future commit could give a z-index to. Walking the chain says the modal
    // cleared every one of them, which is the property `ModalLayer` actually promises.
    openSettingsFromTheColumn();
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    const chain: string[] = [];
    for (let el = dialog.parentElement; el && el !== document.body; el = el.parentElement) {
      chain.push(el.tagName + (el.getAttribute("data-testid") ?? el.className ?? ""));
    }
    expect(chain).toEqual([]);
  });

  it("still works from its portaled position — the close button closes it", () => {
    openSettingsFromTheColumn();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    // React synthetic events bubble along the REACT tree, not the DOM tree, so a portal is exactly
    // the kind of move that silently severs a handler. `onClose` lives in KebabMenu, three DOM
    // subtrees away from where this button now lives.
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("still dismisses on a backdrop click from its portaled position", () => {
    openSettingsFromTheColumn();
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  // The kebab dismisses its dropdown on any outside `pointerdown`, tested as
  // `rootRef.current.contains(e.target)` — a NATIVE DOM containment check, and a portaled dialog is
  // by construction not contained. That is the one hazard of this refactor that a z-index could
  // never have caused, so pin the outcome: opening settings must not leave the dialog fighting the
  // menu's dismissal logic. (It does not, because `setOpen(false)` runs before the dialog mounts and
  // the listener is registered only while the menu is open — but that is an invariant, not luck.)
  it("survives clicks inside itself without the kebab's outside-click logic unmounting it", () => {
    openSettingsFromTheColumn();
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });
});
