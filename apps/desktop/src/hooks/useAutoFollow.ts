// useAutoFollow — stick a scroller to its newest content WITHOUT stealing the reader's position.
//
// EXTRACTED FROM ConciergeThread, UNCHANGED, so a second thread can have it (the mounted-agent
// transcript view). The rules below were each paid for with a founder-visible bug, and the comments
// are kept verbatim from the original because they are the record of what NOT to try again.
// `ConciergeThread.autofollow.test.tsx` still drives this through that component, so it is the
// regression guard on the extraction as well as on the behaviour.
//
// The contract in one line: NEW CONTENT never moves the reader; only reaching the bottom, or the
// reader's own submit, re-arms the follow.
import { useCallback, useEffect, useRef } from "react";

/** How close to the bottom still counts as "following", measured when the READER scrolls.
 *
 *  Small on purpose. The old 150px slack existed because the measurement happened after layout and
 *  had to cover one just-appended message; nothing is unlaid-out at scroll time, so the only slack
 *  needed is for rounding. At 150px a reader who scrolled up a line to re-read it still counted as
 *  "following" and got yanked back on the next feed tick — the founder's original complaint, at
 *  small amplitude. Not smaller than this, though: macOS rubber-band settling and fractional
 *  clientHeight/scrollHeight under non-integral zoom can leave a genuinely-bottomed container a few
 *  px off, and each such miss silently costs the reader the follow. Both sides are tested. */
export const FOLLOW_THRESHOLD_PX = 24;

/** How close to the TOP counts as "the reader wants older content". Generous where the bottom
 *  threshold is tight, because the two failures are not symmetric: missing a follow silently strands
 *  the reader below the fold, whereas fetching a page early costs one bounded read they were about
 *  to ask for anyway. */
const TOP_TRIGGER_PX = 120;

export interface AutoFollowOptions {
  /** A string that changes whenever the RENDERED CONTENT changes — not the array identity.
   *
   *  Callers fold in everything that should re-run the follow: message count, last id, total text
   *  length, and any "is something streaming" flag. Keying on identity instead is bead sparkle-y4ft:
   *  the host rebuilds the array on every feed tick, so clicking anything scrolled the column. */
  contentKey: string;
  /** Changing this RE-ARMS the follow. The reader's own submit is the one event besides reaching the
   *  bottom that means "show me what happens next". Pass the newest user-authored message id; pass a
   *  constant to disable. Never pass a boolean "a user message exists" — that re-arms on every tick
   *  and restores sparkle-y4ft in full. */
  rearmKey: string;
  /** Called when the reader scrolls near the TOP, for backwards paging. Safe to be called
   *  repeatedly — implement the in-flight/exhausted guard in the loader, not here. */
  onReachTop?: () => void;
  /** An EXISTING ref for the scroller, when the caller already has one.
   *
   *  `ConciergeThread` does: `useCopyOnSelection` takes the same node, and two refs on one element
   *  would mean one of them is always null. Omit it and the hook owns the ref, which is what the
   *  mounted-agent thread does. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface AutoFollow {
  /** Attach to the scrolling element. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach as its `onScroll`. */
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Measure the scroller's current height, to be restored after PREPENDING older content. Returns
   *  the value to hand back to {@link restoreAfterPrepend}. */
  measureBeforePrepend: () => number;
  /** Put the reader back where they were after older content was prepended above them. Without this
   *  a backwards page yanks the view down by the height of everything just inserted, which reads as
   *  the app throwing away your place the moment you scroll up. */
  restoreAfterPrepend: (previousHeight: number) => void;
}

export function useAutoFollow({
  contentKey,
  rearmKey,
  onReachTop,
  scrollRef: externalRef,
}: AutoFollowOptions): AutoFollow {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = externalRef ?? ownRef;
  // Whether the reader is following the bottom. Starts TRUE (a freshly opened thread should be at
  // its newest message) and only changes when the READER scrolls — never as a side effect of new
  // content.
  const followRef = useRef(true);
  /** Last observed scrollTop, so an event that moved nothing can be told from the reader actually
   *  scrolling. -1 is a value no scrollTop can hold, so the first event of a session always counts
   *  as the reader's. */
  const lastTopRef = useRef(-1);
  /** The newest re-arm key this hook has already reacted to. `null` until the first effect run, so a
   *  thread that MOUNTS with the user's last message in it (the persisted thread, restored at
   *  launch) isn't mistaken for a fresh submit. */
  const lastRearmRef = useRef<string | null>(null);
  const onReachTopRef = useRef(onReachTop);
  onReachTopRef.current = onReachTop;
  /**
   * Is the reader dragging out a selection RIGHT NOW?
   *
   * GUARD 3, and the one that answers a founder report directly: "when I copy boxes sometimes the
   * part where I started copying loses its initial anchor location."
   *
   * The follow writes `el.scrollTop = el.scrollHeight` on every change of `contentKey`, and callers
   * fold total text length into that key — so a streaming reply fires it once per token. The other
   * two guards ask "should we be following?", and while a reply streams the honest answer is yes.
   * Neither asks whether the reader is mid-GESTURE, so a drag started anywhere in the transcript
   * gets the container yanked to the bottom underneath it several times a second. The browser goes
   * on extending the highlight from where the anchor now sits on screen, which is not where the
   * reader put it.
   *
   * Deferred, never cancelled: the follow stays armed, so the release catches the thread up.
   */
  const selectingRef = useRef(false);
  useEffect(() => {
    // Primary button only — a right-click opens a context menu over a selection rather than starting
    // one.
    //
    // BOTH ends on the DOCUMENT, symmetrically. The release must be, because a drag that overshoots
    // the thread (which is how you select through to the end of an answer) lets go somewhere else
    // entirely — container-bound, this flag would latch on and the thread would stop following for
    // the rest of the session. The PRESS must be for the mirror reason: a selection that starts in
    // the compose box and comes up into the transcript is still one the follow would scroll out from
    // under. The cost is that an ordinary click defers the follow until its own mouseup, which is not
    // observable.
    const down = (e: MouseEvent) => {
      if (e.button === 0) selectingRef.current = true;
    };
    // CATCH UP ON RELEASE, rather than leaving the deferral for the next delta to resolve. The guard
    // only early-returns; nothing re-runs the effect on `mouseup`, so a deferred follow waited on a
    // `contentKey` change that may never come. If the LAST delta of a reply lands during the hold,
    // the answer stays below the fold until some future message arrives — and `followRef` still
    // reads `true`, so nothing looks wrong.
    //
    // Idempotent by construction: while the follow is armed the thread is already at the bottom, so
    // this is a no-op except in exactly the case it is for.
    const up = () => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      const el = scrollRef.current;
      if (!el || !followRef.current) return;
      el.scrollTop = el.scrollHeight;
      lastTopRef.current = el.scrollTop;
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
    };
    // `scrollRef` is a ref OBJECT, stable for the life of the hook — listed because the object is
    // chosen (`externalRef ?? ownRef`) and so cannot be inferred as stable, not because it varies.
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // THE ONE THING THAT RE-ARMS THE FOLLOW BESIDES REACHING THE BOTTOM: the user's own submit.
    //
    // Everything else here is about protecting a reader from content they did not ask for. A message
    // THEY sent is the opposite — an unambiguous "show me what happens next" — and until this existed
    // there was nothing that could re-arm the follow except personally scrolling back to the bottom.
    // That is a one-way door in practice: a trackpad flick that settles 30px short of the bottom is
    // past FOLLOW_THRESHOLD_PX, so the follow dies silently and every later send — including the one
    // they are watching for — lands below the fold.
    const previousRearm = lastRearmRef.current;
    lastRearmRef.current = rearmKey;
    const justSent = previousRearm !== null && rearmKey !== "" && rearmKey !== previousRearm;
    if (justSent) followRef.current = true;
    // The stick-to-bottom check — READ from the reader's own scrolling, not re-measured here.
    // Measuring after layout got both ends wrong: on mount `scrollTop` is 0 against a full
    // `scrollHeight`, so a thread that opens with any content is judged "scrolled up" and never
    // follows again; and a single tall card can exceed the slack, so following silently stops the
    // first time one arrives.
    if (!followRef.current) return;
    // Guard 3 — see `selectingRef`. Never scroll out from under a live drag.
    if (selectingRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Record the scroll WE caused, before the browser dispatches its (async) scroll event. Without
    // this, `lastTopRef` still holds the previous bottom, so a reader gesture that happens to land
    // on exactly that value reads as "didn't move" and the demotion is skipped — and the previous
    // bottom is the likeliest such value, since streaming moves the bottom one chunk at a time.
    lastTopRef.current = el.scrollTop;
  }, [contentKey, rearmKey, scrollRef]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_THRESHOLD_PX;
    // ONE test: did this event actually move the scroll position? Every browser re-fit is already
    // covered without a second term, which is why there isn't one —
    //   • viewport shrinks (window resize, panel opens): scrollTop is untouched while the distance
    //     from the bottom grows. `readerMoved` is false, so nothing happens.
    //   • content removed below the fold: the browser clamps scrollTop to the new maximum, which IS
    //     the bottom, so `atBottom` re-arms the follow.
    //   • a scroll event that changed nothing (horizontal scroll, an anchoring adjustment that nets
    //     zero, a synthetic event): `readerMoved` is false.
    // Two earlier attempts added a geometry-based "was this a clamp?" term instead. Both were worse:
    // keyed on any geometry change it swallowed real scroll-aways during streaming growth, and keyed
    // on a shrinking range it depended on a baseline that a resize with no scroll event leaves stale.
    const readerMoved = el.scrollTop !== lastTopRef.current;
    if (atBottom) followRef.current = true;
    else if (readerMoved) followRef.current = false;
    lastTopRef.current = el.scrollTop;
    // Backwards paging. Gated on `readerMoved` so the programmatic scroll the follow effect performs
    // cannot trigger a fetch — on a short thread `scrollTop` is 0 and therefore always "near the
    // top", which would otherwise page the entire history in on mount.
    if (readerMoved && el.scrollTop <= TOP_TRIGGER_PX) onReachTopRef.current?.();
  }, []);

  const measureBeforePrepend = useCallback(() => scrollRef.current?.scrollHeight ?? 0, [scrollRef]);

  const restoreAfterPrepend = useCallback((previousHeight: number) => {
    const el = scrollRef.current;
    if (!el || previousHeight === 0) return;
    const delta = el.scrollHeight - previousHeight;
    if (delta <= 0) return;
    el.scrollTop += delta;
    lastTopRef.current = el.scrollTop;
  }, [scrollRef]);

  return { scrollRef, onScroll, measureBeforePrepend, restoreAfterPrepend };
}
