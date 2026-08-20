// previewIdleGrace — stop a preview server that has shown NO SIGN OF LIFE for `[preview]
// idle_grace_min` minutes.
//
// ══ THIS USED TO BE A VISIBILITY CLOCK, AND THAT CLOCK STOPPED BOUNDING ANYTHING ════════════════
// Design doc §4 wrote it as: "a covered preview keeps serving for the grace window and only then
// stops." That was a fact about a preview PANE, which could be COVERED by flipping the pair to
// Plan. The pane was removed on 2026-08-19 (`d48af48e5`, the founder: a preview is a card in the
// concierge chat, not a peer column) and a CARD CANNOT BE COVERED — so "is it visible" became
// permanently true for every healthy `ready`/`serving` preview on a loopback url, its timer never
// armed, and a dev server ran until worktree teardown or app exit while `config.rs` went on
// documenting `idle_grace_min` as one of only three things that ever stop a server. Bead
// `sparkle-9yck3i`.
//
// The replacement asks a question a card cannot answer trivially: not "can it be seen" but "has
// anything happened to it". Both halves of that are stated below, because neither is guessable.
//
// ══ WHAT COUNTS AS ACTIVITY — AND WHY IT IS NOT JUST THE WIRE ═══════════════════════════════════
// The obvious answer is "a `preview:state` event", and on its own it is close to useless here:
// `preview.rs`'s `supervise()` transitions to `Ready` ONCE and then loops on a liveness check,
// emitting again only for `Crashed`/`Failed`. A healthy preview therefore produces NO further
// events at all — a hot reload is invisible to this side (and even where a repeat does arrive, via
// `listPreviews()` after a window reload, `setPreview`'s unchanged-value bail used to throw it
// away). A wire-only clock would be a MAX LIFETIME CAP wearing an idle clock's name.
//
// So activity is the union of three things, and only the first is Rust's:
//   1. any `setPreview` — including the repeats the bail discards, which now stamp
//      `lastActivityAt` IN PLACE without re-rendering anything (see `previewStore`);
//   2. an explicit human or agent touch, through `notePreviewActivity` (`previewStore`) — the
//      card's ⟳, a click through to the url, an agent's `preview_inspect` capture;
//   3. the preview STARTING, which is `startedAt`, the fallback anchor for an entry that has
//      never been stamped at all.
// A preview nobody has touched and nothing has said anything about for the whole grace window is
// exactly what the window was written to reclaim, so that is what it now reclaims.
//
// ══ THE TIMER RE-CHECKS ON FIRE RATHER THAN BEING RE-ARMED ON ACTIVITY ══════════════════════════
// Activity deliberately does NOT wake this module: stamping in place is what keeps a redundant
// event from re-rendering the card, and a subscription that fired on it would give that cost
// straight back. So a fired timer does not stop anything on sight — it re-reads the anchor and
// RE-ARMS for whatever time is left. That inverts the usual coupling: the clock polls at the
// deadline instead of the activity path having to notify, which means an activity source added
// later (an agent tool, a proxy hit) needs only to stamp, never to know this module exists.
//
// ══ MODULE-SCOPED TIMERS, NOT COMPONENT STATE ═══════════════════════════════════════════════════
// Unchanged from the visibility era and still right for a stronger reason: nothing renders the
// entry field this clock reads, so there is no component whose lifetime it could borrow. A
// `setTimeout` in a `useEffect` would be cancelled by exactly the unmount this must survive.
import { usePreviewStore, type PreviewEntry, type PreviewState } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import { stopPreviewForAgent } from "./preview";
import { getConfig, onConfigChanged, type EffectiveConfig } from "./config";

/** States `preview.rs` still considers the server live — mirrors `live_for_reattach` in preview.rs
 *  (Installing/Starting/Listening/Ready/Serving), i.e. everything that is not already a terminal
 *  state. A terminal entry (`stopped`/`failed`/`crashed`) has nothing left to stop.
 *
 *  MUST include every `live_for_reattach` arm, not just the ones a human is likely to see idle.
 *  `installing` was added to that Rust set without a matching update here once before (roborev
 *  63963): a preview still waiting on `node_modules` — up to `INSTALL_WAIT_TIMEOUT`, 300s on the
 *  Rust side — armed no idle-grace timer at all, so that whole window accrued nothing toward the
 *  grace period. `previewSeam.test.ts` pins this set against the Rust enum so the next added state
 *  fails a test rather than drifting silently again. */
const LIVE_STATES: ReadonlySet<PreviewState> = new Set(["installing", "starting", "listening", "ready", "serving"]);

const DEFAULT_IDLE_GRACE_MIN = 10;

/**
 * The one impure thing this module does besides `setTimeout`: read the wall clock.
 *
 * INJECTABLE BECAUSE THE CLOCK AND THE TIMER QUEUE ARE TWO DIFFERENT THINGS HERE, and the whole
 * re-check-on-fire design lives in the gap between them. Under `vi.useFakeTimers()` they move
 * together, which is what lets almost every test drive the PRODUCTION value (`Date.now`) rather
 * than a stand-in — the repo's "defaulted seam every test injects" trap is that a seam every test
 * overrides leaves the real call site covered by nothing. The seam still earns its place: a test
 * that moves the clock WITHOUT moving the timer queue is the only way to show that a fired timer
 * re-reads the anchor instead of trusting the delay it was armed with.
 */
export interface PreviewIdleGraceDeps {
  /** Wall clock in epoch ms. Must agree with whatever wrote `lastActivityAt` — `Date.now()` on
   *  both sides in production, and the same faked `Date.now()` on both sides under fake timers.
   *  Two clocks that disagree make an idle window that is silently the wrong length. */
  now: () => number;
}

const PRODUCTION_DEPS: PreviewIdleGraceDeps = { now: () => Date.now() };

/** MODULE-LEVEL AND DEFAULTED TO PRODUCTION, rather than a parameter every caller passes. The
 *  production call sites — the store subscription and the fired timer — take this object, so a test
 *  that leaves it alone is exercising the real one. */
let deps: PreviewIdleGraceDeps = PRODUCTION_DEPS;

/** agentId -> pending stop timer. Module-scoped so it survives whatever component triggered the
 *  reconcile that armed it. */
let pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Agents whose stop IPC is in flight, each mapped to a TOKEN identifying *which* stop.
 *
 * See `onIdleDeadline` for why firing-and-forgetting is not enough: the store entry stays live
 * until `clearPreview` runs, so without this a concurrent reconcile arms an already-expired timer
 * and double-stops. An agent is in `pending` or in this, never both.
 *
 * ══ WHY A TOKEN AND NOT A BARE SET (roborev 65701) ══════════════════════════════════════════════
 * A stop's promise outlives teardown, so its settle can arrive in a world that has moved on, and a
 * membership test alone cannot tell "my stop" from "a later stop for the same agent". The measured
 * interleaving: S1 is in flight when the watcher is torn down (`stopping` cleared); the watcher
 * restarts, the preview is still live, its deadline fires and registers S2; S1 then settles and,
 * with an unconditional delete, removes S2's entry. The store still reads `serving` and there is no
 * pending timer, so the next reconcile — any second preview's `preview:state`, the ordinary case —
 * double-stops, which is the exact bug `stopping` was introduced to prevent. The rejecting variant
 * is worse: it leaves `pending` and `stopping` populated at once, breaking the invariant above.
 *
 * BOTH ARMS COMPARE THE TOKEN, so a stale settle is inert in both directions. Asymmetric guards are
 * exactly what decays — the first version of this guard checked the `.catch` arm and not the
 * `.then`, which is how the hole above survived its own fix.
 */
const stopping = new Map<string, symbol>();

/** agentId -> when we first noticed the roster could not name it. See `idleSinceFor`. */
let orphanedSince = new Map<string, number>();

/** Read once at watcher start and refreshed on every config change, NOT re-read per timer — a
 *  config edit mid-grace-window changes the deadline for the NEXT idle agent, not one already
 *  counting down, which matches every other "read config, act on it" path in this codebase (no
 *  retroactive rewrite of in-flight state). */
let idleGraceMs = DEFAULT_IDLE_GRACE_MIN * 60_000;

function applyConfig(eff: EffectiveConfig): void {
  const minutes = eff.config.preview?.idle_grace_min;
  idleGraceMs = Math.max(1, minutes ?? DEFAULT_IDLE_GRACE_MIN) * 60_000;
}

function clearPending(agentId: string): void {
  const handle = pending.get(agentId);
  if (handle !== undefined) {
    clearTimeout(handle);
    pending.delete(agentId);
  }
}

function liveAgentIds(): ReadonlySet<string> {
  const byAgent = usePreviewStore.getState().byAgent;
  return new Set(
    Object.keys(byAgent).filter((id) => {
      const entry = byAgent[id];
      return entry !== undefined && LIVE_STATES.has(entry.status);
    }),
  );
}

/** Which agents the live fleet can still name. The roster half of `renderablePreviewCards`' two
 *  gates, asked on its own — the state/url half belongs to the card and no longer belongs to this
 *  clock at all, since a visible card is no longer a reason to keep serving. */
function rosterAgentIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const project of useProjectStore.getState().projects) {
    for (const agent of project.agents) ids.add(agent.id);
  }
  return ids;
}

/**
 * Bring `orphanedSince` up to date: a stamp for every preview whose agent the roster cannot name,
 * and no stamp for any it can.
 *
 * Called at the top of every reconcile AND at every timer fire, because both read the map
 * afterwards and neither can assume the other ran recently. Idempotent: an agent already marked
 * keeps its ORIGINAL stamp, so the orphan window counts from when it went unresolvable rather than
 * restarting on each pass.
 */
function refreshOrphanClock(): void {
  const resolvable = rosterAgentIds();
  const byAgent = usePreviewStore.getState().byAgent;
  const now = deps.now();
  for (const agentId of Object.keys(byAgent)) {
    if (resolvable.has(agentId)) orphanedSince.delete(agentId);
    else if (!orphanedSince.has(agentId)) orphanedSince.set(agentId, now);
  }
  // Drop stamps for previews that no longer exist, so this map cannot outgrow the store.
  for (const agentId of Array.from(orphanedSince.keys())) {
    if (!(agentId in byAgent)) orphanedSince.delete(agentId);
  }
}

/**
 * The moment this preview's grace window starts counting from.
 *
 * ORPHANS IGNORE ACTIVITY, and that is the one narrowing carried over from the visibility clock
 * rather than replaced by it. A preview whose agent the roster cannot name paints no card — an
 * orphan folded in by `listPreviews()` after a window reload, a removed project, a server that
 * outlived its agent — so nobody can be looking at it and nobody can touch it. Anchoring it to
 * `lastActivityAt` would let a dev server that is still rebuilding for a worktree with no owner
 * hold itself alive forever, which is precisely the leak the old clock DID catch. Anchoring it to
 * "when it went unresolvable" reproduces the old behaviour exactly: full grace window from the
 * moment it lost its card, then reclaimed.
 */
function idleSinceFor(agentId: string, entry: PreviewEntry): number {
  // A STAMP IN `orphanedSince` IS THE ORPHAN VERDICT — `refreshOrphanClock` puts one there for
  // exactly the agents the roster cannot name and deletes it the moment one comes back. Re-asking
  // `resolvable.has(agentId)` here would be an unfalsifiable restatement of that invariant: no
  // mutation of the extra branch can change an answer, since a resolvable agent never has a stamp
  // to find. (Caught as an inert line by `scripts/mutation-check.sh`, and removed rather than
  // wrapped in a stronger assertion.)
  return orphanedSince.get(agentId) ?? entry.lastActivityAt ?? entry.startedAt;
}

function armIdleTimer(agentId: string, delayMs: number): void {
  // `Math.max(0, …)` because an entry can already be past its deadline when we first see it — a
  // window that reloaded onto servers started long ago, or a config edit that shortened the window.
  const handle = setTimeout(() => onIdleDeadline(agentId), Math.max(0, delayMs));
  pending.set(agentId, handle);
}

/**
 * A deadline came up. Stop the server ONLY if it is still live and still idle.
 *
 * The re-check is the load-bearing half: activity does not wake this module (stamping in place is
 * what keeps a redundant event from re-rendering the card), so the delay this timer was armed with
 * is a LOWER BOUND on the wait, never a verdict. A preview touched at minute 9 of a 10-minute
 * window is re-armed here for the 9 minutes it has left, and the loop repeats for as long as
 * something keeps wanting it.
 */
function onIdleDeadline(agentId: string): void {
  pending.delete(agentId);
  refreshOrphanClock();
  const entry = usePreviewStore.getState().byAgent[agentId];
  if (entry === undefined || !LIVE_STATES.has(entry.status)) return;
  const remaining = idleSinceFor(agentId, entry) + idleGraceMs - deps.now();
  if (remaining > 0) {
    armIdleTimer(agentId, remaining);
    return;
  }
  // IN FLIGHT, AND THE STORE STILL SAYS `serving` UNTIL THE IPC RESOLVES — which is why this is
  // tracked rather than fired and forgotten (roborev 65675, Medium). Any preview-store write during
  // the await (a SECOND agent's `preview:state`, the common case once more than one preview is
  // live) runs `reconcilePreviewIdleGrace`, which would see a live entry with no pending timer, arm
  // one whose delay is already non-positive, and issue a second `preview_stop_for_agent` for the
  // same agent on the next macrotask. `stopping` is what the reconcile pass reads to tell "nothing
  // is timing this" apart from "this is already on its way out".
  const token = Symbol("preview-stop");
  stopping.set(agentId, token);
  void stopPreviewForAgent(agentId)
    .catch((e: unknown) => {
      // A REJECTED STOP MUST NOT LEAVE THE PREVIEW UN-TIMED. Without this the entry stays live with
      // no pending timer and nothing in `stopping`, so it is re-timed only if some unrelated store
      // write happens to reconcile it — a leak that presents as "the grace period silently stopped
      // applying to this one preview". Re-arming a full window is the conservative choice: a stop
      // that failed is not evidence the preview is unwanted.
      console.warn("preview idle grace: stop failed; re-arming the window", agentId, e);
      // STILL OURS TO RE-ARM? An IPC in flight outlives teardown, and this arm runs whenever it
      // finally settles (roborev 65694). Both `startPreviewIdleGraceWatcher`'s cleanup and
      // `resetPreviewIdleGraceStateForTests` clear `stopping`, so its ABSENCE here means the world
      // this stop belonged to is gone — and re-arming would put a live `setTimeout` into a watcher
      // that unmounted, contradicting the cleanup's own contract, with nothing left to clear it.
      // It is also the cross-test leak: `armIdleTimer` writes through the module binding, so a
      // rejection left over from one test would land in the NEXT test's freshly-created map and
      // stop an agent it never seeded.
      if (stopping.get(agentId) !== token) return;
      stopping.delete(agentId);
      const still = usePreviewStore.getState().byAgent[agentId];
      if (still !== undefined && LIVE_STATES.has(still.status)) armIdleTimer(agentId, idleGraceMs);
    })
    .then(() => {
      // SAME TOKEN CHECK AS THE CATCH ARM. Deleting unconditionally is what let a settle from a
      // torn-down world clear a LIVE stop's entry — see the note on `stopping`.
      if (stopping.get(agentId) === token) stopping.delete(agentId);
    });
}

/**
 * Reconcile pending stop timers against the store. Exported so a store subscription can call it
 * directly, and so tests can drive it without the subscribe/config-fetch machinery in
 * `startPreviewIdleGraceWatcher`.
 *
 * Two passes, in this order: cancel first, then arm. An agent that is no longer live (its entry
 * moved to `stopped`) and was formerly pending must lose its timer before the arm pass ever looks
 * at it — reversing the order would let a stale timer survive one extra reconcile.
 *
 * AN AGENT THAT ALREADY HAS A TIMER IS LEFT ALONE, deliberately, even though its anchor may have
 * moved since. Re-arming here would push the deadline out on every unrelated store write, which is
 * how a grace window silently becomes unbounded again; `onIdleDeadline`'s re-check is where a moved
 * anchor is honoured, and it honours it exactly once, at the deadline.
 */
export function reconcilePreviewIdleGrace(): void {
  refreshOrphanClock();
  const byAgent = usePreviewStore.getState().byAgent;
  const live = liveAgentIds();

  for (const agentId of Array.from(pending.keys())) {
    if (!live.has(agentId)) clearPending(agentId);
  }
  for (const agentId of live) {
    if (pending.has(agentId)) continue;
    // ALREADY ON ITS WAY OUT — see `stopping`. Arming here IS the double-stop.
    if (stopping.has(agentId)) continue;
    const entry = byAgent[agentId];
    if (entry === undefined) continue;
    armIdleTimer(agentId, idleSinceFor(agentId, entry) + idleGraceMs - deps.now());
  }
}

let unlistenConfig: (() => void) | undefined;

/** Start watching. Call once at app startup, alongside `startPreviewListener` (`Workspace.tsx`).
 *  Returns a cleanup function that unsubscribes and cancels every pending timer — nothing here
 *  should keep counting down in a window that unmounted. */
export function startPreviewIdleGraceWatcher(): () => void {
  // TWO SUBSCRIPTIONS. `previewStore` wakes this when a preview appears or leaves the live set;
  // `projectStore` wakes it when an agent leaves the fleet, which starts that preview's orphan
  // clock (see `idleSinceFor`) without touching the preview store at all. The UI store is genuinely
  // gone from the answer — no work mode can cover a card, and a card no longer keeps a server
  // alive — so subscribing to it would only wake this on unrelated selection changes.
  //
  // NEITHER SUBSCRIPTION SEES ACTIVITY, by design: `lastActivityAt` is stamped in place precisely
  // so it wakes nobody. `onIdleDeadline` is where a moved anchor is read.
  const unsubPreview = usePreviewStore.subscribe(reconcilePreviewIdleGrace);
  const unsubProjects = useProjectStore.subscribe(reconcilePreviewIdleGrace);

  void getConfig()
    .then(applyConfig)
    .catch(() => {});
  void onConfigChanged(applyConfig)
    .then((u) => {
      unlistenConfig = u;
    })
    .catch(() => {});

  reconcilePreviewIdleGrace();

  return () => {
    unsubPreview();
    unsubProjects();
    unlistenConfig?.();
    unlistenConfig = undefined;
    for (const agentId of Array.from(pending.keys())) clearPending(agentId);
    stopping.clear();
  };
}

/** Test seam: drop module-global state between tests. Never called by app code. */
export function resetPreviewIdleGraceStateForTests(): void {
  for (const handle of pending.values()) clearTimeout(handle);
  pending = new Map();
  // MUST be cleared too, or an in-flight stop from a previous test leaves its agent permanently
  // skipped by the reconcile pass — a leak between tests that reads as "the timer never armed".
  stopping.clear();
  orphanedSince = new Map();
  idleGraceMs = DEFAULT_IDLE_GRACE_MIN * 60_000;
  deps = PRODUCTION_DEPS;
}

/** Test seam: set the grace window directly, bypassing the async config round trip. Never called
 *  by app code. */
export function setPreviewIdleGraceMinutesForTests(minutes: number): void {
  idleGraceMs = Math.max(1, minutes) * 60_000;
}

/** Test seam: swap the wall clock. Never called by app code — and deliberately NOT called by most
 *  tests either, which run the production `Date.now` under fake timers so that the real seam is
 *  covered rather than merely bypassed. */
export function setPreviewIdleGraceClockForTests(now: () => number): void {
  deps = { now };
}
