// Holds the desktop's auth/entitlement state (design spec §8). AuthGate drives it; the balance
// counter and metering read from it. Refresh pulls from the Rust-backed sparkleApi.

import { create } from "zustand";
import type { Me } from "../services/entitlement";
import { fetchMe, hasToken } from "../services/sparkleApi";

interface AuthStore {
  me: Me | null;
  tokenPresent: boolean;
  loading: boolean;
  /** Re-read token presence + entitlement from the keychain/orchestration. */
  refresh: () => Promise<void>;
  /** Local sign-out: clear in-memory state (caller also clears the keychain via sparkleApi). */
  reset: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  me: null,
  tokenPresent: false,
  loading: true,
  refresh: async () => {
    const tokenPresent = await hasToken();
    const me = tokenPresent ? await fetchMe() : null;
    set({ tokenPresent, me, loading: false });
  },
  reset: () => set({ me: null, tokenPresent: false, loading: false }),
}));
