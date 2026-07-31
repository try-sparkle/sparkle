// THE `[pushers]` SECTION AS THE APP CONSUMES IT — and the one rule the config file may not relax.
//
// ── WHY THE BUDGET IS CLAMPED RATHER THAN READ ───────────────────────────────────────────────────
// `messagesPerHour` is editable, and it is editable in ONE DIRECTION: `resolvePusherPolicy` takes
// `min(configured, MESSAGES_PER_HOUR)`. A config file can make a Pusher quieter. It cannot make one
// louder.
//
// That asymmetry is deliberate and it follows from how this ships. The founder chose
// `enabled = true` by default over the recommended fail-safe, on the explicit reasoning that at
// rungs 0-1 the worst case of a trigger bug is noise rather than a destroyed worktree. The message
// budget is what makes that reasoning true — it is the bound on how much noise "noise" can be. A
// budget a hand-edited TOML file could raise to 999 would be a bound in name only, and the first
// time anyone raised it the safety argument for on-by-default would quietly stop holding without
// anything reporting that it had.
//
// So the ceiling lives in code next to the gate that enforces it, and the config expresses a
// preference underneath it. This is the same shape `[workers] max_concurrent` already uses — a
// CEILING ONLY, `min(configured, derived)`, never a floor — so it is the house pattern rather than
// a new one.

import { MESSAGES_PER_HOUR, INBOX_YIELD_PCT } from "./pusherGate";

/** `[pushers]`, resolved and safe to act on. Every field is already clamped. */
export interface PusherPolicy {
  /** `[pushers] enabled`. Defaults TRUE — founder decision 3. */
  enabled: boolean;
  /** Milliseconds between observation cycles for one partner. */
  observeIntervalMs: number;
  /** Challenges per partner per rolling hour. Never above {@link MESSAGES_PER_HOUR}. */
  messagesPerHour: number;
  /** Partner-inbox fill percentage at which the Pusher yields. Never above {@link INBOX_YIELD_PCT}. */
  inboxYieldPct: number;
}

// THERE IS DELIBERATELY NO `model` HERE. The design budgeted a Haiku call per observation to
// compose each challenge; `pusherTriggers` explains why that call was removed (the citation rule
// leaves a composer nothing to do but restate measured numbers, and a fixed shape is easier to
// recognise than varied prose). A `model` key nobody reads would be a lie in a config template the
// user is invited to edit, so the key does not exist either. Phase 2 may reintroduce one — with a
// caller.

/**
 * Five minutes between observation cycles for one partner.
 *
 * With no model call in the loop an observation costs no tokens and no subprocess — it is a read of
 * state the app has already polled. The floor below is therefore not about spend but about work:
 * every cycle walks the roster and touches per-partner records, and a few-second interval would
 * turn a background nicety into a busy loop across the whole fleet for no gain, since none of the
 * measurements it reads move that fast.
 */
export const OBSERVE_INTERVAL_MS = 5 * 60 * 1000;

/** Shortest observation interval accepted, whatever the config says. See {@link OBSERVE_INTERVAL_MS}. */
export const MIN_OBSERVE_INTERVAL_MS = 60 * 1000;

/**
 * What the app uses when `[pushers]` is absent or unreadable.
 *
 * DISABLED, which is the opposite of the shipped default, and the difference matters: a section
 * that is MISSING means the backend predates this feature, and a Rust build with no `[pushers]`
 * concept cannot be running a Pusher anyway. Defaulting an absent section to `enabled: true` would
 * mean an older backend appeared to have the feature switched on underneath it. `[concierge.checks]`
 * resolves an absent section the same way and for the same reason.
 */
export const PUSHERS_DISABLED: PusherPolicy = {
  enabled: false,
  observeIntervalMs: OBSERVE_INTERVAL_MS,
  messagesPerHour: MESSAGES_PER_HOUR,
  inboxYieldPct: INBOX_YIELD_PCT,
};

/** The `[pushers]` table as Rust serializes it. Wire width — a hand-edited file may hold anything. */
export interface PushersConfigPayload {
  enabled?: unknown;
  observe_interval_ms?: unknown;
  messages_per_hour?: unknown;
  inbox_yield_pct?: unknown;
}

// EVERY READER BELOW CLAMPS TOWARD SILENCE, and there is deliberately no plain positive-integer
// reader left. There was one, and routing the ceiling fields through it is what produced the two
// inversions roborev 56226 found: a `0` meaning "mute this" was rejected as non-positive and fell
// back to the CODE DEFAULT, which on both fields is the loudest value permitted. On a ceiling field
// a nonsense value must cost silence, never volume — so the fallback direction is part of each
// reader's contract rather than a detail of its caller.

/**
 * A count from an untrusted wire value, clamped toward SILENCE — 0 is legal and means "never".
 *
 * The Rust `validate` warns that `messages_per_hour = 0` means *"a Pusher can never send
 * anything"*. A positive-integer reader rejected the 0 and fell back to the code default of 4, so the user who typed 0 to silence a Pusher got the FULL shipped rate while being told they had
 * muted it (roborev 56226). User-facing copy is code: the resolver has to do what the warning says,
 * or the warning is a lie the app tells on its own initiative.
 *
 * Clamping toward quiet is also the right default independently: on a ceiling field, a nonsense
 * value should cost silence, never volume.
 */
function countOrSilent(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v < 0 ? 0 : Math.floor(v);
}

/**
 * An interval from an untrusted wire value, clamped UP to the floor rather than to the default.
 *
 * Same class of bug as {@link countOrSilent}: `observe_interval_ms = 0` fell back to the 300000
 * default, while the Rust warning promises *"Sparkle will use 60000"*. Only a value in 1..59999
 * happened to land there. Here every non-positive value resolves to the floor, so the sentence the
 * user is shown is the behaviour they get.
 */
function intervalOrFloor(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v <= 0 ? MIN_OBSERVE_INTERVAL_MS : Math.floor(v);
}

/**
 * A percentage from an untrusted wire value, clamped toward SILENCE.
 *
 * 0 is a meaningful setting here and the wrong fallback is dangerous. `inbox_yield_pct = 0` means
 * "yield always" — the quietest the field can express — and a positive-integer reader rejected it
 * and fell back to the default 80, i.e. the LOUDEST value permitted. A config edit intended to mute the Pusher would have amplified it, which is the one
 * direction this file's header promises cannot happen.
 *
 * So a nonsense value on a ceiling field resolves to the quiet end, not to the code default: a
 * negative percentage becomes 0 (always yield), and a non-number is simply absent so the caller's
 * own default applies.
 */
function pctOrQuiet(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v < 0 ? 0 : Math.floor(v);
}

/**
 * Unambiguous spellings of "off" for the kill switch.
 *
 * `enabled` is the ONLY control a user has over a feature that is on by default and attached to
 * every build agent at birth, so it is the one field where a typo must not leave the feature
 * running. TOML's own boolean is `false`, but a hand-edited file plausibly carries `"false"`,
 * `"off"`, `"no"` or `0` — every one of which is an unmistakable intent to disable, and every one of
 * which previously resolved to ENABLED.
 *
 * Note this is deliberately a list of KNOWN-OFF spellings rather than "anything not exactly `true`":
 * an absent key must still mean enabled (founder decision 3), so the default cannot be flipped.
 */
function readsAsOff(v: unknown): boolean {
  if (v === false || v === 0) return true;
  return typeof v === "string" && /^(false|off|no|0)$/i.test(v.trim());
}

/**
 * Resolve the wire payload into a policy that is safe to act on.
 *
 * Every numeric field is clamped rather than validated-and-rejected: a config typo should make the
 * Pusher quieter or slower, never disable it silently and never make it louder. The one field that
 * can switch the whole thing off is `enabled`, which is the only place a user should be able to.
 */
export function resolvePusherPolicy(payload: PushersConfigPayload | undefined | null): PusherPolicy {
  if (!payload || typeof payload !== "object") return PUSHERS_DISABLED;
  // Any unambiguous "off" disables; anything else (including a missing key on a backend that HAS
  // the section) takes the shipped default of true — founder decision 3.
  if (readsAsOff(payload.enabled)) return { ...PUSHERS_DISABLED, enabled: false };

  const interval = intervalOrFloor(payload.observe_interval_ms) ?? OBSERVE_INTERVAL_MS;
  const perHour = countOrSilent(payload.messages_per_hour) ?? MESSAGES_PER_HOUR;
  const yieldPct = pctOrQuiet(payload.inbox_yield_pct) ?? INBOX_YIELD_PCT;

  return {
    enabled: true,
    observeIntervalMs: Math.max(MIN_OBSERVE_INTERVAL_MS, interval),
    // CEILING ONLY, in both cases — see the file header.
    // `Math.max(0, …)` not `Math.max(1, …)`: 0 is a legal setting meaning "never send", and the
    // Rust warning tells the user exactly that. See countOrSilent.
    messagesPerHour: Math.max(0, Math.min(MESSAGES_PER_HOUR, perHour)),
    inboxYieldPct: Math.min(INBOX_YIELD_PCT, yieldPct),
  };
}
