// SHOULD A `/babysit-pr` DRIVER BE STARTED FOR THIS PR RIGHT NOW — and if not, WHY NOT.
//
// ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────────────────────────
// `.claude/skills/babysit-pr/SKILL.md` is 930 lines that answer review probes, drive re-review and
// self-terminate on merge/close/convergence. It works, and it is genuinely self-driving once it is
// started. NOTHING EVER STARTS IT: it is a slash command a human types when they remember. Over the
// last 40 merged PRs it was invoked on approximately one. PR #1176 merged carrying an unanswered
// `[blocking]` knightwatch probe, and five more PRs then piled up blocked and were only noticed when
// the founder tried to merge them by hand.
//
// This module is the DECISION and nothing else. No poller, no Tauri command, no spawn, no UI — those
// are separate units. Every input arrives as an argument.
//
// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
// No clock (callers pass `now`), no store, no `invoke`, no `listen`, no I/O, no model. The same
// discipline as `pusherFleet.ts` and `services/conflictFlags.ts`, and here it is what lets the four
// rules below be tested as arithmetic rather than by driving a running app against a live PR.
//
// ── RULE 1 · EVIDENCE, NEVER SCHEDULE ────────────────────────────────────────────────────────────
// The founder: *"A PR with no probes and green checks needs no loop. Start on evidence, not on
// schedule — otherwise you spawn an agent per PR and burn the fleet."* So evidence is an explicit,
// enumerated list ([`BabysitEvidenceKind`]) and an empty list HOLDS with `no-evidence`. There is no
// timer in this file and no "it has been a while" branch.
//
// RECONCILING THE TWO HALVES OF THE BRIEF. The founder listed *"a PR is opened"* as a trigger AND
// *"do not dispatch on every PR"* as a requirement. Both are satisfied only if opening triggers an
// EVALUATION whose answer is normally "no-evidence, wait". That is exactly what this function is:
// cheap, pure, and safe to run on every PR on every sweep. A newly-opened PR is a reason to CALL
// this; it is never, by itself, an argument that appears in the evidence list. `pr-opened` is
// deliberately NOT a `BabysitEvidenceKind`, and adding one would re-introduce dispatch-on-schedule
// wearing an event's clothes.
//
// THE TEST THAT ADMITTED `commits-pushed-since-last-review` AND STILL EXCLUDES `pr-opened`. The two
// look alike — both are "something happened to this PR" — and they are not the same kind of thing:
//
//   * `pr-opened` is an EVENT. True exactly once, for every PR, regardless of that PR's state, and
//     it can never become false again. Evidence built on it fires for every PR ever opened: a
//     schedule keyed on creation instead of on the clock. Nothing the PR does can clear it.
//   * `commits-pushed-since-last-review` is a STANDING FACT, re-derived from the PR on every sweep —
//     the head sha against the head the newest knightwatch review says it read. It is FALSE for a
//     healthy PR (the common case is a review that covers the head), becomes true when someone
//     pushes, and goes false again when a review catches up. It is a condition the PR is IN, exactly
//     like `checks-failing`, not a thing that happened to it once.
//
// The distinction is not "event vs fact" as a word game; it is whether the evidence can CLEAR. A
// kind that cannot clear is a schedule wearing an event's clothes. This one clears by itself.
//
// ── WHY IT HAD TO EXIST: THE GATE WAS SATISFIABLE AND THEN SILENTLY INVALIDATED ──────────────────
// knightwatch GATES the merge (`probe-gate.sh` really does exit 10), but it TRIGGERS on PR-open and
// takes 20-40 minutes to run. The steady state that produces: answer the probes, gate clears, push
// four more commits, merge code no reviewer has ever read. Observed on #1273 — knightwatch reviewed
// `9c65efe` while HEAD moved to `4d3030a`, and never saw the last four commits, one of them a
// High-severity credential-leak fix. Running knightwatch MORE OFTEN does not fix it: it is already
// automatic on PR-open, and it is stale BY CONSTRUCTION the moment the head moves under it.
// `babysit-pr` already knows how to notice (its Step 3.5 coverage table, which the Rust
// `reviewed_head`/`review_stale` parse mirrors) — but only once it is RUNNING, and nothing was ever
// starting it for this. That gap is what this kind closes.
//
// ── RULE 2 · EVIDENCE IS PROBES, NOT COMMENTS ────────────────────────────────────────────────────
// LOAD-BEARING, NOT TIDY. knightwatch's `⏸ knightwatch paused` status post re-posts roughly every
// two minutes for as long as an outage lasts, and it carries the review marker while listing ZERO
// probes (`knightwatch.rs` header: "Lifecycle status posts … carry the marker but list no probes").
// Keying evidence on "knightwatch commented" would fire ~30 dispatches an hour, each a full Claude
// session against the founder's own quota, during the exact window the account is already in
// trouble. And the two-observation rule below does NOT save you: a repost storm is PERSISTENTLY
// true, so it clears a two-sighting gate on its second post.
//
// Keying on UNANSWERED PROBES makes the storm produce no evidence at all — a status post
// contributes nothing to `probes`, so a thousand of them still sum to zero. That is the only
// mechanism here that is immune to the storm rather than merely slowed by it.
//
// ── RULE 3 · THE TWO-OBSERVATION RULE ────────────────────────────────────────────────────────────
// A condition must hold across two CONSECUTIVE sweeps before it may be acted on, so transient
// states never fire. The prior sighting arrives as an argument ([`BabysitObservation`]) — never read
// from a clock or a global. The shape is `pusherTriggers.persistedTriggers`': compare by stable
// IDENTITY, not by value, so a condition that persists while getting worse still qualifies.
//
// ── RULE 4 · ONE DRIVER PER PR, ABSOLUTELY ───────────────────────────────────────────────────────
// `babysit-pr`'s own frontmatter says ONE PASS PER INVOCATION; it arms its own follow-up. So two
// dispatches for one PR are not "a watcher started twice", they are two overlapping passes replying
// to the same comments on a human's pull request. The lease standing arrives as a plain string union
// ([`BabysitLeaseStanding`]) — another worker owns the lease itself, and nothing here imports it.
//
//   • `held-live` HOLDS (`driver-alive`).
//   • `held-dead` DOES NOT HOLD. A driver whose app restarted is gone, and the PR needs restarting:
//     Sparkle restarted three times in one day and lost every PTY each time. Treating a dead lease
//     as a live one is how a PR silently stops being watched forever.
//   • `unknown` HOLDS (`lease-unknown`) — FAIL CLOSED AGAINST DISPATCH. The harm is two drivers
//     double-posting on a human's PR, so "I could not tell whether a driver exists" must never read
//     as "no driver exists". This is the same three-states discipline `knightwatch.rs` and
//     `services/mergeGuard/types.ts` insist on, pointed the other way: there the unknown blocks a
//     MERGE, here it blocks a SPAWN, and in both cases collapsing it into a neighbour is the bug.
//
// ── WHY THE HOLD REASON IS A TYPED UNION AND NOT A BOOLEAN ───────────────────────────────────────
// `PRD/sparkle/babysit-pr-auto-dispatch.md` risk 5: `shouldRunImprovementPass` once answered `false`
// for hours and the only honest answer to "what has it been doing?" was *"nothing, and there is no
// way to find out why."* Every hold below is separately reachable and separately tested, so a
// dispatcher that has gone quiet can always name the reason it went quiet.
//
// ── COST IS A SAFETY PROPERTY ────────────────────────────────────────────────────────────────────
// Every dispatch is a full Claude session against the founder's own subscription quota — the same
// account the real build agents draw on. The hourly improvement pass carries a hard wall for exactly
// this reason. So: a per-PR cooldown and a fleet-wide dispatches-per-hour ceiling, both passed in as
// configuration with documented defaults rather than hard-coded magic numbers.

// -------------------------------------------------------------------------------------------------
// The frozen input contract — mirrors Rust's `ProbeGate` in `apps/desktop/src-tauri/src/knightwatch.rs`
// -------------------------------------------------------------------------------------------------

/** A probe's severity, exactly the two spellings the Rust contract recognises. */
export type BabysitProbeSeverity = "blocking" | "open";

/**
 * One knightwatch probe, resolved against the comments that followed it.
 *
 * Mirrors the Rust `Probe` (serde camelCase). Probe identity is `(commentId, index)` and NEVER the
 * index alone — numbering restarts in every review, so two reviews both raise a probe `1`.
 */
export interface BabysitProbe {
  /** The review comment that raised it. Half of the probe's identity. */
  commentId: number;
  /** 1-based, as written in the review. */
  index: number;
  severity: BabysitProbeSeverity;
  /** The specialist named by `[from: …]`, when the review carried one. */
  from: string | null;
  /** The probe's own text, already truncated by the producer. */
  text: string;
  /** A link straight to the review comment. */
  url: string;
  answered: boolean;
}

/**
 * What a read of one PR's knightwatch comments answered. Mirrors the Rust `ProbeGate`.
 *
 * THREE STATES, NEVER TWO — and `applicable` / `probes` are two separate facts precisely so that a
 * consumer reading only one of them still cannot confuse them:
 *
 *   * NOT-APPLICABLE — `applicable: false`. The read SUCCEEDED and this PR carries no knightwatch
 *     comment at all. Every non-Sparkle project is in this state. It is not "clean"; the probe
 *     evidence class simply does not apply.
 *   * UNKNOWN — `applicable: true`, `probes` nullish. The read FAILED or came back saturated. We
 *     could not look. This is the state that must never be collapsed into either neighbour.
 *   * AUTHORITATIVE — `probes: [...]`, where `[]` means "asked; this PR has no probes". A PR
 *     carrying nothing but `⏸ knightwatch paused` status posts is in THIS state with an empty
 *     array, which is the whole of rule 2's defence against the repost storm.
 *
 * NULLISH, NOT `undefined` — this type crosses an IPC boundary, so read UNKNOWN with `== null`.
 * Every optional field here mirrors a Rust `Option<T>` on `knightwatch.rs`'s `ProbeGate`, and serde
 * serializes `None` as JSON **`null`**; nothing on that struct carries `skip_serializing_if`, so the
 * key is always present and its value is literally `null`. A TS `?:` therefore describes a shape the
 * producer never sends, and an `=== undefined` / `!== undefined` guard written against it is wrong in
 * both directions — the two bugs below were one of each:
 *
 *   * `reviewedHead !== undefined && reviewedHead.length > 0` admitted `null` and then read `.length`
 *     off it. That THREW, and the throw was caught a whole level up in `sweepAllProjects` — so one
 *     PR whose newest review named no head aborted the sweep for its entire project, and every PR
 *     after it in that project went unswept for as long as the condition held.
 *   * `probes === undefined` missed `null`, so an unreadable read fell through to `no-evidence` —
 *     silently claiming "we looked; this PR is fine" about a PR nobody could look at. That is the
 *     exact collapse the THREE STATES note above exists to forbid, and it fails OPEN.
 */
export interface BabysitProbeGate {
  applicable: boolean;
  /** Nullish is UNKNOWN — never an empty answer. `[]` is "asked; none". Test it with `== null`. */
  probes: BabysitProbe[] | null | undefined;
  /** Why the read is unknown, in the tool's own words. Shown, never parsed. */
  error: string | null;
  /**
   * Does this PR carry a probe-gate override record newer than its newest knightwatch review?
   *
   * An override is a human saying "stop blocking me on these". Honouring it here means an overridden
   * gate contributes NO probe evidence: dispatching a driver to answer probes a human has explicitly
   * waved through would be arguing with the human. It is safe to honour because the Rust side bounds
   * an override to records newer than the newest review — a NEW review re-arms both the merge gate
   * and, therefore, this one.
   *
   * IT SUPPRESSES PROBE EVIDENCE AND NOTHING ELSE. A human waiving PROBES has said nothing about the
   * PR's checks or its merge state, so failing CI and a DIRTY merge state still dispatch. Broadening
   * it to "an overridden PR is never dispatched" would mean one override silently stops a PR from
   * ever being watched again however badly it later breaks — and it would report the healthy-sounding
   * `no-evidence` while doing it.
   */
  overridden: boolean;
  /**
   * WHICH HEAD the newest knightwatch review says it evaluated, as the bot printed it — abbreviated,
   * typically 7 chars. Mirrors Rust `ProbeGate::reviewed_head`.
   *
   * Nullish is UNKNOWN and MUST NOT be read as "covered": no review, a lifecycle status post, and
   * a status form the parser does not recognise all produce it. Compare by PREFIX against the 40-char
   * `headSha`, never with `===` — matching the short form against the start of the long one, and
   * never the reverse.
   *
   * `null` on the wire and `undefined` from a hand-built test object are the SAME state; see the
   * NULLISH note on this interface for why a `!== undefined` guard here threw on the real value.
   */
  reviewedHead?: string | null;
  /**
   * Does that review self-label `⚠️ Stale: head moved from X to Y mid-run`?
   *
   * AUTHORITATIVE not-covered, and better than our own sha arithmetic — the bot knows what it
   * actually diffed. Its own field rather than a third state of `reviewedHead` because it CO-OCCURS
   * with a named head rather than replacing one: a review can both say what it read and say that the
   * head has already moved past it.
   */
  reviewStale?: boolean;
}

/** Where the PR itself stands. A read that FAILED has no snapshot, so `unknown` is its own state. */
export type BabysitPrState = "open" | "closed" | "merged" | "unknown";

/**
 * The check rollup, already reduced by the producer.
 *
 * `absent` is "asked; this PR has NO checks at all", which is a real and different fact from
 * `pending`. `undefined` on the snapshot field is WE DID NOT LOOK and never becomes evidence.
 */
export type BabysitCheckRollup = "passing" | "failing" | "pending" | "absent";

/** What one sweep saw about one PR. Everything a decision needs; nothing it does not. */
export interface BabysitPrSnapshot {
  /** `owner/name`, quoted straight back in the dispatch. */
  repo: string;
  number: number;
  state: BabysitPrState;
  /**
   * gh's `mergeStateStatus`, case-insensitive. Kept as a BARE STRING on purpose, the same call
   * `RoborevJobRow.status` makes: an unrecognised value must be classifiable as "I don't know what
   * this is" rather than crash a dispatcher. Only `DIRTY` is evidence. `undefined` = not looked.
   */
  mergeStateStatus?: string;
  /** `undefined` = not looked. See [`BabysitCheckRollup`]. */
  checks?: BabysitCheckRollup;
  /**
   * The PR's current head oid, full 40 chars (`headRefOid`). `undefined` = NOT LOOKED, and like
   * every other unknown here it manufactures no evidence — without it there is no stable identity to
   * compare across sweeps, and rule 3 would have nothing to hold on to.
   */
  headSha?: string;
  gate: BabysitProbeGate;
}

/**
 * Whether a `/babysit-pr` driver already holds this PR. Owned by another unit (a Rust lease); this
 * module consumes the standing as a plain string and must not import from it.
 *
 * ── CALLER CONTRACT: `held-dead` MUST SURVIVE THE RESTART THAT CAUSED IT ─────────────────────────
 * The whole `held-dead` path below is keyed on this value, and the motivating scenario is an app
 * restart that killed the driver. So a lease that lives only in memory, or that is REAPED to `free`
 * the moment a driver stops being observable, defeats the recovery entirely: after the restart the
 * standing reads `free`, the recovery path never runs, and the PR waits out the full `cooldownMs`
 * before anyone looks at it again — exactly the outcome the path exists to prevent.
 *
 * An abnormally terminated driver must therefore be surfaced as `held-dead` and PERSISTED. The
 * design report already reaches this conclusion for a neighbouring reason: `pr_claims` is "a
 * courtesy, not a lock", lives in memory and dies with the app, so it is the wrong primitive;
 * `pr_owner.rs` is the durable record that survives a restart. `unknown` is the correct standing
 * while the lease store itself cannot be read — never `free`.
 */
export type BabysitLeaseStanding = "free" | "held-live" | "held-dead" | "unknown";

// -------------------------------------------------------------------------------------------------
// Evidence
// -------------------------------------------------------------------------------------------------

/**
 * The enumerated reasons a PR is worth a driver. This list is CLOSED: if a condition is not here it
 * is not evidence, which is what stops rule 1 from eroding one plausible addition at a time.
 */
export type BabysitEvidenceKind =
  /** An unanswered `[blocking]` probe — the case that produced PR #1176. */
  | "unanswered-blocking-probe"
  /** An unanswered `[open]` probe. Never blocks a merge; still owed an answer. */
  | "unanswered-open-probe"
  /**
   * The head has moved past what the newest knightwatch review read, so the current code is
   * UNREVIEWED. See the header for why this is a standing fact and `pr-opened` is not.
   */
  | "commits-pushed-since-last-review"
  /** The check rollup is failing. */
  | "checks-failing"
  /** The read succeeded and this PR has NO checks at all — CI never ran for it. */
  | "checks-absent"
  /** `DIRTY`: the PR conflicts, so GitHub never fired a `pull_request` event and it is untested. */
  | "merge-conflicting";

/** One reason, carrying enough to be reported without re-reading the PR. */
export interface BabysitEvidence {
  kind: BabysitEvidenceKind;
  /**
   * Stable identity ACROSS SWEEPS — the key the two-observation rule compares on. It must be equal
   * on two sweeps iff they saw the same condition, and must not embed anything that drifts (a
   * duration, a check name, a count), or a persisting condition would look new every time and could
   * never clear the gate.
   */
  id: string;
  /** One line, built only from facts the snapshot carried. */
  detail: string;
  /** Present exactly when `kind` is one of the two probe kinds. */
  probe?: BabysitProbe;
}

/** The Pusher's memory of THIS PR between sweeps: which evidence ids the last sweep saw. */
export interface BabysitObservation {
  evidenceIds: readonly string[];
}

/** The identities to remember for the next sweep. Feed straight into [`BabysitObservation`]. */
export function babysitEvidenceIds(evidence: readonly BabysitEvidence[]): string[] {
  return evidence.map((e) => e.id);
}

/**
 * Everything true about this PR right now, in a stable order (blocking probes, open probes, then the
 * PR-level conditions).
 *
 * Exported because the caller needs it TWICE: once for the decision and once to persist as the next
 * sweep's [`BabysitObservation`]. Deriving the memory from anything other than this function is how
 * the two halves of rule 3 drift apart.
 */
export function babysitEvidenceFor(pr: BabysitPrSnapshot): BabysitEvidence[] {
  const out: BabysitEvidence[] = [];

  // Rule 2. `probes: undefined` yields NOTHING here — an unknown read never manufactures evidence.
  // It is answered separately, by the `probe-read-unknown` hold, because "we could not look" and
  // "we looked and there is nothing" must not produce the same sentence.
  //
  // `applicable: false` also yields nothing, and needs no branch of its own: the Rust side pairs it
  // with an empty `probes`, and a PR with no knightwatch comments has no probes by construction.
  if (!pr.gate.overridden) {
    for (const probe of pr.gate.probes ?? []) {
      if (probe.answered) continue;
      out.push({
        kind: probe.severity === "blocking" ? "unanswered-blocking-probe" : "unanswered-open-probe",
        id: `${probe.severity}-probe:${probe.commentId}#${probe.index}`,
        detail: `Unanswered [${probe.severity}] probe ${probe.index} on comment ${probe.commentId}: ${probe.text}`,
        probe,
      });
    }
  }

  // IS THE CURRENT HEAD REVIEWED? Independent of the probe list above: a review with ZERO probes is
  // the healthy outcome and says nothing about whether it read THIS code.
  //
  // Every guard here fails CLOSED — the module's standing rule that an unknown never manufactures
  // evidence, applied three times over:
  //
  //   * `applicable: false` — no knightwatch on this PR at all. Every non-Sparkle project is here,
  //     and emitting would dispatch a driver on every one of their PRs forever.
  //   * `headSha` unknown — we did not look, so there is no stable id to carry across sweeps.
  //   * `reviewedHead` unknown AND not self-labelled stale — a lifecycle status post or a status form
  //     the parser does not recognise. "We could not tell what it read" is not "it read nothing".
  //
  // The overridden flag is deliberately NOT consulted. A human waiving PROBES has said nothing about
  // whether the code is reviewed, and the existing `overridden` doc makes exactly this point about
  // checks and merge state: it suppresses probe evidence and nothing else.
  if (pr.gate.applicable && pr.headSha !== undefined) {
    const reviewedHead = pr.gate.reviewedHead;
    // PREFIX, never equality — the bot prints 7 chars and `headSha` is the full 40. Short against the
    // start of long, never the reverse.
    //
    // `!= null`, never `!== undefined`: the producer sends `null` for UNKNOWN (see the interface's
    // NULLISH note), and the `undefined`-only form both admitted that `null` and then dereferenced
    // it — throwing out of the whole project's sweep rather than holding this one PR.
    const uncovered =
      pr.gate.reviewStale === true ||
      (reviewedHead != null && reviewedHead.length > 0 && !pr.headSha.startsWith(reviewedHead));
    if (uncovered) {
      out.push({
        kind: "commits-pushed-since-last-review",
        // KEYED ON THE HEAD, which is what makes rule 3 debounce a push instead of fighting it. While
        // someone is actively pushing, the id changes every sweep and never clears the two-observation
        // gate — so a driver starts once the branch SETTLES, not on the first commit of a burst. A
        // count of commits would have been the wrong identity for the reason rule 3 names outright:
        // it drifts, so a persisting condition would look new forever and could never qualify.
        id: `unreviewed-head:${pr.headSha}`,
        detail: pr.gate.reviewStale
          ? `knightwatch self-labelled its newest review stale — head ${pr.headSha.slice(0, 7)} is unreviewed.`
          : `The newest knightwatch review read ${reviewedHead}; head is now ${pr.headSha.slice(0, 7)} and unreviewed.`,
      });
    }
  }

  const conflicting = pr.mergeStateStatus?.toLowerCase() === "dirty";
  if (conflicting) {
    out.push({
      kind: "merge-conflicting",
      id: "merge-conflicting",
      detail: "The PR is conflicting (DIRTY), so GitHub has never run CI against it.",
    });
  }

  if (pr.checks === "failing") {
    out.push({ kind: "checks-failing", id: "checks-failing", detail: "The check rollup is failing." });
  } else if (pr.checks === "absent" && !conflicting) {
    // A DIRTY PR has no checks BECAUSE it is dirty — the `pull_request` event never fires for a PR
    // with no merge commit, so runs are ABSENT rather than pending. Reporting both would be one
    // cause counted twice, and `merge-conflicting` is the one that names the fix.
    //
    // NOT special-cased for drafts, deliberately: a draft carrying an unanswered blocking probe is
    // still owed an answer, and the two-observation rule already means a rollup must read absent
    // across two sweeps — minutes apart on any sane poll interval — before it counts, which is far
    // longer than the seconds between opening a PR and its workflows registering.
    out.push({
      kind: "checks-absent",
      id: "checks-absent",
      detail: "The PR has no checks at all — CI has never run for it.",
    });
  }

  // Blocking first — a reader should see the merge-stopping reason before the advisory ones. The
  // sort is stable, so within a rank the producer's order (the order the reviews raised the probes)
  // is preserved.
  out.sort((a, b) => rankOf(a.kind) - rankOf(b.kind));
  return out;
}

// Review-coverage facts group together at the top — an unanswered probe, then an unanswered probe of
// lesser severity, then "nobody has read this code at all" — ahead of the CI and merge conditions.
// The relative order of the original five is unchanged.
const EVIDENCE_RANK: Record<BabysitEvidenceKind, number> = {
  "unanswered-blocking-probe": 0,
  "unanswered-open-probe": 1,
  "commits-pushed-since-last-review": 2,
  "merge-conflicting": 3,
  "checks-failing": 4,
  "checks-absent": 5,
};

function rankOf(kind: BabysitEvidenceKind): number {
  return EVIDENCE_RANK[kind];
}

// -------------------------------------------------------------------------------------------------
// Configuration — documented defaults, never magic numbers at a call site
// -------------------------------------------------------------------------------------------------

/**
 * How long after a driver was last dispatched for (or last exited on) a PR before another may start.
 *
 * THIRTY MINUTES. The requirement is that a driver which just exited is not re-dispatched on the
 * next tick, and a tick is `OPEN_PR_POLL_MS` (180 s) at its slowest end — so the cooldown has to
 * outlast a whole babysit pass plus the sweep that observes its exit, not merely one interval. Half
 * an hour also bounds the worst case honestly: a PR that genuinely needs continuous attention gets
 * at most two sessions an hour out of this, which is inside the ceiling below.
 */
export const BABYSIT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * The fleet-wide ceiling on dispatches per rolling hour.
 *
 * FOUR, the same number as `pusherGate`'s `MESSAGES_PER_HOUR`, and for a stronger reason: a Pusher
 * message costs a notification, whereas a dispatch costs a full Claude session on the founder's own
 * subscription quota. The design report's risk 3 is exactly this, and the hourly improvement pass
 * carries a hard wall for the same reason. A ceiling of 0 is a legal way to say "measure but never
 * dispatch" and reports `rate-limited` for every PR.
 */
export const BABYSIT_DISPATCHES_PER_HOUR = 4;

/**
 * The cooldown that applies instead when the lease reads `held-dead` — a driver that was KILLED.
 *
 * FIVE MINUTES, roughly two sweeps of the 180 s open-PR poll. It exists because "restart it at once"
 * and "restart it with no limiter at all" are different things, and the second is not safe:
 *
 *   * It slows a crash loop. With no per-PR limiter, a PR whose driver dies on every start
 *     re-dispatches on EVERY sweep; five minutes makes that at most twelve attempts an hour.
 *   * It restores the grace period against a WRONG lease read. Without one, "two drivers
 *     double-posting on a human's PR" — the harm rule 4 calls unacceptable — rests entirely on the
 *     liveness read being correct with zero tolerance, including during the window after a dispatch
 *     when the process has not come up yet.
 *
 * WHAT IT DOES NOT DO, STATED PLAINLY BECAUSE THE ARITHMETIC DOES NOT SUPPORT THE NICER CLAIM:
 * it does not stop one sick PR from consuming the fleet's whole hourly budget. That budget is
 * FLEET-WIDE (`BABYSIT_DISPATCHES_PER_HOUR`, 4), and twelve permitted attempts an hour reach four in
 * about twenty minutes — so a crash-looping PR still spends it, just slower, after which every
 * healthy PR reports `rate-limited` for the rest of the rolling window.
 *
 * Raising this constant does not fix that either: keeping one PR under the whole budget needs a
 * clock longer than `BABYSIT_RATE_WINDOW_MS / maxDispatchesPerHour` (15 minutes at the defaults), at
 * which point it is indistinguishable from the 30-minute normal cooldown and the recovery path stops
 * recovering. A per-PR limiter cannot partition a shared budget — only something that can see all
 * the PRs can. So COST is bounded absolutely (the ceiling holds no matter what); SHARE is not, and
 * fairness is owed by whatever iterates PRs. Tracked as bead `sparkle-f70wf`.
 */
export const BABYSIT_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

/** The rolling window the ceiling is counted over. */
export const BABYSIT_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface BabysitDispatchConfig {
  /** Off is a first-class answer: it reports `disabled` rather than silently never firing. */
  enabled: boolean;
  cooldownMs: number;
  /** The shorter cooldown used when the lease reads `held-dead`. See [`BABYSIT_RECOVERY_COOLDOWN_MS`]. */
  recoveryCooldownMs: number;
  maxDispatchesPerHour: number;
}

/**
 * Fill in the documented defaults. A field that is absent, non-finite or negative falls back rather
 * than propagating: a `NaN` cooldown compares false against everything, which would silently DELETE
 * the cooldown instead of failing loudly, and this is the one place that can catch it.
 *
 * IT ALSO ENFORCES THE ONE RELATION BETWEEN FIELDS, because validating each in isolation is not
 * enough. The whole `held-dead` path rests on the recovery clock being the SHORTER one; a config
 * whose `recoveryCooldownMs` exceeds `cooldownMs` would make a DEAD lease wait longer than a merely
 * free one, so a killed driver's PR would sit at `cooling-down` for however long the operator typed
 * — the "silently stops being watched" outcome rule 4 exists to prevent, delivered by the code added
 * to prevent it. Clamped rather than rejected: this returns a config, not a `Result`, and a clamp
 * degrades to "recovery is no worse than the normal cooldown", which is always safe.
 */
export function resolveBabysitConfig(partial: Partial<BabysitDispatchConfig> = {}): BabysitDispatchConfig {
  const cooldownMs = nonNegative(partial.cooldownMs, BABYSIT_COOLDOWN_MS);
  return {
    enabled: partial.enabled ?? true,
    cooldownMs,
    recoveryCooldownMs: Math.min(
      nonNegative(partial.recoveryCooldownMs, BABYSIT_RECOVERY_COOLDOWN_MS),
      cooldownMs,
    ),
    maxDispatchesPerHour: nonNegative(partial.maxDispatchesPerHour, BABYSIT_DISPATCHES_PER_HOUR),
  };
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** What the fleet as a whole can afford right now. */
export interface BabysitFleetState {
  /**
   * When each recent dispatch happened, epoch ms, ANY PR. Only the last
   * [`BABYSIT_RATE_WINDOW_MS`] is read; the caller may keep a longer tail.
   */
  recentDispatchAt: readonly number[];
  /**
   * Free local agent slots. `localAgentCapacity()` is a machine-wide ceiling and an auto-dispatcher
   * competes with the founder's own "+ New Build Agent" for it, so being full must REFUSE with a
   * recorded reason and never queue silently (design report, risk 4).
   */
  freeAgentSlots: number;
  /** When a driver was last dispatched for THIS PR. `undefined` = never. */
  lastDispatchAt?: number;
  /**
   * When a driver for THIS PR last exited. `undefined` = never, or not observable.
   *
   * Both timestamps exist because either alone leaves a hole: cooling off from the DISPATCH lets a
   * pass longer than the cooldown be re-dispatched the moment it ends, and cooling off from the EXIT
   * does nothing at all for a driver whose exit was never seen. The later of the two governs.
   *
   * CALLER CONTRACT: this is the moment the exit HAPPENED (or was first observed), stamped ONCE and
   * never re-stamped. A caller that refreshes it on every sweep that still sees a finished driver
   * would pin the PR at `cooling-down` forever — the "silently stops being watched" outcome rule 4
   * exists to prevent, arriving through the back door. The `held-dead` exemption below covers the
   * abnormal-termination case; it cannot cover a monotonically advancing timestamp.
   */
  lastDriverExitAt?: number;
}

// -------------------------------------------------------------------------------------------------
// The decision
// -------------------------------------------------------------------------------------------------

/**
 * Why no driver is being started. A typed union, never a sentence and never a bare `false` — see the
 * header on `shouldRunImprovementPass`.
 */
export type BabysitHoldReason =
  /** Auto-dispatch is switched off in configuration. */
  | "disabled"
  /** Nothing about this PR warrants a driver. THE COMMON, HEALTHY ANSWER. */
  | "no-evidence"
  /** A driver is already alive for this PR. Rule 4. */
  | "driver-alive"
  /** We could not tell whether a driver exists. Rule 4, fail-closed. */
  | "lease-unknown"
  /** The knightwatch comment read failed, so "no evidence" would be a claim we cannot make. */
  | "probe-read-unknown"
  /** Evidence exists but this is the first sweep that saw it. Rule 3. */
  | "single-observation"
  /** No free local agent slot. */
  | "at-capacity"
  /** The fleet-wide dispatches-per-hour ceiling is spent. */
  | "rate-limited"
  /** A driver ran for this PR too recently. */
  | "cooling-down"
  /** The PR is closed or merged — there is nothing left to babysit. */
  | "pr-not-open"
  /** We could not read the PR's own state. */
  | "pr-state-unknown";

export type BabysitDecision =
  | { dispatch: true; repo: string; pr: number; evidence: BabysitEvidence[] }
  | { dispatch: false; hold: BabysitHoldReason };

export interface BabysitDispatchInput {
  /** Epoch ms. Passed in — this module never reads a clock. */
  now: number;
  config: BabysitDispatchConfig;
  pr: BabysitPrSnapshot;
  lease: BabysitLeaseStanding;
  /** What the PREVIOUS sweep saw for this PR. `undefined` = there was no previous sweep. */
  prior: BabysitObservation | undefined;
  fleet: BabysitFleetState;
}

/**
 * The whole decision, deterministic and model-free.
 *
 * ── THE ORDER OF THE HOLDS IS ITSELF A DESIGN DECISION ───────────────────────────────────────────
 * Absolute conditions first (off, not a live PR, someone else has it), then the EVIDENCE question,
 * then the resource ceilings. Putting the ceilings LAST is what makes them mean something: with the
 * evidence gate ahead of them, `at-capacity` and `rate-limited` are only ever reported for a PR that
 * would otherwise have been dispatched. Reported first, they would fire for every healthy PR on
 * every sweep and drown the one case anyone wants to see.
 */
export function decideBabysitDispatch(input: BabysitDispatchInput): BabysitDecision {
  const { now, config, pr, lease, prior, fleet } = input;

  if (!config.enabled) return hold("disabled");

  if (pr.state === "unknown") return hold("pr-state-unknown");
  if (pr.state !== "open") return hold("pr-not-open");

  // Rule 4, before anything else is computed: whether this PR needs a driver is not even an
  // interesting question while another one may be holding it.
  if (lease === "held-live") return hold("driver-alive");
  if (lease === "unknown") return hold("lease-unknown");
  // "held-dead" falls through deliberately. See the header: a driver whose app restarted is gone.

  const evidence = babysitEvidenceFor(pr);

  if (evidence.length === 0) {
    // UNKNOWN is not evidence and never manufactures a dispatch — but with the list empty it is also
    // the reason we cannot say `no-evidence`, which is a claim ("we looked; this PR is fine") that an
    // unreadable probe read does not support. When other evidence DID land, the unknown changes
    // nothing: we already have a reason to go, and the driver reads the comments itself on arrival.
    // `== null` catches the `null` the IPC producer actually sends as well as the `undefined` a
    // hand-built object carries. `=== undefined` matched only the second, so a real unreadable read
    // fell through to `no-evidence` — the fail-OPEN direction. See the interface's NULLISH note.
    if (pr.gate.applicable && pr.gate.probes == null) return hold("probe-read-unknown");
    return hold("no-evidence");
  }

  // Rule 3. Compare by identity, never by value.
  const seenBefore = new Set(prior?.evidenceIds ?? []);
  if (!evidence.some((e) => seenBefore.has(e.id))) return hold("single-observation");

  // A DEAD LEASE COOLS DOWN ON THE SHORT CLOCK, NOT THE FULL ONE — rule 4, not a shortcut.
  // The full cooldown's premise is "a driver just ran, give it room". A `held-dead` lease says the
  // exact opposite: the last dispatch produced a driver that was KILLED — Sparkle restarted three
  // times in one day and lost every PTY each time — so its pass never completed and there is nothing
  // to give room to. Charging it the full `cooldownMs` would hold the recovery for up to half an
  // hour on precisely the PR the invariant promises to restart.
  //
  // But NOT zero, which is what this was on the previous commit: with no per-PR limiter at all, a PR
  // whose driver dies on every start re-dispatches on every sweep, and the grace period that
  // tolerates a wrong liveness read disappears with it. The short clock restarts a killed driver
  // inside a sweep or two while slowing a crash loop to twelve attempts an hour.
  //
  // It SLOWS that loop; it does not stop it consuming the fleet's shared hourly budget — see
  // [`BABYSIT_RECOVERY_COOLDOWN_MS`] for why no value of this constant can, and bead `sparkle-f70wf`
  // for where fairness actually belongs.
  const cooldownMs = lease === "held-dead" ? config.recoveryCooldownMs : config.cooldownMs;
  const lastDriverAt = latest(fleet.lastDispatchAt, fleet.lastDriverExitAt);
  if (lastDriverAt !== undefined && now - lastDriverAt < cooldownMs) return hold("cooling-down");

  if (fleet.freeAgentSlots <= 0) return hold("at-capacity");

  const inWindow = fleet.recentDispatchAt.filter((t) => now - t < BABYSIT_RATE_WINDOW_MS).length;
  if (inWindow >= config.maxDispatchesPerHour) return hold("rate-limited");

  // The report is everything true NOW, not merely the subset that has been true twice: the GATE is
  // "at least one condition has persisted", and once it is open the driver should be told about the
  // whole PR. Same reasoning as `persistedTriggers` quoting the current measurement.
  return { dispatch: true, repo: pr.repo, pr: pr.number, evidence };
}

function hold(reason: BabysitHoldReason): BabysitDecision {
  return { dispatch: false, hold: reason };
}

function latest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
