// aiServiceHealthStore — "is the AI proxy SERVICE sustaining failures right now?"
//
// The third-and-a-half failure mode, and the one that was live and invisible on 2026-07-28: the
// server-side proxy answered ~99% of calls with a gateway error (HTTP 502) for 12+ hours because
// Sparkle's own vendor account had a billing problem. Every AI Enhanced feature failed silently; a
// human only found it by reading server logs by hand.
//
// WHY THIS IS A SEPARATE STORE FROM THE TWO THAT ALREADY EXIST.
//   • `aiProviderStore` / `ProviderUnavailableBanner` fire on the DEFINITIVE `ai_unconfigured`
//     sentinel (a 503/404 where the server itself names `provider_unfunded` / `provider_key_rejected`).
//     That is a single authoritative signal, so it lights instantly. But during THIS incident the
//     proxy never emitted it — it returned bare 502s — so that banner stayed dark.
//   • `services/suggestions/vendorOutage.ts` is a circuit breaker that recognises the same 5xx class,
//     but it is SUGGESTIONS-scoped and its job is to THROTTLE doomed retries, not to tell the user
//     anything. Nothing surfaced it.
//
// So this store fills the gap: a lightweight, non-flappy detector for SUSTAINED service failure that
// drives one app-shell banner (AiServiceBanner).
//
// HOW IT IS FED. There is NO single JS chokepoint for AI calls (roborev 54761): chatOnce,
// generate_agent_name, judge_turn_followup and summarize_attention are four separate Tauri commands
// with four separate JS wrappers. EVERY one of them calls `noteAiServiceFailure(err)` — recording at
// each wrapper is what makes the banner truthful for whichever feature fails first.
//
// SUCCESS is asymmetric in WHERE IT COMES FROM, not in who benefits. `chatOnce` reports its own,
// because it is `cacheable: false` and every reply is a real spawn. The other three run
// `cacheable: true`, and claude_oneshot serves a cache hit without touching the CLI — a success
// reported from one would prove nothing and would zero the run this store exists to accumulate, so
// their wrappers still report failures only. Their recovery arrives out of band instead: Rust knows
// whether it spawned (`claude_oneshot::OneShotReply.spawned`), emits `ai://spawn-ok` only for a
// real child, and `services/aiServiceHealthListener.ts` turns that into one noteSuccess(). That is
// the durable fix this comment used to describe as future work; SERVICE_DEGRADED_MAX_AGE_MS is no
// longer the only way back from a cache-only session.
//
// WHAT IT DELIBERATELY DOES NOT COUNT, so a user is never double-warned or mislabelled:
//   • `insufficient_credits*` (the USER's $0 balance → ZeroCreditBanner) and `ai_unconfigured*` (the
//     provider-account sentinel → ProviderUnavailableBanner) YIELD: a more specific banner owns the
//     condition, so this one steps aside (clears) rather than stacking a vaguer message on top.
//   • `ai_unreachable` is the LOCAL transport sentinel (no network path); OfflineBanner owns it, and
//     chatOnce flips the connection store offline on it. Counting it would blame Sparkle's service
//     for the user's dead link, so it is IGNORED (never advances toward degraded).
import { create } from "zustand";

/** The coarse, PII-free cause we can infer from the proxy's typed error string. Intentionally small:
 *  a banner only needs to say roughly why, never the raw status body (which can carry request
 *  fragments). `unreachable` = the service/gateway is erroring (5xx); `rate_limited` = 429. */
export type AiServiceReason = "unreachable" | "rate_limited";

/**
 * Consecutive SERVICE failures before we call the service degraded and light the banner.
 *
 * Four, not one, on purpose — this is the whole "non-flappy" requirement. A lone 502 is the transient
 * gateway blip the Rust/JS retry path is FOR; flashing a scary full-width banner on it would be worse
 * than the silence. Four rejections in a row, with no success in between, is no longer a blip — it is
 * the shape of the sustained outage this exists to surface.
 *
 * "Consecutive" is measured against the RUN, and several things reset a run — so a service that is
 * mostly working never trips this, and neither do isolated blips spread across a long session.
 * {@link AiServiceHealth} carries the one authoritative table of what resets a run and what ends an
 * episode; do not restate it here, because every prose copy of it so far has dropped a row.
 */
export const AI_SERVICE_DEGRADED_THRESHOLD = 4;

/**
 * How long a degradation may be asserted without fresh evidence.
 *
 * Mirrors `aiProviderStore.OUTAGE_MAX_AGE_MS`, and this store needs it for a reason that store does
 * not: RECOVERY IS REPORTED NARROWLY. See the table on {@link AiServiceHealth} for the full set of
 * things that clear `degraded` — do not restate it here. The one that matters for THIS constant is
 * the success, because it is the only clearer a healthy CLI produces on its own.
 *
 * THE HOLE THIS WAS ADDED FOR IS NOW CLOSED, and the constant is kept anyway. Originally only the
 * UNCACHED `chatOnce` could report a success — judge, naming and attention all run
 * `cacheable: true`, and a cache hit never touches the CLI, so reporting healthy from one would
 * mask a wedged CLI. `chatOnce` has exactly one caller (the learned-suggestions tier) which a user
 * can switch off, so that user could drive the banner up through naming/judge/attention, fix their
 * CLI, and be left waiting on a recovery signal that never came. Those three now DO report
 * recovery, on a real spawn only, via `ai://spawn-ok` and `services/aiServiceHealthListener.ts`.
 *
 * So this is no longer the last line of defence — but it is still the bound on a claim asserted
 * without fresh evidence, which is a different job and one nothing else does. Keep it: an app that
 * never calls the CLI again (every AI feature off, no agents running) still produces no success of
 * any kind, and a banner must not outlive its evidence just because the machine went quiet.
 *
 * THIS expiry bounds the CLAIM only — the banner stops being displayed. The DISMISSAL is bounded by
 * {@link RUN_MAX_GAP_MS} (or a success, or a `yield`) instead, and that split is deliberate: clearing the
 * dismissal here made the banner un-dismissable, because `degraded` is immediately recomputed from
 * a run already past the threshold and the bar came straight back on the same failure. Do not fold
 * the two back together. On a real outage the next failing call re-stamps it, so it does not age out mid-outage.
 */
export const SERVICE_DEGRADED_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The longest gap ALLOWED BETWEEN two failures in the same run.
 *
 * A SEPARATE constant from the claim expiry above, deliberately, because they answer different
 * questions and want different values. Collapsing them — which the first version of the run bound
 * did, by reusing SERVICE_DEGRADED_MAX_AGE_MS — silently redefined the trip condition from "4
 * consecutive failures" to "4 failures each within TEN MINUTES of the last", and that breaks the
 * case this store exists for:
 *
 *   a permanently broken CLI (corrupt install, unresolvable shebang) in a quiet session that spawns
 *   an agent or ends a turn every ~15 minutes. Every call fails, but every failure would fold back
 *   to HEALTHY_SERVICE, `consecutiveFailures` would never exceed 1, and the banner would never
 *   light — a false NEGATIVE for a total outage, traded for the false positive the bound was added
 *   to remove.
 *
 * The failures that build a run are user/agent-event driven — naming on spawn, an attention summary,
 * a turn-end judge — so they legitimately arrive far apart. An hour is long enough to survive a
 * quiet session and short enough that isolated blips DAYS apart (the false positive) still can't
 * accumulate. Ten minutes is a fine bound on an unrefreshed CLAIM; it is the wrong bound on a RUN.
 */
export const RUN_MAX_GAP_MS = 60 * 60 * 1000;

/** Is this degradation still recent enough to assert? Pure — `now` is injected — so the rule is
 *  testable without faking timers and the banner cannot drift from the store. */
export function isServiceDegraded(state: AiServiceHealth, now: number): boolean {
  return state.degraded && now - state.degradedAt < SERVICE_DEGRADED_MAX_AGE_MS;
}

/**
 * The detector's whole state. One record so the run counter and the derived `degraded` flag cannot
 * drift apart.
 *
 * THE RUN, THE EPISODE AND THE STORED CLAIM ARE THREE DIFFERENT BOUNDARIES. Conflating any two is
 * how this store has regressed five commits running — every time by restating one of these sets in
 * prose, dropping an entry, and then reasoning from the wrong set. So it is a TABLE, stated ONCE,
 * here, with a COLUMN PER PIECE OF STATE — there is no trailing annotation to get wrong, because a
 * row that says something about `degraded` has to say it in the `degraded` column. Everywhere else
 * POINTS at this; if you find yourself re-enumerating it in a comment, that is the bug repeating.
 *
 *   trigger                                | resets  | ends the EPISODE  | clears the STORED
 *                                          | the RUN | (`dismissed`)     | `degraded`
 *   ---------------------------------------|---------|-------------------|----------------------
 *   a success                              | yes     | yes               | yes
 *   a `yield`                              | yes     | yes               | yes  (via reduceSuccess)
 *   a degrading failure >= RUN_MAX_GAP_MS  | yes     | yes               | yes  (run restarts at 1,
 *     after the last one                   |         |                   |       which is sub-threshold)
 *   an `ignore`                            | yes     | NO                | no   ← the asymmetric row
 *   a `neutral`                            | no      | no                | no
 *   the claim expiry, in `reduceFailure`   | no      | no                | ONLY if the run it leaves
 *                                          |         |                   |  behind is still under
 *                                          |         |                   |  the THRESHOLD
 *   the claim expiry, at READ time         | no      | no                | no — isServiceDegraded is
 *                                          |         |                   |  pure; it stores nothing
 *
 * The last two rows are the SAME bound applied in two places, and they differ in the final column —
 * which is exactly the distinction four rounds of prose kept losing. Read `degraded` through
 * {@link isServiceDegraded}, never directly, and see its field doc for why the reducer's arm is
 * conditioned on the threshold rather than on the run being zero.
 *
 * NOTHING HAPPENS ON ELAPSED TIME ALONE — every row is an EVENT except the read-time one, which is
 * evaluated when a consumer asks. Both time-based rules in the reducer live inside the `degrade`
 * arm, so an `ignore` or `neutral` two hours later does not fold, and a session that goes quiet
 * keeps its dismissal indefinitely. Both comparisons are `>=`, so the boundary itself folds.
 *
 * The `ignore` row is the one that earns the table: a stray `ai_empty_reply` mid-outage resets the
 * run, but must not un-mute a banner the user just dismissed. See `reduceFailure`.
 */
export interface AiServiceHealth {
  /** Service failures observed since the last success, the last non-service outcome, or the last
   *  gap longer than {@link RUN_MAX_GAP_MS} — whichever came most recently. */
  consecutiveFailures: number;
  /** The STORED claim: true once the run crossed {@link AI_SERVICE_DEGRADED_THRESHOLD}. Consumers
   *  must read it through {@link isServiceDegraded}, never directly — the claim expiry is a
   *  READ-TIME bound, and the stored flag routinely survives it: `reduceFailure` clears it on `base`
   *  and then immediately re-derives it from a run still past the threshold, so in a continuing
   *  outage it stays true. In state it is cleared by a success or `yield`, by the run-gap fold, or
   *  by the expiry arm whenever the run it leaves behind is STILL BELOW
   *  {@link AI_SERVICE_DEGRADED_THRESHOLD} after this failure is counted — the `ignore`-latched run
   *  of 0 is the clearest case, not the only one (a run of 1 or 2 clears too). Do not narrow that
   *  guard to `=== 0`: a latched claim would then survive on a sub-threshold run, and since every
   *  degrading failure re-stamps `degradedAt`, the banner would assert a sustained outage off two
   *  failures with no way back down. */
  degraded: boolean;
  /** When `degraded` last had fresh evidence (epoch ms), injected by the caller so the store stays
   *  pure. Read only through {@link isServiceDegraded}. */
  degradedAt: number;
  /** The coarse cause of the most recent counted failure, for the banner copy. */
  reason: AiServiceReason | null;
  /** The user dismissed the banner for the current degradation EPISODE. The table above is the
   *  authoritative list of what clears this; the two traps it exists to stop are the claim expiry
   *  (clearing here made the bar un-dismissable) and the `ignore` verdict (resets the run, must not
   *  un-mute mid-outage). */
  dismissed: boolean;
}

/** The healthy zero-state. Exported so tests and the store share one definition of "all clear". */
export const HEALTHY_SERVICE: AiServiceHealth = {
  consecutiveFailures: 0,
  degraded: false,
  degradedAt: 0,
  reason: null,
  dismissed: false,
};

/**
 * What a proxy rejection means for THIS detector. Three-way on purpose:
 *   • `degrade` — a genuine service failure (5xx / 429); count it toward the threshold.
 *   • `yield`   — a class a MORE SPECIFIC banner owns (insufficient_credits, ai_unconfigured). Our
 *                 banner steps aside so the two never stack.
 *   • `ignore`  — not a service signal (a per-request 4xx, or the local-offline transport sentinel).
 *                 Reset the run so it can't accumulate toward degraded, but leave an open banner be.
 */
export type ServiceFailureOutcome =
  | { kind: "degrade"; reason: AiServiceReason }
  | { kind: "yield" }
  | { kind: "ignore" }
  /** Say NOTHING either way — leave the consecutive run exactly as it is.
   *
   *  Distinct from `ignore`, which RESETS the run on the reasoning that a real answer is evidence
   *  the transport works. That reasoning does not hold for `ai_busy`: the concurrency cap refused
   *  the call locally in microseconds without asking the CLI anything, so it is evidence of neither
   *  health nor failure. The distinction is load-bearing because `ai_busy` and `ai_timeout` are
   *  produced by the SAME condition — a wedged CLI holds every slot, so concurrent callers are
   *  refused instantly while the wedged ones time out one at a time — and treating the refusals as
   *  a reset zeroes the very run the timeouts are accumulating, leaving the detector unable to fire
   *  in the multi-agent case it exists for. */
  | { kind: "neutral" };

/**
 * Classify a proxy error STRING (the typed sentinels src-tauri/src/ai.rs returns) into an outcome.
 * Pure and total, so it is safe against any string and independently testable.
 */
export function classifyServiceFailure(err: string): ServiceFailureOutcome {
  // Owned by a more specific AI banner → step aside (clear ours), never stack a vaguer message on
  // top. The named-reason banner (ProviderUnavailableBanner) says what the user should FIX; this
  // one only says "it has been failing a while", so it must not talk over it.
  if (err.startsWith("insufficient_credits")) return { kind: "yield" };
  if (err === "ai_unconfigured" || err.startsWith("ai_unconfigured:")) return { kind: "yield" };
  if (err === "claude_not_authenticated" || err === "claude_usage_limit") return { kind: "yield" };

  // The concurrency cap doing its JOB — refused locally, nothing asked. NEUTRAL, not ignore: see
  // the `neutral` doc for why resetting here makes the detector unable to fire at all.
  if (err === "ai_busy") return { kind: "neutral" };

  // The LOCAL transport-failure sentinel: no HTTP status came back (DNS/connect/socket). OfflineBanner
  // owns this; counting it would blame Sparkle's service for the user's dead network. Never advances.
  if (err === "ai_unreachable") return { kind: "ignore" };

  // A SUSTAINED run of these means degraded: the CLI is wedged, or the vendor is throttling. These
  // replace the `(HTTP nnn)` shapes the server-side proxy used to emit — nothing can produce those
  // now that AI enhancement runs as a local `claude` process rather than a gateway hop.
  if (err === "ai_timeout") return { kind: "degrade", reason: "unreachable" };
  if (err === "ai_rate_limited") return { kind: "degrade", reason: "rate_limited" };

  // A CLI that produced no usable output at all: a corrupt install, an unresolvable
  // `#!/usr/bin/env node` shebang, an OOM kill, or a flag removed by a CLI upgrade. `spawn_claude`
  // reports these as `ai request failed: claude exited …`. A permanent 100%-failure state — exactly
  // the silent-total-failure shape this store was built for — so it must COUNT.
  if (err.startsWith("ai request failed")) return { kind: "degrade", reason: "unreachable" };

  // Anything else: the CLI answered something this layer has no opinion about, which is evidence the
  // transport works. Reset the run, don't degrade.
  return { kind: "ignore" };
}
/**
 * Fold one classified proxy REJECTION into the detector and return the next state.
 *
 * Returns the SAME reference when nothing changed, so a retry storm of identical outcomes can't churn
 * selector subscribers into a re-render loop. Pure, for testing.
 */
export function reduceFailure(
  state: AiServiceHealth,
  outcome: ServiceFailureOutcome,
  at: number,
): AiServiceHealth {
  switch (outcome.kind) {
    case "yield":
      // A more specific banner is taking over — clearing ours is, from our POV, a recovery.
      return reduceSuccess(state);
    case "neutral":
      // Nothing was asked of the CLI, so nothing was learned. Leave the run untouched.
      return state;
    case "ignore":
      // Not a service signal. Reset the run without disturbing an open banner — THIS arm never
      // clears `degraded` or `dismissed`; see the table for what does. No-op when the run is zero.
      return state.consecutiveFailures === 0 ? state : { ...state, consecutiveFailures: 0 };
    case "degrade": {
      // TWO independent staleness rules, because there are two different things to bound and one
      // constant cannot serve both (sharing SERVICE_DEGRADED_MAX_AGE_MS for the run turned a false
      // positive into a false NEGATIVE — see RUN_MAX_GAP_MS).
      //
      //  1. The RUN is stale (no failure for over an hour) → start over entirely. This is what stops
      //     isolated blips days apart from accumulating into a claim that the service is down now.
      //
      //  2. The CLAIM has aged out but the run has not → drop `degraded` only. The DISMISSAL
      //     survives, and that asymmetry is load-bearing: clearing it here made the banner
      //     un-dismissable in exactly the case the split exists for. `degraded` is recomputed three
      //     lines below as `base.degraded || consecutiveFailures >= THRESHOLD`, and in a continuing
      //     run the count is already past the threshold — so clearing `dismissed` and re-setting
      //     `degraded` on the SAME failure put the bar straight back. A permanently broken CLI
      //     failing every ~15 minutes would re-nag on every single call, with no way to mute it,
      //     while a DENSE outage honoured the dismissal indefinitely. Exactly inverted.
      //
      //     A dismissal is per-EPISODE, and an episode ends on whatever folds to HEALTHY_SERVICE —
      //     see the table on AiServiceHealth, which is the ONE place that set is written down. Note
      //     it is not simply "every run reset": the `ignore` arm zeroes the run and leaves
      //     `dismissed` and `degraded` alone on purpose. That still fixes the original defect: a
      //     genuine later outage, after the user fixed their CLI, arrives more than RUN_MAX_GAP_MS
      //     after the last failure, so it folds and gets to speak.
      const sinceLastFailure = at - state.degradedAt;
      const base =
        sinceLastFailure >= RUN_MAX_GAP_MS
          ? HEALTHY_SERVICE
          : state.degraded && sinceLastFailure >= SERVICE_DEGRADED_MAX_AGE_MS
            ? { ...state, degraded: false }
            : state;
      const consecutiveFailures = base.consecutiveFailures + 1;
      const degraded = base.degraded || consecutiveFailures >= AI_SERVICE_DEGRADED_THRESHOLD;
      // Re-stamp on every degrading failure so a CONTINUING outage never ages out — the expiry is
      // there to bound a STALE claim, not to time-limit a real one.
      return { ...base, consecutiveFailures, degraded, degradedAt: at, reason: outcome.reason };
    }
  }
}

/** A successful proxied call proves the service is usable — clear EVERYTHING, including a prior
 *  dismissal, so a later outage is a fresh episode that gets to speak again. Returns the same
 *  reference when already healthy, to avoid needless notifications. Pure, for testing. */
export function reduceSuccess(state: AiServiceHealth): AiServiceHealth {
  const alreadyHealthy =
    state.consecutiveFailures === 0 && !state.degraded && !state.dismissed && state.reason === null;
  return alreadyHealthy ? state : HEALTHY_SERVICE;
}

interface AiServiceHealthState extends AiServiceHealth {
  /** Record a proxy rejection (the raw typed sentinel string). Classifies + folds it. */
  noteFailure: (err: string) => void;
  /** Record a successful proxied call — clears any degradation and dismissal. */
  noteSuccess: () => void;
  /** The user dismissed the banner for the current episode. Idempotent. */
  dismiss: () => void;
}

export const useAiServiceHealthStore = create<AiServiceHealthState>()((set) => ({
  ...HEALTHY_SERVICE,
  noteFailure: (err) => set((s) => reduceFailure(s, classifyServiceFailure(err), Date.now())),
  noteSuccess: () => set((s) => reduceSuccess(s)),
  dismiss: () => set((s) => (s.dismissed ? s : { ...s, dismissed: true })),
}));
