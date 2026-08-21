// @vitest-environment jsdom
//
// The rail as rendered. The numeric contract is proved in `scrubberGeometry.test.ts` — jsdom lays
// nothing out, so nothing here measures a position (docs/jsdom-test-caveats.md). What IS decidable
// in a DOM, and what these rows assert:
//
//   • WHICH dots exist — a count and their accessible names, which is how the "scope is a zoom, not
//     a filter" behaviour shows up in a tree that has no geometry.
//   • WHICH marker a gesture commits — `onPick`'s ARGUMENT, not merely that it fired. A test that
//     asserted "onPick was called" would pass against a rail that always picks the first prompt.
//   • THAT the drag listeners are on `document` — by dispatching there and requiring the effect.
//     AGENTS.md records a shipped bug from a test firing at the wrong target while the listener sat
//     on another (`no-cross-target-event-dispatch`), so these rows fire where the USER's events go.
//
// The rail's height comes from the `railHeightPx` prop throughout: every `getBoundingClientRect` in
// jsdom reads 0, so without it a drag's fraction would be a division by zero and every assertion
// below would be about NaN.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scrubberHandleLabel,
  SCRUBBER_SCOPE_LABEL,
  THREAD_SCRUBBER_TESTID,
  ThreadScrubber,
  TRACK_WIDTH,
  type ThreadScrubberProps,
} from "./ThreadScrubber";
import { C } from "../../theme/colors";

/** What the track paints when the query SUCCEEDED — read from the token, not restated. */
const SOLID_TRACK_BACKGROUND = C.hairline;
import {
  clusterMarkers,
  fractionFor,
  nearestMarker,
  scopeWindow,
  type ScrubberMarker,
} from "./scrubberGeometry";

/** The rail's own constants, imported rather than restated so the test cannot drift from the paint. */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;
const RAIL = 200;

afterEach(cleanup);

const mk = (index: number, ago: number, textPrefix = `prompt number ${index}`): ScrubberMarker => ({
  id: `m${index}`,
  createdAt: NOW - ago,
  textPrefix,
  index,
});

/** Four prompts spread over nine days, far enough apart never to cluster at RAIL=200. */
const SPREAD: ScrubberMarker[] = [
  mk(1, 9 * DAY, "the oldest one, nine days back"),
  mk(2, 5 * DAY, "Search public data sources to find me 20 people that are most like Zoe"),
  mk(3, 20 * HOUR, "twenty hours back"),
  mk(4, 2 * HOUR, "two hours back"),
];

function draw(over: Partial<ThreadScrubberProps> = {}) {
  const onPick = vi.fn();
  const onSeek = vi.fn();
  const onScopeChange = vi.fn();
  const props: ThreadScrubberProps = {
    markers: SPREAD,
    scope: "2w",
    onScopeChange,
    now: NOW,
    railHeightPx: RAIL,
    position: 1,
    onSeek,
    onPick,
    ...over,
  };
  const utils = render(<ThreadScrubber {...props} />);
  return { ...utils, onPick, onSeek, onScopeChange, props };
}

const dots = () => screen.queryAllByTestId(`${THREAD_SCRUBBER_TESTID}-dot`);
const handle = () => screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-handle`);
const rail = () => handle().parentElement as HTMLElement;

/** A mouse event carrying a real `clientY`, which `fireEvent.mouseMove` alone does not. */
const mouseAt = (clientY: number) => ({ clientY, bubbles: true });

describe("the rail still renders", () => {
  // THE REGRESSION GUARD the founder's goal names. He has asked for this rail four times over
  // sixteen days; the failure that costs him the fifth ask is the rail quietly not drawing.
  it("REGRESSION GUARD: renders the rail with one dot per prompt in the window", () => {
    draw();
    expect(screen.getByTestId(THREAD_SCRUBBER_TESTID)).toBeTruthy();
    expect(dots()).toHaveLength(4);
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Prompt 1, 9 days ago",
      "Prompt 2, 5 days ago",
      "Prompt 3, 20 hours ago",
      "Prompt 4, 2 hours ago",
    ]);
    // Oldest first — top of the rail is the far end of the window, which is the founder's whole
    // mental model ("the top of the slider takes me all the way back").
    expect(screen.getByRole("slider")).toBeTruthy();
  });
});

describe("the scope is a ZOOM, not a filter", () => {
  it("changes WHICH dots render as the window tightens", () => {
    const { rerender, props } = draw({ scope: "2w" });
    expect(dots()).toHaveLength(4);

    rerender(<ThreadScrubber {...props} scope="7d" />);
    // The nine-day-old prompt falls off the top of a seven-day rail.
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Prompt 2, 5 days ago",
      "Prompt 3, 20 hours ago",
      "Prompt 4, 2 hours ago",
    ]);

    rerender(<ThreadScrubber {...props} scope="1d" />);
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Prompt 3, 20 hours ago",
      "Prompt 4, 2 hours ago",
    ]);

    rerender(<ThreadScrubber {...props} scope="1h" />);
    expect(dots()).toHaveLength(0);
  });

  it("offers every scope the founder listed and reports the one picked", () => {
    const { onScopeChange } = draw();
    const select = screen.getByLabelText(SCRUBBER_SCOPE_LABEL) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "1h",
      "3h",
      "6h",
      "12h",
      "1d",
      "3d",
      "7d",
      "1w",
      "2w",
      "1m",
      "3m",
      "6m",
      "1y",
    ]);
    expect(select.value).toBe("2w");
    fireEvent.change(select, { target: { value: "3m" } });
    expect(onScopeChange).toHaveBeenCalledTimes(1);
    expect(onScopeChange).toHaveBeenCalledWith("3m");
  });
});

describe("clicking a dot", () => {
  it("commits THAT prompt — the argument, not merely the call", () => {
    const { onPick } = draw();
    fireEvent.click(dots()[1]!);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m2", index: 2 });

    fireEvent.click(dots()[3]!);
    expect(onPick.mock.calls[1]![0]).toMatchObject({ id: "m4", index: 4 });
  });

  it("does NOT also fire a drag commit — one click is one pick", () => {
    // The dot sits inside the rail, whose mousedown starts a drag. Without the dot swallowing that
    // press, the mouseup ending the zero-distance drag would commit a second, possibly different,
    // marker — and `position` (1, the bottom) would make that second pick the NEWEST prompt every
    // time, silently overriding the one he clicked.
    const { onPick } = draw();
    fireEvent.mouseDown(dots()[0]!, mouseAt(0));
    fireEvent.click(dots()[0]!);
    fireEvent(document, new MouseEvent("mouseup", mouseAt(RAIL)));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m1" });
  });
});

describe("dragging the rail", () => {
  it("seeks live on document mousemove and COMMITS the nearest marker on mouseup", () => {
    const { onPick, onSeek } = draw({ scope: "1d" });
    // A 1d window on a 200px rail: prompt 3 (20h ago) sits at fraction 4/24 ≈ 0.167 → 33px, and
    // prompt 4 (2h ago) at 22/24 ≈ 0.917 → 183px.
    fireEvent.mouseDown(rail(), mouseAt(0));
    fireEvent(document, new MouseEvent("mousemove", mouseAt(40)));
    expect(onSeek).toHaveBeenLastCalledWith(0.2, expect.objectContaining({ id: "m3" }));

    fireEvent(document, new MouseEvent("mousemove", mouseAt(170)));
    expect(onSeek).toHaveBeenLastCalledWith(0.85, expect.objectContaining({ id: "m4" }));
    expect(onPick).not.toHaveBeenCalled(); // nothing commits mid-drag

    fireEvent(document, new MouseEvent("mouseup", mouseAt(170)));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m4" });
  });

  it("stops listening after the drag ends, and after unmount", () => {
    const { onSeek, unmount } = draw();
    fireEvent.mouseDown(rail(), mouseAt(0));
    fireEvent(document, new MouseEvent("mouseup", mouseAt(100)));
    const afterUp = onSeek.mock.calls.length;
    fireEvent(document, new MouseEvent("mousemove", mouseAt(150)));
    expect(onSeek.mock.calls.length).toBe(afterUp);

    fireEvent.mouseDown(rail(), mouseAt(0));
    unmount();
    const afterUnmount = onSeek.mock.calls.length;
    fireEvent(document, new MouseEvent("mousemove", mouseAt(20)));
    expect(onSeek.mock.calls.length).toBe(afterUnmount);
  });

  it("commits nothing when the window holds no prompts", () => {
    // Releasing the handle over an empty rail must be a no-op. A jump to "whatever is nearest" with
    // nothing in range would scroll the thread somewhere he did not ask for.
    const { onPick } = draw({ scope: "1h" });
    fireEvent.mouseDown(rail(), mouseAt(0));
    fireEvent(document, new MouseEvent("mouseup", mouseAt(100)));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("the keyboard", () => {
  it("steps to the previous and next PROMPT, not by a fixed fraction", () => {
    const { onPick, onSeek, rerender, props } = draw({ scope: "2w", position: 1 });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m4" });
    const seekedTo = onSeek.mock.calls[0]![0] as number;

    rerender(<ThreadScrubber {...props} position={seekedTo} />);
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(onPick.mock.calls[1]![0]).toMatchObject({ id: "m3" });

    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(onPick.mock.calls[2]![0]).toMatchObject({ id: "m4" });
  });

  it("holds at the end dot rather than going dead at the top of the rail", () => {
    const { onPick } = draw({ position: 0 });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m1" });
  });

  it("ignores keys it does not own, and every key on an empty rail", () => {
    const { onPick } = draw();
    fireEvent.keyDown(handle(), { key: "a" });
    expect(onPick).not.toHaveBeenCalled();

    cleanup();
    const empty = draw({ scope: "1h" });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(empty.onPick).not.toHaveBeenCalled();
  });

  it("reports its position on the slider role", () => {
    draw({ position: 0.25, scope: "1d" });
    expect(handle().getAttribute("aria-valuemin")).toBe("0");
    expect(handle().getAttribute("aria-valuemax")).toBe("1");
    expect(handle().getAttribute("aria-valuenow")).toBe("0.25");
    // A quarter of the way down a 1d rail is 18 hours back.
    expect(handle().getAttribute("aria-valuetext")).toBe("18 hours ago");
  });
});

describe("the hover card", () => {
  const card = () => screen.queryByTestId(`${THREAD_SCRUBBER_TESTID}-card`);

  it("shows the prompt, its age and the byline — the founder's own mockup line", () => {
    draw();
    expect(card()).toBeNull();
    fireEvent.mouseEnter(dots()[1]!);
    expect(card()!.textContent).toContain(
      "Prompt 2: Search public data sources to find me 20 people that are most like Zoe",
    );
    expect(card()!.textContent).toContain("5 days ago by DROdio");
    fireEvent.mouseLeave(dots()[1]!);
    expect(card()).toBeNull();
  });

  it("opens on KEYBOARD focus too, so the rail is not mouse-only", () => {
    draw();
    fireEvent.focus(dots()[2]!);
    expect(card()!.textContent).toContain("Prompt 3");
    fireEvent.blur(dots()[2]!);
    expect(card()).toBeNull();
  });
});

describe("clustering, as rendered", () => {
  // Six prompts inside four minutes. At RAIL=200 over a 1h window one pixel is 18 seconds, so the
  // default 6px gap is 108 seconds: prompts 1-3 (0s, 40s, 80s) merge, prompts 4-6 (150s, 190s,
  // 230s) merge, and the rail draws TWO dots for six prompts.
  const BURST: ScrubberMarker[] = [
    mk(1, 30 * 60_000 - 0, "first of the burst"),
    mk(2, 30 * 60_000 - 40_000, "second"),
    mk(3, 30 * 60_000 - 80_000, "third"),
    mk(4, 30 * 60_000 - 150_000, "fourth"),
    mk(5, 30 * 60_000 - 190_000, "fifth"),
    mk(6, 30 * 60_000 - 230_000, "the newest of the second burst"),
  ];

  it("draws one fat dot per burst instead of six overlapping ones", () => {
    draw({ markers: BURST, scope: "1h" });
    expect(dots()).toHaveLength(2);
    expect(dots().map((d) => d.getAttribute("data-cluster-size"))).toEqual(["3", "3"]);
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Prompts 1–3, 3 prompts",
      "Prompts 4–6, 3 prompts",
    ]);
  });

  it("reads like the spec's card and jumps to the prompt the card SHOWED", () => {
    const { onPick } = draw({ markers: BURST, scope: "1h" });
    fireEvent.mouseEnter(dots()[1]!);
    const text = screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-card`).textContent!;
    expect(text).toContain("Prompts 4–6 · 3 prompts");
    expect(text).toContain("the newest of the second burst");
    // The card printed the NEWEST member's words, so the click must land on that message and not on
    // the cluster's first — otherwise he arrives somewhere other than what he just read.
    fireEvent.click(dots()[1]!);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: "m6", index: 6 });
  });
});

describe("the empty state", () => {
  it("draws the rail and the dropdown but no dots, and SAYS why on the handle", () => {
    // An unexplained empty rail reads as a bug — the exact failure the spec warns about.
    draw({ scope: "1h" });
    expect(screen.getByTestId(THREAD_SCRUBBER_TESTID)).toBeTruthy();
    expect(screen.getByLabelText(SCRUBBER_SCOPE_LABEL)).toBeTruthy();
    expect(dots()).toHaveLength(0);
    expect(handle().getAttribute("aria-label")).toBe(
      "Thread scrubber — no prompts in the last 1 hour",
    );
  });

  it("names the count and the window once there ARE prompts", () => {
    draw({ scope: "7d" });
    expect(handle().getAttribute("aria-label")).toBe(
      "Thread scrubber — 3 prompts in the last 7 days",
    );
    expect(scrubberHandleLabel(1, "1d")).toBe("Thread scrubber — 1 prompt in the last 1 day");
  });
});

// ── THE ROBOREV 66386 FINDINGS ──────────────────────────────────────────────────────────────────
// Three Mediums against the first cut of this component. Each row below is written to go RED
// without its fix, not merely to describe the fixed behaviour.

describe("a non-primary button never drives the rail", () => {
  // The visible half: a right-click on the rail used to start a drag and COMMIT a jump on release,
  // scrolling the thread to a prompt the reader never asked for while opening a context menu.
  it("ignores a right-click press entirely", () => {
    const { onSeek, onPick } = draw();
    fireEvent.mouseDown(rail(), { clientY: 50, button: 2 });
    expect(onSeek).not.toHaveBeenCalled();

    // …and no drag is armed, so document-level movement afterwards is inert. This is the assertion
    // that catches the WORSE half: `preventDefault()` on mousedown does not suppress `contextmenu`,
    // so a swallowed mouseup would leave `dragging === true` with live document listeners — after
    // which every mouse move anywhere in the app drags the handle.
    fireEvent(document, new MouseEvent("mousemove", mouseAt(120)));
    fireEvent(document, new MouseEvent("mouseup", { ...mouseAt(120), button: 0 }));
    expect(onSeek).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  // The PAIRED case, so the test above cannot pass against a rail that ignores every button: the
  // same gesture with the primary button must still work.
  it("but a primary-button drag still commits, so the guard is not a blanket refusal", () => {
    const { onPick } = draw();
    fireEvent.mouseDown(rail(), { clientY: 0, button: 0 });
    fireEvent(document, new MouseEvent("mousemove", mouseAt(0)));
    fireEvent(document, new MouseEvent("mouseup", { ...mouseAt(0), button: 0 }));
    expect(onPick).toHaveBeenCalledTimes(1);
    // Fraction 0 is the TOP of the rail, which is the OLDEST prompt in the window.
    expect(onPick.mock.calls[0]![0].id).toBe("m1");
  });

  it("disarms rather than commits when a context menu swallows the release", () => {
    const { onPick } = draw();
    fireEvent.mouseDown(rail(), { clientY: 0, button: 0 });
    fireEvent(document, new MouseEvent("contextmenu", { bubbles: true }));
    // The mouseup never arrives. A later stray release must not commit a jump.
    fireEvent(document, new MouseEvent("mouseup", { ...mouseAt(180), button: 0 }));
    expect(onPick).not.toHaveBeenCalled();
  });

  // …AND PUTS THE HANDLE BACK (roborev 66397). `position` is controlled and the parent moved it on
  // every seek of the drag, while only onPick scrolls — so a cancel that merely stopped dragging
  // left the handle pointing at a prompt the thread was never showing. The restore is an onSeek,
  // never an onPick, because a cancelled gesture is not a choice.
  // A CONTROLLED PARENT, which is the only harness in which this defect exists at all (roborev
  // 66467). The first version of this row used a bare `vi.fn()` for `onSeek`, so `position` never
  // moved — and "the fraction the drag STARTED from" and "whatever position is now" were the same
  // number, making the assertion unable to tell them apart. Concretely, `onCancel` could have been
  // rewritten to emit the effect's closed-over `position` and the row stayed green, while in
  // production that closure captures the value from the render where `dragging` flipped true, i.e.
  // AFTER the mousedown's own seek already moved the handle — so the "restore" would re-emit a
  // mid-drag fraction and the handle would never go back.
  //
  // `useThreadScrubber` moves `position` on every seek, so this mirrors the real parent.
  function ControlledRail({ onPick, seen }: { onPick: () => void; seen: number[] }) {
    const [position, setPosition] = useState(1);
    return (
      <ThreadScrubber
        markers={SPREAD}
        scope="2w"
        onScopeChange={() => {}}
        now={NOW}
        railHeightPx={RAIL}
        position={position}
        onSeek={(f) => {
          seen.push(f);
          setPosition(f);
        }}
        onPick={onPick}
      />
    );
  }

  it("re-emits the fraction the drag STARTED from — not the mid-drag one", () => {
    const onPick = vi.fn();
    const seen: number[] = [];
    render(<ControlledRail onPick={onPick} seen={seen} />);

    fireEvent.mouseDown(rail(), { clientY: 0, button: 0 });
    fireEvent(document, new MouseEvent("mousemove", mouseAt(40)));
    // The parent has now MOVED the handle away from where the press began.
    const midDrag = seen[seen.length - 1]!;
    expect(midDrag).not.toBe(1);
    const before = seen.length;

    fireEvent(document, new MouseEvent("contextmenu", { bubbles: true }));

    expect(seen.length).toBe(before + 1);
    const restored = seen[seen.length - 1]!;
    expect(restored, "must restore the PRE-PRESS fraction, not the mid-drag one").toBe(1);
    expect(restored).not.toBe(midDrag);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("the slider role is honest", () => {
  // ARIA's default orientation is HORIZONTAL, so without this the rail announced itself as a
  // horizontal slider — and the user reaches for the keys that role implies.
  it("announces itself as vertical", () => {
    draw();
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
  });

  it("Home jumps to the OLDEST in-window prompt and End to the newest", () => {
    const { onPick } = draw({ scope: "2w", position: 0.5 });
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(onPick.mock.calls.at(-1)![0].id).toBe("m1");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(onPick.mock.calls.at(-1)![0].id).toBe("m4");
  });

  // ALIAS means "does the same thing", so that is what is asserted — the same gesture from the same
  // position through both keys, compared to each other. Pinning a literal id instead would encode
  // whatever the stepping happens to do from an arbitrary position, which is a different claim and
  // one this row is not making.
  it("accepts ArrowLeft/ArrowRight as aliases, since the announced role invites them", () => {
    const back = draw({ scope: "2w", position: 0.98 });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    const viaArrowUp = back.onPick.mock.calls.at(-1)![0].id;
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(back.onPick.mock.calls.at(-1)![0].id).toBe(viaArrowUp);
    cleanup();

    const fwd = draw({ scope: "2w", position: 0.1 });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    const viaArrowDown = fwd.onPick.mock.calls.at(-1)![0].id;
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(fwd.onPick.mock.calls.at(-1)![0].id).toBe(viaArrowDown);

    // …and the two directions are genuinely different, so "both do nothing" cannot pass this.
    expect(viaArrowUp).not.toBe(viaArrowDown);
  });

  // The guard stays a guard: a key the slider does not own must still fall through untouched.
  it("still ignores keys the role does not promise", () => {
    const { onPick } = draw();
    fireEvent.keyDown(handle(), { key: "a" });
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("clustering uses the MEASURED rail, not just the prop", () => {
  /** Give the rail a real laid-out height, which jsdom otherwise reports as 0. */
  function measureRailAs(height: number): void {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const isRail = this.getAttribute("data-scrubber-track") === "yes";
        return { top: 0, left: 0, right: 0, bottom: height, width: 16, height: isRail ? height : 0,
          x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      },
    });
  }
  afterEach(() => {
    // @ts-expect-error restore jsdom's own zero-rect implementation
    delete HTMLElement.prototype.getBoundingClientRect;
  });

  // THE SIDE EFFECT, not the plumbing: the merge threshold is a PIXEL gap, so measuring the wrong
  // ruler changes HOW MANY DOTS EXIST. Four prompts inside one hour are far enough apart to stay
  // separate on a tall rail and must merge on a short one. A component that clustered against the
  // 320px default forever would answer the same either way.
  it("draws more dots on a tall rail than on a short one, for identical markers", () => {
    const MINUTE = 60_000;
    const burst = [mk(1, 50 * MINUTE), mk(2, 49 * MINUTE), mk(3, 48 * MINUTE), mk(4, 47 * MINUTE)];

    measureRailAs(2000);
    const tall = render(<ThreadScrubber {...draw({ markers: burst, scope: "1h" }).props} />);
    const tallDots = tall.container.querySelectorAll(
      `[data-testid="${THREAD_SCRUBBER_TESTID}-dot"]`,
    ).length;
    cleanup();

    measureRailAs(30);
    const short = render(<ThreadScrubber {...draw({ markers: burst, scope: "1h" }).props} />);
    const shortDots = short.container.querySelectorAll(
      `[data-testid="${THREAD_SCRUBBER_TESTID}-dot"]`,
    ).length;

    expect(tallDots).toBeGreaterThan(shortDots);
  });
});

describe("a REJECTED history query does not read as a quiet week", () => {
  // Both states draw zero dots, so the empty rail alone cannot tell them apart — and for four
  // commits of this branch it WAS a rejected query (both Rust commands were missing from
  // generate_handler!), rendering as an ordinary empty week with nothing to indicate otherwise.
  // roborev 66429. The spec's own warning is that the founder reads an empty rail as broken; the
  // honest answer is a rail that can say which of the two he is looking at.
  it("says the history could not be read, rather than that there were no prompts", () => {
    draw({ scope: "1h", failed: true });
    expect(dots()).toHaveLength(0);
    expect(handle().getAttribute("aria-label")).toBe(
      "Thread scrubber — could not read your history for the last 1 hour",
    );
  });

  // THE PAIRED CASE. Without it, a component that always claimed failure would pass the row above.
  it("still says 'no prompts' when the query SUCCEEDED and returned nothing", () => {
    draw({ scope: "1h", failed: false });
    expect(dots()).toHaveLength(0);
    expect(handle().getAttribute("aria-label")).toBe(
      "Thread scrubber — no prompts in the last 1 hour",
    );
  });

  it("the two labels are different strings, so the distinction is real", () => {
    expect(scrubberHandleLabel(0, "7d", true)).not.toBe(scrubberHandleLabel(0, "7d", false));
  });

  // A SIGHTED SIGNAL, not only an accessible name (roborev 66443). The founder is who reads an
  // empty rail as broken, and the first cut of this flag changed nothing he could see.
  // ASSERTS THE PAINT, NOT THE MARKER (roborev 66451). The first version of these rows checked only
  // `[data-scrubber-failed="yes"]`, which the marker attribute satisfies on its own — so reverting
  // all three style lines that ARE the visual difference left the suite green with the attribute
  // still present, and the founder back to an identical empty rail. jsdom does serve inline styles
  // (see ConciergeColumn.wired.test.tsx, NudgeCard.test.tsx, MentionPicker.test.tsx, which all read
  // `style.borderLeft*` for exactly this reason), so the paint itself is assertable here.
  const track = (c: HTMLElement): HTMLElement =>
    c.querySelector<HTMLElement>('[data-scrubber-failed="yes"]') ??
    (c.querySelector<HTMLElement>('[aria-hidden="true"]') as HTMLElement);

  // EXACT VALUES ON BOTH SIDES (roborev 66481). A `not.toBe(...)` is satisfied by an ABSENT
  // declaration, so the ordinary-empty row passed against a track painting NOTHING AT ALL — a worse
  // version of the "an empty rail reads as broken" misreading this block exists to prevent. jsdom
  // stores `background` verbatim even with a custom-property reference (SettingsDialog.test.tsx
  // asserts `style.background === "var(--c-input-surface)"`); only the multi-component `borderLeft`
  // shorthand was unstorable, which is what the longhand split fixed. Nothing forced a negative.
  it("draws the track DASHED, so a sighted reader can tell too", () => {
    const { container } = draw({ scope: "1h", failed: true });
    const t = track(container);
    expect(t).toBeTruthy();
    expect(t.style.borderLeftStyle).toBe("dashed");
    expect(t.style.borderLeftWidth).toBe(`${TRACK_WIDTH}px`);
    // The solid fill must GO, or a dashed border over it is invisible.
    expect(t.style.background).toBe("transparent");
    expect(t.style.opacity).toBe("0.7");
  });

  it("…and leaves the track SOLID and fully opaque on an ordinary empty week", () => {
    const { container } = draw({ scope: "1h", failed: false });
    const t = track(container);
    expect(container.querySelector('[data-scrubber-failed="yes"]')).toBeNull();
    // The hairline is PAINTED, not merely "not dashed" — an absent declaration is a blank rail.
    expect(t.style.background).toBe(SOLID_TRACK_BACKGROUND);
    expect(t.style.borderLeftStyle).toBe("");
    expect(t.style.opacity).toBe("1");
  });

  // Reachable WITHOUT assistive tech: the dots carry a title, the handle did not.
  it("puts the same explanation on the handle's title, for a mouse user", () => {
    draw({ scope: "1h", failed: true });
    expect(handle().getAttribute("title")).toBe(
      "Thread scrubber — could not read your history for the last 1 hour",
    );
  });
});

describe("a CLICK and a DRAG onto the same dot commit the same prompt", () => {
  // THE COMMON CASE, which the same-millisecond fixture could not see (roborev 66465).
  // clusterMarkers merges anything within ~6px, so at a wide scope one fat dot spans DISTINCT
  // timestamps — days apart at 1y. The hover card prints the newest member and a click commits it;
  // the drag used to run nearestMarker over the RAW markers, so releasing on the upper half of that
  // dot (or exactly on its centre, where the equidistant tie deliberately prefers the OLDER)
  // committed a different prompt from the one the card had just named.
  const MIN = 60_000;
  // Four prompts a few minutes apart. Over a 1y window they are far closer than the 6px merge gap,
  // so they are ONE dot whose members have four different timestamps.
  const BURST: ScrubberMarker[] = [
    mk(1, 200 * DAY + 3 * MIN, "oldest of the burst"),
    mk(2, 200 * DAY + 2 * MIN, "second"),
    mk(3, 200 * DAY + 1 * MIN, "third"),
    mk(4, 200 * DAY, "newest of the burst"),
  ];

  function drawBurst() {
    return draw({ markers: BURST, scope: "1y", position: 0.5 });
  }

  it("merges them into one dot, so this fixture really is the case under test", () => {
    drawBurst();
    expect(dots()).toHaveLength(1);
    expect(dots()[0]!.getAttribute("data-cluster-size")).toBe("4");
    // …and the members are NOT same-millisecond, which is what makes this different from the
    // tie-break case in scrubberGeometry.test.ts.
    expect(new Set(BURST.map((m) => m.createdAt)).size).toBe(4);
  });

  it("agree: both commit the newest member the hover card names", () => {
    const clicked = drawBurst();
    fireEvent.click(dots()[0]!);
    const viaClick = clicked.onPick.mock.calls.at(-1)![0].id;
    cleanup();

    const dragged = drawBurst();
    fireEvent.mouseDown(rail(), { clientY: 0, button: 0 });
    // Release at the dot's own centre. THE PIXEL IS CHOSEN SO THE TWO PATHS PROVABLY DISAGREE
    // (roborev 66498): the earlier version used the newest member's fraction, and only
    // distinguished the cluster path from `nearestMarker` because the rounding happened to truncate
    // downward — nudge RAIL, NOW or the burst offset and it would have passed against the un-fixed
    // code. The cluster sits at its OWN fraction, and `nearestMarker` at that pixel answers a
    // different member; the assertion below states that disagreement explicitly, so the row can
    // never again pass by arithmetic accident.
    const win = scopeWindow(NOW, "1y");
    const dotFraction = clusterMarkers(BURST, win, RAIL)[0]!.fraction;
    const at = Math.round(dotFraction * RAIL);
    const rawAnswer = nearestMarker(at / RAIL, BURST, win)!.id;
    expect(rawAnswer, "the fixture must be one where the two paths differ").not.toBe("m4");

    fireEvent(document, new MouseEvent("mousemove", mouseAt(at)));
    fireEvent(document, new MouseEvent("mouseup", { ...mouseAt(at), button: 0 }));
    const viaDrag = dragged.onPick.mock.calls.at(-1)![0].id;

    expect(viaDrag).toBe(viaClick);
    // Stated absolutely too, so a change moving BOTH paths together could not pass silently.
    expect(viaClick).toBe("m4");
    // …and explicitly NOT what the old raw-marker path would have committed.
    expect(viaDrag).not.toBe(rawAnswer);
  });

  // Releasing ABOVE the dot's centre — the half that used to resolve to an older member — must
  // still commit the dot's own prompt, because what the reader released over is the dot.
  it("still commits the dot's prompt when released on its upper half", () => {
    const { onPick } = drawBurst();
    const centre = fractionFor(BURST[3]!.createdAt, scopeWindow(NOW, "1y")) * RAIL;
    fireEvent.mouseDown(rail(), { clientY: 0, button: 0 });
    fireEvent(document, new MouseEvent("mouseup", { ...mouseAt(Math.round(centre - 2)), button: 0 }));
    expect(onPick.mock.calls.at(-1)![0].id).toBe("m4");
  });
});
