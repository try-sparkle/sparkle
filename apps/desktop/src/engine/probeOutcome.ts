// probeOutcome (sparkle-gazo4a) — "we could not look" is a THIRD outcome, and it may never be
// rendered as "it is not there".
//
// ══ THE BUG THIS MODULE EXISTS TO KILL ══════════════════════════════════════════════════════════
// A probe looks for something. The look FAILS — errors, times out, lacks credentials, or comes back
// empty from a query nobody proved was working — and the empty result is published as PROOF OF
// ABSENCE rather than as a FAILED OBSERVATION. Six measured instances are recorded in
// `apps/desktop/shared/false-absence-corpus.json`, which is this module's canonical contract and is
// read from disk by `probeOutcome.falseAbsence.test.ts`. Read that file before changing anything
// here; it carries the evidence and this header carries only the rule.
//
// ══ WHY A TYPE ALONE WAS NOT ENOUGH, AND THIS IS THE WHOLE POINT ════════════════════════════════
// `HealthState::Unknown` has existed in `pipeline_health.rs` since long before any of these
// instances, with a header explaining it, a severity rank below Warning, and unit tests. FOUR of the
// six happened anyway. The reason is that the type governs THE FOLD — which colour the chip paints —
// while what a human actually reads and acts on is the DETAIL SENTENCE attached to it, and nothing
// governed that at all. A reading correctly typed `Unknown` still said "the review daemon is not
// running", and a human restarted a healthy daemon on the strength of it.
//
// So this module governs the SENTENCE. {@link ABSENCE_CLAIM_PATTERNS} is the vocabulary of an
// absence claim, and {@link renderProbeClaim} refuses to emit one for a `could-not-look`.
//
// ══ PURE ═══════════════════════════════════════════════════════════════════════════════════════
// No clock, no network, no store. Every input arrives as a parameter, so each rule below is tested
// as data rather than by standing up a probe.

/**
 * PROOF THAT AN EMPTY RESULT MEANS ANYTHING — the control.
 *
 * An empty result is evidence of absence only once you have shown the query CAN return a non-empty
 * one and that it covered the ground the claim covers. The concierge established that
 * `sparkle-reviewer` genuinely posts nothing by running `gh repo view` ALONGSIDE the empty result,
 * proving `gh` was authenticated and the repo reachable. That finding is reliable BECAUSE of the
 * control; the instances in the corpus are wrong because nobody ran one.
 *
 * BOTH HALVES ARE REQUIRED, and they fail in different directions:
 *
 *   • `reachable: false` — the door was shut. The read errored, timed out, 401'd, or failed to
 *     parse. Empty here means nothing whatsoever.
 *   • `complete: false` — the door was open onto PART OF THE ROOM. A paginated, windowed, capped or
 *     scope-limited read PROVES PRESENCE BUT CAN NEVER PROVE ABSENCE: not seeing the thing settles
 *     nothing, because it may live on a page nobody fetched. This is the same bit
 *     `scripts/lib/pipeline-health.sh`'s `ph_read_pool` returns as its third field, and its comment
 *     names the measured victim — an hourly scan filing a P1 "release runner blocking" bead against
 *     a live fleet of 61 registrations read through a ~26-entry ceiling.
 *
 * `complete` is the half that gets forgotten, because a successful HTTP 200 feels like an answer.
 * Four of the six corpus instances are `complete: false`, not `reachable: false`.
 */
export interface ProbeControl {
  /** Did the query mechanism work at all — authenticated, answered, parsed? */
  reachable: boolean;
  /** Did the read cover the whole population the claim is about? See the note above; a truncated
   *  read proves presence and never absence. */
  complete: boolean;
  /** What was actually demonstrated, in the prober's own words. Shown to a human, never parsed —
   *  this is the sentence that lets a reader judge the control rather than trust it. */
  evidence: string;
}

/**
 * What one probe answered. THREE outcomes, never two.
 *
 * `not-found` carries its control so the claim travels with its warrant: a reader (or a reviewer, or
 * the next agent) can see WHY the emptiness was trusted, rather than having to take it on faith. It
 * is not constructible without one — see {@link resolveProbe}, which is the only sanctioned way to
 * reach this state from a raw read.
 */
export type ProbeOutcome<T> =
  | { kind: "found"; value: T }
  | { kind: "not-found"; control: ProbeControl }
  | { kind: "could-not-look"; why: string; control: ProbeControl | null };

/**
 * Turn a raw read into an outcome. THE ONE PLACE the empty-vs-unreadable decision is made.
 *
 * `value` is what the read produced: a non-null value is FOUND and ends it. A null/absent value is
 * the interesting case, and it is `could-not-look` UNLESS the control proves BOTH halves. That
 * default is the entire fix: today's code paths reach "not found" by falling through, so a forgotten
 * control silently produces the confident wrong answer. Here a forgotten control produces the honest
 * one, and a caller that genuinely can prove absence has to say so explicitly.
 *
 * Note the asymmetry with the rest of this repo's guards, and it is deliberate: most fail CLOSED
 * toward the alarming answer. This one fails toward "I do not know", because the harm here is a
 * CONFIDENT WRONG STATEMENT, and an honest "could not tell" is strictly better than either wrong
 * answer.
 */
export function resolveProbe<T>(read: {
  value: T | null | undefined;
  control: ProbeControl | null;
  /** Why the look failed, when it did. Ignored for a `found`. */
  why?: string;
}): ProbeOutcome<T> {
  const { value, control } = read;
  if (value !== null && value !== undefined) return { kind: "found", value };
  if (control === null) {
    return { kind: "could-not-look", why: read.why ?? "no control was established for this read", control: null };
  }
  if (!control.reachable) {
    return {
      kind: "could-not-look",
      why: read.why ?? `the read did not complete: ${control.evidence}`,
      control,
    };
  }
  if (!control.complete) {
    return {
      kind: "could-not-look",
      why:
        read.why ??
        `the read covered only part of what this claim is about, so an empty result cannot settle ` +
          `it: ${control.evidence}`,
      control,
    };
  }
  return { kind: "not-found", control };
}

/** Convenience for a read that DID complete over the whole population — the control a caller
 *  constructs when it has genuinely proven both halves. Named rather than inlined so the assertion
 *  is greppable: every call site is a place someone claimed absence is provable. */
export function provenControl(evidence: string): ProbeControl {
  return { reachable: true, complete: true, evidence };
}

/** The control for a read that failed outright. */
export function unreachableControl(evidence: string): ProbeControl {
  return { reachable: false, complete: false, evidence };
}

/** The control for a read that succeeded but saw only part of the population — the forgotten half. */
export function truncatedControl(evidence: string): ProbeControl {
  return { reachable: true, complete: false, evidence };
}

/**
 * The control for a CACHED reading — a snapshot taken at some past moment and being used to answer
 * a question about NOW.
 *
 * ══ THE THIRD WAY A CONTROL FAILS, AND IT LOOKS EXACTLY LIKE SUCCESS ════════════════════════════
 * {@link unreachableControl} covers "the door was shut" and {@link truncatedControl} covers "the
 * door was open onto part of the room". This covers the case where the door was wide open, the
 * whole room was read, and the read happened SO LONG AGO that the room has since been rearranged.
 * There is no error, no empty array and no truncation flag — the caller holds a complete, correctly
 * parsed, entirely obsolete answer, and every existing freshness-blind guard reads it as current.
 *
 * ══ THE MEASURED INSTANCE (bead `sparkle-rk0k8o`) ═══════════════════════════════════════════════
 * `services/epicSweepRunner` read the beads snapshot straight off `useBeadsStore` with no freshness
 * question asked. `beadsStore.refresh` KEEPS the previous snapshot when `bd` fails — it writes
 * `error[projectId]` and leaves `byProject[projectId]` alone, which is right for a board that must
 * not blank out mid-poll and catastrophic for a sweep that spends agent slots. With the store
 * failing to list, the sweep held one frozen snapshot for 2h20m and restarted the same epic FOURTEEN
 * times at a 601-second cadence, because every label-derived fact it read was absent from that
 * snapshot: the founder's `no-auto-restart` veto (added mid-run and never seen), the
 * `sweep-restarted:` budget marker the sweep had itself written fourteen times, and the `stalled`
 * mark that would have ended the loop. Its own audit note carries the fingerprint — "no child bead
 * has moved in 16h", then 17h, 18h, 19h on successive ticks, because `now` advanced while
 * `lastChildProgressAt` could not.
 *
 * Absence of evidence rendered as evidence of absence, one more time, from a read that succeeded.
 *
 * ══ WHY `complete: false` AND NOT `reachable: false` ════════════════════════════════════════════
 * Both would refuse, so the distinction is about the SENTENCE a reader gets, which is the half this
 * module exists to govern. `reachable: false` says the mechanism is broken and sends someone to fix
 * `bd`; the mechanism may be perfect and simply not have been asked recently. `complete: false` is
 * the honest shape — the read covered a population (the store as it stood at `readAt`) that is not
 * the population the claim is about (the store as it stands now), which is the same "scope-limited
 * read proves presence and never absence" the truncated arm already names.
 *
 * `readAt` is `undefined` when nothing has ever been read, and that is `reachable: false`: there is
 * no stale answer, there is no answer. Callers pass a COMPLETION-independent clock —
 * `beadsStore.beadsReadStartedAt`, never `beadsPolledAt` — because a read already in flight when a
 * write landed commits AFTER that write while its contents predate it.
 */
export function freshnessControl(
  readAt: number | undefined | null,
  now: number,
  maxAgeMs: number,
  what: string,
): ProbeControl {
  if (readAt === undefined || readAt === null) {
    return unreachableControl(`${what} has never been read in this window`);
  }
  const ageMs = now - readAt;
  if (ageMs > maxAgeMs) {
    return truncatedControl(
      `${what} was last read ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(
        maxAgeMs / 1000,
      )}s freshness bound — it describes an earlier state, so an empty result cannot settle a ` +
        `question about the current one`,
    );
  }
  return provenControl(`${what} was read ${Math.round(ageMs / 1000)}s ago, inside the ${Math.round(
    maxAgeMs / 1000,
  )}s freshness bound`);
}

// ── The absence-claim lexicon ─────────────────────────────────────────────────────────────────────

/**
 * The vocabulary of an ABSENCE CLAIM.
 *
 * A HAND-WRITTEN COPY of `absenceClaims.patterns` in
 * `apps/desktop/shared/false-absence-corpus.json`, pinned byte-for-byte against it by
 * `probeOutcome.falseAbsence.test.ts` — the same anti-drift device `merge-protected-repos.json`
 * uses, and for the same reason: the Rust half in `pipeline_health.rs` needs the identical list, and
 * two hand-written copies that are not pinned to one file drift on the first edit.
 *
 * ⚠️ THESE ARE NOT BANNED WORDS. They are checked ONLY against text generated for a
 * `could-not-look` outcome. A genuine `not-found` is SUPPOSED to say "it is not there" — that is the
 * whole reason the third outcome exists separately rather than being folded into absence. Applying
 * this lexicon to every string in the app would be a different, much worse feature.
 *
 * Kept as source strings rather than literals so the pin can compare them to the JSON without
 * unpicking `RegExp.prototype.source` quirks, and compiled once at module load.
 */
export const ABSENCE_CLAIM_PATTERNS: readonly { id: string; re: RegExp }[] = [
  { id: "does-not-exist", re: /\b(does not|doesn't|do not|don't) exist\b/i },
  { id: "there-is-no", re: /\bthere (is|are|was|were) no\b/i },
  { id: "not-even", re: /\bnot even a\b/i },
  { id: "none-at-all", re: /\b(no|none|nothing)\b[^.!?]{0,60}\bat all\b/i },
  { id: "was-not-found", re: /\bno\b[^.!?]{0,60}\b(was|were) found\b/i },
  { id: "not-found-bare", re: /\b(not found|no jobs found|no results found|nothing found)\b/i },
  { id: "is-not-running", re: /\bis (not|never) running\b/i },
  { id: "is-unavailable", re: /\b(is|are) (unavailable|unreachable|down|dead|offline)\b/i },
  { id: "nothing-changed", re: /\bnothing\b[^.!?]{0,60}\b(has )?changed\b/i },
  { id: "no-progress", re: /\bno (progress|observable change|activity|movement)\b/i },
  { id: "nobody-is", re: /\b(nobody|no one|no agent|no worker) (is|has)\b/i },
];

/**
 * The id of the first absence-claim pattern `text` matches, or `null` if it asserts no absence.
 *
 * Returns the ID rather than a boolean on purpose: when this fires in a test the message needs to
 * name WHICH claim was made, or the failure reads as "some string somewhere is wrong" and the next
 * reader has to re-derive the lexicon by hand.
 */
export function absenceClaimIn(text: string): string | null {
  for (const p of ABSENCE_CLAIM_PATTERNS) {
    if (p.re.test(text)) return p.id;
  }
  return null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The three sentences a caller supplies for its own probe. Each is a function of the outcome so the
 * caller can name what it looked for without this module knowing anything about the domain.
 *
 * `couldNotLook` is the one this module polices. It is given the reason and the control so it can
 * say what went wrong; what it may NOT do is say the thing is absent.
 */
export interface ProbePhrasing<T> {
  found: (value: T) => string;
  /** The absence sentence. Reachable ONLY from a `not-found`, which by construction has a control. */
  notFound: (control: ProbeControl) => string;
  couldNotLook: (why: string, control: ProbeControl | null) => string;
}

/**
 * Render one outcome as the sentence a human reads.
 *
 * THE ENFORCEMENT LIVES HERE, and it THROWS rather than sanitising. A silent rewrite would leave the
 * caller's wrong sentence in the source, passing tests, waiting to be copied into the next probe —
 * and the whole lesson of the corpus is that these sentences propagate. A throw fails the test that
 * covers the call site and names the pattern, so the wrong sentence is fixed where it was written.
 *
 * In production a throw here would be worse than the wrong sentence, so callers that render on a
 * live path use {@link safeRenderProbeClaim}, which degrades to a fixed honest sentence and logs.
 * Test and dev builds want the throw; a running app wants the floor.
 */
export function renderProbeClaim<T>(outcome: ProbeOutcome<T>, phrasing: ProbePhrasing<T>): string {
  switch (outcome.kind) {
    case "found":
      return phrasing.found(outcome.value);
    case "not-found":
      return phrasing.notFound(outcome.control);
    case "could-not-look": {
      const text = phrasing.couldNotLook(outcome.why, outcome.control);
      const claim = absenceClaimIn(text);
      if (claim !== null) {
        throw new Error(
          `probeOutcome: a COULD-NOT-LOOK outcome rendered an ABSENCE CLAIM (pattern "${claim}"). ` +
            `The probe did not observe absence — it failed to observe. Rewrite this sentence to say ` +
            `what could not be read and why. Text was: ${JSON.stringify(text)}`,
        );
      }
      return text;
    }
  }
}

/** The sentence a live path falls back to when its own `couldNotLook` phrasing asserts absence. It
 *  is deliberately bland: the point is that it cannot mislead, not that it is informative. */
export const COULD_NOT_LOOK_FALLBACK =
  "This could not be read, so nothing is being claimed about it either way.";

/**
 * {@link renderProbeClaim} for a LIVE path: the same enforcement, but a bad sentence degrades to
 * {@link COULD_NOT_LOOK_FALLBACK} instead of taking the caller down. `onViolation` is how the caller
 * gets the finding into its own log — this module has no logger, so that stays the caller's.
 */
export function safeRenderProbeClaim<T>(
  outcome: ProbeOutcome<T>,
  phrasing: ProbePhrasing<T>,
  onViolation?: (message: string) => void,
): string {
  try {
    return renderProbeClaim(outcome, phrasing);
  } catch (e) {
    onViolation?.(String(e));
    return `${COULD_NOT_LOOK_FALLBACK}${outcome.kind === "could-not-look" ? ` (${outcome.why})` : ""}`;
  }
}
