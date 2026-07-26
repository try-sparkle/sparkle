// Holds the desktop's auth/entitlement state (design spec §8). AuthGate drives it; the balance
// counter and metering read from it. Refresh pulls from the Rust-backed sparkleApi.
//
// The last-known ENTITLED `me` is persisted (zustand `persist`, same middleware the other ~8
// persisted stores use). Two things fall out of that:
//   • Cold launch renders the workspace OPTIMISTICALLY for a previously-entitled user (no bare
//     "Loading…" while /me round-trips) — see the `merge` hook below.
//   • A network failure / backend-down /me (which `fetchMe` surfaces as null) keeps the last-known
//     entitlement instead of downgrading a paying customer to the paywall — see `refresh`.
// The security property is preserved: an AFFIRMATIVE server "unentitled" downgrades immediately, a
// real sign-out clears the cache, and the offline grace window (ENTITLEMENT_GRACE_MS) re-gates a
// silently-rotated/revoked token once it lapses.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { isEntitlementCacheValid, type Me } from "../services/entitlement";
import { useUiStore } from "./uiStore";
import { shouldRearmZeroCreditBanner } from "../services/zeroCreditBanner";
import { fetchMe, hasToken } from "../services/sparkleApi";

interface AuthStore {
  me: Me | null;
  tokenPresent: boolean;
  loading: boolean;
  /** Epoch ms of the last AFFIRMATIVE server confirmation that this user is entitled. Drives the
   *  offline grace window: a cached entitlement is trusted only within ENTITLEMENT_GRACE_MS of this
   *  stamp (see isEntitlementCacheValid). Null whenever we have no confirmed-entitled state. */
  cachedAt: number | null;
  /** A signed-in-but-unpaid user dismissed the $99 paywall to stay on the free trial. Session-only
   *  (not persisted — the wall returns next launch). Lives here, not in AuthGate's local state, so
   *  BOTH AuthGate and the TopBar TrialIndicator derive the same "trial" view for this user — else
   *  TopBar (which computes its view independently) would still read them as "unpaid" and hide the
   *  in-bar counter. */
  paywallDismissed: boolean;
  setPaywallDismissed: (v: boolean) => void;
  /** The balance (cents) the SERVER last refused an AI call at, or 0 if it never has. The AI gate
   *  reads "balance > floor" (see aiGate.hasAiCredits).
   *
   *  A bare "balance > 0" was the wrong line: the server reserves a per-request HOLD before running
   *  a call (`anthropicHoldCents` — proportional to input size and maxTokens, floored at 1¢) and
   *  refuses at any balance below it. So a leftover balance of a few cents passes a >0 gate and 402s
   *  on every single call, forever, because nothing recorded the refusal.
   *
   *  DELIBERATE IMPRECISION: the 402 reports the balance, not the hold that was unaffordable, so the
   *  floor is the whole balance and closes the gate for calls the balance might still have covered.
   *  That over-blocks after an unusually expensive refusal, which is why `refresh()` clears it —
   *  see there. Session-only (never persisted): a fact about the live balance, not a cached
   *  identity, so a relaunch clears it too. */
  creditFloorCents: number;
  /** Record a server 402 (`insufficient_credits`), so the local gate stops letting calls through at
   *  a balance the server won't serve.
   *
   *  `balanceCents` is the figure the 402 body reported, or null for "no amount reported". Null
   *  falls back to the balance we already hold and leaves `me` untouched — the alternative, adopting
   *  a fabricated 0, would show a funded account as $0.00 AND persist that 0 (a `me` on an entitled
   *  user IS cached), so the fabrication would outlive the session that invented it.
   *
   *  DORMANT TODAY: nothing sends null. `classify_proxy_error` defaults an unparseable 402 body to
   *  `insufficient_credits:0`, so the only caller always has a finite figure and the fabricated 0 IS
   *  still adopted. Null is the contract the JS side holds, not a shape Rust currently produces;
   *  making the classifier emit a bare sentinel is bead sparkle-q5re. */
  noteCreditsRefused: (balanceCents: number | null) => void;
  /** Re-read token presence + entitlement from the keychain/orchestration. */
  refresh: () => Promise<void>;
  /** Write a new `me` from OUTSIDE this store (the dictation relay's per-minute balance frame is the
   *  live caller). Use this rather than `setState({ me })`: it is the seam that applies the
   *  $0-banner re-arm rule, and a raw setState silently skips it — a balance crossing back above
   *  zero through that path would latch the dismissal for the rest of the session. (roborev 48271) */
  setMe: (next: Me | null) => void;
  /** Local sign-out: clear in-memory state AND the persisted cache (caller also clears the keychain
   *  via sparkleApi). */
  reset: () => void;
}

/**
 * Apply the "$0 banner" re-arm rule to a `me` we just observed.
 *
 * Called at EVERY `me` write rather than from a component effect: the rule is a property of the
 * BALANCE, not of any banner being on screen. As an effect it would only fire while some instance of
 * ZeroCreditBanner happened to be mounted, so a refill observed during a paywall/gate render would
 * latch the dismissal for the rest of the session and silently swallow the next $0 episode.
 *
 * The decision itself lives in services/zeroCreditBanner (pure, unit-tested); this is only the seam
 * that feeds it the latched dismissal and the new `me`.
 */
function syncZeroCreditBanner(next: Me | null): void {
  const ui = useUiStore.getState();
  if (shouldRearmZeroCreditBanner(ui.zeroCreditBannerDismissedFor, next)) ui.rearmZeroCreditBanner();
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      me: null,
      tokenPresent: false,
      loading: true,
      cachedAt: null,
      paywallDismissed: false,
      creditFloorCents: 0,
      setPaywallDismissed: (v) => set({ paywallDismissed: v }),
      setMe: (next) => {
        // COMMIT first, then apply the rule: syncZeroCreditBanner writes to another store, and its
        // subscribers run synchronously — so calling it first would notify them against a `me` this
        // store hasn't stored yet. (roborev 52646/52647)
        set({ me: next });
        syncZeroCreditBanner(next);
      },
      // Contract + dormancy: see the `AuthStore.noteCreditsRefused` doc above — pointers elsewhere
      // in the codebase mean that block, not this one.
      // A reported balance is also written into `me`: it's the authoritative figure, so adopting it
      // keeps the balance UI honest without waiting on the next /me. Guarded on `me` being present
      // so a refusal can never conjure an identity for a signed-out user. A NULL (unparseable body)
      // carries no such authority — fall back to the balance we hold and leave `me` alone.
      //
      // This writes `me`, so it goes through the same commit-then-sync shape as the other seams: a
      // 402 that reports a POSITIVE balance (the hold was unaffordable, the balance wasn't zero)
      // raises `me.balanceCents` above zero, which must clear a latched $0 dismissal — otherwise the
      // banner never fires when the balance genuinely reaches zero later. (roborev 48271/53144)
      noteCreditsRefused: (balanceCents) => {
        set((s) => {
          if (balanceCents === null) {
            return { creditFloorCents: s.me?.balanceCents ?? 0, me: s.me };
          }
          return {
            creditFloorCents: balanceCents,
            me: s.me ? { ...s.me, balanceCents } : s.me,
          };
        });
        syncZeroCreditBanner(get().me);
      },
      refresh: async () => {
        const tokenPresent = await hasToken();
        if (!tokenPresent) {
          // No stored token → genuinely signed out (or never signed in). Clear the optimistic cache
          // too: without a token there is nothing to keep alive, and leaving a stale entitled `me`
          // would wrongly render the workspace for a signed-out user. No banner re-arm here: a null
          // `me` never clears a dismissal (it is indistinguishable from a transient failure at the
          // rule's layer) — a real sign-out clears it explicitly in reset().
          set({ tokenPresent: false, me: null, cachedAt: null, loading: false, creditFloorCents: 0 });
          return;
        }
        const fetched = await fetchMe();
        if (fetched) {
          // AFFIRMATIVE server response — authoritative. Refresh the entitlement stamp only while
          // entitled; an affirmative "unentitled" downgrades immediately and drops the stamp, so a
          // real revocation is never masked by the grace window (the security property).
          //
          // Drop the credit floor as well. The floor is an INFERENCE from one refusal, and it is
          // deliberately coarse (the 402 reports the balance, not the hold that was unaffordable),
          // so one unusually expensive call refused at a healthy balance would otherwise gate every
          // AI surface off — including the cheap ones that balance still covers — with no way back:
          // no cheaper call is allowed out to prove the floor wrong. Clearing here bounds that to a
          // single refresh cycle and makes it self-healing. It does NOT reopen the storm this floor
          // exists to stop: refresh is event-driven (mount, auth events, an explicit balance check),
          // never polled, so a genuinely exhausted balance costs one refused call per refresh
          // instead of one per AI surface per settled state, indefinitely.
          set({
            tokenPresent: true,
            me: fetched,
            loading: false,
            cachedAt: fetched.entitled ? Date.now() : null,
            creditFloorCents: 0,
          });
          syncZeroCreditBanner(fetched); // after the commit — see setMe
          return;
        }
        // fetchMe() null → network failure / backend down / an ambiguous 401 (indistinguishable at
        // the JS layer). Do NOT downgrade a paying customer: keep the last-known entitlement while
        // it's within the grace window; only re-gate once that window has lapsed.
        // Read → decide → set → sync. The updater stays PURE (syncZeroCreditBanner writes to another
        // store, which a zustand updater must not do), and the sync runs after the commit so uiStore
        // subscribers never observe the cleared dismissal against a stale `me`. (roborev 48271/52646)
        const prev = get();
        const valid = isEntitlementCacheValid(prev.me, prev.cachedAt, Date.now());
        const me = valid ? prev.me : null;
        set({ tokenPresent: true, me, cachedAt: valid ? prev.cachedAt : null, loading: false });
        // Same identity kept alive by the grace window (or dropped to null past it) — neither can
        // clear a dismissal, but run the rule anyway so this seam can't drift from the other one.
        syncZeroCreditBanner(me);
      },
      reset: () => {
        // A real sign-out is an EXPLICIT act, so it clears the $0-banner dismissal directly rather
        // than letting syncZeroCreditBanner infer it from `me` going null — which it must NOT do,
        // since a transient fetchMe() failure nulls `me` too (see shouldRearmZeroCreditBanner).
        set({
          me: null,
          tokenPresent: false,
          cachedAt: null,
          loading: false,
          paywallDismissed: false,
          // The floor describes ONE account's balance. Leaving it set would carry a signed-out
          // user's exhausted balance onto whoever signs in next and gate their AI off.
          creditFloorCents: 0,
        });
        useUiStore.getState().rearmZeroCreditBanner(); // after the commit, like every other seam
      },
    }),
    {
      name: "sparkle-auth",
      storage: createJSONStorage(() => localStorage),
      // Persist ONLY the confirmed-entitled identity + its stamp. A non-entitled `me` is never
      // cached (nothing to render optimistically, and it must never be treated as last-known-good),
      // and the volatile fields (tokenPresent/loading/paywallDismissed) are recomputed each launch.
      partialize: (s) => ({
        me: s.me?.entitled ? s.me : null,
        cachedAt: s.me?.entitled ? s.cachedAt : null,
      }),
      // On hydrate, decide whether to render optimistically. A still-valid entitled cache seeds
      // `me` + `tokenPresent` and clears `loading`, so the very first frame after a cold launch is
      // the workspace (not "Loading…") while refresh() revalidates in the background. A stale/expired
      // cache is dropped here so it can never flash the workspace beyond the grace window.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<AuthStore, "me" | "cachedAt">>;
        const merged: AuthStore = {
          ...current,
          me: p.me ?? null,
          cachedAt: p.cachedAt ?? null,
        };
        if (isEntitlementCacheValid(merged.me, merged.cachedAt, Date.now())) {
          merged.tokenPresent = true;
          merged.loading = false;
        } else {
          merged.me = null;
          merged.cachedAt = null;
        }
        return merged;
      },
    },
  ),
);
