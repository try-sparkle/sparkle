// One place that answers "are AI enhancement features live?" The rule is per-feature and depends on
// WHO PAYS for that feature's inference — see `SUBSCRIPTION_FUNDED` and `affordable` below:
//
//   • Sparkle-funded (Deepgram cloud dictation) → flag AND a served CREDIT BALANCE. Unchanged.
//   • Subscription-funded (naming, suggestions, concierge) → flag AND (ENTITLEMENT OR credits).
//     These run on the user's own Claude Code subscription and cost Sparkle nothing, so a credit
//     balance cannot be what decides them — and after the vendor key was retired, a credit gate
//     there would be one no top-up could ever satisfy.
//
// The header used to state the credit rule absolutely ("nothing else gates it"). That is no longer
// true, and the `entitled` note below is why the OR arm exists rather than entitlement alone: this
// repo's own rule is that credits — not the one-time purchase — unlock the AI extras for a
// non-entitled user who has a balance, and the split must not take that away.
//
// `entitled` (the one-time $99) also governs the app paywall (deriveAuthView) and the anonymous-trial
// worker-send cap (trialMeter, via aiEnhancementsEnabled). The anonymous trial has no `me`, so it has
// neither entitlement nor credits — which keeps the "trial = no AI enhancements" rule intact under
// both arms.
//
// VISIBLE vs USABLE vs LOCKED (the trial "see it but buy the app to use it" split):
//   - visible (useAiFeatureVisible / aiFeatureVisibleNow) = the settings flag ONLY. Decides whether
//     a user-initiated AI SURFACE renders (the Think chevron, the composer overlay, the mic button),
//     so a trial user can SEE the AI features exist.
//   - usable (useAiFeature / aiFeatureNow) = flag && affordable(key). The real gate that decides
//     whether an AI extra actually runs. For Sparkle-funded features that is still the credit
//     machinery; for subscription-funded ones an entitled user at a zero balance now passes, which
//     is the case the whole migration exists to fix.
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

/**
 * Features whose inference runs on the USER'S OWN Claude Code subscription, not on a Sparkle-funded
 * vendor key. These cost Sparkle nothing, so a Sparkle credit balance must NOT gate them — a user
 * who has run their balance to zero would otherwise lose auto-naming and suggestions for no reason
 * anyone can defend, which is the trap that made a dead vendor key look like a product decision.
 *
 * Everything NOT listed here stays credit-gated because it still spends Sparkle's money:
 *   - `voiceDictation` and `composer` both drive the Deepgram cloud-dictation relay
 *     (`start_cloud_stream`). Deepgram is a different vendor and cannot run on a Claude
 *     subscription, so those keep the balance gate exactly as before.
 *   - `autoApprove` is left in the gated set deliberately: it is not obviously subscription-funded,
 *     and the safe direction for a gate is to keep it until someone establishes otherwise.
 *
 * Adding a key here is a MONETIZATION decision, not a refactor — it removes something a Sparkle
 * credit balance buys. See the PRD.
 */
const SUBSCRIPTION_FUNDED: ReadonlySet<AiFeatureKey> = new Set<AiFeatureKey>([
  "autoRename",
  "suggestedActions",
  "concierge",
]);

/** Does this feature's spend land on Sparkle's bill (and therefore need a credit balance)? */
export function needsSparkleCredits(key: AiFeatureKey): boolean {
  return !SUBSCRIPTION_FUNDED.has(key);
}

/**
 * The affordability half of the gate, for one feature.
 *
 * TWO DIFFERENT QUESTIONS, and conflating them is what this split exists to stop:
 *
 *   - Sparkle-funded (Deepgram cloud dictation) → "is there a CREDIT BALANCE to spend?" Unchanged:
 *     Sparkle really is paying a vendor per minute, so a balance is exactly the right gate.
 *
 *   - Subscription-funded (naming, suggestions, concierge) → "has this person paid for Sparkle in
 *     ANY form?" The inference runs on the user's own Claude Code subscription and costs Sparkle
 *     nothing, so a credit balance cannot be what decides it — an entitled user who has run their
 *     balance to zero is the case the whole migration exists to fix, and with the vendor key retired
 *     a credit gate there is one no top-up could ever satisfy.
 *
 * `entitled || credits`, NOT `entitled` alone. Requiring entitlement by itself looked tidier and was
 * wrong in a way worth recording: it would have taken these features AWAY from a non-entitled user
 * who has a positive credit balance, which is a live case this repo has an explicit rule for
 * ("credits — not the one-time entitlement — decide whether AI features run", see the header). The
 * OR keeps that rule intact while adding the zero-balance-but-paid case, and still refuses the
 * anonymous trial, which has neither.
 */
function affordable(key: AiFeatureKey, me: Me | null, floorCents?: number): boolean {
  if (needsSparkleCredits(key)) return hasAiCredits(me, floorCents);
  return aiEnhancementsEnabled(me) || hasAiCredits(me, floorCents);
}

/** A feature is effectively on when its setting is on AND it is affordable (see {@link affordable}). */
export function useAiFeature(key: AiFeatureKey): boolean {
  const flag = useSettingsStore((s) => s[AI_FEATURE_FIELD[key]]);
  const ok = useAuthStore((s) => affordable(key, s.me, s.creditFloorCents));
  return flag && ok;
}

/** Imperative read for non-React call sites (effects, event handlers). */
export function aiFeatureNow(key: AiFeatureKey): boolean {
  if (!useSettingsStore.getState()[AI_FEATURE_FIELD[key]]) return false;
  const s = useAuthStore.getState();
  return affordable(key, s.me, s.creditFloorCents);
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
