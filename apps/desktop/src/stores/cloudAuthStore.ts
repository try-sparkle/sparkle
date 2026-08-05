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
  /**
   * True once we KNOW the server's answer — set by a SUCCESSFUL probe and by a completed
   * save/delete, and deliberately left unchanged by a FAILED probe (see {@link attempted}).
   *
   * `false` therefore means UNKNOWN, never "none saved", and no gate may conflate the two: an
   * offline probe would otherwise read as "this account has no credential" for the rest of the
   * sign-in. That is the whole rule the cloud gates are built on — `useCloudGate` and
   * `readCloudGate` both treat `!loaded` as allowed and defer to `POST /sessions/start`.
   */
  loaded: boolean;
  /**
   * True once a probe has been ATTEMPTED, whether or not it worked. Distinct from `loaded`, and the
   * distinction is what bounds the automatic hydration in `useCloudGate`.
   *
   * `refresh` deliberately leaves `loaded` FALSE on failure — a failed probe must not read as "we
   * know there's none saved". So an effect that retries while `!loaded` retries forever for anyone
   * offline or hitting a 5xx, with no backoff: exactly the loop roborev 58470 caught. `attempted`
   * survives failure, so it can bound "we already tried this sign-in" without ever claiming to know
   * the answer. Cleared by `reset` (sign-out), so signing back in probes again.
   */
  attempted: boolean;
  /** A request (load/save/delete) is in flight. */
  busy: boolean;
  /** Last user-facing error, or null. Cleared at the start of each request. */
  error: string | null;
  /**
   * Fetch the current method. Never throws; a failure sets `error` and leaves `method` alone.
   *
   * Concurrent callers JOIN the probe already in flight — they do NOT get a no-op — so N consumers
   * mounting in one commit produce ONE request while every one of them still observes the hydrated
   * store when its own promise resolves. AWAITING THE RETURNED PROMISE IS MEANINGFUL, and that is
   * load-bearing: `conciergeTools/lifecycle.readCloudGate` awaits it precisely to re-read `method`
   * afterwards, and an earlier version that returned early there refused the first cloud spawn of
   * every launch.
   *
   * An answer that arrives after a sign-out or a completed save/delete is DISCARDED rather than
   * written, so a stale probe cannot latch the previous account's credential into the new session.
   */
  refresh: () => Promise<void>;
  /**
   * Save a credential. The secret is passed straight to the API and never stored here.
   *
   * TRUE MEANS "THIS SESSION'S WRITE COMPLETED AND WAS NOT SUPERSEDED" — which is NOT the same as
   * "the server call succeeded". A sign-out or a newer write landing while this one is in flight
   * yields **false even though the PUT succeeded server-side**, because its result belongs to an
   * account the user has already left. THE CALLER MUST NOT RETRY ON FALSE: retrying would re-write
   * a credential for the previous account. Treat it as "this attempt did not take effect here",
   * and surface `error` only if it is set (a superseded write deliberately sets none).
   */
  save: (method: ClaudeAuthMethod, secret: string) => Promise<boolean>;
  /** Delete the stored credential. Same return contract as {@link save} — see its note on why
   *  `false` does not mean the server call failed, and must not be retried. */
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

/** The probe currently in flight, shared by every caller so they JOIN it rather than race or drop.
 *  Module-scoped rather than in the store because it is a promise, not UI state — nothing renders
 *  from it, and putting a promise in the store would make it a subscribable value nobody may read. */
let inFlightProbe: Promise<void> | null = null;

/** Bumped by anything that makes an outstanding request's result WRONG rather than merely late — a
 *  sign-out (different account) and a completed save/delete (newer truth).
 *
 *  A PROBE **OR A WRITE** compares the epoch it captured at start against this before every `set`.
 *  Both halves are load-bearing, and reading it as "bumping is for probes; writes only bump" is
 *  exactly what left `save`/`remove` stamping a signed-out account's credential onto the next
 *  session — they bumped it without ever checking it. */
let probeEpoch = 0;

export const useCloudAuthStore = create<CloudAuthState>()((set) => ({
  method: null,
  loaded: false,
  attempted: false,
  busy: false,
  error: null,

  refresh: () => {
    // THE IN-FLIGHT GUARD LIVES HERE, not in the callers. A caller can only test the value it
    // captured at render, so two consumers mounting in the same commit both see the store idle and
    // both fire. Only the store can answer the second one truthfully.
    //
    // IT JOINS THE IN-FLIGHT PROBE, IT DOES NOT DROP THE CALL (roborev 58489). Returning early
    // would resolve the second caller's promise immediately, and one caller awaits this precisely
    // to read the result: `conciergeTools/lifecycle.readCloudGate` does
    // `if (!loaded) await refresh()` and then re-reads `method`. Dropped, it re-reads `null` and
    // refuses the first cloud spawn of every launch with "add your Claude authentication" — the
    // exact refusal that probe exists to prevent. Sharing the promise gives both properties: ONE
    // request, and every awaiting caller sees the hydrated store when its own promise resolves.
    //
    // Keyed on a PROBE-SPECIFIC handle rather than on `busy`, which is the multi-purpose
    // "load/save/delete in flight" flag: keying on `busy` let a `save` swallow a consumer's only
    // probe, and since `busy` is no longer an effect dependency nothing would ever re-run it.
    if (inFlightProbe) return inFlightProbe;
    // THE EPOCH IS WHAT MAKES A LATE ANSWER HARMLESS. Dropping the handle on sign-out stops the
    // next caller JOINING a stale probe, but it does nothing about that probe's own continuation,
    // which still runs and still writes. A GET issued for account A settling after a sign-out would
    // stamp A's `method` — and `attempted: true` — onto B's store; since `attempted` is exactly what
    // bounds hydration, B would then NEVER re-probe and would read A's credential for the rest of
    // the process (roborev 58498). Anything that changes what the truth IS bumps the epoch, and a
    // probe whose epoch has moved writes nothing at all.
    const epoch = probeEpoch;
    const probe = (async () => {
      if (epoch !== probeEpoch) return;
      set({ busy: true, error: null });
      try {
        const info = await cloudApi.getClaudeAuth();
        if (epoch !== probeEpoch) return;
        set({ method: info?.method ?? null, loaded: true, attempted: true, busy: false });
      } catch (err) {
        if (epoch !== probeEpoch) return;
        // Leave `loaded` as it was: a failed probe must not be read as "we know there's none saved".
        // `attempted` IS set — that is what stops the automatic hydration retrying forever.
        set({ busy: false, attempted: true, error: messageFor(err) });
      }
    })();
    // Cleared when it settles, so this is an IN-FLIGHT guard and not a once-per-session latch —
    // `attempted` is what bounds repetition, and the two must not be conflated.
    //
    // ONLY IF IT IS STILL OURS. A stale probe settling after a reset would otherwise null the
    // CURRENT probe's handle, silently disarming the guard for the rest of that probe — so the next
    // refresh issues a duplicate GET, in the auth-transition window where it matters most.
    const handle: Promise<void> = probe.finally(() => {
      if (inFlightProbe === handle) inFlightProbe = null;
    });
    inFlightProbe = handle;
    return handle;
  },

  save: async (method, secret) => {
    // A WRITE IS AS SUPERSEDABLE AS A PROBE. Bumping the epoch without also CHECKING it left this
    // path with the exact latch the probe was just fixed for, reached through the other door: a PUT
    // in flight when the user signs out keeps its continuation, and stamps account A's credential —
    // and the `attempted: true` that bounds hydration — onto B's freshly-reset store. Both buttons
    // live in the same open dialog and nothing disables sign-out while a write is running.
    const epoch = probeEpoch;
    set({ busy: true, error: null });
    try {
      await cloudApi.putClaudeAuth(method, secret);
      if (epoch !== probeEpoch) return false;
      // A COMPLETED WRITE IS NEWER TRUTH THAN ANY PROBE THAT WAS ALREADY IN FLIGHT. Without this,
      // a GET issued before the save but settling after it overwrites the just-saved method with
      // the server's PRE-save answer — and `loaded: true` makes that stale value authoritative, so
      // a user who just saved a credential is told none is configured.
      probeEpoch += 1;
      set({ method, loaded: true, attempted: true, busy: false });
      return true;
    } catch (err) {
      // The error belongs to a session that no longer exists — reporting it would be as wrong as
      // reporting the success. `false` is the honest answer to "did THIS session save": no.
      if (epoch !== probeEpoch) return false;
      set({ busy: false, error: messageFor(err) });
      return false;
    }
  },

  remove: async () => {
    const epoch = probeEpoch; // same reasoning as `save`
    set({ busy: true, error: null });
    try {
      await cloudApi.deleteClaudeAuth();
      if (epoch !== probeEpoch) return false;
      probeEpoch += 1; // a completed delete outranks a probe that was already in flight
      set({ method: null, loaded: true, attempted: true, busy: false });
      return true;
    } catch (err) {
      if (epoch !== probeEpoch) return false;
      set({ busy: false, error: messageFor(err) });
      return false;
    }
  },

  reset: () => {
    // Bump the epoch AND drop the handle. Two different hazards: the epoch stops a probe belonging
    // to the signed-out session from WRITING its answer into the new one, and the handle stops the
    // next caller from JOINING it. Dropping the handle alone was the incomplete half.
    probeEpoch += 1;
    inFlightProbe = null;
    set({ method: null, loaded: false, attempted: false, busy: false, error: null });
  },
}));
