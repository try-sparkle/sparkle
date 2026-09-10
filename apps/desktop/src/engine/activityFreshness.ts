// activityFreshness — read a self-reported activity line as a TIMESTAMPED QUOTE, never as proof of life.
//
// THE BUG THIS EXISTS FOR (bead sparkle-s8y5t6). `AgentTab.activity` is what the agent SAID it was
// doing, written by the agent itself through the sparkle-control `set_agent_activity` MCP op. Before
// this module the string carried no age, so every surface rendered it as the present tense: an agent
// that narrated "blocked on the outage" and then DIED left that line looking live for hours, and the
// watcher read a dead agent as "explained". A self-report is evidence of what was true WHEN IT WAS
// WRITTEN and nothing more — liveness has to come from real tool activity (PostToolUse recency), not
// from the prose. `activityAt` (stamped by setAgentActivity) is what lets every consumer say so.
//
// PURE. Data in, data out — no store, no clock of its own, no React — so the whole policy unit-tests
// as arithmetic and there is exactly one copy of "is this quote too old to trust".

/** How old a self-report may be before it must be treated as STALE — i.e. no longer a statement about
 *  what the agent is doing NOW. Deliberately short: a self-report is written at phase boundaries, so a
 *  line older than a couple of minutes is describing a phase the agent has likely left. Distinct from
 *  useAttentionNotifications' ACTIVITY_FRESH_MS (the notification-body gate) so the two can move
 *  independently; both happen to sit at two minutes today, and that is a coincidence, not a coupling. */
export const ACTIVITY_STALE_MS = 120_000;

/**
 * Age of the current activity line in ms, or `null` when it cannot be known.
 *
 * `null` for a missing stamp (a legacy record, or one restored from a previous session's persisted
 * state — its age is genuinely unknown) and for a stamp in the FUTURE (a clock skew we refuse to
 * report as a negative age). Callers must treat `null` as "unknown age", which {@link isActivityStale}
 * folds to STALE — the conservative direction, because the whole point is never to over-trust a
 * self-report.
 */
export function activityAgeMs(activityAt: number | undefined, now: number): number | null {
  if (activityAt === undefined) return null;
  const age = now - activityAt;
  return age < 0 ? null : age;
}

/**
 * Is this self-report too old (or too unknown) to read as CURRENT state?
 *
 * A missing/unknown stamp is stale, NOT fresh — an unstamped line is exactly the hours-old
 * "blocked on the outage" survivor this module exists to distrust, so the fail direction is stale.
 * `staleMs` defaults to {@link ACTIVITY_STALE_MS}.
 */
export function isActivityStale(
  activityAt: number | undefined,
  now: number,
  staleMs: number = ACTIVITY_STALE_MS,
): boolean {
  const age = activityAgeMs(activityAt, now);
  if (age === null) return true;
  return age > staleMs;
}

/**
 * A short human age suffix for rendering the line as a quote — `"just now"`, `"3m ago"`, `"2h ago"`,
 * `"5d ago"` — or `null` when the age is unknown (missing/future stamp), in which case the caller
 * should render the line as an unattributed quote rather than assert a false age.
 *
 * Under ten seconds reads "just now"; otherwise the largest whole unit (s/m/h/d). Kept coarse on
 * purpose: this annotates a muted secondary line, and a precise "127s ago" is noise there.
 */
export function formatActivityAge(activityAt: number | undefined, now: number): string | null {
  const age = activityAgeMs(activityAt, now);
  if (age === null) return null;
  if (age < 10_000) return "just now";
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** How an activity line should be RENDERED, given its text, its age and who wrote it. */
export interface ActivityPresentation {
  /** The visible line. */
  label: string;
  /** The `title` tooltip — always states provenance in full, whatever the line reads as. */
  title: string;
  /** Whether to render as a past quote (italic, dimmed). */
  stale: boolean;
}

/**
 * Present an activity line honestly, including WHO WROTE IT.
 *
 * PROVENANCE IS NOT COSMETIC HERE, because the two sources have different failure modes and a
 * reader has to know which one they are looking at:
 *
 *   • `"self"` — the agent called `set_agent_activity` itself, at a phase boundary it chose. Its
 *     characteristic failure is ABANDONMENT: accurate when written, then left behind for hours
 *     while the agent works on something else. A stale one means the agent stopped narrating.
 *   • `"narrated"` — Sparkle generated it from the agent's own last turn at a Stop boundary
 *     (services/activityNarrator, bead ). It cannot be abandoned, because a Stop fires
 *     whether or not the agent thought about it. A stale one therefore means something ELSE and
 *     genuinely useful: no turn has ENDED recently, i.e. the agent has been inside one long turn.
 *
 * So a stale self-report and a stale narration must not read the same. `said "…"` is right for the
 * first and actively wrong for the second — nobody said it; Sparkle summarized it. Note what the
 * narrated wording deliberately does NOT claim: "as of Nm ago" states when the line was derived and
 * stops there. It would be easy to write "working for Nm", and that would be an assertion of
 * LIVENESS this module cannot support — the agent may equally have died mid-turn. Liveness comes
 * from real tool activity, never from this prose.
 */
export function presentActivity(
  activity: string,
  activityAt: number | undefined,
  source: "self" | "narrated" | undefined,
  now: number,
): ActivityPresentation {
  const stale = isActivityStale(activityAt, now);
  const age = formatActivityAge(activityAt, now);
  // Undefined source reads as "self": every line written before provenance existed was one.
  const narrated = source === "narrated";

  const provenance = narrated
    ? "Summarized by Sparkle from this agent's last turn"
    : "Self-reported by the agent";
  const title = `${provenance}${age ? ` ${age}` : " (age unknown)"}: ${activity}`;

  if (!stale) return { label: activity, title, stale };

  const suffix = age ?? "age unknown";
  const label = narrated ? `as of ${suffix}: ${activity}` : `said “${activity}” · ${suffix}`;
  return { label, title, stale };
}
