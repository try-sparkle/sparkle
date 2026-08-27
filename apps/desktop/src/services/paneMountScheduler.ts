// WHEN THE NEXT BATCH OF `AgentPane`s IS ALLOWED TO MOUNT — the yield point, and nothing else.
//
// THE FREEZE THIS EXISTS FOR (bead sparkle-pqss6). Across three days of logs: 28 hang detections
// against 14 app starts, and 20 of the 28 landed within 70 seconds of a start — so restarting to
// clear a freeze reliably produced another one. Renderer render-attribution on those stalls shows
// `AgentPane` rendered 93, 92 and 91 times inside a SINGLE stall. Every open agent's pane mounted in
// one commit: N xterms, N WebGL contexts, N sets of pane effects, no yield between them. The
// non-startup instance studied in detail was a 7-agent BATCH SPAWN whose seven status transitions
// were 1.2s apart while `requestAnimationFrame` and `setInterval` were both starved for 10.2s — the
// identical burst, nowhere near boot. That is why the gate this module drives sits on the pane list
// itself rather than on a startup flag: boot and batch spawn are the same code path, and a
// boot-only fix leaves the second half of the bug in place.
//
// WHY `requestAnimationFrame` IS THE PRIMARY CLOCK. The cost being spread is LAYOUT and paint —
// every agent's terminal is laid out at all times, so a hidden pane still costs renderer-wide
// layout. rAF is the only callback that is defined to run once the browser is ready to produce
// another frame, so releasing on it means "mount some panes, let the compositor breathe, mount some
// more". It also degrades in exactly the right direction: when the renderer IS starved, rAF slows
// down and so does the release, instead of piling more mounts onto a loop that is already behind.
//
// WHY IT CANNOT BE rAF ALONE — AND WHY THAT MATTERS FOR STATUS, NOT JUST FOR SPEED. A backgrounded
// or hidden webview does not fire rAF at all. `runtimeStore.status` has exactly ONE writer, a
// MOUNTED `AgentPane`, so a pane that never mounts leaves its agent's status frozen for as long as
// it waits. rAF alone would therefore trade a startup freeze for an indefinitely stale fleet in
// every satellite window the user is not looking at. So each release RACES rAF against a plain
// timer and takes whichever arrives first: on a visible window that is the frame, on a hidden one
// it is the timer. The queue always drains; only its rate varies.
//
// NOT A PRIORITY QUEUE, NOT A BUDGET. It answers one question — "may the next batch mount now?" —
// and the caller decides what a batch is. Ordering (the pane the user is LOOKING at never waits
// behind a queue) belongs to the caller too; see `useStaggeredPaneMounts`.

/** How many panes are admitted per release. Two, not one: a single pane per frame makes a 30-agent
 *  restore take half a second of visibly filling columns, and two is still far under the point where
 *  a commit stops fitting in a frame — the cost this is spreading is one xterm + WebGL context +
 *  pane effects each, not a cheap div. The whole queue drains in ceil(N/2) frames. */
export const PANES_PER_MOUNT_RELEASE = 2;

/** How long a release waits for a frame before giving up on rAF and firing anyway. Long enough that
 *  a visible window always wins on rAF (~16ms) and this never fires, short enough that a hidden
 *  window still drains a 30-pane restore in ~3 seconds rather than never. */
export const MOUNT_RELEASE_FALLBACK_MS = 200;

/**
 * Run `release` at the next frame, or after {@link MOUNT_RELEASE_FALLBACK_MS}, whichever comes
 * first. Returns a canceller; calling it after the release has already run is a no-op, and calling
 * it before guarantees `release` never runs.
 *
 * Exactly-once by construction — both arms fire the same latched callback — because a double
 * release would admit 2×`PANES_PER_MOUNT_RELEASE` panes in one commit and quietly halve the
 * staggering on any machine where the timer and the frame land in the same tick.
 */
export function scheduleMountRelease(release: () => void): () => void {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const clear = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = () => {
    if (settled) return;
    settled = true;
    clear();
    release();
  };

  timer = setTimeout(fire, MOUNT_RELEASE_FALLBACK_MS);
  // Guarded because a non-visual host (a jsdom run without `pretendToBeVisual`, a worker) has no
  // rAF at all, and there the timer above is the whole scheduler rather than a fallback.
  if (typeof requestAnimationFrame === "function") {
    frame = requestAnimationFrame(fire);
    // A test double may invoke its callback synchronously, in which case `fire` already ran with
    // `frame` still null and the handle assigned just above would leak past the cancel.
    if (settled) clear();
  }

  return () => {
    settled = true;
    clear();
  };
}
