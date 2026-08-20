// SHOULD THIS PLAN AUTO-APPROVE? — the decision, kept pure and kept away from the transport.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
// `[approvals].plan` auto-answers Claude Code's plan-exit dialog, and the founder's chosen option is
// "Yes, and auto-accept edits" — a SESSION-WIDE standing grant. That makes a second opinion the only
// thing standing between an unreviewed plan and unattended edits, so a build agent @mentions
// @improve, @improve posts OPEN PROBES as bead comments, and the plan proceeds when it posts an
// explicit "0 open probes — approved". This module answers the one question in that loop that must
// never be got wrong: given the record so far, may this plan proceed?
//
// ── IT IS PURE, AND THAT IS THE POINT ───────────────────────────────────────────────────────────
// No I/O, no clock, no store. `now` is a parameter. The transport it will run on — the @mention
// channel and its immediate scoped spawn — is being built separately and does not exist yet, so
// binding the decision to it would mean either waiting or guessing. The decision does not depend on
// how the record arrives, only on what it says, so it is testable and complete today.
//
// ── THE FOUR RULES, AND WHERE EACH CAME FROM ────────────────────────────────────────────────────
//  1. SILENCE IS NEVER CONSENT. Approval is an explicit verdict, never the absence of probes. The
//     doorbell transport has a VERIFIED silent-delivery failure — `fleet.inbox_send` returns
//     `{ok:true, messageId}` on a message that never arrives (observed 2026-08-14: an agent shipped
//     a PR missing six follow-ups and said verbatim it never received them) — so `ok:true` is not
//     evidence, an ACK comment is, and a missing ACK is UNDELIVERED rather than approved.
//  2. THE GATE MUST STAY SATISFIABLE. Reaching zero open probes has to be possible AND repeatable.
//     The knightwatch probe gate failed this five times (beads sparkle-xmwxu, sparkle-tzb4m,
//     sparkle-lsm0n, sparkle-9musi, sparkle-62eks, sparkle-0jpmw): answering every probe could make
//     a PR permanently unmergeable, because probe identity was an INDEX that renumbered each round,
//     so a new round invalidated the answers already given. Here identity is `(round, index)` and
//     answers are keyed on it, which makes the property structural rather than a rule to remember.
//     `planReviewGate.test.ts` opens with that case, before anything about safety.
//  3. A TIMEOUT SPLITS BY SURFACE. "Silence → escalate to the founder" would reinstate him as the
//     wire, which is the entire thing being removed; his rule is NOTIFY, DON'T BLOCK. So a SYSTEMIC
//     plan (ci.yml, release.yml, ci-gate.sh, runner scripts, the beads store, concierge core,
//     auth/credentials) escalates on silence — those are the expensive misses — and everything else
//     PROCEEDS WITHOUT REVIEW and says so on the record.
//  4. AN OVERRULED REVIEW STAYS READABLE. Every decision carries its own audit sentence, so
//     "proceeded anyway" can never render the same as "never read it" to a human reading the bead
//     weeks later. That is why `record` lives here and is not left to the caller to phrase.

/** Which risk tier a plan sits in. Drives ONLY the timeout behaviour — never whether a probe is
 *  posted (see {@link planNeedsProbe}, whose bias is to probe) and never whether silence approves
 *  (it never does, on either surface). */
export type PlanSurface = "systemic" | "ordinary";

/** One probe: a specific, answerable concern naming the file/risk and what would resolve it.
 *
 *  `id` IS THE SATISFIABILITY PROPERTY. It is `r<round>#<index>` — stable across later rounds — so
 *  an answer recorded in round 1 still refers to the same probe after round 3 arrives. The
 *  knightwatch gate keyed on the bare index, which renumbers every review, and that single choice
 *  is what made answering every probe capable of moving a PR further from mergeable. */
export interface Probe {
  id: string;
  text: string;
}

/** A round of probes as posted by the reviewer, in one bead comment. */
export interface ProbeRound {
  round: number;
  postedAt: number;
  probes: Probe[];
}

/** The review record for one plan, as read from the bead's comments.
 *
 *  THE BEAD IS THE MESSAGE. Every field here is derived from a durable, founder-visible comment —
 *  never from the inbox, which is only a doorbell. That is what keeps the visible record and the
 *  real conversation from diverging, and what makes "never reviewed" distinguishable from
 *  "reviewed and approved". */
export interface PlanReviewLedger {
  planId: string;
  surface: PlanSurface;
  /** When the build agent @mentioned the reviewer. The ACK deadline runs from here. */
  mentionedAt: number;
  /** When the reviewer posted its ACK comment, or null if it never has. NOT the doorbell's return
   *  value — see rule 1. The verdict deadline runs from here. */
  ackAt: number | null;
  rounds: ProbeRound[];
  /** Probe ids the plan agent has resolved, in any round, in any order. */
  answeredProbeIds: string[];
  /** When the plan agent last resolved a probe, or null if it never has.
   *
   *  PART OF THE SILENCE CLOCK, not bookkeeping. The moment the last probe is answered, the ball is
   *  back in the REVIEWER'S court — so that instant is when its next deadline starts running. Without
   *  it, a plan agent that took its time answering would burn the reviewer's budget and the gate
   *  would time out the party that was not the slow one. */
  lastAnswerAt: number | null;
  /** When the reviewer posted "0 open probes — approved", or null. A verdict is only good for the
   *  probe set that existed when it was given — see the `approvedAt` check in {@link judgePlanReview}. */
  approvedAt: number | null;
}

export type PlanReviewDecision =
  /** The reviewer blessed the current probe set. Press the plan dialog. */
  | "approved"
  /** Nothing to decide yet — a deadline is still running, or probes are outstanding. */
  | "wait"
  /** No review arrived in time on an ORDINARY surface. Proceed, and record that nobody reviewed it. */
  | "proceed-unreviewed"
  /** The founder has to look at this one. */
  | "escalate";

export type PlanReviewReason =
  | "approved"
  | "open-probes"
  | "awaiting-ack"
  | "awaiting-review"
  | "no-ack"
  | "review-timeout"
  | "round-cap-exceeded";

export interface PlanReviewVerdict {
  decision: PlanReviewDecision;
  reason: PlanReviewReason;
  /** Probe ids still outstanding, in round then index order. Empty unless `reason` is "open-probes". */
  openProbeIds: string[];
  /** The sentence that goes on the bead, and — for an approval — into the concierge-chat notice.
   *  Carried here rather than composed by the caller so that "proceeded anyway" and "never read it"
   *  cannot be rendered identically by two different call sites. */
  record: string;
}

/**
 * How long the reviewer has to ACKNOWLEDGE the mention.
 *
 * THIS IS THE SPAWN-START ACK, NOT A REVIEW BUDGET, and the split is deliberate. The original
 * design put ~60s on "acknowledge and have read the plan", which a cold on-demand spawn blows
 * routinely — and a deadline that is missed most of the time trains everyone to ignore the
 * escalation, which destroys the signal it exists to carry. So the reviewer acknowledges receipt
 * BEFORE it has read anything (genuinely seconds' work) and the verdict gets the long budget below.
 *
 * PROVISIONAL. Nobody has measured the real distribution yet; that is what the miss logging is for.
 * A constant rather than a literal so the replacement is one deliberate edit with a test in front
 * of it, not a silent tuning.
 */
export const WAKE_ACK_DEADLINE_MS = 90_000;

/**
 * How long the reviewer has to post its first probe set (or its approval) after acknowledging.
 *
 * Runs from the ACK, not from the mention, so a slow spawn does not eat the review budget. Also
 * provisional, for the same reason and replaceable by the same evidence.
 */
export const REVIEW_VERDICT_DEADLINE_MS = 600_000;

/** How many probe rounds may pass before the negotiation is declared stuck.
 *
 *  ANTI-LOOP, and it is the one rule that fires on BOTH surfaces: a reviewer and a plan agent
 *  trading rounds forever is a plan that never executes and never surfaces, which is the silent
 *  strand this whole module is written to avoid. */
export const MAX_PROBE_ROUNDS = 3;

/** Paths whose blast radius is the whole system rather than one feature.
 *
 *  Matched as substrings of a POSIX-ish path, because the same file is named a dozen ways across a
 *  plan's prose and its diff, and a pattern that only matches one spelling fails OPEN — which here
 *  means routing a systemic plan down the ordinary path and proceeding on silence. */
const SYSTEMIC_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//i, // ci.yml, release.yml, and every sibling
  /(^|\/)ci-gate\.sh$/i,
  /(^|\/)scripts\/runner\//i,
  /(^|\/)\.beads\//i, // the shared work-graph store: one DB, every worktree
  /(^|\/)concierge[^/]*\.(rs|ts|tsx)$/i,
  /(^|\/)conciergeTools\//i,
  // ── AUTH / CREDENTIALS: TWO ANCHORS, BECAUSE BOTH DIRECTIONS ARE UNSAFE ──────────────────────
  // Unanchored, this swept in 109 of 5241 tracked files — every `…Authority.ts`, `…authored…` doc
  // and `designTokens.ts` — which wastes the founder's attention until the escalation stops being
  // read (roborev 65823). But requiring a separator on BOTH sides was WORSE (roborev 65827): it
  // excluded camelCase, which is how most auth code here is actually spelled, so `authStore.ts`,
  // `credentialHealth.ts` and `devBypassAuth.ts` became ORDINARY — and an ordinary plan proceeds
  // unreviewed on reviewer silence. The over-match costs attention; the under-match hands unattended
  // edits to credential code, which is the direction this file's own header calls out as unsafe.
  //
  // So: anchor on a separator OR on a camelCase hump, and exclude the `author*` family explicitly by
  // what it IS rather than by demanding a trailing separator. The camel arms are deliberately
  // case-SENSITIVE — under `/i` an uppercase class matches lowercase too, and the hump is the whole
  // signal.
  /(^|[/\-_.(])(oauth|credentials?|secrets?|keychain)/i,
  /(^|[/\-_.(])auth(?!or(?:ed|ing|ity|ities|s)?(?:[/\-_.]|$|[A-Z]))/i,
  /[a-z0-9](Auth|OAuth|Credential|Secret|Keychain)(?!or)/,
  // Token stems are an ALLOW-LIST, never the bare word: `designTokens` and `cssTokens` are ordinary
  // UI code and were the bulk of the original over-match.
  // The stems are ENUMERATED so the list is reviewable and extendable by hand. `push` and the
  // bracketed `[token]` route segment are here on the SAFE side of a genuine judgement call: a
  // device push token and a support magic-link token are both credentials, even though neither
  // sits in an `auth/` directory. Extending this list is the intended way to fix a miss.
  /(^|[/\-_.])(desktop|github|access|refresh|auth|api|bearer|session|push)[-_]?tokens?/i,
  /\[token\]/i,
  /[a-z0-9](AuthToken|AccessToken|RefreshToken|DesktopToken|GithubToken|ApiToken|BearerToken|SessionToken)/,
];

/**
 * The risk tier of a plan, from the paths it says it will touch.
 *
 * ANY systemic path makes the WHOLE plan systemic. Risk is not diluted by the plan being mostly
 * harmless — a one-line `ci-gate.sh` edit inside a forty-file refactor is still the edit that can
 * take the fleet down, and it is the one a probe would have caught.
 */
export function classifyPlanSurface(paths: readonly string[]): PlanSurface {
  return paths.some((p) => SYSTEMIC_PATTERNS.some((re) => re.test(p))) ? "systemic" : "ordinary";
}

/** What a plan says about itself, for the probe-or-not decision. */
export interface PlanShape {
  paths: readonly string[];
  /** The plan agent's own "this is trivial". A HINT FROM THE PARTY WITH THE INCENTIVE TO SKIP
   *  REVIEW, so it is honoured only where the other two signals already agree. */
  agentMarkedTrivial: boolean;
  hasTests: boolean;
}

/** Above this many touched files, a plan is not "localised" whatever else it claims. */
const TRIVIAL_MAX_PATHS = 1;

/**
 * Does this plan warrant a probe at all?
 *
 * THE BIAS IS ONE-DIRECTIONAL AND DELIBERATE: when unsure, PROBE. The founder is token-insensitive
 * and a skipped probe on a systemic plan is the expensive miss — the measured examples are a
 * merge-queue DOA, a weakened `relayGate`, and a competing gate PR, all of which one probe would
 * have caught. So this returns false only for the three narrow exemptions that were actually agreed:
 * a single-file localised change carrying tests, or one the agent marked trivial — and NEITHER
 * exemption can override a systemic surface.
 */
export function planNeedsProbe(plan: PlanShape): boolean {
  if (classifyPlanSurface(plan.paths) === "systemic") return true;
  if (plan.paths.length > TRIVIAL_MAX_PATHS) return true;
  // A single ordinary file: exempt if it carries tests, or if the agent vouched for it. The
  // `hasTests` half is load-bearing — dropping it would make the exemption "any one-file change",
  // which is most changes, and would quietly disable the gate for the common case.
  return !(plan.hasTests || plan.agentMarkedTrivial);
}

/** Probe ids still outstanding, in round-then-index order — the order the reviewer raised them. */
function openProbes(led: PlanReviewLedger): string[] {
  const answered = new Set(led.answeredProbeIds);
  return led.rounds.flatMap((r) => r.probes.filter((p) => !answered.has(p.id)).map((p) => p.id));
}

/** The reviewer's newest word, whenever that was. */
function latestRoundAt(led: PlanReviewLedger): number {
  return led.rounds.reduce((max, r) => Math.max(max, r.postedAt), 0);
}

/**
 * The instant the review last MOVED — the point the silence clock runs from.
 *
 * THE DEADLINE MEASURES SILENCE, NOT ELAPSED TIME, and the distinction is the whole of roborev
 * 65823's High finding. Anchored to `ackAt` alone the budget never advanced, yet it was the
 * fall-through for every post-ACK state — so a review that was progressing perfectly well died at
 * `ackAt + 10 min`: on an ordinary surface that auto-approved unattended edits while the reviewer
 * was mid-sentence, and on a systemic one it escalated a conversation nobody had abandoned. It also
 * made rounds 2 and 3 practically unreachable, quietly contradicting `MAX_PROBE_ROUNDS` and the
 * satisfiability property this module is built around.
 *
 * Three events count as movement, and each is genuinely the reviewer's turn beginning: it
 * acknowledged, it posted a round, or the plan agent finished answering and handed the ball back.
 */
function reviewLastMovedAt(led: PlanReviewLedger): number {
  return Math.max(led.ackAt ?? 0, latestRoundAt(led), led.lastAnswerAt ?? 0);
}

function verdict(
  decision: PlanReviewDecision,
  reason: PlanReviewReason,
  record: string,
  openProbeIds: string[] = [],
): PlanReviewVerdict {
  return { decision, reason, record, openProbeIds };
}

/**
 * May this plan proceed, given the record so far?
 *
 * ORDER OF THE CHECKS IS LOAD-BEARING and reads worst-first:
 *   1. The round cap, because a stuck negotiation is stuck whatever else is true of it.
 *   2. The ACK, because without it we have no evidence the reviewer ever heard us — and an
 *      un-acknowledged plan must never reach the approval arm however clean the board looks.
 *   3. Open probes, because an objection outranks a deadline: a reviewer that RAISED a concern has
 *      not gone silent, so the timeout rule below must not fire and quietly proceed past it. Getting
 *      this pair the wrong way round is the one ordering mistake that would let the gate wave
 *      through exactly what it exists to catch.
 *   4. The explicit verdict, checked against the CURRENT probe set — a blessing given before a later
 *      round cannot approve that round, or approval would be a sticky boolean that silently
 *      overrides a newer objection.
 *   5. The review deadline, split by surface.
 */
export function judgePlanReview(led: PlanReviewLedger, now: number): PlanReviewVerdict {
  const open = openProbes(led);

  // A CONVERGED REVIEW IS NOT A STUCK ONE (roborev 65823). This check used to run unconditionally,
  // ahead of the approval arm, so a ledger past the cap escalated even when every probe was answered
  // and the reviewer had explicitly blessed it — this module's own opening failure, an unsatisfiable
  // gate, with the strand merely made loud instead of silent. The cap exists to end a negotiation
  // going nowhere; one that has ENDED is not going nowhere.
  const converged = open.length === 0 && led.approvedAt !== null && led.approvedAt >= latestRoundAt(led);
  if (led.rounds.length > MAX_PROBE_ROUNDS && !converged) {
    return verdict(
      "escalate",
      "round-cap-exceeded",
      `@improve and the plan agent exchanged ${led.rounds.length} probe rounds on "${led.planId}" ` +
        `without converging (cap ${MAX_PROBE_ROUNDS}). Escalating rather than looping.`,
      open,
    );
  }

  if (led.ackAt === null) {
    if (now - led.mentionedAt <= WAKE_ACK_DEADLINE_MS) {
      return verdict("wait", "awaiting-ack", `Waiting for @improve to acknowledge "${led.planId}".`);
    }
    // NOT "the reviewer declined" — we do not know that it ever heard us. The doorbell's own
    // success return is not evidence (see rule 1), so this is an UNDELIVERED mention. It is a
    // delivery failure on a plan we cannot vouch for, so it takes the escalating path on a systemic
    // surface and the recorded-proceed path otherwise, exactly like a review timeout.
    return led.surface === "systemic"
      ? verdict(
          "escalate",
          "no-ack",
          `@improve never acknowledged the plan-review request for "${led.planId}" within ` +
            `${Math.round(WAKE_ACK_DEADLINE_MS / 1000)}s — treating as UNDELIVERED, not as approval. ` +
            `Systemic surface, so this needs a human.`,
        )
      : verdict(
          "proceed-unreviewed",
          "no-ack",
          `Auto-approved without @improve review: the review request for "${led.planId}" was never ` +
            `acknowledged and timed out after ${Math.round(WAKE_ACK_DEADLINE_MS / 1000)}s ` +
            `(treated as undelivered, never as approval).`,
        );
  }

  if (open.length > 0) {
    return verdict(
      "wait",
      "open-probes",
      `"${led.planId}" has ${open.length} open probe(s) from @improve; auto-approval is blocked ` +
        `until each is resolved.`,
      open,
    );
  }

  // Every probe answered — necessary, but NOT sufficient. Approval is an affirmative verdict, and it
  // must be NEWER than the newest round it claims to bless.
  if (led.approvedAt !== null && led.approvedAt >= latestRoundAt(led)) {
    const resolved = led.rounds.reduce((n, r) => n + r.probes.length, 0);
    return verdict(
      "approved",
      "approved",
      `@improve reviewed the plan for "${led.planId}" — 0 open probes, ${resolved} probes resolved ` +
        `— now executing.`,
    );
  }

  // Measured from the last time the review MOVED — see `reviewLastMovedAt`. Reaching here means
  // there are no open probes, so what we are waiting on is the reviewer's next word, and the clock
  // starts when it last had the ball rather than when the conversation began.
  if (now - reviewLastMovedAt(led) <= REVIEW_VERDICT_DEADLINE_MS) {
    return verdict("wait", "awaiting-review", `Waiting for @improve's verdict on "${led.planId}".`);
  }

  const mins = Math.round(REVIEW_VERDICT_DEADLINE_MS / 60_000);
  return led.surface === "systemic"
    ? verdict(
        "escalate",
        "review-timeout",
        `@improve acknowledged the plan review for "${led.planId}" but posted no verdict within ` +
          `${mins} min. Systemic surface, so this is not proceeding without a human.`,
      )
    : verdict(
        "proceed-unreviewed",
        "review-timeout",
        `Auto-approved without @improve review: the reviewer timed out at ${mins} min on ` +
          `"${led.planId}". Proceeding and recording that nobody reviewed it.`,
      );
}
