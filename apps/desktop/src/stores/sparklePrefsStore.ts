import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** localStorage key for the persisted slice (only durable interrupt rules — see partialize). */
export const SPARKLE_PREFS_PERSIST_KEY = "sparkle-prefs";

/** "mute" = never surface this topic; "allow" = default behavior (interrupt permitted).
 *  An explicit "allow" rule is stored too — it records that the user was asked and chose to keep
 *  interruptions, which a future settings UI can show, and it overwrites any earlier mute. */
export type InterruptDecision = "mute" | "allow";

/** How long a rule outlives the moment it was set. "forever" rules persist to localStorage;
 *  "session" rules are runtime-only (partialize drops them), so a relaunch reverts them to the
 *  allow default without needing any cold-start cleanup pass. */
export type InterruptScope = "session" | "forever";

/** One remembered decision about a topic. `topic` is any stable id the attention layer keys on:
 *  an agent id, an event kind ("review-waiting"), or a free-form slug ("ci-flakes"). */
export interface InterruptPreference {
  topic: string;
  decision: InterruptDecision;
  scope: InterruptScope;
  /** Epoch ms after which the rule stops applying (shouldInterrupt reverts to allow). null =
   *  no expiry. Stored as an absolute instant, not a TTL, so it survives persistence honestly. */
  expiresAt: number | null;
  /** Epoch ms when the rule was last set — for a future settings UI ("muted 3 days ago"). */
  updatedAt: number;
}

export interface SetInterruptPreferenceOpts {
  /** Defaults to "forever" — "don't interrupt me about X" should survive a relaunch unless the
   *  user says otherwise. */
  scope?: InterruptScope;
  /** Convenience: expire the rule this many ms from now. Ignored if `expiresAt` is given. */
  ttlMs?: number;
  /** Absolute expiry (epoch ms). Wins over `ttlMs`. */
  expiresAt?: number | null;
}

interface SparklePrefsState {
  /** Rules keyed by topic — one decision per topic, latest set wins. */
  rules: Record<string, InterruptPreference>;
  /** Injectable clock (epoch ms). Runtime-only (never persisted); tests swap it via setClock to
   *  exercise expiry deterministically instead of waiting on real time. */
  now: () => number;

  setInterruptPreference: (
    topic: string,
    decision: InterruptDecision,
    opts?: SetInterruptPreferenceOpts,
  ) => void;
  /** The attention layer's gate: call before surfacing anything about `topic`. Defaults to true
   *  (allow) when no rule exists, and an expired mute reads as allow again. Pure query — it never
   *  mutates state, so it is safe to call from render paths and headless code alike. */
  shouldInterrupt: (topic: string) => boolean;
  /** Forget the rule for `topic` entirely — back to the allow default. */
  clearPreference: (topic: string) => void;
  /** Active (non-expired) rules, newest first — for a future settings UI. */
  listPreferences: () => InterruptPreference[];
  /** Test hook: replace the clock. */
  setClock: (now: () => number) => void;
}

/** An expired rule no longer applies; a null expiresAt never expires. */
const isExpired = (rule: InterruptPreference, nowMs: number): boolean =>
  rule.expiresAt !== null && nowMs >= rule.expiresAt;

export const useSparklePrefsStore = create<SparklePrefsState>()(
  persist(
    (set, get) => ({
      rules: {},
      now: Date.now,

      setInterruptPreference: (topic, decision, opts) => {
        const nowMs = get().now();
        const expiresAt =
          opts?.expiresAt !== undefined
            ? opts.expiresAt
            : opts?.ttlMs !== undefined
              ? nowMs + opts.ttlMs
              : null;
        set((s) => ({
          rules: {
            ...s.rules,
            [topic]: {
              topic,
              decision,
              scope: opts?.scope ?? "forever",
              expiresAt,
              updatedAt: nowMs,
            },
          },
        }));
      },

      shouldInterrupt: (topic) => {
        const rule = get().rules[topic];
        if (!rule || rule.decision === "allow") return true;
        return isExpired(rule, get().now());
      },

      clearPreference: (topic) =>
        set((s) => {
          if (!(topic in s.rules)) return s;
          const rules = { ...s.rules };
          delete rules[topic];
          return { rules };
        }),

      listPreferences: () => {
        const nowMs = get().now();
        return Object.values(get().rules)
          .filter((r) => !isExpired(r, nowMs))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      },

      setClock: (now) => set({ now }),
    }),
    {
      name: SPARKLE_PREFS_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist only "forever"-scoped rules that are still live: session mutes die with the
      // process by never being written, the clock/actions are runtime-only, and expired rules
      // are dropped here so time-boxed mutes don't accumulate in localStorage indefinitely.
      // (shouldInterrupt already treats an expired rule as allow, so pruning is pure hygiene.)
      partialize: (s) => {
        const nowMs = s.now();
        return {
          rules: Object.fromEntries(
            Object.entries(s.rules).filter(
              ([, r]) => r.scope === "forever" && !isExpired(r, nowMs),
            ),
          ),
        };
      },
    },
  ),
);
