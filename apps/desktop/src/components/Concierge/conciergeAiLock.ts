// WHY the concierge's AI half is not running — and therefore WHICH remedy its locked panel offers.
// The three reasons are deliberately kept apart, because the fix is different in each and the wrong
// copy here is worse than none (this is the same split services/aiGate's header documents):
//
//   flag_off     — the AI-concierge SETTING is off. The fix is turning it back on in
//                  ⋯ Settings → AI features. NOT a purchase: this user may own everything already,
//                  and pitching them the app would read as a bug.
//   not_entitled — the flag is on but the app was never bought (the one-time $99). This is exactly
//                  aiGate's LOCKED state, and components/AiLockedNotice already drives that
//                  checkout — we hand off to it rather than growing a second upsell.
//   no_credits   — the flag is on and the app IS bought, but the balance is at or below the level
//                  the server refuses at. The remedy is the existing top-up (the Refill seam in
//                  components/OutOfCreditsNotice). A "buy the app" upsell here would be flatly
//                  wrong, which is precisely why aiGate's `locked` is entitlement-based rather than
//                  credit-based.
//
// Only the CHAT (the paid `claude -p` brain) and the tools hang off this. The column's status
// readout is derived from local app state, costs nothing, and stays live — see ConciergeColumn.
//
// ══ AND NOT THE COMPOSER, ONCE A CABLE IS PATCHED (bead sparkle-voudj7) ═══════════════════════
// That sentence was the declared scope and the column did not honour it: the lock also removed the
// COMPOSER, in every state. Mounted, that box is not the brain — it relays keystrokes to the human's
// OWN agent's PTY, which calls no model and costs nothing — so the lock was confiscating a
// capability it does not sell. The founder mounted a pane and reported having no typing area at all.
// `ConciergeColumn`'s `lockBlanksColumn` is where that carve-out lives.
//
// AND THE `@Sparkle` ESCAPE HATCH IS NOT GOVERNED BY THIS RULE AT ALL (roborev 64231/64264). An
// earlier draft of this paragraph said it was "still refused at the service level", which is wrong
// in a way worth stating rather than deleting: the service gate is `conciergeAiEnabled` =
// `flag && (entitled || credits)`, deliberately LOOSER than this lock, because
// `conciergeTools/policyBinding` records that a concierge turn "runs on the user's own Claude Code
// subscription and costs Sparkle nothing, so a Sparkle balance cannot answer it". So an ENTITLED
// user at a zero balance is locked out of the COLUMN by this rule and still legitimately reaches
// the brain from a mounted one — and a guard added here to "close that gap" had to be reverted.
//
// This module answers what the column RENDERS. It must not be reused as a permission check.
import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { aiEnhancementsEnabled, useHasAiCredits } from "../../services/aiGate";

export type ConciergeAiLockReason = "flag_off" | "not_entitled" | "no_credits";

/** The settings field backing the concierge's AI toggle (config `[ai].concierge`). Read by NAME
 *  rather than through `AI_FEATURE_FIELD.concierge` on purpose: the key is landing with the
 *  concierge policy layer, and reading the field directly means this module compiles and behaves
 *  correctly both before and after that arrives. Once the key exists the two are the same field. */
export const CONCIERGE_AI_FIELD = "aiConcierge";

/** Is the concierge's AI toggle on? A MISSING field reads as ON, never off: the concierge chat is
 *  not flag-gated at all until that setting ships, so treating "absent" as off would dark the
 *  column for every user on a store that predates the flag. Only an explicit `false` is off. */
export function conciergeAiFlagOn(state: unknown): boolean {
  return (state as Record<string, unknown>)[CONCIERGE_AI_FIELD] !== false;
}

/** The pure rule. Order matters: entitlement is checked before credits so an unbought account can
 *  never be routed to a top-up it cannot use. Null means nothing is locked. */
export function conciergeAiLockReason({
  flag,
  entitled,
  credits,
}: {
  flag: boolean;
  entitled: boolean;
  credits: boolean;
}): ConciergeAiLockReason | null {
  if (!flag) return "flag_off";
  if (!entitled) return "not_entitled";
  if (!credits) return "no_credits";
  return null;
}

/** Store-bound read of the rule above. Like BalanceBadge and LogoWaveform, this reaches for its own
 *  stores rather than the view-model — the gate is app-wide auth/settings state, and teaching the
 *  concierge's data layer about entitlement would buy nothing (see ConciergeColumn's header). */
/**
 * The one-line notice a MOUNTED reader gets when a concierge turn was refused at the door.
 *
 * ══ COPY ONLY — THIS IS NOT A GATE, AND THE DISTINCTION IS LOAD-BEARING ═══════════════════════
 * Called only AFTER `startConciergeTurn` has already rejected on `conciergeAiEnabled()`. It reads
 * the lock reason to pick WORDS, never to decide anything, so it cannot re-import the credit rule
 * that `policyBinding` removed from the decision (see the header). A `null` reason means the two
 * rules disagreed — the authoritative gate refused while this one sees nothing wrong — so it falls
 * back to a line that promises no particular remedy rather than inventing one.
 *
 * ══ WHY IT IS NOT ONE HARD-CODED SENTENCE (roborev 64277) ═════════════════════════════════════
 * It was, for one commit: "AI enhancements are off — turn them back on to send these." That is the
 * `flag_off` remedy, and `flag_off` is the LEAST likely way to get here — the common cases are an
 * unentitled or empty account whose toggle is already ON, told to flip a switch that is already
 * flipped. And it is worse mounted than anywhere else: `lockBlanksColumn` means a mounted reader
 * never sees `ConciergeAiLocked`, so this string is the ONLY thing on screen and the only route to
 * a remedy. That is precisely the unfollowable-remedy failure this bead exists to remove
 * (AGENTS.md: "a refusal that says 'do X instead' is an instruction the user will follow"), which
 * is why the wording tracks `ConciergeAiLocked`'s three branches rather than asserting the flag.
 */
export function conciergeAiOffNotice(reason: ConciergeAiLockReason | null): string {
  switch (reason) {
    case "flag_off":
      return "AI enhancements are off — turn them back on in ⋯ Settings → AI features to send these.";
    case "not_entitled":
      return "Buy Sparkle to talk to your concierge — these messages weren't sent.";
    // UNREACHABLE FROM THE REFUSAL CALL SITE, AND KEPT ANYWAY (roborev 64296). The gate that
    // rejects is `flag && (entitled || credits)`, and this reason needs `entitled && !credits` — so
    // `entitled` alone satisfies the gate and no rejection ever carries it. It stays because this
    // function is a total map over the reason type and the two rules HAVE drifted before; if the
    // lock's credit arm ever becomes the deciding one, the line is already right. Nothing should
    // present it as a state a user can currently hit — a test row that "proved" it had to force the
    // rejection against a lock that would never have produced it, which is why that row was
    // replaced with the reachable `not_entitled` one.
    case "no_credits":
      return "You are out of AI credits — top up to bring your concierge back. These weren't sent.";
    default:
      return "Your concierge couldn't take these messages just now.";
  }
}

export function useConciergeAiLock(): ConciergeAiLockReason | null {
  const flag = useSettingsStore(conciergeAiFlagOn);
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  const credits = useHasAiCredits();
  return conciergeAiLockReason({ flag, entitled, credits });
}


