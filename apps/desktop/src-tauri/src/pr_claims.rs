//! "I am landing this PR myself" — an agent's intent, made legible to every other actor.
//!
//! WHY THIS EXISTS: PR #806 was merged by the concierge while its owning agent was deliberately
//! holding it. The agent's intent lived only in its own head and in a chat message nobody re-read.
//! A claim is that intent written somewhere a second actor can look BEFORE it merges.
//!
//! A CLAIM IS A COURTESY, NOT A LOCK. It expires, its owner can release it, and a dead agent's claim
//! must not wedge a PR forever — hence `expires_at_ms` and the prune-on-every-touch discipline. The
//! registry deliberately lives in the Rust process (one per app launch) rather than in a window's
//! store, so a claim made through any window is visible from every window.
//!
//! Everything decision-shaped here is a free function taking `now_ms`, so the rules are testable
//! without a Tauri `AppHandle` and without sleeping through a real TTL.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Mirrors `PR_CLAIM_DEFAULT_TTL_SECONDS` / `PR_CLAIM_MIN_TTL_SECONDS` / `PR_CLAIM_MAX_TTL_SECONDS`
/// in `services/mergeGuard/types.ts`. Two copies of a constant is a hazard, so: if you change one,
/// change the other — the TS side is the published contract and this side is what enforces it.
const DEFAULT_TTL_SECONDS: u64 = 1800;
const MIN_TTL_SECONDS: u64 = 60;
const MAX_TTL_SECONDS: u64 = 7200;

/// Mirrors `PR_CLAIM_GRACE_SECONDS` in `services/mergeGuard/types.ts`. THE REGISTRY MUST OUTLIVE THE
/// TTL BY THIS MUCH, or the TS layer's `lapsed` standing is unreachable: pruning at
/// `expires_at_ms` deletes the row before anyone can read it as lapsed, `findClaim` returns null,
/// and a live claimant's PR is merged at exactly T+TTL — the hazard `lapsed` was added to close.
/// A claim is READABLE for TTL + this; it stops BLOCKING at TTL + this (decided TS-side).
const GRACE_SECONDS: u64 = 7200;

/// A claim note is free text written by a model and displayed in the UI. Cap it so a runaway
/// generation cannot push a paragraph into a roster row.
const NOTE_MAX_CHARS: usize = 256;

/// One agent's declared intent to land a PR. Mirrors `PrClaim` in `services/mergeGuard/types.ts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrClaim {
    pub root: String,
    pub number: u64,
    pub agent_id: String,
    pub note: Option<String>,
    pub claimed_at_ms: u64,
    pub expires_at_ms: u64,
}

/// The registry, in Tauri managed state. Keyed `<root>\u{1}<number>` — claims are scoped per repo,
/// because PR numbers only mean something relative to one.
#[derive(Default)]
pub struct PrClaims {
    inner: Mutex<HashMap<String, PrClaim>>,
}

impl PrClaims {
    /// Take the map, RECOVERING from a poisoned lock rather than propagating the panic.
    ///
    /// A claim registry is advisory state; a thread that panicked mid-write leaves at worst one
    /// half-considered entry, and every read prunes anyway. Killing the app's merge path forever
    /// over that would turn a courtesy into an outage.
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, PrClaim>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn claim_key(root: &str, number: u64) -> String {
    // \u{1} cannot appear in a path, so no root/number pair can collide with another.
    format!("{}\u{1}{number}", canonical_root(root))
}

/// One spelling per repo. `/a/b`, `/a/b/` and ` /a/b ` are the SAME project, and the frontend's
/// admission check (`normalizeRoot`) deliberately tolerates all three — so a claim written under
/// one spelling and read under another would silently not exist, and the merge gate would see an
/// unclaimed PR. Canonicalize on the way in AND on the way out, here, so no caller has to.
fn canonical_root(root: &str) -> String {
    root.trim().trim_end_matches(['/', '\\']).to_string()
}

/// Clamp a requested TTL into the contract's range. See the constants above.
fn clamp_ttl_seconds(ttl_seconds: Option<u64>) -> u64 {
    ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS).clamp(MIN_TTL_SECONDS, MAX_TTL_SECONDS)
}

/// Trim a note, drop it if it is empty, and cap it by CHARACTERS (not bytes — a byte slice would
/// panic mid-codepoint on the emoji a model will eventually write).
fn normalize_note(note: Option<String>) -> Option<String> {
    let note = note?;
    let trimmed = note.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(NOTE_MAX_CHARS).collect())
}

/// Drop every claim whose expiry has passed. Called on EVERY read and write: an expired claim that
/// is still readable is a claim that can still block a merge, which is the failure mode the expiry
/// exists to prevent.
/// Drop claims that are past TTL **plus the grace window**.
///
/// Deliberately NOT `expires_at_ms > now_ms`. A claim between its TTL and the ceiling is `lapsed`:
/// still readable, and still blocking while its claimant is alive, because an agent inside a long
/// turn issues no tool calls and so cannot renew. Pruning at the TTL made that whole state
/// unobservable — the row was gone before any reader could classify it.
fn prune_expired(map: &mut HashMap<String, PrClaim>, now_ms: u64) {
    map.retain(|_, claim| claim.expires_at_ms + GRACE_SECONDS * 1000 > now_ms);
}

/// Validate the identity a claim is made under. Empty is rejected rather than defaulted: an
/// anonymous claim can be neither released by its owner nor attributed to one, so it would be a
/// permanent, un-ownable block until it expired.
fn validate_request(root: &str, number: u64, agent_id: &str) -> Result<(), String> {
    if root.trim().is_empty() {
        return Err("a PR claim needs a project root — claims are scoped per repo".to_string());
    }
    if number == 0 {
        return Err("a PR claim needs a real PR number".to_string());
    }
    if agent_id.trim().is_empty() {
        return Err("a PR claim needs an agent id — an unattributable claim cannot be released"
            .to_string());
    }
    Ok(())
}

/// Record (or extend) a claim. An unexpired claim by a DIFFERENT agent is an `Err` naming the
/// holder — a claim is never silently stolen, because the whole point is that the other actor finds
/// out rather than guesses. Re-claiming your own extends it with a fresh expiry.
fn set_claim(
    map: &mut HashMap<String, PrClaim>,
    root: &str,
    number: u64,
    agent_id: &str,
    note: Option<String>,
    ttl_seconds: Option<u64>,
    now_ms: u64,
) -> Result<PrClaim, String> {
    validate_request(root, number, agent_id)?;
    prune_expired(map, now_ms);
    let key = claim_key(root, number);
    let agent_id = agent_id.trim();
    if let Some(existing) = map.get(&key) {
        // Rows now survive past their TTL (see `prune_expired`), so "still here" no longer means
        // "still current". A claim inside the GRACE window is takeover-able: it is kept only so a
        // reader can classify it as `lapsed`, and whether it still BLOCKS is decided TS-side, where
        // the claimant's liveness is known. Refusing here would instead hand a dead agent a
        // two-hour veto that nothing could clear.
        let still_current = existing.expires_at_ms > now_ms;
        if still_current && existing.agent_id != agent_id {
            return Err(format!(
                "PR #{number} is claimed by agent {} until {} — ask it to release, or wait it out",
                existing.agent_id, existing.expires_at_ms
            ));
        }
    }
    let claim = PrClaim {
        root: canonical_root(root),
        number,
        agent_id: agent_id.to_string(),
        note: normalize_note(note),
        claimed_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(clamp_ttl_seconds(ttl_seconds) * 1000),
    };
    map.insert(key, claim.clone());
    Ok(claim)
}

/// Release your own claim. `Ok(false)` when there was nothing to release — an already-expired or
/// never-made claim is not an error, because the caller's goal ("nobody is holding this on my
/// behalf") is satisfied either way. Releasing SOMEONE ELSE'S is an `Err`.
fn release_claim(
    map: &mut HashMap<String, PrClaim>,
    root: &str,
    number: u64,
    agent_id: &str,
    now_ms: u64,
) -> Result<bool, String> {
    validate_request(root, number, agent_id)?;
    prune_expired(map, now_ms);
    let key = claim_key(root, number);
    let agent_id = agent_id.trim();
    match map.get(&key) {
        None => Ok(false),
        Some(existing) if existing.agent_id == agent_id => {
            map.remove(&key);
            Ok(true)
        }
        Some(existing) => Err(format!(
            "PR #{number} is claimed by agent {}, not by {agent_id} — only its owner can release it",
            existing.agent_id
        )),
    }
}

/// Every live claim in one repo, oldest PR number first so the list is stable to read and to diff.
fn list_claims(map: &mut HashMap<String, PrClaim>, root: &str, now_ms: u64) -> Vec<PrClaim> {
    prune_expired(map, now_ms);
    let want = canonical_root(root);
    let mut claims: Vec<PrClaim> =
        map.values().filter(|c| canonical_root(&c.root) == want).cloned().collect();
    claims.sort_by_key(|c| c.number);
    claims
}

#[tauri::command]
pub fn pr_claim_set(
    state: tauri::State<'_, PrClaims>,
    root: String,
    number: u64,
    agent_id: String,
    note: Option<String>,
    ttl_seconds: Option<u64>,
) -> Result<PrClaim, String> {
    let mut map = state.map();
    set_claim(&mut map, &root, number, &agent_id, note, ttl_seconds, now_ms())
}

#[tauri::command]
pub fn pr_claim_release(
    state: tauri::State<'_, PrClaims>,
    root: String,
    number: u64,
    agent_id: String,
) -> Result<bool, String> {
    let mut map = state.map();
    release_claim(&mut map, &root, number, &agent_id, now_ms())
}

#[tauri::command]
pub fn pr_claims_list(
    state: tauri::State<'_, PrClaims>,
    root: String,
) -> Result<Vec<PrClaim>, String> {
    if root.trim().is_empty() {
        return Err("pr_claims_list requires a project root".to_string());
    }
    let mut map = state.map();
    Ok(list_claims(&mut map, &root, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000;
    const ROOT: &str = "/Users/x/Projects/sparkle";

    fn empty() -> HashMap<String, PrClaim> {
        HashMap::new()
    }

    /// THE CROSS-BOUNDARY TEST. Everything the TS layer decides about a lapsed claim is decided on
    /// the JSON this registry emits — and a TS test that hand-builds that object, or mocks the probe
    /// that fetches it, cannot notice when the two drift. That is exactly how the inert-`lapsed`
    /// hole survived a green suite: the fixture was a claim the real registry could not produce.
    ///
    /// So this asserts the WIRE SHAPE of a genuinely lapsed claim taken from the real registry, and
    /// `prClaims.test.ts` parses this same literal rather than inventing one. If serde's field
    /// naming or the prune window changes, this fails and the TS fixture must be regenerated.
    #[test]
    fn a_lapsed_claim_serializes_to_the_shape_the_ts_layer_classifies() {
        let mut map = empty();
        let claim =
            set_claim(&mut map, ROOT, 806, "agent-a", Some("holding for roborev".into()), Some(60), T0)
                .unwrap();
        let now = claim.expires_at_ms + 1; // past the TTL, inside the grace window
        let rows = list_claims(&mut map, ROOT, now);
        assert_eq!(rows.len(), 1, "a lapsed claim must still be READABLE — see prune_expired");
        assert!(
            rows[0].expires_at_ms < now,
            "and it must report itself PAST its expiry, or the TS layer cannot classify it lapsed"
        );

        let json = serde_json::to_string(&rows[0]).unwrap();
        // camelCase, because that is what the frontend reads (serde rename_all on PrClaim).
        for key in ["agentId", "claimedAtMs", "expiresAtMs"] {
            assert!(json.contains(key), "the wire shape must carry {key}: {json}");
        }
        // The EXACT literal services/mergeGuard/prClaims.test.ts parses.
        assert_eq!(
            json,
            format!(
                r#"{{"root":"{ROOT}","number":806,"agentId":"agent-a","note":"holding for roborev","claimedAtMs":{T0},"expiresAtMs":{}}}"#,
                claim.expires_at_ms
            ),
            "if this changed, regenerate the fixture in services/mergeGuard/prClaims.test.ts"
        );
    }
    /// A trailing slash is the same repo. The frontend admission check tolerates one, so a claim
    /// written under `/repo/` and read under `/repo` must be the SAME claim — otherwise the merge
    /// gate reads an unclaimed PR and merges out from under the claimant.
    #[test]
    fn a_trailing_separator_is_the_same_repo() {
        let mut map = HashMap::new();
        let now = 1_000_000;
        set_claim(&mut map, "/repo/", 806, "a1", None, None, now).unwrap();
        assert_eq!(list_claims(&mut map, "/repo", now).len(), 1, "readable without the slash");
        assert_eq!(list_claims(&mut map, "/repo/", now).len(), 1, "and with it");
        assert_eq!(list_claims(&mut map, " /repo ", now).len(), 1, "and with whitespace");
        // And the second agent is refused, rather than writing a parallel claim under a second key.
        assert!(set_claim(&mut map, "/repo", 806, "a2", None, None, now).is_err());
        assert_eq!(list_claims(&mut map, "/repo", now)[0].root, "/repo", "stored canonically");
    }

    #[test]
    fn set_then_list_round_trips() {
        let mut map = empty();
        let claim =
            set_claim(&mut map, ROOT, 806, "agent-a", Some(" holding for roborev ".into()), None, T0)
                .unwrap();
        assert_eq!(claim.number, 806);
        assert_eq!(claim.agent_id, "agent-a");
        assert_eq!(claim.note.as_deref(), Some("holding for roborev"), "the note is trimmed");
        assert_eq!(claim.claimed_at_ms, T0);
        assert_eq!(claim.expires_at_ms, T0 + DEFAULT_TTL_SECONDS * 1000);
        assert_eq!(list_claims(&mut map, ROOT, T0), vec![claim]);
    }

    #[test]
    fn claims_are_scoped_per_repo_and_listed_in_pr_order() {
        let mut map = empty();
        set_claim(&mut map, ROOT, 900, "agent-a", None, None, T0).unwrap();
        set_claim(&mut map, ROOT, 806, "agent-a", None, None, T0).unwrap();
        set_claim(&mut map, "/other/repo", 806, "agent-b", None, None, T0).unwrap();
        let listed = list_claims(&mut map, ROOT, T0);
        assert_eq!(listed.iter().map(|c| c.number).collect::<Vec<_>>(), vec![806, 900]);
        assert_eq!(list_claims(&mut map, "/other/repo", T0).len(), 1, "another repo's #806 is its own");
    }

    #[test]
    fn expiry_prunes_on_read() {
        let mut map = empty();
        set_claim(&mut map, ROOT, 806, "agent-a", None, Some(60), T0).unwrap();
        assert_eq!(list_claims(&mut map, ROOT, T0 + 59_000).len(), 1, "still live at 59s");
        // PAST the TTL the row SURVIVES, inside the grace window — this is what makes the TS
        // layer's `lapsed` standing reachable at all. Pruning here deleted the row before any
        // reader could classify it, so a live claimant's PR merged at exactly T+TTL.
        assert_eq!(list_claims(&mut map, ROOT, T0 + 61_000).len(), 1, "lapsed, not gone, at 61s");
        // Only past TTL + grace is it really gone, which is the anti-wedge ceiling.
        // THE BOUNDARIES as LITERAL numbers, because `GRACE_SECONDS` and TS's
        // `PR_CLAIM_GRACE_SECONDS` are two copies of one value and only a comment says "mirrors".
        // prClaims.test.ts asserts the same two boundaries against the same literal, so lowering
        // either constant turns a suite red instead of silently opening a window in which the row
        // is pruned while the TS layer still believes it blocks.
        assert_eq!(GRACE_SECONDS, 7200, "if this changes, change PR_CLAIM_GRACE_SECONDS too");
        assert_eq!(list_claims(&mut map, ROOT, T0 + 60_000 + 7200 * 1000 - 1).len(), 1, "inside grace");
        let past_ceiling = T0 + 60_000 + GRACE_SECONDS * 1000 + 1;
        assert!(list_claims(&mut map, ROOT, past_ceiling).is_empty(), "gone past TTL + grace");
        assert!(map.is_empty(), "the read must have PRUNED it, not merely filtered it out");
    }

    /// THE test the previous round was missing, driven through the real `list_claims` rather than a
    /// hand-built claim: a lapsed row has to be READABLE, or nothing downstream can classify it.
    #[test]
    fn a_lapsed_claim_is_readable_and_takeover_able_but_a_current_one_is_not() {
        let mut map = empty();
        let claim = set_claim(&mut map, ROOT, 806, "agent-a", None, Some(60), T0).unwrap();
        let ttl_end = claim.expires_at_ms;

        // Current → not stolen.
        assert!(set_claim(&mut map, ROOT, 806, "agent-b", None, None, ttl_end - 1).is_err());
        // Lapsed → still readable…
        let rows = list_claims(&mut map, ROOT, ttl_end + 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent_id, "agent-a");
        // …and takeover-able, so keeping the row cannot become an unclearable veto.
        let taken = set_claim(&mut map, ROOT, 806, "agent-b", None, None, ttl_end + 1).unwrap();
        assert_eq!(taken.agent_id, "agent-b");
    }

    /// The core courtesy: a live claim is not stolen. And the core safety valve: it is not a
    /// permanent veto either — once it lapses, the next agent gets it.
    #[test]
    fn a_second_agent_is_refused_while_the_first_is_live_and_allowed_once_it_expires() {
        let mut map = empty();
        set_claim(&mut map, ROOT, 806, "agent-a", None, Some(60), T0).unwrap();

        let refused = set_claim(&mut map, ROOT, 806, "agent-b", None, None, T0 + 1_000).unwrap_err();
        assert!(refused.contains("agent-a"), "the refusal must name the holder: {refused}");
        assert_eq!(map.get(&claim_key(ROOT, 806)).unwrap().agent_id, "agent-a", "not stolen");

        let taken = set_claim(&mut map, ROOT, 806, "agent-b", None, None, T0 + 61_000).unwrap();
        assert_eq!(taken.agent_id, "agent-b", "an expired claim is not a veto");
    }

    #[test]
    fn reclaiming_your_own_extends_it() {
        let mut map = empty();
        let first = set_claim(&mut map, ROOT, 806, "agent-a", None, Some(60), T0).unwrap();
        let second = set_claim(&mut map, ROOT, 806, "agent-a", None, Some(60), T0 + 30_000).unwrap();
        assert!(second.expires_at_ms > first.expires_at_ms, "the expiry must move forward");
        assert_eq!(second.claimed_at_ms, T0 + 30_000);
        assert_eq!(list_claims(&mut map, ROOT, T0 + 30_000).len(), 1, "still one claim, not two");
    }

    #[test]
    fn release_by_the_owner_returns_true_then_false() {
        let mut map = empty();
        set_claim(&mut map, ROOT, 806, "agent-a", None, None, T0).unwrap();
        assert!(release_claim(&mut map, ROOT, 806, "agent-a", T0).unwrap(), "removed");
        assert!(!release_claim(&mut map, ROOT, 806, "agent-a", T0).unwrap(), "nothing left to remove");
    }

    #[test]
    fn release_by_a_non_owner_errors_and_leaves_the_claim_standing() {
        let mut map = empty();
        set_claim(&mut map, ROOT, 806, "agent-a", None, None, T0).unwrap();
        let err = release_claim(&mut map, ROOT, 806, "agent-b", T0).unwrap_err();
        assert!(err.contains("agent-a"), "the error must name the owner: {err}");
        assert_eq!(list_claims(&mut map, ROOT, T0).len(), 1, "the claim survives the attempt");
        // An EXPIRED claim by someone else is not theirs to guard — it is simply gone.
        assert!(!release_claim(&mut map, ROOT, 806, "agent-b", T0 + 9_999_999).unwrap());
    }

    #[test]
    fn ttl_is_clamped_to_the_contract_range() {
        assert_eq!(clamp_ttl_seconds(None), DEFAULT_TTL_SECONDS);
        assert_eq!(clamp_ttl_seconds(Some(0)), MIN_TTL_SECONDS);
        assert_eq!(clamp_ttl_seconds(Some(59)), MIN_TTL_SECONDS);
        assert_eq!(clamp_ttl_seconds(Some(60)), 60);
        assert_eq!(clamp_ttl_seconds(Some(3600)), 3600);
        assert_eq!(clamp_ttl_seconds(Some(7200)), MAX_TTL_SECONDS);
        assert_eq!(clamp_ttl_seconds(Some(u64::MAX)), MAX_TTL_SECONDS, "no unbounded claim");
    }

    #[test]
    fn an_unattributable_or_unreal_claim_is_refused() {
        let mut map = empty();
        assert!(set_claim(&mut map, ROOT, 806, "   ", None, None, T0).is_err(), "empty agent id");
        assert!(set_claim(&mut map, ROOT, 0, "agent-a", None, None, T0).is_err(), "PR #0");
        assert!(set_claim(&mut map, "  ", 806, "agent-a", None, None, T0).is_err(), "empty root");
        assert!(release_claim(&mut map, ROOT, 806, "", T0).is_err(), "empty agent id on release");
        assert!(map.is_empty(), "a rejected request records nothing");
    }

    #[test]
    fn a_note_is_capped_by_characters_not_bytes() {
        let mut map = empty();
        // Multi-byte on purpose: a byte-slice cap would panic mid-codepoint here.
        let long = "é".repeat(NOTE_MAX_CHARS + 50);
        let claim = set_claim(&mut map, ROOT, 806, "agent-a", Some(long), None, T0).unwrap();
        assert_eq!(claim.note.unwrap().chars().count(), NOTE_MAX_CHARS);
        let blank = set_claim(&mut map, ROOT, 807, "agent-a", Some("   ".into()), None, T0).unwrap();
        assert_eq!(blank.note, None, "a whitespace-only note is no note");
    }

    /// A poisoned lock must degrade, not take the app's merge path down with it.
    #[test]
    fn a_poisoned_mutex_still_answers() {
        let claims = PrClaims::default();
        {
            let mut map = claims.map();
            map.insert(
                claim_key(ROOT, 806),
                PrClaim {
                    root: ROOT.to_string(),
                    number: 806,
                    agent_id: "agent-a".to_string(),
                    note: None,
                    claimed_at_ms: T0,
                    expires_at_ms: u64::MAX,
                },
            );
        }
        let poisoner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = claims.inner.lock().unwrap();
            panic!("poison the lock");
        }));
        assert!(poisoner.is_err());
        assert!(claims.inner.is_poisoned(), "the lock really is poisoned");
        assert_eq!(claims.map().len(), 1, "the registry still reads through the poison");
    }
}
