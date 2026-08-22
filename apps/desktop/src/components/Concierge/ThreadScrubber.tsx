// The thread scrubber: a thin vertical rail down the RIGHT of the concierge thread. It REPLACES the
// native scrollbar — a line per prompt, a handle that expands into a grip when you grab it, and a
// scope menu saying how far back the thread is loaded.
//
// ── THE RULE THIS FILE USED TO STATE, AND WHY IT CHANGED (bead sparkle-bjbhw6) ──────────────────
// Until 2026-08-22 the header here said: *"the committed action is `onPick(marker)` carrying a
// message id, and not a scroll offset: the rail does not know how tall the thread is and must never
// pretend to."* That was a deliberate decision, and the founder overruled it in as many words:
//
//   *"I start to scroll up and down, it actually moves the chat in real time. It replaces the
//    scroll. So I don't have the scroll anymore. I just have this draggable handle."*
//   *"As I move the slider, I want it to be scrolling in real time. So as I click on it and as I
//    drag up and down it actually moves the chat thread."*
//   *"I want the slider bar to replace the scroll bar... there shouldn't be a scroll bar. There
//    should only be the slider."*
//
// A control that replaces the scrollbar MUST know the scroller's geometry — there is no version of
// "the thread tracks my hand" that a control ignorant of the scroll range can deliver. So the rail
// is now measured in the scroller's own units (see `railGeometry.ts` for the axis and why it is
// content rather than time), it emits `onScrub(fraction)` on EVERY pointermove, and the controller
// writes `scrollTop` synchronously from it. `onPick` survives for a CLICK on a line and for the
// keyboard, where there is no continuous gesture to follow.
//
// The rail is given real measurements rather than being left to guess: `position` is the scroller's
// own fraction, pushed down by the controller that owns the element, and every mark's `fraction` was
// measured off the rendered row. Nothing here estimates anything.
//
// ── PRESENTATIONAL, AND STILL DELIBERATELY SO ──────────────────────────────────────────────────
// This component holds no store, reads no clock and fetches nothing. `marks`, `scope`, `now`,
// `oldestMs` and `position` all arrive as props and every outcome leaves as a callback. Two
// consequences that look like omissions but are not:
//
//   • `now` IS A REQUIRED PROP, not a `Date.now()` default. It is COUPLED to the mark timestamps —
//     the hover card's age is a function of both — so a test that could control only one of the two
//     could not tell this rail apart from a broken one. That is AGENTS.md's "a defaulted seam every
//     test injects" (bead sparkle-lgbwf) applied before it could happen rather than after.
//   • `railHeightPx` IS A PROP with a default. jsdom lays nothing out, so `getBoundingClientRect`
//     reads 0 for the rail's height; a rail that could only learn its height from a ref would merge
//     nothing and draw its marks at NaN under every test that ever renders it. The measured rect is
//     preferred at runtime and this prop is the fallback — see `fractionFromClientY`.
//
// ── VISUAL REGISTER: CALM AT REST, ANSWERS THE GRAB ────────────────────────────────────────────
// The founder's standing rule for the concierge header is "no words at all", and the rail is
// narrower than the header. So: a 3px track, hairline MARKS rather than dots (*"those dots are
// gonna be way too thick. I think we need it to be little lines instead of dots"*), and a scope
// control that is a bare token plus a chevron rather than a form widget. At rest the handle is a
// 3px hairline; on pointerdown it expands into the app's own drag grip so it reads as draggable
// (*"when I click on the little white slider, it should become fatter. And it should have rows"*).
// `JSX` is imported as a TYPE rather than reached for as a global: React 19 stopped publishing the
// global `JSX` namespace, so the frozen contract's `JSX.Element` return type has to come from the
// package now.
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

import { RAIL_GRIP_DOT, RAIL_GRIP_DOT_GAP } from "../ColumnPullTab";
import { C } from "../../theme/colors";
import { FONT_UI, PILL, RADIUS, SPACE, TYPE, WEIGHT } from "../../theme/scale";
import {
  mergeMarks,
  pickFromBand,
  type MarkBand,
  type RailMark,
} from "./railGeometry";
import {
  ageLabel,
  SCOPE_PHRASE,
  SCRUBBER_SCOPES,
  scopeMenuLabel,
  SCOPE_LABEL,
  type ScrubberScope,
} from "./scrubberGeometry";

export const THREAD_SCRUBBER_TESTID = "concierge-thread-scrubber";
export const SCRUBBER_SCOPE_LABEL = "Scrubber time scope";

/**
 * The opt-out attribute every interactive control in this app sets on itself so that a CLICK-DRAG
 * on it is read as a CONTROL GESTURE rather than as a text selection.
 *
 * The founder's rule, verbatim: *"if I'm dragging and scrolling the scroll bar, I don't want it to
 * be implementing drag to understand. So anything where there is an action that is click drag
 * should not trigger drag to understand."* The mechanism lives in `controlGesture.ts` and the
 * selection hooks consume it; the rail's only job is to DECLARE itself, which is the point of an
 * opt-out attribute over a hardcoded selector list that the next control would forget to join.
 *
 * Spelled as a literal here rather than imported so the rail carries no dependency on the hook that
 * reads it — the attribute is the contract, and `controlGesture.test.ts` pins the same string.
 */
const CONTROL_GESTURE = { "data-control-gesture": "yes" } as const;

/**
 * The hover card's byline author.
 *
 * A CONSTANT, not a mark field, because of what a mark means: the founder decided the rail plots
 * *"his prompts only"* (spec, "The founder's decisions"). Every mark is therefore his by
 * construction, and a per-mark author field would be a column that is the same value in every row.
 * If the rail ever plots someone else's turns this becomes a `RailMark` field — and that change
 * should be forced to touch the contract, rather than being possible by accident.
 */
export const SCRUBBER_AUTHOR = "DROdio";

/**
 * The rail's own width.
 *
 * ── IT SIZES FOUR THINGS, AND THAT IS THE TRAP ─────────────────────────────────────────────────
 * The gutter, the track column, the handle AND (until this change) the scope select all derived
 * their width from this one constant, so bumping it to fit the chevron would have fattened the
 * handle and the mark column too. The scope control now sizes itself (see `ScopeMenu`), and the
 * handle's two states are named below — so this constant means exactly one thing: how much width
 * the gutter takes from the prose.
 *
 * 26 rather than the old 16 because the handle's GRABBED state is a 3x2 dot grip, which is
 * 3*3 + 2*2 = 13px of dots plus its padding. The gutter is `flexShrink: 0` in `ConciergeThread`, so
 * this width comes out of the transcript's — worth it for a control that is now the only vertical
 * position control the column has.
 */
const RAIL_WIDTH = 26;
/** Exported so the paint tests assert the SAME number the rail draws, not a restated literal. */
export const TRACK_WIDTH = 3;
/**
 * A mark is a LINE, not a dot — the founder's own correction: *"those dots are gonna be way too
 * thick. I think we need it to be little lines instead of dots."* So: full-width of the track's
 * column, one or two pixels tall, square-ended. A merged band is drawn TALLER and brighter rather
 * than fatter, because a fat dot is the shape he rejected.
 */
export const MARK_WIDTH = 9;
const MARK_HEIGHT = 1;
const BAND_WIDTH = 13;
const BAND_HEIGHT = 2;
/** The handle at rest: a hairline, the calmest thing that can still be seen. */
const HANDLE_REST_WIDTH = 14;
const HANDLE_REST_HEIGHT = 3;
/**
 * The handle GRABBED: wide enough for a 3x2 grip, tall enough that the dots are not cramped.
 *
 * THE JUMP HAS TO BE LEGIBLE, not merely real. *"When I click on the little white slider, it should
 * become fatter."* Derived from the grip's own metrics plus padding rather than typed as a literal,
 * so the box can never end up smaller than the dots it has to hold — but the REST width is a
 * separate constant, deliberately, because deriving it from `RAIL_WIDTH` is what made the earlier
 * draft's two states 18px and 19px: a change nobody could see.
 */
const HANDLE_GRAB_WIDTH = RAIL_GRIP_DOT * 3 + RAIL_GRIP_DOT_GAP * 2 + 8;
const HANDLE_GRAB_HEIGHT = RAIL_GRIP_DOT * 2 + RAIL_GRIP_DOT_GAP + 6;

export interface ThreadScrubberProps {
  /** Every prompt in the loaded thread, positioned on the CONTENT axis. See `railGeometry.ts`. */
  marks: RailMark[];
  scope: ScrubberScope;
  onScopeChange: (s: ScrubberScope) => void;
  /** INJECTED CLOCK — see the header on why this is required rather than defaulted. */
  now: number;
  /** `MIN(created_at)` for the concierge source, or null when unknown. Drives the scope menu's
   *  "All — since Aug 12", which is the founder's *"I wanna know how far back you have history"*
   *  answered in place so he never has to ask a person to measure the file again. */
  oldestMs?: number | null;
  /** Measured rail height in px; the fallback when the DOM cannot be measured. */
  railHeightPx?: number;
  /** The scroller's own position, 0..1 (0 = top of the loaded thread). Controlled. */
  position: number;
  /**
   * LIVE, ON EVERY POINTERMOVE — this is what scrolls the thread.
   *
   * Not debounced, not throttled and not deferred to pointerup. The founder must be able to watch
   * the thread track his hand, and anything that samples this gesture reintroduces exactly the
   * *"it doesn't really seem to be doing anything"* he reported. The controller writes `scrollTop`
   * synchronously from it, so the browser coalesces to one paint per frame on its own.
   */
  onScrub?: (fraction: number) => void;
  /** The drag ended (release, cancel, or the window losing focus). */
  onScrubEnd?: () => void;
  /** A CLICK on a mark, or a keyboard step — there is no continuous gesture to follow, so these
   *  commit a jump to that message. */
  onPick: (mark: RailMark) => void;
  /** The history query REJECTED, as opposed to returning nothing.
   *
   *  Signalled THREE ways, because a rejection and a quiet week otherwise look identical and the
   *  reader has no other way to tell them apart: the track is drawn DASHED (the sighted signal, and
   *  the one the founder actually sees), the handle's accessible name says so (see
   *  {@link scrubberHandleLabel}), and the handle carries the same string as a `title` so it is
   *  reachable on hover without assistive tech. */
  failed?: boolean;
  /**
   * How many prompts the store holds ABOVE the loaded window.
   *
   * The rail must never imply the loaded thread is all there is — the founder's *"it's definitely
   * not giving me all of them"* is the complaint this answers. It comes from an AGGREGATE count, not
   * from a row fetch, so knowing it costs one `COUNT(*)` rather than a page of text.
   */
  moreAbove?: number;
}

/**
 * The handle's accessible name, which doubles as the EMPTY STATE.
 *
 * An empty rail with no explanation reads as a bug — the spec says so directly, and it is the exact
 * failure the whole sequencing of this feature exists to avoid. There is no room on a 26px rail for
 * a visible message, so the note rides the one element that always exists and always has a name.
 */
export function scrubberHandleLabel(
  count: number,
  scope: ScrubberScope,
  failed = false,
  moreAbove = 0,
): string {
  const window = SCOPE_PHRASE[scope];
  // A REJECTED QUERY IS NOT AN EMPTY ONE, and the rail is the only thing that can tell the reader
  // which it is looking at (roborev 66429). Both produce zero marks, so without this line a broken
  // bridge reads as a quiet week — and for four commits of this branch it WAS a broken bridge.
  if (failed) return `Thread scrubber — could not read your history for ${window}`;
  if (count === 0) return `Thread scrubber — no prompts in ${window}`;
  const head = `Thread scrubber — ${count} ${count === 1 ? "prompt" : "prompts"} loaded`;
  // SAID OUT LOUD, not merely implied by a shorter track. "Loaded" and "exists" are different
  // numbers the moment the thread is paged, and a control that reports only the first is the one
  // that produced "it's definitely not giving me all of them".
  return moreAbove > 0 ? `${head}, ${moreAbove} older still in history` : head;
}

/** A mark's own accessible name and tooltip. Short: the full text lives in the hover card. */
export function scrubberMarkLabel(band: MarkBand, now: number): string {
  const first = band.marks[0]!;
  const last = band.marks[band.marks.length - 1]!;
  if (band.marks.length === 1) {
    const age = first.createdAt === undefined ? "" : `, ${ageLabel(first.createdAt, now)}`;
    return `Prompt ${first.index}${age}`;
  }
  return `Prompts ${first.index}–${last.index}, ${band.marks.length} prompts`;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function ThreadScrubber({
  marks,
  scope,
  onScopeChange,
  now,
  oldestMs = null,
  railHeightPx = 320,
  position,
  onScrub,
  onScrubEnd,
  onPick,
  failed = false,
  moreAbove = 0,
}: ThreadScrubberProps): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The band whose card is showing — hover OR keyboard focus, so the card is not mouse-only. */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  /**
   * The rail's ACTUAL height, once it has laid out.
   *
   * WHY THIS EXISTS AT ALL (roborev 66386). Merging joins marks closer than a PIXEL gap, so it needs
   * the ruler the reader is actually looking at. Measuring only on the drag path meant merging ran
   * against the 320px DEFAULT forever for any consumer that let the rail size itself. On a 900px
   * column the 6px gap then behaves like ~17 real pixels and distinct prompts silently collapse into
   * one line; on a short rail the inverse, marks overlapping without merging. Both are the loss of
   * history this module exists to prevent.
   *
   * `null` until measured, so `??` can distinguish "not laid out yet" from a real 0.
   */
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const read = () => {
      const h = el.getBoundingClientRect().height;
      // A 0 is "no layout yet" (jsdom always, and a real browser before first paint), never a real
      // height — adopting it would divide every mark's position by zero.
      setMeasuredHeight(h > 0 ? h : null);
    };
    read();
    // The concierge column is resizable AND the thread grows as it streams, so the ruler changes
    // under the reader. Guarded because jsdom does not implement ResizeObserver in every setup, and
    // a missing one must degrade to the prop rather than throw at mount.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** ONE ruler for both merging and the drag maths, with the same precedence in both places. */
  const railHeight = measuredHeight ?? railHeightPx;

  const bands = mergeMarks(marks, railHeight);

  // The drag listeners live on `document` and are attached once per drag, so they must not close
  // over the props of the render that started it — a reply streaming into the thread re-renders this
  // column several times a second, and a stale `onScrub` would write to a scroller that has since
  // been replaced. A ref refreshed every render is the same idiom QuoteChiclet uses for its dismiss
  // handler.
  const live = useRef({ onScrub, onScrubEnd, onPick, bands });
  useEffect(() => {
    live.current = { onScrub, onScrubEnd, onPick, bands };
  });

  /**
   * Where on the rail a pointer at `clientY` is.
   *
   * The measured rect wins when there IS one; `railHeightPx` covers the case where there is not.
   * That is not only a test accommodation — a rail inside a column that has not laid out yet
   * measures 0 in a real browser too, and dividing by it would put the handle at NaN.
   */
  const fractionFromClientY = (clientY: number): number => {
    const rect = railRef.current?.getBoundingClientRect();
    const height = rect?.height || railHeight;
    if (!rect || height <= 0) return 0;
    return clamp01((clientY - rect.top) / height);
  };

  useEffect(() => {
    if (!dragging) return;
    // `document`, NOT `window` and NOT the rail element. The pointer leaves a 26px-wide rail almost
    // immediately once a drag starts, so element-scoped listeners would drop the drag on the first
    // sideways pixel; AGENTS.md records a shipped bug from dispatching to the wrong target
    // (`no-cross-target-event-dispatch`).
    const onMove = (e: MouseEvent) => {
      // THE WHOLE POINT: every move scrolls. No debounce, no rAF batching of our own — the browser
      // already coalesces mousemove to one per frame, and adding a second buffer on top is how the
      // first cut of this rail ended up feeling like it "wasn't doing anything".
      live.current.onScrub?.(fractionFromClientY(e.clientY));
    };
    const onUp = (e: MouseEvent) => {
      // Primary button only, mirroring the press. A non-primary release must not END the drag —
      // a right-click during a real drag would otherwise silently finish it half-way.
      if (e.button !== 0) return;
      setDragging(false);
      // One last move, so the thread lands exactly where the pointer was released rather than at
      // wherever the previous coalesced mousemove happened to sit.
      live.current.onScrub?.(fractionFromClientY(e.clientY));
      live.current.onScrubEnd?.();
    };
    // BACKSTOP for the release that never arrives — a context menu that swallows the mouseup, a drag
    // that leaves the window, an OS-level gesture cancel. Without one the rail stays armed for the
    // rest of the session, after which every mouse move ANYWHERE in the app drags the handle.
    //
    // IT DOES NOT PUT THE THREAD BACK, and that is a change from the time rail. There, a cancelled
    // drag had committed nothing, so restoring the handle was the honest outcome. Here every move
    // has ALREADY scrolled the thread — the reader is looking at where they dragged to — so undoing
    // it would yank the transcript away from them on a context menu. Cancelling now means only "the
    // gesture is over".
    const onCancel = () => {
      setDragging(false);
      live.current.onScrubEnd?.();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("contextmenu", onCancel);
    window.addEventListener("blur", onCancel);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("contextmenu", onCancel);
      window.removeEventListener("blur", onCancel);
    };
    // `fractionFromClientY` is deliberately NOT a dependency. It is redefined every render, so
    // including it would tear down and re-attach the document listeners on every render — and a
    // reply streaming into the thread re-renders this column several times a second, which would
    // drop the drag mid-gesture. That is precisely what the `live` ref above exists to prevent:
    // the listeners are attached ONCE per drag and read the current values through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const onRailMouseDown = (e: React.MouseEvent) => {
    /* PRIMARY BUTTON ONLY (roborev 66386). Without this a right-click on the rail started a drag and
       scrolled the thread on release, moving it to somewhere the reader never asked for while they
       were trying to open a context menu. The worse half is that `preventDefault()` on mousedown
       does NOT suppress `contextmenu`: when the native menu takes the press, the matching `mouseup`
       can be swallowed, leaving `dragging === true` with live document listeners. */
    if (e.button !== 0) return;
    // Stops the press from starting a text selection that would drag-highlight the whole thread.
    // `data-control-gesture` on the root is the OTHER half of that (see CONTROL_GESTURE): this stops
    // the browser selecting, that stops the selection-driven features firing on the gesture.
    e.preventDefault();
    setDragging(true);
    // A press ANYWHERE on the track jumps there and starts scrubbing — the same contract a native
    // scrollbar track offers, and the reason the founder can grab the rail without hunting for the
    // handle first.
    onScrub?.(fractionFromClientY(e.clientY));
  };

  /**
   * ArrowUp / ArrowDown step to the previous / next prompt.
   *
   * Stepping by MARK rather than by a fixed fraction is the point: a percentage step lands between
   * prompts almost every time, and the founder is looking for a prompt, not an offset. These commit
   * through `onPick` because a keypress is not a continuous gesture — there is no hand to track.
   */
  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    /* HOME/END ARE PART OF THE ROLE, not an extra (roborev 66386). `role="slider"` promises them,
       and End→newest / Home→oldest is what the founder means by taking him "all the way back".
       Left/Right are accepted as aliases because a screen reader announcing a slider invites them,
       and a key the announced role implies must not be dead. */
    const KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!KEYS.includes(e.key)) return;
    const ordered = [...marks].sort((a, b) => a.fraction - b.fraction || a.index - b.index);
    if (ordered.length === 0) return;
    e.preventDefault();
    if (e.key === "Home" || e.key === "End") {
      onPick(e.key === "Home" ? ordered[0]! : ordered[ordered.length - 1]!);
      return;
    }
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
    const next = back
      ? [...ordered].reverse().find((m) => m.fraction < position - 1e-9)
      : ordered.find((m) => m.fraction > position + 1e-9);
    // Off either end, stay on the end mark rather than doing nothing: an unresponsive arrow key at
    // the top of the rail reads as a broken control.
    onPick(next ?? (back ? ordered[0]! : ordered[ordered.length - 1]!));
  };

  const activeBand = bands.find((b) => b.key === activeKey) ?? null;
  const handleLabel = scrubberHandleLabel(marks.length, scope, failed, moreAbove);

  return (
    <div
      data-testid={THREAD_SCRUBBER_TESTID}
      /* THE OPT-OUT (bead sparkle-bjbhw6, defect 4). A press anywhere in this gutter is a CONTROL
         gesture, so the selection-driven features — the copy affordance and the quote chiclet — must
         not read the drag as a text selection. Declared on the ROOT so every child inherits it by
         `closest()`, which is what makes this an opt-out a control sets on itself rather than a
         selector list the next control has to remember to join. */
      {...CONTROL_GESTURE}
      style={{
        // `flex: 0 0 auto` and full height: the rail is a fixed-width gutter beside the thread's
        // scroller, never a flexible column that steals width from the prose mid-drag.
        flex: "0 0 auto",
        alignSelf: "stretch",
        width: RAIL_WIDTH,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: SPACE.xs,
        paddingBottom: SPACE.xs,
        fontFamily: FONT_UI,
      }}
    >
      <ScopeMenu scope={scope} onScopeChange={onScopeChange} oldestMs={oldestMs} />

      <div
        ref={railRef}
        /* The measured element, named so a test can install a real height on THIS node rather than
           on every element (jsdom reports 0 for all of them). The ruler merging uses has to be
           drivable from a test or the measured-vs-prop divergence is untestable by construction. */
        data-scrubber-track="yes"
        onMouseDown={onRailMouseDown}
        style={{
          position: "relative",
          flex: "1 1 auto",
          width: RAIL_WIDTH,
          // `grab`, not `pointer`: this is a scroll control now, and the cursor is the cheapest
          // possible signal that it is draggable rather than clickable.
          cursor: dragging ? "grabbing" : "grab",
          // The rail is the positioned ancestor for the marks, the handle AND the hover card, which
          // is what lets the card be placed by the same fraction the mark uses.
          minHeight: 0,
        }}
      >
        {/* The track. A drawn hairline, per the design system's "structure is drawn, not filled".
            WHEN THE QUERY FAILED IT IS DASHED, and that is a SIGHTED signal on purpose (roborev
            66443). The first cut of `failed` changed only the handle's accessible name, so a founder
            looking at the column saw an identical empty rail — which is the exact misreading the
            flag exists to prevent, left in place for everyone not using a screen reader. */}
        <div
          aria-hidden
          data-scrubber-failed={failed ? "yes" : undefined}
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            top: 0,
            bottom: 0,
            width: TRACK_WIDTH,
            borderRadius: PILL,
            background: failed ? "transparent" : C.hairline,
            // LONGHANDS, not the `borderLeft` shorthand. `C.hairline` is a CSS custom-property
            // reference, and jsdom refuses to parse a shorthand containing one — it drops the whole
            // declaration, so `style.borderLeftStyle` read back as "" and the paint could not be
            // asserted at all (roborev 66451 asks for exactly that assertion).
            borderLeftStyle: failed ? "dashed" : undefined,
            borderLeftWidth: failed ? TRACK_WIDTH : undefined,
            borderLeftColor: failed ? C.hairline : undefined,
            opacity: failed ? 0.7 : 1,
          }}
        />

        {bands.map((band) => {
          const merged = band.marks.length > 1;
          // NAMED DECLARATIONS rather than inline arrows in the attribute list, and that is a
          // falsifiability decision rather than a style one. An inline arrow inside a JSX opening
          // tag is not a line a mutation check can rewrite — the mutant does not parse — so these
          // behaviours would have been unprovable BY CONSTRUCTION, reported as "could not be
          // judged", which is explicitly not a pass. `function` and not `const … =>` for the same
          // reason one level down: the checker's first strategy swaps `<`/`>`, and in a line whose
          // only such token is the arrow itself that turns `=>` into `=<` and breaks the file.
          function swallowPress(e: React.MouseEvent) { e.stopPropagation(); }
          function commit() { onPick(pickFromBand(band)); }
          function showCard() { setActiveKey(band.key); }
          function hideCard() { setActiveKey((k) => (k === band.key ? null : k)); }
          return (
            <button
              key={band.key}
              type="button"
              data-testid={`${THREAD_SCRUBBER_TESTID}-mark`}
              data-band-size={band.marks.length}
              aria-label={scrubberMarkLabel(band, now)}
              title={scrubberMarkLabel(band, now)}
              // The mark must not also start a rail drag, or a single click would both jump AND
              // scrub to wherever the press landed.
              onMouseDown={swallowPress}
              onClick={commit}
              onMouseEnter={showCard}
              onMouseLeave={hideCard}
              onFocus={showCard}
              onBlur={hideCard}
              style={{
                position: "absolute",
                top: `${band.fraction * 100}%`,
                left: "50%",
                transform: "translate(-50%, -50%)",
                // A LINE, not a dot — see MARK_WIDTH. A merged band is WIDER and TALLER and
                // brighter, never round: size alone is a 1px difference on a dark track, readable
                // when two lines sit side by side and invisible when one does not.
                width: merged ? BAND_WIDTH : MARK_WIDTH,
                height: merged ? BAND_HEIGHT : MARK_HEIGHT,
                padding: 0,
                border: "none",
                borderRadius: 0,
                background: merged ? C.accentInk : C.pillFill,
                cursor: "pointer",
              }}
            />
          );
        })}

        {/* The handle. `role="slider"` because that is what it is; the arrow keys above are the
            behaviour the role promises, not decoration. */}
        <div
          role="slider"
          /* WITHOUT THIS THE ROLE LIES (roborev 66386). ARIA's default orientation is HORIZONTAL, so
             assistive tech announced a horizontal slider on a rail that runs down the column — and
             the user reaches for Left/Right, which the handler used to return early on. */
          aria-orientation="vertical"
          data-testid={`${THREAD_SCRUBBER_TESTID}-handle`}
          /* THE GRABBED STATE, asserted by tests rather than inferred from a style read: jsdom
             cannot tell you a handle "looks fatter", but it can tell you this attribute flipped. */
          data-grabbed={dragging ? "yes" : "no"}
          tabIndex={0}
          aria-label={handleLabel}
          /* The SAME string as the accessible name. The marks carry both an aria-label and a title;
             the handle carried only the former, so the one state that needs explaining was the one
             state a mouse user could not reach (roborev 66443). */
          title={handleLabel}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={clamp01(position)}
          onKeyDown={onHandleKeyDown}
          style={{
            position: "absolute",
            top: `${clamp01(position) * 100}%`,
            left: "50%",
            transform: "translate(-50%, -50%)",
            // THE GRAB ANSWERS (bead sparkle-bjbhw6, defect 8/9). *"When I click on the little white
            // slider, it should become fatter. And it should become like a draggable element that
            // has rows."* At rest it is a hairline; grabbed it becomes the app's own drag grip.
            width: dragging ? HANDLE_GRAB_WIDTH : HANDLE_REST_WIDTH,
            height: dragging ? HANDLE_GRAB_HEIGHT : HANDLE_REST_HEIGHT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: dragging ? RADIUS.sm : PILL,
            background: C.cream,
            opacity: dragging ? 1 : 0.75,
            cursor: dragging ? "grabbing" : "grab",
            // Fast enough to read as the control ANSWERING the press rather than animating at the
            // reader. Only the box changes; the position is written every frame by the drag and must
            // never be transitioned or the handle would lag the hand it is supposed to track.
            transition: "width 90ms ease, height 90ms ease",
          }}
        >
          {/* THE GRIP — three columns by two rows, which is the app's existing drag grip TURNED 90
              DEGREES. His words: *"just like we have the drag to expand column rows... but I want it
              to be three columns and two — so I want it to be flipped 90 degrees from the drag
              sliders."* The dot metrics are imported from `ColumnPullTab`, not restated, so the two
              grips cannot drift into two vocabularies. */}
          {dragging && <RailGrip />}
        </div>

        {activeBand ? <HoverCard band={activeBand} now={now} /> : null}
      </div>
    </div>
  );
}

/**
 * The 3x2 dot field inside a grabbed handle.
 *
 * SQUARE dots, 3px, 2px apart — `ColumnPullTab`'s own metrics, imported rather than restated. The
 * squareness was the founder's earlier call (*"a little bit more square than those round dots"*) and
 * a second grip vocabulary in the same shell is exactly the drift this import prevents.
 *
 * `pointerEvents: none` because the field is inside the element that owns the drag: letting it take
 * events would swallow every mousedown over the only visible part of the control.
 */
function RailGrip(): JSX.Element {
  return (
    <span
      aria-hidden
      data-testid={`${THREAD_SCRUBBER_TESTID}-grip`}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(3, ${RAIL_GRIP_DOT}px)`,
        gap: RAIL_GRIP_DOT_GAP,
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          style={{
            width: RAIL_GRIP_DOT,
            height: RAIL_GRIP_DOT,
            borderRadius: 0,
            background: C.conciergeSurfaceLifted,
          }}
        />
      ))}
    </span>
  );
}

/**
 * The scope control: a visible token plus a chevron, with a real `<select>` invisible on top.
 *
 * ── WHY THE SELECT IS OVERLAID RATHER THAN STYLED ──────────────────────────────────────────────
 * Two founder complaints meet on this one control and a plain styled `<select>` cannot satisfy both.
 *
 *   *"I think there should be, like, a little down arrow to the right of the 3d, to make it obvious
 *    that I can change that time period."* — but a native chevron cannot be positioned, and
 *   `appearance: none` (which the previous version used) removes it entirely. Drawing our own means
 *   drawing the value too, because the two have to sit beside each other.
 *
 *   *"After I select it, it still has a little, like, select outline around it. It shouldn't have
 *    that."* — that is the macOS WebKit UA focus ring, which persists because the select keeps DOM
 *    focus after the picker closes. An invisible select cannot show one.
 *
 * And it is what lets the MENU say more than the closed control does: a native select's closed state
 * prints the selected option's own text, so "All — since Aug 12" in the list would also have to fit
 * in the gutter. Overlaid, the list is as wide as it likes and the chip stays a token.
 *
 * THE RING IS NOT DROPPED, it moves. `.scrubber-scope-select:focus-visible + .scrubber-scope-chip`
 * in index.css draws it on the chip — so a keyboard user still sees where focus is, and a mouse user
 * who has just picked a value sees nothing. That is exactly the tradeoff index.css already argues
 * for on `.nudge-card-quiet`: hover-or-focus alone would leave a focusable control invisible, which
 * is worse than either extreme. An inline style cannot express `:focus-visible`, which is why this
 * is a class at all.
 */
function ScopeMenu({
  scope,
  onScopeChange,
  oldestMs,
}: {
  scope: ScrubberScope;
  onScopeChange: (s: ScrubberScope) => void;
  oldestMs: number | null;
}): JSX.Element {
  // Said in full on the control itself, so the extent is reachable on hover and by assistive tech
  // even while the closed chip shows only the token.
  const title =
    oldestMs === null
      ? SCRUBBER_SCOPE_LABEL
      : `${SCRUBBER_SCOPE_LABEL} — history goes back to ${scopeMenuLabel("all", oldestMs).replace("All — since ", "")}`;
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: RAIL_WIDTH }}>
      <select
        className="scrubber-scope-select"
        aria-label={SCRUBBER_SCOPE_LABEL}
        title={title}
        value={scope}
        onChange={(e) => onScopeChange(e.target.value as ScrubberScope)}
        style={{
          // FILLS THE CHIP AND IS INVISIBLE. Not `display: none` and not `visibility: hidden` —
          // both would take it out of the accessibility tree and off the tab order, which would
          // leave the rail's only settable value unreachable by keyboard.
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          margin: 0,
          padding: 0,
          border: "none",
          cursor: "pointer",
        }}
      >
        {SCRUBBER_SCOPES.map((s) => (
          <option key={s} value={s}>
            {scopeMenuLabel(s, oldestMs)}
          </option>
        ))}
      </select>
      {/* THE SIBLING THE RING LANDS ON — it must come AFTER the select for the `+` combinator in
          index.css to reach it. `aria-hidden` because the select above already carries the name and
          the value; announcing this text again would read the control out twice. */}
      <span
        className="scrubber-scope-chip"
        aria-hidden
        data-testid={`${THREAD_SCRUBBER_TESTID}-scope`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 1,
          color: C.muted,
          fontSize: TYPE.micro,
          fontWeight: WEIGHT.med,
          lineHeight: 1,
          borderRadius: RADIUS.sm,
          padding: "1px 1px",
          pointerEvents: "none",
        }}
      >
        {SCOPE_LABEL[scope]}
        {/* THE CHEVRON the founder asked for. Drawn as an SVG rather than as a text character, so it
            is the same size in every font fallback: a down-pointing triangle CHARACTER renders at
            wildly different weights across the fallback chain, and at 6px that is the difference
            between a chevron and a smudge. (It is also what `glyphIcons.test.ts` requires — that
            ratchet counts glyph-as-icon sites tree-wide and it counts them in COMMENTS too, so even
            naming the character here raised the count. Which is the rule working: the ceiling is a
            budget, and this file has no claim on it.) */}
        <svg width="7" height="4" viewBox="0 0 7 4" aria-hidden focusable="false">
          <path d="M0.5 0.5 L3.5 3.5 L6.5 0.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

/**
 * The card, positioned to the LEFT of the rail.
 *
 * `right: 100%` rather than a computed x: the rail is the right-most thing in the column, so a card
 * drawn to its right would hang off the window edge. Growing leftward into the thread's own width is
 * the only direction with room.
 */
function HoverCard({ band, now }: { band: MarkBand; now: number }): JSX.Element {
  const first = band.marks[0]!;
  const newest = band.marks[band.marks.length - 1]!;
  const many = band.marks.length > 1;
  // A statement pair rather than a multi-line ternary, for the same falsifiability reason as the
  // handlers above: a mutation check can only judge a line it can rewrite on its own.
  let heading = `Prompt ${first.index}: ${first.textPrefix}`;
  if (many) heading = `Prompts ${first.index}–${newest.index} · ${band.marks.length} prompts`;

  return (
    <div
      data-testid={`${THREAD_SCRUBBER_TESTID}-card`}
      role="tooltip"
      style={{
        position: "absolute",
        right: "100%",
        marginRight: SPACE.xs,
        top: `${band.fraction * 100}%`,
        transform: "translateY(-50%)",
        width: 240,
        // Not interactive, and the pointer is on its way to a mark 6px away — swallowing hover here
        // would flicker the card off as the mouse crossed it.
        pointerEvents: "none",
        background: C.conciergeSurfaceLifted,
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.input,
        padding: `${SPACE.xs}px ${SPACE.sm}px`,
        fontSize: TYPE.small,
        color: C.cream,
        lineHeight: 1.35,
        zIndex: 2,
      }}
    >
      <div style={{ fontWeight: WEIGHT.med }}>{heading}</div>
      {many ? <div style={{ marginTop: 2 }}>{newest.textPrefix}</div> : null}
      {/* The age is omitted rather than guessed when the store has not answered for this bubble yet
          — a live prompt sent ten seconds ago has a rendered row before it has a history row, and
          "just now" would be a claim this component cannot support. */}
      {newest.createdAt !== undefined && (
        <div style={{ marginTop: 2, color: C.muted, fontSize: TYPE.micro }}>
          {ageLabel(newest.createdAt, now)} by {SCRUBBER_AUTHOR}
        </div>
      )}
    </div>
  );
}
