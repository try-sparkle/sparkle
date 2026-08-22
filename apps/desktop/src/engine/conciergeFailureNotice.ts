// WHY A FAILED CONCIERGE TURN FAILED — said in the user's own terms, with the machine's own words
// attached.
//
// THE BUG THIS CLOSES. `concierge.rs::emit_outcome` builds the most specific reason it can find
// (claude's own error text, then stderr, then a synthesized exit-status phrase) and ships it to the
// frontend as `concierge:error { id, detail }`. The host then threw `detail` away and printed one
// fixed sentence — "I couldn't reach my brain just now" — for every failure there has ever been.
//
// On 2026-07-29 every single one of the 15 failures was quota exhaustion, and the detail the host
// discarded looked like this, verbatim:
//
//     You've hit your session limit · resets 8:40am (America/Bogota)
//     You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message
//
// A reset time and a settings URL are ACTIONABLE. "Try me again in a moment" is not merely less
// useful than those, it is wrong: retrying does not clear a spend limit, and the user who follows
// that advice burns an hour discovering it. The human spent that day assuming a 529 overload.
//
// THE RULE THIS MODULE ENFORCES: `evidence` is emitted for EVERY kind, including `unknown`. The
// headline is our phrasing and may be wrong about the cause; the evidence is the machine's phrasing
// and cannot be. A classifier that only spoke for the failures it recognised would re-create the
// exact swallow it exists to fix, one unrecognised failure at a time.
//
// Pure and React-free, so the wording is pinned by unit tests rather than asserted through a
// rendered tree — the same posture Concierge/RoutingReceipt takes for the same reason.

/** The coarse cause, inferred from the detail text. Deliberately small: the headline only needs to
 *  say roughly why and what to do about it, because the verbatim {@link ConciergeFailureNotice.evidence}
 *  is right underneath it. */
export type ConciergeFailureKind = "quota" | "auth" | "unknown";

/**
 * How much of the detail to show.
 *
 * A cap exists because `detail` can be raw stderr, and an unbounded dump would push the compose box
 * off a 360px column. 600 is far above every failure text observed in a day of logs (the longest is
 * 103 characters) while still bounding a pathological stderr. The matched line is hoisted to the
 * front before capping, so the sentence the classifier recognised can never be the part that gets
 * cut — which is the failure mode a naive `slice(0, N)` would have.
 */
export const FAILURE_EVIDENCE_MAX = 600;

/** The line the host has always shown. Kept WORD FOR WORD as the unknown-kind headline: it is the
 *  honest thing to say when we genuinely cannot tell, and several suites identify the error bubble
 *  by it. What changes for `unknown` is not this sentence — it is that the evidence now rides along
 *  underneath it. */
export const UNKNOWN_FAILURE_HEADLINE =
  "I couldn't reach my brain just now — try me again in a moment.";

/** NOT "try again". A spend or session limit is a fact about the user's Claude account with a clock
 *  on it; retrying is the one thing guaranteed not to help, and the reset time in the evidence below
 *  is the actual answer to "when can I?". */
export const QUOTA_FAILURE_HEADLINE =
  "Your Claude plan is out of room — retrying won't clear it. This is a limit on your Claude account, not something Sparkle can route around:";

/** The remedy has to be safe under the same condition that produced the failure (AGENTS.md: a
 *  remedy string is an instruction the user will follow). Re-authenticating is, because it renews
 *  the same credential the concierge's own `claude -p` child reads.
 *
 *  NOT "run `claude` in a terminal" any more. Two things were wrong with that. It sent a desktop
 *  user to a terminal Sparkle exists to spare them, and — the reason it had to change — `claude`
 *  with no subcommand drops you at a REPL, so the user still had to know to type `/login`. The app
 *  now renders a Sign in button next to this sentence (`ConciergeHost`), which runs the real
 *  `claude auth login` in place. The copy must keep naming the in-app action, not a shell command:
 *  if the button is ever removed, this string has to change with it. */
export const AUTH_FAILURE_HEADLINE =
  "Your Claude sign-in has expired, so I can't reach my brain. Retrying won't help — sign in again and I'll pick up where we left off:";

const HEADLINES: Record<ConciergeFailureKind, string> = {
  quota: QUOTA_FAILURE_HEADLINE,
  auth: AUTH_FAILURE_HEADLINE,
  unknown: UNKNOWN_FAILURE_HEADLINE,
};

/**
 * The same three facts, worded for the MOUNTED notice row (bead sparkle-voudj7, roborev 64296).
 *
 * ══ WHY THE BUBBLE'S HEADLINE CANNOT BE REUSED THERE ══════════════════════════════════════════
 * Those strings are written for the `failure` bubble in `ConciergeThread`, and two of them depend on
 * things only that bubble has:
 *
 *   • `auth` says "sign in again", and its own doc block above states the contract — the app renders
 *     a Sign in button NEXT TO this sentence, and "if the button is ever removed, this string has to
 *     change with it". That button is the bubble's `canReauth`, and a mounted column does not render
 *     the thread at all. Shown verbatim on the notice row it tells the reader to sign in with no
 *     control anywhere on screen: the unfollowable remedy this bead exists to remove.
 *   • `auth` and `quota` both END IN A COLON introducing the evidence block underneath them. The
 *     notice row carries no evidence, so the mirrored line dangles mid-sentence.
 *
 * So the mounted variants are whole sentences that name an action reachable FROM A MOUNTED COLUMN —
 * unmounting, which is what puts the bubble and its button back on screen.
 */
const MOUNTED_HEADLINES: Record<ConciergeFailureKind, string> = {
  quota:
    "Your Claude plan is out of room — retrying won't clear it. Unmount to read when it resets.",
  auth: "Your Claude sign-in has expired — unmount to sign in again and I'll pick up where we left off.",
  // ══ `unknown` NEEDS THE ROUTE MOST, NOT LEAST (roborev 64319) ═══════════════════════════════
  // A first cut copied the bubble's retry line verbatim here, which broke both rules this block
  // declares — it named no mounted-reachable action, and it was a duplicate literal free to drift
  // from `UNKNOWN_FAILURE_HEADLINE`.
  //
  // And `unknown` is the WORST kind to leave without a route. This module's header records that the
  // machine's verbatim words ride along for every kind *including* this one, precisely because the
  // classifier is lossy — and that evidence lives only in the `failure` bubble a mounted column does
  // not render. `unknown` is the bucket that already swallowed "OAuth session expired and could not
  // be refreshed", i.e. a case where retrying is exactly what cannot work. Pure retry advice with no
  // mention that the real error text is one Esc away reproduces that failure on this surface.
  unknown: "I couldn't reach my brain just now — unmount to read what it said.",
};

/** The mounted-surface sentence for a failure of this kind. See {@link MOUNTED_HEADLINES}. */
export function mountedFailureHeadline(kind: ConciergeFailureKind): string {
  return MOUNTED_HEADLINES[kind];
}

/** The BUBBLE sentence for a failure of this kind — the `HEADLINES` map above, read by kind.
 *
 *  EXPORTED FOR THE TEST THAT ASSERTS THE TWO MAPS DIFFER (roborev 64334). That suite had grown a
 *  hand-maintained second copy of `HEADLINES`, which the total-`Record` type forces to have an ENTRY
 *  but not a CORRECT one — so a fourth kind mapped to `""` or to a copy of another kind's string
 *  would make `mounted !== bubble` pass vacuously for exactly the kind the guard exists to cover.
 *  That is the same entry-versus-contract distinction `MOUNTED_HEADLINES` is commented for. One map,
 *  read through here, so the comparison is against the string the bubble actually renders. */
export function bubbleFailureHeadline(kind: ConciergeFailureKind): string {
  return HEADLINES[kind];
}

/** Every quota phrasing observed in the logs, plus the neighbouring ones the same API emits.
 *  Checked BEFORE {@link AUTH}: a 429 can mention authorization, and a rate limit is a quota fact,
 *  not a credential one. */
const QUOTA =
  /hit your (?:monthly spend|session|usage|weekly)\s+limit|rate.?limit|quota exceeded|usage limit|credit balance is too low|insufficient_quota/i;

/**
 * Credential failures. `please run claude` is the CLI's own onboarding line.
 *
 * THE MISS THIS WIDENS — a one-word gap that cost the founder an onboarding. The pattern used to
 * read `oauth token (?:expired|invalid)`. What the CLI actually emitted on his second machine was:
 *
 *     Failed to authenticate: OAuth session expired and could not be refreshed
 *
 * "session", not "token". So the most unambiguous auth failure the CLI can produce fell through to
 * `unknown` and was answered with "I couldn't reach my brain just now — try me again in a moment."
 * He retried, because that is what it told him to do, and no number of retries could have worked.
 *
 * Widened accordingly, and deliberately past the one string that bit us — `oauth (?:token|session)`
 * covers both nouns, `failed to authenticate` and `could not be refreshed` each catch that sentence
 * independently, and `refresh token` covers the neighbouring phrasing. Over-matching here is cheap:
 * a quota failure is classified BEFORE this (a 429 mentioning authorization is a quota fact), and a
 * misfiled auth headline still ships the machine's verbatim words underneath it. Under-matching is
 * what produced the bug.
 */
const AUTH =
  /not logged in|invalid api key|unauthori[sz]ed|authentication (?:failed|error|required)|failed to authenticate|please run `?claude`?|oauth (?:token|session) (?:expired|invalid)|could not be refreshed|refresh token (?:expired|invalid)|invalid_api_key/i;

/** What we tell the user, and what the machine actually said. */
export interface ConciergeFailureNotice {
  kind: ConciergeFailureKind;
  /** Our sentence. Names the cause and, when there is one, the remedy. */
  headline: string;
  /** The Rust `detail`, VERBATIM — whitespace-trimmed, blank lines dropped, capped, and never
   *  reworded. `resets 8:40am (America/Bogota)` has to survive this byte for byte, because the
   *  reset time is the single most useful thing the app knows and we cannot re-derive it. Empty
   *  only when the detail itself was empty. */
  evidence: string;
}

/** Is this a CREDENTIAL failure? Exported so a caller that rejects the quota arm can still reach the
 *  auth one — `classify` returns on the FIRST hit, so a message carrying any quota token can never
 *  fall through to AUTH on its own (roborev 67814). Reuses the pattern rather than restating it: its
 *  "session" vs "token" scar is exactly what a second copy would lose. */
export function isAuthFailure(detail: string): boolean {
  return AUTH.test(detail);
}

function classify(detail: string): ConciergeFailureKind {
  if (QUOTA.test(detail)) return "quota";
  if (AUTH.test(detail)) return "auth";
  return "unknown";
}

/** Move the line the classifier matched to the front, preserving the order of everything else.
 *  Hoisting rather than filtering: the rest of a multi-line stderr is still evidence, it just isn't
 *  the headline-worthy part, and dropping it would be a second swallow. */
function hoistMatch(lines: string[], matcher: RegExp | null): string[] {
  if (!matcher) return lines;
  const i = lines.findIndex((l) => matcher.test(l));
  if (i <= 0) return lines;
  return [lines[i]!, ...lines.slice(0, i), ...lines.slice(i + 1)];
}

function cap(s: string): string {
  if (s.length <= FAILURE_EVIDENCE_MAX) return s;
  // The ellipsis is OUTSIDE the budget's last character so the result is never longer than the cap.
  return `${s.slice(0, FAILURE_EVIDENCE_MAX - 1).trimEnd()}…`;
}

/**
 * Turn a raw `concierge:error` detail into something a human can act on.
 *
 * TOTAL: every input produces a notice, and every notice carries its evidence. There is no branch
 * that returns only a headline — see the module header for why that is the whole point.
 */
export function conciergeFailureNotice(detail: string): ConciergeFailureNotice {
  const trimmed = detail.trim();
  const kind = classify(trimmed);
  const matcher = kind === "quota" ? QUOTA : kind === "auth" ? AUTH : null;
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { kind, headline: HEADLINES[kind], evidence: cap(hoistMatch(lines, matcher).join("\n")) };
}
