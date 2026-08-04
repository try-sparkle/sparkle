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
// `countLines` is the line-count rule for a collapsed block, imported rather than re-derived so a
// clipped block's subtitle ("41 lines") counts the same way the pill that made it did.
import { countLines, type Attachment } from "../components/composer/attachments";
// The anchor-id rewrite lives with the module that owns what an anchor IS, for the same reason
// `countLines` is imported rather than re-derived: the rule and its persistence must not drift.
import { remapAnchors } from "../components/Concierge/replyAnchors";
// Same rule as `remapAnchors` and `countLines`: the RULE for what a lint mark is — and what bounds
// it — lives with the pure module that owns the wording, imported rather than re-derived so the
// live path and the persisted copy cannot disagree about it.
import { normalizeLintMarks } from "../components/Concierge/lintMarks";

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

type Conversation = Extract<ConciergeMessage, { kind: PersistedKind }>;

function isConversation(m: ConciergeMessage): m is Conversation {
  return (PERSISTED_KINDS as readonly string[]).includes(m.kind);
}

/**
 * Drop each attachment's `dataUrl` before the thread is written to disk, keeping the record itself.
 *
 * A sent message now carries the files that rode with it so the bubble can show them (PRD §8), and
 * an image attachment's `dataUrl` is base64 — a single retina screenshot is routinely 1–4 MB, which
 * is the whole ~5MB localStorage quota in one bubble. That is the exact failure {@link CONCIERGE_MSG_MAX_LEN}
 * exists to prevent, arriving through a field the text cap cannot see: the persist write throws,
 * zustand silently stops persisting the WHOLE store, and the symptom ("my thread stopped surviving
 * restarts") shows up long after the screenshot that caused it.
 *
 * The name/path/kind survive, so a restored bubble still says WHAT was sent — it renders as a chip
 * instead of a thumbnail (AttachmentStrip falls back on a missing `dataUrl`). Re-reading the
 * pixels back off disk isn't an option worth the quota: the paths are temp files that may be gone.
 */
function stripDataUrls(m: Conversation): Conversation {
  if (m.kind !== "you" || !m.attachments?.length) return m;
  return {
    ...m,
    attachments: m.attachments.map(withoutPreview),
  };
}

/**
 * Bound a reply's LINT MARKS on the way to disk — the fourth size axis, and the newest.
 *
 * ══ THE PERSISTENCE DECISION, STATED ONCE ═══════════════════════════════════════════════════════
 * A lint mark SURVIVES a restart. That is a deliberate call, and the opposite of the one
 * `ConciergeFailureMessage` gets — that kind is kept off {@link PERSISTED_KINDS} entirely because
 * "You've hit your session limit · resets 8:40am" is a claim about NOW, and restoring it tomorrow
 * morning would have the app assert something stale on its own initiative.
 *
 * A mark is not that kind of claim. It is a closed observation about a turn that has ended — "this
 * reply offered to act and no action ran in it" was true when it was recorded, and no later event
 * can make it false. The reply it annotates is persisted verbatim beside it, so the mark and its
 * subject age together or not at all. And the thing the founder is actually trying to see is a
 * PATTERN across turns (35 of 45 promises unkept over 1,490 turns); a mark that evaporated on every
 * relaunch would rebuild the invisibility the field exists to end.
 *
 * ══ SO IT IS BOUNDED, LIKE EVERY OTHER PERSISTED PAYLOAD ════════════════════════════════════════
 * `hedge-words` reports one violation PER HEDGING WORD, so a waffly reply can carry dozens, and the
 * rendered line collapses to one sentence plus a count regardless. Unbounded, that is the same
 * failure {@link CONCIERGE_MSG_MAX_LEN} and {@link stripDataUrls} exist to prevent, reaching through
 * a field the text cap cannot see: the persist write throws, zustand silently stops persisting the
 * WHOLE store, and the symptom shows up long after the reply that caused it.
 *
 * `normalizeLintMarks` is the same function {@link rehydrateThread} runs on the way back IN, so the
 * written copy and the restored copy are bounded by one rule rather than two that can drift.
 */
function boundLintMarks(m: Conversation): Conversation {
  if (m.kind !== "sparkle" || !m.lint?.length) return m;
  const lint = normalizeLintMarks(m.lint);
  // Identity preserved when nothing changed — the common case — for the reason `boundLiveThumbnails`
  // states: bubbles are memoised on identity, and rebuilding an untouched message re-renders it.
  //
  // COMPARED BY CONTENT, NOT BY LENGTH (roborev 57878/57851, Medium). `normalizeLintMarks` clips
  // `detail`, clips `check` and coerces a non-string `severity` — none of which change the array's
  // LENGTH. (An unrecognized STRING severity is deliberately passed through; see `sanitize`.) So a length-only shortcut computed the normalized copy and then threw it away, persisting
  // the ORIGINAL: the write-side bound was a no-op for every normalization except the count cap, which
  // contradicts this function's own reason for existing (one rule for the written and restored copies
  // rather than two that can drift) and left the restore path as the only real boundary.
  const unchanged =
    !!lint &&
    lint.length === m.lint.length &&
    lint.every((x, i) => {
      const before = m.lint![i]!;
      return (
        x.check === before.check && x.detail === before.detail && x.severity === before.severity
      );
    });
  return unchanged ? m : { ...m, lint };
}

/** Strip one attachment's preview, keeping the record that names it. Shared by the persistence cap
 *  and the live-retention cap below so the two can't disagree about what "a stripped attachment" is. */
function withoutPreview(a: Attachment): Attachment {
  return { id: a.id, kind: a.kind, path: a.path, name: a.name };
}

/** How many of the newest attachment-carrying messages keep their previews in MEMORY. Older bubbles
 *  degrade to chips, exactly as a restored one does. Six is well past what fits on screen in a column
 *  this narrow, so the thumbnail is still there for anything the reader can plausibly scroll back to. */
export const LIVE_THUMBNAIL_MESSAGES = 6;

/** …and how big any ONE retained preview may be, in base64 characters (~3 MB of string). */
export const LIVE_THUMBNAIL_MAX_CHARS = 4 * 1024 * 1024;

/** …and how much every retained preview may add up to, ACROSS messages and across the attachments
 *  within a message. Expressed as a multiple of the per-attachment cap because that is the
 *  relationship that matters: a single largest-allowed image still fits comfortably, while the
 *  aggregate can never reach the message-cap × attachment-cap product. Roughly 24 MB as UTF-16. */
export const LIVE_THUMBNAIL_TOTAL_CHARS = 3 * LIVE_THUMBNAIL_MAX_CHARS;

/**
 * Bound what the LIVE thread retains in memory, which is a different axis from the localStorage cap.
 *
 * `chat` is never trimmed while the session runs — {@link CONCIERGE_THREAD_MAX} and
 * {@link persistableThread} apply only in `partialize` — so once a sent message carries its own
 * attachments (PRD §8) every `you` bubble pins its base64 for the life of the process. Before that
 * change the string was released at send time, when `takeAttachments` cleared it and the composer
 * row unmounted.
 *
 * THREE caps, because each alone leaves the failure reachable:
 *
 *   - {@link LIVE_THUMBNAIL_MESSAGES} bounds how many bubbles keep previews at all.
 *   - {@link LIVE_THUMBNAIL_MAX_CHARS} bounds any ONE preview. Screenshots are downscaled in Rust
 *     (`screenshot.rs` PREVIEW_MAX_DIM = 1600), but a PICKED or DROPPED image is not:
 *     `attachments.rs` emits a `data_url` for any image up to `MAX_PREVIEW_BYTES` = 40 MB, i.e. a
 *     ~53 MB base64 string.
 *   - {@link LIVE_THUMBNAIL_TOTAL_CHARS} bounds the SUM (roborev 53786). Nothing limits attachments
 *     per message — `loadAttachmentPaths` and the composer load every dropped path — so with only
 *     the first two caps ONE drop of 20 photos pinned ~20 × 4M chars (~160 MB as UTF-16), and six
 *     such bubbles multiplied it. Same unbounded-retention failure this function exists to close,
 *     reached along a different axis.
 *
 * The retained bitmap matters as much as the string: the browser decodes at full resolution to draw
 * a 72 px thumbnail, so the aggregate governs decoded pixels too.
 *
 * Runs on every write, and returns the INPUT ARRAY UNCHANGED when nothing needed stripping — the
 * common case by far. Bubbles are memoized on identity, so rebuilding the array (or an untouched
 * message inside it) on every keystroke-driven write would re-render the whole thread.
 */
export function boundLiveThumbnails(chat: ConciergeMessage[]): ConciergeMessage[] {
  let budget = LIVE_THUMBNAIL_MESSAGES;
  let chars = LIVE_THUMBNAIL_TOTAL_CHARS;
  // Once the aggregate can't cover a preview, everything older is stripped rather than letting a
  // smaller straggler squeeze past a larger one — "the newest previews, until the budget runs out"
  // is a rule a reader can predict; best-fit is not.
  let exhausted = false;
  let out: ConciergeMessage[] | null = null;
  // Newest first: the budget is spent on the messages the reader is nearest to.
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]!;
    if (m.kind !== "you" || !m.attachments?.length) continue;
    // An already-stripped message costs nothing and must not consume the budget, or the cap would
    // ratchet down a message at a time across a long session.
    if (!m.attachments.some((a) => a.dataUrl !== undefined)) continue;
    const withinCount = budget > 0;
    budget -= 1;
    const next = m.attachments.map((a) => {
      if (a.dataUrl === undefined) return a;
      // The per-attachment cap is the FAST REJECT: an oversized preview is dropped whatever the
      // aggregate has left, and costs the aggregate nothing because nothing is retained. It also
      // must not exhaust the budget — one 40 MB paste would otherwise strip the whole thread.
      if (!withinCount || a.dataUrl.length > LIVE_THUMBNAIL_MAX_CHARS) return withoutPreview(a);
      if (exhausted || a.dataUrl.length > chars) {
        exhausted = true;
        return withoutPreview(a);
      }
      chars -= a.dataUrl.length;
      return a;
    });
    if (next.every((a, j) => a === m.attachments![j])) continue;
    out ??= chat.slice();
    out[i] = { ...m, attachments: next };
  }
  return out ?? chat;
}

/** Clip one message to the length cap, preserving its identity and kind. */
function clip<T extends { text: string }>(m: T): T {
  if (m.text.length <= CONCIERGE_MSG_MAX_LEN) return m;
  return { ...m, text: m.text.slice(0, CONCIERGE_MSG_MAX_LEN) + CONCIERGE_TRUNCATION_SUFFIX };
}

/** The CEILING on one collapsed payload — a backstop, not the working bound. The aggregate budget below
 *  is what actually holds the quota; this only stops a single pathological paste from eating all of it.
 *
 *  Deliberately WELL ABOVE `attachments.PILL_MIN_CHARS` (2000, the size at which a one-line paste
 *  collapses). A ceiling set AT that threshold truncates essentially every char-triggered pill by
 *  construction — a block exists because its text is already ≥2000 chars — so the canonical ~40-row
 *  brief would open onto its first 2000 characters after a restart with 58k of the budget unspent, and
 *  the `expired`/`abandoned` arms would be telling the user to re-send text the app had just clipped
 *  (roborev 55760). Matching {@link CONCIERGE_MSG_MAX_LEN} keeps a real brief whole and leaves the
 *  aggregate worst case below untouched. */
export const CONCIERGE_COLLAPSED_MAX_LEN = CONCIERGE_MSG_MAX_LEN;

/** …and how much every collapsed payload may add up to, ACROSS messages.
 *
 *  THE BOUND THAT MATTERS. The per-block ceiling alone leaves the failure wide open along the other
 *  axis — 200 receipts each carrying a capped block is ~800k chars (~1.6 MB as UTF-16) of one origin's
 *  ~5 MB, shared with every other persisted store (roborev 55746, the same shape as
 *  {@link LIVE_THUMBNAIL_TOTAL_CHARS} closing roborev 53786 for previews). Spent NEWEST-FIRST, like the
 *  preview budget, because "the newest payloads until the budget runs out" is a rule a reader can
 *  predict — and because it means a lone brief, the common case, is never clipped at all. */
export const CONCIERGE_COLLAPSED_TOTAL_CHARS = 60_000;

/** What an out-of-budget payload degrades to rather than vanishing: enough to identify it by.
 *
 *  NOT zero, and not the field dropped. A pill with no text behind it is a button that lies, and a
 *  sentence whose elided quote has lost its "…rest is here" is the gap `onDeferredSendOutcome` closes
 *  in the first place. A leading stub keeps the pill's face — its first line — which is exactly what
 *  the face is for, and it wears the truncation suffix so it never claims to be whole. */
export const CONCIERGE_COLLAPSED_MIN_LEN = 200;

/**
 * Bound the COLLAPSED-PAYLOAD axis of a persisted thread, which {@link clip} cannot see.
 *
 * A `sparkle` message can carry a relayed brief as a `TextBlock` (see
 * ConciergeSparkleMessage.collapsed) so the transcript draws it as a pill instead of inlining it. That
 * field SURVIVES persistence for free — every rebuild in this module is a spread, not a field-by-field
 * copy — and survival is the point: a restored pill with no text behind it would be a button that
 * lies. But it arrives UNBOUNDED, which is exactly the failure {@link CONCIERGE_MSG_MAX_LEN} exists to
 * prevent, reaching through a field the text cap cannot see (the same shape as {@link stripDataUrls}):
 * the persist write throws, zustand silently stops persisting the WHOLE store, and the symptom ("my
 * thread stopped surviving restarts") shows up long after the message that caused it.
 *
 * TWO caps, because each alone leaves that failure reachable — {@link CONCIERGE_COLLAPSED_MAX_LEN} per
 * block, {@link CONCIERGE_COLLAPSED_TOTAL_CHARS} across them, spent newest-first, with anything past the
 * budget degraded to {@link CONCIERGE_COLLAPSED_MIN_LEN}. TRUNCATED, never dropped, with the same
 * admission suffix a clipped bubble gets, and `lineCount` recomputed so the pill's subtitle describes
 * the text actually behind it rather than the text that used to be. A restored pill therefore says less
 * than the live one did — never something untrue.
 *
 * Returns the INPUT ARRAY UNCHANGED when nothing needed clipping (the common case), for the same reason
 * {@link boundLiveThumbnails} does: bubbles are memoized on identity.
 */
export function boundCollapsedPayloads(chat: ConciergeMessage[]): ConciergeMessage[] {
  let budget = CONCIERGE_COLLAPSED_TOTAL_CHARS;
  let out: ConciergeMessage[] | null = null;
  // Newest first: the budget is spent on the payloads the reader is nearest to.
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]!;
    if (m.kind !== "sparkle" || !m.collapsed) continue;
    const room = Math.max(CONCIERGE_COLLAPSED_MIN_LEN, Math.min(CONCIERGE_COLLAPSED_MAX_LEN, budget));
    // Spend what this block actually takes, so a short payload does not cost a long one its room. The
    // floor above can overdraw; clamp rather than going negative, or a later block would get `room`
    // from a negative `budget` and the Math.max would silently hand it the floor twice over.
    budget = Math.max(0, budget - Math.min(m.collapsed.text.length, room));
    if (m.collapsed.text.length <= room) continue;
    const text = m.collapsed.text.slice(0, room) + CONCIERGE_TRUNCATION_SUFFIX;
    out ??= chat.slice();
    out[i] = { ...m, collapsed: { ...m.collapsed, text, lineCount: countLines(text) } };
  }
  return out ?? chat;
}

/**
 * Reduce a live thread to what belongs in localStorage: conversation only, newest
 * {@link CONCIERGE_THREAD_MAX} kept, each clipped to {@link CONCIERGE_MSG_MAX_LEN} and with every
 * attachment's base64 dropped (see {@link stripDataUrls} — the second, larger size axis) and every
 * collapsed payload bounded per-block AND in aggregate (see {@link boundCollapsedPayloads} — the third).
 *
 * Exported so the caps are testable without going through zustand's persist middleware, and so the
 * ordering guarantee is pinned in one place: the result stays OLDEST-FIRST, matching
 * `ConciergeViewModel.messages`. (promptHistoryStore is newest-first because it is a lookup table;
 * this is a transcript, and reversing it would render the conversation backwards.)
 */
export function persistableThread(chat: ConciergeMessage[]): ConciergeMessage[] {
  const conversation = chat.filter(isConversation).map(clip).map(stripDataUrls).map(boundLintMarks);
  // Trim from the FRONT: drop the oldest turns, keep the tail the user is actually looking at.
  const kept =
    conversation.length > CONCIERGE_THREAD_MAX
      ? conversation.slice(conversation.length - CONCIERGE_THREAD_MAX)
      : conversation;
  // AFTER the trim, never before: the collapsed budget is spent newest-first over what is actually
  // being written, so payloads on turns about to be dropped must not have taken any of it.
  return boundCollapsedPayloads(kept);
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
 *
 * REPLY ANCHORS ARE THE ONE THING HERE THAT REFERS TO ANOTHER MESSAGE, so the reindex above has to be
 * applied to them too (`ConciergeSparkleMessage.answers`, see Concierge/replyAnchors). A reply carries
 * the ids of the messages it answered; renaming every message and not the references turns a restored
 * thread's quoted stubs — and every "Answered below" marker derived from them — into buttons pointing
 * at ids nothing holds. Anchors whose target did NOT survive (it was trimmed from the front by
 * {@link persistableThread}) keep their quote and lose only the jump; see `remapAnchors`.
 */
export function rehydrateThread(chat: ConciergeMessage[]): ConciergeMessage[] {
  // Built over the SAME positional rule the map below applies, in a first pass, because an anchor may
  // point backwards or forwards and a single pass would only ever have half the map.
  const idMap = new Map(chat.map((m, i) => [m.id, `${RESTORED_ID_PREFIX}${i}`]));
  return chat.map((m, i) => {
    const next = { ...m, id: `${RESTORED_ID_PREFIX}${i}` };
    // NOTHING THAT SURVIVED A RESTART IS STILL STREAMING, so every restored reply is `settled` —
    // including one the app quit in the middle of. That flag is what stops the reply-anchor walk
    // (Concierge/replyAnchors), and without it the first reply of a new session would walk straight
    // past a restored bubble and claim messages a previous session had already answered.
    //
    // It is applied to every restored `sparkle` message, which a live session distinguishes further
    // (an app status line is not an answer). That distinction is not recoverable from disk, and the
    // two directions of the error are not symmetric: erring this way makes a new reply claim FEWER
    // of last session's messages, while the other way would have it claim a stranger's conversation.
    // Under-claiming is the honest side of a fact the persisted thread cannot answer.
    // LINT MARKS ARE RE-VALIDATED, NOT MERELY LET THROUGH. They survive a restart on purpose (see
    // {@link boundLintMarks} for the decision and why it differs from `ConciergeFailureMessage`'s),
    // and "survives" is the easy half: every rebuild in this module is a spread, so the field would
    // have come back whether or not anyone had thought about it. What it needs is the deliberate
    // half. This payload came off localStorage — written by whatever build ran last, and
    // hand-editable — so a malformed or oversized `lint` array must not reach the renderer. Same
    // posture this function already takes for ids and anchors, and the same function the write side
    // runs, so the two boundaries cannot drift.
    if (next.kind === "sparkle")
      return {
        ...next,
        settled: true,
        answers: remapAnchors(next.answers, idMap),
        lint: normalizeLintMarks(next.lint),
      };
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
      // Every write goes through the live-retention cap (see boundLiveThumbnails): the store is the
      // one place all of them converge — the host's append, the receipt rewrite, a seeded test —
      // so bounding here is what makes the guarantee hold rather than depending on each call site.
      setChat: (next) =>
        set((s) => ({
          chat: boundLiveThumbnails(typeof next === "function" ? next(s.chat) : next),
        })),
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

/**
 * Drop the thread — the IDENTITY reset, and the production caller `clearChat` never had.
 *
 * This is the FOURTH per-human concierge store to be found outside `resetConciergeIdentityState`,
 * and it is the largest of the four (roborev 55625). The other three are process-lifetime memory;
 * this one is written to disk on purpose. It holds up to {@link CONCIERGE_THREAD_MAX} `you`/`sparkle`
 * bubbles of up to {@link CONCIERGE_MSG_MAX_LEN} chars each — the human's own words and the model's
 * replies, VERBATIM rather than the audit log's redacted display strings — under a `localStorage`
 * key that is fixed, not keyed by user. Both halves that make residue reachable already exist: the
 * reader is `useConciergeThread` in `ConciergeHost`, and the replay path is this store's own `merge`
 * hook, which rehydrates the previous human's conversation on the next launch.
 *
 * CLEARING THE LIVE STATE IS NOT ENOUGH, AND THE ORDER IS LOAD-BEARING. `clearChat()` empties the
 * store, which `persist` writes straight back out as `{"chat":[]}` — so the key survives, holding an
 * empty thread. That is already residue-free, but `clearStorage()` removes the key outright, which is
 * the state a human would recognise as "gone". It has to run AFTER the `set`, because the write
 * `clearChat` triggers is synchronous: clearing storage first would simply be undone by it.
 */
export function clearConciergeThread(): void {
  useConciergeThreadStore.getState().clearChat();
  useConciergeThreadStore.persist.clearStorage();
}
