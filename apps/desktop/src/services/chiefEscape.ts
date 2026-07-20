// The bounded escape from a Chief chat we can no longer send to (bead sparkle-xh4j).
//
// askChief only reopens a chat on a 404/410, but Chief's error vocabulary is undocumented — if a
// dead chat ever reports as something else, every later turn would retry it forever with no way
// back. Two consecutive send failures against ONE chat abandon it: one full re-seed, in exchange
// for the lane never wedging for the life of the panel.
//
// The rules are pure decisions over (streak, chat) and live here rather than inline in ThinkPanel
// because they are about ASYNC INTERLEAVINGS — a superseded turn resolving on an abandoned chat
// while a newer chat is held — which are near-impossible to drive through the component and exactly
// where reasoning-by-hand fails. Here each case is one function call.
//
// The invariant throughout: a strike belongs to the CHAT the send targeted, never to the turn. A
// turn the user stopped still produces real evidence about its chat.

/** Consecutive send failures against `chatId`. `chatId: null` means no chat is under suspicion.
 *  Readonly because every rule here returns a NEW streak — an in-place write would corrupt
 *  {@link NO_STREAK}, which every caller with no suspect chat aliases. */
export interface SendStreak {
  readonly chatId: string | null;
  readonly count: number;
}

/** Consecutive send failures before a chat is abandoned. */
export const ESCAPE_THRESHOLD = 2;

/** Frozen: this single object is shared by every caller that has no chat under suspicion, so a
 *  stray in-place write would corrupt it process-wide — and every `toEqual(NO_STREAK)` would still
 *  pass, comparing against the same mutated object. */
export const NO_STREAK: SendStreak = Object.freeze({ chatId: null, count: 0 });

/**
 * A send on `chatId` succeeded — that chat is demonstrably alive, so its strikes are void.
 *
 * Only its own. A success on some other chat says nothing about the one under suspicion, and
 * clearing unconditionally would wipe a live chat's strikes when a stale turn resolved elsewhere.
 */
export function afterSuccess(streak: SendStreak, chatId: string | null): SendStreak {
  return streak.chatId === chatId ? NO_STREAK : streak;
}

/**
 * A send failed. `abandon` is true only when the chat that earned the strikes is still the one
 * held: if it has already been replaced, its strikes are history and the held chat has done nothing
 * wrong. Either way a completed verdict clears the streak, so no "doomed" claim about a dead chat
 * outlives it.
 *
 * Named fields, not positionals: `sentOn` and `heldChatId` are both chat ids and swapping them
 * would typecheck, silently restoring the bug where a strike lands on whatever chat happens to be
 * held at catch time instead of the one the send targeted.
 */
export function afterSendFailure(args: {
  streak: SendStreak;
  /** The chat this send targeted, captured BEFORE the await — never "whatever is held now", or the
   *  attribution would depend on the caller's turn guard rather than on this rule. Non-null: a send
   *  failure implies a live chat, and allowing null would collide with the no-suspect sentinel. */
  sentOn: string;
  /** The chat held now, which may already have moved on. */
  heldChatId: string | null;
}): { streak: SendStreak; abandon: boolean } {
  const { streak, sentOn, heldChatId } = args;
  const count = (streak.chatId === sentOn ? streak.count : 0) + 1;
  if (count < ESCAPE_THRESHOLD) return { streak: { chatId: sentOn, count }, abandon: false };
  return { streak: NO_STREAK, abandon: heldChatId === sentOn };
}
