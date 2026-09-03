// THE PUSHER'S SEND GATE — the only path by which a Pusher may say anything, and the reason a
// system that is ON BY DEFAULT for the whole fleet is not a nagging machine.
//
// ── WHY THIS IS A GATE AND NOT A PROMPT ──────────────────────────────────────────────────────────
// The Pusher design settles two anti-noise rules: every challenge cites a MEASURED number, and no
// partner hears more than `MESSAGES_PER_HOUR` of them. Both could have been written into the
// persona. Neither would hold.
//
// That is the top tier of the PR #900 doctrine — *"Encoding judgment as patterns teaches the model
// to produce the pattern instead of the behavior."* A persona saying "always cite a number"
// produces text that LOOKS cited: "you have several commits", "this is roughly the 8th round". A
// send path that refuses uncited text produces the behaviour, because the uncited message never
// leaves the process. So the rules live here, on the wire, where the model cannot reach them.
//
// This matters more for the Pusher than for anything else in the app because of how it ships: the
// founder chose `[pushers] enabled = true` by default AND attach-at-birth (decisions 3 and 4),
// overriding the recommended fail-safe. There is no staged opt-out standing between a trigger bug
// and every builder on the machine. The budget and the citation rule ARE the containment.
//
// ── WHAT "CITED" MEANS HERE, PRECISELY ───────────────────────────────────────────────────────────
// Not "contains a digit". The rule enforced below is stronger and is the whole point:
//
//   1. the challenge must contain at least one number, AND
//   2. EVERY number in the challenge must be one the observation actually measured.
//
// Rule 2 is what makes rule 1 worth having. Requiring merely "a number" is satisfiable by inventing
// one, and an invented number is worse than no number: it is a false measurement delivered in the
// register of a true one, which is exactly the failure the citation rule exists to prevent. A
// partner who acts on "you have 12 commits unpushed" when it has 2 has been actively misled, and it
// learns to distrust the channel — the same tune-out the two-cycle rule in `pusherTriggers` is
// built to avoid, arrived at from the other direction.
//
// So a Pusher can only ever restate arithmetic somebody else did. It cannot compute, estimate, or
// round. That is a severe constraint on what it can say and it is meant to be.
//
// ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────────────────────────
// Pure: no clock of its own (callers pass `now`), no I/O, no model call, no inbox. It decides
// whether a proposed challenge MAY be sent. It never sends one. Keeping the transport out is what
// makes every rule below unit-testable without a running app, and it is why the refusal reasons are
// data rather than log lines.

/**
 * The authority ladder. A Pusher occupies exactly one rung with respect to its partner.
 *
 *   0 observe   — reads only, emits nothing. Where a Pusher spends nearly all its wall-clock.
 *   1 challenge — one informational message. Requires no response.
 *   2 demand    — states a required response. NOT BUILT (Phase 2).
 *   3 seize     — a non-destructive turn interrupt. NOT BUILT (Phase 3).
 */
export type Rung = 0 | 1 | 2 | 3;

/**
 * The highest rung this build may reach, and the enforcement point for it.
 *
 * Phase 1 is observe-and-challenge ONLY. Rungs 2 and 3 are not partially implemented here awaiting
 * a flag — they do not exist, and this constant is what makes that a fact about the code rather
 * than a note in a document. `gateChallenge` refuses anything above it, so a caller that acquires a
 * rung-2 intent from anywhere (a future config key, a model that read the design doc and decided to
 * escalate, a merge that lands Phase 2's triggers early) still cannot emit one.
 *
 * Raising this is the deliberate act of shipping a phase. It is not a tuning knob.
 */
export const MAX_RUNG: Rung = 1;

/**
 * Challenges one partner may receive per rolling hour.
 *
 * Four is the number the design settles on, and the reasoning is a worst case rather than a
 * preference: with attach-at-birth there is one Pusher per builder, so this bounds what a SINGLE
 * builder hears. A partner that hits the cap drops to rung 0 until the window rolls — it is not
 * queued and not deferred, because a challenge that was worth sending an hour ago has usually been
 * overtaken by the work.
 */
export const MESSAGES_PER_HOUR = 4;

/** The rolling window `MESSAGES_PER_HOUR` is measured over. */
export const BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * Percentage fill above which a Pusher declines to send at all.
 *
 * COST, from the design: every message consumes one slot against the inbox's `MAX_PER_AGENT`, and
 * the inbox REFUSES AN `act` WHEN FULL RATHER THAN EVICTING ANYTHING. (The qualifier is load-bearing
 * since `inbox.rs` made the `fyi` class a ring buffer: an `fyi` at its own lower ceiling evicts the
 * stalest `fyi` instead of being refused. A Pusher message is `act`, and an `act` is never evicted
 * and never evicts, so the cost below is unchanged.) So a talkative Pusher does not merely annoy its
 * partner — it can exhaust the partner's inbox and starve the CONCIERGE's ability to reach the same
 * builder. The concierge's message is the one that carries human intent; the Pusher's is the one
 * that can wait. This threshold encodes that priority: the Pusher yields the last fifth of the
 * mailbox to whoever needs it more.
 */
export const INBOX_YIELD_PCT = 80;

/**
 * How long the SAME trigger must stay quiet after being challenged once.
 *
 * ── WHY THIS EXISTS: THE LATCHING TRIGGER ────────────────────────────────────────────────────────
 * The budget alone does not bound repetition, only rate. Two of the four triggers LATCH: once
 * `now >= goalExpiresAt` on an unmet goal, or `roborevRounds >= 8`, the condition is true on every
 * subsequent observation forever. `persistedTriggers` admits an id for being present in two
 * consecutive cycles and has no memory of whether it was ever spoken. So without this, a partner
 * with one expired goal receives the identical sentence `MESSAGES_PER_HOUR` times an hour, every
 * hour — ~96 times a day, about a goal it may have deliberately abandoned.
 *
 * That is the same tune-out the two-observation rule exists to prevent, arrived at from the other
 * direction, and it would ship ON by default fleet-wide. A Pusher that repeats itself is one its
 * partner learns to skip, which costs the whole channel and not just the repeat.
 *
 * ── WHY FOUR HOURS ───────────────────────────────────────────────────────────────────────────────
 * It matches `DEFAULT_GOAL_TTL_MS`, the app's own unit of "long enough that something should have
 * happened by now". A latched condition is therefore raised at most ~6 times a day rather than 96,
 * and a partner that acted on the first one never hears the second at all — the condition clears and
 * the cooldown is moot.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────────
 * Not an escalation ladder. The right answer to "told twice, nothing changed" is to demand or to
 * escalate, and both are Phase 2/3 authority that does not exist here. Phase 1 says it once and goes
 * quiet, which is the conservative half of that behaviour and the only half rungs 0-1 permit.
 */
export const REPEAT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/** Why a proposed challenge was refused. Data, not prose, so callers can count and test them. */
export type GateRefusal =
  /** The Pusher is disabled by config. */
  | "disabled"
  /** Rung above `MAX_RUNG` — Phase 2/3 authority that does not exist in this build. */
  | "rung-not-built"
  /** No trigger persisted across two observations, so there is nothing legitimate to say. */
  | "no-persisted-trigger"
  /** `MESSAGES_PER_HOUR` already spent on this partner within the window. */
  | "budget-exhausted"
  /** This same trigger was challenged within `REPEAT_COOLDOWN_MS`. */
  | "repeat-suppressed"
  /** The partner's inbox is at or above `INBOX_YIELD_PCT` full. */
  | "inbox-yielding"
  /** The challenge contains no number at all. */
  | "uncited"
  /** The challenge contains a number the observation never measured. */
  | "fabricated-citation"
  /** The challenge is empty or whitespace. */
  | "empty";

export interface GateAllowed {
  ok: true;
  rung: 1;
  /** The exact text cleared to send. Trimmed; never re-written otherwise. */
  text: string;
  /** The measured numbers this challenge cites, for the trigger log. */
  cited: string[];
}

export interface GateRefused {
  ok: false;
  reason: GateRefusal;
  /** One line naming what was wrong, for the trigger log. Never delivered to the partner. */
  message: string;
  /** For `fabricated-citation`: the numbers that were not measured. Empty otherwise. */
  fabricated: string[];
}

export type GateVerdict = GateAllowed | GateRefused;

/** A challenge as proposed, before the gate has cleared it. */
export interface ProposedChallenge {
  /** The intended rung. Anything above {@link MAX_RUNG} is refused. */
  rung: Rung;
  /**
   * Which trigger produced this, for the repeat check — a `TriggerId` from `pusherTriggers`.
   *
   * Typed as `string` rather than importing `TriggerId` so this module stays the leaf it claims to
   * be: the gate must not depend on the trigger catalogue, or adding a trigger would mean editing
   * the chokepoint that exists to be stable.
   */
  triggerId: string;
  /** The message text, as composed. */
  text: string;
  /**
   * Every number the observation measured, as the literal token a challenge may quote — e.g.
   * `["4", "38"]` for *"4 verified commits unpushed for 38 minutes"*.
   *
   * Includes the THRESHOLD a trigger fired against as well as the measurement itself, because a
   * legitimate challenge often names both (*"38 minutes, past the 30-minute mark"*). Both are
   * measured facts; neither is invented by the model.
   */
  measured: readonly string[];
}

/** Per-partner send history the budget is computed from. Callers own persistence. */
export interface BudgetState {
  /** Epoch-ms timestamps of challenges already delivered to this partner. */
  sentAt: readonly number[];
}

/** Inbox occupancy for the partner, as read before sending. */
export interface InboxReading {
  used: number;
  capacity: number;
}

/**
 * Numbers already spent on this partner inside the rolling window ending at `now`.
 *
 * Exported because the observation loop needs it to decide whether to spend a MODEL CALL composing
 * a challenge it could not send anyway — the budget is checked twice, once cheaply here and once
 * authoritatively in {@link gateChallenge}. Only the second one is load-bearing.
 */
export function spentInWindow(state: BudgetState, now: number): number {
  const floor = now - BUDGET_WINDOW_MS;
  return state.sentAt.filter((t) => t > floor).length;
}

/**
 * Whether this partner has budget left at `now`.
 *
 * `limit` lets a config lower the cap, and is itself clamped against {@link MESSAGES_PER_HOUR} so
 * passing a larger one cannot raise it. The clamp is applied HERE as well as in
 * `resolvePusherPolicy` on purpose: the policy resolver is one caller, and a second caller that
 * built its limits some other way must not be able to route around the ceiling by reaching this
 * function directly.
 */
export function hasBudget(state: BudgetState, now: number, limit = MESSAGES_PER_HOUR): boolean {
  // Floored at 0, NOT 1: `messages_per_hour = 0` is a legal setting meaning "never send", and the
  // config warning promises exactly that. Flooring to 1 would hand a user who asked for silence one
  // message an hour instead (roborev 56226).
  return spentInWindow(state, now) < Math.min(MESSAGES_PER_HOUR, Math.max(0, limit));
}

/**
 * Record a delivered challenge, dropping timestamps that have aged out of the window.
 *
 * Pruning on write rather than letting `sentAt` grow is deliberate: a Pusher lives as long as its
 * partner, and an unpruned array is a slow leak in a per-agent record that is held for the life of
 * the app. Bounded by `MESSAGES_PER_HOUR` entries by construction.
 */
export function recordSend(state: BudgetState, now: number): BudgetState {
  const floor = now - BUDGET_WINDOW_MS;
  return { sentAt: [...state.sentAt.filter((t) => t > floor), now] };
}

/**
 * Every distinct number in `text`, as written.
 *
 * The LEADING boundary is what separates a measurement from an identifier: `sha1`, `v2` and
 * `abc123` all have their digits preceded by a letter, so none of them is read as a number. That
 * check is the one doing the real work, and `#902` still reads as 902 (a PR number IS a citable
 * fact a caller can pass in `measured`).
 *
 * A TRAILING letter is deliberately allowed, so `3h` and `12m` read as 3 and 12. An earlier version
 * excluded them, and the contract test in `pusherTriggers.test.ts` caught what that cost: the
 * `goal-expired` fallback — *"Your goal expired 3h 12m ago"*, the highest-value trigger in the
 * design — parsed as containing NO numbers and was refused by this very gate as `uncited`. The
 * failure would have been invisible in normal operation and total whenever the composing model was
 * unavailable, which is exactly when the fallback is the only text there is.
 *
 * Erring here is one-directional and that is why this widening is safe: reading MORE numbers can
 * only make the gate STRICTER, because every number found must appear in `measured`. A challenge
 * that quotes a branch name like `5839d2fa` yields `5839` and is refused — an availability cost on
 * text a challenge has no reason to contain, never a way for an uncited claim to get through.
 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9.])\d+(?:\.\d+)?(?!\.?\d)/g;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** Normalize a numeric token so `04`, `4` and `4.0` compare equal. */
function canon(token: string): string {
  const n = Number(token);
  return Number.isFinite(n) ? String(n) : token;
}

/**
 * THE CITATION RULE. Both halves, in one place.
 *
 * Returns the numbers cited (all of which were measured) or the ones that were not. See the file
 * header for why "contains a digit" is not the rule and an invented number is worse than none.
 */
export function checkCitations(
  text: string,
  measured: readonly string[],
): { ok: true; cited: string[] } | { ok: false; reason: "uncited" | "fabricated-citation"; fabricated: string[] } {
  const found = numbersIn(text);
  if (found.length === 0) return { ok: false, reason: "uncited", fabricated: [] };
  const allowed = new Set(measured.map(canon));
  const fabricated = found.filter((t) => !allowed.has(canon(t)));
  if (fabricated.length > 0) return { ok: false, reason: "fabricated-citation", fabricated };
  return { ok: true, cited: found };
}

export interface GateInput {
  /** `[pushers] enabled`. False short-circuits everything. */
  enabled: boolean;
  challenge: ProposedChallenge;
  /** Whether a trigger persisted across two consecutive observations — see `pusherTriggers`. */
  persisted: boolean;
  budget: BudgetState;
  inbox: InboxReading;
  now: number;
  /**
   * When each trigger id was last CHALLENGED for this partner (epoch ms). Callers own persistence,
   * exactly as they do for {@link BudgetState}.
   *
   * Absent or missing entry means "never challenged", which is the permissive reading and the
   * correct one: a Pusher that has no memory should speak, not stay silent. The bound that survives
   * a lost record is the budget, which is computed from a different field.
   */
  lastChallengedAt?: Readonly<Record<string, number>>;
  /**
   * The effective per-partner limits, normally from `resolvePusherPolicy`. Omitted fields fall back
   * to the module constants, and both are re-clamped here so a caller can only ever tighten them.
   */
  limits?: { messagesPerHour?: number; inboxYieldPct?: number };
}

/** Record a delivered challenge against its trigger id, for the next cycle's repeat check. */
export function recordChallenged(
  prev: Readonly<Record<string, number>> | undefined,
  triggerId: string,
  now: number,
): Record<string, number> {
  return { ...(prev ?? {}), [triggerId]: now };
}

/**
 * Drop the cooldown for every trigger that is no longer firing — call once per cycle with the ids
 * the current observation produced.
 *
 * ── THE COOLDOWN IS PER EPISODE, NOT PER TOPIC ───────────────────────────────────────────────────
 * Without this, `REPEAT_COOLDOWN_MS` keyed on the trigger id alone, and only TWO of the four
 * triggers latch. `goal-expired` and `roborev-rounds` stay true once true, so a plain id-keyed
 * cooldown is exactly right for them. `unpushed-commits` and `unanswered-question` do the opposite:
 * they clear when the partner acts and recur later as a genuinely NEW situation.
 *
 * So an agent that was told about 4 unpushed commits, pushed them, and then wrote 3 more half an
 * hour later would have been silenced for the rest of the four hours — punished for having complied.
 * That inverts the mechanism: the cooldown exists to stop the Pusher repeating ITSELF, not to stop
 * it noticing something new.
 *
 * Clearing on absence gets both cases right with one rule and no per-trigger configuration: a
 * latching condition never goes absent, so its cooldown is never cleared and the anti-nag holds; a
 * recurring one clears the moment it resolves, so the next episode is heard immediately.
 */
export function expireClearedTriggers(
  prev: Readonly<Record<string, number>> | undefined,
  activeTriggerIds: readonly string[],
): Record<string, number> {
  if (!prev) return {};
  const active = new Set(activeTriggerIds);
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(prev)) {
    if (active.has(id)) next[id] = at;
  }
  return next;
}

/**
 * The single chokepoint. Every rule the Pusher is held to is applied here, in one function, so
 * there is exactly one place to read and one place to test.
 *
 * ORDER MATTERS, and it is cheapest-and-most-categorical first: a disabled Pusher, an unbuilt rung
 * and an unpersisted trigger are all decided without looking at the text. The citation check runs
 * LAST because it is the only one whose refusal says something about the message rather than about
 * the situation — putting it first would report "uncited" for a challenge that was never eligible
 * to be sent at all, which is a misleading line in the trigger log.
 */
export function gateChallenge(input: GateInput): GateVerdict {
  const { enabled, challenge, persisted, budget, inbox, now } = input;

  if (!enabled) {
    return { ok: false, reason: "disabled", message: "[pushers] enabled = false", fabricated: [] };
  }

  if (challenge.rung > MAX_RUNG) {
    return {
      ok: false,
      reason: "rung-not-built",
      message:
        `rung ${challenge.rung} is not built — this build ships rungs 0-${MAX_RUNG} (observe and ` +
        `challenge). Demand and seize are Phase 2/3.`,
      fabricated: [],
    };
  }

  // Rung 0 reaching the send gate is a caller bug, not a refusal to log as noise: rung 0 emits
  // nothing by definition, so there is no text to gate.
  if (challenge.rung < 1) {
    return {
      ok: false,
      reason: "rung-not-built",
      message: "rung 0 observes and emits nothing; there is no message to send",
      fabricated: [],
    };
  }

  if (!persisted) {
    return {
      ok: false,
      reason: "no-persisted-trigger",
      message:
        "no condition persisted across two consecutive observations — a state that clears itself " +
        "never reaches rung 1",
      fabricated: [],
    };
  }

  const perHour = Math.min(MESSAGES_PER_HOUR, Math.max(0, input.limits?.messagesPerHour ?? MESSAGES_PER_HOUR));
  if (!hasBudget(budget, now, perHour)) {
    return {
      ok: false,
      reason: "budget-exhausted",
      message:
        `${perHour} messages already sent to this partner in the last hour; dropping to ` +
        `rung 0 until the window rolls`,
      fabricated: [],
    };
  }

  // THE REPEAT CHECK, before the inbox read: a suppressed repeat should not spend an `inbox_status`
  // call, and its refusal is about the trigger rather than about the partner's mailbox.
  const lastAt = input.lastChallengedAt?.[challenge.triggerId];
  if (lastAt !== undefined && now - lastAt < REPEAT_COOLDOWN_MS) {
    const mins = Math.round((REPEAT_COOLDOWN_MS - (now - lastAt)) / 60_000);
    return {
      ok: false,
      reason: "repeat-suppressed",
      message:
        `${challenge.triggerId} was already challenged ${Math.round((now - lastAt) / 60_000)} ` +
        `minutes ago; quiet for another ${mins}. A latching condition repeated every window is the ` +
        `tune-out this exists to prevent.`,
      fabricated: [],
    };
  }

  // A capacity of 0 is unreadable, not empty — refuse rather than divide by it and conclude the
  // mailbox has infinite room.
  // Floored at 0, NOT at 1: zero is the quietest setting the field can express ("always yield to
  // the concierge"), and flooring it to 1 would silently turn that into "yield above 1% full",
  // which sends on an empty mailbox — the exact inversion `pctOrQuiet` exists to prevent.
  const yieldAt = Math.min(INBOX_YIELD_PCT, Math.max(0, input.limits?.inboxYieldPct ?? INBOX_YIELD_PCT));
  const pctFull = inbox.capacity > 0 ? (inbox.used / inbox.capacity) * 100 : 100;
  if (pctFull >= yieldAt) {
    return {
      ok: false,
      reason: "inbox-yielding",
      message:
        `partner inbox is ${Math.round(pctFull)}% full (${inbox.used}/${inbox.capacity}); yielding ` +
        `the remaining slots to the concierge`,
      fabricated: [],
    };
  }

  const text = challenge.text.trim();
  if (!text) {
    return { ok: false, reason: "empty", message: "challenge text is empty", fabricated: [] };
  }

  const cites = checkCitations(text, challenge.measured);
  if (!cites.ok) {
    return cites.reason === "uncited"
      ? {
          ok: false,
          reason: "uncited",
          message:
            "challenge cites no measured number. A Pusher may only restate arithmetic the " +
            "observation did; it cannot say a partner 'seems stuck'.",
          fabricated: [],
        }
      : {
          ok: false,
          reason: "fabricated-citation",
          message:
            `challenge cites ${cites.fabricated.join(", ")}, which the observation did not ` +
            `measure. Measured: ${challenge.measured.join(", ") || "(nothing)"}.`,
          fabricated: cites.fabricated,
        };
  }

  return { ok: true, rung: 1, text, cited: cites.cited };
}
