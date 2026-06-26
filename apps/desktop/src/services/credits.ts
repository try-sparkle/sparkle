// The metering gate (design spec §7.1). Every AI action runs through withCredits, which:
//   1. short-circuits (no debit, no work) when AI is disabled,
//   2. debits the estimated cost server-side BEFORE running (402 → out of credits),
//   3. best-effort refunds the reservation if the action throws.
// IO is injected so this is fully unit-testable; the real wiring lives in sparkleApi.ts.

export class AiDisabledError extends Error {
  constructor() {
    super("AI features are turned off");
    this.name = "AiDisabledError";
  }
}

export class OutOfCreditsError extends Error {
  /** `balanceCents` is the user's CURRENT ledger balance at reserve-failure time (what the
   *  server reports after the failed debit), not the shortfall — safe for "you have $X" UI. */
  constructor(public balanceCents: number) {
    super("Out of AI credits");
    this.name = "OutOfCreditsError";
  }
}

export type ConsumeResult =
  | { ok: true; balanceAfterCents: number; ledgerId: string }
  | { ok: false; balanceCents: number };

export interface CreditDeps {
  isAiEnabled: () => boolean;
  consume: (
    cents: number,
    reason: string,
    meta?: Record<string, unknown>,
    idempotencyKey?: string,
  ) => Promise<ConsumeResult>;
  /** Optional refund-on-failure, bound to the debit's ledger id (so it can't mint credits).
   *  Best-effort; its own errors are swallowed. */
  refund?: (ledgerId: string) => Promise<void>;
}

export interface CreditAction {
  estimateCents: number;
  reason: string;
  meta?: Record<string, unknown>;
  /** Stable key so a client retry of the SAME action debits only once. NOTE: this dedups the
   *  DEBIT only — `run()` itself re-executes on every call; callers needing run-once semantics
   *  must guard the action body separately. */
  idempotencyKey?: string;
}

export async function withCredits<T>(
  action: CreditAction,
  run: () => Promise<T>,
  deps: CreditDeps,
): Promise<T> {
  if (!deps.isAiEnabled()) throw new AiDisabledError();

  const res = await deps.consume(
    action.estimateCents,
    action.reason,
    action.meta,
    action.idempotencyKey,
  );
  if (!res.ok) throw new OutOfCreditsError(res.balanceCents);

  try {
    return await run();
  } catch (err) {
    if (deps.refund) {
      try {
        await deps.refund(res.ledgerId);
      } catch {
        // Best-effort: an orphaned reservation is an accepted loss under the estimate model
        // (design spec §7.1). Never mask the original error.
      }
    }
    throw err;
  }
}
