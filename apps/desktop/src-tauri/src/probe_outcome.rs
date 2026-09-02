//! probe_outcome (bead `sparkle-gazo4a`) — the Rust half of "we could not look" is a THIRD outcome,
//! and it may never be rendered as "it is not there".
//!
//! # The bug this exists to kill
//!
//! A probe looks for something. The look FAILS — errors, times out, lacks credentials, or comes back
//! empty from a query nobody proved was working — and the empty result is published as PROOF OF
//! ABSENCE rather than as a FAILED OBSERVATION. Six measured instances are recorded in
//! `apps/desktop/shared/false-absence-corpus.json`, which is the canonical contract for both
//! language halves. Four of them are in `pipeline_health.rs`.
//!
//! # Why a lexicon, when `HealthState::Unknown` already existed
//!
//! This is the whole point, and it is easy to miss. [`crate::pipeline_health::HealthState`] has
//! carried an `Unknown` variant since long before any of these instances, with a doc comment
//! explaining it, a severity rank below `Warning`, and unit tests. **Four of the six happened
//! anyway.**
//!
//! The reason is that the type governs THE FOLD — which colour the chip paints — while the thing a
//! human actually reads and acts on is the DETAIL STRING attached to the reading. Nothing governed
//! that at all, so a component correctly typed `Unknown` still said "the review daemon is not
//! running", and a person restarted a healthy daemon on the strength of it.
//!
//! So: the type decides the colour, and [`absence_claim_in`] decides whether the SENTENCE is
//! allowed. Both are required, and the tests in `pipeline_health.rs` assert both.
//!
//! # The lexicon is a hand-written copy, and it is PINNED
//!
//! [`ABSENCE_CLAIM_PATTERNS`] mirrors `absenceClaims.patterns` in the corpus JSON, exactly as
//! `config.rs`'s `MERGE_PROTECTED_SLUGS` mirrors `merge-protected-repos.json`. The TypeScript half
//! (`apps/desktop/src/engine/probeOutcome.ts`) holds a third copy. Two hand-written copies that are
//! not each pinned to ONE file drift on the first edit — and this repo has measured what that costs
//! (`sparkle-16y6h`: two halves built in parallel against a frozen field list, both suites green,
//! the shipped feature never once ran). The test at the bottom of this file is that pin.
//!
//! The patterns are written in a syntax both JavaScript's `RegExp` and the `regex` crate accept
//! unchanged — no lookaround, no backreferences — so the one contract file serves both.

use regex::Regex;
use std::sync::OnceLock;

/// The vocabulary of an ABSENCE CLAIM: `(id, pattern)` pairs, case-insensitive.
///
/// ⚠️ **These are not banned words.** They are checked ONLY against text generated for a
/// COULD-NOT-LOOK reading. A genuine not-found is *supposed* to say "it is not there" — that is the
/// entire reason the third outcome exists separately rather than being folded into absence. Applying
/// this list to every string in the app would be a different and much worse feature.
///
/// Order and content are pinned to the contract by [`tests::the_absence_lexicon_is_pinned_to_the_shared_contract`].
pub const ABSENCE_CLAIM_PATTERNS: &[(&str, &str)] = &[
    ("does-not-exist", r"\b(does not|doesn't|do not|don't) exist\b"),
    ("there-is-no", r"\bthere (is|are|was|were) no\b"),
    ("not-even", r"\bnot even a\b"),
    ("none-at-all", r"\b(no|none|nothing)\b[^.!?]{0,60}\bat all\b"),
    ("was-not-found", r"\bno\b[^.!?]{0,60}\b(was|were) found\b"),
    ("not-found-bare", r"\b(not found|no jobs found|no results found|nothing found)\b"),
    ("is-not-running", r"\bis (not|never) running\b"),
    ("is-unavailable", r"\b(is|are) (unavailable|unreachable|down|dead|offline)\b"),
    ("nothing-changed", r"\bnothing\b[^.!?]{0,60}\b(has )?changed\b"),
    ("no-progress", r"\bno (progress|observable change|activity|movement)\b"),
    ("nobody-is", r"\b(nobody|no one|no agent|no worker) (is|has)\b"),
];

/// Compiled once. A bad pattern here is a programmer error caught by the pin test, so the compile is
/// allowed to panic rather than surfacing a `Result` every caller would have to ignore.
fn compiled() -> &'static [(&'static str, Regex)] {
    static CELL: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    CELL.get_or_init(|| {
        ABSENCE_CLAIM_PATTERNS
            .iter()
            .map(|(id, src)| {
                let re = Regex::new(&format!("(?i){src}"))
                    .unwrap_or_else(|e| panic!("absence-claim pattern {id} does not compile: {e}"));
                (*id, re)
            })
            .collect()
    })
}

/// The id of the first absence-claim pattern `text` matches, or `None` when it asserts no absence.
///
/// Returns the ID rather than a bool deliberately: when this fires in a test the message has to name
/// WHICH claim was made, or the failure reads as "some string somewhere is wrong" and the next
/// reader has to re-derive the lexicon by hand.
pub fn absence_claim_in(text: &str) -> Option<&'static str> {
    compiled().iter().find(|(_, re)| re.is_match(text)).map(|(id, _)| *id)
}

/// How far back a windowed read actually SAW, and whether it saw everything.
///
/// # The forgotten half of a control
///
/// An empty result is evidence of absence only once you have shown the query can return a non-empty
/// one AND that it covered the ground the claim covers. The first half — reachability — is the one
/// everybody remembers: a 401 or a timeout obviously proves nothing. The second half is the one that
/// gets forgotten, because a successful HTTP 200 *feels* like an answer.
///
/// A paginated, windowed, capped or scope-limited read PROVES PRESENCE BUT CAN NEVER PROVE ABSENCE:
/// not seeing the thing settles nothing, because it may live on a page nobody fetched. This is the
/// same bit `scripts/lib/pipeline-health.sh`'s `ph_read_pool` returns as its third field, and its
/// comment names the measured victim — an hourly scan filing a P1 "release runner blocking" bead
/// against a live fleet of 61 registrations read through a ~26-entry ceiling.
///
/// Measured for the knightwatch case on 2026-08-26: the repo-wide comments page came back FULL (100
/// of 100) and its oldest entry was ~15 hours old, while the claim being made spans 48 hours. So the
/// window was a THIRD of the question, and an empty result could not settle it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadHorizon {
    /// Was the page FULL — i.e. is the list we hold a truncated view of a larger set?
    pub truncated: bool,
    /// Age in seconds of the OLDEST item the read actually saw, or `None` when nothing was seen (and
    /// therefore nothing bounds the window at all).
    pub oldest_seen_secs: Option<u64>,
}

impl ReadHorizon {
    /// Can an EMPTY result from this read support a claim about the last `claim_span_secs` seconds?
    ///
    /// Only when the read is not truncated, or when it is truncated but nevertheless reached back
    /// PAST the span the claim covers — a full page whose oldest entry is older than the question
    /// has still answered the question, because anything within the span would have been in it.
    ///
    /// `oldest_seen_secs: None` on a truncated read is the worst case (a full page we could not date)
    /// and settles nothing.
    pub fn covers(&self, claim_span_secs: u64) -> bool {
        if !self.truncated {
            return true;
        }
        self.oldest_seen_secs.is_some_and(|oldest| oldest >= claim_span_secs)
    }
}

// ── HYSTERESIS: ONE non-green reading is a BLIP, not a finding (bead `sparkle-imfgv5`) ──────────
//
// # The bug this exists to kill
//
// The same module-level mistake as the absence lexicon above, one layer along: a probe looks, gets
// ONE bad reading, and publishes it as a standing fact. Measured on the hourly deployment-pipeline
// scan — a transient, self-healing CI runner dip re-filed the same P1 bead on EVERY pass, with no
// hysteresis of any kind. One bead accumulated **159 recurrence comments** and was dispatched to a
// top-priority agent as a fleet-blocking emergency, while CI had in fact been reaching green
// conclusions throughout. A pool mid-replacement (MIG `isStable=False`, size 4/6) is not the same
// fact as a dead pool, and a monitor that cannot tell them apart converts every blip into a
// standing P1 and burns a top-priority agent on a non-problem.
//
// # Why it lives HERE and not beside the classifier
//
// This module is already the home of "what a single reading is allowed to CLAIM". [`absence_claim_in`]
// governs the sentence a could-not-look reading may write; [`ReadHorizon`] governs whether an empty
// read covers the span its claim reaches. This is the third of the same family: whether ONE
// observation may be published as a condition. All three are pure, all three are pinned to a shared
// JSON contract, and all three exist because the *type* being right (`HealthState::Unknown` has
// always existed) did not stop the *behaviour* being wrong.
//
// # The live consumer is the shell half
//
// `scripts/pipeline-health-scan.sh` is what actually files beads — the app's chip renders, it does
// not write to the backlog — so the production caller of this rule is `ph_hysteresis_step` in
// `scripts/lib/pipeline-health.sh`. That is exactly the shape that has burned this pair twice
// (`sparkle-vlnf7c`, `sparkle-negds0`): a rule implemented on one side, drifting on the other,
// with each half's tests re-encoding its own copy. So both halves replay the SAME sequences from
// `apps/desktop/src-tauri/contracts/pipeline-confirmation-contract.json`, and a rank or a threshold edited on
// one side alone reddens BOTH suites.

/// The four knobs, each closing a different half of the measured harm.
///
/// A ZERO IS "DISABLED", NEVER "ALWAYS TRUE". For [`Self::min_secs`] a naive `sustained >= 0` would
/// confirm on the very first reading, which is the defect itself; for [`Self::cooldown_secs`] and
/// [`Self::max_recurrences`] a zero simply turns that brake off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HysteresisPolicy {
    /// CONFIRM-TWICE: consecutive non-green passes required before the backlog is touched at all.
    pub passes: u32,
    /// The sustained-window alternative, for a caller whose passes are irregular. 0 disables it.
    pub min_secs: u64,
    /// Minimum gap between recurrence writes on a component that stays red. 0 disables it.
    pub cooldown_secs: u64,
    /// Hard ceiling on writes per unhealthy streak. 0 disables it.
    pub max_recurrences: u32,
}

impl HysteresisPolicy {
    /// Pinned to `hysteresis.policy` in the shared contract by the test at the bottom of this file,
    /// and to the shell's own unset-variable defaults by
    /// `scripts/tests/pipeline-health-hysteresis.test.sh`.
    pub const DEFAULT: HysteresisPolicy =
        HysteresisPolicy { passes: 2, min_secs: 0, cooldown_secs: 21_600, max_recurrences: 12 };
}

impl Default for HysteresisPolicy {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// What one component's history looks like between passes. The caller persists it; this module
/// never touches a filesystem, which is what lets a whole SEQUENCE of passes be unit-tested.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreakState {
    /// Consecutive non-green observations, including the one just taken.
    pub streak: u32,
    /// When the current streak began. Meaningful only while `streak > 0`.
    pub first_epoch: u64,
    /// When the backlog was last written for this streak.
    pub last_filed_epoch: u64,
    /// How many times the backlog has been written during this streak.
    pub filings: u32,
}

/// What the caller should do with this pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HysteresisAction {
    /// Green, and no streak was running — nothing to write and nothing to say.
    None,
    /// Green after a streak. The streak, the filing count AND the cooldown all reset, so a later dip
    /// must re-confirm from scratch. This is the half that stops a FLAP accumulating.
    Clear,
    /// Non-green but UNCONFIRMED. The reading is still REPORTED; only the store is left alone.
    Hold,
    /// Non-green and confirmed — create or enrich exactly one record now.
    File,
    /// Non-green and confirmed, but inside the cooldown or at the recurrence ceiling.
    Suppress,
}

impl HysteresisAction {
    /// The token both halves print, and the one the contract's `expect` arrays are written in.
    pub fn as_str(self) -> &'static str {
        match self {
            HysteresisAction::None => "none",
            HysteresisAction::Clear => "clear",
            HysteresisAction::Hold => "hold",
            HysteresisAction::File => "file",
            HysteresisAction::Suppress => "suppress",
        }
    }

    /// Does this action TOUCH the backlog? The one question every caller actually asks, given a
    /// name so no caller has to re-derive it from the variant list — and so that adding a variant
    /// forces a decision here rather than defaulting to "writes".
    pub fn writes_to_the_backlog(self) -> bool {
        matches!(self, HysteresisAction::File)
    }
}

/// Decide one pass. PURE: the caller supplies the prior state and the clock, and gets back the
/// action plus the state to persist.
///
/// `green` folds `Healthy` and `NotApplicable` together on purpose — a component that is
/// deliberately off has nothing to confirm, and treating it as non-green would keep a streak alive
/// forever on a machine with, say, roborev disabled.
pub fn hysteresis_step(
    green: bool,
    prior: StreakState,
    now: u64,
    policy: &HysteresisPolicy,
) -> (HysteresisAction, StreakState) {
    if green {
        if prior.streak == 0 && prior.filings == 0 {
            return (HysteresisAction::None, StreakState::default());
        }
        return (HysteresisAction::Clear, StreakState::default());
    }

    let streak = prior.streak + 1;
    // THE STREAK COUNT DECIDES WHETHER A FIRST-SEEN EPOCH EXISTS, NOT THE EPOCH'S OWN VALUE.
    // Testing `first_epoch > 0` as well looks like belt-and-braces and is a live bug: epoch 0 is a
    // legitimate instant, so the window would reset on every pass and `min_secs` could never fire.
    // `streak == 0` already means "no history" — that is what an absent record loads as.
    let first_epoch = if prior.streak > 0 { prior.first_epoch } else { now };
    let sustained = now.saturating_sub(first_epoch);

    // ONE LINE ON PURPOSE: `mutation-check` comments a single line to prove a test can fail, and a
    // predicate split across two lines cannot be judged at all (commenting either half breaks the
    // parse). A rule this load-bearing has to stay mutable, so it stays within one line.
    let confirmed = streak >= policy.passes || (policy.min_secs > 0 && sustained >= policy.min_secs);
    if !confirmed {
        return (
            HysteresisAction::Hold,
            StreakState { streak, first_epoch, ..prior },
        );
    }

    if prior.filings == 0 {
        return (
            HysteresisAction::File,
            StreakState { streak, first_epoch, last_filed_epoch: now, filings: 1 },
        );
    }
    if policy.max_recurrences > 0 && prior.filings >= policy.max_recurrences {
        return (HysteresisAction::Suppress, StreakState { streak, first_epoch, ..prior });
    }
    if policy.cooldown_secs > 0
        && now.saturating_sub(prior.last_filed_epoch) < policy.cooldown_secs
    {
        return (HysteresisAction::Suppress, StreakState { streak, first_epoch, ..prior });
    }
    (
        HysteresisAction::File,
        StreakState {
            streak,
            first_epoch,
            last_filed_epoch: now,
            filings: prior.filings + 1,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CORPUS: &str = include_str!("../../shared/false-absence-corpus.json");
    const CONFIRMATION: &str = include_str!("../contracts/pipeline-confirmation-contract.json");

    fn confirmation() -> Value {
        serde_json::from_str(CONFIRMATION)
            .expect("the pipeline-confirmation contract must be valid JSON")
    }

    fn policy_from(v: &Value, fallback: &HysteresisPolicy) -> HysteresisPolicy {
        let g = |k: &str, d: u64| v.get(k).and_then(Value::as_u64).unwrap_or(d);
        HysteresisPolicy {
            passes: g("passes", fallback.passes as u64) as u32,
            min_secs: g("minSecs", fallback.min_secs),
            cooldown_secs: g("cooldownSecs", fallback.cooldown_secs),
            max_recurrences: g("maxRecurrences", fallback.max_recurrences as u64) as u32,
        }
    }

    /// THE PIN on the DEFAULTS. Every sequence case below sets its own policy explicitly, so
    /// without this the contract could name `passes: 2` while the shipped default was 1 — the
    /// file-on-first-sight behaviour the bead is about — and every case would still pass.
    #[test]
    fn the_hysteresis_defaults_are_pinned_to_the_shared_contract() {
        let c = confirmation();
        let want = policy_from(&c["hysteresis"]["policy"], &HysteresisPolicy::DEFAULT);
        assert_eq!(
            want,
            HysteresisPolicy::DEFAULT,
            "the Rust hysteresis policy has drifted from \
             apps/desktop/src-tauri/contracts/pipeline-confirmation-contract.json"
        );
    }

    /// THE PIN on the RULE, replayed as SEQUENCES. A rule about consecutive observations cannot be
    /// proven one step at a time: `hold, file, suppress` and `file, file, file` agree on every
    /// individual input and differ entirely in what reaches the backlog.
    ///
    /// The shell half replays these same cases through `ph_hysteresis_step`, so a divergence
    /// reddens both suites rather than shipping as a silent behavioural fork.
    #[test]
    fn every_hysteresis_sequence_in_the_shared_contract_replays_identically() {
        let c = confirmation();
        let defaults = policy_from(&c["hysteresis"]["policy"], &HysteresisPolicy::DEFAULT);
        let cases = c["hysteresis"]["cases"].as_array().expect("hysteresis cases array");
        assert!(!cases.is_empty(), "the contract must carry at least one sequence");
        for case in cases {
            let id = case["id"].as_str().expect("every case names itself");
            let policy = match case.get("policy") {
                Some(p) => policy_from(p, &defaults),
                None => defaults,
            };
            let want: Vec<&str> =
                case["expect"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            let obs = case["observations"].as_array().unwrap();
            assert_eq!(obs.len(), want.len(), "case {id}: one expectation per observation");

            let mut state = StreakState::default();
            let mut got: Vec<&str> = Vec::new();
            for o in obs {
                let green = o["green"].as_bool().expect("green is a bool");
                let at = o["atSecs"].as_u64().expect("atSecs is a number");
                let (action, next) = hysteresis_step(green, state, at, &policy);
                state = next;
                got.push(action.as_str());
            }
            assert_eq!(got, want, "case {id} replayed differently");
        }
    }

    /// `writes_to_the_backlog` is the predicate every caller gates on, so it gets its own pin: a
    /// variant quietly added to the "writes" side would let a HELD blip file again, which is the
    /// whole defect.
    #[test]
    fn only_file_touches_the_backlog() {
        for a in [
            HysteresisAction::None,
            HysteresisAction::Clear,
            HysteresisAction::Hold,
            HysteresisAction::Suppress,
        ] {
            assert!(!a.writes_to_the_backlog(), "{} must not write", a.as_str());
        }
        assert!(HysteresisAction::File.writes_to_the_backlog());
    }

    /// The measured harm, stated as an arithmetic bound rather than as a sequence: an hourly scan
    /// against a component that stays red for a WEEK must not be able to reach anything like the 159
    /// comments the bead records. This is the assertion that fails if the cooldown is removed while
    /// every sequence case above is still satisfied by the confirm-twice half alone.
    #[test]
    fn a_week_of_hourly_passes_over_a_standing_outage_cannot_pile_up_comments() {
        let policy = HysteresisPolicy::DEFAULT;
        let mut state = StreakState::default();
        let mut writes = 0;
        for hour in 0..(24 * 7) {
            let (action, next) = hysteresis_step(false, state, hour * 3600, &policy);
            state = next;
            if action.writes_to_the_backlog() {
                writes += 1;
            }
        }
        assert!(
            writes <= policy.max_recurrences,
            "168 hourly passes over one standing outage wrote {writes} times; the ceiling is {}",
            policy.max_recurrences
        );
        assert!(writes >= 1, "a standing outage must still be recorded at least once");
    }

    fn corpus() -> Value {
        serde_json::from_str(CORPUS).expect("the false-absence corpus must be valid JSON")
    }

    /// THE PIN. Ids, ORDER and pattern SOURCE, all three.
    ///
    /// An id-set-only check goes green while a pattern has been widened or narrowed on one side
    /// only — which is the drift that matters, since the pattern is the thing that actually catches a
    /// wrong sentence. The TypeScript half asserts the identical three things against the identical
    /// file, so the two copies fail TOGETHER or not at all.
    #[test]
    fn the_absence_lexicon_is_pinned_to_the_shared_contract() {
        let c = corpus();
        let want = c["absenceClaims"]["patterns"].as_array().expect("patterns array");
        assert_eq!(
            want.len(),
            ABSENCE_CLAIM_PATTERNS.len(),
            "the Rust lexicon has drifted from apps/desktop/shared/false-absence-corpus.json"
        );
        for (i, w) in want.iter().enumerate() {
            let (id, src) = ABSENCE_CLAIM_PATTERNS[i];
            assert_eq!(w["id"].as_str(), Some(id), "pattern {i} id drifted from the contract");
            assert_eq!(w["re"].as_str(), Some(src), "pattern {id} source drifted from the contract");
        }
    }

    /// Each pattern against ITS OWN measured text — the verbatim sentence a shipped surface actually
    /// produced. Not a tautology: this asserts the lexicon against production output rather than
    /// against itself, so a pattern edited until it no longer catches the wrong sentence it exists
    /// for fails here.
    ///
    /// Tested per-index rather than through [`absence_claim_in`], which returns the FIRST match — a
    /// pattern whose text another pattern also catches would otherwise go green while being dead.
    #[test]
    fn every_pattern_still_catches_the_sentence_it_was_written_for() {
        let c = corpus();
        for (i, w) in c["absenceClaims"]["patterns"].as_array().unwrap().iter().enumerate() {
            let (id, _) = ABSENCE_CLAIM_PATTERNS[i];
            let caught = w["caught"].as_str().expect("every pattern names its measured text");
            let re = Regex::new(&format!("(?i){}", ABSENCE_CLAIM_PATTERNS[i].1)).unwrap();
            assert!(re.is_match(caught), "pattern {id} no longer catches its own measured text: {caught}");
        }
    }

    /// The inverse direction, which is what keeps the lexicon usable. If these matched, every probe
    /// would be forced into a bland fallback and the feature would be a mute button rather than a
    /// truth gate.
    #[test]
    fn an_honest_could_not_look_sentence_is_not_an_absence_claim() {
        for honest in [
            "roborev status did not answer within 8s, and no daemon evidence could be read — diagnose before restarting.",
            "could not read 'sparkle-reviewer' review activity from GitHub; pipeline visibility is degraded.",
            "The releases read covered only published objects, so a draft can be neither confirmed nor ruled out.",
            "the comment window reached back 15h, which is short of the 48h this claim covers.",
        ] {
            assert_eq!(absence_claim_in(honest), None, "false positive on: {honest}");
        }
    }

    /// EVERY measured wrong claim in the corpus must be catchable — including the TypeScript and
    /// shell ones this crate otherwise never touches. A wrong claim the lexicon cannot see is a hole
    /// in the lexicon, and this is the assertion that finds it.
    #[test]
    fn every_measured_wrong_claim_is_caught_by_the_lexicon() {
        let c = corpus();
        for case in c["instances"]["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let wrong = case["wrongClaim"].as_str().unwrap();
            assert!(
                absence_claim_in(wrong).is_some(),
                "instance {id}'s measured wrong claim escapes the lexicon: {wrong}"
            );
        }
    }

    /// A truncated read proves presence, never absence — and an untruncated one settles it.
    #[test]
    fn a_horizon_covers_a_claim_only_when_it_reached_past_it() {
        // Not truncated: we saw everything, so an empty result is a real answer at any span.
        assert!(ReadHorizon { truncated: false, oldest_seen_secs: Some(3600) }.covers(48 * 3600));
        // Truncated and SHORT of the claim — the measured knightwatch case: a full page reaching
        // back 15h, against a 48h question.
        assert!(!ReadHorizon { truncated: true, oldest_seen_secs: Some(15 * 3600) }.covers(48 * 3600));
        // Truncated but reaching back PAST the claim: anything within the span would have been in
        // the page, so the empty result does settle it.
        assert!(ReadHorizon { truncated: true, oldest_seen_secs: Some(72 * 3600) }.covers(48 * 3600));
        // Truncated and undateable: the worst case, and it settles nothing.
        assert!(!ReadHorizon { truncated: true, oldest_seen_secs: None }.covers(1));
    }
}
