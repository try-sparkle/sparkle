// Holds the desktop's auth/entitlement state (design spec §8). AuthGate drives it; the balance
// counter and metering read from it. Refresh pulls from the Rust-backed sparkleApi.

import { create } from "zustand";
import type { Me } from "../services/entitlement";
import { fetchMe, hasToken } from "../services/sparkleApi";

interface AuthStore {
  me: Me | null;
  tokenPresent: boolean;
  loading: boolean;
  /** A signed-in-but-unpaid user dismissed the $99 paywall to stay on the free trial. Session-only
   *  (not persisted — the wall returns next launch). Lives here, not in AuthGate's local state, so
   *  BOTH AuthGate and the TopBar TrialIndicator derive the same "trial" view for this user — else
   *  TopBar (which computes its view independently) would still read them as "unpaid" and hide the
   *  in-bar counter. */
  paywallDismissed: boolean;
  setPaywallDismissed: (v: boolean) => void;
  /** Re-read token presence + entitlement from the keychain/orchestration. */
  refresh: () => Promise<void>;
  /** Local sign-out: clear in-memory state (caller also clears the keychain via sparkleApi). */
  reset: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  me: null,
  tokenPresent: false,
  loading: true,
  paywallDismissed: false,
  setPaywallDismissed: (v) => set({ paywallDismissed: v }),
  refresh: async () => {
    const tokenPresent = await hasToken();
    const me = tokenPresent ? await fetchMe() : null;
    set({ tokenPresent, me, loading: false });
  },
  reset: () => set({ me: null, tokenPresent: false, loading: false, paywallDismissed: false }),
}));
