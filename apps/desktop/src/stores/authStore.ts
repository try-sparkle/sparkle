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
  /** Re-read token presence + entitlement from the keychain/orchestration. */
  refresh: () => Promise<void>;
  /** Local sign-out: clear in-memory state AND the persisted cache (caller also clears the keychain
   *  via sparkleApi). */
  reset: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      me: null,
      tokenPresent: false,
      loading: true,
      cachedAt: null,
      paywallDismissed: false,
      setPaywallDismissed: (v) => set({ paywallDismissed: v }),
      refresh: async () => {
        const tokenPresent = await hasToken();
        if (!tokenPresent) {
          // No stored token → genuinely signed out (or never signed in). Clear the optimistic cache
          // too: without a token there is nothing to keep alive, and leaving a stale entitled `me`
          // would wrongly render the workspace for a signed-out user.
          set({ tokenPresent: false, me: null, cachedAt: null, loading: false });
          return;
        }
        const fetched = await fetchMe();
        if (fetched) {
          // AFFIRMATIVE server response — authoritative. Refresh the entitlement stamp only while
          // entitled; an affirmative "unentitled" downgrades immediately and drops the stamp, so a
          // real revocation is never masked by the grace window (the security property).
          set({
            tokenPresent: true,
            me: fetched,
            loading: false,
            cachedAt: fetched.entitled ? Date.now() : null,
          });
          return;
        }
        // fetchMe() null → network failure / backend down / an ambiguous 401 (indistinguishable at
        // the JS layer). Do NOT downgrade a paying customer: keep the last-known entitlement while
        // it's within the grace window; only re-gate once that window has lapsed.
        set((s) => {
          const valid = isEntitlementCacheValid(s.me, s.cachedAt, Date.now());
          return {
            tokenPresent: true,
            me: valid ? s.me : null,
            cachedAt: valid ? s.cachedAt : null,
            loading: false,
          };
        });
      },
      reset: () =>
        set({
          me: null,
          tokenPresent: false,
          cachedAt: null,
          loading: false,
          paywallDismissed: false,
        }),
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
