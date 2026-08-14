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
// `ConciergeColumn`'s `lockBlanksColumn` is where that carve-out lives; the `@Sparkle` escape hatch
// is still refused at the service level, which is the line that was always doing the real work.
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
export function useConciergeAiLock(): ConciergeAiLockReason | null {
  const flag = useSettingsStore(conciergeAiFlagOn);
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  const credits = useHasAiCredits();
  return conciergeAiLockReason({ flag, entitled, credits });
}
