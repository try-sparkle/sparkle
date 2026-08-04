// Concierge action RECEIPTS — the durable "here is what I actually did" line (bead sparkle-kr2jz).
//
// ══ WHY ═════════════════════════════════════════════════════════════════════════════════════════
// The founder: "You'll often tell me you're gonna do something and then you don't do it. So how do
// we make sure that this happens versus just trusting you?" Measured over all 19 concierge sessions
// (1,490 turns, 2026-07-26 → 08-04): of 45 first-person promises ("I'll spawn it", "I'll send it"),
// 35 were never carried out in the following turn — a 78% drop rate. Of 145 past-tense claims ("I
// sent it", "I closed it"), 32 had no matching tool call.
//
// He cannot check any of that today. The app has exactly one surface that says the concierge acted
// — `ThinkingIndicator`, which renders ONE line and erases it when the turn ends — so the moment a
// reply lands, "I sent it" and "I imagined sending it" look identical. Nine of his 31 recorded
// frustration turns are literally that sentence: "you said there was a message in the inbox … but I
// didn't see", "You said it's up. But I can't actually click on it", "I don't see the goal … so I
// don't think I believe you."
//
// A receipt makes the claim CHECKABLE instead of believed — and, just as importantly, makes the
// ABSENCE of one evidence. That is the whole design: not a better promise, an observable fact.
//
// ══ WHY THIS MODULE IS THE PLUMBING ONLY ════════════════════════════════════════════════════════
// It owns the TYPE and the fan-out, deliberately not the classification and not the rendering:
//
//   • WHICH ops earn a receipt, and what each one says → the classifier (services/conciergeReceipt*)
//   • WHERE a receipt is drawn                         → the concierge thread (components/Concierge)
//
// Splitting it this way is what lets the recorder sit at `controlListener.handleConciergeTool` —
// the ONE seam every `concierge_tool` call passes through, already carrying `noteConciergeToolCall`
// and `noteConciergeAuditCall` — without that file having to know anything about React.
//
// ══ FIRE-AND-FORGET, LIKE ITS TWO NEIGHBOURS ════════════════════════════════════════════════════
// `emit` swallows every listener failure, following `conciergeDispatch.onDeferredSendOutcome`
// ("A listener's failure must never break a delivery that already landed"). A receipt is a record
// of something that ALREADY HAPPENED; a broken renderer must not be able to un-happen it, and must
// never propagate back into the tool reply the concierge is waiting on.

/** What the concierge did. One entry per user-meaningful action — deliberately NOT one per op:
 *  `merge_pr` and `land_agent_branch` are both `merged` to the reader, and a vocabulary the human
 *  reads should be sized for them rather than for the registry. */
export type ConciergeActionKind =
  | "spawned"
  | "sent"
  | "closed"
  | "goal"
  | "filed"
  | "merged";

/** How a message reached an agent. The two channels behave differently enough that collapsing them
 *  would make the receipt lie by omission: a TERMINAL write lands in the agent's PTY immediately,
 *  while an INBOX message sits queued until that agent's next turn boundary and is invisible until
 *  then (bead sparkle-zm0c8). "Sent to X" without saying which one is exactly the ambiguity the
 *  founder has been burned by.
 *
 *  `held` is the third, and it exists because `terminal` was documented as landing IMMEDIATELY while
 *  the op returns ok on a path where it demonstrably does not: `conciergeDispatch` answers
 *  `{ok: true, path: "queued"}` when the PTY is not up yet — "held and will be sent the moment it is
 *  ready" — and that entry can still expire or be abandoned afterwards, which is the whole reason
 *  `onDeferredSendOutcome` exists. Sending to an agent the concierge just spawned is the COMMON way
 *  to hit it. A receipt reading "Sent to X's terminal" for a message merely held is the same
 *  sent-versus-actually-visible ambiguity this field was added to remove (roborev 57862). */
export type ConciergeSendChannel = "terminal" | "inbox" | "held";

/** One thing the concierge did, as the human should be able to check it.
 *
 *  EVERY FIELD IS AN OBSERVATION, NEVER A PROMISE. This record is minted from the tool reply, after
 *  the call resolved — so `ok: false` is a real and expected value, and a refused action gets a
 *  receipt too. That is not a detail: "I couldn't" is the answer to "why didn't it do the thing I
 *  asked", and suppressing it would rebuild the silence this module exists to end. */
export interface ConciergeActionReceipt {
  /** Stable within a session; the renderer keys on it so a re-render cannot duplicate a line. */
  id: string;
  kind: ConciergeActionKind;
  /** Did the action actually succeed? Taken from the dispatch reply's own `ok`, never assumed. */
  ok: boolean;
  /** The agent this was done TO, when there is one. `agentId` is what makes the line clickable —
   *  a receipt naming an agent the reader cannot open is the "you said it's up, but I can't click
   *  on it" complaint restated. */
  agentId?: string;
  agentName?: string;
  /** For `sent`: which channel, because they are visible at different times (see the type above). */
  channel?: ConciergeSendChannel;
  /** This `sent` receipt is a FAN-OUT. Set by the classifier from the op, never inferred from a
   *  missing `agentId`: `channel: "inbox"` has two producers (`inbox_send` and `inbox_broadcast`),
   *  so a subject-less inbox receipt is just as likely to be a single send whose args were refused.
   *  Present without {@link queued}/{@link failed} on a broadcast REFUSAL, which carries no data. */
  fanout?: true;
  /** This `sent` receipt was a PICKER PRESS, not a message. `send_to_agent_terminal` can collapse
   *  onto pressing a button on the human's behalf (`path: "picker-option"`), which really does write
   *  to the PTY — so suppressing the receipt entirely would hide an action that happened, the false
   *  negative this module exists to prevent. It just must not be described as "sent a message"
   *  (roborev 57951). */
  viaPicker?: true;
  /** How many inboxes actually took the message, and how many refused it. `inboxBroadcast` reports
   *  a PARTIAL failure as an OK reply holding these — so a line keyed on `ok` alone would state flat
   *  delivery for a broadcast some inboxes rejected, a claim the tool never made. */
  queued?: number;
  failed?: number;
  /** For `filed`: the bead id, so the line can carry a real `BeadPill`. */
  beadId?: string;
  /** For `merged`: the PR number. */
  prNumber?: number;
  /** The refusal, when `ok` is false — the tool's own words, already human-fit at the registry. */
  reason?: string;
  /** Epoch ms, stamped by the recorder at the moment the call settled. */
  at: number;
  /** The `domain.op` behind this receipt. Carried for diagnostics and for a future audit join;
   *  the renderer must not key display off it — that is what {@link kind} is for. */
  op: string;
}

type ReceiptListener = (r: ConciergeActionReceipt) => void;

const listeners = new Set<ReceiptListener>();

/**
 * How many recent receipts are held for replay.
 *
 * Bounded because nothing else prunes this, and generous because the window it has to cover is a
 * human one: the founder closes his last project, the concierge's in-flight `merge_pr` settles, and
 * he opens a project again minutes later. Sized well above any plausible burst in that window (a
 * broadcast is the largest, and it is one receipt per agent).
 */
const REPLAY_MAX = 64;

/** Recent receipts, oldest first. See {@link onConciergeActionReceipt} for why this exists. */
const recent: ConciergeActionReceipt[] = [];

/**
 * Subscribe to concierge action receipts, receiving any that were recorded BEFORE this subscription.
 * Returns an unsubscribe fn.
 *
 * ══ WHY IT REPLAYS, WHICH IS NOT AN OPTIMISATION ════════════════════════════════════════════════
 * roborev 57866 (Medium). The subscriber is `ConciergeHost`, and `App.tsx` says in as many words
 * that "ConciergeHost unmounts when no project is open" — it is the stated reason `ApiRecovery` is
 * mounted as a SIBLING of the columns rather than inside it. Receipts settle on the tool return
 * path, independently of what is rendered, so a `merge_pr` or `spawn_build_agent` issued while the
 * column was up but settling after the last project closed was fanned out to an empty listener set
 * and lost with no trace.
 *
 * That is not an ordinary dropped notification. This feature's contract is that **the ABSENCE of a
 * receipt is itself evidence** — so a silently dropped receipt does not merely fail to report an
 * action, it manufactures FALSE NEGATIVE evidence that the action never happened. A feature built
 * to stop the founder being told things that aren't so must not be able to tell him one itself.
 *
 * The replay is what makes `ConciergeActionReceipt.id` load-bearing rather than decorative: a
 * subscriber that reconnects sees receipts it may already have drawn, and dedupes on that id.
 */
export function onConciergeActionReceipt(cb: ReceiptListener): () => void {
  listeners.add(cb);
  // Replayed BEFORE returning, so a subscriber cannot miss a receipt recorded between its mount and
  // its first render. Guarded per receipt for the same reason `recordConciergeActionReceipt` is: a
  // listener that throws on a replayed item must not cost the rest of the backlog, and must not
  // throw out of the caller's `useEffect`.
  for (const r of [...recent]) {
    try {
      cb(r);
    } catch (err) {
      console.warn("conciergeReceipts: listener threw on replay; the receipt still stands", err);
    }
  }
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Publish one receipt to every subscriber.
 *
 * NEVER THROWS — see this module's header. Each listener is isolated, so one broken subscriber
 * cannot cost the others their notification, and none of them can fail the tool call that produced
 * the receipt.
 */
export function recordConciergeActionReceipt(receipt: ConciergeActionReceipt): void {
  // Retained FIRST, so a receipt recorded while nothing is listening is still replayed to the next
  // subscriber. This is the half that makes a dropped receipt impossible rather than merely rare.
  recent.push(receipt);
  if (recent.length > REPLAY_MAX) recent.splice(0, recent.length - REPLAY_MAX);
  for (const cb of listeners) {
    try {
      cb(receipt);
    } catch (err) {
      console.warn("conciergeReceipts: listener threw; the receipt still stands", err);
    }
  }
}

/**
 * Drop the retained receipts. THE IDENTITY RESET CALLS THIS — see below.
 *
 * ══ THIS MODULE DOES HOLD PER-HUMAN STATE NOW, AND IT DID NOT BEFORE ════════════════════════════
 * roborev 57888 (Medium). The doc block below used to assert "THERE IS NO PER-HUMAN STATE IN THIS
 * MODULE", and the replay buffer made that false in the same commit that wrote it — a false claim at
 * the highest-authority location in the file, which is the exact defect this feature is about.
 *
 * `recent` holds agent names, PR numbers, bead ids and the tool's verbatim refusal `reason`: an index
 * of what the PREVIOUS human's concierge did. And its whole purpose is a replay path into the next
 * subscriber's thread — so a receipt never posted (precisely the unmounted-host case the replay
 * exists for, and sign-out is a moment the host is likely unmounted) would be delivered into the
 * next human's conversation on their first mount.
 *
 * That is the recurrence pattern `conciergeIdentityReset.ts` documents four prior instances of:
 * "a store is written with retained state, nothing is wired to call a clear, and it stays harmless
 * only until something gains a reader or a REPLAY PATH." It just gained one.
 */
export function clearConciergeReceiptBacklog(): void {
  recent.length = 0;
}

/**
 * Drop every subscriber. TESTS ONLY.
 *
 * ══ IT MUST NEVER BE WIRED INTO THE IDENTITY RESET, AND THE NAME IS PART OF THAT ═══════════════
 * `conciergeIdentityReset.ts` records the search that has found four of these so far: "grep for a
 * store-level `clear…`/`reset…` export and check whether anything outside its own module calls it",
 * and notes that adding a per-human concierge store is "one line here". An export called
 * `clearConciergeActionReceiptListeners` answers that grep and reads exactly like the next line to
 * add — so it is named `_reset…ForTests` instead, matching `_resetConciergeAuditForTests` and
 * `_resetConciergeForTests`, which is how this codebase already spells "not that kind of clear".
 *
 * Wiring it there would be a live bug, not a tidy-up. A LISTENER is per-MOUNT, owned by the
 * subscriber's own unmount — it is not per-human. (The module's per-human state is the replay
 * buffer, and `clearConciergeReceiptBacklog` above is what the identity reset calls for it.)
 *
 * `ConciergeHost` subscribes in a mount-time effect that does not re-run on sign-out, so clearing
 * the SET while it stays mounted would leave every later receipt emitted into an empty listener set
 * and silently never rendered: the precise "you said you did it and I can't see it" failure this
 * module exists to end, caused by the module itself. State that genuinely belongs to a human goes in
 * the backlog and is cleared there — never by dropping the subscriptions.
 */
export function _resetConciergeReceiptsForTests(): void {
  listeners.clear();
  // The replay buffer too, or one test's receipts are replayed into the next test's subscriber.
  recent.length = 0;
  // …and the posted-id set, which is the THIRD piece of module state here (roborev 57926). Every
  // receipts suite calls this reset and none of them knew to clear that separately, so a test
  // recording a receipt whose id a previous test had already "posted" would silently see it
  // suppressed — a leak that gets harder to spot the more suites use the module.
  postedReceiptIds.clear();
}

/**
 * Receipt ids already posted to the thread, so a REPLAY on remount cannot double a line.
 *
 * LIVES HERE, NOT IN `ConciergeHost` (roborev 57905). It was a module-level set in the component,
 * and wiring its clear into `resetConciergeIdentityState` made a SERVICE import a React module —
 * inverting the layering this file's own header states, and dragging ConciergeHost's ~80-import
 * graph into every test of the sign-out path.
 *
 * WHY IT IS CLEARED AT ALL, stated honestly: not to prevent a collision. `nextReceiptId` counts on a
 * process-lifetime counter that no reset touches, so a post-sign-out id can never equal a
 * pre-sign-out one. The ids simply name receipts that no longer exist once the backlog is dropped,
 * and keeping them is pointless residue.
 */
const postedReceiptIds = new Set<string>();

/** Has this receipt already been drawn? Records it as seen when it has not. */
export function claimReceiptForDisplay(id: string): boolean {
  if (postedReceiptIds.has(id)) return false;
  postedReceiptIds.add(id);
  return true;
}

/** Drop the posted-id set. Called by the identity reset alongside the backlog. */
export function clearPostedReceiptIds(): void {
  postedReceiptIds.clear();
}

let seq = 0;

/**
 * Mint a receipt id. A monotonic counter rather than a timestamp or a random value: two actions in
 * the same millisecond are ordinary (a broadcast is N sends), and a colliding key would make React
 * drop one of the lines — silently losing exactly the evidence this feature exists to produce.
 */
export function nextReceiptId(): string {
  seq += 1;
  return `receipt-${seq}`;
}
