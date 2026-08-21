// The thread scrubber: a thin vertical rail down the RIGHT of the concierge thread, a dot per
// prompt the founder sent, a draggable handle, and a hover card telling him what a dot was.
//
// His words for what it is FOR (PRD/sparkle/thread-scrubber-and-retention.md, verbatim at the
// bottom of that doc): *"to be able to really quickly scroll up and down in the chat window by just
// using the slider to find a prompt from a while ago."* Everything below serves that one sentence —
// which is why the committed action is `onPick(marker)` carrying a message id, and not a scroll
// offset: the rail does not know how tall the thread is and must never pretend to.
//
// ── PRESENTATIONAL, AND DELIBERATELY SO ─────────────────────────────────────────────────────────
// This component holds no store, reads no clock and fetches nothing. `markers`, `scope`, `now` and
// `position` all arrive as props and every outcome leaves as a callback. The half that owns the
// thread wires it up. Two consequences worth stating because they look like omissions:
//
//   • `now` IS A REQUIRED PROP, not a `Date.now()` default. It is COUPLED to the marker timestamps —
//     a dot's position is a function of both — so a test that could control only one of the two
//     could not tell this rail apart from a broken one. That is AGENTS.md's "a defaulted seam every
//     test injects" (bead sparkle-lgbwf) applied before it could happen rather than after.
//   • `railHeightPx` IS A PROP with a default. jsdom lays nothing out, so `getBoundingClientRect`
//     reads 0 for the rail's height; a rail that could only learn its height from a ref would
//     cluster nothing and draw its dots at NaN under every test that ever renders it. The measured
//     rect is preferred at runtime and this prop is the fallback — see `fractionFromClientY`.
//
// ── VISUAL REGISTER: CALM AT REST ───────────────────────────────────────────────────────────────
// The founder's standing rule for the concierge header is "no words at all", and the rail is
// narrower than the header. So: a 3px track, 5px dots, a hairline handle, and a scope control that
// is a native <select> styled down to the bare token ("1h", "2w") rather than a form widget. Native
// because it is the accessible default and gets the platform's own picker for free on a control
// with thirteen options; styled down because a chunky select at the top of a 16px rail would be the
// loudest thing in the column.
// `JSX` is imported as a TYPE rather than reached for as a global: React 19 stopped publishing the
// global `JSX` namespace, so the frozen contract's `JSX.Element` return type has to come from the
// package now.
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

import { C } from "../../theme/colors";
import { FONT_UI, PILL, RADIUS, SPACE, TYPE, WEIGHT } from "../../theme/scale";
import {
  ageLabel,
  clusterMarkers,
  fractionFor,
  nearestCluster,
  nearestMarker,
  SCOPE_LABEL,
  SCOPE_PHRASE,
  SCRUBBER_SCOPES,
  scopeWindow,
  timeAt,
  type DotCluster,
  type ScrubberMarker,
  type ScrubberScope,
} from "./scrubberGeometry";

export const THREAD_SCRUBBER_TESTID = "concierge-thread-scrubber";
export const SCRUBBER_SCOPE_LABEL = "Scrubber time scope";

/**
 * The hover card's byline author.
 *
 * A CONSTANT, not a marker field, because of what a dot means: the founder decided the rail plots
 * *"his prompts only"* (spec, "The founder's decisions"). Every dot is therefore his by
 * construction, and a per-marker author field would be a column that is the same value in every
 * row. If the rail ever plots someone else's turns this becomes a `ScrubberMarker` field — and that
 * change should be forced to touch the contract, rather than being possible by accident.
 */
export const SCRUBBER_AUTHOR = "DROdio";

/** The rail's own width. Wide enough for a fat cluster dot plus the handle's overhang; no wider. */
const RAIL_WIDTH = 16;
/** Exported so the paint tests assert the SAME number the rail draws, not a restated literal. */
export const TRACK_WIDTH = 3;
const DOT = 5;
const CLUSTER_DOT = 8;

export interface ThreadScrubberProps {
  markers: ScrubberMarker[];
  scope: ScrubberScope;
  onScopeChange: (s: ScrubberScope) => void;
  /** INJECTED CLOCK — see the header on why this is required rather than defaulted. */
  now: number;
  /** Measured rail height in px; the fallback when the DOM cannot be measured. */
  railHeightPx?: number;
  /** The handle's current position, 0..1 (0 = oldest/top). Controlled. */
  position: number;
  /** Live during a drag — fires on every move with the fraction and the nearest marker. */
  onSeek?: (fraction: number, nearest: ScrubberMarker | null) => void;
  /** COMMITTED — a click on a dot, or the mouseup ending a drag. THIS is what scrolls the thread. */
  onPick: (marker: ScrubberMarker) => void;
  /** The history query REJECTED, as opposed to returning nothing.
   *
   *  Signalled THREE ways, because a rejection and a quiet week otherwise look identical and the
   *  reader has no other way to tell them apart: the track is drawn DASHED (the sighted signal, and
   *  the one the founder actually sees), the handle's accessible name says so (see
   *  {@link scrubberHandleLabel}), and the handle carries the same string as a `title` so it is
   *  reachable on hover without assistive tech. */
  failed?: boolean;
}

/**
 * The handle's accessible name, which doubles as the EMPTY STATE.
 *
 * An empty rail with no explanation reads as a bug — the spec says so directly, and it is the exact
 * failure the whole sequencing of this feature exists to avoid. There is no room on a 16px rail for
 * a visible message, so the note rides the one element that always exists and always has a name.
 */
export function scrubberHandleLabel(
  count: number,
  scope: ScrubberScope,
  failed = false,
): string {
  const window = SCOPE_PHRASE[scope];
  // A REJECTED QUERY IS NOT AN EMPTY ONE, and the rail is the only thing that can tell the reader
  // which it is looking at (roborev 66429). Both produce zero dots, so without this line a broken
  // bridge reads as a quiet week — and for four commits of this branch it WAS a broken bridge.
  if (failed) return `Thread scrubber — could not read your history for the last ${window}`;
  if (count === 0) return `Thread scrubber — no prompts in the last ${window}`;
  return `Thread scrubber — ${count} ${count === 1 ? "prompt" : "prompts"} in the last ${window}`;
}

/** A dot's own accessible name and tooltip. Short: the full text lives in the hover card. */
export function scrubberDotLabel(cluster: DotCluster, now: number): string {
  const first = cluster.markers[0]!;
  const last = cluster.markers[cluster.markers.length - 1]!;
  if (cluster.markers.length === 1) return `Prompt ${first.index}, ${ageLabel(first.createdAt, now)}`;
  return `Prompts ${first.index}–${last.index}, ${cluster.markers.length} prompts`;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function ThreadScrubber({
  markers,
  scope,
  onScopeChange,
  now,
  railHeightPx = 320,
  position,
  onSeek,
  onPick,
  failed = false,
}: ThreadScrubberProps): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** The rail fraction a drag began at, so a CANCELLED drag can put the handle back. */
  const dragStart = useRef<number | null>(null);
  /** The cluster whose card is showing — hover OR keyboard focus, so the card is not mouse-only. */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  /**
   * The rail's ACTUAL height, once it has laid out.
   *
   * WHY THIS EXISTS AT ALL (roborev 66386). Clustering merges dots closer than a PIXEL gap, so it
   * needs the ruler the reader is actually looking at. Measuring only on the drag path — which is
   * what `fractionFromClientY` did, and what this file's header claimed for the whole component —
   * meant clustering ran against the 320px DEFAULT forever for any consumer that let the rail size
   * itself. On a 900px column the 6px merge gap then behaves like ~17 real pixels and distinct
   * prompts silently collapse into one fat dot; on a short rail the inverse, dots overlapping
   * without merging. Both are the loss of history this module exists to prevent.
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
      // height — adopting it would divide every dot's position by zero.
      setMeasuredHeight(h > 0 ? h : null);
    };
    read();
    // The concierge column is resizable, so the ruler changes under the reader. Guarded because
    // jsdom does not implement ResizeObserver in every setup, and a missing one must degrade to the
    // prop rather than throw at mount.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** ONE ruler for both clustering and the drag maths, with the same precedence in both places. */
  const railHeight = measuredHeight ?? railHeightPx;

  const win = scopeWindow(now, scope);
  const clusters = clusterMarkers(markers, win, railHeight);
  const inWindowCount = clusters.reduce((n, c) => n + c.markers.length, 0);

  // The drag listeners live on `document` and are attached once per drag, so they must not close
  // over the props of the render that started it — a reply streaming into the thread re-renders
  // this column several times a second, and a stale `markers` would commit the wrong prompt. A ref
  // refreshed every render is the same idiom QuoteChiclet uses for its dismiss handler.
  const live = useRef({ markers, win, railHeight, onSeek, onPick, clusters });
  useEffect(() => {
    live.current = { markers, win, railHeight, onSeek, onPick, clusters };
  });

  /**
   * Where on the rail a pointer at `clientY` is.
   *
   * The measured rect wins when there IS one; `railHeightPx` covers the case where there is not.
   * That is not only a test accommodation — a rail inside a column that has not laid out yet
   * measures 0 in a real browser too, and dividing by it would put every dot at NaN.
   */
  const fractionFromClientY = (clientY: number): number => {
    const rect = railRef.current?.getBoundingClientRect();
    const height = rect?.height || live.current.railHeight;
    if (!rect || height <= 0) return 0;
    return clamp01((clientY - rect.top) / height);
  };

  useEffect(() => {
    if (!dragging) return;
    // `document`, NOT `window` and NOT the rail element. The pointer leaves a 16px-wide rail almost
    // immediately once a drag starts, so element-scoped listeners would drop the drag on the first
    // sideways pixel; AGENTS.md records a shipped bug from dispatching to the wrong target
    // (`no-cross-target-event-dispatch`).
    const onMove = (e: MouseEvent) => {
      const f = fractionFromClientY(e.clientY);
      const l = live.current;
      l.onSeek?.(f, nearestMarker(f, l.markers, l.win));
    };
    const onUp = (e: MouseEvent) => {
      // Primary button only, mirroring the press. A non-primary release must not COMMIT a jump —
      // and must not clear `dragging` either, or a right-click during a real drag would silently
      // end it half-way.
      if (e.button !== 0) return;
      setDragging(false);
      dragStart.current = null;
      const f = fractionFromClientY(e.clientY);
      const l = live.current;
      // THROUGH THE DOT, not through the raw markers (roborev 66465). What the reader released the
      // handle over is a DOT, and a fat one can span days; committing `nearestMarker` over the raw
      // list meant a drag onto a dot could jump somewhere other than a CLICK on that same dot, and
      // other than the prompt its hover card had just named. Resolving to the cluster and applying
      // the cluster's own rule makes the two paths identical by construction.
      const cluster = nearestCluster(f, l.clusters);
      const picked = cluster ? pickFromCluster(cluster) : null;
      // No commit when the window is empty. `onPick` means "scroll the thread to this bubble", and
      // there is no bubble — releasing the handle over an empty rail must be a no-op, not a jump to
      // wherever the thread happens to be sitting.
      if (picked) l.onPick(picked);
    };
    // BACKSTOP for the release that never arrives — a context menu that swallows the mouseup, a
    // drag that leaves the window, an OS-level gesture cancel. Without one the rail stays armed for
    // the rest of the session. These only DISARM; they never commit a pick, because a cancelled
    // gesture is not a choice the reader made.
    // …and PUT THE HANDLE BACK. `position` is controlled and the parent has been moving it on every
    // `onSeek` of the drag, while only `onPick` scrolls the thread — so simply clearing `dragging`
    // left the handle parked at a mid-drag fraction pointing at a prompt the thread was never
    // showing, with no signal the parent could use to restore it (roborev 66397). Re-emitting the
    // fraction the drag STARTED from is that signal, and it is deliberately `onSeek` and not
    // `onPick`: a cancelled gesture is not a choice, so nothing may scroll.
    const onCancel = () => {
      setDragging(false);
      const l = live.current;
      const from = dragStart.current;
      if (from !== null) l.onSeek?.(from, nearestMarker(from, l.markers, l.win));
      dragStart.current = null;
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
  }, [dragging]);

  const onRailMouseDown = (e: React.MouseEvent) => {
    /* PRIMARY BUTTON ONLY (roborev 66386). Without this a right-click on the rail started a drag
       and committed an `onPick` on release, scrolling the thread to a prompt the reader never asked
       for while they were trying to open a context menu. The worse half is that `preventDefault()`
       on mousedown does NOT suppress `contextmenu`: when the native menu takes the press, the
       matching `mouseup` can be swallowed, leaving `dragging === true` with live document
       listeners — after which every mouse move ANYWHERE in the app drags the handle and the next
       click anywhere commits a jump. */
    if (e.button !== 0) return;
    // Stops the press from starting a text selection that would drag-highlight the whole thread.
    e.preventDefault();
    // Remembered BEFORE the first seek moves it — this is where a cancelled drag returns to.
    dragStart.current = position;
    setDragging(true);
    const f = fractionFromClientY(e.clientY);
    onSeek?.(f, nearestMarker(f, markers, win));
  };

  /**
   * ArrowUp / ArrowDown step to the previous / next prompt.
   *
   * Stepping by MARKER rather than by a fixed fraction is the point: at `1y` scope a percentage
   * step lands between dots almost every time, and the founder is looking for a prompt, not a
   * timestamp. `onSeek` fires first so a controlled parent can move the handle, then `onPick`
   * commits — the same order a drag produces, so the parent needs one code path rather than two.
   */
  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    /* HOME/END ARE PART OF THE ROLE, not an extra (roborev 66386). `role="slider"` promises them,
       and End→oldest is the founder's own sentence for what the rail is for: "if it has one week at
       the top of the slider, it takes me all the way back to one week ago". Left/Right are accepted
       as aliases because a screen reader announcing a slider invites them, and a key the announced
       role implies must not be dead. */
    const KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (!KEYS.includes(e.key)) return;
    const ordered = markers
      .filter((m) => m.createdAt >= win.fromMs && m.createdAt <= win.toMs)
      .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
    if (ordered.length === 0) return;
    e.preventDefault();
    // Home = the TOP of the rail = the OLDEST in-window prompt, because the rail's axis runs oldest
    // at the top (fraction 0) to newest at the bottom. End is its mirror.
    if (e.key === "Home" || e.key === "End") {
      const edge = e.key === "Home" ? ordered[0]! : ordered[ordered.length - 1]!;
      onSeek?.(fractionFor(edge.createdAt, win), edge);
      onPick(edge);
      return;
    }
    const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
    const next = back
      ? [...ordered].reverse().find((m) => fractionFor(m.createdAt, win) < position - 1e-9)
      : ordered.find((m) => fractionFor(m.createdAt, win) > position + 1e-9);
    // Off either end, stay on the end dot rather than doing nothing: an unresponsive arrow key at
    // the top of the rail reads as a broken control.
    const target = next ?? (back ? ordered[0]! : ordered[ordered.length - 1]!);
    onSeek?.(fractionFor(target.createdAt, win), target);
    onPick(target);
  };

  const activeCluster = clusters.find((c) => c.key === activeKey) ?? null;

  return (
    <div
      data-testid={THREAD_SCRUBBER_TESTID}
      style={{
        // `flex: 0 0 auto` and full height: the rail is a fixed-width gutter beside the thread's
        // scroller, never a flexible column that steals width from the prose.
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
      <select
        aria-label={SCRUBBER_SCOPE_LABEL}
        value={scope}
        onChange={(e) => onScopeChange(e.target.value as ScrubberScope)}
        style={{
          // Styled all the way down to a bare token. `appearance: none` removes the platform
          // chevron, which at this width would be most of the control.
          appearance: "none",
          WebkitAppearance: "none",
          background: "transparent",
          border: "none",
          color: C.muted,
          font: "inherit",
          fontSize: TYPE.micro,
          fontWeight: WEIGHT.med,
          textAlign: "center",
          padding: 0,
          width: RAIL_WIDTH,
          cursor: "pointer",
          borderRadius: RADIUS.sm,
        }}
      >
        {SCRUBBER_SCOPES.map((s) => (
          <option key={s} value={s}>
            {SCOPE_LABEL[s]}
          </option>
        ))}
      </select>

      <div
        ref={railRef}
        /* The measured element, named so a test can install a real height on THIS node rather than
           on every element (jsdom reports 0 for all of them). The ruler clustering uses has to be
           drivable from a test or the measured-vs-prop divergence is untestable by construction. */
        data-scrubber-track="yes"
        onMouseDown={onRailMouseDown}
        style={{
          position: "relative",
          flex: "1 1 auto",
          width: RAIL_WIDTH,
          cursor: "pointer",
          // The rail is the positioned ancestor for the dots, the handle AND the hover card, which
          // is what lets the card be placed by the same fraction the dot uses.
          minHeight: 0,
        }}
      >
        {/* The track. A drawn hairline, per the design system's "structure is drawn, not filled".
            WHEN THE QUERY FAILED IT IS DASHED, and that is a SIGHTED signal on purpose (roborev
            66443). The first cut of `failed` changed only the handle's accessible name, so a
            founder looking at the column saw an identical empty rail — which is the exact
            misreading the flag exists to prevent, left in place for everyone not using a screen
            reader. Dashed rather than tinted: the rail carries no other dashes, so it reads as
            "this is not a normal empty" without adding a colour the palette has to justify. */}
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
            // asserted at all (roborev 66451 asks for exactly that assertion). The longhands are
            // stored verbatim, so the dashed track is both real and testable.
            borderLeftStyle: failed ? "dashed" : undefined,
            borderLeftWidth: failed ? TRACK_WIDTH : undefined,
            borderLeftColor: failed ? C.hairline : undefined,
            opacity: failed ? 0.7 : 1,
          }}
        />

        {clusters.map((cluster) => {
          const fat = cluster.markers.length > 1;
          const size = fat ? CLUSTER_DOT : DOT;
          // NAMED DECLARATIONS rather than inline arrows in the attribute list, and that is a
          // falsifiability decision rather than a style one. An inline arrow inside a JSX opening
          // tag is not a line a mutation check can rewrite — the mutant does not parse — so four of
          // this component's behaviours would have been unprovable BY CONSTRUCTION, reported as
          // "could not be judged", which is explicitly not a pass. `function` and not `const … =>`
          // for the same reason one level down: the checker's first strategy swaps `<`/`>`, and in
          // a line whose only such token is the arrow itself that turns `=>` into `=<` and breaks
          // the file, so the site goes unjudged again. These forms cost nothing and stay checkable.
          function swallowPress(e: React.MouseEvent) { e.stopPropagation(); }
          function commit() { onPick(pickFromCluster(cluster)); }
          function showCard() { setActiveKey(cluster.key); }
          function hideCard() { setActiveKey((k) => (k === cluster.key ? null : k)); }
          return (
            <button
              key={cluster.key}
              type="button"
              data-testid={`${THREAD_SCRUBBER_TESTID}-dot`}
              data-cluster-size={cluster.markers.length}
              aria-label={scrubberDotLabel(cluster, now)}
              title={scrubberDotLabel(cluster, now)}
              // The dot must not also start a rail drag, or a single click would commit twice —
              // once as this click and once as the mouseup ending a zero-distance drag.
              onMouseDown={swallowPress}
              onClick={commit}
              onMouseEnter={showCard}
              onMouseLeave={hideCard}
              onFocus={showCard}
              onBlur={hideCard}
              style={{
                position: "absolute",
                top: `${cluster.fraction * 100}%`,
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: size,
                height: size,
                padding: 0,
                border: "none",
                borderRadius: PILL,
                // A cluster is BRIGHTER as well as fatter. Size alone is a 3px difference on a dark
                // track — readable when two dots sit side by side, invisible when one does not.
                background: fat ? C.accentInk : C.pillFill,
                cursor: "pointer",
              }}
            />
          );
        })}

        {/* The handle. `role="slider"` because that is what it is; the arrow keys below are the
            behaviour the role promises, not decoration. */}
        <div
          role="slider"
          /* WITHOUT THIS THE ROLE LIES (roborev 66386). ARIA's default orientation is HORIZONTAL,
             so assistive tech announced a horizontal slider on a rail that runs down the column —
             and the user reaches for Left/Right, which the handler used to return early on. */
          aria-orientation="vertical"
          data-testid={`${THREAD_SCRUBBER_TESTID}-handle`}
          tabIndex={0}
          aria-label={scrubberHandleLabel(inWindowCount, scope, failed)}
          /* The SAME string as the accessible name. The dots carry both an aria-label and a title;
             the handle carried only the former, so the one state that needs explaining was the one
             state a mouse user could not reach (roborev 66443). */
          title={scrubberHandleLabel(inWindowCount, scope, failed)}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={clamp01(position)}
          aria-valuetext={ageLabel(timeAt(position, win), now)}
          onKeyDown={onHandleKeyDown}
          style={{
            position: "absolute",
            top: `${clamp01(position) * 100}%`,
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: RAIL_WIDTH - 2,
            height: 2,
            borderRadius: PILL,
            background: C.cream,
            opacity: dragging ? 1 : 0.75,
            cursor: "grab",
          }}
        />

        {activeCluster ? <HoverCard cluster={activeCluster} now={now} /> : null}
      </div>
    </div>
  );
}

/**
 * Which prompt a click on a FAT dot jumps to: the newest one in it.
 *
 * Because that is the one the card he just read showed him. The card prints the newest member's
 * text (see `HoverCard`), so jumping anywhere else would land him somewhere other than the words on
 * screen — the single most confusing thing a navigation control can do.
 */
export function pickFromCluster(cluster: DotCluster): ScrubberMarker {
  return cluster.markers[cluster.markers.length - 1]!;
}

/**
 * The card, positioned to the LEFT of the rail.
 *
 * `right: 100%` rather than a computed x: the rail is the right-most thing in the column, so a card
 * drawn to its right would hang off the window edge. Growing leftward into the thread's own width
 * is the only direction with room.
 */
function HoverCard({ cluster, now }: { cluster: DotCluster; now: number }): JSX.Element {
  const first = cluster.markers[0]!;
  const newest = cluster.markers[cluster.markers.length - 1]!;
  const many = cluster.markers.length > 1;
  // A statement pair rather than a multi-line ternary, for the same falsifiability reason as the
  // handlers above: a mutation check can only judge a line it can rewrite on its own.
  let heading = `Prompt ${first.index}: ${first.textPrefix}`;
  if (many) heading = `Prompts ${first.index}–${newest.index} · ${cluster.markers.length} prompts`;

  return (
    <div
      data-testid={`${THREAD_SCRUBBER_TESTID}-card`}
      role="tooltip"
      style={{
        position: "absolute",
        right: "100%",
        marginRight: SPACE.xs,
        top: `${cluster.fraction * 100}%`,
        transform: "translateY(-50%)",
        width: 240,
        // Not interactive, and the pointer is on its way to a dot 6px away — swallowing hover here
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
      <div style={{ marginTop: 2, color: C.muted, fontSize: TYPE.micro }}>
        {ageLabel(newest.createdAt, now)} by {SCRUBBER_AUTHOR}
      </div>
    </div>
  );
}
