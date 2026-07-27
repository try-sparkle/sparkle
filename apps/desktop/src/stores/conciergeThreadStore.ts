// conciergeThreadStore — the concierge's VISIBLE conversation, persisted across quit/relaunch
// (spec §3 subsystem C2, `docs/superpowers/specs/2026-07-27-concierge-control-design.md`).
//
// Why this store exists: the thread was plain `useState` in `ConciergeHost`, so restarting the app
// wiped every bubble even though the conversation itself was still on disk in Claude Code's
// transcript. The model's memory is restored separately (`services/concierge.restoreConciergeSession`
// re-derives the session id from that transcript); this half restores what the user can SEE. Either
// alone is a half-fix: a remembering brain with an empty column reads as amnesia, and a full column
// whose brain has forgotten everything is worse.
//
// Scope, deliberately narrow: this owns the message list and nothing else. Typing state, the live
// region, digests, and nudges all stay in the host — they are derived from the live feed and are
// meaningless a restart later. `ConciergeHost` swaps one `useState` line for `useConciergeThread()`
// and is otherwise untouched, because that file is being edited on several branches at once.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ConciergeMessage } from "../components/Concierge/types";

// Keep the thread bounded so localStorage can't grow without limit, exactly as
// promptHistoryStore.PROMPT_HISTORY_MAX does. 200 messages is far more than anyone scrolls back
// through in a column this narrow, and the trim is from the FRONT — the newest turns are the ones
// worth restoring.
export const CONCIERGE_THREAD_MAX = 200;

// Cap each message's text too: count alone doesn't bound size. One pasted diff or a long brain reply
// can be tens of KB, and a handful of those would blow the ~5MB localStorage quota and make the
// persist write throw — which in zustand means the WHOLE store silently stops persisting, so the
// failure shows up as "my thread stopped surviving restarts" long after the message that caused it.
// Over-long text is TRUNCATED rather than dropped: unlike a ghost-completion candidate, a bubble the
// user actually sent still has to be there when they scroll back, just shorter.
export const CONCIERGE_MSG_MAX_LEN = 4000;

/** Marks a bubble whose text was clipped to fit {@link CONCIERGE_MSG_MAX_LEN}, so the restored thread
 *  admits it rather than silently presenting a truncated message as the whole thing. */
export const CONCIERGE_TRUNCATION_SUFFIX = "… (truncated)";

/** The message kinds that are CONVERSATION, i.e. the only ones worth writing to disk.
 *
 *  `you` and `sparkle` are the two halves of the dialogue. Everything else a `ConciergeMessage` can
 *  be is a rendering of live state at a moment that has passed:
 *   - `digest` / `nudge` are re-derived from the feed on every render and never enter the host's
 *     `chat` array at all (they are concatenated in at the view-model, see ConciergeHost's `model`).
 *   - `recap` is the return-from-Away briefing: a DIFF between two feed snapshots, whose lines link
 *     to specific agent ids. Restored a day later it would announce that agents which no longer exist
 *     wanted something from you, and its "you were away 4 minutes" framing would be a lie about the
 *     current session. It does enter `chat`, so it is filtered HERE rather than upstream.
 *   - `batch` is a "all projects calm" divider — a statement about now.
 *
 *  Allowlist, not a blocklist, on purpose: a new derived kind added to `ConciergeMessage` later must
 *  opt IN to being persisted, so the default for anything feed-derived is correct without anyone
 *  remembering this rule. */
const PERSISTED_KINDS = ["you", "sparkle"] as const;

type PersistedKind = (typeof PERSISTED_KINDS)[number];

function isConversation(m: ConciergeMessage): m is Extract<ConciergeMessage, { kind: PersistedKind }> {
  return (PERSISTED_KINDS as readonly string[]).includes(m.kind);
}

/** Clip one message to the length cap, preserving its identity and kind. */
function clip<T extends { text: string }>(m: T): T {
  if (m.text.length <= CONCIERGE_MSG_MAX_LEN) return m;
  return { ...m, text: m.text.slice(0, CONCIERGE_MSG_MAX_LEN) + CONCIERGE_TRUNCATION_SUFFIX };
}

/**
 * Reduce a live thread to what belongs in localStorage: conversation only, newest
 * {@link CONCIERGE_THREAD_MAX} kept, each clipped to {@link CONCIERGE_MSG_MAX_LEN}.
 *
 * Exported so the caps are testable without going through zustand's persist middleware, and so the
 * ordering guarantee is pinned in one place: the result stays OLDEST-FIRST, matching
 * `ConciergeViewModel.messages`. (promptHistoryStore is newest-first because it is a lookup table;
 * this is a transcript, and reversing it would render the conversation backwards.)
 */
export function persistableThread(chat: ConciergeMessage[]): ConciergeMessage[] {
  const conversation = chat.filter(isConversation).map(clip);
  // Trim from the FRONT: drop the oldest turns, keep the tail the user is actually looking at.
  return conversation.length > CONCIERGE_THREAD_MAX
    ? conversation.slice(conversation.length - CONCIERGE_THREAD_MAX)
    : conversation;
}

/** Namespace every restored message id lands in. See {@link rehydrateThread} for why it must exist. */
export const RESTORED_ID_PREFIX = "restored:";

/**
 * Turn a persisted thread into one that is SAFE to mix with a fresh session's messages.
 *
 * Persistence created an id-collision hazard that did not exist when the thread died with the page,
 * and it is not cosmetic. `ConciergeHost` mints ids from a module-level counter that restarts at 0 on
 * every page load (`nextId` → `you-1`, `sparkle-1`, `err-1`, `recap-1`) and keys streamed brain
 * replies as `brain-<rust turn id>`, where `concierge.rs`'s turn sequence also restarts with the
 * process. So after a restart a brand-new turn regenerates ids a restored bubble already holds — and
 * the streaming upsert finds its bubble with `prev.findIndex((m) => m.id === k)`. It would locate the
 * RESTORED message and overwrite it in place: the new reply appears in the middle of the thread on top
 * of an old one, and no new bubble is ever appended. Duplicate React keys on top of that.
 *
 * Reindexing BY POSITION rather than prefixing the original id is deliberate: prefixing is not
 * idempotent across generations. Session 1 persists `you-1`; session 2 restores it as
 * `restored:you-1`, mints its own `you-1`, and persists both; session 3 would then restore two
 * messages that both want the id `restored:you-1`. Position is unique within the array by
 * construction, so this converges no matter how many restarts stack up.
 *
 * The original id is discarded on purpose — nothing needs it. It is a React key, a lookup target for
 * the live turn being streamed (which by definition is not a restored one), and a key into
 * `sentTextRef`, which starts empty after a restart.
 *
 * `redirectable` is cleared for the same class of reason: only the newest routed message is supposed
 * to offer the one-tap redirect, and after a restart every restored receipt is old. Leaving it set
 * would render a redirect button whose backing text (`sentTextRef`) no longer exists — a dead
 * affordance, until the next send happens to clear it.
 */
export function rehydrateThread(chat: ConciergeMessage[]): ConciergeMessage[] {
  return chat.map((m, i) => {
    const next = { ...m, id: `${RESTORED_ID_PREFIX}${i}` };
    return next.kind === "you" && next.receipt?.redirectable
      ? { ...next, receipt: { ...next.receipt, redirectable: false } }
      : next;
  });
}

interface ConciergeThreadState {
  /** The thread, OLDEST FIRST — the same order `ConciergeViewModel.messages` wants. */
  chat: ConciergeMessage[];
  /** Replace the thread. Accepts an updater so it is a drop-in for the `useState` setter the host
   *  used to hold (every existing call site is `setChat((prev) => …)`). */
  setChat: (next: ConciergeMessage[] | ((prev: ConciergeMessage[]) => ConciergeMessage[])) => void;
  /** Drop the whole visible thread (pairs with `resetConciergeSession` for a full "start over"). */
  clearChat: () => void;
}

export const useConciergeThreadStore = create<ConciergeThreadState>()(
  persist(
    (set) => ({
      chat: [],
      setChat: (next) =>
        set((s) => ({ chat: typeof next === "function" ? next(s.chat) : next })),
      clearChat: () => set({ chat: [] }),
    }),
    {
      name: "sparkle-concierge-thread",
      storage: createJSONStorage(() => localStorage),
      // Filter and cap on the way OUT, not on the way in. Live state stays complete — the recap card
      // and an un-clipped long reply must render normally for the session that produced them; it is
      // only the durable copy that is reduced. Doing it in the reducer instead would mean the cap
      // visibly ate messages out from under the user mid-session.
      partialize: (s) => ({ chat: persistableThread(s.chat) }),
      // Restored messages have to be made collision-safe against the ids a fresh session will mint —
      // see rehydrateThread. This is the one hook that sees the persisted payload, so it is where the
      // reindex has to happen; doing it lazily at first render would be too late for the first turn.
      merge: (persisted, current) => ({
        ...current,
        chat: rehydrateThread((persisted as { chat?: ConciergeMessage[] } | undefined)?.chat ?? []),
      }),
    },
  ),
);

/** Subscribe to the thread. The read half of the seam that replaced `ConciergeHost`'s `useState`. */
export function useConciergeThread(): ConciergeMessage[] {
  return useConciergeThreadStore((s) => s.chat);
}

/**
 * The write half — and MODULE-SCOPED on purpose, not returned from the hook.
 *
 * `useState`'s setter is on `react-hooks/exhaustive-deps`' known-stable list; a setter pulled out of a
 * store with `useConciergeThreadStore((s) => s.setChat)` is not, so returning it from the hook made
 * the rule demand it in five dependency arrays inside `ConciergeHost` — five more lines of churn in a
 * file being edited on two sibling branches, for a function that is in fact created once and never
 * changes. A module-scope import isn't a reactive value at all, so the rule correctly ignores it and
 * the host's diff stays at the one line where the `useState` used to be.
 *
 * Same signature as the setter it replaced, including the updater form, so every existing
 * `setChat((prev) => …)` call site is untouched.
 */
export const setConciergeChat: ConciergeThreadState["setChat"] = (next) =>
  useConciergeThreadStore.getState().setChat(next);
