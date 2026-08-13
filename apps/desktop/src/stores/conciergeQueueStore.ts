// WHERE THE CONCIERGE'S QUEUE DEPTH LIVES BETWEEN THE COLUMN AND THE SWEEP.
//
// Modelled on `stores/conflictStore` beside it, and for the same structural reason: one side of the
// seam is a React component that owns the fact, the other is `PusherRunnerDeps.snapshots()` — a
// SYNCHRONOUS read taken from a 60-second `setInterval` that has no component to ask. A store is
// what lets those two exist in different worlds.
//
// ── THE INVARIANT THIS FILE EXISTS TO SATISFY ────────────────────────────────────────────────────
// A Pusher fleet condition fires if and only if its evidence lives in a PERSISTED, APP-WIDE store.
// The two shipped examples are the whole argument:
//
//   • `goals-escalated` fires reliably, because `pusherSnapshots` reads `agent.goal.escalatedAt`
//     straight off `projectStore.projects` — app-wide state that outlives any pane.
//   • `quota-blocked` has NEVER fired, because its evidence is `quotaFor: quotaBlockForAgent`
//     (`pusherMount`), a PER-WINDOW LIVE ENGINE REGISTRY. An agent with no engine registered in this
//     window reads as "no wall", so the condition is refused for exactly the agents nobody is
//     watching — which is every agent the founder actually needs to be told about.
//
// The queue depth started life in the second category and worse: it existed ONLY as a `useRef` plus
// `useState` pair inside `ConciergeHost`, so it crossed no module boundary at all. Publishing it
// here is the whole of the work; the condition that reads it cannot fire until the value is
// somewhere a background sweep can see.
//
// ── "APP-WIDE" HERE MEANS MODULE-WIDE IN THIS WINDOW, AND THAT IS THE RIGHT SCOPE ──────────────
// Worth stating, because the `quota-blocked` comparison above invites the opposite reading. A
// zustand store is not shared ACROSS windows the way `projectStore.projects` is (which the Rust
// roster publishes to all of them), so a satellite window reads `undefined` here.
//
// That is correct rather than a limitation, and the reason is that the SUBJECT and the CHANNEL are
// co-located in a way `quota-blocked`'s never were. What broke that condition is that the evidence
// (a live engine) and the agent it is about live in different windows: window B can be the one that
// owns the project and composes the report about an agent whose wall only window A can see. Here
// there is nothing to misalign — the concierge queue belongs to the `ConciergeHost` in THIS window,
// and `conciergeNotifier`'s sink, which is the only way to deliver a finding about it, is
// registered by that same host. A window with no concierge has no queue AND no way to speak to one,
// so `undefined` is not a blind spot: it is the accurate reading, and it fails closed.
//
// ── `undefined` MEANS WE DID NOT LOOK, AND IT IS NEVER AN EMPTY QUEUE ───────────────────────────
// The one rule, inherited verbatim from `conflictStore` and from `pusherObserve` above it. `0` and
// "nobody has told us" are different facts, and conflating them here would put the fail-open answer
// at the front door of a detector built to end a silence: a window with no concierge mounted — a
// torn-off satellite, a project-less main window, the seconds before the host's first effect — would
// read as "the concierge has nothing queued" and the sweep would stay quiet about a queue it never
// looked at.
//
// ── WHY THE WRITER IS IDENTIFIED, AND WHY THE CLEAR IS CHECKED AGAINST IT ───────────────────────
// Exactly the rule `services/conciergeNotifier` states for its sink, arrived at the same way.
// `ConciergeHost` publishes from an effect and clears in that effect's cleanup — and React mounts
// the NEW instance BEFORE running the OLD one's cleanup, both under strict mode's double-invoke and
// on every ordinary remount. So LAST PUBLISH WINS, and a cleanup only clears if the depth on file is
// still its own. Without the check, the survivor of a remount is the dead instance's clear: the live
// host has already published a real depth and the outgoing one wipes it back to "nobody looked",
// where it stays until the next send moves the queue.
//
// The reverse case is the one that costs the founder something visible, and it is why the clear is
// mandatory rather than nice-to-have: a host that is torn down without clearing leaves its last
// reading standing forever. Nothing else writes this store, so "6 queued" would be reported by every
// sweep for the life of the window, about a concierge that no longer exists.
import { create } from "zustand";

import type { TurnQueueState } from "../engine/conciergeTurnQueue";
import { waitingCount } from "../engine/conciergeTurnQueue";

/**
 * What a mounted concierge publishes about its turn queue.
 *
 * BOTH FIELDS, because they are different facts and this file does not get to decide which one
 * matters — `engine/conciergeTurnQueue` says so in its own words: *"'a turn is running' and 'the
 * queue is non-empty' are different facts that a reducer must not conflate: the queue is empty for
 * the entire life of an ordinary single send, and that send is still running."* The adapter is dumb
 * on purpose (see `pusherSnapshots`' header); the condition that reads this is where the judgement
 * belongs.
 */
export interface ConciergeQueueDepth {
  /** Messages waiting BEHIND the running turn. Never includes the one in flight. */
  waiting: number;
  /** Is a turn in flight right now? */
  running: boolean;
  /**
   * When the OLDEST waiting message was sent, or `null` when nothing is waiting.
   *
   * THE DEPTH ALONE IS NOT ENOUGH, and shipping without this is what kept `queue-unfanned` dead
   * after its producer landed: the condition refuses to fire on an unestablished age, so a reading
   * carrying counts but no clock is indistinguishable from never having looked. A count says the
   * queue is deep; only this says it has STOPPED MOVING, which is the actual complaint.
   */
  oldestAt: number | null;
}

/**
 * The depth a given reducer state publishes as.
 *
 * Exported and used by the host rather than letting it read `.waiting.length` itself, so there is
 * ONE definition of what gets published. A second count at the call site is how the store comes to
 * disagree with the per-message status the founder is looking at — the same "one derivation used
 * twice, never two derivations" rule `ConciergeAgentsRow` records for its own `+[n]`.
 */
export function queueDepthOf(s: TurnQueueState): ConciergeQueueDepth {
  // `waiting[0]` IS the oldest: `enqueue` appends and `turnFinished` shifts from the front, and the
  // cap drops from the front too — so the array is in send order and index 0 has waited longest.
  // Read from the entry rather than tracked separately, so the age and the count can never describe
  // different queues.
  return {
    waiting: waitingCount(s),
    running: s.running !== null,
    oldestAt: s.waiting[0]?.enqueuedAt ?? null,
  };
}

export interface ConciergeQueueState {
  /**
   * The last published reading, or `undefined` for NOBODY HAS LOOKED.
   *
   * `undefined` also covers the states that are indistinguishable from never having looked and must
   * behave the same way: no concierge is mounted in this window at all, and a host that was mounted
   * and has since been torn down.
   */
  depth: ConciergeQueueDepth | undefined;
  /**
   * WHO published it — the host instance's own token, never inspected, only compared.
   *
   * An opaque `object` rather than an id string because identity is the whole question: two host
   * instances briefly coexist across a remount and nothing distinguishes them by value.
   */
  owner: object | null;
  /**
   * Publish one reading, taking ownership. LAST PUBLISH WINS, UNCONDITIONALLY.
   *
   * That is `setConciergeNotifier`'s rule and it is right for the same reason: the incoming host's
   * mount runs BEFORE the outgoing host's cleanup, so an ownership test here — "refuse a publish
   * while somebody else holds it" — would leave the replacement unable to publish at all, and the
   * survivor of every remount would be the dead instance's reading. The asymmetry is deliberate:
   * the write is unguarded and the CLEAR is identity-checked, which is exactly the pair that makes
   * mount-before-cleanup come out right.
   */
  publish(owner: object, depth: ConciergeQueueDepth): void;
  /** Clear `owner`'s reading if it is still the published one. See {@link publish}. */
  clearFor(owner: object): void;
  /** Test seam: back to NOBODY HAS LOOKED. Not a production path. */
  _resetForTests(): void;
}

export const useConciergeQueueStore = create<ConciergeQueueState>((set, get) => ({
  depth: undefined,
  owner: null,
  // UNGUARDED, deliberately — see the interface. Guarding this is what would break a remount.
  publish: (owner, depth) => set({ depth, owner }),
  clearFor: (owner) => {
    if (get().owner !== owner) return;
    set({ depth: undefined, owner: null });
  },
  _resetForTests: () => set({ depth: undefined, owner: null }),
}));

/**
 * Publish a depth on behalf of one host instance.
 *
 * A free function beside the hook for the same reason `setConciergeNotifier` is one: the caller is
 * an effect, not a render, and it should not have to know this is zustand.
 */
export function publishConciergeQueue(owner: object, depth: ConciergeQueueDepth): void {
  useConciergeQueueStore.getState().publish(owner, depth);
}

/** Clear `owner`'s reading if it is still the published one — the host's unmount path. */
export function clearConciergeQueue(owner: object): void {
  useConciergeQueueStore.getState().clearFor(owner);
}
