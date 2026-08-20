// THE ZERO-SPEND GATE — the hard constraint the whole advisor pass is built underneath.
//
// The founder will spend NOTHING outside his Claude Max subscription. Not a small amount, not
// temporarily, not "just to measure it". Zero. So this module answers ONE question before any
// advisor call is dispatched — *can this call, in this account state, land anywhere other than the
// subscription?* — and it answers it from the LIVE usage payload, never from a constant.
//
// ══ WHY `extra_usage.is_enabled == false` IS THE ONLY STATE THAT PERMITS A CALL ═════════════════
//
// Usage credits are an OPT-IN METER sitting beside the subscription. While `is_enabled` is false the
// meter is DISARMED: there is no billable destination for an overflow to land on, so a call cannot
// bill outside the subscription — it either runs on the subscription or is refused by the API. That
// is the entire permission argument, and it is a fact about the ACCOUNT, not about this call's size.
//
// While `is_enabled` is true, a call COULD land on credits. Not *would* — could. That distinction is
// where a cheaper gate would go wrong: one might reason "there is headroom in the 5-hour window, so
// this particular call bills to the subscription anyway". That reasoning is a PREDICTION about a
// window that other agents on this machine are consuming concurrently, and being wrong costs real
// money against an instruction that admits no small amount. So armed credits REFUSE, headroom or no.
//
// ══ FAIL CLOSED. AN UNREADABLE METER IS NOT PERMISSION. ═════════════════════════════════════════
//
// Every path that is not an affirmative, readable `is_enabled === false` refuses: the fetch failed,
// the section is absent (an older backend, or the passthrough not yet landed), the field is null, the
// field is not a boolean. The failure this avoids is the one that reads as harmless — a payload that
// could not be parsed defaulting to "well, nothing said credits were on" and spending anyway. There
// is no observation behind that; it is an absence of observation wearing a verdict's clothes, which
// is the same shape `judge.rs` records as the single most-cited incident in this codebase.
//
// PURE. No IO, no store reads, no clock. The payload is passed in, so every row of the table below
// is one unit test with no AI call, no network and no mocking framework.

/**
 * The `extra_usage` block of Anthropic's `/usage` payload, as it reaches the webview.
 *
 * ══ THE PASSTHROUGH HAS LANDED (bead `sparkle-iclm0`) ═════════════════════════════════════════
 *
 * This block used to be DISCARDED by `apps/desktop/src-tauri/src/account_usage.rs`, so in
 * production every account folded to `usage-field-absent` and this gate refused unconditionally —
 * correct fail-closed behaviour, and completely inert. That is no longer true: `AccountUsageLive`
 * now carries `extraUsage`, `deps.ts` reads it with a plain typed call rather than a cast, and the
 * gate can return something other than a refusal.
 *
 * The camelCase names here are PINNED, and by a Rust test rather than by this comment:
 * `the_serialized_key_names_are_exactly_what_the_advisor_spend_gate_reads` in `account_usage.rs`
 * asserts the SERIALIZED json keys — that `extraUsage.isEnabled` et al are present and that the
 * snake_case forms are not. That distinction is the whole point: the Rust field is `pub
 * extra_usage` in both the correct and the broken case, because `rename_all` decides the wire form
 * and does NOT descend into a nested struct. An inner type missing its own attribute would send
 * `extraUsage.is_enabled`, every account would fold to "field absent", and this gate would refuse
 * forever with nothing reporting why.
 *
 * A garbled MEMBER cannot fake permission either: the Rust side reads each scalar leniently and
 * degrades an unreadable one to `None`, which arrives here as null and is read below as
 * "cannot prove credits are disarmed". The worst case is a pass that declines to run.
 *
 * ══ `T | null`, NEVER `T?` ═════════════════════════════════════════════════════════════════════
 *
 * A Rust `Option` crosses the wire as an explicit `null`; serde omits the key only under
 * `skip_serializing_if`, which `account_usage.rs` does not use. `field?: T` means `T | undefined`,
 * which does not include `null` — a parser written that way describes a shape the wire cannot
 * produce. Both are treated as equivalent at every read site below anyway, because this gate must
 * not be able to distinguish "absent" from "null" into a permission.
 */
export interface ExtraUsagePayload {
  /** Are usage credits ARMED? `false` is the only value that permits an advisor call. */
  isEnabled?: boolean | null;
  /** The monthly spend cap, in dollars. Read for the audit note only — never for the verdict. */
  monthlyLimit?: number | null;
  /** Credits consumed this period. The empirical latch (see `usedCreditsDelta`) reads this. */
  usedCredits?: number | null;
  /** Percent of the credit allowance consumed. Diagnostic only. */
  utilization?: number | null;
  /** Has the account hit its spend limit? `true` refuses unconditionally. */
  spendLimitReached?: boolean | null;
}

/**
 * The slice of `AccountUsageLive` this gate reads. Structural on purpose — it is satisfied by the
 * real payload without importing it, so this module does not depend on a file that is still being
 * written, and a test can hand it a literal.
 */
export interface UsagePayloadForGate {
  extraUsage?: ExtraUsagePayload | null;
}

/** Every reason the gate can refuse. A closed union so the audit note and the tests enumerate the
 *  same set, and adding a refusal path fails `tsc` until it is named here. */
export type SpendRefusalReason =
  /** `extra_usage.is_enabled === true` — a call COULD land on credits. */
  | "credits-armed"
  /** `extra_usage.spend_limit_reached === true` — unconditional, even with credits disarmed. */
  | "spend-limit-reached"
  /** No payload at all: the fetch failed, or the account has no live usage yet. */
  | "usage-unreadable"
  /** A payload arrived but carried no `extra_usage`, or `is_enabled` was null/absent/not a bool. */
  | "usage-field-absent";

/** The gate's verdict. `allowed: true` carries the credit reading the latch will compare against. */
export type SpendVerdict =
  | { allowed: true; usedCreditsBefore: number | null }
  | { allowed: false; reason: SpendRefusalReason };

/** Human-readable one-liner for each refusal, for the durable bead comment. Kept beside the union
 *  so a new reason cannot ship without its sentence. */
export const SPEND_REFUSAL_TEXT: Record<SpendRefusalReason, string> = {
  "credits-armed":
    "usage credits are ARMED (extra_usage.is_enabled = true), so an advisor call could bill outside the Claude Max subscription",
  "spend-limit-reached":
    "the account reports spend_limit_reached = true, which refuses unconditionally",
  "usage-unreadable":
    "the live usage payload could not be read at all, and an unreadable meter is not permission",
  "usage-field-absent":
    "the live usage payload carried no readable extra_usage.is_enabled, and an absent field is not permission",
};

/**
 * MAY an advisor call be dispatched right now?
 *
 * The table, in evaluation order — `spend_limit_reached` first because it is unconditional and must
 * not be reachable-past by a disarmed meter:
 *
 *   | payload state                              | verdict |
 *   |--------------------------------------------|---------|
 *   | `spend_limit_reached === true`             | REFUSE  (unconditional)
 *   | `is_enabled === false`                     | RUN
 *   | `is_enabled === true`                      | REFUSE  ("credits-armed")
 *   | `is_enabled` null / absent / not a boolean | REFUSE  ("usage-field-absent")
 *   | `extra_usage` null / absent                | REFUSE  ("usage-field-absent")
 *   | no payload at all                          | REFUSE  ("usage-unreadable")
 *
 * `usage` is `null | undefined` for "we could not read it", which is a THIRD answer and not a
 * synonym for a payload full of nulls — the two refuse alike, but they refuse with different
 * reasons, and the audit note the founder reads days later has to say which.
 */
export function checkSpendGate(usage: UsagePayloadForGate | null | undefined): SpendVerdict {
  if (!usage) return { allowed: false, reason: "usage-unreadable" };
  const extra = usage.extraUsage;
  if (!extra) return { allowed: false, reason: "usage-field-absent" };

  // FIRST, and unconditionally. A `spend_limit_reached` account is refused even with the meter
  // disarmed: the brief says "unconditionally", and ordering it after the `is_enabled === false`
  // permission would make it unreachable in exactly the state it is most likely to be set in.
  if (extra.spendLimitReached === true) {
    return { allowed: false, reason: "spend-limit-reached" };
  }

  // The ONE permitting state, tested by identity rather than truthiness. `!extra.isEnabled` would
  // read `null`, `undefined` and `0` as permission — i.e. every unreadable shape would spend, which
  // is the precise inversion this module exists to prevent.
  if (extra.isEnabled === false) {
    return {
      allowed: true,
      // Captured HERE, from the same payload the verdict was made on, so the latch's "before" and
      // the permission cannot come from two different reads of a moving meter.
      usedCreditsBefore: typeof extra.usedCredits === "number" ? extra.usedCredits : null,
    };
  }
  if (extra.isEnabled === true) return { allowed: false, reason: "credits-armed" };
  return { allowed: false, reason: "usage-field-absent" };
}

/**
 * Did the credit meter MOVE across the first gate-approved advisor call?
 *
 * ══ WHY THIS EXISTS: NOBODY HAS ESTABLISHED WHICH METER ADVISOR USAGE HITS ══════════════════════
 *
 * The gate above rests on a claim about the account — that with credits disarmed, a call cannot bill
 * outside the subscription. That claim is well-founded and it is still a claim. This is the
 * EMPIRICAL test of it, and it is safe to run for exactly the reason it is worth running: it can
 * only ever execute while credits are DISARMED, so its worst case is a call that fails, never a bill.
 *
 * If `used_credits` moved across the first approved call, the premise is wrong somewhere and the
 * advisor LATCHES ITSELF OFF — it does not retry, does not average, does not wait for a second data
 * point. One movement is the whole finding.
 *
 * Returns `null` when the comparison cannot be made (either reading absent). A null is NOT "it did
 * not move": it is "we cannot say", and the caller must not latch on it — a latch on an unreadable
 * meter would disable the advisor permanently on the first account whose payload omits the field,
 * which is a different failure from the one this guards.
 */
export function usedCreditsDelta(
  before: number | null | undefined,
  after: number | null | undefined,
): number | null {
  if (typeof before !== "number" || typeof after !== "number") return null;
  return after - before;
}

/** Did the meter move enough to latch? Strictly non-zero — this is a counter, not a measurement,
 *  so there is no tolerance band to apply and inventing one would be a way to explain a real
 *  movement away. A NEGATIVE delta counts too: a period rollover is not proof of innocence, and an
 *  unexplained backwards move is exactly as much of a reason to stop and ask a human. */
export function creditsMoved(delta: number | null): boolean {
  return delta !== null && delta !== 0;
}

/**
 * The gate across EVERY registered account, which is what production actually has to answer.
 *
 * ══ WHY THIS IS NOT `checkSpendGate(theActiveAccount)` ══════════════════════════════════════════
 *
 * There is no "active account" to read. The advisor's child is the user's own `claude` CLI, spawned
 * by `research.rs`, and which registered config dir that resolves to is not a fact this layer holds
 * — Sparkle registers several and switches between them. So asking one account's meter would be a
 * guess about which meter the call lands on, and a wrong guess spends money against an instruction
 * that admits no small amount.
 *
 * The fail-closed reading is therefore UNANIMITY: every registered account must be readable AND
 * disarmed. The first refusal wins and is returned verbatim, so the audit note names the actual
 * reason rather than a summary of one.
 *
 * AN EMPTY LIST REFUSES. "No account to read" is not permission — it is the absence of the
 * observation the permission rests on, which is the same shape as an unreadable payload and gets the
 * same answer.
 *
 * The `usedCreditsBefore` returned is the SUM across accounts, so the latch's before/after
 * comparison is over the same quantity on both sides. An account whose reading is absent contributes
 * nothing rather than poisoning the sum to null — the sum is only used to detect MOVEMENT, and a
 * consistently-absent field simply never moves.
 */
export function checkSpendGateForAccounts(
  payloads: readonly (UsagePayloadForGate | null | undefined)[],
): SpendVerdict {
  if (payloads.length === 0) return { allowed: false, reason: "usage-unreadable" };
  let total = 0;
  let sawAny = false;
  for (const p of payloads) {
    const v = checkSpendGate(p);
    if (!v.allowed) return v;
    if (v.usedCreditsBefore !== null) {
      total += v.usedCreditsBefore;
      sawAny = true;
    }
  }
  return { allowed: true, usedCreditsBefore: sawAny ? total : null };
}
