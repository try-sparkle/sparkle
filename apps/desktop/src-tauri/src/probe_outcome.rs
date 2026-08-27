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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CORPUS: &str = include_str!("../../shared/false-absence-corpus.json");

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
