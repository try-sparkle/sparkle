// The armed send — "I'm about to tell that agent this; say the word and I won't."
//
// See docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A3. This is the other half of
// the forwarding-bug fix: services/dispatchAuthority makes an UNDECLARED dispatch unrepresentable,
// and this module is what turns the router's verdict into a declaration the user actually gets to
// veto. `routeMessage` no longer sends — it ARMS an intent here, the countdown becomes visible in
// the column, and only an expiry that the user did not cancel dispatches, carrying
// `{ kind: "countdown", intentId }`. That is the design's "never route silently" in one sentence.
//
// Why an armed timer and not a confirmation dialog: the router is right the overwhelming majority of
// the time, and a modal on every send would make the concierge unusable. A 3-second banner costs an
// attentive user nothing and costs a misrouted paragraph everything it was about to cost.
//
// PRESENCE OUTRANKS THE COUNTDOWN — the precedence rule, and the one piece of this module that is
// not obvious. The source spec contradicted itself (item 2: "unattended = sends"; item 4:
// destructive actions queue while Away). Both classify off APPROVAL_CATEGORIES, so the overlap is
// real and the two halves, each implemented correctly on its own, land a destructive command
// auto-dispatched to a machine nobody is sitting at. The resolution: while Away a DESTRUCTIVE
// intent's expiry QUEUES instead of dispatching; a routine one still sends. The 3s/5s tiers govern
// only while Here. See `shouldDispatchOnExpiry`.
//
// PRESENCE IS AN INJECTED GETTER, and it is REQUIRED — never defaulted. That is a safety property,
// not a style choice. An earlier draft had the call site pass a literal `"here"`; that fails OPEN, so
// a forgotten wiring step produces no type error, no lint signal and no failing test, and destructive
// intents simply fire at a machine nobody is sitting at. Exactly backwards from the philosophy of
// `dispatchAuthority`, which exists to make the unsafe call unrepresentable. So `presence` is a
// required field on `ArmIntentSpec` (a missing one is a compile error), and the two places that
// reason about an ABSENT answer — `shouldDispatchOnExpiry`'s `default` arm, and a getter that throws
// — both resolve to `"away"`, the queueing side.
//
// It is read as a GETTER, evaluated AT EXPIRY rather than at arm time: the user can walk away during
// the very seconds the countdown is running, which is precisely the window the rule exists to cover.
import { classifyDispatch, dispatchDelayMs, type DispatchClass } from "./dispatchClass";
import type { DispatchAuthority } from "./dispatchAuthority";
import { oneLine } from "../components/promptHistory";

/**
 * Is the user at the machine?
 *
 * Structurally identical to `stores/presenceStore.PresenceMode`, and declared here rather than
 * imported so this module stays free of the store (it is a pure rule engine, driven in tests by a
 * plain function). The host's getter returns the store's `mode` directly — no adapter.
 */
export type DispatchPresence = "here" | "away";

/**
 * Where an intent is in its life.
 *
 * - `armed` — PRESENTED to the user: either counting down, or (when `needsConfirmation`) sitting in
 *   the banner waiting for an explicit click. Exactly one intent is ever in this state by way of
 *   re-presentation; see `presentNextQueued`.
 * - `queued` — held back by the precedence rule. NO timer, still retrievable, still carrying its
 *   text. Survives until the `away → here` transition re-presents it.
 *
 * The distinction matters because "queued" must not be confusable with "dropped". A test that only
 * asserts "did not send" passes against an implementation that silently threw the user's message
 * away, so the queue is a real, inspectable place (`queuedIntents`) rather than the absence of one.
 */
export type IntentStatus = "armed" | "queued";

/**
 * How old a queued intent may get before returning is no longer enough to send it.
 *
 * Ten minutes. The countdown's bargain is "you saw this go past and chose not to stop it" — after a
 * long absence the user has no memory of the message to hold up against it, so re-arming a timer
 * would be asking them to veto something they no longer recognise, in 5 seconds, from a standing
 * start. Past this age the intent re-presents with NO timer and dispatches only on an explicit
 * click. See `presentIntent`.
 */
export const STALE_INTENT_MS = 10 * 60 * 1000;

/** One send, either counting down or held. */
export interface DispatchIntent {
  id: string;
  /** The exact wire payload the expiry will dispatch (attachment paths included). */
  text: string;
  /**
   * The same message as the USER wrote it — no attachment temp paths.
   *
   * Separate from `text` because `text` is `attachedPayload`, which prefixes each attachment's
   * quoted temp path so the agent can read the file. That string must never be shown or spoken:
   * quoting it verbatim makes the banner announce
   * `I'll tell Kraken Auth: "'/var/folders/x9/T/sparkle-shot-1753.png' what is wrong here?"`.
   * `ConciergeHost` computes the clean rendering one line from the arm site, so carry it rather
   * than re-deriving it — the host restates this invariant three times ("The temp paths must never
   * reach any of them but the first").
   */
  display: string;
  targetAgentId: string;
  /**
   * The agent's name as it was when the intent armed.
   *
   * SNAPSHOT, not a live lookup: the banner names a specific agent to the user ("I'll tell Kraken
   * Auth…"), and re-resolving the name at render time would let a rename mid-countdown change what
   * the user is being asked to approve. Beyond the design's five fields for exactly that reason.
   */
  targetName: string;
  class: DispatchClass;
  status: IntentStatus;
  /**
   * When the user first sent this. NEVER rewritten — it is the intent's AGE, which is what staleness
   * and queue order are about. Distinct from `countdownStartedAt` on purpose: a re-presented intent
   * gets a fresh countdown but does not get younger.
   */
  armedAt: number;
  /** When the CURRENT countdown began. Equal to `armedAt` on the first arm; reset on each
   *  re-presentation, which is what makes the returning user's countdown a full one. */
  countdownStartedAt: number;
  /**
   * This intent came back from the queue too old to auto-send (see `STALE_INTENT_MS`). It has no
   * timer and NOTHING will dispatch it but an explicit `confirmIntent`.
   */
  needsConfirmation: boolean;
  /** Live only while counting down; nulled the instant the timer fires, queues, or is cancelled. */
  timerId: ReturnType<typeof setTimeout> | null;
}

/** What an expiry did — returned by `fireIntent` so a caller (and a test) can assert on it. */
export type IntentOutcome = "dispatched" | "queued" | "unknown";

/**
 * THE PRECEDENCE RULE. Does this intent's expiry send, or does it queue?
 *
 * Pure and total, so the rule is one testable expression rather than an `if` buried in a timer
 * callback. Read it as: the countdown tiers are a courtesy to someone who is watching. When nobody
 * is watching, "destructive" stops meaning "wait 5s" and starts meaning "don't".
 */
export function shouldDispatchOnExpiry(
  intent: Pick<DispatchIntent, "class">,
  presence: DispatchPresence,
): boolean {
  switch (presence) {
    case "here":
      // Someone is at the machine and had the full tier to cancel. Both classes send.
      return true;
    case "away":
      // Unattended: routine still sends (design item 2 stands), destructive holds (item 4 wins).
      return intent.class !== "destructive";
    default: {
      const unhandled: never = presence;
      void unhandled;
      // An unknown presence is not evidence that anyone is watching. Fail to the safe side.
      return intent.class !== "destructive";
    }
  }
}

/** Read a presence getter that might throw. A getter is someone else's code (a store read, a hook
 *  escape hatch); if it fails we know NOTHING about whether anyone is watching, and "I don't know"
 *  has to mean "away" for the same reason the `default` arm above does. */
function readPresence(get: () => DispatchPresence): DispatchPresence {
  try {
    return get();
  } catch {
    return "away";
  }
}

/** Has this intent been waiting long enough that returning shouldn't silently send it? */
export function isStale(intent: Pick<DispatchIntent, "armedAt">, now: number): boolean {
  return now - intent.armedAt >= STALE_INTENT_MS;
}

/** How long this intent has left, floored at 0. Exported for the banner's live counter.
 *  Measured from `countdownStartedAt`, so a re-presented intent shows its FRESH window rather than a
 *  long-expired one. */
export function remainingMs(
  intent: Pick<DispatchIntent, "class" | "countdownStartedAt">,
  now: number,
): number {
  return Math.max(0, intent.countdownStartedAt + dispatchDelayMs(intent.class) - now);
}

/** The counter as the banner shows it: whole seconds, and never 0 while the send is still pending
 *  (a banner reading "Sending in 0…" for the last fraction of a second reads as already gone). */
export function remainingSeconds(
  intent: Pick<DispatchIntent, "class" | "countdownStartedAt">,
  now: number,
): number {
  return Math.ceil(remainingMs(intent, now) / 1000);
}

/**
 * What the user is about to have said on their behalf, in plain language.
 *
 * QUOTED rather than folded into the sentence ("I'll tell X to <text>"). The design's example
 * sentence reads well for an instruction — "I'll tell Kraken Auth to ship the DMG" — and reads as
 * broken English for the terse answers that are the actual bug ("I'll tell Kraken Auth to yes").
 * The colon form is grammatical for both, and quoting also makes the boundary of the message
 * visible, which matters when the whole point is "is this really what you meant to send there?".
 *
 * `oneLine` collapses the newlines (the same treatment the deferred-outcome lines give quoted text)
 * and this ELIDES past `MAX_QUOTED_CHARS` on top of it — `oneLine` bounds nothing, so a pasted
 * paragraph would otherwise run the banner down the column and push its own Cancel button out of
 * reach, which is a real failure when the button is the entire point of the banner.
 */
export function countdownSentence(intent: Pick<DispatchIntent, "display" | "targetName">): string {
  return `I'll tell ${intent.targetName}: “${elide(oneLine(intent.display))}”.`;
}

/** How much of the message the banner quotes before eliding. Enough to recognise a misroute by,
 *  short enough that the banner stays one or two lines. */
export const MAX_QUOTED_CHARS = 120;

function elide(text: string): string {
  return text.length <= MAX_QUOTED_CHARS ? text : `${text.slice(0, MAX_QUOTED_CHARS - 1)}…`;
}

/**
 * The banner's full announcement. One string so the live region and the visible banner can never
 * describe different sends.
 *
 * TWO SHAPES, because there are two states worth hearing and they call for opposite actions. A
 * counting-down intent says how long is left ("stop this if it's wrong"); a stale one, back from the
 * queue, says nothing is happening until you say so ("nothing will move unless you act"). Reading
 * the countdown wording over an intent with no timer would be the worst of both — a deadline that
 * never arrives, on the one path that is specifically supposed to have none.
 */
export function countdownAnnouncement(
  intent: Pick<
    DispatchIntent,
    "display" | "targetName" | "class" | "countdownStartedAt" | "needsConfirmation"
  >,
  now: number,
): string {
  if (intent.needsConfirmation) {
    return `${countdownSentence(intent)} You were away when this came up, so I've held it — send it when you're ready.`;
  }
  return `${countdownSentence(intent)} Sending in ${remainingSeconds(intent, now)}…`;
}

/** What arming a send needs to know. */
export interface ArmIntentSpec {
  text: string;
  /** The user-facing rendering, WITHOUT attachment temp paths. See `DispatchIntent.display`. */
  display: string;
  targetAgentId: string;
  targetName: string;
  /**
   * Presence AT EXPIRY. A getter, not a value, and REQUIRED — see the header. The production caller
   * passes `() => usePresenceStore.getState().mode`. There is deliberately no default: a defaulted
   * `"here"` is the fail-open hole this whole module is built to close.
   */
  presence: () => DispatchPresence;
  /**
   * This intent has come back from the queue and is in front of the user again.
   *
   * Optional because it only fires on the return path. The host uses it to feed the column's single
   * live region — a re-presented send nobody announces is exactly as silent as the forwarding bug.
   */
  onRepresent?: (intent: DispatchIntent) => void;
  /** Deliver the text. Handed the authority so the call site cannot invent its own. */
  onDispatch: (intent: DispatchIntent, authority: DispatchAuthority) => void;
  /** The precedence rule chose to hold this one (destructive, and nobody is here). */
  onQueue: (intent: DispatchIntent) => void;
  /**
   * The user hit Cancel. Nothing was delivered.
   *
   * REQUIRED, not optional. A send carries more than its text — staged attachments, the
   * spoken-turn latch, a draft the compose box cleared on submit — and every one of those has to be
   * handed back when the send doesn't happen. An optional callback here is an invitation to arm a
   * send and quietly cost the user their files, which is the same class of bug as the silent
   * forward this module exists to fix.
   */
  onCancel: (intent: DispatchIntent) => void;
  /** Override the tier. Tests only — production classifies off the text (see dispatchClass). */
  class?: DispatchClass;
}

let intentSeq = 0;

interface Entry {
  intent: DispatchIntent;
  spec: ArmIntentSpec;
}

/** Every live intent, armed and queued alike. ONE registry, not two: a queued intent is the same
 *  object in a different state, and splitting them into separate maps is how "queued" quietly
 *  becomes "dropped" the first time a code path forgets the second map exists. */
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

/**
 * The subscribe/snapshot pair React reads through `useSyncExternalStore`.
 *
 * `snapshot` is rebuilt ONLY on mutation and returned by identity in between, because
 * `useSyncExternalStore` re-renders whenever the snapshot's identity changes — building a fresh
 * array per call would spin forever.
 */
let snapshot: readonly DispatchIntent[] = [];
let queuedSnapshot: readonly DispatchIntent[] = [];

function byAge(a: DispatchIntent, b: DispatchIntent): number {
  return a.armedAt - b.armedAt;
}

function republish(): void {
  const all = [...entries.values()].map((e) => e.intent);
  // Oldest first: the order the sends were made, which is the order they will fire.
  snapshot = all.filter((i) => i.status === "armed").sort(byAge);
  queuedSnapshot = all.filter((i) => i.status === "queued").sort(byAge);
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A subscriber's failure must never strand a timer that is still counting down.
    }
  }
}

export function subscribeIntents(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Every intent currently PRESENTED to the user — counting down, or awaiting confirmation. Oldest
 *  first, stable identity between mutations. This is what the banner renders. */
export function armedIntents(): readonly DispatchIntent[] {
  return snapshot;
}

/**
 * Every intent the precedence rule is holding, oldest first.
 *
 * Exported so "queued" is a place you can look rather than an inference from an absence — the test
 * that a destructive send survives an Away expiry asserts against THIS, which is what makes it fail
 * against an implementation that dropped the message instead of holding it.
 */
export function queuedIntents(): readonly DispatchIntent[] {
  return queuedSnapshot;
}

/** One intent by id whatever its state, or null once it has dispatched or been cancelled. */
export function getIntent(id: string): DispatchIntent | null {
  return entries.get(id)?.intent ?? null;
}

/**
 * Arm a send: classify it, start its timer, publish it to the banner.
 *
 * Returns the intent so the caller can announce it. Does NOT deliver anything itself — delivery is
 * the `onDispatch` callback's job, which is what keeps this module free of the dispatch layer and
 * unit-testable with fake timers alone.
 */
export function armIntent(spec: ArmIntentSpec): DispatchIntent {
  const id = `intent-${(intentSeq += 1)}`;
  const cls = spec.class ?? classifyDispatch(spec.text);
  const now = Date.now();
  const intent: DispatchIntent = {
    id,
    text: spec.text,
    display: spec.display,
    targetAgentId: spec.targetAgentId,
    targetName: spec.targetName,
    class: cls,
    status: "armed",
    armedAt: now,
    countdownStartedAt: now,
    needsConfirmation: false,
    timerId: null,
  };
  intent.timerId = setTimeout(() => fireIntent(id), dispatchDelayMs(cls));
  entries.set(id, { intent, spec });
  republish();
  return intent;
}

/**
 * The user said no. Clears the timer and drops the intent; nothing is ever delivered.
 *
 * Returns the intent that was cancelled, or null when there was nothing to cancel — a second click
 * on a Cancel button that is mid-unmount, or a cancel racing the expiry, is a no-op rather than an
 * error. The caller uses the return to decide whether to say anything, so a double-cancel can't post
 * "I didn't send that" twice.
 */
export function cancelIntent(id: string): DispatchIntent | null {
  const entry = entries.get(id);
  if (!entry) return null;
  if (entry.intent.timerId !== null) clearTimeout(entry.intent.timerId);
  entry.intent.timerId = null;
  entries.delete(id);
  republish();
  // AFTER the removal, for the same reason `fireIntent` removes first: the callback restores
  // attachments and posts to the thread, either of which can re-enter this module.
  entry.spec.onCancel(entry.intent);
  // Cancelling the presented intent is one of the ways "the head resolves", so the queue behind it
  // moves up. Without this, declining one held send would strand every send behind it forever.
  presentNextQueued();
  return entry.intent;
}

/**
 * The countdown elapsed. Apply the precedence rule and either deliver or hold.
 *
 * Exported so a test can fire an intent without leaning on timer plumbing, and so a future caller
 * (a "send now" button on the banner) has a legitimate way in. Removes the intent FIRST: both
 * callbacks can re-enter this module, and an intent still in the map during its own dispatch is one
 * a stray cancel could pretend to stop after the keystroke had already landed.
 */
export function fireIntent(id: string): IntentOutcome {
  const entry = entries.get(id);
  if (!entry) return "unknown";
  // A held or awaiting-confirmation intent has no deadline to elapse. Only `confirmIntent` moves
  // one of those, and refusing here means no stray timer, retry or re-entrant call can turn "the
  // user must say yes" back into "it went on its own".
  if (entry.intent.status !== "armed" || entry.intent.needsConfirmation) return "unknown";
  if (entry.intent.timerId !== null) clearTimeout(entry.intent.timerId);
  entry.intent.timerId = null;

  if (!shouldDispatchOnExpiry(entry.intent, readPresence(entry.spec.presence))) {
    // HELD, NOT DROPPED. The intent stays in the registry with its text intact, reachable through
    // `queuedIntents`, until the return-from-Away re-presents it. Deleting it here would satisfy
    // "did not send" while losing the user's message — the failure this branch exists to make
    // impossible, wearing a different hat.
    entry.intent.status = "queued";
    republish();
    entry.spec.onQueue(entry.intent);
    return "queued";
  }

  // Dispatching, so the intent is finished: remove FIRST, because both callbacks can re-enter this
  // module and an intent still in the map during its own dispatch is one a stray cancel could
  // pretend to stop after the keystroke had already landed.
  entries.delete(id);
  republish();
  // The ONLY place a `countdown` authority is minted. It names this intent, so a forwarding
  // complaint resolves to the exact send the user watched and did not cancel.
  entry.spec.onDispatch(entry.intent, { kind: "countdown", intentId: entry.intent.id });
  // The head resolved — whatever is behind it may now take the banner.
  presentNextQueued();
  return "dispatched";
}

/**
 * Put a held intent back in front of the user with a FRESH countdown — or, if it has gone stale,
 * with none at all.
 *
 * Internal. The only two ways in are `resumeQueuedIntents` (the away → here edge) and the tail of
 * `fireIntent`/`cancelIntent` (the head resolved).
 */
function presentIntent(entry: Entry): void {
  const now = Date.now();
  const stale = isStale(entry.intent, now);
  entry.intent.status = "armed";
  entry.intent.countdownStartedAt = now;
  entry.intent.needsConfirmation = stale;
  // A stale intent gets NO timer. That is the whole rule: nothing but a click can send it.
  entry.intent.timerId = stale
    ? null
    : setTimeout(() => fireIntent(entry.intent.id), dispatchDelayMs(entry.intent.class));
  republish();
  entry.spec.onRepresent?.(entry.intent);
}

/**
 * Move ONE held intent into the banner, if the banner is free and the user is back.
 *
 * ONE AT A TIME, and this is the correction that matters most. The queue is plural and unbounded,
 * but the column has a single `role="status"` announcer. Re-arming N held intents together would
 * announce one of them and let the rest run their 3–5 seconds out unheard and then dispatch — the
 * exact "a destructive command fired without the user seeing it" failure this design removes,
 * recreated on the return edge. So the head arms alone, and the next one only after it resolves.
 */
function presentNextQueued(): void {
  // Something is already in front of the user — including an intent awaiting confirmation, which
  // occupies the banner indefinitely. Wait for it.
  for (const e of entries.values()) if (e.intent.status === "armed") return;
  const next = [...entries.values()]
    .filter((e) => e.intent.status === "queued")
    .sort((a, b) => byAge(a.intent, b.intent))[0];
  if (!next) return;
  // Still away: presenting now would start a countdown nobody is watching, which is what queueing
  // was for. Re-checked per intent rather than taken as an argument so a presence flip DURING the
  // drain (the user turns away again after two sends) stops the drain at that point.
  if (readPresence(next.spec.presence) !== "here") return;
  presentIntent(next);
}

/**
 * The user is back. Start draining the held queue.
 *
 * Called from the `away → here` edge. Presents only the head; each subsequent intent follows as the
 * one before it dispatches, is confirmed, or is cancelled.
 */
export function resumeQueuedIntents(): void {
  presentNextQueued();
}

/**
 * The user clicked Send on an intent that came back too old to auto-send.
 *
 * Gives it an ordinary countdown rather than dispatching on the spot, so the last thing between a
 * ten-minute-old destructive message and a terminal is still a window with a Cancel button in it.
 * Returns the intent, or null if there was nothing awaiting confirmation under that id.
 */
export function confirmIntent(id: string): DispatchIntent | null {
  const entry = entries.get(id);
  if (!entry || !entry.intent.needsConfirmation) return null;
  entry.intent.needsConfirmation = false;
  entry.intent.status = "armed";
  entry.intent.countdownStartedAt = Date.now();
  if (entry.intent.timerId !== null) clearTimeout(entry.intent.timerId);
  entry.intent.timerId = setTimeout(() => fireIntent(id), dispatchDelayMs(entry.intent.class));
  republish();
  return entry.intent;
}

/** Drop every intent, armed and queued, WITHOUT delivering or reporting. Test teardown and app
 *  shutdown only — a production cancel goes through `cancelIntent` so the user is told. */
export function clearAllIntents(): void {
  for (const entry of entries.values()) {
    if (entry.intent.timerId !== null) clearTimeout(entry.intent.timerId);
    entry.intent.timerId = null;
  }
  entries.clear();
  republish();
}
