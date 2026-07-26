// Visibility rule for the app-level "$0 balance" banner.
//
// Every AI enhancement is gated on `hasAiCredits` (aiGate.ts) — the moment the balance runs out
// they all go dark. Before this banner the only tells were feature-LOCAL (the mic's out-of-credits
// notice, an autoRename that silently stops happening), so a user could watch the app quietly get
// dumber with nothing to connect it to. This is the one global "here is why" notice.
//
// Both rules here — visibility and the zero-crossing re-arm — derive from ONE predicate,
// `hasPositiveBalance`, so they can never disagree with each other and strand a dismissal.
//
// That predicate is deliberately NOT the feature gate's. `aiGate.hasAiCredits` also closes at a
// positive balance the server has refused (the credit floor), and this banner's copy states "Your
// Sparkle credit balance is $0" — true only of a literally exhausted balance. Do not "restore"
// agreement by importing the gate: at a 3¢ balance under a 5¢ floor that prints a false statement
// about the user's money. See the rationale on `hasPositiveBalance`, and the test below that pins
// this divergence.
//
// It is imported from the store-free `entitlement` module for a second reason too: aiGate pulls in
// useAuthStore/useSettingsStore, which would drag the whole store graph into this nominally pure
// rule and into its unit test — the exact coupling entitlement.ts exists to prevent.
import { hasPositiveBalance, type Me } from "./entitlement";

/**
 * Should the "$0 balance" banner be on screen?
 *
 * True ⇔ a signed-in, ENTITLED user has run their credits out and hasn't dismissed the notice.
 *
 * The entitlement clause is the subtle one. Read aiGate's header: `entitled` (the one-time $99)
 * governs the app paywall, while CREDITS govern the AI extras. A user who hasn't bought the app is
 * pitched the $99 by the paywall / `useAiFeatureLocked` — they have no credit balance to refill and
 * telling them to "Refill" would sell the wrong thing. So this banner speaks only to the case the
 * credit flow owns: they bought the app, they had credits, and now they don't.
 */
export function shouldShowZeroCreditBanner(me: Me | null, dismissed: boolean): boolean {
  if (dismissed) return false;
  if (me === null || !me.entitled) return false;
  return !hasPositiveBalance(me);
}

/**
 * Should a dismissed "$0 balance" banner be RE-ARMED, given the identity/balance we just observed?
 *
 * Pure so the rule is testable without the stores; `authStore` applies it on every `me` write.
 *
 * @param dismissedFor The clerkUserId whose dismissal is currently latched (null = nobody's).
 * @param next         The `me` just written.
 *
 * Two things clear a dismissal:
 *   • credits arriving — via `hasPositiveBalance`, the SAME predicate the banner's visibility uses,
 *     so the show rule and the re-arm rule can never disagree;
 *   • a DIFFERENT signed-in identity. Otherwise: dismiss at $0, sign out, sign in as a different
 *     entitled account also at $0, and the new user never sees the warning — one person's dismissal
 *     silencing another's.
 *
 * What deliberately does NOT clear it: `me` going NULL. That is indistinguishable at this layer from
 * a transient `fetchMe()` failure past the grace window — and treating it as an identity change meant
 * a blip of bad network resurrected a banner the user had explicitly dismissed, on a balance that
 * never changed. A real sign-out is an EXPLICIT act (`reset()`), which clears the flag directly
 * rather than inferring it from a null. (roborev 48271)
 */
export function shouldRearmZeroCreditBanner(dismissedFor: string | null, next: Me | null): boolean {
  if (hasPositiveBalance(next)) return true;
  const nextId = next?.clerkUserId ?? null;
  return nextId !== null && dismissedFor !== null && nextId !== dismissedFor;
}
