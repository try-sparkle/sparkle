//! THE CONFLICT LADDER — when to look at a pull request, and when to say a human has to.
//!
//! Pure: data in, decision out. The clock, the identity hash and the `gh` verdict all arrive as
//! parameters, so every rule below is tested as arithmetic rather than by waiting out a real
//! two-hour rung. This is `nudge_ladder.rs`'s shape, deliberately and exactly — one pattern for
//! "watch a thing that has stopped moving and escalate", not two.
//!
//! ── THE FAILURE THIS CLOSES (bead sparkle-zss67) ──────────────────────────────────────────────
//! NOTHING in Sparkle watches for merge conflicts. A PR goes DIRTY and simply sits there. Measured
//! at the time of writing: five open PRs sat roughly 220 commits behind `main`, each carrying
//! exactly ONE commit of work — a day of small, good changes that nobody could land because nobody
//! could see that they had stopped being landable.
//!
//! ── THE COMPOUNDING FAILURE, WHICH IS THE WHOLE POINT ─────────────────────────────────────────
//! A CONFLICTING PR NEVER FIRES GitHub's `pull_request` EVENT, SO IT GETS NO CI AT ALL. Its checks
//! are not failing — they are ABSENT. So a conflicting PR is not merely "stale", it is UNTESTED,
//! and on the PR list it looks identical to one nobody has gotten to yet. Those two states are as
//! different as a locked door and an open one, and they render the same.
//!
//! "Conflicting — AND THEREFORE UNTESTED" must therefore be reported as ONE FACT, not as two
//! findings a reader is left to join. That single sentence is the most useful thing this detector
//! emits, and it is why [`untested`] exists as a derived fact rather than as a field somebody may
//! forget to set.
//!
//! ── WHY THIS CANNOT BE A MODEL ────────────────────────────────────────────────────────────────
//! Detection is MECHANICAL. `mergeStateStatus == DIRTY` is a string comparison and commits-behind
//! is an integer comparison. There is no judgement in either and no prose to parse — so this MUST
//! NOT depend on a model. A provider-wide 529 must never be able to blind us to conflicts, and
//! that is not hypothetical: on 2026-08-03 one outage took out every agent, the concierge and the
//! pusher at once, and the deterministic nudger was the only thing still working. This module is
//! built to be in that same category.
//!
//! ── WHY THE LADDER IS SLOW ────────────────────────────────────────────────────────────────────
//! `nudge_ladder` starts at 5 seconds because a WEDGED AGENT IS EXPENSIVE PER SECOND — it is
//! burning a slot and a human's attention right now. A CONFLICTING PR IS EXPENSIVE PER HOUR: the
//! work is committed and safe, it is just not landing, and the cost accrues as `main` drifts. So
//! this ladder starts at two minutes and tops out at two hours. Same machinery, different tempo,
//! and the tempo is the design.

/// How long to wait before LOOKING at this PR again, per rung. The last entry repeats forever.
///
/// Wall-clock seconds. 2m, 5m, 15m, 30m, 1h, 2h — dense enough at the start that a conflict raised
/// during a working session is surfaced while the author is still at the keyboard, sparse enough at
/// the end that a PR abandoned for a week costs one `gh` call every two hours for the life of the
/// process.
pub const LADDER_SECS: [u64; 6] = [120, 300, 900, 1800, 3600, 7200];

/// Rungs (0-indexed) below this NEVER flag. Covers the seeding look and the 120s look.
///
/// THE GRACE BAND, and it is not decoration: somebody may be actively rebasing RIGHT NOW. A PR is
/// DIRTY for the whole window between `main` moving and its author noticing, and flagging a
/// two-minute-old conflict would fight the very person already fixing it. Flagging therefore starts
/// on the third look — 120 + 300 = seven minutes in — by which point nobody is mid-`git rebase`.
const FIRST_FLAGGING_RUNG: usize = 2;

/// How far behind `origin/main` a MERGEABLE PR must be before it is called "stale".
///
/// 25 matches `[freshness].staleness_warn_commits`' default (config.rs), which is the number this
/// repo already uses for "this branch is old enough that you should rebase before trusting a test
/// run". Reusing it means a PR is called stale here at exactly the point an agent working on that
/// branch would already be warned — one threshold, not two that drift. It is a const rather than a
/// config read because this module is PURE; the driver is free to grow an override later.
pub const STALE_BEHIND_COMMITS: u64 = 25;

/// Unresolved looks that reached a flagging rung before the concierge is flagged.
const ESCALATE_CONCIERGE_AFTER: u32 = 3;

/// Unresolved looks that reached a flagging rung before the founder is flagged. This module never
/// addresses a human itself — it raises a flag that the pusher/concierge loop consumes.
const ESCALATE_FOUNDER_AFTER: u32 = 6;

/// Who a raised flag is for. NOT a message, and never delivered by this module.
///
/// `PartialOrd`/`Ord` are derived so `t > prev` reads as "a HIGHER flag than last time" — the same
/// once-per-threshold rule `nudge_ladder::step` uses, and the reason one stuck PR contributes three
/// notices over its lifetime instead of one every rung forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Escalation {
    /// The PR's own agent — the OWNER, who can rebase it. Always tried first: the overwhelming
    /// majority of conflicts are fixed by the person who wrote the branch, and involving anyone
    /// else before them is noise.
    Agent,
    Concierge,
    Founder,
}

impl Escalation {
    pub fn as_str(self) -> &'static str {
        match self {
            Escalation::Agent => "agent",
            Escalation::Concierge => "concierge",
            Escalation::Founder => "founder",
        }
    }
}

/// What the detector decided about one PR on one look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Look again later. The refusal on the `Decision` carries why nothing was raised.
    Observe,
    /// Raise (or refresh) this PR's flag.
    Flag {
        /// 1-based counter of unresolved looks that reached a flagging rung. Reported on the flag
        /// so a reader sees the history rather than one undated row.
        n: u32,
    },
}

/// Everything the ladder needs to know about one PR at one instant.
#[derive(Debug, Clone)]
pub struct Observation {
    /// Identity of THIS conflict: a hash over `(head_oid, merge_state)`. THE detector — a change to
    /// either is a new situation and resets the whole episode.
    ///
    /// ── WHY THE BASE OID IS *NOT* IN IT (roborev 57856) ────────────────────────────────────────
    /// The obvious third component is the base ref's tip, and including it would have quietly
    /// destroyed this module. `baseRefOid` is `main`'s head, which on this repo advances many times
    /// an hour — while reaching the first flag takes 7 minutes of unbroken episode, the concierge
    /// ~52 minutes, and the founder ~6 hours. Every landing on `main` would have reset every open
    /// PR to rung 0 AND auto-retracted its flag, so the detector would have been most thoroughly
    /// defeated during exactly the busy periods that produce conflicts in the first place.
    ///
    /// The reasoning error is worth naming, because it is easy to repeat: a base move does not
    /// RESOLVE a conflict, it AGGRAVATES one. The only two things that end an episode are the
    /// author pushing (head moves) and GitHub recomputing the PR as no longer dirty (merge state
    /// moves) — and the second of those already covers every way a base move could matter.
    pub hash: u64,
    /// `mergeStateStatus == DIRTY`. A string comparison; there is no judgement in it.
    pub is_dirty: bool,
    /// Commits on `origin/main` that this PR's head does not contain.
    pub commits_behind: u64,
    /// Does ANY check run exist for this PR at all?
    ///
    /// The direct observation behind [`untested_evidence`]. `false` on a conflicting PR is the
    /// fully-confirmed case: GitHub never fired `pull_request`, so nothing ever ran.
    pub has_ci: bool,
    /// GitHub says the PR is a DRAFT. A veto that means "fine" — see [`step`].
    pub is_draft: bool,
    /// This look's verdict was INHERITED from an earlier look rather than read now.
    ///
    /// GitHub recomputes mergeability asynchronously, so a query taken mid-recompute has no verdict
    /// to give and the driver carries the previous one forward. That is deliberately NOT a
    /// `refusal` — a recompute is not a failure to read, and treating it as one would escalate
    /// every healthy PR in the fleet each time anything landed on the base. But it is also not a
    /// first-hand observation, and [`untested_evidence`] must not claim it is (roborev 57915).
    pub carried: bool,
    /// `None` when the PR was READ successfully; `Some(reason)` when it could not be.
    ///
    /// THE FAIL-CLOSED ESCAPE HATCH, mirroring `nudge_ladder::Observation::refusal`. An
    /// unauthenticated or absent `gh` must never read as "no conflicts" — see [`step`], where this
    /// outranks every "it is fine" veto for exactly the reason an unreadable screen outranks a
    /// `working` claim there.
    pub refusal: Option<&'static str>,
}

/// The detector's memory of one PR, between looks.
#[derive(Debug, Clone, Default)]
pub struct PrState {
    /// Last observed identity hash. `None` before the first look — the seeding look, which never
    /// flags.
    hash: Option<u64>,
    /// Current rung, 0-indexed into [`LADDER_SECS`], saturating at the last entry.
    rung: usize,
    /// Looks that reached a flagging rung in this episode, WHETHER OR NOT the PR could be read.
    ///
    /// This drives escalation, and the distinction matters for the same reason it does in
    /// `nudge_ladder`: a PR we can never read is exactly the one a human most needs told about, so
    /// an unreadable look must still accumulate toward the flag.
    attempts: u32,
    /// Why the last look could not READ the PR, if it could not. Travels on the flag so a consumer
    /// can tell "this PR is conflicting" from "we cannot tell what this PR is".
    last_blocked: Option<&'static str>,
    /// Highest flag already raised in this episode, so each threshold is crossed once.
    escalated: Option<Escalation>,
    /// How long this conflict has gone unresolved, in seconds — carried onto the flag.
    unresolved_secs: u64,
}

impl PrState {
    /// Looks that reached a flagging rung — what escalation counts. Reported on every look's log
    /// line; see the driver's `tracing::debug!`.
    pub fn attempts(&self) -> u32 {
        self.attempts
    }
    /// Why the last look could not read the PR.
    pub fn last_blocked(&self) -> Option<&'static str> {
        self.last_blocked
    }
    pub fn unresolved_secs(&self) -> u64 {
        self.unresolved_secs
    }
    /// Highest flag raised so far in this episode. `None` once an episode has reset.
    pub fn escalated(&self) -> Option<Escalation> {
        self.escalated
    }
}

/// One look's full decision — this doubles as the log record, which is why it carries the inputs
/// that produced it as well as the outcome. Without it nobody can later answer "did anyone act on
/// these flags", and the next time five PRs rot we would be guessing again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    /// A flag newly raised at a HIGHER target than before, on THIS look. `None` on every other
    /// look, including later looks of an episode that has already escalated.
    pub escalate: Option<Escalation>,
    /// 1-based rung, for humans reading the log.
    pub rung: usize,
    /// The PR's identity changed since the last look, so the episode reset.
    pub changed: bool,
    /// The gate's verdict for this look. NOT "why nothing was flagged" — READ `action` FOR THAT.
    ///
    /// The three states, spelled out because a driver ported from `nudge_ladder` would guess wrong
    /// (roborev 57856). There, a blocked look means "we cannot WRITE", so it degrades to
    /// `Action::Observe` and `refusal.is_none()` really does mean "we acted". Here a blocked look
    /// means "we cannot READ", which is itself worth telling a human about — so it still flags:
    ///
    ///   * `None` with `Action::Flag`    — read cleanly, and something is wrong with the PR.
    ///   * `Some(r)` with `Action::Flag` — could not read it; flagged anyway, fail-closed, and `r`
    ///     travels to `ConflictFlag::blocked_by`.
    ///   * `Some(r)` with `Action::Observe` — nothing raised; `r` is why (`"seeding"`,
    ///     `"observe-only-rung"`, `"draft"`, `"mergeable"`).
    ///
    /// The one remaining combination, `None` with `Action::Observe`, occurs only on the reset look
    /// (`changed: true`) — where there is no verdict to give because the situation is brand new.
    ///
    /// MATCH ON `action`, NEVER ON `refusal.is_none()`.
    pub refusal: Option<&'static str>,
    /// How long to wait before looking at this PR again.
    pub next_look_secs: u64,
}

/// THE DECISION. Advances `state` and returns what to do.
///
/// Ordering note, and it is the same one `nudge_ladder::step` makes: the rung advances on every
/// unchanged look, INCLUDING looks in the observe-only band and looks where the PR could not be
/// read. The ladder measures how long the situation has gone unresolved, not how many times we
/// managed to read it cleanly.
pub fn step(state: &mut PrState, obs: &Observation) -> Decision {
    let previous = state.hash;
    let changed = previous.is_some_and(|h| h != obs.hash);

    // ANY change resets the whole episode. This is the entire detector — and it is also how a
    // RESOLVED conflict is noticed: `merge_state` is part of the hash, so a PR that stops being
    // DIRTY changes its identity, resets here, and reports `changed: true` — which is the signal
    // the driver turns into an auto-retraction of the flag.
    if changed || previous.is_none() {
        state.hash = Some(obs.hash);
        state.rung = 0;
        state.attempts = 0;
        state.last_blocked = None;
        state.escalated = None;
        state.unresolved_secs = 0;
        return Decision {
            action: Action::Observe,
            escalate: None,
            rung: 1,
            changed,
            // A first look has nothing to refuse — it is the baseline, not a declined flag.
            refusal: if changed { None } else { Some("seeding") },
            next_look_secs: LADDER_SECS[0],
        };
    }

    // Unchanged: climb.
    state.unresolved_secs += LADDER_SECS[state.rung.min(LADDER_SECS.len() - 1)];
    state.rung = (state.rung + 1).min(LADDER_SECS.len() - 1);
    let rung = state.rung;
    let next_look_secs = LADDER_SECS[rung];
    let rung_1based = rung + 1;

    let observe = |refusal: &'static str| Decision {
        action: Action::Observe,
        escalate: None,
        rung: rung_1based,
        changed: false,
        refusal: Some(refusal),
        next_look_secs,
    };

    // The grace band. Somebody may be rebasing right now; do not fight them.
    if rung < FIRST_FLAGGING_RUNG {
        return observe("observe-only-rung");
    }

    // ── THE VETO CHAIN ────────────────────────────────────────────────────────────────────────
    // Collected rather than returned early, because a veto that means "WE COULD NOT READ IT" must
    // still be able to ESCALATE — the same split `nudge_ladder` makes with `counts_as_attempt`.
    //
    // AN UNREADABLE PR OUTRANKS AN "IT IS FINE" CLAIM, and that ordering is the whole fail-closed
    // story. `is_draft` and `is_dirty` are both DERIVED FROM the `gh` output; when `gh` could not
    // be read at all they are defaults, not facts. Evaluating them first would let an
    // unauthenticated `gh` report every PR in the fleet as a fine, mergeable, non-draft PR forever
    // — which is precisely "we reported no conflicts because we could not look", the one outcome
    // this module must never produce.
    let blocked: Option<&'static str> = if obs.refusal.is_some() {
        obs.refusal
    } else if obs.is_draft {
        // A draft is deliberately not ready. Its author is not waiting on anyone.
        Some("draft")
    } else if !obs.is_dirty && obs.commits_behind < STALE_BEHIND_COMMITS {
        // Mergeable and current: there is nothing here to tell anybody about.
        Some("mergeable")
    } else {
        None
    };

    // The two vetoes that mean the PR is FINE rather than stuck do not count toward escalation.
    // Escalating those would page a human about a draft somebody is still writing.
    let counts_as_attempt = !matches!(blocked, Some("draft") | Some("mergeable"));
    if !counts_as_attempt {
        return observe(blocked.unwrap_or("blocked"));
    }

    state.attempts += 1;
    let n = state.attempts;
    state.last_blocked = blocked;

    // Escalate — not a message, and raised once per threshold crossed.
    let target = if n >= ESCALATE_FOUNDER_AFTER {
        Escalation::Founder
    } else if n >= ESCALATE_CONCIERGE_AFTER {
        Escalation::Concierge
    } else {
        // The OWNER first. Almost every conflict is fixed by whoever wrote the branch.
        Escalation::Agent
    };
    // `>` not `>=`: re-raising the same target every rung would turn one stuck PR into a stream of
    // identical notices, which is how a signal stops being read.
    let escalate = match (target, state.escalated) {
        (t, None) => {
            state.escalated = Some(t);
            Some(t)
        }
        (t, Some(prev)) if t > prev => {
            state.escalated = Some(t);
            Some(t)
        }
        _ => None,
    };

    Decision {
        // The look counted either way; whether it produced a NEW notice is a separate question.
        // The flag row itself is refreshed on every `Flag` look so its age never goes stale.
        action: Action::Flag { n },
        escalate,
        rung: rung_1based,
        changed: false,
        refusal: blocked,
        next_look_secs,
    }
}

/// Which fact this PR is flagged for: `"conflicting"` or `"stale"`.
///
/// Conflicting DOMINATES. A PR that is both dirty and 220 commits behind is reported as
/// conflicting, because that is the fact with the consequence attached — see [`untested`].
///
/// ── ONLY MEANINGFUL WHEN THE PR WAS READ (roborev 57856) ──────────────────────────────────────
/// This and [`untested`] describe the LAST KNOWN state, so on a look carrying `obs.refusal` they
/// are a stale reading, not a current fact. The flag keeps them honest by carrying that reason in
/// `ConflictFlag::blocked_by`, which exists for exactly this and whose own contract says so — but a
/// consumer that joins `kind` + `untested` WITHOUT consulting `blocked_by` will read a confident
/// label off data nobody could re-check. Read all three, or read the `evidence` field this
/// function's result is serialized into, which collapses them into one string that cannot be read
/// confidently by mistake. (`evidence` exists BECAUSE this paragraph used to point at a Rust
/// function no frontend consumer could call — roborev 57881.)
///
/// ── THAT WARNING WAS A LIVE DEFECT, AND IT IS NOW CLOSED ON THE ONE RENDERING CONSUMER ────────
/// The report is composed by `conflictCondition` in `packages/core/pusherFleet.ts`, and it did
/// exactly what the paragraph above warns about: a green, mergeable, level-with-main PR whose look
/// was REFUSED arrived there as `kind: "stale"` — the last successful read's word — and was
/// narrated "behind main and drifting further with every merge" for 22 minutes (bead
/// `sparkle-y0wmnb`). It now classifies off `evidence` FIRST: `"unknown"` means no confirmable
/// verdict for this commit, so the row is rendered as COULD NOT ASK GITHUB, is excluded from the
/// "N cannot merge" / "N are behind main" counts, and is never offered the rebase remedy. It is
/// still reported — dropping it would suppress a genuine standing conflict for a whole outage,
/// which is the failure this module's fail-closed path exists to prevent.
///
/// The two values are deliberately not joined by a third `"unreadable"` here: `kind` is a frozen
/// contract with its consumer, and a value it has never seen would be a silent breakage on the
/// other side of the boundary.
pub fn kind(obs: &Observation) -> &'static str {
    if obs.is_dirty {
        "conflicting"
    } else {
        "stale"
    }
}

/// IS THIS PR UNTESTED AS A CONSEQUENCE OF ITS CONFLICT? The one fact this whole module exists to
/// emit, derived rather than stored so it cannot be set wrong.
///
/// A conflicting PR is untested BY CONSTRUCTION: GitHub does not fire the `pull_request` event for
/// a head it cannot merge, so no workflow is dispatched. Its checks are ABSENT, not red — which on
/// a PR list is indistinguishable from "nobody has gotten to it yet". A merely-stale PR is a
/// different animal: it merges, so it ran, so its green is real (if increasingly old).
///
/// ── A REFUSAL ALSO ANSWERS `true`, AND THAT IS THE FAIL-CLOSED DIRECTION (roborev 57873) ──────
/// `false` is not a neutral answer — it is the positive claim "this PR's checks really ran". On a
/// look that could not READ the PR, `is_dirty` is the LAST value `gh` reported rather than a
/// current one, so that claim is not ours to make. `true` says only "do not assume this has been
/// tested", which is exactly what we know. [`untested_evidence`] separates the two reasons
/// (`"no-checks-ran"` vs `"unknown"`) for a caller that needs them apart.
pub fn untested(obs: &Observation) -> bool {
    obs.is_dirty || obs.refusal.is_some()
}

/// HOW we know a conflicting PR is untested — the difference between having seen the absence and
/// having inferred it.
///
///   * `"last-known"` — the verdict was INHERITED from an earlier look because GitHub was still
///     recomputing mergeability. Recent and real, but not read now, and the flag must not present
///     it as the directly-observed case (roborev 57915).
///   * `"last-known-unconfirmed"` — inherited AND declined: the same-head verdict is on the row, but
///     the recompute has outlasted its budget or the reading was one we do not understand. Still a
///     real recent verdict for this commit; just not one we could confirm this look.
///   * `"unknown"` — NOTHING is known about this commit: no reading now, and no same-head verdict to
///     fall back on. The strongest unknown of the three. Checked
///     first, and deliberately: every other arm here reads a field that is a LAST KNOWN value under
///     a refusal, and a helper whose whole job is to say how confident we are must not be the one
///     place that answers confidently from unread data (roborev 57856).
///   * `"no-checks-ran"` — no check run exists at all. Directly observed; the fully-confirmed case.
///   * `"checks-are-stale"` — check runs exist, from before the conflict arose. They ran against a
///     merge that no longer applies, so they say nothing about the PR as it stands now.
///   * `"n/a"` — not conflicting, so the question does not arise.
pub fn untested_evidence(obs: &Observation) -> &'static str {
    if obs.refusal.is_some() && obs.carried {
        // BOTH are true on the paths that inherit a same-head verdict and then decline to trust it
        // (the carry cap, an unrecognised merge state). Collapsing this onto `"unknown"` published
        // "we have no verdict for this commit" over a row whose `kind`/`untested` came from one —
        // so a consumer greying out unreadable rows would have suppressed a genuine, recent,
        // still-standing conflict, and for an unrecognised value the whole fleet's at once
        // (roborev 57937). It is its own answer because it is its own state.
        "last-known-unconfirmed"
    } else if obs.refusal.is_some() {
        "unknown"
    } else if obs.carried {
        "last-known"
    } else if !obs.is_dirty {
        "n/a"
    } else if obs.has_ci {
        "checks-are-stale"
    } else {
        "no-checks-ran"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A PR that went DIRTY and stayed there: same identity forever, readable, not a draft, well
    /// past the staleness threshold, and with no checks at all — the shape the bead describes. The
    /// default subject of every test below; each one changes exactly what it is about.
    fn conflicting() -> Observation {
        Observation {
            hash: 0xdead_beef,
            is_dirty: true,
            commits_behind: 220,
            has_ci: false,
            is_draft: false,
            carried: false,
            refusal: None,
        }
    }

    /// Run `n` looks and collect what was decided each time. Time advances by CALLING step — there
    /// is no clock here and no fake one, exactly as in `nudge_ladder`'s tests.
    fn run(state: &mut PrState, obs: &Observation, n: usize) -> Vec<Decision> {
        (0..n).map(|_| step(state, obs)).collect()
    }

    // ══ THE DETECTOR ════════════════════════════════════════════════════════════════════════════

    #[test]
    fn a_pr_that_stays_dirty_climbs_the_whole_ladder() {
        let mut s = PrState::default();
        let decisions = run(&mut s, &conflicting(), 10);

        // Rung 1 is the seeding look — it has no previous identity to compare against.
        assert_eq!(decisions[0].rung, 1);
        assert_eq!(decisions[0].refusal, Some("seeding"));

        // Then one rung per unchanged look, saturating at the last entry rather than running off
        // the end. Both sequences pinned literally: 2m, 5m, 15m, 30m, 1h, then 2h forever.
        let rungs: Vec<usize> = decisions.iter().map(|d| d.rung).collect();
        assert_eq!(rungs, vec![1, 2, 3, 4, 5, 6, 6, 6, 6, 6]);

        let waits: Vec<u64> = decisions.iter().map(|d| d.next_look_secs).collect();
        assert_eq!(
            waits,
            vec![120, 300, 900, 1800, 3600, 7200, 7200, 7200, 7200, 7200]
        );
    }

    #[test]
    fn any_identity_change_resets_the_ladder_to_rung_one() {
        let mut s = PrState::default();
        let climbed = run(&mut s, &conflicting(), 8);
        assert_eq!(climbed[7].rung, 6, "precondition: parked at the top of the ladder");
        assert!(s.attempts() > 0, "precondition: it had been flagging");

        // A push, a base move, or the conflict being fixed — all of them land here as a new hash.
        let rebased = Observation { hash: 0x1234, ..conflicting() };
        let d = step(&mut s, &rebased);

        assert!(d.changed);
        assert_eq!(d.rung, 1);
        assert_eq!(d.next_look_secs, 120);
        assert_eq!(d.action, Action::Observe);
        assert_eq!(s.attempts(), 0, "a moved PR has no flag history");
        assert_eq!(s.unresolved_secs(), 0);
    }

    /// A reset must clear the ESCALATION high-water mark too, or a PR that conflicts, is fixed, and
    /// conflicts again would silently skip straight past the owner-level notice.
    #[test]
    fn a_reset_clears_an_escalation_too() {
        let mut s = PrState::default();
        run(&mut s, &conflicting(), 20);
        assert_eq!(s.escalated(), Some(Escalation::Founder), "precondition: fully escalated");

        let fresh = Observation { hash: 0xfeed, ..conflicting() };
        step(&mut s, &fresh);
        assert_eq!(s.escalated(), None, "the reset must drop the high-water mark");

        // Climb again and assert the AGENT flag is raised afresh rather than suppressed by the
        // previous episode's Founder.
        let d = run(&mut s, &fresh, 3);
        let raised: Vec<Escalation> = d.iter().filter_map(|d| d.escalate).collect();
        assert_eq!(raised, vec![Escalation::Agent]);
    }

    // ══ THE OBSERVE-ONLY FLOOR ══════════════════════════════════════════════════════════════════

    /// The grace band: somebody may be rebasing RIGHT NOW, and flagging a two-minute-old conflict
    /// would fight the person already fixing it.
    ///
    /// The second half is the load-bearing half. Without it this test passes just as happily
    /// against a module that never flags at all — the trap `nudge_ladder` names by that same name.
    #[test]
    fn the_first_two_looks_never_flag_and_the_very_next_one_does() {
        let mut s = PrState::default();
        let decisions = run(&mut s, &conflicting(), 2);

        for d in &decisions {
            assert_eq!(d.action, Action::Observe, "rung {} must not flag", d.rung);
            assert!(d.escalate.is_none());
        }
        assert_eq!(decisions[1].refusal, Some("observe-only-rung"));

        // ...and the very next look, rung 3 (seven minutes in), DOES flag.
        let d = step(&mut s, &conflicting());
        assert_eq!(d.rung, 3);
        assert_eq!(d.action, Action::Flag { n: 1 });
        assert_eq!(d.escalate, Some(Escalation::Agent), "the OWNER is told first");
        assert_eq!(d.refusal, None);
    }

    // ══ THE VETOES ══════════════════════════════════════════════════════════════════════════════

    /// A draft is deliberately not ready and its author is not waiting on anyone.
    #[test]
    fn a_draft_pr_is_never_flagged_and_never_escalates() {
        let mut s = PrState::default();
        let draft = Observation { is_draft: true, ..conflicting() };
        let decisions = run(&mut s, &draft, 25);

        assert!(decisions.iter().all(|d| d.action == Action::Observe), "a draft must not flag");
        assert!(decisions.iter().all(|d| d.escalate.is_none()));
        assert_eq!(s.attempts(), 0);
        assert_eq!(decisions[2].refusal, Some("draft"));
    }

    /// A mergeable, current PR has nothing wrong with it. Note the `commits_behind` here: the veto
    /// is "mergeable AND current", because a mergeable PR far behind `main` is the "stale" kind.
    #[test]
    fn a_mergeable_and_current_pr_is_never_flagged() {
        let mut s = PrState::default();
        let fine = Observation { is_dirty: false, commits_behind: 3, has_ci: true, ..conflicting() };
        let decisions = run(&mut s, &fine, 25);

        assert!(decisions.iter().all(|d| d.action == Action::Observe));
        assert!(decisions.iter().all(|d| d.escalate.is_none()));
        assert_eq!(s.attempts(), 0);
        assert_eq!(decisions[3].refusal, Some("mergeable"));
    }

    /// The other side of that veto: mergeable but far behind IS flagged, as the "stale" kind. Pin
    /// the threshold on both sides so the boundary cannot drift unnoticed.
    #[test]
    fn a_mergeable_pr_far_behind_main_is_flagged_as_stale() {
        let just_under =
            Observation { is_dirty: false, commits_behind: STALE_BEHIND_COMMITS - 1, ..conflicting() };
        let at_threshold =
            Observation { is_dirty: false, commits_behind: STALE_BEHIND_COMMITS, ..conflicting() };

        let mut under = PrState::default();
        assert!(
            run(&mut under, &just_under, 6).iter().all(|d| d.action == Action::Observe),
            "one commit under the threshold must stay quiet"
        );

        let mut over = PrState::default();
        let decisions = run(&mut over, &at_threshold, 6);
        assert_eq!(decisions[2].action, Action::Flag { n: 1 });
        assert_eq!(kind(&at_threshold), "stale");
    }

    /// FAIL CLOSED — the regression that matters most, and the mirror of `nudge_ladder`'s
    /// `an_agent_we_can_never_write_to_still_escalates`.
    ///
    /// An unauthenticated or absent `gh` hands us defaults, not facts: `is_dirty: false`,
    /// `is_draft: false`, `commits_behind: 0`. Read in that order, those defaults say "a fine,
    /// mergeable PR" — so a veto chain that consulted them first would report the whole fleet as
    /// clean forever, silently, which is exactly "we reported no conflicts because we could not
    /// look". The refusal must outrank them and must still reach a human.
    #[test]
    fn a_pr_we_cannot_read_still_escalates_all_the_way() {
        for reason in ["gh-unavailable", "gh-unauthenticated", "gh-timeout"] {
            let mut s = PrState::default();
            // Every "it is fine" signal present, because that is what an unreadable probe looks
            // like from here.
            let unreadable = Observation {
                is_dirty: false,
                is_draft: false,
                commits_behind: 0,
                has_ci: true,
                refusal: Some(reason),
                ..conflicting()
            };
            let decisions = run(&mut s, &unreadable, 20);

            let raised: Vec<Escalation> = decisions.iter().filter_map(|d| d.escalate).collect();
            assert_eq!(
                raised,
                vec![Escalation::Agent, Escalation::Concierge, Escalation::Founder],
                "{reason}: a PR we cannot read must still reach a human"
            );
            assert_eq!(
                s.last_blocked(),
                Some(reason),
                "{reason}: and the flag must carry WHY, so 'it is conflicting' and 'we cannot tell' \
                 are distinguishable"
            );
        }
    }

    // ══ ESCALATION ══════════════════════════════════════════════════════════════════════════════

    #[test]
    fn the_owner_is_told_first_then_the_concierge_then_the_founder() {
        let mut s = PrState::default();
        let decisions = run(&mut s, &conflicting(), 20);

        let raised: Vec<(usize, Escalation)> =
            decisions.iter().filter_map(|d| d.escalate.map(|e| (d.rung, e))).collect();
        assert_eq!(
            raised,
            vec![
                (3, Escalation::Agent),
                (5, Escalation::Concierge),
                (6, Escalation::Founder)
            ],
            "one flag per threshold, and nothing else"
        );

        // Pin WHICH look each flag rode along with, so a change to the ladder that moved the
        // thresholds could not pass this test by coincidence of rung numbering.
        let at = |e: Escalation| decisions.iter().position(|d| d.escalate == Some(e)).unwrap();
        assert_eq!(decisions[at(Escalation::Agent)].action, Action::Flag { n: 1 });
        assert_eq!(decisions[at(Escalation::Concierge)].action, Action::Flag { n: 3 });
        assert_eq!(decisions[at(Escalation::Founder)].action, Action::Flag { n: 6 });
    }

    /// A target is raised ONCE. Re-raising every rung would turn one stuck PR into a stream of
    /// identical notices, which is how a signal stops being read.
    #[test]
    fn an_escalation_is_not_re_raised_every_rung() {
        let mut s = PrState::default();
        let decisions = run(&mut s, &conflicting(), 40);
        assert_eq!(
            decisions.iter().filter(|d| d.escalate.is_some()).count(),
            3,
            "exactly three escalations for one episode, however long it runs"
        );
        // ...while the LOOK itself keeps flagging, so the flag row's age stays current.
        assert_eq!(
            decisions.iter().filter(|d| matches!(d.action, Action::Flag { .. })).count(),
            38,
            "every look past the grace band refreshes the flag"
        );
    }

    /// The age reported on a flag is the REAL elapsed time, accumulated from the rungs already
    /// waited — not a constant and not the current rung.
    #[test]
    fn the_unresolved_age_accumulates_from_the_rungs_actually_waited() {
        let mut s = PrState::default();
        run(&mut s, &conflicting(), 3);
        // Waited 120 + 300 = 420s to reach the first flagging look at rung 3.
        assert_eq!(s.unresolved_secs(), 420);
        run(&mut s, &conflicting(), 1);
        assert_eq!(s.unresolved_secs(), 420 + 900);
    }

    // ══ "CONFLICTING — AND THEREFORE UNTESTED" ══════════════════════════════════════════════════

    /// The one fact this module exists to emit, and the reason it is DERIVED: a conflicting PR is
    /// untested by construction, and a merely-stale one is not.
    #[test]
    fn untested_is_true_exactly_when_the_kind_is_conflicting() {
        let dirty = conflicting();
        assert_eq!(kind(&dirty), "conflicting");
        assert!(untested(&dirty));

        let stale = Observation { is_dirty: false, commits_behind: 220, has_ci: true, ..conflicting() };
        assert_eq!(kind(&stale), "stale");
        assert!(!untested(&stale), "a stale PR still merges, so its checks really ran");

        // Conflicting DOMINATES: a PR that is both keeps the fact with the consequence attached.
        let both = Observation { commits_behind: 220, ..conflicting() };
        assert_eq!(kind(&both), "conflicting");
        assert!(untested(&both));

        // ...and the claim does NOT depend on whether checks happen to exist. A PR that went dirty
        // after CI had already run still has no CI for the state it is in now.
        let dirty_with_old_checks = Observation { has_ci: true, ..conflicting() };
        assert!(untested(&dirty_with_old_checks));
    }

    /// `has_ci` is the difference between having SEEN the absence and having inferred it.
    #[test]
    fn the_untested_evidence_distinguishes_absent_checks_from_stale_ones() {
        assert_eq!(untested_evidence(&conflicting()), "no-checks-ran");
        assert_eq!(
            untested_evidence(&Observation { has_ci: true, ..conflicting() }),
            "checks-are-stale"
        );
        assert_eq!(
            untested_evidence(&Observation { is_dirty: false, has_ci: true, ..conflicting() }),
            "n/a"
        );
        // A CARRIED verdict is recent and real but was not read now, so it must not be reported as
        // the directly-observed case (roborev 57915).
        assert_eq!(untested_evidence(&Observation { carried: true, ..conflicting() }), "last-known");
        assert_eq!(
            untested_evidence(&Observation { carried: false, ..conflicting() }),
            "no-checks-ran",
            "the control: the SAME facts read first-hand do claim direct observation"
        );
        // INHERITED *AND* DECLINED is its own state, not "we know nothing" (roborev 57937).
        // Collapsing it onto `"unknown"` published "no verdict for this commit" over a row whose
        // kind/untested came from one — so a consumer greying out unreadable rows suppressed a
        // genuine standing conflict.
        assert_eq!(
            untested_evidence(&Observation { carried: true, refusal: Some("gh-failed"), ..conflicting() }),
            "last-known-unconfirmed"
        );
        // ...and with NOTHING to fall back on it really is the strongest unknown.
        assert_eq!(
            untested_evidence(&Observation { carried: false, refusal: Some("gh-failed"), ..conflicting() }),
            "unknown"
        );
    }

    /// A LOOK THAT COULD NOT READ THE PR MUST NOT PRODUCE A CONFIDENT LABEL (roborev 57856).
    ///
    /// The fixture is the dangerous one: the last known state was CLEAN, so `kind`/`untested` —
    /// which read `is_dirty` and nothing else — answer "stale, and its checks really ran". That
    /// is a stale value, not a fact, and `untested_evidence` is the helper whose entire job is to
    /// say how confident we are, so it is the one that must refuse to answer.
    #[test]
    fn an_unreadable_look_never_claims_to_know_whether_the_pr_was_tested() {
        let unread =
            Observation { is_dirty: false, has_ci: true, refusal: Some("gh-failed"), ..conflicting() };
        assert_eq!(untested_evidence(&unread), "unknown");
        // And `untested` fails CLOSED rather than answering the positive claim "its checks ran".
        assert!(untested(&unread));
        assert!(!untested(&Observation { refusal: None, ..unread }), "the control");

        // The same facts WITHOUT the refusal answer confidently — so the assertion above is about
        // the refusal and not about some other field of the fixture.
        assert_eq!(untested_evidence(&Observation { refusal: None, ..unread }), "n/a");

        // And the refusal wins even over the case that would otherwise be the fully-confirmed one.
        assert_eq!(
            untested_evidence(&Observation { refusal: Some("gh-unavailable"), ..conflicting() }),
            "unknown"
        );
    }

    /// The look still FLAGS while carrying its refusal — `Decision::refusal` is the gate's verdict,
    /// not "why nothing was raised", and a driver that matched on `refusal.is_none()` to mean "we
    /// acted" would silently drop every unreadable-PR flag (roborev 57856).
    #[test]
    fn a_refused_look_still_carries_the_flag_action() {
        let mut s = PrState::default();
        let unread = Observation { refusal: Some("gh-failed"), ..conflicting() };
        let d = run(&mut s, &unread, 3);

        assert_eq!(d[2].action, Action::Flag { n: 1 }, "fail closed: it still flags");
        assert_eq!(d[2].refusal, Some("gh-failed"), "...while carrying WHY, on the same look");
        // The reset look is the one place `refusal` is None alongside `Observe`: there is no
        // verdict to give because the situation is brand new.
        assert_eq!(d[0].action, Action::Observe);
        assert_eq!(d[0].refusal, Some("seeding"));
        let reset = step(&mut s, &Observation { hash: 0x9999, ..unread });
        assert!(reset.changed);
        assert_eq!(reset.action, Action::Observe);
        assert_eq!(reset.refusal, None);
    }

    // ══ THE BEAD, REPLAYED ══════════════════════════════════════════════════════════════════════

    /// The five PRs that motivated this, end to end: one commit of work each, ~220 behind, DIRTY,
    /// and no CI at all — sitting there because nothing looked.
    #[test]
    fn the_five_rotting_prs_are_flagged_within_the_hour() {
        let mut s = PrState::default();
        let decisions = run(&mut s, &conflicting(), 6);

        // Flagged on the third look, seven minutes in.
        assert_eq!(decisions[2].action, Action::Flag { n: 1 });
        assert_eq!(decisions[2].escalate, Some(Escalation::Agent));
        // And escalated past the owner well inside the first hour of neglect.
        assert!(decisions.iter().any(|d| d.escalate == Some(Escalation::Concierge)));
        assert_eq!(s.unresolved_secs(), 120 + 300 + 900 + 1800 + 3600);
        // The headline fact, as ONE claim.
        assert_eq!(kind(&conflicting()), "conflicting");
        assert!(untested(&conflicting()));
        assert_eq!(untested_evidence(&conflicting()), "no-checks-ran");
    }
}
