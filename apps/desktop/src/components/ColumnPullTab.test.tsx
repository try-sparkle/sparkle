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

// ── DRIVING A DRAG, NOW THAT IT IS A POINTER GESTURE THAT COMMITS ONCE ─────────────────────────
//
// Two things changed and both show up in every case below.
//
//  • POINTER events, not mouse. The seam takes `setPointerCapture` so a release outside the window
//    is still delivered — a column drag reaches the window edge constantly, and a lost release used
//    to leave the column following the bare cursor.
//  • The width is committed ONCE, on release. Moves paint a CSS variable instead of calling
//    `onWidth`, because calling it per move re-rendered the whole shell at pointer rate (30
//    `Workspace` renders and 1,668ms of jank in a measured drag). So a case that wants to know what
//    the user SEES mid-drag reads the variable, and one that wants to know what was COMMITTED reads
//    `onWidth` after the release.
const VAR = "--test-col-w";
const painted = () => document.documentElement.style.getPropertyValue(VAR);

function press(el: Element, clientX: number, opts: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, buttons: 1, clientX, ...opts });
}
function moveTo(clientX: number, opts: Record<string, unknown> = {}) {
  fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX, ...opts });
}
function release() {
  fireEvent.pointerUp(window, { pointerId: 1 });
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  // The shield is appended to `document.body` directly, so RTL's `cleanup` does not reach it. A case
  // that leaves one behind must not hand the strand to the NEXT case — every assertion about the
  // shield is made inside its own case, so clearing here isolates them without masking anything.
  document.querySelectorAll('[data-testid="column-drag-shield"]').forEach((n) => n.remove());
});

// ── THE WHOLE SEAM IS THE HANDLE ───────────────────────────────────────────────────────────────
//
// The founder: "I also want to be able to drag anywhere up and down the column, even though the pull
// tab shows at the top. I don't want to be limited to dragging at the top." The tab is a 52px-tall
// affordance near the top of a full-height boundary, so before this the other ~95% of the seam took
// no press at all.
describe("ColumnPullTab — the seam is draggable along its whole height", () => {
  it("starts a drag from the RAIL, not only from the tab's dots", () => {
    // THE ASSERTION IS THE COMMITTED WIDTH, not that a handler exists: a rail wired to a no-op would
    // satisfy "it has an onPointerDown" and still be undraggable. Pressing the rail directly is the
    // whole point — no hover first, because the tab is not involved.
    const { onWidth } = setup({ cssVar: VAR });
    press(root(), 500);
    moveTo(560);
    release();
    expect(onWidth).toHaveBeenCalledWith(420);
  });

  it("paints the preview during a rail drag, so the seam tracks the pointer", () => {
    setup({ cssVar: VAR });
    press(root(), 500);
    moveTo(540);
    expect(painted()).toBe("400px");
    release();
  });

  it("advertises the resize cursor across the whole rail, not just under the tab", () => {
    // Without this the reach exists but is invisible: a 6px column with a default cursor reads as
    // decoration, and the founder would have no way to discover the thing he asked for.
    setup({ cssVar: VAR });
    expect(root().style.cursor).toBe("col-resize");
  });

  it("does NOT start a drag from the rail while the column is OVERLAID", () => {
    // Overlaid there is no boundary to drag — the column floats over its neighbour and its width
    // comes from the viewport, so a drag would move an edge the user cannot see. The dots already
    // refuse in that state; the rail has to refuse on the same terms or it reopens the hole.
    const { onWidth } = setup({ cssVar: VAR, overlaid: true });
    press(root(), 500);
    moveTo(560);
    release();
    expect(onWidth).not.toHaveBeenCalled();
    expect(root().style.cursor).not.toBe("col-resize");
  });

  it("commits ONCE when the press lands on the dots, which bubble to the rail", () => {
    // Both the dots and the rail start a drag and the dots are a DESCENDANT, so one press fires the
    // handler twice. The second call must not re-latch the origin — if it did, the gesture would
    // start from a width the first call had already begun moving away from and the seam would jump.
    const { onWidth } = setup({ cssVar: VAR });
    fireEvent.mouseEnter(root());
    press(dots(), 500);
    moveTo(560);
    release();
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(420);
  });

  it("lets the CHEVRON still toggle the overlay instead of grabbing the seam", () => {
    // The chevron sits inside the rail, so without stopping propagation the press that means
    // "overlay me" would also start a drag — raising the full-window shield, which then eats the
    // click that was the entire point of pressing it.
    const { onOverlayToggle, onWidth } = setup({ cssVar: VAR });
    fireEvent.mouseEnter(root());
    fireEvent.pointerDown(chevron(), { pointerId: 1, button: 0, buttons: 1, clientX: 500 });
    fireEvent.click(chevron());
    expect(onOverlayToggle).toHaveBeenCalledTimes(1);
    expect(onWidth).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="column-drag-shield"]')).toBeNull();
  });
});

describe("ColumnPullTab — one tab, two zones", () => {
  it("PAINTS AT REST, quietly, and strengthens on hover", () => {
    // THE FOUNDER REVERSED THE HOVER-ONLY RULE, 2026-08-08: "I don't see the vertical slider so yes,
    // make it always show." This case used to assert the opposite (`opacity` 0 at rest), which is
    // why it is rewritten rather than added to — a suite cannot hold both rules.
    //
    // The assertion is the PROPERTY, not the number, because the number is a knob he will want
    // turned: strictly visible (≠ 0, which is the old behaviour and the bug) and strictly quieter
    // than the hovered state (≠ 1, which is the permanent-chrome weight he called janky). Pinning
    // 0.6 would make every tuning request a test edit; pinning the property fails against both of
    // the states he has actually rejected.
    setup();
    const rest = Number(tab().style.opacity);
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThan(1);
    fireEvent.mouseEnter(root());
    expect(tab().style.opacity).toBe("1");
    fireEvent.mouseLeave(root());
    expect(Number(tab().style.opacity)).toBe(rest);
  });

  it("is REACHABLE at rest — the pointer must not fall through the visible tab", () => {
    // The half of the invisibility that was not about paint. While the tab was `pointerEvents:none`
    // it was not hit-test eligible, so moving onto it from a column fired no enter on the rail: the
    // ONLY way to summon the control was to land inside the literal 6px rail, a target you have to
    // already know is there. Painting it without this would give him something he can see and still
    // cannot press.
    setup();
    expect(tab().style.pointerEvents).toBe("auto");
    fireEvent.mouseEnter(root());
    expect(tab().style.pointerEvents).toBe("auto");
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
    // The corollary of the zone case above: the zone is inert forever, so something else has to
    // notice the pointer. That is the 6px rail — the real gap between the two columns — and it is
    // why the tab can be emphasised without stealing a single click from either neighbour.
    setup();
    expect(root().style.width).toBe("6px");
    expect(root().style.position).toBe("relative");
    fireEvent.mouseEnter(root());
    expect(tab().style.opacity).toBe("1");
  });

  it("is EMPHASISED by keyboard focus too, and rings itself", () => {
    // Hover is a mouse rule, so the keyboard gets the same strengthening — and the ring has a
    // full-strength object to sit on rather than a faint one.
    setup();
    const rest = tab().style.opacity;
    dots().focus();
    fireEvent.focus(dots());
    expect(tab().style.opacity).toBe("1");
    expect(tab().style.outline).toMatch(/2px solid/);
    fireEvent.blur(dots());
    expect(tab().style.opacity).toBe(rest);
    expect(tab().style.outline).toBe("none");
  });

  it("stays visible THROUGH a drag, when the pointer has left the tab", () => {
    setup();
    press(dots(), 500);
    fireEvent.mouseLeave(root());
    expect(tab().style.opacity).toBe("1");
    release();
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
  it("drags as a DELTA from the press point, not a jump to the cursor", () => {
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    // What the user SEES: the column is already 40px wider, painted with no React work.
    expect(painted()).toBe("400px");
    release();
    // What was COMMITTED: exactly one call, with the width the drag settled on.
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(400);
  });

  it("does NOT touch React state per move — one commit per gesture, however far it travels", () => {
    // The regression this exists to catch is the one that was measured: `onWidth` on every pointer
    // event re-rendered the shell at pointer rate. Ten moves must still be one commit.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    for (let x = 505; x <= 550; x += 5) moveTo(x);
    expect(onWidth).not.toHaveBeenCalled();
    expect(painted()).toBe("410px");
    release();
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(410);
  });

  it("commits NOTHING when the gesture never moved — a press on the dots is a click", () => {
    // Committing here would mark the width dirty and persist a value the user never chose.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    release();
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("clamps at both ends, live, and commits the clamped width", () => {
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(9000);
    expect(painted()).toBe("560px");
    moveTo(-9000);
    expect(painted()).toBe("280px");
    release();
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(280);
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
    const { onWidth } = setup({ grows: "right", cssVar: VAR });
    press(dots(), 500);
    moveTo(460);
    expect(painted()).toBe("400px");
    release();
    expect(onWidth).toHaveBeenLastCalledWith(400);
    fireEvent.keyDown(dots(), { key: "ArrowLeft" });
    expect(onWidth).toHaveBeenLastCalledWith(368);
  });

  it("ignores a non-primary button", () => {
    const { onWidth } = setup();
    press(dots(), 500, { button: 2 });
    moveTo(600);
    release();
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
    // Both are painted now, so the discriminator is the EMPHASIS: hovering one takes that one to
    // full and leaves its sibling at the resting weight. The failure this guards (one module-level
    // ref, one shared listener) would light both.
    pair();
    fireEvent.mouseEnter(screen.getByTestId("left-tab"));
    expect(screen.getByTestId("left-tab-tab").style.opacity).toBe("1");
    expect(Number(screen.getByTestId("right-tab-tab").style.opacity)).toBeLessThan(1);
  });

  it("each drags its OWN column, from its own width and against its own clamps", () => {
    const { onLeft, onRight } = pair();

    press(screen.getByTestId("left-tab-dots"), 100);
    moveTo(140);
    release();
    expect(onLeft).toHaveBeenLastCalledWith(400); // 360 + 40
    expect(onRight).not.toHaveBeenCalled();

    press(screen.getByTestId("right-tab-dots"), 800);
    moveTo(830);
    release();
    expect(onRight).toHaveBeenLastCalledWith(270); // 240 + 30, its own base width
    expect(onLeft).toHaveBeenCalledTimes(1); // and the first tab did not move again

    // Its own clamps, not the other's.
    press(screen.getByTestId("right-tab-dots"), 800);
    moveTo(9000);
    release();
    expect(onRight).toHaveBeenLastCalledWith(480);
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
    press(dots(), 500);
    moveTo(600);
    release();
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
  it("the ZONE never takes pointer events, painted tab or not", () => {
    // THE RULE THIS DESCRIBES SURVIVED THE 2026-08-08 REVERSAL; only its subject moved. The hazard
    // was never the tab — it is the 30×52 ZONE, which overhangs ~15px into both columns straight
    // over the agent rows, and it is inert unconditionally. The tab is a ~24×43 object centred on
    // the rail that the user can now always see under the cursor, which is what earns it the right
    // to take a press (that half is asserted in "is REACHABLE at rest" above).
    render(<ColumnPullTab width={360} onWidth={() => {}} min={240} max={640} label="Build column" testId="t" />);
    const zone = screen.getByTestId("t-zone");
    expect(zone.style.pointerEvents).toBe("none");
    fireEvent.mouseEnter(screen.getByTestId("t"));
    expect(zone.style.pointerEvents).toBe("none");
  });

  it("abandons a drag whose release went missing, keeping the width the user last saw", () => {
    // If the release is lost — the pointer leaves the window, a native drag steals it, the button
    // goes up over a surface that swallows the event — the column must not follow the bare cursor
    // across the screen. `buttons === 0` is how we find out it is over.
    //
    // THIS CASE PRESSED THE WRONG ELEMENT and so proved nothing for as long as it has existed: it
    // dispatched on `t-tab`, the wrapper, while the handler is on `t-dots`, a CHILD — which does not
    // bubble upward. It never started a drag, so "no further commits" was true before the guard
    // existed. It presses the dots now, and asserts the settled width rather than only an absence.
    const onWidth = vi.fn();
    render(
      <ColumnPullTab width={360} onWidth={onWidth} min={240} max={640} label="Build column" testId="t" cssVar={VAR} />,
    );
    press(screen.getByTestId("t-dots"), 500);
    moveTo(600);
    expect(painted()).toBe("460px"); // the drag IS live — the precondition the old case lacked
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900, buttons: 0 });
    // It settles on what was on screen, rather than discarding the drag or taking the stray point.
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(460);

    onWidth.mockClear();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, buttons: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 250, buttons: 1 });
    expect(onWidth).not.toHaveBeenCalled();
    expect(painted()).toBe("460px"); // and nothing repainted it
  });
});

describe("the reveal cannot be killed from inside the seam — roborev 54850", () => {
  it("sliding off the tab but staying on the rail keeps the tab shown", () => {
    // The tab is a DOM DESCENDANT of the rail (rail > zone > tab), so React dispatches
    // enter/leave along the DOM path to the common ancestor, not by visual geometry. A leave
    // handler ON THE TAB therefore fires with no matching enter when you move tab → rail, which
    // cleared `hovered` while the pointer was still on the rail. Under the hover-only rule the tab
    // then vanished and could not come back — hidden it was `pointerEvents:"none"`, and the pointer
    // had never left the rail, so nothing would fire again until the user exited the seam entirely.
    // The tab is painted and pressable at rest now, so the dead-reveal consequence is gone; the
    // hover bookkeeping this pins is not, and a leave with no enter still strands the emphasis.
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

// ── SYMMETRIC GROWTH — THE CONCIERGE'S TWO EDGES ───────────────────────────────────────────────
//
// "I basically want to be able to drag out from the middle… make it so that the concierge both
// sides grow when you pull one side."
//
// This KNOWINGLY REVERSES a fix. Symmetric growth was removed once as a bug — "the column grew
// about its centre and its left edge slid left every time the user dragged its right edge" — and the
// founder, shown that exact sentence, chose symmetric anyway, because the column is now the row's
// anchor. So the old defect is the specified behaviour, and these are the cases that pin it.
describe("widthPerPx — one pixel of travel, two pixels of column", () => {
  it("grows the column by 2·dx when the seam is symmetric", () => {
    const onWidth = vi.fn();
    render(
      <ColumnPullTab width={360} onWidth={onWidth} min={280} max={2000} label="Sparkle column" widthPerPx={2} cssVar={VAR} />,
    );
    press(dots(), 500);
    moveTo(540); // the EDGE moved 40px…
    expect(painted()).toBe("440px"); // …and the column gained 80.
    release();
    expect(onWidth).toHaveBeenCalledWith(440);
  });

  it("does it from EITHER edge — the mirrored seam grows the same column the same way", () => {
    // The left seam of the concierge owns the concierge, not the column beside it, and pulling it
    // LEFT (outward) must grow the concierge by the same 2·dx the right seam gives.
    const onWidth = vi.fn();
    render(
      <ColumnPullTab width={360} onWidth={onWidth} min={280} max={2000} label="Sparkle column" grows="right" widthPerPx={2} cssVar={VAR} />,
    );
    press(dots(), 500);
    moveTo(460); // outward is LEFT for this seam
    expect(painted()).toBe("440px");
    release();
    expect(onWidth).toHaveBeenCalledWith(440);
  });

  it("keeps an ordinary seam at 1:1, so the build columns are unaffected", () => {
    // The default must not change: a builder's edge moves its column by exactly the travel.
    const onWidth = vi.fn();
    render(<ColumnPullTab width={360} onWidth={onWidth} min={280} max={2000} label="agent column" cssVar={VAR} />);
    press(dots(), 500);
    moveTo(540);
    expect(painted()).toBe("400px");
    release();
    expect(onWidth).toHaveBeenCalledWith(400);
  });

  it("applies the same factor to the ARROW KEYS, so the two input paths agree", () => {
    // Otherwise a keyboard user finds the concierge growing at half the rate the mouse moves it.
    const onWidth = vi.fn();
    render(
      <ColumnPullTab width={360} onWidth={onWidth} min={280} max={2000} label="Sparkle column" widthPerPx={2} />,
    );
    fireEvent.keyDown(dots(), { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(376); // 360 + 8·2
    fireEvent.keyDown(dots(), { key: "ArrowRight", shiftKey: true });
    expect(onWidth).toHaveBeenLastCalledWith(424); // 360 + 32·2
  });
});

// ── THE DRAG SHIELD ────────────────────────────────────────────────────────────────────────────
//
// A spindump of a real drag put 537 of 1,299 blocking WindowServer samples in WebKit recomputing
// the cursor — every mouse-move hit-tests the element under the pointer and walks a deep tree of
// columns, panes and xterm canvases to ask what cursor it wants. One fixed sheet with a constant
// cursor makes that answer constant.
describe("the drag shield", () => {
  const shield = () => document.querySelector('[data-testid="column-drag-shield"]');

  it("is absent at rest, raised for the gesture, and gone on release", () => {
    setup({ cssVar: VAR });
    expect(shield()).toBeNull();
    press(dots(), 500);
    expect(shield()).not.toBeNull();
    release();
    expect(shield()).toBeNull();
  });

  it("covers the whole window with ONE constant cursor", () => {
    setup({ cssVar: VAR });
    press(dots(), 500);
    const el = shield() as HTMLElement;
    expect(el.style.position).toBe("fixed");
    expect(el.style.cursor).toBe("col-resize");
    expect(el.style.inset).toBe("0");
    release();
  });

  it("comes down when the release goes MISSING too, so it cannot be left covering the app", () => {
    // A shield tied to a flag rather than to the effect's lifetime is how an invisible sheet ends up
    // permanently over the UI, swallowing every click with no way to tell why.
    setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900, buttons: 0 });
    expect(shield()).toBeNull();
  });

  it("comes down on a CANCELLED pointer", () => {
    setup({ cssVar: VAR });
    press(dots(), 500);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(shield()).toBeNull();
  });
});

// ── THE STRANDED SHIELD — bead sparkle-thm9o ───────────────────────────────────────────────────
//
// The app-wide input freeze the founder had to force-restart Sparkle over. Every exit from
// `dragging === true` used to require the app to OBSERVE the pointer: a `pointerup`, a
// `pointercancel`, or a `pointermove` carrying `buttons === 0`. All three are events about a pointer
// the app can still see. When it cannot — the release happens over another application, the window
// loses focus mid-gesture, the OS takes the pointer — none of them ever arrive, `dragging` stays
// true, and a transparent full-viewport sheet at z-index 2147483647 sits over the whole app with no
// click handler and no dismiss path. The app paints perfectly and every click lands on the sheet: no
// text box can be focused, and the concierge's own unmount control cannot be hit. Only a restart
// cleared it.
//
// The corroborating line from the founder's session log is
// `focus-trace: keydown reached NON-editable target=body … defaultPrevented=false activeElement=body`
// — focus stranded on `body` with keys NOT prevented, which is a pointer-blocking overlay rather
// than a stuck key handler.
//
// jsdom has no layout and `setPointerCapture` silently does nothing here (the component says so), so
// every case below asserts the shield node's PRESENCE/ABSENCE and the committed width — never
// geometry, and never that the sheet "blocks" anything, which jsdom cannot answer.
describe("a gesture the app can no longer observe — the stranded drag shield", () => {
  const shield = () => document.querySelector('[data-testid="column-drag-shield"]');

  it("ends the gesture on window BLUR, with no pointerup ever arriving", () => {
    // THE HEADLINE CASE. Before the fix this leaves the shield up forever: there is no `blur`, no
    // `visibilitychange`, no `lostpointercapture` and no timeout in the drag effect's teardown set.
    setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    expect(shield()).not.toBeNull();
    fireEvent.blur(window);
    expect(shield()).toBeNull();
  });

  it("COMMITS the width the user last saw when the gesture is lost, rather than abandoning it", () => {
    // A DELIBERATE CHOICE, and the same one `release-lost` already makes — see `endDrag`'s comment.
    // The preview has already painted that width onto the CSS variable, so abandoning would leave
    // the column PAINTED at one width and STORED at another: the stored-vs-painted split, which the
    // next mousedown resolves by jumping the seam back. Committing keeps the two in step.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    expect(painted()).toBe("400px");
    fireEvent.blur(window);
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(400);
    // …and the gesture is genuinely over: later moves must not keep dragging a column nobody is
    // holding. This is the half that `dragging === false` alone would not prove.
    onWidth.mockClear();
    moveTo(900);
    expect(painted()).toBe("400px");
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("commits NOTHING on blur when the gesture never moved — a lost click is still a click", () => {
    // The `endDrag` "only if it moved" rule has to survive the new exits too, or cmd-tabbing away
    // with the seam merely pressed would mark the width dirty and persist a value nobody chose.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    fireEvent.blur(window);
    expect(onWidth).not.toHaveBeenCalled();
    expect(shield()).toBeNull();
  });

  it("ends the gesture when the document is HIDDEN mid-drag", () => {
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    spy.mockRestore();
    expect(shield()).toBeNull();
    expect(onWidth).toHaveBeenCalledWith(400);
  });

  it("does NOT end the gesture on a visibilitychange back to VISIBLE", () => {
    // The event fires in both directions. Ending on either would kill a live drag the moment the
    // user alt-tabs BACK to the app, which is the opposite of the fix.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    fireEvent(document, new Event("visibilitychange")); // jsdom's default state is "visible"
    expect(shield()).not.toBeNull();
    expect(onWidth).not.toHaveBeenCalled();
    release();
  });

  it("ends the gesture when the OS takes the pointer away — lostpointercapture", () => {
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    fireEvent(window, new Event("lostpointercapture"));
    expect(shield()).toBeNull();
    expect(onWidth).toHaveBeenCalledWith(400);
  });

  it("is not confused by an ELEMENT losing focus — only the WINDOW's blur ends a drag", () => {
    // A native element `blur` does not bubble, so a window-level listener registered in the BUBBLE
    // phase must not hear it. Registering it in the capture phase instead would kill every drag the
    // instant focus moved anywhere inside the app — including the focus change the press itself can
    // cause. This is the case that keeps the fix from being worse than the bug.
    const { onWidth } = setup({ cssVar: VAR });
    dots().focus();
    press(dots(), 500);
    moveTo(540);
    fireEvent.blur(dots());
    expect(shield()).not.toBeNull();
    expect(onWidth).not.toHaveBeenCalled();
    release();
    expect(onWidth).toHaveBeenCalledWith(400);
  });

  it("a blur with NO gesture in flight commits nothing and touches nothing", () => {
    const { onWidth } = setup({ cssVar: VAR });
    fireEvent.blur(window);
    fireEvent(window, new Event("lostpointercapture"));
    expect(onWidth).not.toHaveBeenCalled();
    expect(shield()).toBeNull();
  });

  // ── BELT AND BRACES ──────────────────────────────────────────────────────────────────────────
  // The cases above all still route through the `dragging` flag. These two are the defences that
  // do NOT: a transparent sheet at the maximum z-index must not be able to outlive its gesture even
  // if the flag is wrong, because "the flag was wrong" is exactly what the freeze was.
  it("DISMISSES ITSELF on a press it receives — a shield taking a fresh pointerdown is stranded", () => {
    // During a live gesture the button is already down and the pointer is captured, so the next
    // event is a move or an up. A fresh press landing ON the sheet therefore means the app is no
    // longer tracking the gesture the sheet belongs to.
    const { onWidth } = setup({ cssVar: VAR });
    press(dots(), 500);
    moveTo(540);
    const el = shield() as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 2, button: 0, buttons: 1, clientX: 700 });
    expect(shield()).toBeNull();
    // And the gesture behind it is ended too, not merely uncovered — otherwise the flag stays true
    // and the next render could raise a second sheet.
    expect(onWidth).toHaveBeenCalledWith(400);
    onWidth.mockClear();
    moveTo(900);
    expect(onWidth).not.toHaveBeenCalled();
  });

  it("dismisses itself on a plain MOUSEDOWN too, for pointer-eventless paths", () => {
    setup({ cssVar: VAR });
    press(dots(), 500);
    fireEvent.mouseDown(shield() as HTMLElement, { button: 0, clientX: 700 });
    expect(shield()).toBeNull();
  });

  it("SWEEPS any orphan shield when a new gesture starts — there is never more than one", () => {
    // The last line of defence: a sheet left behind by an instance that went away without its
    // cleanup running (a crashed render, a hot reload, the freeze itself) is cleared by the next
    // drag anyone starts, anywhere in the app.
    const orphan = document.createElement("div");
    orphan.setAttribute("data-testid", "column-drag-shield");
    document.body.appendChild(orphan);
    setup({ cssVar: VAR });
    press(dots(), 500);
    expect(document.querySelectorAll('[data-testid="column-drag-shield"]').length).toBe(1);
    expect(orphan.isConnected).toBe(false);
    release();
    expect(shield()).toBeNull();
  });

  // ── ALL THREE MOUNT SITES ────────────────────────────────────────────────────────────────────
  // The shell mounts this component three times (the concierge seam, and both of the sidebar's
  // pair boundaries). The fix lives in the component, so it holds for every instance — but the
  // failure mode it replaces was ONE stranded sheet covering the whole app regardless of which
  // seam raised it, so the guarantee worth pinning is a fleet-wide one, not a per-instance one.
  it("leaves NO shield anywhere when any one of three mounted tabs loses its gesture", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const onC = vi.fn();
    render(
      <>
        <ColumnPullTab width={360} onWidth={onA} min={280} max={560} label="Sparkle column" testId="a" />
        <ColumnPullTab width={240} onWidth={onB} min={180} max={480} label="Build column" testId="b" />
        <ColumnPullTab width={300} onWidth={onC} min={180} max={480} label="agent column" testId="c" grows="right" />
      </>,
    );
    press(screen.getByTestId("b-dots"), 500);
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 530 });
    expect(document.querySelectorAll('[data-testid="column-drag-shield"]').length).toBe(1);
    fireEvent.blur(window);
    expect(document.querySelectorAll('[data-testid="column-drag-shield"]').length).toBe(0);
    // Only the seam that was actually grabbed committed anything.
    expect(onB).toHaveBeenCalledWith(270);
    expect(onA).not.toHaveBeenCalled();
    expect(onC).not.toHaveBeenCalled();
  });
});

// ── THE LISTENERS ARE INSTALLED ONCE PER GESTURE ───────────────────────────────────────────────
//
// They used to be keyed on `[dragging, commit, grows, endDrag]`, and `commit` is rebuilt whenever
// `onWidth`, `min`, `max` or `label` changes — which for the concierge seam is every time the shell
// re-renders, i.e. on every projectStore write. So a live drag's own listeners were torn down and
// re-added mid-gesture, repeatedly, on the hot path.
describe("a live drag survives the shell re-rendering under it", () => {
  it("does not re-install its window listeners when its props get new identities", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = render(
      <ColumnPullTab width={360} onWidth={() => {}} min={280} max={560} label="Sparkle column" cssVar={VAR} />,
    );
    press(dots(), 500);
    const installed = add.mock.calls.filter(([t]) => t === "pointermove").length;
    expect(installed).toBe(1);

    // Five shell re-renders, each handing the tab a brand-new `onWidth` identity.
    for (let i = 0; i < 5; i += 1) {
      rerender(
        <ColumnPullTab width={360} onWidth={() => {}} min={280} max={560} label="Sparkle column" cssVar={VAR} />,
      );
    }
    expect(add.mock.calls.filter(([t]) => t === "pointermove").length).toBe(installed);
    release();
    add.mockRestore();
  });

  it("still commits through the LATEST onWidth, from the width it was pressed at", () => {
    // The corollary: reading config through a ref must not mean reading a STALE one. The gesture's
    // origin is the width at press time, but the handler it calls is the current one.
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(
      <ColumnPullTab width={360} onWidth={stale} min={280} max={560} label="Sparkle column" cssVar={VAR} />,
    );
    press(dots(), 500);
    moveTo(520);
    rerender(
      <ColumnPullTab width={999} onWidth={fresh} min={280} max={560} label="Sparkle column" cssVar={VAR} />,
    );
    moveTo(540);
    release();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith(400); // 360 (press-time width) + 40, NOT 999 + 40
  });
});
