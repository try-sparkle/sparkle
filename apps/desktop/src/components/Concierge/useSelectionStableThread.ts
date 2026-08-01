// GUARD 4: THE TRANSCRIPT'S STRUCTURE HOLDS STILL WHILE THE READER IS DRAGGING OUT A SELECTION.
//
// THE FOUNDER'S REPORT, verbatim: "When I try to copy blocks of text that I've written in Sparkle,
// it's very hard. The starting point where I start my mouse to drag often gets reset."
//
// ── WHY THE EXISTING GUARDS DO NOT COVER THIS ─────────────────────────────────────────────────────
// Two guards already defend a live drag, and both are real fixes for causes that are NOT this one:
//
//   • `useCopyOnSelection`'s `dragging` flag suppresses the keyboard debounce, so no clipboard write
//     fires mid-gesture and `copyToClipboard`'s execCommand fallback never tears the live selection
//     down with removeAllRanges/addRange under a held button.
//   • `useAutoFollow`'s `selectingRef` (guard 3) stops the follow writing `scrollTop` mid-drag, so
//     the container is not yanked to the bottom underneath the reader.
//
// Both stop something moving the VIEWPORT or the SELECTION OBJECT. Neither stops the DOCUMENT from
// reflowing, and that is the hole. `ConciergeHost` rebuilds nudge and digest messages from scratch on
// every feed tick (`agentToNudge` returns a fresh object literal; digests are fresh literals), and
// `engine/conciergeStreamOrder` deliberately interleaves them by ARRIVAL — so an alert card sits in
// the MIDDLE of the conversation, not at the bottom. Its own header says the resting state of a busy
// fleet is "unrelated agents entering and leaving `needs_you` constantly".
//
// Every one of those entrances and exits inserts or removes a card BETWEEN the reader's two
// endpoints, and a removal is measured in card-heights. The reader is holding the mouse at a fixed
// SCREEN position; the content under it slides up or down by that height; the browser goes on
// extending the highlight from whatever is now beneath the pointer. Nothing reset the anchor — the
// text moved out from under it, which looks identical and is what the founder is describing.
//
// Memoisation cannot fix this and it is worth being precise about why, because the previous attempt
// stopped there. `ConciergeMessageRow` is memoised and `ConciergeThread.inert.test.tsx` pins it, but
// a memo only elides re-renders of entries whose props did not change. These entries genuinely DID
// change — an agent really did leave `needs_you` — so the reflow is correct rendering of a real
// event, and no amount of inertness prevents it. It has to be DEFERRED instead.
//
// ── WHAT THIS DOES ────────────────────────────────────────────────────────────────────────────────
// While a selection is actually being dragged out inside the thread, it renders the SAME message ids
// in the SAME order they had when the gesture began:
//
//   • an id that has since disappeared keeps its last-known object, so nothing is pulled out from
//     under the pointer;
//   • an id that is NEW since the gesture began is withheld, because arrival order can place it
//     mid-thread and an insertion reflows exactly like a removal;
//   • only a `sparkle` entry is refreshed to its newest object — see REFRESHING, below.
//
// On release the held list is dropped and the live array renders, so the thread catches up in one
// step. Deferred, never cancelled — the same contract guard 3 states.
//
// ── WHAT ARMS THE HOLD: THIS GESTURE, NOT MERELY THIS MOMENT (roborev 57320-M2, 57339-M2/M3) ──────
// Two wrong answers were tried before this one, and the failures are worth keeping because they pull
// in opposite directions.
//
//   • "The primary button is down" — too wide. It armed for every press-and-hold in the app, and
//     several are long: a `ColumnPullTab` resize, a terminal drag in column two, a scrollbar drag.
//     For the whole of one the concierge withheld arriving `needs_you` alerts — a delay on the app's
//     ALERTING surface bought for a gesture that was never a transcript selection.
//   • "A non-collapsed selection reaches the thread RIGHT NOW" — wrong in BOTH directions at once.
//     Too narrow, because it left the press→first-drag window unguarded, and that window is exactly
//     where the founder's symptom lives: a tick between the press and the first extension moves the
//     card above the press point, so the drag that follows extends from an anchor no longer where he
//     pressed. And too wide, because a highlight LEFT IN THE TRANSCRIPT is the normal resting state
//     of this column — copy-on-selection is built around it — so any later press whose handler calls
//     `preventDefault()` (ColumnPullTab does) never collapses it, and the stale highlight armed the
//     hold for that unrelated gesture all over again.
//
// So the question is whether THIS GESTURE is plausibly a thread selection, asked two ways:
//
//   1. THE PRESS LANDED IN THE THREAD — armed from the press, which covers the window above.
//   2. …or the press landed elsewhere but a selection has CHANGED since it and now reaches in.
//      That is the compose-box→transcript drag `useCopyOnSelection` documents. Requiring the change
//      is what distinguishes a selection this gesture is making from one left lying around.
//
// Note (2) is scoped by `selectionWithin`, so a terminal drag in column two changes the selection but
// does not reach this container and never arms.
//
// A CORRECTION TO AN EARLIER VERSION OF THIS COMMENT, because it argued the opposite: it claimed a
// target test could not work since `ColumnPullTab` renders inside `[data-concierge-root]`. True, but
// irrelevant — this hook is handed the THREAD SCROLL CONTAINER, not the concierge root, and the pull
// tab is not inside the scroller. `container.contains(target)` excludes it.
//
// ── REFRESHING: `sparkle` ONLY (roborev 57320-M2) ─────────────────────────────────────────────────
// The first version refreshed EVERY still-present id to its newest object, justified as "text
// changing inside a node the reader is not anchored in moves nothing above it". That is wrong in the
// direction that matters: the pointer sits at the FOCUS end, usually BELOW the anchor, so an entry
// earlier in the thread that changes HEIGHT pushes everything below it — including the text under the
// pointer. And these entries do change height: `agentToNudge` rebuilds `text` from `a.statusLabel`
// every tick, and `actionsFor` adds a whole "Approve" row when the agent hits an approval prompt.
//
// So status-derived kinds (`nudge`, `digest`, `recap`) are held at their snapshot object for the
// length of the gesture, and only `sparkle` is refreshed. That is exactly the case the refresh exists
// for — the streaming reply, which the store grows by replacing that one object — and it is safe
// because a SETTLED sparkle entry keeps its identity anyway (`conciergeThreadStore` upserts in place;
// see ConciergeThread.inert.test.tsx), so this refreshes the streaming bubble and nothing else.
//
// ── RELEASING: A NATIVE DRAG EATS THE MOUSEUP (roborev 57320-H1) ──────────────────────────────────
// `AgentSidebar` marks its agent cards `draggable`. That gesture opens with a primary `mousedown`,
// and once the browser enters an HTML5 drag it stops dispatching `mousemove`/`mouseup` altogether,
// ending in `dragend`. A `mouseup`-only release therefore never fires, and the drop lands in the same
// window so `blur` is not guaranteed either — leaving the transcript frozen indefinitely, which this
// file's own scope note calls far worse than the bug it fixes. Hence four releases: `mouseup`,
// `dragstart`/`dragend`, `blur`, and a `mousemove` that finds no button held.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ConciergeMessage } from "./types";
import { selectionWithin } from "./useCopyOnSelection";

/** What `useSelectionStableThread` remembers for the length of one gesture. */
interface Held {
  /** The id order as it stood when the hold began. */
  ids: string[];
  /** The newest object seen for each of those ids, so a vanished one can still be drawn. */
  byId: Map<string, ConciergeMessage>;
}

/**
 * The messages to RENDER: `messages` itself at rest, or a structurally-frozen view of it while the
 * reader is dragging out a selection inside `containerRef`.
 *
 * Pure with respect to `messages` — it never mutates the array it is given, and at rest it returns
 * the very same reference, so the memoised rows downstream are unaffected when no gesture is in
 * flight.
 *
 * @param containerRef the thread's scroll container — the same node `useCopyOnSelection` watches.
 */
export function useSelectionStableThread(
  messages: ConciergeMessage[],
  containerRef: RefObject<HTMLElement | null>,
): ConciergeMessage[] {
  /** Is the primary button down? A REF, not state: the press itself must not re-render the thread —
   *  that would put a render on every click anywhere in the app, for a hold that usually never
   *  becomes observable. The render we do need is the one on RELEASE, and only when we actually
   *  held something (see `release`). */
  const dragging = useRef(false);
  /** The frozen structure, or null when nothing is being held. */
  const held = useRef<Held | null>(null);
  /** Did this gesture ever actually change what was rendered? Only then is a catch-up render owed. */
  const didHold = useRef(false);
  /**
   * WHAT THE READER IS CURRENTLY LOOKING AT — the list as of the last render.
   *
   * The snapshot has to come from here rather than from the incoming `messages`, and the difference
   * is the whole fix. By the time a held render happens the feed tick has ALREADY been handed in, so
   * snapshotting `messages` there freezes the post-change list and holds nothing: the card the reader
   * was dragging across is gone from the very structure meant to preserve it.
   */
  const onScreen = useRef(messages);
  /** Did the press that opened this gesture land inside the thread? Arms the hold on its own — see
   *  WHAT ARMS THE HOLD (1) — so the press→first-drag window is covered. */
  const pressInside = useRef(false);
  /** Has the selection CHANGED since the press? Distinguishes a selection this gesture is making
   *  from one left lying in the transcript by an earlier copy — see WHAT ARMS THE HOLD (2). */
  const selChanged = useRef(false);
  /** Bumped once on release to force the catch-up render. The value is never read. */
  const [, setFlush] = useState(0);

  const release = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    held.current = null;
    if (!didHold.current) return;
    didHold.current = false;
    setFlush((n) => n + 1);
  }, []);

  useEffect(() => {
    // Primary button only — a right-click opens a context menu over a selection the reader means to
    // keep, and a secondary press is not the start of a drag.
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // NOT re-armed if a gesture is somehow already open. Resetting `didHold` under a live hold is
      // how the recovery click became lossy: it would clear the "a catch-up is owed" flag, so the
      // release that followed scheduled no render and the column only corrected on the next
      // incidental one (roborev 57320-H1, secondary).
      if (dragging.current) return;
      dragging.current = true;
      held.current = null;
      didHold.current = false;
      // Recorded HERE because the target is only knowable from the event. A press in the thread arms
      // the hold by itself; anything else has to wait for a selection that reaches in.
      const container = containerRef.current;
      const target = e.target;
      pressInside.current = !!container && target instanceof Node && container.contains(target);
      selChanged.current = false;
    };
    // Only ever used to answer "has the selection moved since the press", so it does no work of its
    // own — the reading of WHAT the selection is happens at render time.
    const onSelectionChange = () => {
      if (dragging.current) selChanged.current = true;
    };
    // A MOVE WITH NO BUTTON HELD MEANS THE RELEASE WAS EATEN. Cheap — it early-returns on the first
    // ref read for every move outside a gesture — and it is the backstop that covers any path that
    // swallows `mouseup`, not just the drag one below.
    const move = (e: MouseEvent) => {
      if (dragging.current && e.buttons === 0) release();
    };
    // BOTH ENDS ON THE DOCUMENT, symmetrically, for the reasons the sibling guards spell out: a drag
    // that overshoots the thread (which is how you select through to the end of a message) releases
    // somewhere else entirely, and a container-bound listener would latch this on for the rest of the
    // session — freezing the transcript permanently, which is far worse than the bug it fixes.
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", release);
    document.addEventListener("mousemove", move);
    document.addEventListener("selectionchange", onSelectionChange);
    // THE NATIVE-DRAG PAIR — see this file's header. A `draggable` card elsewhere in the app turns a
    // primary press into an HTML5 drag, which dispatches neither `mousemove` nor `mouseup`.
    document.addEventListener("dragstart", release);
    document.addEventListener("dragend", release);
    // Losing the window ends the gesture as far as this column is concerned.
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", release);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("dragstart", release);
      document.removeEventListener("dragend", release);
      window.removeEventListener("blur", release);
      // Unmounting mid-gesture must not leave the flags set for the next mount.
      dragging.current = false;
      held.current = null;
      didHold.current = false;
      pressInside.current = false;
      selChanged.current = false;
    };
    // `containerRef` is a ref OBJECT, stable for the life of the hook — listed because the press
    // handler reads it, not because it varies (the same note `useAutoFollow` carries).
  }, [release, containerRef]);

  /** Is THIS GESTURE plausibly a selection being dragged out of the thread? See WHAT ARMS THE HOLD
   *  in the header for why it is asked two ways rather than one. */
  const selecting = (): boolean => {
    if (!dragging.current) return false;
    // (1) The press landed in the thread — enough on its own, and the only answer that covers the
    // window between the press and the first extension.
    if (pressInside.current) return true;
    // (2) A press elsewhere only counts once THIS gesture has moved the selection and it reaches in
    // — the compose-box→transcript drag. Without the `selChanged` term a highlight left over from an
    // earlier copy would arm this for any unrelated press-and-hold.
    if (!selChanged.current) return false;
    const container = containerRef.current;
    if (!container) return false;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    // Reuses the clamp `useCopyOnSelection` already applies, so "reaches into the thread" means
    // exactly the same thing to both guards and the two cannot drift apart.
    return selectionWithin(sel, container).length > 0;
  };

  if (!selecting()) {
    // NOT HOLDING — so drop the snapshot UNCONDITIONALLY (roborev 57339-M1).
    //
    // Keeping it while the button was still down was a bug in the other direction: a gesture whose
    // selection momentarily collapsed rendered live here, and when it re-expanded the stale snapshot
    // was still non-null, so the re-snapshot below was skipped and the thread JUMPED BACK to the
    // older structure — re-inserting cards that had just gone and dropping ones that had just
    // arrived. That is a reflow under a held pointer, which is the whole thing this guard exists to
    // prevent. Clearing here makes the next holding render re-snapshot from `onScreen`, which is
    // what the reader can actually see.
    held.current = null;
    onScreen.current = messages;
    return messages;
  }

  // FIRST HELD RENDER OF THIS GESTURE — freeze what the reader can currently see.
  if (held.current === null) {
    const current = onScreen.current;
    held.current = {
      ids: current.map((m) => m.id),
      byId: new Map(current.map((m) => [m.id, m])),
    };
  }
  const snapshot = held.current;
  const live = new Map(messages.map((m) => [m.id, m]));
  const out = snapshot.ids.map((id) => {
    const next = live.get(id);
    // `sparkle` ONLY — the streaming reply. Every other kind is held at its snapshot object, because
    // a status-derived card can change HEIGHT in place and reflow the column exactly like an
    // insertion. See REFRESHING in this file's header.
    if (next !== undefined && next.kind === "sparkle") snapshot.byId.set(id, next);
    return snapshot.byId.get(id)!;
  });
  // HAS THE LIVE ARRAY DIVERGED FROM WHAT WE ARE SHOWING? One positional comparison catches all three
  // shapes at once, and the third is the one a membership test misses: a card REMOVED, a card
  // INSERTED, and a card RE-SLOTTED by `orderByArrival` after an absence longer than its window —
  // same ids, same count, different order. A moved DOM node reflows the column exactly like an
  // inserted one, so holding membership without holding order would leave the bug half-fixed.
  const changed =
    messages.length !== snapshot.ids.length ||
    snapshot.ids.some((id, i) => messages[i]?.id !== id) ||
    // An in-place object swap on a held kind is a hold too — the reader is being shown the older
    // object, so a catch-up render is owed on release.
    snapshot.ids.some((id, i) => out[i] !== messages[i]);
  if (changed) didHold.current = true;
  const rendered = changed ? out : messages;
  // What is now on screen — so a later snapshot inside the same gesture freezes the held view rather
  // than the live array it is deliberately diverging from.
  onScreen.current = rendered;
  return rendered;
}
