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
// which carry a real reset instant and lapse by the clock with nobody doing anything. That is what
// makes the banner self-clearing — the property the latched design could not have at any poll rate.
//
// PURE. `now` is injected, so every rule below is tested as arithmetic rather than by faking timers,
// and so the banner and any other reader cannot drift apart on what "currently limited" means.
import type { Usage } from "../services/accountStore";

/** The live answer: which account frees up first, and when. */
export interface UsageLimitState {
  /** The account whose limit resets soonest — the one that will end the pause. */
  accountId: string;
  /** Epoch ms when AI resumes. Real, parsed from Anthropic's own reset string upstream, so it is
   *  safe to show the user rather than the unfalsifiable "they'll resume when it resets". */
  until: number;
}

/**
 * Is Sparkle's AI paused by usage limits right now?
 *
 * WHY EVERY ACCOUNT MUST BE BENCHED, NOT JUST ONE. Sparkle runs multi-Max failover: `accountStore`
 * ranks accounts and skips any whose `exhaustedUntil` is in the future. So one benched account out
 * of three means AI is FINE — the next call simply routes elsewhere. A banner that fired on "any
 * account limited" would assert a pause that is not happening, which is the same class of false
 * claim this whole module exists to end, merely arriving from the opposite direction.
 *
 * Returns the account with the EARLIEST reset, because that is the moment the pause actually ends:
 * the first account to come back is the one that serves the next call. Naming the latest would
 * overstate the outage to the user.
 *
 * WHY AN EMPTY LIST ASSERTS NOTHING. No usage records means we have not read the accounts yet — an
 * ABSENCE of evidence, not evidence of health OR of limits. Returning `null` there means the banner
 * stays hidden until something is actually known, which is the right direction to fail: a missing
 * banner during a real outage is recovered by the very next poll, while a banner shown on no
 * evidence is exactly the stale, unfalsifiable claim being fixed.
 */
export function currentUsageLimit(usage: readonly Usage[], now: number): UsageLimitState | null {
  if (usage.length === 0) return null;

  let soonest: UsageLimitState | null = null;
  for (const u of usage) {
    // A null flag, or one whose instant has PASSED, is a usable account. `<= now` rather than
    // `< now` so the reset instant itself already counts as recovered — the banner must not
    // survive its own stated deadline by even a tick, which is precisely the "it's old" complaint.
    if (u.exhaustedUntil == null || u.exhaustedUntil <= now) return null;
    if (soonest === null || u.exhaustedUntil < soonest.until) {
      soonest = { accountId: u.id, until: u.exhaustedUntil };
    }
  }
  return soonest;
}

/**
 * How often to re-ask while a limit IS showing.
 *
 * Only runs while the banner is up, so it costs nothing on a healthy machine — which is what makes
 * a tight interval affordable here. Ten seconds is well inside "I looked away and it was gone" and
 * far finer than the reset instants involved (minutes to hours), so the banner retires promptly
 * without the app polling hard in its normal state.
 */
export const USAGE_LIMIT_RECHECK_MS = 10_000;
