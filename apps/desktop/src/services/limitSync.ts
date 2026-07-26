// Turns REAL rate-limit events into account exhaustion flags. This is the replacement for the
// Phase-1 failover path that scraped terminal text (see rateLimitWatch.ts for why that had to go).
//
// Flow: Rust scans each account's own transcripts for structured `error: "rate_limit"` records
// (`accounts_limit_events`) → this module resolves each event's reset instant (timezone-correct,
// via `parseResetInstant`) → `markExhausted` benches the account until exactly that instant, so
// `pickAccount` routes new jobs elsewhere and the account returns to rotation on time.
//
// Two properties the old path lacked:
//   * An account can only be benched by an event found in ITS OWN transcripts, so no amount of text
//     printed by any agent can bench anything.
//   * The bench ends at the REAL reset time, not a blind fixed backoff. On live data the old 4h
//     guess sidelined an account 35 minutes longer than its actual 2:20pm reset.

import {
  listLimitEvents,
  markExhausted,
  duplicateAccountGroups,
  type Usage,
  type Account,
  type Identity,
} from "./accountStore";
import { resetInstantFor, type LimitEvent } from "./rateLimitWatch";

/** How often to look for new limit events. Cheap between limits: the Rust walk skips any transcript
 *  whose mtime predates the lookback window without opening it. */
export const LIMIT_POLL_MS = 60_000;

/** Decide which accounts need their exhaustion flag written, given the events just observed and the
 *  usage rows already known. PURE — no IO, so the policy is unit-testable.
 *
 *  An event is actionable when its computed reset is still in the future AND we aren't already
 *  benched to at-or-past that instant. The second condition makes polling idempotent: re-seeing the
 *  same event (it stays in the transcript for the whole lookback window) must not rewrite the flag
 *  on every tick. A LATER reset does update — a fresh limit after a partial recovery extends it. */
export function pendingExhaustions(
  events: LimitEvent[],
  usage: Usage[],
  now: number,
  siblings: Record<string, string[]> = {},
): { accountId: string; until: number }[] {
  const known = new Map(usage.map((u) => [u.id, u.exhaustedUntil]));
  const out: { accountId: string; until: number }[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const until = resetInstantFor(ev);
    if (until <= now) continue; // already reset — nothing to bench
    // A rate limit belongs to the LOGIN, not to the config dir. Two registrations of the same
    // Claude account share one quota, but the event only lands in the transcripts of whichever dir
    // was running — so benching that one alone leaves its twin looking healthy, winning auto-pick,
    // and re-hitting the identical limit instantly. Fan the exhaustion across the whole group.
    for (const accountId of [ev.accountId, ...(siblings[ev.accountId] ?? [])]) {
      if (seen.has(accountId)) continue;
      const current = known.get(accountId) ?? null;
      if (current != null && current >= until) continue; // already benched at least this long
      seen.add(accountId);
      out.push({ accountId, until });
    }
  }
  return out;
}

/** Build the `siblings` map {@link pendingExhaustions} needs: for each account, the OTHER accounts
 *  that are the same Anthropic login. Derived from `duplicateAccountGroups`, so it inherits its
 *  accountUuid-only matching (never nickname or email). */
export function siblingMap(accounts: Account[], identities: Identity[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of duplicateAccountGroups(accounts, identities)) {
    for (const a of group.accounts) {
      out[a.id] = group.accounts.filter((o) => o.id !== a.id).map((o) => o.id);
    }
  }
  return out;
}

/** Poll once: read real limit events and bench any account that needs it. Returns the exhaustions
 *  applied (empty when nothing is limited). Never throws — a failure here must not disturb the app;
 *  the next tick retries. */
export async function syncLimitsOnce(
  usage: Usage[],
  now: number = Date.now(),
  accounts: Account[] = [],
  identities: Identity[] = [],
): Promise<{ accountId: string; until: number }[]> {
  try {
    const events = await listLimitEvents();
    const pending = pendingExhaustions(events, usage, now, siblingMap(accounts, identities));
    // Report only the writes that actually LANDED. Returning the whole list would tell the caller
    // to bust its cache for exhaustions that never persisted, and would report a failed write as
    // success; the next tick retries either way.
    const results = await Promise.all(
      pending.map((p) =>
        markExhausted(p.accountId, p.until)
          .then(() => p)
          .catch((e) => {
            console.warn("markExhausted failed for", p.accountId, e);
            return null;
          }),
      ),
    );
    return results.filter((r): r is { accountId: string; until: number } => r != null);
  } catch (e) {
    console.warn("limit sync failed; will retry next tick", e);
    return [];
  }
}
