/**
 * THE TWO LINEAGE ROWS — `Tasks:` and `Build agents:` — drawn ONCE, for every card surface.
 *
 * ══ THE SHAPE, IN THE FOUNDER'S WORDS (2026-08-22) ═════════════════════════════════════════
 * *"Maybe I see something at the bottom of the preview card that says tasks colon, and then it
 * gives me one row of insight into that… it might have the name of each task as a pill, it might
 * say plus three more. Now it'll all be on one row."* And the second row: *"if it's in active build
 * mode… then do we have on the closed preview another row that says builders, maybe, or build
 * agents? Because I think we're calling it build agents in the build column."* — hence
 * `Build agents:`, his explicit word, NOT "builders".
 *
 * ══ FOUR RULES THAT ARE EASY TO GET SUBTLY WRONG ═══════════════════════════════════════════
 * 1. NEVER WRAPS. Each row is exactly one line; the remainder becomes a trailing "+N more".
 * 2. "+N more" EXPANDS THE CARD. It is a second path to the same result as clicking the card body,
 *    NOT a popover: *"maybe the plus seven more is clickable, when I click on it, it would expand
 *    the card."*
 * 3. AN EMPTY ROW IS NOT DRAWN AT ALL — no bare `Tasks:` label with nothing after it. A leaf card
 *    costs zero extra height, which matters because leaves are the majority.
 * 4. EXPANDING DOES NOT EXPLODE THE LINEAGE. These same two rows render collapsed AND expanded:
 *    *"if I click to expand the card, I think I would still see those same fidelity of information…
 *    it would still just show me two rows."* Expansion adds the REST OF THE CARD, not more lineage.
 *    So this component takes no `collapsed` prop — there is nothing for it to branch on.
 *
 * ══ PHRASING CONTENT ONLY — `<span>`, NEVER `<div>` ════════════════════════════════════════
 * `BeadCard`'s concierge chrome mounts inside `<Markdown>`'s `<p>`, where a `<div>` is invalid
 * nesting that the parser "resolves" by reparenting the node out of the sentence that referenced
 * it. Every box here is a `<span>` with an explicit `display`.
 *
 * ══ WHERE THE OVERFLOW RULE IS TESTED, AND WHY NOT HERE ════════════════════════════════════
 * jsdom NEVER LAYS OUT: every `offsetWidth`/`clientWidth` reads 0 and no `ResizeObserver` ever
 * fires (`docs/jsdom-test-caveats.md`). So a test in this file cannot observe "as many as fit".
 * That is not a gap: the DECISION is a pure function, `packPills` in `engine/beadLineage.ts`,
 * tested there against exact numbers including the founder's own "two pills, then +N more" case.
 * What THIS file's tests assert is everything jsdom CAN see — which rows exist, what they read,
 * what a click does, and that an UNMEASURED row shows everything (see the fail-open note in
 * `usePacking`, a rule jsdom exercises for free on every render). Do not "fix" the absent overflow
 * test here by mocking layout; assert it in the engine.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { C } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { packPills, type LineagePill } from "../../engine/beadLineage";

/** Gap between items on a lineage row, px. Also the gap charged by the packer. */
const GAP = 6;

export interface BeadLineageRowsProps {
  /** Chrome-prefixed testid stem, e.g. `concierge-bead-card`. */
  testId: string;
  /** The `Tasks:` row. Empty renders no row. */
  tasks: readonly LineagePill[];
  /** The `Build agents:` row. Empty renders no row — which is also how "not in active build" is
   *  expressed, since {@link inActiveBuild} is defined as "there is an agent to show". */
  buildAgents: readonly LineagePill[];
  /**
   * Expand the whole card. Wired to "+N more" per the founder's second-affordance rule. When a
   * surface cannot expand (a static fixture), pass nothing and the overflow renders as plain text
   * rather than a control that does nothing — the callback-is-the-switch convention `BeadCard`
   * uses for every other affordance.
   */
  onExpand?: () => void;
  /** Jump to a task's bead. Absent renders the pills as static text. */
  onOpenBead?: (beadId: string) => void;
  /**
   * Jump to a build agent — *"clicking one jumps to that agent, the same affordance the concierge
   * uses in chat"*. Mirrors `Concierge/AgentPill`'s reveal, which is addressed BY PROJECT.
   */
  onOpenAgent?: (agent: { agentId: string; projectId?: string }) => void;
}

/**
 * Measure one row and decide how much of it to draw.
 *
 * Returns the whole list until the first layout pass lands, so the row is never briefly EMPTY —
 * a flash of nothing is worse than a flash of too much, and `overflow: hidden` clips the excess
 * for the one frame it exists.
 */
function usePacking(pills: readonly LineagePill[]): {
  rowRef: React.RefObject<HTMLSpanElement | null>;
  moreRef: React.RefObject<HTMLSpanElement | null>;
  itemsRef: React.MutableRefObject<(HTMLSpanElement | null)[]>;
  shown: number;
  overflow: number;
} {
  const count = pills.length;
  const rowRef = useRef<HTMLSpanElement | null>(null);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  const itemsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const [packed, setPacked] = useState({ shown: count, overflow: 0 });

  // ══ THE WIDTH CACHE, AND WHY THE ROW OSCILLATES WITHOUT IT ═════════════════════════════════
  // Only the SHOWN pills are in the DOM. So the moment a pack hides some, their elements are gone
  // and a naive re-measure reads their width as 0 — which makes the packer conclude everything
  // fits, render them all, measure again, pack them away again, for ever. That is not a slow
  // convergence: it is a permanent flicker, and it fires on the very first ResizeObserver callback.
  //
  // Keyed by ID **AND LABEL**, not by index and not by id alone.
  //
  //   • Not by INDEX, because the same row re-renders with different beads as the store polls; an
  //     index-keyed cache would hand pill 3's width to whatever bead later lands in slot 3.
  //   • Not by ID ALONE, because the width is a function of the LABEL, and ids are stable across
  //     polls precisely while titles are not. A retitled bead or a renamed agent would otherwise
  //     keep the width it had under its old label FOR EVER — nothing re-triggers a measurement for
  //     it, and while it is hidden there is no element to correct the entry either. The next resize
  //     would then pack a long-titled pill using its old short width and show it, producing exactly
  //     the clipped row this cache exists to prevent.
  //
  // Entries are only ever written from a real measurement, so a hidden pill keeps the width it had
  // when it was last visible.
  const widthCache = useRef(new Map<string, number>());
  /** True while the single shown pill is being allowed to shrink — see the cache write below. */
  const shrinkRef = useRef(false);

  // The memo/effect key. It carries the LABELS too, so a same-length list with different content —
  // a child closed and another opened between polls, the common case — re-runs the measurement.
  // Keying on `count` alone left that swap completely unobserved: the row's border box does not
  // change, so the ResizeObserver cannot cover it either.
  const pillsKey = pills.map((p) => `${p.id}\u0001${p.label}`).join("\u0000");

  const remeasure = useCallback(() => {
    const row = rowRef.current;
    if (row === null || count === 0) return;

    const keys = pillsKey.length === 0 ? [] : pillsKey.split("\u0000");
    const cache = widthCache.current;
    for (let i = 0; i < keys.length; i++) {
      const el = itemsRef.current[i];
      const key = keys[i];
      if (el === null || el === undefined || key === undefined) continue;
      // A rendered element reporting 0 is an unmeasured frame, not a zero-width pill — never let it
      // overwrite a good reading.
      const w = el.offsetWidth;
      if (w <= 0) continue;
      // ══ THE SHRINK GUARD IS PER-PILL, AND UNCONDITIONAL ═══════════════════════════════════
      // A pill in shrink mode is `flex: 1 1 auto` — grow AND shrink — so its `offsetWidth` is
      // neither its natural width nor a clipped one: it is exactly the row's LEFTOVER SPACE. Feed
      // that back through `packPills` and k=1 always fits while k=2 never does, so the row is
      // pinned at one pill BY CONSTRUCTION, using a number nobody measured.
      //
      // This used to carry an `&& cache.has(key)` escape hatch, on the reasoning that an unknown
      // key must never be starved of a reading. That reasoning is obsolete: the `anyUnmeasured`
      // branch above now fails the whole row OPEN on any uncached key, which mounts every pill at
      // its natural width and lets the follow-up effect measure it honestly. Keeping the hatch was
      // strictly worse — a sole shrunk pill relabelled SHORTER got the row-filling width cached as
      // if it were natural, after which neither `anyUnmeasured` nor `needsMeasure` fired again and
      // the row stayed pinned at one pill across every later poll.
      if (shrinkRef.current && i === 0) continue;
      cache.set(key, w);
    }
    // Drop entries for pills no longer on this row, so the cache cannot grow without bound as the
    // store polls.
    if (cache.size > keys.length * 2) {
      const live = new Set(keys);
      for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);
    }

    const widths = keys.map((k) => cache.get(k) ?? 0);

    // The label is a sibling INSIDE the row, so the space a pill may occupy is what remains after
    // it. `clientWidth` (not `offsetWidth`) so a scrollbar or border never counts as usable.
    const label = row.firstElementChild;
    const labelW = label instanceof HTMLElement ? label.offsetWidth + GAP : 0;
    const available = row.clientWidth - labelW;

    // ══ AN UNMEASURED ROW FAILS OPEN ══════════════════════════════════════════════════════════
    // A width of 0 does not mean "no space", it means WE DID NOT GET A READING — a display:none
    // ancestor, a collapsed flex parent, a pre-layout frame, or a test environment that never lays
    // out. Packing against it would clip the row to a single pill and hide the rest behind a
    // "+N more" that nothing ever measured, which is the "report a default as if it were an
    // answer" defect: the card would LOOK correct while withholding the names it exists to show.
    // Showing everything is the honest degradation — worst case it overflows a box we cannot see.
    //
    // THE SAME RULE COVERS A ROW WHOSE PILLS HAVE NO MEASUREMENT YET, for the same reason: with no
    // widths there is no basis to hide anything.
    // ══ ANY UNMEASURED PILL FAILS THE WHOLE ROW OPEN ═══════════════════════════════════════
    // Not just an all-zero row. A 0 for ONE pill is not a narrow pill, it is a pill we have never
    // seen — and `packPills` cannot tell the difference: it adds the 0, concludes the pill fits,
    // and shows it at a width nobody measured. That is how an all-new list (every id changed on a
    // poll) and a freshly-inserted pill both ended up over-packed and clipped.
    //
    // Showing everything is the honest degradation, and it CONVERGES rather than sticking: with
    // `shown === count` every pill is mounted, the follow-up effect below re-measures, every key
    // lands in the cache, and the next pass packs for real. One extra frame, no flicker.
    // NOT INDEPENDENTLY PINNED, and that is stated rather than papered over: with the follow-up
    // measurement below in place, the SETTLED row is identical with or without this branch, so no
    // jsdom test can catch its removal (mutating it leaves the suite green — checked). What it
    // removes is one FRAME in which pills render at widths nobody measured, which in a real browser
    // is a visible flash of an over-packed row. It is kept as a frame-level guard, not as a
    // correctness claim.
    const anyUnmeasured = keys.some((k) => !cache.has(k));
    if (available <= 0 || anyUnmeasured) {
      setPacked((prev) =>
        prev.shown === count && prev.overflow === 0 ? prev : { shown: count, overflow: 0 },
      );
      return;
    }

    // ONE conservative width for "+N more", measured at the widest count this row can produce
    // (`count - 1`). Charging the widest candidate can only ever show FEWER pills than a per-count
    // measurement would — never more — so the row cannot be made to wrap, which is the single
    // thing rule 1 above forbids. A per-count measurement would need a hidden span per candidate.
    const moreW = moreRef.current?.offsetWidth ?? 0;

    const next = packPills(widths, available, () => moreW, GAP);
    setPacked((prev) =>
      prev.shown === next.shown && prev.overflow === next.overflow ? prev : next,
    );
  }, [count, pillsKey]);

  useLayoutEffect(() => {
    remeasure();
    const row = rowRef.current;
    // The concierge column is resizable and the board reflows, so the answer changes without any
    // prop changing. jsdom defines no ResizeObserver in some configs — degrade to the one-shot
    // measurement above rather than throwing.
    if (row === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(remeasure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [remeasure]);

  // ══ A PILL SHOWN FOR THE FIRST TIME MUST BE MEASURED ═══════════════════════════════════════
  // Growing `shown` schedules nothing on its own: `remeasure` re-runs only when `pillsKey` changes
  // or the ResizeObserver fires. So when a poll inserts a pill at exactly the first hidden slot, it
  // has no cache entry, `packPills` is handed a 0 and treats it as fitting, `shown` grows past what
  // actually fits — and the row then sits over-packed and clipped, its "+N more" possibly eaten,
  // until some unrelated resize happens. The same hole made the all-zero fail-open a ONE-WAY DOOR:
  // it renders everything but never re-measures the row it just made measurable.
  //
  // This runs AFTER paint-layout for the render that first mounted those pills, so their elements
  // exist and `remeasure` gets real widths. It cannot loop: it fires only while some SHOWN pill is
  // missing from the cache, and one `remeasure` writes every shown pill's width.
  const keysNow = pillsKey.length === 0 ? [] : pillsKey.split("\u0000");
  const needsMeasure = keysNow.some((k, i) => i < packed.shown && !widthCache.current.has(k));
  // NO DEPENDENCY ARRAY, deliberately. `needsMeasure` is a BOOLEAN, and the two renders that matter
  // here both have it `true`: the one that mounted a single pill against an all-new list, and the
  // one that then fails open and mounts every pill. React only re-runs an effect when a dep
  // CHANGES, so keying on it deadlocked the row at "show everything" — the exact over-packed state
  // this is meant to resolve. Running every render and self-guarding is what converges: the guard
  // goes false the moment a measurement lands, so this is one extra pass, not a loop.
  useLayoutEffect(() => {
    if (needsMeasure) remeasure();
  });

  // Widened with `soleShrink` above. A sole pill is `0 1 auto`, so its `offsetWidth` is its natural
  // width ONLY while it happens to fit — and nothing here can tell those apart. So a sole pill's
  // reading is never cached. That is safe rather than lossy: an uncached key makes `anyUnmeasured`
  // true, which fails the row open at `shown === count`, and for a one-pill row that IS the answer.
  shrinkRef.current = packed.shown === 1;

  return { rowRef, moreRef, itemsRef, ...packed };
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: GAP,
  minWidth: 0,
  // NEVER WRAPS (rule 1). `hidden` is the backstop for the single pre-measurement frame.
  flexWrap: "nowrap",
  overflow: "hidden",
  fontFamily: FONT_UI,
  fontSize: TYPE.small,
};

const labelStyle: React.CSSProperties = {
  flex: "0 0 auto",
  color: C.conciergeMuted,
  whiteSpace: "nowrap",
};

function pillStyle(interactive: boolean, ink: string, shrink: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    // ══ `0 0 auto` — A PILL MUST NEVER SHRINK, OR THE MEASUREMENT IS A LIE ═══════════════════
    // The row is `nowrap` with `overflow: hidden`, so with the default shrink factor every pill
    // squeezes down when the set is too wide — and the measure pass renders the WHOLE set. The
    // packer would then read the SHRUNK widths, conclude far more pills fit than really do, and
    // ship a row that is either clipped or ellipsised down to nothing. `offsetWidth` has to be the
    // pill's natural width for `packPills` to mean anything.
    //
    // The one-frame overflow this allows is exactly what the row's `overflow: hidden` is for.
    //
    // THE ONE EXCEPTION — a SOLE pill that already overflows. `maxWidth: 100%` resolves against the
    // whole row, so it does not account for the label sitting to its left: a single long task title
    // then ran past the card's edge and its "+N more" was clipped away with it, which is a row that
    // shows neither the name nor the way to see the rest. Measured in the capture. When the packer
    // has already decided only one pill fits, that pill is allowed to SHRINK and ellipsise into
    // whatever the label and the overflow count leave. Multi-pill rows never shrink, so the widths
    // the packer reasons about stay natural.
    // `0 1 auto` — MAY SHRINK, MUST NOT GROW. `1 1 auto` would stretch a SHORT sole pill across the
    // whole row, which reads as a text field rather than a chip. Shrinking is the whole point;
    // growing was never asked for.
    flex: shrink ? "0 1 auto" : "0 0 auto",
    minWidth: 0,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    background: "transparent",
    border: `1px solid ${C.hairline}`,
    borderRadius: RADIUS.input,
    color: ink,
    padding: "1px 7px",
    fontFamily: FONT_UI,
    fontSize: TYPE.small,
    lineHeight: 1.5,
    cursor: interactive ? "pointer" : "default",
  };
}

function LineageRow({
  testId,
  label,
  pills,
  ink,
  onOpen,
  onExpand,
}: {
  testId: string;
  label: string;
  pills: readonly LineagePill[];
  ink: string;
  onOpen?: (pill: LineagePill) => void;
  onExpand?: () => void;
}) {
  const { rowRef, moreRef, itemsRef, shown, overflow } = usePacking(pills);

  // Rule 3: an empty row is not drawn at all — not even its label.
  if (pills.length === 0) return null;

  // Only when the packer has ALREADY concluded one pill is all that fits. In every other state the
  // pills must report natural widths or `packPills` is reasoning about a layout that only exists
  // while it measures.
  // ══ A SOLE PILL MAY ALWAYS GIVE GROUND ═════════════════════════════════════════════════════
  // Not `shown === 1 && overflow > 0`. With exactly ONE pill in the row, `packPills` returns
  // `overflow: 0` — there is nothing to overflow INTO — so that guard was never satisfied for the
  // one case that needs it most: a single task whose title is wider than the row. The pill stayed
  // `0 0 auto`, the row's `overflow: hidden` hard-clipped it mid-character, and there was no
  // ellipsis and no "+N more" to say anything had been cut. (VADE, PR #2436.)
  const soleShrink = shown === 1;

  const moreLabel = (n: number) => `+${n} more`;

  return (
    <span ref={rowRef} data-testid={testId} style={rowStyle}>
      <span style={labelStyle}>{label}</span>

      {pills.slice(0, shown).map((p, i) => (
        <span
          key={p.id}
          ref={(el) => {
            itemsRef.current[i] = el;
          }}
          data-testid={`${testId}-pill`}
          data-pill-id={p.id}
          title={p.label}
          role={onOpen === undefined ? undefined : "button"}
          tabIndex={onOpen === undefined ? undefined : 0}
          onClick={
            onOpen === undefined
              ? undefined
              : (e) => {
                  // THE CARD BODY IS THE EXPAND TARGET, so every interactive child must stop the
                  // click from ALSO toggling it. Without this, opening a task collapses the card
                  // you opened it from, in the same gesture.
                  e.stopPropagation();
                  onOpen(p);
                }
          }
          onKeyDown={
            onOpen === undefined
              ? undefined
              : (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  onOpen(p);
                }
          }
          style={pillStyle(onOpen !== undefined, ink, soleShrink)}
        >
          {p.label}
        </span>
      ))}

      {overflow > 0 && (
        <span
          data-testid={`${testId}-more`}
          role={onExpand === undefined ? undefined : "button"}
          tabIndex={onExpand === undefined ? undefined : 0}
          onClick={
            onExpand === undefined
              ? undefined
              : (e) => {
                  // Deliberately NOT stopped from reaching the card in spirit — but it must not
                  // fire twice. Expanding is what a card-body click does too, so stopping the
                  // bubble and calling `onExpand` directly keeps ONE expansion per gesture.
                  e.stopPropagation();
                  onExpand();
                }
          }
          onKeyDown={
            onExpand === undefined
              ? undefined
              : (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  onExpand();
                }
          }
          style={{
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            color: C.conciergeMuted,
            cursor: onExpand === undefined ? "default" : "pointer",
            textDecoration: onExpand === undefined ? "none" : "underline",
          }}
        >
          {moreLabel(overflow)}
        </span>
      )}

      {/* THE MEASURING TWIN. Off-flow and aria-hidden, it exists only so `usePacking` can charge
          the real width of the widest "+N more" this row could produce. Rendering it inside the row
          keeps it in the same font and box as the thing it stands for; `position: absolute` keeps
          it out of the layout it is measuring. */}
      <span
        ref={moreRef}
        aria-hidden
        style={{
          position: "absolute",
          visibility: "hidden",
          pointerEvents: "none",
          whiteSpace: "nowrap",
          fontFamily: FONT_UI,
          fontSize: TYPE.small,
        }}
      >
        {moreLabel(Math.max(1, pills.length - 1))}
      </span>
    </span>
  );
}

/**
 * Both rows, in order: tasks then build agents.
 *
 * ABOVE THE COMMENTS, which the founder restated so it would not be lost, and comments are
 * newest-first. That ordering is `BeadCard`'s to honour — this component simply renders where it
 * is mounted.
 */
export function BeadLineageRows({
  testId,
  tasks,
  buildAgents,
  onExpand,
  onOpenBead,
  onOpenAgent,
}: BeadLineageRowsProps) {
  if (tasks.length === 0 && buildAgents.length === 0) return null;

  return (
    <span
      data-testid={`${testId}-lineage`}
      style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, position: "relative" }}
    >
      <LineageRow
        testId={`${testId}-tasks`}
        label="Tasks:"
        pills={tasks}
        ink={C.cream}
        onOpen={onOpenBead === undefined ? undefined : (p) => onOpenBead(p.id)}
        onExpand={onExpand}
      />
      <LineageRow
        testId={`${testId}-build-agents`}
        label="Build agents:"
        pills={buildAgents}
        ink={C.tealInk}
        onOpen={
          onOpenAgent === undefined
            ? undefined
            : (p) => onOpenAgent({ agentId: p.id, projectId: p.projectId })
        }
        onExpand={onExpand}
      />
    </span>
  );
}
