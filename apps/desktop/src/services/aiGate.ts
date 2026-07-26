// One place that answers "are AI enhancement features live?" — true ⇔ the signed-in user has
// CREDITS (balanceCents > 0). Every per-feature read ANDs its settings flag with this, so an AI
// feature is on only when its toggle is on AND the user has credits, and it turns off ONLY when the
// user runs out of credits or turns that feature off in preferences — nothing else gates it.
//
// `entitled` (the one-time $99) still governs two OTHER things and is deliberately NOT part of the
// per-feature gate: the app paywall (deriveAuthView) and the anonymous-trial worker-send cap
// (trialMeter, via aiEnhancementsEnabled). Once a user is past the paywall, credits — not a
// one-time entitlement — decide whether the AI extras run. The anonymous trial has no `me`, so it
// has no credits either, which keeps the "trial = no AI enhancements" rule intact.
//
// VISIBLE vs USABLE vs LOCKED (the trial "see it but buy the app to use it" split):
//   - visible (useAiFeatureVisible / aiFeatureVisibleNow) = the settings flag ONLY. Decides whether
//     a user-initiated AI SURFACE renders (the Think chevron, the composer overlay, the mic button),
//     so a trial user can SEE the AI features exist.
//   - usable (useAiFeature / aiFeatureNow) = flag && credits. The real gate that decides whether an
//     AI extra actually runs (spends credits). Unchanged — the credit machinery + OutOfCreditsError
//     still govern a signed-in, entitled user who has run their balance to zero.
//   - locked (useAiFeatureLocked / aiFeatureLockedNow) = flag && NOT entitled (the $99 not yet
//     bought). True exactly when the surface is visible but the action must be blocked with a
//     buy-the-app upsell (AiLockedNotice → openPaywall, the $99 checkout). This is ENTITLEMENT-based,
//     NOT credit-based, on purpose: the notice sells the $99 app, so it must never fire for a user
//     who already bought it — an entitled user with a zero credit balance is handled by the existing
//     credit flow (top-up / OutOfCreditsError), never by this "buy the app" gate. For the anonymous
//     trial (me == null) entitlement and credits both read false, so the two are equivalent there —
//     the split only matters for the entitled-but-out-of-credits case, which locked must NOT catch.
// Currently only the Think (brainstorm) surface uses the visible/locked split — it is a
// purchase-only AI backend with no free fallback. The composer and voice dictation deliberately
// stay on their existing gates: the composer is the metered free-trial send path (locking it would
// break the 100 free prompts), and dictation has a free on-device path, so neither is a clean
// "buy the app to use it" surface. Background features (autoRename, suggestedActions) keep the
// usable gate too, since they have no "user tried to use it" moment.
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore, AI_FEATURE_FIELD, type AiFeatureKey } from "../stores/settingsStore";
import { hasCreditsAbove, type Me } from "./entitlement";
import { OutOfCreditsError } from "./credits";

/** Paid-entitlement check (the one-time $99). Still used by the paywall (deriveAuthView) and the
 *  anonymous-trial send meter (trialMeter). NOT the per-feature AI gate — that is credit-based
 *  (see hasAiCredits), so AI features track the user's live credit balance, not a one-time unlock. */
export function aiEnhancementsEnabled(me: Me | null): boolean {
  return me?.entitled === true;
}

/** Are AI enhancement features unlocked? True ⇔ the user is signed in and has a credit balance the
 *  server will actually serve. This — not entitlement — is what gates every AI extra, so features go
 *  dark exactly when the user runs out of credits (and are off during the anonymous trial, where
 *  there is no `me`).
 *
 *  `floorCents` is the balance the server last refused a call at (see authStore.creditFloorCents).
 *  A bare `balance > 0` was the wrong line: the server reserves a per-request HOLD before it runs
 *  the call, so it refuses at any balance under that hold. A leftover balance of a few cents
 *  therefore passed this gate and 402'd on EVERY call — and because nothing recorded the refusal,
 *  the gate kept re-opening, so every AI surface (per agent, per settled state, forever) re-bought
 *  the same doomed round-trip. Comparing against the refused level closes the gate at a balance the
 *  server has actually rejected; a top-up lifts the balance back above it, and `refresh()` drops the
 *  floor outright so a coarse inference can't outlive its evidence. Defaulted from the store so all
 *  existing call sites keep working; pass it explicitly to test the rule as a pure function.
 *
 *  The RULE itself lives in ./entitlement, a store-free module, and this is the store-bound binding
 *  of it: aiGate imports useAuthStore for its hooks, so anything the stores need — authStore's
 *  $0-banner seam, services/zeroCreditBanner — would close an authStore → aiGate → authStore cycle
 *  by importing from here. Consumers that already depend on the store keep using this one. */
export function hasAiCredits(
  me: Me | null,
  floorCents: number = useAuthStore.getState().creditFloorCents,
): boolean {
  return hasCreditsAbove(me, floorCents);
}

export function useHasAiCredits(): boolean {
  // Subscribes to the floor as well as `me` — otherwise the first refusal would not re-render the
  // surfaces this gate drives, and they would keep firing until some unrelated auth change landed.
  return useAuthStore((s) => hasAiCredits(s.me, s.creditFloorCents));
}

/** Hard client-side credit gate: throw {@link OutOfCreditsError} when the signed-in user has no
 *  positive credit balance, so every AI call routed through this guard fails FAST locally (no server
 *  round-trip) the moment credits hit zero. Reuses the same error the server's 402 maps to, so
 *  callers surface the existing "Out of AI credits" upsell path either way. Carries the live balance
 *  (0 for a null `me`) on {@link OutOfCreditsError.balanceCents}, which nothing renders today — see
 *  its doc before you do. */
export function assertAiCredits(): void {
  const me = useAuthStore.getState().me;
  if (!hasAiCredits(me)) throw new OutOfCreditsError(me?.balanceCents ?? 0);
}

/** A feature is effectively on only when its setting is on AND the user has credits. */
export function useAiFeature(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const credits = useHasAiCredits();
  return flag && credits;
}

/** Imperative read for non-React call sites (effects, event handlers). */
export function aiFeatureNow(key: AiFeatureKey): boolean {
  return (
    useSettingsStore.getState()[AI_FEATURE_FIELD[key]] &&
    hasAiCredits(useAuthStore.getState().me)
  );
}

/** VISIBLE: the settings flag ONLY (ignores credits). Decides whether a user-initiated AI surface
 *  renders — so a trial/no-credits user can SEE the AI feature. Use this for UI presence; pair it
 *  with the usable gate / `useAiFeatureLocked` at the action site. */
export function useAiFeatureVisible(key: AiFeatureKey): boolean {
  return useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
}

/** Imperative VISIBLE read for non-React call sites. */
export function aiFeatureVisibleNow(key: AiFeatureKey): boolean {
  return useSettingsStore.getState()[AI_FEATURE_FIELD[key]];
}

/** LOCKED: the feature's flag is on but the app is NOT yet bought (not entitled) — the surface is
 *  visible but a user-initiated action must be blocked with the buy-the-app ($99) upsell. Deliberately
 *  entitlement-based, not credit-based (see the header): an entitled user who is out of credits is
 *  NOT locked — their zero balance is handled by the existing credit flow, not this paywall upsell. */
export function useAiFeatureLocked(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const entitled = useAuthStore((s) => aiEnhancementsEnabled(s.me));
  return flag && !entitled;
}

/** Imperative LOCKED read for non-React call sites (submit handlers, dictation activation). */
export function aiFeatureLockedNow(key: AiFeatureKey): boolean {
  return (
    useSettingsStore.getState()[AI_FEATURE_FIELD[key]] &&
    !aiEnhancementsEnabled(useAuthStore.getState().me)
  );
}
