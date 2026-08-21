// Regenerates the rolling summary of concierge turns that have aged out of the verbatim window.
//
// WHAT THIS IS NOT: it is not part of the turn. It never touches the live Claude Code session — no
// `--resume`, no `concierge_turn` — because advancing or disturbing that session is the exact thing
// the continuity work exists to protect. It is a separate one-shot on the user's own subscription
// (`chatOnce`, tier `background`), and its failure is ALWAYS non-fatal: the previous summary is kept
// and the attempt is retried at the next threshold. A summariser that could break a reply would be
// a worse bug than the amnesia it mitigates.
import { chatOnce } from "./anthropic";
import {
  messagesOutsideWindow,
  CONTINUITY_MSG_MAX_LEN,
} from "../engine/conciergeContinuity";
import {
  useConciergeThreadSummaryStore,
  SUMMARY_REGEN_EVERY,
  SUMMARY_MAX_LEN,
} from "../stores/conciergeThreadSummaryStore";
import type { ConciergeMessage } from "../components/Concierge/types";

const SYSTEM = [
  "You maintain a running summary of an ongoing conversation between a founder and their assistant.",
  "You will be given the EXISTING summary (possibly empty) and the conversation turns that have",
  "since scrolled out of view. Return a single updated summary that folds the new turns into the old.",
  "",
  "Rules:",
  "- Preserve anything the founder ASKED FOR and whether it was delivered, especially open asks.",
  "- Preserve decisions, stated preferences, and unresolved questions.",
  "- Drop pleasantries, status chatter, and anything already superseded.",
  "- Write terse bullet lines, newest concerns first. No preamble, no sign-off, no markdown headings.",
  `- Hard limit: ${SUMMARY_MAX_LEN} characters.`,
].join("\n");

/** Flatten one message for the summariser prompt — same one-line-per-message rule, and the same
 *  forgery reasoning, as `conciergeContinuity.flat`. */
function line(m: ConciergeMessage): string | null {
  if (m.kind !== "you" && m.kind !== "sparkle") return null;
  const body = (m.text ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!body) return null;
  return `${m.kind}: ${body.slice(0, CONTINUITY_MSG_MAX_LEN)}`;
}

/** How many out-of-window messages are NEWER than what the stored summary already covers. */
export function pendingSince(
  outside: ConciergeMessage[],
  throughMessageId: string | null,
): ConciergeMessage[] {
  if (!throughMessageId) return outside;
  const at = outside.findIndex((m) => m.id === throughMessageId);
  // Not found means the covered message has itself been evicted from the thread. Everything still
  // outside the window is then genuinely uncovered as far as we can prove, so summarise it all
  // rather than silently skipping turns — over-covering costs tokens, under-covering loses the ask.
  if (at < 0) return outside;
  return outside.slice(at + 1);
}

export function shouldRegenerate(
  chat: ConciergeMessage[],
  throughMessageId: string | null,
): boolean {
  return pendingSince(messagesOutsideWindow(chat), throughMessageId).length >= SUMMARY_REGEN_EVERY;
}

/** Wall-clock bound on the summariser's model call.
 *
 *  A background job that nothing awaits must still be able to END. Without this the call is an
 *  unbounded promise: `inFlight` never clears, so ONE wedged summariser silently disables
 *  summarisation for the rest of the session, and under test it hangs the runner outright (which is
 *  how this was found — a queue-cap case that enqueues 50 messages crosses the regeneration
 *  threshold and timed out at the suite level). */
export const SUMMARY_TIMEOUT_MS = 60_000;

/** Only ever ONE summariser at a time.
 *
 *  Without this, a burst of turns fires one `claude -p` per turn: the queue cap alone allows 50
 *  queued messages, every one of which crosses the threshold on its way through dispatch. They would
 *  race to write the same key, and the last writer — not the most complete one — would win. The
 *  guard makes the extra attempts free no-ops instead. */
let inFlight = false;

/** Backoff after a FAILED attempt — the in-flight latch above cannot cover this.
 *
 *  The failure path deliberately does not advance `throughMessageId` (see the `catch` below), which
 *  keeps the pending turns eligible for the next attempt. That is right for a transient failure and
 *  wrong for a STICKY one, because the threshold it is re-tested against stays crossed: once
 *  `pending.length >= SUMMARY_REGEN_EVERY`, it is true on the next turn too, and on every turn
 *  after. So a failure that will still be a failure in ten minutes gets a fresh model call per turn
 *  — the latch never fires, since each attempt has already ended before the next turn begins.
 *
 *  Measured (anonymised session logs, 2026-08-20): the summariser attempted and failed 7 times in
 *  under four minutes, each in ~500ms, every one against an exhausted subscription — a condition
 *  that clears on the order of hours, not seconds. Nothing was retried into success; the retries
 *  only spent the attempt.
 *
 *  Backing off on ANY failure (not just the quota sentinel) is deliberate: a genuinely transient
 *  failure is delayed by one base interval and then recovers, while a sticky one doubles away
 *  quickly. That needs no sentinel plumbed through the frontend, so there is no second place for
 *  the classification to drift. */
export const SUMMARY_FAILURE_BACKOFF_MS = 60_000;
/** Ceiling on the doubling. A quota window is hours long, so there is nothing to gain past this and
 *  a summary that is one interval stale is the cheaper error than a call that cannot succeed. */
export const SUMMARY_FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

let consecutiveFailures = 0;
let cooldownUntil = 0;

/** How long to wait after the `n`th consecutive failure. Exported for the test that pins the curve
 *  rather than re-deriving it. */
export function failureBackoffMs(failures: number): number {
  if (failures < 1) return 0;
  // 2**(n-1) grows past Number.MAX_SAFE_INTEGER for a long enough outage; `Math.min` handles that
  // correctly (Infinity clamps to the cap), but cap the exponent anyway so the intermediate stays a
  // number a reader can reason about.
  const doublings = Math.min(failures - 1, 20);
  return Math.min(SUMMARY_FAILURE_BACKOFF_MS * 2 ** doublings, SUMMARY_FAILURE_BACKOFF_MAX_MS);
}

/** Test seam: clears the in-flight latch and the failure backoff between cases. */
export function _resetThreadSummaryForTests(): void {
  inFlight = false;
  consecutiveFailures = 0;
  cooldownUntil = 0;
}

async function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // NOTE FOR THE NEXT READER: a `p.catch(() => {})` guard stood here to "claim the loser's
  // rejection" if the timeout won and the model call rejected afterwards. It was removed because it
  // could not matter — `Promise.race` calls `.then()` on EVERY input promise, so `p` always carries
  // a reaction and a late rejection is handled whether or not the race returned it. No test could
  // distinguish the two versions (the one written for it passed with the line deleted), and a guard
  // nothing can falsify is worse than none: it invites the next person to trust a mechanism that is
  // not doing anything. The unhandled rejection this file really had came from the default
  // parameter on `deps`, not from here.
  try {
    return await Promise.race([
      p,
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error("summariser timed out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Refresh the rolling summary if enough conversation has aged out since the last one.
 *
 * Resolves to `true` when a new summary was stored, `false` when nothing was due, one was already
 * running, or the attempt failed. Never throws — callers fire-and-forget it from a turn.
 */
export async function maybeRefreshThreadSummary(
  chat: ConciergeMessage[],
  // NOT a default parameter, and that is the whole point. `deps = { chat: chatOnce }` reads the
  // module binding BEFORE the function body runs, so the read happens outside the `try` below and
  // nothing here can catch it. Under vitest that is not hypothetical: accessing an export a
  // `vi.mock` factory omitted THROWS, and several ConciergeHost suites mock
  // `../services/anthropic` for their own reasons without listing `chatOnce`. The throw then
  // escaped as an unhandled rejection from a fire-and-forget call — 4651 tests passing and the
  // shard still red, because the rejection belongs to no test.
  //
  // Resolving it inside the try means a missing binding degrades exactly like a failed model call:
  // no summary this round, retried at the next threshold, turn unaffected.
  // `timeoutMs` is injectable for the same reason `chat` is: the production value is 60s, so a test
  // that cannot shorten it can never make the TIMEOUT win the race — and the late-rejection leak
  // below only exists on that branch. A guard for a path no test can reach is not a guard.
  // `now` is injectable for the same reason `timeoutMs` is, and it is ONE clock on purpose: the
  // same reader both SETS `cooldownUntil` on the failure path and TESTS it on the way in. Two
  // clocks (a real one to stamp, an injected one to compare) would leave a test unable to tell a
  // working gate from a broken one, because it could only control one side of the comparison.
  deps?: { chat?: typeof chatOnce; timeoutMs?: number; now?: () => number },
): Promise<boolean> {
  // The ONLY statement outside the try, because it is the only one that cannot throw: reading a
  // module-local boolean touches no import.
  if (inFlight) return false;

  // THE ELIGIBILITY WORK IS INSIDE THE TRY TOO, and for the same reason the `deps` default was
  // removed (roborev 62012). `useConciergeThreadSummaryStore` and `messagesOutsideWindow` are module
  // bindings, and a suite that mocks either module partially makes reading them THROW — the exact
  // vitest behaviour that produced the `chatOnce` unhandled rejection one module over. This function
  // promises above that it never throws, and every caller takes it at its word with a bare `void`,
  // so a statement that can throw must not sit outside the handler that keeps that promise. The
  // latch moves up with it: everything from here to the first `await` is synchronous, so no second
  // caller can observe the earlier set.
  inFlight = true;
  try {
    // BEFORE the eligibility work, and before any model call: a backoff that only took effect once
    // the thread was re-examined would still pay for the examination on every turn. Inside the try
    // because `deps.now` is caller-supplied and this function promises above that it never throws.
    const now = deps?.now ?? Date.now;
    if (cooldownUntil > 0 && now() < cooldownUntil) return false;

    const store = useConciergeThreadSummaryStore.getState();
    const outside = messagesOutsideWindow(chat);
    const pending = pendingSince(outside, store.throughMessageId);
    if (pending.length < SUMMARY_REGEN_EVERY) return false;

    const lines = pending.map(line).filter((l): l is string => l !== null);
    if (!lines.length) return false;
    const newest = pending[pending.length - 1];
    if (!newest) return false;

    const user = [
      "EXISTING SUMMARY:",
      store.text || "(none)",
      "",
      "NEW TURNS THAT SCROLLED OUT OF VIEW:",
      ...lines,
    ].join("\n");

    // Resolved here, not in a default parameter — see the note on `deps` above.
    const send = deps?.chat ?? chatOnce;
    const text = await withTimeout(
      send(SYSTEM, user, 1024, {
        purpose: "Summarising older concierge conversation",
        background: true,
      }),
      deps?.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    );
    if (!text.trim()) return false;
    useConciergeThreadSummaryStore.getState().set({
      text: text.trim(),
      throughMessageId: newest.id,
    });
    // A reply landed, so whatever was failing has stopped. Clearing the run here rather than at the
    // top of the call is what makes the backoff recover on its own: the next failure starts again at
    // one base interval instead of resuming a doubled one from an outage that is over.
    consecutiveFailures = 0;
    cooldownUntil = 0;
    return true;
  } catch {
    // Deliberately swallowed. The previous summary stays valid, `throughMessageId` does not
    // advance, and the same pending turns are retried — but no sooner than the backoff above, since
    // the threshold that made them eligible stays crossed and would otherwise re-fire every turn.
    // A thrown error here would surface as a failed TURN, which is not what happened.
    consecutiveFailures += 1;
    cooldownUntil = (deps?.now ?? Date.now)() + failureBackoffMs(consecutiveFailures);
    return false;
  } finally {
    inFlight = false;
  }
}
