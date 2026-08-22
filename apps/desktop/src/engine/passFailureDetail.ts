// THE HEADLESS PASS'S FAILURE STRING IS NOT TERMINAL SCROLLBACK, AND THAT DISTINCTION IS THE WHOLE
// REASON THIS FILE EXISTS.
//
// ── THE BUG IT CLOSES (bead sparkle-16y6h's shape, measured on this row) ─────────────────────────
// The founder screenshotted the Improve Sparkle agent sitting on a session limit with a GRAY dot and
// said it should have been RED. He is right: a session limit is a hard stop, no retry clears it, and
// red's own definition in `packages/ui/tokens.ts` is "you are the only one who can clear this".
//
// The obvious fix — reuse `engine/quotaBlock.quotaBlockIn`, the detector `StatusEngine` already uses
// for build rows — is CORRECT FOR THE PANE-OPEN PATH and inert for this one. `quotaBlockIn` is a
// SCROLLBACK detector: it splits `\r` frames, strips `⏺` markers, joins adjacent wrapped rows, and
// then demands a `^You've hit your … limit` opener plus a separator-led `· resets` tail. That is the
// right instrument for a PTY, and keeping it is what gives this row colour parity with build rows.
//
// The headless pass never produces a PTY. `src-tauri/src/sparkle_improve.rs::failure_message` returns
// stderr, else claude's STRUCTURED `detail` from the stream's `result` event, else plain stdout, else
// a synthesized exit-status phrase. The recurring real-world hourly failure is exit 1 with EMPTY
// stderr, so what arrives is one sentence of claude's own prose — and the crate pins exactly that
// shape in `failure_message_surfaces_claude_detail_when_stderr_empty`, asserting the message is
// literally `"Claude usage limit reached"`.
//
// Measured against that real string: `quotaBlockIn` says NO (no opener, no tail), and an opener
// anchored on `^usage limit reached` also says NO, because the string LEADS WITH "Claude". So the
// most likely real session limit on this row would have stayed AMBER with every suite green — two
// halves built against a frozen assumption, clean merge, feature never once runs.
//
// ── WHY IT DELEGATES RATHER THAN MATCHING ───────────────────────────────────────────────────────
// `engine/conciergeFailureNotice` already owns a battle-tested classifier for precisely this shape —
// one structured sentence, no frames, no markers — and it is dependency-free. Reusing its exported
// entry point rather than restating its patterns matters for two reasons:
//
//   • Its AUTH pattern carries a scar this file must not reopen. It used to read
//     `oauth token (?:expired|invalid)`; what the CLI actually emits is "OAuth **session** expired
//     and could not be refreshed". One wrong noun sent the most unambiguous auth failure the CLI can
//     produce to `unknown`, which told the founder to retry — and no number of retries could work.
//   • Its ordering is load-bearing and already correct: QUOTA is tested BEFORE AUTH, because "a 429
//     can mention authorization, and a rate limit is a quota fact, not a credential one".
//
// Two copies of one rule always drift; this repo has the bead trail to prove it. Delegate.
import { conciergeFailureNotice, isAuthFailure } from "./conciergeFailureNotice";

/** A failure NOTHING will clear on its own — the founder is the only actor who can.
 *
 *  Both arms are RED. That is not a new colour and not a new tier: `blocked` already means "needs
 *  you to unstick it", `StatusEngine` already paints a build row's quota wall with it
 *  (statusEngine.ts:1592-1594), and reusing it is what satisfies the founder's non-overridable rule
 *  that this row and the build rows resolve colours IDENTICALLY. */
export type HardStopKind = "quota" | "auth";

/**
 * Classify a headless-pass failure MESSAGE as a hard stop, or `null` when it is not one.
 *
 * `null` is NOT "healthy" — it means "no hard stop found here", and the caller still has a failed
 * pass to characterize. It should fall through to the transient/other arms, which are AMBER because
 * the hourly slot re-attempts them without the founder doing anything.
 *
 * Pure. Takes the message rather than reading it, so the seam is testable against the exact string
 * the Rust side pins.
 */
export function hardStopFailureKind(message: string): HardStopKind | null {
  const kind = conciergeFailureNotice(message).kind;
  if (kind === "auth") return "auth";
  // ⚠️ NOT EVERY "quota" IS A HARD STOP HERE (roborev 67788). The delegate's QUOTA pattern includes
  // `rate.?limit`, which matches the CLI's ordinary short-window 429 (`API Error: 429
  // rate_limit_error`). That is right on the concierge surface, where the machine's verbatim words
  // ride underneath and the reader can see which kind of wall it is. It is WRONG here, where the
  // return value decides a COLOUR: a short-window rate limit is cleared by the next hourly pass with
  // no founder action, so painting it red is exactly the false-red the amber `lapsed` tier was
  // created to stop — the founder pushed back on that six times in one day.
  //
  // So the quota arm additionally demands a DURABLE wall: an account/session/weekly/spend limit, a
  // spent balance, or an exceeded quota. A bare rate limit falls through to `null` and the caller
  // parks it on amber, which is the honest tier for "the machinery will retry this itself".
  if (kind === "quota" && DURABLE_WALL.test(message)) return "quota";
  // ⚠️ FALL THROUGH TO AUTH, NEVER STRAIGHT TO NULL (roborev 67814). `classify` returns on its FIRST
  // hit and tests QUOTA before AUTH, so a credential failure whose text merely mentions a rate limit
  // never reaches the auth arm at all — and returning null there would call an expired credential
  // self-clearing, which no retry ever makes true.
  return isAuthFailure(message) ? "auth" : null;
}

/** The wall phrasings that OUTLIVE a retry — as opposed to a short-window rate limit, which does not.
 *
 *  Each is a phrase this repo has already committed to elsewhere: the four `hit your … limit` nouns
 *  are `conciergeFailureNotice`'s own, and `usage limit reached` / `limit resets at` are the two
 *  `claude_oneshot.rs::is_account_limit` trusts as "a fragment of a real message, verified against
 *  captures". */
const DURABLE_WALL =
  /hit your (?:monthly spend|session|usage|weekly)\s+limit|reached your usage limit|usage limit reached|usage limit exceeded|limit resets at|credit balance is too low|insufficient_quota|quota exceeded/i;

// ⚠️ BARE `usage limit` IS DELIBERATELY NOT IN THAT LIST, though the delegate's QUOTA carries it.
// "API Error: Server is temporarily limiting requests (NOT YOUR USAGE LIMIT) · Rate limited" contains
// the bare phrase while saying in words that it is not one, and it classifies `quota` at the delegate
// on the strength of `rate.?limit`. Admitting the bare phrase here would paint that banner RED. The
// wall wordings above all carry a verb — reached / exceeded / resets — which that banner does not.
