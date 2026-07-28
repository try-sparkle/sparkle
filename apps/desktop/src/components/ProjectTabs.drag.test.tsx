// @vitest-environment jsdom
//
// The tab DRAG gesture — the half of tear-off that lives in the component rather than in the pure
// resolver (tabDrag.ts, tested separately).
//
// What is actually worth asserting here is the wiring the resolver cannot see: that the slop gate
// keeps a sloppy click a click, that a completed drag does NOT also fire onSelect, that a cancelled
// pointer commits nothing, and that a press starting on the pin or the × never drags the tab out
// from under the control the user aimed at. Every one of those was a real hazard in the design, and
// none of them is expressible as a call to `resolveTabDrag`.
//
// jsdom measures every box as 0×0, so the strip and tab rects are stubbed. That is not a shortcut
// around the geometry — the geometry is the resolver's job — it is what lets the WIRING be tested
// at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectTabs, tabTitle } from "./ProjectTabs";

const projects = [
  { id: "sparkle", name: "sparkle" },
  { id: "website", name: "drodio-website" },
];

// A believable strip: 34px tall at the top of the window, two tabs in it.
const STRIP = { x: 0, y: 0, width: 800, height: 34 };
const TABS: Record<string, { x: number; width: number }> = {
  sparkle: { x: 8, width: 100 }, // midpoint 58
  website: { x: 111, width: 120 }, // midpoint 171
};

afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

function stubRects(): void {
  const bar = screen.getByRole("tablist");
  bar.getBoundingClientRect = () => ({ ...STRIP, top: STRIP.y, left: STRIP.x, right: 800, bottom: 34, toJSON: () => ({}) }) as DOMRect;
  for (const [id, r] of Object.entries(TABS)) {
    const el = screen.getByTestId(`tab-${id}`);
    el.getBoundingClientRect = () =>
      ({ x: r.x, y: STRIP.y, width: r.width, height: STRIP.height, top: STRIP.y, left: r.x, right: r.x + r.width, bottom: STRIP.height, toJSON: () => ({}) }) as DOMRect;
  }
}

function renderTabs(overrides: Partial<Parameters<typeof ProjectTabs>[0]> = {}) {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onReorder = vi.fn();
  const onTearOff = vi.fn();
  const onClose = vi.fn();
  render(
    <ProjectTabs
      projects={projects}
      selectedProjectId="sparkle"
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onClose={onClose}
      onReorder={onReorder}
      onTearOff={onTearOff}
      {...overrides}
    />,
  );
  stubRects();
  return { onSelect, onTogglePin, onReorder, onTearOff, onClose };
}

/** One press → moves → release, all on the same tab (pointer capture means the real browser
 *  delivers every move there too, however far the pointer travels). */
function drag(
  id: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  o: { release?: "up" | "cancel"; screen?: { x: number; y: number } } = {},
) {
  const tab = screen.getByTestId(`tab-${id}`);
  fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y, screenX: from.x, screenY: from.y });
  const s = o.screen ?? to;
  fireEvent.pointerMove(tab, { pointerId: 1, clientX: to.x, clientY: to.y, screenX: s.x, screenY: s.y });
  if (o.release === "cancel") fireEvent.pointerCancel(tab, { pointerId: 1, clientX: to.x, clientY: to.y });
  else fireEvent.pointerUp(tab, { pointerId: 1, clientX: to.x, clientY: to.y, screenX: s.x, screenY: s.y });
  // The browser fires `click` after `pointerup`; testing-library's fireEvent does not, so the
  // suppression path has to be exercised explicitly or it would look like it works when it doesn't.
  if (o.release !== "cancel") fireEvent.click(tab);
  return tab;
}

describe("ProjectTabs drag", () => {
  it("treats movement under the slop as a plain click, not a drag", () => {
    const { onSelect, onReorder, onTearOff } = renderTabs();
    // 3px — a shaky hand on a click, which must still SELECT. This is the gate that decides whether
    // the feature is a nuisance: too tight and every click reorders.
    drag("sparkle", { x: 50, y: 17 }, { x: 53, y: 18 });
    expect(onSelect).toHaveBeenCalledWith("sparkle");
    expect(onReorder).not.toHaveBeenCalled();
    expect(onTearOff).not.toHaveBeenCalled();
  });

  it("reorders when released inside the strip, and does NOT also select", () => {
    const { onSelect, onReorder, onTearOff } = renderTabs();
    // Past drodio-website's midpoint (171) → past every tab → append at the end.
    drag("sparkle", { x: 50, y: 17 }, { x: 300, y: 17 });
    expect(onReorder).toHaveBeenCalledWith("sparkle", null);
    expect(onTearOff).not.toHaveBeenCalled();
    // The click that follows a real drag is the one that would land the user on a different tab
    // than the one they just moved.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports the tab whose midpoint the pointer has not yet passed", () => {
    const { onReorder } = renderTabs();
    // 120 is past sparkle's midpoint (58) but short of website's (171).
    drag("sparkle", { x: 50, y: 17 }, { x: 120, y: 17 });
    expect(onReorder).toHaveBeenCalledWith("sparkle", "website");
  });

  it("swallows a drag that ends over the dragged tab's own slot", () => {
    const { onReorder, onSelect } = renderTabs();
    // x=40 is still left of sparkle's own midpoint, so the resolver reports beforeId === "sparkle".
    // That is a move to where it already is; the store must never see it.
    drag("sparkle", { x: 20, y: 17 }, { x: 40, y: 17 });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled(); // it was still a drag, so still not a selection
  });

  it("tears off when dragged clear of the strip, in SCREEN coordinates", () => {
    const { onTearOff, onReorder } = renderTabs();
    // Straight down, well past the strip + tear margin. The window position must come from
    // screenX/screenY — client coordinates are relative to this window and would place the new
    // window near the desktop origin no matter which monitor the user dropped it on.
    drag("sparkle", { x: 50, y: 17 }, { x: 50, y: 400 }, { screen: { x: 2400, y: 700 } });
    expect(onTearOff).toHaveBeenCalledWith("sparkle", { x: 2400, y: 700 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("tears off sideways too — past the end of the strip", () => {
    const { onTearOff } = renderTabs();
    drag("sparkle", { x: 50, y: 17 }, { x: 1200, y: 17 }, { screen: { x: 1200, y: 17 } });
    expect(onTearOff).toHaveBeenCalledWith("sparkle", { x: 1200, y: 17 });
  });

  it("commits nothing when the pointer is cancelled mid-drag", () => {
    const { onTearOff, onReorder, onSelect } = renderTabs();
    // A cancelled pointer has no meaningful final position, so committing would spawn a window at
    // wherever the gesture happened to die.
    drag("sparkle", { x: 50, y: 17 }, { x: 50, y: 400 }, { release: "cancel" });
    expect(onTearOff).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the gesture latched once it starts, even back over the press point", () => {
    const { onSelect } = renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 300, clientY: 17 });
    // …and wander back to exactly where the press began. Without the latch the slop gate re-opens,
    // this frame reads as `idle`, the drag visual vanishes and the release becomes a plain click —
    // the instability tabDrag's `dragging` flag exists to prevent. The observable proof is that
    // this is still NOT a selection.
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 50, clientY: 17 });
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 50, clientY: 17 });
    fireEvent.click(tab);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not start a drag from the pin or the close button", () => {
    const { onReorder, onTearOff, onTogglePin } = renderTabs();
    const pin = screen.getByTestId("pin-sparkle");
    fireEvent.pointerDown(pin, { pointerId: 1, button: 0, clientX: 20, clientY: 17 });
    fireEvent.pointerMove(screen.getByTestId("tab-sparkle"), { pointerId: 1, clientX: 20, clientY: 400 });
    fireEvent.pointerUp(screen.getByTestId("tab-sparkle"), { pointerId: 1, clientX: 20, clientY: 400 });
    expect(onTearOff).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
    // …and the control it started on still works.
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledWith("sparkle");
  });

  it("ignores a non-primary button", () => {
    const { onTearOff } = renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 2, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 50, clientY: 400 });
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 50, clientY: 400 });
    expect(onTearOff).not.toHaveBeenCalled();
  });

  it("shows an insertion caret while reordering and clears it on release", () => {
    renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 120, clientY: 17 });
    expect(screen.getAllByTestId("tab-drop-caret")).toHaveLength(1);
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 120, clientY: 17 });
    expect(screen.queryByTestId("tab-drop-caret")).toBeNull();
  });

  it("shows no caret once the drag has left the strip — there is no slot to drop into", () => {
    renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 50, clientY: 400 });
    expect(screen.queryByTestId("tab-drop-caret")).toBeNull();
  });

  it("a CANCELLED drag does not swallow the next click", () => {
    // suppressClick is strip-wide and is only consumed by a click. A cancel produces no click, so
    // latching it there left the flag armed until the next press — and the keyboard-hint overlay
    // fires a tab's onClick with no pointerdown before it, so the first hint activation after a
    // cancelled drag vanished silently.
    const { onSelect } = renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 50, clientY: 400 });
    fireEvent.pointerCancel(tab, { pointerId: 1, clientX: 50, clientY: 400 });
    // The hint overlay's path: a bare click, no pointer sequence.
    fireEvent.click(tab);
    expect(onSelect).toHaveBeenCalledWith("sparkle");
  });

  it("tears the gesture down when the pointer capture is lost", () => {
    // A capture revoked mid-drag (the tab unmounts, the platform takes it) otherwise leaves the
    // gesture ref and the caret set until the next press — a caret painted over nothing.
    renderTabs();
    const tab = screen.getByTestId("tab-sparkle");
    fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: 50, clientY: 17 });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 120, clientY: 17 });
    expect(screen.getAllByTestId("tab-drop-caret")).toHaveLength(1);
    fireEvent.lostPointerCapture(tab, { pointerId: 1 });
    expect(screen.queryByTestId("tab-drop-caret")).toBeNull();
  });

  it("is inert when neither callback is supplied", () => {
    const { onSelect } = renderTabs({ onReorder: undefined, onTearOff: undefined });
    drag("sparkle", { x: 50, y: 17 }, { x: 50, y: 400 });
    // No drag was ever armed, so the release is an ordinary click and still selects.
    expect(onSelect).toHaveBeenCalledWith("sparkle");
  });
});

describe("torn-out tabs", () => {
  it("badges and dims a project that lives in its own window", () => {
    renderTabs({ tornOutProjectIds: new Set(["website"]) });
    expect(screen.getByTestId("torn-out-website")).toBeTruthy();
    expect(screen.queryByTestId("torn-out-sparkle")).toBeNull();
    expect(screen.getByTestId("tab-website").style.opacity).toBe("0.6");
    expect(screen.getByTestId("tab-sparkle").style.opacity).toBe("1");
  });

  it("hides the close button on a torn-out tab — the tab is the only way back to that window", () => {
    // Closing it would hide the tab while the satellite stayed alive owning the project: no
    // "Show that window", no "Bring it back here", and reconcileSatellites would never prune the
    // row because the window really is live.
    renderTabs({ tornOutProjectIds: new Set(["website"]) });
    expect(screen.queryByTestId("close-website")).toBeNull();
    expect(screen.getByTestId("close-sparkle")).toBeTruthy();
  });

  it("still selects a torn-out tab on click — the bar turns that into a window raise", () => {
    // ProjectTabs stays presentational: it reports the click and ProjectTabsBar decides that a
    // torn-out project means "focus its window". Swallowing it here would leave no way back.
    const { onSelect } = renderTabs({ tornOutProjectIds: new Set(["website"]) });
    fireEvent.click(screen.getByTestId("tab-website"));
    expect(onSelect).toHaveBeenCalledWith("website");
  });
});

describe("tabTitle", () => {
  it("advertises the drag, which is otherwise invisible", () => {
    expect(tabTitle("sparkle", { hasSettings: true, tornOut: false, canTearOff: true })).toBe(
      "sparkle — double-click for project settings — drag out for its own window",
    );
  });

  it("says what a torn-out tab does instead, because clicking it means something else", () => {
    expect(tabTitle("sparkle", { hasSettings: true, tornOut: true, canTearOff: true })).toContain(
      "bring that window forward",
    );
  });

  it("omits the drag hint when the bar cannot tear off", () => {
    expect(tabTitle("sparkle", { hasSettings: false, tornOut: false, canTearOff: false })).toBe("sparkle");
  });
});
