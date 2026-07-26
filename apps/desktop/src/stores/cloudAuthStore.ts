// Claude-auth-for-cloud-agents state (Service B, W5). Holds ONLY the non-secret facts the UI needs:
// WHICH method the server has stored for this user ("byok" | "subscription"), whether we've asked
// yet, and the last error. The secret itself is never held here, never persisted, and never read
// back — the server returns the method only (api.ts §getClaudeAuth), and the Settings panel clears
// its input on a successful save.
//
// Deliberately NOT persisted: a stale "auth configured" cached from a previous launch would let the
// creation gate wave a cloud start through into a guaranteed 400. It's one cheap GET on demand.

import { create } from "zustand";
import { cloudApi, type ClaudeAuthMethod } from "../services/cloudAgents/api";
import { classifyStartError } from "../services/cloudAgents/startError";

interface CloudAuthState {
  /** The method the server has stored, or null for "none saved". Meaningless until `loaded`. */
  method: ClaudeAuthMethod | null;
  /** True once a GET has completed (successfully or not) — distinguishes "none saved" from
   *  "we haven't looked yet", which the gate must not conflate. */
  loaded: boolean;
  /** A request (load/save/delete) is in flight. */
  busy: boolean;
  /** Last user-facing error, or null. Cleared at the start of each request. */
  error: string | null;
  /** Fetch the current method. Never throws; a failure sets `error` and leaves `method` alone. */
  refresh: () => Promise<void>;
  /** Save a credential. Returns true on success. The secret is passed straight to the API and
   *  never stored here. */
  save: (method: ClaudeAuthMethod, secret: string) => Promise<boolean>;
  /** Delete the stored credential. Returns true on success. */
  remove: () => Promise<boolean>;
  /** Drop everything (sign-out). */
  reset: () => void;
}

/**
 * Turn any thrown error into a short user-facing line. Reuses the start-error classifier so the
 * Settings panel and the creation flow phrase the same failure the same way — EXCEPT for the one
 * code that only this route emits: the server 403s `subscription_auth_disabled` when
 * `SPARKLE_ENABLE_SUBSCRIPTION_AUTH` is off (it refuses to store a credential it could never use).
 * The generic classifier would read that 403 as "the whole feature is off", which is both wrong and
 * unactionable; the honest message names the one method that IS available.
 */
export function claudeAuthErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.includes("subscription_auth_disabled")) {
    return "Subscription tokens aren't enabled on the Sparkle server yet — save an API key instead.";
  }
  if (typeof code === "string" && code.includes("secret_method_mismatch")) {
    return "That secret doesn't match the selected method — API keys go under \"API key\", and subscription setup-tokens (sk-ant-oat…) under \"Subscription\".";
  }
  return classifyStartError(err).message;
}

const messageFor = claudeAuthErrorMessage;

export const useCloudAuthStore = create<CloudAuthState>()((set) => ({
  method: null,
  loaded: false,
  busy: false,
  error: null,

  refresh: async () => {
    set({ busy: true, error: null });
    try {
      const info = await cloudApi.getClaudeAuth();
      set({ method: info?.method ?? null, loaded: true, busy: false });
    } catch (err) {
      // Leave `loaded` as it was: a failed probe must not be read as "we know there's none saved".
      set({ busy: false, error: messageFor(err) });
    }
  },

  save: async (method, secret) => {
    set({ busy: true, error: null });
    try {
      await cloudApi.putClaudeAuth(method, secret);
      set({ method, loaded: true, busy: false });
      return true;
    } catch (err) {
      set({ busy: false, error: messageFor(err) });
      return false;
    }
  },

  remove: async () => {
    set({ busy: true, error: null });
    try {
      await cloudApi.deleteClaudeAuth();
      set({ method: null, loaded: true, busy: false });
      return true;
    } catch (err) {
      set({ busy: false, error: messageFor(err) });
      return false;
    }
  },

  reset: () => set({ method: null, loaded: false, busy: false, error: null }),
}));
