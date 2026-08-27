// usageLimit — "is Sparkle's AI actually paused RIGHT NOW, and when does it resume?"
//
// THE FAILURE THIS CLOSES (bead drodio-website-229f.4). The founder watched a top-of-window banner
// assert "Your Claude usage limit has been reached, so Sparkle's AI features are paused" while his
// whole fleet was actively running tool calls. His words: "I still see this error banner across the
// top but I think it's old. I think we need to do this to update this in a more real time."
//
// He was right, and the banner could not have been otherwise. Its state is LATCHED into
// `stores/aiProviderStore` when one of Sparkle's OWN proxied AI calls returns the
// `claude_usage_limit` sentinel, and the only thing that clears it is a LATER Sparkle AI call
// SUCCEEDING (`services/anthropic.noteAiProviderHealthy`). Agent turns do not go through that path
// at all — they run on the Claude Code CLI over a PTY — so an entire fleet can work for hours
// without ever producing the one event that retires the banner. The store also holds ONE global
// observation with NO account identity, so a limit seen on one account outlives a switch to
// another.
//
// The banner therefore asserted a TRANSITION it once observed rather than the CURRENT state. This
// module is the current state: a pure question asked of the accounts' own live exhaustion flags,
// which carry a real reset instant and lapse by the clock with nobody doing anything.
//
// ── WHAT THIS MAY AND MAY NOT DECIDE (knightwatch 5198911473#1, blocking) ───────────────────────
//
// This module may only ever say "there IS a limit". It must never be used to conclude there is not.
//
// The `usage_limit` observation is raised by Sparkle's OWN one-shot AI calls. Those run through
// `claude_oneshot::spawn_claude` with `--no-session-persistence`, so they write NO transcript — and
// `services/limitSync` benches an account solely from `error: "rate_limit"` records found in that
// account's OWN transcripts. A limit hit by a one-shot therefore produces **no `exhaustedUntil`,
// ever**. Reading "no bench" as "not limited" would hide a genuine limit, and no poll rate or trust
// delay fixes that, because the evidence is never written in the first place.
//
// An earlier revision did exactly that, via a timed "clear" heuristic. It is deleted rather than
// tuned. Positive evidence is still worth having — an `exhaustedUntil` in the future is real
// whoever wrote it, and it carries the reset instant that makes the banner checkable — so this
// module ENRICHES a banner that the store has already decided to show, and nothing more.
//
// The real destination is for the one-shot producer to record the account-specific limit state it
// actually used; then this question can be asked soundly in both directions. Tracked on the bead.
//
// PURE. `now` is injected, so every rule is tested as arithmetic rather than by faking timers.
import type { Usage } from "../services/accountStore";
import { exhaustedAccountIds } from "./blockedSubsystems";

/** A limit we can positively see, with the instant it lifts. `null` means NO POSITIVE EVIDENCE —
 *  never "no limit". */
export interface UsageLimitState {
  accountId: string;
  /** Epoch ms when the limit lifts. Real, parsed from Anthropic's own reset string upstream, so it
   *  is safe to show rather than the unfalsifiable "they'll resume when it resets". */
  until: number;
}

/**
 * Is there a live, positively-observed limit on the account Sparkle's own AI calls run under?
 *
 * @param accountId The account one-shots use — the default (`Account.isDefault`, the imported
 *                  `~/.claude`), which is what the ambient `CLAUDE_CONFIG_DIR` resolves to.
 */
export function currentUsageLimit(
  usage: readonly Usage[],
  accountId: string | null,
  now: number,
): UsageLimitState | null {
  if (accountId === null) return null;
  const mine = usage.find((u) => u.id === accountId);

  // HOW THIS SELF-CLEARS — TWO MECHANISMS, BOTH LIVE (knightwatch 5203897279#1, roborev 59675).
  //
  //   1. THE NULL ARM, once the next fetch lands. `effective_exhaustion` (`accounts.rs:1805`) opens
  //      with `acct.exhausted_until.filter(|&e| e > now)?`, so an expired bench is never serialized
  //      — it arrives as `null`. This is why a PAST instant cannot come off the wire.
  //
  //   2. THE `<= now` COMPARISON, in the window before that fetch. This is NOT defence-in-depth,
  //      and an earlier revision of this comment wrongly said it was. The consumer holds the
  //      account snapshot in React state and refetches on `USAGE_LIMIT_RECHECK_MS` (10s) through
  //      `loadAccountState`, which itself serves from a ~5s TTL cache. So a row fetched while the
  //      bench was live AGES IN THE CLIENT: for up to ~15s past the reset instant this function is
  //      called with a future-at-fetch-time `exhaustedUntil` and a later `now`. Across that window
  //      the comparison is the ONLY thing stopping a stale "paused until 5:12 PM" from rendering.
  //      The null arm cannot take over until the next fetch resolves.
  //
  // Both are load-bearing, and bead .5 (make the clear precise by letting written timestamps
  // survive `effective_exhaustion`) must not be read as licence to drop the comparison.
  if (mine?.exhaustedUntil == null || mine.exhaustedUntil <= now) return null;
  return { accountId, until: mine.exhaustedUntil };
}

/**
 * Which account Sparkle's own AI calls run under: the default, else the only one, else unknown.
 *
 * Mirrors `accountStore`'s own tie-break (`eligible.find(isDefault) ?? eligible[0]`) so the two
 * cannot drift on what "the default account" means.
 */
export function oneshotAccountId(
  accounts: readonly { id: string; isDefault: boolean }[],
): string | null {
  return accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? null;
}

/** One account as the failover selector needs to see it. `configDir` is the absolute
 *  `CLAUDE_CONFIG_DIR` for this account (the default account records `""` — "inherit"). */
export interface OneshotAccountCandidate {
  id: string;
  isDefault: boolean;
  configDir: string;
}

/** Inputs to {@link effectiveOneshotAccount}. All already read from the observable seams. */
export interface EffectiveOneshotInput {
  accounts: readonly OneshotAccountCandidate[];
  /** Per-account observed exhaustion (`exhaustedUntil` epoch ms, or null when not benched). */
  usage: readonly { id: string; exhaustedUntil: number | null }[];
  /** Ids that are signed in (a usable Claude login). A failover target must be here, or routing to
   *  it would just fail into `claude_not_authenticated`. */
  signedInIds: ReadonlySet<string>;
  /** Injected clock (epoch ms). */
  now: number;
}

/**
 * The account AI-Enhanced one-shots should ACTUALLY run under, accounting for failover.
 *
 * WHY THIS EXISTS. {@link oneshotAccountId} names the DEFAULT account and is failover-blind, so when
 * that account's Claude subscription hits its session limit, every AI-Enhanced feature is blocked at
 * once and the red "Blocked due to session limits …" bar strands the user even when another healthy
 * account is signed in (`sparkle-v3tz8j`; `sparkle-59a0w` defect #4). This picks a healthy sibling
 * to hand off to, and is the SINGLE SOURCE both the banner (which account it reports as blocked) and
 * the spawn (`services/accountSelection.oneshotFailoverConfigDir` → `CLAUDE_CONFIG_DIR`) read from,
 * so the two cannot disagree — a banner that clears while the spawn still fails, or vice-versa, is
 * exactly the split this avoids.
 *
 * THE RULE, in order:
 *   • Default account NOT walled → the default account (unchanged, ambient — the happy path).
 *   • Default walled AND a healthy (signed-in, not walled) sibling exists → that sibling (fail over).
 *   • Default walled and NOTHING healthy to hand off to → the default account, so the block is
 *     HONEST and the banner shows. Failover must never invent a target that is not actually usable.
 *
 * Returns null only when there are no accounts at all. PURE.
 */
export function effectiveOneshotAccount(
  input: EffectiveOneshotInput,
): OneshotAccountCandidate | null {
  const { accounts, usage, signedInIds, now } = input;
  const defaultAcct = accounts.find((a) => a.isDefault) ?? accounts[0];
  if (!defaultAcct) return null;

  const exhausted = exhaustedAccountIds(usage, now);
  // Happy path: the default account is usable, so run there exactly as before this selector existed.
  if (!exhausted.has(defaultAcct.id)) return defaultAcct;

  // Default is walled — hand off to the first healthy signed-in sibling, if any. Array order is the
  // stable tie-break; a walled or signed-out account is never a target.
  const healthy = accounts.find(
    (a) => a.id !== defaultAcct.id && signedInIds.has(a.id) && !exhausted.has(a.id),
  );
  // No healthy alternative → stay on the walled default so the banner tells the truth.
  return healthy ?? defaultAcct;
}

/** How often to re-ask while a limit IS showing. Only runs then, so a healthy machine pays nothing. */
export const USAGE_LIMIT_RECHECK_MS = 10_000;
