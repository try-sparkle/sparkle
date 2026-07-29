// @vitest-environment jsdom
//
// The unified pull tab: ONE tab per boundary carrying both gestures, revealed on hover. jsdom
// paints nothing, so what is pinned here is the contract that regresses silently — the hover
// gating the founder specifically asked for, the two zones being distinct controls, the drag being
// a delta, and the overlaid round trip where the DOTS mean "dock me" rather than "resize me".
//
// The rev-4 re-cut adds three more, each of which had already been asked for once and lost:
//   • the ANATOMY — arrow ABOVE dots, a real gap between them, anchored near the TOP of the seam;
//   • the geometry matching `PRD/sparkle/ui-directions/rev4.html` rather than being re-derived;
//   • TWO instances, on two boundaries, resizing INDEPENDENTLY.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnPullTab, ConciergeDragGrip, PULL_TAB_RAIL_Z } from "./ColumnPullTab";

afterEach(() => cleanup());

const root = () => screen.getByTestId("column-pull-tab");
const zone = () => screen.getByTestId("column-pull-tab-zone");
const tab = () => screen.getByTestId("column-pull-tab-tab");
const dots = () => screen.getByTestId("column-pull-tab-dots");
const chevron = () => screen.getByTestId("column-pull-tab-chevron");

function setup(props: Partial<Parameters<typeof ColumnPullTab>[0]> = {}) {
  const onWidth = vi.fn();
  const onOverlayToggle = vi.fn();
  render(
    <ColumnPullTab
      width={360}
      onWidth={onWidth}
      min={280}
      max={560}
      label="Sparkle column"
      onOverlayToggle={onOverlayToggle}
      {...props}
    />,
  );
  return { onWidth, onOverlayToggle };
}

describe("ColumnPullTab — one tab, two zones", () => {
  it("is hidden at rest and revealed on hover", () => {
    // The founder's note verbatim: "It should also only show on hover. It's showing all the time
    // now." The control it replaces painted two grey marks on the seam permanently.
    setup();
    expect(tab().style.opacity).toBe("0");
    fireEvent.mouseEnter(root());
    expect(tab().style.opacity).toBe("1");
    fireEvent.mouseLeave(root());
    expect(tab().style.opacity).toBe("0");
  });

  it("takes no clicks while hidden OR shown — the ZONE never swallows a press", () => {
    // THIS USED TO ASSERT THE ZONE GOES LIVE ON HOVER, which was the defect rather than the
    // contract (roborev 54730). The zone overhangs ~15px into both columns, over the agent rows;
    // `shown` is entered by crossing the rail, i.e. by the same movement that puts the pointer
    // inside the sidebar, so "live once shown" still ate presses aimed at a row's left edge.
    // Only the visible tab is pointer-active now, and that is asserted separately below.
    render(<ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />);
    const zone = screen.getByTestId("t-zone");
    expect(zone.style.pointerEvents).toBe("none");
    fireEvent.mouseEnter(screen.getByTestId("t"));
    expect(zone.style.pointerEvents).toBe("none");
  });

  it("detects hover on the in-flow RAIL, which overhangs nothing", () => {
    // The corollary of the above: if the zone is inert at rest, something else has to notice the
    // pointer. That is the 6px rail — the real gap between the two columns — and it is why the
    // control can be revealed at all without stealing a single click from either neighbour.
    setup();
    expect(root().style.width).toBe("6px");
    expect(root().style.position).toBe("relative");
    fireEvent.mouseEnter(root());
    expect(tab().style.opacity).toBe("1");
  });

  it("is revealed by KEYBOARD FOCUS too, and rings itself", () => {
    // Hover-only is a mouse rule. Without this, tabbing onto the dots drives a control that paints
    // nothing at all — there is not even anything for a focus ring to sit on.
    setup();
    expect(tab().style.opacity).toBe("0");
    dots().focus();
    fireEvent.focus(dots());
    expect(tab().style.opacity).toBe("1");
    expect(tab().style.outline).toMatch(/2px solid/);
    fireEvent.blur(dots());
    expect(tab().style.opacity).toBe("0");
    expect(tab().style.outline).toBe("none");
  });

  it("stays visible THROUGH a drag, when the pointer has left the tab", () => {
    setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseLeave(root());
    expect(tab().style.opacity).toBe("1");
  });

  it("carries BOTH gestures in one tab — a chevron zone and a six-dot zone", () => {
    setup();
    expect(tab().contains(chevron())).toBe(true);
    expect(tab().contains(dots())).toBe(true);
    // Six dots, two across.
    const field = dots().querySelector("span[aria-hidden]")!;
    expect(field.childElementCount).toBe(6);
    expect((field as HTMLElement).style.gridTemplateColumns).toContain("repeat(2");
  });

  it("does NOT advertise an overlay when the column has none", () => {
    // An affordance that does nothing is worse than an absent one, so the zone is not rendered
    // rather than rendered-and-disabled.
    setup({ onOverlayToggle: undefined });
    expect(screen.queryByTestId("column-pull-tab-chevron")).toBeNull();
    expect(screen.getByTestId("column-pull-tab-dots")).toBeTruthy();
  });
});

// ── ANATOMY ────────────────────────────────────────────────────────────────────────────────────
// "An arrow ABOVE six dots — not beside them", with a real gap, anchored at the TOP of the
// boundary rather than vertically centred. Every number here is `rev4.html`'s, and the mock is what
// the founder signed off AFTER asking for the first build to come down ~20% in size.
describe("ColumnPullTab — the anatomy the founder asked for", () => {
  it("stacks the ARROW ABOVE the DOTS, with a gap between them", () => {
    setup();
    expect(tab().style.flexDirection).toBe("column");
    // DOM order is the visual order in a column flex with no `order` set.
    const kids = [...tab().children];
    expect(kids.indexOf(chevron())).toBeLessThan(kids.indexOf(dots()));
    // 8px — rev4.html's `.tab{gap:8px}`. The first ask said ten; the correction that superseded it
    // asked for the whole tab smaller, and 8 is what the approved page shipped.
    expect(tab().style.gap).toBe("8px");
  });

  it("anchors near the TOP of the seam, below the header band — never vertically centred", () => {
    // It used to sit at the column's very top, straight over the sidebar's `+` and its chips. The
    // clearance is the point: "it's also a little tight with the plus behind it."
    setup();
    expect(zone().style.top).toBe("34px"); // --hd-h
    expect(tab().style.top).toBe("6px");
    // A centred tab is the thing being replaced: no `bottom`, no `alignItems:center` on the rail.
    expect(tab().style.bottom).toBe("");
    expect(root().style.alignItems).toBe("");
  });

  it("lets a headerless boundary opt out of the header clearance", () => {
    setup({ topOffset: 0 });
    expect(zone().style.top).toBe("0px");
  });

  it("draws the dot field to the mock's geometry — 3px squares, 2px apart", () => {
    setup();
    const field = dots().querySelector("span[aria-hidden]") as HTMLElement;
    expect(field.style.gridTemplateColumns).toBe("repeat(2, 3px)");
    expect(field.style.gap).toBe("2px");
    const square = field.firstElementChild as HTMLElement;
    expect(square.style.width).toBe("3px");
    expect(square.style.height).toBe("3px");
    // SQUARE, not round — "a little bit more square than those round dots".
    expect(square.style.borderRadius).toBe("0");
  });

  it("straddles the seam without taking layout space from either column", () => {
    // The rail stays a 6px in-flow band; the 30px hover zone hangs off it absolutely and overhangs
    // 15px into each column. If the zone ever went in-flow the shell would have to make room for
    // it, and both columns would jump.
    setup();
    expect(root().style.position).toBe("relative");
    expect(zone().style.position).toBe("absolute");
    expect(zone().style.width).toBe("30px");
    expect(zone().style.height).toBe("52px");
    expect(zone().style.transform).toBe("translateX(-50%)");
  });
});

describe("ColumnPullTab — the dots resize", () => {
  it("drags as a DELTA from the mousedown point, not a jump to the cursor", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 540, buttons: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(400);
    fireEvent.mouseUp(window);
  });

  it("clamps at both ends", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 9000, buttons: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(560);
    fireEvent.mouseMove(window, { clientX: -9000, buttons: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(280);
    fireEvent.mouseUp(window);
  });

  it("nudges with the arrows, larger with Shift, and is a real separator", () => {
    const { onWidth } = setup();
    expect(dots().getAttribute("role")).toBe("separator");
    expect(dots().getAttribute("aria-valuenow")).toBe("360");
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(368);
    fireEvent.keyDown(dots(), { key: "ArrowRight", shiftKey: true });
    expect(onWidth).toHaveBeenLastCalledWith(392);
  });

  it("runs the gesture BACKWARDS for a column on the right of its seam", () => {
    // The second boundary can own the column on either side. `grows:"right"` means dragging LEFT
    // grows it — get this wrong and one of the two tabs resizes the wrong way round.
    const { onWidth } = setup({ grows: "right" });
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 460, buttons: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(400);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(dots(), { key: "ArrowLeft" });
    expect(onWidth).toHaveBeenLastCalledWith(368);
  });

  it("ignores a non-primary button", () => {
    const { onWidth } = setup();
    fireEvent.mouseDown(dots(), { button: 2, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600, buttons: 1 });
    expect(onWidth).not.toHaveBeenCalled();
  });
});

// ── BOTH BOUNDARIES ────────────────────────────────────────────────────────────────────────────
// "There must be an instance on the left boundary and one on the right, resizable independently."
// The failure mode this guards is a module-level ref or listener shared between instances: a single
// tab can never show it, and the shell only ever mounted one.
describe("ColumnPullTab — two boundaries, two independent tabs", () => {
  function pair() {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    render(
      <>
        <ColumnPullTab
          width={360}
          onWidth={onLeft}
          min={280}
          max={560}
          label="Sparkle column"
          testId="left-tab"
        />
        <ColumnPullTab
          width={240}
          onWidth={onRight}
          min={180}
          max={480}
          label="Build column"
          testId="right-tab"
        />
      </>,
    );
    return { onLeft, onRight };
  }

  it("each owns its own hover state", () => {
    pair();
    fireEvent.mouseEnter(screen.getByTestId("left-tab"));
    expect(screen.getByTestId("left-tab-tab").style.opacity).toBe("1");
    expect(screen.getByTestId("right-tab-tab").style.opacity).toBe("0");
  });

  it("each drags its OWN column, from its own width and against its own clamps", () => {
    const { onLeft, onRight } = pair();

    fireEvent.mouseDown(screen.getByTestId("left-tab-dots"), { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 140, buttons: 1 });
    fireEvent.mouseUp(window);
    expect(onLeft).toHaveBeenLastCalledWith(400); // 360 + 40
    expect(onRight).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId("right-tab-dots"), { button: 0, clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 830, buttons: 1 });
    fireEvent.mouseUp(window);
    expect(onRight).toHaveBeenLastCalledWith(270); // 240 + 30, its own base width
    expect(onLeft).toHaveBeenCalledTimes(1); // and the first tab did not move again

    // Its own clamps, not the other's.
    fireEvent.mouseDown(screen.getByTestId("right-tab-dots"), { button: 0, clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 9000, buttons: 1 });
    expect(onRight).toHaveBeenLastCalledWith(480);
    fireEvent.mouseUp(window);
  });

  it("keeps their accessible names apart", () => {
    pair();
    expect(screen.getByTestId("left-tab-dots").getAttribute("aria-label")).toBe(
      "Resize the Sparkle column",
    );
    expect(screen.getByTestId("right-tab-dots").getAttribute("aria-label")).toBe(
      "Resize the Build column",
    );
  });
});

describe("ColumnPullTab — the chevron overlays, and the dots snap back", () => {
  it("the chevron toggles the overlay and reports its state", () => {
    const { onOverlayToggle } = setup();
    expect(chevron().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chevron());
    expect(onOverlayToggle).toHaveBeenCalledTimes(1);
  });

  it("WHILE OVERLAID the dots dock instead of resizing — the founder's round trip", () => {
    // "once it's overlaid, if I were to click on the six dots, then it would snap back to not be
    // an overlay anymore. And then I could modify the column width."
    const { onWidth, onOverlayToggle } = setup({ overlaid: true });
    fireEvent.click(dots());
    expect(onOverlayToggle).toHaveBeenCalledTimes(1);
    // …and it must not try to move a boundary that is not on screen.
    fireEvent.mouseDown(dots(), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600, buttons: 1 });
    expect(onWidth).not.toHaveBeenCalled();
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("re-labels both zones for the overlaid state", () => {
    setup({ overlaid: true });
    expect(chevron().getAttribute("aria-pressed")).toBe("true");
    expect(chevron().getAttribute("aria-label")).toMatch(/dock/i);
    expect(dots().getAttribute("aria-label")).toMatch(/dock/i);
    // No longer a separator: there is no boundary to represent while floating.
    expect(dots().getAttribute("role")).toBe("button");
    expect(dots().getAttribute("aria-valuenow")).toBeNull();
  });
});

// ── THE GRIP ───────────────────────────────────────────────────────────────────────────────────
// A DIFFERENT control from the pull tab: 8 dots in 4 columns, lives in the concierge header, and
// moves the whole column between sides. `MAPPING.md` puts it in `.ahd`; `ConciergeColumn` mounts it.
describe("ConciergeDragGrip — 4×2, drags the concierge between sides", () => {
  const grip = () => screen.getByTestId("concierge-drag-grip");

  function setupGrip(side: "left" | "right" = "left") {
    const onSideChange = vi.fn();
    render(<ConciergeDragGrip side={side} onSideChange={onSideChange} />);
    return { onSideChange };
  }

  it("is EIGHT dots, FOUR across — visibly not the pull tab's six-in-two", () => {
    setupGrip();
    const field = grip().querySelector("span[aria-hidden]") as HTMLElement;
    expect(field.childElementCount).toBe(8);
    expect(field.style.gridTemplateColumns).toBe("repeat(4, 3px)");
  });

  it("is NOT hover-gated — it lives in a header, not on a seam", () => {
    setupGrip();
    expect(grip().style.opacity).toBe("");
    expect(grip().style.pointerEvents).toBe("");
  });

  it("commits the far side once the drag clears the throw distance", () => {
    const { onSideChange } = setupGrip("left");
    fireEvent.mouseDown(grip(), { button: 0, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 160 });
    expect(onSideChange).toHaveBeenCalledWith("right");
  });

  it("ignores a twitch — teleporting the whole column on a 3px slip is not recoverable", () => {
    const { onSideChange } = setupGrip("left");
    fireEvent.mouseDown(grip(), { button: 0, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 103 });
    expect(onSideChange).not.toHaveBeenCalled();
  });

  it("does not re-commit the side it is already on", () => {
    const { onSideChange } = setupGrip("right");
    fireEvent.mouseDown(grip(), { button: 0, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 300 });
    expect(onSideChange).not.toHaveBeenCalled();
  });

  it("has a keyboard path, and it is ABSOLUTE rather than a toggle", () => {
    // ← means "put it on the left". A relative toggle would be ambiguous once the control has
    // travelled with the column it moves.
    const { onSideChange } = setupGrip("left");
    expect(grip().getAttribute("tabindex")).toBe("0");
    expect(grip().getAttribute("aria-label")).toMatch(/other side/i);
    fireEvent.keyDown(grip(), { key: "ArrowLeft" });
    expect(onSideChange).not.toHaveBeenCalled(); // already there
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    expect(onSideChange).toHaveBeenCalledWith("right");
  });

  it("ignores a non-primary button", () => {
    const { onSideChange } = setupGrip("left");
    fireEvent.mouseDown(grip(), { button: 2, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 400 });
    expect(onSideChange).not.toHaveBeenCalled();
  });

  it("abandons a drag whose release went missing, instead of arming the next click", () => {
    // roborev 54691 (Medium): "throw it to the other side" invites releasing OUTSIDE the window,
    // and no mouseup arrives for that. The drag then stayed live with a stale origin, so the next
    // ordinary click anywhere in the app read as its end — and, being almost certainly ≥24px from
    // that origin, teleported the whole column.
    const { onSideChange } = setupGrip("left");
    fireEvent.mouseDown(grip(), { button: 0, clientX: 100 });
    // The pointer comes back over the window with nothing held: the release already happened.
    fireEvent.mouseMove(window, { clientX: 400, buttons: 0 });
    expect(onSideChange).not.toHaveBeenCalled();
    // …and an unrelated click later must not be mistaken for the end of that drag.
    fireEvent.mouseUp(window, { clientX: 900 });
    expect(onSideChange).not.toHaveBeenCalled();
  });

  it("keeps a live drag alive while the button IS still held", () => {
    // The cancel above must key on the button state, not merely on movement — otherwise the first
    // pixel of every legitimate drag kills it.
    const { onSideChange } = setupGrip("left");
    fireEvent.mouseDown(grip(), { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 160 });
    expect(onSideChange).toHaveBeenCalledWith("right");
  });
});

describe("the seam never swallows a click meant for a column — roborev 54691 / 54730", () => {
  it("only the VISIBLE tab takes pointer events", () => {
    render(<ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />);
    const tab = screen.getByTestId("t-tab");
    expect(tab.style.pointerEvents).toBe("none");
    fireEvent.mouseEnter(screen.getByTestId("t"));
    expect(tab.style.pointerEvents).toBe("auto");
  });

  it("abandons a drag whose release went missing", () => {
    // If the mouseup is lost, `dragging` stays true and the column follows the bare cursor across
    // the screen until the next click commits a width. `buttons === 0` ends it.
    const onWidth = vi.fn();
    render(<ColumnPullTab width={360} onWidth={onWidth} min={240} max={640} label="Build column" testId="t" />);
    fireEvent.mouseEnter(screen.getByTestId("t"));
    fireEvent.mouseDown(screen.getByTestId("t-tab"), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 900, buttons: 0 });
    onWidth.mockClear();
    fireEvent.mouseMove(window, { clientX: 200, buttons: 0 });
    expect(onWidth).not.toHaveBeenCalled();
  });
});

describe("the reveal cannot be killed from inside the seam — roborev 54850", () => {
  it("sliding off the tab but staying on the rail keeps the tab shown", () => {
    // The tab is a DOM DESCENDANT of the rail (rail > zone > tab), so React dispatches
    // enter/leave along the DOM path to the common ancestor, not by visual geometry. A leave
    // handler ON THE TAB therefore fires with no matching enter when you move tab → rail, which
    // cleared `hovered` while the pointer was still on the rail. The tab vanished and could not
    // come back: hidden it is `pointerEvents:"none"`, and the pointer had never left the rail, so
    // nothing would fire again until the user exited the seam entirely.
    render(
      <ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />,
    );
    const rail = screen.getByTestId("t");
    fireEvent.mouseEnter(rail);
    expect(rail.getAttribute("data-shown")).toBe("true");

    // Slide off the tab's bottom edge onto the rail. A browser sends `mouseout` on the TAB with
    // `relatedTarget` = the rail; React reads that pair, computes the common ancestor (the rail),
    // and dispatches leave on tab/zone only. Modelled with `mouseOut` + relatedTarget rather than
    // `fireEvent.mouseLeave`, which supplies no relatedTarget — React then treats it as a leave of
    // everything and the rail's own handler fires, which is not a motion a pointer can make.
    fireEvent.mouseOut(screen.getByTestId("t-tab"), { relatedTarget: rail });
    expect(rail.getAttribute("data-shown")).toBe("true");
  });

  it("leaving the rail itself still hides it", () => {
    render(
      <ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />,
    );
    const rail = screen.getByTestId("t");
    fireEvent.mouseEnter(rail);
    expect(rail.getAttribute("data-shown")).toBe("true");
    // Leaving the seam entirely: relatedTarget is outside the rail.
    fireEvent.mouseOut(rail, { relatedTarget: document.body });
    expect(rail.getAttribute("data-shown")).toBe("false");
  });
});

describe("the rail renders the constant the concierge is pinned against — roborev 55039", () => {
  it("the rail element's z-index IS PULL_TAB_RAIL_Z, not merely equal to it in the abstract", () => {
    // The pairing guard in ConciergeColumn.wired.test.tsx compares CONCIERGE_LIFT_Z against
    // PULL_TAB_RAIL_Z as a NUMBER, and pins only the concierge's rendered value. That leaves the
    // other half unanchored: re-hardcoding `zIndex: 4` on the rail and bumping the constant keeps
    // the whole suite green while the lift paints over the tab's overhang and eats its hit area —
    // roborev 54841, which is itself a re-run of 54712. Anchoring the rail to rendered output is
    // what makes the pair a real contract rather than two numbers that agree.
    render(
      <ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />,
    );
    expect(Number(screen.getByTestId("t").style.zIndex)).toBe(PULL_TAB_RAIL_Z);
  });
});
